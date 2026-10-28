import crypto from "crypto";
import { fold, icsText, toUtcStamp } from "./booking-links";
import { getDb } from "./db";
import { clockRange, money } from "./region";
import { siteName } from "./site";
import { venueBaseUrl } from "./storefront";
import { addDays, todayISO } from "./time";
import { linkIn } from "./link-locale";
import { staffLocale, staffLocales, staffTranslator, STAFF_LOCALES, type StaffLocale } from "./staff-i18n";
import type { Locale } from "./i18n";
import { venueZoneOf } from "./zones";

/**
 * A venue's bookings and classes as a calendar its staff subscribe to in
 * Google Calendar, Outlook or their phone, so the day's courts are where the
 * rest of their day is. Read-only, refreshed by the calendar app itself.
 *
 * The address carries a long random token instead of a sign-in, since a
 * calendar app cannot sign in. It shows customers' names and numbers, so it
 * is kept only as a hash, as coaches' links are (lib/coach-schedule.ts): the
 * address is shown once, when a manager makes it, and lapses after
 * `FEED_DAYS`. A manager can replace it, which stops the old one working, or
 * turn it off.
 */

/** From a week back, for what just happened, to as far ahead as anybody can book. */
const DAYS_BACK = 7;
const DAYS_AHEAD = 90;

/** How long an address works before a manager has to make a new one. */
export const FEED_DAYS = 365;

const feedHash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());

/** Whether the feed is on, since when and until when; the address itself is not kept to show again. */
export interface FeedStatus {
  on: boolean;
  madeAt: string | null;
  expiresAt: string | null;
  /** On, but past its expiry: it answers nothing until a manager makes a new address. */
  lapsed: boolean;
}

export async function feedStatus(venueId: number): Promise<FeedStatus> {
  const row = (await getDb()
    .prepare("SELECT calendar_feed_hash, calendar_feed_made_at, calendar_feed_expires_at, calendar_feed_expires_at <= now() AS lapsed FROM venues WHERE id = ?")
    .get(venueId)) as { calendar_feed_hash: string | null; calendar_feed_made_at: unknown; calendar_feed_expires_at: unknown; lapsed: boolean | null } | undefined;
  if (!row?.calendar_feed_hash) return { on: false, madeAt: null, expiresAt: null, lapsed: false };
  return { on: true, madeAt: iso(row.calendar_feed_made_at), expiresAt: iso(row.calendar_feed_expires_at), lapsed: row.lapsed === true };
}

/**
 * Turn the feed on with a fresh address (the old one, if any, stops working),
 * shown this once, or off. The token is the address's secret part.
 */
export async function setFeed(venueId: number, on: boolean): Promise<{ token: string; status: FeedStatus } | null> {
  const token = on ? crypto.randomBytes(24).toString("base64url") : null;
  await getDb()
    .prepare(
      `UPDATE venues SET calendar_feed_hash = ?, calendar_token = NULL,
              calendar_feed_made_at = ${on ? "now()" : "NULL"},
              calendar_feed_expires_at = ${on ? `now() + interval '${FEED_DAYS} days'` : "NULL"}
        WHERE id = ?`
    )
    .run(token ? feedHash(token) : null, venueId);
  return token ? { token, status: await feedStatus(venueId) } : null;
}

/**
 * The address to subscribe to, on the venue's own domain where it has one,
 * naming the staff language its words and times are in (`?lang=`), where one
 * is given: the language of whoever turned the feed on or looked it up.
 */
export async function feedUrl(venueId: number, token: string, locale?: StaffLocale): Promise<string> {
  const url = `${await venueBaseUrl(venueId)}/api/calendar/${token}.ics`;
  return locale ? linkIn(url, locale) : url;
}

/** The feed's language from its address: one of the staff languages this install offers, else its first. */
export function feedLocale(raw: string | null | undefined): StaffLocale {
  return typeof raw === "string" && (STAFF_LOCALES as readonly string[]).includes(raw) ? staffLocale(raw as Locale) : staffLocales()[0];
}

export async function venueForFeed(token: string): Promise<number | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const row = (await getDb()
    .prepare("SELECT id FROM venues WHERE calendar_feed_hash = ? AND calendar_feed_expires_at > now()")
    .get(feedHash(token))) as { id: number } | undefined;
  return row?.id ?? null;
}

interface BookingRow {
  code: string;
  date: string;
  start_min: number;
  end_min: number;
  name: string;
  phone: string;
  /** Who takes part, where the booking names somebody other than its customer (lib/participant-bookings.ts). */
  participant_name: string | null;
  total_price: number;
  payment_status: string;
  court_name: string;
  coach_name: string | null;
}

