import type { PerformanceRules } from "./tournament-rules";

/**
 * The arithmetic of performance events — races, throws, ends, games —
 * kept apart from the database like lib/brackets.ts: reading a mark as
 * written, what a competitor's attempts add up to, who ranks where, and
 * who swims in which heat and lane.
 */

/**
 * A mark as staff write it: a time as "1:02.35", "62.35" or "1:01:02.3"
 * (hours, minutes, seconds), a distance or score as a number. "X" (or "-")
 * is a foul or a missed attempt: null. Undefined if it does not read.
 */
export function parseMark(text: string, measure: PerformanceRules["measure"]): number | null | undefined {
  const t = text.trim();
  if (/^(x|-|foul)$/i.test(t)) return null;
  if (measure === "time") {
    const m = /^(?:(\d{1,2}):)?(?:(\d{1,2}):)?(\d{1,5}(?:\.\d{1,3})?)$/.exec(t);
    if (!m) return undefined;
    const parts = [m[1], m[2]].filter((p) => p !== undefined).map(Number);
    const seconds = Number(m[3]);
    if (parts.length > 0 && seconds >= 60) return undefined;
    const value = parts.reduce((total, p) => total * 60 + p, 0) * 60 + seconds;
    return value > 0 ? Math.round(value * 1000) / 1000 : undefined;
  }
  if (!/^\d{1,6}(\.\d{1,3})?$/.test(t)) return undefined;
  return Number(t);
}

/** A mark as people read it: a time as 1:02.35, a distance or score as given. */
export function formatMark(value: number | null, measure: PerformanceRules["measure"]): string {
  if (value === null) return "X";
  if (measure !== "time") return String(Number(value.toFixed(3)));
  const hundredths = Math.round(value * 100);
  const h = Math.floor(hundredths / 360000);
  const m = Math.floor((hundredths % 360000) / 6000);
  const s = (hundredths % 6000) / 100;
  const sec = s.toFixed(2).padStart(m > 0 || h > 0 ? 5 : 1, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : m > 0 ? `${m}:${sec}` : sec;
}

/**
 * What a competitor's attempts make: the best of them, or their total. A
 * total needs every attempt (a missing end is no total); a best needs one
 * good attempt. Null when there is none.
 */
export function aggregate(attempts: (number | null)[], rules: Pick<PerformanceRules, "aggregate" | "better">): number | null {
  const good = attempts.filter((a): a is number => a !== null);
  if (good.length === 0) return null;
  if (rules.aggregate === "total") return good.length === attempts.length ? Math.round(good.reduce((s, a) => s + a, 0) * 1000) / 1000 : null;
  return rules.better === "lower" ? Math.min(...good) : Math.max(...good);
}

export interface Performer {
  entryId: number;
  status: "pending" | "ok" | "dns" | "dnf" | "dq";
  attempts: (number | null)[];
  result: number | null;
}

export interface Ranked extends Performer {
  /** 1 for the best; level results share a rank; null for no result (did not start, finish, or disqualified). */
  rank: number | null;
}

/**
 * Rank by result, the better first. With "best", level results are split
 * by the next best attempt, and so on; still level, they share the rank.
 * Those with no result come last, unranked, in the order given.
 */
export function rankPerformances(rows: Performer[], rules: Pick<PerformanceRules, "aggregate" | "better">): Ranked[] {
  const sign = rules.better === "lower" ? 1 : -1;
  const sortedMarks = (p: Performer) =>
    p.attempts.filter((a): a is number => a !== null).sort((x, y) => sign * (x - y));
  const compare = (x: Performer, y: Performer): number => {
    const by = sign * (x.result! - y.result!);
    if (by !== 0 || rules.aggregate === "total") return by;
    const xs = sortedMarks(x);
    const ys = sortedMarks(y);
    for (let i = 1; i < Math.max(xs.length, ys.length); i++) {
      if (xs[i] === undefined || ys[i] === undefined) return xs[i] === undefined ? (ys[i] === undefined ? 0 : 1) : -1;
      const d = sign * (xs[i] - ys[i]);
      if (d !== 0) return d;
    }
    return 0;
  };
  const scored = rows.filter((r) => r.status === "ok" && r.result !== null).sort((x, y) => compare(x, y) || x.entryId - y.entryId);
  const ranked: Ranked[] = [];
  scored.forEach((r, i) => {
    const level = i > 0 && compare(scored[i - 1], r) === 0;
    ranked.push({ ...r, rank: level ? ranked[i - 1].rank : i + 1 });
  });
  return [...ranked, ...rows.filter((r) => !scored.includes(r)).map((r) => ({ ...r, rank: null }))];
}

/**
 * Lanes from the middle out, as finals are laned: for 8 lanes, 4 5 3 6 2 7 1 8
 * — the best in lane 4.
 */
export function centreOutLanes(lanes: number): number[] {
  const mid = Math.ceil(lanes / 2);
  const order: number[] = [mid];
  for (let k = 1; order.length < lanes; k++) {
    if (mid + k <= lanes) order.push(mid + k);
    if (mid - k >= 1 && order.length < lanes) order.push(mid - k);
  }
  return order;
}

/**
 * Heats for `entries` (best entry mark first; those without one after, in
 * drawn order), `size` to a heat: the best swim in the last heat, the next
 * best in the one before, and so on, each heat laned from the middle out;
 * no heat is left with a single competitor where that can be avoided.
 */
export function seedHeats<T>(ranked: T[], size: number): { heat: number; lane: number; entry: T }[] {
  const count = Math.max(1, Math.ceil(ranked.length / size));
  // Fill from the last heat back, so the first heat is the one that is short.
  const heats: T[][] = Array.from({ length: count }, () => []);
  let h = count - 1;
  for (const entry of ranked) {
    if (heats[h].length >= size) h--;
    heats[h].push(entry);
  }
  // A first heat of one borrows from the next.
  if (count > 1 && heats[0].length === 1 && heats[1].length > 2) heats[0].push(heats[1].pop()!);
  const out: { heat: number; lane: number; entry: T }[] = [];
  heats.forEach((members, i) => {
    const lanes = centreOutLanes(size);
    members.forEach((entry, k) => out.push({ heat: i + 1, lane: lanes[k], entry }));
  });
  return out;
}
