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
  MAX_MEMBERSHIP_MONTHS,
  MAX_PASS_ENTRIES,
  Membership,
  MembershipStatus,
  MAX_PROMO_AMOUNT,
  MAX_PROMO_PERCENT,
  PromoCode,
  PromoKind,
  PromoStatus,
  MAX_PASS_MONTHS,
  Pass,
  PassEntry,
  PassStatus,
  SPORTS,
  SPORT_LABELS,
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
  formatHour,
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
  member_off_peak_rate: number | null;
  member_peak_rate: number | null;
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
    memberOffPeakRate: r.member_off_peak_rate,
    memberPeakRate: r.member_peak_rate,
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

/**
 * Courts at a venue that could take this whole booking, cheapest first.
 * Price is peak-aware, so the order can differ between a morning and an
 * evening slot on the same courts.
 */
/** Errors that mean "that court went", rather than something structural. */
const TAKEN_ERROR = /just booked|filling up very quickly|filled up|already taken/i;

export function courtsForAnyBooking(input: {
  venueId: number;
  sport: Sport;
  date: string;
  hours: number[];
}): Court[] {
  const { venueId, sport, date } = input;
  const hours = [...new Set(input.hours)].sort((a, b) => a - b);
  if (hours.length === 0) return [];

  const db = getDb();
  const courts = (
    db
      .prepare("SELECT * FROM courts WHERE venue_id = ? AND sport = ? ORDER BY id")
      .all(venueId, sport) as CourtRow[]
  ).map(toCourt);
  if (courts.length === 0) return [];

  const classHours = classHoursOn(date, venueId);
  const taken = countTakenPlaces(date, venueId);
  const blocked = blockedPlacesOn(date, venueId);

  const free = courts.filter((court) =>
    hours.every((hour) => {
      const key = `${court.id}:${hour}`;
      return (
        (taken.get(key) ?? 0) + (blocked.get(key) ?? 0) < court.capacity &&
        !classHours.has(key) &&
        !isPastSlot(date, hour)
      );
    })
  );

  return free.sort((a, b) => {
    const diff = computePrice(a, date, hours) - computePrice(b, date, hours);
    return diff !== 0 ? diff : a.id - b.id;
  });
}

/**
 * Book without naming a court: take the cheapest one free for the whole slot.
 *
 * The candidate list is re-read rather than trusted from the client, and if
 * the cheapest is taken in the moment between choosing and inserting, the next
 * one is tried. That is the point of not naming a court — the customer said
 * they do not mind, so a race should cost them a different court, not the
 * booking.
 */
export function createBookingOnAnyCourt(input: {
  venueId: number;
  sport: Sport;
  date: string;
  hours: number[];
  weeks?: number;
  skipConflicts?: boolean;
  name: string;
  phone: string;
  email?: string;
  userId?: number;
}): CreateSeriesResult {
  const { venueId, sport, date, hours, ...rest } = input;

  const venue = getDb().prepare("SELECT id FROM venues WHERE id = ?").get(venueId);
  if (!venue) return { ok: false, error: "Venue not found." };
  if (!SPORTS.includes(sport)) return { ok: false, error: "Unknown sport." };

  const candidates = courtsForAnyBooking({ venueId, sport, date, hours });
  if (candidates.length === 0) {
    // Fall through to the single-court path on any court of that sport, so the
    // customer gets the real reason (closed day, outside hours, past slot)
    // rather than a flat "nothing free".
    const anyCourt = (
      getDb()
        .prepare("SELECT * FROM courts WHERE venue_id = ? AND sport = ? ORDER BY id LIMIT 1")
        .all(venueId, sport) as CourtRow[]
    ).map(toCourt)[0];
    if (!anyCourt)
      return { ok: false, error: `That venue has no ${SPORT_LABELS[sport]} courts.` };
    const probe = createBookingSeries({ ...rest, courtId: anyCourt.id, date, hours, weeks: input.weeks ?? 1 });
    if (probe.ok) return probe; // it came free between the two reads
    // A "someone took it" error from the probe is about that one court, and
    // the customer never chose it. Say what is actually true of all of them.
    if (TAKEN_ERROR.test(probe.error))
      return { ok: false, error: "No court is free for that whole time. Please pick another time." };
    return probe;
  }

  let lastError = "No court is free for that whole time. Please pick another time.";
  for (const court of candidates) {
    const result = createBookingSeries({
      ...rest,
      courtId: court.id,
      date,
      hours,
      weeks: input.weeks ?? 1,
    });
    if (result.ok) return result;
    lastError = result.error;
    // Anything that is not "someone took it" applies to every court equally,
    // so there is no point walking the rest of the list.
    if (!TAKEN_ERROR.test(result.error)) return result;
  }
  return { ok: false, error: lastError };
}

/**
 * `courtId:hour` -> how many places are out of service on a date.
 *
 * A NULL `places` means the whole resource, so it resolves to that court's
 * capacity here. That keeps a capacity-1 court behaving exactly as before: one
 * place blocked out of one is the court closed.
 */
function blockedPlacesOn(date: string, venueId?: number): Map<string, number> {
  const rows = getDb()
    .prepare(`
      SELECT b.court_id AS court_id, b.hour AS hour,
             COALESCE(b.places, c.capacity) AS places
      FROM slot_blocks b JOIN courts c ON c.id = b.court_id
      WHERE b.date = ?
        AND (? IS NULL OR c.venue_id = ?)
    `)
    .all(date, venueId ?? null, venueId ?? null) as {
    court_id: number;
    hour: number;
    places: number;
  }[];
  return new Map(rows.map((r) => [`${r.court_id}:${r.hour}`, r.places]));
}

/** Places out of service on one court-hour. */
function blockedPlacesFor(courtId: number, date: string, hours: number[]): Map<number, number> {
  if (hours.length === 0) return new Map();
  const list = hours.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`
      SELECT b.hour AS hour, COALESCE(b.places, c.capacity) AS places
      FROM slot_blocks b JOIN courts c ON c.id = b.court_id
      WHERE b.court_id = ? AND b.date = ? AND b.hour IN (${list})
    `)
    .all(courtId, date, ...hours) as { hour: number; places: number }[];
  return new Map(rows.map((r) => [r.hour, r.places]));
}

