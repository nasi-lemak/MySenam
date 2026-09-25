import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { databaseFile, getDb } from "./db";

/**
 * Backups.
 *
 * Everything a venue has — its bookings, its ledger, who opened which door —
 * is one file. A crashed box or a mistyped command takes all of it, so taking
 * copies is not an optional extra: it is the difference between software a
 * venue can run on and a demo.
 *
 * `VACUUM INTO` is what makes this simple. It writes a consistent snapshot of
 * the live database from inside SQLite, while the app keeps serving, without
 * the half-copied WAL that `cp` would give you.
 */

/** How many snapshots to keep before the oldest are dropped. */
export const DEFAULT_KEEP = 14;

export interface BackupFile {
  name: string;
  path: string;
  bytes: number;
  /** When the snapshot was taken, from its own filename, in Malaysia time. */
  takenAt: string;
}

export function backupDir(): string {
  const configured = process.env.MYSENAM_BACKUP_DIR;
  if (configured) return configured;
  const db = databaseFile();
  // Beside the database by default, which is the directory an operator
  // already knows to look after.
  return db === ":memory:"
    ? path.join(process.cwd(), "data", "backups")
    : path.join(path.dirname(db), "backups");
}

/** `mysenam-2026-09-26-0214.db`, in Malaysia time, so the name sorts and reads. */
function snapshotName(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .formatToParts(now)
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  // Intl gives 24 for midnight in some runtimes; the date has already rolled.
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return `mysenam-${parts.year}-${parts.month}-${parts.day}-${hour}${parts.minute}${parts.second}.db`;
}

/** Read the timestamp back out of a snapshot's name. */
function takenAtFrom(name: string): string {
  const m = name.match(/^mysenam-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})\.db$/);
  if (!m) return "";
  const [, y, mo, d, h, mi, sec] = m;
  return `${y}-${mo}-${d} ${h}:${mi}:${sec}`;
}

function describe(dir: string, name: string): BackupFile {
  const full = path.join(dir, name);
  return { name, path: full, bytes: fs.statSync(full).size, takenAt: takenAtFrom(name) };
}

/** Snapshots on disk, newest first. */
export function listBackups(dir = backupDir()): BackupFile[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => takenAtFrom(f) !== "")
    .sort()
    .reverse()
    .map((name) => describe(dir, name));
}

/**
 * Is this file a database we could actually restore from?
 *
 * A backup nobody has read is a guess. This opens the snapshot, runs SQLite's
 * own integrity check and counts a table that must exist, so a truncated or
 * corrupt file is caught while there is still a good one beside it.
 */
export function verifyBackup(file: string): { ok: true; bookings: number } | { ok: false; error: string } {
  let snapshot: Database.Database | null = null;
  try {
    snapshot = new Database(file, { readonly: true, fileMustExist: true });
    const [{ integrity_check: result }] = snapshot.pragma("integrity_check") as {
      integrity_check: string;
    }[];
    if (result !== "ok") return { ok: false, error: `Integrity check failed: ${result}` };
    const { n } = snapshot.prepare("SELECT COUNT(*) AS n FROM bookings").get() as { n: number };
    return { ok: true, bookings: n };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Unreadable backup" };
  } finally {
    snapshot?.close();
  }
}

/** Drop all but the newest `keep` snapshots. Returns what it deleted. */
export function pruneBackups(keep = DEFAULT_KEEP, dir = backupDir()): string[] {
  if (keep < 1) return [];
  const dropped: string[] = [];
  for (const backup of listBackups(dir).slice(keep)) {
    fs.unlinkSync(backup.path);
    dropped.push(backup.name);
  }
  return dropped;
}

export type BackupResult =
  | { ok: true; file: BackupFile; bookings: number; pruned: string[] }
  | { ok: false; error: string };

/**
 * Take a snapshot, check it, and retire the oldest.
 *
 * It writes to a `.tmp` name and renames on success, so an interrupted backup
 * never leaves behind a half-file that looks like a good one.
 */
export function createBackup(opts: { dir?: string; keep?: number } = {}): BackupResult {
  const dir = opts.dir ?? backupDir();
  const keep = opts.keep ?? Number(process.env.MYSENAM_BACKUP_KEEP ?? DEFAULT_KEEP);

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Cannot create backup folder" };
  }

  const name = snapshotName();
  const target = path.join(dir, name);
  const temporary = `${target}.tmp`;
  if (fs.existsSync(target)) return { ok: false, error: `${name} already exists.` };

  try {
    fs.rmSync(temporary, { force: true });
    // Consistent snapshot from inside SQLite, taken while the app serves.
    getDb().prepare("VACUUM INTO ?").run(temporary);
  } catch (err) {
    fs.rmSync(temporary, { force: true });
    return { ok: false, error: err instanceof Error ? err.message : "Backup failed" };
  }

  const verified = verifyBackup(temporary);
  if (!verified.ok) {
    fs.rmSync(temporary, { force: true });
    return { ok: false, error: verified.error };
  }

  fs.renameSync(temporary, target);
  return {
    ok: true,
    file: describe(dir, name),
    bookings: verified.bookings,
    pruned: pruneBackups(keep, dir),
  };
}

/** How long ago the newest snapshot was taken, in hours. null when there are none. */
export function hoursSinceLastBackup(dir = backupDir()): number | null {
  const [newest] = listBackups(dir);
  if (!newest || newest.takenAt === "") return null;
  // takenAt is Malaysia time; UTC+8 is fixed, so no DST to reason about.
  const taken = Date.parse(`${newest.takenAt.replace(" ", "T")}+08:00`);
  return Number.isNaN(taken) ? null : (Date.now() - taken) / 3_600_000;
}
