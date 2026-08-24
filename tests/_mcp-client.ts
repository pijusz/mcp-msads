import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENTRYPOINT = join(PROJECT_ROOT, "src", "index.ts");
const NETWORK_DENY = join(PROJECT_ROOT, "scripts", "network-deny-bun.ts");

function isolatedEnv(cwd: string): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        !entry[0].startsWith("MSADS_") && entry[1] !== undefined,
    ),
  );
  return {
    ...env,
    MSADS_ENV_FILE: join(cwd, "missing.env"),
    MSADS_LOG_LEVEL: "error",
    MSADS_RUN_LIVE_TESTS: "false",
    MSADS_VALIDATE_AT_STARTUP: "false",
    MSADS_DEVELOPER_TOKEN: "",
    MSADS_CLIENT_ID: "",
    MSADS_CLIENT_SECRET: "",
    MSADS_REFRESH_TOKEN: "",
    MSADS_TOKEN_FILE: "",
    MSADS_ACCOUNT_ID: "",
    MSADS_CUSTOMER_ID: "",
  };
}

export async function withIsolatedMcpClient<T>(
  name: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const cwd = mkdtempSync(join(tmpdir(), "mcp-msads-client-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--no-env-file", "--preload", NETWORK_DENY, ENTRYPOINT],
    cwd,
    env: isolatedEnv(cwd),
  });
  const client = new Client({ name, version: "1.0.0" });

  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
    rmSync(cwd, { recursive: true, force: true });
  }
}
