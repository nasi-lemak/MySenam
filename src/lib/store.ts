import { activity, activityName, activityKeys } from "./activity-registry";
import { courtFor, courtOffers, groupByHeading, mostPerBookingAllowed, mostSpots, needsOf, placesPerBooking, type KindNeeds } from "./court-activities";
import { eligibilityAt, type EligibilityLine, type Taking } from "./eligibility";
import { signOffHolds, type SignOffChannel } from "./sign-offs";
import { bookingPlaces, CUSTOMER_TAKES_PART, guardianshipOf, PARTICIPANT_TAKES_PART, placeParticipants, placesInducted } from "./participants";
export { courtFor, courtOffers } from "./court-activities";
import { isActivity, venueMayOffer } from "./activities";
import { randomBytes, randomInt } from "crypto";
import { notesFor } from "./customer-notes";
import { signaturesFor } from "./waivers";
import { reviewPath } from "./review-links";
import { getDb, isBusy, isUniqueViolation, withTransaction } from "./db";
import { inSameBusiness, SAME_CREDIT, sameBusiness } from "./branches";
import { listRule, OPEN_TO_CUSTOMERS } from "./listing";
import { distanceM, inCountry, readPoint } from "./geo";
import {
  amenitiesFor,
  cleanAmenities,
  courtFilterSql,
  type Amenity,
  type AmenityFilter,
  type CourtFeatures,
  type CourtFilter,
  type Setting,
  type Surface,
} from "./facilities";
import { creditScope } from "./mode";
import { phoneNumber } from "./phone-check";
import { addonsFor, hasAddons, type BookingAddon } from "./addons";
import { isDuplicateSpend, memberPrices, membersOnlyRefusal, PASS_SCOPES, placesOf as placeRows, refuse as refuseEnt, soldByPlace, type BenefitScope } from "./entitlements";
import { errorText, translator } from "./i18n";
import type { ErrorCode } from "./i18n";
import { Booking, busyness, Refusal, Court, type CourtActivity, CourtAvailability, type SlotInfo, type StartOption, LATEST_CLOSE_HOUR, DEFAULT_OPEN_HOUR, DEFAULT_CLOSE_HOUR, MAX_ADVANCE_DAYS, MAX_VENUE_AHEAD_DAYS, COUNTER_METHODS, type CounterMethod, type PaidVia, MAX_HOURS_PER_BOOKING, MAX_COURT_HOURS, MAX_GROUP_COURTS, CHECK_IN_OPENS_MINUTES_BEFORE, ClassSession, ClassStatus, LiveOccupancy, MAX_CLASS_WEEKS, AccessResult, ACCESS_CODE_STALE_DAYS, Induction, doorFor, MAX_ACCESS_CODE, MIN_ACCESS_CODE, MAX_DEPOSIT, MAX_HIRE_NOTE, HIRE_CONDITIONS, HireCondition, HireRecord, MAX_TOP_UP, MAX_MEMBERSHIP_MONTHS, MAX_MEMBERSHIP_COVERS, MAX_PASS_ENTRIES, MAX_PASS_MINUTES, Membership, MembershipStatus, MAX_PROMO_AMOUNT, MAX_PROMO_PERCENT, PromoCode, PromoKind, PromoStatus, MAX_PASS_MONTHS, Pass, PassEntry, PassKind, PassStatus, WalletBalance, WalletEntry, WaitlistEntry, WaitlistStatus, WAITLIST_OFFER_MINUTES, Sport, Venue, VenueClosure, type BookingStatus, type PaymentStatus } from "./types";
import {
  addDays,
  formatHour,
  isBookableDate,
  isPastSlot,
  isValidDateString,
  isPeakMinute,
  forSport,
  lastMinuteOffAt,
  DEFAULT_PEAK,
  type PeakRules,
  isWithinCancelWindow,
  slotStartsAt,
  todayISO,
  localDateOf,
  dayOfWeek,
  crossesClockChange,
} from "./time";
import {
  DAY_MINUTES,
  LATEST_MINUTE,
  formatLength,
  formatMinute,
  hoursOf,
  instantOf,
  isMinute,
  minutesOf,
  overlaps,
  type Span,
} from "./interval";
import {
  asShown,
  claim,
  clearZones,
  fits,
  inTheWayOf,
  isConflict,
  lockCourts,
  occupantsOn,
  occupiedFor,
  peakPlaces,
  release,
  releaseBooking,
  spacesOf,
  unclaim,
  type Buffers,
  type Occupant,
} from "./claims";
export { releaseBooking } from "./claims";
import { passCost } from "./pass-rules";
export { passCost } from "./pass-rules";
import {
  breachMessage,
  claimBuffers,
  gridMinutes,
  lengthAllowed,
  policiesFor,
  policyBuffers,
  policyBreaches,
  policyFor,
  policyHoursOn,
  sportPolicyAt,
  startsWithin,
  type BookingPolicy,
  type PolicyBreach,
} from "./booking-policy";
import { priceBooking, readQuantityPrices, type MemberPricing, type Quote } from "./pricing";
import { money, region, isAmount, roundMoney } from "./region";
import { phoneKey } from "./phone";
import { hoursOn, parseWeekHours, validateUsualHours, validateWeekHours } from "./week-hours";
import { peakRules, peakRulesFor } from "./peak";
import { venueZoneOf } from "./zones";
import { utilisationByDay, type UseSplit } from "./reports";
import { cancelPolicy, cancelPolicyFor } from "./cancel-policy";
import { seriesWeeks, venueAheadDays } from "./house-rules";
import { creditBooking, creditReceipt, issueReceipt, saidLine } from "./documents";
import { venueTax } from "./tax";
import { englishOf, lengthText, readStaffText, said, withPhrase, type StaffText } from "./staff-text";

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
  setting: Setting | null;
  aircon: number;
  floodlit: number;
  surface: Surface | null;
  per_player?: number;
  max_players?: number | null;
  flat_rate?: boolean | number;
  classes_only?: boolean | number;
  quantity_prices?: string | null;
  /** JSON, kept by the database from court_activities (migration 0092). */
  activities?: string | null;
  noun?: string | null;
  heading?: string | null;
}

/** A court's activities as its row lists them, the main one first. */
function courtActivitiesOf(r: Pick<CourtRow, "sport" | "activities">): CourtActivity[] {
  let list: { sport: string; offPeakRate: number | string | null; peakRate: number | string | null }[] = [];
  try {
    list = r.activities ? JSON.parse(r.activities) : [];
  } catch {
    list = [];
  }
  const out = list.map((a) => ({
    sport: a.sport,
    offPeakRate: a.offPeakRate === null ? null : Number(a.offPeakRate),
    peakRate: a.peakRate === null ? null : Number(a.peakRate),
  }));
  return out.some((a) => a.sport === r.sport) ? out : [{ sport: r.sport, offPeakRate: null, peakRate: null }, ...out];
}

interface VenueRow {
  id: number;
  name: string;
  area: string;
  address: string;
  phone: string;
  cancel_cutoff_hours: number;
  open_min: number;
  close_min: number;
  week_hours?: string | null;
  time_zone?: string | null;
  staffed_from: number | null;
  staffed_to: number | null;
  partly_unstaffed?: "code" | "counter";
  emergency_phone: string | null;
  emergency_info: string | null;
  published_at: string | null;
  suspended_at: string | null;
  suspended_by: "payment" | "owner" | null;
  suspended_reason: string | null;
  lat: number | null;
  lng: number | null;
  amenities: string[] | null;
  access?: "public" | "members" | "private";
}

function toVenue(r: VenueRow): Venue {
  return {
    id: r.id,
    name: r.name,
    area: r.area,
    address: r.address,
    phone: r.phone,
    cancelCutoffHours: r.cancel_cutoff_hours,
    openMin: r.open_min,
    closeMin: r.close_min,
    openHour: hoursOf(r.open_min),
    closeHour: hoursOf(r.close_min),
    weekHours: parseWeekHours(r.week_hours),
    timeZone: venueZoneOf(r),
    staffedFrom: r.staffed_from,
    staffedTo: r.staffed_to,
    partlyUnstaffed: r.partly_unstaffed ?? "code",
    emergencyPhone: r.emergency_phone,
    emergencyInfo: r.emergency_info,
    publishedAt: r.published_at,
    suspendedAt: r.suspended_at,
    suspendedBy: r.suspended_by,
    suspendedReason: r.suspended_reason,
    lat: r.lat,
    lng: r.lng,
    amenities: cleanAmenities(r.amenities),
    access: r.access ?? "public",
  };
}

/** A venue's hours on a date (or its usual hours), in minutes and in hours, and its zone. */
export interface VenueHours {
  openMin: number;
  closeMin: number;
  openHour: number;
  closeHour: number;
  /** Shut that weekday every week. */
  closed: boolean;
  zone: string;
}

/** A venue's trading hours, falling back to the defaults if it has vanished. */
export async function venueHours(
  venueId: number,
  /** The hours on this date, where the weekday has its own; the usual hours without one. */
  date?: string
): Promise<VenueHours> {
  const row = await getDb()
    .prepare("SELECT open_min, close_min, week_hours, time_zone, lat, lng FROM venues WHERE id = ?")
    .get(venueId) as HoursRow | undefined;
  return withHours(row, date);
}

type HoursRow = {
  open_min: number;
  close_min: number;
  week_hours: string | null;
  time_zone: string | null;
  lat: number | null;
  lng: number | null;
};

function withHours(row: HoursRow | undefined, date?: string): VenueHours {
  const usual = { openMin: row?.open_min ?? DEFAULT_OPEN_HOUR * 60, closeMin: row?.close_min ?? DEFAULT_CLOSE_HOUR * 60 };
  const on = date ? hoursOn({ ...usual, weekHours: parseWeekHours(row?.week_hours) }, date) : { ...usual, closed: false };
  return {
    openMin: on.openMin,
    closeMin: on.closeMin,
    openHour: hoursOf(on.openMin),
    closeHour: hoursOf(on.closeMin),
    closed: on.closed,
    zone: venueZoneOf(row ?? {}),
  };
}

/** Class places held by live waiting-list offers (each offer every place its entry waits for), other than `except`. */
async function classOfferHolds(classId: number, except?: number): Promise<number> {
  const since = new Date(Date.now() - WAITLIST_OFFER_MINUTES * 60_000).toISOString().replace("T", " ").slice(0, 19);
  const r = (await getDb()
    .prepare("SELECT COALESCE(SUM(places), 0) AS n FROM waitlist WHERE class_id = ? AND status = 'offered' AND offered_at > ? AND id <> ?")
    .get(classId, since, except ?? 0)) as { n: number | string };
  return Number(r.n);
}

/** The trading hours of the venue a court belongs to. */
export async function courtVenueHours(
  courtId: number,
  /** The hours on this date, where the weekday has its own; the usual hours without one. */
  date?: string
): Promise<VenueHours> {
  const row = await getDb()
    .prepare(`
      SELECT v.id AS id, v.open_min AS open_min, v.close_min AS close_min, v.week_hours AS week_hours,
             v.time_zone AS time_zone, v.lat AS lat, v.lng AS lng
      FROM courts c JOIN venues v ON v.id = c.venue_id WHERE c.id = ?
    `)
    .get(courtId) as (HoursRow & { id: number }) | undefined;
  return withHours(row, date);
}

/** The time zone of the venue a court belongs to. */
export async function courtZone(courtId: number): Promise<string> {
  return (await courtVenueHours(courtId)).zone;
}

/** The closure covering a date, if the venue is shut that whole day. */
export async function getVenueClosure(venueId: number, date: string): Promise<VenueClosure | null> {
  const row = await getDb()
    .prepare("SELECT date, reason FROM venue_closures WHERE venue_id = ? AND date = ?")
    .get(venueId, date) as { date: string; reason: string | null } | undefined;
  if (row) return { date: row.date, reason: row.reason };
  // A weekday the venue never opens on is closed like any closed day.
  const week = (await getDb().prepare("SELECT week_hours FROM venues WHERE id = ?").get(venueId)) as { week_hours: string | null } | undefined;
  return parseWeekHours(week?.week_hours)?.[dayOfWeek(date)] === "closed" ? { date, reason: null } : null;
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
/** A sign-off or certification missing: naming the participant it is missing for, where it is not the customer's own. */
function signOffRefusal(need: "certification" | "any", sport: string, name: string | null): Refusal {
  if (name) return refuse(need === "certification" ? "CERTIFICATION_NEEDED_FOR" : "SIGN_OFF_NEEDED_FOR", { sport, name });
  return refuse(need === "certification" ? "CERTIFICATION_NEEDED" : "SIGN_OFF_NEEDED", { sport });
}

function refuse(code: ErrorCode, vars?: Record<string, string | number>): Refusal {
  const refusal: Refusal = { ok: false, error: errorText(ENGLISH, code, vars), code };
  // Left off entirely when there are none, so the shape on the wire stays the
  // shape it was for every refusal that quotes nothing.
  if (vars) refusal.vars = vars;
  return refusal;
}

/**
 * A change that ran out of tries against others (lib/db.ts, BusyError) is
 * refused as busy, safe to ask again, rather than thrown: nothing was kept.
 */
function busyAware<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R | Refusal> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (isBusy(err)) return refuse("BUSY");
      throw err;
    }
  };
}
export const cancelBooking = busyAware(cancelBookingOnce);
export const adminCancelBooking = busyAware(adminCancelBookingOnce);
export const rescheduleBooking = busyAware(rescheduleBookingOnce);
export const moveBooking = busyAware(moveBookingOnce);
export const enrolInClass = busyAware(enrolInClassOnce);
/** Several people in a class at once, all or none (lib/participant-bookings.ts). */
export const enrolPeople = busyAware(enrolPeopleOnce);
export const claimWaitlistOffer = busyAware(claimWaitlistOfferOnce);

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
    // A day gone by cannot be shut; it would only hide what was booked and played.
    if (date < todayISO((await venueHours(venueId)).zone)) return refuse("CLOSURE_PAST");
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

interface BookingRow {
  id: number;
  code: string;
  court_id: number;
  date: string;
  start_min: number;
  end_min: number;
  starts_at?: Date | string | null;
  ends_at?: Date | string | null;
  fee_amount?: number | string;
  policy_override?: boolean;
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
  shares_paid?: number | string;
  deposit_paid?: number | string;
  group_code?: string | null;
  players?: number;
  concession_name?: string | null;
  concession_preset?: string | null;
  concession_off?: number | string;
  concession_check?: "due" | "seen" | "refused" | null;
  coach_id?: number | null;
  coach_fee?: number | string;
  account_id?: number | null;
  user_id: number | null;
  checked_in_at?: string | null;
  checked_out_at?: string | null;
  hold_until?: string | null;
  released_unpaid?: number;
  tax_rate?: number | string | null;
  participant_id?: number | null;
  participant_name?: string | null;
  sport: Sport;
}

/** Quantity prices as stored; anything unreadable counts as none. */
function readStoredBands(raw: string | null | undefined): Court["quantityPrices"] {
  if (!raw) return null;
  try {
    const read = readQuantityPrices(JSON.parse(raw));
    return read.ok ? read.value : null;
  } catch {
    return null;
  }
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
    setting: r.setting ?? null,
    aircon: r.aircon === 1,
    floodlit: r.floodlit === 1,
    surface: r.surface ?? null,
    perPlayer: r.per_player === 1,
    maxPlayers: r.max_players ?? null,
    flatRate: r.flat_rate === true || r.flat_rate === 1,
    classesOnly: r.classes_only === true || r.classes_only === 1,
    quantityPrices: readStoredBands(r.quantity_prices),
    activities: courtActivitiesOf(r),
    noun: r.noun ?? null,
    heading: r.heading ?? null,
  };
}

/** SQL: court `alias` can be booked for the activity bound to the `?`. */
function offersSql(alias = "c"): string {
  return `EXISTS (SELECT 1 FROM court_activities ca WHERE ca.court_id = ${alias}.id AND ca.sport = ?)`;
}

/** The court a booking is on, as offered for what was booked. */
export async function bookedCourt(booking: Pick<Booking, "courtId" | "sport">): Promise<Court | null> {
  const court = await getCourt(booking.courtId);
  return court ? courtFor(court, booking.sport) : null;
}

function toBooking(r: BookingRow): Booking {
  return {
    id: r.id,
    code: r.code,
    courtId: r.court_id,
    sport: r.sport,
    date: r.date,
    startMin: r.start_min,
    endMin: r.end_min,
    startHour: hoursOf(r.start_min),
    endHour: hoursOf(r.end_min),
    ...(r.starts_at ? { startsAt: new Date(r.starts_at).toISOString() } : {}),
    ...(r.ends_at ? { endsAt: new Date(r.ends_at).toISOString() } : {}),
    feeAmount: Number(r.fee_amount ?? 0),
    policyOverride: r.policy_override === true,
    name: r.name,
    phone: r.phone,
    email: r.email,
    participantId: r.participant_id ?? null,
    participantName: r.participant_name ?? null,
    totalPrice: r.total_price,
    status: r.status,
    createdAt: r.created_at,
    seriesCode: r.series_code,
    paymentStatus: r.payment_status,
    paidAt: r.paid_at,
    paidOnline: r.paid_via === "online",
    paidVia: (r.paid_via as PaidVia | null | undefined) ?? null,
    holdUntil: r.hold_until ?? null,
    releasedUnpaid: r.released_unpaid === 1,
    noShow: r.no_show === 1,
    checkedInAt: r.checked_in_at ?? null,
    checkedOutAt: r.checked_out_at ?? null,
    checkInToken: r.check_in_token,
    classId: r.class_id,
    sharesPaid: Number(r.shares_paid ?? 0),
    depositPaid: Number(r.deposit_paid ?? 0),
    groupCode: r.group_code ?? null,
    players: r.players ?? 1,
    concessionName: r.concession_name ?? null,
    concessionPreset: r.concession_preset ?? null,
    concessionOff: Number(r.concession_off ?? 0),
    concessionCheck: r.concession_check ?? null,
    coachId: r.coach_id ?? null,
    coachFee: Number(r.coach_fee ?? 0),
    accountId: r.account_id ?? null,
    taxRate: r.tax_rate === null || r.tax_rate === undefined ? null : Number(r.tax_rate),
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

/** Errors that mean "that court went", rather than something structural. */
const TAKEN_ERROR = /just booked|filling up very quickly|filled up|already taken/i;

/**
 * A booking's time as a request gives it: exact minutes of the day (`start`
 * and `end`, or `start` and `minutes`), or, as the public API and older
 * screens do, `hours`: the starts of the booking board's columns, end to end
 * ([9, 10] is 9:00–11:00 on a board of hours, [9.5, 10, 10.5] 9:30–11:00 on
 * one of half hours).
 */
export interface WhenInput {
  start?: number;
  end?: number;
  minutes?: number;
  hours?: number[];
}

/** The span a request asks for on a court with this policy. */
export function spanFor(when: WhenInput, policy: BookingPolicy): { ok: true; span: Span } | Refusal {
  if (when.start !== undefined) {
    const end = when.end ?? (when.minutes !== undefined ? when.start + when.minutes : undefined);
    if (!isMinute(when.start) || !isMinute(end) || end <= when.start) return refuse("NO_HOURS");
    return { ok: true, span: { start: when.start, end } };
  }
  const starts = [...new Set((when.hours ?? []).filter((h) => typeof h === "number" && Number.isFinite(h)).map(minutesOf))].sort((a, b) => a - b);
  if (starts.length === 0 || !starts.every(isMinute)) return refuse("NO_HOURS");
  const column = gridMinutes(policy);
  if (!starts.every((m, i) => i === 0 || m - starts[i - 1] === column)) return refuse("HOURS_NOT_CONSECUTIVE");
  return { ok: true, span: { start: starts[0], end: starts[starts.length - 1] + column } };
}

/** A court's booking policy, as everything in it resolves (lib/booking-policy.ts). */
export async function policyForCourt(courtId: number): Promise<BookingPolicy | null> {
  const court = await getCourt(courtId);
  return court ? policyFor(court) : null;
}

/** What a customer may pick on a sport's courts at a venue, by default (a court may have its own). */
export async function policyForSport(venueId: number, sport: Sport): Promise<CourtAvailability["policy"]> {
  return publicPolicy(await sportPolicyAt(venueId, sport));
}

/**
 * The span a request asks for, on a named court or on any court of a sport
 * at a venue: the older `hours` form is read on that policy's grid. Says
 * nothing of whether it may be booked.
 */
export async function requestedSpan(
  where: { courtId: number } | { venueId: number; sport: Sport },
  when: WhenInput
): Promise<{ ok: true; span: Span } | Refusal> {
  if ("courtId" in where) {
    const court = await getCourt(where.courtId);
    if (!court) return refuse("COURT_NOT_FOUND");
    return spanFor(when, await policyFor(court));
  }
  return spanFor(when, await sportPolicyAt(where.venueId, where.sport));
}

/** A court's rules and hours on a date: everything a booking of it is checked against, short of what holds it. */
export interface CourtDay {
  court: Court;
  policy: BookingPolicy;
  /** Its hours that day: the court's own (policy), else the venue's. */
  openMin: number;
  closeMin: number;
  /** Shut all day: a closure, or a weekday it never opens. */
  closed: boolean;
  zone: string;
  /** The business day these are the hours of. */
  date: string;
}

async function courtDays(courts: Court[], date: string): Promise<Map<number, CourtDay>> {
  const out = new Map<number, CourtDay>();
  if (courts.length === 0) return out;
  const venueIds = [...new Set(courts.map((c) => c.venueId))];
  const db = getDb();
  const rows = (await db
    .prepare(`SELECT id, open_min, close_min, week_hours, time_zone, lat, lng FROM venues WHERE id IN (${venueIds.map(() => "?").join(",")})`)
    .all(...venueIds)) as (HoursRow & { id: number })[];
  const shut = (await db
    .prepare(`SELECT venue_id FROM venue_closures WHERE date = ? AND venue_id IN (${venueIds.map(() => "?").join(",")})`)
    .all(date, ...venueIds)) as { venue_id: number }[];
  const policies = await policiesFor(courts);
  for (const court of courts) {
    const v = rows.find((r) => r.id === court.venueId);
    const venue = { openMin: v?.open_min ?? DEFAULT_OPEN_HOUR * 60, closeMin: v?.close_min ?? DEFAULT_CLOSE_HOUR * 60, weekHours: parseWeekHours(v?.week_hours) };
    const policy = policies.get(court.id)!;
    const h = policyHoursOn(policy, venue, date);
    const venueClosedWeekday = hoursOn(venue, date).closed;
    out.set(court.id, {
      court,
      policy,
      openMin: h.openMin,
      closeMin: h.closeMin,
      closed: h.closed || venueClosedWeekday || shut.some((c) => c.venue_id === court.venueId),
      zone: venueZoneOf(v ?? {}),
      date,
    });
  }
  return out;
}

export async function courtDay(court: Court, date: string): Promise<CourtDay> {
  return (await courtDays([court], date)).get(court.id)!;
}

/** The days of several courts, by id, for modules that hold court ids (lib/coaching.ts). */
export async function courtDaysFor(courtIds: number[], date: string): Promise<Map<number, CourtDay>> {
  const courts = (await Promise.all(courtIds.map((id) => getCourt(id)))).filter((c): c is Court => c !== null);
  return courtDays(courts, date);
}

/** Minutes from now until minute `minute` of `date` where the venue is (negative once begun). */
function minutesUntil(date: string, minute: number, zone: string): number {
  return (instantOf(date, minute, zone).getTime() - Date.now()) / 60_000;
}

/** Why a court cannot take a booking of `span`: what is in the way, said as the customer is told. */
function whyTaken(
  occupants: Occupant[],
  court: Court,
  span: Span,
  buffers: Buffers,
  ignore?: (o: Occupant) => boolean,
  /** Places the booking takes on a shared facility (several kayaks, several people on a floor); a court held whole takes itself. */
  places = 1
): { why: "class"; name: string; classId: number } | { why: "blocked" | "full" } | null {
  if (fits(occupants, court.capacity, span, buffers, ignore, places)) return null;
  // What overlaps it, or (on a court of one place) is closer than the separation allows.
  const inWay = inTheWayOf(occupants, court.capacity, span, buffers, ignore);
  const session = inWay.find((o) => o.kind === "class");
  if (session) return { why: "class", name: "", classId: session.classId! };
  const blocks = inWay.filter((o) => o.kind === "block" || o.kind === "outage");
  const booked = inWay.filter((o) => o.kind !== "block" && o.kind !== "outage");
  const roomLeft = court.capacity > 1 ? peakPlaces(booked, occupiedFor(court.capacity, span, buffers)) < court.capacity : booked.length === 0;
  return { why: blocks.length > 0 && roomLeft ? "blocked" : "full" };
}

/**
 * Courts at a venue that could take this whole booking, cheapest first.
 * Price is peak-aware, so the order can differ between a morning and an
 * evening booking on the same courts. Each court's own policy decides whether
 * it may be booked for that time at all.
 */
export async function courtsForAnyBooking(input: { venueId: number; sport: Sport; date: string } & WhenInput): Promise<Court[]> {
  const { venueId, sport, date } = input;
  const db = getDb();
  const courts = (
    await db
      .prepare(`SELECT c.* FROM courts c WHERE c.venue_id = ? AND ${offersSql()} AND NOT c.classes_only ORDER BY c.id`)
      .all(venueId, sport) as CourtRow[]
  ).map((r) => courtFor(toCourt(r), sport));
  if (courts.length === 0) return [];
  const days = await courtDays(courts, date);
  const zone = days.get(courts[0].id)!.zone;
  const held = await occupantsOn(courts, date, zone);
  const rules = await peakRules(venueId);
  const priced: { court: Court; price: number }[] = [];
  for (const court of courts) {
    const day = days.get(court.id)!;
    const asked = spanFor(input, day.policy);
    if (!asked.ok || day.closed) continue;
    const span = asked.span;
    if (policyBreaches(day.policy, span, day, minutesUntil(date, span.start, zone)).length > 0) continue;
    if (minutesUntil(date, span.start, zone) <= 0) continue;
    if (!fits(held.get(court.id)!, court.capacity, span, policyBuffers(day.policy))) continue;
    priced.push({ court, price: priceBooking({ court, date, span, rules, pricing: day.policy.pricing, at: Date.now() }).total });
  }
  return priced.sort((a, b) => a.price - b.price || a.court.id - b.court.id).map((p) => p.court);
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
  weeks?: number;
  skipConflicts?: boolean;
  name: string;
  phone: string;
  email?: string;
  userId?: number;
  players?: number;
  staff?: StaffOverride;
  by?: SignOffChannel;
  /** Who takes part, for somebody the signed-in adult manages (createBookingSeries). */
  participant?: { id: number; name: string };
  /** Who takes part, where that is not (only) the customer (createBookingSeries). */
  participants?: { id: number; name: string }[];
  customerTakesPart?: boolean;
  addedBy?: { userId?: number | null; adminId?: number | null };
} & WhenInput): Promise<CreateSeriesResult> {
  const { venueId, sport, date, ...rest } = input;

  const venue = await getDb().prepare("SELECT id FROM venues WHERE id = ?").get(venueId);
  if (!venue) return refuse("VENUE_NOT_FOUND");
  if (!(await isActivity(sport))) return refuse("UNKNOWN_SPORT");

  const candidates = await courtsForAnyBooking(input);
  if (candidates.length === 0) {
    // Fall through to the single-court path on any court of that sport, so the
    // customer gets the real reason (closed day, outside hours, past slot)
    // rather than a flat "nothing free".
    const anyCourt = (
      await getDb()
        .prepare(`SELECT c.* FROM courts c WHERE c.venue_id = ? AND ${offersSql()} AND NOT c.classes_only ORDER BY c.id LIMIT 1`)
        .all(venueId, sport) as CourtRow[]
    ).map(toCourt)[0];
    if (!anyCourt)
      return refuse("NO_SPORT_AT_VENUE", { sport: activityName(sport) });
    const probe = await createBookingSeries({ ...rest, courtId: anyCourt.id, sport, date, weeks: input.weeks ?? 1 });
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
      weeks: input.weeks ?? 1,
    });
    if (result.ok) return result;
    lastError = result.error;
    // Anything that is not "someone took it" applies to every court equally,
    // so there is no point walking the rest of the list; bar a court's own
    // rules, which the next court may not share.
    const code = (result as { code?: string }).code;
    if (!TAKEN_ERROR.test(result.error) && code !== "POLICY") return result;
  }
  return { ok: false, error: lastError };
}

/**
 * Several courts at the same time, as one: a company night, a club session.
 * Each court is its own booking and code, made as any booking is, and they
 * share a group code so they are confirmed, held and paid together. All or
 * nothing: a court that cannot be had takes the others back with it, saying
 * which one. One date (a weekly booking is one court's).
 */
export async function createGroupBooking(input: {
  courtIds: number[];
  date: string;
  name: string;
  phone: string;
  email?: string;
  userId?: number;
  players?: number;
  /**
   * How many places on each shared resource, where they differ: kinds of kit
   * in one booking (two single kayaks and a double, each kind a fleet of its
   * own). A resource not named takes `players`.
   */
  placesByCourt?: Record<number, number>;
  /** The activity on every court; each court's main one if not said. */
  sport?: Sport;
  staff?: StaffOverride;
  by?: SignOffChannel;
  /**
   * Who takes part on which court, where people are named (lib/participant-bookings.ts):
   * each court's own participants, and whether the customer takes a place
   * there. A court not named here is taken by the customer's party, as a
   * count of places with nobody assigned. Somebody is on one court of a
   * group at most: they are all at the same time.
   */
  assign?: Record<number, { participants: { id: number; name: string }[]; customerTakesPart: boolean }>;
  addedBy?: { userId?: number | null; adminId?: number | null };
} & WhenInput): Promise<CreateSeriesResult> {
  const courtIds = [...new Set(input.courtIds)];
  if (courtIds.length < 2 || courtIds.length > MAX_GROUP_COURTS) return refuse("GROUP_COURTS", { max: MAX_GROUP_COURTS });
  const { assign, ...shared } = input;
  if (assign) {
    const everyone = Object.entries(assign).flatMap(([courtId, a]) => (courtIds.includes(Number(courtId)) ? a.participants.map((p) => p.id) : [NaN]));
    if (everyone.some((id) => Number.isNaN(id)) || new Set(everyone).size !== everyone.length) return refuse("PLAYERS_RANGE", { max: everyone.length });
    // The customer is one person too: at one court of the group at most.
    if (Object.values(assign).filter((a) => a.customerTakesPart).length > 1) return refuse("PLAYERS_RANGE", { max: 1 });
  }
  // In one order, so two groups sharing courts queue rather than deadlock.
  const courts = await Promise.all(courtIds.sort((a, b) => a - b).map((id) => getCourt(id)));
  if (courts.some((c) => !c)) return refuse("COURT_NOT_FOUND");
  if (new Set(courts.map((c) => c!.venueId)).size > 1) return refuse("GROUP_ONE_VENUE");

  // One transaction: a court that cannot be had, or anything going wrong
  // part-way, leaves none of them booked.
  class Refused extends Error {
    constructor(readonly result: CreateSeriesResult) {
      super("GROUP_REFUSED");
    }
  }
  try {
    return await withTransaction(async () => {
      // Everything the group will hold, locked at once before any of it is claimed.
      await lockCourts(courts.map((c) => c!));
      const made: Booking[] = [];
      for (const court of courts) {
        const people = assign?.[court!.id];
        // Where people are named on a court, it takes a place each unless the places are said.
        const players = input.placesByCourt?.[court!.id] ?? (people && people.participants.length > 0 ? undefined : input.players);
        const result = await createBookingSeries({
          ...shared,
          courtId: court!.id,
          weeks: 1,
          ...(players !== undefined ? { players } : {}),
          ...(people && people.participants.length > 0 ? { participants: people.participants, customerTakesPart: people.customerTakesPart } : {}),
        });
        if (!result.ok) throw new Refused({ ...result, error: `${court!.name}: ${result.error}` });
        made.push(...result.bookings);
      }
      const groupCode = randomCode("GR-");
      await getDb()
        .prepare(`UPDATE bookings SET group_code = ? WHERE id IN (${made.map(() => "?").join(",")})`)
        .run(groupCode, ...made.map((b) => b.id));
      return { ok: true as const, bookings: made.map((b) => ({ ...b, groupCode })), skipped: [], seriesCode: null };
    });
  } catch (err) {
    if (err instanceof Refused) return err.result;
    if (isBusy(err)) return refuse("BUSY");
    throw err;
  }
}

/**
 * ` AND <column> IN (this venue's courts)`, or nothing for every venue.
 *
 * Spelled out rather than written as `(? IS NULL OR ...)`, because the
 * planner cannot use an index through that OR: asking for one venue read every
 * venue's rows for the date, so the venue page slowed down with each venue
 * added to the platform.
 */
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
 * What a customer may pick on a court, without its buffers (customers are
 * not told about them; they only find the time unavailable).
 */
function publicPolicy(p: BookingPolicy): CourtAvailability["policy"] {
  return {
    startEvery: p.startEvery,
    startOffset: p.startOffset,
    startTimes: p.startTimes,
    lengthStep: p.lengthStep,
    minLength: p.minLength,
    maxLength: p.maxLength,
    lengths: p.lengths,
    defaultLength: p.defaultLength,
    noticeMinutes: p.noticeMinutes,
    needs: needsOf(p),
  };
}

/**
 * Where a booking may start on a court, and the longest it may run from
 * each: the policy's starts, within the court's hours, not past, with the
 * notice the policy asks, and free of every claim with the court's buffers.
 */
export function startOptions(day: CourtDay, occupants: Occupant[], date: string, ignore?: (o: Occupant) => boolean): StartOption[] {
  if (day.closed) return [];
  const { policy, court } = day;
  const out: StartOption[] = [];
  const buffers = policyBuffers(policy);
  const lengths = policy.lengths ?? null;
  // On a facility turned over whole, a booking that joins a session fits where a shorter one, cleaned while the
  // session runs on, does not: every length is tried, and those that fit are listed when they are not all up to the longest.
  const wide = court.capacity > 1 && buffers.turnover === "facility";
  for (const start of startsWithin(policy, day.openMin, day.closeMin)) {
    const ahead = minutesUntil(date, start, day.zone);
    if (ahead <= 0 || ahead < policy.noticeMinutes) continue;
    const fitting: number[] = [];
    const candidates = lengths ?? lengthsBetween(policy);
    for (const length of candidates) {
      if (start + length > day.closeMin) break;
      // Where the clocks change, no booking touching the change (lib/time.ts); longer ones would too.
      if (crossesClockChange(day.date, start, start + length, day.zone)) break;
      if (!fits(occupants, court.capacity, { start, end: start + length }, buffers, ignore)) {
        // Fixed lengths need not fit in order, but anything longer than one that does not fit will not either.
        if (wide) continue;
        break;
      }
      fitting.push(length);
    }
    if (fitting.length === 0) continue;
    const longest = fitting[fitting.length - 1];
    // Every length up to the longest, unless some in between do not fit.
    out.push(candidates[fitting.length - 1] === longest ? { minute: start, maxLength: longest } : { minute: start, maxLength: longest, lengths: fitting });
  }
  return out;
}

/** The lengths a policy allows, shortest first. */
function lengthsBetween(policy: BookingPolicy): number[] {
  const out: number[] = [];
  const first = Math.ceil(policy.minLength / policy.lengthStep) * policy.lengthStep;
  for (let l = first; l <= policy.maxLength; l += policy.lengthStep) out.push(l);
  return out;
}

/**
 * The booking board for every court of a venue (optionally one sport) on a
 * date: columns of time as the court's policy draws them, each said to be
 * free, partly held or held, and the starts a customer may pick. Held time
 * includes buffers, without saying so.
 */
