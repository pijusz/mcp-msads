import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

/**
 * Microsoft Advertising needs three credentials, not one:
 *   - a developer token (identifies the app to the Ads API)
 *   - an OAuth client id (the Entra ID app registration)
 *   - a refresh token (the user context; access tokens last ~1 hour)
 *
 * There is no client-credentials / daemon flow — the Ads API always requires a
 * user context, so a refresh token is mandatory. `bun run setup` mints one.
 */
const envSchema = z.object({
  /** Developer token. Sandbox uses the universal token `BBD37VB98`. */
  MSADS_DEVELOPER_TOKEN: z.string().default(""),
  /** Entra ID application (client) ID — a GUID. Legacy hex client ids are dead. */
  MSADS_CLIENT_ID: z.string().default(""),
  /**
   * Client secret. Optional, but strongly recommended: refresh tokens issued to
   * a *public* client are bound to the granting device and fail when the server
   * runs elsewhere. Registering a web app with a secret avoids that.
   */
  MSADS_CLIENT_SECRET: z.string().default(""),
  /** Long-lived refresh token. Either this or MSADS_TOKEN_FILE must be present. */
  MSADS_REFRESH_TOKEN: z.string().default(""),
  /** Path to a JSON token file written by `bun run setup`. */
  MSADS_TOKEN_FILE: z.string().default(""),
  /** Entra authority tenant. `common` supports both personal and work accounts. */
  MSADS_TENANT: z
    .string()
    .regex(
      /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/,
      "must be an Entra tenant alias, GUID, or verified domain",
    )
    .default("common"),
  /**
   * Which identity provider owns the Microsoft Advertising user.
   *
   * Microsoft Advertising accounts can be created with a Google account rather
   * than a Microsoft one — commonly, because sandbox sign-up with a Microsoft
   * account requires an outlook.com address. Such a user cannot be
   * authenticated with an Entra token at all: the API needs a Google OAuth
   * token plus an `IdentityProvider: Google` header.
   */
  MSADS_IDENTITY_PROVIDER: z.enum(["microsoft", "google"]).default("microsoft"),
  /** Which Microsoft Advertising environment to target. */
  MSADS_ENVIRONMENT: z.enum(["production", "sandbox"]).default("production"),
  /** Default manager (customer) id, used when a tool call omits it. */
  MSADS_CUSTOMER_ID: z.string().default(""),
  /** Default ad account id, used when a tool call omits it. */
  MSADS_ACCOUNT_ID: z.string().default(""),
  /** Probe the API once at startup to surface bad credentials early. */
  MSADS_VALIDATE_AT_STARTUP: z.enum(["true", "false"]).default("false"),
  /** Give up on an async report after this long. */
  MSADS_REPORT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(300_000),
  /** Base interval between report status polls (backs off from here). */
  MSADS_REPORT_POLL_MS: z.coerce.number().int().min(250).default(2000),
  /** Give up on an async bulk download after this long. */
  MSADS_BULK_TIMEOUT_MS: z.coerce.number().int().min(1000).default(600_000),
  /** Per-request timeout for a single HTTP call. */
  MSADS_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).default(60_000),
  /** Retry budget for explicitly safe reads and polls (429 / 5xx / throttles). */
  MSADS_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
  MSADS_LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).default("warn"),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;
let _dotenvLoaded = false;

/**
 * Parse one `.env` line into `{ key, value }`, or `null` for lines to ignore
 * (blank / comment / malformed). Exported for testing.
 *
 * Rules:
 *   - `#` after trim starts a comment line.
 *   - A leading `export ` is stripped.
 *   - Key and value split on the FIRST `=`.
 *   - Balanced surrounding `"` or `'` are stripped.
 *   - Unquoted values lose a trailing `  # comment`.
 *   - Literal `\n` sequences become real newlines.
 */
