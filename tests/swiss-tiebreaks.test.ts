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
import { getDb } from "../src/lib/db";
import { listVenues } from "../src/lib/store";
import { previewTiebreaks, seededRandom, setTiebreaks, swissStandings, tiebreakRefusal, type SwissResult } from "../src/lib/swiss";
import { addDays, todayISO } from "../src/lib/time";
import { createTournament, enter, makeDraw, recordResult, tournamentDetail, type TournamentDetail, type TournamentInput } from "../src/lib/tournaments";
import { DEFAULT_SCORING, SWISS_TIEBREAKS, readRules, type SwissTiebreak } from "../src/lib/tournament-rules";
import * as adminTournament from "../src/app/api/admin/tournaments/[id]/route";

/**
 * The tie-break screen's server side (ADR 0038, docs/features/tournaments.md#the-tie-break-screen): every published tie-break computed
 * for every entry, what separated each pair level on points and by how much (or that only the seed did), and the order the tie-breaks
 * are applied in: chosen freely before the draw, locked from round 1's pairing and then changed only by a manager with a reason and the
 * preview's token, which changes the table and nothing else.
 */

const win = (a: number, b: number, w: number, score = "21-10, 21-12"): SwissResult => ({ a, b, winner: w, score, status: "done" });
const initial = (...ids: number[]) => new Map(ids.map((id, i) => [id, i + 1]));
const rulesFor = (tiebreaks: SwissTiebreak[], byePoints = 1) => ({ byePoints, tiebreaks });

describe("the tie-break columns, worked by hand", () => {
  // Five players. 1 beat 2 and 3; 2 beat 4; 3 beat 4 and 5; 4 beat 5. Points (a win is 1): 1:2, 2:1, 3:2, 4:1, 5:0.
  const results = [win(1, 2, 1), win(1, 3, 1), win(2, 4, 2), win(3, 4, 3), win(3, 5, 3), win(4, 5, 4)];
  const table = swissStandings([1, 2, 3, 4, 5], initial(1, 2, 3, 4, 5), results, DEFAULT_SCORING, rulesFor(["buchholz"]));
  const line = (id: number) => table.find((l) => l.entryId === id)!;

  it("works out Buchholz, Buchholz without the lowest opponent, and Sonneborn-Berger from the results", () => {
    // Points: 1:2, 2:1, 3:2 (beat 4, 5; lost to 1) -> 2, 4:1, 5:0. Opponents' points: 1:[2,3]->(1,2); 2:[1,4]->(2,1); 3:[1,4,5]->(2,1,0); 4:[2,3,5]->(1,2,0); 5:[3,4]->(2,1).
    expect(table.map((l) => [l.entryId, l.points])).toEqual([[1, 2], [3, 2], [2, 1], [4, 1], [5, 0]]);
    expect(line(1)).toMatchObject({ buchholz: 3, buchholzCut1: 2, sonnebornBerger: 3 });
    expect(line(2)).toMatchObject({ buchholz: 3, buchholzCut1: 2, sonnebornBerger: 1 });
    expect(line(3)).toMatchObject({ buchholz: 3, buchholzCut1: 3, sonnebornBerger: 1 });
    expect(line(4)).toMatchObject({ buchholz: 3, buchholzCut1: 3, sonnebornBerger: 0 });
    expect(line(5)).toMatchObject({ buchholz: 3, buchholzCut1: 2, sonnebornBerger: 0 });
  });

  it("separates 1 and 3 (level on points) by whichever tie-break comes first on which they differ, saying which and by how much", () => {
    const by = (keys: SwissTiebreak[]) => swissStandings([1, 2, 3, 4, 5], initial(1, 2, 3, 4, 5), results, DEFAULT_SCORING, rulesFor(keys));
    // Level on Buchholz (3 each): the next key splits them.
    expect(by(["buchholz", "sonneborn_berger"]).find((l) => l.entryId === 3)!.tie).toEqual({ above: 1, by: "sonneborn_berger", ahead: 3, behind: 1 });
    // Cut-1 puts 3 (3) ahead of 1 (2).
    const cut = by(["buchholz_cut1"]);
    expect(cut.slice(0, 2).map((l) => l.entryId)).toEqual([3, 1]);
    expect(cut[1].tie).toEqual({ above: 3, by: "buchholz_cut1", ahead: 3, behind: 2 });
    // Head to head: 1 beat 3.
    const h2h = by(["head_to_head"]);
    expect(h2h.slice(0, 2).map((l) => l.entryId)).toEqual([1, 3]);
    expect(h2h[1].tie).toEqual({ above: 1, by: "head_to_head", ahead: null, behind: null });
    // Nothing separates 2 and 4 on Buchholz: only the initial order does, and it says so.
    const seedOnly = by(["buchholz"]);
    expect(seedOnly.find((l) => l.entryId === 4)!.tie).toEqual({ above: 2, by: "seed", ahead: 2, behind: 4 });
    // The leader, and a line whose points differ from the one above, have no tie.
    expect(seedOnly[0].tie).toBeNull();
    expect(seedOnly.find((l) => l.entryId === 2)!.tie).toBeNull();
  });
});

