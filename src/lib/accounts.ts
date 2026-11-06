import crypto from "crypto";
import { hoursOf } from "./interval";
import { getDb, withTransaction } from "./db";
import { errorText, isLocale, offeredLocales, translator, type ErrorCode, type Locale } from "./i18n";
import { enqueue } from "./outbox";
import { phoneKey } from "./phone";
import { isAmount, money, roundMoney } from "./region";
import { siteName } from "./site";
import { venueBaseUrl } from "./storefront";
import { venueHours } from "./store";
import { taxIncluded } from "./tax";
import { addDays, todayISO } from "./time";
import { COUNTER_METHODS, type CounterMethod, type Refusal } from "./types";
import { linkIn } from "./link-locale";
import { pageSql, paged, textMatch, type ListQuery, type Page } from "./list-search";
import { actingStaff } from "./acting-staff";

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
  /** The language its invoices are written in: one the install offers, its first unless chosen. */
  locale: Locale;
  bookers: AccountBooker[];
  /** Played or booked on it, not yet invoiced. */
  uninvoiced: number;
  /** On invoices not yet paid, as each was issued, less the credit notes taken off them: what the invoices say is to pay. */
  owing: number;
  /** Credit notes on the account waiting to come off its next invoice (places taken off, or bookings cancelled, after their invoice was issued), not paid back by hand. */
  credit: number;
  /** Closed to new bookings: listed only while credit waits on it, to be paid back by hand. */
  closed: boolean;
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
  /** Credit notes on the account taken off this invoice (`account_credits.applied_invoice_id`). */
  credited: number;
  /** What the account pays on it: the total less the credit notes taken off. */
  due: number;
  /** Received on it so far, part payments included (`account_invoice_payments`); all of `due` once paid. */
  received: number;
  /** Still to pay: `due` less what was received; 0 once paid. */
  balance: number;
  token: string;
  paidOn: string | null;
  paidVia: CounterMethod | null;
}

/** A credit note on the account taken off an invoice, as the invoice lists it. */
export interface InvoiceCredit {
  number: string;
  code: string | null;
  amount: number;
}

export const MAX_TERMS_DAYS = 90;
const MAX_CREDIT_LIMIT = 1_000_000;

const ENGLISH = translator("en");
function refuse(code: ErrorCode, vars: Record<string, string | number> = {}): Refusal {
  return { ok: false, error: errorText(ENGLISH, code, vars), code, vars };
}

/** What a booking on an account still owes: its price, less anything paid towards it already. */
const OWED = "(b.total_price - b.shares_paid)";

/**
 * What the account was charged for a booking: as its invoice was issued (`bookings.invoiced_amount`), never its live
 * price, which a move or a later change may have left behind. Before an invoice, what it owes now.
 */
const CHARGED = `COALESCE(b.invoiced_amount, ${OWED})`;

/** Credit notes are taken off invoices part by part (`account_credit_allocations`): what of credit `c` is taken, and what still waits. */
const ALLOCATED = (c: string) => `COALESCE((SELECT SUM(al.amount) FROM account_credit_allocations al WHERE al.credit_id = ${c}.id), 0)`;
const WAITING = (c: string) => `GREATEST(0, ${c}.amount - ${ALLOCATED(c)})`;
/** Credit notes taken off invoice `i`, and the amounts received on it. */
const CREDITED_ON = (i: string) => `COALESCE((SELECT SUM(al.amount) FROM account_credit_allocations al WHERE al.invoice_id = ${i}.id), 0)`;
const RECEIVED_ON = (i: string) => `COALESCE((SELECT SUM(p.amount) FROM account_invoice_payments p WHERE p.invoice_id = ${i}.id), 0)`;
/** What is still to pay on an unpaid invoice `i`. */
const BALANCE_OF = (i: string) => `GREATEST(0, ${i}.total - ${CREDITED_ON(i)} - ${RECEIVED_ON(i)})`;

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
  locale: string | null;
  closed_at?: unknown;
}

