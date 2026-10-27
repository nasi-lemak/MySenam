import { formatHour, slotStartsAt, zoneOffsetMinutes } from "./time.ts";

/**
 * Time as the scheduling engine keeps it (ADR 0010). A reservation is an
 * exact interval: on the venue's clock, minutes from the start of its
 * business day (18:07 is 1087; past 1440 is after midnight, so a booking from
 * 23:30 to 01:00 is 1410–1500 of the evening it started); in the database, a
 * `tstzrange` of the instants those are where the venue is.
 *
 * Nothing here knows about grids. What may be booked (starts, lengths,
 * buffers, hours) is a booking policy (lib/booking-policy.ts); what a grid
 * shows is the screen's business.
 */

/** Minutes in a day. */
export const DAY_MINUTES = 1440;
/** The latest a business day runs: 4 AM the next morning. */
export const LATEST_MINUTE = 28 * 60;

/** A half-open stretch of minutes, [start, end). */
export interface Span {
  start: number;
  end: number;
}

export function isMinute(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= LATEST_MINUTE;
}

/** Hours (18.5) to minutes (1110), to the nearest minute. */
export function minutesOf(hours: number): number {
  return Math.round(hours * 60);
}

/** Minutes (1110) to hours (18.5): for display and the decimal hours some APIs still give. */
export function hoursOf(minutes: number): number {
  return minutes / 60;
}

export function spanLength(s: Span): number {
  return s.end - s.start;
}

export function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

export function contains(outer: Span, inner: Span): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

/** Spans sorted and joined where they touch or overlap. */
export function merge(spans: Span[]): Span[] {
  const sorted = spans.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

/** What of `within` none of `busy` covers. */
export function freeWithin(within: Span, busy: Span[]): Span[] {
  const out: Span[] = [];
  let at = within.start;
  for (const b of merge(busy)) {
    if (b.end <= at) continue;
    if (b.start >= within.end) break;
    if (b.start > at) out.push({ start: at, end: Math.min(b.start, within.end) });
    at = Math.max(at, b.end);
  }
  if (at < within.end) out.push({ start: at, end: within.end });
  return out;
}

/** The moment minute `minute` of business day `date` begins where the venue is. */
export function instantOf(date: string, minute: number, zone: string): Date {
  return slotStartsAt(date, minute / 60, zone);
}

/** Minute of business day `date` that a moment is, on the venue's clock (may be past 1440 or negative). */
export function minuteOfDay(at: Date, date: string, zone: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const local = at.getTime() + zoneOffsetMinutes(at, zone) * 60_000;
  return Math.round((local - Date.UTC(y, m - 1, d)) / 60_000);
}

/**
 * A Postgres `tstzrange` literal for minutes `start`–`end` of `date`,
 * half-open, as stored in `claims.during`.
 */
export function rangeLiteral(date: string, start: number, end: number, zone: string): string {
  return `[${instantOf(date, start, zone).toISOString()},${instantOf(date, end, zone).toISOString()})`;
}

/** "6:07 PM" for minute 1087; "1:00 AM" for 1500 (after midnight); in another language as it writes a time (lib/time.ts `formatHour`). */
export function formatMinute(minute: number, locale: string = "en"): string {
  return formatHour(minute / 60, locale);
}

/** "75 minutes", "1 hour", "1 hour 30 minutes". */
export function formatLength(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hours = h === 0 ? "" : `${h} hour${h === 1 ? "" : "s"}`;
  if (m === 0) return hours || "0 minutes";
  return h === 0 ? `${m} minutes` : `${hours} ${m} minutes`;
}

/** "18:07", the 24-hour form forms and APIs take. Past midnight wraps: 1500 is "01:00". */
export function clockOf(minute: number): string {
  const h = Math.floor(minute / 60) % 24;
  return `${String(h).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

/** "18:07" or "18:07:00" to minutes; an hour below the venue's opening may be meant as after midnight by the caller. */
export function parseClock(text: unknown): number | null {
  if (typeof text !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})(?::00)?$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 27 || min > 59) return null;
  return h * 60 + min;
}
