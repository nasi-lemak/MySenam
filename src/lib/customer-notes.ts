import { getDb, withTransaction } from "./db";
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
 *
 * It keeps its history (`customer_note_history`, migration 0314, ADR 0064): a row for every write, change and erase, appended in the
 * same transaction as the change, holding the text before and after, who and when. The history is the venue's staff's to read, as the
 * note is (`noteHistory`, the same venue check), goes out with the note to the customer who asks, and is erased with it.
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

/** Write it, or with an empty note take it away. Each change is also a row of the note's history, in the same transaction. */
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
  await withTransaction(async () => {
    const db = getDb();
    // One change at a time to one note, so each row of the history names the text it replaced and none is lost to a race.
    await db.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get(`customer-note:${venueId}:${key}`);
    const was = (await db.prepare("SELECT note FROM customer_notes WHERE venue_id = ? AND phone_key = ?").get(venueId, key)) as { note: string } | undefined;
    if (text === "" ? was === undefined : was?.note === text) return;
    const by = adminId === null ? null : ((await db.prepare("SELECT name FROM admins WHERE id = ?").get(adminId)) as { name: string } | undefined)?.name ?? null;
    if (text === "") await db.prepare("DELETE FROM customer_notes WHERE venue_id = ? AND phone_key = ?").run(venueId, key);
    else
      await db
        .prepare(
          `INSERT INTO customer_notes (venue_id, phone_key, note, updated_by, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
           ON CONFLICT (venue_id, phone_key) DO UPDATE SET note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
        )
        .run(venueId, key, text, adminId);
    await db
      .prepare(
        `INSERT INTO customer_note_history (venue_id, phone_key, action, previous_note, new_note, changed_by, changed_by_name) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(venueId, key, text === "" ? "erased" : was ? "edited" : "written", was?.note ?? null, text === "" ? null : text, adminId, by);
  });
  return { ok: true, note: text === "" ? null : await customerNote(venueId, phone) };
}

export interface NoteChange {
  action: "written" | "edited" | "erased" | "baseline";
  previous: string | null;
  note: string | null;
  changedBy: string | null;
  changedAt: string;
}

/** The note's changes, newest first: for the venue's own staff only (the caller has checked the venue, as for the note itself). */
export async function noteHistory(venueId: number, phone: string): Promise<NoteChange[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT action, previous_note, new_note, changed_by_name, changed_at FROM customer_note_history
        WHERE venue_id = ? AND phone_key = ? ORDER BY id DESC LIMIT 200`
    )
    .all(venueId, phoneKey(phone))) as { action: NoteChange["action"]; previous_note: string | null; new_note: string | null; changed_by_name: string | null; changed_at: unknown }[];
  return rows.map((r) => ({ action: r.action, previous: r.previous_note, note: r.new_note, changedBy: r.changed_by_name, changedAt: String(r.changed_at instanceof Date ? r.changed_at.toISOString() : r.changed_at) }));
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
