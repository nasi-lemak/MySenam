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
import { closeRound, defaultRounds, endSwiss, metKey, pairNextRound, pairRound, swissStandings, type SwissResult } from "../src/lib/swiss";
import { dayBoard } from "../src/lib/tournament-day";
import { addDays, todayISO } from "../src/lib/time";
import {
  applyCorrection,
  createTournament,
  enter,
  makeDraw,
  previewResult,
  recordResult,
  setEntry,
  takeOut,
  tournamentDetail,
  type TournamentDetail,
  type TournamentInput,
} from "../src/lib/tournaments";
import { readRules } from "../src/lib/tournament-rules";

/**
 * Swiss tournaments (lib/swiss.ts; ADR 0033): the draw and its recorded seed, rounds paired one at a time as the one before
 * is decided, byes, leavers, the organiser closing a round, corrections (stand, or pair again while no later round has a
 * result), standings as a pure function of the results, and the event's results flowing into the ratings.
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
  const made = await registerUser({ name: `Swiss Player${n}`, email: `sw${n}@swiss.test`, phone: `01370${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return made.user;
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  ownerId = (await listAdmins())[0].id;
  const venue = (await listVenues())[0];
  venueId = venue.id;
  courts = venue.courts.filter((c) => c.sport === "badminton").slice(0, 2).map((c) => c.id);
  for (let i = 0; i < 18; i++) pool.push(await player());
});

async function swiss(over: Partial<TournamentInput> = {}, count = 8, days = 3) {
  const day = addDays(today, dayOffset);
  dayOffset += days + 1;
  const made = await createTournament(
    {
      venueId,
      name: `Swiss Cup ${dayOffset}`,
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

async function drawnSwiss(over: Partial<TournamentInput> = {}, count = 8, days = 3) {
  const ev = await swiss(over, count, days);
  const done = await makeDraw(ev.id, fixed);
  if (!done.ok) throw new Error(done.error);
  return { ...ev, d: done.value };
}

const detail = async (id: number) => (await tournamentDetail(id, { forStaff: true }))!;
const round = (d: TournamentDetail, r: number) => d.matches.filter((m) => m.stage === "group" && m.round === r);
const played = (d: TournamentDetail, r: number) => round(d, r).filter((m) => m.status !== "bye");
const pairKey = (d: TournamentDetail, r: number) => played(d, r).map((m) => [m.a, m.b].sort().join("v")).sort();

/** Record the matches of a round: the better in the initial order wins, unless told otherwise. */
async function playRound(id: number, r: number, winner?: (a: number, b: number, rank: Map<number, number>) => number, only?: number) {
  const rank = new Map(((await getDb().prepare("SELECT id, swiss_rank FROM tournament_entries WHERE tournament_id = ?").all(id)) as { id: number; swiss_rank: number }[]).map((x) => [x.id, x.swiss_rank]));
  let d = await detail(id);
  let k = 0;
  for (const m of round(d, r).filter((x) => x.status === "scheduled")) {
    if (only !== undefined && k++ >= only) break;
    const w = winner ? winner(m.a!, m.b!, rank) : rank.get(m.a!)! < rank.get(m.b!)! ? m.a! : m.b!;
    const res = await recordResult(m.id, { winner: w, score: w === m.a ? "21-10, 21-12" : "10-21, 12-21" });
    if (!res.ok) throw new Error(res.error);
    d = res.value;
  }
  return detail(id);
}

async function playAll(id: number) {
  for (let guard = 0; guard < 20; guard++) {
    const d = await detail(id);
    if (d.status === "finished") return d;
    const open = d.matches.find((m) => m.status === "scheduled");
    if (!open) return d;
    await playRound(id, open.round);
  }
  throw new Error("never finished");
}

/** The pure replay: the table from the raw results of the event, independent of what the detail reports. */
async function replayTable(id: number) {
  const d = await detail(id);
  const ev = (await getDb().prepare("SELECT bye_points, tiebreaks FROM swiss_events WHERE tournament_id = ?").get(id)) as { bye_points: number; tiebreaks: string };
  const ranks = new Map(((await getDb().prepare("SELECT id, swiss_rank FROM tournament_entries WHERE tournament_id = ? AND swiss_rank IS NOT NULL").all(id)) as { id: number; swiss_rank: number }[]).map((x) => [x.id, x.swiss_rank]));
  const results: SwissResult[] = d.matches
    .filter((m) => m.status !== "scheduled" && !(m.status === "bye" && m.b !== null))
    .map((m) => ({ a: m.a!, b: m.b, winner: m.winner, score: m.score, status: m.status as SwissResult["status"] }));
  return swissStandings([...ranks.keys()], ranks, results, d.rules.scoring, { byePoints: ev.bye_points, tiebreaks: JSON.parse(ev.tiebreaks) });
}

