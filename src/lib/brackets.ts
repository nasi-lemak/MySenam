/**
 * The arithmetic of a tournament, kept apart from the database: who meets
 * whom, where the byes fall, how a group finishes, and how matches fit into
 * the time a venue has given. lib/tournaments.ts stores what this decides.
 */

/** The smallest power of two that holds n. */
export function bracketSize(n: number): number {
  let size = 1;
  while (size < n) size *= 2;
  return Math.max(size, 2);
}

/**
 * Which seed goes in each line of a bracket of `size`, top to bottom, so the
 * top two seeds can only meet in the final, the top four in the semi-finals,
 * and byes fall to the top seeds: 8 → [1, 8, 4, 5, 2, 7, 3, 6].
 */
export function seedOrder(size: number): number[] {
  let order = [1, 2];
  while (order.length < size) {
    const next: number[] = [];
    const total = order.length * 2 + 1;
    for (const seed of order) next.push(seed, total - seed);
    order = next;
  }
  return order;
}

/**
 * The first round of a knockout: pairs of entries, in bracket order, with
 * null for a bye. `ranked` is the entries best first — the seeded ones in
 * seed order, then the rest in drawn order.
 */
export function firstRound<T>(ranked: T[]): [T | null, T | null][] {
  const size = bracketSize(ranked.length);
  const lines = seedOrder(size).map((seed) => ranked[seed - 1] ?? null);
  const pairs: [T | null, T | null][] = [];
  for (let i = 0; i < size; i += 2) pairs.push([lines[i], lines[i + 1]]);
  return pairs;
}

/**
 * Who goes where when groups feed a knockout: group winners take the top
 * seeds in group order, and each group's runner-up is put in the other half
 * of the bracket from its winner — so two from one group cannot meet again
 * before the final — and never against a winner from its own group in the
 * first round. Runners-up are given in group order; the result is ranked,
 * best first, for `firstRound`.
 */
export function knockoutFromGroups<T>(winners: T[], runnersUp: T[]): T[] {
  const g = winners.length;
  const size = bracketSize(g + runnersUp.length);
  const order = seedOrder(size); // line → seed
  const lineOf = new Map(order.map((seed, line) => [seed, line]));
  const topHalf = (seed: number) => lineOf.get(seed)! < size / 2;
  const firstOpponent = (seed: number) => order[lineOf.get(seed)! ^ 1];
  const free = runnersUp.map((_, k) => g + 1 + k);
  const placed = new Map<number, T>();
  runnersUp.forEach((runnerUp, i) => {
    const ownWinner = i + 1;
    const pick =
      free.find((s) => topHalf(s) !== topHalf(ownWinner) && firstOpponent(s) !== ownWinner) ??
      free.find((s) => firstOpponent(s) !== ownWinner) ??
      free[0];
    free.splice(free.indexOf(pick), 1);
    placed.set(pick, runnerUp);
  });
  return [...winners, ...runnersUp.map((_, k) => placed.get(g + 1 + k)!)];
}

/** Shuffled, by a source of randomness that tests can fix. */
export function shuffle<T>(items: T[], random: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Split entries into `groups` groups as evenly as possible, snaking so each
 * group gets one of the top seeds: 1 2 3 4 / 8 7 6 5 / 9 10 ...
 */
export function intoGroups<T>(ranked: T[], groups: number): T[][] {
  const out: T[][] = Array.from({ length: groups }, () => []);
  ranked.forEach((entry, i) => {
    const pass = Math.floor(i / groups);
    const at = i % groups;
    out[pass % 2 === 0 ? at : groups - 1 - at].push(entry);
  });
  return out;
}

/** How many groups of about `size` for n entries, never a group of one. */
export function groupCount(n: number, size: number): number {
  return Math.max(1, Math.round(n / size));
}

/**
 * Everybody in a group against everybody else, in rounds where nobody plays
 * twice (the circle method). Indices into the group.
 */
export function roundRobin(n: number): [number, number][][] {
  const players = Array.from({ length: n % 2 === 0 ? n : n + 1 }, (_, i) => i);
  const bye = n % 2 === 0 ? -1 : n;
  const rounds: [number, number][][] = [];
  for (let r = 0; r < players.length - 1; r++) {
    const round: [number, number][] = [];
    for (let i = 0; i < players.length / 2; i++) {
      const a = players[i];
      const b = players[players.length - 1 - i];
      if (a !== bye && b !== bye) round.push([a, b]);
    }
    rounds.push(round);
    // Keep the first fixed, turn the rest.
    players.splice(1, 0, players.pop()!);
  }
  return rounds;
}

export interface ParsedScore {
  sets: [number, number][];
  setsA: number;
  setsB: number;
  pointsA: number;
  pointsB: number;
}

/** "21-15, 18-21, 21-10" — sets, each "a-b". Null if it does not read as one. */
export function parseScore(score: string): ParsedScore | null {
  const parts = score
    .split(/[,;]/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0 || parts.length > 7) return null;
  const sets: [number, number][] = [];
  for (const part of parts) {
    const m = /^(\d{1,3})\s*[-–:]\s*(\d{1,3})$/.exec(part);
    if (!m) return null;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === b) return null;
    sets.push([a, b]);
  }
  return {
    sets,
    setsA: sets.filter(([a, b]) => a > b).length,
    setsB: sets.filter(([a, b]) => b > a).length,
    pointsA: sets.reduce((s, [a]) => s + a, 0),
    pointsB: sets.reduce((s, [, b]) => s + b, 0),
  };
}

