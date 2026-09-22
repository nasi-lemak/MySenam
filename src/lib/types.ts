export type Sport =
  | "badminton"
  | "tennis"
  | "pickleball"
  | "futsal"
  | "gym"
  | "swimming";

export const SPORTS: Sport[] = [
  "badminton",
  "tennis",
  "pickleball",
  "futsal",
  "gym",
  "swimming",
];

export const SPORT_LABELS: Record<Sport, string> = {
  badminton: "Badminton",
  tennis: "Tennis",
  pickleball: "Pickleball",
  futsal: "Futsal",
  gym: "Gym",
  swimming: "Swimming",
};

export const SPORT_ICONS: Record<Sport, string> = {
  badminton: "🏸",
  tennis: "🎾",
  pickleball: "🥒",
  futsal: "⚽",
  gym: "🏋️",
  swimming: "🏊",
};

export interface Venue {
  id: number;
  name: string;
  area: string;
  address: string;
  phone: string;
  /** Customers may cancel until this many hours before the booking starts. */
  cancelCutoffHours: number;
}

export const DEFAULT_CANCEL_CUTOFF_HOURS = 2;
export const MAX_CANCEL_CUTOFF_HOURS = 72;

/**
 * A bookable resource. `capacity` 1 is a court held exclusively; greater than
 * 1 is a shared facility (gym floor, pool, class) where that many people can
 * hold the same hour.
 */
export interface Court {
  id: number;
  venueId: number;
  name: string;
  sport: Sport;
  offPeakRate: number;
  peakRate: number;
  capacity: number;
}

export const MAX_CAPACITY = 500;

export function isShared(court: Pick<Court, "capacity">): boolean {
  return court.capacity > 1;
}

export type BookingStatus = "confirmed" | "cancelled";
export type PaymentStatus = "unpaid" | "paid";

export interface Booking {
  id: number;
  code: string;
  courtId: number;
  date: string; // YYYY-MM-DD
  startHour: number;
  endHour: number; // exclusive
  name: string;
  phone: string;
  email: string | null;
  totalPrice: number;
  status: BookingStatus;
  createdAt: string;
  seriesCode: string | null;
  paymentStatus: PaymentStatus;
  paidAt: string | null;
  /** Set by staff after the slot passes and nobody turned up. */
  noShow: boolean;
  /** When the customer arrived at the desk, if they did. */
  checkedInAt: string | null;
  checkedOutAt: string | null;
  /** Secret behind the self check-in QR code. Never shown to other customers. */
  checkInToken: string | null;
  /** Set when this booking is an enrolment in an instructor-led class. */
  classId: number | null;
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
  startHour: number;
  endHour: number;
  capacity: number;
  /** Per person, for the whole session. */
  price: number;
  status: ClassStatus;
  seriesCode: string | null;
  enrolled: number;
}

export const MAX_CLASS_WEEKS = 12;

/** One movement of stored credit. The balance is the sum of these. */
export interface WalletEntry {
  id: number;
  amount: number;
  reason: string;
  bookingId: number | null;
  createdAt: string;
}

export const MAX_TOP_UP = 1000;

export interface SlotInfo {
  hour: number;
  rate: number;
  available: boolean;
  /** Places already taken, and the resource's total, for this hour. */
  booked: number;
  capacity: number;
  /** Set when a class has the resource this hour — enrol instead of booking. */
  className?: string;
  classId?: number;
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

export interface CourtAvailability {
  court: Court;
  slots: SlotInfo[];
}

// Operating hours: first bookable slot starts at OPEN_HOUR,
// last bookable slot starts at CLOSE_HOUR - 1.
export const OPEN_HOUR = 8;
export const CLOSE_HOUR = 23;
export const MAX_HOURS_PER_BOOKING = 4;
export const MAX_ADVANCE_DAYS = 14;
// Weekly series may extend past the normal advance window; only the first
// session must fall inside it.
export const MAX_RECUR_WEEKS = 8;
/** Customers may check in from this long before their slot until it ends. */
export const CHECK_IN_OPENS_MINUTES_BEFORE = 60;
