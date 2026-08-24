import type { AccountIds } from "@/services/campaigns";
import { msadsFetch } from "@/services/msads-api";
import { MsAdsError } from "@/utils/errors";

/**
 * Ad Insight — Microsoft's keyword planner equivalent.
 *
 * Only one existing MCP server exposes any of this, which makes it one of the
 * clearer gaps worth filling: it is the only source of search volume, bid
 * estimates, and competition data in the whole API.
 *
 * Sandbox caveat: Microsoft's own docs recommend using production for Ad
 * Insight because sandbox responds to only a fixed handful of keywords and
 * returns stale volumes.
 */

/** Attributes `GetKeywordIdeas` can return. `Competition` is mandatory. */
export const IDEA_ATTRIBUTES = [
  "Keyword",
  "Competition",
  "MonthlySearchCounts",
  "SuggestedBid",
  "AdImpressionShare",
  "Relevance",
  "Source",
  "AdGroupId",
  "AdGroupName",
] as const;

export interface KeywordIdeasInput {
  /** Seed terms. Required unless expandIdeas is false and a URL is supplied. */
  queries?: string[];
  /** Seed URL — Microsoft reads the page to derive ideas. */
  url?: string;
  /** Ask for related ideas rather than only stats on the seeds. */
  expandIdeas?: boolean;
  /** Geographic location ids. Required by the API. */
  locationIds: number[];
  /** Language name, e.g. "English". Required by the API. */
  language: string;
  /** Ad network. Required by the API. */
  network?: string;
  attributes?: string[];
  /** Restrict to ideas within a search-volume band. */
  minSearchVolume?: number;
  maxSearchVolume?: number;
  /** Restrict to a competition band, 0.0–1.0. */
  minCompetition?: number;
  maxCompetition?: number;
  /** Exclude terms already present in the account. */
  excludeAccountKeywords?: boolean;
}

/**
 * Build the `SearchParameters` array.
 *
 * Three parameters are mandatory — language, location, and network — and the
 * request is rejected without any of them. That is easy to get wrong, so the
 * mandatory three are always emitted and the optional ones appended.
 */
export function buildSearchParameters(
  input: KeywordIdeasInput,
): Record<string, unknown>[] {
  const params: Record<string, unknown>[] = [
    {
      Type: "LanguageSearchParameter",
      Languages: [{ Language: input.language }],
    },
    {
      Type: "LocationSearchParameter",
      Locations: input.locationIds.map((id) => ({ LocationId: id })),
    },
    {
      Type: "NetworkSearchParameter",
      Network: { Network: input.network ?? "OwnedAndOperatedAndSyndicatedSearch" },
    },
  ];

  if (input.queries?.length) {
    params.push({ Type: "QuerySearchParameter", Queries: input.queries });
  }
  if (input.url) {
    params.push({ Type: "UrlSearchParameter", Url: input.url });
  }
  if (input.minSearchVolume !== undefined || input.maxSearchVolume !== undefined) {
    params.push({
      Type: "SearchVolumeSearchParameter",
      ...(input.minSearchVolume !== undefined ? { Minimum: input.minSearchVolume } : {}),
      ...(input.maxSearchVolume !== undefined ? { Maximum: input.maxSearchVolume } : {}),
    });
  }
  if (input.minCompetition !== undefined || input.maxCompetition !== undefined) {
    params.push({
      Type: "CompetitionSearchParameter",
      ...(input.minCompetition !== undefined ? { Minimum: input.minCompetition } : {}),
      ...(input.maxCompetition !== undefined ? { Maximum: input.maxCompetition } : {}),
    });
  }
  if (input.excludeAccountKeywords) {
    params.push({
      Type: "ExcludeAccountKeywordsSearchParameter",
      ExcludeAccountKeywords: true,
    });
  }
  return params;
}

export function validateKeywordIdeasInput(input: KeywordIdeasInput): void {
  if (!input.queries?.length && !input.url) {
    throw new MsAdsError({
      message:
        "Keyword ideas need a starting point: pass queries (seed terms) or url (a page to read ideas from).",
    });
  }
  if (!input.locationIds?.length) {
    throw new MsAdsError({
      message:
        "location_ids is required by the API. Use Microsoft's geographical location ids (e.g. 190 for the United States).",
    });
  }
  if (input.expandIdeas === false && !input.queries?.length) {
    throw new MsAdsError({
      message:
        "With expand_ideas false you must supply queries — there is nothing to look up.",
    });
  }
}

