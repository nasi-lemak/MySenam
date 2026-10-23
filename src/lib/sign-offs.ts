import { getDb } from "./db";
import { isValidDateString, todayISO } from "./time";
import type { Sport } from "./types";

/**
 * Staff sign-offs (ADR 0011): somebody at the venue has checked that this
 * person may do this activity here without being taken through it — a belay
 * check on a climbing wall, a range briefing in archery, a gym induction, a
 * paddling competence check. Where an activity's booking rules ask for one
 * (`signOff`, lib/booking-rules.ts), a customer without one cannot book it;
 * staff going past the rules can. One rule for every activity that needs it,
 * rather than a check of its own for each.
 */

export interface SignOff {
  id: number;
  venueId: number;
  /** null: anything at the venue. */
  sport: Sport | null;
  phone: string;
  name: string;
  note: string | null;
  /** The last day it holds (inclusive); null: until taken back. */
  expiresOn: string | null;
  createdAt: string;
}

interface Row {
  id: number;
  venue_id: number;
  sport: string | null;
  phone: string;
  name: string;
  note: string | null;
  expires_on: string | null;
  created_at: string;
}

const toSignOff = (r: Row): SignOff => ({
  id: r.id,
  venueId: r.venue_id,
  sport: r.sport,
  phone: r.phone,
  name: r.name,
  note: r.note,
  expiresOn: r.expires_on,
  createdAt: r.created_at,
});

/** Does this number hold a sign-off for this activity at this venue on this date? */
export async function hasSignOff(venueId: number, phone: string, sport: Sport, date: string): Promise<boolean> {
  return !!(await getDb()
    .prepare(
      `SELECT 1 FROM sign_offs
        WHERE venue_id = ? AND phone_key(phone) = phone_key(?) AND (sport = ? OR sport IS NULL)
          AND revoked_at IS NULL AND (expires_on IS NULL OR expires_on >= ?)
        LIMIT 1`
    )
    .get(venueId, phone, sport, date));
}

/** The venue's sign-offs still in force, newest first. */
export async function listSignOffs(venueId: number): Promise<SignOff[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT * FROM sign_offs WHERE venue_id = ? AND revoked_at IS NULL AND (expires_on IS NULL OR expires_on >= ?)
        ORDER BY id DESC LIMIT 500`
    )
    .all(venueId, todayISO())) as Row[];
  return rows.map(toSignOff);
}

/** Record a sign-off; one for the same number and activity is replaced. */
export async function addSignOff(input: {
  venueId: number;
  sport: Sport | null;
  phone: string;
  name: string;
  note?: string | null;
  expiresOn?: string | null;
  adminId: number | null;
}): Promise<{ ok: true; signOff: SignOff } | { ok: false; error: string }> {
  const phone = input.phone.trim();
  const name = input.name.trim();
  if (phone.replace(/\D/g, "").length < 6) return { ok: false, error: "Give their phone number." };
  if (name.length < 2) return { ok: false, error: "Give their name." };
  if (input.expiresOn && (!isValidDateString(input.expiresOn) || input.expiresOn < todayISO()))
    return { ok: false, error: "It runs out today or later, or never." };
  const note = input.note?.trim() ? input.note.trim().slice(0, 200) : null;
  const db = getDb();
  return db.transaction(async () => {
    await db
      .prepare(
        `UPDATE sign_offs SET revoked_at = datetime('now')
          WHERE venue_id = ? AND phone_key(phone) = phone_key(?) AND COALESCE(sport, '') = COALESCE(?, '') AND revoked_at IS NULL`
      )
      .run(input.venueId, phone, input.sport);
    const row = (await db
      .prepare(
        `INSERT INTO sign_offs (venue_id, sport, phone, name, admin_id, note, expires_on) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`
      )
      .get(input.venueId, input.sport, phone, name, input.adminId, note, input.expiresOn ?? null)) as Row;
    return { ok: true as const, signOff: toSignOff(row) };
  })();
}

/** Take a sign-off back: from now on that person books it through staff again. */
export async function revokeSignOff(venueId: number, id: number): Promise<boolean> {
  const done = await getDb()
    .prepare("UPDATE sign_offs SET revoked_at = datetime('now') WHERE id = ? AND venue_id = ? AND revoked_at IS NULL")
    .run(id, venueId);
  return done.changes > 0;
}
