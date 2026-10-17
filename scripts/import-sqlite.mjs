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
 * halfway through. Encrypted settings (payment keys, the off-site backup
 * secret) are locked with the old install's secret.key, so that is brought
 * across too, unless MYSENAM_SECRET holds the key instead.
 *
 * Usage: node scripts/import-sqlite.mjs <mysenam.db> [--force]
 */
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

const oldKey = path.join(path.dirname(path.resolve(source)), "secret.key");
const newKey = path.join(dataDirectory(), "secret.key");
let keyNote = null;
if (process.env.MYSENAM_SECRET) {
  keyNote = "MYSENAM_SECRET is set: it must be the same value the old install used, or saved payment keys will not open.";
} else if (fs.existsSync(oldKey)) {
  const old = fs.readFileSync(oldKey);
  if (fs.existsSync(newKey)) {
    if (!fs.readFileSync(newKey).equals(old))
      fail(
        `${newKey} already holds a different key, which could not open the old install's saved payment keys.\n` +
          `Move it away, or copy ${oldKey} over it, and run this again.`
      );
  } else {
    keyNote = `copy ${oldKey} to ${newKey}`;
  }
} else {
  keyNote = `No secret.key beside ${source}. If the old install saved payment keys, copy its secret.key to ${newKey}.`;
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

if (keyNote?.startsWith("copy ")) {
  fs.mkdirSync(path.dirname(newKey), { recursive: true });
  fs.copyFileSync(oldKey, newKey);
  fs.chmodSync(newKey, 0o600);
  keyNote = `Brought the old install's secret.key across to ${newKey}.`;
}

const width = Math.max(...counts.map((c) => c.table.length));
for (const c of counts.filter((c) => c.from > 0)) console.log(`  ${c.table.padEnd(width)}  ${c.to}`);
const empty = counts.filter((c) => c.from === 0).length;
if (empty > 0) console.log(`  (${empty} more tables, empty in the old database too)`);
for (const note of notes) console.log(`note: ${note}`);
if (keyNote) console.log(keyNote);
console.log("Every table matches, row for row. Start the app and check the Bookings tab for today.");
