import { getDb } from "./db";
import { getCourt, getVenue } from "./store";
import { Booking } from "./types";
import { isLocale, Locale, translator } from "./i18n";
import { addressFor, drainOutbox, enqueue, hourRange } from "./outbox";
import { takesPaymentOnline } from "./payments";
import { venueBaseUrl } from "./storefront";
import type { DrainResult, OutboxMessage } from "./outbox";

/**
 * What MySenam tells a customer, and when.
 *
 * This sits between the store, which knows what happened, and the outbox,
 * which knows how to say it — so neither has to know about the other. The
 * store stays free of wording and languages; the outbox stays free of
 * bookings and courts.
 *
 * Every message goes out in the language the customer was reading when they
 * did the thing. That is not a detail: somebody who booked in Bahasa Malaysia
 * and gets an English confirmation has been handed a worse experience than if
 * the site had never offered their language at all.
 */

/** Tell a customer their booking stands. */
export function notifyBookingConfirmed(
  bookings: Booking[],
  locale: Locale,
  seriesCode: string | null
): OutboxMessage | null {
  const first = bookings[0];
  if (!first) return null;
  const court = getCourt(first.courtId);
  if (!court) return null;
  const venue = getVenue(court.venueId);
  if (!venue) return null;

  const series = bookings.length > 1;
  const total = bookings.reduce((sum, b) => sum + b.totalPrice, 0);
  const code = seriesCode ?? first.code;

  return enqueue({
    bookingId: first.id,
    venueId: venue.id,
    kind: series ? "booking_series_confirmed" : "booking_confirmed",
    ...addressFor(first.phone, first.email),
    locale,
    subject: series ? "msg.seriesSubject" : "msg.confirmedSubject",
    body: series ? "msg.series" : "msg.confirmed",
    // A retried request must not confirm the same booking twice.
    dedupeKey: `confirmed:${code}`,
    vars: {
      name: firstName(first.name),
      code,
      venue: venue.name,
      weeks: bookings.length,
      ...slot(locale, court.name, venue.name, first),
      total: totalLine(locale, total, bookings.every((b) => b.paymentStatus === "paid"), venue.id),
      // Back to the site they booked on: the venue's storefront, if it has one.
      link: `${venueBaseUrl(venue.id)}/my-booking`,
    },
  });
}

/** Tell a customer a booking is off, and that they owe nothing for it. */
export function notifyBookingCancelled(
  booking: Booking,
  locale: Locale
): OutboxMessage | null {
  const court = getCourt(booking.courtId);
  if (!court) return null;
  const venue = getVenue(court.venueId);
  if (!venue) return null;

  return enqueue({
    bookingId: booking.id,
    venueId: venue.id,
    kind: "booking_cancelled",
    ...addressFor(booking.phone, booking.email),
    locale,
    subject: "msg.cancelledSubject",
    body: "msg.cancelled",
    dedupeKey: `cancelled:${booking.code}`,
    vars: {
      name: firstName(booking.name),
      code: booking.code,
      venue: venue.name,
      ...slot(locale, court.name, venue.name, booking),
    },
  });
}

/** Tell a customer they are in a class. */
export function notifyClassEnrolled(
  booking: Booking,
  locale: Locale,
  session: { name: string; instructor: string }
): OutboxMessage | null {
  const court = getCourt(booking.courtId);
  if (!court) return null;
  const venue = getVenue(court.venueId);
  if (!venue) return null;

  return enqueue({
    bookingId: booking.id,
    venueId: venue.id,
    kind: "class_enrolled",
    ...addressFor(booking.phone, booking.email),
    locale,
    subject: "msg.enrolledSubject",
    body: "msg.enrolled",
    dedupeKey: `enrolled:${booking.code}`,
    vars: {
      name: firstName(booking.name),
      what: session.name,
      instructor: session.instructor,
      code: booking.code,
      venue: venue.name,
      ...slot(locale, court.name, venue.name, booking),
      total: totalLine(locale, booking.totalPrice, booking.paymentStatus === "paid", venue.id),
    },
  });
}

/**
 * Tell somebody at the front of a waitlist that a place is theirs to take.
 *
 * This is the message that most earns its keep: an offer expires, and an offer
 * nobody was told about expires having helped nobody at all.
 */
