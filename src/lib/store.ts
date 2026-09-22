import { randomBytes } from "crypto";
import { getDb } from "./db";
import {
  Booking,
  busyness,
  Court,
  CourtAvailability,
  OPEN_HOUR,
  CLOSE_HOUR,
  DEFAULT_OPEN_HOUR,
  DEFAULT_CLOSE_HOUR,
  MAX_HOURS_PER_BOOKING,
  MAX_RECUR_WEEKS,
  CHECK_IN_OPENS_MINUTES_BEFORE,
  ClassSession,
  ClassStatus,
  LiveOccupancy,
  MAX_CLASS_WEEKS,
  MAX_TOP_UP,
  WalletEntry,
  WaitlistEntry,
  WaitlistStatus,
  WAITLIST_OFFER_MINUTES,
  Sport,
  Venue,
  VenueClosure,
} from "./types";
import {
  addDays,
  isBookableDate,
  isPastSlot,
  isValidDateString,
  isPeak,
  isWithinCancelWindow,
  slotStartsAt,
  todayISO,
} from "./time";

interface CourtRow {
  id: number;
  venue_id: number;
  name: string;
  sport: Sport;
  off_peak_rate: number;
  peak_rate: number;
  capacity: number;
}

interface VenueRow {
  id: number;
  name: string;
  area: string;
  address: string;
  phone: string;
  cancel_cutoff_hours: number;
  open_hour: number;
  close_hour: number;
}

function toVenue(r: VenueRow): Venue {
  return {
    id: r.id,
    name: r.name,
    area: r.area,
    address: r.address,
    phone: r.phone,
    cancelCutoffHours: r.cancel_cutoff_hours,
    openHour: r.open_hour,
    closeHour: r.close_hour,
  };
}

/** A venue's trading hours, falling back to the defaults if it has vanished. */
export function venueHours(venueId: number): { openHour: number; closeHour: number } {
  const row = getDb()
    .prepare("SELECT open_hour, close_hour FROM venues WHERE id = ?")
    .get(venueId) as { open_hour: number; close_hour: number } | undefined;
  return {
    openHour: row?.open_hour ?? DEFAULT_OPEN_HOUR,
    closeHour: row?.close_hour ?? DEFAULT_CLOSE_HOUR,
  };
}

/** The trading hours of the venue a court belongs to. */
export function courtVenueHours(courtId: number): { openHour: number; closeHour: number } {
  const row = getDb()
    .prepare(`
      SELECT v.id AS id, v.open_hour AS open_hour, v.close_hour AS close_hour
      FROM courts c JOIN venues v ON v.id = c.venue_id WHERE c.id = ?
    `)
    .get(courtId) as { id: number; open_hour: number; close_hour: number } | undefined;
  return {
    openHour: row?.open_hour ?? DEFAULT_OPEN_HOUR,
    closeHour: row?.close_hour ?? DEFAULT_CLOSE_HOUR,
  };
}

/** The closure covering a date, if the venue is shut that whole day. */
export function getVenueClosure(venueId: number, date: string): VenueClosure | null {
  const row = getDb()
    .prepare("SELECT date, reason FROM venue_closures WHERE venue_id = ? AND date = ?")
    .get(venueId, date) as { date: string; reason: string | null } | undefined;
  return row ? { date: row.date, reason: row.reason } : null;
}

/** Every closure a venue has from `from` onwards, soonest first. */
export function listVenueClosures(venueId: number, from?: string): VenueClosure[] {
  const rows = getDb()
    .prepare(`
      SELECT date, reason FROM venue_closures
      WHERE venue_id = ? AND (? IS NULL OR date >= ?)
      ORDER BY date
    `)
    .all(venueId, from ?? null, from ?? null) as { date: string; reason: string | null }[];
  return rows.map((r) => ({ date: r.date, reason: r.reason }));
}

export type ClosureResult = { ok: true; closure: VenueClosure } | { ok: false; error: string };

/** Shut a venue for a whole day. Existing bookings are left for staff to handle. */
export function closeVenueDay(venueId: number, date: string, reason?: string): ClosureResult {
  if (!isValidDateString(date)) return { ok: false, error: "Invalid date." };
  const db = getDb();
  const venue = db.prepare("SELECT id FROM venues WHERE id = ?").get(venueId);
  if (!venue) return { ok: false, error: "Venue not found." };
  const trimmed = reason?.trim();
  db.prepare(
    `INSERT INTO venue_closures (venue_id, date, reason) VALUES (?, ?, ?)
     ON CONFLICT (venue_id, date) DO UPDATE SET reason = excluded.reason`
  ).run(venueId, date, trimmed && trimmed.length > 0 ? trimmed : null);
  return { ok: true, closure: { date, reason: trimmed && trimmed.length > 0 ? trimmed : null } };
}

/** Re-open a closed day. */
export function reopenVenueDay(venueId: number, date: string): { ok: boolean } {
  const info = getDb()
    .prepare("DELETE FROM venue_closures WHERE venue_id = ? AND date = ?")
    .run(venueId, date);
  return { ok: info.changes > 0 };
}

