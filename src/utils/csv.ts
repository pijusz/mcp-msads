/**
 * RFC 4180 CSV / TSV parsing, plus the Microsoft Advertising report envelope.
 *
 * Report downloads are not bare CSV. A default report looks like:
 *
 *   "Report Name: My Keyword Performance Report"
 *   "Report Time: 2/7/2020"
 *   "Time Zone: (GMT-08:00) Pacific Time (US & Canada); Tijuana"
 *   "Last Completed Available Day: 2/8/2020 10:15:00 PM (GMT)"
 *   "Report Aggregation: Summary"
 *   "Potential Incomplete Data: true"
 *   "Rows: 5"
 *   <blank>
 *   "AccountId","CampaignId","Keyword","Clicks"
 *   "123","456","red shoes","35"
 *   <blank>
 *   "@2020 Microsoft Corporation. All rights reserved. "
 *
 * The metadata block is worth keeping rather than stripping: `Potential
 * Incomplete Data` and `Last Completed Available Day` tell a caller whether
 * the numbers are still moving, which matters when an agent is about to make
 * a spending decision from them.
 */

export class DelimitedRowLimitError extends Error {
  constructor(readonly maxRows: number) {
    super(`Delimited data exceeds the ${maxRows}-row retention limit.`);
    this.name = "DelimitedRowLimitError";
  }
}

export interface ParsedReport {
  /** Key/value pairs from the leading metadata block. */
  metadata: Record<string, string>;
  /** Column names, in the order the report emitted them. */
  columns: string[];
  /** Retained data rows keyed by column name. */
  rows: Array<Record<string, string>>;
  /** Actual data rows encountered, including rows beyond the retention limit. */
  totalRows: number;
  /** Footer line, when present. */
  footer?: string;
  /** True when Microsoft flagged the final period as still processing. */
  potentiallyIncomplete: boolean;
  /** Row count Microsoft declared in the header, when it did. */
  declaredRows?: number;
}

/**
 * Split delimited text into a grid of raw cells.
 *
 * Handles the RFC 4180 rules that a naive `split(",")` gets wrong: quoted
 * fields containing the delimiter, quoted fields spanning newlines, and the
 * doubled-quote escape (`""` inside a quoted field means one literal quote).
 */
export function forEachDelimitedRow(
  text: string,
  delimiter: string,
  callback: (row: string[], index: number) => void,
): void {
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let index = 0;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    callback(row, index++);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
    } else if (ch === delimiter) {
      endField();
      i++;
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRow();
      i++;
    } else {
      field += ch;
      i++;
    }
  }

  if (field !== "" || row.length > 0) endRow();
}

export function parseDelimited(
  text: string,
  delimiter = ",",
  maxRows = Number.POSITIVE_INFINITY,
): string[][] {
  const rows: string[][] = [];
  forEachDelimitedRow(text, delimiter, (row) => {
    if (rows.length >= maxRows) throw new DelimitedRowLimitError(maxRows);
    rows.push(row);
  });
  return rows;
}

/** True when a parsed row carries no content at all. */
function isBlank(row: string[] | undefined): boolean {
  return !row || row.every((cell) => cell.trim() === "");
}

/**
 * A metadata line is a single cell shaped `Key: Value`. Data rows have many
 * cells, so cell count alone separates the header block from the table — but
 * guard on the colon too, since a one-column report would otherwise confuse it.
 */
function readMetadataLine(row: string[]): [string, string] | null {
  if (row.length !== 1) return null;
  const cell = row[0]?.trim() ?? "";
  const colon = cell.indexOf(":");
  if (colon <= 0) return null;
  return [cell.slice(0, colon).trim(), cell.slice(colon + 1).trim()];
}

/**
 * Parse a downloaded Microsoft Advertising report.
 *
 * Tolerates every combination of the ExcludeReportHeader / ExcludeColumnHeaders
 * / ExcludeReportFooter flags, so a caller that flips them does not also have
 * to change how it reads the result.
 */
export function parseReportCsv(
  text: string,
  delimiter = ",",
  maxRows = Number.POSITIVE_INFINITY,
): ParsedReport {
  const metadata: Record<string, string> = {};
  const rows: Array<Record<string, string>> = [];
  let columns: string[] | undefined;
  let footer: string | undefined;
  let totalRows = 0;

  forEachDelimitedRow(text, delimiter, (row) => {
    if (!columns) {
      if (isBlank(row)) return;
      const kv = readMetadataLine(row);
      if (kv) {
        metadata[kv[0]] = kv[1];
        return;
      }
      columns = row.map((cell) => cell.trim());
      return;
    }

    if (isBlank(row)) return;
    if (row.length === 1 && columns.length > 1) {
      footer = row[0]?.trim();
      return;
    }

    totalRows++;
    if (rows.length >= maxRows) return;
    const record: Record<string, string> = {};
    for (let index = 0; index < columns.length; index++) {
      const name = columns[index];
      if (name !== undefined) record[name] = row[index] ?? "";
    }
    rows.push(record);
  });

  const declaredRows = readDeclaredRows(metadata);
  return {
    metadata,
    columns: columns ?? [],
    rows,
    totalRows,
    ...(footer !== undefined ? { footer } : {}),
    potentiallyIncomplete: readIncomplete(metadata),
    ...(declaredRows !== undefined ? { declaredRows } : {}),
  };
}

function readIncomplete(metadata: Record<string, string>): boolean {
  return (metadata["Potential Incomplete Data"] ?? "").toLowerCase() === "true";
}

function readDeclaredRows(metadata: Record<string, string>): number | undefined {
  const raw = metadata.Rows;
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}
