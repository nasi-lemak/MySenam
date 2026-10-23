import { getDb } from "./db";
import { hoursOf } from "./interval";
import { errorText, isLocale, translator, type ErrorCode, type Locale } from "./i18n";
import { enqueue } from "./outbox";
import { tellOwners, tellVenueStaff } from "./owner-alerts";
import { reviewPath, reviewToken } from "./review-links";
import { siteName } from "./site";
import { venueBaseUrl } from "./storefront";
import { findBookingByCode, getCourt, getVenue } from "./store";
import { addDays, slotStartsAt, todayISO } from "./time";
import { MAX_REVIEW_BODY, type Booking, type Refusal } from "./types";
import { venueZoneOf } from "./zones";

/**
 * Stars and a few words about a venue, from somebody who played there.
 *
 * - **Only after playing.** A review is written from a booking that went
 *   ahead (not cancelled, not a no-show), from when it ends until 60 days
 *   after, through a link signed for that booking: My Booking and the account
 *   page offer it, and one email the day after a customer's first visit to a
 *   venue asks once. Nobody can review a venue they have not booked.
 * - **One per number per venue.** Writing again replaces the earlier one, so
 *   a regular counts once, with what they think now.
 * - **Shown** with a first name and an initial and the month played, newest
 *   first. The average shows from three reviews up, so one opinion is not
 *   presented as a score.
 * - **The venue can answer** each one publicly, and can ask the platform to
 *   look at one that breaks the rules. Only the platform's owners hide a
 *   review; a venue cannot delete what it does not like.
 */

export const REVIEW_DAYS = 60;
export const MIN_SHOWN = 3;
export const MAX_BODY = MAX_REVIEW_BODY;

const ENGLISH = translator("en");
function refuse(code: ErrorCode, vars?: Record<string, string | number>): Refusal {
  return { ok: false, error: errorText(ENGLISH, code, vars), code, ...(vars ? { vars } : {}) };
}

export { reviewPath, reviewToken };

/** "Wei Ling Tan" → "Wei T." */
export function shownName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "Guest";
  const first = parts[0].slice(0, 20);
  return parts.length > 1 ? `${first} ${parts[parts.length - 1][0].toUpperCase()}.` : first;
}

export interface Review {
  id: number;
  venueId: number;
  author: string;
  rating: number;
  body: string | null;
  /** The month played, YYYY-MM. */
  playedIn: string;
  updatedAt: string;
  reply: string | null;
  repliedAt: string | null;
}

/** As the venue's staff and the platform see it. */
export interface StaffReview extends Review {
  reportedAt: string | null;
  reportReason: string | null;
  hiddenAt: string | null;
  hiddenReason: string | null;
  bookingCode: string | null;
}

interface Row {
  id: number;
  venue_id: number;
  booking_id: number | null;
  author: string;
  rating: number;
  body: string | null;
  played_on: string;
  updated_at: string;
  reply: string | null;
  replied_at: string | null;
  reported_at: string | null;
  report_reason: string | null;
  hidden_at: string | null;
  hidden_reason: string | null;
  booking_code?: string | null;
}

const toReview = (r: Row): Review => ({
  id: r.id,
  venueId: r.venue_id,
  author: r.author,
  rating: Number(r.rating),
  body: r.body,
  playedIn: r.played_on.slice(0, 7),
  updatedAt: r.updated_at,
  reply: r.reply,
  repliedAt: r.replied_at,
});

const toStaffReview = (r: Row): StaffReview => ({
  ...toReview(r),
  reportedAt: r.reported_at,
  reportReason: r.report_reason,
  hiddenAt: r.hidden_at,
  hiddenReason: r.hidden_reason,
  bookingCode: r.booking_code ?? null,
});

async function zoneOf(venueId: number): Promise<string> {
  const v = (await getDb().prepare("SELECT time_zone, lat, lng FROM venues WHERE id = ?").get(venueId)) as
    | { time_zone: string | null; lat: number | null; lng: number | null }
    | undefined;
  return venueZoneOf(v ?? {});
}

export interface Reviewable {
  booking: Booking;
  venueId: number;
  venueName: string;
  courtName: string;
  /** This number's review of the venue so far, to edit. */
  existing: Review | null;
}

