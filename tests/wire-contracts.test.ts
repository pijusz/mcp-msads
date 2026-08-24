import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAuthForTesting } from "@/auth/oauth";
import { resetEnvForTesting } from "@/config/env";
import { getKeywordIdeas } from "@/services/ad-insight";
import { updateAudiences } from "@/services/audiences";
import { getBillingDocumentsInfo, toBillingDateTime } from "@/services/billing";
import {
  AD_EXTENSION_TYPES,
  getAdExtensionAssociations,
  getNegativeKeywords,
  setAdExtensionAssociations,
} from "@/services/extensions";
import { deleteCriterions } from "@/services/targeting";
import { installMockFetch, type MockFetch, setTestEnv, tokenResponse } from "./_mock";

let mock: MockFetch;
const IDS = { accountId: "512300", customerId: "9900" };

beforeEach(() => {
  setTestEnv();
  resetEnvForTesting();
  resetAuthForTesting();
  mock = installMockFetch();
  mock.always("login.microsoftonline.com", tokenResponse());
});

afterEach(() => mock.restore());

function onlyCall(match: string) {
  const calls = mock.callsTo(match);
  expect(calls).toHaveLength(1);
  return calls[0]!;
}

describe("Customer Billing request contract", () => {
  test("sends UTC dateTime strings and the required invoice-number flag", async () => {
    mock.queue("BillingDocumentsInfo/Query", { json: { BillingDocumentsInfo: [] } });

    await getBillingDocumentsInfo(["9007199254740993"], "2026-08-01", "2026-08-31");

    const call = onlyCall("BillingDocumentsInfo/Query");
    expect(call.url).toBe(
      "https://clientcenter.api.bingads.microsoft.com/CustomerBilling/v13/BillingDocumentsInfo/Query",
    );
    expect(call.method).toBe("POST");
    expect(call.headers.authorization).toBe("Bearer test-access-token");
    expect(call.headers.developertoken).toBe("test-dev-token");
    expect(call.headers.customerid).toBeUndefined();
    expect(call.headers.customeraccountid).toBeUndefined();
    expect(call.body).toEqual({
      AccountIds: ["9007199254740993"],
      StartDate: "2026-08-01T00:00:00Z",
      EndDate: "2026-08-31T00:00:00Z",
      ReturnInvoiceNumber: true,
    });
  });

  test("rejects malformed, impossible, and inverted dates before sending", async () => {
    expect(() => toBillingDateTime("08/01/2026")).toThrow(/YYYY-MM-DD/);
    expect(() => toBillingDateTime("2026-02-31")).toThrow(/real calendar date/);
    await expect(
      getBillingDocumentsInfo(["1"], "2026-08-31", "2026-08-01"),
    ).rejects.toThrow(/is after/);
    expect(mock.callsTo("BillingDocumentsInfo/Query")).toHaveLength(0);
  });
});

describe("extension request and reconciliation contracts", () => {
  test("association reads include AccountId and preserve field-specific delimiter", async () => {
    mock.queue("AdExtensionsAssociations/Query", {
      json: { AdExtensionAssociationCollection: [] },
    });

    await getAdExtensionAssociations(IDS, ["7000000000000001"], "Campaign", [
      "CalloutAdExtension",
      "SitelinkAdExtension",
    ]);

    const call = onlyCall("AdExtensionsAssociations/Query");
    expect(call.method).toBe("POST");
    expect(call.headers.customerid).toBe("9900");
    expect(call.headers.customeraccountid).toBe("512300");
    expect(call.body).toEqual({
      AccountId: "512300",
      EntityIds: ["7000000000000001"],
      AssociationType: "Campaign",
      AdExtensionType: "CalloutAdExtension,SitelinkAdExtension",
    });
  });

  test("an unfiltered association read still sends every extension type", async () => {
    mock.queue("AdExtensionsAssociations/Query", {
      json: { AdExtensionAssociationCollection: [] },
    });

    // Omitting AdExtensionType fails with error 3814; the field is required
    // despite reading as a filter. No filter must therefore mean "all types",
    // comma-delimited — a space-delimited list is rejected as malformed JSON.
    await getAdExtensionAssociations(IDS, ["7000000000000001"], "Campaign");

    const sent = onlyCall("AdExtensionsAssociations/Query").body as {
      AdExtensionType: string;
    };
    expect(sent.AdExtensionType.split(",")).toEqual([...AD_EXTENSION_TYPES]);
  });

  test("campaign and ad-group negative-keyword reads send the correct parent", async () => {
    mock.queue(
      "NegativeKeywords/QueryByEntityIds",
      { json: { EntityNegativeKeywords: [] } },
      { json: { EntityNegativeKeywords: [] } },
    );

    await getNegativeKeywords(IDS, ["7001", "7002"], "Campaign");
    await getNegativeKeywords(IDS, ["8001"], "AdGroup", "7001");

    const calls = mock.callsTo("NegativeKeywords/QueryByEntityIds");
    expect(calls[0]?.body).toEqual({
      EntityIds: ["7001", "7002"],
      EntityType: "Campaign",
      ParentEntityId: "512300",
    });
    expect(calls[1]?.body).toEqual({
      EntityIds: ["8001"],
      EntityType: "AdGroup",
      ParentEntityId: "7001",
    });
  });

  test("ad-group negative-keyword reads require one entity and its campaign", async () => {
    await expect(getNegativeKeywords(IDS, ["8001"], "AdGroup")).rejects.toThrow(
      /parent_campaign_id is required/,
    );
    await expect(
      getNegativeKeywords(IDS, ["8001", "8002"], "AdGroup", "7001"),
    ).rejects.toThrow(/exactly one ad group/);
    expect(mock.callsTo("NegativeKeywords/QueryByEntityIds")).toHaveLength(0);
  });

  test("association counts use distinct indexes and separate unattributed errors", async () => {
    mock.queue("AdExtensionsAssociations/Set", {
      json: {
        PartialErrors: [
          { Index: 1, Code: 10, Message: "first field" },
          { Index: 1, Code: 11, Message: "second field" },
          { Code: 12, Message: "request-level" },
          { Index: 9, Code: 13, Message: "out-of-range" },
        ],
      },
    });
    const associations = [
      { AdExtensionId: "1", EntityId: "10" },
      { AdExtensionId: "2", EntityId: "20" },
      { AdExtensionId: "3", EntityId: "30" },
    ];

    const result = await setAdExtensionAssociations(IDS, associations, "Campaign");

    expect(result).toMatchObject({ submitted: 3, succeeded: 2, failed: 1 });
    expect(result.succeeded + result.failed).toBe(result.submitted);
    expect(result.errors).toHaveLength(2);
    expect(result.unattributed_errors).toHaveLength(2);
    expect(onlyCall("AdExtensionsAssociations/Set").body).toEqual({
      AccountId: "512300",
      AdExtensionIdToEntityIdAssociations: associations,
      AssociationType: "Campaign",
    });
  });
});

