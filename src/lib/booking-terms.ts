import crypto from "crypto";
import { cancelPolicy, cancelPolicyFor, strikesFor } from "./cancel-policy";
import { cutoffFor } from "./sport-rules";
import type { Sport } from "./types";
import { getDb } from "./db";
import { holdPolicy } from "./holds";
import { takesPaymentOnline } from "./payments";

/**
 * What a customer should know before they book at a venue, in one place:
 * when cancelling is free, what a late cancellation costs, that a no-show
 * counts against their number (and what happens after enough of them), and
 * how long they have to pay where the venue holds bookings until paid.
 *
 * A customer who has read it can say not to show it again at this venue. It
 * comes back when the rules change: `version` is a digest of them. Their own
 * strikes are always shown, read or not: that is news, not a rule.
 */

export interface BookingTerms {
  venueId: number;
  cutoffHours: number;
  /** Percent kept on a late online cancellation; null: no cancelling online after the cutoff. */
  lateKeep: number | null;
  strikeLimit: number | null;
  strikeDays: number;
  /** Where a number past its strikes goes: pay online, or the counter. */
  struckOutPays: boolean;
  /** Minutes to pay before an unpaid booking is let go; null where bookings are not held. */
  holdMinutes: number | null;
  /** Or this share paid online holds it, the rest at the counter. Left out when none, so earlier versions still match. */
  depositPercent?: number;
  /** Money paid online for a booking the customer cancels comes back as stored credit here, not to the card. */
  refundsAsCredit: boolean;
  version: string;
}

export interface YourStanding {
  strikes: number;
  limit: number;
  out: boolean;
}

/** The rules for booking here, for one sport where given (its own cutoff and late-cancel share: lib/sport-rules.ts). */
export async function bookingTerms(venueId: number, sport?: Sport): Promise<BookingTerms | null> {
  const row = (await getDb().prepare("SELECT cancel_cutoff_hours FROM venues WHERE id = ?").get(venueId)) as
    | { cancel_cutoff_hours: number }
    | undefined;
  if (!row) return null;
  const policy = sport ? await cancelPolicyFor(venueId, sport) : await cancelPolicy(venueId);
  if (sport) row.cancel_cutoff_hours = await cutoffFor(venueId, sport, row.cancel_cutoff_hours);
  const hold = await holdPolicy(venueId);
  const terms = {
    venueId,
    cutoffHours: row.cancel_cutoff_hours,
    lateKeep: policy.lateKeep,
    strikeLimit: policy.strikeLimit,
    strikeDays: policy.strikeDays,
    struckOutPays: await takesPaymentOnline(venueId),
    holdMinutes: hold.active ? hold.minutes : null,
    refundsAsCredit: policy.onlineRefunds === "credit" && (await takesPaymentOnline(venueId)),
    ...(hold.active && hold.depositPercent ? { depositPercent: hold.depositPercent } : {}),
  };
  const version = crypto.createHash("sha256").update(JSON.stringify(terms)).digest("hex").slice(0, 16);
  return { ...terms, version };
}

/** Where this number stands against the venue's strike limit, when it has one and any strikes. */
export async function standing(venueId: number, phone: string | null | undefined): Promise<YourStanding | null> {
  if (!phone) return null;
  const policy = await cancelPolicy(venueId);
  if (policy.strikeLimit === null) return null;
  const strikes = await strikesFor(venueId, phone, policy.strikeDays);
  return strikes > 0 ? { strikes, limit: policy.strikeLimit, out: strikes >= policy.strikeLimit } : null;
}

export async function dismissedVersion(userId: number, venueId: number): Promise<string | null> {
  const row = (await getDb()
    .prepare("SELECT version FROM terms_dismissals WHERE user_id = ? AND venue_id = ?")
    .get(userId, venueId)) as { version: string } | undefined;
  return row?.version ?? null;
}

export async function dismissTerms(userId: number, venueId: number, version: string): Promise<void> {
  await getDb()
    .prepare(
      `INSERT INTO terms_dismissals (user_id, venue_id, version) VALUES (?, ?, ?)
       ON CONFLICT (user_id, venue_id) DO UPDATE SET version = excluded.version, dismissed_at = datetime('now')`
    )
    .run(userId, venueId, version.slice(0, 32));
}
