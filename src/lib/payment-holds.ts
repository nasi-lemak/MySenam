import { getDb } from "./db";
import { isMarketplace } from "./mode";
import { tellOwners } from "./owner-alerts";
import { siteName } from "./site";
import { sendPlainEmail } from "./transports";

/**
 * A venue whose invoice is long overdue comes off the marketplace until it
 * is paid.
 *
 * Invoices are due 14 days after they are issued (lib/billing.ts); this gives
 * as long again. After that, every branch on the unpaid invoice is taken out
 * of sight — not found, not bookable, not paid online (lib/listing.ts) — and
 * its managers and the platform owner are told. Nothing is deleted, the
 * dashboard keeps working, and bookings customers already made stand. Paying
 * the invoice, or the owner marking it paid or voiding it, puts the venue back
 * at once.
 *
 * Worked out afresh each time from the invoices, rather than switched on and
 * off by hand, so it cannot drift from what is actually owed.
 */

export const GRACE_DAYS = 14;

function cutoff(now: Date): string {
  const d = new Date(now.getTime() + 8 * 3600_000);
  d.setUTCDate(d.getUTCDate() - GRACE_DAYS);
  return d.toISOString().slice(0, 10);
}

/** Venues with an invoice, their own or their business's, more than GRACE_DAYS past due. */
const OVERDUE = `
  SELECT v.id FROM venues v
   WHERE EXISTS (SELECT 1 FROM venue_invoices i WHERE i.venue_id = v.id AND i.status = 'due' AND i.due_on < ?)
      OR (v.business_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM venue_invoices i WHERE i.business_id = v.business_id AND i.status = 'due' AND i.due_on < ?))`;

export interface HoldChanges {
  held: { id: number; name: string }[];
  lifted: { id: number; name: string }[];
}

/** Take off what is long overdue, and put back what has been settled. */
export async function applyPaymentHolds(now = new Date()): Promise<HoldChanges> {
  if (!isMarketplace()) return { held: [], lifted: [] };
  const db = getDb();
  const before = cutoff(now);
  let changes: HoldChanges = { held: [], lifted: [] };
  await db.transaction(async () => {
    const held = (await db
      .prepare(
        `UPDATE venues SET suspended_at = datetime('now')
          WHERE suspended_at IS NULL AND id IN (${OVERDUE}) RETURNING id, name`
      )
      .all(before, before)) as { id: number; name: string }[];
    const lifted = (await db
      .prepare(
        `UPDATE venues SET suspended_at = NULL
          WHERE suspended_at IS NOT NULL AND id NOT IN (${OVERDUE}) RETURNING id, name`
      )
      .all(before, before)) as { id: number; name: string }[];
    changes = { held, lifted };
  })();

  for (const v of changes.held) {
    await tellStaff(
      v.id,
      `${v.name} is off ${siteName()} until its invoice is paid`,
      `An invoice for ${v.name} is more than ${GRACE_DAYS} days overdue, so customers cannot find, book or pay ` +
        `it online until it is paid. Your dashboard works as before, and bookings already made stand.\n\n` +
        `Pay it under Venues & staff → Billing, and ${v.name} is back straight away.`
    );
  }
  if (changes.held.length > 0)
    await tellOwners(
      `${changes.held.length === 1 ? changes.held[0].name : `${changes.held.length} venues`} taken off for an unpaid invoice`,
      `More than ${GRACE_DAYS} days overdue: ${changes.held.map((v) => v.name).join(", ")}. ` +
        "They come back on their own once paid, marked paid, or the invoice is voided."
    );
  for (const v of changes.lifted)
    await tellStaff(v.id, `${v.name} is back on ${siteName()}`, `Thank you. Customers can find and book ${v.name} again.`);
  return changes;
}

/** A venue's managers and staff, by email. */
async function tellStaff(venueId: number, subject: string, body: string): Promise<void> {
  const people = (await getDb()
    .prepare(
      `SELECT a.email, a.name FROM admins a
        WHERE a.venue_id = ? OR a.business_id = (SELECT business_id FROM venues WHERE id = ?)`
    )
    .all(venueId, venueId)) as { email: string; name: string }[];
  for (const p of people) await sendPlainEmail(p.email, subject, `Hi ${p.name},\n\n${body}\n\n${siteName()}`);
}
