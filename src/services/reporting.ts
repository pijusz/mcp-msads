import { getEnv } from "@/config/env";
import { downloadFile, msadsFetch, type Scope } from "@/services/msads-api";
import {
  type Aggregation,
  getReportType,
  type PredefinedTime,
  type ReportTypeSpec,
  type ScopeKind,
} from "@/services/report-types";
import { type ParsedReport, parseReportCsv } from "@/utils/csv";
import { toMsDate } from "@/utils/dates";
import { MsAdsError } from "@/utils/errors";
import { log } from "@/utils/logger";
import { type Clock, pollJob } from "@/utils/poll-job";
import { unzipSingleText } from "@/utils/zip";

/**
 * The Microsoft Advertising reporting loop: submit → poll → download → unzip →
 * parse. There is no synchronous option; both SOAP and REST expose exactly two
 * operations.
 *
 * Everything here exists to make that loop survivable from a single tool call:
 * a bounded wait with a resumable id, correct handling of the "success but no
 * URL" case, and a re-poll when the download URL ages out mid-flight.
 */

export interface ScopeInput {
  accountIds?: string[];
  campaignIds?: string[];
  adGroupIds?: string[];
  assetGroupIds?: string[];
  /**
   * Parent campaign of `adGroupIds` / `assetGroupIds`. AdGroupReportScope and
   * AssetGroupReportScope both carry CampaignId alongside AccountId.
   */
  campaignId?: string;
}

/** Scope caps, enforced client-side so the failure names the real limit. */
const SCOPE_LIMITS = {
  accounts: 1000,
  campaigns: 300,
  adGroups: 300,
  assetGroups: 100,
} as const;

function assertLimit(list: string[] | undefined, max: number, what: string): void {
  if (list && list.length > max) {
    throw new MsAdsError({
      message: `Too many ${what} in report scope: ${list.length}. The API accepts at most ${max}.`,
    });
  }
}

/**
 * Build the scope object for a report type.
 *
 * The four scope shapes are not interchangeable: an `AccountReportScope` has
 * only `AccountIds`, while the others add campaign / ad group / asset group
 * arrays that are UNIONed with it (not intersected).
 *
 * Pass `warnings` to be told when child entries had to omit their CampaignId.
 */
export function buildScope(
  kind: ScopeKind,
  input: ScopeInput,
  accountId: string,
  warnings?: string[],
): Record<string, unknown> {
  const accountIds = input.accountIds?.length ? input.accountIds : [accountId];
  assertLimit(accountIds, SCOPE_LIMITS.accounts, "accounts");
  assertLimit(input.campaignIds, SCOPE_LIMITS.campaigns, "campaigns");
  assertLimit(input.adGroupIds, SCOPE_LIMITS.adGroups, "ad groups");
  assertLimit(input.assetGroupIds, SCOPE_LIMITS.assetGroups, "asset groups");

  // A child scope entry carries its whole parent chain, but the API only needs
  // the account id alongside the child id for the shapes we build here.
  const campaigns = input.campaignIds?.map((id) => ({
    AccountId: accountId,
    CampaignId: id,
  }));

  if (kind === "account") {
    if (input.campaignIds?.length || input.adGroupIds?.length) {
      throw new MsAdsError({
        message:
          "This report type is scoped to whole accounts only — it cannot be narrowed to campaigns or ad groups. Filter the resulting rows instead.",
      });
    }
    return { AccountIds: accountIds };
  }

  if (kind === "campaign") {
    if (input.adGroupIds?.length) {
      throw new MsAdsError({
        message: "This report type scopes to accounts and campaigns only, not ad groups.",
      });
    }
    // Scope arrays are a union: sending both returns account-wide data too.
    return campaigns?.length ? { Campaigns: campaigns } : { AccountIds: accountIds };
  }

  // The parent campaign of child (ad group / asset group) scope entries: an
  // explicit campaignId, or the sole entry of campaignIds.
  const parentCampaignId =
    input.campaignId ??
    (input.campaignIds?.length === 1 ? input.campaignIds[0] : undefined);
  const withParent = parentCampaignId ? { CampaignId: parentCampaignId } : {};

  const [listKey, idKey, childIds] =
    kind === "assetgroup"
      ? (["AssetGroups", "AssetGroupId", input.assetGroupIds] as const)
      : (["AdGroups", "AdGroupId", input.adGroupIds] as const);

  if (childIds?.length) {
    if (!parentCampaignId) {
      warnings?.push(
        "Child scope entries were sent without CampaignId (the AdGroupReportScope / AssetGroupReportScope schema lists it). Pass campaign_id if the API rejects the scope.",
      );
    }
    return {
      [listKey]: childIds.map((id) => ({
        AccountId: accountId,
        ...withParent,
        [idKey]: id,
      })),
    };
  }
  return campaigns?.length ? { Campaigns: campaigns } : { AccountIds: accountIds };
}