export async function getAvailability(
  venueId: number,
  date: string,
  sport?: Sport,
  /** Price the grid at member rates (or a tier's share), for a caller known to be a member. */
  member: MemberPricing = false,
  /** Include rooms run as classes: for the venue's own staff and systems, who may hire them out. */
  classRooms = false
): Promise<CourtAvailability[]> {
  const db = getDb();
  let courts = (
    await db.prepare("SELECT * FROM courts WHERE venue_id = ? ORDER BY id").all(venueId) as CourtRow[]
  ).map(toCourt);
  // A studio run as classes is booked through its classes, not the grid.
  if (!classRooms) courts = courts.filter((c) => !c.classesOnly);
  // Every court that can be booked for the activity, as offered for it.
  if (sport) courts = courts.filter((c) => courtOffers(c, sport)).map((c) => courtFor(c, sport));
  if (courts.length === 0) return [];
  const days = await courtDays(courts, date);
  const zone = days.get(courts[0].id)!.zone;
  const held = await occupantsOn(courts, date, zone);
  const rules = await peakRules(venueId);
  const classNames = await classNamesFor([...held.values()].flat().map((o) => o.classId).filter((id): id is number => id !== null));
  const now = Date.now();
  // One set of columns for every court shown, so they line up: as fine as
  // the finest court's policy draws, from the earliest opening to the latest
  // close. A court's own hours, outside those, are cells it is shut.
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const open = [...days.values()].filter((d) => !d.closed);
  const grid = Math.max(15, [...days.values()].map((d) => gridMinutes(d.policy)).reduce(gcd));
  const from = open.length > 0 ? Math.min(...open.map((d) => d.openMin)) : Math.min(...[...days.values()].map((d) => d.openMin));
  const to = open.length > 0 ? Math.max(...open.map((d) => d.closeMin)) : Math.max(...[...days.values()].map((d) => d.closeMin));

  return courts.map((court) => {
    const day = days.get(court.id)!;
    const occupants = held.get(court.id)!;
    // Cells show what each holds and keeps free around it, separation included; starts are worked out exactly (startOptions).
    const shown = asShown(occupants);
    // A shared facility turned over whole is closed to everybody while it is.
    const clear = occupants.flatMap(clearZones);
    const own = forSport(rules, court.sport);
    // The rate of a column of time, without fixed prices or minimum charges, which belong to whole bookings.
    const timeOnly = { ...day.policy.pricing, fixedPrices: null, minCharge: null, minBilled: null, billStep: null, setupFee: 0, cleanupFee: 0 };
    const slots: SlotInfo[] = [];
    for (let minute = from; minute < to; minute += grid) {
      const cell = { start: minute, end: Math.min(minute + grid, to) };
      if (cell.start < day.openMin || cell.end > day.closeMin) {
        slots.push({ minute, hour: hoursOf(minute), rate: 0, booked: 0, capacity: court.capacity, available: false, outside: true });
        continue;
      }
      const inCell = shown.filter((o) => overlaps(o.occupied, cell));
      const booked = peakPlaces(inCell.filter((o) => o.kind === "booking" || o.kind === "offer" || o.kind === "move" || o.kind === "approval"), cell);
      const out = peakPlaces(inCell.filter((o) => o.kind === "block" || o.kind === "outage"), cell);
      const load = peakPlaces(inCell, cell);
      const session = inCell.find((o) => o.kind === "class" && overlaps(o.span, cell));
      const cleared = clear.filter((z) => overlaps(z, cell));
      const full = day.closed || load >= court.capacity || cleared.some((z) => z.start <= cell.start && z.end >= cell.end);
      // Held for some of it, not all: a booking from 18:07, or a buffer (on a shared facility, its turnover).
      const partly = !full && (court.capacity === 1 ? inCell.length > 0 : cleared.length > 0);
      const past = minutesUntil(date, minute, zone) <= 0;
      const lastMinute = full || session ? 0 : lastMinuteOffAt(date, minute, own, now);
      slots.push({
        minute,
        hour: hoursOf(minute),
        rate: priceBooking({ court, date, span: cell, member, rules, pricing: timeOnly, at: now }).court,
        ...(lastMinute > 0 ? { lastMinute } : {}),
        ...(isPeakMinute(date, minute, own) ? { peak: true } : {}),
        booked,
        capacity: court.capacity,
        // A class owns the time: enrolling is the only way in.
        available: !full && !partly && !session && !past,
        ...(partly ? { partly: true } : {}),
        ...(session ? { className: classNames.get(session.classId!) ?? "", classId: session.classId! } : {}),
        // Only meaningful while places remain; `blocked` covers the rest.
        ...(out > 0 && !full ? { blockedPlaces: out } : {}),
        ...(day.closed || (out > 0 && full) ? { blocked: true } : {}),
      });
    }
    return {
      court,
      unit: grid / 60,
      grid,
      policy: publicPolicy(day.policy),
      slots,
      starts: startOptions(day, occupants, date),
    };
  });
}

/** Class names by id, for showing who holds a court. */
async function classNamesFor(ids: number[]): Promise<Map<number, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = (await getDb()
    .prepare(`SELECT id, name FROM classes WHERE id IN (${unique.map(() => "?").join(",")})`)
    .all(...unique)) as { id: number; name: string }[];
  return new Map(rows.map((r) => [r.id, r.name]));
}

export interface SearchResult {
  venue: Venue;
  /** How far away, when the search was near somewhere. */
  distanceKm?: number;
  /** The cheapest court free at this venue for this time. */
  court: Court;
  /** Minutes of the day it starts and ends, and the same in hours. */
  startMin: number;
  endMin: number;
  startHour: number;
  endHour: number;
  totalPrice: number;
  /** How many more of the venue's courts are free for the same time. */
  alsoFree: number;
  /** Whether those others cost more than this one. */
  pricesVary: boolean;
  /** What the shown court's booking rules ask for first: a staff sign-off or a certification. */
  needs: KindNeeds;
  /**
   * Where it needs something and the search was for who is taking part
   * (`taking`): each one's status for it (lib/eligibility.ts). Informational:
   * booking checks again. Absent otherwise.
   */
  eligibility?: EligibilityLine[];
  /**
   * Kinds of kit the venue lists under one heading ("Kayaks" over "Single
   * kayak" and "Double kayak"; lib/resources.ts `setCourtHeading`), for each
   * heading with a kind free at this time: every kind under it, each as
   * itself. Never added up: a single kayak is not a double one.
   */
  groups: SearchGroup[];
}

/** One heading's kinds at a search result's venue and time (`SearchResult.groups`). */
export interface SearchGroup {
  heading: string;
  kinds: SearchKind[];
}

/** One kind under a heading, from the result's start for its length: its own price, places and rules. */
export interface SearchKind {
  courtId: number;
  name: string;
  /** Free then, by itself (it may still be the only one of its heading that is). */
  free: boolean;
  /** One booking of it then: one place on a resource with places, the court on one booked whole. */
  totalPrice: number;
  perPlayer: boolean;
  /** Places it has (1: booked whole). */
  capacity: number;
  /** Its own places left over that time; null on one booked whole, or when it cannot start then. */
  placesLeft: number | null;
  needs: KindNeeds;
  /** As `SearchResult.eligibility`, for this kind. */
  eligibility?: EligibilityLine[];
}

export interface SearchInput {
  sport: Sport;
  date: string;
  /** The earliest and latest start wanted, in hours (18.5) or minutes (`fromMin`, `toMin`). */
  fromHour?: number;
  toHour?: number;
  fromMin?: number;
  toMin?: number;
  /** How long, in hours (1.25) or minutes (`minutes`). */
  duration?: number;
  minutes?: number;
  area?: string;
  limit?: number;
  /** Only these venues — a storefront's. Undefined for every venue. */
  venueIds?: number[];
  /** Only venues within this distance of here, nearest first. */
  near?: Near;
  /** Only venues with all of these (lib/facilities.ts). */
  amenities?: AmenityFilter[];
  /** Only courts with all of these: air-con, indoor, floodlit. */
  courtFilters?: CourtFilter[];
  /**
   * The order: the earliest start first (the default); the nearest venue
   * first, which needs `near`; or the cheapest hour first.
   */
  sort?: SearchSort;
  /**
   * A signed-in account's choice of who is taking part: results that need a
   * sign-off or certification then say each one's status, from one query
   * for the page (lib/eligibility.ts). Left out, nothing personal is read.
   */
  taking?: Taking;
}

export const SEARCH_SORTS = ["soonest", "nearest", "cheapest"] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

/** `WHERE` clauses for venues `v` that have every one of these, with their parameters. */
function amenityClauses(filters: AmenityFilter[] | undefined): { clauses: string[]; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  for (const f of filters ?? []) {
    const any = amenitiesFor(f);
    clauses.push(`(${any.map(() => "? = ANY(v.amenities)").join(" OR ")})`);
    params.push(...any);
  }
  return { clauses, params };
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
 * outside the install's country, or not a point at all, is no point.
 */
export function readNear(near: string | null | undefined, km?: string | null): Near | null {
  if (!near) return null;
  const [lat, lng] = near.split(",").map((x) => Number(x.trim()));
  const point = readPoint(lat, lng);
  if (!point || !inCountry(point)) return null;
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
function venueFilter(opts: {
  area?: string;
  sport?: Sport;
  venueIds?: number[];
  near?: Near;
  amenities?: AmenityFilter[];
  courtFilters?: CourtFilter[];
}): {
  sql: string;
  params: (string | number)[];
} {
  // Only venues customers may reach (lib/listing.ts) — in public lists, or
  // just these, for a storefront that named them — and of those not one with
  // nothing to book yet, rather than "0 courts" to somebody looking.
  const clauses: string[] = [
    listRule(opts.venueIds),
    "EXISTS (SELECT 1 FROM courts c WHERE c.venue_id = v.id)",
  ];
  const params: (string | number)[] = [];
  if (opts.venueIds) {
    clauses.push(`v.id IN (${opts.venueIds.map(() => "?").join(",") || "NULL"})`);
    params.push(...opts.venueIds);
  }
  if (opts.area) {
    clauses.push("v.area = ?");
    params.push(opts.area);
  }
  // One court of the sport with every feature asked for, not one court with
  // air-con and another of a different sport that is indoor.
  const features = (opts.courtFilters ?? []).map(courtFilterSql);
  if (opts.sport || features.length > 0) {
    clauses.push(
      `EXISTS (SELECT 1 FROM courts c WHERE c.venue_id = v.id${opts.sport ? ` AND ${offersSql()} AND NOT c.classes_only` : ""}${features.map((f) => ` AND ${f}`).join("")})`
    );
    if (opts.sport) params.push(opts.sport);
  }
  const amenities = amenityClauses(opts.amenities);
  clauses.push(...amenities.clauses);
  params.push(...amenities.params);
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
  opts: {
    area?: string;
    sport?: Sport;
    venueIds?: number[];
    near?: Near;
    amenities?: AmenityFilter[];
    courtFilters?: CourtFilter[];
    page?: number;
    pageSize?: number;
  } = {}
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

/** The activities offered at these venues, or anywhere — anywhere customers can reach — in the catalogue's order. */
export async function sportsOfferedAt(venueIds?: number[], opts: { courtsOnly?: boolean } = {}): Promise<Sport[]> {
  // `courtsOnly`: what can be booked as a court, lane or place (search), leaving out what is only run as classes.
  const from = `SELECT DISTINCT ca.sport FROM court_activities ca JOIN courts c ON c.id = ca.court_id JOIN venues v ON v.id = c.venue_id WHERE ${
    listRule(venueIds)
  }${opts.courtsOnly ? " AND NOT c.classes_only" : ""}`;
  const rows = (
    venueIds === undefined
      ? await getDb().prepare(from).all()
      : await getDb()
          .prepare(`${from} AND c.venue_id IN (${venueIds.map(() => "?").join(",") || "NULL"})`)
          .all(...venueIds)
  ) as { sport: Sport }[];
  const offered = new Set(rows.map((r) => r.sport));
  // The catalogue's order, so search lists every activity where it belongs;
  // retired activities still offered somewhere stay findable, after the rest.
  const known = activityKeys();
  return [...known.filter((s) => offered.has(s)), ...[...offered].filter((s) => !known.includes(s)).sort()];
}

/**
 * The same activities, most popular here first: for the home page's few
 * buttons. Popular is what was booked over the last 30 days at the venues in
 * view (a storefront's, an area's), then how many of them offer it, then the
 * catalogue's order. Search keeps the catalogue's order and lists them all.
 */
/**
 * Popularity across the marketplace or an area, kept ten minutes: it counts
 * a month of bookings (about 200 ms at 400 venues) and only orders the home
 * page's buttons, so a few minutes old is as good as now. Asked about given
 * venues (a storefront), it is counted fresh.
 */
const POPULARITY_MS = 10 * 60_000;
const popularity = new Map<string, { at: number; order: Sport[] }>();

export async function activitiesByPopularity(scope: { venueIds?: number[]; area?: string } = {}): Promise<Sport[]> {
  if (scope.venueIds !== undefined) return countPopularity(scope);
  const key = scope.area ?? "";
  const kept = popularity.get(key);
  if (kept && Date.now() - kept.at < POPULARITY_MS) return kept.order;
  const order = await countPopularity(scope);
  if (popularity.size > 500) popularity.clear();
  popularity.set(key, { at: Date.now(), order });
  return order;
}

async function countPopularity(scope: { venueIds?: number[]; area?: string }): Promise<Sport[]> {
  const offered = await sportsOfferedAt(scope.venueIds, { courtsOnly: true });
  const params: unknown[] = [addDays(todayISO(), -30)];
  let where = `${listRule(scope.venueIds)} AND NOT c.classes_only`;
  if (scope.venueIds !== undefined) {
    where += ` AND c.venue_id IN (${scope.venueIds.map(() => "?").join(",") || "NULL"})`;
    params.push(...scope.venueIds);
  }
  if (scope.area) {
    where += " AND v.area = ?";
    params.push(scope.area);
  }
  const venues = (await getDb()
    .prepare(
      `SELECT ca.sport, COUNT(DISTINCT c.venue_id) AS n FROM court_activities ca JOIN courts c ON c.id = ca.court_id JOIN venues v ON v.id = c.venue_id
        WHERE ${where} GROUP BY ca.sport`
    )
    .all(...params.slice(1))) as { sport: Sport; n: number }[];
  const booked = (await getDb()
    .prepare(
      `SELECT b.sport, COUNT(*) AS n FROM bookings b JOIN courts c ON c.id = b.court_id JOIN venues v ON v.id = c.venue_id
        WHERE b.status = 'confirmed' AND b.date >= ? AND ${where} GROUP BY b.sport`
    )
    .all(...params)) as { sport: Sport; n: number }[];
  const rows = venues.map((v) => ({ sport: v.sport, venues: v.n, booked: booked.find((b) => b.sport === v.sport)?.n ?? 0 }));
  const rank = new Map(rows.map((r) => [r.sport, r]));
  const order = (s: Sport) => offered.indexOf(s);
  return [...offered].sort((a, b) => {
    const x = rank.get(a);
    const y = rank.get(b);
    return Number(y?.booked ?? 0) - Number(x?.booked ?? 0) || Number(y?.venues ?? 0) - Number(x?.venues ?? 0) || order(a) - order(b);
  });
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
      `SELECT COUNT(*) AS n FROM courts c JOIN venues v ON v.id = c.venue_id ${filter.sql} AND ${offersSql()} AND NOT c.classes_only`
    )
    .get(...filter.params, input.sport)) as { n: number };
  return n;
}

/** The areas with something to book, for the search page's area list. */
export async function listAreas(venueIds?: number[]): Promise<string[]> {
  return (await listAreaCounts({ venueIds })).map((a) => a.area);
}

/**
 * Find every court across all venues free for the length asked (`minutes`,
 * or `duration` in hours) from a start its booking policy allows inside the
 * window asked on `date`. One result per venue and start time, cheapest
 * first within it.
 */
export async function searchAvailability(input: SearchInput): Promise<SearchResult[]> {
  const db = getDb();
  // As long as any court may be booked; each court's own policy is applied below.
  const length = Math.min(Math.max(input.minutes ?? minutesOf(input.duration ?? 1), 1), MAX_COURT_HOURS * 60);
  // The window of starts asked for, clamped per court below to its own hours.
  const wantFrom = Math.max(input.fromMin ?? (input.fromHour === undefined ? 0 : minutesOf(input.fromHour)), 0);
  // Past midnight too, for a venue open late, unless a time of day was asked for.
  const wantTo = Math.min(input.toMin ?? (input.toHour === undefined ? LATEST_MINUTE : minutesOf(input.toHour)), LATEST_MINUTE);
  const limit = Math.min(Math.max(input.limit ?? 60, 1), 200);
  if (wantFrom > wantTo) return [];

  const params: (string | number)[] = [input.sport];
  let sql = `
    SELECT c.*, v.id AS v_id, v.name AS v_name, v.area AS v_area,
           v.address AS v_address, v.phone AS v_phone,
           v.cancel_cutoff_hours AS v_cutoff,
           v.open_min AS v_open, v.close_min AS v_close, v.week_hours AS v_week_hours, v.time_zone AS v_time_zone,
           v.staffed_from AS v_staffed_from, v.staffed_to AS v_staffed_to, v.partly_unstaffed AS v_partly_unstaffed,
           v.emergency_phone AS v_emergency_phone, v.emergency_info AS v_emergency_info,
           v.published_at AS v_published_at, v.lat AS v_lat, v.lng AS v_lng, v.amenities AS v_amenities,
           v.access AS v_access, v.book_ahead_days AS v_ahead
    FROM courts c JOIN venues v ON v.id = c.venue_id
    WHERE ${offersSql()} AND NOT c.classes_only AND ${listRule(input.venueIds)}
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
  for (const f of input.courtFilters ?? []) sql += ` AND ${courtFilterSql(f)}`;
  const amenities = amenityClauses(input.amenities);
  for (const clause of amenities.clauses) sql += ` AND ${clause}`;
  params.push(...amenities.params);
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
    v_week_hours: string | null;
    v_time_zone: string | null;
    v_staffed_from: number | null;
    v_staffed_to: number | null;
    v_partly_unstaffed?: "code" | "counter";
    v_emergency_phone: string | null;
    v_emergency_info: string | null;
    v_published_at: string | null;
    v_lat: number | null;
    v_lng: number | null;
    v_amenities: string[] | null;
    v_access: "public" | "members" | "private";
    v_ahead: number | null;
  })[];
  // Near somewhere, the box the database searched is cut to the circle before
  // anything is worked out about the courts in its corners.
  const near = input.near;
  const inReach = near ? rows.filter((r) => distanceM(near, { lat: r.v_lat!, lng: r.v_lng! }) / 1000 <= near.km + 0.05) : rows;
  if (inReach.length === 0) return [];
  const zoneOfRow = (row: (typeof rows)[number]) => venueZoneOf({ time_zone: row.v_time_zone, lat: row.v_lat, lng: row.v_lng });
  // Each court as offered for the activity searched for: its rules and rates for it.
  const allCourts = inReach.map((r) => courtFor(toCourt(r), input.sport));
  // Not a court whose policy will not take a booking that long.
  const days = await courtDays(allCourts, input.date);
  const candidates = inReach.filter((row) => lengthAllowed(days.get(row.id)!.policy, length) && !days.get(row.id)!.closed);
  if (candidates.length === 0) return [];
  const zones = new Map(candidates.map((row) => [row.v_id, zoneOfRow(row)]));
  const held = await occupantsOn(candidates.map(toCourt), input.date, (venueId) => zones.get(venueId)!);
  const rulesOf = await peakRulesFor(candidates.map((r) => r.v_id));
  // Search offers starts at least an hour apart (half an hour for a 90-minute
  // game, a quarter for 75), so a court bookable every five minutes does not
  // fill the page; its board shows every start.
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const apart = gcd(length, 60) >= 15 ? gcd(length, 60) : 15;

  const results: SearchResult[] = [];
  for (const row of candidates) {
    // Only on a day the venue takes bookings for, by everybody: a member's longer window is on its own page.
    const zone = zones.get(row.v_id)!;
    if (!isBookableDate(input.date, zone, Math.min(row.v_ahead ?? MAX_ADVANCE_DAYS, MAX_VENUE_AHEAD_DAYS))) continue;
    const day = days.get(row.id)!;
    const court = day.court;
    const venue: Venue = {
      id: row.v_id,
      name: row.v_name,
      area: row.v_area,
      address: row.v_address,
      phone: row.v_phone,
      cancelCutoffHours: row.v_cutoff,
      openMin: day.openMin,
      closeMin: day.closeMin,
      openHour: hoursOf(day.openMin),
      closeHour: hoursOf(day.closeMin),
      timeZone: zone,
      staffedFrom: row.v_staffed_from,
      staffedTo: row.v_staffed_to,
      partlyUnstaffed: row.v_partly_unstaffed ?? "code",
      emergencyPhone: row.v_emergency_phone,
      emergencyInfo: row.v_emergency_info,
      publishedAt: row.v_published_at,
      // Search only finds venues open to customers.
      suspendedAt: null,
      suspendedBy: null,
      suspendedReason: null,
      lat: row.v_lat,
      lng: row.v_lng,
      amenities: cleanAmenities(row.v_amenities),
      access: row.v_access,
    };
    // Inside the box, but is it inside the circle?
    let distanceKm: number | undefined;
    if (input.near) {
      distanceKm = Math.round(distanceM(input.near, { lat: row.v_lat!, lng: row.v_lng! }) / 100) / 10;
      if (distanceKm > input.near.km) continue;
    }
    const occupants = held.get(court.id)!;
    const buffers = policyBuffers(day.policy);
    // A booking of `length` must still finish by the court's close.
    let shownUpTo = -Infinity;
    for (const start of startsWithin(day.policy, Math.max(wantFrom, day.openMin), Math.min(wantTo, day.closeMin - length) + 1)) {
      if (start < shownUpTo + apart || start % apart !== 0) continue;
      const ahead = minutesUntil(input.date, start, zone);
      if (ahead <= 0 || ahead < day.policy.noticeMinutes) continue;
      const span = { start, end: start + length };
      if (!fits(occupants, court.capacity, span, buffers)) continue;
      shownUpTo = start;
      results.push({
        venue,
        court,
        startMin: start,
        endMin: start + length,
        startHour: hoursOf(start),
        endHour: hoursOf(start + length),
        totalPrice: priceBooking({ court, date: input.date, span, rules: rulesOf.get(row.v_id), pricing: day.policy.pricing, at: Date.now() }).total,
        alsoFree: 0,
        pricesVary: false,
        needs: needsOf(day.policy),
        groups: [],
        ...(distanceKm !== undefined ? { distanceKm } : {}),
      });
    }
  }

  results.sort(
    (a, b) =>
      a.startMin - b.startMin ||
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
    const key = `${r.venue.id}:${r.startMin}`;
    const first = shown.get(key);
    if (first) {
      first.alsoFree++;
      if (r.totalPrice !== first.totalPrice) first.pricesVary = true;
      continue;
    }
    shown.set(key, r);
    fair.push(r);
  }
  // Ordered as asked only now, so each venue and time is still its cheapest court.
  if (input.sort === "nearest" && input.near)
    fair.sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0) || a.venue.id - b.venue.id || a.startMin - b.startMin);
  else if (input.sort === "cheapest")
    fair.sort((a, b) => a.totalPrice - b.totalPrice || a.startMin - b.startMin || (a.distanceKm ?? 0) - (b.distanceKm ?? 0) || a.venue.id - b.venue.id);
  const page = fair.slice(0, limit);

  // Kinds under one heading, for the results shown: each kind at that time as
  // itself, from what was read above (no more queries), in the venue grid's order.
  const headed = new Map<number, { heading: string | null; items: typeof candidates }[]>();
  for (const row of candidates) if (row.heading) headed.set(row.v_id, []);
  for (const venueId of headed.keys())
    headed.set(venueId, groupByHeading(candidates.filter((r) => r.v_id === venueId), (r) => r.heading).filter((g) => g.heading !== null));
  for (const r of page) {
    for (const g of headed.get(r.venue.id) ?? []) {
      const kinds = g.items.map((row) => searchKind(row.id, r.startMin, r.endMin));
      if (kinds.some((k) => k.free)) r.groups.push({ heading: g.heading!, kinds });
    }
  }
  // Who is taking part, where anything shown asks for a sign-off: one query for the page, none otherwise.
  if (input.taking) {
    const asking = page.filter((r) => r.needs || r.groups.some((g) => g.kinds.some((k) => k.needs)));
    if (asking.length > 0) {
      const status = await eligibilityAt({ taking: input.taking, sport: input.sport, date: input.date, venueIds: asking.map((r) => r.venue.id) });
      for (const r of asking) {
        const own = status.lines(r.venue.id, r.needs);
        if (own) r.eligibility = own;
        for (const g of r.groups)
          for (const k of g.kinds) {
            const theirs = status.lines(r.venue.id, k.needs);
            if (theirs) k.eligibility = theirs;
          }
      }
    }
  }
  return page;

  /** One kind from `start` to `end`, by its own rules, places and prices. */
  function searchKind(courtId: number, start: number, end: number): SearchKind {
    const day = days.get(courtId)!;
    const court = day.court;
    const span = { start, end };
    const buffers = policyBuffers(day.policy);
    const occupants = held.get(courtId) ?? [];
    const ahead = minutesUntil(input.date, start, zones.get(court.venueId)!);
    const startsThen =
      start >= day.openMin && end <= day.closeMin && ahead > 0 && ahead >= day.policy.noticeMinutes && startsWithin(day.policy, start, start + 1).length > 0;
    const shared = court.capacity > 1;
    return {
      courtId,
      name: court.name,
      free: startsThen && fits(occupants, court.capacity, span, buffers),
      totalPrice: priceBooking({ court, date: input.date, span, rules: rulesOf.get(court.venueId), pricing: day.policy.pricing, at: Date.now() }).total,
      perPlayer: court.perPlayer === true,
      capacity: court.capacity,
      placesLeft: startsThen && shared ? Math.max(court.capacity - peakPlaces(occupants, occupiedFor(court.capacity, span, buffers)), 0) : null,
      needs: needsOf(day.policy),
    };
  }
}

/**
 * What court time from `span.start` to `span.end` costs at the court's
 * rates, pro rata to the minute (lib/pricing.ts), with none of a policy's
 * pricing rules. A member pays the court's member rate where it has one;
 * where it does not, they pay the public rate, so a venue can discount only
 * some of its courts.
 */
export function computePrice(
  court: Court,
  date: string,
  span: Span,
  /**
   * A member pays the court's member rates; a number is a tier's own price
   * level, that percent of the public price (lib/membership-plans.ts).
   */
  member: MemberPricing = false,
  /** The venue's peak hours and holidays, from `peakRules`. */
  rules: PeakRules = DEFAULT_PEAK,
  /**
   * When the booking is being made, for the venue's last-minute prices. Left
   * out, none apply: what a booking already made cost, or a move.
   */
  at?: number
): number {
  return priceBooking({ court, date, span, member, rules, at }).court;
}

export type { MemberPricing };

/**
 * Whether a membership found by this number counts for a booking made this
 * way. The venue's staff and its own system take the number on their word:
 * they see, or know, the person. Online a number is something anybody can
 * type, so it counts only for the account the membership is linked to, or
 * for the account whose own number it is, proved with a code
 * (lib/phone-check.ts). Without `who` (the system re-pricing what it already
 * holds) it counts.
 */
export async function memberNumberTrusted(phone: string, who?: { userId?: number | null; by?: SignOffChannel }): Promise<boolean> {
  if (!who || (who.by ?? "customer") !== "customer") return true;
  if (!who.userId) return false;
  const row = await getDb()
    .prepare(
      `SELECT 1 AS ok FROM users WHERE id = ? AND verified_phone IS NOT NULL AND phone_key(verified_phone) = phone_key(?)
       UNION ALL
       SELECT 1 FROM memberships WHERE user_id = ? AND phone_key(holder_phone) = phone_key(?)
       LIMIT 1`
    )
    .get(who.userId, phone, who.userId, phone);
  return row !== undefined;
}

export async function memberPricing(
  venueId: number,
  phone: string,
  date?: string,
  /** Who is booking, where a number typed online must be the account's own (above). */
  who?: { userId?: number | null; by?: SignOffChannel }
): Promise<MemberPricing> {
  const m = await activeMembership(venueId, phone, date);
  if (!m) return false;
  if (!(await memberNumberTrusted(phone, who))) return false;
  return m.ratePercent ?? true;
}

/**
 * The price of a booking of a court as its policy prices it: the time (or a
 * fixed price), times the players on a court priced per player, at least the
 * minimum charge, and setup and cleanup fees.
 */
export function quoteBooking(
  court: Court,
  policy: BookingPolicy,
  date: string,
  span: Span,
  member: MemberPricing,
  rules: PeakRules,
  at: number | undefined,
  players = 1
): Quote {
  return priceBooking({ court, date, span, member, rules, pricing: policy.pricing, at, players });
}

export { hasMemberRate } from "./pricing";

/**
 * What a booking would cost, before it is made: the price as the booking
 * would be priced now (member rates for a member's number, last-minute
 * prices), with its lines, and whether the court's policy allows that time.
 * Whether it is free is the booking's to find out.
 */
export async function quoteFor(input: {
  courtId: number;
  date: string;
  phone?: string | null;
  players?: number;
  /** The activity, on a court that offers several; its main one if not said. */
  sport?: Sport;
  /** Who is asking, online: a member's price only for the account's own proved or linked number. */
  userId?: number | null;
  by?: SignOffChannel;
  /**
   * Who takes part, where the booking names people (checked by the caller as
   * the booking route checks them): priced as the booking would be, each
   * member's own place at the member's price where their benefit is for
   * their place alone (lib/entitlements.ts `memberPrices`).
   */
  people?: { participants: { id: number }[]; customerTakesPart: boolean };
} & WhenInput): Promise<{ ok: true; span: Span; quote: Quote; allowed: true } | { ok: true; span: Span; quote: Quote; allowed: false; refusal: Refusal } | Refusal> {
  const found = await getCourt(input.courtId);
  if (!found) return refuse("COURT_NOT_FOUND");
  if (input.sport !== undefined && !courtOffers(found, input.sport)) return refuse("SPORT_NOT_HERE", { sport: activityName(input.sport) });
  const court = courtFor(found, input.sport ?? found.sport);
  if (!isValidDateString(input.date)) return refuse("NO_HOURS");
  const day = await courtDay(court, input.date);
  const asked = spanFor(input, day.policy);
  if (!asked.ok) return asked;
  const span = asked.span;
  const players = Math.min(Math.max(1, input.players ?? 1), placesPerBooking(court));
  const rules = await peakRules(court.venueId);
  let quote: Quote;
  if (input.people && input.phone) {
    // As the booking will be priced: by who takes part, each membership by its scope.
    const members = await memberPrices({
      venueId: court.venueId,
      court,
      booker: { phone: input.phone, userId: input.userId, ...(input.by ? { by: input.by } : {}) },
      participants: input.people.participants,
      customerTakesPart: input.people.customerTakesPart || input.people.participants.length === 0,
      date: input.date,
    });
    const now = Date.now();
    quote = quoteBooking(court, day.policy, input.date, span, members.booking?.level ?? false, rules, now, players);
    const off = roundMoney(
      members.places.reduce(
        (s, p) => s + Math.max(0, roundMoney((quote.court - quoteBooking(court, day.policy, input.date, span, p.level, rules, now, players).court) / players)),
        0
      )
    );
    if (off > 0) quote = { ...quote, court: roundMoney(quote.court - off), total: roundMoney(quote.total - off) };
  } else {
    const member = input.phone ? await memberPricing(court.venueId, input.phone, input.date, input.by ? { userId: input.userId, by: input.by } : undefined) : false;
    quote = quoteBooking(court, day.policy, input.date, span, member, rules, Date.now(), players);
  }
  const breaches = policyBreaches(day.policy, span, day, minutesUntil(input.date, span.start, day.zone));
  if (day.closed) return { ok: true, span, quote, allowed: false, refusal: refuse("VENUE_CLOSED") };
  if (breaches.length > 0) return { ok: true, span, quote, allowed: false, refusal: breachRefusal(day.policy, span, breaches[0]) };
  return { ok: true, span, quote, allowed: true };
}

function randomCode(prefix: string): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = prefix;
  // Unpredictable: a code and a phone number together unlock a booking.
  for (let i = 0; i < 6; i++) code += chars[randomInt(chars.length)];
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
  | {
      ok: true;
      bookings: Booking[];
      skipped: SeriesSkip[];
      seriesCode: string | null;
      /** The court's rules staff went past, to be recorded (lib/activity.ts). */
      overrides?: PolicyBreach[];
    }
  | Refusal;

/** Who is booking, where staff book outside a court's policy. */
export interface StaffOverride {
  /** Go past the court's booking policy (starts, lengths, hours, notice, the booking window). Never past what is claimed. */
  override: boolean;
}

export async function createBooking(
  input: {
    courtId: number;
    date: string;
    name: string;
    phone: string;
    email?: string;
    userId?: number;
    players?: number;
    /** The activity, on a court that offers several; its main one if not said. */
    sport?: Sport;
    staff?: StaffOverride;
    /** Who is booking (createBookingSeries). */
    by?: SignOffChannel;
    /** Who takes part, where that is not (only) the customer (createBookingSeries). */
    participants?: { id: number; name: string }[];
    customerTakesPart?: boolean;
    addedBy?: { userId?: number | null; adminId?: number | null };
  } & WhenInput
): Promise<CreateBookingResult> {
  const result = await createBookingSeries({ ...input, weeks: 1 });
  if (!result.ok) return result;
  return { ok: true, booking: result.bookings[0] };
}

/** A broken rule said as the customer is told, under the code the page translates. */
function breachRefusal(policy: BookingPolicy, span: Span, breach: PolicyBreach): Refusal {
  const length = span.end - span.start;
  if (breach === "LENGTH" && !policy.lengths && length > policy.maxLength) return refuse("MAX_HOURS", { max: hoursOf(policy.maxLength) });
  if (breach === "LENGTH" && !policy.lengths && length < policy.minLength) return refuse("MIN_HOURS", { min: hoursOf(policy.minLength) });
  if (breach === "HOURS") return refuse("HOURS_OUTSIDE_OPENING");
  if (breach === "CLOCK") return refuse("CLOCK_CHANGE");
  // Checked apart from the court's rules, by who is booking (createBookingSeries).
  if (breach === "SIGN_OFF" || breach === "MEMBERSHIP") throw new Error("A sign-off or a membership is not one of the court's time rules.");
  const code = ({ START: "POLICY_START", LENGTH: "POLICY_LENGTH", NOTICE: "POLICY_NOTICE" } as const)[breach];
  return refuse(code, { rule: breachMessage(policy, breach) });
}

/**
 * Book a court for a time, weekly for `weeks` weeks. With `skipConflicts`,
 * weeks something else holds are skipped and reported; otherwise any clash
 * fails the whole series.
 *
 * The court's booking policy says what may be asked for; the database says
 * whether it is free. Each week's booking and its claims are written under
 * a savepoint, and the claims' constraints refuse anything that overlaps
 * what is there (lib/claims.ts), so the check that decides is the write
 * itself, not a read before it.
 */
export async function createBookingSeries(
  input: {
    courtId: number;
    date: string;
    weeks: number;
    name: string;
    phone: string;
    email?: string;
    userId?: number;
    skipConflicts?: boolean;
    /** Set when this booking is an enrolment: it holds a place in the class, which holds the court. */
    classId?: number;
    /** The waiting-list offer this booking claims: its own hold is let go for it. */
    waitlistId?: number;
    /**
     * The approval request this booking is made for (lib/approvals.ts): its
     * hold on the slot is let go for it. With `assessment`, the booking is the
     * session at which staff do the request's in-person step, so it is not
     * held to the sign-off the request is for. Set only by lib/approvals.ts,
     * never from a request's body.
     */
    approval?: { id: number; assessment: boolean };
    /**
     * Who takes part, where the signed-in adult books for somebody they
     * manage (lib/managed-people.ts): the sign-off checked is that person's
     * alone. Set by callers that checked the person is the account's own.
     * The same as `participants` with one.
     */
    participant?: { id: number; name: string };
    /**
     * Who takes part, where that is not (only) the customer: each a
     * participant (lib/participants.ts) the caller checked may be booked for
     * by whoever is booking (a guardian online, the venue's staff for one it
     * knows). Each takes a place and is checked on their own eligibility;
     * the customer takes one too only with `customerTakesPart`. Recorded in
     * `booking_participants`, the one record of who takes part.
     */
    participants?: { id: number; name: string }[];
    customerTakesPart?: boolean;
    /** Who put the participants on it, for the record: the account, or staff. */
    addedBy?: { userId?: number | null; adminId?: number | null };
    /**
     * How many: players on a court priced per player, or places on a shared
     * facility (people on a gym floor, kayaks from a fleet).
     */
    players?: number;
    /** The activity booked: one the court offers; its main one if not said. */
    sport?: Sport;
    staff?: StaffOverride;
    /**
     * Who is booking, for checks that depend on who is in front of whom
     * (sign-offs, lib/sign-offs.ts): the customer online (the default), the
     * venue's staff, or the venue's own system through its API key.
     */
    by?: SignOffChannel;
  } & WhenInput,
  attempt = 0
): Promise<CreateSeriesResult> {
  const { courtId, date, weeks, name, phone, email, userId } = input;
  const skipConflicts = (input.skipConflicts ?? false) && weeks > 1;
  const override = input.staff?.override === true;
  // Who takes part: the participants named, and the customer where they take a place too (or nobody else is named).
  const named = input.participants ?? (input.participant ? [input.participant] : []);
  if (new Set(named.map((p) => p.id)).size !== named.length) return refuse("PLAYERS_RANGE", { max: named.length });
  const customerPlays = named.length === 0 || input.customerTakesPart === true;
  const persons = named.length + (customerPlays && named.length > 0 ? 1 : 0);

  const found = await getCourt(courtId);
  if (!found) return refuse("COURT_NOT_FOUND");
  // The court as offered for what is being booked: its rules and rates for that.
  if (input.sport !== undefined && !courtOffers(found, input.sport)) return refuse("SPORT_NOT_HERE", { sport: activityName(input.sport) });
  const court = courtFor(found, input.sport ?? found.sport);
  // How many: places on a shared facility, players on a court priced per player; else one booking, whoever plays.
  const mostPlayers = placesPerBooking(court);
  // Places sold one by one: each person named takes one.
  const players = mostPlayers > 1 && !input.classId ? (input.players ?? Math.max(1, persons)) : 1;
  if (!Number.isInteger(players) || players < 1 || players > mostPlayers) return refuse("PLAYERS_RANGE", { max: mostPlayers });
  if (mostPlayers > 1 && !input.classId && players < persons) return refuse("PLAYERS_RANGE", { max: mostPlayers });
  // As many weeks as the venue allows (eight unless it says), staff too.
  const weeksAllowed = await seriesWeeks(court.venueId);
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > weeksAllowed)
    return refuse("WEEKS_RANGE", { max: weeksAllowed });
  if (!isValidDateString(date)) return refuse("NO_HOURS");
  const day = await courtDay(court, date);
  const { policy, zone } = day;
  // As far ahead as the venue takes bookings at all; who may book how far is lib/house-rules.ts.
  // A class the venue has put in the diary can be joined whenever it is (a term runs past the window).
  if (!input.classId && !override && !isBookableDate(date, zone, await venueAheadDays(court.venueId)))
    return refuse("DATE_OUT_OF_WINDOW_FIRST");
  const asked = spanFor(input, policy);
  if (!asked.ok) return asked;
  const span = asked.span;
  // Closed that day (a closure, or a weekday it never opens) says so, rather than "outside the hours".
  if (day.closed && !input.classId) return refuse("VENUE_CLOSED");
  // The court's rules: customers keep to them; staff allowed to may go past them, and it is recorded.
  const breaches = input.classId ? [] : policyBreaches(policy, span, day, minutesUntil(date, span.start, zone));
  // A change of the clocks is no rule a manager can waive: the booking would mean two moments, or none.
  if (breaches.includes("CLOCK")) return breachRefusal(policy, span, "CLOCK");
  if (breaches.length > 0 && !override) return breachRefusal(policy, span, breaches[0]);
  if (minutesUntil(date, span.start, zone) <= 0) return refuse("SLOT_PAST");
  // A studio run as classes is booked through its classes; the venue's staff may still hire the room out.
  if (court.classesOnly && !input.classId && (input.by ?? "customer") === "customer" && !override) return refuse("CLASSES_ONLY", { sport: activityName(court.sport) });
  // An activity that needs a staff sign-off or a certification first (a belay
  // check, a range briefing; lib/sign-offs.ts), good until the last week
  // booked. Online it must be the customer's own; a manager going past the
  // rules may book without one, and it is recorded as an override.
  const signOffNeed = input.classId || input.approval?.assessment ? null : policy.certification ? "certification" : policy.signOff ? "any" : null;
  if (signOffNeed) {
    const channel = input.by ?? "customer";
    // Everybody taking part, each on their own: the customer's own, and each participant's.
    // The first without one is named, so a guardian ticking several knows whom it is for.
    let lacking: { name: string | null } | null = null;
    for (const who of [...(customerPlays ? [null] : []), ...named]) {
      const holds = await signOffHolds({
        venueId: court.venueId,
        sport: court.sport,
        until: addDays(date, 7 * (weeks - 1)),
        phone,
        userId,
        channel,
        need: signOffNeed,
        participant: who ? who.id : null,
      });
      if (!holds) {
        lacking = { name: who ? who.name : null };
        break;
      }
    }
    const held = lacking === null;
    if (lacking && !override) return signOffRefusal(signOffNeed, activityName(court.sport), lacking.name);
    if (!held) breaches.push("SIGN_OFF");
    // One person's sign-off is for one person: places for others are booked where staff see them.
    if (held && channel === "customer" && players > Math.max(1, persons) && !override) return refuse("SIGN_OFF_EACH", { sport: activityName(court.sport) });
  }
  // A place on a members' session is each person's own to hold (lib/entitlements.ts, ADR 0025): a
  // participant needs their own membership or a family one naming them, on every week booked. A
  // manager going past the rules may book without, and it is recorded as an override.
  const notMember = await membersOnlyRefusal({
    venueId: court.venueId,
    court,
    classId: input.classId ?? null,
    participants: named,
    dates: Array.from({ length: weeks }, (_, w) => addDays(date, 7 * w)),
  });
  if (notMember && !override) return notMember;
  if (notMember) breaches.push("MEMBERSHIP");

  const db = getDb();
  const seriesCode = weeks > 1 ? generateSeriesCode() : null;
  // Member rates are decided per session, against the date that session falls
  // on: a membership that lapses part-way through a weekly series discounts
  // the weeks it covers and no more.
  // Online (`by: "customer"`, as the booking route says) a member's number counts only when it is the account's own, proved or linked.
  // A membership prices a booking its member takes part in, by the scope of its
  // benefit (lib/entitlements.ts `memberPrices`): the whole booking, or only its
  // members' own places on a session priced by the place. One made only for
  // others who are not members (a parent booking their children) is at the
  // public rate, whoever's number it is on (docs/features/pricing.md#memberships-and-member-rates).
  const membersOn = (weekDate: string) =>
    memberPrices({
      venueId: court.venueId,
      court,
      booker: { phone, userId, ...(input.by ? { by: input.by } : {}) },
      participants: named,
      customerTakesPart: customerPlays,
      date: weekDate,
    });
  const rules = await peakRules(court.venueId);
  // A last-minute price is for time nobody wanted, not for a number that
  // cancelled at this venue on this day and is booking again at the lower price.
  const cancelledHere = rules.lastMinute
    ? await db
        .prepare(
          `SELECT 1 FROM bookings b JOIN courts c ON c.id = b.court_id
            WHERE c.venue_id = ? AND b.date = ? AND b.status = 'cancelled' AND b.phone_key = phone_key(?) LIMIT 1`
        )
        .get(court.venueId, date, phone)
    : undefined;
  const bookedAt = cancelledHere ? undefined : Date.now();
  const buffers = policyBuffers(policy);
  const offer = input.waitlistId;

  /** What holds the court that week, said as the customer is told. */
  const reasonFor = async (weekDate: string): Promise<string> => {
    const held = (await occupantsOn([court], weekDate, zone)).get(court.id)!;
    const why = whyTaken(
      held,
      court,
      span,
      buffers,
      (o) => (o.waitlistId !== null && o.waitlistId === offer) || (input.approval !== undefined && o.approvalId === input.approval.id),
      players
    );
    if (why?.why === "class") return "reserved for a class";
    if (why?.why === "blocked") return "closed for maintenance";
    return court.capacity > 1 ? "fully booked" : "already booked";
  };

  try {
    const result = await withTransaction(async () => {
      // Ids only: each booking is read back once the transaction has committed.
      // Reading them here, by id, put every booking at the same moment on the
      // same index page as every other, and Postgres stopped some (B13).
      const bookingIds: number[] = [];
      const skipped: SeriesSkip[] = [];
      // The offer being claimed holds the time for this booking: let it go first.
      if (offer) await release({ kind: "offer", waitlistId: offer });
      // So does an approval request's hold on the slot it asked for.
      if (input.approval) await release({ kind: "approval", approvalId: input.approval.id });
      for (let week = 0; week < weeks; week++) {
        const weekDate = addDays(date, week * 7);
        let reason: string | null = null;
        if (week > 0 && (await getVenueClosure(court.venueId, weekDate))) reason = "venue closed";
        const members = await membersOn(weekDate);
        const member: MemberPricing = members.booking?.level ?? false;
        const quote = quoteBooking(court, policy, weekDate, span, member, rules, bookedAt, players);
        // A member's own place at the member's price, the others' at the public one: each place's share of the court time.
        // (A class is priced at the class's rate instead.)
        const memberPlaces = input.classId
          ? []
          : members.places
              .map((p) => ({
                ...p,
                amount: roundMoney((quote.court - quoteBooking(court, policy, weekDate, span, p.level, rules, bookedAt, players).court) / players),
              }))
              .filter((p) => p.amount > 0);
        const placeOff = roundMoney(memberPlaces.reduce((s, p) => s + p.amount, 0));
        let bookingId: number | null = null;
        if (!reason) {
          try {
            bookingId = await withTransaction(async () => {
              const id = (await db
                .prepare(
                  `INSERT INTO bookings (code, court_id, sport, date, start_min, end_min, starts_at, ends_at, name, phone, email, total_price,
                     fee_amount, user_id, series_code, check_in_token, class_id, players, policy_override, last_minute)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
                )
                .get(
                  generateCode(), courtId, court.sport, weekDate, span.start, span.end,
                  instantOf(weekDate, span.start, zone).toISOString(), instantOf(weekDate, span.end, zone).toISOString(),
                  name, phone, email ?? null, roundMoney(quote.total - placeOff), quote.fees,
                  userId ?? null, seriesCode, randomBytes(16).toString("hex"),
                  input.classId ?? null, players, breaches.length > 0,
                  quote.total < quoteBooking(court, policy, weekDate, span, member, rules, undefined, players).total ? 1 : 0
                )) as { id: number };
              // Who takes part, where that is somebody other than (or as well as) the customer.
              await placeParticipants(id.id, {
                participants: named,
                customerTakesPart: customerPlays,
                customerName: name,
                addedBy: input.addedBy ?? { userId: userId ?? null },
              });
              // Each member's own place at the member's price, kept per place (lib/entitlements.ts).
              if (memberPlaces.length > 0) {
                const places = await placeRows(id.id);
                for (const p of memberPlaces) {
                  const place = places.find((x) => (p.participantId === null ? x.customer : x.participantId === p.participantId));
                  if (!place) continue;
                  await db
                    .prepare("INSERT INTO place_benefits (booking_id, place_id, participant_id, kind, membership_id, amount) VALUES (?, ?, ?, 'membership', ?, ?)")
                    .run(id.id, place.placeId, p.participantId, p.membershipId, p.amount);
                }
              }
              // An enrolment holds a place in its class; the class holds the court.
              if (!input.classId)
                await claim({ court, source: { kind: "booking", bookingId: id.id }, date: weekDate, span, zone, places: players, ...claimBuffers(policy) });
              return id.id;
            });
          } catch (err) {
            if (!isConflict(err)) throw err;
            reason = await reasonFor(weekDate);
          }
        }
        if (reason || bookingId === null) {
          if (!skipConflicts) throw new Error(`CONFLICT:${weekDate}:${reason}`);
          skipped.push({ date: weekDate, reason: reason ?? "already booked" });
          continue;
        }
        bookingIds.push(bookingId);
      }
      if (bookingIds.length === 0) throw new Error("ALL_CONFLICT");
      return { bookingIds, skipped };
    });
    const bookings: Booking[] = [];
    for (const id of result.bookingIds) bookings.push((await getBookingById(id))!);
    return { ok: true, bookings, skipped: result.skipped, seriesCode, ...(breaches.length > 0 ? { overrides: breaches } : {}) };
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
    if (isUniqueViolation(err, "bookings")) {
      // Astronomically rare code collision — one retry is plenty.
      if (attempt < MAX_SEAT_RETRIES) return await createBookingSeries(input, attempt + 1);
      throw err;
    }
    // Inside a group booking the group's transaction is the one that retries and answers.
    if (isBusy(err)) return refuse("BUSY");
    throw err;
  }
}

