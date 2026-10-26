import crypto from "crypto";
import { fold, icsText, toUtcStamp } from "./booking-links";
import { getDb } from "./db";
import { money } from "./region";
import { siteName } from "./site";
import { venueBaseUrl } from "./storefront";
import { addDays, todayISO } from "./time";
import { formatMinute } from "./interval";
import { venueZoneOf } from "./zones";

/**
 * A venue's bookings and classes as a calendar its staff subscribe to in
 * Google Calendar, Outlook or their phone, so the day's courts are where the
 * rest of their day is. Read-only, refreshed by the calendar app itself.
 *
 * The address carries a long random token instead of a sign-in, since a
 * calendar app cannot sign in. It shows customers' names and numbers, so a
 * manager can replace it, which stops the old one working, or turn it off.
 */

/** From a week back, for what just happened, to as far ahead as anybody can book. */
const DAYS_BACK = 7;
const DAYS_AHEAD = 90;

export async function feedToken(venueId: number): Promise<string | null> {
  const row = (await getDb().prepare("SELECT calendar_token FROM venues WHERE id = ?").get(venueId)) as
    | { calendar_token: string | null }
    | undefined;
  return row?.calendar_token ?? null;
}

/** Turn the feed on with a fresh address (the old one, if any, stops working), or off. */
export async function setFeed(venueId: number, on: boolean): Promise<string | null> {
  const token = on ? crypto.randomBytes(24).toString("base64url") : null;
  await getDb().prepare("UPDATE venues SET calendar_token = ? WHERE id = ?").run(token, venueId);
  return token;
}

/** The address to subscribe to, on the venue's own domain where it has one. */
export async function feedUrl(venueId: number, token: string): Promise<string> {
  return `${await venueBaseUrl(venueId)}/api/calendar/${token}.ics`;
}

export async function venueForFeed(token: string): Promise<number | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const row = (await getDb().prepare("SELECT id FROM venues WHERE calendar_token = ?").get(token)) as { id: number } | undefined;
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

/** The venue's calendar file, now. */
export async function staffCalendar(venueId: number): Promise<string> {
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
    `X-WR-CALNAME:${icsText(`${venue.name} bookings`)}`,
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
        `${b.court_name}: ${b.participant_name ? `${b.participant_name}, booked by ${b.name}` : b.name}${b.coach_name ? `, lesson with ${b.coach_name}` : ""}${b.payment_status === "paid" || Number(b.total_price) === 0 ? "" : " (unpaid)"}`,
        [
          `${b.code}, ${formatMinute(Number(b.start_min))}–${formatMinute(Number(b.end_min))}`,
          `${b.name}, ${b.phone}`,
          `${money(Number(b.total_price))}, ${b.payment_status === "paid" ? "paid" : "not paid yet"}`,
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
        `${k.court_name}, with ${k.instructor}. ${k.enrolled} of ${k.capacity} places taken.`
      )
    ),
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
