import { normalizeTypeAlias, stripSuffix } from "@/services/wire-types";
import { MsAdsError } from "@/utils/errors";

/**
 * Validation for API behaviour that changed and now fails — or worse, silently
 * does nothing. Each rule here exists because the obvious request produces a
 * confusing outcome rather than a clear rejection.
 */

/** The only match types v13 accepts. `Content` and broad-match-modifier are gone. */
export const MATCH_TYPES = ["Broad", "Phrase", "Exact"] as const;
const MATCH_TYPE_SET = new Set<string>(MATCH_TYPES);

/** Negative keywords accept only these; Broad is not a negative match type. */
export const NEGATIVE_MATCH_TYPES = ["Exact", "Phrase"] as const;
const NEGATIVE_MATCH_TYPE_SET = new Set<string>(NEGATIVE_MATCH_TYPES);

/** Campaign types that can actually be created through the API today. */
export const CAMPAIGN_TYPES = [
  "Search",
  "Shopping",
  "Audience",
  "PerformanceMax",
  "Hotel",
  "App",
] as const;
const CAMPAIGN_TYPE_SET = new Set<string>(CAMPAIGN_TYPES);

/**
 * Bid strategies settable on a campaign today, by short name.
 *
 * `TargetCpa` and `TargetRoas` are deliberately absent: since 2025-08-04 the
 * API silently converts them to MaxConversions / MaxConversionValue, so
 * offering them would let a caller believe they set something they did not.
 * The target values live on the converted schemes.
 *
 * Callers may pass the class name (`ManualCpcBiddingScheme`) or the short form
 * (`ManualCpc`). The REST docs disagree with themselves on which is sent; the
 * strongest evidence is Microsoft's generated REST SDK (BingAds-Python-SDK
 * `openapi_client/models/campaign/bidding_scheme.py`), whose serializer emits
 * the short form except for the `keepFull` schemes below, which it sends as
 * full class names. Its deserializer accepts both spellings.
 */
const BID_STRATEGY_NAMES = [
  "EnhancedCpc",
  "ManualCpc",
  "ManualCpm",
  "ManualCpv",
  "MaxClicks",
  "MaxConversions",
  "MaxConversionValue",
  "MaxRoas",
  "TargetImpressionShare",
  "PercentCpc",
  "Commission",
  "CostPerSale",
  "InheritFromParent",
] as const;

const BID_STRATEGY_SUFFIX = "BiddingScheme";

const BID_STRATEGY_ALIASES = {
  suffix: BID_STRATEGY_SUFFIX,
  allowed: new Set<string>(BID_STRATEGY_NAMES),
  keepFull: new Set<string>([
    "MaxConversionValue",
    "MaxRoas",
    "TargetImpressionShare",
    "PercentCpc",
    "Commission",
  ]),
};

const BID_STRATEGY_CLASS_NAMES = BID_STRATEGY_NAMES.map(
  (name) => `${name}${BID_STRATEGY_SUFFIX}`,
);

/** Every accepted spelling: class names and their short forms. */
export const BID_STRATEGIES = [
  ...BID_STRATEGY_CLASS_NAMES,
  ...BID_STRATEGY_NAMES,
] as string[] as [string, ...string[]];

/** Keyed by short name, so both spellings are rejected. */
const REMOVED_BID_STRATEGIES = new Map<string, string>([
  [
    "TargetCpa",
    "TargetCpaBiddingScheme can no longer be set on a campaign (since 2025-08-04). " +
      "Use MaxConversionsBiddingScheme and put your target in its TargetCpa field — that is exactly what the API does internally.",
  ],
  [
    "TargetRoas",
    "TargetRoasBiddingScheme can no longer be set on a campaign (since 2025-08-04). " +
      "Use MaxConversionValueBiddingScheme and put your target in its TargetRoas field.",
  ],
]);

