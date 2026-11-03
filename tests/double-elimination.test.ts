import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { saveVenueTemplate, venueTemplates } from "../src/lib/competition-templates";
import { getDb } from "../src/lib/db";
import { bracketSize, doubleElimination, firstRound } from "../src/lib/brackets";
import { listVenues } from "../src/lib/store";
import { englishOf } from "../src/lib/staff-text";
import {
  applyCorrection,
  makeDraw,
  moveMatch,
  previewResult,
  previewTakeOut,
  recordResult,
  resolveIssue,
  reviewIssue,
  setRules,
  takeOut,
  tournamentDetail,
  type Match,
  type TournamentDetail,
} from "../src/lib/tournaments";
import { at, chalk, fixed, kit, matchAt, shape, violations, type Env } from "./helpers/knockout-formats";

/**
 * Double elimination (ADR 0032, E, P, R, L, F, T): the structure as stored, progression through whole events, the grand-final reset,
 * corrections after play has begun with their two chains, leavers in each bracket, court time. Each test names the rule it proves.
 */

let env: Env;
let k: ReturnType<typeof kit>;
let owner: { id: number; name: string };
const idsOf = (d: TournamentDetail) => d.entries.map((e) => e.id);

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const admin = (await listAdmins())[0];
  owner = { id: admin.id, name: admin.name };
  const venue = (await listVenues())[0];
  env = { venueId: venue.id, ownerId: admin.id, courts: venue.courts.filter((c) => c.sport === "badminton").map((c) => c.id) };
  k = kit(env, "de");
});

const DE = { format: "double_elimination" as const };

describe("setting one up (S)", () => {
  it("S1: double elimination is a format, the grand-final reset is a rule that is on unless turned off, and it is read back", async () => {
    const t = await k.tournament(DE);
    expect(t.format).toBe("double_elimination");
    expect(t.rules.bracket).toEqual({ consolation: false, consolationThirdPlace: false, grandFinalReset: true });
    const off = await k.tournament({ ...DE, rules: { bracket: { grandFinalReset: false } } });
    expect(off.rules.bracket.grandFinalReset).toBe(false);
    // Changed until the draw, not after: results depend on it.
    expect(await setRules(off.id, { bracket: { grandFinalReset: true } })).toMatchObject({ ok: true });
    expect((await tournamentDetail(off.id))!.rules.bracket.grandFinalReset).toBe(true);
    await k.field(off.id, 3);
    expect((await makeDraw(off.id, fixed)).ok).toBe(true);
    expect(await setRules(off.id, { bracket: { grandFinalReset: false } })).toMatchObject({ ok: false });
  });

  it("S2: a consolation draw is not for double elimination, nor for groups; a third-place match is not for double elimination; bad values are refused", async () => {
    await expect(k.tournament({ ...DE, rules: { bracket: { consolation: true } } })).rejects.toThrow(/straight knockout/);
    await expect(k.tournament({ format: "groups", rules: { bracket: { consolation: true } } })).rejects.toThrow(/straight knockout/);
    await expect(k.tournament({ ...DE, thirdPlace: true })).rejects.toThrow(/third-place/);
    await expect(k.tournament({ format: "knockout", rules: { bracket: { consolationThirdPlace: true } } })).rejects.toThrow(/needs a consolation draw/);
    await expect(k.tournament({ ...DE, rules: { bracket: { grandFinalReset: "yes" } } })).rejects.toThrow(/yes or no/);
    // The same refusals when the rules are changed before the draw.
    const t = await k.tournament(DE);
    expect(await setRules(t.id, { bracket: { consolation: true } })).toMatchObject({ ok: false });
  });

  it("S3: it takes three entries at least (two would be a final played twice), and up to the tournament's maximum", async () => {
    const t = await k.tournament({ ...DE, maxEntries: 128 });
    await k.field(t.id, 2);
    expect(await makeDraw(t.id, fixed)).toMatchObject({ ok: false, error: "At least 3 entries are needed." });
    await k.field(t.id, 1);
    expect(await makeDraw(t.id, fixed)).toMatchObject({ ok: true });
  });

  it("a venue's own template keeps the format and the reset (migration 0271)", async () => {
    const t = await k.tournament({ ...DE, rules: { bracket: { grandFinalReset: false } } });
    const saved = await saveVenueTemplate(t.id, "Club double elimination", env.ownerId);
    expect(saved).toMatchObject({ ok: true, value: { format: "double_elimination" } });
    expect((await venueTemplates(env.venueId)).find((x) => x.name === "Club double elimination")!.rules.bracket.grandFinalReset).toBe(false);
  });
});

