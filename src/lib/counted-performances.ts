import type { CountKey, CountedRules } from "./tournament-rules";

/**
 * Counted performances: a competitor's result in a heat or a final is a set of counts, not one mark. Bouldering
 * counts, for each boulder, the attempt on which the zone hold was reached and the attempt on which the top was; a
 * round is ranked by tops, then zones, then fewer attempts to top, then fewer attempts to zone (the keys, and
 * their order, are the event's rules: `CountedRules.rankBy`). Climbing by height counts the highest hold reached,
 * with a "+" for a partial one, and the attempts.
 *
 * Kept apart from the database like lib/performance-math.ts, which hands a counted round to `rankCounted`: reading
 * what a judge entered, what it adds up to, who ranks where. Nothing here is stored but the judge's own record (the
 * units); every tally and placing is worked out from it on each reading, so a corrected count re-ranks the round
 * with nothing to drift, and the same counts always rank the same way (docs/features/tournaments.md#counted-performances,
 * which is where the rules, the tie-breaks and the cut are written down).
 */

/** The most attempts a boulder or route is given on a record: a typing slip, not a climb. */
export const MAX_ATTEMPTS = 99;
/** The highest hold a height record may reach. */
export const MAX_HOLD = 200;

/** One boulder's (or the route's) record, as the judge entered it. */
export interface CountedUnit {
  /** 1-based: the boulder's number in the round. A height event has one route, number 1. */
  unit: number;
  /** Attempts made; a topped boulder ends at the attempt that topped it. */
  attempts: number;
  /** Boulders: the attempt on which the zone was reached (null: not reached). A top is a zone too. */
  zone?: number | null;
  /** Boulders: the attempt on which the top was reached (null: not reached). */
  top?: number | null;
  /** Height: the highest hold reached, 0 for none. */
  hold?: number;
  /** Height: the next move was made but not held ("12+"). */
  plus?: boolean;
}

/** What a competitor's units add up to. Whatever the event ranks by is read from here. */
export interface Tally {
  tops: number;
  zones: number;
  /** The attempts it took to top the boulders topped, added up. */
  attemptsTop: number;
  /** The attempts it took to reach the zone of the boulders where it was reached (a top included), added up. */
  attemptsZone: number;
  /** Height: the hold reached, a half more for a "+". */
  height: number;
  attemptsHeight: number;
}

export const NO_TALLY: Tally = { tops: 0, zones: 0, attemptsTop: 0, attemptsZone: 0, height: 0, attemptsHeight: 0 };

export function tallyOf(units: CountedUnit[]): Tally {
  const t = { ...NO_TALLY };
  for (const u of units) {
    if (u.top != null) {
      t.tops++;
      t.attemptsTop += u.top;
    }
    // A top is a zone: the zone's attempt is the top's where none was marked earlier (`readUnits` makes it so).
    const zone = u.zone ?? u.top ?? null;
    if (zone !== null) {
      t.zones++;
      t.attemptsZone += zone;
    }
    if (u.hold !== undefined) {
      t.height = Math.max(t.height, u.hold + (u.plus ? 0.5 : 0));
      t.attemptsHeight += u.attempts;
    }
  }
  return t;
}

const HIGHER_IS_BETTER: Record<CountKey, boolean> = { tops: true, zones: true, height: true, attempts_top: false, attempts_zone: false, attempts_height: false };

const VALUE: Record<CountKey, (t: Tally) => number> = {
  tops: (t) => t.tops,
  zones: (t) => t.zones,
  attempts_top: (t) => t.attemptsTop,
  attempts_zone: (t) => t.attemptsZone,
  height: (t) => t.height,
  attempts_height: (t) => t.attemptsHeight,
};

/** Negative when `a` ranks ahead of `b` on the keys, in order; 0 when level on all of them. */
export function compareTallies(a: Tally, b: Tally, rankBy: CountKey[]): number {
  for (const key of rankBy) {
    const d = VALUE[key](a) - VALUE[key](b);
    if (d !== 0) return HIGHER_IS_BETTER[key] ? -Math.sign(d) : Math.sign(d);
  }
  return 0;
}

