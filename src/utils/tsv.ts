/**
 * TSV (tab-separated values) serialization for tabular data — report rows mostly.
 *
 * Tab / newline / carriage-return inside values collapse to single spaces: TSV
 * has no quoting convention, so the only escape is to not emit them. Object
 * values are JSON-stringified before scrubbing.
 */
export function rowsToTsv(
  rows: Array<Record<string, unknown>>,
  columns?: string[],
): string {
  if (rows.length === 0) return "";

  const cols = new Set(columns?.length ? columns : undefined);
  if (!columns?.length) {
    for (const row of rows) {
      for (const key of Object.keys(row)) cols.add(key);
    }
  }
  const headers = Array.from(cols);
  const body = rows
    .map((row) => headers.map((h) => escapeCell(row[h])).join("\t"))
    .join("\n");
  return `${headers.join("\t")}\n${body}`;
}

function escapeCell(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") {
    return JSON.stringify(value).replace(/[\t\n\r]/g, " ");
  }
  return String(value).replace(/[\t\n\r]/g, " ");
}
