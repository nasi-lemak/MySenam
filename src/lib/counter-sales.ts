import { addonById, MAX_QUANTITY } from "./addons";
import { getDb } from "./db";
import { creditReceipt, documentFor, issueReceipt, paidVia } from "./documents";
import { longEnough } from "./phone";
import { receiptPath } from "./receipts";
import { roundMoney } from "./region";
import { COUNTER_METHODS, type CounterMethod } from "./types";
import { venueZoneOf } from "./zones";

/**
 * Selling over the counter with no booking: a drink, a tube of shuttles, a
 * grip, a racket hired by somebody who booked elsewhere.
 *
 * What can be picked is the venue's own list of extras (lib/addons.ts), at
 * its price, plus anything typed in with a price for the odd item not on it.
 * Each sale is receipted at once, the venue's tax inside the price as with
 * everything else, and goes into the reports and the accounting export as
 * "Counter sales". A mistake is voided by a manager, which writes a credit
 * note; handing the money back is the desk's to do. There is no stock count:
 * the list says what is sold, not how many are left.
 */

export const MAX_LINES = 20;
export const MAX_UNIT_PRICE = 1000;

export interface SaleLine {
  addonId: number | null;
  name: string;
  quantity: number;
  unitPrice: number;
}

export interface CounterSale {
  id: number;
  venueId: number;
  customerName: string | null;
  lines: SaleLine[];
  total: number;
  paidVia: CounterMethod;
  soldBy: string | null;
  createdAt: string;
  voidedAt: string | null;
  voidReason: string | null;
  receipt: { number: string; path: string } | null;
}

interface Row {
  id: number;
  venue_id: number;
  admin_id: number | null;
  customer_name: string | null;
  customer_phone: string | null;
  lines: string;
  total: number | string;
  paid_via: CounterMethod;
  voided_at: string | null;
  void_reason: string | null;
  created_at: string;
  sold_by?: string | null;
}

async function toSale(r: Row): Promise<CounterSale> {
  const doc = await documentFor(`sale:${r.id}`);
  return {
    id: r.id,
    venueId: r.venue_id,
    customerName: r.customer_name,
    lines: JSON.parse(r.lines) as SaleLine[],
    total: Number(r.total),
    paidVia: r.paid_via,
    soldBy: r.sold_by ?? null,
    createdAt: r.created_at,
    voidedAt: r.voided_at,
    voidReason: r.void_reason,
    receipt: doc ? { number: doc.number, path: receiptPath(doc.ref) } : null,
  };
}

export interface SellInput {
  venueId: number;
  adminId: number | null;
  /** From the list `{ addonId, quantity }`, or typed in `{ name, price, quantity }`. */
  items: unknown;
  via: unknown;
  customerName?: unknown;
  customerPhone?: unknown;
}

type Outcome = { ok: true; sale: CounterSale } | { ok: false; error: string };

export async function sellAtCounter(input: SellInput): Promise<Outcome> {
  if (!COUNTER_METHODS.includes(input.via as CounterMethod)) return { ok: false, error: "Say how it was paid." };
  if (!Array.isArray(input.items) || input.items.length === 0) return { ok: false, error: "Add something to sell." };
  if (input.items.length > MAX_LINES) return { ok: false, error: `At most ${MAX_LINES} lines in one sale.` };

  const lines: SaleLine[] = [];
  for (const raw of input.items as Record<string, unknown>[]) {
    const quantity = Number(raw?.quantity ?? 1);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY)
      return { ok: false, error: `Quantities are 1 to ${MAX_QUANTITY}.` };
    if (raw?.addonId !== undefined && raw.addonId !== null) {
      const addon = Number.isInteger(raw.addonId) ? await addonById(raw.addonId as number) : null;
      if (!addon || addon.venueId !== input.venueId || !addon.active) return { ok: false, error: "That item is not on this venue's list." };
      if (addon.price <= 0) return { ok: false, error: `${addon.name} is free: nothing to sell.` };
      lines.push({ addonId: addon.id, name: addon.kind === "rental" ? `${addon.name} (hire)` : addon.name, quantity, unitPrice: addon.price });
      continue;
    }
    const name = typeof raw?.name === "string" ? raw.name.trim() : "";
    if (name.length < 2 || name.length > 60) return { ok: false, error: "Name each item typed in (2 to 60 characters)." };
    const price = roundMoney(Number(raw?.price));
    if (!Number.isFinite(price) || price <= 0 || price > MAX_UNIT_PRICE)
      return { ok: false, error: `A price is more than 0 and at most ${MAX_UNIT_PRICE}.` };
    lines.push({ addonId: null, name, quantity, unitPrice: price });
  }
  const total = roundMoney(lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0));

  const customerName = typeof input.customerName === "string" && input.customerName.trim() ? input.customerName.trim().slice(0, 80) : null;
  const phone = typeof input.customerPhone === "string" && input.customerPhone.trim() ? input.customerPhone.trim() : null;
  if (phone && !longEnough(phone)) return { ok: false, error: "That phone number looks too short." };

  const db = getDb();
  const row = (await db
    .prepare(
      `INSERT INTO counter_sales (venue_id, admin_id, customer_name, customer_phone, lines, total, paid_via)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`
    )
    .get(input.venueId, input.adminId, customerName, phone, JSON.stringify(lines), total, input.via)) as Row;
  await issueReceipt({
    source: `sale:${row.id}`,
    venueId: input.venueId,
    name: customerName ?? "Counter customer",
    phone,
    lines: lines.map((l) => ({
      description: l.quantity === 1 ? l.name : `${l.name} × ${l.quantity}`,
      amount: roundMoney(l.unitPrice * l.quantity),
    })),
    paidVia: paidVia(input.via as string),
    taxable: true,
  });
  return { ok: true, sale: await toSale(row) };
}