export async function getKeywordIdeas(
  ids: AccountIds,
  input: KeywordIdeasInput,
): Promise<Record<string, unknown>[]> {
  validateKeywordIdeasInput(input);
  // Copied: pushing onto input.attributes would mutate the caller's array.
  const attributes = [
    ...(input.attributes?.length
      ? input.attributes
      : ["Keyword", "Competition", "MonthlySearchCounts", "SuggestedBid"]),
  ];
  // `Competition` is required by the API even when the caller didn't ask.
  if (!attributes.includes("Competition")) attributes.push("Competition");

  const res = await msadsFetch<{ KeywordIdeas?: Record<string, unknown>[] }>(
    "AdInsight",
    "KeywordIdeas/Query",
    {
      body: {
        ExpandIdeas: input.expandIdeas ?? true,
        IdeaAttributes: attributes,
        SearchParameters: buildSearchParameters(input),
      },
      ...ids,
      retry: "safe",
    },
  );
  return res.KeywordIdeas ?? [];
}

export interface TrafficEstimateInput {
  keywords: Array<{ text: string; matchType: string; maxCpc?: number }>;
  locationIds?: number[];
  language?: string;
  network?: string;
  dailyBudget?: number;
  maxCpc?: number;
  negativeKeywords?: string[];
}

/**
 * `GetKeywordTrafficEstimates` — projected clicks, impressions, and cost at a
 * given bid. The request nests campaign → ad group → keyword estimators even
 * for a bare keyword list, so the nesting is assembled here.
 */
export async function getKeywordTrafficEstimates(
  ids: AccountIds,
  input: TrafficEstimateInput,
): Promise<Record<string, unknown>[]> {
  if (!input.keywords?.length) {
    throw new MsAdsError({ message: "At least one keyword is required." });
  }

  // All three criteria are mandatory, though Microsoft documents them as
  // optional: omitting location fails with 804, language with 806, network
  // with 805. Location has no defensible default — an estimate for the wrong
  // country is wrong, not approximate — so it is required of the caller.
  if (!input.locationIds?.length) {
    throw new MsAdsError({
      message:
        "At least one location_id is required to estimate traffic. Use get_targeting_id_file with file=geo_locations to look ids up.",
    });
  }
  const criteria: Record<string, unknown>[] = [];
  for (const id of input.locationIds) {
    criteria.push({ Type: "LocationCriterion", LocationId: id });
  }
  criteria.push({
    Type: "LanguageCriterion",
    Language: input.language ?? "English",
  });
  // The ad group estimator's MaxCpc is mandatory (error 809), so fall back to
  // the highest per-keyword bid. An estimate is a projection AT a bid; without
  // one there is nothing to project, so say so rather than let the API answer
  // with an undifferentiated validation failure.
  const keywordBids = input.keywords
    .map((k) => k.maxCpc)
    .filter((b): b is number => typeof b === "number");
  const adGroupMaxCpc =
    input.maxCpc ?? (keywordBids.length ? Math.max(...keywordBids) : undefined);
  if (adGroupMaxCpc === undefined) {
    throw new MsAdsError({
      message:
        "A bid is required to estimate traffic. Set max_cpc, or give every keyword its own max_cpc.",
    });
  }

  // Not conditional: the API rejects the request with error 805 unless exactly
  // one NetworkCriterion is present, even though every other criterion is
  // optional. Microsoft documents it as optional.
  criteria.push({
    Type: "NetworkCriterion",
    Network: input.network ?? "OwnedAndOperatedAndSyndicatedSearch",
  });

  const res = await msadsFetch<{ CampaignEstimates?: Record<string, unknown>[] }>(
    "AdInsight",
    "KeywordTrafficEstimates/Query",
    {
      body: {
        CampaignEstimators: [
          {
            CampaignId: null,
            ...(input.dailyBudget !== undefined
              ? { DailyBudget: input.dailyBudget }
              : {}),
            ...(criteria.length ? { Criteria: criteria } : {}),
            ...(input.negativeKeywords?.length
              ? {
                  NegativeKeywords: input.negativeKeywords.map((t) => ({
                    Text: t,
                    MatchType: "Exact",
                  })),
                }
              : {}),
            AdGroupEstimators: [
              {
                AdGroupId: null,
                MaxCpc: adGroupMaxCpc,
                KeywordEstimators: input.keywords.map((k) => ({
                  Keyword: { Text: k.text, MatchType: k.matchType },
                  ...(k.maxCpc !== undefined ? { MaxCpc: k.maxCpc } : {}),
                })),
              },
            ],
          },
        ],
      },
      ...ids,
      retry: "safe",
    },
  );
  return res.CampaignEstimates ?? [];
}

/** `SuggestKeywordsForUrl` — note the resource is `KeywordSuggestions`. */
export async function suggestKeywordsForUrl(
  ids: AccountIds,
  url: string,
  maxKeywords = 50,
  language?: string,
): Promise<Record<string, unknown>[]> {
  const res = await msadsFetch<{ Keywords?: Record<string, unknown>[] }>(
    "AdInsight",
    "KeywordSuggestions/QueryByUrl",
    {
      body: {
        Url: url,
        MaxKeywords: Math.min(maxKeywords, 200),
        ...(language ? { Language: language } : {}),
      },
      ...ids,
      retry: "safe",
    },
  );
  return res.Keywords ?? [];
}

