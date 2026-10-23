import { describe, expect, it } from "vitest";
import {
  bracketSize,
  firstRound,
  groupCount,
  intoGroups,
  knockoutFromGroups,
  parseScore,
  roundRobin,
  scheduleMatches,
  seedOrder,
  shuffle,
  standings,
} from "../src/lib/brackets";

/** Who meets whom, where byes fall, how groups finish, and fitting matches into court time. */

describe("a knockout", () => {
  it("is a power of two, with seeds spread so the best meet last", () => {
    expect([2, 3, 5, 8, 9].map(bracketSize)).toEqual([2, 4, 8, 8, 16]);
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
    expect(seedOrder(4)).toEqual([1, 4, 2, 3]);
  });

  it("gives the byes to the top seeds", () => {
    expect(firstRound(["A", "B", "C", "D", "E"])).toEqual([
      ["A", null],
      ["D", "E"],
      ["B", null],
      ["C", null],
    ]);
    expect(firstRound(["A", "B"])).toEqual([["A", "B"]]);
  });

  it("draws the unseeded in an order chance decides", () => {
    const fixed = () => 0;
    expect(shuffle([1, 2, 3, 4], fixed)).toEqual([2, 3, 4, 1]);
  });
});

describe("groups", () => {
  it("share the seeds out, snaking", () => {
    expect(intoGroups([1, 2, 3, 4, 5, 6, 7, 8], 2)).toEqual([
      [1, 4, 5, 8],
      [2, 3, 6, 7],
    ]);
    expect(groupCount(10, 4)).toBe(3);
    expect(groupCount(3, 4)).toBe(1);
  });

  it("send their winners and runners-up to opposite halves of the knockout", () => {
    const pairsOf = (w: string[], r: string[]) => firstRound(knockoutFromGroups(w, r));
    expect(pairsOf(["W1", "W2"], ["R1", "R2"])).toEqual([
      ["W1", "R2"],
      ["W2", "R1"],
    ]);
    const four = pairsOf(["W1", "W2", "W3", "W4"], ["R1", "R2", "R3", "R4"]);
    const half = (name: string) => four.findIndex((p) => p.includes(name)) < 2;
    for (const g of [1, 2, 3, 4]) {
      expect(half(`W${g}`)).not.toBe(half(`R${g}`));
      expect(four.some((p) => p.includes(`W${g}`) && p.includes(`R${g}`))).toBe(false);
    }
  });

  it("play everybody once, nobody twice in a round", () => {
    for (const n of [3, 4, 5, 6]) {
      const rounds = roundRobin(n);
      const pairs = rounds.flat().map(([a, b]) => [Math.min(a, b), Math.max(a, b)].join("-"));
      expect(new Set(pairs).size).toBe((n * (n - 1)) / 2);
      for (const round of rounds) {
        const seen = round.flat();
        expect(new Set(seen).size).toBe(seen.length);
      }
    }
  });

  it("finish on wins, then sets, then points, then who beat whom", () => {
    const table = standings(
      [1, 2, 3],
      [
        { a: 1, b: 2, winner: 1, score: "21-10, 21-12" },
        { a: 2, b: 3, winner: 2, score: "21-19, 19-21, 21-19" },
        { a: 3, b: 1, winner: 3, score: "21-5, 21-5" },
      ]
    );
    // Everybody won once; 3 has the best sets and points.
    expect(table.map((s) => s.entryId)).toEqual([3, 1, 2]);
    expect(table[0]).toMatchObject({ played: 2, won: 1, lost: 1, setDiff: 1 });
  });
});

describe("scores", () => {
  it("read as sets", () => {
    expect(parseScore("21-15, 18-21, 21-10")).toMatchObject({ setsA: 2, setsB: 1, pointsA: 60, pointsB: 46 });
    expect(parseScore("6–4; 7:5")).toMatchObject({ setsA: 2, setsB: 0 });
    expect(parseScore("21-21")).toBeNull();
    expect(parseScore("won easily")).toBeNull();
  });
});

describe("scheduling", () => {
  const slots = [
    { courtId: 1, date: "2026-11-01", minute: 540 },
    { courtId: 2, date: "2026-11-01", minute: 540 },
    { courtId: 1, date: "2026-11-01", minute: 600 },
    { courtId: 2, date: "2026-11-01", minute: 600 },
  ];

  it("plays matches side by side, the final after the semis, nobody twice at once", () => {
    const result = scheduleMatches(
      [
        { key: "sf1", sides: ["A", "B"], after: [] },
        { key: "sf2", sides: ["C", "D"], after: [] },
        { key: "final", sides: ["w:sf1", "w:sf2"], after: ["sf1", "sf2"] },
      ],
      slots
    );
    if (!result.ok) throw new Error("did not fit");
    expect(result.placed.get("sf1")).toEqual({ courtId: 1, date: "2026-11-01", minute: 540 });
    expect(result.placed.get("sf2")).toEqual({ courtId: 2, date: "2026-11-01", minute: 540 });
    expect(result.placed.get("final")?.minute).toBe(600);

    const clash = scheduleMatches(
      [
        { key: "x", sides: ["A", "B"], after: [] },
        { key: "y", sides: ["A", "C"], after: [] },
      ],
      slots
    );
    if (!clash.ok) throw new Error("did not fit");
    expect(clash.placed.get("y")?.minute).toBe(600);
  });

  it("says how many did not fit", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ key: `m${i}`, sides: [`a${i}`, `b${i}`], after: [] }));
    expect(scheduleMatches(many, slots)).toEqual({ ok: false, unplaced: 2 });
  });
});
