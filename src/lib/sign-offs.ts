import { getDb } from "./db";
import { isValidDateString, todayISO } from "./time";
import type { Sport } from "./types";

/**
 * Sign-offs and certifications (docs/features/activities.md#sign-offs): a
 * named member of staff has checked that this person may do this activity
 * without being taken through it — a belay check on a climbing wall, a range
 * briefing in archery, a gym induction, a paddling competence check — or has
 * seen a certification the activity legally needs. Where an activity's
 * booking rules ask for one (`signOff`, or `certification` for the latter
 * only), a customer without one cannot book it; a manager going past the
 * rules can, on record.
 *
 * A phone number typed into a form proves nothing, so online a sign-off is
 * honoured only for the customer's own account: the one staff linked it to,
 * or one that has proved it holds the number signed off
 * (docs/architecture/authentication.md). At the counter, and through the
 * venue's own API key, staff and the venue answer for who is in front of
 * them, and the number is enough.
 */

export type SignOffKind = "operational" | "certification";
/** Who is booking: the customer themselves online, the venue's staff, or the venue's own system. */
export type SignOffChannel = "customer" | "staff" | "api";

export interface SignOff {
  id: number;
  /** For one branch, or (businessId) every branch of a business. */
  venueId: number | null;
  businessId: number | null;
  /** null: anything there. */
  sport: Sport | null;
  phone: string;
  name: string;
  /** The customer's account it is for, where one is linked. */
  userId: number | null;
  /** For somebody that account's adult manages (lib/managed-people.ts): theirs alone, never the adult's. */
  managedPersonId: number | null;
  kind: SignOffKind;
  /** For a certification: what was seen (its number and who issued it). */
  reference: string | null;
  note: string | null;
  /** The last day it holds (inclusive); null: until taken back. */
  expiresOn: string | null;
  createdAt: string;
  /** Who gave it. */
  adminId: number | null;
  adminName: string | null;
  revokedAt: string | null;
  revokedBy: number | null;
  revokeReason: string | null;
}

interface Row {
  id: number;
  venue_id: number | null;
  business_id: number | null;
  sport: string | null;
  phone: string;
  name: string;
  user_id: number | null;
  managed_person_id?: number | null;
  kind: SignOffKind;
  reference: string | null;
  note: string | null;
  expires_on: string | null;
  created_at: string;
  admin_id: number | null;
  admin_name?: string | null;
  revoked_at: string | null;
  revoked_by: number | null;
  revoke_reason: string | null;
}

const toSignOff = (r: Row): SignOff => ({
  id: r.id,
  venueId: r.venue_id,
  businessId: r.business_id,
  sport: r.sport,
  phone: r.phone,
  name: r.name,
  userId: r.user_id,
  managedPersonId: r.managed_person_id ?? null,
  kind: r.kind,
  reference: r.reference,
  note: r.note,
  expiresOn: r.expires_on,
  createdAt: r.created_at,
  adminId: r.admin_id,
  adminName: r.admin_name ?? null,
  revokedAt: r.revoked_at,
  revokedBy: r.revoked_by,
  revokeReason: r.revoke_reason,
});

async function businessOf(venueId: number): Promise<number | null> {
  const row = (await getDb().prepare("SELECT business_id FROM venues WHERE id = ?").get(venueId)) as { business_id: number | null } | undefined;
  return row?.business_id ?? null;
}

/**
 * Does whoever is booking hold a sign-off (or, with `need: "certification"`,
 * a certification) for this activity at this venue, good until `until` (the
 * last day booked)?
 *
 * `participant`: the booking is for somebody the account's adult manages
 * (lib/managed-people.ts). Then only a sign-off written for that person
 * counts (online, one the adult's account holds for them); without it, only
 * the person's own, never one written for somebody they manage. A child's
 * eligibility never counts for the parent or a sibling, nor the parent's for
 * the child.
 */
