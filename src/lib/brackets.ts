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
  /** Sets won and lost, for a set ratio. */
  setsWon: number;
  setsLost: number;
  /** Points (or goals) scored and conceded, and the difference. */
  pointsFor: number;
  pointsAgainst: number;
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
  /** Given as a walkover (a forfeit): counted at the rules' walkover score, where they set one. */
  walkover?: boolean;
}

/**
 * A group's table, ranked by the rules' keys in order (by default most wins,
 * then the better set difference, then points, then whoever won when two
 * level on all that met), the entry's id settling anything still level. A
 * walkover counts at the rules' walkover score where they set one, else as a
 * win with no sets or points either way; a retirement as
 * a win, with its partial score counted only where the rules say "as_played".
 */
export function standings(
  entryIds: number[],
  results: TableResult[],
  scoring: Pick<ScoringRules, "kind" | "tablePoints" | "rankBy" | "retired"> & Partial<Pick<ScoringRules, "setPoints" | "bestOf" | "walkover">> = DEFAULT_SCORING
): Standing[] {
  const table = new Map<number, Standing>(
    entryIds.map((id) => [id, { entryId: id, played: 0, won: 0, drawn: 0, lost: 0, setDiff: 0, setsWon: 0, setsLost: 0, pointsFor: 0, pointsAgainst: 0, pointDiff: 0, points: 0 }])
  );
  for (const given of results) {
    if (given.winner === null && !given.draw) continue;
    // A walkover counts at the rules' forfeit score where they set one, the winner's side first.
    const r =
      given.walkover && scoring.walkover && given.winner !== null
        ? { ...given, score: given.winner === given.a ? scoring.walkover : flipScore(scoring.walkover) }
        : given;
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
      a.pointsAgainst += t.b;
      b.pointsAgainst += t.a;
      a.pointDiff += t.a - t.b;
      b.pointDiff += t.b - t.a;
    } else {
      const parsed = parseScore(r.score);
      if (!parsed) continue;
      a.setDiff += parsed.setsA - parsed.setsB;
      b.setDiff += parsed.setsB - parsed.setsA;
      a.setsWon += parsed.setsA;
      a.setsLost += parsed.setsB;
      b.setsWon += parsed.setsB;
      b.setsLost += parsed.setsA;
      a.pointsFor += parsed.pointsA;
      b.pointsFor += parsed.pointsB;
      a.pointsAgainst += parsed.pointsB;
      b.pointsAgainst += parsed.pointsA;
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
    // Won over lost (volleyball's set and point quotients); none lost ranks above any ratio.
    set_ratio: (s) => ratio(s.setsWon, s.setsLost),
    point_diff: (s) => s.pointDiff,
    point_ratio: (s) => ratio(s.pointsFor, s.pointsAgainst),
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
      const [vy, vx] = [value[key](y), value[key](x)];
      if (vy !== vx) return vy > vx ? 1 : -1;
    }
    return x.entryId - y.entryId;
  });
}

