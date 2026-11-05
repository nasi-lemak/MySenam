/// <reference types="vite/client" />
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { registerUser, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { setEventRated } from "../src/lib/ratings";
import { listVenues } from "../src/lib/store";
import {
  accelerationGroup,
  drawInitialOrder,
  metKey,
  pairNextRound,
  pairRound,
  previewNextRound,
  seededRandom,
  swissStandings,
  virtualPointsFor,
  type SwissResult,
} from "../src/lib/swiss";
import { addDays, todayISO } from "../src/lib/time";
import { applyCorrection, createTournament, enter, makeDraw, previewResult, recordResult, takeOut, tournamentDetail, type TournamentDetail, type TournamentInput } from "../src/lib/tournaments";
import { DEFAULT_SCORING } from "../src/lib/tournament-rules";

/**
 * Accelerated pairing (ADR 0038, docs/features/tournaments.md#accelerated-pairing): the top half of the initial order carries a virtual
 * point into the first rounds so the strongest meet early; the virtual points only steer the pairing and are in no table, result or rating,
 * stop after the accelerated rounds, and are reproduced from the stored seed. The arithmetic first, as examples and as properties; then events.
 */

let ownerId: number;
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
  const made = await registerUser({ name: `Accel Player${n}`, email: `ac${n}@accel.test`, phone: `01380${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return made.user;
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  ownerId = (await listAdmins())[0].id;
  const venue = (await listVenues())[0];
  venueId = venue.id;
  courts = venue.courts.filter((c) => c.sport === "badminton").slice(0, 2).map((c) => c.id);
  for (let i = 0; i < 12; i++) pool.push(await player());
});

async function make(over: Partial<TournamentInput> = {}, count = 8, days = 4) {
  const day = addDays(today, dayOffset);
  dayOffset += days + 1;
  const made = await createTournament(
    {
      venueId,
      name: `Accelerated Cup ${dayOffset}`,
      sport: "badminton",
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
const pairKey = (d: TournamentDetail, r: number) => round(d, r).filter((m) => m.status !== "bye").map((m) => [m.a, m.b].sort((x, y) => x! - y!).join("v")).sort();
const rankOf = async (id: number) => new Map(((await getDb().prepare("SELECT id, swiss_rank FROM tournament_entries WHERE tournament_id = ? AND swiss_rank IS NOT NULL").all(id)) as { id: number; swiss_rank: number }[]).map((x) => [x.id, x.swiss_rank]));
/** The entry with each place of the initial order, 1 first. */
const byRank = async (id: number) => [...(await rankOf(id)).entries()].sort((a, b) => a[1] - b[1]).map(([e]) => e);

/** Play every undecided match of a round: the better in the initial order wins. */
async function playRound(id: number, r: number) {
  const rank = await rankOf(id);
  for (const m of round(await detail(id), r).filter((x) => x.status === "scheduled")) {
    const w = rank.get(m.a!)! < rank.get(m.b!)! ? m.a! : m.b!;
    const res = await recordResult(m.id, { winner: w, score: w === m.a ? "21-10, 21-12" : "10-21, 12-21" });
    if (!res.ok) throw new Error(res.error);
  }
  return detail(id);
}

/** The pure replay of the event's table from its recorded results: independent of what the detail reports, and knowing nothing of virtual points. */
async function replayTable(id: number, upTo = Infinity) {
  const d = await detail(id);
  const ev = (await getDb().prepare("SELECT bye_points, tiebreaks FROM swiss_events WHERE tournament_id = ?").get(id)) as { bye_points: number; tiebreaks: string };
  const ranks = await rankOf(id);
  const results: SwissResult[] = d.matches
    .filter((m) => m.round <= upTo && m.status !== "scheduled" && !(m.status === "bye" && m.b !== null))
    .map((m) => ({ a: m.a!, b: m.b, winner: m.winner, score: m.score, status: m.status as SwissResult["status"] }));
  return swissStandings([...ranks.keys()], ranks, results, d.rules.scoring, { byePoints: ev.bye_points, tiebreaks: JSON.parse(ev.tiebreaks) });
}

/** What the next round is, worked out from the recorded results alone, with the virtual points the event's stored group and rounds give. */
async function expectedPairing(id: number, upTo: number, active?: number[]) {
  const d = await detail(id);
  const ev = (await getDb().prepare("SELECT accel_rounds, accel_group, accel_points FROM swiss_events WHERE tournament_id = ?").get(id)) as { accel_rounds: number; accel_group: number; accel_points: number };
  const ranks = await rankOf(id);
  const table = new Map((await replayTable(id, upTo)).map((l) => [l.entryId, l.points]));
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
    ids.map((e) => ({ id: e, points: table.get(e) ?? 0, rank: ranks.get(e)!, virtual: virtualPointsFor(upTo + 1, ev.accel_rounds, ev.accel_group, ranks.get(e)!, ev.accel_points) })),
    met,
    hadBye,
    first
  )!;
}

describe("the arithmetic of acceleration", () => {
  it("makes the accelerated group the top half of the initial order, rounded up to an even number, and gives its virtual points to nobody after the accelerated rounds", () => {
    expect([4, 5, 6, 7, 8, 9, 10, 12, 16, 17, 33].map(accelerationGroup)).toEqual([2, 4, 4, 4, 4, 6, 6, 6, 8, 10, 18]);
    for (let size = 4; size <= 128; size++) {
      expect(accelerationGroup(size) % 2).toBe(0);
      expect(accelerationGroup(size)).toBeGreaterThanOrEqual(Math.ceil(size / 2) - 1);
      expect(accelerationGroup(size)).toBeLessThanOrEqual(size);
    }
    // Rounds 1..R carry the point for a place within the group; a lower place, or a later round, carries none.
    expect(virtualPointsFor(1, 2, 4, 4, 1)).toBe(1);
    expect(virtualPointsFor(2, 2, 4, 1, 1)).toBe(1);
    expect(virtualPointsFor(3, 2, 4, 1, 1)).toBe(0);
    expect(virtualPointsFor(1, 2, 4, 5, 1)).toBe(0);
    expect(virtualPointsFor(1, 0, 4, 1, 1)).toBe(0);
    expect(virtualPointsFor(1, 2, 4, 1, 3)).toBe(3);
  });

  it("pairs the top half among itself in round 1, and says what each side was paired with; without acceleration it pairs as before", () => {
    const field = (accel: boolean) => Array.from({ length: 8 }, (_, i) => ({ id: i + 1, points: 0, rank: i + 1, virtual: accel && i < 4 ? 1 : undefined }));
    const plain = pairRound(field(false), new Set(), new Set())!;
    const fast = pairRound(field(true), new Set(), new Set())!;
    const key = (p: typeof fast) => p.pairs.map((x) => [x.a, x.b].sort((a, b) => a - b).join("v")).sort();
    expect(key(plain)).toEqual(["1v5", "2v6", "3v7", "4v8"]);
    expect(key(fast)).toEqual(["1v3", "2v4", "5v7", "6v8"]);
    for (const p of fast.pairs) {
      if (p.a <= 4) expect(p.note).toMatchObject({ aVirtual: 1, bVirtual: 1, aPoints: 0, bPoints: 0, float: false });
      else expect(p.note.aVirtual).toBeUndefined();
    }
    // A zero virtual value is the same as none.
    expect(pairRound(field(true).map((p) => ({ ...p, virtual: p.virtual === 1 ? 0 : p.virtual })), new Set(), new Set())).toEqual(plain);
  });

  it("gives an odd field's bye to the lowest of the second half, who carries no virtual point", () => {
    const players = Array.from({ length: 9 }, (_, i) => ({ id: i + 1, points: 0, rank: i + 1, virtual: i < accelerationGroup(9) ? 1 : undefined }));
    const made = pairRound(players, new Set(), new Set())!;
    expect(made.bye!.id).toBe(9);
    expect(made.bye!.note.aVirtual).toBeUndefined();
    // Six in the top group (three pairs among themselves), two in the rest.
    expect(made.pairs.filter((p) => p.a <= 6 && p.b <= 6)).toHaveLength(3);
    expect(made.pairs.filter((p) => p.a > 6 && p.b > 6)).toHaveLength(1);
  });

  it("is valid for any field, any points, any history: everybody placed once, nobody twice, one bye at most each, and the same pairing in any order given", () => {
    const rand = seededRandom(20261105);
    const pick = (k: number) => Math.floor(rand() * k);
    let paired = 0;
    for (let trial = 0; trial < 300; trial++) {
      const size = 4 + pick(13);
      const group = accelerationGroup(size);
      const accelRounds = 1 + pick(2);
      const roundNo = 1 + pick(4);
      const players = Array.from({ length: size }, (_, i) => ({ id: i + 1, points: pick(roundNo + 1), rank: i + 1, virtual: virtualPointsFor(roundNo, accelRounds, group, i + 1, 1) }));
      const met = new Set<string>();
      for (let k = 0; k < pick(size * 2); k++) {
        const [a, b] = [1 + pick(size), 1 + pick(size)];
        if (a !== b) met.add(metKey(a, b));
      }
      const hadBye = new Set<number>(Array.from({ length: pick(3) }, () => 1 + pick(size)));
      const made = pairRound(players, met, hadBye);
      if (!made) continue;
      paired++;
      const placed = [...made.pairs.flatMap((p) => [p.a, p.b]), ...(made.bye ? [made.bye.id] : [])].sort((a, b) => a - b);
      expect(placed).toEqual(players.map((p) => p.id));
      for (const p of made.pairs) expect(met.has(metKey(p.a, p.b))).toBe(false);
      if (made.bye) expect(hadBye.has(made.bye.id)).toBe(false);
      expect(made.bye === null).toBe(size % 2 === 0);
      // The order the players are given in changes nothing.
      expect(pairRound([...players].reverse(), met, hadBye)).toEqual(made);
      // The real points are what the notes keep: a virtual point is never one of them.
      for (const p of made.pairs) expect(p.note.aPoints).toBe(players[p.a - 1].points);
    }
    expect(paired).toBeGreaterThan(200);
  });
});

describe("an accelerated event", () => {
  const rules = { swiss: { rounds: 4, acceleration: 2 } };

  it("is chosen before the draw, and refused where it leaves no round paired as usual, or on another format", async () => {
    const tooMany = await createTournament({ venueId, name: "Too Fast Cup", sport: "badminton", format: "swiss", teamSize: 1, level: null, entryFee: 0, maxEntries: 16, startsOn: addDays(today, 200), endsOn: addDays(today, 202), startHour: 9, endHour: 21, courtIds: courts, rules: { swiss: { rounds: 3, acceleration: 3 } } }, ownerId);
    expect(tooMany).toMatchObject({ ok: false, error: expect.stringContaining("at least one round") });
    const other = await createTournament({ venueId, name: "Not Swiss Cup", sport: "badminton", format: "knockout", teamSize: 1, level: null, entryFee: 0, maxEntries: 16, startsOn: addDays(today, 200), endsOn: addDays(today, 202), startHour: 9, endHour: 21, courtIds: courts, rules: { swiss: { rounds: 3, acceleration: 1 } } }, ownerId);
    expect(other).toMatchObject({ ok: false, error: "Swiss settings are for a Swiss event." });
    // Off by default: an event that never chose it has none.
    const plain = await drawn({}, 8, 3);
    expect(plain.d.swiss!.acceleration).toBeNull();
    expect(round(plain.d, 1).length).toBe(4);
    // With the rounds left to the default (3 for 8 entries), 3 accelerated rounds would leave none: refused at the draw, changing nothing.
    const late = await make({ rules: { swiss: { rounds: null, byePoints: null, tiebreaks: null, acceleration: 3 } } }, 8, 3);
    const refused = await makeDraw(late.id, fixed);
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("leaves none paired as usual") });
    expect((await detail(late.id)).status).not.toBe("drawn");
    expect(await getDb().prepare("SELECT 1 FROM swiss_events WHERE tournament_id = ?").get(late.id)).toBeUndefined();
  });

  it("steers the first rounds with the virtual points and not the later ones, and the table never shows them", async () => {
    const { id, d } = await drawn({ rules });
    const initial = await byRank(id);
    const A = new Set(initial.slice(0, 4));
    expect(d.swiss!.acceleration).toEqual({ rounds: 2, group: 4, points: 1 });
    expect(await getDb().prepare("SELECT accel_rounds, accel_group, accel_points FROM swiss_events WHERE tournament_id = ?").get(id)).toEqual({ accel_rounds: 2, accel_group: 4, accel_points: 1 });
    // Round 1: the best four meet each other, the rest each other.
    for (const m of round(d, 1)) expect(A.has(m.a!)).toBe(A.has(m.b!));
    expect(d.swiss!.rounds[0].notes.filter((x) => x.kind === "pair").every((x) => (x.aVirtual ?? 0) === (A.has(x.a) ? 1 : 0) && (x.bVirtual ?? 0) === (A.has(x.b!) ? 1 : 0))).toBe(true);
    // The table after the round: a win is one point, whoever won; nobody has a point they did not win.
    const r1 = await playRound(id, 1);
    expect(r1.swiss!.standings.map((l) => l.points).sort()).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    // Round 2 is paired on the virtual points: the two A winners (2) meet; the A losers and B winners (1) meet; the B losers (0) meet.
    const [e1, e2, e3, e4, e5, e6, e7, e8] = initial;
    expect(pairKey(r1, 2)).toEqual([[e1, e2], [e3, e5], [e4, e6], [e7, e8]].map((p) => [...p].sort((a, b) => a - b).join("v")).sort());
    expect(pairKey(r1, 2)).toEqual((await expectedPairing(id, 1)).pairs.map((p) => [p.a, p.b].sort((a, b) => a - b).join("v")).sort());
    // Played as if nobody had a virtual point, the same real standing pairs differently (so the points do steer).
    const real = new Map(r1.swiss!.standings.map((l) => [l.entryId, l.points]));
    const ranks = await rankOf(id);
    const plain = pairRound([...ranks.keys()].map((e) => ({ id: e, points: real.get(e) ?? 0, rank: ranks.get(e)! })), new Set(round(r1, 1).map((m) => metKey(m.a!, m.b!))), new Set())!;
    expect(plain.pairs.map((p) => [p.a, p.b].sort((a, b) => a - b).join("v")).sort()).not.toEqual(pairKey(r1, 2));
    const r2 = await playRound(id, 2);
    // After round 2 nothing is virtual any more: round 3 is paired from the real standing, exactly as without acceleration.
    expect(r2.swiss!.rounds[2].notes.every((x) => x.aVirtual === undefined && x.bVirtual === undefined)).toBe(true);
    expect(pairKey(r2, 3)).toEqual((await expectedPairing(id, 2)).pairs.map((p) => [p.a, p.b].sort((a, b) => a - b).join("v")).sort());
    const noVirtual = pairRound([...ranks.keys()].map((e) => ({ id: e, points: (new Map(r2.swiss!.standings.map((l) => [l.entryId, l.points]))).get(e) ?? 0, rank: ranks.get(e)! })), new Set(round(r2, 1).concat(round(r2, 2)).map((m) => metKey(m.a!, m.b!))), new Set(), new Map([...ranks.keys()].map((e) => [e, round(r2, 1).concat(round(r2, 2)).reduce((s, m) => s + (m.a === e ? 1 : m.b === e ? -1 : 0), 0)])))!;
    expect(pairKey(r2, 3)).toEqual(noVirtual.pairs.map((p) => [p.a, p.b].sort((a, b) => a - b).join("v")).sort());
    // The table is the pure function of the recorded results, whichever way the rounds were paired.
    expect(r2.swiss!.standings.map((l) => [l.entryId, l.points, l.buchholz, l.rank])).toEqual((await replayTable(id)).map((l) => [l.entryId, l.points, l.buchholz, l.rank]));
    const decided = r2.matches.filter((m) => m.status === "done").length;
    expect(r2.swiss!.standings.reduce((s, l) => s + l.points, 0)).toBe(decided);
  });

  it("plays to a finish, and its ratings are those of the decided matches: a virtual point is never rated", async () => {
    const made = await make({ rules: { swiss: { rounds: 3, acceleration: 1 } } }, 8, 3);
    expect((await setEventRated("tournament", made.id, true)).ok).toBe(true);
    const done = await makeDraw(made.id, fixed);
    if (!done.ok) throw new Error(done.error);
    for (let r = 1; r <= 3; r++) await playRound(made.id, r);
    const fin = await detail(made.id);
    expect(fin.status).toBe("finished");
    const rated = (await getDb().prepare("SELECT source_match, outcome FROM rated_results WHERE source_kind = 'tournament' AND source_id = ? AND voided_at IS NULL ORDER BY source_match").all(made.id)) as { source_match: number; outcome: string }[];
    const decided = fin.matches.filter((m) => m.status === "done");
    expect(rated.map((x) => x.source_match).sort((a, b) => a - b)).toEqual(decided.map((m) => m.id).sort((a, b) => a - b));
    // Every outcome is the recorded one: the match's real winner won it, whatever the virtual standing said.
    expect(rated).toHaveLength(12);
    expect(fin.swiss!.standings.map((l) => l.points)).toEqual((await replayTable(made.id)).map((l) => l.points));
  });

  it("gives an odd field's bye to the lowest of the second half, and a point is a point for it as for anybody", async () => {
    const { id, d } = await drawn({ rules: { swiss: { rounds: 3, acceleration: 1 } } }, 9, 3);
    const initial = await byRank(id);
    const bye = round(d, 1).find((m) => m.status === "bye")!;
    expect(bye.a).toBe(initial[8]);
    expect(d.swiss!.rounds[0].notes.find((x) => x.kind === "bye")!.aVirtual).toBeUndefined();
    const A = new Set(initial.slice(0, 6));
    for (const m of round(d, 1).filter((x) => x.status !== "bye")) expect(A.has(m.a!)).toBe(A.has(m.b!));
    const r1 = await playRound(id, 1);
    // The bye is worth what a win is: a real point, in the table.
    expect(r1.swiss!.standings.find((l) => l.entryId === initial[8])!.points).toBe(1);
  });

  it("keeps the accelerated group fixed when somebody leaves: nobody is moved in or out, and the leaver is not paired again", async () => {
    const { id, d } = await drawn({ rules }, 8, 4);
    const initial = await byRank(id);
    const leaver = initial[2];
    const left = await takeOut(leaver, "withdrawn");
    expect(left.ok).toBe(true);
    await playRound(id, 1);
    const r1 = await detail(id);
    expect(r1.swiss!.rounds).toHaveLength(2);
    expect(round(r1, 2).some((m) => m.a === leaver || m.b === leaver)).toBe(false);
    expect(await getDb().prepare("SELECT accel_group FROM swiss_events WHERE tournament_id = ?").get(id)).toEqual({ accel_group: 4 });
    // Seven are left: a bye, and the pairing is what the stored rules give from the recorded results.
    expect(round(r1, 2).some((m) => m.status === "bye")).toBe(true);
    const want = await expectedPairing(id, 1);
    expect(pairKey(r1, 2)).toEqual(want.pairs.map((p) => [p.a, p.b].sort((a, b) => a - b).join("v")).sort());
    expect(round(r1, 2).find((m) => m.status === "bye")!.a).toBe(want.bye!.id);
    expect(d.swiss!.acceleration).toEqual(r1.swiss!.acceleration);
  });

  it("pairs again after a correction exactly as a fresh pairing from the corrected results would, virtual points included, and the table stays the replay", async () => {
    const { id } = await drawn({ rules }, 8, 4);
    await playRound(id, 1);
    const before = await detail(id);
    const target = round(before, 1)[0];
    const flipped = { winner: target.winner === target.a ? target.b! : target.a!, score: target.winner === target.a ? "10-21, 12-21" : "21-10, 21-12" };
    const p = await previewResult(target.id, flipped);
    if (!p.ok) throw new Error(p.error);
    const done = await applyCorrection(target.id, flipped, { mode: "replace", reason: "The score was entered the wrong way round", token: p.value.token }, manager);
    expect(done.ok).toBe(true);
    const after = await detail(id);
    expect(pairKey(after, 2)).toEqual((await expectedPairing(id, 1)).pairs.map((x) => [x.a, x.b].sort((a, b) => a - b).join("v")).sort());
    // The new round carries the virtual points in its notes as the first did, and the table has none.
    expect(after.swiss!.rounds[1].notes.some((x) => (x.aVirtual ?? 0) > 0 || (x.bVirtual ?? 0) > 0)).toBe(true);
    expect(after.swiss!.standings.map((l) => [l.entryId, l.points, l.rank])).toEqual((await replayTable(id)).map((l) => [l.entryId, l.points, l.rank]));
    // Replaying the whole event from nothing but the recorded results (a standing correction) leaves it the same.
    await playRound(id, 2);
    await playRound(id, 3);
    const fin = await playRound(id, 4);
    expect(fin.status).toBe("finished");
    expect(fin.swiss!.standings.map((l) => [l.entryId, l.points])).toEqual((await replayTable(id)).map((l) => [l.entryId, l.points]));
  });

  it("is reproducible from the recorded seed: the same seed gives the same initial order and so the same round 1", async () => {
    const { id, entries, d } = await drawn({ rules }, 8, 4);
    const seed = d.swiss!.seed;
    const again = drawInitialOrder(entries.map((e) => ({ id: e, seed: null })), () => seed / 4294967296);
    expect(again.seed).toBe(seed);
    expect(again.initial).toEqual(await byRank(id));
    const first = pairRound(
      again.initial.map((e, i) => ({ id: e, points: 0, rank: i + 1, virtual: virtualPointsFor(1, 2, 4, i + 1, 1) })),
      new Set(),
      new Set()
    )!;
    expect(first.pairs.map((x) => [x.a, x.b].sort((a, b) => a - b).join("v")).sort()).toEqual(pairKey(d, 1));
  });

  it("previews the round that is due without making it: each pairing with its reason, the bye, and whether it fits; and makes exactly that", async () => {
    const { id } = await drawn({ rules }, 9, 4);
    await playRound(id, 1);
    // Round 2 paired by itself; take it back to the state of a round that could not be paired (no court time then), keeping the results.
    const db = getDb();
    await db.prepare("DELETE FROM tournament_matches WHERE tournament_id = ? AND stage = 'group' AND round = 2").run(id);
    await db.prepare("DELETE FROM swiss_rounds WHERE tournament_id = ? AND round = 2").run(id);
    const looked = await previewNextRound(id);
    if (!looked.ok) throw new Error(looked.error);
    expect(looked.value.round).toBe(2);
    expect(looked.value.unplaced).toBe(0);
    expect(looked.value.pairs.length).toBe(4);
    expect(looked.value.bye).not.toBeNull();
    expect(looked.value.pairs.some((x) => (x.note.aVirtual ?? 0) > 0)).toBe(true);
    // Looking changed nothing.
    expect((await detail(id)).swiss!.rounds).toHaveLength(1);
    expect(round(await detail(id), 2)).toHaveLength(0);
    const made = await pairNextRound(id);
    expect(made).toEqual({ ok: true, paired: 2 });
    const after = await detail(id);
    expect(pairKey(after, 2)).toEqual(looked.value.pairs.map((x) => [x.a, x.b].sort((a, b) => a - b).join("v")).sort());
    expect(round(after, 2).find((m) => m.status === "bye")!.a).toBe(looked.value.bye!.id);
    expect(after.swiss!.rounds[1].notes.filter((x) => x.kind === "pair").map((x) => x.aVirtual ?? 0)).toEqual(looked.value.pairs.map((x) => x.note.aVirtual ?? 0));
    // Nothing is due once the round is paired.
    expect(await previewNextRound(id)).toMatchObject({ ok: false, code: "NOT_READY" });
  });

  it("is deterministic: the default scoring's table has no randomness and no virtual field", () => {
    const results: SwissResult[] = [{ a: 1, b: 2, winner: 1, score: "21-10, 21-12", status: "done" }];
    const table = swissStandings([1, 2, 3, 4], new Map([[1, 1], [2, 2], [3, 3], [4, 4]]), results, DEFAULT_SCORING, { byePoints: 1, tiebreaks: ["buchholz"] });
    expect(table.map((l) => [l.entryId, l.points])).toEqual([[1, 1], [2, 0], [3, 0], [4, 0]]);
    expect(Object.keys(table[0])).not.toContain("virtual");
  });
});
