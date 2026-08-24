import dgram from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

const message = "Unexpected network access in hermetic test";
export const denyNetwork = () => {
  throw new Error(message);
};
export const denyFetch = async () => {
  throw new Error(message);
};
export const deniedDns = Object.fromEntries(
  [
    "lookup",
    "lookupService",
    "resolve",
    "resolve4",
    "resolve6",
    "resolveAny",
    "resolveCaa",
    "resolveCname",
    "resolveMx",
    "resolveNaptr",
    "resolveNs",
    "resolvePtr",
    "resolveSoa",
    "resolveSrv",
    "resolveTxt",
    "reverse",
  ].map((name) => [name, denyNetwork]),
);

Object.assign(dns, deniedDns);
Object.assign(dnsPromises, deniedDns);
for (const Resolver of [dns.Resolver, dnsPromises.Resolver]) {
  if (!Resolver?.prototype) continue;
  for (const name of Object.getOwnPropertyNames(Resolver.prototype)) {
    if (
      name !== "constructor" &&
      name !== "cancel" &&
      typeof Resolver.prototype[name] === "function"
    ) {
      Resolver.prototype[name] = denyNetwork;
    }
  }
}

http.request = denyNetwork;
http.get = denyNetwork;
https.request = denyNetwork;
https.get = denyNetwork;
net.connect = denyNetwork;
net.createConnection = denyNetwork;
net.Socket.prototype.connect = denyNetwork;
tls.connect = denyNetwork;
dgram.createSocket = denyNetwork;

globalThis.fetch = denyFetch;
if (globalThis.WebSocket)
  globalThis.WebSocket = class NetworkDeniedWebSocket {
    constructor() {
      denyNetwork();
    }
  };
if (globalThis.Bun) {
  globalThis.Bun.connect = denyNetwork;
  globalThis.Bun.udpSocket = denyNetwork;
}

// Keep named imports from Node built-ins aligned with the patched default objects.
syncBuiltinESMExports();