/** Whether this booking can be reviewed now, and what of: or why not. */
export async function reviewable(code: string, now = new Date()): Promise<{ ok: true; value: Reviewable } | Refusal> {
  const booking = await findBookingByCode(code);
  if (!booking) return refuse("REVIEW_NOT_FOUND");
  const court = await getCourt(booking.courtId);
  const venue = court ? await getVenue(court.venueId) : null;
  if (!court || !venue) return refuse("REVIEW_NOT_FOUND");
  if (booking.status !== "confirmed" || booking.noShow) return refuse("REVIEW_NOT_PLAYED");
  // Paid for, or checked in: a booking made under any number and never turned up to is not a visit,
  // and is the cheapest way to leave a rival one star.
  if (booking.paymentStatus !== "paid" && !booking.checkedInAt && booking.totalPrice > 0) return refuse("REVIEW_NOT_PLAYED");
  const zone = await zoneOf(venue.id);
  if (slotStartsAt(booking.date, booking.endHour, zone).getTime() > now.getTime()) return refuse("REVIEW_NOT_YET");
  if (booking.date < addDays(todayISO(zone), -REVIEW_DAYS)) return refuse("REVIEW_TOO_LATE", { days: REVIEW_DAYS });
  const existing = (await getDb()
    .prepare("SELECT * FROM venue_reviews WHERE venue_id = ? AND phone_key = phone_key(?)")
    .get(venue.id, booking.phone)) as Row | undefined;
  return { ok: true, value: { booking, venueId: venue.id, venueName: venue.name, courtName: court.name, existing: existing ? toReview(existing) : null } };
}

/** Write (or write again) this number's review of the venue, from a booking there. */
export async function writeReview(
  code: string,
  token: string,
  input: { rating: unknown; body?: unknown; locale?: Locale }
): Promise<{ ok: true; review: Review } | Refusal> {
  if (token !== reviewToken(code)) return refuse("REVIEW_NOT_FOUND");
  const can = await reviewable(code);
  if (!can.ok) return can;
  const rating = input.rating;
  if (typeof rating !== "number" || !Number.isInteger(rating) || rating < 1 || rating > 5) return refuse("REVIEW_STARS");
  const body = typeof input.body === "string" && input.body.trim() ? input.body.trim().replace(/\n{3,}/g, "\n\n") : null;
  if (body && body.length > MAX_BODY) return refuse("REVIEW_TOO_LONG", { max: MAX_BODY });
  // Links and numbers are how a review is turned into an advert or a way to reach somebody.
  if (body && (/(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|my|sg|net|org)\b)/i.test(body) || /(\+?\d[\d\s-]{7,}\d)/.test(body)))
    return refuse("REVIEW_LINK");
  const { booking, venueId } = can.value;
  const userId = (await getDb().prepare("SELECT user_id FROM bookings WHERE id = ?").get(booking.id)) as { user_id: number | null } | undefined;
  const row = (await getDb()
    .prepare(
      `INSERT INTO venue_reviews (venue_id, booking_id, phone_key, user_id, author, rating, body, played_on, locale)
       VALUES (?, ?, phone_key(?), ?, ?, ?, ?, ?, ?)
       ON CONFLICT (venue_id, phone_key) DO UPDATE SET booking_id = excluded.booking_id, user_id = COALESCE(excluded.user_id, venue_reviews.user_id),
         author = excluded.author, rating = excluded.rating, body = excluded.body, played_on = excluded.played_on,
         locale = excluded.locale, updated_at = datetime('now'),
         -- A report was about the words now gone.
         reported_at = NULL, report_reason = NULL
       RETURNING *`
    )
    .get(venueId, booking.id, booking.phone, userId?.user_id ?? null, shownName(booking.name), rating, body, booking.date, input.locale ?? null)) as Row;
  return { ok: true, review: toReview(row) };
}

export interface Rating {
  average: number;
  count: number;
}

/** The venue's average, from MIN_SHOWN reviews up; null below that. */
export async function venueRating(venueId: number): Promise<Rating | null> {
  const r = (await getDb()
    .prepare("SELECT COUNT(*) AS n, AVG(rating)::float AS avg FROM venue_reviews WHERE venue_id = ? AND hidden_at IS NULL")
    .get(venueId)) as { n: number | string; avg: number | null };
  const count = Number(r.n);
  return count >= MIN_SHOWN && r.avg !== null ? { average: Math.round(Number(r.avg) * 10) / 10, count } : null;
}

