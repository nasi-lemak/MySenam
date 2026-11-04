import { scoreRefusal } from "./brackets";
import type { ScoringRules } from "./tournament-rules";
import type { ResultKind } from "./rating-math";

/**
 * Which results a rating counts, written once (docs/features/tournaments.md#which-results-count, ADR 0034). The ledger
 * (lib/ratings.ts) reads results through these lists and checks, so the table in the documentation and the code cannot say
 * different things: a test classifies every status a result can have, and a status nobody classified fails it.
 *
 * Counted = decided and confirmed, in an event a manager marked as rated. A result still waiting for the other side's
 * confirmation (or for the stand period, after which it is recorded like any other), one a manager or the event's rules
 * struck or voided, one that cannot be a result (a side against itself, a score its own scoring rules refuse, a draw where
 * none is allowed) and a match never played to a result (abandoned, unplayed, a bye) are not.
 */

export type ResultSource = "tournament" | "league" | "team_league" | "ladder";

/** The statuses of a result row that are decided: the ledger reads these, and no others. */
export const DECIDED_STATUS: Record<ResultSource, string[]> = {
  // done: played to a result; walkover: awarded; retired: one side stopped part-way.
  tournament: ["done", "walkover", "retired"],
  // confirmed: both sides agreed, staff decided, or it stood unanswered; walkover: awarded.
  league: ["confirmed", "walkover"],
  // confirmed, or forfeit (the other side awarded every game).
  team_league: ["confirmed", "forfeit"],
  ladder: ["confirmed", "walkover"],
};

/** The statuses that are not results (yet, or any more). Together with `DECIDED_STATUS` every status is classified. */
export const UNDECIDED_STATUS: Record<ResultSource, string[]> = {
  // scheduled: not played (or abandoned: it keeps no result); bye: nobody to play.
  tournament: ["scheduled", "bye"],
  // unplayed; reported (waiting for the other side); disputed (staff decide); void (struck).
  league: ["unplayed", "reported", "disputed", "void"],
  team_league: ["scheduled", "reported", "disputed", "void"],
  // pending/accepted: not played; reported/disputed: unconfirmed; declined, cancelled, lapsed: never played; void: struck.
  ladder: ["pending", "accepted", "reported", "disputed", "declined", "cancelled", "lapsed", "void"],
};

/** A list for an SQL `IN (...)`: these are the constants above, never input. */
export const sqlList = (statuses: string[]): string => statuses.map((s) => `'${s}'`).join(", ");

/** How a result is treated: whether it is a ledger row, and how much it moves a rating (the rules' weights; 0 by default for a walkover). */
export type Situation =
  | "played"
  | "draw"
  | "retired"
  | "walkover"
  | "forfeit"
  | "abandoned"
  | "bye"
  | "unconfirmed"
  | "disputed"
  | "voided"
  | "out_group_void"
  | "invalid"
  | "nobody_to_rate";

export interface Treatment {
  /** A row is written in the ledger (it explains itself, even where it moves nothing). */
  row: boolean;
  /** "full": the result moves ratings and counts as a result; "half": a win by retirement; "none": a row that moves nothing and is not counted. */
  counts: "full" | "half" | "none" | "no row";
}

export const TREATMENT: Record<Situation, Treatment> = {
  played: { row: true, counts: "full" },
  draw: { row: true, counts: "full" },
  retired: { row: true, counts: "half" },
  walkover: { row: true, counts: "none" },
  forfeit: { row: true, counts: "none" },
  abandoned: { row: false, counts: "no row" },
  bye: { row: false, counts: "no row" },
  unconfirmed: { row: false, counts: "no row" },
  disputed: { row: false, counts: "no row" },
  voided: { row: false, counts: "no row" },
  out_group_void: { row: false, counts: "no row" },
  invalid: { row: false, counts: "no row" },
  nobody_to_rate: { row: false, counts: "no row" },
};

/** What a decided result is, from how it was recorded: the situation it is treated as. */
export function situationOf(kind: ResultKind, outcome: number, forfeit = false): Situation {
  if (kind === "walkover") return forfeit ? "forfeit" : "walkover";
  if (kind === "retired") return "retired";
  return outcome === 0.5 ? "draw" : "played";
}

export interface ValidityInput {
  kind: ResultKind;
  /** Side a's result: 1, 0.5, 0. */
  outcome: number;
  score: string | null;
  scoring: Pick<ScoringRules, "kind" | "bestOf" | "draws">;
  /** Whether this kind of match may end level (a group match of a sport scored in goals, where the rules allow draws). */
  drawsAllowed: boolean;
  /** Somebody on both sides: a match against oneself is not a result. */
  sidesOverlap: boolean;
}

/**
 * Why a decided result cannot be counted, or null: a side against itself; a draw where none is allowed; a played match with no
 * score, or one its own scoring rules refuse (`scoreRefusal`, the check every result passed when it was entered); a retirement
 * whose partial score is not a score. A walkover has no score to check.
 */
export function invalidResult(i: ValidityInput): string | null {
  if (i.sidesOverlap) return "same_subject";
  if (i.kind === "walkover") return null;
  if (i.outcome === 0.5 && !i.drawsAllowed) return "draw_not_allowed";
  if (i.score === null || i.score.trim() === "") return i.kind === "retired" ? null : "no_score";
  const why = scoreRefusal(i.score, i.outcome === 0.5 ? null : i.outcome === 1, i.scoring, { retired: i.kind === "retired", drawAllowed: i.outcome === 0.5 });
  return why ? "score_refused" : null;
}
