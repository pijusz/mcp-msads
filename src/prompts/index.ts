import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * MCP prompts — multi-step workflows over the tools in this server.
 *
 * Each one exists because the sequence is not obvious from the tool list
 * alone: which report answers the question, which column is the deprecated
 * one, and what order the calls go in.
 */

function userPrompt(text: string) {
  return {
    messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
  };
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "account_audit",
    {
      title: "Audit an account",
      description:
        "Review an ad account end to end — structure, spend, delivery blockers, and wasted spend — and produce a prioritized list of findings.",
      argsSchema: {
        account_id: z
          .string()
          .optional()
          .describe("Ad account id. Defaults to the configured one."),
        days: z.string().optional().describe("Lookback window in days. Default 30."),
      },
    },
    ({ account_id, days }) => {
      const account = account_id ? `account ${account_id}` : "the configured account";
      const window = days ?? "30";
      return userPrompt(
        `Audit ${account} over the last ${window} days and report prioritized findings.

Work through this in order:

1. **Structure** — bulk_download with entities Campaigns, AdGroups, Keywords, Budgets to map the account in one call, rather than walking the list_* tools campaign by campaign.

2. **Performance** — run_report with report_type campaign_performance, aggregation Summary, over the window. Use ConversionsQualified, not Conversions: the latter was deprecated in 2022 and always returns 0.

3. **Delivery blockers** — for campaigns with low impression share, run share_of_voice and separate share lost to BUDGET from share lost to RANK. They call for opposite responses: budget for the first, bids or quality for the second. Also check list_insertion_orders — an exhausted or expired insertion order stops delivery regardless of campaign budgets.

4. **Wasted spend** — run_report with search_query_performance. Look for search terms with meaningful spend and zero ConversionsQualified. Also run negative_keyword_conflicts, which finds keywords blocked by your own negative keywords.

5. **Quality** — keyword_performance with the QualityScore column. Scores of 1–5 are underperforming; "--" means not yet computed, not zero.

Report findings ordered by money at stake, and say what each one would cost or save. Where a fix is a specific API change, name the tool and arguments — but do not make any changes without being asked.`,
      );
    },
  );

  server.registerPrompt(
    "find_wasted_spend",
    {
      title: "Find wasted spend",
      description:
        "Identify search terms and keywords burning budget without converting, and draft the negative keywords to stop them.",
      argsSchema: {
        account_id: z.string().optional(),
        days: z.string().optional().describe("Lookback window in days. Default 30."),
        min_spend: z.string().optional().describe("Ignore terms below this spend."),
      },
    },
    ({ account_id, days, min_spend }) =>
      userPrompt(
        `Find wasted spend in ${account_id ? `account ${account_id}` : "the configured account"} over the last ${days ?? "30"} days.

1. run_report with search_query_performance, aggregation Summary, columns including SearchQuery, Keyword, DeliveredMatchType, Impressions, Clicks, Spend, ConversionsQualified.

2. Isolate terms with spend${min_spend ? ` above ${min_spend}` : ""} and zero ConversionsQualified. Weight by spend — a term burning a large share of budget with no conversions matters more than a long tail of small ones.

3. Group the offenders by theme. Individual negatives are rarely the answer; one well-chosen phrase negative usually covers a whole cluster.

4. Propose negative keywords with a match type for each, and say which level they belong at — ad group for narrow ones, campaign for broad ones, or a shared negative list if they apply account-wide.

5. Estimate the monthly saving from each group, based on observed spend.

Two cautions before recommending anything: a term with no conversions may still assist ones attributed elsewhere, so check the Assists column before calling it waste. And search query reports only include terms with meaningful click volume in the last 30 days, so this is not the complete picture.

Present the recommendations for review. Do not add negatives without being asked.`,
      ),
  );

  server.registerPrompt(
    "keyword_expansion",
    {
      title: "Expand keywords",
      description:
        "Research new keywords for a theme or landing page, size the opportunity, and draft what to add.",
      argsSchema: {
        seed: z.string().describe("Seed terms or a landing page URL."),
        account_id: z.string().optional(),
        location_ids: z
          .string()
          .optional()
          .describe(
            "Comma-separated Microsoft location ids. Default 190 (United States).",
          ),
      },
    },
    ({ seed, account_id, location_ids }) =>
      userPrompt(
        `Research keyword expansion opportunities from: ${seed}${
          account_id ? ` (account ${account_id})` : ""
        }

1. get_keyword_ideas with these seeds and location_ids ${location_ids ?? "190"}. If the seed is a URL, pass it as \`url\` and also try suggest_keywords_for_url — they use different signals and surface different terms.

2. Filter out terms already in the account. Set exclude_account_keywords true, and cross-check against list_keywords for the relevant ad groups.

3. get_keyword_traffic_estimates for the survivors, at a bid in line with what the account already pays. Estimates come back as minimum/maximum pairs — quote the range, not a single number.

4. Rank by expected value, not by search volume. High volume with high competition and a suggested bid above the account's current CPA is a bad trade.

5. Propose the additions with a match type each and the ad group they belong in. Prefer Exact and Phrase for terms with clear intent; Broad only where the theme is genuinely wide. Note that v13 has no broad match modifier.

Also flag terms worth adding as NEGATIVES — ideas that clearly signal the wrong intent are as useful as the ones to buy.

Present for review. Do not create keywords without being asked; if asked, create them Paused.`,
      ),
  );

  server.registerPrompt(
    "budget_pacing",
    {
      title: "Check budget pacing",
      description:
        "Compare billed spend against budgets and delivery to see what is under-, over-, or budget-capped.",
      argsSchema: {
        account_id: z.string().optional(),
      },
    },
    ({ account_id }) =>
      userPrompt(
        `Check budget pacing for ${account_id ? `account ${account_id}` : "the configured account"}.

1. get_monthly_spend for the current and previous month. This is the BILLED figure — it differs from report Spend, which shows delivery before invalid-traffic credits and adjustments. Use billing for money questions.

2. run_report with budget_summary (daily aggregation only, 24-month retention) for budget versus spend-to-date, and campaign_performance for delivery.

3. list_budgets to see which campaigns share a budget. A shared budget exhausted by one campaign starves every campaign attached to it, which looks like a targeting problem and is not.

4. run_report with share_of_voice to find campaigns losing impression share to BUDGET specifically. Those are the ones where more budget converts directly into more volume.

5. list_insertion_orders — an insertion order nearing its end date or its cap will halt delivery regardless of healthy campaign budgets.

Report: which campaigns are budget-constrained and what raising them would buy, which are underspending and why, and any risk of exhausting the account before month end. Recommend changes; do not apply them without being asked.`,
      ),
  );

  server.registerPrompt(
    "google_ads_comparison",
    {
      title: "Compare against Google Ads",
      description:
        "Compare Microsoft Advertising performance against Google Ads for the same period. Needs a Google Ads MCP server connected alongside this one.",
      argsSchema: {
        days: z.string().optional().describe("Lookback window in days. Default 30."),
      },
    },
    ({ days }) =>
      userPrompt(
        `Compare Microsoft Advertising and Google Ads performance over the last ${days ?? "30"} days.

This needs a Google Ads MCP server connected as well as this one. If none is available, say so rather than reporting Microsoft figures alone as a comparison.

1. From Microsoft: run_report with campaign_performance, aggregation Summary. Use ConversionsQualified for conversions.

2. From Google Ads: the equivalent campaign performance for the same dates.

3. Normalize before comparing. Cost is in micros on Google and in currency units here. Confirm both accounts use the same currency; if not, convert and say what rate you used. Match the date ranges exactly — a time-zone difference of one day distorts a short window badly.

4. Compare on CPC, CTR, conversion rate, CPA, and ROAS. Microsoft typically shows lower volume at lower CPC; the question worth answering is whether the CPA is better, not whether the volume is larger.

5. Look for themes present on one platform and absent on the other. Where Google performs well on a theme Microsoft is not covering, that is the clearest expansion opportunity — and the Google Ads import feature can bring those campaigns across directly.

Report a side-by-side table plus specific recommendations. State every assumption you made to make the numbers comparable.`,
      ),
  );
}
