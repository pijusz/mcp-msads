import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAuthForTesting } from "@/auth/oauth";
import { resetEnvForTesting } from "@/config/env";
import { runBulkDownload, runBulkUpload } from "@/services/bulk";
import { type Clock, pollJob } from "@/utils/poll-job";
import { installMockFetch, type MockFetch, setTestEnv, tokenResponse } from "./_mock";

let mock: MockFetch;
const IDS = { accountId: "512300", customerId: "9900" };

/** A clock whose sleep advances time instantly and records each wait. */
function fakeClock(): Clock & { sleeps: number[] } {
  let now = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}

/** Upload transport for postBulkFile: no DNS, no socket. */
const UPLOAD = {
  lookup: async () => ["93.184.216.34"],
  fetch: (async () => new Response("", { status: 200 })) as unknown as typeof fetch,
};

beforeEach(() => {
  setTestEnv();
  resetEnvForTesting();
  resetAuthForTesting();
  mock = installMockFetch();
  mock.always("login.microsoftonline.com", tokenResponse());
});
afterEach(() => mock.restore());

describe("pollJob", () => {
  test("returns the first non-pending result without waiting further", async () => {
    const clock = fakeClock();
    const seen: number[] = [];
    const result = await pollJob({
      clock,
      poll: async (attempt) => {
        seen.push(attempt);
        return attempt < 2 ? "pending" : "done";
      },
      isPending: (r) => r === "pending",
      budgetMs: 60_000,
      delay: (attempt) => (attempt + 1) * 100,
      onTimeout: () => "timeout",
    });
    expect(result).toBe("done");
    expect(seen).toEqual([0, 1, 2]);
    expect(clock.sleeps).toEqual([100, 200]);
  });

  test("hands the last pending result and elapsed time to onTimeout", async () => {
    const clock = fakeClock();
    const result = await pollJob({
      clock,
      poll: async (attempt) => ({ attempt }),
      isPending: () => true,
      budgetMs: 250,
      delay: () => 100,
      onTimeout: (last, elapsed) => ({ ...last, elapsed }),
    });
    expect(result).toEqual({ attempt: 3, elapsed: 300 });
    expect(clock.sleeps).toEqual([100, 100, 100]);
  });
});

describe("runBulkDownload polling", () => {
  test("polls through InProgress until Completed on the bulk cadence", async () => {
    mock.queue("DownloadByAccountIds", { json: { DownloadRequestId: "dl-1" } });
    mock.queue(
      "BulkDownloadStatus/Query",
      { json: { RequestStatus: "InProgress", PercentComplete: 10 } },
      { json: { RequestStatus: "InProgress", PercentComplete: 60 } },
      { json: { RequestStatus: "Completed", PercentComplete: 100 } },
    );
    const clock = fakeClock();

    const result = await runBulkDownload(
      IDS,
      { entities: ["Campaigns"] },
      { clock, timeoutMs: 600_000 },
    );

    expect(result.status).toBe("complete");
    expect(result.downloadRequestId).toBe("dl-1");
    expect(mock.callsTo("BulkDownloadStatus/Query")).toHaveLength(3);
    expect(clock.sleeps).toEqual([3000, 3000]);
  });

  test("returns a resumable pending result once the budget is spent", async () => {
    mock.queue("DownloadByAccountIds", { json: { DownloadRequestId: "dl-2" } });
    mock.always("BulkDownloadStatus/Query", {
      json: { RequestStatus: "InProgress", PercentComplete: 40 },
    });
    const clock = fakeClock();

    const result = await runBulkDownload(
      IDS,
      { entities: ["Campaigns"] },
      { clock, timeoutMs: 10_000 },
    );

    // 0 → 3s → 6s → 9s → 14s: the fifth poll is the first past the budget.
    expect(clock.sleeps).toEqual([3000, 3000, 3000, 5000]);
    expect(mock.callsTo("BulkDownloadStatus/Query")).toHaveLength(5);
    expect(result).toEqual({
      status: "pending",
      downloadRequestId: "dl-2",
      message:
        "Still generating after 14s (40% complete). Collect it with get_bulk_download using " +
        'download_request_id "dl-2" — the id stays valid for 2 days.',
    });
  });
});

describe("runBulkUpload polling", () => {
  const RECORDS = [{ Type: "Campaign", Id: "-1", Name: "New", Status: "Paused" }];

  function queueUploadUrl(requestId: string): void {
    mock.queue("BulkUploadUrl/Query", {
      json: {
        UploadUrl: "https://fileupload.api.bingads.microsoft.com/Api/Upload/x?Ver=13",
        RequestId: requestId,
      },
    });
  }

  test("polls through pending upload states until Completed", async () => {
    queueUploadUrl("up-1");
    mock.queue(
      "BulkUploadStatus/Query",
      { json: { RequestStatus: "FileUploaded" } },
      { json: { RequestStatus: "InProgress", PercentComplete: 50 } },
      { json: { RequestStatus: "InProgress", PercentComplete: 90 } },
      { json: { RequestStatus: "InProgress", PercentComplete: 95 } },
      { json: { RequestStatus: "Completed", PercentComplete: 100 } },
    );
    const clock = fakeClock();

    const result = await runBulkUpload(IDS, RECORDS, {
      clock,
      timeoutMs: 600_000,
      upload: UPLOAD,
    });

    expect(result.status).toBe("complete");
    expect(result.requestId).toBe("up-1");
    expect(mock.callsTo("BulkUploadStatus/Query")).toHaveLength(5);
    expect(clock.sleeps).toEqual([3000, 3000, 3000, 5000]);
  });

  test("returns a resumable pending result once the budget is spent", async () => {
    queueUploadUrl("up-2");
    mock.always("BulkUploadStatus/Query", {
      json: { RequestStatus: "InProgress", PercentComplete: 25 },
    });
    const clock = fakeClock();

    const result = await runBulkUpload(IDS, RECORDS, {
      clock,
      timeoutMs: 5_000,
      upload: UPLOAD,
    });

    expect(clock.sleeps).toEqual([3000, 3000]);
    expect(mock.callsTo("BulkUploadStatus/Query")).toHaveLength(3);
    expect(result).toEqual({
      status: "pending",
      requestId: "up-2",
      message:
        "Still processing after 6s (25%). The upload was accepted — collect it with get_bulk_upload " +
        'using request_id "up-2".',
    });
  });
});
