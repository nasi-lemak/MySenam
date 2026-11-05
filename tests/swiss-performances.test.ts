/// <reference types="vite/client" />
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { registerUser, type User } from "../src/lib/auth";
import { guardianEntrant, type Entrant } from "../src/lib/competition-entrants";
import type { CountedUnit } from "../src/lib/counted-performances";
import { getDb } from "../src/lib/db";
import { addManaged } from "../src/lib/managed-people";
import { namedForThePublic } from "../src/lib/public-names";
import { setEventRated } from "../src/lib/ratings";
import { createCourt, listVenues } from "../src/lib/store";
import { seededRandom } from "../src/lib/swiss";
import { cumulativeRanking, expectedGrouping, heatSizes, planHeats, previewRegroup, regroupFrom, roundPlacings } from "../src/lib/swiss-performances";
import { addOfficial } from "../src/lib/match-reports";
import { officialPerformances, officialPerformanceView, requestCorrection } from "../src/lib/official-performances";
import { addDays, todayISO } from "../src/lib/time";
import { swissRefusal } from "../src/lib/tournament-rules";
import {
  createTournament,
  enter,
  enterAs,
  makeDraw,
  previewPerformances,
  recordPerformances,
  setRules,
  takeOut,
  tournamentDetail,
  type PerformanceInput,
  type TournamentDetail,
  type TournamentInput,
} from "../src/lib/tournaments";
import * as adminTournament from "../src/app/api/admin/tournaments/[id]/route";
import * as publicRoute from "../src/app/api/tournaments/[id]/route";

/**
 * A counted event played in Swiss rounds (ADR 0038, docs/features/tournaments.md#swiss-for-performance-events): each round's groups are
 * formed from the standing the rounds before left, every round is the event's own counted ranking across all its groups, the standing adds
 * the placings up under a rule that is data, and a correction flags a later round's groups for review rather than moving anybody. The
 * arithmetic first, as examples and properties; then whole events.
 */

const U = (unit: number, attempts: number, zone: number | null = null, top: number | null = null): CountedUnit => ({ unit, attempts, zone, top });

describe("the size of the groups", () => {
  it("is as even as can be, never leaves one alone, and never sits anybody out", () => {
    for (let size = 2; size <= 12; size++)
      for (let count = 1; count <= 70; count++) {
        const sizes = heatSizes(count, size);
        expect(sizes.reduce((a, b) => a + b, 0)).toBe(count);
        expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
        expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
        if (count >= 2) expect(Math.min(...sizes)).toBeGreaterThanOrEqual(2);
        expect(sizes.length).toBe(Math.min(Math.max(1, Math.ceil(count / size)), Math.max(1, Math.floor(count / 2))));
        // A group is the size the event sets, or one more where the alternative is a group of one.
        expect(Math.max(...sizes)).toBeLessThanOrEqual(size + 1);
      }
    expect(heatSizes(3, 2)).toEqual([3]);
    expect(heatSizes(5, 4)).toEqual([3, 2]);
    expect(heatSizes(10, 4)).toEqual([4, 3, 3]);
    expect(heatSizes(8, 4)).toEqual([4, 4]);
    expect(heatSizes(1, 4)).toEqual([1]);
    expect(heatSizes(0, 4)).toEqual([]);
  });

  it("forms the groups from the best first: adjacent places together, the best group last to climb and the worst of each group first, or the best first throughout", () => {
    const field = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(planHeats(field, 4, "reverse")).toEqual([
      { heat: 1, entries: [10, 9, 8] },
      { heat: 2, entries: [7, 6, 5] },
      { heat: 3, entries: [4, 3, 2, 1] },
    ]);
    expect(planHeats(field, 4, "ranking")).toEqual([
      { heat: 1, entries: [1, 2, 3, 4] },
      { heat: 2, entries: [5, 6, 7] },
      { heat: 3, entries: [8, 9, 10] },
    ]);
    const rand = seededRandom(7);
    for (let trial = 0; trial < 100; trial++) {
      const size = 2 + Math.floor(rand() * 9);
      const count = 1 + Math.floor(rand() * 40);
      const ids = Array.from({ length: count }, (_, i) => i + 1);
      for (const mode of ["reverse", "ranking"] as const) {
        const heats = planHeats(ids, size, mode);
        // Everybody once; each group is a contiguous run of the order.
        expect(heats.flatMap((h) => h.entries).sort((a, b) => a - b)).toEqual(ids);
        for (const h of heats) {
          const sorted = [...h.entries].sort((a, b) => a - b);
          expect(sorted[sorted.length - 1] - sorted[0]).toBe(sorted.length - 1);
        }
      }
    }
  });
});

