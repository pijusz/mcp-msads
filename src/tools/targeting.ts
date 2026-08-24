import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as tg from "@/services/targeting";
import { ACCOUNT_ARGS, ids, WRITE } from "@/tools/_shared";
import {
  COLLECTION_LIMIT,
  collectionEnvelope,
  DEFAULT_COLLECTION_LIMIT,
  MAX_COLLECTION_LIMIT,
} from "@/utils/collection";
import { defineRead } from "@/utils/define-read";
import { destructiveTool, writeTool } from "@/utils/register-tool";
import { run } from "@/utils/tool-response";

const LEVEL = z
  .enum(["campaign", "adgroup"])
  .describe("Which level the criterions belong to.");

const CRITERION_EXAMPLES = `Criterion shapes (the nested Criterion object carries its own Type):
- Age:      { "Criterion": { "Type": "AgeCriterion", "AgeRange": "TwentyFiveToThirtyFour" } }
- Gender:   { "Criterion": { "Type": "GenderCriterion", "GenderType": "Female" } }
- Device:   { "Criterion": { "Type": "DeviceCriterion", "DeviceName": "Smartphones" } }
- Location: { "Criterion": { "Type": "LocationCriterion", "LocationId": 190 } }
- Schedule: { "Criterion": { "Type": "DayTimeCriterion", "Day": "Monday", "FromHour": 9, "FromMinute": "Zero", "ToHour": 17, "ToMinute": "Zero" } }
- Audience: { "Criterion": { "Type": "AudienceCriterion", "AudienceId": "123", "AudienceType": "RemarketingList" } }
- LinkedIn: { "Criterion": { "Type": "ProfileCriterion", "ProfileId": 456, "ProfileType": "Industry" } }

Wrap each in { "Type": "BiddableAdGroupCriterion" | "NegativeAdGroupCriterion", ... } (or the Campaign equivalents). A biddable criterion may carry { "CriterionBid": { "Type": "BidMultiplier", "Multiplier": 20 } } to bid 20% higher for that segment.`;

