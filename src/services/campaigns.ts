import { batchWrite, type EntitySpec } from "@/services/batch-write";
import {
  normalizeBiddingScheme,
  rejectChildBidStrategy,
  validateCampaignType,
  validateMatchType,
} from "@/services/guardrails";
import { msadsFetch, type Scope } from "@/services/msads-api";
import { BATCH_LIMITS, type BatchResult } from "@/utils/batch";
import { toMsDate } from "@/utils/dates";
import { assertHasFields, stripUndefined } from "@/utils/tool-response";

/**
 * Campaign Management: campaigns, ad groups, ads, keywords, budgets.
 *
 * Every write here goes through `batchWrite` and so `mapBatchResult`, because
 * Microsoft batch writes half-succeed by design and a caller needs per-item
 * outcomes. Each entity's write guardrails and shaping live in its spec's
 * `toWire`, so tools and direct service callers get the same rules.
 */

async function call<T>(
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  body: unknown,
  ids: Scope,
  retry?: "safe",
): Promise<T> {
  return msadsFetch<T>("CampaignManagement", path, { method, body, ...ids, retry });
}

/**
 * Convert StartDate / EndDate from `YYYY-MM-DD` to the API's `{Day, Month,
 * Year}` object. Callers pass ISO strings so that a date means the same thing
 * everywhere (run_report takes `2026-08-01` too); building the object wrong is
 * API error 113. Non-string values pass through unchanged.
 */
function withIsoDates(entity: Record<string, unknown>): Record<string, unknown> {
  const out = { ...entity };
  for (const field of ["StartDate", "EndDate"] as const) {
    const value = entity[field];
    if (typeof value === "string" && value !== "") out[field] = toMsDate(value);
  }
  return out;
}

/**
 * Defaulting creates to Paused: creating live spend without being asked to is
 * not a reasonable default for an agent-driven call. An explicit Status wins.
 */
function pausedByDefault(entity: Record<string, unknown>): Record<string, unknown> {
  return { Status: "Paused", ...entity };
}

const CAMPAIGNS: EntitySpec = {
  path: "Campaigns",
  parent: "AccountId",
  list: "Campaigns",
  idField: "CampaignIds",
  limit: BATCH_LIMITS.campaigns,
  what: "campaigns",
  /** ISO dates converted, BiddingScheme Type normalized, type checked on create. */
  toWire(campaign, op) {
    if (op === "add") {
      validateCampaignType(campaign.CampaignType);
      campaign = pausedByDefault(campaign);
    }
    const out = withIsoDates(campaign);
    if (campaign.BiddingScheme !== undefined) {
      out.BiddingScheme = normalizeBiddingScheme(campaign.BiddingScheme);
    }
    return out;
  },
  label: (c, op) => String(op === "add" ? (c.Name ?? "") : (c.Name ?? c.Id ?? "")),
};

const AD_GROUPS: EntitySpec = {
  path: "AdGroups",
  parent: "CampaignId",
  list: "AdGroups",
  idField: "AdGroupIds",
  limit: BATCH_LIMITS.adGroups,
  what: "ad groups",
  /** Bid strategies are campaign-level only, so refuse one. */
  toWire(adGroup, op) {
    if (op === "add") adGroup = pausedByDefault(adGroup);
    rejectChildBidStrategy(adGroup, "ad group");
    return withIsoDates(adGroup);
  },
  label: (g, op) => String(op === "add" ? (g.Name ?? "") : (g.Name ?? g.Id ?? "")),
};

/* ------------------------------------------------------------------ *
 * Campaigns
 * ------------------------------------------------------------------ */

/**
 * Fields the API withholds unless explicitly requested. Asking for them by
 * default costs nothing and avoids a caller wondering why a configured bid
 * strategy or ad-schedule setting appears to be missing.
 */
const CAMPAIGN_ADDITIONAL_FIELDS = [
  "AdScheduleUseSearcherTimeZone",
  "TargetSetting",
  "MaxConversionValueBiddingScheme",
  "TargetImpressionShareBiddingScheme",
  // Comma-delimited. The reference docs describe SOAP's flags-enum
  // serialization, which is space-delimited; REST/JSON rejects that with
  // "Invalid JSON ... Path: $.ReturnAdditionalFields". Verified against the
  // live API — an array is rejected too.
].join(",");

export async function getCampaignsByAccount(
  ids: Scope,
  campaignType?: string,
): Promise<Record<string, unknown>[]> {
  const res = await call<{ Campaigns?: Record<string, unknown>[] }>(
    "Campaigns/QueryByAccountId",
    "POST",
    {
      AccountId: ids.accountId,
      ...(campaignType ? { CampaignType: campaignType } : {}),
      ReturnAdditionalFields: CAMPAIGN_ADDITIONAL_FIELDS,
    },
    ids,
    "safe",
  );
  return res.Campaigns ?? [];
}

