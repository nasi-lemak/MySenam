import { getDb, isUniqueViolation, withTransaction } from "./db";
import { errorText, translator, type ErrorCode } from "./i18n";
import { isAmount, money, roundMoney } from "./region";
import { addDays, isPastSlot, isValidDateString, SLOT, slotsBetween, todayISO } from "./time";
import { SPORTS, type Refusal, type Sport } from "./types";

/**
 * One-to-one coaching. A venue lists its coaches, what each coaches, their
 * fee for an hour and the hours they take lessons. A customer books a lesson
 * the way they book a court, with a coach on it: the court is picked for
 * them, and the coach's fee goes on top of its price, so paying, cancelling,
 * receipts and reports all work as for any booking.
 *
 * A coach is in one place at a time. Each lesson writes a row per slot into
 * `coach_slots`, keyed on the coach and the time, so two lessons cannot take
 * the same coach at once. A cancelled lesson's rows are cleared when it is
 * cancelled, or found stale and cleared by the next booking that wants the time.
 */

export interface CoachHours {
  /** 0 is Sunday. */
  weekday: number;
  from: number;
  until: number;
}

export interface Coach {
  id: number;
  venueId: number;
  name: string;
  bio: string | null;
  sports: Sport[];
  rate: number;
  active: boolean;
  hours: CoachHours[];
  /** Days off, from today on: no lessons booked then. */
  timeOff: CoachTimeOff[];
}

export interface CoachTimeOff {
  id: number;
  from: string;
  until: string;
  reason: string | null;
}

const ENGLISH = translator("en");
function refuse(code: ErrorCode, vars?: Record<string, string | number>): Refusal {
  return { ok: false, error: errorText(ENGLISH, code, vars), code, ...(vars ? { vars } : {}) };
}

interface CoachRow {
  id: number;
  venue_id: number;
  name: string;
  bio: string | null;
  sports: string;
  rate: number | string;
  active: number;
}

async function withHours(rows: CoachRow[]): Promise<Coach[]> {
  if (rows.length === 0) return [];
  const hours = (await getDb()
    .prepare(`SELECT coach_id, weekday, from_hour, until_hour FROM coach_hours WHERE coach_id IN (${rows.map(() => "?").join(",")}) ORDER BY weekday, from_hour`)
    .all(...rows.map((r) => r.id))) as { coach_id: number; weekday: number; from_hour: number; until_hour: number }[];
  const off = (await getDb()
    .prepare(
      `SELECT id, coach_id, from_date, until_date, reason FROM coach_time_off
        WHERE coach_id IN (${rows.map(() => "?").join(",")}) AND until_date >= ? ORDER BY from_date`
    )
    .all(...rows.map((r) => r.id), addDays(todayISO(), -1))) as { id: number; coach_id: number; from_date: string; until_date: string; reason: string | null }[];
  return rows.map((r) => ({
    id: r.id,
    venueId: r.venue_id,
    name: r.name,
    bio: r.bio,
    sports: r.sports.split(",").filter((s): s is Sport => SPORTS.includes(s as Sport)),
    rate: Number(r.rate),
    active: r.active === 1,
    hours: hours
      .filter((h) => h.coach_id === r.id)
      .map((h) => ({ weekday: h.weekday, from: Number(h.from_hour), until: Number(h.until_hour) })),
    timeOff: off.filter((o) => o.coach_id === r.id).map((o) => ({ id: o.id, from: o.from_date, until: o.until_date, reason: o.reason })),
  }));
}

export async function listCoaches(venueId: number, opts: { activeOnly?: boolean } = {}): Promise<Coach[]> {
  const rows = (await getDb()
    .prepare(`SELECT * FROM coaches WHERE venue_id = ?${opts.activeOnly ? " AND active = 1" : ""} ORDER BY active DESC, name`)
    .all(venueId)) as CoachRow[];
  return withHours(rows);
}

