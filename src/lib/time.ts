import { MAX_ADVANCE_DAYS } from "./types";
import { region } from "./region";

// Built once per zone. Constructing a formatter costs far more than using
// one, and isPastSlot asks for the date and hour once per court per hour — a
// search across every venue builds tens of thousands of them otherwise. Built
// on first use rather than at load, so the browser has its country by then.
let formats: { zone: string; date: Intl.DateTimeFormat; hour: Intl.DateTimeFormat } | null = null;
function formatters() {
  const zone = region().timeZone;
  if (formats?.zone !== zone)
    formats = {
      zone,
      date: new Intl.DateTimeFormat("en-CA", { timeZone: zone }),
      hour: new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", hour12: false }),
    };
  return formats;
}

/** Today's date (YYYY-MM-DD) in the install's time zone. */
export function todayISO(): string {
  return formatters().date.format(new Date());
}

/** Current hour (0-23) in the install's time zone. */
export function currentHour(): number {
  return parseInt(formatters().hour.format(new Date()), 10) % 24;
}

export function isValidDateString(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && !isNaN(Date.parse(`${date}T00:00:00Z`));
}

/** Day of week (0 = Sunday) for a YYYY-MM-DD string, timezone-independent. */
export function dayOfWeek(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/**
 * When a venue's peak rate applies. Each venue sets its own (migration 0038);
 * the default is weekday evenings from 18:00 and all weekend.
 */
export interface PeakRules {
  /** Peak on a working day from this hour until `weekdayUntil`. The same hour twice: no peak. */
  weekdayFrom: number;
  weekdayUntil: number;
  /** The days (0 = Sunday) priced as the weekend: Friday and Saturday in some states. */
  weekendDays: number[];
  weekendFrom: number;
  weekendUntil: number;
  /** Dates priced as the weekend: public, school and festive holidays. */
  holidays: string[];
}

export const DEFAULT_PEAK: PeakRules = {
  weekdayFrom: 18,
  weekdayUntil: 24,
  weekendDays: [0, 6],
  weekendFrom: 0,
  weekendUntil: 24,
  holidays: [],
};

/** Is the hour starting at `hour` on `date` priced at the peak rate? */
export function isPeak(date: string, hour: number, rules: PeakRules = DEFAULT_PEAK): boolean {
  const weekend = rules.weekendDays.includes(dayOfWeek(date)) || rules.holidays.includes(date);
  return weekend
    ? hour >= rules.weekendFrom && hour < rules.weekendUntil
    : hour >= rules.weekdayFrom && hour < rules.weekdayUntil;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Is `date` within the bookable window (today .. today + MAX_ADVANCE_DAYS)? */
export function isBookableDate(date: string): boolean {
  const today = todayISO();
  return date >= today && date <= addDays(today, MAX_ADVANCE_DAYS);
}

/** Has this slot already started (or passed), local time? */
export function isPastSlot(date: string, hour: number): boolean {
  const today = todayISO();
  if (date < today) return true;
  if (date > today) return false;
  return hour <= currentHour();
}

/** The UTC instant at which a slot (local time) begins. */
export function slotStartsAt(date: string, hour: number): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hour - region().utcOffsetHours));
}

/** Hours from now until a slot starts; negative once it has begun. */
export function hoursUntilSlot(date: string, hour: number): number {
  return (slotStartsAt(date, hour).getTime() - Date.now()) / 3_600_000;
}

/** Is a customer still inside the free-cancellation window? */
export function isWithinCancelWindow(
  date: string,
  hour: number,
  cutoffHours: number
): boolean {
  return hoursUntilSlot(date, hour) >= cutoffHours;
}

export function formatHour(hour: number): string {
  const h = hour % 24;
  const suffix = h >= 12 ? "PM" : "AM";
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}:00 ${suffix}`;
}