/** Columns Microsoft deprecated; they still parse but always return 0. */
const DEPRECATED_COLUMNS: Record<string, string> = {
  Conversions: "ConversionsQualified",
  AllConversions: "AllConversionsQualified",
  ViewThroughConversions: "ViewThroughConversionsQualified",
  AveragePosition: "",
};

export interface ReportRequestInput {
  reportType: string;
  accountId: string;
  columns?: string[];
  aggregation?: Aggregation;
  predefinedTime?: PredefinedTime;
  startDate?: string;
  endDate?: string;
  timeZone?: string;
  scope?: ScopeInput;
  filter?: Record<string, unknown>;
  maxRows?: number;
  reportName?: string;
  format?: "Csv" | "Tsv";
  returnOnlyCompleteData?: boolean;
}

export interface BuiltReportRequest {
  body: Record<string, unknown>;
  /** Non-fatal advisories worth showing the caller alongside results. */
  warnings: string[];
}

/**
 * Omitting TimePeriod for a non-Summary aggregation makes the API silently
 * downgrade to Summary, so the caller gets numbers that don't mean what they
 * asked for.
 */
function needsTimePeriod(spec: ReportTypeSpec, aggregation: Aggregation): boolean {
  return aggregation !== "Summary" && !spec.noTimePeriodColumn;
}

interface RequiredColumn {
  column: string;
  /** Insert at the front rather than the end. */
  first?: boolean;
  warning: string;
}

/** Columns the request must carry: the type's required ones, plus TimePeriod. */
function requiredColumnsFor(
  spec: ReportTypeSpec,
  reportType: string,
  aggregation: Aggregation | undefined,
): RequiredColumn[] {
  const required: RequiredColumn[] = (spec.requiredColumns ?? []).map((column) => ({
    column,
    warning: `Added the required column "${column}" for ${reportType}.`,
  }));
  if (aggregation && needsTimePeriod(spec, aggregation)) {
    required.push({
      column: "TimePeriod",
      first: true,
      warning: `Added the TimePeriod column: without it the API silently ignores "${aggregation}" aggregation and returns a Summary.`,
    });
  }
  return required;
}

/**
 * Assemble the `SubmitGenerateReport` body, validating the combinations the
 * API rejects with unhelpful numeric codes.
 */
