import crypto from "crypto";
import { getDb, withTransaction } from "./db";
import { errorText, translator, type ErrorCode } from "./i18n";
import { enqueue } from "./outbox";
import { phoneKey } from "./phone";
import { isAmount, roundMoney } from "./region";
import { siteName } from "./site";
import { venueBaseUrl } from "./storefront";
import { venueHours } from "./store";
import { taxIncluded } from "./tax";
import { addDays, todayISO } from "./time";
import { COUNTER_METHODS, type CounterMethod, type Refusal } from "./types";

/**
 * Company and school accounts: an organisation that books through the month
 * and pays once, on an invoice, rather than at the counter each time.
 *
 * A school's PE teacher, a firm's sports club, a corporate league: the people
 * who book are not the people who pay. The venue opens an account with where
 * the invoices go and how long the organisation has to pay, and says whose
 * numbers may charge to it. One of those people, signed in with that number
 * proved (users.verified_phone), can choose the account when booking; staff can
 * put any booking on it at the desk. The booking stands unpaid, is not held for
 * payment online, and counts toward the account's limit, if it has one.
 *
 * On the first of each month (or whenever a manager asks), what was played on
 * the account and not yet invoiced is put on one invoice, which is emailed to
 * the account with a link to print it. Marked paid, each booking on it is paid
 * by the same means. Withdrawn, its bookings go back to be invoiced again.
 */

export interface AccountBooker {
  name: string;
  phone: string;
}

export interface Account {
  id: number;
  venueId: number;
  name: string;
  contact: string | null;
  email: string;
  address: string | null;
  taxNo: string | null;
  termsDays: number;
  creditLimit: number | null;
  bookers: AccountBooker[];
  /** Played or booked on it, not yet invoiced. */
  uninvoiced: number;
  /** On invoices not yet paid. */
  owing: number;
}

export interface InvoiceLine {
  code: string;
  date: string;
  startHour: number;
  endHour: number;
  courtName: string;
  bookedBy: string;
  amount: number;
}

export interface AccountInvoice {
  id: number;
  number: string;
  accountId: number;
  accountName: string;
  venueId: number;
  period: string;
  issuedOn: string;
  dueOn: string;
  total: number;
  taxAmount: number;
  token: string;
  paidOn: string | null;
  paidVia: CounterMethod | null;
}

export const MAX_TERMS_DAYS = 90;
const MAX_CREDIT_LIMIT = 1_000_000;

const ENGLISH = translator("en");
function refuse(code: ErrorCode, vars: Record<string, string | number> = {}): Refusal {
  return { ok: false, error: errorText(ENGLISH, code, vars), code, vars };
}

/** What a booking on an account still owes: its price, less anything paid towards it already. */
const OWED = "(b.total_price - b.shares_paid)";

interface AccountRow {
  id: number;
  venue_id: number;
  name: string;
  contact: string | null;
  email: string;
  address: string | null;
  tax_no: string | null;
  terms_days: number;
  credit_limit: number | string | null;
}

async function withTotals(rows: AccountRow[]): Promise<Account[]> {
  if (rows.length === 0) return [];
  const db = getDb();
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => "?").join(",");
  const bookers = (await db
    .prepare(`SELECT account_id, name, phone FROM account_bookers WHERE account_id IN (${marks}) ORDER BY name`)
    .all(...ids)) as { account_id: number; name: string; phone: string }[];
  const sums = (await db
    .prepare(
      `SELECT b.account_id,
              COALESCE(SUM(CASE WHEN b.account_invoice_id IS NULL THEN ${OWED} END), 0)::float AS uninvoiced,
              COALESCE(SUM(CASE WHEN b.account_invoice_id IS NOT NULL THEN ${OWED} END), 0)::float AS owing
         FROM bookings b
        WHERE b.account_id IN (${marks}) AND b.status = 'confirmed' AND b.payment_status = 'unpaid'
        GROUP BY b.account_id`
    )
    .all(...ids)) as { account_id: number; uninvoiced: number; owing: number }[];
  return rows.map((r) => {
    const s = sums.find((x) => x.account_id === r.id);
    return {
      id: r.id,
      venueId: r.venue_id,
      name: r.name,
      contact: r.contact,
      email: r.email,
      address: r.address,
      taxNo: r.tax_no,
      termsDays: Number(r.terms_days),
      creditLimit: r.credit_limit === null ? null : Number(r.credit_limit),
      bookers: bookers.filter((b) => b.account_id === r.id).map((b) => ({ name: b.name, phone: b.phone })),
      uninvoiced: roundMoney(Number(s?.uninvoiced ?? 0)),
      owing: roundMoney(Number(s?.owing ?? 0)),
    };
  });
}

