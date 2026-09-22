import { getDb } from "./db";
import {
  Booking,
  Court,
  CourtAvailability,
  OPEN_HOUR,
  CLOSE_HOUR,
  MAX_HOURS_PER_BOOKING,
  MAX_RECUR_WEEKS,
  Sport,
  Venue,
} from "./types";
import {
  addDays,
  isBookableDate,
  isPastSlot,
  isPeak,
  isWithinCancelWindow,
} from "./time";

interface CourtRow {
  id: number;
  venue_id: number;
  name: string;
  sport: Sport;
  off_peak_rate: number;
  peak_rate: number;
}

interface VenueRow {
  id: number;
  name: string;
  area: string;
  address: string;
  phone: string;
  cancel_cutoff_hours: number;
}

function toVenue(r: VenueRow): Venue {
  return {
    id: r.id,
    name: r.name,
    area: r.area,
    address: r.address,
    phone: r.phone,
    cancelCutoffHours: r.cancel_cutoff_hours,
  };
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
}

function toCourt(r: CourtRow): Court {
  return {
    id: r.id,
    venueId: r.venue_id,
    name: r.name,
    sport: r.sport,
    offPeakRate: r.off_peak_rate,
    peakRate: r.peak_rate,
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

  const taken = db
    .prepare("SELECT court_id, hour FROM booking_slots WHERE date = ? AND court_id IN (SELECT id FROM courts WHERE venue_id = ?)")
    .all(date, venueId) as { court_id: number; hour: number }[];
  const takenSet = new Set(taken.map((t) => `${t.court_id}:${t.hour}`));

  const blocked = db
    .prepare("SELECT court_id, hour FROM slot_blocks WHERE date = ? AND court_id IN (SELECT id FROM courts WHERE venue_id = ?)")
    .all(date, venueId) as { court_id: number; hour: number }[];
  const blockedSet = new Set(blocked.map((b) => `${b.court_id}:${b.hour}`));

  return courts.map((court) => ({
    court,
    slots: Array.from({ length: CLOSE_HOUR - OPEN_HOUR }, (_, i) => {
      const hour = OPEN_HOUR + i;
      const key = `${court.id}:${hour}`;
      return {
        hour,
        rate: isPeak(date, hour) ? court.peakRate : court.offPeakRate,
        available: !takenSet.has(key) && !blockedSet.has(key) && !isPastSlot(date, hour),
      };
    }),
  }));
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
  const fromHour = Math.max(input.fromHour ?? OPEN_HOUR, OPEN_HOUR);
  // A booking of `duration` hours must finish by CLOSE_HOUR.
  const lastStart = Math.min(input.toHour ?? CLOSE_HOUR, CLOSE_HOUR - duration);
  const limit = Math.min(Math.max(input.limit ?? 60, 1), 200);
  if (fromHour > lastStart) return [];

  const params: (string | number)[] = [input.sport];
  let sql = `
    SELECT c.*, v.id AS v_id, v.name AS v_name, v.area AS v_area,
           v.address AS v_address, v.phone AS v_phone,
           v.cancel_cutoff_hours AS v_cutoff
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
  })[];
  if (rows.length === 0) return [];

  const courtIds = rows.map((r) => r.id);
  const idList = courtIds.map(() => "?").join(",");
  const taken = db
    .prepare(`SELECT court_id, hour FROM booking_slots WHERE date = ? AND court_id IN (${idList})`)
    .all(input.date, ...courtIds) as { court_id: number; hour: number }[];
  const blocked = db
    .prepare(`SELECT court_id, hour FROM slot_blocks WHERE date = ? AND court_id IN (${idList})`)
    .all(input.date, ...courtIds) as { court_id: number; hour: number }[];
  const unavailable = new Set([
    ...taken.map((t) => `${t.court_id}:${t.hour}`),
    ...blocked.map((b) => `${b.court_id}:${b.hour}`),
  ]);

  const results: SearchResult[] = [];
  for (const row of rows) {
    const court = toCourt(row);
    const venue: Venue = {
      id: row.v_id,
      name: row.v_name,
      area: row.v_area,
      address: row.v_address,
      phone: row.v_phone,
      cancelCutoffHours: row.v_cutoff,
    };
    for (let start = fromHour; start <= lastStart; start++) {
      const hours = Array.from({ length: duration }, (_, i) => start + i);
      const free = hours.every(
        (h) => !unavailable.has(`${court.id}:${h}`) && !isPastSlot(input.date, h)
      );
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
}): CreateSeriesResult {
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
  if (hours[0] < OPEN_HOUR || hours[hours.length - 1] >= CLOSE_HOUR)
    return { ok: false, error: "Selected hours are outside operating hours." };
  if (isPastSlot(date, hours[0]))
    return { ok: false, error: "That time slot has already passed." };

  const db = getDb();
  const placeholders = hours.map(() => "?").join(",");
  const takenCheck = db.prepare(
    `SELECT COUNT(*) AS n FROM booking_slots WHERE court_id = ? AND date = ? AND hour IN (${placeholders})`
  );
  const blockedCheck = db.prepare(
    `SELECT COUNT(*) AS n FROM slot_blocks WHERE court_id = ? AND date = ? AND hour IN (${placeholders})`
  );
  const insertBooking = db.prepare(`
    INSERT INTO bookings (code, court_id, date, start_hour, end_hour, name, phone, email, total_price, user_id, series_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSlot = db.prepare(
    "INSERT INTO booking_slots (booking_id, court_id, date, hour) VALUES (?, ?, ?, ?)"
  );

  const seriesCode = weeks > 1 ? generateSeriesCode() : null;

  try {
    const result = db.transaction(() => {
      const bookings: Booking[] = [];
      const skipped: SeriesSkip[] = [];
      for (let week = 0; week < weeks; week++) {
        const weekDate = addDays(date, week * 7);
        let reason: string | null = null;
        if ((takenCheck.get(courtId, weekDate, ...hours) as { n: number }).n > 0) {
          reason = "already booked";
        } else if ((blockedCheck.get(courtId, weekDate, ...hours) as { n: number }).n > 0) {
          reason = "closed for maintenance";
        }
        if (reason) {
          if (!skipConflicts) throw new Error(`CONFLICT:${weekDate}:${reason}`);
          skipped.push({ date: weekDate, reason });
          continue;
        }
        const bookingId = insertBooking.run(
          generateCode(), courtId, weekDate, hours[0], hours[hours.length - 1] + 1,
          name, phone, email ?? null, computePrice(court, weekDate, hours),
          userId ?? null, seriesCode
        ).lastInsertRowid as number;
        for (const hour of hours) insertSlot.run(bookingId, courtId, weekDate, hour);
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
              : "One or more of those slots was just booked by someone else. Please pick again.",
      };
    }
    if (message === "ALL_CONFLICT") {
      return { ok: false, error: "Every week in that series is already taken. Please pick another slot." };
    }
    if (message.includes("UNIQUE constraint failed: booking_slots")) {
      return { ok: false, error: "One or more of those slots was just booked by someone else. Please pick again." };
    }
    if (message.includes("UNIQUE constraint failed: bookings.code")) {
      // Astronomically rare code collision — one retry is plenty.
      return createBookingSeries(input);
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
  return { ok: true, cancelled: future.length };
}

function getBookingById(id: number): Booking | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM bookings WHERE id = ?").get(id) as BookingRow | undefined;
  return row ? toBooking(row) : null;
}

export function findBooking(code: string, phone: string): Booking | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM bookings WHERE UPPER(code) = UPPER(?) AND phone = ?")
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
  return { ok: true, booking: { ...booking, status: "cancelled" } };
}

export type AdminSlotStatus = "free" | "booked" | "blocked" | "past";

export interface AdminCourtSlots {
  court: Court;
  slots: { hour: number; status: AdminSlotStatus; bookingCode?: string; blockReason?: string }[];
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
    `)
    .all(date, venueId) as { court_id: number; hour: number; code: string }[];
  const bookedMap = new Map(booked.map((b) => [`${b.court_id}:${b.hour}`, b.code]));

  const blocks = db
    .prepare("SELECT court_id, hour, reason FROM slot_blocks WHERE date = ? AND court_id IN (SELECT id FROM courts WHERE venue_id = ?)")
    .all(date, venueId) as { court_id: number; hour: number; reason: string | null }[];
  const blockMap = new Map(blocks.map((b) => [`${b.court_id}:${b.hour}`, b.reason ?? ""]));

  return courts.map((court) => ({
    court,
    slots: Array.from({ length: CLOSE_HOUR - OPEN_HOUR }, (_, i) => {
      const hour = OPEN_HOUR + i;
      const key = `${court.id}:${hour}`;
      const bookingCode = bookedMap.get(key);
      const blockReason = blockMap.get(key);
      const status: AdminSlotStatus = bookingCode
        ? "booked"
        : blockReason !== undefined
          ? "blocked"
          : isPastSlot(date, hour)
            ? "past"
            : "free";
      return {
        hour,
        status,
        ...(bookingCode ? { bookingCode } : {}),
        ...(blockReason !== undefined ? { blockReason } : {}),
      };
    }),
  }));
}

export type BlockResult = { ok: true; changed: number } | { ok: false; error: string };

/** Block hours on a court (maintenance/closure). Skips hours that are booked. */
export function blockSlots(courtId: number, date: string, hours: number[], reason?: string): BlockResult {
  if (!getCourt(courtId)) return { ok: false, error: "Court not found." };
  const valid = [...new Set(hours)].filter((h) => h >= OPEN_HOUR && h < CLOSE_HOUR);
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
    .prepare("SELECT * FROM bookings WHERE UPPER(code) = UPPER(?)")
    .get(code.trim()) as BookingRow | undefined;
  if (!row) return { ok: false, error: "Booking not found." };
  const booking = toBooking(row);
  if (booking.status === "cancelled") return { ok: false, error: "This booking is already cancelled." };

  db.transaction(() => {
    db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(booking.id);
    db.prepare("DELETE FROM booking_slots WHERE booking_id = ?").run(booking.id);
  })();
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

  return {
    totalSlotsPerDay: CLOSE_HOUR - OPEN_HOUR,
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

export function createVenue(input: {
  name: string;
  area: string;
  address: string;
  phone: string;
}): VenueEditResult {
  const db = getDb();
  const info = db
    .prepare("INSERT INTO venues (name, area, address, phone) VALUES (?, ?, ?, ?)")
    .run(input.name.trim(), input.area.trim(), input.address.trim(), input.phone.trim());
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
  }
): VenueEditResult {
  const db = getDb();
  const row = db.prepare("SELECT * FROM venues WHERE id = ?").get(venueId) as VenueRow | undefined;
  if (!row) return { ok: false, error: "Venue not found." };
  const current = toVenue(row);

  db.prepare(
    "UPDATE venues SET name = ?, area = ?, address = ?, phone = ?, cancel_cutoff_hours = ? WHERE id = ?"
  ).run(
    changes.name?.trim() ?? current.name,
    changes.area?.trim() ?? current.area,
    changes.address?.trim() ?? current.address,
    changes.phone?.trim() ?? current.phone,
    changes.cancelCutoffHours ?? current.cancelCutoffHours,
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
             v.name AS venue_name, v.area AS venue_area, v.address AS venue_address
      FROM bookings b
      JOIN courts c ON c.id = b.court_id
      JOIN venues v ON v.id = c.venue_id
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
    .prepare("SELECT * FROM bookings WHERE id = ? AND user_id = ?")
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
  return { ok: true, booking: { ...booking, status: "cancelled" } };
}

export type PaymentResult = { ok: true; booking: Booking } | { ok: false; error: string };

/** Front-desk payment toggle for a single booking (admin only). */
export function setPaymentStatus(code: string, paid: boolean): PaymentResult {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM bookings WHERE UPPER(code) = UPPER(?)")
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

export type NoShowResult = { ok: true; booking: Booking } | { ok: false; error: string };

/** Flag a passed booking whose customer never turned up (staff only). */
export function setNoShow(code: string, noShow: boolean): NoShowResult {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM bookings WHERE UPPER(code) = UPPER(?)")
    .get(code.trim()) as BookingRow | undefined;
  if (!row) return { ok: false, error: "Booking not found." };
  const booking = toBooking(row);

  if (booking.status === "cancelled")
    return { ok: false, error: "This booking was cancelled." };
  if (noShow && !isPastSlot(booking.date, booking.startHour))
    return { ok: false, error: "This booking has not started yet." };
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
}): CourtEditResult {
  const db = getDb();
  if (!getVenue(input.venueId)) return { ok: false, error: "Venue not found." };
  const info = db
    .prepare(
      "INSERT INTO courts (venue_id, name, sport, off_peak_rate, peak_rate) VALUES (?, ?, ?, ?, ?)"
    )
    .run(input.venueId, input.name.trim(), input.sport, input.offPeakRate, input.peakRate);
  return { ok: true, court: getCourt(info.lastInsertRowid as number)! };
}

export function updateCourt(
  courtId: number,
  changes: { name?: string; offPeakRate?: number; peakRate?: number }
): CourtEditResult {
  const db = getDb();
  const court = getCourt(courtId);
  if (!court) return { ok: false, error: "Court not found." };
  db.prepare("UPDATE courts SET name = ?, off_peak_rate = ?, peak_rate = ? WHERE id = ?").run(
    changes.name?.trim() ?? court.name,
    changes.offPeakRate ?? court.offPeakRate,
    changes.peakRate ?? court.peakRate,
    courtId
  );
  return { ok: true, court: getCourt(courtId)! };
}

export function listBookingsForDate(date: string, venueId?: number): AdminBookingRow[] {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT b.*, c.name AS court_name, c.sport AS court_sport, v.name AS venue_name
      FROM bookings b
      JOIN courts c ON c.id = b.court_id
      JOIN venues v ON v.id = c.venue_id
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
