import { MsAdsError } from "@/utils/errors";

/**
 * Registry of Microsoft Advertising report types.
 *
 * Each report request is a *derived* type — passing the base `ReportRequest`
 * fails — and each derived type accepts exactly one of four scope shapes. The
 * scope kind is not discoverable at runtime, so it is recorded here; getting it
 * wrong produces an opaque validation error.
 *
 * Aggregation support is expressed as retention in Microsoft's docs
 * ("Not Applicable" = unsupported), so `noAggregation` marks the seven report
 * types that have no Aggregation element at all.
 */

export type ScopeKind = "account" | "campaign" | "adgroup" | "assetgroup";

export interface ReportTypeSpec {
  /** The `Type` discriminator sent in the JSON body. */
  requestType: string;
  scope: ScopeKind;
  description: string;
  /** True when the type has no Aggregation element. */
  noAggregation?: boolean;
  /** True when the type has no Time element. */
  noTime?: boolean;
  /**
   * True when the column enum has no `TimePeriod` value. Those reports use
   * their own time columns (CallDetail uses StartTime/EndTime), so the
   * TimePeriod auto-add must be skipped or the request is rejected outright.
   */
  noTimePeriodColumn?: boolean;
  /** Sensible starting columns — every report needs ≥1 attribute and ≥1 metric. */
  defaultColumns: string[];
}

/**
 * Keyed by the short name exposed to callers. Short names are stable and
 * lowercase so a model does not have to remember Microsoft's suffix.
 */