export function buildReportRequest(input: ReportRequestInput): BuiltReportRequest {
  const spec = getReportType(input.reportType);
  const warnings: string[] = [];
  // Track whether TimePeriod was the CALLER's choice or came from our defaults.
  // Most default column sets lead with TimePeriod, so treating a defaulted
  // TimePeriod as a caller error would reject Summary for nearly every report.
  const callerChoseColumns = Boolean(input.columns?.length);
  const columns = callerChoseColumns
    ? [...(input.columns as string[])]
    : [...spec.defaultColumns];

  for (const col of columns) {
    const replacement = DEPRECATED_COLUMNS[col];
    if (replacement !== undefined) {
      warnings.push(
        replacement
          ? `Column "${col}" was deprecated in 2022 and always returns 0 — use "${replacement}".`
          : `Column "${col}" was deprecated and always returns 0.`,
      );
    }
  }

  // Types without an Aggregation element (budget_summary, change history,
  // negative keyword conflicts) reject one, and have no TimePeriod column.
  const aggregation = spec.noAggregation ? undefined : (input.aggregation ?? "Daily");

  const present = new Set(columns);
  for (const { column, first, warning } of requiredColumnsFor(
    spec,
    input.reportType,
    aggregation,
  )) {
    if (present.has(column)) continue;
    present.add(column);
    if (first) columns.unshift(column);
    else columns.push(column);
    warnings.push(warning);
  }

  if (spec.noAggregation && input.aggregation) {
    warnings.push(
      `The ${input.reportType} report has no aggregation setting; ignored aggregation "${input.aggregation}".`,
    );
  }

  // Error 2034: TimePeriod with Summary (or on a type without the column).
  if (aggregation && !needsTimePeriod(spec, aggregation) && present.has("TimePeriod")) {
    if (callerChoseColumns) {
      throw new MsAdsError({
        message:
          "The TimePeriod column cannot be used with Summary aggregation (API error 2034). Drop the column or pick a different aggregation.",
      });
    }
    // Defaulted in, not asked for — quietly drop it so Summary just works.
    columns.splice(columns.indexOf("TimePeriod"), 1);
  }

  const request: Record<string, unknown> = {
    Type: spec.requestType,
    Format: input.format ?? "Csv",
    // FormatVersion 2.0 drops thousands separators from numeric fields and
    // gives hourly TimePeriod as `yyyy-mm-dd|hour` instead of a US datetime.
    FormatVersion: "2.0",
    ReportName: input.reportName ?? `mcp-msads-${input.reportType}`,
    ExcludeReportHeader: false,
    ExcludeColumnHeaders: false,
    // The footer is a copyright line — pure noise in an agent's context.
    ExcludeReportFooter: true,
    ReturnOnlyCompleteData: input.returnOnlyCompleteData ?? false,
    Columns: columns,
    Scope: buildScope(spec.scope, input.scope ?? {}, input.accountId, warnings),
  };

  if (aggregation) request.Aggregation = aggregation;

  if (!spec.noTime) {
    request.Time = buildTime(input);
  } else if (input.predefinedTime || input.startDate) {
    warnings.push(
      `The ${input.reportType} report is a snapshot of current settings and ignores any time range.`,
    );
  }

  if (input.filter && Object.keys(input.filter).length > 0) {
    request.Filter = input.filter;
  }
  // Only KeywordPerformanceReportRequest supports MaxRows.
  if (input.maxRows !== undefined) {
    if (spec.requestType === "KeywordPerformanceReportRequest") {
      request.MaxRows = input.maxRows;
    } else {
      warnings.push(
        `Only the keyword_performance report supports max_rows server-side; ${input.reportType} rows are truncated client-side instead.`,
      );
    }
  }

  if (input.returnOnlyCompleteData && isTodayIncluded(input)) {
    throw new MsAdsError({
      message:
        "return_only_complete_data cannot be combined with a time period that includes today (API error 2004).",
    });
  }

  return { body: { ReportRequest: request }, warnings };
}

function isTodayIncluded(input: ReportRequestInput): boolean {
  if (input.predefinedTime) {
    return [
      "Today",
      "ThisWeek",
      "ThisMonth",
      "ThisYear",
      "ThisWeekStartingMonday",
    ].includes(input.predefinedTime);
  }
  if (input.endDate) {
    return input.endDate >= new Date().toISOString().slice(0, 10);
  }
  return false;
}

function buildTime(input: ReportRequestInput): Record<string, unknown> {
  const hasCustom = Boolean(input.startDate || input.endDate);

  // Error 2008: PredefinedTime and a custom range are mutually exclusive.
  if (hasCustom && input.predefinedTime) {
    throw new MsAdsError({
      message:
        "Set either predefined_time or a start_date/end_date range, not both (API error 2008).",
    });
  }

  const time: Record<string, unknown> = {};
  if (input.timeZone) time.ReportTimeZone = input.timeZone;

  if (hasCustom) {
    if (!input.startDate || !input.endDate) {
      throw new MsAdsError({
        message: "A custom date range needs both start_date and end_date.",
      });
    }
    if (input.startDate > input.endDate) {
      throw new MsAdsError({
        message: `start_date (${input.startDate}) is after end_date (${input.endDate}).`,
      });
    }
    // "Today" in the report time zone can be up to a day ahead of UTC (e.g.
    // UTC+13), so only reject end dates beyond tomorrow in UTC.
    const latest = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    if (input.endDate > latest) {
      throw new MsAdsError({
        message: `end_date (${input.endDate}) is in the future; the API rejects this (error 2041).`,
      });
    }
    time.CustomDateRangeStart = toMsDate(input.startDate);
    time.CustomDateRangeEnd = toMsDate(input.endDate);

    // HourOfDay / DayOfWeek accept only predefined periods.
    if (input.aggregation === "HourOfDay" || input.aggregation === "DayOfWeek") {
      throw new MsAdsError({
        message: `${input.aggregation} aggregation does not support custom date ranges — use predefined_time instead.`,
      });
    }
  } else {
    time.PredefinedTime = input.predefinedTime ?? "LastSevenDays";
  }
  return time;
}

