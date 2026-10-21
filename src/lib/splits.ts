import crypto from "crypto";
import { getDb } from "./db";
import { creditReceipt } from "./documents";
import { findBooking, getCourt, getVenue } from "./store";
import { roundMoney } from "./region";
import { isPastSlot } from "./time";
import { venueZoneOf } from "./zones";
import { MAX_SPLIT_PARTS } from "./types";

/**
 * Splitting a booking's cost with friends, without accounts.
 *
 * The booker chooses how many ways (2 to 10, themselves included) and gets a
 * link to send. Each friend who opens it pays one share to the venue online,
 * through the venue's own payment page, towards the booking (as players in
 * an open game do: `bookings.shares_paid`). The booker pays what is left, or
 * nothing once the shares cover it all.
 *
 * - Only an unpaid booking at a venue taking payment online, not already
 *   held for payment and not an open game, and only before it starts.
 * - The booking stays the booker's: until it is all paid they owe whatever is
 *   left, and the venue's cancellation rules apply to them.
 * - A share paid after every share is taken, after the booking was paid in
 *   full or cancelled, is owed back by the venue; so is every share if the
 *   booking is cancelled later. Each share has its own receipt.
 */

export const MAX_PARTS = MAX_SPLIT_PARTS;

export interface Split {
  id: number;
  bookingId: number;
  parts: number;
  share: number;
  token: string;
  /** Friends' shares paid so far. */
  paid: number;
}

export interface SplitView extends Split {
  code: string;
  venueId: number;
  venueName: string;
  courtName: string;
  date: string;
  startHour: number;
  endHour: number;
  total: number;
  /** The booker's first name, as friends see it. */
  host: string;
  /** Why a friend cannot pay now, if they cannot. */
  closed: "paid" | "cancelled" | "started" | "full" | null;
}

export function splitPath(token: string): string {
  return `/split/${token}`;
}

async function paidShares(splitId: number): Promise<number> {
  const r = (await getDb()
    .prepare("SELECT COUNT(*) AS n FROM online_payments WHERE split_id = ? AND purpose = 'split' AND status = 'paid' AND refund_due = 0")
    .get(splitId)) as { n: number | string };
  return Number(r.n);
}

type Result = { ok: true; split: Split } | { ok: false; error: string; status: number };

/** The booker, with their code and number, splitting it `parts` ways. Changing the number is allowed until a friend has paid. */
export async function splitBooking(code: string, phone: string, parts: unknown): Promise<Result> {
  if (!Number.isInteger(parts) || (parts as number) < 2 || (parts as number) > MAX_PARTS)
    return { ok: false, error: `Split it 2 to ${MAX_PARTS} ways, yourself included.`, status: 400 };
  const booking = await findBooking(code, phone);
  if (!booking) return { ok: false, error: "Booking not found.", status: 404 };
  if (booking.status !== "confirmed") return { ok: false, error: "That booking was cancelled.", status: 409 };
  if (booking.paymentStatus === "paid") return { ok: false, error: "That booking is paid already.", status: 409 };
  if (booking.holdUntil) return { ok: false, error: "This venue holds a booking only until it is paid: pay it first, then settle up with your friends.", status: 409 };
  if (booking.totalPrice <= 0) return { ok: false, error: "There is nothing to split.", status: 409 };
  const db = getDb();
  const court = (await getCourt(booking.courtId))!;
  const venueRow = (await db.prepare("SELECT time_zone, lat, lng FROM venues WHERE id = ?").get(court.venueId)) as {
    time_zone: string | null;
    lat: number | null;
    lng: number | null;
  };
  if (isPastSlot(booking.date, booking.startHour, venueZoneOf(venueRow))) return { ok: false, error: "That booking has started.", status: 409 };
  const { takesPaymentOnline } = await import("./payments");
  if (!(await takesPaymentOnline(court.venueId))) return { ok: false, error: "This venue does not take payment online, so friends cannot pay their share here.", status: 409 };
  const game = await db.prepare("SELECT 1 FROM open_games WHERE booking_id = ? AND status <> 'cancelled'").get(booking.id);
  if (game) return { ok: false, error: "This booking is an open game: players pay their share there.", status: 409 };

  // Each friend's share, rounded down to the cent; the booker's part takes the rest.
  const share = Math.floor(((booking.totalPrice - booking.sharesPaid) / (parts as number)) * 100) / 100;
  if (share <= 0) return { ok: false, error: "There is nothing to split.", status: 409 };
  const existing = (await db.prepare("SELECT id FROM booking_splits WHERE booking_id = ?").get(booking.id)) as { id: number } | undefined;
  if (existing) {
    if ((await paidShares(existing.id)) > 0) return { ok: false, error: "A friend has paid already, so the split stays as it is.", status: 409 };
    await db.prepare("UPDATE booking_splits SET parts = ?, share = ? WHERE id = ?").run(parts, share, existing.id);
  } else {
    await db
      .prepare("INSERT INTO booking_splits (booking_id, parts, share, token) VALUES (?, ?, ?, ?)")
      .run(booking.id, parts, share, crypto.randomBytes(18).toString("base64url"));
  }
  return { ok: true, split: (await splitFor(booking.id))! };
}

