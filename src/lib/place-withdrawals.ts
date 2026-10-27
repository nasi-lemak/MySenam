import { policyFor } from "./booking-policy";
import { getDb, withTransaction } from "./db";
import { creditBookingPlace } from "./documents";
import { placeShares, placesOf, refuse, soldByPlace, type BookingPlace } from "./entitlements";
import { isLocale, translator, type Locale } from "./i18n";
import { hasBeenLive } from "./listing";
import { enqueue, hourRange } from "./outbox";
import { participantEvent, type Actor } from "./participants";
import { money, roundMoney } from "./region";
import { said, withPhrase } from "./staff-text";
import { isPastSlot } from "./time";
import type { Booking, Court, Refusal } from "./types";

/**
 * Taking one person off a booking, the others staying booked (ADR 0025;
 * docs/features/booking.md#taking-one-person-off-a-booking).
 *
 * Where the activity allows it (the booking rule `separatePlaces`, yes unless
 * the venue sells the places as one), a guardian withdraws one child, the
 * customer stops taking part themself, or a group gives up places nobody was
 * named on. What it does depends on what was booked:
 *
 * - a place on a shared-capacity session (a gym floor, a pool, kayaks): the
 *   place is released for somebody else, and the waiting list is offered it;
 * - a place priced by the place (each player on a court priced per player,
 *   each place on a facility not priced flat): that place's share of the
 *   court time as charged (lib/entitlements.ts `placeShare`) comes off: off
 *   what is owed on a booking not yet paid, or given back the way it was paid
 *   under the venue's cancellation terms (a late withdrawal keeps the venue's
 *   share); the place's own concession or member price goes with it, its pass
 *   entries go back, and booking-wide benefits stay with the booking;
 * - a court or room hired whole: the person is simply no longer named on it.
 *   Nothing is priced per person, so nothing is refunded and the court stays
 *   booked: removing a player never cancels or refunds the court itself.
 *
 * Refused, with the reason, where it cannot be done this way: a lesson
 * (booked as one, the coach's fee included), a class place (each is its own
 * enrolment: cancel it), an open game, a booking others paid shares of, one
 * with a deposit paid or charged to an account, one whose payment page is
 * open, kit still out, a place already marked at the door, the last person
 * on it (cancel the booking instead), or past the venue's cutoff. Staff at the
 * counter may do it up to the end of the booking, in full, on the record.
 *
 * Done in one transaction under the booking's row lock: two withdrawals at
 * once each see the other, and the money, the pass entries, the places held
 * and the record go together or not at all.
 */

/** What to take off: one participant, the customer taking part themself, or so many places nobody is named on. */
export type WithdrawWhat = { participantId: number } | { customer: true } | { unnamed: number } | { placeId: number };

export type WithdrawBy = { kind: "customer"; userId: number | null; name: string } | { kind: "staff"; adminId: number; name: string };

export interface WithdrawOutcome {
  /** Who, as named on the booking (null for places nobody was named on). */
  name: string | null;
  participantId: number | null;
  places: number;
  /** What the places cost as charged: 0 where nothing is priced per person. */
  price: number;
  /** Paid: given back, and kept by the venue on a late withdrawal. */
  refund: number;
  kept: number;
  /** Not yet paid: what comes off what is owed. */
  owedLess: number;
  /** Pass entries (or minutes) given back. */
  units: number;
  /** How the money goes back: to credit, owed back on the online payment, by hand at the counter; none. */
  how: "credit" | "online" | "hand" | "pass" | "none";
  late: boolean;
  keptPercent: number | null;
  /** Places freed on a shared-capacity session. */
  released: number;
}

/** Each person (and the unnamed places) on a booking, and whether they can be taken off now, with what it would do. */
export interface WithdrawOption extends Partial<WithdrawOutcome> {
  who: "customer" | "participant" | "unnamed";
  /** The place's row, to name it when taking it off; null for the places nobody is named on. */
  placeId: number | null;
  participantId: number | null;
  name: string | null;
  allowed: boolean;
  /** Why not, where not. */
  refusal?: { error: string; code?: string; vars?: Record<string, string | number> };
}

interface Assessed {
  outcome: WithdrawOutcome;
  place: BookingPlace | null;
  share: number;
  paid: boolean;
  /** The part of a booking-wide promo code the places taken off had (lib/entitlements.ts `placeShares`). */
  promoShare: number;
}

