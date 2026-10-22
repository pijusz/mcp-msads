#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runSetup } from "@/auth/setup";
import { loadEnv, shouldValidateAtStartup } from "@/config/env";
import { createServer } from "@/server";
import { getUser } from "@/services/accounts";
import { log } from "@/utils/logger";
import pkg from "../package.json";

export const VERSION = pkg.version;

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(`mcp-msads v${VERSION}`);
  process.exit(0);
}

if (process.argv[2] === "setup") {
  // Imported statically rather than via `await import()`. A top-level dynamic
  // import gets hoisted during bundling, which reorders module initialization
  // ahead of zod's class definitions and makes the published bundle throw
  // "Class2 is not a constructor" on startup. setup.ts pulls only Node
  // builtins, so deferring it bought nothing anyway.
  try {
    await runSetup(process.argv.slice(3));
  } catch (err) {
    console.error(`\n  Setup failed: ${(err as Error).message}\n`);
    process.exit(1);
  }
  process.exit(0);
}

const server = createServer();
const transport = new StdioServerTransport();

log.info(`Starting mcp-msads v${VERSION} on stdio`);
await server.connect(transport);
void runStartupPreflight();

/**
 * Validate credentials after the transport is connected, never before — a
 * failed probe must not stop the server from completing the MCP handshake, or
 * the client reports an opaque "connection closed" instead of the real error.
 */
async function runStartupPreflight(): Promise<void> {
  try {
    const env = loadEnv();
    if (!env.MSADS_REFRESH_TOKEN && !env.MSADS_TOKEN_FILE) {
      throw new Error(
        "No credentials configured. Run `mcp-msads setup` to authorize, then set MSADS_TOKEN_FILE (preferred, persists rotations) or MSADS_REFRESH_TOKEN.",
      );
    }
    if (shouldValidateAtStartup()) {
      await getUser();
      log.info("Credentials valid.");
    }
  } catch (err) {
    log.warn(
      "Startup preflight warning. The server is running, but tool calls will fail until this is fixed:",
      (err as Error).message,
    );
  }
}
