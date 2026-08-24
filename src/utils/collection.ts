import { z } from "zod";

export const DEFAULT_COLLECTION_LIMIT = 200;
export const MAX_COLLECTION_LIMIT = 5000;

export const COLLECTION_LIMIT = z
  .number()
  .int()
  .min(1)
  .max(MAX_COLLECTION_LIMIT)
  .optional()
  .describe(
    `Maximum rows to return. Default ${DEFAULT_COLLECTION_LIMIT}; hard maximum ${MAX_COLLECTION_LIMIT}.`,
  );

interface CollectionOptions {
  limit?: number;
  total?: number;
  truncated?: boolean;
  guidance?: string;
}

/** Shape a public collection without renaming its domain-specific result key. */
export function collectionEnvelope<K extends string, T>(
  key: K,
  rows: readonly T[],
  options: CollectionOptions = {},
): { [P in K]: T[] } & {
  discovered?: number;
  total?: number;
  showing: number;
  truncated: boolean;
  guidance?: string;
} {
  const limit = options.limit ?? DEFAULT_COLLECTION_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_COLLECTION_LIMIT) {
    throw new RangeError(
      `Collection limit must be between 1 and ${MAX_COLLECTION_LIMIT}.`,
    );
  }

  const shown = rows.slice(0, limit);
  const truncated = options.truncated ?? (options.total ?? rows.length) > shown.length;
  return {
    ...(options.total !== undefined
      ? { total: options.total }
      : { discovered: rows.length }),
    showing: shown.length,
    truncated,
    ...(truncated
      ? {
          guidance:
            options.guidance ??
            "Narrow the filters, request a smaller scope, or use the available pagination arguments to retrieve more.",
        }
      : {}),
    [key]: shown,
  } as { [P in K]: T[] } & {
    discovered?: number;
    total?: number;
    showing: number;
    truncated: boolean;
    guidance?: string;
  };
}