/** Won over lost, with nothing lost above every ratio and nothing at all at the foot. */
function ratio(won: number, lost: number): number {
  if (lost === 0) return won === 0 ? 0 : Number.MAX_SAFE_INTEGER;
  return won / lost;
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

/** Time a tournament holds on one court on one day, in minutes of the day. */
export interface Window {
  courtId: number;
  date: string;
  start: number;
  end: number;
}

/** A match to place, with how long it is given on court. */
export interface TimedMatch extends ToSchedule {
  minutes: number;
  /**
   * Sides that may yet play it, where who plays is still to be decided:
   * kept clear of `sideBusy` (another division's matches), not of this
   * draw's own matches, which the bracket already keeps apart.
   */
  could?: string[];
}

/** Something already on a court, or a side already playing, then. */
export interface Taken {
  courtId?: number;
  date: string;
  start: number;
  end: number;
}

const gcd = (x: number, y: number): number => (y === 0 ? x : gcd(y, x % y));

/** The grid starts fall on: the greatest common divisor of the lengths, so matches of one length keep their old slots. */
export function startStep(minutes: number[]): number {
  return minutes.reduce((g, m) => gcd(g, m), 0) || 60;
}

/**
 * Fit matches of differing lengths into the hours held, earliest first: no
 * court has two at once, nobody plays two at once, and a match starts only
 * once every match feeding it has ended. Starts fall on a grid of `step`
 * minutes counted from `origin` (the tournament's first minute of the day).
 * `occupied` is what else is on the courts then (another division's
 * matches); `sideBusy` is when sides are playing elsewhere, keyed as
 * `ToSchedule.sides` are, and a match's `could` sides are kept clear of it too. `allowed` says whether a start may be used (not
 * in the past). With every match one length this places them exactly where
 * `scheduleMatches` does.
 */
export function scheduleTimed(
  matches: TimedMatch[],
  windows: Window[],
  opts: { step: number; origin: number; occupied?: Taken[]; sideBusy?: Map<string, Taken[]>; allowed?: (date: string, minute: number) => boolean }
): { ok: true; placed: Map<string, Slot & { end: number }> } | { ok: false; unplaced: number } {
  const ordered = [...windows].sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start || a.courtId - b.courtId);
  const onCourt = new Map<string, Taken[]>();
  for (const o of opts.occupied ?? []) {
    const k = `${o.courtId}:${o.date}`;
    onCourt.set(k, [...(onCourt.get(k) ?? []), o]);
  }
  const elsewhere = opts.sideBusy ?? new Map<string, Taken[]>();
  const busy = new Map<string, Taken[]>([...elsewhere].map(([k, v]) => [k, [...v]]));
  const overlaps = (list: Taken[] | undefined, date: string, start: number, end: number) => !!list?.some((o) => o.date === date && o.start < end && start < o.end);
  const placed = new Map<string, Slot & { end: number }>();
  let unplaced = 0;

  for (const match of matches) {
    let after: { date: string; minute: number } | null = null;
    let waiting = false;
    for (const k of match.after) {
      const p = placed.get(k);
      if (!p) {
        waiting = true;
        break;
      }
      if (!after || p.date > after.date || (p.date === after.date && p.end > after.minute)) after = { date: p.date, minute: p.end };
    }
    if (waiting) {
      unplaced++;
      continue;
    }
    let best: (Slot & { end: number }) | null = null;
    for (const w of ordered) {
      if (after && w.date < after.date) continue;
      if (best && (w.date > best.date || (w.date === best.date && w.start > best.minute))) break;
      const first = w.start + ((((opts.origin - w.start) % opts.step) + opts.step) % opts.step);
      for (let s = first; s + match.minutes <= w.end; s += opts.step) {
        if (best && w.date === best.date && (s > best.minute || (s === best.minute && w.courtId > best.courtId))) break;
        if (after && w.date === after.date && s < after.minute) continue;
        const end: number = s + match.minutes;
        if (opts.allowed && !opts.allowed(w.date, s)) continue;
        if (overlaps(onCourt.get(`${w.courtId}:${w.date}`), w.date, s, end)) continue;
        if (match.sides.some((side) => overlaps(busy.get(side), w.date, s, end))) continue;
        if (match.could?.some((side) => overlaps(elsewhere.get(side), w.date, s, end))) continue;
        best = { courtId: w.courtId, date: w.date, minute: s, end };
        break;
      }
    }
    if (!best) {
      unplaced++;
      continue;
    }
    const k = `${best.courtId}:${best.date}`;
    onCourt.set(k, [...(onCourt.get(k) ?? []), { courtId: best.courtId, date: best.date, start: best.minute, end: best.end }]);
    for (const side of match.sides) busy.set(side, [...(busy.get(side) ?? []), { date: best.date, start: best.minute, end: best.end }]);
    placed.set(match.key, best);
  }
  return unplaced > 0 ? { ok: false, unplaced } : { ok: true, placed };
}

// ------------------------------------------------------------ structures: consolation draws and double elimination

/**
 * Which bracket a match is in. "main" is the ordinary knockout (stored as no
 * bracket at all); "winners", "losers" and "grand" are a double elimination's;
 * "consolation" is a knockout's first-round losers' draw (ADR 0032).
 */
export type BracketKind = "main" | "winners" | "losers" | "grand" | "consolation";