async function storeModule() {
  // Imported here, not at the top: lib/store.ts is the booking engine this module works beside.
  return import("./store");
}

/** Why nobody can be taken off this booking now, or the terms a withdrawal goes on (the share given back). */
async function bookingTerms(
  booking: Booking,
  court: Court,
  by: WithdrawBy
): Promise<{ refusal: Refusal } | { share: number; late: boolean; keptPercent: number | null }> {
  const store = await storeModule();
  if (booking.status === "cancelled") return { refusal: refuse("ALREADY_CANCELLED") };
  if (booking.coachId) return { refusal: refuse("ENT_WITHDRAW_LESSON") };
  if (booking.classId !== null) return { refusal: refuse("ENT_WITHDRAW_CLASS") };
  const game = await store.gameUnder(booking.id);
  if (game && game.status !== "cancelled") return { refusal: refuse("ENT_WITHDRAW_GAME") };
  if ((booking.accountId ?? null) !== null) return { refusal: refuse("ENT_WITHDRAW_ACCOUNT") };
  if ((booking.depositPaid ?? 0) > 0) return { refusal: refuse("ENT_WITHDRAW_DEPOSIT") };
  if ((booking.sharesPaid ?? 0) - (booking.depositPaid ?? 0) > 0.005) return { refusal: refuse("ENT_WITHDRAW_SHARED") };
  if (await store.paymentPageOpen(booking.id)) return { refusal: refuse("ENT_WITHDRAW_PAGE_OPEN") };
  if (await store.hasOpenHire(booking.id)) return { refusal: refuse("KIT_STILL_OUT") };
  const policy = await policyFor(court);
  if (!policy.separatePlaces) return { refusal: refuse("ENT_WITHDRAW_SOLD_WHOLE") };
  const zone = await store.courtZone(booking.courtId);
  if (by.kind === "staff") {
    // The counter, as an admin cancellation: until it has been played, in full.
    if (isPastSlot(booking.date, booking.endHour, zone)) return { refusal: refuse("CANCEL_PLAYED") };
    return { share: 1, late: false, keptPercent: null };
  }
  const terms = await store.lateTerms(booking);
  if (!terms.allowed) {
    const cutoff = await store.cancelCutoffForBooking(booking.id);
    return { refusal: cutoff === 0 || isPastSlot(booking.date, booking.startHour, zone) ? refuse("ENT_WITHDRAW_STARTED") : refuse("ENT_WITHDRAW_CUTOFF", { n: cutoff }) };
  }
  return { share: terms.share, late: terms.late, keptPercent: terms.keptPercent };
}

