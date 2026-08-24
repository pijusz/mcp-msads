import { describe, expect, test } from "bun:test";
import {
  rejectChildBidStrategy,
  validateBidStrategy,
  validateCampaignType,
  validateMatchType,
} from "@/services/guardrails";

describe("validateBidStrategy", () => {
  test("accepts a currently-settable strategy", () => {
    expect(() =>
      validateBidStrategy({ Type: "MaxConversionsBiddingScheme", TargetCpa: 25 }),
    ).not.toThrow();
  });

  test("rejects TargetCpa and points at the scheme that replaced it", () => {
    // The API silently converts this, so accepting it would mislead the caller.
    expect(() => validateBidStrategy({ Type: "TargetCpaBiddingScheme" })).toThrow(
      /MaxConversionsBiddingScheme/,
    );
  });

  test("rejects TargetRoas and points at its replacement", () => {
    expect(() => validateBidStrategy({ Type: "TargetRoasBiddingScheme" })).toThrow(
      /MaxConversionValueBiddingScheme/,
    );
  });

  test("names the valid options for an unknown strategy", () => {
    expect(() => validateBidStrategy({ Type: "MagicBiddingScheme" })).toThrow(
      /Valid values:/,
    );
  });

  test("ignores a missing or untyped scheme", () => {
    expect(() => validateBidStrategy(undefined)).not.toThrow();
    expect(() => validateBidStrategy({})).not.toThrow();
  });
});

describe("validateCampaignType", () => {
  test("accepts the types that can still be created", () => {
    for (const t of ["Search", "Shopping", "Audience", "PerformanceMax"]) {
      expect(() => validateCampaignType(t)).not.toThrow();
    }
  });

  test("explains what replaced DynamicSearchAds", () => {
    expect(() => validateCampaignType("DynamicSearchAds")).toThrow(
      /SearchDynamic ad group/,
    );
  });

  test("rejects an unknown type", () => {
    expect(() => validateCampaignType("Video")).toThrow(/Valid values:/);
  });
});

describe("validateMatchType", () => {
  test("accepts the three real match types", () => {
    for (const m of ["Broad", "Phrase", "Exact"]) {
      expect(() => validateMatchType(m)).not.toThrow();
    }
  });

  test("says Content was removed rather than just rejecting it", () => {
    expect(() => validateMatchType("Content")).toThrow(/removed in v13/);
  });

  test("redirects broad match modifier to Phrase", () => {
    expect(() => validateMatchType("BroadMatchModifier")).toThrow(/use Phrase/);
  });
});

describe("rejectChildBidStrategy", () => {
  test("refuses an ad-group bid strategy, which the API would silently ignore", () => {
    expect(() =>
      rejectChildBidStrategy(
        { BiddingScheme: { Type: "ManualCpcBiddingScheme" } },
        "ad group",
      ),
    ).toThrow(/campaign level only/);
  });

  test("allows a per-keyword bid, which is a different thing entirely", () => {
    expect(() =>
      rejectChildBidStrategy({ Bid: { Amount: 1.5 } }, "keyword"),
    ).not.toThrow();
  });
});
