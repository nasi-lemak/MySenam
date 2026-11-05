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
import { TEMPLATES, templateByKey } from "../src/lib/competition-templates";
import { getDb } from "../src/lib/db";
import { setEventRated } from "../src/lib/ratings";
import { listVenues } from "../src/lib/store";
import {
  accelerationGroup,
  bakuRounds,
  bakuVirtualPoints,
  drawInitialOrder,
  metKey,
  pairNextRound,
  pairRound,
  previewNextRound,
  seededRandom,
  swissStandings,
  type PairingPlayer,
  type SwissResult,
} from "../src/lib/swiss";
import { bakuNote, showPoints } from "../src/lib/swiss-columns";
import { addDays, todayISO } from "../src/lib/time";
import { applyCorrection, createTournament, enter, makeDraw, previewResult, recordResult, setRules, takeOut, tournamentDetail, type TournamentDetail, type TournamentInput } from "../src/lib/tournaments";
import { accelerationOf, bakuScoringRefusal, pairingName, parseRules, readRules, swissRefusal } from "../src/lib/tournament-rules";
import * as adminTournament from "../src/app/api/admin/tournaments/[id]/route";

/**
 * FIDE's Baku Acceleration Method as a chess pairing option (docs/architecture/decisions/0047-baku-acceleration-for-chess.md; FIDE Handbook
 * C.04.7, in force from 1 February 2026): GA is the top half of the initial order rounded up to an even number; the accelerated rounds are
 * the first half of the event rounded up; GA is paired as if it had a win's points more before the first half of the accelerated rounds
 * (rounded up) and half of that before the rest; nobody has any after them, and GB never. The virtual points steer the pairing and are in no
 * table, tie-break, result or rating. Chess scores a win 2, a draw 1 and a loss 0 in table points (shown as 1, 1/2, 0), the "win is worth two
 * draws" of article 1.1; a virtual "1" of the text is 2 table points here and its "half" is 1.
 */

const WIN = 2;
const DRAW = 1;

let ownerId: number;
let otherVenueAdminCookie: string | null = null;
let managerCookie: string;
let venueId: number;
let courts: number[];
let n = 0;
let dayOffset = 3;
const today = todayISO();
const fixed = () => 0.42;
const pool: User[] = [];
const manager = { id: 1, name: "Musa Manager" };

