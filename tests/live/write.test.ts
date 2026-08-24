import { afterEach, describe, expect, test } from "bun:test";
import * as cm from "@/services/campaigns";
import {
  createRegistry,
  getTestAccountId,
  liveWriteSkipReason,
  liveWritesEnabled,
  testIds,
  testName,
} from "./_helpers";

/**
 * Write checks against the real API. Every entity is created paused, tracked,
 * and deleted in afterEach — nothing here can serve an ad or spend money.
 */
const registry = createRegistry();
afterEach(() => registry.cleanup());

describe.skipIf(!liveWritesEnabled())(`[live] writes (${liveWriteSkipReason()})`, () => {
  test("creates, reads back, updates, and deletes a campaign", async () => {
    const ids = await testIds();
    const name = testName("campaign");

    const created = await cm.addCampaigns(ids, [
      {
        Name: name,
        CampaignType: "Search",
        DailyBudget: 5,
        BudgetType: "DailyBudgetStandard",
        Status: "Paused",
        Languages: ["English"],
      },
    ]);

    expect(created.succeeded, JSON.stringify(created.outcomes)).toBe(1);
    expect(created.ids[0]).toBeTruthy();
    const campaignId = created.ids[0]!;
    registry.trackCampaign(campaignId);

    const [fetched] = await cm.getCampaignsByIds(ids, [campaignId]);
    expect(fetched?.Name).toBe(name);
    expect(fetched?.Status).toBe("Paused");

    const renamed = `${name}-updated`;
    const updated = await cm.updateCampaigns(ids, [{ Id: campaignId, Name: renamed }]);
    expect(updated.failed).toBe(0);

    const [reread] = await cm.getCampaignsByIds(ids, [campaignId]);
    expect(reread?.Name).toBe(renamed);
  }, 120_000);

  test("reports per-item outcomes when only part of a batch is valid", async () => {
    const ids = await testIds();
    const good = testName("partial-ok");

    const result = await cm.addCampaigns(ids, [
      {
        Name: good,
        CampaignType: "Search",
        DailyBudget: 5,
        BudgetType: "DailyBudgetStandard",
        Status: "Paused",
        Languages: ["English"],
      },
      // Invalid on purpose: a negative budget must be rejected on its own
      // without taking the valid sibling down with it.
      {
        Name: testName("partial-bad"),
        CampaignType: "Search",
        DailyBudget: -1,
        BudgetType: "DailyBudgetStandard",
        Status: "Paused",
        Languages: ["English"],
      },
    ]);

    expect(result.submitted).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.outcomes[0]?.success).toBe(true);
    expect(result.outcomes[1]?.success).toBe(false);
    expect(result.outcomes[1]?.error?.code).toBeGreaterThan(0);

    for (const id of result.ids) registry.trackCampaign(id);
  }, 120_000);

  test("creates an ad group and keywords under a campaign", async () => {
    const ids = await testIds();

    const campaign = await cm.addCampaigns(ids, [
      {
        Name: testName("kw-campaign"),
        CampaignType: "Search",
        DailyBudget: 5,
        BudgetType: "DailyBudgetStandard",
        Status: "Paused",
        Languages: ["English"],
      },
    ]);
    expect(campaign.succeeded, JSON.stringify(campaign.outcomes)).toBe(1);
    expect(campaign.ids[0]).toBeTruthy();
    const campaignId = campaign.ids[0]!;
    registry.trackCampaign(campaignId);

    const group = await cm.addAdGroups(ids, campaignId, [
      { Name: testName("adgroup"), Status: "Paused", CpcBid: { Amount: 0.5 } },
    ]);
    expect(group.succeeded, JSON.stringify(group.outcomes)).toBe(1);
    expect(group.ids[0]).toBeTruthy();
    const adGroupId = group.ids[0]!;
    registry.trackAdGroup(campaignId, adGroupId);

    const keywords = await cm.addKeywords(ids, adGroupId, [
      { Text: "mcp msads test keyword", MatchType: "Exact", Status: "Paused" },
      { Text: "mcp msads other keyword", MatchType: "Phrase", Status: "Paused" },
    ]);
    expect(keywords.succeeded, JSON.stringify(keywords.outcomes)).toBe(2);

    const readBack = await cm.getKeywordsByAdGroup(ids, adGroupId);
    expect(readBack.length).toBeGreaterThanOrEqual(2);
  }, 180_000);

  test("account id alone is enough — the customer id resolves itself", async () => {
    // The pairing is the usual cause of error 106; this proves resolution works.
    const ids = await testIds();
    expect(ids.accountId).toBe(getTestAccountId());
    expect(ids.customerId).toBeTruthy();
  }, 60_000);
});
