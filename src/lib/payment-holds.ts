import { getDb } from "./db";
import { isMarketplace } from "./mode";
import { tellOwners, tellVenueStaff } from "./owner-alerts";
import { siteName } from "./site";
import { money, offsetMs } from "./region";

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
/** How far into the grace a venue is warned that it is coming off. */
export const WARN_AFTER_DAYS = 7;

/** Malaysia's date, `days` before now. */
function daysAgo(now: Date, days: number): string {
  const d = new Date(now.getTime() + offsetMs());
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
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

/**
 * Warn what is a week overdue, take off what is long overdue, and put back
 * what has been settled. A venue the platform owner suspended is theirs to
 * put back (lib/suspensions.ts): settling an invoice does not lift that.
 */
export async function applyPaymentHolds(now = new Date()): Promise<HoldChanges> {
  if (!isMarketplace()) return { held: [], lifted: [] };
  const db = getDb();
  const before = daysAgo(now, GRACE_DAYS);
  await warnOverdue(now);
  let changes: HoldChanges = { held: [], lifted: [] };
  await db.transaction(async () => {
    const held = (await db
      .prepare(
        `UPDATE venues SET suspended_at = datetime('now'), suspended_by = 'payment', suspended_reason = NULL
          WHERE suspended_at IS NULL AND id IN (${OVERDUE}) RETURNING id, name`
      )
      .all(before, before)) as { id: number; name: string }[];
    const lifted = (await db
      .prepare(
        `UPDATE venues SET suspended_at = NULL, suspended_by = NULL
          WHERE suspended_by = 'payment' AND id NOT IN (${OVERDUE}) RETURNING id, name`
      )
      .all(before, before)) as { id: number; name: string }[];
    changes = { held, lifted };
  })();

  for (const v of changes.held) {
    await tellVenueStaff(
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
    await tellVenueStaff(v.id, `${v.name} is back on ${siteName()}`, `Thank you. Customers can find and book ${v.name} again.`);
  return changes;
}

/**
 * A week into the grace, once per invoice: what is owed, and the day the
 * venue comes off if it is still owed then.
 */
async function warnOverdue(now: Date): Promise<void> {
  const db = getDb();
  const due = (await db
    .prepare(
      `UPDATE venue_invoices SET warned_at = datetime('now')
        WHERE status = 'due' AND warned_at IS NULL AND due_on < ? AND due_on >= ?
        RETURNING id, venue_id, business_id, amount, due_on, period`
    )
    .all(daysAgo(now, WARN_AFTER_DAYS), daysAgo(now, GRACE_DAYS))) as {
    id: number;
    venue_id: number | null;
    business_id: number | null;
    amount: number;
    due_on: string;
    period: string;
  }[];
  for (const invoice of due) {
    const venues = (await db
      .prepare("SELECT id, name FROM venues WHERE id = ? OR (business_id = ? AND published_at IS NOT NULL) ORDER BY id")
      .all(invoice.venue_id, invoice.business_id)) as { id: number; name: string }[];
    if (venues.length === 0) continue;
    const names = venues.map((v) => v.name).join(", ");
    const offOn = addDays(invoice.due_on, GRACE_DAYS + 1);
    await tellVenueStaff(
      venues[0].id,
      `Your ${siteName()} invoice is overdue`,
      `The invoice for ${invoice.period}, ${money(Number(invoice.amount).toFixed(2))}, was due on ${invoice.due_on}. ` +
        `If it is still unpaid on ${offOn}, ${names} will be hidden from customers until it is paid. ` +
        `Bookings already made will stand.\n\nPay it under Venues & staff → Billing.`
    );
  }
}