async function player(): Promise<User> {
  n++;
  const made = await registerUser({ name: `Baku Player${n}`, email: `bk${n}@baku.test`, phone: `01390${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return made.user;
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const venue = (await listVenues())[0];
  venueId = venue.id;
  courts = venue.courts.filter((c) => c.sport === "badminton").slice(0, 2).map((c) => c.id);
  const boss = await createAdmin({ name: "Musa Baku", email: "musa@baku.test", password: "manager-pass-1", venueId });
  if (!boss.ok) throw new Error("staff");
  ownerId = boss.admin.id;
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(boss.admin.id)).token}`;
  // An administrator of another venue, who may not touch this one's events.
  const otherVenue = (await listVenues()).find((v) => v.id !== venueId);
  if (otherVenue) {
    const stranger = await createAdmin({ name: "Sam Stranger", email: "sam@baku.test", password: "stranger-pass-1", venueId: otherVenue.id, role: "desk" });
    if (!stranger.ok) throw new Error("staff");
    otherVenueAdminCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(stranger.admin.id)).token}`;
  }
  for (let i = 0; i < 12; i++) pool.push(await player());
});

const BAKU = { method: "baku" as const };

async function make(over: Partial<TournamentInput> = {}, count = 8, days = 4) {
  const day = addDays(today, dayOffset);
  dayOffset += days + 1;
  const made = await createTournament(
    {
      venueId,
      name: `Baku Open ${dayOffset}`,
      sport: "badminton",
      template: "chess_results",
      format: "swiss",
      teamSize: 1,
      level: null,
      entryFee: 0,
      maxEntries: 32,
      startsOn: day,
      endsOn: addDays(day, days - 1),
      startHour: 9,
      endHour: 21,
      courtIds: courts,
      rules: { swiss: { rounds: 5, acceleration: BAKU } },
      ...over,
    },
    ownerId
  );
  if (!made.ok) throw new Error(made.error);
  const entries: number[] = [];
  for (const u of pool.slice(0, count)) {
    const e = await enter(u, made.value.id);
    if (!e.ok) throw new Error(e.error);
    entries.push(e.value.id);
  }
  return { id: made.value.id, entries };
}

async function drawn(over: Partial<TournamentInput> = {}, count = 8, days = 4) {
  const ev = await make(over, count, days);
  const done = await makeDraw(ev.id, fixed);
  if (!done.ok) throw new Error(done.error);
  return { ...ev, d: done.value };
}

const detail = async (id: number) => (await tournamentDetail(id, { forStaff: true }))!;
const round = (d: TournamentDetail, r: number) => d.matches.filter((m) => m.stage === "group" && m.round === r);
const keyOf = (pairs: { a: number | null; b: number | null }[]) => pairs.map((p) => [p.a, p.b].sort((x, y) => x! - y!).join("v")).sort();
const pairKey = (d: TournamentDetail, r: number) => keyOf(round(d, r).filter((m) => m.status !== "bye"));
const rankOf = async (id: number) => new Map(((await getDb().prepare("SELECT id, swiss_rank FROM tournament_entries WHERE tournament_id = ? AND swiss_rank IS NOT NULL").all(id)) as { id: number; swiss_rank: number }[]).map((x) => [x.id, x.swiss_rank]));
const byRank = async (id: number) => [...(await rankOf(id)).entries()].sort((a, b) => a[1] - b[1]).map(([e]) => e);
const stored = async (id: number) =>
  (await getDb().prepare("SELECT accel_method, accel_rounds, accel_group, accel_points FROM swiss_events WHERE tournament_id = ?").get(id)) as { accel_method: string; accel_rounds: number; accel_group: number; accel_points: number };

/** Play every undecided match of a round: the better in the initial order wins, but a match whose ranks add to a multiple of 3 is drawn. */
async function playRound(id: number, r: number, draws = true) {
  const rank = await rankOf(id);
  for (const m of round(await detail(id), r).filter((x) => x.status === "scheduled")) {
    const [ra, rb] = [rank.get(m.a!)!, rank.get(m.b!)!];
    const res =
      draws && (ra + rb) % 3 === 0
        ? await recordResult(m.id, { winner: null, score: "1-1" })
        : await (async () => {
            const w = ra < rb ? m.a! : m.b!;
            return recordResult(m.id, { winner: w, score: w === m.a ? "1-0" : "0-1" });
          })();
    if (!res.ok) throw new Error(res.error);
  }
  return detail(id);
}

/** The real points of everybody, worked out from the matches alone as the rules of chess score them: a win 2, a draw 1 each, a bye a win. Knows nothing of virtual points. */
function realPoints(d: TournamentDetail, upTo = Infinity): Map<number, number> {
  const points = new Map<number, number>();
  const add = (id: number | null, v: number) => id !== null && points.set(id, (points.get(id) ?? 0) + v);
  for (const m of d.matches.filter((x) => x.stage === "group" && x.round <= upTo)) {
    if (m.status === "bye" && m.b === null) add(m.a, WIN);
    else if (m.status === "done" && m.winner === null) {
      add(m.a, DRAW);
      add(m.b, DRAW);
    }
    else if (m.status === "done" || m.status === "walkover") add(m.winner, WIN);
  }
  return points;
}

/** The real points of every entry of the table, those who scored nothing included, in entry order. */
const withZeros = (d: TournamentDetail, upTo: number): [number, number][] => {
  const real = realPoints(d, upTo);
  return d.swiss!.standings.map((l): [number, number] => [l.entryId, real.get(l.entryId) ?? 0]).sort((a, b) => a[0] - b[0]);
};

/**
 * The text of the Baku method worked out afresh, independently of lib/swiss.ts: for an event of `rounds` rounds and `size` entries the
 * accelerated rounds are the first half rounded up, the full virtual point is before the first half of those rounded up, half of it before the rest.
 */
function virtualOf(size: number, rounds: number, round: number, rank: number): number {
  const ga = 2 * Math.ceil(size / 4);
  const accelerated = Math.ceil(rounds / 2);
  if (rank > ga || round > accelerated) return 0;
  return round <= Math.ceil(accelerated / 2) ? WIN : WIN / 2;
}

/** What the next round is, from the recorded results alone, with the virtual points the text gives. */
async function expectedPairing(id: number, upTo: number, size: number, rounds: number, active?: number[]) {
  const d = await detail(id);
  const ranks = await rankOf(id);
  const real = realPoints(d, upTo);
  const prior = d.matches.filter((m) => m.stage === "group" && m.round <= upTo && m.a !== null && m.b !== null);
  const met = new Set(prior.map((m) => metKey(m.a!, m.b!)));
  const hadBye = new Set(d.matches.filter((m) => m.stage === "group" && m.round <= upTo && m.status === "bye" && m.b === null).map((m) => m.a!));
  const first = new Map<number, number>();
  for (const m of prior) {
    first.set(m.a!, (first.get(m.a!) ?? 0) + 1);
    first.set(m.b!, (first.get(m.b!) ?? 0) - 1);
  }
  const ids = active ?? d.entries.filter((e) => e.status === "entered").map((e) => e.id);
  return pairRound(
    ids.map((e) => ({ id: e, points: real.get(e) ?? 0, rank: ranks.get(e)!, virtual: virtualOf(size, rounds, upTo + 1, ranks.get(e)!) })),
    met,
    hadBye,
    first
  )!;
}

describe("the method of the FIDE text, as arithmetic", () => {
  it("makes GA the first half of the field rounded up to an even number: the worked example of 161 players has 82", () => {
    expect(accelerationGroup(161)).toBe(82);
    expect([4, 5, 6, 7, 8, 9, 10, 11, 12, 16, 17, 33, 161].map(accelerationGroup)).toEqual([2, 4, 4, 4, 4, 6, 6, 6, 6, 8, 10, 18, 82]);
    // "The first half, rounded up to the nearest even number" and 2 x ceil(n / 4) are the same number for every field.
    for (let size = 2; size <= 200; size++) {
      const evenHalf = Math.ceil(Math.ceil(size / 2) / 2) * 2;
      expect(accelerationGroup(size)).toBe(evenHalf);
    }
  });

  it("takes the accelerated rounds as the first half of the event rounded up, the full point before the first half of those rounded up, and half of it before the rest", () => {
    // The text's examples: nine rounds are five accelerated, three at a point and two at half a point; eleven rounds (matchpoints 2 for a win) are six: three at 2, three at 1.
    expect(bakuRounds(9)).toEqual({ accelerated: 5, full: 3, half: 2 });
    expect(bakuRounds(11)).toEqual({ accelerated: 6, full: 3, half: 3 });
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((r) => bakuRounds(r))).toEqual([
      { accelerated: 1, full: 1, half: 0 },
      { accelerated: 1, full: 1, half: 0 },
      { accelerated: 2, full: 1, half: 1 },
      { accelerated: 2, full: 1, half: 1 },
      { accelerated: 3, full: 2, half: 1 },
      { accelerated: 3, full: 2, half: 1 },
      { accelerated: 4, full: 2, half: 2 },
      { accelerated: 4, full: 2, half: 2 },
    ]);
    // Per round, in a nine-round event of 8: a win is 1 point in the text and 2 table points here (so "half" is 1).
    const nine = (rank: number) => [1, 2, 3, 4, 5, 6, 7, 8, 9].map((r) => bakuVirtualPoints(r, 5, 4, rank, 2));
    expect(nine(1)).toEqual([2, 2, 2, 1, 1, 0, 0, 0, 0]);
    expect(nine(4)).toEqual([2, 2, 2, 1, 1, 0, 0, 0, 0]);
    // GB never has any, and neither does anybody after the last accelerated round.
    expect(nine(5)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(nine(8)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    // The eleven-round matchpoint example (a win is 2 matchpoints, so 2 then 1): the same function at win = 2 table points.
    expect([1, 2, 3, 4, 5, 6, 7].map((r) => bakuVirtualPoints(r, 6, 8, 1, 2))).toEqual([2, 2, 2, 1, 1, 1, 0]);
    // Whatever a win is worth, in halves: 4 gives 4 then 2.
    expect([1, 2, 3, 4].map((r) => bakuVirtualPoints(r, 3, 2, 1, 4))).toEqual([4, 4, 2, 0]);
    // The function agrees with the independent reading of the text for every size, length and place.
    for (const size of [4, 8, 9, 12, 16, 33]) for (const rounds of [2, 3, 5, 7, 9]) for (let r = 1; r <= rounds; r++) for (let rank = 1; rank <= size; rank++) {
      expect(bakuVirtualPoints(r, bakuRounds(rounds).accelerated, accelerationGroup(size), rank, WIN)).toBe(virtualOf(size, rounds, r, rank));
    }
  });

  it("is a rule of whole table points: it needs a win worth two draws and a loss nothing", () => {
    expect(bakuScoringRefusal({ tablePoints: { win: 2, draw: 1, loss: 0 } })).toBeNull();
    expect(bakuScoringRefusal({ tablePoints: { win: 4, draw: 2, loss: 0 } })).toBeNull();
    for (const tablePoints of [{ win: 3, draw: 1, loss: 0 }, { win: 1, draw: 0, loss: 0 }, { win: 2, draw: 1, loss: 1 }, { win: 2, draw: 0, loss: 0 }])
      expect(bakuScoringRefusal({ tablePoints })).toMatch(/win is worth two draws/);
  });
});

describe("hand-worked pairings", () => {
  const field = (points: number[], virtual: (rank: number) => number): PairingPlayer[] => points.map((p, i) => ({ id: i + 1, points: p, rank: i + 1, virtual: virtual(i + 1) }));
  const pairs = (p: ReturnType<typeof pairRound>) => keyOf(p!.pairs);

  it("round 1 of eight pairs GA (the best four) among itself and GB among itself, whoever the lower half would have met", () => {
    const players = field([0, 0, 0, 0, 0, 0, 0, 0], (r) => bakuVirtualPoints(1, 3, 4, r, WIN));
    // Standard Swiss would meet 1v5 2v6 3v7 4v8. With GA at 2 virtual points: 1v3 2v4 within GA, 5v7 6v8 within GB.
    expect(pairs(pairRound(field([0, 0, 0, 0, 0, 0, 0, 0], () => 0), new Set(), new Set()))).toEqual(["1v5", "2v6", "3v7", "4v8"]);
    expect(pairs(pairRound(players, new Set(), new Set()))).toEqual(["1v3", "2v4", "5v7", "6v8"]);
  });

  it("round 3 of five (eight players, real points 0 0 4 3 2 2 2 1): no acceleration, half a point (1) and a full point (2) pair three different ways", () => {
    const real = [0, 0, 4, 3, 2, 2, 2, 1];
    const standard = pairRound(field(real, () => 0), new Set(), new Set());
    // The accelerated rounds of a five-round event are three, the full point is before rounds 1 and 2 and half of it before round 3.
    const half = pairRound(field(real, (r) => bakuVirtualPoints(3, 3, 4, r, WIN)), new Set(), new Set());
    const full = pairRound(field(real, (r) => bakuVirtualPoints(1, 3, 4, r, WIN)), new Set(), new Set());
    // Worked by hand. No virtual: order by points 3(4) 4(3) 5 6 7(2) 8(1) 1 2(0): 3v4, the three on 2 pair 5v6, 7 drops to 8, 1v2.
    expect(pairs(standard)).toEqual(["1v2", "3v4", "5v6", "7v8"]);
    // Half (1 point to ranks 1-4): 3 has 5, 4 has 4, 5 6 7 have 2, and 1 2 8 have 1. 3v4, 5v6, then 7 meets the best of the group below, 1; 2v8.
    expect(pairs(half)).toEqual(["1v7", "2v8", "3v4", "5v6"]);
    // Full (2 points): 3 has 6, 4 has 5, and 1 2 5 6 7 all have 2, 8 has 1. 3v4; 1 takes the lower half of {1 2 5 6 7} (5), then 2v6, 7v8.
    expect(pairs(full)).toEqual(["1v5", "2v6", "3v4", "7v8"]);
    // The notes keep the real points and say what was virtual.
    const note = half!.pairs.find((p) => p.a === 1 || p.b === 1)!.note;
    expect([note.aPoints, note.bPoints].sort()).toEqual([0, 2]);
    expect([note.aVirtual ?? 0, note.bVirtual ?? 0].sort()).toEqual([0, WIN / 2]);
  });

  it("an odd field: nine players, the bye goes to the lowest of GB; GA of six pairs among itself in round 1", () => {
    const made = pairRound(field(Array(9).fill(0), (r) => bakuVirtualPoints(1, 3, accelerationGroup(9), r, WIN)), new Set(), new Set())!;
    expect(made.bye!.id).toBe(9);
    expect(made.bye!.note.aVirtual).toBeUndefined();
    expect(made.pairs.filter((p) => p.a <= 6 && p.b <= 6)).toHaveLength(3);
    expect(made.pairs.filter((p) => p.a > 6 && p.b > 6)).toHaveLength(1);
  });
});

describe("the option is a rule: standard Swiss is the default, and Baku is offered to chess alone", () => {
  it("reads whichever way it was written: a number is the legacy constant method, and none is standard", () => {
    expect(accelerationOf(undefined)).toEqual({ method: "none" });
    expect(accelerationOf({ rounds: null, byePoints: null, tiebreaks: null })).toEqual({ method: "none" });
    expect(accelerationOf({ rounds: 5, byePoints: null, tiebreaks: null, acceleration: 2 })).toEqual({ method: "constant", rounds: 2 });
    expect(accelerationOf({ rounds: 5, byePoints: null, tiebreaks: null, acceleration: { method: "constant", rounds: 3 } })).toEqual({ method: "constant", rounds: 3 });
    expect(accelerationOf({ rounds: 5, byePoints: null, tiebreaks: null, acceleration: { method: "baku" } })).toEqual({ method: "baku" });
    expect(accelerationOf({ rounds: 5, byePoints: null, tiebreaks: null, acceleration: { method: "none" } })).toEqual({ method: "none" });
    expect([undefined, { rounds: 5, byePoints: null, tiebreaks: null, acceleration: 2 }, { rounds: 5, byePoints: null, tiebreaks: null, acceleration: BAKU }].map(pairingName)).toEqual(["standard", "constant (2 rounds)", "baku"]);
    // What is stored reads as it did: the number stays a number, Baku is an object, and none is not stored.
    expect(readRules(JSON.stringify({ swiss: { rounds: 4, acceleration: 2 } })).swiss).toEqual({ rounds: 4, byePoints: null, tiebreaks: null, acceleration: 2 });
    expect(readRules(JSON.stringify({ swiss: { rounds: 4, acceleration: BAKU } })).swiss).toEqual({ rounds: 4, byePoints: null, tiebreaks: null, acceleration: BAKU });
    expect(readRules(JSON.stringify({ swiss: { rounds: 4, acceleration: { method: "none" } } })).swiss).toEqual({ rounds: 4, byePoints: null, tiebreaks: null });
    expect(readRules(JSON.stringify({ swiss: { rounds: 4, acceleration: { method: "constant", rounds: 2 } } })).swiss!.acceleration).toBe(2);
    expect(readRules(JSON.stringify({ swiss: { rounds: 4, acceleration: { method: "luck" } } })).swiss).toEqual({ rounds: 4, byePoints: null, tiebreaks: null });
  });

  it("is data on the template: only the chess template lists it, with scoring that fits it", () => {
    expect(TEMPLATES.filter((t) => t.swissAcceleration).map((t) => [t.key, t.swissAcceleration])).toEqual([["chess_results", ["baku"]]]);
    const chess = templateByKey("chess_results")!;
    expect(chess.sports).toEqual(["chess"]);
    expect(chess.rules.scoring).toMatchObject({ kind: "tally", draws: true, tablePoints: { win: 2, draw: 1, loss: 0 }, pointsInHalves: true, walkover: "1-0" });
    expect(bakuScoringRefusal(chess.rules.scoring)).toBeNull();
    expect(chess.rules.swiss).toBeUndefined();
    // Every other template reads as it did: no halves flag, no acceleration.
    for (const t of TEMPLATES.filter((x) => x.key !== "chess_results")) expect(t.rules.scoring.pointsInHalves).toBeUndefined();
  });

  it("is refused where the template does not offer it, where the scoring does not fit, for another format and for a counted performance event; standard and the legacy method are not", () => {
    const swiss = (acceleration: unknown) => ({ rounds: 5, byePoints: null, tiebreaks: null, acceleration }) as never;
    const scoring = templateByKey("chess_results")!.rules.scoring;
    expect(swissRefusal("swiss", { swiss: swiss(BAKU), performance: null, scoring }, ["baku"])).toBeNull();
    expect(swissRefusal("swiss", { swiss: swiss(BAKU), performance: null, scoring }, [])).toMatch(/chess tournament/);
    expect(swissRefusal("swiss", { swiss: swiss(BAKU), performance: null, scoring: { ...scoring, tablePoints: { win: 3, draw: 1, loss: 0 } } }, ["baku"])).toMatch(/two draws/);
    expect(swissRefusal("knockout", { swiss: swiss(BAKU), performance: null, scoring }, ["baku"])).toBe("Swiss settings are for a Swiss event.");
    const counted = { measure: "score", better: "higher", attempts: 1, aggregate: "best", heatSize: 8, finalSize: 0, counted: { kind: "boulders", units: 4, rankBy: ["tops"], countback: false, finalStart: "reverse", cutTies: "choose" } } as never;
    expect(swissRefusal("performance", { swiss: swiss(BAKU), performance: counted }, ["baku"])).toMatch(/head-to-head/);
    // Standard pairing, and the earlier constant method where it is already set, are every sport's.
    expect(swissRefusal("swiss", { swiss: swiss(undefined), performance: null, scoring: undefined }, [])).toBeNull();
    expect(swissRefusal("swiss", { swiss: swiss({ method: "none" }), performance: null }, [])).toBeNull();
    expect(swissRefusal("swiss", { swiss: swiss(2), performance: null }, [])).toBeNull();
    expect(swissRefusal("swiss", { swiss: swiss({ method: "constant", rounds: 5 }), performance: null }, [])).toMatch(/at least one round/);
    // Parsing: an unknown method is not understood.
    expect(parseRules({ swiss: { acceleration: { method: "luck" } } })).toMatchObject({ ok: false });
    expect(parseRules({ swiss: { acceleration: { method: "constant" } } })).toMatchObject({ ok: false });
    expect(parseRules({ swiss: { acceleration: { method: "baku" } } })).toMatchObject({ ok: true });
  });

  it("is refused when an event is set up on another sport's template, and on the chess template with scoring it does not fit; accepted on chess", async () => {
    const day = addDays(today, 150);
    const base = { venueId, name: "Refused Baku Open", sport: "badminton", format: "swiss" as const, teamSize: 1 as const, level: null, entryFee: 0, maxEntries: 16, startsOn: day, endsOn: addDays(day, 2), startHour: 9, endHour: 21, courtIds: courts };
    const other = await createTournament({ ...base, template: "racket_best_of_3", rules: { swiss: { rounds: 4, acceleration: BAKU } } }, ownerId);
    expect(other).toMatchObject({ ok: false, error: expect.stringContaining("chess tournament") });
    const custom = await createTournament({ ...base, template: "custom", rules: { swiss: { rounds: 4, acceleration: BAKU } } }, ownerId);
    expect(custom).toMatchObject({ ok: false });
    // Even with chess's scoring typed in by hand, a template that does not offer Baku does not get it.
    const handMade = await createTournament({ ...base, template: "goals_league", rules: { scoring: { tablePoints: { win: 2, draw: 1, loss: 0 } }, swiss: { rounds: 4, acceleration: BAKU } } }, ownerId);
    expect(handMade).toMatchObject({ ok: false, error: expect.stringContaining("chess tournament") });
    const badScoring = await createTournament({ ...base, template: "chess_results", rules: { scoring: { tablePoints: { win: 3, draw: 1, loss: 0 } }, swiss: { rounds: 4, acceleration: BAKU } } }, ownerId);
    expect(badScoring).toMatchObject({ ok: false, error: expect.stringContaining("two draws") });
    const unknown = await createTournament({ ...base, template: "chess_results", rules: { swiss: { rounds: 4, acceleration: { method: "luck" } } } }, ownerId);
    expect(unknown).toMatchObject({ ok: false });
    const good = await createTournament({ ...base, template: "chess_results", rules: { swiss: { rounds: 4, acceleration: BAKU } } }, ownerId);
    expect(good.ok && good.value.rules.swiss).toMatchObject({ acceleration: BAKU });
    // A knockout may not carry it.
    const knockout = await createTournament({ ...base, name: "Knockout Baku", format: "knockout", template: "chess_results", rules: { swiss: { rounds: 4, acceleration: BAKU } } }, ownerId);
    expect(knockout).toMatchObject({ ok: false, error: "Swiss settings are for a Swiss event." });
    // The legacy constant method is still any template's.
    const legacy = await createTournament({ ...base, name: "Legacy Cup", template: "racket_best_of_3", rules: { swiss: { rounds: 4, acceleration: 2 } } }, ownerId);
    expect(legacy.ok && legacy.value.rules.swiss).toMatchObject({ acceleration: 2 });
  });

  it("is chosen before the draw: set and taken away while open, refused once the draw is made and on a template that does not offer it", async () => {
    const plain = await make({ rules: { swiss: { rounds: 5 } } });
    expect((await detail(plain.id)).rules.swiss!.acceleration).toBeUndefined();
    const set = await setRules(plain.id, { swiss: { acceleration: BAKU } });
    expect(set.ok && set.value.rules.swiss!.acceleration).toEqual(BAKU);
    const away = await setRules(plain.id, { swiss: { acceleration: { method: "none" } } });
    expect(away.ok && away.value.rules.swiss!.acceleration).toBeUndefined();
    expect((await setRules(plain.id, { swiss: { acceleration: BAKU } })).ok).toBe(true);
    // Scoring that no longer fits is refused while Baku is on.
    expect(await setRules(plain.id, { scoring: { tablePoints: { win: 3 } } })).toMatchObject({ ok: false, error: expect.stringContaining("two draws") });
    expect((await detail(plain.id)).rules.scoring.tablePoints).toEqual({ win: 2, draw: 1, loss: 0 });
    const done = await makeDraw(plain.id, fixed);
    expect(done.ok).toBe(true);
    expect(await setRules(plain.id, { swiss: { acceleration: { method: "none" } } })).toMatchObject({ ok: false, error: "The draw is made: its rules stand as they were." });
    // An event started on a template that does not offer it cannot be given it later either.
    const custom = await make({ template: "custom", rules: { swiss: { rounds: 5 } } });
    expect(await setRules(custom.id, { swiss: { acceleration: BAKU } })).toMatchObject({ ok: false, error: expect.stringContaining("chess tournament") });
  });

  it("is a manager of the venue's rule, and the pairing it sets is in the activity log", async () => {
    const ev = await make({ rules: { swiss: { rounds: 5 } } });
    const post = (cookie: string | undefined, id: number, body: Record<string, unknown>) =>
      adminTournament.POST(new NextRequest(`http://localhost/api/admin/tournaments/${id}`, { method: "POST", headers: cookie ? { cookie } : {}, body: JSON.stringify(body) }), { params: Promise.resolve({ id: String(id) }) });
    expect((await post(undefined, ev.id, { action: "rules", rules: { swiss: { acceleration: BAKU } } })).status).toBe(401);
    // Staff of another venue are refused (where the test database has a second venue).
    if (otherVenueAdminCookie) expect((await post(otherVenueAdminCookie, ev.id, { action: "rules", rules: { swiss: { acceleration: BAKU } } })).status).toBe(403);
    expect((await detail(ev.id)).rules.swiss!.acceleration).toBeUndefined();
    const set = await post(managerCookie, ev.id, { action: "rules", rules: { swiss: { acceleration: BAKU } } });
    expect(set.status).toBe(200);
    expect(((await set.json()).tournament as TournamentDetail).rules.swiss!.acceleration).toEqual(BAKU);
    const refused = await post(managerCookie, (await make({ template: "custom", rules: { swiss: { rounds: 5 } } })).id, { action: "rules", rules: { swiss: { acceleration: BAKU } } });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/chess tournament/);
    const logged = (await getDb().prepare("SELECT detail FROM staff_actions WHERE action = 'tournament.rules' ORDER BY id").all()) as { detail: string }[];
    expect(logged.map((l) => l.detail).filter((d) => d.includes("pairing"))).toEqual([expect.stringMatching(/Baku Open .*, pairing baku$/)]);
  });
});