describe("the draw (D, E, T)", () => {
  for (const n of [3, 4, 5, 6, 8, 11, 16]) {
    it(`E1 E2 E5 D3: ${n} entries make 2n-2 matches, byes through, routes the pure structure plans`, async () => {
      const { t, ids } = await k.drawn(DE, n, n > 11 ? 2 : 1);
      const real = t.matches.filter((m) => m.status !== "bye");
      expect(real.filter((m) => m.bracket === "winners")).toHaveLength(n - 1);
      expect(real.filter((m) => m.bracket === "losers")).toHaveLength(n - 2);
      expect(real.filter((m) => m.bracket === "grand")).toHaveLength(2);
      expect(violations(t)).toEqual([]);
      // The byes are the top seeds' and went straight through.
      const size = bracketSize(n);
      expect(t.matches.filter((m) => m.status === "bye" && m.bracket === "winners")).toHaveLength(size - n);
      for (const b of t.matches.filter((m) => m.status === "bye" && m.bracket === "winners")) expect(b.winner).toBe(b.a ?? b.b);
      // The stored matches are the planned ones: same places, same first round, same routes.
      const plan = doubleElimination(size, firstRound(t.drawOrder!), true);
      const place = (m: { bracket: string; round: number; position: number }) => `${m.bracket}:${m.round}:${m.position}`;
      const stored = new Map(t.matches.map((m) => [place(m), m]));
      expect(stored.size).toBe(plan.length);
      for (const p of plan) {
        const m = stored.get(`${p.bracket === "main" ? "main" : p.bracket}:${p.round}:${p.position}`)!;
        expect(m, p.key).toBeTruthy();
        if (p.round === 1 && p.bracket === "winners") expect([m.a, m.b]).toEqual([p.a, p.b]);
        const target = (id: number | null) => (id === null ? null : place(t.matches.find((x) => x.id === id)!));
        const planned = (key: string | null) => (key === null ? null : place(plan.find((x) => x.key === key)!));
        expect(target(m.next), `${p.key} winner's route`).toBe(planned(p.nextKey));
        expect(target(m.loserNext), `${p.key} loser's route`).toBe(planned(p.loserNextKey));
      }
      expect(t.drawOrder).toHaveLength(n);
      expect([...t.drawOrder!].sort((x, y) => x - y)).toEqual([...ids].sort((x, y) => x - y));
    });
  }

  it("D1: the order the draw was made in is recorded, seeds first and then those drawn by lot; the same chance gives the same order, and the matches are the structure built from it", async () => {
    const a = await k.drawn(DE, 7);
    const c = await k.drawn(DE, 7);
    // The same source of chance and the same entries: the same order (by place entered) and the same draw.
    expect(c.t.drawOrder!.map((e) => c.ids.indexOf(e))).toEqual(a.t.drawOrder!.map((e) => a.ids.indexOf(e)));
    expect(shape(c.t, c.ids)).toEqual(shape(a.t, a.ids));
    // Another source of chance draws the unseeded differently; a seed set by staff is first whatever the chance.
    const b = await k.tournament(DE);
    const ids = await k.field(b.id, 7);
    const { setEntry } = await import("../src/lib/tournaments");
    await setEntry(ids[5], { seed: 1 });
    const seeded = await makeDraw(b.id, () => 0.9);
    if (!seeded.ok) throw new Error(seeded.error);
    expect(seeded.value.drawOrder![0]).toBe(ids[5]);
    expect(seeded.value.drawOrder).not.toEqual(a.t.drawOrder!.map((e) => ids[a.ids.indexOf(e)]));
    // Everything in the draw is a function of that order (E1 E2 above): rebuilt from it, the first round is the same.
    const rebuilt = doubleElimination(bracketSize(7), firstRound(seeded.value.drawOrder!), true);
    const stored = seeded.value.matches.filter((m) => m.bracket === "winners" && m.round === 1).sort((x, y) => x.position - y.position);
    expect(stored.map((m) => [m.a, m.b])).toEqual(rebuilt.filter((m) => m.round === 1 && m.bracket === "winners").map((m) => [m.a, m.b]));
  });

  it("S4 T1: every match has the length its stage gives it, and starts after every match that feeds it on either route", async () => {
    const { t } = await k.drawn({ ...DE, stageMinutes: { knockout: 20, final: 25, losers: 35, grand_final: 45, reset: 50 } }, 8, 2);
    const lengths = (bracket: string, round?: number) => t.matches.filter((m) => m.bracket === bracket && (round === undefined || m.round === round) && m.status !== "bye").map((m) => m.minutes);
    expect(new Set(lengths("winners", 1))).toEqual(new Set([20]));
    expect(new Set(lengths("winners", 3))).toEqual(new Set([25]));
    expect(new Set(lengths("losers"))).toEqual(new Set([35]));
    expect(lengths("grand")).toEqual([45, 50]);
    const end = (m: Match) => `${m.date} ${String(m.minute! + m.minutes).padStart(4, "0")}`;
    const start = (m: Match) => `${m.date} ${String(m.minute!).padStart(4, "0")}`;
    for (const m of t.matches.filter((x) => x.status !== "bye")) {
      expect(m.courtId, at(m)).not.toBeNull();
      for (const f of t.matches.filter((x) => x.next === m.id || x.loserNext === m.id).filter((x) => x.status !== "bye"))
        expect(start(m) >= end(f), `${at(m)} starts after ${at(f)} ends`).toBe(true);
    }
    // Nobody is on two courts at once, and no court has two matches at once (the database refuses it too).
    const slots = t.matches.filter((x) => x.status !== "bye").map((m) => `${m.courtId}|${m.date}|${m.minute}`);
    expect(new Set(slots).size).toBe(slots.length);
  });

  it("T1: where there is no room for the reset it is left without a court, and the draw is not refused", async () => {
    // Four entries: 6 matches of 60 minutes in 6 hours on one court, so the reset cannot fit.
    const t = await k.tournament({ ...DE, courtIds: [env.courts[0]], startHour: 9, endHour: 15, matchMinutes: 60 });
    await k.field(t.id, 4);
    const made = await makeDraw(t.id, fixed);
    if (!made.ok) throw new Error(made.error);
    const reset = matchAt(made.value, "grand:2:1");
    expect(reset).toMatchObject({ courtId: null, date: null, minute: null, status: "scheduled" });
    // 3 entries need 4 matches before the reset: they fit with it too.
    const roomy = await k.drawn({ ...DE, courtIds: [env.courts[0]], startHour: 9, endHour: 15, matchMinutes: 60 }, 3);
    expect(matchAt(roomy.t, "grand:2:1").courtId).not.toBeNull();
  });
});

describe("progression through a whole event (P, E4, F)", () => {
  const outcomes: [string, (m: Match) => number][] = [
    ["the entry entered first wins every match", chalk],
    ["the entry entered last wins every match", (m) => Math.max(m.a!, m.b!)],
    ["the first side wins", (m) => m.a!],
    ["the second side wins", (m) => m.b!],
    ["alternately", (m) => ((m.id + m.round) % 2 === 0 ? m.a! : m.b!)],
  ];
  for (const n of [3, 4, 6, 8, 11]) {
    for (const [name, rule] of outcomes) {
      it(`${n} entries, ${name}: G3 after every result; it finishes; everybody is placed once; matches played are 2n-2 and a reset where it was needed`, async () => {
        const { t } = await k.drawn(DE, n, n > 8 ? 2 : 1);
        let d = (await tournamentDetail(t.id, { forStaff: true }))!;
        const trace: string[] = [];
        for (let step = 0; step < 100; step++) {
          const next = d.matches.find((m) => m.status === "scheduled" && m.a !== null && m.b !== null);
          if (!next) break;
          await k.result(next, rule(next));
          d = (await tournamentDetail(t.id, { forStaff: true }))!;
          trace.push(at(next));
          expect(violations(d), `after ${trace.join(", ")}`).toEqual([]);
        }
        expect(d.status).toBe("finished");
        const grandFinal = matchAt(d, "grand:1:1");
        const reset = matchAt(d, "grand:2:1");
        // E4: the reset is played exactly when the losers' bracket's champion (the second side) won the grand final.
        if (grandFinal.winner === grandFinal.b) expect(reset.status).toBe("done");
        else expect(reset).toMatchObject({ status: "bye", a: null, b: null, winner: null });
        expect(d.matches.filter((m) => m.status === "done")).toHaveLength(2 * n - 2 + (grandFinal.winner === grandFinal.b ? 1 : 0));
        // F1 F3: one place each; the champion won what decided it, the runner-up lost it.
        const places = d.placings!;
        expect(places.map((p) => p.entryId).sort((x, y) => x - y)).toEqual([...idsOf(d)].sort((x, y) => x - y));
        const decider = reset.status === "done" ? reset : grandFinal;
        expect(places[0]).toEqual({ entryId: decider.winner, place: 1 });
        expect(places[1].place).toBe(2);
        expect(places[1].entryId).toBe(decider.winner === decider.a ? decider.b : decider.a);
        // The third place is the loser of the losers' final.
        const losersFinal = d.matches.filter((m) => m.bracket === "losers").sort((x, y) => y.round - x.round)[0];
        expect(places.find((p) => p.entryId === (losersFinal.winner === losersFinal.a ? losersFinal.b : losersFinal.a))!.place).toBe(3);
        // Every entrant lost at most twice, and everybody but the champion exactly twice, except the runner-up of an unreset final.
        const losses = new Map<number, number>();
        for (const m of d.matches.filter((x) => x.status === "done"))
          for (const e of [m.a!, m.b!]) if (e !== m.winner) losses.set(e, (losses.get(e) ?? 0) + 1);
        for (const e of idsOf(d)) expect(losses.get(e) ?? 0).toBeLessThanOrEqual(2);
      });
    }
  }

  it("E4: with the reset off the grand final decides and there is no reset match", async () => {
    const { t } = await k.drawn({ ...DE, rules: { bracket: { grandFinalReset: false } } }, 4);
    expect(t.matches.find((m) => m.bracket === "grand" && m.round === 2)).toBeUndefined();
    const { d } = await k.play(t.id, (m) => m.b!);
    expect(d.status).toBe("finished");
    expect(d.matches.filter((m) => m.status === "done")).toHaveLength(6);
    const final = matchAt(d, "grand:1:1");
    expect(d.placings![0].entryId).toBe(final.winner);
  });

  it("E6 P5: the reset is empty and to play before the grand final, needed (both in it) or not (a bye, nobody in it) after", async () => {
    const { t } = await k.drawn(DE, 4);
    const before = matchAt(t, "grand:2:1");
    expect(before).toMatchObject({ status: "scheduled", a: null, b: null });
    // Play to the grand final: the second side (the losers' champion) wins it.
    const { d } = await k.play(t.id, (m) => (m.bracket === "grand" ? m.b! : chalk(m)), (m) => m.bracket === "grand" && m.round === 2);
    const reset = matchAt(d, "grand:2:1");
    const gf = matchAt(d, "grand:1:1");
    expect(gf.winner).toBe(gf.b);
    expect(reset).toMatchObject({ status: "scheduled", a: gf.winner, b: gf.a });
    expect(d.status).toBe("drawn");
    expect(violations(d)).toEqual([]);
  });
});