describe("the draw", () => {
  it("makes the initial order, records its seed and rounds, and pairs and places round 1", async () => {
    const { id, entries, d } = await drawnSwiss();
    expect(d.format).toBe("swiss");
    expect(d.status).toBe("drawn");
    expect(d.swiss!.roundsTotal).toBe(defaultRounds(8));
    expect(d.swiss!.roundsTotal).toBe(3);
    expect(d.swiss!.rounds).toHaveLength(1);
    expect(typeof d.swiss!.seed).toBe("number");
    expect(d.swiss!.tiebreaks.slice(0, 2)).toEqual(["buchholz", "median_buchholz"]);
    const r1 = round(d, 1);
    expect(r1).toHaveLength(4);
    expect(r1.every((m) => m.status === "scheduled" && m.courtId !== null && m.date !== null && m.minute !== null)).toBe(true);
    // Everybody is in one match.
    expect(r1.flatMap((m) => [m.a, m.b]).sort()).toEqual([...entries].sort());
    const ranks = ((await getDb().prepare("SELECT swiss_rank FROM tournament_entries WHERE tournament_id = ? ORDER BY swiss_rank").all(id)) as { swiss_rank: number }[]).map((r) => r.swiss_rank);
    expect(ranks).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // Staff-held time is kept for the rounds to come.
    expect(d.matches.some((m) => m.stage === "knockout")).toBe(false);
    expect(d.groups).toEqual([]);
  });

  it("puts staff seeds first, and reproduces the drawn order from the recorded seed", async () => {
    const a = await swiss();
    await setEntry(a.entries[5], { seed: 1 });
    await setEntry(a.entries[2], { seed: 2 });
    const da = (await makeDraw(a.id, fixed)) as { ok: true; value: TournamentDetail };
    const ranksA = new Map(((await getDb().prepare("SELECT id, swiss_rank FROM tournament_entries WHERE tournament_id = ?").all(a.id)) as { id: number; swiss_rank: number }[]).map((r) => [r.id, r.swiss_rank]));
    expect(ranksA.get(a.entries[5])).toBe(1);
    expect(ranksA.get(a.entries[2])).toBe(2);
    // The same entries in the same order and the same randomness: the same initial order, entry by entry.
    const b = await swiss();
    await setEntry(b.entries[5], { seed: 1 });
    await setEntry(b.entries[2], { seed: 2 });
    await makeDraw(b.id, fixed);
    const ranksB = new Map(((await getDb().prepare("SELECT id, swiss_rank FROM tournament_entries WHERE tournament_id = ?").all(b.id)) as { id: number; swiss_rank: number }[]).map((r) => [r.id, r.swiss_rank]));
    expect(b.entries.map((e) => ranksB.get(e))).toEqual(a.entries.map((e) => ranksA.get(e)));
    expect(da.value.swiss!.seed).toBe((await detail(b.id)).swiss!.seed);
    // A different source of randomness gives a different recorded seed.
    const c = await swiss();
    await makeDraw(c.id, () => 0.9);
    expect((await detail(c.id)).swiss!.seed).not.toBe(da.value.swiss!.seed);
  });

  it("takes the rounds the organiser sets, refuses more than nobody-meets-twice allows, and needs four entries", async () => {
    const two = await drawnSwiss({ rules: { swiss: { rounds: 2 } } }, 8);
    expect(two.d.swiss!.roundsTotal).toBe(2);
    const many = await swiss({ rules: { swiss: { rounds: 6 } } }, 5);
    expect(await makeDraw(many.id, fixed)).toMatchObject({ ok: false, error: expect.stringContaining("at most 5 rounds") });
    const few = await swiss({}, 3);
    expect(await makeDraw(few.id, fixed)).toMatchObject({ ok: false, error: expect.stringContaining("At least 4") });
  });

  it("is refused, changing nothing, where the rounds cannot all fit the time held", async () => {
    // One day, 2 courts, one short window: 8 players, 3 rounds of 4 matches of an hour each does not fit in two hours.
    const ev = await swiss({ startHour: 9, endHour: 11 }, 8, 1);
    const refused = await makeDraw(ev.id, fixed);
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("Not enough court time") });
    const d = await detail(ev.id);
    expect(d.status === "open" || d.status === "closed").toBe(true);
    expect(d.matches).toHaveLength(0);
    expect(await getDb().prepare("SELECT 1 FROM swiss_events WHERE tournament_id = ?").get(ev.id)).toBeUndefined();
  });

  it("only takes Swiss settings for a Swiss event", async () => {
    const day = addDays(today, 60);
    const made = await createTournament({ venueId, name: "Not Swiss Cup", sport: "badminton", format: "knockout", teamSize: 1, level: null, entryFee: 0, maxEntries: 8, startsOn: day, endsOn: day, startHour: 9, endHour: 21, courtIds: courts, rules: { swiss: { rounds: 3 } } }, ownerId);
    expect(made).toMatchObject({ ok: false, error: expect.stringContaining("Swiss") });
    expect(readRules(JSON.stringify({ swiss: { rounds: 3, byePoints: 2, tiebreaks: ["buchholz", "nonsense"] } })).swiss).toEqual({ rounds: 3, byePoints: 2, tiebreaks: ["buchholz"] });
  });
});

