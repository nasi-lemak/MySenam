import { getDb } from "./db";

/**
 * WhatsApp messages a venue's customers were sent, counted by month, for the
 * venue to see what its credit went on (lib/whatsapp-credit.ts). Templates
 * and replies in a chat the customer opened are counted apart. Email is not
 * counted, and neither are the codes that check a customer's phone number,
 * which are the platform's own cost.
 */

/** YYYY-MM, Malaysia time. */
export function monthOf(now = new Date()): string {
  return new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 7);
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
  /** Templates sent. */
  paid: number;
  /** Replies in a chat the customer opened. */
  free: number;
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
  for (const c of counts) out.set(c.venue_id, { venueId: c.venue_id, month, paid: c.paid, free: c.free });
  for (const id of venueIds ?? []) if (!out.has(id)) out.set(id, { venueId: id, month, paid: 0, free: 0 });
  return out;
}

/** One venue's use in a month. */
export async function usageOf(venueId: number, month = monthOf()): Promise<Usage> {
  return (await usageFor(month, [venueId])).get(venueId)!;
}
