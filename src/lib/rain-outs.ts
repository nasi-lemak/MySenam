import { getDb } from "./db";
import { cancelClassAndTell, notifyVenueCancelled, tickOutbox } from "./notify";
import { refundCancelled } from "./payments";
import { adminCancelBooking, blockSlots, getCourt, venueHours } from "./store";
import { isPastSlot, isValidDateString, slotsBetween, todayISO } from "./time";
import type { Booking } from "./types";

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
  fromHour: number;
  untilHour: number;
  reason?: string;
  preview?: boolean;
}

export type RainOutResult =
  | { ok: true; bookings: Booking[] | { code: string; name: string; startHour: number }[]; classes: number; blocked: number }
  | { ok: false; error: string };

export async function rainOut(input: RainOut): Promise<RainOutResult> {
  if (!isValidDateString(input.date) || input.date < todayISO()) return { ok: false, error: "Today or a day ahead." };
  const courtIds = [...new Set(input.courtIds)];
  if (courtIds.length === 0) return { ok: false, error: "Choose the courts it is rained off on." };
  for (const id of courtIds) {
    const court = await getCourt(id);
    if (!court || court.venueId !== input.venueId) return { ok: false, error: "Those courts are not all at this venue." };
  }
  const { openHour, closeHour, step, zone } = await venueHours(input.venueId, input.date);
  if (!(input.fromHour < input.untilHour) || input.fromHour < openHour || input.untilHour > closeHour)
    return { ok: false, error: "Give hours inside the day's opening hours, the first before the last." };

  const db = getDb();
  const marks = courtIds.map(() => "?").join(",");
  // By the slots they hold, so a booking across a linked court is found too (lib/court-links.ts).
  const bookings = (await db
    .prepare(
      `SELECT DISTINCT b.code, b.name, b.start_hour, b.end_hour FROM booking_slots s JOIN bookings b ON b.id = s.booking_id
        WHERE s.court_id IN (${marks}) AND s.date = ? AND s.hour >= ? AND s.hour < ?
          AND b.status = 'confirmed' AND b.class_id IS NULL
        ORDER BY b.start_hour`
    )
    .all(...courtIds, input.date, input.fromHour, input.untilHour)) as { code: string; name: string; start_hour: number; end_hour: number }[];
  const classes = (await db
    .prepare(
      `SELECT id FROM classes WHERE court_id IN (${marks}) AND date = ? AND status = 'scheduled'
          AND start_hour < ? AND end_hour > ?`
    )
    .all(...courtIds, input.date, input.untilHour, input.fromHour)) as { id: number }[];
  // One that has finished is left alone, as when staff cancel one (lib/store.ts `adminCancelBooking`).
  const live = bookings.filter((b) => !isPastSlot(input.date, Number(b.end_hour), zone));

  if (input.preview)
    return { ok: true, bookings: live.map((b) => ({ code: b.code, name: b.name, startHour: Number(b.start_hour) })), classes: classes.length, blocked: 0 };

  const cancelled: Booking[] = [];
  let classesOff = 0;
  for (const cl of classes) if ((await cancelClassAndTell(cl.id)).ok) classesOff++;
  for (const b of live) {
    const done = await adminCancelBooking(b.code);
    if (!done.ok) continue;
    await refundCancelled([done.booking.id], { byVenue: true });
    await notifyVenueCancelled(done.booking);
    cancelled.push(done.booking);
  }
  // Nobody books what is left of those hours meanwhile.
  const hours = slotsBetween(input.fromHour, input.untilHour, step).filter((h) => !isPastSlot(input.date, h, zone));
  let blocked = 0;
  const reason = (input.reason ?? "").trim().slice(0, 80) || "Rained off";
  if (hours.length > 0)
    for (const id of courtIds) if ((await blockSlots(id, input.date, hours, reason)).ok) blocked++;
  await tickOutbox();
  return { ok: true, bookings: cancelled, classes: classesOff, blocked };
}
