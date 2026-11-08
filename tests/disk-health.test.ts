import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

process.env.MYSENAM_DB = ":memory:";

import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { recentAlerts } from "../src/lib/alerts";
import { createBackup, listBackups } from "../src/lib/backup";
import { getDb } from "../src/lib/db";
import { checkDiskHealth, DEFAULT_THRESHOLDS, diskHealth, diskRefusal, diskThresholds, readDisk, resetDiskHealthClock, stateOf, type StatFn } from "../src/lib/disk-health";
import { copyOffsite, offsiteStatus } from "../src/lib/offsite";
import { runScheduledWork } from "../src/lib/scheduler";
import { GET as systemGet } from "../src/app/api/admin/system/route";

/**
 * Disk-space monitoring (lib/disk-health.ts, operations/monitoring.md#disk-space). The volume's answer is always stubbed
 * (`statfs`), so no test fills, or depends on how full, a real disk.
 */

/** A volume of 1,000 blocks of 4 KiB with the given percentage used (and everything not used free to a normal process). */
const volume = (usedPercent: number) => {
  const used = Math.round(usedPercent * 10);
  return { bsize: 4096, blocks: 1000, bfree: 1000 - used, bavail: 1000 - used };
};
const answering = (usedPercent: number): StatFn => async () => volume(usedPercent);

/** A clock well past the start of time, so the first look is never inside the 15 minutes of "last looked at 0". */
const T0 = 1_800_000_000_000;
const MIN = 60_000;

let disk = 10;
const spy = () => vi.spyOn(fs.promises, "statfs").mockImplementation((async () => volume(disk)) as never);

const diskAlerts = async () => (await recentAlerts()).filter((a) => a.key.startsWith("disk:") || a.key === "backup:no-space").map((a) => a.key).sort();
/** The most one owner was emailed about it: each owner is told once, however often it is looked at. */
const mailsAbout = async (word: string) =>
  Number(((await getDb().prepare("SELECT COALESCE(MAX(n), 0) AS n FROM (SELECT COUNT(*) AS n FROM messages WHERE kind = 'staff_alert' AND subject LIKE ? GROUP BY recipient) t").get(`%${word}%`)) as { n: number }).n);

const work = fs.mkdtempSync(path.join(os.tmpdir(), "disk-health-"));
const THRESHOLD_ENV = ["MYSENAM_DISK_WARN_PERCENT", "MYSENAM_DISK_CRITICAL_PERCENT", "MYSENAM_DISK_BLOCK_PERCENT"];
const saved = Object.fromEntries(THRESHOLD_ENV.map((k) => [k, process.env[k]]));

beforeAll(async () => {
  await ensureBootstrapAdmin();
});
afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});
beforeEach(async () => {
  // The suite's own setting keeps the machine's disk out of every other test; these tests use the real defaults.
  for (const k of THRESHOLD_ENV) delete process.env[k];
  delete process.env.MYSENAM_BACKUP_DIR;
  disk = 10;
  resetDiskHealthClock();
  await getDb().prepare("DELETE FROM system_alerts").run();
  await getDb().prepare("DELETE FROM messages WHERE kind = 'staff_alert'").run();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of THRESHOLD_ENV) if (saved[k] === undefined) delete process.env[k];
  else process.env[k] = saved[k];
  for (const k of Object.keys(process.env)) if (k.startsWith("OFFSITE_")) delete process.env[k];
});

