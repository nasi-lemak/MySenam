import { hasBeenLive } from "./listing";
import { hoursOf } from "./interval";
import { coachNames } from "./coaching";
import { refundLines } from "./refund-text";
import type { CancelRefund } from "./payments";
import { getDb } from "./db";
import { cancelClassSession, findBooking, getClass, getClassRoster, getCourt, getVenue, venueHours } from "./store";
import { Booking, WAITLIST_OFFER_MINUTES, type ClassSession } from "./types";
import { isLocale, Locale, translator, type Phrase } from "./i18n";
import { drainOutbox, enqueue, hourRange, sentences } from "./outbox";
import type { Channel, Compose } from "./outbox";
import { icsCalendar } from "./booking-links";
import { siteName } from "./site";
import { whatsappFor } from "./whatsapp-credit";
import { createNotice } from "./urgent";
import { takesPaymentOnline } from "./payments";
import { venueBaseUrl } from "./storefront";
import type { DrainResult, OutboxMessage } from "./outbox";
import { money, shortDate } from "./region";
import { slotStartsAt } from "./time";
import { venueZoneOf } from "./zones";
import { longEnough } from "./phone";
import { taxIncluded, venueTax } from "./tax";
import { receiptPath } from "./receipts";
import { linkIn } from "./link-locale";
import { bookingLinkPath } from "./booking-access";
import { clockValue, said, type ServerPhrase, type StaffText } from "./staff-text";
import { chosenStaffLocale, staffReaderLocale, type StaffLocale } from "./staff-locales";

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
  if (whatsapp && message.venueId !== null && person.phone.trim() && (await whatsappFor(message.venueId, message.kind)))
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
function calendarFor(
  bookings: Booking[],
  court: string | ((b: Booking) => string),
  venue: { name: string; address: string; timeZone?: string }
): string {
  return icsCalendar(
    bookings.map((b) => ({
      siteName: siteName(),
      code: b.code,
      date: b.date,
      startHour: b.startHour,
      endHour: b.endHour,
      courtName: typeof court === "string" ? court : court(b),
      venueName: venue.name,
      venueAddress: venue.address,
      timeZone: venue.timeZone,
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

  // Several courts at the same time, booked as one: one message naming each court and its code.
  const group = !seriesCode && bookings.length > 1 && !!first.groupCode && bookings.every((b) => b.groupCode === first.groupCode);
  const names = new Map<number, string>();
  if (group) for (const b of bookings) names.set(b.courtId, (await getCourt(b.courtId))?.name ?? court.name);
  const series = bookings.length > 1 && !group;
  const total = bookings.reduce((sum, b) => sum + b.totalPrice, 0);
  const code = seriesCode ?? (group ? first.groupCode! : first.code);
  // A lesson says who is coaching it, where the court is named.
  const coach = first.coachId ? (await coachNames([first.id])).get(first.id) : undefined;
  const courtNames = group ? [...new Set(bookings.map((b) => names.get(b.courtId)!))].join(", ") : court.name;
  // Who it is for, where it names somebody other than its customer, who is told (lib/participant-bookings.ts).
  const where = forWhom(locale, coach ? translator(locale)("msg.lesson", { court: court.name, coach }) : courtNames, namesOn(bookings));

  await alertVenue(bookings, code, courtNames, venue);
  return await deliver(first, {
    bookingId: first.id,
    venueId: venue.id,
    kind: series ? "booking_series_confirmed" : "booking_confirmed",
    calendar: calendarFor(bookings, group ? (b) => names.get(b.courtId)! : court.name, venue),
    locale,
    subject: series ? "msg.seriesSubject" : "msg.confirmedSubject",
    body: series ? "msg.series" : "msg.confirmed",
    // A retried request must not confirm the same booking twice.
    dedupeKey: `confirmed:${code}`,
    vars: {
      name: firstName(first.name),
      // Each court's own code, which is what the desk and /my-booking take.
      code: group ? bookings.map((b) => `${b.code} (${names.get(b.courtId)})`).join(", ") : code,
      venue: venue.name,
      weeks: bookings.length,
      ...slot(locale, where, venue.name, first),
      total: await totalLine(locale, total, bookings.every((b) => b.paymentStatus === "paid"), venue.id),
      // Back to the site they booked on (the venue's storefront, if it has one), on the booking itself:
      // its signed link opens it without the code and phone typed again (lib/booking-access.ts).
      link: linkIn(`${await venueBaseUrl(venue.id)}${bookingLinkPath(first.code, first.date)}`, locale),
    },
  });
}

/**
 * Where a venue hears about bookings made online: its own address and
 * WhatsApp number, if it chose them, and the staff language the alerts are
 * written in (null: none chosen, the install's first staff language).
 */
export interface BookingAlerts {
  email: string | null;
  phone: string | null;
  locale: StaffLocale | null;
}

export async function bookingAlerts(venueId: number): Promise<BookingAlerts> {
  const row = (await getDb().prepare("SELECT alert_email, alert_phone, alert_locale FROM venues WHERE id = ?").get(venueId)) as
    | { alert_email: string | null; alert_phone: string | null; alert_locale: string | null }
    | undefined;
  return { email: row?.alert_email ?? null, phone: row?.alert_phone ?? null, locale: chosenStaffLocale(row?.alert_locale) };
}

/** `locale` left out keeps the language already chosen; null or "" is none chosen. */
export async function setBookingAlerts(
  venueId: number,
  input: { email?: unknown; phone?: unknown; locale?: unknown }
): Promise<{ ok: true; alerts: BookingAlerts } | { ok: false; error: string }> {
  const email = typeof input.email === "string" ? input.email.trim() : "";
  const phone = typeof input.phone === "string" ? input.phone.trim() : "";
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "That email address does not look right." };
  if (phone && !longEnough(phone)) return { ok: false, error: "That phone number is too short." };
  const keep = input.locale === undefined;
  const locale = chosenStaffLocale(input.locale);
  if (!keep && locale === null && input.locale !== null && input.locale !== "")
    return { ok: false, error: "The dashboard is not offered in that language." };
  await getDb()
    .prepare(`UPDATE venues SET alert_email = ?, alert_phone = ?${keep ? "" : ", alert_locale = ?"} WHERE id = ?`)
    .run(email || null, phone || null, ...(keep ? [] : [locale]), venueId);
  return { ok: true, alerts: await bookingAlerts(venueId) };
}

/**
 * Tell the venue a customer booked online: by email, and on WhatsApp where
 * the venue sends WhatsApp at all (each one counts against its messages).
 * Once per booking, in the language the venue chose for its alerts (else
 * the install's first staff language), the hours as it writes them; staff
 * bookings, made at the desk, are not announced to the desk.
 */
async function alertVenue(bookings: Booking[], code: string, courtName: string, venue: { id: number; name: string }): Promise<void> {
  const alerts = await bookingAlerts(venue.id);
  if (!alerts.email && !alerts.phone) return;
  const first = bookings[0];
  const locale = staffReaderLocale(alerts.locale);
  const t = translator(locale);
  const total = bookings.reduce((sum, b) => sum + b.totalPrice, 0);
  const { where, when } = slot(locale, courtName, venue.name, first);
  const message = {
    bookingId: first.id,
    venueId: venue.id,
    kind: "venue_new_booking" as const,
    locale,
    subject: "msg.venueNewBookingSubject" as const,
    body: "msg.venueNewBooking" as const,
    vars: {
      name: first.name,
      phone: first.phone,
      where,
      when: bookings.length > 1 ? `${when} (${bookings.length}×)` : when,
      code,
      amount: total === 0 ? t("price.free") : money(total),
      paid: t(bookings.every((b) => b.paymentStatus === "paid") ? "msg.alertPaid" : "msg.alertUnpaid"),
    },
  };
  if (alerts.email)
    await enqueue({ ...message, channel: "email", recipient: alerts.email, dedupeKey: `venuenew:${code}:email` });
  if (alerts.phone && (await whatsappFor(venue.id, "venue_new_booking")))
    await enqueue({ ...message, channel: "whatsapp", recipient: alerts.phone, dedupeKey: `venuenew:${code}:whatsapp` });
}

/**
 * Whether the venue also hears when a customer cancels online, or changes a
 * booking's time or who is on it, at the same address and number as new
 * bookings (migration 0237). Both off unless the venue turns them on; only
 * for bookings starting within `withinHours` of the change (a day unless the
 * venue widens it; null: any booking).
 */
export interface ChangeAlerts {
  cancellations: boolean;
  changes: boolean;
  withinHours: number | null;
}

/** The hours a venue may choose to hear about changes within (null: any time ahead). */
export const CHANGE_ALERT_WINDOWS = [24, 48, 168, null] as const;

export async function changeAlerts(venueId: number): Promise<ChangeAlerts> {
  const row = (await getDb()
    .prepare("SELECT alert_cancellations, alert_changes, alert_change_hours FROM venues WHERE id = ?")
    .get(venueId)) as { alert_cancellations: boolean; alert_changes: boolean; alert_change_hours: number | null } | undefined;
  return {
    cancellations: row?.alert_cancellations === true,
    changes: row?.alert_changes === true,
    withinHours: row ? row.alert_change_hours : 24,
  };
}

export async function setChangeAlerts(
  venueId: number,
  input: { cancellations?: unknown; changes?: unknown; withinHours?: unknown }
): Promise<{ ok: true; changes: ChangeAlerts } | { ok: false; error: string }> {
  const now = await changeAlerts(venueId);
  const within = input.withinHours === undefined ? now.withinHours : input.withinHours === null ? null : Number(input.withinHours);
  if (!(CHANGE_ALERT_WINDOWS as readonly (number | null)[]).includes(within))
    return { ok: false, error: "Hear about changes to bookings within a day, two days, a week, or any time ahead." };
  const flag = (v: unknown, was: boolean) => (v === undefined ? was : v === true);
  await getDb()
    .prepare("UPDATE venues SET alert_cancellations = ?, alert_changes = ?, alert_change_hours = ? WHERE id = ?")
    .run(flag(input.cancellations, now.cancellations), flag(input.changes, now.changes), within, venueId);
  return { ok: true, changes: await changeAlerts(venueId) };
}

/**
 * Tell the venue a customer cancelled or changed a booking online, where it
 * asked to hear (`changeAlerts`): through the outbox, by email and on
 * WhatsApp as new-booking alerts go, in the install's first language. Only
 * bookings starting soon enough to matter (the venue's window, measured from
 * now to the booking's start, or to its old start for a change); for several
 * at once (a series), one message for the first of those, with how many.
 */
async function alertVenueChange(
  /** Cancelled whole; its date, time or court changed; or somebody taken off it (lib/place-withdrawals.ts). */
  what: "cancelled" | "changed" | "withdrawn",
  bookings: Booking[],
  venue: { id: number; name: string },
  courtName: string,
  was?: Pick<Booking, "date" | "startMin"> | null,
  /** Tells apart two changes of the same booking at the same time (two withdrawals). */
  tag?: string
): Promise<void> {
  const settings = await changeAlerts(venue.id);
  if (what === "cancelled" ? !settings.cancellations : !settings.changes) return;
  const alerts = await bookingAlerts(venue.id);
  if (!alerts.email && !alerts.phone) return;
  const zone = (await venueHours(venue.id)).zone;
  const startsAt = (b: Pick<Booking, "date" | "startMin">) => slotStartsAt(b.date, b.startMin / 60, zone).getTime();
  const soon = (b: Pick<Booking, "date" | "startMin">) =>
    settings.withinHours === null || startsAt(b) - Date.now() <= settings.withinHours * 3_600_000;
  const within = bookings.filter((b) => soon(b) || (was ? soon(was) : false));
  const first = within[0];
  if (!first) return;
  const locale = staffReaderLocale(alerts.locale);
  const t = translator(locale);
  const { where, when } = slot(locale, courtName, venue.name, first);
  const wasWhen = was
    ? slot(locale, courtName, venue.name, {
        date: was.date,
        startHour: was.startMin / 60,
        endHour: (was.startMin + first.endMin - first.startMin) / 60,
      }).when
    : null;
  const message = {
    bookingId: first.id,
    venueId: venue.id,
    kind: "venue_booking_change" as const,
    locale,
    subject: "p8c.msg.venueChangeSubject" as const,
    body: "p8c.msg.venueChange" as const,
    vars: {
      what:
        what === "cancelled"
          ? t("p8c.msg.whatCancelled")
          : what === "withdrawn"
            ? t("p8c.msg.whatWithdrawn")
            : wasWhen
              ? t("p8c.msg.whatChangedFrom", { was: wasWhen })
              : t("p8c.msg.whatChanged"),
      name: first.name,
      phone: first.phone,
      where,
      when: within.length > 1 ? `${when} (${within.length}×)` : when,
      code: first.seriesCode && within.length > 1 ? first.seriesCode : first.code,
    },
  };
  const key = `venue${what}:${first.code}:${first.date}:${first.startMin}${tag ? `:${tag}` : ""}`;
  if (alerts.email) await enqueue({ ...message, channel: "email", recipient: alerts.email, dedupeKey: `${key}:email` });
  if (alerts.phone && (await whatsappFor(venue.id, "venue_booking_change")))
    await enqueue({ ...message, channel: "whatsapp", recipient: alerts.phone, dedupeKey: `${key}:whatsapp` });
}

/** A customer took somebody off their booking online (lib/place-withdrawals.ts): the venue hears, where it asked to. */
export async function alertVenueWithdrawn(booking: Booking, withdrawalId: number): Promise<void> {
  const court = await getCourt(booking.courtId);
  const venue = court ? await getVenue(court.venueId) : null;
  if (!court || !venue || !hasBeenLive(venue)) return;
  await alertVenueChange("withdrawn", [booking], venue, court.name, null, `w${withdrawalId}`);
}

/** Tell a customer a booking is off, and that they owe nothing for it. */
export async function notifyBookingCancelled(
  booking: Booking,
  locale: Locale,
  /** What it cost and how the money is going back, for a cancellation by the customer. */
  outcome: { kept?: number | null; refunds?: CancelRefund[] } = {}
): Promise<OutboxMessage | null> {
  const court = await getCourt(booking.courtId);
  if (!court) return null;
  const venue = await getVenue(court.venueId);
  // Nobody hears from a venue that has never been live: its bookings are
  // its own staff trying it out, under whatever number they typed.
  if (!venue || !hasBeenLive(venue)) return null;
  // Only customers cancel through here (api/bookings/cancel, api/my/bookings/cancel): the venue hears, if it asked.
  await alertVenueChange("cancelled", [booking], venue, court.name);

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
      money: cancelMoney(locale, outcome),
    },
  });
}