export async function getCampaignsByIds(
  ids: Scope,
  campaignIds: string[],
): Promise<Record<string, unknown>[]> {
  const res = await call<{ Campaigns?: Record<string, unknown>[] }>(
    "Campaigns/QueryByIds",
    "POST",
    {
      AccountId: ids.accountId,
      CampaignIds: campaignIds,
      ReturnAdditionalFields: CAMPAIGN_ADDITIONAL_FIELDS,
    },
    ids,
    "safe",
  );
  return res.Campaigns ?? [];
}

export function addCampaigns(
  ids: Scope,
  campaigns: Record<string, unknown>[],
): Promise<BatchResult> {
  return batchWrite(CAMPAIGNS, "add", ids, undefined, campaigns);
}

export function updateCampaigns(
  ids: Scope,
  campaigns: Record<string, unknown>[],
): Promise<BatchResult> {
  return batchWrite(CAMPAIGNS, "update", ids, undefined, campaigns);
}

export function deleteCampaigns(ids: Scope, campaignIds: string[]): Promise<BatchResult> {
  return batchWrite(CAMPAIGNS, "delete", ids, undefined, campaignIds);
}

/* ------------------------------------------------------------------ *
 * Ad groups
 * ------------------------------------------------------------------ */

export async function getAdGroupsByCampaign(
  ids: Scope,
  campaignId: string,
): Promise<Record<string, unknown>[]> {
  const res = await call<{ AdGroups?: Record<string, unknown>[] }>(
    "AdGroups/QueryByCampaignId",
    "POST",
    { CampaignId: campaignId },
    ids,
    "safe",
  );
  return res.AdGroups ?? [];
}

export async function getAdGroupsByIds(
  ids: Scope,
  campaignId: string,
  adGroupIds: string[],
): Promise<Record<string, unknown>[]> {
  const res = await call<{ AdGroups?: Record<string, unknown>[] }>(
    "AdGroups/QueryByIds",
    "POST",
    { CampaignId: campaignId, AdGroupIds: adGroupIds },
    ids,
    "safe",
  );
  return res.AdGroups ?? [];
}

export function addAdGroups(
  ids: Scope,
  campaignId: string,
  adGroups: Record<string, unknown>[],
): Promise<BatchResult> {
  return batchWrite(AD_GROUPS, "add", ids, campaignId, adGroups);
}

export function updateAdGroups(
  ids: Scope,
  campaignId: string,
  adGroups: Record<string, unknown>[],
): Promise<BatchResult> {
  return batchWrite(AD_GROUPS, "update", ids, campaignId, adGroups);
}

export function deleteAdGroups(
  ids: Scope,
  campaignId: string,
  adGroupIds: string[],
): Promise<BatchResult> {
  return batchWrite(AD_GROUPS, "delete", ids, campaignId, adGroupIds);
}

/* ------------------------------------------------------------------ *
 * Ads
 * ------------------------------------------------------------------ */

/**
 * Ad types, for both the `AdTypes` read filter and an ad's own `Type`
 * discriminator. Note the absent `Ad` suffix: the API wants `ResponsiveSearch`,
 * and `ResponsiveSearchAd` fails to deserialize, taking the whole request with
 * it — the reply is error 100 ("the request message is null"), which says
 * nothing about the type that caused it.
 */
export const AD_TYPES = [
  "Text",
  "Image",
  "Product",
  "AppInstall",
  "ExpandedText",
  "DynamicSearch",
  "ResponsiveAd",
  "ResponsiveSearch",
  "Hotel",
] as const;

export async function getAdsByAdGroup(
  ids: Scope,
  adGroupId: string,
  adTypes?: string[],
): Promise<Record<string, unknown>[]> {
  const res = await call<{ Ads?: Record<string, unknown>[] }>(
    "Ads/QueryByAdGroupId",
    "POST",
    {
      AdGroupId: adGroupId,
      // Required despite reading as a filter: omitting it fails with error
      // 2805, whose message ("Creating or updating ads of this type is not
      // allowed") describes a write and names no type. No filter means all.
      AdTypes: adTypes?.length ? adTypes : [...AD_TYPES],
    },
    ids,
    "safe",
  );
  return res.Ads ?? [];
}

/**
 * Responsive search ad copy travels as asset links, not plain text: a headline
 * is `{ Asset: { Text, Type: "TextAsset" } }`. Passing `{ Text }` directly is
 * rejected with error 6206 ("Headline is not valid"), which does not hint that
 * the shape rather than the content is the problem. Accept the shorthand and
 * wrap it, so a caller can write a headline as a string.
 */
