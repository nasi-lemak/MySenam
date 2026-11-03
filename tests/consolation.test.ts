import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { bracketSize, consolationDraw, firstRound } from "../src/lib/brackets";
import { getDb } from "../src/lib/db";
import { listVenues } from "../src/lib/store";
import {
  applyCorrection,
  makeDraw,
  previewResult,
  previewTakeOut,
  recordResult,
  resolveIssue,
  reviewIssue,
  takeOut,
  tournamentDetail,
  type Match,
  type TournamentDetail,
} from "../src/lib/tournaments";
import { at, chalk, fixed, kit, matchAt, shape, violations, type Env } from "./helpers/knockout-formats";

/**
 * A knockout with a consolation draw for first-round losers (ADR 0032, C, P, R, L, F): the draw as stored, progression through
 * whole events, leavers in either draw, corrections with their two routes, placings, ratings.
 */

let env: Env;
let k: ReturnType<typeof kit>;
let owner: { id: number; name: string };
const CONS = { format: "knockout" as const, rules: { bracket: { consolation: true } } };
const WITH_THIRD = { format: "knockout" as const, thirdPlace: true, rules: { bracket: { consolation: true, consolationThirdPlace: true } } };

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const admin = (await listAdmins())[0];
  owner = { id: admin.id, name: admin.name };
  const venue = (await listVenues())[0];
  env = { venueId: venue.id, ownerId: admin.id, courts: venue.courts.filter((c) => c.sport === "badminton").map((c) => c.id) };
  k = kit(env, "co");
});

describe("setting one up (S1 S2)", () => {
  it("S1: a consolation draw is a rule of a straight knockout, off unless chosen, with its third-place match its own choice", async () => {
    const plain = await k.tournament({ format: "knockout" });
    expect(plain.rules.bracket).toEqual({ consolation: false, consolationThirdPlace: false, grandFinalReset: true });
    const t = await k.tournament(WITH_THIRD);
    expect(t.rules.bracket).toMatchObject({ consolation: true, consolationThirdPlace: true });
    expect(t.format).toBe("knockout");
  });

  it("C2: with fewer than six entries, or a main draw of four, the draw is made without a consolation draw", async () => {
    for (const n of [2, 3, 4, 5]) {
      const { t } = await k.drawn(CONS, n);
      expect(t.matches.filter((m) => m.bracket === "consolation"), `${n} entries`).toHaveLength(0);
      expect(violations(t)).toEqual([]);
    }
  });
});

describe("the draw (C, T)", () => {
  for (const n of [6, 7, 8, 11, 12, 16]) {
    it(`C1 C3 C5: ${n} entries: the consolation draw is the pure structure's, M-1 matches, the main draw's first-round matches played feed it`, async () => {
      const { t } = await k.drawn(WITH_THIRD, n, n > 11 ? 2 : 1);
      const size = bracketSize(n);
      const pairs = firstRound(t.drawOrder!);
      const plan = consolationDraw(size, pairs, true)!;
      const cons = t.matches.filter((m) => m.bracket === "consolation");
      expect(cons.length).toBe(plan.matches.length);
      const playedFirst = t.matches.filter((m) => m.bracket === "main" && m.round === 1 && m.status !== "bye");
      expect(cons.filter((m) => m.placement === null)).toHaveLength(playedFirst.length - 1);
      // Every first-round match played sends its loser into the consolation draw; byes send nobody.
      for (const m of t.matches.filter((x) => x.bracket === "main" && x.round === 1)) {
        if (m.status === "bye") expect(m.loserNext).toBeNull();
        else expect(t.matches.find((x) => x.id === m.loserNext)!.bracket).toBe("consolation");
      }
      // The main draw has n-1 matches played, and its own third-place match beside the consolation draw's.
      expect(t.matches.filter((m) => m.bracket === "main" && m.status !== "bye" && m.placement === null)).toHaveLength(n - 1);
      expect(t.matches.filter((m) => m.placement === 3).map((m) => m.bracket).sort()).toEqual(plan.matches.some((m) => m.placement === 3) ? ["consolation", "main"] : ["main"]);
      expect(violations(t)).toEqual([]);
    });
  }

  it("S4 T1: a consolation match has the length of its stage, and starts after the main-draw matches that feed it", async () => {
    const { t } = await k.drawn({ ...CONS, stageMinutes: { consolation: 20, final: 45 } }, 12, 2);
    for (const m of t.matches.filter((x) => x.bracket === "consolation")) {
      expect(m.minutes).toBe(20);
      expect(m.courtId).not.toBeNull();
      for (const f of t.matches.filter((x) => x.loserNext === m.id || x.next === m.id).filter((x) => x.status !== "bye"))
        expect(`${m.date} ${String(m.minute).padStart(4, "0")}` >= `${f.date} ${String(f.minute! + f.minutes).padStart(4, "0")}`).toBe(true);
    }
    expect(t.matches.find((m) => m.bracket === "main" && m.round === 4 && m.placement === null)!.minutes).toBe(45);
  });
});

