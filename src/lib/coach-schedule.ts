import crypto from "crypto";
import { logAction } from "./activity";
import { hoursOf } from "./interval";
import { icsText, toUtcStamp } from "./booking-links";
import { coachClasses } from "./class-coaches";
import { coachById, type Coach } from "./coaching";
import { getDb } from "./db";
import { toCsv } from "./export";
import { enqueue } from "./outbox";
import { clockRange, money, roundMoney } from "./region";
import { isLocale, offeredLocales, translator, type Locale } from "./i18n";
import { staffLocales } from "./staff-locales";
import { siteName } from "./site";
import { venueBaseUrl } from "./storefront";
import { shiftEvents } from "./roster-calendar";
import { addDays, currentTime, formatHour, todayISO } from "./time";
import { venueZoneOf } from "./zones";

/**
 * A coach's side of their lessons (lib/coaching.ts), without an account:
 *
 * - **Their schedule** at a private link, `/coach/<token>`, and the same as a
 *   calendar feed for their phone, with the classes they teach (`classes.coach_id`,
 *   lib/class-coaches.ts) beside their lessons: a class's name, court, time and how many
 *   places are taken, never who is in it. A manager turns it on, which makes the
 *   link, and can replace or withdraw it. It shows the coach's own lessons
 *   only (`bookings.coach_id`), with each student's name (the participants
 *   taking part, a child among them) and the booker's number, so the coach
 *   can reach them; nothing else of the venue's: no other coach's students,
 *   no other child at the venue, no guardian records. The
 *   link is shown once, when made: only its hash is kept, and it lapses after
 *   `LINK_DAYS` unless replaced. It sets the coach's own hours and days off,
 *   each change recorded in the venue's activity log under the coach's name;
 *   it decides no applications (that needs an account: lib/approvals.ts).
 * - **An email** when a lesson is booked with them, and when one is
 *   cancelled, where the venue has given their address, in the coach's own
 *   language (`coachLocale`).
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
  /** The language they chose (at their link, or staff for them); null for none chosen. */
  locale: Locale | null;
  /** Until when their private link works, when one is on; the link itself was shown once, when made. */
  linkUntil: string | null;
}

export async function coachContacts(venueId: number): Promise<Map<number, CoachContact>> {
  const rows = (await getDb()
    .prepare("SELECT id, email, locale, CASE WHEN link_hash IS NOT NULL AND link_expires_at > now() THEN link_expires_at END AS link_until FROM coaches WHERE venue_id = ?")
    .all(venueId)) as { id: number; email: string | null; locale: string | null; link_until: unknown }[];
  return new Map(rows.map((r) => [r.id, { email: r.email, locale: chosenCoachLocale(r.locale), linkUntil: iso(r.link_until) }]));
}

/**
 * A coach's own language: any language this install offers customers
 * (Tamil too), since everything a coach reads (their page, its calendar,
 * their emails) is written from the customer dictionaries; null (or "") for
 * none chosen. Set by the coach at their link, or by staff on their record.
 * `venueId` null: whoever holds the link, already found by it.
 */
export async function setCoachLocale(coachId: number, venueId: number | null, raw: unknown): Promise<{ ok: true; locale: Locale | null } | { ok: false; error: string }> {
  const locale = chosenCoachLocale(raw);
  if (locale === null && raw !== null && raw !== "") return { ok: false, error: "That language is not offered here." };
  const done = await getDb()
    .prepare("UPDATE coaches SET locale = ? WHERE id = ? AND (?::int IS NULL OR venue_id = ?::int)")
    .run(locale, coachId, venueId, venueId);
  return done.changes === 1 ? { ok: true, locale } : { ok: false, error: "Coach not found." };
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
  /** The language the coach chose; null for none chosen. */
  locale: Locale | null;
  venueName: string;
  venueAddress: string;
  zone: string;
}

export async function coachForToken(token: string): Promise<CoachByToken | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const row = (await getDb()
    .prepare(
      `SELECT k.id, k.locale, v.name, v.address, v.time_zone, v.lat, v.lng FROM coaches k JOIN venues v ON v.id = k.venue_id
        WHERE k.link_hash = ? AND k.link_expires_at > now()`
    )
    .get(linkHash(token))) as { id: number; locale: string | null; name: string; address: string; time_zone: string | null; lat: number | null; lng: number | null } | undefined;
  if (!row) return null;
  const coach = await coachById(row.id);
  return coach ? { coach, locale: chosenCoachLocale(row.locale), venueName: row.name, venueAddress: row.address, zone: venueZoneOf(row) } : null;
}

