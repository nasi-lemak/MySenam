import { MAX_ADVANCE_DAYS } from "./types";
import { region } from "./region";

/**
 * Time zones. Every venue keeps its courts' times in its own wall-clock time:
 * a booking is "18:00 on the 4th" where the venue is. Its zone (an IANA name,
 * such as Asia/Kuala_Lumpur or America/New_York) turns that into a moment,
 * daylight saving and all. A venue with none set is in the install's.
 */
export function installZone(): string {
  return region().timeZone;
}

// Built once per zone. Constructing a formatter costs far more than using
// one, and isPastSlot asks for the date and hour once per court per hour — a
// search across every venue builds tens of thousands of them otherwise. Built
// on first use rather than at load, so the browser has its country by then.
const formats = new Map<string, { date: Intl.DateTimeFormat; clock: Intl.DateTimeFormat }>();
function formatters(zone: string) {
  let f = formats.get(zone);
  if (!f) {
    f = {
      date: new Intl.DateTimeFormat("en-CA", { timeZone: zone }),
      clock: new Intl.DateTimeFormat("en-GB", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }),
    };
    formats.set(zone, f);
  }
  return f;
}

/** Whether this is a time zone the runtime knows. */
export function isTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || !zone) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of a moment in a zone. */
function wallClock(at: Date, zone: string): { y: number; m: number; d: number; h: number; min: number; s: number } {
  const parts = Object.fromEntries(formatters(zone).clock.formatToParts(at).map((p) => [p.type, p.value]));
  return { y: +parts.year, m: +parts.month, d: +parts.day, h: +parts.hour % 24, min: +parts.minute, s: +parts.second };
}

/** How far ahead of UTC a zone is at a moment, in minutes (negative west of Greenwich). */
export function zoneOffsetMinutes(at: Date, zone: string): number {
  const w = wallClock(at, zone);
  return Math.round((Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s) - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** Today's date (YYYY-MM-DD) in a zone: the install's unless a venue's is given. */
export function todayISO(zone: string = installZone()): string {
  return formatters(zone).date.format(new Date());
}

/** The hour now (0-23) in a zone. */
export function currentHour(zone: string = installZone()): number {
  return wallClock(new Date(), zone).h;
}

/** The time now in a zone, in hours: 18.5 at 18:30. */
export function currentTime(zone: string = installZone()): number {
  const w = wallClock(new Date(), zone);
  return w.h + w.min / 60;
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

/** Is `date` within the bookable window (today .. today + MAX_ADVANCE_DAYS), where the venue is? */
export function isBookableDate(date: string, zone: string = installZone()): boolean {
  const today = todayISO(zone);
  return date >= today && date <= addDays(today, MAX_ADVANCE_DAYS);
}

/**
 * Has this slot already started (or passed), the venue's time? A slot is
 * under way from its first minute: 18:00 is past at 18:10, and 18:30 at 18:30.
 */
export function isPastSlot(date: string, hour: number, zone: string = installZone()): boolean {
  const today = todayISO(zone);
  if (date < today) return true;
  if (date > today) return false;
  return hour <= currentTime(zone);
}

/**
 * The moment a slot begins: `date` at `hour` (18.5 is 18:30) on the venue's
 * clock. Across a daylight-saving change the offset is the one in force at
 * that moment, not today's.
 */
export function slotStartsAt(date: string, hour: number, zone: string = installZone()): Date {
  const [y, m, d] = date.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d, 0, Math.round(hour * 60));
  // Guess with the offset at the wall time read as UTC, then once more with
  // the offset at the guess, which settles it either side of a change.
  let at = wall - zoneOffsetMinutes(new Date(wall), zone) * 60_000;
  at = wall - zoneOffsetMinutes(new Date(at), zone) * 60_000;
  return new Date(at);
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
export function hoursUntilSlot(date: string, hour: number, zone: string = installZone()): number {
  return (slotStartsAt(date, hour, zone).getTime() - Date.now()) / 3_600_000;
}

/** Is a customer still inside the free-cancellation window? */
export function isWithinCancelWindow(
  date: string,
  hour: number,
  cutoffHours: number,
  zone: string = installZone()
): boolean {
  return hoursUntilSlot(date, hour, zone) >= cutoffHours;
}

export function formatHour(hour: number): string {
  const whole = Math.floor(hour);
  const minutes = Math.round((hour - whole) * 60);
  const h = whole % 24;
  const suffix = h >= 12 ? "PM" : "AM";
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}:${String(minutes).padStart(2, "0")} ${suffix}`;
}