/** `GetHistoricalSearchCount` — search volume for the normalized term. */
/**
 * Both ends of the range are mandatory — omitting either fails with
 * KspStartDateNull or KspEndDateNull. Defaults to a trailing twelve months,
 * which is what a caller asking for search volume almost always wants.
 */
function defaultSearchCountRange(): {
  start: { Day: number; Month: number; Year: number };
  end: { Day: number; Month: number; Year: number };
} {
  const now = new Date();
  const start = new Date(now);
  start.setUTCMonth(start.getUTCMonth() - 12);
  const asDate = (d: Date) => ({
    Day: 1,
    Month: d.getUTCMonth() + 1,
    Year: d.getUTCFullYear(),
  });
  return { start: asDate(start), end: asDate(now) };
}

export async function getHistoricalSearchCount(
  ids: AccountIds,
  keywords: string[],
  input: {
    /** ISO country codes, e.g. ["US"] — not the numeric location ids. */
    publisherCountries?: string[];
    language?: string;
    network?: string;
    startDate?: { Day: number; Month: number; Year: number };
    endDate?: { Day: number; Month: number; Year: number };
    timePeriodRollup?: string;
  } = {},
): Promise<Record<string, unknown>[]> {
  if (keywords.length > 1000) {
    throw new MsAdsError({
      message: `Too many keywords: ${keywords.length}. The API accepts at most 1000 per call.`,
    });
  }
  const res = await msadsFetch<{
    KeywordHistoricalSearchCounts?: Record<string, unknown>[];
  }>("AdInsight", "HistoricalSearchCount/Query", {
    body: {
      Keywords: keywords,
      TimePeriodRollup: input.timePeriodRollup ?? "Monthly",
      // Language is mandatory (error 3412 InvalidLanguage without it) and wants
      // the full name — "en" is rejected where "English" is accepted.
      Language: input.language ?? "English",
      ...(input.network ? { Network: input.network } : {}),
      ...(input.publisherCountries?.length
        ? { PublisherCountries: input.publisherCountries }
        : {}),
      // A start date is mandatory too (error KspStartDateNull). Default to a
      // trailing twelve months, which is what a caller asking for search volume
      // almost always wants.
      StartDate: input.startDate ?? defaultSearchCountRange().start,
      EndDate: input.endDate ?? defaultSearchCountRange().end,
    },
    ...ids,
    retry: "safe",
  });
  return res.KeywordHistoricalSearchCounts ?? [];
}

/** `GetBidLandscapeByKeywordIds` — estimated stats at a range of bids. */
export async function getBidLandscape(
  ids: AccountIds,
  keywordIds: string[],
  includeCurrentBid = true,
): Promise<Record<string, unknown>[]> {
  if (keywordIds.length > 1000) {
    throw new MsAdsError({
      message: `Too many keyword ids: ${keywordIds.length}. The API accepts at most 1000 per call.`,
    });
  }
  const res = await msadsFetch<{ BidLandscape?: Record<string, unknown>[] }>(
    "AdInsight",
    "BidLandscape/QueryByKeywordIds",
    {
      body: { KeywordIds: keywordIds, IncludeCurrentBid: includeCurrentBid },
      ...ids,
      retry: "safe",
    },
  );
  return res.BidLandscape ?? [];
}

/** `GetAuctionInsightData` — who else is competing in your auctions. */
export async function getAuctionInsight(
  ids: AccountIds,
  entityType: string,
  entityIds: string[],
  startDate: { Day: number; Month: number; Year: number },
  endDate: { Day: number; Month: number; Year: number },
): Promise<Record<string, unknown>> {
  if (entityIds.length > 200) {
    throw new MsAdsError({
      message: `Too many entity ids: ${entityIds.length}. Auction insight accepts at most 200 per call.`,
    });
  }
  // The date range travels inside SearchParameters, not at the top level.
  // Top-level StartDate/EndDate are ignored and the call fails with error 813
  // ("SearchParameters array is null or missing"), then 815 naming the
  // parameter it wants. Verified against the live API on 2026-08-21.
  return msadsFetch<Record<string, unknown>>("AdInsight", "AuctionInsightData/Query", {
    body: {
      EntityType: entityType,
      ...(entityIds.length ? { EntityIds: entityIds } : {}),
      SearchParameters: [
        { Type: "DateRangeSearchParameter", StartDate: startDate, EndDate: endDate },
      ],
    },
    ...ids,
    retry: "safe",
  });
}
