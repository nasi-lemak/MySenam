import { addDays, dayOfWeek } from "./time";
import { DAY_MINUTES, LATEST_MINUTE, formatMinute } from "./interval";

/**
 * Opening hours, weekday by weekday, in minutes from midnight (ADR 0010).
 *
 * A venue has its usual hours (`open_min`, `close_min`). A weekday can keep
 * them (null), have its own, or be closed (a closed weekday is treated as a
 * closure: lib/store.ts `getVenueClosure`). Index 0 is Sunday, as
 * `Date.getUTCDay()` counts. A court's booking policy may have hours of its
 * own in the same form (lib/booking-policy.ts).
 *
 * Hours may run past midnight: a close of 1560 is 2 AM the next morning, and
 * those minutes belong to the day they started on (a booking from 1 AM is on
 * the evening's date). They may not reach into the next day's own opening,
 * so the same moment can never belong to two days.
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
      return { open: Math.round(Number((d as { open: number }).open)), close: Math.round(Number((d as { close: number }).close)) };
    return null;
  });
  return week.every((d) => d === null) ? null : week;
}

/**
 * Hours set to apply from a date (migration 0252, ADR 0027): the venue's usual
 * hours and its week, as a whole, from `from` on. The venue's own columns are
 * the hours in force today; a change not yet in force waits here, and the
 * date asked about decides which applies (`hoursFor`).
 */
export interface HoursChange {
  id: number;
  /** The first business date it applies to. */
  from: string;
  openMin: number;
  closeMin: number;
  weekHours: WeekHours | null;
}

/** A venue's hours as stored: its current ones, and any set from a later date. */
export interface DatedHours {
  openMin: number;
  closeMin: number;
  weekHours?: WeekHours | null;
  /** Hours set from a date, soonest first (`venues.hours_changes`, kept by the database). */
  hoursChanges?: HoursChange[] | null;
}

/** The changes as the venue row lists them; anything unreadable counts as none. */
export function parseHoursChanges(raw: unknown): HoursChange[] {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const out: HoursChange[] = [];
  for (const c of value as Record<string, unknown>[]) {
    if (!c || typeof c.from !== "string" || !Number.isFinite(c.openMin) || !Number.isFinite(c.closeMin)) continue;
    out.push({
      id: Number(c.id),
      from: c.from,
      openMin: Number(c.openMin),
      closeMin: Number(c.closeMin),
      weekHours: parseWeekHours(c.weekHours ?? null),
    });
  }
  return out.sort((a, b) => a.from.localeCompare(b.from));
}

/** The change in force on a date: the latest from on or before it; none, and the current settings apply. */
export function changeOn<T extends { from: string }>(changes: T[] | null | undefined, date: string): T | null {
  let found: T | null = null;
  for (const c of changes ?? []) if (c.from <= date && (!found || c.from > found.from)) found = c;
  return found;
}

/** The usual hours and week that apply on a date: a change from on or before it, else the current ones. */
export function hoursFor(venue: DatedHours, date: string): { openMin: number; closeMin: number; weekHours: WeekHours | null } {
  const c = changeOn(venue.hoursChanges, date);
  if (c) return { openMin: c.openMin, closeMin: c.closeMin, weekHours: c.weekHours };
  return { openMin: venue.openMin, closeMin: venue.closeMin, weekHours: venue.weekHours ?? null };
}

/**
 * The hours as they stand today: the current ones, or a change already in
 * force that staff have not yet touched since (lib/dated-changes.ts makes it
 * the current settings then). Changes from later dates are kept.
 */
export function hoursToday<T extends DatedHours>(venue: T, today: string): T {
  const now = hoursFor(venue, today);
  return { ...venue, openMin: now.openMin, closeMin: now.closeMin, weekHours: now.weekHours };
}

/** A venue row's hours (its columns and `hours_changes`), as they stand on `today` where the venue is. */
export function storedHours(
  row: { open_min: number; close_min: number; week_hours?: string | null; hours_changes?: string | null },
  today: string
): DatedHours & { weekHours: WeekHours | null } {
  const stored = { openMin: row.open_min, closeMin: row.close_min, weekHours: parseWeekHours(row.week_hours), hoursChanges: parseHoursChanges(row.hours_changes) };
  return hoursToday(stored, today);
}