describe("a chess event of eight with five rounds", () => {
  it("is drawn with GA of four and three accelerated rounds, stored with the method, and shows GA's virtual points per round: 1 point, 1 point, half a point, none, none", async () => {
    const { id, d } = await drawn();
    expect(await stored(id)).toEqual({ accel_method: "baku", accel_rounds: 3, accel_group: 4, accel_points: WIN });
    expect(d.swiss!.acceleration).toEqual({ method: "baku", rounds: 3, group: 4, points: WIN, fullRounds: 2 });
    const initial = await byRank(id);
    const GA = new Set(initial.slice(0, 4));
    // Round 1: GA meets itself, GB itself, and the notes say each side was paired with 2 table points (a point).
    for (const m of round(d, 1)) expect(GA.has(m.a!)).toBe(GA.has(m.b!));
    expect(d.swiss!.rounds[0].notes.every((x) => (x.aVirtual ?? 0) === (GA.has(x.a) ? WIN : 0) && (x.bVirtual ?? 0) === (GA.has(x.b!) ? WIN : 0))).toBe(true);
    let cur = d;
    const seen: number[][] = [];
    for (let r = 1; r <= 5; r++) {
      cur = await detail(id);
      // The pairing of every round is the one the text gives from the recorded results.
      expect(pairKey(cur, r)).toEqual(keyOf((await expectedPairing(id, r - 1, 8, 5)).pairs));
      seen.push([...new Set(cur.swiss!.rounds[r - 1].notes.flatMap((x) => [x.aVirtual ?? 0, x.bVirtual ?? 0]))].sort());
      await playRound(id, r);
    }
    // Rounds 1 and 2 carry 2 (a point), round 3 carries 1 (half a point), rounds 4 and 5 none.
    expect(seen).toEqual([[0, 2], [0, 2], [0, 1], [0], [0]]);
    const fin = await detail(id);
    expect(fin.status).toBe("finished");
    // The table is the real points alone: a win 2, a draw 1 each, whoever had a virtual point; the sum is what was played.
    expect(fin.swiss!.standings.map((l) => [l.entryId, l.points]).sort((a, b) => a[0] - b[0])).toEqual(withZeros(fin, Infinity));
    const decided = fin.matches.filter((m) => m.status === "done");
    const draws = decided.filter((m) => m.winner === null).length;
    expect(fin.swiss!.standings.reduce((s, l) => s + l.points, 0)).toBe(WIN * (decided.length - draws) + 2 * DRAW * draws);
    expect(draws).toBeGreaterThan(0);
  });

  it("without the option is standard Swiss: nothing virtual anywhere, the pairing of every round the plain one, and the stored method none", async () => {
    const { id, d } = await drawn({ rules: { swiss: { rounds: 5 } } });
    expect(await stored(id)).toEqual({ accel_method: "none", accel_rounds: 0, accel_group: 0, accel_points: 0 });
    expect(d.swiss!.acceleration).toBeNull();
    for (let r = 1; r <= 5; r++) {
      const cur = await detail(id);
      expect(cur.swiss!.rounds[r - 1].notes.every((x) => x.aVirtual === undefined && x.bVirtual === undefined)).toBe(true);
      const ranks = await rankOf(id);
      const real = realPoints(cur, r - 1);
      const prior = cur.matches.filter((m) => m.stage === "group" && m.round < r && m.a !== null && m.b !== null);
      const first = new Map<number, number>();
      for (const m of prior) {
        first.set(m.a!, (first.get(m.a!) ?? 0) + 1);
        first.set(m.b!, (first.get(m.b!) ?? 0) - 1);
      }
      const plain = pairRound([...ranks.keys()].map((e) => ({ id: e, points: real.get(e) ?? 0, rank: ranks.get(e)! })), new Set(prior.map((m) => metKey(m.a!, m.b!))), new Set(), first)!;
      expect(pairKey(cur, r)).toEqual(keyOf(plain.pairs));
      await playRound(id, r);
    }
    // Round 1 of standard Swiss: the top half meets the bottom half.
    const initial = await byRank(id);
    expect(pairKey(d, 1)).toEqual(keyOf([[initial[0], initial[4]], [initial[1], initial[5]], [initial[2], initial[6]], [initial[3], initial[7]]].map(([a, b]) => ({ a, b }))));
  });

  it("is reproducible from the recorded seed, and pairs again exactly as a fresh pairing from the corrected results would: in a round at a full point and in one at half", async () => {
    const { id, entries, d } = await drawn();
    const seed = d.swiss!.seed;
    const again = drawInitialOrder(entries.map((e) => ({ id: e, seed: null })), () => seed / 4294967296);
    expect(again.initial).toEqual(await byRank(id));
    const first = pairRound(again.initial.map((e, i) => ({ id: e, points: 0, rank: i + 1, virtual: virtualOf(8, 5, 1, i + 1) })), new Set(), new Set())!;
    expect(keyOf(first.pairs)).toEqual(pairKey(d, 1));
    await playRound(id, 1, false);
    // Round 1 is corrected (a full-point round paired round 2) and the correction pairs again.
    const before = await detail(id);
    const target = round(before, 1)[0];
    const flipped = { winner: target.winner === target.a ? target.b! : target.a!, score: target.winner === target.a ? "0-1" : "1-0" };
    const p1 = await previewResult(target.id, flipped);
    if (!p1.ok) throw new Error(p1.error);
    expect((await applyCorrection(target.id, flipped, { mode: "replace", reason: "The result was entered the wrong way round", token: p1.value.token }, manager)).ok).toBe(true);
    let after = await detail(id);
    expect(pairKey(after, 2)).toEqual(keyOf((await expectedPairing(id, 1, 8, 5)).pairs));
    expect(after.swiss!.rounds[1].notes.some((x) => (x.aVirtual ?? 0) === WIN)).toBe(true);
    // Round 2 is played and round 3, the half-point round, is paired: its virtual points are 1.
    after = await playRound(id, 2, false);
    expect(pairKey(after, 3)).toEqual(keyOf((await expectedPairing(id, 2, 8, 5)).pairs));
    const half = new Set(after.swiss!.rounds[2].notes.flatMap((x) => [x.aVirtual ?? 0, x.bVirtual ?? 0]));
    expect([...half].sort()).toEqual([0, 1]);
    // A correction to round 2 pairs round 3 again, at half a point, and equals a fresh pairing.
    const t2 = round(after, 2).find((m) => m.status === "done")!;
    const flip2 = { winner: t2.winner === t2.a ? t2.b! : t2.a!, score: t2.winner === t2.a ? "0-1" : "1-0" };
    const p2 = await previewResult(t2.id, flip2);
    if (!p2.ok) throw new Error(p2.error);
    expect((await applyCorrection(t2.id, flip2, { mode: "replace", reason: "The result was entered the wrong way round", token: p2.value.token }, manager)).ok).toBe(true);
    after = await detail(id);
    expect(pairKey(after, 3)).toEqual(keyOf((await expectedPairing(id, 2, 8, 5)).pairs));
    expect([...new Set(after.swiss!.rounds[2].notes.flatMap((x) => [x.aVirtual ?? 0, x.bVirtual ?? 0]))].sort()).toEqual([0, 1]);
    // The table stayed the real points of the recorded results through both corrections.
    expect(after.swiss!.standings.map((l) => [l.entryId, l.points]).sort((a, b) => a[0] - b[0])).toEqual(withZeros(after, 2));
    // Played on to the end, a finished event is the replay of its results.
    await playRound(id, 3, false);
    await playRound(id, 4, false);
    const fin = await playRound(id, 5, false);
    expect(fin.status).toBe("finished");
    const ranks = await rankOf(id);
    const results: SwissResult[] = fin.matches.filter((m) => m.status !== "scheduled" && !(m.status === "bye" && m.b !== null)).map((m) => ({ a: m.a!, b: m.b, winner: m.winner, score: m.score, status: m.status as SwissResult["status"] }));
    const replay = swissStandings([...ranks.keys()], ranks, results, fin.rules.scoring, { byePoints: WIN, tiebreaks: fin.swiss!.tiebreaks });
    expect(fin.swiss!.standings.map((l) => [l.entryId, l.points, l.rank])).toEqual(replay.map((l) => [l.entryId, l.points, l.rank]));
  });

  it("previews the round that is due with its virtual points, a half-point round said as half, and makes exactly that", async () => {
    const { id } = await drawn({}, 9);
    await playRound(id, 1);
    await playRound(id, 2);
    // Round 3 paired by itself; take it back to the state of a round that could not be paired, keeping the results.
    const db = getDb();
    await db.prepare("DELETE FROM tournament_matches WHERE tournament_id = ? AND stage = 'group' AND round = 3").run(id);
    await db.prepare("DELETE FROM swiss_rounds WHERE tournament_id = ? AND round = 3").run(id);
    const looked = await previewNextRound(id);
    if (!looked.ok) throw new Error(looked.error);
    expect(looked.value.round).toBe(3);
    const virtuals = looked.value.pairs.flatMap((x) => [x.note.aVirtual ?? 0, x.note.bVirtual ?? 0]);
    expect(virtuals.some((v) => v > 0)).toBe(true);
    expect(new Set(virtuals.filter((v) => v > 0))).toEqual(new Set([WIN / 2]));
    expect((await detail(id)).swiss!.rounds).toHaveLength(2);
    expect(await pairNextRound(id)).toEqual({ ok: true, paired: 3 });
    const after = await detail(id);
    expect(pairKey(after, 3)).toEqual(keyOf(looked.value.pairs));
    // How a half-point reads on a screen, and how the pairing reads in words: "+ 1/2 accelerated" and "round 1-2 ... round 3".
    expect(showPoints(WIN / 2, true)).toBe("½");
    expect(showPoints(WIN, true)).toBe("1");
    expect(showPoints(3, true)).toBe("1½");
    expect(showPoints(0, true)).toBe("0");
    expect(showPoints(3, false)).toBe("3");
    expect(bakuNote({ group: 6, rounds: 3, fullRounds: 2 })).toEqual({ half: true, params: { group: 6, fullRange: "1–2", halfRange: "3", last: 3 } });
    expect(bakuNote({ group: 2, rounds: 1, fullRounds: 1 })).toMatchObject({ half: false });
  });
});

