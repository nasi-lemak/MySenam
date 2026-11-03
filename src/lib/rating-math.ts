/**
 * The arithmetic of ratings, apart from the database (docs/features/tournaments.md#ratings-and-rankings, ADR 0031).
 *
 * A published, deterministic rule; nothing is learned. It is an Elo-family update with fixed constants
 * (`DEFAULT_RATING_RULES`, kept as install data in `rating_rules`):
 *
 * - everyone starts at `start`;
 * - a side's rating is the average of its members' (a doubles pair, a team's lineup), and the chance it wins is
 *   `1 / (1 + 10^((opposing − own) / scale))`;
 * - each member moves by `K × weight × margin factor × (result − chance)`, with K larger for the first games a
 *   subject plays so newcomers settle faster (`kBands`), a result of 1 for a win, 0.5 for a draw, 0 for a loss;
 * - `weight` is 1 for a match played, `retirementWeight` for a win by retirement (the other side stopped part-way) and
 *   `walkoverWeight` for a walkover (a forfeit is not play: by default it moves nothing and is not counted);
 * - the margin factor exists only where the sport's scoring is a tally of goals or points (`margin`): a winning margin
 *   of one is worth nothing extra, and each further goal adds `step`, up to `cap` goals;
 * - ratings are rounded to two decimals after every update, so a replay gives the same numbers on any machine;
 * - a subject is provisional until it has `provisionalGames` counted results.
 *
 * `replay` is a pure function of the rows in the order given by `orderKey`: running it again over the same rows
 * gives the same ratings. That is the whole of the ratings' state; nothing here updates a rating from a previous one
 * outside the replay.
 */

export type RatingFormat = "singles" | "doubles" | "team";
export const RATING_FORMATS: RatingFormat[] = ["singles", "doubles", "team"];
export type ResultKind = "played" | "walkover" | "retired";

export interface RatingRules {
  start: number;
  /** The scale of the expected-score curve: a side `scale` points ahead is expected to win about 91% of the time. */
  scale: number;
  /** K by games a subject has played before this one: the first `games` use `k`; `null` games is the rest. */
  kBands: { games: number | null; k: number }[];
  /** Counted results before a rating stops being provisional (and can be ranked). */
  provisionalGames: number;
  walkoverWeight: number;
  retirementWeight: number;
  margin: { enabled: boolean; step: number; cap: number };
  /** The lowest rating of each declared level above beginner, to say what level a rating earns. */
  levelFrom: { intermediate: number; advanced: number; competitive: number };
  /** How close two ratings must be for matchmaking to say they are alike. */
  matchBand: number;
  /** Results shown as a player's recent form. */
  formLength: number;
}

export const DEFAULT_RATING_RULES: RatingRules = {
  start: 1000,
  scale: 400,
  kBands: [
    { games: 10, k: 40 },
    { games: 30, k: 24 },
    { games: null, k: 16 },
  ],
  provisionalGames: 8,
  walkoverWeight: 0,
  retirementWeight: 0.5,
  margin: { enabled: true, step: 0.1, cap: 4 },
  levelFrom: { intermediate: 950, advanced: 1100, competitive: 1250 },
  matchBand: 100,
  formLength: 5,
};

const num = (v: unknown, lo: number, hi: number, fallback: number): number => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : fallback);

