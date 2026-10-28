import { getDb } from "./db";
import { cancelClassAndTell, notifyVenueCancelled, tickOutbox } from "./notify";
import { refundCancelled } from "./payments";
import { blockSlots, getCourt, venueHours } from "./store";
import { venueCancel } from "./counter-refunds";
import { isValidDateString, todayISO } from "./time";
import { hoursOf, instantOf, minutesOf } from "./interval";
import type { Booking, ClassSession } from "./types";
import type { Phrase } from "./i18n";
import type { CancelReason } from "./notify";

/**
 * Rained off: one action for outdoor courts when the weather turns. Every
 * booking and class on the chosen courts in those hours is called off, the
 * money goes back as for any booking the venue cancels, each customer is told
 * (and the desk sees until they have seen it), and the hours are blocked so
 * nobody books them meanwhile. A booking already under way is called off too;
 * one that has finished is left alone.
 *
 * Asked first with `preview`, it only says what it would call off.
 */
export interface RainOut {
  venueId: number;
  courtIds: number[];
  date: string;
  /** The time rained off, in minutes of the day (or hours, the older way). */
  fromMin?: number;
  untilMin?: number;
  fromHour?: number;
  untilHour?: number;
  /**
   * What staff typed, sent to each customer as typed. Blank or left out, or
   * with `reasonPreset`, the built-in reason goes instead, each customer
   * reading it in their own language; `reason` is then only the label on
   * the blocks, for the staff's schedule.
   */
  reason?: string;
  /** Staff left the built-in reason as it was (`RAIN_PRESETS`). */
  reasonPreset?: string;
  preview?: boolean;
}

/** The built-in reasons, by the customer phrase each is written from. */
export const RAIN_PRESETS = { rained_off: "pre.rainedOff" } as const satisfies Record<string, Phrase>;
export type RainPreset = keyof typeof RAIN_PRESETS;
export const isRainPreset = (v: unknown): v is RainPreset => typeof v === "string" && Object.hasOwn(RAIN_PRESETS, v);

export type RainOutResult =
  | {
      ok: true;
      bookings: Booking[] | { code: string; name: string; startMin: number; startHour: number }[];
      classes: number;
      blocked: number;
      /** Not on a preview: each class called off with the enrolments it cancelled, for the activity log. */
      classesOff?: { session: ClassSession; enrolments: Booking[] }[];
    }
  | { ok: false; error: string };

export async function rainOut(input: RainOut): Promise<RainOutResult> {
  if (!isValidDateString(input.date) || input.date < todayISO()) return { ok: false, error: "Today or a day ahead." };
  const courtIds = [...new Set(input.courtIds)];
  if (courtIds.length === 0) return { ok: false, error: "Choose the courts it is rained off on." };
  for (const id of courtIds) {
    const court = await getCourt(id);
    if (!court || court.venueId !== input.venueId) return { ok: false, error: "Those courts are not all at this venue." };
  }
  const from = input.fromMin ?? (input.fromHour === undefined ? NaN : minutesOf(input.fromHour));
  const until = input.untilMin ?? (input.untilHour === undefined ? NaN : minutesOf(input.untilHour));
  const { openMin, closeMin, zone } = await venueHours(input.venueId, input.date);
  if (!(from < until) || from < openMin || until > closeMin)
    return { ok: false, error: "Give hours inside the day's opening hours, the first before the last." };

  const db = getDb();
  const marks = courtIds.map(() => "?").join(",");
  // By what holds the courts' spaces, so a booking across a linked court is found too (lib/court-links.ts).
  const holding = `(c.space_id IN (SELECT space_id FROM court_spaces WHERE court_id IN (${marks})) OR (c.space_id IS NULL AND c.court_id IN (${marks})))`;
  const bookings = (await db
    .prepare(
      `SELECT DISTINCT b.code, b.name, b.start_min, b.end_min FROM claims c JOIN bookings b ON b.id = c.booking_id
        WHERE c.active AND ${holding} AND b.date = ? AND b.start_min < ? AND b.end_min > ?
          AND b.status = 'confirmed'
        ORDER BY b.start_min`
    )
    .all(...courtIds, ...courtIds, input.date, until, from)) as { code: string; name: string; start_min: number; end_min: number }[];
  const classes = (await db
    .prepare(
      `SELECT DISTINCT k.id FROM claims c JOIN classes k ON k.id = c.class_id
        WHERE c.active AND ${holding} AND k.date = ? AND k.status = 'scheduled' AND k.start_min < ? AND k.end_min > ?`
    )
    .all(...courtIds, ...courtIds, input.date, until, from)) as { id: number }[];
  // One that has finished is left alone, as when staff cancel one (lib/store.ts `adminCancelBooking`).
  const now = Date.now();
  const live = bookings.filter((b) => instantOf(input.date, b.end_min, zone).getTime() > now);

  if (input.preview)
    return { ok: true, bookings: live.map((b) => ({ code: b.code, name: b.name, startMin: b.start_min, startHour: hoursOf(b.start_min) })), classes: classes.length, blocked: 0 };

  // What each customer is told: what staff typed, as typed; else the built-in
  // reason, in each customer's own language (the outbox writes in it).
  const typed = (input.reason ?? "").trim().slice(0, 80);
  const preset: RainPreset | null = isRainPreset(input.reasonPreset) ? input.reasonPreset : typed === "" ? "rained_off" : null;
  const why: CancelReason = preset ? { phrase: RAIN_PRESETS[preset] } : { text: typed };
  const cancelled: Booking[] = [];
  const classesOff: { session: ClassSession; enrolments: Booking[] }[] = [];
  for (const cl of classes) {
    const off = await cancelClassAndTell(cl.id, why, "rain");
    if (off.ok && off.session) classesOff.push({ session: off.session, enrolments: off.cancelled ?? [] });
  }
  for (const b of live) {
    // A counter payment is owed back, for the desk to settle (lib/counter-refunds.ts).
    const done = await venueCancel(b.code, "rain");
    if (!done.ok) continue;
    await refundCancelled([done.booking.id], { byVenue: true });
    await notifyVenueCancelled(done.booking, undefined, why);
    cancelled.push(done.booking);
  }
  // Nobody books what is left of that time meanwhile: from the next minute, or the start.
  const nowMinute = Math.ceil((now - instantOf(input.date, 0, zone).getTime()) / 60_000);
  const start = Math.max(from, nowMinute);
  let blocked = 0;
  // The blocks' label on the staff's schedule: what the panel showed them.
  const reason = typed || "Rained off";
  if (start < until)
    for (const id of courtIds) if ((await blockSlots(id, input.date, { start, end: until }, reason)).ok) blocked++;
  await tickOutbox();
  return { ok: true, bookings: cancelled, classes: classesOff.length, blocked, classesOff };
}
