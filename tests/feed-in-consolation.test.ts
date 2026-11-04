import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { bracketSize, feedInConsequences, feedInConsolation, firstRound } from "../src/lib/brackets";
import { saveVenueTemplate, venueTemplates } from "../src/lib/competition-templates";
import { getDb } from "../src/lib/db";
import { listVenues } from "../src/lib/store";
import {
  applyCorrection,
  feedInPreview,
  makeDraw,
  moveMatch,
  previewResult,
  previewTakeOut,
  recordResult,
  resolveIssue,
  reviewIssue,
  setRules,
  takeOut,
  tournamentById,
  tournamentDetail,
  type Match,
  type TournamentDetail,
} from "../src/lib/tournaments";
import { at, chalk, fixed, kit, matchAt, shape, violations, type Env } from "./helpers/knockout-formats";

/**
 * A knockout with an advanced feed-in consolation draw (ADR 0034): every loser of the main draw but the runner-up plays on. The format
 * as set up and confirmed, the draw as stored, progression through whole events, leavers in either draw, corrections with their two
 * routes, places, ratings, tournament day, court time. Each test names the rule it proves.
 */

let env: Env;
let k: ReturnType<typeof kit>;
let owner: { id: number; name: string };
const FEED = { format: "knockout" as const, confirmFeedIn: true, rules: { bracket: { consolation: true, consolationMode: "feed_in" } } };
const FEED_THIRD = { format: "knockout" as const, confirmFeedIn: true, rules: { bracket: { consolation: true, consolationThirdPlace: true, consolationMode: "feed_in" } } };
const FIRST_ROUND = { format: "knockout" as const, rules: { bracket: { consolation: true } } };

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const admin = (await listAdmins())[0];
  owner = { id: admin.id, name: admin.name };
  const venue = (await listVenues())[0];
  env = { venueId: venue.id, ownerId: admin.id, courts: venue.courts.filter((c) => c.sport === "badminton").map((c) => c.id) };
  k = kit(env, "fi");
});

const daysFor = (n: number) => (n > 24 ? 4 : n > 16 ? 3 : n > 9 ? 2 : 1);
const flipped = (m: Match) => (m.winner === m.a ? m.b! : m.a!);
const resultOf = (m: Match, winner: number) => ({ winner, score: k.score(m, winner) });
const staff = async (id: number) => (await tournamentDetail(id, { forStaff: true }))!;

