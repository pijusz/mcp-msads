import { getEnv } from "@/config/env";
import { hashEmail, hashPhone } from "@/services/pii";
import { MsAdsError } from "@/utils/errors";
import { log } from "@/utils/logger";
import {
  MAX_API_RESPONSE_BYTES,
  parseJsonBytes,
  readResponseBytes,
} from "@/utils/safe-http";

/**
 * Microsoft Conversions API (CAPI) — server-side conversion ingestion.
 *
 * A different system from the rest of this server: its own host, its own auth
 * token, and its own payload schema. It is the server-side counterpart to the
 * UET JavaScript tag, for conversions that happen where a browser tag cannot
 * observe them.
 *
 * https://learn.microsoft.com/en-us/advertising/guides/uet-conversion-api-integration
 */

const CAPI_BASE = "https://capi.uet.microsoft.com/v1";

/** Microsoft accepts at most 1,000 events per request. */
export const MAX_EVENTS_PER_BATCH = 1000;

const MAX_DIAGNOSTICS = 20;
const MAX_DIAGNOSTIC_TEXT = 500;
const DIAGNOSTIC_FIELDS = new Set([
  "code",
  "errorcode",
  "message",
  "details",
  "description",
  "field",
  "fieldpath",
  "index",
  "eventindex",
  "iswarning",
  "parameter",
  "status",
]);

/** Events older than this are rejected outright. */
const MAX_EVENT_AGE_DAYS = 7;

export type CapiEventType = "pageLoad" | "custom";

export interface CapiUserData {
  /** Microsoft click id — by far the strongest signal when available. */
  msclkid?: string;
  /** SHA-256 of the normalized email. */
  em?: string;
  /** SHA-256 of the E.164 phone number. */
  ph?: string;
  /** Must equal the VID from the client-side ID-sync pixel. */
  anonymousId?: string;
  externalId?: string;
  idfa?: string;
  gaid?: string;
  clientUserAgent?: string;
  clientIpAddress?: string;
}

export interface CapiCustomData {
  value?: number;
  currency?: string;
  transactionId?: string;
  eventCategory?: string;
  eventLabel?: string;
  eventValue?: number;
  items?: Array<Record<string, unknown>>;
  itemIds?: string[];
  pageType?: string;
  ecommTotalValue?: number;
  ecommCategory?: string;
  searchTerm?: string;
  hotelData?: Record<string, unknown>;
}

export interface CapiEvent {
  eventType: CapiEventType;
  eventName: string;
  /** Unix seconds, UTC. Defaults to now. */
  eventTime?: number;
  /** Must match the JS tag's id for deduplication to work. */
  eventId?: string;
  eventSourceUrl?: string;
  pageLoadId?: string;
  referrerUrl?: string;
  pageTitle?: string;
  keywords?: string;
  /** "G" granted, "D" denied. */
  adStorageConsent?: "G" | "D";
  userData: CapiUserData;
  customData?: CapiCustomData;
}

export interface RawIdentifiers {
  /** Plaintext email; hashed here and never sent as-is. */
  email?: string;
  /** Plaintext phone; normalized to E.164 and hashed here. */
  phone?: string;
  defaultCountryCode?: string;
}

/**
 * Build a `userData` block, hashing any plaintext identifiers.
 *
 * Every identifier CAPI accepts is either an opaque id or a hash; plaintext
 * must never reach the wire. Routing through here makes that structural rather
 * than a rule callers have to remember.
 */
export function buildUserData(identifiers: CapiUserData & RawIdentifiers): CapiUserData {
  const { email, phone, defaultCountryCode, ...rest } = identifiers;
  const out: CapiUserData = { ...rest };

  if (email) out.em = hashEmail(email).hash;
  if (phone) out.ph = hashPhone(phone, defaultCountryCode).hash;

  return out;
}

const ATTRIBUTION_IDENTIFIERS = [
  "msclkid",
  "em",
  "ph",
  "anonymousId",
  "externalId",
  "idfa",
  "gaid",
] as const;

/** At least one attribution identifier is required; UA/IP are supplemental only. */
export function assertHasIdentifier(userData: CapiUserData, index: number): void {
  const hasAny = ATTRIBUTION_IDENTIFIERS.some((key) => {
    const value = userData[key];
    return typeof value === "string" && value.trim() !== "";
  });
  if (!hasAny) {
    throw new MsAdsError({
      message:
        `Event at index ${index} has no user identifier. CAPI needs at least one of ` +
        "msclkid, em (hashed email), ph (hashed phone), anonymousId, externalId, idfa, or gaid — " +
        "without one the conversion cannot be attributed to a click.",
    });
  }
}

export function validateEvent(event: CapiEvent, index: number): void {
  if (!event.eventName) {
    throw new MsAdsError({ message: `Event at index ${index} has no eventName.` });
  }
  if (event.eventType !== "pageLoad" && event.eventType !== "custom") {
    throw new MsAdsError({
      message: `Event at index ${index} has eventType "${event.eventType}". Only "pageLoad" and "custom" are accepted.`,
    });
  }
  assertHasIdentifier(event.userData, index);

  if (event.eventTime !== undefined) {
    const ageDays = (Date.now() / 1000 - event.eventTime) / 86_400;
    if (ageDays > MAX_EVENT_AGE_DAYS) {
      throw new MsAdsError({
        message:
          `Event at index ${index} is ${Math.round(ageDays)} days old. CAPI rejects events older than ${MAX_EVENT_AGE_DAYS} days. ` +
          "For older conversions use the offline conversions API instead.",
      });
    }
    if (event.eventTime > Date.now() / 1000 + 300) {
      throw new MsAdsError({
        message: `Event at index ${index} has an eventTime in the future. Use Unix SECONDS in UTC, not milliseconds.`,
      });
    }
  }
}