describe("the tie notes, as properties of any table", () => {
  it("agrees with an independent working of the columns, and every note names the first key that separates and the seed only where none does", () => {
    const rand = seededRandom(1105);
    const pick = (k: number) => Math.floor(rand() * k);
    const keys: SwissTiebreak[] = ["buchholz", "buchholz_cut1", "sonneborn_berger", "median_buchholz", "wins", "set_diff", "point_diff", "points_for"];
    for (let trial = 0; trial < 120; trial++) {
      const size = 4 + pick(7);
      const ids = Array.from({ length: size }, (_, i) => i + 1);
      const results: SwissResult[] = [];
      const seen = new Set<string>();
      for (let k = 0; k < size * 2; k++) {
        const [a, b] = [1 + pick(size), 1 + pick(size)];
        if (a === b || seen.has(`${Math.min(a, b)}:${Math.max(a, b)}`)) continue;
        seen.add(`${Math.min(a, b)}:${Math.max(a, b)}`);
        const w = pick(2) === 0 ? a : b;
        results.push(win(a, b, w, `21-${pick(15)}, 21-${pick(15)}`));
      }
      const order = [...keys].sort(() => rand() - 0.5).slice(0, 1 + pick(keys.length));
      const table = swissStandings(ids, initial(...ids), results, DEFAULT_SCORING, rulesFor(order));
      const points = new Map(table.map((l) => [l.entryId, l.points]));
      // The independent working of the three columns this change adds, from the raw results.
      const theirs = (id: number) => results.filter((r) => r.a === id || r.b === id).map((r) => ({ other: r.a === id ? r.b! : r.a, won: r.winner === id }));
      for (const l of table) {
        const opp = theirs(l.entryId).map((o) => points.get(o.other)!);
        expect(l.buchholz).toBe(opp.reduce((s, p) => s + p, 0));
        expect(l.buchholzCut1).toBe([...opp].sort((x, y) => x - y).slice(1).reduce((s, p) => s + p, 0));
        expect(l.sonnebornBerger).toBe(theirs(l.entryId).filter((o) => o.won).reduce((s, o) => s + points.get(o.other)!, 0));
      }
      const value = (id: number, key: SwissTiebreak): number => {
        const l = table.find((x) => x.entryId === id)!;
        return key === "buchholz" ? l.buchholz : key === "buchholz_cut1" ? l.buchholzCut1! : key === "sonneborn_berger" ? l.sonnebornBerger! : key === "median_buchholz" ? l.medianBuchholz : key === "wins" ? l.won : key === "set_diff" ? l.setDiff : key === "point_diff" ? l.pointDiff : l.pointsFor;
      };
      table.forEach((l, i) => {
        const above = i > 0 ? table[i - 1] : null;
        if (!above || above.points !== l.points) return expect(l.tie).toBeNull();
        const tie = l.tie!;
        expect(tie.above).toBe(above.entryId);
        const first = order.find((k) => value(above.entryId, k) !== value(l.entryId, k));
        if (first === undefined) {
          expect(tie.by).toBe("seed");
          expect(tie.ahead).toBeLessThan(tie.behind!);
        } else {
          expect(tie.by).toBe(first);
          expect(tie.ahead).toBe(value(above.entryId, first));
          expect(tie.behind).toBe(value(l.entryId, first));
          // Every earlier key in the order was level, and the one above is the better on the key that separated them.
          for (const k of order.slice(0, order.indexOf(first))) expect(value(above.entryId, k)).toBe(value(l.entryId, k));
          expect(tie.ahead!).toBeGreaterThan(tie.behind!);
        }
      });
    }
  });
});