/** An account's language, if the install still offers it; else the install's first. */
function invoiceLocale(stored: string | null): Locale {
  const offered = offeredLocales();
  return isLocale(stored) && offered.includes(stored) ? stored : offered[0];
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
      `SELECT b.account_id, COALESCE(SUM(${OWED}), 0)::float AS uninvoiced
         FROM bookings b
        WHERE b.account_id IN (${marks}) AND b.status = 'confirmed' AND b.payment_status = 'unpaid' AND b.account_invoice_id IS NULL
        GROUP BY b.account_id`
    )
    .all(...ids)) as { account_id: number; uninvoiced: number }[];
  // Owing: what its unpaid invoices say is to pay, each its total as issued less the credit notes taken off it. A
  // booking on one cancelled since stays on it as issued; its credit note waits on the account (`credit`).
  const invoiced = (await db
    .prepare(
      `SELECT i.account_id,
              COALESCE(SUM(${BALANCE_OF("i")}), 0)::float AS owing
         FROM account_invoices i
        WHERE i.account_id IN (${marks}) AND i.paid_on IS NULL GROUP BY i.account_id`
    )
    .all(...ids)) as { account_id: number; owing: number }[];
  // Credit notes waiting for the next invoice.
  const credits = (await db
    .prepare(
      `SELECT c.account_id,
              COALESCE(SUM(CASE WHEN c.settled_at IS NULL THEN ${WAITING("c")} END), 0)::float AS waiting
         FROM account_credits c
        WHERE c.account_id IN (${marks}) GROUP BY c.account_id`
    )
    .all(...ids)) as { account_id: number; waiting: number }[];
  return rows.map((r) => {
    const s = sums.find((x) => x.account_id === r.id);
    const o = invoiced.find((x) => x.account_id === r.id);
    const c = credits.find((x) => x.account_id === r.id);
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
      locale: invoiceLocale(r.locale),
      bookers: bookers.filter((b) => b.account_id === r.id).map((b) => ({ name: b.name, phone: b.phone })),
      uninvoiced: roundMoney(Number(s?.uninvoiced ?? 0)),
      owing: roundMoney(Number(o?.owing ?? 0)),
      credit: roundMoney(Number(c?.waiting ?? 0)),
      closed: r.closed_at !== null && r.closed_at !== undefined,
    };
  });
}

/** A venue's open accounts, with what each owes; and closed ones still holding credit to be paid back by hand. */
export async function listAccounts(venueId: number): Promise<Account[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT * FROM venue_accounts a WHERE a.venue_id = ?
          AND (a.closed_at IS NULL OR EXISTS (SELECT 1 FROM account_credits c WHERE c.account_id = a.id AND c.settled_at IS NULL AND ${WAITING("c")} > 0.004))
        ORDER BY a.closed_at IS NOT NULL, a.name`
    )
    .all(venueId)) as AccountRow[];
  return withTotals(rows);
}

/**
 * The credit waiting on an account paid back to it by hand (a bank
 * transfer): every credit note with something still waiting, whatever part
 * of it has come off invoices already, is marked paid back for what waited,
 * with who did it and what they wrote down, so it never comes off an
 * invoice afterwards. The credits are locked first, as an invoice being
 * issued locks them, so it either takes a credit or leaves it to this, never
 * both. Returns what was paid back; 0 when nothing waited.
 */
export async function settleAccountCredit(
  venueId: number,
  accountId: number,
  by: { adminId: number; name: string },
  note: string | null
): Promise<{ ok: true; amount: number; account: Account } | { ok: false; error: string }> {
  const db = getDb();
  const account = (await db.prepare("SELECT * FROM venue_accounts WHERE id = ? AND venue_id = ?").get(accountId, venueId)) as AccountRow | undefined;
  if (!account) return { ok: false, error: "That account is not here." };
  const written = note?.trim().slice(0, 200) || null;
  const paidBack = await withTransaction(async () => {
    const locked = (await db
      .prepare("SELECT id FROM account_credits WHERE account_id = ? AND venue_id = ? AND settled_at IS NULL ORDER BY id FOR UPDATE")
      .all(accountId, venueId)) as { id: number }[];
    if (locked.length === 0) return 0;
    // What waits is read after the locks are held (a statement of its own): an allocation made a moment ago counts.
    const waiting = (await db
      .prepare(
        `SELECT c.id, ${WAITING("c")}::float AS remaining FROM account_credits c
          WHERE c.id IN (${locked.map(() => "?").join(",")}) AND c.settled_at IS NULL`
      )
      .all(...locked.map((l) => l.id))) as { id: number; remaining: number }[];
    let total = 0;
    for (const c of waiting) {
      const left = roundMoney(Number(c.remaining));
      if (left <= 0.004) continue;
      await db
        .prepare("UPDATE account_credits SET settled_at = now(), settled_amount = ?, settled_by_admin_id = ?, settled_by_name = ?, settled_note = ? WHERE id = ?")
        .run(left, by.adminId, by.name, written, c.id);
      total = roundMoney(total + left);
    }
    return total;
  });
  if (paidBack <= 0) return { ok: false, error: "No credit waits on that account." };
  const [view] = await withTotals([account]);
  return { ok: true, amount: paidBack, account: view };
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
  const locale = input.locale === undefined || input.locale === null || input.locale === "" ? null : input.locale;
  if (locale !== null && !(typeof locale === "string" && isLocale(locale) && offeredLocales().includes(locale)))
    return { ok: false, error: "Invoices can be written in one of this site's languages only." };
  const values = [name, text(input.contact, 120), email, text(input.address, 400), text(input.taxNo, 40), termsDays, limit, locale];
  const db = getDb();
  let id: number;
  if (input.id !== undefined) {
    id = Number(input.id);
    const done = await db
      .prepare(
        `UPDATE venue_accounts SET name = ?, contact = ?, email = ?, address = ?, tax_no = ?, terms_days = ?, credit_limit = ?, locale = ?
          WHERE id = ? AND venue_id = ? AND closed_at IS NULL`
      )
      .run(...values, id, venueId);
    if (done.changes === 0) return { ok: false, error: "That account is not open here." };
  } else {
    const row = (await db
      .prepare(
        `INSERT INTO venue_accounts (venue_id, name, contact, email, address, tax_no, terms_days, credit_limit, locale)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
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
 * this venue's, is paid or cancelled, if they would take it past its limit, or
 * if the venue stops new bookings on an account with an invoice so many days
 * overdue (`venues.company_overdue_block_days`, off unless set) and one is: the
 * refusal names what is overdue. Staff may go past that with a reason, which the
 * caller records (`overridden` says what was past).
 */
export async function chargeToAccount(
  venueId: number,
  accountId: number,
  bookingIds: number[],
  opts: { override?: { reason: string } } = {}
): Promise<{ ok: true; overridden?: { amount: number; days: number; reason: string } } | Refusal> {
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
    // An account with an invoice long overdue takes no more bookings, where the venue has said how long is too long.
    let overridden: { amount: number; days: number; reason: string } | undefined;
    const blockDays = await overdueBlockDays(venueId);
    if (blockDays !== null) {
      const late = (await overdueInvoices({ accountId })).filter((i) => i.daysOverdue >= blockDays);
      if (late.length > 0) {
        const amount = roundMoney(late.reduce((sum, i) => sum + i.balance, 0));
        const days = Math.max(...late.map((i) => i.daysOverdue));
        const reason = opts.override?.reason?.trim().slice(0, 300) ?? "";
        if (reason.length < 3) return refuse("ACCOUNT_OVERDUE", { name: account.name, amount: money(amount), days });
        overridden = { amount, days, reason };
      }
    }
    const adding = rows.reduce((sum, r) => sum + Number(r.owed), 0);
    if (account.creditLimit !== null && account.uninvoiced + account.owing + adding > account.creditLimit + 1e-9)
      return refuse("ACCOUNT_OVER_LIMIT", { name: account.name });
    await db.prepare(`UPDATE bookings SET account_id = ?, hold_until = NULL WHERE id IN (${marks})`).run(accountId, ...bookingIds);
    return { ok: true as const, ...(overridden ? { overridden } : {}) };
  });
}

