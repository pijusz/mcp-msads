import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";
import { readTool, strictToolSchema } from "@/utils/register-tool";
import { errorPayload, ok, run } from "@/utils/tool-response";

/**
 * Register one read operation as an MCP tool and, when its arguments project
 * cleanly onto a URI, as an MCP resource from the same handler.
 *
 * The two reference servers disagreed on this: mcp-meta-ads exposes reads as
 * resources, mcp-gads exposes them as tools. Each choice loses something —
 * resources are the semantically correct surface for a read, but several
 * popular clients (Cursor among them) never surface resource templates, so a
 * resource-only read is invisible there. Tools work everywhere.
 *
 * Resource URIs additionally accept the tool's declared arguments as query
 * params, so `msads://accounts?filter=Brand` is the same call as the tool with
 * `{ filter: "Brand" }`. Rich structured reads omit a URI and remain tool-only.
 */

export interface ReadDefinition<Args extends ZodRawShape> {
  /** Tool name, e.g. `list_accounts`. Also the resource name. */
  name: string;
  /** Human-readable title for the resource listing. */
  title: string;
  description: string;
  inputSchema: Args;
  /**
   * Resource URI template, e.g. `msads://accounts` or
   * `msads://account/{accountId}/campaigns`. Omit to register a tool only —
   * appropriate for reads with rich structured arguments that don't project
   * onto a URI (report requests, keyword-idea searches).
   */
  uriTemplate?: string;
  /**
   * Maps URI template variables onto handler arguments. Only needed when the
   * variable name differs from the argument name (`{accountId}` → `account_id`).
   */
  uriVars?: Record<string, string>;
  /** Resource priority hint, 0.0–1.0. */
  priority?: number;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

type ArgKind = "array" | "number" | "boolean" | "other";

/**
 * Read the declared kind of each argument out of the Zod shape, unwrapping
 * `.optional()` / `.default()` wrappers.
 *
 * Resource query params arrive as strings before strict Zod parsing. Without
 * declared coercion, a single `?tag_ids=5` would remain a scalar and fail an
 * array schema, while valid number and boolean query values would also fail.
 * Consulting the schema keeps the resource surface aligned with the tool.
 */
export function schemaKinds(shape: ZodRawShape): Record<string, ArgKind> {
  const kinds: Record<string, ArgKind> = {};
  for (const [key, schema] of Object.entries(shape)) {
    let def = (schema as unknown as { _zod?: { def?: Record<string, unknown> } })._zod
      ?.def;
    // Unwrap optional/default/nullable layers to reach the real type.
    for (let depth = 0; depth < 5 && def; depth++) {
      const type = def.type as string | undefined;
      if (type === "array") {
        kinds[key] = "array";
        break;
      }
      if (type === "number") {
        kinds[key] = "number";
        break;
      }
      if (type === "boolean") {
        kinds[key] = "boolean";
        break;
      }
      const inner = def.innerType as
        | { _zod?: { def?: Record<string, unknown> } }
        | undefined;
      if (!inner) {
        kinds[key] = "other";
        break;
      }
      def = inner._zod?.def;
    }
    kinds[key] ??= "other";
  }
  return kinds;
}

/**
 * Build handler arguments from a resource URI: template variables first, then
 * query-string params. Everything arrives as a string, so declared number and
 * boolean values are recovered before the strict tool schema parses them.
 */
export function argsFromUri(
  uri: URL,
  vars: Record<string, string | string[]>,
  uriVars: Record<string, string>,
  kinds: Record<string, ArgKind>,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const uriArgs = new Set<string>();

  for (const [varName, raw] of Object.entries(vars)) {
    // The SDK exposes the query suffix from `{query}` as a synthetic template
    // variable. The URLSearchParams loop below is the authoritative parser.
    if (varName === "query") continue;
    const key = uriVars[varName] ?? varName;
    if (!(key in kinds)) {
      throw new Error(`Resource URI variable "${varName}" is not declared by the tool.`);
    }
    const value = firstValue(raw);
    if (value === undefined) continue;
    args[key] = value;
    uriArgs.add(key);
  }

  for (const [key, value] of uri.searchParams.entries()) {
    const kind = kinds[key];
    if (!kind) {
      throw new Error(`Unknown resource query parameter "${key}".`);
    }
    if (uriArgs.has(key)) {
      throw new Error(
        `Resource query parameter "${key}" conflicts with the value in the URI path.`,
      );
    }

    const coerced = coerce(value, kind);
    const existing = args[key];
    if (existing === undefined) {
      args[key] = kind === "array" ? [coerced] : coerced;
    } else if (kind === "array" && Array.isArray(existing)) {
      existing.push(coerced);
    } else {
      throw new Error(`Resource query parameter "${key}" may only appear once.`);
    }
  }

  return args;
}

/**
 * Query params are always strings. Recover booleans and numbers so a resource
 * caller gets the same behaviour as a tool caller. Ids stay strings on purpose:
 * Microsoft serializes 64-bit ids as strings and parsing them loses precision.
 */
function coerce(value: string, kind: ArgKind | undefined): unknown {
  if (kind === "number") {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (kind === "boolean") {
    return value === "true" || value === "false" ? value === "true" : value;
  }
  return value;
}

export function defineRead<Args extends ZodRawShape>(
  server: McpServer,
  def: ReadDefinition<Args>,
): void {
  readTool(
    server,
    def.name,
    def.description,
    def.inputSchema,
    run(def.handler) as unknown as ToolCallback<Args>,
  );

  if (!def.uriTemplate) return;

  const uriVars = def.uriVars ?? {};
  const kinds = schemaKinds(def.inputSchema);
  const inputSchema = strictToolSchema(def.inputSchema);
  // The SDK matches resource templates literally, query string included, so a
  // template that accepts `?foo=bar` needs a companion `{query}` variant.
  for (const [suffix, template] of [
    ["", def.uriTemplate],
    ["-query", `${def.uriTemplate}{query}`],
  ] as const) {
    server.registerResource(
      `${def.name}${suffix}`,
      new ResourceTemplate(template, { list: undefined }),
      {
        title: def.title,
        description: def.description,
        mimeType: "application/json",
        annotations: { audience: ["assistant"], priority: def.priority ?? 0.7 },
      },
      async (uri, vars) => {
        const text = await (async () => {
          try {
            return JSON.stringify(
              await def.handler(
                inputSchema.parse(argsFromUri(uri, vars, uriVars, kinds)),
              ),
              null,
              2,
            );
          } catch (err) {
            return JSON.stringify(errorPayload(err), null, 2);
          }
        })();
        return {
          contents: [{ uri: uri.href, mimeType: "application/json", text }],
        };
      },
    );
  }
}

/** Re-exported so tool modules need only one import for the common case. */
export { ok };
