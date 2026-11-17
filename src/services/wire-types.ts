/**
 * Discriminator aliasing. Microsoft's REST docs spell some `Type` values as
 * class names (`ManualCpcBiddingScheme`, `UrlGoal`) and others as short enum
 * values (`ManualCpc`, `Url`); its generated REST SDK accepts both on read.
 * These helpers accept either spelling and pick the one sent on the wire.
 */

/** `ManualCpcBiddingScheme` → `ManualCpc`; values without the suffix pass through. */
export function stripSuffix(value: string, suffix: string): string {
  return value.endsWith(suffix) ? value.slice(0, -suffix.length) : value;
}

export interface TypeAliasOptions {
  /** Class-name suffix, e.g. `BiddingScheme` or `Goal`. */
  suffix: string;
  /** Accepted short names (without the suffix). */
  allowed: ReadonlySet<string>;
  /** Short names whose wire form is the full class name. */
  keepFull?: ReadonlySet<string>;
}

/** Wire name for either spelling of `value`, or undefined if it is not allowed. */
export function normalizeTypeAlias(
  value: string,
  { suffix, allowed, keepFull }: TypeAliasOptions,
): string | undefined {
  const short = stripSuffix(value, suffix);
  if (!allowed.has(short)) return undefined;
  return keepFull?.has(short) ? `${short}${suffix}` : short;
}
