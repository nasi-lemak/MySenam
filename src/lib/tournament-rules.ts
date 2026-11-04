/**
 * How a competition is scored and ranked, and how it treats an entrant who
 * leaves it, as data: one engine, with rules a tournament sets — usually
 * from its sport's template (lib/competition-templates.ts) — rather than an
 * engine per sport (ADR 0013).
 *
 * Whatever the rules, an entrant who is out goes no further: the matches
 * they have left are walkovers to the other side, and they never take a
 * place that sends somebody on. What the rules decide is what happens to the
 * group results they already played — they stand, so the table reflects the
 * matches as played, or they are void, as if those matches had never been,
 * the usual answer to a disqualification — and whether a fee paid online is
 * owed back when they leave before the draw. Knockout results already played
 * always stand; changing those is a correction (lib/tournaments.ts).
 *
 * A tournament stored before scoring was configurable has no `scoring`: it
 * reads as the defaults below, which are exactly how every table was ranked
 * then, so nothing already played is ranked differently.
 */

export type OutReason = "withdrawn" | "retired" | "disqualified";
export const OUT_REASONS: OutReason[] = ["withdrawn", "retired", "disqualified"];
export type OutStage = "before_draw" | "groups" | "knockout";

/** What a table is ranked by, in order; the entry's id settles anything still level. */
export type RankKey = "points" | "wins" | "set_diff" | "set_ratio" | "point_diff" | "point_ratio" | "points_for" | "head_to_head";
export const RANK_KEYS: RankKey[] = ["points", "wins", "set_diff", "set_ratio", "point_diff", "point_ratio", "points_for", "head_to_head"];

export interface ScoringRules {
  /**
   * "sets": a score is sets, "21-15, 18-21, 21-10" (games in tennis), and a
   * set is never level. "tally": one number each side, "3-2" (goals,
   * baskets), which may be level where draws are allowed.
   */
  kind: "sets" | "tally";
  /** Sets: how many a match is the best of (1, 3, 5, 7). Shown and checked: a match is not won by fewer than a majority. */
  bestOf: number;
  /** Tally: a level score is a draw in a group or round robin. A knockout always needs a winner. */
  draws: boolean;
  /** Table points for a win, a draw and a loss, where the table is ranked by points. */
  tablePoints: { win: number; draw: number; loss: number };
  /**
   * Sets only: table points that depend on the set score instead, as
   * volleyball awards them — a win without going the distance (3-0, 3-1),
   * a win in the deciding set (3-2), a loss in it (2-3), a clear loss. Null
   * uses `tablePoints`. A walkover or a retirement counts as clear.
   */
  setPoints: { winClear: number; winDecider: number; loseDecider: number; loseClear: number } | null;
  rankBy: RankKey[];
  /**
   * A match one side stopped part-way (a retirement): won by the other side
   * either way, and recorded with the score as it stood, never one made up.
   * "win_only": the table counts the win and leaves the partial score out of
   * set and point differences. "as_played": the sets and points actually
   * played count, as they stood.
   */
  retired: "win_only" | "as_played";
  /**
   * The score a walkover (a forfeit) counts as in the table, from the
   * winner's side: "3-0" for goals, "25-0, 25-0, 25-0" for sets. Null counts
   * the win and no score, as before forfeits could be scored.
   */
  walkover: string | null;
}

/**
 * What a counted performance (lib/counted-performances.ts) can rank by. Bouldering counts tops (more is better), zones
 * (more), attempts to top (fewer) and attempts to zone (fewer); climbing by height counts the highest hold (more) and
 * the attempts (fewer).
 */
export type CountKey = "tops" | "zones" | "attempts_top" | "attempts_zone" | "height" | "attempts_height";
export const COUNT_KEYS: Record<"boulders" | "height", CountKey[]> = {
  boulders: ["tops", "zones", "attempts_top", "attempts_zone"],
  height: ["height", "attempts_height"],
};

