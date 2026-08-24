import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { MsAdsError } from "@/utils/errors";

export const MAX_API_RESPONSE_BYTES = 16 * 1024 * 1024;
export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export type DnsLookup = (hostname: string) => Promise<readonly string[]>;

export type SafeHttpRequest = (
  url: URL,
  init: RequestInit,
  address: string,
  signal: AbortSignal,
) => Promise<Response>;

export interface SafeHttpDependencies {
  /** Test-only direct request injection; production uses the pinned HTTPS transport. */
  fetch?: typeof fetch;
  request?: SafeHttpRequest;
  lookup?: DnsLookup;
}

export interface SafeHttpOptions extends SafeHttpDependencies {
  timeoutMs: number;
  maxBytes: number;
  /** When set, the initial URL and every redirect must keep this exact origin. */
  allowedOrigin?: string;
}

export interface SafeHttpResult {
  status: number;
  ok: boolean;
  bytes: Buffer;
}

const defaultLookup: DnsLookup = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map(
    ({ address }) => address,
  );

let testFetch: typeof fetch | undefined;

/** Test harness hook; production never sets this and always uses pinned HTTPS. */
export function setSafeHttpFetchForTesting(value?: typeof fetch): void {
  testFetch = value;
}

/** Read a response without allowing an unbounded JSON, text, or binary allocation. */
export async function readResponseBytes(
  response: Response,
  maxBytes = MAX_API_RESPONSE_BYTES,
): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (Number.isFinite(size) && size > maxBytes) throw bodyTooLarge(maxBytes);
  }

  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw bodyTooLarge(maxBytes);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

export function parseJsonBytes(bytes: Uint8Array): unknown {
  if (bytes.byteLength === 0) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/**
 * Fetch an API-returned URL after validating the URL and every redirect.
 * Production requests pin HTTPS lookup to an already-vetted address so DNS
 * cannot change between validation and connection. The original URL hostname
 * remains intact for Host, TLS SNI, and certificate verification.
 */
export async function safeFetchBytes(
  input: string,
  init: RequestInit,
  options: SafeHttpOptions,
): Promise<SafeHttpResult> {
  const lookup = options.lookup ?? defaultLookup;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  let url: URL;

  try {
    url = new URL(input);
  } catch {
    throw new MsAdsError({ message: "The API returned an invalid outbound URL." });
  }

  try {
    for (let redirects = 0; ; redirects++) {
      const addresses = await validateDestination(
        url,
        lookup,
        options.allowedOrigin,
        controller.signal,
      );
      const fetchImpl = options.fetch ?? testFetch;
      const response = options.request
        ? await options.request(url, init, addresses[0] as string, controller.signal)
        : fetchImpl
          ? await fetchImpl(url, {
              ...init,
              redirect: "manual",
              signal: controller.signal,
            })
          : await pinnedHttpsRequest(
              url,
              init,
              addresses[0] as string,
              controller.signal,
            );

      if (!isRedirect(response.status)) {
        return {
          status: response.status,
          ok: response.ok,
          bytes: await readResponseBytes(response, options.maxBytes),
        };
      }

      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get("location");
      if (!location) {
        throw new MsAdsError({
          status: response.status,
          message: "Outbound request returned a redirect without a Location header.",
        });
      }
      if (redirects >= MAX_REDIRECTS) {
        throw new MsAdsError({
          message: "Outbound request exceeded the redirect limit.",
        });
      }

      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new MsAdsError({
          message: "Outbound request returned an invalid redirect.",
        });
      }

      const method = String(init.method ?? "GET").toUpperCase();
      if (
        method !== "GET" &&
        method !== "HEAD" &&
        response.status !== 307 &&
        response.status !== 308
      ) {
        throw new MsAdsError({
          message: "Credential-bearing request refused a method-changing redirect.",
        });
      }
      url = next;
    }
  } catch (error) {
    if (controller.signal.aborted || (error as Error).name === "AbortError") {
      throw new MsAdsError({
        message: `Outbound request timed out after ${options.timeoutMs}ms.`,
      });
    }
    if (error instanceof MsAdsError) throw error;
    throw new MsAdsError({
      message: `Outbound request failed: ${(error as Error).message ?? String(error)}`,
    });
  } finally {
    clearTimeout(timer);
  }
}