describe("setting one up, and confirming what it costs (S, M)", () => {
  it("S1: it is a mode of a consolation draw on a straight knockout, off unless chosen; what was stored before reads as it did, and the first round is still the meaning of `consolation: true`", async () => {
    const plain = await k.tournament({ format: "knockout" });
    expect(plain.rules.bracket).toEqual({ consolation: false, consolationThirdPlace: false, grandFinalReset: true });
    const first = await k.tournament(FIRST_ROUND);
    expect(first.rules.bracket).toEqual({ consolation: true, consolationThirdPlace: false, grandFinalReset: true });
    const named = await k.tournament({ ...FIRST_ROUND, rules: { bracket: { consolation: true, consolationMode: "first_round" } } });
    expect(named.rules.bracket).toEqual({ consolation: true, consolationThirdPlace: false, grandFinalReset: true });
    const feed = await k.tournament(FEED);
    expect(feed.rules.bracket).toEqual({ consolation: true, consolationThirdPlace: false, grandFinalReset: true, consolationMode: "feed_in" });
    expect(feed.format).toBe("knockout");
    expect((await k.tournament(FEED_THIRD)).rules.bracket).toMatchObject({ consolationThirdPlace: true, consolationMode: "feed_in" });
  });

  it("S2 M5: it is refused until the organiser has confirmed it, and the refusal says what it adds: the matches, the court hours, for how many entries", async () => {
    const { confirmFeedIn: _confirmed, ...unconfirmed } = FEED;
    void _confirmed;
    const refused = await createRefusal(unconfirmed);
    const c = feedInConsequences(40, false, { knockout: 30, final: 30, consolation: 30 })!;
    expect(refused).toMatchObject({ code: "FEED_IN_CONFIRM", vars: { entries: 40, addedMatches: c.consolationMatches, totalMatches: c.totalMatches, rounds: c.rounds, mostMatches: c.mostMatches } });
    expect(refused.error).toBe(`A feed-in consolation draw adds ${c.consolationMatches} matches (${c.totalMatches} in all for 40 entries) and about ${c.consolationMinutes / 60} court hours. Confirm the format to go on.`);
    expect(refused.ok).toBe(false);
  });

  /** A tournament that is refused: its answer. */
  async function createRefusal(over: Record<string, unknown>) {
    const { createTournament } = await import("../src/lib/tournaments");
    const { addDays, todayISO } = await import("../src/lib/time");
    const day = addDays(todayISO(), 400);
    const made = await createTournament(
      { venueId: env.venueId, name: "fi Refused Cup", sport: "badminton", format: "knockout", teamSize: 1, level: null, entryFee: 0, maxEntries: 40, startsOn: day, endsOn: day, startHour: 9, endHour: 21, matchMinutes: 30, courtIds: env.courts, ...over } as never,
      env.ownerId
    );
    if (made.ok) throw new Error("it was made");
    return made;
  }

  it("S2: refused for a double elimination or groups, with a third-place match of the knockout, with an unknown mode, and as a mode of no consolation draw", async () => {
    expect((await createRefusal({ ...FEED, format: "double_elimination" })).error).toMatch(/straight knockout/);
    expect((await createRefusal({ ...FEED, format: "groups" })).error).toMatch(/straight knockout/);
    expect((await createRefusal({ ...FEED, thirdPlace: true })).error).toMatch(/third-place match/);
    expect((await createRefusal({ ...FEED, rules: { bracket: { consolation: true, consolationMode: "swiss" } } })).error).toMatch(/first round|first_round/);
    expect((await createRefusal({ ...FEED, rules: { bracket: { consolationMode: "feed_in" } } })).error).toMatch(/needs a consolation draw/);
    expect((await createRefusal({ ...FEED, rules: { bracket: { consolation: true, consolationMode: 3 } } })).error).toMatch(/first round|first_round/);
  });

  it("S3: chosen later (before the draw) it needs the confirmation too; changing something else while it is on does not; going back to the first round takes it away; after the draw the rules stand", async () => {
    const t = await k.tournament({ format: "knockout" });
    const first = await setRules(t.id, { bracket: { consolation: true, consolationMode: "feed_in" } });
    expect(first).toMatchObject({ ok: false, code: "FEED_IN_CONFIRM" });
    expect((await tournamentById(t.id))!.rules.bracket.consolationMode).toBeUndefined();
    expect(await setRules(t.id, { bracket: { consolation: true, consolationMode: "feed_in" } }, { confirmFeedIn: true })).toMatchObject({ ok: true });
    expect((await tournamentById(t.id))!.rules.bracket).toMatchObject({ consolation: true, consolationMode: "feed_in" });
    // Another rule changed while it is on: no new confirmation.
    expect(await setRules(t.id, { scoring: { bestOf: 5 } })).toMatchObject({ ok: true });
    expect((await tournamentById(t.id))!.rules.bracket.consolationMode).toBe("feed_in");
    // Its third-place match changes how many matches it adds: confirmed again.
    expect(await setRules(t.id, { bracket: { consolationThirdPlace: true } })).toMatchObject({ ok: false, code: "FEED_IN_CONFIRM" });
    expect(await setRules(t.id, { bracket: { consolationThirdPlace: true } }, { confirmFeedIn: true })).toMatchObject({ ok: true });
    // Back to the first round: stored as it always was.
    expect(await setRules(t.id, { bracket: { consolationMode: "first_round" } })).toMatchObject({ ok: true });
    expect((await tournamentById(t.id))!.rules.bracket).toEqual({ consolation: true, consolationThirdPlace: true, grandFinalReset: true });
    // Switching the consolation draw off takes the mode with it.
    await setRules(t.id, { bracket: { consolationMode: "feed_in" } }, { confirmFeedIn: true });
    expect(await setRules(t.id, { bracket: { consolation: false } })).toMatchObject({ ok: true });
    expect((await tournamentById(t.id))!.rules.bracket).toEqual({ consolation: false, consolationThirdPlace: false, grandFinalReset: true });
    // A knockout with a third-place match of its own cannot take it.
    const withThird = await k.tournament({ format: "knockout", thirdPlace: true });
    expect(await setRules(withThird.id, { bracket: { consolation: true, consolationMode: "feed_in" } }, { confirmFeedIn: true })).toMatchObject({ ok: false });
    // The draw made, the rules stand.
    const drawn = await k.drawn(FEED, 6);
    expect(await setRules(drawn.t.id, { bracket: { consolation: false } })).toMatchObject({ ok: false });
  });

  it("M5: the preview for a tournament: what it adds for the entries it has, or the most it takes while fewer than five have entered; and for another number", async () => {
    const t = await k.tournament({ ...FEED, maxEntries: 16 });
    const empty = feedInPreview(t, false);
    expect(empty).toMatchObject({ entries: 16, fitsHeld: true });
    expect(empty.consequences).toMatchObject({ mainMatches: 15, consolationMatches: 13, totalMatches: 28, mainRounds: 4, rounds: 6, mostMatches: 6 });
    await k.field(t.id, 6);
    const six = feedInPreview((await tournamentById(t.id))!, false);
    expect(six.entries).toBe(6);
    expect(six.consequences).toMatchObject({ mainMatches: 5, consolationMatches: 3, totalMatches: 8 });
    expect(feedInPreview((await tournamentById(t.id))!, true, 8).consequences).toMatchObject({ consolationMatches: 6, totalMatches: 13 });
    expect(feedInPreview((await tournamentById(t.id))!, false, 4).consequences).toBeNull();
  });

  it("S4: a venue's own template keeps the mode", async () => {
    const t = await k.tournament(FEED_THIRD);
    const saved = await saveVenueTemplate(t.id, "Club feed-in knockout", env.ownerId);
    if (!saved.ok) throw new Error(saved.error);
    expect((await venueTemplates(env.venueId)).find((x) => x.name === "Club feed-in knockout")!.rules.bracket).toMatchObject({ consolation: true, consolationThirdPlace: true, consolationMode: "feed_in" });
  });
});