/** A competitor's result as a set of counts, ranked by the keys in order; the entry's id settles nothing: level counts share a place. */
export interface CountedRules {
  /** Bouldering: a top and a zone for each boulder. Height: the highest hold reached on one route. */
  kind: "boulders" | "height";
  /** Boulders in a round (1 to 40); a height event is one route. */
  units: number;
  /** What the round is ranked by, in order: all four for the full format, "tops" then "zones" for the simple club one. */
  rankBy: CountKey[];
  /** Level in the final on every key: the better placing in the heats decides, and only still-level competitors share a place. */
  countback: boolean;
  /** The final's order of start: the worst heat placing first and the best last ("reverse"), or the best first. */
  finalStart: "reverse" | "ranking";
  /** Level for the last place in the final: the organiser chooses who goes through ("choose"), or all of those level do ("all"). */
  cutTies: "choose" | "all";
}

export const DEFAULT_COUNTED: CountedRules = { kind: "boulders", units: 4, rankBy: ["tops", "zones", "attempts_top", "attempts_zone"], countback: false, finalStart: "reverse", cutTies: "choose" };

export interface PerformanceRules {
  /** What is measured: a time (lower is better), a distance or a score. A counted event measures nothing: see `counted`. */
  measure: "time" | "distance" | "score";
  better: "lower" | "higher";
  /** Attempts (or ends, or games) each competitor has in a heat or final. */
  attempts: number;
  /** "best": the best attempt counts, the next best breaks a tie. "total": attempts add up (archery ends, bowling games). */
  aggregate: "best" | "total";
  /** Competitors per heat: lanes, targets. */
  heatSize: number;
  /** How many go from the heats to a final; 0 ranks everybody on their heat results alone. */
  finalSize: number;
  /** Counts instead of a mark: tops and zones, or a height (lib/counted-performances.ts). Absent for the marks above. */
  counted?: CountedRules;
}

/**
 * What a Swiss event breaks ties by after its points, in order (docs/architecture/decisions/0033-swiss-tournaments-and-club-ladders.md):
 * Buchholz (the points of the opponents played), median Buchholz, or any of the competition rules' own ranking keys but the points.
 */
export type SwissTiebreak = "buchholz" | "median_buchholz" | Exclude<RankKey, "points">;
export const SWISS_TIEBREAKS: SwissTiebreak[] = ["buchholz", "median_buchholz", "wins", "set_diff", "set_ratio", "point_diff", "point_ratio", "points_for", "head_to_head"];

/** A Swiss event's settings. Null: the default (rounds ⌈log₂ n⌉ at the draw; a bye worth a win; Buchholz, median Buchholz, then the scoring's own keys). */
export interface SwissRules {
  rounds: number | null;
  byePoints: number | null;
  tiebreaks: SwissTiebreak[] | null;
}

export const DEFAULT_SWISS: SwissRules = { rounds: null, byePoints: null, tiebreaks: null };

/**
 * How a knockout is drawn beyond its first elimination (ADR 0032): a consolation
 * draw for first-round losers (a straight knockout only) with, if wanted, a
 * third-place match of its own; and whether a double elimination's grand final
 * is played again when the losers' bracket's champion wins it.
 */
export interface BracketRules {
  consolation: boolean;
  consolationThirdPlace: boolean;
  grandFinalReset: boolean;
  /**
   * What a consolation draw takes (ADR 0034): "first_round", the losers of the first round (what `consolation` has always meant,
   * and what is meant where this is absent), or the advanced "feed_in", every loser of the main draw but its runner-up. Stored
   * only for "feed_in", so what was stored before reads as it did.
   */
  consolationMode?: ConsolationMode;
}

export type ConsolationMode = "first_round" | "feed_in";
export const CONSOLATION_MODES: ConsolationMode[] = ["first_round", "feed_in"];

/** Is this a feed-in consolation draw (an advanced format: every loser of the main draw but its runner-up plays on)? */
export const isFeedIn = (b: Pick<BracketRules, "consolation" | "consolationMode">) => b.consolation && b.consolationMode === "feed_in";

export interface CompetitionRules {
  /** Group results already played by somebody who withdrew or retired. */
  groupResultsOnWithdrawal: "stand" | "void";
  /** Group results already played by somebody disqualified. */
  groupResultsOnDisqualification: "stand" | "void";
  /** A fee paid online is owed back to somebody who leaves before the draw. */
  refundBeforeDraw: boolean;
  scoring: ScoringRules;
  /** Only for a performance event. */
  performance: PerformanceRules | null;
  /** Only for a Swiss event (absent otherwise). */
  swiss?: SwissRules | null;
  /** A consolation draw, and a double elimination's grand-final reset. */
  bracket: BracketRules;
}

