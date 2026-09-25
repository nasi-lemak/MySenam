import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

process.env.MYSENAM_DB = ":memory:";

import {
  createBackup,
  DEFAULT_KEEP,
  hoursSinceLastBackup,
  listBackups,
  pruneBackups,
  verifyBackup,
} from "../src/lib/backup";
import { createBooking, listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mysenam-backup-"));
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("taking a snapshot", () => {
  it("writes a readable copy of the live database", () => {
    const court = listVenues()[0].courts[0];
    const booking = createBooking({
      courtId: court.id,
      date: addDays(todayISO(), 5),
      hours: [10],
      name: "Backup Test",
      phone: "0170000001",
    });
    expect(booking.ok).toBe(true);

    const result = createBackup({ dir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bookings).toBeGreaterThan(0);
    expect(result.file.bytes).toBeGreaterThan(0);
    expect(result.file.name).toMatch(/^mysenam-\d{4}-\d{2}-\d{2}-\d{6}\.db$/);
    expect(fs.existsSync(result.file.path)).toBe(true);

    // The copy has to stand on its own, not just exist.
    const verified = verifyBackup(result.file.path);
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.bookings).toBe(result.bookings);
  });

  it("leaves nothing behind when it cannot write", () => {
    const missing = path.join(dir, "no", "such", "place");
    fs.mkdirSync(missing, { recursive: true });
    fs.chmodSync(missing, 0o500);
    const result = createBackup({ dir: missing });
    // Root can write to a read-only directory, so only assert the invariant
    // that matters: whatever happened, no half-file is left looking real.
    expect(listBackups(missing).every((b) => verifyBackup(b.path).ok)).toBe(true);
    expect(fs.readdirSync(missing).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
    if (!result.ok) expect(result.error).not.toBe("");
    fs.chmodSync(missing, 0o700);
  });

  it("refuses a file that is not a database", () => {
    const junk = path.join(dir, "mysenam-2026-01-01-000000.db");
    fs.writeFileSync(junk, "this is not a database");
    expect(verifyBackup(junk).ok).toBe(false);
    expect(verifyBackup(path.join(dir, "absent.db")).ok).toBe(false);
  });

  it("names snapshots so they sort oldest to newest", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T01:00:00+08:00"));
    const first = createBackup({ dir });
    vi.setSystemTime(new Date("2026-09-26T02:00:00+08:00"));
    const second = createBackup({ dir });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(first.file.name < second.file.name).toBe(true);
    expect(second.file.takenAt).toBe("2026-09-26 02:00:00");
    // Newest first is what an operator wants to see.
    expect(listBackups(dir)[0].name).toBe(second.file.name);
  });
});

describe("keeping the folder tidy", () => {
  function snapshotsAt(hours: number[]) {
    vi.useFakeTimers();
    for (const h of hours) {
      vi.setSystemTime(new Date(`2026-09-26T${String(h).padStart(2, "0")}:00:00+08:00`));
      const made = createBackup({ dir, keep: 99 });
      expect(made.ok).toBe(true);
    }
  }

  it("retires the oldest and keeps the rest", () => {
    snapshotsAt([1, 2, 3, 4, 5]);
    expect(listBackups(dir)).toHaveLength(5);

    const dropped = pruneBackups(2, dir);
    expect(dropped).toHaveLength(3);
    const left = listBackups(dir);
    expect(left).toHaveLength(2);
    // The two that survive are the newest two.
    expect(left.map((b) => b.takenAt)).toEqual(["2026-09-26 05:00:00", "2026-09-26 04:00:00"]);
  });

  it("prunes as part of taking one, without touching anything else", () => {
    snapshotsAt([1, 2, 3]);
    fs.writeFileSync(path.join(dir, "notes.txt"), "not a backup");

    vi.setSystemTime(new Date("2026-09-26T04:00:00+08:00"));
    const result = createBackup({ dir, keep: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pruned).toHaveLength(2);
    expect(listBackups(dir)).toHaveLength(2);
    // Anything that is not a snapshot is none of its business.
    expect(fs.existsSync(path.join(dir, "notes.txt"))).toBe(true);
  });

  it("never prunes itself down to nothing", () => {
    snapshotsAt([1, 2]);
    expect(pruneBackups(0, dir)).toHaveLength(0);
    expect(listBackups(dir)).toHaveLength(2);
    expect(DEFAULT_KEEP).toBeGreaterThan(1);
  });
});

describe("how stale the newest one is", () => {
  it("reports nothing at all when there are no backups", () => {
    expect(hoursSinceLastBackup(dir)).toBeNull();
  });

  it("measures from the snapshot's own name", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T02:00:00+08:00"));
    expect(createBackup({ dir }).ok).toBe(true);

    vi.setSystemTime(new Date("2026-09-26T08:00:00+08:00"));
    expect(hoursSinceLastBackup(dir)).toBeCloseTo(6, 1);
  });
});
