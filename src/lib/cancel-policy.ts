import { getDb } from "./db";
import { phoneKey } from "./phone";
import { addDays, todayISO } from "./time";

/**
 * What a late cancellation or a no-show costs, set by each venue.
 *
 * Free cancellation up to the venue's cutoff is unchanged. After it, by
 * default, a customer cannot cancel online at all and has to call; a venue
 * can instead let them, keeping a share of what was paid (`lateKeep`, a
 * percentage) and sending the rest back the way it came.
 *
 * A strike is a no-show, or a late cancellation of a booking nobody paid for
 * (one that was paid has paid its fee). After `strikeLimit` strikes in
 * `strikeDays` days a number must pay online to book here, where the venue
 * takes payment online, and otherwise books at the counter.
 *
 * `onlineRefunds` is what happens to money paid online when a customer
 * cancels (lib/payments.ts `refundCancelled`): staff refund it, as before; it
 * goes straight back through the gateway where that has a refund API; or it
 * becomes stored credit on the customer's account.
 */
export type OnlineRefunds = "staff" | "gateway" | "credit";
const ONLINE_REFUNDS: OnlineRefunds[] = ["staff", "gateway", "credit"];

export interface CancelPolicy {
  /** Percent of what was paid the venue keeps on a late cancellation; null: no late cancelling online. */
  lateKeep: number | null;
  strikeLimit: number | null;
  strikeDays: number;
  onlineRefunds: OnlineRefunds;
}

export async function cancelPolicy(venueId: number): Promise<CancelPolicy> {
  const row = (await getDb()
    .prepare("SELECT late_cancel_keep, strike_limit, strike_days, online_refunds FROM venues WHERE id = ?")
    .get(venueId)) as
    | { late_cancel_keep: number | null; strike_limit: number | null; strike_days: number; online_refunds: OnlineRefunds }
    | undefined;
  return {
    lateKeep: row?.late_cancel_keep ?? null,
    strikeLimit: row?.strike_limit ?? null,
    strikeDays: row?.strike_days ?? 90,
    onlineRefunds: row?.online_refunds ?? "staff",
  };
}

export async function setCancelPolicy(
  venueId: number,
  input: { lateKeep?: unknown; strikeLimit?: unknown; strikeDays?: unknown; onlineRefunds?: unknown }
): Promise<{ ok: true; policy: CancelPolicy } | { ok: false; error: string }> {
  const keep = input.lateKeep ?? null;
  if (keep !== null && (!Number.isInteger(keep) || (keep as number) < 0 || (keep as number) > 100))
    return { ok: false, error: "Keep 0 to 100 percent, or leave late cancelling off." };
  const limit = input.strikeLimit ?? null;
  if (limit !== null && (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 20))
    return { ok: false, error: "Strikes before paying online: 1 to 20, or off." };
  const days = input.strikeDays ?? 90;
  if (!Number.isInteger(days) || (days as number) < 7 || (days as number) > 365) return { ok: false, error: "Count strikes over 7 to 365 days." };
  const refunds = input.onlineRefunds ?? "staff";
  if (!ONLINE_REFUNDS.includes(refunds as OnlineRefunds)) return { ok: false, error: "Choose how money paid online goes back." };
  await getDb()
    .prepare("UPDATE venues SET late_cancel_keep = ?, strike_limit = ?, strike_days = ?, online_refunds = ? WHERE id = ?")
    .run(keep, limit, days, refunds, venueId);
  return { ok: true, policy: await cancelPolicy(venueId) };
}

/** A number's strikes at a venue in its counting window. */
export async function strikesFor(venueId: number, phone: string, days?: number): Promise<number> {
  const window = days ?? (await cancelPolicy(venueId)).strikeDays;
  const row = (await getDb()
    .prepare(
      `SELECT COUNT(*)::int AS n FROM bookings b JOIN courts c ON c.id = b.court_id
        WHERE c.venue_id = ? AND b.phone_key = ? AND b.date >= ?
          -- Forgiven by the venue: only what came after counts again.
          AND b.date > COALESCE((SELECT forgiven_on FROM strike_forgiveness f WHERE f.venue_id = c.venue_id AND f.phone_key = b.phone_key), '')
          -- A late cancellation the venue was paid something for (in full, or a deposit it kept part of) is not one.
          AND (b.no_show = 1 OR (b.late_cancelled = 1 AND b.payment_status <> 'paid' AND b.deposit_paid = 0))`
    )
    .get(venueId, phoneKey(phone), addDays(todayISO(), -window))) as { n: number };
  return row.n;
}

/** Whether this number has run out of trust here: it pays online to book, or books at the counter. */
export async function struckOut(venueId: number, phone: string): Promise<{ out: boolean; strikes: number }> {
  const policy = await cancelPolicy(venueId);
  if (policy.strikeLimit === null) return { out: false, strikes: 0 };
  const strikes = await strikesFor(venueId, phone, policy.strikeDays);
  return { out: strikes >= policy.strikeLimit, strikes };
}

/**
 * The venue lets a number off: its strikes so far stop counting. Staff do it
 * when a no-show had a good reason, or was marked by mistake.
 */
export async function forgiveStrikes(venueId: number, phone: string, adminId: number | null): Promise<void> {
  await getDb()
    .prepare(
      `INSERT INTO strike_forgiveness (venue_id, phone_key, forgiven_on, admin_id) VALUES (?, ?, ?, ?)
       ON CONFLICT (venue_id, phone_key) DO UPDATE SET forgiven_on = excluded.forgiven_on, admin_id = excluded.admin_id`
    )
    .run(venueId, phoneKey(phone), todayISO(), adminId);
}
