import { createHash } from "node:crypto";
import { getAccessToken } from "@/auth/oauth";
import { getEnv, resolveDeveloperToken } from "@/config/env";
import type { AccountIds } from "@/services/campaigns";
import { downloadFile, msadsFetch, serviceBaseUrl } from "@/services/msads-api";
import { forEachDelimitedRow } from "@/utils/csv";
import { MsAdsError } from "@/utils/errors";
import { log } from "@/utils/logger";
import {
  MAX_API_RESPONSE_BYTES,
  type SafeHttpDependencies,
  safeFetchBytes,
} from "@/utils/safe-http";
import { unzipSingleText, zipSync } from "@/utils/zip";

export const MAX_BULK_DOWNLOAD_ROWS = 100_000;
export const MAX_BULK_UPLOAD_RECORDS = 100_000;
export const MAX_BULK_CSV_BYTES = 64 * 1024 * 1024;
export const MAX_BULK_CAMPAIGN_IDS = 1000;

/**
 * Bulk service — whole-account entity export.
 *
 * Only one existing MCP server touches this, which is a real gap: Bulk is how
 * you read an entire account in one operation. Campaign Management caps reads
 * at one parent at a time (ad groups for one campaign, ads for one ad group),
 * so reconstructing an account through it costs hundreds of calls.
 *
 * `LastSyncTimeInUTC` also makes delta sync possible — only what changed since
 * a previous download.
 */

/** The entity families a bulk download can request. */
export const DOWNLOAD_ENTITIES = [
  "Campaigns",
  "AdGroups",
  "Ads",
  "Keywords",
  "Budgets",
  "BidStrategies",
  "Labels",
  "NegativeKeywordLists",
  "CampaignNegativeKeywords",
  "AdGroupNegativeKeywords",
  "AdExtensions",
  "Audiences",
  "AdGroupTargetCriterions",
  "CampaignTargetCriterions",
  "ConversionGoals",
  "AssetGroups",
  "Experiments",
] as const;

export interface BulkDownloadInput {
  entities: string[];
  /** ISO timestamp for a delta sync. Must be within the last 30 days. */
  lastSyncTimeUtc?: string;
  fileType?: "Csv" | "Tsv";
  campaignIds?: string[];
}

export interface BulkDownloadSubmission {
  downloadRequestId: string;
}

export async function submitBulkDownload(
  ids: AccountIds,
  input: BulkDownloadInput,
): Promise<BulkDownloadSubmission> {
  if (!input.entities?.length) {
    throw new MsAdsError({
      message: `At least one download entity is required. Valid values: ${DOWNLOAD_ENTITIES.join(", ")}.`,
    });
  }
  if (input.lastSyncTimeUtc) {
    const age = Date.now() - Date.parse(input.lastSyncTimeUtc);
    if (Number.isNaN(age)) {
      throw new MsAdsError({
        message: `last_sync_time_utc "${input.lastSyncTimeUtc}" is not a valid timestamp.`,
      });
    }
    if (age > 30 * 24 * 3600_000) {
      throw new MsAdsError({
        message:
          "last_sync_time_utc is more than 30 days ago, which the API rejects. Omit it for a full download instead.",
      });
    }
  }

  const body: Record<string, unknown> = {
    CompressionType: "Zip",
    DataScope: "EntityData",
    DownloadEntities: input.entities,
    DownloadFileType: input.fileType ?? "Csv",
    // v13 supports only format version 6.0.
    FormatVersion: "6.0",
    ...(input.lastSyncTimeUtc ? { LastSyncTimeInUTC: input.lastSyncTimeUtc } : {}),
  };

  if ((input.campaignIds?.length ?? 0) > MAX_BULK_CAMPAIGN_IDS) {
    throw new MsAdsError({
      message: `Too many campaign ids: ${input.campaignIds?.length}. Bulk downloads accept at most ${MAX_BULK_CAMPAIGN_IDS}.`,
    });
  }

  const byCampaign = Boolean(input.campaignIds?.length);
  if (byCampaign) {
    body.Campaigns = input.campaignIds?.map((id) => ({
      AccountId: ids.accountId,
      CampaignId: id,
    }));
  } else {
    body.AccountIds = [ids.accountId];
  }

  const res = await msadsFetch<{ DownloadRequestId?: string }>(
    "Bulk",
    byCampaign ? "Campaigns/DownloadByCampaignIds" : "Campaigns/DownloadByAccountIds",
    { body, ...ids },
  );
  if (!res.DownloadRequestId) {
    throw new MsAdsError({ message: "Bulk download returned no DownloadRequestId." });
  }
  return { downloadRequestId: res.DownloadRequestId };
}

