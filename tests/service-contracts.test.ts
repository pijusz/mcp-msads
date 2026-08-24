import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAuthForTesting } from "@/auth/oauth";
import { resetEnvForTesting } from "@/config/env";
import {
  findAccountsOrCustomers,
  getAccountsInfo,
  getUser,
  searchAccounts,
} from "@/services/accounts";
import {
  getAuctionInsight,
  getBidLandscape,
  getHistoricalSearchCount,
  getKeywordTrafficEstimates,
  suggestKeywordsForUrl,
} from "@/services/ad-insight";
import {
  addAudiences,
  applyCustomerList,
  deleteAudiences,
  getAudiencesByIds,
  updateAudiences,
} from "@/services/audiences";
import {
  getAccountMonthlySpend,
  INSERTION_ORDER_PAGE_MAX,
  searchInsertionOrders,
} from "@/services/billing";
import {
  getBulkDownloadStatus,
  getBulkUploadStatus,
  getBulkUploadUrl,
  submitBulkDownload,
} from "@/services/bulk";
import {
  AD_TYPES,
  addAdGroups,
  addAds,
  addCampaigns,
  addKeywords,
  deleteAdGroups,
  deleteAds,
  deleteCampaigns,
  deleteKeywords,
  getAdGroupsByCampaign,
  getAdGroupsByIds,
  getAdsByAdGroup,
  getBudgetsByIds,
  getCampaignsByAccount,
  getCampaignsByIds,
  getKeywordsByAdGroup,
  updateAdGroups,
  updateAds,
  updateCampaigns,
  updateKeywords,
} from "@/services/campaigns";
import {
  addConversionGoals,
  addUetTags,
  applyOfflineConversionAdjustments,
  applyOfflineConversions,
  getConversionGoals,
  getUetTags,
  updateConversionGoals,
} from "@/services/conversions";
import {
  addAdExtensions,
  addLabels,
  addNegativeKeywords,
  deleteAdExtensionAssociations,
  deleteAdExtensions,
  deleteNegativeKeywords,
  getAdExtensionIds,
  getAdExtensionsByIds,
  getLabels,
  setLabelAssociations,
  updateAdExtensions,
} from "@/services/extensions";
import {
  addImportJob,
  deleteImportJobs,
  getImportEntityIdsMapping,
  getImportJobs,
  getImportResults,
} from "@/services/import-jobs";
import { pollReport, submitReport } from "@/services/reporting";
import {
  addCriterions,
  getCriterions,
  getGeoLocationsFileUrl,
  getProfileDataFileUrl,
  searchCompanies,
  updateCriterions,
} from "@/services/targeting";
import { installMockFetch, type MockFetch, setTestEnv, tokenResponse } from "./_mock";

let mock: MockFetch;
const IDS = { accountId: "9007199254740993", customerId: "9007199254740995" };

beforeEach(() => {
  setTestEnv();
  resetEnvForTesting();
  resetAuthForTesting();
  mock = installMockFetch();
  mock.always("login.microsoftonline.com", tokenResponse());
});

afterEach(() => mock.restore());

function callEnding(path: string) {
  const calls = mock.calls.filter((call) => new URL(call.url).pathname.endsWith(path));
  expect(calls, path).toHaveLength(1);
  return calls[0]!;
}

function expectAccountHeaders(call: ReturnType<typeof callEnding>): void {
  expect(call.headers.authorization).toBe("Bearer test-access-token");
  expect(call.headers.developertoken).toBe("test-dev-token");
  expect(call.headers.customeraccountid).toBe(IDS.accountId);
  expect(call.headers.customerid).toBe(IDS.customerId);
}

