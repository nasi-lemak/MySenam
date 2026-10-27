import { coachWorks, attachCoach, listCoaches, lessonStarts, type Coach } from "./coaching";
import { getDb, withTransaction } from "./db";
import { creditBookingCoach, creditReceipt, issueReceipt } from "./documents";
import { errorText, translator, type ErrorCode, type Locale } from "./i18n";
import { hasBeenLive } from "./listing";
import { enqueue, hourRange } from "./outbox";
import { money, roundMoney } from "./region";
import { said, withPhrase } from "./staff-text";
import { COUNTER_METHODS, PAID_VIA_LABELS, type Booking, type CounterMethod, type Refusal, type Sport, type StartOption } from "./types";

/**
 * Lesson coaches: who coaches a lesson, and changing it (owner's decisions of
 * 27 October 2026; docs/features/programmes.md#giving-a-lesson-to-another-coach
 * and #who-chooses-the-coach).
 *
 * - **Ordinary changes keep the coach**: a lesson moved to another time goes
 *   with its coach, inside the coach's hours, time off and other lessons
 *   (lib/store.ts rescheduleBooking). Customers never change the coach.
 * - **A manager gives a lesson to another coach**, through the same change
 *   (`coachId`), with or without a new time. The new coach's fee for the
 *   lesson's minutes takes the place of the old. Not yet paid, the price
 *   follows. Paid, the manager chooses (`CoachMoney`), having been shown the
 *   effect (`coachChangeTerms`):
 *     - `keep`: the price stays as paid and the venue absorbs the difference,
 *       on the record;
 *     - `adjust`: a dearer coach's difference is owed on the booking,
 *       collected at the counter on a receipt of its own
 *       (`collectCoachDifference`); a cheaper one's goes back the way the
 *       lesson was paid (credit, the online payment, or by hand) with a credit
 *       note of its own.
 *   Written in the change's own transaction, under the booking's row lock
 *   (`applyCoachChange`), so a retry or two managers at once settle it once.
 *   The booking's price as sold, and its receipt, stay as they were: the
 *   receipt keeps the coach and fee it was sold with (lib/documents.ts
 *   bookingSale), and a later cancellation gives back only what is left
 *   (lib/store.ts paidPartLeft). Refused: a lesson paid with a lesson pack
 *   (the pack was for its coach: cancel and book again), and one others paid a
 *   share of or a deposit on.
 * - **Who chooses the coach of a new lesson** is the venue's setting
 *   (`venues.lesson_coach_choice`): the customer (as before), or the venue,
 *   when a customer books a lesson for a sport and time and a free coach of
 *   that sport is assigned (`assignLessonCoach`).
 */

export type CoachMoney = "keep" | "adjust";
export type CoachChoice = "customer" | "venue";

const ENGLISH = translator("en");
function refuse(code: ErrorCode, vars?: Record<string, string | number>): Refusal {
  return { ok: false, error: errorText(ENGLISH, code, vars), code, ...(vars ? { vars } : {}) };
}
/** A refusal of this module's, in English with its code, for a route to return. */
export const lessonRefusal = refuse;

// ------------------------------------------------------------------ who chooses

export async function coachChoice(venueId: number): Promise<CoachChoice> {
  const row = (await getDb().prepare("SELECT lesson_coach_choice FROM venues WHERE id = ?").get(venueId)) as { lesson_coach_choice: string } | undefined;
  return row?.lesson_coach_choice === "venue" ? "venue" : "customer";
}

export async function setCoachChoice(venueId: number, choice: unknown): Promise<{ ok: true; choice: CoachChoice } | { ok: false; error: string }> {
  if (choice !== "customer" && choice !== "venue") return { ok: false, error: "Say who chooses the coach: customer or venue." };
  const done = await getDb().prepare("UPDATE venues SET lesson_coach_choice = ? WHERE id = ?").run(choice, venueId);
  if (done.changes !== 1) return { ok: false, error: "Venue not found." };
  return { ok: true, choice };
}

/** The coaches who could take a lesson of this sport here, the venue choosing: active, and coaching it. */
async function coachesFor(venueId: number, sport: Sport): Promise<Coach[]> {
  return (await listCoaches(venueId, { activeOnly: true })).filter((c) => c.sports.includes(sport)).sort((a, b) => a.id - b.id);
}

