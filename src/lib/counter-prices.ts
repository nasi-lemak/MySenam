import { getDb } from "./db";
import { isAmount, roundMoney } from "./region";
import { REASON_MAX, REASON_MIN } from "./policy-overrides";

/**
 * What a pass or membership sold at the counter costs (X1-19;
 * docs/features/pricing.md#selling-at-the-counter).
 *
 * The venue's prices are a manager's (docs/architecture/tenancy.md): a
 * membership is sold on one of the venue's plans and a pass from one of its
 * pass products (lib/pass-products.ts), at the plan's or product's price and
 * for its term. Anything else (another price, another term, or a sale with
 * neither) is a manager's, with a reason, kept with the sale in its
 * transaction (`counter_price_overrides`, migration 0235) and in the activity
 * log (`sale.price_set`). Front desk is refused, never quietly priced.
 */

/** A manager's price, as written with the sale. */
export interface CounterPriceOverride {
  /** The plan's or product's price; null when sold from neither. */
  listPrice: number | null;
  reason: string;
  adminId: number;
  adminName: string;
}

export type CounterPrice =
  | { ok: true; price: number; override: CounterPriceOverride | null }
  | { ok: false; error: string; code: string; status: number };

/** Who is selling, as the routes know them. */
export interface Seller {
  id: number;
  name: string;
  role: "manager" | "desk";
}

const refused = (status: number, code: string, error: string): CounterPrice => ({ ok: false, status, code, error });

/**
 * The price to sell at, from the plan or product's (`listPrice`, null for
 * neither), what was asked (`asked`, the price typed; left out, the list
 * price), whether the term asked differs from the plan's or product's, and
 * the reason given (`reason`).
 */
export function counterPrice(input: { seller: Seller; listPrice: number | null; asked: unknown; termDiffers?: boolean; reason: unknown }): CounterPrice {
  const { seller, listPrice } = input;
  const asked = input.asked === undefined || input.asked === null || input.asked === "" ? null : input.asked;
  if (asked !== null && !isAmount(asked)) return refused(400, "P8B_PRICE_INVALID", "A price is 0 or more, to the sen or cent.");
  const price = asked === null ? listPrice : roundMoney(asked as number);
  if (listPrice !== null && price === listPrice && !input.termDiffers) return { ok: true, price: listPrice, override: null };
  // Another price or term, or neither a plan nor a product: a manager's, with the reason.
  if (seller.role === "desk")
    return listPrice === null
      ? refused(403, "P8B_SELL_FROM_LIST", "Sell one of the venue's plans or passes at its price. A manager sells anything else, with a reason.")
      : refused(403, "P8B_PRICE_MANAGER", "Only a manager can sell at another price or for another term, with a reason.");
  if (price === null) return refused(400, "P8B_PRICE_INVALID", "A price is 0 or more, to the sen or cent.");
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < REASON_MIN || reason.length > REASON_MAX)
    return refused(400, "P8B_PRICE_REASON", "Say why it is sold at this price or for this term (5 to 300 characters): it is kept with the sale.");
  return { ok: true, price, override: { listPrice, reason, adminId: seller.id, adminName: seller.name } };
}

/** Written with the sale, inside its transaction (lib/store.ts `sellMembership`, `issuePass`). */
export async function recordPriceOverride(kind: "membership" | "pass", saleId: number, venueId: number, price: number, o: CounterPriceOverride): Promise<void> {
  await getDb()
    .prepare(
      `INSERT INTO counter_price_overrides (venue_id, kind, sale_id, list_price, price, reason, admin_id, admin_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(venueId, kind, saleId, o.listPrice, price, o.reason, o.adminId, o.adminName);
}

/** A sale's override, for the staff list: the list price it replaced and why. */
export interface PriceSet {
  listPrice: number | null;
  reason: string;
  adminName: string;
}

/** The overrides on these sales. */
export async function priceOverridesFor(kind: "membership" | "pass", ids: number[]): Promise<Map<number, PriceSet>> {
  const out = new Map<number, PriceSet>();
  if (ids.length === 0) return out;
  const rows = (await getDb()
    .prepare(
      `SELECT sale_id, list_price::float AS list_price, reason, admin_name FROM counter_price_overrides
        WHERE kind = ? AND sale_id IN (${ids.map(() => "?").join(",")})`
    )
    .all(kind, ...ids)) as { sale_id: number; list_price: number | null; reason: string; admin_name: string }[];
  for (const r of rows) out.set(r.sale_id, { listPrice: r.list_price === null ? null : Number(r.list_price), reason: r.reason, adminName: r.admin_name });
  return out;
}
