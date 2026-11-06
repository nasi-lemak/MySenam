import { getDb } from "./db";
import { refuse } from "./entitlements";
import { instantOf } from "./interval";
import { translator, type Locale } from "./i18n";
import { linkIn } from "./link-locale";
import { abandonUnsent } from "./outbox";
import { clockTime, shortDate } from "./region";
import { localDateOf } from "./time";
import type { Booking, Refusal } from "./types";
import type { CancelResult } from "./store";

/**
 * A coached lesson's time moved by the venue (owner's decision, 5 November 2026; docs/features/programmes.md#a-lesson-moved-by-the-venue).
 *
 * The move itself is the booking's own staff "change time" (lib/store.ts `rescheduleBooking`), which already keeps the lesson's coach with
 * it and checks the coach's week, time off and other lessons; this module is what a *venue* move of a lesson adds:
 *
 * - **The price stays as agreed.** The new time may price differently; the customer is neither charged more nor refunded less without a
 *   choice. Staff see the difference before moving; changing the price is the manager's explicit, logged price adjustment
 *   (lib/price-adjustments.ts), never a side effect of the move.
 * - **Each move is recorded** (`lesson_moves`, migration 0282): where the lesson was and is, the difference, who moved it, and the window
 *   in which its customer may cancel with everything back because the venue moved it: the venue's own number of days after the move
 *   (`venues.lesson_move_refund_days`, default 7), or the lesson's old time if sooner, never past the new start.
 * - **Cancelling in that window** is the customer's own act, never done for them, and goes through the venue's cancellation money path in
 *   full (`venueCancel`: online money back through the gateway where it can, credit and passes restored, a counter payment owed back for
 *   staff to hand over): no late share, no strike.
 * - **Reminders are re-armed**: a reminder queued for the old time is given up, and the one a customer already had no longer blocks a
 *   reminder for the new time.
 */

const HOUR = 3_600_000;

/** Days a customer may cancel a lesson the venue moved, from the venue's setting. */
export async function refundWindowDays(venueId: number): Promise<number> {
  const row = (await getDb().prepare("SELECT lesson_move_refund_days AS n FROM venues WHERE id = ?").get(venueId)) as { n: number } | undefined;
  return row?.n ?? 7;
}

export interface MoveRecordInput {
  bookingId: number;
  venueId: number;
  zone: string;
  from: { date: string; startMin: number; endMin: number; courtId: number };
  to: { date: string; startMin: number; endMin: number; courtId: number };
  /** The agreed price, which stays. */
  priceKept: number;
  /** The court time at the new time less at the old: what was not charged (positive) or not given back (negative). */
  priceDifference: number;
  by: { adminId: number | null; name: string } | null;
  now?: Date;
}

/**
 * Write the record of a lesson the venue moved, inside the move's transaction (so a move that is refused or only previewed leaves
 * nothing), and re-arm its reminders. The window: the venue's days after the move, or the old time if sooner, never past the new
 * start; a venue that set no days offers none.
 */
export async function recordLessonMove(input: MoveRecordInput): Promise<void> {
  const now = input.now ?? new Date();
  const days = await refundWindowDays(input.venueId);
  const oldStart = instantOf(input.from.date, input.from.startMin, input.zone).getTime();
  const newStart = instantOf(input.to.date, input.to.startMin, input.zone).getTime();
  const ends = days === 0 ? now.getTime() : Math.min(now.getTime() + days * 24 * HOUR, oldStart, newStart);
  await getDb()
    .prepare(
      `INSERT INTO lesson_moves (booking_id, venue_id, from_date, from_start_min, from_end_min, from_court_id, to_date, to_start_min, to_end_min, to_court_id,
                                 price_kept, price_difference, moved_by_admin_id, moved_by_name, moved_at, window_ends_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::timestamptz, ?::timestamptz)`
    )
    .run(
      input.bookingId,
      input.venueId,
      input.from.date,
      input.from.startMin,
      input.from.endMin,
      input.from.courtId,
      input.to.date,
      input.to.startMin,
      input.to.endMin,
      input.to.courtId,
      input.priceKept,
      input.priceDifference,
      input.by?.adminId ?? null,
      input.by?.name ?? "",
      now.toISOString(),
      new Date(Math.max(ends, now.getTime())).toISOString()
    );
  const row = (await getDb().prepare("SELECT code FROM bookings WHERE id = ?").get(input.bookingId)) as { code: string } | undefined;
  if (row) await rearmReminder(row.code);
}

