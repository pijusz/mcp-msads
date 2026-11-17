import { batchWrite, type EntitySpec } from "@/services/batch-write";
import { validateNegativeMatchType } from "@/services/guardrails";
import { msadsFetch, type Scope } from "@/services/msads-api";
import {
  assertBatchLimit,
  BATCH_LIMITS,
  type BatchResult,
  chunk,
  mapBatchResult,
} from "@/utils/batch";
import { MsAdsError, readPartialErrors } from "@/utils/errors";

/**
 * Ad extensions, labels, and negative keywords.
 *
 * Ad extensions carry a trap worth stating loudly: they do NOT support partial
 * update. Any optional field omitted on a PUT is deleted from the extension,
 * unlike almost every other entity in this API.
 */

/**
 * Result shape for operations that return ONLY `PartialErrors` — no id array.
 *
 * Association and label-assignment writes are not positional-id batches, so
 * running them through `mapBatchResult` reports every success as a failure:
 * with no ids to match, every item looks like "no id and no error".
 */
export interface AssociationResult {
  submitted: number;
  succeeded: number;
  failed: number;
  errors: ReturnType<typeof readPartialErrors>;
  unattributed_errors?: ReturnType<typeof readPartialErrors>;
}

function associationResult(res: unknown, submitted: number): AssociationResult {
  const partialErrors = readPartialErrors(res);
  const errors = partialErrors.filter(
    (error) =>
      typeof error.index === "number" && error.index >= 0 && error.index < submitted,
  );
  const unattributedErrors = partialErrors.filter((error) => !errors.includes(error));
  const failed = new Set(errors.map((error) => error.index)).size;
  return {
    submitted,
    succeeded: submitted - failed,
    failed,
    errors,
    ...(unattributedErrors.length > 0 ? { unattributed_errors: unattributedErrors } : {}),
  };
}

export const AD_EXTENSION_TYPES = [
  "SitelinkAdExtension",
  "CalloutAdExtension",
  "StructuredSnippetAdExtension",
  "CallAdExtension",
  "ImageAdExtension",
  "LogoAdExtension",
  "PriceAdExtension",
  "PromotionAdExtension",
  "ReviewAdExtension",
  "ActionAdExtension",
  "AppAdExtension",
  "FilterLinkAdExtension",
  "FlyerAdExtension",
  "LocationAdExtension",
] as const;

/**
 * Ids of the account's extensions of one type.
 *
 * GetAdExtensionIdsByAccountId answers `{ AdExtensionIds: long[] }` — bare ids,
 * not associations. Omit `associationType` to include unassociated extensions.
 */
export async function getAdExtensionIds(
  ids: Scope,
  extensionType: string,
  associationType?: string,
): Promise<string[]> {
  const res = await msadsFetch<{
    AdExtensionIds?: Array<string | number | null> | null;
  }>("CampaignManagement", "AdExtensionIds/QueryByAccountId", {
    body: {
      AccountId: ids.accountId,
      AdExtensionType: extensionType,
      ...(associationType ? { AssociationType: associationType } : {}),
    },
    ...ids,
    retry: "safe",
  });
  const list = Array.isArray(res.AdExtensionIds) ? res.AdExtensionIds : [];
  return [
    ...new Set(list.filter((id) => id !== null && id !== "").map((id) => String(id))),
  ];
}

export async function getAdExtensionsByIds(
  ids: Scope,
  extensionIds: string[],
  extensionType: string,
): Promise<Record<string, unknown>[]> {
  const extensions: Record<string, unknown>[] = [];
  for (const batch of chunk(extensionIds, BATCH_LIMITS.adExtensions)) {
    const res = await msadsFetch<{ AdExtensions?: Record<string, unknown>[] }>(
      "CampaignManagement",
      "AdExtensions/QueryByIds",
      {
        body: {
          AccountId: ids.accountId,
          AdExtensionIds: batch,
          AdExtensionType: extensionType,
        },
        ...ids,
        retry: "safe",
      },
    );
    extensions.push(...(res.AdExtensions ?? []));
  }
  return extensions;
}

const AD_EXTENSIONS: EntitySpec = {
  path: "AdExtensions",
  parent: "AccountId",
  list: "AdExtensions",
  idField: "AdExtensionIds",
  limit: BATCH_LIMITS.adExtensions,
  what: "ad extensions",
  label: (e, op) => String(op === "add" ? (e.Type ?? "") : (e.Id ?? "")),
  // AdExtensionIdentities is an array of { Id, Version } objects, not bare ids.
  // Passing it through unflattened stringifies each to "[object Object]", which
  // then cannot be fed to associate_ad_extensions.
  addedIds: (res) =>
    Array.isArray(res.AdExtensionIdentities)
      ? (res.AdExtensionIdentities as Array<{ Id?: unknown } | null>).map(
          (i) => i?.Id ?? null,
        )
      : [],
};

