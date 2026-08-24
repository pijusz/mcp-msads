import { describe, expect, test } from "bun:test";
import { buildOfflineConversion } from "@/services/conversions";
import { sha256Hex } from "@/services/pii";

const RECENT = () => new Date(Date.now() - 3600_000).toISOString();

describe("buildOfflineConversion", () => {
  test("builds a conversion identified by click id", () => {
    const out = buildOfflineConversion(
      {
        conversionName: "Purchase",
        conversionTime: RECENT(),
        microsoftClickId: "abc123",
        conversionValue: 49.99,
        conversionCurrencyCode: "USD",
      },
      0,
    );
    expect(out.ConversionName).toBe("Purchase");
    expect(out.MicrosoftClickId).toBe("abc123");
    expect(out.ConversionValue).toBe(49.99);
  });

  test("hashes a plaintext email rather than sending it", () => {
    const out = buildOfflineConversion(
      { conversionName: "Lead", conversionTime: RECENT(), email: "Someone@Example.com" },
      0,
    );
    expect(out.HashedEmailAddress).toBe(sha256Hex("someone@example.com"));
    expect(JSON.stringify(out)).not.toContain("Someone@Example.com");
  });

  test("normalizes the timestamp to ISO 8601 UTC", () => {
    const out = buildOfflineConversion(
      { conversionName: "X", conversionTime: RECENT(), microsoftClickId: "c" },
      0,
    );
    expect(String(out.ConversionTime)).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  test("requires an identity, since an unidentified conversion is discarded", () => {
    expect(() =>
      buildOfflineConversion({ conversionName: "X", conversionTime: RECENT() }, 2),
    ).toThrow(/index 2 has no identity/);
  });

  test("accepts email alone as identity, without a click id", () => {
    expect(() =>
      buildOfflineConversion(
        { conversionName: "X", conversionTime: RECENT(), email: "a@b.com" },
        0,
      ),
    ).not.toThrow();
  });

  test("requires a conversion name, which must match a goal exactly", () => {
    expect(() =>
      buildOfflineConversion(
        { conversionName: "", conversionTime: RECENT(), microsoftClickId: "c" },
        0,
      ),
    ).toThrow(/silently discarded/);
  });

  test("rejects a conversion older than 90 days", () => {
    const old = new Date(Date.now() - 100 * 24 * 3600_000).toISOString();
    expect(() =>
      buildOfflineConversion(
        { conversionName: "X", conversionTime: old, microsoftClickId: "c" },
        0,
      ),
    ).toThrow(/older than 90 days/);
  });

  test("rejects a future conversion time", () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(() =>
      buildOfflineConversion(
        { conversionName: "X", conversionTime: future, microsoftClickId: "c" },
        0,
      ),
    ).toThrow(/in the future/);
  });

  test("rejects an unparseable timestamp with a format hint", () => {
    expect(() =>
      buildOfflineConversion(
        { conversionName: "X", conversionTime: "yesterday", microsoftClickId: "c" },
        0,
      ),
    ).toThrow(/ISO 8601 UTC/);
  });

  test("bounds external attribution credit to (0, 1]", () => {
    for (const credit of [0, 1.5, -0.2]) {
      expect(() =>
        buildOfflineConversion(
          {
            conversionName: "X",
            conversionTime: RECENT(),
            microsoftClickId: "c",
            externalAttributionCredit: credit,
          },
          0,
        ),
      ).toThrow(/greater than 0 and at most 1/);
    }
    expect(() =>
      buildOfflineConversion(
        {
          conversionName: "X",
          conversionTime: RECENT(),
          microsoftClickId: "c",
          externalAttributionCredit: 0.5,
        },
        0,
      ),
    ).not.toThrow();
  });

  test("omits fields the caller did not supply", () => {
    const out = buildOfflineConversion(
      { conversionName: "X", conversionTime: RECENT(), microsoftClickId: "c" },
      0,
    );
    expect(out).not.toHaveProperty("HashedEmailAddress");
    expect(out).not.toHaveProperty("ConversionValue");
  });
});