/** What cancelling one week of a series would do, shown before it is done. */
export interface SeriesWeek {
  code: string;
  date: string;
  startHour: number;
  endHour: number;
  /**
   * `free`: inside the free-cancellation window; `late`: past it, where the
   * venue lets late cancels go for a share; `stays`: past it where the venue
   * does not, or with kit still out on it.
   */
  outcome: "free" | "late" | "stays";
  /** What the venue keeps of what was paid, as a percentage, on a late cancel. */
  keptPercent: number | null;
  /** Paid for it so far (or its deposit), less shares players paid. */
  paid: number;
  /** Goes back on cancelling. */
  refund: number;
  /** Kept by the venue on cancelling. */
  kept: number;
  /** Still to pay where it stays booked. */
  owed: number;
  /** A late cancel of a week never paid counts towards the venue's strikes. */
  strike: boolean;
  /** Why it stays: the cutoff, or kit on hire. */
  reason?: "cutoff" | "kit";
}

/** How a late cancel of this booking goes, if the venue allows one; null where it is free or not allowed. */
export async function lateTerms(booking: Booking): Promise<{ late: boolean; share: number; keptPercent: number | null; allowed: boolean }> {
  const cutoff = await cancelCutoffForBooking(booking.id);
  const zone = await courtZone(booking.courtId);
  if (isWithinCancelWindow(booking.date, booking.startHour, cutoff, zone)) return { late: false, share: 1, keptPercent: null, allowed: true };
  const court = await getCourt(booking.courtId);
  const { lateKeep } = court ? await cancelPolicyFor(court.venueId, booking.sport) : { lateKeep: null };
  if (lateKeep === null || isPastSlot(booking.date, booking.startHour, zone)) return { late: true, share: 0, keptPercent: null, allowed: false };
  return { late: true, share: (100 - lateKeep) / 100, keptPercent: lateKeep, allowed: true };
}

async function seriesRows(seriesCode: string, phone: string): Promise<BookingRow[]> {
  return (await getDb()
    .prepare(
      "SELECT * FROM bookings WHERE UPPER(series_code) = UPPER(?) AND phone_key = phone_key(?) AND status = 'confirmed' ORDER BY date, start_min"
    )
    .all(seriesCode.trim(), phone.trim())) as BookingRow[];
}

/**
 * Each upcoming week of a series and what cancelling it would do: weeks
 * inside the free window go back in full; weeks past it go for the venue's
 * late-cancel share where it allows one, and otherwise stay booked (and
 * owed). Weeks already started are not listed.
 */
export async function seriesCancelPlan(
  seriesCode: string,
  phone: string
): Promise<{ ok: true; weeks: SeriesWeek[] } | Refusal> {
  const rows = await seriesRows(seriesCode, phone);
  if (rows.length === 0) return refuse("SERIES_NOT_FOUND");
  const zone = await courtZone(rows[0].court_id);
  const weeks: SeriesWeek[] = [];
  for (const row of rows) {
    if (isPastSlot(row.date, hoursOf(row.start_min), zone)) continue;
    const booking = toBooking(row);
    const terms = await lateTerms(booking);
    const paid =
      booking.paymentStatus === "paid"
        ? roundMoney((booking.totalPrice - (booking.sharesPaid ?? 0)) * (await paidPartLeft(booking.id)))
        : roundMoney(booking.depositPaid ?? 0);
    const kit = await hasOpenHire(booking.id);
    const outcome = kit || !terms.allowed ? "stays" : terms.late ? "late" : "free";
    const kept = outcome === "stays" ? 0 : roundMoney(paid * (1 - terms.share));
    weeks.push({
      code: booking.code,
      date: booking.date,
      startHour: booking.startHour,
      endHour: booking.endHour,
      outcome,
      keptPercent: outcome === "late" ? terms.keptPercent : null,
      paid,
      refund: outcome === "stays" ? 0 : roundMoney(paid - kept),
      kept,
      owed: outcome === "stays" && booking.paymentStatus !== "paid" ? roundMoney(booking.totalPrice - (booking.sharesPaid ?? 0) - paid) : 0,
      strike: outcome === "late" && paid === 0,
      ...(outcome === "stays" ? { reason: kit ? ("kit" as const) : ("cutoff" as const) } : {}),
    });
  }
  return { ok: true, weeks };
}

/**
 * Cancel weeks of a series (verified by phone), each on its own terms, all
 * in one transaction. With `choice`, exactly the weeks named, those past the
 * free window only where the customer accepted the late terms they were
 * shown; a week whose terms changed since (it crossed the cutoff) refuses the
 * lot, so nothing is cancelled on terms nobody saw. Without it, only the
 * weeks free to cancel; the rest are returned with why they were left.
 */
export async function cancelSeries(
  seriesCode: string,
  phone: string,
  choice?: { codes: string[]; acceptLate?: string[] }
): Promise<
  | { ok: true; cancelled: number; bookingIds: number[]; weeks: SeriesWeek[]; left: SeriesWeek[] }
  | (Refusal & { cancelled: number })
> {
  const plan = await seriesCancelPlan(seriesCode, phone);
  if (!plan.ok) return { ...plan, cancelled: 0 };
  const byCode = new Map(plan.weeks.map((w) => [w.code.toUpperCase(), w]));
  let chosen: SeriesWeek[];
  if (choice) {
    const accepted = new Set((choice.acceptLate ?? []).map((c) => c.toUpperCase()));
    chosen = [];
    for (const code of new Set(choice.codes.map((c) => c.toUpperCase()))) {
      const week = byCode.get(code);
      if (!week || week.outcome === "stays" || (week.outcome === "late" && !accepted.has(code)))
        return { ...refuse("SERIES_CHANGED"), cancelled: 0 };
      chosen.push(week);
    }
  } else chosen = plan.weeks.filter((w) => w.outcome === "free");
  const all = await seriesRows(seriesCode, phone);
  if (chosen.length === 0) return { ...refuse("SERIES_NONE_LEFT", { n: all.length > 0 ? await cancelCutoffForBooking(all[0].id) : 0 }), cancelled: 0 };

  const db = getDb();
  const rows = new Map(all.map((r) => [r.code.toUpperCase(), r]));
  // Claimed one by one, so a second request at the same moment cancels (and refunds) nothing twice.
  const claimed: BookingRow[] = [];
  // Each refunded in the same transaction that cancels it (M15): a crash part-way
  // leaves a week either booked or cancelled and refunded, never one without the other.
  await db.transaction(async () => {
    claimed.length = 0;
    for (const week of chosen) {
      const row = rows.get(week.code.toUpperCase());
      if (!row) continue;
      const done = await db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ? AND status = 'confirmed'").run(row.id);
      if (done.changes !== 1) continue;
      await releaseBooking(row.id);
      const share = week.outcome === "late" ? (100 - (week.keptPercent ?? 0)) / 100 : 1;
      if (week.outcome === "late")
        await db.prepare("UPDATE bookings SET late_cancelled = 1, late_kept_percent = ? WHERE id = ?").run(week.keptPercent, row.id);
      await refundBooking(row.id, share);
      claimed.push(row);
    }
  })();
  // Each freed week goes to whoever has waited longest for it.
  for (const row of claimed) await offerSlotPlace(row.court_id, row.date);
  const done = new Set(claimed.map((r) => r.code.toUpperCase()));
  return {
    ok: true,
    cancelled: claimed.length,
    bookingIds: claimed.map((r) => r.id),
    weeks: chosen.filter((w) => done.has(w.code.toUpperCase())),
    left: plan.weeks.filter((w) => !done.has(w.code.toUpperCase())),
  };
}

export async function getBookingById(id: number): Promise<Booking | null> {
  const db = getDb();
  const row = await db.prepare("SELECT b.*, ci.checked_in_at, ci.checked_out_at FROM bookings b LEFT JOIN check_ins ci ON ci.booking_id = b.id WHERE b.id = ?").get(id) as BookingRow | undefined;
  return row ? toBooking(row) : null;
}

/** A booking by its code alone, for callers that have checked something else (a signed receipt link). */
export async function findBookingByCode(code: string): Promise<Booking | null> {
  const row = (await getDb()
    .prepare("SELECT b.*, ci.checked_in_at, ci.checked_out_at FROM bookings b LEFT JOIN check_ins ci ON ci.booking_id = b.id WHERE UPPER(b.code) = UPPER(?)")
    .get(code)) as BookingRow | undefined;
  return row ? toBooking(row) : null;
}

export async function findBooking(code: string, phone: string): Promise<Booking | null> {
  const db = getDb();
  const row = await db
    .prepare("SELECT b.*, ci.checked_in_at, ci.checked_out_at FROM bookings b LEFT JOIN check_ins ci ON ci.booking_id = b.id WHERE UPPER(b.code) = UPPER(?) AND b.phone_key = phone_key(?)")
    .get(code.trim(), phone.trim()) as BookingRow | undefined;
  return row ? toBooking(row) : null;
}

export type CancelResult =
  | {
      ok: true;
      booking: Booking;
      /** A late cancellation: what the venue kept of what was paid (0 for one never paid). */
      kept?: number;
    }
  | Refusal;

/** The cancellation cutoff of the venue a booking belongs to. */
export async function cancelCutoffForBooking(bookingId: number): Promise<number> {
  const row = await getDb()
    .prepare(`
      SELECT COALESCE(sr.cancel_cutoff_hours, v.cancel_cutoff_hours) AS hours FROM bookings b
      JOIN courts c ON c.id = b.court_id
      JOIN venues v ON v.id = c.venue_id
      -- The sport's own, where the venue gave it one (lib/sport-rules.ts).
      LEFT JOIN sport_rules sr ON sr.venue_id = v.id AND sr.sport = b.sport
      WHERE b.id = ?
    `)
    .get(bookingId) as { hours: number } | undefined;
  return row?.hours ?? 0;
}

/**
 * Why a customer may no longer change this booking's time, if they may not:
 * it is inside the venue's cancellation cutoff, or has started. Asked before
 * any time is offered, and again when one is chosen.
 */
export async function customerChangeRefusal(booking: Booking): Promise<Refusal | null> {
  const cutoff = await cancelCutoffForBooking(booking.id);
  const { zone } = await courtVenueHours(booking.courtId);
  if (isWithinCancelWindow(booking.date, booking.startHour, cutoff, zone)) return null;
  return cutoff === 0 ? refuse("RESCHEDULE_STARTED") : refuse("RESCHEDULE_CUTOFF", { n: cutoff });
}

/** The last moment a booking's customer may still change it: its start, less the venue's cancellation cutoff. */
export async function changeDeadline(bookingId: number): Promise<Date | null> {
  const row = (await getDb().prepare("SELECT starts_at FROM bookings WHERE id = ?").get(bookingId)) as { starts_at: string | Date | null } | undefined;
  if (!row?.starts_at) return null;
  return new Date(new Date(row.starts_at).getTime() - (await cancelCutoffForBooking(bookingId)) * 3_600_000);
}

function cutoffMessage(hours: number): string {
  return hours === 0
    ? "This booking has already started and can no longer be cancelled."
    : `Bookings can only be cancelled at least ${hours} hour${hours === 1 ? "" : "s"} before they start. Please call the venue.`;
}

async function cancelBookingOnce(code: string, phone: string): Promise<CancelResult> {
  const booking = await findBooking(code, phone);
  if (!booking) return refuse("BOOKING_NOT_FOUND_CODE");
  return customerCancel(booking);
}

/**
 * A customer cancelling their own booking. Free up to the venue's cutoff,
 * everything going back as it was paid. After the cutoff, only where the
 * venue allows late cancelling (lib/cancel-policy.ts): it keeps its share of
 * what was paid and the rest goes back; one never paid counts as a strike.
 * Once the booking has started it cannot be cancelled at all.
 */
async function customerCancel(booking: Booking): Promise<CancelResult> {
  if (booking.status === "cancelled") return refuse("ALREADY_CANCELLED");
  if (await hasOpenHire(booking.id))
    return refuse("KIT_STILL_OUT");
  const cutoff = await cancelCutoffForBooking(booking.id);
  const zone = await courtZone(booking.courtId);
  let share = 1;
  let keptPercent: number | null = null;
  // Late: past the free-cancellation cutoff, which the venue may allow for a share of the price.
  const late = !isWithinCancelWindow(booking.date, booking.startHour, cutoff, zone);
  if (late) {
    const court = await getCourt(booking.courtId);
    const { lateKeep } = court ? await cancelPolicyFor(court.venueId, booking.sport) : { lateKeep: null };
    if (lateKeep === null || isPastSlot(booking.date, booking.startHour, zone))
      return { ok: false, error: cutoffMessage(cutoff) };
    share = (100 - lateKeep) / 100;
    keptPercent = lateKeep;
  }

  const db = getDb();
  // Claimed in one statement: of two cancels at the same moment, only one refunds.
  // Refunded in the same transaction (M15): cancelled means refunded, even if the server stops a moment later.
  const claimed = await db.transaction(async () => {
    const done = await db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ? AND status = 'confirmed'").run(booking.id);
    if (done.changes !== 1) return false;
    await releaseBooking(booking.id);
    if (late) await db.prepare("UPDATE bookings SET late_cancelled = 1, late_kept_percent = ? WHERE id = ?").run(keptPercent, booking.id);
    await refundBooking(booking.id, share);
    return true;
  })();
  if (!claimed) return refuse("ALREADY_CANCELLED");
  // A freed place goes to whoever has waited longest.
  if (booking.classId) await offerClassPlace(booking.classId);
  else await offerSlotPlace(booking.courtId, booking.date);
  const kept =
    booking.paymentStatus === "paid"
      ? roundMoney((booking.totalPrice - (booking.sharesPaid ?? 0)) * (await paidPartLeft(booking.id)) * (1 - share))
      : roundMoney((booking.depositPaid ?? 0) * (1 - share));
  return { ok: true, booking: { ...booking, status: "cancelled" }, ...(late ? { kept } : {}) };
}

export type AdminSlotStatus = "free" | "booked" | "blocked" | "past";

/** One thing on a court's day, as staff see it: exact times, and why. */
export interface ScheduleEntry {
  kind: "booking" | "offer" | "move" | "approval" | "class" | "block" | "outage" | "buffer";
  /** Minutes of the day. */
  start: number;
  end: number;
  /** A booking's code and booker, a class's name, a block's reason; for a buffer, what it is kept for. */
  label: string;
  /** The label as a phrase a staff screen says in the staff language, where MySenam worded it. */
  phrase?: StaffText;
  bookingCode?: string;
  blockId?: number;
  /** Places it holds of a shared facility. */
  places?: number;
  /** Made on another court sharing this one's floor. */
  viaCourt?: number;
}

export interface AdminCourtSlots {
  court: Court;
  /** The schedule's column width in minutes. */
  grid: number;
  slots: {
    minute: number;
    hour: number;
    status: AdminSlotStatus;
    /** Places taken in this column (0 or 1 for an exclusive court). */
    booked: number;
    /** Something holds part of it, not all. */
    partly?: boolean;
    /** Only meaningful for an exclusive court. */
    bookingCode?: string;
    /** Places out of service, while some remain bookable. */
    blockedPlaces?: number;
    blockReason?: string;
    /** The reason as a phrase, where MySenam worded it ("Closed"). */
    blockReasonPhrase?: StaffText;
  }[];
  /** Everything on the court that day, with buffers, to the minute. */
  entries: ScheduleEntry[];
}

/** The staff schedule's column width at a venue: the finest any of its courts' policies draws, never under 15 minutes. */
export async function scheduleGrid(venueId: number): Promise<number> {
  const courts = (
    (await getDb().prepare("SELECT * FROM courts WHERE venue_id = ? ORDER BY id").all(venueId)) as CourtRow[]
  ).map(toCourt);
  if (courts.length === 0) return 60;
  const policies = await policiesFor(courts);
  return Math.max(15, Math.min(...courts.map((c) => gridMinutes(policies.get(c.id)!))));
}

/** The staff schedule of a venue on a date: columns for blocking, and every entry to the minute. */
export async function getAdminSlots(venueId: number, date: string): Promise<AdminCourtSlots[]> {
  const db = getDb();
  const courts = (
    await db.prepare("SELECT * FROM courts WHERE venue_id = ? ORDER BY id").all(venueId) as CourtRow[]
  ).map(toCourt);
  if (courts.length === 0) return [];
  const { openMin, closeMin, zone } = await venueHours(venueId, date);
  const closure = await getVenueClosure(venueId, date);
  const grid = await scheduleGrid(venueId);
  const held = await occupantsOn(courts, date, zone);
  const all = [...held.values()].flat();
  const bookingIds = [...new Set(all.map((o) => o.bookingId).filter((id): id is number => id !== null))];
  const bookings = new Map(
    (bookingIds.length
      ? ((await db.prepare(`SELECT id, code, name FROM bookings WHERE id IN (${bookingIds.map(() => "?").join(",")})`).all(...bookingIds)) as {
          id: number;
          code: string;
          name: string;
        }[])
      : []
    ).map((b) => [b.id, b])
  );
  const blockIds = [...new Set(all.map((o) => o.blockId).filter((id): id is number => id !== null))];
  const blockReasons = new Map(
    (blockIds.length
      ? ((await db.prepare(`SELECT id, reason FROM blocks WHERE id IN (${blockIds.map(() => "?").join(",")})`).all(...blockIds)) as {
          id: number;
          reason: string | null;
        }[])
      : []
    ).map((b) => [b.id, b.reason ?? ""])
  );
  const outageIds = [...new Set(all.map((o) => o.outageId).filter((id): id is number => id !== null))];
  const outageReasons = new Map(
    (outageIds.length
      ? ((await db.prepare(`SELECT id, reason FROM court_outages WHERE id IN (${outageIds.map(() => "?").join(",")})`).all(...outageIds)) as {
          id: number;
          reason: string | null;
        }[])
      : []
    ).map((o) => [o.id, o.reason])
  );
  const classNames = await classNamesFor(all.map((o) => o.classId).filter((id): id is number => id !== null));
  // An outage nobody gave a reason for is out of service: MySenam's words, so a phrase too.
  const unexplained = (o: Occupant) => o.outageId !== null && outageReasons.has(o.outageId) && outageReasons.get(o.outageId) === null;
  const reasonOf = (o: Occupant) =>
    o.blockId !== null
      ? (blockReasons.get(o.blockId) ?? "")
      : o.outageId !== null
        ? unexplained(o)
          ? englishOf(said("srv.sch.outOfService"))
          : (outageReasons.get(o.outageId) ?? "")
        : undefined;

  return courts.map((court) => {
    // As held, separation included: what each keeps free around it reads as a buffer.
    const occupants = asShown(held.get(court.id)!);
    // A shared facility turned over whole is closed to everybody while it is.
    const clear = occupants.flatMap(clearZones);
    const entries: ScheduleEntry[] = [];
    for (const o of occupants) {
      const clip = (n: number) => Math.min(Math.max(n, 0), LATEST_MINUTE);
      const via = o.viaCourt !== court.id ? { viaCourt: o.viaCourt } : {};
      const places = court.capacity > 1 ? { places: o.places } : {};
      const b = o.bookingId !== null ? bookings.get(o.bookingId) : undefined;
      const label =
        o.kind === "booking"
          ? `${b?.code ?? ""} ${b?.name ?? ""}`.trim()
          : o.kind === "class"
            ? (classNames.get(o.classId!) ?? "Class")
            : o.kind === "offer"
              ? "Offered to the waiting list"
              : o.kind === "move"
                ? "Held for a game's proposed new time"
                : o.kind === "approval"
                  ? // Named by the schedule in the staff language, by its kind.
                    ""
                  : (reasonOf(o) ?? "");
      const phrase =
        o.kind === "class" && !classNames.has(o.classId!)
          ? said("srv.sch.class")
          : o.kind === "offer"
            ? said("srv.sch.offer")
            : o.kind === "move"
              ? said("srv.sch.move")
              : unexplained(o)
                ? said("srv.sch.outOfService")
                : undefined;
      entries.push({
        kind: o.kind,
        start: clip(o.span.start),
        end: clip(o.span.end),
        label,
        ...(phrase ? { phrase } : {}),
        ...(b ? { bookingCode: b.code } : {}),
        ...(o.blockId !== null ? { blockId: o.blockId } : {}),
        ...places,
        ...via,
      });
      // Staff see the buffers, and what they are kept for.
      const kept = (side: "before" | "after") => {
        const said_ = label ? said(`srv.sch.kept.${side}`, { label: phrase ?? label }) : said(`srv.sch.kept.${side}.bare`);
        return { label: englishOf(said_), phrase: said_ };
      };
      if (o.occupied.start < o.span.start)
        entries.push({ kind: "buffer", start: clip(o.occupied.start), end: clip(o.span.start), ...kept("before"), ...via });
      if (o.occupied.end > o.span.end)
        entries.push({ kind: "buffer", start: clip(o.span.end), end: clip(o.occupied.end), ...kept("after"), ...via });
    }
    entries.sort((a, b) => a.start - b.start || a.end - b.end);
    const slots: AdminCourtSlots["slots"] = [];
    for (let minute = openMin; minute < closeMin; minute += grid) {
      const cell = { start: minute, end: Math.min(minute + grid, closeMin) };
      const inCell = occupants.filter((o) => overlaps(o.occupied, cell));
      const count = peakPlaces(
        inCell.filter((o) => o.kind === "booking" || o.kind === "offer" || o.kind === "move" || o.kind === "approval" || o.kind === "class"),
        cell
      );
      const blocks = inCell.filter((o) => o.kind === "block" || o.kind === "outage");
      const out = peakPlaces(blocks, cell);
      const block = blocks[0];
      // A whole-day closure reads as a block on every column that is not sold.
      const blockReason = block !== undefined ? (reasonOf(block) ?? "") : closure ? (closure.reason ?? englishOf(said("srv.sch.closed"))) : undefined;
      const blockReasonPhrase =
        block !== undefined ? (unexplained(block) ? said("srv.sch.outOfService") : undefined) : closure && closure.reason === null ? said("srv.sch.closed") : undefined;
      // A shared facility only reads as "booked" once every place is gone, and
      // a partial block only reads as "blocked" once it has taken the last one.
      const shutByBlock = closure !== null || (block !== undefined && count + out >= court.capacity);
      const booking = inCell.find((o) => o.kind === "booking" && o.bookingId !== null);
      // While a facility turned over whole is kept clear, it reads as held, as a buffer does on a court of one place.
      const cleared = clear.filter((z) => overlaps(z, cell));
      const turning = cleared.some((z) => z.start <= cell.start && z.end >= cell.end);
      const status: AdminSlotStatus =
        count >= court.capacity || turning ? "booked" : shutByBlock ? "blocked" : minutesUntil(date, minute, zone) <= 0 ? "past" : "free";
      const covered =
        court.capacity === 1
          ? inCell.length > 0 && !inCell.some((o) => o.occupied.start <= cell.start && o.occupied.end >= cell.end)
          : !turning && cleared.length > 0;
      slots.push({
        minute,
        hour: hoursOf(minute),
        status,
        booked: count,
        ...(covered ? { partly: true } : {}),
        ...(court.capacity === 1 && booking ? { bookingCode: bookings.get(booking.bookingId!)?.code } : {}),
        ...(blockReason !== undefined ? { blockReason } : {}),
        ...(blockReasonPhrase ? { blockReasonPhrase } : {}),
        ...(out > 0 && !shutByBlock ? { blockedPlaces: out } : {}),
      });
    }
    return { court, grid, slots, entries };
  });
}

export type BlockResult = { ok: true; changed: number; blockIds: number[] } | Refusal;

/** What a block is for, beyond its time. */
export interface BlockDetails {
  reason?: string | null;
  /** Places out of a shared facility; omitted for the whole court. */
  places?: number | null;
  repeatCode?: string | null;
  tournamentId?: number | null;
  /** A competition's hold, shared by its divisions (lib/competitions.ts). */
  competitionId?: number | null;
}