function toAssetLinks(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item) => {
    if (typeof item === "string") {
      return { Asset: { Text: item, Type: "TextAsset" } };
    }
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      if ("Asset" in record) return record;
      if (typeof record.Text === "string") {
        const { Text, ...rest } = record;
        return { ...rest, Asset: { Text, Type: "TextAsset" } };
      }
    }
    return item;
  });
}

const ASSET_LINK_FIELDS = ["Headlines", "Descriptions", "LongHeadlines"] as const;

export function normalizeAdAssets(ad: Record<string, unknown>): Record<string, unknown> {
  const out = { ...ad };
  for (const field of ASSET_LINK_FIELDS) {
    if (field in out) out[field] = toAssetLinks(out[field]);
  }
  return out;
}

const ADS: EntitySpec = {
  path: "Ads",
  parent: "AdGroupId",
  list: "Ads",
  idField: "AdIds",
  limit: BATCH_LIMITS.ads,
  what: "ads",
  // Create and update share the asset-link normalization; update used to skip it.
  toWire: (ad, op) => normalizeAdAssets(op === "add" ? pausedByDefault(ad) : ad),
  label: (a, op) => String(op === "add" ? (a.Type ?? "") : (a.Id ?? "")),
};

export function addAds(
  ids: Scope,
  adGroupId: string,
  ads: Record<string, unknown>[],
): Promise<BatchResult> {
  return batchWrite(ADS, "add", ids, adGroupId, ads);
}

export function updateAds(
  ids: Scope,
  adGroupId: string,
  ads: Record<string, unknown>[],
): Promise<BatchResult> {
  return batchWrite(ADS, "update", ids, adGroupId, ads);
}

export function deleteAds(
  ids: Scope,
  adGroupId: string,
  adIds: string[],
): Promise<BatchResult> {
  return batchWrite(ADS, "delete", ids, adGroupId, adIds);
}

/* ------------------------------------------------------------------ *
 * Keywords
 * ------------------------------------------------------------------ */

export async function getKeywordsByAdGroup(
  ids: Scope,
  adGroupId: string,
): Promise<Record<string, unknown>[]> {
  const res = await call<{ Keywords?: Record<string, unknown>[] }>(
    "Keywords/QueryByAdGroupId",
    "POST",
    { AdGroupId: adGroupId },
    ids,
    "safe",
  );
  return res.Keywords ?? [];
}

const KEYWORDS: EntitySpec = {
  path: "Keywords",
  parent: "AdGroupId",
  list: "Keywords",
  idField: "KeywordIds",
  limit: BATCH_LIMITS.keywords,
  what: "keywords",
  toWire(keyword, op) {
    if (op === "add") {
      validateMatchType(keyword.MatchType);
      rejectChildBidStrategy(keyword, "keyword");
      return pausedByDefault(keyword);
    }
    // Id identifies the row; something else has to change or this is a no-op.
    const { Id: _id, ...fields } = stripUndefined(keyword);
    assertHasFields(fields, "update on a keyword");
    rejectChildBidStrategy(keyword, "keyword");
    return keyword;
  },
  label: (k, op) =>
    op === "add"
      ? `${k.Text ?? ""} (${k.MatchType ?? ""})`
      : String(k.Text ?? k.Id ?? ""),
};

export function addKeywords(
  ids: Scope,
  adGroupId: string,
  keywords: Record<string, unknown>[],
): Promise<BatchResult> {
  return batchWrite(KEYWORDS, "add", ids, adGroupId, keywords);
}

export function updateKeywords(
  ids: Scope,
  adGroupId: string,
  keywords: Record<string, unknown>[],
): Promise<BatchResult> {
  return batchWrite(KEYWORDS, "update", ids, adGroupId, keywords);
}

export function deleteKeywords(
  ids: Scope,
  adGroupId: string,
  keywordIds: string[],
): Promise<BatchResult> {
  return batchWrite(KEYWORDS, "delete", ids, adGroupId, keywordIds);
}

/* ------------------------------------------------------------------ *
 * Budgets
 * ------------------------------------------------------------------ */

export async function getBudgetsByIds(
  ids: Scope,
  budgetIds?: string[],
): Promise<Record<string, unknown>[]> {
  const res = await call<{ Budgets?: Record<string, unknown>[] }>(
    "Budgets/QueryByIds",
    "POST",
    { BudgetIds: budgetIds ?? null },
    ids,
    "safe",
  );
  return res.Budgets ?? [];
}