export interface HoursOn {
  openMin: number;
  closeMin: number;
  /** Shut that weekday every week. */
  closed: boolean;
}

/** The hours on one date, from the usual hours and the weekday's own, as set for that date (`hoursFor`). */
export function hoursOn(venue: DatedHours, date: string): HoursOn {
  const v = hoursFor(venue, date);
  const day = v.weekHours?.[dayOfWeek(date)] ?? null;
  if (day === "closed") return { openMin: v.openMin, closeMin: v.openMin, closed: true };
  if (day) return { openMin: day.open, closeMin: day.close, closed: false };
  return { openMin: v.openMin, closeMin: v.closeMin, closed: false };
}

/** Usual hours as given, checked: open before close, within midnight and 4 AM the next morning. */
export function validateUsualHours(openMin: unknown, closeMin: unknown): { ok: true } | { ok: false; error: string } {
  if (!Number.isInteger(openMin) || !Number.isInteger(closeMin)) return { ok: false, error: "Opening hours are whole minutes." };
  const open = openMin as number;
  const close = closeMin as number;
  if (open < 0 || open >= DAY_MINUTES || close > LATEST_MINUTE)
    return { ok: false, error: `Open from midnight, and close by ${formatMinute(LATEST_MINUTE)} the next morning at the latest.` };
  if (close - open < 60) return { ok: false, error: "A venue must be open for at least an hour." };
  return { ok: true };
}

/**
 * A week of hours as given, checked: each day opening before it closes,
 * within midnight to 4 AM the next morning, and no day's late hours running
 * into the next day's opening. null back means every day keeps the usual
 * hours.
 */
export function validateWeekHours(
  input: unknown,
  usual: { openMin: number; closeMin: number }
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
      if (open < 0 || open >= DAY_MINUTES || close > LATEST_MINUTE || close <= open)
        return { ok: false, error: `${WEEKDAYS[i]}: open before you close, and close by ${formatMinute(LATEST_MINUTE)} the next morning at the latest.` };
      week.push({ open, close });
    } else return { ok: false, error: `${WEEKDAYS[i]}: the usual hours, its own, or closed.` };
  }
  return checkOverlap(week.every((d) => d === null) ? null : week, usual);
}

function checkOverlap(week: WeekHours | null, usual: { openMin: number; closeMin: number }): { ok: true; week: WeekHours | null } | { ok: false; error: string } {
  const venue = { ...usual, weekHours: week };
  // A Sunday, so index i is weekday i.
  const sunday = "2026-01-04";
  for (let i = 0; i < 7; i++) {
    const today = hoursOn(venue, addDays(sunday, i));
    const tomorrow = hoursOn(venue, addDays(sunday, i + 1));
    if (today.closed || tomorrow.closed) continue;
    if (today.closeMin - DAY_MINUTES > tomorrow.openMin)
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
export function weekLines(venue: { openMin: number; closeMin: number; weekHours?: WeekHours | null }): {
  from: number;
  to: number;
  hours: { open: number; close: number } | "closed";
}[] {
  const order = [1, 2, 3, 4, 5, 6, 0];
  const sunday = "2026-01-04";
  const lines: { from: number; to: number; hours: { open: number; close: number } | "closed" }[] = [];
  for (const day of order) {
    // The week as given (a venue's current hours, or a change's), whatever is set from other dates.
    const on = hoursOn({ openMin: venue.openMin, closeMin: venue.closeMin, weekHours: venue.weekHours }, addDays(sunday, day));
    const hours = on.closed ? ("closed" as const) : { open: on.openMin, close: on.closeMin };
    const last = lines[lines.length - 1];
    const same =
      last && (last.hours === "closed" ? hours === "closed" : hours !== "closed" && last.hours.open === hours.open && last.hours.close === hours.close);
    if (same) last.to = day;
    else lines.push({ from: day, to: day, hours });
  }
  return lines;
}
