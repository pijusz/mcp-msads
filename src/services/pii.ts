import { createHash } from "node:crypto";

/**
 * Normalization and hashing for customer-match identifiers.
 *
 * Microsoft matches uploaded identifiers against its own records by hashing
 * both sides, so our normalization has to agree with theirs exactly — a
 * mismatched case or a stray space produces a silent non-match rather than an
 * error, which is the worst possible failure mode for an audience upload.
 *
 * Raw identifiers must never leave this process unhashed. Every entry point
 * that accepts an email or phone routes through here.
 *
 * https://learn.microsoft.com/en-us/advertising/guides/customer-match
 */

/** SHA-256, lower-case hex — the encoding both customer lists and CAPI expect. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** True when a string is already a SHA-256 hex digest. */
export function isSha256Hex(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value.trim());
}

/**
 * Normalize an email address per Microsoft's documented rules: strip accents,
 * lower-case, remove every dot from the local part, and drop a `+tag` suffix.
 *
 * Removing dots looks wrong — on most providers `first.last@` and `firstlast@`
 * are different mailboxes — but correctness here means *agreeing with
 * Microsoft*, not modelling email semantics. Microsoft applies this same
 * normalization to its own records before hashing, so skipping the dot rule
 * makes `jo.hn@contoso.com` hash to something their stored `john@contoso.com`
 * never matches. The failure is silent: no error, just an audience that
 * matches fewer people than it should.
 *
 * Verified against Microsoft's published test vectors in tests/pii.test.ts.
 */
export function normalizeEmail(email: string): string {
  const trimmed = stripAccents(email.trim()).toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return trimmed;

  let local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);

  // `+alias` is removed before dots so a tag containing dots goes with it.
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  local = local.replace(/\./g, "");

  return `${local}@${domain}`;
}

/**
 * Decompose accented characters and drop the combining marks, so that
 * `josé@x.com` and `jose@x.com` hash alike — which is what Microsoft does.
 */
function stripAccents(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Normalize a phone number to E.164: digits only, with a leading `+`.
 *
 * A country code is required. A bare national number cannot be matched, and
 * guessing one would silently attribute users to the wrong country, so a
 * number without one is rejected rather than assumed.
 */
export function normalizePhone(phone: string, defaultCountryCode?: string): string {
  const trimmed = phone.trim();
  const hadPlus = trimmed.startsWith("+");
  let digits = trimmed.replace(/\D/g, "");

  if (!digits) {
    throw new Error("Phone normalization failed: the value contains no digits.");
  }

  if (!hadPlus) {
    if (!defaultCountryCode) {
      throw new Error(
        "Phone normalization failed: the value has no country code. Microsoft requires E.164 format. " +
          "Supply default_country_code, or include the code in the number.",
      );
    }
    const cc = defaultCountryCode.replace(/\D/g, "");
    // A number may already carry the country code without a "+".
    digits = digits.startsWith(cc) ? digits : `${cc}${digits}`;
  }

  return `+${digits}`;
}

export interface HashedIdentifier {
  hash: string;
  /** True when the caller supplied an already-hashed value we passed through. */
  preHashed: boolean;
}

/**
 * Hash an email, passing through anything already hashed.
 *
 * The pass-through matters: callers frequently hold pre-hashed identifiers and
 * never have the plaintext. Re-hashing a digest would produce a value that
 * matches nothing.
 */
export function hashEmail(email: string): HashedIdentifier {
  if (isSha256Hex(email)) return { hash: email.trim().toLowerCase(), preHashed: true };
  return { hash: sha256Hex(normalizeEmail(email)), preHashed: false };
}

export function hashPhone(phone: string, defaultCountryCode?: string): HashedIdentifier {
  if (isSha256Hex(phone)) return { hash: phone.trim().toLowerCase(), preHashed: true };
  return { hash: sha256Hex(normalizePhone(phone, defaultCountryCode)), preHashed: false };
}

export interface HashSummary {
  hashes: string[];
  total: number;
  /** How many were already hashed when supplied. */
  preHashed: number;
  /** Entries we could not normalize, with the reason. */
  rejected: Array<{ index: number; reason: string }>;
}

/**
 * Hash a batch, keeping going past individual failures.
 *
 * An audience upload of 50,000 rows should not be lost because three phone
 * numbers lack a country code; the caller gets the good hashes plus a precise
 * list of what was dropped.
 */
export function hashBatch(
  values: string[],
  kind: "email" | "phone",
  defaultCountryCode?: string,
): HashSummary {
  const hashes: string[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  let preHashed = 0;

  values.forEach((value, index) => {
    try {
      const result =
        kind === "email" ? hashEmail(value) : hashPhone(value, defaultCountryCode);
      hashes.push(result.hash);
      if (result.preHashed) preHashed++;
    } catch (err) {
      rejected.push({ index, reason: (err as Error).message });
    }
  });

  return { hashes, total: values.length, preHashed, rejected };
}
