import { describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { withIsolatedMcpClient } from "./_mcp-client";
import {
  DESTRUCTIVE_TOOLS,
  PROMPT_ARGUMENTS,
  PROMPT_NAMES,
  READ_TOOLS,
  RESOURCE_TEMPLATES,
  TOOL_NAMES,
  WRITE_TOOLS,
} from "./expected-manifest";

/**
 * Boots the real binary over a real stdio transport and speaks MCP to it.
 * This is the only test that proves a client can actually connect — unit tests
 * on the registration helpers would still pass if the handshake were broken.
 *
 * No credentials are set, which is deliberate: a missing credential must
 * degrade to a failing tool CALL, never to a failed handshake. A server that
 * exits during init shows up in clients as an opaque "connection closed".
 */
const withClient = <T>(fn: (client: Client) => Promise<T>) =>
  withIsolatedMcpClient("test-client", fn);

describe("MCP protocol", () => {
  test("completes the handshake with no credentials configured", async () => {
    const version = await withClient(async (c) => c.getServerVersion());
    expect(version?.name).toBe("mcp-msads");
  }, 30_000);

  test("advertises the exact reviewed tool manifest", async () => {
    const names = await withClient(async (c) =>
      (await c.listTools()).tools.map((t) => t.name).sort(),
    );
    expect(names).toEqual(TOOL_NAMES);
    expect(names).not.toContain("get_uet_tag_auth_key");
    expect(names).not.toContain("msads_raw_write");
    expect(names).not.toContain("upload_customer_list");
  }, 30_000);

  test("every tool carries a description and an input schema", async () => {
    const tools = await withClient(async (c) => (await c.listTools()).tools);
    for (const tool of tools) {
      expect(tool.description, `${tool.name} has no description`).toBeTruthy();
      expect(tool.inputSchema, `${tool.name} has no input schema`).toBeTruthy();
    }
  }, 30_000);

  test("classifies every tool as read, write, or destructive", async () => {
    const tools = await withClient(async (c) => (await c.listTools()).tools);
    const classes = {
      read: [] as string[],
      write: [] as string[],
      destructive: [] as string[],
    };
    for (const tool of tools) {
      const annotations = tool.annotations;
      expect(annotations?.openWorldHint, tool.name).toBe(true);
      if (annotations?.readOnlyHint) {
        expect(annotations.destructiveHint, tool.name).toBe(false);
        classes.read.push(tool.name);
      } else if (annotations?.destructiveHint) {
        classes.destructive.push(tool.name);
      } else {
        classes.write.push(tool.name);
      }
    }
    expect(classes.read.sort()).toEqual(READ_TOOLS);
    expect(classes.write.sort()).toEqual(WRITE_TOOLS);
    expect(classes.destructive.sort()).toEqual(DESTRUCTIVE_TOOLS);
  }, 30_000);

  test("advertises the exact resource and prompt manifests", async () => {
    const manifests = await withClient(async (c) => ({
      resources: (await c.listResourceTemplates()).resourceTemplates
        .map((r) => r.uriTemplate)
        .sort(),
      prompts: (await c.listPrompts()).prompts.map((p) => p.name).sort(),
    }));
    expect(manifests.resources).toEqual(RESOURCE_TEMPLATES);
    expect(manifests.prompts).toEqual(PROMPT_NAMES);
  }, 30_000);

  test("public schemas and prompt bodies contain no reusable CAPI credential", async () => {
    const surface = await withClient(async (c) => {
      const tools = (await c.listTools()).tools;
      const prompts = await Promise.all(
        (await c.listPrompts()).prompts.map((prompt) =>
          c.getPrompt({
            name: prompt.name,
            arguments: PROMPT_ARGUMENTS[prompt.name],
          }),
        ),
      );
      return { tools, prompts };
    });
    const serialized = JSON.stringify(surface);
    expect(serialized).not.toContain("get_uet_tag_auth_key");
    expect(serialized).not.toContain('"auth_key"');

    const send = surface.tools.find((tool) => tool.name === "send_conversion_events");
    expect(send?.inputSchema.properties).toHaveProperty("account_id");
    expect(send?.inputSchema.properties).toHaveProperty("tag_id");
    expect(send?.inputSchema.properties).not.toHaveProperty("auth_key");
    const ordinaryImport = surface.tools.find(
      (tool) => tool.name === "create_google_import",
    );
    expect(ordinaryImport?.inputSchema.properties).not.toHaveProperty(
      "delete_removed_entities",
    );
  }, 30_000);

  test("a tool needing no credentials returns real data", async () => {
    const result = await withClient(async (c) =>
      c.callTool({ name: "list_report_types", arguments: {} }),
    );
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    const parsed = JSON.parse(text);
    expect(parsed.total).toBeGreaterThan(20);
    expect(parsed.report_types.some((r: any) => r.name === "campaign_performance")).toBe(
      true,
    );
  }, 30_000);

  test("a credential-less call fails as a tool error, not a transport crash", async () => {
    const result = await withClient(async (c) =>
      c.callTool({ name: "list_accounts", arguments: {} }),
    );
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    // The message must name the fix, not just report a failure.
    expect(text).toMatch(/refresh token|setup/i);
  }, 30_000);

  test("the same read works through the resource surface", async () => {
    const contents = await withClient(async (c) =>
      c.readResource({ uri: "msads://report-types" }),
    );
    const text = (contents.contents[0] as { text: string }).text;
    expect(JSON.parse(text).report_types.length).toBeGreaterThan(20);
  }, 30_000);
});
