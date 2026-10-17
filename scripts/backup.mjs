#!/usr/bin/env node
/**
 * Take a snapshot of the database. The app already takes one every night on
 * its own schedule; this is for cron on a box where you would rather the
 * operating system did it, and for "take one now, before I touch anything":
 *
 *   15 3 * * *  cd /srv/mysenam && npm run backup >> /var/log/mysenam-backup.log 2>&1
 *
 * On a Postgres server (DATABASE_URL=postgres://…) the snapshot is pg_dump's
 * custom format, read back by pg_restore before it is kept. On PGlite it is a
 * copy of the data folder — and PGlite is one process's database, so stop the
 * app first and say so with --app-stopped; while it runs, use the Backup
 * button in its settings instead.
 *
 * Exits non-zero if the snapshot could not be taken or did not verify, so a
 * failing backup shows up as a failing job rather than a quiet no-op.
 *
 * Usage: node scripts/backup.mjs [--dir PATH] [--keep N] [--app-stopped]
 */
import { backupDir, createBackup } from "../src/lib/backup.ts";
import { databaseLabel, databaseTarget, getDb } from "../src/lib/db.ts";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
}

const target = databaseTarget();
if (target.kind === "pglite" && target.dir === null) {
  console.error("The database is in memory (MYSENAM_DB=:memory:); there is nothing on disk to back up.");
  process.exit(1);
}
if (target.kind === "pglite" && !args.includes("--app-stopped")) {
  console.error(
    `${databaseLabel()} can only be opened by one process at a time.\n` +
      "While the app is running, take a backup from its settings (or let its nightly one run).\n" +
      "With the app stopped, re-run with --app-stopped."
  );
  process.exit(1);
}

const dir = flag("dir", backupDir());
const keep = Number(flag("keep", process.env.MYSENAM_BACKUP_KEEP ?? 14));

try {
  // Opening it brings the schema up to date, so even a brand-new database
  // has the tables a backup is checked for.
  await getDb().prepare("SELECT 1").get();
  const result = await createBackup({ dir, keep });
  if (!result.ok) {
    console.error(`Backup failed: ${result.error}`);
    process.exitCode = 1;
  } else {
    console.log(`${result.file.name} — ${(result.file.bytes / 1024).toFixed(0)} KB, ${result.bookings} bookings`);
    for (const old of result.pruned) console.log(`retired ${old}`);
  }
} finally {
  await getDb().close();
}
