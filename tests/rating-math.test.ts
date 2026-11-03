import { describe, expect, it } from "vitest";
import {
  DEFAULT_RATING_RULES,
  expectedScore,
  isProvisional,
  kFor,
  levelOfRating,
  marginFactor,
  orderKey,
  readRatingRules,
  replay,
  round2,
  weightOf,
  type ReplayRow,
} from "../src/lib/rating-math";

/**
 * The arithmetic of ratings (lib/rating-math.ts): a published Elo-family rule, a pure function of the rows in their order.
 */

const R = DEFAULT_RATING_RULES;
const key = (i: number) => orderKey({ playedOn: "2026-01-01", playOrder: i, sourceKind: "tournament", sourceId: 1, sourceMatch: i, unitNo: 0 });
const m = (k: string, frozen?: number) => ({ key: k, ...(frozen !== undefined ? { frozen } : {}) });
const row = (i: number, a: string[], b: string[], outcome = 1, extra: Partial<ReplayRow> = {}): ReplayRow => ({
  id: i,
  order: key(i),
  outcome,
  kind: "played",
  margin: null,
  a: a.map((k) => m(k)),
  b: b.map((k) => m(k)),
  ...extra,
});

describe("the published constants", () => {
  it("are fixed and documented: start 1000, K by games played, provisional until 8 counted results", () => {
    expect(R).toMatchObject({ start: 1000, scale: 400, provisionalGames: 8, walkoverWeight: 0, retirementWeight: 0.5, matchBand: 100 });
    expect(R.kBands).toEqual([
      { games: 10, k: 40 },
      { games: 30, k: 24 },
      { games: null, k: 16 },
    ]);
    expect(R.levelFrom).toEqual({ intermediate: 950, advanced: 1100, competitive: 1250 });
  });

  it("K falls as a subject plays: newcomers move faster", () => {
    expect(kFor(R, 0)).toBe(40);
    expect(kFor(R, 9)).toBe(40);
    expect(kFor(R, 10)).toBe(24);
    expect(kFor(R, 29)).toBe(24);
    expect(kFor(R, 30)).toBe(16);
    expect(kFor(R, 500)).toBe(16);
  });

  it("a side expected to win half the time when level, and about 91% when 400 ahead", () => {
    expect(expectedScore(R, 1000, 1000)).toBe(0.5);
    expect(expectedScore(R, 1400, 1000)).toBeCloseTo(0.909, 3);
    expect(expectedScore(R, 1000, 1400) + expectedScore(R, 1400, 1000)).toBeCloseTo(1, 12);
  });

  it("reads the stored rules, with anything missing or out of range as the default", () => {
    expect(readRatingRules(null)).toEqual(R);
    expect(readRatingRules("not json")).toEqual(R);
    expect(readRatingRules("{}")).toEqual(R);
    expect(readRatingRules(JSON.stringify({ start: 1500, provisionalGames: 5, kBands: [{ games: 5, k: 60 }, { games: null, k: 20 }] }))).toMatchObject({
      start: 1500,
      provisionalGames: 5,
      kBands: [{ games: 5, k: 60 }, { games: null, k: 20 }],
    });
    // Out of range, unordered or without an open last band: the default.
    expect(readRatingRules(JSON.stringify({ start: 3, kBands: [{ games: 5, k: 60 }] }))).toEqual(R);
    expect(readRatingRules(JSON.stringify({ levelFrom: { intermediate: 1200, advanced: 1100, competitive: 1300 } })).levelFrom).toEqual(R.levelFrom);
  });

  it("says what level a rating earns, by the published thresholds", () => {
    expect(levelOfRating(R, 900)).toBe("beginner");
    expect(levelOfRating(R, 950)).toBe("intermediate");
    expect(levelOfRating(R, 1100)).toBe("advanced");
    expect(levelOfRating(R, 1250)).toBe("competitive");
  });

  it("weighs a result: played 1, a retirement a half, a walkover nothing; a margin only past one goal", () => {
    expect(weightOf(R, "played")).toBe(1);
    expect(weightOf(R, "retired")).toBe(0.5);
    expect(weightOf(R, "walkover")).toBe(0);
    expect(marginFactor(R, null)).toBe(1);
    expect(marginFactor(R, 0)).toBe(1);
    expect(marginFactor(R, 1)).toBe(1);
    expect(marginFactor(R, 2)).toBe(1.1);
    expect(marginFactor(R, 5)).toBe(1.4);
    expect(marginFactor(R, 40)).toBe(1.4);
    expect(marginFactor({ ...R, margin: { ...R.margin, enabled: false } }, 5)).toBe(1);
  });
});

