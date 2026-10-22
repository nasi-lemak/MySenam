import { addDays, dayOfWeek } from "./time";
import { LATEST_CLOSE_HOUR, OPEN_HOUR } from "./types";

/**
 * A venue's hours, weekday by weekday.
 *
 * Each venue has its usual hours (`open_hour`, `close_hour`). A weekday can
 * keep them (null), have its own, or be closed (a closed weekday is treated
 * as a closure: lib/store.ts `getVenueClosure`). Index 0 is Sunday, as
 * `Date.getUTCDay()` counts.
 *
 * Hours may run past midnight: a close of 26 is 2 AM the next morning, and
 * those hours belong to the day they started on (a booking from 1 AM is on
 * the evening's date). They may not reach into the next day's own opening,
 * so the same moment can never be two slots.
 */

export type DayHours = { open: number; close: number } | "closed" | null;
export type WeekHours = DayHours[];

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** What is stored, made safe to use: seven entries, or null when every day keeps the usual hours. */
export function parseWeekHours(raw: unknown): WeekHours | null {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(value) || value.length !== 7) return null;
  const week = value.map((d): DayHours => {
    if (d === "closed") return "closed";
    if (d && typeof d === "object" && Number.isFinite((d as { open: unknown }).open) && Number.isFinite((d as { close: unknown }).close))
      return { open: Number((d as { open: number }).open), close: Number((d as { close: number }).close) };
    return null;
  });
  return week.every((d) => d === null) ? null : week;
}

export interface HoursOn {
  openHour: number;
  closeHour: number;
  /** Shut that weekday every week. */
  closed: boolean;
}

/** The hours on one date, from the usual hours and the weekday's own. */
export function hoursOn(venue: { openHour: number; closeHour: number; weekHours?: WeekHours | null }, date: string): HoursOn {
  const day = venue.weekHours?.[dayOfWeek(date)] ?? null;
  if (day === "closed") return { openHour: venue.openHour, closeHour: venue.openHour, closed: true };
  if (day) return { openHour: day.open, closeHour: day.close, closed: false };
  return { openHour: venue.openHour, closeHour: venue.closeHour, closed: false };
}

/**
 * A week of hours as given, checked: each day open at least an hour, within
 * midnight to LATEST_CLOSE_HOUR, on whole hours, and no day's late hours
 * running into the next day's opening. null back means every day keeps the
 * usual hours.
 */
export function validateWeekHours(
  input: unknown,
  usual: { openHour: number; closeHour: number }
): { ok: true; week: WeekHours | null } | { ok: false; error: string } {
  if (input === null || input === undefined) return checkOverlap(null, usual);
  if (!Array.isArray(input) || input.length !== 7) return { ok: false, error: "Give seven days, Sunday first." };
  const week: WeekHours = [];
  for (let i = 0; i < 7; i++) {
    const d = input[i];
    if (d === null || d === undefined || d === "usual") week.push(null);
    else if (d === "closed") week.push("closed");
    else if (typeof d === "object" && Number.isInteger((d as { open: unknown }).open) && Number.isInteger((d as { close: unknown }).close)) {
      const { open, close } = d as { open: number; close: number };
      if (open < OPEN_HOUR || open > 23 || close > LATEST_CLOSE_HOUR || close - open < 1)
        return { ok: false, error: `${WEEKDAYS[i]}: open on the hour, at least an hour, and close by ${LATEST_CLOSE_HOUR - 24} AM the next morning at the latest.` };
      week.push({ open, close });
    } else return { ok: false, error: `${WEEKDAYS[i]}: the usual hours, its own, or closed.` };
  }
  return checkOverlap(week.every((d) => d === null) ? null : week, usual);
}

function checkOverlap(week: WeekHours | null, usual: { openHour: number; closeHour: number }): { ok: true; week: WeekHours | null } | { ok: false; error: string } {
  const venue = { ...usual, weekHours: week };
  // A Sunday, so index i is weekday i.
  const sunday = "2026-01-04";
  for (let i = 0; i < 7; i++) {
    const today = hoursOn(venue, addDays(sunday, i));
    const tomorrow = hoursOn(venue, addDays(sunday, i + 1));
    if (today.closed || tomorrow.closed) continue;
    if (today.closeHour - 24 > tomorrow.openHour)
      return { ok: false, error: `${WEEKDAYS[i]} runs past ${WEEKDAYS[(i + 1) % 7]}'s opening. Close earlier, or open ${WEEKDAYS[(i + 1) % 7]} later.` };
  }
  return { ok: true, week };
}

/** Whether any day differs from the usual hours, for showing the week rather than one line. */
export function variesByDay(week: WeekHours | null | undefined): boolean {
  return !!week && week.some((d) => d !== null);
}

/**
 * The week as lines for a page, Monday first, runs of days with the same
 * hours together: Mon–Fri 4 PM–12 AM, Sat–Sun 7 AM–12 AM, or a day closed.
 */
export function weekLines(venue: { openHour: number; closeHour: number; weekHours?: WeekHours | null }): {
  from: number;
  to: number;
  hours: { open: number; close: number } | "closed";
}[] {
  const order = [1, 2, 3, 4, 5, 6, 0];
  const sunday = "2026-01-04";
  const lines: { from: number; to: number; hours: { open: number; close: number } | "closed" }[] = [];
  for (const day of order) {
    const on = hoursOn(venue, addDays(sunday, day));
    const hours = on.closed ? ("closed" as const) : { open: on.openHour, close: on.closeHour };
    const last = lines[lines.length - 1];
    const same =
      last && (last.hours === "closed" ? hours === "closed" : hours !== "closed" && last.hours.open === hours.open && last.hours.close === hours.close);
    if (same) last.to = day;
    else lines.push({ from: day, to: day, hours });
  }
  return lines;
}