/** Pass spends a withdrawal gives back: the place's own, or so many places' of a pass spent per place. */
async function openSpends(bookingId: number, place: BookingPlace | null, unnamed: number): Promise<{ id: number; pass_id: number; delta: number; place_id: number | null }[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT e.id, e.pass_id, e.delta, e.place_id FROM pass_entries e JOIN passes p ON p.id = e.pass_id
        WHERE e.booking_id = ? AND e.delta < 0
          AND NOT EXISTS (SELECT 1 FROM pass_entries r WHERE r.settles_entry_id = e.id)
          AND ${place && place.placeId !== null ? "e.place_id = ?" : "e.place_id IS NULL AND p.scope = 'places'"}
        ORDER BY e.id`
    )
    .all(...(place && place.placeId !== null ? [bookingId, place.placeId] : [bookingId]))) as { id: number; pass_id: number; delta: number; place_id: number | null }[];
  return place && place.placeId !== null ? rows : rows.slice(0, unnamed);
}

/**
 * What taking `what` off this booking would do now, or why it cannot be done:
 * read only, so the same answer is shown before and checked again under the
 * booking's lock when it is done.
 */
async function assess(booking: Booking, court: Court, what: WithdrawWhat, by: WithdrawBy): Promise<Assessed | Refusal> {
  const terms = await bookingTerms(booking, court, by);
  if ("refusal" in terms) return terms.refusal;
  const places = await placesOf(booking.id);
  const named = places.some((p) => p.placeId !== null) ? places.length : 0;
  // Players count where a booking is sold by the head or takes places; a court hired whole is one booking whoever plays.
  const counted = court.capacity > 1 || court.perPlayer === true;
  const players = counted ? Math.max(1, booking.players ?? 1) : 1;
  const unnamedNow = counted ? Math.max(0, players - Math.max(1, named)) : 0;
  let place: BookingPlace | null = null;
  let count = 1;
  if ("unnamed" in what) {
    count = what.unnamed;
    if (!Number.isInteger(count) || count < 1 || count > unnamedNow) return refuse("ENT_WITHDRAW_NO_PLACES");
  } else {
    place =
      "customer" in what
        ? (places.find((p) => p.customer && p.placeId !== null) ?? null)
        : "placeId" in what
          ? (places.find((p) => p.placeId === what.placeId) ?? null)
          : (places.find((p) => p.participantId === what.participantId) ?? null);
    if (!place) {
      // The customer taking the booking alone is the booking: cancel it instead.
      if ("customer" in what && places.length === 1 && places[0].customer) return refuse("ENT_WITHDRAW_LAST", { name: booking.name });
      return refuse("ENT_WITHDRAW_NOT_ON");
    }
    if (named - 1 + unnamedNow < 1) return refuse("ENT_WITHDRAW_LAST", { name: place.name ?? booking.name });
    if (place.placeId !== null && (await getDb().prepare("SELECT 1 FROM place_attendance WHERE place_id = ?").get(place.placeId)))
      return refuse("ENT_WITHDRAW_ATTENDED", { name: place.name ?? booking.name });
  }
  // The place's price, where places are priced; a court hired whole has none apart from the court.
  // Its own share, part by part (lib/entitlements.ts `placeShares`): what its benefits and its part of a code took off go with it.
  const lines = soldByPlace(court) ? (await placeShares(booking.id)).lines : [];
  const taken = place ? lines.filter((l) => l.placeId === place!.placeId).slice(0, 1) : lines.filter((l) => l.placeId === -1).slice(-count);
  const price = roundMoney(taken.reduce((s, l) => s + l.net, 0));
  const promoShare = roundMoney(taken.reduce((s, l) => s + l.promo, 0));
  const paid = booking.paymentStatus === "paid";
  const via = booking.paidVia ?? null;
  const spends = paid && via === "pass" ? await openSpends(booking.id, place, count) : [];
  const units = spends.reduce((n, e) => n + Math.floor(-e.delta * terms.share), 0);
  const how: WithdrawOutcome["how"] =
    !paid || price <= 0 ? (units > 0 ? "pass" : "none") : via === "credit" ? "credit" : via === "online" ? "online" : via === "pass" ? "pass" : "hand";
  const refund = paid && how !== "pass" && how !== "none" ? roundMoney(price * terms.share) : 0;
  return {
    place,
    share: terms.share,
    paid,
    promoShare,
    outcome: {
      name: place ? (place.customer ? (place.name ?? booking.name) : place.name) : null,
      participantId: place?.participantId ?? null,
      places: count,
      price,
      refund,
      kept: paid && how !== "pass" && how !== "none" ? roundMoney(price - refund) : 0,
      owedLess: paid ? 0 : price,
      units,
      how: !paid && price > 0 ? "none" : how,
      late: terms.late,
      keptPercent: terms.late ? terms.keptPercent : null,
      released: court.capacity > 1 ? count : 0,
    },
  };
}

/**
 * Each person on a booking, and the places nobody is named on, with whether
 * they can be taken off now and what it would do; or why nobody can.
 */
export async function withdrawOptions(booking: Booking, by: WithdrawBy): Promise<WithdrawOption[]> {
  const store = await storeModule();
  const court = await store.bookedCourt(booking);
  if (!court) return [];
  const places = (await placesOf(booking.id)).filter((p) => p.placeId !== null);
  const out: WithdrawOption[] = [];
  const say = (r: Refusal) => ({ error: r.error, ...(r.code ? { code: r.code } : {}), ...(r.vars ? { vars: r.vars } : {}) });
  for (const p of places) {
    const what: WithdrawWhat = p.customer ? { customer: true } : { participantId: p.participantId ?? -1 };
    const a = await assess(booking, court, what, by);
    out.push({
      ...("ok" in a ? { refusal: say(a) } : a.outcome),
      who: p.customer ? "customer" : "participant",
      placeId: p.placeId,
      participantId: p.participantId,
      name: p.customer ? (p.name ?? booking.name) : p.name,
      allowed: !("ok" in a),
    });
  }
  const counted = court.capacity > 1 || court.perPlayer === true;
  const unnamed = counted ? Math.max(0, (booking.players ?? 1) - Math.max(1, places.length)) : 0;
  if (unnamed > 0) {
    const a = await assess(booking, court, { unnamed: 1 }, by);
    out.push({ ...("ok" in a ? { refusal: say(a) } : a.outcome), who: "unnamed", placeId: null, participantId: null, name: null, allowed: !("ok" in a) });
  }
  return out;
}

export type WithdrawResult = { ok: true; booking: Booking; withdrawal: WithdrawOutcome & { id: number } } | Refusal;

class Refused extends Error {
  constructor(readonly refusal: Refusal) {
    super("WITHDRAW_REFUSED");
  }
}

/**
 * Take one person (or places nobody is named on) off a booking: everything a
 * withdrawal changes, in one transaction under the booking's row lock, then
 * the freed place offered to the waiting list and the person's history and
 * the guardian told. Money paid online is noted as owed back here; the caller
 * sends it through the venue's refund path (lib/payments.ts `refundCancelled`).
 */
export async function withdrawPlace(bookingId: number, what: WithdrawWhat, by: WithdrawBy, reason?: string | null): Promise<WithdrawResult> {
  const store = await storeModule();
  const db = getDb();
  let done: { id: number; outcome: WithdrawOutcome } | null = null;
  try {
    done = await withTransaction(async () => {
      const lock = (await db.prepare("SELECT id FROM bookings WHERE id = ? FOR UPDATE").get(bookingId)) as { id: number } | undefined;
      if (!lock) throw new Refused(refuse("BOOKING_NOT_FOUND"));
      const booking = (await store.getBookingById(bookingId))!;
      const court = await store.bookedCourt(booking);
      if (!court) throw new Refused(refuse("COURT_NOT_FOUND"));
      const a = await assess(booking, court, what, by);
      if ("ok" in a) throw new Refused(a);
      const o = a.outcome;
      const w = (await db
        .prepare(
          `INSERT INTO place_withdrawals (booking_id, place_id, takes_part_as, participant_id, name, places, price, paid, refunded, kept, late, kept_percent,
             units_returned, released, by_kind, by_user_id, by_admin_id, by_name, reason, promo_share)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
        )
        .get(
          booking.id,
          a.place?.placeId ?? null,
          a.place ? (a.place.customer ? "customer" : "participant") : "unnamed",
          a.place?.participantId ?? null,
          o.name,
          o.places,
          o.price,
          a.paid,
          o.refund,
          o.kept,
          o.late,
          o.keptPercent,
          o.units,
          o.released,
          by.kind,
          by.kind === "customer" ? by.userId : null,
          by.kind === "staff" ? by.adminId : null,
          by.name,
          reason?.trim().slice(0, 300) || null,
          a.promoShare
        )) as { id: number };

      // The money, the way it was paid; or, not yet paid, the price comes off what is owed.
      if (!a.paid) {
        if (o.price > 0) {
          // A booking-wide discount is shared between the places: exactly the part that went with this place goes with it.
          const before = Math.max(1, booking.players ?? 1);
          if (a.promoShare > 0) await db.prepare("UPDATE promo_uses SET discount = GREATEST(0, discount - ?) WHERE booking_id = ?").run(a.promoShare, booking.id);
          await db
            .prepare("UPDATE bookings SET concession_off = concession_off - ROUND(concession_off * ? / ?, 2) WHERE id = ? AND concession_check IS DISTINCT FROM 'refused'")
            .run(o.places, before, booking.id);
          await db.prepare("UPDATE bookings SET total_price = GREATEST(0, total_price - ?) WHERE id = ?").run(o.price, booking.id);
        }
      } else {
        // The booking's price stays as sold; this place's part of it is settled here (`place_withdrawals.price`, paid).
        if (o.how === "credit" && o.refund > 0) {
          const charges = (await db
            .prepare("SELECT user_id, amount::float AS amount, venue_id FROM wallet_entries WHERE booking_id = ? AND amount < 0 ORDER BY id")
            .all(booking.id)) as { user_id: number; amount: number; venue_id: number | null }[];
          const charged = charges.reduce((s, c) => s - Number(c.amount), 0);
          const why = withPhrase(said("srv.wallet.refund", { code: booking.code }));
          let left = o.refund;
          for (const [i, c] of charges.entries()) {
            const back = i === charges.length - 1 ? roundMoney(left) : roundMoney((-Number(c.amount) / charged) * o.refund);
            left = roundMoney(left - back);
            if (back > 0)
              await db
                .prepare("INSERT INTO wallet_entries (user_id, amount, reason, reason_phrase, booking_id, venue_id, withdrawal_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
                .run(c.user_id, back, ...why, booking.id, c.venue_id, w.id);
          }
        } else if (o.how === "online" && o.refund > 0) {
          // Owed back on the payment, never more than it took; sent through the venue's refund path once this commits.
          await db
            .prepare(
              `UPDATE online_payments p SET refund_due = LEAST(p.amount, p.refund_due + ?)
                WHERE p.status = 'paid' AND p.id = (SELECT pb.payment_id FROM online_payment_bookings pb JOIN online_payments q ON q.id = pb.payment_id
                                                     WHERE pb.booking_id = ? AND q.status = 'paid' ORDER BY q.id DESC LIMIT 1)`
            )
            .run(o.refund, booking.id);
        }
        if (o.refund > 0)
          await creditBookingPlace(booking.id, w.id, o.name ?? `${o.places} place${o.places === 1 ? "" : "s"}`, o.refund, o.late ? "receipt.why.lateCancelled" : "receipt.why.cancelled");
      }
      // A pass spent for the place gives back its entries (rounded down on a late withdrawal), once.
      if (a.paid && booking.paidVia === "pass")
        for (const e of await openSpends(booking.id, a.place, o.places)) {
          const back = Math.floor(-e.delta * a.share);
          if (back > 0)
            await db
              .prepare("INSERT INTO pass_entries (pass_id, delta, reason, booking_id, place_id, settles_entry_id) VALUES (?, ?, ?, ?, ?, ?)")
              .run(e.pass_id, back, `Place taken off ${booking.code}`, booking.id, e.place_id, e.id);
        }

      if (a.place && a.place.placeId !== null) {
        // The place's own benefits go with it, and its part of a code; booking-wide ones stay.
        await db
          .prepare("UPDATE place_benefits SET reversed_at = now(), reversed_why = 'withdrawn' WHERE booking_id = ? AND place_id = ? AND reversed_at IS NULL")
          .run(booking.id, a.place.placeId);
        await db
          .prepare("UPDATE promo_place_shares SET reversed_at = now(), reversed_why = 'withdrawn' WHERE booking_id = ? AND place_id = ? AND reversed_at IS NULL")
          .run(booking.id, a.place.placeId);
        await db.prepare("DELETE FROM booking_participants WHERE id = ?").run(a.place.placeId);
        // The customer left on their own takes the booking alone, as a booking naming nobody does.
        const rest = (await db.prepare("SELECT id, takes_part_as FROM booking_participants WHERE booking_id = ?").all(booking.id)) as { id: number; takes_part_as: string }[];
        if (rest.length === 1 && rest[0].takes_part_as === "customer") {
          await db.prepare("UPDATE place_benefits SET place_id = NULL WHERE booking_id = ? AND place_id = ?").run(booking.id, rest[0].id);
          // Their part of a code is then simply what is left of it (lib/entitlements.ts `placeShares`).
          await db
            .prepare("UPDATE promo_place_shares SET reversed_at = now(), reversed_why = 'repriced' WHERE booking_id = ? AND place_id = ? AND reversed_at IS NULL")
            .run(booking.id, rest[0].id);
          await db.prepare("UPDATE pass_entries SET place_id = NULL WHERE booking_id = ? AND place_id = ?").run(booking.id, rest[0].id);
          await db.prepare("DELETE FROM booking_participants WHERE id = ?").run(rest[0].id);
        }
      }
      // Fewer places: the booking's count, and what it holds of a shared facility.
      if (court.capacity > 1 || court.perPlayer === true)
        await db.prepare("UPDATE bookings SET players = GREATEST(1, players - ?) WHERE id = ?").run(o.places, booking.id);
      if (o.released > 0)
        await db.prepare("UPDATE claims SET places = GREATEST(1, places - ?) WHERE booking_id = ? AND active AND places > 1").run(o.released, booking.id);
      return { id: w.id, outcome: o };
    });
  } catch (err) {
    if (err instanceof Refused) return err.refusal;
    throw err;
  }
  const booking = (await store.getBookingById(bookingId))!;
  // The freed place goes to whoever has waited longest for it.
  if (done.outcome.released > 0) await store.offerSlotPlace(booking.courtId, booking.date);
  if (done.outcome.participantId !== null) {
    const actor: Actor = by.kind === "staff" ? { adminId: by.adminId, name: by.name } : by.userId ? { userId: by.userId, name: by.name } : { system: true };
    const venueId = (await store.getCourt(booking.courtId))?.venueId ?? null;
    await participantEvent(done.outcome.participantId, "booking.withdrawn", actor, { venueId, detail: `${booking.code}${reason ? `: ${reason}` : ""}` });
  }
  return { ok: true, booking, withdrawal: { id: done.id, ...done.outcome } };
}

