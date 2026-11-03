/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { DEFAULT_SCORING } from "../src/lib/tournament-rules";
import {
  defaultRounds,
  defaultTiebreaks,
  maxRounds,
  metKey,
  pairRound,
  roundsFit,
  seededRandom,
  swissStandings,
  type PairingPlayer,
  type SwissResult,
} from "../src/lib/swiss";

/**
 * Swiss arithmetic apart from the database (ADR 0033): the rounds, the pairing rules and the standings with their
 * tie-breaks, against hand-worked examples and as properties over many sizes and score distributions.
 */

const lcg = (seed: number) => seededRandom(seed);

describe("rounds", () => {
  it("default to the fewest that can leave one unbeaten entrant, and never more than nobody-meets-twice allows", () => {
    expect([2, 3, 4, 5, 8, 9, 16, 17, 32, 33, 64, 128].map(defaultRounds)).toEqual([1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7]);
    expect([4, 5, 8, 9].map(maxRounds)).toEqual([3, 5, 7, 9]);
    for (let n = 4; n <= 128; n++) expect(defaultRounds(n)).toBeLessThanOrEqual(maxRounds(n));
  });

  it("break ties by Buchholz, median Buchholz, then the scoring's own keys but the points", () => {
    expect(defaultTiebreaks(DEFAULT_SCORING)).toEqual(["buchholz", "median_buchholz", "wins", "set_diff", "point_diff", "head_to_head"]);
    expect(defaultTiebreaks({ rankBy: ["points", "point_diff", "points_for", "head_to_head"] })).toEqual(["buchholz", "median_buchholz", "point_diff", "points_for", "head_to_head"]);
  });
});

const players = (...points: number[]): PairingPlayer[] => points.map((p, i) => ({ id: i + 1, points: p, rank: i + 1 }));