/** How every table was ranked before scoring could be chosen: wins, sets, points, then who beat whom. */
export const DEFAULT_SCORING: ScoringRules = {
  kind: "sets",
  bestOf: 3,
  draws: false,
  tablePoints: { win: 1, draw: 0, loss: 0 },
  setPoints: null,
  rankBy: ["wins", "set_diff", "point_diff", "head_to_head"],
  retired: "win_only",
  walkover: null,
};

export const DEFAULT_PERFORMANCE: PerformanceRules = { measure: "time", better: "lower", attempts: 1, aggregate: "best", heatSize: 8, finalSize: 8 };

/** No consolation draw, and a double elimination's grand final played again where the losers' champion wins it. */
export const DEFAULT_BRACKET: BracketRules = { consolation: false, consolationThirdPlace: false, grandFinalReset: true };

/** What every tournament had before rules could be chosen, and what one starts with when its sport has no template. */
export const DEFAULT_RULES: CompetitionRules = {
  groupResultsOnWithdrawal: "stand",
  groupResultsOnDisqualification: "void",
  refundBeforeDraw: true,
  scoring: DEFAULT_SCORING,
  performance: null,
  bracket: DEFAULT_BRACKET,
};

function readBracket(raw: unknown): BracketRules {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const consolation = b.consolation === true;
  return {
    consolation,
    consolationThirdPlace: consolation && b.consolationThirdPlace === true,
    grandFinalReset: b.grandFinalReset !== false,
    ...(consolation && b.consolationMode === "feed_in" ? { consolationMode: "feed_in" as const } : {}),
  };
}

const int = (v: unknown, lo: number, hi: number, fallback: number) => (Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? (v as number) : fallback);

function readScoring(raw: unknown): ScoringRules {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const tp = (s.tablePoints && typeof s.tablePoints === "object" ? s.tablePoints : {}) as Record<string, unknown>;
  const rankBy = Array.isArray(s.rankBy) ? (s.rankBy.filter((k) => RANK_KEYS.includes(k as RankKey)) as RankKey[]) : [];
  return {
    kind: s.kind === "tally" ? "tally" : "sets",
    bestOf: [1, 3, 5, 7].includes(s.bestOf as number) ? (s.bestOf as number) : DEFAULT_SCORING.bestOf,
    draws: s.kind === "tally" && s.draws === true,
    tablePoints: {
      win: int(tp.win, 0, 10, DEFAULT_SCORING.tablePoints.win),
      draw: int(tp.draw, 0, 10, DEFAULT_SCORING.tablePoints.draw),
      loss: int(tp.loss, 0, 10, DEFAULT_SCORING.tablePoints.loss),
    },
    setPoints: s.kind !== "tally" ? readSetPoints(s.setPoints) : null,
    rankBy: rankBy.length > 0 ? [...new Set(rankBy)] : DEFAULT_SCORING.rankBy,
    retired: s.retired === "as_played" ? "as_played" : "win_only",
    walkover: walkoverRefusal(s.walkover, s.kind === "tally" ? "tally" : "sets", [1, 3, 5, 7].includes(s.bestOf as number) ? (s.bestOf as number) : DEFAULT_SCORING.bestOf) === null && typeof s.walkover === "string"
      ? s.walkover.trim()
      : null,
  };
}

/**
 * Why a walkover's score cannot be used, or null: one number each side with
 * the winner ahead ("3-0"), or for sets, the majority of a best-of, each set
 * won by the winner ("25-0, 25-0, 25-0" for a best of five).
 */
export function walkoverRefusal(score: unknown, kind: "sets" | "tally", bestOf: number): string | null {
  if (score === null || score === undefined) return null;
  if (typeof score !== "string" || score.trim() === "") return "A walkover's score is written like a result, the winner's side first.";
  const pairs = score.split(",").map((p) => /^\s*(\d{1,3})\s*-\s*(\d{1,3})\s*$/.exec(p));
  if (pairs.some((m) => m === null)) return 'Write a walkover\'s score like "3-0", or "25-0, 25-0" for sets.';
  if (pairs.some((m) => Number(m![1]) <= Number(m![2]))) return "The winner's side of a walkover's score is first, and ahead.";
  if (kind === "tally" && pairs.length !== 1) return 'A walkover in a tally sport is one score, like "3-0".';
  if (kind === "sets" && pairs.length !== Math.ceil(bestOf / 2)) return `A walkover in a best of ${bestOf} is ${Math.ceil(bestOf / 2)} sets.`;
  return null;
}