/** Where one side of a match comes from: an entrant at the draw (null: nobody), the winner or the loser of a match, or nothing. */
type Source = { entry: number | null } | { win: string } | { lose: string } | null;

/** A match as the draw makes it, with the routes its winner and its loser take. */
export interface PlannedMatch {
  key: string;
  bracket: BracketKind;
  round: number;
  position: number;
  /** Known at the draw only in a first round (null with the other side known: a bye). */
  a: number | null;
  b: number | null;
  nextKey: string | null;
  nextSlot: "a" | "b" | null;
  loserNextKey: string | null;
  loserNextSlot: "a" | "b" | null;
  /** Every match that must be over first, on either route. */
  after: string[];
  bye: boolean;
  /** 3: a third-place match. */
  placement?: 3;
  /** The grand final's second match, played where the losers' bracket's champion won the first. */
  reset?: boolean;
}

interface Node {
  key: string;
  bracket: BracketKind;
  round: number;
  position: number;
  src: [Source, Source];
  bye?: boolean;
  placement?: 3;
  reset?: boolean;
}

/**
 * Wire nodes (each side of which says where it comes from) into matches with
 * routes. A match with a source that never exists — the loser of a bye — is not
 * made when its other source is real: that source is wired straight on to where
 * the match's winner would have gone; with neither, it goes too (ADR 0032, D3).
 * Sources outside `nodes` (a knockout's first-round matches, for a consolation
 * draw) are returned as the routes their losers take. Nodes are in creation
 * order, every source before the match it feeds.
 */
function wire(nodes: Node[]): { matches: PlannedMatch[]; losersTo: Map<string, { key: string; slot: "a" | "b" }> } {
  const internal = new Set(nodes.map((n) => n.key));
  const byes = new Set(nodes.filter((n) => n.bye).map((n) => n.key));
  const removed = new Set<string>();
  const alias = new Map<string, Source>();
  const resolve = (s: Source): Source => {
    if (!s || "entry" in s) return s;
    if ("lose" in s) return byes.has(s.lose) || removed.has(s.lose) ? null : s;
    return alias.has(s.win) ? alias.get(s.win)! : s;
  };
  const kept: { node: Node; src: [Source, Source] }[] = [];
  for (const node of nodes) {
    const src: [Source, Source] = [resolve(node.src[0]), resolve(node.src[1])];
    if (node.bye) {
      kept.push({ node, src });
      continue;
    }
    const live = src.filter((s): s is Exclude<Source, null> => s !== null);
    if (live.length === 2) kept.push({ node, src });
    else {
      removed.add(node.key);
      alias.set(node.key, live[0] ?? null);
    }
  }
  const out = new Map<string, PlannedMatch>();
  const order: PlannedMatch[] = [];
  const counter = new Map<string, number>();
  for (const { node } of kept) {
    const at = `${node.bracket}:${node.round}`;
    // Positions are counted again from 1 among the matches made.
    const position = (counter.get(at) ?? 0) + 1;
    counter.set(at, position);
    const m: PlannedMatch = {
      key: node.key,
      bracket: node.bracket,
      round: node.round,
      position,
      a: null,
      b: null,
      nextKey: null,
      nextSlot: null,
      loserNextKey: null,
      loserNextSlot: null,
      after: [],
      bye: Boolean(node.bye),
      ...(node.placement ? { placement: node.placement } : {}),
      ...(node.reset ? { reset: true } : {}),
    };
    out.set(node.key, m);
    order.push(m);
  }
  const losersTo = new Map<string, { key: string; slot: "a" | "b" }>();
  for (const { node, src } of kept) {
    const m = out.get(node.key)!;
    (["a", "b"] as const).forEach((slot, i) => {
      const s = src[i];
      if (!s) return;
      if ("entry" in s) m[slot] = s.entry;
      else if ("win" in s) {
        const from = out.get(s.win)!;
        from.nextKey = m.key;
        from.nextSlot = slot;
        m.after.push(s.win);
      } else {
        const from = internal.has(s.lose) ? out.get(s.lose)! : null;
        if (from) {
          from.loserNextKey = m.key;
          from.loserNextSlot = slot;
        } else losersTo.set(s.lose, { key: m.key, slot });
        m.after.push(s.lose);
      }
    });
  }
  return { matches: order, losersTo };
}

