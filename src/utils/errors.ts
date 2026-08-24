/**
 * Microsoft Advertising API error handling.
 *
 * The API reports failures in three different ways and a client has to handle
 * all of them:
 *
 *  1. **Operation errors** — the whole call failed. `OperationErrors` /
 *     `Errors` array, numeric `Code` + symbolic `ErrorCode`.
 *  2. **Partial errors** — a batch call where *some* items failed. Microsoft
 *     has no all-or-nothing mode: "You will have to handle that on the client
 *     side." Successful indices come back as `null` in the id array, failures
 *     land in `PartialErrors` / `NestedPartialErrors` keyed by `Index`.
 *  3. **OAuth errors** — from login.microsoftonline.com, a completely
 *     different envelope (`error` / `error_description`).
 *
 * Reference:
 *   https://learn.microsoft.com/en-us/advertising/guides/operation-error-codes
 *   https://learn.microsoft.com/en-us/advertising/guides/handle-service-errors-exceptions
 */

/** Numeric operation error codes worth naming. */
export const ErrorCode = {
  InternalError: 0,
  NullRequest: 100,
  InvalidCredentials: 105,
  UserIsNotAuthorized: 106,
  UserCompromised: 108,
  AuthenticationTokenExpired: 109,
  InvalidDateObject: 113,
  RequestMissingHeaders: 116,
  CallRateExceeded: 117,
  UserLoginAccessDenied: 120,
  ConcurrentRequestOverLimit: 207,
  AccountTooBigToDownload: 3207,
  BulkNoMoreCallsPermitted: 4204,
} as const;

/**
 * Short, actionable hints keyed by numeric error code. These are the codes an
 * operator can actually do something about; anything else falls through to the
 * API's own message.
 */
const HINTS: Record<number, string> = {
  0: "Transient internal error on Microsoft's side — retried automatically; if it persists, retry later.",
  100: "The request body was empty or unparseable.",
  105:
    "Invalid credentials. The usual cause is an environment mismatch — production tokens do not work against sandbox and vice versa. " +
    "Check MSADS_ENVIRONMENT, then confirm the developer token matches it (sandbox uses the universal token BBD37VB98).",
  106:
    "Authenticated, but this user lacks permission on the requested account or entity. " +
    "Verify the CustomerId / CustomerAccountId pair, and that the signed-in user has a role on that account.",
  108: "Microsoft flagged this account for suspicious activity. The user must reset their password before the API will work.",
  109: "Access token expired — refreshed automatically and the call retried.",
  113: "A date field is malformed. Dates are objects: { Day, Month, Year }.",
  116:
    "A required header is missing. Campaign Management, Reporting, Bulk, and Ad Insight need CustomerId and CustomerAccountId; " +
    "Customer Management and Customer Billing must NOT receive them.",
  117: "Call rate exceeded — Microsoft enforces a rolling 60-second per-user window. Waited and retried; reduce call volume by batching.",
  120: "This is a merged or secondary login. Sign in with the primary Microsoft Advertising credentials instead.",
  122: "Use the work or school account for these credentials, not the personal account.",
  123: "Use the personal account for these credentials, not the work or school account.",
  124: "This email maps to two identities — pick the correct one during consent.",
  125: "This email maps to two identities — pick the correct one during consent.",
  207: "Too many reports in flight. This limit is not time-based: wait for pending reports to finish, then resubmit.",
  3207: "Account is too large for a whole-account bulk download (over ~4M keywords). Download by campaign id instead.",
  4204: "Bulk download/upload rate limit hit. Microsoft tracks upload and download separately; wait up to 15 minutes.",
};

export interface MsAdsOperationError {
  /** Numeric code, e.g. 105. */
  code?: number;
  /** Symbolic code, e.g. "InvalidCredentials". */
  errorCode?: string;
  message?: string;
  details?: string;
  /** Which request field triggered it, when the API says. */
  fieldPath?: string;
}

/** One failed item inside a batch operation. */
export interface MsAdsBatchError extends MsAdsOperationError {
  /** Zero-based position of the failing child item in the request array. */
  index?: number;
  /** Zero-based parent position for NestedPartialErrors. */
  parent_index?: number;
}