export async function signOffHolds(input: {
  venueId: number;
  sport: Sport;
  until: string;
  phone: string;
  userId?: number | null;
  channel: SignOffChannel;
  need: "any" | "certification";
  participant?: number | null;
}): Promise<boolean> {
  // Online without an account there is nobody to hold one.
  if (input.channel === "customer" && !input.userId) return false;
  const business = await businessOf(input.venueId);
  const participant = input.participant ?? null;
  const who =
    participant !== null
      ? input.channel === "customer"
        ? `(s.managed_person_id = ? AND s.user_id = ? AND EXISTS (SELECT 1 FROM managed_people m WHERE m.id = s.managed_person_id AND m.user_id = ?))`
        : `s.managed_person_id = ?`
      : input.channel === "customer"
        ? `s.managed_person_id IS NULL AND (s.user_id = ? OR (s.user_id IS NULL AND EXISTS (
            SELECT 1 FROM users u WHERE u.id = ? AND u.phone_verified_at IS NOT NULL AND phone_key(u.phone) = phone_key(s.phone))))`
        : `s.managed_person_id IS NULL AND (phone_key(s.phone) = phone_key(?) OR s.user_id = ?)`;
  const whoArgs =
    participant !== null
      ? input.channel === "customer"
        ? [participant, input.userId, input.userId]
        : [participant]
      : input.channel === "customer"
        ? [input.userId, input.userId]
        : [input.phone, input.userId ?? -1];
  return !!(await getDb()
    .prepare(
      `SELECT 1 FROM sign_offs s
        WHERE (s.venue_id = ? OR (s.business_id IS NOT NULL AND s.business_id = ?))
          AND (s.sport = ? OR s.sport IS NULL)
          AND s.revoked_at IS NULL AND (s.expires_on IS NULL OR s.expires_on >= ?)
          AND (? = 'any' OR s.kind = 'certification')
          AND ${who}
        LIMIT 1`
    )
    .get(input.venueId, business ?? -1, input.sport, input.until, input.need, ...whoArgs));
}

/** Sign-offs in force at a venue (its own and its business's), newest first, with who gave them. */
export async function listSignOffs(venueId: number): Promise<SignOff[]> {
  const business = await businessOf(venueId);
  const rows = (await getDb()
    .prepare(
      `SELECT s.*, a.name AS admin_name FROM sign_offs s LEFT JOIN admins a ON a.id = s.admin_id
        WHERE (s.venue_id = ? OR (s.business_id IS NOT NULL AND s.business_id = ?))
          AND s.revoked_at IS NULL AND (s.expires_on IS NULL OR s.expires_on >= ?)
        ORDER BY s.id DESC LIMIT 500`
    )
    .all(venueId, business ?? -1, todayISO())) as Row[];
  return rows.map(toSignOff);
}

/**
 * Record a sign-off; one for the same number, activity, kind and scope is
 * replaced. Linked to the customer's account when staff name it by email, or
 * when an account has proved this number.
 */