/** Write one block and claim its time. Throws `23P01` when something holds it. */
async function writeBlock(court: Court, date: string, span: Span, zone: string, details: BlockDetails): Promise<number> {
  const row = (await getDb()
    .prepare(
      `INSERT INTO blocks (venue_id, court_id, date, start_min, end_min, reason, places, repeat_code, tournament_id, competition_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .get(
      court.venueId,
      court.id,
      date,
      span.start,
      span.end,
      details.reason ?? null,
      details.places ?? null,
      details.repeatCode ?? null,
      details.tournamentId ?? null,
      details.competitionId ?? null
    )) as { id: number };
  await claim({ court, source: { kind: "block", blockId: row.id }, date, span, zone, places: details.places ?? court.capacity });
  return row.id;
}

/**
 * Take block time within `span` off a court: blocks inside it go, and blocks
 * across its edges keep their parts outside it. Returns the minutes freed.
 */
async function carveBlocks(
  court: Court,
  date: string,
  span: Span,
  zone: string,
  only?: (b: { tournament_id: number | null; competition_id: number | null }) => boolean
): Promise<number> {
  const db = getDb();
  const rows = (await db
    .prepare("SELECT * FROM blocks WHERE court_id = ? AND date = ? AND start_min < ? AND end_min > ?")
    .all(court.id, date, span.end, span.start)) as {
    id: number;
    start_min: number;
    end_min: number;
    reason: string | null;
    places: number | null;
    repeat_code: string | null;
    tournament_id: number | null;
    competition_id: number | null;
  }[];
  let freed = 0;
  for (const b of rows) {
    if (only && !only(b)) continue;
    await db.prepare("DELETE FROM blocks WHERE id = ?").run(b.id);
    freed += Math.min(b.end_min, span.end) - Math.max(b.start_min, span.start);
    const keep = { reason: b.reason, places: b.places, repeatCode: b.repeat_code, tournamentId: b.tournament_id, competitionId: b.competition_id };
    if (b.start_min < span.start) await writeBlock(court, date, { start: b.start_min, end: span.start }, zone, keep);
    if (b.end_min > span.end) await writeBlock(court, date, { start: span.end, end: b.end_min }, zone, keep);
  }
  return freed;
}

/** Turn what a block request gives into spans: exact minutes, or columns of the staff schedule (runs of them). */
async function blockSpans(court: Court, when: number[] | WhenInput, openMin: number, closeMin: number): Promise<{ spans: Span[]; cells: number[]; grid: number }> {
  const grid = await scheduleGrid(court.venueId);
  if (!Array.isArray(when) && when.start !== undefined) {
    const end = when.end ?? (when.minutes !== undefined ? when.start + when.minutes : undefined);
    if (!isMinute(when.start) || !isMinute(end) || end <= when.start) return { spans: [], cells: [], grid };
    const span = { start: Math.max(when.start, openMin), end: Math.min(end, closeMin) };
    return span.end > span.start ? { spans: [span], cells: [span.start], grid } : { spans: [], cells: [], grid };
  }
  const hours = Array.isArray(when) ? when : (when.hours ?? []);
  const cells = [...new Set(hours.filter((h) => typeof h === "number" && Number.isFinite(h)).map(minutesOf))]
    .filter((m) => m >= openMin && m < closeMin && (m - openMin) % grid === 0)
    .sort((a, b) => a - b);
  const spans: Span[] = [];
  for (const m of cells) {
    const end = Math.min(m + grid, closeMin);
    const last = spans[spans.length - 1];
    if (last && last.end === m) last.end = end;
    else spans.push({ start: m, end });
  }
  return { spans, cells, grid };
}

/**
 * Block time on a court (maintenance, a school's lessons, a tournament's
 * hold). What is already held is left to its holder: the block covers the
 * rest of the time asked for, and a shared facility's places are taken out
 * only where that many are free. Blocking time already blocked revises it.
 */
export async function blockSlots(
  courtId: number,
  date: string,
  /** Exact minutes, or the starts of the staff schedule's columns ([9, 10] on a schedule of hours). */
  when: number[] | WhenInput,
  reason?: string,
  /**
   * How many places to take out. Omitted means the whole resource, which is
   * the only thing a court can mean. On a shared facility a number takes that
   * many places out and leaves the rest bookable.
   */
  places?: number,
  details: Omit<BlockDetails, "reason" | "places"> = {}
): Promise<BlockResult> {
  const court = await getCourt(courtId);
  if (!court) return refuse("COURT_NOT_FOUND");
  const { openMin, closeMin, zone } = await courtVenueHours(courtId, date);
  const { spans, cells, grid } = await blockSpans(court, when, openMin, closeMin);
  if (spans.length === 0) return { ok: false, error: "No valid hours given." };

  const partial = places !== undefined && places !== null;
  if (partial) {
    if (!Number.isInteger(places) || places! < 1 || places! > court.capacity)
      return { ok: false, error: `Places out must be 1–${court.capacity}.` };
    if (court.capacity === 1)
      return { ok: false, error: "An exclusive court is blocked whole, not in parts." };
  }
  const wanted = partial ? places! : court.capacity;

  let blockIds: number[] = [];
  let strandedAt: number | null = null;
  let strandedFree = 0;
  const writeBlocks = () => withTransaction(async () => {
    // Blocking blocked time revises it, rather than stacking a second block. A
    // tournament's hold leaves blocks staff made where they are: that time is
    // simply not the tournament's.
    if (!details.tournamentId && !details.competitionId)
      for (const span of spans) await carveBlocks(court, date, span, zone, (b) => b.tournament_id === null && b.competition_id === null);
    // A block keeps no buffers of its own, so it may go wherever nothing holds or keeps the time (separation included).
    const occupants = asShown((await occupantsOn([court], date, zone)).get(court.id)!);
    for (const span of spans) {
      // Where the time asked for can take this block: between what holds it, and where enough places are free.
      const edges = [...new Set([span.start, span.end, ...occupants.flatMap((o) => [o.occupied.start, o.occupied.end, ...clearZones(o).flatMap((z) => [z.start, z.end])])])]
        .filter((m) => m >= span.start && m <= span.end)
        .sort((a, b) => a - b);
      let run: Span | null = null;
      const flush = async () => {
        if (run) blockIds.push(await writeBlock(court, date, run, zone, { reason, places: partial ? places : null, ...details }));
        run = null;
      };
      for (let i = 0; i + 1 < edges.length; i++) {
        const piece = { start: edges[i], end: edges[i + 1] };
        // Nothing is held while a facility turned over whole is kept clear: the block goes either side.
        if (occupants.some((o) => clearZones(o).some((z) => overlaps(z, piece)))) {
          await flush();
          continue;
        }
        const used = peakPlaces(occupants, piece);
        if (used + wanted <= court.capacity) {
          run = run && run.end === piece.start ? { start: run.start, end: piece.end } : (await flush(), piece);
        } else {
          await flush();
          // Taking out more places than are free would strand a booking.
          if (partial && strandedAt === null) {
            strandedAt = piece.start;
            strandedFree = court.capacity - used;
          }
        }
      }
      await flush();
    }
  });
  // A booking made or moved between reading what holds the court and writing
  // the block makes the write conflict: read again, and block around it.
  for (let attempt = 0; ; attempt++) {
    blockIds = [];
    strandedAt = null;
    strandedFree = 0;
    try {
      await writeBlocks();
      break;
    } catch (err) {
      if (!isConflict(err) || attempt >= 4) throw err;
    }
  }
  if (blockIds.length === 0 && strandedAt !== null)
    return { ok: false, error: `Only ${strandedFree} place(s) are free at ${formatMinute(strandedAt)}.` };
  // Counted in the columns asked for (an hour is one), not in minutes.
  const blocked = (await getDb()
    .prepare(`SELECT start_min, end_min FROM blocks WHERE id IN (${blockIds.map(() => "?").join(",") || "NULL"})`)
    .all(...blockIds)) as { start_min: number; end_min: number }[];
  const changed = cells.filter((m) => blocked.some((b) => b.start_min < Math.min(m + grid, closeMin) && b.end_min > m)).length;
  return { ok: true, changed, blockIds };
}

/**
 * Take block time within `span` off a court, from one tournament's holds only
 * when `tournamentId` is given, or one competition's when `competitionId` is.
 * Returns the minutes freed.
 */
export async function releaseBlockTime(courtId: number, date: string, span: Span, tournamentId?: number, competitionId?: number): Promise<number> {
  const court = await getCourt(courtId);
  if (!court) return 0;
  const { zone } = await courtVenueHours(courtId);
  const only =
    competitionId !== undefined
      ? (b: { competition_id: number | null }) => b.competition_id === competitionId
      : tournamentId === undefined
        ? undefined
        : (b: { tournament_id: number | null }) => b.tournament_id === tournamentId;
  return withTransaction(() => carveBlocks(court, date, span, zone, only));
}

/** Take block time off a court: exact minutes, or columns of the staff schedule. */
export async function unblockSlots(courtId: number, date: string, when: number[] | WhenInput): Promise<BlockResult> {
  const court = await getCourt(courtId);
  if (!court) return refuse("COURT_NOT_FOUND");
  const { openMin, closeMin, zone } = await courtVenueHours(courtId, date);
  const { spans, cells, grid } = await blockSpans(court, when, openMin, closeMin);
  if (spans.length === 0) return { ok: false, error: "No valid hours given." };
  const before = (await getDb().prepare("SELECT start_min, end_min FROM blocks WHERE court_id = ? AND date = ?").all(courtId, date)) as {
    start_min: number;
    end_min: number;
  }[];
  await withTransaction(async () => {
    for (const span of spans) await carveBlocks(court, date, span, zone);
  });
  const changed = cells.filter((m) => before.some((b) => b.start_min < Math.min(m + grid, closeMin) && b.end_min > m)).length;
  return { ok: true, changed, blockIds: [] };
}

/** Admin cancellation by code — no phone check, works even after start time. */
async function adminCancelBookingOnce(code: string): Promise<CancelResult> {
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
  // Over: there is nothing left to cancel, and a refund would be money out for
  // an hour that was used. One under way can still be called off (a leak, a
  // power cut) and refunded.
  const { zone } = await venueHours((await getCourt(booking.courtId))!.venueId);
  if (isPastSlot(booking.date, booking.endHour, zone)) return refuse("CANCEL_PLAYED");

  const claimed = await db.transaction(async () => {
    const done = await db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ? AND status = 'confirmed'").run(booking.id);
    if (done.changes !== 1) return false;
    await releaseBooking(booking.id);
    await refundBooking(booking.id);
    return true;
  })();
  if (!claimed) return refuse("ALREADY_CANCELLED");
  // A freed place goes to whoever has waited longest.
  if (booking.classId) await offerClassPlace(booking.classId);
  else await offerSlotPlace(booking.courtId, booking.date);
  return { ok: true, booking: { ...booking, status: "cancelled" } };
}

export type RescheduleResult =
  | {
      ok: true;
      booking: Booking;
      from: { date: string; startMin: number; endMin: number; startHour: number; endHour: number; courtId: number };
      /** What the price went up (or down) by; 0 when it stayed as it was. */
      priceChange: number;
      /** What the new time costs against the old at today's rates, when the price was left as paid. */
      unchargedDifference: number;
      /** The court's rules staff went past, to be recorded. */
      overrides?: PolicyBreach[];
      /** Where it went (or, previewed or held, would go). */
      to: { date: string; startMin: number; endMin: number; courtId: number; courtName: string };
      /** Previewed only: nothing was changed. */
      preview?: true;
      /** Held only, for a game's proposal: the booking has not moved. */
      held?: true;
    }
  | Refusal;

/** An open game on a booking, as moving the booking needs it (lib/game-moves.ts). */
export async function gameUnder(bookingId: number): Promise<{ id: number; status: string; players: number; pendingMove: number | null } | null> {
  const row = (await getDb()
    .prepare(
      `SELECT g.id, g.status,
              (SELECT COUNT(*)::int FROM open_game_players p WHERE p.game_id = g.id AND p.status = 'accepted') AS players,
              (SELECT m.id FROM game_moves m WHERE m.game_id = g.id AND m.status = 'pending') AS pending_move
         FROM open_games g WHERE g.booking_id = ?`
    )
    .get(bookingId)) as { id: number; status: string; players: number; pending_move: number | null } | undefined;
  return row ? { id: row.id, status: row.status, players: row.players, pendingMove: row.pending_move } : null;
}

/** Shares players of a booking's open game have paid online and still count towards it. */
async function gameSharesPaid(bookingId: number): Promise<number> {
  const row = (await getDb()
    .prepare(
      `SELECT COALESCE(SUM(op.amount - op.refund_due), 0)::float AS paid
         FROM online_payments op JOIN open_game_players p ON p.id = op.game_player_id JOIN open_games g ON g.id = p.game_id
        WHERE g.booking_id = ? AND op.purpose = 'share' AND op.status = 'paid'`
    )
    .get(bookingId)) as { paid: number };
  return Number(row.paid);
}

/** The booking changed while it was being moved: it is refused rather than moved from a time it no longer has. */
class BookingChanged extends Error {}
/** A preview: everything done, then undone. */
class PreviewOnly extends Error {}

/** The parts of `span` that `taken` does not cover. */
function outside(span: Span, taken: Span): Span[] {
  if (!overlaps(span, taken)) return [span];
  const parts: Span[] = [];
  if (span.start < taken.start) parts.push({ start: span.start, end: taken.start });
  if (taken.end < span.end) parts.push({ start: taken.end, end: span.end });
  return parts;
}

/** Move a booking's claims to another court and time, inside the caller's transaction. Throws `23P01` when it is held. */
async function reclaimBooking(booking: Booking, court: Court, date: string, span: Span, zone: string, policy: BookingPolicy): Promise<void> {
  await unclaim({ kind: "booking", bookingId: booking.id });
  await claim({
    court,
    source: { kind: "booking", bookingId: booking.id },
    date,
    span,
    zone,
    places: booking.players ?? 1,
    ...claimBuffers(policy),
  });
  await getDb()
    .prepare("UPDATE bookings SET court_id = ?, date = ?, start_min = ?, end_min = ?, starts_at = ?, ends_at = ? WHERE id = ?")
    .run(court.id, date, span.start, span.end, instantOf(date, span.start, zone).toISOString(), instantOf(date, span.end, zone).toISOString(), booking.id);
}

/** When a booking was made, for the last-minute price it was given. */
function bookedAtOf(booking: Booking): number | undefined {
  const at = Date.parse(`${booking.createdAt.replace(" ", "T")}${booking.createdAt.includes("Z") ? "" : "Z"}`);
  return Number.isFinite(at) ? at : undefined;
}

/**
 * Move a booking to another date or time — the same length, at the same
 * venue, for the same sport — keeping its code, how it was paid, its extras
 * and any promo. The alternative is cancel-and-book-again, which is a new
 * code, a refund to sort out and, for the customer, the risk the time they
 * had goes while they rebook.
 *
 * It stays on its court when that is free then, and otherwise goes to
 * another court of the same sport (or to `courtId`, for staff choosing one).
 *
 * Customers may change a booking up to the same cutoff as cancelling it, to a
 * time inside the booking window and the court's booking policy. Staff may
 * change it at any time before it has finished, outside the policy too
 * (returned as `overrides`, to be recorded).
 *
 * The price follows the court time: an unpaid booking is repriced at the new
 * time's rate, up or down. A paid one keeps what was paid — a customer may not
 * move it somewhere dearer (they would be playing peak hours for an off-peak
 * price), and staff who do so have chosen not to charge the difference.
 */
async function rescheduleBookingOnce(
  code: string,
  to: {
    date: string;
    start?: number;
    startHour?: number;
    courtId?: number;
    /** Staff allowed to (a manager) going past the new court's booking policy; recorded by the caller. */
    override?: boolean;
    /** Work out what it would do, and undo it: nothing changes. */
    preview?: boolean;
    /**
     * The caller is moving the booking's open game with it, players and all
     * (lib/game-moves.ts): a manager's change, or a proposal the players
     * answered. Without it, a booking whose game has players is refused.
     */
    game?: boolean;
    /** Hold the new time for a game's proposal instead of moving: a claim of its own, until `expiresAt`. */
    hold?: { moveId: number; expiresAt: Date };
    /** Moving onto the time this proposal held. */
    fromHold?: number;
  },
  by: "staff" | "customer"
): Promise<RescheduleResult> {
  const db = getDb();
  const row = (await db
    .prepare(
      "SELECT b.*, ci.checked_in_at, ci.checked_out_at FROM bookings b LEFT JOIN check_ins ci ON ci.booking_id = b.id WHERE UPPER(b.code) = UPPER(?)"
    )
    .get(code.trim())) as BookingRow | undefined;
  if (!row) return refuse("BOOKING_NOT_FOUND");
  const booking = toBooking(row);
  if (booking.status === "cancelled") return refuse("BOOKING_WAS_CANCELLED");
  if (booking.classId !== null) return refuse("RESCHEDULE_CLASS");
  if (booking.checkedInAt) return refuse("RESCHEDULE_CHECKED_IN");
  // An open game: a called-off one changes nothing; one with nobody in it
  // moves with its booking; one with players moves only as an explicit change
  // they are asked about (lib/game-moves.ts), never once it has begun.
  const game = await gameUnder(booking.id);
  const live = game !== null && game.status !== "cancelled";
  if (live && game.pendingMove !== null && game.pendingMove !== to.hold?.moveId && game.pendingMove !== to.fromHold) return refuse("RESCHEDULE_PROPOSED");
  if (live && game.players > 0) {
    const { zone: z } = await courtVenueHours(booking.courtId);
    if (minutesUntil(booking.date, booking.startMin, z) <= 0) return refuse("RESCHEDULE_GAME_STARTED");
    if (!to.game) return refuse("RESCHEDULE_GAME");
  }
  // Friends have paid their share for this time: moving it is for the venue,
  // who can square it with them. A game's players are asked themselves.
  const friendsPaid = booking.sharesPaid - (booking.depositPaid ?? 0) - (live ? await gameSharesPaid(booking.id) : 0);
  if (by === "customer" && friendsPaid > 0.005) return refuse("RESCHEDULE_SHARED");
  // A coach's time is not the court's: moving it is a conversation with the venue.
  if (booking.coachId) return refuse("RESCHEDULE_COACH");
  if (await hasOpenHire(booking.id)) return refuse("KIT_STILL_OUT");

  const fromCourt = await bookedCourt(booking);
  if (!fromCourt) return refuse("COURT_NOT_FOUND");
  const start = to.start ?? (to.startHour === undefined ? NaN : minutesOf(to.startHour));
  if (!isMinute(start) || !isValidDateString(to.date)) return refuse("SLOT_PAST");
  const length = booking.endMin - booking.startMin;
  const span = { start, end: start + length };
  const { zone } = await courtVenueHours(booking.courtId);
  if (by === "customer") {
    const tooLate = await customerChangeRefusal(booking);
    if (tooLate) return tooLate;
  } else if (minutesUntil(booking.date, booking.endMin, zone) <= 0) {
    return { ok: false, error: "That booking has already finished." };
  }
  if (by === "customer" && !isBookableDate(to.date, zone, await venueAheadDays(fromCourt.venueId))) return refuse("DATE_OUT_OF_WINDOW");
  if (minutesUntil(to.date, span.start, zone) <= 0) return refuse("SLOT_PAST");
  if (await getVenueClosure(fromCourt.venueId, to.date)) return refuse("VENUE_CLOSED");

  // The courts it could go to, its own first.
  let candidates: Court[];
  if (to.courtId !== undefined) {
    const chosen = await getCourt(to.courtId);
    if (!chosen) return refuse("COURT_NOT_FOUND");
    if (chosen.venueId !== fromCourt.venueId)
      return { ok: false, error: "A booking can only move within the same venue." };
    if (!courtOffers(chosen, booking.sport))
      return {
        ok: false,
        error: `${chosen.name} is not booked for ${activityName(booking.sport)}.`,
      };
    candidates = [courtFor(chosen, booking.sport)];
  } else {
    candidates = [
      fromCourt,
      ...(
        (await db
          .prepare(`SELECT c.* FROM courts c WHERE c.venue_id = ? AND ${offersSql()} AND c.id != ? ORDER BY c.id`)
          .all(fromCourt.venueId, booking.sport, fromCourt.id)) as CourtRow[]
      ).map((r) => courtFor(toCourt(r), booking.sport)),
    ];
  }
  const sameTime = to.date === booking.date && span.start === booking.startMin;
  if (sameTime && candidates.length === 1 && candidates[0].id === fromCourt.id) return refuse("RESCHEDULE_SAME");
  if (sameTime && to.courtId === undefined) return refuse("RESCHEDULE_SAME");

  const days = await courtDays(candidates, to.date);
  // Moved by the customer, re-priced on the same terms as booking online: a member's rate for their own proved or linked number.
  const member = (date: string) =>
    memberPricing(fromCourt.venueId, booking.phone, date, by === "customer" ? { userId: (row as { user_id?: number | null }).user_id ?? null, by } : undefined);
  const rules = await peakRules(fromCourt.venueId);
  const players = booking.players ?? 1;
  // What the old time cost when booked: a last-minute price stays with the time
  // it was given for, so moving away from it costs the difference.
  const fromPolicy = await policyFor(fromCourt);
  const oldPrice = quoteBooking(fromCourt, fromPolicy, booking.date, { start: booking.startMin, end: booking.endMin }, await member(booking.date), rules, bookedAtOf(booking), players).total;
  const newMember = await member(to.date);
  let firstRefusal: Refusal | null = null;

  for (const court of candidates) {
    const day = days.get(court.id)!;
    // The court's rules for the new time, its length included: a court that
    // does not sell bookings that long does not take this one either.
    // Managers may go past them, and it is recorded.
    const breaches = policyBreaches(day.policy, span, day, minutesUntil(to.date, span.start, zone));
    if (breaches.length > 0 && (breaches.includes("CLOCK") || !(by === "staff" && to.override === true))) {
      firstRefusal ??= breachRefusal(day.policy, span, breaches.includes("CLOCK") ? "CLOCK" : breaches[0]);
      continue;
    }
    // A sign-off the activity asks for there must still hold on the new date, and be the customer's own.
    const need = day.policy.certification ? "certification" : day.policy.signOff ? "any" : null;
    if (need) {
      const bookedBy = ((await db.prepare("SELECT user_id FROM bookings WHERE id = ?").get(booking.id)) as { user_id: number | null }).user_id;
      // Everybody taking part, each still on their own (lib/participants.ts); the first without one named.
      let lacking: { name: string | null } | null = null;
      for (const place of await bookingPlaces(booking.id)) {
        const holds =
          place.customer !== (place.participantId !== null) &&
          (await signOffHolds({
            venueId: court.venueId,
            sport: booking.sport,
            until: to.date,
            phone: booking.phone,
            userId: bookedBy,
            channel: by,
            need,
            participant: place.customer ? null : place.participantId,
          }));
        if (!holds) {
          lacking = { name: place.customer ? null : place.name };
          break;
        }
      }
      const held = lacking === null;
      if (lacking && !(by === "staff" && to.override === true)) {
        firstRefusal ??= signOffRefusal(need, activityName(booking.sport), lacking.name);
        continue;
      }
      if (!held) breaches.push("SIGN_OFF");
    }
    // A members' session: each participant still a member on the new date (lib/entitlements.ts).
    const notMember = await membersOnlyRefusal({
      venueId: court.venueId,
      court,
      participants: (await bookingPlaces(booking.id)).flatMap((p) => (!p.customer && p.participantId !== null ? [{ id: p.participantId, name: p.name ?? "" }] : [])),
      dates: [to.date],
    });
    if (notMember && !(by === "staff" && to.override === true)) {
      firstRefusal ??= notMember;
      continue;
    }
    if (notMember) breaches.push("MEMBERSHIP");
    const delta = Math.round((quoteBooking(court, day.policy, to.date, span, newMember, rules, undefined, players).total - oldPrice) * 100) / 100;
    const paid = booking.paymentStatus === "paid";
    if (paid && delta > 0 && by === "customer") return refuse("RESCHEDULE_DEARER", { amount: delta.toFixed(2) });
    // A payment page open for the old price would settle it short.
    if (!paid && delta > 0 && (await paymentPageOpen(booking.id))) return refuse("RESCHEDULE_PAGE_OPEN");
    const priceChange = paid ? 0 : Math.max(-booking.totalPrice, delta);
    const from = { date: booking.date, startMin: booking.startMin, endMin: booking.endMin, startHour: booking.startHour, endHour: booking.endHour, courtId: fromCourt.id };
    const where = { date: to.date, startMin: span.start, endMin: span.end, courtId: court.id, courtName: court.name };
    const result = {
      ok: true as const,
      from,
      to: where,
      priceChange,
      unchargedDifference: paid ? delta : 0,
      ...(breaches.length > 0 ? { overrides: breaches } : {}),
    };
    try {
      await withTransaction(async () => {
        // Nothing changed since it was read: the game first, then the booking,
        // in the order every change to a game takes them (lib/games.ts).
        const g = live ? ((await db.prepare("SELECT status FROM open_games WHERE id = ? FOR UPDATE").get(game.id)) as { status: string }) : null;
        const now = (await db.prepare("SELECT status, date, start_min, end_min, court_id FROM bookings WHERE id = ? FOR UPDATE").get(booking.id)) as {
          status: string; date: string; start_min: number; end_min: number; court_id: number;
        };
        if (now.status !== booking.status || now.date !== booking.date || now.start_min !== booking.startMin || now.end_min !== booking.endMin || now.court_id !== booking.courtId)
          throw new BookingChanged();
        if (g && g.status !== "cancelled" && !to.game) {
          const again = await gameUnder(booking.id);
          if (again && (again.players > 0 || (again.pendingMove !== null && again.pendingMove !== to.hold?.moveId))) throw new BookingChanged();
        }
        if (to.hold) {
          // The booking keeps its own time; the new time is held beside it. Where
          // the two overlap on floor the booking already holds (the same court, or
          // a court sharing its floor: a pitch over it, a court under it), only the
          // part outside the booking's time is held there; the rest of the new
          // court's floor is held for all of it.
          // What the booking keeps now, as its claims were made, not as the rules are today: its `occupied`,
          // and the separation it keeps, which nothing else's time may enter (the hold included).
          const kept = (await db
            .prepare("SELECT buffer_before, buffer_after, separation_before, separation_after FROM claims WHERE booking_id = ? AND active LIMIT 1")
            .get(booking.id)) as { buffer_before: number; buffer_after: number; separation_before: number; separation_after: number } | undefined;
          const ownSpan = {
            start: booking.startMin - Math.max(Number(kept?.buffer_before ?? 0), Number(kept?.separation_before ?? 0)),
            end: booking.endMin + Math.max(Number(kept?.buffer_after ?? 0), Number(kept?.separation_after ?? 0)),
          };
          // The new time with its operational time; separation, on a court of one place, is kept by the hold's
          // outer edges (less what the operational time already keeps), and on a shared facility held as places.
          const p = policyBuffers(day.policy);
          const newSpan = occupiedFor(court.capacity, span, p);
          const edge = (part: Span) => ({
            separationBefore: part.start === newSpan.start ? Math.max(0, p.sepBefore - p.before) : 0,
            separationAfter: part.end === newSpan.end ? Math.max(0, p.sepAfter - p.after) : 0,
          });
          const source = { kind: "move" as const, moveId: to.hold.moveId };
          const sameDay = to.date === booking.date;
          if (court.capacity === 1 && fromCourt.capacity === 1 && sameDay) {
            const own = new Set(await spacesOf(fromCourt.id));
            const mine = await spacesOf(court.id);
            const shared = mine.filter((s) => own.has(s));
            const rest = mine.filter((s) => !own.has(s));
            if (rest.length > 0) await claim({ court, source, date: to.date, span: newSpan, zone, expiresAt: to.hold.expiresAt, onlySpaces: rest, ...edge(newSpan) });
            if (shared.length > 0)
              for (const part of outside(newSpan, ownSpan))
                await claim({ court, source, date: to.date, span: part, zone, expiresAt: to.hold.expiresAt, onlySpaces: shared, ...edge(part) });
          } else if (court.capacity === 1) {
            const parts = court.id === fromCourt.id && sameDay ? outside(newSpan, ownSpan) : [newSpan];
            for (const part of parts) await claim({ court, source, date: to.date, span: part, zone, expiresAt: to.hold.expiresAt, ...edge(part) });
          } else if (p.turnover === "facility") {
            // A facility turned over whole: the hold keeps it clear on its outer edges as a booking would, except
            // where its own booking already keeps it (newSpan is the time alone here).
            const beside = court.id === fromCourt.id && sameDay;
            const parts = beside ? outside(newSpan, ownSpan) : [newSpan];
            const roomBefore = beside && newSpan.start >= ownSpan.end ? newSpan.start - ownSpan.end : Infinity;
            const roomAfter = beside && newSpan.end <= ownSpan.start ? ownSpan.start - newSpan.end : Infinity;
            for (const part of parts) {
              const first = part.start === newSpan.start;
              const last = part.end === newSpan.end;
              await claim({
                court,
                source,
                date: to.date,
                span: part,
                zone,
                places: players,
                expiresAt: to.hold.expiresAt,
                turnover: "facility",
                bufferBefore: first ? Math.min(p.before, roomBefore) : 0,
                separationBefore: first ? Math.min(p.sepBefore, roomBefore) : 0,
                bufferAfter: last ? Math.min(p.after, roomAfter) : 0,
                separationAfter: last ? Math.min(p.sepAfter, roomAfter) : 0,
              });
            }
          } else {
            const parts = court.id === fromCourt.id && sameDay ? outside(newSpan, ownSpan) : [newSpan];
            for (const part of parts) await claim({ court, source, date: to.date, span: part, zone, places: players, expiresAt: to.hold.expiresAt });
          }
        } else {
          if (to.fromHold !== undefined) await unclaim({ kind: "move", moveId: to.fromHold });
          // The claims are what decide: a booking, class, block, waiting-list offer or held move there refuses it.
          await reclaimBooking(booking, court, to.date, span, zone, day.policy);
          if (breaches.length > 0) await db.prepare("UPDATE bookings SET policy_override = true WHERE id = ?").run(booking.id);
          await db.prepare("UPDATE bookings SET total_price = total_price + ? WHERE id = ?").run(priceChange, booking.id);
          // A called-off game keeps where and when it was, not where its booking went.
          await db
            .prepare(
              `UPDATE open_games SET was_date = ?, was_start_min = ?, was_end_min = ?, was_court_id = ?
                WHERE booking_id = ? AND status = 'cancelled' AND was_date IS NULL`
            )
            .run(booking.date, booking.startMin, booking.endMin, fromCourt.id, booking.id);
        }
        if (to.preview) throw new PreviewOnly();
      });
    } catch (err) {
      if (err instanceof PreviewOnly) return { ...result, booking, preview: true };
      if (err instanceof BookingChanged) return refuse("RESCHEDULE_CHANGED");
      if (isConflict(err)) continue;
      throw err;
    }
    if (to.hold) return { ...result, booking, held: true };
    // The time it left may now be free for somebody waiting on it.
    await offerSlotPlace(fromCourt.id, booking.date);
    // A game with nobody in it yet went with its booking: whoever asked, was
    // invited or is waiting hears the new time. (A game with players moves
    // through lib/game-moves.ts, which tells them itself.)
    if (live && !to.game) await (await import("./games")).gameTimeChanged(game.id);
    return { ...result, booking: (await getBookingById(booking.id))! };
  }
  return firstRefusal ?? refuse("RESCHEDULE_TAKEN");
}

/**
 * The start times a booking could be changed to on a date: each start a
 * court of its sport allows where it is free for the booking's whole length,
 * its own court first, with what the court time would cost and how that
 * compares with now.
 */
export interface RescheduleOption {
  startMin: number;
  startHour: number;
  courtId: number;
  courtName: string;
  /** The court time at the new time. */
  price: number;
  /** That, less what the court time costs where it is now. */
  difference: number;
}

export async function rescheduleOptions(code: string, date: string): Promise<RescheduleOption[]> {
  const booking = await bookingByCode(code);
  if (!booking || booking.status === "cancelled" || booking.classId !== null) return [];
  const court = await bookedCourt(booking);
  if (!court) return [];
  const { zone } = await venueHours(court.venueId);
  if (!isBookableDate(date, zone, await venueAheadDays(court.venueId)) || (await getVenueClosure(court.venueId, date))) return [];
  const length = booking.endMin - booking.startMin;
  const member = await memberPricing(court.venueId, booking.phone, date);
  const rules = await peakRules(court.venueId);
  const players = booking.players ?? 1;
  const ownPolicy = await policyFor(court);
  const now = quoteBooking(court, ownPolicy, booking.date, { start: booking.startMin, end: booking.endMin }, await memberPricing(court.venueId, booking.phone, booking.date), rules, undefined, players).total;
  const courts = [
    court,
    ...(
      (await getDb()
        .prepare(`SELECT c.* FROM courts c WHERE c.venue_id = ? AND ${offersSql()} AND c.id != ? ORDER BY c.id`)
        .all(court.venueId, booking.sport, court.id)) as CourtRow[]
    ).map((r) => courtFor(toCourt(r), booking.sport)),
  ];
  const days = await courtDays(courts, date);
  const held = await occupantsOn(courts, date, zone);
  // Its own time counts as free: it is what is being moved.
  const own = (o: Occupant) => o.bookingId === booking.id;
  const options = new Map<number, RescheduleOption>();
  for (const c of courts) {
    const day = days.get(c.id)!;
    if (day.closed) continue;
    for (const start of startsWithin(day.policy, day.openMin, day.closeMin - length + 1)) {
      if (options.has(start) || (date === booking.date && start === booking.startMin)) continue;
      if (minutesUntil(date, start, zone) <= 0) continue;
      const span = { start, end: start + length };
      if (policyBreaches(day.policy, span, day, minutesUntil(date, start, zone)).length > 0) continue;
      if (!fits(held.get(c.id)!, c.capacity, span, policyBuffers(day.policy), own, players)) continue;
      const price = quoteBooking(c, day.policy, date, span, member, rules, undefined, players).total;
      options.set(start, {
        startMin: start,
        startHour: hoursOf(start),
        courtId: c.id,
        courtName: c.name,
        price,
        difference: Math.round((price - now) * 100) / 100,
      });
    }
  }
  return [...options.values()].sort((a, b) => a.startMin - b.startMin);
}

/**
 * Where "Book again" takes a customer: the same court and time on the next
 * day they are free — the same weekday first, since most regulars play the
 * same night each week — else another court of the same sport, else just the
 * venue. Only a link: the customer still sees the price and taps Book.
 */
export async function bookAgainLink(code: string): Promise<string | null> {
  const booking = await bookingByCode(code);
  if (!booking || booking.classId !== null) return null;
  const court = await bookedCourt(booking);
  if (!court) return null;
  const today = todayISO();
  // After the booking itself: "again" from one still to come means another time.
  const days = Array.from({ length: MAX_ADVANCE_DAYS + 1 }, (_, i) => addDays(today, i)).filter((d) => d > booking.date);
  const sameWeekday = (d: string) =>
    new Date(`${d}T00:00:00Z`).getUTCDay() === new Date(`${booking.date}T00:00:00Z`).getUTCDay();
  const ordered = [...days.filter(sameWeekday), ...days.filter((d) => !sameWeekday(d))];
  const span = { start: booking.startMin, end: booking.endMin };
  const link = (date: string, courtId: number) =>
    `/venue/${court.venueId}?date=${date}&sport=${booking.sport}&court=${courtId}&start=${span.start}&minutes=${span.end - span.start}`;
  const courts = [
    court,
    ...(
      (await getDb()
        .prepare(`SELECT c.* FROM courts c WHERE c.venue_id = ? AND ${offersSql()} AND c.id != ? ORDER BY c.id`)
        .all(court.venueId, booking.sport, court.id)) as CourtRow[]
    ).map((r) => courtFor(toCourt(r), booking.sport)),
  ];
  for (const date of ordered) {
    const days2 = await courtDays(courts, date);
    const first = days2.get(court.id)!;
    if (first.closed || minutesUntil(date, span.start, first.zone) <= 0) continue;
    const held = await occupantsOn(courts, date, first.zone);
    for (const c of courts) {
      const day = days2.get(c.id)!;
      if (policyBreaches(day.policy, span, day, minutesUntil(date, span.start, day.zone)).length > 0) continue;
      if (fits(held.get(c.id)!, c.capacity, span, policyBuffers(day.policy), undefined, booking.players ?? 1)) return link(date, c.id);
    }
  }
  return `/venue/${court.venueId}?sport=${booking.sport}`;
}

export type MoveResult =
  | { ok: true; booking: Booking; fromCourt: Court; toCourt: Court }
  | Refusal;

/** What is in the way of a booking on a court, said for staff. */
async function inTheWay(booking: Booking, court: Court, policy: BookingPolicy, zone: string): Promise<string> {
  const held = (await occupantsOn([court], booking.date, zone)).get(court.id)!;
  const span = { start: booking.startMin, end: booking.endMin };
  const why = whyTaken(held, court, span, policyBuffers(policy), (o) => o.bookingId === booking.id, booking.players ?? 1);
  if (why?.why === "class") return `${court.name} is running ${(await classNamesFor([why.classId])).get(why.classId) ?? "a class"} at that time.`;
  if (why?.why === "blocked") return `${court.name} is blocked off for part of that time.`;
  return `${court.name} is already taken at ${formatMinute(span.start)}.`;
}

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
async function moveBookingOnce(code: string, toCourtId: number): Promise<MoveResult> {
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

  const fromCourt = await bookedCourt(booking);
  const target = await getCourt(toCourtId);
  if (!fromCourt || !target) return refuse("COURT_NOT_FOUND");
  const toCourt = courtFor(target, courtOffers(target, booking.sport) ? booking.sport : target.sport);
  if (fromCourt.id === toCourt.id)
    return { ok: false, error: "That booking is already on that court." };
  if (fromCourt.venueId !== toCourt.venueId)
    return { ok: false, error: "A booking can only move within the same venue." };
  if (!courtOffers(target, booking.sport))
    return {
      ok: false,
      error: `${toCourt.name} is not booked for ${activityName(booking.sport)}.`,
    };

  const zone = await courtZone(booking.courtId);
  // A booking that is wholly in the past is history; there is nothing to move.
  if (minutesUntil(booking.date, booking.endMin, zone) <= 0)
    return { ok: false, error: "That booking has already finished." };

  const policy = await policyFor(toCourt);
  try {
    // Its claims go to the other court in one step; the constraints refuse it there if anything holds that time.
    await withTransaction(() => reclaimBooking(booking, toCourt, booking.date, { start: booking.startMin, end: booking.endMin }, zone, policy));
  } catch (err) {
    if (isConflict(err)) return { ok: false, error: await inTheWay(booking, toCourt, policy, zone) };
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
  const candidates = (
    await getDb()
      .prepare(`SELECT c.* FROM courts c WHERE c.venue_id = ? AND ${offersSql()} AND c.id != ? ORDER BY c.id`)
      .all(court.venueId, booking.sport, court.id) as CourtRow[]
  ).map((r) => courtFor(toCourt(r), booking.sport));
  if (candidates.length === 0) return [];
  const days = await courtDays(candidates, booking.date);
  const held = await occupantsOn(candidates, booking.date, days.get(candidates[0].id)!.zone);
  const span = { start: booking.startMin, end: booking.endMin };
  // Booked, blocked, a class, or offered to somebody on the waiting list, as the move itself counts; its own time is free.
  return candidates.filter((c) => {
    const p = days.get(c.id)!.policy;
    return fits(held.get(c.id)!, c.capacity, span, policyBuffers(p), (o) => o.bookingId === booking.id, booking.players ?? 1);
  });
}

export interface OccupancyDay {
  date: string;
  perCourt: {
    courtId: number;
    /** Place-hours booked: each booking is its places for its minutes. */
    booked: number;
    /** Place-hours taken out of service by blocks and outages: two places of four for an hour is 2. */
    blocked: number;
    /** Place-hours that could have been sold: the day's hours times capacity, less `blocked`; none on a closed day. */
    sellable: number;
  }[];
  /**
   * The venue's day as the reports measure it (lib/reports.ts `measureUse`):
   * the courts' floor once, a pitch and the courts under it being the same
   * floor (B11), and shared facilities' places apart, never blended; null
   * where the venue has none of that kind. Not the sum of the lines above.
   */
  totals: { courts: UseSplit | null; shared: UseSplit | null };
}

export interface OccupancyReport {
  totalSlotsPerDay: number;
  courts: Court[];
  days: OccupancyDay[];
}

/**
 * Place-hours booked, taken out of service and sellable per court for
 * `numDays` days from `start`, measured as the reports measure utilisation
 * (docs/features/reporting.md): each day by its own hours, a closed day
 * offering nothing, and every place a block or outage takes out coming off
 * what could be sold for its time, so a block of two kayaks of six takes two
 * places, not the hour.
 */
export async function getOccupancy(venueId: number, start: string, numDays: number): Promise<OccupancyReport> {
  const db = getDb();
  const courts = (
    await db.prepare("SELECT * FROM courts WHERE venue_id = ? ORDER BY id").all(venueId) as CourtRow[]
  ).map(toCourt);
  const dates = Array.from({ length: numDays }, (_, i) => addDays(start, i));
  const { openMin, closeMin, zone } = await venueHours(venueId);
  const totals = await utilisationByDay(venueId, start, dates[dates.length - 1]);
  const days: OccupancyDay[] = [];
  for (const date of dates) {
    const held = await occupantsOn(courts, date, zone);
    const on = await venueHours(venueId, date);
    const shut = on.closed || (await getVenueClosure(venueId, date)) !== null;
    const day = { start: on.openMin, end: on.closeMin };
    const open = shut ? 0 : (day.end - day.start) / 60;
    const minutes = (list: Occupant[], each: (o: Occupant) => number) =>
      list.reduce((sum, o) => sum + Math.max(0, Math.min(o.span.end, day.end) - Math.max(o.span.start, day.start)) * each(o), 0);
    days.push({
      date,
      perCourt: courts.map((c) => {
        const occupants = held.get(c.id)!;
        const offered = open * c.capacity;
        const blocked = Math.min(
          offered,
          minutes(occupants.filter((o) => o.kind === "block" || o.kind === "outage"), (o) => Math.min(o.places, c.capacity)) / 60
        );
        return {
          courtId: c.id,
          booked: minutes(occupants.filter((o) => o.kind === "booking"), (o) => o.places) / 60,
          blocked,
          sellable: offered - blocked,
        };
      }),
      totals: totals.get(date) ?? { courts: null, shared: null },
    });
  }
  return { totalSlotsPerDay: (closeMin - openMin) / 60, courts, days };
}

export type VenueEditResult = { ok: true; venue: Venue } | Refusal;

/** Validate a venue's usual hours (minutes, or hours as the older forms give them), defaulting anything not given. */
function normaliseHours(
  open: number | undefined,
  close: number | undefined
): { ok: true; openMin: number; closeMin: number } | Refusal {
  const openMin = open ?? DEFAULT_OPEN_HOUR * 60;
  const closeMin = close ?? DEFAULT_CLOSE_HOUR * 60;
  const checked = validateUsualHours(openMin, closeMin);
  if (!checked.ok) return { ok: false, error: checked.error };
  return { ok: true, openMin, closeMin };
}

/** Minutes from a request that may give minutes, or hours (18.5) the older way. */
function minutesFrom(min: number | undefined, hour: number | undefined): number | undefined {
  if (min !== undefined) return min;
  return hour === undefined ? undefined : minutesOf(hour);
}

export async function createVenue(input: {
  name: string;
  area: string;
  address: string;
  phone: string;
  /** Its usual hours, in minutes of the day (or hours, the older way). */
  openMin?: number;
  closeMin?: number;
  openHour?: number;
  closeHour?: number;
  /** A business setting itself up: nobody else sees it until it goes live. */
  draft?: boolean;
}): Promise<VenueEditResult> {
  const hours = normaliseHours(minutesFrom(input.openMin, input.openHour), minutesFrom(input.closeMin, input.closeHour));
  if (!hours.ok) return hours;
  // A late close may not run into the next morning's opening.
  const overlap = validateWeekHours(null, hours);
  if (!overlap.ok) return overlap;
  const db = getDb();
  const info = await db
    .prepare(
      `INSERT INTO venues (name, area, address, phone, open_min, close_min, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ${input.draft ? "NULL" : "datetime('now')"})`
    )
    .run(
      input.name.trim(),
      input.area.trim(),
      input.address.trim(),
      input.phone.trim(),
      hours.openMin,
      hours.closeMin
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

/** What a venue offers besides its courts, replaced whole: from the fixed list, nothing else. */
export async function setVenueAmenities(venueId: number, amenities: Amenity[]): Promise<void> {
  await getDb()
    .prepare("UPDATE venues SET amenities = string_to_array(?, ',') WHERE id = ?")
    .run(cleanAmenities(amenities).join(","), venueId);
}

/** What a court is like: indoor or outdoor, air-con, floodlights, surface. Only what is given changes. */
export async function setCourtFeatures(courtId: number, f: Partial<CourtFeatures>): Promise<Court | null> {
  const court = await getCourt(courtId);
  if (!court) return null;
  const next = { ...court, ...f };
  await getDb()
    .prepare("UPDATE courts SET setting = ?, aircon = ?, floodlit = ?, surface = ? WHERE id = ?")
    .run(next.setting, next.aircon ? 1 : 0, next.floodlit ? 1 : 0, next.surface, courtId);
  return getCourt(courtId);
}

export async function updateVenue(
  venueId: number,
  changes: {
    name?: string;
    area?: string;
    address?: string;
    phone?: string;
    cancelCutoffHours?: number;
    /** Usual hours in minutes of the day (or hours, the older way). */
    openMin?: number;
    closeMin?: number;
    openHour?: number;
    closeHour?: number;
    /** Weekdays with hours of their own, or closed (lib/week-hours.ts); null puts every day back on the usual hours. */
    weekHours?: unknown;
    /** null for both means always staffed; equal values mean never staffed. */
    staffedFrom?: number | null;
    staffedTo?: number | null;
    /** A booking staffed for only part of its time: the door code, or somebody stays on the desk. */
    partlyUnstaffed?: "code" | "counter";
    emergencyPhone?: string | null;
    emergencyInfo?: string | null;
  }
): Promise<VenueEditResult> {
  const db = getDb();
  const row = await db.prepare("SELECT * FROM venues WHERE id = ?").get(venueId) as VenueRow | undefined;
  if (!row) return refuse("VENUE_NOT_FOUND");
  const current = toVenue(row);

  const hours = normaliseHours(
    minutesFrom(changes.openMin, changes.openHour) ?? current.openMin,
    minutesFrom(changes.closeMin, changes.closeHour) ?? current.closeMin
  );
  if (!hours.ok) return hours;
  const week = validateWeekHours(changes.weekHours !== undefined ? changes.weekHours : current.weekHours ?? null, hours);
  if (!week.ok) return week;
  // Narrowing a day, or closing one, would strand anything already sold outside the new hours.
  const sold = (await db
    .prepare(`
      SELECT DISTINCT b.date, b.start_min, b.end_min FROM bookings b
      WHERE b.court_id IN (SELECT id FROM courts WHERE venue_id = ?) AND b.date >= ? AND b.status = 'confirmed' AND b.class_id IS NULL
    `)
    .all(venueId, todayISO())) as { date: string; start_min: number; end_min: number }[];
  const next = { openMin: hours.openMin, closeMin: hours.closeMin, weekHours: week.week };
  const stranded = sold.filter((r) => {
    const on = hoursOn(next, r.date);
    return on.closed || r.start_min < on.openMin || r.end_min > on.closeMin;
  });
  if (stranded.length > 0)
    return {
      ok: false,
      error: `Bookings already exist outside those hours (the first on ${stranded.map((r) => r.date).sort()[0]}). Cancel or move them first.`,
    };

  const staffedFrom =
    changes.staffedFrom !== undefined ? changes.staffedFrom : current.staffedFrom;
  const staffedTo = changes.staffedTo !== undefined ? changes.staffedTo : current.staffedTo;
  if ((staffedFrom === null) !== (staffedTo === null))
    return { ok: false, error: "Give both ends of the staffed window, or neither." };
  for (const hour of [staffedFrom, staffedTo]) {
    if (hour !== null && (!Number.isInteger(hour) || hour < 0 || hour > LATEST_CLOSE_HOUR))
      return { ok: false, error: "A staffed hour must be between midnight and the latest close." };
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
                       open_min = ?, close_min = ?, week_hours = ?, staffed_from = ?, staffed_to = ?,
                       partly_unstaffed = ?, emergency_phone = ?, emergency_info = ? WHERE id = ?`
  ).run(
    changes.name?.trim() ?? current.name,
    changes.area?.trim() ?? current.area,
    changes.address?.trim() ?? current.address,
    changes.phone?.trim() ?? current.phone,
    changes.cancelCutoffHours ?? current.cancelCutoffHours,
    hours.openMin,
    hours.closeMin,
    week.week ? JSON.stringify(week.week) : null,
    staffedFrom,
    staffedTo,
    changes.partlyUnstaffed ?? current.partlyUnstaffed ?? "code",
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
  /** Booked from an account that has proved, by a code, that it holds this number. */
  phoneChecked: boolean;
  /** Extras to hand over or sell with it. */
  addons: BookingAddon[];
  /** A lesson: who is coaching it (lib/coaching.ts). */
  coachName: string | null;
  /** This number's strikes at the venue, and its limit; null where the venue counts none. */
  strikes: { count: number; limit: number } | null;
  /** The company or school account it is charged to, and whether it is on an invoice yet (lib/accounts.ts). */
  accountName: string | null;
  invoiced: boolean;
  /** The venue's own note on this customer, by number (lib/customer-notes.ts). */
  staffNote: string | null;
  /** Agreed to the venue's waiver as it stands; true where it asks for none (lib/waivers.ts). */
  waiverSigned: boolean;
  /**
   * Where the booking names who takes part (lib/participant-bookings.ts):
   * each of them, and whether staff saw them arrive (`markPlace`). Empty for
   * a booking its customer takes alone.
   */
  people: { placeId: number; name: string | null; customer: boolean; arrivedAt: string | null; noShow: boolean }[];
  /** One person's concession on their own place (lib/entitlements.ts), and where its proof stands. */
  placeConcessions?: { id: number; name: string | null; concessionName: string; concessionPreset: string | null; amount: number; check: "due" | "seen" | "refused" | null }[];
}

export interface UserBookingRow extends Booking {
  courtName: string;
  sport: Sport;
  venueName: string;
  venueArea: string;
  venueAddress: string;
  /** The venue's time zone, which the booking's times are in. */
  venueTimeZone: string;
  /** Hours before the start it may be cancelled for free. */
  venueCancelCutoffHours: number;
  /** After that, the percent of what was paid the venue keeps; null: no cancelling online. */
  venueLateCancelKeep: number | null;
  /** Strikes before a number pays online to book here; null when the venue counts none. */
  venueStrikeLimit: number | null;
  /** Where to rate the visit, once it has been played (lib/reviews.ts); null otherwise. */
  reviewUrl: string | null;
  /** The most players an open game on it can look for (lib/court-activities.ts `mostSpots`). */
  mostSpots: number;
}

export async function listUserBookings(userId: number): Promise<UserBookingRow[]> {
  const db = getDb();
  const rows = await db
    .prepare(`
      SELECT b.*, c.name AS court_name, b.sport AS court_sport,
             c.capacity AS court_capacity, c.per_player AS court_per_player, c.max_players AS court_max_players,
             v.name AS venue_name, v.area AS venue_area, v.address AS venue_address,
             v.time_zone AS venue_time_zone, v.lat AS venue_lat, v.lng AS venue_lng,
             COALESCE(sr.cancel_cutoff_hours, v.cancel_cutoff_hours) AS venue_cutoff,
             CASE WHEN sr.late_keep = -1 THEN NULL ELSE COALESCE(sr.late_keep, v.late_cancel_keep) END AS venue_late_keep,
             v.strike_limit AS venue_strike_limit,
             ci.checked_in_at, ci.checked_out_at
      FROM bookings b
      JOIN courts c ON c.id = b.court_id
      JOIN venues v ON v.id = c.venue_id
      LEFT JOIN sport_rules sr ON sr.venue_id = v.id AND sr.sport = b.sport
      LEFT JOIN check_ins ci ON ci.booking_id = b.id
      WHERE b.user_id = ?
      ORDER BY b.date DESC, b.start_min DESC
    `)
    .all(userId) as (BookingRow & {
    court_name: string;
    court_sport: Sport;
    court_capacity: number;
    court_per_player: number;
    court_max_players: number | null;
    venue_name: string;
    venue_area: string;
    venue_address: string;
    venue_time_zone: string | null;
    venue_lat: number | null;
    venue_lng: number | null;
    venue_cutoff: number;
    venue_late_keep: number | null;
    venue_strike_limit: number | null;
  })[];
  return rows.map((r) => ({
    ...toBooking(r),
    courtName: r.court_name,
    sport: r.court_sport,
    venueName: r.venue_name,
    venueArea: r.venue_area,
    venueAddress: r.venue_address,
    venueTimeZone: venueZoneOf({ time_zone: r.venue_time_zone, lat: r.venue_lat, lng: r.venue_lng }),
    venueCancelCutoffHours: r.venue_cutoff,
    venueLateCancelKeep: r.venue_late_keep,
    venueStrikeLimit: r.venue_strike_limit,
    reviewUrl: mayReviewByDate(r, venueZoneOf({ time_zone: r.venue_time_zone, lat: r.venue_lat, lng: r.venue_lng })) ? reviewPath(r.code) : null,
    mostSpots: mostSpots({ capacity: r.court_capacity, perPlayer: r.court_per_player === 1, maxPlayers: r.court_max_players }),
  }));
}

/** Played, on a day before today and within the window for reviews; the review page checks the hour. */
function mayReviewByDate(r: BookingRow, zone: string): boolean {
  const today = todayISO(zone);
  return r.status === "confirmed" && r.no_show !== 1 && r.date < today && r.date >= addDays(today, -60);
}

/** Cancel a booking that belongs to this user (before it starts). */
export async function cancelUserBooking(userId: number, bookingId: number): Promise<CancelResult> {
  const db = getDb();
  const row = await db
    .prepare("SELECT b.*, ci.checked_in_at, ci.checked_out_at FROM bookings b LEFT JOIN check_ins ci ON ci.booking_id = b.id WHERE b.id = ? AND b.user_id = ?")
    .get(bookingId, userId) as BookingRow | undefined;
  if (!row) return refuse("BOOKING_NOT_FOUND");
  return customerCancel(toBooking(row));
}

export type PaymentResult = { ok: true; booking: Booking } | Refusal;

/** Front-desk payment toggle for a single booking (admin only). */
export async function setPaymentStatus(
  code: string,
  paid: boolean,
  via: CounterMethod | null = null,
  /** Front desk: may take back only a counter payment it marked today. */
  by: "manager" | "desk" = "manager"
): Promise<PaymentResult> {
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
    if (!paid) {
      // Paid online, with credit or a pass: that money is given back by refunding it, not by a tick.
      if (booking.paidVia === "online" || booking.paidVia === "credit" || booking.paidVia === "pass")
        return refuse("UNPAY_NOT_COUNTER");
      // The desk can put right its own slip on the day; anything older is a manager's.
      const zone = (await venueHours((await getCourt(booking.courtId))!.venueId)).zone;
      if (by === "desk" && (!booking.paidAt || localDateOf(booking.paidAt, zone) !== todayISO(zone)))
        return refuse("UNPAY_MANAGER");
    }

    // Marked by hand: whatever the desk says it was paid with, never the gateway.
    await db.prepare(
      "UPDATE bookings SET payment_status = ?, paid_at = ?, paid_via = ? WHERE id = ?"
    ).run(paid ? "paid" : "unpaid", paid ? new Date().toISOString() : null, paid ? via : null, booking.id);
    return {
      ok: true,
      booking: {
        ...booking,
        paymentStatus: paid ? "paid" : "unpaid",
        paidAt: paid ? new Date().toISOString() : null,
        paidVia: paid ? via : null,
        paidOnline: false,
      },
    };
  });
}