export async function splitFor(bookingId: number): Promise<Split | null> {
  const r = (await getDb().prepare("SELECT * FROM booking_splits WHERE booking_id = ?").get(bookingId)) as
    | { id: number; booking_id: number; parts: number; share: number | string; token: string }
    | undefined;
  return r ? { id: r.id, bookingId: r.booking_id, parts: r.parts, share: Number(r.share), token: r.token, paid: await paidShares(r.id) } : null;
}

/** What a friend sees at the link. */
export async function splitByToken(token: string): Promise<SplitView | null> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  const db = getDb();
  const r = (await db
    .prepare(
      `SELECT s.*, b.code, b.date, b.start_hour, b.end_hour, b.name, b.status, b.payment_status, b.total_price::float AS total,
              c.name AS court, v.id AS venue_id, v.name AS venue, v.time_zone, v.lat, v.lng
         FROM booking_splits s JOIN bookings b ON b.id = s.booking_id JOIN courts c ON c.id = b.court_id JOIN venues v ON v.id = c.venue_id
        WHERE s.token = ?`
    )
    .get(token)) as
    | {
        id: number;
        booking_id: number;
        parts: number;
        share: number | string;
        token: string;
        code: string;
        date: string;
        start_hour: number;
        end_hour: number;
        name: string;
        status: string;
        payment_status: string;
        total: number;
        court: string;
        venue_id: number;
        venue: string;
        time_zone: string | null;
        lat: number | null;
        lng: number | null;
      }
    | undefined;
  if (!r) return null;
  const paid = await paidShares(r.id);
  const closed: SplitView["closed"] =
    r.status !== "confirmed"
      ? "cancelled"
      : r.payment_status === "paid"
        ? "paid"
        : isPastSlot(r.date, Number(r.start_hour), venueZoneOf(r))
          ? "started"
          : paid >= r.parts - 1
            ? "full"
            : null;
  return {
    id: r.id,
    bookingId: r.booking_id,
    parts: r.parts,
    share: Number(r.share),
    token: r.token,
    paid,
    code: r.code,
    venueId: r.venue_id,
    venueName: r.venue,
    courtName: r.court,
    date: r.date,
    startHour: Number(r.start_hour),
    endHour: Number(r.end_hour),
    total: r.total,
    host: r.name.trim().split(/\s+/)[0],
    closed,
  };
}

/**
 * A friend's share arrived (lib/payments.ts calls this once, inside its
 * claim): counted towards the booking while a share is still open and the
 * booking unpaid; owed back otherwise. True when counted.
 */
export async function countSplitShare(paymentId: number, splitId: number, amount: number): Promise<boolean> {
  const db = getDb();
  const s = (await db
    .prepare(
      `SELECT s.parts, b.id AS booking_id, b.status, b.payment_status, b.total_price::float AS total, b.shares_paid::float AS shares_paid
         FROM booking_splits s JOIN bookings b ON b.id = s.booking_id WHERE s.id = ?`
    )
    .get(splitId)) as { parts: number; booking_id: number; status: string; payment_status: string; total: number; shares_paid: number } | undefined;
  const others = s
    ? Number(
        ((await db
          .prepare("SELECT COUNT(*) AS n FROM online_payments WHERE split_id = ? AND purpose = 'split' AND status = 'paid' AND refund_due = 0 AND id <> ?")
          .get(splitId, paymentId)) as { n: number | string }).n
      )
    : 0;
  if (!s || s.status !== "confirmed" || s.payment_status === "paid" || others >= s.parts - 1) {
    await db.prepare("UPDATE online_payments SET refund_due = amount WHERE id = ?").run(paymentId);
    return false;
  }
  const sharesPaid = roundMoney(s.shares_paid + amount);
  await db.prepare("UPDATE bookings SET shares_paid = ? WHERE id = ?").run(sharesPaid, s.booking_id);
  if (sharesPaid >= s.total)
    await db.prepare("UPDATE bookings SET payment_status = 'paid', paid_at = datetime('now'), paid_via = 'online' WHERE id = ?").run(s.booking_id);
  return true;
}

/**
 * The booking was cancelled: each friend's share is owed back, at the same
 * `share` as the booker's payment (all of it, or what is left after the
 * venue's late-cancellation fee), and its receipt credited for that much.
 */
export async function splitCancelled(bookingId: number, share = 1): Promise<void> {
  if (share <= 0) return;
  const db = getDb();
  const paid = (await db
    .prepare(
      `UPDATE online_payments SET refund_due = ROUND(amount * ${Number(share)}, 2)
        WHERE purpose = 'split' AND status = 'paid' AND refund_due = 0
          AND split_id IN (SELECT id FROM booking_splits WHERE booking_id = ?) RETURNING id`
    )
    .all(bookingId)) as { id: number }[];
  for (const p of paid) await creditReceipt(`payment:${p.id}`, share < 1 ? "receipt.why.lateCancelled" : "receipt.why.cancelled", share);
}

export async function venueOfSplit(token: string): Promise<{ venueId: number; venueName: string } | null> {
  const v = await splitByToken(token);
  if (!v) return null;
  const venue = await getVenue(v.venueId);
  return venue ? { venueId: venue.id, venueName: venue.name } : null;
}
