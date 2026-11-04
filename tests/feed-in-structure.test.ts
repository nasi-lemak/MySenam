import { describe, expect, it } from "vitest";
import { bracketSize, feedInConsequences, feedInConsolation, feedInPreview, firstRound, placings, type PlacingMatch } from "../src/lib/brackets";

/**
 * The feed-in consolation draw as a pure structure (ADR 0034, rules G, C, M, F), apart from the database: the count of matches by
 * size, who feeds each side, who a player can meet, the most matches one entrant can play, and the places. Whole events are played
 * through the graph, every outcome for the small fields.
 */

const minutes = { knockout: 30, final: 30, consolation: 30 };

interface Node {
  key: string;
  bracket: "main" | "consolation";
  round: number;
  placement: 3 | null;
  next: string | null;
  nextSlot: "a" | "b" | null;
  loserNext: string | null;
  loserSlot: "a" | "b" | null;
  /** Entrants: set at the draw in a first round, else by the routes. */
  a: number | null;
  b: number | null;
  bye: boolean;
}

/** The whole event as the draw makes it: the main draw as the knockout does, and the planned consolation draw, in an order where every feeder comes first. */
function event(n: number, third = false): { nodes: Node[]; plan: ReturnType<typeof feedInConsolation> } {
  const size = bracketSize(n);
  const pairs = firstRound(Array.from({ length: n }, (_, i) => i + 1));
  const plan = feedInConsolation(size, pairs, third);
  const k = Math.log2(size);
  const nodes: Node[] = [];
  for (let r = 1; r <= k; r++)
    for (let p = 1; p <= size / 2 ** r; p++) {
      const pair = r === 1 ? pairs[p - 1] : null;
      nodes.push({
        key: `k${r}-${p}`,
        bracket: "main",
        round: r,
        placement: null,
        next: r < k ? `k${r + 1}-${Math.ceil(p / 2)}` : null,
        nextSlot: r < k ? (p % 2 === 1 ? "a" : "b") : null,
        loserNext: plan?.losersTo.get(`k${r}-${p}`)?.key ?? null,
        loserSlot: plan?.losersTo.get(`k${r}-${p}`)?.slot ?? null,
        a: pair ? pair[0] : null,
        b: pair ? pair[1] : null,
        bye: pair !== null && (pair[0] === null) !== (pair[1] === null),
      });
    }
  for (const m of plan?.matches ?? [])
    nodes.push({ key: m.key, bracket: "consolation", round: m.round, placement: m.placement ?? null, next: m.nextKey, nextSlot: m.nextSlot, loserNext: m.loserNextKey, loserSlot: m.loserNextSlot, a: null, b: null, bye: false });
  return { nodes, plan };
}

/** Play an event through its graph: `pick` says which side wins each match played, by its order. Returns who met whom, in order, and each entrant's matches. */
function play(n: number, third: boolean, pick: (index: number, a: number, b: number) => 0 | 1) {
  const { nodes } = event(n, third);
  const sides = new Map(nodes.map((m) => [m.key, { a: m.a, b: m.b }]));
  const meetings: { key: string; bracket: string; round: number; a: number; b: number; winner: number }[] = [];
  const played = new Map<number, number>();
  const result = new Map<string, { winner: number | null; loser: number | null }>();
  let index = 0;
  for (const m of nodes) {
    const s = sides.get(m.key)!;
    if (m.bye) {
      const through = s.a ?? s.b;
      result.set(m.key, { winner: through, loser: null });
      if (m.next) sides.get(m.next)![m.nextSlot!] = through;
      continue;
    }
    if (s.a === null || s.b === null) throw new Error(`${m.key} has a side nobody fills (${s.a} v ${s.b})`);
    const winner = pick(index++, s.a, s.b) === 0 ? s.a : s.b;
    const loser = winner === s.a ? s.b : s.a;
    meetings.push({ key: m.key, bracket: m.bracket, round: m.round, a: s.a, b: s.b, winner });
    for (const e of [s.a, s.b]) played.set(e, (played.get(e) ?? 0) + 1);
    result.set(m.key, { winner, loser });
    if (m.next) sides.get(m.next)![m.nextSlot!] = winner;
    if (m.loserNext) sides.get(m.loserNext)![m.loserSlot!] = loser;
  }
  return { nodes, meetings, played, result };
}