interface ClassRow {
  id: number;
  name: string;
  instructor: string;
  date: string;
  start_min: number;
  end_min: number;
  capacity: number;
  court_name: string;
  enrolled: number;
}

/**
 * The venue's calendar file, now. What people read (each event's title and
 * description, the calendar's name) is in the staff language `locale`, times
 * as it writes them; what calendar apps read (start, end, zone, ids) is as
 * iCalendar has it.
 */
export async function staffCalendar(venueId: number, locale: StaffLocale = staffLocales()[0]): Promise<string> {
  const t = staffTranslator(locale);
  const db = getDb();
  const venue = (await db.prepare("SELECT name, address, time_zone, lat, lng FROM venues WHERE id = ?").get(venueId)) as {
    name: string;
    address: string;
    time_zone: string | null;
    lat: number | null;
    lng: number | null;
  };
  const zone = venueZoneOf(venue);
  const today = todayISO(zone);
  const from = addDays(today, -DAYS_BACK);
  const until = addDays(today, DAYS_AHEAD);
  const bookings = (await db
    .prepare(
      `SELECT b.code, b.date, b.start_min, b.end_min, b.name, b.phone, b.participant_name, b.total_price, b.payment_status,
              c.name AS court_name, k.name AS coach_name
         FROM bookings b JOIN courts c ON c.id = b.court_id LEFT JOIN coaches k ON k.id = b.coach_id
        WHERE c.venue_id = ? AND b.status = 'confirmed' AND b.class_id IS NULL AND b.date BETWEEN ? AND ?
        ORDER BY b.date, b.start_min`
    )
    .all(venueId, from, until)) as BookingRow[];
  const classes = (await db
    .prepare(
      `SELECT k.id, k.name, k.instructor, k.date, k.start_min, k.end_min, k.capacity, c.name AS court_name,
              (SELECT COUNT(*)::int FROM bookings e WHERE e.class_id = k.id AND e.status = 'confirmed') AS enrolled
         FROM classes k JOIN courts c ON c.id = k.court_id
        WHERE c.venue_id = ? AND k.status = 'scheduled' AND k.date BETWEEN ? AND ?
        ORDER BY k.date, k.start_min`
    )
    .all(venueId, from, until)) as ClassRow[];

  const host = new URL(await venueBaseUrl(venueId)).host;
  const stamp = toUtcStamp(today, 0, zone);
  // Times as minutes of the business day.
  const event = (uid: string, date: string, start: number, end: number, summary: string, description: string) => [
    "BEGIN:VEVENT",
    `UID:${uid}@${host}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${toUtcStamp(date, start / 60, zone)}`,
    `DTEND:${toUtcStamp(date, end / 60, zone)}`,
    `SUMMARY:${icsText(summary)}`,
    `DESCRIPTION:${icsText(description)}`,
    `LOCATION:${icsText(venue.address)}`,
    "END:VEVENT",
  ];
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${icsText(siteName())}//Staff calendar//EN`,
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(t("tl7.ics.calName", { venue: venue.name }))}`,
    `X-WR-TIMEZONE:${zone}`,
    // Calendar apps that honour it look again every half hour.
    "REFRESH-INTERVAL;VALUE=DURATION:PT30M",
    "X-PUBLISHED-TTL:PT30M",
    ...bookings.flatMap((b) =>
      event(
        `booking-${b.code}`,
        b.date,
        Number(b.start_min),
        Number(b.end_min),
        summaryOf(t, b),
        [
          `${b.code}, ${clockRange(Number(b.start_min), Number(b.end_min), locale)}`,
          `${b.name}, ${b.phone}`,
          t(b.payment_status === "paid" ? "tl7.ics.paid" : "tl7.ics.notPaid", { amount: money(Number(b.total_price)) }),
        ].join("\n")
      )
    ),
    ...classes.flatMap((k) =>
      event(
        `class-${k.id}`,
        k.date,
        Number(k.start_min),
        Number(k.end_min),
        `${k.name} (${k.enrolled}/${k.capacity})`,
        t("tl7.ics.class", { court: k.court_name, instructor: k.instructor, enrolled: k.enrolled, capacity: k.capacity })
      )
    ),
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

/** A booking's title: the court and who, the coach of a lesson, and "(unpaid)" while something is owed. */
function summaryOf(t: ReturnType<typeof staffTranslator>, b: BookingRow): string {
  let what = t("tl7.ics.summary", { court: b.court_name, who: b.participant_name ? t("tl7.ics.bookedBy", { participant: b.participant_name, name: b.name }) : b.name });
  if (b.coach_name) what = t("tl7.ics.withCoach", { what, coach: b.coach_name });
  return b.payment_status === "paid" || Number(b.total_price) === 0 ? what : t("tl7.ics.unpaid", { what });
}