/** What the public sees, newest first. */
export async function venueReviews(venueId: number, limit = 10): Promise<Review[]> {
  const rows = (await getDb()
    .prepare("SELECT * FROM venue_reviews WHERE venue_id = ? AND hidden_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT ?")
    .all(venueId, limit)) as Row[];
  return rows.map(toReview);
}

/**
 * Everything about the venue's reviews, hidden ones included, for its staff:
 * but not which booking wrote each, so a bad review cannot be traced to a
 * number and turned away. The platform's owners see that when one is reported.
 */
export async function staffReviews(venueId: number, limit = 100): Promise<StaffReview[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT r.* FROM venue_reviews r
        WHERE r.venue_id = ? ORDER BY r.updated_at DESC, r.id DESC LIMIT ?`
    )
    .all(venueId, limit)) as Row[];
  return rows.map(toStaffReview);
}

/** Reviews a venue has asked the platform to look at, not yet decided. */
export async function reportedReviews(): Promise<(StaffReview & { venueName: string })[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT r.*, b.code AS booking_code, v.name AS venue_name FROM venue_reviews r
         JOIN venues v ON v.id = r.venue_id LEFT JOIN bookings b ON b.id = r.booking_id
        WHERE r.reported_at IS NOT NULL AND r.hidden_at IS NULL ORDER BY r.reported_at`
    )
    .all()) as (Row & { venue_name: string })[];
  return rows.map((r) => ({ ...toStaffReview(r), venueName: r.venue_name }));
}

type Done = { ok: true; review: StaffReview } | { ok: false; error: string };

async function staffRow(id: number, venueId: number): Promise<StaffReview | null> {
  const row = (await getDb()
    .prepare("SELECT r.* FROM venue_reviews r WHERE r.id = ? AND r.venue_id = ?")
    .get(id, venueId)) as Row | undefined;
  return row ? toStaffReview(row) : null;
}

/** The venue's public answer; empty takes it away. */
export async function replyToReview(id: number, venueId: number, text: unknown): Promise<Done> {
  const reply = typeof text === "string" && text.trim() ? text.trim() : null;
  if (reply && reply.length > MAX_BODY) return { ok: false, error: `Keep the reply to ${MAX_BODY} characters.` };
  const done = await getDb()
    .prepare("UPDATE venue_reviews SET reply = ?, replied_at = CASE WHEN ?::text IS NULL THEN NULL ELSE datetime('now') END WHERE id = ? AND venue_id = ?")
    .run(reply, reply, id, venueId);
  if (done.changes !== 1) return { ok: false, error: "Review not found." };
  return { ok: true, review: (await staffRow(id, venueId))! };
}

/** The venue asking the platform to look at a review it thinks breaks the rules. It stays up until decided. */
export async function reportReview(id: number, venueId: number, reason: unknown): Promise<Done> {
  const why = typeof reason === "string" ? reason.trim().slice(0, 500) : "";
  if (why.length < 5) return { ok: false, error: "Say which rule it breaks." };
  const already = (await getDb()
    .prepare("SELECT reported_at FROM venue_reviews WHERE id = ? AND venue_id = ? AND hidden_at IS NULL")
    .get(id, venueId)) as { reported_at: string | null } | undefined;
  if (!already) return { ok: false, error: "Review not found." };
  // Asked once: reporting it again changes nothing until the platform decides.
  if (already.reported_at) return { ok: true, review: (await staffRow(id, venueId))! };
  await getDb()
    .prepare("UPDATE venue_reviews SET reported_at = datetime('now'), report_reason = ? WHERE id = ? AND venue_id = ?")
    .run(why, id, venueId);
  const review = (await staffRow(id, venueId))!;
  const venue = await getVenue(venueId);
  await tellOwners(
    `Review reported at ${venue?.name ?? `venue ${venueId}`}`,
    `${venue?.name ?? "A venue"} asks for a review to be looked at.\n\n${review.author}, ${review.rating}/5: ${review.body ?? "(no words)"}\n\nWhy: ${why}\n\nDecide under Venues & staff → Reviews.`
  );
  return { ok: true, review };
}

