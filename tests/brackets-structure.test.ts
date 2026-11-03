import { describe, expect, it } from "vitest";
import { bracketSize, consolationDraw, doubleElimination, firstRound, matchLabel, placings, roundsByBracket, seedOrder, type PlannedMatch, type PlacingMatch } from "../src/lib/brackets";

/**
 * The structures of ADR 0032, apart from the database: consolation draws and double elimination as matches with routes
 * (G, C, E), checked by playing whole events on paper, every outcome where there are few enough to count.
 */

/** A knockout's matches as lib/tournaments.ts makes them (`knockout()`), for the consolation draw to hang on. */
function mainKnockout(size: number, pairs: [number | null, number | null][], thirdPlace = false): PlannedMatch[] {
  const rounds = Math.log2(size);
  const out: PlannedMatch[] = [];
  for (let r = 1; r <= rounds; r++)
    for (let p = 1; p <= size / 2 ** r; p++) {
      const pair = r === 1 ? pairs[p - 1] : [null, null];
      out.push({
        key: `k${r}-${p}`,
        bracket: "main",
        round: r,
        position: p,
        a: pair[0],
        b: pair[1],
        nextKey: r < rounds ? `k${r + 1}-${Math.ceil(p / 2)}` : null,
        nextSlot: r < rounds ? (p % 2 === 1 ? "a" : "b") : null,
        loserNextKey: null,
        loserNextSlot: null,
        after: r === 1 ? [] : [`k${r - 1}-${p * 2 - 1}`, `k${r - 1}-${p * 2}`],
        bye: r === 1 && (pair[0] === null) !== (pair[1] === null),
      });
    }
  if (thirdPlace && rounds >= 2) {
    for (const semi of out.filter((m) => m.round === rounds - 1)) {
      semi.loserNextKey = "k3p";
      semi.loserNextSlot = semi.position === 1 ? "a" : "b";
    }
    out.push({ key: "k3p", bracket: "main", round: rounds, position: 2, placement: 3, a: null, b: null, nextKey: null, nextSlot: null, loserNextKey: null, loserNextSlot: null, after: [`k${rounds - 1}-1`, `k${rounds - 1}-2`], bye: false });
  }
  return out;
}

interface Played {
  key: string;
  bracket: string;
  round: number;
  a: number;
  b: number;
  winner: number;
}

/**
 * Play an event on paper: byes through, then each match whose two sides are known, in the order they become known, the
 * side `aWins` says winning. Checks the invariants of G3 after every step, and returns what was played.
 */
function playOn(matches: PlannedMatch[], aWins: (m: PlannedMatch, step: number) => boolean, verify = true) {
  const state = new Map(matches.map((m) => [m.key, { a: m.a, b: m.b, done: false, winner: null as number | null }]));
  const by = new Map(matches.map((m) => [m.key, m]));
  const send = (key: string | null, slot: "a" | "b" | null, entry: number | null) => {
    if (key && slot) state.get(key)![slot] = entry;
  };
  for (const m of matches.filter((x) => x.bye)) {
    const s = state.get(m.key)!;
    s.done = true;
    s.winner = (s.a ?? s.b)!;
    send(m.nextKey, m.nextSlot, s.winner);
  }
  const played: Played[] = [];
  const checkOnePlace = () => {
    // G3: nobody is in two matches still to play.
    const seen = new Set<number>();
    for (const [key, s] of state) {
      if (s.done) continue;
      for (const e of [s.a, s.b]) {
        if (e === null) continue;
        expect(seen.has(e), `entrant ${e} in two matches still to play (${key})`).toBe(false);
        seen.add(e);
      }
    }
  };
  for (let step = 0; step < 1000; step++) {
    if (verify) checkOnePlace();
    const m = matches.find((x) => !state.get(x.key)!.done && state.get(x.key)!.a !== null && state.get(x.key)!.b !== null);
    if (!m) break;
    const s = state.get(m.key)!;
    if (verify) expect(s.a).not.toBe(s.b);
    const winner = aWins(m, step) ? s.a! : s.b!;
    const loser = winner === s.a ? s.b! : s.a!;
    s.done = true;
    s.winner = winner;
    played.push({ key: m.key, bracket: m.bracket, round: m.round, a: s.a!, b: s.b!, winner });
    // The winners' champion winning the grand final makes the reset not needed (E4, P5): nobody is sent to it.
    if (m.key === "gf" && winner === s.a) continue;
    send(m.nextKey, m.nextSlot, winner);
    send(m.loserNextKey, m.loserNextSlot, loser);
  }
  const left = matches.filter((m) => !state.get(m.key)!.done);
  return { played, left, state, by };
}