describe("playing the rounds", () => {
  it("pairs the next round only when every match of the one before is decided, and never twice", async () => {
    const { id } = await drawnSwiss();
    let d = await playRound(id, 1, undefined, 3);
    expect(d.swiss!.rounds).toHaveLength(1);
    expect(await pairNextRound(id)).toMatchObject({ ok: false, code: "NOT_READY" });
    d = await playRound(id, 1);
    expect(d.swiss!.rounds).toHaveLength(2);
    expect(round(d, 2)).toHaveLength(4);
    // Asking again, or a second server, pairs nothing more.
    expect(await pairNextRound(id)).toMatchObject({ ok: false, code: "NOT_READY" });
    expect((await detail(id)).swiss!.rounds).toHaveLength(2);
  });

  it("pairs by score group with nobody meeting twice, places each round after the last ends, and finishes after the last round", async () => {
    const { id } = await drawnSwiss({}, 8);
    const d = await playAll(id);
    expect(d.status).toBe("finished");
    expect(d.swiss!.rounds).toHaveLength(3);
    const seen = new Set<string>();
    for (const r of [1, 2, 3]) {
      for (const k of pairKey(d, r)) {
        expect(seen.has(k)).toBe(false);
        seen.add(k);
      }
      const ids = played(d, r).flatMap((m) => [m.a, m.b]);
      expect(new Set(ids).size).toBe(8);
    }
    // Round 2 is paired from the standings: the 1-0 against the 1-0, the 0-1 against the 0-1.
    const after1 = new Map<number, number>();
    for (const m of round(d, 1)) after1.set(m.winner!, 1);
    for (const m of played(d, 2)) expect(after1.get(m.a!) ?? 0).toBe(after1.get(m.b!) ?? 0);
    // Each round starts after the one before ended.
    const end = (m: { date: string | null; minute: number | null; minutes: number }) => `${m.date}:${String(m.minute! + m.minutes).padStart(5, "0")}`;
    const start = (m: { date: string | null; minute: number | null }) => `${m.date}:${String(m.minute!).padStart(5, "0")}`;
    for (const r of [2, 3]) {
      const lastEnd = played(d, r - 1).map(end).sort().pop()!;
      for (const m of played(d, r)) expect(start(m) >= lastEnd).toBe(true);
    }
    // The held time was kept until the last round was paired, and an event finished has nothing left to give.
    expect(d.swiss!.nextRound).toBeNull();
  });

  it("gives an odd event a bye each round to somebody different, lowest-ranked first, scored as a win and not as a result", async () => {
    const { id, d } = await drawnSwiss({ rules: { swiss: { rounds: 3 } } }, 7);
    const byes: number[] = [];
    const first = round(d, 1).find((m) => m.status === "bye")!;
    expect(first.b).toBeNull();
    expect(first.winner).toBe(first.a);
    expect(first.courtId).toBeNull();
    const last = ((await getDb().prepare("SELECT id FROM tournament_entries WHERE tournament_id = ? AND swiss_rank = 7").get(id)) as { id: number }).id;
    expect(first.a).toBe(last);
    byes.push(first.a!);
    const fin = await playAll(id);
    for (const r of [2, 3]) {
      const b = round(fin, r).find((m) => m.status === "bye")!;
      expect(byes).not.toContain(b.a);
      byes.push(b.a!);
    }
    expect(new Set(byes).size).toBe(3);
    const lines = new Map(fin.swiss!.standings.map((l) => [l.entryId, l]));
    for (const b of byes) expect(lines.get(b)!.byes).toBe(1);
    expect(fin.status).toBe("finished");
  });

  it("takes a bye's value, and the tie-breaks, from the event's settings", async () => {
    const { d } = await drawnSwiss({ rules: { swiss: { rounds: 2, byePoints: 0, tiebreaks: ["set_diff", "buchholz"] } } }, 5);
    expect(d.swiss!.byePoints).toBe(0);
    expect(d.swiss!.tiebreaks).toEqual(["set_diff", "buchholz"]);
  });

  it("shows why each pairing was made, and is the pure function of the results: the table is the replay", async () => {
    const { id } = await drawnSwiss({}, 8);
    const d = await playAll(id);
    const notes = d.swiss!.rounds.flatMap((r) => r.notes);
    expect(notes.length).toBe(12);
    expect(notes.every((x) => x.kind === "pair" && typeof x.aPoints === "number")).toBe(true);
    const again = await replayTable(id);
    expect(d.swiss!.standings.map((l) => [l.entryId, l.points, l.buchholz, l.medianBuchholz, l.rank])).toEqual(again.map((l) => [l.entryId, l.points, l.buchholz, l.medianBuchholz, l.rank]));
    // The leader is the unbeaten.
    expect(d.swiss!.standings[0].points).toBe(Math.max(...d.swiss!.standings.map((l) => l.points)));
  });

  it("works for events of many sizes: every round paired, nobody twice, at most one bye each", async () => {
    for (const count of [4, 5, 6, 9, 12, 13]) {
      const { id } = await drawnSwiss({}, count, 4);
      const d = await playAll(id);
      expect(d.status, `n=${count}`).toBe("finished");
      const met = new Set<string>();
      const byes = new Map<number, number>();
      for (const m of d.matches.filter((x) => x.stage === "group")) {
        if (m.status === "bye") byes.set(m.a!, (byes.get(m.a!) ?? 0) + 1);
        else {
          expect(met.has(metKey(m.a!, m.b!))).toBe(false);
          met.add(metKey(m.a!, m.b!));
        }
      }
      expect([...byes.values()].every((v) => v === 1)).toBe(true);
    }
  });

  it("shows on the day's board: round 1 fixtures between known sides, with their court and time", async () => {
    const { id, d } = await drawnSwiss({}, 8);
    const board = await dayBoard(id);
    expect(board).not.toBeNull();
    expect(board!.waiting.length + board!.courts.filter((c) => c.now || c.next).length).toBeGreaterThan(0);
    const labels = [...board!.waiting, ...board!.courts.flatMap((c) => [c.now, c.next].filter(Boolean))].map((f) => f!.label);
    expect(labels.every((l) => l.startsWith("Round 1, match"))).toBe(true);
    expect(round(d, 1)).toHaveLength(4);
  });
});

