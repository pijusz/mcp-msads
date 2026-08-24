import type { AccountIds } from "@/services/campaigns";
import { msadsFetch } from "@/services/msads-api";
import { type BatchResult, mapBatchResult } from "@/utils/batch";
import { MsAdsError } from "@/utils/errors";

/**
 * Google Ads import.
 *
 * Nothing else in the MCP field exposes this, and it is one of the few genuine
 * reasons to run Microsoft Advertising alongside Google Ads rather than instead
 * of it: campaigns built once in Google can be mirrored across on a schedule.
 *
 * The one thing this cannot do for you is obtain a credential id. That is a
 * UI-only artifact — no v13 operation returns one — so it has to be supplied.
 */

export const CREDENTIAL_HELP =
  "An import credential id is not obtainable through the API. Get one in the Microsoft Advertising UI: " +
  "sign in to the destination ad account, search 'Import credential ID' in the top search box, and authorize with Google. " +
  "It must be created by the SAME Microsoft user whose token calls this operation, and it is only valid for accounts " +
  "under one manager account. Revoking the 'BingAdsImport App' in Google account settings invalidates it; a Google " +
  "password change does not.";

/** Frequency.Type accepts exactly these three values. */
export const FREQUENCY_TYPES = ["Scheduling", "Auto", "RunNow"] as const;

export interface ImportJobInput {
  name: string;
  credentialId: string;
  googleAccountId: string;
  /** Omit for a one-off run now. */
  frequency?: { type: string; cron?: string; timeZone?: string };
  importOption?: Record<string, unknown>;
  notificationEmail?: string;
  notificationType?: "None" | "Changes" | "Errors" | "EveryTime";
  /** Restrict to specific Google campaigns. Omit to import everything eligible. */
  campaignAdGroupIds?: Array<Record<string, unknown>>;
}

/**
 * Cron is six ordered fields, and the minute field must be 0 — imports run on
 * the hour. Validating here turns an opaque server-side rejection into a
 * message that says which field is wrong.
 */
export function validateCron(cron: string): void {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 6) {
    throw new MsAdsError({
      message:
        `Cron "${cron}" has ${parts.length} fields; it needs exactly 6: ` +
        'minute hour day-of-month month day-of-week year. Example: "0 16 * * * *" for daily at 4 PM.',
    });
  }
  if (parts[0] !== "0") {
    throw new MsAdsError({
      message: `Cron minute field must be 0 — imports run on the hour. Got "${parts[0]}".`,
    });
  }
}

export function buildImportJob(input: ImportJobInput): Record<string, unknown> {
  if (!input.credentialId) {
    throw new MsAdsError({ message: `credential_id is required. ${CREDENTIAL_HELP}` });
  }
  if (!input.googleAccountId) {
    throw new MsAdsError({ message: "google_account_id is required." });
  }
  if (input.name.length < 1 || input.name.length > 255) {
    throw new MsAdsError({ message: "Import job name must be 1–255 characters." });
  }

  let frequency: Record<string, unknown> | undefined;
  if (input.frequency) {
    const type = input.frequency.type;
    if (!(FREQUENCY_TYPES as readonly string[]).includes(type)) {
      throw new MsAdsError({
        message:
          `Frequency type "${type}" is not valid. Use one of ${FREQUENCY_TYPES.join(", ")}. ` +
          'Daily/weekly/monthly are all "Scheduling" with different cron expressions.',
      });
    }
    if (type === "Scheduling") {
      if (!input.frequency.cron) {
        throw new MsAdsError({
          message: 'Frequency type "Scheduling" requires a cron expression.',
        });
      }
      validateCron(input.frequency.cron);
    }
    frequency = {
      Type: type,
      ...(input.frequency.cron ? { Cron: input.frequency.cron } : {}),
      ...(input.frequency.timeZone ? { TimeZone: input.frequency.timeZone } : {}),
    };
  }

  return {
    Type: "GoogleImportJob",
    Name: input.name,
    CredentialId: input.credentialId,
    GoogleAccountId: input.googleAccountId,
    ...(frequency ? { Frequency: frequency } : {}),
    ...(input.importOption
      ? { ImportOption: { ...input.importOption, Type: "GoogleImportOption" } }
      : {}),
    ...(input.notificationEmail ? { NotificationEmail: input.notificationEmail } : {}),
    ...(input.notificationType ? { NotificationType: input.notificationType } : {}),
    ...(input.campaignAdGroupIds?.length
      ? { CampaignAdGroupIds: input.campaignAdGroupIds }
      : {}),
  };
}