/** Dates a venue is shut inside a range, as a set for bulk checks. */
function closedDatesIn(venueIds: number[], from: string, to: string): Set<string> {
  if (venueIds.length === 0) return new Set();
  const list = venueIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT venue_id, date FROM venue_closures
       WHERE venue_id IN (${list}) AND date >= ? AND date <= ?`
    )
    .all(...venueIds, from, to) as { venue_id: number; date: string }[];
  return new Set(rows.map((r) => `${r.venue_id}:${r.date}`));
}

interface BookingRow {
  id: number;
  code: string;
  court_id: number;
  date: string;
  start_hour: number;
  end_hour: number;
  name: string;
  phone: string;
  email: string | null;
  total_price: number;
  status: "confirmed" | "cancelled";
  created_at: string;
  series_code: string | null;
  payment_status: "unpaid" | "paid";
  paid_at: string | null;
  no_show: number;
  check_in_token: string | null;
  class_id: number | null;
  user_id: number | null;
  checked_in_at?: string | null;
  checked_out_at?: string | null;
}

function toCourt(r: CourtRow): Court {
  return {
    id: r.id,
    venueId: r.venue_id,
    name: r.name,
    sport: r.sport,
    offPeakRate: r.off_peak_rate,
    peakRate: r.peak_rate,
    capacity: r.capacity,
  };
}

function toBooking(r: BookingRow): Booking {
  return {
    id: r.id,
    code: r.code,
    courtId: r.court_id,
    date: r.date,
    startHour: r.start_hour,
    endHour: r.end_hour,
    name: r.name,
    phone: r.phone,
    email: r.email,
    totalPrice: r.total_price,
    status: r.status,
    createdAt: r.created_at,
    seriesCode: r.series_code,
    paymentStatus: r.payment_status,
    paidAt: r.paid_at,
    noShow: r.no_show === 1,
    checkedInAt: r.checked_in_at ?? null,
    checkedOutAt: r.checked_out_at ?? null,
    checkInToken: r.check_in_token,
    classId: r.class_id,
  };
}

export function listVenues(): (Venue & { courts: Court[] })[] {
  const db = getDb();
  const venues = (db.prepare("SELECT * FROM venues ORDER BY id").all() as VenueRow[]).map(toVenue);
  const courts = (db.prepare("SELECT * FROM courts ORDER BY id").all() as CourtRow[]).map(toCourt);
  return venues.map((v) => ({ ...v, courts: courts.filter((c) => c.venueId === v.id) }));
}

export function getVenue(id: number): (Venue & { courts: Court[] }) | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM venues WHERE id = ?").get(id) as VenueRow | undefined;
  if (!row) return null;
  const venue = toVenue(row);
  const courts = (
    db.prepare("SELECT * FROM courts WHERE venue_id = ? ORDER BY id").all(id) as CourtRow[]
  ).map(toCourt);
  return { ...venue, courts };
}

export function getCourt(id: number): Court | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM courts WHERE id = ?").get(id) as CourtRow | undefined;
  return row ? toCourt(row) : null;
}

/** Availability grid for every court of a venue (optionally one sport) on a date. */
export function getAvailability(venueId: number, date: string, sport?: Sport): CourtAvailability[] {
  const db = getDb();
  let courts = (
    db.prepare("SELECT * FROM courts WHERE venue_id = ? ORDER BY id").all(venueId) as CourtRow[]
  ).map(toCourt);
  if (sport) courts = courts.filter((c) => c.sport === sport);

  const takenCounts = countTakenPlaces(date, venueId);

  const blocked = db
    .prepare("SELECT court_id, hour FROM slot_blocks WHERE date = ? AND court_id IN (SELECT id FROM courts WHERE venue_id = ?)")
    .all(date, venueId) as { court_id: number; hour: number }[];
  const blockedSet = new Set(blocked.map((b) => `${b.court_id}:${b.hour}`));
  const classHours = classHoursOn(date, venueId);
  const { openHour, closeHour } = venueHours(venueId);
  // A closed day reads like every hour is blocked, so nothing can be picked.
  const closed = getVenueClosure(venueId, date) !== null;

  return courts.map((court) => ({
    court,
    slots: Array.from({ length: closeHour - openHour }, (_, i) => {
      const hour = openHour + i;
      const key = `${court.id}:${hour}`;
      const booked = takenCounts.get(key) ?? 0;
      const session = classHours.get(key);
      return {
        hour,
        rate: isPeak(date, hour) ? court.peakRate : court.offPeakRate,
        booked,
        capacity: court.capacity,
        // A class owns the hour: enrolling is the only way in.
        available:
          !closed &&
          booked < court.capacity &&
          !blockedSet.has(key) &&
          !session &&
          !isPastSlot(date, hour),
        ...(session ? { className: session.name, classId: session.id } : {}),
        ...(closed || blockedSet.has(key) ? { blocked: true } : {}),
      };
    }),
  }));
}

/** `courtId:hour` -> the class holding it, for a date (optionally one venue). */
function classHoursOn(
  date: string,
  venueId?: number
): Map<string, { id: number; name: string }> {
  const rows = getDb()
    .prepare(`
      SELECT id, court_id, name, start_hour, end_hour FROM classes
      WHERE date = ? AND status = 'scheduled'
        AND (? IS NULL OR court_id IN (SELECT id FROM courts WHERE venue_id = ?))
    `)
    .all(date, venueId ?? null, venueId ?? null) as {
    id: number;
    court_id: number;
    name: string;
    start_hour: number;
    end_hour: number;
  }[];

  const map = new Map<string, { id: number; name: string }>();
  for (const row of rows) {
    for (let hour = row.start_hour; hour < row.end_hour; hour++) {
      map.set(`${row.court_id}:${hour}`, { id: row.id, name: row.name });
    }
  }
  return map;
}

/** Places already taken per `courtId:hour` on a date, for one venue or all. */
function countTakenPlaces(date: string, venueId?: number): Map<string, number> {
  const rows = getDb()
    .prepare(`
      SELECT court_id, hour, COUNT(*) AS n FROM booking_slots
      WHERE date = ? AND (? IS NULL OR court_id IN (SELECT id FROM courts WHERE venue_id = ?))
      GROUP BY court_id, hour
    `)
    .all(date, venueId ?? null, venueId ?? null) as {
    court_id: number;
    hour: number;
    n: number;
  }[];
  return new Map(rows.map((r) => [`${r.court_id}:${r.hour}`, r.n]));
}

export interface SearchResult {
  venue: Venue;
  court: Court;
  startHour: number;
  endHour: number;
  totalPrice: number;
}

export interface SearchInput {
  sport: Sport;
  date: string;
  fromHour?: number;
  toHour?: number;
  duration?: number;
  area?: string;
  limit?: number;
}

/** Distinct venue areas, for the search filter. */
export function listAreas(): string[] {
  const rows = getDb()
    .prepare("SELECT DISTINCT area FROM venues ORDER BY area")
    .all() as { area: string }[];
  return rows.map((r) => r.area);
}

/**
 * Find every court across all venues with `duration` consecutive free hours
 * starting inside [fromHour, toHour] on `date`. One result per viable start
 * time, cheapest-first within the same start hour.
 */
export function searchAvailability(input: SearchInput): SearchResult[] {
  const db = getDb();
  const duration = Math.min(Math.max(input.duration ?? 1, 1), MAX_HOURS_PER_BOOKING);
  // The window of start hours asked for, clamped per venue below to that
  // venue's own trading hours.
  const wantFrom = Math.max(input.fromHour ?? OPEN_HOUR, OPEN_HOUR);
  const wantTo = Math.min(input.toHour ?? CLOSE_HOUR, CLOSE_HOUR);
  const limit = Math.min(Math.max(input.limit ?? 60, 1), 200);
  if (wantFrom > wantTo) return [];

  const params: (string | number)[] = [input.sport];
  let sql = `
    SELECT c.*, v.id AS v_id, v.name AS v_name, v.area AS v_area,
           v.address AS v_address, v.phone AS v_phone,
           v.cancel_cutoff_hours AS v_cutoff,
           v.open_hour AS v_open, v.close_hour AS v_close
    FROM courts c JOIN venues v ON v.id = c.venue_id
    WHERE c.sport = ?
  `;
  if (input.area) {
    sql += " AND v.area = ?";
    params.push(input.area);
  }
  sql += " ORDER BY v.id, c.id";

  const rows = db.prepare(sql).all(...params) as (CourtRow & {
    v_id: number;
    v_name: string;
    v_area: string;
    v_address: string;
    v_phone: string;
    v_cutoff: number;
    v_open: number;
    v_close: number;
  })[];
  if (rows.length === 0) return [];

  // A venue shut for the day has nothing to offer, whatever its courts say.
  const closedVenues = closedDatesIn(
    [...new Set(rows.map((r) => r.v_id))],
    input.date,
    input.date
  );

  const courtIds = rows.map((r) => r.id);
  const idList = courtIds.map(() => "?").join(",");
  const taken = db
    .prepare(`
      SELECT court_id, hour, COUNT(*) AS n FROM booking_slots
      WHERE date = ? AND court_id IN (${idList}) GROUP BY court_id, hour
    `)
    .all(input.date, ...courtIds) as { court_id: number; hour: number; n: number }[];
  const takenCounts = new Map(taken.map((t) => [`${t.court_id}:${t.hour}`, t.n]));
  const blocked = db
    .prepare(`SELECT court_id, hour FROM slot_blocks WHERE date = ? AND court_id IN (${idList})`)
    .all(input.date, ...courtIds) as { court_id: number; hour: number }[];
  const blockedSet = new Set(blocked.map((b) => `${b.court_id}:${b.hour}`));
  const classHours = classHoursOn(input.date);

  const results: SearchResult[] = [];
  for (const row of rows) {
    if (closedVenues.has(`${row.v_id}:${input.date}`)) continue;
    const court = toCourt(row);
    const venue: Venue = {
      id: row.v_id,
      name: row.v_name,
      area: row.v_area,
      address: row.v_address,
      phone: row.v_phone,
      cancelCutoffHours: row.v_cutoff,
      openHour: row.v_open,
      closeHour: row.v_close,
    };
    // A booking of `duration` hours must still finish by the venue's close.
    const fromHour = Math.max(wantFrom, venue.openHour);
    const lastStart = Math.min(wantTo, venue.closeHour - duration);
    for (let start = fromHour; start <= lastStart; start++) {
      const hours = Array.from({ length: duration }, (_, i) => start + i);
      const free = hours.every((h) => {
        const key = `${court.id}:${h}`;
        return (
          (takenCounts.get(key) ?? 0) < court.capacity &&
          !blockedSet.has(key) &&
          !classHours.has(key) &&
          !isPastSlot(input.date, h)
        );
      });
      if (!free) continue;
      results.push({
        venue,
        court,
        startHour: start,
        endHour: start + duration,
        totalPrice: computePrice(court, input.date, hours),
      });
    }
  }

  results.sort(
    (a, b) =>
      a.startHour - b.startHour ||
      a.totalPrice - b.totalPrice ||
      a.venue.name.localeCompare(b.venue.name) ||
      a.court.name.localeCompare(b.court.name)
  );
  return results.slice(0, limit);
}

export function computePrice(court: Court, date: string, hours: number[]): number {
  return hours.reduce(
    (sum, h) => sum + (isPeak(date, h) ? court.peakRate : court.offPeakRate),
    0
  );
}

function randomCode(prefix: string): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = prefix;
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

const generateCode = () => randomCode("MT-");
const generateSeriesCode = () => randomCode("SR-");

export type CreateBookingResult =
  | { ok: true; booking: Booking }
  | { ok: false; error: string };

/** Bounded retries when two requests race for the same place. */
const MAX_SEAT_RETRIES = 5;

export interface SeriesSkip {
  date: string;
  reason: string;
}

export type CreateSeriesResult =
  | { ok: true; bookings: Booking[]; skipped: SeriesSkip[]; seriesCode: string | null }
  | { ok: false; error: string };

export function createBooking(input: {
  courtId: number;
  date: string;
  hours: number[];
  name: string;
  phone: string;
  email?: string;
  userId?: number;
}): CreateBookingResult {
  const result = createBookingSeries({ ...input, weeks: 1 });
  if (!result.ok) return result;
  return { ok: true, booking: result.bookings[0] };
}

/**
 * Book the same court and hours weekly for `weeks` weeks. With
 * `skipConflicts`, weeks that clash with existing bookings or blocks are
 * skipped and reported; otherwise any clash fails the whole series.
 */
export function createBookingSeries(input: {
  courtId: number;
  date: string;
  hours: number[];
  weeks: number;
  name: string;
  phone: string;
  email?: string;
  userId?: number;
  skipConflicts?: boolean;
  /** Set when this booking is an enrolment, which may use the class's hours. */
  classId?: number;
}, attempt = 0): CreateSeriesResult {
  const { courtId, date, weeks, name, phone, email, userId } = input;
  const hours = [...new Set(input.hours)].sort((a, b) => a - b);
  const skipConflicts = (input.skipConflicts ?? false) && weeks > 1;

  const court = getCourt(courtId);
  if (!court) return { ok: false, error: "Court not found." };
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > MAX_RECUR_WEEKS)
    return { ok: false, error: `Weeks must be between 1 and ${MAX_RECUR_WEEKS}.` };
  if (!isBookableDate(date))
    return { ok: false, error: "The first date is outside the booking window." };
  if (hours.length === 0) return { ok: false, error: "Select at least one hour." };
  if (hours.length > MAX_HOURS_PER_BOOKING)
    return { ok: false, error: `Maximum ${MAX_HOURS_PER_BOOKING} hours per booking.` };
  for (let i = 1; i < hours.length; i++) {
    if (hours[i] !== hours[i - 1] + 1)
      return { ok: false, error: "Selected hours must be consecutive." };
  }
  const { openHour, closeHour } = courtVenueHours(courtId);
  if (hours[0] < openHour || hours[hours.length - 1] >= closeHour)
    return { ok: false, error: "Selected hours are outside operating hours." };
  if (isPastSlot(date, hours[0]))
    return { ok: false, error: "That time slot has already passed." };
  if (getVenueClosure(court.venueId, date))
    return { ok: false, error: "The venue is closed that day." };

  const db = getDb();
  const placeholders = hours.map(() => "?").join(",");
  const seatsTaken = db.prepare(
    "SELECT seat FROM booking_slots WHERE court_id = ? AND date = ? AND hour = ?"
  );
  const blockedCheck = db.prepare(
    `SELECT COUNT(*) AS n FROM slot_blocks WHERE court_id = ? AND date = ? AND hour IN (${placeholders})`
  );
  const insertBooking = db.prepare(`
    INSERT INTO bookings (code, court_id, date, start_hour, end_hour, name, phone, email, total_price, user_id, series_code, check_in_token, class_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSlot = db.prepare(
    "INSERT INTO booking_slots (booking_id, court_id, date, hour, seat) VALUES (?, ?, ?, ?, ?)"
  );

  /** Lowest unused place for an hour, or null when the resource is full. */
  const freeSeat = (weekDate: string, hour: number): number | null => {
    const used = new Set(
      (seatsTaken.all(courtId, weekDate, hour) as { seat: number }[]).map((r) => r.seat)
    );
    for (let seat = 0; seat < court.capacity; seat++) {
      if (!used.has(seat)) return seat;
    }
    return null;
  };

  const seriesCode = weeks > 1 ? generateSeriesCode() : null;

  try {
    const result = db.transaction(() => {
      const bookings: Booking[] = [];
      const skipped: SeriesSkip[] = [];
      for (let week = 0; week < weeks; week++) {
        const weekDate = addDays(date, week * 7);
        const seats = hours.map((hour) => freeSeat(weekDate, hour));

        let reason: string | null = null;
        const classes = classHoursOn(weekDate);
        if (seats.some((seat) => seat === null)) {
          reason = court.capacity > 1 ? "fully booked" : "already booked";
        } else if ((blockedCheck.get(courtId, weekDate, ...hours) as { n: number }).n > 0) {
          reason = "closed for maintenance";
        } else if (!input.classId && hours.some((h) => classes.has(`${courtId}:${h}`))) {
          reason = "reserved for a class";
        }
        if (reason) {
          if (!skipConflicts) throw new Error(`CONFLICT:${weekDate}:${reason}`);
          skipped.push({ date: weekDate, reason });
          continue;
        }
        const bookingId = insertBooking.run(
          generateCode(), courtId, weekDate, hours[0], hours[hours.length - 1] + 1,
          name, phone, email ?? null, computePrice(court, weekDate, hours),
          userId ?? null, seriesCode, randomBytes(16).toString("hex"),
          input.classId ?? null
        ).lastInsertRowid as number;
        hours.forEach((hour, i) => insertSlot.run(bookingId, courtId, weekDate, hour, seats[i]!));
        bookings.push(getBookingById(bookingId)!);
      }
      if (bookings.length === 0) throw new Error("ALL_CONFLICT");
      return { bookings, skipped };
    })();
    return { ok: true, ...result, seriesCode };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("CONFLICT:")) {
      const [, conflictDate, reason] = message.split(":");
      return {
        ok: false,
        error:
          weeks > 1
            ? `${conflictDate} is unavailable (${reason}). Enable "skip unavailable weeks" or pick another slot.`
            : reason === "closed for maintenance"
              ? "One or more of those slots is closed for maintenance. Please pick again."
              : reason === "fully booked"
                ? "That session filled up while you were booking. Please pick another time."
                : reason === "reserved for a class"
                  ? "That time is reserved for a class. Enrol in the class instead."
                  : "One or more of those slots was just booked by someone else. Please pick again.",
      };
    }
    if (message === "ALL_CONFLICT") {
      return { ok: false, error: "Every week in that series is already taken. Please pick another slot." };
    }
    if (message.includes("UNIQUE constraint failed: booking_slots")) {
      // Two requests picked the same place at once; the loser retries against
      // the winner's state. A genuinely full resource fails the seat check
      // above instead, so this cannot spin, but bound it regardless.
      if (attempt < MAX_SEAT_RETRIES) return createBookingSeries(input, attempt + 1);
      return {
        ok: false,
        error: "That session is filling up very quickly. Please try again.",
      };
    }
    if (message.includes("UNIQUE constraint failed: bookings.code")) {
      // Astronomically rare code collision — one retry is plenty.
      if (attempt < MAX_SEAT_RETRIES) return createBookingSeries(input, attempt + 1);
      throw err;
    }
    throw err;
  }
}