export interface Standing {
  entryId: number;
  played: number;
  won: number;
  lost: number;
  setDiff: number;
  pointDiff: number;
}

/**
 * A group's table: most wins first, then the better set difference, then
 * points; then, between two level on all that, whoever won when they met.
 * A walkover counts as a win, with no sets or points either way.
 */
export function standings(
  entryIds: number[],
  results: { a: number; b: number; winner: number | null; score: string | null }[]
): Standing[] {
  const table = new Map<number, Standing>(
    entryIds.map((id) => [id, { entryId: id, played: 0, won: 0, lost: 0, setDiff: 0, pointDiff: 0 }])
  );
  for (const r of results) {
    if (r.winner === null) continue;
    const a = table.get(r.a);
    const b = table.get(r.b);
    if (!a || !b) continue;
    a.played++;
    b.played++;
    const [win, loss] = r.winner === r.a ? [a, b] : [b, a];
    win.won++;
    loss.lost++;
    const parsed = r.score ? parseScore(r.score) : null;
    if (parsed) {
      a.setDiff += parsed.setsA - parsed.setsB;
      b.setDiff += parsed.setsB - parsed.setsA;
      a.pointDiff += parsed.pointsA - parsed.pointsB;
      b.pointDiff += parsed.pointsB - parsed.pointsA;
    }
  }
  const headToHead = (x: number, y: number) =>
    results.find((r) => r.winner !== null && ((r.a === x && r.b === y) || (r.a === y && r.b === x)))?.winner;
  return [...table.values()].sort((x, y) => {
    const by = y.won - x.won || y.setDiff - x.setDiff || y.pointDiff - x.pointDiff;
    if (by !== 0) return by;
    const met = headToHead(x.entryId, y.entryId);
    return met === x.entryId ? -1 : met === y.entryId ? 1 : x.entryId - y.entryId;
  });
}

/** A court's time for one match: from `minute` of the day, one match long. */
export interface Slot {
  courtId: number;
  date: string;
  minute: number;
}

export interface ToSchedule {
  key: string;
  /** Who plays: entries known now, or placeholders for winners to come. */
  sides: string[];
  /** Matches that must be over first: their winners play in this one. */
  after: string[];
}

/**
 * Fit matches into the hours held, earliest first, so that nobody plays two
 * at once and a match starts only after the ones feeding it have finished.
 * One match a slot on a court (the slots of one tournament are all one match
 * long). Returns where each goes, or the number of matches that did not fit.
 */
export function scheduleMatches(
  matches: ToSchedule[],
  slots: Slot[]
): { ok: true; placed: Map<string, Slot> } | { ok: false; unplaced: number } {
  const ordered = [...slots].sort((a, b) => a.date.localeCompare(b.date) || a.minute - b.minute || a.courtId - b.courtId);
  const taken = new Set<number>();
  const busy = new Map<string, Set<string>>(); // "date:minute" → sides playing then
  const at = new Map<string, number>(); // key → index of its slot
  const placed = new Map<string, Slot>();
  let unplaced = 0;
  const time = (s: Slot) => `${s.date}:${String(s.minute).padStart(4, "0")}`;

  for (const match of matches) {
    const earliest = Math.max(-1, ...match.after.map((k) => at.get(k) ?? Infinity));
    if (earliest === Infinity) {
      unplaced++;
      continue;
    }
    const finishTime = earliest >= 0 ? time(ordered[earliest]) : "";
    let found = -1;
    for (let i = 0; i < ordered.length; i++) {
      if (taken.has(i)) continue;
      const t = time(ordered[i]);
      if (t <= finishTime) continue;
      const playing = busy.get(t);
      if (playing && match.sides.some((s) => playing.has(s))) continue;
      found = i;
      break;
    }
    if (found < 0) {
      unplaced++;
      continue;
    }
    taken.add(found);
    at.set(match.key, found);
    const t = time(ordered[found]);
    if (!busy.has(t)) busy.set(t, new Set());
    for (const s of match.sides) busy.get(t)!.add(s);
    placed.set(match.key, ordered[found]);
  }
  return unplaced > 0 ? { ok: false, unplaced } : { ok: true, placed };
}
