import type { AccountIds } from "@/services/campaigns";
import { msadsFetch } from "@/services/msads-api";
import { hashEmail, hashPhone } from "@/services/pii";
import {
  assertBatchLimit,
  BATCH_LIMITS,
  type BatchResult,
  mapBatchResult,
} from "@/utils/batch";
import { MsAdsError, readPartialErrors } from "@/utils/errors";

/**
 * Conversion tracking: UET tags, conversion goals, and offline conversion upload.
 *
 * The Apply* operations here return `PartialErrors` and nothing else — no ids,
 * no success count. "Success" therefore means "no errors came back", which is
 * weaker than it sounds and is reported as such.
 */

/* ------------------------------- UET ------------------------------- */

export async function getUetTags(
  ids: AccountIds,
  tagIds?: string[],
): Promise<Record<string, unknown>[]> {
  const res = await msadsFetch<{ UetTags?: Record<string, unknown>[] }>(
    "CampaignManagement",
    "UetTags/QueryByIds",
    { body: { TagIds: tagIds ?? null }, ...ids, retry: "safe" },
  );
  return res.UetTags ?? [];
}

export async function addUetTags(
  ids: AccountIds,
  tags: Record<string, unknown>[],
): Promise<BatchResult> {
  assertBatchLimit(tags, BATCH_LIMITS.uetTags, "UET tags");
  const res = await msadsFetch<Record<string, unknown>>("CampaignManagement", "UetTags", {
    method: "POST",
    body: { UetTags: tags },
    ...ids,
  });
  // AddUetTags returns the created tags rather than a bare id array.
  // A null slot is Microsoft's per-item failure marker, so it must survive
  // rather than being dereferenced.
  const created = Array.isArray(res.UetTags)
    ? (res.UetTags as Array<{ Id?: unknown } | null>)
    : [];
  return mapBatchResult(
    { UetTagIds: created.map((t) => t?.Id ?? null), ...res },
    "UetTagIds",
    tags.map((t) => String(t.Name ?? "")),
    tags.length,
  );
}

/**
 * Fetch the per-tag Conversions API auth key.
 *
 * Two Microsoft pages disagree on the response shape — the generated service
 * reference returns a flat `UetTagAuthKey`, while the CAPI guide shows a nested
 * `TagAuthKey.AuthKey`. Both are accepted here rather than betting on one.
 *
 * Note the key is only *created* for the tag's owner; someone with shared
 * access can read an existing key but not mint one.
 */
export async function getUetTagAuthKey(ids: AccountIds, tagId: string): Promise<string> {
  const res = await msadsFetch<{
    UetTagAuthKey?: string;
    TagAuthKey?: { AuthKey?: string };
  }>("CampaignManagement", "UetTagAuthKey/Query", {
    body: { UetTagId: tagId },
    ...ids,
    retry: "safe",
  });

  const key = res.UetTagAuthKey ?? res.TagAuthKey?.AuthKey;
  if (!key) {
    throw new MsAdsError({
      message:
        `No Conversions API auth key was returned for UET tag ${tagId}. ` +
        "A key can only be created by the tag's owner — shared access can read an existing key but not generate one.",
    });
  }
  return key;
}

/* -------------------------- Conversion goals -------------------------- */

/**
 * `Type` discriminators on the conversion goal OBJECT — what you send when
 * creating one.
 */
export const CONVERSION_GOAL_TYPES = [
  "UrlGoal",
  "EventGoal",
  "DurationGoal",
  "PagesViewedPerVisitGoal",
  "AppInstallGoal",
  "AppDownloadGoal",
  "OfflineConversionGoal",
  "InStoreTransactionGoal",
] as const;

/**
 * A DIFFERENT enum, used only to filter reads — note the absent "Goal" suffix.
 * Passing the object discriminators here is rejected as invalid JSON rather
 * than as an unknown value, which makes the cause hard to see.
 *
 * `InStoreTransaction` is deliberately excluded from the default: it is
 * pilot-gated, and including it fails the whole call with
 * InStoreTransactionPilotNotEnabledForCustomer on any account without it.
 * Callers who have the pilot can pass it explicitly.
 */
export const CONVERSION_GOAL_FILTER_TYPES = [
  "Url",
  "Duration",
  "PagesViewedPerVisit",
  "Event",
  "AppInstall",
  "OfflineConversion",
  "AppDownload",
] as const;

export async function getConversionGoals(
  ids: AccountIds,
  goalIds?: string[],
  goalTypes?: string[],
): Promise<Record<string, unknown>[]> {
  const res = await msadsFetch<{ ConversionGoals?: Record<string, unknown>[] }>(
    "CampaignManagement",
    "ConversionGoals/QueryByIds",
    {
      body: {
        ConversionGoalIds: goalIds ?? null,
        // Comma-delimited: REST/JSON rejects the space-delimited SOAP form.
        ConversionGoalTypes: (goalTypes ?? CONVERSION_GOAL_FILTER_TYPES).join(","),
        ReturnAdditionalFields:
          "ViewThroughConversionWindowInMinutes,IsExternallyAttributed",
      },
      ...ids,
      retry: "safe",
    },
  );
  return res.ConversionGoals ?? [];
}

