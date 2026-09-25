#!/usr/bin/env node
/**
 * Take a snapshot of the database. Meant for cron:
 *
 *   0 3 * * *  cd /srv/mysenam && npm run backup >> /var/log/mysenam-backup.log 2>&1
 *
 * Exits non-zero if the snapshot could not be taken or did not verify, so a
 * failing backup shows up as a failing job rather than a quiet no-op.
 *
 * Usage: node scripts/backup.mjs [--dir PATH] [--keep N]
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
}

const dbFile =
  process.env.MYSENAM_DB ??
  process.env.MUDAHTEMPAH_DB ??
  (() => {
    const dir = path.join(process.cwd(), "data");
    const current = path.join(dir, "mysenam.db");
    const legacy = path.join(dir, "mudahtempah.db");
    return fs.existsSync(current) || !fs.existsSync(legacy) ? current : legacy;
  })();

const dir = flag("dir", process.env.MYSENAM_BACKUP_DIR ?? path.join(path.dirname(dbFile), "backups"));
const keep = Number(flag("keep", process.env.MYSENAM_BACKUP_KEEP ?? 14));

if (!fs.existsSync(dbFile)) {
  console.error(`No database at ${dbFile}. Nothing to back up.`);
  process.exit(1);
}
fs.mkdirSync(dir, { recursive: true });

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
  .formatToParts(new Date())
  .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
const hour = parts.hour === "24" ? "00" : parts.hour;
const name = `mysenam-${parts.year}-${parts.month}-${parts.day}-${hour}${parts.minute}${parts.second}.db`;
const target = path.join(dir, name);
const temporary = `${target}.tmp`;

const db = new Database(dbFile, { readonly: false, fileMustExist: true });
try {
  fs.rmSync(temporary, { force: true });
  db.prepare("VACUUM INTO ?").run(temporary);
} catch (err) {
  fs.rmSync(temporary, { force: true });
  console.error(`Backup failed: ${err.message}`);
  process.exit(1);
} finally {
  db.close();
}

// A backup nobody has read is a guess.
try {
  const snapshot = new Database(temporary, { readonly: true, fileMustExist: true });
  const [{ integrity_check: integrity }] = snapshot.pragma("integrity_check");
  const { n } = snapshot.prepare("SELECT COUNT(*) AS n FROM bookings").get();
  snapshot.close();
  if (integrity !== "ok") throw new Error(`integrity check said "${integrity}"`);
  fs.renameSync(temporary, target);
  console.log(`${name} — ${(fs.statSync(target).size / 1024).toFixed(0)} KB, ${n} bookings`);
} catch (err) {
  fs.rmSync(temporary, { force: true });
  console.error(`Backup did not verify, so it was discarded: ${err.message}`);
  process.exit(1);
}

// Retire the oldest.
const snapshots = fs
  .readdirSync(dir)
  .filter((f) => /^mysenam-\d{4}-\d{2}-\d{2}-\d{6}\.db$/.test(f))
  .sort()
  .reverse();
for (const old of snapshots.slice(keep)) {
  fs.unlinkSync(path.join(dir, old));
  console.log(`retired ${old}`);
}