/**
 * A reminder for a booking that moved: one still queued says the old time, so it is given up; one already sent (or given up) said the old
 * time too and must not stop the reminder for the new one. Reminders are keyed by the booking's code and time (`reminder:<code>:<date>:<start>`),
 * so a sent one for the old time never blocks the new; those written before that, keyed by the code alone, have their key set aside. `notifyReminders`
 * then finds the booking at its new time when that is within a day, as for any booking.
 */
export async function rearmReminder(code: string): Promise<void> {
  const keys = [`reminder:${code}`, `reminder:${code}:whatsapp`];
  await abandonUnsent([...keys, `reminder:${code}:%`], "The lesson was moved: a reminder for its new time follows.");
  await getDb()
    .prepare(`UPDATE messages SET dedupe_key = dedupe_key || ':moved' || id WHERE dedupe_key IN (${keys.map(() => "?").join(",")})`)
    .run(...keys);
}

export interface MovedLessonOffer {
  moveId: number;
  /** When the customer may no longer cancel it with everything back. */
  until: string;
  from: { date: string; startMin: number; endMin: number };
  to: { date: string; startMin: number; endMin: number };
  /** The court time at the new time less at the old: not charged, not refunded; the agreed price stays. */
  priceDifference: number;
  movedBy: string;
}

interface MoveRow {
  id: number;
  from_date: string;
  from_start_min: number;
  from_end_min: number;
  to_date: string;
  to_start_min: number;
  to_end_min: number;
  price_difference: string | number;
  moved_by_name: string;
  window_ends_at: Date | string;
}

/** The lesson's latest move, if its customer may still cancel because of it: not taken, window open, lesson still to come, booking still on. */
export async function openLessonMove(bookingId: number, now = new Date()): Promise<MovedLessonOffer | null> {
  const row = (await getDb()
    .prepare(
      `SELECT m.id, m.from_date, m.from_start_min, m.from_end_min, m.to_date, m.to_start_min, m.to_end_min, m.price_difference, m.moved_by_name, m.window_ends_at, m.cancelled_at
         FROM lesson_moves m JOIN bookings b ON b.id = m.booking_id
        WHERE m.booking_id = ? AND b.status = 'confirmed' AND b.coach_id IS NOT NULL ORDER BY m.id DESC LIMIT 1`
    )
    .get(bookingId)) as (MoveRow & { cancelled_at: unknown }) | undefined;
  if (!row || row.cancelled_at) return null;
  const ends = new Date(row.window_ends_at);
  if (ends.getTime() <= now.getTime()) return null;
  return {
    moveId: row.id,
    until: ends.toISOString(),
    from: { date: row.from_date, startMin: row.from_start_min, endMin: row.from_end_min },
    to: { date: row.to_date, startMin: row.to_start_min, endMin: row.to_end_min },
    priceDifference: Number(row.price_difference),
    movedBy: row.moved_by_name,
  };
}