describe("pairing a round", () => {
  it("pairs the top half of a score group with the bottom half, the Dutch way: 1 v 5, 2 v 6, 3 v 7, 4 v 8", () => {
    const made = pairRound(players(0, 0, 0, 0, 0, 0, 0, 0), new Set(), new Set())!;
    expect(made.pairs.map((p) => [p.a, p.b].sort((x, y) => x - y))).toEqual([[1, 5], [2, 6], [3, 7], [4, 8]]);
    expect(made.bye).toBeNull();
  });

  it("keeps score groups together, and floats one down only where the group is odd", () => {
    // 1 and 2 on 1 point, 3, 4 and 5 on 0: 1 v 2, then 3 v 4, and 5 has the bye.
    const made = pairRound(players(1, 1, 0, 0, 0), new Set(), new Set())!;
    expect(made.pairs.map((p) => [p.a, p.b].sort((x, y) => x - y))).toEqual([[1, 2], [3, 4]]);
    expect(made.bye!.id).toBe(5);
    // Three on 1, three on 0: the odd one floats down (1 v 2 and 3 v 4 would leave 3 floating: 3 meets the best of the next group).
    const six = pairRound(players(1, 1, 1, 0, 0, 0), new Set(), new Set())!;
    expect(six.pairs.some((p) => p.note.float)).toBe(true);
    expect(six.pairs).toHaveLength(3);
  });

  it("never pairs two who have met, undoing a choice that would leave the rest unpairable", () => {
    // Four players, round 1 was 1v3 and 2v4; the Dutch 1v3 would be a rematch.
    const met = new Set([metKey(1, 3), metKey(2, 4)]);
    const made = pairRound(players(1, 1, 0, 0), met, new Set())!;
    expect(made.pairs.map((p) => [p.a, p.b].sort((x, y) => x - y))).toEqual([[1, 2], [3, 4]]);
    // With only one pairing left that avoids the met pairs, it is the one found even though it is against the preferred order.
    const tight = new Set([metKey(1, 2), metKey(1, 3), metKey(2, 4), metKey(3, 4)]);
    const found = pairRound(players(0, 0, 0, 0), tight, new Set())!;
    expect(found.pairs.map((p) => [p.a, p.b].sort((x, y) => x - y))).toEqual([[1, 4], [2, 3]]);
  });

  it("gives the bye to the lowest-ranked player without one, never a second", () => {
    const made = pairRound(players(2, 1, 1, 0, 0), new Set(), new Set())!;
    expect(made.bye!.id).toBe(5);
    // 5 has had one: the next from the bottom.
    expect(pairRound(players(2, 1, 1, 0, 0), new Set(), new Set([5]))!.bye!.id).toBe(4);
    // Everybody has had one: no legal round.
    expect(pairRound(players(2, 1, 1, 0, 0), new Set(), new Set([1, 2, 3, 4, 5]))).toBeNull();
  });

  it("gives the bye to somebody else where the lowest-ranked would leave the rest unpairable", () => {
    // 1, 2 and 3 have all met each other. With 5 or 4 having the bye the rest cannot be paired; with 3 it can (1 v 4, 2 v 5).
    const met = new Set([metKey(1, 2), metKey(1, 3), metKey(2, 3)]);
    const made = pairRound(players(1, 1, 1, 0, 0), met, new Set())!;
    expect(made.bye!.id).toBe(3);
    for (const p of made.pairs) expect(met.has(metKey(p.a, p.b))).toBe(false);
  });

  it("names first the player who has been first fewer times, the better ranked where level", () => {
    const first = new Map([[1, 2], [2, 0]]);
    const made = pairRound(players(0, 0), new Set(), new Set(), first)!;
    expect(made.pairs[0].a).toBe(2);
    expect(pairRound(players(0, 0), new Set(), new Set())!.pairs[0].a).toBe(1);
  });

  it("is deterministic, whatever order the players are given in", () => {
    const a = pairRound(players(2, 2, 1, 1, 1, 0, 0), new Set([metKey(1, 2)]), new Set([7]));
    const b = pairRound([...players(2, 2, 1, 1, 1, 0, 0)].reverse(), new Set([metKey(1, 2)]), new Set([7]));
    expect(b).toEqual(a);
  });

  it("every player is paired once, nobody meets twice and nobody has two byes, over whole events of many sizes", () => {
    for (let n = 4; n <= 40; n++) {
      const rand = lcg(1000 + n);
      const rounds = Math.min(defaultRounds(n) + 1, maxRounds(n));
      const points = new Map<number, number>(Array.from({ length: n }, (_, i) => [i + 1, 0]));
      const met = new Set<string>();
      const byes = new Set<number>();
      const first = new Map<number, number>();
      for (let r = 1; r <= rounds; r++) {
        const made = pairRound(
          [...points].map(([id, pts]) => ({ id, points: pts, rank: id })),
          met,
          byes,
          first
        );
        expect(made, `n=${n} round ${r}`).not.toBeNull();
        const seen = new Set<number>();
        for (const p of made!.pairs) {
          expect(met.has(metKey(p.a, p.b)), `rematch n=${n} r=${r}`).toBe(false);
          for (const id of [p.a, p.b]) {
            expect(seen.has(id)).toBe(false);
            seen.add(id);
          }
          met.add(metKey(p.a, p.b));
          first.set(p.a, (first.get(p.a) ?? 0) + 1);
          first.set(p.b, (first.get(p.b) ?? 0) - 1);
          const winner = rand() < 0.5 ? p.a : p.b;
          points.set(winner, points.get(winner)! + 1);
        }
        if (made!.bye) {
          expect(byes.has(made!.bye.id)).toBe(false);
          expect(seen.has(made!.bye.id)).toBe(false);
          seen.add(made!.bye.id);
          byes.add(made!.bye.id);
          points.set(made!.bye.id, points.get(made!.bye.id)! + 1);
        }
        expect(seen.size).toBe(n);
        // Floats are rare: the pairing is within a score group wherever the group is even.
        expect(n % 2 === 0 || made!.bye !== null).toBe(true);
      }
    }
  });

  it("prefers the same score group: with every group even, nobody floats", () => {
    const made = pairRound(players(3, 3, 2, 2, 2, 2, 1, 1), new Set(), new Set())!;
    expect(made.pairs.every((p) => !p.note.float)).toBe(true);
  });

  it("gives up honestly: no legal pairing is null, never a rematch", () => {
    const all = new Set<string>();
    for (let x = 1; x <= 4; x++) for (let y = x + 1; y <= 4; y++) all.add(metKey(x, y));
    expect(pairRound(players(0, 0, 0, 0), all, new Set())).toBeNull();
  });
});