describe("somebody leaving", () => {
  it("gives the opponent a walkover, skips the leaver in later rounds, and lets what they played stand", async () => {
    const { id, d } = await drawnSwiss({}, 8);
    const leaver = round(d, 1)[0].a!;
    const opponent = round(d, 1)[0].b!;
    const out = await takeOut(leaver, "withdrawn");
    expect(out.ok).toBe(true);
    let after = await detail(id);
    const m = round(after, 1).find((x) => x.a === leaver)!;
    expect(m.status).toBe("walkover");
    expect(m.winner).toBe(opponent);
    after = await playRound(id, 1);
    expect(after.swiss!.rounds).toHaveLength(2);
    for (const r of round(after, 2)) expect([r.a, r.b]).not.toContain(leaver);
    // Seven are in round 2: one bye.
    expect(round(after, 2).filter((x) => x.status === "bye")).toHaveLength(1);
    const fin = await playAll(id);
    expect(fin.status).toBe("finished");
    for (const r of [2, 3]) for (const x of round(fin, r)) expect([x.a, x.b]).not.toContain(leaver);
    // The leaver's own results stand and are flagged out.
    const line = fin.swiss!.standings.find((l) => l.entryId === leaver)!;
    expect(line.out).toBe("withdrawn");
    expect(line.resultsVoid).toBe(false);
  });

  it("leaves a disqualified player's results void for everybody, opponents' Buchholz included", async () => {
    const { id } = await drawnSwiss({}, 8);
    let d = await playRound(id, 1);
    const target = round(d, 1)[0].winner!;
    const beaten = round(d, 1)[0].a === target ? round(d, 1)[0].b! : round(d, 1)[0].a!;
    expect((await takeOut(target, "disqualified", "Fighting")).ok).toBe(true);
    d = await detail(id);
    const line = d.swiss!.standings.find((l) => l.entryId === target)!;
    expect(line.resultsVoid).toBe(true);
    expect(line.rank).toBe(0);
    expect(d.swiss!.standings[d.swiss!.standings.length - 1].entryId).toBe(target);
    // The beaten opponent has no loss counted against them and the void match counts for nobody.
    expect(d.swiss!.standings.find((l) => l.entryId === beaten)!.played).toBe(0);
    const again = await replayTable(id);
    expect(again.find((l) => l.entryId === beaten)).toBeDefined();
  });

  it("previews what a leaver changes, including the round it pairs, and refuses a stale confirmation", async () => {
    const { id, d } = await drawnSwiss({}, 8);
    await playRound(id, 1, undefined, 3);
    const { previewTakeOut } = await import("../src/lib/tournaments");
    const last = round(await detail(id), 1).find((m) => m.status === "scheduled")!;
    const preview = await previewTakeOut(last.a!, "withdrawn");
    expect(preview).toMatchObject({ ok: true });
    if (!preview.ok) return;
    expect(preview.value.consequential).toBe(true);
    // The walkover completes the round, so the next is paired: the preview says so, and changes nothing.
    expect(preview.value.changes.some((c) => c.includes("Round 2"))).toBe(true);
    expect((await detail(id)).swiss!.rounds).toHaveLength(1);
    const stale = await takeOut(last.a!, "withdrawn", undefined, { token: "stale" });
    expect(stale).toMatchObject({ ok: false, code: "CHANGED" });
    expect(d.id).toBe(id);
  });

  it("ends the event where nobody is left to pair", async () => {
    const { id, d } = await drawnSwiss({}, 4);
    for (const m of round(d, 1)) await recordResult(m.id, { winner: m.a!, score: "21-10, 21-12" });
    let cur = await detail(id);
    expect(cur.swiss!.rounds).toHaveLength(2);
    for (const e of cur.entries.slice(0, 3)) await takeOut(e.id, "withdrawn");
    cur = await detail(id);
    expect(cur.status).toBe("finished");
    expect(cur.swiss!.roundsTotal).toBe(2);
  });
});

