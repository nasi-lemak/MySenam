import type { WeekHours } from "./week-hours";
import type { ErrorCode } from "./i18n";
import type { Amenity, CourtFeatures } from "./facilities";
import { region } from "./region.ts";
/**
 * An activity's key in the catalogue: "badminton", "bouldering", or an
 * operator's own ("sky_yoga"). The code names none of them; what each is
 * called, how it is found and its usual rules are data (lib/activity-registry.ts,
 * ADR 0011).
 */
export type Sport = string;

export interface Venue {
  id: number;
  name: string;
  area: string;
  address: string;
  phone: string;
  /** Customers may cancel until this many hours before the booking starts. */
  cancelCutoffHours: number;
  /** Trading hours in minutes of the day: when it opens, and when it closes (past 1440 is after midnight). */
  openMin: number;
  closeMin: number;
  /** The same in hours (18.5 is 18:30), for display. */
  openHour: number;
  closeHour: number;
  /** Weekdays with hours of their own, or closed; null when every day keeps the usual ones (lib/week-hours.ts). */
  weekHours?: WeekHours | null;
  /** The venue's time zone (IANA), which its courts' times are in. */
  timeZone: string;
  /**
   * When somebody is behind the counter. null for both means always staffed;
   * equal values mean never staffed. Outside the window is an unstaffed hour,
   * which is when self-entry applies.
   */
  staffedFrom: number | null;
  staffedTo: number | null;
  /** Shown to anyone letting themselves in. */
  emergencyPhone: string | null;
  emergencyInfo: string | null;
  /** When customers could first reach it; null for a draft (lib/listing.ts). */
  publishedAt: string | null;
  /** Taken off the marketplace; null otherwise. */
  suspendedAt: string | null;
  /** By an invoice long overdue, which paying lifts, or by the platform owner. */
  suspendedBy: "payment" | "owner" | null;
  /** The platform owner's reason, shown to the venue's staff. */
  suspendedReason: string | null;
  /** Where it is on the map; null for venues never pinned. */
  lat: number | null;
  lng: number | null;
  /** What it offers besides its courts, from a fixed list (lib/facilities.ts). */
  amenities: Amenity[];
  /** Who it is for: anybody, members, or a private list (lib/access.ts). */
  access?: "public" | "members" | "private";
}

/** True when nobody is behind the counter at this hour. */
export function isUnstaffedHour(
  venue: Pick<Venue, "staffedFrom" | "staffedTo">,
  hour: number
): boolean {
  const { staffedFrom: from, staffedTo: to } = venue;
  if (from === null || to === null) return false; // always staffed
  if (from === to) return true; // never staffed
  return from < to
    ? hour < from || hour >= to
    : // A window that wraps past midnight, such as 22:00–06:00.
      hour < from && hour >= to;
}

/** A whole day a venue is shut. */
export interface VenueClosure {
  date: string;
  reason: string | null;
}

export const DEFAULT_CANCEL_CUTOFF_HOURS = 2;
export const MAX_CANCEL_CUTOFF_HOURS = 72;

/**
 * A bookable resource. `capacity` 1 is a court held exclusively; greater than
 * 1 is a shared facility (gym floor, pool, class) where that many people can
 * hold the same hour.
 */
/** One activity a court offers, at its own rates where it has them (null: the court's). */
export interface CourtActivity {
  sport: Sport;
  offPeakRate: number | null;
  peakRate: number | null;
}

