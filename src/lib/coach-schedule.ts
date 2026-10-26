import crypto from "crypto";
import { logAction } from "./activity";
import { hoursOf } from "./interval";
import { icsText, toUtcStamp } from "./booking-links";
import { coachById, type Coach } from "./coaching";
import { getDb } from "./db";
import { toCsv } from "./export";
import { enqueue } from "./outbox";
import { money, roundMoney } from "./region";
import { siteName } from "./site";
import { venueBaseUrl } from "./storefront";
import { addDays, formatHour, todayISO } from "./time";
import { venueZoneOf } from "./zones";

/**
 * A coach's side of their lessons (lib/coaching.ts), without an account:
 *
 * - **Their schedule** at a private link, `/coach/<token>`, and the same as a
 *   calendar feed for their phone. A manager turns it on, which makes the
 *   link, and can replace or withdraw it. It shows each student's name and
 *   number, so the coach can reach them; nothing else of the venue's. The
 *   link is shown once, when made: only its hash is kept, and it lapses after
 *   `LINK_DAYS` unless replaced. It sets the coach's own hours and days off,
 *   each change recorded in the venue's activity log under the coach's name;
 *   it decides no applications (that needs an account: lib/approvals.ts).
 * - **An email** when a lesson is booked with them, and when one is
 *   cancelled, where the venue has given their address.
 * - **What they are owed**: the coach's fee on each lesson in a period that
 *   went ahead, split by paid and not yet paid, for the venue to pay them.
 */

const DAYS_BACK = 7;
const DAYS_AHEAD = 90;

/** How long a coach's private link works once made. */
export const LINK_DAYS = 365;

const linkHash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());

export interface CoachContact {
  email: string | null;
  /** Until when their private link works, when one is on; the link itself was shown once, when made. */
  linkUntil: string | null;
}

export async function coachContacts(venueId: number): Promise<Map<number, CoachContact>> {
  const rows = (await getDb()
    .prepare("SELECT id, email, CASE WHEN link_hash IS NOT NULL AND link_expires_at > now() THEN link_expires_at END AS link_until FROM coaches WHERE venue_id = ?")
    .all(venueId)) as { id: number; email: string | null; link_until: unknown }[];
  return new Map(rows.map((r) => [r.id, { email: r.email, linkUntil: iso(r.link_until) }]));
}

export async function setCoachEmail(coachId: number, venueId: number, email: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  const value = typeof email === "string" && email.trim() ? email.trim() : null;
  if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return { ok: false, error: "That email address does not look right." };
  const done = await getDb().prepare("UPDATE coaches SET email = ? WHERE id = ? AND venue_id = ?").run(value, coachId, venueId);
  return done.changes === 1 ? { ok: true } : { ok: false, error: "Coach not found." };
}

export interface NewCoachLink {
  pageUrl: string;
  calendarUrl: string;
  until: string;
}

/**
 * A fresh private link (the old one stops working), shown this once; or, with
 * `on` false, none. Null when the venue has no such coach.
 */
export async function setCoachLink(coachId: number, venueId: number, on: boolean): Promise<{ link: NewCoachLink | null } | null> {
  const token = on ? crypto.randomBytes(24).toString("base64url") : null;
  const row = (await getDb()
    .prepare(
      `UPDATE coaches SET link_hash = ?, link_expires_at = ${on ? `now() + interval '${LINK_DAYS} days'` : "NULL"}, calendar_token = NULL
        WHERE id = ? AND venue_id = ? RETURNING link_expires_at`
    )
    .get(token ? linkHash(token) : null, coachId, venueId)) as { link_expires_at: unknown } | undefined;
  if (!row) return null;
  if (!token) return { link: null };
  const base = await venueBaseUrl(venueId);
  return { link: { pageUrl: `${base}/coach/${token}`, calendarUrl: `${base}/api/coach-calendar/${token}.ics`, until: iso(row.link_expires_at)! } };
}

export interface CoachByToken {
  coach: Coach;
  venueName: string;
  venueAddress: string;
  zone: string;
}

export async function coachForToken(token: string): Promise<CoachByToken | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const row = (await getDb()
    .prepare(
      `SELECT k.id, v.name, v.address, v.time_zone, v.lat, v.lng FROM coaches k JOIN venues v ON v.id = k.venue_id
        WHERE k.link_hash = ? AND k.link_expires_at > now()`
    )
    .get(linkHash(token))) as { id: number; name: string; address: string; time_zone: string | null; lat: number | null; lng: number | null } | undefined;
  if (!row) return null;
  const coach = await coachById(row.id);
  return coach ? { coach, venueName: row.name, venueAddress: row.address, zone: venueZoneOf(row) } : null;
}

/** A change the coach made at their own link, in the venue's activity log under their name. */
export async function logCoachChange(found: CoachByToken, detail: string): Promise<void> {
  await logAction({ id: null, name: found.coach.name }, { venueId: found.coach.venueId, action: "settings.changed", detail: `${found.coach.name}, at their own link: ${detail}` });
}

