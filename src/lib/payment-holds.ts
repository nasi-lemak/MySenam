import { getDb, mustRethrow } from "./db";
import { isMarketplace } from "./mode";
import { tellOwnersEach, tellVenueStaffEach } from "./owner-alerts";
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
 * at once; so does the owner giving it time (`giveInvoiceGrace`, ADR 0063):
 * the venue is not held for that invoice until after the date given. Its
 * customers are told once when it goes off (lib/suspension-notices.ts).
 *
 * Worked out afresh each time from the invoices, rather than switched on and
 * off by hand, so it cannot drift from what is actually owed.
 */

export const GRACE_DAYS = 14;
/** How far into the grace a venue is warned that it is coming off. */
export const WARN_AFTER_DAYS = 7;

/**
 * How many days before an invoice falls due its managers are reminded (MYSENAM_INVOICE_REMINDER_DAYS, default 3; 0 turns the reminder
 * off). Never more than the days the invoice has to run (14), so it is not sent the day it is issued.
 */
export function invoiceReminderDays(): number {
  const n = Number(process.env.MYSENAM_INVOICE_REMINDER_DAYS ?? 3);
  return Number.isInteger(n) && n >= 0 && n <= 13 ? n : 3;
}

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

/**
 * Venues with an invoice, their own or their business's, more than GRACE_DAYS past due, and not given more time by the owner
 * (`billing_grace_until`, see `giveInvoiceGrace`: the venue is held from the day after it). Four parameters: the cut-off and today, twice.
 */
const OVERDUE = `
  SELECT v.id FROM venues v
   WHERE EXISTS (SELECT 1 FROM venue_invoices i WHERE i.venue_id = v.id AND i.status = 'due' AND i.due_on < ?
                    AND (i.billing_grace_until IS NULL OR i.billing_grace_until < ?))
      OR (v.business_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM venue_invoices i WHERE i.business_id = v.business_id AND i.status = 'due' AND i.due_on < ?
               AND (i.billing_grace_until IS NULL OR i.billing_grace_until < ?)))`;

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
  const today = daysAgo(now, 0);
  await warnOverdue(now);
  let changes: HoldChanges = { held: [], lifted: [] };
  await db.transaction(async () => {
    const held = (await db
      .prepare(
        `UPDATE venues SET suspended_at = datetime('now'), suspended_by = 'payment', suspended_reason = NULL
          WHERE suspended_at IS NULL AND id IN (${OVERDUE}) RETURNING id, name`
      )
      .all(before, today, before, today)) as { id: number; name: string }[];
    const lifted = (await db
      .prepare(
        `UPDATE venues SET suspended_at = NULL, suspended_by = NULL
          WHERE suspended_by = 'payment' AND id NOT IN (${OVERDUE}) RETURNING id, name`
      )
      .all(before, today, before, today)) as { id: number; name: string }[];
    changes = { held, lifted };
  })();

  for (const v of changes.held) {
    await tellVenueStaffEach(v.id, (t) => ({
      subject: t("r9d.hold.s", { venue: v.name }),
      body: t("r9d.hold.b", { venue: v.name, days: GRACE_DAYS, place: `${t("sh.tab.venuesStaff")} → ${t("bill.title")}` }),
    }));
  }
  if (changes.held.length > 0)
    await tellOwnersEach((t) => ({
      subject:
        changes.held.length === 1
          ? t("r9d.hold.owners.one", { venue: changes.held[0].name })
          : t("r9d.hold.owners.many", { n: changes.held.length }),
      body: t("r9d.hold.owners.b", { days: GRACE_DAYS, names: changes.held.map((v) => v.name).join(", ") }),
    }));
  for (const v of changes.lifted)
    await tellVenueStaffEach(v.id, (t) => ({ subject: t("r9d.back.s", { name: v.name }), body: t("r9d.hold.lifted.b", { venue: v.name }) }));
  await afterSuspensions();
  return changes;
}

