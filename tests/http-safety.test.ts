import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAuthForTesting } from "@/auth/oauth";
import { resetEnvForTesting } from "@/config/env";
import { postBulkFile } from "@/services/bulk";
import { msadsFetch } from "@/services/msads-api";
import {
  isPublicAddress,
  MAX_API_RESPONSE_BYTES,
  safeFetchBytes,
} from "@/utils/safe-http";
import { installMockFetch, type MockFetch, setTestEnv, tokenResponse } from "./_mock";

let mock: MockFetch;

beforeEach(() => {
  setTestEnv();
  resetEnvForTesting();
  resetAuthForTesting();
  mock = installMockFetch();
  mock.always("login.microsoftonline.com", tokenResponse());
});

afterEach(() => mock.restore());

describe("explicit retry safety", () => {
  test("does not replay a mutation after a 500", async () => {
    mock.always("CampaignManagement", { status: 500, text: "transient" });

    await expect(
      msadsFetch("CampaignManagement", "Campaigns", {
        method: "POST",
        body: { Campaigns: [{ Name: "one" }] },
        retries: 3,
      }),
    ).rejects.toThrow(/HTTP 500/);
    expect(mock.callsTo("CampaignManagement")).toHaveLength(1);
  });

  test("does not replay a mutation after an ambiguous network failure", async () => {
    mock.always("CampaignManagement", { networkError: "connection reset" });

    await expect(
      msadsFetch("CampaignManagement", "Campaigns", {
        method: "POST",
        body: { Campaigns: [{ Name: "one" }] },
        retries: 3,
      }),
    ).rejects.toThrow(/Network error/);
    expect(mock.callsTo("CampaignManagement")).toHaveLength(1);
  });

  test("retries an explicitly safe POST read", async () => {
    mock.queue(
      "User/Query",
      { status: 503, text: "busy", headers: { "retry-after": "0" } },
      { json: { User: { Id: "1" } } },
    );

    const result = await msadsFetch<{ User: { Id: string } }>(
      "CustomerManagement",
      "User/Query",
      { body: { UserId: null }, retry: "safe", retries: 1 },
    );
    expect(result.User.Id).toBe("1");
    expect(mock.callsTo("User/Query")).toHaveLength(2);
  });

  test("still replays a rejected mutation once after error 109", async () => {
    mock.queue(
      "Campaigns",
      { status: 401, json: { Errors: [{ Code: 109 }] } },
      { json: { CampaignIds: ["1"] } },
    );

    await msadsFetch("CampaignManagement", "Campaigns", {
      method: "POST",
      body: { Campaigns: [{ Name: "one" }] },
      retries: 0,
    });
    expect(mock.callsTo("Campaigns")).toHaveLength(2);
  });

  test("rejects an oversized API error body before parsing it", async () => {
    mock.queue("User/Query", {
      status: 400,
      json: { Errors: [{ Code: 100 }] },
      headers: { "content-length": String(MAX_API_RESPONSE_BYTES + 1) },
    });

    await expect(
      msadsFetch("CustomerManagement", "User/Query", {
        body: { UserId: null },
        retry: "safe",
      }),
    ).rejects.toThrow(/safety limit/);
  });

  test("times out when an API response stalls", async () => {
    const routedFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes("CampaignManagement")) {
        return routedFetch(input, init);
      }
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    }) as typeof fetch;

    await expect(
      msadsFetch("CampaignManagement", "Campaigns", {
        method: "POST",
        body: {},
        timeout: 10,
      }),
    ).rejects.toThrow(/timed out after 10ms/);
    expect(calls).toBe(1);
  });

  test("retries a timeout only when the request is explicitly safe", async () => {
    const routedFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes("User/Query")) return routedFetch(input, init);
      calls++;
      if (calls === 2) {
        return new Response(JSON.stringify({ User: { Id: "1" } }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    }) as typeof fetch;

    await expect(
      msadsFetch<{ User: { Id: string } }>("CustomerManagement", "User/Query", {
        body: { UserId: null },
        retry: "safe",
        retries: 1,
        timeout: 10,
      }),
    ).resolves.toEqual({ User: { Id: "1" } });
    expect(calls).toBe(2);
  });
});