describe("the draw (G, D, T)", () => {
  for (const n of [5, 6, 7, 8, 9, 11, 12, 16, 17]) {
    it(`G1 C1 M1: ${n} entries: the draw is the pure structure's; main n-1 matches, consolation n-3; every main loser but the runner-up has a route into it`, async () => {
      const { t } = await k.drawn(FEED, n, daysFor(n));
      const size = bracketSize(n);
      const plan = feedInConsolation(size, firstRound(t.drawOrder!), false)!;
      const cons = t.matches.filter((m) => m.bracket === "consolation");
      expect(cons.length).toBe(plan.matches.length);
      expect(cons.length).toBe(n - 3);
      expect(t.matches.filter((m) => m.bracket === "main" && m.status !== "bye")).toHaveLength(n - 1);
      expect(t.matches.filter((m) => m.placement === 3)).toHaveLength(0);
      const rounds = Math.max(...t.matches.filter((m) => m.bracket === "main").map((m) => m.round));
      for (const m of t.matches.filter((x) => x.bracket === "main")) {
        if (m.status === "bye" || m.round === rounds) expect(m.loserNext, at(m)).toBeNull();
        else expect(t.matches.find((x) => x.id === m.loserNext)!.bracket, at(m)).toBe("consolation");
      }
      // Counted as the preview says, and the consolation matches are exactly the plan's by place.
      expect(cons.map(at).sort()).toEqual(plan.matches.map((m) => `consolation:${m.round}:${m.position}`).sort());
      const c = feedInConsequences(n, false, { knockout: 30, final: 30, consolation: 30 })!;
      expect(t.matches.filter((m) => m.status !== "bye")).toHaveLength(c.totalMatches);
      expect(violations(t)).toEqual([]);
    });
  }

  it("S2 C4: with the consolation third-place match, the last drop round's two losers play it where both are matches played; the main draw has none", async () => {
    const { t } = await k.drawn(FEED_THIRD, 12, 2);
    const third = t.matches.filter((m) => m.placement === 3);
    expect(third.map((m) => m.bracket)).toEqual(["consolation"]);
    expect(at(third[0])).toBe("consolation:5:2");
    const final = matchAt(t, "consolation:5:1");
    const semis = t.matches.filter((m) => m.next === final.id);
    expect(semis).toHaveLength(2);
    expect(semis.map((m) => m.loserNext)).toEqual([third[0].id, third[0].id]);
    // Five entries: the consolation semi-finals are not both matches, so there is none.
    const small = await k.drawn(FEED_THIRD, 5);
    expect(small.t.matches.filter((m) => m.placement === 3)).toHaveLength(0);
  });

  it("S4 T1: a consolation match has the length of its stage and starts after every match that feeds it, on either route; the main draw's final has its own", async () => {
    const { t } = await k.drawn({ ...FEED, stageMinutes: { consolation: 20, final: 45 } }, 12, 2);
    for (const m of t.matches.filter((x) => x.bracket === "consolation")) {
      expect(m.minutes).toBe(20);
      expect(m.courtId).not.toBeNull();
      for (const f of t.matches.filter((x) => x.loserNext === m.id || x.next === m.id).filter((x) => x.status !== "bye"))
        expect(`${m.date} ${String(m.minute).padStart(4, "0")}` >= `${f.date} ${String(f.minute! + f.minutes).padStart(4, "0")}`, `${at(m)} after ${at(f)}`).toBe(true);
    }
    expect(t.matches.find((m) => m.bracket === "main" && m.round === 4 && m.placement === null)!.minutes).toBe(45);
    // No two matches on one court at once.
    const slots = new Set<string>();
    for (const m of t.matches.filter((x) => x.courtId !== null)) {
      for (let at_ = m.minute!; at_ < m.minute! + m.minutes; at_ += 5) {
        const key = `${m.courtId}|${m.date}|${at_}`;
        expect(slots.has(key), `${at(m)} overlaps on court ${m.courtId}`).toBe(false);
        slots.add(key);
      }
    }
  });

  it("T1 D1: the same chance gives the same draw; and the first-round consolation draw is unchanged beside it (same field, same main draw)", async () => {
    const a = await k.drawn(FEED, 9, 2);
    const b = await k.drawn(FEED, 9, 2);
    expect(shape(a.t, a.ids)).toEqual(shape(b.t, b.ids));
    const first = await k.drawn(FIRST_ROUND, 9, 2);
    expect(shape(first.t, first.ids).filter((x) => x.startsWith("main:"))).toEqual(shape(a.t, a.ids).filter((x) => x.startsWith("main:")));
    expect(a.t.matches.filter((m) => m.bracket === "consolation").length).toBeGreaterThan(first.t.matches.filter((m) => m.bracket === "consolation").length);
  });

  it("T1: where the court time held cannot hold every match the draw is refused with an explanation and nothing is changed (a plain knockout of the same field fits)", async () => {
    const hours = { courtIds: [env.courts[0]], startHour: 9, endHour: 13 };
    const plain = await k.tournament({ format: "knockout", ...hours });
    await k.field(plain.id, 8);
    expect((await makeDraw(plain.id, fixed)).ok).toBe(true);
    const t = await k.tournament({ ...FEED, ...hours });
    await k.field(t.id, 8);
    const refused = await makeDraw(t.id, fixed);
    expect(refused).toMatchObject({ ok: false });
    expect(refused.ok ? "" : refused.error).toMatch(/Not enough court time: \d+ of 12 matches do not fit/);
    const after = await staff(t.id);
    expect(after.status).not.toBe("drawn");
    expect(after.matches).toHaveLength(0);
    expect((await getDb().prepare("SELECT draw_order FROM tournaments WHERE id = ?").get(t.id)) as { draw_order: string | null }).toEqual({ draw_order: null });
    // The preview said so beforehand: more is needed than is held.
    expect(feedInPreview((await tournamentById(t.id))!, false)).toMatchObject({ fitsHeld: false });
    // More days make room, and the same field is then drawn.
    const roomy = await k.drawn(FEED, 8, 1);
    expect(roomy.t.status).toBe("drawn");
  });
});

describe("progression through a whole event (P, F)", () => {
  const outcomes: [string, (m: Match) => number][] = [
    ["the entry entered first wins", chalk],
    ["the entry entered last wins", (m) => Math.max(m.a!, m.b!)],
    ["the first side wins", (m) => m.a!],
    ["alternately", (m) => ((m.id + m.round) % 2 === 0 ? m.a! : m.b!)],
  ];
  for (const n of [5, 6, 7, 8, 9, 12]) {
    for (const [name, rule] of outcomes) {
      it(`${n} entries, ${name}: G3 after every result, every loser but the runner-up plays on only in the consolation draw, the places are complete`, async () => {
        const third = n % 2 === 0;
        const { t } = await k.drawn(third ? FEED_THIRD : FEED, n, daysFor(n));
        let d = await staff(t.id);
        const lost = new Set<number>();
        const trace: string[] = [];
        const finalRound = Math.max(...d.matches.filter((m) => m.bracket === "main").map((m) => m.round));
        for (let step = 0; step < 100; step++) {
          const next = d.matches.find((m) => m.status === "scheduled" && m.a !== null && m.b !== null);
          if (!next) break;
          const winner = rule(next);
          await k.result(next, winner);
          if (next.bracket === "main" && next.round < finalRound) lost.add(winner === next.a ? next.b! : next.a!);
          d = await staff(t.id);
          trace.push(at(next));
          expect(violations(d), `after ${trace.join(", ")}`).toEqual([]);
          // C6: somebody who lost a main-draw match is never in a main-draw match again.
          for (const m of d.matches.filter((x) => x.bracket === "main" && x.status === "scheduled")) {
            expect(lost.has(m.a ?? -1), `${at(m)} a`).toBe(false);
            expect(lost.has(m.b ?? -1), `${at(m)} b`).toBe(false);
          }
        }
        expect(d.status).toBe("finished");
        const consolationEntrants = new Set(d.matches.filter((m) => m.bracket === "consolation").flatMap((m) => [m.a, m.b]));
        for (const e of lost) expect(consolationEntrants.has(e), `entrant ${e} lost in the main draw and never played on`).toBe(true);
        // Everybody has a place; the main final decides first and second; the consolation final third and fourth.
        const places = d.placings!;
        expect(places.map((p) => p.entryId).sort((x, y) => x - y)).toEqual(d.entries.map((e) => e.id).sort((x, y) => x - y));
        const mainFinal = d.matches.find((m) => m.bracket === "main" && m.round === finalRound)!;
        expect(places[0]).toEqual({ entryId: mainFinal.winner, place: 1 });
        expect(places[1]).toEqual({ entryId: flipped(mainFinal), place: 2 });
        const consFinal = d.matches.filter((m) => m.bracket === "consolation" && m.placement === null).sort((x, y) => y.round - x.round)[0];
        expect(places.find((p) => p.entryId === consFinal.winner)!.place).toBe(3);
        expect(places.find((p) => p.entryId === flipped(consFinal))!.place).toBe(4);
        // A match played for each match counted: 2n-4, and the third-place match where there is one.
        expect(d.matches.filter((m) => m.status === "done")).toHaveLength(d.matches.filter((m) => m.status !== "bye").length);
        const bound = feedInConsequences(n, third, { knockout: 30, final: 30, consolation: 30 })!;
        expect(d.matches.filter((m) => m.status === "done")).toHaveLength(bound.totalMatches);
        const counts = new Map<number, number>();
        for (const m of d.matches.filter((x) => x.status === "done")) for (const e of [m.a!, m.b!]) counts.set(e, (counts.get(e) ?? 0) + 1);
        expect(Math.max(...counts.values())).toBeLessThanOrEqual(bound.mostMatches);
      });
    }
  }

  it("P1: the result of a main-draw match puts its winner on the winner's route and its loser on the loser's, in one change (both sides of the drop-round match)", async () => {
    const { t } = await k.drawn(FEED, 8);
    const d = await staff(t.id);
    const one = matchAt(d, "main:1:1");
    const done = await recordResult(one.id, resultOf(one, one.a!));
    if (!done.ok) throw new Error(done.error);
    const into = done.value.matches.find((m) => m.id === one.loserNext)!;
    expect(into.bracket).toBe("consolation");
    expect([into.a, into.b]).toContain(one.b);
    const up = done.value.matches.find((m) => m.id === one.next)!;
    expect([up.a, up.b]).toContain(one.a);
  });
});

