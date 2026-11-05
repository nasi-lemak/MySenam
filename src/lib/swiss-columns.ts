import type { SwissLine } from "./swiss";
import type { SwissTiebreak } from "./tournament-rules";

/**
 * A tie-break's value for a line of a Swiss table, as the table shows it (the staff tie-break screen and the public standings): what the
 * standings compare, in a form anybody can read. Head to head has none: it is who beat whom, said where two entries are separated by it.
 * Kept free of the database so a screen can import it.
 */
const ratio = (won: number, lost: number) => (lost === 0 ? (won === 0 ? 0 : Number.POSITIVE_INFINITY) : won / lost);

export function tiebreakValue(l: SwissLine, key: SwissTiebreak, halves = false): number | null {
  // Where points are kept doubled and shown halved (chess), the tie-breaks that add up points are halved the same way.
  const pts = (n: number) => (halves ? n / 2 : n);
  switch (key) {
    case "buchholz":
      return pts(l.buchholz);
    case "median_buchholz":
      return pts(l.medianBuchholz);
    case "buchholz_cut1":
      return l.buchholzCut1 === undefined ? null : pts(l.buchholzCut1);
    case "sonneborn_berger":
      return l.sonnebornBerger === undefined ? null : pts(l.sonnebornBerger);
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

/**
 * Points as a Swiss table or a pairing note writes them. Table points are whole numbers, so where a sport scores in halves (chess) they are
 * kept doubled and shown halved: 3 is "1½", 1 is "½". Otherwise the number as it is.
 */
export const showPoints = (n: number, halves = false): string => {
  if (!halves) return String(n);
  const whole = Math.trunc(n / 2);
  if (n % 2 === 0) return String(n / 2);
  return whole === 0 ? "½" : `${whole}½`;
};

/** A run of rounds as it is written: "2" for one, "1–3" for several. */
const roundRange = (from: number, to: number): string => (from >= to ? String(to) : `${from}–${to}`);

/**
 * What a Baku-accelerated event tells its readers (ADR 0047): the size of GA, the rounds that carry the full virtual point and, if there are
 * any (an event of 1 or 2 rounds has one accelerated round and none at half), those that carry half of it. Screens choose their phrase by `half`.
 */
export function bakuNote(a: { group: number; rounds: number; fullRounds?: number }): { half: boolean; params: { group: number; fullRange: string; halfRange: string; last: number } } {
  const full = a.fullRounds ?? Math.ceil(a.rounds / 2);
  return { half: a.rounds > full, params: { group: a.group, fullRange: roundRange(1, full), halfRange: roundRange(full + 1, a.rounds), last: a.rounds } };
}
