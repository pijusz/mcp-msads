import { type MsAdsBatchError, MsAdsError, readPartialErrors } from "@/utils/errors";

/**
 * Batch write result handling.
 *
 * Microsoft has no all-or-nothing mode for batch writes: "You will have to
 * handle that on the client side." A single call can half-succeed, and the
 * response encodes that across two structures with *different* indexing rules:
 *
 *   - The returned id array is POSITIONAL. `CampaignIds[i]` belongs to
 *     `Campaigns[i]` in the request, and is `null` where that item failed.
 *   - `PartialErrors` is NOT positional. It contains only failures, each
 *     carrying its own `Index`.
 *
 * Reporting a batch as one boolean is therefore wrong, and reporting only the
 * error list loses which inputs succeeded. This module reconciles the two into
 * one outcome per submitted item, which is what a caller actually needs to
 * decide what to retry.
 */

export interface BatchOutcomeError {
  code?: number;
  error_code?: string;
  message?: string;
  details?: string;
  field_path?: string;
  parent_index?: number;
}

export interface ItemOutcome {
  /** Position in the submitted array. */
  index: number;
  success: boolean;
  /** Assigned entity id, present on success. */
  id?: string;
  /** Echo of an identifying field from the input, to make the result readable. */
  label?: string;
  /** First error, retained for concise consumers. */
  error?: BatchOutcomeError;
  /** Every error attributed to this item. */
  errors?: BatchOutcomeError[];
}

export interface BatchResult {
  submitted: number;
  succeeded: number;
  failed: number;
  /** True when every submitted item failed — a systematic problem, not per-item. */
  all_failed: boolean;
  /**
   * Errors the API returned without an index, so they cannot be attributed to
   * a specific item. Counted separately: folding them into `failed` would make
   * `succeeded + failed` exceed `submitted`.
   */
  unattributed_errors?: MsAdsBatchError[];
  /** Ids of the items that succeeded, in submission order. */
  ids: string[];
  outcomes: ItemOutcome[];
}

function formatError(err: MsAdsBatchError): BatchOutcomeError {
  return {
    ...(err.code !== undefined && { code: err.code }),
    ...(err.errorCode !== undefined && { error_code: err.errorCode }),
    ...(err.message !== undefined && { message: err.message }),
    ...(err.details !== undefined && { details: err.details }),
    ...(err.fieldPath !== undefined && { field_path: err.fieldPath }),
    ...(err.parent_index !== undefined && { parent_index: err.parent_index }),
  };
}

/**
 * Reconcile a batch response into per-item outcomes.
 *
 * @param response  Raw JSON body from the API.
 * @param idField   Name of the returned id array, e.g. "CampaignIds".
 * @param labels    Optional per-index labels (a name, a keyword) for readability.
 * @param submitted Item count, when the id array may be absent entirely.
 */
export function mapBatchResult(
  response: Record<string, unknown>,
  idField: string,
  labels: Array<string | undefined> = [],
  submitted?: number,
): BatchResult {
  const rawIds = response[idField];
  const ids = Array.isArray(rawIds) ? rawIds : [];
  const partialErrors = readPartialErrors(response);
  const baseCount = Math.max(ids.length, labels.length);
  const count =
    submitted ??
    (baseCount > 0
      ? baseCount
      : Math.max(
          0,
          ...partialErrors.map((error) =>
            Number.isInteger(error.index) && (error.index as number) >= 0
              ? (error.index as number) + 1
              : 0,
          ),
        ));
  const errorsByIndex = new Map<number, MsAdsBatchError[]>();
  const unindexed: MsAdsBatchError[] = [];

  for (const error of partialErrors) {
    const index = error.index;
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= count) {
      unindexed.push(error);
      continue;
    }
    const bucket = errorsByIndex.get(index as number);
    if (bucket) bucket.push(error);
    else errorsByIndex.set(index as number, [error]);
  }

  const outcomes: ItemOutcome[] = [];
  const successIds: string[] = [];

  for (let i = 0; i < count; i++) {
    const itemErrors = errorsByIndex.get(i) ?? [];
    const rawId = ids[i];
    // `null` in the id array is Microsoft's marker for "this one failed".
    const id = rawId === null || rawId === undefined ? undefined : String(rawId);
    const label = labels[i];
    const success = itemErrors.length === 0 && id !== undefined;
    const formattedErrors = itemErrors.map(formatError);

    if (success && id) successIds.push(id);

    outcomes.push({
      index: i,
      success,
      ...(id !== undefined && { id }),
      ...(label !== undefined && { label }),
      ...(formattedErrors.length > 0
        ? { error: formattedErrors[0], errors: formattedErrors }
        : {}),
      // No id and no matching error: the API neither confirmed nor explained it.
      ...(!success && formattedErrors.length === 0
        ? {
            error: {
              message:
                "The API returned neither an id nor an error for this item. Re-read the entity to confirm whether it was created.",
            },
          }
        : {}),
    });
  }

  const succeeded = outcomes.filter((o) => o.success).length;
  const failed = outcomes.length - succeeded;

  // Unindexed errors still have to surface, but as their own channel — they
  // describe the request rather than any one item.
  for (const err of unindexed) {
    outcomes.push({ index: -1, success: false, error: formatError(err) });
  }

  return {
    submitted: count,
    succeeded,
    failed,
    all_failed: count > 0 && succeeded === 0,
    ...(unindexed.length > 0 ? { unattributed_errors: unindexed } : {}),
    ids: successIds,
    outcomes,
  };
}

/**
 * Split a list into API-sized chunks.
 *
 * The real limits are lower than intuition suggests — 100 campaigns, 50 ads —
 * so callers must chunk rather than assume a generous batch size.
 */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size < 1) throw new Error("Chunk size must be at least 1.");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** Documented per-operation batch limits. Exceeding one is an outright error. */
export const BATCH_LIMITS = {
  campaigns: 100,
  adGroups: 1000,
  ads: 50,
  adsGet: 20,
  keywords: 1000,
  adGroupCriterions: 1000,
  campaignCriterions: 100,
  budgets: 100,
  bidStrategies: 100,
  audiences: 100,
  adExtensions: 100,
  conversionGoals: 100,
  uetTags: 100,
  labels: 100,
  offlineConversions: 1000,
  productPartitionActions: 5000,
} as const;

/** Guard a batch against its documented limit, naming the limit on failure. */
export function assertBatchLimit(items: unknown[], limit: number, what: string): void {
  if (items.length === 0) {
    throw new MsAdsError({ message: `No ${what} supplied.` });
  }
  if (items.length > limit) {
    throw new MsAdsError({
      message:
        `Too many ${what}: ${items.length}. The API accepts at most ${limit} per call. ` +
        "Split the request into smaller batches.",
    });
  }
}