describe("somebody leaving (L)", () => {
  async function leave(entryId: number, reason: "withdrawn" | "retired" | "disqualified") {
    const preview = await previewTakeOut(entryId, reason);
    if (!preview.ok) throw new Error(preview.error);
    const done = await takeOut(entryId, reason, "left", { token: preview.value.token });
    if (!done.ok) throw new Error(done.error);
    expect(done.value.changes).toEqual(preview.value.changes);
    return done.value;
  }

  it("L1 P2: a leaver before the first round is a walkover to the opponent, and sits in the consolation draw out of the event: the opponent there has a walkover", async () => {
    const { t, ids } = await k.drawn(FEED, 8);
    const first = matchAt(t, "main:1:2");
    const leaver = first.a!;
    await leave(leaver, "disqualified");
    const d = await staff(t.id);
    expect(matchAt(d, "main:1:2")).toMatchObject({ status: "walkover", winner: first.b });
    expect(violations(d)).toEqual([]);
    expect(d.entries.find((e) => e.id === leaver)!.out).toMatchObject({ reason: "disqualified", stage: "knockout" });
    // The walkover's loser is the leaver: in the consolation draw they wait for the other side, then lose there.
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
      for (const stopAfter of [0, 1, 2, 3]) {
        const { t, ids } = await k.drawn(FEED_THIRD, 11, 2);
        if (stopAfter > 0) await k.play(t.id, chalk, (m) => (m.bracket === "main" ? m.round > stopAfter : m.round > stopAfter + 1));
        const before = await staff(t.id);
        const eligible = ids.filter((e) => !before.entries.find((x) => x.id === e)!.out);
        const leaver = eligible[(stopAfter * 3 + reason.length) % eligible.length];
        await leave(leaver, reason);
        expect(violations(await staff(t.id))).toEqual([]);
        const playedBefore = before.matches.filter((m) => m.status === "done").map((m) => `${m.id}:${m.winner}`);
        const end = await k.play(t.id, chalk);
        expect(end.d.status).toBe("finished");
        expect(violations(end.d)).toEqual([]);
        const after = end.d.matches.filter((m) => m.status === "done").map((m) => `${m.id}:${m.winner}`);
        for (const p of playedBefore) expect(after).toContain(p);
        expect(end.d.placings!.map((p) => p.entryId).sort((x, y) => x - y)).toEqual([...ids].sort((x, y) => x - y));
      }
    });
  }

  it("L1: a leaver in the consolation draw (somebody who has dropped in) is out of the event; the opponent has the walkover and plays on", async () => {
    const { t } = await k.drawn(FEED, 8);
    const { d } = await k.play(t.id, chalk, (m) => (m.bracket === "consolation" ? m.round > 1 : m.round > 2));
    // Main rounds 1 and 2 are played: the drop round's matches are waiting with both sides in.
    const drop = d.matches.find((m) => m.bracket === "consolation" && m.round === 2 && m.status === "scheduled" && m.a !== null && m.b !== null)!;
    const first = d.matches.filter((m) => m.bracket === "consolation" && m.round === 1).every((m) => m.status === "done");
    expect(first).toBe(true);
    await leave(drop.a!, "withdrawn");
    const after = await staff(t.id);
    expect(after.matches.find((m) => m.id === drop.id)).toMatchObject({ status: "walkover", winner: drop.b });
    expect(violations(after)).toEqual([]);
    const end = await k.play(t.id, chalk);
    expect(end.d.status).toBe("finished");
    expect(violations(end.d)).toEqual([]);
  });

  it("L3: a leaver after the draw can be taken out only as confirmed against the preview, and the preview names what changes", async () => {
    const { t } = await k.drawn(FEED, 8);
    const first = matchAt(t, "main:1:1");
    const preview = await previewTakeOut(first.a!, "withdrawn");
    if (!preview.ok) throw new Error(preview.error);
    expect(preview.value.changes.join(" ")).toMatch(/walkover/i);
    expect(await takeOut(first.a!, "withdrawn", "left", { token: "stale" })).toMatchObject({ ok: false, code: "CHANGED" });
  });
});

