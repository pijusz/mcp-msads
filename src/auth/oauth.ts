import { readSecureFile, withFileLock, writeSecureFile } from "@/auth/secure-file";
import { getEnv, isGoogleIdentity, resolveClientId } from "@/config/env";
import { MsAdsAuthError, parseOAuthError } from "@/utils/errors";
import { log } from "@/utils/logger";
import { MAX_API_RESPONSE_BYTES, readResponseBytes } from "@/utils/safe-http";

/**
 * OAuth 2.0 against the Microsoft identity platform, by hand.
 *
 * Deliberately not @azure/msal-node: MSAL owns the refresh token inside an
 * opaque serialized cache and steers callers to acquireTokenSilent, so using
 * it would mean persisting a blob instead of a string the operator can read,
 * rotate, and paste. The flow we need is one POST.
 *
 * There is no client-credentials path — the Ads API always requires a user
 * context and rejects app-only tokens with error 105. Consent happens once via
 * `mcp-msads setup`; after that this module lives off the refresh token.
 *
 * https://learn.microsoft.com/en-us/advertising/guides/authentication-oauth
 */

/**
 * The only Microsoft scope the API accepts. `ads.manage` and `bingads.manage`
 * are dead — tokens minted with them are refused once MFA enforcement applies.
 */
export const SCOPE = "https://ads.microsoft.com/msads.manage offline_access";

/**
 * Google scope. Microsoft's federation only needs the user's identity; the
 * Ads permissions still come from their role on the account, not from here.
 */
export const GOOGLE_SCOPE = "profile email";

