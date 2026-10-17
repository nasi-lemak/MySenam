import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { getDb, withTransaction } from "../src/lib/db";
import type { Statement } from "../src/lib/db";
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
 * joined court. Nothing failed — the answers were right — they just took
 * seconds once a few hundred venues were on one install.
 *
 * Timing would make a flaky test, so this asks Postgres instead. It records
 * each query the real function runs, with the values it ran with, and has
 * Postgres plan it again with sequential scans switched off. On tables this
 * small the planner would happily read every row anyway; with scans off it
 * reads them only when no index can answer the query — which is exactly the
 * mistake this is here to catch.
 */

const BIG_TABLES = new Set(["bookings", "booking_slots", "slot_blocks", "classes"]);

/** Every SELECT a call runs, with the values it ran with. */
async function queriesRunBy(fn: () => Promise<unknown>): Promise<{ sql: string; params: unknown[] }[]> {
  const db = getDb();
  const prepare = db.prepare;
  const seen: { sql: string; params: unknown[] }[] = [];
  db.prepare = ((sql: string): Statement => {
    const real = prepare.call(db, sql);
    const record = (params: unknown[]) => {
      if (/^\s*SELECT/i.test(sql)) seen.push({ sql, params });
    };
    return {
      get: (...p) => (record(p), real.get(...p)),
      all: (...p) => (record(p), real.all(...p)),
      run: (...p) => (record(p), real.run(...p)),
    };
  }) as typeof db.prepare;
  try {
    await fn();
  } finally {
    db.prepare = prepare;
  }
  return seen;
}

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
}

/** Each step of the plan that reads a table which grows with trade. */
async function bigTableSteps(q: { sql: string; params: unknown[] }): Promise<string[]> {
  return withTransaction(async () => {
    const db = getDb();
    await db.prepare("SET LOCAL enable_seqscan = off").run();
    const [row] = (await db.prepare(`EXPLAIN (FORMAT JSON) ${q.sql}`).all(...q.params)) as {
      "QUERY PLAN": { Plan: PlanNode }[];
    }[];
    const steps: string[] = [];
    const walk = (node: PlanNode) => {
      const table = node["Relation Name"];
      if (table && BIG_TABLES.has(table))
        steps.push(`${table}: ${node["Node Type"]}${node["Index Name"] ? ` using ${node["Index Name"]}` : ""}`);
      node.Plans?.forEach(walk);
    };
    walk(row["QUERY PLAN"][0].Plan);
    return steps;
  });
}

async function stepsOf(fn: () => Promise<unknown>): Promise<string[]> {
  const steps: string[] = [];
  for (const q of await queriesRunBy(fn)) steps.push(...(await bigTableSteps(q)));
  return steps;
}

let venueId: number;
const tomorrow = addDays(todayISO(), 1);

beforeAll(async () => {
  const venue = (await listVenues())[0];
  venueId = venue.id;
  // A booking on the day, so the day list goes on to count its no-shows.
  const made = await createBooking({
    courtId: venue.courts[0].id,
    date: tomorrow,
    hours: [10],
    name: "Aina",
    phone: "0123456789",
  });
  expect(made.ok).toBe(true);
});

describe("reading a venue's own bookings never reads the whole table", () => {
  const cases: [string, () => Promise<unknown>][] = [
    ["the venue page", () => getAvailability(venueId, tomorrow)],
    ["the day list", () => listBookingsForDate(tomorrow, venueId)],
    ["the no-show count", () => countNoShows("0123456789")],
    ["the report", () => venueReport(venueId, todayISO(), addDays(todayISO(), 30))],
  ];

  for (const [name, call] of cases) {
    it(name, async () => {
      const steps = await stepsOf(call);
      expect(steps.length).toBeGreaterThan(0);
      expect(steps.filter((s) => s.includes("Seq Scan"))).toEqual([]);
    });
  }
});
