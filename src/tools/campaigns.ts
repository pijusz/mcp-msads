import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ResolvedAccount } from "@/services/accounts";
import * as cm from "@/services/campaigns";
import {
  BID_STRATEGIES,
  CAMPAIGN_TYPES,
  MATCH_TYPES,
  rejectChildBidStrategy,
  validateBidStrategy,
  validateCampaignType,
  validateMatchType,
} from "@/services/guardrails";
import { toMsDate } from "@/services/reporting";
import { ACCOUNT_ARGS, ids, WRITE } from "@/tools/_shared";
import { BATCH_LIMITS } from "@/utils/batch";
import {
  COLLECTION_LIMIT,
  collectionEnvelope,
  DEFAULT_COLLECTION_LIMIT,
  MAX_COLLECTION_LIMIT,
} from "@/utils/collection";
import { defineRead } from "@/utils/define-read";
import { MsAdsError } from "@/utils/errors";
import { destructiveTool, writeTool } from "@/utils/register-tool";
import { assertHasFields, run, stripUndefined } from "@/utils/tool-response";

/** Every write tool resolves the account/customer pair the same way. */
/** Status is Active or Paused; there is no separate 'Enabled'. */
const STATUS = z.enum(["Active", "Paused"]);

/**
 * Ads must carry their `Type` on update, and the caller of set_status only has
 * ids. Read the ad group once and pair each id with the type the API reported,
 * rather than guessing a type and having the write rejected.
 */
async function withAdTypes(
  scope: ResolvedAccount,
  adGroupId: string,
  adIds: string[],
  status: string,
): Promise<Record<string, unknown>[]> {
  const existing = await cm.getAdsByAdGroup(scope, adGroupId);
  const typeById = new Map(existing.map((ad) => [String(ad.Id), String(ad.Type ?? "")]));
  return adIds.map((id) => {
    const type = typeById.get(id);
    if (!type) {
      throw new MsAdsError({
        message: `Ad ${id} was not found in ad group ${adGroupId}. Check parent_id.`,
      });
    }
    return { Id: id, Type: type, Status: status };
  });
}

/**
 * Convert StartDate / EndDate from `YYYY-MM-DD` to the API's `{Day, Month,
 * Year}` object.
 *
 * The tools take ISO strings so that a date means the same thing everywhere:
 * run_report already accepted `2026-08-01`, while these tools made the caller
 * hand-build a date object for the identical concept. Building it wrong is
 * API error 113.
 */
function isoDates(entity: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of ["StartDate", "EndDate"] as const) {
    const value = entity[field];
    if (typeof value === "string" && value !== "") out[field] = toMsDate(value);
  }
  return out;
}

