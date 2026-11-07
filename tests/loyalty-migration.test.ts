import fs from "fs";
import path from "path";
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { runStep } from "../src/lib/db-steps";

/**
 * Migration 0320 (G19, ADR 0066) on an install that already holds free hours given twice: nothing is deleted or merged, every
 * reward keeps its pass, each is numbered in the order it was recorded, the unique key is built over them without failing, and a
 * further insert of a taken place is refused. Run on PGlite, and on a throwaway Postgres database when TEST_DATABASE_URL is set.
 */

const DIR = path.join(__dirname, "..", "db", "migrations");
const FILES = fs.readdirSync(DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();

interface Conn {
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  transaction(fn: (c: Pick<Conn, "query">) => Promise<void>): Promise<void>;
  close(): Promise<void>;
}

async function run(conn: Conn, files: string[]): Promise<void> {
  for (const f of files) {
    const version = f.replace(/\.sql$/, "");
    await conn.transaction(async (tx) => {
      await tx.query(fs.readFileSync(path.join(DIR, f), "utf8"));
      await runStep(version, { query: async (sql, params) => ({ rows: await tx.query(sql, params) }) });
      await tx.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
    });
  }
}

function pglite(): Conn {
  const db = new PGlite({ extensions: { citext } });
  return {
    query: async (sql, params) => (params ? (await db.query(sql, params)).rows : (await db.exec(sql)).flatMap((r) => r.rows)) as Record<string, unknown>[],
    transaction: async (fn) => {
      await db.transaction(async (tx) => fn({ query: async (sql, params) => (params ? (await tx.query(sql, params)).rows : (await tx.exec(sql)).flatMap((r) => r.rows)) as Record<string, unknown>[] }));
    },
    close: () => db.close(),
  };
}

const server = process.env.TEST_DATABASE_URL;
const databases: string[] = [];

async function postgres(): Promise<Conn> {
  const name = `loyalty_mig_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Client({ connectionString: server });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  databases.push(name);
  const url = new URL(server!);
  url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  return {
    query: async (sql, params) => (await client.query(sql, params as unknown[] | undefined)).rows as Record<string, unknown>[],
    transaction: async (fn) => {
      await client.query("BEGIN");
      try {
        await fn({ query: async (sql, params) => (await client.query(sql, params as unknown[] | undefined)).rows as Record<string, unknown>[] });
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    },
    close: () => client.end(),
  };
}

afterAll(async () => {
  if (!server) return;
  const admin = new pg.Client({ connectionString: server });
  await admin.connect();
  for (const name of databases) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
});

const engines: [string, () => Promise<Conn>][] = [["PGlite", async () => pglite()]];
if (server) engines.push(["Postgres", postgres]);

describe.each(engines)("migration 0320 on %s over free hours already given twice", (_name, open) => {
  it("keeps every reward and pass, numbers them in the order recorded, and builds the unique key without deleting a thing", async () => {
    const conn = await open();
    try {
      await conn.query("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
      await run(conn, FILES.filter((f) => f < "0320"));

      const id = async (sql: string, params: unknown[] = []) => Number((await conn.query(`${sql} RETURNING id`, params))[0].id);
      const venue = await id("INSERT INTO venues (name, area, address, phone, time_zone, loyalty_every) VALUES ('Old Hall', 'PJ', 'x', '031', 'Asia/Kuala_Lumpur', 5)");
      const other = await id("INSERT INTO venues (name, area, address, phone, time_zone, loyalty_every) VALUES ('Other Hall', 'PJ', 'x', '032', 'Asia/Kuala_Lumpur', 5)");
      const pass = (code: string, v: number, phone: string) =>
        id("INSERT INTO passes (code, venue_id, name, entries, price, holder_name, holder_phone, expires_on) VALUES ($1, $2, 'Loyalty: one free hour', 1, 0, 'Regular', $3, '2027-01-31')", [code, v, phone]);
      const reward = (v: number, key: string, passId: number | null) =>
        id("INSERT INTO loyalty_rewards (venue_id, phone_key, pass_id) VALUES ($1, $2, $3)", [v, key, passId]);

      // The old code: two runs at once gave the same hour twice (two passes, two rows), another number honestly once, the same
      // number at another venue once, and one pass was issued whose row was never written.
      const p1 = await pass("PS-LEG0001", venue, "0191230002");
      const p2 = await pass("PS-LEG0002", venue, "0191230002");
      const p3 = await pass("PS-LEG0003", venue, "0191230001");
      const p4 = await pass("PS-LEG0004", other, "0191230002");
      await pass("PS-LEG0005", venue, "0191230009");
      const r1 = await reward(venue, "60191230002", p1);
      const r2 = await reward(venue, "60191230002", p2);
      const r3 = await reward(venue, "60191230001", p3);
      const r4 = await reward(other, "60191230002", p4);
      const r5 = await reward(venue, "60191230002", null);
      const before = await conn.query("SELECT id, venue_id, phone_key, pass_id, created_at FROM loyalty_rewards ORDER BY id");
      expect(before).toHaveLength(5);

      await run(conn, FILES.filter((f) => f >= "0320" && f < "0321"));

      const after = await conn.query("SELECT id, venue_id, phone_key, pass_id, created_at, n FROM loyalty_rewards ORDER BY id");
      expect(after).toHaveLength(5);
      // Every row is as it was, with a place added.
      for (const [i, row] of after.entries()) expect({ ...row, n: undefined }).toEqual({ ...before[i], n: undefined });
      const n = Object.fromEntries(after.map((r) => [Number(r.id), Number(r.n)]));
      expect(n[r1]).toBe(1);
      expect(n[r2]).toBe(2);
      expect(n[r5]).toBe(3);
      expect(n[r3]).toBe(1);
      expect(n[r4]).toBe(1);
      expect(Number((await conn.query("SELECT COUNT(*) AS n FROM passes"))[0].n)).toBe(5);
      // The key is there, and a taken place is refused from now on; the next place is free.
      expect((await conn.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'loyalty_rewards_venue_phone_n'"))[0].indexdef).toMatch(/UNIQUE/);
      await expect(conn.query("INSERT INTO loyalty_rewards (venue_id, phone_key, n) VALUES ($1, '60191230002', 2)", [venue])).rejects.toMatchObject({ code: "23505" });
      await conn.query("INSERT INTO loyalty_rewards (venue_id, phone_key, n) VALUES ($1, '60191230002', 4)", [venue]);
      // Applying it again changes nothing (migrations are re-runnable).
      await conn.transaction(async (tx) => {
        await tx.query(fs.readFileSync(path.join(DIR, "0320_loyalty_reward_ordinal.sql"), "utf8"));
      });
      expect(Number((await conn.query("SELECT COUNT(*) AS n FROM loyalty_rewards"))[0].n)).toBe(6);
    } finally {
      await conn.close();
    }
  }, 120_000);
});