describe("the structure (G, C, M)", () => {
  it("M1: the match counts: the main draw n-1, the consolation draw n-3 (n-2 entrants, one champion), n-2 with its third-place match where both consolation semi-finals are played; 2n-4 in all", () => {
    for (let n = 5; n <= 64; n++) {
      const plain = feedInConsequences(n, false, minutes)!;
      expect(plain.mainMatches, `n=${n}`).toBe(n - 1);
      expect(plain.consolationMatches, `n=${n}`).toBe(n - 3);
      expect(plain.totalMatches, `n=${n}`).toBe(2 * n - 4);
      expect(plain.consolationEntrants, `n=${n}`).toBe(n - 2);
      const third = feedInConsequences(n, true, minutes)!;
      expect(third.consolationMatches - plain.consolationMatches, `n=${n}`).toBe(feedInConsolation(bracketSize(n), firstRound(Array.from({ length: n }, (_, i) => i + 1)), true)!.matches.filter((m) => m.placement === 3).length);
      expect([0, 1]).toContain(third.consolationMatches - plain.consolationMatches);
    }
    expect(feedInConsequences(128, false, minutes)).toMatchObject({ mainMatches: 127, consolationMatches: 125, totalMatches: 252 });
  });

  it("M2: there is none below five entries (a main draw below eight lines), and from five there always is", () => {
    for (const n of [2, 3, 4]) expect(feedInConsequences(n, false, minutes), `n=${n}`).toBeNull();
    expect(feedInConsolation(4, [[1, 4], [2, 3]], false)).toBeNull();
    for (let n = 5; n <= 40; n++) expect(feedInConsolation(bracketSize(n), firstRound(Array.from({ length: n }, (_, i) => i + 1)), false), `n=${n}`).not.toBeNull();
  });

  it("G1: every side of every match has exactly one source; each main match but the final and the byes sends its loser on, once; the winners' route is the knockout's", () => {
    for (let n = 5; n <= 40; n++) {
      for (const third of [false, true]) {
        const { nodes } = event(n, third);
        const feeders = new Map<string, string[]>();
        const add = (to: string, slot: string, from: string) => feeders.set(`${to}:${slot}`, [...(feeders.get(`${to}:${slot}`) ?? []), from]);
        for (const m of nodes) {
          if (m.next) add(m.next, m.nextSlot!, `${m.key} win`);
          if (m.loserNext) add(m.loserNext, m.loserSlot!, `${m.key} lose`);
        }
        for (const [slot, from] of feeders) expect(from, `n=${n} ${slot}`).toHaveLength(1);
        for (const m of nodes.filter((x) => x.bracket === "consolation"))
          for (const slot of ["a", "b"]) expect(feeders.has(`${m.key}:${slot}`), `n=${n} ${m.key} ${slot} has no source`).toBe(true);
        const main = nodes.filter((m) => m.bracket === "main");
        const rounds = Math.max(...main.map((m) => m.round));
        for (const m of main) {
          const sends = m.bye || m.round === rounds ? false : true;
          expect(m.loserNext !== null, `n=${n} ${m.key}`).toBe(sends);
        }
      }
    }
  });

  it("C1: consolation round 1 pairs the first round's losers, a drop round has the previous survivor play the loser of main round r, and the last round is the consolation final", () => {
    const { plan } = event(16, true);
    const keys = plan!.matches.map((m) => `${m.round}:${m.position}${m.placement ? "p" : ""}`);
    // k = 4 rounds: consolation rounds 1 (4 matches), 2 (4: drop of main round 2), 3 (2), 4 (2: drop of main round 3), 5 (final + third place).
    expect(keys).toEqual(["1:1", "1:2", "1:3", "1:4", "2:1", "2:2", "2:3", "2:4", "3:1", "3:2", "4:1", "4:2", "5:1", "5:2p"]);
    const into = (key: string) => [...plan!.losersTo].filter(([, to]) => to.key === key).map(([from]) => from);
    expect(into("c1-1").sort()).toEqual(["k1-1", "k1-2"]);
    // Main round 2 is even: its losers drop reversed, so position p of the drop round gets main match m+1-p.
    expect(into("c2-1")).toEqual(["k2-4"]);
    expect(into("c2-4")).toEqual(["k2-1"]);
    // Main round 3 (odd): in order. The semi-finals (round 3 of 4) are the last drop; the final's loser goes nowhere.
    expect(into("c4-1")).toEqual(["k3-1"]);
    expect(into("c4-2")).toEqual(["k3-2"]);
    expect([...plan!.losersTo.keys()].includes("k4-1")).toBe(false);
    const final = plan!.matches.find((m) => m.round === 5 && !m.placement)!;
    const thirdPlace = plan!.matches.find((m) => m.placement === 3)!;
    expect(final.after.sort()).toEqual(["c4-1", "c4-2"]);
    expect(thirdPlace.after.sort()).toEqual(["c4-1", "c4-2"]);
    expect(plan!.matches.find((m) => m.key === "c4-1")).toMatchObject({ nextKey: final.key, loserNextKey: thirdPlace.key });
  });

  it("M3: the court time: each match at its stage's length, the extra hours are the consolation draw's", () => {
    const c = feedInConsequences(16, false, { knockout: 30, final: 45, consolation: 20 })!;
    expect(c.mainMinutes).toBe(14 * 30 + 45);
    expect(c.consolationMinutes).toBe(13 * 20);
    expect(c.totalMinutes).toBe(c.mainMinutes + c.consolationMinutes);
    const held = feedInPreview({ matchMinutes: 30, stageMinutes: { final: 45, consolation: 20 }, courts: 2, days: 1, startMin: 9 * 60, endMin: 21 * 60, maxEntries: 40, entered: 16 }, false);
    expect(held).toMatchObject({ entries: 16, heldMinutes: 2 * 12 * 60, needMinutes: c.totalMinutes, fitsHeld: true });
    // Too little time held is said so, and fewer than five entered counts the most it takes.
    expect(feedInPreview({ matchMinutes: 60, stageMinutes: {}, courts: 1, days: 1, startMin: 9 * 60, endMin: 13 * 60, maxEntries: 16, entered: 2 }, false)).toMatchObject({ entries: 16, fitsHeld: false });
  });
});

