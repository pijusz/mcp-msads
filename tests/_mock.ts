/**
 * Test transport. Replaces global fetch with a router so client behaviour —
 * headers, retries, token refresh — can be asserted without credentials.
 */

import { setSafeHttpFetchForTesting } from "@/utils/safe-http";
import { denyFetch } from "./_network-deny";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface MockResponse {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
  /** Reject with this instead of responding, to simulate a network failure. */
  networkError?: string;
}

export interface MockFetch {
  calls: RecordedCall[];
  /** Queue one response for the next matching request. */
  queue(match: string, ...responses: MockResponse[]): void;
  /** Always answer requests matching this substring with this response. */
  always(match: string, response: MockResponse): void;
  restore(): void;
  callsTo(match: string): RecordedCall[];
}

export function installMockFetch(): MockFetch {
  const calls: RecordedCall[] = [];
  const queues = new Map<string, MockResponse[]>();
  const standing = new Map<string, MockResponse>();

  function respond(res: MockResponse): Response {
    if (res.networkError) throw new Error(res.networkError);
    const status = res.status ?? 200;
    const headers = new Headers(res.headers ?? {});
    let payload: string;
    if (res.json !== undefined) {
      payload = JSON.stringify(res.json);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    } else {
      payload = res.text ?? "";
      if (!headers.has("content-type")) headers.set("content-type", "text/plain");
    }
    return new Response(payload, { status, headers });
  }

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((v, k) => {
      headers[k] = v;
    });

    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, method: init?.method ?? "GET", headers, body });

    for (const [match, responses] of queues) {
      if (url.includes(match) && responses.length > 0) {
        const next = responses.shift();
        if (next) return respond(next);
      }
    }
    for (const [match, response] of standing) {
      if (url.includes(match)) return respond(response);
    }
    throw new Error(`mock fetch: no response queued for ${url}`);
  }) as typeof fetch;
  setSafeHttpFetchForTesting(((input, init) =>
    globalThis.fetch(input, init)) as typeof fetch);

  return {
    calls,
    queue(match, ...responses) {
      const existing = queues.get(match) ?? [];
      queues.set(match, [...existing, ...responses]);
    },
    always(match, response) {
      standing.set(match, response);
    },
    callsTo(match) {
      return calls.filter((c) => c.url.includes(match));
    },
    restore() {
      setSafeHttpFetchForTesting();
      globalThis.fetch = denyFetch;
    },
  };
}

/** A successful Entra token response. */
export function tokenResponse(overrides: Record<string, unknown> = {}): MockResponse {
  return {
    json: {
      token_type: "Bearer",
      scope: "https://ads.microsoft.com/msads.manage",
      expires_in: 3599,
      access_token: "test-access-token",
      refresh_token: "test-refresh-token-rotated",
      ...overrides,
    },
  };
}

/** Set the env this server needs, wiping anything a previous test left behind. */
export function setTestEnv(overrides: Record<string, string | undefined> = {}): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("MSADS_")) delete process.env[key];
  }
  const base: Record<string, string> = {
    MSADS_DEVELOPER_TOKEN: "test-dev-token",
    MSADS_CLIENT_ID: "11111111-2222-3333-4444-555555555555",
    MSADS_REFRESH_TOKEN: "test-refresh-token",
    MSADS_ENV_FILE: "/nonexistent-so-dotenv-is-skipped",
  };
  for (const [k, v] of Object.entries({ ...base, ...overrides })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
