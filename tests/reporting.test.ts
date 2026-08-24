import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAuthForTesting } from "@/auth/oauth";
import { resetEnvForTesting } from "@/config/env";
import { REPORT_TYPE_NAMES, REPORT_TYPES } from "@/services/report-types";
import {
  buildReportRequest,
  buildScope,
  getSubmittedReport,
  pollDelayMs,
  runReport,
  toMsDate,
} from "@/services/reporting";
import { installMockFetch, type MockFetch, setTestEnv, tokenResponse } from "./_mock";
import { MS_REPORT_ZIP } from "./fixtures/zip-archives";

let mock: MockFetch;
const IDS = { accountId: "512300", customerId: "9900" };

beforeEach(() => {
  setTestEnv();
  resetEnvForTesting();
  resetAuthForTesting();
  mock = installMockFetch();
  mock.always("login.microsoftonline.com", tokenResponse());
});
afterEach(() => mock.restore());

describe("toMsDate", () => {
  test("converts an ISO date to the API's date object", () => {
    expect(toMsDate("2026-08-17")).toEqual({ Year: 2026, Month: 8, Day: 17 });
  });

  test("rejects a non-ISO string", () => {
    expect(() => toMsDate("17/08/2026")).toThrow(/YYYY-MM-DD/);
  });

  test("rejects a date that does not exist", () => {
    expect(() => toMsDate("2026-02-31")).toThrow(/not a real calendar date/);
  });

  test("accepts a real leap day", () => {
    expect(toMsDate("2024-02-29").Day).toBe(29);
  });
});

describe("buildScope", () => {
  test("account scope carries only account ids", () => {
    expect(buildScope("account", {}, "42")).toEqual({ AccountIds: ["42"] });
  });

  test("campaign scope pairs each campaign with its account", () => {
    expect(buildScope("campaign", { campaignIds: ["7"] }, "42")).toEqual({
      Campaigns: [{ AccountId: "42", CampaignId: "7" }],
    });
  });

  test("ad group scope pairs each ad group with its account", () => {
    expect(buildScope("adgroup", { adGroupIds: ["3"] }, "42")).toEqual({
      AdGroups: [{ AccountId: "42", AdGroupId: "3" }],
    });
  });

  test("falls back to the whole account when no children are named", () => {
    expect(buildScope("adgroup", {}, "42")).toEqual({ AccountIds: ["42"] });
  });

  test("refuses campaign narrowing on an account-only report", () => {
    expect(() => buildScope("account", { campaignIds: ["7"] }, "42")).toThrow(
      /whole accounts only/,
    );
  });

  test("refuses ad group narrowing on a campaign-scoped report", () => {
    expect(() => buildScope("campaign", { adGroupIds: ["3"] }, "42")).toThrow(
      /not ad groups/,
    );
  });

  test("enforces the documented scope caps with a message naming the limit", () => {
    const many = Array.from({ length: 301 }, (_, i) => String(i));
    expect(() => buildScope("adgroup", { campaignIds: many }, "42")).toThrow(
      /at most 300/,
    );
  });
});