function seeded(seed: number) {
  let x = seed;
  return () => {
    x = (x * 1664525 + 1013904223) % 4294967296;
    return x / 4294967296;
  };
}

const entrantsOf = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

/** Every side of every match has exactly one source: an entrant, or a route into it. No side that cannot be explained (G3). */
function explained(matches: PlannedMatch[], extra: Map<string, { key: string; slot: "a" | "b" }> = new Map()) {
  const fed = new Map<string, number>();
  const feed = (key: string | null, slot: "a" | "b" | null) => {
    if (key && slot) fed.set(`${key}:${slot}`, (fed.get(`${key}:${slot}`) ?? 0) + 1);
  };
  for (const m of matches) {
    feed(m.nextKey, m.nextSlot);
    feed(m.loserNextKey, m.loserNextSlot);
  }
  for (const to of extra.values()) feed(to.key, to.slot);
  for (const m of matches) {
    for (const slot of ["a", "b"] as const) {
      const entry = m[slot];
      const routes = fed.get(`${m.key}:${slot}`) ?? 0;
      if (m.bye) continue;
      expect(entry !== null ? 1 : 0 + routes, `${m.key} side ${slot}`).toBe(1);
      expect(entry !== null && routes > 0, `${m.key} ${slot} has an entrant and a route`).toBe(false);
    }
  }
}