/** Only one import job per call is accepted. */
export async function addImportJob(
  ids: AccountIds,
  input: ImportJobInput,
): Promise<BatchResult> {
  const job = buildImportJob(input);
  const res = await msadsFetch<Record<string, unknown>>(
    "CampaignManagement",
    "ImportJobs",
    { method: "POST", body: { ImportJobs: [job] }, ...ids },
  );
  return mapBatchResult(res, "ImportJobIds", [input.name], 1);
}

export async function getImportJobs(
  ids: AccountIds,
  jobIds?: string[],
): Promise<Record<string, unknown>[]> {
  const res = await msadsFetch<{ ImportJobs?: Record<string, unknown>[] }>(
    "CampaignManagement",
    "ImportJobs/QueryByIds",
    {
      body: {
        ImportJobIds: jobIds ?? null,
        ImportType: "GoogleImportJob",
        ReturnAdditionalFields: "NotificationEmail",
      },
      ...ids,
      retry: "safe",
    },
  );
  return res.ImportJobs ?? [];
}

export async function deleteImportJobs(
  ids: AccountIds,
  jobIds: string[],
): Promise<BatchResult> {
  const res = await msadsFetch<Record<string, unknown>>(
    "CampaignManagement",
    "ImportJobs",
    {
      method: "DELETE",
      body: { ImportJobIds: jobIds, ImportType: "GoogleImportJob" },
      ...ids,
    },
  );
  return mapBatchResult(
    { ImportJobIds: jobIds, ...res },
    "ImportJobIds",
    jobIds,
    jobIds.length,
  );
}

/** Results for completed runs. Only the last 90 days are retained. */
export async function getImportResults(
  ids: AccountIds,
  jobIds?: string[],
  pageIndex = 0,
  pageSize = 100,
): Promise<Record<string, unknown>[]> {
  const res = await msadsFetch<{ ImportResults?: Record<string, unknown>[] }>(
    "CampaignManagement",
    "ImportResults/Query",
    {
      body: {
        ImportJobIds: jobIds ?? null,
        ImportType: "GoogleImportJob",
        PageInfo: { Index: pageIndex, Size: Math.min(pageSize, 1000) },
      },
      ...ids,
      retry: "safe",
    },
  );
  return res.ImportResults ?? [];
}

/** Map Google entity ids to the Microsoft ids they were imported as. */
export async function getImportEntityIdsMapping(
  ids: AccountIds,
  entityType: string,
  sourceEntityIds: string[],
  sourceParentId?: string,
): Promise<Record<string, unknown>[]> {
  if (sourceEntityIds.length > 100) {
    throw new MsAdsError({
      message: `Too many source entity ids: ${sourceEntityIds.length}. The API accepts at most 100 per call.`,
    });
  }
  const res = await msadsFetch<{ EntityIdsMapping?: Record<string, unknown>[] }>(
    "CampaignManagement",
    "ImportEntityIdsMapping/Query",
    {
      body: {
        ImportEntityType: entityType,
        ImportType: "GoogleImportJob",
        SourceEntityIds: sourceEntityIds,
        ...(sourceParentId ? { SourceParentId: sourceParentId } : {}),
      },
      ...ids,
      retry: "safe",
    },
  );
  return res.EntityIdsMapping ?? [];
}