export function addAdExtensions(
  ids: Scope,
  extensions: Record<string, unknown>[],
): Promise<BatchResult> {
  return batchWrite(AD_EXTENSIONS, "add", ids, undefined, extensions);
}

export function updateAdExtensions(
  ids: Scope,
  extensions: Record<string, unknown>[],
): Promise<BatchResult> {
  return batchWrite(AD_EXTENSIONS, "update", ids, undefined, extensions);
}

export function deleteAdExtensions(
  ids: Scope,
  extensionIds: string[],
): Promise<BatchResult> {
  return batchWrite(AD_EXTENSIONS, "delete", ids, undefined, extensionIds);
}

/**
 * Attach extensions to campaigns or ad groups.
 *
 * An extension exists in an account-level library and does nothing until it is
 * associated with something. Callout extensions additionally need 2–20
 * associated before any of them serve.
 */
export async function setAdExtensionAssociations(
  ids: Scope,
  associations: Record<string, unknown>[],
  associationType: string,
): Promise<AssociationResult> {
  assertBatchLimit(associations, BATCH_LIMITS.adExtensions, "associations");
  const res = await msadsFetch<Record<string, unknown>>(
    "CampaignManagement",
    "AdExtensionsAssociations/Set",
    {
      method: "POST",
      body: {
        AccountId: ids.accountId,
        AdExtensionIdToEntityIdAssociations: associations,
        AssociationType: associationType,
      },
      ...ids,
    },
  );
  return associationResult(res, associations.length);
}

export async function getAdExtensionAssociations(
  ids: Scope,
  entityIds: string[],
  associationType: string,
  extensionTypes?: string[],
): Promise<Record<string, unknown>[]> {
  const res = await msadsFetch<{
    AdExtensionAssociationCollection?: Record<string, unknown>[];
  }>("CampaignManagement", "AdExtensionsAssociations/Query", {
    body: {
      AccountId: ids.accountId,
      EntityIds: entityIds,
      AssociationType: associationType,
      // Required, not optional: omitting it fails with error 3814
      // ("AdExtensionType is invalid"). Comma-delimited — a space-delimited
      // list is rejected as malformed JSON. Default to every type so an
      // unfiltered query means "all", which is what callers expect.
      AdExtensionType: (extensionTypes?.length
        ? extensionTypes
        : AD_EXTENSION_TYPES
      ).join(","),
    },
    ...ids,
    retry: "safe",
  });
  return res.AdExtensionAssociationCollection ?? [];
}

export async function deleteAdExtensionAssociations(
  ids: Scope,
  associations: Record<string, unknown>[],
  associationType: string,
): Promise<AssociationResult> {
  const res = await msadsFetch<Record<string, unknown>>(
    "CampaignManagement",
    "AdExtensionsAssociations",
    {
      method: "DELETE",
      body: {
        AccountId: ids.accountId,
        AdExtensionIdToEntityIdAssociations: associations,
        AssociationType: associationType,
      },
      ...ids,
    },
  );
  return associationResult(res, associations.length);
}

/* ------------------------------------------------------------------ *
 * Negative keywords
 * ------------------------------------------------------------------ */

/** Up to 20,000 negative keywords per entity. */
export const NEGATIVE_KEYWORD_LIMIT = 20_000;

export async function getNegativeKeywords(
  ids: Scope,
  entityIds: string[],
  entityType: "Campaign" | "AdGroup",
  parentCampaignId?: string,
): Promise<Record<string, unknown>[]> {
  if (entityType === "AdGroup" && !parentCampaignId) {
    throw new MsAdsError({
      message: "parent_campaign_id is required when listing ad-group negative keywords.",
    });
  }
  if (entityType === "AdGroup" && entityIds.length !== 1) {
    throw new MsAdsError({
      message:
        "Ad-group negative-keyword reads accept exactly one ad group per call. Send separate requests for each ad group.",
    });
  }

  const res = await msadsFetch<{ EntityNegativeKeywords?: Record<string, unknown>[] }>(
    "CampaignManagement",
    "NegativeKeywords/QueryByEntityIds",
    {
      body: {
        EntityIds: entityIds,
        EntityType: entityType,
        ParentEntityId: entityType === "AdGroup" ? parentCampaignId : ids.accountId,
      },
      ...ids,
      retry: "safe",
    },
  );
  return res.EntityNegativeKeywords ?? [];
}

