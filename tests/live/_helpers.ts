import { resolveAccount } from "@/services/accounts";
import * as cm from "@/services/campaigns";
import type { BatchResult, ItemOutcome } from "@/utils/batch";
import { MsAdsError } from "@/utils/errors";

/**
 * Helpers for integration tests that hit the real Microsoft Advertising API.
 *
 * Guard contract — all three are required, with no fallbacks:
 *   - MSADS_RUN_LIVE_TESTS=true   explicit opt-in
 *   - credentials in the environment
 *   - MSADS_TEST_ACCOUNT_ID       the account these tests may touch
 *
 * The account id never falls back to "the first account we can see". A test
 * suite that creates and deletes campaigns must never guess which account it
 * is pointed at. MSADS_TEST_ACCOUNT_ID is the whole safety story: opting in
 * means opting in to writes, which are created paused and deleted in the same
 * run, with `bun run test:cleanup` as the fallback sweep.
 */

export const TEST_NAME_PREFIX = "mcp-msads-test-";

export function liveTestsEnabled(): boolean {
  return (
    process.env.MSADS_RUN_LIVE_TESTS === "true" &&
    Boolean(process.env.MSADS_REFRESH_TOKEN || process.env.MSADS_TOKEN_FILE) &&
    Boolean(process.env.MSADS_TEST_ACCOUNT_ID)
  );
}

export function liveSkipReason(): string {
  if (process.env.MSADS_RUN_LIVE_TESTS !== "true") return "MSADS_RUN_LIVE_TESTS != true";
  if (!process.env.MSADS_REFRESH_TOKEN && !process.env.MSADS_TOKEN_FILE) {
    return "no MSADS_REFRESH_TOKEN or MSADS_TOKEN_FILE";
  }
  if (!process.env.MSADS_TEST_ACCOUNT_ID) return "MSADS_TEST_ACCOUNT_ID not set";
  return "enabled";
}

export function liveWritesEnabled(): boolean {
  return liveTestsEnabled();
}

export function liveWriteSkipReason(): string {
  return liveSkipReason();
}

export function getTestAccountId(): string {
  const id = process.env.MSADS_TEST_ACCOUNT_ID;
  if (!id) {
    throw new Error(
      "MSADS_TEST_ACCOUNT_ID is required for live tests. Set it to an ad account that is safe to mutate.",
    );
  }
  return id;
}

export async function testIds() {
  return resolveAccount({ accountId: getTestAccountId() });
}