export function registerCampaignTools(server: McpServer): void {
  /* ---------------------------- reads ---------------------------- */

  defineRead(server, {
    name: "list_campaigns",
    title: "Campaigns",
    uriTemplate: "msads://account/{accountId}/campaigns",
    uriVars: { accountId: "account_id" },
    priority: 0.9,
    description:
      "List campaigns in an ad account, with budget, status, bid strategy, and campaign type. " +
      "Optionally filter to one campaign type (Search, Shopping, Audience, PerformanceMax, Hotel, App), " +
      "or pass campaign_ids to fetch specific campaigns.",
    inputSchema: {
      ...ACCOUNT_ARGS,
      campaign_type: z
        .enum(CAMPAIGN_TYPES)
        .optional()
        .describe("Restrict to one campaign type."),
      campaign_ids: z
        .array(z.string())
        .max(MAX_COLLECTION_LIMIT)
        .optional()
        .describe("Fetch these campaigns specifically instead of the whole account."),
      limit: COLLECTION_LIMIT,
    },
    handler: async (args) => {
      const scope = await ids(args);
      const wanted = Array.isArray(args.campaign_ids)
        ? args.campaign_ids.map(String)
        : null;
      const campaigns = wanted
        ? await cm.getCampaignsByIds(scope, wanted)
        : await cm.getCampaignsByAccount(
            scope,
            args.campaign_type ? String(args.campaign_type) : undefined,
          );
      return {
        account_id: scope.accountId,
        ...collectionEnvelope("campaigns", campaigns, {
          limit: Number(args.limit ?? DEFAULT_COLLECTION_LIMIT),
        }),
      };
    },
  });

  defineRead(server, {
    name: "list_ad_groups",
    title: "Ad groups",
    uriTemplate: "msads://campaign/{campaignId}/adgroups",
    uriVars: { campaignId: "campaign_id" },
    priority: 0.85,
    description:
      "List the ad groups in a campaign, with status, bids, and targeting settings.",
    inputSchema: {
      ...ACCOUNT_ARGS,
      campaign_id: z.string().describe("Campaign id."),
      limit: COLLECTION_LIMIT,
    },
    handler: async (args) => {
      const scope = await ids(args);
      const adGroups = await cm.getAdGroupsByCampaign(scope, String(args.campaign_id));
      return {
        campaign_id: String(args.campaign_id),
        ...collectionEnvelope("ad_groups", adGroups, {
          limit: Number(args.limit ?? DEFAULT_COLLECTION_LIMIT),
        }),
      };
    },
  });

  defineRead(server, {
    name: "list_ads",
    title: "Ads",
    uriTemplate: "msads://adgroup/{adGroupId}/ads",
    uriVars: { adGroupId: "ad_group_id" },
    priority: 0.85,
    description:
      "List the ads in an ad group. Optionally filter by ad type (ResponsiveSearchAd, ExpandedTextAd, ResponsiveAd, ProductAd, DynamicSearchAd, AppInstallAd, HotelAd, TextAd).",
    inputSchema: {
      ...ACCOUNT_ARGS,
      ad_group_id: z.string().describe("Ad group id."),
      ad_types: z
        .array(z.enum(cm.AD_TYPES))
        .optional()
        .describe("Restrict to these ad types. All types when omitted."),
      limit: COLLECTION_LIMIT,
    },
    handler: async (args) => {
      const scope = await ids(args);
      const ads = await cm.getAdsByAdGroup(
        scope,
        String(args.ad_group_id),
        Array.isArray(args.ad_types) ? args.ad_types.map(String) : undefined,
      );
      return {
        ad_group_id: String(args.ad_group_id),
        ...collectionEnvelope("ads", ads, {
          limit: Number(args.limit ?? DEFAULT_COLLECTION_LIMIT),
        }),
      };
    },
  });

  defineRead(server, {
    name: "list_keywords",
    title: "Keywords",
    uriTemplate: "msads://adgroup/{adGroupId}/keywords",
    uriVars: { adGroupId: "ad_group_id" },
    priority: 0.85,
    description:
      "List the keywords in an ad group, with match type, bid, status, and final URLs. " +
      "For performance data on these keywords use run_report with report_type keyword_performance.",
    inputSchema: {
      ...ACCOUNT_ARGS,
      ad_group_id: z.string().describe("Ad group id."),
      limit: COLLECTION_LIMIT,
    },
    handler: async (args) => {
      const scope = await ids(args);
      const keywords = await cm.getKeywordsByAdGroup(scope, String(args.ad_group_id));
      return {
        ad_group_id: String(args.ad_group_id),
        ...collectionEnvelope("keywords", keywords, {
          limit: Number(args.limit ?? DEFAULT_COLLECTION_LIMIT),
        }),
      };
    },
  });

  defineRead(server, {
    name: "list_budgets",
    title: "Shared budgets",
    uriTemplate: "msads://account/{accountId}/budgets",
    uriVars: { accountId: "account_id" },
    priority: 0.6,
    description:
      "List shared budgets in the account's budget library. Campaigns using a shared budget carry its BudgetId; " +
      "campaigns with their own budget have BudgetId 0 and a DailyBudget of their own.",
    inputSchema: {
      ...ACCOUNT_ARGS,
      budget_ids: z
        .array(z.string())
        .max(MAX_COLLECTION_LIMIT)
        .optional()
        .describe("Specific budget ids; omit for all."),
      limit: COLLECTION_LIMIT,
    },
    handler: async (args) => {
      const scope = await ids(args);
      const budgets = await cm.getBudgetsByIds(
        scope,
        Array.isArray(args.budget_ids) ? args.budget_ids.map(String) : undefined,
      );
      return collectionEnvelope("budgets", budgets, {
        limit: Number(args.limit ?? DEFAULT_COLLECTION_LIMIT),
      });
    },
  });

  /* ---------------------------- writes ---------------------------- */

  writeTool(
    server,
    "create_campaigns",
    `${WRITE}Create up to ${BATCH_LIMITS.campaigns} campaigns in one call.

Batch writes half-succeed by design: the result reports a per-item outcome with the assigned id or the specific error, so check the per-item outcomes list, not just the succeeded count.

Notes that prevent silent misconfiguration:
- Budget: set daily_budget for an unshared budget, or budget_id to attach a shared one — not both.
- Bid strategy: TargetCpa and TargetRoas can no longer be set on a campaign; use MaxConversions / MaxConversionValue and put the target inside that scheme.
- DynamicSearchAds is no longer a campaign type; use Search with a SearchDynamic ad group.
- New campaigns default to Paused here unless you pass status explicitly.`,
    {
      ...ACCOUNT_ARGS,
      campaigns: z
        .array(
          z
            .object({
              Name: z.string().describe("Campaign name, unique within the account."),
              CampaignType: z.enum(CAMPAIGN_TYPES).optional().describe("Default Search."),
              DailyBudget: z
                .number()
                .optional()
                .describe("Daily budget in account currency."),
              BudgetType: z
                .enum([
                  "DailyBudgetStandard",
                  "DailyBudgetAccelerated",
                  "LifetimeBudgetStandard",
                ])
                .optional(),
              BudgetId: z
                .string()
                .optional()
                .describe("Attach an existing shared budget."),
              Status: STATUS.optional().describe("Default Paused."),
              BiddingScheme: z
                .object({ Type: z.enum(BID_STRATEGIES) })
                .passthrough()
                .optional()
                .describe(
                  'e.g. { "Type": "MaxConversionsBiddingScheme", "TargetCpa": 25 }',
                ),
              Languages: z
                .array(z.string())
                .min(1)
                .describe(
                  'Required. A campaign with no languages accepts no ad groups: every ad group creation under it fails with error 1257 unless each one repeats a Language of its own. Audience campaigns need ["All"].',
                ),
              TimeZone: z.string().optional(),
              StartDate: z.string().optional().describe("YYYY-MM-DD."),
              EndDate: z.string().optional().describe("YYYY-MM-DD."),
              TrackingUrlTemplate: z.string().optional(),
              FinalUrlSuffix: z.string().optional(),
              Settings: z.array(z.record(z.string(), z.unknown())).optional(),
            })
            .passthrough(),
        )
        .min(1)
        .max(BATCH_LIMITS.campaigns),
    },
    run(async (args: Record<string, unknown>) => {
      const scope = await ids(args);
      const campaigns = (args.campaigns as Record<string, unknown>[]).map((c) => {
        validateCampaignType(c.CampaignType);
        validateBidStrategy(c.BiddingScheme);
        // Defaulting to Paused: creating live spend without being asked to is
        // not a reasonable default for an agent-driven call.
        return { Status: "Paused", ...c, ...isoDates(c) };
      });
      return cm.addCampaigns(scope, campaigns);
    }),
  );

  writeTool(
    server,
    "update_campaigns",
    `${WRITE}Update existing campaigns. Each entry must carry its Id; every other field is optional and only the fields you send are changed.

Use this to pause or resume (Status), change budgets, or switch bid strategy. Check per-item outcomes in the result.`,
    {
      ...ACCOUNT_ARGS,
      campaigns: z
        .array(
          z
            .object({
              Id: z.string().describe("Campaign id to update."),
              Name: z.string().optional(),
              Status: STATUS.optional(),
              DailyBudget: z.number().optional(),
              BudgetId: z.string().optional(),
              BiddingScheme: z
                .object({ Type: z.enum(BID_STRATEGIES) })
                .passthrough()
                .optional(),
              TrackingUrlTemplate: z.string().optional(),
              FinalUrlSuffix: z.string().optional(),
            })
            .passthrough(),
        )
        .min(1)
        .max(BATCH_LIMITS.campaigns),
    },
    run(async (args: Record<string, unknown>) => {
      const scope = await ids(args);
      const campaigns = args.campaigns as Record<string, unknown>[];
      for (const c of campaigns) validateBidStrategy(c.BiddingScheme);
      return cm.updateCampaigns(scope, campaigns);
    }),
  );

  writeTool(
    server,
    "set_status",
    `${WRITE}Pause or resume campaigns, ad groups, ads, or keywords by id.

Pausing is the reversible alternative to deleting: delivery stops, historical performance is kept, and it can be undone. Reach for this before any delete_* tool.

Ad groups, ads, and keywords need parent_id (the campaign id for an ad group, the ad group id for an ad or keyword).`,
    {
      ...ACCOUNT_ARGS,
      entity_type: z
        .enum(["campaign", "ad_group", "ad", "keyword"])
        .describe("What the ids refer to."),
      ids: z.array(z.string()).min(1).describe("Entity ids to change."),
      status: STATUS.describe("Active to resume, Paused to stop delivery."),
      parent_id: z
        .string()
        .optional()
        .describe(
          "Campaign id for ad groups; ad group id for ads and keywords. Not needed for campaigns.",
        ),
    },
    run(async (args: Record<string, unknown>) => {
      const scope = await ids(args);
      const entityIds = (args.ids as string[]).map(String);
      const status = String(args.status);
      const type = String(args.entity_type);
      const parentId = args.parent_id ? String(args.parent_id) : "";

      if (type !== "campaign" && !parentId) {
        const parent = type === "ad_group" ? "campaign id" : "ad group id";
        throw new MsAdsError({
          message: `parent_id is required for ${type} — pass the ${parent} it belongs to.`,
        });
      }

      const rows = entityIds.map((id) => ({ Id: id, Status: status }));
      switch (type) {
        case "campaign":
          return cm.updateCampaigns(scope, rows);
        case "ad_group":
          return cm.updateAdGroups(scope, parentId, rows);
        case "ad":
          // Ads require their Type on update; read it back rather than guess.
          return cm.updateAds(
            scope,
            parentId,
            await withAdTypes(scope, parentId, entityIds, status),
          );
        default:
          return cm.updateKeywords(scope, parentId, rows);
      }
    }),
  );

  destructiveTool(
    server,
    "delete_campaigns",
    `${WRITE}Permanently delete campaigns. This cannot be undone and removes their ad groups, ads, and keywords with them. To stop delivery reversibly, use set_campaign_status with Paused instead.`,
    {
      ...ACCOUNT_ARGS,
      campaign_ids: z.array(z.string()).min(1).max(BATCH_LIMITS.campaigns),
    },
    run(async (args: Record<string, unknown>) => {
      const scope = await ids(args);
      return cm.deleteCampaigns(scope, (args.campaign_ids as string[]).map(String));
    }),
  );

  writeTool(
    server,
    "create_ad_groups",
    `${WRITE}Create up to ${BATCH_LIMITS.adGroups} ad groups in one campaign.

Bid strategies cannot be set here — they are campaign-level only since April 2021, and the API silently ignores an ad-group BiddingScheme rather than rejecting it.`,
    {
      ...ACCOUNT_ARGS,
      campaign_id: z.string().describe("Parent campaign id."),
      ad_groups: z
        .array(
          z
            .object({
              Name: z.string(),
              Status: STATUS.optional().describe("Default Paused."),
              CpcBid: z
                .object({ Amount: z.number() })
                .optional()
                .describe("Default bid."),
              StartDate: z.string().optional().describe("YYYY-MM-DD."),
              EndDate: z.string().optional().describe("YYYY-MM-DD."),
              Language: z
                .string()
                .optional()
                .describe(
                  "Inherited from the campaign's Languages when omitted. Required only if the campaign declares none, which otherwise fails with error 1257.",
                ),
              Network: z.string().optional(),
              AdGroupType: z
                .string()
                .optional()
                .describe("e.g. SearchStandard, SearchDynamic."),
            })
            .passthrough(),
        )
        .min(1)
        .max(BATCH_LIMITS.adGroups),
    },
    run(async (args: Record<string, unknown>) => {
      const scope = await ids(args);
      const adGroups = (args.ad_groups as Record<string, unknown>[]).map((g) => {
        rejectChildBidStrategy(g, "ad group");
        return { Status: "Paused", ...g, ...isoDates(g) };
      });
      return cm.addAdGroups(scope, String(args.campaign_id), adGroups);
    }),
  );

  writeTool(
    server,
    "update_ad_groups",
    `${WRITE}Update ad groups. Each entry must carry its Id. Only the fields you send change.`,
    {
      ...ACCOUNT_ARGS,
      campaign_id: z.string(),
      ad_groups: z
        .array(
          z
            .object({
              Id: z.string(),
              Name: z.string().optional(),
              Status: STATUS.optional(),
              CpcBid: z.object({ Amount: z.number() }).optional(),
            })
            .passthrough(),
        )
        .min(1)
        .max(BATCH_LIMITS.adGroups),
    },
    run(async (args: Record<string, unknown>) => {
      const scope = await ids(args);
      const adGroups = args.ad_groups as Record<string, unknown>[];
      for (const g of adGroups) rejectChildBidStrategy(g, "ad group");
      return cm.updateAdGroups(scope, String(args.campaign_id), adGroups);
    }),
  );

  destructiveTool(
    server,
    "delete_ad_groups",
    `${WRITE}Permanently delete ad groups and everything under them. Pause instead if you may want them back.`,
    {
      ...ACCOUNT_ARGS,
      campaign_id: z.string(),
      ad_group_ids: z.array(z.string()).min(1).max(BATCH_LIMITS.adGroups),
    },
    run(async (args: Record<string, unknown>) => {
      const scope = await ids(args);
      return cm.deleteAdGroups(
        scope,
        String(args.campaign_id),
        (args.ad_group_ids as string[]).map(String),
      );
    }),
  );

  writeTool(
    server,
    "create_ads",
    `${WRITE}Create up to ${BATCH_LIMITS.ads} ads in one ad group.

Each ad needs a Type discriminator — note the absent "Ad" suffix. Responsive search ads are the current default format:
{ "Type": "ResponsiveSearch", "Headlines": ["..."], "Descriptions": ["..."], "Path1": "...", "FinalUrls": ["https://..."] }

Headlines and Descriptions are sent to the API as asset links; plain strings are wrapped for you.

Limits: 3–15 headlines (≤30 chars each), 2–4 descriptions (≤90 chars each), Path1/Path2 ≤15 chars. An ad group allows at most 3 active responsive search ads and 100 ads in total.`,
    {
      ...ACCOUNT_ARGS,
      ad_group_id: z.string().describe("Parent ad group id."),
      ads: z
        .array(
          z
            .object({
              Type: z
                .enum(cm.AD_TYPES)
                .describe("Ad type discriminator. No 'Ad' suffix."),
              Status: STATUS.optional().describe("Default Paused."),
              FinalUrls: z.array(z.string()).optional(),
            })
            .passthrough(),
        )
        .min(1)
        .max(BATCH_LIMITS.ads),
    },
    run(async (args: Record<string, unknown>) => {
      const scope = await ids(args);
      const ads = (args.ads as Record<string, unknown>[]).map((a) => ({
        Status: "Paused",
        ...a,
      }));
      return cm.addAds(scope, String(args.ad_group_id), ads);
    }),
  );

  writeTool(
    server,
    "update_ads",
    `${WRITE}Update ads. Each entry needs Id and Type. Most ad copy fields cannot be edited after creation — for a copy change, create a new ad and delete the old one.`,
    {
      ...ACCOUNT_ARGS,
      ad_group_id: z.string(),
      ads: z
        .array(z.object({ Id: z.string(), Type: z.string() }).passthrough())
        .min(1)
        .max(BATCH_LIMITS.ads),
    },
    run(async (args: Record<string, unknown>) => {
      const scope = await ids(args);
      return cm.updateAds(
        scope,
        String(args.ad_group_id),
        args.ads as Record<string, unknown>[],
      );
    }),
  );

  destructiveTool(
    server,
    "delete_ads",
    `${WRITE}Permanently delete ads from an ad group.`,
    {
      ...ACCOUNT_ARGS,
      ad_group_id: z.string(),
      ad_ids: z.array(z.string()).min(1).max(BATCH_LIMITS.ads),
    },
    run(async (args: Record<string, unknown>) => {
      const scope = await ids(args);
      return cm.deleteAds(
        scope,
        String(args.ad_group_id),
        (args.ad_ids as string[]).map(String),
      );
    }),
  );

  writeTool(
    server,
    "create_keywords",
    `${WRITE}Add up to ${BATCH_LIMITS.keywords} keywords to an ad group.

Match types are Broad, Phrase, and Exact only — Content and broad-match-modifier no longer exist in v13. Keyword text is capped at 100 characters.

Per-keyword bids are allowed, but bid STRATEGIES are campaign-level only.`,
    {
      ...ACCOUNT_ARGS,
      ad_group_id: z.string().describe("Parent ad group id."),
      keywords: z
        .array(
          z
            .object({
              Text: z.string().max(100).describe("Keyword text."),
              MatchType: z.enum(MATCH_TYPES),
              Bid: z
                .object({ Amount: z.number() })
                .optional()
                .describe("Per-keyword max CPC."),
              Status: STATUS.optional().describe("Default Paused."),
              FinalUrls: z.array(z.string()).optional(),
              Param1: z.string().optional(),
              Param2: z.string().optional(),
              Param3: z.string().optional(),
            })
            .passthrough(),
        )
        .min(1)
        .max(BATCH_LIMITS.keywords),
    },
    run(async (args: Record<string, unknown>) => {
      const scope = await ids(args);
      const keywords = (args.keywords as Record<string, unknown>[]).map((k) => {
        validateMatchType(k.MatchType);
        rejectChildBidStrategy(k, "keyword");
        return { Status: "Paused", ...k };
      });
      return cm.addKeywords(scope, String(args.ad_group_id), keywords);
    }),
  );

  writeTool(
    server,
    "update_keywords",
    `${WRITE}Update keywords — bids, status, final URLs. Each entry must carry its Id.`,
    {
      ...ACCOUNT_ARGS,
      ad_group_id: z.string(),
      keywords: z
        .array(
          z
            .object({
              Id: z.string(),
              Bid: z.object({ Amount: z.number() }).optional(),
              Status: STATUS.optional(),
              FinalUrls: z.array(z.string()).optional(),
            })
            .passthrough(),
        )
        .min(1)
        .max(BATCH_LIMITS.keywords),
    },
    run(async (args: Record<string, unknown>) => {
      const scope = await ids(args);
      const keywords = (args.keywords as Record<string, unknown>[]).map((k) => {
        // Id identifies the row; something else has to change or this is a no-op.
        const { Id: _id, ...fields } = stripUndefined(k);
        assertHasFields(fields, "update on a keyword");
        rejectChildBidStrategy(k, "keyword");
        return k;
      });
      return cm.updateKeywords(scope, String(args.ad_group_id), keywords);
    }),
  );

  destructiveTool(
    server,
    "delete_keywords",
    `${WRITE}Permanently delete keywords from an ad group. Historical performance for a deleted keyword stays in reports, but the keyword itself is gone. Pause instead if you may want it back.`,
    {
      ...ACCOUNT_ARGS,
      ad_group_id: z.string(),
      keyword_ids: z.array(z.string()).min(1).max(BATCH_LIMITS.keywords),
    },
    run(async (args: Record<string, unknown>) => {
      const scope = await ids(args);
      return cm.deleteKeywords(
        scope,
        String(args.ad_group_id),
        (args.keyword_ids as string[]).map(String),
      );
    }),
  );
}
