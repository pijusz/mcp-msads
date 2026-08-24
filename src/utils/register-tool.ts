import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ZodRawShape, z } from "zod";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/**
 * Writes that add or change data but don't remove it (Add / Update operations).
 * `destructiveHint: false` lets clients render a lighter-weight confirmation
 * than they do for deletes.
 */
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/** Deletes and anything else that loses data irrecoverably. */
const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export function strictToolSchema<Args extends ZodRawShape>(shape: Args) {
  return z.strictObject(shape);
}

export function readTool<Args extends ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: Args,
  handler: ToolCallback<Args>,
) {
  const schema = strictToolSchema(inputSchema);
  return server.registerTool<ZodRawShape, typeof schema>(
    name,
    { description, inputSchema: schema, annotations: READ_ONLY },
    handler as unknown as ToolCallback<typeof schema>,
  );
}

export function writeTool<Args extends ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: Args,
  handler: ToolCallback<Args>,
) {
  const schema = strictToolSchema(inputSchema);
  return server.registerTool<ZodRawShape, typeof schema>(
    name,
    { description, inputSchema: schema, annotations: WRITE },
    handler as unknown as ToolCallback<typeof schema>,
  );
}

export function destructiveTool<Args extends ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: Args,
  handler: ToolCallback<Args>,
) {
  const schema = strictToolSchema(inputSchema);
  return server.registerTool<ZodRawShape, typeof schema>(
    name,
    { description, inputSchema: schema, annotations: DESTRUCTIVE },
    handler as unknown as ToolCallback<typeof schema>,
  );
}