/** Availability grid for every court of a venue (optionally one sport) on a date. */
export function getAvailability(
  venueId: number,
  date: string,
  sport?: Sport,
  /** Price the grid at member rates, for a caller known to be a member. */
  member = false
): CourtAvailability[] {
  const db = getDb();
  let courts = (
    db.prepare("SELECT * FROM courts WHERE venue_id = ? ORDER BY id").all(venueId) as CourtRow[]
  ).map(toCourt);
  if (sport) courts = courts.filter((c) => c.sport === sport);

  const takenCounts = countTakenPlaces(date, venueId);

  const blockedPlaces = blockedPlacesOn(date, venueId);
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
      const out = blockedPlaces.get(key) ?? 0;
      const session = classHours.get(key);
      // A partial block shrinks the resource rather than closing it, so the
      // hour stays bookable until the remaining places are gone.
      const shut = closed || booked + out >= court.capacity;
      return {
        hour,
        rate: computePrice(court, date, [hour], member),
        booked,
        capacity: court.capacity,
        // A class owns the hour: enrolling is the only way in.
        available: !shut && !session && !isPastSlot(date, hour),
        ...(session ? { className: session.name, classId: session.id } : {}),
        // Only meaningful while places remain; `blocked` covers the rest.
        ...(out > 0 && !shut ? { blockedPlaces: out } : {}),
        ...(closed || (out > 0 && shut) ? { blocked: true } : {}),
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
  const blockedPlaces = blockedPlacesOn(input.date);
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
          (takenCounts.get(key) ?? 0) + (blockedPlaces.get(key) ?? 0) < court.capacity &&
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

/**
 * What a booking costs. A member pays the court's member rate where it has
 * one; where it does not, they pay the public rate, so a venue can discount
 * only some of its courts.
 */
export function computePrice(
  court: Court,
  date: string,
  hours: number[],
  member = false
): number {
  return hours.reduce((sum, h) => {
    const peak = isPeak(date, h);
    if (member) {
      const rate = peak ? court.memberPeakRate : court.memberOffPeakRate;
      if (rate !== null) return sum + rate;
    }
    return sum + (peak ? court.peakRate : court.offPeakRate);
  }, 0);
}

/** Does this court charge members less, at any hour? */
export function hasMemberRate(court: Court): boolean {
  return court.memberOffPeakRate !== null || court.memberPeakRate !== null;
}

function randomCode(prefix: string): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = prefix;
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

const generateCode = () => randomCode("MS-");
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
  /**
   * Does a block leave room for one more? A partial block shrinks the
   * resource, so it only closes the hour once the places left run out.
   */
  const blockedOut = (weekDate: string): boolean => {
    const blocked = blockedPlacesFor(courtId, weekDate, hours);
    if (blocked.size === 0) return false;
    const takenHere = db.prepare(
      "SELECT COUNT(*) AS n FROM booking_slots WHERE court_id = ? AND date = ? AND hour = ?"
    );
    return hours.some((hour) => {
      const out = blocked.get(hour) ?? 0;
      if (out === 0) return false;
      const taken = (takenHere.get(courtId, weekDate, hour) as { n: number }).n;
      return taken + out >= court.capacity;
    });
  };
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

  // Member rates are decided per session, against the date that session falls
  // on: a membership that lapses part-way through a weekly series discounts
  // the weeks it covers and no more.
  const memberOn = (weekDate: string) =>
    activeMembership(court.venueId, phone, weekDate) !== null;

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
        } else if (blockedOut(weekDate)) {
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
          name, phone, email ?? null, computePrice(court, weekDate, hours, memberOn(weekDate)),
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
  for (const row of future) refundBooking(row.id);
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
  refundBooking(booking.id);
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
    /** Places out of service this hour, while some remain bookable. */
    blockedPlaces?: number;
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
    .prepare("SELECT court_id, hour, reason, places FROM slot_blocks WHERE date = ? AND court_id IN (SELECT id FROM courts WHERE venue_id = ?)")
    .all(date, venueId) as {
    court_id: number;
    hour: number;
    reason: string | null;
    places: number | null;
  }[];
  const blockMap = new Map(blocks.map((b) => [`${b.court_id}:${b.hour}`, b]));
  const blockedPlaces = blockedPlacesOn(date, venueId);

  const { openHour, closeHour } = venueHours(venueId);
  const closure = getVenueClosure(venueId, date);

  return courts.map((court) => ({
    court,
    slots: Array.from({ length: closeHour - openHour }, (_, i) => {
      const hour = openHour + i;
      const key = `${court.id}:${hour}`;
      const count = bookedCounts.get(key) ?? 0;
      const block = blockMap.get(key);
      const out = blockedPlaces.get(key) ?? 0;
      // A whole-day closure reads as a block on every hour that is not sold.
      const blockReason =
        block !== undefined
          ? block.reason ?? ""
          : closure
            ? closure.reason ?? "Closed"
            : undefined;
      // A shared facility only reads as "booked" once every place is gone, and
      // a partial block only reads as "blocked" once it has taken the last one.
      // A whole-day closure is not a partial anything: it shuts the hour flat.
      const shutByBlock =
        closure !== null || (block !== undefined && count + out >= court.capacity);
      const status: AdminSlotStatus =
        count >= court.capacity
          ? "booked"
          : shutByBlock
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
        ...(out > 0 && !shutByBlock ? { blockedPlaces: out } : {}),
      };
    }),
  }));
}

export type BlockResult = { ok: true; changed: number } | { ok: false; error: string };

/** Block hours on a court (maintenance/closure). Skips hours that are booked. */
export function blockSlots(
  courtId: number,
  date: string,
  hours: number[],
  reason?: string,
  /**
   * How many places to take out. Omitted means the whole resource, which is
   * the only thing a court can mean. On a shared facility a number takes that
   * many places out and leaves the rest bookable.
   */
  places?: number
): BlockResult {
  const court = getCourt(courtId);
  if (!court) return { ok: false, error: "Court not found." };
  const { openHour, closeHour } = courtVenueHours(courtId);
  const valid = [...new Set(hours)].filter((h) => h >= openHour && h < closeHour);
  if (valid.length === 0) return { ok: false, error: "No valid hours given." };

  const partial = places !== undefined && places !== null;
  if (partial) {
    if (!Number.isInteger(places) || places! < 1 || places! > court.capacity)
      return { ok: false, error: `Places out must be 1–${court.capacity}.` };
    if (court.capacity === 1)
      return { ok: false, error: "An exclusive court is blocked whole, not in parts." };
  }

  const db = getDb();
  const isBooked = db.prepare(
    "SELECT COUNT(*) AS n FROM booking_slots WHERE court_id = ? AND date = ? AND hour = ?"
  );
  // One block row per court-hour, so re-blocking an hour revises it.
  const insert = db.prepare(`
    INSERT INTO slot_blocks (court_id, date, hour, reason, places) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (court_id, date, hour)
    DO UPDATE SET reason = excluded.reason, places = excluded.places
  `);

  let changed = 0;
  let strandedAt: number | null = null;
  db.transaction(() => {
    for (const hour of valid) {
      const booked = (isBooked.get(courtId, date, hour) as { n: number }).n;
      // Taking out more places than are free would strand a booking.
      const wanted = partial ? places! : court.capacity;
      if (booked + wanted > court.capacity) {
        if (partial && strandedAt === null) strandedAt = hour;
        continue;
      }
      changed += insert.run(courtId, date, hour, reason ?? null, partial ? places! : null).changes;
    }
  })();

  if (changed === 0 && strandedAt !== null)
    return {
      ok: false,
      error: `Only ${court.capacity - (isBooked.get(courtId, date, strandedAt) as { n: number }).n} place(s) are free at ${formatHour(strandedAt)}.`,
    };
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
  refundBooking(booking.id);
  // A freed place goes to whoever has waited longest.
  if (booking.classId) offerClassPlace(booking.classId);
  else offerSlotPlace(booking.courtId, booking.date);
  return { ok: true, booking: { ...booking, status: "cancelled" } };
}