describe("dedicated service request contracts", () => {
  test("Customer Management and remaining Billing reads use exact hosts and bodies", async () => {
    mock.queue("User/Query", { json: { User: { Id: "1" } } });
    mock.queue("AccountsOrCustomersInfo/Find", {
      json: { AccountInfoWithCustomerData: [] },
    });
    mock.queue("AccountsInfo/Query", { json: { AccountsInfo: [] } });
    mock.queue("Accounts/Search", { json: { Accounts: [] } });
    mock.queue("AccountMonthlySpend/Query", {
      json: { AccountMonthlySpend: { Amount: 1 } },
    });
    mock.queue("InsertionOrders/Search", { json: { InsertionOrders: [] } });

    await getUser("9007199254740997");
    await findAccountsOrCustomers("Brand", 25);
    await getAccountsInfo("9007199254740995", true);
    await searchAccounts(
      [{ Field: "Id", Operator: "Equals", Value: IDS.accountId }],
      2,
      50,
    );
    await getAccountMonthlySpend(IDS.accountId, 2026, 8);
    await searchInsertionOrders(
      [{ Field: "AccountId", Operator: "Equals", Value: IDS.accountId }],
      3,
      75,
    );

    const expected = [
      ["/CustomerManagement/v13/User/Query", { UserId: "9007199254740997" }],
      [
        "/CustomerManagement/v13/AccountsOrCustomersInfo/Find",
        { Filter: "Brand", TopN: 25 },
      ],
      [
        "/CustomerManagement/v13/AccountsInfo/Query",
        { CustomerId: "9007199254740995", OnlyParentAccounts: true },
      ],
      [
        "/CustomerManagement/v13/Accounts/Search",
        {
          Predicates: [{ Field: "Id", Operator: "Equals", Value: IDS.accountId }],
          PageInfo: { Index: 2, Size: 50 },
        },
      ],
      [
        "/CustomerBilling/v13/AccountMonthlySpend/Query",
        { AccountId: IDS.accountId, MonthYear: "2026-08-01T00:00:00" },
      ],
      [
        "/CustomerBilling/v13/InsertionOrders/Search",
        {
          Predicates: [{ Field: "AccountId", Operator: "Equals", Value: IDS.accountId }],
          PageInfo: { Index: 3, Size: 75 },
        },
      ],
    ] as const;
    for (const [path, body] of expected) {
      const call = callEnding(path);
      expect(call.url).toBe(`https://clientcenter.api.bingads.microsoft.com${path}`);
      expect(call.method).toBe("POST");
      expect(call.body).toEqual(body);
      expect(call.headers.customeraccountid).toBeUndefined();
      expect(call.headers.customerid).toBeUndefined();
    }
  });

  test("core Campaign Management CRUD uses exact paths, methods, 64-bit strings, and partial reconciliation", async () => {
    mock.queue("/Campaigns", {
      json: {
        CampaignIds: ["8000000000000001", null],
        PartialErrors: [{ Index: 1, Code: 1100, Message: "bad campaign" }],
      },
    });
    mock.always("Campaigns", {
      json: { Campaigns: [], CampaignIds: ["8000000000000001"] },
    });
    mock.always("AdGroups", { json: { AdGroups: [], AdGroupIds: ["8100000000000001"] } });
    mock.always("Ads", { json: { Ads: [], AdIds: ["8200000000000001"] } });
    mock.always("Keywords", { json: { Keywords: [], KeywordIds: ["8300000000000001"] } });
    mock.always("Budgets/QueryByIds", { json: { Budgets: [] } });

    const campaignAdd = await addCampaigns(IDS, [{ Name: "Good" }, { Name: "Bad" }]);
    await updateCampaigns(IDS, [{ Id: "8000000000000001", Name: "Updated" }]);
    await deleteCampaigns(IDS, ["8000000000000001"]);
    await getCampaignsByAccount(IDS, "Search");
    await getCampaignsByIds(IDS, ["8000000000000001"]);

    await addAdGroups(IDS, "8000000000000001", [{ Name: "Group" }]);
    await updateAdGroups(IDS, "8000000000000001", [{ Id: "8100000000000001" }]);
    await deleteAdGroups(IDS, "8000000000000001", ["8100000000000001"]);
    await getAdGroupsByCampaign(IDS, "8000000000000001");
    await getAdGroupsByIds(IDS, "8000000000000001", ["8100000000000001"]);

    await addAds(IDS, "8100000000000001", [{ Type: "ResponsiveSearchAd" }]);
    await updateAds(IDS, "8100000000000001", [{ Id: "8200000000000001" }]);
    await deleteAds(IDS, "8100000000000001", ["8200000000000001"]);
    await getAdsByAdGroup(IDS, "8100000000000001", ["ResponsiveSearch"]);

    await addKeywords(IDS, "8100000000000001", [{ Text: "shoes", MatchType: "Exact" }]);
    await updateKeywords(IDS, "8100000000000001", [
      { Id: "8300000000000001", Text: "boots" },
    ]);
    await deleteKeywords(IDS, "8100000000000001", ["8300000000000001"]);
    await getKeywordsByAdGroup(IDS, "8100000000000001");
    await getBudgetsByIds(IDS, ["8400000000000001"]);

    expect(campaignAdd).toMatchObject({ submitted: 2, succeeded: 1, failed: 1 });
    expect(campaignAdd.outcomes[1]?.error?.message).toBe("bad campaign");

    const writes = [
      [
        "/CampaignManagement/v13/Campaigns",
        "POST",
        { AccountId: IDS.accountId, Campaigns: [{ Name: "Good" }, { Name: "Bad" }] },
      ],
      [
        "/CampaignManagement/v13/Campaigns",
        "PUT",
        {
          AccountId: IDS.accountId,
          Campaigns: [{ Id: "8000000000000001", Name: "Updated" }],
        },
      ],
      [
        "/CampaignManagement/v13/Campaigns",
        "DELETE",
        { AccountId: IDS.accountId, CampaignIds: ["8000000000000001"] },
      ],
      [
        "/CampaignManagement/v13/AdGroups",
        "POST",
        { CampaignId: "8000000000000001", AdGroups: [{ Name: "Group" }] },
      ],
      [
        "/CampaignManagement/v13/AdGroups",
        "PUT",
        { CampaignId: "8000000000000001", AdGroups: [{ Id: "8100000000000001" }] },
      ],
      [
        "/CampaignManagement/v13/AdGroups",
        "DELETE",
        { CampaignId: "8000000000000001", AdGroupIds: ["8100000000000001"] },
      ],
      [
        "/CampaignManagement/v13/Ads",
        "POST",
        { AdGroupId: "8100000000000001", Ads: [{ Type: "ResponsiveSearchAd" }] },
      ],
      [
        "/CampaignManagement/v13/Ads",
        "PUT",
        { AdGroupId: "8100000000000001", Ads: [{ Id: "8200000000000001" }] },
      ],
      [
        "/CampaignManagement/v13/Ads",
        "DELETE",
        { AdGroupId: "8100000000000001", AdIds: ["8200000000000001"] },
      ],
      [
        "/CampaignManagement/v13/Keywords",
        "POST",
        {
          AdGroupId: "8100000000000001",
          Keywords: [{ Text: "shoes", MatchType: "Exact" }],
        },
      ],
      [
        "/CampaignManagement/v13/Keywords",
        "PUT",
        {
          AdGroupId: "8100000000000001",
          Keywords: [{ Id: "8300000000000001", Text: "boots" }],
        },
      ],
      [
        "/CampaignManagement/v13/Keywords",
        "DELETE",
        { AdGroupId: "8100000000000001", KeywordIds: ["8300000000000001"] },
      ],
    ] as const;
    for (const [path, method, body] of writes) {
      const call = mock.calls.find(
        (candidate) =>
          new URL(candidate.url).pathname === path && candidate.method === method,
      );
      expect(call, `${method} ${path}`).toBeDefined();
      expect(call?.body).toEqual(body);
      expectAccountHeaders(call!);
    }

    const reads = [
      [
        "/CampaignManagement/v13/Campaigns/QueryByAccountId",
        { AccountId: IDS.accountId, CampaignType: "Search" },
      ],
      [
        "/CampaignManagement/v13/Campaigns/QueryByIds",
        { AccountId: IDS.accountId, CampaignIds: ["8000000000000001"] },
      ],
      [
        "/CampaignManagement/v13/AdGroups/QueryByCampaignId",
        { CampaignId: "8000000000000001" },
      ],
      [
        "/CampaignManagement/v13/AdGroups/QueryByIds",
        { CampaignId: "8000000000000001", AdGroupIds: ["8100000000000001"] },
      ],
      [
        "/CampaignManagement/v13/Ads/QueryByAdGroupId",
        { AdGroupId: "8100000000000001", AdTypes: ["ResponsiveSearch"] },
      ],
      [
        "/CampaignManagement/v13/Keywords/QueryByAdGroupId",
        { AdGroupId: "8100000000000001" },
      ],
      ["/CampaignManagement/v13/Budgets/QueryByIds", { BudgetIds: ["8400000000000001"] }],
    ] as const;
    for (const [path, bodySubset] of reads) {
      const call = callEnding(path);
      expect(call.method).toBe("POST");
      expect(call.body).toMatchObject(bodySubset);
      expectAccountHeaders(call);
    }
  });

  test("audience, extension, label, negative, and targeting families keep exact wire shapes", async () => {
    mock.queue("Audiences/QueryByIds", { json: { Audiences: [] } });
    mock.queue("CustomerListUserData/Apply", { json: {} });
    mock.queue(
      "/Audiences",
      {
        json: {
          AudienceIds: ["5000000000000001", null],
          PartialErrors: [{ Index: 1, Code: 1, Message: "bad audience" }],
        },
      },
      { json: {} },
      { json: {} },
    );
    mock.queue("AdExtensionIds/QueryByAccountId", {
      json: { AdExtensionIdToEntityIdAssociations: [] },
    });
    mock.queue("AdExtensions/QueryByIds", { json: { AdExtensions: [] } });
    mock.queue(
      "/AdExtensions",
      {
        json: {
          AdExtensionIdentities: [{ Id: "5100000000000001" }, null],
          PartialErrors: [{ Index: 1, Code: 2, Message: "bad extension" }],
        },
      },
      { json: {} },
      { json: {} },
    );
    mock.queue("/AdExtensionsAssociations", {
      json: { PartialErrors: [{ Index: 1, Code: 3, Message: "not associated" }] },
    });
    mock.queue(
      "/EntityNegativeKeywords",
      { json: { NegativeKeywordIds: [{ Ids: ["5200000000000001"] }] } },
      { json: {} },
    );
    mock.queue("Labels/QueryByIds", { json: { Labels: [] } });
    mock.queue("/Labels", { json: { LabelIds: ["5300000000000001"] } });
    mock.queue("LabelAssociations/Set", {
      json: { PartialErrors: [{ Index: 0, Code: 4, Message: "label failed" }] },
    });
    mock.queue("CampaignCriterions/QueryByIds", { json: { CampaignCriterions: [] } });
    mock.queue(
      "/CampaignCriterions",
      { json: { CampaignCriterionIds: ["5400000000000001"] } },
      { json: {} },
    );
    mock.queue("ProfileDataFileUrl/Query", {
      json: { FileUrl: "https://example.com/profile.csv" },
    });
    mock.queue("Companies/Search", { json: { Companies: [] } });
    mock.queue("GeoLocationsFileUrl/Query", {
      json: { FileUrl: "https://example.com/geo.csv" },
    });

    await getAudiencesByIds(IDS, ["5000000000000001"], "RemarketingList");
    const addedAudiences = await addAudiences(IDS, [
      { Type: "RemarketingList", Name: "Good" },
      { Type: "CustomerList", Name: "Bad" },
    ]);
    await updateAudiences(IDS, [
      { Id: "5000000000000001", Type: "RemarketingList", Name: "Updated" },
    ]);
    await deleteAudiences(IDS, ["5000000000000001"]);
    await applyCustomerList(IDS, {
      audienceId: "5000000000000001",
      action: "Add",
      emails: ["person@example.com"],
    });

    await getAdExtensionIds(IDS, "SitelinkAdExtension", "Campaign");
    await getAdExtensionsByIds(IDS, ["5100000000000001"], "SitelinkAdExtension");
    const addedExtensions = await addAdExtensions(IDS, [
      { Type: "SitelinkAdExtension" },
      { Type: "CalloutAdExtension" },
    ]);
    await updateAdExtensions(IDS, [
      { Id: "5100000000000001", Type: "SitelinkAdExtension" },
    ]);
    await deleteAdExtensions(IDS, ["5100000000000001"]);
    const detached = await deleteAdExtensionAssociations(
      IDS,
      [
        { AdExtensionId: "5100000000000001", EntityId: "8000000000000001" },
        { AdExtensionId: "5100000000000002", EntityId: "8000000000000001" },
      ],
      "Campaign",
    );
    await addNegativeKeywords(IDS, "8000000000000001", "Campaign", [
      { Text: "free", MatchType: "Phrase" },
    ]);
    await deleteNegativeKeywords(IDS, "8000000000000001", "Campaign", [
      "5200000000000001",
    ]);
    await getLabels(IDS, ["5300000000000001"], 2, 40);
    await addLabels(IDS, [{ Name: "Priority" }]);
    const labels = await setLabelAssociations(
      IDS,
      [{ LabelId: "5300000000000001", EntityId: "8000000000000001" }],
      "Campaign",
    );

    const criterion = {
      Id: "5400000000000001",
      Criterion: { Type: "AgeCriterion", AgeRange: "EighteenToTwentyFour" },
    };
    await getCriterions(IDS, "campaign", ["5400000000000001"], "Age");
    await addCriterions(IDS, "campaign", [criterion]);
    await updateCriterions(IDS, "campaign", [criterion]);
    await getProfileDataFileUrl(IDS, "Industry", "en");
    await searchCompanies(IDS, "Contoso", "en");
    await getGeoLocationsFileUrl(IDS, "en", "2.0");

    expect(addedAudiences).toMatchObject({ submitted: 2, succeeded: 1, failed: 1 });
    expect(addedExtensions).toMatchObject({ submitted: 2, succeeded: 1, failed: 1 });
    expect(detached).toMatchObject({ submitted: 2, succeeded: 1, failed: 1 });
    expect(labels).toMatchObject({ submitted: 1, succeeded: 0, failed: 1 });

    expect(callEnding("/CampaignManagement/v13/Audiences/QueryByIds").body).toEqual({
      AudienceIds: ["5000000000000001"],
      Type: "RemarketingList",
    });
    const audienceWrites = mock.calls.filter((call) =>
      new URL(call.url).pathname.endsWith("/CampaignManagement/v13/Audiences"),
    );
    expect(audienceWrites.map((call) => call.method)).toEqual(["POST", "PUT", "DELETE"]);
    const customerList = callEnding("/CampaignManagement/v13/CustomerListUserData/Apply");
    expect(JSON.stringify(customerList.body)).not.toContain("person@example.com");
    expect(customerList.body).toMatchObject({
      CustomerListUserData: {
        AcceptCustomerMatchTerm: true,
        ActionType: "Add",
        AudienceId: "5000000000000001",
        CustomerListItemSubType: "Email",
      },
    });

    expect(
      callEnding("/CampaignManagement/v13/AdExtensionIds/QueryByAccountId").body,
    ).toEqual({
      AccountId: IDS.accountId,
      AdExtensionType: "SitelinkAdExtension",
      AssociationType: "Campaign",
    });
    expect(callEnding("/CampaignManagement/v13/AdExtensions/QueryByIds").body).toEqual({
      AccountId: IDS.accountId,
      AdExtensionIds: ["5100000000000001"],
      AdExtensionType: "SitelinkAdExtension",
    });
    const extensionWrites = mock.calls.filter((call) =>
      new URL(call.url).pathname.endsWith("/CampaignManagement/v13/AdExtensions"),
    );
    expect(extensionWrites.map((call) => call.method)).toEqual(["POST", "PUT", "DELETE"]);
    expect(callEnding("/CampaignManagement/v13/AdExtensionsAssociations").method).toBe(
      "DELETE",
    );
    const negativeWrites = mock.calls.filter((call) =>
      new URL(call.url).pathname.endsWith(
        "/CampaignManagement/v13/EntityNegativeKeywords",
      ),
    );
    expect(negativeWrites.map((call) => call.method)).toEqual(["POST", "DELETE"]);
    expect(negativeWrites[0]?.body).toEqual({
      EntityNegativeKeywords: [
        {
          EntityId: "8000000000000001",
          EntityType: "Campaign",
          NegativeKeywords: [{ Text: "free", MatchType: "Phrase" }],
        },
      ],
    });
    expect(callEnding("/CampaignManagement/v13/Labels/QueryByIds").body).toEqual({
      LabelIds: ["5300000000000001"],
      PageInfo: { Index: 2, Size: 40 },
    });
    expect(callEnding("/CampaignManagement/v13/LabelAssociations/Set").body).toEqual({
      EntityType: "Campaign",
      LabelAssociations: [{ LabelId: "5300000000000001", EntityId: "8000000000000001" }],
    });

    expect(
      callEnding("/CampaignManagement/v13/CampaignCriterions/QueryByIds").body,
    ).toEqual({
      CampaignCriterionIds: ["5400000000000001"],
      CriterionType: "Age",
    });
    const criterionWrites = mock.calls.filter((call) =>
      new URL(call.url).pathname.endsWith("/CampaignManagement/v13/CampaignCriterions"),
    );
    expect(criterionWrites.map((call) => call.method)).toEqual(["POST", "PUT"]);
    expect(criterionWrites[0]?.body).toEqual({
      CampaignCriterions: [criterion],
      CriterionType: "Targets",
    });
    expect(callEnding("/CampaignManagement/v13/ProfileDataFileUrl/Query").body).toEqual({
      ProfileType: "Industry",
      LanguageLocale: "en",
    });
    expect(callEnding("/CampaignManagement/v13/Companies/Search").body).toEqual({
      CompanyNameFilter: "Contoso",
      LanguageLocale: "en",
    });
    expect(callEnding("/CampaignManagement/v13/GeoLocationsFileUrl/Query").body).toEqual({
      LanguageLocale: "en",
      Version: "2.0",
    });
  });

  test("conversion operations keep exact discriminators, delimiters, hashing, and nested partial errors", async () => {
    mock.queue("UetTags/QueryByIds", { json: { UetTags: [] } });
    mock.queue("/UetTags", {
      json: {
        UetTags: [{ Id: "7000000000000001" }, null],
        PartialErrors: [{ Index: 1, Code: 1 }],
      },
    });
    mock.queue("ConversionGoals/QueryByIds", { json: { ConversionGoals: [] } });
    mock.queue(
      "/ConversionGoals",
      { json: { ConversionGoalIds: ["7100000000000001"] } },
      { json: {} },
    );
    mock.queue("OfflineConversions/Apply", {
      json: {
        NestedPartialErrors: [
          { Index: 0, BatchErrors: [{ Index: 2, Code: 3, Message: "field" }] },
        ],
      },
    });
    mock.queue("OfflineConversionAdjustments/Apply", { json: {} });

    await getUetTags(IDS, ["7000000000000001"]);
    const tags = await addUetTags(IDS, [{ Name: "Good" }, { Name: "Bad" }]);
    await getConversionGoals(IDS, ["7100000000000001"], ["Url", "OfflineConversion"]);
    await addConversionGoals(IDS, [{ Name: "Lead", Type: "OfflineConversionGoal" }]);
    await updateConversionGoals(IDS, [
      { Id: "7100000000000001", Name: "Lead 2", Type: "OfflineConversionGoal" },
    ]);
    const time = new Date(Date.now() - 3_600_000).toISOString();
    const applied = await applyOfflineConversions(IDS, [
      { conversionName: "Lead", conversionTime: time, email: "person@example.com" },
    ]);
    await applyOfflineConversionAdjustments(IDS, [
      {
        conversionName: "Lead",
        conversionTime: time,
        adjustmentTime: new Date().toISOString(),
        adjustmentType: "Retract",
        microsoftClickId: "click-1",
      },
    ]);

    expect(tags).toMatchObject({ submitted: 2, succeeded: 1, failed: 1 });
    expect(applied.errors[0]).toMatchObject({ index: 2, parent_index: 0 });
    const goalRead = callEnding("/CampaignManagement/v13/ConversionGoals/QueryByIds");
    expect(goalRead.body).toEqual({
      ConversionGoalIds: ["7100000000000001"],
      ConversionGoalTypes: "Url,OfflineConversion",
      ReturnAdditionalFields:
        "ViewThroughConversionWindowInMinutes,IsExternallyAttributed",
    });
    const upload = callEnding("/CampaignManagement/v13/OfflineConversions/Apply");
    expect(JSON.stringify(upload.body)).not.toContain("person@example.com");
    expect((upload.body as any).OfflineConversions[0].HashedEmailAddress).toMatch(
      /^[a-f0-9]{64}$/,
    );
    for (const call of mock.calls.filter((candidate) =>
      candidate.url.includes("CampaignManagement/v13"),
    )) {
      expectAccountHeaders(call);
    }
  });

  test("Google import operations use exact paths, types, pagination, and partial outcomes", async () => {
    mock.queue("ImportJobs/QueryByIds", { json: { ImportJobs: [] } });
    mock.queue(
      "/ImportJobs",
      { json: { ImportJobIds: ["6000000000000001"] } },
      { json: { PartialErrors: [{ Index: 0, Code: 1, Message: "not deleted" }] } },
    );
    mock.queue("ImportResults/Query", { json: { ImportResults: [] } });
    mock.queue("ImportEntityIdsMapping/Query", { json: { EntityIdsMapping: [] } });

    await addImportJob(IDS, {
      name: "Import",
      credentialId: "credential",
      googleAccountId: "123-456",
    });
    await getImportJobs(IDS, ["6000000000000001"]);
    const deleted = await deleteImportJobs(IDS, ["6000000000000001"]);
    await getImportResults(IDS, ["6000000000000001"], 4, 80);
    await getImportEntityIdsMapping(IDS, "Campaign", ["9000000000000001"], "parent-1");

    expect(deleted).toMatchObject({ submitted: 1, succeeded: 0, failed: 1 });
    const add = mock.calls.find(
      (call) => call.url.endsWith("/ImportJobs") && call.method === "POST",
    )!;
    expect(add.body).toEqual({
      ImportJobs: [
        {
          Type: "GoogleImportJob",
          Name: "Import",
          CredentialId: "credential",
          GoogleAccountId: "123-456",
        },
      ],
    });
    expect(callEnding("/CampaignManagement/v13/ImportJobs/QueryByIds").body).toEqual({
      ImportJobIds: ["6000000000000001"],
      ImportType: "GoogleImportJob",
      ReturnAdditionalFields: "NotificationEmail",
    });
    expect(callEnding("/CampaignManagement/v13/ImportResults/Query").body).toEqual({
      ImportJobIds: ["6000000000000001"],
      ImportType: "GoogleImportJob",
      PageInfo: { Index: 4, Size: 80 },
    });
    expect(
      callEnding("/CampaignManagement/v13/ImportEntityIdsMapping/Query").body,
    ).toEqual({
      ImportEntityType: "Campaign",
      ImportType: "GoogleImportJob",
      SourceEntityIds: ["9000000000000001"],
      SourceParentId: "parent-1",
    });
  });

  test("remaining Ad Insight requests use verified paths and exact nested bodies", async () => {
    mock.queue("KeywordTrafficEstimates/Query", { json: { CampaignEstimates: [] } });
    mock.queue("KeywordSuggestions/QueryByUrl", { json: { Keywords: [] } });
    mock.queue("HistoricalSearchCount/Query", {
      json: { KeywordHistoricalSearchCounts: [] },
    });
    mock.queue("BidLandscape/QueryByKeywordIds", { json: { BidLandscape: [] } });
    mock.queue("AuctionInsightData/Query", { json: { AuctionInsightEntries: [] } });

    await getKeywordTrafficEstimates(IDS, {
      keywords: [{ text: "shoes", matchType: "Exact", maxCpc: 1.5 }],
      locationIds: [190],
      language: "English",
      network: "OwnedAndOperatedAndSyndicatedSearch",
      dailyBudget: 20,
      maxCpc: 2,
    });
    await suggestKeywordsForUrl(IDS, "https://example.com", 75, "English");
    const start = { Day: 1, Month: 1, Year: 2026 };
    const end = { Day: 1, Month: 8, Year: 2026 };
    await getHistoricalSearchCount(IDS, ["shoes"], {
      publisherCountries: ["US"],
      startDate: start,
      endDate: end,
    });
    await getBidLandscape(IDS, ["9000000000000001"], false);
    await getAuctionInsight(IDS, "Campaign", ["8000000000000001"], start, end);

    const paths = [
      "/AdInsight/v13/KeywordTrafficEstimates/Query",
      "/AdInsight/v13/KeywordSuggestions/QueryByUrl",
      "/AdInsight/v13/HistoricalSearchCount/Query",
      "/AdInsight/v13/BidLandscape/QueryByKeywordIds",
      "/AdInsight/v13/AuctionInsightData/Query",
    ];
    for (const path of paths) {
      const call = callEnding(path);
      expect(call.url).toBe(`https://adinsight.api.bingads.microsoft.com${path}`);
      expect(call.method).toBe("POST");
      expectAccountHeaders(call);
    }
    expect(callEnding(paths[0]!).body).toEqual({
      CampaignEstimators: [
        {
          CampaignId: null,
          DailyBudget: 20,
          Criteria: [
            { Type: "LocationCriterion", LocationId: 190 },
            { Type: "LanguageCriterion", Language: "English" },
            { Type: "NetworkCriterion", Network: "OwnedAndOperatedAndSyndicatedSearch" },
          ],
          AdGroupEstimators: [
            {
              AdGroupId: null,
              MaxCpc: 2,
              KeywordEstimators: [
                { Keyword: { Text: "shoes", MatchType: "Exact" }, MaxCpc: 1.5 },
              ],
            },
          ],
        },
      ],
    });
    expect(callEnding(paths[1]!).body).toEqual({
      Url: "https://example.com",
      MaxKeywords: 75,
      Language: "English",
    });
    expect(callEnding(paths[2]!).body).toEqual({
      Keywords: ["shoes"],
      TimePeriodRollup: "Monthly",
      Language: "English",
      PublisherCountries: ["US"],
      StartDate: start,
      EndDate: end,
    });
    expect(callEnding(paths[3]!).body).toEqual({
      KeywordIds: ["9000000000000001"],
      IncludeCurrentBid: false,
    });
    // The date range lives inside SearchParameters. Top-level StartDate and
    // EndDate are ignored and the call fails with error 813.
    expect(callEnding(paths[4]!).body).toEqual({
      EntityType: "Campaign",
      EntityIds: ["8000000000000001"],
      SearchParameters: [
        { Type: "DateRangeSearchParameter", StartDate: start, EndDate: end },
      ],
    });
  });

  test("Bulk submission, status, and upload-url operations use exact contracts", async () => {
    mock.queue("Campaigns/DownloadByCampaignIds", {
      json: { DownloadRequestId: "download-1" },
    });
    mock.queue("BulkDownloadStatus/Query", {
      json: { RequestStatus: "InProgress", PercentComplete: 20 },
    });
    mock.queue("BulkUploadUrl/Query", {
      json: {
        UploadUrl: "https://bulk.api.bingads.microsoft.com/upload",
        RequestId: "upload-1",
      },
    });
    mock.queue("BulkUploadStatus/Query", {
      json: { RequestStatus: "Completed", ResultFileUrl: null },
    });

    await submitBulkDownload(IDS, {
      entities: ["Campaigns", "Keywords"],
      campaignIds: ["8000000000000001"],
      fileType: "Tsv",
    });
    await getBulkDownloadStatus(IDS, "download-1");
    await getBulkUploadUrl(IDS, "ErrorsOnly");
    await getBulkUploadStatus(IDS, "upload-1");

    const expected = [
      [
        "/Bulk/v13/Campaigns/DownloadByCampaignIds",
        {
          CompressionType: "Zip",
          DataScope: "EntityData",
          DownloadEntities: ["Campaigns", "Keywords"],
          DownloadFileType: "Tsv",
          FormatVersion: "6.0",
          Campaigns: [{ AccountId: IDS.accountId, CampaignId: "8000000000000001" }],
        },
      ],
      ["/Bulk/v13/BulkDownloadStatus/Query", { RequestId: "download-1" }],
      [
        "/Bulk/v13/BulkUploadUrl/Query",
        { AccountId: IDS.accountId, ResponseMode: "ErrorsOnly" },
      ],
      ["/Bulk/v13/BulkUploadStatus/Query", { RequestId: "upload-1" }],
    ] as const;
    for (const [path, body] of expected) {
      const call = callEnding(path);
      expect(call.url).toBe(`https://bulk.api.bingads.microsoft.com${path}`);
      expect(call.method).toBe("POST");
      expect(call.body).toEqual(body);
      expectAccountHeaders(call);
    }
  });

  test("Reporting submission and polling remain distinct and preserve headers", async () => {
    const body = { ReportRequest: { Type: "CampaignPerformanceReportRequest" } };
    mock.queue("GenerateReport/Submit", { json: { ReportRequestId: "report-1" } });
    mock.queue("GenerateReport/Poll", {
      json: { ReportRequestStatus: { Status: "Pending" } },
    });

    await submitReport(body, IDS);
    await pollReport("report-1", IDS);

    const submit = callEnding("/Reporting/v13/GenerateReport/Submit");
    const poll = callEnding("/Reporting/v13/GenerateReport/Poll");
    expect(submit.url).toBe(
      "https://reporting.api.bingads.microsoft.com/Reporting/v13/GenerateReport/Submit",
    );
    expect(submit.method).toBe("POST");
    expect(submit.body).toEqual(body);
    expect(poll.body).toEqual({ ReportRequestId: "report-1" });
    expectAccountHeaders(submit);
    expectAccountHeaders(poll);
  });

  test("wraps ad copy as asset links whatever shorthand the caller used", async () => {
    mock.queue("v13/Ads", { json: { AdIds: ["1"], PartialErrors: [] } });

    // Responsive search copy travels as asset links. Plain text is rejected
    // with error 6206, which blames the headline rather than its shape.
    await addAds(IDS, "8100000000000001", [
      {
        Type: "ResponsiveSearch",
        Headlines: [
          "Plain string",
          { Text: "Text object" },
          { Asset: { Text: "Already wrapped", Type: "TextAsset" } },
        ],
        Descriptions: ["A description"],
      },
    ]);

    const sent = callEnding("/CampaignManagement/v13/Ads").body as {
      Ads: { Headlines: unknown[]; Descriptions: unknown[] }[];
    };
    expect(sent.Ads[0]?.Headlines).toEqual([
      { Asset: { Text: "Plain string", Type: "TextAsset" } },
      { Asset: { Text: "Text object", Type: "TextAsset" } },
      { Asset: { Text: "Already wrapped", Type: "TextAsset" } },
    ]);
    expect(sent.Ads[0]?.Descriptions).toEqual([
      { Asset: { Text: "A description", Type: "TextAsset" } },
    ]);
  });

  test("an unfiltered ad read still sends every ad type", async () => {
    mock.queue("Ads/QueryByAdGroupId", { json: { Ads: [] } });

    // Omitting AdTypes fails with error 2805, whose message describes a write
    // and names no type. No filter must therefore mean "all types".
    await getAdsByAdGroup(IDS, "8100000000000001");

    expect(callEnding("/CampaignManagement/v13/Ads/QueryByAdGroupId").body).toEqual({
      AdGroupId: "8100000000000001",
      AdTypes: [...AD_TYPES],
    });
  });

  test("clamps insertion-order paging to the Customer Billing maximum", async () => {
    mock.queue("InsertionOrders/Search", { json: { InsertionOrders: [] } });

    // Customer Billing rejects PageInfo.Size above 100 with error 3032 — a
    // lower cap than Campaign Management's 1000. Passing a larger page through
    // makes the call fail outright rather than return a short page.
    await searchInsertionOrders(
      [{ Field: "AccountId", Operator: "Equals", Value: IDS.accountId }],
      0,
      1000,
    );

    expect(callEnding("/CustomerBilling/v13/InsertionOrders/Search").body).toMatchObject({
      PageInfo: { Index: 0, Size: INSERTION_ORDER_PAGE_MAX },
    });
  });
});