/** The winners' bracket of a knockout of `size` lines: keys `w{round}-{position}`. */
function winnersNodes(size: number, firstPairs: [number | null, number | null][]): Node[] {
  const nodes: Node[] = [];
  const rounds = Math.log2(size);
  for (let r = 1; r <= rounds; r++)
    for (let p = 1; p <= size / 2 ** r; p++) {
      const pair = r === 1 ? firstPairs[p - 1] : null;
      nodes.push({
        key: `w${r}-${p}`,
        bracket: "winners",
        round: r,
        position: p,
        src: pair ? [{ entry: pair[0] }, { entry: pair[1] }] : [{ win: `w${r - 1}-${2 * p - 1}` }, { win: `w${r - 1}-${2 * p}` }],
        ...(pair && (pair[0] === null) !== (pair[1] === null) ? { bye: true } : {}),
      });
    }
  return nodes;
}

/**
 * A double elimination of `size` lines (4 or more, a power of two), `firstPairs`
 * the winners' first round as `firstRound` makes it, null a bye. Winners' bracket
 * `w{r}-{p}`; losers' bracket `l{round}-{position}` of rounds 1 to 2k-2 (k the
 * winners' rounds): round 1 pairs the first round's losers, each *drop* round
 * 2r-2 has the survivor of the round before play the loser of winners' round r —
 * those dropping in reversed where r is even, in order where it is odd, so a
 * loser meets nobody they have played in their first losers' matches — and each
 * consolidation round 2r-3 pairs the winners of a drop round. The winners'
 * champion and the losers' champion meet in the grand final `gf`; with `reset`,
 * `gf2` is the match played again between the same two if the losers' champion
 * won it: the grand final's winner goes to its first side and its loser to its
 * second (the same two whichever won), and it is *not needed* when the winners'
 * champion wins (lib/tournaments.ts settles that).
 */
export function doubleElimination(size: number, firstPairs: [number | null, number | null][], reset: boolean): PlannedMatch[] {
  const k = Math.log2(size);
  const nodes = winnersNodes(size, firstPairs);
  for (let i = 1; i <= size / 4; i++)
    nodes.push({ key: `l1-${i}`, bracket: "losers", round: 1, position: i, src: [{ lose: `w1-${2 * i - 1}` }, { lose: `w1-${2 * i}` }] });
  let previous = 1;
  for (let r = 2; r <= k; r++) {
    const m = size / 2 ** r;
    if (r >= 3) {
      const round = 2 * r - 3;
      for (let p = 1; p <= m; p++)
        nodes.push({ key: `l${round}-${p}`, bracket: "losers", round, position: p, src: [{ win: `l${previous}-${2 * p - 1}` }, { win: `l${previous}-${2 * p}` }] });
      previous = round;
    }
    const drop = 2 * r - 2;
    for (let p = 1; p <= m; p++)
      nodes.push({ key: `l${drop}-${p}`, bracket: "losers", round: drop, position: p, src: [{ win: `l${previous}-${p}` }, { lose: `w${r}-${r % 2 === 0 ? m + 1 - p : p}` }] });
    previous = drop;
  }
  nodes.push({ key: "gf", bracket: "grand", round: 1, position: 1, src: [{ win: `w${k}-1` }, { win: `l${2 * k - 2}-1` }] });
  if (reset) nodes.push({ key: "gf2", bracket: "grand", round: 2, position: 1, src: [{ win: "gf" }, { lose: "gf" }], reset: true });
  return wire(nodes).matches;
}

/**
 * A first-round consolation draw for a knockout of `size` lines (8 or more,
 * keys `k1-{p}` for its first round, as the knockout makes them): a knockout
 * of the first-round matches' losers, keys `c{round}-{position}`, or null where
 * there would be fewer than two first-round matches played. Its lines are seeded by
 * how close the matches were — the closest, whose loser is expected to be the
 * strongest, first — and byes go to the top lines. With `thirdPlace`, the
 * consolation semi-finals' losers play for third (`c3p`), where both are matches
 * played. `losersTo` is where each first-round loser goes (their match's key).
 */