/** The rules from what is stored (`rating_rules.rules`): anything missing or out of range is the default. */
export function readRatingRules(raw: string | null | undefined): RatingRules {
  let given: Record<string, unknown> = {};
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) given = parsed as Record<string, unknown>;
  } catch {
    given = {};
  }
  const d = DEFAULT_RATING_RULES;
  const margin = (given.margin && typeof given.margin === "object" ? given.margin : {}) as Record<string, unknown>;
  const from = (given.levelFrom && typeof given.levelFrom === "object" ? given.levelFrom : {}) as Record<string, unknown>;
  let kBands = d.kBands;
  if (Array.isArray(given.kBands) && given.kBands.length > 0) {
    const bands = (given.kBands as Record<string, unknown>[]).map((b) => ({ games: b.games === null ? null : num(b.games, 1, 100000, NaN), k: num(b.k, 1, 200, NaN) }));
    const ok =
      bands.every((b) => !Number.isNaN(b.k) && (b.games === null || !Number.isNaN(b.games))) &&
      bands.every((b, i) => (b.games === null ? i === bands.length - 1 : i === bands.length - 1 ? false : (bands[i + 1].games === null || b.games < (bands[i + 1].games as number))));
    if (ok && bands[bands.length - 1].games === null) kBands = bands;
  }
  const intermediate = num(from.intermediate, 0, 5000, d.levelFrom.intermediate);
  const advanced = num(from.advanced, 0, 5000, d.levelFrom.advanced);
  const competitive = num(from.competitive, 0, 5000, d.levelFrom.competitive);
  const ordered = intermediate < advanced && advanced < competitive;
  return {
    start: num(given.start, 100, 5000, d.start),
    scale: num(given.scale, 50, 2000, d.scale),
    kBands,
    provisionalGames: Math.round(num(given.provisionalGames, 1, 200, d.provisionalGames)),
    walkoverWeight: num(given.walkoverWeight, 0, 1, d.walkoverWeight),
    retirementWeight: num(given.retirementWeight, 0, 1, d.retirementWeight),
    margin: { enabled: margin.enabled === false ? false : d.margin.enabled, step: num(margin.step, 0, 1, d.margin.step), cap: Math.round(num(margin.cap, 0, 50, d.margin.cap)) },
    levelFrom: ordered ? { intermediate, advanced, competitive } : d.levelFrom,
    matchBand: Math.round(num(given.matchBand, 1, 1000, d.matchBand)),
    formLength: Math.round(num(given.formLength, 1, 20, d.formLength)),
  };
}

export const round2 = (x: number): number => Math.round(x * 100) / 100;

/** K for a subject that has `games` counted results behind it. */
export function kFor(rules: RatingRules, games: number): number {
  for (const band of rules.kBands) if (band.games === null || games < band.games) return band.k;
  return rules.kBands[rules.kBands.length - 1].k;
}

/** The chance (0 to 1) a side rated `own` wins against one rated `other`. */
export function expectedScore(rules: RatingRules, own: number, other: number): number {
  return 1 / (1 + Math.pow(10, (other - own) / rules.scale));
}

/** How much a result counts for: a match played 1, a retirement and a walkover as the rules say. */
export function weightOf(rules: RatingRules, kind: ResultKind): number {
  return kind === "played" ? 1 : kind === "retired" ? rules.retirementWeight : rules.walkoverWeight;
}

/** Extra for a decisive tally (goals, points): 1 up to a margin of one, then `step` more for each further goal up to `cap`. */
export function marginFactor(rules: RatingRules, margin: number | null): number {
  if (!rules.margin.enabled || margin === null || margin <= 1) return 1;
  return round2(1 + Math.min(margin - 1, rules.margin.cap) * rules.margin.step);
}

export type Level = "beginner" | "intermediate" | "advanced" | "competitive";

/** The declared level a rating corresponds to, by the published thresholds. */
export function levelOfRating(rules: RatingRules, rating: number): Level {
  const f = rules.levelFrom;
  return rating >= f.competitive ? "competitive" : rating >= f.advanced ? "advanced" : rating >= f.intermediate ? "intermediate" : "beginner";
}

// ------------------------------------------------------------ the replay

/** One side's member: a subject the replay keeps a rating for, or a removed one standing at the rating it had. */
export interface ReplayMember {
  /** "user:12", "participant:3", "team:7", or "removed:<n>" for one erased. */
  key: string;
  frozen?: number;
}

export interface ReplayRow {
  id: number;
  /** Sorts the ledger into the order it is replayed in (`orderKey`). */
  order: string;
  /** Side a's result: 1, 0.5 or 0. */
  outcome: number;
  kind: ResultKind;
  margin: number | null;
  a: ReplayMember[];
  b: ReplayMember[];
}

export interface SubjectState {
  rating: number;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  lastOrder: string | null;
}

export interface MemberOutcome {
  before: number;
  after: number;
  k: number;
  gamesBefore: number;
}

export interface RowOutcome {
  weight: number;
  marginFactor: number;
  sideA: number;
  sideB: number;
  expectedA: number;
  members: Map<string, MemberOutcome>;
}

export interface ReplayResult {
  subjects: Map<string, SubjectState>;
  rows: Map<number, RowOutcome>;
}

const fresh = (rules: RatingRules): SubjectState => ({ rating: rules.start, games: 0, wins: 0, draws: 0, losses: 0, lastOrder: null });