/** Wire `Type` for either spelling; throws on removed or unknown strategies. */
function bidStrategyWireType(type: string): string {
  const removed = REMOVED_BID_STRATEGIES.get(stripSuffix(type, BID_STRATEGY_SUFFIX));
  if (removed) throw new MsAdsError({ message: removed });

  const wire = normalizeTypeAlias(type, BID_STRATEGY_ALIASES);
  if (!wire) {
    throw new MsAdsError({
      message: `Unknown bid strategy "${type}". Valid values: ${BID_STRATEGY_CLASS_NAMES.join(", ")} (the short form without "BiddingScheme" is accepted too).`,
    });
  }
  return wire;
}

function schemeType(scheme: unknown): string | undefined {
  if (!scheme || typeof scheme !== "object") return undefined;
  const type = (scheme as Record<string, unknown>).Type;
  return typeof type === "string" ? type : undefined;
}

export function validateBidStrategy(scheme: unknown): void {
  const type = schemeType(scheme);
  if (type !== undefined) bidStrategyWireType(type);
}

/**
 * Validate, then rewrite `Type` to the value Microsoft's REST SDK sends.
 * Returns the input unchanged when there is no typed scheme.
 */
export function normalizeBiddingScheme(scheme: unknown): unknown {
  const type = schemeType(scheme);
  if (type === undefined) return scheme;
  return { ...(scheme as Record<string, unknown>), Type: bidStrategyWireType(type) };
}

export function validateCampaignType(type: unknown): void {
  if (typeof type !== "string") return;

  if (type === "DynamicSearchAds") {
    throw new MsAdsError({
      message:
        "DynamicSearchAds is no longer a valid campaign type — existing ones were converted to Search. " +
        "Create a Search campaign and add a SearchDynamic ad group instead.",
    });
  }
  if (!CAMPAIGN_TYPE_SET.has(type)) {
    throw new MsAdsError({
      message: `Unknown campaign type "${type}". Valid values: ${CAMPAIGN_TYPES.join(", ")}.`,
    });
  }
}

export function validateMatchType(matchType: unknown): void {
  if (typeof matchType !== "string") return;
  if (!MATCH_TYPE_SET.has(matchType)) {
    const extra =
      matchType === "Content"
        ? " `Content` was removed in v13."
        : /modifier/i.test(matchType)
          ? " Broad match modifier no longer exists; use Phrase."
          : "";
    throw new MsAdsError({
      message: `Invalid match type "${matchType}". Valid values: ${MATCH_TYPES.join(", ")}.${extra}`,
    });
  }
}

/** Negative keywords have no Broad match; the match type is required. */
export function validateNegativeMatchType(matchType: unknown, text?: string): void {
  if (typeof matchType === "string" && NEGATIVE_MATCH_TYPE_SET.has(matchType)) return;
  const keyword = text === undefined ? "" : ` for "${text}"`;
  throw new MsAdsError({
    message: `Invalid negative match type "${String(matchType)}"${keyword}. Negative keywords support only ${NEGATIVE_MATCH_TYPES.join(" and ")}; Broad is not a negative match type.`,
  });
}

/**
 * Bid strategies have been campaign-level only since April 2021. Setting one
 * on an ad group or keyword is *silently ignored*, so refusing here is the
 * only way the caller learns it did nothing.
 */
export function rejectChildBidStrategy(
  entity: Record<string, unknown>,
  level: string,
): void {
  if (entity.BiddingScheme !== undefined) {
    throw new MsAdsError({
      message:
        `Bid strategies cannot be set at the ${level} level — the API accepts the field and ignores it (campaign level only since April 2021). ` +
        "Set BiddingScheme on the campaign instead.",
    });
  }
}

/**
 * Ad extension updates replace the whole object: any optional field left out
 * is cleared. Partial update works for most other entities, which makes this
 * especially easy to get wrong.
 */
export const AD_EXTENSION_UPDATE_WARNING =
  "Ad extension updates are full replacements, not partial updates: any optional field you omit will be CLEARED. " +
  "Read the extension first and resend every field you want to keep.";