/** Cancel all future confirmed bookings in a series (verified by phone). */
export function cancelSeries(seriesCode: string, phone: string): {
  ok: boolean;
  cancelled: number;
  error?: string;
} {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM bookings WHERE UPPER(series_code) = UPPER(?) AND phone = ? AND status = 'confirmed'"
    )
    .all(seriesCode.trim(), phone.trim()) as BookingRow[];
  if (rows.length === 0)
    return { ok: false, cancelled: 0, error: "Series not found. Check the series code and phone number." };

  const cutoff = cancelCutoffForBooking(rows[0].id);
  const future = rows.filter((r) => isWithinCancelWindow(r.date, r.start_hour, cutoff));
  if (future.length === 0)
    return {
      ok: false,
      cancelled: 0,
      error: `No sessions left to cancel — the rest start within ${cutoff} hour${cutoff === 1 ? "" : "s"}.`,
    };

  db.transaction(() => {
    for (const row of future) {
      db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(row.id);
      db.prepare("DELETE FROM booking_slots WHERE booking_id = ?").run(row.id);
    }
  })();
  for (const row of future) refundBookingToWallet(row.id);
  return { ok: true, cancelled: future.length };
}

function getBookingById(id: number): Booking | null {
  const db = getDb();
  const row = db.prepare("SELECT b.*, ci.checked_in_at, ci.checked_out_at FROM bookings b LEFT JOIN check_ins ci ON ci.booking_id = b.id WHERE b.id = ?").get(id) as BookingRow | undefined;
  return row ? toBooking(row) : null;
}

export function findBooking(code: string, phone: string): Booking | null {
  const db = getDb();
  const row = db
    .prepare("SELECT b.*, ci.checked_in_at, ci.checked_out_at FROM bookings b LEFT JOIN check_ins ci ON ci.booking_id = b.id WHERE UPPER(b.code) = UPPER(?) AND b.phone = ?")
    .get(code.trim(), phone.trim()) as BookingRow | undefined;
  return row ? toBooking(row) : null;
}

export type CancelResult = { ok: true; booking: Booking } | { ok: false; error: string };

/** The cancellation cutoff of the venue a booking belongs to. */
function cancelCutoffForBooking(bookingId: number): number {
  const row = getDb()
    .prepare(`
      SELECT v.cancel_cutoff_hours AS hours FROM bookings b
      JOIN courts c ON c.id = b.court_id
      JOIN venues v ON v.id = c.venue_id
      WHERE b.id = ?
    `)
    .get(bookingId) as { hours: number } | undefined;
  return row?.hours ?? 0;
}

function cutoffMessage(hours: number): string {
  return hours === 0
    ? "This booking has already started and can no longer be cancelled."
    : `Bookings can only be cancelled at least ${hours} hour${hours === 1 ? "" : "s"} before they start. Please call the venue.`;
}

export function cancelBooking(code: string, phone: string): CancelResult {
  const booking = findBooking(code, phone);
  if (!booking) return { ok: false, error: "Booking not found. Check the code and phone number." };
  if (booking.status === "cancelled") return { ok: false, error: "This booking is already cancelled." };
  const cutoff = cancelCutoffForBooking(booking.id);
  if (!isWithinCancelWindow(booking.date, booking.startHour, cutoff))
    return { ok: false, error: cutoffMessage(cutoff) };

  const db = getDb();
  db.transaction(() => {
    db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(booking.id);
    db.prepare("DELETE FROM booking_slots WHERE booking_id = ?").run(booking.id);
  })();
  refundBookingToWallet(booking.id);
  // A freed place goes to whoever has waited longest.
  if (booking.classId) offerClassPlace(booking.classId);
  else offerSlotPlace(booking.courtId, booking.date);
  return { ok: true, booking: { ...booking, status: "cancelled" } };
}

export type AdminSlotStatus = "free" | "booked" | "blocked" | "past";

export interface AdminCourtSlots {
  court: Court;
  slots: {
    hour: number;
    status: AdminSlotStatus;
    /** Places taken this hour (0 or 1 for an exclusive court). */
    booked: number;
    /** Only meaningful for an exclusive court. */
    bookingCode?: string;
    blockReason?: string;
  }[];
}

/** Full slot-status grid for a venue on a date (admin view). */
export function getAdminSlots(venueId: number, date: string): AdminCourtSlots[] {
  const db = getDb();
  const courts = (
    db.prepare("SELECT * FROM courts WHERE venue_id = ? ORDER BY id").all(venueId) as CourtRow[]
  ).map(toCourt);

  const booked = db
    .prepare(`
      SELECT s.court_id, s.hour, b.code FROM booking_slots s
      JOIN bookings b ON b.id = s.booking_id
      WHERE s.date = ? AND s.court_id IN (SELECT id FROM courts WHERE venue_id = ?)
      ORDER BY s.seat
    `)
    .all(date, venueId) as { court_id: number; hour: number; code: string }[];
  const bookedMap = new Map<string, string>();
  const bookedCounts = new Map<string, number>();
  for (const row of booked) {
    const key = `${row.court_id}:${row.hour}`;
    if (!bookedMap.has(key)) bookedMap.set(key, row.code);
    bookedCounts.set(key, (bookedCounts.get(key) ?? 0) + 1);
  }

  const blocks = db
    .prepare("SELECT court_id, hour, reason FROM slot_blocks WHERE date = ? AND court_id IN (SELECT id FROM courts WHERE venue_id = ?)")
    .all(date, venueId) as { court_id: number; hour: number; reason: string | null }[];
  const blockMap = new Map(blocks.map((b) => [`${b.court_id}:${b.hour}`, b.reason ?? ""]));

  const { openHour, closeHour } = venueHours(venueId);
  const closure = getVenueClosure(venueId, date);

  return courts.map((court) => ({
    court,
    slots: Array.from({ length: closeHour - openHour }, (_, i) => {
      const hour = openHour + i;
      const key = `${court.id}:${hour}`;
      const count = bookedCounts.get(key) ?? 0;
      // A whole-day closure reads as a block on every hour that is not sold.
      const blockReason = blockMap.get(key) ?? (closure ? closure.reason ?? "Closed" : undefined);
      // A shared facility only reads as "booked" once every place is gone.
      const status: AdminSlotStatus =
        count >= court.capacity
          ? "booked"
          : blockReason !== undefined
            ? "blocked"
            : isPastSlot(date, hour)
              ? "past"
              : "free";
      return {
        hour,
        status,
        booked: count,
        ...(court.capacity === 1 && bookedMap.has(key)
          ? { bookingCode: bookedMap.get(key) }
          : {}),
        ...(blockReason !== undefined ? { blockReason } : {}),
      };
    }),
  }));
}

export type BlockResult = { ok: true; changed: number } | { ok: false; error: string };

/** Block hours on a court (maintenance/closure). Skips hours that are booked. */
export function blockSlots(courtId: number, date: string, hours: number[], reason?: string): BlockResult {
  if (!getCourt(courtId)) return { ok: false, error: "Court not found." };
  const { openHour, closeHour } = courtVenueHours(courtId);
  const valid = [...new Set(hours)].filter((h) => h >= openHour && h < closeHour);
  if (valid.length === 0) return { ok: false, error: "No valid hours given." };

  const db = getDb();
  const isBooked = db.prepare(
    "SELECT COUNT(*) AS n FROM booking_slots WHERE court_id = ? AND date = ? AND hour = ?"
  );
  const insert = db.prepare(
    "INSERT OR IGNORE INTO slot_blocks (court_id, date, hour, reason) VALUES (?, ?, ?, ?)"
  );
  let changed = 0;
  db.transaction(() => {
    for (const hour of valid) {
      const booked = isBooked.get(courtId, date, hour) as { n: number };
      if (booked.n > 0) continue; // never block over an existing booking
      changed += insert.run(courtId, date, hour, reason ?? null).changes;
    }
  })();
  return { ok: true, changed };
}