/** A venue's open accounts, with what each owes. */
export async function listAccounts(venueId: number): Promise<Account[]> {
  const rows = (await getDb()
    .prepare("SELECT * FROM venue_accounts WHERE venue_id = ? AND closed_at IS NULL ORDER BY name")
    .all(venueId)) as AccountRow[];
  return withTotals(rows);
}

/** An open account; or, with `closed`, one closed since (what is on it is still invoiced). */
export async function accountById(id: number, closed = false): Promise<Account | null> {
  const row = (await getDb()
    .prepare(`SELECT * FROM venue_accounts WHERE id = ?${closed ? "" : " AND closed_at IS NULL"}`)
    .get(id)) as AccountRow | undefined;
  return row ? (await withTotals([row]))[0] : null;
}

const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : null);

/** Open one, or change one: `id` to change. */
export async function saveAccount(
  venueId: number,
  input: Record<string, unknown>
): Promise<{ ok: true; account: Account } | { ok: false; error: string }> {
  const name = text(input.name, 120);
  if (!name || name.length < 2) return { ok: false, error: "Give the account a name: the company or school." };
  const email = text(input.email, 200);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "Give an email address the invoices go to." };
  const termsDays = input.termsDays === undefined || input.termsDays === null ? 30 : Number(input.termsDays);
  if (!Number.isInteger(termsDays) || termsDays < 0 || termsDays > MAX_TERMS_DAYS)
    return { ok: false, error: `Days to pay must be 0–${MAX_TERMS_DAYS}.` };
  const limit = input.creditLimit === undefined || input.creditLimit === null || input.creditLimit === "" ? null : input.creditLimit;
  if (limit !== null && !isAmount(limit, 1, MAX_CREDIT_LIMIT)) return { ok: false, error: "A limit must be an amount, or blank for none." };
  const values = [name, text(input.contact, 120), email, text(input.address, 400), text(input.taxNo, 40), termsDays, limit];
  const db = getDb();
  let id: number;
  if (input.id !== undefined) {
    id = Number(input.id);
    const done = await db
      .prepare(
        `UPDATE venue_accounts SET name = ?, contact = ?, email = ?, address = ?, tax_no = ?, terms_days = ?, credit_limit = ?
          WHERE id = ? AND venue_id = ? AND closed_at IS NULL`
      )
      .run(...values, id, venueId);
    if (done.changes === 0) return { ok: false, error: "That account is not open here." };
  } else {
    const row = (await db
      .prepare(
        `INSERT INTO venue_accounts (venue_id, name, contact, email, address, tax_no, terms_days, credit_limit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .get(venueId, ...values)) as { id: number };
    id = row.id;
  }
  return { ok: true, account: (await accountById(id))! };
}

/** No more bookings on it. What is on it already is still invoiced and paid. */
export async function closeAccount(venueId: number, id: number): Promise<boolean> {
  const done = await getDb()
    .prepare("UPDATE venue_accounts SET closed_at = datetime('now') WHERE id = ? AND venue_id = ? AND closed_at IS NULL")
    .run(id, venueId);
  if (done.changes === 0) return false;
  await getDb().prepare("DELETE FROM account_bookers WHERE account_id = ?").run(id);
  return true;
}

async function ownAccount(venueId: number, accountId: number): Promise<boolean> {
  return !!(await getDb().prepare("SELECT 1 FROM venue_accounts WHERE id = ? AND venue_id = ? AND closed_at IS NULL").get(accountId, venueId));
}

/** Somebody who may charge their own bookings to it. */
export async function addBooker(
  venueId: number,
  accountId: number,
  input: { name?: unknown; phone?: unknown }
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await ownAccount(venueId, accountId))) return { ok: false, error: "That account is not open here." };
  const name = text(input.name, 80);
  if (!name || name.length < 2) return { ok: false, error: "Give their name." };
  const phone = text(input.phone, 30);
  if (!phone || !/^\+?[0-9 -]{7,20}$/.test(phone)) return { ok: false, error: "Give their phone number." };
  await getDb()
    .prepare(
      `INSERT INTO account_bookers (account_id, name, phone) VALUES (?, ?, ?)
       ON CONFLICT (account_id, phone_key) DO UPDATE SET name = excluded.name, phone = excluded.phone`
    )
    .run(accountId, name, phone);
  return { ok: true };
}

export async function removeBooker(venueId: number, accountId: number, phone: string): Promise<boolean> {
  if (!(await ownAccount(venueId, accountId))) return false;
  const done = await getDb().prepare("DELETE FROM account_bookers WHERE account_id = ? AND phone_key = ?").run(accountId, phoneKey(phone));
  return done.changes > 0;
}

/**
 * The accounts here a signed-in customer may charge to: those that list the
 * number they have proved. A number typed into a form proves nothing.
 */
export async function accountsForUser(venueId: number, userId: number): Promise<{ id: number; name: string }[]> {
  return (await getDb()
    .prepare(
      `SELECT DISTINCT a.id, a.name FROM venue_accounts a
         JOIN account_bookers k ON k.account_id = a.id
         JOIN users u ON u.id = ? AND u.verified_phone IS NOT NULL AND phone_key(u.verified_phone) = k.phone_key
        WHERE a.venue_id = ? AND a.closed_at IS NULL ORDER BY a.name`
    )
    .all(userId, venueId)) as { id: number; name: string }[];
}

/**
 * Charge these bookings to an account: unpaid, not held for payment online,
 * invoiced at the month's end. Refused, with nothing changed, if any is not
 * this venue's, is paid or cancelled, or if they would take it past its limit.
 */
export async function chargeToAccount(venueId: number, accountId: number, bookingIds: number[]): Promise<{ ok: true } | Refusal> {
  return withTransaction(async () => {
    const db = getDb();
    const account = await accountById(accountId);
    if (!account || account.venueId !== venueId) return refuse("ACCOUNT_NOT_HERE");
    if (bookingIds.length === 0) return { ok: true as const };
    const marks = bookingIds.map(() => "?").join(",");
    const rows = (await db
      .prepare(
        `SELECT b.id, ${OWED}::float AS owed, b.status, b.payment_status, b.account_invoice_id, c.venue_id
           FROM bookings b JOIN courts c ON c.id = b.court_id WHERE b.id IN (${marks})`
      )
      .all(...bookingIds)) as { id: number; owed: number; status: string; payment_status: string; account_invoice_id: number | null; venue_id: number }[];
    if (rows.length !== new Set(bookingIds).size || rows.some((r) => r.venue_id !== venueId || r.status !== "confirmed" || r.payment_status !== "unpaid" || r.account_invoice_id !== null))
      return { ok: false as const, error: "Only unpaid bookings here, not yet invoiced, can go on an account." };
    const adding = rows.reduce((sum, r) => sum + Number(r.owed), 0);
    if (account.creditLimit !== null && account.uninvoiced + account.owing + adding > account.creditLimit + 1e-9)
      return refuse("ACCOUNT_OVER_LIMIT", { name: account.name });
    await db.prepare(`UPDATE bookings SET account_id = ?, hold_until = NULL WHERE id IN (${marks})`).run(accountId, ...bookingIds);
    return { ok: true as const };
  });
}

/** Off its account, back to being paid at the counter; not once it is invoiced. */
export async function takeOffAccount(venueId: number, bookingId: number): Promise<boolean> {
  const done = await getDb()
    .prepare(
      `UPDATE bookings SET account_id = NULL WHERE id = ? AND account_invoice_id IS NULL AND account_id IS NOT NULL
          AND court_id IN (SELECT id FROM courts WHERE venue_id = ?)`
    )
    .run(bookingId, venueId);
  return done.changes > 0;
}

// ------------------------------------------------------------ invoices

interface InvoiceRow {
  id: number;
  account_id: number;
  account_name: string;
  venue_id: number;
  period: string;
  issued_on: string;
  due_on: string;
  total: number | string;
  tax_amount: number | string;
  token: string;
  paid_on: string | null;
  paid_via: CounterMethod | null;
}

const INVOICE_SELECT = `SELECT i.*, a.name AS account_name FROM account_invoices i JOIN venue_accounts a ON a.id = i.account_id`;

const toInvoice = (r: InvoiceRow): AccountInvoice => ({
  id: r.id,
  number: `${r.period}-A${String(r.id).padStart(5, "0")}`,
  accountId: r.account_id,
  accountName: r.account_name,
  venueId: r.venue_id,
  period: r.period,
  issuedOn: r.issued_on,
  dueOn: r.due_on,
  total: Number(r.total),
  taxAmount: Number(r.tax_amount),
  token: r.token,
  paidOn: r.paid_on,
  paidVia: r.paid_via,
});

/** The last day of a month, YYYY-MM. */
function monthEnd(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/**
 * Put on one invoice what was played on the account up to the end of
 * `period` (and not after today), not yet invoiced or paid. Null when there
 * is nothing to invoice.
 */
export async function issueInvoice(accountId: number, period: string, opts: { email?: boolean } = {}): Promise<AccountInvoice | null> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return null;
  const account = await accountById(accountId, true);
  if (!account) return null;
  const zone = (await venueHours(account.venueId)).zone;
  const today = todayISO(zone);
  const until = monthEnd(period) < today ? monthEnd(period) : today;
  const invoice = await withTransaction(async () => {
    const db = getDb();
    const rows = (await db
      .prepare(
        `SELECT b.id, ${OWED}::float AS owed, b.tax_rate FROM bookings b
          WHERE b.account_id = ? AND b.account_invoice_id IS NULL AND b.status = 'confirmed' AND b.payment_status = 'unpaid'
            AND b.date <= ? AND ${OWED} > 0
          FOR UPDATE`
      )
      .all(accountId, until)) as { id: number; owed: number; tax_rate: number | string | null }[];
    if (rows.length === 0) return null;
    const total = roundMoney(rows.reduce((sum, r) => sum + Number(r.owed), 0));
    const tax = roundMoney(rows.reduce((sum, r) => sum + taxIncluded(Number(r.owed), r.tax_rate === null ? null : Number(r.tax_rate)), 0));
    const made = (await db
      .prepare(
        `INSERT INTO account_invoices (account_id, venue_id, period, issued_on, due_on, total, tax_amount, token)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .get(accountId, account.venueId, period, today, addDays(today, account.termsDays), total, tax, crypto.randomBytes(24).toString("base64url"))) as {
      id: number;
    };
    await db.prepare(`UPDATE bookings SET account_invoice_id = ? WHERE id IN (${rows.map(() => "?").join(",")})`).run(made.id, ...rows.map((r) => r.id));
    return (await invoiceById(made.id))!;
  });
  if (invoice && opts.email !== false) await emailInvoice(invoice, account.email);
  return invoice;
}

