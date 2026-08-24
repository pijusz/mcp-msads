import { describe, expect, test } from "bun:test";
import { toMsDate } from "@/services/reporting";

/**
 * The campaign tools accept ISO date strings and convert on the way out, so a
 * date means the same thing in run_report and create_campaigns. Building the
 * object form by hand is API error 113.
 */
describe("date handling consistency", () => {
  test("an ISO string converts to the API's date object", () => {
    expect(toMsDate("2026-08-01")).toEqual({ Year: 2026, Month: 8, Day: 1 });
  });

  test("the same string form works for reports and for campaign dates", () => {
    // One representation across the whole surface.
    const iso = "2026-12-31";
    expect(toMsDate(iso)).toEqual({ Year: 2026, Month: 12, Day: 31 });
  });
});
