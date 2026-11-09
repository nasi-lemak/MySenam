import { salesJournal, type Category } from "./accounting";
import { getDb, withTransaction } from "./db";
import { hireDay, hireDepositsHeld, type HeldByMethod } from "./hire-deposits";
import { isAmount, roundMoney } from "./region";
import { addDays, todayISO } from "./time";
import { COUNTER_METHODS, type CounterMethod } from "./types";
import { venueZoneOf } from "./zones";

/**
 * The cash-up: what a venue's counter took and gave back on one day, by how
 * (X1-2; docs/features/payments-and-credit.md#cash-up), so the drawer, the QR
 * account and the card terminal can each be counted against it at the end of
 * a shift.
 *
 * Not a second ledger: it is the sales journal (lib/accounting.ts
 * `salesJournal`) for that day on the venue's calendar, every receipt and
 * credit note from every source (bookings paid, counter sales, credit
 * top-ups, passes, memberships, vouchers, fees, money kept from deposits),
 * summed by method, and for one member of staff where asked: who took or gave
 * back each one is kept with it (migration 0234). Its totals are the
 * journal's, row for row (`tests/cash-up.test.ts`), with one addition: where
 * credit is the install's own (MYSENAM_CREDIT_SCOPE=platform), credit sold
 * over this venue's counter is in its till though not in its books, and is
 * counted too. A test booking's receipt and credit notes, from before the
 * venue went live (lib/test-bookings.ts), are not added into those totals; they
 * are listed beside them in a block of their own (`test`), with their own
 * lines by method, so takings that were real money are never out of sight:
 * staff keep such a booking as real, and it is then in the totals.
 *
 * Hire deposits are not takings, but they are in the drawer (or on the terminal,
 * or in the QR account) while the kit is out: the day's `deposits` block lists
 * what was taken, given back and kept from them by how they were held, and what is
 * still held for customers (lib/hire-deposits.ts: the one definition the reports'
 * liabilities use too). What is kept from a deposit is a sale in the journal, so
 * the expected amount in each till is the journal's net plus the deposits taken
 * less every deposit let go of (given back and kept), counted once.
 *
 * A refund is two events (ADR 0075): the cancellation, whose credit note is in the journal on the day it is written, and the cash handed back, which
 * is a payout on the day it is. The credit note of a refund with a payout (or of a customer's own cancellation) is the record, not cash leaving a
 * till, so it is put back in the expected amount and the payout (by the day and method it was handed over) is taken out; refunds not yet handed over
 * are listed apart as still owed (`refunds`). The journal's own figures (`byMethod`, `totals`, `entries`) are untouched.
 *
 * The expected amounts are what a cashier counts against: `counts` are what was
 * counted at the end of the shift, with the variance, kept as they were counted
 * (cash_up_counts, migration 0308; `saveCashUpCount`).
 *
 * Front desk sees its own: what it took and gave back itself, today or the
 * day before (a shift past midnight). A manager sees everybody's, any day, or
 * one person's.
 */

/** The order methods are listed in: the counter's own first. */
const METHOD_ORDER = ["cash", "qr", "transfer", "card", "counter", "online", "credit"];

/** Paid from credit already sold: in the journal as the sale it is, but no money changes hands. */
const NOT_MONEY = new Set(["credit"]);

export interface CashUpEntry {
  /** When (UTC, ISO). */
  at: string;
  number: string;
  type: "Receipt" | "Credit note";
  customer: string;
  description: string;
  category: Category;
  /** How (lib/types.ts PaidVia, or `counter` where only "at the counter" was said), or null where nothing says. */
  method: string | null;
  /** Negative for a credit note. */
  gross: number;
  staffName: string | null;
}

export interface CashUpMethod {
  method: string | null;
  /** Receipts. */
  taken: number;
  /** Credit notes, as a positive amount. */
  givenBack: number;
  net: number;
  count: number;
  /** False for what was paid from credit already sold: no money changes hands. */
  money: boolean;
}

/** Receipts and credit notes summed by method: the real day's, and the test bookings' beside it. */
export interface CashUpPart {
  entries: CashUpEntry[];
  byMethod: CashUpMethod[];
  /** Money only (not what credit already sold paid for). */
  totals: { taken: number; givenBack: number; net: number };
}

