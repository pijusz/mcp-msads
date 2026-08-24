import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as bulk from "@/services/bulk";
import { ACCOUNT_ARGS, ids } from "@/tools/_shared";
import {
  COLLECTION_LIMIT,
  collectionEnvelope,
  DEFAULT_COLLECTION_LIMIT,
} from "@/utils/collection";
import { defineRead } from "@/utils/define-read";
import { MsAdsError } from "@/utils/errors";
import { destructiveTool } from "@/utils/register-tool";
import { run } from "@/utils/tool-response";

function shapeRecords(records: bulk.BulkRecords, limit: number) {
  const candidates: Array<{ type: string; record: Record<string, string> }> = [];
  for (const [type, rows] of Object.entries(records.byType)) {
    for (const record of rows) {
      if (candidates.length >= limit) break;
      candidates.push({ type, record });
    }
    if (candidates.length >= limit) break;
  }
  const { records: shown, ...envelope } = collectionEnvelope("records", candidates, {
    limit,
    total: records.totalRows,
    guidance: "Narrow by campaign_ids or use last_sync_time_utc for a delta export.",
  });
  const byType: Record<string, Array<Record<string, string>>> = {};
  for (const { type, record } of shown) {
    const rows = byType[type] ?? [];
    rows.push(record);
    byType[type] = rows;
  }
  return {
    ...envelope,
    entity_types: Object.keys(records.byType),
    by_type: byType,
  };
}

function shapeDownloadResult(result: bulk.BulkDownloadResult, limit: number) {
  const base = {
    status: result.status,
    download_request_id: result.downloadRequestId,
    ...(result.message !== undefined && { message: result.message }),
  };
  if (result.records) {
    return {
      ...base,
      ...(result.errors?.length
        ? {
            error_count: result.errors.length,
            errors_showing: Math.min(result.errors.length, limit),
            errors_truncated: result.errors.length > limit,
            ...(result.errors.length > limit
              ? { errors_guidance: "Narrow the bulk scope or raise limit." }
              : {}),
            errors: result.errors.slice(0, limit),
          }
        : {}),
      ...shapeRecords(result.records, limit),
    };
  }
  return result.errors?.length
    ? { ...base, ...collectionEnvelope("errors", result.errors, { limit }) }
    : base;
}

function shapeUploadResult(result: bulk.BulkUploadResult, limit: number) {
  return {
    status: result.status,
    request_id: result.requestId,
    ...(result.message !== undefined && { message: result.message }),
    ...(result.serviceErrors?.length
      ? {
          service_error_count: result.serviceErrors.length,
          service_errors_showing: Math.min(result.serviceErrors.length, limit),
          service_errors_truncated: result.serviceErrors.length > limit,
          ...(result.serviceErrors.length > limit
            ? { service_errors_guidance: "Raise limit to inspect more errors." }
            : {}),
          service_errors: result.serviceErrors.slice(0, limit),
        }
      : {}),
    ...(result.errors?.length
      ? {
          error_count: result.errors.length,
          errors_showing: Math.min(result.errors.length, limit),
          errors_truncated: result.errors.length > limit,
          ...(result.errors.length > limit
            ? { errors_guidance: "Narrow the bulk scope or raise limit." }
            : {}),
          errors: result.errors.slice(0, limit),
        }
      : {}),
    ...(result.records ? shapeRecords(result.records, limit) : {}),
  };
}