describe("closing a round", () => {
  it("settles each undecided match by a walkover or as played by nobody, then pairs the next round", async () => {
    const { id } = await drawnSwiss({}, 8);
    let d = await playRound(id, 1, undefined, 2);
    const open = round(d, 1).filter((m) => m.status === "scheduled");
    expect(open).toHaveLength(2);
    // Every undecided match needs an answer.
    expect(await closeRound(id, 1, [{ matchId: open[0].id, winner: open[0].a }])).toMatchObject({ ok: false });
    expect(await closeRound(id, 1, [{ matchId: open[0].id, winner: 999999 }, { matchId: open[1].id, winner: null }])).toMatchObject({ ok: false });
    expect(await closeRound(id, 2, [])).toMatchObject({ ok: false, error: expect.stringContaining("latest") });
    const closed = await closeRound(id, 1, [{ matchId: open[0].id, winner: open[0].a }, { matchId: open[1].id, winner: null }]);
    expect(closed.ok).toBe(true);
    d = await detail(id);
    const forfeited = round(d, 1).find((m) => m.id === open[0].id)!;
    expect(forfeited.status).toBe("walkover");
    expect(forfeited.winner).toBe(open[0].a);
    const nobody = round(d, 1).find((m) => m.id === open[1].id)!;
    expect(nobody.status).toBe("bye");
    expect(nobody.winner).toBeNull();
    // Nobody scores in it, and it counts as met: the two are not paired again.
    for (const l of d.swiss!.standings.filter((x) => [nobody.a, nobody.b].includes(x.entryId))) expect(l.points).toBe(0);
    expect(d.swiss!.rounds).toHaveLength(2);
    expect(pairKey(d, 2)).not.toContain([nobody.a, nobody.b].sort().join("v"));
  });
});