// ------------------------------------------------------------ overdue accounts

/** The venue's setting: days past an invoice's due day after which new bookings on that account are refused; null for never (the default). */
export async function overdueBlockDays(venueId: number): Promise<number | null> {
  const row = (await getDb().prepare("SELECT company_overdue_block_days AS days FROM venues WHERE id = ?").get(venueId)) as { days: number | null } | undefined;
  return row?.days === null || row?.days === undefined ? null : Number(row.days);
}

/** Set it (a manager's): a whole number of days, 1 to 365, or null/blank for never. */
export async function setOverdueBlockDays(venueId: number, days: unknown): Promise<{ ok: true; days: number | null } | { ok: false; error: string }> {
  const value = days === undefined || days === null || days === "" ? null : Number(days);
  if (value !== null && (!Number.isInteger(value) || value < 1 || value > 365)) return { ok: false, error: "Days overdue must be a whole number from 1 to 365, or blank for never." };
  const done = await getDb().prepare("UPDATE venues SET company_overdue_block_days = ? WHERE id = ?").run(value, venueId);
  if (done.changes === 0) return { ok: false, error: "That venue is not here." };
  return { ok: true, days: value };
}

export interface OverdueInvoice {
  id: number;
  number: string;
  accountId: number;
  accountName: string;
  venueId: number;
  dueOn: string;
  /** Whole days past the due day, on the venue's calendar. */
  daysOverdue: number;
  /** Still to pay on it (what its credit notes and part payments leave). */
  balance: number;
}

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * Invoices to accounts unpaid past their due day with something still to pay, oldest first: one account's, or the venues'
 * (`null` for all), days counted on each venue's own calendar. One definition, for the block on new bookings, the
 * reminders and the needs-attention list.
 */
