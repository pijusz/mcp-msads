import { MsAdsAuthError, MsAdsError } from "@/utils/errors";

/**
 * Shared MCP tool-response helpers, so no tool file re-implements the success
 * and failure envelopes.
 *
 * Return types are intentionally inferred rather than declared: they need to
 * structurally satisfy the SDK's CallToolResult, which carries an
 * `[x: string]: unknown` index signature we would otherwise have to model.
 */

export function ok(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

/**
 * Build the structured error body. Kept separate from `fail` so resources —
 * which use a different envelope from tools — can share the same shape.
 */
export function errorPayload(err: unknown): { error: Record<string, unknown> } {
  if (err instanceof MsAdsError) {
    return {
      error: {
        message: err.message,
        ...(err.status !== undefined && { status: err.status }),
        ...(err.hint !== undefined && { hint: err.hint }),
        // Microsoft support asks for this to trace a call server-side.
        ...(err.trackingId !== undefined && { tracking_id: err.trackingId }),
        ...(err.errors.length > 0 && { errors: err.errors }),
        ...(err.partialErrors.length > 0 && { partial_errors: err.partialErrors }),
        ...(err.diagnostics !== undefined && { diagnostics: err.diagnostics }),
      },
    };
  }
  if (err instanceof MsAdsAuthError) {
    return {
      error: {
        message: err.message,
        ...(err.oauthError !== undefined && { oauth_error: err.oauthError }),
        needs_reconsent: err.needsReconsent,
        ...(err.needsReconsent && { fix: "Run `mcp-msads setup` to re-authorize." }),
      },
    };
  }
  return { error: { message: (err as Error)?.message ?? String(err) } };
}

export function fail(err: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(errorPayload(err), null, 2) },
    ],
    isError: true as const,
  };
}

/**
 * Wrap an async handler so each tool file drops its try/catch boilerplate.
 * The handler returns a raw payload; serialization and error routing happen here.
 */
export function run<Args, P>(handler: (args: Args) => Promise<P>) {
  return async (args: Args) => {
    try {
      return ok(await handler(args));
    } catch (err) {
      return fail(err);
    }
  };
}

/** Drop keys whose value is `undefined`, for assembling partial-update bodies. */
export function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Guard for partial-update tools where an empty body would be a silent no-op. */
export function assertHasFields(body: Record<string, unknown>, what = "update"): void {
  if (Object.keys(body).length === 0) {
    throw new MsAdsError({
      message: `No fields to ${what}. Pass at least one field to change.`,
    });
  }
}