export function unblockSlots(courtId: number, date: string, hours: number[]): BlockResult {
  if (!getCourt(courtId)) return { ok: false, error: "Court not found." };
  const valid = [...new Set(hours)];
  if (valid.length === 0) return { ok: false, error: "No valid hours given." };
  const db = getDb();
  const result = db
    .prepare(`DELETE FROM slot_blocks WHERE court_id = ? AND date = ? AND hour IN (${valid.map(() => "?").join(",")})`)
    .run(courtId, date, ...valid);
  return { ok: true, changed: result.changes };
}

/** Admin cancellation by code — no phone check, works even after start time. */
export function adminCancelBooking(code: string): CancelResult {
  const db = getDb();
  const row = db
    .prepare("SELECT b.*, ci.checked_in_at, ci.checked_out_at FROM bookings b LEFT JOIN check_ins ci ON ci.booking_id = b.id WHERE UPPER(b.code) = UPPER(?)")
    .get(code.trim()) as BookingRow | undefined;
  if (!row) return { ok: false, error: "Booking not found." };
  const booking = toBooking(row);
  if (booking.status === "cancelled") return { ok: false, error: "This booking is already cancelled." };

  db.transaction(() => {
    db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(booking.id);
    db.prepare("DELETE FROM booking_slots WHERE booking_id = ?").run(booking.id);
  })();
  refundBookingToWallet(booking.id);
  // A freed place goes to whoever has waited longest.
  if (booking.classId) offerClassPlace(booking.classId);
  else offerSlotPlace(booking.courtId, booking.date);
  return { ok: true, booking: { ...booking, status: "cancelled" } };
}

export interface OccupancyDay {
  date: string;
  perCourt: { courtId: number; booked: number; blocked: number }[];
}

export interface OccupancyReport {
  totalSlotsPerDay: number;
  courts: Court[];
  days: OccupancyDay[];
}

/** Booked/blocked hour counts per court for `numDays` days from `start`. */
export function getOccupancy(venueId: number, start: string, numDays: number): OccupancyReport {
  const db = getDb();
  const courts = (
    db.prepare("SELECT * FROM courts WHERE venue_id = ? ORDER BY id").all(venueId) as CourtRow[]
  ).map(toCourt);
  const courtIds = new Set(courts.map((c) => c.id));

  const dates = Array.from({ length: numDays }, (_, i) => addDays(start, i));
  const end = dates[dates.length - 1];

  const bookedRows = db
    .prepare(`
      SELECT court_id, date, COUNT(*) AS n FROM booking_slots
      WHERE date >= ? AND date <= ? GROUP BY court_id, date
    `)
    .all(start, end) as { court_id: number; date: string; n: number }[];
  const blockedRows = db
    .prepare(`
      SELECT court_id, date, COUNT(*) AS n FROM slot_blocks
      WHERE date >= ? AND date <= ? GROUP BY court_id, date
    `)
    .all(start, end) as { court_id: number; date: string; n: number }[];

  const bookedMap = new Map(
    bookedRows.filter((r) => courtIds.has(r.court_id)).map((r) => [`${r.court_id}:${r.date}`, r.n])
  );
  const blockedMap = new Map(
    blockedRows.filter((r) => courtIds.has(r.court_id)).map((r) => [`${r.court_id}:${r.date}`, r.n])
  );

  const { openHour, closeHour } = venueHours(venueId);

  return {
    totalSlotsPerDay: closeHour - openHour,
    courts,
    days: dates.map((date) => ({
      date,
      perCourt: courts.map((c) => ({
        courtId: c.id,
        booked: bookedMap.get(`${c.id}:${date}`) ?? 0,
        blocked: blockedMap.get(`${c.id}:${date}`) ?? 0,
      })),
    })),
  };
}

export type VenueEditResult = { ok: true; venue: Venue } | { ok: false; error: string };

/** Validate a venue's trading hours, defaulting anything not given. */
function normaliseHours(
  open: number | undefined,
  close: number | undefined
): { ok: true; openHour: number; closeHour: number } | { ok: false; error: string } {
  const openHour = open ?? DEFAULT_OPEN_HOUR;
  const closeHour = close ?? DEFAULT_CLOSE_HOUR;
  if (!Number.isInteger(openHour) || !Number.isInteger(closeHour))
    return { ok: false, error: "Opening hours must be whole hours." };
  if (openHour < OPEN_HOUR || closeHour > CLOSE_HOUR)
    return { ok: false, error: `Hours must be between ${OPEN_HOUR}:00 and ${CLOSE_HOUR}:00.` };
  if (closeHour - openHour < 1)
    return { ok: false, error: "A venue must be open for at least an hour." };
  return { ok: true, openHour, closeHour };
}

export function createVenue(input: {
  name: string;
  area: string;
  address: string;
  phone: string;
  openHour?: number;
  closeHour?: number;
}): VenueEditResult {
  const hours = normaliseHours(input.openHour, input.closeHour);
  if (!hours.ok) return hours;
  const db = getDb();
  const info = db
    .prepare(
      "INSERT INTO venues (name, area, address, phone, open_hour, close_hour) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(
      input.name.trim(),
      input.area.trim(),
      input.address.trim(),
      input.phone.trim(),
      hours.openHour,
      hours.closeHour
    );
  const venue = toVenue(
    db.prepare("SELECT * FROM venues WHERE id = ?").get(info.lastInsertRowid) as VenueRow
  );
  return { ok: true, venue };
}

export function updateVenue(
  venueId: number,
  changes: {
    name?: string;
    area?: string;
    address?: string;
    phone?: string;
    cancelCutoffHours?: number;
    openHour?: number;
    closeHour?: number;
  }
): VenueEditResult {
  const db = getDb();
  const row = db.prepare("SELECT * FROM venues WHERE id = ?").get(venueId) as VenueRow | undefined;
  if (!row) return { ok: false, error: "Venue not found." };
  const current = toVenue(row);

  const hours = normaliseHours(
    changes.openHour ?? current.openHour,
    changes.closeHour ?? current.closeHour
  );
  if (!hours.ok) return hours;
  // Narrowing the day would strand anything already sold outside the new hours.
  const stranded = db
    .prepare(`
      SELECT COUNT(*) AS n FROM booking_slots s
      WHERE s.court_id IN (SELECT id FROM courts WHERE venue_id = ?)
        AND s.date >= ? AND (s.hour < ? OR s.hour >= ?)
    `)
    .get(venueId, todayISO(), hours.openHour, hours.closeHour) as { n: number };
  if (stranded.n > 0)
    return {
      ok: false,
      error: "Bookings already exist outside those hours. Cancel or move them first.",
    };

  db.prepare(
    `UPDATE venues SET name = ?, area = ?, address = ?, phone = ?, cancel_cutoff_hours = ?,
                       open_hour = ?, close_hour = ? WHERE id = ?`
  ).run(
    changes.name?.trim() ?? current.name,
    changes.area?.trim() ?? current.area,
    changes.address?.trim() ?? current.address,
    changes.phone?.trim() ?? current.phone,
    changes.cancelCutoffHours ?? current.cancelCutoffHours,
    hours.openHour,
    hours.closeHour,
    venueId
  );
  return {
    ok: true,
    venue: toVenue(db.prepare("SELECT * FROM venues WHERE id = ?").get(venueId) as VenueRow),
  };
}

/** Which venue a booking code belongs to — used to scope admin actions. */
export function getVenueIdForBookingCode(code: string): number | null {
  const row = getDb()
    .prepare(`
      SELECT c.venue_id AS venue_id FROM bookings b
      JOIN courts c ON c.id = b.court_id
      WHERE UPPER(b.code) = UPPER(?)
    `)
    .get(code.trim()) as { venue_id: number } | undefined;
  return row?.venue_id ?? null;
}

/** Venues touched by a series — a series should never span venues, but check. */
export function getVenueIdsForSeriesCode(seriesCode: string): number[] {
  const rows = getDb()
    .prepare(`
      SELECT DISTINCT c.venue_id AS venue_id FROM bookings b
      JOIN courts c ON c.id = b.court_id
      WHERE UPPER(b.series_code) = UPPER(?)
    `)
    .all(seriesCode.trim()) as { venue_id: number }[];
  return rows.map((r) => r.venue_id);
}

export interface AdminBookingRow extends Booking {
  courtName: string;
  sport: Sport;
  venueName: string;
  /** Prior no-shows by this phone number, so the desk can spot repeats. */
  priorNoShows: number;
}

export interface UserBookingRow extends Booking {
  courtName: string;
  sport: Sport;
  venueName: string;
  venueArea: string;
  venueAddress: string;
}