/** What a lesson of this sport costs for the coach here, from the cheapest to the dearest an hour; null with none. */
export async function lessonRates(venueId: number, sport: Sport): Promise<{ min: number; max: number } | null> {
  const coaches = await coachesFor(venueId, sport);
  if (coaches.length === 0) return null;
  const rates = coaches.map((c) => c.rate);
  return { min: Math.min(...rates), max: Math.max(...rates) };
}

/** The sports a lesson can be booked for here: those an active coach coaches. */
export async function lessonSports(venueId: number): Promise<Sport[]> {
  return [...new Set((await listCoaches(venueId, { activeOnly: true })).flatMap((c) => c.sports))];
}

/**
 * Where a lesson of this sport can start on a date with whichever coach is
 * free, and the longest it may run from each: every coach's starts together
 * (lib/coaching.ts lessonStarts), no scheduling of its own.
 */
export async function venueLessonStarts(venueId: number, date: string, sport: Sport): Promise<StartOption[]> {
  const best = new Map<number, number>();
  for (const coach of await coachesFor(venueId, sport))
    for (const s of await lessonStarts(coach, date, sport)) best.set(s.minute, Math.max(best.get(s.minute) ?? 0, s.maxLength));
  return [...best].sort((a, b) => a[0] - b[0]).map(([minute, maxLength]) => ({ minute, maxLength }));
}

/**
 * Put a coach the venue chooses on a lesson just booked: one who coaches the
 * sport and takes lessons through its time, the one with the fewest lessons
 * that day first, then the lowest id (`prefer`, the coach of a series' first
 * week, before them; `only`, the coach a lesson pack is for, alone). Each is
 * tried under their own lock (lib/coaching.ts attachCoach), the claim
 * deciding: one taken meanwhile, by a lesson at the same moment, passes to
 * the next. Nobody free: refused, and nothing changed; the caller lets the
 * booking go.
 */
export async function assignLessonCoach(
  bookingId: number,
  opts: { prefer?: number; only?: number } = {}
): Promise<{ ok: true; coach: Coach; fee: number } | Refusal> {
  const b = (await getDb()
    .prepare("SELECT b.date, b.start_min, b.end_min, b.sport, c.venue_id FROM bookings b JOIN courts c ON c.id = b.court_id WHERE b.id = ?")
    .get(bookingId)) as { date: string; start_min: number; end_min: number; sport: Sport; venue_id: number } | undefined;
  if (!b) return refuse("BOOKING_NOT_FOUND");
  const span = { start: b.start_min, end: b.end_min };
  const working = (await coachesFor(b.venue_id, b.sport)).filter((c) => coachWorks(c, b.date, span) && (opts.only === undefined || c.id === opts.only));
  if (working.length === 0) return refuse("LESSON_NO_COACH");
  const counts = new Map(
    (
      (await getDb()
        .prepare(
          `SELECT coach_id, COUNT(*)::int AS n FROM bookings
            WHERE coach_id IN (${working.map(() => "?").join(",")}) AND date = ? AND status = 'confirmed' GROUP BY coach_id`
        )
        .all(...working.map((c) => c.id), b.date)) as { coach_id: number; n: number }[]
    ).map((r) => [r.coach_id, Number(r.n)])
  );
  const order = [...working].sort((x, y) => (counts.get(x.id) ?? 0) - (counts.get(y.id) ?? 0) || x.id - y.id);
  if (opts.prefer !== undefined) order.sort((x, y) => Number(y.id === opts.prefer) - Number(x.id === opts.prefer));
  for (const coach of order) {
    const attached = await attachCoach(bookingId, coach);
    if (attached.ok) return { ok: true, coach, fee: attached.fee };
    if (attached.code !== "COACH_TAKEN") return attached;
  }
  return refuse("LESSON_NO_COACH");
}

// ------------------------------------------------------------------ another coach

/** How money given back for a cheaper coach goes: the way the lesson was paid. */
export type RefundHow = "credit" | "online" | "hand";