export interface CountedLine {
  entryId: number;
  status: "pending" | "ok" | "dns" | "dnf" | "dq";
  counts?: CountedUnit[];
}

/**
 * Rank a round: those with a result (status ok, with their counts) by the event's keys, the better first, level
 * counts sharing a place and the next place skipped (1, 2, 2, 4). With `previous` (each competitor's placing in the
 * round before) and the rules' countback on, competitors still level are split by it, the better earlier placing
 * first; a competitor with none counts after everybody with one; level on that too, they share a place. Those with no
 * result (not started, not finished, disqualified, or not yet in) come last, unranked, in the order given.
 */
export function rankCounted<T extends CountedLine>(rows: T[], rules: Pick<CountedRules, "rankBy" | "countback">, previous?: Map<number, number | null>): (T & { tally: Tally; rank: number | null })[] {
  const before = (id: number) => previous?.get(id) ?? Number.POSITIVE_INFINITY;
  const withTally = rows.map((r) => ({ ...r, tally: tallyOf(r.counts ?? []) }));
  const compare = (x: (typeof withTally)[number], y: (typeof withTally)[number]): number => {
    const by = compareTallies(x.tally, y.tally, rules.rankBy);
    if (by !== 0 || !rules.countback || !previous) return by;
    const a = before(x.entryId);
    const b = before(y.entryId);
    return a === b ? 0 : a < b ? -1 : 1;
  };
  const scored = withTally.filter((r) => r.status === "ok").sort((x, y) => compare(x, y) || x.entryId - y.entryId);
  const ranked: (T & { tally: Tally; rank: number | null })[] = [];
  scored.forEach((r, i) => ranked.push({ ...r, rank: i > 0 && compare(scored[i - 1], r) === 0 ? ranked[i - 1].rank : i + 1 }));
  return [...ranked, ...withTally.filter((r) => r.status !== "ok").map((r) => ({ ...r, rank: null }))];
}

/** The final's order of start from those going through, best placing first: the worst first and the best last ("reverse"), or as ranked. */
export function startOrder<T>(bestFirst: T[], rules: Pick<CountedRules, "finalStart">): T[] {
  return rules.finalStart === "reverse" ? [...bestFirst].reverse() : [...bestFirst];
}

/** A tally as the field reads it: "2T 3Z 5 7" (tops, zones, attempts to top, attempts to zone), only what the event ranks by; "12+ (3)" for a height. */
export function formatTally(t: Tally, rules: Pick<CountedRules, "kind" | "rankBy">): string {
  if (rules.kind === "height") {
    const shown = Number.isInteger(t.height) ? String(t.height) : `${Math.floor(t.height)}+`;
    return rules.rankBy.includes("attempts_height") ? `${shown} (${t.attemptsHeight})` : shown;
  }
  const part: Record<CountKey, string> = { tops: `${t.tops}T`, zones: `${t.zones}Z`, attempts_top: String(t.attemptsTop), attempts_zone: String(t.attemptsZone), height: "", attempts_height: "" };
  return rules.rankBy.map((k) => part[k]).join(" ");
}

/** How many of the field topped (and reached the zone of) each boulder, and how many have a record: what a round's page shows. */
export interface UnitStat {
  unit: number;
  tops: number;
  zones: number;
  /** Competitors with a result in the round. */
  climbers: number;
}

export function fieldStats(rows: CountedLine[], rules: Pick<CountedRules, "kind" | "units">): UnitStat[] {
  if (rules.kind !== "boulders") return [];
  const ok = rows.filter((r) => r.status === "ok");
  return Array.from({ length: rules.units }, (_, i) => {
    const mine = ok.map((r) => (r.counts ?? []).find((u) => u.unit === i + 1));
    return {
      unit: i + 1,
      tops: mine.filter((u) => u?.top != null).length,
      zones: mine.filter((u) => u && (u.zone ?? u.top) != null).length,
      climbers: ok.length,
    };
  });
}