export async function overdueInvoices(where: { accountId?: number; venueIds?: number[] | null }): Promise<OverdueInvoice[]> {
  const params: unknown[] = [addDays(todayISO(), 1)];
  let filter = "";
  if (where.accountId !== undefined) {
    filter = " AND i.account_id = ?";
    params.push(where.accountId);
  } else if (where.venueIds) {
    if (where.venueIds.length === 0) return [];
    filter = ` AND i.venue_id IN (${where.venueIds.map(() => "?").join(",")})`;
    params.push(...where.venueIds);
  }
  // A day's grace either side of the zones; each row is judged on its own venue's calendar below.
  const rows = (await getDb()
    .prepare(
      `SELECT i.id, i.period, i.account_id, i.venue_id, i.due_on, a.name AS account_name, ${BALANCE_OF("i")}::float AS balance
         FROM account_invoices i JOIN venue_accounts a ON a.id = i.account_id
        WHERE i.paid_on IS NULL AND i.due_on < ?${filter} ORDER BY i.due_on, i.id`
    )
    .all(...params)) as { id: number; period: string; account_id: number; venue_id: number; due_on: string; account_name: string; balance: number }[];
  const today = new Map<number, string>();
  const out: OverdueInvoice[] = [];
  for (const r of rows) {
    if (!today.has(r.venue_id)) today.set(r.venue_id, todayISO((await venueHours(r.venue_id)).zone));
    const days = daysBetween(r.due_on, today.get(r.venue_id)!);
    const balance = roundMoney(Number(r.balance));
    if (days < 1 || balance <= 0.004) continue;
    out.push({ id: r.id, number: `${r.period}-A${String(r.id).padStart(5, "0")}`, accountId: r.account_id, accountName: r.account_name, venueId: r.venue_id, dueOn: r.due_on, daysOverdue: days, balance });
  }
  return out;
}

/** The venues' needs-attention list: invoices to accounts past their day, and whether the venue's block now stops new bookings on each account. */
export async function overdueAccountsAttention(venueIds: number[] | null): Promise<(OverdueInvoice & { blocking: boolean })[]> {
  const late = await overdueInvoices({ venueIds });
  const days = new Map<number, number | null>();
  const out: (OverdueInvoice & { blocking: boolean })[] = [];
  for (const i of late) {
    if (!days.has(i.venueId)) days.set(i.venueId, await overdueBlockDays(i.venueId));
    const limit = days.get(i.venueId)!;
    out.push({ ...i, blocking: limit !== null && i.daysOverdue >= limit });
  }
  return out;
}

/** A reminder to the account, at most, on the first day overdue and then each week, six at most for an invoice. */
const REMIND_EVERY_DAYS = 7;
const MAX_OVERDUE_REMINDERS = 6;

/**
 * The scheduler's job: each invoice past its day with something still to pay is reminded to its account's address, the
 * first day it is overdue and weekly after, through the outbox (`dedupeKey` keeps a repeated tick from sending twice;
 * claimed with the count it was read at, so two ticks at once send once). Returns how many were queued.
 */
export async function remindOverdueAccountInvoices(): Promise<number> {
  const db = getDb();
  const late = await overdueInvoices({});
  let queued = 0;
  for (const i of late) {
    const row = (await db.prepare("SELECT overdue_reminders AS n, overdue_reminded_on AS last, token FROM account_invoices WHERE id = ?").get(i.id)) as
      | { n: number; last: string | null; token: string }
      | undefined;
    if (!row || Number(row.n) >= MAX_OVERDUE_REMINDERS) continue;
    const today = todayISO((await venueHours(i.venueId)).zone);
    if (row.last && daysBetween(row.last, today) < REMIND_EVERY_DAYS) continue;
    const account = await accountById(i.accountId, true);
    if (!account) continue;
    const claimed = await db
      .prepare("UPDATE account_invoices SET overdue_reminders = overdue_reminders + 1, overdue_reminded_on = ? WHERE id = ? AND overdue_reminders = ? AND paid_on IS NULL")
      .run(today, i.id, Number(row.n));
    if (claimed.changes === 0) continue;
    const venue = (await db.prepare("SELECT name FROM venues WHERE id = ?").get(i.venueId)) as { name: string };
    await enqueue({
      venueId: i.venueId,
      kind: "account_invoice",
      channel: "email",
      recipient: account.email,
      locale: account.locale,
      subject: "msg.accountOverdueSubject",
      body: "msg.accountOverdue",
      dedupeKey: `account-overdue:${i.id}:${Number(row.n) + 1}`,
      vars: {
        account: account.name,
        venue: venue.name,
        number: i.number,
        total: i.balance,
        due: i.dueOn,
        days: i.daysOverdue,
        link: linkIn(`${await venueBaseUrl(i.venueId)}/account-invoice/${row.token}`, account.locale),
        site: siteName(),
      },
    });
    queued++;
  }
  return queued;
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
  credited: number | string | null;
  received: number | string | null;
  token: string;
  paid_on: string | null;
  paid_via: CounterMethod | null;
}

const INVOICE_SELECT = `SELECT i.*, a.name AS account_name,
    ${CREDITED_ON("i")}::float AS credited,
    ${RECEIVED_ON("i")}::float AS received
  FROM account_invoices i JOIN venue_accounts a ON a.id = i.account_id`;