const sets = (w: string) => w;
const win = (a: number, b: number | null, winner: number | null, score: string | null = null, status: SwissResult["status"] = "done"): SwissResult => ({ a, b, winner, score, status });
const initial = (...ids: number[]) => new Map(ids.map((id, i) => [id, i + 1]));
const rulesFor = (tiebreaks = defaultTiebreaks(DEFAULT_SCORING), byePoints = 1) => ({ byePoints, tiebreaks });

describe("standings", () => {
  it("rank by points, then Buchholz (the points of the opponents played): a hand-worked table", () => {
    // Round 1: A beat D, B beat C. Round 2: A beat B, C beat D.
    const table = swissStandings(
      [1, 2, 3, 4],
      initial(1, 2, 3, 4),
      [win(1, 4, 1, sets("21-10, 21-12")), win(2, 3, 2, sets("21-15, 21-18")), win(1, 2, 1, sets("21-19, 21-18")), win(3, 4, 3, sets("21-5, 21-5"))],
      DEFAULT_SCORING,
      rulesFor()
    );
    expect(table.map((l) => [l.entryId, l.points, l.buchholz])).toEqual([
      [1, 2, 1], // opponents D (0) and B (1)
      [2, 1, 3], // C (1), A (2)
      [3, 1, 1], // B (1), D (0)
      [4, 0, 3], // A (2), C (1)
    ]);
    expect(table.map((l) => l.rank)).toEqual([1, 2, 3, 4]);
  });

  it("count a bye as the points a win is worth (or what the event sets) and nothing else: no opponent, no difference", () => {
    const results = [win(1, 2, 1, "21-10, 21-10"), win(3, null, 3, null, "bye"), win(1, 3, 3, "21-10, 21-10"), win(2, null, 2, null, "bye")];
    const table = swissStandings([1, 2, 3], initial(1, 2, 3), results, DEFAULT_SCORING, rulesFor());
    const by = new Map(table.map((l) => [l.entryId, l]));
    expect(by.get(3)!.points).toBe(2); // a bye and a win
    expect(by.get(3)!.byes).toBe(1);
    expect(by.get(3)!.buchholz).toBe(1); // the opponent played, not the bye
    expect(by.get(2)!.points).toBe(1);
    const half = swissStandings([1, 2, 3], initial(1, 2, 3), results, DEFAULT_SCORING, rulesFor(undefined, 0));
    expect(half.find((l) => l.entryId === 3)!.points).toBe(1);
  });

  it("take median Buchholz as Buchholz without the highest and lowest opponent, for three or more opponents", () => {
    // Player 1 beat 2, 3 and 4, whose points end 3, 1 and 0 from games among themselves.
    const results = [
      win(1, 2, 1, "21-1, 21-1"),
      win(1, 3, 1, "21-1, 21-1"),
      win(1, 4, 1, "21-1, 21-1"),
      win(2, 3, 2, "21-1, 21-1"),
      win(2, 4, 2, "21-1, 21-1"),
      win(3, 4, 3, "21-1, 21-1"),
    ];
    const table = swissStandings([1, 2, 3, 4], initial(1, 2, 3, 4), results, DEFAULT_SCORING, rulesFor());
    const one = table.find((l) => l.entryId === 1)!;
    expect(one.buchholz).toBe(2 + 1 + 0);
    expect(one.medianBuchholz).toBe(1); // without the 2 and the 0
    // With fewer than three opponents the median is the Buchholz.
    const few = swissStandings([1, 2, 3], initial(1, 2, 3), [win(1, 2, 1, "21-1, 21-1"), win(1, 3, 1, "21-1, 21-1")], DEFAULT_SCORING, rulesFor());
    expect(few.find((l) => l.entryId === 1)!.medianBuchholz).toBe(few.find((l) => l.entryId === 1)!.buchholz);
  });

  it("use the competition rules' own keys after the Swiss ones, and the initial order last, so nothing is left to chance", () => {
    // 1 and 2 each beat a different player and lost to nobody: level on points and Buchholz (both beat a zero); set difference decides.
    const results = [win(1, 3, 1, "21-5, 21-5"), win(2, 4, 2, "21-19, 19-21, 21-19")];
    const bySetDiff = swissStandings([1, 2, 3, 4], initial(1, 2, 3, 4), results, DEFAULT_SCORING, rulesFor(["buchholz", "set_diff"]));
    expect(bySetDiff.map((l) => l.entryId).slice(0, 2)).toEqual([1, 2]);
    // Reverse the initial order and ask for no key that separates them: the initial order settles it.
    const byInitial = swissStandings([1, 2, 3, 4], initial(2, 1, 4, 3), results, DEFAULT_SCORING, rulesFor(["buchholz"]));
    expect(byInitial.map((l) => l.entryId).slice(0, 2)).toEqual([2, 1]);
  });

  it("settle a tie by who beat whom where the event asks for it", () => {
    const results = [win(1, 2, 2, "21-10, 21-10"), win(1, 3, 1, "21-10, 21-10"), win(2, 3, 3, "21-10, 21-10")];
    // Everybody 1-1; Buchholz equal; head to head is a three-way cycle, so the initial order settles it deterministically.
    const table = swissStandings([1, 2, 3], initial(1, 2, 3), results, DEFAULT_SCORING, rulesFor(["buchholz", "head_to_head"]));
    expect(table.map((l) => l.points)).toEqual([1, 1, 1]);
    const again = swissStandings([1, 2, 3], initial(1, 2, 3), results, DEFAULT_SCORING, rulesFor(["buchholz", "head_to_head"]));
    expect(again).toEqual(table);
  });

  it("are a pure function: the same results in any order give the same table", () => {
    const results = [win(1, 4, 1, "21-10, 21-12"), win(2, 3, 2, "21-15, 21-18"), win(1, 2, 1, "21-19, 21-18"), win(3, 4, 3, "21-5, 21-5"), win(5, null, 5, null, "bye")];
    const a = swissStandings([1, 2, 3, 4, 5], initial(1, 2, 3, 4, 5), results, DEFAULT_SCORING, rulesFor());
    const b = swissStandings([5, 4, 3, 2, 1], initial(1, 2, 3, 4, 5), [...results].reverse(), DEFAULT_SCORING, rulesFor());
    expect(b).toEqual(a);
  });

  it("count a draw (where the sport has them) for both, and a walkover as a win", () => {
    const goals = { ...DEFAULT_SCORING, kind: "tally" as const, bestOf: 1, draws: true, tablePoints: { win: 3, draw: 1, loss: 0 }, rankBy: ["points" as const, "point_diff" as const] };
    const table = swissStandings(
      [1, 2, 3, 4],
      initial(1, 2, 3, 4),
      [win(1, 2, null, "2-2"), win(3, 4, 3, null, "walkover")],
      goals,
      rulesFor(["buchholz"], 3)
    );
    const by = new Map(table.map((l) => [l.entryId, l]));
    expect([by.get(1)!.points, by.get(2)!.points, by.get(3)!.points, by.get(4)!.points]).toEqual([1, 1, 3, 0]);
  });
});

