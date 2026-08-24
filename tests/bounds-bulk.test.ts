import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resetAuthForTesting } from "@/auth/oauth";
import { resetEnvForTesting } from "@/config/env";
import { createServer } from "@/server";
import {
  buildBulkCsv,
  fetchBulkFile,
  getSubmittedBulkDownload,
  getSubmittedBulkUpload,
  MAX_BULK_UPLOAD_RECORDS,
  parseBulkText,
} from "@/services/bulk";
import { cacheClear } from "@/services/cache";
import { fetchReportFile } from "@/services/reporting";
import {
  collectionEnvelope,
  DEFAULT_COLLECTION_LIMIT,
  MAX_COLLECTION_LIMIT,
} from "@/utils/collection";
import { MAX_DOWNLOAD_BYTES, readResponseBytes } from "@/utils/safe-http";
import { unzipSingleText, zipSync } from "@/utils/zip";
import { installMockFetch, type MockFetch, setTestEnv, tokenResponse } from "./_mock";

let mock: MockFetch;
const IDS = { accountId: "123", customerId: "456" };

beforeEach(() => {
  setTestEnv({ MSADS_ACCOUNT_ID: "123", MSADS_CUSTOMER_ID: "456" });
  resetEnvForTesting();
  resetAuthForTesting();
  cacheClear();
  mock = installMockFetch();
  mock.always("login.microsoftonline.com", tokenResponse());
});

afterEach(() => mock.restore());

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "bounds-test", version: "1.0.0" });
  const server: McpServer = createServer();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function payload(result: Awaited<ReturnType<Client["callTool"]>>): any {
  const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";
  return JSON.parse(text);
}

describe("collection envelopes", () => {
  test("caps rows under their domain key and reports explicit metadata", () => {
    const rows = Array.from({ length: DEFAULT_COLLECTION_LIMIT + 1 }, (_, i) => i);
    const result = collectionEnvelope("campaigns", rows);
    expect(result.campaigns).toHaveLength(DEFAULT_COLLECTION_LIMIT);
    expect(result).toMatchObject({
      discovered: DEFAULT_COLLECTION_LIMIT + 1,
      showing: DEFAULT_COLLECTION_LIMIT,
      truncated: true,
    });
    expect(result.guidance).toMatch(/narrow|pagination/i);
    expect(() =>
      collectionEnvelope("rows", [], { limit: MAX_COLLECTION_LIMIT + 1 }),
    ).toThrow(/between 1 and 5000/);
  });

  test("marks a full list_accounts API cap as potentially truncated", async () => {
    mock.queue("AccountsOrCustomersInfo/Find", {
      json: {
        AccountInfoWithCustomerData: Array.from(
          { length: MAX_COLLECTION_LIMIT },
          (_, index) => ({
            AccountId: String(index),
            AccountName: `Account ${index}`,
          }),
        ),
      },
    });
    const result = await withClient((client) =>
      client.callTool({
        name: "list_accounts",
        arguments: { limit: MAX_COLLECTION_LIMIT },
      }),
    );
    expect(payload(result)).toMatchObject({
      showing: MAX_COLLECTION_LIMIT,
      truncated: true,
    });
  });

  test("caps raw read collections without hiding their response key", async () => {
    mock.queue("Campaigns/QueryByAccountId", {
      json: {
        Campaigns: Array.from({ length: DEFAULT_COLLECTION_LIMIT + 1 }, (_, i) => ({
          Id: String(i),
        })),
      },
    });
    const result = await withClient((client) =>
      client.callTool({
        name: "msads_raw_read",
        arguments: {
          service: "CampaignManagement",
          path: "Campaigns/QueryByAccountId",
          body: { AccountId: "123" },
        },
      }),
    );
    const body = payload(result);
    expect(body.Campaigns).toHaveLength(DEFAULT_COLLECTION_LIMIT);
    expect(body).toMatchObject({
      discovered: DEFAULT_COLLECTION_LIMIT + 1,
      showing: DEFAULT_COLLECTION_LIMIT,
      truncated: true,
    });
  });

  test("all variable collection tools advertise a bounded argument", async () => {
    const tools = await withClient(async (client) => (await client.listTools()).tools);
    const byName = new Map(tools.map((tool) => [tool.name, tool.inputSchema.properties]));
    const limitTools = [
      "bulk_download",
      "bulk_upload",
      "get_account_hierarchy",
      "get_auction_insights",
      "get_bid_landscape",
      "get_bulk_download",
      "get_bulk_upload",
      "get_current_user",
      "get_historical_search_count",
      "get_keyword_ideas",
      "get_keyword_traffic_estimates",
      "list_accounts",
      "list_ad_extension_associations",
      "list_ad_extensions",
      "list_ad_groups",
      "list_ads",
      "list_audiences",
      "list_billing_documents",
      "list_budgets",
      "list_campaigns",
      "list_conversion_goals",
      "list_google_imports",
      "list_keywords",
      "list_negative_keywords",
      "list_report_types",
      "list_targeting",
      "list_uet_tags",
      "map_google_entity_ids",
      "msads_raw_read",
      "search_linkedin_companies",
    ];
    for (const name of limitTools) {
      expect(byName.get(name), name).toHaveProperty("limit");
      expect((byName.get(name)?.limit as any)?.maximum, name).toBe(MAX_COLLECTION_LIMIT);
    }
    for (const name of [
      "get_google_import_results",
      "list_insertion_orders",
      "list_labels",
    ]) {
      expect(byName.get(name), name).toHaveProperty("page_size");
      expect((byName.get(name)?.page_size as any)?.maximum, name).toBeLessThanOrEqual(
        MAX_COLLECTION_LIMIT,
      );
    }
    for (const name of ["run_report", "get_report"]) {
      expect((byName.get(name)?.max_rows as any)?.maximum, name).toBe(
        MAX_COLLECTION_LIMIT,
      );
    }
    expect((byName.get("suggest_keywords_for_url")?.max_keywords as any)?.maximum).toBe(
      200,
    );
  });
});

