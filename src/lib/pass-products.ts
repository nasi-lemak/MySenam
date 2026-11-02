import { isActivity } from "./activities";
import { getDb } from "./db";
import { isScope, PASS_SCOPES } from "./entitlements";
import { isAmount, roundMoney } from "./region";
import { addDays } from "./time";
import { DAY_MINUTES } from "./interval";
import { MAX_PASS_ENTRIES, MAX_PASS_MINUTES, MAX_PASS_MONTHS, type BenefitScope, type PassKind } from "./types";

/**
 * The passes a venue sells over the counter (X1-19; migration 0235;
 * docs/features/pricing.md#selling-at-the-counter): set up by a manager with
 * what each spends and covers, how long it lasts and its price, so the desk
 * sells "10 sessions, 3 months, RM120" with a tap and the price is the
 * venue's, not whoever is at the desk. A pass sold from one copies its terms
 * and names it (`passes.product_id`); retiring a product leaves the passes
 * already sold as they were.
 */

export interface PassProduct {
  id: number;
  venueId: number;
  name: string;
  sport: string | null;
  coachId: number | null;
  coachName: string | null;
  kind: PassKind;
  /** Entries (a session pass) or minutes of court time (a time pass). */
  entries: number;
  entryMinutes: number | null;
  maxMinutes: number | null;
  scope: BenefitScope;
  price: number;
  /** Days it lasts from the day it is sold, that day included. */
  validDays: number;
  /** Offered on the venue's page, bought and paid online (migration 0264; lib/pass-purchases.ts). Off unless a manager says. */
  soldOnline: boolean;
  /**
   * A day pass (migration 0266; lib/entries.ts): one entry for one person,
   * admitting them all the day it is first used, at a resource taking entries.
   */
  dayPass: boolean;
}

/** A venue's list stays short enough to pick from at a glance. */
export const MAX_PASS_PRODUCTS = 20;
export const MAX_VALID_DAYS = MAX_PASS_MONTHS * 31;

interface Row {
  id: number;
  venue_id: number;
  name: string;
  sport: string | null;
  coach_id: number | null;
  coach_name: string | null;
  kind: string;
  entries: number;
  entry_minutes: number | null;
  max_minutes: number | null;
  scope: string;
  price: number | string;
  valid_days: number;
  sold_online: boolean | number | null;
  day_pass?: boolean | null;
}

const SELECT = `SELECT p.*, k.name AS coach_name FROM pass_products p LEFT JOIN coaches k ON k.id = p.coach_id`;

const toProduct = (r: Row): PassProduct => ({
  id: r.id,
  venueId: r.venue_id,
  name: r.name,
  sport: r.sport,
  coachId: r.coach_id,
  coachName: r.coach_name,
  kind: r.kind === "time" ? "time" : "session",
  entries: r.entries,
  entryMinutes: r.entry_minutes,
  maxMinutes: r.max_minutes,
  scope: isScope(r.scope, PASS_SCOPES) ? r.scope : "booking",
  price: Number(r.price),
  validDays: r.valid_days,
  soldOnline: Boolean(r.sold_online),
  dayPass: r.day_pass === true,
});

/** What the venue offers now, cheapest first. */
export async function listPassProducts(venueId: number): Promise<PassProduct[]> {
  const rows = (await getDb()
    .prepare(`${SELECT} WHERE p.venue_id = ? AND p.retired_at IS NULL ORDER BY p.price, p.id`)
    .all(venueId)) as Row[];
  return rows.map(toProduct);
}

/** What the venue offers online now (lib/pass-purchases.ts), cheapest first. */
export async function listOnlinePassProducts(venueId: number): Promise<PassProduct[]> {
  return (await listPassProducts(venueId)).filter((p) => p.soldOnline);
}

/**
 * One by id whatever became of it, for settling a payment made for it: a
 * product retired while the customer paid still gives what they paid for.
 */
export async function passProductById(id: number): Promise<PassProduct | null> {
  const row = (await getDb().prepare(`${SELECT} WHERE p.id = ?`).get(id)) as Row | undefined;
  return row ? toProduct(row) : null;
}

/** The least a pass sold online may cost: a payment page asks for something. */
export const MIN_ONLINE_PASS_PRICE = 1;

/** Why this product cannot be sold online, or null: a free or token one is given at the counter. */
export function onlineRefusal(product: Pick<PassProduct, "price">): string | null {
  return product.price < MIN_ONLINE_PASS_PRICE ? `A pass sold online costs at least ${MIN_ONLINE_PASS_PRICE}.` : null;
}

/** A manager offers one online, or stops: passes already sold, and pages already open, are as they were. */
export async function setSoldOnline(venueId: number, id: number, soldOnline: boolean): Promise<ProductResult | null> {
  const product = await passProductAt(venueId, id);
  if (!product) return null;
  if (soldOnline) {
    const why = onlineRefusal(product);
    if (why) return { ok: false, error: why };
  }
  await getDb().prepare("UPDATE pass_products SET sold_online = ? WHERE id = ? AND venue_id = ?").run(soldOnline, id, venueId);
  return { ok: true, product: (await passProductAt(venueId, id))! };
}

/** One the venue still offers; null for a retired one or another venue's. */
export async function passProductAt(venueId: number, id: number): Promise<PassProduct | null> {
  const row = (await getDb().prepare(`${SELECT} WHERE p.id = ? AND p.venue_id = ? AND p.retired_at IS NULL`).get(id, venueId)) as Row | undefined;
  return row ? toProduct(row) : null;
}