const toInvoice = (r: InvoiceRow): AccountInvoice => {
  const due = roundMoney(Math.max(0, Number(r.total) - Number(r.credited ?? 0)));
  const received = r.paid_on ? due : roundMoney(Number(r.received ?? 0));
  return {
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
    credited: roundMoney(Number(r.credited ?? 0)),
    due,
    received,
    balance: r.paid_on ? 0 : roundMoney(Math.max(0, due - received)),
    token: r.token,
    paidOn: r.paid_on,
    paidVia: r.paid_via,
  };
};

/** The last day of a month, YYYY-MM. */
function monthEnd(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/**
 * Put on one invoice what is charged to the account for dates up to the end
 * of `period` (and not after today), not yet invoiced or paid: "this month
 * so far" includes a session later today. The account buys on credit as it
 * books, and an issued invoice never changes: a place taken off, or the
 * booking cancelled, after it is issued is a credit note on the account
 * against it (`creditAccountForPlace`, `creditAccountForCancellation`), so an
 * hour invoiced and then not played is never charged. Null when there is
 * nothing to invoice.
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
    // What each booking is charged on this invoice is kept with it: the invoice never follows the booking's price afterwards.
    await db
      .prepare(`UPDATE bookings SET account_invoice_id = ?, invoiced_amount = GREATEST(0, total_price - shares_paid) WHERE id IN (${rows.map(() => "?").join(",")})`)
      .run(made.id, ...rows.map((r) => r.id));
    // Credit notes waiting on the account come off it, oldest first, part by part as far as its total goes: one too big for
    // this invoice takes what fits and the rest waits for the next. Each part is recorded (who, when, how much).
    const waiting = (await db
      .prepare("SELECT id, amount::float AS amount FROM account_credits WHERE account_id = ? AND settled_at IS NULL ORDER BY id FOR UPDATE")
      .all(accountId)) as { id: number; amount: number }[];
    if (waiting.length > 0) {
      // Read after the locks are held (a statement of its own), so a part taken a moment ago by another invoice counts.
      const taken = (await db
        .prepare(`SELECT credit_id, SUM(amount)::float AS taken FROM account_credit_allocations WHERE credit_id IN (${waiting.map(() => "?").join(",")}) GROUP BY credit_id`)
        .all(...waiting.map((c) => c.id))) as { credit_id: number; taken: number }[];
      const by = actingStaff();
      let room = total;
      for (const c of waiting) {
        const before = roundMoney(Number(taken.find((t) => t.credit_id === c.id)?.taken ?? 0));
        const left = roundMoney(Number(c.amount) - before);
        if (left <= 0.004) continue;
        const part = Math.min(left, room);
        if (part <= 0.004) break;
        await db
          .prepare("INSERT INTO account_credit_allocations (credit_id, invoice_id, amount, allocated_by_admin_id, allocated_by_name) VALUES (?, ?, ?, ?, ?)")
          .run(c.id, made.id, part, by?.id ?? null, by?.name ?? "scheduled invoicing");
        room = roundMoney(room - part);
        // Taken whole by this one invoice: marked so, as it always was.
        if (before === 0 && part >= left - 0.004) await db.prepare("UPDATE account_credits SET applied_invoice_id = ? WHERE id = ?").run(made.id, c.id);
      }
    }
    return (await invoiceById(made.id))!;
  });
  if (invoice && opts.email !== false) await emailInvoice(invoice, account);
  return invoice;
}

async function emailInvoice(invoice: AccountInvoice, account: Account): Promise<void> {
  const venue = (await getDb().prepare("SELECT name FROM venues WHERE id = ?").get(invoice.venueId)) as { name: string };
  await enqueue({
    venueId: invoice.venueId,
    kind: "account_invoice",
    channel: "email",
    recipient: account.email,
    locale: account.locale,
    subject: "msg.accountInvoiceSubject",
    body: "msg.accountInvoice",
    dedupeKey: `account-invoice:${invoice.id}`,
    vars: {
      account: invoice.accountName,
      venue: venue.name,
      number: invoice.number,
      // What the account pays: the total less the credit notes taken off it.
      total: invoice.due,
      due: invoice.dueOn,
      link: linkIn(`${await venueBaseUrl(invoice.venueId)}/account-invoice/${invoice.token}`, account.locale),
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

/** What the counter's invoice list filters by (lib/list-search.ts). */
export const INVOICE_LIST_STATUSES = ["open", "overdue", "paid"] as const;

/**
 * A venue's invoices to its accounts found by number or the account's name or
 * email; by status (`overdue`: unpaid past its day, oldest first); a page at
 * a time, newest first (lib/list-search.ts).
 */
export async function searchInvoices(venueId: number, query: ListQuery): Promise<Page<AccountInvoice>> {
  const today = todayISO();
  const match = textMatch(query.q, { codes: ["(i.period || '-A' || lpad(i.id::text, 5, '0'))"], names: ["a.name", "a.email"] });
  const STATUS: Record<string, { sql: string; params: unknown[] }> = {
    open: { sql: "i.paid_on IS NULL AND i.due_on >= ?", params: [today] },
    overdue: { sql: "i.paid_on IS NULL AND i.due_on < ?", params: [today] },
    paid: { sql: "i.paid_on IS NOT NULL", params: [] },
  };
  const status = query.status ? STATUS[query.status] : { sql: "TRUE", params: [] };
  const rows = (await getDb()
    .prepare(
      `${INVOICE_SELECT} WHERE i.venue_id = ? AND ${match.sql} AND ${status.sql}
        ORDER BY ${query.status === "overdue" ? "i.due_on, i.id" : "i.id DESC"} ${pageSql(query.page)}`
    )
    .all(venueId, ...match.params, ...status.params)) as InvoiceRow[];
  const page = paged(rows, query.page);
  return { ...page, items: page.items.map(toInvoice) };
}

/** What is on it, booking by booking. */
export async function invoiceLines(invoiceId: number): Promise<InvoiceLine[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT b.code, b.date, b.start_min, b.end_min, c.name AS court_name, b.name, ${CHARGED}::float AS owed
         FROM bookings b JOIN courts c ON c.id = b.court_id
        WHERE b.account_invoice_id = ? ORDER BY b.date, b.start_min, b.id`
    )
    .all(invoiceId)) as { code: string; date: string; start_min: number; end_min: number; court_name: string; name: string; owed: number }[];
  return rows.map((r) => ({
    code: r.code,
    date: r.date,
    startHour: hoursOf(r.start_min),
    endHour: hoursOf(r.end_min),
    courtName: r.court_name,
    bookedBy: r.name,
    amount: roundMoney(Number(r.owed)),
  }));
}

/** The credit notes on the account taken off this invoice, oldest first. */
export async function invoiceCredits(invoiceId: number): Promise<InvoiceCredit[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT r.number, b.code, al.amount::float AS amount FROM account_credit_allocations al
         JOIN account_credits c ON c.id = al.credit_id
         LEFT JOIN receipts r ON r.id = c.receipt_id LEFT JOIN bookings b ON b.id = c.booking_id
        WHERE al.invoice_id = ? ORDER BY al.id`
    )
    .all(invoiceId)) as { number: string | null; code: string | null; amount: number }[];
  return rows.map((r) => ({ number: r.number ?? "", code: r.code, amount: roundMoney(Number(r.amount)) }));
}

