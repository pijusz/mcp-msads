import { batchWrite, type EntitySpec } from "@/services/batch-write";
import { msadsFetch, type Scope } from "@/services/msads-api";
import { BATCH_LIMITS, type BatchResult } from "@/utils/batch";
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
        parent: "CampaignId",
      }
    : {
        collection: "AdGroupCriterions",
        body: "AdGroupCriterions",
        ids: "AdGroupCriterionIds",
        parent: "AdGroupId",
      };
}

function limitFor(level: CriterionLevel): number {
  return level === "campaign"
    ? BATCH_LIMITS.campaignCriterions
    : BATCH_LIMITS.adGroupCriterions;
}

/**
 * Read criterions of one campaign or ad group.
 *
 * `CampaignId` / `AdGroupId` is a required request element of
 * GetCampaignCriterionsByIds / GetAdGroupCriterionsByIds; with null ids the
 * API returns every criterion of that type under the parent.
 */
export async function getCriterions(
  ids: Scope,
  level: CriterionLevel,
  parentId: string,
  criterionIds: string[] | null,
  criterionType: string,
): Promise<Record<string, unknown>[]> {
  const p = paths(level);
  const res = await msadsFetch<Record<string, unknown>>(
    "CampaignManagement",
    `${p.collection}/QueryByIds`,
    {
      body: {
        [p.ids]: criterionIds,
        [p.parent]: parentId,
        CriterionType: criterionType,
      },
      ...ids,
      retry: "safe",
    },
  );
  const list = res[p.body];
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
}

function criterionSpec(
  level: CriterionLevel,
  batchFields: EntitySpec["batchFields"],
): EntitySpec {
  const p = paths(level);
  return {
    path: p.collection,
    list: p.body,
    idField: p.ids,
    limit: limitFor(level),
    what: "criterions",
    label: (c, op) =>
      String(
        op === "add"
          ? ((c.Criterion as Record<string, unknown>)?.Type ?? "")
          : (c.Id ?? ""),
      ),
    batchFields,
  };
}

export function addCriterions(
  ids: Scope,
  level: CriterionLevel,
  criterions: Record<string, unknown>[],
): Promise<BatchResult> {
  const spec = criterionSpec(level, (items) => {
    const wire = items as Record<string, unknown>[];
    assertCompleteDeviceSet(wire);
    return { CriterionType: resolveCriterionType(wire) };
  });
  return batchWrite(spec, "add", ids, undefined, criterions);
}

export function updateCriterions(
  ids: Scope,
  level: CriterionLevel,
  criterions: Record<string, unknown>[],
): Promise<BatchResult> {
  const spec = criterionSpec(level, (items) => ({
    CriterionType: resolveCriterionType(items as Record<string, unknown>[]),
  }));
  return batchWrite(spec, "update", ids, undefined, criterions);
}

export function deleteCriterions(
  ids: Scope,
  level: CriterionLevel,
  parentId: string,
  criterionIds: string[],
  criterionType: string,
): Promise<BatchResult> {
  // The parent follows the ids in this body, so it rides in batchFields
  // rather than the spec's leading parent slot.
  const spec = criterionSpec(level, () => ({
    [paths(level).parent]: parentId,
    CriterionType: resolveDeleteCriterionType(criterionType),
  }));
  return batchWrite(spec, "delete", ids, undefined, criterionIds);
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
  ids: Scope,
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
  ids: Scope,
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
  ids: Scope,
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