export interface Court extends CourtFeatures {
  id: number;
  venueId: number;
  name: string;
  /** Its main activity: what it is listed under first. */
  sport: Sport;
  /** Every activity it can be booked for, the main one first. */
  activities: CourtActivity[];
  /** What one of it is called ("lane", "bay"); null: what its activity's are. */
  noun: string | null;
  offPeakRate: number;
  peakRate: number;
  /** What a member pays instead. null means members pay the public rate here. */
  memberOffPeakRate: number | null;
  memberPeakRate: number | null;
  capacity: number;
  /** Its rates are per player, and a booking says how many play, up to `maxPlayers` (DEFAULT_MAX_PLAYERS). */
  perPlayer?: boolean;
  maxPlayers?: number | null;
  /**
   * What the desk holds while this resource is out on hire, in ringgit. 0 is
   * the normal case: a court cannot be carried off.
   */
  deposit: number;
  /**
   * Nobody is at the door: the customer lets themselves in with a code. The
   * code itself is never part of this object, which is served publicly.
   */
  unmanned: boolean;
}

export const MAX_CAPACITY = 500;
/** The largest deposit a venue may set, so a typo cannot ask for thousands. */
export const MAX_DEPOSIT = 500;

export function isHire(court: Pick<Court, "deposit">): boolean {
  return court.deposit > 0;
}

/** Keeps the emergency note to something readable on a phone at midnight. */
export const MAX_EMERGENCY_INFO = 300;

/** The longest a door code should go unchanged before staff are nagged. */
export const ACCESS_CODE_STALE_DAYS = 30;

export const MIN_ACCESS_CODE = 4;
export const MAX_ACCESS_CODE = 12;

/**
 * Why a door code is being withheld. Each one is a thing the customer can
 * act on, so the reason travels with the refusal rather than a bare no.
 */
export type AccessDenial =
  | "not-unmanned"
  | "staffed-now"
  | "no-induction"
  | "cancelled"
  | "unpaid"
  | "too-early"
  | "over";

/** What a customer gets back when asking to be let in. */
export type AccessResult =
  | {
      ok: true;
      accessCode: string;
      courtName: string;
      venueName: string;
      until: string;
      /** What to do, and who to ring, while standing inside an empty building. */
      emergencyPhone: string | null;
      emergencyInfo: string | null;
      /**
       * How many people are checked in at this venue right now, this one
       * included. 1 means they are alone in the building.
       */
      presentNow: number;
    }
  | { ok: false; reason: AccessDenial; message: string };