export interface CoachChangeTerms {
  fromCoach: { id: number; name: string };
  toCoach: { id: number; name: string };
  /** The fee on the lesson now, and the new coach's for its minutes. */
  fromFee: number;
  toFee: number;
  /** The new fee less the old. */
  difference: number;
  paid: boolean;
  /** Paid: where money given back would go. */
  refundHow: RefundHow | null;
  /** Paid, and `adjust`: owed by the customer, or given back (never more than is left paid). */
  owed: number;
  refund: number;
  /** Paid, and `keep`: what the venue absorbs (signed). */
  absorbed: number;
}

interface LessonRow {
  id: number;
  code: string;
  coach_id: number | null;
  coach_fee: number;
  start_min: number;
  end_min: number;
  payment_status: string;
  paid_via: string | null;
  total_price: number;
  shares_paid: number;
  status: string;
}

const refundHowOf = (via: string | null): RefundHow => (via === "credit" ? "credit" : via === "online" ? "online" : "hand");

/** What the paid part of a booking still stands at: its price less what went back for cheaper coaches already. */
async function paidLeft(bookingId: number, total: number, shares: number): Promise<number> {
  const gone = (await getDb()
    .prepare("SELECT COALESCE(SUM(refunded), 0)::float AS gone FROM lesson_coach_changes WHERE booking_id = ? AND paid")
    .get(bookingId)) as { gone: number };
  return Math.max(0, roundMoney(total - shares - Number(gone.gone)));
}

/**
 * Why this lesson cannot go to another coach whatever the time, or null: the
 * refusals that do not depend on where it moves. `money` is the manager's
 * choice for a paid lesson; without one a paid lesson is refused, so nothing
 * paid changes coach by accident.
 */
export async function coachChangeRefusal(booking: Booking, money: CoachMoney | undefined): Promise<Refusal | null> {
  // Others paid a share, or a deposit was paid: the money is several people's, or part-paid; cancel and book again.
  if (booking.sharesPaid > 0.005) return refuse("LESSON_COACH_PART_PAID");
  if (booking.paymentStatus !== "paid") return null;
  // A lesson pack was for the coach booked: its entries are not moved onto another's lessons.
  if (booking.paidVia === "pass") {
    const pack = (await getDb()
      .prepare(
        `SELECT k.name FROM pass_entries e JOIN passes p ON p.id = e.pass_id LEFT JOIN coaches k ON k.id = p.coach_id
          WHERE e.booking_id = ? AND e.delta < 0 ORDER BY e.id LIMIT 1`
      )
      .get(booking.id)) as { name: string | null } | undefined;
    return refuse("LESSON_COACH_PASS", { name: pack?.name ?? "" });
  }
  if (money !== "keep" && money !== "adjust") return refuse("RESCHEDULE_COACH_PAID");
  return null;
}

/** What giving this lesson to `to` would do to its money: shown before it is done, and done the same way. */
export async function coachChangeTerms(booking: Booking, to: Coach, money?: CoachMoney): Promise<CoachChangeTerms> {
  const from = (await getDb().prepare("SELECT id, name FROM coaches WHERE id = ?").get(booking.coachId)) as { id: number; name: string } | undefined;
  const fromFee = roundMoney(booking.coachFee ?? 0);
  const toFee = roundMoney((to.rate * (booking.endMin - booking.startMin)) / 60);
  const difference = roundMoney(toFee - fromFee);
  const paid = booking.paymentStatus === "paid";
  const left = paid ? await paidLeft(booking.id, booking.totalPrice, booking.sharesPaid) : 0;
  const adjust = paid && money === "adjust";
  return {
    fromCoach: { id: from?.id ?? booking.coachId ?? 0, name: from?.name ?? "" },
    toCoach: { id: to.id, name: to.name },
    fromFee,
    toFee,
    difference,
    paid,
    refundHow: paid ? refundHowOf(booking.paidVia ?? null) : null,
    owed: adjust && difference > 0 ? difference : 0,
    refund: adjust && difference < 0 ? Math.min(-difference, left) : 0,
    absorbed: paid && money === "keep" ? difference : 0,
  };
}

export interface CoachChange extends CoachChangeTerms {
  id: number;
  money: "repriced" | "kept" | "adjusted";
}

/**
 * Record a lesson given to another coach, and settle its money: inside the
 * change's own transaction (lib/store.ts rescheduleBooking), after the
 * booking's row lock and the new coach's claim, so it is done once or not at
 * all. The booking's coach and fee are already the new ones; on a paid lesson
 * its price as sold stays.
 */