/**
 * What was kept back from a hire deposit, rung up as a sale (lib/store.ts,
 * returnHire): one per hire, receipted, in the day's takings. Compensation
 * for damage or loss is not taxed unless the venue says it is a charge for a
 * service; the venue decides, case by case. Run inside the return's
 * transaction.
 */
export async function sellKeptDeposit(input: {
  venueId: number;
  hireRecordId: number;
  description: string;
  amount: number;
  via: CounterMethod;
  taxable: boolean;
  customerName: string | null;
  customerPhone: string | null;
}): Promise<number> {
  const lines: SaleLine[] = [{ addonId: null, name: input.description.slice(0, 120), quantity: 1, unitPrice: roundMoney(input.amount) }];
  const row = (await getDb()
    .prepare(
      `INSERT INTO counter_sales (venue_id, admin_id, customer_name, customer_phone, lines, total, paid_via, hire_record_id)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .get(input.venueId, input.customerName, input.customerPhone, JSON.stringify(lines), roundMoney(input.amount), input.via, input.hireRecordId)) as { id: number };
  await issueReceipt({
    source: `sale:${row.id}`,
    venueId: input.venueId,
    name: input.customerName ?? "Counter customer",
    phone: input.customerPhone,
    lines: [{ description: lines[0].name, amount: lines[0].unitPrice }],
    paidVia: paidVia(input.via),
    taxable: input.taxable,
  });
  return row.id;
}

export async function getCounterSale(id: number): Promise<CounterSale | null> {
  const row = (await getDb().prepare("SELECT * FROM counter_sales WHERE id = ?").get(id)) as Row | undefined;
  return row ? toSale(row) : null;
}

async function zoneOf(venueId: number): Promise<string> {
  const v = (await getDb().prepare("SELECT time_zone, lat, lng FROM venues WHERE id = ?").get(venueId)) as
    | { time_zone: string | null; lat: number | null; lng: number | null }
    | undefined;
  return venueZoneOf(v ?? {});
}

export interface CounterDay {
  sales: CounterSale[];
  /** Not counting voided ones. */
  total: number;
  byMethod: { via: CounterMethod; total: number }[];
}

/** A day's sales at the counter, on the venue's calendar, newest first: the till to count against. */
export async function counterDay(venueId: number, date: string): Promise<CounterDay> {
  const rows = (await getDb()
    .prepare(
      `SELECT s.*, a.name AS sold_by FROM counter_sales s LEFT JOIN admins a ON a.id = s.admin_id
        WHERE s.venue_id = ? AND to_char((s.created_at::timestamp AT TIME ZONE 'UTC') AT TIME ZONE ?, 'YYYY-MM-DD') = ?
        ORDER BY s.id DESC`
    )
    .all(venueId, await zoneOf(venueId), date)) as Row[];
  const sales = await Promise.all(rows.map(toSale));
  const kept = sales.filter((s) => !s.voidedAt);
  const methods = new Map<CounterMethod, number>();
  for (const s of kept) methods.set(s.paidVia, roundMoney((methods.get(s.paidVia) ?? 0) + s.total));
  return {
    sales,
    total: roundMoney(kept.reduce((s, x) => s + x.total, 0)),
    byMethod: [...methods.entries()].map(([via, total]) => ({ via, total })),
  };
}

/** A sale undone: written off with a credit note, once. The money goes back by hand. */
export async function voidCounterSale(id: number, adminId: number | null, reason: unknown): Promise<Outcome> {
  const why = typeof reason === "string" ? reason.trim().slice(0, 200) : "";
  if (why.length < 3) return { ok: false, error: "Say why it is being voided." };
  const done = await getDb()
    .prepare("UPDATE counter_sales SET voided_at = datetime('now'), voided_by = ?, void_reason = ? WHERE id = ? AND voided_at IS NULL")
    .run(adminId, why, id);
  if (done.changes !== 1) return { ok: false, error: "That sale is already voided." };
  await creditReceipt(`sale:${id}`, "receipt.why.voided");
  return { ok: true, sale: (await getCounterSale(id))! };
}
