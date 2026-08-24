import { mock } from "bun:test";
import dgram from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { deniedDns, denyFetch, denyNetwork } from "./network-deny.mjs";

class NetworkDeniedClient {
  constructor() {
    denyNetwork();
  }
}

class NetworkDeniedWebSocket {
  constructor() {
    denyNetwork();
  }
}

const deniedUndici = {
  Agent: NetworkDeniedClient,
  BalancedPool: NetworkDeniedClient,
  Client: NetworkDeniedClient,
  EnvHttpProxyAgent: NetworkDeniedClient,
  Pool: NetworkDeniedClient,
  ProxyAgent: NetworkDeniedClient,
  RetryAgent: NetworkDeniedClient,
  WebSocket: NetworkDeniedWebSocket,
  connect: denyFetch,
  fetch: denyFetch,
  pipeline: denyFetch,
  request: denyFetch,
  stream: denyFetch,
  upgrade: denyFetch,
};
const deniedWs = Object.assign(NetworkDeniedWebSocket, {
  Server: NetworkDeniedClient,
  WebSocket: NetworkDeniedWebSocket,
  WebSocketServer: NetworkDeniedClient,
  createWebSocketStream: denyNetwork,
});

// Bun does not mirror mutations of built-in default exports onto named imports,
// so its preload also replaces those module views. Node uses network-deny.mjs.
mock.module("node:dns", () => ({ ...dns, ...deniedDns, default: dns }));
mock.module("node:dns/promises", () => ({
  ...dnsPromises,
  ...deniedDns,
  default: dnsPromises,
}));
mock.module("node:http", () => ({
  ...http,
  default: http,
  get: denyNetwork,
  request: denyNetwork,
}));
mock.module("node:https", () => ({
  ...https,
  default: https,
  get: denyNetwork,
  request: denyNetwork,
}));
mock.module("node:net", () => ({
  ...net,
  default: net,
  connect: denyNetwork,
  createConnection: denyNetwork,
}));
mock.module("node:tls", () => ({ ...tls, default: tls, connect: denyNetwork }));
mock.module("node:dgram", () => ({
  ...dgram,
  default: dgram,
  createSocket: denyNetwork,
}));
mock.module("undici", () => ({
  ...deniedUndici,
  default: deniedUndici,
  "module.exports": deniedUndici,
}));
mock.module("ws", () => ({
  ...deniedWs,
  default: deniedWs,
  "module.exports": deniedWs,
}));