export function registerBulkTools(server: McpServer): void {
  defineRead(server, {
    name: "bulk_download",
    title: "Bulk account export",
    priority: 0.8,
    description:
      "Export an account's entities in one operation and return them grouped by record type.\n\n" +
      "This returns CONFIGURATION, not performance — no clicks, spend, or conversions. For metrics use run_report.\n\n" +
      "Use this instead of the list_* tools when you need broad account state: those read one parent at a time " +
      "(ad groups for one campaign, ads for one ad group), so mapping a whole account through them takes hundreds of calls. " +
      "This takes one.\n\n" +
      "Pass last_sync_time_utc for a delta export — only what changed since that timestamp, which must be within the last 30 days.\n\n" +
      "Bulk generation takes minutes, not seconds. If the wait budget runs out you get a resumable download_request_id, valid for 2 days. " +
      "Accounts over ~4M keywords cannot be exported whole; narrow with campaign_ids instead.",
    inputSchema: {
      ...ACCOUNT_ARGS,
      entities: z
        .array(z.enum(bulk.DOWNLOAD_ENTITIES))
        .min(1)
        .describe("Entity families to export."),
      campaign_ids: z
        .array(z.string())
        .max(bulk.MAX_BULK_CAMPAIGN_IDS)
        .optional()
        .describe(
          "Limit to these campaigns (max 1000). Omit to export the whole account.",
        ),
      last_sync_time_utc: z
        .string()
        .optional()
        .describe("ISO timestamp for a delta export. Must be within the last 30 days."),
      limit: COLLECTION_LIMIT,
      timeout_ms: z
        .number()
        .int()
        .min(1000)
        .optional()
        .describe("How long to wait before returning a resumable pending result."),
    },
    handler: async (args) => {
      const scope = await ids(args);
      const result = await bulk.runBulkDownload(
        scope,
        {
          entities: (args.entities as string[]).map(String),
          ...(Array.isArray(args.campaign_ids)
            ? { campaignIds: args.campaign_ids.map(String) }
            : {}),
          ...(args.last_sync_time_utc
            ? { lastSyncTimeUtc: String(args.last_sync_time_utc) }
            : {}),
        },
        args.timeout_ms ? { timeoutMs: Number(args.timeout_ms) } : {},
      );

      return {
        account_id: scope.accountId,
        ...shapeDownloadResult(result, Number(args.limit ?? DEFAULT_COLLECTION_LIMIT)),
      };
    },
  });

  destructiveTool(
    server,
    "bulk_upload",
    `⚠️ WRITE OPERATION — Create, change, or delete many entities at once by uploading bulk records. Bulk record types can remove data, so this entire surface is conservatively destructive and can affect live ad spend.

Use this instead of the create_*/update_* tools when writing across many parents. Those cap at one parent per call (50 ads in ONE ad group, 1000 keywords in ONE ad group); this writes across the whole account in a single operation.

Each record is a flat object whose "Type" field names the record kind ("Campaign", "Ad Group", "Keyword", ...). To attach children to a parent created in the same upload, give the parent a NEGATIVE "Id" and reference it from the child's "Parent Id":

  [{ "Type": "Campaign",  "Id": "-1", "Name": "New Campaign", "Status": "Paused", "Budget": "10.00" },
   { "Type": "Ad Group",  "Id": "-2", "Parent Id": "-1", "Name": "New Ad Group", "Status": "Paused" },
   { "Type": "Keyword",   "Parent Id": "-2", "Keyword": "running shoes", "Match Type": "Exact", "Status": "Paused" }]

Notes:
- Parent records must appear before their children.
- To CLEAR an optional field use the literal string "delete_value"; an empty string is ignored, not treated as a delete.
- Set entities to Paused unless you intend them to start delivering.
- Results come back per record; failures appear as records whose Type ends in "Error" and are surfaced separately.`,
    {
      ...ACCOUNT_ARGS,
      records: z
        .array(z.record(z.string(), z.string()))
        .min(1)
        .max(bulk.MAX_BULK_UPLOAD_RECORDS)
        .describe('Bulk records. Every record needs a "Type" field.'),
      limit: COLLECTION_LIMIT,
      timeout_ms: z.number().int().min(1000).optional(),
    },
    run(async (args: Record<string, unknown>) => {
      const scope = await ids(args);
      const records = args.records as Array<Record<string, string>>;

      const untyped = records.findIndex((r) => !r.Type);
      if (untyped >= 0) {
        throw new MsAdsError({
          message: `Record at index ${untyped} has no "Type" field. Every bulk record must name its record kind.`,
        });
      }

      const result = await bulk.runBulkUpload(
        scope,
        records,
        args.timeout_ms ? { timeoutMs: Number(args.timeout_ms) } : {},
      );

      return {
        account_id: scope.accountId,
        submitted: records.length,
        ...shapeUploadResult(result, Number(args.limit ?? DEFAULT_COLLECTION_LIMIT)),
      };
    }),
  );

  defineRead(server, {
    name: "get_bulk_download",
    title: "Collect a bulk export",
    priority: 0.5,
    description:
      "Collect a bulk export that bulk_download left pending, using its download_request_id. Ids stay valid for 2 days.",
    inputSchema: {
      ...ACCOUNT_ARGS,
      download_request_id: z.string().describe("Id from a pending bulk_download call."),
      limit: COLLECTION_LIMIT,
    },
    handler: async (args) => {
      const scope = await ids(args);
      const result = await bulk.getSubmittedBulkDownload(
        scope,
        String(args.download_request_id),
      );
      return shapeDownloadResult(result, Number(args.limit ?? DEFAULT_COLLECTION_LIMIT));
    },
  });

  defineRead(server, {
    name: "get_bulk_upload",
    title: "Collect a bulk upload",
    priority: 0.5,
    description:
      "Collect a bulk upload that bulk_upload left pending, using its request_id.",
    inputSchema: {
      ...ACCOUNT_ARGS,
      request_id: z.string().describe("Id from a pending bulk_upload call."),
      limit: COLLECTION_LIMIT,
    },
    handler: async (args) => {
      const scope = await ids(args);
      return shapeUploadResult(
        await bulk.getSubmittedBulkUpload(scope, String(args.request_id)),
        Number(args.limit ?? DEFAULT_COLLECTION_LIMIT),
      );
    },
  });
}