describe("the thresholds", () => {
  it("are 80, 90 and 95 unless set", () => {
    expect(diskThresholds({})).toEqual({ ...DEFAULT_THRESHOLDS, valid: true, problem: null });
    expect(DEFAULT_THRESHOLDS).toEqual({ warn: 80, critical: 90, block: 95 });
  });

  it("can be set, one or all, so long as they increase", () => {
    expect(diskThresholds({ MYSENAM_DISK_WARN_PERCENT: "70" })).toMatchObject({ warn: 70, critical: 90, block: 95, valid: true });
    expect(diskThresholds({ MYSENAM_DISK_WARN_PERCENT: "60", MYSENAM_DISK_CRITICAL_PERCENT: "75.5", MYSENAM_DISK_BLOCK_PERCENT: "99" })).toMatchObject({ warn: 60, critical: 75.5, block: 99, valid: true });
  });

  it("fall back to the defaults, whole, and say so, when they are not numbers, out of range, or out of order", () => {
    for (const env of [
      { MYSENAM_DISK_WARN_PERCENT: "lots" },
      { MYSENAM_DISK_WARN_PERCENT: "0" },
      { MYSENAM_DISK_BLOCK_PERCENT: "101" },
      { MYSENAM_DISK_CRITICAL_PERCENT: "-5" },
      { MYSENAM_DISK_WARN_PERCENT: "92" }, // above the default critical
      { MYSENAM_DISK_WARN_PERCENT: "90", MYSENAM_DISK_CRITICAL_PERCENT: "90", MYSENAM_DISK_BLOCK_PERCENT: "95" },
      { MYSENAM_DISK_WARN_PERCENT: "50", MYSENAM_DISK_CRITICAL_PERCENT: "40", MYSENAM_DISK_BLOCK_PERCENT: "99" },
    ]) {
      const t = diskThresholds(env);
      expect(t, JSON.stringify(env)).toMatchObject({ warn: 80, critical: 90, block: 95, valid: false });
      expect(t.problem).toMatch(/defaults 80\/90\/95 are in force/);
    }
    expect(diskThresholds({ MYSENAM_DISK_WARN_PERCENT: "lots" }).problem).toContain("MYSENAM_DISK_WARN_PERCENT");
  });

  it("give the state at each boundary", () => {
    const t = DEFAULT_THRESHOLDS;
    expect([0, 79.9, 80, 89.9, 90, 94.9, 95, 100].map((p) => stateOf(p, t))).toEqual(["ok", "ok", "warn", "warn", "critical", "critical", "full", "full"]);
    expect(stateOf(null, t)).toBe("unknown");
  });
});

