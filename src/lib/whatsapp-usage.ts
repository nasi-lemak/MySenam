import { getDb } from "./db";

/**
 * WhatsApp messages a venue's customers were sent, counted for its bill.
 *
 * Meta charges the platform for each template it delivers — a few sen in
 * Malaysia — so a flat fee with no ceiling would cost more than it brings in
 * at a busy hall. Each venue's fee includes a monthly allowance; past that,
 * each message is charged on the next month's invoice at a small rate. Both
 * have marketplace defaults and can be set per venue.
 *
 * What counts is what Meta charges for: a template sent. A reply in a chat
 * the customer opened (the "Send it to my WhatsApp" button) is free, and is
 * counted apart so a venue can see what it saved. Email is not counted at
 * all, and neither are the codes that check a customer's phone number, which
 * protect the whole marketplace rather than one venue.
 */

/** Messages a month's fee includes unless the venue has its own number. */
export function defaultIncluded(): number {
  const n = Number(process.env.MYSENAM_WHATSAPP_INCLUDED ?? 300);
  return Number.isInteger(n) && n >= 0 ? n : 300;
}

/** What each message past the allowance costs, in ringgit, unless the venue has its own. */
export function defaultMessagePrice(): number {
  const n = Number(process.env.MYSENAM_WHATSAPP_PRICE ?? 0.08);
  return Number.isFinite(n) && n >= 0 && n <= 5 ? n : 0.08;
}

/** YYYY-MM, Malaysia time. */
export function monthOf(now = new Date()): string {
  return new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 7);
}

/** The month before a YYYY-MM. */
export function monthBefore(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/**
 * A Malaysia-time month as the UTC `sent_at` strings it spans: from midnight
 * on the 1st (16:00 UTC the day before) up to, not including, the next 1st.
 */
export function monthBounds(month: string): [string, string] {
  const [y, m] = month.split("-").map(Number);
  const utc = (year: number, mon: number) =>
    new Date(Date.UTC(year, mon - 1, 1) - 8 * 3_600_000).toISOString().replace("T", " ").slice(0, 19);
  return [utc(y, m), m === 12 ? utc(y + 1, 1) : utc(y, m + 1)];
}

export interface Usage {
  venueId: number;
  month: string;
  /** Templates sent: what Meta charges for. */
  paid: number;
  /** Replies in a chat the customer opened: free. */
  free: number;
  included: number;
  unitPrice: number;
  /** Past the allowance, and what that comes to. */
  over: number;
  amount: number;
}

interface PlanRow {
  id: number;
  whatsapp_included: number | null;
  whatsapp_price: number | string | null;
}

function priced(row: PlanRow, month: string, paid: number, free: number): Usage {
  const included = row.whatsapp_included ?? defaultIncluded();
  const unitPrice = row.whatsapp_price === null ? defaultMessagePrice() : Number(row.whatsapp_price);
  const over = Math.max(0, paid - included);
  return { venueId: row.id, month, paid, free, included, unitPrice, over, amount: Math.round(over * unitPrice * 100) / 100 };
}

/** Each of these venues' use in a month (every venue's when none are named). */
export async function usageFor(month: string, venueIds?: number[]): Promise<Map<number, Usage>> {
  const out = new Map<number, Usage>();
  if (venueIds && venueIds.length === 0) return out;
  const [from, to] = monthBounds(month);
  const only = venueIds ? ` AND venue_id IN (${venueIds.map(() => "?").join(",")})` : "";
  const counts = (await getDb()
    .prepare(
      `SELECT venue_id, SUM(CASE WHEN free = 0 THEN 1 ELSE 0 END)::int AS paid, SUM(free)::int AS free
         FROM messages
        WHERE channel = 'whatsapp' AND status = 'sent' AND sent_at >= ? AND sent_at < ?${only}
        GROUP BY venue_id`
    )
    .all(from, to, ...(venueIds ?? []))) as { venue_id: number; paid: number; free: number }[];
  const byVenue = new Map(counts.map((c) => [c.venue_id, c]));
  const plans = (await getDb()
    .prepare(
      `SELECT id, whatsapp_included, whatsapp_price FROM venues${venueIds ? ` WHERE id IN (${venueIds.map(() => "?").join(",")})` : ""}`
    )
    .all(...(venueIds ?? []))) as PlanRow[];
  for (const p of plans) {
    const c = byVenue.get(p.id);
    out.set(p.id, priced(p, month, c?.paid ?? 0, c?.free ?? 0));
  }
  return out;
}

/** One venue's use in a month. */
export async function usageOf(venueId: number, month = monthOf()): Promise<Usage | null> {
  return (await usageFor(month, [venueId])).get(venueId) ?? null;
}
