import { MsAdsError } from "@/utils/errors";

/**
 * Validation for API behaviour that changed and now fails — or worse, silently
 * does nothing. Each rule here exists because the obvious request produces a
 * confusing outcome rather than a clear rejection.
 */

/** The only match types v13 accepts. `Content` and broad-match-modifier are gone. */
export const MATCH_TYPES = ["Broad", "Phrase", "Exact"] as const;

/** Campaign types that can actually be created through the API today. */
export const CAMPAIGN_TYPES = [
  "Search",
  "Shopping",
  "Audience",
  "PerformanceMax",
  "Hotel",
  "App",
] as const;

/**
 * Bid strategies settable on a campaign today.
 *
 * `TargetCpaBiddingScheme` and `TargetRoasBiddingScheme` are deliberately
 * absent: since 2025-08-04 the API silently converts them to MaxConversions /
 * MaxConversionValue, so offering them would let a caller believe they set
 * something they did not. The target values live on the converted schemes.
 */
export const BID_STRATEGIES = [
  "EnhancedCpcBiddingScheme",
  "ManualCpcBiddingScheme",
  "ManualCpmBiddingScheme",
  "ManualCpvBiddingScheme",
  "MaxClicksBiddingScheme",
  "MaxConversionsBiddingScheme",
  "MaxConversionValueBiddingScheme",
  "MaxRoasBiddingScheme",
  "TargetImpressionShareBiddingScheme",
  "PercentCpcBiddingScheme",
  "CommissionBiddingScheme",
  "CostPerSaleBiddingScheme",
  "InheritFromParentBiddingScheme",
] as const;

const REMOVED_BID_STRATEGIES: Record<string, string> = {
  TargetCpaBiddingScheme:
    "TargetCpaBiddingScheme can no longer be set on a campaign (since 2025-08-04). " +
    "Use MaxConversionsBiddingScheme and put your target in its TargetCpa field — that is exactly what the API does internally.",
  TargetRoasBiddingScheme:
    "TargetRoasBiddingScheme can no longer be set on a campaign (since 2025-08-04). " +
    "Use MaxConversionValueBiddingScheme and put your target in its TargetRoas field.",
};

export function validateBidStrategy(scheme: unknown): void {
  if (!scheme || typeof scheme !== "object") return;
  const type = (scheme as Record<string, unknown>).Type;
  if (typeof type !== "string") return;

  const removed = REMOVED_BID_STRATEGIES[type];
  if (removed) throw new MsAdsError({ message: removed });

  if (!(BID_STRATEGIES as readonly string[]).includes(type)) {
    throw new MsAdsError({
      message: `Unknown bid strategy "${type}". Valid values: ${BID_STRATEGIES.join(", ")}.`,
    });
  }
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
  if (!(CAMPAIGN_TYPES as readonly string[]).includes(type)) {
    throw new MsAdsError({
      message: `Unknown campaign type "${type}". Valid values: ${CAMPAIGN_TYPES.join(", ")}.`,
    });
  }
}

export function validateMatchType(matchType: unknown): void {
  if (typeof matchType !== "string") return;
  if (!(MATCH_TYPES as readonly string[]).includes(matchType)) {
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
