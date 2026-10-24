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
  scheduleTimed,
  seedOrder,
  startStep,
  shuffle,
  standings,
  parseTally,
  scoreRefusal,
} from "../src/lib/brackets";
import { DEFAULT_SCORING, parseRules, walkoverRefusal, type RankKey } from "../src/lib/tournament-rules";

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

describe("scoring by the sport's rules", () => {
  const goals = { kind: "tally" as const, bestOf: 1, draws: true, tablePoints: { win: 3, draw: 1, loss: 0 }, rankBy: ["points", "point_diff", "points_for", "head_to_head"] as RankKey[], retired: "win_only" as const };

  it("reads a tally, with how a level knockout match was decided", () => {
    expect(parseTally("3-2")).toEqual({ a: 3, b: 2, decider: null });
    expect(parseTally("2-2 (penalties 4-3)")).toEqual({ a: 2, b: 2, decider: "penalties 4-3" });
    expect(parseTally("21-15, 21-10")).toBeNull();
  });

  it("refuses a score that does not fit the result: the wrong winner, too many sets, more than a majority, a level score with no decider", () => {
    const sets = { kind: "sets" as const, bestOf: 3, draws: false };
    expect(scoreRefusal("21-15, 21-10", true, sets)).toBeNull();
    expect(scoreRefusal("21-15, 21-10", false, sets)).toMatch(/other side won/);
    expect(scoreRefusal("21-15, 15-21, 21-10, 21-5", true, sets)).toMatch(/more sets/);
    expect(scoreRefusal("11-5, 11-5, 11-5", true, { ...sets, bestOf: 5 })).toBeNull();
    expect(scoreRefusal("21-15, 3-8", false, sets, { retired: true })).toBeNull();
    expect(scoreRefusal("2-2", true, goals)).toMatch(/how it was decided/);
    expect(scoreRefusal("2-2 (penalties 4-3)", true, goals)).toBeNull();
    expect(scoreRefusal("2-2", null, goals, { drawAllowed: true })).toBeNull();
    expect(scoreRefusal("2-1", null, goals, { drawAllowed: true })).toMatch(/has a winner/);
  });

  it("ranks a goals table by points, then goal difference, counting draws", () => {
    const table = standings(
      [1, 2, 3],
      [
        { a: 1, b: 2, winner: null, score: "1-1", draw: true },
        { a: 1, b: 3, winner: 1, score: "3-0" },
        { a: 2, b: 3, winner: 2, score: "1-0" },
      ],
      goals
    );
    expect(table.map((s) => [s.entryId, s.points, s.pointDiff, s.drawn])).toEqual([
      [1, 4, 3, 1],
      [2, 4, 1, 1],
      [3, 0, -4, 0],
    ]);
  });

  it("counts a retirement's partial score only where the rules say as played", () => {
    const results = [{ a: 1, b: 2, winner: 2, score: "21-15, 3-8", retired: true }];
    expect(standings([1, 2], results).find((s) => s.entryId === 2)).toMatchObject({ won: 1, setDiff: 0, pointDiff: 0 });
    expect(standings([1, 2], results, { ...DEFAULT_SCORING, retired: "as_played" }).find((s) => s.entryId === 2)).toMatchObject({ won: 1, setDiff: 0, pointDiff: -1 });
  });
});