function readSetPoints(raw: unknown): ScoringRules["setPoints"] {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const keys = ["winClear", "winDecider", "loseDecider", "loseClear"] as const;
  if (keys.some((k) => !Number.isInteger(p[k]) || (p[k] as number) < 0 || (p[k] as number) > 10)) return null;
  return { winClear: p.winClear as number, winDecider: p.winDecider as number, loseDecider: p.loseDecider as number, loseClear: p.loseClear as number };
}

export function readCounted(raw: unknown): CountedRules | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const kind = c.kind === "height" ? "height" : "boulders";
  const allowed = COUNT_KEYS[kind];
  const keys = Array.isArray(c.rankBy) ? [...new Set(c.rankBy.filter((k): k is CountKey => allowed.includes(k as CountKey)))] : [];
  return {
    kind,
    units: kind === "height" ? 1 : int(c.units, 1, 40, DEFAULT_COUNTED.units),
    rankBy: keys.length > 0 ? keys : kind === "height" ? ["height", "attempts_height"] : DEFAULT_COUNTED.rankBy,
    countback: c.countback === true,
    finalStart: c.finalStart === "ranking" ? "ranking" : "reverse",
    cutTies: c.cutTies === "all" ? "all" : "choose",
  };
}

/** Why counted rules cannot be used, or null. */
export function countedRefusal(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return "Counted rules are a set of choices.";
  const c = raw as Record<string, unknown>;
  if (c.kind !== undefined && c.kind !== "boulders" && c.kind !== "height") return 'Counts are of "boulders" or a "height".';
  const kind = c.kind === "height" ? "height" : "boulders";
  if (c.units !== undefined && (!Number.isInteger(c.units) || (c.units as number) < 1 || (c.units as number) > 40)) return "A round has 1 to 40 boulders.";
  if (kind === "height" && c.units !== undefined && c.units !== 1) return "A height event is one route.";
  if (c.rankBy !== undefined && (!Array.isArray(c.rankBy) || c.rankBy.length === 0 || c.rankBy.some((k) => !COUNT_KEYS[kind].includes(k as CountKey)) || new Set(c.rankBy).size !== c.rankBy.length))
    return `Rank by some of, once each: ${COUNT_KEYS[kind].join(", ")}.`;
  if (c.countback !== undefined && typeof c.countback !== "boolean") return "Say whether the heats break a tie in the final.";
  if (c.finalStart !== undefined && c.finalStart !== "reverse" && c.finalStart !== "ranking") return 'The final starts in "reverse" order of the heats, or in "ranking" order.';
  if (c.cutTies !== undefined && c.cutTies !== "choose" && c.cutTies !== "all") return 'Competitors level for the last place in the final: "choose" who goes through, or "all" of them.';
  return null;
}

function readPerformance(raw: unknown): PerformanceRules | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const counted = readCounted(p.counted);
  // A counted event measures nothing and has no attempts to add: these are fixed, so nothing else reads them as a mark.
  if (counted)
    return {
      measure: "score",
      better: "higher",
      attempts: 1,
      aggregate: "best",
      heatSize: int(p.heatSize, 2, 40, DEFAULT_PERFORMANCE.heatSize),
      finalSize: int(p.finalSize, 0, 40, DEFAULT_PERFORMANCE.finalSize),
      counted,
    };
  const measure = p.measure === "distance" || p.measure === "score" ? p.measure : "time";
  return {
    measure,
    better: p.better === "higher" || p.better === "lower" ? p.better : measure === "time" ? "lower" : "higher",
    attempts: int(p.attempts, 1, 12, 1),
    aggregate: p.aggregate === "total" ? "total" : "best",
    heatSize: int(p.heatSize, 2, 40, DEFAULT_PERFORMANCE.heatSize),
    finalSize: int(p.finalSize, 0, 40, DEFAULT_PERFORMANCE.finalSize),
  };
}