describe("a double elimination's structure (ADR 0032, E)", () => {
  for (const n of [3, 4, 5, 6, 7, 8, 9, 12, 16, 17, 24, 31, 32, 33, 64, 100, 128]) {
    it(`E1 E2 E5, G3: ${n} entries are 2n-2 matches, every side explained, everybody's path ends`, () => {
      const size = bracketSize(n);
      const plan = doubleElimination(size, firstRound(entrantsOf(n)), true);
      const real = plan.filter((m) => !m.bye && !m.reset);
      expect(real.filter((m) => m.bracket === "winners")).toHaveLength(n - 1);
      expect(real.filter((m) => m.bracket === "losers")).toHaveLength(n - 2);
      expect(real.filter((m) => m.bracket === "grand")).toHaveLength(1);
      expect(plan.filter((m) => m.reset)).toHaveLength(1);
      explained(plan);
      // Keys and positions are unique, positions are counted from 1 in each bracket round.
      expect(new Set(plan.map((m) => m.key)).size).toBe(plan.length);
      for (const [bracket, round] of Array.from(new Set(plan.map((m) => `${m.bracket}:${m.round}`)), (x) => x.split(":"))) {
        const here = plan.filter((m) => m.bracket === bracket && m.round === Number(round)).map((m) => m.position);
        expect(here.sort((x, y) => x - y)).toEqual(here.map((_, i) => i + 1));
      }
      // Every route leads to a match made, and nobody is routed to a match before it can be played (`after` has every feeder).
      const keys = new Set(plan.map((m) => m.key));
      for (const m of plan) {
        for (const to of [m.nextKey, m.loserNextKey]) if (to) expect(keys.has(to)).toBe(true);
        for (const a of m.after) expect(keys.has(a)).toBe(true);
      }
      // Played on paper, higher seeds winning (a); the reset, when the losers' champion wins, is played too.
      for (const aWins of [() => true, () => false, (m: PlannedMatch, step: number) => (m.key.length + step) % 3 !== 0]) {
        const r = playOn(plan, aWins);
        const unplayed = r.left.filter((m) => !m.reset);
        expect(unplayed, `left unplayed: ${unplayed.map((m) => m.key)}`).toHaveLength(0);
        const reset = r.played.some((p) => p.key === "gf2");
        const gf = r.played.find((p) => p.key === "gf")!;
        // E4: the reset is played exactly when the losers' bracket's champion (the grand final's second side) won the grand final.
        expect(reset).toBe(gf.winner === gf.b);
        expect(r.played).toHaveLength(2 * n - 2 + (reset ? 1 : 0));
      }
    });
  }

  it("E4: with the reset off there is no reset match, and the grand final's winner is champion", () => {
    const plan = doubleElimination(8, firstRound(entrantsOf(8)), false);
    expect(plan.find((m) => m.key === "gf2")).toBeUndefined();
    expect(plan.find((m) => m.key === "gf")).toMatchObject({ nextKey: null, loserNextKey: null });
    const withReset = doubleElimination(8, firstRound(entrantsOf(8)), true);
    expect(withReset.find((m) => m.key === "gf")).toMatchObject({ nextKey: "gf2", nextSlot: "a", loserNextKey: "gf2", loserNextSlot: "b" });
  });

  it("D3: a bye leaves no loser, so a losers' match with nobody to meet is not made, and its one source goes straight on", () => {
    // Three entries: seed 1 has the bye; the one first-round match's loser goes straight to the second losers' round.
    const plan = doubleElimination(4, firstRound([1, 2, 3]), true);
    expect(plan.map((m) => m.key)).toEqual(["w1-1", "w1-2", "w2-1", "l2-1", "gf", "gf2"]);
    expect(plan.find((m) => m.key === "w1-2")).toMatchObject({ loserNextKey: "l2-1", loserNextSlot: "a" });
    expect(plan.find((m) => m.key === "w2-1")).toMatchObject({ loserNextKey: "l2-1", loserNextSlot: "b" });
    expect(plan.find((m) => m.key === "w1-1")).toMatchObject({ bye: true, loserNextKey: null });
  });

  it("E3: nobody meets, in their first two losers' matches, a player they have already played (every outcome for 8, sampled for 16 and 32)", () => {
    const check = (n: number, outcome: (m: PlannedMatch, step: number) => boolean) => {
      const plan = doubleElimination(bracketSize(n), firstRound(entrantsOf(n)), true);
      const r = playOn(plan, outcome, false);
      const met = new Set<string>();
      for (const p of r.played) {
        const pair = [p.a, p.b].sort((x, y) => x - y).join("-");
        if (p.bracket === "losers" && p.round <= 2) expect(met.has(pair), `${n} entries: ${p.key} is a rematch of ${pair}`).toBe(false);
        met.add(pair);
      }
    };
    for (const n of [5, 6, 7, 8])
      for (let bits = 0; bits < 2 ** 14; bits++) check(n, (_m, step) => ((bits >> (step % 14)) & 1) === 1);
    const random = seeded(7);
    for (const n of [9, 12, 15, 16, 17, 24, 31, 32])
      for (let i = 0; i < 200; i++) check(n, () => random() < 0.5);
  });

  it("E3: the drop order is reversed into the second losers' round and in order into the fourth", () => {
    const plan = doubleElimination(16, firstRound(entrantsOf(16)), true);
    // 4 matches in winners' round 2 drop into losers' round 2 reversed; 2 in round 3 drop into round 4 in order.
    expect(plan.find((m) => m.key === "w2-1")).toMatchObject({ loserNextKey: "l2-4" });
    expect(plan.find((m) => m.key === "w2-4")).toMatchObject({ loserNextKey: "l2-1" });
    expect(plan.find((m) => m.key === "w3-1")).toMatchObject({ loserNextKey: "l4-1" });
    expect(plan.find((m) => m.key === "w3-2")).toMatchObject({ loserNextKey: "l4-2" });
    expect(plan.find((m) => m.key === "w4-1")).toMatchObject({ loserNextKey: "l6-1" });
  });
});

