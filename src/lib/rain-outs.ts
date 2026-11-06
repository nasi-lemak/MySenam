import { getDb, withTransaction } from "./db";
import { notifyVenueCancelled, tellClassCancelled, tickOutbox } from "./notify";
import { refundCancelled } from "./payments";
import { blockSlots, cancelClassSession, getClass, getCourt, venueHours, withdrawOffers } from "./store";
import { venueCancel } from "./counter-refunds";
import { isValidDateString, todayISO } from "./time";
import { hoursOf, instantOf, minutesOf, type Span } from "./interval";
import type { Booking, ClassSession } from "./types";
import type { Phrase } from "./i18n";
import type { CancelReason } from "./notify";

/**
 * Rained off: one action for outdoor courts when the weather turns. Every
 * booking and class on the chosen courts in those hours is called off, the
 * money goes back as for any booking the venue cancels, each customer is told
 * (and the desk sees until they have seen it), and the hours are blocked so
 * nobody books them meanwhile. A booking or class already under way is called
 * off too; one that has finished is left alone.
 *
 * The hours are blocked first, so that from then on nothing in them is offered,
 * claimed or booked; each booking and class is then called off in a transaction
 * that blocks the time it frees, so the freed time is never open in between and
 * is offered to nobody. A booking made before the block, or kept from being
 * called off (kit still out), is not skipped silently: what could not be called
 * off is listed in `left` for the desk.
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
  /** Rained off for outdoor safety: its blocks are safety closures, which nothing overrides (ADR 0046). */
  safety?: boolean;
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
      /** Not on a preview: what is still standing in those hours and why (kit still out), for the desk to deal with. */
      left?: { ref: string; name: string; why: string }[];
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
  /** What is booked in those hours and not over: one that has finished is left alone, as when staff cancel one (lib/store.ts `adminCancelBooking`). */
  const standing = async () => {
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
        `SELECT DISTINCT k.id, k.name, k.end_min FROM claims c JOIN classes k ON k.id = c.class_id
          WHERE c.active AND ${holding} AND k.date = ? AND k.status = 'scheduled' AND k.start_min < ? AND k.end_min > ?`
      )
      .all(...courtIds, ...courtIds, input.date, until, from)) as { id: number; name: string; end_min: number }[];
    const now = Date.now();
    return {
      bookings: bookings.filter((b) => instantOf(input.date, b.end_min, zone).getTime() > now),
      classes: classes.filter((k) => instantOf(input.date, k.end_min, zone).getTime() > now),
    };
  };

  if (input.preview) {
    const would = await standing();
    return { ok: true, bookings: would.bookings.map((b) => ({ code: b.code, name: b.name, startMin: b.start_min, startHour: hoursOf(b.start_min) })), classes: would.classes.length, blocked: 0 };
  }

  // What each customer is told: what staff typed, as typed; else the built-in
  // reason, in each customer's own language (the outbox writes in it).
  const typed = (input.reason ?? "").trim().slice(0, 80);
  const preset: RainPreset | null = isRainPreset(input.reasonPreset) ? input.reasonPreset : typed === "" ? "rained_off" : null;
  const why: CancelReason = preset ? { phrase: RAIN_PRESETS[preset] } : { text: typed };
  // Nobody books what is left of that time: from the next minute, or the start.
  const nowMinute = Math.ceil((Date.now() - instantOf(input.date, 0, zone).getTime()) / 60_000);
  const start = Math.max(from, nowMinute);
  // The blocks' label on the staff's schedule: what the panel showed them.
  const reason = typed || "Rained off";
  const block = (courtId: number, span: Span) => blockSlots(courtId, input.date, span, reason, undefined, { safety: input.safety === true });
  /** Take the time a booking or class held in the same transaction that called it off, so it is never open in between. */
  const takeFreed = async (courtId: number, held: Span) => {
    const span = { start: Math.max(held.start, start), end: Math.min(held.end, until) };
    if (span.end > span.start) for (const id of courtIds.includes(courtId) ? [courtId] : courtIds) await block(id, span);
  };

  // 1. The hours are blocked first: from here nothing in them is offered, claimed or booked. What is held keeps its time
  // until it is called off below; live offers for the hours are let go (the entry goes back to waiting).
  let blocked = 0;
  if (start < until) {
    await withTransaction(async () => {
      await withdrawOffers({ courtIds }, input.date, input.date, { start, end: until });
      blocked = 0;
      for (const id of courtIds) if ((await block(id, { start, end: until })).ok) blocked++;
    });
  }

  // 2. What is booked is called off, each in a transaction that also blocks the time it frees; what arrived before the
  // block is found by going round again.
  const cancelled: Booking[] = [];
  const classesOff: { session: ClassSession; enrolments: Booking[] }[] = [];
  const left = new Map<string, { ref: string; name: string; why: string }>();
  const done = new Set<string>();
  for (let round = 0; round < 4; round++) {
    const now = await standing();
    const bookings = now.bookings.filter((b) => !done.has(`b${b.code}`));
    const classes = now.classes.filter((k) => !done.has(`c${k.id}`));
    if (bookings.length === 0 && classes.length === 0) break;
    for (const cl of classes) {
      done.add(`c${cl.id}`);
      const session = await getClass(cl.id);
      if (!session) continue;
      const off = await withTransaction(async () => {
        const result = await cancelClassSession(cl.id, "rain");
        if (result.ok) await takeFreed(session.courtId, { start: session.startMin, end: session.endMin });
        return result;
      });
      if (off.ok) {
        const told = await tellClassCancelled(cl.id, session, off, why);
        classesOff.push({ session, enrolments: told.cancelled ?? [] });
      }
    }
    for (const b of bookings) {
      done.add(`b${b.code}`);
      // A counter payment is owed back, for the desk to settle (lib/counter-refunds.ts); nothing is offered, the time is blocked.
      const off = await venueCancel(b.code, "rain", { offer: false, within: (booking) => takeFreed(booking.courtId, { start: booking.startMin, end: booking.endMin }) });
      if (!off.ok) {
        // Over since it was listed, or cancelled by its customer meanwhile: nothing to list. Kit still out, or anything else: for the desk.
        if (!("code" in off && (off.code === "ALREADY_CANCELLED" || off.code === "CANCEL_PLAYED"))) left.set(b.code, { ref: b.code, name: b.name, why: off.error });
        continue;
      }
      await refundCancelled([off.booking.id], { byVenue: true });
      await notifyVenueCancelled(off.booking, undefined, why);
      cancelled.push(off.booking);
    }
  }
  await tickOutbox();
  return { ok: true, bookings: cancelled, classes: classesOff.length, blocked, classesOff, left: [...left.values()] };
}