describe("progression through a whole event (P, F)", () => {
  const outcomes: [string, (m: Match) => number][] = [
    ["the entry entered first wins", chalk],
    ["the entry entered last wins", (m) => Math.max(m.a!, m.b!)],
    ["the first side wins", (m) => m.a!],
    ["alternately", (m) => ((m.id + m.round) % 2 === 0 ? m.a! : m.b!)],
  ];
  for (const n of [6, 8, 11, 12]) {
    for (const [name, rule] of outcomes) {
      it(`${n} entries, ${name}: G3 after every result, C6 first-round losers play on only in the consolation draw, F2 placings are complete`, async () => {
        const { t } = await k.drawn(WITH_THIRD, n, n > 11 ? 2 : 1);
        let d = (await tournamentDetail(t.id, { forStaff: true }))!;
        const lost = new Set<number>();
        const trace: string[] = [];
        for (let step = 0; step < 100; step++) {
          const next = d.matches.find((m) => m.status === "scheduled" && m.a !== null && m.b !== null);
          if (!next) break;
          const winner = rule(next);
          await k.result(next, winner);
          if (next.bracket === "main" && next.round === 1) lost.add(winner === next.a ? next.b! : next.a!);
          // C6: a first-round loser is never in a main-draw match again.
          d = (await tournamentDetail(t.id, { forStaff: true }))!;
          trace.push(at(next));
          expect(violations(d), `after ${trace.join(", ")}`).toEqual([]);
          for (const m of d.matches.filter((x) => x.bracket === "main" && x.round > 1)) {
            expect(lost.has(m.a ?? -1), `${at(m)} a`).toBe(false);
            expect(lost.has(m.b ?? -1), `${at(m)} b`).toBe(false);
          }
        }
        expect(d.status).toBe("finished");
        const places = d.placings!;
        expect(places.map((p) => p.entryId).sort((x, y) => x - y)).toEqual(d.entries.map((e) => e.id).sort((x, y) => x - y));
        // The main draw's final decides first and second; those who lost in the first round are all below those who won it or had a bye.
        const final = d.matches.filter((m) => m.bracket === "main" && m.placement === null).sort((x, y) => y.round - x.round)[0];
        expect(places[0]).toEqual({ entryId: final.winner, place: 1 });
        const mainEntrants = new Set(d.matches.filter((m) => m.bracket === "main" && m.round > 1).flatMap((m) => [m.a!, m.b!]));
        const worstMain = Math.max(...places.filter((p) => mainEntrants.has(p.entryId)).map((p) => p.place));
        for (const p of places.filter((x) => lost.has(x.entryId))) expect(p.place).toBeGreaterThan(worstMain);
        // The consolation draw's champion is the best of those who lost first.
        const consFinal = d.matches.filter((m) => m.bracket === "consolation" && m.placement === null).sort((x, y) => y.round - x.round)[0];
        expect(places.find((p) => p.entryId === consFinal.winner)!.place).toBe(mainEntrants.size + 1);
        expect(worstMain).toBeLessThanOrEqual(mainEntrants.size);
      });
    }
  }
});

