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
  localPhotosDir,
  photosArchiveOf,
  pruneBackups,
  restorePhotos,
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
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("taking a snapshot", () => {
  it("writes a readable copy of the live database", async () => {
    const court = (await listVenues())[0].courts[0];
    const booking = await createBooking({
      courtId: court.id,
      date: addDays(todayISO(), 5),
      hours: [10],
      name: "Backup Test",
      phone: "0170000001",
    });
    expect(booking.ok).toBe(true);

    const result = await createBackup({ dir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bookings).toBeGreaterThan(0);
    expect(result.file.bytes).toBeGreaterThan(0);
    expect(result.file.name).toMatch(/^mysenam-\d{4}-\d{2}-\d{2}-\d{6}\.(dump|tar\.gz)$/);
    expect(fs.existsSync(result.file.path)).toBe(true);

    // The copy has to stand on its own, not just exist.
    const verified = await verifyBackup(result.file.path);
    expect(verified.ok).toBe(true);
    // A PGlite copy is loaded and counted; a pg_dump file is only listed.
    if (verified.ok && verified.bookings !== null) expect(verified.bookings).toBe(result.bookings);
  });

  it("leaves nothing behind when it cannot write", async () => {
    const missing = path.join(dir, "no", "such", "place");
    fs.mkdirSync(missing, { recursive: true });
    fs.chmodSync(missing, 0o500);
    const result = await createBackup({ dir: missing });
    // Root can write to a read-only directory, so only assert the invariant
    // that matters: whatever happened, no half-file is left looking real.
    for (const b of listBackups(missing)) expect((await verifyBackup(b.path)).ok).toBe(true);
    expect(fs.readdirSync(missing).filter((f) => f.startsWith(".tmp-"))).toHaveLength(0);
    if (!result.ok) expect(result.error).not.toBe("");
    fs.chmodSync(missing, 0o700);
  });

  it("refuses a file that is not a backup", async () => {
    for (const ext of ["tar.gz", "dump", "db"]) {
      const junk = path.join(dir, `mysenam-2026-01-01-000000.${ext}`);
      fs.writeFileSync(junk, "this is not a database");
      expect((await verifyBackup(junk)).ok, ext).toBe(false);
    }
    expect((await verifyBackup(path.join(dir, "absent.tar.gz"))).ok).toBe(false);
  });

  it("names snapshots so they sort oldest to newest", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-26T01:00:00+08:00"));
    const first = await createBackup({ dir });
    vi.setSystemTime(new Date("2026-09-26T02:00:00+08:00"));
    const second = await createBackup({ dir });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(first.file.name < second.file.name).toBe(true);
    expect(second.file.takenAt).toBe("2026-09-26 02:00:00");
    // Newest first is what an operator wants to see.
    expect(listBackups(dir)[0].name).toBe(second.file.name);
  });
});

describe("two snapshots in the same second", () => {
  it("both kept, the later listed first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-26T03:00:00+08:00"));
    const first = await createBackup({ dir });
    const second = await createBackup({ dir });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.file.name).not.toBe(first.file.name);
    expect(second.file.takenAt).toBe(first.file.takenAt);
    expect(listBackups(dir).map((b) => b.name)).toEqual([second.file.name, first.file.name]);
  });
});

describe("keeping the folder tidy", () => {
  async function snapshotsAt(hours: number[]) {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (const h of hours) {
      vi.setSystemTime(new Date(`2026-09-26T${String(h).padStart(2, "0")}:00:00+08:00`));
      const made = await createBackup({ dir, keep: 99 });
      expect(made.ok).toBe(true);
    }
  }

  it("retires the oldest and keeps the rest", async () => {
    await snapshotsAt([1, 2, 3, 4, 5]);
    expect(listBackups(dir)).toHaveLength(5);

    const dropped = pruneBackups(2, dir);
    expect(dropped).toHaveLength(3);
    const left = listBackups(dir);
    expect(left).toHaveLength(2);
    // The two that survive are the newest two.
    expect(left.map((b) => b.takenAt)).toEqual(["2026-09-26 05:00:00", "2026-09-26 04:00:00"]);
  });

  it("prunes as part of taking one, without touching anything else", async () => {
    await snapshotsAt([1, 2, 3]);
    fs.writeFileSync(path.join(dir, "notes.txt"), "not a backup");

    vi.setSystemTime(new Date("2026-09-26T04:00:00+08:00"));
    const result = await createBackup({ dir, keep: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pruned).toHaveLength(2);
    expect(listBackups(dir)).toHaveLength(2);
    // Anything that is not a snapshot is none of its business.
    expect(fs.existsSync(path.join(dir, "notes.txt"))).toBe(true);
  });

  it("never prunes itself down to nothing", async () => {
    await snapshotsAt([1, 2]);
    expect(pruneBackups(0, dir)).toHaveLength(0);
    expect(listBackups(dir)).toHaveLength(2);
    expect(DEFAULT_KEEP).toBeGreaterThan(1);
  });
});

describe("how stale the newest one is", () => {
  it("reports nothing at all when there are no backups", () => {
    expect(hoursSinceLastBackup(dir)).toBeNull();
  });

  it("measures from the snapshot's own name", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-26T02:00:00+08:00"));
    expect((await createBackup({ dir })).ok).toBe(true);

    vi.setSystemTime(new Date("2026-09-26T08:00:00+08:00"));
    expect(hoursSinceLastBackup(dir)).toBeCloseTo(6, 1);
  });
});

