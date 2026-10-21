import { getDb } from "./db";
import { DEFAULT_PEAK, isValidDateString, todayISO, type PeakRules } from "./time";

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
  peak_weekday_from: number;
  peak_weekday_until: number;
  peak_weekend_days: string;
  peak_weekend_from: number;
  peak_weekend_until: number;
}

const toRules = (row: Row, holidays: string[]): PeakRules => ({
  weekdayFrom: row.peak_weekday_from,
  weekdayUntil: row.peak_weekday_until,
  weekendDays: row.peak_weekend_days
    .split(",")
    .filter(Boolean)
    .map(Number),
  weekendFrom: row.peak_weekend_from,
  weekendUntil: row.peak_weekend_until,
  holidays,
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
      `SELECT id, peak_weekday_from, peak_weekday_until, peak_weekend_days, peak_weekend_from, peak_weekend_until
       FROM venues WHERE id IN (${list})`
    )
    .all(...ids)) as Row[];
  const holidays = (await db
    .prepare(`SELECT venue_id, date FROM venue_holidays WHERE venue_id IN (${list}) ORDER BY date`)
    .all(...ids)) as { venue_id: number; date: string }[];
  for (const row of rows)
    out.set(row.id, toRules(row, holidays.filter((h) => h.venue_id === row.id).map((h) => h.date)));
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

const isHour = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 24;

/**
 * Set when peak applies: `{ weekdayFrom, weekdayUntil, weekendDays,
 * weekendFrom, weekendUntil }`. A window with the same start and end has no
 * peak at all; 0 to 24 is the whole day. Prices of bookings already made
 * stay as they are.
 */
export async function setPeakRules(venueId: number, input: Record<string, unknown>): Promise<Result<{ rules: PeakRules }>> {
  const { weekdayFrom, weekdayUntil, weekendFrom, weekendUntil, weekendDays } = input;
  if (!isHour(weekdayFrom) || !isHour(weekdayUntil) || !isHour(weekendFrom) || !isHour(weekendUntil))
    return { ok: false, error: "Peak hours run from a whole hour, 0 to 24." };
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
      `UPDATE venues SET peak_weekday_from = ?, peak_weekday_until = ?, peak_weekend_days = ?,
         peak_weekend_from = ?, peak_weekend_until = ? WHERE id = ?`
    )
    .run(weekdayFrom, weekdayUntil, days.join(","), weekendFrom, weekendUntil, venueId);
  return { ok: true, rules: await peakRules(venueId) };
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

export async function removeHoliday(venueId: number, date: string): Promise<boolean> {
  const info = await getDb().prepare("DELETE FROM venue_holidays WHERE venue_id = ? AND date = ?").run(venueId, date);
  return info.changes > 0;
}