/**
 * What follows a venue going off or coming back, by whatever route (ADR 0063): its customers told once (lib/suspension-notices.ts: any
 * suspension not yet told for, so a stop after the suspension is mended here), and memberships that renew by themselves paused at the
 * gateway while it is off and carried on once it is back (lib/payments.ts `reconcileRenewalPauses`). It must never undo a suspension or a
 * lift, so what fails is logged and left for the next run.
 */
export async function afterSuspensions(): Promise<void> {
  try {
    await (await import("./suspension-notices")).tellSuspendedVenues();
  } catch (err) {
    if (mustRethrow(err)) throw err;
    console.error("[mysenam] telling a suspended venue's customers failed:", err instanceof Error ? err.message : "unknown error");
  }
  try {
    await (await import("./payments")).reconcileRenewalPauses();
  } catch (err) {
    if (mustRethrow(err)) throw err;
    console.error("[mysenam] pausing or resuming membership renewals failed:", err instanceof Error ? err.message : "unknown error");
  }
}

/**
 * A week into the grace, once per invoice: what is owed, and the day the
 * venue comes off if it is still owed then. Told first and stamped after, each
 * email under the invoice's own dedupe key: a stop between the two tells it
 * again on the next run and writes nothing twice, where stamping first would
 * lose the warning for good.
 */
async function warnOverdue(now: Date): Promise<void> {
  const db = getDb();
  const due = (await db
    .prepare(
      `SELECT id, venue_id, business_id, amount, due_on, period FROM venue_invoices
        WHERE status = 'due' AND warned_at IS NULL AND billing_grace_until IS NULL AND due_on < ? AND due_on >= ?`
    )
    .all(daysAgo(now, WARN_AFTER_DAYS), daysAgo(now, GRACE_DAYS))) as InvoiceRow[];
  for (const invoice of due) {
    const venues = (await db
      .prepare("SELECT id, name FROM venues WHERE id = ? OR (business_id = ? AND published_at IS NOT NULL) ORDER BY id")
      .all(invoice.venue_id, invoice.business_id)) as { id: number; name: string }[];
    if (venues.length > 0) {
      const names = venues.map((v) => v.name).join(", ");
      const offOn = addDays(invoice.due_on, GRACE_DAYS + 1);
      await tellVenueStaffEach(
        venues[0].id,
        (t) => ({
          subject: t("r9d.overdue.s"),
          body: t("r9d.overdue.b", {
            period: invoice.period,
            amount: money(Number(invoice.amount).toFixed(2)),
            due: invoice.due_on,
            off: offOn,
            names,
            place: `${t("sh.tab.venuesStaff")} → ${t("bill.title")}`,
          }),
        }),
        { dedupeKey: `invoice-overdue:${invoice.id}` }
      );
    }
    await db.prepare("UPDATE venue_invoices SET warned_at = datetime('now') WHERE id = ? AND warned_at IS NULL").run(invoice.id);
  }
}

interface InvoiceRow {
  id: number;
  venue_id: number | null;
  business_id: number | null;
  amount: number | string;
  due_on: string;
  period: string;
}

/**
 * Tell a venue's managers about the platform's invoice to it, in writing, before it can be late: when it is issued (amount, due date,
 * where to pay) and a few days before it falls due (`invoiceReminderDays`), once each. Until now the first word was a warning a week
 * after the due date, a week short of the venue coming off the marketplace. A business's one invoice goes to its managers (found
 * through its first branch, as the overdue warning is). Each email is queued under the invoice's own dedupe key and the invoice
 * stamped after: a stop between the two writes nothing twice on the next run, on any server. Answers how many invoices were told of.
 * Run by the scheduler after the month's invoices are issued; also safe to call at any other time.
 */