function pinnedHttpsRequest(
  url: URL,
  init: RequestInit,
  address: string,
  signal: AbortSignal,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const family = isIP(address) as 4 | 6;
    type PinnedLookupCallback = {
      (error: null, address: string, family: 4 | 6): void;
      (error: null, addresses: Array<{ address: string; family: 4 | 6 }>): void;
    };
    const pinnedLookup = ((
      _hostname: string,
      options: { all?: boolean } | number,
      callback: PinnedLookupCallback,
    ) => {
      if (typeof options === "object" && options.all) {
        callback(null, [{ address, family }]);
      } else {
        callback(null, address, family);
      }
    }) as unknown as LookupFunction;
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    headers.host = url.host;
    const request = httpsRequest(
      url,
      {
        method: init.method ?? "GET",
        headers,
        lookup: pinnedLookup,
        ...(isIP(hostname) ? {} : { servername: hostname }),
        signal,
      },
      (incoming) => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) responseHeaders.append(name, item);
          } else if (value !== undefined) {
            responseHeaders.set(name, value);
          }
        }
        const status = incoming.statusCode ?? 500;
        const body = status === 204 || status === 304 ? null : Readable.toWeb(incoming);
        resolve(
          new Response(body as ReadableStream<Uint8Array> | null, {
            status,
            headers: responseHeaders,
          }),
        );
      },
    );
    request.on("error", reject);

    const body = init.body;
    if (body === undefined || body === null) {
      request.end();
    } else if (typeof body === "string" || body instanceof Uint8Array) {
      request.end(body);
    } else {
      request.destroy(new Error("Pinned HTTPS requests require a buffered body."));
    }
  });
}

async function validateDestination(
  url: URL,
  lookup: DnsLookup,
  allowedOrigin: string | undefined,
  signal: AbortSignal,
): Promise<readonly string[]> {
  if (
    url.protocol !== "https:" ||
    (url.port !== "" && url.port !== "443") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new MsAdsError({
      message: "Outbound URLs must use HTTPS on port 443 without embedded credentials.",
    });
  }
  if (allowedOrigin && url.origin !== allowedOrigin) {
    throw new MsAdsError({ message: "Outbound URL is outside the approved origin." });
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: readonly string[];
  if (isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      addresses = await waitFor(lookup(hostname), signal);
    } catch (error) {
      if ((error as Error).name === "AbortError") throw error;
      throw new MsAdsError({ message: "Outbound URL hostname could not be resolved." });
    }
  }
  if (addresses.length === 0) {
    throw new MsAdsError({ message: "Outbound URL hostname resolved to no addresses." });
  }
  for (const address of addresses) {
    if (!isPublicAddress(address)) {
      throw new MsAdsError({
        message:
          "Outbound URL resolved to a private, local, metadata, or reserved address.",
      });
    }
  }
  return addresses;
}

function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;

  const words = ipv6Words(address);
  if (!words) return false;

  // IPv4-mapped addresses must be classified as IPv4, not accepted as IPv6.
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return isPublicIpv4(
      `${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`,
    );
  }

  const first = words[0] ?? 0;
  // Public IPv6 destinations are global unicast (2000::/3). This rejects
  // site-local fec0::/10 and other non-global address families by default.
  if ((first & 0xe000) !== 0x2000) return false;
  if (first === 0x2002) return false; // 6to4 can tunnel private IPv4
  if (first === 0x2001) {
    const second = words[1] ?? 0;
    if (second === 0x0db8) return false; // documentation
    if (second === 0x0000 || second === 0x0002) return false; // Teredo/benchmark
    if ((second & 0xfff0) === 0x0010 || (second & 0xfff0) === 0x0020) return false; // ORCHID
  }
  return true;
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a = 0, b = 0, c = 0] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function ipv6Words(address: string): number[] | null {
  const value = address.toLowerCase().split("%")[0] ?? "";
  const split = value.split("::");
  if (split.length > 2) return null;

  const parsePart = (part: string): number[] | null => {
    if (!part) return [];
    const out: number[] = [];
    for (const token of part.split(":")) {
      if (token.includes(".")) {
        const octets = token.split(".").map(Number);
        if (
          octets.length !== 4 ||
          octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
        )
          return null;
        out.push(((octets[0] ?? 0) << 8) | (octets[1] ?? 0));
        out.push(((octets[2] ?? 0) << 8) | (octets[3] ?? 0));
      } else if (!/^[0-9a-f]{1,4}$/.test(token)) {
        return null;
      } else {
        out.push(Number.parseInt(token, 16));
      }
    }
    return out;
  };

  const left = parsePart(split[0] ?? "");
  const right = parsePart(split[1] ?? "");
  if (!left || !right) return null;
  if (split.length === 1) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...Array(missing).fill(0), ...right];
}

function isRedirect(status: number): boolean {
  return (
    status === 301 || status === 302 || status === 303 || status === 307 || status === 308
  );
}

function bodyTooLarge(maxBytes: number): MsAdsError {
  return new MsAdsError({
    message: `HTTP response exceeded the ${maxBytes}-byte safety limit. Narrow the request or use a bounded file workflow.`,
  });
}
