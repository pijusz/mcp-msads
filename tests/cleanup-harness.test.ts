import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAuthForTesting } from "@/auth/oauth";
import { resetEnvForTesting } from "@/config/env";
import type { BatchResult } from "@/utils/batch";
import { installMockFetch, type MockFetch, setTestEnv, tokenResponse } from "./_mock";
import {
  assertCleanupComplete,
  createRegistry,
  inspectCleanupResult,
} from "./live/_helpers";

let mock: MockFetch;

beforeEach(() => {
  setTestEnv({ MSADS_TEST_ACCOUNT_ID: "123", MSADS_CUSTOMER_ID: "456" });
  resetEnvForTesting();
  resetAuthForTesting();
  mock = installMockFetch();
  mock.always("login.microsoftonline.com", tokenResponse());
});

afterEach(() => mock.restore());

function batch(outcomes: BatchResult["outcomes"]): BatchResult {
  const submitted = outcomes.filter((outcome) => outcome.index >= 0).length;
  const succeeded = outcomes.filter(
    (outcome) => outcome.index >= 0 && outcome.success,
  ).length;
  return {
    submitted,
    succeeded,
    failed: submitted - succeeded,
    all_failed: submitted > 0 && succeeded === 0,
    ids: outcomes
      .filter((outcome) => outcome.success && outcome.id)
      .map((outcome) => outcome.id!),
    outcomes,
  };
}

describe("live cleanup accounting", () => {
  test("counts only confirmed success and explicit already-absent outcomes", () => {
    const result = inspectCleanupResult(
      ["10", "11", "12"],
      batch([
        { index: 0, success: true, id: "10" },
        {
          index: 1,
          success: false,
          error: {
            code: 1044,
            error_code: "CampaignServiceEntityDoesNotExist",
            message: "already absent",
          },
        },
        { index: 2, success: false, error: { message: "permission denied" } },
      ]),
      "campaign",
    );

    expect(result.cleanedIds).toEqual(["10", "11"]);
    expect(result.failedIds).toEqual(["12"]);
    expect(result.failures).toEqual(["12: permission denied"]);
    expect(() => assertCleanupComplete(result, "campaign(s)")).toThrow(
      /left 1 campaign\(s\)/,
    );
  });

  test("does not infer absence from ambiguous identity or permission failures", () => {
    for (const error of [
      { error_code: "InvalidCustomerId", message: "Invalid customer id" },
      { error_code: "InvalidAccountId", message: "Invalid account id" },
      { error_code: "InvalidCredentials", message: "Invalid credential id" },
      { error_code: "UserIsNotAuthorized", message: "Campaign id does not exist" },
      {
        code: 105,
        error_code: "CampaignServiceEntityDoesNotExist",
        message: "credential failure with a conflicting name",
      },
      {
        code: 1044,
        error_code: "UserIsNotAuthorized",
        message: "absence code with a conflicting name",
      },
    ]) {
      const result = inspectCleanupResult(
        ["42"],
        batch([{ index: 0, success: false, error }]),
        "campaign",
      );
      expect(result.cleanedIds, error.error_code).toEqual([]);
      expect(result.failedIds, error.error_code).toEqual(["42"]);
    }
  });

  test("does not treat a mixed absence and permission outcome as absent", () => {
    const result = inspectCleanupResult(
      ["42"],
      batch([
        {
          index: 0,
          success: false,
          error: { code: 1044, message: "already absent" },
          errors: [
            { code: 1044, message: "already absent" },
            { code: 106, message: "permission denied" },
          ],
        },
      ]),
      "campaign",
    );

    expect(result.cleanedIds).toEqual([]);
    expect(result.failedIds).toEqual(["42"]);
  });

  test("uses the documented entity-absence code and name", () => {
    const campaign = inspectCleanupResult(
      ["10"],
      batch([{ index: 0, success: false, error: { code: 1044 } }]),
      "campaign",
    );
    const adGroup = inspectCleanupResult(
      ["11"],
      batch([
        {
          index: 0,
          success: false,
          error: { error_code: "CampaignServiceEntityDoesNotExist" },
        },
      ]),
      "ad_group",
    );
    expect(campaign.cleanedIds).toEqual(["10"]);
    expect(adGroup.cleanedIds).toEqual(["11"]);
  });

  test("keeps failed ids registered, fails teardown, and retries them", async () => {
    const registry = createRegistry();
    registry.trackCampaign("9007199254740993");
    mock.queue(
      "Campaigns",
      {
        json: {
          PartialErrors: [
            { Index: 0, ErrorCode: "UserIsNotAuthorized", Message: "denied" },
          ],
        },
      },
      { json: {} },
    );

    await expect(registry.cleanup()).rejects.toThrow(/left 1 registered entity id/);
    await expect(registry.cleanup()).resolves.toEqual({ deleted: 1, failed: 0 });
    expect(mock.callsTo("Campaigns")).toHaveLength(2);
  });

  test("retains every submitted id after mixed request-level cleanup errors", async () => {
    const registry = createRegistry();
    registry.trackCampaign("7000000000000001");
    registry.trackCampaign("7000000000000002");
    mock.queue(
      "Campaigns",
      {
        status: 400,
        json: {
          OperationErrors: [
            {
              Code: 1044,
              ErrorCode: "CampaignServiceEntityDoesNotExist",
              Message: "already absent",
            },
            { Code: 106, ErrorCode: "UserIsNotAuthorized", Message: "denied" },
          ],
        },
      },
      { json: {} },
    );

    await expect(registry.cleanup()).rejects.toThrow(/left 2 registered entity id/);
    await expect(registry.cleanup()).resolves.toEqual({ deleted: 2, failed: 0 });
    const calls = mock.callsTo("Campaigns");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toMatchObject({
      CampaignIds: ["7000000000000001", "7000000000000002"],
    });
  });

  test("surfaces unattributed cleanup errors even when item outcomes succeed", () => {
    const result = inspectCleanupResult(
      ["10"],
      {
        ...batch([{ index: 0, success: true, id: "10" }]),
        unattributed_errors: [{ message: "request-level failure" }],
      },
      "campaign",
    );
    expect(result.cleanedIds).toEqual(["10"]);
    expect(result.failures).toEqual(["request: request-level failure"]);
  });
});