function readSwiss(raw: unknown): SwissRules | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const tiebreaks = Array.isArray(s.tiebreaks) ? [...new Set(s.tiebreaks.filter((k) => SWISS_TIEBREAKS.includes(k as SwissTiebreak)) as SwissTiebreak[])] : [];
  return {
    rounds: int(s.rounds, 1, 127, 0) || null,
    byePoints: Number.isInteger(s.byePoints) && (s.byePoints as number) >= 0 && (s.byePoints as number) <= 10 ? (s.byePoints as number) : null,
    tiebreaks: tiebreaks.length > 0 ? tiebreaks : null,
  };
}

export function readRules(raw: string | null | undefined): CompetitionRules {
  let given: Record<string, unknown> = {};
  try {
    given = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    given = {};
  }
  return {
    groupResultsOnWithdrawal: given.groupResultsOnWithdrawal === "void" ? "void" : "stand",
    groupResultsOnDisqualification: given.groupResultsOnDisqualification === "stand" ? "stand" : "void",
    refundBeforeDraw: given.refundBeforeDraw !== false,
    scoring: readScoring(given.scoring),
    performance: readPerformance(given.performance),
    ...(readSwiss(given.swiss) ? { swiss: readSwiss(given.swiss) } : {}),
    bracket: readBracket(given.bracket),
  };
}

/**
 * Rules from a form or request, laid over `base` (the sport's template, or
 * what the tournament has): what is understood, or why not.
 */
