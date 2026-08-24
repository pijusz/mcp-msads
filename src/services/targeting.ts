import type { AccountIds } from "@/services/campaigns";
import { msadsFetch } from "@/services/msads-api";
import {
  assertBatchLimit,
  BATCH_LIMITS,
  type BatchResult,
  mapBatchResult,
} from "@/utils/batch";
import { MsAdsError } from "@/utils/errors";

/**
 * Targeting criterions — age, gender, device, location, schedule, audience,
 * and LinkedIn profile targeting.
 *
 * The API has a read/write asymmetry that is easy to get wrong and produces
 * confusing failures: you WRITE with an umbrella `CriterionType` ("Targets" or
 * "Audience") but READ back with the specific type ("Age", "Device", …). This
 * module derives the umbrella from the criterions themselves so callers never
 * have to know.
 */

/** Criterion types written under the "Targets" umbrella. */
const TARGET_CRITERIA = new Set([
  "AgeCriterion",
  "GenderCriterion",
  "DeviceCriterion",
  "DayTimeCriterion",
  "LocationCriterion",
  "LocationIntentCriterion",
  "RadiusCriterion",
  "ProfileCriterion",
  "PlacementCriterion",
  "TopicCriterion",
  "GenreCriterion",
  "StoreCriterion",
]);

/** Criterion types written under the "Audience" umbrella. */
const AUDIENCE_CRITERIA = new Set(["AudienceCriterion"]);

/**
 * Work out which umbrella `CriterionType` a batch needs.
 *
 * A single call carries exactly one umbrella value, so a batch mixing target
 * and audience criterions has to be split — better to say that plainly than to
 * let the API reject it with a type error that names neither cause.
 */
export function resolveCriterionType(criterions: Record<string, unknown>[]): string {
  const kinds = new Set<string>();

  for (const wrapper of criterions) {
    const criterion = wrapper.Criterion as Record<string, unknown> | undefined;
    const type = criterion?.Type;
    if (typeof type !== "string") {
      throw new MsAdsError({
        message:
          'Every criterion needs a nested Criterion object with a Type, e.g. { "Criterion": { "Type": "AgeCriterion", "AgeRange": "EighteenToTwentyFour" } }.',
      });
    }
    if (TARGET_CRITERIA.has(type)) kinds.add("Targets");
    else if (AUDIENCE_CRITERIA.has(type)) kinds.add("Audience");
    else if (type === "Webpage") kinds.add("Webpage");
    else if (type === "ProductScope") kinds.add("ProductScope");
    else {
      throw new MsAdsError({
        message: `Unsupported criterion type "${type}" for this operation.`,
      });
    }
  }

  if (kinds.size > 1) {
    throw new MsAdsError({
      message:
        `This batch mixes ${[...kinds].join(" and ")} criterions, but a single call carries one CriterionType. ` +
        "Send them as separate calls.",
    });
  }
  const only = [...kinds][0];
  if (!only) throw new MsAdsError({ message: "No criterions supplied." });
  return only;
}

/**
 * Device targeting is all-or-nothing: Microsoft requires Computers,
 * Smartphones, and Tablets together, and adding a subset silently adds none.
 */
export function assertCompleteDeviceSet(criterions: Record<string, unknown>[]): void {
  const devices = criterions
    .map((c) => (c.Criterion as Record<string, unknown> | undefined) ?? {})
    .filter((c) => c.Type === "DeviceCriterion")
    .map((c) => String(c.DeviceName ?? ""));

  if (devices.length === 0) return;

  const required = ["Computers", "Smartphones", "Tablets"];
  const missing = required.filter((d) => !devices.includes(d));
  if (missing.length > 0) {
    throw new MsAdsError({
      message:
        `Device targeting must include all three of Computers, Smartphones, and Tablets in one call — missing ${missing.join(", ")}. ` +
        "A partial set is accepted by the API and then applied to nothing.",
    });
  }
}

export type CriterionLevel = "campaign" | "adgroup";

const DELETE_CRITERION_FAMILIES = {
  Age: "Targets",
  Gender: "Targets",
  Device: "Targets",
  DayTime: "Targets",
  Location: "Targets",
  LocationIntent: "Targets",
  Radius: "Targets",
  CompanyName: "Targets",
  Industry: "Targets",
  JobFunction: "Targets",
  JobSeniority: "Targets",
  Placement: "Targets",
  Topic: "Targets",
  Genre: "Targets",
  Store: "Targets",
  RemarketingList: "Audience",
  CustomAudience: "Audience",
  InMarketAudience: "Audience",
  ProductAudience: "Audience",
  SimilarRemarketingList: "Audience",
  CombinedList: "Audience",
  CustomerList: "Audience",
  ImpressionBasedRemarketingList: "Audience",
  Webpage: "Webpage",
  ProductScope: "ProductScope",
} as const satisfies Record<string, "Targets" | "Audience" | "Webpage" | "ProductScope">;

export const DELETE_CRITERION_TYPES = Object.keys(DELETE_CRITERION_FAMILIES) as [
  keyof typeof DELETE_CRITERION_FAMILIES,
  ...(keyof typeof DELETE_CRITERION_FAMILIES)[],
];

export function resolveDeleteCriterionType(
  criterionType: string,
): "Targets" | "Audience" | "Webpage" | "ProductScope" {
  const family =
    DELETE_CRITERION_FAMILIES[criterionType as keyof typeof DELETE_CRITERION_FAMILIES];
  if (!family) {
    throw new MsAdsError({
      message: `Unsupported criterion type "${criterionType}" for deletion.`,
    });
  }
  return family;
}