describe("buildReportRequest", () => {
  const base = { reportType: "campaign_performance", accountId: "42" };

  test("emits the derived request type, never the base type", () => {
    const { body } = buildReportRequest(base);
    const req = (body as any).ReportRequest;
    expect(req.Type).toBe("CampaignPerformanceReportRequest");
  });

  test("uses FormatVersion 2.0 and drops the copyright footer", () => {
    const req = (buildReportRequest(base).body as any).ReportRequest;
    expect(req.FormatVersion).toBe("2.0");
    expect(req.ExcludeReportFooter).toBe(true);
    // The header block carries the incomplete-data flag, so it stays.
    expect(req.ExcludeReportHeader).toBe(false);
  });

  test("adds TimePeriod for a non-Summary aggregation and says why", () => {
    const { body, warnings } = buildReportRequest({
      ...base,
      aggregation: "Daily",
      columns: ["CampaignName", "Clicks"],
    });
    const req = (body as any).ReportRequest;
    expect(req.Columns).toContain("TimePeriod");
    expect(warnings.join(" ")).toContain("silently ignores");
  });

  test("rejects TimePeriod with Summary aggregation (error 2034)", () => {
    expect(() =>
      buildReportRequest({
        ...base,
        aggregation: "Summary",
        columns: ["TimePeriod", "Clicks"],
      }),
    ).toThrow(/2034/);
  });

  test("warns that deprecated conversion columns always return zero", () => {
    const { warnings } = buildReportRequest({
      ...base,
      columns: ["CampaignName", "Conversions"],
    });
    expect(warnings.join(" ")).toContain("ConversionsQualified");
  });

  test("defaults to a predefined time period", () => {
    const req = (buildReportRequest(base).body as any).ReportRequest;
    expect(req.Time.PredefinedTime).toBe("LastSevenDays");
  });

  test("rejects mixing a predefined period with a custom range (error 2008)", () => {
    expect(() =>
      buildReportRequest({
        ...base,
        predefinedTime: "LastSevenDays",
        startDate: "2026-08-01",
        endDate: "2026-08-07",
      }),
    ).toThrow(/2008/);
  });

  test("requires both ends of a custom range", () => {
    expect(() => buildReportRequest({ ...base, startDate: "2026-08-01" })).toThrow(
      /both start_date and end_date/,
    );
  });

  test("rejects an inverted range", () => {
    expect(() =>
      buildReportRequest({ ...base, startDate: "2026-08-09", endDate: "2026-08-01" }),
    ).toThrow(/is after/);
  });

  test("rejects a future end date (error 2041)", () => {
    expect(() =>
      buildReportRequest({ ...base, startDate: "2026-01-01", endDate: "2099-01-01" }),
    ).toThrow(/future/);
  });

  test("converts a custom range into date objects", () => {
    const req = (
      buildReportRequest({ ...base, startDate: "2026-08-01", endDate: "2026-08-07" })
        .body as any
    ).ReportRequest;
    expect(req.Time.CustomDateRangeStart).toEqual({ Year: 2026, Month: 8, Day: 1 });
    expect(req.Time.PredefinedTime).toBeUndefined();
  });

  test("rejects custom ranges for hourly and weekday aggregations locally", () => {
    for (const aggregation of ["HourOfDay", "DayOfWeek"] as const) {
      expect(() =>
        buildReportRequest({
          ...base,
          aggregation,
          startDate: "2026-08-01",
          endDate: "2026-08-07",
        }),
      ).toThrow(/does not support custom date ranges/);
    }
  });

  test("omits Aggregation for report types that have no such element", () => {
    const req = (
      buildReportRequest({ reportType: "budget_summary", accountId: "42" }).body as any
    ).ReportRequest;
    expect(req.Aggregation).toBeUndefined();
  });

  test("omits Time for snapshot report types and says so", () => {
    const { body, warnings } = buildReportRequest({
      reportType: "negative_keyword_conflicts",
      accountId: "42",
      predefinedTime: "LastSevenDays",
    });
    expect((body as any).ReportRequest.Time).toBeUndefined();
    expect(warnings.join(" ")).toContain("ignores any time range");
  });

  test("only sends MaxRows for the report type that supports it", () => {
    const kw = (
      buildReportRequest({
        reportType: "keyword_performance",
        accountId: "42",
        maxRows: 50,
      }).body as any
    ).ReportRequest;
    expect(kw.MaxRows).toBe(50);

    const camp = buildReportRequest({ ...base, maxRows: 50 });
    expect((camp.body as any).ReportRequest.MaxRows).toBeUndefined();
    expect(camp.warnings.join(" ")).toContain("client-side");
  });

  test("rejects complete-data-only when the range includes today (error 2004)", () => {
    expect(() =>
      buildReportRequest({
        ...base,
        predefinedTime: "Today",
        returnOnlyCompleteData: true,
      }),
    ).toThrow(/2004/);
  });

  test("every registered report type builds without throwing", () => {
    for (const name of REPORT_TYPE_NAMES) {
      const built = buildReportRequest({ reportType: name, accountId: "42" });
      const req = (built.body as any).ReportRequest;
      expect(req.Type).toBe(REPORT_TYPES[name]!.requestType);
      expect(req.Columns.length).toBeGreaterThan(0);
      expect(req.Scope).toBeDefined();
    }
  });

  test("names the valid options when given an unknown report type", () => {
    expect(() => buildReportRequest({ reportType: "nope", accountId: "42" })).toThrow(
      /Available: /,
    );
  });
});

describe("pollDelayMs", () => {
  test("polls fast at first so small reports return quickly", () => {
    expect(pollDelayMs(0, 2000)).toBe(1000);
    expect(pollDelayMs(4, 2000)).toBe(1000);
  });

  test("backs off after the initial burst", () => {
    expect(pollDelayMs(6, 2000)).toBeGreaterThanOrEqual(2000);
    expect(pollDelayMs(30, 2000)).toBeGreaterThan(pollDelayMs(6, 2000));
  });

  test("caps the interval so a long report is still checked regularly", () => {
    expect(pollDelayMs(500, 2000)).toBeLessThanOrEqual(30_000);
  });
});