describe("a known sequence between two players", () => {
  it("moves by K x (result - expected), rounded to two decimals after every game", () => {
    const rows = [row(1, ["user:1"], ["user:2"]), row(2, ["user:1"], ["user:2"]), row(3, ["user:2"], ["user:1"])];
    const out = replay(rows, R);
    // 1: level, so each moves 20.
    expect(out.rows.get(1)!.members.get("a:user:1")).toEqual({ before: 1000, after: 1020, k: 40, gamesBefore: 0 });
    expect(out.rows.get(1)!.members.get("b:user:2")).toEqual({ before: 1000, after: 980, k: 40, gamesBefore: 0 });
    // 2: 1020 v 980: expected 0.5575.
    const e2 = expectedScore(R, 1020, 980);
    expect(out.rows.get(2)!.expectedA).toBeCloseTo(e2, 4);
    expect(out.rows.get(2)!.members.get("a:user:1")!.after).toBe(round2(1020 + 40 * (1 - e2)));
    // 3: player 2 wins at last.
    const afterTwo = { a: out.rows.get(2)!.members.get("a:user:1")!.after, b: out.rows.get(2)!.members.get("b:user:2")!.after };
    const e3 = expectedScore(R, afterTwo.b, afterTwo.a);
    expect(out.rows.get(3)!.members.get("a:user:2")!.after).toBe(round2(afterTwo.b + 40 * (1 - e3)));
    expect(out.subjects.get("user:1")).toMatchObject({ games: 3, wins: 2, losses: 1, draws: 0 });
    expect(out.subjects.get("user:2")).toMatchObject({ games: 3, wins: 1, losses: 2 });
  });

  it("a draw is half a point each: level players do not move, the stronger loses a little", () => {
    const out = replay([row(1, ["user:1"], ["user:2"], 0.5)], R);
    expect(out.subjects.get("user:1")!.rating).toBe(1000);
    expect(out.subjects.get("user:1")!).toMatchObject({ draws: 1, games: 1 });
    const two = replay([row(1, ["user:1"], ["user:2"], 1), row(2, ["user:1"], ["user:2"], 0.5)], R);
    expect(two.subjects.get("user:1")!.rating).toBeLessThan(1020);
    expect(two.subjects.get("user:2")!.rating).toBeGreaterThan(980);
  });

  it("goes from provisional to ranked after the provisional count of results, and K drops after ten", () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(i + 1, ["user:1"], [`user:${i + 10}`]));
    const out = replay(rows, R);
    expect(isProvisional(R, out.rows.get(7)!.members.get("a:user:1")!.gamesBefore + 1)).toBe(true);
    expect(isProvisional(R, out.rows.get(8)!.members.get("a:user:1")!.gamesBefore + 1)).toBe(false);
    expect(out.rows.get(10)!.members.get("a:user:1")!.k).toBe(40);
    expect(out.rows.get(11)!.members.get("a:user:1")!.k).toBe(24);
    expect(out.subjects.get("user:1")!.games).toBe(12);
  });
});

describe("doubles and teams", () => {
  it("a pair rates as the average of its members, and each member moves by their own K", () => {
    // user:1 has a history; user:2 is new; the pair's rating is their average.
    const warm = Array.from({ length: 12 }, (_, i) => row(i + 1, ["user:1"], [`user:${100 + i}`]));
    const pair = row(100, ["user:1", "user:2"], ["user:50", "user:51"], 1);
    const out = replay([...warm, pair], R);
    const o = out.rows.get(100)!;
    const one = out.rows.get(12)!.members.get("a:user:1")!.after;
    expect(o.sideA).toBe(round2((one + 1000) / 2));
    expect(o.sideB).toBe(1000);
    const e = expectedScore(R, o.sideA, o.sideB);
    // user:1 has 12 games (K 24); user:2 has none (K 40).
    expect(o.members.get("a:user:1")!.after).toBe(round2(one + 24 * (1 - e)));
    expect(o.members.get("a:user:2")!.after).toBe(round2(1000 + 40 * (1 - e)));
    expect(o.members.get("b:user:50")!.after).toBe(round2(1000 + 40 * (0 - (1 - e))));
  });

  it("a removed member stands at the rating it had, and never moves", () => {
    const out = replay([{ id: 1, order: key(1), outcome: 1, kind: "played", margin: null, a: [m("user:1")], b: [m("removed:9", 1200)] }], R);
    const o = out.rows.get(1)!;
    expect(o.sideB).toBe(1200);
    expect(o.members.get("b:removed:9")).toMatchObject({ before: 1200, after: 1200 });
    expect(out.subjects.has("removed:9")).toBe(false);
    expect(out.subjects.get("user:1")!.rating).toBeGreaterThan(1020);
  });
});

describe("walkovers, retirements and margins", () => {
  it("a walkover moves nothing and is not counted; a retirement counts half", () => {
    const walk = replay([row(1, ["user:1"], ["user:2"], 1, { kind: "walkover" })], R);
    expect(walk.subjects.get("user:1")).toMatchObject({ rating: 1000, games: 0, wins: 0 });
    expect(walk.subjects.get("user:2")).toMatchObject({ rating: 1000, games: 0, losses: 0 });
    const full = replay([row(1, ["user:1"], ["user:2"], 1)], R).subjects.get("user:1")!.rating;
    const half = replay([row(1, ["user:1"], ["user:2"], 1, { kind: "retired" })], R).subjects.get("user:1")!;
    expect(half.rating).toBe(1010);
    expect(full).toBe(1020);
    expect(half.games).toBe(1);
  });

  it("a bigger winning margin in a tally adds up to 40% to the change", () => {
    const narrow = replay([row(1, ["user:1"], ["user:2"], 1, { margin: 1 })], R).subjects.get("user:1")!.rating;
    const wide = replay([row(1, ["user:1"], ["user:2"], 1, { margin: 5 })], R).subjects.get("user:1")!.rating;
    expect(narrow).toBe(1020);
    expect(wide).toBe(1028);
  });
});