export interface CapiResult {
  /** True when the whole batch was accepted. */
  accepted: boolean;
  eventsSent: number;
  /** Validation failures — these events were dropped. */
  errors: unknown[];
  /**
   * Warnings. Microsoft strips the offending optional field and still returns
   * 200, so a warning means the event landed with LESS data than was sent.
   */
  warnings: unknown[];
}

/**
 * Send conversion events.
 *
 * `continueOnValidationError` defaults to true: without it a single malformed
 * event fails the whole batch with HTTP 400, which for a 1,000-event upload
 * loses 999 good conversions to one bad row.
 */
export async function sendEvents(
  tagId: string,
  authKey: string,
  events: CapiEvent[],
  opts: {
    continueOnValidationError?: boolean;
    dataProvider?: string;
    timeoutMs?: number;
  } = {},
): Promise<CapiResult> {
  if (events.length === 0) {
    throw new MsAdsError({ message: "No events to send." });
  }
  if (events.length > MAX_EVENTS_PER_BATCH) {
    throw new MsAdsError({
      message: `Too many events: ${events.length}. CAPI accepts at most ${MAX_EVENTS_PER_BATCH} per request.`,
    });
  }

  events.forEach(validateEvent);

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    data: events.map((event) => ({
      ...event,
      eventTime: event.eventTime ?? now,
    })),
    continueOnValidationError: opts.continueOnValidationError ?? true,
    ...(opts.dataProvider ? { dataProvider: opts.dataProvider } : {}),
  };

  const timeoutMs = opts.timeoutMs ?? getEnv().MSADS_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  let body: unknown;
  try {
    res = await fetch(`${CAPI_BASE}/${encodeURIComponent(tagId)}/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    body = parseJsonBytes(await readResponseBytes(res, MAX_API_RESPONSE_BYTES));
  } catch (error) {
    if (controller.signal.aborted || (error as Error).name === "AbortError") {
      throw new MsAdsError({ message: `CAPI request timed out after ${timeoutMs}ms.` });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new MsAdsError({
      status: res.status,
      message:
        res.status === 401
          ? "CAPI rejected the per-tag auth key (HTTP 401); it is not the OAuth access token."
          : `CAPI rejected the batch (HTTP ${res.status}).`,
      diagnostics: safeCapiDiagnostics(body, authKey),
    });
  }

  const split = splitDiagnostics(body);
  const errors = sanitizeDiagnostics(split.errors, authKey);
  const warnings = sanitizeDiagnostics(split.warnings, authKey);
  if (warnings.length > 0) {
    log.warn(
      `CAPI accepted the batch with ${warnings.length} warning(s); the offending fields were dropped.`,
    );
  }

  return {
    accepted: errors.length === 0,
    eventsSent: events.length,
    errors,
    warnings,
  };
}

/** CAPI diagnostics that are safe and small enough to return through MCP. */
export interface SafeCapiDiagnostics {
  errors: Array<Record<string, string | number | boolean | null>>;
  warnings: Array<Record<string, string | number | boolean | null>>;
  truncated: boolean;
}

function sanitizeDiagnostic(
  item: unknown,
  secret?: string,
): Record<string, string | number | boolean | null> | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const safe: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(item)) {
    if (!DIAGNOSTIC_FIELDS.has(key.toLowerCase())) continue;
    if (typeof value === "string") {
      const redacted = secret ? value.replaceAll(secret, "[redacted]") : value;
      safe[key] =
        redacted.length > MAX_DIAGNOSTIC_TEXT
          ? `${redacted.slice(0, MAX_DIAGNOSTIC_TEXT)}…`
          : redacted;
    } else if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      safe[key] = value;
    }
  }
  return Object.keys(safe).length > 0 ? safe : null;
}

function sanitizeDiagnostics(
  items: unknown[],
  secret?: string,
): Array<Record<string, string | number | boolean | null>> {
  return items
    .slice(0, MAX_DIAGNOSTICS)
    .map((item) => sanitizeDiagnostic(item, secret))
    .filter(
      (item): item is Record<string, string | number | boolean | null> => item !== null,
    );
}

/** Reduce provider errors to a bounded, non-secret structure safe for MCP output. */
export function safeCapiDiagnostics(body: unknown, secret?: string): SafeCapiDiagnostics {
  const split = splitDiagnostics(body);
  const fallback = split.errors.length === 0 && split.warnings.length === 0 ? [body] : [];
  const errors = sanitizeDiagnostics([...split.errors, ...fallback], secret);
  const warnings = sanitizeDiagnostics(split.warnings, secret);
  return {
    errors,
    warnings,
    truncated:
      split.errors.length + fallback.length > MAX_DIAGNOSTICS ||
      split.warnings.length > MAX_DIAGNOSTICS,
  };
}

/**
 * Separate warnings from errors in the response.
 *
 * Microsoft returns both in one list distinguished by an `isWarning` flag. An
 * error means the event was dropped; a warning means an optional field was
 * removed from an accepted event.
 */
export function splitDiagnostics(body: unknown): {
  errors: unknown[];
  warnings: unknown[];
} {
  if (!body || typeof body !== "object") return { errors: [], warnings: [] };

  const b = body as Record<string, unknown>;
  const list = [
    ...(Array.isArray(b.errors) ? b.errors : []),
    ...(Array.isArray(b.Errors) ? b.Errors : []),
    ...(Array.isArray(b.validationErrors) ? b.validationErrors : []),
  ];

  const errors: unknown[] = [];
  const warnings: unknown[] = [];
  for (const item of list) {
    const isWarning =
      item &&
      typeof item === "object" &&
      (item as Record<string, unknown>).isWarning === true;
    (isWarning ? warnings : errors).push(item);
  }
  return { errors, warnings };
}