describe("fitting the rounds", () => {
  const day = (court: number, date: string) => ({ courtId: court, date, start: 540, end: 1260 });

  it("says whether every round, one after the last ends, fits the time held", () => {
    const windows = [day(1, "2030-01-01"), day(2, "2030-01-01")];
    // 12 hours, two courts, 60-minute matches: 24 matches. 3 rounds of 4 fit; 7 rounds of 4 (28) do not.
    expect(roundsFit(3, 4, 60, windows, { step: 60, origin: 540 })).toBe(true);
    expect(roundsFit(7, 4, 60, windows, { step: 60, origin: 540 })).toBe(false);
    // Rounds are in turn: a round of 4 on two courts takes two hours, so six rounds fill the day exactly.
    expect(roundsFit(6, 4, 60, windows, { step: 60, origin: 540 })).toBe(true);
  });
});

describe("the recorded seed", () => {
  it("gives the same drawn order every time, and a different one for a different seed", () => {
    const order = (seed: number) => {
      const r = seededRandom(seed);
      const xs = [1, 2, 3, 4, 5, 6, 7, 8];
      for (let i = xs.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        [xs[i], xs[j]] = [xs[j], xs[i]];
      }
      return xs;
    };
    expect(order(42)).toEqual(order(42));
    expect(order(42)).not.toEqual(order(43));
  });
});
