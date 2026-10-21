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
  /**
   * How long one of the venue's slots is, in hours: 1, or 0.5 where it sells
   * by the half hour. A slot costs its share of the hourly rate.
   */
  slotHours?: number;
}

export const DEFAULT_PEAK: PeakRules = {
  weekdayFrom: 18,
  weekdayUntil: 24,
  weekendDays: [0, 6],
  weekendFrom: 0,
  weekendUntil: 24,
  holidays: [],
  slotHours: 1,
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

/**
 * Has this slot already started (or passed), local time? A slot is under way
 * from its first minute: 18:00 is past at 18:10, and 18:30 at 18:30.
 */
export function isPastSlot(date: string, hour: number): boolean {
  const today = todayISO();
  if (date < today) return true;
  if (date > today) return false;
  // The minutes are the same in UTC as here: Malaysia and Singapore are whole hours ahead.
  return hour <= currentHour() + new Date().getUTCMinutes() / 60;
}

/** The UTC instant at which a slot (local time) begins. 18.5 is 18:30. */
export function slotStartsAt(date: string, hour: number): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, Math.round((hour - region().utcOffsetHours) * 60)));
}

/** A slot's length in hours: 1 by the hour, 0.5 by the half hour. */
export const slotHours = (slotMinutes: number) => slotMinutes / 60;

/** The slots from `start` up to `end`, each `step` hours long: 18, 18.5, 19… */
export function slotsBetween(start: number, end: number, step = 1): number[] {
  const out: number[] = [];
  for (let i = 0; start + i * step < end - 1e-9; i++) out.push(start + i * step);
  return out;
}

/** Whether these slot starts follow on from each other without a gap. */
export function consecutive(hours: number[], step = 1): boolean {
  return hours.every((h, i) => i === 0 || Math.abs(h - hours[i - 1] - step) < 1e-9);
}

/** Whether a time falls on a slot boundary: any hour, or the half hour where slots are halves. */
export function onSlot(hour: number, step = 1): boolean {
  return Number.isFinite(hour) && Math.abs(hour / step - Math.round(hour / step)) < 1e-9;
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
  const whole = Math.floor(hour);
  const minutes = Math.round((hour - whole) * 60);
  const h = whole % 24;
  const suffix = h >= 12 ? "PM" : "AM";
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}:${String(minutes).padStart(2, "0")} ${suffix}`;
}