export async function notifyInvoiceStages(now = new Date()): Promise<{ issued: number; reminded: number }> {
  if (!isMarketplace()) return { issued: 0, reminded: 0 };
  const db = getDb();
  const result = { issued: 0, reminded: 0 };
  const today = daysAgo(now, 0);

  const tell = async (invoice: InvoiceRow, stage: "issued" | "due-soon"): Promise<boolean> => {
    const venues = (await db
      .prepare("SELECT id, name FROM venues WHERE id = ? OR (business_id = ? AND published_at IS NOT NULL) ORDER BY id")
      .all(invoice.venue_id, invoice.business_id)) as { id: number; name: string }[];
    if (venues.length === 0) return false;
    const names = venues.map((v) => v.name).join(", ");
    const amount = money(Number(invoice.amount).toFixed(2));
    const off = addDays(invoice.due_on, GRACE_DAYS + 1);
    await tellVenueStaffEach(
      venues[0].id,
      (t) => {
        const place = `${t("sh.tab.venuesStaff")} → ${t("bill.title")}`;
        return stage === "issued"
          ? { subject: t("srv.fx6.inv.s", { period: invoice.period, amount }), body: t("srv.fx6.inv.b", { period: invoice.period, amount, due: invoice.due_on, off, names, place }) }
          : { subject: t("srv.fx6.invSoon.s", { period: invoice.period, due: invoice.due_on }), body: t("srv.fx6.invSoon.b", { period: invoice.period, amount, due: invoice.due_on, names, place }) };
      },
      { managersOnly: true, dedupeKey: `invoice-${stage}:${invoice.id}` }
    );
    return true;
  };

  const fresh = (await db
    .prepare("SELECT id, venue_id, business_id, amount, due_on, period FROM venue_invoices WHERE status = 'due' AND issued_notified_at IS NULL ORDER BY id")
    .all()) as InvoiceRow[];
  for (const invoice of fresh) {
    if (await tell(invoice, "issued")) result.issued++;
    await db.prepare("UPDATE venue_invoices SET issued_notified_at = datetime('now') WHERE id = ? AND issued_notified_at IS NULL").run(invoice.id);
  }

  const days = invoiceReminderDays();
  if (days > 0) {
    const soon = (await db
      .prepare(
        `SELECT id, venue_id, business_id, amount, due_on, period FROM venue_invoices
          WHERE status = 'due' AND due_soon_notified_at IS NULL AND due_on >= ? AND due_on <= ? ORDER BY id`
      )
      .all(today, addDays(today, days))) as InvoiceRow[];
    for (const invoice of soon) {
      if (await tell(invoice, "due-soon")) result.reminded++;
      await db.prepare("UPDATE venue_invoices SET due_soon_notified_at = datetime('now') WHERE id = ? AND due_soon_notified_at IS NULL").run(invoice.id);
    }
  }
  return result;
}

// ------------------------------------------------------------ time given by the owner (ADR 0063)

/** The longest the owner may give an overdue invoice at one time. */
export const GRACE_MAX_DAYS = 90;

export type GraceResult =
  | { ok: true; invoices: { id: number; period: string; until: string | null }[] }
  | { ok: false; error: string; code?: string };

const GRACE_REASON_ASKED = "Say why (5 to 300 characters): it is kept in the staff activity log with your name.";

/** Why this date cannot be the end of some time given, or null. */
function graceDateRefusal(until: string, now: Date): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || new Date(`${until}T00:00:00Z`).toISOString().slice(0, 10) !== until)
    return "Give the date it is paid by, as YYYY-MM-DD.";
  const today = daysAgo(now, 0);
  if (until <= today) return "The date must be after today.";
  if (until > addDays(today, GRACE_MAX_DAYS)) return `At most ${GRACE_MAX_DAYS} days at a time.`;
  return null;
}