export function parseEnvLine(rawLine: string): { key: string; value: string } | null {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) return null;

  const withoutExport = line.startsWith("export ")
    ? line.slice("export ".length).trim()
    : line;
  const eq = withoutExport.indexOf("=");
  if (eq <= 0) return null;

  const key = withoutExport.slice(0, eq).trim();
  if (!key) return null;

  let value = withoutExport.slice(eq + 1).trim();
  const hasQuotes =
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"));
  if (hasQuotes && value.length >= 2) {
    value = value.slice(1, -1);
  } else {
    value = value.replace(/\s+#.*$/, "");
  }
  return { key, value: value.replace(/\\n/g, "\n") };
}

export function loadDotEnvIfPresent(): void {
  if (_dotenvLoaded) return;
  _dotenvLoaded = true;

  // Selecting a different file must REPLACE .env, never layer on top of it.
  // A production run that omits MSADS_ENVIRONMENT expects the production
  // default; silently inheriting MSADS_ENVIRONMENT=sandbox from .env would
  // point it at the sandbox hosts with no visible sign.
  const envFile = process.env.MSADS_ENV_FILE || ".env";
  if (!existsSync(envFile)) return;

  let text: string;
  try {
    text = readFileSync(envFile, "utf-8");
  } catch {
    return;
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const parsed = parseEnvLine(rawLine);
    if (!parsed) continue;
    // Never override a var the process was already given.
    if (process.env[parsed.key] !== undefined) continue;
    process.env[parsed.key] = parsed.value;
  }
}

function formatEnvError(err: z.ZodError): string {
  const lines = err.issues.map((issue) => {
    const key = issue.path.join(".") || "unknown";
    return `- ${key}: ${issue.message}`;
  });
  return `Invalid environment configuration:\n${lines.join("\n")}`;
}

export function loadEnv(): Env {
  if (_env) return _env;
  loadDotEnvIfPresent();
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(formatEnvError(parsed.error));
  }
  _env = parsed.data;
  return _env;
}

export function getEnv(): Env {
  if (!_env) return loadEnv();
  return _env;
}

/** Test-only: drop the memoized env so the next loadEnv() re-reads process.env. */
export function resetEnvForTesting(): void {
  _env = null;
  _dotenvLoaded = false;
}

export function isGoogleIdentity(): boolean {
  return getEnv().MSADS_IDENTITY_PROVIDER === "google";
}

export function isSandbox(): boolean {
  return getEnv().MSADS_ENVIRONMENT === "sandbox";
}

export function shouldValidateAtStartup(): boolean {
  return process.env.MSADS_VALIDATE_AT_STARTUP === "true";
}

/**
 * The sandbox accepts one universal developer token, so a sandbox user never
 * has to apply for one. Production has no such default.
 */
export const SANDBOX_DEVELOPER_TOKEN = "BBD37VB98";

/** Public "Tutorial Sample App" client id — sandbox only. */
export const SANDBOX_CLIENT_ID = "00001111-aaaa-2222-bbbb-3333cccc4444";

export function resolveDeveloperToken(): string {
  const env = getEnv();
  if (env.MSADS_DEVELOPER_TOKEN) return env.MSADS_DEVELOPER_TOKEN;
  if (isSandbox()) return SANDBOX_DEVELOPER_TOKEN;
  throw new Error(
    "MSADS_DEVELOPER_TOKEN is required for the production environment. " +
      "Request one at https://ads.microsoft.com/cc/Settings/DevSettings (Super Admin credentials required), " +
      "or set MSADS_ENVIRONMENT=sandbox to use the universal sandbox token.",
  );
}

export function resolveClientId(): string {
  const env = getEnv();
  if (env.MSADS_CLIENT_ID) return env.MSADS_CLIENT_ID;
  if (env.MSADS_IDENTITY_PROVIDER === "google") {
    throw new Error(
      "MSADS_CLIENT_ID is required for Google identity. Create an OAuth 2.0 Client ID " +
        "of type 'Web application' at https://console.cloud.google.com/apis/credentials — " +
        "Microsoft's sandbox sample client id only works for Microsoft accounts.",
    );
  }
  if (isSandbox()) return SANDBOX_CLIENT_ID;
  throw new Error(
    "MSADS_CLIENT_ID is required. Register an application in the Microsoft Entra admin center " +
      "(Accounts in any organizational directory and personal Microsoft accounts) and use its Application (client) ID.",
  );
}
