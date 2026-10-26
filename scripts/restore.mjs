#!/usr/bin/env node
/**
 * Put a snapshot back. This replaces everything in the live database, so it
 * asks to be told twice: name the file, and pass --force.
 *
 *   node scripts/restore.mjs data/backups/mysenam-2026-09-26-030000.dump --force
 *
 * Stop the app first (systemctl stop mysenam).
 *
 * A .dump (pg_dump) goes back into the Postgres server in DATABASE_URL, in one
 * transaction: it all goes back or none of it does. A .tar.gz (PGlite) goes
 * back as the PGlite data folder. Either way, what was there is kept first —
 * a fresh snapshot of the server, or the old folder moved aside — because the
 * worst restore is the one that turns out to have been the wrong file.
 *
 * A .db file is from the SQLite version of MySenam: bring that across with
 * `npm run import-sqlite` instead.
 *
 * Before anything is replaced, the set is checked against its manifest: the
 * database and its photos must both be there and unchanged since they were
 * taken. And while an app instance is still running against this database
 * (it renews the scheduler's lease every minute) nothing is replaced unless
 * --app-stopped says it has really stopped.
 *
 * A snapshot holds accounts erased and records retention removed since it was
 * taken. The restored database is marked, and the app, when it next starts and
 * before it serves anything, erases again the accounts in the erasure ledger
 * beside the backups and runs the retention policy (src/lib/erasure-ledger.ts).
 *
 *   node scripts/restore.mjs <backup> --drill
 *
 * restores it somewhere it can do no harm instead — a database of its own on
 * the Postgres server in DATABASE_URL, dropped afterwards, or a temporary
 * PGlite copy — counts what came back against the manifest, and says how long
 * it took. The live database and photos are not touched.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { backupDir, createBackup, pgEnvironment, restoreDrill, restorePhotos, verifyBackup, verifyBackupSet } from "../src/lib/backup.ts";
import { databaseLabel, databaseTarget, getDb } from "../src/lib/db.ts";

const run = promisify(execFile);
const args = process.argv.slice(2);
const source = args.find((a) => !a.startsWith("--"));
const force = args.includes("--force");
const drill = args.includes("--drill");

if (!source) {
  console.error("Usage: node scripts/restore.mjs <backup.dump | backup.tar.gz> --force | --drill");
  process.exit(1);
}
if (!fs.existsSync(source)) {
  console.error(`No such backup: ${source}`);
  process.exit(1);
}
if (source.endsWith(".db")) {
  console.error("That is a backup from the SQLite version of MySenam. Bring it across with:\n");
  console.error(`  npm run import-sqlite -- ${source}`);
  process.exit(1);
}

if (drill) {
  const report = await restoreDrill(source);
  for (const w of report.warnings) console.log(`warning: ${w}`);
  console.log(
    `Restored aside in ${(report.ms / 1000).toFixed(1)} s: ` +
      Object.entries(report.counts).map(([t, n]) => `${n} ${t}`).join(", ") +
      `; ${report.photos} photos; payment keys readable ${report.paymentKeys.readable}, unreadable ${report.paymentKeys.unreadable}.`
  );
  if (!report.ok) {
    console.error(`The drill failed:\n  ${report.problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log("Drill passed. Nothing live was touched.");
  process.exit(0);
}

const target = databaseTarget();
const wanted = target.kind === "postgres" ? ".dump" : ".tar.gz";
if (!source.endsWith(wanted)) {
  console.error(
    target.kind === "postgres"
      ? "The database is a Postgres server, which restores from a .dump (pg_dump) file."
      : "The database is PGlite, which restores from a .tar.gz copy of its data folder."
  );
  process.exit(1);
}
if (target.kind === "pglite" && target.dir === null) {
  console.error("The database is in memory (MYSENAM_DB=:memory:); there is nowhere to restore to.");
  process.exit(1);
}

// Refuse anything that is not a backup we could serve from.
const verified = await verifyBackup(source);
if (!verified.ok) {
  console.error(`That file is not a backup this install can restore: ${verified.error}`);
  process.exit(1);
}
// And that its parts belong together and are as they were backed up.
const set = await verifyBackupSet(source);
if (!set.ok) {
  console.error(`That backup set is not whole, so nothing was restored:\n  ${set.problems.join("\n  ")}`);
  process.exit(1);
}
for (const w of set.warnings) console.log(`warning: ${w}`);
console.log(`${source}: verified${verified.bookings === null ? "" : `, ${verified.bookings} bookings`}`);
console.log(`Would replace: ${databaseLabel()}`);
if (!force) {
  console.error("\nNothing done. Stop the app, then re-run with --force.");
  process.exit(1);
}

// An instance still running against this database renews the scheduler's
// lease (lib/scheduler.ts) every minute: restoring under it would mix its
// writes into the restored data.
if (!args.includes("--app-stopped")) {
  const lease = await getDb().prepare("SELECT value FROM settings WHERE key = 'scheduler_lease'").get();
  const [holder, until] = (lease?.value ?? "").split("|");
  if (Number(until) > Date.now()) {
    await getDb().close();
    console.error(
      `An app instance (${holder}) looks to be running against this database: it held the scheduler's lease until ${new Date(Number(until)).toISOString()}.\n` +
        "Nothing done. Stop every instance; then wait three minutes for the lease to run out, or re-run with --app-stopped if you are sure."
    );
    process.exit(1);
  }
  // PGlite is one process's database: let go of it before its folder is replaced.
  if (target.kind === "pglite") await getDb().close();
}

if (target.kind === "postgres") {
  // What is there now, kept first.
  const before = await createBackup({ dir: backupDir(), keep: Number.MAX_SAFE_INTEGER });
  await getDb().close();
  if (!before.ok) {
    console.error(`Could not keep a copy of what is there now, so nothing was restored: ${before.error}`);
    process.exit(1);
  }
  console.log(`What was there is kept in ${before.file.path}`);
  const env = pgEnvironment(target.url);
  try {
    // Without --dbname pg_restore only prints the SQL; the rest of the
    // connection comes from the environment, as for pg_dump.
    await run(
      process.env.MYSENAM_PG_RESTORE || "pg_restore",
      [
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-privileges",
        "--single-transaction",
        "--exit-on-error",
        "--dbname",
        env.PGDATABASE,
        source,
      ],
      { env, maxBuffer: 64 * 1024 * 1024 }
    );
  } catch (err) {
    console.error(`Restore failed, and was rolled back: ${(err.stderr || err.message).trim()}`);
    process.exit(1);
  }
} else {
  const { PGlite } = await import("@electric-sql/pglite");
  const { citext } = await import("@electric-sql/pglite/contrib/citext");
  if (fs.existsSync(target.dir)) {
    const aside = `${target.dir}.replaced-${Date.now()}`;
    fs.renameSync(target.dir, aside);
    console.log(`What was there is kept in ${aside}`);
  }
  const db = await PGlite.create({
    dataDir: target.dir,
    loadDataDir: new Blob([fs.readFileSync(source)]),
    extensions: { citext },
  });
  await db.close();
}

// The photos that went with it, where photos are kept on this server.
const photos = await restorePhotos(source);
if (photos.keptAside) console.log(`The photos that were there are kept in ${photos.keptAside}`);
// Read it back through the app's own layer, which also brings an older
// snapshot's schema up to date.
const { n } = await getDb().prepare("SELECT COUNT(*) AS n FROM bookings").get();
// What retention and erasure removed since this backup must not come back:
// the app applies the erasures recorded since (lib/erasure-ledger.ts) and the
// retention policy again when it next starts, before it serves anything.
await getDb()
  .prepare("INSERT INTO settings (key, value) VALUES ('restore_reapply_due', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
  .run(path.basename(source));
const ledger = path.join(backupDir(), "erasure-ledger.jsonl");
const erasures = fs.existsSync(ledger) ? fs.readFileSync(ledger, "utf8").split("\n").filter((l) => l.trim()).length : 0;
await getDb().close();
console.log(`Restored: ${n} bookings, ${photos.photos} photos. Start the app and check the Bookings tab for today.`);
console.log(
  `When it starts, the app applies again the ${erasures} erasure(s) in the ledger beside the backups and the retention policy, before it serves anything.`
);