describe("a round's placings and the standing across rounds", () => {
  it("places those with a result by their rank (level share, the next skipped) and those without one a place behind the last who has one", () => {
    const placed = roundPlacings([1, 2, 3, 4, 5, 6], [{ entryId: 1, rank: 1 }, { entryId: 2, rank: 2 }, { entryId: 3, rank: 2 }, { entryId: 4, rank: 4 }, { entryId: 5, rank: null }]);
    expect([...placed]).toEqual([[1, 1], [2, 2], [3, 2], [4, 4], [5, 5], [6, 5]]);
    // Nobody with a result: everybody first.
    expect([...roundPlacings([1, 2], [])]).toEqual([[1, 1], [2, 1]]);
  });

  it("adds the placings up (the fewest wins), or the best N, and splits what is level by the better placings, then the initial order, sharing a place only where nothing else does", () => {
    const rounds = [new Map([[1, 1], [2, 2], [3, 3], [4, 4]]), new Map([[1, 3], [2, 4], [3, 1], [4, 2]]), new Map([[1, 4], [2, 1], [3, 2], [4, 3]])];
    const initial = new Map([[1, 1], [2, 2], [3, 3], [4, 4]]);
    // Totals: 1: 8, 2: 7, 3: 6, 4: 9.
    const sum = cumulativeRanking([1, 2, 3, 4], initial, rounds, { cumulative: "sum_of_placings", bestN: null });
    expect(sum.map((l) => [l.entryId, l.total, l.rank])).toEqual([[3, 6, 1], [2, 7, 2], [1, 8, 3], [4, 9, 4]]);
    expect(sum[0]).toMatchObject({ placings: [3, 1, 2], counted: [3, 1, 2] });
    // The best two of three: 1: 1+3, 2: 1+2, 3: 1+2, 4: 2+3. 2 and 3 are level on the total; the third placing, which does not count towards it,
    // is the countback: 3's is a 3 and 2's is a 4, so 3 is ahead.
    const best = cumulativeRanking([1, 2, 3, 4], initial, rounds, { cumulative: "best_n", bestN: 2 });
    expect(best.map((l) => [l.entryId, l.total])).toEqual([[3, 3], [2, 3], [1, 4], [4, 5]]);
    expect(best[0].counted).toEqual([1, 2]);
    expect(best[1].tie).toEqual({ above: 3, by: "countback", ahead: 3, behind: 4 });
    expect(best.map((l) => l.rank)).toEqual([1, 2, 3, 4]);
    // Level on the total and on every placing: the seed orders them, and they share the place.
    const level = cumulativeRanking([1, 2], new Map([[1, 2], [2, 1]]), [new Map([[1, 1], [2, 3]]), new Map([[1, 3], [2, 1]]), new Map([[1, 2], [2, 2]])], { cumulative: "sum_of_placings", bestN: null });
    expect(level.map((l) => [l.entryId, l.total, l.rank, l.order])).toEqual([[2, 6, 1, 1], [1, 6, 1, 2]]);
    expect(level[1].tie).toMatchObject({ above: 2, by: "seed", ahead: 1, behind: 2 });
    // Level on the total, split by the better placings: 1 has a first place (1, 4, 4) where 2's best is a second (2, 3, 4), whatever the seed says.
    const split = cumulativeRanking([1, 2], new Map([[1, 2], [2, 1]]), [new Map([[1, 1], [2, 2]]), new Map([[1, 4], [2, 3]]), new Map([[1, 4], [2, 4]])], { cumulative: "sum_of_placings", bestN: null });
    expect(split.map((l) => [l.entryId, l.total, l.rank])).toEqual([[1, 9, 1], [2, 9, 2]]);
    expect(split[1].tie).toEqual({ above: 1, by: "countback", ahead: 1, behind: 2 });
  });

  it("is a total, deterministic order independent of the order the entries are given in, and its place is the number ranked ahead plus one", () => {
    const rand = seededRandom(99);
    for (let trial = 0; trial < 150; trial++) {
      const size = 2 + Math.floor(rand() * 10);
      const rounds = 1 + Math.floor(rand() * 4);
      const ids = Array.from({ length: size }, (_, i) => i + 1);
      const initial = new Map(ids.map((id) => [id, id]));
      const placings = Array.from({ length: rounds }, () => new Map(ids.map((id) => [id, 1 + Math.floor(rand() * size)])));
      const rule = rand() < 0.5 ? { cumulative: "sum_of_placings" as const, bestN: null } : { cumulative: "best_n" as const, bestN: 1 + Math.floor(rand() * rounds) };
      const a = cumulativeRanking(ids, initial, placings, rule);
      const b = cumulativeRanking([...ids].reverse(), initial, placings, rule);
      expect(b).toEqual(a);
      expect(a.map((l) => l.order)).toEqual(ids.map((_, i) => i + 1));
      for (let i = 1; i < a.length; i++) {
        expect(a[i].total).toBeGreaterThanOrEqual(a[i - 1].total);
        // Place: the same as the line above where nothing but the seed separates them, else the position.
        expect(a[i].rank === a[i - 1].rank || a[i].rank === i + 1).toBe(true);
      }
      for (const l of a) expect(l.total).toBe(l.counted.reduce((s, p) => s + p, 0));
    }
  });

  it("finds nobody to move when the groups stand, nobody when someone left, and exactly who changes group when the standing changed", () => {
    const heats = [{ heat: 1, members: [8, 7, 6, 5] }, { heat: 2, members: [4, 3, 2, 1] }];
    const standing = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(expectedGrouping(heats, standing, "reverse")).toEqual([]);
    // Somebody who left is not in the standing's order: the groups keep their sizes and move nobody.
    expect(expectedGrouping(heats, [1, 2, 3, 5, 6, 7, 8], "reverse")).toEqual([]);
    expect(expectedGrouping(heats, [1, 2, 4, 5, 6, 7, 8], "reverse")).toEqual([]);
    // 4 and 5 swap across the boundary.
    expect(expectedGrouping(heats, [1, 2, 3, 5, 4, 6, 7, 8], "reverse")).toEqual([{ entryId: 4, from: 2, to: 1 }, { entryId: 5, from: 1, to: 2 }]);
    // The order of start inside a group is not a grouping.
    expect(expectedGrouping(heats, [3, 1, 4, 2, 7, 8, 5, 6], "reverse")).toEqual([]);
  });
});

describe("the rules of a Swiss performance event", () => {
  const counted = { kind: "boulders" as const, units: 3, rankBy: ["tops" as const], countback: false, finalStart: "reverse" as const, cutTies: "choose" as const };
  const perf = (finalSize: number, withCounted = true) => ({ measure: "score" as const, better: "higher" as const, attempts: 1, aggregate: "best" as const, heatSize: 4, finalSize, ...(withCounted ? { counted } : {}) });
  const swiss = (over: object = {}) => ({ rounds: null, byePoints: null, tiebreaks: null, ...over });

  it("is for a counted event with no final, with at least two rounds and a best N that fits; and head-to-head settings are not for it", () => {
    expect(swissRefusal("performance", { performance: perf(0), swiss: swiss({ rounds: 3, cumulative: "sum_of_placings" }) })).toBeNull();
    expect(swissRefusal("performance", { performance: perf(0), swiss: swiss({ cumulative: "best_n", bestN: 2 }) })).toBeNull();
    expect(swissRefusal("performance", { performance: perf(0, false), swiss: swiss() })).toMatch(/counted performance event/);
    expect(swissRefusal("performance", { performance: perf(8), swiss: swiss() })).toMatch(/no final/);
    expect(swissRefusal("performance", { performance: perf(0), swiss: swiss({ rounds: 1 }) })).toMatch(/at least 2 rounds/);
    expect(swissRefusal("performance", { performance: perf(0), swiss: swiss({ cumulative: "best_n" }) })).toMatch(/how many/);
    expect(swissRefusal("performance", { performance: perf(0), swiss: swiss({ rounds: 3, cumulative: "best_n", bestN: 4 }) })).toMatch(/more than the rounds/);
    expect(swissRefusal("performance", { performance: perf(0), swiss: swiss({ acceleration: 1 }) })).toMatch(/head-to-head/);
    expect(swissRefusal("performance", { performance: perf(0), swiss: swiss({ byePoints: 1 }) })).toMatch(/head-to-head/);
    expect(swissRefusal("swiss", { performance: null, swiss: swiss({ cumulative: "sum_of_placings" }) })).toMatch(/performance event/);
    expect(swissRefusal("knockout", { performance: null, swiss: swiss() })).toBe("Swiss settings are for a Swiss event.");
    expect(swissRefusal("knockout", { performance: null, swiss: null })).toBeNull();
  });
});

// ------------------------------------------------------------------ whole events

let ownerId: number;
let n = 0;
let dayOffset = 3;
let managerCookie: string;
let deskCookie: string;