/** A change the coach made at their own link, in the venue's activity log under their name. */
export async function logCoachChange(found: CoachByToken, detail: string): Promise<void> {
  await logAction({ id: null, name: found.coach.name }, { venueId: found.coach.venueId, action: "settings.changed", detail: `${found.coach.name}, at their own link: ${detail}` });
}

export interface Lesson {
  /** The booking's id: what the coach's register of the lesson is kept under (lib/attendance.ts). */
  id: number;
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
      `SELECT b.id, b.code, b.date, b.start_min, b.end_min, COALESCE(b.participant_name, b.name) AS name, b.phone, b.payment_status, c.name AS court
         FROM bookings b JOIN courts c ON c.id = b.court_id
        WHERE b.coach_id = ? AND b.status = 'confirmed' AND b.date BETWEEN ? AND ?
        ORDER BY b.date, b.start_min`
    )
    .all(coachId, from, until)) as {
    id: number;
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
    id: r.id,
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

/** A coach's calendar's language from its address (`?lang=`): one this install offers, else its first. */
export function coachFeedLocale(raw: string | null | undefined): Locale {
  return isLocale(raw) && offeredLocales().includes(raw) ? raw : (offeredLocales()[0] ?? "en");
}

/** A coach's language as stored: one this install offers, else null (none chosen). */
export function chosenCoachLocale(raw: unknown): Locale | null {
  return typeof raw === "string" && isLocale(raw) && offeredLocales().includes(raw) ? raw : null;
}

/**
 * The language MySenam writes to a coach in: their own (`coaches.locale`),
 * else the install's first staff language. Times in it are written as it
 * writes them.
 */
export function coachLocale(stored?: unknown): Locale {
  return chosenCoachLocale(stored) ?? staffLocales()[0];
}

/**
 * Their lessons as a calendar file, from a week back to as far ahead as
 * anybody can book. What people read is in `locale` (the language the coach's
 * page linked it in), times as it writes them; what calendar apps read is as
 * iCalendar has it.
 */
export async function coachCalendar(found: CoachByToken, venueId: number, locale: Locale = coachFeedLocale(null)): Promise<string> {
  const t = translator(locale);
  const today = todayISO(found.zone);
  const lessons = await coachLessons(found.coach.id, addDays(today, -DAYS_BACK), addDays(today, DAYS_AHEAD));
  // The classes they teach, as the venue's coach (lib/class-coaches.ts): the same calendar, never who is in them.
  const classes = await coachClasses(found.coach.id, addDays(today, -DAYS_BACK), addDays(today, DAYS_AHEAD));
  const host = new URL(await venueBaseUrl(venueId)).host;
  const stamp = toUtcStamp(today, 0, found.zone);
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${icsText(siteName())}//Coach calendar//EN`,
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(t("tl7.coachCal.name", { venue: found.venueName }))}`,
    `X-WR-TIMEZONE:${found.zone}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT30M",
    "X-PUBLISHED-TTL:PT30M",
    ...lessons.flatMap((l) => [
      "BEGIN:VEVENT",
      `UID:lesson-${l.code}@${host}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${toUtcStamp(l.date, l.startHour, found.zone)}`,
      `DTEND:${toUtcStamp(l.date, l.endHour, found.zone)}`,
      `SUMMARY:${icsText(t("tl7.coachCal.lesson", { student: l.student, court: l.court }))}`,
      `DESCRIPTION:${icsText(`${l.code}, ${formatHour(l.startHour, locale)}–${formatHour(l.endHour, locale)}\n${l.student}, ${l.phone}`)}`,
      `LOCATION:${icsText(found.venueAddress)}`,
      "END:VEVENT",
    ]),
    ...classes.flatMap((c) => [
      "BEGIN:VEVENT",
      `UID:class-${c.id}@${host}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${toUtcStamp(c.date, c.startMin / 60, found.zone)}`,
      `DTEND:${toUtcStamp(c.date, c.endMin / 60, found.zone)}`,
      `SUMMARY:${icsText(t("clsa.cal.class", { name: c.name, court: c.court }))}`,
      `DESCRIPTION:${icsText(`${c.name}, ${clockRange(c.startMin, c.endMin, locale)}\n${t("clsa.coach.line", { name: c.name, court: c.court, enrolled: c.enrolled, capacity: c.capacity })}`)}`,
      `LOCATION:${icsText(found.venueAddress)}`,
      "END:VEVENT",
    ]),
    // Their own rostered shifts as an instructor or the like, on their own link only (lib/rosters.ts).
    ...(await shiftEvents(venueId, { kind: "coach", id: found.coach.id }, locale, found.zone)),
    "END:VCALENDAR",
  ].join("\r\n");
}

