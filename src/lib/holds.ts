import { getDb } from "./db";
import { releaseBooking } from "./claims";
import { takesPaymentOnline } from "./payments";
import { DEPOSIT_PERCENTS } from "./types";
import { offerSlotPlace, settleCancelled } from "./store";

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
}


export async function holdPolicy(venueId: number): Promise<HoldPolicy> {
  const row = (await getDb().prepare("SELECT pay_to_hold, hold_minutes, deposit_percent FROM venues WHERE id = ?").get(venueId)) as
    | { pay_to_hold: number; hold_minutes: number; deposit_percent: number | null }
    | undefined;
  const on = row?.pay_to_hold === 1;
  return {
    on,
    minutes: row?.hold_minutes ?? 15,
    active: on && (await takesPaymentOnline(venueId)),
    depositPercent: on ? (row?.deposit_percent ?? null) : null,
  };
}

export async function setHoldPolicy(
  venueId: number,
  input: { on: boolean; minutes?: number; depositPercent?: number | null }
): Promise<{ ok: true; policy: HoldPolicy } | { ok: false; error: string }> {
  const minutes = input.minutes ?? 15;
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 60) return { ok: false, error: "Hold a booking for 5 to 60 minutes." };
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
  await getDb()
    .prepare("UPDATE venues SET pay_to_hold = ?, hold_minutes = ?, deposit_percent = ? WHERE id = ?")
    .run(input.on ? 1 : 0, minutes, deposit, venueId);
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
      `SELECT id, court_id, date FROM bookings
        WHERE hold_until IS NOT NULL AND status = 'confirmed' AND payment_status = 'unpaid' AND hold_until < datetime('now')`
    )
    .all()) as { id: number; court_id: number; date: string }[];
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
  for (const place of new Set(released.map((b) => `${b.court_id}|${b.date}`))) {
    const [court, date] = place.split("|");
    await offerSlotPlace(Number(court), date);
  }
  return released.length;
}
