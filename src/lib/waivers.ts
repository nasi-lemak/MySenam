import { getDb } from "./db";
import { errorText, translator } from "./i18n";
import { phoneKey } from "./phone";
import type { Refusal } from "./types";

/**
 * A venue's waiver: what a customer agrees to before they play, for a
 * climbing wall, a gym floor, kayaks on a lake, or a court that wants it.
 *
 * The venue writes it; the booking form shows a box to tick, with the waiver
 * a click away, and the booking is refused until it is ticked. What is kept is
 * the agreement: which version, by which number, in whose name, and when, so
 * it is asked once per person until the venue changes the words. Changing
 * them is a new version that everybody agrees to afresh. Staff see on each
 * booking whether it is signed, and can record one signed on paper.
 *
 * A signature is the venue's record of consent, so it is kept when a customer
 * erases their account (like the money on their bookings), and goes out with
 * their data when they ask.
 *
 * An adult may agree on behalf of a participant they act for (lib/participants.ts):
 * the adult signs (their name and number), the person takes part, and that
 * agreement is the person's alone, apart from the adult's own.
 */

export const MAX_WAIVER = 8000;

export interface Waiver {
  id: number;
  venueId: number;
  text: string;
  createdAt: string;
}

export interface WaiverSignature {
  name: string;
  signedAt: string;
  /** Staff who recorded one signed on paper; null when the customer ticked it. */
  recordedBy: string | null;
}

/** The waiver in force at a venue, or null when it asks for none. */
export async function currentWaiver(venueId: number): Promise<Waiver | null> {
  const row = (await getDb()
    .prepare("SELECT id, venue_id, text, created_at FROM venue_waivers WHERE venue_id = ? AND retired_at IS NULL ORDER BY id DESC LIMIT 1")
    .get(venueId)) as { id: number; venue_id: number; text: string; created_at: string } | undefined;
  return row ? { id: row.id, venueId: row.venue_id, text: row.text, createdAt: row.created_at } : null;
}

/**
 * New words, which everybody agrees to afresh; the same words change nothing.
 * Empty: no waiver from now on.
 */
export async function setWaiver(venueId: number, text: unknown): Promise<{ ok: true; waiver: Waiver | null } | { ok: false; error: string }> {
  if (typeof text !== "string") return { ok: false, error: "Write the waiver, or leave it empty for none." };
  const words = text.trim();
  if (words.length > MAX_WAIVER) return { ok: false, error: `Up to ${MAX_WAIVER} characters.` };
  if (words !== "" && words.length < 40) return { ok: false, error: "That is too short to be a waiver." };
  const now = await currentWaiver(venueId);
  if (now && now.text === words) return { ok: true, waiver: now };
  const db = getDb();
  await db.prepare("UPDATE venue_waivers SET retired_at = datetime('now') WHERE venue_id = ? AND retired_at IS NULL").run(venueId);
  if (words === "") return { ok: true, waiver: null };
  await db.prepare("INSERT INTO venue_waivers (venue_id, text) VALUES (?, ?)").run(venueId, words);
  return { ok: true, waiver: await currentWaiver(venueId) };
}

/** Has this number agreed to the venue's waiver as it stands, for themselves? True where there is none. */
export async function waiverSigned(venueId: number, phone: string): Promise<boolean> {
  const waiver = await currentWaiver(venueId);
  if (!waiver) return true;
  return !!(await getDb()
    .prepare("SELECT 1 FROM waiver_signatures WHERE waiver_id = ? AND phone_key = ? AND participant_name IS NULL")
    .get(waiver.id, phoneKey(phone)));
}

/**
 * Has the venue's waiver as it stands been agreed for this participant
 * (lib/participants.ts): by a guardian on their behalf, or, once linked to
 * their own login, by that account for itself? Never a guardian's own
 * agreement or a sibling's. True where there is none.
 */