export interface BulkStatus {
  status: string;
  percentComplete?: number;
  resultFileUrl?: string;
  errors?: unknown[];
}

export async function getBulkDownloadStatus(
  ids: AccountIds,
  requestId: string,
): Promise<BulkStatus> {
  const res = await msadsFetch<{
    RequestStatus?: string;
    PercentComplete?: number;
    ResultFileUrl?: string | null;
    Errors?: unknown[];
  }>("Bulk", "BulkDownloadStatus/Query", {
    body: { RequestId: requestId },
    ...ids,
    retry: "safe",
  });
  return {
    status: res.RequestStatus ?? "InProgress",
    ...(res.PercentComplete !== undefined
      ? { percentComplete: res.PercentComplete }
      : {}),
    ...(res.ResultFileUrl ? { resultFileUrl: res.ResultFileUrl } : {}),
    ...(res.Errors?.length ? { errors: res.Errors } : {}),
  };
}

export interface BulkRecords {
  /** Column headers from the bulk file. */
  columns: string[];
  /** Rows grouped by their `Type` column. */
  byType: Record<string, Array<Record<string, string>>>;
  totalRows: number;
}

/**
 * Download and parse a completed bulk file.
 *
 * Bulk files are wide and heterogeneous — every record type shares one header
 * row, so most cells in any given row are empty. Grouping by the `Type` column
 * and dropping empty cells turns that into something a model can actually read.
 */
export async function fetchBulkFile(
  url: string,
  fileType: "Csv" | "Tsv" = "Csv",
): Promise<BulkRecords> {
  const archive = await downloadFile(url, 300_000);
  const text = unzipSingleText(archive);
  return parseBulkText(text, fileType);
}

/** Parse only a bounded number of rows before building the by-type index. */
export function parseBulkText(
  text: string,
  fileType: "Csv" | "Tsv" = "Csv",
  maxRows = MAX_BULK_DOWNLOAD_ROWS,
): BulkRecords {
  let columns: string[] | undefined;
  let typeIndex = -1;
  const byType: Record<string, Array<Record<string, string>>> = {};
  let totalRows = 0;

  forEachDelimitedRow(text, fileType === "Tsv" ? "\t" : ",", (row) => {
    if (!columns) {
      columns = row.map((cell) => cell.trim());
      typeIndex = columns.indexOf("Type");
      return;
    }
    if (row.every((cell) => cell.trim() === "")) return;
    if (totalRows >= maxRows) {
      throw new MsAdsError({
        message:
          `Bulk export exceeds the ${maxRows}-row in-memory limit. ` +
          "Narrow by campaign_ids or use last_sync_time_utc for a delta export.",
      });
    }

    const type = typeIndex >= 0 ? (row[typeIndex] ?? "Unknown") : "Unknown";
    const record: Record<string, string> = {};
    for (let index = 0; index < columns.length; index++) {
      const name = columns[index];
      const value = row[index];
      if (name && value !== undefined && value !== "") record[name] = value;
    }
    const bucket = byType[type];
    if (bucket) bucket.push(record);
    else byType[type] = [record];
    totalRows++;
  });

  return { columns: columns ?? [], byType, totalRows };
}

export interface BulkDownloadResult {
  status: "complete" | "completed_with_errors" | "pending" | "failed";
  downloadRequestId: string;
  records?: BulkRecords;
  message?: string;
  errors?: unknown[];
}

const PENDING_DOWNLOAD_STATES = new Set([
  "InProgress",
  "InProgressWithErrors",
  "Pending",
]);

async function parseBulkDownloadStatus(
  status: BulkStatus,
  downloadRequestId: string,
  fileType: "Csv" | "Tsv",
): Promise<BulkDownloadResult> {
  if (status.status === "CompletedWithErrors") {
    return {
      status: "completed_with_errors",
      downloadRequestId,
      ...(status.errors ? { errors: status.errors } : {}),
      message:
        "The bulk download completed with provider errors and is not a usable account export. Submit a new download.",
    };
  }
  if (status.status === "Completed") {
    return {
      status: "complete",
      downloadRequestId,
      records: status.resultFileUrl
        ? await fetchBulkFile(status.resultFileUrl, fileType)
        : { columns: [], byType: {}, totalRows: 0 },
      ...(!status.resultFileUrl
        ? { message: "Completed with no result file — no matching entities." }
        : {}),
    };
  }
  if (PENDING_DOWNLOAD_STATES.has(status.status)) {
    return {
      status: "pending",
      downloadRequestId,
      message: `${status.percentComplete ?? 0}% complete. Try again shortly.`,
    };
  }
  return {
    status: "failed",
    downloadRequestId,
    ...(status.errors ? { errors: status.errors } : {}),
    message:
      status.status === "FailedFullSyncRequired"
        ? "The delta sync could not be served; retry without last_sync_time_utc for a full download."
        : `The bulk download ended with terminal status ${status.status}. Submit a new one.`,
  };
}