export interface MsAdsErrorInfo {
  message: string;
  status?: number;
  /** Errors that failed the whole operation. */
  errors?: MsAdsOperationError[];
  /** Per-item failures from a batch operation. */
  partialErrors?: MsAdsBatchError[];
  /** Microsoft's log correlation id — support asks for this. */
  trackingId?: string;
  hint?: string;
  /** Safe, bounded provider-specific diagnostics suitable for tool output. */
  diagnostics?: unknown;
}

export class MsAdsError extends Error {
  readonly status?: number;
  readonly errors: MsAdsOperationError[];
  readonly partialErrors: MsAdsBatchError[];
  readonly trackingId?: string;
  readonly hint?: string;
  readonly diagnostics?: unknown;

  constructor(info: MsAdsErrorInfo) {
    super(info.message);
    this.name = "MsAdsError";
    this.status = info.status;
    this.errors = info.errors ?? [];
    this.partialErrors = info.partialErrors ?? [];
    this.trackingId = info.trackingId;
    this.hint = info.hint;
    this.diagnostics = info.diagnostics;
  }

  /** Every numeric code present anywhere in this error. */
  get codes(): number[] {
    return [...this.errors, ...this.partialErrors]
      .map((e) => e.code)
      .filter((c): c is number => typeof c === "number");
  }

  has(code: number): boolean {
    return this.codes.includes(code);
  }
}

/** Raised when the OAuth token endpoint rejects us. */
export class MsAdsAuthError extends Error {
  readonly oauthError?: string;
  readonly description?: string;
  /** True when the refresh token is dead and only re-consent will fix it. */
  readonly needsReconsent: boolean;

  constructor(message: string, oauthError?: string, description?: string) {
    super(message);
    this.name = "MsAdsAuthError";
    this.oauthError = oauthError;
    this.description = description;
    this.needsReconsent = oauthError === "invalid_grant";
  }
}

/**
 * Reverse of the ErrorCode table. Microsoft sometimes returns a numeric `Code`
 * with no symbolic `ErrorCode`, which would otherwise surface as a bare
 * "Error 109" — useless to a reader. Recover the name from the number.
 */
const CODE_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(ErrorCode).map(([name, code]) => [code, name]),
);

export function nameForCode(code: number | undefined): string | undefined {
  return code === undefined ? undefined : CODE_NAMES[code];
}

export function hintForCode(code: number | undefined): string | undefined {
  return code === undefined ? undefined : HINTS[code];
}

/**
 * Read one error object out of a response. Microsoft is not consistent about
 * casing or field names across services (`Code`/`code`, `ErrorCode`/`Error`,
 * `Message`/`Detail`), so accept the documented spellings and the observed ones.
 */
function readError(raw: unknown): MsAdsOperationError | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const out: MsAdsOperationError = {
    code: num(e.Code) ?? num(e.code),
    errorCode: str(e.ErrorCode) ?? str(e.errorCode) ?? str(e.Error),
    message: str(e.Message) ?? str(e.message) ?? str(e.Detail),
    details: str(e.Details) ?? str(e.details),
    fieldPath: str(e.FieldPath) ?? str(e.fieldPath),
  };
  const hasAnything = Object.values(out).some((v) => v !== undefined);
  return hasAnything ? out : null;
}

function readErrorArray(raw: unknown): MsAdsOperationError[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(readError).filter((e): e is MsAdsOperationError => e !== null);
}

/**
 * Read `PartialErrors` (flat) and `NestedPartialErrors` (grouped by parent
 * index, used by operations that write child entities such as ad groups within
 * campaigns). Both collapse to a flat list carrying the item index.
 */
