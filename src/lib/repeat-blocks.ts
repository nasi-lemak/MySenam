import crypto from "crypto";
import { getDb } from "./db";
import { blockSlots, courtVenueHours, getCourt } from "./store";
import { addDays, dayOfWeek, isValidDateString, todayISO } from "./time";
import { hoursOf, instantOf, minutesOf } from "./interval";

/**
 * Repeating blocks: the same time taken out every week, for as many weeks as
 * it runs. A school's PE lessons on Tuesday mornings, cleaning on Monday
 * evenings, the club's own night: the desk sets it once rather than blocking
 * each week by hand.
 *
 * Each week is an ordinary block (lib/store.ts `blockSlots`), so availability,
 * search and booking see it as they see any other, and one week can still be
 * released on the schedule. What ties them together is a code, so the rest of
 * the run can be listed and taken off at once. Time already booked is left
 * to its bookings and named, for the desk to move or let be.
 */

export const MAX_REPEAT_WEEKS = 52;

export interface RepeatInput {
  venueId: number;
  courtIds: number[];
  /** The first day it can fall on. */
  from: string;
  /** Days of the week: 0 Sunday to 6 Saturday. */
  days: number[];
  /** The time each of those days, in minutes of the day (or hours, the older way). */
  fromMin?: number;
  untilMin?: number;
  fromHour?: number;
  untilHour?: number;
  weeks: number;
  reason: string;
}

export interface RepeatBlock {
  code: string;
  reason: string;
  courts: string[];
  /** The days of the week it falls on, 0 Sunday to 6 Saturday. */
  days: number[];
  fromMin: number;
  untilMin: number;
  fromHour: number;
  untilHour: number;
  /** The first and last dates still to come. */
  next: string;
  last: string;
  /** Court-days still to come. */
  left: number;
}

export type RepeatResult =
  | { ok: true; code: string; blocked: number; clashes: { courtName: string; date: string; minute: number; hour: number }[] }
  | { ok: false; error: string };

export async function repeatBlock(input: RepeatInput): Promise<RepeatResult> {
  if (!isValidDateString(input.from) || input.from < todayISO()) return { ok: false, error: "Start today or later." };
  const days = [...new Set(input.days)].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  if (days.length === 0) return { ok: false, error: "Choose the days of the week." };
  if (!Number.isInteger(input.weeks) || input.weeks < 1 || input.weeks > MAX_REPEAT_WEEKS)
    return { ok: false, error: `For 1 to ${MAX_REPEAT_WEEKS} weeks.` };
  const fromMin = input.fromMin ?? (input.fromHour === undefined ? NaN : minutesOf(input.fromHour));
  const untilMin = input.untilMin ?? (input.untilHour === undefined ? NaN : minutesOf(input.untilHour));
  if (!(fromMin < untilMin)) return { ok: false, error: "The first hour before the last." };
  const reason = input.reason.trim().slice(0, 80);
  if (reason.length < 2) return { ok: false, error: "Say what it is for: customers see it." };
  const courtIds = [...new Set(input.courtIds)];
  if (courtIds.length === 0) return { ok: false, error: "Choose the courts." };
  const courts = [];
  for (const id of courtIds) {
    const court = await getCourt(id);
    if (!court || court.venueId !== input.venueId) return { ok: false, error: "Those courts are not all at this venue." };
    courts.push(court);
  }

  const code = `RB-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  const db = getDb();
  let blocked = 0;
  const clashes: { courtName: string; date: string; minute: number; hour: number }[] = [];
  for (let i = 0; i < input.weeks * 7; i++) {
    const date = addDays(input.from, i);
    if (!days.includes(dayOfWeek(date))) continue;
    for (const court of courts) {
      const { openMin, closeMin, zone } = await courtVenueHours(court.id, date);
      const nowMinute = Math.ceil((Date.now() - instantOf(date, 0, zone).getTime()) / 60_000);
      const span = { start: Math.max(fromMin, openMin, nowMinute), end: Math.min(untilMin, closeMin) };
      if (span.end <= span.start) continue;
      // Bookings in the way keep their time, and are named.
      const booked = (await db
        .prepare(
          `SELECT DISTINCT b.start_min FROM claims c JOIN bookings b ON b.id = c.booking_id
            WHERE c.active AND (c.space_id IN (SELECT space_id FROM court_spaces WHERE court_id = ?) OR (c.space_id IS NULL AND c.court_id = ?))
              AND b.date = ? AND b.start_min < ? AND b.end_min > ? ORDER BY b.start_min`
        )
        .all(court.id, court.id, date, span.end, span.start)) as { start_min: number }[];
      for (const b of booked) {
        const minute = Math.max(b.start_min, span.start);
        clashes.push({ courtName: court.name, date, minute, hour: hoursOf(minute) });
      }
      const done = await blockSlots(court.id, date, span, reason, undefined, { repeatCode: code });
      if (!done.ok || done.blockIds.length === 0) continue;
      blocked++;
    }
  }
  if (blocked === 0 && clashes.length === 0) return { ok: false, error: "Those hours are not open on any of those days." };
  clashes.sort((a, b) => a.date.localeCompare(b.date) || a.minute - b.minute);
  return { ok: true, code, blocked, clashes };
}

/** A venue's repeating blocks with weeks still to come. */
export async function listRepeatBlocks(venueId: number): Promise<RepeatBlock[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT b.repeat_code, b.reason, b.date, b.start_min, b.end_min, c.name AS court
         FROM blocks b JOIN courts c ON c.id = b.court_id
        WHERE b.venue_id = ? AND b.repeat_code IS NOT NULL AND b.date >= ?
        ORDER BY b.date, b.start_min`
    )
    .all(venueId, todayISO())) as { repeat_code: string; reason: string | null; date: string; start_min: number; end_min: number; court: string }[];
  const byCode = new Map<string, typeof rows>();
  for (const r of rows) byCode.set(r.repeat_code, [...(byCode.get(r.repeat_code) ?? []), r]);
  return [...byCode].map(([code, list]) => {
    const fromMin = Math.min(...list.map((r) => r.start_min));
    const untilMin = Math.max(...list.map((r) => r.end_min));
    return {
      code,
      reason: list[0].reason ?? "",
      courts: [...new Set(list.map((r) => r.court))],
      days: [...new Set(list.map((r) => dayOfWeek(r.date)))].sort(),
      fromMin,
      untilMin,
      fromHour: hoursOf(fromMin),
      untilHour: hoursOf(untilMin),
      next: list[0].date,
      last: list[list.length - 1].date,
      left: new Set(list.map((r) => `${r.court}|${r.date}`)).size,
    };
  });
}

/** The rest of a run, from today, taken off: the court hours it frees. Weeks already past stay as they were. */
export async function endRepeatBlock(venueId: number, code: string): Promise<number> {
  const gone = (await getDb()
    .prepare(
      `DELETE FROM blocks WHERE repeat_code = ? AND date >= ? AND venue_id = ?
        RETURNING start_min, end_min`
    )
    .all(code, todayISO(), venueId)) as { start_min: number; end_min: number }[];
  return gone.reduce((sum, g) => sum + (g.end_min - g.start_min), 0) / 60;
}