/** Tell a customer the weeks of a series they cancelled are off: one message, not one a week. */
export async function notifySeriesCancelled(
  bookings: Booking[],
  locale: Locale,
  outcome: { refunds?: CancelRefund[] } = {}
): Promise<OutboxMessage | null> {
  if (bookings.length === 0) return null;
  const first = [...bookings].sort((a, b) => a.date.localeCompare(b.date))[0];
  const court = await getCourt(first.courtId);
  if (!court) return null;
  const venue = await getVenue(court.venueId);
  if (!venue || !hasBeenLive(venue)) return null;
  const t = translator(locale);
  const where = slot(locale, court.name, venue.name, first);
  // Only customers cancel a series through here (api/bookings/cancel-series): the venue hears of the weeks soon enough to matter.
  await alertVenueChange("cancelled", [...bookings].sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin), venue, court.name);
  return await deliver(first, {
    bookingId: first.id,
    venueId: venue.id,
    kind: "booking_cancelled",
    locale,
    subject: "msg.cancelledSubject",
    body: "msg.cancelled",
    dedupeKey: `cancelled-series:${first.seriesCode ?? first.code}:${first.code}`,
    vars: {
      name: firstName(first.name),
      code: first.seriesCode ?? first.code,
      venue: venue.name,
      where: where.where,
      when: t("msg.seriesWhen", { n: bookings.length, from: where.when }),
      money: cancelMoney(locale, outcome),
    },
  });
}

