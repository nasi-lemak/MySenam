/**
 * Fixture lists for a league of teams, apart from the database
 * (docs/features/tournaments.md#team-leagues): who meets whom and who is at
 * home (a round robin, single or double), which of the manager's match nights
 * each fixture falls on (a team plays once a night, never on a date it cannot),
 * and which court and time on the night each gets. Pure, so its properties are
 * tested on their own (`tests/fixtures-plan.test.ts`).
 *
 * The round robin is the circle method: with an odd number of teams one has a
 * bye each round. Home and away alternate for every team as closely as the
 * pairings allow (no team is home more than once more than it is away over a
 * single round robin, and a double one has every pair meet home and away, so
 * it is exactly even).
 */

export interface PlannedFixture {
  /** 1 for the first time a pair meets, 2 for the return. */
  leg: number;
  /** The round, counted across both legs from 1. */
  round: number;
  home: number;
  away: number;
}

export interface Bye {
  round: number;
  team: number;
}

/**
 * Every pair of `teamIds` meeting once (`legs` 1) or home and away (`legs` 2),
 * in rounds in which no team plays twice. Teams are given as ids; the order
 * given only decides who is where on the first round.
 */
export function teamRoundRobin(teamIds: number[], legs: 1 | 2): { fixtures: PlannedFixture[]; byes: Bye[]; rounds: number } {
  const n = teamIds.length;
  if (n < 2) return { fixtures: [], byes: [], rounds: 0 };
  // An even circle of positions; position m-1 is fixed (a dummy "bye" when there is an odd number of teams).
  const m = n % 2 === 0 ? n : n + 1;
  const spin = m - 1;
  const perLeg = m - 1;
  const fixtures: PlannedFixture[] = [];
  const byes: Bye[] = [];
  const at = (p: number): number | null => (p < n ? teamIds[p] : null);
  for (let r = 0; r < spin; r++) {
    const round = r + 1;
    const pairs: [number, number][] = [];
    const fixedHome = r % 2 === 1;
    pairs.push(fixedHome ? [m - 1, r] : [r, m - 1]);
    for (let k = 1; k < m / 2; k++) {
      const a = (r + k) % spin;
      const b = (((r - k) % spin) + spin) % spin;
      pairs.push(k % 2 === 1 ? [a, b] : [b, a]);
    }
    for (const [h, a] of pairs) {
      const home = at(h);
      const away = at(a);
      if (home === null && away !== null) byes.push({ round, team: away });
      else if (away === null && home !== null) byes.push({ round, team: home });
      else if (home !== null && away !== null) fixtures.push({ leg: 1, round, home, away });
    }
  }
  if (legs === 2) {
    const first = fixtures.slice();
    for (const f of first) fixtures.push({ leg: 2, round: f.round + perLeg, home: f.away, away: f.home });
    for (const b of byes.slice()) byes.push({ round: b.round + perLeg, team: b.team });
  }
  return { fixtures, byes, rounds: perLeg * legs };
}

/** The fewest match nights a league of `teams` teams needs, given how many fixtures one night holds. */
export function fewestNights(teams: number, legs: 1 | 2, capacity: number): number {
  if (teams < 2 || capacity < 1) return 0;
  const rounds = (teams % 2 === 0 ? teams - 1 : teams) * legs;
  const total = ((teams * (teams - 1)) / 2) * legs;
  return Math.max(rounds, Math.ceil(total / capacity));
}

/** A small deterministic generator, so a search for a placement gives the same answer every time. */
function seeded(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Placement {
  fixture: PlannedFixture;
  /** Index into the nights given. */
  night: number;
}

/**
 * Put every fixture on one of `nights` (dates, in order): a team plays at most
 * once a night, never on a date in its blackouts, and a night holds no more
 * than `capacity` fixtures. Earlier rounds go on earlier nights, so with room
 * to spare and no blackouts round n is night n. Where that leaves some over
 * (blackouts in the way), other orders are tried, deterministically, before
 * giving up; what could not be placed is returned, and nothing is half done.
 */
export function placeOnNights(
  fixtures: PlannedFixture[],
  nights: string[],
  opts: { capacity: number; blackouts: Map<number, Set<string>> }
): { ok: true; placed: Placement[] } | { ok: false; unplaced: PlannedFixture[] } {
  const attempt = (order: PlannedFixture[]): { placed: Placement[]; unplaced: PlannedFixture[] } => {
    const left = order.slice();
    const placed: Placement[] = [];
    for (let night = 0; night < nights.length && left.length > 0; night++) {
      const busy = new Set<number>();
      let held = 0;
      for (let i = 0; i < left.length && held < opts.capacity; ) {
        const f = left[i];
        const out = (t: number) => busy.has(t) || (opts.blackouts.get(t)?.has(nights[night]) ?? false);
        if (out(f.home) || out(f.away)) {
          i++;
          continue;
        }
        busy.add(f.home);
        busy.add(f.away);
        held++;
        placed.push({ fixture: f, night });
        left.splice(i, 1);
      }
    }
    return { placed, unplaced: left };
  };
  const natural = attempt(fixtures);
  if (natural.unplaced.length === 0) return { ok: true, placed: natural.placed };
  let best = natural;
  const random = seeded(fixtures.length * 7919 + nights.length * 104729 + fixtures.reduce((s, f) => s + f.home * 31 + f.away, 0));
  for (let tries = 0; tries < 400 && best.unplaced.length > 0; tries++) {
    // Most constrained first (a team with many blackouts), the rest shuffled.
    const keyed = fixtures.map((f) => ({
      f,
      k:
        -((opts.blackouts.get(f.home)?.size ?? 0) + (opts.blackouts.get(f.away)?.size ?? 0)) * 2 +
        random() * Math.max(1, Math.min(fixtures.length, 4 + tries / 10)),
    }));
    keyed.sort((x, y) => x.k - y.k);
    const tried = attempt(keyed.map((x) => x.f));
    if (tried.unplaced.length < best.unplaced.length) best = tried;
  }
  return best.unplaced.length === 0 ? { ok: true, placed: best.placed } : { ok: false, unplaced: best.unplaced };
}

export interface CourtSlot {
  fixture: PlannedFixture;
  court: number;
  /** 0 for the first time on the night, 1 for the next, and so on. */
  slot: number;
}

/**
 * The courts and times of one night's fixtures: the earliest time a court is
 * free, the home team's own court where it is free then, else any. `slots` is
 * how many times a court is used in a night. Returns null if the night cannot
 * hold them all.
 */
export function courtsForNight(fixtures: PlannedFixture[], courts: number[], slots: number, homeCourt: Map<number, number | null>): CourtSlot[] | null {
  if (fixtures.length > courts.length * slots) return null;
  const used = new Set<string>();
  const out: CourtSlot[] = [];
  for (const fixture of fixtures) {
    let done = false;
    for (let slot = 0; slot < slots && !done; slot++) {
      const preferred = homeCourt.get(fixture.home) ?? null;
      const free = courts.filter((c) => !used.has(`${slot}:${c}`));
      if (free.length === 0) continue;
      const court = preferred !== null && free.includes(preferred) ? preferred : free[0];
      used.add(`${slot}:${court}`);
      out.push({ fixture, court, slot });
      done = true;
    }
    if (!done) return null;
  }
  return out;
}