async function player(name = "Climber"): Promise<User> {
  n++;
  const made = await registerUser({ name: `${name} Sw${n}`, email: `sw${n}@swwall.my`, phone: `01350${String(n).padStart(5, "0")}`, password: "a long enough password" });
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
  return { venueId: venue.id, courtIds: venue.courts.filter((c) => c.sport === sport).slice(0, 2).map((c) => c.id) };
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const where = await venueWith("bouldering");
  const manager = await createAdmin({ name: "Musa Wall", email: "musa@swwall.test", password: "manager-pass-1", venueId: where.venueId });
  const desk = await createAdmin({ name: "Dina Wall", email: "dina@swwall.test", password: "desk-password-1", venueId: where.venueId, role: "desk" });
  if (!manager.ok || !desk.ok) throw new Error("staff");
  ownerId = manager.admin.id;
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(manager.admin.id)).token}`;
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
});

const SWISS = { rounds: 3, cumulative: "sum_of_placings" as const };
const rulesOf = (swiss: object = SWISS, performance: object = {}) => ({ swiss, performance: { heatSize: 4, finalSize: 0, counted: { units: 3 }, ...performance } });

async function competition(over: Partial<TournamentInput> = {}, days = 1) {
  const day = addDays(todayISO(), dayOffset);
  dayOffset += days + 1;
  const where = await venueWith("bouldering");
  const made = await createTournament(
    { ...where, name: `Swiss Wall ${dayOffset}`, sport: "bouldering", template: "bouldering_tops_zones_attempts", format: "performance", teamSize: 1, level: null, entryFee: 0, maxEntries: 32, startsOn: day, endsOn: addDays(day, days - 1), startHour: 8, endHour: 20, rules: rulesOf(), ...over } as TournamentInput,
    ownerId
  );
  if (!made.ok) throw new Error(made.error);
  return made.value;
}

const ok = <T,>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

const detail = async (id: number) => (await tournamentDetail(id, { forStaff: true }))!;
const heatsOf = (d: TournamentDetail, r: number) => d.matches.filter((m) => m.stage === "heat" && m.round === r).sort((a, b) => a.position - b.position);
const lineup = (d: TournamentDetail, matchId: number) => d.performance!.lines[matchId].slice().sort((a, b) => a.lane - b.lane).map((l) => l.entryId);
const initialOrder = async (id: number) => ((await getDb().prepare("SELECT id FROM tournament_entries WHERE tournament_id = ? AND swiss_rank IS NOT NULL ORDER BY swiss_rank").all(id)) as { id: number }[]).map((r) => r.id);

/** Eight levels of climbing, best first by index descending: each is distinct under the full ranking (tops, zones, attempts to top, to zone). */
const SKILL: CountedUnit[][] = [
  [U(1, 2, 2)], //                                     0: 0T 1Z
  [U(1, 2, 1), U(2, 2, 1)], //                         1: 0T 2Z
  [U(1, 3, 3, 3)], //                                  2: 1T 1Z, attempts to top 3
  [U(1, 1, 1, 1)], //                                  3: 1T 1Z, attempts to top 1
  [U(1, 1, 1, 1), U(2, 2, 2, 2)], //                   4: 2T, attempts to top 3
  [U(1, 1, 1, 1), U(2, 1, 1, 1)], //                   5: 2T, attempts to top 2
  [U(1, 1, 1, 1), U(2, 1, 1, 1), U(3, 3, 3, 3)], //    6: 3T, attempts to top 5
  [U(1, 1, 1, 1), U(2, 1, 1, 1), U(3, 1, 1, 1)], //    7: 3T, attempts to top 3
];
const sent = (units: CountedUnit[]): object[] => units.map((u) => ({ ...u }));
const without = (plan: Record<number, number>, id: number): Record<number, number> => Object.fromEntries(Object.entries(plan).filter(([k]) => Number(k) !== id));

/** A permutation of the levels for round r, so a climber's placing changes from round to round. */
const levelIn = (index: number, r: number) => ((r === 1 ? 1 : r === 2 ? 3 : 5) * index + (r - 1)) % 8;
/** What an eight-climber field does in round r: the level of the climber at `index` of `ids`. */
const planOf = (ids: number[], r: number): Record<number, number> => Object.fromEntries(ids.map((id, i) => [id, levelIn(i, r)]));

async function recordHeat(d: TournamentDetail, matchId: number, level: Record<number, number | "dns" | "dnf">, confirm?: { token: string }) {
  const lines: PerformanceInput[] = d.performance!.lines[matchId]
    .filter((l) => level[l.entryId] !== undefined)
    .map((l) => (typeof level[l.entryId] === "string" ? { entryId: l.entryId, status: level[l.entryId] as "dns" | "dnf" } : { entryId: l.entryId, counts: sent(SKILL[level[l.entryId] as number]) }));
  return recordPerformances(matchId, lines, confirm);
}

async function playRound(id: number, r: number, level: Record<number, number | "dns" | "dnf">) {
  let d = await detail(id);
  for (const h of heatsOf(d, r)) if (h.status === "scheduled") d = ok(await recordHeat(d, h.id, level));
  return d;
}

/** The standing, worked from the raw lines alone and the rules above, by nothing in lib/swiss-performances.ts: placings, totals, countback, seed. */
async function independentStanding(id: number, rule: { best?: number } = {}) {
  const d = await detail(id);
  const seed = new Map(((await getDb().prepare("SELECT id, swiss_rank FROM tournament_entries WHERE tournament_id = ? AND swiss_rank IS NOT NULL").all(id)) as { id: number; swiss_rank: number }[]).map((r) => [r.id, r.swiss_rank]));
  const rows = (await getDb().prepare("SELECT p.entry_id, p.status, p.counts, m.round, m.status AS mstatus FROM tournament_performances p JOIN tournament_matches m ON m.id = p.match_id WHERE p.tournament_id = ? AND m.stage = 'heat'").all(id)) as { entry_id: number; status: string; counts: string | null; round: number; mstatus: string }[];
  const rounds = [...new Set(rows.map((r) => r.round))].sort((a, b) => a - b).filter((r) => rows.filter((x) => x.round === r).every((x) => x.status !== "pending"));
  const score = (counts: CountedUnit[]) => {
    const tops = counts.filter((u) => u.top != null);
    const zones = counts.filter((u) => (u.zone ?? u.top) != null);
    return [tops.length, zones.length, -tops.reduce((s, u) => s + u.top!, 0), -zones.reduce((s, u) => s + (u.zone ?? u.top)!, 0)];
  };
  const placingsOf = new Map<number, number[]>([...seed.keys()].map((e) => [e, []]));
  for (const r of rounds) {
    const ok = rows.filter((x) => x.round === r && x.status === "ok").map((x) => ({ id: x.entry_id, s: score(JSON.parse(x.counts!) as CountedUnit[]) }));
    const better = (a: number[], b: number[]) => { for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };
    for (const e of seed.keys()) {
      const mine = ok.find((x) => x.id === e);
      placingsOf.get(e)!.push(mine ? 1 + ok.filter((x) => better(x.s, mine.s)).length : ok.length + 1);
    }
  }
  const lines = [...seed.keys()].map((e) => {
    const all = [...placingsOf.get(e)!].sort((a, b) => a - b);
    const counted = rule.best ? all.slice(0, rule.best) : placingsOf.get(e)!;
    return { id: e, total: counted.reduce((s, p) => s + p, 0), all, placings: placingsOf.get(e)! };
  });
  lines.sort((a, b) => a.total - b.total || (() => { for (let i = 0; i < a.all.length; i++) if (a.all[i] !== b.all[i]) return a.all[i] - b.all[i]; return 0; })() || seed.get(a.id)! - seed.get(b.id)!);
  return { lines, d };
}

describe("the draw", () => {
  it("is for a counted event: refused for marks, with a final, or with too few rounds; and forms round 1's groups from an initial order drawn from the recorded seed, with no final", async () => {
    const day = addDays(todayISO(), 400);
    const where = await venueWith("bouldering");
    const base = { ...where, name: "Rejected Wall", sport: "bouldering", format: "performance", teamSize: 1, level: null, entryFee: 0, maxEntries: 16, startsOn: day, endsOn: day, startHour: 8, endHour: 20 } as TournamentInput;
    expect(await createTournament({ ...base, template: "bouldering_tops_zones_attempts", rules: rulesOf(SWISS, { finalSize: 4 }) } as TournamentInput, ownerId)).toMatchObject({ ok: false, error: expect.stringContaining("no final") });
    expect(await createTournament({ ...base, template: "bouldering_tops_zones_attempts", rules: rulesOf({ rounds: 1 }) } as TournamentInput, ownerId)).toMatchObject({ ok: false, error: expect.stringContaining("at least 2 rounds") });
    expect(await createTournament({ ...base, template: "bouldering_tops_zones_attempts", rules: rulesOf({ rounds: 3, cumulative: "best_n" }) } as TournamentInput, ownerId)).toMatchObject({ ok: false });
    expect(await createTournament({ ...base, template: "bouldering_tops_zones_attempts", rules: rulesOf({ rounds: 3, cumulative: "best_n", bestN: 5 }) } as TournamentInput, ownerId)).toMatchObject({ ok: false, error: expect.stringContaining("more than the rounds") });
    // A marks event cannot be played in Swiss rounds.
    const swim = await venueWith("swimming").catch(() => null);
    if (swim) expect(await createTournament({ ...swim, name: "Swim Swiss", sport: "swimming", format: "performance", teamSize: 1, level: null, entryFee: 0, maxEntries: 16, startsOn: day, endsOn: day, startHour: 8, endHour: 20, rules: { swiss: { rounds: 3, byePoints: null, tiebreaks: null } } } as TournamentInput, ownerId)).toMatchObject({ ok: false });
    // The rules are laid over what the event has before the draw, and refused after it.
    const t = await competition();
    expect(await setRules(t.id, { swiss: { cumulative: "best_n", bestN: 2 } })).toMatchObject({ ok: true });
    expect(await setRules(t.id, { performance: { finalSize: 4 } })).toMatchObject({ ok: false, error: expect.stringContaining("no final") });
    expect(await setRules(t.id, { swiss: { cumulative: "sum_of_placings", bestN: null } })).toMatchObject({ ok: true });
    const ids: number[] = [];
    for (let i = 0; i < 8; i++) ids.push(ok(await enter(await player(), t.id)).id);
    const d = ok(await makeDraw(t.id, () => 0.3));
    expect(d.matches.filter((m) => m.stage === "final")).toHaveLength(0);
    expect(heatsOf(d, 1)).toHaveLength(2);
    expect(heatsOf(d, 2)).toHaveLength(0);
    const swissRow = (await getDb().prepare("SELECT rounds, planned_rounds, seed, cumulative, best_n, tiebreaks FROM swiss_events WHERE tournament_id = ?").get(t.id)) as Record<string, unknown>;
    expect(swissRow).toMatchObject({ rounds: 3, planned_rounds: 3, cumulative: "sum_of_placings", best_n: null, tiebreaks: "[]" });
    expect(d.performance!.swiss).toMatchObject({ roundsTotal: 3, cumulative: "sum_of_placings", nextRound: null, review: [] });
    // Round 1 is the initial order, in groups of the size the event sets; the best group is the last to climb and each starts worst first.
    const initial = await initialOrder(t.id);
    expect(initial.slice().sort((a, b) => a - b)).toEqual(ids.slice().sort((a, b) => a - b));
    expect(lineup(d, heatsOf(d, 1)[1].id)).toEqual(initial.slice(0, 4).reverse());
    expect(lineup(d, heatsOf(d, 1)[0].id)).toEqual(initial.slice(4).reverse());
    expect(d.performance!.swiss!.rounds[0].notes.map((x) => x.members.every((m) => m.place === null))).toEqual([true, true]);
    expect(heatsOf(d, 1).every((m) => m.courtId !== null && m.date !== null)).toBe(true);
    // The same seed gives the same order.
    const again = (await import("../src/lib/swiss")).drawInitialOrder(ids.map((id) => ({ id, seed: null })), () => d.performance!.swiss!.seed / 4294967296);
    expect(again.initial).toEqual(initial);
    // Nothing is rated.
    expect(await setEventRated("tournament", t.id, true)).toMatchObject({ ok: false, code: "RT_PERFORMANCE" });
  });

  it("is refused, changing nothing, where the rounds cannot all fit the time held", async () => {
    const t = await competition({ rules: rulesOf({ rounds: 60, cumulative: "sum_of_placings" }), startHour: 8, endHour: 9 } as Partial<TournamentInput>);
    for (let i = 0; i < 8; i++) ok(await enter(await player(), t.id));
    const refused = await makeDraw(t.id, () => 0.3);
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("Not enough court time") });
    expect(await getDb().prepare("SELECT 1 FROM swiss_events WHERE tournament_id = ?").get(t.id)).toBeUndefined();
    expect((await detail(t.id)).status).not.toBe("drawn");
  });
});

describe("playing the rounds", () => {
  it("groups each round from the standing once every group of the one before is in, adds the placings up, and finishes after the last round", async () => {
    const t = await competition({}, 2);
    const ids: number[] = [];
    for (let i = 0; i < 8; i++) ids.push(ok(await enter(await player(), t.id)).id);
    let d = ok(await makeDraw(t.id, () => 0.3));
    const initial = await initialOrder(t.id);
    // Round 1 by the initial order; the first group in does not group round 2.
    const r1 = planOf(initial, 1);
    d = ok(await recordHeat(d, heatsOf(d, 1)[0].id, r1));
    expect(heatsOf(d, 2)).toHaveLength(0);
    d = ok(await recordHeat(d, heatsOf(d, 1)[1].id, r1));
    expect(heatsOf(d, 2)).toHaveLength(2);
    // Round 2's groups: the four best in round 1 (level 7, 6, 5, 4) together, in the last group, the worst of them first.
    const byLevel = (plan: Record<number, number>) => ids.slice().sort((a, b) => plan[b] - plan[a]);
    const place1 = byLevel(r1);
    expect(lineup(d, heatsOf(d, 2)[1].id)).toEqual(place1.slice(0, 4).reverse());
    expect(lineup(d, heatsOf(d, 2)[0].id)).toEqual(place1.slice(4).reverse());
    // Why: each member's place and total in the standing the group was formed from.
    const note = d.performance!.swiss!.rounds[1].notes.find((x) => x.heat === 2)!;
    expect(note.members.map((m) => m.id)).toEqual(place1.slice(0, 4).reverse());
    expect(note.members.map((m) => m.place).sort()).toEqual([1, 2, 3, 4]);
    expect(note.members.map((m) => m.total).sort()).toEqual([1, 2, 3, 4]);
    // A round is not climbed twice, and the standing counts only rounds that are in.
    expect(d.performance!.swiss!.standings.map((l) => l.placings.length)).toEqual(Array(8).fill(1));
    const r2 = planOf(initial, 2);
    d = await playRound(t.id, 2, r2);
    expect(heatsOf(d, 3)).toHaveLength(2);
    const r3 = planOf(initial, 3);
    d = await playRound(t.id, 3, r3);
    expect(d.status).toBe("finished");
    expect(heatsOf(d, 4)).toHaveLength(0);
    // The standing is the sum of each round's placing (level 7 is first, so placing = 8 - level), worked here independently.
    const independent = await independentStanding(t.id);
    const placing = (id: number) => [r1, r2, r3].map((p) => 8 - p[id]);
    expect(independent.lines.map((l) => l.placings)).toEqual(independent.lines.map((l) => placing(l.id)));
    expect(d.performance!.ranking.map((r) => r.entryId)).toEqual(independent.lines.map((l) => l.id));
    expect(d.performance!.swiss!.standings.map((l) => [l.entryId, l.total])).toEqual(independent.lines.map((l) => [l.id, l.total]));
    expect(d.performance!.ranking[0]).toMatchObject({ rank: 1, stage: "heat" });
    expect(d.performance!.ranking[0].shown).toBe(`${independent.lines[0].total} (${independent.lines[0].placings.join(", ")})`);
    expect(d.performance!.swiss!.nextRound).toBeNull();
    expect(d.performance!.swiss!.review).toEqual([]);
    // Every round's lines carry the climber's place in the round across all its groups.
    for (const m of heatsOf(d, 2)) for (const l of d.performance!.lines[m.id]) expect(l.rank).toBe(8 - r2[l.entryId]);
    // Nobody was told in the wrong language or twice: each climber has a message for each round after the first.
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages WHERE subject LIKE ?").get(`Round 2 of ${t.name}%`)) as { n: number }).n).toBe(8);
  });

  it("adds the best N placings when the event says so, and is the same as the independent working", async () => {
    const t = await competition({ rules: rulesOf({ rounds: 3, cumulative: "best_n", bestN: 2 }) }, 2);
    const ids: number[] = [];
    for (let i = 0; i < 8; i++) ids.push(ok(await enter(await player(), t.id)).id);
    ok(await makeDraw(t.id, () => 0.6));
    const initial = await initialOrder(t.id);
    for (const r of [1, 2, 3]) await playRound(t.id, r, planOf(initial, r));
    const d = await detail(t.id);
    const independent = await independentStanding(t.id, { best: 2 });
    expect(d.performance!.swiss).toMatchObject({ cumulative: "best_n", bestN: 2 });
    expect(d.performance!.swiss!.standings.map((l) => [l.entryId, l.total, l.counted.length])).toEqual(independent.lines.map((l) => [l.id, l.total, 2]));
    expect(d.status).toBe("finished");
  });

  it("forms odd fields without a bye: nobody sits out and no group is one competitor", async () => {
    for (const [count, sizes] of [[7, [3, 4]], [5, [2, 3]], [3, [3]], [9, [3, 3, 3]]] as [number, number[]][]) {
      const t = await competition({}, 2);
      for (let i = 0; i < count; i++) ok(await enter(await player(), t.id));
      let d = ok(await makeDraw(t.id, () => 0.4));
      expect(heatsOf(d, 1).map((m) => lineup(d, m.id).length)).toEqual(sizes);
      const initial = await initialOrder(t.id);
      d = await playRound(t.id, 1, Object.fromEntries(initial.map((id, i) => [id, i % 8])));
      expect(heatsOf(d, 2).map((m) => lineup(d, m.id).length)).toEqual(sizes);
      expect(new Set(heatsOf(d, 2).flatMap((m) => lineup(d, m.id))).size).toBe(count);
    }
  });
});

describe("corrections: flagged, never reshuffled", () => {
  /** Eight climbers, rounds 1 and 2 grouped, round 1 in full. */
  async function setup(rules = SWISS) {
    const t = await competition({ rules: rulesOf(rules) }, 2);
    const ids: number[] = [];
    for (let i = 0; i < 8; i++) ids.push(ok(await enter(await player(), t.id)).id);
    ok(await makeDraw(t.id, () => 0.3));
    const initial = await initialOrder(t.id);
    const d = await playRound(t.id, 1, planOf(initial, 1));
    return { t, ids, initial, d };
  }

  /** The correction that puts the 4th and 5th of round 1 the other way round: it moves two climbers across the boundary of the groups. */
  const swap = (d: TournamentDetail, initial: number[]) => {
    const plan = planOf(initial, 1);
    const order = initial.slice().sort((a, b) => plan[b] - plan[a]);
    const [fourth, fifth] = [order[3], order[4]];
    const heat = (id: number) => heatsOf(d, 1).find((m) => d.performance!.lines[m.id].some((l) => l.entryId === id))!;
    return { fourth, fifth, lines: [{ matchId: heat(fourth).id, level: { [fourth]: plan[fifth] } }, { matchId: heat(fifth).id, level: { [fifth]: plan[fourth] } }] };
  };

  it("flags a later round whose groups the corrected standing would form differently, moves nobody, and says so in the preview", async () => {
    const { t, initial, d } = await setup();
    const before = heatsOf(d, 2).map((m) => lineup(d, m.id));
    const s = swap(d, initial);
    // Previewing the first line of the correction changes nothing, and a flag that would appear is said.
    const first = s.lines[0];
    const looked = await previewPerformances(first.matchId, [{ entryId: s.fourth, counts: sent(SKILL[first.level[s.fourth]]) }]);
    expect(looked.ok).toBe(true);
    let now = ok(await recordHeat(d, first.matchId, first.level));
    // One line changed: the 4th now climbs as the 5th did, so the two are level; nobody crossed yet or someone did, but the grouping is untouched.
    now = ok(await recordHeat(now, s.lines[1].matchId, s.lines[1].level));
    expect(heatsOf(now, 2).map((m) => lineup(now, m.id))).toEqual(before);
    const review = now.performance!.swiss!.review;
    expect(review).toHaveLength(1);
    expect(review[0].round).toBe(2);
    expect(review[0].moves.map((m) => m.entryId).sort((a, b) => a - b)).toEqual([s.fourth, s.fifth].sort((a, b) => a - b));
    // The two would change group: the one now ahead goes to the better group (2), the other down (1).
    const toBetter = review[0].moves.find((m) => m.to === 2)!;
    expect(toBetter.entryId).toBe(s.fifth);
    expect(review[0].moves.find((m) => m.to === 1)!.entryId).toBe(s.fourth);
    // The standing itself is corrected at once, as the pure working has it.
    const independent = await independentStanding(t.id);
    expect(now.performance!.swiss!.standings.map((l) => l.entryId)).toEqual(independent.lines.map((l) => l.id));
    // The preview of such a correction tells the organiser (nothing is refused).
    const again = await previewPerformances(first.matchId, [{ entryId: s.fourth, counts: sent(SKILL[first.level[s.fourth]]) }]);
    expect(again.ok).toBe(true);
  });

  it("says in a correction's preview that a later round is flagged", async () => {
    const { initial, d } = await setup();
    const s = swap(d, initial);
    // Correct the fifth's line to the fourth's level, which is on its own enough to make them level and change the order of the groups.
    const bigger = SKILL[7];
    const target = s.lines[1];
    const lines: PerformanceInput[] = [{ entryId: s.fifth, counts: sent(bigger) }];
    const looked = await previewPerformances(target.matchId, lines);
    if (!looked.ok) throw new Error(looked.error);
    expect(looked.value.changePhrases?.some((p) => p.key === "srv.pf.swissReview") ?? false).toBe(true);
    expect(looked.value.consequential).toBe(false);
    // Nothing was changed by looking.
    expect((await detail((await getDb().prepare("SELECT tournament_id FROM tournament_matches WHERE id = ?").get(target.matchId) as { tournament_id: number }).tournament_id)).performance!.swiss!.review).toEqual([]);
  });

  it("groups the round again, previewed and confirmed, while nobody has climbed it: the same as grouping fresh from the corrected standing", async () => {
    const { t, initial, d } = await setup();
    const s = swap(d, initial);
    let now = ok(await recordHeat(d, s.lines[0].matchId, s.lines[0].level));
    now = ok(await recordHeat(now, s.lines[1].matchId, s.lines[1].level));
    const preview = ok(await previewRegroup(t.id, 2));
    expect(preview.moves.map((m) => m.entryId).sort((a, b) => a - b)).toEqual([s.fourth, s.fifth].sort((a, b) => a - b));
    expect(preview.cleared).toEqual([]);
    expect(preview.dropped).toEqual([]);
    // A stale token, a short reason, and a round that is not grouped are refused; nothing changes.
    expect(await regroupFrom(t.id, 2, { token: "stale", reason: "Correction to round 1" })).toMatchObject({ ok: false, code: "CHANGED" });
    expect(await regroupFrom(t.id, 2, { token: preview.token, reason: "no" })).toMatchObject({ ok: false });
    expect(await previewRegroup(t.id, 1)).toMatchObject({ ok: false });
    expect(await previewRegroup(t.id, 3)).toMatchObject({ ok: false });
    expect(heatsOf(await detail(t.id), 2).map((m) => lineup(now, m.id))).toEqual(heatsOf(now, 2).map((m) => lineup(now, m.id)));
    const mailsBefore = ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages").get()) as { n: number }).n;
    const done = ok(await regroupFrom(t.id, 2, { token: preview.token, reason: "Correction to round 1" }));
    // Grouped again from the corrected standing: what a fresh grouping gives, as the pure planner has it.
    const independent = await independentStanding(t.id);
    const expected = planHeats(independent.lines.map((l) => l.id), 4, "reverse");
    expect(heatsOf(done, 2).map((m) => lineup(done, m.id))).toEqual(expected.map((h) => h.entries));
    expect(done.performance!.swiss!.review).toEqual([]);
    expect(done.performance!.swiss!.rounds).toHaveLength(2);
    expect(heatsOf(done, 2).every((m) => m.courtId !== null && m.date !== null)).toBe(true);
    // The climbers are told their group again.
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages").get()) as { n: number }).n).toBeGreaterThan(mailsBefore);
    // And the event plays on to its finish from there.
    for (const r of [2, 3]) await playRound(t.id, r, planOf(initial, r));
    expect((await detail(t.id)).status).toBe("finished");
  });

  it("refuses to group a round again once anybody has climbed it or a later one, and the flag stays until a manager keeps the groups, for good reason", async () => {
    const { t, initial, d } = await setup();
    const s = swap(d, initial);
    let now = ok(await recordHeat(d, s.lines[0].matchId, s.lines[0].level));
    now = ok(await recordHeat(now, s.lines[1].matchId, s.lines[1].level));
    // One group of round 2 climbs.
    const plan2 = planOf(initial, 2);
    now = ok(await recordHeat(now, heatsOf(now, 2)[0].id, plan2));
    expect(await previewRegroup(t.id, 2)).toMatchObject({ ok: false, code: "CLIMBED" });
    expect(await regroupFrom(t.id, 2, { token: "x", reason: "Too late" })).toMatchObject({ ok: false });
    expect(now.performance!.swiss!.review).toHaveLength(1);
    // Keeping the groups needs a reason, clears exactly this flag, and moves nobody.
    const { keepGrouping } = await import("../src/lib/swiss-performances");
    expect(await keepGrouping(t.id, 2, "ok")).toMatchObject({ ok: false });
    const kept = ok(await keepGrouping(t.id, 2, "The climbers have started; the groups stand"));
    expect(kept.performance!.swiss!.review).toEqual([]);
    expect(heatsOf(kept, 2).map((m) => lineup(kept, m.id))).toEqual(heatsOf(now, 2).map((m) => lineup(now, m.id)));
    expect(await keepGrouping(t.id, 2, "Again, for nothing")).toMatchObject({ ok: false, error: expect.stringContaining("Nothing") });
    // A further correction that changes what the corrected standing would form flags it again.
    const plan1 = planOf(initial, 1);
    const order = initial.slice().sort((a, b) => plan1[b] - plan1[a]);
    const [second, third] = [order[1], order[2]];
    const heatOf = (id: number) => heatsOf(kept, 1).find((m) => kept.performance!.lines[m.id].some((l) => l.entryId === id))!;
    // Make the best three a clear way down the order inside the same group: that moves nobody across the boundary, so no new flag.
    const same = ok(await recordHeat(kept, heatOf(second).id, { [second]: plan1[third] }));
    expect(same.performance!.swiss!.review).toEqual([]);
    // Move the sixth (now in the worse group) above the fourth: that is a different expected grouping, and the flag is back.
    const [fourth, sixth] = [order[3], order[5]];
    const moved = ok(await recordHeat(same, heatOf(sixth).id, { [sixth]: 7 }));
    const back = ok(await recordHeat(moved, heatOf(fourth).id, { [fourth]: 0 }));
    expect(back.performance!.swiss!.review.length).toBe(1);
    // The standing is, throughout, the independent working of the recorded lines.
    expect(back.performance!.swiss!.standings.map((l) => l.entryId)).toEqual((await independentStanding(t.id)).lines.map((l) => l.id));
  });

  it("replaying the corrected results from scratch gives the same standing and the same flags as the corrected event", async () => {
    const { t, initial, d } = await setup();
    const s = swap(d, initial);
    let now = ok(await recordHeat(d, s.lines[0].matchId, s.lines[0].level));
    now = ok(await recordHeat(now, s.lines[1].matchId, s.lines[1].level));
    now = await playRound(t.id, 2, planOf(initial, 2));
    // A second event, played straight through with the corrected round 1 recorded the first time, ends in the same standing.
    const u = await competition({ rules: rulesOf(SWISS) }, 2);
    const ids2: number[] = [];
    for (let i = 0; i < 8; i++) ids2.push(ok(await enter(await player(), u.id)).id);
    ok(await makeDraw(u.id, () => 0.3));
    const initial2 = await initialOrder(u.id);
    const plan1 = planOf(initial, 1);
    const order = initial.slice().sort((a, b) => plan1[b] - plan1[a]);
    const level2: Record<number, number> = { ...planOf(initial2, 1) };
    // The same climbers by their place in the initial order: 4th and 5th of round 1 exchanged.
    const idx = (id: number) => initial.indexOf(id);
    level2[initial2[idx(order[3])]] = plan1[order[4]];
    level2[initial2[idx(order[4])]] = plan1[order[3]];
    let replay = await playRound(u.id, 1, level2);
    replay = await playRound(u.id, 2, Object.fromEntries(initial2.map((id, i) => [id, planOf(initial, 2)[initial[i]]])));
    const ranked = (x: TournamentDetail, order2: number[]) => x.performance!.swiss!.standings.map((l) => [order2.indexOf(l.entryId) + 1, l.total, l.rank]);
    expect(ranked(replay, initial2)).toEqual(ranked(now, initial));
    // The corrected event's round 2 was formed before the correction (and is flagged); the replayed one from the corrected standing (and is not).
    expect(now.performance!.swiss!.review.length).toBe(1);
    expect(replay.performance!.swiss!.review).toEqual([]);
  });
});

describe("somebody leaving", () => {
  it("is not grouped after they leave; what they climbed stands, they rank behind those who stayed, and no flag appears for a group they were in", async () => {
    const t = await competition({}, 2);
    const ids: number[] = [];
    for (let i = 0; i < 8; i++) ids.push(ok(await enter(await player(), t.id)).id);
    ok(await makeDraw(t.id, () => 0.3));
    const initial = await initialOrder(t.id);
    // The climber with the top level of round 1 withdraws after round 1: they are not in round 2.
    const plan1 = planOf(initial, 1);
    let d = await playRound(t.id, 1, plan1);
    const leaver = initial.find((id) => plan1[id] === 7)!;
    expect((await takeOut(leaver, "withdrawn")).ok).toBe(true);
    d = await detail(t.id);
    // Round 2 was grouped when round 1 completed (before they left): they are in it, their line did not start; no flag.
    expect(heatsOf(d, 2).flatMap((m) => lineup(d, m.id))).toContain(leaver);
    expect(d.performance!.lines[heatsOf(d, 2).find((m) => lineup(d, m.id).includes(leaver))!.id].find((l) => l.entryId === leaver)!.status).toBe("dns");
    expect(d.performance!.swiss!.review).toEqual([]);
    d = await playRound(t.id, 2, without(planOf(initial, 2), leaver));
    // Round 3 groups the seven who are left: sizes 4 and 3.
    expect(heatsOf(d, 3).map((m) => lineup(d, m.id).length)).toEqual([3, 4]);
    expect(heatsOf(d, 3).flatMap((m) => lineup(d, m.id))).not.toContain(leaver);
    d = await playRound(t.id, 3, without(planOf(initial, 3), leaver));
    expect(d.status).toBe("finished");
    const row = d.performance!.swiss!.standings.find((l) => l.entryId === leaver)!;
    // Their round 1 stands (first), the rounds they missed count as one place behind the last who climbed.
    expect(row.placings[0]).toBe(1);
    expect(row.placings.slice(1)).toEqual([8, 8]);
    expect(d.performance!.swiss!.standings.findIndex((l) => l.entryId === leaver)).toBeGreaterThan(0);
  });

  it("keeps a disqualified climber's record with no place, and ends the event where nobody is left to compare", async () => {
    const t = await competition({}, 2);
    for (let i = 0; i < 4; i++) ok(await enter(await player(), t.id));
    ok(await makeDraw(t.id, () => 0.3));
    const initial = await initialOrder(t.id);
    const plan1 = planOf(initial, 1);
    ok(await takeOut(initial[0], "disqualified", "Used a hold marked out of bounds, seen by the judge"));
    let d = await playRound(t.id, 1, without(plan1, initial[0]));
    const standing = d.performance!.swiss!.standings;
    expect(standing[standing.length - 1]).toMatchObject({ entryId: initial[0], rank: null, resultsVoid: true });
    expect(standing.slice(0, 3).map((l) => l.rank)).toEqual([1, 2, 3]);
    // Round 2 is formed of the three who are left; two of them leave, then the last: nobody is left to compare, and the event ends with the rounds it has.
    expect(heatsOf(d, 2).map((m) => lineup(d, m.id).length)).toEqual([3]);
    for (const id of initial.slice(1, 3)) expect((await takeOut(id, "withdrawn")).ok).toBe(true);
    d = await detail(t.id);
    expect(d.status).toBe("drawn");
    expect(d.performance!.swiss!.roundsTotal).toBe(3);
    expect((await takeOut(initial[3], "withdrawn")).ok).toBe(true);
    d = await detail(t.id);
    expect(d.performance!.swiss!.roundsTotal).toBe(2);
    expect(d.status).toBe("finished");
  });
});

describe("court time, and results arriving together", () => {
  it("leaves a round ungrouped, with why, where no court time is left, and groups it when a manager tries again with time held", async () => {
    const t = await competition({}, 2);
    for (let i = 0; i < 8; i++) ok(await enter(await player(), t.id));
    ok(await makeDraw(t.id, () => 0.3));
    const initial = await initialOrder(t.id);
    const db = getDb();
    // The venue loses the time it held for the later rounds (an outage, say).
    const held = (await db.prepare("SELECT * FROM blocks WHERE tournament_id = ?").all(t.id)) as Record<string, unknown>[];
    expect(held.length).toBeGreaterThan(0);
    await db.prepare("DELETE FROM blocks WHERE tournament_id = ?").run(t.id);
    // The result that completes the round is accepted all the same: grouping never fails a result.
    const d = await playRound(t.id, 1, planOf(initial, 1));
    expect(d.performance!.swiss!.rounds).toHaveLength(1);
    expect(d.performance!.swiss!.blocked).toBe("NO_TIME:2");
    expect(d.performance!.swiss!.nextRound).toBe(2);
    expect(heatsOf(d, 2)).toHaveLength(0);
    // Time held again: the manager's route groups it, and a second try groups nothing more.
    for (const row of held) {
      const cols = Object.keys(row);
      await db.prepare(`INSERT INTO blocks (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => row[c] as never));
    }
    const post = (body: Record<string, unknown>) =>
      adminTournament.POST(new NextRequest(`http://localhost/api/admin/tournaments/${t.id}`, { method: "POST", headers: { cookie: managerCookie }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: String(t.id) }) });
    expect((await post({ action: "swiss_pair" })).status).toBe(200);
    const after = await detail(t.id);
    expect(heatsOf(after, 2)).toHaveLength(2);
    expect(after.performance!.swiss!.blocked).toBeNull();
    expect((await post({ action: "swiss_pair" })).status).toBe(409);
    expect(heatsOf(await detail(t.id), 2)).toHaveLength(2);
  });

  it("groups the next round once when the last two groups of a round are recorded at the same time", async () => {
    const t = await competition({}, 2);
    for (let i = 0; i < 8; i++) ok(await enter(await player(), t.id));
    const drawn = ok(await makeDraw(t.id, () => 0.3));
    const initial = await initialOrder(t.id);
    const plan = planOf(initial, 1);
    const [one, two] = heatsOf(drawn, 1);
    const [a, b] = await Promise.all([recordHeat(drawn, one.id, plan), recordHeat(drawn, two.id, plan)]);
    expect(a.ok && b.ok).toBe(true);
    const d = await detail(t.id);
    expect(d.performance!.swiss!.rounds).toHaveLength(2);
    expect(heatsOf(d, 2)).toHaveLength(2);
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM swiss_rounds WHERE tournament_id = ?").get(t.id)) as { n: number }).n).toBe(2);
  });
});

