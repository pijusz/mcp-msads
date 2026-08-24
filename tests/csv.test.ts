import { describe, expect, test } from "bun:test";
import { parseDelimited, parseReportCsv } from "@/utils/csv";

describe("parseDelimited", () => {
  test("splits a simple grid", () => {
    expect(parseDelimited("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  test("keeps delimiters that sit inside quotes", () => {
    expect(parseDelimited('"Smith, John",42')).toEqual([["Smith, John", "42"]]);
  });

  test("unescapes doubled quotes", () => {
    expect(parseDelimited('"He said ""hi""",x')).toEqual([['He said "hi"', "x"]]);
  });

  test("keeps newlines that sit inside quotes", () => {
    expect(parseDelimited('"line1\nline2",b')).toEqual([["line1\nline2", "b"]]);
  });

  test("treats CRLF as one row terminator", () => {
    expect(parseDelimited("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  test("does not invent a trailing row for a trailing newline", () => {
    expect(parseDelimited("a\nb\n")).toEqual([["a"], ["b"]]);
  });

  test("preserves empty fields", () => {
    expect(parseDelimited("a,,c")).toEqual([["a", "", "c"]]);
  });

  test("strips a UTF-8 BOM", () => {
    expect(parseDelimited("﻿a,b")).toEqual([["a", "b"]]);
  });

  test("supports a tab delimiter for Tsv reports", () => {
    expect(parseDelimited("a\tb\n1\t2", "\t")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

// A faithful reproduction of the layout in Microsoft's own reports doc.
const FULL_REPORT = `"Report Name: My Keyword Performance Report"
"Report Time: 2/7/2020"
"Time Zone: (GMT-08:00) Pacific Time (US & Canada); Tijuana"
"Last Completed Available Day: 2/8/2020 10:15:00 PM (GMT)"
"Report Aggregation: Summary"
"Report Filter: "
"Potential Incomplete Data: true"
"Rows: 2"

"AccountId","CampaignId","Keyword","Clicks"
"123","456","red shoes","35"
"123","456","blue, suede shoes","7"

"@2020 Microsoft Corporation. All rights reserved. "
`;

describe("parseReportCsv", () => {
  test("separates metadata, columns, rows, and footer", () => {
    const r = parseReportCsv(FULL_REPORT);
    expect(r.metadata["Report Name"]).toBe("My Keyword Performance Report");
    expect(r.metadata["Report Aggregation"]).toBe("Summary");
    expect(r.columns).toEqual(["AccountId", "CampaignId", "Keyword", "Clicks"]);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toEqual({
      AccountId: "123",
      CampaignId: "456",
      Keyword: "red shoes",
      Clicks: "35",
    });
    expect(r.footer).toContain("Microsoft Corporation");
  });

  test("surfaces the incomplete-data flag rather than burying it", () => {
    expect(parseReportCsv(FULL_REPORT).potentiallyIncomplete).toBe(true);
  });

  test("reads the declared row count and it matches what was parsed", () => {
    const r = parseReportCsv(FULL_REPORT);
    expect(r.declaredRows).toBe(2);
    expect(r.rows).toHaveLength(r.declaredRows as number);
  });

  test("counts all rows while retaining only the requested ceiling", () => {
    const data = Array.from({ length: 100 }, (_, index) => `"${index}","value"`).join(
      "\n",
    );
    const report = parseReportCsv(`"Id","Value"\n${data}\n`, ",", 2);
    expect(report.rows).toHaveLength(2);
    expect(report.totalRows).toBe(100);
    expect(report.rows[1]?.Id).toBe("1");
  });

  test("keeps a comma inside a quoted keyword intact", () => {
    expect(parseReportCsv(FULL_REPORT).rows[1]?.Keyword).toBe("blue, suede shoes");
  });

  test("handles a report with the header block excluded", () => {
    const r = parseReportCsv('"CampaignId","Clicks"\n"1","5"\n');
    expect(r.metadata).toEqual({});
    expect(r.columns).toEqual(["CampaignId", "Clicks"]);
    expect(r.rows).toEqual([{ CampaignId: "1", Clicks: "5" }]);
    expect(r.potentiallyIncomplete).toBe(false);
  });

  test("handles a report with zero data rows", () => {
    const r = parseReportCsv(
      '"Report Name: Empty"\n"Rows: 0"\n\n"CampaignId","Clicks"\n',
    );
    expect(r.columns).toEqual(["CampaignId", "Clicks"]);
    expect(r.rows).toEqual([]);
    expect(r.declaredRows).toBe(0);
  });

  test("returns empty results for an entirely empty download", () => {
    const r = parseReportCsv("");
    expect(r.columns).toEqual([]);
    expect(r.rows).toEqual([]);
  });

  test("pads a short row instead of dropping its columns", () => {
    const r = parseReportCsv('"A","B","C"\n"1","2"\n');
    expect(r.rows[0]).toEqual({ A: "1", B: "2", C: "" });
  });

  test("parses a Tsv report", () => {
    const r = parseReportCsv('"CampaignId"\t"Clicks"\n"1"\t"5"\n', "\t");
    expect(r.rows).toEqual([{ CampaignId: "1", Clicks: "5" }]);
  });
});