describe("ratios and forfeit scores", () => {
  const order = (table: { entryId: number }[], ids: number[]) => table.map((s) => s.entryId).filter((id) => ids.includes(id));
  const sets5 = { kind: "sets" as const, bestOf: 5, draws: false, tablePoints: { win: 2, draw: 1, loss: 0 }, retired: "win_only" as const };
  const goals = { kind: "tally" as const, bestOf: 1, draws: true, tablePoints: { win: 3, draw: 1, loss: 0 }, retired: "win_only" as const };

  it("ranks by set ratio where the difference is level: 5-3 above 6-4", () => {
    const results = [
      { a: 1, b: 3, winner: 1, score: "11-5, 11-5, 5-11, 5-11, 11-5" },
      { a: 1, b: 4, winner: 1, score: "11-5, 11-5, 5-11, 5-11, 11-5" },
      { a: 2, b: 3, winner: 2, score: "11-5, 11-5, 11-5" },
      { a: 2, b: 4, winner: 4, score: "11-5, 11-5, 5-11, 5-11, 5-11" },
    ];
    const byDiff = standings([1, 2, 3, 4], results, { ...sets5, rankBy: ["set_diff"] });
    const byRatio = standings([1, 2, 3, 4], results, { ...sets5, rankBy: ["set_ratio"] });
    expect(byRatio.find((s) => s.entryId === 1)).toMatchObject({ setsWon: 6, setsLost: 4, setDiff: 2 });
    expect(byRatio.find((s) => s.entryId === 2)).toMatchObject({ setsWon: 5, setsLost: 3, setDiff: 2 });
    // Level on difference, the entry's id settles it; on ratio, 5/3 beats 6/4.
    expect(order(byDiff, [1, 2])).toEqual([1, 2]);
    expect(order(byRatio, [1, 2])).toEqual([2, 1]);
  });

  it("ranks by point ratio, with nothing conceded above any ratio and nothing at all at the foot", () => {
    const results = [
      { a: 1, b: 3, winner: 1, score: "4-2" },
      { a: 2, b: 4, winner: 2, score: "3-1" },
      { a: 5, b: 6, winner: 5, score: "1-0" },
    ];
    const table = standings([1, 2, 3, 4, 5, 6, 7], results, { ...goals, rankBy: ["point_ratio"] });
    expect(table.find((s) => s.entryId === 1)).toMatchObject({ pointsFor: 4, pointsAgainst: 2 });
    expect(order(table, [1, 2, 5, 7])).toEqual([5, 2, 1, 7]);
    expect(order(standings([1, 2], results, { ...goals, rankBy: ["point_diff"] }), [1, 2])).toEqual([1, 2]);
  });

  it("counts a walkover at the rules' forfeit score, from the winner's side; with none set, the win only", () => {
    const results = [{ a: 1, b: 2, winner: 2, score: null, walkover: true }];
    expect(standings([1, 2], results, { ...goals, rankBy: ["points"], walkover: "3-0" }).find((s) => s.entryId === 2)).toMatchObject({ won: 1, pointsFor: 3, pointDiff: 3, points: 3 });
    expect(standings([1, 2], results, { ...goals, rankBy: ["points"], walkover: null }).find((s) => s.entryId === 2)).toMatchObject({ won: 1, pointsFor: 0, pointDiff: 0 });
    const volleyball = { ...sets5, rankBy: ["points" as RankKey], setPoints: { winClear: 3, winDecider: 2, loseDecider: 1, loseClear: 0 }, walkover: "25-0, 25-0, 25-0" };
    const table = standings([1, 2], results, volleyball);
    expect(table.find((s) => s.entryId === 2)).toMatchObject({ setsWon: 3, setsLost: 0, pointsFor: 75, points: 3 });
    expect(table.find((s) => s.entryId === 1)).toMatchObject({ setsWon: 0, setsLost: 3, pointsAgainst: 75, points: 0 });
  });

  it("refuses a forfeit score that is not a winning result of the match as set up", () => {
    expect(walkoverRefusal("3-0", "tally", 1)).toBeNull();
    expect(walkoverRefusal(null, "sets", 5)).toBeNull();
    expect(walkoverRefusal("0-3", "tally", 1)).toMatch(/first, and ahead/);
    expect(walkoverRefusal("3-0, 3-0", "tally", 1)).toMatch(/one score/);
    expect(walkoverRefusal("25-0, 25-0", "sets", 5)).toMatch(/best of 5 is 3 sets/);
    expect(walkoverRefusal("three nil", "tally", 1)).toMatch(/Write/);
    expect(parseRules({ scoring: { kind: "tally", walkover: "3-0" } })).toMatchObject({ ok: true, rules: { scoring: { walkover: "3-0" } } });
    // Changing the match cannot quietly drop a forfeit score set before.
    const set = parseRules({ scoring: { bestOf: 5, walkover: "25-0, 25-0, 25-0" } });
    if (!set.ok) throw new Error(set.error);
    expect(parseRules({ scoring: { bestOf: 3 } }, set.rules)).toMatchObject({ ok: false });
    expect(parseRules({ scoring: { bestOf: 3, walkover: "25-0, 25-0" } }, set.rules)).toMatchObject({ ok: true });
  });
});