describe("corrections after play has begun (R)", () => {
  /** An eight-entry event (four first-round matches, a consolation draw of five), `chalk` playing, until `stop`. */
  async function eight(stop: (m: Match) => boolean = () => false) {
    const { t, ids } = await k.drawn(FEED, 8);
    const { d } = await k.play(t.id, chalk, stop);
    return { t, ids, d };
  }

  it("R1: a first-round result put right while nothing it feeds is played moves both competitors: the winner into the main draw, the loser into the consolation draw", async () => {
    const { d } = await eight((m) => !(m.bracket === "main" && m.round === 1));
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
  });

  it("R1: a semi-final's result put right while nothing it feeds is played moves its loser into the consolation draw's last drop round, and the final's side", async () => {
    const { d } = await eight((m) => m.bracket === "consolation" || m.round >= 3);
    const semi = matchAt(d, "main:2:1");
    const [win, lose] = [semi.winner!, flipped(semi)];
    const done = await recordResult(semi.id, resultOf(semi, lose));
    if (!done.ok) throw new Error(done.error);
    const final = done.value.matches.find((x) => x.id === semi.next)!;
    const drop = done.value.matches.find((x) => x.id === semi.loserNext)!;
    expect(drop.bracket).toBe("consolation");
    expect([final.a, final.b]).toContain(lose);
    expect([drop.a, drop.b]).toContain(win);
    expect([drop.a, drop.b]).not.toContain(lose);
    expect(violations(done.value)).toEqual([]);
  });

  it("R2: refused as a plain result once the main-draw match or the consolation match it fed is played", async () => {
    const first = await eight((m) => m.bracket === "main" && m.round > 1);
    const m = matchAt(first.d, "main:1:1");
    expect(matchAt(first.d, "consolation:1:1").status).toBe("done");
    expect(await recordResult(m.id, resultOf(m, flipped(m)))).toMatchObject({ ok: false, code: "KNOCKOUT_STARTED" });
    const second = await eight((x) => x.bracket !== "main" || x.round > 2);
    const m2 = matchAt(second.d, "main:1:1");
    expect(matchAt(second.d, "consolation:1:1").status).toBe("scheduled");
    expect(await recordResult(m2.id, resultOf(m2, flipped(m2)))).toMatchObject({ ok: false, code: "KNOCKOUT_STARTED" });
    // A semi-final whose drop-round match is played.
    const third = await eight((x) => x.bracket === "main" && x.round === 3);
    const semi = matchAt(third.d, "main:2:2");
    expect(await recordResult(semi.id, resultOf(semi, flipped(semi)))).toMatchObject({ ok: false, code: "KNOCKOUT_STARTED" });
  });

  async function wrongBothWays(place = "main:1:1", stop: (m: Match) => boolean = (m) => m.bracket === "main" && m.round >= 3) {
    const { t, d } = await eight(stop);
    const m = matchAt(d, place);
    const swap = resultOf(m, flipped(m));
    const preview = await previewResult(m.id, swap);
    if (!preview.ok) throw new Error(preview.error);
    const done = await applyCorrection(m.id, swap, { mode: "standings_only", reason: "Names swapped on the sheet", token: preview.value.token }, owner);
    if (!done.ok) throw new Error(done.error);
    return { t, before: d, m, preview: preview.value, done: done.value };
  }

  it("R3: a record-only correction opens an issue for the main draw's route and one for the consolation draw's, each listing what the wrong competitor played, and the tournament does not finish", async () => {
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
    expect(done.detail.matches.find((x) => x.id === winnersRoute.fromMatchId)!.bracket).toBe("main");
    // The chain follows the wrong loser on in the consolation draw through every match they played.
    expect(consolationRoute.affected.length).toBeGreaterThanOrEqual(2);
    expect(done.detail.status).toBe("drawn");
    expect(violations(done.detail, { openIssues: true })).toEqual([]);
  });

  it("R3 R5: a manager lets both stand, with a reason, and the tournament then finishes as played", async () => {
    const { t, done } = await wrongBothWays();
    for (const issue of done.detail.issues) {
      const review = await reviewIssue(issue.id);
      if (!review.ok) throw new Error(review.error);
      const stood = await resolveIssue(issue.id, { action: "stand", reason: "The results stand as played", token: review.value.token }, owner);
      if (!stood.ok) throw new Error(stood.error);
    }
    const end = await k.play(t.id, chalk);
    expect(end.d.status).toBe("finished");
    expect(end.d.issues.map((i) => i.status)).toEqual(["stood", "stood"]);
    expect(end.d.placings).toHaveLength(8);
  });

  it("R6: replaying one replays both: the winner of the first-round match in the main draw, the loser in the consolation draw, then it plays to a finish consistently", async () => {
    const { t, done, m } = await wrongBothWays();
    const issue = done.detail.issues[0];
    const review = await reviewIssue(issue.id);
    if (!review.ok || !review.value.replay.possible) throw new Error("not reviewable");
    expect(review.value.together).toBe(done.detail.issues[1].id);
    const before = await staff(t.id);
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

  it("R6: a semi-final corrected after the final and the consolation were played: both routes replayed together (the final, and the drop round on to the consolation final)", async () => {
    const { t, done, m } = await wrongBothWays("main:2:1", () => false);
    expect(done.detail.issues).toHaveLength(2);
    const issue = done.detail.issues[0];
    const review = await reviewIssue(issue.id);
    if (!review.ok) throw new Error(review.error);
    expect(review.value.together).toBe(done.detail.issues[1].id);
    if (!review.value.replay.possible) throw new Error(review.value.replay.blockers.join("; "));
    const before = await staff(t.id);
    const slots = Object.fromEntries(
      review.value.replay.matches.map((x) => {
        const y = before.matches.find((z) => z.id === x.matchId)!;
        return [String(x.matchId), { courtId: y.courtId!, date: y.date!, startMin: y.minute! }];
      })
    );
    const replay = await resolveIssue(issue.id, { action: "replay", reason: "Replayed from the corrected semi-final", token: review.value.token, slots }, owner);
    if (!replay.ok) throw new Error(replay.error);
    // What was played stands (ADR 0032, R6): the opponent who beat the wrong competitor in the drop round is still in the consolation final
    // they won their way to, while their drop-round match is played again. Nobody is in two matches still to play.
    expect(violations(replay.value.detail, { openIssues: true })).toEqual([]);
    const end = await k.play(t.id, (x) => {
      // A replayed match is played again: whoever is already in the played match it fed goes on again, so nothing needs a correction of its own;
      // the competitor who now won the semi-final goes on from it as the corrected result says.
      const fed = before.matches.find((y) => y.id === x.next);
      const held = fed && x.nextSlot ? fed[x.nextSlot] : null;
      if (fed && fed.status === "done" && held !== null && (x.a === held || x.b === held)) return held;
      const was = before.matches.find((y) => y.id === x.id)!;
      return was.winner !== null && (x.a === was.winner || x.b === was.winner) ? was.winner : chalk(x);
    });
    expect(end.d.status).toBe("finished");
    expect(violations(end.d)).toEqual([]);
    expect(matchAt(end.d, "main:2:1").winner).toBe(flipped(m));
    expect(end.d.placings).toHaveLength(8);
  });

  describe("a corrected event is the event played from scratch with the corrected result (replay-from-scratch equality)", () => {
    const descendants = (d: TournamentDetail, id: number) => {
      const seen = new Set<number>();
      const queue = [id];
      while (queue.length) {
        const x = queue.pop()!;
        const m = d.matches.find((y) => y.id === x)!;
        for (const to of [m.next, m.loserNext])
          if (to !== null && !seen.has(to)) {
            seen.add(to);
            queue.push(to);
          }
      }
      return seen;
    };

    async function checkEvery(n: number, every = 1) {
      const over = n % 2 === 0 ? FEED_THIRD : FEED;
      const probe = await k.drawn(over, n, daysFor(n));
      const places = probe.t.matches.filter((m) => m.status !== "bye").map(at);
      for (const [i, place] of places.entries()) {
        if (i % every !== 0) continue;
        const a = await k.drawn(over, n, daysFor(n));
        const target = matchAt(a.t, place);
        const waiting = descendants(a.t, target.id);
        await k.play(a.t.id, chalk, (m) => waiting.has(m.id));
        let d = await staff(a.t.id);
        let t1 = matchAt(d, place);
        if (t1.status === "scheduled" && t1.a !== null && t1.b !== null) {
          await k.result(t1, chalk(t1));
          d = await staff(a.t.id);
          t1 = matchAt(d, place);
        }
        expect(t1.status, place).toBe("done");
        const other = flipped(t1);
        const corrected = await recordResult(t1.id, resultOf(t1, other));
        if (!corrected.ok) throw new Error(`${place}: ${corrected.error}`);
        expect(violations(corrected.value), `${place} corrected`).toEqual([]);
        const endA = await k.play(a.t.id, chalk);
        const b = await k.drawn(over, n, daysFor(n));
        const endB = await k.play(b.t.id, (m) => (at(m) === place ? (chalk(m) === m.a ? m.b! : m.a!) : chalk(m)));
        expect(shape(endA.d, a.ids), `n=${n} ${place}`).toEqual(shape(endB.d, b.ids));
        expect(endA.d.status).toBe("finished");
        expect(violations(endA.d)).toEqual([]);
      }
    }

    it("plain corrections at every depth, in the main and the consolation draw: eight entries (twelve matches, every one of them)", async () => {
      await checkEvery(8);
    }, 300_000);

    it("six entries with a byes-and-compression shape (every match), and eleven (every third)", async () => {
      await checkEvery(6);
      await checkEvery(11, 3);
    }, 300_000);
  });
});

describe("what the rest of the app does with these matches (T2, K)", () => {
  it("T2: a match is named by its draw, in English and the staff language: the consolation draw's rounds, final and third-place match", async () => {
    const { matchNamePhrase } = await import("../src/lib/tournaments");
    const { staffTranslator } = await import("../src/lib/staff-i18n");
    const { t } = await k.drawn(FEED_THIRD, 16, 2);
    const say = (place: string, lang: "en" | "ms" | "zh") => staffTranslator(lang, "MySenam").say(matchNamePhrase(t, matchAt(t, place)));
    expect(say("consolation:1:1", "en")).toBe("Consolation round 1, match 1");
    expect(say("consolation:2:3", "en")).toBe("Consolation round 2, match 3");
    expect(say("consolation:5:1", "en")).toBe("Consolation final");
    expect(say("consolation:5:2", "en")).toBe("Consolation third-place match");
    expect(say("consolation:5:1", "ms")).toBe("Akhir saguhati");
    expect(say("consolation:5:1", "zh")).toBe("安慰赛决赛");
    expect(say("main:4:1", "en")).toBe("Final");
    expect(say("main:3:2", "en")).toBe("Semi-final 2");
  });

  it("T2: tournament day works on these fixtures: the board lists them, the live page carries them named by their bracket", async () => {
    const day = await import("../src/lib/tournament-day");
    const { setEntry } = await import("../src/lib/tournaments");
    const { t, ids } = await k.drawn(FEED, 8);
    for (const id of ids) await setEntry(id, { checkedIn: true });
    expect(await day.dayBoard(t.id)).not.toBeNull();
    const first = matchAt((await tournamentDetail(t.id))!, "main:1:1");
    await k.result(first, chalk(first));
    expect((await day.liveBoard(t.id))!.recent[0]).toMatchObject({ bracket: "main", round: 1 });
    const { d } = await k.play(t.id, chalk);
    expect((await day.liveBoard(t.id))!.recent.some((r) => r.bracket === "consolation")).toBe(true);
    expect(d.status).toBe("finished");
  });

  it("T2: the next-match notice names a consolation fixture by its bracket, and a manager calls it to its court", async () => {
    const day = await import("../src/lib/tournament-day");
    const { instantOf } = await import("../src/lib/interval");
    const { tournamentZone, setEntry } = await import("../src/lib/tournaments");
    const { vi } = await import("vitest");
    const { t, ids } = await k.drawn(FEED, 8);
    for (const id of ids) await setEntry(id, { checkedIn: true });
    const first = await staff(t.id);
    for (const place of ["main:1:1", "main:1:2", "main:1:3", "main:1:4"]) await k.result(matchAt(first, place), chalk(matchAt(first, place)));
    const l1 = matchAt(await staff(t.id), "consolation:1:1");
    expect(l1.status).toBe("scheduled");
    const zone = await tournamentZone(t.id);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(instantOf(t.startsOn, l1.minute! - 10, zone));
      const before = ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages WHERE kind = 'tournament_day'").get()) as { n: number }).n;
      expect(await day.announceNext(t.id)).toBeGreaterThan(0);
      const told = (await getDb().prepare("SELECT body FROM messages WHERE kind = 'tournament_day' ORDER BY id").all()) as { body: string }[];
      expect(told.slice(before).some((m) => m.body.includes("Consolation round 1")), JSON.stringify(told.slice(before))).toBe(true);
      const called = await day.callFixture(l1.id, { id: null, name: "Musa Manager", role: "manager" });
      expect(called.ok, called.ok ? "" : String(called.error)).toBe(true);
      expect(JSON.stringify(await day.liveBoard(t.id, new Date()))).toContain('"bracket":"consolation"');
    } finally {
      vi.useRealTimers();
    }
  });

  it("K1: every decided match between two entrants is one ledger row, the consolation draw's included; a bye is none; a correction replaces the row", async () => {
    const { setEventRated } = await import("../src/lib/ratings");
    const t = await k.tournament(FEED);
    expect(await setEventRated("tournament", t.id, true)).toMatchObject({ ok: true });
    await k.field(t.id, 7);
    const made = await makeDraw(t.id, fixed);
    if (!made.ok) throw new Error(made.error);
    const rows = async () => ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM rated_results WHERE source_kind = 'tournament' AND source_id = ? AND voided_at IS NULL").get(t.id)) as { n: number }).n;
    expect(await rows()).toBe(0);
    const { d } = await k.play(t.id, chalk);
    expect(d.status).toBe("finished");
    // Seven entries: main draw 6 matches played, consolation draw 4 (n-3): ten matches, the one bye none.
    expect(d.matches.filter((m) => m.status === "done")).toHaveLength(10);
    expect(d.matches.filter((m) => m.bracket === "consolation" && m.status === "done")).toHaveLength(4);
    expect(await rows()).toBe(10);
    // A correction through both routes replaces the rows: the ledger is read again.
    const c = matchAt(d, "consolation:1:1");
    const swap = resultOf(c, flipped(c));
    const preview = await previewResult(c.id, swap);
    if (!preview.ok) throw new Error(preview.error);
    const done = await applyCorrection(c.id, swap, { mode: "standings_only", reason: "Consolation sheet corrected", token: preview.value.token }, owner);
    if (!done.ok) throw new Error(done.error);
    expect(await rows()).toBe(10);
    const row = (await getDb().prepare("SELECT outcome FROM rated_results WHERE source_kind = 'tournament' AND source_id = ? AND source_match = ? AND voided_at IS NULL").get(t.id, c.id)) as { outcome: string };
    expect(Number(row.outcome)).toBe(swap.winner === c.a ? 1 : 0);
    const m = matchAt(done.value.detail, "main:1:2");
    const swapMain = resultOf(m, flipped(m));
    const previewMain = await previewResult(m.id, swapMain);
    if (!previewMain.ok) throw new Error(previewMain.error);
    expect(await applyCorrection(m.id, swapMain, { mode: "standings_only", reason: "Main sheet corrected", token: previewMain.value.token }, owner)).toMatchObject({ ok: true });
    expect(await rows()).toBe(10);
  });

  it("T2: the public data carries the consolation draw's matches with their routes and the final places; the preview route says what the format adds", async () => {
    const { NextRequest } = await import("next/server");
    const { ADMIN_SESSION_COOKIE, createAdminSession } = await import("../src/lib/admin-auth");
    const { t } = await k.drawn(FEED, 6);
    await k.play(t.id, chalk);
    const publicRoute = await import("../src/app/api/tournaments/[id]/route");
    const res = await publicRoute.GET(new NextRequest(`http://localhost/api/tournaments/${t.id}`), { params: Promise.resolve({ id: String(t.id) }) });
    const body = (await res.json()) as { tournament: { status: string; placings: { place: number }[]; rules: { bracket: { consolationMode?: string } }; matches: { bracket: string; loserNext: number | null }[] } };
    expect(body.tournament.status).toBe("finished");
    expect(body.tournament.placings).toHaveLength(6);
    expect(body.tournament.placings.slice(0, 4).map((p) => p.place)).toEqual([1, 2, 3, 4]);
    expect(body.tournament.rules.bracket.consolationMode).toBe("feed_in");
    expect(body.tournament.matches.filter((m) => m.bracket === "consolation")).toHaveLength(3);
    // The preview route, for staff.
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(env.ownerId)).token}`;
    const preview = await import("../src/app/api/admin/tournaments/[id]/feed-in-preview/route");
    const ask = async (id: number, query = "") =>
      preview.GET(new NextRequest(`http://localhost/api/admin/tournaments/${id}/feed-in-preview${query}`, { headers: { cookie } }), { params: Promise.resolve({ id: String(id) }) });
    const open = await k.tournament({ ...FEED, maxEntries: 16 });
    const got = await ask(open.id);
    expect(got.status).toBe(200);
    expect(((await got.json()) as { preview: { entries: number; consequences: { consolationMatches: number; totalMatches: number } } }).preview).toMatchObject({ entries: 16, consequences: { consolationMatches: 13, totalMatches: 28 } });
    const eight = await ask(open.id, "?entries=8&consolationThirdPlace=1");
    expect(((await eight.json()) as { preview: { consequences: { consolationMatches: number } } }).preview.consequences.consolationMatches).toBe(6);
    expect((await ask(open.id, "?entries=1")).status).toBe(400);
    // Not for another format; not without a session.
    const groups = await k.tournament({ format: "groups" });
    expect((await ask(groups.id)).status).toBe(409);
    const anonymous = await preview.GET(new NextRequest(`http://localhost/api/admin/tournaments/${open.id}/feed-in-preview`), { params: Promise.resolve({ id: String(open.id) }) });
    expect(anonymous.status).toBe(401);
  });

  it("S2: through the create route the format is refused without confirmFeedIn (400, code, the numbers), and made with it", async () => {
    const { NextRequest } = await import("next/server");
    const { ADMIN_SESSION_COOKIE, createAdminSession } = await import("../src/lib/admin-auth");
    const { addDays, todayISO } = await import("../src/lib/time");
    const route = await import("../src/app/api/admin/tournaments/route");
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(env.ownerId)).token}`;
    const day = addDays(todayISO(), 220);
    const post = (over: Record<string, unknown>) =>
      route.POST(
        new NextRequest("http://localhost/api/admin/tournaments", {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ venueId: env.venueId, name: "Feed Route Cup", sport: "badminton", format: "knockout", teamSize: 1, entryFee: 0, maxEntries: 16, startsOn: day, endsOn: day, startHour: 9, endHour: 21, courtIds: env.courts, rules: { bracket: { consolation: true, consolationMode: "feed_in" } }, ...over }),
        })
      );
    const refused = await post({});
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: "FEED_IN_CONFIRM", vars: { entries: 16, addedMatches: 13, totalMatches: 28 } });
    const made = await post({ confirmFeedIn: true });
    expect(made.status).toBe(201);
    const t = ((await made.json()) as { tournament: { id: number; rules: { bracket: { consolationMode: string } } } }).tournament;
    expect(t.rules.bracket.consolationMode).toBe("feed_in");
    // The rules route: switching another tournament to it asks for the confirmation too.
    const other = await k.tournament({ format: "knockout" });
    const tournamentRoute = await import("../src/app/api/admin/tournaments/[id]/route");
    const set = (body: Record<string, unknown>) =>
      tournamentRoute.POST(new NextRequest(`http://localhost/api/admin/tournaments/${other.id}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: String(other.id) }) });
    const rules = { bracket: { consolation: true, consolationMode: "feed_in" } };
    const no = await set({ action: "rules", rules });
    expect(no.status).toBe(409);
    expect(await no.json()).toMatchObject({ code: "FEED_IN_CONFIRM" });
    expect((await set({ action: "rules", rules, confirmFeedIn: true })).status).toBe(200);
  });
});