describe("officials", () => {
  it("enter a round's counts as staff do; a round is finalised when its groups are in and advanced once a later round has been climbed, when only a correction request is open", async () => {
    const t = await competition({}, 2);
    for (let i = 0; i < 8; i++) ok(await enter(await player(), t.id));
    let d = ok(await makeDraw(t.id, () => 0.3));
    const initial = await initialOrder(t.id);
    const official = ok(await addOfficial(t.id, "Judge Jamal", ownerId));
    const lock = async (matchId: number) => (await officialPerformanceView(official.token))!.rounds.find((r) => r.matchId === matchId)!.lock;
    const plan1 = planOf(initial, 1);
    const linesOf = (matchId: number, plan: Record<number, number>) => d.performance!.lines[matchId].map((l) => ({ entryId: l.entryId, counts: sent(SKILL[plan[l.entryId]]) }));
    const [h1, h2] = heatsOf(d, 1);
    // An official enters a group as staff would: the same path, so the next round is grouped when the last group is in.
    expect(await lock(h1.id)).toBeNull();
    expect((await officialPerformances(official.token, h1.id, linesOf(h1.id, plan1))).ok).toBe(true);
    expect(await lock(h1.id)).toBe("finalised");
    expect(heatsOf(await detail(t.id), 2)).toHaveLength(0);
    expect((await officialPerformances(official.token, h2.id, linesOf(h2.id, plan1))).ok).toBe(true);
    d = await detail(t.id);
    expect(heatsOf(d, 2)).toHaveLength(2);
    // A finalised round cannot be overwritten by an official: they ask for a correction.
    expect(await officialPerformances(official.token, h1.id, linesOf(h1.id, plan1))).toMatchObject({ ok: false, code: "OFC_ROUND_FINAL" });
    // Round 2 is open to them; once a line of it has a climb, round 1 is advanced.
    const plan2 = planOf(initial, 2);
    const [g1] = heatsOf(d, 2);
    expect(await lock(g1.id)).toBeNull();
    expect(await lock(h1.id)).toBe("finalised");
    expect((await officialPerformances(official.token, g1.id, [{ entryId: d.performance!.lines[g1.id][0].entryId, counts: sent(SKILL[plan2[d.performance!.lines[g1.id][0].entryId]]) }])).ok).toBe(true);
    expect(await lock(h1.id)).toBe("advanced");
    expect(await lock(h2.id)).toBe("advanced");
    // A correction request for an advanced round is accepted for a manager to decide.
    const asked = await requestCorrection(official.token, h1.id, "Judge miscounted the first boulder.", [{ entryId: d.performance!.lines[h1.id][0].entryId, counts: sent(SKILL[7]) }]);
    expect(asked.ok).toBe(true);
  });
});