function paths(level: CriterionLevel) {
  return level === "campaign"
    ? {
        collection: "CampaignCriterions",
        body: "CampaignCriterions",
        ids: "CampaignCriterionIds",
      }
    : {
        collection: "AdGroupCriterions",
        body: "AdGroupCriterions",
        ids: "AdGroupCriterionIds",
      };
}

function limitFor(level: CriterionLevel): number {
  return level === "campaign"
    ? BATCH_LIMITS.campaignCriterions
    : BATCH_LIMITS.adGroupCriterions;
}

export async function getCriterions(
  ids: AccountIds,
  level: CriterionLevel,
  criterionIds: string[] | null,
  criterionType: string,
): Promise<Record<string, unknown>[]> {
  const p = paths(level);
  const res = await msadsFetch<Record<string, unknown>>(
    "CampaignManagement",
    `${p.collection}/QueryByIds`,
    {
      body: {
        [level === "campaign" ? "CampaignCriterionIds" : "AdGroupCriterionIds"]:
          criterionIds,
        CriterionType: criterionType,
      },
      ...ids,
      retry: "safe",
    },
  );
  const list = res[p.body];
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
}

export async function addCriterions(
  ids: AccountIds,
  level: CriterionLevel,
  criterions: Record<string, unknown>[],
): Promise<BatchResult> {
  assertBatchLimit(criterions, limitFor(level), "criterions");
  assertCompleteDeviceSet(criterions);
  const criterionType = resolveCriterionType(criterions);
  const p = paths(level);

  const res = await msadsFetch<Record<string, unknown>>(
    "CampaignManagement",
    p.collection,
    {
      method: "POST",
      body: { [p.body]: criterions, CriterionType: criterionType },
      ...ids,
    },
  );
  return mapBatchResult(
    res,
    p.ids,
    criterions.map((c) => String((c.Criterion as Record<string, unknown>)?.Type ?? "")),
    criterions.length,
  );
}

export async function updateCriterions(
  ids: AccountIds,
  level: CriterionLevel,
  criterions: Record<string, unknown>[],
): Promise<BatchResult> {
  assertBatchLimit(criterions, limitFor(level), "criterions");
  const criterionType = resolveCriterionType(criterions);
  const p = paths(level);

  const res = await msadsFetch<Record<string, unknown>>(
    "CampaignManagement",
    p.collection,
    {
      method: "PUT",
      body: { [p.body]: criterions, CriterionType: criterionType },
      ...ids,
    },
  );
  return mapBatchResult(
    { [p.ids]: criterions.map((c) => c.Id ?? null), ...res },
    p.ids,
    criterions.map((c) => String(c.Id ?? "")),
    criterions.length,
  );
}

export async function deleteCriterions(
  ids: AccountIds,
  level: CriterionLevel,
  criterionIds: string[],
  criterionType: string,
): Promise<BatchResult> {
  assertBatchLimit(criterionIds, limitFor(level), "criterions");
  const p = paths(level);
  const writeFamily = resolveDeleteCriterionType(criterionType);

  const res = await msadsFetch<Record<string, unknown>>(
    "CampaignManagement",
    p.collection,
    {
      method: "DELETE",
      body: {
        [level === "campaign" ? "CampaignCriterionIds" : "AdGroupCriterionIds"]:
          criterionIds,
        CriterionType: writeFamily,
      },
      ...ids,
    },
  );
  return mapBatchResult(
    { [p.ids]: criterionIds, ...res },
    p.ids,
    criterionIds,
    criterionIds.length,
  );
}

/* ------------------------------------------------------------------ *
 * LinkedIn profile targeting — unique to Microsoft Advertising
 * ------------------------------------------------------------------ */

export type ProfileType = "CompanyName" | "Industry" | "JobFunction" | "JobSeniority";

/**
 * Temporary URL for the industry / job-function id file.
 *
 * These ids are not queryable — Microsoft publishes them as a downloadable
 * file, so a caller has to fetch and search it.
 */
export async function getProfileDataFileUrl(
  ids: AccountIds,
  profileType: ProfileType,
  languageLocale = "en",
): Promise<string> {
  const res = await msadsFetch<{ FileUrl?: string }>(
    "CampaignManagement",
    "ProfileDataFileUrl/Query",
    {
      body: { ProfileType: profileType, LanguageLocale: languageLocale },
      ...ids,
      retry: "safe",
    },
  );
  if (!res.FileUrl) {
    throw new MsAdsError({ message: "No profile data file URL was returned." });
  }
  return res.FileUrl;
}

/** Search LinkedIn company names to get their ProfileIds. */
export async function searchCompanies(
  ids: AccountIds,
  filter: string,
  languageLocale = "en",
): Promise<Record<string, unknown>[]> {
  const res = await msadsFetch<{ Companies?: Record<string, unknown>[] }>(
    "CampaignManagement",
    "Companies/Search",
    {
      body: { CompanyNameFilter: filter, LanguageLocale: languageLocale },
      ...ids,
      retry: "safe",
    },
  );
  return res.Companies ?? [];
}

/** Temporary URL for the geographical location id file. */
export async function getGeoLocationsFileUrl(
  ids: AccountIds,
  languageLocale = "en",
  version = "2.0",
): Promise<string> {
  const res = await msadsFetch<{ FileUrl?: string }>(
    "CampaignManagement",
    "GeoLocationsFileUrl/Query",
    {
      body: { LanguageLocale: languageLocale, Version: version },
      ...ids,
      retry: "safe",
    },
  );
  if (!res.FileUrl) {
    throw new MsAdsError({ message: "No geo locations file URL was returned." });
  }
  return res.FileUrl;
}