/** One hire deposit taken or let go of on the day. */
export interface CashUpDepositEntry {
  at: string;
  bookingCode: string;
  customer: string;
  event: "taken" | "returned";
  /** How it was held (cash, qr, transfer, card), or null where that was not recorded. */
  method: string | null;
  /** Taken: the deposit. Returned: what was given back. */
  amount: number;
  /** Returned: what was kept back out of it (a sale in the journal). */
  kept: number;
  staffName: string | null;
}

/** Hire deposits on the day by method: taken, given back and kept (all positive amounts). */
export interface CashUpDeposits {
  byMethod: { method: string | null; taken: number; givenBack: number; kept: number }[];
  entries: CashUpDepositEntry[];
  /** Held for customers at the end of that day, by how they were held: the reports' liability for hire deposits as of then. */
  held: HeldByMethod[];
  heldTotal: number;
}

/** What each till should hold from the day, and what was counted. */
export interface CashUpExpected {
  method: CounterMethod;
  /** The journal's net for the method: takings less what was given back. */
  journalNet: number;
  /**
   * Credit notes the journal gave back on the day that record a refund owed or handed back (positive): they are the record, not cash leaving
   * the till, so they are put back here, and what was actually handed over is taken out (`handedBack`), on the day it was (ADR 0075).
   */
  refundNotes: number;
  /** Money handed back across the counter on the day by this method (positive), from the payouts: what actually left the till. */
  handedBack: number;
  /** Deposits taken less every deposit let go of (given back and kept; the part kept is in the journal as a sale). */
  depositsNet: number;
  /** `journalNet + refundNotes - handedBack + depositsNet`. */
  expected: number;
}

/** A refund handed back across the counter (or at the till by another method) on the day. */
export interface CashUpHandedBack {
  at: string;
  kind: "booking" | "entry" | "pass" | "membership";
  /** The booking's code, the pass's or membership's code, or the tournament's name: what the money went back on. */
  reference: string;
  /** The credit note it was paid out on, where the payout names one. */
  creditNote: string | null;
  amount: number;
  /** How it was actually handed over (an agreed alternative to the way it was paid is the one recorded), or null where no method was recorded. */
  method: string | null;
  /** How the customer had paid. */
  paidWith: string | null;
  /**
   * `payout`: taken out of the till on this day, by this method, and its credit note is not (see `refundNotes`). `credit note`: a payout
   * from before payouts named their credit note: counted by the credit note, on its day, as it always was, and not taken out a second time.
   */
  countedAs: "payout" | "credit note";
  staffName: string | null;
}

/** A refund owed back to a customer and not yet handed over at the end of the day: not money gone from any till. */
export interface CashUpStillOwed {
  kind: "booking" | "entry" | "pass" | "membership";
  reference: string;
  amount: number;
  /** How the customer paid, which is how it is owed back unless they agree to another. */
  method: string | null;
  /** Why (the cause as the list of money owed back records it). */
  cause: string;
  /** True where the customer's own cancellation wrote it (its credit note was written then). */
  customerCancelled: boolean;
  creditNote: string | null;
  /** Since when (UTC, ISO). */
  since: string;
}

/**
 * Refunds on the day, kept apart (ADR 0075): what was handed back, by the method it actually went back by, and what is still owed. The
 * credit note stays in the journal as the record; this is the cash side.
 */
export interface CashUpRefunds {
  handed: CashUpHandedBack[];
  /** Money taken out of the tills by payouts (`countedAs: "payout"`), by method actually used. */
  handedByMethod: { method: string | null; amount: number; count: number }[];
  /** Owed back at the end of the day and not yet handed over, venue-wide (an obligation is not a person's till). */
  owed: CashUpStillOwed[];
  owedByMethod: { method: string | null; amount: number; count: number }[];
  owedTotal: number;
}

/** A shift's count of one till, kept as it was counted. */
export interface CashUpCount {
  method: CounterMethod;
  counted: number;
  expected: number;
  /** Counted less expected: negative when short. */
  variance: number;
  note: string | null;
  countedBy: string | null;
  at: string;
}