describe("a first-round consolation draw's structure (ADR 0032, C)", () => {
  const build = (n: number, third = false, mainThird = false) => {
    const size = bracketSize(n);
    const pairs = firstRound(entrantsOf(n));
    const main = mainKnockout(size, pairs, mainThird);
    const cons = consolationDraw(size, pairs, third);
    if (cons) {
      for (const [key, to] of cons.losersTo) {
        const from = main.find((m) => m.key === key)!;
        from.loserNextKey = to.key;
        from.loserNextSlot = to.slot;
      }
    }
    return { size, pairs, main, cons, all: [...main, ...(cons?.matches ?? [])] };
  };

  it("C2: none below a main draw of 8 or from fewer than two first-round matches played", () => {
    for (const n of [2, 3, 4, 5]) expect(build(n).cons, `${n} entries`).toBeNull();
    for (const n of [6, 7, 8, 10, 16, 18, 31]) expect(build(n).cons, `${n} entries`).not.toBeNull();
    // One first-round match played (a main draw's size plus one entry): no consolation draw.
    for (const n of [9, 17, 33, 65]) expect(build(n).cons, `${n} entries`).toBeNull();
  });

  for (const n of [6, 7, 8, 10, 11, 12, 13, 15, 16, 18, 20, 23, 25, 31, 32, 34, 48, 64, 66, 100, 128]) {
    it(`C1 C3 C5 C6, G3: ${n} entries: the first-round losers played, and only they, are in it; M-1 matches; every side explained`, () => {
      const { size, pairs, main, cons, all } = build(n);
      const played = pairs.filter((p) => p[0] !== null && p[1] !== null).length;
      expect(played).toBe(n - size / 2);
      explained(all, new Map());
      const consMatches = cons!.matches.filter((m) => !m.placement);
      expect(consMatches).toHaveLength(played - 1);
      expect(main.filter((m) => !m.bye && m.placement === undefined)).toHaveLength(n - 1);
      // Each first-round match played sends its loser into the consolation draw, and only those do.
      const toCons = main.filter((m) => m.loserNextKey && m.loserNextKey.startsWith("c"));
      expect(toCons.map((m) => m.key).sort()).toEqual(main.filter((m) => m.round === 1 && !m.bye).map((m) => m.key).sort());
      expect(cons!.losersTo.size).toBe(played);
      for (const aWins of [() => true, () => false, (_m: PlannedMatch, step: number) => step % 2 === 0]) {
        const r = playOn(all, aWins);
        expect(r.left).toHaveLength(0);
        // C6: nobody is in the main draw and the consolation draw both: a first-round loser never plays a main-draw match after.
        const lost = new Set(r.played.filter((p) => p.bracket === "main" && p.round === 1).map((p) => (p.winner === p.a ? p.b : p.a)));
        for (const p of r.played.filter((x) => x.bracket === "main" && x.round > 1)) {
          expect(lost.has(p.a)).toBe(false);
          expect(lost.has(p.b)).toBe(false);
        }
        const inCons = new Set(r.played.filter((p) => p.bracket === "consolation").flatMap((p) => [p.a, p.b]));
        expect([...inCons].sort((x, y) => x - y)).toEqual([...lost].sort((x, y) => x - y));
      }
    });
  }

  it("C3: lines are seeded by how close the matches were, the closest (whose loser is expected strongest) first, and byes go to the top lines", () => {
    // 8 lines, all played: the consolation's first round pairs seeds 1 v 4 and 2 v 3 (seedOrder(4)); seed 1 is the loser of the closest match, 4 v 5.
    const { cons } = build(8);
    expect(cons!.losersTo.get("k1-2")).toEqual({ key: "c1-1", slot: "a" });
    expect(cons!.losersTo.get("k1-1")).toEqual({ key: "c1-1", slot: "b" });
    // 7 entries: three first-round matches played, 4 lines, line 1 has a bye, so its loser goes straight to the final.
    const seven = build(7);
    const byeLine = [...seven.cons!.losersTo].filter(([, to]) => to.key === seven.cons!.matches.find((m) => m.round === 2)!.key);
    expect(byeLine).toHaveLength(1);
    expect(seven.cons!.matches.map((m) => m.key)).toEqual(["c1-2", "c2-1"]);
  });

  it("C4: a consolation third-place match exists only where both consolation semi-finals are matches played", () => {
    const keys = (n: number) => build(n, true).cons!.matches.filter((m) => m.placement === 3).length;
    // 12 entries: 8 lines, 4 first-round matches played; the consolation has four lines: two semi-finals.
    expect(keys(12)).toBe(1);
    // 11 entries: 3 played, 4 lines, one semi-final only: none.
    expect(keys(11)).toBe(0);
    // 6 entries: one consolation match (the final): none.
    expect(keys(6)).toBe(0);
    // 20 entries: 8 first-round matches... always where there are eight or more lines.
    expect(keys(24)).toBe(1);
    const third = build(12, true).cons!.matches.find((m) => m.placement === 3)!;
    expect(third.after).toHaveLength(2);
    expect(third).toMatchObject({ bracket: "consolation", nextKey: null });
  });

  it("the main draw keeps its third-place match beside a consolation draw", () => {
    const { main, cons } = build(16, true, true);
    expect(main.find((m) => m.key === "k3p")).toBeTruthy();
    expect(cons!.matches.find((m) => m.key === "c3p")).toBeTruthy();
    // Semi-finals send their losers to the third-place match, first-round matches to the consolation draw: never the same route.
    for (const m of main) if (m.loserNextKey) expect(m.round === 1 ? m.loserNextKey.startsWith("c") : m.loserNextKey === "k3p").toBe(true);
  });
});

