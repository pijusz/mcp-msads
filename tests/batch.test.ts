import { describe, expect, test } from "bun:test";
import { assertBatchLimit, chunk, mapBatchResult } from "@/utils/batch";

describe("mapBatchResult", () => {
  test("marks every item successful when nothing failed", () => {
    const r = mapBatchResult({ CampaignIds: ["10", "11"] }, "CampaignIds", ["a", "b"]);
    expect(r).toMatchObject({ submitted: 2, succeeded: 2, failed: 0, all_failed: false });
    expect(r.ids).toEqual(["10", "11"]);
  });

  test("reconciles a null id with its PartialErrors entry", () => {
    // Microsoft nulls the failed slot and reports the reason out of band.
    const r = mapBatchResult(
      {
        CampaignIds: ["10", null, "12"],
        PartialErrors: [
          {
            Index: 1,
            Code: 1042,
            ErrorCode: "CampaignServiceDuplicateCampaignName",
            Message: "Duplicate name.",
            FieldPath: "Campaign.Name",
          },
        ],
      },
      "CampaignIds",
      ["Brand", "Brand", "Generic"],
    );

    expect(r).toMatchObject({ submitted: 3, succeeded: 2, failed: 1 });
    expect(r.ids).toEqual(["10", "12"]);

    const failure = r.outcomes[1];
    expect(failure?.success).toBe(false);
    expect(failure?.label).toBe("Brand");
    expect(failure?.error?.error_code).toBe("CampaignServiceDuplicateCampaignName");
    expect(failure?.error?.field_path).toBe("Campaign.Name");
    // The successful neighbours keep their ids.
    expect(r.outcomes[0]?.id).toBe("10");
    expect(r.outcomes[2]?.id).toBe("12");
  });

  test("handles a wholly failed batch that returns no id array at all", () => {
    const r = mapBatchResult(
      {
        PartialErrors: [
          { Index: 0, Code: 1 },
          { Index: 1, Code: 2 },
        ],
      },
      "KeywordIds",
      [],
      2,
    );
    expect(r.all_failed).toBe(true);
    expect(r.succeeded).toBe(0);
    expect(r.failed).toBe(2);
  });

  test("flattens NestedPartialErrors into the same outcome list", () => {
    const r = mapBatchResult(
      {
        AdGroupIds: [null, "22"],
        NestedPartialErrors: [
          { Index: 7, BatchErrors: [{ Index: 0, Code: 99, Message: "bad" }] },
        ],
      },
      "AdGroupIds",
    );
    expect(r.outcomes[0]?.error?.code).toBe(99);
    expect(r.outcomes[0]?.error?.parent_index).toBe(7);
    expect(r.outcomes[0]?.index).toBe(0);
    expect(r.outcomes[1]?.success).toBe(true);
  });

  test("does not claim success when an item got neither id nor error", () => {
    const r = mapBatchResult({ CampaignIds: [null] }, "CampaignIds", ["x"]);
    expect(r.outcomes[0]?.success).toBe(false);
    expect(r.outcomes[0]?.error?.message).toContain("neither an id nor an error");
  });

  test("preserves multiple errors attributed to the same item", () => {
    const result = mapBatchResult(
      {
        CampaignIds: [null],
        PartialErrors: [
          { Index: 0, Code: 1, Message: "first" },
          { Index: 0, Code: 2, Message: "second" },
        ],
      },
      "CampaignIds",
      ["item"],
      1,
    );
    expect(result.outcomes[0]?.error?.message).toBe("first");
    expect(result.outcomes[0]?.errors?.map((error) => error.message)).toEqual([
      "first",
      "second",
    ]);
  });

  test("treats invalid indexes as unattributed without inventing items", () => {
    const result = mapBatchResult(
      {
        CampaignIds: [null],
        PartialErrors: [
          { Index: -1, Code: 1, Message: "negative" },
          { Index: 9, Code: 2, Message: "outside" },
        ],
      },
      "CampaignIds",
      ["only"],
      1,
    );
    expect(result.submitted).toBe(1);
    expect(result.outcomes.filter((outcome) => outcome.index >= 0)).toHaveLength(1);
    expect(result.unattributed_errors?.map((error) => error.message)).toEqual([
      "negative",
      "outside",
    ]);
  });

  test("surfaces an unindexed error without corrupting the counts", () => {
    // An error the API could not attribute to an item describes the REQUEST.
    // Counting it in `failed` would make succeeded + failed exceed submitted.
    const r = mapBatchResult(
      { CampaignIds: ["1", "2"], PartialErrors: [{ Code: 500, Message: "orphan" }] },
      "CampaignIds",
    );
    expect(r.submitted).toBe(2);
    expect(r.succeeded).toBe(2);
    expect(r.failed).toBe(0);
    expect(r.succeeded + r.failed).toBe(r.submitted);
    expect(r.unattributed_errors?.[0]?.message).toBe("orphan");
    expect(r.outcomes.find((o) => o.index === -1)?.error?.message).toBe("orphan");
  });

  test("all_failed stays false when nothing was submitted", () => {
    expect(mapBatchResult({}, "CampaignIds", [], 0).all_failed).toBe(false);
  });
});

describe("chunk", () => {
  test("splits to the requested size", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  test("returns nothing for an empty list", () => {
    expect(chunk([], 10)).toEqual([]);
  });

  test("keeps a short list in one chunk", () => {
    expect(chunk([1], 100)).toEqual([[1]]);
  });

  test("rejects a nonsensical chunk size", () => {
    expect(() => chunk([1], 0)).toThrow();
  });
});

describe("assertBatchLimit", () => {
  test("names the real limit rather than failing vaguely", () => {
    expect(() => assertBatchLimit(new Array(101), 100, "campaigns")).toThrow(
      /at most 100 per call/,
    );
  });

  test("rejects an empty batch", () => {
    expect(() => assertBatchLimit([], 100, "campaigns")).toThrow(/No campaigns supplied/);
  });

  test("accepts a batch exactly at the limit", () => {
    expect(() => assertBatchLimit(new Array(100), 100, "campaigns")).not.toThrow();
  });
});
