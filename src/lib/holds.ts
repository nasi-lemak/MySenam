import { getDb } from "./db";
import { releaseBooking } from "./claims";
import { takesPaymentOnline } from "./payments";
import { DEPOSIT_PERCENTS, WAITLIST_OFFER_LEAST_MINUTES, WAITLIST_OFFER_MINUTES, WAITLIST_OFFER_MOST_MINUTES } from "./types";
import { offerFreedPlace, settleCancelled } from "./store";

/**
 * Paying online to hold a booking.
 *
 * Most venues take a booking on trust and the money at the counter. One that
 * loses too many slots to people who never come can ask instead for payment
 * online to hold it: a booking made online is then held for a few minutes
 * (`hold_minutes`, 15 unless set) while the customer pays, and let go for
 * somebody else if they do not. Paid, it stands and is confirmed by email
 * with its calendar invite; until then nobody is told it is theirs.
 *
 * Opening the payment page holds it for 30 minutes more from then, so a
 * customer part-way through paying is not undercut. A payment that still lands
 * after the booking was let go is recorded as owed back, as for any booking
 * cancelled after paying (lib/payments.ts).
 *
 * Only bookings made online by customers are held. Staff at the counter,
 * bookings paid at once from credit or a pass, and free ones are not.
 */

/**
 * How long a held booking waits on its payment page, and how long the page
 * stays open where the gateway can close it (Stripe: 30 minutes at the least),
 * so nobody pays for a slot already let go.
 */
export const PAYMENT_PAGE_MINUTES = 30;

export interface HoldPolicy {
  /** Asked for, by the venue. */
  on: boolean;
  minutes: number;
  /** In force: asked for, and the venue can take payment online. */
  active: boolean;
  /** The share of the price the customer may pay now to hold it, the rest at the counter; null: the whole price. */
  depositPercent: number | null;
  /**
   * How long a waiting-list offer of a place lasts at the most, whether or not holds are on (ADR 0060): shortened to the time left
   * to the start of what is offered, and not made at all with fewer than a few minutes left.
   */
  offerMinutes: number;
}


export async function holdPolicy(venueId: number): Promise<HoldPolicy> {
  const row = (await getDb().prepare("SELECT pay_to_hold, hold_minutes, deposit_percent, waitlist_offer_minutes FROM venues WHERE id = ?").get(venueId)) as
    | { pay_to_hold: number; hold_minutes: number; deposit_percent: number | null; waitlist_offer_minutes: number }
    | undefined;
  const on = row?.pay_to_hold === 1;
  return {
    on,
    minutes: row?.hold_minutes ?? 15,
    active: on && (await takesPaymentOnline(venueId)),
    depositPercent: on ? (row?.deposit_percent ?? null) : null,
    offerMinutes: row?.waitlist_offer_minutes ?? WAITLIST_OFFER_MINUTES,
  };
}