describe("somebody leaving (L)", () => {
  it("L1 P2: a leaver before the first round is a walkover to the opponent, and sits in the consolation draw out of the event: the opponent there has a walkover", async () => {
    const { t, ids } = await k.drawn(CONS, 8);
    const first = matchAt(t, "main:1:2");
    const leaver = first.a!;
    const preview = await previewTakeOut(leaver, "withdrawn");
    if (!preview.ok) throw new Error(preview.error);
    const done = await takeOut(leaver, "disqualified", "rules", { token: (await previewTakeOut(leaver, "disqualified")).ok ? ((await previewTakeOut(leaver, "disqualified")) as { value: { token: string } }).value.token : "" });
    if (!done.ok) throw new Error(done.error);
    const d = (await tournamentDetail(t.id, { forStaff: true }))!;
    expect(matchAt(d, "main:1:2")).toMatchObject({ status: "walkover", winner: first.b });
    expect(violations(d)).toEqual([]);
    expect(d.entries.find((e) => e.id === leaver)!.out).toMatchObject({ reason: "disqualified", stage: "knockout" });
    // In the consolation draw they wait for the other side; then lose there.
    const slot = d.matches.find((m) => m.id === first.loserNext)!;
    expect([slot.a, slot.b]).toContain(leaver);
    const end = await k.play(t.id, chalk);
    expect(end.d.status).toBe("finished");
    expect(violations(end.d)).toEqual([]);
    expect(end.d.matches.filter((m) => m.status === "walkover" && m.bracket === "consolation").length).toBeGreaterThanOrEqual(1);
    expect(end.d.placings!.map((p) => p.entryId).sort((x, y) => x - y)).toEqual([...ids].sort((x, y) => x - y));
  });

  for (const reason of ["withdrawn", "retired", "disqualified"] as const) {
    it(`L1: ${reason}, in each draw and at each stage of an eleven-entry event: G3 holds, results played stand, it finishes`, async () => {
      for (const stopAfter of [0, 1, 2]) {
        const { t, ids } = await k.drawn(WITH_THIRD, 11);
        if (stopAfter > 0) await k.play(t.id, chalk, (m) => m.round > stopAfter);
        const before = (await tournamentDetail(t.id, { forStaff: true }))!;
        const eligible = ids.filter((e) => !before.entries.find((x) => x.id === e)!.out);
        const leaver = eligible[(stopAfter * 3 + reason.length) % eligible.length];
        const preview = await previewTakeOut(leaver, reason);
        if (!preview.ok) throw new Error(preview.error);
        const done = await takeOut(leaver, reason, "left", { token: preview.value.token });
        if (!done.ok) throw new Error(done.error);
        expect(done.value.changes).toEqual(preview.value.changes);
        expect(violations((await tournamentDetail(t.id, { forStaff: true }))!)).toEqual([]);
        const playedBefore = before.matches.filter((m) => m.status === "done").map((m) => `${m.id}:${m.winner}`);
        const end = await k.play(t.id, chalk);
        expect(end.d.status).toBe("finished");
        expect(violations(end.d)).toEqual([]);
        const after = end.d.matches.filter((m) => m.status === "done").map((m) => `${m.id}:${m.winner}`);
        for (const p of playedBefore) expect(after).toContain(p);
      }
    });
  }
});

const flipped = (m: Match) => (m.winner === m.a ? m.b! : m.a!);
const resultOf = (m: Match, winner: number) => ({ winner, score: k.score(m, winner) });