describe("the people, and what the public sees", () => {
  it("names a declared minor by first name and initial, in every round's group, and carries no minor's full name in the public route", async () => {
    const t = await competition({}, 2);
    const mum = await player("Mum");
    const kid = await addManaged(mum.id, { displayName: "Aina Binti Lim", relationship: "parent", authority: true }, mum.name);
    if (!kid.ok) throw new Error(kid.error);
    const kidEntry = ok(await enterAs((await guardianEntrant(mum, kid.person.id)) as Entrant, t.id));
    const ids = [kidEntry.id];
    for (let i = 0; i < 7; i++) ids.push(ok(await enter(await player(), t.id)).id);
    ok(await makeDraw(t.id, () => 0.5));
    const initial = await initialOrder(t.id);
    await playRound(t.id, 1, planOf(initial, 1));
    const pub = await namedForThePublic((await tournamentDetail(t.id))!);
    expect(pub.entries.find((e) => e.id === kidEntry.id)!.name).toBe("Aina L.");
    expect(pub.performance!.swiss!.standings.some((l) => l.entryId === kidEntry.id)).toBe(true);
    const res = await publicRoute.GET(new NextRequest(`http://localhost/api/tournaments/${t.id}`), { params: Promise.resolve({ id: String(t.id) }) });
    const text = JSON.stringify(await res.json());
    expect(text).toContain("Aina L.");
    expect(text).not.toContain("Aina Binti Lim");
    expect(text).toContain("placings");
    // The event is never rated: no ledger row.
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM rated_results WHERE source_kind = 'tournament' AND source_id = ?").get(t.id)) as { n: number }).n).toBe(0);
  });
});

