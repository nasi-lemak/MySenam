import { describe, expect, it } from "vitest";
import { courtsForNight, fewestNights, placeOnNights, teamRoundRobin } from "../src/lib/fixtures";

/**
 * The fixture generator on its own (lib/fixtures.ts): who meets whom and who is at home, which match night each
 * fixture falls on, and which court and time on the night. Properties, for every size of league.
 */

const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
const key = (a: number, b: number) => `${Math.min(a, b)}-${Math.max(a, b)}`;

describe("a round robin", () => {
  for (let n = 2; n <= 16; n++) {
    it(`of ${n} teams: every pair meets once, nobody plays twice in a round, home and away balance`, () => {
      const { fixtures, byes, rounds } = teamRoundRobin(ids(n), 1);
      expect(fixtures.length).toBe((n * (n - 1)) / 2);
      expect(new Set(fixtures.map((f) => key(f.home, f.away))).size).toBe(fixtures.length);
      expect(rounds).toBe(n % 2 === 0 ? n - 1 : n);
      for (let r = 1; r <= rounds; r++) {
        const playing = fixtures.filter((f) => f.round === r).flatMap((f) => [f.home, f.away]);
        expect(new Set(playing).size).toBe(playing.length);
      }
      // An odd number of teams: one is idle each round, and each team is idle once.
      if (n % 2 === 1) {
        expect(byes.length).toBe(rounds);
        expect(new Set(byes.map((b) => b.team)).size).toBe(n);
      } else expect(byes).toEqual([]);
      // Home and away differ by at most one for every team.
      for (const t of ids(n)) {
        const home = fixtures.filter((f) => f.home === t).length;
        const away = fixtures.filter((f) => f.away === t).length;
        expect(Math.abs(home - away)).toBeLessThanOrEqual(1);
      }
    });
  }

  it("alternates home and away for a team as the pairings allow (no more than one run of two in a row across the season)", () => {
    const { fixtures } = teamRoundRobin(ids(8), 1);
    let breaks = 0;
    for (const t of ids(8)) {
      const seq = fixtures.filter((f) => f.home === t || f.away === t).sort((a, b) => a.round - b.round).map((f) => (f.home === t ? "H" : "A"));
      for (let i = 1; i < seq.length; i++) if (seq[i] === seq[i - 1]) breaks++;
    }
    // The least a round robin of 8 can break its alternation is n - 2 times in all.
    expect(breaks).toBe(6);
  });

  it("double: every ordered pair once, so every team is exactly as often home as away", () => {
    for (const n of [3, 4, 5, 6, 9, 10]) {
      const { fixtures, rounds } = teamRoundRobin(ids(n), 2);
      expect(fixtures.length).toBe(n * (n - 1));
      expect(new Set(fixtures.map((f) => `${f.home}>${f.away}`)).size).toBe(fixtures.length);
      expect(rounds).toBe((n % 2 === 0 ? n - 1 : n) * 2);
      for (const t of ids(n)) expect(fixtures.filter((f) => f.home === t).length).toBe(fixtures.filter((f) => f.away === t).length);
      // The return leg comes after every first-leg round.
      const firstLegLast = Math.max(...fixtures.filter((f) => f.leg === 1).map((f) => f.round));
      expect(Math.min(...fixtures.filter((f) => f.leg === 2).map((f) => f.round))).toBeGreaterThan(firstLegLast);
    }
  });

  it("makes nothing for fewer than two teams", () => {
    expect(teamRoundRobin([], 1).fixtures).toEqual([]);
    expect(teamRoundRobin([1], 2).fixtures).toEqual([]);
  });
});