export type MoveResult =
  | { ok: true; booking: Booking; fromCourt: Court; toCourt: Court }
  | { ok: false; error: string };

/**
 * Move a confirmed booking to another court, keeping everything that makes it
 * the same booking: its code, what was paid and how, and any check-in. The
 * alternative staff have without this is cancel-and-rebook, which issues a new
 * code, drops the payment record and un-checks-in anyone already inside.
 *
 * The price does not change. A move is the venue's convenience, not the
 * customer's, so it never costs them more — nor do they gain from being put on
 * a cheaper court.
 */
export function moveBooking(code: string, toCourtId: number): MoveResult {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT b.*, ci.checked_in_at, ci.checked_out_at FROM bookings b LEFT JOIN check_ins ci ON ci.booking_id = b.id WHERE UPPER(b.code) = UPPER(?)"
    )
    .get(code.trim()) as BookingRow | undefined;
  if (!row) return { ok: false, error: "Booking not found." };
  const booking = toBooking(row);

  if (booking.status === "cancelled")
    return { ok: false, error: "This booking was cancelled." };
  if (booking.classId !== null)
    return { ok: false, error: "A class enrolment moves with its class, not on its own." };

  const fromCourt = getCourt(booking.courtId);
  const toCourt = getCourt(toCourtId);
  if (!fromCourt || !toCourt) return { ok: false, error: "Court not found." };
  if (fromCourt.id === toCourt.id)
    return { ok: false, error: "That booking is already on that court." };
  if (fromCourt.venueId !== toCourt.venueId)
    return { ok: false, error: "A booking can only move within the same venue." };
  if (fromCourt.sport !== toCourt.sport)
    return {
      ok: false,
      error: `${toCourt.name} is for ${SPORT_LABELS[toCourt.sport]}, not ${SPORT_LABELS[fromCourt.sport]}.`,
    };

  const hours = Array.from(
    { length: booking.endHour - booking.startHour },
    (_, i) => booking.startHour + i
  );
  // A booking that is wholly in the past is history; there is nothing to move.
  if (isPastSlot(booking.date, hours[hours.length - 1]))
    return { ok: false, error: "That booking has already finished." };

  const blockedThere = blockedPlacesFor(toCourtId, booking.date, hours);
  const takenThere = db.prepare(
    "SELECT COUNT(*) AS n FROM booking_slots WHERE court_id = ? AND date = ? AND hour = ?"
  );
  for (const hour of hours) {
    const out = blockedThere.get(hour) ?? 0;
    if (out === 0) continue;
    const taken = (takenThere.get(toCourtId, booking.date, hour) as { n: number }).n;
    if (taken + out >= toCourt.capacity)
      return { ok: false, error: `${toCourt.name} is blocked off for part of that time.` };
  }

  const classHours = classHoursOn(booking.date, toCourt.venueId);
  for (const hour of hours) {
    const session = classHours.get(`${toCourtId}:${hour}`);
    if (session)
      return { ok: false, error: `${toCourt.name} is running ${session.name} at that time.` };
  }

  const seatsTaken = db.prepare(
    "SELECT seat FROM booking_slots WHERE court_id = ? AND date = ? AND hour = ?"
  );

  try {
    db.transaction(() => {
      // Free the old places first, so a court can be swapped with itself in a
      // shared facility and so the target sees a true picture.
      db.prepare("DELETE FROM booking_slots WHERE booking_id = ?").run(booking.id);

      const insert = db.prepare(
        "INSERT INTO booking_slots (booking_id, court_id, date, hour, seat) VALUES (?, ?, ?, ?, ?)"
      );
      for (const hour of hours) {
        const used = new Set(
          (seatsTaken.all(toCourtId, booking.date, hour) as { seat: number }[]).map((r) => r.seat)
        );
        let seat: number | null = null;
        for (let s = 0; s < toCourt.capacity; s++) {
          if (!used.has(s)) { seat = s; break; }
        }
        if (seat === null) throw new Error(`FULL:${hour}`);
        // The unique index is the real guard; a racing insert fails here.
        insert.run(booking.id, toCourtId, booking.date, hour, seat);
      }
      db.prepare("UPDATE bookings SET court_id = ? WHERE id = ?").run(toCourtId, booking.id);
    })();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("FULL:")) {
      const hour = err.message.slice(5);
      return { ok: false, error: `${toCourt.name} is already taken at ${formatHour(Number(hour))}.` };
    }
    if (err instanceof Error && /UNIQUE constraint failed/.test(err.message))
      return { ok: false, error: `${toCourt.name} was taken while you were moving it. Try again.` };
    throw err;
  }

  // The court it left may now be free for somebody waiting on it.
  offerSlotPlace(fromCourt.id, booking.date);

  return {
    ok: true,
    booking: { ...booking, courtId: toCourtId },
    fromCourt,
    toCourt,
  };
}