describe("API-returned URL safety", () => {
  const publicLookup = async () => ["93.184.216.34"];

  test("rejects private, loopback, link-local, and mapped-private addresses", () => {
    for (const address of [
      "10.0.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "::1",
      "fe80::1",
      "fec0::1",
      "::ffff:10.0.0.1",
    ]) {
      expect(isPublicAddress(address)).toBe(false);
    }
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });

  test("rejects a private DNS answer before fetch", async () => {
    let fetched = false;
    await expect(
      safeFetchBytes(
        "https://result.test/file",
        { method: "GET" },
        {
          timeoutMs: 100,
          maxBytes: 1024,
          lookup: async () => ["127.0.0.1"],
          fetch: (async () => {
            fetched = true;
            return new Response("unexpected");
          }) as unknown as typeof fetch,
        },
      ),
    ).rejects.toThrow(/private, local, metadata, or reserved/);
    expect(fetched).toBe(false);
  });

  test("pins each redirect hop to the address validated for that hostname", async () => {
    const connected: Array<{ host: string; address: string }> = [];
    const result = await safeFetchBytes(
      "https://first.test/file",
      { method: "GET" },
      {
        timeoutMs: 100,
        maxBytes: 1024,
        lookup: async (hostname) =>
          hostname === "first.test" ? ["93.184.216.34"] : ["93.184.216.35"],
        request: async (url, _init, address) => {
          connected.push({ host: url.hostname, address });
          return url.hostname === "first.test"
            ? new Response(null, {
                status: 302,
                headers: { location: "https://second.test/result" },
              })
            : new Response("ok");
        },
      },
    );
    expect(result.bytes.toString()).toBe("ok");
    expect(connected).toEqual([
      { host: "first.test", address: "93.184.216.34" },
      { host: "second.test", address: "93.184.216.35" },
    ]);
  });

  test("manually validates every redirect before following it", async () => {
    let calls = 0;
    await expect(
      safeFetchBytes(
        "https://result.test/file",
        { method: "GET" },
        {
          timeoutMs: 100,
          maxBytes: 1024,
          lookup: publicLookup,
          fetch: (async () => {
            calls++;
            return new Response(null, {
              status: 302,
              headers: { location: "https://127.0.0.1/private" },
            });
          }) as unknown as typeof fetch,
        },
      ),
    ).rejects.toThrow(/private, local, metadata, or reserved/);
    expect(calls).toBe(1);
  });

  test("rejects insecure redirect targets", async () => {
    await expect(
      safeFetchBytes(
        "https://result.test/file",
        { method: "GET" },
        {
          timeoutMs: 100,
          maxBytes: 1024,
          lookup: publicLookup,
          fetch: (async () =>
            new Response(null, {
              status: 302,
              headers: { location: "http://public.test/file" },
            })) as unknown as typeof fetch,
        },
      ),
    ).rejects.toThrow(/HTTPS on port 443/);
  });

  test("times out a stalled outbound request", async () => {
    const stalled = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      })) as typeof fetch;

    await expect(
      safeFetchBytes(
        "https://result.test/file",
        { method: "GET" },
        {
          timeoutMs: 10,
          maxBytes: 1024,
          lookup: publicLookup,
          fetch: stalled,
        },
      ),
    ).rejects.toThrow(/timed out after 10ms/);
  });

  test("never forwards bulk credentials outside the approved origin", async () => {
    const calls: Array<{ url: string; auth?: string }> = [];
    const uploadFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        ...(headers.get("AuthenticationToken")
          ? { auth: headers.get("AuthenticationToken") ?? undefined }
          : {}),
      });
      return new Response(null, {
        status: 307,
        headers: { location: "https://attacker.test/upload" },
      });
    }) as typeof fetch;

    await expect(
      postBulkFile(
        "https://bulk.api.bingads.microsoft.com/upload",
        { accountId: "42", customerId: "9" },
        Buffer.from("zip"),
        "upload.zip",
        { fetch: uploadFetch, lookup: publicLookup },
      ),
    ).rejects.toThrow(/outside the approved origin/);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("bulk.api.bingads.microsoft.com");
    expect(calls[0]?.auth).toBe("test-access-token");
    expect(calls.some((call) => call.url.includes("attacker.test"))).toBe(false);
  });
});