/**
 * Give an unpaid invoice more time, or take the time given back (`until: null`). The owner's decision, with a reason and their name, kept
 * on the invoice (`billing_grace_*`, migration 0311) and written to the staff activity log by the caller (ADR 0057). The invoice itself is
 * untouched: its due date, amount and status stay as issued, so the books say what happened (it is not marked paid, and nothing is
 * voided); only the automatic hold waits, until the end of that date. A venue held for it comes back at once; the venue's managers
 * are told the date it is held from if still unpaid. Withdrawing the time can hold the venue at once, if the invoice is long overdue.
 */
export async function giveInvoiceGrace(
  invoiceId: number,
  input: { until: string | null; reason: string; by: string },
  now = new Date()
): Promise<GraceResult> {
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 300) return { ok: false, error: GRACE_REASON_ASKED, code: "BILL_REASON_REQUIRED" };
  if (input.until !== null) {
    const refused = graceDateRefusal(input.until, now);
    if (refused) return { ok: false, error: refused };
  }
  const done = (await getDb()
    .prepare(
      `UPDATE venue_invoices
          SET billing_grace_until = ?, billing_grace_reason = ?, billing_grace_by = ?, billing_grace_at = datetime('now')
        WHERE id = ? AND status = 'due' RETURNING id, venue_id, business_id, period, amount, due_on`
    )
    .get(input.until, reason, input.by.slice(0, 100), invoiceId)) as InvoiceRow | undefined;
  if (!done) return { ok: false, error: "That invoice is not waiting to be paid." };
  await applyPaymentHolds(now);
  if (input.until !== null) await tellGrace(done, input.until);
  return { ok: true, invoices: [{ id: done.id, period: done.period, until: input.until }] };
}

/**
 * Give time on every overdue invoice a venue is held for, its own or its business's: the way the owner lifts a hold for payment
 * (`liftVenue`). The same reason and date on each.
 */
export async function giveGraceToOverdueOf(
  venueId: number,
  input: { until: string; reason: string; by: string },
  now = new Date()
): Promise<GraceResult> {
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 300) return { ok: false, error: GRACE_REASON_ASKED, code: "BILL_REASON_REQUIRED" };
  const refused = graceDateRefusal(input.until, now);
  if (refused) return { ok: false, error: refused };
  const owed = (await getDb()
    .prepare(
      `SELECT i.id FROM venue_invoices i
        WHERE i.status = 'due' AND i.due_on < ? AND (i.billing_grace_until IS NULL OR i.billing_grace_until < ?)
          AND (i.venue_id = ? OR i.business_id = (SELECT business_id FROM venues WHERE id = ?))
        ORDER BY i.id`
    )
    .all(daysAgo(now, GRACE_DAYS), daysAgo(now, 0), venueId, venueId)) as { id: number }[];
  const invoices: { id: number; period: string; until: string | null }[] = [];
  for (const { id } of owed) {
    const done = await giveInvoiceGrace(id, input, now);
    if (!done.ok) return done;
    invoices.push(...done.invoices);
  }
  return { ok: true, invoices };
}

/** Tell the managers of the venue (or business) an invoice is to, once per invoice and date, that it was given time and until when. */
async function tellGrace(invoice: InvoiceRow, until: string): Promise<void> {
  const venues = (await getDb()
    .prepare("SELECT id, name FROM venues WHERE id = ? OR (business_id = ? AND published_at IS NOT NULL) ORDER BY id")
    .all(invoice.venue_id, invoice.business_id)) as { id: number; name: string }[];
  if (venues.length === 0) return;
  const names = venues.map((v) => v.name).join(", ");
  await tellVenueStaffEach(
    venues[0].id,
    (t) => ({
      subject: t("fx11.grace.s", { period: invoice.period }),
      body: t("fx11.grace.b", {
        period: invoice.period,
        amount: money(Number(invoice.amount).toFixed(2)),
        until,
        off: addDays(until, 1),
        names,
        place: `${t("sh.tab.venuesStaff")} → ${t("bill.title")}`,
      }),
    }),
    { managersOnly: true, dedupeKey: `invoice-grace:${invoice.id}:${until}` }
  );
}