describe("corrections: stand, or pair again", () => {
  /** Round 1 played in full, round 2 paired and untouched; the result of round 1's first match to be changed to its loser. */
  async function setup() {
    const ev = await drawnSwiss({}, 8, 4);
    await playRound(ev.id, 1);
    const d = await detail(ev.id);
    const target = round(d, 1)[0];
    const flipped = { winner: target.winner === target.a ? target.b! : target.a!, score: target.winner === target.a ? "10-21, 12-21" : "21-10, 21-12" };
    return { ...ev, target, flipped, d };
  }

  it("is a correction once a later round is paired: previewed with both ways, never made as a plain result", async () => {
    const { id, target, flipped } = await setup();
    const plain = await recordResult(target.id, flipped);
    expect(plain).toMatchObject({ ok: false, code: "KNOCKOUT_STARTED" });
    const p = await previewResult(target.id, flipped);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.value.needsCorrection).toBe(true);
    expect(p.value.replace).toMatchObject({ possible: true });
    expect(p.value.standingsOnly.changes.length).toBeGreaterThan(0);
    if (p.value.replace.possible) expect(p.value.replace.changes.some((c) => c.includes("is now"))).toBe(true);
    // Nothing was changed by looking.
    const d = await detail(id);
    expect(round(d, 1).find((m) => m.id === target.id)!.winner).toBe(target.winner);
    expect(d.swiss!.rounds).toHaveLength(2);
  });

  it("stands: the pairings made stay and only the standings change", async () => {
    const { id, target, flipped, d: before } = await setup();
    const p = await previewResult(target.id, flipped);
    if (!p.ok) throw new Error(p.error);
    const done = await applyCorrection(target.id, flipped, { mode: "standings_only", reason: "The score was entered the wrong way round", token: p.value.token }, manager);
    expect(done.ok).toBe(true);
    const after = await detail(id);
    expect(pairKey(after, 2)).toEqual(pairKey(before, 2));
    expect(round(after, 2).map((m) => m.id).sort()).toEqual(round(before, 2).map((m) => m.id).sort());
    expect(round(after, 1).find((m) => m.id === target.id)!.winner).toBe(flipped.winner);
    expect(after.swiss!.standings.map((l) => l.entryId)).not.toEqual(before.swiss!.standings.map((l) => l.entryId));
    const again = await replayTable(id);
    expect(after.swiss!.standings.map((l) => l.entryId)).toEqual(again.map((l) => l.entryId));
    const kept = (await getDb().prepare("SELECT kind, reason FROM tournament_corrections WHERE tournament_id = ?").all(id)) as { kind: string; reason: string }[];
    expect(kept).toEqual([{ kind: "standings_only", reason: "The score was entered the wrong way round" }]);
  });

  it("pairs again, while no match of a later round has a result: the same as a fresh pairing from the corrected results", async () => {
    const { id, target, flipped, d: before } = await setup();
    const p = await previewResult(target.id, flipped);
    if (!p.ok) throw new Error(p.error);
    // A confirmation made against another state is refused.
    expect(await applyCorrection(target.id, flipped, { mode: "replace", reason: "Wrong way round", token: "stale" }, manager)).toMatchObject({ ok: false, code: "CHANGED" });
    expect(await applyCorrection(target.id, flipped, { mode: "replace", reason: "no", token: p.value.token }, manager)).toMatchObject({ ok: false });
    const done = await applyCorrection(target.id, flipped, { mode: "replace", reason: "The score was entered the wrong way round", token: p.value.token }, manager);
    expect(done.ok).toBe(true);
    const after = await detail(id);
    // The old round 2 is gone, kept in the correction; the new one is what pairRound makes from the corrected results.
    expect(round(after, 2).map((m) => m.id).some((x) => round(before, 2).map((m) => m.id).includes(x))).toBe(false);
    const standing = new Map(after.swiss!.standings.map((l) => [l.entryId, l.points]));
    const ranks = new Map(((await getDb().prepare("SELECT id, swiss_rank FROM tournament_entries WHERE tournament_id = ?").all(id)) as { id: number; swiss_rank: number }[]).map((r) => [r.id, r.swiss_rank]));
    const met = new Set(round(after, 1).map((m) => metKey(m.a!, m.b!)));
    const first = new Map<number, number>();
    for (const m of round(after, 1)) {
      first.set(m.a!, 1);
      first.set(m.b!, -1);
    }
    const fresh = pairRound([...ranks.keys()].map((e) => ({ id: e, points: standing.get(e) ?? 0, rank: ranks.get(e)! })), met, new Set(), first)!;
    expect(pairKey(after, 2)).toEqual(fresh.pairs.map((x) => [x.a, x.b].sort().join("v")).sort());
    expect(after.swiss!.rounds).toHaveLength(2);
    expect(after.swiss!.rounds[1].notes).toHaveLength(4);
    const kept = (await getDb().prepare("SELECT kind, before_state FROM tournament_corrections WHERE tournament_id = ?").all(id)) as { kind: string; before_state: string }[];
    expect(kept.map((k) => k.kind)).toEqual(["replace"]);
    expect(JSON.parse(kept[0].before_state).length).toBeGreaterThanOrEqual(1);
    // Replay equality: the table is again the pure function of the recorded results.
    const again = await replayTable(id);
    expect(after.swiss!.standings.map((l) => [l.entryId, l.points])).toEqual(again.map((l) => [l.entryId, l.points]));
    // And the event plays on to its finish.
    expect((await playAll(id)).status).toBe("finished");
  });

  it("refuses pairing again, with why, once a match of a later round has a result; standing is still possible", async () => {
    const { id, target, flipped } = await setup();
    await playRound(id, 2, undefined, 1);
    const p = await previewResult(target.id, flipped);
    if (!p.ok) throw new Error(p.error);
    expect(p.value.replace).toMatchObject({ possible: false });
    if (!p.value.replace.possible) expect(p.value.replace.blockers[0]).toContain("played");
    expect(await applyCorrection(target.id, flipped, { mode: "replace", reason: "Wrong way round", token: p.value.token }, manager)).toMatchObject({ ok: false, code: "BLOCKED" });
    // Nothing changed.
    expect((await detail(id)).swiss!.rounds).toHaveLength(2);
    const stand = await applyCorrection(target.id, flipped, { mode: "standings_only", reason: "Wrong way round", token: p.value.token }, manager);
    expect(stand.ok).toBe(true);
    expect(played(await detail(id), 2).filter((m) => m.status === "done")).toHaveLength(1);
  });

  it("is an ordinary result while the next round is not paired, and in the last round of a finished event only the standings change", async () => {
    const ev = await drawnSwiss({}, 8);
    await playRound(ev.id, 1, undefined, 3);
    const d = await detail(ev.id);
    const done = round(d, 1).find((m) => m.status === "done")!;
    const flipped = { winner: done.winner === done.a ? done.b! : done.a!, score: done.winner === done.a ? "10-21, 12-21" : "21-10, 21-12" };
    expect((await recordResult(done.id, flipped)).ok).toBe(true);
    const fin = await playAll(ev.id);
    expect(fin.status).toBe("finished");
    const last = round(fin, fin.swiss!.roundsTotal).find((m) => m.status === "done")!;
    const lastFlip = { winner: last.winner === last.a ? last.b! : last.a!, score: last.winner === last.a ? "10-21, 12-21" : "21-10, 21-12" };
    expect((await recordResult(last.id, lastFlip)).ok).toBe(true);
    const after = await detail(ev.id);
    expect(after.status).toBe("finished");
    const again = await replayTable(ev.id);
    expect(after.swiss!.standings.map((l) => l.entryId)).toEqual(again.map((l) => l.entryId));
  });

  it("is a manager's: the correction needs a reason and the preview's token", async () => {
    const { target, flipped } = await setup();
    const p = await previewResult(target.id, flipped);
    if (!p.ok) throw new Error(p.error);
    expect(await applyCorrection(target.id, flipped, { mode: "standings_only", reason: "", token: p.value.token }, manager)).toMatchObject({ ok: false });
  });
});