describe("corrections (R)", () => {
  /** An eight-entry event (four first-round matches, a consolation draw of four lines), `chalk` playing, until `stop`. */
  async function eight(stop: (m: Match) => boolean = () => false) {
    const { t, ids } = await k.drawn(CONS, 8);
    const { d } = await k.play(t.id, chalk, stop);
    return { t, ids, d };
  }

  it("R1: a first-round result put right while nothing it feeds is played moves both competitors: the winner into the main draw, the loser into the consolation draw", async () => {
    const { t, d } = await eight((m) => !(m.bracket === "main" && m.round === 1));
    const m = matchAt(d, "main:1:1");
    const [win, lose] = [m.winner!, flipped(m)];
    const preview = await previewResult(m.id, resultOf(m, lose));
    if (!preview.ok) throw new Error(preview.error);
    expect(preview.value.needsCorrection).toBe(false);
    expect(preview.value.changes.join(" ")).toMatch(/Consolation/);
    const done = await recordResult(m.id, resultOf(m, lose));
    if (!done.ok) throw new Error(done.error);
    const main2 = done.value.matches.find((x) => x.id === m.next)!;
    const cons = done.value.matches.find((x) => x.id === m.loserNext)!;
    expect([main2.a, main2.b]).toContain(lose);
    expect([main2.a, main2.b]).not.toContain(win);
    expect([cons.a, cons.b]).toContain(win);
    expect([cons.a, cons.b]).not.toContain(lose);
    expect(violations(done.value)).toEqual([]);
    expect(t.id).toBe(done.value.id);
  });

  it("R2: refused as a plain result once the main-draw match or the consolation match it fed is played", async () => {
    // The consolation match (first round) played alone.
    const first = await eight((m) => m.bracket === "main" && m.round > 1);
    const m = matchAt(first.d, "main:1:1");
    expect(matchAt(first.d, "consolation:1:1").status).toBe("done");
    expect(await recordResult(m.id, resultOf(m, flipped(m)))).toMatchObject({ ok: false, code: "KNOCKOUT_STARTED" });
    // The main-draw match played, the consolation draw not.
    const second = await eight((x) => x.bracket !== "main" || x.round > 2);
    const m2 = matchAt(second.d, "main:1:1");
    expect(matchAt(second.d, "consolation:1:1").status).toBe("scheduled");
    expect(await recordResult(m2.id, resultOf(m2, flipped(m2)))).toMatchObject({ ok: false, code: "KNOCKOUT_STARTED" });
  });

  async function wrongBothWays() {
    const { t, d } = await eight((m) => m.bracket === "main" && m.round >= 3);
    const m = matchAt(d, "main:1:1");
    const swap = resultOf(m, flipped(m));
    const preview = await previewResult(m.id, swap);
    if (!preview.ok) throw new Error(preview.error);
    const done = await applyCorrection(m.id, swap, { mode: "standings_only", reason: "Names swapped on the sheet", token: preview.value.token }, owner);
    if (!done.ok) throw new Error(done.error);
    return { t, before: d, m, preview: preview.value, done: done.value };
  }

  it("R3: a record-only correction opens an issue for the main draw's route and one for the consolation draw's, and the tournament does not finish", async () => {
    const { m, preview, done } = await wrongBothWays();
    expect(preview.replace).toMatchObject({ possible: false });
    expect(preview.issuesIfStandingsOnly!.length).toBeGreaterThanOrEqual(1);
    expect(done.changes).toEqual([...preview.standingsOnly.changes, ...preview.issuesIfStandingsOnly!]);
    const issues = done.detail.issues;
    expect(issues).toHaveLength(2);
    const winnersRoute = issues.find((i) => i.wrongEntry === m.winner)!;
    const consolationRoute = issues.find((i) => i.wrongEntry !== m.winner)!;
    expect(winnersRoute).toMatchObject({ rightEntry: consolationRoute.wrongEntry });
    expect(consolationRoute).toMatchObject({ rightEntry: winnersRoute.wrongEntry });
    expect(done.detail.matches.find((x) => x.id === consolationRoute.fromMatchId)!.bracket).toBe("consolation");
    expect(done.detail.status).toBe("drawn");
    expect(violations(done.detail, { openIssues: true })).toEqual([]);
  });

  it("R6: replaying one replays both: the winner of the first-round match in the main draw, the loser in the consolation draw, then it plays to a finish consistently", async () => {
    const { t, done, m } = await wrongBothWays();
    const issue = done.detail.issues[0];
    const review = await reviewIssue(issue.id);
    if (!review.ok || !review.value.replay.possible) throw new Error("not reviewable");
    expect(review.value.together).toBe(done.detail.issues[1].id);
    const before = (await tournamentDetail(t.id, { forStaff: true }))!;
    const slots = Object.fromEntries(
      review.value.replay.matches.map((x) => {
        const y = before.matches.find((z) => z.id === x.matchId)!;
        return [String(x.matchId), { courtId: y.courtId!, date: y.date!, startMin: y.minute! }];
      })
    );
    const replay = await resolveIssue(issue.id, { action: "replay", reason: "Both draws replayed from the corrected result", token: review.value.token, slots }, owner);
    if (!replay.ok) throw new Error(replay.error);
    expect(replay.value.detail.issues.map((i) => i.status)).toEqual(["replayed", "replayed"]);
    expect(violations(replay.value.detail)).toEqual([]);
    // The same results again where a match is replayed, so nothing downstream needs a correction of its own.
    const rule = (x: Match) => {
      const was = before.matches.find((y) => y.id === x.id)!;
      const loser = was.winner === null ? null : was.winner === was.a ? was.b : was.a;
      if (loser !== null && (x.a === loser || x.b === loser)) return x.a === loser ? x.b! : x.a!;
      if (was.winner !== null && (x.a === was.winner || x.b === was.winner)) return was.winner;
      return chalk(x);
    };
    const end = await k.play(t.id, rule);
    expect(end.d.status).toBe("finished");
    expect(violations(end.d)).toEqual([]);
    expect(end.d.placings).toHaveLength(8);
    expect(matchAt(end.d, "main:1:1").winner).toBe(flipped(m));
  });

  it("the third-place match keeps its own rule: a semi-final corrected after the final is played opens an issue for each route and replaying either is refused as before", async () => {
    const { t } = await k.drawn(WITH_THIRD, 8);
    const { d } = await k.play(t.id, chalk);
    expect(d.status).toBe("finished");
    const semi = matchAt(d, "main:2:1");
    const swap = resultOf(semi, flipped(semi));
    const preview = await previewResult(semi.id, swap);
    if (!preview.ok) throw new Error(preview.error);
    const done = await applyCorrection(semi.id, swap, { mode: "standings_only", reason: "Semi-final sheet was swapped", token: preview.value.token }, owner);
    if (!done.ok) throw new Error(done.error);
    expect(done.value.detail.issues.length).toBeGreaterThanOrEqual(1);
    for (const issue of done.value.detail.issues) {
      const review = await reviewIssue(issue.id);
      if (!review.ok) throw new Error(review.error);
      expect(review.value.together).toBeNull();
    }
  });

  describe("a corrected event is the event played from scratch with the corrected result (replay-from-scratch equality)", () => {
    it("plain corrections at every depth, in the main and the consolation draw: the corrected state is the scratch state", async () => {
      const probe = await k.drawn(CONS, 8);
      const places = probe.t.matches.filter((m) => m.status !== "bye").map(at);
      expect(places.length).toBe(10);
      for (const place of places) {
        const a = await k.drawn(CONS, 8);
        const target = matchAt(a.t, place);
        const descendants = (d: TournamentDetail, id: number) => {
          const seen = new Set<number>();
          const queue = [id];
          while (queue.length) {
            const x = queue.pop()!;
            const m = d.matches.find((y) => y.id === x)!;
            for (const to of [m.next, m.loserNext]) if (to !== null && !seen.has(to)) {
                seen.add(to);
                queue.push(to);
              }
          }
          return seen;
        };
        const waiting = descendants(a.t, target.id);
        await k.play(a.t.id, chalk, (m) => waiting.has(m.id));
        let d = (await tournamentDetail(a.t.id, { forStaff: true }))!;
        let t1 = matchAt(d, place);
        if (t1.status === "scheduled" && t1.a !== null && t1.b !== null) {
          await k.result(t1, chalk(t1));
          d = (await tournamentDetail(a.t.id, { forStaff: true }))!;
          t1 = matchAt(d, place);
        }
        expect(t1.status, place).toBe("done");
        const other = flipped(t1);
        const corrected = await recordResult(t1.id, resultOf(t1, other));
        if (!corrected.ok) throw new Error(`${place}: ${corrected.error}`);
        expect(violations(corrected.value), `${place} corrected`).toEqual([]);
        const endA = await k.play(a.t.id, chalk);
        const b = await k.drawn(CONS, 8);
        const endB = await k.play(b.t.id, (m) => (at(m) === place ? (chalk(m) === m.a ? m.b! : m.a!) : chalk(m)));
        expect(shape(endA.d, a.ids), place).toEqual(shape(endB.d, b.ids));
        expect(endA.d.status).toBe("finished");
        expect(violations(endA.d)).toEqual([]);
      }
    }, 240_000);
  });
});