/** Mark every confirmed session in a series paid at once. */
export async function paySeries(
  seriesCode: string,
  via: CounterMethod | null = null
): Promise<{ ok: boolean; paid: number; error?: string }> {
  // One statement: a week paid online a moment ago is not still "unpaid" here,
  // so the counter never writes over it (and the online money is not lost).
  const paid = (await getDb()
    .prepare(
      `UPDATE bookings SET payment_status = 'paid', paid_at = ?, paid_via = ?
        WHERE UPPER(series_code) = UPPER(?) AND status = 'confirmed' AND payment_status = 'unpaid'
        RETURNING id`
    )
    .all(new Date().toISOString(), via, seriesCode.trim())) as { id: number }[];
  if (paid.length === 0) return { ok: false, paid: 0, error: "No unpaid sessions found for that series." };
  return { ok: true, paid: paid.length };
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
function checkInWindowError(booking: Booking, zone: string): string | null {
  const now = Date.now();
  const opens =
    slotStartsAt(booking.date, booking.startHour, zone).getTime() -
    CHECK_IN_OPENS_MINUTES_BEFORE * 60_000;
  if (now < opens)
    return `Check-in opens ${CHECK_IN_OPENS_MINUTES_BEFORE} minutes before your slot.`;
  if (now >= slotStartsAt(booking.date, booking.endHour, zone).getTime())
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
  const windowError = checkInWindowError(booking, await courtZone(booking.courtId));
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
  participant_id: number | null;
  for_participant: boolean;
  review_reason: string | null;
  reviewed_at: unknown;
  reviewed_by_name: string | null;
  review_note: string | null;
  assigned_from_name: string | null;
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
    participantId: r.participant_id,
    forParticipant: r.for_participant === true,
    needsReview: r.review_reason !== null && (r.reviewed_at === null || r.reviewed_at === undefined),
    reviewedBy: r.reviewed_by_name,
    reviewNote: r.review_note,
    assignedFromName: r.assigned_from_name,
  };
}

const INDUCTION_SELECT = `
  SELECT i.*, a.name AS admin_name
  FROM inductions i
  LEFT JOIN admins a ON a.id = i.admin_id
`;

/**
 * Has the holder of this number been shown round themself, and not since
 * been withdrawn? Never by an induction recorded for a participant on it
 * (lib/participants.ts participantInducted is theirs).
 */
export async function isInducted(venueId: number, phone: string): Promise<boolean> {
  const row = await getDb()
    .prepare(
      "SELECT 1 AS n FROM inductions WHERE venue_id = ? AND phone_key(phone) = phone_key(?) AND revoked_at IS NULL AND NOT for_participant"
    )
    .get(venueId, normalisePhone(phone)) as { n: number } | undefined;
  return row !== undefined;
}

export type InductionResult =
  | { ok: true; induction: Induction }
  | Refusal;

/**
 * Record that an operator has shown somebody round: the holder of this
 * number themself, or (`participant`) a participant this venue knows, whose
 * induction is theirs alone and keeps the number (a guardian's) only to
 * reach them. Callers check the participant is one the venue may act for.
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
  participant?: { id: number; name: string } | null;
}): Promise<InductionResult> {
  if (input.participant) return recordParticipantInduction({ ...input, participant: input.participant });
  return withTransaction(async () => {
    const db = getDb();
    if (!await getVenue(input.venueId)) return refuse("VENUE_NOT_FOUND");
    const phone = normalisePhone(input.phone);
    if (phone.length < 7) return { ok: false, error: "Please give a valid phone number." };
    const name = input.name.trim();
    if (name.length < 2) return { ok: false, error: "Please give the person's name." };
    const note = nullIfBlank(input.note ?? null);

    const existing = await db
      .prepare("SELECT id, revoked_at FROM inductions WHERE venue_id = ? AND phone_key(phone) = phone_key(?) AND NOT for_participant")
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

/** A participant's own induction: one line per participant and venue, revived when re-inducted. */
async function recordParticipantInduction(input: {
  venueId: number;
  phone: string;
  adminId?: number;
  note?: string;
  participant: { id: number; name: string };
}): Promise<InductionResult> {
  return withTransaction(async () => {
    const db = getDb();
    if (!await getVenue(input.venueId)) return refuse("VENUE_NOT_FOUND");
    const phone = normalisePhone(input.phone);
    if (phone.length < 7) return { ok: false, error: "Please give a valid phone number." };
    const note = nullIfBlank(input.note ?? null);
    const existing = await db
      .prepare("SELECT id, revoked_at FROM inductions WHERE venue_id = ? AND participant_id = ?")
      .get(input.venueId, input.participant.id) as { id: number; revoked_at: string | null } | undefined;
    if (existing && existing.revoked_at === null)
      return { ok: false, error: `${input.participant.name} has already been inducted here.` };
    if (existing) {
      await db
        .prepare("UPDATE inductions SET name = ?, phone = ?, admin_id = ?, note = ?, created_at = datetime('now'), revoked_at = NULL WHERE id = ?")
        .run(input.participant.name, phone, input.adminId ?? null, note, existing.id);
      return { ok: true, induction: (await inductionById(existing.id))! };
    }
    const info = await db
      .prepare("INSERT INTO inductions (venue_id, phone, name, admin_id, note, participant_id, for_participant) VALUES (?, ?, ?, ?, ?, ?, true)")
      .run(input.venueId, phone, input.participant.name, input.adminId ?? null, note, input.participant.id);
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
  const { zone } = await venueHours(venueId);
  const rows = await getDb()
    .prepare(`
      SELECT b.ends_at FROM check_ins ci
      JOIN bookings b ON b.id = ci.booking_id
      JOIN courts c ON c.id = b.court_id
      WHERE c.venue_id = ? AND ci.checked_out_at IS NULL
        AND b.status = 'confirmed' AND b.date = ?
    `)
    .all(venueId, todayISO(zone)) as { ends_at: Date }[];
  const now = Date.now();
  return rows.filter((r) => new Date(r.ends_at).getTime() > now).length;
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
  // a code in circulation for no reason. The booking's whole time decides,
  // not its start: one that runs on after the counter shuts gets the code
  // (so nobody is shut out, or in, at the end) unless the venue keeps
  // somebody on the desk until such bookings end.
  const door = doorFor(venue, Math.round(booking.startHour * 60), Math.round(booking.endHour * 60));
  if (door.by === "counter")
    return {
      ok: false,
      reason: "staffed-now",
      message: door.partly
        ? `Someone stays on the desk until your booking ends. Ask at the counter and they will let you in.`
        : `Someone is on the desk at that hour. Ask at the counter and they will let you in.`,
    };

  // Nobody is here to show a stranger where the emergency button is, so that
  // has to have happened already, in person, while somebody could check it:
  // to everybody taking part, each by their own induction (never a
  // guardian's, a sibling's or the number's when the booking is for somebody
  // else; lib/participants.ts).
  const bookedBy = ((await db.prepare("SELECT user_id FROM bookings WHERE id = ?").get(booking.id)) as { user_id: number | null } | undefined)?.user_id ?? null;
  if (!(await placesInducted(venue.id, { id: booking.id, phone: booking.phone, userId: bookedBy })))
    return {
      ok: false,
      reason: "no-induction",
      message:
        "Before using this outside staffed hours you need a one-off run-through at the desk. Drop in while the counter is open and it takes a few minutes.",
    };

  // Attendance a manager arranged under staff supervision is met by staff:
  // never a door code, whatever else the person holds (ADR 0020).
  const supervised = (await db.prepare("SELECT staff_supervised FROM bookings WHERE id = ?").get(booking.id)) as { staff_supervised: boolean } | undefined;
  if (supervised?.staff_supervised === true)
    return {
      ok: false,
      reason: "supervised",
      message: "Staff will meet you for this booking and let you in. There is no door code for it.",
    };

  // An activity whose rules ask for a sign-off or a certification opens no
  // door to a booking without one in force that day: a session booked for an
  // approval's in-person step (lib/approvals.ts), or one a manager booked
  // past the rules, waits for somebody to be there. A pending, refused,
  // lapsed or revoked approval is not one. The rules are the booked
  // activity's, on a resource that offers several, and an activity the venue
  // takes approval applications for needs its approval here whatever its
  // booking rules say (ADR 0020).
  const rules = await policyFor(courtFor(court, courtOffers(court, booking.sport) ? booking.sport : court.sport));
  const asked = (await db
    .prepare("SELECT kind FROM approval_requirements WHERE venue_id = ? AND sport = ?")
    .get(venue.id, booking.sport)) as { kind: string } | undefined;
  const need =
    rules.certification || asked?.kind === "certification" ? "certification" : rules.signOff || asked ? "any" : null;
  // Each taking part on their own sign-off: for somebody booked for, theirs, never the adult's or a sibling's.
  let signedOff = true;
  if (need)
    for (const place of await bookingPlaces(booking.id))
      signedOff =
        signedOff &&
        place.customer !== (place.participantId !== null) &&
        (await signOffHolds({
          venueId: venue.id,
          sport: booking.sport,
          until: booking.date,
          phone: booking.phone,
          userId: bookedBy,
          channel: "staff",
          need,
          participant: place.customer ? null : place.participantId,
        }));
  if (!signedOff)
    return {
      ok: false,
      reason: "approval-needed",
      message:
        need === "certification"
          ? "This activity needs a certification the venue has recorded for you before the door code is given. Ask at the counter while it is open."
          : "This activity needs a sign-off from the venue's staff before the door code is given. Ask at the counter while it is open.",
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
    slotStartsAt(booking.date, booking.startHour, venue.timeZone).getTime() -
    CHECK_IN_OPENS_MINUTES_BEFORE * 60_000;
  const ends = slotStartsAt(booking.date, booking.endHour, venue.timeZone).getTime();
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
  participant_name: string | null;
}

const HIRE_SELECT = `
  SELECT h.*, b.code, b.court_id, b.name, b.phone, b.participant_name, c.name AS court_name, c.venue_id
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
    // Who has the kit, where the booking is for somebody else; the customer holds the deposit.
    participantName: r.participant_name ?? null,
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
  if (!isAmount(held))
    return { ok: false, error: `A deposit must be ${money(0)} or more, to the ${region().currency.minor}.` };
  if (held > MAX_DEPOSIT)
    return { ok: false, error: `A deposit cannot be more than ${money(MAX_DEPOSIT)}.` };

  if (!booking.checkedInAt) {
    const windowError = checkInWindowError(booking, await courtZone(booking.courtId));
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
  input: {
    condition: HireCondition;
    /** What is kept back, and why, reason by reason (lib/deposit-deductions.ts). */
    deductions?: { reason: unknown; amount: unknown }[];
    /** The older way: one amount, its reason taken from the condition (damaged, lost; otherwise "other"). */
    withheld?: number;
    note?: string;
    /** How the deposit was held, so what is kept is in the takings under the same method; cash unless said. */
    via?: CounterMethod;
  }
): Promise<HireResult> {
  const db = getDb();
  const booking = await bookingByCode(code);
  if (!booking) return refuse("BOOKING_NOT_FOUND");

  const hire = await hireFor(booking.id);
  if (!hire) return { ok: false, error: "No deposit is held on this booking." };
  if (hire.returnedAt) return { ok: false, error: "This kit has already been taken back." };

  if (!HIRE_CONDITIONS.includes(input.condition))
    return { ok: false, error: "Unknown condition." };

  const { isDeductionReason } = await import("./deposit-deductions");
  const fromCondition = input.condition === "damaged" ? "damage" : input.condition === "lost" ? "loss" : "other";
  const asked = input.deductions ?? (input.withheld ? [{ reason: fromCondition, amount: input.withheld }] : []);
  if (!Array.isArray(asked)) return { ok: false, error: "Deductions are a list of reasons and amounts." };
  const deductions: { reason: import("./deposit-deductions").DeductionReason; amount: number }[] = [];
  for (const d of asked) {
    if (!isDeductionReason(d?.reason)) return { ok: false, error: "Say why each amount is kept back." };
    if (typeof d.amount !== "number" || !isAmount(d.amount) || d.amount <= 0)
      return { ok: false, error: `An amount kept back must be more than ${money(0)}, to the ${region().currency.minor}.` };
    if (deductions.some((x) => x.reason === d.reason)) return { ok: false, error: "Each reason once: add its amounts together." };
    deductions.push({ reason: d.reason, amount: d.amount });
  }
  const withheld = roundMoney(deductions.reduce((sum, d) => sum + d.amount, 0));
  if (withheld > hire.deposit)
    return {
      ok: false,
      error: `Only ${money(hire.deposit)} is held on this booking, so ${money(withheld)} cannot be kept back.`,
    };

  const note = (input.note ?? "").trim();
  if (note.length > MAX_HIRE_NOTE)
    return { ok: false, error: `A note cannot be longer than ${MAX_HIRE_NOTE} characters.` };
  if ((input.condition !== "ok" || withheld > 0) && note === "")
    return { ok: false, error: "Say what happened — a note is required when the kit is not returned fine." };

  const via = input.via ?? "cash";
  if (!COUNTER_METHODS.includes(via)) return { ok: false, error: "Say how the deposit was paid." };
  const court = await getCourt(booking.courtId);

  const returned = await db.transaction(async () => {
    // Only the return that gets there first: two at once keep the deposit once.
    const done = await db.prepare(`
      UPDATE hire_records
      SET returned_at = datetime('now'), withheld = ?, condition = ?, note = ?
      WHERE booking_id = ? AND returned_at IS NULL
      RETURNING id
    `).get(withheld, input.condition, note === "" ? null : note, booking.id) as { id: number } | undefined;
    if (!done) return false;
    // What is kept is income: rung up and receipted with the return (M13),
    // reason by reason, each with the tax its nature carries at this venue.
    const { sellKeptDeposit } = await import("./counter-sales");
    const { DEDUCTION_INFO } = await import("./deposit-deductions");
    for (const d of deductions)
      await sellKeptDeposit({
        venueId: court?.venueId ?? 0,
        hireRecordId: done.id,
        reason: d.reason,
        description: `${DEDUCTION_INFO[d.reason].label}: ${court?.name ?? "hired kit"} (${booking.code}). ${note}`,
        phrase: said("srv.line.kept", { reason: said(`srv.deduction.${d.reason}`), item: court?.name ?? said("srv.line.hiredKit"), code: booking.code, note }),
        amount: d.amount,
        via,
        customerName: booking.name,
        customerPhone: booking.phone,
      });
    // The kit is back, so whoever brought it has left the desk.
    await db.prepare(
      "UPDATE check_ins SET checked_out_at = datetime('now') WHERE booking_id = ? AND checked_out_at IS NULL"
    ).run(booking.id);
    return true;
  })();
  if (!returned) return { ok: false, error: "This kit has already been taken back." };

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
  const { zone } = await venueHours(venueId);
  const courts = (
    await db.prepare("SELECT * FROM courts WHERE venue_id = ? ORDER BY id").all(venueId) as CourtRow[]
  ).map(toCourt);
  if (courts.length === 0) return [];

  const rows = await db
    .prepare(`
      SELECT b.court_id, b.ends_at FROM check_ins ci
      JOIN bookings b ON b.id = ci.booking_id
      JOIN courts c ON c.id = b.court_id
      WHERE c.venue_id = ? AND ci.checked_out_at IS NULL
        AND b.status = 'confirmed' AND b.date = ?
    `)
    .all(venueId, todayISO(zone)) as { court_id: number; ends_at: Date }[];

  const now = Date.now();
  const present = new Map<number, number>();
  for (const row of rows) {
    if (new Date(row.ends_at).getTime() <= now) continue;
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
    if (noShow && !isPastSlot(booking.date, booking.startHour, await courtZone(booking.courtId)))
      return { ok: false, error: "This booking has not started yet." };
    if (noShow && booking.checkedInAt)
      return { ok: false, error: "This customer checked in, so they were not a no-show." };
    if (booking.noShow === noShow)
      return { ok: false, error: `Already marked ${noShow ? "a no-show" : "attended"}.` };

    await db.prepare("UPDATE bookings SET no_show = ? WHERE id = ?").run(noShow ? 1 : 0, booking.id);
    return { ok: true, booking: { ...booking, noShow } };
  });
}

/** One person taking a place on a booking, and whether staff saw them arrive (lib/participant-bookings.ts; migration 0147). */
export interface PlaceAttendance {
  placeId: number;
  /** The participant, by id (null for the customer, or once erased). */
  participantId: number | null;
  /** The booking's own customer, taking a place alongside others. */
  customer: boolean;
  name: string | null;
  arrivedAt: string | null;
  noShow: boolean;
  /** Staff who recorded it, by name as it was. */
  recordedBy: string | null;
}

/**
 * Who of the people a booking names arrived, did not, or is not yet known;
 * nothing for a booking taken by its customer alone (its check-in is theirs).
 */
export async function placeAttendance(bookingId: number): Promise<PlaceAttendance[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT bp.id, bp.takes_part_as, bp.participant_id, bp.name, pa.arrived_at, pa.no_show, pa.recorded_by_name
         FROM booking_participants bp LEFT JOIN place_attendance pa ON pa.place_id = bp.id
        WHERE bp.booking_id = ? ORDER BY bp.id`
    )
    .all(bookingId)) as {
    id: number;
    takes_part_as: "customer" | "participant";
    participant_id: number | null;
    name: string | null;
    arrived_at: unknown;
    no_show: boolean | null;
    recorded_by_name: string | null;
  }[];
  if (!rows.some((r) => r.takes_part_as === "participant")) return [];
  return rows.map((r) => ({
    placeId: r.id,
    participantId: r.participant_id,
    customer: r.takes_part_as === "customer",
    name: r.name,
    arrivedAt: r.arrived_at === null || r.arrived_at === undefined ? null : r.arrived_at instanceof Date ? r.arrived_at.toISOString() : String(r.arrived_at),
    noShow: r.no_show === true,
    recordedBy: r.recorded_by_name,
  }));
}