export async function addSignOff(input: {
  venueId: number;
  /** For every branch of the venue's business, not this branch alone. */
  wholeBusiness?: boolean;
  sport: Sport | null;
  phone: string;
  name: string;
  email?: string | null;
  kind?: SignOffKind;
  reference?: string | null;
  note?: string | null;
  expiresOn?: string | null;
  adminId: number | null;
  /** For somebody the account named by `email` manages (lib/managed-people.ts): replaces only theirs. */
  managedPersonId?: number | null;
}): Promise<{ ok: true; signOff: SignOff } | { ok: false; error: string }> {
  const phone = input.phone.trim();
  const name = input.name.trim();
  const kind = input.kind ?? "operational";
  if (kind !== "operational" && kind !== "certification") return { ok: false, error: "A sign-off or a certification." };
  if (phone.replace(/\D/g, "").length < 6) return { ok: false, error: "Give their phone number." };
  if (name.length < 2) return { ok: false, error: "Give their name." };
  if (input.expiresOn && (!isValidDateString(input.expiresOn) || input.expiresOn < todayISO()))
    return { ok: false, error: "It runs out today or later, or never." };
  const reference = input.reference?.trim() ? input.reference.trim().slice(0, 120) : null;
  if (kind === "certification" && (!reference || !input.expiresOn))
    return { ok: false, error: "A certification needs what was seen (its number and issuer) and the day it runs out." };
  const note = input.note?.trim() ? input.note.trim().slice(0, 200) : null;
  const business = input.wholeBusiness ? await businessOf(input.venueId) : null;
  if (input.wholeBusiness && business === null) return { ok: false, error: "This venue is not part of a business." };
  const db = getDb();
  // The account it is for: named by email (staff were shown it), else the one that has proved this number.
  let userId: number | null = null;
  if (input.email?.trim()) {
    const named = (await db.prepare("SELECT id FROM users WHERE email = ?").get(input.email.trim())) as { id: number } | undefined;
    if (!named) return { ok: false, error: "No account has that email." };
    userId = named.id;
  } else {
    const proved = (await db
      .prepare("SELECT id FROM users WHERE phone_verified_at IS NOT NULL AND phone_key(phone) = phone_key(?) ORDER BY id LIMIT 1")
      .get(phone)) as { id: number } | undefined;
    userId = proved?.id ?? null;
  }
  const scope = business !== null ? { venue: null, business } : { venue: input.venueId, business: null };
  const managed = input.managedPersonId ?? null;
  if (managed !== null && userId === null) return { ok: false, error: "No account has that email." };
  return db.transaction(async () => {
    await db
      .prepare(
        `UPDATE sign_offs SET revoked_at = datetime('now'), revoked_by = ?, revoke_reason = 'Replaced'
          WHERE COALESCE(venue_id, 0) = COALESCE(?, 0) AND COALESCE(business_id, 0) = COALESCE(?, 0)
            AND phone_key(phone) = phone_key(?) AND COALESCE(sport, '') = COALESCE(?, '') AND kind = ? AND revoked_at IS NULL
            AND managed_person_id IS NOT DISTINCT FROM ?`
      )
      .run(input.adminId, scope.venue, scope.business, phone, input.sport, kind, managed);
    const row = (await db
      .prepare(
        `INSERT INTO sign_offs (venue_id, business_id, sport, phone, name, user_id, kind, reference, admin_id, note, expires_on, managed_person_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
      )
      .get(scope.venue, scope.business, input.sport, phone, name, userId, kind, reference, input.adminId, note, input.expiresOn ?? null, managed)) as Row;
    return { ok: true as const, signOff: toSignOff(row) };
  })();
}

/** Take one back, saying who and why: from now on that person books it through staff again. */
export async function revokeSignOff(
  venueId: number,
  id: number,
  by: { adminId: number | null; reason?: string | null; wholeBusiness?: boolean }
): Promise<boolean> {
  const business = await businessOf(venueId);
  const done = await getDb()
    .prepare(
      `UPDATE sign_offs SET revoked_at = datetime('now'), revoked_by = ?, revoke_reason = ?
        WHERE id = ? AND revoked_at IS NULL AND (venue_id = ? OR (? AND business_id IS NOT NULL AND business_id = ?))`
    )
    .run(by.adminId, by.reason?.trim() ? by.reason.trim().slice(0, 200) : null, id, venueId, by.wholeBusiness === true, business ?? -1);
  return done.changes > 0;
}

/** One sign-off by id, where this venue can see it. */
export async function signOffAt(venueId: number, id: number): Promise<SignOff | null> {
  const business = await businessOf(venueId);
  const row = (await getDb()
    .prepare(
      `SELECT s.*, a.name AS admin_name FROM sign_offs s LEFT JOIN admins a ON a.id = s.admin_id
        WHERE s.id = ? AND (s.venue_id = ? OR (s.business_id IS NOT NULL AND s.business_id = ?))`
    )
    .get(id, venueId, business ?? -1)) as Row | undefined;
  return row ? toSignOff(row) : null;
}
