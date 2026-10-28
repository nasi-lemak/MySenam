import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { logAction } from "../src/lib/activity";
import { raiseAlert } from "../src/lib/alerts";
import { getDb, withTransaction } from "../src/lib/db";

/**
 * Writes that must never undo the work they are part of (the staff activity
 * log, an alert, an error report: `aside` in lib/db.ts). A failure they catch
 * leaves the transaction they sit in usable (on Postgres any error aborts a
 * transaction, so it is caught under a savepoint), and a serialization
 * failure or deadlock is not swallowed: the transaction is run again, as any
 * other would be. Swallowing one turned a transaction that should have been
 * retried into an error on its next statement (a membership suspended while
 * somebody booked, on Postgres).
 */

const db = () => getDb();
let n = 0;

beforeAll(async () => {
  await db().exec(`
    CREATE TABLE aside_work (id SERIAL PRIMARY KEY, what TEXT NOT NULL);
    CREATE SEQUENCE aside_tries;
  `);
  await db().exec(`
    CREATE FUNCTION aside_refuse_log() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.action = 'aside.fails' THEN RAISE EXCEPTION 'refused by the test' USING ERRCODE = '23514'; END IF;
      IF NEW.action = 'aside.collides' AND nextval('aside_tries') % 2 = 1 THEN
        RAISE EXCEPTION 'could not serialize access' USING ERRCODE = '40001';
      END IF;
      RETURN NEW;
    END $$;
    CREATE FUNCTION aside_refuse_alert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.key = 'aside:fails' THEN RAISE EXCEPTION 'refused by the test' USING ERRCODE = '23514'; END IF;
      IF NEW.key = 'aside:collides' AND nextval('aside_tries') % 2 = 1 THEN
        RAISE EXCEPTION 'could not serialize access' USING ERRCODE = '40001';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER aside_log BEFORE INSERT ON staff_actions FOR EACH ROW EXECUTE FUNCTION aside_refuse_log();
    CREATE TRIGGER aside_alert BEFORE INSERT ON system_alerts FOR EACH ROW EXECUTE FUNCTION aside_refuse_alert();
  `);
});

const work = async (what: string) => (await db().prepare("SELECT COUNT(*)::int AS n FROM aside_work WHERE what = ?").get(what)) as { n: number };
const logged = async (detail: string) =>
  (await db().prepare("SELECT COUNT(*)::int AS n FROM staff_actions WHERE detail = ?").get(detail)) as { n: number };

describe("the staff activity log inside a transaction", () => {
  it("failing, leaves the transaction to carry on and commit what it did", async () => {
    const what = `fails-${++n}`;
    await withTransaction(async () => {
      await db().prepare("INSERT INTO aside_work (what) VALUES (?)").run(what);
      await logAction({ id: null, name: "Tester" }, { venueId: null, action: "aside.fails", detail: what });
      await db().prepare("INSERT INTO aside_work (what) VALUES (?)").run(what);
    });
    expect((await work(what)).n).toBe(2);
    expect((await logged(what)).n).toBe(0);
  });

  it("colliding with another transaction, runs the whole transaction again, done once", async () => {
    const what = `collides-${++n}`;
    let tries = 0;
    await withTransaction(async () => {
      tries++;
      await db().prepare("INSERT INTO aside_work (what) VALUES (?)").run(what);
      await logAction({ id: null, name: "Tester" }, { venueId: null, action: "aside.collides", detail: what });
      await db().prepare("SELECT 1").get();
    });
    expect(tries).toBe(2);
    expect((await work(what)).n).toBe(1);
    expect((await logged(what)).n).toBe(1);
  });

  it("outside a transaction, never throws", async () => {
    await expect(logAction({ id: null, name: "Tester" }, { venueId: null, action: "aside.fails", detail: "alone" })).resolves.toBeUndefined();
  });
});

describe("an alert raised inside a transaction", () => {
  it("failing, leaves the transaction to carry on", async () => {
    const what = `alert-fails-${++n}`;
    await withTransaction(async () => {
      expect(await raiseAlert("aside:fails", "A test alert", "detail")).toBe(false);
      await db().prepare("INSERT INTO aside_work (what) VALUES (?)").run(what);
    });
    expect((await work(what)).n).toBe(1);
  });

  it("colliding, runs the transaction again", async () => {
    const what = `alert-collides-${++n}`;
    let tries = 0;
    await withTransaction(async () => {
      tries++;
      await raiseAlert("aside:collides", "A test alert", "detail");
      await db().prepare("INSERT INTO aside_work (what) VALUES (?)").run(what);
    });
    expect(tries).toBe(2);
    expect((await work(what)).n).toBe(1);
    expect(((await db().prepare("SELECT count FROM system_alerts WHERE key = 'aside:collides'").get()) as { count: number }).count).toBe(1);
  });
});