describe("the sequence is checked", () => {
  it("takes some of the published tie-breaks, each once, at least one", () => {
    expect(tiebreakRefusal(["buchholz", "wins"])).toBeNull();
    expect(tiebreakRefusal([...SWISS_TIEBREAKS])).toBeNull();
    for (const bad of [[], "buchholz", null, ["buchholz", "buchholz"], ["buchholz", "luck"], [1]]) expect(tiebreakRefusal(bad)).not.toBeNull();
  });
});

let ownerId: number;
let venueId: number;
let courts: number[];
let managerCookie: string;
let deskCookie: string;
let n = 0;
let dayOffset = 3;
const today = todayISO();
const pool: User[] = [];

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const venue = (await listVenues())[0];
  venueId = venue.id;
  courts = venue.courts.filter((c) => c.sport === "badminton").slice(0, 2).map((c) => c.id);
  const manager = await createAdmin({ name: "Musa Ties", email: "musa@ties.test", password: "manager-pass-1", venueId });
  const desk = await createAdmin({ name: "Dina Ties", email: "dina@ties.test", password: "desk-password-1", venueId, role: "desk" });
  if (!manager.ok || !desk.ok) throw new Error("staff");
  ownerId = manager.admin.id;
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(manager.admin.id)).token}`;
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
  for (let i = 0; i < 8; i++) {
    n++;
    const made = await registerUser({ name: `Tie Player${n}`, email: `tp${n}@ties.test`, phone: `01360${String(n).padStart(5, "0")}`, password: "a long enough password" });
    if (!made.ok) throw new Error(made.error);
    pool.push(made.user);
  }
});

async function event(over: Partial<TournamentInput> = {}, draw = true) {
  const day = addDays(today, dayOffset);
  dayOffset += 5;
  const made = await createTournament({ venueId, name: `Tie Cup ${dayOffset}`, sport: "badminton", format: "swiss", teamSize: 1, level: null, entryFee: 0, maxEntries: 32, startsOn: day, endsOn: addDays(day, 3), startHour: 9, endHour: 21, courtIds: courts, ...over }, ownerId);
  if (!made.ok) throw new Error(made.error);
  for (const u of pool) {
    const e = await enter(u, made.value.id);
    if (!e.ok) throw new Error(e.error);
  }
  if (draw) {
    const done = await makeDraw(made.value.id, () => 0.42);
    if (!done.ok) throw new Error(done.error);
  }
  return made.value.id;
}

const detail = async (id: number) => (await tournamentDetail(id, { forStaff: true }))!;
const round = (d: TournamentDetail, r: number) => d.matches.filter((m) => m.stage === "group" && m.round === r);
const rankOf = async (id: number) => new Map(((await getDb().prepare("SELECT id, swiss_rank FROM tournament_entries WHERE tournament_id = ?").all(id)) as { id: number; swiss_rank: number }[]).map((x) => [x.id, x.swiss_rank]));

/** Round 1 played so that the better seed wins, by a margin that grows with the winner's seed number: the point difference then runs against the seeds. */
async function playRoundOne(id: number) {
  const rank = await rankOf(id);
  for (const m of round(await detail(id), 1).filter((x) => x.status === "scheduled")) {
    const w = rank.get(m.a!)! < rank.get(m.b!)! ? m.a! : m.b!;
    const margin = rank.get(w)!;
    const score = w === m.a ? `21-${21 - 2 - margin}, 21-${21 - 2 - margin}` : `${21 - 2 - margin}-21, ${21 - 2 - margin}-21`;
    const res = await recordResult(m.id, { winner: w, score });
    if (!res.ok) throw new Error(res.error);
  }
  return detail(id);
}

const post = (cookie: string | undefined, id: number, body: Record<string, unknown>) =>
  adminTournament.POST(
    new NextRequest(`http://localhost/api/admin/tournaments/${id}`, { method: "POST", headers: cookie ? { cookie } : {}, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: String(id) }) }
  );