export function notifyWaitlistOffer(input: {
  venueId: number;
  name: string;
  phone: string;
  email?: string | null;
  locale: Locale;
  what: string;
  date: string;
  startHour: number;
  token: string;
}): OutboxMessage | null {
  const venue = getVenue(input.venueId);
  if (!venue) return null;
  const { from } = hourRange(input.startHour, input.startHour + 1);

  return enqueue({
    venueId: venue.id,
    kind: "waitlist_offer",
    ...addressFor(input.phone, input.email),
    locale: input.locale,
    subject: "msg.offerSubject",
    body: "msg.offer",
    // The token is what the sweep keys on: one message per offer, and a
    // re-offer to the next person gets a new token and so a new message.
    dedupeKey: `offer:${input.token}`,
    vars: {
      name: firstName(input.name),
      what: input.what,
      venue: venue.name,
      date: input.date,
      from,
      link: `${venueBaseUrl(venue.id)}/waitlist/${input.token}`,
    },
  });
}

interface OfferRow {
  id: number;
  name: string;
  phone: string;
  email: string | null;
  locale: string;
  offer_token: string;
  class_id: number | null;
  court_id: number | null;
  date: string | null;
  start_hour: number | null;
  class_name: string | null;
  court_name: string | null;
  venue_id: number | null;
}

/**
 * Write the message for any live waitlist offer that has not been told about.
 *
 * An offer is created deep inside the store, by somebody else's cancellation,
 * in half a dozen different places. Rather than thread a notification through
 * every one of them — and make the store depend on this file, which depends on
 * the store — this reads the state and says what is missing. The offer token is
 * the dedupe key, so running it twice writes nothing twice, and a re-offer to
 * the next person in the queue gets a new token and so a new message.
 */
export function notifyPendingOffers(): OutboxMessage[] {
  const rows = getDb()
    .prepare(
      `SELECT w.id, w.name, w.phone, w.email, w.locale, w.offer_token,
              w.class_id, w.court_id,
              -- A class entry carries no date of its own; the class has it.
              COALESCE(c.date, w.date) AS date,
              COALESCE(c.start_hour, w.start_hour) AS start_hour,
              c.name AS class_name,
              ct.name AS court_name,
              COALESCE(cc.venue_id, ct.venue_id) AS venue_id
         FROM waitlist w
         LEFT JOIN classes c  ON c.id  = w.class_id
         LEFT JOIN courts  cc ON cc.id = c.court_id
         LEFT JOIN courts  ct ON ct.id = w.court_id
        WHERE w.status = 'offered'
          AND w.offer_token IS NOT NULL
          AND NOT EXISTS (
                SELECT 1 FROM messages m WHERE m.dedupe_key = 'offer:' || w.offer_token
              )`
    )
    .all() as OfferRow[];

  const written: OutboxMessage[] = [];
  for (const row of rows) {
    if (row.venue_id === null) continue;
    const what = row.class_name ?? row.court_name;
    if (!what || !row.date || row.start_hour === null) continue;
    const message = notifyWaitlistOffer({
      venueId: row.venue_id,
      name: row.name,
      phone: row.phone,
      email: row.email,
      locale: isLocale(row.locale) ? row.locale : "en",
      what,
      date: row.date,
      startHour: row.start_hour,
      token: row.offer_token,
    });
    if (message) written.push(message);
  }
  return written;
}

/**
 * Catch up on everything owed, and try to send it.
 *
 * There is no scheduler here — a booking platform that needs a cron running to
 * be correct is one that breaks quietly on a restart — so this is called from
 * the requests that could have caused work, and is cheap when there is none.
 */
export async function tickOutbox(): Promise<DrainResult> {
  notifyPendingOffers();
  return drainOutbox();
}

/**
 * Where and when, each as one phrase.
 *
 * A WhatsApp template with a parameter for every detail is one Meta turns down
 * for having too many parameters for its length, so the court and venue, and
 * the date and hours, travel as one each.
 */
function slot(
  locale: Locale,
  court: string,
  venue: string,
  at: { date: string; startHour: number; endHour: number }
): { where: string; when: string } {
  const t = translator(locale);
  return {
    where: t("msg.where", { court, venue }),
    when: t("msg.when", { date: at.date, ...hourRange(at.startHour, at.endHour) }),
  };
}

/** The total and how it is settled: paid, or still to pay — online too, where the venue takes it. */
function totalLine(locale: Locale, amount: number, paid: boolean, venueId: number): string {
  const t = translator(locale);
  const payment = paid
    ? "msg.paid"
    : takesPaymentOnline(venueId)
      ? "msg.payAtCounterOrOnline"
      : "msg.payAtCounter";
  return t("msg.total", { amount, payment: t(payment) });
}

/** "Nurul Hana" → "Nurul". A message is not a form. */
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name.trim();
}