/**
 * Tell coaches, by email, of lessons booked with them and of lessons since
 * cancelled. Once each: a lesson's cancellation only if its booking was told.
 *
 * **Every lesson still to come that its coach has not been told of**, however long ago it was booked: a coach whose address was
 * set later, or whose lessons were reassigned to them, hears of all of them (ADR 0072; it used to look only at lessons booked in
 * the last two days, so the rest were never told). Lessons of a coach with no address are not lost: the needs-attention list names
 * those coaches (`coachesWithoutEmail`). The coach's emails are not held to the day's limit per recipient (lib/outbox.ts): the address
 * is one the venue's manager gave, and a limit would write off a backlog for good.
 */
export async function notifyCoaches(now = new Date()): Promise<number> {
  const db = getDb();
  const rows = (await db
    .prepare(
      `SELECT b.id, b.code, b.date, b.start_min, b.end_min, COALESCE(b.participant_name, b.name) AS name, b.status, k.id AS coach_id, k.name AS coach, k.email, k.locale,
              c.name AS court, v.id AS venue_id, v.name AS venue,
              EXISTS (SELECT 1 FROM messages m WHERE m.dedupe_key = 'coach-new:' || b.id) AS told
         FROM bookings b JOIN coaches k ON k.id = b.coach_id JOIN courts c ON c.id = b.court_id JOIN venues v ON v.id = c.venue_id
        WHERE k.email IS NOT NULL AND b.demo = 0 AND b.date >= ?
          AND ((b.status = 'confirmed' AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.dedupe_key = 'coach-new:' || b.id))
               OR (b.status = 'cancelled' AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.dedupe_key = 'coach-cancel:' || b.id)))
        ORDER BY b.date, b.start_min, b.id`
    )
    .all(now.toISOString().slice(0, 10))) as {
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
    locale: string | null;
    court: string;
    venue_id: number;
    venue: string;
    told: boolean;
  }[];
  let sent = 0;
  for (const r of rows) {
    const cancelled = r.status === "cancelled";
    if (cancelled && !r.told) continue;
    // Each coach in their own language.
    const locale = coachLocale(r.locale);
    const vars = {
      name: r.coach.split(/\s+/)[0],
      student: r.name,
      court: r.court,
      venue: r.venue,
      date: r.date,
      time: clockRange(r.start_min, r.end_min, locale),
      code: r.code,
    };
    await enqueue({
      venueId: r.venue_id,
      bookingId: r.id,
      kind: "coach_lesson",
      channel: "email",
      recipient: r.email,
      locale,
      subject: cancelled ? "msg.coachCancelledSubject" : "msg.coachNewSubject",
      body: cancelled ? "msg.coachCancelled" : "msg.coachNew",
      dedupeKey: `${cancelled ? "coach-cancel" : "coach-new"}:${r.id}`,
      vars,
    });
    sent++;
  }
  return sent;
}

export interface UntoldCoach {
  coachId: number;
  coach: string;
  venueId: number;
  venueName: string;
  /** Lessons still to come with this coach, none of which MySenam can tell them of. */
  lessons: number;
  firstDate: string;
  /** The coach has a schedule link that works, so can see their lessons without an email. */
  hasLink: boolean;
}

/**
 * The coaches who have lessons still to come and no email address: nothing is sent to them (`notifyCoaches` needs an address), so staff
 * tell them another way or set the address, after which they are told of every one. Needs-attention list; soonest lesson first.
 */