/**
 * One place taken off a booking on this account after its invoice was issued
 * (lib/place-withdrawals.ts, inside the withdrawal's transaction, under the
 * booking's lock): the invoice stays as issued; `amount` becomes a credit note
 * on the account against it, which comes off the account's next invoice.
 */
export async function creditAccountForPlace(input: {
  bookingId: number;
  withdrawalId: number;
  /** Who was taken off: their name, apart from the credit note's words (lib/documents.ts `Line.who`), or so many places. */
  who: { name: string | null; places: number };
  amount: number;
  why: string;
}): Promise<{ id: number; number: string | null } | null> {
  const amount = roundMoney(input.amount);
  if (amount <= 0) return null;
  const db = getDb();
  const b = (await db
    .prepare(
      `SELECT b.code, b.tax_rate, b.account_id, b.account_invoice_id, a.venue_id, a.name AS account_name
         FROM bookings b JOIN venue_accounts a ON a.id = b.account_id WHERE b.id = ?`
    )
    .get(input.bookingId)) as
    | { code: string; tax_rate: number | string | null; account_id: number; account_invoice_id: number | null; venue_id: number; account_name: string }
    | undefined;
  if (!b) return null;
  const invoice = b.account_invoice_id === null ? null : await invoiceById(b.account_invoice_id);
  const made = (await db
    .prepare("INSERT INTO account_credits (account_id, venue_id, booking_id, withdrawal_id, invoice_id, amount) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
    .get(b.account_id, b.venue_id, input.bookingId, input.withdrawalId, b.account_invoice_id, amount)) as { id: number };
  const { creditAccountPlace } = await import("./documents");
  const note = await creditAccountPlace({
    creditId: made.id,
    venueId: b.venue_id,
    accountName: b.account_name,
    invoiceNumber: invoice?.number ?? null,
    code: b.code,
    who: input.who,
    amount,
    taxRate: b.tax_rate === null ? null : Number(b.tax_rate),
    why: input.why,
  });
  if (note) await db.prepare("UPDATE account_credits SET receipt_id = ? WHERE id = ?").run(note.id, made.id);
  return { id: made.id, number: note?.number ?? null };
}

/**
 * A booking on this account cancelled after its invoice was issued
 * (lib/store.ts `refundBooking`, inside the cancellation's transaction): the
 * invoice stays as issued; `part` of what it charged for the booking (its
 * invoiced price, never the live one: all of it, or what is left after the
 * venue's late-cancellation fee, less places and moves already credited) becomes a credit note on the account against it, paid
 * or not, which comes off the account's next invoice or is paid back by
 * hand. Once per booking. False when the booking is not on an issued
 * invoice, so the caller reverses its receipt instead.
 */
export async function creditAccountForCancellation(bookingId: number, part: number, why: string): Promise<boolean> {
  const db = getDb();
  const b = (await db
    .prepare(
      `SELECT b.code, b.tax_rate, b.account_id, b.account_invoice_id, ${CHARGED}::float AS owed, a.venue_id, a.name AS account_name
         FROM bookings b JOIN venue_accounts a ON a.id = b.account_id WHERE b.id = ? AND b.account_invoice_id IS NOT NULL`
    )
    .get(bookingId)) as
    | { code: string; tax_rate: number | string | null; account_id: number; account_invoice_id: number; owed: number; venue_id: number; account_name: string }
    | undefined;
  if (!b) return false;
  const amount = roundMoney(Number(b.owed) * Math.min(1, Math.max(0, part)));
  if (amount <= 0) return true;
  const made = (await db
    .prepare(
      `INSERT INTO account_credits (account_id, venue_id, booking_id, invoice_id, amount, for_cancellation) VALUES (?, ?, ?, ?, ?, true)
       ON CONFLICT (booking_id) WHERE for_cancellation DO NOTHING RETURNING id`
    )
    .get(b.account_id, b.venue_id, bookingId, b.account_invoice_id, amount)) as { id: number } | undefined;
  if (!made) return true;
  const invoice = await invoiceById(b.account_invoice_id);
  const { creditAccountPlace, saidLine } = await import("./documents");
  const { said } = await import("./staff-text");
  const note = await creditAccountPlace({
    creditId: made.id,
    venueId: b.venue_id,
    accountName: b.account_name,
    invoiceNumber: invoice?.number ?? null,
    code: b.code,
    who: { name: null, places: 0 },
    amount,
    taxRate: b.tax_rate === null ? null : Number(b.tax_rate),
    why,
    line:
      why === "receipt.why.lateCancelled"
        ? saidLine(said("srv.line.lateShare", { pct: Math.round(part * 100), code: b.code }), amount)
        : saidLine(said("srv.d8b.cancelled", { code: b.code }), amount),
  });
  if (note) await db.prepare("UPDATE account_credits SET receipt_id = ? WHERE id = ?").run(note.id, made.id);
  return true;
}

/**
 * A booking on an issued invoice moved to a court or time that costs less (lib/store.ts `rescheduleBooking`, inside its
 * transaction, under the booking's lock): the invoice stays as issued and the booking keeps the price it was invoiced at;
 * the difference is a credit note on the account against that invoice, which comes off the account's next invoice or is
 * paid back by hand. Several moves, several credit notes. Null where the booking is not on an issued invoice or nothing
 * is to credit.
 */
export async function creditAccountForMove(bookingId: number, amount: number, why: string): Promise<{ id: number; number: string | null; amount: number } | null> {
  const credit = roundMoney(amount);
  if (credit <= 0) return null;
  const db = getDb();
  const b = (await db
    .prepare(
      `SELECT b.code, b.tax_rate, b.account_id, b.account_invoice_id, a.venue_id, a.name AS account_name
         FROM bookings b JOIN venue_accounts a ON a.id = b.account_id WHERE b.id = ? AND b.account_invoice_id IS NOT NULL`
    )
    .get(bookingId)) as
    | { code: string; tax_rate: number | string | null; account_id: number; account_invoice_id: number; venue_id: number; account_name: string }
    | undefined;
  if (!b) return null;
  const made = (await db
    .prepare("INSERT INTO account_credits (account_id, venue_id, booking_id, invoice_id, amount, for_adjustment) VALUES (?, ?, ?, ?, ?, true) RETURNING id")
    .get(b.account_id, b.venue_id, bookingId, b.account_invoice_id, credit)) as { id: number };
  const invoice = await invoiceById(b.account_invoice_id);
  const { creditAccountPlace, saidLine } = await import("./documents");
  const { said } = await import("./staff-text");
  const note = await creditAccountPlace({
    creditId: made.id,
    venueId: b.venue_id,
    accountName: b.account_name,
    invoiceNumber: invoice?.number ?? null,
    code: b.code,
    who: { name: null, places: 0 },
    amount: credit,
    taxRate: b.tax_rate === null ? null : Number(b.tax_rate),
    why,
    line: saidLine(said("srv.fx4.movedCheaper", { code: b.code }), credit),
  });
  if (note) await db.prepare("UPDATE account_credits SET receipt_id = ? WHERE id = ?").run(note.id, made.id);
  return { id: made.id, number: note?.number ?? null, amount: credit };
}

/**
 * Paid, or part-paid: `amount` is what was received now (all that is still to pay when not said), by `via`, recorded with
 * who took it and when. The bookings on the invoice are paid, by the same means, as the money received covers them in
 * the order they were played (an invoice paid in one go pays them all, as it always did); what the credit notes taken
 * off it cover is theirs, paid when the invoice is. The invoice is paid when what was received and the credit notes taken
 * off it cover its total, the remainder staying due until then. One cancelled since it was issued was paid for too (the
 * invoice stays as issued), its credit note on the account giving it back.
 */
export async function markInvoicePaid(
  venueId: number,
  invoiceId: number,
  via: unknown,
  amount?: unknown
): Promise<{ ok: true; invoice: AccountInvoice } | { ok: false; error: string }> {
  if (!COUNTER_METHODS.includes(via as CounterMethod)) return { ok: false, error: "Say how it was paid." };
  let asked: number | null = null;
  if (amount !== undefined && amount !== null && amount !== "") {
    if (!isAmount(amount, 0.01, MAX_CREDIT_LIMIT)) return { ok: false, error: "An amount received must be more than nothing, to the sen." };
    asked = roundMoney(amount);
  }
  const method = via as CounterMethod;
  return withTransaction(async () => {
    const db = getDb();
    const locked = (await db.prepare("SELECT id, paid_on FROM account_invoices WHERE id = ? AND venue_id = ? FOR UPDATE").get(invoiceId, venueId)) as
      | { id: number; paid_on: string | null }
      | undefined;
    if (!locked || locked.paid_on) return { ok: false as const, error: "That invoice is not here, or is paid already." };
    const now = await invoiceById(invoiceId);
    if (!now) return { ok: false as const, error: "That invoice is not here, or is paid already." };
    const pay = asked ?? now.balance;
    if (pay > now.balance + 0.004) return { ok: false as const, error: `Only ${money(now.balance)} is still to pay on it.` };
    const zone = (await venueHours(venueId)).zone;
    const by = actingStaff();
    if (pay > 0.004)
      await db
        .prepare("INSERT INTO account_invoice_payments (invoice_id, venue_id, amount, via, received_on, received_by_admin_id, received_by_name) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(invoiceId, venueId, pay, method, todayISO(zone), by?.id ?? null, by?.name ?? null);
    const received = roundMoney(now.received + (pay > 0.004 ? pay : 0));
    const settled = received >= now.due - 0.004;
    if (settled)
      await db.prepare("UPDATE account_invoices SET paid_on = ?, paid_via = ? WHERE id = ?").run(todayISO(zone), method, invoiceId);
    // The bookings the money received covers, in the order played; all of them once it is settled.
    const lines = (await db
      .prepare(
        `SELECT b.id, b.payment_status, ${CHARGED}::float AS charged FROM bookings b
          WHERE b.account_invoice_id = ? ORDER BY b.date, b.start_min, b.id FOR UPDATE`
      )
      .all(invoiceId)) as { id: number; payment_status: string; charged: number }[];
    const covered: number[] = [];
    let running = 0;
    for (const l of lines) {
      running = roundMoney(running + Number(l.charged));
      if (l.payment_status === "unpaid" && (settled || running <= received + 0.004)) covered.push(l.id);
    }
    if (covered.length > 0)
      await db
        .prepare(
          `UPDATE bookings SET payment_status = 'paid', paid_at = ?, paid_via = ?, paid_by = ?, paid_by_name = ?
            WHERE id IN (${covered.map(() => "?").join(",")}) AND payment_status = 'unpaid'`
        )
        // Who took the money, for the cash-up: whoever is acting (lib/acting-staff.ts).
        .run(new Date().toISOString(), method, by?.id ?? null, by?.name ?? null, ...covered);
    return { ok: true as const, invoice: (await invoiceById(invoiceId))! };
  });
}

/**
 * Withdrawn, as if never issued: its bookings wait to be invoiced again. Not
 * once paid or part-paid, nor once a booking on it was cancelled with a credit note
 * against it (that credit note stands, so the invoice does too).
 */
export async function withdrawInvoice(venueId: number, invoiceId: number): Promise<boolean> {
  return withTransaction(async () => {
    const db = getDb();
    // Its bookings first, as everything else takes them (a booking, then what it refers to): a change to one
    // of them under way (somebody taken off it) finishes first, rather than deadlocking with the delete.
    await db.prepare("SELECT id FROM bookings WHERE account_invoice_id = ? ORDER BY id FOR UPDATE").all(invoiceId);
    if (await db.prepare("SELECT 1 FROM account_credits WHERE invoice_id = ? AND (for_cancellation OR for_adjustment)").get(invoiceId)) return false;
    // Nor once any part of it was paid: that money was taken against this invoice.
    if (await db.prepare("SELECT 1 FROM account_invoice_payments WHERE invoice_id = ?").get(invoiceId)) return false;
    const done = await db.prepare("DELETE FROM account_invoices WHERE id = ? AND venue_id = ? AND paid_on IS NULL").run(invoiceId, venueId);
    return done.changes > 0;
  });
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