export async function coachById(id: number): Promise<Coach | null> {
  const row = (await getDb().prepare("SELECT * FROM coaches WHERE id = ?").get(id)) as CoachRow | undefined;
  return row ? (await withHours([row]))[0] : null;
}

export interface CoachInput {
  name: unknown;
  bio?: unknown;
  sports: unknown;
  rate: unknown;
  hours: unknown;
}

function readInput(input: CoachInput): { ok: true; value: { name: string; bio: string | null; sports: Sport[]; rate: number; hours: CoachHours[] } } | { ok: false; error: string } {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length < 2 || name.length > 80) return { ok: false, error: "Give the coach's name." };
  const bio = typeof input.bio === "string" && input.bio.trim() !== "" ? input.bio.trim().slice(0, 500) : null;
  const sports = Array.isArray(input.sports) ? [...new Set(input.sports.filter((s): s is Sport => SPORTS.includes(s as Sport)))] : [];
  if (sports.length === 0) return { ok: false, error: "Choose at least one sport they coach." };
  if (!isAmount(input.rate, 0, 2000)) return { ok: false, error: `Their fee for an hour: ${money(0)} to ${money(2000)}.` };
  const hours = readHours(input.hours);
  if (typeof hours === "string") return { ok: false, error: hours };
  return { ok: true, value: { name, bio, sports, rate: roundMoney(input.rate as number), hours } };
}

/** Weekly stretches of lesson hours as given, checked; or why not. */
function readHours(raw: unknown): CoachHours[] | string {
  if (!Array.isArray(raw)) return "Give the hours they take lessons.";
  if (raw.length > 28) return "At most 28 stretches of hours in a week.";
  const hours: CoachHours[] = [];
  for (const h of raw as Record<string, unknown>[]) {
    const weekday = Number(h?.weekday);
    const from = Number(h?.from);
    const until = Number(h?.until);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6 || !(from >= 0 && until <= 24 && from < until) || from * 2 !== Math.round(from * 2) || until * 2 !== Math.round(until * 2))
      return "Each stretch of hours needs a day, and a start before its end, on the hour or half hour.";
    hours.push({ weekday, from, until });
  }
  return hours;
}

/**
 * The coach's own week, set at their private link (lib/coach-schedule.ts):
 * the hours they take lessons. Lessons already booked stand.
 */
export async function setCoachHours(coachId: number, raw: unknown): Promise<{ ok: true; coach: Coach } | { ok: false; error: string }> {
  const hours = readHours(raw);
  if (typeof hours === "string") return { ok: false, error: hours };
  return withTransaction(async () => {
    const db = getDb();
    await db.prepare("DELETE FROM coach_hours WHERE coach_id = ?").run(coachId);
    for (const h of hours)
      await db.prepare("INSERT INTO coach_hours (coach_id, weekday, from_hour, until_hour) VALUES (?, ?, ?, ?)").run(coachId, h.weekday, h.from, h.until);
    await db.prepare("UPDATE coaches SET self_changed_at = datetime('now') WHERE id = ?").run(coachId);
    return { ok: true as const, coach: (await coachById(coachId))! };
  });
}