/** Prefixed, unique entity name so the fallback cleanup script can find orphans. */
export function testName(suffix: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${TEST_NAME_PREFIX}${suffix}-${stamp}-${rand}`;
}

export interface CleanupRegistry {
  trackCampaign(id: string): void;
  trackAdGroup(campaignId: string, id: string): void;
  cleanup(): Promise<{ deleted: number; failed: number }>;
}

export interface CleanupInspection {
  cleanedIds: string[];
  failedIds: string[];
  failures: string[];
}

export type CleanupEntity = "campaign" | "ad_group";

const ALREADY_GONE_CODE = 1044;
const ALREADY_GONE_NAME = "CampaignServiceEntityDoesNotExist";

/** Treat only confirmed success or Microsoft's exact entity-absence code as clean. */
export function inspectCleanupResult(
  submittedIds: string[],
  result: BatchResult,
  entity: CleanupEntity,
): CleanupInspection {
  const cleanedIds: string[] = [];
  const failedIds: string[] = [];
  const failures: string[] = [];

  for (let index = 0; index < submittedIds.length; index++) {
    const id = submittedIds[index]!;
    const outcome = result.outcomes.find((candidate) => candidate.index === index);
    if (outcome?.success || (outcome && isAlreadyGoneOutcome(outcome, entity))) {
      cleanedIds.push(id);
    } else {
      failedIds.push(id);
      failures.push(
        `${id}: ${outcome?.error?.message ?? "no successful cleanup outcome"}`,
      );
    }
  }
  for (const error of result.unattributed_errors ?? []) {
    failures.push(
      `request: ${error.message ?? error.errorCode ?? error.code ?? "unknown error"}`,
    );
  }
  return { cleanedIds, failedIds, failures };
}

export function assertCleanupComplete(
  inspection: CleanupInspection,
  entityName = "entities",
): void {
  if (inspection.failedIds.length > 0 || inspection.failures.length > 0) {
    throw new Error(
      `Cleanup left ${inspection.failedIds.length} ${entityName}: ${inspection.failedIds.join(", ")}`,
    );
  }
}

function hasAlreadyGoneCode(code: number | undefined, name: string | undefined) {
  if (code === undefined) return name === ALREADY_GONE_NAME;
  return code === ALREADY_GONE_CODE && (name === undefined || name === ALREADY_GONE_NAME);
}

function isAlreadyGoneOutcome(outcome: ItemOutcome, _entity: CleanupEntity): boolean {
  const errors = outcome.errors ?? (outcome.error ? [outcome.error] : []);
  return (
    errors.length > 0 &&
    errors.every((error) => hasAlreadyGoneCode(error.code, error.error_code))
  );
}

/**
 * Per-file registry of entities to delete at teardown.
 *
 * Deletion runs children-first. Deleting a campaign removes its ad groups
 * anyway, so a 'not found' during cleanup is success, not failure.
 */
export function createRegistry(): CleanupRegistry {
  const campaigns = new Set<string>();
  const adGroups = new Map<string, Set<string>>();

  return {
    trackCampaign: (id) => campaigns.add(id),
    trackAdGroup: (campaignId, id) => {
      const set = adGroups.get(campaignId) ?? new Set<string>();
      set.add(id);
      adGroups.set(campaignId, set);
    },
    async cleanup() {
      if (campaigns.size === 0 && adGroups.size === 0) return { deleted: 0, failed: 0 };

      const ids = await testIds();
      let deleted = 0;
      const failures: string[] = [];

      for (const [campaignId, groupIds] of adGroups) {
        const submitted = [...groupIds];
        try {
          const inspection = inspectCleanupResult(
            submitted,
            await cm.deleteAdGroups(ids, campaignId, submitted),
            "ad_group",
          );
          deleted += inspection.cleanedIds.length;
          for (const id of inspection.cleanedIds) groupIds.delete(id);
          failures.push(...inspection.failures.map((failure) => `ad group ${failure}`));
        } catch (err) {
          if (isAlreadyGone(err, "ad_group")) {
            deleted += submitted.length;
            groupIds.clear();
          } else {
            failures.push(
              ...submitted.map((id) => `ad group ${id}: ${(err as Error).message}`),
            );
          }
        }
        if (groupIds.size === 0) adGroups.delete(campaignId);
      }

      if (campaigns.size > 0) {
        const submitted = [...campaigns];
        try {
          const inspection = inspectCleanupResult(
            submitted,
            await cm.deleteCampaigns(ids, submitted),
            "campaign",
          );
          deleted += inspection.cleanedIds.length;
          for (const id of inspection.cleanedIds) campaigns.delete(id);
          failures.push(...inspection.failures.map((failure) => `campaign ${failure}`));
        } catch (err) {
          if (isAlreadyGone(err, "campaign")) {
            deleted += submitted.length;
            campaigns.clear();
          } else {
            failures.push(
              ...submitted.map((id) => `campaign ${id}: ${(err as Error).message}`),
            );
          }
        }
      }

      const failed =
        [...adGroups.values()].reduce((sum, set) => sum + set.size, 0) + campaigns.size;
      if (failures.length > 0 || failed > 0) {
        throw new Error(
          `Live-test cleanup left ${failed} registered entity id(s): ${failures.join("; ")}`,
        );
      }
      return { deleted, failed: 0 };
    },
  };
}

/** A missing entity during cleanup means the test already removed it. */
function isAlreadyGone(err: unknown, _entity: CleanupEntity): boolean {
  if (!(err instanceof MsAdsError)) return false;
  const errors = [...err.errors, ...err.partialErrors];
  return (
    errors.length > 0 &&
    errors.every((error) => hasAlreadyGoneCode(error.code, error.errorCode))
  );
}
