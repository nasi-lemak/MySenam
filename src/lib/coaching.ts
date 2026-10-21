import { getDb, isUniqueViolation, withTransaction } from "./db";
import { errorText, translator, type ErrorCode } from "./i18n";
import { isAmount, money, roundMoney } from "./region";
import { isPastSlot, slotsBetween } from "./time";
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
  if (!Array.isArray(input.hours)) return { ok: false, error: "Give the hours they take lessons." };
  const hours: CoachHours[] = [];
  for (const h of input.hours as Record<string, unknown>[]) {
    const weekday = Number(h?.weekday);
    const from = Number(h?.from);
    const until = Number(h?.until);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6 || !(from >= 0 && until <= 24 && from < until) || from * 2 !== Math.round(from * 2) || until * 2 !== Math.round(until * 2))
      return { ok: false, error: "Each stretch of hours needs a day, and a start before its end, on the hour or half hour." };
    hours.push({ weekday, from, until });
  }
  return { ok: true, value: { name, bio, sports, rate: roundMoney(input.rate as number), hours } };
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

/** Does the coach take lessons through all of these slots on that day? */
export function coachWorks(coach: Coach, date: string, hours: number[], step: number): boolean {
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
  venue: { openHour: number; closeHour: number; step: number; zone: string }
): Promise<number[]> {
  const taken = await takenSlots(coach.id, date);
  return slotsBetween(venue.openHour, venue.closeHour, venue.step).filter(
    (h) => coachWorks(coach, date, [h], venue.step) && !taken.has(h) && !isPastSlot(date, h, venue.zone) && freeCourtAt(h)
  );
}

export type AttachResult = { ok: true; fee: number } | Refusal;

/**
 * Put the coach on a booking just made: their slots claimed, their fee on its
 * price. Refused, and nothing changed, when the coach is taken or not working
 * then; the caller lets the booking go.
 */
export async function attachCoach(bookingId: number, coach: Coach, step: number): Promise<AttachResult> {
  const db = getDb();
  const booking = (await db
    .prepare("SELECT b.id, b.date, b.start_hour, b.end_hour, c.sport, c.venue_id FROM bookings b JOIN courts c ON c.id = b.court_id WHERE b.id = ?")
    .get(bookingId)) as { id: number; date: string; start_hour: number; end_hour: number; sport: Sport; venue_id: number } | undefined;
  if (!booking || booking.venue_id !== coach.venueId || !coach.active) return refuse("COACH_NOT_FOUND");
  if (!coach.sports.includes(booking.sport)) return refuse("COACH_NOT_FOUND");
  const hours = slotsBetween(Number(booking.start_hour), Number(booking.end_hour), step);
  if (!coachWorks(coach, booking.date, hours, step)) return refuse("COACH_NOT_WORKING", { name: coach.name });
  const fee = roundMoney(coach.rate * hours.length * step);
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
