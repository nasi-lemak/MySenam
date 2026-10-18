import { getDb } from "./db";
import { cancelClassAndTell, notifyVenueCancelled, tickOutbox } from "./notify";
import { adminCancelBooking, cancelClassSession } from "./store";
import { addDays, isValidDateString, todayISO } from "./time";

/**
 * A court out of service for days at a time — resurfacing, a torn net, a
 * pool drained — or until further notice.
 *
 * Blocking an hour (store.blockSlots) is for an hour; this is for a stretch
 * of days, including ones not yet in the booking window. Nothing else needs
 * to know about it: every question about what is blocked goes through
 * `blocks_between` in the database (db/migrations/0009), which counts every
 * trading hour of an outage as blocked, so the court is closed wherever a
 * block would close it.
 *
 * What is already booked in the stretch is not left to be discovered on the
 * day. Taking the court out lists it, and goes ahead only when staff say to
 * cancel it — each booking refunded as a staff cancellation would be, and its
 * customer told.
 */

export interface Outage {
  id: number;
  courtId: number;
  courtName: string;
  venueId: number;
  startsOn: string;
  /** null: until further notice. */
  endsOn: string | null;
  reason: string | null;
}

export interface Affected {
  kind: "booking" | "class";
  /** A booking's code, or a class's id. */
  ref: string;
  date: string;
  startHour: number;
  name: string;
}

const SELECT = `
  SELECT o.id, o.court_id, c.name AS court_name, c.venue_id, o.starts_on, o.ends_on, o.reason
    FROM court_outages o JOIN courts c ON c.id = o.court_id`;

interface Row {
  id: number;
  court_id: number;
  court_name: string;
  venue_id: number;
  starts_on: string;
  ends_on: string | null;
  reason: string | null;
}

const toOutage = (r: Row): Outage => ({
  id: r.id,
  courtId: r.court_id,
  courtName: r.court_name,
  venueId: r.venue_id,
  startsOn: r.starts_on,
  endsOn: r.ends_on,
  reason: r.reason,
});

/** Outages not yet over at these venues, soonest first. */
export async function listOutages(venueIds: number[]): Promise<Outage[]> {
  if (venueIds.length === 0) return [];
  return (
    (await getDb()
      .prepare(
        `${SELECT} WHERE c.venue_id IN (${venueIds.map(() => "?").join(",")})
           AND (o.ends_on IS NULL OR o.ends_on >= ?) ORDER BY o.starts_on, o.id`
      )
      .all(...venueIds, todayISO())) as Row[]
  ).map(toOutage);
}

export async function outageById(id: number): Promise<Outage | null> {
  const row = (await getDb().prepare(`${SELECT} WHERE o.id = ?`).get(id)) as Row | undefined;
  return row ? toOutage(row) : null;
}

