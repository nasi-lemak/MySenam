import { execFile } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { dataDirectory, databaseTarget, getDb } from "./db.ts";
import { isoOffset, region } from "./region.ts";

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
  /** Its manifest is there, and every part it names: a set that can be checked and restored whole. */
  complete: boolean;
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

// A second snapshot in the same second (a backup, then a restore keeping what
// was there) takes a -2 after the time rather than failing.
const NAME = /^mysenam-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})(?:-(\d+))?\.(dump|tar\.gz|db)$/;

/** Read the timestamp back out of a snapshot's name. */
function takenAtFrom(name: string): string {
  const m = name.match(NAME);
  if (!m) return "";
  const [, y, mo, d, h, mi, sec] = m;
  return `${y}-${mo}-${d} ${h}:${mi}:${sec}`;
}

/** Newest first; within a second, the later of the two first. */
function newerFirst(a: string, b: string): number {
  const seq = (name: string) => Number(name.match(NAME)?.[7] ?? 1);
  return takenAtFrom(b).localeCompare(takenAtFrom(a)) || seq(b) - seq(a);
}

function describe(dir: string, name: string): BackupFile {
  const full = path.join(dir, name);
  return { name, path: full, bytes: fs.statSync(full).size, takenAt: takenAtFrom(name), complete: partsPresent(full) };
}

/** The manifest of a backup set: what is in it, and each part's SHA-256. */
export function manifestOf(snapshot: string): string {
  return snapshot.replace(/\.(dump|tar\.gz)$/, ".manifest.json");
}

export interface BackupManifest {
  version: 1;
  createdAt: string;
  /** "postgres" (a pg_dump file) or "pglite" (a copy of its data folder). */
  engine: "postgres" | "pglite";
  database: { file: string; bytes: number; sha256: string };
  photos: { file: string; bytes: number; sha256: string; count: number } | null;
  bookings: number;
  /**
   * The erasure ledger's newest entry when the set was made (lib/erasure-ledger.ts): a record, off the
   * server with the set, of how far the ledger had reached, which a restore checks the ledger against.
   */
  erasureLedger?: { seq: number; hash: string };
}

const sha256Of = (file: string) =>
  new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });

function partsPresent(snapshot: string): boolean {
  try {
    const m = JSON.parse(fs.readFileSync(manifestOf(snapshot), "utf8")) as BackupManifest;
    return fs.existsSync(snapshot) && (!m.photos || fs.existsSync(path.join(path.dirname(snapshot), m.photos.file)));
  } catch {
    return false;
  }
}

/** Written last, once every part is in place: a manifest beside a snapshot means the set is whole. */
async function writeManifest(snapshot: string, info: { engine: BackupManifest["engine"]; bookings: number; photos: number }): Promise<string> {
  const archive = photosArchiveOf(snapshot);
  // The ledger beside the backups is there from the first backup on, so a restore on this server knows it is whole.
  const ledger = await import("./erasure-ledger.ts");
  ledger.ensureLedgerFile();
  const head = await ledger.ledgerHead().catch(() => null);
  const manifest: BackupManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    engine: info.engine,
    database: { file: path.basename(snapshot), bytes: fs.statSync(snapshot).size, sha256: await sha256Of(snapshot) },
    photos:
      info.photos > 0
        ? { file: path.basename(archive), bytes: fs.statSync(archive).size, sha256: await sha256Of(archive), count: info.photos }
        : null,
    bookings: info.bookings,
    ...(head ? { erasureLedger: { seq: head.seq, hash: head.hash } } : {}),
  };
  const file = manifestOf(snapshot);
  const temporary = path.join(path.dirname(file), `.tmp-${path.basename(file)}`);
  fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2));
  fs.renameSync(temporary, file);
  return file;
}

export type SetCheck = { ok: true; manifest: BackupManifest | null; warnings: string[] } | { ok: false; problems: string[] };

/**
 * Is this backup set whole and unchanged since it was taken? Each part its
 * manifest names must be there and hash to what was written down. A set with
 * no manifest (taken before they were written) is allowed, with a warning:
 * nothing can say whether its photos belong with it.
 */