export interface CashUp extends CashUpPart {
  venueId: number;
  date: string;
  /** One member of staff's, or null for everybody's. */
  staffId: number | null;
  /**
   * Test bookings' receipts and credit notes that day, from before the venue went live: shown, never added into the
   * totals above. Empty when there are none.
   */
  test: CashUpPart;
  /** Who took or gave back money that day, for the filter. */
  staff: { id: number; name: string }[];
  /** Hire deposits held, given back and kept that day. */
  deposits: CashUpDeposits;
  /** What each till should hold: money received less refunds actually handed over, by method, plus the deposits' part. Only methods with something in them. */
  expected: CashUpExpected[];
  /** Refunds handed back that day and refunds still owed at its end (ADR 0075). */
  refunds: CashUpRefunds;
  /** The latest count of each till for this scope (everybody's, or this member of staff's), if any. */
  counts: CashUpCount[];
}

type Row = Awaited<ReturnType<typeof salesJournal>>[number];

function summarise(rows: Row[]): CashUpPart {
  const methods = new Map<string | null, CashUpMethod>();
  for (const r of rows) {
    const m = methods.get(r.method) ?? { method: r.method, taken: 0, givenBack: 0, net: 0, count: 0, money: !NOT_MONEY.has(r.method ?? "") };
    if (r.type === "Receipt") m.taken += r.gross;
    else m.givenBack += -r.gross;
    m.net += r.gross;
    m.count++;
    methods.set(r.method, m);
  }
  const rank = (m: string | null) => (m === null ? METHOD_ORDER.length + 1 : METHOD_ORDER.includes(m) ? METHOD_ORDER.indexOf(m) : METHOD_ORDER.length);
  const byMethod = [...methods.values()]
    .map((m) => ({ ...m, taken: roundMoney(m.taken), givenBack: roundMoney(m.givenBack), net: roundMoney(m.net) }))
    .sort((a, b) => rank(a.method) - rank(b.method) || String(a.method).localeCompare(String(b.method)));
  const money = byMethod.filter((m) => m.money);
  return {
    entries: rows.map((r) => ({
      at: r.at,
      number: r.number,
      type: r.type,
      customer: r.customer,
      description: r.description,
      category: r.category,
      method: r.method,
      gross: r.gross,
      staffName: r.staffName,
    })),
    byMethod,
    totals: {
      taken: roundMoney(money.reduce((s, m) => s + m.taken, 0)),
      givenBack: roundMoney(money.reduce((s, m) => s + m.givenBack, 0)),
      net: roundMoney(money.reduce((s, m) => s + m.net, 0)),
    },
  };
}

export async function cashUp(venueId: number, date: string, staffId: number | null): Promise<CashUp> {
  // The day's journal, with credit the install sold as its own over this counter (in the till, not the books).
  const all = await salesJournal(venueId, date, date, { counter: true });
  const staff = new Map<number, string>();
  for (const r of all) if (r.staffId !== null) staff.set(r.staffId, r.staffName ?? "");
  const mine = (rows: Row[]) =>
    (staffId === null ? rows : rows.filter((r) => r.staffId === staffId)).sort((a, b) => a.at.localeCompare(b.at) || a.number.localeCompare(b.number));
  const realRows = mine(all.filter((r) => !r.test));
  const real = summarise(realRows);
  const deposits = await depositsOn(venueId, date, staffId);
  for (const e of deposits.entries) if (e.staffId > 0 && e.staffName) staff.set(e.staffId, e.staffName);
  const refunds = await refundsOn(venueId, date, staffId, realRows);
  return {
    venueId,
    date,
    staffId,
    ...real,
    test: summarise(mine(all.filter((r) => r.test))),
    staff: [...staff.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    deposits: { byMethod: deposits.byMethod, entries: deposits.entries.map((e) => ({ at: e.at, bookingCode: e.bookingCode, customer: e.customer, event: e.event, method: e.method, amount: e.amount, kept: e.kept, staffName: e.staffName })), held: deposits.held, heldTotal: deposits.heldTotal },
    expected: expectedFor(real, deposits.byMethod, refunds),
    refunds: refunds.report,
    counts: await countsFor(venueId, date, staffId),
  };
}

const MONEY_METHODS: readonly CounterMethod[] = COUNTER_METHODS;

/**
 * What each till should hold from the day: the money received less the money actually handed back, by method, on the day each happened,
 * plus the deposits' part (taken less let go of, kept included once). The journal's credit notes that record a refund owed or handed back are
 * not cash leaving the till (`refunds.notes`, put back); the payouts are (`refunds.out`). Every other credit note (a sale voided, a price
 * adjusted, a refund with no payout list behind it) is still the journal's.
 */
function expectedFor(part: CashUpPart, byMethod: CashUpDeposits["byMethod"], refunds: { notes: Map<string, number>; out: Map<string, number> }): CashUpExpected[] {
  const out: CashUpExpected[] = [];
  for (const method of MONEY_METHODS) {
    const j = part.byMethod.find((m) => m.method === method)?.net ?? 0;
    const d = byMethod.find((m) => m.method === method);
    const depositsNet = d ? roundMoney(d.taken - d.givenBack - d.kept) : 0;
    const refundNotes = roundMoney(refunds.notes.get(method) ?? 0);
    const handedBack = roundMoney(refunds.out.get(method) ?? 0);
    if (!part.byMethod.some((m) => m.method === method) && !d && refundNotes === 0 && handedBack === 0) continue;
    out.push({ method, journalNet: roundMoney(j), refundNotes, handedBack, depositsNet, expected: roundMoney(j + refundNotes - handedBack + depositsNet) });
  }
  return out;
}

/** A stored time as an ISO string, whichever way the driver hands it back. */
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : /^\d{4}-\d{2}-\d{2} \d/.test(String(v)) ? `${String(v).replace(" ", "T")}Z` : String(v));
const dayIn = (column: string) => `to_char(${column} AT TIME ZONE ?, 'YYYY-MM-DD')`;
const CUSTOMER_NOTE_SOURCE = `CASE WHEN o.cause = 'customer_cancelled' THEN 'booking:' || o.booking_id WHEN o.cause = 'place_withdrawn' THEN 'booking:' || o.booking_id || ':place:' || o.withdrawal_id END`;

