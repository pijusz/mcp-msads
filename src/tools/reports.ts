import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveAccount } from "@/services/accounts";
import {
  AGGREGATIONS,
  PREDEFINED_TIMES,
  REPORT_TYPE_NAMES,
  REPORT_TYPES,
} from "@/services/report-types";
import {
  getSubmittedReport,
  type RunReportResult,
  runReport,
} from "@/services/reporting";
import { ACCOUNT_ARGS } from "@/tools/_shared";
import {
  COLLECTION_LIMIT,
  collectionEnvelope,
  DEFAULT_COLLECTION_LIMIT,
  MAX_COLLECTION_LIMIT,
} from "@/utils/collection";
import type { ParsedReport } from "@/utils/csv";
import { defineRead } from "@/utils/define-read";
import { rowsToTsv } from "@/utils/tsv";

/**
 * Default row ceiling. Ad reports routinely run to tens of thousands of rows;
 * pasting one whole into a model's context is both expensive and useless.
 * Truncation is always reported, never silent.
 */
const DEFAULT_MAX_ROWS = DEFAULT_COLLECTION_LIMIT;

interface ShapeOptions {
  format: "tsv" | "json";
  maxRows: number;
  columns?: string[];
}

/**
 * Project and truncate report rows for return to the model.
 *
 * TSV by default: for tabular data it costs roughly half the tokens of the
 * equivalent JSON, because keys are not repeated per row.
 */
function shapeReport(report: ParsedReport, opts: ShapeOptions) {
  const projected = opts.columns?.length
    ? report.rows.map((row) => {
        const out: Record<string, string> = {};
        for (const col of opts.columns as string[]) out[col] = row[col] ?? "";
        return out;
      })
    : report.rows;

  const { rows, ...envelope } = collectionEnvelope("rows", projected, {
    limit: opts.maxRows,
    total: Math.max(report.declaredRows ?? 0, report.totalRows),
    guidance: "Raise max_rows, narrow the report scope, or use a coarser aggregation.",
  });

  return {
    ...envelope,
    columns: opts.columns?.length ? opts.columns : report.columns,
    ...(opts.format === "tsv"
      ? {
          rows_tsv: rowsToTsv(rows, opts.columns?.length ? opts.columns : report.columns),
        }
      : { rows }),
  };
}

/** Assemble the common response envelope for a report result. */
function reportResponse(result: RunReportResult, opts: ShapeOptions) {
  const base = {
    status: result.status,
    report_request_id: result.reportRequestId,
    ...(result.warnings.length > 0 && { warnings: result.warnings }),
    ...(result.message !== undefined && { message: result.message }),
  };

  if (result.status !== "complete" || !result.report) return base;

  const meta = result.report.metadata;
  return {
    ...base,
    ...(result.report.potentiallyIncomplete && {
      // Worth shouting about: an agent may be about to act on these numbers.
      data_warning:
        "Microsoft flagged this report as potentially incomplete — the most recent period is still being processed. Clicks settle in ~2h, conversions in ~3h.",
    }),
    report_metadata: {
      time_zone: meta["Time Zone"],
      last_completed_available_day: meta["Last Completed Available Day"],
      aggregation: meta["Report Aggregation"],
    },
    ...shapeReport(result.report, opts),
  };
}

const FORMAT = z
  .enum(["tsv", "json"])
  .optional()
  .describe("Output shape. TSV is roughly half the tokens of JSON. Default tsv.");

const MAX_ROWS = COLLECTION_LIMIT.describe(
  `Row ceiling for the returned payload. Default ${DEFAULT_MAX_ROWS}.`,
);

function shapeOptionsFrom(args: Record<string, unknown>): ShapeOptions {
  const cols = args.columns;
  return {
    format: args.format === "json" ? "json" : "tsv",
    maxRows: Number(args.max_rows ?? DEFAULT_MAX_ROWS),
    ...(Array.isArray(cols) ? { columns: cols.map(String) } : {}),
  };
}

const REPORT_DESCRIPTION = `Run a Microsoft Advertising performance report and return the rows.

Reporting is asynchronous server-side: this tool submits the report, polls until it is ready, downloads the ZIP, and parses the CSV for you. Small reports typically return in a few seconds. If the wait budget runs out the tool returns status "pending" with a report_request_id — the report is NOT lost; collect it with get_report.

Key behaviours:
- Every monetary value is in the account's own currency (see get_account).
- Aggregation defaults to Daily, and TimePeriod is added automatically — without that column the API silently ignores the aggregation and returns a Summary.
- Use either predefined_time OR start_date/end_date, never both.
- Use ConversionsQualified, not Conversions: the latter was deprecated in 2022 and always returns 0.
- Output is capped at ${DEFAULT_MAX_ROWS} rows by default and truncation is always reported.

Call list_report_types to see every report type with its default columns and scoping rules.`;

