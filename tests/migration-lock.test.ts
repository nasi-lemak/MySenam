import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { promisify } from "util";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Migrations under a lock (lib/db.ts, `lockMigrations`): every server starting
 * against one Postgres database waits on the same advisory lock before it
 * looks at what is applied, so two starting at once never apply a migration
 * twice nor trip over each other's half-made schema.
 *
 * Postgres only: PGlite is one process's database and has no lock to take
 * (its driver has no `lockMigrations`), so on PGlite this file is skipped.
 * The servers here are real `node` processes loading src/ as the scripts do.
 */

const server = process.env.TEST_DATABASE_URL;
const ROOT = path.join(import.meta.dirname, "..");
const LOCK = 7419266;
const run = promisify(execFile);
const migrations = fs.readdirSync(path.join(ROOT, "db", "migrations")).filter((f) => /^\d+_.+\.sql$/.test(f)).length;

/** A query on its own connection, outside the app. */
async function onDatabase<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const made: string[] = [];
async function freshDatabase(): Promise<string> {
  const name = `mysenam_lock_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  await onDatabase(server!, (c) => c.query(`CREATE DATABASE ${name}`));
  made.push(name);
  const url = new URL(server!);
  url.pathname = `/${name}`;
  return url.toString();
}

afterAll(async () => {
  if (!server) return;
  const { getDb } = await import("../src/lib/db");
  await getDb().close();
  for (const name of made) await onDatabase(server, (c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
});

/** One server starting: opens the database (migrating it) and says what it found. */
async function start(url: string, country = "MY"): Promise<{ code: number; out: string }> {
  const db = pathToFileURL(path.join(ROOT, "src", "lib", "db.ts")).href;
  const code = `
    const { getDb } = await import(${JSON.stringify(db)});
    const row = await getDb().prepare("SELECT COUNT(*)::int AS n FROM venues").get();
    console.log(JSON.stringify(row));
    await getDb().close();
  `;
  try {
    const { stdout, stderr } = await run("node", ["--input-type=module", "-e", code], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: url, MYSENAM_DB: "", MYSENAM_COUNTRY: country, MYSENAM_SCHEDULER: "off" },
      timeout: 120_000,
    });
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

const applied = (url: string) =>
  onDatabase(url, async (c) => {
    const { rows } = await c.query("SELECT version, COUNT(*)::int AS n FROM schema_migrations GROUP BY version");
    return rows as { version: string; n: number }[];
  });

describe.skipIf(!server)("migrations under a lock, on Postgres", () => {
  it("wait for the lock another server holds before reading or changing the schema, then apply every migration once", async () => {
    // This file's own empty database (tests/setup-db.ts): nothing has opened it yet.
    const url = process.env.DATABASE_URL!;
    const holder = new pg.Client({ connectionString: url });
    await holder.connect();
    try {
      await holder.query("SELECT pg_advisory_lock($1)", [LOCK]);
      const { getDb } = await import("../src/lib/db");
      let opened = false;
      const first = getDb()
        .prepare("SELECT COUNT(*)::int AS n FROM venues")
        .get()
        .then((r) => {
          opened = true;
          return r as { n: number };
        });
      // It asks for the lock and waits for it; nothing of the schema is made meanwhile.
      const deadline = Date.now() + 10_000;
      let waiting = 0;
      while (waiting === 0 && Date.now() < deadline) {
        waiting = (
          await holder.query(
            "SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = $1 AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
            [LOCK]
          )
        ).rows[0].n;
        if (waiting === 0) await new Promise((r) => setTimeout(r, 100));
      }
      expect(waiting).toBe(1);
      await new Promise((r) => setTimeout(r, 500));
      expect(opened).toBe(false);
      expect((await holder.query("SELECT to_regclass('schema_migrations') AS t")).rows[0].t).toBeNull();
      expect((await holder.query("SELECT to_regclass('venues') AS t")).rows[0].t).toBeNull();

      await holder.query("SELECT pg_advisory_unlock($1)", [LOCK]);
      expect((await first).n).toBe(4);
      const versions = await applied(url);
      expect(versions).toHaveLength(migrations);
      expect(versions.every((v) => v.n === 1)).toBe(true);
      // And it let the lock go again once done.
      expect(
        (await holder.query("SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = $1 AND database = (SELECT oid FROM pg_database WHERE datname = current_database())", [LOCK]))
          .rows[0].n
      ).toBe(0);
    } finally {
      await holder.end();
    }
  });

  it("let several servers start at once on an empty database: each starts, and every migration is applied once", async () => {
    // An install outside Malaysia starts with no venues (lib/db.ts, seedIfEmpty), so this is the migrations alone.
    const url = await freshDatabase();
    const started = await Promise.all([start(url, "SG"), start(url, "SG"), start(url, "SG"), start(url, "SG")]);
    for (const s of started) expect(s, s.out).toMatchObject({ code: 0 });
    for (const s of started) expect(s.out).toContain('{"n":0}');
    const versions = await applied(url);
    expect(versions).toHaveLength(migrations);
    expect(versions.every((v) => v.n === 1)).toBe(true);
  }, 300_000);

  it("let several servers start at once on an empty Malaysian database: each starts, and the starter venues are seeded once", async () => {
    // Seeding runs under the same lock as migrations (lib/db.ts, opened): without it, one of the
    // servers failed with a serialization error (40001) in its serializable seed.
    const url = await freshDatabase();
    const started = await Promise.all([start(url), start(url), start(url), start(url)]);
    for (const s of started) expect(s, s.out).toMatchObject({ code: 0 });
    expect(await onDatabase(url, async (c) => (await c.query("SELECT COUNT(*)::int AS n FROM venues")).rows[0].n)).toBe(4);
  }, 300_000);

  it("start a server on a database already migrated without applying anything again", async () => {
    const url = await freshDatabase();
    expect((await start(url)).code).toBe(0);
    const before = await onDatabase(url, async (c) => (await c.query("SELECT version, applied_at::text AS at FROM schema_migrations ORDER BY version")).rows);
    const again = await start(url);
    expect(again, again.out).toMatchObject({ code: 0 });
    expect(await onDatabase(url, async (c) => (await c.query("SELECT version, applied_at::text AS at FROM schema_migrations ORDER BY version")).rows)).toEqual(before);
  }, 300_000);
});
