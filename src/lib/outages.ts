import { getDb, withTransaction } from "./db";
import { cancelClassAndTell, notifyVenueCancelled, tickOutbox } from "./notify";
import { courtDaysFor, courtZone, getCourt, releaseBlockTime } from "./store";
import { venueCancel } from "./counter-refunds";
import { refundCancelled } from "./payments";
import { addDays, isValidDateString, todayISO } from "./time";
import { claim, isConflict, lockCourts, occupantsOn, unclaim, type Occupant } from "./claims";
import { DAY_MINUTES, freeWithin, hoursOf, merge, overlaps, type Span } from "./interval";
import type { Booking, ClassSession } from "./types";

/**
 * A court out of service for days at a time — resurfacing, a torn net, a
 * pool drained — or until further notice.
 *
 * Blocking an hour (store.blockSlots) is for an hour; this is for a stretch
 * of days, including ones not yet in the booking window. Nothing else needs
 * to know about it: the outage claims the court for those whole days
 * (lib/claims.ts), so it is closed wherever a block would close it, and the
 * database refuses anything booked over it.
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
  /** When it starts, in minutes of the day and in hours. */
  startMin: number;
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
  // Whatever holds the court's spaces: its own bookings and classes, and those
  // of courts sharing its floor (lib/court-links.ts), which the outage closes too.
  const holding = `(c.space_id IN (SELECT space_id FROM court_spaces WHERE court_id = ?) OR (c.space_id IS NULL AND c.court_id = ?))`;
  const bookings = (await db
    .prepare(
      `SELECT DISTINCT b.code, b.date, b.start_min, b.name FROM claims c JOIN bookings b ON b.id = c.booking_id
        WHERE c.active AND ${holding} AND b.date >= ? AND b.date <= ? AND b.status = 'confirmed'
        ORDER BY b.date, b.start_min`
    )
    .all(courtId, courtId, from, to)) as { code: string; date: string; start_min: number; name: string }[];
  const classes = (await db
    .prepare(
      `SELECT DISTINCT k.id, k.date, k.start_min, k.name FROM claims c JOIN classes k ON k.id = c.class_id
        WHERE c.active AND ${holding} AND k.date >= ? AND k.date <= ? AND k.status = 'scheduled'
        ORDER BY k.date, k.start_min`
    )
    .all(courtId, courtId, from, to)) as { id: number; date: string; start_min: number; name: string }[];
  return [
    ...bookings.map((b) => ({ kind: "booking" as const, ref: b.code, date: b.date, startMin: b.start_min, startHour: hoursOf(b.start_min), name: b.name })),
    ...classes.map((c) => ({ kind: "class" as const, ref: String(c.id), date: c.date, startMin: c.start_min, startHour: hoursOf(c.start_min), name: c.name })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin);
}

/** Days from one date to another, counting both. */
function daysFrom(first: string, last: string): number {
  return Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000) + 1;
}

/**
 * Claim a court out of service for whole business days, from the first to
 * the last, or on: from where the day before's late hours end (its 1 AM is
 * that night's, not the first day's) to where the last day closes, past
 * midnight where it runs that late. Throws `23P01` over anything held.
 */
async function claimOutage(outageId: number, courtId: number, startsOn: string, endsOn: string | null): Promise<void> {
  const court = await getCourt(courtId);
  if (!court) return;
  const closesAt = async (date: string) => {
    const day = (await courtDaysFor([courtId], date)).get(courtId);
    return day && !day.closed ? day.closeMin : 0;
  };
  const start = Math.max(0, (await closesAt(addDays(startsOn, -1))) - DAY_MINUTES);
  const end = endsOn === null ? DAY_MINUTES : (daysFrom(startsOn, endsOn) - 1) * DAY_MINUTES + Math.max(DAY_MINUTES, await closesAt(endsOn));
  await claim({
    court,
    source: { kind: "outage", outageId },
    date: startsOn,
    span: { start, end },
    zone: await courtZone(courtId),
    places: court.capacity,
    openEnded: endsOn === null,
  });
}