describe("extension discovery", () => {
  test("fetches every discovered id in API-sized chunks", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => String(i + 1));
    mock.queue("AdExtensionIds/QueryByAccountId", {
      json: {
        AdExtensionIdToEntityIdAssociations: ids.map((id) => ({
          AdExtensionId: id,
        })),
      },
    });
    for (const chunk of [ids.slice(0, 100), ids.slice(100, 200), ids.slice(200)]) {
      mock.queue("AdExtensions/QueryByIds", {
        json: { AdExtensions: chunk.map((Id) => ({ Id })) },
      });
    }

    const result = await withClient((client) =>
      client.callTool({
        name: "list_ad_extensions",
        arguments: {
          account_id: "123",
          extension_type: "SitelinkAdExtension",
          limit: 500,
        },
      }),
    );
    expect(result.isError).toBeFalsy();
    expect(payload(result)).toMatchObject({
      discovered_extension_ids: 250,
      discovered: 250,
      showing: 250,
      truncated: false,
    });
    expect(
      mock
        .callsTo("AdExtensions/QueryByIds")
        .map((call) => (call.body as any).AdExtensionIds.length),
    ).toEqual([100, 100, 50]);
  });
});

describe("report and bulk public schemas", () => {
  test("use enums and reject documented scope maxima before fetch", async () => {
    await withClient(async (client) => {
      const tools = (await client.listTools()).tools;
      const report = tools.find((tool) => tool.name === "run_report")?.inputSchema
        .properties as any;
      expect(report.report_type.enum).toContain("keyword_performance");
      expect(report.account_ids.maxItems).toBe(1000);
      expect(report.campaign_ids.maxItems).toBe(300);
      expect(report.ad_group_ids.maxItems).toBe(300);
      expect(report.asset_group_ids.maxItems).toBe(100);

      const bulkDownload = tools.find((tool) => tool.name === "bulk_download")
        ?.inputSchema.properties as any;
      const bulkUpload = tools.find((tool) => tool.name === "bulk_upload")?.inputSchema
        .properties as any;
      expect(bulkDownload.campaign_ids.maxItems).toBe(1000);
      expect(bulkUpload.records.maxItems).toBe(MAX_BULK_UPLOAD_RECORDS);

      for (const arguments_ of [
        {
          report_type: "campaign_performance",
          campaign_ids: Array(301).fill("1"),
        },
        {
          report_type: "ad_group_performance",
          ad_group_ids: Array(301).fill("1"),
        },
        {
          report_type: "asset_group_performance",
          asset_group_ids: Array(101).fill("1"),
        },
        {
          report_type: "account_performance",
          account_ids: Array(1001).fill("1"),
        },
      ]) {
        const result = await client.callTool({
          name: "run_report",
          arguments: { account_id: "123", ...arguments_ },
        });
        expect(result.isError).toBe(true);
      }
      const bulkResult = await client.callTool({
        name: "bulk_download",
        arguments: {
          account_id: "123",
          entities: ["Campaigns"],
          campaign_ids: Array(1001).fill("1"),
        },
      });
      expect(bulkResult.isError).toBe(true);
      const uploadResult = await client.callTool({
        name: "bulk_upload",
        arguments: {
          account_id: "123",
          records: Array(MAX_BULK_UPLOAD_RECORDS + 1).fill({ Type: "Campaign" }),
        },
      });
      expect(uploadResult.isError).toBe(true);
    });
    expect(mock.calls).toHaveLength(0);
  });

  test("passes keyword max_rows into the submitted request", async () => {
    mock.queue("GenerateReport/Submit", { json: { ReportRequestId: "report-1" } });
    mock.queue("GenerateReport/Poll", {
      json: {
        ReportRequestStatus: { Status: "Success", ReportDownloadUrl: null },
      },
    });
    const result = await withClient((client) =>
      client.callTool({
        name: "run_report",
        arguments: {
          account_id: "123",
          report_type: "keyword_performance",
          max_rows: 37,
        },
      }),
    );
    expect(result.isError).toBeFalsy();
    const submit = mock.callsTo("GenerateReport/Submit")[0];
    expect(submit).toBeDefined();
    expect(((submit as any).body.ReportRequest as any).MaxRows).toBe(37);
  });
});