export function consolationDraw(
  size: number,
  firstPairs: [number | null, number | null][],
  thirdPlace: boolean
): { matches: PlannedMatch[]; losersTo: Map<string, { key: string; slot: "a" | "b" }> } | null {
  if (size < 8) return null;
  const order = seedOrder(size);
  const real = firstPairs
    .map((pair, i) => ({ key: `k1-${i + 1}`, favourite: order[2 * i], real: pair[0] !== null && pair[1] !== null }))
    .filter((x) => x.real)
    .sort((x, y) => y.favourite - x.favourite);
  if (real.length < 2) return null;
  const lines = bracketSize(real.length);
  const seeds = seedOrder(lines);
  const rounds = Math.log2(lines);
  const nodes: Node[] = [];
  for (let i = 0; i < lines / 2; i++) {
    const line = (seed: number): Source => (seed <= real.length ? { lose: real[seed - 1].key } : null);
    nodes.push({ key: `c1-${i + 1}`, bracket: "consolation", round: 1, position: i + 1, src: [line(seeds[2 * i]), line(seeds[2 * i + 1])] });
  }
  for (let r = 2; r <= rounds; r++)
    for (let p = 1; p <= lines / 2 ** r; p++)
      nodes.push({ key: `c${r}-${p}`, bracket: "consolation", round: r, position: p, src: [{ win: `c${r - 1}-${2 * p - 1}` }, { win: `c${r - 1}-${2 * p}` }] });
  if (thirdPlace && rounds >= 2)
    nodes.push({ key: "c3p", bracket: "consolation", round: rounds, position: 2, placement: 3, src: [{ lose: `c${rounds - 1}-1` }, { lose: `c${rounds - 1}-2` }] });
  return wire(nodes);
}

/**
 * A feed-in consolation draw for a knockout of `size` lines (8 or more, keys `k{round}-{position}` as the knockout makes
 * them; ADR 0034): the loser of every match of the main draw's rounds 1 to k-1 (k its rounds) plays on, the runner-up
 * alone does not. It is the losers' bracket of `doubleElimination` without the winners' final's loser and the grand
 * final: round 1 pairs the first round's losers, each drop round 2r-2 has the survivor of the round before play the loser of
 * the main draw's round r (reversed where r is even, as in ADR 0032 E3), each consolidation round 2r-3 pairs the winners of
 * a drop round, and the last, round 2k-3 (the *consolation final*), pairs the winners of the drop round of the semi-finals'
 * losers. Sources that never exist (the loser of a bye) are compressed away as everywhere (D3). With `thirdPlace`, the
 * losers of the last drop round's two matches play `c3p`, where both are matches played. `losersTo` is where each main
 * match's loser goes (their match's key).
 */
export function feedInConsolation(
  size: number,
  firstPairs: [number | null, number | null][],
  thirdPlace: boolean
): { matches: PlannedMatch[]; losersTo: Map<string, { key: string; slot: "a" | "b" }> } | null {
  if (size < 8) return null;
  const k = Math.log2(size);
  // The loser of a bye is nobody.
  const loserOf = (round: number, position: number): Source => {
    if (round === 1) {
      const pair = firstPairs[position - 1];
      if ((pair[0] === null) !== (pair[1] === null) || (pair[0] === null && pair[1] === null)) return null;
    }
    return { lose: `k${round}-${position}` };
  };
  const nodes: Node[] = [];
  const node = (round: number, position: number, src: [Source, Source], extra: Partial<Node> = {}) =>
    nodes.push({ key: `c${round}-${position}`, bracket: "consolation", round, position, src, ...extra });
  for (let i = 1; i <= size / 4; i++) node(1, i, [loserOf(1, 2 * i - 1), loserOf(1, 2 * i)]);
  let previous = 1;
  for (let r = 2; r <= k - 1; r++) {
    const m = size / 2 ** r;
    if (r >= 3) {
      const round = 2 * r - 3;
      for (let p = 1; p <= m; p++) node(round, p, [{ win: `c${previous}-${2 * p - 1}` }, { win: `c${previous}-${2 * p}` }]);
      previous = round;
    }
    const drop = 2 * r - 2;
    for (let p = 1; p <= m; p++) node(drop, p, [{ win: `c${previous}-${p}` }, loserOf(r, r % 2 === 0 ? m + 1 - p : p)]);
    previous = drop;
  }
  const last = 2 * k - 3;
  node(last, 1, [{ win: `c${previous}-1` }, { win: `c${previous}-2` }]);
  if (thirdPlace) node(last, 2, [{ lose: `c${previous}-1` }, { lose: `c${previous}-2` }], { placement: 3 });
  return wire(nodes);
}