export type OutageResult =
  | {
      ok: true;
      outage: Outage;
      cancelled: number;
      bookingsOff?: Booking[];
      classesOff?: { session: ClassSession; enrolments: Booking[] }[];
    }
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
  const overlap = async () =>
    (await db
      .prepare(
        `SELECT starts_on, ends_on FROM court_outages
          WHERE court_id = ? AND starts_on <= ? AND (ends_on IS NULL OR ends_on >= ?) LIMIT 1`
      )
      .get(input.courtId, input.endsOn ?? "9999-12-31", input.startsOn)) as { starts_on: string; ends_on: string | null } | undefined;
  const alreadyOut = (o: { starts_on: string; ends_on: string | null }) => ({
    ok: false as const,
    error: `It is already out of service then (${o.starts_on} ${
      o.ends_on ? `to ${o.ends_on}` : "until further notice"
    }). End that one first, or pick other days.`,
  });

  let cancelled = 0;
  // What it called off, for the activity log (api/admin/outages): each booking, and each class with its enrolments.
  const bookingsOff: Booking[] = [];
  const classesOff: { session: ClassSession; enrolments: Booking[] }[] = [];
  // A booking can land while what was there is being cancelled: the court is
  // closed in one transaction that finds nothing in the way, or it goes round
  // again for what arrived (a few times, then it says so).
  for (let round = 0; round < 3; round++) {
    const overlapping = await overlap();
    if (overlapping) return alreadyOut(overlapping);
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
    for (const a of affected) {
      if (a.kind === "class") {
        const off = await cancelClassAndTell(Number(a.ref), undefined, "outage");
        if (!off.ok) continue;
        cancelled++;
        if (off.session) classesOff.push({ session: off.session, enrolments: off.cancelled ?? [] });
        continue;
      }
      // A counter payment is owed back, for the desk to settle (lib/counter-refunds.ts).
      const done = await venueCancel(a.ref, "outage");
      if (!done.ok) continue;
      cancelled++;
      bookingsOff.push(done.booking);
      // Online money goes back as the venue's policy for what it cancels has it, as for a closed day.
      await refundCancelled([done.booking.id], { byVenue: true });
      await notifyVenueCancelled(done.booking);
    }
    if (affected.length > 0) await tickOutbox();

    let closed: { ok: true; id: number } | ReturnType<typeof alreadyOut> | null;
    try {
      closed = await withTransaction(async () => {
        const again = await overlap();
        if (again) return alreadyOut(again);
        if ((await affectedBy(input.courtId, input.startsOn, input.endsOn)).length > 0) return null;
        const info = await db
          .prepare("INSERT INTO court_outages (court_id, starts_on, ends_on, reason, created_by) VALUES (?, ?, ?, ?, ?)")
          .run(input.courtId, input.startsOn, input.endsOn, reason, input.adminId);
        // Blocks in those days give way: a court out of service needs no block,
        // and a tournament's hold there is time its draw cannot use.
        const blocks = (await db
          .prepare(
            `SELECT DISTINCT k.court_id, k.date, k.start_min, k.end_min FROM claims c JOIN blocks k ON k.id = c.block_id
              WHERE c.active AND (c.space_id IN (SELECT space_id FROM court_spaces WHERE court_id = ?) OR (c.space_id IS NULL AND c.court_id = ?))
                AND k.date >= ? AND k.date <= ?`
          )
          .all(input.courtId, input.courtId, input.startsOn, input.endsOn ?? "9999-12-31")) as {
          court_id: number;
          date: string;
          start_min: number;
          end_min: number;
        }[];
        for (const k of blocks) await releaseBlockTime(k.court_id, k.date, { start: k.start_min, end: k.end_min });
        // The claim is what keeps bookings out: anything that arrived meanwhile refuses it, and it goes round again.
        await claimOutage(info.lastInsertRowid as number, input.courtId, input.startsOn, input.endsOn);
        return { ok: true as const, id: info.lastInsertRowid as number };
      });
    } catch (err) {
      if (!isConflict(err)) throw err;
      closed = null;
    }
    if (closed && !closed.ok) return closed;
    if (closed) return { ok: true, outage: (await outageById(closed.id))!, cancelled, bookingsOff, classesOff };
  }
  return { ok: false, error: "Bookings keep arriving for those days. Try again in a moment." };
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
  else
    await withTransaction(async () => {
      const last = addDays(today, -1);
      await db.prepare("UPDATE court_outages SET ends_on = ? WHERE id = ?").run(last, id);
      // Its claim shrinks to the days it was out.
      await unclaim({ kind: "outage", outageId: id });
      await claimOutage(id, outage.courtId, outage.startsOn, last);
    });
  return { ok: true };
}