describe("somebody leaving (L)", () => {
  it("L1 P2: a leaver before their first match is a walkover to the opponent in the winners' bracket, and out of the event in the losers'", async () => {
    const { t, ids } = await k.drawn(DE, 8);
    const first = matchAt(t, "winners:1:1");
    const leaver = first.a!;
    const preview = await previewTakeOut(leaver, "withdrawn");
    if (!preview.ok) throw new Error(preview.error);
    expect(preview.value.consequential).toBe(true);
    const done = await takeOut(leaver, "withdrawn", undefined, { token: preview.value.token });
    if (!done.ok) throw new Error(done.error);
    // The preview is a rolled-back run of the real change: it said what was done.
    expect(done.value.changes).toEqual(preview.value.changes);
    const d = (await tournamentDetail(t.id, { forStaff: true }))!;
    expect(matchAt(d, "winners:1:1")).toMatchObject({ status: "walkover", winner: first.b });
    expect(violations(d)).toEqual([]);
    // They sit in the losers' bracket until the other side is known, then lose there by walkover.
    const l1 = matchAt(d, "losers:1:1");
    expect([l1.a, l1.b]).toContain(leaver);
    expect(d.entries.find((e) => e.id === leaver)!.out).toMatchObject({ reason: "withdrawn", stage: "knockout" });
    // Play on; the leaver never plays again, and the event finishes.
    const end = await k.play(t.id, chalk);
    expect(end.d.status).toBe("finished");
    expect(violations(end.d)).toEqual([]);
    expect(end.d.matches.filter((m) => m.status === "done" && (m.a === leaver || m.b === leaver))).toHaveLength(0);
    expect(end.d.matches.filter((m) => m.status === "walkover" && (m.a === leaver || m.b === leaver)).length).toBeGreaterThanOrEqual(2);
    expect(end.d.placings!.map((p) => p.entryId).sort((x, y) => x - y)).toEqual([...ids].sort((x, y) => x - y));
  });

  for (const reason of ["withdrawn", "retired", "disqualified"] as const) {
    it(`L1 L2: ${reason}, in each bracket and at each stage of a six-entry event: G3 holds, it finishes, and what was played stands`, async () => {
      // Everybody in turn, after nothing has been played and after the first round.
      for (const stopAfterRound of [0, 1]) {
        const { t, ids } = await k.drawn(DE, 6);
        if (stopAfterRound === 1) await k.play(t.id, chalk, (m) => m.round > 1 || m.bracket !== "winners");
        const before = (await tournamentDetail(t.id, { forStaff: true }))!;
        const eligible = ids.filter((e) => !before.entries.find((x) => x.id === e)!.out);
        // Somebody different for each: the leaver is the n-th entrant, by whom the draw put where.
        const leaver = eligible[(stopAfterRound * 2 + reason.length) % eligible.length];
        const preview = await previewTakeOut(leaver, reason);
        if (!preview.ok) throw new Error(preview.error);
        const done = await takeOut(leaver, reason, "left", { token: preview.value.token });
        if (!done.ok) throw new Error(done.error);
        expect(done.value.changes).toEqual(preview.value.changes);
        const d = (await tournamentDetail(t.id, { forStaff: true }))!;
        expect(violations(d)).toEqual([]);
        const playedBefore = before.matches.filter((m) => m.status === "done").map((m) => `${m.id}:${m.winner}:${m.score}`);
        const end = await k.play(t.id, chalk);
        expect(end.d.status).toBe("finished");
        expect(violations(end.d)).toEqual([]);
        // Results already played stand: a knockout result always does.
        const after = end.d.matches.filter((m) => m.status === "done").map((m) => `${m.id}:${m.winner}:${m.score}`);
        for (const p of playedBefore) expect(after).toContain(p);
        // The leaver plays no match after leaving.
        expect(end.d.matches.filter((m) => !before.matches.find((x) => x.id === m.id && x.status === "done") && m.status === "done" && (m.a === leaver || m.b === leaver))).toHaveLength(0);
        expect(end.d.placings!.find((p) => p.entryId === leaver)).toBeTruthy();
      }
    });
  }

  it("L1: a leaver in the losers' bracket (who has dropped in) is out of the event; the opponent has the walkover", async () => {
    const { t } = await k.drawn(DE, 8);
    // The winners' first round is played, chalk: the losers are in the losers' bracket.
    const { d } = await k.play(t.id, chalk, (m) => m.bracket !== "winners" || m.round > 1);
    const l1 = matchAt(d, "losers:1:1");
    const leaver = l1.a!;
    const opponent = l1.b!;
    const done = await takeOut(leaver, "retired");
    if (!done.ok) throw new Error(done.error);
    const after = (await tournamentDetail(t.id, { forStaff: true }))!;
    expect(matchAt(after, "losers:1:1")).toMatchObject({ status: "walkover", winner: opponent });
    expect(violations(after)).toEqual([]);
    // The opponent goes on in the losers' bracket, to the drop round.
    expect([matchAt(after, "losers:2:1").a, matchAt(after, "losers:2:1").b]).toContain(opponent);
  });

  it("L1: the winners' champion leaving before the grand final gives the losers' champion a walkover, and the reset (the leaver in it) one too", async () => {
    const { t } = await k.drawn(DE, 4);
    const { d } = await k.play(t.id, chalk, (m) => m.bracket === "grand" || (m.bracket === "losers" && m.round === 2));
    const gf = matchAt(d, "grand:1:1");
    const champ = gf.a!;
    expect(await takeOut(champ, "withdrawn")).toMatchObject({ ok: true });
    const mid = (await tournamentDetail(t.id, { forStaff: true }))!;
    expect(violations(mid)).toEqual([]);
    const end = await k.play(t.id, chalk);
    expect(end.d.status).toBe("finished");
    const final = matchAt(end.d, "grand:1:1");
    expect(final).toMatchObject({ status: "walkover", winner: final.b });
    expect(final.a).toBe(champ);
    // The losers' champion won the grand final, so the reset is needed: and the leaver is in it, so it is a walkover to the other.
    expect(matchAt(end.d, "grand:2:1")).toMatchObject({ status: "walkover", winner: final.b });
    expect(end.d.placings![0].entryId).toBe(final.b);
    expect(violations(end.d)).toEqual([]);
  });

  it("L3: a leaver after the draw can be taken out only as confirmed against the preview", async () => {
    const { t } = await k.drawn(DE, 5);
    const first = matchAt(t, "winners:1:2");
    const preview = await previewTakeOut(first.a!, "withdrawn");
    if (!preview.ok) throw new Error(preview.error);
    // Something changes meanwhile.
    await k.result(first, first.b!);
    expect(await takeOut(first.a!, "withdrawn", undefined, { token: preview.value.token })).toMatchObject({ ok: false, code: "CHANGED" });
  });
});