/** What a feed-in consolation draw adds to a knockout of `entries`, worked out from the structure it is built as (ADR 0034, M). */
export interface FeedInConsequences {
  entries: number;
  /** The main draw's matches played, n - 1. */
  mainMatches: number;
  /** The consolation draw's, its third-place match included. */
  consolationMatches: number;
  totalMatches: number;
  /** Minutes on court: the main draw's (its final at the final's length), the consolation draw's, and the whole. */
  mainMinutes: number;
  consolationMinutes: number;
  totalMinutes: number;
  /** Rounds in the main draw alone, and the most matches one after the other in the whole event (the longest chain of matches that must follow each other). */
  mainRounds: number;
  rounds: number;
  /** The most matches any one entrant can play (win the main draw's rounds, or drop and win every consolation match). */
  mostMatches: number;
  /** Entrants who are in the consolation draw at some point: everybody who loses a match of the main draw but its final. */
  consolationEntrants: number;
}

/**
 * The consequences of a feed-in consolation draw for `entries` (null where there is none to make: fewer than five entries, a
 * main draw below eight lines). `minutes` are the lengths of the main draw's matches, its final and a consolation match.
 */
export function feedInConsequences(entries: number, thirdPlace: boolean, minutes: { knockout: number; final: number; consolation: number }): FeedInConsequences | null {
  if (!Number.isInteger(entries) || entries < 2) return null;
  const size = bracketSize(entries);
  const pairs = firstRound(Array.from({ length: entries }, (_, i) => i + 1));
  const plan = feedInConsolation(size, pairs, thirdPlace);
  if (!plan) return null;
  const k = Math.log2(size);
  // The main draw as the knockout makes it: byes are not matches.
  interface M { after: string[]; next: string | null; loserNext: string | null; bye: boolean; minutes: number }
  const all = new Map<string, M>();
  for (let r = 1; r <= k; r++)
    for (let p = 1; p <= size / 2 ** r; p++) {
      const pair = r === 1 ? pairs[p - 1] : null;
      const key = `k${r}-${p}`;
      all.set(key, {
        after: r === 1 ? [] : [`k${r - 1}-${2 * p - 1}`, `k${r - 1}-${2 * p}`],
        next: r < k ? `k${r + 1}-${Math.ceil(p / 2)}` : null,
        loserNext: plan.losersTo.get(key)?.key ?? null,
        bye: pair !== null && (pair[0] === null) !== (pair[1] === null),
        minutes: r === k ? minutes.final : minutes.knockout,
      });
    }
  for (const m of plan.matches)
    all.set(m.key, { after: m.after, next: m.nextKey, loserNext: m.loserNextKey, bye: false, minutes: minutes.consolation });
  const depth = new Map<string, number>();
  const depthOf = (key: string): number => {
    if (depth.has(key)) return depth.get(key)!;
    const m = all.get(key)!;
    const d = m.bye ? 0 : 1 + Math.max(0, ...m.after.map(depthOf));
    depth.set(key, d);
    return d;
  };
  const most = new Map<string, number>();
  const mostFrom = (key: string | null): number => {
    if (key === null) return 0;
    if (most.has(key)) return most.get(key)!;
    const m = all.get(key)!;
    const n = (m.bye ? 0 : 1) + Math.max(mostFrom(m.next), mostFrom(m.loserNext));
    most.set(key, n);
    return n;
  };
  const real = [...all].filter(([, m]) => !m.bye);
  const main = real.filter(([key]) => key.startsWith("k"));
  const mainMinutes = main.reduce((s, [, m]) => s + m.minutes, 0);
  const consolationMinutes = plan.matches.length * minutes.consolation;
  const firstRoundKeys = [...all.keys()].filter((key) => key.startsWith("k1-"));
  return {
    entries,
    mainMatches: main.length,
    consolationMatches: plan.matches.length,
    totalMatches: main.length + plan.matches.length,
    mainMinutes,
    consolationMinutes,
    totalMinutes: mainMinutes + consolationMinutes,
    mainRounds: k,
    rounds: Math.max(...[...all.keys()].map(depthOf)),
    mostMatches: Math.max(...firstRoundKeys.map((key) => mostFrom(key))),
    consolationEntrants: plan.losersTo.size,
  };
}