export async function verifyBackupSet(snapshot: string): Promise<SetCheck> {
  if (!fs.existsSync(snapshot)) return { ok: false, problems: [`${path.basename(snapshot)} is not there.`] };
  const file = manifestOf(snapshot);
  if (!fs.existsSync(file)) return { ok: true, manifest: null, warnings: ["No manifest (an older backup): its parts cannot be checked against each other."] };
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, "utf8")) as BackupManifest;
  } catch {
    return { ok: false, problems: ["The manifest cannot be read."] };
  }
  const problems: string[] = [];
  if (manifest.database.file !== path.basename(snapshot)) problems.push(`The manifest is for ${manifest.database.file}, not ${path.basename(snapshot)}.`);
  else if ((await sha256Of(snapshot)) !== manifest.database.sha256) problems.push(`${manifest.database.file} is not what was backed up (its SHA-256 differs).`);
  if (manifest.photos) {
    const archive = path.join(path.dirname(snapshot), manifest.photos.file);
    if (!fs.existsSync(archive)) problems.push(`Its photos (${manifest.photos.file}) are missing.`);
    else if ((await sha256Of(archive)) !== manifest.photos.sha256) problems.push(`${manifest.photos.file} is not what was backed up (its SHA-256 differs).`);
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, manifest, warnings: [] };
}

/** Snapshots on disk, newest first. */
export function listBackups(dir = backupDir()): BackupFile[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => takenAtFrom(f) !== "")
    .sort(newerFirst)
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
const MUST_HAVE = ["venues", "courts", "bookings", "claims", "users", "wallet_entries"];

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

/**
 * Venue photos kept on this server's disk (no PHOTOS_S3_* bucket) are files,
 * not rows, so the database snapshot does not hold them (known limitations
 * S10). Each snapshot then has a companion archive of the photos folder
 * beside it, taken and checked with it, pruned with it, copied off-site with
 * it and put back by the restore. With a bucket, photos are the bucket's to
 * keep (versioning or the provider's own backups), and there is no companion.
 */
export function localPhotosDir(): string | null {
  const bucketed =
    process.env.PHOTOS_S3_ENDPOINT && process.env.PHOTOS_S3_BUCKET && process.env.PHOTOS_S3_ACCESS_KEY_ID && process.env.PHOTOS_S3_SECRET_ACCESS_KEY;
  return bucketed ? null : path.join(dataDirectory(), "photos");
}

/** The photos archive that goes with a snapshot. */
export function photosArchiveOf(snapshot: string): string {
  return snapshot.replace(/\.(dump|tar\.gz)$/, ".photos.tar.gz");
}

/** Every photo file under a folder, as paths relative to it. */
function photoFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return (fs.readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => !f.endsWith(".part") && fs.statSync(path.join(dir, f)).isFile())
    .map((f) => f.split(path.sep).join("/"))
    .sort();
}