export async function addConversionGoals(
  ids: AccountIds,
  goals: Record<string, unknown>[],
): Promise<BatchResult> {
  assertBatchLimit(goals, BATCH_LIMITS.conversionGoals, "conversion goals");
  const res = await msadsFetch<Record<string, unknown>>(
    "CampaignManagement",
    "ConversionGoals",
    { method: "POST", body: { ConversionGoals: goals }, ...ids },
  );
  return mapBatchResult(
    res,
    "ConversionGoalIds",
    goals.map((g) => String(g.Name ?? "")),
    goals.length,
  );
}

export async function updateConversionGoals(
  ids: AccountIds,
  goals: Record<string, unknown>[],
): Promise<BatchResult> {
  assertBatchLimit(goals, BATCH_LIMITS.conversionGoals, "conversion goals");
  const res = await msadsFetch<Record<string, unknown>>(
    "CampaignManagement",
    "ConversionGoals",
    { method: "PUT", body: { ConversionGoals: goals }, ...ids },
  );
  return mapBatchResult(
    { ConversionGoalIds: goals.map((g) => g.Id ?? null), ...res },
    "ConversionGoalIds",
    goals.map((g) => String(g.Name ?? g.Id ?? "")),
    goals.length,
  );
}

/* ------------------------ Offline conversions ------------------------ */

export interface OfflineConversionInput {
  /** Must match an existing conversion goal name exactly, or it is discarded. */
  conversionName: string;
  /** ISO 8601 UTC. Must be after the click and within the last 90 days. */
  conversionTime: string;
  microsoftClickId?: string;
  conversionValue?: number;
  conversionCurrencyCode?: string;
  /** Plaintext email; hashed here. Lets a conversion match without a click id. */
  email?: string;
  /** Plaintext phone; normalized to E.164 and hashed here. */
  phone?: string;
  defaultCountryCode?: string;
  externalAttributionCredit?: number;
  externalAttributionModel?: string;
}

const NINETY_DAYS_MS = 90 * 24 * 3600_000;

/**
 * Validate and build one offline conversion.
 *
 * The rule worth enforcing client-side is identity: without a click id AND
 * without a hashed identifier the conversion cannot be attributed to anything,
 * and Microsoft accepts the upload and drops it.
 */
export function buildOfflineConversion(
  input: OfflineConversionInput,
  index: number,
): Record<string, unknown> {
  if (!input.conversionName) {
    throw new MsAdsError({
      message: `Conversion at index ${index} has no conversion_name. It must match an existing conversion goal name exactly, or the data is silently discarded.`,
    });
  }

  const time = Date.parse(input.conversionTime);
  if (Number.isNaN(time)) {
    throw new MsAdsError({
      message: `Conversion at index ${index} has an unparseable conversion_time "${input.conversionTime}". Use ISO 8601 UTC, e.g. 2026-08-17T14:30:00Z.`,
    });
  }
  if (Date.now() - time > NINETY_DAYS_MS) {
    throw new MsAdsError({
      message: `Conversion at index ${index} is older than 90 days, which the API rejects.`,
    });
  }
  if (time > Date.now() + 300_000) {
    throw new MsAdsError({
      message: `Conversion at index ${index} has a conversion_time in the future.`,
    });
  }

  const hashedEmail = input.email ? hashEmail(input.email).hash : undefined;
  const hashedPhone = input.phone
    ? hashPhone(input.phone, input.defaultCountryCode).hash
    : undefined;

  if (!input.microsoftClickId && !hashedEmail && !hashedPhone) {
    throw new MsAdsError({
      message:
        `Conversion at index ${index} has no identity. Supply microsoft_click_id (the msclkid from the ad click), ` +
        "or an email/phone for enhanced conversions. Without one it cannot be attributed to a click and will be discarded.",
    });
  }

  if (
    input.externalAttributionCredit !== undefined &&
    (input.externalAttributionCredit <= 0 || input.externalAttributionCredit > 1)
  ) {
    throw new MsAdsError({
      message: `Conversion at index ${index} has external_attribution_credit ${input.externalAttributionCredit}; it must be greater than 0 and at most 1.`,
    });
  }

  return {
    ConversionName: input.conversionName,
    ConversionTime: new Date(time).toISOString(),
    ...(input.microsoftClickId ? { MicrosoftClickId: input.microsoftClickId } : {}),
    ...(input.conversionValue !== undefined
      ? { ConversionValue: input.conversionValue }
      : {}),
    ...(input.conversionCurrencyCode
      ? { ConversionCurrencyCode: input.conversionCurrencyCode }
      : {}),
    ...(hashedEmail ? { HashedEmailAddress: hashedEmail } : {}),
    ...(hashedPhone ? { HashedPhoneNumber: hashedPhone } : {}),
    ...(input.externalAttributionCredit !== undefined
      ? { ExternalAttributionCredit: input.externalAttributionCredit }
      : {}),
    ...(input.externalAttributionModel
      ? { ExternalAttributionModel: input.externalAttributionModel }
      : {}),
  };
}