export function authorityBase(tenant = getEnv().MSADS_TENANT): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0`;
}

/** Which scope string to request, per configured identity provider. */
export function scopeFor(): string {
  return isGoogleIdentity() ? GOOGLE_SCOPE : SCOPE;
}

export function authorizeUrlBase(tenant?: string): string {
  if (isGoogleIdentity()) return "https://accounts.google.com/o/oauth2/v2/auth";
  return `${authorityBase(tenant)}/authorize`;
}

export function tokenUrl(tenant?: string): string {
  if (isGoogleIdentity()) return "https://oauth2.googleapis.com/token";
  return `${authorityBase(tenant)}/token`;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** ms epoch at which the access token stops being valid. */
  expiresAt: number;
  scope?: string;
}

/** Shape of the JSON file `setup` writes and this module rotates. */
export interface TokenFile {
  refresh_token: string;
  scope?: string;
  client_id?: string;
  tenant?: string;
  environment?: string;
  updated_at?: string;
}

/** Refresh this many ms before actual expiry, so in-flight calls don't race it. */
const EXPIRY_SKEW_MS = 5 * 60_000;

let cached: TokenSet | null = null;
/** Refresh token held in memory, so rotation survives without a token file. */
let currentRefreshToken: string | null = null;
/** De-dupes concurrent refreshes — many tools may call at once on first use. */
let inFlight: Promise<TokenSet> | null = null;

export function readTokenFile(path: string): TokenFile | null {
  try {
    const parsed = JSON.parse(readSecureFile(path)) as Record<string, unknown>;
    if (typeof parsed.refresh_token !== "string" || !parsed.refresh_token) return null;
    return {
      refresh_token: parsed.refresh_token,
      ...(typeof parsed.scope === "string" ? { scope: parsed.scope } : {}),
      ...(typeof parsed.client_id === "string" ? { client_id: parsed.client_id } : {}),
      ...(typeof parsed.tenant === "string" ? { tenant: parsed.tenant } : {}),
      ...(typeof parsed.environment === "string"
        ? { environment: parsed.environment }
        : {}),
      ...(typeof parsed.updated_at === "string" ? { updated_at: parsed.updated_at } : {}),
    };
  } catch {
    return null;
  }
}

export function writeTokenFile(path: string, data: TokenFile): void {
  const persisted: TokenFile = {
    refresh_token: data.refresh_token,
    ...(data.scope !== undefined ? { scope: data.scope } : {}),
    ...(data.client_id !== undefined ? { client_id: data.client_id } : {}),
    ...(data.tenant !== undefined ? { tenant: data.tenant } : {}),
    ...(data.environment !== undefined ? { environment: data.environment } : {}),
    ...(data.updated_at !== undefined ? { updated_at: data.updated_at } : {}),
  };
  writeSecureFile(path, `${JSON.stringify(persisted, null, 2)}\n`);
}

/**
 * Resolve the refresh token: whatever the last rotation produced, else the
 * token file, else the environment.
 */
export function getRefreshToken(): string {
  if (currentRefreshToken) return currentRefreshToken;

  const env = getEnv();
  if (env.MSADS_TOKEN_FILE) {
    const file = readTokenFile(env.MSADS_TOKEN_FILE);
    if (file?.refresh_token) {
      currentRefreshToken = file.refresh_token;
      return currentRefreshToken;
    }
  }
  if (env.MSADS_REFRESH_TOKEN) {
    currentRefreshToken = env.MSADS_REFRESH_TOKEN;
    return currentRefreshToken;
  }
  throw new MsAdsAuthError(
    "No refresh token available. Run `mcp-msads setup` to authorize once, then set " +
      "MSADS_REFRESH_TOKEN (or point MSADS_TOKEN_FILE at the file setup wrote).",
  );
}

/**
 * Persist a rotated refresh token. Entra returns a new one on every refresh
 * and expects the old one to be discarded, so losing this write means the
 * 90-day idle clock keeps running against a token we no longer use.
 */
function persistRefreshToken(token: string, tokens: TokenSet): void {
  const env = getEnv();
  if (env.MSADS_TOKEN_FILE) {
    writeTokenFile(env.MSADS_TOKEN_FILE, {
      refresh_token: token,
      ...(tokens.scope !== undefined ? { scope: tokens.scope } : {}),
      client_id: resolveClientId(),
      tenant: env.MSADS_TENANT,
      environment: env.MSADS_ENVIRONMENT,
      updated_at: new Date().toISOString(),
    });
  }
  currentRefreshToken = token;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

/** POST the token endpoint and normalize the response. */
export async function requestToken(form: Record<string, string>): Promise<TokenSet> {
  const body = new URLSearchParams(form);
  const timeoutMs = getEnv().MSADS_REQUEST_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  let res: Response;
  let raw: string;
  try {
    res = await fetch(tokenUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal,
    });
    raw = new TextDecoder().decode(await readResponseBytes(res, MAX_API_RESPONSE_BYTES));
  } catch (error) {
    if (signal.aborted) {
      throw new MsAdsAuthError(
        `Token request timed out after ${timeoutMs} ms (MSADS_REQUEST_TIMEOUT_MS).`,
      );
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { error_description: raw };
  }

  if (!res.ok) throw parseOAuthError(res.status, parsed);

  const data = parsed as TokenResponse;
  if (!data.access_token) {
    throw new MsAdsAuthError("Token endpoint returned no access_token.");
  }

  // Entra reports lifetime in seconds; default to the documented 1 hour.
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
  const set: TokenSet = {
    accessToken: data.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
    ...(data.refresh_token !== undefined ? { refreshToken: data.refresh_token } : {}),
    ...(data.scope !== undefined ? { scope: data.scope } : {}),
  };

  // A Microsoft token minted without msads.manage will be refused by the Ads
  // API with a confusing 105. Catching it here points at the real cause: stale
  // consent. Google tokens carry unrelated scopes, so the check does not apply.
  if (!isGoogleIdentity() && set.scope && !set.scope.includes("msads.manage")) {
    log.warn(
      `Token was granted scope "${set.scope}", which does not include msads.manage. ` +
        "The Microsoft Advertising API will reject it — re-run `mcp-msads setup` to re-consent.",
    );
  }
  return set;
}

/** Exchange an authorization code. Used by `setup`, not at runtime. */
export async function exchangeCode(params: {
  code: string;
  redirectUri: string;
  codeVerifier: string;
  clientId: string;
  clientSecret?: string;
}): Promise<TokenSet> {
  return requestToken({
    client_id: params.clientId,
    scope: scopeFor(),
    code: params.code,
    redirect_uri: params.redirectUri,
    grant_type: "authorization_code",
    code_verifier: params.codeVerifier,
    ...(params.clientSecret ? { client_secret: params.clientSecret } : {}),
  });
}

async function refreshWithToken(refreshToken: string): Promise<TokenSet> {
  const env = getEnv();
  const tokens = await requestToken({
    client_id: resolveClientId(),
    // Google rejects a refresh request that repeats the scope; Entra requires it.
    ...(isGoogleIdentity() ? {} : { scope: SCOPE }),
    refresh_token: refreshToken,
    grant_type: "refresh_token",
    ...(env.MSADS_CLIENT_SECRET ? { client_secret: env.MSADS_CLIENT_SECRET } : {}),
  });

  // Entra rotates the refresh token on every use; Google reuses the same one
  // and simply omits it from refresh responses. Both are handled by only
  // persisting when a genuinely new value comes back.
  if (tokens.refreshToken && tokens.refreshToken !== refreshToken) {
    persistRefreshToken(tokens.refreshToken, tokens);
  }
  cached = tokens;
  return tokens;
}

/** Trade the refresh token for a fresh access token (and a rotated refresh token). */
export async function refreshAccessToken(): Promise<TokenSet> {
  const env = getEnv();
  const tokenPath = env.MSADS_TOKEN_FILE;
  if (!tokenPath) return refreshWithToken(getRefreshToken());

  return withFileLock(tokenPath, async () => {
    // Another process may have rotated while this process waited for the lock.
    const refreshToken = readTokenFile(tokenPath)?.refresh_token ?? getRefreshToken();
    currentRefreshToken = refreshToken;
    return refreshWithToken(refreshToken);
  });
}

function isFresh(tokens: TokenSet | null): tokens is TokenSet {
  return tokens !== null && tokens.expiresAt - EXPIRY_SKEW_MS > Date.now();
}

/**
 * Return a usable access token, refreshing when the cached one is close to
 * expiry. Concurrent callers share one in-flight refresh.
 */
export async function getAccessToken(): Promise<string> {
  if (isFresh(cached)) return cached.accessToken;
  if (inFlight) return (await inFlight).accessToken;

  inFlight = refreshAccessToken().finally(() => {
    inFlight = null;
  });
  return (await inFlight).accessToken;
}

/**
 * Drop the cached access token so the next call refreshes. Used when the API
 * reports 109 (AuthenticationTokenExpired) before our own clock said so.
 */
export function invalidateAccessToken(): void {
  cached = null;
}

/** Test-only: clear every piece of module state. */
export function resetAuthForTesting(): void {
  cached = null;
  currentRefreshToken = null;
  inFlight = null;
}
