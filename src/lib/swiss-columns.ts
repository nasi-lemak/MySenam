import type { SwissLine } from "./swiss";
import type { SwissTiebreak } from "./tournament-rules";

/**
 * A tie-break's value for a line of a Swiss table, as the table shows it (the staff tie-break screen and the public standings): what the
 * standings compare, in a form anybody can read. Head to head has none: it is who beat whom, said where two entries are separated by it.
 * Kept free of the database so a screen can import it.
 */
const ratio = (won: number, lost: number) => (lost === 0 ? (won === 0 ? 0 : Number.POSITIVE_INFINITY) : won / lost);

export function tiebreakValue(l: SwissLine, key: SwissTiebreak): number | null {
  switch (key) {
    case "buchholz":
      return l.buchholz;
    case "median_buchholz":
      return l.medianBuchholz;
    case "buchholz_cut1":
      return l.buchholzCut1 ?? null;
    case "sonneborn_berger":
      return l.sonnebornBerger ?? null;
    case "wins":
      return l.won;
    case "set_diff":
      return l.setDiff;
    case "set_ratio":
      return ratio(l.setsWon, l.setsLost);
    case "point_diff":
      return l.pointDiff;
    case "point_ratio":
      return ratio(l.pointsFor, l.pointsAgainst);
    case "points_for":
      return l.pointsFor;
    case "head_to_head":
      return null;
  }
}

/** A value as the table writes it: a dash for none, ∞ for a ratio with nothing against, whole numbers whole, others to two places. */
export const showValue = (n: number | null): string => (n === null ? "–" : !Number.isFinite(n) ? "∞" : Number.isInteger(n) ? String(n) : n.toFixed(2));
