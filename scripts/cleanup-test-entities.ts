#!/usr/bin/env bun
import { resolveAccount } from "@/services/accounts";
import * as cm from "@/services/campaigns";
import {
  assertCleanupComplete,
  inspectCleanupResult,
  TEST_NAME_PREFIX,
} from "../tests/live/_helpers";

/**
 * Fallback cleanup for live tests that crashed before their afterEach ran.
 *
 * Live tests name everything `mcp-msads-test-*` precisely so orphans can be
 * found later. This deletes every campaign matching that prefix in the test
 * account — and nothing else.
 *
 *   bun run test:cleanup:dry   # show what would be deleted
 *   bun run test:cleanup       # delete it
 */

const dryRun = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  const accountId = process.env.MSADS_TEST_ACCOUNT_ID;
  if (!accountId) {
    console.error(
      "MSADS_TEST_ACCOUNT_ID is not set. Refusing to guess which account to clean up.",
    );
    process.exit(1);
  }

  const ids = await resolveAccount({ accountId });
  const campaigns = await cm.getCampaignsByAccount(ids);

  // Match on the prefix only. Anything a human created is left alone.
  const orphans = campaigns.filter((c) =>
    String(c.Name ?? "").startsWith(TEST_NAME_PREFIX),
  );

  if (orphans.length === 0) {
    console.log(`No leftover ${TEST_NAME_PREFIX}* campaigns in account ${accountId}.`);
    return;
  }

  console.log(
    `${dryRun ? "Would delete" : "Deleting"} ${orphans.length} test campaign(s) in account ${accountId}:`,
  );
  for (const c of orphans) console.log(`  ${c.Id}  ${c.Name}`);

  if (dryRun) {
    console.log("\nDry run — nothing was deleted. Re-run without --dry-run to proceed.");
    return;
  }

  const submittedIds = orphans.map((c) => String(c.Id));
  const result = await cm.deleteCampaigns(ids, submittedIds);
  const inspection = inspectCleanupResult(submittedIds, result, "campaign");
  console.log(
    `\nCleaned ${inspection.cleanedIds.length}, failed ${inspection.failedIds.length}.`,
  );
  for (const failure of inspection.failures) console.error(`  ${failure}`);
  assertCleanupComplete(inspection, "campaign(s)");
}

try {
  await main();
} catch (err) {
  console.error("Cleanup failed:", (err as Error).message);
  process.exit(1);
}
