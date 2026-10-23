import { getDb } from "./db";
import { DEFAULT_PEAK, isValidDateString, todayISO, type LastMinute, type PeakRules } from "./time";
import { venueZoneOf } from "./zones";
import { LATEST_MINUTE } from "./interval";
import { isMyState, publicHolidays } from "./holiday-calendar";
import { region } from "./region";

/**
 * Each venue's peak hours, weekend and holidays: when its courts' peak rates
 * apply. Courts keep their two rates; this decides which one an hour costs.
 */

/** Holidays a venue can list ahead at once: a year's worth and then some. */
export const MAX_HOLIDAYS = 60;

export interface Holiday {
  date: string;
  name: string;
}

interface Row {
  id: number;
  peak_weekday_from_min: number;
  peak_weekday_until_min: number;
  peak_weekend_days: string;
  peak_weekend_from_min: number;
  peak_weekend_until_min: number;
  last_minute_hours: number | null;
  last_minute_percent: number | null;
  last_minute_off_peak: number;
  time_zone: string | null;
  lat: number | null;
  lng: number | null;
}

const toRules = (row: Row, holidays: string[]): PeakRules => ({
  weekdayFrom: row.peak_weekday_from_min,
  weekdayUntil: row.peak_weekday_until_min,
  weekendDays: row.peak_weekend_days
    .split(",")
    .filter(Boolean)
    .map(Number),
  weekendFrom: row.peak_weekend_from_min,
  weekendUntil: row.peak_weekend_until_min,
  holidays,
  ...(row.last_minute_hours && row.last_minute_percent
    ? { lastMinute: { hours: row.last_minute_hours, percent: row.last_minute_percent, offPeakOnly: row.last_minute_off_peak === 1, zone: venueZoneOf(row) } }
    : {}),
});

/** The rules of several venues at once, for a search across them. A venue not found gets the default. */
export async function peakRulesFor(venueIds: number[]): Promise<Map<number, PeakRules>> {
  const ids = [...new Set(venueIds)];
  const out = new Map<number, PeakRules>();
  if (ids.length === 0) return out;
  const list = ids.map(() => "?").join(",");
  const db = getDb();
  const rows = (await db
    .prepare(
      `SELECT id, peak_weekday_from_min, peak_weekday_until_min, peak_weekend_days, peak_weekend_from_min, peak_weekend_until_min,
              last_minute_hours, last_minute_percent, last_minute_off_peak, time_zone, lat, lng
       FROM venues WHERE id IN (${list})`
    )
    .all(...ids)) as Row[];
  const holidays = (await db
    .prepare(`SELECT venue_id, date FROM venue_holidays WHERE venue_id IN (${list}) ORDER BY date`)
    .all(...ids)) as { venue_id: number; date: string }[];
  // Imported here, not at the top: lib/sport-rules.ts is read by modules this one is.
  const { sportPeaks } = await import("./sport-rules");
  const peaks = await sportPeaks(rows.map((r) => r.id));
  for (const row of rows) {
    const rules = toRules(row, holidays.filter((h) => h.venue_id === row.id).map((h) => h.date));
    const bySport = peaks.get(row.id);
    out.set(row.id, bySport ? { ...rules, bySport } : rules);
  }
  for (const id of ids) if (!out.has(id)) out.set(id, DEFAULT_PEAK);
  return out;
}

export async function peakRules(venueId: number): Promise<PeakRules> {
  return (await peakRulesFor([venueId])).get(venueId)!;
}

/** The holidays a venue has listed from today on, with their names, for its settings. */
export async function upcomingHolidays(venueId: number): Promise<Holiday[]> {
  return (await getDb()
    .prepare("SELECT date, name FROM venue_holidays WHERE venue_id = ? AND date >= ? ORDER BY date")
    .all(venueId, todayISO())) as Holiday[];
}

type Result<T> = { ok: true } & T | { ok: false; error: string };

/** A minute of the business day a peak window may start or end at: midnight to 4 AM the next morning. */
const isPeakMinute = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= LATEST_MINUTE;

/**
 * Set when peak applies: `{ weekdayFrom, weekdayUntil, weekendDays,
 * weekendFrom, weekendUntil }`, in minutes of the day (1050 is 17:30). A
 * window with the same start and end has no peak at all; 0 to 1440 is the
 * whole day. Prices of bookings already made stay as they are.
 */