/** What an organiser has set, as the preview of a feed-in consolation draw reads it (lib/tournaments.ts `feedInPreview`). */
export interface FeedInSetup {
  matchMinutes: number;
  /** Match length by stage, over `matchMinutes`. */
  stageMinutes: Partial<Record<string, number>>;
  courts: number;
  days: number;
  /** The time each day, in minutes of the day. */
  startMin: number;
  endMin: number;
  /** The most it takes, and those entered. */
  maxEntries: number;
  entered: number;
}

/** What a feed-in consolation draw would add for a tournament's entries, and whether the time it holds could hold it (ADR 0034, M). */
export interface FeedInPreview {
  /** The entries counted: those entered, or the most it takes while fewer than five have entered. */
  entries: number;
  /** Null where there is no consolation draw to make (fewer than five entries). */
  consequences: FeedInConsequences | null;
  /** Court time held in all (courts x hours each day x days), in minutes, and what the whole event needs of it: an estimate, since the draw itself fits every match and refuses, changing nothing, if one does not fit. */
  heldMinutes: number;
  needMinutes: number;
  fitsHeld: boolean;
}

export function feedInPreview(setup: FeedInSetup, consolationThirdPlace: boolean, entries?: number): FeedInPreview {
  const counted = entries ?? (setup.entered >= 5 ? setup.entered : setup.maxEntries);
  const length = (stage: string) => setup.stageMinutes[stage] ?? setup.matchMinutes;
  const consequences = feedInConsequences(counted, consolationThirdPlace, { knockout: length("knockout"), final: length("final"), consolation: length("consolation") });
  const heldMinutes = setup.courts * (setup.endMin - setup.startMin) * Math.max(1, setup.days);
  const needMinutes = consequences?.totalMinutes ?? 0;
  return { entries: counted, consequences, heldMinutes, needMinutes, fitsHeld: needMinutes <= heldMinutes };
}

/** The most rounds any bracket's matches have: for naming a round from the end ("final", "semi-final"). */
export function roundsByBracket(matches: { bracket: BracketKind; round: number }[]): Map<BracketKind, number> {
  const rounds = new Map<BracketKind, number>();
  for (const m of matches) rounds.set(m.bracket, Math.max(rounds.get(m.bracket) ?? 0, m.round));
  return rounds;
}

/**
 * What to call a match: a dictionary key and the number to say it with, so a
 * screen can say it in its language. `rounds` is how many rounds its own bracket has.
 */
export function matchLabel(
  m: { stage: string; groupNo: number | null; round: number; placement: 3 | null; bracket: BracketKind },
  rounds: number
): { key: string; n?: number } {
  // A Swiss event's matches are the rounds of its group stage; its `rounds` is -1 (lib/swiss.ts, ADR 0033).
  if (m.stage === "group") return rounds < 0 ? { key: "swiss.ui.round", n: m.round } : { key: "tour.group", n: m.groupNo ?? 0 };
  if (m.bracket === "winners") return m.round === rounds ? { key: "fm1.winnersFinal" } : { key: "fm1.winnersRound", n: m.round };
  if (m.bracket === "losers") return m.round === rounds ? { key: "fm1.losersFinal" } : { key: "fm1.losersRound", n: m.round };
  if (m.bracket === "grand") return m.round === 1 ? { key: "fm1.grandFinal" } : { key: "fm1.reset" };
  if (m.bracket === "consolation") {
    if (m.placement === 3) return { key: "fm1.consolationThird" };
    return m.round === rounds ? { key: "fm1.consolationFinal" } : { key: "fm1.consolationRound", n: m.round };
  }
  if (m.placement === 3) return { key: "tour.thirdPlace" };
  if (m.round === rounds) return { key: "tour.final" };
  if (m.round === rounds - 1) return { key: "tour.semis" };
  if (m.round === rounds - 2) return { key: "tour.quarters" };
  return { key: "tour.round", n: m.round };
}

