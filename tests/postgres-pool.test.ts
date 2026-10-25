import { describe, expect, it } from "vitest";
import { getDb } from "../src/lib/db";

/**
 * The connection pool on a Postgres server (skipped on PGlite, which has no
 * pool). Each new connection turns JIT off before it is handed out, so the
 * setting never queues behind or ahead of the caller's first query: pg 8
 * warns of overlapping queries on one client, and pg 9 refuses them.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)("the Postgres connection pool", () => {
  it("turns JIT off on every new connection, without overlapping the first query", async () => {
    const warnings: string[] = [];
    const listen = (w: Error) => {
      if (/already executing a query/.test(w.message)) warnings.push(w.message);
    };
    process.on("warning", listen);
    try {
      // More at once than any connection yet open: every one of these is a new connection's first query.
      const rows = await Promise.all(Array.from({ length: 8 }, () => getDb().prepare("SELECT current_setting('jit') AS jit").get()));
      expect(rows.map((r) => (r as { jit: string }).jit)).toEqual(Array(8).fill("off"));
      await new Promise((r) => setTimeout(r, 50));
      expect(warnings).toEqual([]);
    } finally {
      process.off("warning", listen);
    }
  });
});
