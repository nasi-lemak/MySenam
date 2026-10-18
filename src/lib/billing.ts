import { applyPaymentHolds } from "./payment-holds";
import { getDb, withTransaction } from "./db";
import { BillplzAccount, createBill } from "./billplz";
import { baseUrl } from "./outbox";
import { isMarketplace } from "./mode";
import { siteName } from "./site";
import { getVenue } from "./store";
import { defaultIncluded, defaultMessagePrice, monthBefore, monthOf, usageFor, type Usage } from "./whatsapp-usage";

/**
 * What venues pay to be on the marketplace: one invoice a month — for a
 * venue on its own, or for a business, covering all its branches with a line
 * for each.
 *
 * Each venue has a monthly fee — its own, or the marketplace's default — and
 * a date billing starts from, set when it is approved (after any free months).
 * Every full calendar month from then is invoiced once: a venue that joins on
 * the 16th has the rest of that month free, and nothing is ever prorated or
 * back-billed by surprise.
 *
 * Paying online goes to the platform's own Billplz account (BILLPLZ_*), which
 * is a different account from every venue's: this is the platform's income,
 * where a booking payment is the venue's.
 */

export type InvoiceStatus = "due" | "paid" | "void";

export interface Invoice {
  id: number;
  /** The venue it is for; null on a business's invoice. */
  venueId: number | null;
  /** The business it is for; null on a venue's own. */
  businessId: number | null;
  /** Who it is addressed to: the venue's name, or the business's. */
  venueName: string;
  /** On a business's invoice, what each branch adds up to. */
  lines: { venueId: number; venueName: string; amount: number }[];
  /** YYYY-MM */
  period: string;
  amount: number;
  status: InvoiceStatus;
  issuedOn: string;
  dueOn: string;
  paidAt: string | null;
  paidVia: "online" | "manual" | null;
  overdue: boolean;
  /** WhatsApp messages from the month before, for each venue it covers. */
  usage: InvoiceUsage[];
}

export interface InvoiceUsage {
  venueId: number;
  venueName: string;
  /** YYYY-MM the messages were sent in. */
  month: string;
  messages: number;
  included: number;
  unitPrice: number;
  amount: number;
}

interface InvoiceRow {
  id: number;
  venue_id: number | null;
  business_id: number | null;
  venue_name: string;
  period: string;
  amount: number;
  status: InvoiceStatus;
  issued_on: string;
  due_on: string;
  paid_at: string | null;
  paid_via: "online" | "manual" | null;
}

export const PAYMENT_TERMS_DAYS = 14;

