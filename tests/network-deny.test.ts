import { describe, expect, test } from "bun:test";
import { lookup } from "node:dns";
import { lookup as lookupAsync } from "node:dns/promises";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { createRequire } from "node:module";
import { connect } from "node:net";

type UndiciView = {
  request: (url: string) => Promise<unknown>;
};
type WebSocketConstructor = new (url: string) => unknown;

const undiciEsm = (await import(String("undici"))) as UndiciView & {
  default: UndiciView;
};
const wsEsm = (await import(String("ws"))) as {
  default: WebSocketConstructor;
  WebSocket: WebSocketConstructor;
};
const require = createRequire(import.meta.url);
const undiciCommonJs = require("undici") as UndiciView;
const WebSocketCommonJs = require("ws") as WebSocketConstructor;

const DENIED = /Unexpected network access in hermetic test/;

describe("hermetic network preload", () => {
  test("denies fetch, DNS, HTTP, HTTPS, and socket connections", async () => {
    await expect(fetch("https://example.com")).rejects.toThrow(DENIED);
    expect(() => lookup("example.com", () => undefined)).toThrow(DENIED);
    expect(() => lookupAsync("example.com")).toThrow(DENIED);
    expect(() => httpGet("http://example.com")).toThrow(DENIED);
    expect(() => httpsGet("https://example.com")).toThrow(DENIED);
    expect(() => connect(443, "example.com")).toThrow(DENIED);
    expect(() => Bun.connect({ hostname: "example.com", port: 443, socket: {} })).toThrow(
      DENIED,
    );
  });

  test("denies undici and ws through ESM named, ESM default, and CommonJS views", async () => {
    const httpLoopback = "http://127.0.0.1:1";
    await expect(undiciEsm.request(httpLoopback)).rejects.toThrow(DENIED);
    await expect(undiciEsm.default.request(httpLoopback)).rejects.toThrow(DENIED);
    await expect(undiciCommonJs.request(httpLoopback)).rejects.toThrow(DENIED);

    const wsLoopback = "ws://127.0.0.1:1";
    expect(() => new wsEsm.WebSocket(wsLoopback)).toThrow(DENIED);
    expect(() => new wsEsm.default(wsLoopback)).toThrow(DENIED);
    expect(() => new WebSocketCommonJs(wsLoopback)).toThrow(DENIED);
  });
});
