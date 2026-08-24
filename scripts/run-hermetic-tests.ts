#!/usr/bin/env bun
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const NETWORK_DENY = join(PROJECT_ROOT, "scripts", "network-deny-bun.ts");

export function listDefaultTestFiles(projectRoot = PROJECT_ROOT): string[] {
  const testsDir = join(projectRoot, "tests");
  return readdirSync(testsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => join(testsDir, entry.name))
    .sort();
}

function cleanTestEnv(tokenFile: string, cwd: string): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        !entry[0].startsWith("MSADS_") && entry[1] !== undefined,
    ),
  );
  return {
    ...env,
    MSADS_ENV_FILE: join(cwd, "missing.env"),
    MSADS_TOKEN_FILE: tokenFile,
    MSADS_RUN_LIVE_TESTS: "false",
    MSADS_VALIDATE_AT_STARTUP: "false",
    MSADS_LOG_LEVEL: "error",
  };
}

async function main(): Promise<number> {
  const cwd = mkdtempSync(join(tmpdir(), "mcp-msads-tests-"));
  const tokenFile = join(cwd, "sentinel-token.json");
  const refreshKey = ["refresh", "token"].join("_");
  const sentinel = JSON.stringify({ [refreshKey]: "synthetic-hermetic-sentinel" });
  writeFileSync(tokenFile, sentinel, { mode: 0o600 });
  chmodSync(tokenFile, 0o600);

  const beforeBytes = readFileSync(tokenFile);
  const beforeMode = statSync(tokenFile).mode & 0o777;
  const tests = listDefaultTestFiles();
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "test", "--preload", NETWORK_DENY, ...tests],
    {
      cwd,
      env: cleanTestEnv(tokenFile, cwd),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );

  let exitCode = 1;
  let sentinelError: string | null = null;
  try {
    exitCode = await child.exited;
    const afterBytes = readFileSync(tokenFile);
    const afterMode = statSync(tokenFile).mode & 0o777;
    if (!beforeBytes.equals(afterBytes) || beforeMode !== afterMode) {
      sentinelError = "Hermetic test sentinel token file changed";
    }
  } catch (error) {
    sentinelError = `Could not verify hermetic test sentinel: ${(error as Error).message}`;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }

  if (sentinelError) {
    console.error(sentinelError);
    return 1;
  }
  if (exitCode === 0) {
    console.log(
      `Hermetic tests passed: ${tests.length} ${basename(resolve(PROJECT_ROOT, "tests"))}/*.test.ts files; sentinel unchanged.`,
    );
  }
  return exitCode;
}

if (import.meta.main) {
  process.exit(await main());
}
