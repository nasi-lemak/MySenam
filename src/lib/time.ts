import { MAX_ADVANCE_DAYS } from "./types";

const TZ = "Asia/Kuala_Lumpur";

/** Today's date (YYYY-MM-DD) in Malaysia time. */
export function todayISO(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
}

/** Current hour (0-23) in Malaysia time. */
export function currentHour(): number {
  const h = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    hour12: false,
  }).format(new Date());
  return parseInt(h, 10) % 24;
}

export function isValidDateString(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && !isNaN(Date.parse(`${date}T00:00:00Z`));
}

/** Day of week (0 = Sunday) for a YYYY-MM-DD string, timezone-independent. */
export function dayOfWeek(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function isWeekend(date: string): boolean {
  const d = dayOfWeek(date);
  return d === 0 || d === 6;
}

/** Peak pricing: all weekend hours, and weekday evenings from 18:00. */
export function isPeak(date: string, hour: number): boolean {
  return isWeekend(date) || hour >= 18;
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

/** Has this slot already started (or passed) in Malaysia time? */
export function isPastSlot(date: string, hour: number): boolean {
  const today = todayISO();
  if (date < today) return true;
  if (date > today) return false;
  return hour <= currentHour();
}

export function formatHour(hour: number): string {
  const h = hour % 24;
  const suffix = h >= 12 ? "PM" : "AM";
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}:00 ${suffix}`;
}