/** Courts a booking could move to right now, for the staff picker. */
export function moveTargetsFor(code: string): Court[] {
  const booking = bookingByCode(code);
  if (!booking || booking.status === "cancelled" || booking.classId !== null) return [];
  const court = getCourt(booking.courtId);
  if (!court) return [];
  const hours = Array.from(
    { length: booking.endHour - booking.startHour },
    (_, i) => booking.startHour + i
  );
  const db = getDb();
  const candidates = (
    db
      .prepare("SELECT * FROM courts WHERE venue_id = ? AND sport = ? AND id != ? ORDER BY id")
      .all(court.venueId, court.sport, court.id) as CourtRow[]
  ).map(toCourt);

  const classHours = classHoursOn(booking.date, court.venueId);
  return candidates.filter((c) => {
    const blocked = blockedPlacesFor(c.id, booking.date, hours);
    for (const hour of hours) {
      if (classHours.has(`${c.id}:${hour}`)) return false;
      const taken = db
        .prepare(
          "SELECT COUNT(*) AS n FROM booking_slots WHERE court_id = ? AND date = ? AND hour = ?"
        )
        .get(c.id, booking.date, hour) as { n: number };
      if (taken.n + (blocked.get(hour) ?? 0) >= c.capacity) return false;
    }
    return true;
  });
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
  // A partial block does not remove an hour from the day, so only count the
  // blocks that take the whole resource.
  const blockedRows = db
    .prepare(`
      SELECT b.court_id AS court_id, b.date AS date, COUNT(*) AS n
      FROM slot_blocks b JOIN courts c ON c.id = b.court_id
      WHERE b.date >= ? AND b.date <= ?
        AND COALESCE(b.places, c.capacity) >= c.capacity
      GROUP BY b.court_id, b.date
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
  refundBooking(booking.id);
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
  changes: {
    name?: string;
    offPeakRate?: number;
    peakRate?: number;
    /** null clears it, so members pay the public rate on this court again. */
    memberOffPeakRate?: number | null;
    memberPeakRate?: number | null;
    capacity?: number;
  }
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

  const memberOffPeak =
    changes.memberOffPeakRate !== undefined ? changes.memberOffPeakRate : court.memberOffPeakRate;
  const memberPeak =
    changes.memberPeakRate !== undefined ? changes.memberPeakRate : court.memberPeakRate;
  const offPeak = changes.offPeakRate ?? court.offPeakRate;
  const peak = changes.peakRate ?? court.peakRate;

  // A member rate above the public one is not a member rate.
  if (memberOffPeak !== null && memberOffPeak > offPeak)
    return { ok: false, error: "The off-peak member rate is higher than the public one." };
  if (memberPeak !== null && memberPeak > peak)
    return { ok: false, error: "The peak member rate is higher than the public one." };
  if ((memberOffPeak !== null && memberOffPeak < 0) || (memberPeak !== null && memberPeak < 0))
    return { ok: false, error: "A member rate cannot be negative." };

  db.prepare(`
    UPDATE courts SET name = ?, off_peak_rate = ?, peak_rate = ?,
                      member_off_peak_rate = ?, member_peak_rate = ?, capacity = ?
    WHERE id = ?
  `).run(
    changes.name?.trim() ?? court.name,
    offPeak,
    peak,
    memberOffPeak,
    memberPeak,
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
  for (const row of enrolments) refundBooking(row.id);
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

/**
 * Undo whatever a cancelled booking was settled with. A booking is paid from
 * credit or with a pass, never both, so each call is a no-op for the other.
 */
function refundBooking(bookingId: number): void {
  refundBookingToWallet(bookingId);
  refundBookingToPass(bookingId);
  // The customer never had the benefit, so a limited code is not poorer for it.
  releasePromoUse(bookingId);
}

/* ---------------- Memberships ---------------- */

interface MembershipRow {
  id: number;
  code: string;
  venue_id: number;
  venue_name: string;
  holder_name: string;
  holder_phone: string;
  starts_on: string;
  expires_on: string;
  price: number;
  status: MembershipStatus;
}

const MEMBERSHIP_SELECT = `
  SELECT m.id, m.code, m.venue_id, v.name AS venue_name, m.holder_name, m.holder_phone,
         m.starts_on, m.expires_on, m.price, m.status
  FROM memberships m JOIN venues v ON v.id = m.venue_id
`;

function toMembership(r: MembershipRow): Membership {
  const m: Membership = {
    id: r.id,
    code: r.code,
    venueId: r.venue_id,
    venueName: r.venue_name,
    holderName: r.holder_name,
    holderPhone: r.holder_phone,
    startsOn: r.starts_on,
    expiresOn: r.expires_on,
    price: r.price,
    status: r.status,
  };
  const reason = membershipBlockedReason(m);
  return reason ? { ...m, unusableReason: reason } : m;
}

/** Why a membership is not giving member rates today. */
function membershipBlockedReason(m: Membership): string | null {
  if (m.status === "void") return "This membership was cancelled.";
  const today = todayISO();
  if (today < m.startsOn) return `This membership starts on ${m.startsOn}.`;
  if (today > m.expiresOn) return `This membership expired on ${m.expiresOn}.`;
  return null;
}

/**
 * Is this phone number a live member of this venue on this date?
 *
 * Membership is held against the phone number, not an account, so someone who
 * booked as a guest still gets their rate. The date checked is the booking's,
 * not today's: a membership that lapses before the session does not discount it.
 */
export function activeMembership(
  venueId: number,
  phone: string,
  onDate?: string
): Membership | null {
  const digits = normalisePhone(phone);
  if (digits.length < 6) return null;
  const date = onDate ?? todayISO();
  const rows = getDb()
    .prepare(`${MEMBERSHIP_SELECT} WHERE m.venue_id = ? AND m.status = 'active'`)
    .all(venueId) as MembershipRow[];
  const match = rows.find(
    (r) =>
      normalisePhone(r.holder_phone) === digits &&
      r.starts_on <= date &&
      r.expires_on >= date
  );
  return match ? toMembership(match) : null;
}

/** Every membership a phone number holds, newest first. */
export function listMembershipsFor(input: { phone?: string; userId?: number }): Membership[] {
  const phone = input.phone?.trim() || null;
  const userId = input.userId ?? null;
  if (phone === null && userId === null) return [];
  const rows = getDb()
    .prepare(`
      ${MEMBERSHIP_SELECT}
      WHERE (? IS NOT NULL AND m.holder_phone = ?) OR (? IS NOT NULL AND m.user_id = ?)
      ORDER BY m.id DESC
    `)
    .all(phone, phone, userId, userId) as MembershipRow[];
  return rows.map(toMembership);
}

export function listMembershipsForVenue(venueId: number, limit = 200): Membership[] {
  const rows = getDb()
    .prepare(`${MEMBERSHIP_SELECT} WHERE m.venue_id = ? ORDER BY m.id DESC LIMIT ?`)
    .all(venueId, Math.min(Math.max(limit, 1), 500)) as MembershipRow[];
  return rows.map(toMembership);
}

export function membershipById(id: number): Membership | null {
  const row = getDb().prepare(`${MEMBERSHIP_SELECT} WHERE m.id = ?`).get(id) as
    | MembershipRow
    | undefined;
  return row ? toMembership(row) : null;
}

export type MembershipResult =
  | { ok: true; membership: Membership }
  | { ok: false; error: string };

/** Sell a membership at the counter. */
export function sellMembership(input: {
  venueId: number;
  holderName: string;
  holderPhone: string;
  startsOn: string;
  expiresOn: string;
  price: number;
  adminId: number;
  userId?: number;
}): MembershipResult {
  const db = getDb();
  if (!db.prepare("SELECT id FROM venues WHERE id = ?").get(input.venueId))
    return { ok: false, error: "Venue not found." };

  const holderName = input.holderName.trim();
  const holderPhone = input.holderPhone.trim();
  if (holderName.length < 2 || holderPhone.length < 6)
    return { ok: false, error: "A holder name and phone number are required." };
  if (!Number.isInteger(input.price) || input.price < 0)
    return { ok: false, error: "Price must be a whole number of ringgit." };
  if (!isValidDateString(input.startsOn) || !isValidDateString(input.expiresOn))
    return { ok: false, error: "Invalid dates." };
  if (input.expiresOn < input.startsOn)
    return { ok: false, error: "The end date is before the start date." };
  if (input.expiresOn < todayISO())
    return { ok: false, error: "That membership would already have expired." };
  if (input.expiresOn > addDays(todayISO(), MAX_MEMBERSHIP_MONTHS * 31))
    return {
      ok: false,
      error: `A membership may not run more than ${MAX_MEMBERSHIP_MONTHS} months.`,
    };

  // Overlapping memberships at one venue would make "which rate?" ambiguous.
  const clash = (
    db
      .prepare(`${MEMBERSHIP_SELECT} WHERE m.venue_id = ? AND m.status = 'active'`)
      .all(input.venueId) as MembershipRow[]
  ).find(
    (r) =>
      normalisePhone(r.holder_phone) === normalisePhone(holderPhone) &&
      r.starts_on <= input.expiresOn &&
      r.expires_on >= input.startsOn
  );
  if (clash)
    return {
      ok: false,
      error: `That number already has a membership here until ${clash.expires_on}.`,
    };

  const info = db
    .prepare(`
      INSERT INTO memberships (code, venue_id, holder_name, holder_phone, user_id,
                               starts_on, expires_on, price, admin_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      randomCode("MB-"), input.venueId, holderName, holderPhone, input.userId ?? null,
      input.startsOn, input.expiresOn, input.price, input.adminId
    );
  return { ok: true, membership: membershipById(Number(info.lastInsertRowid))! };
}

/** Cancel a membership. Bookings already made keep the price they were given. */
export function voidMembership(id: number): MembershipResult {
  const m = membershipById(id);
  if (!m) return { ok: false, error: "Membership not found." };
  if (m.status === "void") return { ok: false, error: "This membership is already cancelled." };
  getDb().prepare("UPDATE memberships SET status = 'void' WHERE id = ?").run(id);
  return { ok: true, membership: membershipById(id)! };
}

/* ---------------- Promo codes ---------------- */

interface PromoRow {
  id: number;
  code: string;
  venue_id: number;
  venue_name: string;
  sport: Sport | null;
  description: string;
  kind: PromoKind;
  value: number;
  min_hours: number;
  valid_from: string;
  valid_to: string;
  max_uses: number | null;
  status: PromoStatus;
  used: number;
}

const PROMO_SELECT = `
  SELECT p.id, p.code, p.venue_id, v.name AS venue_name, p.sport, p.description,
         p.kind, p.value, p.min_hours, p.valid_from, p.valid_to, p.max_uses, p.status,
         (SELECT COUNT(*) FROM promo_uses u WHERE u.promo_id = p.id) AS used
  FROM promo_codes p JOIN venues v ON v.id = p.venue_id
`;

function toPromo(r: PromoRow): PromoCode {
  const promo: PromoCode = {
    id: r.id,
    code: r.code,
    venueId: r.venue_id,
    venueName: r.venue_name,
    sport: r.sport,
    description: r.description,
    kind: r.kind,
    value: r.value,
    minHours: r.min_hours,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    maxUses: r.max_uses,
    used: r.used,
    status: r.status,
  };
  const reason = promoBlockedReason(promo);
  return reason ? { ...promo, unusableReason: reason } : promo;
}

/** Why a code is dead regardless of which booking it is put against. */
function promoBlockedReason(p: PromoCode): string | null {
  if (p.status === "void") return "This code was withdrawn.";
  if (p.maxUses !== null && p.used >= p.maxUses) return "This code has been fully claimed.";
  if (p.validTo < todayISO()) return `This code ran out on ${p.validTo}.`;
  return null;
}

/** What a code takes off a price. Never more than the price itself. */
function promoDiscount(p: Pick<PromoCode, "kind" | "value">, price: number): number {
  const off = p.kind === "percent" ? Math.floor((price * p.value) / 100) : p.value;
  return Math.max(0, Math.min(off, price));
}

export function getPromoCode(venueId: number, code: string): PromoCode | null {
  const row = getDb()
    .prepare(`${PROMO_SELECT} WHERE p.venue_id = ? AND UPPER(p.code) = UPPER(?)`)
    .get(venueId, code.trim()) as PromoRow | undefined;
  return row ? toPromo(row) : null;
}

export function listPromoCodes(venueId: number): PromoCode[] {
  const rows = getDb()
    .prepare(`${PROMO_SELECT} WHERE p.venue_id = ? ORDER BY p.id DESC`)
    .all(venueId) as PromoRow[];
  return rows.map(toPromo);
}

export type PromoEditResult = { ok: true; promo: PromoCode } | { ok: false; error: string };

export function createPromoCode(input: {
  venueId: number;
  code: string;
  description: string;
  kind: PromoKind;
  value: number;
  sport?: Sport | null;
  minHours?: number;
  validFrom: string;
  validTo: string;
  maxUses?: number | null;
  adminId: number;
}): PromoEditResult {
  const db = getDb();
  if (!db.prepare("SELECT id FROM venues WHERE id = ?").get(input.venueId))
    return { ok: false, error: "Venue not found." };

  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9-]{3,20}$/.test(code))
    return { ok: false, error: "A code is 3–20 letters, digits or dashes." };
  if (input.description.trim().length < 3)
    return { ok: false, error: "Describe what the code is for." };
  if (input.kind !== "percent" && input.kind !== "amount")
    return { ok: false, error: "Unknown discount type." };
  if (!Number.isInteger(input.value) || input.value < 1)
    return { ok: false, error: "The discount must be a whole number above zero." };
  if (input.kind === "percent" && input.value > MAX_PROMO_PERCENT)
    return { ok: false, error: `A percentage cannot exceed ${MAX_PROMO_PERCENT}.` };
  if (input.kind === "amount" && input.value > MAX_PROMO_AMOUNT)
    return { ok: false, error: `A fixed discount cannot exceed RM${MAX_PROMO_AMOUNT}.` };

  const minHours = input.minHours ?? 1;
  if (!Number.isInteger(minHours) || minHours < 1 || minHours > MAX_HOURS_PER_BOOKING)
    return { ok: false, error: `Minimum hours must be 1–${MAX_HOURS_PER_BOOKING}.` };
  if (!isValidDateString(input.validFrom) || !isValidDateString(input.validTo))
    return { ok: false, error: "Invalid dates." };
  if (input.validTo < input.validFrom)
    return { ok: false, error: "The end date is before the start date." };
  if (input.maxUses !== undefined && input.maxUses !== null &&
      (!Number.isInteger(input.maxUses) || input.maxUses < 1))
    return { ok: false, error: "A usage limit must be a whole number above zero." };
  if (input.sport && !SPORTS.includes(input.sport))
    return { ok: false, error: "Unknown sport." };
  if (input.sport) {
    const has = db
      .prepare("SELECT 1 FROM courts WHERE venue_id = ? AND sport = ? LIMIT 1")
      .get(input.venueId, input.sport);
    if (!has) return { ok: false, error: "That venue has no courts for that sport." };
  }
  if (getPromoCode(input.venueId, code))
    return { ok: false, error: `${code} already exists at this venue.` };

  const info = db
    .prepare(`
      INSERT INTO promo_codes (code, venue_id, sport, description, kind, value,
                               min_hours, valid_from, valid_to, max_uses, admin_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      code, input.venueId, input.sport ?? null, input.description.trim(), input.kind,
      input.value, minHours, input.validFrom, input.validTo, input.maxUses ?? null, input.adminId
    );
  return { ok: true, promo: promoById(Number(info.lastInsertRowid))! };
}

export function promoById(id: number): PromoCode | null {
  const row = getDb().prepare(`${PROMO_SELECT} WHERE p.id = ?`).get(id) as PromoRow | undefined;
  return row ? toPromo(row) : null;
}

/** Withdraw a code. Discounts already given stand. */
export function voidPromoCode(id: number): PromoEditResult {
  const promo = promoById(id);
  if (!promo) return { ok: false, error: "Code not found." };
  if (promo.status === "void") return { ok: false, error: "This code is already withdrawn." };
  getDb().prepare("UPDATE promo_codes SET status = 'void' WHERE id = ?").run(id);
  return { ok: true, promo: promoById(id)! };
}

export type PromoQuote =
  | { ok: true; promo: PromoCode; discount: number }
  | { ok: false; error: string };

/**
 * What a code would take off this particular booking, without claiming it.
 * The quote is advisory: the use count is only binding inside applyPromo().
 */
export function quotePromo(input: {
  venueId: number;
  code: string;
  sport: Sport;
  date: string;
  hours: number;
  price: number;
}): PromoQuote {
  const promo = getPromoCode(input.venueId, input.code);
  if (!promo) return { ok: false, error: "That code is not valid at this venue." };

  const blocked = promoBlockedReason(promo);
  if (blocked) return { ok: false, error: blocked };

  if (input.date < promo.validFrom)
    return { ok: false, error: `This code starts on ${promo.validFrom}.` };
  if (input.date > promo.validTo)
    return { ok: false, error: `This code ran out on ${promo.validTo}.` };
  if (promo.sport && promo.sport !== input.sport)
    return { ok: false, error: `This code only covers ${SPORT_LABELS[promo.sport]}.` };
  if (input.hours < promo.minHours)
    return {
      ok: false,
      error: `This code needs a booking of at least ${promo.minHours} hour${promo.minHours === 1 ? "" : "s"}.`,
    };

  const discount = promoDiscount(promo, input.price);
  if (discount <= 0) return { ok: false, error: "This code takes nothing off that price." };
  return { ok: true, promo, discount };
}

export type PromoApplyResult =
  | { ok: true; discount: number; newTotal: number; promo: PromoCode }
  | { ok: false; error: string };

/**
 * Claim a code against a booking: record the use and reduce what is owed.
 *
 * The use count is re-counted inside the transaction, so two customers
 * cannot both take the last use of a limited code. The booking's own
 * total_price is what changes, so everything downstream — paying from credit
 * or a pass, and the day's takings — sees the discounted figure without
 * knowing promo codes exist.
 */
export function applyPromo(bookingId: number, code: string): PromoApplyResult {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT b.*, ci.checked_in_at, ci.checked_out_at FROM bookings b LEFT JOIN check_ins ci ON ci.booking_id = b.id WHERE b.id = ?"
    )
    .get(bookingId) as BookingRow | undefined;
  if (!row) return { ok: false, error: "Booking not found." };
  const booking = toBooking(row);
  if (booking.status === "cancelled") return { ok: false, error: "This booking was cancelled." };
  if (booking.paymentStatus === "paid")
    return { ok: false, error: "This booking is already paid; a code cannot be added now." };

  const court = getCourt(booking.courtId);
  if (!court) return { ok: false, error: "Court not found." };

  const quote = quotePromo({
    venueId: court.venueId,
    code,
    sport: court.sport,
    date: booking.date,
    hours: booking.endHour - booking.startHour,
    price: booking.totalPrice,
  });
  if (!quote.ok) return quote;

  try {
    db.transaction(() => {
      const fresh = promoById(quote.promo.id)!;
      const blocked = promoBlockedReason(fresh);
      if (blocked) throw new Error(`BLOCKED:${blocked}`);
      // Re-derive against the live price, not the quoted one.
      const discount = promoDiscount(fresh, booking.totalPrice);
      if (discount <= 0) throw new Error("BLOCKED:This code takes nothing off that price.");
      db.prepare(
        "INSERT INTO promo_uses (promo_id, booking_id, discount) VALUES (?, ?, ?)"
      ).run(fresh.id, booking.id, discount);
      db.prepare("UPDATE bookings SET total_price = total_price - ? WHERE id = ?")
        .run(discount, booking.id);
    })();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("BLOCKED:"))
      return { ok: false, error: err.message.slice("BLOCKED:".length) };
    if (err instanceof Error && /UNIQUE constraint failed: promo_uses/.test(err.message))
      return { ok: false, error: "A code has already been used on this booking." };
    throw err;
  }

  const use = db
    .prepare("SELECT discount FROM promo_uses WHERE booking_id = ?")
    .get(booking.id) as { discount: number };
  return {
    ok: true,
    discount: use.discount,
    newTotal: booking.totalPrice - use.discount,
    promo: promoById(quote.promo.id)!,
  };
}

/**
 * Give a cancelled booking's use of a code back. The customer never had the
 * benefit, so a limited code should not be poorer for it.
 */
function releasePromoUse(bookingId: number): void {
  getDb().prepare("DELETE FROM promo_uses WHERE booking_id = ?").run(bookingId);
}

/** The code used on a booking, for showing it back to staff and customers. */
export function promoUseFor(bookingId: number): { code: string; discount: number } | null {
  const row = getDb()
    .prepare(`
      SELECT p.code AS code, u.discount AS discount
      FROM promo_uses u JOIN promo_codes p ON p.id = u.promo_id
      WHERE u.booking_id = ?
    `)
    .get(bookingId) as { code: string; discount: number } | undefined;
  return row ?? null;
}

/* ---------------- Multi-visit passes ---------------- */

interface PassRow {
  id: number;
  code: string;
  venue_id: number;
  venue_name: string;
  sport: Sport | null;
  name: string;
  entries: number;
  price: number;
  holder_name: string;
  holder_phone: string;
  expires_on: string;
  status: PassStatus;
  created_at: string;
  spent: number | null;
}

const PASS_SELECT = `
  SELECT p.id, p.code, p.venue_id, v.name AS venue_name, p.sport, p.name,
         p.entries, p.price, p.holder_name, p.holder_phone, p.expires_on,
         p.status, p.created_at,
         (SELECT COALESCE(SUM(delta), 0) FROM pass_entries e WHERE e.pass_id = p.id) AS spent
  FROM passes p JOIN venues v ON v.id = p.venue_id
`;

function toPass(r: PassRow): Pass {
  const remaining = r.entries + (r.spent ?? 0);
  const pass: Pass = {
    id: r.id,
    code: r.code,
    venueId: r.venue_id,
    venueName: r.venue_name,
    sport: r.sport,
    name: r.name,
    entries: r.entries,
    remaining,
    price: r.price,
    holderName: r.holder_name,
    holderPhone: r.holder_phone,
    expiresOn: r.expires_on,
    status: r.status,
    createdAt: r.created_at,
  };
  const reason = passBlockedReason(pass);
  return reason ? { ...pass, unusableReason: reason } : pass;
}

/** Why a pass cannot be spent today, or null when it can. */
function passBlockedReason(pass: Pick<Pass, "status" | "expiresOn" | "remaining">): string | null {
  if (pass.status === "void") return "This pass was cancelled.";
  // expires_on is inclusive, so a pass is good for the whole of that day.
  if (pass.expiresOn < todayISO()) return `This pass expired on ${pass.expiresOn}.`;
  if (pass.remaining <= 0) return "This pass has no entries left.";
  return null;
}

export function getPass(code: string): Pass | null {
  const row = getDb()
    .prepare(`${PASS_SELECT} WHERE UPPER(p.code) = UPPER(?)`)
    .get(code.trim()) as PassRow | undefined;
  return row ? toPass(row) : null;
}

/**
 * Every pass held by a phone number (and account, when signed in), newest
 * first. Spent and expired passes are kept so the holder can see the history.
 */
export function listPassesFor(input: { phone?: string; userId?: number }): Pass[] {
  const phone = input.phone?.trim() || null;
  const userId = input.userId ?? null;
  if (phone === null && userId === null) return [];
  const rows = getDb()
    .prepare(`
      ${PASS_SELECT}
      WHERE (? IS NOT NULL AND p.holder_phone = ?) OR (? IS NOT NULL AND p.user_id = ?)
      ORDER BY p.id DESC
    `)
    .all(phone, phone, userId, userId) as PassRow[];
  return rows.map(toPass);
}

/** Passes issued by one venue, newest first — the counter's list. */
export function listPassesForVenue(venueId: number, limit = 100): Pass[] {
  const rows = getDb()
    .prepare(`${PASS_SELECT} WHERE p.venue_id = ? ORDER BY p.id DESC LIMIT ?`)
    .all(venueId, Math.min(Math.max(limit, 1), 500)) as PassRow[];
  return rows.map(toPass);
}

export function listPassEntries(passId: number, limit = 50): PassEntry[] {
  const rows = getDb()
    .prepare(
      "SELECT id, delta, reason, booking_id, created_at FROM pass_entries WHERE pass_id = ? ORDER BY id DESC LIMIT ?"
    )
    .all(passId, Math.min(Math.max(limit, 1), 200)) as {
    id: number;
    delta: number;
    reason: string;
    booking_id: number | null;
    created_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    delta: r.delta,
    reason: r.reason,
    bookingId: r.booking_id,
    createdAt: r.created_at,
  }));
}

export type PassResult = { ok: true; pass: Pass } | { ok: false; error: string };

/** Sell a pass at the counter. */
export function issuePass(input: {
  venueId: number;
  sport?: Sport | null;
  name: string;
  entries: number;
  price: number;
  holderName: string;
  holderPhone: string;
  expiresOn: string;
  adminId: number;
  userId?: number;
}): PassResult {
  const db = getDb();
  const venue = db.prepare("SELECT id FROM venues WHERE id = ?").get(input.venueId);
  if (!venue) return { ok: false, error: "Venue not found." };

  const name = input.name.trim();
  const holderName = input.holderName.trim();
  const holderPhone = input.holderPhone.trim();
  if (name.length < 2) return { ok: false, error: "Give the pass a name." };
  if (holderName.length < 2 || holderPhone.length < 6)
    return { ok: false, error: "A holder name and phone number are required." };
  if (!Number.isInteger(input.entries) || input.entries < 1 || input.entries > MAX_PASS_ENTRIES)
    return { ok: false, error: `Entries must be 1–${MAX_PASS_ENTRIES}.` };
  if (!Number.isInteger(input.price) || input.price < 0)
    return { ok: false, error: "Price must be a whole number of ringgit." };
  if (!isValidDateString(input.expiresOn))
    return { ok: false, error: "Invalid expiry date." };
  if (input.expiresOn < todayISO())
    return { ok: false, error: "The expiry date has already passed." };
  if (input.expiresOn > addDays(todayISO(), MAX_PASS_MONTHS * 31))
    return { ok: false, error: `A pass may not run more than ${MAX_PASS_MONTHS} months.` };
  if (input.sport && !SPORTS.includes(input.sport))
    return { ok: false, error: "Unknown sport." };
  // A sport-locked pass is pointless if the venue has no such courts.
  if (input.sport) {
    const has = db
      .prepare("SELECT 1 FROM courts WHERE venue_id = ? AND sport = ? LIMIT 1")
      .get(input.venueId, input.sport);
    if (!has) return { ok: false, error: "That venue has no courts for that sport." };
  }

  const info = db
    .prepare(`
      INSERT INTO passes (code, venue_id, sport, name, entries, price, holder_name,
                          holder_phone, user_id, expires_on, admin_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      randomCode("PS-"),
      input.venueId,
      input.sport ?? null,
      name,
      input.entries,
      input.price,
      holderName,
      holderPhone,
      input.userId ?? null,
      input.expiresOn,
      input.adminId
    );
  return { ok: true, pass: passById(Number(info.lastInsertRowid))! };
}

