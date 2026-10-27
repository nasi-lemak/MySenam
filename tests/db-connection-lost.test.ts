import { describe, expect, it } from "vitest";
import pg from "pg";

process.env.MYSENAM_DB = ":memory:";

import { getDb, withTransaction } from "../src/lib/db";

/**
 * A connection cut while a transaction holds it (the server restarting, an
 * administrator ending it) fails that transaction, and only that: the
 * process does not crash on an error nobody heard, and the next transaction
 * gets a working connection. Needs real Postgres to cut one.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)("a connection cut in the middle of a transaction (Postgres)", () => {
  it("fails that transaction, crashes nothing, and the next one works", async () => {
    const uncaught: unknown[] = [];
    const listen = (err: unknown) => uncaught.push(err);
    process.on("uncaughtException", listen);
    try {
      const outcome = withTransaction(async () => {
        const { pid } = (await getDb().prepare("SELECT pg_backend_pid() AS pid").get()) as { pid: number };
        const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
        await admin.connect();
        try {
          await admin.query("SELECT pg_terminate_backend($1)", [pid]);
        } finally {
          await admin.end();
        }
        await new Promise((r) => setTimeout(r, 200));
        await getDb().prepare("SELECT 1").get();
      });
      await expect(outcome).rejects.toBeTruthy();
      await new Promise((r) => setTimeout(r, 200));
      expect(uncaught).toEqual([]);
      // The broken connection was thrown away, not handed on.
      for (let i = 0; i < 12; i++) expect(await withTransaction(async () => (await getDb().prepare("SELECT 1 AS one").get()) as { one: number })).toEqual({ one: 1 });
    } finally {
      process.off("uncaughtException", listen);
    }
  });
});
