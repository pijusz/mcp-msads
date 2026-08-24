import { describe, expect, test } from "bun:test";
import { assertCompleteDeviceSet, resolveCriterionType } from "@/services/targeting";

const wrap = (criterion: Record<string, unknown>) => ({
  Type: "BiddableAdGroupCriterion",
  Criterion: criterion,
});

describe("resolveCriterionType", () => {
  test("routes demographics to the Targets umbrella", () => {
    // Writes use an umbrella type; reads use the specific one. Callers should
    // not have to know that, so it is derived from the criterions.
    expect(resolveCriterionType([wrap({ Type: "AgeCriterion" })])).toBe("Targets");
    expect(resolveCriterionType([wrap({ Type: "GenderCriterion" })])).toBe("Targets");
  });

  test("routes location, schedule, and device to Targets", () => {
    for (const type of ["LocationCriterion", "DayTimeCriterion", "DeviceCriterion"]) {
      expect(resolveCriterionType([wrap({ Type: type })])).toBe("Targets");
    }
  });

  test("routes LinkedIn profile targeting to Targets", () => {
    expect(resolveCriterionType([wrap({ Type: "ProfileCriterion" })])).toBe("Targets");
  });

  test("routes audiences to the Audience umbrella", () => {
    expect(resolveCriterionType([wrap({ Type: "AudienceCriterion" })])).toBe("Audience");
  });

  test("allows mixed types within one umbrella", () => {
    expect(
      resolveCriterionType([
        wrap({ Type: "AgeCriterion" }),
        wrap({ Type: "GenderCriterion" }),
      ]),
    ).toBe("Targets");
  });

  test("refuses a batch that mixes umbrellas, explaining why", () => {
    // One call carries exactly one CriterionType, so this must be two calls.
    expect(() =>
      resolveCriterionType([
        wrap({ Type: "AgeCriterion" }),
        wrap({ Type: "AudienceCriterion" }),
      ]),
    ).toThrow(/separate calls/);
  });

  test("rejects a wrapper with no nested Criterion", () => {
    expect(() => resolveCriterionType([{ Type: "BiddableAdGroupCriterion" }])).toThrow(
      /nested Criterion object/,
    );
  });

  test("rejects an unknown criterion type", () => {
    expect(() => resolveCriterionType([wrap({ Type: "TelepathyCriterion" })])).toThrow(
      /Unsupported criterion type/,
    );
  });

  test("rejects an empty batch", () => {
    expect(() => resolveCriterionType([])).toThrow(/No criterions/);
  });
});

describe("assertCompleteDeviceSet", () => {
  test("accepts all three device types", () => {
    const all = ["Computers", "Smartphones", "Tablets"].map((d) =>
      wrap({ Type: "DeviceCriterion", DeviceName: d }),
    );
    expect(() => assertCompleteDeviceSet(all)).not.toThrow();
  });

  test("rejects a partial set, naming what is missing", () => {
    // The API accepts a partial set and then applies none of it — silently.
    expect(() =>
      assertCompleteDeviceSet([
        wrap({ Type: "DeviceCriterion", DeviceName: "Computers" }),
      ]),
    ).toThrow(/missing Smartphones, Tablets/);
  });

  test("ignores batches with no device criterions at all", () => {
    expect(() => assertCompleteDeviceSet([wrap({ Type: "AgeCriterion" })])).not.toThrow();
  });
});
