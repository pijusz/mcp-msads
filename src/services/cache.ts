import { createHash } from "node:crypto";

/**
 * In-memory cache primitives for hot-path Microsoft Advertising API responses.
 *
 * Scope: per-process. Lost on server restart.
 *
 * Keying convention: every key starts with `sha256(credential).slice(0,12)` so
 * credential rotation invalidates everything derived from the old one. The
 * credential itself never appears in a key (avoids leaking via heap dumps).
 */

interface Entry<T> {
  value: T;
  expiresAt: number; // ms epoch; Number.POSITIVE_INFINITY = process-lifetime
}

const cache = new Map<string, Entry<unknown>>();

function fingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 12);
}

export function tokenKey(secret: string, suffix: string): string {
  return `${fingerprint(secret)}:${suffix}`;
}

/** Key prefix covering "everything derived from this credential". */
export function tokenPrefix(secret: string): string {
  return `${fingerprint(secret)}:`;
}

export function cacheGet<T>(key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value as T;
}

/** `ttlMs = Number.POSITIVE_INFINITY` caches for the process lifetime. */
export function cacheSet<T>(key: string, value: T, ttlMs: number): void {
  cache.set(key, {
    value,
    expiresAt:
      ttlMs === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : Date.now() + ttlMs,
  });
}

export function cacheInvalidate(key: string): boolean {
  return cache.delete(key);
}

/** Invalidate every key starting with `prefix`. Returns how many were removed. */
export function cacheInvalidatePrefix(prefix: string): number {
  let removed = 0;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
      removed++;
    }
  }
  return removed;
}

/** Compute-if-absent. `ttlMs = Number.POSITIVE_INFINITY` for memoize-forever. */
export async function cached<T>(
  key: string,
  ttlMs: number,
  compute: () => Promise<T>,
): Promise<T> {
  const hit = cacheGet<T>(key);
  if (hit !== undefined) return hit;
  const value = await compute();
  cacheSet(key, value, ttlMs);
  return value;
}

/** Test-only utility. */
export function cacheClear(): void {
  cache.clear();
}

/** Test-only utility. */
export function cacheSize(): number {
  return cache.size;
}