export function listUserBookings(userId: number): UserBookingRow[] {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT b.*, c.name AS court_name, c.sport AS court_sport,
             v.name AS venue_name, v.area AS venue_area, v.address AS venue_address,
             ci.checked_in_at, ci.checked_out_at
      FROM bookings b
      JOIN courts c ON c.id = b.court_id
      JOIN venues v ON v.id = c.venue_id
      LEFT JOIN check_ins ci ON ci.booking_id = b.id
      WHERE b.user_id = ?
      ORDER BY b.date DESC, b.start_hour DESC
    `)
    .all(userId) as (BookingRow & {
    court_name: string;
    court_sport: Sport;
    venue_name: string;
    venue_area: string;
    venue_address: string;
  })[];
  return rows.map((r) => ({
    ...toBooking(r),
    courtName: r.court_name,
    sport: r.court_sport,
    venueName: r.venue_name,
    venueArea: r.venue_area,
    venueAddress: r.venue_address,
  }));
}

/** Cancel a booking that belongs to this user (before it starts). */
export function cancelUserBooking(userId: number, bookingId: number): CancelResult {
  const db = getDb();
  const row = db
    .prepare("SELECT b.*, ci.checked_in_at, ci.checked_out_at FROM bookings b LEFT JOIN check_ins ci ON ci.booking_id = b.id WHERE b.id = ? AND b.user_id = ?")
    .get(bookingId, userId) as BookingRow | undefined;
  if (!row) return { ok: false, error: "Booking not found." };
  const booking = toBooking(row);
  if (booking.status === "cancelled") return { ok: false, error: "This booking is already cancelled." };
  const cutoff = cancelCutoffForBooking(booking.id);
  if (!isWithinCancelWindow(booking.date, booking.startHour, cutoff))
    return { ok: false, error: cutoffMessage(cutoff) };

  db.transaction(() => {
    db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(booking.id);
    db.prepare("DELETE FROM booking_slots WHERE booking_id = ?").run(booking.id);
  })();
  refundBookingToWallet(booking.id);
  // A freed place goes to whoever has waited longest.
  if (booking.classId) offerClassPlace(booking.classId);
  else offerSlotPlace(booking.courtId, booking.date);
  return { ok: true, booking: { ...booking, status: "cancelled" } };
}

export type PaymentResult = { ok: true; booking: Booking } | { ok: false; error: string };

/** Front-desk payment toggle for a single booking (admin only). */
export function setPaymentStatus(code: string, paid: boolean): PaymentResult {
  const db = getDb();
  const row = db
    .prepare("SELECT b.*, ci.checked_in_at, ci.checked_out_at FROM bookings b LEFT JOIN check_ins ci ON ci.booking_id = b.id WHERE UPPER(b.code) = UPPER(?)")
    .get(code.trim()) as BookingRow | undefined;
  if (!row) return { ok: false, error: "Booking not found." };
  const booking = toBooking(row);
  if (booking.status === "cancelled")
    return { ok: false, error: "This booking is cancelled." };
  if ((booking.paymentStatus === "paid") === paid)
    return { ok: false, error: `This booking is already marked ${paid ? "paid" : "unpaid"}.` };

  db.prepare(
    "UPDATE bookings SET payment_status = ?, paid_at = ? WHERE id = ?"
  ).run(paid ? "paid" : "unpaid", paid ? new Date().toISOString() : null, booking.id);
  return {
    ok: true,
    booking: {
      ...booking,
      paymentStatus: paid ? "paid" : "unpaid",
      paidAt: paid ? new Date().toISOString() : null,
    },
  };
}

/** Mark every confirmed session in a series paid at once. */
export function paySeries(seriesCode: string): { ok: boolean; paid: number; error?: string } {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM bookings WHERE UPPER(series_code) = UPPER(?) AND status = 'confirmed' AND payment_status = 'unpaid'"
    )
    .all(seriesCode.trim()) as BookingRow[];
  if (rows.length === 0)
    return { ok: false, paid: 0, error: "No unpaid sessions found for that series." };

  const now = new Date().toISOString();
  db.transaction(() => {
    for (const row of rows) {
      db.prepare("UPDATE bookings SET payment_status = 'paid', paid_at = ? WHERE id = ?").run(
        now,
        row.id
      );
    }
  })();
  return { ok: true, paid: rows.length };
}

export type CheckInResult = { ok: true; booking: Booking } | { ok: false; error: string };

function bookingByCode(code: string): Booking | null {
  const row = getDb()
    .prepare(
      "SELECT b.*, ci.checked_in_at, ci.checked_out_at FROM bookings b LEFT JOIN check_ins ci ON ci.booking_id = b.id WHERE UPPER(b.code) = UPPER(?)"
    )
    .get(code.trim()) as BookingRow | undefined;
  return row ? toBooking(row) : null;
}

/**
 * Check-in is only open from shortly before the slot until it ends, so an
 * early arrival cannot inflate the live headcount for the rest of the day.
 */
function checkInWindowError(booking: Booking): string | null {
  const now = Date.now();
  const opens =
    slotStartsAt(booking.date, booking.startHour).getTime() -
    CHECK_IN_OPENS_MINUTES_BEFORE * 60_000;
  if (now < opens)
    return `Check-in opens ${CHECK_IN_OPENS_MINUTES_BEFORE} minutes before your slot.`;
  if (now >= slotStartsAt(booking.date, booking.endHour).getTime())
    return "This booking has already ended.";
  return null;
}

/** Record an arrival at the front desk. */
export function checkIn(code: string): CheckInResult {
  const booking = bookingByCode(code);
  if (!booking) return { ok: false, error: "Booking not found." };
  return checkInBooking(booking);
}

/** Self-service check-in from the QR code on a booking. */
export function checkInByToken(token: string): CheckInResult {
  const trimmed = token.trim();
  if (trimmed === "") return { ok: false, error: "Booking not found." };
  const row = getDb()
    .prepare(
      "SELECT b.*, ci.checked_in_at, ci.checked_out_at FROM bookings b LEFT JOIN check_ins ci ON ci.booking_id = b.id WHERE b.check_in_token = ?"
    )
    .get(trimmed) as BookingRow | undefined;
  if (!row) return { ok: false, error: "Booking not found." };
  return checkInBooking(toBooking(row));
}

function checkInBooking(booking: Booking): CheckInResult {
  if (booking.status === "cancelled") return { ok: false, error: "This booking was cancelled." };
  if (booking.checkedInAt) return { ok: false, error: "Already checked in." };
  const windowError = checkInWindowError(booking);
  if (windowError) return { ok: false, error: windowError };

  const db = getDb();
  db.transaction(() => {
    db.prepare("INSERT INTO check_ins (booking_id) VALUES (?)").run(booking.id);
    // Arriving contradicts a no-show, so clear any stale flag.
    if (booking.noShow) db.prepare("UPDATE bookings SET no_show = 0 WHERE id = ?").run(booking.id);
  })();
  return { ok: true, booking: bookingByCode(booking.code)! };
}

export function checkOut(code: string): CheckInResult {
  const booking = bookingByCode(code);
  if (!booking) return { ok: false, error: "Booking not found." };
  if (!booking.checkedInAt) return { ok: false, error: "This booking has not checked in." };
  if (booking.checkedOutAt) return { ok: false, error: "Already checked out." };

  getDb()
    .prepare("UPDATE check_ins SET checked_out_at = datetime('now') WHERE booking_id = ?")
    .run(booking.id);
  return { ok: true, booking: bookingByCode(code)! };
}

/**
 * Who is inside each resource right now, from door check-ins.
 *
 * Someone counts as present when they have checked in, have not checked out,
 * and their booking has not ended yet — most people leave without telling the
 * desk, so the booking's end time is the backstop.
 */
export function getLiveOccupancy(venueId: number): LiveOccupancy[] {
  const db = getDb();
  const courts = (
    db.prepare("SELECT * FROM courts WHERE venue_id = ? ORDER BY id").all(venueId) as CourtRow[]
  ).map(toCourt);
  if (courts.length === 0) return [];

  const rows = db
    .prepare(`
      SELECT b.court_id, b.date, b.end_hour FROM check_ins ci
      JOIN bookings b ON b.id = ci.booking_id
      JOIN courts c ON c.id = b.court_id
      WHERE c.venue_id = ? AND ci.checked_out_at IS NULL
        AND b.status = 'confirmed' AND b.date = ?
    `)
    .all(venueId, todayISO()) as { court_id: number; date: string; end_hour: number }[];

  const now = Date.now();
  const present = new Map<number, number>();
  for (const row of rows) {
    if (slotStartsAt(row.date, row.end_hour).getTime() <= now) continue;
    present.set(row.court_id, (present.get(row.court_id) ?? 0) + 1);
  }

  return courts.map((court) => {
    const count = present.get(court.id) ?? 0;
    return {
      courtId: court.id,
      courtName: court.name,
      sport: court.sport,
      capacity: court.capacity,
      present: count,
      level: busyness(count, court.capacity),
    };
  });
}

export type NoShowResult = { ok: true; booking: Booking } | { ok: false; error: string };

/** Flag a passed booking whose customer never turned up (staff only). */
export function setNoShow(code: string, noShow: boolean): NoShowResult {
  const db = getDb();
  const row = db
    .prepare("SELECT b.*, ci.checked_in_at, ci.checked_out_at FROM bookings b LEFT JOIN check_ins ci ON ci.booking_id = b.id WHERE UPPER(b.code) = UPPER(?)")
    .get(code.trim()) as BookingRow | undefined;
  if (!row) return { ok: false, error: "Booking not found." };
  const booking = toBooking(row);

  if (booking.status === "cancelled")
    return { ok: false, error: "This booking was cancelled." };
  if (noShow && !isPastSlot(booking.date, booking.startHour))
    return { ok: false, error: "This booking has not started yet." };
  if (noShow && booking.checkedInAt)
    return { ok: false, error: "This customer checked in, so they were not a no-show." };
  if (booking.noShow === noShow)
    return { ok: false, error: `Already marked ${noShow ? "a no-show" : "attended"}.` };

  db.prepare("UPDATE bookings SET no_show = ? WHERE id = ?").run(noShow ? 1 : 0, booking.id);
  return { ok: true, booking: { ...booking, noShow } };
}

/** How many times this phone number has been flagged a no-show. */
export function countNoShows(phone: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM bookings WHERE phone = ? AND no_show = 1")
    .get(phone.trim()) as { n: number };
  return row.n;
}

export type CourtEditResult = { ok: true; court: Court } | { ok: false; error: string };

export function createCourt(input: {
  venueId: number;
  name: string;
  sport: Sport;
  offPeakRate: number;
  peakRate: number;
  capacity?: number;
}): CourtEditResult {
  const db = getDb();
  if (!getVenue(input.venueId)) return { ok: false, error: "Venue not found." };
  const info = db
    .prepare(
      "INSERT INTO courts (venue_id, name, sport, off_peak_rate, peak_rate, capacity) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(
      input.venueId,
      input.name.trim(),
      input.sport,
      input.offPeakRate,
      input.peakRate,
      input.capacity ?? 1
    );
  return { ok: true, court: getCourt(info.lastInsertRowid as number)! };
}

export function updateCourt(
  courtId: number,
  changes: { name?: string; offPeakRate?: number; peakRate?: number; capacity?: number }
): CourtEditResult {
  const db = getDb();
  const court = getCourt(courtId);
  if (!court) return { ok: false, error: "Court not found." };

  // Shrinking capacity below what is already booked would strand those
  // bookings, so refuse rather than silently overbook.
  if (changes.capacity !== undefined && changes.capacity < court.capacity) {
    const peak = db
      .prepare(`
        SELECT COUNT(*) AS n FROM booking_slots
        WHERE court_id = ? AND date >= date('now')
        GROUP BY date, hour ORDER BY n DESC LIMIT 1
      `)
      .get(courtId) as { n: number } | undefined;
    if (peak && peak.n > changes.capacity) {
      return {
        ok: false,
        error: `Capacity cannot go below ${peak.n} — that many places are already booked in an upcoming hour.`,
      };
    }
  }

  db.prepare(
    "UPDATE courts SET name = ?, off_peak_rate = ?, peak_rate = ?, capacity = ? WHERE id = ?"
  ).run(
    changes.name?.trim() ?? court.name,
    changes.offPeakRate ?? court.offPeakRate,
    changes.peakRate ?? court.peakRate,
    changes.capacity ?? court.capacity,
    courtId
  );
  return { ok: true, court: getCourt(courtId)! };
}

export function listBookingsForDate(date: string, venueId?: number): AdminBookingRow[] {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT b.*, c.name AS court_name, c.sport AS court_sport, v.name AS venue_name,
             ci.checked_in_at, ci.checked_out_at
      FROM bookings b
      JOIN courts c ON c.id = b.court_id
      JOIN venues v ON v.id = c.venue_id
      LEFT JOIN check_ins ci ON ci.booking_id = b.id
      WHERE b.date = ? AND (? IS NULL OR v.id = ?)
      ORDER BY v.id, c.id, b.start_hour
    `)
    .all(date, venueId ?? null, venueId ?? null) as (BookingRow & {
    court_name: string;
    court_sport: Sport;
    venue_name: string;
  })[];
  return rows.map((r) => {
    const booking = toBooking(r);
    return {
      ...booking,
      courtName: r.court_name,
      sport: r.court_sport,
      venueName: r.venue_name,
      // Exclude this booking so the count reads as history, not self-reference.
      priorNoShows: countNoShows(booking.phone) - (booking.noShow ? 1 : 0),
    };
  });
}

