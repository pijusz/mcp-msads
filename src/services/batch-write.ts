import { msadsFetch, type Scope, type ServiceName } from "@/services/msads-api";
import { assertBatchLimit, type BatchResult, mapBatchResult } from "@/utils/batch";

/**
 * The add / update / delete shape shared by most entity writes.
 *
 * Campaign Management batch writes differ only in path, parent field, list
 * field, id field, limit and per-item shaping. Writing each one out by hand let
 * them drift — update_ads skipped the asset normalization that create_ads
 * applied — so the shape lives here once and each entity is a spec.
 *
 * Body key order is part of the wire contract and is preserved exactly:
 *
 *   add / update  { [parent], [list]: items, ...batchFields }
 *   delete        { [parent], [idField]: ids, ...batchFields }
 *
 * Writes whose request or response does not fit (nested negative keywords,
 * associations that return only PartialErrors) stay explicit in their service.
 */

type Entity = Record<string, unknown>;

export type EntityOp = "add" | "update";
export type WriteOp = EntityOp | "delete";

export interface EntitySpec {
  /** Defaults to CampaignManagement. */
  service?: ServiceName;
  path: string;
  /**
   * Parent field sent first in the body. `AccountId` is filled from the scope;
   * the others from the `parentId` argument.
   */
  parent?: "AccountId" | "CampaignId" | "AdGroupId";
  /** Body field carrying the entities on add / update, e.g. `Campaigns`. */
  list: string;
  /** Response id array, and the body field carrying ids on delete. */
  idField: string;
  limit: number;
  /** Plural noun for limit errors, e.g. "ad groups". */
  what: string;
  /**
   * Per-item guardrails and wire shaping. The single place an entity's write
   * rules live: throw to reject, return the object to send.
   */
  toWire?(entity: Entity, op: EntityOp): Entity;
  /** Readable per-item label for the outcome list. Delete labels are the ids. */
  label(entity: Entity, op: EntityOp): string;
  /**
   * Batch-level checks and trailing body fields, evaluated after the limit
   * check and per-item shaping.
   */
  batchFields?(items: Entity[] | string[], op: WriteOp): Entity;
  /** For add responses that return objects rather than a bare id array. */
  addedIds?(response: Entity): unknown[];
}

const METHODS = { add: "POST", update: "PUT", delete: "DELETE" } as const;

export function batchWrite(
  spec: EntitySpec,
  op: EntityOp,
  scope: Scope,
  parentId: string | undefined,
  items: Entity[],
): Promise<BatchResult>;
export function batchWrite(
  spec: EntitySpec,
  op: "delete",
  scope: Scope,
  parentId: string | undefined,
  items: string[],
): Promise<BatchResult>;
export async function batchWrite(
  spec: EntitySpec,
  op: WriteOp,
  scope: Scope,
  parentId: string | undefined,
  items: Entity[] | string[],
): Promise<BatchResult> {
  assertBatchLimit(items, spec.limit, spec.what);
  const parent = spec.parent
    ? { [spec.parent]: spec.parent === "AccountId" ? scope.accountId : parentId }
    : {};
  const send = (body: Entity) =>
    msadsFetch<Entity>(spec.service ?? "CampaignManagement", spec.path, {
      method: METHODS[op],
      body,
      ...scope,
    });

  if (op === "delete") {
    const ids = items as string[];
    const res = await send({
      ...parent,
      [spec.idField]: ids,
      ...spec.batchFields?.(ids, op),
    });
    // Delete returns no id array; synthesize outcomes from the submitted ids.
    return mapBatchResult({ [spec.idField]: ids, ...res }, spec.idField, ids, ids.length);
  }

  const wire = (items as Entity[]).map((e) => (spec.toWire ? spec.toWire(e, op) : e));
  const res = await send({
    ...parent,
    [spec.list]: wire,
    ...spec.batchFields?.(wire, op),
  });
  const labels = wire.map((e) => spec.label(e, op));
  if (op === "add") {
    const response = spec.addedIds ? { ...res, [spec.idField]: spec.addedIds(res) } : res;
    return mapBatchResult(response, spec.idField, labels, wire.length);
  }
  // Update returns no id array; synthesize outcomes from the submitted ids.
  return mapBatchResult(
    { [spec.idField]: wire.map((e) => e.Id ?? null), ...res },
    spec.idField,
    labels,
    wire.length,
  );
}
