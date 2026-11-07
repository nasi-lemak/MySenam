import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { runStep } from "../src/lib/db-steps";

/**
 * Migrations 0337 and 0338 (MEMB D6, ADR 0071) on an install where memberships were sold before they kept their benefits:
 * each gets the benefits of its tier as the tier stands when the migration runs, recorded as `backfilled`; a membership on no
 * tier gets the plain benefits; nothing is invented, and running it again changes nothing.
 */

const DIR = path.join(__dirname, "..", "db", "migrations");
const FILES = fs.readdirSync(DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();

async function run(db: PGlite, files: string[]): Promise<void> {
  for (const f of files) {
    const version = f.replace(/\.sql$/, "");
    await db.transaction(async (tx) => {
      await tx.exec(fs.readFileSync(path.join(DIR, f), "utf8"));
      await runStep(version, { query: async (sql, params) => ({ rows: (await tx.query(sql, params)).rows as Record<string, unknown>[] }) });
    });
  }
}

describe("migrations 0337 and 0338 on memberships sold before benefits were kept", () => {
  it("backfills each term from its tier as it stands, marks it backfilled, and is repeatable", async () => {
    const db = new PGlite({ extensions: { citext } });
    await run(db, FILES.filter((f) => f < "0337"));
    const venue = (await db.query<{ id: number }>("INSERT INTO venues (name, area, address, phone, time_zone) VALUES ('Old Club', 'PJ', 'x', '031', 'Asia/Kuala_Lumpur') RETURNING id")).rows[0].id;
    // A tier edited since some members bought it: they are given what it is now, which is what they were getting.
    const gold = (await db.query<{ id: number }>(
      "INSERT INTO membership_plans (venue_id, name, months, price, rate_percent, ahead_days, scope, extend_on_suspension, admits_entry, admits_entry_sport) VALUES ($1, 'Gold', 12, 500, 90, 21, 'participant', TRUE, FALSE, NULL) RETURNING id",
      [venue]
    )).rows[0].id;
    const gym = (await db.query<{ id: number }>("INSERT INTO membership_plans (venue_id, name, months, price) VALUES ($1, 'Plain', 1, 50) RETURNING id", [venue])).rows[0].id;
    const insert = (code: string, tier: number | null, plan: number | null) =>
      db.query(
        "INSERT INTO memberships (code, venue_id, holder_name, holder_phone, starts_on, expires_on, price, plan_id, tier_id) VALUES ($1, $2, 'Holder', '0123456789', '2026-10-01', '2027-09-30', 100, $3, $4)",
        [code, venue, plan, tier]
      );
    await insert("MB-GOLD", gold, gold);
    await insert("MB-PLAIN", gym, null);
    await insert("MB-NONE", null, null);
    // A plan retired since: its running terms still get its benefits.
    await db.query("UPDATE membership_plans SET retired_at = datetime('now') WHERE id = $1", [gym]);

    await run(db, FILES.filter((f) => f >= "0337"));

    type Row = { code: string; benefits: Record<string, unknown>; benefits_version: number | null; benefits_source: string };
    const read = async () => (await db.query<Row>("SELECT code, benefits, benefits_version, benefits_source FROM memberships ORDER BY code")).rows;
    const rows = await read();
    const by = (code: string) => rows.find((r) => r.code === code)!;
    expect(by("MB-GOLD")).toMatchObject({
      benefits: { ratePercent: 90, aheadDays: 21, scope: "participant", admitsEntry: false, admitsEntrySport: null, extendOnSuspension: true },
      benefits_version: 1,
      benefits_source: "backfilled",
    });
    expect(by("MB-PLAIN")).toMatchObject({
      benefits: { ratePercent: null, aheadDays: null, scope: "booking", admitsEntry: false, extendOnSuspension: false },
      benefits_version: 1,
      benefits_source: "backfilled",
    });
    expect(by("MB-NONE")).toMatchObject({
      benefits: { ratePercent: null, aheadDays: null, scope: "booking", admitsEntry: false, extendOnSuspension: false },
      benefits_version: null,
      benefits_source: "backfilled",
    });
    expect((await db.query<{ version: number }>("SELECT version FROM membership_plans WHERE id = $1", [gold])).rows[0].version).toBe(1);

    // Running the backfill again changes nothing (a tier edited in between does not reach a term already recorded).
    await db.query("UPDATE membership_plans SET rate_percent = 50 WHERE id = $1", [gold]);
    await db.exec(fs.readFileSync(path.join(DIR, "0338_membership_term_benefits_backfill.sql"), "utf8"));
    expect(await read()).toEqual(rows);

    // The source is one of the two words.
    await expect(db.query("UPDATE memberships SET benefits_source = 'guessed' WHERE code = 'MB-NONE'")).rejects.toThrow();
    await db.close();
  });
});