export interface Lesson {
  code: string;
  date: string;
  startHour: number;
  endHour: number;
  court: string;
  student: string;
  phone: string;
  paid: boolean;
}

/** A coach's lessons still on, between two dates. */
export async function coachLessons(coachId: number, from: string, until: string): Promise<Lesson[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT b.code, b.date, b.start_min, b.end_min, COALESCE(b.participant_name, b.name) AS name, b.phone, b.payment_status, c.name AS court
         FROM bookings b JOIN courts c ON c.id = b.court_id
        WHERE b.coach_id = ? AND b.status = 'confirmed' AND b.date BETWEEN ? AND ?
        ORDER BY b.date, b.start_min`
    )
    .all(coachId, from, until)) as {
    code: string;
    date: string;
    start_min: number;
    end_min: number;
    name: string;
    phone: string;
    payment_status: string;
    court: string;
  }[];
  return rows.map((r) => ({
    code: r.code,
    date: r.date,
    startHour: hoursOf(r.start_min),
    endHour: hoursOf(r.end_min),
    court: r.court,
    student: r.name,
    phone: r.phone,
    paid: r.payment_status === "paid",
  }));
}

/** Their lessons as a calendar file, from a week back to as far ahead as anybody can book. */
export async function coachCalendar(found: CoachByToken, venueId: number): Promise<string> {
  const today = todayISO(found.zone);
  const lessons = await coachLessons(found.coach.id, addDays(today, -DAYS_BACK), addDays(today, DAYS_AHEAD));
  const host = new URL(await venueBaseUrl(venueId)).host;
  const stamp = toUtcStamp(today, 0, found.zone);
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${icsText(siteName())}//Coach calendar//EN`,
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(`Lessons at ${found.venueName}`)}`,
    `X-WR-TIMEZONE:${found.zone}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT30M",
    "X-PUBLISHED-TTL:PT30M",
    ...lessons.flatMap((l) => [
      "BEGIN:VEVENT",
      `UID:lesson-${l.code}@${host}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${toUtcStamp(l.date, l.startHour, found.zone)}`,
      `DTEND:${toUtcStamp(l.date, l.endHour, found.zone)}`,
      `SUMMARY:${icsText(`Lesson: ${l.student}, ${l.court}`)}`,
      `DESCRIPTION:${icsText(`${l.code}, ${formatHour(l.startHour)}–${formatHour(l.endHour)}\n${l.student}, ${l.phone}`)}`,
      `LOCATION:${icsText(found.venueAddress)}`,
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
  ].join("\r\n");
}

/**
 * Tell coaches, by email, of lessons booked with them and of lessons since
 * cancelled. Once each: a lesson's cancellation only if its booking was told.
 */
export async function notifyCoaches(now = new Date()): Promise<number> {
  const db = getDb();
  const since = new Date(now.getTime() - 2 * 86_400_000).toISOString().replace("T", " ").slice(0, 19);
  const rows = (await db
    .prepare(
      `SELECT b.id, b.code, b.date, b.start_min, b.end_min, COALESCE(b.participant_name, b.name) AS name, b.status, k.id AS coach_id, k.name AS coach, k.email,
              c.name AS court, v.id AS venue_id, v.name AS venue,
              EXISTS (SELECT 1 FROM messages m WHERE m.dedupe_key = 'coach-new:' || b.id) AS told
         FROM bookings b JOIN coaches k ON k.id = b.coach_id JOIN courts c ON c.id = b.court_id JOIN venues v ON v.id = c.venue_id
        WHERE k.email IS NOT NULL AND b.demo = 0 AND b.date >= ?
          AND ((b.status = 'confirmed' AND b.created_at >= ?
                AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.dedupe_key = 'coach-new:' || b.id))
               OR (b.status = 'cancelled' AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.dedupe_key = 'coach-cancel:' || b.id)))`
    )
    .all(now.toISOString().slice(0, 10), since)) as {
    id: number;
    code: string;
    date: string;
    start_min: number;
    end_min: number;
    name: string;
    status: string;
    coach_id: number;
    coach: string;
    email: string;
    court: string;
    venue_id: number;
    venue: string;
    told: boolean;
  }[];
  let sent = 0;
  for (const r of rows) {
    const cancelled = r.status === "cancelled";
    if (cancelled && !r.told) continue;
    const vars = {
      name: r.coach.split(/\s+/)[0],
      student: r.name,
      court: r.court,
      venue: r.venue,
      date: r.date,
      time: `${formatHour(hoursOf(r.start_min))}–${formatHour(hoursOf(r.end_min))}`,
      code: r.code,
    };
    await enqueue({
      venueId: r.venue_id,
      bookingId: r.id,
      kind: "coach_lesson",
      channel: "email",
      recipient: r.email,
      locale: "en",
      subject: cancelled ? "msg.coachCancelledSubject" : "msg.coachNewSubject",
      body: cancelled ? "msg.coachCancelled" : "msg.coachNew",
      dedupeKey: `${cancelled ? "coach-cancel" : "coach-new"}:${r.id}`,
      vars,
    });
    sent++;
  }
  return sent;
}