describe("odd fields, other sizes, leavers", () => {
  it("nine players: the bye of every round goes by the pairing score, is a real point in the table and never a virtual one; every pairing is the text's", async () => {
    const { id, d } = await drawn({}, 9);
    const initial = await byRank(id);
    expect(await stored(id)).toMatchObject({ accel_group: 6, accel_rounds: 3, accel_points: WIN });
    // Round 1: the bye is the last of GB, with no virtual point.
    const bye = round(d, 1).find((m) => m.status === "bye")!;
    expect(bye.a).toBe(initial[8]);
    expect(d.swiss!.rounds[0].notes.find((x) => x.kind === "bye")!.aVirtual).toBeUndefined();
    const GA = new Set(initial.slice(0, 6));
    for (const m of round(d, 1).filter((x) => x.status !== "bye")) expect(GA.has(m.a!)).toBe(GA.has(m.b!));
    for (let r = 1; r <= 5; r++) {
      const cur = await detail(id);
      expect(pairKey(cur, r)).toEqual(keyOf((await expectedPairing(id, r - 1, 9, 5)).pairs));
      const b = round(cur, r).find((m) => m.status === "bye")!;
      expect(b.a).toBe((await expectedPairing(id, r - 1, 9, 5)).bye!.id);
      await playRound(id, r);
    }
    const fin = await detail(id);
    // Nobody had two byes; the byes are real points.
    const byes = fin.matches.filter((m) => m.status === "bye" && m.b === null).map((m) => m.a!);
    expect(new Set(byes).size).toBe(byes.length);
    expect(fin.swiss!.standings.map((l) => [l.entryId, l.points]).sort((a, b) => a[0] - b[0])).toEqual(withZeros(fin, Infinity));
  });

  it("twelve players with the default rounds (four): two accelerated rounds, a point then half a point, GA of six", async () => {
    const { id, d } = await drawn({ rules: { swiss: { acceleration: BAKU } } }, 12, 5);
    expect(d.swiss!.roundsTotal).toBe(4);
    expect(await stored(id)).toEqual({ accel_method: "baku", accel_rounds: 2, accel_group: 6, accel_points: WIN });
    const seen: number[][] = [];
    for (let r = 1; r <= 4; r++) {
      const cur = await detail(id);
      expect(pairKey(cur, r)).toEqual(keyOf((await expectedPairing(id, r - 1, 12, 4)).pairs));
      seen.push([...new Set(cur.swiss!.rounds[r - 1].notes.flatMap((x) => [x.aVirtual ?? 0, x.bVirtual ?? 0]))].sort());
      await playRound(id, r);
    }
    expect(seen).toEqual([[0, 2], [0, 1], [0], [0]]);
  });

  it("an event of two rounds has one accelerated round and none at half; the group is fixed at the draw when somebody withdraws", async () => {
    const { id, d } = await drawn({ rules: { swiss: { rounds: 2, acceleration: BAKU } } }, 8);
    expect(await stored(id)).toEqual({ accel_method: "baku", accel_rounds: 1, accel_group: 4, accel_points: WIN });
    expect(d.swiss!.acceleration).toMatchObject({ rounds: 1, fullRounds: 1 });
    expect(bakuNote(d.swiss!.acceleration!).half).toBe(false);
    await playRound(id, 1);
    expect((await detail(id)).swiss!.rounds[1].notes.every((x) => x.aVirtual === undefined && x.bVirtual === undefined)).toBe(true);
  });

  it("withdrawals during the accelerated rounds: nobody moves in or out of GA, the leaver is not paired again, and the virtual points follow the stored schedule", async () => {
    const { id } = await drawn({}, 8, 5);
    const initial = await byRank(id);
    const leaver = initial[2];
    expect((await takeOut(leaver, "withdrawn")).ok).toBe(true);
    await playRound(id, 1);
    let cur = await detail(id);
    expect(round(cur, 2).some((m) => m.a === leaver || m.b === leaver)).toBe(false);
    // Seven are left, a bye; GA is still the four of the draw (three of them left) and rank 4 is in it, rank 5 is not.
    expect(await stored(id)).toMatchObject({ accel_group: 4 });
    expect(round(cur, 2).some((m) => m.status === "bye")).toBe(true);
    const want2 = await expectedPairing(id, 1, 8, 5);
    expect(pairKey(cur, 2)).toEqual(keyOf(want2.pairs));
    const virtuals = (r: number) => new Map(cur.swiss!.rounds[r - 1].notes.flatMap((x) => [[x.a, x.aVirtual ?? 0], ...(x.b !== null ? [[x.b, x.bVirtual ?? 0]] : [])] as [number, number][]));
    for (const [e, v] of virtuals(2)) expect(v).toBe(initial.indexOf(e) < 4 ? WIN : 0);
    // A second one leaves in round 2 (rank 1, in GA): round 3 pairs on half a point for the remaining GA.
    expect((await takeOut(initial[0], "withdrawn")).ok).toBe(true);
    cur = await playRound(id, 2);
    expect(pairKey(cur, 3)).toEqual(keyOf((await expectedPairing(id, 2, 8, 5)).pairs));
    for (const [e, v] of virtuals(3)) expect(v).toBe(initial.indexOf(e) < 4 && e !== leaver && e !== initial[0] ? WIN / 2 : 0);
    expect(round(cur, 3).some((m) => m.a === initial[0] || m.b === initial[0] || m.a === leaver || m.b === leaver)).toBe(false);
    expect(cur.swiss!.standings.map((l) => [l.entryId, l.points]).sort((a, b) => a[0] - b[0])).toEqual(withZeros(cur, 2));
  });

  it("ratings read the decided matches and nothing virtual: every game of a rated event is one rated result, a bye none", async () => {
    const made = await make({ rules: { swiss: { rounds: 3, acceleration: BAKU } } }, 9, 3);
    expect((await setEventRated("tournament", made.id, true)).ok).toBe(true);
    const done = await makeDraw(made.id, fixed);
    if (!done.ok) throw new Error(done.error);
    for (let r = 1; r <= 3; r++) await playRound(made.id, r);
    const fin = await detail(made.id);
    expect(fin.status).toBe("finished");
    const rated = (await getDb().prepare("SELECT source_match FROM rated_results WHERE source_kind = 'tournament' AND source_id = ? AND voided_at IS NULL ORDER BY source_match").all(made.id)) as { source_match: number }[];
    const games = fin.matches.filter((m) => m.status === "done");
    expect(rated.map((x) => x.source_match).sort((a, b) => a - b)).toEqual(games.map((m) => m.id).sort((a, b) => a - b));
    expect(games).toHaveLength(12);
    expect(fin.matches.filter((m) => m.status === "bye")).toHaveLength(3);
  });
});