/** Archive the photos folder beside a snapshot, and read the archive back: the same files, or no archive. */
async function archivePhotos(snapshot: string): Promise<{ ok: true; photos: number } | { ok: false; error: string }> {
  const dir = localPhotosDir();
  const files = dir ? photoFiles(dir) : [];
  if (!dir || files.length === 0) return { ok: true, photos: 0 };
  const archive = photosArchiveOf(snapshot);
  const temporary = path.join(path.dirname(archive), `.tmp-${path.basename(archive)}`);
  try {
    fs.rmSync(temporary, { force: true });
    // The folder, not a list of its files: tens of thousands of names would not fit on a command line.
    await run("tar", ["-czf", temporary, "--exclude=*.part", "-C", dir, "."], { maxBuffer: 16 * 1024 * 1024 });
    const { stdout } = await run("tar", ["-tzf", temporary], { maxBuffer: 64 * 1024 * 1024 });
    const listed = new Set(stdout.split("\n").filter((l) => l && !l.endsWith("/")).map((l) => l.replace(/^\.\//, "")));
    // Every photo there was is in it (one deleted meanwhile need not be; one uploaded meanwhile is a bonus).
    const missing = files.filter((f) => !listed.has(f) && fs.existsSync(path.join(dir, f)));
    if (missing.length > 0) throw new Error(`the photos archive is missing ${missing.length} of ${files.length} files`);
    fs.renameSync(temporary, archive);
    return { ok: true, photos: listed.size };
  } catch (err) {
    fs.rmSync(temporary, { force: true });
    return { ok: false, error: `Photos could not be archived: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
  }
}

/** Put a snapshot's photos back, keeping what was there aside. Nothing to do when it has none. */
export async function restorePhotos(snapshot: string): Promise<{ photos: number; keptAside: string | null }> {
  const archive = photosArchiveOf(snapshot);
  const dir = localPhotosDir();
  if (!dir || !fs.existsSync(archive)) return { photos: 0, keptAside: null };
  let keptAside: string | null = null;
  if (fs.existsSync(dir)) {
    keptAside = `${dir}.replaced-${Date.now()}`;
    fs.renameSync(dir, keptAside);
  }
  fs.mkdirSync(dir, { recursive: true });
  await run("tar", ["-xzf", archive, "-C", dir], { maxBuffer: 16 * 1024 * 1024 });
  return { photos: photoFiles(dir).length, keptAside };
}

/** Drop all but the newest `keep` snapshots, and their photos. Returns what it deleted. */
export function pruneBackups(keep = DEFAULT_KEEP, dir = backupDir()): string[] {
  if (keep < 1) return [];
  const dropped: string[] = [];
  for (const backup of listBackups(dir).slice(keep)) {
    fs.unlinkSync(backup.path);
    fs.rmSync(photosArchiveOf(backup.path), { force: true });
    fs.rmSync(manifestOf(backup.path), { force: true });
    dropped.push(backup.name);
  }
  return dropped;
}

export type BackupResult =
  | { ok: true; file: BackupFile; bookings: number; pruned: string[]; photos: { file: string | null; count: number }; manifest: string }
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

  const extension = target.kind === "postgres" ? "dump" : "tar.gz";
  const now = new Date();
  let name = snapshotName(extension, now);
  for (let n = 2; fs.existsSync(path.join(dir, name)) && n < 100; n++)
    name = snapshotName(extension, now).replace(`.${extension}`, `-${n}.${extension}`);
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

  // The photos with it, or no backup: a snapshot whose photos are missing is not a whole one.
  const photos = await archivePhotos(final);
  if (!photos.ok) {
    fs.rmSync(temporary, { force: true });
    return { ok: false, error: photos.error };
  }

  fs.renameSync(temporary, final);
  // A pg_dump file is read back rather than restored, so its count comes from
  // the database it was taken from.
  const bookings =
    verified.bookings ??
    Number(((await getDb().prepare("SELECT COUNT(*) AS n FROM bookings").get()) as { n: number }).n);
  const manifest = await writeManifest(final, { engine: target.kind === "postgres" ? "postgres" : "pglite", bookings, photos: photos.photos });
  return {
    ok: true,
    file: describe(dir, name),
    bookings,
    pruned: pruneBackups(keep, dir),
    photos: { file: photos.photos > 0 ? photosArchiveOf(final) : null, count: photos.photos },
    manifest,
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

export interface DrillReport {
  ok: boolean;
  problems: string[];
  warnings: string[];
  /** What came back, counted in the restored copy. */
  counts: Record<string, number>;
  photos: number;
  /** Venues' payment keys in the copy that this install's secret can open; the secret is not in any backup. */
  paymentKeys: { readable: number; unreadable: number };
  ms: number;
}

/**
 * Restore a backup set somewhere it can do no harm and look at what comes
 * back: a database of its own beside the live one on a Postgres server
 * (dropped afterwards), or a PGlite copy in a temporary folder; its photos
 * unpacked into a temporary folder. The live database and photos are never
 * touched. This is the check that a backup can actually be restored, and
 * how long it takes.
 */
export async function restoreDrill(snapshot: string): Promise<DrillReport> {
  const started = Date.now();
  const report: DrillReport = { ok: false, problems: [], warnings: [], counts: {}, photos: 0, paymentKeys: { readable: 0, unreadable: 0 }, ms: 0 };
  const set = await verifyBackupSet(snapshot);
  if (!set.ok) return { ...report, problems: set.problems, ms: Date.now() - started };
  report.warnings.push(...set.warnings);
  const COUNTED = ["venues", "courts", "bookings", "claims", "users", "wallet_entries", "online_payments", "receipts", "venue_photos"];
  let credentials: string[] = [];
  const target = databaseTarget();
  try {
    if (snapshot.endsWith(".dump")) {
      if (target.kind !== "postgres") throw new Error("A .dump is restored to a Postgres server: set DATABASE_URL to one (the drill uses a database of its own there).");
      const pg = (await import("pg")).default;
      const scratch = `mysenam_drill_${Date.now()}_${process.pid}`;
      const admin = new pg.Client({ connectionString: target.url });
      await admin.connect();
      try {
        await admin.query(`CREATE DATABASE ${scratch}`);
        try {
          const env = { ...pgEnvironment(target.url), PGDATABASE: scratch };
          await run(pgRestore(), ["--no-owner", "--no-privileges", "--exit-on-error", "--dbname", scratch, snapshot], { env, maxBuffer: 64 * 1024 * 1024 });
          const url = new URL(target.url);
          url.pathname = `/${scratch}`;
          const copy = new pg.Client({ connectionString: url.toString() });
          await copy.connect();
          try {
            for (const t of COUNTED) report.counts[t] = Number((await copy.query(`SELECT COUNT(*)::int AS n FROM ${t}`)).rows[0].n);
            // Court time moved to the archive (migration 0267): a backup from before it has no such table.
            if ((await copy.query("SELECT to_regclass('claims_archive')::text AS t")).rows[0].t) report.counts.claims_archive = Number((await copy.query("SELECT COUNT(*)::int AS n FROM claims_archive")).rows[0].n);
            credentials = (await copy.query("SELECT credentials FROM venue_payment_accounts")).rows.map((r: { credentials: string }) => r.credentials);
          } finally {
            await copy.end();
          }
        } finally {
          await admin.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
        }
      } finally {
        await admin.end();
      }
    } else {
      const { PGlite, types } = await import("@electric-sql/pglite");
      const { citext } = await import("@electric-sql/pglite/contrib/citext");
      const copy = await PGlite.create({ loadDataDir: new Blob([fs.readFileSync(snapshot)]), extensions: { citext }, parsers: { [types.INT8]: (v: string) => Number(v) } });
      try {
        for (const t of COUNTED) report.counts[t] = Number((await copy.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${t}`)).rows[0].n);
        if ((await copy.query<{ t: string | null }>("SELECT to_regclass('claims_archive')::text AS t")).rows[0].t)
          report.counts.claims_archive = Number((await copy.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM claims_archive")).rows[0].n);
        credentials = (await copy.query<{ credentials: string }>("SELECT credentials FROM venue_payment_accounts")).rows.map((r) => r.credentials);
      } finally {
        await copy.close();
      }
    }
  } catch (err) {
    report.problems.push(`The database did not restore: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  }
  if (set.manifest && report.counts.bookings !== undefined && report.counts.bookings !== set.manifest.bookings)
    report.problems.push(`${report.counts.bookings} bookings came back; the manifest says ${set.manifest.bookings} were backed up.`);

  // The photos, unpacked aside and counted against the manifest.
  const archive = photosArchiveOf(snapshot);
  if (fs.existsSync(archive)) {
    const aside = fs.mkdtempSync(path.join(os.tmpdir(), "mysenam-drill-photos-"));
    try {
      await run("tar", ["-xzf", archive, "-C", aside], { maxBuffer: 16 * 1024 * 1024 });
      report.photos = photoFiles(aside).length;
      if (set.manifest?.photos && report.photos !== set.manifest.photos.count)
        report.problems.push(`${report.photos} photos came back; the manifest says ${set.manifest.photos.count}.`);
    } catch (err) {
      report.problems.push(`The photos did not unpack: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    } finally {
      fs.rmSync(aside, { recursive: true, force: true });
    }
  }

  // Payment keys are sealed with this install's secret, which no backup holds.
  const { unseal } = await import("./secrets.ts");
  for (const raw of credentials) {
    let readable = true;
    try {
      const fields = JSON.parse(raw) as Record<string, unknown>;
      for (const v of Object.values(fields)) if (typeof v === "string" && v.startsWith("v1:") && unseal(v) === null) readable = false;
    } catch {
      readable = false;
    }
    if (readable) report.paymentKeys.readable++;
    else report.paymentKeys.unreadable++;
  }
  if (report.paymentKeys.unreadable > 0)
    report.warnings.push(
      `${report.paymentKeys.unreadable} venue payment key(s) cannot be opened with this install's secret (MYSENAM_SECRET or secret.key): restore that secret too, or venues reconnect their gateways.`
    );
  report.ok = report.problems.length === 0;
  report.ms = Date.now() - started;
  return report;
}
