import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listDefaultTestFiles } from "../scripts/run-hermetic-tests";
import { scanTrackedFiles } from "../scripts/scan-secrets";
import { denyFetch } from "./_network-deny";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

function tempDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("hermetic test isolation", () => {
  test("unexpected fetch fails immediately", async () => {
    expect(globalThis.fetch).toBe(denyFetch);
    await expect(fetch("https://example.invalid")).rejects.toThrow(
      "Unexpected network access in hermetic test",
    );
  });

  test("default discovery includes only top-level test files", () => {
    const files = listDefaultTestFiles(PROJECT_ROOT);
    const testsDir = join(PROJECT_ROOT, "tests");
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((path) => dirname(path) === testsDir)).toBe(true);
    expect(files.some((path) => path.includes(`${join("tests", "live")}`))).toBe(false);
  });
});

describe("tracked secret scanner", () => {
  test("reports a synthetic tracked token location without its value", () => {
    const root = tempDirectory("mcp-msads-secret-scan-");
    try {
      const init = spawnSync("git", ["init", "-q", root]);
      expect(init.status).toBe(0);
      const key = ["refresh", "token"].join("_");
      const value = ["1", "//", "synthetic-token-value-123456789"].join("");
      writeFileSync(join(root, "credential.json"), JSON.stringify({ [key]: value }));
      const add = spawnSync("git", ["-C", root, "add", "credential.json"]);
      expect(add.status).toBe(0);

      const findings = scanTrackedFiles(root);
      expect(findings.some((finding) => finding.key === key)).toBe(true);
      expect(findings.every((finding) => finding.path === "credential.json")).toBe(true);
      expect(JSON.stringify(findings)).not.toContain(value);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Google credential import permissions", () => {
  test("rewritten env files are owner-only on POSIX", () => {
    const root = tempDirectory("mcp-msads-import-");
    try {
      const source = join(root, "credentials.json");
      const envPath = join(root, ".env");
      mkdirSync(dirname(source), { recursive: true });
      writeFileSync(
        source,
        JSON.stringify({
          installed: {
            client_id: "synthetic-client-id",
            client_secret: "synthetic-client-secret",
          },
        }),
      );
      writeFileSync(envPath, "KEEP=yes\n", { mode: 0o644 });
      chmodSync(envPath, 0o644);

      const script = join(PROJECT_ROOT, "scripts", "import-google-credentials.ts");
      const result = spawnSync(
        process.execPath,
        ["--no-env-file", script, source, envPath],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(0);
      if (process.platform !== "win32") {
        expect(statSync(envPath).mode & 0o777).toBe(0o600);
      }
      expect(result.stdout).not.toContain("synthetic-client-id");
      expect(result.stdout).not.toContain("synthetic-client-secret");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
