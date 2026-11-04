/// <reference types="vite/client" />
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { registerUser, type User } from "../src/lib/auth";
import { guardianEntrant, type Entrant } from "../src/lib/competition-entrants";
import { templateByKey, templateFor, templatesFor } from "../src/lib/competition-templates";
import { MAX_ATTEMPTS, compareTallies, fieldStats, formatTally, rankCounted, readUnits, startOrder, tallyOf, type CountedUnit } from "../src/lib/counted-performances";
import { getDb } from "../src/lib/db";
import { addManaged } from "../src/lib/managed-people";
import { rankPerformances } from "../src/lib/performance-math";
import { namedForThePublic } from "../src/lib/public-names";
import { setEventRated } from "../src/lib/ratings";
import { createCourt, listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { parseRules, readRules, type CountedRules } from "../src/lib/tournament-rules";
import {
  createTournament,
  enter,
  enterAs,
  makeDraw,
  makeFinal,
  previewPerformances,
  recordPerformances,
  takeOut,
  tournamentDetail,
  type PerformanceInput,
  type TournamentDetail,
  type TournamentInput,
} from "../src/lib/tournaments";
import * as matchRoute from "../src/app/api/admin/tournaments/[id]/matches/[matchId]/route";
import * as publicRoute from "../src/app/api/tournaments/[id]/route";

/**
 * Counted performances (docs/features/tournaments.md#counted-performances): a competitor's result is a set of counts,
 * bouldering tops and zones or a height, ranked by the event's published rules, through the same path as any performance
 * result. The arithmetic first, against hand-worked examples and as properties; then whole events.
 */

const U = (unit: number, attempts: number, zone: number | null = null, top: number | null = null): CountedUnit => ({ unit, attempts, zone, top });
/** As sent to the route: the same, a plain record. */
const sent = (units: CountedUnit[]): object[] => units.map((u) => ({ ...u }));

const FULL: CountedRules["rankBy"] = ["tops", "zones", "attempts_top", "attempts_zone"];
const SIMPLE: CountedRules["rankBy"] = ["tops", "zones"];
const read = (units: object[], units_ = 4) => {
  const r = readUnits(units, { kind: "boulders", units: units_ });
  if (!r.ok) throw new Error(r.error);
  return r.units;
};

describe("the arithmetic of counts", () => {
  // Climber A on four boulders: boulder 1 topped on the 2nd attempt (zone on the 1st), boulder 2 topped first go, boulder 3
  // the zone on the 3rd attempt and no top (5 attempts in all), boulder 4 nothing (3 attempts).
  const a = read([U(1, 2, 1, 2), U(2, 1, null, 1), U(3, 5, 3, null), U(4, 3)]);

  it("counts tops, zones and the attempts it took to reach each, and ignores attempts that reached nothing", () => {
    expect(tallyOf(a)).toMatchObject({ tops: 2, zones: 3, attemptsTop: 3, attemptsZone: 1 + 1 + 3 });
    // A top is a zone too, on the same attempt where none was marked earlier.
    expect(a[1]).toMatchObject({ zone: 1, top: 1 });
    expect(formatTally(tallyOf(a), { kind: "boulders", rankBy: FULL })).toBe("2T 3Z 3 5");
    expect(formatTally(tallyOf(a), { kind: "boulders", rankBy: SIMPLE })).toBe("2T 3Z");
  });

  it("ranks tops over zones over fewer attempts to top over fewer attempts to zone, and shares a place level on all four", () => {
    const climbers = [
      { entryId: 1, status: "ok" as const, counts: read([U(1, 1, 1, 1), U(2, 1, 1, 1), U(3, 2, 2, 2)]) }, // 3T 3Z, 4 attempts to top, 4 to zone
      { entryId: 2, status: "ok" as const, counts: read([U(1, 1, 1, 1), U(2, 1, 1, 1), U(3, 6, 1, 6)]) }, // 3T 3Z, 8, 3
      { entryId: 3, status: "ok" as const, counts: read([U(1, 1, 1, 1), U(2, 1, 1, 1), U(3, 4, 4)]) }, // 2T 3Z, 2, 6
      { entryId: 4, status: "ok" as const, counts: read([U(1, 1, 1, 1), U(2, 1, 1, 1), U(3, 2, 2)]) }, // 2T 3Z, 2, 4: ahead of 3 on attempts to zone
      { entryId: 5, status: "ok" as const, counts: read([U(1, 1, 1, 1), U(2, 1, 1, 1), U(3, 2, 2)]) }, // level with 4 on all four
      { entryId: 6, status: "ok" as const, counts: read([U(1, 3, 3, 3), U(2, 1, 1), U(3, 1, 1), U(4, 1, 1)]) }, // 1T 4Z: fewer tops, more zones
      { entryId: 7, status: "ok" as const, counts: read([U(1, 1, 1, 1)]) }, // 1T 1Z, one attempt: still ahead of any number of zones with no top
      { entryId: 8, status: "ok" as const, counts: read([U(1, 2, 1), U(2, 2, 2), U(3, 3, 1), U(4, 2, 2)]) }, // 0T 4Z
      { entryId: 9, status: "dns" as const },
    ];
    const ranked = rankCounted(climbers, { rankBy: FULL, countback: false });
    expect(ranked.map((r) => [r.entryId, r.rank])).toEqual([
      [1, 1],
      [2, 2],
      [4, 3],
      [5, 3],
      [3, 5],
      [6, 6],
      [7, 7],
      [8, 8],
      [9, null],
    ]);
    // 6 has one top like 7 and more zones (4 against 1); 7's single top still beats 8's four zones with none.
    expect(tallyOf(climbers[5].counts!)).toMatchObject({ tops: 1, zones: 4 });
    expect(tallyOf(climbers[7].counts!)).toMatchObject({ tops: 0, zones: 4 });
  });

  it("with tops then zones only, attempts do not split anybody", () => {
    const climbers = [
      { entryId: 1, status: "ok" as const, counts: read([U(1, 1, 1, 1), U(2, 1, 1, 1), U(3, 2, 2, 2)]) },
      { entryId: 2, status: "ok" as const, counts: read([U(1, 1, 1, 1), U(2, 1, 1, 1), U(3, 6, 1, 6)]) },
      { entryId: 3, status: "ok" as const, counts: read([U(1, 1, 1, 1), U(2, 1, 1, 1), U(3, 4, 4)]) },
    ];
    expect(rankCounted(climbers, { rankBy: SIMPLE, countback: false }).map((r) => [r.entryId, r.rank])).toEqual([
      [1, 1],
      [2, 1],
      [3, 3],
    ]);
    // The full format splits the first two.
    expect(rankCounted(climbers, { rankBy: FULL, countback: false }).map((r) => [r.entryId, r.rank])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  });

  it("shares a place and skips the next (1, 2, 2, 4), and puts those with no result last and unranked", () => {
    const one = read([U(1, 1, 1, 1)]);
    const ranked = rankCounted(
      [
        { entryId: 10, status: "dq", counts: one },
        { entryId: 11, status: "ok", counts: one },
        { entryId: 12, status: "ok", counts: read([U(1, 2, 2, 2)]) },
        { entryId: 13, status: "ok", counts: read([U(1, 2, 2, 2)]) },
        { entryId: 14, status: "ok", counts: read([U(1, 3, 3, 3)]) },
        { entryId: 15, status: "pending" },
        { entryId: 16, status: "dnf" },
      ],
      { rankBy: FULL, countback: false }
    );
    expect(ranked.map((r) => [r.entryId, r.rank])).toEqual([
      [11, 1],
      [12, 2],
      [13, 2],
      [14, 4],
      [10, null],
      [15, null],
      [16, null],
    ]);
  });

  it("splits a tie by the better earlier placing only where the countback rule is on; level there too, they share", () => {
    const same = read([U(1, 1, 1, 1)]);
    const rows = [
      { entryId: 1, status: "ok" as const, counts: same },
      { entryId: 2, status: "ok" as const, counts: same },
      { entryId: 3, status: "ok" as const, counts: same },
      { entryId: 4, status: "ok" as const, counts: same },
    ];
    const before = new Map<number, number | null>([
      [1, 3],
      [2, 1],
      [3, 3],
    ]); // 4 has no earlier placing
    expect(rankCounted(rows, { rankBy: SIMPLE, countback: false }, before).map((r) => [r.entryId, r.rank])).toEqual([[1, 1], [2, 1], [3, 1], [4, 1]]);
    expect(rankCounted(rows, { rankBy: SIMPLE, countback: true }, before).map((r) => [r.entryId, r.rank])).toEqual([
      [2, 1],
      [1, 2],
      [3, 2],
      [4, 4],
    ]);
    // Countback never overrides a count: a better earlier placing does not lift somebody with fewer tops.
    const fewer = [{ entryId: 5, status: "ok" as const, counts: read([U(1, 1, 1)]) }, ...rows];
    expect(rankCounted(fewer, { rankBy: SIMPLE, countback: true }, new Map([[5, 1]])).at(-1)).toMatchObject({ entryId: 5, rank: 5 });
  });

  it("ranks a height: a partial hold beats the hold below, fewer attempts break a tie, a hold of nothing is a result", () => {
    const route = (hold: number, attempts: number, plus = false) => {
      const r = readUnits([{ unit: 1, attempts, hold, plus }], { kind: "height", units: 1 });
      if (!r.ok) throw new Error(r.error);
      return r.units;
    };
    const rules = { rankBy: ["height", "attempts_height"] as CountedRules["rankBy"], countback: false };
    const ranked = rankCounted(
      [
        { entryId: 1, status: "ok", counts: route(12, 2) },
        { entryId: 2, status: "ok", counts: route(12, 1, true) },
        { entryId: 3, status: "ok", counts: route(12, 1) },
        { entryId: 4, status: "ok", counts: route(7, 1) },
        { entryId: 5, status: "ok", counts: route(0, 1) },
        { entryId: 6, status: "ok", counts: route(7, 1) },
      ],
      rules
    );
    expect(ranked.map((r) => [r.entryId, r.rank])).toEqual([
      [2, 1],
      [3, 2],
      [1, 3],
      [4, 4],
      [6, 4],
      [5, 6],
    ]);
    expect(formatTally(tallyOf(route(12, 3, true)), { kind: "height", rankBy: rules.rankBy })).toBe("12+ (3)");
    expect(formatTally(tallyOf(route(12, 3)), { kind: "height", rankBy: ["height"] })).toBe("12");
  });

  it("starts the final with the worst placed, or the best (the setting), and counts how many topped each boulder", () => {
    expect(startOrder([1, 2, 3], { finalStart: "reverse" })).toEqual([3, 2, 1]);
    expect(startOrder([1, 2, 3], { finalStart: "ranking" })).toEqual([1, 2, 3]);
    const stats = fieldStats(
      [
        { entryId: 1, status: "ok", counts: read([U(1, 1, 1, 1), U(2, 2, 2)]) },
        { entryId: 2, status: "ok", counts: read([U(1, 3, 1, 3)]) },
        { entryId: 3, status: "dns" },
      ],
      { kind: "boulders", units: 3 }
    );
    expect(stats).toEqual([
      { unit: 1, tops: 2, zones: 2, climbers: 2 },
      { unit: 2, tops: 0, zones: 1, climbers: 2 },
      { unit: 3, tops: 0, zones: 0, climbers: 2 },
    ]);
  });

  it("reads what a judge enters against how a climb goes, and says what is wrong", () => {
    const bad = (units: unknown, rules: { kind: "boulders" | "height"; units: number } = { kind: "boulders", units: 3 }) => {
      const r = readUnits(units, rules);
      return r.ok ? "ok" : r.error;
    };
    expect(bad([])).toMatch(/at least one boulder/);
    expect(bad(undefined)).toMatch(/at least one boulder/);
    expect(bad([U(4, 1)])).toMatch(/numbered 1 to 3/);
    expect(bad([U(1, 1), U(1, 2)])).toMatch(/Boulder 1 is given twice/);
    expect(bad([U(1, 0)])).toMatch(/attempts are 1 to 99/);
    expect(bad([U(1, MAX_ATTEMPTS + 1)])).toMatch(/attempts are 1 to 99/);
    expect(bad([U(1, 2, 3)])).toMatch(/zone is reached on an attempt that was made/);
    expect(bad([U(1, 2, null, 3)])).toMatch(/top is reached on an attempt that was made/);
    // The zone is no later than the top; the climb ends at the top.
    expect(bad([U(1, 3, 3, 2)])).toMatch(/no later than the top/);
    expect(bad([U(1, 4, 1, 2)])).toMatch(/ends at the top, on attempt 2, not 4/);
    expect(bad([{ unit: 1, attempts: 1, hold: 3 }])).toMatch(/not a hold/);
    expect(bad(["x"])).toMatch(/set of counts/);
    expect(bad([{ unit: 1, attempts: 2.5 }])).toMatch(/attempts are/);
    // A height: one route, a hold, no zone or top.
    const height = { kind: "height" as const, units: 1 };
    expect(bad([{ unit: 1, attempts: 2, hold: 9, plus: true }], height)).toBe("ok");
    expect(bad([{ unit: 2, attempts: 2, hold: 9 }], height)).toMatch(/one route/);
    expect(bad([{ unit: 1, attempts: 2, hold: 9, top: 2 }], height)).toMatch(/no zone or top/);
    expect(bad([{ unit: 1, attempts: 2, hold: 201 }], height)).toMatch(/0 to 200/);
    expect(bad([{ unit: 1, attempts: 2, hold: 9, plus: "yes" }], height)).toMatch(/\+/);
    // Not every boulder need be entered: one left out was not climbed.
    expect(read([U(3, 1, 1, 1)])).toHaveLength(1);
  });

  it("is deterministic and independent of the order given: random fields, both rank configurations, replayed", () => {
    let seed = 20261103;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const pick = (n: number) => Math.floor(next() * n);
    for (let trial = 0; trial < 150; trial++) {
      const n = 2 + pick(11);
      const rows = Array.from({ length: n }, (_, i) => {
        const units: CountedUnit[] = [];
        for (let u = 1; u <= 4; u++) {
          if (pick(4) === 0) continue;
          const attempts = 1 + pick(5);
          const top = pick(3) === 0 ? attempts : null;
          const zone = top !== null ? 1 + pick(top) : pick(2) === 0 ? 1 + pick(attempts) : null;
          units.push(U(u, attempts, zone, top));
        }
        return { entryId: i + 1, status: units.length === 0 || pick(12) === 0 ? ("dns" as const) : ("ok" as const), counts: units.length === 0 ? [] : read(units) };
      });
      for (const rankBy of [FULL, SIMPLE]) {
        const rules = { rankBy, countback: false };
        const ranked = rankCounted(rows, rules);
        const ok = ranked.filter((r) => r.status === "ok");
        // A place is one more than the number of climbers strictly ahead, so level climbers share and the next is skipped.
        for (const r of ok) expect(r.rank).toBe(1 + ok.filter((o) => compareTallies(o.tally, r.tally, rankBy) < 0).length);
        for (const r of ranked.filter((x) => x.status !== "ok")) expect(r.rank).toBeNull();
        // Nothing depends on the order the rows come in, and the same counts rank the same each time.
        const shuffled = [...rows].sort(() => next() - 0.5);
        const again = rankCounted(shuffled, rules);
        expect(new Map(again.map((r) => [r.entryId, r.rank]))).toEqual(new Map(ranked.map((r) => [r.entryId, r.rank])));
        // A better count never ranks behind a worse one.
        for (const x of ok) for (const y of ok) if (compareTallies(x.tally, y.tally, rankBy) < 0) expect(x.rank!).toBeLessThan(y.rank!);
      }
    }
  });

  it("is what rankPerformances does for a counted event, and leaves a marks event alone", () => {
    const counted = rankPerformances(
      [
        { entryId: 1, status: "ok", attempts: [], result: 1, counts: read([U(1, 1, 1, 1)]) },
        { entryId: 2, status: "ok", attempts: [], result: 2, counts: read([U(1, 1, 1, 1), U(2, 1, 1, 1)]) },
      ],
      { aggregate: "best", better: "higher", counted: { kind: "boulders", units: 2, rankBy: FULL, countback: false, finalStart: "reverse", cutTies: "choose" } }
    );
    expect(counted.map((r) => [r.entryId, r.rank])).toEqual([[2, 1], [1, 2]]);
    const marks = rankPerformances(
      [
        { entryId: 1, status: "ok", attempts: [7.1], result: 7.1 },
        { entryId: 2, status: "ok", attempts: [7.4], result: 7.4 },
      ],
      { aggregate: "best", better: "higher" }
    );
    expect(marks.map((r) => [r.entryId, r.rank])).toEqual([[2, 1], [1, 2]]);
  });
});

describe("the rules and templates of a counted event", () => {
  it("is offered for bouldering and climbing, and is data: no engine of its own", () => {
    expect(templateFor("bouldering").key).toBe("bouldering_tops_zones_attempts");
    expect(templatesFor("bouldering").map((t) => t.key).slice(0, 2)).toEqual(["bouldering_tops_zones_attempts", "bouldering_tops_zones"]);
    expect(templateFor("climbing").key).toBe("climbing_height");
    expect(templateByKey("bouldering_tops_zones_attempts")!.rules.performance!.counted).toMatchObject({ kind: "boulders", rankBy: FULL, units: 4 });
    expect(templateByKey("bouldering_tops_zones")!.rules.performance!.counted).toMatchObject({ rankBy: SIMPLE });
    expect(templateByKey("climbing_height")!.rules.performance!.counted).toMatchObject({ kind: "height", countback: true });
    // A counted event measures nothing: the marks' settings are fixed so nothing reads them as one.
    expect(templateByKey("bouldering_tops_zones")!.rules.performance).toMatchObject({ measure: "score", better: "higher", attempts: 1, aggregate: "best" });
  });

  it("is laid over the template's one choice at a time and checked; a marks event has no counted rules", () => {
    const base = templateByKey("bouldering_tops_zones_attempts")!.rules;
    const ok = parseRules({ performance: { counted: { units: 6, rankBy: SIMPLE, countback: true, finalStart: "ranking", cutTies: "all" } } }, base);
    if (!ok.ok) throw new Error(ok.error);
    expect(ok.rules.performance!.counted).toEqual({ kind: "boulders", units: 6, rankBy: SIMPLE, countback: true, finalStart: "ranking", cutTies: "all" });
    expect(ok.rules.performance).toMatchObject({ heatSize: 20, finalSize: 6 });
    const refused = (counted: unknown) => {
      const r = parseRules({ performance: { counted } }, base);
      return r.ok ? "ok" : r.error;
    };
    expect(refused({ units: 0 })).toMatch(/1 to 40/);
    expect(refused({ units: 41 })).toMatch(/1 to 40/);
    expect(refused({ rankBy: [] })).toMatch(/Rank by/);
    expect(refused({ rankBy: ["tops", "tops"] })).toMatch(/once each/);
    expect(refused({ rankBy: ["height"] })).toMatch(/Rank by/);
    expect(refused({ kind: "swimming" })).toMatch(/boulders/);
    expect(refused({ kind: "height", units: 3 })).toMatch(/one route/);
    expect(refused({ countback: "yes" })).toMatch(/heats break a tie/);
    expect(refused({ finalStart: "random" })).toMatch(/reverse/);
    expect(refused({ cutTies: "toss" })).toMatch(/choose/);
    expect(refused("tops")).toMatch(/set of choices/);
    // null makes it an event of marks; counted rules on a marks template make it a counted one.
    const marks = parseRules({ performance: { counted: null, measure: "time" } }, base);
    if (!marks.ok) throw new Error(marks.error);
    expect(marks.rules.performance!.counted).toBeUndefined();
    const made = parseRules({ performance: { counted: { kind: "height" } } }, templateByKey("best_attempt")!.rules);
    if (!made.ok) throw new Error(made.error);
    expect(made.rules.performance!.counted).toMatchObject({ kind: "height", units: 1, rankBy: ["height", "attempts_height"] });
    // Stored and read back the same; a stored marks event is unchanged by any of this.
    expect(readRules(JSON.stringify(ok.rules)).performance!.counted).toEqual(ok.rules.performance!.counted);
    expect("counted" in readRules(JSON.stringify(templateByKey("swimming_heats")!.rules)).performance!).toBe(false);
    expect(readRules(JSON.stringify({ performance: { counted: { kind: "height", rankBy: ["tops"] } } })).performance!.counted!.rankBy).toEqual(["height", "attempts_height"]);
  });
});

// ------------------------------------------------------------ whole events

let ownerId: number;
let n = 0;
let dayOffset = 3;

async function player(name = "Climber"): Promise<User> {
  n++;
  const made = await registerUser({ name: `${name} Wall${n}`, email: `w${n}@wall.my`, phone: `01360${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now'), verified_phone = phone WHERE id = ?").run(made.user.id);
  return made.user;
}

async function venueWith(sport: string) {
  let venue = (await listVenues()).find((v) => v.courts.some((c) => c.sport === sport));
  if (!venue) {
    const made = await createCourt({ venueId: (await listVenues())[0].id, name: `${sport} wall`, sport, offPeakRate: 20, peakRate: 30 });
    if (!made.ok) throw new Error(made.error);
    venue = (await listVenues()).find((v) => v.courts.some((c) => c.sport === sport))!;
  }
  return { venueId: venue.id, courtIds: venue.courts.filter((c) => c.sport === sport).slice(0, 1).map((c) => c.id) };
}

async function competition(over: Partial<TournamentInput> & { sport: string }) {
  const day = addDays(todayISO(), dayOffset++);
  const where = await venueWith(over.sport);
  const made = await createTournament(
    { ...where, name: `Wall Cup ${dayOffset}`, format: "performance", teamSize: 1, level: null, entryFee: 0, maxEntries: 32, startsOn: day, endsOn: day, startHour: 8, endHour: 20, ...over } as TournamentInput,
    ownerId
  );
  if (!made.ok) throw new Error(made.error);
  return made.value;
}

const ok = <T,>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

/** What each climber (by their number in the field) does in the groups, as units, or "dns"; and in the final. */
type Plan = Record<number, CountedUnit[] | "dns" | "dnf">;

/** Enter `count` climbers, draw, and return the way to find each in the detail. */
async function wall(count: number, over: Partial<TournamentInput> = {}, sport = "bouldering") {
  const t = await competition({ sport, template: "bouldering_tops_zones_attempts", ...over });
  const ids: number[] = [];
  for (let i = 0; i < count; i++) ids.push(ok(await enter(await player(), t.id)).id);
  const d = ok(await makeDraw(t.id, () => 0.3));
  return { t, ids, d };
}

const detail = async (id: number) => (await tournamentDetail(id, { forStaff: true }))!;
const heats = (d: TournamentDetail) => d.matches.filter((m) => m.stage === "heat");
const finalOf = (d: TournamentDetail) => d.matches.find((m) => m.stage === "final")!;
const line = (d: TournamentDetail, matchId: number, entryId: number) => d.performance!.lines[matchId].find((l) => l.entryId === entryId)!;
const rankOf = (d: TournamentDetail, entryId: number) => d.performance!.ranking.find((r) => r.entryId === entryId)!;
/** A climber's place among all the groups together (the final's field is listed under the final until it has results), and their line in their group. */
const groupPlace = (d: TournamentDetail, ids: number[], i: number) => d.performance!.heatRanking.find((r) => r.entryId === ids[i])!.rank;
const groupLine = (d: TournamentDetail, ids: number[], i: number) => {
  const h = heats(d).find((x) => d.performance!.lines[x.id].some((l) => l.entryId === ids[i]))!;
  return line(d, h.id, ids[i]);
};

/** Record a round: each line of the match as the plan says by the climber's number in `ids`. */
async function record(matchId: number, d: TournamentDetail, ids: number[], plan: Plan, confirm?: { token: string }) {
  const inIt = d.performance!.lines[matchId].map((l) => l.entryId);
  const lines: PerformanceInput[] = inIt
    .filter((id) => plan[ids.indexOf(id)] !== undefined)
    .map((id) => {
      const p = plan[ids.indexOf(id)];
      return typeof p === "string" ? { entryId: id, status: p } : { entryId: id, counts: sent(p) };
    });
  return recordPerformances(matchId, lines, confirm);
}

/** The groups' results for the eight-climber field below (3 boulders), by number; hand-worked in the test that uses them. */
const GROUPS: Plan = {
  0: [U(1, 2, 1, 2), U(2, 1, null, 1), U(3, 3)], //                    2T 2Z, attempts 3 and 2
  1: [U(1, 1, 1, 1), U(2, 3, 2, 3), U(3, 2, 1)], //                    2T 3Z, 4 and 4
  2: [U(1, 1, 1, 1), U(2, 1, 1, 1), U(3, 5, 3, 5)], //                 3T 3Z, 7 and 5
  3: [U(1, 4, 2), U(2, 3)], //                                         0T 1Z
  4: [U(1, 3, 3, 3), U(2, 2, 1)], //                                   1T 2Z, 3 and 4
  5: [U(1, 2, 1, 2), U(2, 2, 1)], //                                   1T 2Z, 2 and 2
  6: [U(1, 1, 1, 1), U(2, 3, 2, 3), U(3, 2, 1)], //                    2T 3Z, 4 and 4: level with 1
  7: "dns",
};

async function playGroups(d: TournamentDetail, ids: number[], plan: Plan = GROUPS) {
  let now = d;
  for (const h of heats(d)) now = ok(await record(h.id, now, ids, plan));
  return now;
}

describe("a bouldering qualification and final", () => {
  const rules = { performance: { heatSize: 4, finalSize: 3, counted: { units: 3 } } };

  it("draws groups by lot into an order of start, ranks them by the published rules, and fills the final from the best", async () => {
    const { t, ids, d } = await wall(8, { rules });
    expect(t.template).toBe("bouldering_tops_zones_attempts");
    expect(heats(d)).toHaveLength(2);
    expect(finalOf(d)).toBeDefined();
    // Each group starts 1, 2, 3, 4 (an order of start, not lanes from the middle out); the final has nobody until the groups are in.
    for (const h of heats(d)) expect(d.performance!.lines[h.id].map((l) => l.lane).sort()).toEqual([1, 2, 3, 4]);
    expect(d.performance!.lines[finalOf(d).id]).toHaveLength(0);
    // Everybody has an order of start, and nothing is a mark.
    expect(d.entries.every((e) => e.entryMark === null)).toBe(true);

    const now = await playGroups(d, ids);
    // Hand-worked: 3T (2) first; 2T 3Z 4 4 twice (1 and 6) share second; 2T 2Z (0) fourth; 1T 2Z 2 2 (5) fifth, then (4) with 3 4;
    // 0T 1Z (3); the climber who did not start has no place.
    expect([2, 1, 6, 0, 5, 4, 3, 7].map((i) => groupPlace(now, ids, i))).toEqual([1, 2, 2, 4, 5, 6, 7, null]);
    expect(groupLine(now, ids, 1).shown).toBe("2T 3Z 4 4");
    expect(groupLine(now, ids, 2).shown).toBe("3T 3Z 7 5");
    expect(groupLine(now, ids, 3).shown).toBe("0T 1Z 0 2");
    expect(groupLine(now, ids, 4).shown).toBe("1T 2Z 3 4");
    expect(groupLine(now, ids, 7).status).toBe("dns");
    // The top three (level second place both through: they fit) swim the final, the worst placed first.
    const inFinal = now.performance!.lines[finalOf(now).id];
    expect(inFinal).toHaveLength(3);
    expect(inFinal.sort((a, b) => a.lane - b.lane).map((l) => l.entryId)).toEqual([ids[6], ids[1], ids[2]]);
    expect(now.matches.filter((m) => m.stage === "heat").every((m) => m.status === "done")).toBe(true);
    // How many of the field topped each boulder, across the groups.
    expect(now.performance!.field!.heat).toEqual([
      { unit: 1, tops: 6, zones: 7, climbers: 7 },
      { unit: 2, tops: 4, zones: 6, climbers: 7 },
      { unit: 3, tops: 1, zones: 3, climbers: 7 },
    ]);
  });

  it("runs the final to a finish: the final's order, then everybody else by their groups; level counts share a place", async () => {
    const { t, ids, d } = await wall(8, { rules });
    let now = await playGroups(d, ids);
    const final = finalOf(now);
    // Final: 1 tops one boulder fewer than 2; 6 and 2 level (3 boulders... one each) on all four counts.
    now = ok(
      await record(final.id, now, ids, {
        1: [U(1, 2, 1, 2), U(2, 1, 1, 1), U(3, 4, 2)], // 2T 3Z 3 4
        2: [U(1, 1, 1, 1), U(2, 3, 3, 3), U(3, 6, 3)], //  2T 3Z 4 7
        6: [U(1, 1, 1, 1), U(2, 3, 3, 3), U(3, 6, 3)], //  level with 2
      })
    );
    expect(now.status).toBe("finished");
    const order = now.performance!.ranking.slice(0, 3).map((r) => [r.entryId, r.rank, r.stage]);
    expect(order).toEqual([
      [ids[1], 1, "final"],
      [ids[2], 2, "final"],
      [ids[6], 2, "final"],
    ]);
    // After the finalists, the rest by their groups, ranked on from the final's size; the one who did not start has no place.
    expect(now.performance!.ranking.slice(3).map((r) => [r.entryId, r.rank])).toEqual([
      [ids[0], 4],
      [ids[5], 5],
      [ids[4], 6],
      [ids[3], 7],
      [ids[7], null],
    ]);
    expect(now.performance!.field!.final[0]).toEqual({ unit: 1, tops: 3, zones: 3, climbers: 3 });
    // The public page shows the same thing, with the counts for each competitor.
    const publicView = (await tournamentDetail(t.id))!;
    expect(publicView.performance!.ranking[0].tally).toMatchObject({ tops: 2, zones: 3, attemptsTop: 3, attemptsZone: 4 });
  });

  it("starts the final in the order the rules say, and an organiser's setting can put the best first", async () => {
    const { ids, d } = await wall(8, { rules: { performance: { heatSize: 4, finalSize: 3, counted: { units: 3, finalStart: "ranking" } } } });
    const now = await playGroups(d, ids);
    expect(now.performance!.lines[finalOf(now).id].sort((a, b) => a.lane - b.lane).map((l) => l.entryId)).toEqual([ids[2], ids[1], ids[6]]);
  });

  it("asks the organiser to choose when climbers are level for the last place, or takes all of them where the rules say so", async () => {
    // Final of two: 2 is first, 1 and 6 are level for the last place.
    const choose = await wall(8, { rules: { performance: { heatSize: 4, finalSize: 2, counted: { units: 3 } } } });
    let now = await playGroups(choose.d, choose.ids);
    expect(now.performance!.lines[finalOf(now).id]).toHaveLength(0);
    expect(now.performance!.tieForFinal?.sort()).toEqual([choose.ids[1], choose.ids[6]].sort());
    expect(await makeFinal(choose.t.id, [choose.ids[1], choose.ids[6]])).toMatchObject({ ok: false });
    now = ok(await makeFinal(choose.t.id, [choose.ids[6]]));
    expect(now.performance!.lines[finalOf(now).id].map((l) => l.entryId).sort()).toEqual([choose.ids[2], choose.ids[6]].sort());

    const all = await wall(8, { rules: { performance: { heatSize: 4, finalSize: 2, counted: { units: 3, cutTies: "all" } } } });
    now = await playGroups(all.d, all.ids);
    expect(now.performance!.tieForFinal).toBeNull();
    expect(now.performance!.lines[finalOf(now).id].map((l) => l.entryId).sort()).toEqual([all.ids[2], all.ids[1], all.ids[6]].sort());
  });

  it("splits a tie in the final by the groups where the venue turns the countback on, and shares the place where it does not", async () => {
    const level: Plan = {
      1: [U(1, 1, 1, 1), U(2, 1, 1, 1), U(3, 2, 1)],
      2: [U(1, 1, 1, 1), U(2, 1, 1, 1), U(3, 2, 1)],
    };
    for (const countback of [false, true]) {
      const { ids, d } = await wall(8, { rules: { performance: { heatSize: 4, finalSize: 3, counted: { units: 3, countback } } } });
      let now = await playGroups(d, ids);
      // In the groups 2 was ahead of 1 on attempts; in the final they are level on every count.
      const final = finalOf(now);
      now = ok(await record(final.id, now, ids, { ...level, 6: [U(1, 3, 3), U(2, 1)] }));
      const r = (i: number) => rankOf(now, ids[i]).rank;
      expect([r(2), r(1)]).toEqual(countback ? [1, 2] : [1, 1]);
    }
  });

  it("an organiser's club format ranks by tops then zones only, with no final, and finishes on the one round", async () => {
    const t = await competition({ sport: "bouldering", template: "bouldering_tops_zones" });
    const ids = [] as number[];
    for (let i = 0; i < 4; i++) ids.push(ok(await enter(await player(), t.id)).id);
    const d = ok(await makeDraw(t.id, () => 0.2));
    expect(d.matches.filter((m) => m.stage === "final")).toHaveLength(0);
    expect(heats(d)).toHaveLength(1);
    const now = ok(
      await record(heats(d)[0].id, d, ids, {
        0: [U(1, 1, 1, 1), U(2, 1, 1, 1), U(3, 2, 1)], // 2T 3Z
        1: [U(1, 3, 3, 3), U(2, 5, 4, 5), U(3, 4, 4)], // 2T 3Z with far more attempts: level in the club format
        2: [U(1, 1, 1, 1), U(2, 3)], //                    1T 1Z
        3: "dnf",
      })
    );
    expect(now.status).toBe("finished");
    expect(now.performance!.ranking.map((r) => [r.entryId, r.rank, r.shown])).toEqual([
      [ids[0], 1, "2T 3Z"],
      [ids[1], 1, "2T 3Z"],
      [ids[2], 3, "1T 1Z"],
      [ids[3], null, null],
    ]);
  });

  it("ranks a climbing event by height: a partial hold ahead of the hold, fewer attempts next, and the groups decide a level final", async () => {
    const t = await competition({ sport: "climbing", rules: { performance: { heatSize: 4, finalSize: 2 } } });
    expect(t.template).toBe("climbing_height");
    const ids = [] as number[];
    for (let i = 0; i < 5; i++) ids.push(ok(await enter(await player(), t.id)).id);
    let d = ok(await makeDraw(t.id, () => 0.9));
    const route = (hold: number, attempts: number, plus = false) => [{ unit: 1, attempts, hold, plus }];
    const lines = (plan: Record<number, object[] | string>, match: number) =>
      d.performance!.lines[match].map((l) => {
        const p = plan[ids.indexOf(l.entryId)];
        return typeof p === "string" ? { entryId: l.entryId, status: p as PerformanceInput["status"] } : { entryId: l.entryId, counts: p };
      });
    const groupPlan = { 0: route(14, 1), 1: route(14, 2, true), 2: route(14, 2), 3: route(9, 1), 4: route(9, 1) };
    for (const h of heats(d)) {
      const mine = d.performance!.lines[h.id].map((l) => l.entryId);
      const plan = Object.fromEntries(Object.entries(groupPlan).filter(([i]) => mine.includes(ids[Number(i)])));
      d = ok(await recordPerformances(h.id, lines(plan, h.id)));
    }
    // 14+ (climber 1) first, then 14 with 1 attempt (0), 14 with 2 (2), then two level on 9.
    expect(d.performance!.heatRanking.map((r) => [r.entryId, r.rank])).toEqual([
      [ids[1], 1],
      [ids[0], 2],
      [ids[2], 3],
      [ids[3], 4],
      [ids[4], 4],
    ]);
    expect(groupLine(d, ids, 1).shown).toBe("14+ (2)");
    expect(groupLine(d, ids, 0).shown).toBe("14 (1)");
    expect(d.performance!.lines[finalOf(d).id].map((l) => l.entryId).sort()).toEqual([ids[0], ids[1]].sort());
    // In the final the two are level on height and attempts: with the countback on (the template's rule) the better group placing decides.
    const done = ok(await recordPerformances(finalOf(d).id, d.performance!.lines[finalOf(d).id].map((l) => ({ entryId: l.entryId, counts: route(15, 1) }))));
    expect(done.status).toBe("finished");
    expect(done.performance!.ranking.slice(0, 2).map((r) => [r.entryId, r.rank])).toEqual([
      [ids[1], 1],
      [ids[0], 2],
    ]);
    expect(done.performance!.ranking.slice(2).map((r) => [r.entryId, r.rank])).toEqual([
      [ids[2], 3],
      [ids[3], 4],
      [ids[4], 4],
    ]);
  });
});

describe("a correction to a counted round", () => {
  const rules = { performance: { heatSize: 4, finalSize: 3, counted: { units: 3 } } };
  const topsAll = [U(1, 1, 1, 1), U(2, 1, 1, 1), U(3, 1, 1, 1)];

  it("re-ranks the round at once; one that changes who is in the final needs the preview and its confirmation", async () => {
    const { t, ids, d } = await wall(8, { rules });
    let now = await playGroups(d, ids);
    const heatOfZero = heats(now).find((h) => now.performance!.lines[h.id].some((l) => l.entryId === ids[0]))!;
    // Climber 0 was fourth. The judge finds they topped all three: first, ahead of 2 on fewer attempts, and the cut is now a tie.
    const better: PerformanceInput[] = [{ entryId: ids[0], counts: sent(topsAll) }];
    const blind = await recordPerformances(heatOfZero.id, better);
    expect(blind).toMatchObject({ ok: false, code: "CONFIRM" });
    // Nothing was written by the refused attempt.
    expect(line(await detail(t.id), heatOfZero.id, ids[0]).tally).toMatchObject({ tops: 2 });

    const preview = ok(await previewPerformances(heatOfZero.id, better));
    expect(preview.consequential).toBe(true);
    const said = preview.changes.join(" ");
    expect(said).toMatch(/2T 2Z 3 2 becomes 3T 3Z 3 3/);
    expect(said).toMatch(/place 4 becomes place 1/);
    expect(said).toMatch(/Climbers are now level for the final's last place/);
    expect(preview.changePhrases.length).toBe(preview.changes.length);
    // The preview changed nothing either.
    expect((await detail(t.id)).performance!.lines[finalOf(now).id].map((l) => l.entryId).sort()).toEqual([ids[1], ids[2], ids[6]].sort());

    // Confirmed against a different change: refused; against the change previewed: made.
    expect(await recordPerformances(heatOfZero.id, [{ entryId: ids[0], counts: sent([U(1, 1, 1, 1)]) }], { token: preview.token })).toMatchObject({ ok: false, code: "CHANGED" });
    now = ok(await recordPerformances(heatOfZero.id, better, { token: preview.token }));
    expect(rankOf(now, ids[0]).rank).toBe(1);
    // 1 and 6 are level for the last place of three: the final is emptied until the organiser chooses, as it was before it was first filled.
    expect(now.performance!.lines[finalOf(now).id]).toHaveLength(0);
    expect(now.performance!.tieForFinal?.sort()).toEqual([ids[1], ids[6]].sort());
    now = ok(await makeFinal(t.id, [ids[1]]));
    // Best first by rank, the worst placed starting: 1 (chosen), then 2, then the new leader.
    expect(now.performance!.lines[finalOf(now).id].sort((a, b) => a.lane - b.lane).map((l) => l.entryId)).toEqual([ids[1], ids[2], ids[0]]);
  });

  it("a correction that leaves the final's field as it was is made at once, even after the final has results", async () => {
    const { t, ids, d } = await wall(8, { rules });
    let now = await playGroups(d, ids);
    now = ok(await record(finalOf(now).id, now, ids, { 1: [U(1, 1, 1, 1)], 2: [U(1, 1, 1, 1), U(2, 1, 1, 1)], 6: [U(1, 1)] }));
    expect(now.status).toBe("finished");
    const heatOf = (i: number) => heats(now).find((h) => now.performance!.lines[h.id].some((l) => l.entryId === ids[i]))!;
    // The last placed climber's count is put right, and stays last: nothing downstream changes, so nothing is asked.
    const fix = [{ entryId: ids[3], counts: sent([U(1, 4, 2), U(2, 3, 1)]) }];
    expect(ok(await previewPerformances(heatOf(3).id, fix)).consequential).toBe(false);
    now = ok(await recordPerformances(heatOf(3).id, fix));
    expect(rankOf(now, ids[3]).shown).toBe("0T 2Z 0 3");
    expect(rankOf(now, ids[3]).rank).toBe(7);
    expect(now.status).toBe("finished");
    // One that would change who swam the final is refused (the final has results), with nothing changed.
    const would = [{ entryId: ids[0], counts: sent(topsAll) }];
    expect(await recordPerformances(heatOf(0).id, would)).toMatchObject({ ok: false, error: expect.stringMatching(/The final has results/) });
    expect(await previewPerformances(heatOf(0).id, would)).toMatchObject({ ok: false, error: expect.stringMatching(/The final has results/) });
    expect(rankOf(await detail(t.id), ids[0]).rank).toBe(4);
    // The final's own results are corrected freely, and re-rank the final.
    expect((await detail(t.id)).performance!.lines[finalOf(now).id]).toHaveLength(3);
    now = ok(await recordPerformances(finalOf(now).id, [{ entryId: ids[6], counts: sent(topsAll) }]));
    expect(rankOf(now, ids[6]).rank).toBe(1);
  });

  it("an organiser's choice among those level stands through a correction that does not touch them, and is asked again when it does", async () => {
    const { t, ids, d } = await wall(8, { rules: { performance: { heatSize: 4, finalSize: 2, counted: { units: 3 } } } });
    let now = await playGroups(d, ids);
    now = ok(await makeFinal(t.id, [ids[6]]));
    const heatOf = (i: number) => heats(now).find((h) => now.performance!.lines[h.id].some((l) => l.entryId === ids[i]))!;
    // The last placed is corrected: the choice stands, the final is as it was, nothing asked.
    const small = [{ entryId: ids[3], counts: sent([U(1, 4, 2), U(2, 3, 1)]) }];
    expect(ok(await previewPerformances(heatOf(3).id, small)).consequential).toBe(false);
    now = ok(await recordPerformances(heatOf(3).id, small));
    expect(now.performance!.lines[finalOf(now).id].map((l) => l.entryId).sort()).toEqual([ids[2], ids[6]].sort());
    // One of those level is corrected to be behind the other: nobody is level any more, and the final is the best two.
    const worse = [{ entryId: ids[6], counts: sent([U(1, 1, 1, 1)]) }];
    const preview = ok(await previewPerformances(heatOf(6).id, worse));
    expect(preview.consequential).toBe(true);
    now = ok(await recordPerformances(heatOf(6).id, worse, { token: preview.token }));
    expect(now.performance!.tieForFinal).toBeNull();
    expect(now.performance!.lines[finalOf(now).id].map((l) => l.entryId).sort()).toEqual([ids[1], ids[2]].sort());
  });

  it("replaying the corrected results from scratch gives the same placings as the corrected event", async () => {
    // Event A: wrong counts first, put right (the field changes, and is confirmed), then the final. Event B: the right counts straight away.
    const six = [U(1, 1, 1, 1), U(2, 3, 2, 3), U(3, 2, 2)]; // 2T 3Z 4 5: behind 1, so nobody is level at the cut
    const final: Plan = { 0: [U(1, 1, 1, 1), U(2, 1, 1, 1), U(3, 2, 1)], 2: [U(1, 1, 1, 1), U(2, 2, 2, 2)], 1: [U(1, 3, 3)] };
    const wrong: Plan = { ...GROUPS, 6: six, 0: [U(1, 4)], 5: topsAll };
    const right: Plan = { ...GROUPS, 6: six, 0: topsAll, 5: [U(1, 4)] };
    const a = await wall(8, { rules });
    let da = await playGroups(a.d, a.ids, wrong);
    for (const h of heats(da)) {
      const mine = da.performance!.lines[h.id].map((l) => l.entryId);
      const fixes = mine.filter((id) => JSON.stringify(wrong[a.ids.indexOf(id)]) !== JSON.stringify(right[a.ids.indexOf(id)]));
      if (fixes.length === 0) continue;
      const lines = fixes.map((id) => ({ entryId: id, counts: sent(right[a.ids.indexOf(id)] as CountedUnit[]) }));
      const tried = await recordPerformances(h.id, lines);
      const p = tried.ok ? null : ok(await previewPerformances(h.id, lines));
      da = ok(await recordPerformances(h.id, lines, p ? { token: p.token } : undefined));
    }
    da = ok(await record(finalOf(da).id, da, a.ids, final));
    const b = await wall(8, { rules });
    let db = await playGroups(b.d, b.ids, right);
    db = ok(await record(finalOf(db).id, db, b.ids, final));
    const shape = (d: TournamentDetail, ids: number[]) =>
      ids.map((id) => {
        const r = d.performance!.ranking.find((x) => x.entryId === id)!;
        return [r.rank, r.shown, r.stage];
      });
    expect(shape(da, a.ids)).toEqual(shape(db, b.ids));
    expect(da.status).toBe("finished");
    expect(db.status).toBe("finished");
  });

  it("writes nothing when one line in a save is wrong: all of it or none", async () => {
    const { t, ids, d } = await wall(8, { rules });
    const h = heats(d)[0];
    const mine = d.performance!.lines[h.id].map((l) => l.entryId);
    const bad = await recordPerformances(h.id, [
      { entryId: mine[0], counts: sent([U(1, 1, 1, 1)]) },
      { entryId: mine[1], counts: sent([U(1, 2, 1, 1)]) }, // topped on 1 with 2 attempts: the climb ends at the top
    ]);
    expect(bad).toMatchObject({ ok: false, error: expect.stringMatching(/ends at the top/) });
    expect(line(await detail(t.id), h.id, mine[0]).status).toBe("pending");
    expect(ids).toHaveLength(8);
  });
});

describe("who is out, and refusals", () => {
  const rules = { performance: { heatSize: 4, finalSize: 3, counted: { units: 3 } } };

  it("a climber who withdraws does not start what is left; one disqualified keeps their record and has no place", async () => {
    const { t, ids, d } = await wall(8, { rules });
    ok(await takeOut(ids[3], "withdrawn"));
    let now = await detail(t.id);
    const heatOf = (i: number) => heats(now).find((h) => now.performance!.lines[h.id].some((l) => l.entryId === ids[i]))!;
    expect(line(now, heatOf(3).id, ids[3]).status).toBe("dns");
    now = await playGroups(now, ids, { ...GROUPS, 3: undefined as never });
    // 7 did not start; 3 withdrew: both have no place. 6 climbers are placed.
    expect(now.performance!.heatRanking.filter((r) => r.rank !== null)).toHaveLength(6);
    ok(await takeOut(ids[2], "disqualified", "Used a hold marked out of bounds, seen by the judge"));
    now = await detail(t.id);
    const dq = line(now, heatOf(2).id, ids[2]);
    expect(dq).toMatchObject({ status: "dq", rank: null });
    // Their counts are kept as the judge recorded them.
    expect(dq.counts!.map((u) => u.top)).toEqual([1, 1, 5]);
    // The final was filled already: they are in it, but do not start it.
    expect(d.entries).toHaveLength(8);
    expect(line(now, finalOf(now).id, ids[2]).status).toBe("dns");
  });

  it("refuses counts for marks and marks for counts, an entry mark, and a result for somebody not in the round", async () => {
    const { t, ids, d } = await wall(8, { rules });
    const h = heats(d)[0];
    const mine = d.performance!.lines[h.id].map((l) => l.entryId);
    expect(await recordPerformances(h.id, [{ entryId: mine[0], attempts: ["7.42"] }])).toMatchObject({ ok: false, error: "This event takes a count for each boulder, not a mark." });
    expect(await recordPerformances(h.id, [{ entryId: mine[0] }])).toMatchObject({ ok: false, error: expect.stringMatching(/at least one boulder/) });
    expect(await recordPerformances(h.id, [{ entryId: mine[0], counts: [] }])).toMatchObject({ ok: false });
    expect(await recordPerformances(h.id, [{ entryId: ids.find((i) => !mine.includes(i))!, counts: sent([U(1, 1, 1, 1)]) }])).toMatchObject({ ok: false, error: "Somebody given is not in it." });
    expect(await recordPerformances(finalOf(d).id, [{ entryId: mine[0], counts: sent([U(1, 1, 1, 1)]) }])).toMatchObject({ ok: false, error: "Nobody is in it yet." });
    // A marks event takes no counts.
    const swim = await competition({ sport: "swimming" });
    const swimmer = ok(await enter(await player(), swim.id));
    ok(await enter(await player(), swim.id));
    const swum = ok(await makeDraw(swim.id, () => 0.5));
    expect(await recordPerformances(heats(swum)[0].id, [{ entryId: swimmer.id, counts: sent([U(1, 1, 1, 1)]) }])).toMatchObject({ ok: false, error: "This event takes marks, not counts." });
    // No entry mark in an event drawn by lot.
    const late = await competition({ sport: "bouldering", template: "bouldering_tops_zones" });
    expect(await enter(await player(), late.id, { entryMark: "12" })).toMatchObject({ ok: false, error: expect.stringMatching(/no entry mark/) });
    expect((await enter(await player(), late.id)).ok).toBe(true);
    expect(t.id).toBeGreaterThan(0);
  });

  it("is never rated: marking it rated is refused with a message, and a result in it reaches no ledger", async () => {
    const { t } = await wall(4, { rules });
    const refused = await setEventRated("tournament", t.id, true);
    expect(refused).toMatchObject({ ok: false, code: "RT_PERFORMANCE", status: 409 });
    expect(refused.ok ? "" : refused.error).toMatch(/not rated/);
    // Switching it off is no change, and not an error.
    expect(await setEventRated("tournament", t.id, false)).toMatchObject({ ok: true, value: { rated: false } });
    expect(((await getDb().prepare("SELECT rated FROM tournaments WHERE id = ?").get(t.id)) as { rated: boolean }).rated).toBe(false);
    // A performance event of marks the same.
    const swim = await competition({ sport: "swimming" });
    expect(await setEventRated("tournament", swim.id, true)).toMatchObject({ ok: false, code: "RT_PERFORMANCE" });
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM rated_results").get()) as { n: number }).n).toBe(0);
  });
});

describe("juniors, guardians and what the public sees", () => {
  it("names a declared minor by first name and initial on the public page, and in full to staff; results go the same way as an adult's", async () => {
    const t = await competition({ sport: "bouldering", template: "bouldering_tops_zones", rules: { performance: { counted: { units: 3 } } } });
    const mum = await player("Mum");
    const kid = await addManaged(mum.id, { displayName: "Aina Binti Lim", relationship: "parent", authority: true }, mum.name);
    if (!kid.ok) throw new Error(kid.error);
    const kidEntry = ok(await enterAs((await guardianEntrant(mum, kid.person.id)) as Entrant, t.id));
    const adult = await player("Adam");
    const adultEntry = ok(await enter(adult, t.id));
    const d = ok(await makeDraw(t.id, () => 0.5));
    // A child's result is entered the way anybody's is, by the same path.
    const done = ok(
      await recordPerformances(heats(d)[0].id, [
        { entryId: kidEntry.id, counts: sent([U(1, 2, 1, 2), U(2, 1, 1, 1)]) },
        { entryId: adultEntry.id, counts: sent([U(1, 1, 1, 1)]) },
      ])
    );
    expect(done.entries.find((e) => e.id === kidEntry.id)!.name).toBe("Aina Binti Lim");
    expect(rankOf(done, kidEntry.id).rank).toBe(1);
    // The public page: the child short, the adult as entered; the counts and places are there for both.
    const pub = await namedForThePublic((await tournamentDetail(t.id))!);
    expect(pub.entries.find((e) => e.id === kidEntry.id)!.name).toBe("Aina L.");
    expect(pub.entries.find((e) => e.id === adultEntry.id)!.name).toBe(adultEntry.name);
    expect(pub.performance!.ranking[0]).toMatchObject({ entryId: kidEntry.id, rank: 1 });
    // The route says the same, and carries the child's full name nowhere.
    const res = await publicRoute.GET(new NextRequest(`http://localhost/api/tournaments/${t.id}`), { params: Promise.resolve({ id: String(t.id) }) });
    const text = JSON.stringify(await res.json());
    expect(text).toContain("Aina L.");
    expect(text).not.toContain("Aina Binti Lim");
    // A tournament that shows everybody short does so for adults too.
    await getDb().prepare("UPDATE tournaments SET live_names = 'short' WHERE id = ?").run(t.id);
    const everybody = await namedForThePublic((await tournamentDetail(t.id))!);
    expect(everybody.entries.find((e) => e.id === adultEntry.id)!.name).toMatch(/^\S+ \w\.$/);
    // An event of another kind is shown as it always was.
    const swim = await competition({ sport: "swimming" });
    const swimmer = ok(await enter(await player(), swim.id));
    expect((await namedForThePublic((await tournamentDetail(swim.id))!)).entries.find((e) => e.id === swimmer.id)!.name).toBe(swimmer.name);
  });
});

describe("a performance event of marks, the same path", () => {
  it("accepts a heat correction that leaves the final's field as it was after the final has results, and refuses one that changes it", async () => {
    const t = await competition({ sport: "swimming" });
    const ids: number[] = [];
    for (let i = 0; i < 10; i++) ids.push(ok(await enter(await player("Swimmer"), t.id, { entryMark: (60 + i * 0.5).toFixed(2) })).id);
    let d = ok(await makeDraw(t.id, () => 0.3));
    const time = (k: number) => `1:0${Math.floor(k / 2)}.${10 + k}`;
    for (const h of heats(d)) d = ok(await recordPerformances(h.id, d.performance!.lines[h.id].map((l) => ({ entryId: l.entryId, attempts: [time(ids.indexOf(l.entryId))] }))));
    const final = finalOf(d);
    const inFinal = d.performance!.lines[final.id];
    expect(inFinal).toHaveLength(8);
    d = ok(await recordPerformances(final.id, inFinal.map((l) => ({ entryId: l.entryId, attempts: [`1:0${ids.indexOf(l.entryId) % 5}.50`] }))));
    expect(d.status).toBe("finished");
    const heatOf = (i: number) => heats(d).find((h) => d.performance!.lines[h.id].some((l) => l.entryId === ids[i]))!;
    // The ninth fastest is corrected to a slightly different time, and is still outside the eight: the final stands as swum.
    d = ok(await recordPerformances(heatOf(8).id, [{ entryId: ids[8], attempts: ["1:04.99"] }]));
    expect(d.performance!.lines[final.id]).toHaveLength(8);
    expect(d.performance!.lines[final.id].every((l) => l.status === "ok")).toBe(true);
    // One who would have been in the final is another matter: refused, and nothing changed.
    const refused = await recordPerformances(heatOf(8).id, [{ entryId: ids[8], attempts: ["58.00"] }]);
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/The final has results/) });
    expect((await detail(t.id)).performance!.lines[heatOf(8).id].find((l) => l.entryId === ids[8])!.shown).toBe("1:04.99");
  });
});

