import { getEnv } from "@/config/env";
import { downloadFile, msadsFetch } from "@/services/msads-api";
import {
  type Aggregation,
  getReportType,
  type PredefinedTime,
  type ScopeKind,
} from "@/services/report-types";
import { type ParsedReport, parseReportCsv } from "@/utils/csv";
import { MsAdsError } from "@/utils/errors";
import { log } from "@/utils/logger";
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

/** Microsoft's `Date` is an object, not a string. */
export interface MsDate {
  Day: number;
  Month: number;
  Year: number;
}

/** Convert `YYYY-MM-DD` into the API's date object. */
export function toMsDate(iso: string): MsDate {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) {
    throw new MsAdsError({
      message: `Invalid date "${iso}". Use YYYY-MM-DD.`,
    });
  }
  const [, year, month, day] = m;
  const date = {
    Year: Number(year),
    Month: Number(month),
    Day: Number(day),
  };
  // Reject 2026-02-31 and friends before the API does, with a clearer message.
  const probe = new Date(Date.UTC(date.Year, date.Month - 1, date.Day));
  if (
    probe.getUTCFullYear() !== date.Year ||
    probe.getUTCMonth() !== date.Month - 1 ||
    probe.getUTCDate() !== date.Day
  ) {
    throw new MsAdsError({ message: `"${iso}" is not a real calendar date.` });
  }
  return date;
}

export interface ScopeInput {
  accountIds?: string[];
  campaignIds?: string[];
  adGroupIds?: string[];
  assetGroupIds?: string[];
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
 */
export function buildScope(
  kind: ScopeKind,
  input: ScopeInput,
  accountId: string,
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

  if (kind === "assetgroup") {
    if (input.assetGroupIds?.length) {
      return {
        AssetGroups: input.assetGroupIds.map((id) => ({
          AccountId: accountId,
          AssetGroupId: id,
        })),
      };
    }
    return campaigns?.length ? { Campaigns: campaigns } : { AccountIds: accountIds };
  }

  // adgroup
  if (input.adGroupIds?.length) {
    return {
      AdGroups: input.adGroupIds.map((id) => ({
        AccountId: accountId,
        AdGroupId: id,
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

  const aggregation = input.aggregation ?? (spec.noAggregation ? undefined : "Daily");

  // Error 2034: TimePeriod with Summary. The inverse — omitting TimePeriod for
  // a non-Summary aggregation — is worse, because the API silently downgrades
  // to Summary and the caller gets numbers that don't mean what they asked for.
  if (aggregation && aggregation !== "Summary" && !spec.noTimePeriodColumn) {
    if (!columns.includes("TimePeriod")) {
      columns.unshift("TimePeriod");
      warnings.push(
        `Added the TimePeriod column: without it the API silently ignores "${aggregation}" aggregation and returns a Summary.`,
      );
    }
  } else if (columns.includes("TimePeriod")) {
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
    Scope: buildScope(spec.scope, input.scope ?? {}, input.accountId),
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
    const today = new Date().toISOString().slice(0, 10);
    if (input.endDate > today) {
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
  ids: { accountId: string; customerId?: string },
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
  ids: { accountId: string; customerId?: string },
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
  ids: { accountId: string; customerId?: string },
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
 * Run a report to completion within a time budget.
 *
 * On timeout this returns `status: "pending"` with the report id rather than
 * throwing: the report is still being generated server-side and the caller can
 * pick it up with `get_report` instead of paying for it twice.
 */
export async function runReport(
  input: ReportRequestInput,
  ids: { accountId: string; customerId?: string },
  opts: { timeoutMs?: number; pollMs?: number; maxRows?: number } = {},
): Promise<RunReportResult> {
  const env = getEnv();
  const timeoutMs = opts.timeoutMs ?? env.MSADS_REPORT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? env.MSADS_REPORT_POLL_MS;

  const { body, warnings } = buildReportRequest(input);
  const { reportRequestId } = await submitReport(body, ids);
  log.info(`Report ${input.reportType} submitted as ${reportRequestId}`);

  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    const result = await pollReport(reportRequestId, ids);

    if (result.status === "Error") {
      throw new MsAdsError({
        message:
          `Report ${reportRequestId} failed server-side. Resubmitting sometimes clears a transient failure; ` +
          "if it keeps failing, the column or filter combination is likely invalid for this report type.",
      });
    }

    if (result.status === "Success") {
      // A null URL on Success is the documented "no rows matched" signal, not
      // an error. Reporting it as an error would be actively misleading.
      if (!result.downloadUrl) {
        return {
          status: "no_data",
          reportRequestId,
          warnings,
          waitedMs: Date.now() - started,
          message:
            "The report generated successfully but matched zero rows for these parameters.",
        };
      }
      const report = await fetchReportWithFreshUrl(
        reportRequestId,
        result.downloadUrl,
        ids,
        input.format ?? "Csv",
        opts.maxRows ?? Number.POSITIVE_INFINITY,
      );
      return {
        status: "complete",
        reportRequestId,
        report,
        warnings,
        waitedMs: Date.now() - started,
      };
    }

    if (Date.now() - started >= timeoutMs) {
      return {
        status: "pending",
        reportRequestId,
        warnings,
        waitedMs: Date.now() - started,
        message:
          `Still generating after ${Math.round((Date.now() - started) / 1000)}s. The report is not lost — ` +
          `call get_report with report_request_id "${reportRequestId}" to collect it. ` +
          "The id stays valid for about a day.",
      };
    }

    await new Promise((r) => setTimeout(r, pollDelayMs(attempt, pollMs)));
  }
}

/**
 * Collect a report that was submitted earlier. Because a download URL is only
 * valid for ~5 minutes, this always re-polls for a fresh one rather than
 * caching the URL from a previous call.
 */
export async function getSubmittedReport(
  reportRequestId: string,
  ids: { accountId: string; customerId?: string },
  format: "Csv" | "Tsv" = "Csv",
  maxRows = Number.POSITIVE_INFINITY,
): Promise<RunReportResult> {
  const result = await pollReport(reportRequestId, ids);

  if (result.status === "Pending") {
    return {
      status: "pending",
      reportRequestId,
      warnings: [],
      waitedMs: 0,
      message: "Still generating. Try again shortly.",
    };
  }
  if (result.status === "Error") {
    throw new MsAdsError({
      message: `Report ${reportRequestId} failed server-side. Submit a new one.`,
    });
  }
  if (!result.downloadUrl) {
    return {
      status: "no_data",
      reportRequestId,
      warnings: [],
      waitedMs: 0,
      message: "The report completed but matched zero rows.",
    };
  }
  return {
    status: "complete",
    reportRequestId,
    report: await fetchReportWithFreshUrl(
      reportRequestId,
      result.downloadUrl,
      ids,
      format,
      maxRows,
    ),
    warnings: [],
    waitedMs: 0,
  };
}
