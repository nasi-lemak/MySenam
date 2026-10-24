import { DEFAULT_SCORING, type RankKey, type ScoringRules } from "./tournament-rules";

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

export interface ParsedTally {
  a: number;
  b: number;
  /** How a level knockout match was decided, as written: "penalties 4-3". */
  decider: string | null;
}

/** "3-2", or "2-2 (penalties 4-3)" — one number each side. Null if it does not read as one. */
export function parseTally(score: string): ParsedTally | null {
  const m = /^\s*(\d{1,4})\s*[-–:]\s*(\d{1,4})\s*(?:\((.{1,60})\))?\s*$/.exec(score);
  if (!m) return null;
  return { a: Number(m[1]), b: Number(m[2]), decider: m[3]?.trim() || null };
}

/**
 * Why a score cannot stand for this result, or null. Sets: each set has a
 * winner, there are no more than the match is the best of, and the winner
 * took more of them (not so for a retirement, where the score is what was
 * played) but never more than a majority. Tally: the winner scored more; a
 * level score is a draw where draws are allowed, and otherwise needs how it
 * was decided, in brackets.
 */
/**
 * A score as the other side would write it: "21-15, 18-21" is "15-21, 21-18",
 * "3-2" is "2-3", and "2-2 (penalties 4-3)" is "2-2 (penalties 3-4)". Words
 * are left alone. Players write their own score first; it is kept with the
 * first-named side's first.
 */
export function flipScore(score: string): string {
  return score.replace(/(\d+)\s*-\s*(\d+)/g, (_, a: string, b: string) => `${b}-${a}`);
}

export function scoreRefusal(
  score: string,
  winnerIsA: boolean | null,
  scoring: Pick<ScoringRules, "kind" | "bestOf" | "draws">,
  opts: { retired?: boolean; drawAllowed?: boolean } = {}
): string | null {
  if (scoring.kind === "tally") {
    const t = parseTally(score);
    if (!t) return 'Write the score as one number each side, like "3-2".';
    if (winnerIsA === null) return t.a === t.b && opts.drawAllowed ? null : t.a === t.b ? "A draw is not allowed here: give the winner." : "That score has a winner.";
    if (opts.retired) return null;
    if (t.a === t.b) return t.decider ? null : 'Level: say how it was decided, like "2-2 (penalties 4-3)".';
    return (t.a > t.b) === winnerIsA ? null : "That score says the other side won.";
  }
  if (winnerIsA === null) return "A match in sets always has a winner.";
  const parsed = parseScore(score);
  if (!parsed) return 'Write the score as sets, like "21-15, 18-21, 21-10".';
  if (parsed.sets.length > scoring.bestOf) return `That is more sets than a best of ${scoring.bestOf}.`;
  const won = winnerIsA ? parsed.setsA : parsed.setsB;
  const lost = winnerIsA ? parsed.setsB : parsed.setsA;
  if (opts.retired) return null;
  if (won <= lost) return "That score says the other side won.";
  if (won > Math.ceil(scoring.bestOf / 2)) return `A best of ${scoring.bestOf} is won with ${Math.ceil(scoring.bestOf / 2)} sets.`;
  return null;
}

export interface Standing {
  entryId: number;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  setDiff: number;
  /** Points (or goals) scored, and the difference. */
  pointsFor: number;
  pointDiff: number;
  /** Table points, by the rules' points for a win, a draw and a loss. */
  points: number;
}

export interface TableResult {
  a: number;
  b: number;
  winner: number | null;
  score: string | null;
  /** Played and level (a tally sport's draw). */
  draw?: boolean;
  /** One side stopped part-way. */
  retired?: boolean;
}

/**
 * A group's table, ranked by the rules' keys in order (by default most wins,
 * then the better set difference, then points, then whoever won when two
 * level on all that met), the entry's id settling anything still level. A
 * walkover counts as a win with no sets or points either way; a retirement as
 * a win, with its partial score counted only where the rules say "as_played".
 */