/** What is booked on this court from one day to another (or on, for ever). */
export async function affectedBy(courtId: number, startsOn: string, endsOn: string | null): Promise<Affected[]> {
  const db = getDb();
  const from = startsOn < todayISO() ? todayISO() : startsOn;
  const to = endsOn ?? "9999-12-31";
  const bookings = (await db
    .prepare(
      `SELECT b.code, b.date, MIN(s.hour) AS start_hour, b.name FROM bookings b
         JOIN booking_slots s ON s.booking_id = b.id
        WHERE s.court_id = ? AND b.date >= ? AND b.date <= ?
          AND b.status = 'confirmed' AND b.class_id IS NULL
        GROUP BY b.id, b.code, b.date, b.name ORDER BY b.date, start_hour`
    )
    .all(courtId, from, to)) as { code: string; date: string; start_hour: number; name: string }[];
  const classes = (await db
    .prepare(
      `SELECT id, date, start_hour, name FROM classes
        WHERE court_id = ? AND date >= ? AND date <= ? AND status = 'scheduled' ORDER BY date, start_hour`
    )
    .all(courtId, from, to)) as { id: number; date: string; start_hour: number; name: string }[];
  return [
    ...bookings.map((b) => ({ kind: "booking" as const, ref: b.code, date: b.date, startHour: b.start_hour, name: b.name })),
    ...classes.map((c) => ({ kind: "class" as const, ref: String(c.id), date: c.date, startHour: c.start_hour, name: c.name })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.startHour - b.startHour);
}

export type OutageResult =
  | { ok: true; outage: Outage; cancelled: number }
  | { ok: false; error: string; affected?: Affected[] };

export async function createOutage(input: {
  courtId: number;
  startsOn: string;
  endsOn: string | null;
  reason?: string;
  adminId: number;
  /** Cancel, refund and tell everybody booked in the stretch. Without it, any booking stops it. */
  cancelAffected?: boolean;
}): Promise<OutageResult> {
  const db = getDb();
  if (!isValidDateString(input.startsOn)) return { ok: false, error: "Give the first day it is out." };
  if (input.startsOn < todayISO()) return { ok: false, error: "It cannot start in the past." };
  if (input.endsOn !== null) {
    if (!isValidDateString(input.endsOn)) return { ok: false, error: "Give the last day it is out, or none." };
    if (input.endsOn < input.startsOn) return { ok: false, error: "The last day is before the first." };
  }
  const reason = input.reason?.trim().slice(0, 200) || null;
  if (!(await db.prepare("SELECT 1 FROM courts WHERE id = ?").get(input.courtId)))
    return { ok: false, error: "Court not found." };

  // One outage at a time per court: a second over the same days is a slip,
  // or a double click, and would show customers the same closure twice.
  const overlapping = (await db
    .prepare(
      `SELECT starts_on, ends_on FROM court_outages
        WHERE court_id = ? AND starts_on <= ? AND (ends_on IS NULL OR ends_on >= ?) LIMIT 1`
    )
    .get(input.courtId, input.endsOn ?? "9999-12-31", input.startsOn)) as
    | { starts_on: string; ends_on: string | null }
    | undefined;
  if (overlapping)
    return {
      ok: false,
      error: `It is already out of service then (${overlapping.starts_on} ${
        overlapping.ends_on ? `to ${overlapping.ends_on}` : "until further notice"
      }). End that one first, or pick other days.`,
    };

  const affected = await affectedBy(input.courtId, input.startsOn, input.endsOn);
  if (affected.length > 0 && !input.cancelAffected)
    return {
      ok: false,
      error:
        affected.length === 1
          ? "There is a booking in that time. Move it, or cancel it and tell the customer."
          : `There are ${affected.length} bookings and classes in that time. Move them, or cancel them and tell the customers.`,
      affected,
    };

  // Cancel what is there before closing the court over it, so nothing is
  // refunded or messaged for a court that then failed to close.
  let cancelled = 0;
  for (const a of affected) {
    if (a.kind === "class") {
      if ((await cancelClassAndTell(Number(a.ref))).ok) cancelled++;
      continue;
    }
    const done = await adminCancelBooking(a.ref);
    if (!done.ok) continue;
    cancelled++;
    await notifyVenueCancelled(done.booking);
  }
  if (cancelled > 0) await tickOutbox();

  const info = await db
    .prepare("INSERT INTO court_outages (court_id, starts_on, ends_on, reason, created_by) VALUES (?, ?, ?, ?, ?)")
    .run(input.courtId, input.startsOn, input.endsOn, reason, input.adminId);
  return { ok: true, outage: (await outageById(info.lastInsertRowid as number))!, cancelled };
}

/**
 * Back in service from today. An outage that had not started yet is simply
 * gone; one under way ends yesterday.
 */
export async function endOutage(id: number): Promise<{ ok: true } | { ok: false; error: string }> {
  const outage = await outageById(id);
  if (!outage) return { ok: false, error: "Not found." };
  const today = todayISO();
  if (outage.endsOn !== null && outage.endsOn < today) return { ok: false, error: "That is over already." };
  const db = getDb();
  if (outage.startsOn >= today) await db.prepare("DELETE FROM court_outages WHERE id = ?").run(id);
  else await db.prepare("UPDATE court_outages SET ends_on = ? WHERE id = ?").run(addDays(today, -1), id);
  return { ok: true };
}