describe("before the draw", () => {
  it("is chosen freely, kept in the event's rules, and the draw uses it", async () => {
    const id = await event({}, false);
    const saved = await setTiebreaks(id, ["wins", "buchholz"]);
    expect(saved.ok).toBe(true);
    if (saved.ok) expect(saved.value.after).toEqual(["wins", "buchholz"]);
    const t = (await getDb().prepare("SELECT rules FROM tournaments WHERE id = ?").get(id)) as { rules: string };
    expect(readRules(t.rules).swiss!.tiebreaks).toEqual(["wins", "buchholz"]);
    expect(await setTiebreaks(id, [])).toMatchObject({ ok: false });
    expect(await setTiebreaks(id, ["buchholz", "buchholz"])).toMatchObject({ ok: false });
    // The preview before the draw has nothing to compare and is not locked.
    const preview = await previewTiebreaks(id, ["buchholz"]);
    expect(preview).toMatchObject({ ok: true, value: { locked: false, current: ["wins", "buchholz"], moved: [] } });
    const drawn = await makeDraw(id, () => 0.42);
    if (!drawn.ok) throw new Error(drawn.error);
    expect(drawn.value.swiss!.tiebreaks).toEqual(["wins", "buchholz"]);
  });
});

describe("after round 1 is paired: locked", () => {
  it("refuses a change without a reason and the preview's token, then makes it as previewed: the table changes, the pairings and the event do not", async () => {
    const id = await event();
    const before = await playRoundOne(id);
    const current = before.swiss!.tiebreaks;
    // Locked: a plain save is refused, and says why.
    expect(await setTiebreaks(id, ["head_to_head"])).toMatchObject({ ok: false, code: "TIEBREAKS_LOCKED" });
    expect(await setTiebreaks(id, ["head_to_head"], { token: "x", reason: "no" })).toMatchObject({ ok: false, code: "TIEBREAKS_LOCKED" });
    expect((await detail(id)).swiss!.tiebreaks).toEqual(current);
    // The winners are level on points and on Buchholz; the point difference puts the largest margin first: the worst seed of them.
    const winners = before.swiss!.standings.filter((l) => l.points === 1);
    expect(winners.map((l) => l.tie?.by)).toEqual([undefined, ...Array(winners.length - 1).fill(winners[1].tie!.by)].map((x) => x));
    expect(winners.slice(1).every((l) => !!l.tie && l.tie.by !== "seed")).toBe(true);
    const seeds = await rankOf(id);
    const bySeed = [...winners].sort((a, b) => seeds.get(a.entryId)! - seeds.get(b.entryId)!).map((l) => l.entryId);
    expect(winners.map((l) => l.entryId)).not.toEqual(bySeed);
    // Head to head alone cannot separate them (none met): the seed does, and the preview says who only the seed orders.
    const p = await previewTiebreaks(id, ["head_to_head"]);
    if (!p.ok) throw new Error(p.error);
    expect(p.value.locked).toBe(true);
    expect(p.value.moved.length).toBeGreaterThan(0);
    expect(p.value.after.filter((r) => r.rank > 0 && r.tie?.by === "seed").length).toBeGreaterThan(0);
    expect(p.value.bySeed.length).toBeGreaterThan(0);
    expect(p.value.after.slice(0, winners.length).map((r) => r.entryId)).toEqual(bySeed);
    // Looking changed nothing.
    expect((await detail(id)).swiss!.tiebreaks).toEqual(current);
    const roundsBefore = round(await detail(id), 2).map((m) => [m.id, m.a, m.b]);
    // A stale token, a reason too short, and the sequence it already has are refused.
    expect(await setTiebreaks(id, ["head_to_head"], { token: "stale", reason: "Club rule" })).toMatchObject({ ok: false, code: "CHANGED" });
    expect(await setTiebreaks(id, ["head_to_head"], { token: p.value.token, reason: "no" })).toMatchObject({ ok: false, code: "TIEBREAKS_LOCKED" });
    const same = await previewTiebreaks(id, current);
    if (!same.ok) throw new Error(same.error);
    expect(await setTiebreaks(id, current, { token: same.value.token, reason: "Same again" })).toMatchObject({ ok: false, error: expect.stringContaining("already") });
    // Made as previewed.
    const done = await setTiebreaks(id, ["head_to_head"], { token: p.value.token, reason: "The club ranks by who beat whom" });
    expect(done.ok).toBe(true);
    const after = await detail(id);
    expect(after.swiss!.tiebreaks).toEqual(["head_to_head"]);
    expect(after.swiss!.standings.map((l) => l.entryId)).toEqual(p.value.after.map((r) => r.entryId));
    expect(readRules((await getDb().prepare("SELECT rules FROM tournaments WHERE id = ?").get(id) as { rules: string }).rules).swiss!.tiebreaks).toEqual(["head_to_head"]);
    // The pairings, the rounds and the event are as they were: a round is paired on points and the initial order, never on a tie-break.
    expect(round(after, 2).map((m) => [m.id, m.a, m.b])).toEqual(roundsBefore);
    expect(after.status).toBe("drawn");
    // And the table is the pure function of the results and this order.
    const results: SwissResult[] = after.matches.filter((m) => m.status !== "scheduled" && !(m.status === "bye" && m.b !== null)).map((m) => ({ a: m.a!, b: m.b, winner: m.winner, score: m.score, status: m.status as SwissResult["status"] }));
    const replay = swissStandings([...seeds.keys()], seeds, results, after.rules.scoring, { byePoints: after.swiss!.byePoints, tiebreaks: ["head_to_head"] });
    expect(after.swiss!.standings.map((l) => [l.entryId, l.rank])).toEqual(replay.map((l) => [l.entryId, l.rank]));
  });

  it("refuses to apply a preview once the event has moved on, and changes nothing", async () => {
    const id = await event();
    const before = await playRoundOne(id);
    const p = await previewTiebreaks(id, ["points_for", "wins"]);
    if (!p.ok) throw new Error(p.error);
    // A result arrives after the preview was looked at.
    const next = round(before, 2).find((m) => m.status === "scheduled")!;
    expect((await recordResult(next.id, { winner: next.a!, score: "21-10, 21-12" })).ok).toBe(true);
    expect(await setTiebreaks(id, ["points_for", "wins"], { token: p.value.token, reason: "Club rule" })).toMatchObject({ ok: false, code: "CHANGED" });
    expect((await detail(id)).swiss!.tiebreaks).toEqual(before.swiss!.tiebreaks);
  });
});