/** A match as `placings` reads it. */
export interface PlacingMatch {
  bracket: BracketKind;
  round: number;
  placement: 3 | null;
  a: number | null;
  b: number | null;
  winner: number | null;
  status: "scheduled" | "done" | "walkover" | "bye" | "retired";
}

const isPlayed = (m: PlacingMatch) => m.status === "done" || m.status === "walkover" || m.status === "retired";

/**
 * Where everybody finished, once a knockout or a double elimination is over
 * (null while any match is still to play): one place each, level entrants
 * sharing one (joint third, where there is no third-place match). Entrants are
 * put in order of how late they were put out: the champion, the runner-up, the
 * third-place match's two, then each earlier round's losers together, deepest
 * first. With a consolation draw those who won a first-round match, or had a
 * bye, come first, then the consolation draw's own order (with a feed-in consolation draw: the champion and the runner-up, then the
 * consolation draw's own order, its champion third). In a double
 * elimination: the champion and runner-up (from the reset where it was played),
 * then those put out of the losers' bracket, the last round first. An entrant who
 * left stands where the matches put them (ADR 0032, F).
 */
export function placings(matches: PlacingMatch[], opts: { feedIn?: boolean } = {}): { entryId: number; place: number }[] | null {
  if (matches.length === 0 || matches.some((m) => m.status === "scheduled")) return null;
  const loserOf = (m: PlacingMatch | undefined): number | null => (m && isPlayed(m) && m.winner !== null ? (m.winner === m.a ? m.b : m.a) : null);
  const winnerOf = (m: PlacingMatch | undefined): number | null => (m && isPlayed(m) ? m.winner : null);
  const losersOfRound = (list: PlacingMatch[], round: number) => list.filter((m) => m.round === round && m.placement === null).map(loserOf);
  const stages: (number | null)[][] = [];
  const knockoutStages = (list: PlacingMatch[], lowest: number) => {
    const rounds = Math.max(0, ...list.map((m) => m.round));
    const final = list.find((m) => m.round === rounds && m.placement === null);
    const third = list.find((m) => m.placement === 3);
    stages.push([winnerOf(final)], [loserOf(final)]);
    if (third) stages.push([winnerOf(third)], [loserOf(third)]);
    for (let r = rounds - 1; r >= lowest; r--) stages.push(losersOfRound(list, r));
  };
  if (matches.some((m) => m.bracket === "grand")) {
    const gf = matches.find((m) => m.bracket === "grand" && m.round === 1);
    const reset = matches.find((m) => m.bracket === "grand" && m.round === 2);
    const last = reset && isPlayed(reset) ? reset : gf;
    stages.push([winnerOf(last)], [loserOf(last)]);
    const losers = matches.filter((m) => m.bracket === "losers");
    for (let r = Math.max(0, ...losers.map((m) => m.round)); r >= 1; r--) stages.push(losersOfRound(losers, r));
  } else {
    const main = matches.filter((m) => m.bracket === "main");
    const consolation = matches.filter((m) => m.bracket === "consolation");
    // Those who lost a first-round match played go to the consolation draw: they are placed after the main draw's.
    // A feed-in consolation draw takes every loser but the runner-up: the main draw places only its final's two (ADR 0034, F).
    knockoutStages(main, consolation.length > 0 ? (opts.feedIn ? Math.max(0, ...main.map((m) => m.round)) : 2) : 1);
    if (consolation.length > 0) knockoutStages(consolation, 1);
  }
  const place = new Map<number, number>();
  for (const stage of stages) {
    const fresh = [...new Set(stage.filter((e): e is number => e !== null && !place.has(e)))];
    const at = place.size + 1;
    for (const e of fresh) place.set(e, at);
  }
  return [...place].map(([entryId, p]) => ({ entryId, place: p })).sort((x, y) => x.place - y.place || x.entryId - y.entryId);
}