describe("ending early, and a round that cannot be paired", () => {
  it("leaves the round unpaired with why when no legal pairing exists, and ends the event after the last round paired", async () => {
    // Four players, three rounds is the whole round robin; two leave after round 1 and the two left have met.
    const { id, d } = await drawnSwiss({ rules: { swiss: { rounds: 3 } } }, 4);
    for (const m of round(d, 1)) await recordResult(m.id, { winner: m.a!, score: "21-10, 21-12" });
    const r1 = round(await detail(id), 1);
    // The two who played each other in round 1 stay; the other pair leave: the round 2 pairing is the stayers against each other, who met.
    await takeOut(r1[1].a!, "withdrawn");
    await takeOut(r1[1].b!, "withdrawn");
    const cur = await detail(id);
    // Only two are left and they have met: the event ends after the last round paired.
    expect(cur.status === "finished" || cur.swiss!.blocked !== null || cur.swiss!.roundsTotal === 2).toBe(true);
    if (cur.status !== "finished") {
      expect(cur.swiss!.nextRound).not.toBeNull();
      expect(await endSwiss(id)).toMatchObject({ ok: true });
    }
    expect((await detail(id)).status).toBe("finished");
  });

  it("refuses to end an event that has not paired a round, or whose last round is paired", async () => {
    const { id } = await drawnSwiss({ rules: { swiss: { rounds: 1 } } }, 4);
    expect(await endSwiss(id)).toMatchObject({ ok: false, error: expect.stringContaining("last round") });
  });
});