export function registerTargetingTools(server: McpServer): void {
  defineRead(server, {
    name: "list_targeting",
    title: "Targeting criterions",
    priority: 0.8,
    description:
      "Read targeting criterions on a campaign or ad group — age, gender, device, location, ad schedule, audiences, or LinkedIn profile targeting.\n\n" +
      "Reads use the SPECIFIC criterion type (Age, Device, RemarketingList, …), unlike writes which use an umbrella type. Pass the specific one here.",
    inputSchema: {
      ...ACCOUNT_ARGS,
      level: LEVEL,
      criterion_type: z
        .string()
        .describe(
          "Specific type to read: Age, Gender, Device, DayTime, Location, LocationIntent, Radius, CompanyName, Industry, JobFunction, RemarketingList, CustomAudience, InMarketAudience, Placement, Topic.",
        ),
      criterion_ids: z
        .array(z.string())
        .max(MAX_COLLECTION_LIMIT)
        .optional()
        .describe("Specific ids; omit for all."),
      limit: COLLECTION_LIMIT,
    },
    handler: async (args) => {
      const scope = await ids(args);
      const criterions = await tg.getCriterions(
        scope,
        args.level as tg.CriterionLevel,
        Array.isArray(args.criterion_ids) ? args.criterion_ids.map(String) : null,
        String(args.criterion_type),
      );
      return collectionEnvelope("criterions", criterions, {
        limit: Number(args.limit ?? DEFAULT_COLLECTION_LIMIT),
      });
    },
  });

  writeTool(
    server,
    "add_targeting",
    `${WRITE}Add targeting criterions to a campaign or ad group.

You do NOT need to supply a CriterionType — it is derived from the criterions themselves. The API uses an umbrella type on writes ("Targets" for demographics/location/device/schedule, "Audience" for audiences) but the specific type on reads, and mixing the two families in one call is rejected. That is handled for you; a mixed batch is refused up front with an explanation.

${CRITERION_EXAMPLES}

Device targeting must include all three of Computers, Smartphones, and Tablets in one call — the API accepts a partial set and then applies none of it, so a partial set is rejected here instead.

Day/time criterion fields cannot be edited after creation; to change a schedule, delete and re-add.`,
    {
      ...ACCOUNT_ARGS,
      level: LEVEL,
      criterions: z
        .array(
          z
            .object({
              Type: z
                .string()
                .describe(
                  "Wrapper type: BiddableAdGroupCriterion, NegativeAdGroupCriterion, BiddableCampaignCriterion, or NegativeCampaignCriterion.",
                ),
              Criterion: z
                .record(z.string(), z.unknown())
                .describe("The criterion itself, carrying its own Type."),
            })
            .passthrough(),
        )
        .min(1),
    },
    run(async (args: Record<string, unknown>) => {
      const scope = await ids(args);
      return tg.addCriterions(
        scope,
        args.level as tg.CriterionLevel,
        args.criterions as Record<string, unknown>[],
      );
    }),
  );

  writeTool(
    server,
    "update_targeting",
    `${WRITE}Update targeting criterions — most commonly to change a bid multiplier. Each entry needs its Id and its Criterion object.

Day/time criterion fields are immutable; delete and re-add to change a schedule.`,
    {
      ...ACCOUNT_ARGS,
      level: LEVEL,
      criterions: z
        .array(
          z
            .object({
              Id: z.string(),
              Type: z.string(),
              Criterion: z.record(z.string(), z.unknown()),
            })
            .passthrough(),
        )
        .min(1),
    },
    run(async (args: Record<string, unknown>) => {
      const scope = await ids(args);
      return tg.updateCriterions(
        scope,
        args.level as tg.CriterionLevel,
        args.criterions as Record<string, unknown>[],
      );
    }),
  );

  destructiveTool(
    server,
    "delete_targeting",
    `${WRITE}Remove targeting criterions. Removing all of a targeting dimension widens who sees the ads, which can increase spend — check what remains before deleting.`,
    {
      ...ACCOUNT_ARGS,
      level: LEVEL,
      criterion_ids: z.array(z.string()).min(1),
      criterion_type: z
        .enum(tg.DELETE_CRITERION_TYPES)
        .describe(
          "Specific read type of the criterions being removed, e.g. Age or RemarketingList. It is mapped to the required write family.",
        ),
    },
    run(async (args: Record<string, unknown>) => {
      const scope = await ids(args);
      return tg.deleteCriterions(
        scope,
        args.level as tg.CriterionLevel,
        (args.criterion_ids as string[]).map(String),
        String(args.criterion_type),
      );
    }),
  );

  defineRead(server, {
    name: "search_linkedin_companies",
    title: "LinkedIn company search",
    priority: 0.75,
    description:
      "Search LinkedIn company names and return their ProfileIds, for use with ProfileCriterion targeting.\n\n" +
      "LinkedIn profile targeting — by company, industry, or job function — has no equivalent in Google Ads or Meta. It is the clearest reason to run Microsoft Advertising for B2B.\n\n" +
      "Supported on Search, Shopping, and Audience campaigns. Up to 1,000 company criterions per campaign or ad group.",
    inputSchema: {
      ...ACCOUNT_ARGS,
      company_name: z.string().describe("Company name or prefix to search for."),
      language_locale: z.string().optional().describe('Default "en".'),
      limit: COLLECTION_LIMIT,
    },
    handler: async (args) => {
      const scope = await ids(args);
      const companies = await tg.searchCompanies(
        scope,
        String(args.company_name),
        args.language_locale ? String(args.language_locale) : "en",
      );
      return collectionEnvelope("companies", companies, {
        limit: Number(args.limit ?? DEFAULT_COLLECTION_LIMIT),
      });
    },
  });

  defineRead(server, {
    name: "get_targeting_id_file",
    title: "Targeting id reference files",
    priority: 0.6,
    description:
      "Get a temporary download URL for Microsoft's targeting id reference files.\n\n" +
      "Location ids and LinkedIn industry / job-function ids are not queryable — Microsoft publishes them as downloadable files, and every location and profile criterion needs an id from one of them. Fetch the URL here, then read the file to find the id you need.\n\n" +
      "For LinkedIn COMPANY ids use search_linkedin_companies instead; those are searchable.",
    inputSchema: {
      ...ACCOUNT_ARGS,
      file: z
        .enum(["geo_locations", "industry", "job_function", "job_seniority"])
        .describe("Which reference file to fetch."),
      language_locale: z.string().optional().describe('Default "en".'),
    },
    handler: async (args) => {
      const scope = await ids(args);
      const locale = args.language_locale ? String(args.language_locale) : "en";
      const file = String(args.file);

      if (file === "geo_locations") {
        return {
          file,
          url: await tg.getGeoLocationsFileUrl(scope, locale),
          note: "Temporary URL. The file maps location ids to names and types; use the numeric id in a LocationCriterion.",
        };
      }
      const profileType = (
        {
          industry: "Industry",
          job_function: "JobFunction",
          job_seniority: "JobSeniority",
        } as const
      )[file as "industry" | "job_function" | "job_seniority"];
      return {
        file,
        url: await tg.getProfileDataFileUrl(scope, profileType as tg.ProfileType, locale),
        note: "Temporary URL. Use the numeric ProfileId from this file in a ProfileCriterion.",
      };
    },
  });
}
