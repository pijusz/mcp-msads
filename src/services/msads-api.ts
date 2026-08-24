import { getAccessToken, invalidateAccessToken } from "@/auth/oauth";
import { getEnv, isGoogleIdentity, isSandbox, resolveDeveloperToken } from "@/config/env";
import { ErrorCode, MsAdsError, parseApiError } from "@/utils/errors";
import { log } from "@/utils/logger";
import {
  MAX_API_RESPONSE_BYTES,
  MAX_DOWNLOAD_BYTES,
  parseJsonBytes,
  readResponseBytes,
  type SafeHttpDependencies,
  safeFetchBytes,
} from "@/utils/safe-http";

/**
 * Microsoft Advertising REST/JSON client.
 *
 * REST rather than SOAP on purpose: Microsoft stops shipping features to SOAP
 * on 2026-10-01 and removes it entirely on 2027-01-31, so a SOAP envelope
 * builder would be dead code within months. REST covers every operation.
 *
 * The REST surface is not content negotiation over the .svc endpoints — it is
 * a separate URL grammar on the same hosts:
 *   SOAP  https://campaign.api.bingads.microsoft.com/Api/Advertiser/CampaignManagement/v13/CampaignManagementService.svc
 *   REST  https://campaign.api.bingads.microsoft.com/CampaignManagement/v13/Campaigns/QueryByAccountId
 *
 * Reads are POSTs with a JSON body, not GETs.
 */

export type ServiceName =
  | "CustomerManagement"
  | "CustomerBilling"
  | "CampaignManagement"
  | "Reporting"
  | "Bulk"
  | "AdInsight";

interface ServiceSpec {
  /** Subdomain under `api[.sandbox].bingads.microsoft.com`. */
  host: string;
  /** First path segment, which is not always the service name (Bulk is `Bulk`). */
  prefix: string;
  /**
   * Whether this service takes the CustomerId / CustomerAccountId headers.
   * Customer Management and Customer Billing reject them — sending them
   * anyway is a documented source of confusion, so we model it per service.
   */
  accountScoped: boolean;
}

const SERVICES: Record<ServiceName, ServiceSpec> = {
  CustomerManagement: {
    host: "clientcenter",
    prefix: "CustomerManagement/v13",
    accountScoped: false,
  },
  CustomerBilling: {
    host: "clientcenter",
    prefix: "CustomerBilling/v13",
    accountScoped: false,
  },
  CampaignManagement: {
    host: "campaign",
    prefix: "CampaignManagement/v13",
    accountScoped: true,
  },
  Reporting: { host: "reporting", prefix: "Reporting/v13", accountScoped: true },
  Bulk: { host: "bulk", prefix: "Bulk/v13", accountScoped: true },
  AdInsight: { host: "adinsight", prefix: "AdInsight/v13", accountScoped: true },
};

export const SERVICE_NAMES = Object.keys(SERVICES) as ServiceName[];

/** Whether a service takes the CustomerId / CustomerAccountId headers. */
export function isAccountScoped(service: ServiceName): boolean {
  return SERVICES[service].accountScoped;
}

