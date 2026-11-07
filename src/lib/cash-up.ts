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
  /** Deposits taken less every deposit let go of (given back and kept; the part kept is in the journal as a sale). */
  depositsNet: number;
  expected: number;
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
  /** What each till should hold: the journal's net by method plus the deposits' part. Only methods with something in them. */
  expected: CashUpExpected[];
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
  const real = summarise(mine(all.filter((r) => !r.test)));
  const deposits = await depositsOn(venueId, date, staffId);
  for (const e of deposits.entries) if (e.staffId > 0 && e.staffName) staff.set(e.staffId, e.staffName);
  return {
    venueId,
    date,
    staffId,
    ...real,
    test: summarise(mine(all.filter((r) => r.test))),
    staff: [...staff.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    deposits: { byMethod: deposits.byMethod, entries: deposits.entries.map((e) => ({ at: e.at, bookingCode: e.bookingCode, customer: e.customer, event: e.event, method: e.method, amount: e.amount, kept: e.kept, staffName: e.staffName })), held: deposits.held, heldTotal: deposits.heldTotal },
    expected: expectedFor(real, deposits.byMethod),
    counts: await countsFor(venueId, date, staffId),
  };
}

const MONEY_METHODS: readonly CounterMethod[] = COUNTER_METHODS;

/** What each till should hold from the day: the journal's net plus the deposits' part (taken less let go of, kept included once). */
function expectedFor(part: CashUpPart, byMethod: CashUpDeposits["byMethod"]): CashUpExpected[] {
  const out: CashUpExpected[] = [];
  for (const method of MONEY_METHODS) {
    const j = part.byMethod.find((m) => m.method === method)?.net ?? 0;
    const d = byMethod.find((m) => m.method === method);
    const depositsNet = d ? roundMoney(d.taken - d.givenBack - d.kept) : 0;
    if (!part.byMethod.some((m) => m.method === method) && !d) continue;
    out.push({ method, journalNet: roundMoney(j), depositsNet, expected: roundMoney(j + depositsNet) });
  }
  return out;
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
