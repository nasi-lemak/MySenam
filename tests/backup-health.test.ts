import { afterAll, afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

process.env.MYSENAM_DB = ":memory:";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backup-health-"));
process.env.MYSENAM_BACKUP_DIR = dir;
process.env.MYSENAM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "backup-health-data-"));

import { backupHealth, rpoHours } from "../src/lib/backup-health";
import { createBackup } from "../src/lib/backup";
import { getDb } from "../src/lib/db";
import { MAX_UPLOAD } from "../src/lib/offsite";
import { checkBackupHealth } from "../src/lib/scheduler";

/**
 * Whether the install could be recovered, and from how long ago: the state on
 * the Backups panel, and the alerts the scheduler raises when copies stop or
 * fall behind the recovery-point target.
 */

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

afterEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith("OFFSITE_")) delete process.env[k];
  delete process.env.MYSENAM_BACKUP_RPO_HOURS;
});

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

async function lastCopy(stored: { lastCopied: object | null; lastError: object | null }) {
  await getDb()
    .prepare("INSERT INTO settings (key, value) VALUES ('offsite_status', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(stored));
}

function offsiteAtHome() {
  process.env.OFFSITE_S3_ENDPOINT = "https://s3.ap-southeast-5.amazonaws.com";
  process.env.OFFSITE_S3_BUCKET = "b";
  process.env.OFFSITE_S3_ACCESS_KEY_ID = "i";
  process.env.OFFSITE_S3_SECRET_ACCESS_KEY = "s";
  process.env.OFFSITE_DATA_LOCATION = "MY";
}

async function alert(key: string) {
  return (await getDb().prepare("SELECT subject, last_detail FROM system_alerts WHERE key = ?").get(key)) as { subject: string; last_detail: string } | undefined;
}

describe("backup health", () => {
  it("says there is nothing yet, then that copies are on this server only", async () => {
    expect(await backupHealth()).toMatchObject({ state: "none", recoverableHours: null, problems: [expect.stringMatching(/no backup/)] });
    const taken = await createBackup();
    expect(taken.ok).toBe(true);
    const health = await backupHealth();
    expect(health).toMatchObject({ state: "local_only", offsite: "off", problems: [] });
    expect(health.recoverableHours).toBeLessThan(1);
    await checkBackupHealth();
    expect(await alert("backup-stale")).toBeUndefined();
  });

  it("counts the newest off-site copy as the recovery point once off-site copies are set up, and alerts past the target", async () => {
    offsiteAtHome();
    await lastCopy({ lastCopied: null, lastError: null });
    expect(await backupHealth()).toMatchObject({ state: "stale", offsite: "active", recoverableHours: null, problems: [expect.stringMatching(/Nothing has been copied off-site/)] });

    await lastCopy({ lastCopied: { name: "x.dump", at: hoursAgo(2), key: "x" }, lastError: null });
    expect(await backupHealth()).toMatchObject({ state: "ok", offsite: "active", problems: [] });

    // Copies stopped a day and a half ago, though local snapshots go on.
    await lastCopy({ lastCopied: { name: "x.dump", at: hoursAgo(36), key: "x" }, lastError: null });
    const behind = await backupHealth();
    expect(behind).toMatchObject({ state: "stale", rpoHours: 26 });
    expect(behind.recoverableHours).toBeGreaterThan(35);
    expect(behind.problems[0]).toMatch(/off-site copy is 3[56] hours old, past the 26-hour/);
    await checkBackupHealth();
    expect(await alert("backup-stale")).toMatchObject({ subject: expect.stringMatching(/recovery-point target/) });

    // A longer target, set for the install.
    process.env.MYSENAM_BACKUP_RPO_HOURS = "48";
    expect(rpoHours()).toBe(48);
    expect((await backupHealth()).state).toBe("ok");
    process.env.MYSENAM_BACKUP_RPO_HOURS = "nonsense";
    expect(rpoHours()).toBe(26);
  });

  it("is failing when the last attempt failed after the last copy, and paused when the transfer is not allowed", async () => {
    offsiteAtHome();
    await lastCopy({ lastCopied: { name: "x.dump", at: hoursAgo(3), key: "x" }, lastError: { at: hoursAgo(1), error: "403 AccessDenied" } });
    expect(await backupHealth()).toMatchObject({ state: "failing", offsite: "failing", problems: [expect.stringMatching(/failing: 403 AccessDenied/)] });

    // A B2 bucket in the US, declared as Malaysia: paused, and said why.
    process.env.OFFSITE_S3_ENDPOINT = "https://s3.us-west-004.backblazeb2.com";
    expect(await backupHealth()).toMatchObject({ state: "paused", offsite: "paused", problems: expect.arrayContaining([expect.stringMatching(/in US, but OFFSITE_DATA_LOCATION says MY/)]) });
  });

  it("warns when the largest part nears what one upload can carry, even in parts", async () => {
    offsiteAtHome();
    await lastCopy({ lastCopied: { name: "x.dump", at: hoursAgo(1), key: "x", largestBytes: Math.ceil(MAX_UPLOAD * 0.85) }, lastError: null });
    const health = await backupHealth();
    expect(health).toMatchObject({ state: "ok", nearSizeLimit: true, problems: [expect.stringMatching(/one upload, in parts, takes about 976 GB/)] });
    await checkBackupHealth();
    expect(await alert("offsite-near-limit")).toBeDefined();
    await lastCopy({ lastCopied: { name: "x.dump", at: hoursAgo(1), key: "x", largestBytes: 1024 }, lastError: null });
    expect((await backupHealth()).nearSizeLimit).toBe(false);
  });
});
