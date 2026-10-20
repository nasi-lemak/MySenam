import { hasBeenLive } from "./listing";
import { getDb } from "./db";
import { cancelClassSession, findBooking, getClass, getClassRoster, getCourt, getVenue } from "./store";
import { Booking } from "./types";
import { isLocale, Locale, translator } from "./i18n";
import { drainOutbox, enqueue, hourRange } from "./outbox";
import type { Channel, Compose } from "./outbox";
import { icsCalendar } from "./booking-links";
import { siteName } from "./site";
import { whatsappFor } from "./whatsapp-credit";
import { createNotice } from "./urgent";
import { takesPaymentOnline } from "./payments";
import { venueBaseUrl } from "./storefront";
import type { DrainResult, OutboxMessage } from "./outbox";
import { offsetMs, region } from "./region";
import { taxIncluded, venueTax } from "./tax";
import { receiptPath } from "./receipts";

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

/**
 * Write one message to every way this customer is reached, and return the
 * first. Email whenever they gave an address — it is free and carries the
 * calendar invite. WhatsApp as well for urgent news unless the venue has
 * switched it off, and for everything else where the venue has chosen it and,
 * on a marketplace, has credit (lib/whatsapp-credit.ts). Neither: nothing is
 * written, and the booking code on the confirmation screen is what they have.
 *
 * The first message keeps the given dedupe key, which is what other code
 * looks messages up by; a second channel's copy has the channel added to it.
 */
async function deliver(
  person: { phone: string; email?: string | null },
  message: Omit<Compose, "channel" | "recipient">,
  /** False: by email only — a receipt, or a reminder the venue keeps off WhatsApp. */
  whatsapp = true
) {
  const to: { channel: Channel; recipient: string }[] = [];
  const email = person.email?.trim();
  if (email) to.push({ channel: "email", recipient: email });
  if (whatsapp && person.phone.trim() && (await whatsappFor(message.venueId, message.kind)))
    to.push({ channel: "whatsapp", recipient: person.phone.trim() });
  let first = null;
  for (const [i, address] of to.entries()) {
    const written = await enqueue({
      ...message,
      ...address,
      dedupeKey: message.dedupeKey && i > 0 ? `${message.dedupeKey}:${address.channel}` : message.dedupeKey,
    });
    first ??= written;
  }
  return first;
}

/** The booking, or each week of a series, as a calendar file. */
function calendarFor(bookings: Booking[], court: string, venue: { name: string; address: string }): string {
  return icsCalendar(
    bookings.map((b) => ({
      siteName: siteName(),
      code: b.code,
      date: b.date,
      startHour: b.startHour,
      endHour: b.endHour,
      courtName: court,
      venueName: venue.name,
      venueAddress: venue.address,
      totalPrice: b.totalPrice,
    }))
  );
}

/** Tell a customer their booking stands. */
export async function notifyBookingConfirmed(
  bookings: Booking[],
  locale: Locale,
  seriesCode: string | null
): Promise<OutboxMessage | null> {
  const first = bookings[0];
  if (!first) return null;
  const court = await getCourt(first.courtId);
  if (!court) return null;
  const venue = await getVenue(court.venueId);
  // Nobody hears from a venue that has never been live: its bookings are
  // its own staff trying it out, under whatever number they typed.
  if (!venue || !hasBeenLive(venue)) return null;

  const series = bookings.length > 1;
  const total = bookings.reduce((sum, b) => sum + b.totalPrice, 0);
  const code = seriesCode ?? first.code;

  return await deliver(first, {
    bookingId: first.id,
    venueId: venue.id,
    kind: series ? "booking_series_confirmed" : "booking_confirmed",
    calendar: calendarFor(bookings, court.name, venue),
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
      total: await totalLine(locale, total, bookings.every((b) => b.paymentStatus === "paid"), venue.id),
      // Back to the site they booked on: the venue's storefront, if it has one.
      link: `${await venueBaseUrl(venue.id)}/my-booking`,
    },
  });
}