describe("a pure function of the rows in their order", () => {
  /** A small deterministic generator, so the property runs are reproducible. */
  const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

  function randomRows(seed: number, count: number): ReplayRow[] {
    const r = rng(seed);
    const people = Array.from({ length: 8 }, (_, i) => `user:${i + 1}`);
    return Array.from({ length: count }, (_, i) => {
      const doubles = r() < 0.3;
      const pool = [...people].sort(() => r() - 0.5);
      const a = pool.slice(0, doubles ? 2 : 1);
      const b = pool.slice(doubles ? 2 : 1, doubles ? 4 : 2);
      const roll = r();
      const kind = roll < 0.1 ? "walkover" : roll < 0.2 ? "retired" : "played";
      return row(i + 1, a, b, r() < 0.1 ? 0.5 : r() < 0.5 ? 1 : 0, { kind, margin: r() < 0.4 ? Math.floor(r() * 6) : null });
    });
  }

  it("gives the same ratings whatever order the rows are handed over in (determinism)", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const rows = randomRows(seed, 60);
      const shuffled = [...rows].sort(() => rng(seed + 100)() - 0.5).reverse();
      const a = replay(rows, R);
      const b = replay(shuffled, R);
      expect([...a.subjects]).toEqual([...b.subjects].sort((x, y) => ([...a.subjects.keys()].indexOf(x[0]) - [...a.subjects.keys()].indexOf(y[0]))));
      expect(JSON.stringify([...a.rows].map(([id, o]) => [id, o.sideA, o.sideB, o.expectedA, [...o.members]]))).toBe(JSON.stringify([...b.rows].sort((x, y) => x[0] - y[0]).map(([id, o]) => [id, o.sideA, o.sideB, o.expectedA, [...o.members]])));
    }
  });

  it("replaying a prefix gives exactly the state the longer replay passed through (nothing depends on later rows)", () => {
    const rows = randomRows(11, 50);
    const full = replay(rows, R);
    for (const cut of [1, 10, 25, 49]) {
      const prefix = replay(rows.slice(0, cut), R);
      for (const [id, o] of prefix.rows) expect(JSON.stringify([...o.members])).toBe(JSON.stringify([...full.rows.get(id)!.members]));
    }
  });

  it("removing a row and replaying equals replaying without it: a voided result leaves no trace", () => {
    const rows = randomRows(7, 40);
    const without = rows.filter((r) => r.id !== 20);
    const a = replay(without, R);
    const b = replay(rows.filter((r) => r.id !== 20), R);
    expect(JSON.stringify([...a.subjects])).toBe(JSON.stringify([...b.subjects]));
    // And it matters: the full ledger differs from the one without it for somebody.
    const full = replay(rows, R);
    expect(JSON.stringify([...full.subjects])).not.toBe(JSON.stringify([...a.subjects]));
  });

  it("conserves nothing it should not: with equal K, a two-player game is zero-sum", () => {
    const out = replay([row(1, ["user:1"], ["user:2"]), row(2, ["user:2"], ["user:1"])], R);
    const total = out.subjects.get("user:1")!.rating + out.subjects.get("user:2")!.rating;
    expect(total).toBeCloseTo(2000, 1);
  });
});

describe("restarting a rating", () => {
  it("starts the subject again after the cutoff, while the opponents keep the rating it had then", () => {
    const rows = [row(1, ["user:1"], ["user:2"]), row(2, ["user:1"], ["user:2"]), row(3, ["user:1"], ["user:2"]), row(4, ["user:1"], ["user:2"])];
    const plain = replay(rows, R);
    const reset = replay(rows, R, new Map([["user:1", key(2)]]));
    // The first two rows are as they were, for both.
    expect(reset.rows.get(2)!.members.get("a:user:1")).toEqual(plain.rows.get(2)!.members.get("a:user:1"));
    // From the third, user:1 begins again at 1000 with no games; user:2 carries on.
    expect(reset.rows.get(3)!.members.get("a:user:1")).toMatchObject({ before: 1000, gamesBefore: 0, k: 40 });
    expect(reset.rows.get(3)!.members.get("b:user:2")!.before).toBe(plain.rows.get(3)!.members.get("b:user:2")!.before);
    expect(reset.subjects.get("user:1")!.games).toBe(2);
    // A reset with nothing after it leaves the subject at the start.
    const last = replay(rows, R, new Map([["user:1", key(4)]]));
    expect(last.subjects.get("user:1")).toMatchObject({ rating: 1000, games: 0, wins: 0 });
  });
});