/**
 * Run a bulk download to completion within a budget.
 *
 * Bulk is slower than reporting — Microsoft suggests 15–20s polling intervals
 * for small accounts and a multi-minute initial wait for large ones — so this
 * polls more patiently and returns a resumable id when the budget runs out.
 */
export async function runBulkDownload(
  ids: AccountIds,
  input: BulkDownloadInput,
  opts: { timeoutMs?: number } = {},
): Promise<BulkDownloadResult> {
  const env = getEnv();
  const timeoutMs = opts.timeoutMs ?? env.MSADS_BULK_TIMEOUT_MS;
  const { downloadRequestId } = await submitBulkDownload(ids, input);
  log.info(`Bulk download submitted as ${downloadRequestId}`);

  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    const status = await getBulkDownloadStatus(ids, downloadRequestId);

    const parsed = await parseBulkDownloadStatus(
      status,
      downloadRequestId,
      input.fileType ?? "Csv",
    );
    if (parsed.status !== "pending") return parsed;

    if (Date.now() - started >= timeoutMs) {
      return {
        status: "pending",
        downloadRequestId,
        message:
          `Still generating after ${Math.round((Date.now() - started) / 1000)}s ` +
          `(${status.percentComplete ?? 0}% complete). Collect it with get_bulk_download using ` +
          `download_request_id "${downloadRequestId}" — the id stays valid for 2 days.`,
      };
    }

    // Bulk files take minutes, not seconds; polling every second wastes calls
    // and counts against a throttle that locks out for 15 minutes when tripped.
    const delay = attempt < 3 ? 3000 : Math.min(15_000, 5000 * 2 ** (attempt - 3));
    await new Promise((r) => setTimeout(r, delay));
  }
}

/** Collect a bulk download submitted earlier. */
export async function getSubmittedBulkDownload(
  ids: AccountIds,
  downloadRequestId: string,
  fileType: "Csv" | "Tsv" = "Csv",
): Promise<BulkDownloadResult> {
  return parseBulkDownloadStatus(
    await getBulkDownloadStatus(ids, downloadRequestId),
    downloadRequestId,
    fileType,
  );
}

/* ------------------------------------------------------------------ *
 * Upload
 * ------------------------------------------------------------------ */

/**
 * Serialize bulk records to CSV.
 *
 * Bulk files share one header row across every record type, so the header is
 * the union of all keys present. `Type` must come first, and the
 * `Format Version` row must be the very first data row.
 */
export function buildBulkCsv(
  records: Array<Record<string, string>>,
  maxBytes = MAX_BULK_CSV_BYTES,
): string {
  if (records.length === 0) {
    throw new MsAdsError({ message: "No records to upload." });
  }
  if (records.length > MAX_BULK_UPLOAD_RECORDS) {
    throw new MsAdsError({
      message: `Bulk upload has ${records.length} records; the hard maximum is ${MAX_BULK_UPLOAD_RECORDS}. Split the upload.`,
    });
  }

  // `Type` must lead. `Name` must exist because the Format Version row carries
  // the version string in that column, even if no supplied record uses it.
  const columns = new Set<string>(["Type", "Name"]);
  for (const record of records) {
    for (const key of Object.keys(record)) columns.add(key);
  }
  const header = [...columns];

  // Count bytes before retaining each escaped line. In particular, a large cell
  // is rejected before quote escaping can double its allocation.
  const lines: string[] = [];
  let bytes = Buffer.byteLength("﻿", "utf8");
  const append = (values: string[]) => {
    const line = csvLine(values, maxBytes - bytes - 1);
    bytes += Buffer.byteLength(line, "utf8") + 1;
    if (bytes > maxBytes) bulkCsvTooLarge(maxBytes);
    lines.push(line);
  };

  append(header);
  append(
    header.map((column) =>
      column === "Type" ? "Format Version" : column === "Name" ? "6.0" : "",
    ),
  );
  for (const record of records) append(header.map((column) => record[column] ?? ""));
  return `﻿${lines.join("\n")}\n`;
}