describe("bulk workflow bounds", () => {
  test("enforces the upload record and serialized CSV boundaries", () => {
    const atLimit = Array(MAX_BULK_UPLOAD_RECORDS).fill({ Type: "Campaign" });
    expect(() => buildBulkCsv(atLimit)).not.toThrow();
    expect(() => buildBulkCsv([...atLimit, { Type: "Campaign" }])).toThrow(
      /hard maximum.*100000/i,
    );

    const records = [{ Type: "Campaign", Name: "Bounded" }];
    const csv = buildBulkCsv(records);
    const bytes = Buffer.byteLength(csv, "utf8");
    expect(buildBulkCsv(records, bytes)).toBe(csv);
    expect(() => buildBulkCsv(records, bytes - 1)).toThrow(/before compression/i);
    expect(() =>
      buildBulkCsv([{ Type: "Campaign", Name: '"'.repeat(1000) }], 100),
    ).toThrow(/before compression/i);
  });

  test("bounds retained rows before grouping and gives narrowing guidance", () => {
    const atLimit = "Type,Name\nCampaign,A\nCampaign,B\n";
    expect(parseBulkText(atLimit, "Csv", 2).totalRows).toBe(2);
    expect(() => parseBulkText(`${atLimit}Campaign,C\n`, "Csv", 2)).toThrow(
      /campaign_ids|last_sync_time_utc/i,
    );
  });

  test("enforces compressed and aggregate decompressed byte ceilings", async () => {
    await expect(
      readResponseBytes(
        new Response("x", {
          headers: { "content-length": String(MAX_DOWNLOAD_BYTES + 1) },
        }),
        MAX_DOWNLOAD_BYTES,
      ),
    ).rejects.toThrow(/exceed/i);
    await expect(
      readResponseBytes(
        new Response("x", {
          headers: { "content-length": String(MAX_DOWNLOAD_BYTES) },
        }),
        MAX_DOWNLOAD_BYTES,
      ),
    ).resolves.toEqual(Buffer.from("x"));

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) =>
      String(input).includes("93.184.216.")
        ? new Response("x", {
            headers: { "content-length": String(MAX_DOWNLOAD_BYTES + 1) },
          })
        : realFetch(input, init)) as typeof fetch;
    await expect(fetchBulkFile("https://93.184.216.40/bulk.zip")).rejects.toThrow(
      /exceed/i,
    );
    await expect(fetchReportFile("https://93.184.216.41/report.zip")).rejects.toThrow(
      /exceed/i,
    );

    const archive = zipSync([{ name: "data.csv", data: "1234" }]);
    expect(unzipSingleText(archive, "utf8", 4)).toBe("1234");
    expect(() => unzipSingleText(archive, "utf8", 3)).toThrow(/decompressed bytes/i);
    const aggregate = zipSync([
      { name: "a.csv", data: "1234" },
      { name: "b.csv", data: "5678" },
    ]);
    expect(() => unzipSingleText(aggregate, "utf8", 7)).toThrow(/decompressed bytes/i);
  });
});