export function standings(
  entryIds: number[],
  results: TableResult[],
  scoring: Pick<ScoringRules, "kind" | "tablePoints" | "rankBy" | "retired"> & Partial<Pick<ScoringRules, "setPoints" | "bestOf">> = DEFAULT_SCORING
): Standing[] {
  const table = new Map<number, Standing>(
    entryIds.map((id) => [id, { entryId: id, played: 0, won: 0, drawn: 0, lost: 0, setDiff: 0, pointsFor: 0, pointDiff: 0, points: 0 }])
  );
  for (const r of results) {
    if (r.winner === null && !r.draw) continue;
    const a = table.get(r.a);
    const b = table.get(r.b);
    if (!a || !b) continue;
    a.played++;
    b.played++;
    if (r.draw) {
      a.drawn++;
      b.drawn++;
      a.points += scoring.tablePoints.draw;
      b.points += scoring.tablePoints.draw;
    } else {
      const [win, loss] = r.winner === r.a ? [a, b] : [b, a];
      win.won++;
      loss.lost++;
      if (scoring.setPoints && scoring.kind === "sets") {
        // Went to the deciding set: the loser won all but one of the sets needed. A walkover or retirement is clear.
        const parsed = r.score && !r.retired ? parseScore(r.score) : null;
        const loserSets = parsed ? Math.min(parsed.setsA, parsed.setsB) : 0;
        const decider = parsed !== null && loserSets === Math.floor((scoring.bestOf ?? 3) / 2);
        win.points += decider ? scoring.setPoints.winDecider : scoring.setPoints.winClear;
        loss.points += decider ? scoring.setPoints.loseDecider : scoring.setPoints.loseClear;
      } else {
        win.points += scoring.tablePoints.win;
        loss.points += scoring.tablePoints.loss;
      }
    }
    if (!r.score || (r.retired && scoring.retired === "win_only")) continue;
    if (scoring.kind === "tally") {
      const t = parseTally(r.score);
      if (!t) continue;
      a.pointsFor += t.a;
      b.pointsFor += t.b;
      a.pointDiff += t.a - t.b;
      b.pointDiff += t.b - t.a;
    } else {
      const parsed = parseScore(r.score);
      if (!parsed) continue;
      a.setDiff += parsed.setsA - parsed.setsB;
      b.setDiff += parsed.setsB - parsed.setsA;
      a.pointsFor += parsed.pointsA;
      b.pointsFor += parsed.pointsB;
      a.pointDiff += parsed.pointsA - parsed.pointsB;
      b.pointDiff += parsed.pointsB - parsed.pointsA;
    }
  }
  const headToHead = (x: number, y: number) =>
    results.find((r) => r.winner !== null && !r.draw && ((r.a === x && r.b === y) || (r.a === y && r.b === x)))?.winner;
  const value: Record<Exclude<RankKey, "head_to_head">, (s: Standing) => number> = {
    points: (s) => s.points,
    wins: (s) => s.won,
    set_diff: (s) => s.setDiff,
    point_diff: (s) => s.pointDiff,
    points_for: (s) => s.pointsFor,
  };
  return [...table.values()].sort((x, y) => {
    for (const key of scoring.rankBy) {
      if (key === "head_to_head") {
        const met = headToHead(x.entryId, y.entryId);
        if (met === x.entryId) return -1;
        if (met === y.entryId) return 1;
        continue;
      }
      const by = value[key](y) - value[key](x);
      if (by !== 0) return by;
    }
    return x.entryId - y.entryId;
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

/** A slot's time, as `scheduleMatches` keys who is busy: "2026-11-20:0540". */
export const slotTime = (s: Pick<Slot, "date" | "minute">) => `${s.date}:${String(s.minute).padStart(4, "0")}`;

/**
 * Fit matches into the hours held, earliest first, so that nobody plays two
 * at once and a match starts only after the ones feeding it have finished.
 * One match a slot on a court (the slots of one tournament are all one match
 * long). `alreadyBusy` is who plays elsewhere then (another division of the
 * same competition), by slot time. Returns where each goes, or the number of
 * matches that did not fit.
 */
export function scheduleMatches(
  matches: ToSchedule[],
  slots: Slot[],
  alreadyBusy: Map<string, Set<string>> = new Map()
): { ok: true; placed: Map<string, Slot> } | { ok: false; unplaced: number } {
  const ordered = [...slots].sort((a, b) => a.date.localeCompare(b.date) || a.minute - b.minute || a.courtId - b.courtId);
  const taken = new Set<number>();
  // "date:minute" → sides playing then
  const busy = new Map<string, Set<string>>([...alreadyBusy].map(([k, v]) => [k, new Set(v)]));
  const at = new Map<string, number>(); // key → index of its slot
  const placed = new Map<string, Slot>();
  let unplaced = 0;
  const time = slotTime;

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