/** The key that puts ledger rows in order: when it was played, then the event and match, so the order never depends on when a row was written. */
export function orderKey(r: { playedOn: string; playOrder: number; sourceKind: string; sourceId: number; sourceMatch: number; unitNo: number }): string {
  const pad = (n: number, w: number) => String(Math.max(0, Math.trunc(n))).padStart(w, "0");
  return `${r.playedOn}|${pad(r.playOrder, 6)}|${r.sourceKind}|${pad(r.sourceId, 10)}|${pad(r.sourceMatch, 10)}|${pad(r.unitNo, 3)}`;
}

/**
 * Replay a pool's rows in order and say where everybody stands and what each row did. `resets` maps a member's key to the
 * order key of the last of its results a manager reset it after: the member starts again from the starting rating
 * with the first row after that (their earlier results still counted for the people they played, at the rating they had then).
 * Rows are sorted here by `order`, so the caller's order does not matter.
 */
export function replay(rowsIn: ReplayRow[], rules: RatingRules, resets: Map<string, string> = new Map()): ReplayResult {
  const rows = [...rowsIn].sort((x, y) => (x.order < y.order ? -1 : x.order > y.order ? 1 : x.id - y.id));
  const subjects = new Map<string, SubjectState>();
  const resetDone = new Set<string>();
  const stateOf = (m: ReplayMember, order: string): SubjectState => {
    let s = subjects.get(m.key);
    if (!s) {
      s = fresh(rules);
      subjects.set(m.key, s);
    }
    const cut = resets.get(m.key);
    if (cut !== undefined && !resetDone.has(m.key) && order > cut) {
      resetDone.add(m.key);
      Object.assign(s, fresh(rules));
    }
    return s;
  };
  const out = new Map<number, RowOutcome>();
  for (const row of rows) {
    const sides = { a: row.a, b: row.b };
    const states = new Map<string, SubjectState>();
    const ratingOf = (m: ReplayMember): number => (m.frozen !== undefined ? m.frozen : stateOf(m, row.order).rating);
    const mean = (ms: ReplayMember[]): number => (ms.length === 0 ? rules.start : round2(ms.reduce((sum, m) => sum + ratingOf(m), 0) / ms.length));
    const sideA = mean(sides.a);
    const sideB = mean(sides.b);
    const expectedA = expectedScore(rules, sideA, sideB);
    const weight = weightOf(rules, row.kind);
    const mf = marginFactor(rules, row.margin);
    const members = new Map<string, MemberOutcome>();
    const plan: { m: ReplayMember; s: SubjectState; result: number; delta: number; k: number; before: number; gamesBefore: number }[] = [];
    for (const side of ["a", "b"] as const) {
      const result = side === "a" ? row.outcome : 1 - row.outcome;
      const expected = side === "a" ? expectedA : 1 - expectedA;
      for (const m of sides[side]) {
        if (m.frozen !== undefined) {
          members.set(`${side}:${m.key}`, { before: m.frozen, after: m.frozen, k: 0, gamesBefore: 0 });
          continue;
        }
        const s = stateOf(m, row.order);
        states.set(m.key, s);
        const k = kFor(rules, s.games);
        plan.push({ m, s, result, delta: k * weight * mf * (result - expected), k, before: s.rating, gamesBefore: s.games });
      }
    }
    // Everyone moves from the ratings the row found them at.
    for (const p of plan) {
      const after = round2(p.before + p.delta);
      p.s.rating = after;
      if (weight > 0) {
        p.s.games += 1;
        if (p.result === 1) p.s.wins += 1;
        else if (p.result === 0) p.s.losses += 1;
        else p.s.draws += 1;
        p.s.lastOrder = row.order;
      }
      const side = row.a.includes(p.m) ? "a" : "b";
      members.set(`${side}:${p.m.key}`, { before: p.before, after, k: p.k, gamesBefore: p.gamesBefore });
    }
    out.set(row.id, { weight, marginFactor: mf, sideA, sideB, expectedA: Math.round(expectedA * 100000) / 100000, members });
  }
  // A reset with nothing played after it leaves the subject at the start.
  for (const [key, cut] of resets) {
    const s = subjects.get(key);
    if (s && !resetDone.has(key) && !(s.lastOrder !== null && s.lastOrder > cut)) Object.assign(s, fresh(rules));
  }
  return { subjects, rows: out };
}

/** A rating is provisional until it has `provisionalGames` counted results; provisional ratings are never ranked. */
export const isProvisional = (rules: RatingRules, games: number): boolean => games < rules.provisionalGames;
