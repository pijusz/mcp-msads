import { describe, expect, test } from "bun:test";
import { buildImportJob, validateCron } from "@/services/import-jobs";

const BASE = { name: "Nightly", credentialId: "cred-1", googleAccountId: "123" };

describe("validateCron", () => {
  test("accepts the documented daily expression", () => {
    expect(() => validateCron("0 16 * * * *")).not.toThrow();
  });

  test("accepts weekly and monthly expressions", () => {
    expect(() => validateCron("0 16 * * 3 *")).not.toThrow();
    expect(() => validateCron("0 16 1 * * *")).not.toThrow();
  });

  test("rejects the wrong number of fields, naming the six", () => {
    expect(() => validateCron("0 16 * * *")).toThrow(/exactly 6/);
  });

  test("rejects a non-zero minute, since imports run on the hour", () => {
    expect(() => validateCron("30 16 * * * *")).toThrow(/must be 0/);
  });
});

describe("buildImportJob", () => {
  test("emits the GoogleImportJob discriminator", () => {
    expect(buildImportJob(BASE).Type).toBe("GoogleImportJob");
  });

  test("omits Frequency for a run-now job", () => {
    expect(buildImportJob(BASE).Frequency).toBeUndefined();
  });

  test("builds a scheduled frequency", () => {
    const job = buildImportJob({
      ...BASE,
      frequency: { type: "Scheduling", cron: "0 16 * * * *" },
    });
    expect(job.Frequency).toMatchObject({ Type: "Scheduling", Cron: "0 16 * * * *" });
  });

  test("requires a cron when scheduling", () => {
    expect(() => buildImportJob({ ...BASE, frequency: { type: "Scheduling" } })).toThrow(
      /requires a cron/,
    );
  });

  test("rejects a frequency type that is really a cron concept", () => {
    // Daily/Weekly/Monthly are all "Scheduling" with different crons.
    expect(() => buildImportJob({ ...BASE, frequency: { type: "Daily" } })).toThrow(
      /Daily\/weekly\/monthly are all/,
    );
  });

  test("explains where to get a credential id when it is missing", () => {
    // No v13 operation returns one, so the message must point at the UI.
    expect(() => buildImportJob({ ...BASE, credentialId: "" })).toThrow(
      /Import credential ID/,
    );
  });

  test("requires a google account id", () => {
    expect(() => buildImportJob({ ...BASE, googleAccountId: "" })).toThrow(
      /google_account_id is required/,
    );
  });

  test("enforces the 255-character name limit", () => {
    expect(() => buildImportJob({ ...BASE, name: "x".repeat(256) })).toThrow(/1–255/);
  });

  test("tags the import option with its discriminator", () => {
    const job = buildImportJob({
      ...BASE,
      importOption: { NewPausedCampaignsAndChildEntities: true },
    });
    expect(job.ImportOption).toMatchObject({
      Type: "GoogleImportOption",
      NewPausedCampaignsAndChildEntities: true,
    });
  });
});
