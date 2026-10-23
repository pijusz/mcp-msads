import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import {
  authorizeUrlBase,
  exchangeCode,
  GOOGLE_SCOPE,
  SCOPE,
  writeTokenFile,
} from "@/auth/oauth";
import { loadEnv, SANDBOX_CLIENT_ID } from "@/config/env";
import { MsAdsAuthError } from "@/utils/errors";

/**
 * One-time interactive authorization.
 *
 * Microsoft Advertising has no app-only auth path — a user must consent
 * through a browser at least once. After that the refresh token this writes
 * carries the server indefinitely, so this runs once per deployment, not once
 * per session.
 *
 * PKCE is used even though we send a client secret: Microsoft recommends it
 * "for all application types … including confidential clients like web apps",
 * and it costs nothing.
 */

const DEFAULT_PORT = 31544;
export const CALLBACK_HOST = "127.0.0.1";

interface SetupArgs {
  port: number;
  out?: string;
  allowInRepo: boolean;
  help?: boolean;
}

export const SETUP_USAGE = `
  Usage: mcp-msads setup [--port <n>] [--out <path>] [--allow-in-repo]

  Opens a browser for one-time OAuth consent and writes a mode-0600
  refresh-token file. Reads MSADS_CLIENT_ID, MSADS_CLIENT_SECRET,
  MSADS_ENVIRONMENT and MSADS_IDENTITY_PROVIDER from the environment.

    --port <n>        Loopback callback port (default ${DEFAULT_PORT}).
    --out <path>      Token file path (default: MSADS_TOKEN_FILE, else the
                      platform config directory).
    --allow-in-repo   Permit --out inside a Git checkout.
    -h, --help        Show this help without starting authorization.
`;

export function defaultTokenPath(
  platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  // Join with the target platform's separator, not the host's.
  const { join: joinFor } = platform === "win32" ? win32 : posix;
  const configRoot =
    platform === "win32"
      ? env.APPDATA || joinFor(home, "AppData", "Roaming")
      : platform === "darwin"
        ? joinFor(home, "Library", "Application Support")
        : env.XDG_CONFIG_HOME || joinFor(home, ".config");
  return joinFor(configRoot, "mcp-msads", "msads-token.json");
}

/**
 * Where setup should write, before `--out` is considered.
 *
 * An operator who has already set `MSADS_TOKEN_FILE` expects `setup` to
 * refresh *that* file. Writing to the platform default instead leaves the
 * server reading a stale token whose only symptom is error 105 on every call,
 * long after the browser said "Authorized".
 */
export function configuredTokenPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.MSADS_TOKEN_FILE?.trim();
  return configured || defaultTokenPath();
}

function canonicalOutputPath(path: string): string {
  let existing = path;
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    suffix.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...suffix);
}