describe("one change at a time (T3)", () => {
  it("T3: two first-round results at once, each feeding the same consolation match, both go in", async () => {
    const { t } = await k.drawn(FEED, 8);
    const d = await staff(t.id);
    const feeders = d.matches.filter((m) => m.bracket === "main" && m.round === 1 && m.loserNext === matchAt(d, "consolation:1:1").id);
    expect(feeders).toHaveLength(2);
    const both = await Promise.all(feeders.map((m) => recordResult(m.id, { winner: m.a!, score: k.score(m, m.a!) })));
    expect(both.map((r) => r.ok)).toEqual([true, true]);
    const cons = matchAt(await staff(t.id), "consolation:1:1");
    expect([cons.a, cons.b].sort()).toEqual(feeders.map((m) => m.b!).sort());
  });

  it("T3: a semi-final's result and its drop-round match's move at once: whichever goes first, the state is consistent", async () => {
    const { t } = await k.drawn(FEED, 8);
    const first = await staff(t.id);
    for (const place of ["main:1:1", "main:1:2", "main:1:3", "main:1:4"]) await k.result(matchAt(first, place), chalk(matchAt(first, place)));
    const d = await staff(t.id);
    const semi = matchAt(d, "main:2:1");
    const drop = d.matches.find((m) => m.id === semi.loserNext)!;
    const to = { courtId: drop.courtId!, date: drop.date!, startMin: drop.minute! + 30 };
    const raced = await Promise.all([recordResult(semi.id, { winner: semi.a!, score: k.score(semi, semi.a!) }), moveMatch(drop.id, to)]);
    expect(raced[0].ok).toBe(true);
    const end = await staff(t.id);
    expect(violations(end)).toEqual([]);
    expect(end.matches.filter((m) => m.status === "scheduled" && m.date !== null).every((m) => m.courtId !== null)).toBe(true);
  });
});