export async function setPeakRules(venueId: number, input: Record<string, unknown>): Promise<Result<{ rules: PeakRules }>> {
  const { weekdayFrom, weekdayUntil, weekendFrom, weekendUntil, weekendDays } = input;
  if (!isPeakMinute(weekdayFrom) || !isPeakMinute(weekdayUntil) || !isPeakMinute(weekendFrom) || !isPeakMinute(weekendUntil))
    return { ok: false, error: "Peak times are whole minutes of the day, from midnight to 4 AM the next morning." };
  if (weekdayFrom > weekdayUntil || weekendFrom > weekendUntil)
    return { ok: false, error: "Peak hours end after they start." };
  if (
    !Array.isArray(weekendDays) ||
    weekendDays.length > 3 ||
    !weekendDays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)
  )
    return { ok: false, error: "The weekend is up to three days of the week." };
  const days = [...new Set(weekendDays as number[])].sort((a, b) => a - b);
  await getDb()
    .prepare(
      `UPDATE venues SET peak_weekday_from_min = ?, peak_weekday_until_min = ?, peak_weekend_days = ?,
         peak_weekend_from_min = ?, peak_weekend_until_min = ? WHERE id = ?`
    )
    .run(weekdayFrom, weekdayUntil, days.join(","), weekendFrom, weekendUntil, venueId);
  return { ok: true, rules: await peakRules(venueId) };
}

/**
 * Last-minute prices: `{ hours, percent, offPeakOnly }`, or `{ off: true }`.
 * Hours still free within `hours` (1–24) of starting cost `percent` (5–50)
 * less, for bookings made then; bookings already made keep their price.
 */
export async function setLastMinute(
  venueId: number,
  input: Record<string, unknown>
): Promise<Result<{ lastMinute: Omit<LastMinute, "zone"> | null }>> {
  if (input.off === true) {
    await getDb().prepare("UPDATE venues SET last_minute_hours = NULL, last_minute_percent = NULL WHERE id = ?").run(venueId);
    return { ok: true, lastMinute: null };
  }
  const { hours, percent } = input;
  if (typeof hours !== "number" || !Number.isInteger(hours) || hours < 1 || hours > 24)
    return { ok: false, error: "How close to the start: 1 to 24 hours." };
  if (typeof percent !== "number" || !Number.isInteger(percent) || percent < 5 || percent > 50)
    return { ok: false, error: "The discount is 5% to 50%." };
  const offPeakOnly = input.offPeakOnly !== false;
  await getDb()
    .prepare("UPDATE venues SET last_minute_hours = ?, last_minute_percent = ?, last_minute_off_peak = ? WHERE id = ?")
    .run(hours, percent, offPeakOnly ? 1 : 0, venueId);
  return { ok: true, lastMinute: { hours, percent, offPeakOnly } };
}

/** Price a date like the weekend. Naming a date already listed renames it. */
export async function addHoliday(venueId: number, input: { date?: unknown; name?: unknown }): Promise<Result<{ holiday: Holiday }>> {
  const date = typeof input.date === "string" ? input.date : "";
  if (!isValidDateString(date)) return { ok: false, error: "Pick a date." };
  if (date < todayISO()) return { ok: false, error: "That date has passed." };
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 60) : "";
  if (!name) return { ok: false, error: "Name the holiday, such as Hari Raya Aidilfitri." };
  const db = getDb();
  const listed = (await db
    .prepare("SELECT COUNT(*)::int AS n FROM venue_holidays WHERE venue_id = ? AND date >= ? AND date != ?")
    .get(venueId, todayISO(), date)) as { n: number };
  if (listed.n >= MAX_HOLIDAYS) return { ok: false, error: `Up to ${MAX_HOLIDAYS} holidays ahead. Remove one first.` };
  await db
    .prepare(
      `INSERT INTO venue_holidays (venue_id, date, name) VALUES (?, ?, ?)
       ON CONFLICT (venue_id, date) DO UPDATE SET name = EXCLUDED.name`
    )
    .run(venueId, date, name);
  return { ok: true, holiday: { date, name } };
}

/**
 * Every public holiday still to come from the gazetted list (lib/holiday-calendar.ts):
 * in Malaysia, the state's own as well, or with `state` "" only the days every
 * state keeps. Days the venue listed already keep their own names; it stops at
 * the most a venue may list.
 */
export async function fillHolidays(venueId: number, state: unknown): Promise<Result<{ added: number }>> {
  const country = region().country;
  if (country === "MY" && state !== "" && !isMyState(state)) return { ok: false, error: "Choose the venue's state." };
  const db = getDb();
  const today = todayISO();
  const listed = (await db.prepare("SELECT COUNT(*)::int AS n FROM venue_holidays WHERE venue_id = ? AND date >= ?").get(venueId, today)) as {
    n: number;
  };
  let room = MAX_HOLIDAYS - listed.n;
  let added = 0;
  for (const h of publicHolidays(country, isMyState(state) ? state : null, today)) {
    if (room <= 0) break;
    const done = await db
      .prepare("INSERT INTO venue_holidays (venue_id, date, name) VALUES (?, ?, ?) ON CONFLICT (venue_id, date) DO NOTHING")
      .run(venueId, h.date, h.name);
    if (done.changes > 0) {
      added++;
      room--;
    }
  }
  return { ok: true, added };
}

export async function removeHoliday(venueId: number, date: string): Promise<boolean> {
  const info = await getDb().prepare("DELETE FROM venue_holidays WHERE venue_id = ? AND date = ?").run(venueId, date);
  return info.changes > 0;
}