export async function setHoldPolicy(
  venueId: number,
  input: { on: boolean; minutes?: number; depositPercent?: number | null; offerMinutes?: number }
): Promise<{ ok: true; policy: HoldPolicy } | { ok: false; error: string }> {
  const minutes = input.minutes ?? 15;
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 60) return { ok: false, error: "Hold a booking for 5 to 60 minutes." };
  // Not given: as it was.
  if (
    input.offerMinutes !== undefined &&
    (!Number.isInteger(input.offerMinutes) || input.offerMinutes < WAITLIST_OFFER_LEAST_MINUTES || input.offerMinutes > WAITLIST_OFFER_MOST_MINUTES)
  )
    return { ok: false, error: `Hold a waiting-list offer for ${WAITLIST_OFFER_LEAST_MINUTES} to ${WAITLIST_OFFER_MOST_MINUTES} minutes.` };
  // Not given: as it was.
  const deposit =
    input.depositPercent !== undefined
      ? input.depositPercent
      : (((await getDb().prepare("SELECT deposit_percent FROM venues WHERE id = ?").get(venueId)) as { deposit_percent: number | null } | undefined)
          ?.deposit_percent ?? null);
  if (deposit !== null && !(DEPOSIT_PERCENTS as readonly number[]).includes(deposit))
    return { ok: false, error: `A deposit of ${DEPOSIT_PERCENTS.join(", ")} percent, or the whole price.` };
  if (input.on && !(await takesPaymentOnline(venueId)))
    return { ok: false, error: "Set up taking payment online first: there is no way to pay without it." };
  // Since when holds are asked for: from the moment it is turned on, kept while it stays on (`holdStrandedBookings`).
  await getDb()
    .prepare(
      `UPDATE venues SET pay_to_hold_since = CASE WHEN ? = 0 THEN NULL WHEN pay_to_hold = 1 THEN pay_to_hold_since ELSE datetime('now') END,
              pay_to_hold = ?, hold_minutes = ?, deposit_percent = ? WHERE id = ?`
    )
    .run(input.on ? 1 : 0, input.on ? 1 : 0, minutes, deposit, venueId);
  if (input.offerMinutes !== undefined) await getDb().prepare("UPDATE venues SET waitlist_offer_minutes = ? WHERE id = ?").run(input.offerMinutes, venueId);
  return { ok: true, policy: await holdPolicy(venueId) };
}

/** Hold these new, unpaid bookings for the venue's minutes. Returns until when, or null if none was held. */
export async function holdNewBookings(bookingIds: number[], minutes: number): Promise<string | null> {
  if (bookingIds.length === 0) return null;
  const db = getDb();
  await db
    .prepare(
      `UPDATE bookings SET hold_until = datetime('now', '+${Math.round(minutes)} minutes')
        WHERE id IN (${bookingIds.map(() => "?").join(",")}) AND payment_status = 'unpaid' AND total_price > 0`
    )
    .run(...bookingIds);
  const row = (await db
    .prepare(`SELECT MIN(hold_until) AS until FROM bookings WHERE id IN (${bookingIds.map(() => "?").join(",")})`)
    .get(...bookingIds)) as { until: string | null };
  return row.until;
}

/**
 * A booking made online whose request died after the booking was saved and before its hold was applied
 * (`holdNewBookings` runs last in the booking route) stands confirmed and unpaid with no hold at a venue that asks
 * for payment online to hold, and nothing would ever let it go (ADR 0054). The scheduler's sweep puts the hold such
 * a booking would have had, from when it was made: still running, the customer has the rest of their minutes; past,
 * `releaseExpiredHolds` lets it go in the same tick. Idempotent and safe to run twice or concurrently: one UPDATE
 * that only touches a booking still unpaid with no hold, and a hold that is there is never moved. Only what the
 * booking route holds is swept: made online by a customer, not on an account, not a class place, unpaid with
 * nothing paid towards it, no payment ever started for it, not made for an approval, at a venue whose holds are in
 * force, and made since they were turned on. Returns how many were held.
 */
