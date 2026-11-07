import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-units-"));
process.env.MYSENAM_BACKUP_DIR = dir;
process.env.MYSENAM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-units-data-"));

// A backup that has not finished, until the test lets it: the stand-in for a large database and a slow off-site upload.
const slow = vi.hoisted(() => ({ calls: 0, finish: null as null | (() => void) }));
vi.mock("../src/lib/backup", async (original) => ({
  ...(await original<typeof import("../src/lib/backup")>()),
  hoursSinceLastBackup: () => null,
  createBackup: vi.fn(() => {
    slow.calls++;
    return new Promise((resolve) => (slow.finish = () => resolve({ ok: false, error: "stand-in backup ended" })));
  }),
}));
vi.mock("../src/lib/notify", async (original) => {
  const real = await original<typeof import("../src/lib/notify")>();
  return { ...real, tickOutbox: vi.fn(real.tickOutbox) };
});
vi.mock("../src/lib/payments", async (original) => {
  const real = await original<typeof import("../src/lib/payments")>();
  return { ...real, settleRefundClaims: vi.fn(real.settleRefundClaims), settlePendingRefunds: vi.fn(real.settlePendingRefunds), reconcileRefunds: vi.fn(real.reconcileRefunds) };
});

import { getDb } from "../src/lib/db";
import { tickOutbox } from "../src/lib/notify";
import { settleRefundClaims } from "../src/lib/payments";
import { createBackup } from "../src/lib/backup";
import { holdLease, LEASE_MS, LONG_LEASE, longJobMs, runScheduledWork, SHORT_LEASE, schedulerTicks, withLease } from "../src/lib/scheduler";

/**
 * Hardening round G18 (ADR 0066): the backup and its off-site copy run as their own unit, on their own lease, so that however long
 * they take the outbox, refunds and the heartbeat go on each minute; a unit that outlasts its limit loses its lease; two
 * instances share the work without doing any of it twice. The backup here is a stand-in that waits: it proves the scheduler does not
 * wait for it, not how long a real upload takes.
 */

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(async () => {
  slow.finish?.();
  slow.finish = null;
  delete process.env.MYSENAM_LONG_JOB_MINUTES;
  vi.useRealTimers();
  await getDb().prepare("DELETE FROM settings WHERE key IN (?, ?)").run(SHORT_LEASE, LONG_LEASE);
});
beforeEach(() => {
  slow.calls = 0;
  slow.finish = null;
  vi.mocked(createBackup).mockClear();
  vi.mocked(tickOutbox).mockClear();
  vi.mocked(settleRefundClaims).mockClear();
});

