import { msadsFetch } from "@/services/msads-api";
import {
  assertBatchLimit,
  BATCH_LIMITS,
  type BatchResult,
  mapBatchResult,
} from "@/utils/batch";

/**
 * Campaign Management: campaigns, ad groups, ads, keywords, budgets.
 *
 * Every write here goes through `mapBatchResult`, because Microsoft batch
 * writes half-succeed by design and a caller needs per-item outcomes.
 */

export interface AccountIds {
  accountId: string;
  customerId?: string;
}

async function call<T>(
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  body: unknown,
  ids: AccountIds,
  retry?: "safe",
): Promise<T> {
  return msadsFetch<T>("CampaignManagement", path, { method, body, ...ids, retry });
}

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
  ids: AccountIds,
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
  ids: AccountIds,
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

export async function addCampaigns(
  ids: AccountIds,
  campaigns: Record<string, unknown>[],
): Promise<BatchResult> {
  assertBatchLimit(campaigns, BATCH_LIMITS.campaigns, "campaigns");
  const res = await call<Record<string, unknown>>(
    "Campaigns",
    "POST",
    { AccountId: ids.accountId, Campaigns: campaigns },
    ids,
  );
  return mapBatchResult(
    res,
    "CampaignIds",
    campaigns.map((c) => String(c.Name ?? "")),
    campaigns.length,
  );
}

export async function updateCampaigns(
  ids: AccountIds,
  campaigns: Record<string, unknown>[],
): Promise<BatchResult> {
  assertBatchLimit(campaigns, BATCH_LIMITS.campaigns, "campaigns");
  const res = await call<Record<string, unknown>>(
    "Campaigns",
    "PUT",
    { AccountId: ids.accountId, Campaigns: campaigns },
    ids,
  );
  // Update returns no id array; synthesize outcomes from the submitted ids.
  return mapBatchResult(
    { CampaignIds: campaigns.map((c) => c.Id ?? null), ...res },
    "CampaignIds",
    campaigns.map((c) => String(c.Name ?? c.Id ?? "")),
    campaigns.length,
  );
}

export async function deleteCampaigns(
  ids: AccountIds,
  campaignIds: string[],
): Promise<BatchResult> {
  assertBatchLimit(campaignIds, BATCH_LIMITS.campaigns, "campaigns");
  const res = await call<Record<string, unknown>>(
    "Campaigns",
    "DELETE",
    { AccountId: ids.accountId, CampaignIds: campaignIds },
    ids,
  );
  return mapBatchResult(
    { CampaignIds: campaignIds, ...res },
    "CampaignIds",
    campaignIds,
    campaignIds.length,
  );
}

/* ------------------------------------------------------------------ *
 * Ad groups
 * ------------------------------------------------------------------ */