export function serviceBaseUrl(service: ServiceName): string {
  const spec = SERVICES[service];
  const domain = isSandbox()
    ? "api.sandbox.bingads.microsoft.com"
    : "api.bingads.microsoft.com";
  return `https://${spec.host}.${domain}/${spec.prefix}`;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  /** Manager (customer) id override for this call. */
  customerId?: string;
  /** Ad account id override for this call. */
  accountId?: string;
  timeout?: number;
  retries?: number;
  /** Explicitly marks this operation safe to replay after transient failures. */
  retry?: "safe";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Assemble request headers.
 *
 * `Authorization` must carry the `Bearer ` prefix — the docs call this out
 * because SOAP's AuthenticationToken element did not use one.
 */
export async function buildHeaders(
  service: ServiceName,
  opts: RequestOptions = {},
): Promise<Record<string, string>> {
  const env = getEnv();
  const spec = SERVICES[service];
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await getAccessToken()}`,
    DeveloperToken: resolveDeveloperToken(),
    "Content-Type": "application/json",
    // Microsoft advertises HTTP compression as a REST benefit; reports are big.
    "Accept-Encoding": "gzip, deflate",
    // Tells Microsoft the bearer token was issued by Google rather than Entra.
    // Required for accounts created with a Google sign-in; omitting it makes
    // every call fail with error 105, since Microsoft tries to validate a
    // Google token as one of its own.
    ...(isGoogleIdentity() ? { IdentityProvider: "Google" } : {}),
  };

  if (spec.accountScoped) {
    const customerId = opts.customerId ?? env.MSADS_CUSTOMER_ID;
    const accountId = opts.accountId ?? env.MSADS_ACCOUNT_ID;
    if (customerId) headers.CustomerId = String(customerId);
    if (accountId) headers.CustomerAccountId = String(accountId);
  }

  return headers;
}

/** Codes that are worth another attempt rather than an immediate failure. */
const RETRYABLE_CODES = new Set<number>([
  ErrorCode.InternalError, // 0   — transient on Microsoft's side
  ErrorCode.CallRateExceeded, // 117 — rolling 60s per-user window
  ErrorCode.ConcurrentRequestOverLimit, // 207 — too many reports in flight
  ErrorCode.BulkNoMoreCallsPermitted, // 4204 — bulk throttle
]);

function shouldRetry(status: number, err?: MsAdsError): boolean {
  if (status === 429 || status >= 500) return true;
  if (!err) return false;
  return err.codes.some((c) => RETRYABLE_CODES.has(c));
}

/**
 * Backoff schedule. Microsoft's throttles are measured in minutes, not
 * milliseconds, so the rate-limit codes get their own much longer curve —
 * retrying 117 after one second just burns another call against the window.
 */
export function retryDelayMs(attempt: number, err?: MsAdsError): number {
  const jitter = Math.floor(Math.random() * 500);
  if (err?.has(ErrorCode.CallRateExceeded)) {
    // Docs say wait 60s; ramp toward that instead of stalling the first retry.
    return Math.min(60_000, 10_000 * 2 ** attempt) + jitter;
  }
  if (
    err?.has(ErrorCode.BulkNoMoreCallsPermitted) ||
    err?.has(ErrorCode.ConcurrentRequestOverLimit)
  ) {
    return Math.min(60_000, 15_000 * 2 ** attempt) + jitter;
  }
  return 1000 * 2 ** attempt + jitter;
}

/**
 * Largest delay we will honor from a server. Microsoft's own throttles top out
 * around a minute; a `Retry-After: 86400` would otherwise block a single tool
 * call for a day with no way for the caller to intervene.
 */
export const MAX_RETRY_DELAY_MS = 60_000;

/** Honor a server-sent Retry-After (seconds, or an HTTP date), capped. */
export function retryAfterMs(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, seconds * 1000));
  }
  const date = Date.parse(raw);
  if (Number.isFinite(date)) {
    return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, date - Date.now()));
  }
  return null;
}

async function readBody(res: Response): Promise<unknown> {
  const bytes = await readResponseBytes(res, MAX_API_RESPONSE_BYTES);
  const contentType = res.headers.get("content-type") ?? "";
  return contentType.includes("json")
    ? parseJsonBytes(bytes)
    : new TextDecoder().decode(bytes);
}

/**
 * Call a Microsoft Advertising REST operation.
 *
 * Handles, in order: token refresh on 109, retry with backoff on throttling and
 * transient failures, and translation of the fault envelope into MsAdsError.
 */
export async function msadsFetch<T>(
  service: ServiceName,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch is unavailable. Use Node 18+ or Bun.");
  }

  const env = getEnv();
  const {
    method = "POST",
    body,
    timeout = env.MSADS_REQUEST_TIMEOUT_MS,
    retries = env.MSADS_MAX_RETRIES,
  } = opts;
  const retryBudget = opts.retry === "safe" ? retries : 0;

  const url = `${serviceBaseUrl(service)}/${path.replace(/^\/+/, "")}`;
  let refreshedOnce = false;
  let lastError: MsAdsError | undefined;

  for (let attempt = 0; attempt <= retryBudget; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const headers = await buildHeaders(service, opts);
      const init: RequestInit = { method, headers, signal: controller.signal };
      if (body !== undefined) init.body = JSON.stringify(body);

      const res = await fetch(url, init);
      // NOTE: the timer is deliberately NOT cleared here. fetch resolves when
      // the HEADERS arrive; a server that then stalls mid-body would hang
      // forever with the abort already disarmed. It is cleared in `finally`.
      if (res.ok) {
        const parsed = await readBody(res);
        return (parsed ?? {}) as T;
      }

      const err = parseApiError(res.status, await readBody(res));
      lastError = err;

      // 109 means the token died earlier than our clock predicted. Refresh and
      // replay once — this is exactly what Microsoft's own SDKs do.
      if (err.has(ErrorCode.AuthenticationTokenExpired) && !refreshedOnce) {
        refreshedOnce = true;
        invalidateAccessToken();
        log.info("Access token expired (109) — refreshing and retrying once");
        attempt--; // the replay shouldn't consume the throttling retry budget
        continue;
      }

      if (attempt < retryBudget && shouldRetry(res.status, err)) {
        const delay = retryAfterMs(res.headers) ?? retryDelayMs(attempt, err);
        log.warn(
          `${service} ${path} → HTTP ${res.status} (${err.message}); retrying in ${delay}ms ` +
            `(attempt ${attempt + 1}/${retryBudget})`,
        );
        await sleep(delay);
        continue;
      }

      throw err;
    } catch (err) {
      if (err instanceof MsAdsError) throw err;

      const reason = (err as Error).message ?? String(err);
      const aborted = (err as Error).name === "AbortError";
      if (attempt < retryBudget) {
        const delay = retryDelayMs(attempt);
        log.warn(
          `${service} ${path} ${aborted ? "timeout" : "network error"}, retrying in ${delay}ms: ${reason}`,
        );
        await sleep(delay);
        continue;
      }
      throw new MsAdsError({
        message: aborted
          ? `${service} ${path} timed out after ${timeout}ms. Raise MSADS_REQUEST_TIMEOUT_MS if this is a large operation.`
          : `Network error calling ${service} ${path}: ${reason}`,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new MsAdsError({ message: `${service} ${path} failed` });
}

/**
 * Download a file the API handed us a URL for (report and bulk results).
 *
 * These URLs are pre-signed and short-lived — report URLs last 5 minutes — and
 * must NOT carry our auth headers. They also live on a CDN whose domain
 * Microsoft explicitly reserves the right to change, so nothing here pins a host.
 */
export async function downloadFile(
  url: string,
  timeoutMs = 120_000,
  maxBytes = MAX_DOWNLOAD_BYTES,
  dependencies: SafeHttpDependencies = {},
): Promise<Buffer> {
  const res = await safeFetchBytes(
    url,
    { method: "GET" },
    {
      timeoutMs,
      maxBytes,
      ...dependencies,
    },
  );
  if (!res.ok) {
    throw new MsAdsError({
      status: res.status,
      message:
        res.status === 403 || res.status === 404
          ? `Download URL rejected (HTTP ${res.status}). These URLs expire ~5 minutes after being issued — poll again for a fresh one.`
          : `Failed to download result file (HTTP ${res.status}).`,
    });
  }
  return res.bytes;
}