describe("targeting and audience mutation contracts", () => {
  test("maps specific targeting read types to exact delete families", async () => {
    const cases = [
      ["Age", "Targets"],
      ["RemarketingList", "Audience"],
      ["Webpage", "Webpage"],
      ["ProductScope", "ProductScope"],
    ] as const;
    mock.queue("/CampaignCriterions", ...cases.map(() => ({ json: {} })));

    for (const [specific, family] of cases) {
      await deleteCriterions(IDS, "campaign", ["9007199254740993"], specific);
      const call = mock.callsTo("/CampaignCriterions").at(-1)!;
      expect(call.method).toBe("DELETE");
      expect(call.body).toEqual({
        CampaignCriterionIds: ["9007199254740993"],
        CriterionType: family,
      });
    }
  });

  test("rejects an unreviewed targeting delete type locally", async () => {
    await expect(deleteCriterions(IDS, "adgroup", ["1"], "Telepathy")).rejects.toThrow(
      /Unsupported criterion type/,
    );
    expect(mock.callsTo("/AdGroupCriterions")).toHaveLength(0);
  });

  test("audience updates require an updateable Type and emit it unchanged", async () => {
    mock.queue("/Audiences", { json: {} });
    const update = {
      Id: "9007199254740993",
      Type: "RemarketingList",
      Name: "Retargeting",
    };

    await updateAudiences(IDS, [update]);

    const call = onlyCall("/Audiences");
    expect(call.method).toBe("PUT");
    expect(call.body).toEqual({ Audiences: [update] });
  });

  test("rejects missing, read-only, and invalid CustomAudience update fields", async () => {
    await expect(updateAudiences(IDS, [{ Id: "1", Name: "missing" }])).rejects.toThrow(
      /needs Type/,
    );
    await expect(
      updateAudiences(IDS, [{ Id: "1", Type: "CustomerList" }]),
    ).rejects.toThrow(/updateable family/);
    await expect(
      updateAudiences(IDS, [{ Id: "1", Type: "CustomAudience", MembershipDuration: 30 }]),
    ).rejects.toThrow(/only support Name and Description/);
    expect(mock.callsTo("/Audiences")).toHaveLength(0);
  });
});

describe("Ad Insight request contract", () => {
  test("GetKeywordIdeas keeps the official IdeaAttributes JSON array", async () => {
    mock.queue("KeywordIdeas/Query", { json: { KeywordIdeas: [] } });

    await getKeywordIdeas(IDS, {
      queries: ["running shoes"],
      locationIds: [190],
      language: "English",
      attributes: ["Keyword", "SuggestedBid"],
    });

    const call = onlyCall("KeywordIdeas/Query");
    expect(call.url).toBe(
      "https://adinsight.api.bingads.microsoft.com/AdInsight/v13/KeywordIdeas/Query",
    );
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({
      ExpandIdeas: true,
      IdeaAttributes: ["Keyword", "SuggestedBid", "Competition"],
      SearchParameters: [
        { Type: "LanguageSearchParameter", Languages: [{ Language: "English" }] },
        { Type: "LocationSearchParameter", Locations: [{ LocationId: 190 }] },
        {
          Type: "NetworkSearchParameter",
          Network: { Network: "OwnedAndOperatedAndSyndicatedSearch" },
        },
        { Type: "QuerySearchParameter", Queries: ["running shoes"] },
      ],
    });
    expect(Array.isArray((call.body as Record<string, unknown>).IdeaAttributes)).toBe(
      true,
    );
  });
});
