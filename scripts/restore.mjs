#!/usr/bin/env node
/**
 * Put a snapshot back. This overwrites the live database, so it asks to be
 * told twice: name the file, and pass --force.
 *
 *   node scripts/restore.mjs data/backups/mysenam-2026-09-26-030000.db --force
 *
 * Stop the app first. SQLite will let you swap the file underneath a running
 * process and you will not enjoy what happens next.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const [source, ...rest] = process.argv.slice(2);
const force = rest.includes("--force") || process.argv.includes("--force");

if (!source) {
  console.error("Usage: node scripts/restore.mjs <backup.db> --force");
  process.exit(1);
}

const dbFile =
  process.env.MYSENAM_DB ??
  process.env.MUDAHTEMPAH_DB ??
  path.join(process.cwd(), "data", "mysenam.db");

if (!fs.existsSync(source)) {
  console.error(`No such backup: ${source}`);
  process.exit(1);
}

// Refuse to restore something that is not a database we could serve.
let bookings = 0;
try {
  const snapshot = new Database(source, { readonly: true, fileMustExist: true });
  const [{ integrity_check: integrity }] = snapshot.pragma("integrity_check");
  if (integrity !== "ok") throw new Error(`integrity check said "${integrity}"`);
  bookings = snapshot.prepare("SELECT COUNT(*) AS n FROM bookings").get().n;
  snapshot.close();
} catch (err) {
  console.error(`That file will not open as a MySenam database: ${err.message}`);
  process.exit(1);
}

console.log(`${source}: ${bookings} bookings`);
console.log(`Would replace: ${dbFile}`);

if (!force) {
  console.error("\nNothing done. Stop the app, then re-run with --force.");
  process.exit(1);
}

// Keep what is being replaced. The worst restore is the one that turns out to
// have been the wrong file.
if (fs.existsSync(dbFile)) {
  const aside = `${dbFile}.replaced-${Date.now()}`;
  fs.renameSync(dbFile, aside);
  console.log(`Previous database moved to ${aside}`);
}
// WAL and shm belong to the database that has just been moved aside.
for (const suffix of ["-wal", "-shm"]) fs.rmSync(`${dbFile}${suffix}`, { force: true });

fs.mkdirSync(path.dirname(dbFile), { recursive: true });
fs.copyFileSync(source, dbFile);
console.log(`Restored. Start the app and check the Bookings tab for today.`);
