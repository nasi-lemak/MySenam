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
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import { backupDir, createBackup, pgEnvironment, verifyBackup } from "../src/lib/backup.ts";
import { databaseLabel, databaseTarget, getDb } from "../src/lib/db.ts";

const run = promisify(execFile);
const args = process.argv.slice(2);
const source = args.find((a) => !a.startsWith("--"));
const force = args.includes("--force");

if (!source) {
  console.error("Usage: node scripts/restore.mjs <backup.dump | backup.tar.gz> --force");
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
console.log(`${source}: verified${verified.bookings === null ? "" : `, ${verified.bookings} bookings`}`);
console.log(`Would replace: ${databaseLabel()}`);
if (!force) {
  console.error("\nNothing done. Stop the app, then re-run with --force.");
  process.exit(1);
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

// Read it back through the app's own layer, which also brings an older
// snapshot's schema up to date.
const { n } = await getDb().prepare("SELECT COUNT(*) AS n FROM bookings").get();
await getDb().close();
console.log(`Restored: ${n} bookings. Start the app and check the Bookings tab for today.`);
