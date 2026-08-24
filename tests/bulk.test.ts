import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAuthForTesting } from "@/auth/oauth";
import { resetEnvForTesting } from "@/config/env";
import { buildBulkCsv, fetchBulkFile, submitBulkDownload } from "@/services/bulk";
import { zipSync } from "@/utils/zip";
import { installMockFetch, type MockFetch, setTestEnv, tokenResponse } from "./_mock";
import { BULK_ZIP } from "./fixtures/zip-archives";

let mock: MockFetch;
const IDS = { accountId: "512300", customerId: "9900" };

/** Serve the zipped bulk file as real bytes; everything else goes to the mock. */
function serveBulkBytes(): void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) =>
    String(input).includes("93.184.216.34")
      ? new Response(Buffer.from(BULK_ZIP, "base64"), { status: 200 })
      : realFetch(input, init)) as typeof fetch;
}

beforeEach(() => {
  setTestEnv();
  resetEnvForTesting();
  resetAuthForTesting();
  mock = installMockFetch();
  mock.always("login.microsoftonline.com", tokenResponse());
});
afterEach(() => mock.restore());

describe("fetchBulkFile", () => {
  test("unzips and groups records by their Type column", async () => {
    serveBulkBytes();
    const records = await fetchBulkFile("https://93.184.216.34/f.zip");
    expect(records.byType.Campaign).toHaveLength(2);
    expect(records.byType["Ad Group"]).toHaveLength(1);
    expect(records.byType.Keyword).toHaveLength(2);
    expect(records.totalRows).toBe(7);
  });

  test("drops the empty cells that dominate a wide bulk row", async () => {
    serveBulkBytes();
    const records = await fetchBulkFile("https://93.184.216.34/f.zip");
    const campaign = records.byType.Campaign?.[0];
    expect(campaign?.Name).toBe("Brand - Exact");
    // A Campaign row leaves every keyword-only column blank; they must not appear.
    expect(campaign).not.toHaveProperty("Keyword");
    expect(campaign).not.toHaveProperty("Match Type");
  });

  test("preserves quoted commas and escaped quotes in entity names", async () => {
    serveBulkBytes();
    const records = await fetchBulkFile("https://93.184.216.34/f.zip");
    expect(records.byType.Campaign?.[1]?.Name).toBe("Shopping, All");
    expect(records.byType.Keyword?.[1]?.Keyword).toBe('acme "pro" widgets');
  });
});

describe("submitBulkDownload", () => {
  test("downloads the whole account when no campaigns are named", async () => {
    mock.queue("DownloadByAccountIds", { json: { DownloadRequestId: "dl-1" } });
    const res = await submitBulkDownload(IDS, { entities: ["Campaigns"] });
    expect(res.downloadRequestId).toBe("dl-1");
    const body = mock.callsTo("DownloadByAccountIds")[0]?.body as any;
    expect(body.AccountIds).toEqual(["512300"]);
    // v13 accepts only format version 6.0.
    expect(body.FormatVersion).toBe("6.0");
    expect(body.CompressionType).toBe("Zip");
  });

  test("switches to the per-campaign endpoint when campaigns are named", async () => {
    mock.queue("DownloadByCampaignIds", { json: { DownloadRequestId: "dl-2" } });
    await submitBulkDownload(IDS, { entities: ["Keywords"], campaignIds: ["900001"] });
    const body = mock.callsTo("DownloadByCampaignIds")[0]?.body as any;
    expect(body.Campaigns).toEqual([{ AccountId: "512300", CampaignId: "900001" }]);
    expect(body.AccountIds).toBeUndefined();
  });

  test("requires at least one entity family", async () => {
    await expect(submitBulkDownload(IDS, { entities: [] })).rejects.toThrow(
      /at least one download entity/i,
    );
  });

  test("rejects a delta sync older than the API's 30-day window", async () => {
    const old = new Date(Date.now() - 40 * 24 * 3600_000).toISOString();
    await expect(
      submitBulkDownload(IDS, { entities: ["Campaigns"], lastSyncTimeUtc: old }),
    ).rejects.toThrow(/more than 30 days/);
  });

  test("rejects an unparseable sync timestamp", async () => {
    await expect(
      submitBulkDownload(IDS, {
        entities: ["Campaigns"],
        lastSyncTimeUtc: "last tuesday",
      }),
    ).rejects.toThrow(/not a valid timestamp/);
  });

  test("passes a recent delta timestamp through", async () => {
    mock.queue("DownloadByAccountIds", { json: { DownloadRequestId: "dl-3" } });
    const recent = new Date(Date.now() - 3600_000).toISOString();
    await submitBulkDownload(IDS, { entities: ["Campaigns"], lastSyncTimeUtc: recent });
    const body = mock.callsTo("DownloadByAccountIds")[0]?.body as Record<string, unknown>;
    expect(body.LastSyncTimeInUTC).toBe(recent);
  });
});