export function parseRules(input: unknown, base: CompetitionRules = DEFAULT_RULES): { ok: true; rules: CompetitionRules } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, rules: base };
  if (typeof input !== "object") return { ok: false, error: "Rules are a set of choices." };
  const r = input as Record<string, unknown>;
  const pick = (v: unknown, fallback: "stand" | "void") => (v === undefined ? fallback : v === "stand" || v === "void" ? v : null);
  const w = pick(r.groupResultsOnWithdrawal, base.groupResultsOnWithdrawal);
  const d = pick(r.groupResultsOnDisqualification, base.groupResultsOnDisqualification);
  if (!w || !d) return { ok: false, error: 'Group results "stand" or are "void".' };
  if (r.refundBeforeDraw !== undefined && typeof r.refundBeforeDraw !== "boolean") return { ok: false, error: "Say whether fees are owed back before the draw." };
  let scoring = base.scoring;
  if (r.scoring !== undefined) {
    if (!r.scoring || typeof r.scoring !== "object") return { ok: false, error: "Scoring is a set of choices." };
    const s = r.scoring as Record<string, unknown>;
    if (s.kind !== undefined && s.kind !== "sets" && s.kind !== "tally") return { ok: false, error: 'Scoring is by "sets" or a "tally".' };
    if (s.bestOf !== undefined && ![1, 3, 5, 7].includes(s.bestOf as number)) return { ok: false, error: "A match is the best of 1, 3, 5 or 7 sets." };
    if (s.retired !== undefined && s.retired !== "win_only" && s.retired !== "as_played") return { ok: false, error: 'A retirement counts "win_only" or "as_played".' };
    if (s.rankBy !== undefined && (!Array.isArray(s.rankBy) || s.rankBy.length === 0 || s.rankBy.some((k) => !RANK_KEYS.includes(k as RankKey))))
      return { ok: false, error: `Rank by some of: ${RANK_KEYS.join(", ")}.` };
    if (s.setPoints !== undefined && s.setPoints !== null && readSetPoints(s.setPoints) === null)
      return { ok: false, error: "Points by set score are four whole numbers, 0 to 10: a clear win, a win in the deciding set, a loss in it, a clear loss." };
    if (s.setPoints && (s.kind ?? base.scoring.kind) === "tally") return { ok: false, error: "Points by set score are for matches scored in sets." };
    // Checked against the match as it will be, so changing the sets or the kind cannot quietly drop a walkover's score.
    const why = walkoverRefusal(
      s.walkover !== undefined ? s.walkover : base.scoring.walkover,
      ((s.kind as string) ?? base.scoring.kind) === "tally" ? "tally" : "sets",
      (s.bestOf as number) ?? base.scoring.bestOf
    );
    if (why) return { ok: false, error: why };
    scoring = readScoring({ ...base.scoring, ...s, tablePoints: { ...base.scoring.tablePoints, ...((s.tablePoints as object) ?? {}) } });
  }
  let performance = base.performance;
  if (r.performance !== undefined) {
    if (r.performance === null) performance = null;
    else if (typeof r.performance !== "object") return { ok: false, error: "A performance event's rules are a set of choices." };
    else {
      const given = r.performance as Record<string, unknown>;
      // Counted rules are laid over the template's one by one, and checked; null makes it an event of marks.
      let counted: unknown = base.performance?.counted ?? null;
      if (given.counted === null) counted = null;
      else if (given.counted !== undefined) {
        const why = countedRefusal(given.counted);
        if (why) return { ok: false, error: why };
        counted = { ...(base.performance?.counted ?? DEFAULT_COUNTED), ...(given.counted as object) };
      }
      performance = readPerformance({ ...(base.performance ?? DEFAULT_PERFORMANCE), ...given, counted });
    }
  }
  let swiss = base.swiss ?? null;
  if (r.swiss !== undefined) {
    if (r.swiss === null) swiss = null;
    else if (typeof r.swiss !== "object") return { ok: false, error: "A Swiss event's settings are a set of choices." };
    else {
      const x = r.swiss as Record<string, unknown>;
      if (x.rounds !== undefined && x.rounds !== null && (!Number.isInteger(x.rounds) || (x.rounds as number) < 1 || (x.rounds as number) > 127))
        return { ok: false, error: "A Swiss event plays 1 or more rounds, or leave it to the default." };
      if (x.byePoints !== undefined && x.byePoints !== null && (!Number.isInteger(x.byePoints) || (x.byePoints as number) < 0 || (x.byePoints as number) > 10))
        return { ok: false, error: "A bye is worth 0 to 10 points, or leave it at the points for a win." };
      if (x.tiebreaks !== undefined && x.tiebreaks !== null && (!Array.isArray(x.tiebreaks) || x.tiebreaks.length === 0 || x.tiebreaks.some((k) => !SWISS_TIEBREAKS.includes(k as SwissTiebreak))))
        return { ok: false, error: `Break ties by some of: ${SWISS_TIEBREAKS.join(", ")}.` };
      swiss = readSwiss({ ...(base.swiss ?? DEFAULT_SWISS), ...x });
    }
  }
  let bracket = base.bracket;
  if (r.bracket !== undefined) {
    if (!r.bracket || typeof r.bracket !== "object" || Array.isArray(r.bracket)) return { ok: false, error: "A bracket's rules are a set of choices." };
    const b = r.bracket as Record<string, unknown>;
    for (const key of ["consolation", "consolationThirdPlace", "grandFinalReset"])
      if (b[key] !== undefined && typeof b[key] !== "boolean") return { ok: false, error: "Say yes or no: a consolation draw, its third-place match, the grand final's reset." };
    if (b.consolationMode !== undefined && !CONSOLATION_MODES.includes(b.consolationMode as ConsolationMode))
      return { ok: false, error: "A consolation draw takes the losers of the first round (first_round) or every loser but the runner-up (feed_in)." };
    // Choosing the first round again takes the advanced choice away (it is stored only where it is feed-in).
    const laid: Record<string, unknown> = { ...base.bracket, ...b };
    if (b.consolationMode === "first_round") delete laid.consolationMode;
    bracket = readBracket(laid);
    if (b.consolationThirdPlace === true && !bracket.consolation) return { ok: false, error: "A consolation third-place match needs a consolation draw." };
    if (b.consolationMode === "feed_in" && !bracket.consolation) return { ok: false, error: "A feed-in consolation draw needs a consolation draw." };
  }
  return {
    ok: true,
    rules: {
      groupResultsOnWithdrawal: w,
      groupResultsOnDisqualification: d,
      refundBeforeDraw: r.refundBeforeDraw === undefined ? base.refundBeforeDraw : r.refundBeforeDraw !== false,
      scoring,
      performance,
      ...(swiss ? { swiss } : {}),
      bracket,
    },
  };
}

/** Do this entrant's group results count, under these rules? */
export function groupResultsVoid(rules: CompetitionRules, reason: OutReason | null, stage: OutStage | null): boolean {
  if (!reason || stage === "before_draw") return false;
  return (reason === "disqualified" ? rules.groupResultsOnDisqualification : rules.groupResultsOnWithdrawal) === "void";
}