// ------------------------------------------------------------ what coaches are owed

export interface CoachPayout {
  coachId: number;
  coach: string;
  lessons: number;
  hours: number;
  /** Coach fees on lessons that went ahead and are paid. */
  paidFees: number;
  /** On lessons that went ahead and are not paid yet: owed once the venue collects. */
  unpaidFees: number;
  /** Lessons the student did not turn up to, and the fees on them: the venue decides. */
  noShows: number;
  noShowFees: number;
  /** Paid lessons cancelled late, and the coach's fee times the share the venue kept: the venue decides. */
  lateCancels: number;
  lateCancelFees: number;
}

/** Per coach, the lessons in a period (on the lesson's date) and the coach's fees on them. */
export async function coachPayouts(venueId: number, from: string, to: string): Promise<CoachPayout[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT k.id, k.name,
              COUNT(b.id) FILTER (WHERE b.no_show = 0) AS lessons,
              COALESCE(SUM(b.end_min - b.start_min) FILTER (WHERE b.no_show = 0) / 60.0, 0)::float AS hours,
              COALESCE(SUM(b.coach_fee) FILTER (WHERE b.no_show = 0 AND b.payment_status = 'paid'), 0)::float AS paid,
              COALESCE(SUM(b.coach_fee) FILTER (WHERE b.no_show = 0 AND b.payment_status <> 'paid'), 0)::float AS unpaid,
              COUNT(b.id) FILTER (WHERE b.no_show = 1) AS no_shows,
              COALESCE(SUM(b.coach_fee) FILTER (WHERE b.no_show = 1), 0)::float AS no_show_fees,
              MAX(late.n) AS late_cancels, MAX(late.fees)::float AS late_fees
         FROM coaches k
         LEFT JOIN bookings b ON b.coach_id = k.id AND b.status = 'confirmed' AND b.demo = 0 AND b.date BETWEEN ? AND ?
         CROSS JOIN LATERAL (
           SELECT COUNT(*) AS n, COALESCE(SUM(x.coach_fee * x.late_kept_percent / 100.0), 0) AS fees
             FROM bookings x
            WHERE x.coach_id = k.id AND x.status = 'cancelled' AND x.late_cancelled = 1 AND x.late_kept_percent > 0
              AND x.payment_status = 'paid' AND x.demo = 0 AND x.date BETWEEN ? AND ?
         ) late
        WHERE k.venue_id = ?
        GROUP BY k.id, k.name
        ORDER BY k.name`
    )
    .all(from, to, from, to, venueId)) as {
    id: number;
    name: string;
    lessons: number | string;
    hours: number;
    paid: number;
    unpaid: number;
    no_shows: number | string;
    no_show_fees: number;
    late_cancels: number | string;
    late_fees: number;
  }[];
  return rows
    .map((r) => ({
      coachId: r.id,
      coach: r.name,
      lessons: Number(r.lessons),
      hours: Number(r.hours),
      paidFees: roundMoney(Number(r.paid)),
      unpaidFees: roundMoney(Number(r.unpaid)),
      noShows: Number(r.no_shows),
      noShowFees: roundMoney(Number(r.no_show_fees)),
      lateCancels: Number(r.late_cancels),
      lateCancelFees: roundMoney(Number(r.late_fees)),
    }))
    .filter((p) => p.lessons > 0 || p.noShows > 0 || p.lateCancels > 0);
}

/** The same, one row per lesson, for the venue's books and the coach's own records. */
export async function coachPayoutsCsv(venueId: number, from: string, to: string): Promise<string> {
  const rows = (await getDb()
    .prepare(
      `SELECT k.name AS coach, b.date, b.start_min, b.end_min, b.code, COALESCE(b.participant_name, b.name) AS student, c.name AS court,
              b.coach_fee::float AS fee, b.payment_status, b.no_show
         FROM bookings b JOIN coaches k ON k.id = b.coach_id JOIN courts c ON c.id = b.court_id
        WHERE k.venue_id = ? AND b.status = 'confirmed' AND b.demo = 0 AND b.date BETWEEN ? AND ?
        ORDER BY k.name, b.date, b.start_min`
    )
    .all(venueId, from, to)) as {
    coach: string;
    date: string;
    start_min: number;
    end_min: number;
    code: string;
    student: string;
    court: string;
    fee: number;
    payment_status: string;
    no_show: number;
  }[];
  return toCsv(
    ["Coach", "Date", "Time", "Booking", "Student", "Court", "Coach fee", "Paid", "Status"],
    rows.map((r) => [
      r.coach,
      r.date,
      `${formatHour(hoursOf(r.start_min))}–${formatHour(hoursOf(r.end_min))}`,
      r.code,
      r.student,
      r.court,
      money(Number(r.fee)),
      r.payment_status === "paid" ? "Yes" : "No",
      r.no_show === 1 ? "No-show" : "Went ahead",
    ])
  );
}