function repositoryRootFor(path: string): string | null {
  let current = dirname(path);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function pathIsWithin(parent: string, path: string): boolean {
  const child = relative(parent, path);
  return child === "" || (!child.startsWith(`..${sep}`) && !isAbsolute(child));
}

export function resolveSetupOutput(
  args: SetupArgs,
  cwd = process.cwd(),
  defaultPath = configuredTokenPath(),
): string {
  const path = canonicalOutputPath(
    args.out ? resolve(cwd, args.out) : resolve(defaultPath),
  );
  const repositoryRoot = repositoryRootFor(path);
  if (!args.allowInRepo && repositoryRoot && pathIsWithin(repositoryRoot, path)) {
    throw new MsAdsAuthError(
      `Refusing to write an OAuth token inside the Git repository at ${repositoryRoot}. ` +
        "Choose a path outside the checkout or pass --allow-in-repo explicitly.",
    );
  }
  return path;
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(path, 0o700);
}

export function prepareSetupOutput(
  args: SetupArgs,
  cwd = process.cwd(),
  defaultPath = configuredTokenPath(),
): string {
  const path = resolveSetupOutput(args, cwd, defaultPath);
  if (!args.out) ensurePrivateDirectory(dirname(path));
  // Re-resolve after directory creation so a pre-existing symlink cannot hide
  // a repository destination during the initial prospective-path check.
  return resolveSetupOutput(args, cwd, path);
}

/** base64url without padding, per RFC 7636. */
function base64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  tenant?: string;
  google?: boolean;
}): string {
  const url = new URL(authorizeUrlBase(params.tenant));
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", params.google ? GOOGLE_SCOPE : SCOPE);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");

  if (params.google) {
    // Google withholds the refresh token unless BOTH of these are present, and
    // returns it only on a fresh consent — a silent re-consent yields an access
    // token that expires in an hour with no way to renew it.
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "select_account consent");
    return url.toString();
  }

  url.searchParams.set("response_mode", "query");
  // `select_account` forces the account picker AND the consent screen.
  //
  // Plain `consent` is a trap: if the browser already has an active Microsoft
  // session — very likely, since registering the app means having just been in
  // the Azure portal — Entra silently reuses THAT identity and only asks to
  // approve scopes. You end up authorized as your Entra admin rather than as
  // the user who owns the Microsoft Advertising account, and every call then
  // fails with error 105, which reads as a credentials problem rather than a
  // wrong-account one.
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export function browserLaunch(
  url: string,
  platform = process.platform,
): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") {
    return {
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
    };
  }
  return { command: "xdg-open", args: [url] };
}

export function openBrowser(url: string, platform = process.platform): void {
  const launch = browserLaunch(url, platform);
  try {
    const child = spawn(launch.command, launch.args, {
      detached: true,
      shell: false,
      stdio: "ignore",
    });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // Non-fatal: the URL is printed too.
  }
}

const SUCCESS_PAGE = `<!doctype html><meta charset="utf-8">
<title>mcp-msads authorized</title>
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;line-height:1.6">
<h2>Authorized</h2><p>You can close this tab and return to the terminal.</p></body>`;

function failurePage(message: string): string {
  return `<!doctype html><meta charset="utf-8">
<title>mcp-msads authorization failed</title>
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;line-height:1.6">
<h2>Authorization failed</h2><pre>${message.replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"))}</pre></body>`;
}

export function parseOAuthCallback(url: URL, expectedState: string): string {
  // State is checked before provider errors so an attacker cannot inject a
  // believable failure message into a callback they did not initiate.
  if (url.searchParams.get("state") !== expectedState) {
    throw new MsAdsAuthError("OAuth state mismatch; aborting.");
  }
  const error = url.searchParams.get("error");
  if (error) {
    const detail = url.searchParams.get("error_description") ?? error;
    throw new MsAdsAuthError(`Authorization denied: ${detail}`, error);
  }
  const code = url.searchParams.get("code");
  if (!code) throw new MsAdsAuthError("No authorization code received.");
  return code;
}

/** Run the local callback server and resolve with the authorization code. */
export function awaitCallback(port: number, expectedState: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let timer: ReturnType<typeof setTimeout>;
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${CALLBACK_HOST}:${port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }

      const finish = (status: number, page: string) => {
        clearTimeout(timer);
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page);
        server.close();
      };

      try {
        const code = parseOAuthCallback(url, expectedState);
        finish(200, SUCCESS_PAGE);
        resolvePromise(code);
      } catch (error) {
        const authError = error as MsAdsAuthError;
        finish(400, failurePage(authError.message));
        rejectPromise(authError);
      }
    });

    server.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(
        new MsAdsAuthError(
          `Could not listen on ${CALLBACK_HOST}:${port}: ${(err as Error).message}. ` +
            "Pass --port to choose another, and register the matching redirect URI.",
        ),
      );
    });

    server.listen(port, CALLBACK_HOST, () => {
      console.log(
        `  Listening for the callback on http://${CALLBACK_HOST}:${port}/callback`,
      );
    });

    timer = setTimeout(() => {
      server.close();
      rejectPromise(new MsAdsAuthError("Authorization timed out after 5 minutes."));
    }, 5 * 60_000);
    timer.unref?.();
  });
}