export async function holdStrandedBookings(): Promise<number> {
  const db = getDb();
  const rows = (await db
    .prepare(
      `SELECT b.id, c.venue_id, v.hold_minutes FROM bookings b JOIN courts c ON c.id = b.court_id JOIN venues v ON v.id = c.venue_id
        WHERE v.pay_to_hold = 1 AND b.hold_until IS NULL AND b.status = 'confirmed' AND b.payment_status = 'unpaid'
          AND b.total_price > 0 AND b.deposit_paid = 0 AND b.shares_paid = 0 AND b.account_id IS NULL AND b.class_id IS NULL AND b.demo = 0
          AND b.made_on = 'customer'
          AND b.created_at < datetime('now', '-5 minutes') AND b.created_at > datetime('now', '-3 hours')
          AND (v.pay_to_hold_since IS NULL OR b.created_at >= v.pay_to_hold_since)
          AND NOT EXISTS (SELECT 1 FROM online_payment_bookings pb WHERE pb.booking_id = b.id)
          AND NOT EXISTS (SELECT 1 FROM approval_requests ar WHERE ar.booking_id = b.id)
        ORDER BY b.id LIMIT 200`
    )
    .all()) as { id: number; venue_id: number; hold_minutes: number | null }[];
  if (rows.length === 0) return 0;
  const active = new Map<number, boolean>();
  let held = 0;
  for (const r of rows) {
    if (!active.has(r.venue_id)) active.set(r.venue_id, (await holdPolicy(r.venue_id)).active);
    if (!active.get(r.venue_id)) continue;
    const done = await db
      .prepare(
        `UPDATE bookings SET hold_until = datetime(created_at, '+${Math.round(r.hold_minutes ?? 15)} minutes')
          WHERE id = ? AND hold_until IS NULL AND status = 'confirmed' AND payment_status = 'unpaid' AND deposit_paid = 0`
      )
      .run(r.id);
    held += done.changes;
  }
  return held;
}

/**
 * The customer has the payment page open: give them time to finish. Once per
 * booking, and only while the hold is still running, so opening the page over
 * and over cannot keep a court held without paying.
 */
export async function extendHolds(bookingIds: number[]): Promise<void> {
  if (bookingIds.length === 0) return;
  await getDb()
    .prepare(
      `UPDATE bookings SET hold_until = datetime('now', '+${PAYMENT_PAGE_MINUTES} minutes'), hold_extended = 1
        WHERE id IN (${bookingIds.map(() => "?").join(",")}) AND hold_until IS NOT NULL AND hold_extended = 0
          AND payment_status = 'unpaid' AND hold_until > datetime('now')
          AND hold_until < datetime('now', '+${PAYMENT_PAGE_MINUTES} minutes')`
    )
    .run(...bookingIds);
}

/**
 * Let go of every held booking not paid in time: cancelled, its places
 * freed, and offered to whoever has waited for them. Cheap enough to call on
 * the way past — booking, reading a day's availability — as well as on the
 * scheduler's tick, so a slot comes free on time even with no scheduler.
 */
export async function releaseExpiredHolds(): Promise<number> {
  const db = getDb();
  const due = (await db
    .prepare(
      `SELECT id, court_id, date, class_id FROM bookings
        WHERE hold_until IS NOT NULL AND status = 'confirmed' AND payment_status = 'unpaid' AND hold_until < datetime('now')`
    )
    .all()) as { id: number; court_id: number; date: string; class_id: number | null }[];
  if (due.length === 0) return 0;
  const released: typeof due = [];
  for (const b of due) {
    const done = await db.transaction(async () => {
      // Paid, or let go by another caller, since the read: leave it.
      const claimed = await db
        .prepare(
          // A deposit paid stands it, even in the moment before its hold is cleared (lib/payments.ts).
          "UPDATE bookings SET status = 'cancelled', released_unpaid = 1 WHERE id = ? AND status = 'confirmed' AND payment_status = 'unpaid' AND deposit_paid = 0 AND hold_until < datetime('now')"
        )
        .run(b.id);
      if (claimed.changes === 0) return false;
      await releaseBooking(b.id);
      // As any cancellation, in the same transaction: a promo use given back,
      // an open game called off and its shares owed back.
      await settleCancelled(b.id);
      return true;
    })();
    if (done) released.push(b);
  }
  // Each freed place to whoever waits for it: a class place to its class's list, court time to the court's (ADR 0060).
  for (const place of new Set(released.map((b) => (b.class_id ? `class|${b.class_id}` : `${b.court_id}|${b.date}`)))) {
    const [court, date] = place.split("|");
    if (court === "class") await offerFreedPlace({ classId: Number(date) });
    else await offerFreedPlace({ courtId: Number(court), date });
  }
  return released.length;
}