export async function applyCoachChange(
  bookingId: number,
  input: { from: { id: number; name: string; fee: number }; to: { id: number; name: string; fee: number }; money?: CoachMoney; by: { adminId: number | null; name: string } | null }
): Promise<CoachChange> {
  const db = getDb();
  const b = (await db
    .prepare(
      `SELECT b.id, b.code, b.coach_id, b.coach_fee::float AS coach_fee, b.start_min, b.end_min, b.payment_status, b.paid_via,
              b.total_price::float AS total_price, b.shares_paid::float AS shares_paid, b.status, c.venue_id
         FROM bookings b JOIN courts c ON c.id = b.court_id WHERE b.id = ?`
    )
    .get(bookingId)) as LessonRow & { venue_id: number };
  const paid = b.payment_status === "paid";
  const difference = roundMoney(input.to.fee - input.from.fee);
  const adjust = paid && input.money === "adjust";
  const left = paid ? await paidLeft(b.id, Number(b.total_price), Number(b.shares_paid)) : 0;
  const owed = adjust && difference > 0 ? difference : 0;
  const refund = adjust && difference < 0 ? Math.min(-difference, left) : 0;
  const how: RefundHow | null = refund > 0 ? refundHowOf(b.paid_via) : null;
  const kind: CoachChange["money"] = !paid ? "repriced" : adjust ? "adjusted" : "kept";
  const absorbed = paid && kind === "kept" ? difference : 0;
  const row = (await db
    .prepare(
      `INSERT INTO lesson_coach_changes (booking_id, venue_id, from_coach_id, to_coach_id, from_coach_name, to_coach_name, from_fee, to_fee,
         paid, money, absorbed, owed, refunded, refund_how, by_admin_id, by_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .get(
      b.id, b.venue_id, input.from.id, input.to.id, input.from.name, input.to.name, input.from.fee, input.to.fee,
      paid, kind, absorbed, owed, refund, how, input.by?.adminId ?? null, input.by?.name ?? null
    )) as { id: number };
  if (refund > 0) {
    if (how === "credit") {
      // Back to the pots it came from, in proportion, marked as this change's (not the booking's own refund on cancelling).
      const charges = (await db
        .prepare("SELECT user_id, amount::float AS amount, venue_id FROM wallet_entries WHERE booking_id = ? AND amount < 0 ORDER BY id")
        .all(b.id)) as { user_id: number; amount: number; venue_id: number | null }[];
      const charged = charges.reduce((s, c) => s - Number(c.amount), 0);
      const why = withPhrase(said("srv.wallet.refund", { code: b.code }));
      let rest = refund;
      for (const [i, c] of charges.entries()) {
        const back = i === charges.length - 1 ? roundMoney(rest) : roundMoney((-Number(c.amount) / charged) * refund);
        rest = roundMoney(rest - back);
        if (back > 0)
          await db
            .prepare("INSERT INTO wallet_entries (user_id, amount, reason, reason_phrase, booking_id, venue_id, coach_change_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .run(c.user_id, back, ...why, b.id, c.venue_id, row.id);
      }
    } else if (how === "online") {
      // Owed back on the payment, never more than it took; sent through the venue's refund path once this commits.
      await db
        .prepare(
          `UPDATE online_payments p SET refund_due = LEAST(p.amount, p.refund_due + ?)
            WHERE p.status = 'paid' AND p.id = (SELECT pb.payment_id FROM online_payment_bookings pb JOIN online_payments q ON q.id = pb.payment_id
                                                 WHERE pb.booking_id = ? AND q.status = 'paid' ORDER BY q.id DESC LIMIT 1)`
        )
        .run(refund, b.id);
    }
    // At the counter: the credit note says what the venue's staff give back.
    await creditBookingCoach(b.id, row.id, `Coaching with ${input.to.name} in place of ${input.from.name}`, refund);
  }
  return {
    id: row.id,
    money: kind,
    fromCoach: { id: input.from.id, name: input.from.name },
    toCoach: { id: input.to.id, name: input.to.name },
    fromFee: input.from.fee,
    toFee: input.to.fee,
    difference,
    paid,
    refundHow: paid ? refundHowOf(b.paid_via) : null,
    owed,
    refund,
    absorbed,
  };
}

/** The money line of a change, as the activity log records it. */
export function coachChangeDetail(c: CoachChange): string {
  const fees = `fee ${money(c.fromFee)} → ${money(c.toFee)}`;
  if (c.money === "repriced") return `${fees}; not paid, price ${c.difference >= 0 ? "+" : "−"}${money(Math.abs(c.difference))}`;
  if (c.money === "kept")
    return `${fees}; paid, price kept as paid${c.absorbed > 0 ? `, the venue absorbs ${money(c.absorbed)}` : c.absorbed < 0 ? `, the venue keeps ${money(-c.absorbed)} over the new fee` : ""}`;
  if (c.owed > 0) return `${fees}; paid, ${money(c.owed)} more owed by the customer`;
  if (c.refund > 0) return `${fees}; paid, ${money(c.refund)} back ${c.refundHow === "credit" ? "to credit" : c.refundHow === "online" ? "on the online payment" : "by hand"}, with a credit note`;
  return `${fees}; paid, no difference`;
}

/** Each lesson's differences still owed for a dearer coach, for the day's bookings at the counter. */
export async function owedForCoachChanges(bookingIds: number[]): Promise<Map<number, { changeId: number; amount: number; coach: string }[]>> {
  const out = new Map<number, { changeId: number; amount: number; coach: string }[]>();
  if (bookingIds.length === 0) return out;
  const rows = (await getDb()
    .prepare(
      `SELECT id, booking_id, owed::float AS owed, to_coach_name FROM lesson_coach_changes
        WHERE booking_id IN (${bookingIds.map(() => "?").join(",")}) AND owed > 0 AND owed_paid_at IS NULL AND owed_cleared_at IS NULL ORDER BY id`
    )
    .all(...bookingIds)) as { id: number; booking_id: number; owed: number; to_coach_name: string }[];
  for (const r of rows) out.set(r.booking_id, [...(out.get(r.booking_id) ?? []), { changeId: r.id, amount: Number(r.owed), coach: r.to_coach_name }]);
  return out;
}

export type CollectResult = { ok: true; changeId: number; bookingCode: string; amount: number; receipt: string | null } | { ok: false; error: string; code?: string; status: number };

/**
 * The difference owed for a dearer coach, taken at the counter: marked once,
 * under the booking's lock, with a receipt of its own (`lesson-coach:<id>`,
 * filed under Coaching). The booking's own receipt stays as it was sold.
 */
export async function collectCoachDifference(changeId: number, venueId: number, method: unknown): Promise<CollectResult> {
  if (typeof method !== "string" || !(COUNTER_METHODS as readonly string[]).includes(method))
    return { ok: false, error: `Say how it was paid: ${COUNTER_METHODS.join(", ")}.`, status: 400 };
  const db = getDb();
  const done = await withTransaction(async () => {
    const c = (await db
      .prepare(
        `SELECT l.id, l.booking_id, l.venue_id, l.owed::float AS owed, l.owed_paid_at, l.owed_cleared_at, l.from_coach_name, l.to_coach_name
           FROM lesson_coach_changes l WHERE l.id = ?`
      )
      .get(changeId)) as
      | { id: number; booking_id: number; venue_id: number | null; owed: number; owed_paid_at: string | null; owed_cleared_at: string | null; from_coach_name: string; to_coach_name: string }
      | undefined;
    if (!c || c.venue_id !== venueId) return { ok: false as const, error: "Nothing owed for that coach change.", status: 404 };
    const b = (await db.prepare("SELECT id, code, status, user_id, name, phone FROM bookings WHERE id = ? FOR UPDATE").get(c.booking_id)) as {
      id: number; code: string; status: string; user_id: number | null; name: string; phone: string;
    };
    const again = (await db.prepare("SELECT owed_paid_at, owed_cleared_at FROM lesson_coach_changes WHERE id = ?").get(c.id)) as {
      owed_paid_at: string | null; owed_cleared_at: string | null;
    };
    if (Number(c.owed) <= 0 || again.owed_paid_at || again.owed_cleared_at || b.status === "cancelled")
      return { ok: false as const, error: "Nothing is owed for that coach change now.", code: "LESSON_COACH_NOTHING_OWED", status: 409 };
    await db.prepare("UPDATE lesson_coach_changes SET owed_paid_at = now(), owed_paid_via = ? WHERE id = ?").run(method, c.id);
    return { ok: true as const, c, b };
  });
  if (!done.ok) return done;
  const receipt = await issueReceipt({
    source: `lesson-coach:${changeId}`,
    venueId,
    userId: done.b.user_id,
    name: done.b.name,
    phone: done.b.phone,
    lines: [{ description: `Coaching with ${done.c.to_coach_name} in place of ${done.c.from_coach_name}, ${done.b.code}: the difference`, amount: Number(done.c.owed) }],
    paidVia: PAID_VIA_LABELS[method as CounterMethod],
    taxable: true,
    note: `Booking ${done.b.code}`,
  });
  return { ok: true, changeId, bookingCode: done.b.code, amount: Number(done.c.owed), receipt: receipt?.ref ?? null };
}

/**
 * A lesson with coach changes cancelled, `share` of it given back (lib/store.ts
 * refundBooking): a difference collected for a dearer coach is credited
 * as the lesson is, and given back by hand as it was taken; one not yet
 * collected is no longer owed.
 */
export async function coachChangesCancelled(bookingId: number, share: number): Promise<void> {
  const db = getDb();
  await db
    .prepare("UPDATE lesson_coach_changes SET owed_cleared_at = now() WHERE booking_id = ? AND owed > 0 AND owed_paid_at IS NULL AND owed_cleared_at IS NULL")
    .run(bookingId);
  const collected = (await db
    .prepare("SELECT id FROM lesson_coach_changes WHERE booking_id = ? AND owed > 0 AND owed_paid_at IS NOT NULL ORDER BY id")
    .all(bookingId)) as { id: number }[];
  for (const c of collected) await creditReceipt(`lesson-coach:${c.id}`, share < 1 ? "receipt.why.lateCancelled" : "receipt.why.cancelled", share);
}

/** The money line of a change, as the customer is told it. */
export function coachChangeMoney(locale: Locale, c: Pick<CoachChange, "money" | "owed" | "refund" | "refundHow">, totalNow: number): string {
  const t = translator(locale);
  if (c.money === "repriced") return t("co6.msg.priceNow", { total: money(totalNow) });
  if (c.owed > 0) return t("co6.msg.owed", { amount: money(c.owed) });
  if (c.refund > 0)
    return t(c.refundHow === "credit" ? "co6.msg.toCredit" : c.refundHow === "online" ? "co6.msg.toCard" : "co6.msg.byHand", { amount: money(c.refund) });
  return t("co6.msg.priceSame");
}

/**
 * Tell the customer their lesson is with another coach, by email in the
 * language they booked in: who now, at what time, and what it did to the
 * money. Nothing for a venue never live, or a booking with no address. The
 * coaches hear as for any move (lib/coach-schedule.ts notifyLessonMoved).
 */
export async function notifyCoachChanged(booking: Booking, change: CoachChange, locale: Locale): Promise<boolean> {
  const email = booking.email?.trim();
  if (!email) return false;
  const { getCourt, getVenue } = await import("./store");
  const court = await getCourt(booking.courtId);
  const venue = court ? await getVenue(court.venueId) : null;
  if (!court || !venue || !hasBeenLive(venue)) return false;
  const t = translator(locale);
  await enqueue({
    bookingId: booking.id,
    venueId: venue.id,
    kind: "booking_rescheduled",
    channel: "email",
    recipient: email,
    locale,
    subject: "co6.msg.subject",
    body: "co6.msg.body",
    dedupeKey: `coach-changed:${change.id}`,
    vars: {
      name: booking.name.trim().split(/\s+/)[0] || booking.name.trim(),
      venue: venue.name,
      code: booking.code,
      from: change.fromCoach.name,
      to: change.toCoach.name,
      where: t("msg.where", { court: court.name, venue: venue.name }),
      when: t("msg.when", { date: booking.date, ...hourRange(booking.startHour, booking.endHour, locale) }),
      money: coachChangeMoney(locale, change, booking.totalPrice),
    },
  });
  return true;
}