describe("reading the volume", () => {
  it("says used as df does: used over used plus what a normal process may still use, so root's reserve does not hide a full disk", async () => {
    // 1,000 blocks, 100 free in all but only 40 of them for a normal process: df says 960 / 1000 = 96%.
    const reading = await readDisk("/", async () => ({ bsize: 4096, blocks: 1000, bfree: 100, bavail: 40 }));
    expect(reading).toEqual({ totalBytes: 1000 * 4096, freeBytes: 40 * 4096, usedPercent: 95.7 });
  });

  it("reads the nearest folder that exists when the folder is not made yet", async () => {
    const asked: string[] = [];
    const statfs: StatFn = async (p) => {
      asked.push(p);
      if (p.includes("not-yet")) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return volume(42);
    };
    expect(await readDisk(path.join(work, "not-yet", "deeper"), statfs)).toMatchObject({ usedPercent: 42 });
    expect(asked).toEqual([path.join(work, "not-yet", "deeper"), path.join(work, "not-yet"), work]);
  });

  it("is unknown, not a guess, where the platform cannot answer", async () => {
    expect(await readDisk(work, async () => Promise.reject(Object.assign(new Error("not implemented"), { code: "ERR_METHOD_NOT_IMPLEMENTED" })))).toBeNull();
    expect(await readDisk(work, async () => Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" })))).toBeNull();
    expect(await readDisk(work, async () => ({ bsize: 4096, blocks: 0, bfree: 0, bavail: 0 }))).toBeNull();
    const health = await diskHealth({}, async () => Promise.reject(new Error("no statfs here")));
    expect(health).toMatchObject({ state: "unknown", usedPercent: null, freeBytes: null, totalBytes: null });
    expect(health.thresholds).toMatchObject({ warn: 80, critical: 90, block: 95 });
  });
});

describe("the alerts", () => {
  it("are told as the disk fills, one at a time, and clear as it falls", async () => {
    const check = async (used: number, at: number) => {
      disk = used;
      return checkDiskHealth(at, {}, answering(used));
    };
    expect(await check(50, T0)).toMatchObject({ state: "ok" });
    expect(await diskAlerts()).toEqual([]);

    expect(await check(85, T0 + 16 * MIN)).toMatchObject({ state: "warn" });
    expect(await diskAlerts()).toEqual(["disk:warn"]);
    expect(await check(92, T0 + 32 * MIN)).toMatchObject({ state: "critical" });
    expect(await diskAlerts()).toEqual(["disk:critical"]);
    expect(await check(97, T0 + 48 * MIN)).toMatchObject({ state: "full" });
    expect(await diskAlerts()).toEqual(["disk:full"]);
    // Falling: the worse alerts do not linger beside the state that now holds.
    expect(await check(91, T0 + 64 * MIN)).toMatchObject({ state: "critical" });
    expect(await diskAlerts()).toEqual(["disk:critical"]);
    expect(await check(40, T0 + 80 * MIN)).toMatchObject({ state: "ok" });
    expect(await diskAlerts()).toEqual([]);
  });

  it("say the volume's numbers and no path, in the owner's alert", async () => {
    await checkDiskHealth(T0, {}, answering(96));
    const [alert] = (await recentAlerts()).filter((a) => a.key === "disk:full");
    expect(alert.subject).toMatch(/backups are being refused/);
    expect(alert.lastDetail).toMatch(/96% of the disk/);
    expect(alert.lastDetail).toMatch(/95% limit/);
    expect(`${alert.subject}${alert.lastDetail}`).not.toContain(work);
    expect(`${alert.subject}${alert.lastDetail}`).not.toMatch(/\/(home|var|tmp|data)\b/);
    expect(alert.subjectPhrase).toMatchObject({ key: "srv.disk.full.alert" });
  });

  it("are told once, not at every look, while it stays so (deduped), and the owners are emailed once", async () => {
    for (let i = 0; i < 5; i++) await checkDiskHealth(T0 + i * 16 * MIN, {}, answering(91));
    const [alert] = (await recentAlerts()).filter((a) => a.key === "disk:critical");
    expect(alert.count).toBe(5);
    expect(await mailsAbout("nearly full")).toBe(1);
  });

  it("look at most every 15 minutes", async () => {
    expect(await checkDiskHealth(T0, {}, answering(85))).not.toBeNull();
    expect(await checkDiskHealth(T0 + 14 * MIN, {}, answering(99))).toBeNull();
    expect(await diskAlerts()).toEqual(["disk:warn"]);
    expect(await checkDiskHealth(T0 + 15 * MIN, {}, answering(99))).toMatchObject({ state: "full" });
    expect(await diskAlerts()).toEqual(["disk:full"]);
  });

  it("use the thresholds set, and the defaults, saying so, when they are wrong", async () => {
    await checkDiskHealth(T0, { MYSENAM_DISK_WARN_PERCENT: "50" }, answering(55));
    expect(await diskAlerts()).toEqual(["disk:warn"]);
    resetDiskHealthClock();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const health = await checkDiskHealth(T0, { MYSENAM_DISK_WARN_PERCENT: "nonsense" }, answering(85));
    expect(health?.thresholds).toMatchObject({ warn: 80, valid: false });
    expect(health?.state).toBe("warn");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("MYSENAM_DISK_WARN_PERCENT"));
  });

  it("leave what stands alone when the platform cannot answer, and raise nothing", async () => {
    await checkDiskHealth(T0, {}, answering(96));
    expect(await diskAlerts()).toEqual(["disk:full"]);
    const unknown = await checkDiskHealth(T0 + 16 * MIN, {}, async () => Promise.reject(new Error("no statfs")));
    expect(unknown).toMatchObject({ state: "unknown" });
    expect(await diskAlerts()).toEqual(["disk:full"]);
    resetDiskHealthClock();
    await getDb().prepare("DELETE FROM system_alerts").run();
    await checkDiskHealth(T0, {}, async () => Promise.reject(new Error("no statfs")));
    expect(await diskAlerts()).toEqual([]);
  });

  it("are raised by the scheduler's short pass, and by nothing in the long one", async () => {
    spy();
    disk = 93;
    await runScheduledWork(new Date(), "short");
    expect(await diskAlerts()).toEqual(["disk:critical"]);
    // Asked again at once: the 15-minute rule holds, nothing changes.
    disk = 10;
    await runScheduledWork(new Date(), "short");
    expect(await diskAlerts()).toEqual(["disk:critical"]);
    resetDiskHealthClock();
    await runScheduledWork(new Date(), "short");
    expect(await diskAlerts()).toEqual([]);
  });
});

describe("the owner's system answer", () => {
  it("carries the disk: used percent, free bytes, state and thresholds, owner only", async () => {
    spy();
    disk = 96.5;
    const owner = await createAdmin({ name: "Owner", email: "owner@disk.test", password: "a long enough password", venueId: null, role: "manager" });
    if (!owner.ok) throw new Error(owner.error);
    const call = (token?: string) => systemGet(new NextRequest("http://localhost/api/admin/system", token ? { headers: { cookie: `${ADMIN_SESSION_COOKIE}=${token}` } } : undefined));
    const res = await call((await createAdminSession(owner.admin.id)).token);
    expect(res.status).toBe(200);
    expect((await res.json()).disk).toEqual({
      state: "full",
      usedPercent: 96.5,
      freeBytes: 35 * 4096,
      totalBytes: 1000 * 4096,
      thresholds: { warn: 80, critical: 90, block: 95, valid: true, problem: null },
    });
    expect((await call()).status).toBe(401);
  });

  it("says unknown, with nulls, where the platform cannot answer", async () => {
    vi.spyOn(fs.promises, "statfs").mockRejectedValue(Object.assign(new Error("not implemented"), { code: "ERR_METHOD_NOT_IMPLEMENTED" }));
    const owner = await createAdmin({ name: "Owner Two", email: "owner2@disk.test", password: "a long enough password", venueId: null, role: "manager" });
    if (!owner.ok) throw new Error(owner.error);
    const res = await systemGet(new NextRequest("http://localhost/api/admin/system", { headers: { cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(owner.admin.id)).token}` } }));
    expect((await res.json()).disk).toMatchObject({ state: "unknown", usedPercent: null, freeBytes: null });
  });
});

describe("a backup at the block threshold", () => {
  it("is refused before it starts: nothing written, not a success, and not blocked a point below", async () => {
    const dir = path.join(work, "backups-a");
    const statfs = spy();
    disk = 95;
    const refused = await createBackup({ dir });
    expect(refused).toMatchObject({ ok: false, noSpace: true, error: expect.stringMatching(/Not started: the disk it would write to is 95% used.*95% limit/) });
    expect(fs.existsSync(dir)).toBe(false);
    expect(listBackups(dir)).toEqual([]);
    expect(refused.ok === false && refused.error).not.toContain(work);

    disk = 94.9;
    const taken = await createBackup({ dir });
    expect(taken.ok).toBe(true);
    expect(listBackups(dir)).toHaveLength(1);
    // The volume asked is the one the backup is written to.
    expect(statfs).toHaveBeenCalled();
  });

  it("looks at the backup folder's own volume, the nearest folder above it when it is not made yet", async () => {
    const dir = path.join(work, "backups-b", "not", "made");
    const asked: string[] = [];
    vi.spyOn(fs.promises, "statfs").mockImplementation((async (p: string) => {
      asked.push(p);
      if (p === dir || p === path.dirname(dir)) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return volume(99);
    }) as never);
    expect(await createBackup({ dir })).toMatchObject({ ok: false, noSpace: true });
    expect(asked[0]).toBe(dir);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("is not blocked by a platform that cannot answer (not knowing is no reason to stop a backup)", async () => {
    vi.spyOn(fs.promises, "statfs").mockRejectedValue(Object.assign(new Error("not implemented"), { code: "ERR_METHOD_NOT_IMPLEMENTED" }));
    expect((await createBackup({ dir: path.join(work, "backups-c") })).ok).toBe(true);
    expect(await diskRefusal(work, {}, async () => Promise.reject(new Error("no")))).toBeNull();
  });

  it("is told by the scheduler as backup:no-space, never as a success, tried again, and the alert clears when one is taken", async () => {
    process.env.MYSENAM_BACKUP_DIR = path.join(work, "backups-d");
    spy();
    disk = 97;
    const refused = await runScheduledWork(new Date(), "long");
    expect(refused.backup).toMatchObject({ ok: false, error: expect.stringMatching(/Not started/) });
    expect(await diskAlerts()).toEqual(["backup:no-space"]);
    expect(listBackups(process.env.MYSENAM_BACKUP_DIR)).toEqual([]);
    // Not the ordinary failure alert, and the off-site copy was not attempted as if there were a set.
    expect((await recentAlerts()).map((a) => a.key)).not.toContain("backup");
    expect((await offsiteStatus()).lastCopied).toBeNull();
    // Told once however often it is tried (the scheduler tries each minute while a backup is due).
    await runScheduledWork(new Date(), "long");
    await runScheduledWork(new Date(), "long");
    expect((await recentAlerts()).find((a) => a.key === "backup:no-space")?.count).toBe(3);
    expect(await mailsAbout("too full")).toBe(1);

    disk = 60;
    const taken = await runScheduledWork(new Date(), "long");
    expect(taken.backup).toMatchObject({ ok: true });
    expect(await diskAlerts()).toEqual([]);
    expect(listBackups(process.env.MYSENAM_BACKUP_DIR)).toHaveLength(1);
  });

  it("never blocks the short pass that holds bookings and payments: it runs, and says so only as an alert", async () => {
    spy();
    disk = 99;
    const result = await runScheduledWork(new Date(), "short");
    expect(result.backup).toBeNull();
    expect(await diskAlerts()).toEqual(["disk:full"]);
  });
});

describe("an off-site copy at the block threshold", () => {
  const offsiteEnv = (publicKeyFile: string | null) => {
    process.env.OFFSITE_S3_ENDPOINT = "http://127.0.0.1:9"; // nothing listens: a copy that is not refused fails differently
    process.env.OFFSITE_S3_BUCKET = "backups";
    process.env.OFFSITE_S3_ACCESS_KEY_ID = "id";
    process.env.OFFSITE_S3_SECRET_ACCESS_KEY = "secret";
    process.env.OFFSITE_DATA_LOCATION = "MY";
    if (publicKeyFile) process.env.OFFSITE_ENCRYPTION_PUBLIC_KEY_FILE = publicKeyFile;
  };
  const publicKey = () => {
    const file = path.join(work, "offsite-public.pem");
    fs.writeFileSync(file, crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }));
    return file;
  };

  it("that would write an encrypted scratch copy is refused, remembered as failed, and the last good copy stands", async () => {
    spy();
    const taken = await createBackup({ dir: path.join(work, "backups-e") });
    if (!taken.ok) throw new Error(taken.error);
    offsiteEnv(publicKey());
    const before = await offsiteStatus();
    disk = 96;
    const refused = await copyOffsite(taken.file, taken.photos.file, taken.manifest);
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/Not started: the disk it would write to is 96% used/) });
    const status = await offsiteStatus();
    expect(status.lastError?.error).toMatch(/Not started/);
    expect(status.lastCopied).toEqual(before.lastCopied);
  });

  it("with room goes on (here to a closed port, so it fails for its own reason), and one that writes no scratch copy is not held back by the disk", async () => {
    spy();
    const taken = await createBackup({ dir: path.join(work, "backups-f") });
    if (!taken.ok) throw new Error(taken.error);
    offsiteEnv(publicKey());
    disk = 50;
    expect(await copyOffsite(taken.file, taken.photos.file, taken.manifest)).toMatchObject({ ok: false, error: expect.not.stringMatching(/Not started/) });
    // Streamed as it is: nothing is written beside the data, so a full disk is no reason to hold the copy that protects it.
    offsiteEnv(null);
    delete process.env.OFFSITE_ENCRYPTION_PUBLIC_KEY_FILE;
    disk = 99;
    expect(await copyOffsite(taken.file, taken.photos.file, taken.manifest)).toMatchObject({ ok: false, error: expect.not.stringMatching(/Not started/) });
  });
});