function csvLine(values: string[], maxBytes: number): string {
  const cells: string[] = [];
  let bytes = 0;
  for (const value of values) {
    const text = String(value ?? "");
    const quoted = /[",\n\r]/.test(text);
    let quoteEscapes = 0;
    if (quoted) {
      for (let index = 0; index < text.length; index++) {
        if (text.charCodeAt(index) === 34) quoteEscapes++;
      }
    }
    bytes +=
      (cells.length > 0 ? 1 : 0) +
      Buffer.byteLength(text, "utf8") +
      (quoted ? quoteEscapes + 2 : 0);
    if (bytes > maxBytes) bulkCsvTooLarge(maxBytes);
    cells.push(quoted ? `"${text.replace(/"/g, '""')}"` : text);
  }
  return cells.join(",");
}

function bulkCsvTooLarge(maxBytes: number): never {
  throw new MsAdsError({
    message: `Serialized bulk CSV exceeds the ${maxBytes}-byte hard maximum. Split the upload before compression.`,
  });
}

interface UploadUrlResponse {
  UploadUrl?: string;
  RequestId?: string;
}

/**
 * Request a one-time upload URL.
 *
 * Each URL is single-use; reusing one fails with error 3224
 * (BulkServiceUrlAlreadyUsedForUpload).
 */
export async function getBulkUploadUrl(
  ids: AccountIds,
  responseMode: "ErrorsOnly" | "ErrorsAndResults" = "ErrorsAndResults",
): Promise<{ uploadUrl: string; requestId: string }> {
  const res = await msadsFetch<UploadUrlResponse>("Bulk", "BulkUploadUrl/Query", {
    body: { AccountId: ids.accountId, ResponseMode: responseMode },
    ...ids,
    retry: "safe",
  });
  if (!res.UploadUrl || !res.RequestId) {
    throw new MsAdsError({ message: "GetBulkUploadUrl returned no upload URL." });
  }
  return { uploadUrl: res.UploadUrl, requestId: res.RequestId };
}

/**
 * POST the zipped bulk file to the upload URL.
 *
 * This endpoint does NOT use `Authorization: Bearer`. It takes the raw access
 * token in an `AuthenticationToken` header — the SOAP-era convention, kept for
 * the upload URL alone. Getting this wrong yields a bare 401 with no body.
 */
export async function postBulkFile(
  uploadUrl: string,
  ids: AccountIds,
  archive: Buffer,
  fileName = "upload.zip",
  dependencies: SafeHttpDependencies = {},
): Promise<void> {
  const accessToken = await getAccessToken();
  const boundary = `----mcpmsads${createHash("sha256").update(uploadUrl).digest("hex").slice(0, 16)}`;

  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="payload"; filename="${fileName}"\r\n` +
      "Content-Type: application/zip\r\n\r\n",
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const body = Buffer.concat([head, archive, tail]);

  const headers: Record<string, string> = {
    AuthenticationToken: accessToken,
    DeveloperToken: resolveDeveloperToken(),
    "Content-Type": `multipart/form-data; boundary=${boundary}`,
    CustomerAccountId: ids.accountId,
    // Microsoft's own HTTP example writes `AccountId` here while the prose says
    // `CustomerAccountId`. Sending both costs nothing and covers the ambiguity.
    AccountId: ids.accountId,
    ...(ids.customerId ? { CustomerId: ids.customerId } : {}),
  };

  const res = await safeFetchBytes(
    uploadUrl,
    { method: "POST", headers, body },
    {
      timeoutMs: getEnv().MSADS_REQUEST_TIMEOUT_MS,
      maxBytes: MAX_API_RESPONSE_BYTES,
      allowedOrigin: new URL(serviceBaseUrl("Bulk")).origin,
      ...dependencies,
    },
  );
  if (!res.ok) {
    const detail = new TextDecoder().decode(res.bytes).slice(0, 500);
    throw new MsAdsError({
      status: res.status,
      message:
        res.status === 401
          ? "Bulk upload rejected the credentials (HTTP 401). This endpoint uses the AuthenticationToken header rather than Authorization: Bearer."
          : `Bulk upload failed (HTTP ${res.status}). ${detail}`,
    });
  }
}

export interface BulkUploadResult {
  status: "complete" | "completed_with_errors" | "pending" | "failed";
  requestId: string;
  /** Parsed result file, including an explicit empty result on empty completion. */
  records?: BulkRecords;
  /** Rows whose Type ends in "Error" — the per-record failures. */
  errors?: Array<Record<string, string>>;
  serviceErrors?: unknown[];
  message?: string;
}

interface BulkUploadStatus {
  state: string;
  percentComplete?: number;
  resultFileUrl?: string;
  errors?: unknown[];
}

const PENDING_UPLOAD_STATES = new Set([
  "FileUploaded",
  "InProgress",
  "InProgressWithErrors",
  "PendingFileUpload",
  "PendingFileUploadWithErrors",
  "Pending",
]);

export async function getBulkUploadStatus(
  ids: AccountIds,
  requestId: string,
): Promise<BulkUploadStatus> {
  const status = await msadsFetch<{
    RequestStatus?: string;
    PercentComplete?: number;
    ResultFileUrl?: string | null;
    Errors?: unknown[];
  }>("Bulk", "BulkUploadStatus/Query", {
    body: { RequestId: requestId },
    ...ids,
    retry: "safe",
  });
  return {
    state: status.RequestStatus ?? "InProgress",
    ...(status.PercentComplete !== undefined
      ? { percentComplete: status.PercentComplete }
      : {}),
    ...(status.ResultFileUrl ? { resultFileUrl: status.ResultFileUrl } : {}),
    ...(status.Errors?.length ? { errors: status.Errors } : {}),
  };
}

/** Interpret upload status identically during initial polling and later collection. */
export async function parseBulkUploadStatus(
  status: BulkUploadStatus,
  requestId: string,
): Promise<BulkUploadResult> {
  if (status.state === "Completed" || status.state === "CompletedWithErrors") {
    const records = status.resultFileUrl
      ? await fetchBulkFile(status.resultFileUrl)
      : { columns: [], byType: {}, totalRows: 0 };
    const errors = Object.entries(records.byType)
      .filter(([type]) => type.endsWith("Error"))
      .flatMap(([, rows]) => rows);
    return {
      status:
        status.state === "Completed" && errors.length === 0
          ? "complete"
          : "completed_with_errors",
      requestId,
      records,
      ...(errors.length > 0 ? { errors } : {}),
      ...(status.errors ? { serviceErrors: status.errors } : {}),
      ...(!status.resultFileUrl
        ? { message: "Completed with no result file — no result rows were produced." }
        : {}),
    };
  }
  if (PENDING_UPLOAD_STATES.has(status.state)) {
    return {
      status: "pending",
      requestId,
      message:
        `${status.percentComplete ?? 0}% complete. Collect it with get_bulk_upload ` +
        `using request_id "${requestId}".`,
      ...(status.errors ? { serviceErrors: status.errors } : {}),
    };
  }
  return {
    status: "failed",
    requestId,
    message:
      `Bulk upload ended with terminal status ${status.state}. ` +
      "Correct the row count or file format if named, then submit a new upload.",
    ...(status.errors ? { serviceErrors: status.errors } : {}),
  };
}

/** Poll an upload to completion and parse the result file. */
export async function runBulkUpload(
  ids: AccountIds,
  records: Array<Record<string, string>>,
  opts: { timeoutMs?: number } = {},
): Promise<BulkUploadResult> {
  const env = getEnv();
  const timeoutMs = opts.timeoutMs ?? env.MSADS_BULK_TIMEOUT_MS;

  const csv = buildBulkCsv(records);
  const archive = zipSync([{ name: "upload.csv", data: csv }]);

  const { uploadUrl, requestId } = await getBulkUploadUrl(ids);
  await postBulkFile(uploadUrl, ids, archive);
  log.info(`Bulk upload ${requestId} submitted (${records.length} records)`);

  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    const status = await getBulkUploadStatus(ids, requestId);
    const parsed = await parseBulkUploadStatus(status, requestId);
    if (parsed.status !== "pending") return parsed;

    if (Date.now() - started >= timeoutMs) {
      return {
        status: "pending",
        requestId,
        message:
          `Still processing after ${Math.round((Date.now() - started) / 1000)}s ` +
          `(${status.percentComplete ?? 0}%). The upload was accepted — collect it with get_bulk_upload ` +
          `using request_id "${requestId}".`,
      };
    }

    // Microsoft suggests roughly one minute per 10,000 rows before polling.
    const delay = attempt < 3 ? 3000 : Math.min(15_000, 5000 * 2 ** (attempt - 3));
    await new Promise((r) => setTimeout(r, delay));
  }
}

/** Collect a bulk upload submitted earlier. */
export async function getSubmittedBulkUpload(
  ids: AccountIds,
  requestId: string,
): Promise<BulkUploadResult> {
  return parseBulkUploadStatus(await getBulkUploadStatus(ids, requestId), requestId);
}