/** One person cleared by staff to use a venue outside staffed hours. */
export interface Induction {
  id: number;
  venueId: number;
  phone: string;
  name: string;
  adminName: string | null;
  note: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export function isShared(court: Pick<Court, "capacity">): boolean {
  return court.capacity > 1;
}

export type BookingStatus = "confirmed" | "cancelled";
export type PaymentStatus = "unpaid" | "paid";

/**
 * How a booking was paid. Staff pick one of COUNTER_METHODS when they take
 * the money; the rest are recorded by the payment itself. Older bookings
 * marked paid before this was asked have none.
 */
export const COUNTER_METHODS = ["cash", "qr", "transfer", "card"] as const;
export type CounterMethod = (typeof COUNTER_METHODS)[number];
export type PaidVia = CounterMethod | "online" | "pass" | "credit";
export const PAID_VIA_LABELS: Record<PaidVia, string> = {
  cash: "Cash",
  // The country's QR scheme: DuitNow in Malaysia, PayNow in Singapore.
  get qr() {
    return `${region().qrName} / e-wallet`;
  },
  transfer: "Bank transfer",
  card: "Card terminal",
  online: "Online",
  pass: "Pass",
  credit: "Stored credit",
};

export interface Booking {
  id: number;
  /** The venue's tax rate (%) when it was booked, included in the price; null with none. */
  taxRate?: number | null;
  code: string;
  courtId: number;
  /** The activity booked: one its court offered then. */
  sport: Sport;
  /** The venue's business day it is on (YYYY-MM-DD). */
  date: string;
  /** Minutes of that day it starts and ends (1087 is 18:07; past 1440 is after midnight). */
  startMin: number;
  endMin: number;
  /** The same in hours (18.5 is 18:30), for display and the public API. */
  startHour: number;
  endHour: number; // exclusive
  /** The moments it starts and ends, where the venue is (ISO 8601). */
  startsAt?: string;
  endsAt?: string;
  /** Setup and cleanup fees, part of `totalPrice`, shown apart from the time. */
  feeAmount?: number;
  /** Made by staff outside the court's booking policy (what, and who, is in the activity log). */
  policyOverride?: boolean;
  name: string;
  phone: string;
  email: string | null;
  totalPrice: number;
  status: BookingStatus;
  createdAt: string;
  seriesCode: string | null;
  /** Booked with other courts at the same time, as one (lib/store.ts `createGroupBooking`). */
  groupCode?: string | null;
  /** How many play, on a court priced per player; 1 elsewhere. */
  players?: number;
  /** A concession price (lib/concessions.ts): which, what it took off, and whether proof was seen. */
  concessionName?: string | null;
  concessionOff?: number;
  concessionCheck?: "due" | "seen" | "refused" | null;
  paymentStatus: PaymentStatus;
  paidAt: string | null;
  /** Paid through the venue's online gateway: the money is there, not in the till. */
  paidOnline?: boolean;
  /** How it was paid, when that was recorded; see PAID_VIA. */
  paidVia?: PaidVia | null;
  /** Held unpaid until then, at a venue asking for payment online to hold it (lib/holds.ts). */
  holdUntil?: string | null;
  /** Let go because it was not paid in time. */
  releasedUnpaid?: boolean;
  /** Set by staff after the slot passes and nobody turned up. */
  noShow: boolean;
  /** When the customer arrived at the desk, if they did. */
  checkedInAt: string | null;
  checkedOutAt: string | null;
  /** Secret behind the self check-in QR code. Never shown to other customers. */
  checkInToken: string | null;
  /** Set when this booking is an enrolment in an instructor-led class. */
  classId: number | null;
  /**
   * Paid towards it on receipts of its own: other players' shares in its open
   * game (lib/games.ts), friends' in a split (lib/splits.ts), and the booker's
   * own deposit (depositPaid). The rest is what is still due.
   */
  sharesPaid: number;
  /** Of sharesPaid, what the booker paid online as a deposit to hold it (lib/holds.ts). */
  depositPaid?: number;
  /** A lesson: the coach on it, and their fee inside the price (lib/coaching.ts). */
  coachId?: number | null;
  coachFee?: number;
  /** Charged to a company or school account, paid on its invoice (lib/accounts.ts). */
  accountId?: number | null;
}

export type ClassStatus = "scheduled" | "cancelled";

/** An instructor-led session people enrol in, rather than book outright. */
export interface ClassSession {
  id: number;
  courtId: number;
  courtName: string;
  venueId: number;
  venueName: string;
  venueArea: string;
  sport: Sport;
  name: string;
  instructor: string;
  date: string;
  /** Minutes of the day it runs, and the same in hours. */
  startMin: number;
  endMin: number;
  startHour: number;
  endHour: number;
  capacity: number;
  /** Per person, for the whole session. */
  price: number;
  status: ClassStatus;
  seriesCode: string | null;
  enrolled: number;
  /** Anyone, women only or men only (lib/who.ts). */
  who: "anyone" | "women" | "men";
  /** A share off each session for joining every one left in the series at once (lib/store.ts `enrolInTerm`). */
  termOffPercent?: number | null;
}

export const MAX_CLASS_WEEKS = 12;

/** One movement of stored credit. The balance is the sum of these. */
export interface WalletEntry {
  id: number;
  amount: number;
  reason: string;
  bookingId: number | null;
  createdAt: string;
  /** The venue whose credit this is, when credit is per venue; null for any venue. */
  venueId?: number | null;
  venueName?: string | null;
}

/** A customer's credit at one venue, or (venueId null) at any venue. */
export interface WalletBalance {
  venueId: number | null;
  venueName: string | null;
  balance: number;
}

/** The most ways a booking can be split with friends, the booker included (lib/splits.ts). */
export const MAX_SPLIT_PARTS = 10;

/** The most a review of a venue may say (lib/reviews.ts). */
export const MAX_REVIEW_BODY = 1000;

export const MAX_TOP_UP = 1000;

/**
 * A block of entries bought up front. One entry covers one booked hour, so a
 * 2-hour booking spends 2 — which keeps a pass worth exactly what it replaces.
 */
export interface Pass {
  id: number;
  code: string;
  venueId: number;
  venueName: string;
  /** null means any sport at that venue. */
  sport: Sport | null;
  /** A pack of lessons: pays whole lessons with this coach, and nothing else. Null: court time. */
  coachId?: number | null;
  coachName?: string | null;
  name: string;
  /**
   * How it is spent: `session` passes spend entries, `time` passes spend
   * minutes of court time (a time credit).
   */
  kind: PassKind;
  /**
   * A session pass: the minutes one entry covers, a booking spending one
   * entry per so many minutes or part of them; null, one entry a booking
   * whatever its length.
   */
  entryMinutes: number | null;
  /** The longest booking it may pay for, in minutes; null: any length. */
  maxMinutes: number | null;
  /**
   * What was sold, and what is left after spends and refunds: entries on a
   * session pass, minutes on a time pass.
   */
  entries: number;
  remaining: number;
  price: number;
  holderName: string;
  holderPhone: string;
  /** Inclusive — the pass is still good on this date. */
  expiresOn: string;
  status: PassStatus;
  createdAt: string;
  /** Why the pass cannot be spent right now, if it cannot. */
  unusableReason?: string;
}

export type PassStatus = "active" | "void";
export type PassKind = "session" | "time";

/** One movement of entries. Spends are negative, refunds positive. */
export interface PassEntry {
  id: number;
  delta: number;
  reason: string;
  bookingId: number | null;
  createdAt: string;
}

/** A discount a venue advertises, redeemed by typing its code. */
export interface PromoCode {
  id: number;
  code: string;
  venueId: number;
  venueName: string;
  /** null means any sport at that venue. */
  sport: Sport | null;
  description: string;
  kind: PromoKind;
  /** Percent 1–100, or whole ringgit off. */
  value: number;
  /** The smallest booking it applies to. */
  minHours: number;
  /** Inclusive dates the booking itself must fall within. */
  validFrom: string;
  validTo: string;
  /** null means unlimited. */
  maxUses: number | null;
  /** How many bookings one phone number may use it on; null means no limit. */
  maxPerCustomer: number | null;
  used: number;
  status: PromoStatus;
  /** Why it cannot be used today, if it cannot. */
  unusableReason?: string;
}

export type PromoKind = "percent" | "amount";
export type PromoStatus = "active" | "void";

/** Membership of one venue, entitling the holder to that venue's member rates. */
export interface Membership {
  id: number;
  code: string;
  venueId: number;
  venueName: string;
  holderName: string;
  holderPhone: string;
  /** Inclusive on both ends. */
  startsOn: string;
  expiresOn: string;
  price: number;
  status: MembershipStatus;
  /** Bought online on one of the venue's plans, rather than sold at the counter. */
  online?: boolean;
  /** The plan (tier) it is on, however it was sold: its benefits are the plan's (lib/membership-plans.ts). */
  tierId?: number | null;
  tierName?: string | null;
  /** The tier's benefits: this share of the public price, and how far ahead (null: the venue's). */
  ratePercent?: number | null;
  aheadDays?: number | null;
  /** Why it is not giving member rates today, if it is not. */
  unusableReason?: string;
}

export type MembershipStatus = "active" | "void";

/** How far ahead a membership may be sold. */
export const MAX_MEMBERSHIP_MONTHS = 24;

export const MAX_PROMO_PERCENT = 100;
export const MAX_PROMO_AMOUNT = 500;

/** What the kit looked like when it came back. */
export type HireCondition = "ok" | "damaged" | "lost";

export const HIRE_CONDITIONS: HireCondition[] = ["ok", "damaged", "lost"];

export const HIRE_CONDITION_LABELS: Record<HireCondition, string> = {
  ok: "Returned fine",
  damaged: "Damaged",
  lost: "Not returned",
};

/**
 * Kit handed over the counter against a deposit. The deposit is held at the
 * desk, not taken from the wallet, so these fields record the state of the
 * hold rather than a payment.
 */
export interface HireRecord {
  id: number;
  bookingId: number;
  bookingCode: string;
  courtId: number;
  courtName: string;
  venueId: number;
  /** What the customer's name was on the booking, for the open-hires list. */
  name: string;
  phone: string;
  deposit: number;
  takenAt: string;
  returnedAt: string | null;
  /** Kept back out of the deposit. null until the kit comes back. */
  withheld: number | null;
  condition: HireCondition | null;
  note: string | null;
}

/** The longest damage note staff may leave, so the column stays readable. */
export const MAX_HIRE_NOTE = 500;

export const MAX_PASS_ENTRIES = 200;
/** The most court time a time pass may hold: 500 hours. */
export const MAX_PASS_MINUTES = 500 * 60;
/** How far ahead a pass may be set to expire. */
export const MAX_PASS_MONTHS = 24;

export type WaitlistStatus = "waiting" | "offered" | "claimed" | "expired" | "cancelled";

/** Somebody queuing for a place that is currently full. */
export interface WaitlistEntry {
  id: number;
  classId: number | null;
  courtId: number | null;
  date: string | null;
  /** The time wanted, in minutes of the day, and the same in hours. */
  startMin: number | null;
  endMin: number | null;
  startHour: number | null;
  endHour: number | null;
  name: string;
  phone: string;
  status: WaitlistStatus;
  offeredAt: string | null;
  /** Only ever sent to the person holding the offer. */
  offerToken: string | null;
  /** The language they were reading when they joined. */
  locale: string;
  createdAt: string;
  /** Filled in for display. */
  label?: string;
  /** Seconds left to claim, when offered. */
  expiresInSeconds?: number;
}

/**
 * How long someone gets to claim a place before it passes to the next. The
 * offer message says "30 minutes" in so many words (msg.offer, and its
 * WhatsApp template): change them together.
 */
export const WAITLIST_OFFER_MINUTES = 30;

/**
 * One column of the booking board: `grid` minutes from `minute`. The board
 * draws time; what may be booked is the court's policy, and `starts` on its
 * CourtAvailability says where a booking may begin and how long it may run.
 */
export interface SlotInfo {
  /** Its start, in minutes of the day and in hours. */
  minute: number;
  hour: number;
  /** What this column of time costs, at the court's rates. */
  rate: number;
  /** A last-minute price: this percent off, for booking it now. */
  lastMinute?: number;
  /** In the venue's peak hours: an off-peak-only concession does not apply. */
  peak?: boolean;
  /** Nothing holds any of it (customers are not told why: a buffer, a booking, a block). */
  available: boolean;
  /** Some of it is held, not all (a booking from 18:07). */
  partly?: boolean;
  /** Places already taken, and the resource's total, for this hour. */
  booked: number;
  capacity: number;
  /** Set when a class has the resource this hour — enrol instead of booking. */
  className?: string;
  classId?: number;
  /** Closed by staff, so queuing for it would be pointless. */
  blocked?: boolean;
  /** Outside this court's hours that day (its own, or the venue's). */
  outside?: boolean;
  /**
   * Places out of service while others remain bookable — two kayaks of six in
   * for repair. Absent when the hour is fully blocked, which `blocked` says.
   */
  blockedPlaces?: number;
}

/** How full a shared facility is, for the crowd indicator. */
export type Busyness = "quiet" | "filling" | "busy" | "full";

export function busyness(booked: number, capacity: number): Busyness {
  if (capacity <= 0 || booked >= capacity) return "full";
  const ratio = booked / capacity;
  if (ratio < 0.4) return "quiet";
  if (ratio < 0.75) return "filling";
  return "busy";
}

export const BUSYNESS_LABELS: Record<Busyness, string> = {
  quiet: "Quiet",
  filling: "Filling up",
  busy: "Busy",
  full: "Full",
};

/** How many people are inside a resource right now, from door check-ins. */
export interface LiveOccupancy {
  courtId: number;
  courtName: string;
  sport: Sport;
  capacity: number;
  present: number;
  level: Busyness;
}

/** What a customer may pick on a court: its policy's rules, without its buffers. */
export interface PublicPolicy {
  startEvery: number;
  startOffset: number;
  startTimes: number[] | null;
  lengthStep: number;
  minLength: number;
  maxLength: number;
  lengths: number[] | null;
  defaultLength: number;
  noticeMinutes: number;
}

/** Where a booking may start on a court, and the longest it may run from there. */
export interface StartOption {
  minute: number;
  /** The longest booking from here that fits what is free and the court's hours. */
  maxLength: number;
}

export interface CourtAvailability {
  court: Court;
  /** The board's column width in hours (and `grid` in minutes): a display choice, from the policy. */
  unit: number;
  grid: number;
  policy: PublicPolicy;
  slots: SlotInfo[];
  /** Where a booking may start now, free and within the rules. */
  starts: StartOption[];
}

// The outer bounds any venue may trade within. Each venue sets its own
// open and close inside this range; these are the defaults and the
// limits the UI offers.
export const OPEN_HOUR = 0;
export const CLOSE_HOUR = 24;
/**
 * The latest a day's hours may run, into the next morning: 28 is 4 AM. Hours
 * past 24 belong to the day they started on (lib/week-hours.ts).
 */
export const LATEST_CLOSE_HOUR = 28;
export const DEFAULT_OPEN_HOUR = 8;
export const DEFAULT_CLOSE_HOUR = 23;
export const MAX_HOURS_PER_BOOKING = 4;
export const MAX_ADVANCE_DAYS = 14;
/** The furthest ahead a venue may choose to take bookings, for everybody or its members. */
export const MAX_VENUE_AHEAD_DAYS = 90;
// Weekly series may extend past the normal advance window; only the first
// session must fall inside it. Eight weeks unless the venue allows more
// (lib/house-rules.ts `seriesWeeks`), up to half a year.
export const MAX_RECUR_WEEKS = 8;
export const MAX_SERIES_WEEKS = 26;
/** The longest a venue may let one court be booked at a time, in hours. */
export const MAX_COURT_HOURS = 12;
/** The most players a per-player court takes in one booking, unless the venue says. */
export const DEFAULT_MAX_PLAYERS = 8;
export const MAX_PLAYERS = 50;
/** The most courts one person may book together at the same time. */
export const MAX_GROUP_COURTS = 6;
/** Customers may check in from this long before their slot until it ends. */
export const CHECK_IN_OPENS_MINUTES_BEFORE = 60;

/**
 * A refusal, in a shape a customer can be told about.
 *
 * `error` is the English sentence and is always there, so nothing that reads
 * it today breaks. `code` is the same refusal named rather than written, which
 * is what lets the page say it in the reader's language; `vars` fills whatever
 * the sentence quotes. A refusal with no code is one nothing has needed to
 * translate yet — it still shows, in English.
 */
export interface Refusal {
  ok: false;
  error: string;
  code?: ErrorCode;
  vars?: Record<string, string | number>;
}

/** The deposits a venue may take online to hold a booking, as a percent of the price (lib/holds.ts). */
export const DEPOSIT_PERCENTS = [10, 20, 25, 30, 40, 50] as const;