describe("match nights", () => {
  const nights = (n: number) => Array.from({ length: n }, (_, i) => `2027-03-${String(i + 1).padStart(2, "0")}`);

  it("round n is night n when there is room and no blackouts", () => {
    const { fixtures } = teamRoundRobin(ids(6), 1);
    const placed = placeOnNights(fixtures, nights(5), { capacity: 3, blackouts: new Map() });
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    for (const p of placed.placed) expect(p.night + 1).toBe(p.fixture.round);
  });

  it("a team plays once a night, capacity is respected, and nobody plays on a blackout date", () => {
    const { fixtures } = teamRoundRobin(ids(6), 2);
    const blackouts = new Map<number, Set<string>>([
      [1, new Set(["2027-03-02", "2027-03-05"])],
      [4, new Set(["2027-03-03"])],
    ]);
    const placed = placeOnNights(fixtures, nights(18), { capacity: 2, blackouts });
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    expect(placed.placed.length).toBe(fixtures.length);
    const perNight = new Map<number, typeof placed.placed>();
    for (const p of placed.placed) perNight.set(p.night, [...(perNight.get(p.night) ?? []), p]);
    for (const [night, here] of perNight) {
      expect(here.length).toBeLessThanOrEqual(2);
      const teams = here.flatMap((p) => [p.fixture.home, p.fixture.away]);
      expect(new Set(teams).size).toBe(teams.length);
      for (const t of teams) expect(blackouts.get(t)?.has(nights(18)[night]) ?? false).toBe(false);
    }
  });

  it("says what could not be placed, and places nothing, when the nights cannot hold it", () => {
    const { fixtures } = teamRoundRobin(ids(4), 1);
    // Team 1 can play on none of the three nights there are.
    const none = placeOnNights(fixtures, nights(3), { capacity: 2, blackouts: new Map([[1, new Set(nights(3))]]) });
    expect(none.ok).toBe(false);
    if (none.ok) return;
    expect(none.unplaced.length).toBe(3);
    expect(none.unplaced.every((f) => f.home === 1 || f.away === 1)).toBe(true);
  });

  it("finds a placement where the plain order does not (blackouts that matter)", () => {
    const { fixtures } = teamRoundRobin(ids(4), 1);
    // Four nights for three rounds, with a team out on each of the first two nights.
    const blackouts = new Map<number, Set<string>>([
      [1, new Set([nights(4)[0]])],
      [2, new Set([nights(4)[1]])],
    ]);
    const placed = placeOnNights(fixtures, nights(4), { capacity: 2, blackouts });
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    for (const p of placed.placed) expect(blackouts.get(p.fixture.home)?.has(nights(4)[p.night]) ?? false).toBe(false);
  });

  it("is the same answer every time", () => {
    const { fixtures } = teamRoundRobin(ids(6), 2);
    const blackouts = new Map<number, Set<string>>([[2, new Set(["2027-03-01", "2027-03-02"])]]);
    const a = placeOnNights(fixtures, nights(12), { capacity: 3, blackouts });
    const b = placeOnNights(fixtures, nights(12), { capacity: 3, blackouts });
    expect(a).toEqual(b);
  });

  it("the fewest nights a league needs: the rounds, or the fixtures over what a night holds", () => {
    expect(fewestNights(6, 1, 3)).toBe(5);
    expect(fewestNights(5, 1, 2)).toBe(5);
    expect(fewestNights(6, 2, 1)).toBe(30);
    expect(fewestNights(1, 1, 3)).toBe(0);
  });
});

describe("courts on a night", () => {
  it("puts the first fixtures on different courts at the first time, then the next time", () => {
    const f = teamRoundRobin(ids(6), 1).fixtures.filter((x) => x.round === 1);
    const out = courtsForNight(f, [10, 11], 2, new Map())!;
    expect(out.length).toBe(3);
    const taken = new Set(out.map((o) => `${o.slot}:${o.court}`));
    expect(taken.size).toBe(3);
    expect(out.filter((o) => o.slot === 0).length).toBe(2);
  });

  it("gives the home team its own court where it is free then", () => {
    const f = teamRoundRobin(ids(4), 1).fixtures.filter((x) => x.round === 1);
    const out = courtsForNight(f, [10, 11], 1, new Map([[f[1].home, 11]]))!;
    expect(out.find((o) => o.fixture === f[1])!.court).toBe(11);
  });

  it("refuses a night that holds fewer than it is given", () => {
    const f = teamRoundRobin(ids(6), 1).fixtures.filter((x) => x.round === 1);
    expect(courtsForNight(f, [10], 2, new Map())).toBeNull();
  });
});
