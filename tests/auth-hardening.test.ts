import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readTokenFile,
  requestToken,
  resetAuthForTesting,
  type TokenFile,
  writeTokenFile,
} from "@/auth/oauth";
import { recoveryPathFor, withFileLock } from "@/auth/secure-file";
import {
  browserLaunch,
  CALLBACK_HOST,
  configuredTokenPath,
  defaultTokenPath,
  openBrowser,
  parseOAuthCallback,
  parseSetupArgs,
  prepareSetupOutput,
  resolveSetupOutput,
} from "@/auth/setup";
import { loadDotEnvIfPresent, loadEnv, resetEnvForTesting } from "@/config/env";
import { setTestEnv } from "./_mock";
import { denyFetch } from "./_network-deny";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REFRESH_WORKER = join(PROJECT_ROOT, "tests", "fixtures", "token-refresh-worker.ts");
const LOCK_HOLDER = join(PROJECT_ROOT, "tests", "fixtures", "credential-lock-holder.ts");
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "mcp-msads-auth-"));
  temporaryDirectories.push(path);
  return path;
}

function syntheticToken(refreshToken: string): TokenFile {
  return { refresh_token: refreshToken, updated_at: new Date(0).toISOString() };
}

afterEach(() => {
  globalThis.fetch = denyFetch;
  resetAuthForTesting();
  setTestEnv();
  resetEnvForTesting();
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("secure token files", () => {
  test("writes new and existing files as 0600 and persists no access token", () => {
    const path = join(temporaryDirectory(), "token.json");
    const data = {
      ...syntheticToken("synthetic-refresh-one"),
      access_token: "synthetic-access-value",
      expires_at: 123,
    } as TokenFile & { access_token: string; expires_at: number };

    writeTokenFile(path, data);
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    let saved = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(saved.refresh_token).toBe("synthetic-refresh-one");
    expect(saved.access_token).toBeUndefined();
    expect(saved.expires_at).toBeUndefined();

    chmodSync(path, 0o644);
    writeTokenFile(path, syntheticToken("synthetic-refresh-two"));
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    saved = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(saved.refresh_token).toBe("synthetic-refresh-two");
    expect(existsSync(recoveryPathFor(path))).toBe(false);
    expect(readdirSync(dirname(path)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  test("uses the recovery copy when an interrupted rename leaves no primary", () => {
    const path = join(temporaryDirectory(), "token.json");
    const recovery = recoveryPathFor(path);
    writeTokenFile(path, syntheticToken("synthetic-old"));
    writeFileSync(recovery, readFileSync(path), { mode: 0o600 });
    unlinkSync(path);

    expect(readTokenFile(path)?.refresh_token).toBe("synthetic-old");
    if (process.platform !== "win32") {
      expect(statSync(recovery).mode & 0o777).toBe(0o600);
    }
  });
});

describe("refresh locking", () => {
  test("serializes processes and re-reads a token rotated by the first owner", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "token.json");
    writeTokenFile(path, syntheticToken("synthetic-root"));

    const spawnWorker = (id: string, delay: number) =>
      Bun.spawn([process.execPath, REFRESH_WORKER, path, id, String(delay)], {
        env: { ...process.env },
        stdout: "pipe",
        stderr: "pipe",
      });
    const first = spawnWorker("first", 100);
    const second = spawnWorker("second", 10);
    const [firstStatus, secondStatus] = await Promise.all([first.exited, second.exited]);
    const errors = `${await new Response(first.stderr).text()}${await new Response(second.stderr).text()}`;

    expect(errors).toBe("");
    expect(firstStatus).toBe(0);
    expect(secondStatus).toBe(0);
    const saved = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const rotated = String(saved.refresh_token);
    expect(rotated).toContain("first");
    expect(rotated).toContain("second");
    expect(rotated.split("-")).toHaveLength(4);
    expect(saved.access_token).toBeUndefined();
    expect(readdirSync(directory)).toEqual(["token.json"]);
  });

  test("serializes 50 simultaneous contenders", async () => {
    const path = join(temporaryDirectory(), "token.json");
    let active = 0;
    let maximumActive = 0;
    const completed: number[] = [];

    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        withFileLock(
          path,
          async () => {
            active++;
            maximumActive = Math.max(maximumActive, active);
            try {
              await Bun.sleep(2);
              completed.push(index);
            } finally {
              active--;
            }
          },
          { waitMs: 10_000, pollMs: 2 },
        ),
      ),
    );

    expect(maximumActive).toBe(1);
    expect(completed.sort((left, right) => left - right)).toEqual(
      Array.from({ length: 50 }, (_, index) => index),
    );
  });

  test("waits only for a bounded time when a live owner holds the lock", async () => {
    const path = join(temporaryDirectory(), "token.json");

    await withFileLock(path, async () => {
      const startedAt = Date.now();
      await expect(
        withFileLock(path, async () => undefined, { waitMs: 30, pollMs: 5 }),
      ).rejects.toThrow(/unrelated local service.*fails closed/);
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeGreaterThanOrEqual(25);
      expect(elapsedMs).toBeLessThan(500);
    });
  });

  test("reacquires immediately after a lock-owning process is killed", async () => {
    const path = join(temporaryDirectory(), "token.json");
    const holder = Bun.spawn([process.execPath, LOCK_HOLDER, path], {
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const reader = holder.stdout.getReader();
      const acquired = await Promise.race([
        reader.read().then(({ value }) => new TextDecoder().decode(value)),
        Bun.sleep(2_000).then(() => {
          throw new Error("Timed out waiting for child lock acquisition");
        }),
      ]);
      expect(acquired).toContain("acquired");

      holder.kill("SIGKILL");
      expect(await holder.exited).not.toBe(0);
      await expect(
        withFileLock(path, async () => "reacquired", { waitMs: 1_000, pollMs: 10 }),
      ).resolves.toBe("reacquired");
      expect(await new Response(holder.stderr).text()).toBe("");
    } finally {
      holder.kill("SIGKILL");
      await holder.exited;
    }
  });

  test("creates no filesystem artifacts while held or after release", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "token.json");

    await withFileLock(path, async () => {
      expect(readdirSync(directory)).toEqual([]);
    });

    expect(readdirSync(directory)).toEqual([]);
  });
});

describe("setup safety", () => {
  test("--help short-circuits and unknown flags never start authorization", () => {
    expect(parseSetupArgs(["--help"]).help).toBe(true);
    expect(parseSetupArgs(["--port", "4000", "-h"]).help).toBe(true);
    expect(parseSetupArgs(["--port", "4000"]).help).toBeUndefined();
    expect(() => parseSetupArgs(["--prot", "4000"])).toThrow(/Unknown or incomplete/);
    expect(() => parseSetupArgs(["--out"])).toThrow(/Unknown or incomplete/);
  });

  test("validates tenants and launches URLs without a shell", () => {
    setTestEnv({ MSADS_TENANT: "common$(touch injected)" });
    resetEnvForTesting();
    expect(() => loadEnv()).toThrow(/MSADS_TENANT/);

    const url = "https://example.test/?state=$(touch injected)&x=a;b";
    expect(browserLaunch(url, "darwin")).toEqual({ command: "open", args: [url] });
    expect(browserLaunch(url, "linux")).toEqual({
      command: "xdg-open",
      args: [url],
    });
    expect(browserLaunch(url, "win32")).toEqual({
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
    });
  });

  test("keeps an asynchronously missing browser launcher non-fatal", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = temporaryDirectory();
    try {
      expect(() => openBrowser("https://example.test", "linux")).not.toThrow();
      await Bun.sleep(50);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  test("defaults to the platform config directory and creates it owner-only", () => {
    expect(defaultTokenPath("linux", { HOME: "/home/example" })).toBe(
      "/home/example/.config/mcp-msads/msads-token.json",
    );
    expect(defaultTokenPath("darwin", { HOME: "/Users/example" })).toBe(
      "/Users/example/Library/Application Support/mcp-msads/msads-token.json",
    );
    expect(defaultTokenPath("win32", { USERPROFILE: "C:\\Users\\example" })).toContain(
      "mcp-msads",
    );

    const root = temporaryDirectory();
    const path = prepareSetupOutput(
      parseSetupArgs([]),
      root,
      join(root, "config", "mcp-msads", "msads-token.json"),
    );
    expect(path).toBe(
      join(realpathSync(root), "config", "mcp-msads", "msads-token.json"),
    );
    if (process.platform !== "win32") {
      expect(statSync(join(root, "config", "mcp-msads")).mode & 0o777).toBe(0o700);
    }
  });

  test("MSADS_ENV_FILE replaces .env rather than layering over it", () => {
    const root = temporaryDirectory();
    writeFileSync(
      join(root, ".env"),
      "MSADS_ENVIRONMENT=sandbox\nMSADS_ACCOUNT_ID=111\n",
    );
    writeFileSync(join(root, "production.env"), "MSADS_ACCOUNT_ID=222\n");

    const originalCwd = process.cwd();
    const originalFile = process.env.MSADS_ENV_FILE;
    const originalEnvironment = process.env.MSADS_ENVIRONMENT;
    const originalAccount = process.env.MSADS_ACCOUNT_ID;
    try {
      process.chdir(root);
      delete process.env.MSADS_ENVIRONMENT;
      delete process.env.MSADS_ACCOUNT_ID;
      process.env.MSADS_ENV_FILE = join(root, "production.env");
      resetEnvForTesting();
      loadDotEnvIfPresent();

      // A production run omits MSADS_ENVIRONMENT on purpose. Inheriting
      // sandbox from .env would silently retarget it at the sandbox hosts.
      const loaded = { ...process.env };
      expect(loaded.MSADS_ENVIRONMENT).toBeUndefined();
      expect(loaded.MSADS_ACCOUNT_ID).toBe("222");
    } finally {
      process.chdir(originalCwd);
      if (originalFile === undefined) delete process.env.MSADS_ENV_FILE;
      else process.env.MSADS_ENV_FILE = originalFile;
      if (originalEnvironment === undefined) delete process.env.MSADS_ENVIRONMENT;
      else process.env.MSADS_ENVIRONMENT = originalEnvironment;
      if (originalAccount === undefined) delete process.env.MSADS_ACCOUNT_ID;
      else process.env.MSADS_ACCOUNT_ID = originalAccount;
      resetEnvForTesting();
    }
  });

  test("writes to MSADS_TOKEN_FILE when it is already set", () => {
    const root = temporaryDirectory();
    const configured = join(root, "config", "mcp-msads", "sandbox-token.json");

    expect(configuredTokenPath({ MSADS_TOKEN_FILE: configured })).toBe(configured);
    expect(configuredTokenPath({ MSADS_TOKEN_FILE: "   " })).toBe(defaultTokenPath());
    expect(configuredTokenPath({})).toBe(defaultTokenPath());

    // Setup must refresh the file the server reads. Writing to the platform
    // default instead leaves a stale token behind whose only symptom is
    // error 105 on every call.
    const path = prepareSetupOutput(parseSetupArgs([]), root, configured);
    expect(path).toBe(
      join(realpathSync(root), "config", "mcp-msads", "sandbox-token.json"),
    );

    // An explicit --out still wins over the environment.
    expect(
      resolveSetupOutput(parseSetupArgs(["--out", "elsewhere.json"]), root, configured),
    ).toBe(join(realpathSync(root), "elsewhere.json"));

    // And the default parameter itself must consult the environment, not just
    // the injectable seam above.
    const original = process.env.MSADS_TOKEN_FILE;
    process.env.MSADS_TOKEN_FILE = join(root, "from-env", "token.json");
    try {
      expect(prepareSetupOutput(parseSetupArgs([]), root)).toBe(
        join(realpathSync(root), "from-env", "token.json"),
      );
    } finally {
      if (original === undefined) delete process.env.MSADS_TOKEN_FILE;
      else process.env.MSADS_TOKEN_FILE = original;
    }
  });

  test("rejects repository output unless the explicit override is present", () => {
    const repository = join(temporaryDirectory(), "checkout");
    mkdirSync(join(repository, ".git"), { recursive: true });

    const guarded = parseSetupArgs(["--out", "token.json"]);
    expect(() => resolveSetupOutput(guarded, repository)).toThrow(
      /inside the Git repository/,
    );

    const allowed = parseSetupArgs(["--out", "token.json", "--allow-in-repo"]);
    expect(resolveSetupOutput(allowed, repository)).toBe(
      join(realpathSync(repository), "token.json"),
    );
  });

  test("rejects an output reached through a symlink into a repository", () => {
    if (process.platform === "win32") return;
    const root = temporaryDirectory();
    const repository = join(root, "checkout");
    const outside = join(root, "outside");
    mkdirSync(join(repository, ".git"), { recursive: true });
    mkdirSync(outside);
    symlinkSync(repository, join(outside, "linked-checkout"), "dir");

    expect(() =>
      resolveSetupOutput(
        parseSetupArgs(["--out", "linked-checkout/token.json"]),
        outside,
      ),
    ).toThrow(/inside the Git repository/);
  });

  test("checks state before accepting either an error or an authorization code", () => {
    const injectedError = new URL(
      "http://127.0.0.1/callback?error=access_denied&error_description=forged&state=wrong",
    );
    expect(() => parseOAuthCallback(injectedError, "expected")).toThrow(/state mismatch/);

    const providerError = new URL(
      "http://127.0.0.1/callback?error=access_denied&state=expected",
    );
    expect(() => parseOAuthCallback(providerError, "expected")).toThrow(
      /Authorization denied/,
    );

    const success = new URL("http://127.0.0.1/callback?code=code-1&state=expected");
    expect(parseOAuthCallback(success, "expected")).toBe("code-1");
    expect(CALLBACK_HOST).toBe("127.0.0.1");
  });
});

describe("token endpoint timeout", () => {
  test("aborts a stalled token request with the configured timeout", async () => {
    process.env.MSADS_CLIENT_ID = "11111111-2222-3333-4444-555555555555";
    process.env.MSADS_REFRESH_TOKEN = "synthetic-refresh";
    process.env.MSADS_ENV_FILE = "/nonexistent-so-dotenv-is-skipped";
    process.env.MSADS_REQUEST_TIMEOUT_MS = "1000";
    resetEnvForTesting();

    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return reject(new Error("missing abort signal"));
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      })) as typeof fetch;

    await expect(
      requestToken({ grant_type: "refresh_token", refresh_token: "synthetic-refresh" }),
    ).rejects.toThrow(/Token request timed out.*MSADS_REQUEST_TIMEOUT_MS/);
  });
});