export async function addNegativeKeywords(
  ids: Scope,
  entityId: string,
  entityType: "Campaign" | "AdGroup",
  keywords: Array<{ Text: string; MatchType: string }>,
): Promise<BatchResult> {
  assertBatchLimit(keywords, NEGATIVE_KEYWORD_LIMIT, "negative keywords");
  for (const k of keywords) validateNegativeMatchType(k.MatchType, k.Text);
  const res = await msadsFetch<Record<string, unknown>>(
    "CampaignManagement",
    "EntityNegativeKeywords",
    {
      method: "POST",
      body: {
        EntityNegativeKeywords: [
          {
            EntityId: entityId,
            EntityType: entityType,
            // NegativeKeyword derives from SharedListItem: REST needs the discriminator.
            NegativeKeywords: keywords.map((k) => ({ Type: "NegativeKeyword", ...k })),
          },
        ],
      },
      ...ids,
    },
  );
  // NegativeKeywordIds is an IdCollection[] keyed to ENTITIES, not keywords: one
  // entry was submitted, so the ids for our N keywords live in its nested Ids
  // array. Reconciling against the outer array would report N-1 phantom failures.
  const collections = Array.isArray(res.NegativeKeywordIds)
    ? (res.NegativeKeywordIds as Array<{ Ids?: unknown[] } | null>)
    : [];
  const keywordIds = Array.isArray(collections[0]?.Ids) ? collections[0].Ids : [];
  return mapBatchResult(
    { ...res, NegativeKeywordIds: keywordIds },
    "NegativeKeywordIds",
    keywords.map((k) => `${k.Text} (${k.MatchType})`),
    keywords.length,
  );
}

export async function deleteNegativeKeywords(
  ids: Scope,
  entityId: string,
  entityType: "Campaign" | "AdGroup",
  keywordIds: string[],
): Promise<BatchResult> {
  assertBatchLimit(keywordIds, NEGATIVE_KEYWORD_LIMIT, "negative keywords");
  const res = await msadsFetch<Record<string, unknown>>(
    "CampaignManagement",
    "EntityNegativeKeywords",
    {
      method: "DELETE",
      body: {
        EntityNegativeKeywords: [
          {
            EntityId: entityId,
            EntityType: entityType,
            NegativeKeywords: keywordIds.map((id) => ({
              Type: "NegativeKeyword",
              Id: id,
            })),
          },
        ],
      },
      ...ids,
    },
  );
  return mapBatchResult(
    { NegativeKeywordIds: keywordIds, ...res },
    "NegativeKeywordIds",
    keywordIds,
    keywordIds.length,
  );
}

/* ------------------------------------------------------------------ *
 * Labels
 * ------------------------------------------------------------------ */

export async function getLabels(
  ids: Scope,
  labelIds?: string[],
  pageIndex = 0,
  pageSize = 200,
): Promise<Record<string, unknown>[]> {
  const res = await msadsFetch<{ Labels?: Record<string, unknown>[] }>(
    "CampaignManagement",
    "Labels/QueryByIds",
    {
      body: {
        LabelIds: labelIds ?? null,
        PageInfo: { Index: pageIndex, Size: Math.min(pageSize, 1000) },
      },
      ...ids,
      retry: "safe",
    },
  );
  return res.Labels ?? [];
}

const LABELS: EntitySpec = {
  path: "Labels",
  list: "Labels",
  idField: "LabelIds",
  limit: BATCH_LIMITS.labels,
  what: "labels",
  label: (l) => String(l.Name ?? ""),
};

export function addLabels(
  ids: Scope,
  labels: Record<string, unknown>[],
): Promise<BatchResult> {
  return batchWrite(LABELS, "add", ids, undefined, labels);
}

export async function setLabelAssociations(
  ids: Scope,
  associations: Record<string, unknown>[],
  entityType: string,
): Promise<AssociationResult> {
  assertBatchLimit(associations, BATCH_LIMITS.labels, "label associations");
  const res = await msadsFetch<Record<string, unknown>>(
    "CampaignManagement",
    "LabelAssociations/Set",
    {
      method: "POST",
      body: { EntityType: entityType, LabelAssociations: associations },
      ...ids,
    },
  );
  return associationResult(res, associations.length);
}
