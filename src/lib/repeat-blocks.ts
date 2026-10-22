import crypto from "crypto";
import { getDb } from "./db";
import { blockSlots, courtVenueHours, getCourt } from "./store";
import { addDays, dayOfWeek, isPastSlot, isValidDateString, slotsBetween, todayISO } from "./time";

/**
 * Repeating blocks: the same hours taken out every week, for as many weeks as
 * it runs. A school's PE lessons on Tuesday mornings, cleaning on Monday
 * evenings, the club's own night: the desk sets it once rather than blocking
 * each week by hand.
 *
 * Each week is an ordinary block (lib/store.ts `blockSlots`), so availability,
 * search and booking see it as they see any other, and one week can still be
 * released on the schedule. What ties them together is a code, so the rest of
 * the run can be listed and taken off at once. Hours already booked are left
 * to their bookings and named, for the desk to move or let be.
 */

export const MAX_REPEAT_WEEKS = 52;

export interface RepeatInput {
  venueId: number;
  courtIds: number[];
  /** The first day it can fall on. */
  from: string;
  /** Days of the week: 0 Sunday to 6 Saturday. */
  days: number[];
  fromHour: number;
  untilHour: number;
  weeks: number;
  reason: string;
}

export interface RepeatBlock {
  code: string;
  reason: string;
  courts: string[];
  /** The days of the week it falls on, 0 Sunday to 6 Saturday. */
  days: number[];
  fromHour: number;
  untilHour: number;
  /** The first and last dates still to come. */
  next: string;
  last: string;
  /** Court-days still to come. */
  left: number;
}

export type RepeatResult =
  | { ok: true; code: string; blocked: number; clashes: { courtName: string; date: string; hour: number }[] }
  | { ok: false; error: string };

export async function repeatBlock(input: RepeatInput): Promise<RepeatResult> {
  if (!isValidDateString(input.from) || input.from < todayISO()) return { ok: false, error: "Start today or later." };
  const days = [...new Set(input.days)].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  if (days.length === 0) return { ok: false, error: "Choose the days of the week." };
  if (!Number.isInteger(input.weeks) || input.weeks < 1 || input.weeks > MAX_REPEAT_WEEKS)
    return { ok: false, error: `For 1 to ${MAX_REPEAT_WEEKS} weeks.` };
  if (!(input.fromHour < input.untilHour)) return { ok: false, error: "The first hour before the last." };
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
  const clashes: { courtName: string; date: string; hour: number }[] = [];
  for (let i = 0; i < input.weeks * 7; i++) {
    const date = addDays(input.from, i);
    if (!days.includes(dayOfWeek(date))) continue;
    for (const court of courts) {
      const { openHour, closeHour, step, zone } = await courtVenueHours(court.id, date);
      const hours = slotsBetween(Math.max(input.fromHour, openHour), Math.min(input.untilHour, closeHour), step).filter(
        (h) => !isPastSlot(date, h, zone)
      );
      if (hours.length === 0) continue;
      const booked = (await db
        .prepare(`SELECT DISTINCT hour FROM booking_slots WHERE court_id = ? AND date = ? AND hour IN (${hours.map(() => "?").join(",")})`)
        .all(court.id, date, ...hours)) as { hour: number | string }[];
      for (const b of booked) clashes.push({ courtName: court.name, date, hour: Number(b.hour) });
      const free = hours.filter((h) => !booked.some((b) => Number(b.hour) === h));
      if (free.length === 0) continue;
      const done = await blockSlots(court.id, date, free, reason);
      if (!done.ok) continue;
      await db
        .prepare(`UPDATE slot_blocks SET repeat_code = ? WHERE court_id = ? AND date = ? AND hour IN (${free.map(() => "?").join(",")})`)
        .run(code, court.id, date, ...free);
      blocked++;
    }
  }
  if (blocked === 0 && clashes.length === 0) return { ok: false, error: "Those hours are not open on any of those days." };
  clashes.sort((a, b) => a.date.localeCompare(b.date) || a.hour - b.hour);
  return { ok: true, code, blocked, clashes };
}

/** A venue's repeating blocks with weeks still to come. */
export async function listRepeatBlocks(venueId: number): Promise<RepeatBlock[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT s.repeat_code, s.reason, s.date, s.hour, s.span, c.name AS court
         FROM slot_blocks s JOIN courts c ON c.id = s.court_id
        WHERE c.venue_id = ? AND s.repeat_code IS NOT NULL AND s.date >= ?
        ORDER BY s.date, s.hour`
    )
    .all(venueId, todayISO())) as { repeat_code: string; reason: string | null; date: string; hour: number | string; span: number | string | null; court: string }[];
  const byCode = new Map<string, typeof rows>();
  for (const r of rows) byCode.set(r.repeat_code, [...(byCode.get(r.repeat_code) ?? []), r]);
  return [...byCode].map(([code, list]) => {
    const hours = list.map((r) => Number(r.hour));
    const step = Number(list[0].span ?? 1) || 1;
    return {
      code,
      reason: list[0].reason ?? "",
      courts: [...new Set(list.map((r) => r.court))],
      days: [...new Set(list.map((r) => dayOfWeek(r.date)))].sort(),
      fromHour: Math.min(...hours),
      untilHour: Math.max(...hours) + step,
      next: list[0].date,
      last: list[list.length - 1].date,
      left: new Set(list.map((r) => `${r.court}|${r.date}`)).size,
    };
  });
}

/** The rest of a run, from today, taken off. Weeks already past stay as they were. */
export async function endRepeatBlock(venueId: number, code: string): Promise<number> {
  const done = await getDb()
    .prepare(
      `DELETE FROM slot_blocks WHERE repeat_code = ? AND date >= ?
          AND court_id IN (SELECT id FROM courts WHERE venue_id = ?)`
    )
    .run(code, todayISO(), venueId);
  return done.changes;
}
