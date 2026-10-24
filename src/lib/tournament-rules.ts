/**
 * How a competition treats an entrant who leaves it, as data: one engine,
 * with rules a tournament (and, later, a sport's template) sets, rather than
 * an engine per sport.
 *
 * Whatever the rules, an entrant who is out goes no further: the matches
 * they have left are walkovers to the other side, and they never take a
 * place that sends somebody on. What the rules decide is what happens to the
 * group results they already played — they stand, so the table reflects the
 * matches as played, or they are void, as if those matches had never been,
 * the usual answer to a disqualification — and whether a fee paid online is
 * owed back when they leave before the draw. Knockout results already played
 * always stand; changing those is a correction (lib/tournaments.ts).
 */

export type OutReason = "withdrawn" | "retired" | "disqualified";
export const OUT_REASONS: OutReason[] = ["withdrawn", "retired", "disqualified"];
export type OutStage = "before_draw" | "groups" | "knockout";

export interface CompetitionRules {
  /** Group results already played by somebody who withdrew or retired. */
  groupResultsOnWithdrawal: "stand" | "void";
  /** Group results already played by somebody disqualified. */
  groupResultsOnDisqualification: "stand" | "void";
  /** A fee paid online is owed back to somebody who leaves before the draw. */
  refundBeforeDraw: boolean;
}

/** What every tournament had before rules could be chosen, and what a new one starts with. */
export const DEFAULT_RULES: CompetitionRules = {
  groupResultsOnWithdrawal: "stand",
  groupResultsOnDisqualification: "void",
  refundBeforeDraw: true,
};

export function readRules(raw: string | null | undefined): CompetitionRules {
  let given: Partial<CompetitionRules> = {};
  try {
    given = raw ? (JSON.parse(raw) as Partial<CompetitionRules>) : {};
  } catch {
    given = {};
  }
  return {
    groupResultsOnWithdrawal: given.groupResultsOnWithdrawal === "void" ? "void" : "stand",
    groupResultsOnDisqualification: given.groupResultsOnDisqualification === "stand" ? "stand" : "void",
    refundBeforeDraw: given.refundBeforeDraw !== false,
  };
}

/** Rules from a form or request: what is understood, or why not. */
export function parseRules(input: unknown): { ok: true; rules: CompetitionRules } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, rules: DEFAULT_RULES };
  if (typeof input !== "object") return { ok: false, error: "Rules are a set of choices." };
  const r = input as Record<string, unknown>;
  const pick = (v: unknown, fallback: "stand" | "void") => (v === undefined ? fallback : v === "stand" || v === "void" ? v : null);
  const w = pick(r.groupResultsOnWithdrawal, DEFAULT_RULES.groupResultsOnWithdrawal);
  const d = pick(r.groupResultsOnDisqualification, DEFAULT_RULES.groupResultsOnDisqualification);
  if (!w || !d) return { ok: false, error: 'Group results "stand" or are "void".' };
  if (r.refundBeforeDraw !== undefined && typeof r.refundBeforeDraw !== "boolean") return { ok: false, error: "Say whether fees are owed back before the draw." };
  return { ok: true, rules: { groupResultsOnWithdrawal: w, groupResultsOnDisqualification: d, refundBeforeDraw: r.refundBeforeDraw !== false } };
}

/** Do this entrant's group results count, under these rules? */
export function groupResultsVoid(rules: CompetitionRules, reason: OutReason | null, stage: OutStage | null): boolean {
  if (!reason || stage === "before_draw") return false;
  return (reason === "disqualified" ? rules.groupResultsOnDisqualification : rules.groupResultsOnWithdrawal) === "void";
}
