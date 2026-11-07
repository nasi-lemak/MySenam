import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { runStep } from "../src/lib/db-steps";

/**
 * Migration 0341 (lib/no-show-marks.ts, ADR 0072) on an install where hosts have already marked players as no-shows: every mark stays in
 * force, scoped to the venue of its game; nothing is made up (no host, time or reason); a game without a mark gets none; running the
 * migration again changes nothing. (`legacy_platform` is for a mark whose venue cannot be found, which the foreign keys make impossible for
 * a game that still has its booking; a mark written by a server still on the old code after the migration has run has no status and is read as
 * one, `tests/no-show-marks.test.ts`.)
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

describe("migration 0341 on marks made before they had a venue, a reason or a status", () => {
  it("keeps every mark in force, scoped to its game's venue, and invents nothing", async () => {
    const db = new PGlite({ extensions: { citext } });
    await run(db, FILES.filter((f) => f < "0341"));
    const id = async (sql: string, params: unknown[] = []) => (await db.query<{ id: number }>(`${sql} RETURNING id`, params)).rows[0].id;

    const venueA = await id("INSERT INTO venues (name, area, address, phone, time_zone) VALUES ('Hall A', 'PJ', 'x', '031', 'Asia/Kuala_Lumpur')");
    const venueB = await id("INSERT INTO venues (name, area, address, phone, time_zone) VALUES ('Hall B', 'KL', 'x', '032', 'Asia/Kuala_Lumpur')");
    const courtA = await id("INSERT INTO courts (venue_id, name, sport, off_peak_rate, peak_rate) VALUES ($1, 'A1', 'badminton', 20, 20)", [venueA]);
    const courtB = await id("INSERT INTO courts (venue_id, name, sport, off_peak_rate, peak_rate) VALUES ($1, 'B1', 'badminton', 20, 20)", [venueB]);
    const user = async (n: number) => id("INSERT INTO users (name, email, phone, password_hash) VALUES ($1, $2, $3, 'x')", [`User ${n}`, `u${n}@old.my`, `0123${n}00000`]);
    const host = await user(1);
    const flake = await user(2);
    const fine = await user(3);
    const game = async (court: number, code: string) => {
      const booking = await id(
        "INSERT INTO bookings (code, court_id, date, start_min, end_min, starts_at, ends_at, name, phone, total_price, status) VALUES ($1, $2, '2026-10-01', 540, 600, '2026-10-01T01:00:00Z', '2026-10-01T02:00:00Z', 'Host', '0123100000', 20, 'confirmed')",
        [code, court]
      );
      return id("INSERT INTO open_games (booking_id, host_id, spots, share) VALUES ($1, $2, 3, 0)", [booking, host]);
    };
    const gA = await game(courtA, "OLDA1");
    const gB = await game(courtB, "OLDB1");
    const gC = await game(courtA, "OLDA2");
    const mark = (g: number, u: number, noShow: number) => id("INSERT INTO open_game_players (game_id, user_id, status, no_show) VALUES ($1, $2, 'accepted', $3)", [g, u, noShow]);
    const m1 = await mark(gA, flake, 1);
    const m2 = await mark(gB, flake, 1);
    const clean = await mark(gC, fine, 0);

    await run(db, FILES.filter((f) => f === "0341_no_show_marks_reviewable.sql"));

    const rows = (await db.query<Record<string, unknown>>("SELECT id, no_show, no_show_status, no_show_scope, no_show_venue_id, no_show_reason, no_show_at, no_show_reviewed_by FROM open_game_players ORDER BY id")).rows;
    const by = (i: number) => rows.find((r) => r.id === i)!;
    expect(by(m1)).toMatchObject({ no_show: 1, no_show_status: "in_force", no_show_scope: "venue", no_show_venue_id: venueA, no_show_reason: null, no_show_at: null, no_show_reviewed_by: null });
    expect(by(m2)).toMatchObject({ no_show: 1, no_show_status: "in_force", no_show_scope: "venue", no_show_venue_id: venueB });
    expect(by(clean)).toMatchObject({ no_show: 0, no_show_status: null, no_show_scope: null, no_show_venue_id: null });

    // Running it again changes nothing.
    const before = JSON.stringify((await db.query("SELECT * FROM open_game_players ORDER BY id")).rows);
    await run(db, FILES.filter((f) => f === "0341_no_show_marks_reviewable.sql"));
    expect(JSON.stringify((await db.query("SELECT * FROM open_game_players ORDER BY id")).rows)).toBe(before);
    await db.close();
  });
});
