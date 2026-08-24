import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAuthForTesting } from "@/auth/oauth";
import { resetEnvForTesting } from "@/config/env";
import {
  buildHeaders,
  msadsFetch,
  retryAfterMs,
  retryDelayMs,
  serviceBaseUrl,
} from "@/services/msads-api";
import { ErrorCode, MsAdsError } from "@/utils/errors";
import { installMockFetch, type MockFetch, setTestEnv, tokenResponse } from "./_mock";

let mock: MockFetch;

beforeEach(() => {
  setTestEnv();
  resetEnvForTesting();
  resetAuthForTesting();
  mock = installMockFetch();
  mock.always("login.microsoftonline.com", tokenResponse());
});

afterEach(() => mock.restore());

describe("serviceBaseUrl", () => {
  test("maps each service to its own host", () => {
    expect(serviceBaseUrl("CampaignManagement")).toBe(
      "https://campaign.api.bingads.microsoft.com/CampaignManagement/v13",
    );
    expect(serviceBaseUrl("Reporting")).toBe(
      "https://reporting.api.bingads.microsoft.com/Reporting/v13",
    );
    expect(serviceBaseUrl("AdInsight")).toBe(
      "https://adinsight.api.bingads.microsoft.com/AdInsight/v13",
    );
  });

  test("Customer Management and Billing share the clientcenter host", () => {
    expect(serviceBaseUrl("CustomerManagement")).toContain("clientcenter.api.bingads");
    expect(serviceBaseUrl("CustomerBilling")).toContain("clientcenter.api.bingads");
  });

  test("Bulk uses the short /Bulk/v13 path, not the SOAP CampaignManagement path", () => {
    expect(serviceBaseUrl("Bulk")).toBe(
      "https://bulk.api.bingads.microsoft.com/Bulk/v13",
    );
  });

  test("sandbox swaps in the sandbox domain", () => {
    setTestEnv({ MSADS_ENVIRONMENT: "sandbox" });
    resetEnvForTesting();
    expect(serviceBaseUrl("CampaignManagement")).toBe(
      "https://campaign.api.sandbox.bingads.microsoft.com/CampaignManagement/v13",
    );
  });
});

describe("buildHeaders", () => {
  test("sends Bearer-prefixed auth and the developer token", async () => {
    const h = await buildHeaders("CampaignManagement");
    expect(h.Authorization).toBe("Bearer test-access-token");
    expect(h.DeveloperToken).toBe("test-dev-token");
  });

  test("sends account headers for account-scoped services", async () => {
    setTestEnv({ MSADS_CUSTOMER_ID: "9", MSADS_ACCOUNT_ID: "42" });
    resetEnvForTesting();
    const h = await buildHeaders("CampaignManagement");
    expect(h.CustomerId).toBe("9");
    expect(h.CustomerAccountId).toBe("42");
  });

  test("omits account headers for Customer Management, which rejects them", async () => {
    setTestEnv({ MSADS_CUSTOMER_ID: "9", MSADS_ACCOUNT_ID: "42" });
    resetEnvForTesting();
    const h = await buildHeaders("CustomerManagement");
    expect(h.CustomerId).toBeUndefined();
    expect(h.CustomerAccountId).toBeUndefined();
  });

  test("omits account headers for Customer Billing too", async () => {
    setTestEnv({ MSADS_CUSTOMER_ID: "9", MSADS_ACCOUNT_ID: "42" });
    resetEnvForTesting();
    const h = await buildHeaders("CustomerBilling");
    expect(h.CustomerId).toBeUndefined();
  });

  test("per-call ids override the env defaults", async () => {
    setTestEnv({ MSADS_ACCOUNT_ID: "42" });
    resetEnvForTesting();
    const h = await buildHeaders("Reporting", { accountId: "777", customerId: "888" });
    expect(h.CustomerAccountId).toBe("777");
    expect(h.CustomerId).toBe("888");
  });

  test("falls back to the universal sandbox developer token", async () => {
    setTestEnv({ MSADS_ENVIRONMENT: "sandbox", MSADS_DEVELOPER_TOKEN: undefined });
    resetEnvForTesting();
    expect((await buildHeaders("Reporting")).DeveloperToken).toBe("BBD37VB98");
  });

  test("refuses to run in production without a developer token", async () => {
    setTestEnv({ MSADS_DEVELOPER_TOKEN: undefined });
    resetEnvForTesting();
    expect(buildHeaders("Reporting")).rejects.toThrow(
      /MSADS_DEVELOPER_TOKEN is required/,
    );
  });
});