describe("resumable bulk status collection", () => {
  test("collects pending uploads and treats empty completion as complete", async () => {
    mock.queue(
      "BulkUploadStatus/Query",
      { json: { RequestStatus: "InProgress", PercentComplete: 42 } },
      { json: { RequestStatus: "Completed", ResultFileUrl: null } },
    );
    const pending = await getSubmittedBulkUpload(IDS, "up-1");
    expect(pending).toMatchObject({ status: "pending", requestId: "up-1" });
    expect(pending.message).toMatch(/get_bulk_upload/);

    const complete = await getSubmittedBulkUpload(IDS, "up-1");
    expect(complete).toMatchObject({
      status: "complete",
      requestId: "up-1",
      records: { totalRows: 0, byType: {} },
    });
  });

  test("returns empty completed downloads instead of marking them pending", async () => {
    mock.queue("BulkDownloadStatus/Query", {
      json: { RequestStatus: "Completed", ResultFileUrl: null },
    });
    await expect(getSubmittedBulkDownload(IDS, "down-1")).resolves.toMatchObject({
      status: "complete",
      records: { totalRows: 0, byType: {} },
    });
  });

  test("does not present a download completed with errors as a usable export", async () => {
    mock.queue("BulkDownloadStatus/Query", {
      json: {
        RequestStatus: "CompletedWithErrors",
        ResultFileUrl: null,
        Errors: [{ Code: 1, Message: "provider rejected part of the export" }],
      },
    });
    const result = await getSubmittedBulkDownload(IDS, "down-errors");
    expect(result).toMatchObject({
      status: "completed_with_errors",
      downloadRequestId: "down-errors",
      errors: [{ Code: 1 }],
    });
    expect(result.records).toBeUndefined();
    expect(result.message).toMatch(/not a usable account export/);
  });

  test("returns row-count, format, and failure terminal statuses immediately", async () => {
    mock.queue(
      "BulkUploadStatus/Query",
      { json: { RequestStatus: "RowCountExceeded" } },
      { json: { RequestStatus: "InvalidFileFormat" } },
      { json: { RequestStatus: "Failed" } },
    );
    for (const expected of ["RowCountExceeded", "InvalidFileFormat", "Failed"]) {
      const result = await getSubmittedBulkUpload(IDS, "up-failed");
      expect(result.status).toBe("failed");
      expect(result.message).toContain(expected);
    }
  });
});
