import { randomBytes } from "crypto";
import { getDb, isUniqueViolation, withTransaction } from "./db";
import { inSameBusiness, SAME_CREDIT, sameBusiness } from "./branches";
import { OPEN_TO_CUSTOMERS } from "./listing";
import { distanceM, inMalaysia, readPoint } from "./geo";
import { creditScope } from "./mode";
import { errorText, translator } from "./i18n";
import type { ErrorCode } from "./i18n";
import {
  Booking,
  busyness,
  Refusal,
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
  AccessResult,
  ACCESS_CODE_STALE_DAYS,
  Induction,
  isUnstaffedHour,
  NEVER_UNMANNED,
  MAX_ACCESS_CODE,
  MIN_ACCESS_CODE,
  MAX_DEPOSIT,
  MAX_HIRE_NOTE,
  HIRE_CONDITIONS,
  HireCondition,
  HireRecord,
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
  WalletBalance,
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
  deposit: number;
  unmanned: number;
  access_code: string | null;
  access_code_changed_at: string | null;
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
  staffed_from: number | null;
  staffed_to: number | null;
  emergency_phone: string | null;
  emergency_info: string | null;
  published_at: string | null;
  suspended_at: string | null;
  suspended_by: "payment" | "owner" | null;
  suspended_reason: string | null;
  lat: number | null;
  lng: number | null;
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
    staffedFrom: r.staffed_from,
    staffedTo: r.staffed_to,
    emergencyPhone: r.emergency_phone,
    emergencyInfo: r.emergency_info,
    publishedAt: r.published_at,
    suspendedAt: r.suspended_at,
    suspendedBy: r.suspended_by,
    suspendedReason: r.suspended_reason,
    lat: r.lat,
    lng: r.lng,
  };
}

/** A venue's trading hours, falling back to the defaults if it has vanished. */
export async function venueHours(venueId: number): Promise<{ openHour: number; closeHour: number }> {
  const row = await getDb()
    .prepare("SELECT open_hour, close_hour FROM venues WHERE id = ?")
    .get(venueId) as { open_hour: number; close_hour: number } | undefined;
  return {
    openHour: row?.open_hour ?? DEFAULT_OPEN_HOUR,
    closeHour: row?.close_hour ?? DEFAULT_CLOSE_HOUR,
  };
}

/** The trading hours of the venue a court belongs to. */
export async function courtVenueHours(courtId: number): Promise<{ openHour: number; closeHour: number }> {
  const row = await getDb()
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
export async function getVenueClosure(venueId: number, date: string): Promise<VenueClosure | null> {
  const row = await getDb()
    .prepare("SELECT date, reason FROM venue_closures WHERE venue_id = ? AND date = ?")
    .get(venueId, date) as { date: string; reason: string | null } | undefined;
  return row ? { date: row.date, reason: row.reason } : null;
}

/** Every closure a venue has from `from` onwards, soonest first. */
export async function listVenueClosures(venueId: number, from?: string): Promise<VenueClosure[]> {
  const rows = await getDb()
    .prepare(`
      SELECT date, reason FROM venue_closures
      WHERE venue_id = ? AND (?::text IS NULL OR date >= ?)
      ORDER BY date
    `)
    .all(venueId, from ?? null, from ?? null) as { date: string; reason: string | null }[];
  return rows.map((r) => ({ date: r.date, reason: r.reason }));
}

/**
 * Refuse something, by name.
 *
 * The English sentence comes out of the same dictionary the Bahasa Malaysia one
 * does, so the two cannot drift apart and the store does not carry a second
 * copy of its own wording. `code` travels to the browser, which says it in
 * whichever language the reader is actually in.
 */
function refuse(code: ErrorCode, vars?: Record<string, string | number>): Refusal {
  const refusal: Refusal = { ok: false, error: errorText(ENGLISH, code, vars), code };
  // Left off entirely when there are none, so the shape on the wire stays the
  // shape it was for every refusal that quotes nothing.
  if (vars) refusal.vars = vars;
  return refusal;
}

/** The store speaks English; the page translates. */
const ENGLISH = translator("en");

export type ClosureResult = { ok: true; closure: VenueClosure } | Refusal;

/** Shut a venue for a whole day. Existing bookings are left for staff to handle. */
export async function closeVenueDay(venueId: number, date: string, reason?: string): Promise<ClosureResult> {
  return withTransaction(async () => {
    if (!isValidDateString(date)) return { ok: false, error: "Invalid date." };
    const db = getDb();
    const venue = await db.prepare("SELECT id FROM venues WHERE id = ?").get(venueId);
    if (!venue) return refuse("VENUE_NOT_FOUND");
    const trimmed = reason?.trim();
    await db.prepare(
      `INSERT INTO venue_closures (venue_id, date, reason) VALUES (?, ?, ?)
       ON CONFLICT (venue_id, date) DO UPDATE SET reason = excluded.reason`
    ).run(venueId, date, trimmed && trimmed.length > 0 ? trimmed : null);
    return { ok: true, closure: { date, reason: trimmed && trimmed.length > 0 ? trimmed : null } };
  });
}

/** Re-open a closed day. */
export async function reopenVenueDay(venueId: number, date: string): Promise<{ ok: boolean }> {
  const info = await getDb()
    .prepare("DELETE FROM venue_closures WHERE venue_id = ? AND date = ?")
    .run(venueId, date);
  return { ok: info.changes > 0 };
}

/** Dates a venue is shut inside a range, as a set for bulk checks. */
async function closedDatesIn(venueIds: number[], from: string, to: string): Promise<Set<string>> {
  if (venueIds.length === 0) return new Set();
  const list = venueIds.map(() => "?").join(",");
  const rows = await getDb()
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
  paid_via?: string | null;
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
    deposit: r.deposit,
    unmanned: r.unmanned === 1,
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
    paidOnline: r.paid_via === "online",
    noShow: r.no_show === 1,
    checkedInAt: r.checked_in_at ?? null,
    checkedOutAt: r.checked_out_at ?? null,
    checkInToken: r.check_in_token,
    classId: r.class_id,
  };
}

export async function listVenues(): Promise<(Venue & { courts: Court[] })[]> {
  const db = getDb();
  const venues = (await db.prepare("SELECT * FROM venues ORDER BY id").all() as VenueRow[]).map(toVenue);
  const courts = (await db.prepare("SELECT * FROM courts ORDER BY id").all() as CourtRow[]).map(toCourt);
  return venues.map((v) => ({ ...v, courts: courts.filter((c) => c.venueId === v.id) }));
}

/** These venues and their courts, in id order: a business's branches. */
export async function listVenuesByIds(ids: number[]): Promise<(Venue & { courts: Court[] })[]> {
  if (ids.length === 0) return [];
  const db = getDb();
  const list = ids.map(() => "?").join(",");
  const venues = ((await db.prepare(`SELECT * FROM venues WHERE id IN (${list}) ORDER BY id`).all(...ids)) as VenueRow[]).map(
    toVenue
  );
  const courts = (
    (await db.prepare(`SELECT * FROM courts WHERE venue_id IN (${list}) ORDER BY id`).all(...ids)) as CourtRow[]
  ).map(toCourt);
  return venues.map((v) => ({ ...v, courts: courts.filter((c) => c.venueId === v.id) }));
}

export async function getVenue(id: number): Promise<(Venue & { courts: Court[] }) | null> {
  const db = getDb();
  const row = await db.prepare("SELECT * FROM venues WHERE id = ?").get(id) as VenueRow | undefined;
  if (!row) return null;
  const venue = toVenue(row);
  const courts = (
    await db.prepare("SELECT * FROM courts WHERE venue_id = ? ORDER BY id").all(id) as CourtRow[]
  ).map(toCourt);
  return { ...venue, courts };
}

export async function getCourt(id: number): Promise<Court | null> {
  const db = getDb();
  const row = await db.prepare("SELECT * FROM courts WHERE id = ?").get(id) as CourtRow | undefined;
  return row ? toCourt(row) : null;
}

/**
 * Courts at a venue that could take this whole booking, cheapest first.
 * Price is peak-aware, so the order can differ between a morning and an
 * evening slot on the same courts.
 */
/** Errors that mean "that court went", rather than something structural. */
const TAKEN_ERROR = /just booked|filling up very quickly|filled up|already taken/i;