export function getPassById(id: number): Pass | null {
  return passById(id);
}

function passById(id: number): Pass | null {
  const row = getDb().prepare(`${PASS_SELECT} WHERE p.id = ?`).get(id) as PassRow | undefined;
  return row ? toPass(row) : null;
}

/** Cancel a pass. Entries already spent stay spent; the rest become unusable. */
export function voidPass(passId: number): PassResult {
  const db = getDb();
  const pass = passById(passId);
  if (!pass) return { ok: false, error: "Pass not found." };
  if (pass.status === "void") return { ok: false, error: "This pass is already cancelled." };
  db.prepare("UPDATE passes SET status = 'void' WHERE id = ?").run(passId);
  return { ok: true, pass: passById(passId)! };
}

/**
 * Can this pass pay for this booking? Checks scope and standing but not the
 * entry count, which is only safe to read inside the paying transaction.
 */
function passScopeError(pass: Pass, booking: Booking): string | null {
  const court = getCourt(booking.courtId);
  if (!court) return "Court not found.";
  if (court.venueId !== pass.venueId) return "That pass is for a different venue.";
  if (pass.sport && court.sport !== pass.sport)
    return `That pass only covers ${SPORT_LABELS[pass.sport]}.`;
  return null;
}

export type PassPayResult =
  | { ok: true; pass: Pass; spent: number }
  | { ok: false; error: string };