export type PlaceMarkResult = { ok: true; booking: Booking; places: PlaceAttendance[] } | Refusal;

/**
 * Staff record that one person a booking names arrived, did not, or clear
 * what was recorded (`clear`). An arrival checks the booking in (it counts
 * as checked in once anybody on it arrived), within the check-in window; a
 * no-show only once it has started, and never for somebody seen to arrive.
 * The booking is a no-show (the strike its customer may carry) only when
 * everybody it names was one and nobody checked it in. Who recorded it is
 * kept.
 */
export async function markPlace(code: string, placeId: number, mark: "arrived" | "no_show" | "clear", admin: { id: number | null; name: string }): Promise<PlaceMarkResult> {
  return withTransaction(async () => {
    const db = getDb();
    const found = await bookingByCode(code);
    if (!found) return refuse("BOOKING_NOT_FOUND");
    // One change at a time to a booking's attendance.
    await db.prepare("SELECT id FROM bookings WHERE id = ? FOR UPDATE").get(found.id);
    const booking = (await bookingByCode(code))!;
    if (booking.status === "cancelled") return refuse("BOOKING_WAS_CANCELLED");
    const place = (await db
      .prepare("SELECT id FROM booking_participants WHERE id = ? AND booking_id = ?")
      .get(placeId, booking.id)) as { id: number } | undefined;
    if (!place || (await placeAttendance(booking.id)).length === 0) return { ok: false, error: "No such person on this booking." };
    const before = (await db.prepare("SELECT check_in_id FROM place_attendance WHERE place_id = ?").get(place.id)) as { check_in_id: number | null } | undefined;
    const zone = await courtZone(booking.courtId);

    if (mark === "arrived") {
      if (!booking.checkedInAt) {
        const windowError = checkInWindowError(booking, zone);
        if (windowError) return { ok: false, error: windowError };
        await db.prepare("INSERT INTO check_ins (booking_id) VALUES (?)").run(booking.id);
      }
      const checkIn = (await db.prepare("SELECT id FROM check_ins WHERE booking_id = ?").get(booking.id)) as { id: number };
      await db
        .prepare(
          `INSERT INTO place_attendance (place_id, booking_id, check_in_id, arrived_at, no_show, recorded_by_admin_id, recorded_by_name)
           VALUES (?, ?, ?, now(), false, ?, ?)
           ON CONFLICT (place_id) DO UPDATE SET check_in_id = EXCLUDED.check_in_id, arrived_at = EXCLUDED.arrived_at, no_show = false,
             recorded_by_admin_id = EXCLUDED.recorded_by_admin_id, recorded_by_name = EXCLUDED.recorded_by_name, recorded_at = now()`
        )
        .run(place.id, booking.id, checkIn.id, admin.id, admin.name);
      // Arriving contradicts a no-show, so clear any stale flag.
      if (booking.noShow) await db.prepare("UPDATE bookings SET no_show = 0 WHERE id = ?").run(booking.id);
    } else if (mark === "no_show") {
      if (!isPastSlot(booking.date, booking.startHour, zone)) return { ok: false, error: "This booking has not started yet." };
      if (before?.check_in_id) return { ok: false, error: "They checked in, so they were not a no-show." };
      await db
        .prepare(
          `INSERT INTO place_attendance (place_id, booking_id, check_in_id, arrived_at, no_show, recorded_by_admin_id, recorded_by_name)
           VALUES (?, ?, NULL, NULL, true, ?, ?)
           ON CONFLICT (place_id) DO UPDATE SET check_in_id = NULL, arrived_at = NULL, no_show = true,
             recorded_by_admin_id = EXCLUDED.recorded_by_admin_id, recorded_by_name = EXCLUDED.recorded_by_name, recorded_at = now()`
        )
        .run(place.id, booking.id, admin.id, admin.name);
    } else {
      await db.prepare("DELETE FROM place_attendance WHERE place_id = ?").run(place.id);
    }

    // The booking's own no-show: everybody it names was one, and nobody checked it in.
    const places = await placeAttendance(booking.id);
    const allAway = places.every((p) => p.noShow) && !booking.checkedInAt;
    if (allAway !== booking.noShow && (allAway || mark !== "arrived"))
      await db.prepare("UPDATE bookings SET no_show = ? WHERE id = ?").run(allAway ? 1 : 0, booking.id);
    return { ok: true as const, booking: (await bookingByCode(code))!, places };
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
  // An activity in the catalogue the venue may offer: the platform's, or its own business's.
  if (!(await venueMayOffer(input.venueId, input.sport))) return refuse("UNKNOWN_SPORT");
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
  // A court taking one booking at a time is given a space of its own by the database (lib/claims.ts).
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
    /** Priced per player, and the most one booking takes (null for DEFAULT_MAX_PLAYERS). */
    perPlayer?: boolean;
    maxPlayers?: number | null;
    /** With places: one price for the whole booking rather than per place. */
    flatRate?: boolean;
    /** Run as classes only: customers book its classes, not the room. */
    classesOnly?: boolean;
    /** Lower prices for larger bookings (lib/pricing.ts); null for none. */
    quantityPrices?: unknown;
  }
): Promise<CourtEditResult> {
  const db = getDb();
  const court = await getCourt(courtId);
  if (!court) return refuse("COURT_NOT_FOUND");

  // A linked court is sold whole: places would not hold the floor (lib/court-links.ts).
  if (changes.capacity !== undefined && changes.capacity > 1 && (await db.prepare("SELECT 1 FROM court_links WHERE whole_id = ? OR part_id = ?").get(courtId, courtId)))
    return { ok: false, error: "This court shares its floor with others, so it is booked whole. Unlink it first." };

  // What holds the court from now on, to check a change of capacity against.
  const upcoming = changes.capacity !== undefined && changes.capacity !== court.capacity
    ? ((await db
        .prepare(
          `SELECT lower(occupied) AS lo, upper(occupied) AS hi, COALESCE(places, 1) AS places FROM claims
            WHERE court_id = ? AND active AND (upper(occupied) IS NULL OR upper(occupied) > now())`
        )
        .all(courtId)) as { lo: Date; hi: Date | null; places: number }[])
    : [];
  // One booking at a time and places are held differently (lib/claims.ts): a
  // court changes between them only with nothing to come on it.
  if (changes.capacity !== undefined && (changes.capacity === 1) !== (court.capacity === 1) && upcoming.length > 0)
    return { ok: false, error: "This court has bookings or blocks to come. Change between one booking at a time and places once they are over." };
  // Shrinking capacity below what is already booked would strand those
  // bookings, so refuse rather than silently overbook.
  if (changes.capacity !== undefined && changes.capacity < court.capacity && court.capacity > 1) {
    const edges = upcoming
      .flatMap((c) => [[new Date(c.lo).getTime(), Number(c.places)], [c.hi === null ? Infinity : new Date(c.hi).getTime(), -Number(c.places)]] as [number, number][])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let load = 0;
    let peak = 0;
    for (const [, d] of edges) peak = Math.max(peak, (load += d));
    if (peak > changes.capacity)
      return {
        ok: false,
        error: `Capacity cannot go below ${peak} — that many places are already booked at an upcoming time.`,
      };
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
    return { ok: false, error: `A deposit cannot be more than ${money(MAX_DEPOSIT)}.` };
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
  const watched = court.activities.find((a) => activity(a.sport).supervised);
  if (unmanned && watched)
    return {
      ok: false,
      error: `${activityName(watched.sport)} cannot be left unmanned — someone has to be watching the water.`,
    };
  // A deposit is a person looking at a hull. There is nobody to hand the
  // kayak to, nobody to look it over, and nobody to hold the money.
  if (unmanned && deposit > 0)
    return {
      ok: false,
      error: "Something hired out against a deposit needs someone at the counter, so it cannot be unmanned.",
    };

  const perPlayer = changes.perPlayer ?? court.perPlayer ?? false;
  const capacity = changes.capacity ?? court.capacity;
  // A facility with places may take one a booking (a gym session each); a court priced per player at least two.
  const fewest = capacity > 1 ? 1 : 2;
  // As many as the venue likes, up to every place it has; a court priced per player up to MAX_PLAYERS.
  const most = mostPerBookingAllowed(capacity);
  let maxPlayers = changes.maxPlayers !== undefined ? changes.maxPlayers : court.maxPlayers ?? null;
  // Places changed under a limit set before: the limit follows them down, as
  // it already did for every booking (`placesPerBooking`), rather than refuse.
  if (changes.maxPlayers === undefined && maxPlayers !== null && (maxPlayers > most || maxPlayers < fewest))
    maxPlayers = maxPlayers > most ? most : null;
  if (maxPlayers !== null && (!Number.isInteger(maxPlayers) || maxPlayers < fewest || maxPlayers > most))
    return { ok: false, error: `Up to ${fewest} to ${most} in one booking.` };
  // A shared facility already sells places, one per person.
  if (perPlayer && capacity > 1)
    return { ok: false, error: "This sells places already, one per person: price it per place instead." };
  // One price for the whole booking only means something where a booking can take several places.
  const flatRate = changes.flatRate ?? court.flatRate ?? false;
  if (flatRate && capacity === 1)
    return { ok: false, error: "A court booked whole already has one price for the booking." };
  const bands = changes.quantityPrices !== undefined ? readQuantityPrices(changes.quantityPrices) : { ok: true as const, value: court.quantityPrices ?? null };
  if (!bands.ok) return { ok: false, error: bands.error };

  const codeChanged = codeGiven && newCode !== stored.code;

  await db.transaction(async () => {
    await db.prepare(`
      UPDATE courts SET name = ?, off_peak_rate = ?, peak_rate = ?,
                        member_off_peak_rate = ?, member_peak_rate = ?, capacity = ?,
                        deposit = ?, unmanned = ?, access_code = ?,
                        per_player = ?, max_players = ?, flat_rate = ?, quantity_prices = ?, classes_only = ?
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
      perPlayer ? 1 : 0,
      maxPlayers,
      flatRate,
      bands.value ? JSON.stringify(bands.value) : null,
      changes.classesOnly ?? court.classesOnly ?? false,
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
      SELECT b.*, c.name AS court_name, b.sport AS court_sport, c.deposit AS court_deposit,
             v.id AS venue_id, v.name AS venue_name, ci.checked_in_at, ci.checked_out_at,
             u.verified_phone AS user_verified_phone, k.name AS coach_name, ac.name AS account_name
      FROM bookings b
      JOIN courts c ON c.id = b.court_id
      JOIN venues v ON v.id = c.venue_id
      LEFT JOIN check_ins ci ON ci.booking_id = b.id
      LEFT JOIN users u ON u.id = b.user_id
      LEFT JOIN coaches k ON k.id = b.coach_id
      LEFT JOIN venue_accounts ac ON ac.id = b.account_id
      WHERE b.date = ?${venue.sql}
      ORDER BY v.id, c.id, b.start_min
    `)
    .all(date, ...venue.params) as (BookingRow & {
    court_name: string;
    court_sport: Sport;
    court_deposit: number;
    venue_id: number;
    venue_name: string;
    user_verified_phone: string | null;
    coach_name: string | null;
    account_name: string | null;
    account_invoice_id: number | null;
  })[];
  // One pass for the whole day rather than a lookup per row.
  const hires = new Map<number, HireRecord>();
  if (rows.length > 0) {
    const held = await db
      .prepare(`${HIRE_SELECT} WHERE h.booking_id IN (${rows.map(() => "?").join(",")})`)
      .all(...rows.map((r) => r.id)) as HireRow[];
    for (const row of held) hires.set(row.booking_id, toHire(row));
  }
  const extras = await addonsFor(rows.map((r) => r.id));
  const notes = await notesFor(rows.map((r) => ({ venueId: r.venue_id, phone: r.phone })));
  // Each person taking part: the customer's own agreement, or each participant's (lib/participants.ts).
  const places = new Map<number, (number | null)[]>();
  // And who of them arrived, for the counter to say person by person (`markPlace`).
  const people = new Map<number, AdminBookingRow["people"]>();
  if (rows.length > 0) {
    const named = (await db
      .prepare(
        `SELECT bp.id, bp.booking_id, bp.takes_part_as, bp.participant_id, bp.name, pa.arrived_at, pa.no_show
           FROM booking_participants bp LEFT JOIN place_attendance pa ON pa.place_id = bp.id
          WHERE bp.booking_id IN (${rows.map(() => "?").join(",")}) ORDER BY bp.id`
      )
      .all(...rows.map((r) => r.id))) as {
      id: number;
      booking_id: number;
      takes_part_as: string;
      participant_id: number | null;
      name: string | null;
      arrived_at: unknown;
      no_show: boolean | null;
    }[];
    for (const n of named) {
      places.set(n.booking_id, [...(places.get(n.booking_id) ?? []), n.takes_part_as === "customer" ? null : (n.participant_id ?? -1)]);
      people.set(n.booking_id, [
        ...(people.get(n.booking_id) ?? []),
        {
          placeId: n.id,
          name: n.name,
          customer: n.takes_part_as === "customer",
          arrivedAt: n.arrived_at === null || n.arrived_at === undefined ? null : n.arrived_at instanceof Date ? n.arrived_at.toISOString() : String(n.arrived_at),
          noShow: n.no_show === true,
        },
      ]);
    }
  }
  // One person's concession on their own place, for the desk to check their proof (lib/entitlements.ts).
  const placeConcessions = new Map<number, NonNullable<AdminBookingRow["placeConcessions"]>>();
  if (rows.length > 0) {
    const live = (await db
      .prepare(
        `SELECT pb.id, pb.booking_id, pb.concession_name, pb.concession_preset, pb.amount::float AS amount, pb.proof_check, bp.name
           FROM place_benefits pb LEFT JOIN booking_participants bp ON bp.id = pb.place_id
          WHERE pb.booking_id IN (${rows.map(() => "?").join(",")}) AND pb.kind = 'concession' AND (pb.reversed_at IS NULL OR pb.proof_check = 'refused')
          ORDER BY pb.id`
      )
      .all(...rows.map((r) => r.id))) as {
      id: number;
      booking_id: number;
      concession_name: string | null;
      concession_preset: string | null;
      amount: number;
      proof_check: "due" | "seen" | "refused" | null;
      name: string | null;
    }[];
    for (const c of live)
      placeConcessions.set(c.booking_id, [
        ...(placeConcessions.get(c.booking_id) ?? []),
        { id: c.id, name: c.name, concessionName: c.concession_name ?? "", concessionPreset: c.concession_preset, amount: Number(c.amount), check: c.proof_check },
      ]);
  }
  const placesOf = (r: { id: number }) => places.get(r.id) ?? [null];
  const waivers = await signaturesFor(
    rows.flatMap((r) => placesOf(r).map((p) => ({ venueId: r.venue_id, phone: r.phone, participant: p })))
  );
  const policies = new Map<number, Awaited<ReturnType<typeof cancelPolicy>>>();
  for (const r of rows) if (!policies.has(r.venue_id)) policies.set(r.venue_id, await cancelPolicy(r.venue_id));

  // No-shows and strikes for every number on the day in two queries, not two per row; and each
  // venue's own, by the number however it was typed: another venue's dealings are not its staff's.
  const keys = [...new Set(rows.map((r) => phoneKey(r.phone)))];
  const venueIds = [...policies.keys()];
  const history = new Map<string, { noShows: number; strikeDates: string[] }>();
  if (keys.length > 0) {
    const longest = Math.max(0, ...[...policies.values()].map((p) => p.strikeDays));
    const marked = (await db
      .prepare(
        `SELECT c.venue_id, b.phone_key, b.date, b.no_show,
                (b.no_show = 1 OR (b.late_cancelled = 1 AND b.payment_status <> 'paid' AND b.deposit_paid = 0))
                  AND b.date > COALESCE((SELECT forgiven_on FROM strike_forgiveness f WHERE f.venue_id = c.venue_id AND f.phone_key = b.phone_key), '')
                  AND b.date >= ? AS strike
           FROM bookings b JOIN courts c ON c.id = b.court_id
          WHERE c.venue_id IN (${venueIds.map(() => "?").join(",")}) AND b.phone_key IN (${keys.map(() => "?").join(",")})
            AND (b.no_show = 1 OR (b.late_cancelled = 1 AND b.payment_status <> 'paid' AND b.deposit_paid = 0))`
      )
      .all(addDays(todayISO(), -longest), ...venueIds, ...keys)) as {
      venue_id: number;
      phone_key: string;
      date: string;
      no_show: number;
      strike: boolean | number;
    }[];
    for (const m of marked) {
      const key = `${m.venue_id}:${m.phone_key}`;
      const h = history.get(key) ?? { noShows: 0, strikeDates: [] };
      if (m.no_show === 1) h.noShows++;
      if (m.strike === true || m.strike === 1) h.strikeDates.push(m.date);
      history.set(key, h);
    }
  }

  const list: AdminBookingRow[] = [];
  for (const r of rows) {
    const booking = toBooking(r);
    const policy = policies.get(r.venue_id)!;
    const h = history.get(`${r.venue_id}:${phoneKey(booking.phone)}`) ?? { noShows: 0, strikeDates: [] };
    const since = addDays(todayISO(), -policy.strikeDays);
    list.push({
      ...booking,
      courtName: r.court_name,
      sport: r.court_sport,
      venueId: r.venue_id,
      venueName: r.venue_name,
      // Exclude this booking so the count reads as history, not self-reference.
      priorNoShows: h.noShows - (booking.noShow ? 1 : 0),
      courtDeposit: r.court_deposit,
      hire: hires.get(booking.id) ?? null,
      phoneChecked: r.user_verified_phone !== null && phoneNumber(booking.phone) === r.user_verified_phone,
      addons: extras.get(booking.id) ?? [],
      coachName: r.coach_name,
      strikes:
        policy.strikeLimit === null
          ? null
          : { count: h.strikeDates.filter((d) => d >= since).length, limit: policy.strikeLimit },
      accountName: r.account_name,
      invoiced: r.account_invoice_id !== null,
      staffNote: notes.get(`${r.venue_id}:${phoneKey(booking.phone)}`) ?? null,
      waiverSigned: placesOf(r).every((p) => waivers.get(p !== null ? `${r.venue_id}:p${p}` : `${r.venue_id}:${phoneKey(booking.phone)}`) ?? true),
      people: (people.get(booking.id) ?? []).some((p) => !p.customer) ? people.get(booking.id)! : [],
      ...(placeConcessions.has(booking.id) ? { placeConcessions: placeConcessions.get(booking.id)! } : {}),
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
  start_min: number;
  end_min: number;
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
  who: ClassSession["who"];
  term_off_percent?: number | null;
}

const CLASS_SELECT = `
  SELECT cl.*, c.name AS court_name,
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
    startMin: r.start_min,
    endMin: r.end_min,
    startHour: hoursOf(r.start_min),
    endHour: hoursOf(r.end_min),
    capacity: r.capacity,
    price: r.price,
    status: r.status,
    seriesCode: r.series_code,
    enrolled: r.enrolled,
    who: r.who ?? "anyone",
    termOffPercent: r.term_off_percent ?? null,
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
  // One venue's own classes (its page has already been let in) need only be
  // live; the public classes page needs venues in public lists.
  if (filter.openOnly) clauses.push(filter.venueId ? OPEN_TO_CUSTOMERS : listRule(filter.venueIds));
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
    clauses.push("cl.sport = ?");
    params.push(filter.sport);
  }
  if (filter.to) {
    clauses.push("cl.date <= ?");
    params.push(filter.to);
  }

  const rows = await getDb()
    .prepare(`${CLASS_SELECT} WHERE ${clauses.join(" AND ")} ORDER BY cl.date, cl.start_min, cl.id`)
    .all(...params) as ClassRow[];
  return rows.map(toClass);
}

export type CreateClassResult =
  | { ok: true; classes: ClassSession[]; seriesCode: string | null }
  | Refusal;

/**
 * Schedule a class, optionally repeating weekly for a term. A class holds its
 * court (all of a shared facility's places) for its time, with the court's
 * buffers: it cannot be laid over bookings, blocks or another class, and
 * nothing can be booked over it afterwards.
 */
export async function createClassSessions(input: {
  courtId: number;
  name: string;
  instructor: string;
  date: string;
  /** Its time, in minutes of the day (or hours, the older way). */
  start?: number;
  end?: number;
  startHour?: number;
  endHour?: number;
  capacity: number;
  price: number;
  weeks?: number;
  /** Anyone, women only or men only. */
  who?: ClassSession["who"];
  /** A share off each session for joining the whole term at once. */
  termOffPercent?: number | null;
}): Promise<CreateClassResult> {
  const { courtId, date } = input;
  const start = minutesFrom(input.start, input.startHour);
  const end = minutesFrom(input.end, input.endHour);
  const weeks = input.weeks ?? 1;
  const who = input.who ?? "anyone";
  if (who !== "anyone" && who !== "women" && who !== "men") return { ok: false, error: "Anyone, women only or men only." };

  const court = await getCourt(courtId);
  if (!court) return refuse("COURT_NOT_FOUND");
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > MAX_CLASS_WEEKS)
    return { ok: false, error: `Weeks must be between 1 and ${MAX_CLASS_WEEKS}.` };
  const termOff = input.termOffPercent ?? null;
  if (termOff !== null && (!Number.isInteger(termOff) || termOff < 0 || termOff > 50))
    return { ok: false, error: "Take 0 to 50 percent off for the whole term." };
  const day = await courtDay(court, date);
  if (!isMinute(start) || !isMinute(end) || start < day.openMin || end > day.closeMin || end <= start)
    return { ok: false, error: "Class hours are outside operating hours." };
  if (await getVenueClosure(court.venueId, date))
    return refuse("VENUE_CLOSED");
  if (input.capacity < 1 || input.capacity > court.capacity)
    return {
      ok: false,
      error: `Capacity must be 1–${court.capacity}, the capacity of ${court.name}.`,
    };
  if (minutesUntil(date, start, day.zone) <= 0)
    return { ok: false, error: "That start time has already passed." };

  const span = { start, end };
  const db = getDb();
  const seriesCode = weeks > 1 ? randomCode("CL-") : null;

  try {
    const created = await withTransaction(async () => {
      const sessions: ClassSession[] = [];
      for (let week = 0; week < weeks; week++) {
        const weekDate = addDays(date, week * 7);
        const row = (await db
          .prepare(
            `INSERT INTO classes (court_id, name, instructor, date, start_min, end_min, capacity, price, series_code, who, term_off_percent)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
          )
          .get(
            courtId, input.name.trim(), input.instructor.trim(), weekDate,
            start, end, input.capacity, input.price, seriesCode, who, seriesCode ? termOff : null
          )) as { id: number };
        try {
          await withTransaction(() =>
            claim({
              court,
              source: { kind: "class", classId: row.id },
              date: weekDate,
              span,
              zone: day.zone,
              places: court.capacity,
              ...claimBuffers(day.policy),
            })
          );
        } catch (err) {
          if (!isConflict(err)) throw err;
          const held = (await occupantsOn([court], weekDate, day.zone)).get(court.id)!;
          const why = whyTaken(held, court, span, policyBuffers(day.policy));
          throw new Error(`${why?.why === "class" ? "CLASH" : "BOOKED"}:${weekDate}`);
        }
        sessions.push((await getClass(row.id))!);
      }
      return sessions;
    });
    return { ok: true, classes: created, seriesCode };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("BOOKED:"))
      return {
        ok: false,
        error: `${message.slice(7)} already has bookings or blocks in those hours. Cancel them first.`,
      };
    if (message.startsWith("CLASH:"))
      return { ok: false, error: `${message.slice(6)} already has a class at that time.` };
    throw err;
  }
}

export type EnrolResult = { ok: true; booking: Booking } | Refusal;

/**
 * Take a place in a class. The enrolment is a booking of the class's time,
 * holding a place in the class (the class holds the court). The class row is
 * locked while its places are counted, so two people cannot take its last.
 */
async function enrolInClassOnce(input: {
  classId: number;
  name: string;
  phone: string;
  email?: string;
  userId?: number;
  /** The waiting-list offer being claimed, whose own hold does not count. */
  waitlistId?: number;
}): Promise<EnrolResult> {
  const made = await enrolPeopleOnce({ ...input, people: [null] });
  return made.ok ? { ok: true, booking: made.bookings[0] } : made;
}

export type EnrolPeopleResult = { ok: true; bookings: Booking[] } | Refusal;

/**
 * Enrol several people in a class at once, all or none: the customer
 * (`null`) and each participant (lib/participant-bookings.ts) a place and an
 * enrolment of their own, so each is on the roster, checked in, cancelled
 * and refunded as themself. The class is locked while its places are
 * counted, so two guardians cannot take its last places for different
 * children. Somebody already enrolled is refused, by who they are: the
 * customer by their number taking part themself, a participant by their id
 * (two children on one parent's number are two people).
 */
async function enrolPeopleOnce(input: {
  classId: number;
  name: string;
  phone: string;
  email?: string;
  userId?: number;
  waitlistId?: number;
  /** Who takes each place: `null` the customer themself, or a participant. */
  people: ({ id: number; name: string } | null)[];
  addedBy?: { userId?: number | null; adminId?: number | null };
}): Promise<EnrolPeopleResult> {
  if (input.people.length === 0) return refuse("PLAYERS_RANGE", { max: 1 });
  return withTransaction(async () => {
    await getDb().prepare("SELECT id FROM classes WHERE id = ? FOR UPDATE").get(input.classId);
    const session = await getClass(input.classId);
    if (!session) return refuse("CLASS_NOT_FOUND");
    if (session.status === "cancelled") return refuse("CLASS_CANCELLED");
    if (minutesUntil(session.date, session.startMin, (await venueHours(session.venueId)).zone) <= 0)
      return refuse("CLASS_STARTED");
    // Every place asked for, or none: never some of a family and not the rest.
    if (session.enrolled + (await classOfferHolds(session.id, input.waitlistId)) + input.people.length > session.capacity)
      return refuse("CLASS_FULL");
    // The day may have been closed after the class was put in the diary.
    if (await getVenueClosure(session.venueId, session.date))
      return refuse("VENUE_CLOSED");

    for (const person of input.people) {
      const already = person
        ? await getDb()
            .prepare(`SELECT b.id FROM bookings b WHERE b.class_id = ? AND b.status = 'confirmed' AND ${PARTICIPANT_TAKES_PART("b")}`)
            .get(session.id, person.id)
        : await getDb()
            .prepare(`SELECT b.id FROM bookings b WHERE b.class_id = ? AND b.phone_key = phone_key(?) AND b.status = 'confirmed' AND ${CUSTOMER_TAKES_PART("b")}`)
            .get(session.id, input.phone.trim());
      if (already) return refuse("ALREADY_ENROLLED");
    }

    const bookings: Booking[] = [];
    for (const person of input.people) {
      const result = await createBookingSeries({
        courtId: session.courtId,
        date: session.date,
        start: session.startMin,
        end: session.endMin,
        weeks: 1,
        name: input.name,
        phone: input.phone,
        email: input.email,
        userId: input.userId,
        classId: session.id,
        ...(person ? { participants: [person], addedBy: input.addedBy ?? { userId: input.userId ?? null } } : {}),
      });
      // One place not had takes the others back with it (the transaction).
      // Its code and values ride along, so a refusal (a member's place, say) is said in the reader's language.
      if (!result.ok) throw new EnrolRefused({ ok: false, error: result.error, ...("code" in result && result.code ? { code: result.code } : {}), ...("vars" in result && result.vars ? { vars: result.vars } : {}) });

      // Price the enrolment at the class rate, not the court's.
      await getDb()
        .prepare("UPDATE bookings SET total_price = ?, fee_amount = 0 WHERE id = ?")
        .run(session.price, result.bookings[0].id);
      bookings.push({ ...result.bookings[0], totalPrice: session.price, feeAmount: 0 });
    }
    return { ok: true as const, bookings };
  }).catch((err: unknown) => {
    if (err instanceof EnrolRefused) return err.result;
    throw err;
  });
}

class EnrolRefused extends Error {
  constructor(readonly result: Refusal) {
    super("ENROL_REFUSED");
  }
}

export interface TermInfo {
  /** Sessions from this one on that still have a place. */
  sessions: ClassSession[];
  /** What they come to, the term's share off taken. */
  total: number;
  offPercent: number;
}

/** Every session left in a weekly class from this one, for joining the term at once. */
export async function classTerm(classId: number): Promise<TermInfo | null> {
  const session = await getClass(classId);
  if (!session?.seriesCode) return null;
  const zone = (await venueHours(session.venueId)).zone;
  const rows = (await getDb()
    .prepare(`${CLASS_SELECT} WHERE cl.series_code = ? AND cl.status = 'scheduled' AND cl.date >= ? ORDER BY cl.date`)
    .all(session.seriesCode, session.date)) as ClassRow[];
  const sessions = rows.map(toClass).filter((c) => c.enrolled < c.capacity && minutesUntil(c.date, c.startMin, zone) > 0);
  if (sessions.length < 2) return null;
  const offPercent = session.termOffPercent ?? 0;
  const total = roundMoney(sessions.reduce((sum, c) => sum + roundMoney((c.price * (100 - offPercent)) / 100), 0));
  return { sessions, total, offPercent };
}

export type TermResult =
  | { ok: true; bookings: Booking[]; skipped: SeriesSkip[]; seriesCode: string }
  | Refusal;

/**
 * Join a weekly class for every session left, from this one: one enrolment
 * each, as `enrolInClass` makes them, sharing a series code so they are
 * confirmed and paid as one, at the term's share off. A session that has
 * filled, or that this number is in already, is skipped and said.
 */
export async function enrolInTerm(input: {
  classId: number;
  name: string;
  phone: string;
  email?: string;
  userId?: number;
  /** Who takes each place in every session (`enrolPeople`): the customer alone unless said. */
  people?: ({ id: number; name: string } | null)[];
  addedBy?: { userId?: number | null; adminId?: number | null };
}): Promise<TermResult> {
  const term = await classTerm(input.classId);
  if (!term) return refuse("CLASS_NO_TERM");
  const bookings: Booking[] = [];
  const skipped: SeriesSkip[] = [];
  const { people, ...who } = input;
  for (const session of term.sessions) {
    // Everybody named in each session, or that session is skipped and said: never some of them.
    const made = await enrolPeople({ ...who, classId: session.id, people: people ?? [null] });
    if (!made.ok) {
      skipped.push({ date: session.date, reason: made.error });
      continue;
    }
    bookings.push(...made.bookings);
  }
  if (bookings.length === 0) return { ok: false, error: skipped[0]?.reason ?? "No session left to join.", code: "CLASS_FULL" } as Refusal;
  const seriesCode = generateSeriesCode();
  const db = getDb();
  for (const b of bookings) {
    const price = roundMoney((b.totalPrice * (100 - term.offPercent)) / 100);
    await db.prepare("UPDATE bookings SET series_code = ?, total_price = ? WHERE id = ?").run(seriesCode, price, b.id);
    b.seriesCode = seriesCode;
    b.totalPrice = price;
  }
  return { ok: true, bookings, skipped, seriesCode };
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

  let released = 0;
  await db.transaction(async () => {
    released = 0;
    await db.prepare("UPDATE classes SET status = 'cancelled' WHERE id = ?").run(classId);
    // The court is free again for that time.
    await release({ kind: "class", classId });
    for (const row of enrolments) {
      // Only an enrolment still standing: one its customer cancelled a moment ago was refunded then.
      const done = await db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ? AND status = 'confirmed'").run(row.id);
      if (done.changes !== 1) continue;
      await releaseBooking(row.id);
      await refundBooking(row.id);
      released++;
    }
  })();
  return { ok: true, released };
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
  reason_phrase?: string | null;
  booking_id: number | null;
  created_at: string;
  venue_id?: number | null;
  venue_name?: string | null;
}

const WALLET_SELECT = `
  SELECT w.id, w.amount, w.reason, w.reason_phrase, w.booking_id, w.created_at, w.venue_id, v.name AS venue_name
  FROM wallet_entries w LEFT JOIN venues v ON v.id = w.venue_id
`;