export async function coachesWithoutEmail(venueIds: number[] | null): Promise<UntoldCoach[]> {
  if (venueIds !== null && venueIds.length === 0) return [];
  const rows = (await getDb()
    .prepare(
      `SELECT k.id, k.name, v.id AS venue_id, v.name AS venue, COUNT(*)::int AS n, MIN(b.date) AS first_date,
              (k.link_hash IS NOT NULL AND k.link_expires_at > now()) AS has_link
         FROM bookings b JOIN coaches k ON k.id = b.coach_id JOIN courts c ON c.id = b.court_id JOIN venues v ON v.id = c.venue_id
        WHERE (k.email IS NULL OR k.email = '') AND b.status = 'confirmed' AND b.demo = 0 AND NOT b.test AND b.date >= ?
          ${venueIds === null ? "" : `AND v.id IN (${venueIds.map(() => "?").join(",")})`}
        GROUP BY k.id, k.name, v.id, v.name, k.link_hash, k.link_expires_at
        ORDER BY first_date, k.id`
    )
    .all(todayISO(), ...(venueIds ?? []))) as { id: number; name: string; venue_id: number; venue: string; n: number; first_date: string; has_link: boolean }[];
  return rows.map((r) => ({ coachId: r.id, coach: r.name, venueId: r.venue_id, venueName: r.venue, lessons: r.n, firstDate: r.first_date, hasLink: r.has_link === true }));
}

/**
 * A lesson moved to another time (lib/store.ts rescheduleBooking): its coach,
 * where they have an email, is told the old time and the new. Moved to
 * another coach, the new one is told of a lesson booked with them and the
 * one before that it is no longer theirs. Only once the coach had heard of
 * the lesson (`coach-new:<id>`): before that, `notifyCoaches` tells whoever
 * has it now, at its time now. Returns how many were queued.
 */
export async function notifyLessonMoved(bookingId: number, was: { date: string; startMin: number; endMin: number; coachId: number }): Promise<number> {
  const db = getDb();
  const r = (await db
    .prepare(
      `SELECT b.id, b.code, b.date, b.start_min, b.end_min, COALESCE(b.participant_name, b.name) AS name, b.coach_id, b.demo,
              c.name AS court, v.id AS venue_id, v.name AS venue,
              EXISTS (SELECT 1 FROM messages m WHERE m.dedupe_key = 'coach-new:' || b.id) AS told
         FROM bookings b JOIN courts c ON c.id = b.court_id JOIN venues v ON v.id = c.venue_id WHERE b.id = ?`
    )
    .get(bookingId)) as
    | { id: number; code: string; date: string; start_min: number; end_min: number; name: string; coach_id: number | null; demo: number; court: string; venue_id: number; venue: string; told: boolean }
    | undefined;
  if (!r || r.coach_id === null || !r.told || r.demo) return 0;
  const coaches = (await db.prepare("SELECT id, name, email, locale FROM coaches WHERE id IN (?, ?)").all(r.coach_id, was.coachId)) as { id: number; name: string; email: string | null; locale: string | null }[];
  const coach = (id: number) => coaches.find((k) => k.id === id);
  const common = { student: r.name, court: r.court, venue: r.venue, code: r.code };
  // Each coach told in their own language, the times as it writes them.
  type Said = (when: (start: number, end: number) => string) => Record<string, string>;
  const tell = async (to: { name: string; email: string | null; locale: string | null } | undefined, subject: "fin6.msg.coachMovedSubject" | "msg.coachNewSubject" | "fin6.msg.coachHandedOverSubject", body: "fin6.msg.coachMoved" | "msg.coachNew" | "fin6.msg.coachHandedOver", said: Said) => {
    if (!to?.email) return 0;
    const locale = coachLocale(to.locale);
    const vars = said((start, end) => clockRange(start, end, locale));
    await enqueue({
      venueId: r.venue_id,
      bookingId: r.id,
      kind: "coach_lesson",
      channel: "email",
      recipient: to.email,
      locale,
      subject,
      body,
      vars: { name: to.name.split(/\s+/)[0], ...common, ...vars },
    });
    return 1;
  };
  const now: Said = (when) => ({ date: r.date, time: when(r.start_min, r.end_min) });
  if (r.coach_id === was.coachId)
    return tell(coach(r.coach_id), "fin6.msg.coachMovedSubject", "fin6.msg.coachMoved", (when) => ({ ...now(when), was: `${was.date}, ${when(was.startMin, was.endMin)}` }));
  return (
    (await tell(coach(r.coach_id), "msg.coachNewSubject", "msg.coachNew", now)) +
    (await tell(coach(was.coachId), "fin6.msg.coachHandedOverSubject", "fin6.msg.coachHandedOver", (when) => ({ date: was.date, time: when(was.startMin, was.endMin) })))
  );
}

// ------------------------------------------------------------ what coaches are owed