export interface ApplyResult {
  submitted: number;
  /** Errors reported by the API; an empty list is the only success signal. */
  errors: ReturnType<typeof readPartialErrors>;
  message: string;
}

export async function applyOfflineConversions(
  ids: AccountIds,
  conversions: OfflineConversionInput[],
): Promise<ApplyResult> {
  assertBatchLimit(conversions, BATCH_LIMITS.offlineConversions, "offline conversions");
  const payload = conversions.map(buildOfflineConversion);

  const res = await msadsFetch<Record<string, unknown>>(
    "CampaignManagement",
    "OfflineConversions/Apply",
    { body: { OfflineConversions: payload }, ...ids },
  );

  const errors = readPartialErrors(res);
  return {
    submitted: payload.length,
    errors,
    message:
      errors.length > 0
        ? `${errors.length} of ${payload.length} conversions were rejected.`
        : "Accepted. This operation returns no per-item confirmation, so an empty error list is the only success signal. " +
          "Conversions take up to 6 hours to appear in reporting, and a goal created less than 2 hours ago may not accept data yet.",
  };
}

export interface OfflineAdjustmentInput {
  conversionName: string;
  /** ISO 8601 UTC of the ORIGINAL conversion. */
  conversionTime: string;
  /** ISO 8601 UTC of the adjustment. Cannot precede the conversion. */
  adjustmentTime: string;
  adjustmentType: "Restate" | "Retract";
  adjustmentValue?: number;
  adjustmentCurrencyCode?: string;
  microsoftClickId?: string;
  email?: string;
  phone?: string;
  defaultCountryCode?: string;
}

export async function applyOfflineConversionAdjustments(
  ids: AccountIds,
  adjustments: OfflineAdjustmentInput[],
): Promise<ApplyResult> {
  assertBatchLimit(adjustments, BATCH_LIMITS.offlineConversions, "adjustments");

  const payload = adjustments.map((adj, index) => {
    if (adj.adjustmentType === "Restate" && adj.adjustmentValue === undefined) {
      throw new MsAdsError({
        message: `Adjustment at index ${index} is a Restate but has no adjustment_value. Restate requires the new value; Retract must not carry one.`,
      });
    }
    if (adj.adjustmentType === "Retract" && adj.adjustmentValue !== undefined) {
      throw new MsAdsError({
        message: `Adjustment at index ${index} is a Retract but carries an adjustment_value. Retract cancels the conversion and takes no value.`,
      });
    }
    const conversionTime = Date.parse(adj.conversionTime);
    const adjustmentTime = Date.parse(adj.adjustmentTime);
    if (Number.isNaN(conversionTime) || Number.isNaN(adjustmentTime)) {
      throw new MsAdsError({
        message: `Adjustment at index ${index} has an unparseable timestamp. Use ISO 8601 UTC.`,
      });
    }
    if (adjustmentTime < conversionTime) {
      throw new MsAdsError({
        message: `Adjustment at index ${index} is timed before the conversion it adjusts, which the API rejects.`,
      });
    }

    return {
      ConversionName: adj.conversionName,
      ConversionTime: new Date(conversionTime).toISOString(),
      AdjustmentTime: new Date(adjustmentTime).toISOString(),
      AdjustmentType: adj.adjustmentType,
      ...(adj.adjustmentValue !== undefined
        ? { AdjustmentValue: adj.adjustmentValue }
        : {}),
      ...(adj.adjustmentCurrencyCode
        ? { AdjustmentCurrencyCode: adj.adjustmentCurrencyCode }
        : {}),
      ...(adj.microsoftClickId ? { MicrosoftClickId: adj.microsoftClickId } : {}),
      ...(adj.email ? { HashedEmailAddress: hashEmail(adj.email).hash } : {}),
      ...(adj.phone
        ? { HashedPhoneNumber: hashPhone(adj.phone, adj.defaultCountryCode).hash }
        : {}),
    };
  });

  const res = await msadsFetch<Record<string, unknown>>(
    "CampaignManagement",
    "OfflineConversionAdjustments/Apply",
    { body: { OfflineConversionAdjustments: payload }, ...ids },
  );

  const errors = readPartialErrors(res);
  return {
    submitted: payload.length,
    errors,
    message:
      errors.length > 0
        ? `${errors.length} of ${payload.length} adjustments were rejected.`
        : "Accepted. This operation returns no per-item confirmation, so an empty error list is the only success signal.",
  };
}