export async function getAdGroupsByCampaign(
  ids: AccountIds,
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
  ids: AccountIds,
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

export async function addAdGroups(
  ids: AccountIds,
  campaignId: string,
  adGroups: Record<string, unknown>[],
): Promise<BatchResult> {
  assertBatchLimit(adGroups, BATCH_LIMITS.adGroups, "ad groups");
  const res = await call<Record<string, unknown>>(
    "AdGroups",
    "POST",
    { CampaignId: campaignId, AdGroups: adGroups },
    ids,
  );
  return mapBatchResult(
    res,
    "AdGroupIds",
    adGroups.map((g) => String(g.Name ?? "")),
    adGroups.length,
  );
}

export async function updateAdGroups(
  ids: AccountIds,
  campaignId: string,
  adGroups: Record<string, unknown>[],
): Promise<BatchResult> {
  assertBatchLimit(adGroups, BATCH_LIMITS.adGroups, "ad groups");
  const res = await call<Record<string, unknown>>(
    "AdGroups",
    "PUT",
    { CampaignId: campaignId, AdGroups: adGroups },
    ids,
  );
  return mapBatchResult(
    { AdGroupIds: adGroups.map((g) => g.Id ?? null), ...res },
    "AdGroupIds",
    adGroups.map((g) => String(g.Name ?? g.Id ?? "")),
    adGroups.length,
  );
}

export async function deleteAdGroups(
  ids: AccountIds,
  campaignId: string,
  adGroupIds: string[],
): Promise<BatchResult> {
  assertBatchLimit(adGroupIds, BATCH_LIMITS.adGroups, "ad groups");
  const res = await call<Record<string, unknown>>(
    "AdGroups",
    "DELETE",
    { CampaignId: campaignId, AdGroupIds: adGroupIds },
    ids,
  );
  return mapBatchResult(
    { AdGroupIds: adGroupIds, ...res },
    "AdGroupIds",
    adGroupIds,
    adGroupIds.length,
  );
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
  ids: AccountIds,
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

export async function addAds(
  ids: AccountIds,
  adGroupId: string,
  ads: Record<string, unknown>[],
): Promise<BatchResult> {
  assertBatchLimit(ads, BATCH_LIMITS.ads, "ads");
  ads = ads.map(normalizeAdAssets);
  const res = await call<Record<string, unknown>>(
    "Ads",
    "POST",
    { AdGroupId: adGroupId, Ads: ads },
    ids,
  );
  return mapBatchResult(
    res,
    "AdIds",
    ads.map((a) => String(a.Type ?? "")),
    ads.length,
  );
}

export async function updateAds(
  ids: AccountIds,
  adGroupId: string,
  ads: Record<string, unknown>[],
): Promise<BatchResult> {
  assertBatchLimit(ads, BATCH_LIMITS.ads, "ads");
  const res = await call<Record<string, unknown>>(
    "Ads",
    "PUT",
    { AdGroupId: adGroupId, Ads: ads },
    ids,
  );
  return mapBatchResult(
    { AdIds: ads.map((a) => a.Id ?? null), ...res },
    "AdIds",
    ads.map((a) => String(a.Id ?? "")),
    ads.length,
  );
}

export async function deleteAds(
  ids: AccountIds,
  adGroupId: string,
  adIds: string[],
): Promise<BatchResult> {
  assertBatchLimit(adIds, BATCH_LIMITS.ads, "ads");
  const res = await call<Record<string, unknown>>(
    "Ads",
    "DELETE",
    { AdGroupId: adGroupId, AdIds: adIds },
    ids,
  );
  return mapBatchResult({ AdIds: adIds, ...res }, "AdIds", adIds, adIds.length);
}

/* ------------------------------------------------------------------ *
 * Keywords
 * ------------------------------------------------------------------ */

export async function getKeywordsByAdGroup(
  ids: AccountIds,
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

export async function addKeywords(
  ids: AccountIds,
  adGroupId: string,
  keywords: Record<string, unknown>[],
): Promise<BatchResult> {
  assertBatchLimit(keywords, BATCH_LIMITS.keywords, "keywords");
  const res = await call<Record<string, unknown>>(
    "Keywords",
    "POST",
    { AdGroupId: adGroupId, Keywords: keywords },
    ids,
  );
  return mapBatchResult(
    res,
    "KeywordIds",
    keywords.map((k) => `${k.Text ?? ""} (${k.MatchType ?? ""})`),
    keywords.length,
  );
}

export async function updateKeywords(
  ids: AccountIds,
  adGroupId: string,
  keywords: Record<string, unknown>[],
): Promise<BatchResult> {
  assertBatchLimit(keywords, BATCH_LIMITS.keywords, "keywords");
  const res = await call<Record<string, unknown>>(
    "Keywords",
    "PUT",
    { AdGroupId: adGroupId, Keywords: keywords },
    ids,
  );
  return mapBatchResult(
    { KeywordIds: keywords.map((k) => k.Id ?? null), ...res },
    "KeywordIds",
    keywords.map((k) => String(k.Text ?? k.Id ?? "")),
    keywords.length,
  );
}

export async function deleteKeywords(
  ids: AccountIds,
  adGroupId: string,
  keywordIds: string[],
): Promise<BatchResult> {
  assertBatchLimit(keywordIds, BATCH_LIMITS.keywords, "keywords");
  const res = await call<Record<string, unknown>>(
    "Keywords",
    "DELETE",
    { AdGroupId: adGroupId, KeywordIds: keywordIds },
    ids,
  );
  return mapBatchResult(
    { KeywordIds: keywordIds, ...res },
    "KeywordIds",
    keywordIds,
    keywordIds.length,
  );
}

/* ------------------------------------------------------------------ *
 * Budgets
 * ------------------------------------------------------------------ */

export async function getBudgetsByIds(
  ids: AccountIds,
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