/* ---------------- Instructor-led classes ---------------- */

interface ClassRow {
  id: number;
  court_id: number;
  name: string;
  instructor: string;
  date: string;
  start_hour: number;
  end_hour: number;
  capacity: number;
  price: number;
  status: ClassStatus;
  series_code: string | null;
  court_name: string;
  sport: Sport;
  venue_id: number;
  venue_name: string;
  venue_area: string;
  enrolled: number;
}

const CLASS_SELECT = `
  SELECT cl.*, c.name AS court_name, c.sport AS sport,
         v.id AS venue_id, v.name AS venue_name, v.area AS venue_area,
         (SELECT COUNT(*) FROM bookings b
            WHERE b.class_id = cl.id AND b.status = 'confirmed') AS enrolled
  FROM classes cl
  JOIN courts c ON c.id = cl.court_id
  JOIN venues v ON v.id = c.venue_id
`;

function toClass(r: ClassRow): ClassSession {
  return {
    id: r.id,
    courtId: r.court_id,
    courtName: r.court_name,
    venueId: r.venue_id,
    venueName: r.venue_name,
    venueArea: r.venue_area,
    sport: r.sport,
    name: r.name,
    instructor: r.instructor,
    date: r.date,
    startHour: r.start_hour,
    endHour: r.end_hour,
    capacity: r.capacity,
    price: r.price,
    status: r.status,
    seriesCode: r.series_code,
    enrolled: r.enrolled,
  };
}

export function getClass(id: number): ClassSession | null {
  const row = getDb().prepare(`${CLASS_SELECT} WHERE cl.id = ?`).get(id) as ClassRow | undefined;
  return row ? toClass(row) : null;
}

/** Upcoming scheduled classes, soonest first. */
export function listClasses(filter: {
  venueId?: number;
  sport?: Sport;
  from?: string;
  to?: string;
  includeCancelled?: boolean;
} = {}): ClassSession[] {
  const from = filter.from ?? todayISO();
  const clauses = ["cl.date >= ?"];
  const params: (string | number)[] = [from];
  if (!filter.includeCancelled) clauses.push("cl.status = 'scheduled'");
  if (filter.venueId) {
    clauses.push("v.id = ?");
    params.push(filter.venueId);
  }
  if (filter.sport) {
    clauses.push("c.sport = ?");
    params.push(filter.sport);
  }
  if (filter.to) {
    clauses.push("cl.date <= ?");
    params.push(filter.to);
  }

  const rows = getDb()
    .prepare(`${CLASS_SELECT} WHERE ${clauses.join(" AND ")} ORDER BY cl.date, cl.start_hour, cl.id`)
    .all(...params) as ClassRow[];
  return rows.map(toClass);
}

export type CreateClassResult =
  | { ok: true; classes: ClassSession[]; seriesCode: string | null }
  | { ok: false; error: string };

/**
 * Schedule a class, optionally repeating weekly for a term. The resource must
 * be free for those hours — a class cannot be laid over existing bookings.
 */
