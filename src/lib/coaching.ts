import { isKnownActivity } from "./activity-registry";
import { getDb, withTransaction } from "./db";
import { errorText, translator, type ErrorCode } from "./i18n";
import { isAmount, money, roundMoney } from "./region";
import { addDays, isValidDateString, todayISO } from "./time";
import { type Refusal, type Sport, type StartOption } from "./types";
import { LATEST_MINUTE, freeWithin, instantOf, minuteOfDay, rangeLiteral, type Span } from "./interval";
import { isConflict, lockCoach, occupantsOn } from "./claims";

/**
 * One-to-one coaching. A venue lists its coaches, what each coaches, their
 * fee for an hour and the hours they take lessons. A customer books a lesson
 * the way they book a court, with a coach on it: the court is picked for
 * them, and the coach's fee goes on top of its price, so paying, cancelling,
 * receipts and reports all work as for any booking.
 *
 * A coach is in one place at a time. Each lesson claims the coach for its
 * time (`coach_claims`), and an exclusion constraint refuses two lessons that
 * overlap by a minute, whatever courts they are on. A cancelled lesson lets
 * its claim go (lib/store.ts `releaseBooking`).
 */

export interface CoachHours {
  /** 0 is Sunday. */
  weekday: number;
  /** Minutes of the day they start and stop taking lessons. */
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
    .prepare(`SELECT coach_id, weekday, from_min, until_min FROM coach_hours WHERE coach_id IN (${rows.map(() => "?").join(",")}) ORDER BY weekday, from_min`)
    .all(...rows.map((r) => r.id))) as { coach_id: number; weekday: number; from_min: number; until_min: number }[];
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
    sports: r.sports.split(",").filter((s): s is Sport => isKnownActivity(s)),
    rate: Number(r.rate),
    active: r.active === 1,
    hours: hours
      .filter((h) => h.coach_id === r.id)
      .map((h) => ({ weekday: h.weekday, from: h.from_min, until: h.until_min })),
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
  const sports = Array.isArray(input.sports) ? [...new Set(input.sports.filter((s): s is Sport => isKnownActivity(s)))] : [];
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
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6 || !Number.isInteger(from) || !Number.isInteger(until) || !(from >= 0 && until <= LATEST_MINUTE && from < until))
      return "Each stretch of hours needs a day, and a start before its end, in minutes of the day.";
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
      await db.prepare("INSERT INTO coach_hours (coach_id, weekday, from_min, until_min) VALUES (?, ?, ?, ?)").run(coachId, h.weekday, h.from, h.until);
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
      await db.prepare("INSERT INTO coach_hours (coach_id, weekday, from_min, until_min) VALUES (?, ?, ?, ?)").run(id, h.weekday, h.from, h.until);
    return { ok: true as const, coach: (await coachById(id))! };
  });
}

/** No more lessons booked with them; lessons already booked stand. */
export async function retireCoach(id: number, venueId: number): Promise<boolean> {
  const done = await getDb().prepare("UPDATE coaches SET active = 0 WHERE id = ? AND venue_id = ?").run(id, venueId);
  return done.changes === 1;
}

const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** Does the coach take lessons through the whole of this time on that day? */
export function coachWorks(coach: Coach, date: string, span: Span): boolean {
  if (coach.timeOff.some((o) => date >= o.from && date <= o.until)) return false;
  return coach.hours.some((w) => w.weekday === weekdayOf(date) && span.start >= w.from && span.end <= w.until);
}

/** The time this coach is already in lessons on a date, in that day's minutes (not counting booking `except`'s). */
async function coachBusy(coachId: number, date: string, zone: string, except?: number): Promise<Span[]> {
  const day = `[${instantOf(date, -24 * 60, zone).toISOString()},${instantOf(date, LATEST_MINUTE + 24 * 60, zone).toISOString()})`;
  const rows = (await getDb()
    .prepare(
      `SELECT lower(during) AS lo, upper(during) AS hi FROM coach_claims WHERE coach_id = ? AND active AND during && ?::tstzrange${except === undefined ? "" : " AND booking_id IS DISTINCT FROM ?"}`
    )
    .all(coachId, day, ...(except === undefined ? [] : [except]))) as { lo: Date; hi: Date }[];
  return rows.map((r) => ({ start: minuteOfDay(new Date(r.lo), date, zone), end: minuteOfDay(new Date(r.hi), date, zone) }));
}