export interface CoachPayout {
  coachId: number;
  coach: string;
  /** Lessons that have been held: they ended before now, on the venue's clock, and were not marked a no-show. */
  lessons: number;
  hours: number;
  /** Coach fees on lessons that went ahead and are paid. */
  paidFees: number;
  /** On lessons that went ahead and are not paid yet: owed once the venue collects. */
  unpaidFees: number;
  /** Lessons in the period still to come (not yet ended), and their fees: booked, not delivered, so not owed yet (ADR 0072). */
  scheduledLessons: number;
  scheduledHours: number;
  scheduledPaidFees: number;
  scheduledUnpaidFees: number;
  /** Lessons the student did not turn up to, and the fees on them: the venue decides. */
  noShows: number;
  noShowFees: number;
  /** Paid lessons cancelled late, and the coach's fee times the share the venue kept: the venue decides. */
  lateCancels: number;
  lateCancelFees: number;
}

/** Whether a lesson has ended, on the venue's own clock: its date has passed, or it is today and its last minute has. */
const heldSql = (alias: string) => `(${alias}.date < ? OR (${alias}.date = ? AND ${alias}.end_min <= ?))`;

/** The venue's date today and the minute of its day now, for `heldSql`. */
async function venueClock(venueId: number): Promise<[string, string, number]> {
  const row = (await getDb().prepare("SELECT time_zone, lat, lng FROM venues WHERE id = ?").get(venueId)) as { time_zone: string | null; lat: number | null; lng: number | null } | undefined;
  const zone = venueZoneOf(row ?? {});
  const today = todayISO(zone);
  return [today, today, Math.floor(currentTime(zone) * 60)];
}

/**
 * Per coach, the lessons in a period (on the lesson's date) and the coach's fees on them. What is owed (`lessons`, `paidFees`,
 * `unpaidFees`) counts only lessons that have ended; lessons still to come are `scheduled…`, booked and not yet delivered (ADR 0072).
 */
export async function coachPayouts(venueId: number, from: string, to: string): Promise<CoachPayout[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT k.id, k.name,
              COUNT(b.id) FILTER (WHERE b.no_show = 0 AND b.held) AS lessons,
              COALESCE(SUM(b.end_min - b.start_min) FILTER (WHERE b.no_show = 0 AND b.held) / 60.0, 0)::float AS hours,
              COALESCE(SUM(b.coach_fee) FILTER (WHERE b.no_show = 0 AND b.held AND b.payment_status = 'paid'), 0)::float AS paid,
              COALESCE(SUM(b.coach_fee) FILTER (WHERE b.no_show = 0 AND b.held AND b.payment_status <> 'paid'), 0)::float AS unpaid,
              COUNT(b.id) FILTER (WHERE b.no_show = 0 AND NOT b.held) AS scheduled,
              COALESCE(SUM(b.end_min - b.start_min) FILTER (WHERE b.no_show = 0 AND NOT b.held) / 60.0, 0)::float AS scheduled_hours,
              COALESCE(SUM(b.coach_fee) FILTER (WHERE b.no_show = 0 AND NOT b.held AND b.payment_status = 'paid'), 0)::float AS scheduled_paid,
              COALESCE(SUM(b.coach_fee) FILTER (WHERE b.no_show = 0 AND NOT b.held AND b.payment_status <> 'paid'), 0)::float AS scheduled_unpaid,
              COUNT(b.id) FILTER (WHERE b.no_show = 1) AS no_shows,
              COALESCE(SUM(b.coach_fee) FILTER (WHERE b.no_show = 1), 0)::float AS no_show_fees,
              MAX(late.n) AS late_cancels, MAX(late.fees)::float AS late_fees
         FROM coaches k
         LEFT JOIN (
           SELECT x.*, ${heldSql("x")} AS held FROM bookings x
            WHERE x.status = 'confirmed' AND x.demo = 0 AND x.date BETWEEN ? AND ?
         ) b ON b.coach_id = k.id
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
    .all(...(await venueClock(venueId)), from, to, from, to, venueId)) as {
    id: number;
    name: string;
    lessons: number | string;
    hours: number;
    paid: number;
    unpaid: number;
    scheduled: number | string;
    scheduled_hours: number;
    scheduled_paid: number;
    scheduled_unpaid: number;
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
      scheduledLessons: Number(r.scheduled),
      scheduledHours: Number(r.scheduled_hours),
      scheduledPaidFees: roundMoney(Number(r.scheduled_paid)),
      scheduledUnpaidFees: roundMoney(Number(r.scheduled_unpaid)),
      noShows: Number(r.no_shows),
      noShowFees: roundMoney(Number(r.no_show_fees)),
      lateCancels: Number(r.late_cancels),
      lateCancelFees: roundMoney(Number(r.late_fees)),
    }))
    .filter((p) => p.lessons > 0 || p.scheduledLessons > 0 || p.noShows > 0 || p.lateCancels > 0);
}