function byMethodOf(rows: { method: string | null; amount: number }[]): { method: string | null; amount: number; count: number }[] {
  const m = new Map<string | null, { method: string | null; amount: number; count: number }>();
  for (const r of rows) {
    const e = m.get(r.method) ?? { method: r.method, amount: 0, count: 0 };
    e.amount += r.amount;
    e.count++;
    m.set(r.method, e);
  }
  const rank = (x: string | null) => (x === null ? METHOD_ORDER.length + 1 : METHOD_ORDER.includes(x) ? METHOD_ORDER.indexOf(x) : METHOD_ORDER.length);
  return [...m.values()].map((e) => ({ ...e, amount: roundMoney(e.amount) })).sort((a, b) => rank(a.method) - rank(b.method));
}

/**
 * The cash side of refunds on one day (ADR 0075), from the lists staff settle from, never a second ledger:
 *
 * - **Handed back that day**: the payouts (`counter_payouts`, and the settled rows of `counter_fee_refunds_owed`) dated by when they were handed
 *   over on the venue's calendar, by the method actually used.
 * - **Still owed at the end of the day**: `counter_refunds_owed` and `counter_fee_refunds_owed` rows that arose by then and were not settled until
 *   after it. An obligation is not money gone from a till.
 * - **Credit notes not counted as cash**: a credit note in the day's journal that a payout, or an owed row of a customer's cancellation, points
 *   at is the record of the refund, so its amount is put back into the till and the payout takes the cash out on the day it happened. A payout
 *   that names no credit note (written before they were linked) is left to its credit note as it always was, so nothing is taken out twice.
 * - **A cancellation from before migration 0346, reconciled by a manager** (ADR 0078): its credit note was counted as cash leaving the till on its
 *   own day (the rule above for a note nothing points at), and that day stays as it was counted. Neither the reconciliation's owed row nor its
 *   payout (`historical_reconciliation`) links the note; the part handed back now is a payout on the day it is handed over, like any other.
 */