export function parseSetupArgs(argv: string[]): SetupArgs {
  let port = DEFAULT_PORT;
  let out: string | undefined;
  let allowInRepo = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      return { port, allowInRepo, help: true };
    }
    if (arg === "--port" && argv[i + 1]) {
      port = Number(argv[++i]);
    } else if (arg === "--out" && argv[i + 1]) {
      out = argv[++i];
    } else if (arg === "--allow-in-repo") {
      allowInRepo = true;
    } else {
      // Unknown flags (or a flag missing its value) used to be ignored, which
      // meant a typo or `setup --help` silently launched a real authorization.
      throw new MsAdsAuthError(
        `Unknown or incomplete setup argument: ${arg}\n${SETUP_USAGE}`,
      );
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new MsAdsAuthError("--port must be an integer between 1 and 65535.");
  }
  return { port, ...(out ? { out } : {}), allowInRepo };
}

export async function runSetup(argv: string[] = []): Promise<void> {
  const args = parseSetupArgs(argv);
  if (args.help) {
    console.log(SETUP_USAGE);
    return;
  }
  const { port } = args;
  const outPath = prepareSetupOutput(args);
  const env = loadEnv();
  const sandbox = env.MSADS_ENVIRONMENT === "sandbox";
  const google = env.MSADS_IDENTITY_PROVIDER === "google";
  const clientId = env.MSADS_CLIENT_ID || (sandbox && !google ? SANDBOX_CLIENT_ID : "");
  const redirectUri = `http://${CALLBACK_HOST}:${port}/callback`;

  console.log(
    `\n  mcp-msads — authorization setup (${env.MSADS_ENVIRONMENT}, ` +
      `${google ? "Google" : "Microsoft"} identity)\n`,
  );

  if (google && !clientId) {
    console.error(
      "  MSADS_CLIENT_ID is not set.\n\n" +
        "  Your Microsoft Advertising account signs in with Google, so the OAuth\n" +
        "  client must be a Google one — a Microsoft app registration cannot\n" +
        "  authenticate that user.\n\n" +
        "  Create one:\n" +
        "    1. https://console.cloud.google.com/apis/credentials\n" +
        "    2. Create credentials -> OAuth client ID\n" +
        "    3. Prefer Desktop app for local setup; it accepts loopback ports without registration.\n" +
        "       If you choose Web application, register this exact authorized redirect URI: " +
        redirectUri +
        "\n" +
        "    4. Copy the Client ID and Client secret\n\n" +
        "  Set them as MSADS_CLIENT_ID and MSADS_CLIENT_SECRET.\n",
    );
    process.exit(1);
  }

  if (!clientId) {
    console.error(
      "  MSADS_CLIENT_ID is not set.\n\n" +
        "  Register an application first:\n" +
        "    1. https://portal.azure.com → Microsoft Entra ID → App registrations → New registration\n" +
        "    2. Supported account types: 'Accounts in any organizational directory and personal\n" +
        "       Microsoft accounts'. Anything narrower fails against the /common endpoint.\n" +
        "    3. Platform: Web. Redirect URI: " +
        redirectUri +
        "\n" +
        "    4. Certificates & secrets → New client secret. Set it as MSADS_CLIENT_SECRET.\n\n" +
        "  Register a WEB app with a secret, not a public/native client: a public-client\n" +
        "  refresh token is bound to the device that granted it and will fail on any other host.\n",
    );
    process.exit(1);
  }

  // The Certificates & secrets table shows Value next to Secret ID, and the
  // wrong column is the more id-looking one. A GUID here is almost certainly
  // the Secret ID, which fails much later with an opaque invalid_client.
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      env.MSADS_CLIENT_SECRET,
    )
  ) {
    console.error(
      "  MSADS_CLIENT_SECRET is a GUID, which means it is the secret's ID rather\n" +
        "  than the secret itself.\n\n" +
        "  In Certificates & secrets, the client secrets table has two similar\n" +
        "  columns. You want the VALUE column (roughly 40 characters, usually\n" +
        "  containing a '~'), not Secret ID.\n\n" +
        "  The value is only displayed when the secret is created. If it is no\n" +
        "  longer visible, delete that secret and add a new one.\n",
    );
    process.exit(1);
  }

  if (!env.MSADS_CLIENT_SECRET && !google) {
    console.warn(
      "  Warning: MSADS_CLIENT_SECRET is not set.\n" +
        "  Without a client secret this is a public client, and Microsoft binds the resulting\n" +
        "  refresh token to this device — it will fail with invalid_grant if the server runs\n" +
        "  anywhere else. Fine for local use; not for a deployment.\n",
    );
  }

  const { verifier, challenge } = createPkcePair();
  const state = base64Url(randomBytes(16));
  const authUrl = buildAuthorizeUrl({
    clientId,
    redirectUri,
    challenge,
    state,
    tenant: env.MSADS_TENANT,
    google,
  });

  console.log(
    google
      ? "  Sign in with the GOOGLE account that owns the Microsoft Advertising\n" +
          "  account. Picking a different Google account authorizes successfully\n" +
          "  and then fails every API call with error 105.\n"
      : "  Sign in as the user who owns the Microsoft Advertising account —\n" +
          "  NOT necessarily the account you use for the Azure portal. They are\n" +
          "  usually different identities, and picking the wrong one authorizes\n" +
          "  successfully but then fails every API call with error 105.\n",
  );
  console.log("  Opening your browser to authorize...\n");
  console.log(`  If it does not open, visit:\n  ${authUrl}\n`);
  const callback = awaitCallback(port, state);
  openBrowser(authUrl);

  const code = await callback;
  console.log("  Exchanging the authorization code for tokens...");

  const tokens = await exchangeCode({
    code,
    redirectUri,
    codeVerifier: verifier,
    clientId,
    ...(env.MSADS_CLIENT_SECRET ? { clientSecret: env.MSADS_CLIENT_SECRET } : {}),
  });

  if (!tokens.refreshToken) {
    console.error(
      "\n  No refresh token was returned. The 'offline_access' scope was not granted —\n" +
        "  check the app registration's API permissions and try again.\n",
    );
    process.exit(1);
  }

  writeTokenFile(outPath, {
    refresh_token: tokens.refreshToken,
    ...(tokens.scope !== undefined ? { scope: tokens.scope } : {}),
    client_id: clientId,
    tenant: env.MSADS_TENANT,
    environment: env.MSADS_ENVIRONMENT,
    updated_at: new Date().toISOString(),
  });

  console.log(`\n  Authorized. Token saved to ${outPath} (mode 0600).\n`);
  if (env.MSADS_TOKEN_FILE && !args.out) {
    console.log(
      "  This is the file MSADS_TOKEN_FILE already points at, so the\n" +
        "  server picks the new token up with no further changes.\n",
    );
  }
  console.log("  Add to your environment:\n");
  console.log(`    MSADS_TOKEN_FILE=${outPath}`);
  console.log(`    MSADS_CLIENT_ID=${clientId}`);
  if (env.MSADS_CLIENT_SECRET) console.log("    MSADS_CLIENT_SECRET=<your secret>");
  console.log(
    sandbox
      ? "    MSADS_ENVIRONMENT=sandbox\n"
      : "    MSADS_DEVELOPER_TOKEN=<your developer token>\n",
  );
  console.log("  Or copy the refresh token itself into MSADS_REFRESH_TOKEN.\n");
  console.log(
    google
      ? "  Note: Google refresh tokens do not rotate and do not expire through\n" +
          "  normal use. They stop working if you revoke the app's access, change\n" +
          "  the account password, or leave them unused for six months.\n"
      : "  Note: refresh tokens rotate on every use and idle out after ~90 days.\n" +
          "  Using MSADS_TOKEN_FILE lets the server persist each rotation; with\n" +
          "  MSADS_REFRESH_TOKEN alone, rotation is kept in memory only.\n",
  );
}

// `mcp-msads setup` reaches runSetup through src/index.ts. Running this file
// directly used to define the function and exit 0 with no output and no
// browser, which looks exactly like a successful run that did nothing.
if (import.meta.main) {
  await runSetup(process.argv.slice(2));
}
