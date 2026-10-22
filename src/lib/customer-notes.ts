import { getDb } from "./db";
import { phoneKey } from "./phone";

/**
 * A note the venue's staff keep about a customer, by phone number: "prefers
 * Court 3", "pays by transfer", "bring the ramp out". One per number per
 * venue, shown on each of their bookings, changed by whoever is at the desk.
 *
 * It is personal data like any other: it goes out with what the venue holds
 * against the number, and with the customer's own data when they ask for it,
 * and it is removed when they erase their account. So staff are told, where
 * they write it, that the customer may read it.
 */

export const MAX_NOTE = 500;

export interface CustomerNote {
  note: string;
  updatedAt: string;
  updatedBy: string | null;
}

export async function customerNote(venueId: number, phone: string): Promise<CustomerNote | null> {
  const row = (await getDb()
    .prepare(
      `SELECT n.note, n.updated_at, a.name AS author FROM customer_notes n LEFT JOIN admins a ON a.id = n.updated_by
        WHERE n.venue_id = ? AND n.phone_key = ?`
    )
    .get(venueId, phoneKey(phone))) as { note: string; updated_at: string; author: string | null } | undefined;
  return row ? { note: row.note, updatedAt: row.updated_at, updatedBy: row.author } : null;
}

/** Write it, or with an empty note take it away. */
export async function setCustomerNote(
  venueId: number,
  phone: string,
  note: unknown,
  adminId: number | null
): Promise<{ ok: true; note: CustomerNote | null } | { ok: false; error: string }> {
  const key = phoneKey(phone);
  if (key.length < 7) return { ok: false, error: "Give the customer's phone number." };
  if (typeof note !== "string") return { ok: false, error: "Write the note." };
  const text = note.trim();
  if (text.length > MAX_NOTE) return { ok: false, error: `Up to ${MAX_NOTE} characters.` };
  const db = getDb();
  if (text === "") {
    await db.prepare("DELETE FROM customer_notes WHERE venue_id = ? AND phone_key = ?").run(venueId, key);
    return { ok: true, note: null };
  }
  await db
    .prepare(
      `INSERT INTO customer_notes (venue_id, phone_key, note, updated_by, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT (venue_id, phone_key) DO UPDATE SET note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
    )
    .run(venueId, key, text, adminId);
  return { ok: true, note: await customerNote(venueId, phone) };
}

/** The notes for these numbers at these venues, by `venueId:phoneKey`: one query for a day's list. */
export async function notesFor(pairs: { venueId: number; phone: string }[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (pairs.length === 0) return found;
  const venues = [...new Set(pairs.map((p) => p.venueId))];
  const keys = [...new Set(pairs.map((p) => phoneKey(p.phone)))];
  const rows = (await getDb()
    .prepare(
      `SELECT venue_id, phone_key, note FROM customer_notes
        WHERE venue_id IN (${venues.map(() => "?").join(",")}) AND phone_key IN (${keys.map(() => "?").join(",")})`
    )
    .all(...venues, ...keys)) as { venue_id: number; phone_key: string; note: string }[];
  for (const r of rows) found.set(`${r.venue_id}:${r.phone_key}`, r.note);
  return found;
}