/**
 * What a request takes off: `{ participantId }`, `{ customer: true }` (the
 * customer stops taking part themself) or `{ unnamed: n }` (places nobody is
 * named on). Null where it says none of these.
 */
export function readWithdrawWhat(body: Record<string, unknown>): WithdrawWhat | null {
  if (Number.isInteger(body.participantId) && (body.participantId as number) > 0) return { participantId: body.participantId as number };
  // The place's own row, as staff screens list each person (`people[].placeId`).
  if (Number.isInteger(body.placeId) && (body.placeId as number) > 0) return { placeId: body.placeId as number };
  if (body.customer === true) return { customer: true };
  if (Number.isInteger(body.unnamed) && (body.unnamed as number) > 0 && (body.unnamed as number) <= 50) return { unnamed: body.unnamed as number };
  return null;
}

/** The language a booking was made in, for what staff's changes to it tell the customer; English for one made before that was kept. */
export async function bookingLocale(bookingId: number): Promise<Locale> {
  const row = (await getDb().prepare("SELECT locale FROM bookings WHERE id = ?").get(bookingId)) as { locale: string | null } | undefined;
  return row?.locale && isLocale(row.locale) ? row.locale : "en";
}

/** The money line of a withdrawal, as the customer is told it. */
export function withdrawMoney(locale: Locale, o: Pick<WithdrawOutcome, "refund" | "kept" | "owedLess" | "units" | "price" | "how">): string {
  const t = translator(locale);
  if (o.price <= 0 && o.units <= 0) return t("ent.msg.noPrice");
  const parts: string[] = [];
  if (o.owedLess > 0) parts.push(t("ent.msg.owedLess", { amount: money(o.owedLess) }));
  if (o.kept > 0) parts.push(t("ent.msg.kept", { kept: money(o.kept) }));
  if (o.refund > 0) parts.push(t(o.how === "credit" ? "ent.msg.toCredit" : o.how === "online" ? "ent.msg.toCard" : "ent.msg.byHand", { amount: money(o.refund) }));
  if (o.units > 0) parts.push(t("ent.msg.toPass", { n: o.units }));
  // Paid for as a whole (a pass for the booking): nothing of it was one person's.
  if (parts.length === 0) parts.push(t("ent.msg.wholeStays"));
  return parts.join(" ");
}