export const REPORT_TYPES: Record<string, ReportTypeSpec> = {
  account_performance: {
    requestType: "AccountPerformanceReportRequest",
    scope: "account",
    description: "Account-level performance and trends, including impression share.",
    defaultColumns: [
      "TimePeriod",
      "AccountName",
      "AccountId",
      "Impressions",
      "Clicks",
      "Spend",
      "Ctr",
      "AverageCpc",
      "ConversionsQualified",
    ],
  },
  campaign_performance: {
    requestType: "CampaignPerformanceReportRequest",
    scope: "campaign",
    description: "Campaign-level delivery, cost, conversions, and impression share.",
    defaultColumns: [
      "TimePeriod",
      "CampaignName",
      "CampaignId",
      "CampaignStatus",
      "Impressions",
      "Clicks",
      "Spend",
      "Ctr",
      "AverageCpc",
      "ConversionsQualified",
      "Revenue",
    ],
  },
  ad_group_performance: {
    requestType: "AdGroupPerformanceReportRequest",
    scope: "adgroup",
    description: "Ad group–level delivery stats and impression share.",
    defaultColumns: [
      "TimePeriod",
      "CampaignName",
      "AdGroupName",
      "AdGroupId",
      "Impressions",
      "Clicks",
      "Spend",
      "Ctr",
      "AverageCpc",
      "ConversionsQualified",
    ],
  },
  ad_performance: {
    requestType: "AdPerformanceReportRequest",
    scope: "adgroup",
    description: "Per-ad performance including ad copy fields and ad strength.",
    defaultColumns: [
      "TimePeriod",
      "CampaignName",
      "AdGroupName",
      "AdId",
      "AdTitle",
      "AdType",
      "Impressions",
      "Clicks",
      "Spend",
      "ConversionsQualified",
    ],
  },
  keyword_performance: {
    requestType: "KeywordPerformanceReportRequest",
    scope: "adgroup",
    description:
      "Keyword-level performance plus quality score. Not valid for Shopping campaigns.",
    defaultColumns: [
      "TimePeriod",
      "CampaignName",
      "AdGroupName",
      "Keyword",
      "KeywordId",
      "DeliveredMatchType",
      "Impressions",
      "Clicks",
      "Spend",
      "QualityScore",
      "ConversionsQualified",
    ],
  },
  search_query_performance: {
    requestType: "SearchQueryPerformanceReportRequest",
    scope: "adgroup",
    description:
      "Actual search terms that triggered ads. Only terms with meaningful click volume in the last 30 days appear. Hourly retention is just 1 month.",
    defaultColumns: [
      "TimePeriod",
      "CampaignName",
      "AdGroupName",
      "SearchQuery",
      "Keyword",
      "DeliveredMatchType",
      "Impressions",
      "Clicks",
      "Spend",
      "ConversionsQualified",
    ],
  },
  geographic_performance: {
    requestType: "GeographicPerformanceReportRequest",
    scope: "adgroup",
    description:
      "Performance by country, state, city, or metro. Hourly retention is 14 days.",
    defaultColumns: [
      "TimePeriod",
      "AccountName",
      "Country",
      "State",
      "City",
      "Impressions",
      "Clicks",
      "Spend",
      "ConversionsQualified",
    ],
  },
  user_location_performance: {
    requestType: "UserLocationPerformanceReportRequest",
    scope: "adgroup",
    description:
      "Physical location of the user alongside the location their query was about. Hourly retention is 14 days.",
    defaultColumns: [
      "TimePeriod",
      "AccountName",
      "Country",
      "State",
      "City",
      "Impressions",
      "Clicks",
      "Spend",
    ],
  },
  age_gender_audience: {
    requestType: "AgeGenderAudienceReportRequest",
    scope: "adgroup",
    description: "Performance split by age bracket and gender.",
    defaultColumns: [
      "TimePeriod",
      "CampaignName",
      "AdGroupName",
      "AgeGroup",
      "Gender",
      "Impressions",
      "Clicks",
      "Spend",
      "ConversionsQualified",
    ],
  },
  conversion_performance: {
    requestType: "ConversionPerformanceReportRequest",
    scope: "adgroup",
    description: "Conversions, assists, revenue, and revenue per conversion by goal.",
    defaultColumns: [
      "TimePeriod",
      "CampaignName",
      "Goal",
      "GoalType",
      "ConversionsQualified",
      "Revenue",
      "Assists",
      "ReturnOnAdSpend",
    ],
  },
  goals_and_funnels: {
    requestType: "GoalsAndFunnelsReportRequest",
    scope: "adgroup",
    description: "Conversion funnel steps by goal. Hourly retention is 1 month.",
    defaultColumns: [
      // No impression, click, or spend metrics exist in this enum.
      "TimePeriod",
      "Goal",
      "GoalId",
      "GoalType",
      "CampaignName",
      "AllConversionsQualified",
      "AllRevenue",
      "Assists",
    ],
  },
  destination_url_performance: {
    requestType: "DestinationUrlPerformanceReportRequest",
    scope: "adgroup",
    description: "Landing page (destination URL) performance.",
    defaultColumns: [
      "TimePeriod",
      "CampaignName",
      "DestinationUrl",
      "Impressions",
      "Clicks",
      "Spend",
      "ConversionsQualified",
    ],
  },
  share_of_voice: {
    requestType: "ShareOfVoiceReportRequest",
    scope: "adgroup",
    description:
      "Impression share and share lost to budget or rank, per keyword. No hourly aggregation; 6-month retention.",
    defaultColumns: [
      "TimePeriod",
      "CampaignName",
      "AdGroupName",
      "Keyword",
      // KeywordId is required, and impression-share columns do not satisfy the
      // "at least one measure" rule — hence Impressions/Clicks/Spend.
      "KeywordId",
      "Impressions",
      "Clicks",
      "Spend",
      "ImpressionSharePercent",
      "ImpressionLostToBudgetPercent",
      "ImpressionLostToRankAggPercent",
    ],
  },
  budget_summary: {
    requestType: "BudgetSummaryReportRequest",
    scope: "campaign",
    description:
      "Monthly budget, spend to date, and whether spend is on target. Daily aggregation only, 24-month retention.",
    noAggregation: true,
    defaultColumns: [
      "AccountName",
      "CampaignName",
      "MonthlyBudget",
      "DailySpend",
      "MonthToDateSpend",
    ],
  },
  campaign_change_history: {
    requestType: "SearchCampaignChangeHistoryReportRequest",
    scope: "campaign",
    description: "Who changed what and when, with old and new values. 6-month retention.",
    noAggregation: true,
    defaultColumns: [
      "DateTime",
      "CampaignName",
      "ChangedBy",
      "ItemChanged",
      "AttributeChanged",
      "HowChanged",
      "OldValue",
      "NewValue",
    ],
  },
  negative_keyword_conflicts: {
    requestType: "NegativeKeywordConflictReportRequest",
    scope: "adgroup",
    description:
      "Keywords blocked by your own negative keywords. A snapshot of current settings — no time range, no aggregation, no history.",
    noAggregation: true,
    noTime: true,
    defaultColumns: [
      "AccountName",
      "CampaignName",
      "AdGroupName",
      "Keyword",
      "NegativeKeyword",
      "ConflictLevel",
    ],
  },
  product_partition_performance: {
    requestType: "ProductPartitionPerformanceReportRequest",
    scope: "adgroup",
    description: "Shopping performance by product group and partition type.",
    defaultColumns: [
      "TimePeriod",
      "CampaignName",
      "AdGroupName",
      // PartitionType is required; ProductGroup alone is not enough.
      "PartitionType",
      "ProductGroup",
      "Impressions",
      "Clicks",
      "Spend",
      "ConversionsQualified",
    ],
  },
  product_search_query_performance: {
    requestType: "ProductSearchQueryPerformanceReportRequest",
    scope: "adgroup",
    description: "Search terms for Shopping campaigns. Hourly retention is 1 month.",
    defaultColumns: [
      "TimePeriod",
      // AccountName is required.
      "AccountName",
      "CampaignName",
      "AdGroupName",
      "SearchQuery",
      "Impressions",
      "Clicks",
      "Spend",
      "ConversionsQualified",
    ],
  },
  asset_group_performance: {
    requestType: "AssetGroupPerformanceReportRequest",
    scope: "assetgroup",
    description: "Performance Max asset group performance.",
    defaultColumns: [
      "TimePeriod",
      "CampaignName",
      "AssetGroupName",
      "Impressions",
      "Clicks",
      "Spend",
      // This enum has no *Qualified variants at all.
      "Conversions",
    ],
  },
  asset_performance: {
    requestType: "AssetPerformanceReportRequest",
    scope: "adgroup",
    description: "Per-asset performance. Only 30 days of data are retained.",
    defaultColumns: [
      "TimePeriod",
      "CampaignName",
      // AdGroupId is REQUIRED — undocumented; the reference page lists no
      // required columns, but the API rejects the request without it. Found by
      // bisecting against the live API. Note the documented side effect: naming
      // an ad group filters out Performance Max and App asset-group data.
      "AdGroupId",
      "AdGroupName",
      "AssetId",
      "AssetContent",
      "AssetType",
      "AssetSource",
      "Impressions",
      "Clicks",
      "Spend",
      // No *Qualified variant in this enum.
      "Conversions",
    ],
  },
  professional_demographics: {
    requestType: "ProfessionalDemographicsAudienceReportRequest",
    scope: "adgroup",
    description:
      "LinkedIn-derived performance by company, industry, and job function. Unique to Microsoft Advertising.",
    defaultColumns: [
      "TimePeriod",
      "AccountName",
      "CampaignName",
      "AdGroupName",
      "CompanyName",
      // Named *Name here, unlike the ProfileCriterion types.
      "IndustryName",
      "JobFunctionName",
      "Impressions",
      "Clicks",
      "Spend",
      "ConversionsQualified",
    ],
  },
  audience_performance: {
    requestType: "AudiencePerformanceReportRequest",
    scope: "adgroup",
    description: "Performance by audience and association status.",
    defaultColumns: [
      "TimePeriod",
      "CampaignName",
      "AdGroupName",
      // AudienceId is required; AudienceName alone is not enough.
      "AudienceId",
      "AudienceName",
      "AudienceType",
      "Impressions",
      "Clicks",
      "Spend",
      "ConversionsQualified",
    ],
  },
  ad_extension_by_ad: {
    requestType: "AdExtensionByAdReportRequest",
    scope: "adgroup",
    description: "Ad extension performance broken out per ad.",
    defaultColumns: [
      "TimePeriod",
      "CampaignName",
      "AdId",
      "AdExtensionType",
      "Impressions",
      "Clicks",
      "Spend",
    ],
  },
  ad_extension_detail: {
    requestType: "AdExtensionDetailReportRequest",
    scope: "adgroup",
    description: "Effectiveness of individual extension items, e.g. each sitelink.",
    defaultColumns: [
      "TimePeriod",
      "CampaignName",
      // AdExtensionId and AdExtensionTypeId are required.
      "AdExtensionId",
      "AdExtensionTypeId",
      "AdExtensionType",
      "AdExtensionPropertyValue",
      "Impressions",
      "Clicks",
      "Spend",
      "ConversionsQualified",
    ],
  },
  call_detail: {
    requestType: "CallDetailReportRequest",
    scope: "adgroup",
    noTimePeriodColumn: true,
    description: "Forwarded call duration and phone spend. 6-month retention.",
    defaultColumns: [
      // No TimePeriod in this enum; StartTime/EndTime carry the time dimension.
      // Duration, StartTime, and EndTime are all required.
      "CampaignName",
      "AdGroupName",
      "StartTime",
      "EndTime",
      "Duration",
      "AreaCode",
      "City",
      "State",
    ],
  },
  dsa_search_query: {
    requestType: "DSASearchQueryPerformanceReportRequest",
    scope: "adgroup",
    description:
      "Search terms that triggered dynamic search ads. Hourly retention is 1 month.",
    defaultColumns: [
      "TimePeriod",
      "CampaignName",
      "AdGroupName",
      "SearchQuery",
      "Headline",
      "Impressions",
      "Clicks",
      "Spend",
    ],
  },
  publisher_usage_performance: {
    requestType: "PublisherUsagePerformanceReportRequest",
    scope: "adgroup",
    description:
      "Performance per publisher website, for building exclusion lists. Hourly retention is 2 months.",
    defaultColumns: [
      "TimePeriod",
      "CampaignName",
      "PublisherUrl",
      "Impressions",
      "Clicks",
      "Spend",
    ],
  },
  bid_strategy: {
    requestType: "BidStrategyReportRequest",
    scope: "campaign",
    description: "Portfolio bid strategy performance across its campaigns.",
    defaultColumns: [
      "TimePeriod",
      "CampaignName",
      // Not "BidStrategyName" — the enum names it Portfolio*.
      "PortfolioBidStrategyName",
      "BidStrategyType",
      "Impressions",
      "Clicks",
      "Spend",
      "ConversionsQualified",
    ],
  },
};