/** Tell a customer a booking is off, and that they owe nothing for it. */
export async function notifyBookingCancelled(
  booking: Booking,
  locale: Locale
): Promise<OutboxMessage | null> {
  const court = await getCourt(booking.courtId);
  if (!court) return null;
  const venue = await getVenue(court.venueId);
  // Nobody hears from a venue that has never been live: its bookings are
  // its own staff trying it out, under whatever number they typed.
  if (!venue || !hasBeenLive(venue)) return null;

  return await deliver(booking, {
    bookingId: booking.id,
    venueId: venue.id,
    kind: "booking_cancelled",
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
export async function notifyClassEnrolled(
  booking: Booking,
  locale: Locale,
  session: { name: string; instructor: string }
): Promise<OutboxMessage | null> {
  const court = await getCourt(booking.courtId);
  if (!court) return null;
  const venue = await getVenue(court.venueId);
  // Nobody hears from a venue that has never been live: its bookings are
  // its own staff trying it out, under whatever number they typed.
  if (!venue || !hasBeenLive(venue)) return null;

  return await deliver(booking, {
    bookingId: booking.id,
    venueId: venue.id,
    kind: "class_enrolled",
    calendar: calendarFor([booking], `${session.name} (${court.name})`, venue),
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
      total: await totalLine(locale, booking.totalPrice, booking.paymentStatus === "paid", venue.id),
    },
  });
}

/**
 * Tell somebody at the front of a waitlist that a place is theirs to take.
 *
 * This is the message that most earns its keep: an offer expires, and an offer
 * nobody was told about expires having helped nobody at all.
 */
export async function notifyWaitlistOffer(input: {
  venueId: number;
  name: string;
  phone: string;
  email?: string | null;
  locale: Locale;
  what: string;
  date: string;
  startHour: number;
  token: string;
}): Promise<OutboxMessage | null> {
  const venue = await getVenue(input.venueId);
  // Nobody hears from a venue that has never been live: its bookings are
  // its own staff trying it out, under whatever number they typed.
  if (!venue || !hasBeenLive(venue)) return null;
  const { from } = hourRange(input.startHour, input.startHour + 1);

  return await deliver(input, {
    venueId: venue.id,
    kind: "waitlist_offer",
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
      link: `${await venueBaseUrl(venue.id)}/waitlist/${input.token}`,
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
export async function notifyPendingOffers(): Promise<OutboxMessage[]> {
  const rows = await getDb()
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
    const message = await notifyWaitlistOffer({
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
  await notifyPendingOffers();
  await notifyReminders();
  return await drainOutbox();
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
async function totalLine(locale: Locale, amount: number, paid: boolean, venueId: number): Promise<string> {
  const t = translator(locale);
  if (amount === 0) return t("msg.totalFree");
  const payment = paid
    ? "msg.paid"
    : await takesPaymentOnline(venueId)
      ? "msg.payAtCounterOrOnline"
      : "msg.payAtCounter";
  return t("msg.total", { amount, payment: t(payment) });
}

/** "Nurul Hana" → "Nurul". A message is not a form. */
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name.trim();
}

// ------------------------------------------------------------- from the venue

/** The language a booking was made in, or English for one made before that was kept. */
async function localeOf(bookingId: number): Promise<Locale> {
  const row = (await getDb().prepare("SELECT locale FROM bookings WHERE id = ?").get(bookingId)) as { locale: string | null } | undefined;
  return row?.locale && isLocale(row.locale) ? row.locale : "en";
}

/** Remember the language a booking was made in, for what the venue tells them later. */
export async function rememberLocale(bookingIds: number[], locale: Locale): Promise<void> {
  if (bookingIds.length === 0) return;
  await getDb()
    .prepare(`UPDATE bookings SET locale = ? WHERE id IN (${bookingIds.map(() => "?").join(",")})`)
    .run(locale, ...bookingIds);
}

/**
 * The venue cancelled a booking — at the desk, by closing the day, by taking
 * the court out of service, or by calling off the class. The customer is told
 * on everything that reaches them, with a link to say they have seen it, and
 * the notice stays on the staff's list until they have (lib/urgent.ts). With
 * nothing to reach them on, the notice is there all the same, for a call.
 */
export async function notifyVenueCancelled(booking: Booking, what?: string): Promise<number | null> {
  const court = await getCourt(booking.courtId);
  if (!court) return null;
  const venue = await getVenue(court.venueId);
  if (!venue || !hasBeenLive(venue)) return null;
  const locale = await localeOf(booking.id);
  const t = translator(locale);
  const place = what ? `${what} (${court.name})` : court.name;
  const { where, when } = slot(locale, place, venue.name, booking);
  const notice = await createNotice({
    venueId: venue.id,
    bookingId: booking.id,
    kind: "cancelled",
    name: booking.name,
    phone: booking.phone,
    email: booking.email ?? null,
    date: booking.date,
    startHour: booking.startHour,
    summary: `${venue.name} cancelled booking ${booking.code}: ${where}, ${when}.`,
  });
  await deliver(booking, {
    bookingId: booking.id,
    venueId: venue.id,
    kind: "booking_cancelled_by_venue",
    locale,
    subject: "msg.venueCancelledSubject",
    body: "msg.venueCancelled",
    dedupeKey: `vcancelled:${booking.code}`,
    noticeId: notice.id,
    vars: {
      name: firstName(booking.name),
      venue: venue.name,
      code: booking.code,
      where,
      when,
      money: t(booking.paymentStatus === "paid" ? "msg.refundOwed" : "msg.nothingOwed"),
      ack: `${await venueBaseUrl(venue.id)}/ack/${notice.token}`,
    },
  });
  return notice.id;
}

/** The venue moved a booking to another court: same time, same price. */
export async function notifyMoved(booking: Booking): Promise<number | null> {
  const court = await getCourt(booking.courtId);
  if (!court) return null;
  const venue = await getVenue(court.venueId);
  if (!venue || !hasBeenLive(venue)) return null;
  const locale = await localeOf(booking.id);
  const { where, when } = slot(locale, court.name, venue.name, booking);
  const notice = await createNotice({
    venueId: venue.id,
    bookingId: booking.id,
    kind: "moved",
    name: booking.name,
    phone: booking.phone,
    email: booking.email ?? null,
    date: booking.date,
    startHour: booking.startHour,
    summary: `${venue.name} moved booking ${booking.code} to ${where}, ${when}.`,
  });
  await deliver(booking, {
    bookingId: booking.id,
    venueId: venue.id,
    kind: "booking_moved",
    locale,
    subject: "msg.movedSubject",
    body: "msg.moved",
    // Moved twice is told twice.
    dedupeKey: `moved:${booking.code}:${notice.id}`,
    noticeId: notice.id,
    calendar: calendarFor([booking], court.name, venue),
    vars: {
      name: firstName(booking.name),
      venue: venue.name,
      code: booking.code,
      where,
      when,
      ack: `${await venueBaseUrl(venue.id)}/ack/${notice.token}`,
    },
  });
  return notice.id;
}

/**
 * Tell a customer their booking is at a new date or time. Changed by the
 * venue, it is urgent news they are asked to acknowledge, like a move;
 * changed by the customer, it is an email with the calendar invite updated.
 */
export async function notifyRescheduled(
  booking: Booking,
  by: "staff" | "customer",
  priceChange: number
): Promise<number | null> {
  const court = await getCourt(booking.courtId);
  if (!court) return null;
  const venue = await getVenue(court.venueId);
  if (!venue || !hasBeenLive(venue)) return null;
  const locale = await localeOf(booking.id);
  const t = translator(locale);
  const { where, when } = slot(locale, court.name, venue.name, booking);
  const money =
    priceChange !== 0 && booking.paymentStatus !== "paid"
      ? t("msg.priceNow", { total: booking.totalPrice.toFixed(2) })
      : t("msg.priceSame");
  const calendar = calendarFor([booking], court.name, venue);
  if (by === "customer") {
    await deliver(
      booking,
      {
        bookingId: booking.id,
        venueId: venue.id,
        kind: "booking_rescheduled",
        locale,
        subject: "msg.changedSubject",
        body: "msg.changed",
        dedupeKey: `changed:${booking.code}:${booking.date}:${booking.startHour}:${booking.courtId}`,
        calendar,
        vars: {
          name: firstName(booking.name),
          venue: venue.name,
          code: booking.code,
          where,
          when,
          money,
          link: `${await venueBaseUrl(venue.id)}/my-booking`,
        },
      },
      false
    );
    return null;
  }
  const notice = await createNotice({
    venueId: venue.id,
    bookingId: booking.id,
    kind: "moved",
    name: booking.name,
    phone: booking.phone,
    email: booking.email ?? null,
    date: booking.date,
    startHour: booking.startHour,
    summary: `${venue.name} changed booking ${booking.code} to ${where}, ${when}.`,
  });
  await deliver(booking, {
    bookingId: booking.id,
    venueId: venue.id,
    kind: "booking_rescheduled",
    locale,
    subject: "msg.rescheduledSubject",
    body: "msg.rescheduled",
    dedupeKey: `rescheduled:${booking.code}:${notice.id}`,
    noticeId: notice.id,
    calendar,
    vars: {
      name: firstName(booking.name),
      venue: venue.name,
      code: booking.code,
      where,
      when,
      money,
      ack: `${await venueBaseUrl(venue.id)}/ack/${notice.token}`,
    },
  });
  return notice.id;
}

/**
 * A receipt, by email, when a booking is paid after it was made — online
 * later, or at the counter. One paid as it was booked (credit, a pass) says
 * so in its confirmation already.
 */
export async function notifyPaid(bookings: Booking[], how: "online" | "counter"): Promise<void> {
  for (const booking of bookings) {
    if (!booking.email || booking.totalPrice <= 0) continue;
    const court = await getCourt(booking.courtId);
    if (!court) continue;
    const venue = await getVenue(court.venueId);
    if (!venue || !hasBeenLive(venue)) continue;
    const locale = await localeOf(booking.id);
    // The tax inside the price, where the venue charges it (lib/tax.ts).
    const tax = booking.taxRate ? await venueTax(venue.id) : null;
    const taxLine =
      tax && booking.taxRate
        ? translator(locale)("msg.receiptTax", {
            tax: tax.name,
            taxAmount: taxIncluded(booking.totalPrice, booking.taxRate),
            rate: booking.taxRate,
          })
        : "";
    await deliver(
      booking,
      {
        bookingId: booking.id,
        venueId: venue.id,
        kind: "payment_received",
        locale,
        subject: "msg.receiptSubject",
        body: "msg.receipt",
        dedupeKey: `paid:${booking.code}`,
        vars: {
          name: firstName(booking.name),
          venue: venue.name,
          code: booking.code,
          amount: booking.totalPrice,
          how: translator(locale)(how === "online" ? "msg.howOnline" : "msg.howCounter"),
          taxLine,
          receiptUrl: `${await venueBaseUrl(venue.id)}${receiptPath(booking.code)}`,
          ...slot(locale, court.name, venue.name, booking),
        },
      },
      false
    );
  }
}

/** The start of a booking (local time) as a moment. */
function startsAt(date: string, hour: number): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d, hour - region().utcOffsetHours);
}

/**
 * The day before: a reminder for every booking starting within the next 24
 * hours that was made longer ago than that — somebody who booked this
 * afternoon for tonight does not need reminding. By email always; on WhatsApp
 * too only where the venue has chosen it, since each one costs a message.
 * Once per booking, however often this runs.
 */
export async function notifyReminders(now = new Date()): Promise<number> {
  const today = new Date(now.getTime() + offsetMs()).toISOString().slice(0, 10);
  const tomorrow = new Date(now.getTime() + 32 * 3_600_000).toISOString().slice(0, 10);
  const rows = (await getDb()
    .prepare(
      `SELECT b.*, v.whatsapp_reminders FROM bookings b
         JOIN courts c ON c.id = b.court_id JOIN venues v ON v.id = c.venue_id
        WHERE b.status = 'confirmed' AND b.demo = 0 AND b.date IN (?, ?)
          AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.dedupe_key = 'reminder:' || b.code)`
    )
    .all(today, tomorrow)) as (Record<string, unknown> & { whatsapp_reminders: number })[];
  let written = 0;
  for (const r of rows) {
    const start = startsAt(r.date as string, r.start_hour as number);
    const made = Date.parse(`${(r.created_at as string).replace(" ", "T")}Z`);
    if (start <= now.getTime() || start - now.getTime() > 24 * 3_600_000) continue;
    if (start - made < 24 * 3_600_000) continue;
    const court = await getCourt(r.court_id as number);
    if (!court) continue;
    const venue = await getVenue(court.venueId);
    if (!venue || !hasBeenLive(venue)) continue;
    const locale = r.locale && isLocale(r.locale as string) ? (r.locale as Locale) : "en";
    const booking = { phone: r.phone as string, email: r.email as string | null };
    const message = await deliver(
      booking,
      {
        bookingId: r.id as number,
        venueId: venue.id,
        kind: "booking_reminder",
        locale,
        subject: "msg.reminderSubject",
        body: "msg.reminder",
        dedupeKey: `reminder:${r.code as string}`,
        vars: {
          name: firstName(r.name as string),
          code: r.code as string,
          ...slot(locale, court.name, venue.name, { date: r.date as string, startHour: r.start_hour as number, endHour: r.end_hour as number }),
          link: `${await venueBaseUrl(venue.id)}/my-booking`,
        },
      },
      r.whatsapp_reminders === 1
    );
    if (message) written++;
  }
  return written;
}

/** Call off a class and tell everybody enrolled in it, as a venue cancellation each. */
export async function cancelClassAndTell(classId: number): Promise<{ ok: boolean; released: number; error?: string }> {
  const session = await getClass(classId);
  const enrolled = (await getClassRoster(classId)).filter((b) => b.status === "confirmed");
  const result = await cancelClassSession(classId);
  if (!result.ok || !session) return result;
  for (const b of enrolled) await notifyVenueCancelled({ ...b, status: "cancelled" }, session.name);
  return result;
}

/** Receipts for every week of a series just marked paid at the counter. */
export async function notifyPaidSeries(seriesCode: string, how: "online" | "counter"): Promise<void> {
  const rows = (await getDb()
    .prepare("SELECT code, phone FROM bookings WHERE UPPER(series_code) = UPPER(?) AND status = 'confirmed' AND payment_status = 'paid'")
    .all(seriesCode.trim())) as { code: string; phone: string }[];
  const bookings: Booking[] = [];
  for (const r of rows) {
    const b = await findBooking(r.code, r.phone);
    if (b) bookings.push(b);
  }
  await notifyPaid(bookings, how);
}
