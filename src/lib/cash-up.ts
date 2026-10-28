import { salesJournal, type Category } from "./accounting";
import { getDb } from "./db";
import { roundMoney } from "./region";
import { addDays, todayISO } from "./time";
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
 * counted too; and one subtraction: a test booking's receipt and credit notes,
 * from before the venue went live (lib/test-bookings.ts), are no money in the
 * till and are left out.
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

export interface CashUp {
  venueId: number;
  date: string;
  /** One member of staff's, or null for everybody's. */
  staffId: number | null;
  entries: CashUpEntry[];
  byMethod: CashUpMethod[];
  /** Money only (not what credit already sold paid for). */
  totals: { taken: number; givenBack: number; net: number };
  /** Who took or gave back money that day, for the filter. */
  staff: { id: number; name: string }[];
}

export async function cashUp(venueId: number, date: string, staffId: number | null): Promise<CashUp> {
  // The day's journal, with credit the install sold as its own over this counter (in the till, not the books).
  const day = (await salesJournal(venueId, date, date, { counter: true })).filter((r) => !r.test);
  const staff = new Map<number, string>();
  for (const r of day) if (r.staffId !== null) staff.set(r.staffId, r.staffName ?? "");
  const rows = (staffId === null ? day : day.filter((r) => r.staffId === staffId)).sort((a, b) => a.at.localeCompare(b.at) || a.number.localeCompare(b.number));

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
    venueId,
    date,
    staffId,
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
    staff: [...staff.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
  };
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
