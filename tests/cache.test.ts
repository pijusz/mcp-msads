import { beforeEach, describe, expect, test } from "bun:test";
import {
  cacheClear,
  cached,
  cacheGet,
  cacheInvalidate,
  cacheInvalidatePrefix,
  cacheSet,
  cacheSize,
  tokenKey,
  tokenPrefix,
} from "@/services/cache";

beforeEach(() => cacheClear());

describe("cache", () => {
  test("round-trips a value", () => {
    cacheSet("k", { a: 1 }, 1000);
    expect(cacheGet<{ a: number }>("k")).toEqual({ a: 1 });
  });

  test("returns undefined for a missing key", () => {
    expect(cacheGet("nope")).toBeUndefined();
  });

  test("expires entries past their TTL", () => {
    cacheSet("k", "v", -1);
    expect(cacheGet("k")).toBeUndefined();
    expect(cacheSize()).toBe(0);
  });

  test("POSITIVE_INFINITY caches for the process lifetime", () => {
    cacheSet("k", "v", Number.POSITIVE_INFINITY);
    expect(cacheGet<string>("k")).toBe("v");
  });

  test("cacheInvalidate removes one key", () => {
    cacheSet("k", "v", 1000);
    expect(cacheInvalidate("k")).toBe(true);
    expect(cacheInvalidate("k")).toBe(false);
  });

  test("cacheInvalidatePrefix removes only the matching keys", () => {
    cacheSet("aa:1", "v", 1000);
    cacheSet("aa:2", "v", 1000);
    cacheSet("bb:1", "v", 1000);
    expect(cacheInvalidatePrefix("aa:")).toBe(2);
    expect(cacheGet<string>("bb:1")).toBe("v");
  });

  test("cached() computes once then serves the cached value", async () => {
    let calls = 0;
    const compute = async () => {
      calls++;
      return calls;
    };
    expect(await cached("k", 1000, compute)).toBe(1);
    expect(await cached("k", 1000, compute)).toBe(1);
    expect(calls).toBe(1);
  });

  test("tokenKey never embeds the raw secret", () => {
    const key = tokenKey("super-secret-token", "me");
    expect(key).not.toContain("super-secret-token");
    expect(key).toEndWith(":me");
  });

  test("tokenKey is stable and tokenPrefix matches its keys", () => {
    expect(tokenKey("t", "a")).toBe(tokenKey("t", "a"));
    expect(tokenKey("t", "a")).toStartWith(tokenPrefix("t"));
  });

  test("rotating the credential changes the key namespace", () => {
    expect(tokenPrefix("old")).not.toBe(tokenPrefix("new"));
  });
});