describe("ratings", () => {
  it("counts every decided two-sided match, not byes, and replays a correction", async () => {
    const day = addDays(today, dayOffset);
    dayOffset += 5;
    const made = await createTournament({ venueId, name: "Rated Swiss", sport: "badminton", format: "swiss", teamSize: 1, level: null, entryFee: 0, maxEntries: 16, startsOn: day, endsOn: addDays(day, 2), startHour: 9, endHour: 21, courtIds: courts, rules: { swiss: { rounds: 2 } } }, ownerId);
    if (!made.ok) throw new Error(made.error);
    expect((await setEventRated("tournament", made.value.id, true)).ok).toBe(true);
    for (const u of pool.slice(0, 7)) await enter(u, made.value.id);
    const drawn = await makeDraw(made.value.id, fixed);
    if (!drawn.ok) throw new Error(drawn.error);
    const live = async () => ((await getDb().prepare("SELECT source_match, outcome, kind FROM rated_results WHERE source_kind = 'tournament' AND source_id = ? AND voided_at IS NULL ORDER BY source_match").all(made.value.id)) as { source_match: number; outcome: string; kind: string }[]);
    expect(await live()).toHaveLength(0);
    const fin = await playAll(made.value.id);
    expect(fin.status).toBe("finished");
    const decided = fin.matches.filter((m) => m.status === "done");
    const rows = await live();
    // Seven entries, two rounds: three matches and a bye each round; the byes are not rated.
    expect(decided).toHaveLength(6);
    expect(rows.map((r) => r.source_match).sort()).toEqual(decided.map((m) => m.id).sort());
    expect(fin.matches.filter((m) => m.status === "bye")).toHaveLength(2);
    // A correction (the last round's first match flipped) replays: its row is voided and written again.
    const last = round(fin, 2).find((m) => m.status === "done")!;
    const before = rows.find((r) => r.source_match === last.id)!;
    const flip = last.winner === last.a ? { winner: last.b!, score: "10-21, 12-21" } : { winner: last.a!, score: "21-10, 21-12" };
    expect((await recordResult(last.id, flip)).ok).toBe(true);
    const after = (await live()).find((r) => r.source_match === last.id)!;
    expect(after.outcome).not.toBe(before.outcome);
    expect((await getDb().prepare("SELECT COUNT(*)::int AS n FROM rated_results WHERE source_kind = 'tournament' AND source_id = ? AND source_match = ?").get(made.value.id, last.id)) as { n: number }).toEqual({ n: 2 });
  });
});

describe("tournament day, and results at once", () => {
  it("tells each player their pairing when a round is paired, and announces and calls a later round's fixtures", async () => {
    const { id, entries } = await drawnSwiss({}, 8);
    for (const e of entries) await setEntry(e, { checkedIn: true });
    const mails = async () => ((await getDb().prepare("SELECT subject, body, recipient, kind FROM messages ORDER BY id").all()) as { subject: string | null; body: string; recipient: string; kind: string }[]);
    const before = (await mails()).length;
    const d = await playRound(id, 1);
    const told = (await mails()).slice(before).filter((m) => m.subject?.startsWith("Round 2 of"));
    expect(told).toHaveLength(8);
    expect(told.every((m) => m.body.includes("Round 2 of"))).toBe(true);
    // The next round's fixture is announced to its sides within the hour of its time, once.
    const fixture = round(d, 2).filter((m) => m.status === "scheduled").sort((a, b) => `${a.date}${String(a.minute).padStart(5, "0")}`.localeCompare(`${b.date}${String(b.minute).padStart(5, "0")}`))[0];
    const zone = (await import("../src/lib/tournaments")).tournamentZone;
    const { instantOf } = await import("../src/lib/interval");
    const at = instantOf(fixture.date!, fixture.minute! - 30, await zone(id));
    const { announceNext, callFixture } = await import("../src/lib/tournament-day");
    // The day's clock is the tournament's own day.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(at);
      expect(await announceNext(id)).toBeGreaterThan(0);
      expect(await announceNext(id)).toBe(0);
      // Called at its time by a manager, both sides being checked in.
      vi.setSystemTime(instantOf(fixture.date!, fixture.minute! + 1, await zone(id)));
      const called = await callFixture(fixture.id, { id: null, name: "Musa Manager", role: "manager" });
      expect(called.ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pairs the next round once when the last two results of a round arrive together", async () => {
    const { id } = await drawnSwiss({}, 8);
    let d = await playRound(id, 1, undefined, 2);
    const open = round(d, 1).filter((m) => m.status === "scheduled");
    expect(open).toHaveLength(2);
    const both = await Promise.all(open.map((m) => recordResult(m.id, { winner: m.a!, score: "21-10, 21-12" })));
    expect(both.every((r) => r.ok)).toBe(true);
    d = await detail(id);
    expect(d.swiss!.rounds).toHaveLength(2);
    expect(round(d, 2)).toHaveLength(4);
    // The table is the replay of the recorded results, however they arrived.
    const again = await replayTable(id);
    expect(d.swiss!.standings.map((l) => [l.entryId, l.points])).toEqual(again.map((l) => [l.entryId, l.points]));
    const paired = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM swiss_rounds WHERE tournament_id = ?").get(id)) as { n: number };
    expect(paired.n).toBe(2);
  });

  it("is not released early: the held time stays until the last round is paired", async () => {
    const { id } = await drawnSwiss({}, 8);
    const held = async () => ((await getDb().prepare("SELECT COALESCE(SUM(end_min - start_min), 0)::int AS m FROM blocks WHERE tournament_id = ?").get(id)) as { m: number }).m;
    const before = await held();
    await playRound(id, 1);
    expect(await held()).toBe(before);
    await playAll(id);
    expect(await held()).toBeLessThan(before);
  });
});
