import { getDb } from "./db";
import { phoneKey } from "./phone";
import { addDays, todayISO } from "./time";

/**
 * What a late cancellation or a no-show costs, set by each venue.
 *
 * Free cancellation up to the venue's cutoff is unchanged. After it, by
 * default, a customer cannot cancel online at all and has to call; a venue
 * can instead let them, keeping a share of what was paid (`lateKeep`, a
 * percentage) and sending the rest back the way it came. Where it does not,
 * it may still let them give the court back (`giveBack`, off by default):
 * cancelled online until the slot starts, nothing refunded (the venue keeps
 * all of it, the same path as keeping 100%), the slot offered again and the
 * waiting list told.
 *
 * A strike is a no-show, or a late cancellation of a booking nobody paid for
 * (one that was paid has paid its fee). After `strikeLimit` strikes in
 * `strikeDays` days a number must pay online to book here, where the venue
 * takes payment online, and otherwise books at the counter.
 *
 * `onlineRefunds` is what happens to money paid online when a customer
 * cancels (lib/payments.ts `refundCancelled`): staff refund it, as before; it
 * goes straight back through the gateway where that has a refund API; or it
 * becomes stored credit on the customer's account. Where staff refund it,
 * `refundWithinDays` is what the customer is told it takes; one owed longer
 * is overdue (lib/payments.ts `refundsOwed`).
 */
export type OnlineRefunds = "staff" | "gateway" | "credit";
const ONLINE_REFUNDS: OnlineRefunds[] = ["staff", "gateway", "credit"];

export interface CancelPolicy {
  /** Percent of what was paid the venue keeps on a late cancellation; null: no late cancelling online. */
  lateKeep: number | null;
  /** With `lateKeep` null: a customer may still give the court back late, nothing refunded. Off by default. */
  giveBack: boolean;
  strikeLimit: number | null;
  strikeDays: number;
  onlineRefunds: OnlineRefunds;
  /** Days staff take to refund by hand, as customers are told. */
  refundWithinDays: number;
}

export async function cancelPolicy(venueId: number): Promise<CancelPolicy> {
  const row = (await getDb()
    .prepare("SELECT late_cancel_keep, late_give_back, strike_limit, strike_days, online_refunds, refund_within_days FROM venues WHERE id = ?")
    .get(venueId)) as
    | { late_cancel_keep: number | null; late_give_back: boolean; strike_limit: number | null; strike_days: number; online_refunds: OnlineRefunds; refund_within_days: number }
    | undefined;
  return {
    lateKeep: row?.late_cancel_keep ?? null,
    giveBack: row?.late_give_back === true,
    strikeLimit: row?.strike_limit ?? null,
    strikeDays: row?.strike_days ?? 90,
    onlineRefunds: row?.online_refunds ?? "staff",
    refundWithinDays: row?.refund_within_days ?? 7,
  };
}

/** The venue's policy as it applies to one sport: that sport's own late-cancel share, where it has one. */
export async function cancelPolicyFor(venueId: number, sport: string): Promise<CancelPolicy> {
  const policy = await cancelPolicy(venueId);
  const row = (await getDb().prepare("SELECT late_keep FROM sport_rules WHERE venue_id = ? AND sport = ?").get(venueId, sport)) as
    | { late_keep: number | null }
    | undefined;
  if (row?.late_keep === null || row?.late_keep === undefined) return policy;
  return { ...policy, lateKeep: row.late_keep === -1 ? null : row.late_keep };
}

/**
 * The cancellation terms that govern one booking (ADR 0069, DEC-09): the ones snapshotted on it when it was made
 * (`bookings.cancel_terms`, lib/booking-terms.ts `cancelTermsSnapshot`), so a manager editing the cutoff or the late-cancel
 * share afterwards changes what new bookings are sold on and nothing already sold. A booking from before the snapshot
 * existed (NULL) is read on the venue's current terms, as it always was: what it was shown is not recorded anywhere, so none is
 * invented. `source` says which.
 */
export interface BookingCancelTerms extends CancelPolicy {
  cutoffHours: number;
  source: "booked" | "current";
  /** The digest of the terms shown at booking (the terms endpoint's `version`), where snapshotted. */
  version: string | null;
}

/** What is kept on a booking of the terms it was sold on: the entitlement is read back, the rest is evidence. */
export interface StoredCancelTerms {
  v: 1;
  takenAt: string;
  version: string;
  cutoffHours: number;
  lateKeep: number | null;
  giveBack: boolean;
  strikeLimit: number | null;
  strikeDays: number;
  onlineRefunds: OnlineRefunds;
  refundWithinDays: number;
  holdMinutes: number | null;
  depositPercent: number | null;
  refundsAsCredit: boolean;
}

/** A stored snapshot, if what is there is one this code wrote; anything malformed is no snapshot (the current terms then apply). */
export function readStoredTerms(raw: unknown): StoredCancelTerms | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null) return null;
  const t = value as Record<string, unknown>;
  const hours = t.cutoffHours;
  if (t.v !== 1 || typeof hours !== "number" || !Number.isInteger(hours) || hours < 0) return null;
  if (t.lateKeep !== null && (typeof t.lateKeep !== "number" || t.lateKeep < 0 || t.lateKeep > 100)) return null;
  if (typeof t.giveBack !== "boolean") return null;
  return t as unknown as StoredCancelTerms;
}