describe("properties of whole events", () => {
  it("every random chess event: everybody once a round, nobody twice, one bye at most, GA fixed, virtual points only in GA and only in the accelerated rounds, and never in a table", () => {
    const rand = seededRandom(20261105);
    const pick = (k: number) => Math.floor(rand() * k);
    let events = 0;
    for (let trial = 0; trial < 150; trial++) {
      const size = 4 + pick(17);
      const rounds = 2 + pick(Math.min(7, size - 2));
      const ga = accelerationGroup(size);
      const { accelerated, full, half } = bakuRounds(rounds);
      expect(full + half).toBe(accelerated);
      const real = new Map<number, number>(Array.from({ length: size }, (_, i) => [i + 1, 0]));
      const met = new Set<string>();
      const hadBye = new Set<number>();
      const first = new Map<number, number>();
      let leavers = 0;
      let active = Array.from({ length: size }, (_, i) => i + 1);
      for (let r = 1; r <= rounds; r++) {
        if (r > 1 && active.length > 4 && pick(4) === 0) {
          active = active.filter((_, i) => i !== pick(active.length));
          leavers++;
        }
        const virtualFor = (rank: number) => bakuVirtualPoints(r, accelerated, ga, rank, WIN);
        const made = pairRound(active.map((id) => ({ id, points: real.get(id)!, rank: id, virtual: virtualFor(id) })), met, hadBye, first);
        if (!made) break;
        const placed = [...made.pairs.flatMap((p) => [p.a, p.b]), ...(made.bye ? [made.bye.id] : [])].sort((a, b) => a - b);
        expect(placed).toEqual([...active].sort((a, b) => a - b));
        for (const p of made.pairs) {
          expect(met.has(metKey(p.a, p.b))).toBe(false);
          // The note keeps the real points; the virtual ones are GA's, in the accelerated rounds, at the schedule's value.
          expect(p.note.aPoints).toBe(real.get(p.a));
          expect(p.note.bPoints).toBe(real.get(p.b));
          expect(p.note.aVirtual ?? 0).toBe(virtualOf(size, rounds, r, p.a));
          expect(p.note.bVirtual ?? 0).toBe(virtualOf(size, rounds, r, p.b));
          if (r > accelerated) expect(p.note.aVirtual === undefined && p.note.bVirtual === undefined).toBe(true);
          // A result: the better rank wins or it is drawn when the ranks add to a multiple of 3. The table gets real points only.
          const draw = (p.a + p.b) % 3 === 0;
          if (draw) {
            real.set(p.a, real.get(p.a)! + DRAW);
            real.set(p.b, real.get(p.b)! + DRAW);
          } else real.set(Math.min(p.a, p.b), real.get(Math.min(p.a, p.b))! + WIN);
          met.add(metKey(p.a, p.b));
          first.set(p.a, (first.get(p.a) ?? 0) + 1);
          first.set(p.b, (first.get(p.b) ?? 0) - 1);
        }
        if (made.bye) {
          expect(hadBye.has(made.bye.id)).toBe(false);
          hadBye.add(made.bye.id);
          real.set(made.bye.id, real.get(made.bye.id)! + WIN);
        }
      }
      // The total of the table is exactly what the results gave, 2 a game and 2 a bye: no virtual point is in it.
      const total = [...real.values()].reduce((s, v) => s + v, 0);
      expect(total % 1).toBe(0);
      events++;
      void leavers;
    }
    expect(events).toBe(150);
  });

  it("the table is the same function of the results whatever the accelerated pairing was: no virtual field exists for it to read", () => {
    const results: SwissResult[] = [{ a: 1, b: 2, winner: null, score: "1-1", status: "done" }, { a: 3, b: null, winner: 3, score: null, status: "bye" }];
    const scoring = templateByKey("chess_results")!.rules.scoring;
    const table = swissStandings([1, 2, 3, 4], new Map([[1, 1], [2, 2], [3, 3], [4, 4]]), results, scoring, { byePoints: WIN, tiebreaks: ["buchholz"] });
    expect(table.map((l) => [l.entryId, l.points])).toEqual([[3, 2], [1, 1], [2, 1], [4, 0]]);
    expect(Object.keys(table[0])).not.toContain("virtual");
  });
});