/**
 * Settle a booking with a pass: one entry per booked hour, all or nothing.
 * The remaining count is re-read inside the transaction so two concurrent
 * bookings cannot spend the same entry.
 */
export function payBookingWithPass(bookingId: number, passCode: string): PassPayResult {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT b.*, ci.checked_in_at, ci.checked_out_at FROM bookings b LEFT JOIN check_ins ci ON ci.booking_id = b.id WHERE b.id = ?"
    )
    .get(bookingId) as BookingRow | undefined;
  if (!row) return { ok: false, error: "Booking not found." };
  const booking = toBooking(row);
  if (booking.status === "cancelled") return { ok: false, error: "This booking was cancelled." };
  if (booking.paymentStatus === "paid") return { ok: false, error: "This booking is already paid." };

  const pass = getPass(passCode);
  if (!pass) return { ok: false, error: "Pass not found." };
  const scope = passScopeError(pass, booking);
  if (scope) return { ok: false, error: scope };

  // A pass is the holder's to spend, so it has to be their booking.
  if (normalisePhone(pass.holderPhone) !== normalisePhone(booking.phone))
    return { ok: false, error: "That pass belongs to a different phone number." };

  const hours = booking.endHour - booking.startHour;

  try {
    db.transaction(() => {
      const fresh = passById(pass.id)!;
      const blocked = passBlockedReason(fresh);
      if (blocked) throw new Error(`BLOCKED:${blocked}`);
      if (fresh.remaining < hours)
        throw new Error(
          `BLOCKED:This pass has ${fresh.remaining} ${fresh.remaining === 1 ? "entry" : "entries"} left, and this booking needs ${hours}.`
        );
      db.prepare(
        "INSERT INTO pass_entries (pass_id, delta, reason, booking_id) VALUES (?, ?, ?, ?)"
      ).run(pass.id, -hours, `Booking ${booking.code}`, booking.id);
      db.prepare(
        "UPDATE bookings SET payment_status = 'paid', paid_at = datetime('now') WHERE id = ?"
      ).run(booking.id);
    })();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("BLOCKED:"))
      return { ok: false, error: err.message.slice("BLOCKED:".length) };
    throw err;
  }

  return { ok: true, pass: passById(pass.id)!, spent: hours };
}