const until = async (what: () => boolean | Promise<boolean>, ms = 20000) => {
  for (let waited = 0; waited < ms; waited += 10) {
    if (await what()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("did not happen in time");
};
const heartbeat = async () => ((await getDb().prepare("SELECT value FROM settings WHERE key = 'scheduler_heartbeat'").get()) as { value: string } | undefined)?.value ?? null;

describe("a long backup is its own unit", () => {
  it("does not delay the outbox, refunds or heartbeat: every short pass runs, and no second backup starts meanwhile", async () => {
    const { tick, longTick } = schedulerTicks();
    const long = longTick();
    await until(() => slow.calls === 1);
    await getDb().prepare("INSERT INTO settings (key, value) VALUES ('scheduler_heartbeat', '2000-01-01 00:00:00') ON CONFLICT (key) DO UPDATE SET value = excluded.value").run();
    for (let i = 0; i < 3; i++) await tick();
    // Three minutes of short passes while the backup has not ended.
    expect(vi.mocked(tickOutbox)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(settleRefundClaims)).toHaveBeenCalledTimes(3);
    expect((await heartbeat())! > "2000-01-01").toBe(true);
    // The next minutes' long ticks find it still running, and start nothing.
    await longTick();
    await longTick();
    expect(slow.calls).toBe(1);
    // Ended, the next one may start.
    slow.finish!();
    await long;
    void longTick();
    await until(() => slow.calls === 2);
  });

  it("is kept out of the short pass, and the short work out of the long one; both together are what a caller asking for everything gets", async () => {
    const short = await runScheduledWork(new Date(), "short");
    expect(short.backup).toBeNull();
    expect(createBackup).not.toHaveBeenCalled();
    expect(tickOutbox).toHaveBeenCalledTimes(1);
    vi.mocked(tickOutbox).mockClear();
    const long = runScheduledWork(new Date(), "long");
    await until(() => slow.calls === 1);
    slow.finish!();
    expect((await long).backup).toMatchObject({ ok: false });
    expect(tickOutbox).not.toHaveBeenCalled();
    const both = runScheduledWork(new Date());
    await until(() => slow.calls === 2);
    slow.finish!();
    expect((await both).backup).toMatchObject({ ok: false });
    expect(tickOutbox).toHaveBeenCalledTimes(1);
  });
});

describe("a unit that outlasts its limit", () => {
  it("loses its lease, tells the owners once, and starts no second backup in this process until it ends", async () => {
    process.env.MYSENAM_LONG_JOB_MINUTES = "0.001";
    expect(longJobMs()).toBe(60);
    const { longTick } = schedulerTicks();
    await longTick();
    expect(slow.calls).toBe(1);
    const alert = (await getDb().prepare("SELECT key, count FROM system_alerts WHERE key = 'scheduler:long-jobs-overran'").get()) as { key: string; count: number };
    expect(alert.count).toBe(1);
    // Not renewed: it runs out, and an instance elsewhere takes the long work.
    const row = (await getDb().prepare("SELECT value FROM settings WHERE key = ?").get(LONG_LEASE)) as { value: string };
    const until_ = Number(row.value.split("|")[1]);
    expect(until_).toBeLessThanOrEqual(Date.now() + LEASE_MS);
    expect(await holdLease(LONG_LEASE, "another-instance", until_ + 1)).toBe(true);
    await getDb().prepare("DELETE FROM settings WHERE key = ?").run(LONG_LEASE);
    // Still running here: the next minutes start nothing, and the alert is not raised again.
    await longTick();
    await longTick();
    expect(slow.calls).toBe(1);
    expect(((await getDb().prepare("SELECT count FROM system_alerts WHERE key = 'scheduler:long-jobs-overran'").get()) as { count: number }).count).toBe(1);
    slow.finish!();
    await until(async () => {
      await longTick();
      return slow.calls === 2;
    });
  });

  it("is not waited for by withLease past its limit, and the lease is not renewed after", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(20_000_000_000);
    const stuck = new Promise<void>(() => undefined);
    // maxMs uses a real timer (setTimeout is not faked): a short one.
    const outcome = await withLease(LONG_LEASE, () => stuck, { instance: "a", maxMs: 30 });
    expect(outcome).toBe("overran");
    // Minutes pass with nobody renewing: the other may take it once it runs out, and not before.
    expect(await holdLease(LONG_LEASE, "b", Date.now() + LEASE_MS - 1)).toBe(false);
    expect(await holdLease(LONG_LEASE, "b", Date.now() + LEASE_MS + 1)).toBe(true);
  });
});

describe("the two leases and two instances", () => {
  it("are independent: one instance runs the short work while another runs the long, and neither takes the other's", async () => {
    expect(await holdLease(SHORT_LEASE, "a", 0)).toBe(true);
    expect(await holdLease(LONG_LEASE, "b", 0)).toBe(true);
    expect(await holdLease(SHORT_LEASE, "b", 1_000)).toBe(false);
    expect(await holdLease(LONG_LEASE, "a", 1_000)).toBe(false);
    // The holder renews; the other can take it only after it runs out.
    expect(await holdLease(LONG_LEASE, "b", 60_000)).toBe(true);
    expect(await holdLease(LONG_LEASE, "a", 60_000 + LEASE_MS - 1)).toBe(false);
    expect(await holdLease(LONG_LEASE, "a", 60_000 + LEASE_MS + 1)).toBe(true);
    // The short lease was untouched by all of that.
    expect(await holdLease(SHORT_LEASE, "a", 60_000)).toBe(true);
  });

  it("two instances starting the long work at the same moment run it once", async () => {
    let ran = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const work = async () => {
      ran++;
      await gate;
    };
    const both = Promise.all([withLease(LONG_LEASE, work, { instance: "a" }), withLease(LONG_LEASE, work, { instance: "b" })]);
    await until(() => ran >= 1);
    // Give the other every chance to start too.
    await new Promise((r) => setTimeout(r, 50));
    release();
    const outcomes = (await both).sort();
    expect(outcomes).toEqual(["held", "ran"]);
    expect(ran).toBe(1);
  });

  it("the short lease keeps its old behaviour for the callers that use it (holdSchedulerLease, withSchedulerLease are covered in scale-out.test.ts)", async () => {
    expect(await withLease(SHORT_LEASE, async () => undefined, { instance: "x" })).toBe("ran");
    expect(await withLease(SHORT_LEASE, async () => undefined, { instance: "y" })).toBe("held");
  });
});