async function emailInvoice(invoice: AccountInvoice, email: string): Promise<void> {
  const venue = (await getDb().prepare("SELECT name FROM venues WHERE id = ?").get(invoice.venueId)) as { name: string };
  await enqueue({
    venueId: invoice.venueId,
    kind: "account_invoice",
    channel: "email",
    recipient: email,
    locale: "en",
    subject: "msg.accountInvoiceSubject",
    body: "msg.accountInvoice",
    dedupeKey: `account-invoice:${invoice.id}`,
    vars: {
      account: invoice.accountName,
      venue: venue.name,
      number: invoice.number,
      total: invoice.total,
      due: invoice.dueOn,
      link: `${await venueBaseUrl(invoice.venueId)}/account-invoice/${invoice.token}`,
      site: siteName(),
    },
  });
}

export async function invoiceById(id: number): Promise<AccountInvoice | null> {
  const row = (await getDb().prepare(`${INVOICE_SELECT} WHERE i.id = ?`).get(id)) as InvoiceRow | undefined;
  return row ? toInvoice(row) : null;
}

export async function invoiceByToken(token: string): Promise<AccountInvoice | null> {
  if (!token || token.length < 20) return null;
  const row = (await getDb().prepare(`${INVOICE_SELECT} WHERE i.token = ?`).get(token)) as InvoiceRow | undefined;
  return row ? toInvoice(row) : null;
}