describe("msadsFetch", () => {
  test("POSTs JSON and returns the parsed body", async () => {
    mock.queue("CampaignManagement", { json: { CampaignIds: ["1"] } });
    const res = await msadsFetch<{ CampaignIds: string[] }>(
      "CampaignManagement",
      "Campaigns",
      { body: { AccountId: "1" } },
    );
    expect(res.CampaignIds).toEqual(["1"]);
    const call = mock.callsTo("CampaignManagement")[0];
    expect(call?.method).toBe("POST");
    expect(call?.body).toEqual({ AccountId: "1" });
  });

  test("defaults to POST because reads are POSTs in this API", async () => {
    mock.queue("CustomerManagement", { json: {} });
    await msadsFetch("CustomerManagement", "User/Query", { body: { UserId: null } });
    expect(mock.callsTo("CustomerManagement")[0]?.method).toBe("POST");
  });

  test("throws a typed MsAdsError carrying the tracking id", async () => {
    mock.queue("CampaignManagement", {
      status: 400,
      json: {
        OperationErrors: [{ Code: 106, ErrorCode: "UserIsNotAuthorized" }],
        TrackingId: "trace-9",
      },
    });
    const err = (await msadsFetch("CampaignManagement", "Campaigns", {
      retries: 0,
    }).catch((e) => e)) as MsAdsError;
    expect(err).toBeInstanceOf(MsAdsError);
    expect(err.trackingId).toBe("trace-9");
    expect(err.has(ErrorCode.UserIsNotAuthorized)).toBe(true);
  });

  test("refreshes the token and replays once on error 109", async () => {
    mock.queue(
      "CampaignManagement",
      { status: 401, json: { Errors: [{ Code: 109 }] } },
      { json: { ok: true } },
    );
    const res = await msadsFetch<{ ok: boolean }>("CampaignManagement", "Campaigns");
    expect(res.ok).toBe(true);
    // Two token fetches: the initial one, then the forced refresh after 109.
    expect(mock.callsTo("login.microsoftonline.com").length).toBe(2);
    expect(mock.callsTo("CampaignManagement").length).toBe(2);
  });

  test("does not loop forever when 109 repeats", async () => {
    mock.always("CampaignManagement", { status: 401, json: { Errors: [{ Code: 109 }] } });
    await expect(
      msadsFetch("CampaignManagement", "Campaigns", { retries: 0 }),
    ).rejects.toThrow(/AuthenticationTokenExpired/);
    expect(mock.callsTo("CampaignManagement").length).toBe(2);
  });

  test("retries an explicitly safe poll after a 500", async () => {
    mock.queue(
      "Reporting",
      { status: 500, text: "boom", headers: { "retry-after": "0" } },
      { json: { done: true } },
    );
    const res = await msadsFetch<{ done: boolean }>("Reporting", "GenerateReport/Poll", {
      retry: "safe",
    });
    expect(res.done).toBe(true);
    expect(mock.callsTo("Reporting").length).toBe(2);
  });

  test("does not retry a non-transient 400", async () => {
    mock.queue("Reporting", {
      status: 400,
      json: { Errors: [{ Code: 2015, ErrorCode: "RequiredColumnsNotSelected" }] },
    });
    await expect(
      msadsFetch("Reporting", "GenerateReport/Poll", { retry: "safe" }),
    ).rejects.toThrow(/RequiredColumnsNotSelected/);
    expect(mock.callsTo("Reporting").length).toBe(1);
  });

  test("surfaces a timeout with a message naming the tunable", async () => {
    mock.always("Reporting", { networkError: "The operation was aborted" });
    await expect(
      msadsFetch("Reporting", "GenerateReport/Poll", { retries: 0 }),
    ).rejects.toThrow(/Network error|timed out/);
  });
});

describe("backoff", () => {
  test("waits far longer for a rate-limit code than a generic failure", () => {
    const rateLimited = new MsAdsError({
      message: "x",
      errors: [{ code: ErrorCode.CallRateExceeded }],
    });
    // Microsoft's window is 60 seconds; a 1s retry just burns another call.
    expect(retryDelayMs(0, rateLimited)).toBeGreaterThanOrEqual(10_000);
    expect(retryDelayMs(0)).toBeLessThan(2000);
  });

  test("caps rate-limit backoff at a minute", () => {
    const err = new MsAdsError({
      message: "x",
      errors: [{ code: ErrorCode.CallRateExceeded }],
    });
    expect(retryDelayMs(10, err)).toBeLessThanOrEqual(60_500);
  });

  test("backs off longer for concurrent-report and bulk throttles", () => {
    const bulk = new MsAdsError({
      message: "x",
      errors: [{ code: ErrorCode.BulkNoMoreCallsPermitted }],
    });
    expect(retryDelayMs(0, bulk)).toBeGreaterThanOrEqual(15_000);
  });

  test("grows exponentially across attempts", () => {
    expect(retryDelayMs(2)).toBeGreaterThan(retryDelayMs(0));
  });

  test("reads Retry-After in seconds", () => {
    expect(retryAfterMs(new Headers({ "retry-after": "30" }))).toBe(30_000);
  });

  test("reads Retry-After as an HTTP date", () => {
    const future = new Date(Date.now() + 20_000).toUTCString();
    const ms = retryAfterMs(new Headers({ "retry-after": future }));
    expect(ms).toBeGreaterThan(10_000);
  });

  test("returns null when the header is absent or junk", () => {
    expect(retryAfterMs(new Headers())).toBeNull();
    expect(retryAfterMs(new Headers({ "retry-after": "soon" }))).toBeNull();
  });
});