export interface SubmitResult {
  reportRequestId: string;
}

export async function submitReport(
  body: Record<string, unknown>,
  ids: Scope,
): Promise<SubmitResult> {
  const res = await msadsFetch<{ ReportRequestId?: string }>(
    "Reporting",
    "GenerateReport/Submit",
    { body, ...ids },
  );
  if (!res.ReportRequestId) {
    throw new MsAdsError({
      message: "SubmitGenerateReport returned no ReportRequestId.",
    });
  }
  return { reportRequestId: res.ReportRequestId };
}

export type ReportStatus = "Pending" | "Success" | "Error";

export interface PollResult {
  status: ReportStatus;
  downloadUrl?: string;
}

export async function pollReport(
  reportRequestId: string,
  ids: Scope,
): Promise<PollResult> {
  const res = await msadsFetch<{
    ReportRequestStatus?: { Status?: string; ReportDownloadUrl?: string | null };
  }>("Reporting", "GenerateReport/Poll", {
    body: { ReportRequestId: reportRequestId },
    ...ids,
    retry: "safe",
  });

  const status = (res.ReportRequestStatus?.Status ?? "Pending") as ReportStatus;
  const url = res.ReportRequestStatus?.ReportDownloadUrl;
  return { status, ...(url ? { downloadUrl: url } : {}) };
}

/** Download the ZIP the report URL points at and parse the CSV inside it. */
export async function fetchReportFile(
  downloadUrl: string,
  format: "Csv" | "Tsv" = "Csv",
  maxRows = Number.POSITIVE_INFINITY,
): Promise<ParsedReport> {
  const archive = await downloadFile(downloadUrl);
  // Every report download is ZIP compressed regardless of the Format field.
  const text = unzipSingleText(archive);
  return parseReportCsv(text, format === "Tsv" ? "\t" : ",", maxRows);
}

async function fetchReportWithFreshUrl(
  reportRequestId: string,
  downloadUrl: string,
  ids: Scope,
  format: "Csv" | "Tsv",
  maxRows: number,
): Promise<ParsedReport> {
  try {
    return await fetchReportFile(downloadUrl, format, maxRows);
  } catch (error) {
    if (
      !(error instanceof MsAdsError) ||
      (error.status !== 403 && error.status !== 404)
    ) {
      throw error;
    }
  }

  const refreshed = await pollReport(reportRequestId, ids);
  if (refreshed.status !== "Success" || !refreshed.downloadUrl) {
    throw new MsAdsError({
      message: `Report ${reportRequestId} download URL expired and a fresh URL was not available. Poll it again shortly.`,
    });
  }
  return fetchReportFile(refreshed.downloadUrl, format, maxRows);
}

export interface RunReportResult {
  status: "complete" | "pending" | "no_data";
  reportRequestId: string;
  report?: ParsedReport;
  warnings: string[];
  /** How long the poll loop waited, in ms. */
  waitedMs: number;
  /** Guidance for a caller holding a pending id. */
  message?: string;
}

/**
 * Poll cadence: fast at first because small Summary reports land in seconds,
 * then backing off toward a steady interval so a long report does not spam
 * the service. Mirrors what Microsoft's own SDK does (1s × 5, then ~5s).
 */