// ------------------------------------------------- the last night's late hours

/**
 * Outages written before migration 0090 (and any whose venue has since come
 * to stay open past midnight) claim whole calendar days, so the late hours of
 * their last night, after midnight, stay bookable. `claimOutage` takes them
 * now; this takes what such an outage is missing, the same way, where it is
 * free, and lists for staff whatever was sold there since. It never cancels
 * or overlaps a booking: the hours a booking holds stay its own, and running
 * it again once that booking is over or moved claims them.
 */
export interface LateHoursRepair {
  outageId: number;
  courtId: number;
  courtName: string;
  /** The outage's last day, whose late hours these are. */
  date: string;
  /** What was taken now, in minutes of that day (past 1440 is after midnight). */
  claimed: Span[];
  /** Bookings and classes in those hours, left as they are for staff to move or keep. */
  collisions: Affected[];
  /** Bookings kept arriving while it tried: run it again. */
  busy?: boolean;
}

interface Missing {
  outage: Outage;
  /** Late hours of its last day that it does not claim. */
  gaps: Span[];
}

/** The late hours of an outage's last night that its claim does not cover, if any. */
async function missingLateHours(outage: Outage): Promise<Missing | null> {
  if (outage.endsOn === null) return null;
  const court = await getCourt(outage.courtId);
  if (!court) return null;
  const day = (await courtDaysFor([court.id], outage.endsOn)).get(court.id);
  if (!day || day.closed || day.closeMin <= DAY_MINUTES) return null;
  const late = { start: DAY_MINUTES, end: day.closeMin };
  const held = (await occupantsOn([court], outage.endsOn, await courtZone(court.id))).get(court.id) ?? [];
  const own = held.filter((o) => o.kind === "outage" && o.outageId === outage.id).map((o) => o.span);
  const gaps = freeWithin(late, own);
  return gaps.length > 0 ? { outage, gaps } : null;
}

/** Outages at these venues (every venue for null) not yet over whose last night's late hours are open. */
export async function outagesMissingLateHours(venueIds: number[] | null): Promise<Missing[]> {
  if (venueIds && venueIds.length === 0) return [];
  const only = venueIds ? ` AND c.venue_id IN (${venueIds.map(() => "?").join(",")})` : "";
  // From yesterday: its late hours run into this morning.
  const rows = (await getDb()
    .prepare(`${SELECT} WHERE o.ends_on IS NOT NULL AND o.ends_on >= ?${only} ORDER BY o.ends_on, o.id`)
    .all(addDays(todayISO(), -1), ...(venueIds ?? []))) as Row[];
  const out: Missing[] = [];
  for (const r of rows) {
    const missing = await missingLateHours(toOutage(r));
    if (missing) out.push(missing);
  }
  return out;
}