describe("matches of different lengths in court time", () => {
  const windows = [1, 2].map((courtId) => ({ courtId, date: "2026-12-01", start: 540, end: 780 }));
  const grid = (len: number) => windows.flatMap((w) => Array.from({ length: (w.end - w.start) / len }, (_, i) => ({ courtId: w.courtId, date: w.date, minute: w.start + i * len })));

  it("places matches of one length exactly where the slot scheduler does", () => {
    const matches = [
      { key: "q1", sides: ["e1", "e2"], after: [] },
      { key: "q2", sides: ["e3", "e4"], after: [] },
      { key: "q3", sides: ["e5", "e6"], after: [] },
      { key: "q4", sides: ["e7", "e8"], after: [] },
      { key: "s1", sides: ["w:s1:a", "w:s1:b"], after: ["q1", "q2"] },
      { key: "s2", sides: ["w:s2:a", "w:s2:b"], after: ["q3", "q4"] },
      { key: "f", sides: ["w:f:a", "w:f:b"], after: ["s1", "s2"] },
    ];
    const slots = scheduleMatches(matches, grid(30));
    const timed = scheduleTimed(matches.map((m) => ({ ...m, minutes: 30 })), windows, { step: startStep([30]), origin: 540 });
    if (!slots.ok || !timed.ok) throw new Error("did not fit");
    for (const m of matches) expect({ ...timed.placed.get(m.key)!, end: undefined }).toEqual({ ...slots.placed.get(m.key)!, end: undefined });
  });

  it("gives each its length: no court or side has two at once, and a match starts once those feeding it have ended", () => {
    const matches = [
      { key: "g1", sides: ["e1", "e2"], after: [], minutes: 30 },
      { key: "g2", sides: ["e1", "e3"], after: [], minutes: 30 },
      { key: "g3", sides: ["e2", "e3"], after: [], minutes: 30 },
      { key: "f", sides: ["w:f:a", "w:f:b"], after: ["g1", "g2", "g3"], minutes: 90 },
    ];
    expect(startStep([30, 90, 45])).toBe(15);
    const timed = scheduleTimed(matches, windows, { step: 30, origin: 540, occupied: [{ courtId: 2, date: "2026-12-01", start: 540, end: 600 }], sideBusy: new Map([["e3", [{ date: "2026-12-01", start: 540, end: 570 }]]]) });
    if (!timed.ok) throw new Error("did not fit");
    const at = (k: string) => timed.placed.get(k)!;
    // Court 2 is taken until 10:00 by another division; e3 plays elsewhere until 09:30.
    expect(at("g1")).toMatchObject({ courtId: 1, minute: 540, end: 570 });
    expect(at("g2")).toMatchObject({ minute: 570 });
    expect(at("g3")).toMatchObject({ minute: 600 });
    expect(at("f")).toMatchObject({ minute: 630, end: 720 });
    // Too long for what is held: not placed.
    expect(scheduleTimed([{ key: "x", sides: [], after: [], minutes: 300 }], windows, { step: 30, origin: 540 })).toEqual({ ok: false, unplaced: 1 });
    // Not before what `allowed` lets through (the past).
    const later = scheduleTimed([{ key: "y", sides: [], after: [], minutes: 30 }], windows, { step: 30, origin: 540, allowed: (_d, m) => m >= 660 });
    expect(later.ok && later.placed.get("y")).toMatchObject({ minute: 660 });
  });
});
