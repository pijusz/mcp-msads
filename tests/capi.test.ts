import { describe, expect, test } from "bun:test";
import {
  assertHasIdentifier,
  buildUserData,
  type CapiEvent,
  MAX_EVENTS_PER_BATCH,
  sendEvents,
  splitDiagnostics,
  validateEvent,
} from "@/services/capi";
import { sha256Hex } from "@/services/pii";
import { errorPayload } from "@/utils/tool-response";

const EVENT = (over: Partial<CapiEvent> = {}): CapiEvent => ({
  eventType: "custom",
  eventName: "purchase",
  userData: { msclkid: "abc123" },
  ...over,
});

describe("buildUserData", () => {
  test("hashes plaintext email and phone", () => {
    const ud = buildUserData({ email: "Someone@Example.com", phone: "+14255551212" });
    expect(ud.em).toBe(sha256Hex("someone@example.com"));
    expect(ud.ph).toBe(sha256Hex("+14255551212"));
  });

  test("never leaks the plaintext into the payload", () => {
    const ud = buildUserData({ email: "secret@example.com" });
    expect(JSON.stringify(ud)).not.toContain("secret@example.com");
  });

  test("passes opaque identifiers through untouched", () => {
    const ud = buildUserData({ msclkid: "click-1", anonymousId: "vid-1" });
    expect(ud.msclkid).toBe("click-1");
    expect(ud.anonymousId).toBe("vid-1");
  });

  test("does not emit the raw-identifier helper keys", () => {
    const ud = buildUserData({ email: "a@b.com", defaultCountryCode: "1" }) as Record<
      string,
      unknown
    >;
    expect(ud.email).toBeUndefined();
    expect(ud.defaultCountryCode).toBeUndefined();
  });
});

describe("assertHasIdentifier", () => {
  test("accepts any single identifier", () => {
    expect(() => assertHasIdentifier({ em: "x" }, 0)).not.toThrow();
    expect(() => assertHasIdentifier({ msclkid: "x" }, 0)).not.toThrow();
  });

  test("rejects an event with nothing to attribute it to", () => {
    expect(() => assertHasIdentifier({}, 3)).toThrow(/index 3 has no user identifier/);
  });

  test("treats a blank identifier as absent", () => {
    expect(() => assertHasIdentifier({ msclkid: "   " }, 0)).toThrow(
      /no user identifier/,
    );
  });

  test("rejects user-agent and IP metadata without an attribution identity", () => {
    expect(() =>
      assertHasIdentifier(
        { clientUserAgent: "browser", clientIpAddress: "203.0.113.10" },
        2,
      ),
    ).toThrow(/index 2 has no user identifier/);
  });
});

describe("validateEvent", () => {
  test("accepts a well-formed event", () => {
    expect(() => validateEvent(EVENT(), 0)).not.toThrow();
  });

  test("requires an eventName", () => {
    expect(() => validateEvent(EVENT({ eventName: "" }), 0)).toThrow(/no eventName/);
  });

  test("rejects an unsupported eventType", () => {
    expect(() => validateEvent(EVENT({ eventType: "conversion" as never }), 0)).toThrow(
      /Only "pageLoad" and "custom"/,
    );
  });

  test("rejects an event older than the 7-day window and names the alternative", () => {
    const old = Math.floor(Date.now() / 1000) - 10 * 86_400;
    expect(() => validateEvent(EVENT({ eventTime: old }), 0)).toThrow(
      /offline conversions API/,
    );
  });

  test("accepts an event inside the window", () => {
    const recent = Math.floor(Date.now() / 1000) - 2 * 86_400;
    expect(() => validateEvent(EVENT({ eventTime: recent }), 0)).not.toThrow();
  });

  test("catches milliseconds passed where seconds were expected", () => {
    // Date.now() in ms looks like a date ~50,000 years in the future.
    expect(() => validateEvent(EVENT({ eventTime: Date.now() }), 0)).toThrow(
      /Unix SECONDS/,
    );
  });
});

describe("splitDiagnostics", () => {
  test("separates warnings from errors", () => {
    // A warning means the event landed with a field stripped — partial data
    // loss behind a 200, which must not be reported as success.
    const { errors, warnings } = splitDiagnostics({
      errors: [{ message: "bad field", isWarning: true }, { message: "fatal" }],
    });
    expect(warnings).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  test("returns empty lists for a clean response", () => {
    expect(splitDiagnostics({})).toEqual({ errors: [], warnings: [] });
    expect(splitDiagnostics(null)).toEqual({ errors: [], warnings: [] });
  });
});

describe("sendEvents", () => {
  const realFetch = globalThis.fetch;

  test("posts to the CAPI host with a bearer auth key", async () => {
    let captured: { url: string; headers: any; body: any } | null = null;
    globalThis.fetch = (async (input: any, init?: any) => {
      captured = {
        url: String(input),
        headers: init.headers,
        body: JSON.parse(init.body),
      };
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const result = await sendEvents("tag-1", "key-1", [EVENT()]);
      expect(result.accepted).toBe(true);
      expect(result.eventsSent).toBe(1);
      expect(captured!.url).toBe("https://capi.uet.microsoft.com/v1/tag-1/events");
      expect(captured!.headers.Authorization).toBe("Bearer key-1");
      // Without this a single bad row would fail an otherwise good batch.
      expect(captured!.body.continueOnValidationError).toBe(true);
      // eventTime is stamped when the caller omits it.
      expect(typeof captured!.body.data[0].eventTime).toBe("number");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("explains a 401 as a per-tag key problem, not an OAuth one", async () => {
    globalThis.fetch = (async () =>
      new Response("{}", {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    try {
      await expect(sendEvents("t", "bad", [EVENT()])).rejects.toThrow(/per-tag auth key/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("surfaces bounded safe diagnostics for non-2xx responses", async () => {
    const longMessage = "x".repeat(1000);
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          errors: Array.from({ length: 25 }, (_, index) => ({
            eventIndex: index,
            errorCode: "InvalidEvent",
            message: longMessage,
            authKey: "must-not-survive",
          })),
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    try {
      let payload: ReturnType<typeof errorPayload> | undefined;
      try {
        await sendEvents("t", "key", [EVENT()]);
      } catch (error) {
        payload = errorPayload(error);
      }
      const diagnostics = payload?.error.diagnostics as {
        errors: Array<Record<string, unknown>>;
        warnings: unknown[];
        truncated: boolean;
      };
      expect(diagnostics.errors).toHaveLength(20);
      expect(diagnostics.truncated).toBe(true);
      expect(String(diagnostics.errors[0]?.message)).toHaveLength(501);
      expect(JSON.stringify(diagnostics)).not.toContain("must-not-survive");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("times out a stalled request", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      })) as typeof fetch;
    try {
      await expect(sendEvents("t", "key", [EVENT()], { timeoutMs: 10 })).rejects.toThrow(
        /timed out after 10ms/,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("rejects an oversized batch before sending anything", async () => {
    const many = Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, () => EVENT());
    await expect(sendEvents("t", "k", many)).rejects.toThrow(/at most 1000/);
  });

  test("rejects an empty batch", async () => {
    await expect(sendEvents("t", "k", [])).rejects.toThrow(/No events/);
  });

  test("validates every event before sending any of them", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await expect(
        sendEvents("t", "k", [EVENT(), EVENT({ userData: {} })]),
      ).rejects.toThrow(/index 1/);
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
