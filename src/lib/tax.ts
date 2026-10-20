import { getDb } from "./db";
import { region, roundMoney } from "./region";

/**
 * Sales tax: SST in Malaysia, GST in Singapore.
 *
 * Two different taxes pass through MySenam, and neither is MySenam's to
 * decide. A venue charges its own on what customers pay it, if it is
 * registered; the platform charges its own on what it invoices venues, if
 * its operator is. Both are settings, so the rates and numbers an
 * accountant gives drop in without code.
 *
 * A venue's prices are what the customer pays, tax included — Singapore
 * requires GST-inclusive prices to consumers, and Malaysians are used to
 * "RM20 incl. SST" — so tax never changes what anybody pays, only how a
 * receipt and a report break it down. Each booking keeps the rate it was
 * taken at (migration 0036), so a later change of rate does not rewrite
 * what was charged.
 */

export interface VenueTax {
  registered: boolean;
  /** SST, GST: what the receipt calls it. */
  name: string;
  /** Percent, included in prices. Null when not registered. */
  rate: number | null;
  regNo: string | null;
}

export const MAX_TAX_RATE = 30;

/** What the tax is called here when nobody has said otherwise. */
export function taxName(): string {
  return region().tax.name;
}

/** The tax inside a tax-inclusive amount: RM21.20 at 6% holds RM1.20. */
export function taxIncluded(gross: number, rate: number | null | undefined): number {
  if (!rate || rate <= 0 || gross <= 0) return 0;
  return roundMoney((gross * rate) / (100 + rate));
}

/** The tax to add on top of a tax-exclusive amount: RM100 at 8% adds RM8. */
export function taxOnTop(net: number, rate: number | null | undefined): number {
  if (!rate || rate <= 0 || net <= 0) return 0;
  return roundMoney((net * rate) / 100);
}

export async function venueTax(venueId: number): Promise<VenueTax> {
  const row = (await getDb()
    .prepare("SELECT tax_registered, tax_name, tax_rate, tax_reg_no FROM venues WHERE id = ?")
    .get(venueId)) as { tax_registered: number; tax_name: string | null; tax_rate: number | string | null; tax_reg_no: string | null } | undefined;
  const registered = row?.tax_registered === 1;
  return {
    registered,
    name: row?.tax_name || taxName(),
    rate: registered && row?.tax_rate !== null && row?.tax_rate !== undefined ? Number(row.tax_rate) : null,
    regNo: registered ? row?.tax_reg_no ?? null : null,
  };
}

export type TaxResult = { ok: true; tax: VenueTax } | { ok: false; error: string };

/**
 * Register a venue for tax, change its rate or number, or take it off. New
 * bookings carry the new rate; bookings already made keep theirs.
 */
export async function setVenueTax(
  venueId: number,
  input: { registered: unknown; name?: unknown; rate?: unknown; regNo?: unknown }
): Promise<TaxResult> {
  if (input.registered !== true) {
    await getDb().prepare("UPDATE venues SET tax_registered = 0 WHERE id = ?").run(venueId);
    return { ok: true, tax: await venueTax(venueId) };
  }
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 12) : taxName();
  const rate = input.rate;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0 || rate > MAX_TAX_RATE || Math.round(rate * 100) !== rate * 100)
    return { ok: false, error: `The rate is a percentage above 0 and up to ${MAX_TAX_RATE}, such as 6 or 9.` };
  const regNo = typeof input.regNo === "string" ? input.regNo.trim() : "";
  if (regNo.length < 3 || regNo.length > 40)
    return { ok: false, error: `A registered venue's ${name} registration number goes on its receipts. Enter it.` };
  await getDb()
    .prepare("UPDATE venues SET tax_registered = 1, tax_name = ?, tax_rate = ?, tax_reg_no = ? WHERE id = ?")
    .run(name, rate, regNo, venueId);
  return { ok: true, tax: await venueTax(venueId) };
}

/** The platform operator's own tax, on what it invoices venues: from the environment. */
export interface PlatformTax {
  name: string;
  /** Percent, added on top of the fee. */
  rate: number;
  regNo: string;
}

/**
 * `MYSENAM_TAX_RATE` and `MYSENAM_TAX_REG_NO` (and `MYSENAM_TAX_NAME`, else
 * the country's): set both once the operator is registered, and invoices
 * from then on carry the tax. Either missing: no tax, as before.
 */
export function platformTax(): PlatformTax | null {
  const rate = Number(process.env.MYSENAM_TAX_RATE);
  const regNo = process.env.MYSENAM_TAX_REG_NO?.trim();
  if (!Number.isFinite(rate) || rate <= 0 || rate > MAX_TAX_RATE || !regNo) return null;
  return { name: process.env.MYSENAM_TAX_NAME?.trim() || taxName(), rate, regNo };
}