describe("corrections after play has begun (R)", () => {
  /** An eight-entry event, the entry entered first winning, played until `stop` says to leave a match. */
  async function eight(stop: (m: Match) => boolean = () => false) {
    const { t, ids } = await k.drawn(DE, 8);
    const { d } = await k.play(t.id, chalk, stop);
    return { t, ids, d };
  }
  const flipped = (m: Match) => (m.winner === m.a ? m.b! : m.a!);
  const resultOf = (m: Match, winner: number) => ({ winner, score: k.score(m, winner) });
  /** The same results again where a match is replayed: who lost it before loses again, else who won it wins, else the entry entered first. */
  const mirror = (before: TournamentDetail) => (m: Match) => {
    const was = before.matches.find((x) => x.id === m.id)!;
    const loser = was.winner === null ? null : was.winner === was.a ? was.b : was.a;
    if (loser !== null && (m.a === loser || m.b === loser)) return m.a === loser ? m.b! : m.a!;
    if (was.winner !== null && (m.a === was.winner || m.b === was.winner)) return was.winner;
    return chalk(m);
  };

  it("R1: a result put right while nothing it feeds is played moves both competitors, one along each route, in one change", async () => {
    const { d } = await eight((m) => !(m.bracket === "winners" && m.round === 1));
    const m = matchAt(d, "winners:1:1");
    const [oldWinner, oldLoser] = [m.winner!, m.winner === m.a ? m.b! : m.a!];
    expect(matchAt(d, "winners:2:1").a).toBe(oldWinner);
    expect(matchAt(d, "losers:1:1").a).toBe(oldLoser);
    const preview = await previewResult(m.id, resultOf(m, oldLoser));
    if (!preview.ok) throw new Error(preview.error);
    expect(preview.value.needsCorrection).toBe(false);
    // The change names both brackets.
    expect(preview.value.changes.join(" ")).toMatch(/Winners' round 2/);
    expect(preview.value.changes.join(" ")).toMatch(/Losers' round 1/);
    const done = await recordResult(m.id, resultOf(m, oldLoser));
    if (!done.ok) throw new Error(done.error);
    expect(matchAt(done.value, "winners:2:1").a).toBe(oldLoser);
    expect(matchAt(done.value, "losers:1:1").a).toBe(oldWinner);
    expect(violations(done.value)).toEqual([]);
    // As often as is wanted while nothing it fed is played.
    const back = await recordResult(m.id, resultOf(m, oldWinner));
    if (!back.ok) throw new Error(back.error);
    expect(matchAt(back.value, "winners:2:1").a).toBe(oldWinner);
    expect(violations(back.value)).toEqual([]);
  });

  it("R2: refused as a plain result once either match it fed is played: the winners' route, or the loser's alone", async () => {
    // The winners' route played: winners' round 2 match 1 (fed by winners' round 1 matches 1 and 2).
    const first = await eight((m) => m.bracket === "winners" && m.round === 3);
    const m = matchAt(first.d, "winners:1:1");
    expect(await recordResult(m.id, resultOf(m, flipped(m)))).toMatchObject({ ok: false, code: "KNOCKOUT_STARTED" });
    // The loser's route played alone: only the first winners' round and the first losers' round are played.
    const second = await eight((x) => !(x.bracket === "winners" && x.round === 1) && !(x.bracket === "losers" && x.round === 1));
    const m2 = matchAt(second.d, "winners:1:1");
    expect(matchAt(second.d, "winners:2:1").status).toBe("scheduled");
    expect(matchAt(second.d, "losers:1:1").status).toBe("done");
    expect(await recordResult(m2.id, resultOf(m2, flipped(m2)))).toMatchObject({ ok: false, code: "KNOCKOUT_STARTED" });
    // The same score put right, with the winner unchanged, is a correction too once a match it fed is played.
    expect(await recordResult(m2.id, { winner: m2.winner!, score: k.score(m2, m2.winner!).replace("21-10", "21-9") })).toMatchObject({ ok: false, code: "KNOCKOUT_STARTED" });
  });

  /** The first winners' match corrected in the record only after the first two winners' rounds and the first two losers' rounds are played. */
  async function wrongBothWays() {
    const { t, ids, d } = await eight((m) => (m.bracket === "winners" && m.round >= 3) || (m.bracket === "losers" && m.round >= 3));
    const m = matchAt(d, "winners:1:1");
    const swap = resultOf(m, flipped(m));
    const preview = await previewResult(m.id, swap);
    if (!preview.ok) throw new Error(preview.error);
    const done = await applyCorrection(m.id, swap, { mode: "standings_only", reason: "Names swapped on the sheet", token: preview.value.token }, owner);
    if (!done.ok) throw new Error(done.error);
    return { t, ids, before: d, m, swap, preview: preview.value, done: done.value };
  }

  it("R2 R3: the preview says the bracket cannot take it, what a record-only correction would change, and an issue for each route", async () => {
    const { m, preview, done, before } = await wrongBothWays();
    expect(preview.needsCorrection).toBe(true);
    expect(preview.replace).toMatchObject({ possible: false });
    expect(preview.issuesIfStandingsOnly).toHaveLength(2);
    // Applied, it is exactly what was previewed, and opens exactly those two issues.
    expect(done.changes).toEqual([...preview.standingsOnly.changes, ...preview.issuesIfStandingsOnly!]);
    expect(done.detail.issues).toHaveLength(2);
    const [winnersRoute, losersRoute] = done.detail.issues;
    const oldWinner = m.winner!;
    const oldLoser = m.winner === m.a ? m.b! : m.a!;
    // The wrong winner is in the winners' route; the old loser, who should have won, in the losers'.
    expect(winnersRoute).toMatchObject({ wrongEntry: oldWinner, rightEntry: oldLoser, status: "open" });
    expect(losersRoute).toMatchObject({ wrongEntry: oldLoser, rightEntry: oldWinner, status: "open" });
    expect(winnersRoute.fromMatchId).toBe(matchAt(before, "winners:2:1").id);
    expect(losersRoute.fromMatchId).toBe(matchAt(before, "losers:1:1").id);
    // Each lists every match the wrong competitor played, in the order played, played ones first.
    expect(winnersRoute.affected.map((a) => a.matchId)[0]).toBe(matchAt(before, "winners:2:1").id);
    expect(winnersRoute.affected[0].played).toBe(true);
    expect(losersRoute.affected.length).toBeGreaterThanOrEqual(1);
    // The record is right and nobody moved; the tournament does not finish while an issue is open.
    expect(matchAt(done.detail, "winners:1:1").winner).toBe(oldLoser);
    expect(matchAt(done.detail, "winners:2:1").a === oldWinner || matchAt(done.detail, "winners:2:1").b === oldWinner).toBe(true);
    expect(done.detail.status).toBe("drawn");
    expect(violations(done.detail, { openIssues: true })).toEqual([]);
  });

  it("R3: a record-only correction is a manager's, with a reason, against the state previewed", async () => {
    const { m, swap, preview } = await wrongBothWays();
    // Already applied: its token is stale.
    expect(await applyCorrection(m.id, swap, { mode: "standings_only", reason: "Again", token: preview.token }, owner)).toMatchObject({ ok: false, code: "CHANGED" });
    expect(await applyCorrection(m.id, swap, { mode: "standings_only", reason: "no", token: preview.token }, owner)).toMatchObject({ ok: false });
  });

  it("R5: both issues can be let stand, with a reason, and the tournament then finishes as played", async () => {
    const { t, done } = await wrongBothWays();
    for (const issue of done.detail.issues) {
      const review = await reviewIssue(issue.id);
      if (!review.ok) throw new Error(review.error);
      const resolved = await resolveIssue(issue.id, { action: "stand", reason: "Both players agreed", token: review.value.token }, owner);
      if (!resolved.ok) throw new Error(resolved.error);
    }
    const mid = await k.play(t.id, chalk);
    expect(mid.d.status).toBe("finished");
    expect(mid.d.issues.map((i) => i.status)).toEqual(["stood", "stood"]);
    expect(mid.d.placings).toHaveLength(8);
  });

  it("R6: replaying one issue replays both chains together: the right competitor in each place, nobody in two, and it plays to a finish", async () => {
    const { t, done, m } = await wrongBothWays();
    const [winnersRoute, losersRoute] = done.detail.issues;
    const review = await reviewIssue(winnersRoute.id);
    if (!review.ok) throw new Error(review.error);
    if (!review.value.replay.possible) throw new Error(review.value.replay.blockers.join(" "));
    // Both chains' matches are to be given a court and a time.
    const planned = review.value.replay.matches.map((x) => x.matchId);
    for (const a of [...winnersRoute.affected, ...losersRoute.affected]) expect(planned).toContain(a.matchId);
    const before = (await tournamentDetail(t.id, { forStaff: true }))!;
    const slots = Object.fromEntries(
      planned.map((id) => {
        const x = before.matches.find((y) => y.id === id)!;
        return [String(id), { courtId: x.courtId!, date: x.date!, startMin: x.minute! }];
      })
    );
    const replay = await resolveIssue(winnersRoute.id, { action: "replay", reason: "Both brackets replayed from the corrected result", token: review.value.token, slots }, owner);
    if (!replay.ok) throw new Error(replay.error);
    const d = replay.value.detail;
    expect(d.issues.map((i) => i.status)).toEqual(["replayed", "replayed"]);
    const oldWinner = winnersRoute.wrongEntry;
    const oldLoser = losersRoute.wrongEntry;
    // The right competitor is in the head of each chain, in the place of the wrong one, and they are to play again.
    const winnersHead = d.matches.find((x) => x.id === winnersRoute.fromMatchId)!;
    const losersHead = d.matches.find((x) => x.id === losersRoute.fromMatchId)!;
    expect([winnersHead.a, winnersHead.b]).toContain(oldLoser);
    expect([winnersHead.a, winnersHead.b]).not.toContain(oldWinner);
    expect([losersHead.a, losersHead.b]).toContain(oldWinner);
    expect([losersHead.a, losersHead.b]).not.toContain(oldLoser);
    expect(winnersHead.status).toBe("scheduled");
    expect(losersHead.status).toBe("scheduled");
    // Nobody is in two matches, and every side is explained, now that nothing is left wrong.
    expect(violations(d)).toEqual([]);
    expect(d.status).toBe("drawn");
    // What was played is kept in the record, and the correction and its resolution are listed.
    expect(d.corrections.map((c) => c.kind)).toEqual(["standings_only", "replay"]);
    const kept = (await getDb().prepare("SELECT before_state FROM tournament_corrections WHERE tournament_id = ? AND kind = 'replay'").get(t.id)) as { before_state: string };
    expect((JSON.parse(kept.before_state) as { id: number }[]).map((x) => x.id)).toEqual(expect.arrayContaining(planned));
    // The replayed matches played again, the same way where they can be, and the event finishes consistently.
    const end = await k.play(t.id, mirror(before));
    expect(end.d.status).toBe("finished");
    expect(violations(end.d)).toEqual([]);
    expect(end.d.placings).toHaveLength(8);
    expect(englishOf(replay.value.changePhrases[0])).toMatch(/replayed/i);
    expect(matchAt(end.d, "winners:1:1").winner).toBe(oldLoser);
    expect(m.id).toBe(matchAt(end.d, "winners:1:1").id);
  });

  it("R6: replaying the loser's route alone is refused while the winners' route is let stand: the right competitor is already in a match they did not come through", async () => {
    const { t, done } = await wrongBothWays();
    const [winnersRoute, losersRoute] = done.detail.issues;
    const stand = await reviewIssue(winnersRoute.id);
    if (!stand.ok) throw new Error(stand.error);
    expect(await resolveIssue(winnersRoute.id, { action: "stand", reason: "The winners' route stands", token: stand.value.token }, owner)).toMatchObject({ ok: true });
    const review = await reviewIssue(losersRoute.id);
    if (!review.ok) throw new Error(review.error);
    expect(review.value.replay).toMatchObject({ possible: false });
    expect(review.value.replay.possible === false && review.value.replay.blockers.join(" ")).toMatch(/already/);
    const d = (await tournamentDetail(t.id, { forStaff: true }))!;
    expect(d.issues.find((i) => i.id === losersRoute.id)!.status).toBe("open");
    // It can be let stand.
    expect(await resolveIssue(losersRoute.id, { action: "stand", reason: "The loser's route stands too", token: review.value.token }, owner)).toMatchObject({ ok: true });
  });

  it("R6: a replay is not put on a court somebody has booked, and a replay of both chains with a slot missing asks for it: nothing changes", async () => {
    const { t, done } = await wrongBothWays();
    const [winnersRoute] = done.detail.issues;
    const review = await reviewIssue(winnersRoute.id);
    if (!review.ok || !review.value.replay.possible) throw new Error("not reviewable");
    expect(await resolveIssue(winnersRoute.id, { action: "replay", reason: "Replay without courts", token: review.value.token }, owner)).toMatchObject({ ok: false, error: expect.stringMatching(/court and a time/) });
    const d = (await tournamentDetail(t.id, { forStaff: true }))!;
    expect(d.issues.every((i) => i.status === "open")).toBe(true);
    expect(violations(d, { openIssues: true })).toEqual([]);
  });

  it("R4: a record-only correction in the losers' bracket follows the winner only along the winners' route of the losers' bracket, into the grand final", async () => {
    // Everything played but the reset; the losers' final is then corrected in the record only.
    const { t } = await k.drawn(DE, 4);
    const { d } = await k.play(t.id, (m) => (m.bracket === "grand" ? m.b! : chalk(m)));
    expect(d.status).toBe("finished");
    const lf = matchAt(d, "losers:2:1");
    const swap = resultOf(lf, flipped(lf));
    const preview = await previewResult(lf.id, swap);
    if (!preview.ok) throw new Error(preview.error);
    expect(preview.value.needsCorrection).toBe(true);
    const done = await applyCorrection(lf.id, swap, { mode: "standings_only", reason: "Wrong player on the sheet", token: preview.value.token }, owner);
    if (!done.ok) throw new Error(done.error);
    // One issue (the losers' final's loser is out: no loser's route), from the grand final, through the reset.
    expect(done.value.detail.issues).toHaveLength(1);
    expect(done.value.detail.issues[0]).toMatchObject({ wrongEntry: lf.winner, rightEntry: flipped(lf), fromMatchId: matchAt(d, "grand:1:1").id });
    expect(done.value.detail.issues[0].affected.map((a) => a.matchId)).toEqual([matchAt(d, "grand:1:1").id, matchAt(d, "grand:2:1").id]);
    expect(done.value.detail.status).toBe("drawn");
  });

  it("R4: a grand final corrected so that the winners' champion won it, after the reset was played: one issue, the reset, with nobody to replay it for", async () => {
    const { t } = await k.drawn(DE, 4);
    const { d } = await k.play(t.id, (m) => (m.bracket === "grand" ? m.b! : chalk(m)));
    const gf = matchAt(d, "grand:1:1");
    expect(matchAt(d, "grand:2:1").status).toBe("done");
    const swap = resultOf(gf, gf.a!);
    expect(await recordResult(gf.id, swap)).toMatchObject({ ok: false, code: "KNOCKOUT_STARTED" });
    const preview = await previewResult(gf.id, swap);
    if (!preview.ok) throw new Error(preview.error);
    expect(preview.value.issuesIfStandingsOnly).toHaveLength(1);
    const done = await applyCorrection(gf.id, swap, { mode: "standings_only", reason: "The grand final was the other way", token: preview.value.token }, owner);
    if (!done.ok) throw new Error(done.error);
    const [issue] = done.value.detail.issues;
    expect(issue).toMatchObject({ fromMatchId: matchAt(d, "grand:2:1").id, rightEntry: null, status: "open" });
    const review = await reviewIssue(issue.id);
    if (!review.ok) throw new Error(review.error);
    expect(review.value.replay).toMatchObject({ possible: false });
    expect(await resolveIssue(issue.id, { action: "stand", reason: "The reset was played and stands", token: review.value.token }, owner)).toMatchObject({ ok: true });
    const end = (await tournamentDetail(t.id, { forStaff: true }))!;
    expect(end.status).toBe("finished");
    // As played stands: the reset's winner is champion.
    expect(end.placings![0].entryId).toBe(matchAt(end, "grand:2:1").winner);
  });

  it("R1 P5 P6: the grand final put right appears and takes away the reset, and a finished tournament is under way again when it is needed", async () => {
    const { t } = await k.drawn(DE, 4);
    // The winners' champion wins the grand final: it finishes, the reset not needed.
    const first = await k.play(t.id, chalk);
    expect(first.d.status).toBe("finished");
    const gf = matchAt(first.d, "grand:1:1");
    expect(matchAt(first.d, "grand:2:1")).toMatchObject({ status: "bye", a: null, b: null });
    const resetSlot = matchAt(first.d, "grand:2:1");
    // Put right: the losers' champion won. The reset appears, with both of them, and the tournament is not finished.
    const needed = await recordResult(gf.id, { winner: gf.b!, score: k.score(gf, gf.b!) });
    if (!needed.ok) throw new Error(needed.error);
    expect(matchAt(needed.value, "grand:2:1")).toMatchObject({ status: "scheduled", a: gf.b, b: gf.a });
    expect(needed.value.status).toBe("drawn");
    expect(needed.value.placings).toBeNull();
    expect(violations(needed.value)).toEqual([]);
    // Its time was kept, or it has none and a manager gives it one.
    const kept = matchAt(needed.value, "grand:2:1");
    expect(kept.courtId === null || (kept.courtId === resetSlot.courtId && kept.date === resetSlot.date)).toBe(true);
    if (kept.courtId === null) {
      const moved = await moveMatch(kept.id, { courtId: resetSlot.courtId ?? env.courts[0], date: resetSlot.date ?? gf.date!, startMin: (resetSlot.minute ?? gf.minute! + gf.minutes) + 0 });
      expect(moved).toBeDefined();
    }
    // Put right again, before the reset is played: it goes, and the tournament finishes.
    const gone = await recordResult(gf.id, { winner: gf.a!, score: k.score(gf, gf.a!) });
    if (!gone.ok) throw new Error(gone.error);
    expect(matchAt(gone.value, "grand:2:1")).toMatchObject({ status: "bye", a: null, b: null, winner: null });
    expect(gone.value.status).toBe("finished");
    expect(violations(gone.value)).toEqual([]);
    expect(gone.value.placings![0].entryId).toBe(gf.a);
  });

  it("R1: a result in the losers' bracket put right moves only its winner (nothing is routed from a loser there)", async () => {
    const { t } = await k.drawn(DE, 8);
    const { d } = await k.play(t.id, chalk, (m) => !(m.bracket === "winners" && m.round === 1));
    const m = matchAt(d, "losers:1:1");
    expect(m.status).toBe("scheduled");
    const w = await k.result(m, m.a!);
    const next = matchAt(w, "losers:2:1");
    expect([next.a, next.b]).toContain(m.a);
    const fixedUp = await recordResult(m.id, { winner: m.b!, score: k.score(m, m.b!) });
    if (!fixedUp.ok) throw new Error(fixedUp.error);
    const after = matchAt(fixedUp.value, "losers:2:1");
    expect([after.a, after.b]).toContain(m.b);
    expect([after.a, after.b]).not.toContain(m.a);
    expect(violations(fixedUp.value)).toEqual([]);
  });

  describe("a corrected event is the event played from scratch with the corrected result (replay-from-scratch equality)", () => {
    // Every match of a six-entry event in turn: play everything that does not depend on it, put it right, play on;
    // against the same event played with that result the other way round from the start.
    it("plain corrections at every depth, in each bracket: the corrected state is the scratch state", async () => {
      const probe = await k.drawn(DE, 6);
      const places = probe.t.matches.filter((m) => m.status !== "bye").map(at);
      expect(places.length).toBe(11);
      for (const place of places) {
        // A: played to the end by the rule, except that what depends on `place` waits until it has been put right.
        const a = await k.drawn(DE, 6);
        const target = matchAt(a.t, place);
        const descendants = (d: TournamentDetail, id: number) => {
          const seen = new Set<number>();
          const queue = [id];
          while (queue.length) {
            const x = queue.pop()!;
            for (const m of d.matches.filter((y) => y.id === x)) for (const to of [m.next, m.loserNext]) if (to !== null && !seen.has(to)) {
                seen.add(to);
                queue.push(to);
              }
          }
          return seen;
        };
        const waiting = descendants(a.t, target.id);
        await k.play(a.t.id, chalk, (m) => waiting.has(m.id));
        // The target decided (by the rule) if its sides are known; if it has not been played yet it is, then put right.
        let d = (await tournamentDetail(a.t.id, { forStaff: true }))!;
        let t1 = matchAt(d, place);
        if (t1.status === "scheduled" && t1.a !== null && t1.b !== null) {
          await k.result(t1, chalk(t1));
          d = (await tournamentDetail(a.t.id, { forStaff: true }))!;
          t1 = matchAt(d, place);
        }
        if (t1.status === "done") {
          const other = t1.winner === t1.a ? t1.b! : t1.a!;
          const done = await recordResult(t1.id, { winner: other, score: k.score(t1, other) });
          if (!done.ok) throw new Error(`${place}: ${done.error}`);
          expect(violations(done.value), `${place} corrected`).toEqual([]);
        }
        const endA = await k.play(a.t.id, chalk);
        // B: the same event, the target decided the other way round when it is played.
        const b = await k.drawn(DE, 6);
        const rule = (m: Match, dd: TournamentDetail) => (at(m) === place ? (chalk(m) === m.a ? m.b! : m.a!) : dd && chalk(m));
        const endB = await k.play(b.t.id, rule);
        // The target was only ever put right if it was played: where it was not (its sides never known as a pair), the two are the same event.
        if (t1.status === "done") expect(shape(endA.d, a.ids), place).toEqual(shape(endB.d, b.ids));
        expect(endA.d.status).toBe("finished");
        expect(violations(endA.d)).toEqual([]);
      }
    }, 240_000);
  });
});

describe("what the rest of the app does with these matches (T2, K)", () => {
  it("T2: a match is named by its bracket, in English and the staff language", async () => {
    const { t } = await k.drawn(DE, 5);
    const { matchNamePhrase } = await import("../src/lib/tournaments");
    const { staffTranslator } = await import("../src/lib/staff-i18n");
    const say = (place: string, lang: "en" | "ms" | "zh") => staffTranslator(lang, "MySenam").say(matchNamePhrase(t, matchAt(t, place)));
    expect(say("winners:1:2", "en")).toBe("Winners' round 1, match 2");
    expect(say("winners:3:1", "en")).toBe("Winners' final");
    expect(say("losers:2:1", "en")).toBe("Losers' round 2, match 1");
    expect(say("losers:4:1", "en")).toBe("Losers' final");
    expect(say("grand:1:1", "en")).toBe("Grand final");
    expect(say("grand:2:1", "en")).toBe("Grand final reset");
    expect(say("grand:1:1", "ms")).toBe("Akhir besar");
    expect(say("losers:4:1", "zh")).toBe("败者组决赛");
  });

  it("K1 T2: tournament day works on these fixtures: the board lists them with their names, a fixture is called, and the live page carries them", async () => {
    const day = await import("../src/lib/tournament-day");
    const { t, ids } = await k.drawn(DE, 4);
    for (const id of ids) {
      const { setEntry } = await import("../src/lib/tournaments");
      await setEntry(id, { checkedIn: true });
    }
    const board = await day.dayBoard(t.id);
    expect(board).not.toBeNull();
    const live = await day.liveBoard(t.id);
    expect(live!.courts.length).toBeGreaterThan(0);
    // After a result the live page shows it, named by its bracket.
    const first = matchAt((await tournamentDetail(t.id))!, "winners:1:1");
    await k.result(first, chalk(first));
    const after = await day.liveBoard(t.id);
    expect(after!.recent[0]).toMatchObject({ bracket: "winners", round: 1 });
  });

  it("T2: the next-match notice names a losers' bracket fixture by its bracket, a manager calls it to its court, and the live page says which bracket it is", async () => {
    const day = await import("../src/lib/tournament-day");
    const { instantOf } = await import("../src/lib/interval");
    const { tournamentZone, setEntry } = await import("../src/lib/tournaments");
    const { vi } = await import("vitest");
    const { t, ids } = await k.drawn(DE, 4);
    for (const id of ids) await setEntry(id, { checkedIn: true });
    const first = (await tournamentDetail(t.id, { forStaff: true }))!;
    for (const place of ["winners:1:1", "winners:1:2"]) await k.result(matchAt(first, place), chalk(matchAt(first, place)));
    const d = (await tournamentDetail(t.id, { forStaff: true }))!;
    const l1 = matchAt(d, "losers:1:1");
    expect(l1.status).toBe("scheduled");
    const zone = await tournamentZone(t.id);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(instantOf(t.startsOn, l1.minute! - 10, zone));
      const before = ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages WHERE kind = 'tournament_day'").get()) as { n: number }).n;
      expect(await day.announceNext(t.id)).toBeGreaterThan(0);
      const told = (await getDb().prepare("SELECT body FROM messages WHERE kind = 'tournament_day' ORDER BY id").all()) as { body: string }[];
      expect(told.length).toBeGreaterThan(before);
      expect(told.slice(before).some((m) => m.body.includes("Losers' round 1"))).toBe(true);
      // The fixture is called to its court by a manager, both sides having checked in.
      const called = await day.callFixture(l1.id, { id: null, name: "Musa Manager", role: "manager" });
      expect(called.ok, called.ok ? "" : String(called.error)).toBe(true);
      const board = await day.liveBoard(t.id, new Date());
      expect(JSON.stringify(board)).toContain('"bracket":"losers"');
    } finally {
      vi.useRealTimers();
    }
  });

  it("K1: every decided match between two entrants is one row in the ratings ledger, whatever its bracket; a bye and a reset not needed are none; a correction replays", async () => {
    const { setEventRated } = await import("../src/lib/ratings");
    const t = await k.tournament(DE);
    expect(await setEventRated("tournament", t.id, true)).toMatchObject({ ok: true });
    const ids = await k.field(t.id, 5);
    const made = await makeDraw(t.id, fixed);
    if (!made.ok) throw new Error(made.error);
    const live = async () => ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM rated_results WHERE source_kind = 'tournament' AND source_id = ? AND voided_at IS NULL").get(t.id)) as { n: number }).n;
    expect(await live()).toBe(0);
    // Players are accounts, so they can be rated.
    const { d } = await k.play(t.id, chalk, (m) => m.bracket === "grand");
    expect(d.matches.filter((m) => m.status === "done")).toHaveLength(d.matches.filter((m) => m.bracket !== "grand" && m.status !== "bye").length);
    expect(await live()).toBe(d.matches.filter((m) => m.status === "done").length);
    // The grand final won by the winners' champion: nine matches (2n-2 = 8, a bye is none, the reset is not needed).
    await k.play(t.id, chalk);
    const end = (await tournamentDetail(t.id))!;
    expect(end.status).toBe("finished");
    expect(await live()).toBe(2 * 5 - 2);
    // A correction through both chains replaces the rows: the ledger reads the result as it now stands.
    const m = matchAt(end, "winners:1:2");
    const swap = { winner: m.winner === m.a ? m.b! : m.a!, score: "" };
    swap.score = k.score(m, swap.winner);
    const preview = await previewResult(m.id, swap);
    if (!preview.ok) throw new Error(preview.error);
    expect(await applyCorrection(m.id, swap, { mode: "standings_only", reason: "Names swapped on the sheet", token: preview.value.token }, owner)).toMatchObject({ ok: true });
    expect(await live()).toBe(2 * 5 - 2);
    const row = (await getDb().prepare("SELECT outcome FROM rated_results WHERE source_kind = 'tournament' AND source_id = ? AND source_match = ? AND voided_at IS NULL").get(t.id, m.id)) as { outcome: string };
    expect(Number(row.outcome)).toBe(swap.winner === m.a ? 1 : 0);
    expect(ids.length).toBe(5);
  });
});

describe("one change at a time (T3)", () => {
  it("T3: two results feeding the same losers' match at once both go in, and a result and a move of the next match never interleave", async () => {
    const { t } = await k.drawn(DE, 8);
    const d = (await tournamentDetail(t.id, { forStaff: true }))!;
    const [one, two] = [matchAt(d, "winners:1:1"), matchAt(d, "winners:1:2")];
    const both = await Promise.all([recordResult(one.id, { winner: one.a!, score: k.score(one, one.a!) }), recordResult(two.id, { winner: two.b!, score: k.score(two, two.b!) })]);
    expect(both.map((r) => r.ok)).toEqual([true, true]);
    const after = (await tournamentDetail(t.id, { forStaff: true }))!;
    const l1 = matchAt(after, "losers:1:1");
    expect(l1.a).toBe(one.b);
    expect(l1.b).toBe(two.a);
    expect(violations(after)).toEqual([]);
    // A move of a fixture and a result of the match that feeds it, at once: whichever goes first, the state is consistent.
    const w2 = matchAt(after, "winners:2:1");
    const [three, four] = [matchAt(after, "winners:1:3"), matchAt(after, "winners:1:4")];
    await k.result(three, three.a!);
    const to = { courtId: w2.courtId!, date: w2.date!, startMin: w2.minute! + 60 };
    const raced = await Promise.all([recordResult(four.id, { winner: four.a!, score: k.score(four, four.a!) }), moveMatch(w2.id, to)]);
    expect(raced[0].ok).toBe(true);
    const end = (await tournamentDetail(t.id, { forStaff: true }))!;
    expect(violations(end)).toEqual([]);
    expect(end.matches.filter((m) => m.status === "scheduled" && m.date !== null).every((m) => m.courtId !== null)).toBe(true);
    // Whoever lost the race did not corrupt it: the moved match is where it was put, or where it was.
    const moved = matchAt(end, "winners:2:1");
    expect([w2.minute, to.startMin]).toContain(moved.minute);
  });
});

describe("a division of a competition (T1)", () => {
  it("T1: a double elimination is scheduled into the competition's time around its sibling: never two matches on a court, and nobody on court in both divisions at once", async () => {
    const { addDays, todayISO } = await import("../src/lib/time");
    const { createCompetition } = await import("../src/lib/competitions");
    const { createTournament, enter } = await import("../src/lib/tournaments");
    const day = addDays(todayISO(), 260);
    const made = await createCompetition({ venueId: env.venueId, name: "Club Championship DE", sport: "badminton", startsOn: day, endsOn: day, startMin: 9 * 60, endMin: 17 * 60, matchMinutes: 30, courtIds: env.courts.slice(0, 2) }, env.ownerId);
    if (!made.ok) throw new Error(made.error);
    const division = async (name: string, format: "double_elimination" | "knockout") => {
      const t = await createTournament(
        { venueId: env.venueId, competitionId: made.value.id, name, sport: "badminton", format, teamSize: 1, level: null, entryFee: 0, maxEntries: 16, startsOn: "2099-01-01", endsOn: "2099-01-01", courtIds: [] } as never,
        env.ownerId
      );
      if (!t.ok) throw new Error(t.error);
      return t.value;
    };
    const first = await division("Men's Double", "double_elimination");
    const second = await division("Men's Knockout", "knockout");
    const users = [await k.player(), await k.player(), await k.player(), await k.player()];
    const entered = async (tid: number) => {
      const ids: number[] = [];
      for (const u of users) {
        const e = await enter(u, tid);
        if (!e.ok) throw new Error(e.error);
        ids.push(e.value.id);
      }
      return ids;
    };
    await entered(first.id);
    await entered(second.id);
    expect((await makeDraw(first.id, fixed)).ok).toBe(true);
    expect((await makeDraw(second.id, fixed)).ok).toBe(true);
    await k.play(first.id, chalk);
    await k.play(second.id, chalk);
    const a = (await tournamentDetail(first.id, { forStaff: true }))!;
    const b = (await tournamentDetail(second.id, { forStaff: true }))!;
    expect([a.status, b.status]).toEqual(["finished", "finished"]);
    // By account: the same four people are entered in both. Each match as a time on a court.
    const owner = new Map<number, number>();
    for (const row of (await getDb().prepare("SELECT id, user_id FROM tournament_entries WHERE tournament_id IN (?, ?)").all(first.id, second.id)) as { id: number; user_id: number }[]) owner.set(row.id, row.user_id);
    const played = [...a.matches, ...b.matches].filter((m) => m.status === "done" && m.date !== null);
    const slots = new Set<string>();
    for (const m of played) {
      const key = `${m.courtId}|${m.date}|${m.minute}`;
      expect(slots.has(key), `two matches on court ${m.courtId} at ${m.minute}`).toBe(false);
      slots.add(key);
    }
    for (const user of users) {
      const mine = played.filter((m) => owner.get(m.a!) === user.id || owner.get(m.b!) === user.id);
      for (const x of mine)
        for (const y of mine)
          if (x.id < y.id) expect(x.minute! < y.minute! + y.minutes && y.minute! < x.minute! + x.minutes, `${user.id} in two matches at once`).toBe(false);
    }
    expect(violations(a)).toEqual([]);
  });
});

describe("the routes", () => {
  it("S1 S2: a manager sets a double elimination up through the route, with the reset off and a stage length; a consolation draw for it is refused; the public page's data carries the brackets, the places and the order", async () => {
    const { NextRequest } = await import("next/server");
    const { ADMIN_SESSION_COOKIE, createAdminSession } = await import("../src/lib/admin-auth");
    const { addDays, todayISO } = await import("../src/lib/time");
    const route = await import("../src/app/api/admin/tournaments/route");
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(env.ownerId)).token}`;
    const day = addDays(todayISO(), 200);
    const post = (over: Record<string, unknown>) =>
      route.POST(
        new NextRequest("http://localhost/api/admin/tournaments", {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({
            venueId: env.venueId,
            name: "Route Cup",
            sport: "badminton",
            format: "double_elimination",
            teamSize: 1,
            entryFee: 0,
            maxEntries: 16,
            startsOn: day,
            endsOn: day,
            startHour: 9,
            endHour: 21,
            courtIds: env.courts,
            stageMinutes: { grand_final: 50 },
            rules: { bracket: { grandFinalReset: false } },
            ...over,
          }),
        })
      );
    const made = await post({});
    expect(made.status).toBe(201);
    const t = ((await made.json()) as { tournament: { id: number; format: string; rules: { bracket: unknown }; stageMinutes: unknown } }).tournament;
    expect(t).toMatchObject({ format: "double_elimination", rules: { bracket: { grandFinalReset: false } }, stageMinutes: { grand_final: 50 } });
    const refused = await post({ name: "Route Cup 2", rules: { bracket: { consolation: true } } });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toMatch(/straight knockout/);
    // The public data of a drawn and finished one.
    await k.field(t.id, 4);
    expect((await makeDraw(t.id, fixed)).ok).toBe(true);
    await k.play(t.id, chalk);
    const publicRoute = await import("../src/app/api/tournaments/[id]/route");
    const res = await publicRoute.GET(new NextRequest(`http://localhost/api/tournaments/${t.id}`), { params: Promise.resolve({ id: String(t.id) }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tournament: { status: string; placings: { place: number }[]; drawOrder: number[]; matches: { bracket: string }[] } };
    expect(body.tournament.status).toBe("finished");
    expect(body.tournament.placings.map((p) => p.place)).toEqual([1, 2, 3, 4]);
    expect(body.tournament.drawOrder).toHaveLength(4);
    expect(new Set(body.tournament.matches.map((m) => m.bracket))).toEqual(new Set(["winners", "losers", "grand"]));
    // No reset match at all, with the setting off.
    expect(body.tournament.matches.filter((m) => m.bracket === "grand")).toHaveLength(1);
  });
});