describe("the photos with each snapshot (S10)", () => {
  /** A data folder of its own, with venue photos on disk as the app writes them. */
  function photosOnDisk(files: Record<string, string>): string {
    const data = fs.mkdtempSync(path.join(dir, "data-"));
    vi.stubEnv("MYSENAM_DATA_DIR", data);
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(data, "photos", name)), { recursive: true });
      fs.writeFileSync(path.join(data, "photos", name), content);
    }
    return path.join(data, "photos");
  }
  const backups = () => path.join(dir, "backups");

  it("are archived beside it, checked, and put back by the restore, with what was there kept aside", async () => {
    const photos = photosOnDisk({ "venues/1/abc-400.webp": "small", "venues/1/abc-1600.webp": "large", "venues/2/def-400.webp": "other", "venues/2/up.part": "half-written" });
    const result = await createBackup({ dir: backups() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.photos).toEqual({ file: photosArchiveOf(result.file.path), count: 3 });
    expect(fs.existsSync(photosArchiveOf(result.file.path))).toBe(true);
    // The archive is not mistaken for a snapshot of its own.
    expect(listBackups(backups()).map((b) => b.name)).toEqual([result.file.name]);

    // The photos are lost, and something else written in their place.
    fs.rmSync(photos, { recursive: true });
    fs.mkdirSync(photos);
    fs.writeFileSync(path.join(photos, "stray.webp"), "stray");

    const restored = await restorePhotos(result.file.path);
    expect(restored.photos).toBe(3);
    expect(fs.readFileSync(path.join(photos, "venues/1/abc-1600.webp"), "utf8")).toBe("large");
    expect(fs.readFileSync(path.join(photos, "venues/2/def-400.webp"), "utf8")).toBe("other");
    expect(fs.existsSync(path.join(photos, "stray.webp"))).toBe(false);
    // A half-written upload is not a photo, and is not kept.
    expect(fs.existsSync(path.join(photos, "venues/2/up.part"))).toBe(false);
    expect(restored.keptAside).not.toBeNull();
    expect(fs.readFileSync(path.join(restored.keptAside!, "stray.webp"), "utf8")).toBe("stray");
  });

  it("go when their snapshot is pruned", async () => {
    photosOnDisk({ "venues/1/abc-400.webp": "small" });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-26T01:00:00+08:00"));
    const first = await createBackup({ dir: backups(), keep: 99 });
    vi.setSystemTime(new Date("2026-09-26T02:00:00+08:00"));
    const second = await createBackup({ dir: backups(), keep: 99 });
    if (!first.ok || !second.ok) throw new Error("no backup");
    expect(pruneBackups(1, backups())).toEqual([first.file.name]);
    expect(fs.existsSync(photosArchiveOf(first.file.path))).toBe(false);
    expect(fs.existsSync(photosArchiveOf(second.file.path))).toBe(true);
  });

  it("fail the whole backup when they cannot be archived, leaving no snapshot that looks whole", async () => {
    photosOnDisk({ "venues/1/abc-400.webp": "small" });
    // A tar that fails, as a full disk or a broken archive would.
    const bin = fs.mkdtempSync(path.join(dir, "bin-"));
    fs.writeFileSync(path.join(bin, "tar"), "#!/bin/sh\necho 'tar: write error' >&2\nexit 2\n", { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
    const result = await createBackup({ dir: backups() });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Photos could not be archived/);
    expect(listBackups(backups())).toEqual([]);
    expect(fs.readdirSync(backups()).filter((f) => f.startsWith(".tmp-"))).toEqual([]);
  });

  it("need no archive when there are none, or when a bucket keeps them", async () => {
    photosOnDisk({});
    const none = await createBackup({ dir: backups() });
    expect(none.ok && none.photos).toEqual({ file: null, count: 0 });

    photosOnDisk({ "venues/1/abc-400.webp": "small" });
    for (const v of ["ENDPOINT", "BUCKET", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY"]) vi.stubEnv(`PHOTOS_S3_${v}`, "set");
    expect(localPhotosDir()).toBeNull();
    const bucketed = await createBackup({ dir: backups() });
    expect(bucketed.ok && bucketed.photos).toEqual({ file: null, count: 0 });
    expect((await restorePhotos(bucketed.ok ? bucketed.file.path : "")).photos).toBe(0);
  });
});
