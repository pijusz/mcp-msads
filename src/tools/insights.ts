import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as ai from "@/services/ad-insight";
import { MATCH_TYPES } from "@/services/guardrails";
import { toMsDate } from "@/services/reporting";
import { ACCOUNT_ARGS, ids } from "@/tools/_shared";
import {
  COLLECTION_LIMIT,
  collectionEnvelope,
  DEFAULT_COLLECTION_LIMIT,
} from "@/utils/collection";
import { defineRead } from "@/utils/define-read";

const SANDBOX_NOTE =
  "Note: Ad Insight is heavily degraded in the sandbox — Microsoft's own docs recommend running it against production.";

export function registerInsightTools(server: McpServer): void {
  defineRead(server, {
    name: "get_keyword_ideas",
    title: "Keyword ideas",
    priority: 0.9,
    description:
      "Microsoft Advertising's keyword planner: search volume, competition, and suggested bids for keyword ideas. " +
      "Seed it with queries (terms you already have in mind) or a url (a page Microsoft reads for ideas), or both.\n\n" +
      "The API requires a language, a location, and a network on every request — language and network default sensibly, but location_ids has no safe default and must be supplied. " +
      "Returns up to about 3,000 ideas.\n\n" +
      "MonthlySearchCounts comes back newest-first. Last month's figure can lag by up to 72 hours.\n\n" +
      SANDBOX_NOTE,
    inputSchema: {
      ...ACCOUNT_ARGS,
      queries: z.array(z.string()).optional().describe("Seed keywords."),
      url: z
        .string()
        .optional()
        .describe("Seed URL; Microsoft derives ideas from the page."),
      location_ids: z
        .array(z.number().int())
        .min(1)
        .describe("Microsoft geographical location ids, e.g. 190 for the United States."),
      language: z
        .string()
        .optional()
        .describe('Language name, e.g. "English". Default English.'),
      network: z
        .string()
        .optional()
        .describe("Default OwnedAndOperatedAndSyndicatedSearch."),
      expand_ideas: z
        .boolean()
        .optional()
        .describe(
          "True (default) returns related ideas; false returns stats on the seeds only.",
        ),
      attributes: z
        .array(z.enum(ai.IDEA_ATTRIBUTES))
        .optional()
        .describe("Which attributes to return. Competition is always included."),
      min_search_volume: z.number().int().optional(),
      max_search_volume: z.number().int().optional(),
      min_competition: z.number().min(0).max(1).optional().describe("0.0–1.0."),
      max_competition: z.number().min(0).max(1).optional().describe("0.0–1.0."),
      exclude_account_keywords: z
        .boolean()
        .optional()
        .describe("Skip ideas already present in the account."),
      limit: COLLECTION_LIMIT,
    },
    handler: async (args) => {
      const scope = await ids(args);
      const ideas = await ai.getKeywordIdeas(scope, {
        ...(Array.isArray(args.queries) ? { queries: args.queries.map(String) } : {}),
        ...(args.url ? { url: String(args.url) } : {}),
        locationIds: (args.location_ids as number[]).map(Number),
        language: args.language ? String(args.language) : "English",
        ...(args.network ? { network: String(args.network) } : {}),
        ...(args.expand_ideas !== undefined
          ? { expandIdeas: args.expand_ideas === true }
          : {}),
        ...(Array.isArray(args.attributes)
          ? { attributes: args.attributes.map(String) }
          : {}),
        ...(args.min_search_volume !== undefined
          ? { minSearchVolume: Number(args.min_search_volume) }
          : {}),
        ...(args.max_search_volume !== undefined
          ? { maxSearchVolume: Number(args.max_search_volume) }
          : {}),
        ...(args.min_competition !== undefined
          ? { minCompetition: Number(args.min_competition) }
          : {}),
        ...(args.max_competition !== undefined
          ? { maxCompetition: Number(args.max_competition) }
          : {}),
        ...(args.exclude_account_keywords === true
          ? { excludeAccountKeywords: true }
          : {}),
      });

      return collectionEnvelope("ideas", ideas, {
        limit: Number(args.limit ?? DEFAULT_COLLECTION_LIMIT),
        guidance: "Tighten the search-volume or competition filters, or raise limit.",
      });
    },
  });

  defineRead(server, {
    name: "get_keyword_traffic_estimates",
    title: "Keyword traffic estimates",
    priority: 0.8,
    description:
      "Estimate clicks, impressions, average CPC, and total cost for a set of keywords at a given bid — before spending anything on them. " +
      "Each estimate comes back as a minimum/maximum pair rather than a single number.\n\n" +
      "Pair this with get_keyword_ideas: ideas tell you what people search for, estimates tell you what it would cost to show up.\n\n" +
      SANDBOX_NOTE,
    inputSchema: {
      ...ACCOUNT_ARGS,
      keywords: z
        .array(
          z.object({
            text: z.string(),
            match_type: z.enum(MATCH_TYPES),
            max_cpc: z.number().optional().describe("Per-keyword bid override."),
          }),
        )
        .min(1)
        .describe("Keywords to estimate."),
      max_cpc: z
        .number()
        .optional()
        .describe(
          "Bid to estimate at. Required unless every keyword carries its own max_cpc — an estimate is a projection at a bid.",
        ),
      daily_budget: z.number().optional().describe("Assumed daily budget."),
      location_ids: z
        .array(z.number().int())
        .min(1)
        .describe(
          "Required — the API rejects a request without one. Look ids up with get_targeting_id_file (file=geo_locations).",
        ),
      language: z
        .string()
        .optional()
        .describe("English (default), French, or German — the API supports no others."),
      network: z
        .string()
        .optional()
        .describe("Default OwnedAndOperatedAndSyndicatedSearch."),
      negative_keywords: z.array(z.string()).optional(),
      limit: COLLECTION_LIMIT,
    },
    handler: async (args) => {
      const scope = await ids(args);
      const keywords = (
        args.keywords as Array<{ text: string; match_type: string; max_cpc?: number }>
      ).map((k) => ({
        text: k.text,
        matchType: k.match_type,
        ...(k.max_cpc !== undefined ? { maxCpc: k.max_cpc } : {}),
      }));

      const estimates = await ai.getKeywordTrafficEstimates(scope, {
        keywords,
        ...(args.max_cpc !== undefined ? { maxCpc: Number(args.max_cpc) } : {}),
        ...(args.daily_budget !== undefined
          ? { dailyBudget: Number(args.daily_budget) }
          : {}),
        locationIds: (args.location_ids as number[]).map(Number),
        ...(args.language ? { language: String(args.language) } : {}),
        ...(args.network ? { network: String(args.network) } : {}),
        ...(Array.isArray(args.negative_keywords)
          ? { negativeKeywords: args.negative_keywords.map(String) }
          : {}),
      });
      return collectionEnvelope("campaign_estimates", estimates, {
        limit: Number(args.limit ?? DEFAULT_COLLECTION_LIMIT),
      });
    },
  });

  defineRead(server, {
    name: "suggest_keywords_for_url",
    title: "Keyword suggestions from a URL",
    priority: 0.7,
    description:
      "Suggest keywords by reading the content of a web page. Returns at most 200, without volume or bid data.\n\n" +
      "get_keyword_ideas also accepts a url and returns richer data (volume, competition, suggested bids), so prefer it when you need numbers. This operation uses a different signal and surfaces terms drawn more literally from the page copy, so it is worth running alongside when building a starter set from a landing page.\n\n" +
      SANDBOX_NOTE,
    inputSchema: {
      ...ACCOUNT_ARGS,
      url: z.string().describe("Page to derive keywords from."),
      max_keywords: z.number().int().min(1).max(200).optional().describe("Default 200."),
      language: z.string().optional(),
    },
    handler: async (args) => {
      const scope = await ids(args);
      const keywords = await ai.suggestKeywordsForUrl(
        scope,
        String(args.url),
        Number(args.max_keywords ?? DEFAULT_COLLECTION_LIMIT),
        args.language ? String(args.language) : undefined,
      );
      return {
        url: String(args.url),
        ...collectionEnvelope("keywords", keywords, {
          limit: Number(args.max_keywords ?? DEFAULT_COLLECTION_LIMIT),
        }),
      };
    },
  });

  defineRead(server, {
    name: "get_historical_search_count",
    title: "Historical search volume",
    priority: 0.7,
    description:
      "Historical search volume for specific terms over time, independent of any campaign. Up to 1,000 keywords per call. " +
      "Use this to judge seasonality and trend before committing budget.\n\n" +
      SANDBOX_NOTE,
    inputSchema: {
      ...ACCOUNT_ARGS,
      keywords: z.array(z.string()).min(1).max(1000).describe("Terms to look up."),
      start_date: z.string().optional().describe("YYYY-MM-DD."),
      end_date: z.string().optional().describe("YYYY-MM-DD."),
      time_period_rollup: z
        .enum(["Hourly", "Daily", "Weekly", "Monthly"])
        .optional()
        .describe("Default Monthly."),
      language: z.string().optional(),
      network: z.string().optional(),
      limit: COLLECTION_LIMIT,
    },
    handler: async (args) => {
      const scope = await ids(args);
      const counts = await ai.getHistoricalSearchCount(
        scope,
        (args.keywords as string[]).map(String),
        {
          ...(args.start_date ? { startDate: toMsDate(String(args.start_date)) } : {}),
          ...(args.end_date ? { endDate: toMsDate(String(args.end_date)) } : {}),
          ...(args.time_period_rollup
            ? { timePeriodRollup: String(args.time_period_rollup) }
            : {}),
          ...(args.language ? { language: String(args.language) } : {}),
          ...(args.network ? { network: String(args.network) } : {}),
        },
      );
      return collectionEnvelope("search_counts", counts, {
        limit: Number(args.limit ?? DEFAULT_COLLECTION_LIMIT),
      });
    },
  });

  defineRead(server, {
    name: "get_bid_landscape",
    title: "Bid landscape",
    priority: 0.7,
    description:
      "For existing keywords, show estimated clicks, impressions, and cost across a range of bids — the data behind 'what would happen if I bid more'. " +
      "Takes keyword ids from list_keywords, up to 1,000 per call.\n\n" +
      SANDBOX_NOTE,
    inputSchema: {
      ...ACCOUNT_ARGS,
      keyword_ids: z.array(z.string()).min(1).max(1000).describe("Keyword ids."),
      include_current_bid: z.boolean().optional().describe("Default true."),
      limit: COLLECTION_LIMIT,
    },
    handler: async (args) => {
      const scope = await ids(args);
      const landscape = await ai.getBidLandscape(
        scope,
        (args.keyword_ids as string[]).map(String),
        args.include_current_bid !== false,
      );
      return collectionEnvelope("bid_landscape", landscape, {
        limit: Number(args.limit ?? DEFAULT_COLLECTION_LIMIT),
      });
    },
  });

  defineRead(server, {
    name: "get_auction_insights",
    title: "Auction insights",
    priority: 0.75,
    description:
      "Competitive auction data: who else shows up in the same auctions, their impression share, overlap rate, and position-above rate. " +
      "Scope it to accounts, campaigns, ad groups, or keywords with entity_type, up to 200 entity ids.",
    inputSchema: {
      ...ACCOUNT_ARGS,
      entity_type: z
        .enum(["Account", "Campaign", "AdGroup", "Keyword"])
        .describe("What the entity ids refer to."),
      entity_ids: z.array(z.string()).min(1).max(200),
      start_date: z.string().describe("YYYY-MM-DD."),
      end_date: z.string().describe("YYYY-MM-DD."),
      limit: COLLECTION_LIMIT,
    },
    handler: async (args) => {
      const scope = await ids(args);
      const response = await ai.getAuctionInsight(
        scope,
        String(args.entity_type),
        (args.entity_ids as string[]).map(String),
        toMsDate(String(args.start_date)),
        toMsDate(String(args.end_date)),
      );
      const entries = Array.isArray(response.AuctionInsightEntries)
        ? (response.AuctionInsightEntries as Record<string, unknown>[])
        : [];
      const { AuctionInsightEntries: _entries, ...metadata } = response;
      return {
        ...metadata,
        ...collectionEnvelope("AuctionInsightEntries", entries, {
          limit: Number(args.limit ?? DEFAULT_COLLECTION_LIMIT),
        }),
      };
    },
  });
}