/** A lesson's moves, newest first, for staff: where it was, the difference, who moved it, and whether its customer took the refund. */
export async function lessonMoveHistory(bookingId: number): Promise<(MovedLessonOffer & { cancelledAt: string | null })[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT id, from_date, from_start_min, from_end_min, to_date, to_start_min, to_end_min, price_difference, moved_by_name, window_ends_at, cancelled_at
         FROM lesson_moves WHERE booking_id = ? ORDER BY id DESC`
    )
    .all(bookingId)) as (MoveRow & { cancelled_at: Date | string | null })[];
  return rows.map((row) => ({
    moveId: row.id,
    until: new Date(row.window_ends_at).toISOString(),
    from: { date: row.from_date, startMin: row.from_start_min, endMin: row.from_end_min },
    to: { date: row.to_date, startMin: row.to_start_min, endMin: row.to_end_min },
    priceDifference: Number(row.price_difference),
    movedBy: row.moved_by_name,
    cancelledAt: row.cancelled_at ? new Date(row.cancelled_at).toISOString() : null,
  }));
}

/**
 * The sentence added to the customer's notice of a lesson the venue moved: they may cancel it for everything back until a time, from this
 * link. Empty where no window is open (the venue offers none, or it is a lesson not moved).
 */
export async function refundOfferText(booking: Booking, locale: Locale, link: string, zone: string): Promise<string> {
  if (!booking.coachId) return "";
  const offer = await openLessonMove(booking.id);
  if (!offer) return "";
  const at = new Date(offer.until);
  const until = `${shortDate(localDateOf(offer.until, zone), locale)}, ${clockTime(at, zone, locale)}`;
  return translator(locale)("clsb.msg.refundOffer", { until, link: linkIn(link, locale) });
}

/**
 * The customer takes the refund the venue's move of their lesson offers: the lesson is cancelled with everything back, through the
 * venue's own cancellation money path (`venueCancel`), and the move is marked taken. Refused once the window has closed or the lesson
 * has started, and for a lesson the venue did not move. The caller then sends any online money back (`refundCancelled` byVenue), tells
 * the customer, and the coach hears of it as of any cancelled lesson.
 */
export async function cancelMovedLesson(booking: Booking): Promise<CancelResult | Refusal> {
  if (booking.status === "cancelled") return refuse("ALREADY_CANCELLED");
  if (!booking.coachId) return refuse("LESSON_MOVE_NO_OFFER");
  const offer = await openLessonMove(booking.id);
  if (!offer) return refuse("LESSON_MOVE_NO_OFFER");
  const { courtVenueHours } = await import("./store");
  const { zone } = await courtVenueHours(booking.courtId);
  if (instantOf(booking.date, booking.startMin, zone).getTime() <= Date.now()) return refuse("LESSON_MOVE_NO_OFFER");
  const { venueCancel } = await import("./counter-refunds");
  const done = await venueCancel(booking.code, "lesson_moved");
  if (!done.ok) return done;
  await getDb().prepare("UPDATE lesson_moves SET cancelled_at = now() WHERE id = ? AND cancelled_at IS NULL").run(offer.moveId);
  return done;
}

/** Venue settings for lessons and registers, as the manager sees them. */
export async function lessonSettings(venueId: number): Promise<{ moveRefundDays: number; attendanceLockDays: number }> {
  const row = (await getDb().prepare("SELECT lesson_move_refund_days AS r, attendance_lock_days AS a FROM venues WHERE id = ?").get(venueId)) as
    | { r: number; a: number }
    | undefined;
  return { moveRefundDays: row?.r ?? 7, attendanceLockDays: row?.a ?? 14 };
}

/** A manager sets them: whole days, 0 to 60 for the refund window (0 offers none), 0 to 365 for how long after a session a register stays open. */
export async function setLessonSettings(
  venueId: number,
  input: { moveRefundDays?: unknown; attendanceLockDays?: unknown }
): Promise<{ ok: true; settings: { moveRefundDays: number; attendanceLockDays: number }; changed: string[] } | { ok: false; error: string; code: "LESSON_SETTINGS_RANGE" }> {
  const now = await lessonSettings(venueId);
  const pick = (v: unknown, was: number, max: number): number | null => {
    if (v === undefined) return was;
    return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max ? v : null;
  };
  const refund = pick(input.moveRefundDays, now.moveRefundDays, 60);
  const lock = pick(input.attendanceLockDays, now.attendanceLockDays, 365);
  if (refund === null || lock === null)
    return { ok: false, error: "The refund window is 0 to 60 days and a register stays open 0 to 365 days after its session.", code: "LESSON_SETTINGS_RANGE" };
  await getDb().prepare("UPDATE venues SET lesson_move_refund_days = ?, attendance_lock_days = ? WHERE id = ?").run(refund, lock, venueId);
  const changed = [
    ...(refund !== now.moveRefundDays ? [`moved-lesson refund window ${now.moveRefundDays} → ${refund} days`] : []),
    ...(lock !== now.attendanceLockDays ? [`register open ${now.attendanceLockDays} → ${lock} days after`] : []),
  ];
  return { ok: true, settings: { moveRefundDays: refund, attendanceLockDays: lock }, changed };
}
