import { MAX_ADVANCE_DAYS } from "./types.ts";
import { region } from "./region.ts";

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

/** The date (YYYY-MM-DD) in a zone of a stored moment: an ISO time, or the database's UTC "YYYY-MM-DD HH:MM:SS". */
export function localDateOf(stamp: string, zone: string = installZone()): string {
  const at = new Date(/[TZ+]/.test(stamp.slice(10)) ? stamp : `${stamp.replace(" ", "T")}Z`);
  return formatters(zone).date.format(at);
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
 * When a venue's peak rate applies. Each venue sets its own; the default is
 * weekday evenings from 18:00 and all weekend. Times are minutes of the
 * business day (ADR 0010), so a peak can start at 17:30 or 17:45.
 */
export interface PeakRules {
  /** Peak on a working day from this minute until `weekdayUntil`. The same minute twice: no peak. */
  weekdayFrom: number;
  weekdayUntil: number;
  /** The days (0 = Sunday) priced as the weekend: Friday and Saturday in some states. */
  weekendDays: number[];
  weekendFrom: number;
  weekendUntil: number;
  /** Dates priced as the weekend: public, school and festive holidays. */
  holidays: string[];
  /**
   * Last-minute prices: time starting within `hours` of now costs `percent`
   * less, for a booking made now; only off-peak time where `offPeakOnly`.
   * Times are the venue's, in `zone`. Null: none.
   */
  lastMinute?: LastMinute | null;
  /** A sport's own peak window here, over the venue's (lib/sport-rules.ts); applied by `forSport`. */
  bySport?: Record<string, { weekdayFrom: number; weekdayUntil: number; weekendFrom: number; weekendUntil: number }>;
}

/** The rules as they apply to one sport: its own peak window where it has one. */
export function forSport(rules: PeakRules, sport: string): PeakRules {
  const own = rules.bySport?.[sport];
  return own ? { ...rules, ...own, bySport: undefined } : rules;
}

export interface LastMinute {
  hours: number;
  percent: number;
  offPeakOnly: boolean;
  zone: string;
}

export const DEFAULT_PEAK: PeakRules = {
  weekdayFrom: 18 * 60,
  weekdayUntil: 24 * 60,
  weekendDays: [0, 6],
  weekendFrom: 0,
  weekendUntil: 24 * 60,
  holidays: [],
};

/** The peak window on a date: the weekend's on weekend days and holidays, else the weekday's. */
export function peakWindow(date: string, rules: PeakRules = DEFAULT_PEAK): { from: number; until: number } {
  const weekend = rules.weekendDays.includes(dayOfWeek(date)) || rules.holidays.includes(date);
  return weekend ? { from: rules.weekendFrom, until: rules.weekendUntil } : { from: rules.weekdayFrom, until: rules.weekdayUntil };
}

/** Is minute `minute` of `date` at the peak rate? */
export function isPeakMinute(date: string, minute: number, rules: PeakRules = DEFAULT_PEAK): boolean {
  const w = peakWindow(date, rules);
  return minute >= w.from && minute < w.until;
}

/**
 * The last-minute discount (percent) on time starting at minute `minute` of
 * `date`, for a booking made at `at`; 0 when none applies.
 */
export function lastMinuteOffAt(date: string, minute: number, rules: PeakRules, at: number): number {
  const lm = rules.lastMinute;
  if (!lm) return 0;
  if (lm.offPeakOnly && isPeakMinute(date, minute, rules)) return 0;
  const until = slotStartsAt(date, minute / 60, lm.zone).getTime() - at;
  return until > 0 && until <= lm.hours * 3_600_000 ? lm.percent : 0;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Is `date` within the bookable window (today .. today + `ahead` days, the
 * site's by default, or the venue's: lib/house-rules.ts), where the venue is?
 */
export function isBookableDate(date: string, zone: string = installZone(), ahead: number = MAX_ADVANCE_DAYS): boolean {
  const today = todayISO(zone);
  return date >= today && date <= addDays(today, ahead);
}

/**
 * Has this slot already started (or passed), the venue's time? A slot is
 * under way from its first minute: 18:00 is past at 18:10, and 18:30 at 18:30.
 */
export function isPastSlot(date: string, hour: number, zone: string = installZone()): boolean {
  const today = todayISO(zone);
  if (date > today) return false;
  if (date === today && hour < 24) return hour <= currentTime(zone);
  // Yesterday's hours after midnight (hour 25 is 1 AM today) are worked out to the minute.
  if (hour >= 24 && date >= addDays(today, -2)) return slotStartsAt(date, hour, zone).getTime() <= Date.now();
  return date < today || hour <= currentTime(zone);
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