/** The money line of a cancellation: a fee kept, refunds on their way, or nothing owed. */
function cancelMoney(locale: Locale, outcome: { kept?: number | null; refunds?: CancelRefund[] }): string {
  const t = translator(locale);
  const lines = [
    ...(outcome.kept ? [t("msg.keptFee", { kept: money(outcome.kept) })] : []),
    ...refundLines(t, outcome.refunds),
  ];
  return lines.length > 0 ? lines.join(" ") : t("msg.owedNothing");
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
      what: forWhom(locale, session.name, namesOn([booking])),
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
  const { from } = hourRange(input.startHour, input.startHour + 1, input.locale);

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
      // With its weekday, in the reader's language (audit R8 X2-16).
      date: shortDate(input.date, input.locale, true),
      from,
      // In the language the offer is written in, unless they have chosen one (lib/link-locale.ts).
      link: linkIn(`${await venueBaseUrl(venue.id)}/waitlist/${input.token}`, input.locale),
    },
  });
}

/**
 * Tell somebody who joined a waiting list that they are on it, with the
 * private link to leave it again (audit R8 X2-9): a guest who joined from the
 * grid or a class page has no account to do it from, and somebody who found
 * another court should not keep being offered this one. By email only, where
 * they gave an address: it is a receipt of what they did, not news worth a
 * WhatsApp message; the joined screen shows the same link.
 */