describe("events played through the graph (G3, E3-style, M)", () => {
  it("G3 M1: every outcome of fields of 5 to 8 (and of 9 with a third place): nobody is in two matches at once, every side is filled, every loser but the runner-up plays on, the count is 2n-4, nobody plays more than the most", () => {
    for (const n of [5, 6, 7, 8]) {
      const total = 2 * n - 4;
      for (let mask = 0; mask < 2 ** total; mask++) {
        const { meetings, played, result, nodes } = play(n, false, (i) => (((mask >> i) & 1) as 0 | 1));
        expect(meetings, `n=${n} mask=${mask}`).toHaveLength(total);
        const finalKey = `k${Math.log2(bracketSize(n))}-1`;
        const runnerUp = result.get(finalKey)!.loser!;
        // Everybody who lost a main match played, other than the runner-up, is in a consolation match.
        const inConsolation = new Set(meetings.filter((m) => m.bracket === "consolation").flatMap((m) => [m.a, m.b]));
        for (const m of meetings.filter((x) => x.bracket === "main" && x.key !== finalKey)) {
          const loser = m.winner === m.a ? m.b : m.a;
          expect(inConsolation.has(loser), `n=${n} mask=${mask} loser of ${m.key}`).toBe(true);
        }
        expect(inConsolation.has(runnerUp)).toBe(false);
        expect(Math.max(...played.values())).toBeLessThanOrEqual(feedInConsequences(n, false, minutes)!.mostMatches);
        expect(nodes.length).toBeGreaterThan(0);
      }
    }
    for (let mask = 0; mask < 2 ** 8; mask++) {
      const { meetings } = play(9, true, (i) => (((mask * 2654435761) >>> i) & 1) as 0 | 1);
      expect(meetings).toHaveLength(feedInConsequences(9, true, minutes)!.totalMatches);
    }
  });

  it("M4: the most matches one entrant can play is reached by some outcome, and no outcome exceeds it", () => {
    for (const n of [5, 6, 7, 8]) {
      let most = 0;
      for (let mask = 0; mask < 2 ** (2 * n - 4); mask++) most = Math.max(most, ...play(n, false, (i) => (((mask >> i) & 1) as 0 | 1)).played.values());
      expect(most, `n=${n}`).toBe(feedInConsequences(n, false, minutes)!.mostMatches);
    }
    // Sampled for larger fields: always at most the bound, and by always sending the same side the bound is met.
    for (const n of [12, 16, 17, 31, 33, 64]) {
      const bound = feedInConsequences(n, false, minutes)!.mostMatches;
      for (const pick of [() => 0 as const, () => 1 as const, (i: number) => (i % 2) as 0 | 1, (i: number) => ((i * 7) % 3 === 0 ? 1 : 0) as 0 | 1]) {
        const { played, meetings } = play(n, false, pick);
        expect(Math.max(...played.values()), `n=${n}`).toBeLessThanOrEqual(bound);
        expect(meetings).toHaveLength(2 * n - 4);
      }
    }
  });

  it("E3: in consolation rounds 1 and 2 nobody meets a player they have already played, wherever the byes fall (every outcome of 5 to 8, sampled for 9 to 32)", () => {
    const check = (n: number, pick: (i: number, a: number, b: number) => 0 | 1) => {
      const { meetings } = play(n, false, pick);
      const met = new Set<string>();
      const key = (x: number, y: number) => `${Math.min(x, y)}-${Math.max(x, y)}`;
      for (const m of meetings) {
        if (m.bracket === "consolation" && m.round <= 2) expect(met.has(key(m.a, m.b)), `n=${n} ${m.key}: ${m.a} v ${m.b} met before`).toBe(false);
        met.add(key(m.a, m.b));
      }
    };
    for (const n of [5, 6, 7, 8]) for (let mask = 0; mask < 2 ** (2 * n - 4); mask++) check(n, (i) => (((mask >> i) & 1) as 0 | 1));
    for (let n = 9; n <= 32; n++) for (let seed = 1; seed <= 12; seed++) check(n, (i) => ((((i + 3) * seed * 2654435761) >>> 7) & 1) as 0 | 1);
  });

  it("D3: with byes (a field that is not a power of two) every side of every consolation match is still filled, over sampled outcomes of every size to 40", () => {
    for (let n = 5; n <= 40; n++) for (const third of [false, true]) for (let seed = 1; seed <= 4; seed++) expect(() => play(n, third, (i) => ((((i + 1) * seed * 40503) >>> 3) & 1) as 0 | 1)).not.toThrow();
  });
});

