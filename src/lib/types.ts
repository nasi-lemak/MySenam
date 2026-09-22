export type Sport = "badminton" | "tennis" | "pickleball" | "futsal";

export const SPORTS: Sport[] = ["badminton", "tennis", "pickleball", "futsal"];

export const SPORT_LABELS: Record<Sport, string> = {
  badminton: "Badminton",
  tennis: "Tennis",
  pickleball: "Pickleball",
  futsal: "Futsal",
};

export const SPORT_ICONS: Record<Sport, string> = {
  badminton: "🏸",
  tennis: "🎾",
  pickleball: "🥒",
  futsal: "⚽",
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

export interface Court {
  id: number;
  venueId: number;
  name: string;
  sport: Sport;
  offPeakRate: number;
  peakRate: number;
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
}

export interface SlotInfo {
  hour: number;
  rate: number;
  available: boolean;
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
