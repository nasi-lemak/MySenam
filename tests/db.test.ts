import { describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { BusyError, getDb, isBusy, isUniqueViolation, resetTransactionStats, toPostgresParams, transactionStats, withTransaction } from "../src/lib/db";
import { refusal } from "../src/lib/api";

/**
 * The database layer itself.
 *
 * The rest of the application was written against SQLite and reads the
 * database the way it did then: `?` for values, numbers back as numbers,
 * timestamps as text, a transaction inside another one able to fail on its
 * own. These are the promises the Postgres layer has to keep for that to hold.
 */

const db = () => getDb();

describe("speaking to Postgres the way the code expects", () => {
  it("turns ? into numbered values, leaving quoted text and comments alone", () => {
    expect(toPostgresParams("SELECT '?', \"a?\", ? -- what's this?\n, ?")).toBe(
      "SELECT '?', \"a?\", $1 -- what's this?\n, $2"
    );
    expect(toPostgresParams("SELECT ?::text IS NULL")).toBe("SELECT $1::text IS NULL");
  });

  it("gives back counts and money as numbers, and the new row's id", async () => {
    const made = await db()
      .prepare("INSERT INTO users (name, email, phone, password_hash) VALUES (?, ?, ?, ?)")
      .run("Aina", "Aina@Example.my", "0100000001", "x");
    expect(made.changes).toBe(1);
    expect(typeof made.lastInsertRowid).toBe("number");
    const row = (await db()
      .prepare("SELECT COUNT(*) AS n, SUM(off_peak_rate) AS total FROM courts")
      .get()) as { n: unknown; total: unknown };
    expect(typeof row.n).toBe("number");
    expect(typeof row.total).toBe("number");
  });

  it("matches email addresses whatever their case", async () => {
    const found = (await db().prepare("SELECT email FROM users WHERE email = ?").get("aina@EXAMPLE.MY")) as
      | { email: string }
      | undefined;
    expect(found?.email).toBe("Aina@Example.my");
    await expect(
      db().prepare("INSERT INTO users (name, email, phone, password_hash) VALUES (?, ?, ?, ?)").run("B", "AINA@example.my", "0100000002", "x")
    ).rejects.toSatisfy((err: unknown) => isUniqueViolation(err, "users"));
  });

  it("keeps timestamps as the text SQLite wrote, in UTC", async () => {
    const row = (await db().prepare("SELECT datetime('now') AS now, datetime('2026-01-31 10:00:00', '+1 day') AS later").get()) as {
      now: string;
      later: string;
    };
    expect(row.now).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    expect(row.later).toBe("2026-02-01 10:00:00");
  });
});

describe("transactions", () => {
  const settings = async () =>
    ((await db().prepare("SELECT key FROM settings WHERE key LIKE 'tx-%' ORDER BY key").all()) as { key: string }[]).map(
      (r) => r.key
    );
  const put = (key: string) => db().prepare("INSERT INTO settings (key, value) VALUES (?, 'v')").run(key);

  it("undoes everything when one fails", async () => {
    await expect(
      withTransaction(async () => {
        await put("tx-a");
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(await settings()).toEqual([]);
  });

  it("lets one inside another fail on its own, and the outer carry on", async () => {
    await withTransaction(async () => {
      await put("tx-outer");
      // A duplicate key would leave a bare Postgres transaction unusable; the
      // inner one is a savepoint, so only its own work is undone.
      await expect(
        withTransaction(async () => {
          await put("tx-inner");
          await put("tx-outer");
        })
      ).rejects.toSatisfy((err: unknown) => isUniqueViolation(err));
      await put("tx-after");
    });
    expect(await settings()).toEqual(["tx-after", "tx-outer"]);
  });

  /** An error as Postgres raises it, with its code. */
  const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });

  it("runs a transaction again after a serialization failure or deadlock, keeping only the try that commits", async () => {
    resetTransactionStats();
    let tries = 0;
    await withTransaction(async () => {
      tries++;
      await put(`tx-retry-${tries}`);
      if (tries === 1) throw pgError("40001");
      if (tries === 2) throw pgError("40P01");
    });
    expect(tries).toBe(3);
    expect(await settings()).toEqual(["tx-after", "tx-outer", "tx-retry-3"]);
    expect(transactionStats()).toMatchObject({ transactions: 1, retries: { "40001": 1, "40P01": 1 }, exhausted: 0 });
  });

  it("gives up after ten tries as busy, with nothing kept, and says so as 503", async () => {
    resetTransactionStats();
    let tries = 0;
    const err = await withTransaction(async () => {
      tries++;
      await put(`tx-busy-${tries}`);
      throw pgError("40001");
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BusyError);
    expect(isBusy(err)).toBe(true);
    expect(tries).toBe(10);
    expect((await settings()).filter((k) => k.startsWith("tx-busy"))).toEqual([]);
    expect(transactionStats().exhausted).toBe(1);
    const res = refusal({ ok: false, error: "busy", code: "BUSY" });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("2");
  });

  it("never retries a real conflict or any other error", async () => {
    let tries = 0;
    await expect(
      withTransaction(async () => {
        tries++;
        throw pgError("23P01");
      })
    ).rejects.toMatchObject({ code: "23P01" });
    expect(tries).toBe(1);
  });
});