async function refundsOn(venueId: number, date: string, staffId: number | null, rows: Row[]): Promise<{ report: CashUpRefunds; notes: Map<string, number>; out: Map<string, number> }> {
  const db = getDb();
  const v = (await db.prepare("SELECT time_zone, lat, lng FROM venues WHERE id = ?").get(venueId)) as { time_zone: string | null; lat: number | null; lng: number | null } | undefined;
  const zone = venueZoneOf(v ?? {});

  // The day's credit notes (in this scope) that are the record of a refund owed or handed back, not cash leaving a till.
  const noteIds = rows.filter((r) => r.type === "Credit note" && r.ref.startsWith("receipt:")).map((r) => Number(r.ref.slice("receipt:".length)));
  const linked = new Set<number>();
  if (noteIds.length > 0) {
    const ph = noteIds.map(() => "?").join(",");
    const found = (await db
      .prepare(
        `SELECT credit_note_id AS id FROM counter_payouts WHERE credit_note_id IN (${ph}) AND NOT historical_reconciliation
         UNION SELECT credit_note_id FROM counter_fee_refunds_owed WHERE credit_note_id IN (${ph})
         UNION SELECT r.id FROM counter_refunds_owed o JOIN receipts r ON r.kind = 'credit_note' AND r.source = ${CUSTOMER_NOTE_SOURCE}
                WHERE r.id IN (${ph}) AND o.historical_finding IS NULL`
      )
      .all(...noteIds, ...noteIds, ...noteIds)) as { id: number }[];
    for (const f of found) linked.add(Number(f.id));
  }
  const notes = new Map<string, number>();
  for (const r of rows) {
    if (r.type !== "Credit note" || !r.ref.startsWith("receipt:") || !linked.has(Number(r.ref.slice("receipt:".length)))) continue;
    if (r.method && (MONEY_METHODS as readonly string[]).includes(r.method)) notes.set(r.method, (notes.get(r.method) ?? 0) - r.gross);
  }

  // Handed back on the day.
  const bookings = (await db
    .prepare(
      `SELECT b.code, p.amount::float AS amount, p.via, p.credit_note_id, r.number AS note_number, b.paid_via, p.admin_name, p.paid_out_at
         FROM counter_payouts p JOIN bookings b ON b.id = p.booking_id LEFT JOIN receipts r ON r.id = p.credit_note_id
        WHERE p.venue_id = ? AND NOT b.test AND ${dayIn("p.paid_out_at")} = ?${staffId === null ? "" : " AND p.admin_id = ?"}`
    )
    .all(venueId, zone, date, ...(staffId === null ? [] : [staffId]))) as {
    code: string; amount: number; via: string | null; credit_note_id: number | null; note_number: string | null; paid_via: string | null; admin_name: string | null; paid_out_at: unknown;
  }[];
  const fees = (await db
    .prepare(
      `SELECT CASE WHEN o.pass_id IS NOT NULL THEN 'pass' WHEN o.membership_id IS NOT NULL THEN 'membership' ELSE 'entry' END AS kind,
              COALESCE(p.code, m.code, t.name, '') AS reference, o.amount::float AS amount, o.via, o.credit_note_id, r.number AS note_number, o.admin_name, o.settled_at
         FROM counter_fee_refunds_owed o
         LEFT JOIN tournament_entries e ON e.id = o.tournament_entry_id LEFT JOIN tournaments t ON t.id = e.tournament_id
         LEFT JOIN passes p ON p.id = o.pass_id LEFT JOIN memberships m ON m.id = o.membership_id LEFT JOIN receipts r ON r.id = o.credit_note_id
        WHERE o.venue_id = ? AND o.settled_at IS NOT NULL AND ${dayIn("o.settled_at")} = ?${staffId === null ? "" : " AND o.admin_id = ?"}`
    )
    .all(venueId, zone, date, ...(staffId === null ? [] : [staffId]))) as {
    kind: "pass" | "membership" | "entry"; reference: string; amount: number; via: string | null; credit_note_id: number | null; note_number: string | null; admin_name: string | null; settled_at: unknown;
  }[];
  const asMethod = (m: string | null) => ((COUNTER_METHODS as readonly string[]).includes(m ?? "") ? m : null);
  const handed: CashUpHandedBack[] = [
    ...bookings.map((r) => ({
      at: iso(r.paid_out_at),
      kind: "booking" as const,
      reference: r.code,
      creditNote: r.note_number,
      amount: roundMoney(Number(r.amount)),
      method: asMethod(r.via),
      paidWith: asMethod(r.paid_via),
      countedAs: r.credit_note_id === null ? ("credit note" as const) : ("payout" as const),
      staffName: r.admin_name,
    })),
    ...fees.map((r) => ({
      at: iso(r.settled_at),
      kind: r.kind,
      reference: r.reference,
      creditNote: r.note_number,
      amount: roundMoney(Number(r.amount)),
      method: asMethod(r.via),
      paidWith: asMethod(r.via),
      countedAs: r.credit_note_id === null ? ("credit note" as const) : ("payout" as const),
      staffName: r.admin_name,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at) || a.reference.localeCompare(b.reference));
  const out = new Map<string, number>();
  for (const h of handed) if (h.countedAs === "payout" && h.method) out.set(h.method, (out.get(h.method) ?? 0) + h.amount);

  // Still owed at the end of the day (the venue's, not one person's).
  const owedBookings = (await db
    .prepare(
      `SELECT b.code, o.amount::float AS amount, o.via, o.cause, o.owed_since, r.number AS note_number
         FROM counter_refunds_owed o JOIN bookings b ON b.id = o.booking_id LEFT JOIN receipts r ON r.kind = 'credit_note' AND r.source = ${CUSTOMER_NOTE_SOURCE}
        WHERE o.venue_id = ? AND NOT b.test AND ${dayIn("o.owed_since")} <= ? AND (o.settled_at IS NULL OR ${dayIn("o.settled_at")} > ?)`
    )
    .all(venueId, zone, date, zone, date)) as { code: string; amount: number; via: string | null; cause: string; owed_since: unknown; note_number: string | null }[];
  const owedFees = (await db
    .prepare(
      `SELECT CASE WHEN o.pass_id IS NOT NULL THEN 'pass' WHEN o.membership_id IS NOT NULL THEN 'membership' ELSE 'entry' END AS kind,
              COALESCE(p.code, m.code, t.name, '') AS reference, o.amount::float AS amount, o.via, o.cause, o.owed_since, r.number AS note_number
         FROM counter_fee_refunds_owed o
         LEFT JOIN tournament_entries e ON e.id = o.tournament_entry_id LEFT JOIN tournaments t ON t.id = e.tournament_id
         LEFT JOIN passes p ON p.id = o.pass_id LEFT JOIN memberships m ON m.id = o.membership_id LEFT JOIN receipts r ON r.id = o.credit_note_id
        WHERE o.venue_id = ? AND ${dayIn("o.owed_since")} <= ? AND (o.settled_at IS NULL OR ${dayIn("o.settled_at")} > ?)`
    )
    .all(venueId, zone, date, zone, date)) as { kind: "pass" | "membership" | "entry"; reference: string; amount: number; via: string | null; cause: string; owed_since: unknown; note_number: string | null }[];
  const owed: CashUpStillOwed[] = [
    ...owedBookings.map((r) => ({
      kind: "booking" as const,
      reference: r.code,
      amount: roundMoney(Number(r.amount)),
      method: asMethod(r.via),
      cause: r.cause,
      customerCancelled: r.cause === "customer_cancelled" || r.cause === "place_withdrawn",
      creditNote: r.note_number,
      since: iso(r.owed_since),
    })),
    ...owedFees.map((r) => ({
      kind: r.kind,
      reference: r.reference,
      amount: roundMoney(Number(r.amount)),
      method: asMethod(r.via),
      cause: r.cause,
      customerCancelled: false,
      creditNote: r.note_number,
      since: iso(r.owed_since),
    })),
  ].sort((a, b) => a.since.localeCompare(b.since) || a.reference.localeCompare(b.reference));

  return {
    notes,
    out,
    report: {
      handed,
      handedByMethod: byMethodOf(handed.filter((h) => h.countedAs === "payout")),
      owed,
      owedByMethod: byMethodOf(owed),
      owedTotal: roundMoney(owed.reduce((s, o) => s + o.amount, 0)),
    },
  };
}

/**
 * The day's hire deposits (on the venue's calendar; one member of staff's where asked: who took each and who gave it back is
 * kept with it): taken, given back and kept, by how they were held, and what is still held at the end of the day.
 */
async function depositsOn(venueId: number, date: string, staffId: number | null): Promise<CashUpDeposits & { entries: (CashUpDepositEntry & { staffId: number })[] }> {
  const db = getDb();
  const v = (await db.prepare("SELECT time_zone, lat, lng FROM venues WHERE id = ?").get(venueId)) as { time_zone: string | null; lat: number | null; lng: number | null } | undefined;
  const zone = venueZoneOf(v ?? {});
  const base = `FROM hire_records h JOIN bookings b ON b.id = h.booking_id JOIN courts c ON c.id = b.court_id WHERE c.venue_id = ? AND h.deposit > 0`;
  const taken = (await db
    .prepare(
      `SELECT h.taken_at AS at, b.code, b.name, COALESCE(h.deposit_via, h.deposit_via_stated) AS method, h.deposit::float AS amount, h.taken_by_admin_id AS staff_id, h.taken_by_name AS staff_name
         ${base} AND ${hireDay("h.taken_at")} = ?${staffId === null ? "" : " AND h.taken_by_admin_id = ?"}`
    )
    .all(venueId, zone, date, ...(staffId === null ? [] : [staffId]))) as {
    at: string; code: string; name: string; method: string | null; amount: number; staff_id: number | null; staff_name: string | null;
  }[];
  const back = (await db
    .prepare(
      `SELECT h.returned_at AS at, b.code, b.name, COALESCE(h.deposit_via, h.deposit_via_stated, h.returned_via) AS method, h.deposit::float AS deposit, COALESCE(h.withheld, 0)::float AS kept,
              h.returned_by_admin_id AS staff_id, h.returned_by_name AS staff_name
         ${base} AND h.returned_at IS NOT NULL AND ${hireDay("h.returned_at")} = ?${staffId === null ? "" : " AND h.returned_by_admin_id = ?"}`
    )
    .all(venueId, zone, date, ...(staffId === null ? [] : [staffId]))) as {
    at: string; code: string; name: string; method: string | null; deposit: number; kept: number; staff_id: number | null; staff_name: string | null;
  }[];
  const stamp = (t: string) => (/^\d{4}-\d{2}-\d{2} \d/.test(t) ? `${t.replace(" ", "T")}Z` : t);
  const entries: (CashUpDepositEntry & { staffId: number })[] = [
    ...taken.map((r) => ({ at: stamp(String(r.at)), bookingCode: r.code, customer: r.name, event: "taken" as const, method: r.method, amount: roundMoney(Number(r.amount)), kept: 0, staffName: r.staff_name, staffId: r.staff_id ?? 0 })),
    ...back.map((r) => ({
      at: stamp(String(r.at)),
      bookingCode: r.code,
      customer: r.name,
      event: "returned" as const,
      method: r.method,
      amount: roundMoney(Number(r.deposit) - Number(r.kept)),
      kept: roundMoney(Number(r.kept)),
      staffName: r.staff_name,
      staffId: r.staff_id ?? 0,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at) || a.bookingCode.localeCompare(b.bookingCode));
  const methods = new Map<string | null, { method: string | null; taken: number; givenBack: number; kept: number }>();
  for (const e of entries) {
    const m = methods.get(e.method) ?? { method: e.method, taken: 0, givenBack: 0, kept: 0 };
    if (e.event === "taken") m.taken += e.amount;
    else {
      m.givenBack += e.amount;
      m.kept += e.kept;
    }
    methods.set(e.method, m);
  }
  const rank = (m: string | null) => (m === null ? METHOD_ORDER.length + 1 : METHOD_ORDER.includes(m) ? METHOD_ORDER.indexOf(m) : METHOD_ORDER.length);
  const byMethod = [...methods.values()]
    .map((m) => ({ ...m, taken: roundMoney(m.taken), givenBack: roundMoney(m.givenBack), kept: roundMoney(m.kept) }))
    .sort((a, b) => rank(a.method) - rank(b.method));
  const held = await hireDepositsHeld(venueId, { day: date, zone });
  return { byMethod, entries, held: held.byMethod, heldTotal: held.total };
}

/** The latest count of each till for this day and scope. */
async function countsFor(venueId: number, date: string, staffId: number | null): Promise<CashUpCount[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT DISTINCT ON (method) method, counted::float AS counted, expected::float AS expected, variance::float AS variance, note, counted_by_name, created_at
         FROM cash_up_counts WHERE venue_id = ? AND day = ? AND scope_staff_id IS NOT DISTINCT FROM ? ORDER BY method, id DESC`
    )
    .all(venueId, date, staffId)) as { method: CounterMethod; counted: number; expected: number; variance: number; note: string | null; counted_by_name: string | null; created_at: unknown }[];
  return rows.map((r) => ({
    method: r.method,
    counted: roundMoney(Number(r.counted)),
    expected: roundMoney(Number(r.expected)),
    variance: roundMoney(Number(r.variance)),
    note: r.note,
    countedBy: r.counted_by_name,
    at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));
}

const MAX_COUNT = 10_000_000;

/**
 * Record what a cashier counted, till by till, against what the cash-up expects (worked out here from `cashUp`, never taken from
 * the caller): the variance is counted less expected, negative when short. A recount is another row, and the latest counts; nothing
 * is edited. The caller has checked the member of staff may see this cash-up (`cashUpAs`).
 */
export async function saveCashUpCount(
  cashUp: CashUp,
  by: { id: number; name: string },
  counts: unknown,
  note: unknown
): Promise<{ ok: true; counts: CashUpCount[] } | { ok: false; error: string }> {
  if (!Array.isArray(counts) || counts.length === 0) return { ok: false, error: "Give what was counted, till by till." };
  const text = typeof note === "string" && note.trim() !== "" ? note.trim().slice(0, 300) : null;
  const seen = new Set<string>();
  const rows: { method: CounterMethod; counted: number; expected: number }[] = [];
  for (const c of counts as { method?: unknown; counted?: unknown }[]) {
    if (!COUNTER_METHODS.includes(c?.method as CounterMethod)) return { ok: false, error: "Each count is for cash, QR, transfer or card." };
    if (seen.has(c.method as string)) return { ok: false, error: "Each till once." };
    seen.add(c.method as string);
    if (!isAmount(c.counted, 0, MAX_COUNT)) return { ok: false, error: "A count is an amount of money, to the sen, from nothing up." };
    rows.push({ method: c.method as CounterMethod, counted: c.counted, expected: cashUp.expected.find((e) => e.method === c.method)?.expected ?? 0 });
  }
  const db = getDb();
  await withTransaction(async () => {
    for (const r of rows)
      await db
        .prepare(
          `INSERT INTO cash_up_counts (venue_id, day, scope_staff_id, method, counted, expected, variance, note, counted_by_admin_id, counted_by_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(cashUp.venueId, cashUp.date, cashUp.staffId, r.method, r.counted, r.expected, roundMoney(r.counted - r.expected), text, by.id, by.name);
  });
  return { ok: true, counts: await countsFor(cashUp.venueId, cashUp.date, cashUp.staffId) };
}

/** What a member of staff may see (the caller has checked the venue is theirs): the route's and the printout's one rule. */
export async function cashUpAs(
  staff: { id: number; role: "manager" | "desk" },
  venueId: number,
  ask: { date?: string | null; staffId?: string | null }
): Promise<{ ok: true; cashUp: CashUp; scope: "own" | "all"; deskDays: string[] } | { ok: false; status: number; code?: string; error: string }> {
  const days = await deskDays(venueId);
  const date = ask.date || days[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return { ok: false, status: 400, error: "date is YYYY-MM-DD." };
  const raw = ask.staffId;
  const asked = raw === undefined || raw === null || raw === "" || raw === "all" ? null : Number(raw);
  if (asked !== null && (!Number.isInteger(asked) || asked <= 0)) return { ok: false, status: 400, error: "staffId is a member of staff's id." };
  const desk = staff.role === "desk";
  // Front desk closes its own till: its own takings, on its own shift.
  if (desk && asked !== null && asked !== staff.id)
    return { ok: false, status: 403, code: "P8B_CASHUP_OWN", error: "Front desk sees its own cash-up. Ask a manager for everybody's." };
  if (desk && !days.includes(date))
    return { ok: false, status: 403, code: "P8B_CASHUP_DAY", error: "Front desk cashes up today or yesterday. Ask a manager for another day." };
  const result = await cashUp(venueId, date, desk ? staff.id : asked);
  // Who else took money that day is a manager's to see.
  return { ok: true, cashUp: desk ? { ...result, staff: [] } : result, scope: desk ? "own" : "all", deskDays: days };
}

/** The venue's today, and the days front desk may cash up: today, and yesterday for a shift past midnight. */
export async function deskDays(venueId: number): Promise<string[]> {
  const v = (await getDb().prepare("SELECT time_zone, lat, lng FROM venues WHERE id = ?").get(venueId)) as
    | { time_zone: string | null; lat: number | null; lng: number | null }
    | undefined;
  const today = todayISO(venueZoneOf(v ?? {}));
  return [today, addDays(today, -1)];
}