// ------------------------------------------------------------ what a judge enters

/** A unit as sent: numbers, or null, for a boulder; a hold and whether it is a "+" for a route. */
export type UnitInput = Record<string, unknown>;

const whole = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
const absent = (v: unknown) => v === undefined || v === null;

/**
 * The units a judge entered for one competitor, checked against how a climb goes: a boulder topped ends at the attempt that
 * topped it, the zone is reached no later than the top (a top with no zone marked reaches it on the same attempt), nothing
 * is reached on an attempt not made, and no boulder is entered twice. A competitor needs at least one unit: somebody who
 * did not climb did not start. Not every boulder need be entered: one not entered is not climbed, and counts for nothing.
 */
export function readUnits(input: unknown, rules: Pick<CountedRules, "kind" | "units">): { ok: true; units: CountedUnit[] } | { ok: false; error: string } {
  if (!Array.isArray(input) || input.length === 0)
    return { ok: false, error: rules.kind === "height" ? "Give the highest hold reached and the attempts, or say why there is none." : "Give at least one boulder's attempts, or say why there is no result." };
  const units: CountedUnit[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Each boulder is a set of counts." };
    const u = raw as UnitInput;
    const at = whole(u.unit, 1, rules.units) ? u.unit : null;
    if (at === null) return { ok: false, error: rules.kind === "height" ? "A height event is one route: number 1." : `A boulder is numbered 1 to ${rules.units}.` };
    if (units.some((x) => x.unit === at)) return { ok: false, error: `Boulder ${at} is given twice.` };
    if (!whole(u.attempts, 1, MAX_ATTEMPTS)) return { ok: false, error: `Boulder ${at}: attempts are 1 to ${MAX_ATTEMPTS}.` };
    if (rules.kind === "height") {
      if (!absent(u.zone) || !absent(u.top)) return { ok: false, error: "A height is a hold reached: it has no zone or top." };
      if (!whole(u.hold, 0, MAX_HOLD)) return { ok: false, error: `The hold reached is 0 to ${MAX_HOLD}.` };
      if (u.plus !== undefined && typeof u.plus !== "boolean") return { ok: false, error: 'Say whether the hold is a "+".' };
      units.push({ unit: at, attempts: u.attempts, hold: u.hold, plus: u.plus === true });
      continue;
    }
    if (!absent(u.hold) || !absent(u.plus)) return { ok: false, error: `Boulder ${at}: a boulder has a zone and a top, not a hold.` };
    if (!absent(u.zone) && !whole(u.zone, 1, u.attempts)) return { ok: false, error: `Boulder ${at}: the zone is reached on an attempt that was made, 1 to ${u.attempts}.` };
    if (!absent(u.top) && !whole(u.top, 1, u.attempts)) return { ok: false, error: `Boulder ${at}: the top is reached on an attempt that was made, 1 to ${u.attempts}.` };
    const top = absent(u.top) ? null : (u.top as number);
    let zone = absent(u.zone) ? null : (u.zone as number);
    if (top !== null) {
      if (zone !== null && zone > top) return { ok: false, error: `Boulder ${at}: the zone is reached no later than the top.` };
      if (top !== u.attempts) return { ok: false, error: `Boulder ${at}: the climb ends at the top, on attempt ${top}, not ${u.attempts}.` };
      zone = zone ?? top;
    }
    units.push({ unit: at, attempts: u.attempts, zone, top });
  }
  return { ok: true, units: units.sort((a, b) => a.unit - b.unit) };
}

/** The units a line has stored; none for a line that has not been counted, or one that does not read. */
export function storedUnits(raw: string | null | undefined): CountedUnit[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as CountedUnit[]).filter((u) => u && typeof u === "object" && Number.isInteger(u.unit) && Number.isInteger(u.attempts)) : [];
  } catch {
    return [];
  }
}