export function createClassSessions(input: {
  courtId: number;
  name: string;
  instructor: string;
  date: string;
  startHour: number;
  endHour: number;
  capacity: number;
  price: number;
  weeks?: number;
}): CreateClassResult {
  const { courtId, date, startHour, endHour } = input;
  const weeks = input.weeks ?? 1;

  const court = getCourt(courtId);
  if (!court) return { ok: false, error: "Court not found." };
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > MAX_CLASS_WEEKS)
    return { ok: false, error: `Weeks must be between 1 and ${MAX_CLASS_WEEKS}.` };
  const { openHour, closeHour } = courtVenueHours(courtId);
  if (startHour < openHour || endHour > closeHour || endHour <= startHour)
    return { ok: false, error: "Class hours are outside operating hours." };
  if (getVenueClosure(court.venueId, date))
    return { ok: false, error: "The venue is closed that day." };
  if (input.capacity < 1 || input.capacity > court.capacity)
    return {
      ok: false,
      error: `Capacity must be 1–${court.capacity}, the capacity of ${court.name}.`,
    };
  if (isPastSlot(date, startHour))
    return { ok: false, error: "That start time has already passed." };

  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i);
  const db = getDb();
  const seriesCode = weeks > 1 ? randomCode("CL-") : null;

  const taken = db.prepare(
    `SELECT COUNT(*) AS n FROM booking_slots WHERE court_id = ? AND date = ? AND hour IN (${hours
      .map(() => "?")
      .join(",")})`
  );
  const insert = db.prepare(`
    INSERT INTO classes (court_id, name, instructor, date, start_hour, end_hour, capacity, price, series_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  try {
    const created = db.transaction(() => {
      const sessions: ClassSession[] = [];
      for (let week = 0; week < weeks; week++) {
        const weekDate = addDays(date, week * 7);
        if ((taken.get(courtId, weekDate, ...hours) as { n: number }).n > 0)
          throw new Error(`BOOKED:${weekDate}`);
        const clashes = classHoursOn(weekDate);
        if (hours.some((h) => clashes.has(`${courtId}:${h}`)))
          throw new Error(`CLASH:${weekDate}`);

        const id = insert.run(
          courtId, input.name.trim(), input.instructor.trim(), weekDate,
          startHour, endHour, input.capacity, input.price, seriesCode
        ).lastInsertRowid as number;
        sessions.push(getClass(id)!);
      }
      return sessions;
    })();
    return { ok: true, classes: created, seriesCode };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("BOOKED:"))
      return {
        ok: false,
        error: `${message.slice(7)} already has bookings in those hours. Cancel them first.`,
      };
    if (message.startsWith("CLASH:"))
      return { ok: false, error: `${message.slice(6)} already has a class at that time.` };
    throw err;
  }
}

export type EnrolResult = { ok: true; booking: Booking } | { ok: false; error: string };

/** Take a place in a class. The enrolment is an ordinary booking. */
export function enrolInClass(input: {
  classId: number;
  name: string;
  phone: string;
  email?: string;
  userId?: number;
}): EnrolResult {
  const session = getClass(input.classId);
  if (!session) return { ok: false, error: "Class not found." };
  if (session.status === "cancelled") return { ok: false, error: "This class was cancelled." };
  if (isPastSlot(session.date, session.startHour))
    return { ok: false, error: "This class has already started." };
  if (session.enrolled >= session.capacity)
    return { ok: false, error: "This class is full." };
  // The day may have been closed after the class was put in the diary.
  if (getVenueClosure(session.venueId, session.date))
    return { ok: false, error: "The venue is closed that day." };

  const already = getDb()
    .prepare(
      "SELECT id FROM bookings WHERE class_id = ? AND phone = ? AND status = 'confirmed'"
    )
    .get(session.id, input.phone.trim());
  if (already) return { ok: false, error: "You are already enrolled in this class." };

  const hours = Array.from(
    { length: session.endHour - session.startHour },
    (_, i) => session.startHour + i
  );
  const result = createBookingSeries({
    courtId: session.courtId,
    date: session.date,
    hours,
    weeks: 1,
    name: input.name,
    phone: input.phone,
    email: input.email,
    userId: input.userId,
    classId: session.id,
  });
  if (!result.ok) return { ok: false, error: result.error };

  // Price the enrolment at the class rate, not the court's hourly rate.
  getDb()
    .prepare("UPDATE bookings SET total_price = ? WHERE id = ?")
    .run(session.price, result.bookings[0].id);
  return { ok: true, booking: { ...result.bookings[0], totalPrice: session.price } };
}

/** Cancel a class and release every enrolment in it. */
export function cancelClassSession(classId: number): {
  ok: boolean;
  released: number;
  error?: string;
} {
  const session = getClass(classId);
  if (!session) return { ok: false, released: 0, error: "Class not found." };
  if (session.status === "cancelled")
    return { ok: false, released: 0, error: "This class is already cancelled." };

  const db = getDb();
  const enrolments = db
    .prepare("SELECT id FROM bookings WHERE class_id = ? AND status = 'confirmed'")
    .all(classId) as { id: number }[];

  db.transaction(() => {
    db.prepare("UPDATE classes SET status = 'cancelled' WHERE id = ?").run(classId);
    for (const row of enrolments) {
      db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(row.id);
      db.prepare("DELETE FROM booking_slots WHERE booking_id = ?").run(row.id);
    }
  })();
  for (const row of enrolments) refundBookingToWallet(row.id);
  return { ok: true, released: enrolments.length };
}

/** Who is coming to a class. */
export function getClassRoster(classId: number): Booking[] {
  const rows = getDb()
    .prepare(`
      SELECT b.*, ci.checked_in_at, ci.checked_out_at FROM bookings b
      LEFT JOIN check_ins ci ON ci.booking_id = b.id
      WHERE b.class_id = ? ORDER BY b.status, b.id
    `)
    .all(classId) as BookingRow[];
  return rows.map(toBooking);
}

/* ---------------- Stored credit ---------------- */

interface WalletRow {
  id: number;
  amount: number;
  reason: string;
  booking_id: number | null;
  created_at: string;
}

function toWalletEntry(r: WalletRow): WalletEntry {
  return {
    id: r.id,
    amount: r.amount,
    reason: r.reason,
    bookingId: r.booking_id,
    createdAt: r.created_at,
  };
}

export function getWalletBalance(userId: number): number {
  const row = getDb()
    .prepare("SELECT COALESCE(SUM(amount), 0) AS balance FROM wallet_entries WHERE user_id = ?")
    .get(userId) as { balance: number };
  return row.balance;
}

/** Most recent movements first. */
export function listWalletEntries(userId: number, limit = 50): WalletEntry[] {
  const rows = getDb()
    .prepare(
      "SELECT id, amount, reason, booking_id, created_at FROM wallet_entries WHERE user_id = ? ORDER BY id DESC LIMIT ?"
    )
    .all(userId, Math.min(Math.max(limit, 1), 200)) as WalletRow[];
  return rows.map(toWalletEntry);
}

export type WalletResult =
  | { ok: true; balance: number; entry: WalletEntry }
  | { ok: false; error: string };

/** Record credit bought at the counter. */
export function topUpWallet(input: {
  userId: number;
  amount: number;
  adminId: number;
  reason?: string;
}): WalletResult {
  if (!Number.isInteger(input.amount) || input.amount < 1 || input.amount > MAX_TOP_UP)
    return { ok: false, error: `Top-up must be RM1–${MAX_TOP_UP}.` };
  const db = getDb();
  const user = db.prepare("SELECT id FROM users WHERE id = ?").get(input.userId);
  if (!user) return { ok: false, error: "Customer not found." };

  const info = db
    .prepare(
      "INSERT INTO wallet_entries (user_id, amount, reason, admin_id) VALUES (?, ?, ?, ?)"
    )
    .run(input.userId, input.amount, input.reason?.trim() || "Counter top-up", input.adminId);
  return {
    ok: true,
    balance: getWalletBalance(input.userId),
    entry: toWalletEntry(
      db.prepare("SELECT id, amount, reason, booking_id, created_at FROM wallet_entries WHERE id = ?")
        .get(info.lastInsertRowid) as WalletRow
    ),
  };
}

/**
 * Settle a booking from its owner's stored credit. Balance is re-read inside
 * the transaction so two concurrent payments cannot overdraw it.
 */
export function payBookingFromWallet(bookingId: number): WalletResult {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT b.*, ci.checked_in_at, ci.checked_out_at FROM bookings b LEFT JOIN check_ins ci ON ci.booking_id = b.id WHERE b.id = ?"
    )
    .get(bookingId) as BookingRow | undefined;
  if (!row) return { ok: false, error: "Booking not found." };
  const booking = toBooking(row);

  if (!row.user_id) return { ok: false, error: "This booking has no account to charge." };
  if (booking.status === "cancelled") return { ok: false, error: "This booking was cancelled." };
  if (booking.paymentStatus === "paid") return { ok: false, error: "This booking is already paid." };

  const userId = row.user_id;
  try {
    const entryId = db.transaction(() => {
      const balance = getWalletBalance(userId);
      if (balance < booking.totalPrice) throw new Error("INSUFFICIENT");
      const info = db
        .prepare(
          "INSERT INTO wallet_entries (user_id, amount, reason, booking_id) VALUES (?, ?, ?, ?)"
        )
        .run(userId, -booking.totalPrice, `Booking ${booking.code}`, booking.id);
      db.prepare(
        "UPDATE bookings SET payment_status = 'paid', paid_at = datetime('now') WHERE id = ?"
      ).run(booking.id);
      return info.lastInsertRowid;
    })();

    return {
      ok: true,
      balance: getWalletBalance(userId),
      entry: toWalletEntry(
        db.prepare("SELECT id, amount, reason, booking_id, created_at FROM wallet_entries WHERE id = ?")
          .get(entryId) as WalletRow
      ),
    };
  } catch (err) {
    if (err instanceof Error && err.message === "INSUFFICIENT")
      return { ok: false, error: "Not enough credit. Top up at the counter or pay there." };
    throw err;
  }
}

/** Was this booking settled from stored credit? */
function walletChargeFor(bookingId: number): { user_id: number; amount: number } | null {
  const row = getDb()
    .prepare(
      "SELECT user_id, amount FROM wallet_entries WHERE booking_id = ? AND amount < 0 ORDER BY id LIMIT 1"
    )
    .get(bookingId) as { user_id: number; amount: number } | undefined;
  return row ?? null;
}

/**
 * Put a wallet-paid booking's money back when it is cancelled. Refunding twice
 * is refused, so a double cancellation cannot mint credit.
 */
export function refundBookingToWallet(bookingId: number): WalletResult {
  const charge = walletChargeFor(bookingId);
  if (!charge) return { ok: false, error: "This booking was not paid from credit." };

  const db = getDb();
  const refunded = db
    .prepare("SELECT id FROM wallet_entries WHERE booking_id = ? AND amount > 0")
    .get(bookingId);
  if (refunded) return { ok: false, error: "This booking has already been refunded." };

  const code = (db.prepare("SELECT code FROM bookings WHERE id = ?").get(bookingId) as
    | { code: string }
    | undefined)?.code;
  const info = db
    .prepare("INSERT INTO wallet_entries (user_id, amount, reason, booking_id) VALUES (?, ?, ?, ?)")
    .run(charge.user_id, -charge.amount, `Refund for ${code ?? "booking"}`, bookingId);

  return {
    ok: true,
    balance: getWalletBalance(charge.user_id),
    entry: toWalletEntry(
      db.prepare("SELECT id, amount, reason, booking_id, created_at FROM wallet_entries WHERE id = ?")
        .get(info.lastInsertRowid) as WalletRow
    ),
  };
}

/** Find a customer by email or phone, for the counter. */
export function findUserForWallet(
  query: string
): { id: number; name: string; email: string; phone: string; balance: number } | null {
  const trimmed = query.trim();
  if (trimmed === "") return null;
  const row = getDb()
    .prepare("SELECT id, name, email, phone FROM users WHERE email = ? OR phone = ?")
    .get(trimmed, trimmed) as
    | { id: number; name: string; email: string; phone: string }
    | undefined;
  return row ? { ...row, balance: getWalletBalance(row.id) } : null;
}

/* ---------------- Waitlists ---------------- */

interface WaitlistRow {
  id: number;
  class_id: number | null;
  court_id: number | null;
  date: string | null;
  start_hour: number | null;
  end_hour: number | null;
  name: string;
  phone: string;
  email: string | null;
  user_id: number | null;
  status: WaitlistStatus;
  offered_at: string | null;
  offer_token: string | null;
  created_at: string;
}

function toWaitlistEntry(r: WaitlistRow, includeToken = false): WaitlistEntry {
  const entry: WaitlistEntry = {
    id: r.id,
    classId: r.class_id,
    courtId: r.court_id,
    date: r.date,
    startHour: r.start_hour,
    endHour: r.end_hour,
    name: r.name,
    phone: r.phone,
    status: r.status,
    offeredAt: r.offered_at,
    offerToken: includeToken ? r.offer_token : null,
    createdAt: r.created_at,
  };
  if (r.status === "offered" && r.offered_at) {
    const deadline = parseUtc(r.offered_at) + WAITLIST_OFFER_MINUTES * 60_000;
    entry.expiresInSeconds = Math.max(0, Math.round((deadline - Date.now()) / 1000));
  }
  return entry;
}

/** SQLite's datetime('now') is UTC without a zone marker. */
function parseUtc(stamp: string): number {
  return new Date(stamp.includes("Z") ? stamp : `${stamp.replace(" ", "T")}Z`).getTime();
}

/**
 * Time out offers nobody claimed. There is no scheduler, so this runs at the
 * start of every waitlist operation — the queue is only ever read through one
 * of these, so a stale offer never blocks the next person for long.
 */
function expireStaleOffers(): void {
  const db = getDb();
  const rows = db
    .prepare("SELECT id, offered_at FROM waitlist WHERE status = 'offered'")
    .all() as { id: number; offered_at: string | null }[];
  const now = Date.now();
  for (const row of rows) {
    if (!row.offered_at) continue;
    if (parseUtc(row.offered_at) + WAITLIST_OFFER_MINUTES * 60_000 <= now) {
      db.prepare(
        "UPDATE waitlist SET status = 'expired', offer_token = NULL WHERE id = ?"
      ).run(row.id);
    }
  }
}

export type WaitlistResult =
  | { ok: true; entry: WaitlistEntry; position: number }
  | { ok: false; error: string };

/** Queue for a class place. Only possible while the class is actually full. */
export function joinClassWaitlist(input: {
  classId: number;
  name: string;
  phone: string;
  email?: string;
  userId?: number;
}): WaitlistResult {
  expireStaleOffers();
  const session = getClass(input.classId);
  if (!session) return { ok: false, error: "Class not found." };
  if (session.status === "cancelled") return { ok: false, error: "This class was cancelled." };
  if (isPastSlot(session.date, session.startHour))
    return { ok: false, error: "This class has already started." };
  if (session.enrolled < session.capacity)
    return { ok: false, error: "This class still has places — enrol instead." };

  const db = getDb();
  const already = db
    .prepare(
      "SELECT id FROM waitlist WHERE class_id = ? AND phone = ? AND status IN ('waiting','offered')"
    )
    .get(input.classId, input.phone.trim());
  if (already) return { ok: false, error: "You are already on this waitlist." };
  const enrolled = db
    .prepare("SELECT id FROM bookings WHERE class_id = ? AND phone = ? AND status = 'confirmed'")
    .get(input.classId, input.phone.trim());
  if (enrolled) return { ok: false, error: "You are already enrolled in this class." };

  const info = db
    .prepare(
      "INSERT INTO waitlist (class_id, name, phone, email, user_id) VALUES (?, ?, ?, ?, ?)"
    )
    .run(
      input.classId,
      input.name.trim(),
      input.phone.trim(),
      input.email?.trim() ?? null,
      input.userId ?? null
    );
  const entry = toWaitlistEntry(
    db.prepare("SELECT * FROM waitlist WHERE id = ?").get(info.lastInsertRowid) as WaitlistRow
  );
  return { ok: true, entry, position: classQueue(input.classId).length };
}

function classQueue(classId: number): WaitlistRow[] {
  return getDb()
    .prepare(
      "SELECT * FROM waitlist WHERE class_id = ? AND status IN ('waiting','offered') ORDER BY id"
    )
    .all(classId) as WaitlistRow[];
}

/**
 * A place in a class opened up: offer it to the person who has waited longest.
 * Does nothing if someone already holds a live offer for it.
 */
export function offerClassPlace(classId: number): WaitlistEntry | null {
  expireStaleOffers();
  const queue = classQueue(classId);
  if (queue.some((row) => row.status === "offered")) return null;

  const session = getClass(classId);
  if (!session || session.status === "cancelled") return null;
  if (session.enrolled >= session.capacity) return null;

  const next = queue.find((row) => row.status === "waiting");
  if (!next) return null;

  const db = getDb();
  db.prepare(
    "UPDATE waitlist SET status = 'offered', offered_at = datetime('now'), offer_token = ? WHERE id = ?"
  ).run(randomBytes(16).toString("hex"), next.id);
  return toWaitlistEntry(
    db.prepare("SELECT * FROM waitlist WHERE id = ?").get(next.id) as WaitlistRow,
    true
  );
}

export type ClaimResult =
  | { ok: true; booking: Booking; entry: WaitlistEntry }
  | { ok: false; error: string };

/** Take up an offered place. The offer token is the only way in. */
export function claimWaitlistOffer(token: string): ClaimResult {
  expireStaleOffers();
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM waitlist WHERE offer_token = ?")
    .get(token.trim()) as WaitlistRow | undefined;
  if (!row) return { ok: false, error: "This offer is no longer valid." };
  if (row.status !== "offered")
    return { ok: false, error: "This offer has expired or was already claimed." };

  let booking: Booking;
  if (row.class_id) {
    const enrolled = enrolInClass({
      classId: row.class_id,
      name: row.name,
      phone: row.phone,
      email: row.email ?? undefined,
      userId: row.user_id ?? undefined,
    });
    if (!enrolled.ok) return { ok: false, error: enrolled.error };
    booking = enrolled.booking;
  } else if (row.court_id && row.date && row.start_hour !== null && row.end_hour !== null) {
    const hours = Array.from(
      { length: row.end_hour - row.start_hour },
      (_, i) => row.start_hour! + i
    );
    const created = createBooking({
      courtId: row.court_id,
      date: row.date,
      hours,
      name: row.name,
      phone: row.phone,
      email: row.email ?? undefined,
      userId: row.user_id ?? undefined,
    });
    if (!created.ok) {
      // Somebody beat them to it. Keep their place rather than burning it.
      db.prepare(
        "UPDATE waitlist SET status = 'waiting', offered_at = NULL, offer_token = NULL WHERE id = ?"
      ).run(row.id);
      return { ok: false, error: created.error };
    }
    booking = created.booking;
  } else {
    return { ok: false, error: "This offer is no longer valid." };
  }

  db.prepare("UPDATE waitlist SET status = 'claimed', offer_token = NULL WHERE id = ?").run(row.id);
  return {
    ok: true,
    booking,
    entry: toWaitlistEntry(
      db.prepare("SELECT * FROM waitlist WHERE id = ?").get(row.id) as WaitlistRow
    ),
  };
}

/** Give up a place in the queue. */
export function leaveWaitlist(entryId: number, phone: string): { ok: boolean; error?: string } {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM waitlist WHERE id = ? AND phone = ?")
    .get(entryId, phone.trim()) as WaitlistRow | undefined;
  if (!row) return { ok: false, error: "Waitlist entry not found." };
  if (row.status === "claimed") return { ok: false, error: "This place was already claimed." };

  db.prepare("UPDATE waitlist SET status = 'cancelled', offer_token = NULL WHERE id = ?").run(row.id);
  // Someone dropping out may free a live offer for the next person.
  if (row.class_id) offerClassPlace(row.class_id);
  else if (row.court_id && row.date) offerSlotPlace(row.court_id, row.date);
  return { ok: true };
}

/** The queue for a class, for staff. */
export function listClassWaitlist(classId: number): WaitlistEntry[] {
  expireStaleOffers();
  const rows = getDb()
    .prepare(
      "SELECT * FROM waitlist WHERE class_id = ? AND status IN ('waiting','offered') ORDER BY id"
    )
    .all(classId) as WaitlistRow[];
  return rows.map((r) => toWaitlistEntry(r));
}

/** What this person is queuing for, with any live offer's token. */
export function listWaitlistFor(phone: string): WaitlistEntry[] {
  expireStaleOffers();
  const rows = getDb()
    .prepare(
      "SELECT * FROM waitlist WHERE phone = ? AND status IN ('waiting','offered') ORDER BY id DESC"
    )
    .all(phone.trim()) as WaitlistRow[];
  return rows.map((row) => {
    const entry = toWaitlistEntry(row, row.status === "offered");
    if (row.class_id) {
      const session = getClass(row.class_id);
      if (session) {
        entry.label = `${session.name} · ${session.date} ${formatHourLabel(session.startHour)}`;
      }
    } else if (row.court_id && row.date && row.start_hour !== null) {
      const court = getCourt(row.court_id);
      if (court) {
        entry.label = `${court.name} · ${row.date} ${formatHourLabel(row.start_hour)}`;
      }
    }
    return entry;
  });
}

function formatHourLabel(hour: number): string {
  const h = hour % 24;
  const suffix = h >= 12 ? "PM" : "AM";
  return `${h % 12 === 0 ? 12 : h % 12}:00 ${suffix}`;
}

/* ---------------- Waitlists for ordinary slots ---------------- */

/** Are all these hours free on this resource right now? */
function slotHoursFree(courtId: number, date: string, hours: number[]): boolean {
  const court = getCourt(courtId);
  if (!court) return false;
  const db = getDb();
  const classes = classHoursOn(date);
  for (const hour of hours) {
    if (classes.has(`${courtId}:${hour}`)) return false;
    const blocked = db
      .prepare("SELECT 1 FROM slot_blocks WHERE court_id = ? AND date = ? AND hour = ?")
      .get(courtId, date, hour);
    if (blocked) return false;
    const taken = db
      .prepare(
        "SELECT COUNT(*) AS n FROM booking_slots WHERE court_id = ? AND date = ? AND hour = ?"
      )
      .get(courtId, date, hour) as { n: number };
    if (taken.n >= court.capacity) return false;
  }
  return true;
}

/** Queue for a court or facility slot that is currently taken. */
export function joinSlotWaitlist(input: {
  courtId: number;
  date: string;
  startHour: number;
  endHour: number;
  name: string;
  phone: string;
  email?: string;
  userId?: number;
}): WaitlistResult {
  expireStaleOffers();
  const { courtId, date, startHour, endHour } = input;

  const waitCourt = getCourt(courtId);
  if (!waitCourt) return { ok: false, error: "Court not found." };
  const { openHour, closeHour } = courtVenueHours(courtId);
  if (endHour <= startHour || startHour < openHour || endHour > closeHour)
    return { ok: false, error: "Those hours are outside operating hours." };
  if (getVenueClosure(waitCourt.venueId, date))
    return { ok: false, error: "The venue is closed that day." };
  if (endHour - startHour > MAX_HOURS_PER_BOOKING)
    return { ok: false, error: `Maximum ${MAX_HOURS_PER_BOOKING} hours per booking.` };
  if (!isBookableDate(date)) return { ok: false, error: "Date is outside the booking window." };
  if (isPastSlot(date, startHour)) return { ok: false, error: "That time has already passed." };

  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i);
  if (slotHoursFree(courtId, date, hours))
    return { ok: false, error: "That slot is free — book it instead." };

  const db = getDb();
  const already = db
    .prepare(`
      SELECT id FROM waitlist
      WHERE court_id = ? AND date = ? AND start_hour = ? AND phone = ?
        AND status IN ('waiting','offered')
    `)
    .get(courtId, date, startHour, input.phone.trim());
  if (already) return { ok: false, error: "You are already on this waitlist." };

  const info = db
    .prepare(`
      INSERT INTO waitlist (court_id, date, start_hour, end_hour, name, phone, email, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      courtId, date, startHour, endHour,
      input.name.trim(), input.phone.trim(), input.email?.trim() ?? null, input.userId ?? null
    );

  const entry = toWaitlistEntry(
    db.prepare("SELECT * FROM waitlist WHERE id = ?").get(info.lastInsertRowid) as WaitlistRow
  );
  return { ok: true, entry, position: slotQueue(courtId, date).length };
}