describe("through the staff route", () => {
  it("is a manager's: the desk is refused; a preview is answered; a locked change needs its reason and token; and the change is in the activity log with its reason", async () => {
    const id = await event();
    await playRoundOne(id);
    expect((await post(undefined, id, { action: "swiss_tiebreaks", tiebreaks: ["wins"], preview: true })).status).toBe(401);
    const refused = await post(deskCookie, id, { action: "swiss_tiebreaks", tiebreaks: ["wins"], preview: true });
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("MANAGER_ONLY");
    expect((await post(managerCookie, id, { action: "swiss_tiebreaks", tiebreaks: ["luck"], preview: true })).status).toBe(409);
    const looked = await post(managerCookie, id, { action: "swiss_tiebreaks", tiebreaks: ["points_for"], preview: true });
    expect(looked.status).toBe(200);
    const preview = (await looked.json()).preview as { token: string; locked: boolean; moved: unknown[] };
    expect(preview.locked).toBe(true);
    const locked = await post(managerCookie, id, { action: "swiss_tiebreaks", tiebreaks: ["points_for"] });
    expect(locked.status).toBe(409);
    expect((await locked.json()).code).toBe("TIEBREAKS_LOCKED");
    expect((await getDb().prepare("SELECT COUNT(*)::int AS n FROM staff_actions WHERE action = 'tournament.swiss_tiebreaks'").get() as { n: number }).n).toBe(0);
    const saved = await post(managerCookie, id, { action: "swiss_tiebreaks", tiebreaks: ["points_for"], token: preview.token, reason: "Club rule: points scored" });
    expect(saved.status).toBe(200);
    expect(((await saved.json()).tournament as TournamentDetail).swiss!.tiebreaks).toEqual(["points_for"]);
    const logged = (await getDb().prepare("SELECT action, detail FROM staff_actions WHERE action = 'tournament.swiss_tiebreaks'").all()) as { action: string; detail: string }[];
    expect(logged).toHaveLength(1);
    expect(logged[0].detail).toContain("points_for");
    expect(logged[0].detail).toContain("Club rule: points scored");
    expect(logged[0].detail).toContain("buchholz");
    // Nothing is due to pair while round 1 is not decided, and a preview of it says so.
    const undecided = await event();
    const none = await post(managerCookie, undecided, { action: "swiss_preview" });
    expect(none.status).toBe(409);
    expect((await none.json()).code).toBe("NOT_READY");
    // A head-to-head event has no performance rounds to group.
    expect((await post(managerCookie, undecided, { action: "swiss_regroup", round: 2, preview: true })).status).toBe(409);
  });
});