/**
 * Phone numbers are typed loosely, so compare only the digits — and treat the
 * international and national forms of a Malaysian number as the same one,
 * since "+60 12-345 6789" and "012-345 6789" are the same phone. No national
 * prefix starts 60, so stripping it is unambiguous.
 */
function normalisePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.startsWith("60") && digits.length >= 10 ? `0${digits.slice(2)}` : digits;
}

/**
 * Give a cancelled booking's entries back. Refunding twice is refused, so a
 * double cancellation cannot mint entries. An expired pass is still credited —
 * the ledger stays honest, even if the entries can no longer be spent.
 */
export function refundBookingToPass(bookingId: number): PassPayResult {
  const db = getDb();
  const charge = db
    .prepare(
      "SELECT pass_id, delta FROM pass_entries WHERE booking_id = ? AND delta < 0 ORDER BY id LIMIT 1"
    )
    .get(bookingId) as { pass_id: number; delta: number } | undefined;
  if (!charge) return { ok: false, error: "This booking was not paid with a pass." };

  const refunded = db
    .prepare("SELECT id FROM pass_entries WHERE booking_id = ? AND delta > 0")
    .get(bookingId);
  if (refunded) return { ok: false, error: "This booking has already been refunded." };

  const code = (db.prepare("SELECT code FROM bookings WHERE id = ?").get(bookingId) as
    | { code: string }
    | undefined)?.code;
  db.prepare("INSERT INTO pass_entries (pass_id, delta, reason, booking_id) VALUES (?, ?, ?, ?)")
    .run(charge.pass_id, -charge.delta, `Refund for ${code ?? "booking"}`, bookingId);

  return { ok: true, pass: passById(charge.pass_id)!, spent: charge.delta };
}

/**
 * The passes a phone number could spend on a court today — what the booking
 * form offers. Only passes with entries left and standing to spend them.
 */
export function usablePassesFor(phone: string, courtId: number): Pass[] {
  const court = getCourt(courtId);
  if (!court) return [];
  const digits = normalisePhone(phone);
  if (digits.length < 6) return [];
  return listPassesFor({ phone: phone.trim() }).filter(
    (p) =>
      !p.unusableReason &&
      p.venueId === court.venueId &&
      (p.sport === null || p.sport === court.sport) &&
      normalisePhone(p.holderPhone) === digits
  );
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
  const blocked = blockedPlacesFor(courtId, date, hours);
  for (const hour of hours) {
    if (classes.has(`${courtId}:${hour}`)) return false;
    const taken = db
      .prepare(
        "SELECT COUNT(*) AS n FROM booking_slots WHERE court_id = ? AND date = ? AND hour = ?"
      )
      .get(courtId, date, hour) as { n: number };
    if (taken.n + (blocked.get(hour) ?? 0) >= court.capacity) return false;
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