export async function waiverSignedFor(venueId: number, managedPersonId: number): Promise<boolean> {
  const waiver = await currentWaiver(venueId);
  if (!waiver) return true;
  return !!(await getDb()
    .prepare(
      `SELECT 1 FROM waiver_signatures s WHERE s.waiver_id = ? AND (s.managed_person_id = ?
          OR (s.participant_name IS NULL AND s.phone_key = (SELECT phone_key(u.phone) FROM participants p JOIN users u ON u.id = p.linked_user_id
                                                             WHERE p.id = ? AND u.phone_verified_at IS NOT NULL)))`
    )
    .get(waiver.id, managedPersonId, managedPersonId));
}

/**
 * Record an agreement to the waiver in force: by the customer ticking it, or
 * by staff from paper. With `participant`, the customer (the adult signing)
 * agrees on behalf of somebody they manage.
 */
export async function signWaiver(
  venueId: number,
  input: { phone: string; name: string; bookingId?: number | null; adminId?: number | null; participant?: { id: number; name: string } | null }
): Promise<boolean> {
  const waiver = await currentWaiver(venueId);
  if (!waiver) return false;
  if (input.participant) {
    await getDb()
      .prepare(
        `INSERT INTO waiver_signatures (waiver_id, phone_key, name, booking_id, recorded_by, managed_person_id, participant_name) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (waiver_id, managed_person_id) WHERE managed_person_id IS NOT NULL DO NOTHING`
      )
      .run(
        waiver.id, phoneKey(input.phone), input.name.trim().slice(0, 80), input.bookingId ?? null, input.adminId ?? null,
        input.participant.id, input.participant.name.trim().slice(0, 80)
      );
    return true;
  }
  await getDb()
    .prepare(
      `INSERT INTO waiver_signatures (waiver_id, phone_key, name, booking_id, recorded_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (waiver_id, phone_key) WHERE participant_name IS NULL DO NOTHING`
    )
    .run(waiver.id, phoneKey(input.phone), input.name.trim().slice(0, 80), input.bookingId ?? null, input.adminId ?? null);
  return true;
}

/**
 * Which of these numbers have signed each venue's waiver, by `venueId:phoneKey`;
 * venues with none count as signed. A pair with `participant` asks about an
 * agreement on behalf of somebody managed, keyed `venueId:p<id>`.
 */
export async function signaturesFor(pairs: { venueId: number; phone: string; participant?: number | null }[]): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  if (pairs.length === 0) return result;
  const venues = [...new Set(pairs.map((p) => p.venueId))];
  const rows = (await getDb()
    .prepare(
      `SELECT w.venue_id, s.phone_key, s.managed_person_id, s.participant_name FROM venue_waivers w LEFT JOIN waiver_signatures s ON s.waiver_id = w.id
        WHERE w.retired_at IS NULL AND w.venue_id IN (${venues.map(() => "?").join(",")})`
    )
    .all(...venues)) as { venue_id: number; phone_key: string | null; managed_person_id: number | null; participant_name: string | null }[];
  const asks = new Set(rows.map((r) => r.venue_id));
  const signed = new Set(
    rows
      .filter((r) => r.phone_key)
      .map((r) => (r.participant_name === null ? `${r.venue_id}:${r.phone_key}` : r.managed_person_id !== null ? `${r.venue_id}:p${r.managed_person_id}` : ""))
  );
  for (const p of pairs) {
    const key = p.participant ? `${p.venueId}:p${p.participant}` : `${p.venueId}:${phoneKey(p.phone)}`;
    result.set(key, !asks.has(p.venueId) || signed.has(key));
  }
  return result;
}

/**
 * For a booking or enrolment from the venue's page: refused until the box is
 * ticked, where the venue has a waiver this number has not agreed to.
 */
export async function waiverRefusal(venueId: number, phone: string, agreed: unknown, participant?: number | null): Promise<Refusal | null> {
  if (agreed === true || (participant ? await waiverSignedFor(venueId, participant) : await waiverSigned(venueId, phone))) return null;
  return { ok: false, error: errorText(translator("en"), "WAIVER_NEEDED"), code: "WAIVER_NEEDED" };
}
