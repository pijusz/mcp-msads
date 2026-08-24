import { describe, expect, test } from "bun:test";
import { buildSearchParameters, validateKeywordIdeasInput } from "@/services/ad-insight";

const BASE = { locationIds: [190], language: "English" };

describe("buildSearchParameters", () => {
  test("always emits the three parameters the API requires", () => {
    const types = buildSearchParameters({ ...BASE, queries: ["shoes"] }).map(
      (p) => p.Type,
    );
    expect(types).toContain("LanguageSearchParameter");
    expect(types).toContain("LocationSearchParameter");
    expect(types).toContain("NetworkSearchParameter");
  });

  test("defaults the network rather than omitting it", () => {
    const network = buildSearchParameters({ ...BASE, queries: ["a"] }).find(
      (p) => p.Type === "NetworkSearchParameter",
    );
    expect(network?.Network).toEqual({ Network: "OwnedAndOperatedAndSyndicatedSearch" });
  });

  test("maps location ids into location criteria", () => {
    const loc = buildSearchParameters({
      ...BASE,
      locationIds: [190, 191],
      queries: ["a"],
    }).find((p) => p.Type === "LocationSearchParameter");
    expect(loc?.Locations).toEqual([{ LocationId: 190 }, { LocationId: 191 }]);
  });

  test("includes a query parameter when seeds are given", () => {
    const q = buildSearchParameters({ ...BASE, queries: ["running shoes"] }).find(
      (p) => p.Type === "QuerySearchParameter",
    );
    expect(q?.Queries).toEqual(["running shoes"]);
  });

  test("includes a url parameter when a seed page is given", () => {
    const u = buildSearchParameters({ ...BASE, url: "https://example.com" }).find(
      (p) => p.Type === "UrlSearchParameter",
    );
    expect(u?.Url).toBe("https://example.com");
  });

  test("emits volume and competition bands only when asked", () => {
    const plain = buildSearchParameters({ ...BASE, queries: ["a"] });
    expect(plain.some((p) => p.Type === "SearchVolumeSearchParameter")).toBe(false);

    const filtered = buildSearchParameters({
      ...BASE,
      queries: ["a"],
      minSearchVolume: 100,
      maxCompetition: 0.5,
    });
    expect(filtered.find((p) => p.Type === "SearchVolumeSearchParameter")?.Minimum).toBe(
      100,
    );
    expect(filtered.find((p) => p.Type === "CompetitionSearchParameter")?.Maximum).toBe(
      0.5,
    );
  });
});

describe("validateKeywordIdeasInput", () => {
  test("requires a seed of some kind", () => {
    expect(() => validateKeywordIdeasInput(BASE)).toThrow(/queries .*or url/);
  });

  test("requires location ids, which the API has no default for", () => {
    expect(() =>
      validateKeywordIdeasInput({ locationIds: [], language: "English", queries: ["a"] }),
    ).toThrow(/location_ids is required/);
  });

  test("rejects expand_ideas false with no seed terms to look up", () => {
    expect(() =>
      validateKeywordIdeasInput({ ...BASE, url: "https://x.com", expandIdeas: false }),
    ).toThrow(/nothing to look up/);
  });

  test("accepts a well-formed request", () => {
    expect(() =>
      validateKeywordIdeasInput({ ...BASE, queries: ["shoes"] }),
    ).not.toThrow();
  });
});