describe("the places (F)", () => {
  const asPlacing = (n: number, third: boolean, pick: (i: number, a: number, b: number) => 0 | 1): { matches: PlacingMatch[]; ids: number[] } => {
    const { nodes, result, meetings } = play(n, third, pick);
    const matches: PlacingMatch[] = nodes
      .filter((m) => m.bye || meetings.some((x) => x.key === m.key))
      .map((m) => {
        const r = result.get(m.key)!;
        const meeting = meetings.find((x) => x.key === m.key);
        return { bracket: m.bracket, round: m.round, placement: m.placement, a: meeting?.a ?? null, b: meeting?.b ?? null, winner: r.winner, status: m.bye ? ("bye" as const) : ("done" as const) };
      });
    return { matches, ids: Array.from({ length: n }, (_, i) => i + 1) };
  };

  it("F1 F2: champion and runner-up from the main final, then the consolation draw's own order: its champion third, its runner-up fourth; every entrant has a place", () => {
    for (const n of [5, 6, 7, 8, 9, 12, 16, 17, 33]) {
      for (const third of [false, true]) {
        const { matches, ids } = asPlacing(n, third, (i) => ((i * 5) % 3 === 0 ? 1 : 0));
        const got = placings(matches, { feedIn: true })!;
        expect(got.map((p) => p.entryId).sort((x, y) => x - y), `n=${n}`).toEqual(ids);
        const main = matches.filter((m) => m.bracket === "main" && m.placement === null);
        const mainFinal = main.sort((x, y) => y.round - x.round)[0];
        expect(got[0]).toEqual({ entryId: mainFinal.winner, place: 1 });
        expect(got[1]).toEqual({ entryId: mainFinal.winner === mainFinal.a ? mainFinal.b : mainFinal.a, place: 2 });
        const cons = matches.filter((m) => m.bracket === "consolation" && m.placement === null).sort((x, y) => y.round - x.round);
        const consFinal = cons[0];
        expect(got.find((p) => p.entryId === consFinal.winner)!.place).toBe(3);
        expect(got.find((p) => p.entryId === (consFinal.winner === consFinal.a ? consFinal.b : consFinal.a))!.place).toBe(4);
        // The places are 1, 2, 3, 4 and then levels by how late each was put out, never out of order.
        expect(got.map((p) => p.place)).toEqual([...got.map((p) => p.place)].sort((x, y) => x - y));
      }
    }
  });

  it("F2: with the consolation third-place match, its two take the places after the consolation final; without, the consolation semi-finals' losers are level", () => {
    const withMatch = asPlacing(16, true, (i) => (i % 2) as 0 | 1);
    const third = withMatch.matches.find((m) => m.placement === 3)!;
    const places = placings(withMatch.matches, { feedIn: true })!;
    expect(places.find((p) => p.entryId === third.winner)!.place).toBe(5);
    expect(places.find((p) => p.entryId === (third.winner === third.a ? third.b : third.a))!.place).toBe(6);
    const without = asPlacing(16, false, (i) => (i % 2) as 0 | 1);
    const level = placings(without.matches, { feedIn: true })!.filter((p) => p.place === 5);
    expect(level).toHaveLength(2);
  });

  it("F2: the first-round consolation draw's places are unchanged (the option is read only for a feed-in)", () => {
    const matches: PlacingMatch[] = [
      { bracket: "main", round: 1, placement: null, a: 1, b: 2, winner: 1, status: "done" },
      { bracket: "main", round: 1, placement: null, a: 3, b: 4, winner: 3, status: "done" },
      { bracket: "main", round: 2, placement: null, a: 1, b: 3, winner: 1, status: "done" },
      { bracket: "consolation", round: 1, placement: null, a: 2, b: 4, winner: 2, status: "done" },
    ];
    expect(placings(matches)!.map((p) => p.entryId)).toEqual([1, 3, 2, 4]);
  });
});