/** What is in the way in those hours: bookings and classes to list, and anything else that holds them. */
async function inTheWay(held: Occupant[], outageId: number, gaps: Span[]): Promise<{ list: Affected[]; busy: Span[] }> {
  const db = getDb();
  const list: Affected[] = [];
  const busy: Span[] = [];
  const seen = new Set<string>();
  for (const o of held) {
    // What it keeps, not only what it holds: no outage's time may go into a separation, or into a facility's turnover.
    if ((o.kind === "outage" && o.outageId === outageId) || !gaps.some((g) => overlaps(o.kept, g))) continue;
    busy.push(o.kept);
    if (o.kind === "booking" && o.bookingId !== null && !seen.has(`b${o.bookingId}`)) {
      seen.add(`b${o.bookingId}`);
      const b = (await db.prepare("SELECT code, date, start_min, name FROM bookings WHERE id = ? AND status = 'confirmed'").get(o.bookingId)) as
        | { code: string; date: string; start_min: number; name: string }
        | undefined;
      if (b) list.push({ kind: "booking", ref: b.code, date: b.date, startMin: b.start_min, startHour: hoursOf(b.start_min), name: b.name });
    } else if (o.kind === "class" && o.classId !== null && !seen.has(`c${o.classId}`)) {
      seen.add(`c${o.classId}`);
      const k = (await db.prepare("SELECT id, date, start_min, name FROM classes WHERE id = ?").get(o.classId)) as
        | { id: number; date: string; start_min: number; name: string }
        | undefined;
      if (k) list.push({ kind: "class", ref: String(k.id), date: k.date, startMin: k.start_min, startHour: hoursOf(k.start_min), name: k.name });
    }
  }
  return { list: list.sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin), busy };
}

/**
 * Claim the missing late hours of each such outage at these venues (or one
 * outage, by `outageId`) where they are free, as `claimOutage` would have;
 * list what holds the rest. A block there gives way, as it does when a court
 * is taken out. Safe to run again: what it took is not taken twice.
 */
export async function repairLateHours(input: { venueIds: number[] | null; outageId?: number }): Promise<LateHoursRepair[]> {
  const repairs: LateHoursRepair[] = [];
  for (const first of await outagesMissingLateHours(input.venueIds)) {
    if (input.outageId !== undefined && first.outage.id !== input.outageId) continue;
    const { outage } = first;
    const court = (await getCourt(outage.courtId))!;
    const zone = await courtZone(court.id);
    const date = outage.endsOn!;
    const done: LateHoursRepair = { outageId: outage.id, courtId: court.id, courtName: outage.courtName, date, claimed: [], collisions: [] };
    // A booking can land in those hours while this runs: the claim refuses it
    // and it reads again, a few times, then says so.
    let finished = false;
    for (let round = 0; round < 3 && !finished; round++) {
      try {
        const result = await withTransaction(async () => {
          await lockCourts([court]);
          const now = await missingLateHours(outage);
          if (!now) return { claimed: [] as Span[], collisions: [] as Affected[] };
          let held = (await occupantsOn([court], date, zone)).get(court.id) ?? [];
          // Blocks give way, as when a court is taken out (createOutage).
          for (const b of held.filter((o) => o.kind === "block" && o.blockId !== null && now.gaps.some((g) => overlaps(o.occupied, g)))) {
            const block = (await getDb().prepare("SELECT court_id, date FROM blocks WHERE id = ?").get(b.blockId)) as { court_id: number; date: string } | undefined;
            if (block?.date !== date) continue;
            for (const g of now.gaps) if (overlaps(b.span, g)) await releaseBlockTime(block.court_id, date, { start: Math.max(b.span.start, g.start), end: Math.min(b.span.end, g.end) });
          }
          held = (await occupantsOn([court], date, zone)).get(court.id) ?? [];
          const way = await inTheWay(held, outage.id, now.gaps);
          const free = merge(now.gaps.flatMap((g) => freeWithin(g, way.busy)));
          for (const span of free)
            await claim({ court, source: { kind: "outage", outageId: outage.id }, date, span, zone, places: court.capacity });
          return { claimed: free, collisions: way.list };
        });
        done.claimed = result.claimed;
        done.collisions = result.collisions;
        finished = true;
      } catch (err) {
        if (!isConflict(err)) throw err;
      }
    }
    if (!finished) done.busy = true;
    repairs.push(done);
  }
  return repairs;
}