export const REPORT_TYPE_NAMES = Object.keys(REPORT_TYPES).sort();

export function getReportType(name: string): ReportTypeSpec {
  const spec = REPORT_TYPES[name];
  if (!spec) {
    throw new MsAdsError({
      message: `Unknown report type "${name}". Available: ${REPORT_TYPE_NAMES.join(", ")}`,
    });
  }
  return spec;
}

/** The 9 aggregation values. `WeeklyStartingMonday` is easy to miss. */
export const AGGREGATIONS = [
  "Summary",
  "Hourly",
  "Daily",
  "Weekly",
  "WeeklyStartingMonday",
  "Monthly",
  "Yearly",
  "HourOfDay",
  "DayOfWeek",
] as const;

/** The 17 predefined time periods. */
export const PREDEFINED_TIMES = [
  "Today",
  "Yesterday",
  "LastSevenDays",
  "ThisWeek",
  "LastWeek",
  "Last14Days",
  "Last30Days",
  "LastFourWeeks",
  "ThisMonth",
  "LastMonth",
  "LastThreeMonths",
  "LastSixMonths",
  "ThisYear",
  "LastYear",
  "ThisWeekStartingMonday",
  "LastWeekStartingMonday",
  "LastFourWeeksStartingMonday",
] as const;

export type Aggregation = (typeof AGGREGATIONS)[number];
export type PredefinedTime = (typeof PREDEFINED_TIMES)[number];