/** The platform's decision: hidden (with why, told to the venue), or shown again. */
export async function moderateReview(id: number, hide: boolean, reason?: unknown): Promise<Done> {
  const db = getDb();
  const row = (await db.prepare("SELECT venue_id FROM venue_reviews WHERE id = ?").get(id)) as { venue_id: number } | undefined;
  if (!row) return { ok: false, error: "Review not found." };
  if (hide) {
    const why = typeof reason === "string" ? reason.trim().slice(0, 500) : "";
    if (why.length < 3) return { ok: false, error: "Say why it is hidden." };
    await db.prepare("UPDATE venue_reviews SET hidden_at = datetime('now'), hidden_reason = ? WHERE id = ?").run(why, id);
    await tellVenueStaff(row.venue_id, "A review was hidden", `A review of your venue has been hidden: ${why}`);
  } else {
    await db.prepare("UPDATE venue_reviews SET hidden_at = NULL, hidden_reason = NULL, reported_at = NULL, report_reason = NULL WHERE id = ?").run(id);
  }
  return { ok: true, review: (await staffRow(id, row.venue_id))! };
}

export async function reviewRequestsOn(venueId: number): Promise<boolean> {
  const r = (await getDb().prepare("SELECT review_requests FROM venues WHERE id = ?").get(venueId)) as { review_requests: number } | undefined;
  return r?.review_requests === 1;
}

export async function setReviewRequests(venueId: number, on: boolean): Promise<void> {
  await getDb().prepare("UPDATE venues SET review_requests = ? WHERE id = ?").run(on ? 1 : 0, venueId);
}

/**
 * The day after: one email asking a customer how it was, after a booking
 * that went ahead, the first time they play at a venue that asks. Never again
 * for that venue, whether they answer or not. By email only.
 */
export async function askForReviews(now = new Date()): Promise<number> {
  const from = new Date(now.getTime() - 3 * 86_400_000).toISOString().slice(0, 10);
  const to = now.toISOString().slice(0, 10);
  const rows = (await getDb()
    .prepare(
      `SELECT b.id, b.code, b.name, b.email, b.date, b.end_min, b.locale, b.phone_key, c.name AS court, v.id AS venue_id, v.name AS venue
         FROM bookings b JOIN courts c ON c.id = b.court_id JOIN venues v ON v.id = c.venue_id
        WHERE b.status = 'confirmed' AND b.no_show = 0 AND b.demo = 0 AND b.email IS NOT NULL AND b.email <> ''
          AND b.date BETWEEN ? AND ? AND v.review_requests = 1 AND v.published_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM venue_reviews r WHERE r.venue_id = v.id AND r.phone_key = b.phone_key)
          AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.dedupe_key = 'review:' || v.id || ':' || b.phone_key)
        ORDER BY b.date, b.end_min`
    )
    .all(from, to)) as {
    id: number;
    code: string;
    name: string;
    email: string;
    date: string;
    end_min: number;
    locale: string | null;
    phone_key: string;
    court: string;
    venue_id: number;
    venue: string;
  }[];
  let asked = 0;
  const seen = new Set<string>();
  for (const r of rows) {
    const key = `review:${r.venue_id}:${r.phone_key}`;
    if (seen.has(key)) continue;
    const ended = slotStartsAt(r.date, hoursOf(r.end_min), await zoneOf(r.venue_id)).getTime();
    // A couple of hours after, so it is not in the middle of getting changed.
    if (now.getTime() - ended < 2 * 3_600_000 || now.getTime() - ended > 72 * 3_600_000) continue;
    seen.add(key);
    const locale: Locale = r.locale && isLocale(r.locale) ? r.locale : "en";
    await enqueue({
      venueId: r.venue_id,
      bookingId: r.id,
      kind: "review_request",
      channel: "email",
      recipient: r.email,
      locale,
      subject: "msg.reviewSubject",
      body: "msg.review",
      dedupeKey: key,
      vars: {
        name: r.name.trim().split(/\s+/)[0],
        venue: r.venue,
        court: r.court,
        date: r.date,
        link: `${await venueBaseUrl(r.venue_id)}${reviewPath(r.code)}`,
        site: siteName(),
      },
    });
    asked++;
  }
  return asked;
}