function today(now = new Date()): string {
  return new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

function toInvoice(r: InvoiceRow, lines: Invoice["lines"] = [], now = new Date(), usage: InvoiceUsage[] = []): Invoice {
  return {
    id: r.id,
    venueId: r.venue_id,
    businessId: r.business_id,
    venueName: r.venue_name,
    lines,
    period: r.period,
    amount: r.amount,
    status: r.status,
    issuedOn: r.issued_on,
    dueOn: r.due_on,
    paidAt: r.paid_at,
    paidVia: r.paid_via,
    overdue: r.status === "due" && r.due_on < today(now),
    usage,
  };
}

const INVOICE_SELECT = `
  SELECT i.*, COALESCE(b.name, v.name) AS venue_name FROM venue_invoices i
    LEFT JOIN venues v ON v.id = i.venue_id
    LEFT JOIN businesses b ON b.id = i.business_id
`;

/** Rows to invoices, each business invoice with its branch lines. */
async function withLines(rows: InvoiceRow[], now = new Date()): Promise<Invoice[]> {
  const ids = rows.filter((r) => r.business_id !== null).map((r) => r.id);
  const lines = new Map<number, Invoice["lines"]>();
  if (ids.length > 0) {
    const all = (await getDb()
      .prepare(
        `SELECT l.invoice_id, l.venue_id, v.name AS venue_name, l.amount FROM invoice_lines l
           JOIN venues v ON v.id = l.venue_id
          WHERE l.invoice_id IN (${ids.map(() => "?").join(",")}) ORDER BY v.name`
      )
      .all(...ids)) as { invoice_id: number; venue_id: number; venue_name: string; amount: number }[];
    for (const l of all)
      lines.set(l.invoice_id, [
        ...(lines.get(l.invoice_id) ?? []),
        { venueId: l.venue_id, venueName: l.venue_name, amount: l.amount },
      ]);
  }
  const usage = new Map<number, InvoiceUsage[]>();
  if (rows.length > 0) {
    const all = (await getDb()
      .prepare(
        `SELECT u.*, v.name AS venue_name FROM invoice_usage u JOIN venues v ON v.id = u.venue_id
          WHERE u.invoice_id IN (${rows.map(() => "?").join(",")}) ORDER BY v.name`
      )
      .all(...rows.map((r) => r.id))) as {
      invoice_id: number;
      venue_id: number;
      venue_name: string;
      month: string;
      messages: number;
      included: number;
      unit_price: number | string;
      amount: number | string;
    }[];
    for (const u of all)
      usage.set(u.invoice_id, [
        ...(usage.get(u.invoice_id) ?? []),
        {
          venueId: u.venue_id,
          venueName: u.venue_name,
          month: u.month,
          messages: u.messages,
          included: u.included,
          unitPrice: Number(u.unit_price),
          amount: Number(u.amount),
        },
      ]);
  }
  return rows.map((r) => toInvoice(r, lines.get(r.id) ?? [], now, usage.get(r.id) ?? []));
}

/** The marketplace's fee for a venue with none of its own. */
export function defaultFee(): number {
  const fee = Number(process.env.MYSENAM_VENUE_FEE ?? 0);
  return Number.isFinite(fee) && fee > 0 ? fee : 0;
}

/**
 * Free months a venue gets from going live before its first invoice: one
 * unless the install says otherwise. With the rest of the month it goes live
 * in, also free, a venue has four weeks or more of real customers to judge
 * by before it pays anything.
 */
export function freeMonths(): number {
  const n = Number(process.env.MYSENAM_FREE_MONTHS ?? 1);
  return Number.isInteger(n) && n >= 0 && n <= 24 ? n : 1;
}

export interface VenuePlan {
  venueId: number;
  venueName: string;
  /** Its own fee, or null to pay the default. */
  monthlyFee: number | null;
  /** What it actually pays a month. */
  effectiveFee: number;
  /** Null: not billed. */
  billingStartsOn: string | null;
  /** WhatsApp messages its fee includes a month, and each one past that: its own, or null for the defaults. */
  whatsappIncluded: number | null;
  whatsappPrice: number | null;
  /** This month so far. */
  usage: Usage;
}

export async function venuePlans(): Promise<VenuePlan[]> {
  const fallback = defaultFee();
  const usage = await usageFor(monthOf());
  return (
    await getDb()
      .prepare("SELECT id, name, monthly_fee, billing_starts_on, whatsapp_included, whatsapp_price FROM venues ORDER BY name")
      .all() as {
      id: number;
      name: string;
      monthly_fee: number | null;
      billing_starts_on: string | null;
      whatsapp_included: number | null;
      whatsapp_price: number | string | null;
    }[]
  ).map((r) => ({
    venueId: r.id,
    venueName: r.name,
    monthlyFee: r.monthly_fee,
    effectiveFee: r.monthly_fee ?? fallback,
    billingStartsOn: r.billing_starts_on,
    whatsappIncluded: r.whatsapp_included,
    whatsappPrice: r.whatsapp_price === null ? null : Number(r.whatsapp_price),
    usage: usage.get(r.id)!,
  }));
}

/** The marketplace's WhatsApp allowance and rate, for a venue with none of its own. */
export function messageDefaults(): { included: number; unitPrice: number } {
  return { included: defaultIncluded(), unitPrice: defaultMessagePrice() };
}

export async function setVenuePlan(
  venueId: number,
  plan: {
    monthlyFee: number | null;
    billingStartsOn: string | null;
    /** Left out: unchanged. Null: the marketplace's default. */
    whatsappIncluded?: number | null;
    whatsappPrice?: number | null;
  }
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!await getVenue(venueId)) return { ok: false, error: "Venue not found." };
  if (plan.monthlyFee !== null && (!Number.isFinite(plan.monthlyFee) || plan.monthlyFee < 0 || plan.monthlyFee > 100_000))
    return { ok: false, error: "The monthly fee must be RM0–100,000." };
  if (plan.billingStartsOn !== null && !/^\d{4}-\d{2}-\d{2}$/.test(plan.billingStartsOn))
    return { ok: false, error: "Billing starts on a date, YYYY-MM-DD." };
  const included = plan.whatsappIncluded;
  if (included !== undefined && included !== null && (!Number.isInteger(included) || included < 0 || included > 1_000_000))
    return { ok: false, error: "WhatsApp messages included: a whole number, 0 or more." };
  const price = plan.whatsappPrice;
  if (price !== undefined && price !== null && (!Number.isFinite(price) || price < 0 || price > 5))
    return { ok: false, error: "Each extra WhatsApp message: RM0–5." };
  await getDb()
    .prepare("UPDATE venues SET monthly_fee = ?, billing_starts_on = ? WHERE id = ?")
    .run(plan.monthlyFee, plan.billingStartsOn, venueId);
  if (included !== undefined) await getDb().prepare("UPDATE venues SET whatsapp_included = ? WHERE id = ?").run(included, venueId);
  if (price !== undefined) await getDb().prepare("UPDATE venues SET whatsapp_price = ? WHERE id = ?").run(price, venueId);
  return { ok: true };
}

