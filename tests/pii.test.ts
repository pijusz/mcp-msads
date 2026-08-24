import { describe, expect, test } from "bun:test";
import {
  hashBatch,
  hashEmail,
  hashPhone,
  isSha256Hex,
  normalizeEmail,
  normalizePhone,
  sha256Hex,
} from "@/services/pii";

describe("normalizeEmail", () => {
  test("lower-cases and trims", () => {
    expect(normalizeEmail("  Someone@Example.COM ")).toBe("someone@example.com");
  });

  test("drops a plus tag from the local part", () => {
    expect(normalizeEmail("someone+ads@example.com")).toBe("someone@example.com");
  });

  test("removes dots from the local part, as Microsoft does", () => {
    // Microsoft strips dots on their side before hashing. Keeping them here
    // would produce a hash their records never match — silently.
    expect(normalizeEmail("first.last@example.com")).toBe("firstlast@example.com");
  });

  test("keeps dots in the domain", () => {
    expect(normalizeEmail("a@mail.example.co.uk")).toBe("a@mail.example.co.uk");
  });

  test("strips accents", () => {
    expect(normalizeEmail("josé@example.com")).toBe("jose@example.com");
  });

  test("drops a plus tag before stripping dots, so a dotted tag goes too", () => {
    expect(normalizeEmail("first.last+news.letter@example.com")).toBe(
      "firstlast@example.com",
    );
  });

  test("leaves a plus in the domain alone", () => {
    expect(normalizeEmail("a@ex+ample.com")).toBe("a@ex+ample.com");
  });

  test("passes through a string with no @", () => {
    expect(normalizeEmail(" NotAnEmail ")).toBe("notanemail");
  });
});

describe("normalizePhone", () => {
  test("keeps an E.164 number and strips formatting", () => {
    expect(normalizePhone("+1 (425) 555-1212")).toBe("+14255551212");
  });

  test("applies a default country code when none is present", () => {
    expect(normalizePhone("425-555-1212", "1")).toBe("+14255551212");
  });

  test("does not double the country code when it is already there", () => {
    expect(normalizePhone("14255551212", "1")).toBe("+14255551212");
  });

  test("refuses to guess a missing country code without echoing the identifier", () => {
    // Guessing would silently attribute users to the wrong country.
    const raw = "4255551212";
    const error = (() => {
      try {
        normalizePhone(raw);
      } catch (caught) {
        return caught as Error;
      }
    })();
    expect(error?.message).toMatch(/no country code/);
    expect(error?.message).not.toContain(raw);
  });

  test("rejects a value with no digits without echoing the identifier", () => {
    const raw = "not-a-phone";
    const error = (() => {
      try {
        normalizePhone(raw);
      } catch (caught) {
        return caught as Error;
      }
    })();
    expect(error?.message).toMatch(/no digits/);
    expect(error?.message).not.toContain(raw);
  });
});

describe("hashEmail / hashPhone", () => {
  test("hashes the normalized form, not the raw input", () => {
    const { hash, preHashed } = hashEmail("  Someone+Ads@Example.com ");
    expect(preHashed).toBe(false);
    expect(hash).toBe(sha256Hex("someone@example.com"));
  });

  test("produces a 64-character lower-case hex digest", () => {
    expect(hashEmail("a@b.com").hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("passes an already-hashed value through instead of re-hashing", () => {
    // Re-hashing a digest would produce a value that matches nothing.
    const digest = sha256Hex("someone@example.com");
    const result = hashEmail(digest.toUpperCase());
    expect(result.preHashed).toBe(true);
    expect(result.hash).toBe(digest);
  });

  test("addresses differing only by case or plus tag hash identically", () => {
    expect(hashEmail("Someone@Example.com").hash).toBe(
      hashEmail("someone+promo@example.com").hash,
    );
  });

  test("hashes a phone from its E.164 form", () => {
    expect(hashPhone("+1 425 555 1212").hash).toBe(sha256Hex("+14255551212"));
  });
});

describe("isSha256Hex", () => {
  test("recognises a digest in either case", () => {
    const d = sha256Hex("x");
    expect(isSha256Hex(d)).toBe(true);
    expect(isSha256Hex(d.toUpperCase())).toBe(true);
  });

  test("rejects near-misses", () => {
    expect(isSha256Hex("abc")).toBe(false);
    expect(isSha256Hex(`${"a".repeat(63)}z`)).toBe(false);
  });
});

describe("hashBatch", () => {
  test("hashes a whole batch and counts pre-hashed entries", () => {
    const digest = sha256Hex("x@y.com");
    const result = hashBatch(["a@b.com", digest], "email");
    expect(result.total).toBe(2);
    expect(result.hashes).toHaveLength(2);
    expect(result.preHashed).toBe(1);
    expect(result.rejected).toEqual([]);
  });

  test("keeps the good rows when some fail, and says which failed", () => {
    // One bad phone number must not cost the caller the other 49,999.
    const result = hashBatch(["+14255551212", "5551212", "+442071234567"], "phone");
    expect(result.hashes).toHaveLength(2);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.index).toBe(1);
    expect(result.rejected[0]?.reason).toMatch(/country code/);
    expect(result.rejected[0]?.reason).not.toContain("5551212");
  });

  test("applies a default country code across the batch", () => {
    const result = hashBatch(["4255551212", "2065551212"], "phone", "1");
    expect(result.rejected).toEqual([]);
    expect(result.hashes[0]).toBe(sha256Hex("+14255551212"));
  });
});

describe("Microsoft's published test vectors", () => {
  // Straight from the Conversions API documentation. These pin the whole
  // normalize-then-hash pipeline against Microsoft's own implementation; if
  // either drifts, customer matching silently degrades rather than erroring.
  test("email vector matches", () => {
    expect(hashEmail("john@contoso.com").hash).toBe(
      "ec81f3ac7b2b19675bab9d54cf416f9f18cff87c97da5cca82c0f0891bc40602",
    );
  });

  test("phone vector matches", () => {
    expect(hashPhone("+14255551234").hash).toBe(
      "c59475d96e9f01d7d18d06cfad84dd02333207f02c0c2c5663ef2782cda0390e",
    );
  });

  test("the email vector survives messy input", () => {
    // Same address with padding, caps, a dotted local part, and a plus tag.
    expect(hashEmail("  Jo.hn+Promo@Contoso.COM ").hash).toBe(
      "ec81f3ac7b2b19675bab9d54cf416f9f18cff87c97da5cca82c0f0891bc40602",
    );
  });

  test("the phone vector survives formatting", () => {
    expect(hashPhone("+1 (425) 555-1234").hash).toBe(
      "c59475d96e9f01d7d18d06cfad84dd02333207f02c0c2c5663ef2782cda0390e",
    );
  });
});