export function pollDelayMs(attempt: number, base: number): number {
  if (attempt < 5) return 1000;
  return Math.min(base * 2 ** Math.floor((attempt - 5) / 3), 30_000);
}

/**
 * Interpret one poll of a submitted report: `null` while it is still pending,
 * otherwise the finished result. Shared by `runReport` and
 * `getSubmittedReport` so a status means the same thing on both paths.
 */
async function settleReport(
  reportRequestId: string,
  result: PollResult,
  ids: Scope,
  opts: {
    format: "Csv" | "Tsv";
    maxRows: number;
    warnings: string[];
    waitedMs: () => number;
  },
): Promise<RunReportResult | null> {
  if (result.status === "Error") {
    throw new MsAdsError({
      message:
        `Report ${reportRequestId} failed server-side. Resubmitting sometimes clears a transient failure; ` +
        "if it keeps failing, the column or filter combination is likely invalid for this report type.",
    });
  }
  if (result.status !== "Success") return null;

  // A null URL on Success is the documented "no rows matched" signal, not
  // an error. Reporting it as an error would be actively misleading.
  if (!result.downloadUrl) {
    return {
      status: "no_data",
      reportRequestId,
      warnings: opts.warnings,
      waitedMs: opts.waitedMs(),
      message:
        "The report generated successfully but matched zero rows for these parameters.",
    };
  }
  const report = await fetchReportWithFreshUrl(
    reportRequestId,
    result.downloadUrl,
    ids,
    opts.format,
    opts.maxRows,
  );
  return {
    status: "complete",
    reportRequestId,
    report,
    warnings: opts.warnings,
    waitedMs: opts.waitedMs(),
  };
}

/**
 * Run a report to completion within a time budget.
 *
 * On timeout this returns `status: "pending"` with the report id rather than
 * throwing: the report is still being generated server-side and the caller can
 * pick it up with `get_report` instead of paying for it twice.
 */
export async function runReport(
  input: ReportRequestInput,
  ids: Scope,
  opts: { timeoutMs?: number; pollMs?: number; maxRows?: number; clock?: Clock } = {},
): Promise<RunReportResult> {
  const env = getEnv();
  const timeoutMs = opts.timeoutMs ?? env.MSADS_REPORT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? env.MSADS_REPORT_POLL_MS;

  const { body, warnings } = buildReportRequest(input);
  const { reportRequestId } = await submitReport(body, ids);
  log.info(`Report ${input.reportType} submitted as ${reportRequestId}`);

  return pollJob<RunReportResult | null, RunReportResult>({
    clock: opts.clock,
    poll: async (_attempt, elapsedMs) =>
      settleReport(reportRequestId, await pollReport(reportRequestId, ids), ids, {
        format: input.format ?? "Csv",
        maxRows: opts.maxRows ?? Number.POSITIVE_INFINITY,
        warnings,
        waitedMs: elapsedMs,
      }),
    isPending: (result) => result === null,
    budgetMs: timeoutMs,
    delay: (attempt) => pollDelayMs(attempt, pollMs),
    onTimeout: (_last, waitedMs) => ({
      status: "pending",
      reportRequestId,
      warnings,
      waitedMs,
      message:
        `Still generating after ${Math.round(waitedMs / 1000)}s. The report is not lost — ` +
        `call get_report with report_request_id "${reportRequestId}" to collect it. ` +
        "The id stays valid for about a day.",
    }),
  }) as Promise<RunReportResult>;
}

/**
 * Collect a report that was submitted earlier. Because a download URL is only
 * valid for ~5 minutes, this always re-polls for a fresh one rather than
 * caching the URL from a previous call.
 */
export async function getSubmittedReport(
  reportRequestId: string,
  ids: Scope,
  format: "Csv" | "Tsv" = "Csv",
  maxRows = Number.POSITIVE_INFINITY,
): Promise<RunReportResult> {
  const settled = await settleReport(
    reportRequestId,
    await pollReport(reportRequestId, ids),
    ids,
    { format, maxRows, warnings: [], waitedMs: () => 0 },
  );
  return (
    settled ?? {
      status: "pending",
      reportRequestId,
      warnings: [],
      waitedMs: 0,
      message: "Still generating. Try again shortly.",
    }
  );
}