/**
 * Tell the customer (the guardian) who is off their booking, and what that did
 * to the money: by email, naming the person. Nothing to a venue never live.
 */
export async function notifyWithdrawn(booking: Booking, withdrawal: WithdrawOutcome & { id: number }, locale: Locale): Promise<void> {
  const email = booking.email?.trim();
  if (!email) return;
  const store = await storeModule();
  const court = await store.getCourt(booking.courtId);
  const venue = court ? await store.getVenue(court.venueId) : null;
  if (!court || !venue || !hasBeenLive(venue)) return;
  const t = translator(locale);
  const who = withdrawal.name ?? t("ent.msg.places", { n: withdrawal.places });
  await enqueue({
    bookingId: booking.id,
    venueId: venue.id,
    kind: "booking_cancelled",
    channel: "email",
    recipient: email,
    locale,
    subject: "ent.msg.withdrawnSubject",
    body: "ent.msg.withdrawn",
    dedupeKey: `withdrawn:${booking.code}:${withdrawal.id}`,
    vars: {
      name: booking.name.trim().split(/\s+/)[0] || booking.name.trim(),
      who,
      code: booking.code,
      where: t("msg.where", { court: court.name, venue: venue.name }),
      when: t("msg.when", { date: booking.date, ...hourRange(booking.startHour, booking.endHour) }),
      money: withdrawMoney(locale, withdrawal),
    },
  });
}