export function registerReportTools(server: McpServer): void {
  defineRead(server, {
    name: "list_report_types",
    title: "Available report types",
    uriTemplate: "msads://report-types",
    priority: 0.75,
    description:
      "Every report type run_report supports, with what it covers, how it can be scoped, and its default columns. " +
      "Consult this before run_report when unsure which report answers a question.",
    inputSchema: { limit: COLLECTION_LIMIT },
    handler: async (args) => ({
      aggregations: AGGREGATIONS,
      predefined_times: PREDEFINED_TIMES,
      ...collectionEnvelope(
        "report_types",
        REPORT_TYPE_NAMES.map((name) => {
          const spec = REPORT_TYPES[name];
          if (!spec) return { name };
          return {
            name,
            description: spec.description,
            scope: spec.scope,
            default_columns: spec.defaultColumns,
            ...(spec.noAggregation && { supports_aggregation: false }),
            ...(spec.noTime && { supports_time_range: false }),
          };
        }),
        {
          limit: Number(args.limit ?? DEFAULT_COLLECTION_LIMIT),
          total: REPORT_TYPE_NAMES.length,
        },
      ),
    }),
  });

  defineRead(server, {
    name: "run_report",
    title: "Run a performance report",
    description: REPORT_DESCRIPTION,
    priority: 0.95,
    inputSchema: {
      report_type: z
        .enum(REPORT_TYPE_NAMES as [string, ...string[]])
        .describe(`One of: ${REPORT_TYPE_NAMES.join(", ")}. See list_report_types.`),
      ...ACCOUNT_ARGS,
      columns: z
        .array(z.string())
        .max(MAX_COLLECTION_LIMIT)
        .optional()
        .describe("Report columns. Defaults to a sensible set per report type."),
      aggregation: z
        .enum(AGGREGATIONS)
        .optional()
        .describe("Time grain. Default Daily. Summary aggregates the whole range."),
      predefined_time: z
        .enum(PREDEFINED_TIMES)
        .optional()
        .describe("Relative period. Default LastSevenDays. Excludes start/end date."),
      start_date: z.string().optional().describe("YYYY-MM-DD. Requires end_date."),
      end_date: z.string().optional().describe("YYYY-MM-DD. Cannot be in the future."),
      time_zone: z
        .string()
        .optional()
        .describe(
          "Report time zone, e.g. PacificTimeUSCanadaTijuana. Only sets which day 'today' means; values are always UTC.",
        ),
      campaign_ids: z
        .array(z.string())
        .max(300)
        .optional()
        .describe("Narrow to these campaigns (max 300)."),
      ad_group_ids: z
        .array(z.string())
        .max(300)
        .optional()
        .describe("Narrow to these ad groups (max 300)."),
      asset_group_ids: z
        .array(z.string())
        .max(100)
        .optional()
        .describe("Narrow asset-group reports to these asset groups (max 100)."),
      account_ids: z
        .array(z.string())
        .max(1000)
        .optional()
        .describe("Report across several accounts at once (max 1000)."),
      filter: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          'Server-side row filter, e.g. { "Status": "Active" }. Shape varies per report type.',
        ),
      max_rows: MAX_ROWS,
      format: FORMAT,
      timeout_ms: z
        .number()
        .int()
        .min(1000)
        .optional()
        .describe("How long to wait before returning a resumable pending result."),
    },
    handler: async (args) => {
      const ids = await resolveAccount(args);

      const scope = {
        ...(Array.isArray(args.account_ids)
          ? { accountIds: args.account_ids.map(String) }
          : {}),
        ...(Array.isArray(args.campaign_ids)
          ? { campaignIds: args.campaign_ids.map(String) }
          : {}),
        ...(Array.isArray(args.ad_group_ids)
          ? { adGroupIds: args.ad_group_ids.map(String) }
          : {}),
        ...(Array.isArray(args.asset_group_ids)
          ? { assetGroupIds: args.asset_group_ids.map(String) }
          : {}),
      };

      const result = await runReport(
        {
          reportType: String(args.report_type),
          accountId: ids.accountId,
          ...(Array.isArray(args.columns) ? { columns: args.columns.map(String) } : {}),
          ...(args.aggregation ? { aggregation: args.aggregation as never } : {}),
          ...(args.predefined_time
            ? { predefinedTime: args.predefined_time as never }
            : {}),
          ...(args.start_date ? { startDate: String(args.start_date) } : {}),
          ...(args.end_date ? { endDate: String(args.end_date) } : {}),
          ...(args.time_zone ? { timeZone: String(args.time_zone) } : {}),
          ...(args.filter ? { filter: args.filter as Record<string, unknown> } : {}),
          ...(args.report_type === "keyword_performance" || args.max_rows !== undefined
            ? { maxRows: Number(args.max_rows ?? DEFAULT_MAX_ROWS) }
            : {}),
          scope,
        },
        ids,
        {
          ...(args.timeout_ms ? { timeoutMs: Number(args.timeout_ms) } : {}),
          maxRows: Number(args.max_rows ?? DEFAULT_MAX_ROWS),
        },
      );

      return {
        account_id: ids.accountId,
        ...reportResponse(result, shapeOptionsFrom(args)),
      };
    },
  });

  defineRead(server, {
    name: "get_report",
    title: "Collect a previously submitted report",
    priority: 0.6,
    description:
      "Collect a report that run_report left in the 'pending' state, using its report_request_id. " +
      "Report ids stay valid for about a day. Download URLs expire after 5 minutes, so this always re-polls for a fresh one rather than reusing a stale link.",
    inputSchema: {
      report_request_id: z.string().describe("Id returned by a pending run_report call."),
      ...ACCOUNT_ARGS,
      max_rows: MAX_ROWS,
      format: FORMAT,
      columns: z.array(z.string()).max(MAX_COLLECTION_LIMIT).optional(),
    },
    handler: async (args) => {
      const ids = await resolveAccount(args);
      const result = await getSubmittedReport(
        String(args.report_request_id),
        ids,
        "Csv",
        Number(args.max_rows ?? DEFAULT_MAX_ROWS),
      );
      return {
        account_id: ids.accountId,
        ...reportResponse(result, shapeOptionsFrom(args)),
      };
    },
  });
}
