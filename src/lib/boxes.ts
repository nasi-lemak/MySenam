/**
 * The arithmetic of a box league, kept apart from the database: how many
 * boxes a season has and how big, who goes up and down, and who goes where
 * next season. lib/leagues.ts stores what this decides.
 */

export type Move = "up" | "down" | "stay";

/** No box smaller than this: two players are a match, not a box. */
export const MIN_BOX = 3;
/** Nor bigger than this: fifteen matches is as many as a month holds. */
export const MAX_BOX = 6;

/**
 * The sizes of the boxes for n players, top box first: as many boxes of
 * `size` as there are players for, with whoever is left over spread across
 * them (bigger at the top) rather than made into a short box of their own —
 * so one more or one fewer player does not reshuffle the whole ladder. A
 * box is split only when it would pass MAX_BOX, and never into one smaller
 * than MIN_BOX.
 */
export function boxSizes(n: number, size: number): number[] {
  if (n <= 0) return [];
  let count = Math.max(1, Math.floor(n / size));
  while (Math.ceil(n / count) > MAX_BOX) count++;
  while (count > 1 && Math.floor(n / count) < MIN_BOX) count--;
  const base = Math.floor(n / count);
  const extra = n % count;
  return Array.from({ length: count }, (_, i) => base + (i < extra ? 1 : 0));
}

/** Cut a ranked list into boxes of the given sizes. */
export function intoBoxes<T>(ranked: T[], sizes: number[]): T[][] {
  const out: T[][] = [];
  let at = 0;
  for (const s of sizes) {
    out.push(ranked.slice(at, at + s));
    at += s;
  }
  return out;
}

/**
 * Who moves, given each box's finishing order, top box first. The best
 * `moves` of every box but the top go up; the worst `moves` of every box but
 * the bottom go down — never more than half a box either way.
 */
export function seasonMoves<T>(boxes: T[][], moves: number): Map<T, Move> {
  const out = new Map<T, Move>();
  boxes.forEach((box, i) => {
    const m = Math.min(moves, Math.floor(box.length / 2));
    box.forEach((p, place) => {
      let move: Move = "stay";
      if (i > 0 && place < m) move = "up";
      else if (i < boxes.length - 1 && place >= box.length - m) move = "down";
      out.set(p, move);
    });
  });
  return out;
}

export interface LadderPlayer {
  id: number;
  /** Last season, if they played it: their box, where they finished, and the move. */
  last?: { box: number; finish: number; move: Move } | null;
  /** For a newcomer: where staff want them. */
  startBox?: number | null;
  /** Their own say of how good they are: higher is better; 0 if they gave none. */
  level: number;
}

/**
 * Everybody for the coming season, best first, ready to cut into boxes.
 *
 * Those who played last season go to the box their move takes them to — in
 * it, those coming down first, then those staying in the order they
 * finished, then those coming up. A newcomer staff have placed goes at the
 * foot of that box; the rest go below everybody, best level first. In a
 * first season nobody has played, so it is level, then who joined first.
 * When fewer play than last time the boxes close up, from the bottom.
 */
export function ladder(players: LadderPlayer[]): number[] {
  const key = (p: LadderPlayer): [number, number, number] => {
    if (p.last) {
      const target = p.last.box + (p.last.move === "up" ? -1 : p.last.move === "down" ? 1 : 0);
      const within = p.last.move === "down" ? 0 : p.last.move === "stay" ? 1 : 2;
      return [target, within, p.last.finish];
    }
    return [p.startBox ?? Number.MAX_SAFE_INTEGER, 3, 0];
  };
  return [...players]
    .map((p, joined) => ({ p, k: key(p), joined }))
    .sort((x, y) => x.k[0] - y.k[0] || x.k[1] - y.k[1] || x.k[2] - y.k[2] || y.p.level - x.p.level || x.joined - y.joined)
    .map(({ p }) => p.id);
}