describe("a division of a competition (T1)", () => {
  it("T1: a feed-in knockout is scheduled into the competition's time around its sibling: never two matches on a court, and nobody on court in both divisions at once", async () => {
    const { addDays, todayISO } = await import("../src/lib/time");
    const { createCompetition } = await import("../src/lib/competitions");
    const { createTournament, enter } = await import("../src/lib/tournaments");
    const day = addDays(todayISO(), 300);
    const made = await createCompetition({ venueId: env.venueId, name: "Club Championship FI", sport: "badminton", startsOn: day, endsOn: day, startMin: 9 * 60, endMin: 21 * 60, matchMinutes: 30, courtIds: env.courts.slice(0, 2) }, env.ownerId);
    if (!made.ok) throw new Error(made.error);
    const division = async (name: string, over: Record<string, unknown>) => {
      const t = await createTournament(
        { venueId: env.venueId, competitionId: made.value.id, name, sport: "badminton", format: "knockout", teamSize: 1, level: null, entryFee: 0, maxEntries: 16, startsOn: "2099-01-01", endsOn: "2099-01-01", courtIds: [], ...over } as never,
        env.ownerId
      );
      if (!t.ok) throw new Error(t.error);
      return t.value;
    };
    const first = await division("Men's Feed-in", FEED);
    const second = await division("Men's Knockout", {});
    const users = [await k.player(), await k.player(), await k.player(), await k.player(), await k.player(), await k.player()];
    for (const tid of [first.id, second.id])
      for (const u of users) {
        const e = await enter(u, tid);
        if (!e.ok) throw new Error(e.error);
      }
    expect((await makeDraw(first.id, fixed)).ok).toBe(true);
    expect((await makeDraw(second.id, fixed)).ok).toBe(true);
    await k.play(first.id, chalk);
    await k.play(second.id, chalk);
    const a = await staff(first.id);
    const b = await staff(second.id);
    expect([a.status, b.status]).toEqual(["finished", "finished"]);
    const owner_ = new Map<number, number>();
    for (const row of (await getDb().prepare("SELECT id, user_id FROM tournament_entries WHERE tournament_id IN (?, ?)").all(first.id, second.id)) as { id: number; user_id: number }[]) owner_.set(row.id, row.user_id);
    const played = [...a.matches, ...b.matches].filter((m) => m.status === "done" && m.date !== null);
    const slots = new Set<string>();
    for (const m of played) {
      const key = `${m.courtId}|${m.date}|${m.minute}`;
      expect(slots.has(key), `two matches on court ${m.courtId} at ${m.minute}`).toBe(false);
      slots.add(key);
    }
    for (const user of users) {
      const mine = played.filter((m) => owner_.get(m.a!) === user.id || owner_.get(m.b!) === user.id);
      for (const x of mine) for (const y of mine) if (x.id < y.id) expect(x.minute! < y.minute! + y.minutes && y.minute! < x.minute! + x.minutes, `${user.id} in two matches at once`).toBe(false);
    }
    expect(violations(a)).toEqual([]);
    expect(a.matches.filter((m) => m.bracket === "consolation")).toHaveLength(3);
  });
});
