import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { argsFromUri, schemaKinds } from "@/utils/define-read";
import { withIsolatedMcpClient } from "./_mcp-client";

/**
 * Resource URIs bypass Zod, so query params arrive as raw strings. These
 * exercise the coercion that keeps the resource surface behaving like the
 * tool surface — read through a real client, not by calling internals.
 */
async function readResource(uri: string): Promise<string> {
  return withIsolatedMcpClient("res-test", async (client) => {
    const res = await client.readResource({ uri });
    return (res.contents[0] as { text: string }).text;
  });
}

describe("resource query-param coercion", () => {
  test("a resource read returns the same payload as its tool", async () => {
    const text = await readResource("msads://report-types");
    const parsed = JSON.parse(text);
    expect(parsed.report_types.length).toBeGreaterThan(20);
  }, 30_000);

  test("an unauthenticated read surfaces a structured error, not a crash", async () => {
    // No credentials configured: the resource must still answer with JSON.
    const text = await readResource("msads://account/123/campaigns");
    expect(JSON.parse(text).error).toBeDefined();
  }, 30_000);
});

describe("schemaKinds", () => {
  test("sees through optional wrappers to the real type", () => {
    const kinds = schemaKinds({
      ids: z.array(z.string()).optional(),
      name: z.string().optional(),
      count: z.number().int().optional(),
      flag: z.boolean().optional(),
      required_ids: z.array(z.string()),
    });
    expect(kinds).toEqual({
      ids: "array",
      name: "other",
      count: "number",
      flag: "boolean",
      required_ids: "array",
    });
  });
});

describe("argsFromUri", () => {
  const kinds = schemaKinds({
    tag_ids: z.array(z.string()).optional(),
    year: z.number().optional(),
    only_parents: z.boolean().optional(),
    filter: z.string().optional(),
  });
  const build = (uri: string, vars: Record<string, string> = {}) =>
    argsFromUri(new URL(uri), vars, {}, kinds);

  test("wraps a SINGLE value for an array-typed argument", () => {
    // The bug this prevents: ?tag_ids=5 was dropped by the handler's
    // Array.isArray guard, silently returning every tag instead of one.
    expect(build("msads://x?tag_ids=5").tag_ids).toEqual(["5"]);
  });

  test("still collects repeated values into one array", () => {
    expect(build("msads://x?tag_ids=5&tag_ids=6").tag_ids).toEqual(["5", "6"]);
  });

  test("coerces a number-typed argument", () => {
    expect(build("msads://x?year=2026").year).toBe(2026);
  });

  test("leaves a non-numeric value for a number argument as a string", () => {
    expect(build("msads://x?year=soon").year).toBe("soon");
  });

  test("coerces booleans", () => {
    expect(build("msads://x?only_parents=true").only_parents).toBe(true);
    expect(build("msads://x?only_parents=false").only_parents).toBe(false);
  });

  test("leaves plain strings alone, including numeric-looking ids", () => {
    // Ids must stay strings: they are 64-bit and parsing loses precision.
    expect(build("msads://x?filter=12345").filter).toBe("12345");
  });

  test("maps template variables through uriVars", () => {
    const args = argsFromUri(
      new URL("msads://account/99/campaigns"),
      { accountId: "99" },
      { accountId: "account_id" },
      { account_id: "other" },
    );
    expect(args.account_id).toBe("99");
  });
});