/**
 * When this coach could take a lesson on a date, in that day's minutes: their
 * hours that weekday, none on time off, less their other lessons (not
 * `except`, a lesson being moved, whose own time counts as free). What a
 * lesson may move to (lib/store.ts rescheduleOptions); the claim decides.
 */
export async function coachFreeSpans(coach: Coach, date: string, zone: string, except?: number): Promise<Span[]> {
  if (coach.timeOff.some((o) => date >= o.from && date <= o.until)) return [];
  const busy = await coachBusy(coach.id, date, zone, except);
  return coach.hours.filter((w) => w.weekday === weekdayOf(date)).flatMap((w) => freeWithin({ start: w.from, end: w.until }, busy));
}

/**
 * Where a lesson with this coach can start on a date, and the longest it may
 * run from each: a start a court of the sport allows and is free from, while
 * the coach takes lessons then and is in no other.
 */
export async function lessonStarts(coach: Coach, date: string, sport: Sport): Promise<StartOption[]> {
  // Imported here: lib/store.ts reads this module.
  const { courtDaysFor, startOptions } = await import("./store");
  const courts = ((await getDb().prepare("SELECT * FROM courts WHERE venue_id = ? AND sport = ? ORDER BY id").all(coach.venueId, sport)) as { id: number }[]).map((c) => c.id);
  if (courts.length === 0) return [];
  const days = await courtDaysFor(courts, date);
  const first = [...days.values()][0];
  const held = await occupantsOn([...days.values()].map((d) => d.court), date, first.zone);
  const busy = await coachBusy(coach.id, date, first.zone);
  const free = coach.timeOff.some((o) => date >= o.from && date <= o.until)
    ? []
    : coach.hours.filter((w) => w.weekday === weekdayOf(date)).flatMap((w) => freeWithin({ start: w.from, end: w.until }, busy));
  const best = new Map<number, number>();
  for (const day of days.values()) {
    for (const option of startOptions(day, held.get(day.court.id)!, date)) {
      const window = free.find((f) => f.start <= option.minute && option.minute < f.end);
      if (!window) continue;
      const longest = Math.min(option.maxLength, window.end - option.minute);
      if (longest < day.policy.minLength) continue;
      best.set(option.minute, Math.max(best.get(option.minute) ?? 0, longest));
    }
  }
  return [...best].sort((a, b) => a[0] - b[0]).map(([minute, maxLength]) => ({ minute, maxLength }));
}

export type AttachResult = { ok: true; fee: number } | Refusal;

/**
 * Put the coach on a booking just made: the coach claimed for its time,
 * their fee on its price, pro rata to the minute. Refused, and nothing
 * changed, when the coach is taken or not working then; the caller lets the
 * booking go.
 */
export async function attachCoach(bookingId: number, coach: Coach): Promise<AttachResult> {
  const db = getDb();
  const booking = (await db
    .prepare(
      `SELECT b.id, b.date, b.start_min, b.end_min, b.sport, c.venue_id, v.time_zone, v.lat, v.lng
         FROM bookings b JOIN courts c ON c.id = b.court_id JOIN venues v ON v.id = c.venue_id WHERE b.id = ?`
    )
    .get(bookingId)) as
    | { id: number; date: string; start_min: number; end_min: number; sport: Sport; venue_id: number; time_zone: string | null; lat: number | null; lng: number | null }
    | undefined;
  if (!booking || booking.venue_id !== coach.venueId || !coach.active) return refuse("COACH_NOT_FOUND");
  if (!coach.sports.includes(booking.sport)) return refuse("COACH_NOT_FOUND");
  const span = { start: booking.start_min, end: booking.end_min };
  if (!coachWorks(coach, booking.date, span)) return refuse("COACH_NOT_WORKING", { name: coach.name });
  const fee = roundMoney((coach.rate * (span.end - span.start)) / 60);
  const { venueZoneOf } = await import("./zones");
  const zone = venueZoneOf(booking);
  try {
    await withTransaction(async () => {
      await lockCoach(coach.id);
      await db
        .prepare("INSERT INTO coach_claims (coach_id, booking_id, during) VALUES (?, ?, ?::tstzrange)")
        .run(coach.id, bookingId, rangeLiteral(booking.date, span.start, span.end, zone));
      await db
        .prepare("UPDATE bookings SET coach_id = ?, coach_fee = ?, total_price = total_price + ? WHERE id = ?")
        .run(coach.id, fee, fee, bookingId);
    });
  } catch (err) {
    if (isConflict(err)) return refuse("COACH_TAKEN", { name: coach.name });
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