function toWalletEntry(r: WalletRow): WalletEntry {
  const phrase = readStaffText(r.reason_phrase);
  return {
    id: r.id,
    amount: r.amount,
    reason: r.reason,
    ...(phrase ? { reasonPhrase: phrase } : {}),
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
export async function listWalletEntries(userId: number, limit = 50, venueId?: number): Promise<WalletEntry[]> {
  // A venue's counter sees that venue's credit, not what the customer has been doing elsewhere.
  const rows = (venueId === undefined
    ? await getDb()
        .prepare(`${WALLET_SELECT} WHERE w.user_id = ? ORDER BY w.id DESC LIMIT ?`)
        .all(userId, Math.min(Math.max(limit, 1), 200))
    : await getDb()
        .prepare(`${WALLET_SELECT} WHERE w.user_id = ? AND w.venue_id = ? ORDER BY w.id DESC LIMIT ?`)
        .all(userId, venueId, Math.min(Math.max(limit, 1), 200))) as WalletRow[];
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
    if (!isAmount(input.amount, 1, MAX_TOP_UP))
      return { ok: false, error: `Top-up must be ${money(1)}–${MAX_TOP_UP}.` };
    const db = getDb();
    const user = await db.prepare("SELECT id FROM users WHERE id = ?").get(input.userId);
    if (!user) return { ok: false, error: "Customer not found." };
    const perVenue = creditScope() === "venue";
    if (perVenue && (input.venueId === undefined || !await getVenue(input.venueId)))
      return { ok: false, error: "Credit belongs to a venue here: say which one sold it." };

    const info = await db
      .prepare(
        "INSERT INTO wallet_entries (user_id, amount, reason, reason_phrase, admin_id, venue_id) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(
        input.userId,
        input.amount,
        // What staff typed stays as typed.
        ...(input.reason?.trim() ? [input.reason.trim(), null] : withPhrase(said("srv.wallet.counterTopUp"))),
        input.adminId,
        perVenue ? input.venueId! : null
      );
    const venueId = input.venueId ?? null;
    await issueReceipt({
      source: `wallet:${info.lastInsertRowid}`,
      venueId: perVenue ? input.venueId! : venueId,
      userId: input.userId,
      name: ((await db.prepare("SELECT name FROM users WHERE id = ?").get(input.userId)) as { name: string }).name,
      // What staff typed stays as typed, inside the line's words.
      lines: [saidLine(said("srv.line.credit", { what: input.reason?.trim() || said("srv.line.counterTopUp") }), input.amount)],
      paidVia: "At the counter",
      // Credit is taxed when it is spent, on what it buys.
      taxable: false,
      note: venueId !== null && (await venueTax(venueId)).registered ? "receipt.creditNoTax" : null,
    });
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
export async function claimPayment(bookingId: number, via: "pass" | "credit"): Promise<boolean> {
  return (
    (await getDb()
      .prepare(
        "UPDATE bookings SET payment_status = 'paid', paid_at = datetime('now'), paid_via = ? WHERE id = ? AND payment_status = 'unpaid'"
      )
      .run(via, bookingId)).changes === 1
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
        "INSERT INTO wallet_entries (user_id, amount, reason, reason_phrase, booking_id, venue_id) VALUES (?, ?, ?, ?, ?, ?)"
      );
      const reason = withPhrase(said("srv.wallet.booking", { code: booking.code }));
      let first: number | bigint | null = null;
      if (venueId === undefined) {
        first = (await charge.run(userId, -price, ...reason, booking.id, null)).lastInsertRowid;
      } else {
        const fromVenue = Math.min(Math.max(await potBalance(userId, venueId), 0), price);
        if (fromVenue > 0)
          first = (await charge.run(userId, -fromVenue, ...reason, booking.id, venueId)).lastInsertRowid;
        if (price - fromVenue > 0) {
          const id = (await charge.run(userId, -(price - fromVenue), ...reason, booking.id, null)).lastInsertRowid;
          first ??= id;
        }
      }
      if (!await claimPayment(booking.id, "credit")) throw new Error("RACED");
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
export async function refundBookingToWallet(bookingId: number, share = 1): Promise<WalletResult> {
  const charges = await walletChargesFor(bookingId);
  if (charges.length === 0) return { ok: false, error: "This booking was not paid from credit." };

  const db = getDb();
  // Credit given back for a place taken off it (lib/place-withdrawals.ts) is not the booking's own refund.
  const refunded = await db
    .prepare("SELECT id FROM wallet_entries WHERE booking_id = ? AND amount > 0 AND withdrawal_id IS NULL")
    .get(bookingId);
  if (refunded) return { ok: false, error: "This booking has already been refunded." };

  const code = (await db.prepare("SELECT code FROM bookings WHERE id = ?").get(bookingId) as
    | { code: string }
    | undefined)?.code;
  const put = db.prepare(
    "INSERT INTO wallet_entries (user_id, amount, reason, reason_phrase, booking_id, venue_id) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const reason = withPhrase(code ? said("srv.wallet.refund", { code }) : said("srv.wallet.refundBooking"));
  const ids = await db.transaction(async () => {
    const made: number[] = [];
    for (const c of charges) {
      const back = roundMoney(-c.amount * share);
      if (back <= 0) continue;
      made.push(
        (await put.run(c.user_id, back, ...reason, bookingId, c.venue_id)).lastInsertRowid as number
      );
    }
    return made;
  })();
  // A late cancellation where the venue keeps it all: nothing goes back.
  if (ids.length === 0) return { ok: false, error: "Nothing to give back." };

  const venueId = charges.find((c) => c.venue_id !== null)?.venue_id ?? undefined;
  return {
    ok: true,
    balance: await getWalletBalance(charges[0].user_id, venueId),
    entry: await walletEntryById(ids[0]),
  };
}

/**
 * Give back what a cancelled booking was paid, by whichever way it was paid
 * (credit, a pass or online: one at most, so the others are no-ops): all of
 * it (`share` 1), or what is left after a venue keeps its fee for a late
 * cancellation.
 */
/** What follows a booking being cancelled however it was, for callers outside this module (a hold let go). */
export async function settleCancelled(bookingId: number): Promise<void> {
  await refundBooking(bookingId);
}

/** Is a payment page for this booking still open, unpaid, within the day a page lasts? */
export async function paymentPageOpen(bookingId: number): Promise<boolean> {
  return !!(await getDb()
    .prepare(
      `SELECT 1 FROM online_payments p JOIN online_payment_bookings pb ON pb.payment_id = p.id
        WHERE pb.booking_id = ? AND p.status = 'pending' AND p.purpose = 'booking'
          AND p.created_at > datetime('now', '-24 hours')`
    )
    .get(bookingId));
}

/**
 * The part of a paid booking's price still on it: all of it, less places taken
 * off while it was paid (lib/place-withdrawals.ts), whose money was settled
 * then. What a cancellation gives back is of this part only.
 */
export async function paidPartLeft(bookingId: number): Promise<number> {
  const row = (await getDb()
    .prepare(
      `SELECT (b.total_price - b.shares_paid)::float AS base,
              (SELECT COALESCE(SUM(w.price), 0) FROM place_withdrawals w WHERE w.booking_id = b.id AND w.paid)::float AS gone
         FROM bookings b WHERE b.id = ?`
    )
    .get(bookingId)) as { base: number; gone: number } | undefined;
  if (!row || Number(row.gone) <= 0 || Number(row.base) <= 0) return 1;
  return Math.max(0, (Number(row.base) - Number(row.gone)) / Number(row.base));
}

async function refundBooking(bookingId: number, share = 1): Promise<void> {
  // Places already taken off it while paid were settled then: only what is left goes back now.
  const left = await paidPartLeft(bookingId);
  // A paid booking's receipt is reversed, whoever gives the money back and how.
  await creditBooking(bookingId, share < 1 ? "receipt.why.lateCancelled" : "receipt.why.cancelled", share, left);
  await refundBookingToWallet(bookingId, share * left);
  // A pass's spends are each given back once: a place taken off already settled its own.
  await refundBookingToPass(bookingId, share);
  await noteOnlineRefundDue(bookingId, share * left);
  // The customer never had the benefit, so a limited code is not poorer for it.
  await releasePromoUse(bookingId);
  // An open game on it goes too, and its players' shares are owed back.
  // Imported here, not at the top: lib/games.ts reads from this module.
  const { bookingCancelled } = await import("./games");
  await bookingCancelled(bookingId);
  // Friends who paid a share of it are owed it back.
  const { splitCancelled } = await import("./splits");
  await splitCancelled(bookingId, share);
}

/**
 * A booking paid online and then cancelled has money sitting in the venue's
 * gateway account that is not the venue's to keep. Nothing here can send it
 * back — a refund is made in the gateway — so the amount is written against
 * the payment, and the venue is shown what it owes until staff say it is done.
 */
async function noteOnlineRefundDue(bookingId: number, share = 1): Promise<void> {
  // What the payment took for this booking, where it says; never more than it took in all.
  await getDb()
    .prepare(`
      UPDATE online_payments p
         SET refund_due = LEAST(p.amount, p.refund_due + ROUND(COALESCE(
               (SELECT pb.amount FROM online_payment_bookings pb WHERE pb.payment_id = p.id AND pb.booking_id = ?),
               (SELECT total_price - shares_paid FROM bookings WHERE id = ?)) * ${Number(share)}, 2))
       WHERE p.status = 'paid'
         AND p.id IN (SELECT payment_id FROM online_payment_bookings WHERE booking_id = ?)
         -- Paid for online, or a deposit or other part paid on it (the rest was never paid online).
         AND (p.deposit = 1 OR EXISTS (SELECT 1 FROM bookings WHERE id = ? AND paid_via = 'online')
              OR EXISTS (SELECT 1 FROM receipts r WHERE r.source IN ('booking-part:' || ? || ':' || p.id, 'booking-paid:' || ? || ':' || p.id)))
    `)
    .run(bookingId, bookingId, bookingId, bookingId, bookingId, bookingId);
  const why = share < 1 ? "receipt.why.lateCancelled" : "receipt.why.cancelled";
  const code = ((await getDb().prepare("SELECT code FROM bookings WHERE id = ?").get(bookingId)) as { code: string } | undefined)?.code ?? String(bookingId);
  // A deposit's own receipt is credited for what goes back: this booking's part
  // of it, since one deposit can hold several bookings (a weekly series).
  const deposits = (await getDb()
    .prepare(
      `SELECT p.id, pb.amount::float AS amount FROM online_payments p JOIN online_payment_bookings pb ON pb.payment_id = p.id
        WHERE pb.booking_id = ? AND p.deposit = 1 AND p.status = 'paid'`
    )
    .all(bookingId)) as { id: number; amount: number | null }[];
  for (const d of deposits)
    await creditReceipt(`payment:${d.id}`, why, share, d.amount === null ? undefined : { key: code, amount: Number(d.amount) });
  // So is a part paid online before a share it counted on was handed back (lib/games.ts, unpayShare),
  // or the part a chargeback left (lib/payments.ts, disputeLost): each is this booking's alone.
  const parts = (await getDb()
    .prepare("SELECT source, total::float AS total FROM receipts WHERE kind = 'receipt' AND (source LIKE ? OR source LIKE ?)")
    .all(`booking-part:${bookingId}:%`, `booking-paid:${bookingId}:%`)) as { source: string; total: number }[];
  for (const p of parts) await creditReceipt(p.source, why, share, { key: code, amount: Number(p.total) });
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
  plan_id: number | null;
  tier_id?: number | null;
  tier_name?: string | null;
  tier_rate?: number | null;
  tier_ahead?: number | null;
  tier_scope?: BenefitScope | null;
  holder_kind?: "customer" | "participant";
  holder_participant_id?: number | null;
  holder_participant_name?: string | null;
  covers?: { id: number; name: string }[] | string | null;
}

const MEMBERSHIP_SELECT = `
  SELECT m.id, m.code, m.venue_id, v.name AS venue_name, m.holder_name, m.holder_phone,
         m.starts_on, m.expires_on, m.price, m.status, m.plan_id,
         m.tier_id, t.name AS tier_name, t.rate_percent AS tier_rate, t.ahead_days AS tier_ahead, t.scope AS tier_scope,
         m.holder_kind, m.holder_participant_id, hp.display_name AS holder_participant_name,
         (SELECT json_agg(json_build_object('id', cp.id, 'name', cp.display_name) ORDER BY cp.id)
            FROM membership_participants mp JOIN participants cp ON cp.id = mp.participant_id WHERE mp.membership_id = m.id) AS covers
  FROM memberships m JOIN venues v ON v.id = m.venue_id
  LEFT JOIN membership_plans t ON t.id = m.tier_id
  LEFT JOIN participants hp ON hp.id = m.holder_participant_id
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
    online: r.plan_id !== null,
    tierId: r.tier_id ?? null,
    tierName: r.tier_name ?? null,
    ratePercent: r.tier_rate ?? null,
    aheadDays: r.tier_ahead ?? null,
    scope: r.tier_scope ?? "booking",
    // A participant's membership whose participant has gone covers nobody: -1, never the number's holder.
    holderParticipantId: r.holder_kind === "participant" ? (r.holder_participant_id ?? -1) : null,
    holderParticipantName: r.holder_kind === "participant" ? (r.holder_participant_name ?? null) : null,
    covers: (typeof r.covers === "string" ? (JSON.parse(r.covers) as { id: number; name: string }[]) : r.covers) ?? [],
  };
  const reason = membershipBlocked(m);
  return reason ? { ...m, unusableReason: englishOf(reason), unusablePhrase: reason } : m;
}

/** Why a membership is not giving member rates today. */
function membershipBlocked(m: Membership): StaffText | null {
  if (m.status === "void") return said("srv.unusable.membershipCancelled");
  const today = todayISO();
  if (today < m.startsOn) return said("srv.unusable.membershipStarts", { date: m.startsOn });
  if (today > m.expiresOn) return said("srv.unusable.membershipExpired", { date: m.expiresOn });
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
 *
 * The number holder's own only: a participant's own membership sold on their
 * guardian's number is the participant's (`participantMembership`), and never
 * makes the number's holder a member (ADR 0025).
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
    .prepare(
      `${MEMBERSHIP_SELECT} WHERE ${inSameBusiness("m.venue_id")} AND m.status = 'active' AND m.holder_kind = 'customer' AND phone_key(m.holder_phone) = phone_key(?)`
    )
    .all(venueId, phone) as MembershipRow[];
  const match = rows.find(
    (r) =>
      normalisePhone(r.holder_phone) === digits &&
      r.starts_on <= date &&
      r.expires_on >= date
  );
  return match ? toMembership(match) : null;
}

/**
 * The live membership a participant has here on this date (ADR 0025): their
 * own (`holder_participant_id`), or a family membership that names them
 * (`membership_participants`). Never their guardian's own: a parent's
 * membership does not make a child a member unless it names the child.
 */
export async function participantMembership(venueId: number, participantId: number, onDate?: string): Promise<Membership | null> {
  const date = onDate ?? todayISO();
  const row = (await getDb()
    .prepare(
      `${MEMBERSHIP_SELECT} WHERE ${inSameBusiness("m.venue_id")} AND m.status = 'active' AND m.starts_on <= ? AND m.expires_on >= ?
         AND (m.holder_participant_id = ? OR EXISTS (SELECT 1 FROM membership_participants mp WHERE mp.membership_id = m.id AND mp.participant_id = ?))
       ORDER BY COALESCE(m.holder_participant_id = ?, false) DESC, m.id LIMIT 1`
    )
    .get(venueId, date, date, participantId, participantId, participantId)) as MembershipRow | undefined;
  return row ? toMembership(row) : null;
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

/** Sell a membership, at the counter or (with no `adminId`) once paid for online. */
export async function sellMembership(input: {
  venueId: number;
  holderName: string;
  holderPhone: string;
  startsOn: string;
  expiresOn: string;
  price: number;
  /** Absent when it was bought online. */
  adminId?: number;
  userId?: number;
  planId?: number;
  /** The plan whose benefits it carries, sold at the counter (bought online, it is `planId`). */
  tierId?: number;
  /** How it was paid, for its receipt: "Online (Stripe)". At the counter when staff sell it. */
  paidVia?: string;
  /**
   * A participant's own membership, sold on their guardian's number (a child's
   * swim-club membership): the caller checked the venue knows them with a
   * guardian on `holderPhone`. It is theirs alone (ADR 0025).
   */
  holderParticipantId?: number | null;
  /** A family membership: the participants it covers besides its holder, checked by the caller as above. */
  covers?: number[];
}): Promise<MembershipResult> {
  const covers = [...new Set(input.covers ?? [])];
  if (input.holderParticipantId && covers.includes(input.holderParticipantId))
    return { ok: false, error: "The holder is covered by their own membership already." };
  if (covers.length > MAX_MEMBERSHIP_COVERS) return { ok: false, error: `A family membership covers up to ${MAX_MEMBERSHIP_COVERS} people besides its holder.` };
  return withTransaction(async () => {
    const db = getDb();
    if (!await db.prepare("SELECT id FROM venues WHERE id = ?").get(input.venueId))
      return refuse("VENUE_NOT_FOUND");

    const holderName = input.holderName.trim();
    const holderPhone = input.holderPhone.trim();
    if (holderName.length < 2 || holderPhone.length < 6)
      return { ok: false, error: "A holder name and phone number are required." };
    if (!isAmount(input.price))
      return { ok: false, error: `Price must be ${money(0)} or more, to the ${region().currency.minor}.` };
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
    // One holder's: the number's holder's own, or one participant's own.
    const participantHolder = input.holderParticipantId ?? null;
    const clash = (
      await db
        .prepare(`${MEMBERSHIP_SELECT} WHERE ${inSameBusiness("m.venue_id")} AND m.status = 'active'`)
        .all(input.venueId) as MembershipRow[]
    ).find(
      (r) =>
        (participantHolder === null
          ? (r.holder_kind ?? "customer") === "customer" && normalisePhone(r.holder_phone) === normalisePhone(holderPhone)
          : r.holder_participant_id === participantHolder) &&
        r.starts_on <= input.expiresOn &&
        r.expires_on >= input.startsOn
    );
    if (clash)
      return {
        ok: false,
        error: participantHolder !== null
          ? `${clash.holder_participant_name ?? "That person"} already has a membership until ${clash.expires_on}.`
          : clash.venue_id === input.venueId
            ? `That number already has a membership here until ${clash.expires_on}.`
            : `That number already has a membership at ${clash.venue_name}, which covers this venue too, until ${clash.expires_on}.`,
      };

    const info = await db
      .prepare(`
        INSERT INTO memberships (code, venue_id, holder_name, holder_phone, user_id,
                                 starts_on, expires_on, price, admin_id, plan_id, tier_id, holder_kind, holder_participant_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        randomCode("MB-"), input.venueId, holderName, holderPhone, input.userId ?? null,
        input.startsOn, input.expiresOn, input.price, input.adminId ?? null, input.planId ?? null,
        input.tierId ?? input.planId ?? null,
        participantHolder === null ? "customer" : "participant", participantHolder
      );
    // The dependants a family membership covers, named as it is sold.
    for (const participantId of covers)
      await db
        .prepare("INSERT INTO membership_participants (membership_id, participant_id, added_by_admin_id) VALUES (?, ?, ?)")
        .run(info.lastInsertRowid, participantId, input.adminId ?? null);
    const membership = (await membershipById(Number(info.lastInsertRowid)))!;
    await issueReceipt({
      source: `membership:${membership.id}`,
      venueId: input.venueId,
      userId: input.userId ?? null,
      name: holderName,
      phone: holderPhone,
      lines: [saidLine(said("srv.line.membership", { code: membership.code, from: input.startsOn, to: input.expiresOn }), input.price)],
      paidVia: input.paidVia ?? "At the counter",
      taxable: true,
    });
    return { ok: true, membership };
  });
}

/** Cancel a membership. Bookings already made keep the price they were given. */
export async function voidMembership(id: number): Promise<MembershipResult> {
  return withTransaction(async () => {
    const m = await membershipById(id);
    if (!m) return { ok: false, error: "Membership not found." };
    if (m.status === "void") return { ok: false, error: "This membership is already cancelled." };
    await getDb().prepare("UPDATE memberships SET status = 'void' WHERE id = ?").run(id);
    await creditReceipt(`membership:${id}`, "receipt.why.voided");
    return { ok: true, membership: (await membershipById(id))! };
  });
}

/** The most days a membership can be given back at once. */
export const MAX_MEMBERSHIP_EXTENSION_DAYS = 90;

/**
 * Days given back on a membership: somebody injured, away, or shut out by a
 * long closure. Its end moves later; nothing is charged. Staff do it, and it
 * is logged; a membership already over cannot be brought back this way.
 */
export async function extendMembership(id: number, days: number): Promise<MembershipResult> {
  if (!Number.isInteger(days) || days < 1 || days > MAX_MEMBERSHIP_EXTENSION_DAYS)
    return { ok: false, error: `Give back 1 to ${MAX_MEMBERSHIP_EXTENSION_DAYS} days.` };
  return withTransaction(async () => {
    const m = await membershipById(id);
    if (!m) return { ok: false, error: "Membership not found." };
    if (m.status === "void") return { ok: false, error: "This membership is cancelled." };
    if (m.expiresOn < todayISO()) return { ok: false, error: "This membership has already ended. Sell a new one instead." };
    await getDb().prepare("UPDATE memberships SET expires_on = ? WHERE id = ?").run(addDays(m.expiresOn, days), id);
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
  max_per_customer: number | null;
  status: PromoStatus;
  used: number;
}

const PROMO_SELECT = `
  SELECT p.id, p.code, p.venue_id, v.name AS venue_name, p.sport, p.description,
         p.kind, p.value, p.min_hours, p.valid_from, p.valid_to, p.max_uses, p.max_per_customer, p.status,
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
    maxPerCustomer: r.max_per_customer,
    used: r.used,
    status: r.status,
  };
  const reason = promoBlocked(promo);
  return reason ? { ...promo, unusableReason: englishOf(reason), unusablePhrase: reason } : promo;
}

/** Why a code is dead regardless of which booking it is put against. */
function promoBlocked(p: PromoCode): StaffText | null {
  if (p.status === "void") return said("srv.unusable.codeWithdrawn");
  if (p.maxUses !== null && p.used >= p.maxUses) return said("srv.unusable.codeClaimed");
  if (p.validTo < todayISO()) return said("srv.unusable.codeRanOut", { date: p.validTo });
  return null;
}

const promoBlockedReason = (p: PromoCode): string | null => {
  const reason = promoBlocked(p);
  return reason && englishOf(reason);
};

/** What a code takes off a price. Never more than the price itself. */
function promoDiscount(p: Pick<PromoCode, "kind" | "value">, price: number): number {
  // A percentage comes off to the sen or cent, rounded in the venue's favour.
  const scale = 10 ** region().currency.minorUnits;
  const off = p.kind === "percent" ? Math.floor(roundMoney((price * p.value) / 100) * scale + 1e-6) / scale : p.value;
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
  maxPerCustomer?: number | null;
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
      return { ok: false, error: `A fixed discount cannot exceed ${money(MAX_PROMO_AMOUNT)}.` };

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
    if (input.maxPerCustomer !== undefined && input.maxPerCustomer !== null &&
        (!Number.isInteger(input.maxPerCustomer) || input.maxPerCustomer < 1))
      return { ok: false, error: "A limit per customer must be a whole number above zero." };
    if (input.sport && !(await isActivity(input.sport)))
      return refuse("UNKNOWN_SPORT");
    if (input.sport) {
      const has = await db
        .prepare(`SELECT 1 FROM courts c WHERE c.venue_id = ? AND ${offersSql()} LIMIT 1`)
        .get(input.venueId, input.sport);
      if (!has) return { ok: false, error: "That venue has no courts for that sport." };
    }
    if (await getPromoCode(input.venueId, code))
      return { ok: false, error: `${code} already exists at this venue.` };

    const info = await db
      .prepare(`
        INSERT INTO promo_codes (code, venue_id, sport, description, kind, value,
                                 min_hours, valid_from, valid_to, max_uses, max_per_customer, admin_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        code, input.venueId, input.sport ?? null, input.description.trim(), input.kind,
        input.value, minHours, input.validFrom, input.validTo, input.maxUses ?? null, input.maxPerCustomer ?? null, input.adminId
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
    return { ok: false, error: `This code only covers ${activityName(promo.sport)}.` };
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
  // One discount at a time: a last-minute price is already one.
  if ((row as BookingRow & { last_minute?: number }).last_minute === 1) return refuse("PROMO_NOT_LAST_MINUTE");
  // Nor on a concession price.
  if (row.concession_name) return refuse("ONE_DISCOUNT");

  const court = await getCourt(booking.courtId);
  if (!court) return refuse("COURT_NOT_FOUND");

  const quote = await quotePromo({
    venueId: court.venueId,
    code,
    sport: booking.sport,
    date: booking.date,
    hours: booking.endHour - booking.startHour,
    // A code is for the court time: a coach's fee is theirs, and setup and
    // cleanup fees are not time, as with concessions.
    price: booking.totalPrice - (booking.coachFee ?? 0) - (booking.feeAmount ?? 0),
  });
  if (!quote.ok) return quote;

  try {
    await db.transaction(async () => {
      const fresh = (await promoById(quote.promo.id))!;
      const blocked = promoBlockedReason(fresh);
      if (blocked) throw new Error(`BLOCKED:${blocked}`);
      // Re-derive against the live price, not the quoted one.
      const discount = promoDiscount(fresh, booking.totalPrice - (booking.coachFee ?? 0) - (booking.feeAmount ?? 0));
      if (discount <= 0) throw new Error("BLOCKED:This code takes nothing off that price.");
      // One customer cannot take a code's every use: counted by phone, however it is typed.
      if (fresh.maxPerCustomer !== null) {
        const mine = (await db
          .prepare(
            `SELECT COUNT(*) AS n FROM promo_uses u JOIN bookings b ON b.id = u.booking_id
              WHERE u.promo_id = ? AND b.phone_key = phone_key(?) AND b.status = 'confirmed'`
          )
          .get(fresh.id, booking.phone)) as { n: number | string };
        if (Number(mine.n) >= fresh.maxPerCustomer) throw new Error("LIMIT");
      }
      await db.prepare(
        "INSERT INTO promo_uses (promo_id, booking_id, discount) VALUES (?, ?, ?)"
      ).run(fresh.id, booking.id, discount);
      await db.prepare("UPDATE bookings SET total_price = total_price - ? WHERE id = ?")
        .run(discount, booking.id);
    })();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("BLOCKED:"))
      return { ok: false, error: err.message.slice("BLOCKED:".length) };
    if (err instanceof Error && err.message === "LIMIT") return refuse("PROMO_YOUR_LIMIT");
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
  kind: PassKind;
  entry_minutes: number | null;
  max_minutes: number | null;
  entries: number;
  price: number;
  holder_name: string;
  holder_phone: string;
  expires_on: string;
  status: PassStatus;
  created_at: string;
  spent: number | null;
  coach_id: number | null;
  coach_name: string | null;
  scope: BenefitScope;
  holder_kind: "customer" | "participant";
  holder_participant_id: number | null;
  holder_participant_name: string | null;
}

const PASS_SELECT = `
  SELECT p.id, p.code, p.venue_id, v.name AS venue_name, p.sport, p.name,
         p.kind, p.entry_minutes, p.max_minutes, p.entries, p.price, p.holder_name, p.holder_phone, p.expires_on,
         p.status, p.created_at, p.coach_id, k.name AS coach_name,
         p.scope, p.holder_kind, p.holder_participant_id, hp.display_name AS holder_participant_name,
         (SELECT COALESCE(SUM(delta), 0) FROM pass_entries e WHERE e.pass_id = p.id) AS spent
  FROM passes p JOIN venues v ON v.id = p.venue_id LEFT JOIN coaches k ON k.id = p.coach_id
  LEFT JOIN participants hp ON hp.id = p.holder_participant_id
`;

function toPass(r: PassRow): Pass {
  const remaining = r.entries + (r.spent ?? 0);
  const pass: Pass = {
    id: r.id,
    code: r.code,
    venueId: r.venue_id,
    venueName: r.venue_name,
    sport: r.sport,
    coachId: r.coach_id,
    coachName: r.coach_name,
    name: r.name,
    kind: r.kind,
    entryMinutes: r.entry_minutes,
    maxMinutes: r.max_minutes,
    entries: r.entries,
    remaining,
    price: r.price,
    holderName: r.holder_name,
    holderPhone: r.holder_phone,
    scope: r.scope ?? "booking",
    // A participant's pass whose participant has gone covers nobody: -1, never the holder.
    holderParticipantId: r.holder_kind === "participant" ? (r.holder_participant_id ?? -1) : null,
    holderParticipantName: r.holder_kind === "participant" ? r.holder_participant_name : null,
    expiresOn: r.expires_on,
    status: r.status,
    createdAt: r.created_at,
  };
  const reason = passBlocked(pass);
  return reason ? { ...pass, unusableReason: englishOf(reason), unusablePhrase: reason } : pass;
}

/** Why a pass cannot be spent today, or null when it can. */
function passBlocked(pass: Pick<Pass, "status" | "expiresOn" | "remaining" | "kind">): StaffText | null {
  if (pass.status === "void") return said("srv.unusable.passCancelled");
  // expires_on is inclusive, so a pass is good for the whole of that day.
  if (pass.expiresOn < todayISO()) return said("srv.unusable.passExpired", { date: pass.expiresOn });
  if (pass.remaining <= 0) return said(pass.kind === "time" ? "srv.unusable.passNoTime" : "srv.unusable.passNoEntries");
  return null;
}

const passBlockedReason = (pass: Pick<Pass, "status" | "expiresOn" | "remaining" | "kind">): string | null => {
  const reason = passBlocked(pass);
  return reason && englishOf(reason);
};

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
  /** Session (entries) or time (minutes of court time); session if not said. */
  kind?: PassKind;
  /** Entries sold on a session pass; minutes of court time on a time pass. */
  entries: number;
  /**
   * A session pass's entry: the minutes one covers (a booking spends one per
   * so many minutes or part), or null for one a booking. 60 if not said.
   */
  entryMinutes?: number | null;
  /** The longest booking the pass may pay for, in minutes; null: any. */
  maxMinutes?: number | null;
  price: number;
  holderName: string;
  holderPhone: string;
  expiresOn: string;
  /** null: given by the system itself, a loyalty reward (lib/loyalty.ts). */
  adminId: number | null;
  userId?: number;
  /** A pack of lessons with this coach. */
  coachId?: number | null;
  /** What one use covers (lib/entitlements.ts); the booking as a whole if not said. */
  scope?: BenefitScope;
  /**
   * A pass for one person's place held for a participant the holder acts for
   * (a child's swim pass, bought by the parent): the caller checked the venue
   * knows them with a guardian on the holder's number.
   */
  holderParticipantId?: number | null;
}): Promise<PassResult> {
  const scope = input.scope ?? "booking";
  if (!PASS_SCOPES.includes(scope)) return { ok: false, error: "A pass covers a booking, a resource hired whole, one person's place, or each place." };
  // Only a pass for one person's place is somebody else's to use.
  if (input.holderParticipantId !== undefined && input.holderParticipantId !== null && scope !== "participant")
    return { ok: false, error: "Only a pass for one person's place is held for somebody you act for." };
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
    const kind = input.kind ?? "session";
    if (kind !== "session" && kind !== "time") return { ok: false, error: "A pass spends entries or court time." };
    if (kind === "session" && (!Number.isInteger(input.entries) || input.entries < 1 || input.entries > MAX_PASS_ENTRIES))
      return { ok: false, error: `Entries must be 1–${MAX_PASS_ENTRIES}.` };
    if (kind === "time" && (!Number.isInteger(input.entries) || input.entries < 1 || input.entries > MAX_PASS_MINUTES))
      return { ok: false, error: `Court time must be 1–${MAX_PASS_MINUTES} minutes.` };
    // A time pass spends what was booked, to the minute: no entry to size.
    const entryMinutes = kind === "time" ? null : input.entryMinutes === undefined ? 60 : input.entryMinutes;
    if (entryMinutes !== null && (!Number.isInteger(entryMinutes) || entryMinutes < 1 || entryMinutes > DAY_MINUTES))
      return { ok: false, error: `An entry covers 1–${DAY_MINUTES} minutes, or a whole booking.` };
    const maxMinutes = input.maxMinutes ?? null;
    if (maxMinutes !== null && (!Number.isInteger(maxMinutes) || maxMinutes < 1 || maxMinutes > DAY_MINUTES))
      return { ok: false, error: `The longest booking a pass pays for is 1–${DAY_MINUTES} minutes.` };
    if (!isAmount(input.price))
      return { ok: false, error: `Price must be ${money(0)} or more, to the ${region().currency.minor}.` };
    if (!isValidDateString(input.expiresOn))
      return { ok: false, error: "Invalid expiry date." };
    if (input.expiresOn < todayISO())
      return { ok: false, error: "The expiry date has already passed." };
    if (input.expiresOn > addDays(todayISO(), MAX_PASS_MONTHS * 31))
      return { ok: false, error: `A pass may not run more than ${MAX_PASS_MONTHS} months.` };
    if (input.sport && !(await isActivity(input.sport)))
      return refuse("UNKNOWN_SPORT");
    // A sport-locked pass is pointless if the venue has no such courts.
    if (input.sport) {
      const has = await db
        .prepare(`SELECT 1 FROM courts c WHERE c.venue_id = ? AND ${offersSql()} LIMIT 1`)
        .get(input.venueId, input.sport);
      if (!has) return { ok: false, error: "That venue has no courts for that sport." };
    }
    if (input.coachId !== undefined && input.coachId !== null) {
      const coach = (await db.prepare("SELECT venue_id, active FROM coaches WHERE id = ?").get(input.coachId)) as
        | { venue_id: number; active: number }
        | undefined;
      if (!coach || coach.venue_id !== input.venueId || coach.active !== 1) return { ok: false, error: "That coach does not take lessons here." };
    }

    const info = await db
      .prepare(`
        INSERT INTO passes (code, venue_id, sport, name, kind, entry_minutes, max_minutes, entries, price, holder_name,
                            holder_phone, user_id, expires_on, admin_id, coach_id, scope, holder_kind, holder_participant_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        randomCode("PS-"),
        input.venueId,
        input.sport ?? null,
        name,
        kind,
        entryMinutes,
        maxMinutes,
        input.entries,
        input.price,
        holderName,
        holderPhone,
        input.userId ?? null,
        input.expiresOn,
        input.adminId,
        input.coachId ?? null,
        scope,
        input.holderParticipantId ? "participant" : "customer",
        input.holderParticipantId ?? null
      );
    const pass = (await passById(Number(info.lastInsertRowid)))!;
    await issueReceipt({
      source: `pass:${pass.id}`,
      venueId: input.venueId,
      userId: input.userId ?? null,
      name: holderName,
      phone: holderPhone,
      lines: [saidLine(said("srv.line.pass", { name, code: pass.code, amount: passUnits(pass, input.entries), date: input.expiresOn }), input.price)],
      paidVia: input.price === 0 ? null : "At the counter",
      taxable: true,
    });
    return { ok: true, pass };
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
    await creditReceipt(`pass:${passId}`, "receipt.why.voided");
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
  if (pass.sport && booking.sport !== pass.sport)
    return `That pass only covers ${activityName(pass.sport)}.`;
  // A pack of lessons pays lessons with its coach; a court pass does not pay a coach.
  if (pass.coachId && booking.coachId !== pass.coachId)
    return `That pass is for lessons with ${pass.coachName ?? "one coach"} only.`;
  if (!pass.coachId && booking.coachId)
    return "A court pass does not cover a coach's fee. Use a lesson pack for this coach, or pay another way.";
  return null;
}

export type PassPayResult =
  | { ok: true; pass: Pass; spent: number }
  | Refusal;

/**
 * Settle a booking with a pass, all or nothing: a time pass spends the
 * minutes booked, a session pass its entries (`passCost`). The remaining
 * balance is re-read inside the transaction so two concurrent bookings
 * cannot spend the same entry.
 */
export async function payBookingWithPass(bookingId: number, passCode: string): Promise<PassPayResult> {
  return payBookingWithPasses(bookingId, [passCode]);
}

/**
 * Settle a booking with one pass, or with one person's pass for each place
 * (ADR 0025): all or nothing, never part-paid.
 *
 * What a pass spends follows its scope (lib/entitlements.ts): a `booking` or
 * `resource` pass spends `passCost` once for the booking as a whole (a
 * `resource` pass only on a resource hired whole); a `places` pass spends it
 * for each place the booking takes, one ledger line a place; a `participant`
 * pass pays one person's place, its holder's, so a booking is paid by such
 * passes only when every place on it is covered by its own person's pass.
 * Each line names the place it was spent for, so taking that place off the
 * booking gives back exactly that. The balances are re-read inside the
 * transaction, the booking is claimed paid once, and the database refuses a
 * second spend for one place: concurrent requests, the counter and the
 * customer cannot spend the same entry or pay the same place twice.
 */
export async function payBookingWithPasses(
  bookingId: number,
  passCodes: string[],
  /** Courts of a group, each with its own people: a person's pass pays where they are and is passed over elsewhere. */
  opts: { skipAbsent?: boolean } = {}
): Promise<PassPayResult> {
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

  // A pass is for court time; rackets and drinks on the booking are paid another way.
  if (await hasAddons(booking.id)) return refuse("PASS_NOT_FOR_EXTRAS");

  const codes = [...new Set(passCodes.map((c) => c.trim().toUpperCase()).filter((c) => c !== ""))];
  if (codes.length === 0) return refuse("PASS_NOT_FOUND");
  const passes: Pass[] = [];
  for (const code of codes) {
    const pass = await getPass(code);
    if (!pass) return refuse("PASS_NOT_FOUND");
    const scope = await passScopeError(pass, booking);
    if (scope) return { ok: false, error: scope };
    // A pass is the holder's to spend, so it has to be their booking.
    if (normalisePhone(pass.holderPhone) !== normalisePhone(booking.phone)) return refuse("PASS_WRONG_PHONE");
    passes.push(pass);
  }
  const court = await getCourt(booking.courtId);
  if (!court) return refuse("COURT_NOT_FOUND");
  const minutes = booking.endMin - booking.startMin;

  // What each pass spends, and for which place (null: the booking as a whole, or a place nobody is named on).
  const spends: { pass: Pass; placeId: number | null; units: number }[] = [];
  const costOf = (pass: Pass): number | Refusal => {
    const cost = passCost(pass, minutes);
    return cost.ok ? cost.units : { ok: false, error: `That pass pays for bookings up to ${formatLength(cost.maxMinutes)}.` };
  };
  const oneEach = passes.every((p) => p.scope === "participant");
  if (passes.length > 1 && !oneEach) return refuseEnt("ENT_PASS_MIX");
  if (!oneEach) {
    const pass = passes[0];
    // A package of a resource's hours pays for the resource hired whole, not for places sold one by one.
    if (pass.scope === "resource" && soldByPlace(court)) return refuseEnt("ENT_PASS_RESOURCE");
    const units = costOf(pass);
    if (typeof units !== "number") return units;
    if (pass.scope === "places") {
      const named = (await placeRows(booking.id)).filter((p) => p.placeId !== null);
      for (const place of named) spends.push({ pass, placeId: place.placeId, units });
      for (let i = named.length; i < Math.max(1, booking.players ?? 1); i++) spends.push({ pass, placeId: null, units });
    } else spends.push({ pass, placeId: null, units });
  } else {
    // Each a person's own: every place on the booking covered by its own person's pass, once.
    const places = await placeRows(booking.id);
    if ((booking.players ?? 1) > places.length) return refuseEnt("ENT_PASS_UNNAMED");
    const covered = new Set<number>();
    for (const pass of passes) {
      const place = places.find((p) => (pass.holderParticipantId ? p.participantId === pass.holderParticipantId : p.customer));
      if (!place && opts.skipAbsent) continue;
      if (!place) return refuseEnt("ENT_PASS_NOT_ON_BOOKING", { name: pass.holderParticipantName ?? pass.holderName });
      if (covered.has(place.placeId ?? 0)) return refuseEnt("ENT_PASS_TWICE", { name: place.name ?? pass.holderName });
      covered.add(place.placeId ?? 0);
      const units = costOf(pass);
      if (typeof units !== "number") return units;
      spends.push({ pass, placeId: place.placeId, units });
    }
    const uncovered = places.filter((p) => !covered.has(p.placeId ?? 0));
    if (uncovered.length > 0)
      return refuseEnt("ENT_PASS_UNCOVERED", { names: uncovered.map((p) => (p.customer ? booking.name : p.name ?? "?")).join(", ") });
  }

  try {
    await db.transaction(async () => {
      const needed = new Map<number, number>();
      for (const s of spends) needed.set(s.pass.id, (needed.get(s.pass.id) ?? 0) + s.units);
      for (const [passId, units] of needed) {
        const fresh = (await passById(passId))!;
        const blocked = passBlockedReason(fresh);
        if (blocked) throw new Error(`BLOCKED:${blocked}`);
        if (fresh.remaining < units)
          throw new Error(`BLOCKED:This pass has ${passAmount(fresh, fresh.remaining)} left, and this booking needs ${passAmount(fresh, units)}.`);
      }
      for (const s of spends)
        await db
          .prepare("INSERT INTO pass_entries (pass_id, delta, reason, booking_id, place_id) VALUES (?, ?, ?, ?, ?)")
          .run(s.pass.id, -s.units, `Booking ${booking.code}`, booking.id, s.placeId);
      if (!await claimPayment(booking.id, "pass")) throw new Error("RACED");
    })();
  } catch (err) {
    if (err instanceof Error && err.message === "RACED") return refuse("ALREADY_PAID");
    if (isDuplicateSpend(err)) return refuse("ALREADY_PAID");
    if (err instanceof Error && err.message.startsWith("BLOCKED:"))
      return { ok: false, error: err.message.slice("BLOCKED:".length) };
    throw err;
  }

  const first = spends[0].pass;
  return { ok: true, pass: (await passById(first.id))!, spent: spends.filter((s) => s.pass.id === first.id).reduce((n, s) => n + s.units, 0) };
}

/** "3 entries", "1 h 30 min": an amount of what a pass holds. */
export function passAmount(pass: Pick<Pass, "kind">, units: number): string {
  return englishOf(passUnits(pass, units));
}

/** The same, as a phrase a staff screen says in the staff language. */
function passUnits(pass: Pick<Pass, "kind">, units: number): StaffText {
  if (pass.kind === "time") return lengthText(units);
  return said(units === 1 ? "srv.pass.entries_one" : "srv.pass.entries_other", { n: units });
}

/** Empty is the same as unset for optional text a venue types in. */
function nullIfBlank(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/**
 * Phone numbers are typed loosely, so compare them by their key: the digits,
 * with the international and national forms of one number made the same
 * (lib/phone.ts).
 */
export function normalisePhone(phone: string): string {
  return phoneKey(phone);
}

/**
 * Give a cancelled booking's entries back. Refunding twice is refused, so a
 * double cancellation cannot mint entries. An expired pass is still credited —
 * the ledger stays honest, even if the entries can no longer be spent.
 */
export async function refundBookingToPass(bookingId: number, share = 1): Promise<PassPayResult> {
  return withTransaction(async () => {
    const db = getDb();
    // Every spend on the booking: one for a booking paid as a whole, one a place for a pass spent per place.
    const charges = (await db
      .prepare(
        `SELECT e.id, e.pass_id, e.delta, e.place_id,
                EXISTS (SELECT 1 FROM pass_entries r WHERE r.settles_entry_id = e.id) AS settled
           FROM pass_entries e WHERE e.booking_id = ? AND e.delta < 0 ORDER BY e.id`
      )
      .all(bookingId)) as { id: number; pass_id: number; delta: number; place_id: number | null; settled: boolean }[];
    if (charges.length === 0) return { ok: false, error: "This booking was not paid with a pass." };

    // Given back before spends were matched to their refunds (every refund until migration 0155).
    const refunded = await db
      .prepare("SELECT id FROM pass_entries WHERE booking_id = ? AND delta > 0 AND settles_entry_id IS NULL")
      .get(bookingId);
    if (refunded) return { ok: false, error: "This booking has already been refunded." };
    // Each spend is given back once: a place taken off the booking already settled its own.
    const open = charges.filter((c) => !c.settled);
    if (open.length === 0) return { ok: false, error: "This booking has already been refunded." };

    const code = (await db.prepare("SELECT code FROM bookings WHERE id = ?").get(bookingId) as
      | { code: string }
      | undefined)?.code;
    for (const charge of open) {
      // Whole entries (or minutes) only: a late cancellation's share is rounded down.
      const back = Math.floor(-charge.delta * share);
      if (back > 0)
        await db
          .prepare("INSERT INTO pass_entries (pass_id, delta, reason, booking_id, place_id, settles_entry_id) VALUES (?, ?, ?, ?, ?, ?)")
          .run(charge.pass_id, back, `Refund for ${code ?? "booking"}`, bookingId, charge.place_id, charge.id);
    }

    return { ok: true, pass: (await passById(open[0].pass_id))!, spent: open.reduce((n, c) => n + c.delta, 0) };
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
  start_min: number | null;
  end_min: number | null;
  name: string;
  phone: string;
  email: string | null;
  user_id: number | null;
  status: WaitlistStatus;
  offered_at: string | null;
  offer_token: string | null;
  locale: string;
  created_at: string;
  places?: number;
  customer_takes_part?: boolean;
  made_by?: WaitlistMadeBy;
  made_by_admin_id?: number | null;
  made_by_api_key_id?: number | null;
  made_by_name?: string | null;
}

/** Who put an entry on the list: its customer online, the venue's staff at the counter, or the venue's API key (migration 0180). */
export type WaitlistMadeBy = "customer" | "staff" | "api";

/**
 * The venue queuing somebody on their word, as its counter books
 * (lib/waitlist-venue.ts): the member of staff, or the venue's own system
 * through its API key, by name as it is kept.
 */
export type WaitlistMaker = { channel: "staff"; adminId: number; name: string } | { channel: "api"; apiKeyId: number; name: string };

function toWaitlistEntry(r: WaitlistRow, includeToken = false): WaitlistEntry {
  const entry: WaitlistEntry = {
    id: r.id,
    classId: r.class_id,
    courtId: r.court_id,
    date: r.date,
    startMin: r.start_min,
    endMin: r.end_min,
    startHour: r.start_min === null ? null : hoursOf(r.start_min),
    endHour: r.end_min === null ? null : hoursOf(r.end_min),
    name: r.name,
    phone: r.phone,
    status: r.status,
    offeredAt: r.offered_at,
    offerToken: includeToken ? r.offer_token : null,
    locale: r.locale,
    createdAt: r.created_at,
    places: r.places ?? 1,
    customerTakesPart: r.customer_takes_part !== false,
    madeBy: r.made_by ?? "customer",
    ...(r.made_by && r.made_by !== "customer" ? { madeByName: r.made_by_name ?? null } : {}),
  };
  if (r.status === "offered" && r.offered_at) {
    const deadline = parseUtc(r.offered_at) + WAITLIST_OFFER_MINUTES * 60_000;
    entry.expiresInSeconds = Math.max(0, Math.round((deadline - Date.now()) / 1000));
  }
  return entry;
}

/** An entry as read back, with who it is for. */
async function readEntry(id: number, includeToken = false): Promise<WaitlistEntry> {
  const entry = toWaitlistEntry((await getDb().prepare("SELECT * FROM waitlist WHERE id = ?").get(id)) as WaitlistRow, includeToken);
  const names = (await entryPeople(id)).map((p) => p.name ?? "");
  if (names.length > 0) entry.participantNames = names;
  return entry;
}

/**
 * Who a waiting-list entry is for, besides (or instead of) its customer
 * (lib/participant-bookings.ts): each participant by id, null once their
 * record was erased.
 */
async function entryPeople(waitlistId: number): Promise<{ id: number | null; name: string | null }[]> {
  return (await getDb()
    .prepare("SELECT participant_id AS id, name FROM waitlist_participants WHERE waitlist_id = ? ORDER BY id")
    .all(waitlistId)) as { id: number | null; name: string | null }[];
}

/** The venue an entry is at, through its court or its class. */
async function entryVenue(row: WaitlistRow): Promise<number | null> {
  if (row.class_id) return (await getClass(row.class_id))?.venueId ?? null;
  return row.court_id ? ((await getCourt(row.court_id))?.venueId ?? null) : null;
}

/** How an entry is checked and booked: as it was made (online, the counter, the API). */
const channelOf = (row: WaitlistRow): SignOffChannel => row.made_by ?? "customer";

/**
 * Is an entry still for whom it was made, by whoever made it? Each
 * participant's record still there, and the account that queued still
 * acting for each (a guardian who ended or lost the relationship queues for
 * nobody); for an entry the venue made (the counter, its API key), each a
 * participant the venue knows with a live guardian on the entry's number, as
 * the counter checks a booking (lib/participant-bookings.ts `selectionAtVenue`).
 * Never resolved by putting the customer in a child's place.
 */
async function entryStillTheirs(row: WaitlistRow): Promise<{ id: number; name: string }[] | null> {
  const people = await entryPeople(row.id);
  if (channelOf(row) !== "customer") {
    if (people.length === 0) return [];
    if (people.some((p) => p.id === null)) return null;
    const venueId = await entryVenue(row);
    if (venueId === null) return null;
    const { selectionAtVenue } = await import("./participant-bookings");
    const known = await selectionAtVenue(venueId, row.phone, people.map((p) => p.id as number), row.customer_takes_part !== false);
    return "participants" in known ? known.participants : null;
  }
  const named: { id: number; name: string }[] = [];
  for (const p of people) {
    if (p.id === null || row.user_id === null) return null;
    const mine = await guardianshipOf(row.user_id, p.id, { live: true });
    if (!mine) return null;
    named.push({ id: p.id, name: mine.participant.displayName });
  }
  return named;
}

/** An entry that is no longer for whom it was made: taken out of the queue, its hold let go. */
async function dropEntry(id: number): Promise<void> {
  await getDb().prepare("UPDATE waitlist SET status = 'cancelled', offer_token = NULL WHERE id = ? AND status IN ('waiting','offered')").run(id);
  await release({ kind: "offer", waitlistId: id });
}

/** Who an entry is for, as the queue asks it (lib/participant-bookings.ts). */
interface Queuer {
  /** Participants named. */
  participants: { id: number; name: string }[];
  /** The customer takes a place too (always, where nobody is named). */
  customerTakesPart: boolean;
}
const queuerOf = (s: { participants: { id: number; name: string }[]; customerTakesPart: boolean } | undefined): Queuer =>
  !s || s.participants.length === 0 ? { participants: [], customerTakesPart: true } : s;
const placesFor = (q: Queuer): number => q.participants.length + (q.customerTakesPart ? 1 : 0);

/**
 * Is anybody this entry would be for already waiting (or, `enrolled`, in the
 * class)? The customer by their number, where they take part themself; each
 * participant by their id. Two children on one parent's number are two
 * people, and the parent a third.
 */
async function alreadyQueued(
  q: Queuer,
  phone: string,
  where: { sql: string; params: unknown[] }
): Promise<boolean> {
  const db = getDb();
  if (
    q.customerTakesPart &&
    (await db
      .prepare(`SELECT 1 FROM waitlist w WHERE ${where.sql} AND phone_key(w.phone) = phone_key(?) AND w.customer_takes_part AND w.status IN ('waiting','offered')`)
      .get(...where.params, phone.trim()))
  )
    return true;
  for (const p of q.participants)
    if (
      await db
        .prepare(
          `SELECT 1 FROM waitlist w JOIN waitlist_participants wp ON wp.waitlist_id = w.id
            WHERE ${where.sql} AND wp.participant_id = ? AND w.status IN ('waiting','offered')`
        )
        .get(...where.params, p.id)
    )
      return true;
  return false;
}

/** Write an entry and who it is for, in the caller's transaction. */
async function insertEntry(
  cols: { class_id?: number; court_id?: number; date?: string; start_min?: number; end_min?: number },
  input: { name: string; phone: string; email?: string; userId?: number; locale?: string; madeBy?: WaitlistMaker },
  q: Queuer
): Promise<number> {
  const db = getDb();
  const by = input.madeBy;
  const row = (await db
    .prepare(
      `INSERT INTO waitlist (class_id, court_id, date, start_min, end_min, name, phone, email, user_id, locale, places, customer_takes_part,
                             made_by, made_by_admin_id, made_by_api_key_id, made_by_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .get(
      cols.class_id ?? null,
      cols.court_id ?? null,
      cols.date ?? null,
      cols.start_min ?? null,
      cols.end_min ?? null,
      input.name.trim(),
      input.phone.trim(),
      input.email?.trim() ?? null,
      input.userId ?? null,
      input.locale ?? "en",
      placesFor(q),
      q.customerTakesPart,
      by?.channel ?? "customer",
      by?.channel === "staff" ? by.adminId : null,
      by?.channel === "api" ? by.apiKeyId : null,
      by ? by.name.slice(0, 120) : null
    )) as { id: number };
  for (const p of q.participants)
    await db.prepare("INSERT INTO waitlist_participants (waitlist_id, participant_id, name) VALUES (?, ?, ?)").run(row.id, p.id, p.name);
  return row.id;
}

/** datetime('now') is UTC without a zone marker. */
function parseUtc(stamp: string): number {
  return new Date(stamp.includes("Z") ? stamp : `${stamp.replace(" ", "T")}Z`).getTime();
}

/**
 * Time out offers nobody claimed, at the start of every waitlist operation
 * and on every scheduler tick. Returns where places came free again, for the
 * next person in each queue to be offered them.
 */
async function expireStaleOffers(): Promise<{ classIds: number[]; slots: { courtId: number; date: string }[] }> {
  const db = getDb();
  const rows = await db
    .prepare("SELECT id, offered_at, class_id, court_id, date FROM waitlist WHERE status = 'offered'")
    .all() as { id: number; offered_at: string | null; class_id: number | null; court_id: number | null; date: string | null }[];
  const now = Date.now();
  const freed = { classIds: [] as number[], slots: [] as { courtId: number; date: string }[] };
  for (const row of rows) {
    if (!row.offered_at) continue;
    if (parseUtc(row.offered_at) + WAITLIST_OFFER_MINUTES * 60_000 <= now) {
      const done = await db.prepare(
        "UPDATE waitlist SET status = 'expired', offer_token = NULL WHERE id = ? AND status = 'offered'"
      ).run(row.id);
      if (done.changes !== 1) continue;
      // Its hold on the court goes with it.
      await release({ kind: "offer", waitlistId: row.id });
      if (row.class_id) freed.classIds.push(row.class_id);
      else if (row.court_id && row.date) freed.slots.push({ courtId: row.court_id, date: row.date });
    }
  }
  return freed;
}

/**
 * The scheduler's part: offers that ran out pass straight to the next person
 * waiting, rather than sitting until somebody else happens to cancel. The
 * offers made are told by the outbox's sweep (notifyPendingOffers).
 */
export async function passOnExpiredOffers(): Promise<number> {
  const freed = await expireStaleOffers();
  let offered = 0;
  for (const id of new Set(freed.classIds)) if (await offerClassPlace(id)) offered++;
  const seen = new Set<string>();
  for (const s of freed.slots) {
    const key = `${s.courtId}:${s.date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (await offerSlotPlace(s.courtId, s.date)) offered++;
  }
  return offered;
}

export type WaitlistResult =
  | { ok: true; entry: WaitlistEntry; position: number }
  | Refusal;

/**
 * Queue for a class place. Only possible while the class cannot take
 * everybody asked for. With `people`, for participants the signed-in account
 * acts for (lib/participant-bookings.ts, checked by the caller), and the
 * customer too where they take part: the entry keeps them all, and waits for
 * a place for each.
 */
export async function joinClassWaitlist(input: {
  classId: number;
  name: string;
  phone: string;
  /** The language to make the offer in, when one comes. */
  locale?: string;
  email?: string;
  userId?: number;
  people?: { participants: { id: number; name: string }[]; customerTakesPart: boolean };
  /** Queued by the venue, on its word (lib/waitlist-venue.ts): checked and booked as the counter would. */
  madeBy?: WaitlistMaker;
}): Promise<WaitlistResult> {
  return withTransaction(async () => {
    await expireStaleOffers();
    const session = await getClass(input.classId);
    if (!session) return refuse("CLASS_NOT_FOUND");
    if (session.status === "cancelled") return refuse("CLASS_CANCELLED");
    if (minutesUntil(session.date, session.startMin, (await venueHours(session.venueId)).zone) <= 0)
      return refuse("CLASS_STARTED");
    const q = queuerOf(input.people);
    const places = placesFor(q);
    if (places > session.capacity) return refuse("PLAYERS_RANGE", { max: session.capacity });
    if (session.capacity - session.enrolled >= places)
      return refuse("CLASS_HAS_PLACES");

    const db = getDb();
    if (await alreadyQueued(q, input.phone, { sql: "w.class_id = ?", params: [input.classId] })) return refuse("ALREADY_WAITING");
    if (q.customerTakesPart) {
      const enrolled = await db
        .prepare(`SELECT b.id FROM bookings b WHERE b.class_id = ? AND b.phone_key = phone_key(?) AND b.status = 'confirmed' AND ${CUSTOMER_TAKES_PART("b")}`)
        .get(input.classId, input.phone.trim());
      if (enrolled) return refuse("ALREADY_ENROLLED");
    }
    for (const p of q.participants)
      if (await db.prepare(`SELECT b.id FROM bookings b WHERE b.class_id = ? AND b.status = 'confirmed' AND ${PARTICIPANT_TAKES_PART("b")}`).get(input.classId, p.id))
        return refuse("ALREADY_ENROLLED");

    const id = await insertEntry({ class_id: input.classId }, input, q);
    return { ok: true, entry: await readEntry(id), position: (await classQueue(input.classId)).length };
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
 * Places came free in a class: offer them to the person who has waited
 * longest and whose places they all are (an entry for two children is
 * offered two places, never one; an entry that does not fit waits, as a
 * time that is not free does on the slot queue). Each entry is checked
 * again first: still for whom it was made, by an account acting for them.
 * Does nothing if someone already holds a live offer for it.
 */
export async function offerClassPlace(classId: number): Promise<WaitlistEntry | null> {
  return withTransaction(async () => {
    await expireStaleOffers();
    const queue = await classQueue(classId);
    if (queue.some((row) => row.status === "offered")) return null;

    const session = await getClass(classId);
    if (!session || session.status === "cancelled") return null;
    const free = session.capacity - session.enrolled - (await classOfferHolds(classId));
    if (free <= 0) return null;

    const db = getDb();
    for (const next of queue) {
      if (next.status !== "waiting" || (next.places ?? 1) > free) continue;
      if ((await entryStillTheirs(next)) === null) {
        await dropEntry(next.id);
        continue;
      }
      await db.prepare(
        "UPDATE waitlist SET status = 'offered', offered_at = datetime('now'), offer_token = ? WHERE id = ?"
      ).run(randomBytes(16).toString("hex"), next.id);
      return await readEntry(next.id, true);
    }
    return null;
  });
}

export type ClaimResult =
  | { ok: true; booking: Booking; bookings: Booking[]; entry: WaitlistEntry }
  | Refusal;

/**
 * Take up an offered place. The offer token is the only way in. Booked for
 * whom the entry was made, each checked again as any booking is (their own
 * sign-offs, the account still acting for them, the price as it stands now):
 * never the customer in a child's place, never fewer places than asked.
 */
async function claimWaitlistOfferOnce(token: string): Promise<ClaimResult> {
  return withTransaction(async () => {
    await expireStaleOffers();
    const db = getDb();
    const row = await db
      .prepare("SELECT * FROM waitlist WHERE offer_token = ?")
      .get(token.trim()) as WaitlistRow | undefined;
    if (!row) return refuse("OFFER_INVALID");
    if (row.status !== "offered")
      return refuse("OFFER_EXPIRED");

    // Still for whom it was made, by somebody acting for them: else it goes, and the place to the next.
    const named = await entryStillTheirs(row);
    if (named === null) {
      await dropEntry(row.id);
      if (row.class_id) await offerClassPlace(row.class_id);
      else if (row.court_id && row.date) await offerSlotPlace(row.court_id, row.date);
      return refuse("OFFER_INVALID");
    }
    const takesPart = row.customer_takes_part !== false || named.length === 0;

    let bookings: Booking[];
    if (row.class_id) {
      const enrolled = await enrolPeople({
        classId: row.class_id,
        name: row.name,
        phone: row.phone,
        email: row.email ?? undefined,
        userId: row.user_id ?? undefined,
        waitlistId: row.id,
        people: [...(takesPart ? [null] : []), ...named],
        addedBy: channelOf(row) === "customer" ? { userId: row.user_id } : { adminId: row.made_by_admin_id ?? null },
      });
      if (!enrolled.ok) return { ok: false, error: enrolled.error, ...(enrolled.code ? { code: enrolled.code } : {}) } as Refusal;
      bookings = enrolled.bookings;
    } else if (row.court_id && row.date && row.start_min !== null && row.end_min !== null) {
      // Booked as the customer would book it; the offer's own hold becomes the booking's.
      const created = await createBookingSeries({
        courtId: row.court_id,
        date: row.date,
        start: row.start_min,
        end: row.end_min,
        weeks: 1,
        name: row.name,
        phone: row.phone,
        email: row.email ?? undefined,
        userId: row.user_id ?? undefined,
        waitlistId: row.id,
        // As it was queued: an entry the counter or the API made is booked as they book (sign-offs on its number).
        ...(channelOf(row) !== "customer" ? { by: channelOf(row) } : {}),
        ...(named.length > 0
          ? { participants: named, customerTakesPart: takesPart, addedBy: channelOf(row) === "customer" ? { userId: row.user_id } : { adminId: row.made_by_admin_id ?? null } }
          : {}),
        ...((row.places ?? 1) > 1 ? { players: row.places } : {}),
      });
      if (!created.ok) {
        // Somebody beat them to it. Keep their place rather than burning it.
        await db.prepare(
          "UPDATE waitlist SET status = 'waiting', offered_at = NULL, offer_token = NULL WHERE id = ?"
        ).run(row.id);
        await release({ kind: "offer", waitlistId: row.id });
        return { ok: false, error: created.error, ...(created.code ? { code: created.code } : {}) } as Refusal;
      }
      bookings = created.bookings;
    } else {
      return refuse("OFFER_INVALID");
    }

    await db.prepare("UPDATE waitlist SET status = 'claimed', offer_token = NULL WHERE id = ?").run(row.id);
    return { ok: true, booking: bookings[0], bookings, entry: await readEntry(row.id) };
  });
}

/** Give up a place in the queue. */
export async function leaveWaitlist(entryId: number, phone: string): Promise<{ ok: true } | Refusal> {
  return withTransaction(async () => {
    const db = getDb();
    const row = await db
      .prepare("SELECT * FROM waitlist WHERE id = ? AND phone_key(phone) = phone_key(?)")
      .get(entryId, phone.trim()) as WaitlistRow | undefined;
    if (!row) return refuse("WAITLIST_NOT_FOUND");
    if (row.status === "claimed") return refuse("PLACE_ALREADY_CLAIMED");

    await db.prepare("UPDATE waitlist SET status = 'cancelled', offer_token = NULL WHERE id = ?").run(row.id);
    await release({ kind: "offer", waitlistId: row.id });
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
  const out: WaitlistEntry[] = [];
  for (const r of rows) out.push(await readEntry(r.id));
  return out;
}

/** What this person is queuing for, with any live offer's token. */
export async function listWaitlistFor(phone: string): Promise<WaitlistEntry[]> {
  return listWaitlist("phone_key(phone) = phone_key(?)", [phone.trim()]);
}

/**
 * An account's own places in waiting lists: those it joined, and those on the
 * number it has proved. A number the account only typed in is not enough to
 * see who else queued on it.
 */
export async function listWaitlistForAccount(userId: number): Promise<WaitlistEntry[]> {
  return listWaitlist(
    `(user_id = ? OR EXISTS (SELECT 1 FROM users u WHERE u.id = ? AND u.verified_phone IS NOT NULL AND phone_key(u.verified_phone) = phone_key(waitlist.phone)))`,
    [userId, userId]
  );
}

async function listWaitlist(where: string, params: unknown[]): Promise<WaitlistEntry[]> {
  await expireStaleOffers();
  const rows = await getDb()
    .prepare(`SELECT * FROM waitlist WHERE ${where} AND status IN ('waiting','offered') ORDER BY id DESC`)
    .all(...params) as WaitlistRow[];
  const entries: WaitlistEntry[] = [];
  for (const row of rows) entries.push(await labelled(row, row.status === "offered"));
  return entries;
}

/** An entry with what it waits for, in words: the class, or the resource and the time. */
async function labelled(row: WaitlistRow, includeToken: boolean): Promise<WaitlistEntry> {
  const entry = await readEntry(row.id, includeToken);
  if (row.class_id) {
    const session = await getClass(row.class_id);
    if (session) {
      entry.label = `${session.name} · ${session.date} ${formatMinute(session.startMin)}`;
    }
  } else if (row.court_id && row.date && row.start_min !== null) {
    const court = await getCourt(row.court_id);
    if (court) {
      entry.label = `${court.name} · ${row.date} ${formatMinute(row.start_min)}`;
    }
  }
  return entry;
}

/**
 * A venue's queues on a day, for its staff and its own system: court and
 * facility time on its resources that day, and its classes that day, in the
 * order they will be offered, each saying who made it. Never an offer's
 * token: that is only ever the customer's.
 */
export async function listVenueWaitlist(venueId: number, date: string): Promise<WaitlistEntry[]> {
  await expireStaleOffers();
  const rows = (await getDb()
    .prepare(
      `SELECT w.* FROM waitlist w
         LEFT JOIN courts ct ON ct.id = w.court_id
         LEFT JOIN classes cl ON cl.id = w.class_id
         LEFT JOIN courts cc ON cc.id = cl.court_id
        WHERE w.status IN ('waiting','offered')
          AND ((w.class_id IS NULL AND ct.venue_id = ? AND w.date = ?) OR (w.class_id IS NOT NULL AND cc.venue_id = ? AND cl.date = ?))
        ORDER BY w.id`
    )
    .all(venueId, date, venueId, date)) as WaitlistRow[];
  const entries: WaitlistEntry[] = [];
  for (const row of rows) entries.push(await labelled(row, false));
  return entries;
}

/**
 * Staff (or the venue's API key) take an entry the venue made off its list:
 * one made at the counter or through the API, at this venue. One its
 * customer made online is theirs to leave. Its hold goes, and a live offer
 * passes to the next in line, as when somebody leaves.
 */
export async function removeVenueWaitlistEntry(entryId: number, venueId: number): Promise<{ ok: true; entry: WaitlistEntry } | Refusal> {
  return withTransaction(async () => {
    const db = getDb();
    const row = (await db.prepare("SELECT * FROM waitlist WHERE id = ? FOR UPDATE").get(entryId)) as WaitlistRow | undefined;
    // Another venue's entry is not there at all, as far as this venue is concerned.
    if (!row || (await entryVenue(row)) !== venueId) return refuse("WAITLIST_NOT_FOUND");
    if (channelOf(row) === "customer") return { ok: false, error: "That entry was made online by the customer: it is theirs to leave." } as Refusal;
    if (row.status === "claimed") return refuse("PLACE_ALREADY_CLAIMED");
    if (row.status !== "waiting" && row.status !== "offered") return refuse("WAITLIST_NOT_FOUND");
    await db.prepare("UPDATE waitlist SET status = 'cancelled', offer_token = NULL WHERE id = ?").run(row.id);
    await release({ kind: "offer", waitlistId: row.id });
    const entry = await labelled(row, false);
    if (row.class_id) await offerClassPlace(row.class_id);
    else if (row.court_id && row.date) await offerSlotPlace(row.court_id, row.date);
    return { ok: true as const, entry };
  });
}

/* ---------------- Waitlists for ordinary time ---------------- */

/** Is this time free on this resource right now, with its buffers, for `places` more? */
async function slotTimeFree(court: Court, date: string, span: Span, policy: BookingPolicy, zone: string, places = 1): Promise<boolean> {
  const held = (await occupantsOn([court], date, zone)).get(court.id)!;
  return fits(held, court.capacity, span, policyBuffers(policy), undefined, court.capacity > 1 ? places : 1);
}

/**
 * Queue for court or facility time that is currently taken. With `people`,
 * for participants the signed-in account acts for (checked by the caller):
 * each must be able to book it (their own sign-off), and the entry waits
 * for a place for each on a shared facility.
 */
export async function joinSlotWaitlist(input: {
  courtId: number;
  date: string;
  /** The language to make the offer in, when one comes. */
  locale?: string;
  /** The time wanted, in minutes of the day (or hours, the older way). */
  start?: number;
  end?: number;
  startHour?: number;
  endHour?: number;
  name: string;
  phone: string;
  email?: string;
  userId?: number;
  people?: { participants: { id: number; name: string }[]; customerTakesPart: boolean };
  /** Queued by the venue, on its word (lib/waitlist-venue.ts): checked and booked as the counter would. */
  madeBy?: WaitlistMaker;
}): Promise<WaitlistResult> {
  return withTransaction(async () => {
    await expireStaleOffers();
    const { courtId, date } = input;
    const start = minutesFrom(input.start, input.startHour);
    const end = minutesFrom(input.end, input.endHour);

    const waitCourt = await getCourt(courtId);
    if (!waitCourt) return refuse("COURT_NOT_FOUND");
    if (!isValidDateString(date)) return refuse("THOSE_HOURS_OUTSIDE_OPENING");
    const day = await courtDay(waitCourt, date);
    if (!isMinute(start) || !isMinute(end) || end <= start) return refuse("THOSE_HOURS_OUTSIDE_OPENING");
    const span = { start, end };
    if (day.closed) return refuse("VENUE_CLOSED");
    // Asked for as a booking would be: the court's rules.
    const breaches = policyBreaches(day.policy, span, day, minutesUntil(date, start, day.zone)).filter((b) => b !== "NOTICE");
    if (breaches.includes("HOURS")) return refuse("THOSE_HOURS_OUTSIDE_OPENING");
    if (breaches.length > 0) return breachRefusal(day.policy, span, breaches[0]);
    if (!isBookableDate(date, day.zone, await venueAheadDays(waitCourt.venueId))) return refuse("DATE_OUT_OF_WINDOW");
    if (minutesUntil(date, start, day.zone) <= 0) return refuse("TIME_PAST");
    const q = queuerOf(input.people);
    const places = placesFor(q);
    // Places sold one by one (a shared facility, a court priced per player): one each. A court booked whole takes any party.
    if (placesPerBooking(waitCourt) > 1 && places > placesPerBooking(waitCourt)) return refuse("PLAYERS_RANGE", { max: placesPerBooking(waitCourt) });
    // Only somebody who could book it waits for it: an offer they could not take would go round for nothing.
    // Each taking part on their own sign-off: the customer's own where they take part, each participant's.
    const need = day.policy.certification ? "certification" : day.policy.signOff ? "any" : null;
    if (need)
      for (const who of [...(q.customerTakesPart ? [null] : []), ...q.participants])
        if (
          !(await signOffHolds({ venueId: waitCourt.venueId, sport: waitCourt.sport, until: date, phone: input.phone, userId: input.userId, channel: input.madeBy?.channel ?? "customer", need, participant: who ? who.id : null }))
        )
          return signOffRefusal(need, activityName(waitCourt.sport), who ? who.name : null);

    if (await slotTimeFree(waitCourt, date, span, day.policy, day.zone, places))
      return refuse("SLOT_FREE_BOOK_IT");

    if (await alreadyQueued(q, input.phone, { sql: "w.court_id = ? AND w.date = ? AND w.start_min = ?", params: [courtId, date, start] }))
      return refuse("ALREADY_WAITING");

    const id = await insertEntry({ court_id: courtId, date, start_min: start, end_min: end }, input, q);
    return { ok: true, entry: await readEntry(id), position: (await slotQueue(courtId, date)).length };
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
 * Time freed up on a resource: offer it to the longest waiter whose wanted
 * time is now entirely free, for every place they wait for. The offer claims
 * that time (and those places) until it is taken up or runs out, so nobody
 * else can book it meanwhile; one live offer per resource and day, so
 * overlapping windows cannot be promised to two people at once. Each entry
 * is checked again first: still for whom it was made, by an account acting
 * for them (else it leaves the queue), and each of them still able to book
 * it (else it waits).
 */
export async function offerSlotPlace(courtId: number, date: string): Promise<WaitlistEntry | null> {
  return withTransaction(async () => {
    await expireStaleOffers();
    const queue = await slotQueue(courtId, date);
    if (queue.some((row) => row.status === "offered")) return null;
    const court = await getCourt(courtId);
    if (!court) return null;
    const day = await courtDay(court, date);
    const need = day.policy.certification ? "certification" : day.policy.signOff ? "any" : null;

    for (const row of queue) {
      if (row.status !== "waiting" || row.start_min === null || row.end_min === null) continue;
      const span = { start: row.start_min, end: row.end_min };
      if (minutesUntil(date, span.start, day.zone) <= 0) continue;
      const places = row.places ?? 1;
      if (!(await slotTimeFree(court, date, span, day.policy, day.zone, places))) continue;
      const named = await entryStillTheirs(row);
      if (named === null) {
        await dropEntry(row.id);
        continue;
      }
      // Eligibility as it stands now, each on their own: a sign-off that lapsed while they waited.
      if (need) {
        let eligible = true;
        for (const who of [...(row.customer_takes_part !== false ? [null] : []), ...named.map((p) => p.id)])
          eligible =
            eligible &&
            (await signOffHolds({ venueId: court.venueId, sport: court.sport, until: date, phone: row.phone, userId: row.user_id, channel: channelOf(row), need, participant: who }));
        if (!eligible) continue;
      }

      const db = getDb();
      try {
        await withTransaction(async () => {
          await db.prepare(
            "UPDATE waitlist SET status = 'offered', offered_at = datetime('now'), offer_token = ? WHERE id = ?"
          ).run(randomBytes(16).toString("hex"), row.id);
          await claim({
            court,
            source: { kind: "offer", waitlistId: row.id },
            date,
            span,
            zone: day.zone,
            ...claimBuffers(day.policy),
            // Every place it waits for, or no offer at all.
            places,
            expiresAt: new Date(Date.now() + WAITLIST_OFFER_MINUTES * 60_000),
          });
        });
      } catch (err) {
        // Taken in the moment between looking and offering: the next in line may want other time.
        if (isConflict(err)) continue;
        throw err;
      }
      return await readEntry(row.id, true);
    }
    return null;
  });
}

/* ---------------- Finding a booking, for staff ---------------- */

export interface BookingHit {
  code: string;
  date: string;
  startMin: number;
  endMin: number;
  startHour: number;
  endHour: number;
  courtName: string;
  venueName: string;
  name: string;
  phone: string;
  status: BookingStatus;
  paymentStatus: PaymentStatus;
}

/**
 * The bookings at these venues a customer at the desk is asking about: by
 * code, phone number (however typed), email or part of a name, from 90 days
 * back to 90 ahead, newest first. Not the whole history: a desk looking up
 * somebody standing in front of it.
 */
export async function searchBookings(query: string, venueIds?: number[]): Promise<BookingHit[]> {
  const q = query.trim();
  if (q.length < 3) return [];
  const venues = venueIds === undefined ? { sql: "", params: [] as number[] } : { sql: ` AND c.venue_id IN (${venueIds.map(() => "?").join(",") || "NULL"})`, params: venueIds };
  const digits = q.replace(/\D/g, "");
  const rows = (await getDb()
    .prepare(
      `SELECT b.code, b.date, b.start_min, b.end_min, c.name AS court_name, v.name AS venue_name, b.name, b.phone, b.status, b.payment_status
         FROM bookings b JOIN courts c ON c.id = b.court_id JOIN venues v ON v.id = c.venue_id
        WHERE b.date BETWEEN ? AND ?${venues.sql}
          AND (UPPER(b.code) = UPPER(?) OR (? <> '' AND b.phone_key = phone_key(?)) OR LOWER(b.email) = LOWER(?) OR b.name ILIKE ?)
        ORDER BY b.date DESC, b.start_min DESC LIMIT 50`
    )
    .all(
      addDays(todayISO(), -90),
      addDays(todayISO(), 90),
      ...venues.params,
      q,
      digits.length >= 7 ? digits : "",
      q,
      q,
      `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    )) as {
    code: string;
    date: string;
    start_min: number;
    end_min: number;
    court_name: string;
    venue_name: string;
    name: string;
    phone: string;
    status: BookingStatus;
    payment_status: PaymentStatus;
  }[];
  return rows.map((r) => ({
    code: r.code,
    date: r.date,
    startMin: r.start_min,
    endMin: r.end_min,
    startHour: hoursOf(r.start_min),
    endHour: hoursOf(r.end_min),
    courtName: r.court_name,
    venueName: r.venue_name,
    name: r.name,
    phone: r.phone,
    status: r.status,
    paymentStatus: r.payment_status,
  }));
}