export async function courtsForAnyBooking(input: {
  venueId: number;
  sport: Sport;
  date: string;
  hours: number[];
}): Promise<Court[]> {
  const { venueId, sport, date } = input;
  const hours = [...new Set(input.hours)].sort((a, b) => a - b);
  if (hours.length === 0) return [];

  const db = getDb();
  const courts = (
    await db
      .prepare("SELECT * FROM courts WHERE venue_id = ? AND sport = ? ORDER BY id")
      .all(venueId, sport) as CourtRow[]
  ).map(toCourt);
  if (courts.length === 0) return [];

  const classHours = await classHoursOn(date, venueId);
  const taken = await countTakenPlaces(date, venueId);
  const blocked = await blockedPlacesOn(date, venueId);

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
export async function createBookingOnAnyCourt(input: {
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
}): Promise<CreateSeriesResult> {
  const { venueId, sport, date, hours, ...rest } = input;

  const venue = await getDb().prepare("SELECT id FROM venues WHERE id = ?").get(venueId);
  if (!venue) return refuse("VENUE_NOT_FOUND");
  if (!SPORTS.includes(sport)) return refuse("UNKNOWN_SPORT");

  const candidates = await courtsForAnyBooking({ venueId, sport, date, hours });
  if (candidates.length === 0) {
    // Fall through to the single-court path on any court of that sport, so the
    // customer gets the real reason (closed day, outside hours, past slot)
    // rather than a flat "nothing free".
    const anyCourt = (
      await getDb()
        .prepare("SELECT * FROM courts WHERE venue_id = ? AND sport = ? ORDER BY id LIMIT 1")
        .all(venueId, sport) as CourtRow[]
    ).map(toCourt)[0];
    if (!anyCourt)
      return refuse("NO_SPORT_AT_VENUE", { sport: SPORT_LABELS[sport] });
    const probe = await createBookingSeries({ ...rest, courtId: anyCourt.id, date, hours, weeks: input.weeks ?? 1 });
    if (probe.ok) return probe; // it came free between the two reads
    // A "someone took it" error from the probe is about that one court, and
    // the customer never chose it. Say what is actually true of all of them.
    if (TAKEN_ERROR.test(probe.error))
      return refuse("NO_COURT_FREE");
    return probe;
  }

  let lastError = "No court is free for that whole time. Please pick another time.";
  for (const court of candidates) {
    const result = await createBookingSeries({
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
 * ` AND <column> IN (this venue's courts)`, or nothing for every venue.
 *
 * Spelled out rather than written as `(? IS NULL OR ...)`, because the
 * planner cannot use an index through that OR: asking for one venue read every
 * venue's rows for the date, so the venue page slowed down with each venue
 * added to the platform.
 */
/** ` AND <column> IN (these courts)`, or nothing when no list is given. */
function onlyCourts(column: string, courtIds?: number[]): { sql: string; params: number[] } {
  if (courtIds === undefined) return { sql: "", params: [] };
  return { sql: ` AND ${column} IN (${courtIds.map(() => "?").join(",") || "NULL"})`, params: courtIds };
}

function venueCourts(column: string, venueId?: number | number[] | null): { sql: string; params: number[] } {
  if (venueId == null) return { sql: "", params: [] };
  // Several venues: a business's branches.
  if (Array.isArray(venueId))
    return venueId.length === 0
      ? { sql: " AND FALSE", params: [] }
      : {
          sql: ` AND ${column} IN (SELECT id FROM courts WHERE venue_id IN (${venueId.map(() => "?").join(",")}))`,
          params: venueId,
        };
  return { sql: ` AND ${column} IN (SELECT id FROM courts WHERE venue_id = ?)`, params: [venueId] };
}

/**
 * `courtId:hour` -> how many places are out of service on a date.
 *
 * A NULL `places` means the whole resource, so it resolves to that court's
 * capacity here. That keeps a capacity-1 court behaving exactly as before: one
 * place blocked out of one is the court closed.
 */
async function blockedPlacesOn(
  date: string,
  venueId?: number,
  courtIds?: number[]
): Promise<Map<string, number>> {
  const venue = venueCourts("b.court_id", venueId);
  const courts = onlyCourts("b.court_id", courtIds);
  const rows = await getDb()
    .prepare(`
      SELECT b.court_id AS court_id, b.hour AS hour,
             COALESCE(b.places, c.capacity) AS places
      FROM blocks_between(?, ?) b JOIN courts c ON c.id = b.court_id
      WHERE true${venue.sql}${courts.sql}
    `)
    .all(date, date, ...venue.params, ...courts.params) as {
    court_id: number;
    hour: number;
    places: number;
  }[];
  return new Map(rows.map((r) => [`${r.court_id}:${r.hour}`, r.places]));
}

/** Places out of service on one court-hour. */
async function blockedPlacesFor(courtId: number, date: string, hours: number[]): Promise<Map<number, number>> {
  if (hours.length === 0) return new Map();
  const list = hours.map(() => "?").join(",");
  const rows = await getDb()
    .prepare(`
      SELECT b.hour AS hour, COALESCE(b.places, c.capacity) AS places
      FROM blocks_between(?, ?) b JOIN courts c ON c.id = b.court_id
      WHERE b.court_id = ? AND b.hour IN (${list})
    `)
    .all(date, date, courtId, ...hours) as { hour: number; places: number }[];
  return new Map(rows.map((r) => [r.hour, r.places]));
}

/** Availability grid for every court of a venue (optionally one sport) on a date. */
export async function getAvailability(
  venueId: number,
  date: string,
  sport?: Sport,
  /** Price the grid at member rates, for a caller known to be a member. */
  member = false
): Promise<CourtAvailability[]> {
  const db = getDb();
  let courts = (
    await db.prepare("SELECT * FROM courts WHERE venue_id = ? ORDER BY id").all(venueId) as CourtRow[]
  ).map(toCourt);
  if (sport) courts = courts.filter((c) => c.sport === sport);

  const takenCounts = await countTakenPlaces(date, venueId);

  const blockedPlaces = await blockedPlacesOn(date, venueId);
  const classHours = await classHoursOn(date, venueId);
  const { openHour, closeHour } = await venueHours(venueId);
  // A closed day reads like every hour is blocked, so nothing can be picked.
  const closed = await getVenueClosure(venueId, date) !== null;

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
async function classHoursOn(
  date: string,
  venueId?: number,
  courtIds?: number[]
): Promise<Map<string, { id: number; name: string }>> {
  const venue = venueCourts("court_id", venueId);
  const courts = onlyCourts("court_id", courtIds);
  const rows = await getDb()
    .prepare(`
      SELECT id, court_id, name, start_hour, end_hour FROM classes
      WHERE date = ? AND status = 'scheduled'${venue.sql}${courts.sql}
    `)
    .all(date, ...venue.params, ...courts.params) as {
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
async function countTakenPlaces(date: string, venueId?: number): Promise<Map<string, number>> {
  const venue = venueCourts("court_id", venueId);
  const rows = await getDb()
    .prepare(`
      SELECT court_id, hour, COUNT(*) AS n FROM booking_slots
      WHERE date = ?${venue.sql}
      GROUP BY court_id, hour
    `)
    .all(date, ...venue.params) as {
    court_id: number;
    hour: number;
    n: number;
  }[];
  return new Map(rows.map((r) => [`${r.court_id}:${r.hour}`, r.n]));
}

export interface SearchResult {
  venue: Venue;
  /** How far away, when the search was near somewhere. */
  distanceKm?: number;
  /** The cheapest court free at this venue for this time. */
  court: Court;
  startHour: number;
  endHour: number;
  totalPrice: number;
  /** How many more of the venue's courts are free for the same time. */
  alsoFree: number;
  /** Whether those others cost more than this one. */
  pricesVary: boolean;
}

export interface SearchInput {
  sport: Sport;
  date: string;
  fromHour?: number;
  toHour?: number;
  duration?: number;
  area?: string;
  limit?: number;
  /** Only these venues — a storefront's. Undefined for every venue. */
  venueIds?: number[];
  /** Only venues within this distance of here, nearest first. */
  near?: Near;
}

/** Somewhere to search around, and how far out. */
export interface Near {
  lat: number;
  lng: number;
  km: number;
}
export const NEAR_DEFAULT_KM = 10;
export const NEAR_MAX_KM = 50;

/**
 * `near=3.1390,101.6869` and `km=10` from a query string, or null. A point
 * outside Malaysia, or not a point at all, is no point.
 */
export function readNear(near: string | null | undefined, km?: string | null): Near | null {
  if (!near) return null;
  const [lat, lng] = near.split(",").map((x) => Number(x.trim()));
  const point = readPoint(lat, lng);
  if (!point || !inMalaysia(point)) return null;
  const radius = Number(km);
  return {
    ...point,
    km: Number.isFinite(radius) && radius > 0 ? Math.min(radius, NEAR_MAX_KM) : NEAR_DEFAULT_KM,
  };
}

/**
 * Kilometres from a point to venue `v`, in SQL, along the ground. With its
 * parameters, which go wherever the expression does.
 */
function distanceKmSql(near: Near): { sql: string; params: number[] } {
  return {
    sql: `(6371 * acos(LEAST(1.0, GREATEST(-1.0,
            cos(radians(?)) * cos(radians(v.lat)) * cos(radians(v.lng) - radians(?))
            + sin(radians(?)) * sin(radians(v.lat))))))`,
    params: [near.lat, near.lng, near.lat],
  };
}

/** A box around the circle, which an index on the columns can answer, before the exact distance. */
function nearBox(near: Near): { sql: string; params: number[] } {
  const dLat = near.km / 111;
  const dLng = near.km / (111 * Math.max(Math.cos((near.lat * Math.PI) / 180), 0.01));
  return {
    sql: "v.lat BETWEEN ? AND ? AND v.lng BETWEEN ? AND ?",
    params: [near.lat - dLat, near.lat + dLat, near.lng - dLng, near.lng + dLng],
  };
}

/** Distinct venue areas, for the search filter. */
/** One page of the venue list, and how many venues there are in all. */
export interface VenuePage {
  venues: (Venue & { courts: Court[]; distanceKm?: number })[];
  total: number;
  page: number;
  pageSize: number;
}

export const VENUE_PAGE_SIZE = 24;
const MAX_VENUE_PAGE_SIZE = 100;

/** `WHERE` for the public venue list, shared by the page and its counts. */
function venueFilter(opts: { area?: string; sport?: Sport; venueIds?: number[]; near?: Near }): {
  sql: string;
  params: (string | number)[];
} {
  // Only venues customers may reach (lib/listing.ts), and of those not one
  // with nothing to book yet, rather than "0 courts" to somebody looking.
  const clauses: string[] = [OPEN_TO_CUSTOMERS, "EXISTS (SELECT 1 FROM courts c WHERE c.venue_id = v.id)"];
  const params: (string | number)[] = [];
  if (opts.venueIds) {
    clauses.push(`v.id IN (${opts.venueIds.map(() => "?").join(",") || "NULL"})`);
    params.push(...opts.venueIds);
  }
  if (opts.area) {
    clauses.push("v.area = ?");
    params.push(opts.area);
  }
  if (opts.sport) {
    clauses.push("EXISTS (SELECT 1 FROM courts c WHERE c.venue_id = v.id AND c.sport = ?)");
    params.push(opts.sport);
  }
  if (opts.near) {
    const box = nearBox(opts.near);
    const distance = distanceKmSql(opts.near);
    clauses.push(box.sql, `${distance.sql} <= ?`);
    params.push(...box.params, ...distance.params, opts.near.km);
  }
  return { sql: `WHERE ${clauses.join(" AND ")}`, params };
}

/**
 * The venues a visitor is browsing, a page at a time.
 *
 * `listVenues` hands back every venue and every court, which is right for a
 * business with a handful of branches and wrong for a marketplace with
 * thousands: measured with two thousand venues, the home page was 4 MB of
 * HTML and stopped answering under load. This reads one page of venues, and
 * only their courts.
 */
export async function listVenuePage(
  opts: { area?: string; sport?: Sport; venueIds?: number[]; near?: Near; page?: number; pageSize?: number } = {}
): Promise<VenuePage> {
  const db = getDb();
  const pageSize = Math.min(Math.max(Math.trunc(opts.pageSize ?? VENUE_PAGE_SIZE), 1), MAX_VENUE_PAGE_SIZE);
  const page = Math.max(Math.trunc(opts.page ?? 1), 1);
  const filter = venueFilter(opts);
  const { total } = (await db
    .prepare(`SELECT COUNT(*) AS total FROM venues v ${filter.sql}`)
    .get(...filter.params)) as { total: number };
  // Near somewhere: nearest first, which nobody can game but by moving.
  const distance = opts.near ? distanceKmSql(opts.near) : null;
  const rows = (
    distance
      ? await db
          .prepare(
            `SELECT v.*, ${distance.sql} AS distance_km FROM venues v ${filter.sql}
              ORDER BY distance_km, v.id LIMIT ? OFFSET ?`
          )
          .all(...distance.params, ...filter.params, pageSize, (page - 1) * pageSize)
      : await db
          // A fair order, not an alphabetical one: by name, "AAA Badminton" would
          // sit at the top for good, and a venue could rename itself to get there.
          // Shuffled by the day, so every venue takes its turn near the top, and
          // the same all day, so paging through never shows one venue twice.
          .prepare(`SELECT v.* FROM venues v ${filter.sql} ORDER BY md5(v.id || ':' || ?), v.id LIMIT ? OFFSET ?`)
          .all(...filter.params, todayISO(), pageSize, (page - 1) * pageSize)
  ) as (VenueRow & { distance_km?: number })[];
  if (rows.length === 0) return { venues: [], total, page, pageSize };
  const courts = (
    (await db
      .prepare(`SELECT * FROM courts WHERE venue_id IN (${rows.map(() => "?").join(",")}) ORDER BY id`)
      .all(...rows.map((r) => r.id))) as CourtRow[]
  ).map(toCourt);
  return {
    venues: rows.map((r) => ({
      ...toVenue(r),
      courts: courts.filter((c) => c.venueId === r.id),
      ...(r.distance_km !== undefined ? { distanceKm: Math.round(Number(r.distance_km) * 10) / 10 } : {}),
    })),
    total,
    page,
    pageSize,
  };
}

/** Each area with how many venues are in it, for browsing by area. */
export async function listAreaCounts(
  opts: { sport?: Sport; venueIds?: number[] } = {}
): Promise<{ area: string; venues: number }[]> {
  const filter = venueFilter(opts);
  return (await getDb()
    .prepare(`SELECT v.area, COUNT(*) AS venues FROM venues v ${filter.sql} GROUP BY v.area ORDER BY v.area`)
    .all(...filter.params)) as { area: string; venues: number }[];
}

/** The sports played at these venues, or anywhere — anywhere customers can reach. */
export async function sportsOfferedAt(venueIds?: number[]): Promise<Sport[]> {
  const from = `SELECT DISTINCT c.sport FROM courts c JOIN venues v ON v.id = c.venue_id WHERE ${OPEN_TO_CUSTOMERS}`;
  const rows = (
    venueIds === undefined
      ? await getDb().prepare(from).all()
      : await getDb()
          .prepare(`${from} AND c.venue_id IN (${venueIds.map(() => "?").join(",") || "NULL"})`)
          .all(...venueIds)
  ) as { sport: Sport }[];
  const offered = new Set(rows.map((r) => r.sport));
  return SPORTS.filter((s) => offered.has(s));
}

/**
 * How many courts a search would have to look at.
 *
 * Every free hour on every court is worked out to find the few shown, so a
 * search's cost is its number of courts. Narrowed to an area it is a few
 * hundred; across a national marketplace it is ten thousand or more, and
 * measured at that size one search took eight seconds. `SEARCH_COURT_LIMIT`
 * is where the search page asks for an area first.
 */
export const SEARCH_COURT_LIMIT = 400;

export async function countSearchCourts(input: {
  sport: Sport;
  area?: string;
  venueIds?: number[];
  near?: Near;
}): Promise<number> {
  const filter = venueFilter({ area: input.area, venueIds: input.venueIds, near: input.near });
  const { n } = (await getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM courts c JOIN venues v ON v.id = c.venue_id ${filter.sql} AND c.sport = ?`
    )
    .get(...filter.params, input.sport)) as { n: number };
  return n;
}

/** The areas with something to book, for the search page's area list. */
export async function listAreas(venueIds?: number[]): Promise<string[]> {
  return (await listAreaCounts({ venueIds })).map((a) => a.area);
}

/**
 * Find every court across all venues with `duration` consecutive free hours
 * starting inside [fromHour, toHour] on `date`. One result per viable start
 * time, cheapest-first within the same start hour.
 */
export async function searchAvailability(input: SearchInput): Promise<SearchResult[]> {
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
           v.open_hour AS v_open, v.close_hour AS v_close,
           v.staffed_from AS v_staffed_from, v.staffed_to AS v_staffed_to,
           v.emergency_phone AS v_emergency_phone, v.emergency_info AS v_emergency_info,
           v.published_at AS v_published_at, v.lat AS v_lat, v.lng AS v_lng
    FROM courts c JOIN venues v ON v.id = c.venue_id
    WHERE c.sport = ? AND ${OPEN_TO_CUSTOMERS}
  `;
  if (input.area) {
    sql += " AND v.area = ?";
    params.push(input.area);
  }
  if (input.venueIds) {
    if (input.venueIds.length === 0) return [];
    sql += ` AND v.id IN (${input.venueIds.map(() => "?").join(",")})`;
    params.push(...input.venueIds);
  }
  if (input.near) {
    const box = nearBox(input.near);
    sql += ` AND ${box.sql}`;
    params.push(...box.params);
  }
  sql += " ORDER BY v.id, c.id";

  const rows = await db.prepare(sql).all(...params) as (CourtRow & {
    v_id: number;
    v_name: string;
    v_area: string;
    v_address: string;
    v_phone: string;
    v_cutoff: number;
    v_open: number;
    v_close: number;
    v_staffed_from: number | null;
    v_staffed_to: number | null;
    v_emergency_phone: string | null;
    v_emergency_info: string | null;
    v_published_at: string | null;
    v_lat: number | null;
    v_lng: number | null;
  })[];
  if (rows.length === 0) return [];

  // A venue shut for the day has nothing to offer, whatever its courts say.
  const closedVenues = await closedDatesIn(
    [...new Set(rows.map((r) => r.v_id))],
    input.date,
    input.date
  );

  const courtIds = rows.map((r) => r.id);
  const idList = courtIds.map(() => "?").join(",");
  const taken = await db
    .prepare(`
      SELECT court_id, hour, COUNT(*) AS n FROM booking_slots
      WHERE date = ? AND court_id IN (${idList}) GROUP BY court_id, hour
    `)
    .all(input.date, ...courtIds) as { court_id: number; hour: number; n: number }[];
  const takenCounts = new Map(taken.map((t) => [`${t.court_id}:${t.hour}`, t.n]));
  // Only for the courts being searched, not every court in the country.
  const blockedPlaces = await blockedPlacesOn(input.date, undefined, courtIds);
  const classHours = await classHoursOn(input.date, undefined, courtIds);

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
      staffedFrom: row.v_staffed_from,
      staffedTo: row.v_staffed_to,
      emergencyPhone: row.v_emergency_phone,
      emergencyInfo: row.v_emergency_info,
      publishedAt: row.v_published_at,
      // Search only finds venues open to customers.
      suspendedAt: null,
      suspendedBy: null,
      suspendedReason: null,
      lat: row.v_lat,
      lng: row.v_lng,
    };
    // Inside the box, but is it inside the circle?
    let distanceKm: number | undefined;
    if (input.near) {
      distanceKm = Math.round(distanceM(input.near, { lat: row.v_lat!, lng: row.v_lng! }) / 100) / 10;
      if (distanceKm > input.near.km) continue;
    }
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
        alsoFree: 0,
        pricesVary: false,
        ...(distanceKm !== undefined ? { distanceKm } : {}),
      });
    }
  }

  results.sort(
    (a, b) =>
      a.startHour - b.startHour ||
      // Near somewhere, the nearest first at each time; otherwise the cheapest.
      (a.distanceKm ?? 0) - (b.distanceKm ?? 0) ||
      a.totalPrice - b.totalPrice ||
      a.venue.name.localeCompare(b.venue.name) ||
      a.court.name.localeCompare(b.court.name)
  );

  // One result per venue per start time — its cheapest court — before the
  // limit, not after. Otherwise a venue with a hundred courts fills every
  // place in the results and the venues around it disappear from the search:
  // adding courts would be a way to the top. The others are counted instead.
  const shown = new Map<string, SearchResult>();
  const fair: SearchResult[] = [];
  for (const r of results) {
    const key = `${r.venue.id}:${r.startHour}`;
    const first = shown.get(key);
    if (first) {
      first.alsoFree++;
      if (r.totalPrice !== first.totalPrice) first.pricesVary = true;
      continue;
    }
    shown.set(key, r);
    fair.push(r);
  }
  return fair.slice(0, limit);
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
  | Refusal;

/** Bounded retries when two requests race for the same place. */
const MAX_SEAT_RETRIES = 5;

export interface SeriesSkip {
  date: string;
  reason: string;
}

export type CreateSeriesResult =
  | { ok: true; bookings: Booking[]; skipped: SeriesSkip[]; seriesCode: string | null }
  | Refusal;

export async function createBooking(input: {
  courtId: number;
  date: string;
  hours: number[];
  name: string;
  phone: string;
  email?: string;
  userId?: number;
}): Promise<CreateBookingResult> {
  const result = await createBookingSeries({ ...input, weeks: 1 });
  if (!result.ok) return result;
  return { ok: true, booking: result.bookings[0] };
}

/**
 * Book the same court and hours weekly for `weeks` weeks. With
 * `skipConflicts`, weeks that clash with existing bookings or blocks are
 * skipped and reported; otherwise any clash fails the whole series.
 */
export async function createBookingSeries(input: {
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
}, attempt = 0): Promise<CreateSeriesResult> {
  const { courtId, date, weeks, name, phone, email, userId } = input;
  const hours = [...new Set(input.hours)].sort((a, b) => a - b);
  const skipConflicts = (input.skipConflicts ?? false) && weeks > 1;

  const court = await getCourt(courtId);
  if (!court) return refuse("COURT_NOT_FOUND");
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > MAX_RECUR_WEEKS)
    return refuse("WEEKS_RANGE", { max: MAX_RECUR_WEEKS });
  if (!isBookableDate(date))
    return refuse("DATE_OUT_OF_WINDOW_FIRST");
  if (hours.length === 0) return refuse("NO_HOURS");
  if (hours.length > MAX_HOURS_PER_BOOKING)
    return refuse("MAX_HOURS", { max: MAX_HOURS_PER_BOOKING });
  for (let i = 1; i < hours.length; i++) {
    if (hours[i] !== hours[i - 1] + 1)
      return refuse("HOURS_NOT_CONSECUTIVE");
  }
  const { openHour, closeHour } = await courtVenueHours(courtId);
  if (hours[0] < openHour || hours[hours.length - 1] >= closeHour)
    return refuse("HOURS_OUTSIDE_OPENING");
  if (isPastSlot(date, hours[0]))
    return refuse("SLOT_PAST");
  if (await getVenueClosure(court.venueId, date))
    return refuse("VENUE_CLOSED");

  const db = getDb();
  const placeholders = hours.map(() => "?").join(",");
  const seatsTaken = db.prepare(
    "SELECT seat FROM booking_slots WHERE court_id = ? AND date = ? AND hour = ?"
  );
  /**
   * Does a block leave room for one more? A partial block shrinks the
   * resource, so it only closes the hour once the places left run out.
   */
  const blockedOut = async (weekDate: string): Promise<boolean> => {
    const blocked = await blockedPlacesFor(courtId, weekDate, hours);
    if (blocked.size === 0) return false;
    const takenHere = db.prepare(
      "SELECT COUNT(*) AS n FROM booking_slots WHERE court_id = ? AND date = ? AND hour = ?"
    );
    for (const hour of hours) {
      const out = blocked.get(hour) ?? 0;
      if (out === 0) continue;
      const taken = (await takenHere.get(courtId, weekDate, hour) as { n: number }).n;
      if (taken + out >= court.capacity) return true;
    }
    return false;
  };
  const insertBooking = db.prepare(`
    INSERT INTO bookings (code, court_id, date, start_hour, end_hour, name, phone, email, total_price, user_id, series_code, check_in_token, class_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSlot = db.prepare(
    "INSERT INTO booking_slots (booking_id, court_id, date, hour, seat) VALUES (?, ?, ?, ?, ?)"
  );

  /** Lowest unused place for an hour, or null when the resource is full. */
  const freeSeat = async (weekDate: string, hour: number): Promise<number | null> => {
    const used = new Set(
      (await seatsTaken.all(courtId, weekDate, hour) as { seat: number }[]).map((r) => r.seat)
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
  const memberOn = async (weekDate: string) =>
    await activeMembership(court.venueId, phone, weekDate) !== null;

  try {
    const result = await db.transaction(async () => {
      const bookings: Booking[] = [];
      const skipped: SeriesSkip[] = [];
      for (let week = 0; week < weeks; week++) {
        const weekDate = addDays(date, week * 7);
        const seats: (number | null)[] = [];
        for (const hour of hours) seats.push(await freeSeat(weekDate, hour));

        let reason: string | null = null;
        const classes = await classHoursOn(weekDate, court.venueId);
        if (seats.some((seat) => seat === null)) {
          reason = court.capacity > 1 ? "fully booked" : "already booked";
        } else if (await blockedOut(weekDate)) {
          reason = "closed for maintenance";
        } else if (!input.classId && hours.some((h) => classes.has(`${courtId}:${h}`))) {
          reason = "reserved for a class";
        }
        if (reason) {
          if (!skipConflicts) throw new Error(`CONFLICT:${weekDate}:${reason}`);
          skipped.push({ date: weekDate, reason });
          continue;
        }
        const bookingId = (await insertBooking.run(
          generateCode(), courtId, weekDate, hours[0], hours[hours.length - 1] + 1,
          name, phone, email ?? null, computePrice(court, weekDate, hours, await memberOn(weekDate)),
          userId ?? null, seriesCode, randomBytes(16).toString("hex"),
          input.classId ?? null
        )).lastInsertRowid as number;
        for (const [i, hour] of hours.entries()) await insertSlot.run(bookingId, courtId, weekDate, hour, seats[i]!);
        bookings.push((await getBookingById(bookingId))!);
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
      return refuse("SERIES_ALL_TAKEN");
    }
    if (isUniqueViolation(err, "booking_slots")) {
      // Two requests picked the same place at once; the loser retries against
      // the winner's state. A genuinely full resource fails the seat check
      // above instead, so this cannot spin, but bound it regardless.
      if (attempt < MAX_SEAT_RETRIES) return await createBookingSeries(input, attempt + 1);
      return refuse("FILLING_FAST");
    }
    if (isUniqueViolation(err, "bookings")) {
      // Astronomically rare code collision — one retry is plenty.
      if (attempt < MAX_SEAT_RETRIES) return await createBookingSeries(input, attempt + 1);
      throw err;
    }
    throw err;
  }
}

/** Cancel all future confirmed bookings in a series (verified by phone). */
export async function cancelSeries(
  seriesCode: string,
  phone: string
): Promise<{ ok: true; cancelled: number } | (Refusal & { cancelled: number })> {
  const db = getDb();
  const rows = await db
    .prepare(
      "SELECT * FROM bookings WHERE UPPER(series_code) = UPPER(?) AND phone = ? AND status = 'confirmed'"
    )
    .all(seriesCode.trim(), phone.trim()) as BookingRow[];
  if (rows.length === 0)
    return { ...refuse("SERIES_NOT_FOUND"), cancelled: 0 };

  const cutoff = await cancelCutoffForBooking(rows[0].id);
  const future = rows.filter((r) => isWithinCancelWindow(r.date, r.start_hour, cutoff));
  if (future.length === 0)
    return { ...refuse("SERIES_NONE_LEFT", { n: cutoff }), cancelled: 0 };

  await db.transaction(async () => {
    for (const row of future) {
      await db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(row.id);
      await db.prepare("DELETE FROM booking_slots WHERE booking_id = ?").run(row.id);
    }
  })();
  for (const row of future) await refundBooking(row.id);
  return { ok: true, cancelled: future.length };
}

async function getBookingById(id: number): Promise<Booking | null> {
  const db = getDb();
  const row = await db.prepare("SELECT b.*, ci.checked_in_at, ci.checked_out_at FROM bookings b LEFT JOIN check_ins ci ON ci.booking_id = b.id WHERE b.id = ?").get(id) as BookingRow | undefined;
  return row ? toBooking(row) : null;
}

export async function findBooking(code: string, phone: string): Promise<Booking | null> {
  const db = getDb();
  const row = await db
    .prepare("SELECT b.*, ci.checked_in_at, ci.checked_out_at FROM bookings b LEFT JOIN check_ins ci ON ci.booking_id = b.id WHERE UPPER(b.code) = UPPER(?) AND b.phone = ?")
    .get(code.trim(), phone.trim()) as BookingRow | undefined;
  return row ? toBooking(row) : null;
}

export type CancelResult = { ok: true; booking: Booking } | Refusal;

/** The cancellation cutoff of the venue a booking belongs to. */
async function cancelCutoffForBooking(bookingId: number): Promise<number> {
  const row = await getDb()
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

export async function cancelBooking(code: string, phone: string): Promise<CancelResult> {
  const booking = await findBooking(code, phone);
  if (!booking) return refuse("BOOKING_NOT_FOUND_CODE");
  if (booking.status === "cancelled") return refuse("ALREADY_CANCELLED");
  if (await hasOpenHire(booking.id))
    return refuse("KIT_STILL_OUT");
  const cutoff = await cancelCutoffForBooking(booking.id);
  if (!isWithinCancelWindow(booking.date, booking.startHour, cutoff))
    return { ok: false, error: cutoffMessage(cutoff) };

  const db = getDb();
  await db.transaction(async () => {
    await db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(booking.id);
    await db.prepare("DELETE FROM booking_slots WHERE booking_id = ?").run(booking.id);
  })();
  await refundBooking(booking.id);
  // A freed place goes to whoever has waited longest.
  if (booking.classId) await offerClassPlace(booking.classId);
  else await offerSlotPlace(booking.courtId, booking.date);
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
export async function getAdminSlots(venueId: number, date: string): Promise<AdminCourtSlots[]> {
  const db = getDb();
  const courts = (
    await db.prepare("SELECT * FROM courts WHERE venue_id = ? ORDER BY id").all(venueId) as CourtRow[]
  ).map(toCourt);

  const booked = await db
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

  const blocks = await db
    .prepare(
      "SELECT court_id, hour, reason, places FROM blocks_between(?, ?) WHERE court_id IN (SELECT id FROM courts WHERE venue_id = ?)"
    )
    .all(date, date, venueId) as {
    court_id: number;
    hour: number;
    reason: string | null;
    places: number | null;
  }[];
  const blockMap = new Map(blocks.map((b) => [`${b.court_id}:${b.hour}`, b]));
  const blockedPlaces = await blockedPlacesOn(date, venueId);

  const { openHour, closeHour } = await venueHours(venueId);
  const closure = await getVenueClosure(venueId, date);

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

export type BlockResult = { ok: true; changed: number } | Refusal;

/** Block hours on a court (maintenance/closure). Skips hours that are booked. */
export async function blockSlots(
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
): Promise<BlockResult> {
  const court = await getCourt(courtId);
  if (!court) return refuse("COURT_NOT_FOUND");
  const { openHour, closeHour } = await courtVenueHours(courtId);
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
  await db.transaction(async () => {
    for (const hour of valid) {
      const booked = (await isBooked.get(courtId, date, hour) as { n: number }).n;
      // Taking out more places than are free would strand a booking.
      const wanted = partial ? places! : court.capacity;
      if (booked + wanted > court.capacity) {
        if (partial && strandedAt === null) strandedAt = hour;
        continue;
      }
      changed += (await insert.run(courtId, date, hour, reason ?? null, partial ? places! : null)).changes;
    }
  })();

  if (changed === 0 && strandedAt !== null)
    return {
      ok: false,
      error: `Only ${court.capacity - (await isBooked.get(courtId, date, strandedAt) as { n: number }).n} place(s) are free at ${formatHour(strandedAt)}.`,
    };
  return { ok: true, changed };
}

export async function unblockSlots(courtId: number, date: string, hours: number[]): Promise<BlockResult> {
  if (!await getCourt(courtId)) return refuse("COURT_NOT_FOUND");
  const valid = [...new Set(hours)];
  if (valid.length === 0) return { ok: false, error: "No valid hours given." };
  const db = getDb();
  const result = await db
    .prepare(`DELETE FROM slot_blocks WHERE court_id = ? AND date = ? AND hour IN (${valid.map(() => "?").join(",")})`)
    .run(courtId, date, ...valid);
  return { ok: true, changed: result.changes };
}

/** Admin cancellation by code — no phone check, works even after start time. */
export async function adminCancelBooking(code: string): Promise<CancelResult> {
  const db = getDb();
  const row = await db
    .prepare("SELECT b.*, ci.checked_in_at, ci.checked_out_at FROM bookings b LEFT JOIN check_ins ci ON ci.booking_id = b.id WHERE UPPER(b.code) = UPPER(?)")
    .get(code.trim()) as BookingRow | undefined;
  if (!row) return refuse("BOOKING_NOT_FOUND");
  const booking = toBooking(row);
  if (booking.status === "cancelled") return refuse("ALREADY_CANCELLED");
  // Cancelling would drop the only record of what is out and what is held
  // against it, so settle the hire first even from the admin side.
  if (await hasOpenHire(booking.id))
    return { ok: false, error: "The kit for this booking is still out. Take it back in first." };

  await db.transaction(async () => {
    await db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(booking.id);
    await db.prepare("DELETE FROM booking_slots WHERE booking_id = ?").run(booking.id);
  })();
  await refundBooking(booking.id);
  // A freed place goes to whoever has waited longest.
  if (booking.classId) await offerClassPlace(booking.classId);
  else await offerSlotPlace(booking.courtId, booking.date);
  return { ok: true, booking: { ...booking, status: "cancelled" } };
}

export type MoveResult =
  | { ok: true; booking: Booking; fromCourt: Court; toCourt: Court }
  | Refusal;

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
export async function moveBooking(code: string, toCourtId: number): Promise<MoveResult> {
  const db = getDb();
  const row = await db
    .prepare(
      "SELECT b.*, ci.checked_in_at, ci.checked_out_at FROM bookings b LEFT JOIN check_ins ci ON ci.booking_id = b.id WHERE UPPER(b.code) = UPPER(?)"
    )
    .get(code.trim()) as BookingRow | undefined;
  if (!row) return refuse("BOOKING_NOT_FOUND");
  const booking = toBooking(row);

  if (booking.status === "cancelled")
    return refuse("BOOKING_WAS_CANCELLED");
  if (booking.classId !== null)
    return { ok: false, error: "A class enrolment moves with its class, not on its own." };
  // The kit came off this resource; moving the booking would file it against
  // another one.
  if (await hasOpenHire(booking.id))
    return { ok: false, error: "The kit for this booking is still out. Take it back in first." };

  const fromCourt = await getCourt(booking.courtId);
  const toCourt = await getCourt(toCourtId);
  if (!fromCourt || !toCourt) return refuse("COURT_NOT_FOUND");
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

  const blockedThere = await blockedPlacesFor(toCourtId, booking.date, hours);
  const takenThere = db.prepare(
    "SELECT COUNT(*) AS n FROM booking_slots WHERE court_id = ? AND date = ? AND hour = ?"
  );
  for (const hour of hours) {
    const out = blockedThere.get(hour) ?? 0;
    if (out === 0) continue;
    const taken = (await takenThere.get(toCourtId, booking.date, hour) as { n: number }).n;
    if (taken + out >= toCourt.capacity)
      return { ok: false, error: `${toCourt.name} is blocked off for part of that time.` };
  }

  const classHours = await classHoursOn(booking.date, toCourt.venueId);
  for (const hour of hours) {
    const session = classHours.get(`${toCourtId}:${hour}`);
    if (session)
      return { ok: false, error: `${toCourt.name} is running ${session.name} at that time.` };
  }

  const seatsTaken = db.prepare(
    "SELECT seat FROM booking_slots WHERE court_id = ? AND date = ? AND hour = ?"
  );

  try {
    await db.transaction(async () => {
      // Free the old places first, so a court can be swapped with itself in a
      // shared facility and so the target sees a true picture.
      await db.prepare("DELETE FROM booking_slots WHERE booking_id = ?").run(booking.id);

      const insert = db.prepare(
        "INSERT INTO booking_slots (booking_id, court_id, date, hour, seat) VALUES (?, ?, ?, ?, ?)"
      );
      for (const hour of hours) {
        const used = new Set(
          (await seatsTaken.all(toCourtId, booking.date, hour) as { seat: number }[]).map((r) => r.seat)
        );
        let seat: number | null = null;
        for (let s = 0; s < toCourt.capacity; s++) {
          if (!used.has(s)) { seat = s; break; }
        }
        if (seat === null) throw new Error(`FULL:${hour}`);
        // The unique index is the real guard; a racing insert fails here.
        await insert.run(booking.id, toCourtId, booking.date, hour, seat);
      }
      await db.prepare("UPDATE bookings SET court_id = ? WHERE id = ?").run(toCourtId, booking.id);
    })();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("FULL:")) {
      const hour = err.message.slice(5);
      return { ok: false, error: `${toCourt.name} is already taken at ${formatHour(Number(hour))}.` };
    }
    if (isUniqueViolation(err))
      return { ok: false, error: `${toCourt.name} was taken while you were moving it. Try again.` };
    throw err;
  }

  // The court it left may now be free for somebody waiting on it.
  await offerSlotPlace(fromCourt.id, booking.date);

  return {
    ok: true,
    booking: { ...booking, courtId: toCourtId },
    fromCourt,
    toCourt,
  };
}

/** Courts a booking could move to right now, for the staff picker. */
export async function moveTargetsFor(code: string): Promise<Court[]> {
  const booking = await bookingByCode(code);
  if (!booking || booking.status === "cancelled" || booking.classId !== null) return [];
  const court = await getCourt(booking.courtId);
  if (!court) return [];
  const hours = Array.from(
    { length: booking.endHour - booking.startHour },
    (_, i) => booking.startHour + i
  );
  const db = getDb();
  const candidates = (
    await db
      .prepare("SELECT * FROM courts WHERE venue_id = ? AND sport = ? AND id != ? ORDER BY id")
      .all(court.venueId, court.sport, court.id) as CourtRow[]
  ).map(toCourt);

  const classHours = await classHoursOn(booking.date, court.venueId);
  const free: Court[] = [];
  candidates: for (const c of candidates) {
    const blocked = await blockedPlacesFor(c.id, booking.date, hours);
    for (const hour of hours) {
      if (classHours.has(`${c.id}:${hour}`)) continue candidates;
      const taken = await db
        .prepare(
          "SELECT COUNT(*) AS n FROM booking_slots WHERE court_id = ? AND date = ? AND hour = ?"
        )
        .get(c.id, booking.date, hour) as { n: number };
      if (taken.n + (blocked.get(hour) ?? 0) >= c.capacity) continue candidates;
    }
    free.push(c);
  }
  return free;
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
export async function getOccupancy(venueId: number, start: string, numDays: number): Promise<OccupancyReport> {
  const db = getDb();
  const courts = (
    await db.prepare("SELECT * FROM courts WHERE venue_id = ? ORDER BY id").all(venueId) as CourtRow[]
  ).map(toCourt);
  const courtIds = new Set(courts.map((c) => c.id));

  const dates = Array.from({ length: numDays }, (_, i) => addDays(start, i));
  const end = dates[dates.length - 1];

  const bookedRows = await db
    .prepare(`
      SELECT court_id, date, COUNT(*) AS n FROM booking_slots
      WHERE date >= ? AND date <= ? GROUP BY court_id, date
    `)
    .all(start, end) as { court_id: number; date: string; n: number }[];
  // A partial block does not remove an hour from the day, so only count the
  // blocks that take the whole resource.
  const blockedRows = await db
    .prepare(`
      SELECT b.court_id AS court_id, b.date AS date, COUNT(*) AS n
      FROM blocks_between(?, ?) b JOIN courts c ON c.id = b.court_id
      WHERE COALESCE(b.places, c.capacity) >= c.capacity
      GROUP BY b.court_id, b.date
    `)
    .all(start, end) as { court_id: number; date: string; n: number }[];

  const bookedMap = new Map(
    bookedRows.filter((r) => courtIds.has(r.court_id)).map((r) => [`${r.court_id}:${r.date}`, r.n])
  );
  const blockedMap = new Map(
    blockedRows.filter((r) => courtIds.has(r.court_id)).map((r) => [`${r.court_id}:${r.date}`, r.n])
  );

  const { openHour, closeHour } = await venueHours(venueId);

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

export type VenueEditResult = { ok: true; venue: Venue } | Refusal;

/** Validate a venue's trading hours, defaulting anything not given. */
function normaliseHours(
  open: number | undefined,
  close: number | undefined
): { ok: true; openHour: number; closeHour: number } | Refusal {
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

export async function createVenue(input: {
  name: string;
  area: string;
  address: string;
  phone: string;
  openHour?: number;
  closeHour?: number;
  /** A business setting itself up: nobody else sees it until it goes live. */
  draft?: boolean;
}): Promise<VenueEditResult> {
  const hours = normaliseHours(input.openHour, input.closeHour);
  if (!hours.ok) return hours;
  const db = getDb();
  const info = await db
    .prepare(
      `INSERT INTO venues (name, area, address, phone, open_hour, close_hour, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ${input.draft ? "NULL" : "datetime('now')"})`
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
    await db.prepare("SELECT * FROM venues WHERE id = ?").get(info.lastInsertRowid) as VenueRow
  );
  return { ok: true, venue };
}

/**
 * Move a venue's pin. Returns how far it moved, in metres, or null when it
 * had none before.
 */
export async function setVenuePin(venueId: number, pin: { lat: number; lng: number }): Promise<number | null> {
  const db = getDb();
  const old = (await db.prepare("SELECT lat, lng FROM venues WHERE id = ?").get(venueId)) as
    | { lat: number | null; lng: number | null }
    | undefined;
  await db.prepare("UPDATE venues SET lat = ?, lng = ? WHERE id = ?").run(pin.lat, pin.lng, venueId);
  return old && old.lat !== null && old.lng !== null ? distanceM({ lat: old.lat, lng: old.lng }, pin) : null;
}

export async function updateVenue(
  venueId: number,
  changes: {
    name?: string;
    area?: string;
    address?: string;
    phone?: string;
    cancelCutoffHours?: number;
    openHour?: number;
    closeHour?: number;
    /** null for both means always staffed; equal values mean never staffed. */
    staffedFrom?: number | null;
    staffedTo?: number | null;
    emergencyPhone?: string | null;
    emergencyInfo?: string | null;
  }
): Promise<VenueEditResult> {
  const db = getDb();
  const row = await db.prepare("SELECT * FROM venues WHERE id = ?").get(venueId) as VenueRow | undefined;
  if (!row) return refuse("VENUE_NOT_FOUND");
  const current = toVenue(row);

  const hours = normaliseHours(
    changes.openHour ?? current.openHour,
    changes.closeHour ?? current.closeHour
  );
  if (!hours.ok) return hours;
  // Narrowing the day would strand anything already sold outside the new hours.
  const stranded = await db
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

  const staffedFrom =
    changes.staffedFrom !== undefined ? changes.staffedFrom : current.staffedFrom;
  const staffedTo = changes.staffedTo !== undefined ? changes.staffedTo : current.staffedTo;
  if ((staffedFrom === null) !== (staffedTo === null))
    return { ok: false, error: "Give both ends of the staffed window, or neither." };
  for (const hour of [staffedFrom, staffedTo]) {
    if (hour !== null && (!Number.isInteger(hour) || hour < 0 || hour > 24))
      return { ok: false, error: "A staffed hour must be between 0 and 24." };
  }
  // Unstaffed hours only mean anything where a resource can be let into, and
  // taking the counter away from kit that is on loan is the one combination
  // that cannot work at all.
  if (staffedFrom !== null && (await listOpenHires(venueId)).length > 0 && staffedFrom === staffedTo)
    return {
      ok: false,
      error: "Kit is out on hire at this venue. Somebody has to be here to take it back.",
    };

  await db.prepare(
    `UPDATE venues SET name = ?, area = ?, address = ?, phone = ?, cancel_cutoff_hours = ?,
                       open_hour = ?, close_hour = ?, staffed_from = ?, staffed_to = ?,
                       emergency_phone = ?, emergency_info = ? WHERE id = ?`
  ).run(
    changes.name?.trim() ?? current.name,
    changes.area?.trim() ?? current.area,
    changes.address?.trim() ?? current.address,
    changes.phone?.trim() ?? current.phone,
    changes.cancelCutoffHours ?? current.cancelCutoffHours,
    hours.openHour,
    hours.closeHour,
    staffedFrom,
    staffedTo,
    changes.emergencyPhone !== undefined
      ? nullIfBlank(changes.emergencyPhone)
      : current.emergencyPhone,
    changes.emergencyInfo !== undefined
      ? nullIfBlank(changes.emergencyInfo)
      : current.emergencyInfo,
    venueId
  );
  return {
    ok: true,
    venue: toVenue(await db.prepare("SELECT * FROM venues WHERE id = ?").get(venueId) as VenueRow),
  };
}

/** Which venue a booking code belongs to — used to scope admin actions. */
export async function getVenueIdForBookingCode(code: string): Promise<number | null> {
  const row = await getDb()
    .prepare(`
      SELECT c.venue_id AS venue_id FROM bookings b
      JOIN courts c ON c.id = b.court_id
      WHERE UPPER(b.code) = UPPER(?)
    `)
    .get(code.trim()) as { venue_id: number } | undefined;
  return row?.venue_id ?? null;
}

/** Venues touched by a series — a series should never span venues, but check. */
export async function getVenueIdsForSeriesCode(seriesCode: string): Promise<number[]> {
  const rows = await getDb()
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
  venueId: number;
  venueName: string;
  /** Prior no-shows by this phone number, so the desk can spot repeats. */
  priorNoShows: number;
  /** What this resource is hired out against, 0 when it stays put. */
  courtDeposit: number;
  /** The hire against this booking, open or settled. */
  hire: HireRecord | null;
}

export interface UserBookingRow extends Booking {
  courtName: string;
  sport: Sport;
  venueName: string;
  venueArea: string;
  venueAddress: string;
}

export async function listUserBookings(userId: number): Promise<UserBookingRow[]> {
  const db = getDb();
  const rows = await db
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
export async function cancelUserBooking(userId: number, bookingId: number): Promise<CancelResult> {
  const db = getDb();
  const row = await db
    .prepare("SELECT b.*, ci.checked_in_at, ci.checked_out_at FROM bookings b LEFT JOIN check_ins ci ON ci.booking_id = b.id WHERE b.id = ? AND b.user_id = ?")
    .get(bookingId, userId) as BookingRow | undefined;
  if (!row) return refuse("BOOKING_NOT_FOUND");
  const booking = toBooking(row);
  if (booking.status === "cancelled") return refuse("ALREADY_CANCELLED");
  if (await hasOpenHire(booking.id))
    return refuse("KIT_STILL_OUT");
  const cutoff = await cancelCutoffForBooking(booking.id);
  if (!isWithinCancelWindow(booking.date, booking.startHour, cutoff))
    return { ok: false, error: cutoffMessage(cutoff) };

  await db.transaction(async () => {
    await db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(booking.id);
    await db.prepare("DELETE FROM booking_slots WHERE booking_id = ?").run(booking.id);
  })();
  await refundBooking(booking.id);
  // A freed place goes to whoever has waited longest.
  if (booking.classId) await offerClassPlace(booking.classId);
  else await offerSlotPlace(booking.courtId, booking.date);
  return { ok: true, booking: { ...booking, status: "cancelled" } };
}

export type PaymentResult = { ok: true; booking: Booking } | Refusal;

/** Front-desk payment toggle for a single booking (admin only). */
export async function setPaymentStatus(code: string, paid: boolean): Promise<PaymentResult> {
  return withTransaction(async () => {
    const db = getDb();
    const row = await db
      .prepare("SELECT b.*, ci.checked_in_at, ci.checked_out_at FROM bookings b LEFT JOIN check_ins ci ON ci.booking_id = b.id WHERE UPPER(b.code) = UPPER(?)")
      .get(code.trim()) as BookingRow | undefined;
    if (!row) return refuse("BOOKING_NOT_FOUND");
    const booking = toBooking(row);
    if (booking.status === "cancelled")
      return { ok: false, error: "This booking is cancelled." };
    if ((booking.paymentStatus === "paid") === paid)
      return { ok: false, error: `This booking is already marked ${paid ? "paid" : "unpaid"}.` };

    // Marked by hand, so whatever it was paid with, it was not the gateway.
    await db.prepare(
      "UPDATE bookings SET payment_status = ?, paid_at = ?, paid_via = NULL WHERE id = ?"
    ).run(paid ? "paid" : "unpaid", paid ? new Date().toISOString() : null, booking.id);
    return {
      ok: true,
      booking: {
        ...booking,
        paymentStatus: paid ? "paid" : "unpaid",
        paidAt: paid ? new Date().toISOString() : null,
      },
    };
  });
}

/** Mark every confirmed session in a series paid at once. */
export async function paySeries(seriesCode: string): Promise<{ ok: boolean; paid: number; error?: string }> {
  const db = getDb();
  const rows = await db
    .prepare(
      "SELECT * FROM bookings WHERE UPPER(series_code) = UPPER(?) AND status = 'confirmed' AND payment_status = 'unpaid'"
    )
    .all(seriesCode.trim()) as BookingRow[];
  if (rows.length === 0)
    return { ok: false, paid: 0, error: "No unpaid sessions found for that series." };

  const now = new Date().toISOString();
  await db.transaction(async () => {
    for (const row of rows) {
      await db.prepare("UPDATE bookings SET payment_status = 'paid', paid_at = ? WHERE id = ?").run(
        now,
        row.id
      );
    }
  })();
  return { ok: true, paid: rows.length };
}

export type CheckInResult = { ok: true; booking: Booking } | Refusal;

async function bookingByCode(code: string): Promise<Booking | null> {
  const row = await getDb()
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
export async function checkIn(code: string): Promise<CheckInResult> {
  const booking = await bookingByCode(code);
  if (!booking) return refuse("BOOKING_NOT_FOUND");
  return await checkInBooking(booking);
}

/** Self-service check-in from the QR code on a booking. */
export async function checkInByToken(token: string): Promise<CheckInResult> {
  const trimmed = token.trim();
  if (trimmed === "") return refuse("BOOKING_NOT_FOUND");
  const row = await getDb()
    .prepare(
      "SELECT b.*, ci.checked_in_at, ci.checked_out_at FROM bookings b LEFT JOIN check_ins ci ON ci.booking_id = b.id WHERE b.check_in_token = ?"
    )
    .get(trimmed) as BookingRow | undefined;
  if (!row) return refuse("BOOKING_NOT_FOUND");
  return await checkInBooking(toBooking(row));
}

async function checkInBooking(booking: Booking): Promise<CheckInResult> {
  if (booking.status === "cancelled") return refuse("BOOKING_WAS_CANCELLED");
  if (booking.checkedInAt) return { ok: false, error: "Already checked in." };
  const windowError = checkInWindowError(booking);
  if (windowError) return { ok: false, error: windowError };

  const db = getDb();
  await db.transaction(async () => {
    await db.prepare("INSERT INTO check_ins (booking_id) VALUES (?)").run(booking.id);
    // Arriving contradicts a no-show, so clear any stale flag.
    if (booking.noShow) await db.prepare("UPDATE bookings SET no_show = 0 WHERE id = ?").run(booking.id);
  })();
  return { ok: true, booking: (await bookingByCode(booking.code))! };
}

export async function checkOut(code: string): Promise<CheckInResult> {
  return withTransaction(async () => {
    const booking = await bookingByCode(code);
    if (!booking) return refuse("BOOKING_NOT_FOUND");
    if (!booking.checkedInAt) return { ok: false, error: "This booking has not checked in." };
    if (booking.checkedOutAt) return { ok: false, error: "Already checked out." };

    await getDb()
      .prepare("UPDATE check_ins SET checked_out_at = datetime('now') WHERE booking_id = ?")
      .run(booking.id);
    return { ok: true, booking: (await bookingByCode(code))! };
  });
}

// ---------------------------------------------------------------------------
// Inductions
//
// The 24-hour chains do not hand overnight access to a stranger who signed up
// on a phone. Somebody is shown round in person first: where the emergency
// button is, what not to do on a rack with nobody watching, and their identity
// and age are checked while they stand there. That visit is what turns an
// unstaffed gym from reckless into insurable, so it is recorded by an operator
// and can never be self-declared.
// ---------------------------------------------------------------------------

interface InductionRow {
  id: number;
  venue_id: number;
  phone: string;
  name: string;
  admin_id: number | null;
  note: string | null;
  created_at: string;
  revoked_at: string | null;
  admin_name: string | null;
}

function toInduction(r: InductionRow): Induction {
  return {
    id: r.id,
    venueId: r.venue_id,
    phone: r.phone,
    name: r.name,
    adminName: r.admin_name,
    note: r.note,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
  };
}

const INDUCTION_SELECT = `
  SELECT i.*, a.name AS admin_name
  FROM inductions i
  LEFT JOIN admins a ON a.id = i.admin_id
`;

/** Has this person been shown round, and not since been withdrawn? */
export async function isInducted(venueId: number, phone: string): Promise<boolean> {
  const row = await getDb()
    .prepare(
      "SELECT 1 AS n FROM inductions WHERE venue_id = ? AND phone = ? AND revoked_at IS NULL"
    )
    .get(venueId, normalisePhone(phone)) as { n: number } | undefined;
  return row !== undefined;
}

export type InductionResult =
  | { ok: true; induction: Induction }
  | Refusal;

/**
 * Record that an operator has shown somebody round.
 *
 * Re-inducting a person who was withdrawn revives the same row rather than
 * adding a second one, so the venue keeps one line per person and the history
 * of it stays on that line.
 */
export async function recordInduction(input: {
  venueId: number;
  phone: string;
  name: string;
  adminId?: number;
  note?: string;
}): Promise<InductionResult> {
  return withTransaction(async () => {
    const db = getDb();
    if (!await getVenue(input.venueId)) return refuse("VENUE_NOT_FOUND");
    const phone = normalisePhone(input.phone);
    if (phone.length < 7) return { ok: false, error: "Please give a valid phone number." };
    const name = input.name.trim();
    if (name.length < 2) return { ok: false, error: "Please give the person's name." };
    const note = nullIfBlank(input.note ?? null);

    const existing = await db
      .prepare("SELECT id, revoked_at FROM inductions WHERE venue_id = ? AND phone = ?")
      .get(input.venueId, phone) as { id: number; revoked_at: string | null } | undefined;

    if (existing && existing.revoked_at === null)
      return { ok: false, error: `${name} has already been inducted here.` };

    if (existing) {
      await db.prepare(`
        UPDATE inductions
        SET name = ?, admin_id = ?, note = ?, created_at = datetime('now'), revoked_at = NULL
        WHERE id = ?
      `).run(name, input.adminId ?? null, note, existing.id);
      return { ok: true, induction: (await inductionById(existing.id))! };
    }

    const info = await db
      .prepare(
        "INSERT INTO inductions (venue_id, phone, name, admin_id, note) VALUES (?, ?, ?, ?, ?)"
      )
      .run(input.venueId, phone, name, input.adminId ?? null, note);
    return { ok: true, induction: (await inductionById(info.lastInsertRowid as number))! };
  });
}

/** Withdraw someone's out-of-hours access without losing the record of it. */
export async function revokeInduction(id: number): Promise<InductionResult> {
  return withTransaction(async () => {
    const db = getDb();
    const induction = await inductionById(id);
    if (!induction) return { ok: false, error: "Induction not found." };
    if (induction.revokedAt) return { ok: false, error: "That access is already withdrawn." };
    await db.prepare("UPDATE inductions SET revoked_at = datetime('now') WHERE id = ?").run(id);
    return { ok: true, induction: (await inductionById(id))! };
  });
}

export async function inductionById(id: number): Promise<Induction | null> {
  const row = await getDb().prepare(`${INDUCTION_SELECT} WHERE i.id = ?`).get(id) as
    | InductionRow
    | undefined;
  return row ? toInduction(row) : null;
}

/** Everyone cleared for out-of-hours use at a venue, newest first. */
export async function listInductions(venueId: number): Promise<Induction[]> {
  const rows = await getDb()
    .prepare(`${INDUCTION_SELECT} WHERE i.venue_id = ? ORDER BY i.revoked_at IS NOT NULL, i.created_at DESC`)
    .all(venueId) as InductionRow[];
  return rows.map(toInduction);
}

/**
 * How many people are inside this venue right now, from door codes and desk
 * check-ins alike. The honest answer to "will I be on my own in there?".
 */
export async function presentAtVenue(venueId: number): Promise<number> {
  const rows = await getDb()
    .prepare(`
      SELECT b.date, b.end_hour FROM check_ins ci
      JOIN bookings b ON b.id = ci.booking_id
      JOIN courts c ON c.id = b.court_id
      WHERE c.venue_id = ? AND ci.checked_out_at IS NULL
        AND b.status = 'confirmed' AND b.date = ?
    `)
    .all(venueId, todayISO()) as { date: string; end_hour: number }[];
  const now = Date.now();
  return rows.filter((r) => slotStartsAt(r.date, r.end_hour).getTime() > now).length;
}

// ---------------------------------------------------------------------------
// Unmanned resources
//
// A badminton court at 11 PM does not need anybody standing next to it. A
// kayak does, which is why this is a property of the resource rather than the
// venue: a centre can put its courts behind a keypad overnight and still keep
// someone at the counter where the hulls are.
//
// MySenam does not open the door. It relays a code that staff have programmed
// into the lock, to people who have earned the right to see it, and writes
// down every time it did so. Generating or rotating the code here would be
// worse than useless: the lock would not know, and the court would be
// unopenable by the one person entitled to be in it.
// ---------------------------------------------------------------------------

export interface CourtAccess {
  code: string | null;
  changedAt: string | null;
  /** True once the code has gone unchanged long enough to be worth nagging. */
  stale: boolean;
}

/** The door code for a resource. Admin-only: never goes near a public route. */
export async function courtAccess(courtId: number): Promise<CourtAccess> {
  const row = await getDb()
    .prepare("SELECT access_code, access_code_changed_at FROM courts WHERE id = ?")
    .get(courtId) as { access_code: string | null; access_code_changed_at: string | null } | undefined;
  if (!row) return { code: null, changedAt: null, stale: false };

  const changedAt = row.access_code_changed_at;
  const stale =
    row.access_code !== null &&
    (changedAt === null ||
      Date.now() - Date.parse(`${changedAt.replace(" ", "T")}Z`) >
        ACCESS_CODE_STALE_DAYS * 86_400_000);
  return { code: row.access_code, changedAt, stale };
}

/**
 * Give the customer the code for their booking, and write down that we did.
 *
 * Every refusal here is a thing the customer can act on, so each carries its
 * own reason rather than a flat no. The window is the check-in window, because
 * they are the same event: on an unmanned court, opening the door *is*
 * arriving, so this also checks them in and the live headcount stays honest
 * without anybody at a desk to press a button.
 */
export async function accessCodeFor(code: string, phone: string): Promise<AccessResult | null> {
  const db = getDb();
  const booking = await findBooking(code, phone);
  if (!booking) return null;

  const court = await getCourt(booking.courtId);
  if (!court) return null;
  const access = await courtAccess(court.id);

  if (!court.unmanned || access.code === null)
    return {
      ok: false,
      reason: "not-unmanned",
      message: `Someone will let you in at ${court.name}. There is no door code for it.`,
    };
  if (booking.status === "cancelled")
    return { ok: false, reason: "cancelled", message: "This booking was cancelled." };

  const venue = await getVenue(court.venueId);
  if (!venue) return null;

  // During staffed hours the counter does this, and a code handed out then is
  // a code in circulation for no reason.
  if (!isUnstaffedHour(venue, booking.startHour))
    return {
      ok: false,
      reason: "staffed-now",
      message: `Someone is on the desk at that hour. Ask at the counter and they will let you in.`,
    };

  // Nobody is here to show a stranger where the emergency button is, so that
  // has to have happened already, in person, while somebody could check it.
  if (!await isInducted(venue.id, booking.phone))
    return {
      ok: false,
      reason: "no-induction",
      message:
        "Before using this outside staffed hours you need a one-off run-through at the desk. Drop in while the counter is open and it takes a few minutes.",
    };

  // Nobody is on site to take the money, so the door is the till.
  if (booking.paymentStatus !== "paid")
    return {
      ok: false,
      reason: "unpaid",
      message:
        "This booking is not paid yet. Nobody is on site to take payment, so the code appears once it is.",
    };

  const now = Date.now();
  const opens =
    slotStartsAt(booking.date, booking.startHour).getTime() -
    CHECK_IN_OPENS_MINUTES_BEFORE * 60_000;
  const ends = slotStartsAt(booking.date, booking.endHour).getTime();
  if (now < opens)
    return {
      ok: false,
      reason: "too-early",
      message: `Your code appears ${CHECK_IN_OPENS_MINUTES_BEFORE} minutes before your slot.`,
    };
  if (now >= ends)
    return { ok: false, reason: "over", message: "This booking has already ended." };

  await db.transaction(async () => {
    await db.prepare("INSERT INTO access_reveals (booking_id) VALUES (?)").run(booking.id);
    // Opening the door is the arrival, so there is nothing else to press.
    if (!booking.checkedInAt) {
      await db.prepare("INSERT INTO check_ins (booking_id) VALUES (?)").run(booking.id);
      if (booking.noShow) await db.prepare("UPDATE bookings SET no_show = 0 WHERE id = ?").run(booking.id);
    }
  })();

  return {
    ok: true,
    accessCode: access.code,
    courtName: court.name,
    venueName: venue.name,
    until: formatHour(booking.endHour),
    emergencyPhone: venue.emergencyPhone,
    emergencyInfo: venue.emergencyInfo,
    // Counted after the check-in above, so it includes them.
    presentNow: await presentAtVenue(venue.id),
  };
}

export interface AccessReveal {
  bookingCode: string;
  name: string;
  phone: string;
  courtName: string;
  revealedAt: string;
}

/** Who has been given a code at this venue, most recent first. */
export async function listAccessReveals(venueId: number, limit = 50): Promise<AccessReveal[]> {
  const rows = await getDb()
    .prepare(`
      SELECT b.code, b.name, b.phone, c.name AS court_name, r.revealed_at
      FROM access_reveals r
      JOIN bookings b ON b.id = r.booking_id
      JOIN courts c ON c.id = b.court_id
      WHERE c.venue_id = ?
      ORDER BY r.revealed_at DESC, r.id DESC
      LIMIT ?
    `)
    .all(venueId, limit) as {
    code: string;
    name: string;
    phone: string;
    court_name: string;
    revealed_at: string;
  }[];
  return rows.map((r) => ({
    bookingCode: r.code,
    name: r.name,
    phone: r.phone,
    courtName: r.court_name,
    revealedAt: r.revealed_at,
  }));
}

// ---------------------------------------------------------------------------
// Equipment hire
//
// Some resources leave the building. A kayak goes on the water, a racquet goes
// home in a bag. Against that the desk holds a deposit — cash or a card
// imprint, not account credit — and hands it back when the kit returns. What
// the system owes that process is a record of what is out, what is being held
// against it, and what came back in what state; the money itself never moves
// through the wallet, so nothing here writes a ledger entry.
// ---------------------------------------------------------------------------

interface HireRow {
  id: number;
  booking_id: number;
  deposit: number;
  taken_at: string;
  returned_at: string | null;
  withheld: number | null;
  condition: HireCondition | null;
  note: string | null;
  code: string;
  court_id: number;
  court_name: string;
  venue_id: number;
  name: string;
  phone: string;
}

const HIRE_SELECT = `
  SELECT h.*, b.code, b.court_id, b.name, b.phone, c.name AS court_name, c.venue_id
  FROM hire_records h
  JOIN bookings b ON b.id = h.booking_id
  JOIN courts c ON c.id = b.court_id
`;

function toHire(r: HireRow): HireRecord {
  return {
    id: r.id,
    bookingId: r.booking_id,
    bookingCode: r.code,
    courtId: r.court_id,
    courtName: r.court_name,
    venueId: r.venue_id,
    name: r.name,
    phone: r.phone,
    deposit: r.deposit,
    takenAt: r.taken_at,
    returnedAt: r.returned_at,
    withheld: r.withheld,
    condition: r.condition,
    note: r.note,
  };
}

/** The hire against a booking, open or settled. */
export async function hireFor(bookingId: number): Promise<HireRecord | null> {
  const row = await getDb()
    .prepare(`${HIRE_SELECT} WHERE h.booking_id = ?`)
    .get(bookingId) as HireRow | undefined;
  return row ? toHire(row) : null;
}

/** True while kit against this booking is physically out. */
export async function hasOpenHire(bookingId: number): Promise<boolean> {
  const row = await getDb()
    .prepare("SELECT 1 AS n FROM hire_records WHERE booking_id = ? AND returned_at IS NULL")
    .get(bookingId) as { n: number } | undefined;
  return row !== undefined;
}

async function openHireCountForCourt(courtId: number): Promise<number> {
  const row = await getDb()
    .prepare(`
      SELECT COUNT(*) AS n FROM hire_records h
      JOIN bookings b ON b.id = h.booking_id
      WHERE b.court_id = ? AND h.returned_at IS NULL
    `)
    .get(courtId) as { n: number };
  return row.n;
}

/** Everything still out at a venue, oldest first — the desk's chase list. */
export async function listOpenHires(venueId: number): Promise<HireRecord[]> {
  const rows = await getDb()
    .prepare(`${HIRE_SELECT} WHERE c.venue_id = ? AND h.returned_at IS NULL ORDER BY h.taken_at`)
    .all(venueId) as HireRow[];
  return rows.map(toHire);
}

export type HireResult =
  | { ok: true; hire: HireRecord; booking: Booking }
  | Refusal;

/**
 * Hand the kit over and record the deposit held against it.
 *
 * The deposit defaults to the court's own figure; staff may override it,
 * including down to nothing, because a waiver still needs the rest of the
 * record — the kayak is out either way. Handing over also checks the customer
 * in, so the desk does one thing instead of two, and the check-in window
 * applies unchanged: kit does not leave before the slot it belongs to.
 */
export async function takeHire(code: string, deposit?: number): Promise<HireResult> {
  const db = getDb();
  const booking = await bookingByCode(code);
  if (!booking) return refuse("BOOKING_NOT_FOUND");
  if (booking.status === "cancelled") return refuse("BOOKING_WAS_CANCELLED");

  const court = await getCourt(booking.courtId);
  if (!court) return refuse("COURT_NOT_FOUND");
  if (court.deposit <= 0)
    return { ok: false, error: `${court.name} is not hired out. Set a deposit on it first.` };

  const existing = await hireFor(booking.id);
  if (existing)
    return {
      ok: false,
      error: existing.returnedAt
        ? "This booking's kit has already been taken back."
        : "A deposit is already held on this booking.",
    };

  const held = deposit ?? court.deposit;
  if (!Number.isInteger(held) || held < 0)
    return { ok: false, error: "A deposit must be a whole number of ringgit." };
  if (held > MAX_DEPOSIT)
    return { ok: false, error: `A deposit cannot be more than RM${MAX_DEPOSIT}.` };

  if (!booking.checkedInAt) {
    const windowError = checkInWindowError(booking);
    if (windowError) return { ok: false, error: windowError };
  }
  if (booking.checkedOutAt)
    return { ok: false, error: "This booking has already checked out." };

  await db.transaction(async () => {
    if (!booking.checkedInAt) {
      await db.prepare("INSERT INTO check_ins (booking_id) VALUES (?)").run(booking.id);
      if (booking.noShow) await db.prepare("UPDATE bookings SET no_show = 0 WHERE id = ?").run(booking.id);
    }
    await db.prepare("INSERT INTO hire_records (booking_id, deposit) VALUES (?, ?)").run(
      booking.id,
      held
    );
  })();

  return { ok: true, hire: (await hireFor(booking.id))!, booking: (await bookingByCode(booking.code))! };
}

/**
 * Take the kit back in, settling the deposit.
 *
 * `withheld` is what the venue keeps out of the hold — never more than it took,
 * so a damaged hull cannot turn into a bill through this screen. Anything kept
 * back, and any condition short of fine, needs a note: the customer is about to
 * be told why they are not getting all of their money, and "damaged" alone is
 * not a reason anyone can stand behind later.
 */
export async function returnHire(
  code: string,
  input: { condition: HireCondition; withheld?: number; note?: string }
): Promise<HireResult> {
  const db = getDb();
  const booking = await bookingByCode(code);
  if (!booking) return refuse("BOOKING_NOT_FOUND");

  const hire = await hireFor(booking.id);
  if (!hire) return { ok: false, error: "No deposit is held on this booking." };
  if (hire.returnedAt) return { ok: false, error: "This kit has already been taken back." };

  if (!HIRE_CONDITIONS.includes(input.condition))
    return { ok: false, error: "Unknown condition." };

  const withheld = input.withheld ?? 0;
  if (!Number.isInteger(withheld) || withheld < 0)
    return { ok: false, error: "An amount withheld must be a whole number of ringgit." };
  if (withheld > hire.deposit)
    return {
      ok: false,
      error: `Only RM${hire.deposit} is held on this booking, so RM${withheld} cannot be kept back.`,
    };

  const note = (input.note ?? "").trim();
  if (note.length > MAX_HIRE_NOTE)
    return { ok: false, error: `A note cannot be longer than ${MAX_HIRE_NOTE} characters.` };
  if ((input.condition !== "ok" || withheld > 0) && note === "")
    return { ok: false, error: "Say what happened — a note is required when the kit is not returned fine." };

  await db.transaction(async () => {
    await db.prepare(`
      UPDATE hire_records
      SET returned_at = datetime('now'), withheld = ?, condition = ?, note = ?
      WHERE booking_id = ?
    `).run(withheld, input.condition, note === "" ? null : note, booking.id);
    // The kit is back, so whoever brought it has left the desk.
    await db.prepare(
      "UPDATE check_ins SET checked_out_at = datetime('now') WHERE booking_id = ? AND checked_out_at IS NULL"
    ).run(booking.id);
  })();

  return { ok: true, hire: (await hireFor(booking.id))!, booking: (await bookingByCode(booking.code))! };
}

/**
 * Who is inside each resource right now, from door check-ins.
 *
 * Someone counts as present when they have checked in, have not checked out,
 * and their booking has not ended yet — most people leave without telling the
 * desk, so the booking's end time is the backstop.
 */
export async function getLiveOccupancy(venueId: number): Promise<LiveOccupancy[]> {
  const db = getDb();
  const courts = (
    await db.prepare("SELECT * FROM courts WHERE venue_id = ? ORDER BY id").all(venueId) as CourtRow[]
  ).map(toCourt);
  if (courts.length === 0) return [];

  const rows = await db
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

export type NoShowResult = { ok: true; booking: Booking } | Refusal;

/** Flag a passed booking whose customer never turned up (staff only). */
export async function setNoShow(code: string, noShow: boolean): Promise<NoShowResult> {
  return withTransaction(async () => {
    const db = getDb();
    const row = await db
      .prepare("SELECT b.*, ci.checked_in_at, ci.checked_out_at FROM bookings b LEFT JOIN check_ins ci ON ci.booking_id = b.id WHERE UPPER(b.code) = UPPER(?)")
      .get(code.trim()) as BookingRow | undefined;
    if (!row) return refuse("BOOKING_NOT_FOUND");
    const booking = toBooking(row);

    if (booking.status === "cancelled")
      return refuse("BOOKING_WAS_CANCELLED");
    if (noShow && !isPastSlot(booking.date, booking.startHour))
      return { ok: false, error: "This booking has not started yet." };
    if (noShow && booking.checkedInAt)
      return { ok: false, error: "This customer checked in, so they were not a no-show." };
    if (booking.noShow === noShow)
      return { ok: false, error: `Already marked ${noShow ? "a no-show" : "attended"}.` };

    await db.prepare("UPDATE bookings SET no_show = ? WHERE id = ?").run(noShow ? 1 : 0, booking.id);
    return { ok: true, booking: { ...booking, noShow } };
  });
}

/** How many times this phone number has been flagged a no-show. */
export async function countNoShows(phone: string): Promise<number> {
  const row = await getDb()
    .prepare("SELECT COUNT(*) AS n FROM bookings WHERE phone = ? AND no_show = 1")
    .get(phone.trim()) as { n: number };
  return row.n;
}

export type CourtEditResult = { ok: true; court: Court } | Refusal;

export async function createCourt(input: {
  venueId: number;
  name: string;
  sport: Sport;
  offPeakRate: number;
  peakRate: number;
  capacity?: number;
  deposit?: number;
}): Promise<CourtEditResult> {
  const db = getDb();
  if (!await getVenue(input.venueId)) return refuse("VENUE_NOT_FOUND");
  const info = await db
    .prepare(
      "INSERT INTO courts (venue_id, name, sport, off_peak_rate, peak_rate, capacity, deposit) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      input.venueId,
      input.name.trim(),
      input.sport,
      input.offPeakRate,
      input.peakRate,
      input.capacity ?? 1,
      input.deposit ?? 0
    );
  return { ok: true, court: (await getCourt(info.lastInsertRowid as number))! };
}

export async function updateCourt(
  courtId: number,
  changes: {
    name?: string;
    offPeakRate?: number;
    peakRate?: number;
    /** null clears it, so members pay the public rate on this court again. */
    memberOffPeakRate?: number | null;
    memberPeakRate?: number | null;
    capacity?: number;
    deposit?: number;
    unmanned?: boolean;
    /** null clears the stored code, which also switches unmanned off. */
    accessCode?: string | null;
  }
): Promise<CourtEditResult> {
  const db = getDb();
  const court = await getCourt(courtId);
  if (!court) return refuse("COURT_NOT_FOUND");

  // Shrinking capacity below what is already booked would strand those
  // bookings, so refuse rather than silently overbook.
  if (changes.capacity !== undefined && changes.capacity < court.capacity) {
    const peak = await db
      .prepare(`
        SELECT COUNT(*) AS n FROM booking_slots
        WHERE court_id = ? AND date >= substr(datetime('now'), 1, 10)
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

  const deposit = changes.deposit ?? court.deposit;
  if (deposit < 0) return { ok: false, error: "A deposit cannot be negative." };
  if (deposit > MAX_DEPOSIT)
    return { ok: false, error: `A deposit cannot be more than RM${MAX_DEPOSIT}.` };
  // Dropping the deposit to nothing while kit is out would leave those holds
  // unsettleable, so let them come back first.
  if (deposit === 0 && court.deposit > 0 && await openHireCountForCourt(courtId) > 0)
    return { ok: false, error: "Some kit is still out on hire. Take it back in first." };

  const stored = await courtAccess(courtId);
  const codeGiven = changes.accessCode !== undefined;
  const newCode =
    changes.accessCode === undefined
      ? stored.code
      : changes.accessCode === null || changes.accessCode.trim() === ""
        ? null
        : changes.accessCode.trim();
  let unmanned = changes.unmanned ?? court.unmanned;
  // Clearing the code takes the door with it: an unmanned resource with
  // nothing to hand out is one nobody can get into. Asking for both in the
  // same call is a contradiction, and is refused below rather than resolved.
  if (newCode === null && changes.accessCode !== undefined && changes.unmanned === undefined)
    unmanned = false;

  if (newCode !== null) {
    if (newCode.length < MIN_ACCESS_CODE || newCode.length > MAX_ACCESS_CODE)
      return {
        ok: false,
        error: `A door code must be ${MIN_ACCESS_CODE}–${MAX_ACCESS_CODE} characters.`,
      };
    if (!/^[A-Za-z0-9#*-]+$/.test(newCode))
      return { ok: false, error: "A door code can only use letters, digits, #, * and -." };
  }
  if (unmanned && newCode === null)
    return { ok: false, error: "An unmanned resource needs a door code. Set one first." };
  // Drowning is silent and fast. This is the one refusal a venue cannot talk
  // its way past, however good the rest of its arrangements are.
  if (unmanned && NEVER_UNMANNED.includes(court.sport))
    return {
      ok: false,
      error: `${SPORT_LABELS[court.sport]} cannot be left unmanned — someone has to be watching the water.`,
    };
  // A deposit is a person looking at a hull. There is nobody to hand the
  // kayak to, nobody to look it over, and nobody to hold the money.
  if (unmanned && deposit > 0)
    return {
      ok: false,
      error: "Something hired out against a deposit needs someone at the counter, so it cannot be unmanned.",
    };

  const codeChanged = codeGiven && newCode !== stored.code;

  await db.transaction(async () => {
    await db.prepare(`
      UPDATE courts SET name = ?, off_peak_rate = ?, peak_rate = ?,
                        member_off_peak_rate = ?, member_peak_rate = ?, capacity = ?,
                        deposit = ?, unmanned = ?, access_code = ?
      WHERE id = ?
    `).run(
      changes.name?.trim() ?? court.name,
      offPeak,
      peak,
      memberOffPeak,
      memberPeak,
      changes.capacity ?? court.capacity,
      deposit,
      unmanned ? 1 : 0,
      newCode,
      courtId
    );
    // Only a genuine change restarts the clock, so re-saving the same code
    // cannot be used to make a stale door look fresh.
    if (codeChanged)
      await db.prepare("UPDATE courts SET access_code_changed_at = datetime('now') WHERE id = ?").run(
        courtId
      );
  })();
  return { ok: true, court: (await getCourt(courtId))! };
}

/** A day's bookings: everywhere, at one venue, or at several (a business's branches). */
export async function listBookingsForDate(date: string, venueId?: number | number[]): Promise<AdminBookingRow[]> {
  const db = getDb();
  const venue = venueCourts("b.court_id", venueId);
  const rows = await db
    .prepare(`
      SELECT b.*, c.name AS court_name, c.sport AS court_sport, c.deposit AS court_deposit,
             v.id AS venue_id, v.name AS venue_name, ci.checked_in_at, ci.checked_out_at
      FROM bookings b
      JOIN courts c ON c.id = b.court_id
      JOIN venues v ON v.id = c.venue_id
      LEFT JOIN check_ins ci ON ci.booking_id = b.id
      WHERE b.date = ?${venue.sql}
      ORDER BY v.id, c.id, b.start_hour
    `)
    .all(date, ...venue.params) as (BookingRow & {
    court_name: string;
    court_sport: Sport;
    court_deposit: number;
    venue_id: number;
    venue_name: string;
  })[];
  // One pass for the whole day rather than a lookup per row.
  const hires = new Map<number, HireRecord>();
  if (rows.length > 0) {
    const held = await db
      .prepare(`${HIRE_SELECT} WHERE h.booking_id IN (${rows.map(() => "?").join(",")})`)
      .all(...rows.map((r) => r.id)) as HireRow[];
    for (const row of held) hires.set(row.booking_id, toHire(row));
  }

  const list: AdminBookingRow[] = [];
  for (const r of rows) {
    const booking = toBooking(r);
    list.push({
      ...booking,
      courtName: r.court_name,
      sport: r.court_sport,
      venueId: r.venue_id,
      venueName: r.venue_name,
      // Exclude this booking so the count reads as history, not self-reference.
      priorNoShows: (await countNoShows(booking.phone)) - (booking.noShow ? 1 : 0),
      courtDeposit: r.court_deposit,
      hire: hires.get(booking.id) ?? null,
    });
  }
  return list;
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

export async function getClass(id: number): Promise<ClassSession | null> {
  const row = await getDb().prepare(`${CLASS_SELECT} WHERE cl.id = ?`).get(id) as ClassRow | undefined;
  return row ? toClass(row) : null;
}

/** Upcoming scheduled classes, soonest first. */
export async function listClasses(filter: {
  venueId?: number;
  /** Only these venues — a storefront's. */
  venueIds?: number[];
  sport?: Sport;
  from?: string;
  to?: string;
  includeCancelled?: boolean;
  /** Only at venues customers may reach: the public listing. */
  openOnly?: boolean;
} = {}): Promise<ClassSession[]> {
  const from = filter.from ?? todayISO();
  const clauses = ["cl.date >= ?"];
  if (filter.openOnly) clauses.push(OPEN_TO_CUSTOMERS);
  const params: (string | number)[] = [from];
  if (!filter.includeCancelled) clauses.push("cl.status = 'scheduled'");
  if (filter.venueId) {
    clauses.push("v.id = ?");
    params.push(filter.venueId);
  }
  if (filter.venueIds) {
    if (filter.venueIds.length === 0) return [];
    clauses.push(`v.id IN (${filter.venueIds.map(() => "?").join(",")})`);
    params.push(...filter.venueIds);
  }
  if (filter.sport) {
    clauses.push("c.sport = ?");
    params.push(filter.sport);
  }
  if (filter.to) {
    clauses.push("cl.date <= ?");
    params.push(filter.to);
  }

  const rows = await getDb()
    .prepare(`${CLASS_SELECT} WHERE ${clauses.join(" AND ")} ORDER BY cl.date, cl.start_hour, cl.id`)
    .all(...params) as ClassRow[];
  return rows.map(toClass);
}

export type CreateClassResult =
  | { ok: true; classes: ClassSession[]; seriesCode: string | null }
  | Refusal;

/**
 * Schedule a class, optionally repeating weekly for a term. The resource must
 * be free for those hours — a class cannot be laid over existing bookings.
 */
export async function createClassSessions(input: {
  courtId: number;
  name: string;
  instructor: string;
  date: string;
  startHour: number;
  endHour: number;
  capacity: number;
  price: number;
  weeks?: number;
}): Promise<CreateClassResult> {
  const { courtId, date, startHour, endHour } = input;
  const weeks = input.weeks ?? 1;

  const court = await getCourt(courtId);
  if (!court) return refuse("COURT_NOT_FOUND");
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > MAX_CLASS_WEEKS)
    return { ok: false, error: `Weeks must be between 1 and ${MAX_CLASS_WEEKS}.` };
  const { openHour, closeHour } = await courtVenueHours(courtId);
  if (startHour < openHour || endHour > closeHour || endHour <= startHour)
    return { ok: false, error: "Class hours are outside operating hours." };
  if (await getVenueClosure(court.venueId, date))
    return refuse("VENUE_CLOSED");
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
    const created = await db.transaction(async () => {
      const sessions: ClassSession[] = [];
      for (let week = 0; week < weeks; week++) {
        const weekDate = addDays(date, week * 7);
        if ((await taken.get(courtId, weekDate, ...hours) as { n: number }).n > 0)
          throw new Error(`BOOKED:${weekDate}`);
        const clashes = await classHoursOn(weekDate, court.venueId);
        if (hours.some((h) => clashes.has(`${courtId}:${h}`)))
          throw new Error(`CLASH:${weekDate}`);

        const id = (await insert.run(
          courtId, input.name.trim(), input.instructor.trim(), weekDate,
          startHour, endHour, input.capacity, input.price, seriesCode
        )).lastInsertRowid as number;
        sessions.push((await getClass(id))!);
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

export type EnrolResult = { ok: true; booking: Booking } | Refusal;

/** Take a place in a class. The enrolment is an ordinary booking. */
export async function enrolInClass(input: {
  classId: number;
  name: string;
  phone: string;
  email?: string;
  userId?: number;
}): Promise<EnrolResult> {
  return withTransaction(async () => {
    const session = await getClass(input.classId);
    if (!session) return refuse("CLASS_NOT_FOUND");
    if (session.status === "cancelled") return refuse("CLASS_CANCELLED");
    if (isPastSlot(session.date, session.startHour))
      return refuse("CLASS_STARTED");
    if (session.enrolled >= session.capacity)
      return refuse("CLASS_FULL");
    // The day may have been closed after the class was put in the diary.
    if (await getVenueClosure(session.venueId, session.date))
      return refuse("VENUE_CLOSED");

    const already = await getDb()
      .prepare(
        "SELECT id FROM bookings WHERE class_id = ? AND phone = ? AND status = 'confirmed'"
      )
      .get(session.id, input.phone.trim());
    if (already) return refuse("ALREADY_ENROLLED");

    const hours = Array.from(
      { length: session.endHour - session.startHour },
      (_, i) => session.startHour + i
    );
    const result = await createBookingSeries({
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
    await getDb()
      .prepare("UPDATE bookings SET total_price = ? WHERE id = ?")
      .run(session.price, result.bookings[0].id);
    return { ok: true, booking: { ...result.bookings[0], totalPrice: session.price } };
  });
}

/** Cancel a class and release every enrolment in it. */
export async function cancelClassSession(classId: number): Promise<{
  ok: boolean;
  released: number;
  error?: string;
}> {
  const session = await getClass(classId);
  if (!session) return { ok: false, released: 0, error: "Class not found." };
  if (session.status === "cancelled")
    return { ok: false, released: 0, error: "This class is already cancelled." };

  const db = getDb();
  const enrolments = await db
    .prepare("SELECT id FROM bookings WHERE class_id = ? AND status = 'confirmed'")
    .all(classId) as { id: number }[];

  await db.transaction(async () => {
    await db.prepare("UPDATE classes SET status = 'cancelled' WHERE id = ?").run(classId);
    for (const row of enrolments) {
      await db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(row.id);
      await db.prepare("DELETE FROM booking_slots WHERE booking_id = ?").run(row.id);
    }
  })();
  for (const row of enrolments) await refundBooking(row.id);
  return { ok: true, released: enrolments.length };
}

/** Who is coming to a class. */
export async function getClassRoster(classId: number): Promise<Booking[]> {
  const rows = await getDb()
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
  venue_id?: number | null;
  venue_name?: string | null;
}

const WALLET_SELECT = `
  SELECT w.id, w.amount, w.reason, w.booking_id, w.created_at, w.venue_id, v.name AS venue_name
  FROM wallet_entries w LEFT JOIN venues v ON v.id = w.venue_id
`;

function toWalletEntry(r: WalletRow): WalletEntry {
  return {
    id: r.id,
    amount: r.amount,
    reason: r.reason,
    bookingId: r.booking_id,
    createdAt: r.created_at,
    venueId: r.venue_id ?? null,
    venueName: r.venue_name ?? null,
  };
}

async function walletEntryById(id: number | bigint): Promise<WalletEntry> {
  return toWalletEntry(await getDb().prepare(`${WALLET_SELECT} WHERE w.id = ?`).get(id) as WalletRow);
}

/** Credit in one pot: a venue's (its business's), or (null) the one spendable anywhere. */
async function potBalance(userId: number, venueId: number | null): Promise<number> {
  const row = await getDb()
    .prepare(
      venueId === null
        ? "SELECT COALESCE(SUM(amount), 0) AS balance FROM wallet_entries WHERE user_id = ? AND venue_id IS NULL"
        : `SELECT COALESCE(SUM(amount), 0) AS balance FROM wallet_entries WHERE user_id = ? AND ${SAME_CREDIT}`
    )
    .get(...(venueId === null ? [userId] : [userId, venueId])) as { balance: number };
  return row.balance;
}

/**
 * What a customer can spend. Where credit is per venue and a venue is named,
 * that is the venue's own credit plus any spendable anywhere; otherwise all
 * of it.
 */
export async function getWalletBalance(userId: number, venueId?: number): Promise<number> {
  if (creditScope() === "venue" && venueId !== undefined)
    return await potBalance(userId, venueId) + await potBalance(userId, null);
  const row = await getDb()
    .prepare("SELECT COALESCE(SUM(amount), 0) AS balance FROM wallet_entries WHERE user_id = ?")
    .get(userId) as { balance: number };
  return row.balance;
}

/** A customer's credit, pot by pot — one line per venue it can be spent at. */
export async function walletBalances(userId: number): Promise<WalletBalance[]> {
  return (
    await getDb()
      .prepare(`
        SELECT MIN(w.venue_id) AS "venueId", MIN(COALESCE(b.name, v.name)) AS "venueName", SUM(w.amount) AS balance
          FROM wallet_entries w
          LEFT JOIN venues v ON v.id = w.venue_id
          LEFT JOIN businesses b ON b.id = v.business_id
         WHERE w.user_id = ?
         -- One pot per business, or per venue on its own, or the one spendable anywhere.
         GROUP BY CASE WHEN w.venue_id IS NULL THEN NULL
                       WHEN v.business_id IS NOT NULL THEN 'b' || v.business_id
                       ELSE 'v' || w.venue_id END
        HAVING SUM(w.amount) <> 0
         ORDER BY MIN(w.venue_id) IS NOT NULL, MIN(COALESCE(b.name, v.name))
      `)
      .all(userId) as WalletBalance[]
  );
}

/** Most recent movements first. */
export async function listWalletEntries(userId: number, limit = 50): Promise<WalletEntry[]> {
  const rows = await getDb()
    .prepare(`${WALLET_SELECT} WHERE w.user_id = ? ORDER BY w.id DESC LIMIT ?`)
    .all(userId, Math.min(Math.max(limit, 1), 200)) as WalletRow[];
  return rows.map(toWalletEntry);
}

export type WalletResult =
  | { ok: true; balance: number; entry: WalletEntry }
  | Refusal;

/**
 * Record credit bought at the counter. Where credit is per venue, it is the
 * credit of the venue that sold it, and `venueId` says which.
 */
export async function topUpWallet(input: {
  userId: number;
  amount: number;
  adminId: number;
  reason?: string;
  venueId?: number;
}): Promise<WalletResult> {
  return withTransaction(async () => {
    if (!Number.isInteger(input.amount) || input.amount < 1 || input.amount > MAX_TOP_UP)
      return { ok: false, error: `Top-up must be RM1–${MAX_TOP_UP}.` };
    const db = getDb();
    const user = await db.prepare("SELECT id FROM users WHERE id = ?").get(input.userId);
    if (!user) return { ok: false, error: "Customer not found." };
    const perVenue = creditScope() === "venue";
    if (perVenue && (input.venueId === undefined || !await getVenue(input.venueId)))
      return { ok: false, error: "Credit belongs to a venue here: say which one sold it." };

    const info = await db
      .prepare(
        "INSERT INTO wallet_entries (user_id, amount, reason, admin_id, venue_id) VALUES (?, ?, ?, ?, ?)"
      )
      .run(
        input.userId,
        input.amount,
        input.reason?.trim() || "Counter top-up",
        input.adminId,
        perVenue ? input.venueId! : null
      );
    return {
      ok: true,
      balance: await getWalletBalance(input.userId, perVenue ? input.venueId : undefined),
      entry: await walletEntryById(info.lastInsertRowid!),
    };
  });
}

/**
 * Settle a booking from its owner's stored credit. Balance is re-read inside
 * the transaction so two concurrent payments cannot overdraw it.
 */
/**
 * Mark a booking paid, and say whether this call is the one that did it.
 *
 * Every payment path checks "is it already paid?" before opening its
 * transaction. Two requests can both make that check before either writes —
 * every query is a point where another request can run — and the customer
 * would be charged twice for one hour, once from a wallet and once from a
 * pass. The database decides instead: exactly one UPDATE can move a booking
 * out of 'unpaid', everybody else gets no rows and throws, rolling their own
 * ledger entry back with them. The same shape promo codes already get from
 * their UNIQUE constraint.
 */
export async function claimPayment(bookingId: number): Promise<boolean> {
  return (
    (await getDb()
      .prepare(
        "UPDATE bookings SET payment_status = 'paid', paid_at = datetime('now') WHERE id = ? AND payment_status = 'unpaid'"
      )
      .run(bookingId)).changes === 1
  );
}

export async function payBookingFromWallet(bookingId: number): Promise<WalletResult> {
  const db = getDb();
  const row = await db
    .prepare(
      "SELECT b.*, ci.checked_in_at, ci.checked_out_at FROM bookings b LEFT JOIN check_ins ci ON ci.booking_id = b.id WHERE b.id = ?"
    )
    .get(bookingId) as BookingRow | undefined;
  if (!row) return refuse("BOOKING_NOT_FOUND");
  const booking = toBooking(row);

  if (!row.user_id) return refuse("NO_ACCOUNT_TO_CHARGE");
  if (booking.status === "cancelled") return refuse("BOOKING_WAS_CANCELLED");
  if (booking.paymentStatus === "paid") return refuse("ALREADY_PAID");

  const userId = row.user_id;
  // Where credit is per venue, a booking is paid from this venue's credit
  // first and then from any spendable anywhere — a line for each, so a refund
  // puts each part back where it came from.
  const venueId = creditScope() === "venue" ? (await getCourt(booking.courtId))?.venueId : undefined;
  try {
    const entryId = await db.transaction(async () => {
      const price = booking.totalPrice;
      if (await getWalletBalance(userId, venueId) < price) throw new Error("INSUFFICIENT");
      const charge = db.prepare(
        "INSERT INTO wallet_entries (user_id, amount, reason, booking_id, venue_id) VALUES (?, ?, ?, ?, ?)"
      );
      const reason = `Booking ${booking.code}`;
      let first: number | bigint | null = null;
      if (venueId === undefined) {
        first = (await charge.run(userId, -price, reason, booking.id, null)).lastInsertRowid;
      } else {
        const fromVenue = Math.min(Math.max(await potBalance(userId, venueId), 0), price);
        if (fromVenue > 0)
          first = (await charge.run(userId, -fromVenue, reason, booking.id, venueId)).lastInsertRowid;
        if (price - fromVenue > 0) {
          const id = (await charge.run(userId, -(price - fromVenue), reason, booking.id, null)).lastInsertRowid;
          first ??= id;
        }
      }
      if (!await claimPayment(booking.id)) throw new Error("RACED");
      return first!;
    })();

    return {
      ok: true,
      balance: await getWalletBalance(userId, venueId),
      entry: await walletEntryById(entryId),
    };
  } catch (err) {
    if (err instanceof Error && err.message === "INSUFFICIENT")
      return refuse("NOT_ENOUGH_CREDIT");
    if (err instanceof Error && err.message === "RACED") return refuse("ALREADY_PAID");
    throw err;
  }
}

/** What this booking took from stored credit, line by line — one per pot. */
async function walletChargesFor(
  bookingId: number
): Promise<{ user_id: number; amount: number; venue_id: number | null }[]> {
  return await getDb()
    .prepare(
      "SELECT user_id, amount, venue_id FROM wallet_entries WHERE booking_id = ? AND amount < 0 ORDER BY id"
    )
    .all(bookingId) as { user_id: number; amount: number; venue_id: number | null }[];
}

/**
 * Put a wallet-paid booking's money back when it is cancelled. Refunding twice
 * is refused, so a double cancellation cannot mint credit.
 */
export async function refundBookingToWallet(bookingId: number): Promise<WalletResult> {
  const charges = await walletChargesFor(bookingId);
  if (charges.length === 0) return { ok: false, error: "This booking was not paid from credit." };

  const db = getDb();
  const refunded = await db
    .prepare("SELECT id FROM wallet_entries WHERE booking_id = ? AND amount > 0")
    .get(bookingId);
  if (refunded) return { ok: false, error: "This booking has already been refunded." };

  const code = (await db.prepare("SELECT code FROM bookings WHERE id = ?").get(bookingId) as
    | { code: string }
    | undefined)?.code;
  const put = db.prepare(
    "INSERT INTO wallet_entries (user_id, amount, reason, booking_id, venue_id) VALUES (?, ?, ?, ?, ?)"
  );
  const ids = await db.transaction(async () => {
    const made: number[] = [];
    for (const c of charges)
      made.push(
        (await put.run(c.user_id, -c.amount, `Refund for ${code ?? "booking"}`, bookingId, c.venue_id))
          .lastInsertRowid as number
      );
    return made;
  })();

  const venueId = charges.find((c) => c.venue_id !== null)?.venue_id ?? undefined;
  return {
    ok: true,
    balance: await getWalletBalance(charges[0].user_id, venueId),
    entry: await walletEntryById(ids[0]),
  };
}

/**
 * Undo whatever a cancelled booking was settled with. A booking is paid from
 * credit or with a pass, never both, so each call is a no-op for the other.
 */
async function refundBooking(bookingId: number): Promise<void> {
  await refundBookingToWallet(bookingId);
  await refundBookingToPass(bookingId);
  await noteOnlineRefundDue(bookingId);
  // The customer never had the benefit, so a limited code is not poorer for it.
  await releasePromoUse(bookingId);
}

/**
 * A booking paid online and then cancelled has money sitting in the venue's
 * gateway account that is not the venue's to keep. Nothing here can send it
 * back — a refund is made in the gateway — so the amount is written against
 * the payment, and the venue is shown what it owes until staff say it is done.
 */
async function noteOnlineRefundDue(bookingId: number): Promise<void> {
  await getDb()
    .prepare(`
      UPDATE online_payments
         SET refund_due = refund_due + (SELECT total_price FROM bookings WHERE id = ?)
       WHERE status = 'paid'
         AND id IN (SELECT payment_id FROM online_payment_bookings WHERE booking_id = ?)
         AND EXISTS (SELECT 1 FROM bookings WHERE id = ? AND paid_via = 'online')
    `)
    .run(bookingId, bookingId, bookingId);
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
 * A membership of one branch is a membership of every branch of the same
 * business: the member pays each branch's member rate, wherever they play.
 *
 * Membership is held against the phone number, not an account, so someone who
 * booked as a guest still gets their rate. The date checked is the booking's,
 * not today's: a membership that lapses before the session does not discount it.
 */
export async function activeMembership(
  venueId: number,
  phone: string,
  onDate?: string
): Promise<Membership | null> {
  const digits = normalisePhone(phone);
  if (digits.length < 6) return null;
  const date = onDate ?? todayISO();
  const rows = await getDb()
    .prepare(`${MEMBERSHIP_SELECT} WHERE ${inSameBusiness("m.venue_id")} AND m.status = 'active'`)
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
/** What this account holds. Keyed on the account, for the reason above. */
export async function listMembershipsFor(userId: number): Promise<Membership[]> {
  const rows = await getDb()
    .prepare(`${MEMBERSHIP_SELECT} WHERE m.user_id = ? ORDER BY m.id DESC`)
    .all(userId) as MembershipRow[];
  return rows.map(toMembership);
}

export async function listMembershipsForVenue(venueId: number, limit = 200): Promise<Membership[]> {
  const rows = await getDb()
    .prepare(`${MEMBERSHIP_SELECT} WHERE m.venue_id = ? ORDER BY m.id DESC LIMIT ?`)
    .all(venueId, Math.min(Math.max(limit, 1), 500)) as MembershipRow[];
  return rows.map(toMembership);
}

export async function membershipById(id: number): Promise<Membership | null> {
  const row = await getDb().prepare(`${MEMBERSHIP_SELECT} WHERE m.id = ?`).get(id) as
    | MembershipRow
    | undefined;
  return row ? toMembership(row) : null;
}

export type MembershipResult =
  | { ok: true; membership: Membership }
  | Refusal;

/** Sell a membership at the counter. */
export async function sellMembership(input: {
  venueId: number;
  holderName: string;
  holderPhone: string;
  startsOn: string;
  expiresOn: string;
  price: number;
  adminId: number;
  userId?: number;
}): Promise<MembershipResult> {
  return withTransaction(async () => {
    const db = getDb();
    if (!await db.prepare("SELECT id FROM venues WHERE id = ?").get(input.venueId))
      return refuse("VENUE_NOT_FOUND");

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

    // Overlapping memberships would make "which rate?" ambiguous — at one
    // venue, or anywhere in its business, where one membership covers all.
    const clash = (
      await db
        .prepare(`${MEMBERSHIP_SELECT} WHERE ${inSameBusiness("m.venue_id")} AND m.status = 'active'`)
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
        error:
          clash.venue_id === input.venueId
            ? `That number already has a membership here until ${clash.expires_on}.`
            : `That number already has a membership at ${clash.venue_name}, which covers this venue too, until ${clash.expires_on}.`,
      };

    const info = await db
      .prepare(`
        INSERT INTO memberships (code, venue_id, holder_name, holder_phone, user_id,
                                 starts_on, expires_on, price, admin_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        randomCode("MB-"), input.venueId, holderName, holderPhone, input.userId ?? null,
        input.startsOn, input.expiresOn, input.price, input.adminId
      );
    return { ok: true, membership: (await membershipById(Number(info.lastInsertRowid)))! };
  });
}

/** Cancel a membership. Bookings already made keep the price they were given. */
export async function voidMembership(id: number): Promise<MembershipResult> {
  return withTransaction(async () => {
    const m = await membershipById(id);
    if (!m) return { ok: false, error: "Membership not found." };
    if (m.status === "void") return { ok: false, error: "This membership is already cancelled." };
    await getDb().prepare("UPDATE memberships SET status = 'void' WHERE id = ?").run(id);
    return { ok: true, membership: (await membershipById(id))! };
  });
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

export async function getPromoCode(venueId: number, code: string): Promise<PromoCode | null> {
  const row = await getDb()
    .prepare(`${PROMO_SELECT} WHERE p.venue_id = ? AND UPPER(p.code) = UPPER(?)`)
    .get(venueId, code.trim()) as PromoRow | undefined;
  return row ? toPromo(row) : null;
}

export async function listPromoCodes(venueId: number): Promise<PromoCode[]> {
  const rows = await getDb()
    .prepare(`${PROMO_SELECT} WHERE p.venue_id = ? ORDER BY p.id DESC`)
    .all(venueId) as PromoRow[];
  return rows.map(toPromo);
}

export type PromoEditResult = { ok: true; promo: PromoCode } | Refusal;

export async function createPromoCode(input: {
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
}): Promise<PromoEditResult> {
  return withTransaction(async () => {
    const db = getDb();
    if (!await db.prepare("SELECT id FROM venues WHERE id = ?").get(input.venueId))
      return refuse("VENUE_NOT_FOUND");

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
      return refuse("UNKNOWN_SPORT");
    if (input.sport) {
      const has = await db
        .prepare("SELECT 1 FROM courts WHERE venue_id = ? AND sport = ? LIMIT 1")
        .get(input.venueId, input.sport);
      if (!has) return { ok: false, error: "That venue has no courts for that sport." };
    }
    if (await getPromoCode(input.venueId, code))
      return { ok: false, error: `${code} already exists at this venue.` };

    const info = await db
      .prepare(`
        INSERT INTO promo_codes (code, venue_id, sport, description, kind, value,
                                 min_hours, valid_from, valid_to, max_uses, admin_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        code, input.venueId, input.sport ?? null, input.description.trim(), input.kind,
        input.value, minHours, input.validFrom, input.validTo, input.maxUses ?? null, input.adminId
      );
    return { ok: true, promo: (await promoById(Number(info.lastInsertRowid)))! };
  });
}

export async function promoById(id: number): Promise<PromoCode | null> {
  const row = await getDb().prepare(`${PROMO_SELECT} WHERE p.id = ?`).get(id) as PromoRow | undefined;
  return row ? toPromo(row) : null;
}

/** Withdraw a code. Discounts already given stand. */
export async function voidPromoCode(id: number): Promise<PromoEditResult> {
  return withTransaction(async () => {
    const promo = await promoById(id);
    if (!promo) return { ok: false, error: "Code not found." };
    if (promo.status === "void") return { ok: false, error: "This code is already withdrawn." };
    await getDb().prepare("UPDATE promo_codes SET status = 'void' WHERE id = ?").run(id);
    return { ok: true, promo: (await promoById(id))! };
  });
}

export type PromoQuote =
  | { ok: true; promo: PromoCode; discount: number }
  | Refusal;

/**
 * What a code would take off this particular booking, without claiming it.
 * The quote is advisory: the use count is only binding inside applyPromo().
 */
export async function quotePromo(input: {
  venueId: number;
  code: string;
  sport: Sport;
  date: string;
  hours: number;
  price: number;
}): Promise<PromoQuote> {
  const promo = await getPromoCode(input.venueId, input.code);
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
  | Refusal;

/**
 * Claim a code against a booking: record the use and reduce what is owed.
 *
 * The use count is re-counted inside the transaction, so two customers
 * cannot both take the last use of a limited code. The booking's own
 * total_price is what changes, so everything downstream — paying from credit
 * or a pass, and the day's takings — sees the discounted figure without
 * knowing promo codes exist.
 */
export async function applyPromo(bookingId: number, code: string): Promise<PromoApplyResult> {
  const db = getDb();
  const row = await db
    .prepare(
      "SELECT b.*, ci.checked_in_at, ci.checked_out_at FROM bookings b LEFT JOIN check_ins ci ON ci.booking_id = b.id WHERE b.id = ?"
    )
    .get(bookingId) as BookingRow | undefined;
  if (!row) return refuse("BOOKING_NOT_FOUND");
  const booking = toBooking(row);
  if (booking.status === "cancelled") return refuse("BOOKING_WAS_CANCELLED");
  if (booking.paymentStatus === "paid")
    return refuse("PROMO_TOO_LATE");

  const court = await getCourt(booking.courtId);
  if (!court) return refuse("COURT_NOT_FOUND");

  const quote = await quotePromo({
    venueId: court.venueId,
    code,
    sport: court.sport,
    date: booking.date,
    hours: booking.endHour - booking.startHour,
    price: booking.totalPrice,
  });
  if (!quote.ok) return quote;

  try {
    await db.transaction(async () => {
      const fresh = (await promoById(quote.promo.id))!;
      const blocked = promoBlockedReason(fresh);
      if (blocked) throw new Error(`BLOCKED:${blocked}`);
      // Re-derive against the live price, not the quoted one.
      const discount = promoDiscount(fresh, booking.totalPrice);
      if (discount <= 0) throw new Error("BLOCKED:This code takes nothing off that price.");
      await db.prepare(
        "INSERT INTO promo_uses (promo_id, booking_id, discount) VALUES (?, ?, ?)"
      ).run(fresh.id, booking.id, discount);
      await db.prepare("UPDATE bookings SET total_price = total_price - ? WHERE id = ?")
        .run(discount, booking.id);
    })();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("BLOCKED:"))
      return { ok: false, error: err.message.slice("BLOCKED:".length) };
    if (isUniqueViolation(err, "promo_uses"))
      return refuse("PROMO_ALREADY_USED");
    throw err;
  }

  const use = await db
    .prepare("SELECT discount FROM promo_uses WHERE booking_id = ?")
    .get(booking.id) as { discount: number };
  return {
    ok: true,
    discount: use.discount,
    newTotal: booking.totalPrice - use.discount,
    promo: (await promoById(quote.promo.id))!,
  };
}

/**
 * Give a cancelled booking's use of a code back. The customer never had the
 * benefit, so a limited code should not be poorer for it.
 */
async function releasePromoUse(bookingId: number): Promise<void> {
  await getDb().prepare("DELETE FROM promo_uses WHERE booking_id = ?").run(bookingId);
}

/** The code used on a booking, for showing it back to staff and customers. */
export async function promoUseFor(bookingId: number): Promise<{ code: string; discount: number } | null> {
  const row = await getDb()
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

export async function getPass(code: string): Promise<Pass | null> {
  const row = await getDb()
    .prepare(`${PASS_SELECT} WHERE UPPER(p.code) = UPPER(?)`)
    .get(code.trim()) as PassRow | undefined;
  return row ? toPass(row) : null;
}

/**
 * Every pass held by a phone number (and account, when signed in), newest
 * first. Spent and expired passes are kept so the holder can see the history.
 */
/**
 * What this account holds.
 *
 * Keyed on the account and nothing else. A phone number looks like a handle
 * for this — it is what a pass is sold against at a counter — but nothing
 * verifies the number somebody types when they register, so matching on it
 * hands whoever typed it first everything bought against it, and a pass code
 * is bearer money. The counter links a pass to an account by choosing it in
 * front of the customer, which is the only place anybody checks who they are.
 */
export async function listPassesFor(userId: number): Promise<Pass[]> {
  const rows = await getDb()
    .prepare(`${PASS_SELECT} WHERE p.user_id = ? ORDER BY p.id DESC`)
    .all(userId) as PassRow[];
  return rows.map(toPass);
}

/** Passes issued by one venue, newest first — the counter's list. */
export async function listPassesForVenue(venueId: number, limit = 100): Promise<Pass[]> {
  const rows = await getDb()
    .prepare(`${PASS_SELECT} WHERE p.venue_id = ? ORDER BY p.id DESC LIMIT ?`)
    .all(venueId, Math.min(Math.max(limit, 1), 500)) as PassRow[];
  return rows.map(toPass);
}

export async function listPassEntries(passId: number, limit = 50): Promise<PassEntry[]> {
  const rows = await getDb()
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

export type PassResult = { ok: true; pass: Pass } | Refusal;

/** Sell a pass at the counter. */
export async function issuePass(input: {
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
}): Promise<PassResult> {
  return withTransaction(async () => {
    const db = getDb();
    const venue = await db.prepare("SELECT id FROM venues WHERE id = ?").get(input.venueId);
    if (!venue) return refuse("VENUE_NOT_FOUND");

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
      return refuse("UNKNOWN_SPORT");
    // A sport-locked pass is pointless if the venue has no such courts.
    if (input.sport) {
      const has = await db
        .prepare("SELECT 1 FROM courts WHERE venue_id = ? AND sport = ? LIMIT 1")
        .get(input.venueId, input.sport);
      if (!has) return { ok: false, error: "That venue has no courts for that sport." };
    }

    const info = await db
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
    return { ok: true, pass: (await passById(Number(info.lastInsertRowid)))! };
  });
}

export async function getPassById(id: number): Promise<Pass | null> {
  return await passById(id);
}

async function passById(id: number): Promise<Pass | null> {
  const row = await getDb().prepare(`${PASS_SELECT} WHERE p.id = ?`).get(id) as PassRow | undefined;
  return row ? toPass(row) : null;
}

/** Cancel a pass. Entries already spent stay spent; the rest become unusable. */
export async function voidPass(passId: number): Promise<PassResult> {
  return withTransaction(async () => {
    const db = getDb();
    const pass = await passById(passId);
    if (!pass) return refuse("PASS_NOT_FOUND");
    if (pass.status === "void") return { ok: false, error: "This pass is already cancelled." };
    await db.prepare("UPDATE passes SET status = 'void' WHERE id = ?").run(passId);
    return { ok: true, pass: (await passById(passId))! };
  });
}

/**
 * Can this pass pay for this booking? Checks scope and standing but not the
 * entry count, which is only safe to read inside the paying transaction.
 */
async function passScopeError(pass: Pass, booking: Booking): Promise<string | null> {
  const court = await getCourt(booking.courtId);
  if (!court) return "Court not found.";
  if (court.venueId !== pass.venueId && !(await sameBusiness(court.venueId, pass.venueId)))
    return "That pass is for a different venue.";
  if (pass.sport && court.sport !== pass.sport)
    return `That pass only covers ${SPORT_LABELS[pass.sport]}.`;
  return null;
}

export type PassPayResult =
  | { ok: true; pass: Pass; spent: number }
  | Refusal;

/**
 * Settle a booking with a pass: one entry per booked hour, all or nothing.
 * The remaining count is re-read inside the transaction so two concurrent
 * bookings cannot spend the same entry.
 */
export async function payBookingWithPass(bookingId: number, passCode: string): Promise<PassPayResult> {
  const db = getDb();
  const row = await db
    .prepare(
      "SELECT b.*, ci.checked_in_at, ci.checked_out_at FROM bookings b LEFT JOIN check_ins ci ON ci.booking_id = b.id WHERE b.id = ?"
    )
    .get(bookingId) as BookingRow | undefined;
  if (!row) return refuse("BOOKING_NOT_FOUND");
  const booking = toBooking(row);
  if (booking.status === "cancelled") return refuse("BOOKING_WAS_CANCELLED");
  if (booking.paymentStatus === "paid") return refuse("ALREADY_PAID");

  const pass = await getPass(passCode);
  if (!pass) return refuse("PASS_NOT_FOUND");
  const scope = await passScopeError(pass, booking);
  if (scope) return { ok: false, error: scope };

  // A pass is the holder's to spend, so it has to be their booking.
  if (normalisePhone(pass.holderPhone) !== normalisePhone(booking.phone))
    return refuse("PASS_WRONG_PHONE");

  const hours = booking.endHour - booking.startHour;

  try {
    await db.transaction(async () => {
      const fresh = (await passById(pass.id))!;
      const blocked = passBlockedReason(fresh);
      if (blocked) throw new Error(`BLOCKED:${blocked}`);
      if (fresh.remaining < hours)
        throw new Error(
          `BLOCKED:This pass has ${fresh.remaining} ${fresh.remaining === 1 ? "entry" : "entries"} left, and this booking needs ${hours}.`
        );
      await db.prepare(
        "INSERT INTO pass_entries (pass_id, delta, reason, booking_id) VALUES (?, ?, ?, ?)"
      ).run(pass.id, -hours, `Booking ${booking.code}`, booking.id);
      if (!await claimPayment(booking.id)) throw new Error("RACED");
    })();
  } catch (err) {
    if (err instanceof Error && err.message === "RACED") return refuse("ALREADY_PAID");
    if (err instanceof Error && err.message.startsWith("BLOCKED:"))
      return { ok: false, error: err.message.slice("BLOCKED:".length) };
    throw err;
  }

  return { ok: true, pass: (await passById(pass.id))!, spent: hours };
}

/**
 * Phone numbers are typed loosely, so compare only the digits — and treat the
 * international and national forms of a Malaysian number as the same one,
 * since "+60 12-345 6789" and "012-345 6789" are the same phone. No national
 * prefix starts 60, so stripping it is unambiguous.
 */
/** Empty is the same as unset for optional text a venue types in. */
function nullIfBlank(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

function normalisePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.startsWith("60") && digits.length >= 10 ? `0${digits.slice(2)}` : digits;
}

/**
 * Give a cancelled booking's entries back. Refunding twice is refused, so a
 * double cancellation cannot mint entries. An expired pass is still credited —
 * the ledger stays honest, even if the entries can no longer be spent.
 */
export async function refundBookingToPass(bookingId: number): Promise<PassPayResult> {
  return withTransaction(async () => {
    const db = getDb();
    const charge = await db
      .prepare(
        "SELECT pass_id, delta FROM pass_entries WHERE booking_id = ? AND delta < 0 ORDER BY id LIMIT 1"
      )
      .get(bookingId) as { pass_id: number; delta: number } | undefined;
    if (!charge) return { ok: false, error: "This booking was not paid with a pass." };

    const refunded = await db
      .prepare("SELECT id FROM pass_entries WHERE booking_id = ? AND delta > 0")
      .get(bookingId);
    if (refunded) return { ok: false, error: "This booking has already been refunded." };

    const code = (await db.prepare("SELECT code FROM bookings WHERE id = ?").get(bookingId) as
      | { code: string }
      | undefined)?.code;
    await db.prepare("INSERT INTO pass_entries (pass_id, delta, reason, booking_id) VALUES (?, ?, ?, ?)")
      .run(charge.pass_id, -charge.delta, `Refund for ${code ?? "booking"}`, bookingId);

    return { ok: true, pass: (await passById(charge.pass_id))!, spent: charge.delta };
  });
}

/** Find a customer by email or phone, for the counter. */
export async function findUserForWallet(
  query: string,
  venueId?: number
): Promise<{ id: number; name: string; email: string; phone: string; balance: number } | null> {
  const trimmed = query.trim();
  if (trimmed === "") return null;
  const row = await getDb()
    .prepare("SELECT id, name, email, phone FROM users WHERE email = ? OR phone = ?")
    .get(trimmed, trimmed) as
    | { id: number; name: string; email: string; phone: string }
    | undefined;
  return row ? { ...row, balance: await getWalletBalance(row.id, venueId) } : null;
}

/**
 * The account behind an email address, for the counter to link a sale to.
 *
 * Email rather than phone: an account is keyed on it, exactly one account can
 * hold it, and staff are looking at the person who just said it. A phone
 * number is none of those things — see `listPassesFor`.
 */
export async function findAccountByEmail(
  email: string
): Promise<{ id: number; name: string; email: string } | null> {
  const trimmed = email.trim();
  if (trimmed === "") return null;
  return (
    (await getDb()
      .prepare("SELECT id, name, email FROM users WHERE email = ?")
      .get(trimmed) as { id: number; name: string; email: string } | undefined) ?? null
  );
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
  locale: string;
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
    locale: r.locale,
    createdAt: r.created_at,
  };
  if (r.status === "offered" && r.offered_at) {
    const deadline = parseUtc(r.offered_at) + WAITLIST_OFFER_MINUTES * 60_000;
    entry.expiresInSeconds = Math.max(0, Math.round((deadline - Date.now()) / 1000));
  }
  return entry;
}

/** datetime('now') is UTC without a zone marker. */
function parseUtc(stamp: string): number {
  return new Date(stamp.includes("Z") ? stamp : `${stamp.replace(" ", "T")}Z`).getTime();
}

/**
 * Time out offers nobody claimed. There is no scheduler, so this runs at the
 * start of every waitlist operation — the queue is only ever read through one
 * of these, so a stale offer never blocks the next person for long.
 */
async function expireStaleOffers(): Promise<void> {
  const db = getDb();
  const rows = await db
    .prepare("SELECT id, offered_at FROM waitlist WHERE status = 'offered'")
    .all() as { id: number; offered_at: string | null }[];
  const now = Date.now();
  for (const row of rows) {
    if (!row.offered_at) continue;
    if (parseUtc(row.offered_at) + WAITLIST_OFFER_MINUTES * 60_000 <= now) {
      await db.prepare(
        "UPDATE waitlist SET status = 'expired', offer_token = NULL WHERE id = ?"
      ).run(row.id);
    }
  }
}

export type WaitlistResult =
  | { ok: true; entry: WaitlistEntry; position: number }
  | Refusal;

/** Queue for a class place. Only possible while the class is actually full. */
export async function joinClassWaitlist(input: {
  classId: number;
  name: string;
  phone: string;
  /** The language to make the offer in, when one comes. */
  locale?: string;
  email?: string;
  userId?: number;
}): Promise<WaitlistResult> {
  return withTransaction(async () => {
    await expireStaleOffers();
    const session = await getClass(input.classId);
    if (!session) return refuse("CLASS_NOT_FOUND");
    if (session.status === "cancelled") return refuse("CLASS_CANCELLED");
    if (isPastSlot(session.date, session.startHour))
      return refuse("CLASS_STARTED");
    if (session.enrolled < session.capacity)
      return refuse("CLASS_HAS_PLACES");

    const db = getDb();
    const already = await db
      .prepare(
        "SELECT id FROM waitlist WHERE class_id = ? AND phone = ? AND status IN ('waiting','offered')"
      )
      .get(input.classId, input.phone.trim());
    if (already) return refuse("ALREADY_WAITING");
    const enrolled = await db
      .prepare("SELECT id FROM bookings WHERE class_id = ? AND phone = ? AND status = 'confirmed'")
      .get(input.classId, input.phone.trim());
    if (enrolled) return refuse("ALREADY_ENROLLED");

    const info = await db
      .prepare(
        "INSERT INTO waitlist (class_id, name, phone, email, user_id, locale) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(
        input.classId,
        input.name.trim(),
        input.phone.trim(),
        input.email?.trim() ?? null,
        input.userId ?? null,
        input.locale ?? "en"
      );
    const entry = toWaitlistEntry(
      await db.prepare("SELECT * FROM waitlist WHERE id = ?").get(info.lastInsertRowid) as WaitlistRow
    );
    return { ok: true, entry, position: (await classQueue(input.classId)).length };
  });
}

async function classQueue(classId: number): Promise<WaitlistRow[]> {
  return await getDb()
    .prepare(
      "SELECT * FROM waitlist WHERE class_id = ? AND status IN ('waiting','offered') ORDER BY id"
    )
    .all(classId) as WaitlistRow[];
}

/**
 * A place in a class opened up: offer it to the person who has waited longest.
 * Does nothing if someone already holds a live offer for it.
 */
export async function offerClassPlace(classId: number): Promise<WaitlistEntry | null> {
  return withTransaction(async () => {
    await expireStaleOffers();
    const queue = await classQueue(classId);
    if (queue.some((row) => row.status === "offered")) return null;

    const session = await getClass(classId);
    if (!session || session.status === "cancelled") return null;
    if (session.enrolled >= session.capacity) return null;

    const next = queue.find((row) => row.status === "waiting");
    if (!next) return null;

    const db = getDb();
    await db.prepare(
      "UPDATE waitlist SET status = 'offered', offered_at = datetime('now'), offer_token = ? WHERE id = ?"
    ).run(randomBytes(16).toString("hex"), next.id);
    return toWaitlistEntry(
      await db.prepare("SELECT * FROM waitlist WHERE id = ?").get(next.id) as WaitlistRow,
      true
    );
  });
}

export type ClaimResult =
  | { ok: true; booking: Booking; entry: WaitlistEntry }
  | Refusal;

/** Take up an offered place. The offer token is the only way in. */
export async function claimWaitlistOffer(token: string): Promise<ClaimResult> {
  return withTransaction(async () => {
    await expireStaleOffers();
    const db = getDb();
    const row = await db
      .prepare("SELECT * FROM waitlist WHERE offer_token = ?")
      .get(token.trim()) as WaitlistRow | undefined;
    if (!row) return refuse("OFFER_INVALID");
    if (row.status !== "offered")
      return refuse("OFFER_EXPIRED");

    let booking: Booking;
    if (row.class_id) {
      const enrolled = await enrolInClass({
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
      const created = await createBooking({
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
        await db.prepare(
          "UPDATE waitlist SET status = 'waiting', offered_at = NULL, offer_token = NULL WHERE id = ?"
        ).run(row.id);
        return { ok: false, error: created.error };
      }
      booking = created.booking;
    } else {
      return refuse("OFFER_INVALID");
    }

    await db.prepare("UPDATE waitlist SET status = 'claimed', offer_token = NULL WHERE id = ?").run(row.id);
    return {
      ok: true,
      booking,
      entry: toWaitlistEntry(
        await db.prepare("SELECT * FROM waitlist WHERE id = ?").get(row.id) as WaitlistRow
      ),
    };
  });
}

/** Give up a place in the queue. */
export async function leaveWaitlist(entryId: number, phone: string): Promise<{ ok: true } | Refusal> {
  return withTransaction(async () => {
    const db = getDb();
    const row = await db
      .prepare("SELECT * FROM waitlist WHERE id = ? AND phone = ?")
      .get(entryId, phone.trim()) as WaitlistRow | undefined;
    if (!row) return refuse("WAITLIST_NOT_FOUND");
    if (row.status === "claimed") return refuse("PLACE_ALREADY_CLAIMED");

    await db.prepare("UPDATE waitlist SET status = 'cancelled', offer_token = NULL WHERE id = ?").run(row.id);
    // Someone dropping out may free a live offer for the next person.
    if (row.class_id) await offerClassPlace(row.class_id);
    else if (row.court_id && row.date) await offerSlotPlace(row.court_id, row.date);
    return { ok: true };
  });
}

/** The queue for a class, for staff. */
export async function listClassWaitlist(classId: number): Promise<WaitlistEntry[]> {
  await expireStaleOffers();
  const rows = await getDb()
    .prepare(
      "SELECT * FROM waitlist WHERE class_id = ? AND status IN ('waiting','offered') ORDER BY id"
    )
    .all(classId) as WaitlistRow[];
  return rows.map((r) => toWaitlistEntry(r));
}

/** What this person is queuing for, with any live offer's token. */
export async function listWaitlistFor(phone: string): Promise<WaitlistEntry[]> {
  await expireStaleOffers();
  const rows = await getDb()
    .prepare(
      "SELECT * FROM waitlist WHERE phone = ? AND status IN ('waiting','offered') ORDER BY id DESC"
    )
    .all(phone.trim()) as WaitlistRow[];
  const entries: WaitlistEntry[] = [];
  for (const row of rows) {
    const entry = toWaitlistEntry(row, row.status === "offered");
    if (row.class_id) {
      const session = await getClass(row.class_id);
      if (session) {
        entry.label = `${session.name} · ${session.date} ${formatHourLabel(session.startHour)}`;
      }
    } else if (row.court_id && row.date && row.start_hour !== null) {
      const court = await getCourt(row.court_id);
      if (court) {
        entry.label = `${court.name} · ${row.date} ${formatHourLabel(row.start_hour)}`;
      }
    }
    entries.push(entry);
  }
  return entries;
}

function formatHourLabel(hour: number): string {
  const h = hour % 24;
  const suffix = h >= 12 ? "PM" : "AM";
  return `${h % 12 === 0 ? 12 : h % 12}:00 ${suffix}`;
}

/* ---------------- Waitlists for ordinary slots ---------------- */

/** Are all these hours free on this resource right now? */
async function slotHoursFree(courtId: number, date: string, hours: number[]): Promise<boolean> {
  const court = await getCourt(courtId);
  if (!court) return false;
  const db = getDb();
  const classes = await classHoursOn(date, court.venueId);
  const blocked = await blockedPlacesFor(courtId, date, hours);
  for (const hour of hours) {
    if (classes.has(`${courtId}:${hour}`)) return false;
    const taken = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM booking_slots WHERE court_id = ? AND date = ? AND hour = ?"
      )
      .get(courtId, date, hour) as { n: number };
    if (taken.n + (blocked.get(hour) ?? 0) >= court.capacity) return false;
  }
  return true;
}

/** Queue for a court or facility slot that is currently taken. */
export async function joinSlotWaitlist(input: {
  courtId: number;
  date: string;
  /** The language to make the offer in, when one comes. */
  locale?: string;
  startHour: number;
  endHour: number;
  name: string;
  phone: string;
  email?: string;
  userId?: number;
}): Promise<WaitlistResult> {
  return withTransaction(async () => {
    await expireStaleOffers();
    const { courtId, date, startHour, endHour } = input;

    const waitCourt = await getCourt(courtId);
    if (!waitCourt) return refuse("COURT_NOT_FOUND");
    const { openHour, closeHour } = await courtVenueHours(courtId);
    if (endHour <= startHour || startHour < openHour || endHour > closeHour)
      return refuse("THOSE_HOURS_OUTSIDE_OPENING");
    if (await getVenueClosure(waitCourt.venueId, date))
      return refuse("VENUE_CLOSED");
    if (endHour - startHour > MAX_HOURS_PER_BOOKING)
      return refuse("MAX_HOURS", { max: MAX_HOURS_PER_BOOKING });
    if (!isBookableDate(date)) return refuse("DATE_OUT_OF_WINDOW");
    if (isPastSlot(date, startHour)) return refuse("TIME_PAST");

    const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i);
    if (await slotHoursFree(courtId, date, hours))
      return refuse("SLOT_FREE_BOOK_IT");

    const db = getDb();
    const already = await db
      .prepare(`
        SELECT id FROM waitlist
        WHERE court_id = ? AND date = ? AND start_hour = ? AND phone = ?
          AND status IN ('waiting','offered')
      `)
      .get(courtId, date, startHour, input.phone.trim());
    if (already) return refuse("ALREADY_WAITING");

    const info = await db
      .prepare(`
        INSERT INTO waitlist (court_id, date, start_hour, end_hour, name, phone, email, user_id, locale)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        courtId, date, startHour, endHour,
        input.name.trim(), input.phone.trim(), input.email?.trim() ?? null,
        input.userId ?? null, input.locale ?? "en"
      );

    const entry = toWaitlistEntry(
      await db.prepare("SELECT * FROM waitlist WHERE id = ?").get(info.lastInsertRowid) as WaitlistRow
    );
    return { ok: true, entry, position: (await slotQueue(courtId, date)).length };
  });
}

async function slotQueue(courtId: number, date: string): Promise<WaitlistRow[]> {
  return await getDb()
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
export async function offerSlotPlace(courtId: number, date: string): Promise<WaitlistEntry | null> {
  return withTransaction(async () => {
    await expireStaleOffers();
    const queue = await slotQueue(courtId, date);
    if (queue.some((row) => row.status === "offered")) return null;

    for (const row of queue) {
      if (row.status !== "waiting" || row.start_hour === null || row.end_hour === null) continue;
      const hours = Array.from(
        { length: row.end_hour - row.start_hour },
        (_, i) => row.start_hour! + i
      );
      if (isPastSlot(date, row.start_hour)) continue;
      if (!await slotHoursFree(courtId, date, hours)) continue;

      const db = getDb();
      await db.prepare(
        "UPDATE waitlist SET status = 'offered', offered_at = datetime('now'), offer_token = ? WHERE id = ?"
      ).run(randomBytes(16).toString("hex"), row.id);
      return toWaitlistEntry(
        await db.prepare("SELECT * FROM waitlist WHERE id = ?").get(row.id) as WaitlistRow,
        true
      );
    }
    return null;
  });
}