function slotQueue(courtId: number, date: string): WaitlistRow[] {
  return getDb()
    .prepare(
      "SELECT * FROM waitlist WHERE court_id = ? AND date = ? AND status IN ('waiting','offered') ORDER BY id"
    )
    .all(courtId, date) as WaitlistRow[];
}

/**
 * Hours freed up on a resource: offer them to the longest waiter whose
 * requested window is now entirely free. One live offer per resource and day,
 * so overlapping windows cannot be promised to two people at once.
 */
export function offerSlotPlace(courtId: number, date: string): WaitlistEntry | null {
  expireStaleOffers();
  const queue = slotQueue(courtId, date);
  if (queue.some((row) => row.status === "offered")) return null;

  for (const row of queue) {
    if (row.status !== "waiting" || row.start_hour === null || row.end_hour === null) continue;
    const hours = Array.from(
      { length: row.end_hour - row.start_hour },
      (_, i) => row.start_hour! + i
    );
    if (isPastSlot(date, row.start_hour)) continue;
    if (!slotHoursFree(courtId, date, hours)) continue;

    const db = getDb();
    db.prepare(
      "UPDATE waitlist SET status = 'offered', offered_at = datetime('now'), offer_token = ? WHERE id = ?"
    ).run(randomBytes(16).toString("hex"), row.id);
    return toWaitlistEntry(
      db.prepare("SELECT * FROM waitlist WHERE id = ?").get(row.id) as WaitlistRow,
      true
    );
  }
  return null;
}