describe("placings (ADR 0032, F)", () => {
  const places = (list: PlannedMatch[], aWins: (m: PlannedMatch, step: number) => boolean) => {
    const r = playOn(list, aWins);
    const asMatches: PlacingMatch[] = list.map((m) => {
      const s = r.state.get(m.key)!;
      const done = s.done && !m.bye;
      return {
        bracket: m.bracket,
        round: m.round,
        placement: m.placement ?? null,
        a: s.a,
        b: s.b,
        winner: s.winner,
        status: m.bye ? "bye" : done ? "done" : m.reset ? "bye" : "scheduled",
      };
    });
    return placings(asMatches);
  };

  it("F2: a knockout of 8: champion, runner-up, joint third (no third-place match), joint fifth to eighth", () => {
    const list = mainKnockout(8, firstRound(entrantsOf(8)));
    const p = places(list, () => true)!;
    expect(p.map((x) => x.place)).toEqual([1, 2, 3, 3, 5, 5, 5, 5]);
    expect(p[0].entryId).toBe(1);
  });

  it("F2: a third-place match separates third and fourth", () => {
    const list = mainKnockout(8, firstRound(entrantsOf(8)), true);
    const p = places(list, () => true)!;
    expect(p.map((x) => x.place)).toEqual([1, 2, 3, 4, 5, 5, 5, 5]);
  });

  it("F2: with a consolation draw the main draw's places come first, then the consolation draw's; everybody is placed once", () => {
    for (const n of [6, 8, 11, 16, 21]) {
      const size = bracketSize(n);
      const pairs = firstRound(entrantsOf(n));
      const main = mainKnockout(size, pairs);
      const cons = consolationDraw(size, pairs, true)!;
      for (const [key, to] of cons.losersTo) {
        const from = main.find((m) => m.key === key)!;
        from.loserNextKey = to.key;
        from.loserNextSlot = to.slot;
      }
      const p = places([...main, ...cons.matches], () => true)!;
      expect(p.map((x) => x.entryId).sort((x, y) => x - y)).toEqual(entrantsOf(n));
      // Those who won a first-round match or had a bye (the main draw's second round on) are placed above the first-round losers.
      const second = main.filter((m) => m.round === 2).length * 2;
      const mainPlaces = p.filter((x) => x.place <= second);
      expect(mainPlaces.length).toBe(second);
      expect(p[0].place).toBe(1);
      expect(Math.min(...p.slice(second).map((x) => x.place))).toBe(second + 1);
    }
  });

  it("F3: a double elimination: champion and runner-up, then the losers' bracket's last round first; the reset decides when it was played", () => {
    const plan = doubleElimination(8, firstRound(entrantsOf(8)), true);
    // Winners' champion (seed 1) wins everything.
    const chalk = places(plan, () => true)!;
    expect(chalk.slice(0, 2)).toEqual([
      { entryId: 1, place: 1 },
      { entryId: expect.any(Number), place: 2 },
    ]);
    expect(chalk.map((x) => x.place)).toEqual([1, 2, 3, 4, 5, 5, 7, 7]);
    // The losers' champion wins the grand final and then the reset: champion is whoever won the reset.
    const upset = places(plan, (m) => (m.bracket === "grand" ? false : true))!;
    expect(upset).toHaveLength(8);
    expect(upset[0].place).toBe(1);
  });

  it("F1: none while any match is still to play", () => {
    expect(placings([{ bracket: "main", round: 1, placement: null, a: 1, b: 2, winner: null, status: "scheduled" }])).toBeNull();
  });
});

describe("naming a match (T2)", () => {
  it("says what a match in each bracket is, from the end of its own bracket", () => {
    const plan = doubleElimination(8, firstRound(entrantsOf(8)), true);
    const rounds = roundsByBracket(plan);
    const label = (key: string) => {
      const m = plan.find((x) => x.key === key)!;
      return matchLabel({ stage: "knockout", groupNo: null, round: m.round, placement: m.placement ?? null, bracket: m.bracket }, rounds.get(m.bracket)!);
    };
    expect(label("w1-1")).toEqual({ key: "fm1.winnersRound", n: 1 });
    expect(label("w3-1")).toEqual({ key: "fm1.winnersFinal" });
    expect(label("l2-1")).toEqual({ key: "fm1.losersRound", n: 2 });
    expect(label("l4-1")).toEqual({ key: "fm1.losersFinal" });
    expect(label("gf")).toEqual({ key: "fm1.grandFinal" });
    expect(label("gf2")).toEqual({ key: "fm1.reset" });
    expect(seedOrder(4)).toEqual([1, 4, 2, 3]);
  });
});
