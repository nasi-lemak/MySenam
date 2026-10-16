import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { getDb } from "../src/lib/db";
import { venueReport } from "../src/lib/reports";
import {
  countNoShows,
  createBooking,
  getAvailability,
  listBookingsForDate,
  listVenues,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * The pages a venue uses every day must cost what that venue's own trade
 * costs, not what the whole platform's does.
 *
 * Each of these was once a read of every venue's rows: the venue page asked
 * for "this venue, or every venue if none" in one `(? IS NULL OR ...)` clause,
 * which no index can serve; the day list counted a customer's no-shows with no
 * index on phone; and the report picked a venue's rows by filtering on the
 * joined court. Nothing failed — the answers were right — they just took seconds
 * once a few hundred venues were on one install, and the server answers one
 * request at a time, so everybody waited.
 *
 * Timing would make a flaky test, so this asks SQLite instead: it records the
 * statements the real function runs and checks the plan for each. The
 * database is new and has no statistics, which is what a production install
 * looks like too, since nothing runs ANALYZE.
 */

const BIG_TABLES = new Set(["bookings", "booking_slots", "slot_blocks", "classes"]);

/** Every SELECT a call prepares, in order. */
function statementsRunBy(fn: () => unknown): string[] {
  const db = getDb();
  const prepare = db.prepare;
  const seen: string[] = [];
  db.prepare = ((sql: string) => {
    seen.push(sql);
    return prepare.call(db, sql);
  }) as typeof db.prepare;
  try {
    fn();
  } finally {
    db.prepare = prepare;
  }
  return seen.filter((sql) => /^\s*SELECT/i.test(sql));
}

/** Map each alias (and bare table name) in a statement to its table. */
function aliases(sql: string): Map<string, string> {
  const map = new Map<string, string>();
  const keywords = new Set(["ON", "WHERE", "JOIN", "LEFT", "INNER", "GROUP", "ORDER", "USING"]);
  for (const m of sql.matchAll(/\b(?:FROM|JOIN)\s+(\w+)(?:\s+(?:AS\s+)?(\w+))?/gi)) {
    const [, table, alias] = m;
    map.set(table, table);
    if (alias && !keywords.has(alias.toUpperCase())) map.set(alias, table);
  }
  return map;
}

/** The plan's steps that touch a table that grows with trade, as `table: detail`. */
function bigTableSteps(sql: string): string[] {
  const placeholders = sql.match(/\?/g)?.length ?? 0;
  const rows = getDb()
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...Array(placeholders).fill(null)) as { detail: string }[];
  const tables = aliases(sql);
  return rows
    .map((r) => {
      const subject = r.detail.match(/^(?:SCAN|SEARCH) (\w+)/)?.[1];
      const table = subject ? tables.get(subject) : undefined;
      return table && BIG_TABLES.has(table) ? `${table}: ${r.detail}` : null;
    })
    .filter((s): s is string => s !== null);
}

let venueId: number;
const tomorrow = addDays(todayISO(), 1);

beforeAll(() => {
  const venue = listVenues()[0];
  venueId = venue.id;
  // A booking on the day, so the day list goes on to count its no-shows.
  const made = createBooking({
    courtId: venue.courts[0].id,
    date: tomorrow,
    hours: [10],
    name: "Aina",
    phone: "0123456789",
  });
  expect(made.ok).toBe(true);
});

describe("reading a venue's own bookings never reads the whole table", () => {
  const cases: [string, () => unknown][] = [
    ["the venue page", () => getAvailability(venueId, tomorrow)],
    ["the day list", () => listBookingsForDate(tomorrow, venueId)],
    ["the no-show count", () => countNoShows("0123456789")],
    ["the report", () => venueReport(venueId, todayISO(), addDays(todayISO(), 30))],
  ];

  for (const [name, call] of cases) {
    it(name, () => {
      const statements = statementsRunBy(call);
      expect(statements.length).toBeGreaterThan(0);
      const scans = statements.flatMap(bigTableSteps).filter((step) => step.includes(": SCAN "));
      expect(scans).toEqual([]);
    });
  }

  it("the report goes to this venue's courts, not to every venue's dates", () => {
    const steps = statementsRunBy(() =>
      venueReport(venueId, todayISO(), addDays(todayISO(), 30))
    ).flatMap(bigTableSteps);
    expect(steps.length).toBeGreaterThan(0);
    // idx_bookings_date answers "every booking in the period", whichever venue.
    expect(steps.filter((s) => s.includes("idx_bookings_date"))).toEqual([]);
  });
});
