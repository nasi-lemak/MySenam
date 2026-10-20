import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { dataDirectory, databaseTarget, getDb } from "./db.ts";
import { isoOffset, region } from "./region";

const run = promisify(execFile);

/**
 * Backups.
 *
 * Everything a venue has — its bookings, its ledger, who opened which door —
 * is in one database. A crashed box or a mistyped command takes all of it, so
 * taking copies is not an optional extra: it is the difference between
 * software a venue can run on and a demo.
 *
 * On a Postgres server a backup is `pg_dump` in its custom format: consistent
 * while the app keeps serving, and restored with `pg_restore`. On PGlite —
 * development and the demo — it is PGlite's own copy of its data folder.
 * Either way the copy is checked before it is kept, written under a temporary
 * name and renamed only once it has passed, so an interrupted or broken backup
 * never sits beside the good ones looking like one.
 */

/** How many snapshots to keep before the oldest are dropped. */
export const DEFAULT_KEEP = 14;

export interface BackupFile {
  name: string;
  path: string;
  bytes: number;
  /** When the snapshot was taken, from its own filename, in local time. */
  takenAt: string;
}

export function backupDir(): string {
  return process.env.MYSENAM_BACKUP_DIR || path.join(dataDirectory(), "backups");
}

/** `mysenam-2026-09-26-021400.dump`, in local time, so the name sorts and reads. */
function snapshotName(extension: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: region().timeZone,
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
  return `mysenam-${parts.year}-${parts.month}-${parts.day}-${hour}${parts.minute}${parts.second}.${extension}`;
}

const NAME = /^mysenam-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})\.(dump|tar\.gz|db)$/;

/** Read the timestamp back out of a snapshot's name. */
function takenAtFrom(name: string): string {
  const m = name.match(NAME);
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
    .sort((a, b) => takenAtFrom(b).localeCompare(takenAtFrom(a)))
    .map((name) => describe(dir, name));
}

/**
 * The connection details for pg_dump and pg_restore, as environment
 * variables — so the password is never on a command line, where anybody on
 * the machine could read it from the process list.
 */
export function pgEnvironment(url: string): NodeJS.ProcessEnv {
  const u = new URL(url);
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (u.hostname) env.PGHOST = decodeURIComponent(u.hostname);
  if (u.port) env.PGPORT = u.port;
  if (u.username) env.PGUSER = decodeURIComponent(u.username);
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (database) env.PGDATABASE = database;
  const host = u.searchParams.get("host");
  if (host) env.PGHOST = host;
  const sslmode = u.searchParams.get("sslmode");
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}

const pgDump = () => process.env.MYSENAM_PG_DUMP || "pg_dump";
const pgRestore = () => process.env.MYSENAM_PG_RESTORE || "pg_restore";

/** Tables a real backup must contain; a dump without them is not one. */
const MUST_HAVE = ["venues", "courts", "bookings", "booking_slots", "users", "wallet_entries"];

export type VerifyResult = { ok: true; bookings: number | null } | { ok: false; error: string };

/**
 * Is this file a backup we could actually restore from?
 *
 * A backup nobody has read is a guess. A pg_dump file is read back by
 * pg_restore, and must list the tables that hold the business; a PGlite copy
 * is loaded into a fresh PGlite and its bookings counted.
 */
export async function verifyBackup(file: string): Promise<VerifyResult> {
  try {
    if (file.endsWith(".dump")) {
      const { stdout } = await run(pgRestore(), ["--list", file], { maxBuffer: 64 * 1024 * 1024 });
      const missing = MUST_HAVE.filter((t) => !new RegExp(`TABLE DATA public ${t} `).test(stdout));
      if (missing.length > 0) return { ok: false, error: `The backup has no data for ${missing.join(", ")}.` };
      return { ok: true, bookings: null };
    }
    if (file.endsWith(".tar.gz")) {
      const { PGlite, types } = await import("@electric-sql/pglite");
      const { citext } = await import("@electric-sql/pglite/contrib/citext");
      const data = fs.readFileSync(file);
      const copy = await PGlite.create({
        loadDataDir: new Blob([data]),
        extensions: { citext },
        parsers: { [types.INT8]: (v: string) => Number(v) },
      });
      try {
        const { rows } = await copy.query<{ n: number }>("SELECT COUNT(*) AS n FROM bookings");
        return { ok: true, bookings: Number(rows[0].n) };
      } finally {
        await copy.close();
      }
    }
    return { ok: false, error: "Not a backup this install can read." };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.split("\n")[0] : "Unreadable backup" };
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

/** Take a snapshot, check it, and retire the oldest. */
export async function createBackup(opts: { dir?: string; keep?: number } = {}): Promise<BackupResult> {
  const dir = opts.dir ?? backupDir();
  const keep = opts.keep ?? Number(process.env.MYSENAM_BACKUP_KEEP ?? DEFAULT_KEEP);
  const target = databaseTarget();

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Cannot create backup folder" };
  }

  const name = snapshotName(target.kind === "postgres" ? "dump" : "tar.gz");
  const final = path.join(dir, name);
  // The temporary name keeps the real extension last, so the checks that go by
  // it still know what the file is.
  const temporary = path.join(dir, `.tmp-${name}`);
  if (fs.existsSync(final)) return { ok: false, error: `${name} already exists.` };

  try {
    fs.rmSync(temporary, { force: true });
    if (target.kind === "postgres") {
      await run(pgDump(), ["--format=custom", "--no-owner", "--no-privileges", "--file", temporary], {
        env: pgEnvironment(target.url),
        maxBuffer: 16 * 1024 * 1024,
      });
    } else {
      fs.writeFileSync(temporary, await getDb().dumpDataDir());
    }
  } catch (err) {
    fs.rmSync(temporary, { force: true });
    const message = err instanceof Error ? err.message.split("\n")[0] : "Backup failed";
    return {
      ok: false,
      error: /ENOENT/.test(message) ? "pg_dump is not installed on this machine (apt install postgresql-client)." : message,
    };
  }

  const verified = await verifyBackup(temporary);
  if (!verified.ok) {
    fs.rmSync(temporary, { force: true });
    return { ok: false, error: verified.error };
  }

  fs.renameSync(temporary, final);
  // A pg_dump file is read back rather than restored, so its count comes from
  // the database it was taken from.
  const bookings =
    verified.bookings ??
    Number(((await getDb().prepare("SELECT COUNT(*) AS n FROM bookings").get()) as { n: number }).n);
  return {
    ok: true,
    file: describe(dir, name),
    bookings,
    pruned: pruneBackups(keep, dir),
  };
}

/** How long ago the newest snapshot was taken, in hours. null when there are none. */
export function hoursSinceLastBackup(dir = backupDir()): number | null {
  const [newest] = listBackups(dir);
  if (!newest || newest.takenAt === "") return null;
  // takenAt is local time; the offset is fixed (no DST), so nothing to reason about.
  const taken = Date.parse(`${newest.takenAt.replace(" ", "T")}${isoOffset()}`);
  return Number.isNaN(taken) ? null : (Date.now() - taken) / 3_600_000;
}