/**
 * The same, one row per lesson: every coach's, for the venue's books; or
 * (`coachId`) one coach's own, to hand to that coach, naming only the
 * students in their own lessons, never another coach's (a child among them).
 */
export async function coachPayoutsCsv(venueId: number, from: string, to: string, coachId?: number): Promise<string> {
  const clock = await venueClock(venueId);
  const rows = (await getDb()
    .prepare(
      `SELECT k.name AS coach, b.date, b.start_min, b.end_min, b.code, COALESCE(b.participant_name, b.name) AS student, c.name AS court,
              b.coach_fee::float AS fee, b.payment_status, b.no_show
         FROM bookings b JOIN coaches k ON k.id = b.coach_id JOIN courts c ON c.id = b.court_id
        WHERE k.venue_id = ? AND b.status = 'confirmed' AND b.demo = 0 AND b.date BETWEEN ? AND ?${coachId !== undefined ? " AND k.id = ?" : ""}
        ORDER BY k.name, b.date, b.start_min`
    )
    .all(venueId, from, to, ...(coachId !== undefined ? [coachId] : []))) as {
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
      r.no_show === 1 ? "No-show" : r.date < clock[0] || (r.date === clock[0] && r.end_min <= clock[2]) ? "Went ahead" : "Scheduled",
    ])
  );
}

/**
 * Weeks of a lesson series moved together by the venue (lib/series-moves.ts): its coach is told once, in their own
 * language, the first week from where it was to where it is now and how many weeks moved, rather than once a week.
 * Only weeks the coach had heard of (`coach-new:<id>`), as `notifyLessonMoved`. Returns how many were queued.
 */
export async function notifyLessonSeriesMoved(
  seriesCode: string,
  weeks: { bookingId: number; was: { date: string; startMin: number; endMin: number } }[]
): Promise<number> {
  const db = getDb();
  type Week = { id: number; date: string; start_min: number; end_min: number; name: string; coach_id: number; court: string; venue_id: number; venue: string };
  const told: { r: Week; was: { date: string; startMin: number; endMin: number } }[] = [];
  for (const w of weeks) {
    const r = (await db
      .prepare(
        `SELECT b.id, b.date, b.start_min, b.end_min, COALESCE(b.participant_name, b.name) AS name, b.coach_id, b.demo,
                c.name AS court, v.id AS venue_id, v.name AS venue,
                EXISTS (SELECT 1 FROM messages m WHERE m.dedupe_key = 'coach-new:' || b.id) AS told
           FROM bookings b JOIN courts c ON c.id = b.court_id JOIN venues v ON v.id = c.venue_id WHERE b.id = ?`
      )
      .get(w.bookingId)) as (Omit<Week, "coach_id"> & { coach_id: number | null; demo: number; told: boolean }) | undefined;
    if (r && r.coach_id !== null && r.told && !r.demo) told.push({ r: { ...r, coach_id: r.coach_id }, was: w.was });
  }
  let queued = 0;
  for (const coachId of new Set(told.map((t) => t.r.coach_id))) {
    const mine = told.filter((t) => t.r.coach_id === coachId).sort((a, b) => a.r.date.localeCompare(b.r.date));
    const coach = (await db.prepare("SELECT name, email, locale FROM coaches WHERE id = ?").get(coachId)) as
      | { name: string; email: string | null; locale: string | null }
      | undefined;
    if (!coach?.email) continue;
    const locale = coachLocale(coach.locale);
    const { r, was } = mine[0];
    await enqueue({
      venueId: r.venue_id,
      bookingId: r.id,
      kind: "coach_lesson",
      channel: "email",
      recipient: coach.email,
      locale,
      subject: "r9e.msg.coachSeriesMovedSubject",
      body: "r9e.msg.coachSeriesMoved",
      vars: {
        name: coach.name.split(/\s+/)[0],
        n: String(mine.length),
        student: r.name,
        court: r.court,
        venue: r.venue,
        code: seriesCode.trim().toUpperCase(),
        was: `${was.date}, ${clockRange(was.startMin, was.endMin, locale)}`,
        date: r.date,
        time: clockRange(r.start_min, r.end_min, locale),
      },
    });
    queued++;
  }
  return queued;
}
