import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as imp from "@/services/import-jobs";
import { ACCOUNT_ARGS, ids, WRITE } from "@/tools/_shared";
import {
  COLLECTION_LIMIT,
  collectionEnvelope,
  DEFAULT_COLLECTION_LIMIT,
  MAX_COLLECTION_LIMIT,
} from "@/utils/collection";
import { defineRead } from "@/utils/define-read";
import { MsAdsError } from "@/utils/errors";
import { destructiveTool, writeTool } from "@/utils/register-tool";
import { run } from "@/utils/tool-response";

const GOOGLE_IMPORT_ARGS = {
  ...ACCOUNT_ARGS,
  name: z.string().min(1).max(255).describe("Name for this import job."),
  credential_id: z
    .string()
    .describe(
      "Import credential id from the Microsoft Advertising UI. Not obtainable via API.",
    ),
  google_account_id: z.string().describe("Google Ads account id to import from."),
  frequency_type: z
    .enum(imp.FREQUENCY_TYPES)
    .optional()
    .describe("Omit to run once now."),
  cron: z.string().optional().describe('Required when frequency_type is "Scheduling".'),
  time_zone: z.string().optional().describe("Default GMT."),
  notification_email: z.string().optional(),
  notification_type: z.enum(["None", "Changes", "Errors", "EveryTime"]).optional(),
  new_paused_campaigns: z
    .boolean()
    .optional()
    .describe(
      "Default true. Set false only when imported entities may deliver immediately.",
    ),
  budget_adjustment_percent: z
    .number()
    .min(-90)
    .max(900)
    .optional()
    .describe("Scale imported budgets, e.g. -50 to halve them."),
  bid_adjustment_percent: z
    .number()
    .min(-90)
    .max(900)
    .optional()
    .describe("Scale imported bids."),
  import_option: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Additional GoogleImportOption fields. Deletion mirroring and paused defaults are controlled by the selected tool.",
    ),
};

const IMPORT_DESCRIPTION = `Set up a Google Ads import — copying campaigns, ad groups, ads, keywords, and settings from a Google Ads account into this one, once or on a schedule.

New campaigns and child entities default to Paused. Set new_paused_campaigns false only when they may begin delivering immediately.

Prerequisite you must obtain manually: ${imp.CREDENTIAL_HELP}

Scheduling — frequency_type is Scheduling, Auto, or RunNow. Daily, weekly, and monthly are all "Scheduling" with different six-field cron expressions whose minute is 0. Omit frequency_type to run once now.`;

function createImportHandler(mirrorDeletions: boolean) {
  return run(async (args: Record<string, unknown>) => {
    const scope = await ids(args);
    const extraOptions =
      (args.import_option as Record<string, unknown> | undefined) ?? {};
    const reserved = Object.keys(extraOptions).find((key) =>
      ["deleteremovedentities", "newpausedcampaignsandchildentities"].includes(
        key.toLowerCase(),
      ),
    );
    if (reserved) {
      throw new MsAdsError({
        message: `${reserved} is controlled by the selected import tool and cannot be set through import_option.`,
      });
    }

    const importOption: Record<string, unknown> = {
      ...extraOptions,
      NewPausedCampaignsAndChildEntities: args.new_paused_campaigns !== false,
      DeleteRemovedEntities: mirrorDeletions,
      ...(args.budget_adjustment_percent !== undefined
        ? { AdjustmentForCampaignBudgets: Number(args.budget_adjustment_percent) }
        : {}),
      ...(args.bid_adjustment_percent !== undefined
        ? { AdjustmentForBids: Number(args.bid_adjustment_percent) }
        : {}),
    };

    return imp.addImportJob(scope, {
      name: String(args.name),
      credentialId: String(args.credential_id),
      googleAccountId: String(args.google_account_id),
      ...(args.frequency_type
        ? {
            frequency: {
              type: String(args.frequency_type),
              ...(args.cron ? { cron: String(args.cron) } : {}),
              ...(args.time_zone ? { timeZone: String(args.time_zone) } : {}),
            },
          }
        : {}),
      importOption,
      ...(args.notification_email
        ? { notificationEmail: String(args.notification_email) }
        : {}),
      ...(args.notification_type
        ? {
            notificationType: args.notification_type as
              | "None"
              | "Changes"
              | "Errors"
              | "EveryTime",
          }
        : {}),
    });
  });
}