/** Days off for a coach, from today on, up to a year away. What they already have booked then is said, for the venue to move. */
export async function addTimeOff(
  coachId: number,
  input: { from?: unknown; until?: unknown; reason?: unknown }
): Promise<{ ok: true; coach: Coach; clashes: number } | { ok: false; error: string }> {
  const from = typeof input.from === "string" ? input.from : "";
  const until = typeof input.until === "string" && input.until ? input.until : from;
  if (!isValidDateString(from) || !isValidDateString(until)) return { ok: false, error: "Give the first and last day off." };
  if (until < from) return { ok: false, error: "The last day is before the first." };
  if (from < todayISO() || until > addDays(todayISO(), 366)) return { ok: false, error: "Time off runs from today, up to a year ahead." };
  const reason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim().slice(0, 120) : null;
  const db = getDb();
  if (((await db.prepare("SELECT COUNT(*)::int AS n FROM coach_time_off WHERE coach_id = ? AND until_date >= ?").get(coachId, todayISO())) as { n: number }).n >= 20)
    return { ok: false, error: "At most 20 stretches of time off ahead." };
  await db.prepare("INSERT INTO coach_time_off (coach_id, from_date, until_date, reason) VALUES (?, ?, ?, ?)").run(coachId, from, until, reason);
  await db.prepare("UPDATE coaches SET self_changed_at = datetime('now') WHERE id = ?").run(coachId);
  const clashes = (await db
    .prepare(
      `SELECT COUNT(*)::int AS n FROM bookings WHERE coach_id = ? AND status = 'confirmed' AND date >= ? AND date <= ?`
    )
    .get(coachId, from, until)) as { n: number };
  return { ok: true, coach: (await coachById(coachId))!, clashes: clashes.n };
}

export async function removeTimeOff(coachId: number, id: number): Promise<boolean> {
  const done = await getDb().prepare("DELETE FROM coach_time_off WHERE id = ? AND coach_id = ?").run(id, coachId);
  return done.changes === 1;
}

/** Add a coach (no `id`) or change one. */
export async function saveCoach(venueId: number, input: CoachInput & { id?: unknown }): Promise<{ ok: true; coach: Coach } | { ok: false; error: string }> {
  const read = readInput(input);
  if (!read.ok) return read;
  const { name, bio, sports, rate, hours } = read.value;
  return withTransaction(async () => {
    const db = getDb();
    let id: number;
    if (input.id !== undefined && input.id !== null) {
      const done = await db
        .prepare("UPDATE coaches SET name = ?, bio = ?, sports = ?, rate = ?, active = 1 WHERE id = ? AND venue_id = ?")
        .run(name, bio, sports.join(","), rate, input.id, venueId);
      if (done.changes !== 1) return { ok: false as const, error: "Coach not found." };
      id = input.id as number;
      await db.prepare("DELETE FROM coach_hours WHERE coach_id = ?").run(id);
    } else {
      id = ((await db
        .prepare("INSERT INTO coaches (venue_id, name, bio, sports, rate) VALUES (?, ?, ?, ?, ?) RETURNING id")
        .get(venueId, name, bio, sports.join(","), rate)) as { id: number }).id;
    }
    for (const h of hours)
      await db.prepare("INSERT INTO coach_hours (coach_id, weekday, from_hour, until_hour) VALUES (?, ?, ?, ?)").run(id, h.weekday, h.from, h.until);
    return { ok: true as const, coach: (await coachById(id))! };
  });
}

/** No more lessons booked with them; lessons already booked stand. */
export async function retireCoach(id: number, venueId: number): Promise<boolean> {
  const done = await getDb().prepare("UPDATE coaches SET active = 0 WHERE id = ? AND venue_id = ?").run(id, venueId);
  return done.changes === 1;
}

const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** Does the coach take lessons through all of these slots, each `step` hours long, on that day? */
export function coachWorks(coach: Coach, date: string, hours: number[], step: number): boolean {
  if (coach.timeOff.some((o) => date >= o.from && date <= o.until)) return false;
  const day = coach.hours.filter((h) => h.weekday === weekdayOf(date));
  return hours.every((h) => day.some((w) => h >= w.from && h + step <= w.until));
}

/** Slots this coach is already taken, by a lesson still standing. */
async function takenSlots(coachId: number, date: string): Promise<Set<number>> {
  const rows = (await getDb()
    .prepare(
      `SELECT s.hour FROM coach_slots s JOIN bookings b ON b.id = s.booking_id
        WHERE s.coach_id = ? AND s.date = ? AND b.status = 'confirmed'`
    )
    .all(coachId, date)) as { hour: number }[];
  return new Set(rows.map((r) => Number(r.hour)));
}