describe("buildBulkCsv", () => {
  test("puts Type first and Format Version as the first data row", () => {
    const csv = buildBulkCsv([{ Type: "Campaign", Name: "Brand", Status: "Paused" }]);
    const lines = csv.split("\n");
    // The BOM is required by the service, so strip it before comparing.
    expect(lines[0]?.replace(/^﻿/, "").split(",")[0]).toBe("Type");
    expect(lines[1]).toContain("Format Version");
    expect(lines[1]).toContain("6.0");
    expect(lines[2]).toContain("Campaign");
  });

  test("writes a UTF-8 BOM, which the service requires", () => {
    expect(buildBulkCsv([{ Type: "Campaign" }]).charCodeAt(0)).toBe(0xfeff);
  });

  test("unions columns across heterogeneous records", () => {
    const csv = buildBulkCsv([
      { Type: "Campaign", Name: "A" },
      { Type: "Keyword", Keyword: "shoes", "Match Type": "Exact" },
    ]);
    const header = csv.split("\n")[0]?.replace(/^﻿/, "") ?? "";
    for (const col of ["Type", "Name", "Keyword", "Match Type"]) {
      expect(header).toContain(col);
    }
  });

  test("quotes cells containing commas, quotes, or newlines", () => {
    const csv = buildBulkCsv([{ Type: "Campaign", Name: 'Shoes, "Best"' }]);
    expect(csv).toContain('"Shoes, ""Best"""');
  });

  test("leaves a cell absent from a record empty rather than undefined", () => {
    const csv = buildBulkCsv([
      { Type: "Campaign", Name: "A", Status: "Paused" },
      { Type: "Keyword", Name: "B" },
    ]);
    expect(csv).not.toContain("undefined");
  });

  test("rejects an empty upload", () => {
    expect(() => buildBulkCsv([])).toThrow(/No records/);
  });
});

describe("bulk upload round trip", () => {
  test("the CSV we build parses back to the records we put in", async () => {
    // Proves the writer and reader agree, which is what the service sees.
    const records: Array<Record<string, string>> = [
      { Type: "Campaign", Id: "-1", Name: "Brand, Exact", Status: "Paused" },
      { Type: "Keyword", "Parent Id": "-1", Keyword: 'say "hi"', "Match Type": "Phrase" },
    ];
    const archive = zipSync([{ name: "upload.csv", data: buildBulkCsv(records) }]);

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) =>
      String(input).includes("93.184.216.35")
        ? new Response(new Uint8Array(archive), { status: 200 })
        : realFetch(input, init)) as typeof fetch;

    const parsed = await fetchBulkFile("https://93.184.216.35/f.zip");
    expect(parsed.byType.Campaign?.[0]?.Name).toBe("Brand, Exact");
    expect(parsed.byType.Keyword?.[0]?.Keyword).toBe('say "hi"');
    expect(parsed.byType["Format Version"]).toHaveLength(1);
  });
});