export function registerImportTools(server: McpServer): void {
  defineRead(server, {
    name: "list_google_imports",
    title: "Google Ads import jobs",
    priority: 0.65,
    description:
      "List Google Ads import jobs configured for this account — their schedule, status, and when each last ran.\n\n" +
      "Up to 100 scheduled import jobs per account. Note the credential id is never returned on read.",
    inputSchema: {
      ...ACCOUNT_ARGS,
      job_ids: z
        .array(z.string())
        .max(MAX_COLLECTION_LIMIT)
        .optional()
        .describe("Specific ids; omit for all."),
      limit: COLLECTION_LIMIT,
    },
    handler: async (args) => {
      const scope = await ids(args);
      const jobs = await imp.getImportJobs(
        scope,
        Array.isArray(args.job_ids) ? args.job_ids.map(String) : undefined,
      );
      return collectionEnvelope("import_jobs", jobs, {
        limit: Number(args.limit ?? DEFAULT_COLLECTION_LIMIT),
      });
    },
  });

  defineRead(server, {
    name: "get_google_import_results",
    title: "Google Ads import results",
    priority: 0.65,
    description:
      "Results from completed Google Ads import runs: per-entity-type counts of additions, changes, deletions, and errors, plus an error log URL when a run had problems.\n\n" +
      "One result per run, so a weekly job returns one row per week. Only the last 90 days are retained, and a job scheduled for the future returns nothing yet.",
    inputSchema: {
      ...ACCOUNT_ARGS,
      job_ids: z.array(z.string()).max(MAX_COLLECTION_LIMIT).optional(),
      page_index: z.number().int().min(0).optional(),
      page_size: z.number().int().min(1).max(1000).optional().describe("Default 200."),
    },
    handler: async (args) => {
      const scope = await ids(args);
      const pageIndex = Number(args.page_index ?? 0);
      const pageSize = Number(args.page_size ?? DEFAULT_COLLECTION_LIMIT);
      const results = await imp.getImportResults(
        scope,
        Array.isArray(args.job_ids) ? args.job_ids.map(String) : undefined,
        pageIndex,
        pageSize,
      );
      return {
        page_index: pageIndex,
        ...collectionEnvelope("import_results", results, {
          limit: pageSize,
          truncated: results.length === pageSize,
          guidance: `Request page_index ${pageIndex + 1} to continue.`,
        }),
      };
    },
  });

  writeTool(
    server,
    "create_google_import",
    `${WRITE}${IMPORT_DESCRIPTION}\n\nThis tool never mirrors source deletions. Use create_google_import_with_deletion_mirroring when Microsoft entities should be removed after their Google source is deleted.`,
    GOOGLE_IMPORT_ARGS,
    createImportHandler(false),
  );

  destructiveTool(
    server,
    "create_google_import_with_deletion_mirroring",
    `${WRITE}${IMPORT_DESCRIPTION}\n\nDeletion mirroring is enabled: future imports can remove Microsoft Advertising entities when their Google source is deleted.`,
    GOOGLE_IMPORT_ARGS,
    createImportHandler(true),
  );

  destructiveTool(
    server,
    "delete_google_imports",
    `${WRITE}Delete Google Ads import jobs, stopping future scheduled runs. Campaigns already imported are NOT removed — they stay and simply stop being synced. Past import results remain retrievable by job id.`,
    {
      ...ACCOUNT_ARGS,
      job_ids: z.array(z.string()).min(1),
    },
    run(async (args: Record<string, unknown>) => {
      const scope = await ids(args);
      return imp.deleteImportJobs(scope, (args.job_ids as string[]).map(String));
    }),
  );

  defineRead(server, {
    name: "map_google_entity_ids",
    title: "Google → Microsoft entity id mapping",
    priority: 0.5,
    description:
      "Map Google Ads entity ids to the Microsoft Advertising ids they were imported as. Use it to line up performance between the two platforms for the same campaign or ad group. A source id that was never imported maps to 0. Up to 100 ids per call.",
    inputSchema: {
      ...ACCOUNT_ARGS,
      entity_type: z
        .enum(["Campaign", "AdGroup", "Ad", "Keyword"])
        .describe("What the source ids refer to."),
      source_entity_ids: z.array(z.string()).min(1).max(100).describe("Google Ads ids."),
      source_parent_id: z
        .string()
        .optional()
        .describe("Google parent id, required for child entities."),
      limit: COLLECTION_LIMIT,
    },
    handler: async (args) => {
      const scope = await ids(args);
      const mapping = await imp.getImportEntityIdsMapping(
        scope,
        String(args.entity_type),
        (args.source_entity_ids as string[]).map(String),
        args.source_parent_id ? String(args.source_parent_id) : undefined,
      );
      return collectionEnvelope("entity_ids_mapping", mapping, {
        limit: Number(args.limit ?? DEFAULT_COLLECTION_LIMIT),
      });
    },
  });
}