/**
 * The slots a lesson with this coach can start in on a date: the coach takes
 * lessons then, is not already taken, it has not passed, and a court of one
 * of their sports is free.
 */
export async function lessonSlots(
  coach: Coach,
  date: string,
  freeCourtAt: (hour: number) => boolean,
  venue: { openHour: number; closeHour: number; zone: string },
  /** What the lesson's sport is sold by here: each slot is that long. */
  unit: number
): Promise<number[]> {
  const taken = await takenSlots(coach.id, date);
  return slotsBetween(venue.openHour, venue.closeHour, unit).filter(
    (h) =>
      coachWorks(coach, date, [h], unit) &&
      slotsBetween(h, h + unit, SLOT).every((half) => !taken.has(half)) &&
      !isPastSlot(date, h, venue.zone) &&
      freeCourtAt(h)
  );
}

export type AttachResult = { ok: true; fee: number } | Refusal;

/**
 * Put the coach on a booking just made: their slots claimed, their fee on its
 * price. Refused, and nothing changed, when the coach is taken or not working
 * then; the caller lets the booking go.
 */
export async function attachCoach(bookingId: number, coach: Coach): Promise<AttachResult> {
  const db = getDb();
  const booking = (await db
    .prepare("SELECT b.id, b.date, b.start_hour, b.end_hour, c.sport, c.venue_id FROM bookings b JOIN courts c ON c.id = b.court_id WHERE b.id = ?")
    .get(bookingId)) as { id: number; date: string; start_hour: number; end_hour: number; sport: Sport; venue_id: number } | undefined;
  if (!booking || booking.venue_id !== coach.venueId || !coach.active) return refuse("COACH_NOT_FOUND");
  if (!coach.sports.includes(booking.sport)) return refuse("COACH_NOT_FOUND");
  // The coach's time is kept in the diary's half hours, as the court's is.
  const hours = slotsBetween(Number(booking.start_hour), Number(booking.end_hour), SLOT);
  if (!coachWorks(coach, booking.date, hours, SLOT)) return refuse("COACH_NOT_WORKING", { name: coach.name });
  const fee = roundMoney(coach.rate * hours.length * SLOT);
  try {
    await withTransaction(async () => {
      // Rows left by a lesson since cancelled are stale: clear them first.
      await db
        .prepare(
          `DELETE FROM coach_slots WHERE coach_id = ? AND date = ?
             AND booking_id IN (SELECT id FROM bookings WHERE status <> 'confirmed')`
        )
        .run(coach.id, booking.date);
      for (const h of hours)
        await db.prepare("INSERT INTO coach_slots (coach_id, date, hour, booking_id) VALUES (?, ?, ?, ?)").run(coach.id, booking.date, h, bookingId);
      await db
        .prepare("UPDATE bookings SET coach_id = ?, coach_fee = ?, total_price = total_price + ? WHERE id = ?")
        .run(coach.id, fee, fee, bookingId);
    });
  } catch (err) {
    if (isUniqueViolation(err)) return refuse("COACH_TAKEN", { name: coach.name });
    throw err;
  }
  return { ok: true, fee };
}

/** The coach on a booking, by name, for the screens that show it. */
export async function coachNames(bookingIds: number[]): Promise<Map<number, string>> {
  if (bookingIds.length === 0) return new Map();
  const rows = (await getDb()
    .prepare(`SELECT b.id, k.name FROM bookings b JOIN coaches k ON k.id = b.coach_id WHERE b.id IN (${bookingIds.map(() => "?").join(",")})`)
    .all(...bookingIds)) as { id: number; name: string }[];
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * A booking made for a lesson the coach could not take after all: gone, as
 * if never made. It was never confirmed to anybody, held, paid or announced.
 */
export async function discardBooking(bookingId: number): Promise<void> {
  await getDb().prepare("DELETE FROM bookings WHERE id = ? AND payment_status = 'unpaid'").run(bookingId);
}