describe("ratings and tournament day (K1, T2)", () => {
  it("K1: every decided match between two entrants is one ledger row, the consolation draw's included; a bye is none; a correction replaces the row", async () => {
    const { setEventRated } = await import("../src/lib/ratings");
    const t = await k.tournament(CONS);
    expect(await setEventRated("tournament", t.id, true)).toMatchObject({ ok: true });
    await k.field(t.id, 7);
    const made = await makeDraw(t.id, fixed);
    if (!made.ok) throw new Error(made.error);
    const rows = async () => ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM rated_results WHERE source_kind = 'tournament' AND source_id = ? AND voided_at IS NULL").get(t.id)) as { n: number }).n;
    expect(await rows()).toBe(0);
    const { d } = await k.play(t.id, chalk);
    expect(d.status).toBe("finished");
    // Seven entries: main draw 6 matches played, consolation draw 2: eight matches, the one bye none.
    expect(d.matches.filter((m) => m.status === "done")).toHaveLength(8);
    expect(d.matches.filter((m) => m.bracket === "consolation" && m.status === "done")).toHaveLength(2);
    expect(await rows()).toBe(8);
    const c = matchAt(d, "consolation:1:1");
    const swap = resultOf(c, flipped(c));
    const preview = await previewResult(c.id, swap);
    if (!preview.ok) throw new Error(preview.error);
    const done = await applyCorrection(c.id, swap, { mode: "standings_only", reason: "Consolation sheet corrected", token: preview.value.token }, owner);
    if (!done.ok) throw new Error(done.error);
    expect(await rows()).toBe(8);
    const row = (await getDb().prepare("SELECT outcome FROM rated_results WHERE source_kind = 'tournament' AND source_id = ? AND source_match = ? AND voided_at IS NULL").get(t.id, c.id)) as { outcome: string };
    expect(Number(row.outcome)).toBe(swap.winner === c.a ? 1 : 0);
  });

  it("T2: the live page names a consolation match by its bracket", async () => {
    const day = await import("../src/lib/tournament-day");
    const { t } = await k.drawn(CONS, 8);
    const first = matchAt((await tournamentDetail(t.id))!, "main:1:1");
    await k.result(first, chalk(first));
    const board = await day.liveBoard(t.id);
    expect(board!.recent[0]).toMatchObject({ bracket: "main", round: 1 });
    const { d } = await k.play(t.id, chalk);
    const after = await day.liveBoard(t.id);
    expect(after!.recent.some((r) => r.bracket === "consolation")).toBe(true);
    expect(d.status).toBe("finished");
  });

  it("T2: a match is named by its draw, in English and the staff language", async () => {
    const { matchNamePhrase } = await import("../src/lib/tournaments");
    const { staffTranslator } = await import("../src/lib/staff-i18n");
    const { t } = await k.drawn(WITH_THIRD, 16, 2);
    const say = (place: string, lang: "en" | "ms" | "zh") => staffTranslator(lang, "MySenam").say(matchNamePhrase(t, matchAt(t, place)));
    expect(say("consolation:1:1", "en")).toBe("Consolation round 1, match 1");
    expect(say("consolation:3:1", "en")).toBe("Consolation final");
    expect(say("consolation:3:2", "en")).toBe("Consolation third-place match");
    expect(say("consolation:3:1", "ms")).toBe("Akhir saguhati");
    expect(say("consolation:3:1", "zh")).toBe("安慰赛决赛");
    expect(say("main:4:1", "en")).toBe("Final");
  });
});

describe("one change at a time (T3)", () => {
  it("T3: two first-round results at once, each feeding the same consolation match, both go in", async () => {
    const { t } = await k.drawn(CONS, 8);
    const d = (await tournamentDetail(t.id, { forStaff: true }))!;
    const feeders = d.matches.filter((m) => m.bracket === "main" && m.round === 1 && m.loserNext === matchAt(d, "consolation:1:1").id);
    expect(feeders).toHaveLength(2);
    const both = await Promise.all(feeders.map((m) => recordResult(m.id, { winner: m.a!, score: k.score(m, m.a!) })));
    expect(both.map((r) => r.ok)).toEqual([true, true]);
    const after = (await tournamentDetail(t.id, { forStaff: true }))!;
    const cons = matchAt(after, "consolation:1:1");
    expect([cons.a, cons.b].sort()).toEqual(feeders.map((m) => m.b!).sort());
    expect(violations(after)).toEqual([]);
  });
});