/** The terms that govern a booking: its snapshot where it has one, else the venue's current ones for its sport. */
export async function bookingCancelTerms(bookingId: number): Promise<BookingCancelTerms | null> {
  const row = (await getDb()
    .prepare(
      `SELECT b.cancel_terms, b.sport, c.venue_id, COALESCE(sr.cancel_cutoff_hours, v.cancel_cutoff_hours) AS live_cutoff
         FROM bookings b
         JOIN courts c ON c.id = b.court_id
         JOIN venues v ON v.id = c.venue_id
         -- The sport's own, where the venue gave it one (lib/sport-rules.ts).
         LEFT JOIN sport_rules sr ON sr.venue_id = v.id AND sr.sport = b.sport
        WHERE b.id = ?`
    )
    .get(bookingId)) as { cancel_terms: unknown; sport: string; venue_id: number; live_cutoff: number } | undefined;
  if (!row) return null;
  const stored = readStoredTerms(row.cancel_terms);
  const live = await cancelPolicyFor(row.venue_id, row.sport);
  if (!stored) return { ...live, cutoffHours: row.live_cutoff ?? 0, source: "current", version: null };
  return {
    ...live,
    // What was shown at booking is the entitlement. How money goes back and the strike rules stay the venue's current settings:
    // the amount owed is the same whichever way it is paid, and a strike limit is about a number, not about this booking.
    lateKeep: stored.lateKeep,
    giveBack: stored.giveBack,
    cutoffHours: stored.cutoffHours,
    source: "booked",
    version: typeof stored.version === "string" ? stored.version : null,
  };
}

export async function setCancelPolicy(
  venueId: number,
  input: { lateKeep?: unknown; giveBack?: unknown; strikeLimit?: unknown; strikeDays?: unknown; onlineRefunds?: unknown; refundWithinDays?: unknown }
): Promise<{ ok: true; policy: CancelPolicy } | { ok: false; error: string }> {
  const keep = input.lateKeep ?? null;
  if (keep !== null && (!Number.isInteger(keep) || (keep as number) < 0 || (keep as number) > 100))
    return { ok: false, error: "Keep 0 to 100 percent, or leave late cancelling off." };
  // Left out: as it is (a form or a script that does not know of it changes nothing).
  const giveBack = input.giveBack === undefined ? (await cancelPolicy(venueId)).giveBack : input.giveBack;
  if (typeof giveBack !== "boolean") return { ok: false, error: "Say whether customers may give a court back late: true or false." };
  const limit = input.strikeLimit ?? null;
  if (limit !== null && (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 20))
    return { ok: false, error: "Strikes before paying online: 1 to 20, or off." };
  const days = input.strikeDays ?? 90;
  if (!Number.isInteger(days) || (days as number) < 7 || (days as number) > 365) return { ok: false, error: "Count strikes over 7 to 365 days." };
  const refunds = input.onlineRefunds ?? "staff";
  if (!ONLINE_REFUNDS.includes(refunds as OnlineRefunds)) return { ok: false, error: "Choose how money paid online goes back." };
  const within = input.refundWithinDays ?? (await cancelPolicy(venueId)).refundWithinDays;
  if (!Number.isInteger(within) || (within as number) < 1 || (within as number) > 30)
    return { ok: false, error: "Say how many days refunds by hand take: 1 to 30." };
  await getDb()
    .prepare("UPDATE venues SET late_cancel_keep = ?, late_give_back = ?, strike_limit = ?, strike_days = ?, online_refunds = ?, refund_within_days = ? WHERE id = ?")
    .run(keep, giveBack, limit, days, refunds, within, venueId);
  return { ok: true, policy: await cancelPolicy(venueId) };
}

/** A number's strikes at a venue in its counting window. */
export async function strikesFor(venueId: number, phone: string, days?: number): Promise<number> {
  const window = days ?? (await cancelPolicy(venueId)).strikeDays;
  const row = (await getDb()
    .prepare(
      `SELECT COUNT(*)::int AS n FROM bookings b JOIN courts c ON c.id = b.court_id
        WHERE c.venue_id = ? AND b.phone_key = ? AND b.date >= ?
          -- A test booking, from before the venue went live, is nobody's strike (lib/test-bookings.ts).
          AND NOT b.test
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

/**
 * What cancelling online past the cutoff does at this venue, for this sport:
 * the share kept (`lateKeep`), or, where the venue lets customers give the
 * court back instead, all of it (`giveBack`); null: it cannot be done online.
 */
export function lateCancelTerms(policy: Pick<CancelPolicy, "lateKeep" | "giveBack">): { keep: number; giveBack: boolean } | null {
  if (policy.lateKeep !== null) return { keep: policy.lateKeep, giveBack: false };
  return policy.giveBack ? { keep: 100, giveBack: true } : null;
}
