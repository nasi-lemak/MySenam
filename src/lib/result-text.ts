import type { T } from "./i18n";
import type { CompetitionRules } from "./tournament-rules";

/** A result as a sentence: "Aina won 21-15, 21-18", a walkover, a draw. */
export function resultSentence(t: T, r: { winner: number | null; score: string | null; walkover: boolean }, names: Map<number, string>): string {
  if (r.walkover) return t("result.walkoverTo", { name: names.get(r.winner ?? 0) ?? "" });
  if (r.winner === null) return t("result.drawn", { score: r.score ?? "" });
  return t("result.wonBy", { name: names.get(r.winner) ?? "", score: r.score ?? "" });
}

/** How this sport's scores are written, for the result form. */
export const scoreExample = (x: { rules: Pick<CompetitionRules, "scoring"> }) => (x.rules.scoring.kind === "tally" ? "3-2" : "21-15, 18-21, 21-10");