/** When a venue is let in: billing starts after its free months. */
export async function startBilling(venueId: number, now = new Date()): Promise<void> {
  const start = new Date(`${today(now)}T00:00:00Z`);
  start.setUTCMonth(start.getUTCMonth() + freeMonths());
  await getDb()
    .prepare("UPDATE venues SET billing_starts_on = ? WHERE id = ? AND billing_starts_on IS NULL")
    .run(start.toISOString().slice(0, 10), venueId);
}

function addDaysTo(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Issue this month's invoice to every venue that owes one. Safe to call as
 * often as anything likes: a venue's month is invoiced once, whatever.
 */
export async function issueDueInvoices(now = new Date()): Promise<Invoice[]> {
  if (!isMarketplace()) return [];
  const date = today(now);
  const period = date.slice(0, 7);
  const firstOfMonth = `${period}-01`;
  const fallback = defaultFee();
  const db = getDb();
  const issued = new Set<number>();
  const due = addDaysTo(date, PAYMENT_TERMS_DAYS);
  await db.transaction(async () => {
    // Read inside the transaction, so two callers at the start of a month
    // cannot both bill the same branch.
    const owing = (await db
      .prepare(`
        SELECT id, business_id, COALESCE(monthly_fee, ?) AS fee, billing_starts_on FROM venues
         WHERE billing_starts_on IS NOT NULL AND billing_starts_on <= ?
           AND COALESCE(monthly_fee, ?) > 0
           AND id NOT IN (SELECT venue_id FROM venue_invoices WHERE period = ? AND venue_id IS NOT NULL)
           AND id NOT IN (SELECT venue_id FROM invoice_lines WHERE period = ?)
         ORDER BY id
      `)
      .all(fallback, firstOfMonth, fallback, period, period)) as {
      id: number;
      business_id: number | null;
      fee: number | string;
      billing_starts_on: string;
    }[];

    // Last month's WhatsApp messages go on this month's invoice — counted only
    // for a month the venue was billed for, so its free months stay free.
    const lastMonth = monthBefore(period);
    const usage = await usageFor(
      lastMonth,
      owing.filter((v) => v.billing_starts_on <= `${lastMonth}-01`).map((v) => v.id)
    );
    const charged = async (invoiceId: number, venueId: number): Promise<number> => {
      const u = usage.get(venueId);
      if (!u || u.paid + u.free === 0) return 0;
      const info = await db
        .prepare(
          `INSERT INTO invoice_usage (invoice_id, venue_id, month, messages, included, unit_price, amount)
           VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (venue_id, month) DO NOTHING`
        )
        .run(invoiceId, venueId, u.month, u.paid, u.included, u.unitPrice, u.amount);
      if (info.changes === 0 || u.amount === 0) return 0;
      await db.prepare("UPDATE venue_invoices SET amount = amount + ? WHERE id = ?").run(u.amount, invoiceId);
      return u.amount;
    };

    for (const v of owing) {
      if (v.business_id === null) {
        // A venue on its own: its own invoice, as always.
        const info = await db
          .prepare(
            `INSERT INTO venue_invoices (venue_id, period, amount, issued_on, due_on) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (venue_id, period) DO NOTHING`
          )
          .run(v.id, period, v.fee, date, due);
        if (info.changes === 1) {
          issued.add(info.lastInsertRowid as number);
          await charged(info.lastInsertRowid as number, v.id);
        }
        continue;
      }
      // A branch: a line on its business's invoice for the month, made by the
      // first branch to need it. A branch whose billing starts after that
      // invoice was settled gets one of its own instead.
      let invoice = (await db
        .prepare("SELECT id, status FROM venue_invoices WHERE business_id = ? AND period = ?")
        .get(v.business_id, period)) as { id: number; status: InvoiceStatus } | undefined;
      if (!invoice) {
        const made = await db
          .prepare(
            "INSERT INTO venue_invoices (business_id, period, amount, issued_on, due_on) VALUES (?, ?, 0, ?, ?)"
          )
          .run(v.business_id, period, date, due);
        invoice = { id: made.lastInsertRowid as number, status: "due" };
      }
      if (invoice.status !== "due") {
        const info = await db
          .prepare("INSERT INTO venue_invoices (venue_id, period, amount, issued_on, due_on) VALUES (?, ?, ?, ?, ?)")
          .run(v.id, period, v.fee, date, due);
        issued.add(info.lastInsertRowid as number);
        await charged(info.lastInsertRowid as number, v.id);
        continue;
      }
      await db
        .prepare("INSERT INTO invoice_lines (invoice_id, venue_id, period, amount) VALUES (?, ?, ?, ?)")
        .run(invoice.id, v.id, period, v.fee);
      await db.prepare("UPDATE venue_invoices SET amount = amount + ? WHERE id = ?").run(v.fee, invoice.id);
      // The branch's line carries its own messages too, so the lines add up to the total.
      const extra = await charged(invoice.id, v.id);
      if (extra > 0)
        await db.prepare("UPDATE invoice_lines SET amount = amount + ? WHERE invoice_id = ? AND venue_id = ?").run(extra, invoice.id, v.id);
      issued.add(invoice.id);
    }
  })();
  const invoices: Invoice[] = [];
  for (const id of issued) invoices.push((await invoiceById(id, now))!);
  return invoices;
}

export async function invoiceById(id: number, now = new Date()): Promise<Invoice | null> {
  const row = await getDb().prepare(`${INVOICE_SELECT} WHERE i.id = ?`).get(id) as InvoiceRow | undefined;
  return row ? (await withLines([row], now))[0] : null;
}

/** One venue's invoices, or every venue's for the platform owner. Newest first. */
/**
 * Invoices for every venue, or for these venues (a business's branches):
 * their own, and their businesses'.
 */
export async function listInvoices(venueId?: number | number[], limit = 100): Promise<Invoice[]> {
  const ids = venueId === undefined ? undefined : Array.isArray(venueId) ? venueId : [venueId];
  const list = ids?.map(() => "?").join(",") || "NULL";
  const rows = (
    ids === undefined
      ? await getDb().prepare(`${INVOICE_SELECT} ORDER BY i.period DESC, venue_name LIMIT ?`).all(limit)
      : await getDb()
          .prepare(
            `${INVOICE_SELECT}
              WHERE i.venue_id IN (${list})
                 OR i.business_id IN (SELECT business_id FROM venues WHERE id IN (${list}) AND business_id IS NOT NULL)
              ORDER BY i.period DESC, venue_name LIMIT ?`
          )
          .all(...ids, ...ids, limit)
  ) as InvoiceRow[];
  return await withLines(rows);
}

export type InvoiceResult = { ok: true; invoice: Invoice } | { ok: false; error: string };

/** Paid some other way — a bank transfer, a cheque — and recorded by the owner. */
export async function markInvoicePaid(id: number): Promise<InvoiceResult> {
  return settled(await withTransaction(async (): Promise<InvoiceResult> => {
    const done = await getDb()
      .prepare(
        "UPDATE venue_invoices SET status = 'paid', paid_at = datetime('now'), paid_via = 'manual' WHERE id = ? AND status = 'due'"
      )
      .run(id);
    if (done.changes === 0) return { ok: false, error: "That invoice is not waiting to be paid." };
    return { ok: true, invoice: (await invoiceById(id))! };
  }));
}

/** Once an invoice is settled either way, a venue held for it comes back. */
async function settled(result: InvoiceResult): Promise<InvoiceResult> {
  if (result.ok) await applyPaymentHolds();
  return result;
}

export async function voidInvoice(id: number): Promise<InvoiceResult> {
  return settled(await withTransaction(async (): Promise<InvoiceResult> => {
    const done = await getDb()
      .prepare("UPDATE venue_invoices SET status = 'void' WHERE id = ? AND status = 'due'")
      .run(id);
    if (done.changes === 0) return { ok: false, error: "Only an unpaid invoice can be voided." };
    return { ok: true, invoice: (await invoiceById(id))! };
  }));
}

// ------------------------------------------------------------ paying online

/** The platform's own Billplz account, where venues' fees go. */
export function platformAccount(): BillplzAccount | null {
  const apiKey = process.env.BILLPLZ_API_KEY;
  const collectionId = process.env.BILLPLZ_COLLECTION_ID;
  const xSignatureKey = process.env.BILLPLZ_X_SIGNATURE_KEY;
  if (!apiKey || !collectionId || !xSignatureKey) return null;
  return { apiKey, collectionId, xSignatureKey, sandbox: process.env.BILLPLZ_SANDBOX === "on" };
}

export type PayInvoiceResult = { ok: true; url: string } | { ok: false; error: string; status: number };

export async function payInvoiceOnline(invoiceId: number, payer: { name: string; email: string }): Promise<PayInvoiceResult> {
  const invoice = await invoiceById(invoiceId);
  if (!invoice) return { ok: false, error: "Invoice not found.", status: 404 };
  if (invoice.status !== "due") return { ok: false, error: "That invoice is not waiting to be paid.", status: 409 };
  const account = platformAccount();
  if (!account) return { ok: false, error: "Paying invoices online is not set up. Pay by bank transfer.", status: 409 };

  const db = getDb();
  const existing = await db
    .prepare(
      "SELECT url FROM online_payments WHERE purpose = 'invoice' AND invoice_id = ? AND status = 'pending' AND created_at > datetime('now', '-1 day') ORDER BY id DESC LIMIT 1"
    )
    .get(invoiceId) as { url: string } | undefined;
  if (existing) return { ok: true, url: existing.url };

  let bill;
  try {
    bill = await createBill(account, {
      amount: invoice.amount,
      name: payer.name,
      email: payer.email,
      description:
        invoice.lines.length > 0
          ? `${siteName()}: ${invoice.venueName}, ${invoice.period} (${invoice.lines.length} branches)`
          : `${siteName()}: ${invoice.venueName}, ${invoice.period}`,
      callbackUrl: `${baseUrl()}/api/payments/billplz/callback`,
      redirectUrl: `${baseUrl()}/payments/return`,
      reference: { label: "Invoice", value: `${invoice.venueName} ${invoice.period}` },
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "The payment page could not be opened.", status: 502 };
  }
  await db.prepare(
    `INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, payer_name, purpose, invoice_id)
     VALUES ('billplz', ?, ?, ?, ?, ?, 'invoice', ?)`
  ).run(bill.id, bill.url, invoice.venueId, invoice.amount, payer.name, invoiceId);
  return { ok: true, url: bill.url };
}

/** The gateway says an invoice's bill was paid. Once, however often it says so. */
export async function settleInvoice(invoiceId: number): Promise<void> {
  await getDb()
    .prepare(
      "UPDATE venue_invoices SET status = 'paid', paid_at = datetime('now'), paid_via = 'online' WHERE id = ? AND status = 'due'"
    )
    .run(invoiceId);
  await applyPaymentHolds();
}
