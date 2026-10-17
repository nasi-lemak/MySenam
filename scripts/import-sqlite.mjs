#!/usr/bin/env node
/**
 * Bring an install across from the SQLite version of MySenam.
 *
 *   DATABASE_URL=postgres://… npm run import-sqlite -- /var/data/mysenam.db
 *
 * Copies every table the SQLite file has into the database this install now
 * uses (DATABASE_URL, or PGlite), keeping every id, so links, booking codes
 * and the ledger all still line up. It runs as one transaction: if anything
 * does not fit, nothing is changed. Afterwards it counts every table on both
 * sides and says so if any differ.
 *
 * The target must hold nothing of its own yet. A fresh database has only the
 * four starter venues, which this replaces; anything more — a customer, a
 * booking, a staff account — and it refuses unless told --force, which wipes
 * it first.
 *
 * Stop the old app before copying its file, so nothing is written to it
 * halfway through. Venues' saved payment keys are locked with the old
 * install's secret.key or MYSENAM_SECRET; this checks the new install's key
 * opens them before it starts, and brings secret.key across from beside the
 * file when there is no other.
 *
 * Usage: node scripts/import-sqlite.mjs <mysenam.db> [--force]
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { dataDirectory, databaseLabel, getDb, isEphemeral, withTransaction } from "../src/lib/db.ts";

const args = process.argv.slice(2);
const source = args.find((a) => !a.startsWith("--"));
const force = args.includes("--force");

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!source) fail("Usage: node scripts/import-sqlite.mjs <mysenam.db> [--force]");
if (!fs.existsSync(source)) fail(`No such file: ${source}`);
if (isEphemeral()) fail("The database is in memory (MYSENAM_DB=:memory:); there is nowhere to import into.");

let sqlite;
try {
  sqlite = new Database(source, { readonly: true, fileMustExist: true });
} catch (err) {
  fail(`That file will not open as a SQLite database: ${err.message}`);
}
const sqliteTables = new Set(
  sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name)
);
if (!sqliteTables.has("bookings") || !sqliteTables.has("venues")) fail(`${source} is not a MySenam database.`);

// ------------------------------------------------------------ the key

// Venues' saved payment keys are sealed with a key the database does not
// hold: MYSENAM_SECRET, or else secret.key in the data folder (the same
// material either way — the file holds what the variable would). Work out
// which key this install will use, and prove it opens them before copying
// anything, because the wrong one fails quietly: online payment just stops.
const oldKey = path.join(path.dirname(path.resolve(source)), "secret.key");
const newKey = path.join(dataDirectory(), "secret.key");
const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : null);
const material = process.env.MYSENAM_SECRET || read(newKey) || read(oldKey);
const bringKeyAcross = !process.env.MYSENAM_SECRET && !read(newKey) && read(oldKey) !== null;

function opens(key, sealed) {
  try {
    const raw = Buffer.from(sealed.slice("v1:".length), "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", crypto.createHash("sha256").update(key).digest(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    return true;
  } catch {
    return false;
  }
}

const sealed = sqliteTables.has("venue_payment_accounts")
  ? sqlite.prepare("SELECT api_key FROM venue_payment_accounts WHERE api_key LIKE 'v1:%' LIMIT 1").get()?.api_key
  : undefined;
if (sealed && !(material && opens(material, sealed)) && !force) {
  const where = process.env.MYSENAM_SECRET
    ? "MYSENAM_SECRET"
    : read(newKey)
      ? newKey
      : "no key at all";
  fail(
    `The old install has saved payment keys, and the key this install would use (${where}) cannot open them.\n` +
      `Set MYSENAM_SECRET to the old install's MYSENAM_SECRET, or to the contents of its secret.key, and run this again.\n` +
      "(Or pass --force to import anyway; each venue then enters its payment keys again.)"
  );
}

// ------------------------------------------------------------ the target

const db = getDb();
const one = async (sql, ...params) => db.prepare(sql).get(...params);
const all = async (sql, ...params) => db.prepare(sql).all(...params);

const pgTables = (
  await all(
    `SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations'`
  )
).map((r) => r.name);

const own = await one(
  "SELECT (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM bookings) + (SELECT COUNT(*) FROM admins) AS n"
);
if (own.n > 0 && !force) {
  await db.close();
  fail(
    `${databaseLabel()} already has customers, bookings or staff of its own.\n` +
      "Importing replaces everything in it. Re-run with --force if that is what you want."
  );
}

// Parents before children, so every foreign key finds its row.
const edges = await all(
  `SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent
     FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace`
);
const order = [];
const placed = new Set();
const visit = (table, trail = new Set()) => {
  if (placed.has(table) || trail.has(table)) return;
  trail.add(table);
  for (const e of edges) if (e.child === table && e.parent !== table) visit(e.parent, trail);
  placed.add(table);
  order.push(table);
};
for (const t of [...pgTables].sort()) visit(t);

const columnsOf = async (table) =>
  (
    await all(
      `SELECT column_name AS name, is_identity = 'YES' AS identity FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ? ORDER BY ordinal_position`,
      table
    )
  ).map((r) => ({ name: r.name, identity: r.identity }));

const quote = (name) => `"${name.replace(/"/g, '""')}"`;
const notes = [];
const counts = [];

console.log(`Importing ${source} into ${databaseLabel()} …`);
try {
  await withTransaction(async () => {
    await db.exec(`TRUNCATE ${pgTables.map(quote).join(", ")} RESTART IDENTITY CASCADE`);

    for (const table of order) {
      const pgColumns = await columnsOf(table);
      if (!sqliteTables.has(table)) {
        notes.push(`${table}: not in the old database; left empty`);
        continue;
      }
      const oldColumns = new Set(sqlite.prepare(`PRAGMA table_info(${quote(table)})`).all().map((c) => c.name));
      const columns = pgColumns.filter((c) => oldColumns.has(c.name)).map((c) => c.name);
      const dropped = [...oldColumns].filter((c) => !pgColumns.some((p) => p.name === c));
      if (dropped.length > 0) notes.push(`${table}: old column(s) ${dropped.join(", ")} not carried over`);

      const orderBy = oldColumns.has("id") ? " ORDER BY id" : "";
      const rows = sqlite.prepare(`SELECT ${columns.map(quote).join(", ")} FROM ${quote(table)}${orderBy}`).raw().all();
      // Postgres takes at most 65535 values in one statement.
      const perBatch = Math.max(1, Math.floor(30000 / columns.length));
      for (let i = 0; i < rows.length; i += perBatch) {
        const batch = rows.slice(i, i + perBatch);
        const tuple = `(${columns.map(() => "?").join(", ")})`;
        await db
          .prepare(
            `INSERT INTO ${quote(table)} (${columns.map(quote).join(", ")}) VALUES ${batch.map(() => tuple).join(", ")} RETURNING NULL`
          )
          .run(...batch.flat());
      }

      // Ids carry on from the highest one brought across.
      if (pgColumns.some((c) => c.name === "id" && c.identity))
        await one(
          `SELECT setval(pg_get_serial_sequence(?, 'id'), COALESCE((SELECT MAX(id) FROM ${quote(table)}), 0) + 1, false)`,
          table
        );

      const { n } = await one(`SELECT COUNT(*) AS n FROM ${quote(table)}`);
      counts.push({ table, from: rows.length, to: n });
      if (n !== rows.length) throw new Error(`${table}: copied ${rows.length} rows but ${n} arrived`);
    }
  });
} catch (err) {
  await db.close();
  const detail = err.detail ? ` (${err.detail})` : "";
  fail(`Import failed, and nothing was changed: ${err.message}${detail}`);
}
await db.close();
sqlite.close();

let keyNote = null;
if (bringKeyAcross) {
  fs.mkdirSync(path.dirname(newKey), { recursive: true });
  fs.copyFileSync(oldKey, newKey);
  fs.chmodSync(newKey, 0o600);
  keyNote = `Brought the old install's secret.key across to ${newKey}.`;
}
if (sealed) keyNote = `${keyNote ? `${keyNote} ` : ""}Saved payment keys: ${opens(material ?? "", sealed) ? "checked, and they open" : "will need entering again"}.`;

const width = Math.max(...counts.map((c) => c.table.length));
for (const c of counts.filter((c) => c.from > 0)) console.log(`  ${c.table.padEnd(width)}  ${c.to}`);
const empty = counts.filter((c) => c.from === 0).length;
if (empty > 0) console.log(`  (${empty} more tables, empty in the old database too)`);
for (const note of notes) console.log(`note: ${note}`);
if (keyNote) console.log(keyNote);
console.log("Every table matches, row for row. Start the app and check the Bookings tab for today.");
