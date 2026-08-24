import { describe, expect, test } from "bun:test";
import { accountDirectory, getUser } from "@/services/accounts";
import * as cm from "@/services/campaigns";
import { REPORT_TYPE_NAMES } from "@/services/report-types";
import { runReport } from "@/services/reporting";
import { getTestAccountId, liveSkipReason, liveTestsEnabled, testIds } from "./_helpers";

/**
 * Read-only checks against the real API. Safe to run against a production
 * account: nothing here writes.
 */
describe.skipIf(!liveTestsEnabled())(`[live] reads (${liveSkipReason()})`, () => {
  test("authenticates and identifies the user", async () => {
    const user = await getUser();
    expect(user.Id).toBeTruthy();
  });

  test("the configured test account is reachable", async () => {
    const directory = await accountDirectory();
    const match = directory.find((a) => String(a.Id) === getTestAccountId());
    expect(
      match,
      `MSADS_TEST_ACCOUNT_ID ${getTestAccountId()} is not visible to these credentials`,
    ).toBeDefined();
    // The customer pairing is what makes every account-scoped call work.
    expect(match?.CustomerId).toBeTruthy();
  });

  test("lists campaigns", async () => {
    const campaigns = await cm.getCampaignsByAccount(await testIds());
    expect(Array.isArray(campaigns)).toBe(true);
  });

  test("runs a campaign performance report end to end", async () => {
    const result = await runReport(
      { reportType: "campaign_performance", accountId: getTestAccountId() },
      await testIds(),
      { timeoutMs: 180_000 },
    );
    // no_data is a legitimate outcome for a fresh or paused account.
    expect(["complete", "no_data", "pending"]).toContain(result.status);
    if (result.status === "complete") {
      expect(result.report?.columns.length).toBeGreaterThan(0);
    }
  }, 200_000);

  /**
   * Every registered type is expected to work in BOTH environments. The
   * catalog once carried msclkid_performance, which production rejected with
   * UnknownReportType exactly as the sandbox did — the request class
   * deserializes, but the service serves it nowhere — so it was removed
   * rather than shipped as a tool argument that can never succeed.
   */
  const EXPECTED_UNSUPPORTED = new Map<string, string>();

  test("validates every registered report type serially for this environment", async () => {
    // Wait for each report before submitting the next one. One-millisecond
    // submission budgets leave jobs running and cause the test itself to hit
    // Microsoft's concurrent-report throttle.
    const ids = await testIds();
    const unexpected: string[] = [];
    for (const name of REPORT_TYPE_NAMES) {
      const expectedError = EXPECTED_UNSUPPORTED.get(name);
      const error = await runReport(
        { reportType: name, accountId: getTestAccountId() },
        ids,
        { timeoutMs: 120_000 },
      ).then(
        () => null,
        (caught: Error) => caught,
      );

      if (expectedError) {
        if (!error?.message.includes(expectedError)) {
          unexpected.push(
            `${name}: expected ${expectedError}, got ${error?.message ?? "accepted"}`,
          );
        }
      } else if (error) {
        unexpected.push(`${name}: ${error.message}`);
      }
    }
    expect(unexpected).toEqual([]);
  }, 3_900_000);
});