export function readPartialErrors(body: unknown): MsAdsBatchError[] {
  if (!body || typeof body !== "object") return [];
  const b = body as Record<string, unknown>;
  const out: MsAdsBatchError[] = [];

  const pushWithIndex = (raw: unknown, parentIndex?: number) => {
    const parsed = readError(raw);
    if (!parsed) return;
    const item = raw as Record<string, unknown>;
    const idx = item.Index ?? item.index;
    out.push({
      ...parsed,
      index: typeof idx === "number" ? idx : undefined,
      ...(parentIndex !== undefined ? { parent_index: parentIndex } : {}),
    });
  };

  const partial = b.PartialErrors ?? b.partialErrors;
  if (Array.isArray(partial)) {
    for (const item of partial) pushWithIndex(item);
  }
  const nested = b.NestedPartialErrors ?? b.nestedPartialErrors;
  if (Array.isArray(nested)) {
    for (const group of nested) {
      if (!group || typeof group !== "object") continue;
      const g = group as Record<string, unknown>;
      // BatchErrorCollection: an outer index plus its own BatchErrors array.
      const innerRaw = g.BatchErrors ?? g.batchErrors;
      const inner = Array.isArray(innerRaw) ? innerRaw : [];
      if (inner.length === 0) {
        pushWithIndex(group);
        continue;
      }
      const parent = g.Index ?? g.index;
      const parentIndex = typeof parent === "number" ? parent : undefined;
      for (const item of inner) pushWithIndex(item, parentIndex);
    }
  }
  return out;
}

/**
 * Turn a non-OK REST response into a typed MsAdsError.
 *
 * The fault envelope varies by service — `OperationErrors` (AdApiFaultDetail),
 * `Errors`, or a bare error object — so try each in turn rather than assuming
 * one shape.
 */
export function parseApiError(status: number, body: unknown): MsAdsError {
  if (typeof body === "string") {
    return new MsAdsError({
      status,
      message: body.trim()
        ? `Microsoft Advertising API error (HTTP ${status}): ${truncate(body)}`
        : `Microsoft Advertising API error (HTTP ${status})`,
    });
  }
  if (!body || typeof body !== "object") {
    return new MsAdsError({
      status,
      message: `Microsoft Advertising API error (HTTP ${status})`,
    });
  }

  const b = body as Record<string, unknown>;
  // Container keys vary in casing across services the same way field names do.
  const errors = [
    ...readErrorArray(b.OperationErrors ?? b.operationErrors),
    ...readErrorArray(b.Errors ?? b.errors),
    ...readErrorArray(b.BatchErrors ?? b.batchErrors),
  ];
  // Some services return a single bare fault rather than an array.
  if (errors.length === 0) {
    const single = readError(b);
    if (single) errors.push(single);
  }
  const partialErrors = readPartialErrors(b);
  const trackingId =
    typeof b.TrackingId === "string"
      ? b.TrackingId
      : typeof b.trackingId === "string"
        ? b.trackingId
        : undefined;

  const primary = errors[0] ?? partialErrors[0];
  const message = buildMessage(status, errors, partialErrors);

  return new MsAdsError({
    status,
    message,
    errors,
    partialErrors,
    trackingId,
    hint: hintForCode(primary?.code),
  });
}

function buildMessage(
  status: number,
  errors: MsAdsOperationError[],
  partialErrors: MsAdsBatchError[],
): string {
  const primary = errors[0] ?? partialErrors[0];
  if (!primary) return `Microsoft Advertising API error (HTTP ${status})`;

  const label = primary.errorCode ?? nameForCode(primary.code) ?? "Error";
  const code = primary.code !== undefined ? ` ${primary.code}` : "";
  const detail = primary.message ?? primary.details ?? `HTTP ${status}`;
  const extra =
    errors.length + partialErrors.length > 1
      ? ` (+${errors.length + partialErrors.length - 1} more)`
      : "";
  return `${label}${code}: ${detail}${extra}`;
}

function truncate(text: string, max = 500): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Parse an OAuth token-endpoint failure. */
export function parseOAuthError(status: number, body: unknown): MsAdsAuthError {
  const b = (body ?? {}) as Record<string, unknown>;
  const err = typeof b.error === "string" ? b.error : undefined;
  const desc = typeof b.error_description === "string" ? b.error_description : undefined;

  let message = `OAuth token request failed (HTTP ${status})`;
  if (err) message += `: ${err}`;
  if (desc) message += ` — ${desc}`;
  if (err === "invalid_grant") {
    message +=
      "\n\nThe refresh token is no longer usable. Common causes: it expired (90 days idle), " +
      "the user changed their password or revoked consent, or — most often for a server — " +
      "the token was issued to a PUBLIC client, which binds it to the granting device. " +
      "Register a Web application WITH a client secret and re-run `mcp-msads setup`.";
  }
  return new MsAdsAuthError(message, err, desc);
}