/** A venue's invoices to its accounts, newest first; or one account's. */
export async function listInvoices(venueId: number, accountId?: number): Promise<AccountInvoice[]> {
  const rows = (await getDb()
    .prepare(`${INVOICE_SELECT} WHERE i.venue_id = ?${accountId ? " AND i.account_id = ?" : ""} ORDER BY i.id DESC LIMIT 100`)
    .all(...(accountId ? [venueId, accountId] : [venueId]))) as InvoiceRow[];
  return rows.map(toInvoice);
}

/** What is on it, booking by booking. */
export async function invoiceLines(invoiceId: number): Promise<InvoiceLine[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT b.code, b.date, b.start_hour, b.end_hour, c.name AS court_name, b.name, ${OWED}::float AS owed
         FROM bookings b JOIN courts c ON c.id = b.court_id
        WHERE b.account_invoice_id = ? ORDER BY b.date, b.start_hour, b.id`
    )
    .all(invoiceId)) as { code: string; date: string; start_hour: number; end_hour: number; court_name: string; name: string; owed: number }[];
  return rows.map((r) => ({
    code: r.code,
    date: r.date,
    startHour: Number(r.start_hour),
    endHour: Number(r.end_hour),
    courtName: r.court_name,
    bookedBy: r.name,
    amount: roundMoney(Number(r.owed)),
  }));
}

/** Paid: and with it, each booking on it, by the same means. */
export async function markInvoicePaid(venueId: number, invoiceId: number, via: unknown): Promise<{ ok: true; invoice: AccountInvoice } | { ok: false; error: string }> {
  if (!COUNTER_METHODS.includes(via as CounterMethod)) return { ok: false, error: "Say how it was paid." };
  return withTransaction(async () => {
    const db = getDb();
    const done = await db
      .prepare("UPDATE account_invoices SET paid_on = ?, paid_via = ? WHERE id = ? AND venue_id = ? AND paid_on IS NULL")
      .run(todayISO((await venueHours(venueId)).zone), via, invoiceId, venueId);
    if (done.changes === 0) return { ok: false as const, error: "That invoice is not here, or is paid already." };
    await db
      .prepare(
        `UPDATE bookings SET payment_status = 'paid', paid_at = ?, paid_via = ?
          WHERE account_invoice_id = ? AND status = 'confirmed' AND payment_status = 'unpaid'`
      )
      .run(new Date().toISOString(), via, invoiceId);
    return { ok: true as const, invoice: (await invoiceById(invoiceId))! };
  });
}

/** Withdrawn, as if never issued: its bookings wait to be invoiced again. Not once paid. */
export async function withdrawInvoice(venueId: number, invoiceId: number): Promise<boolean> {
  const done = await getDb().prepare("DELETE FROM account_invoices WHERE id = ? AND venue_id = ? AND paid_on IS NULL").run(invoiceId, venueId);
  return done.changes > 0;
}

/**
 * Early each month, last month's invoice for every account that played on
 * it, once: an account invoiced for that month already (by a manager, say)
 * has the rest carried into the next.
 */
export async function issueDueAccountInvoices(): Promise<number> {
  const db = getDb();
  // Only accounts with something from before this month to invoice; a day's grace either side of the zones.
  const accounts = (await db
    .prepare(
      `SELECT DISTINCT a.id, a.venue_id FROM venue_accounts a JOIN bookings b ON b.account_id = a.id
        WHERE b.account_invoice_id IS NULL AND b.status = 'confirmed' AND b.payment_status = 'unpaid' AND b.date < ?`
    )
    .all(`${addDays(todayISO(), 1).slice(0, 7)}-01`)) as { id: number; venue_id: number }[];
  let issued = 0;
  for (const a of accounts) {
    const today = todayISO((await venueHours(a.venue_id)).zone);
    const last = addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
    const already = await db.prepare("SELECT 1 FROM account_invoices WHERE account_id = ? AND period = ?").get(a.id, last);
    if (already) continue;
    if (await issueInvoice(a.id, last)) issued++;
  }
  return issued;
}