describe("through the staff route", () => {
  it("is a manager's: the desk is refused; a flagged round is previewed, grouped again or kept, each answered and logged", async () => {
    const t = await competition({}, 2);
    for (let i = 0; i < 8; i++) ok(await enter(await player(), t.id));
    ok(await makeDraw(t.id, () => 0.3));
    const initial = await initialOrder(t.id);
    const plan1 = planOf(initial, 1);
    let d = await playRound(t.id, 1, plan1);
    const order = initial.slice().sort((a, b) => plan1[b] - plan1[a]);
    const heat = (id: number) => heatsOf(d, 1).find((m) => d.performance!.lines[m.id].some((l) => l.entryId === id))!;
    d = ok(await recordHeat(d, heat(order[3]).id, { [order[3]]: plan1[order[4]] }));
    d = ok(await recordHeat(d, heat(order[4]).id, { [order[4]]: plan1[order[3]] }));
    expect(d.performance!.swiss!.review).toHaveLength(1);
    const post = (cookie: string | undefined, body: Record<string, unknown>) =>
      adminTournament.POST(new NextRequest(`http://localhost/api/admin/tournaments/${t.id}`, { method: "POST", headers: cookie ? { cookie } : {}, body: JSON.stringify(body) }), { params: Promise.resolve({ id: String(t.id) }) });
    expect((await post(undefined, { action: "swiss_regroup", round: 2, preview: true })).status).toBe(401);
    const refused = await post(deskCookie, { action: "swiss_regroup", round: 2, preview: true });
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("MANAGER_ONLY");
    expect((await post(deskCookie, { action: "swiss_keep_grouping", round: 2, reason: "Stays" })).status).toBe(403);
    const looked = await post(managerCookie, { action: "swiss_regroup", round: 2, preview: true });
    expect(looked.status).toBe(200);
    const preview = (await looked.json()).preview as { moves: unknown[]; token: string };
    expect(preview.moves).toHaveLength(2);
    expect((await post(managerCookie, { action: "swiss_regroup", round: 2, token: preview.token, reason: "x" })).status).toBe(409);
    expect((await post(managerCookie, { action: "swiss_regroup", round: 9, preview: true })).status).toBe(409);
    expect((await getDb().prepare("SELECT COUNT(*)::int AS n FROM staff_actions WHERE action LIKE 'tournament.swiss_%group%'").get() as { n: number }).n).toBe(0);
    const done = await post(managerCookie, { action: "swiss_regroup", round: 2, token: preview.token, reason: "Correction to round 1" });
    expect(done.status).toBe(200);
    expect(((await done.json()).tournament as TournamentDetail).performance!.swiss!.review).toEqual([]);
    const logged = (await getDb().prepare("SELECT action, detail FROM staff_actions WHERE action = 'tournament.swiss_regrouped'").all()) as { action: string; detail: string }[];
    expect(logged).toHaveLength(1);
    expect(logged[0].detail).toContain("round 2");
    expect(logged[0].detail).toContain("Correction to round 1");
    // "Pair the next round" is the same route for a counted event: it groups; nothing is due now.
    expect((await post(managerCookie, { action: "swiss_pair" })).status).toBe(409);
  });
});