/** The last day a pass sold today from it may be used. */
export function productExpiry(product: Pick<PassProduct, "validDays">, today: string): string {
  return addDays(today, product.validDays - 1);
}

export type ProductResult = { ok: true; product: PassProduct } | { ok: false; error: string };

const minutesOrNull = (v: unknown): number | null | false => (v === undefined || v === null || v === "" ? null : Number.isInteger(v) ? (v as number) : false);

/** A manager adds one. */
export async function createPassProduct(venueId: number, input: Record<string, unknown>, adminId: number | null): Promise<ProductResult> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length < 2 || name.length > 60) return { ok: false, error: "Give the pass a name of 2 to 60 characters." };
  if (input.dayPass !== undefined && typeof input.dayPass !== "boolean") return { ok: false, error: "dayPass is true or false." };
  // A day pass is one entry for one person, whatever else was said (lib/entries.ts).
  const dayPass = input.dayPass === true;
  if (dayPass) input = { ...input, kind: "session", entries: 1, entryMinutes: null, maxMinutes: null, scope: "participant", coachId: null };
  const kind = input.kind === undefined || input.kind === null || input.kind === "" ? "session" : input.kind;
  if (kind !== "session" && kind !== "time") return { ok: false, error: "A pass spends entries or court time." };
  const most = kind === "time" ? MAX_PASS_MINUTES : MAX_PASS_ENTRIES;
  if (!Number.isInteger(input.entries) || (input.entries as number) < 1 || (input.entries as number) > most)
    return { ok: false, error: kind === "time" ? `Court time must be 1–${most} minutes.` : `Entries must be 1–${most}.` };
  const entry = minutesOrNull(input.entryMinutes === undefined && kind === "session" ? 60 : input.entryMinutes);
  const longest = minutesOrNull(input.maxMinutes);
  if (entry === false || longest === false) return { ok: false, error: "entryMinutes and maxMinutes are whole minutes, or null." };
  const entryMinutes = kind === "time" ? null : entry;
  if (entryMinutes !== null && (entryMinutes < 1 || entryMinutes > DAY_MINUTES)) return { ok: false, error: `An entry covers 1–${DAY_MINUTES} minutes, or a whole booking.` };
  if (longest !== null && (longest < 1 || longest > DAY_MINUTES)) return { ok: false, error: `The longest booking a pass pays for is 1–${DAY_MINUTES} minutes.` };
  if (!isAmount(input.price, 0, 100000)) return { ok: false, error: "A price is 0 or more, to the sen or cent." };
  if (!Number.isInteger(input.validDays) || (input.validDays as number) < 1 || (input.validDays as number) > MAX_VALID_DAYS)
    return { ok: false, error: `A pass lasts 1 to ${MAX_VALID_DAYS} days.` };
  const scope = input.scope === undefined || input.scope === null || input.scope === "" ? "booking" : input.scope;
  if (!isScope(scope, PASS_SCOPES)) return { ok: false, error: "scope must be booking, resource, participant or places." };
  const db = getDb();
  let sport: string | null = null;
  if (input.sport !== undefined && input.sport !== null && input.sport !== "") {
    if (!(await isActivity(input.sport))) return { ok: false, error: "Unknown sport." };
    sport = input.sport as string;
  }
  let coachId: number | null = null;
  if (input.coachId !== undefined && input.coachId !== null && input.coachId !== "") {
    const coach = Number.isInteger(input.coachId)
      ? ((await db.prepare("SELECT venue_id, active FROM coaches WHERE id = ?").get(input.coachId)) as { venue_id: number; active: number } | undefined)
      : undefined;
    if (!coach || coach.venue_id !== venueId || coach.active !== 1) return { ok: false, error: "That coach does not take lessons here." };
    coachId = input.coachId as number;
  }
  const soldOnline = input.soldOnline === true;
  if (input.soldOnline !== undefined && typeof input.soldOnline !== "boolean") return { ok: false, error: "soldOnline is true or false." };
  if (soldOnline) {
    const why = onlineRefusal({ price: Number(input.price) });
    if (why) return { ok: false, error: why };
  }
  const { n } = (await db.prepare("SELECT COUNT(*)::int AS n FROM pass_products WHERE venue_id = ? AND retired_at IS NULL").get(venueId)) as { n: number };
  if (Number(n) >= MAX_PASS_PRODUCTS) return { ok: false, error: `A venue offers up to ${MAX_PASS_PRODUCTS} passes. Retire one first.` };
  const row = (await db
    .prepare(
      `INSERT INTO pass_products (venue_id, name, sport, coach_id, kind, entries, entry_minutes, max_minutes, scope, price, valid_days, created_by, sold_online, day_pass)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .get(venueId, name, sport, coachId, kind, input.entries, entryMinutes, longest, scope, roundMoney(input.price as number), input.validDays, adminId, soldOnline, dayPass)) as { id: number };
  return { ok: true, product: (await passProductAt(venueId, row.id))! };
}

/** Stop selling one. Passes already sold from it run their course. */
export async function retirePassProduct(venueId: number, id: number): Promise<PassProduct | null> {
  const product = await passProductAt(venueId, id);
  if (!product) return null;
  await getDb().prepare("UPDATE pass_products SET retired_at = now() WHERE id = ? AND venue_id = ? AND retired_at IS NULL").run(id, venueId);
  return product;
}