export async function notifyWaitlistJoined(input: {
  entryId: number;
  venueId: number;
  name: string;
  phone: string;
  email?: string | null;
  locale: Locale;
  what: string;
  date: string;
  startHour: number;
  position: number;
  leaveToken: string;
}): Promise<OutboxMessage | null> {
  const venue = await getVenue(input.venueId);
  // Nobody hears from a venue that has never been live: its entries are its own staff trying it out.
  if (!venue || !hasBeenLive(venue)) return null;
  const { from } = hourRange(input.startHour, input.startHour + 1, input.locale);
  return await deliver(
    input,
    {
      venueId: venue.id,
      kind: "waitlist_joined",
      locale: input.locale,
      subject: "q8b.msg.joinedSubject",
      body: "q8b.msg.joined",
      dedupeKey: `joined:${input.entryId}`,
      vars: {
        name: firstName(input.name),
        what: input.what,
        venue: venue.name,
        date: shortDate(input.date, input.locale, true),
        from,
        position: input.position,
        leave: linkIn(`${await venueBaseUrl(venue.id)}/waitlist/leave/${input.leaveToken}`, input.locale),
      },
    },
    false
  );
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
  start_min: number | null;
  class_name: string | null;
  court_name: string | null;
  venue_id: number | null;
  for_names: string | null;
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
              COALESCE(c.start_min, w.start_min) AS start_min,
              c.name AS class_name,
              ct.name AS court_name,
              (SELECT string_agg(wp.name, ', ' ORDER BY wp.id) FROM waitlist_participants wp WHERE wp.waitlist_id = w.id AND wp.name IS NOT NULL) AS for_names,
              COALESCE(cc.venue_id, ct.venue_id) AS venue_id
         FROM waitlist w
         LEFT JOIN classes c  ON c.id  = w.class_id
         LEFT JOIN courts  cc ON cc.id = c.court_id
         LEFT JOIN courts  ct ON ct.id = w.court_id
        WHERE w.status = 'offered'
          AND w.offer_token IS NOT NULL
          AND NOT EXISTS (
                SELECT 1 FROM messages m WHERE m.dedupe_key = 'offer:' || w.offer_token
              )
          -- Nothing to a number the venue has refused since the offer was made (its claim is refused).
          AND NOT EXISTS (
                SELECT 1 FROM venue_blocked_phones bp
                 WHERE bp.venue_id = COALESCE(cc.venue_id, ct.venue_id) AND bp.phone_key = phone_key(w.phone)
              )`
    )
    .all() as OfferRow[];

  const written: OutboxMessage[] = [];
  for (const row of rows) {
    if (row.venue_id === null) continue;
    const place = row.class_name ?? row.court_name;
    if (!place || !row.date || row.start_min === null) continue;
    // The entry's people, kept from when it was made: the offer says who it is for.
    const what = forWhom(isLocale(row.locale) ? row.locale : "en", place, row.for_names);
    const message = await notifyWaitlistOffer({
      venueId: row.venue_id,
      name: row.name,
      phone: row.phone,
      email: row.email,
      locale: isLocale(row.locale) ? row.locale : "en",
      what,
      date: row.date,
      startHour: hoursOf(row.start_min),
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
  // Password resets asked for are worked through after their reply; any a server stopped before reaching are done here.
  await (await import("./password-reset")).processResetRequests();
  // Sign-ups asked for, the same way (lib/registration.ts).
  await (await import("./registration")).processRegistrationRequests();
  await notifyPendingOffers();
  // Reminders look over three days of bookings: once a minute is soon enough, not on every request.
  if (Date.now() - remindersLooked.at >= 60_000) {
    remindersLooked.at = Date.now();
    await notifyReminders();
    // Players in somebody else's open game: the booking's reminder goes to its host only.
    await (await import("./games")).remindPlayers();
  }
  const drained = await drainOutbox();
  // A guardian notice given up, or reported undelivered, becomes the venue's task to tell them (lib/contact-guardians.ts).
  await (await import("./contact-guardians")).taskUndeliveredNotices();
  return drained;
}

const remindersLooked = { at: 0 };

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
    // The day with its weekday, in the reader's language (audit R8 X2-16): "Sat, 31 Oct", "Sab, 31 Okt".
    when: t("msg.when", { date: shortDate(at.date, locale, true), ...hourRange(at.startHour, at.endHour, locale) }),
  };
}

/**
 * An urgent notice's line for the staff's list, as a phrase they read in the
 * staff language: what the venue did to the booking, where and when. The
 * summary stored beside it keeps the customer's language for where and when.
 */
function noticePhrase(
  key: ServerPhrase,
  venue: string,
  code: string,
  court: string,
  at: { date: string; startHour: number; endHour: number }
): StaffText {
  return said(key, {
    venue,
    code,
    where: said("srv.urgent.where", { court, venue }),
    // The hours as times of day, said in the staff language where the notice is read; its English as before.
    when: said("srv.urgent.when", { date: at.date, from: clockValue(at.startHour * 60), to: clockValue(at.endHour * 60) }),
  });
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
/**
 * What a message is about, and who it is for where the booking names
 * somebody other than its customer: "Court 1, for Alya". The account holder
 * or guardian is the one told; a participant needs no email or phone of
 * their own, and only their name is said.
 */
function forWhom(locale: Locale, what: string, names: string | null | undefined): string {
  return names ? translator(locale)("pbk.msg.for", { what, names }) : what;
}

/** Everybody the bookings name (their summary, lib/participants.ts), once each. */
function namesOn(bookings: { participantName?: string | null }[]): string | null {
  const names = [...new Set(bookings.flatMap((b) => (b.participantName ? b.participantName.split(", ") : [])))];
  return names.length > 0 ? names.join(", ") : null;
}

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
 *
 * With `why`, the message says why, above what is owed (in the same
 * parameter, so the WhatsApp template stays as Meta approved it): a built-in
 * reason in the customer's own language, or what staff typed, as typed.
 */
export async function notifyVenueCancelled(
  booking: Booking,
  what?: string,
  why?: CancelReason,
  /** What became of the money, where staff settled it otherwise than in full the way it was paid (lib/counter-refunds.ts). */
  settled?: { phrase: Phrase; vars: Record<string, string> }
): Promise<number | null> {
  const court = await getCourt(booking.courtId);
  if (!court) return null;
  const venue = await getVenue(court.venueId);
  if (!venue || !hasBeenLive(venue)) return null;
  const locale = await localeOf(booking.id);
  const t = translator(locale);
  const place = what ? `${what} (${court.name})` : court.name;
  const { where, when } = slot(locale, place, venue.name, booking);
  const reason = why ? ("phrase" in why ? t(why.phrase) : why.text.trim()) : "";
  const owed = settled ? t(settled.phrase, settled.vars) : t(booking.paymentStatus === "paid" ? "msg.refundOwed" : "msg.nothingOwed");
  const notice = await createNotice({
    venueId: venue.id,
    bookingId: booking.id,
    kind: "cancelled",
    name: booking.name,
    phone: booking.phone,
    email: booking.email ?? null,
    date: booking.date,
    startMin: booking.startMin,
    summary: `${venue.name} cancelled booking ${booking.code}: ${where}, ${when}.`,
    summaryPhrase: noticePhrase("srv.urgent.cancelled", venue.name, booking.code, place, booking),
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
      money: reason ? `${t("pre.why", { reason })}\n${owed}` : owed,
      ack: linkIn(`${await venueBaseUrl(venue.id)}/ack/${notice.token}`, locale),
    },
  });
  return notice.id;
}

/**
 * Why the venue cancelled, for the customer's message: a built-in reason by
 * its phrase, written in each customer's language, or what staff typed.
 */
export type CancelReason = { phrase: Phrase } | { text: string };

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
    startMin: booking.startMin,
    summary: `${venue.name} moved booking ${booking.code} to ${where}, ${when}.`,
    summaryPhrase: noticePhrase("srv.urgent.moved", venue.name, booking.code, court.name, booking),
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
      ack: linkIn(`${await venueBaseUrl(venue.id)}/ack/${notice.token}`, locale),
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
  priceChange: number,
  /** Where it was before, for the venue's change alert (`alertVenueChange`). */
  was?: Pick<Booking, "date" | "startMin"> | null
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
    await alertVenueChange("changed", [booking], venue, court.name, was);
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
          link: linkIn(`${await venueBaseUrl(venue.id)}${bookingLinkPath(booking.code, booking.date)}`, locale),
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
    startMin: booking.startMin,
    summary: `${venue.name} changed booking ${booking.code} to ${where}, ${when}.`,
    summaryPhrase: noticePhrase("srv.urgent.changed", venue.name, booking.code, court.name, booking),
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
      ack: linkIn(`${await venueBaseUrl(venue.id)}/ack/${notice.token}`, locale),
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
          receiptUrl: linkIn(`${await venueBaseUrl(venue.id)}${receiptPath(booking.code)}`, locale),
          // Whom it is for, where it names somebody other than its customer: a guardian paying for children sees which booking is whose.
          ...slot(locale, forWhom(locale, court.name, namesOn([booking])), venue.name, booking),
        },
      },
      false
    );
  }
}


/**
 * The day before: a reminder for every booking starting within the next 24
 * hours that was made longer ago than that — somebody who booked this
 * afternoon for tonight does not need reminding. By email always; on WhatsApp
 * too only where the venue has chosen it, since each one costs a message.
 * Once per booking, however often this runs.
 */
export async function notifyReminders(now = new Date()): Promise<number> {
  // Wide enough for a venue anywhere on the clock; each is then held to its own zone.
  const from = new Date(now.getTime() - 24 * 3_600_000).toISOString().slice(0, 10);
  const to = new Date(now.getTime() + 48 * 3_600_000).toISOString().slice(0, 10);
  const rows = (await getDb()
    .prepare(
      `SELECT b.*, v.whatsapp_reminders, v.time_zone AS venue_time_zone, v.lat AS venue_lat, v.lng AS venue_lng FROM bookings b
         JOIN courts c ON c.id = b.court_id JOIN venues v ON v.id = c.venue_id
        WHERE b.status = 'confirmed' AND b.demo = 0 AND b.date >= ? AND b.date <= ?
          AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.dedupe_key = 'reminder:' || b.code)`
    )
    .all(from, to)) as (Record<string, unknown> & {
    whatsapp_reminders: number;
    venue_time_zone: string | null;
    venue_lat: number | null;
    venue_lng: number | null;
  })[];
  let written = 0;
  for (const r of rows) {
    const zone = venueZoneOf({ time_zone: r.venue_time_zone, lat: r.venue_lat, lng: r.venue_lng });
    const start = slotStartsAt(r.date as string, hoursOf(r.start_min as number), zone).getTime();
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
          ...slot(locale, forWhom(locale, court.name, (r.participant_name as string | null) ?? null), venue.name, { date: r.date as string, startHour: hoursOf(r.start_min as number), endHour: hoursOf(r.end_min as number) }),
          link: linkIn(`${await venueBaseUrl(venue.id)}${bookingLinkPath(r.code as string, r.date as string)}`, locale),
        },
      },
      r.whatsapp_reminders === 1
    );
    if (message) written++;
  }
  return written;
}

/** Call off a class and tell everybody enrolled in it, as a venue cancellation each. */
export async function cancelClassAndTell(
  classId: number,
  why?: CancelReason
): Promise<{ ok: boolean; released: number; error?: string; session?: ClassSession; cancelled?: Booking[] }> {
  const session = await getClass(classId);
  // How each stood before (paid or not), for the activity log; the refund changes it.
  const before = new Map((await getClassRoster(classId)).map((b) => [b.id, b]));
  const result = await cancelClassSession(classId);
  if (!result.ok || !session) return result;
  // Exactly the enrolments it cancelled: not one its customer had just cancelled, nor miss one made a moment before.
  const ids = new Set(result.cancelledIds ?? []);
  const cancelled = (await getClassRoster(classId))
    .filter((b) => ids.has(b.id))
    .map((b) => ({ ...b, status: "cancelled" as const, paymentStatus: before.get(b.id)?.paymentStatus ?? b.paymentStatus }));
  for (const b of cancelled) await notifyVenueCancelled(b, session.name, why);
  return { ...result, session, cancelled };
}

/**
 * A class's name or instructor changed (lib/class-changes.ts `changeClass`):
 * the facts people signed up for. Everybody enrolled in a session changed,
 * and everybody holding a live offer of a place in one, is told once per
 * change: one email for several sessions of a series, in the language they
 * enrolled or joined the list in. Not for its price (for enrolments from now
 * on: nobody's changes) or its places. By email only, where they gave an
 * address, as the waiting-list receipt is: there is no WhatsApp template for
 * it, and the class still runs when and where it did. Returns how many were
 * written.
 */
export async function notifyClassChanged(changed: { before: ClassSession; after: ClassSession }[]): Promise<number> {
  const first = changed[0];
  if (!first) return 0;
  const renamed = first.before.name !== first.after.name;
  const newInstructor = first.before.instructor !== first.after.instructor;
  if (!renamed && !newInstructor) return 0;
  const venue = await getVenue(first.after.venueId);
  if (!venue || !hasBeenLive(venue)) return 0;
  const what = (locale: Locale) => {
    const t = translator(locale);
    return sentences(
      t,
      renamed && t("r9d.msg.newName", { name: first.after.name, old: first.before.name }),
      newInstructor && t("r9d.msg.newInstructor", { instructor: first.after.instructor, old: first.before.instructor })
    );
  };
  const when = (locale: Locale, sessions: ClassSession[]) => {
    const { when: at } = slot(locale, sessions[0].courtName, venue.name, sessions[0]);
    return sessions.length > 1 ? translator(locale)("msg.seriesWhen", { n: sessions.length, from: at }) : at;
  };
  // One change, one key: written again (a retry), nothing is sent twice.
  const change = `${first.after.id}:${Date.now()}`;
  let written = 0;

  // Enrolled: each address once, with every session of theirs that changed.
  const people = new Map<string, { booking: Booking; sessions: ClassSession[] }>();
  for (const { after } of changed)
    for (const b of await getClassRoster(after.id)) {
      const email = b.email?.trim().toLowerCase();
      if (b.status !== "confirmed" || !email) continue;
      const known = people.get(email);
      if (!known) people.set(email, { booking: b, sessions: [after] });
      else if (!known.sessions.some((s) => s.id === after.id)) known.sessions.push(after);
    }
  for (const [email, { booking, sessions }] of people) {
    const locale = await localeOf(booking.id);
    const message = await deliver(
      { phone: "", email: booking.email },
      {
        bookingId: booking.id,
        venueId: venue.id,
        kind: "class_changed",
        locale,
        subject: "r9d.msg.classChangedSubject",
        body: "r9d.msg.classChanged",
        dedupeKey: `classchg:${change}:${email}`,
        vars: { name: firstName(booking.name), what: first.after.name, venue: venue.name, when: when(locale, sessions), changes: what(locale), code: booking.code },
      },
      false
    );
    if (message) written++;
  }

  // Offered a place and not yet taken it: told too, with the offer's own link.
  const since = new Date(Date.now() - WAITLIST_OFFER_MINUTES * 60_000).toISOString().replace("T", " ").slice(0, 19);
  const ids = changed.map((c) => c.after.id);
  const offers = (await getDb()
    .prepare(
      `SELECT id, name, email, locale, offer_token, class_id FROM waitlist
        WHERE class_id IN (${ids.map(() => "?").join(",")}) AND status = 'offered' AND offered_at > ? AND offer_token IS NOT NULL ORDER BY id`
    )
    .all(...ids, since)) as { id: number; name: string; email: string | null; locale: string | null; offer_token: string; class_id: number }[];
  for (const o of offers) {
    const email = o.email?.trim();
    if (!email) continue;
    const locale: Locale = o.locale && isLocale(o.locale) ? o.locale : "en";
    const session = changed.find((c) => c.after.id === o.class_id)!.after;
    const message = await deliver(
      { phone: "", email },
      {
        venueId: venue.id,
        kind: "class_changed",
        locale,
        subject: "r9d.msg.classChangedSubject",
        body: "r9d.msg.classChangedOffered",
        dedupeKey: `classchg:${change}:offer:${o.id}`,
        vars: {
          name: firstName(o.name),
          what: first.after.name,
          venue: venue.name,
          when: when(locale, [session]),
          changes: what(locale),
          link: linkIn(`${await venueBaseUrl(venue.id)}/waitlist/${o.offer_token}`, locale),
        },
      },
      false
    );
    if (message) written++;
  }
  return written;
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

/**
 * The venue moved weeks of a weekly series in one step (lib/series-moves.ts): the customer is told once, as for a
 * single booking the venue moves (the notice they acknowledge, `msg.rescheduled`), with every week moved in the
 * calendar file. Weeks not paid yet and priced again at their new time say what they now come to.
 */
export async function notifySeriesMoved(seriesCode: string, moved: { booking: Booking; priceChange: number }[]): Promise<number | null> {
  if (moved.length === 0) return null;
  const weeks = [...moved].sort((a, b) => a.booking.date.localeCompare(b.booking.date) || a.booking.startMin - b.booking.startMin);
  const first = weeks[0].booking;
  const court = await getCourt(first.courtId);
  if (!court) return null;
  const venue = await getVenue(court.venueId);
  if (!venue || !hasBeenLive(venue)) return null;
  const locale = await localeOf(first.id);
  const t = translator(locale);
  const at = slot(locale, court.name, venue.name, first);
  const repriced = weeks.filter((w) => w.priceChange !== 0 && w.booking.paymentStatus !== "paid");
  const unpaid = weeks.filter((w) => w.booking.paymentStatus !== "paid").reduce((sum, w) => sum + w.booking.totalPrice, 0);
  const courts = new Map<number, string>();
  for (const w of weeks) if (!courts.has(w.booking.courtId)) courts.set(w.booking.courtId, (await getCourt(w.booking.courtId))?.name ?? court.name);
  const code = seriesCode.trim().toUpperCase();
  const notice = await createNotice({
    venueId: venue.id,
    bookingId: first.id,
    kind: "moved",
    name: first.name,
    phone: first.phone,
    email: first.email ?? null,
    date: first.date,
    startMin: first.startMin,
    summary: `${venue.name} changed ${weeks.length} week(s) of series ${code} to ${at.where}, from ${at.when}.`,
    summaryPhrase: noticePhrase("srv.urgent.changed", venue.name, code, court.name, first),
  });
  await deliver(first, {
    bookingId: first.id,
    venueId: venue.id,
    kind: "booking_rescheduled",
    locale,
    subject: "msg.rescheduledSubject",
    body: "msg.rescheduled",
    dedupeKey: `rescheduled-series:${code}:${notice.id}`,
    noticeId: notice.id,
    calendar: calendarFor(
      weeks.map((w) => w.booking),
      (b) => courts.get(b.courtId) ?? court.name,
      venue
    ),
    vars: {
      name: firstName(first.name),
      venue: venue.name,
      code,
      where: at.where,
      when: t("msg.seriesWhen", { n: weeks.length, from: at.when }),
      money: repriced.length > 0 ? t("r9e.msg.priceWeeks", { total: unpaid.toFixed(2) }) : t("msg.priceSame"),
      ack: linkIn(`${await venueBaseUrl(venue.id)}/ack/${notice.token}`, locale),
    },
  });
  return notice.id;
}