describe("runReport end to end", () => {
  test("submits, polls until success, downloads, unzips, and parses", async () => {
    mock.queue("GenerateReport/Submit", { json: { ReportRequestId: "rq-1" } });
    mock.queue(
      "GenerateReport/Poll",
      { json: { ReportRequestStatus: { Status: "Pending" } } },
      {
        json: {
          ReportRequestStatus: {
            Status: "Success",
            ReportDownloadUrl: "https://93.184.216.36/rq-1.zip",
          },
        },
      },
    );
    mock.always("93.184.216.36", {
      text: Buffer.from(MS_REPORT_ZIP, "base64").toString("binary"),
    });

    // The mock returns text; give the client the real bytes instead.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      if (url.includes("93.184.216.36")) {
        return new Response(Buffer.from(MS_REPORT_ZIP, "base64"), { status: 200 });
      }
      return realFetch(input, init);
    }) as typeof fetch;

    const result = await runReport(
      { reportType: "campaign_performance", accountId: "512300", aggregation: "Daily" },
      IDS,
      { pollMs: 1 },
    );

    expect(result.status).toBe("complete");
    expect(result.reportRequestId).toBe("rq-1");
    expect(result.report?.rows).toHaveLength(3);
    expect(result.report?.columns).toContain("ConversionsQualified");
    expect(result.report?.rows[0]?.CampaignName).toBe("Brand - Exact");
    // The quoted comma inside a campaign name must survive parsing.
    expect(result.report?.rows[2]?.CampaignName).toBe("Shopping, All Products");
    expect(result.report?.potentiallyIncomplete).toBe(false);
  });

  test("retains only the requested rows while preserving the report total", async () => {
    mock.queue("GenerateReport/Submit", { json: { ReportRequestId: "rq-bounded" } });
    mock.queue("GenerateReport/Poll", {
      json: {
        ReportRequestStatus: {
          Status: "Success",
          ReportDownloadUrl: "https://93.184.216.36/bounded.zip",
        },
      },
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("93.184.216.36")
        ? new Response(Buffer.from(MS_REPORT_ZIP, "base64"))
        : realFetch(input, init)) as typeof fetch;

    const result = await runReport(
      { reportType: "campaign_performance", accountId: "512300" },
      IDS,
      { pollMs: 1, maxRows: 1 },
    );
    expect(result.report?.rows).toHaveLength(1);
    expect(result.report?.totalRows).toBe(3);
  });

  test("re-polls once when a report download URL has expired", async () => {
    mock.queue("GenerateReport/Submit", { json: { ReportRequestId: "rq-expired" } });
    mock.queue(
      "GenerateReport/Poll",
      {
        json: {
          ReportRequestStatus: {
            Status: "Success",
            ReportDownloadUrl: "https://93.184.216.36/expired.zip",
          },
        },
      },
      {
        json: {
          ReportRequestStatus: {
            Status: "Success",
            ReportDownloadUrl: "https://93.184.216.36/fresh.zip",
          },
        },
      },
    );
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("expired.zip")) return new Response(null, { status: 403 });
      if (url.endsWith("fresh.zip")) {
        return new Response(Buffer.from(MS_REPORT_ZIP, "base64"));
      }
      return realFetch(input, init);
    }) as typeof fetch;

    const result = await runReport(
      { reportType: "campaign_performance", accountId: "512300" },
      IDS,
      { pollMs: 1, maxRows: 2 },
    );
    expect(result.report?.rows).toHaveLength(2);
    expect(mock.callsTo("GenerateReport/Poll")).toHaveLength(2);
  });

  test("reports zero rows as no_data, not as an error", async () => {
    mock.queue("GenerateReport/Submit", { json: { ReportRequestId: "rq-2" } });
    mock.queue("GenerateReport/Poll", {
      // Success with a null URL is Microsoft's documented "no rows" signal.
      json: { ReportRequestStatus: { Status: "Success", ReportDownloadUrl: null } },
    });

    const result = await runReport(
      { reportType: "campaign_performance", accountId: "512300" },
      IDS,
      { pollMs: 1 },
    );
    expect(result.status).toBe("no_data");
    expect(result.message).toContain("zero rows");
  });

  test("returns a resumable id instead of throwing when the budget runs out", async () => {
    mock.queue("GenerateReport/Submit", { json: { ReportRequestId: "rq-3" } });
    mock.always("GenerateReport/Poll", {
      json: { ReportRequestStatus: { Status: "Pending" } },
    });

    const result = await runReport(
      { reportType: "campaign_performance", accountId: "512300" },
      IDS,
      { timeoutMs: 10, pollMs: 1 },
    );
    expect(result.status).toBe("pending");
    expect(result.reportRequestId).toBe("rq-3");
    expect(result.message).toContain("get_report");
  });

  test("surfaces a server-side report failure", async () => {
    mock.queue("GenerateReport/Submit", { json: { ReportRequestId: "rq-4" } });
    mock.queue("GenerateReport/Poll", {
      json: { ReportRequestStatus: { Status: "Error" } },
    });
    await expect(
      runReport({ reportType: "campaign_performance", accountId: "512300" }, IDS, {
        pollMs: 1,
      }),
    ).rejects.toThrow(/failed server-side/);
  });

  test("get_report re-polls for a fresh URL rather than reusing a stale one", async () => {
    mock.queue("GenerateReport/Poll", {
      json: { ReportRequestStatus: { Status: "Pending" } },
    });
    const result = await getSubmittedReport("rq-5", IDS);
    expect(result.status).toBe("pending");
    expect(mock.callsTo("GenerateReport/Poll")).toHaveLength(1);
  });
});