describe("through the staff route", () => {
  it("records counts, previews a correction, and confirms it against the preview; the log says what each line was and is", async () => {
    const { t, ids, d } = await wall(8, { rules: { performance: { heatSize: 4, finalSize: 3, counted: { units: 3 } } } });
    const owner = (await listAdmins())[0];
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(owner.id)).token}`;
    const post = (matchId: number, body: object, as = cookie) =>
      matchRoute.POST(
        new NextRequest(`http://localhost/api/admin/tournaments/${t.id}/matches/${matchId}`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: as, origin: "http://localhost" },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: String(t.id), matchId: String(matchId) }) }
      );
    let now = d;
    for (const h of heats(d)) {
      const mine = d.performance!.lines[h.id].map((l) => l.entryId);
      const performances = mine.filter((id) => GROUPS[ids.indexOf(id)] !== undefined).map((id) => {
        const p = GROUPS[ids.indexOf(id)];
        return typeof p === "string" ? { entryId: id, status: p } : { entryId: id, counts: sent(p) };
      });
      const res = await post(h.id, { performances });
      expect(res.status).toBe(200);
      now = (await res.json()).tournament;
    }
    expect(now.performance!.heatRanking[0]).toMatchObject({ entryId: ids[2], rank: 1 });
    const h0 = heats(now).find((h) => now.performance!.lines[h.id].some((l) => l.entryId === ids[0]))!;
    const better = [{ entryId: ids[0], counts: sent([U(1, 1, 1, 1), U(2, 1, 1, 1), U(3, 1, 1, 1)]) }];
    // Not confirmed: asked to preview. Previewed: what it changes, and a token. Confirmed: made.
    const blind = await post(h0.id, { performances: better });
    expect(blind.status).toBe(409);
    expect((await blind.json()).code).toBe("CONFIRM");
    const previewed = await (await post(h0.id, { performances: better, preview: true })).json();
    expect(previewed.preview.consequential).toBe(true);
    expect(previewed.preview.changes.join(" ")).toMatch(/final/);
    const stale = await post(h0.id, { performances: [{ entryId: ids[0], counts: sent([U(1, 1, 1, 1)]) }], confirm: { token: previewed.preview.token } });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe("CHANGED");
    const made = await post(h0.id, { performances: better, confirm: { token: previewed.preview.token } });
    expect(made.status).toBe(200);
    // A bad count is a refusal, not a server error.
    const bad = await post(h0.id, { performances: [{ entryId: ids[0], counts: [{ unit: 9, attempts: 1 }] }], preview: true });
    expect(bad.status).toBe(409);
    expect((await bad.json()).error).toMatch(/numbered 1 to 3/);
    // The activity log carries each line's result and what it replaced.
    const logged = (await getDb().prepare("SELECT detail FROM staff_actions WHERE action = 'tournament.performances' ORDER BY id DESC LIMIT 1").get()) as { detail: string };
    expect(logged.detail).toMatch(/2T 2Z 3 2/);
    expect(logged.detail).toMatch(/3T 3Z 3 3/);
    // Front desk enters results too, as for any performance event.
    const desk = await createAdmin({ name: "Desk", email: `deskwall${Date.now()}@wall.my`, password: "desk-password", venueId: t.venueId, role: "desk" });
    if (!desk.ok) throw new Error(desk.error);
    const deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
    const h1 = heats(now).find((h) => h.id !== h0.id)!;
    const mine = now.performance!.lines[h1.id].map((l) => l.entryId);
    expect((await post(h1.id, { performances: [{ entryId: mine[0], counts: sent([U(1, 1, 1, 1)]) }], preview: true }, deskCookie)).status).toBe(200);
  });
});

beforeAll(async () => {
  await ensureBootstrapAdmin();
  ownerId = (await listAdmins())[0].id;
});
