import { createHash, randomInt } from "crypto";
import { getDb, isUniqueViolation, withTransaction } from "./db";
import { phoneKey } from "./phone";

/**
 * Participants: the people who take part, apart from the accounts that sign
 * in (ADR 0023; docs/architecture/privacy.md#participants).
 *
 * A user account is somebody who can sign in and act. A participant is the
 * person who actually takes part in a booking, a class, an induction or an
 * assessment, where that is somebody other than the account holder: a child
 * a parent books for, a person staff book for at the counter. The account
 * holder taking part as themself has no participant row: their account, its
 * number and its own records are them, as always. So "who took part" has one
 * answer: the booking's participants (`booking_participants`), or, where it
 * names none, its customer.
 *
 * Identity is the participant's id, never a name, a phone number or an email
 * address: two children share a parent's number, unrelated customers share a
 * number or change theirs. Nothing here ever merges people, or moves a
 * booking, sign-off, induction or waiver between them, on matching contact
 * details. Contact details on a guardian are there to reach them, nothing else.
 *
 * Who may act for a participant is a relationship (`participant_guardians`):
 * an account, or a guardian a venue recorded by name and number, with the
 * relationship and authority as declared (never verified) and how it was
 * established: online by the account holder, at a venue's counter to named
 * staff, or by staff after a review. A child can have two guardians; a
 * relationship is corrected or revoked with its history kept, and a revoked
 * one acts for nobody. A participant may later be linked to their own login,
 * by a procedure both sides agree to (a guardian hands over and the account
 * accepts) or by staff with a reason; nothing they had is lost, and that
 * account's eligibility includes theirs.
 *
 * Eligibility is the participant's own: a sign-off, an induction or a waiver
 * for them counts for them alone, never for a guardian, a sibling or the
 * number it was recorded on; and a guardian's never for them.
 *
 * Who sees a participant: their guardians (live relationships), their linked
 * account, and venues they have dealings with (created there, or a booking,
 * application, sign-off, induction or waiver there; the business's other
 * branches too, as sign-offs are shared) — never other venues, other
 * customers, opponents or coaches, and never discovery or matchmaking.
 */

export type Relationship = "parent" | "guardian" | "other";
export const RELATIONSHIPS: Relationship[] = ["parent", "guardian", "other"];
export type Provenance = "online" | "counter" | "staff_review";

export interface Participant {
  id: number;
  displayName: string;
  /** As declared; null where none was given. */
  birthYear: number | null;
  /** Added online by an account holder, or by a venue's staff. */
  origin: "account" | "venue";
  /** The venue that recorded it, for one a venue added. */
  venueId: number | null;
  /** Linked to the participant's own login. */
  linked: boolean;
  createdAt: string;
}

export type ParticipantRefusal = { ok: false; error: string; code: string; status: number; vars?: Record<string, string | number> };
export const refused = (code: string, error: string, status = 400, vars?: Record<string, string | number>): ParticipantRefusal => ({
  ok: false,
  error,
  code,
  status,
  ...(vars ? { vars } : {}),
});
export const isRefusal = (x: unknown): x is ParticipantRefusal => typeof x === "object" && x !== null && (x as ParticipantRefusal).ok === false;

export const iso = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));

export interface ParticipantRow {
  id: number;
  display_name: string;
  birth_year: number | null;
  origin: "account" | "venue";
  venue_id: number | null;
  linked_user_id: number | null;
  created_at: unknown;
}

export const toParticipant = (r: ParticipantRow): Participant => ({
  id: r.id,
  displayName: r.display_name,
  birthYear: r.birth_year,
  origin: r.origin,
  venueId: r.venue_id,
  linked: r.linked_user_id !== null && r.linked_user_id !== undefined,
  createdAt: iso(r.created_at) ?? "",
});

/** A name that is a name: not an email address or a phone number. */
export function readName(v: unknown): string | ParticipantRefusal {
  const name = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  if (name.length < 1 || name.length > 40 || name.includes("@") || (name.match(/\d/g) ?? []).length >= 5)
    return refused("GUARD_NAME_NEEDED", "Give a first name, or what the family calls them (up to 40 characters).");
  return name;
}

export function readBirthYear(v: unknown): number | null | ParticipantRefusal {
  if (v === undefined || v === null || v === "") return null;
  const year = Number(v);
  const now = new Date().getUTCFullYear();
  if (!Number.isInteger(year) || year > now || year < now - 120) return refused("GUARD_BIRTH_YEAR_BAD", "A birth year, as four digits, or leave it out.");
  return year;
}

export function readRelationship(v: unknown): Relationship | ParticipantRefusal {
  return RELATIONSHIPS.includes(v as Relationship)
    ? (v as Relationship)
    : refused("GUARD_RELATIONSHIP_NEEDED", "Say how you are related: parent, legal guardian, or another person with authority.");
}

const reasonOf = (v: unknown): string | null => {
  const r = typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, 300) : "";
  return r.length >= 5 ? r : null;
};

// ------------------------------------------------------------------ audit

/** Who did it: an account holder, staff (by name as it was), or the system. */
export type Actor = { userId: number; name?: string | null } | { adminId: number | null; name: string } | { system: true };

/** Write one entry in the participant's history: who, on whose behalf (the participant), where, what. */
export async function participantEvent(participantId: number, action: string, actor: Actor, opts: { venueId?: number | null; detail?: string | null } = {}): Promise<void> {
  await getDb()
    .prepare("INSERT INTO participant_events (participant_id, action, actor_user_id, actor_admin_id, actor_name, venue_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(
      participantId,
      action,
      "userId" in actor ? actor.userId : null,
      "adminId" in actor ? actor.adminId : null,
      "system" in actor ? "MySenam" : (actor.name ?? null),
      opts.venueId ?? null,
      opts.detail?.slice(0, 500) ?? null
    );
}

export interface ParticipantEvent {
  action: string;
  actorName: string | null;
  venueId: number | null;
  detail: string | null;
  at: string;
}

export async function participantHistory(participantId: number): Promise<ParticipantEvent[]> {
  const rows = (await getDb()
    .prepare("SELECT action, actor_name, venue_id, detail, created_at FROM participant_events WHERE participant_id = ? ORDER BY id")
    .all(participantId)) as { action: string; actor_name: string | null; venue_id: number | null; detail: string | null; created_at: unknown }[];
  return rows.map((r) => ({ action: r.action, actorName: r.actor_name, venueId: r.venue_id, detail: r.detail, at: iso(r.created_at) ?? "" }));
}

// ------------------------------------------------------------------ who may act

/** SQL: account `?` may act for participant `alias.id` now (a live relationship, not archived), or is their linked account. */
export const ACTS_FOR = (alias: string) =>
  `(${alias}.linked_user_id = ? OR EXISTS (SELECT 1 FROM participant_guardians g WHERE g.participant_id = ${alias}.id AND g.user_id = ? AND g.revoked_at IS NULL))`;

export interface Guardianship {
  id: number;
  participantId: number;
  userId: number | null;
  /** The account's name, or the name staff recorded. */
  name: string | null;
  relationship: Relationship;
  authorityDeclaredAt: string;
  provenance: Provenance;
  recordedBy: string | null;
  createdAt: string;
  archivedAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
}

interface GuardianRow {
  id: number;
  participant_id: number;
  user_id: number | null;
  account_name?: string | null;
  contact_name: string | null;
  contact_phone?: string | null;
  relationship: Relationship;
  authority_declared_at: unknown;
  provenance: Provenance;
  recorded_by_name: string | null;
  created_at: unknown;
  archived_at: unknown;
  revoked_at: unknown;
  revoke_reason: string | null;
}

const toGuardianship = (r: GuardianRow): Guardianship => ({
  id: r.id,
  participantId: r.participant_id,
  userId: r.user_id,
  name: r.account_name ?? r.contact_name ?? null,
  relationship: r.relationship,
  authorityDeclaredAt: iso(r.authority_declared_at) ?? "",
  provenance: r.provenance,
  recordedBy: r.recorded_by_name,
  createdAt: iso(r.created_at) ?? "",
  archivedAt: iso(r.archived_at),
  revokedAt: iso(r.revoked_at),
  revokeReason: r.revoke_reason,
});

/**
 * This account's relationship to a participant, not revoked (`live`: not
 * archived either), or null: every account-side use goes through here, so
 * nobody acts for a participant another adult manages, and a revoked
 * guardian acts for nobody.
 */
export async function guardianshipOf(
  userId: number,
  participantId: unknown,
  opts: { live?: boolean } = {}
): Promise<{ participant: Participant; guardianship: Guardianship } | null> {
  const n = Number(participantId);
  if (!Number.isInteger(n) || n <= 0) return null;
  const row = (await getDb()
    .prepare(
      `SELECT p.id, p.display_name, p.birth_year, p.origin, p.venue_id, p.linked_user_id, p.created_at,
              g.id AS g_id, g.user_id, g.relationship, g.authority_declared_at, g.provenance, g.recorded_by_name,
              g.created_at AS g_created_at, g.archived_at, g.revoked_at, g.revoke_reason
         FROM participants p JOIN participant_guardians g ON g.participant_id = p.id
        WHERE p.id = ? AND g.user_id = ? AND g.revoked_at IS NULL${opts.live ? " AND g.archived_at IS NULL" : ""}
        ORDER BY g.id DESC LIMIT 1`
    )
    .get(n, userId)) as (ParticipantRow & Omit<GuardianRow, "id" | "participant_id" | "contact_name" | "created_at"> & { g_id: number; g_created_at: unknown }) | undefined;
  if (!row) return null;
  return {
    participant: toParticipant(row),
    guardianship: toGuardianship({ ...row, id: row.g_id, participant_id: row.id, contact_name: null, created_at: row.g_created_at }),
  };
}

/** Everybody this account is guardian of (not revoked), with their own relationship to each; archived ones only when asked. */
export async function guardianshipsOf(userId: number, opts: { archived?: boolean } = {}): Promise<{ participant: Participant; guardianship: Guardianship; otherGuardians: number }[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT p.id, p.display_name, p.birth_year, p.origin, p.venue_id, p.linked_user_id, p.created_at,
              g.id AS g_id, g.user_id, g.relationship, g.authority_declared_at, g.provenance, g.recorded_by_name,
              g.created_at AS g_created_at, g.archived_at, g.revoked_at, g.revoke_reason,
              (SELECT COUNT(*)::int FROM participant_guardians o WHERE o.participant_id = p.id AND o.id <> g.id AND o.revoked_at IS NULL) AS others
         FROM participant_guardians g JOIN participants p ON p.id = g.participant_id
        WHERE g.user_id = ? AND g.revoked_at IS NULL${opts.archived ? "" : " AND g.archived_at IS NULL"}
        ORDER BY g.archived_at NULLS FIRST, p.id`
    )
    .all(userId)) as (ParticipantRow & Omit<GuardianRow, "id" | "participant_id" | "contact_name" | "created_at"> & { g_id: number; g_created_at: unknown; others: number })[];
  return rows.map((row) => ({
    participant: toParticipant(row),
    guardianship: toGuardianship({ ...row, id: row.g_id, participant_id: row.id, contact_name: null, created_at: row.g_created_at }),
    otherGuardians: row.others,
  }));
}

/** The participant this account is linked to as their own login, if any. */
export async function linkedParticipantOf(userId: number): Promise<Participant | null> {
  const row = (await getDb().prepare("SELECT * FROM participants WHERE linked_user_id = ?").get(userId)) as ParticipantRow | undefined;
  return row ? toParticipant(row) : null;
}

/** At most this many people one account manages at once (archived and revoked apart). */
export const MAX_MANAGED = 12;

async function liveCount(userId: number): Promise<number> {
  return ((await getDb()
    .prepare("SELECT COUNT(*)::int AS n FROM participant_guardians WHERE user_id = ? AND revoked_at IS NULL AND archived_at IS NULL")
    .get(userId)) as { n: number }).n;
}

export async function underLimit(userId: number): Promise<ParticipantRefusal | null> {
  return (await liveCount(userId)) >= MAX_MANAGED ? refused("GUARD_TOO_MANY", `Up to ${MAX_MANAGED} people on one account.`, 409, { n: MAX_MANAGED }) : null;
}

/**
 * A participant added online by an account holder, who declares the
 * relationship and their authority (its time recorded): the participant and
 * that relationship, together.
 */
export async function createForAccount(
  user: { id: number; name?: string | null },
  input: { displayName: string; birthYear: number | null; relationship: Relationship }
): Promise<Participant> {
  return withTransaction(async () => {
    const db = getDb();
    const row = (await db
      .prepare("INSERT INTO participants (display_name, birth_year, origin, created_by_user_id) VALUES (?, ?, 'account', ?) RETURNING *")
      .get(input.displayName, input.birthYear, user.id)) as ParticipantRow;
    await db
      .prepare("INSERT INTO participant_guardians (participant_id, user_id, relationship, authority_declared_at, provenance) VALUES (?, ?, ?, now(), 'online')")
      .run(row.id, user.id, input.relationship);
    await participantEvent(row.id, "participant.created", { userId: user.id, name: user.name }, { detail: `declared ${input.relationship} online` });
    return toParticipant(row);
  });
}

/**
 * A participant a venue's staff add, with the guardian who declared their
 * relationship and authority at the counter, named by contact details only
 * where they have no account (for the venue's staff to reach them; never
 * matched to anybody). Seen by that venue (and its business) and nobody
 * else, until a guardian's account is added or their own login linked.
 * For the counter and the venue's own system (ADR 0023).
 */
export async function createAtVenue(input: {
  venueId: number;
  admin: { id: number | null; name: string };
  displayName: unknown;
  birthYear?: unknown;
  guardian: { name: unknown; phone: unknown; relationship: unknown; authority: unknown };
  note?: unknown;
}): Promise<{ ok: true; participant: Participant; guardianshipId: number } | ParticipantRefusal> {
  const name = readName(input.displayName);
  if (isRefusal(name)) return name;
  const birthYear = readBirthYear(input.birthYear);
  if (isRefusal(birthYear)) return birthYear;
  const relationship = readRelationship(input.guardian.relationship);
  if (isRefusal(relationship)) return relationship;
  const guardianName = typeof input.guardian.name === "string" ? input.guardian.name.trim().replace(/\s+/g, " ") : "";
  if (guardianName.length < 2 || guardianName.length > 80) return refused("PTC_GUARDIAN_NAME", "Give the guardian's name.");
  const phone = typeof input.guardian.phone === "string" ? phoneKey(input.guardian.phone) : "";
  if (phone.length < 7) return refused("PTC_GUARDIAN_PHONE", "Give a number to reach the guardian on.");
  if (input.guardian.authority !== true)
    return refused("PTC_COUNTER_AUTHORITY", "Confirm the guardian declared to you that they are the parent, legal guardian or another person with authority to act for them.");
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 200) : null;
  return withTransaction(async () => {
    const db = getDb();
    const row = (await db
      .prepare("INSERT INTO participants (display_name, birth_year, origin, venue_id, created_by_admin_id) VALUES (?, ?, 'venue', ?, ?) RETURNING *")
      .get(name, birthYear, input.venueId, input.admin.id)) as ParticipantRow;
    const g = (await db
      .prepare(
        `INSERT INTO participant_guardians (participant_id, contact_name, contact_phone, relationship, authority_declared_at, provenance,
           recorded_by_admin_id, recorded_by_name, venue_id, note)
         VALUES (?, ?, ?, ?, now(), 'counter', ?, ?, ?, ?) RETURNING id`
      )
      .get(row.id, guardianName, phone, relationship, input.admin.id, input.admin.name, input.venueId, note)) as { id: number };
    await participantEvent(row.id, "participant.created", { adminId: input.admin.id, name: input.admin.name }, {
      venueId: input.venueId,
      detail: `at the counter; ${guardianName} declared ${relationship} to staff`,
    });
    return { ok: true as const, participant: toParticipant(row), guardianshipId: g.id };
  });
}

// ------------------------------------------------------------------ venues

/** SQL: the venues whose staff see what venue `?` sees: it, and its business's other branches. */
const SCOPE = `(SELECT v2.id FROM venues v2 WHERE v2.id = ? OR (v2.business_id IS NOT NULL AND v2.business_id = (SELECT v3.business_id FROM venues v3 WHERE v3.id = ?)))`;

/** SQL: participant `p` is known to venue `?` (seven times the venue's id, in order). */
const KNOWN_TO = `(p.venue_id IN ${SCOPE}
  OR EXISTS (SELECT 1 FROM booking_participants bp JOIN bookings b ON b.id = bp.booking_id JOIN courts c ON c.id = b.court_id
              WHERE bp.participant_id = p.id AND c.venue_id IN ${SCOPE})
  OR EXISTS (SELECT 1 FROM approval_requests r WHERE r.managed_person_id = p.id AND r.venue_id IN ${SCOPE})
  OR EXISTS (SELECT 1 FROM sign_offs s WHERE s.managed_person_id = p.id
              AND (s.venue_id IN ${SCOPE} OR s.business_id = (SELECT v4.business_id FROM venues v4 WHERE v4.id = ?)))
  OR EXISTS (SELECT 1 FROM inductions i WHERE i.participant_id = p.id AND i.venue_id IN ${SCOPE})
  OR EXISTS (SELECT 1 FROM waiver_signatures ws JOIN venue_waivers w ON w.id = ws.waiver_id
              WHERE ws.managed_person_id = p.id AND w.venue_id IN ${SCOPE}))`;
const knownArgs = (venueId: number) => [venueId, venueId, venueId, venueId, venueId, venueId, venueId, venueId, venueId, venueId, venueId, venueId, venueId];

/** May this venue's staff see (and act at the counter for) this participant? */
export async function visibleToVenue(venueId: number, participantId: number): Promise<boolean> {
  return !!(await getDb().prepare(`SELECT 1 FROM participants p WHERE p.id = ? AND ${KNOWN_TO}`).get(participantId, ...knownArgs(venueId)));
}

export interface VenueParticipant extends Participant {
  /** The guardians on the number asked about: name, declared relationship, how established. */
  guardians: { id: number; name: string; relationship: Relationship; provenance: Provenance; account: boolean }[];
  /** Their own induction here, in force. */
  inductionId: number | null;
}

/**
 * The participants a venue knows whose guardian is on this number (an
 * account's, or one staff recorded): candidates for staff to choose from at
 * the counter, never a match that decides anything by itself. Bounded to
 * the venue's own dealings, and to a number: no browsing.
 */
export async function participantsForVenue(venueId: number, phone: string): Promise<VenueParticipant[]> {
  const key = phoneKey(phone);
  if (key.length < 7) return [];
  const db = getDb();
  const rows = (await db
    .prepare(
      `SELECT DISTINCT p.* FROM participants p JOIN participant_guardians g ON g.participant_id = p.id AND g.revoked_at IS NULL
         LEFT JOIN users u ON u.id = g.user_id
        WHERE (phone_key(u.phone) = ? OR phone_key(g.contact_phone) = ?) AND ${KNOWN_TO}
        ORDER BY p.id LIMIT 30`
    )
    .all(key, key, ...knownArgs(venueId))) as ParticipantRow[];
  const out: VenueParticipant[] = [];
  for (const r of rows) {
    const guardians = (await db
      .prepare(
        `SELECT g.id, COALESCE(u.name, g.contact_name) AS name, g.relationship, g.provenance, g.user_id IS NOT NULL AS account
           FROM participant_guardians g LEFT JOIN users u ON u.id = g.user_id
          WHERE g.participant_id = ? AND g.revoked_at IS NULL AND (phone_key(u.phone) = ? OR phone_key(g.contact_phone) = ?) ORDER BY g.id`
      )
      .all(r.id, key, key)) as { id: number; name: string; relationship: Relationship; provenance: Provenance; account: boolean }[];
    const induction = (await db
      .prepare("SELECT id FROM inductions WHERE venue_id = ? AND participant_id = ? AND revoked_at IS NULL")
      .get(venueId, r.id)) as { id: number } | undefined;
    out.push({ ...toParticipant(r), guardians, inductionId: induction?.id ?? null });
  }
  return out;
}

/** One participant as this venue's staff may see them, or null. */
export async function participantAtVenue(venueId: number, participantId: unknown): Promise<Participant | null> {
  const n = Number(participantId);
  if (!Number.isInteger(n) || n <= 0) return null;
  const row = (await getDb().prepare(`SELECT p.* FROM participants p WHERE p.id = ? AND ${KNOWN_TO}`).get(n, ...knownArgs(venueId))) as ParticipantRow | undefined;
  return row ? toParticipant(row) : null;
}

// ------------------------------------------------------------------ relationships

/**
 * End a relationship for good, with who and why: that guardian makes no new
 * booking or application for the participant from now on. Nothing they made
 * is deleted. `by` the guardian themself (their own only), or a venue's
 * staff for a participant that venue knows, with a reason.
 */
export async function revokeGuardianship(
  guardianshipId: number,
  by: { userId: number; name?: string | null } | { venueId: number; participantId: number; admin: { id: number | null; name: string } },
  reason: unknown
): Promise<{ ok: true } | ParticipantRefusal> {
  const why = reasonOf(reason);
  const staff = "venueId" in by;
  if (staff && !why) return refused("PTC_REASON_NEEDED", "Say why, in a few words.");
  const done = await withTransaction(async (): Promise<{ ok: true; userId: number | null; participantId: number } | ParticipantRefusal> => {
    const db = getDb();
    const g = (await db.prepare("SELECT id, participant_id, user_id, relationship FROM participant_guardians WHERE id = ? AND revoked_at IS NULL FOR UPDATE").get(guardianshipId)) as
      | { id: number; participant_id: number; user_id: number | null; relationship: Relationship }
      | undefined;
    if (!g) return refused("PTC_NOT_FOUND", "No such relationship.", 404);
    if (!staff && g.user_id !== by.userId) return refused("GUARD_NOT_FOUND", "Not one of the people you manage.", 404);
    if (staff && (g.participant_id !== by.participantId || !(await visibleToVenue(by.venueId, g.participant_id)))) return refused("PTC_NOT_FOUND", "No such relationship.", 404);
    await db
      .prepare(
        `UPDATE participant_guardians SET revoked_at = now(), revoked_by_user_id = ?, revoked_by_admin_id = ?, revoked_by_name = ?, revoke_reason = ? WHERE id = ?`
      )
      .run(staff ? null : by.userId, staff ? by.admin.id : null, staff ? by.admin.name : (by.name ?? null), why ?? "Ended by the guardian", g.id);
    // Codes this guardian gave out and nobody used yet go with it.
    if (g.user_id !== null)
      await db
        .prepare("UPDATE participant_invites SET cancelled_at = now() WHERE participant_id = ? AND created_by_user_id = ? AND used_at IS NULL AND cancelled_at IS NULL")
        .run(g.participant_id, g.user_id);
    await participantEvent(g.participant_id, staff ? "guardian.revoked_by_staff" : "guardian.ended", staff ? { adminId: by.admin.id, name: by.admin.name } : { userId: by.userId, name: by.name }, {
      venueId: staff ? by.venueId : null,
      detail: `${g.relationship}${why ? `: ${why}` : ""}`,
    });
    return { ok: true as const, userId: g.user_id, participantId: g.participant_id };
  });
  if (!done.ok) return done;
  // Their applications for the participant still waiting are withdrawn: nothing new from them (lib/approvals.ts).
  if (done.userId !== null)
    await (await import("./approvals")).guardianEnded(done.userId, done.participantId, staff ? `revoked by ${by.admin.name}` : "ended by the guardian");
  return { ok: true };
}

// ------------------------------------------------------------------ handing over, a second guardian

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
/** How long a code stays good. */
export const INVITE_DAYS = 7;
const hashCode = (code: string) => createHash("sha256").update(code.toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex");

/**
 * A code this guardian gives somebody to accept: `guardian`, another adult
 * becoming a guardian too (they declare their own relationship and
 * authority); `link`, the participant's own login taking them over. Shown
 * once, kept only as a hash, good for a week; a new one replaces this
 * guardian's earlier unused one for the same purpose.
 */
export async function createInvite(
  user: { id: number; name?: string | null },
  participantId: unknown,
  purpose: unknown
): Promise<{ ok: true; code: string; expiresAt: string } | ParticipantRefusal> {
  if (purpose !== "guardian" && purpose !== "link") return refused("PTC_PURPOSE", "A code for another guardian, or for their own login.");
  const mine = await guardianshipOf(user.id, participantId, { live: true });
  if (!mine) return refused("GUARD_NOT_FOUND", "Not one of the people you manage.", 404);
  if (purpose === "link" && mine.participant.linked) return refused("PTC_ALREADY_LINKED", "They already have their own login linked.", 409);
  const code = Array.from({ length: 10 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  const shown = `${code.slice(0, 5)}-${code.slice(5)}`;
  return withTransaction(async () => {
    const db = getDb();
    await db
      .prepare("UPDATE participant_invites SET cancelled_at = now() WHERE participant_id = ? AND created_by_user_id = ? AND purpose = ? AND used_at IS NULL AND cancelled_at IS NULL")
      .run(mine.participant.id, user.id, purpose);
    const row = (await db
      .prepare(`INSERT INTO participant_invites (participant_id, purpose, code_hash, created_by_user_id, expires_at) VALUES (?, ?, ?, ?, now() + interval '${INVITE_DAYS} days') RETURNING expires_at`)
      .get(mine.participant.id, purpose, hashCode(code), user.id)) as { expires_at: unknown };
    await participantEvent(mine.participant.id, purpose === "link" ? "invite.link" : "invite.guardian", { userId: user.id, name: user.name });
    return { ok: true as const, code: shown, expiresAt: iso(row.expires_at) ?? "" };
  });
}

/**
 * Accept a code: as a guardian (with the relationship and authority this
 * account declares), or as the participant's own login. Refused when the
 * code is unknown, used, cancelled or out of date, or when whoever gave it no
 * longer acts for the participant.
 */
export async function acceptInvite(
  user: { id: number; name?: string | null },
  input: Record<string, unknown>
): Promise<{ ok: true; participant: Participant; as: "guardian" | "linked" } | ParticipantRefusal> {
  const code = typeof input.code === "string" ? input.code : "";
  if (code.replace(/[^A-Za-z0-9]/g, "").length !== 10) return refused("PTC_INVITE_INVALID", "That code is not one we know, or it has run out.", 404);
  const db = getDb();
  return withTransaction(async () => {
    const inv = (await db
      .prepare(
        `SELECT i.id, i.participant_id, i.purpose, i.created_by_user_id, u.name AS by_name FROM participant_invites i JOIN users u ON u.id = i.created_by_user_id
          WHERE i.code_hash = ? AND i.used_at IS NULL AND i.cancelled_at IS NULL AND i.expires_at > now() FOR UPDATE OF i`
      )
      .get(hashCode(code))) as { id: number; participant_id: number; purpose: "guardian" | "link"; created_by_user_id: number; by_name: string } | undefined;
    // Whoever gave it must still act for them.
    const giver = inv ? await guardianshipOf(inv.created_by_user_id, inv.participant_id, { live: true }) : null;
    if (!inv || !giver) return refused("PTC_INVITE_INVALID", "That code is not one we know, or it has run out.", 404);
    const p = giver.participant;
    const already = (await db
      .prepare("SELECT 1 FROM participant_guardians WHERE participant_id = ? AND user_id = ? AND revoked_at IS NULL")
      .get(p.id, user.id)) as unknown;
    const linkedTo = (await db.prepare("SELECT linked_user_id FROM participants WHERE id = ?").get(p.id)) as { linked_user_id: number | null };
    if (inv.purpose === "guardian") {
      if (already) return refused("PTC_ALREADY_GUARDIAN", "You already manage them.", 409);
      if (linkedTo.linked_user_id === user.id) return refused("PTC_LINK_SELF", "This is their own login: it cannot be their guardian too.", 409);
      const relationship = readRelationship(input.relationship);
      if (isRefusal(relationship)) return relationship;
      if (input.authority !== true)
        return refused("GUARD_AUTHORITY_NEEDED", "Confirm that you are their parent, legal guardian or another person with authority to act for them.");
      const limit = await underLimit(user.id);
      if (limit) return limit;
      await db
        .prepare("INSERT INTO participant_guardians (participant_id, user_id, relationship, authority_declared_at, provenance) VALUES (?, ?, ?, now(), 'online')")
        .run(p.id, user.id, relationship);
      await participantEvent(p.id, "guardian.added", { userId: user.id, name: user.name }, { detail: `declared ${relationship} online; code from ${inv.by_name}` });
    } else {
      if (already) return refused("PTC_LINK_SELF", "You manage them: their own login has to be somebody else's account.", 409);
      if (linkedTo.linked_user_id !== null) return refused("PTC_ALREADY_LINKED", "They already have their own login linked.", 409);
      if (await linkedParticipantOf(user.id)) return refused("PTC_ACCOUNT_LINKED", "This account is already linked to somebody's record.", 409);
      await db.prepare("UPDATE participants SET linked_user_id = ?, linked_at = now(), updated_at = now() WHERE id = ?").run(user.id, p.id);
      await participantEvent(p.id, "linked", { userId: user.id, name: user.name }, { detail: `own login accepted the code ${inv.by_name} gave` });
    }
    await db.prepare("UPDATE participant_invites SET used_at = now(), used_by_user_id = ? WHERE id = ?").run(user.id, inv.id);
    const row = (await db.prepare("SELECT * FROM participants WHERE id = ?").get(p.id)) as ParticipantRow;
    return { ok: true as const, participant: toParticipant(row), as: inv.purpose === "guardian" ? ("guardian" as const) : ("linked" as const) };
  });
}

/**
 * A venue's staff link a participant they know to the account named by its
 * email, with a reason (the person stood at the counter, the guardian
 * agreed): the participant's own login from now on. Audited; never done on
 * matching contact details.
 */
export async function linkByStaff(input: {
  venueId: number;
  participantId: number;
  email: unknown;
  admin: { id: number | null; name: string };
  reason: unknown;
}): Promise<{ ok: true; participant: Participant } | ParticipantRefusal> {
  const why = reasonOf(input.reason);
  if (!why) return refused("PTC_REASON_NEEDED", "Say why, in a few words.");
  const email = typeof input.email === "string" ? input.email.trim() : "";
  if (!email) return refused("PTC_EMAIL_NEEDED", "Give the email of their own account.");
  const db = getDb();
  return withTransaction(async () => {
    if (!(await visibleToVenue(input.venueId, input.participantId))) return refused("PTC_NOT_FOUND", "No such participant here.", 404);
    const account = (await db.prepare("SELECT id FROM users WHERE email = ?").get(email)) as { id: number } | undefined;
    if (!account) return refused("PTC_NO_ACCOUNT", "No account has that email.", 404);
    const p = (await db.prepare("SELECT linked_user_id FROM participants WHERE id = ? FOR UPDATE").get(input.participantId)) as { linked_user_id: number | null };
    if (p.linked_user_id !== null) return refused("PTC_ALREADY_LINKED", "They already have their own login linked.", 409);
    if (await linkedParticipantOf(account.id)) return refused("PTC_ACCOUNT_LINKED", "This account is already linked to somebody's record.", 409);
    if (await db.prepare("SELECT 1 FROM participant_guardians WHERE participant_id = ? AND user_id = ? AND revoked_at IS NULL").get(input.participantId, account.id))
      return refused("PTC_LINK_SELF", "That account manages them: their own login has to be somebody else's account.", 409);
    await db.prepare("UPDATE participants SET linked_user_id = ?, linked_at = now(), updated_at = now() WHERE id = ?").run(account.id, input.participantId);
    await participantEvent(input.participantId, "linked_by_staff", { adminId: input.admin.id, name: input.admin.name }, { venueId: input.venueId, detail: why });
    const row = (await db.prepare("SELECT * FROM participants WHERE id = ?").get(input.participantId)) as ParticipantRow;
    return { ok: true as const, participant: toParticipant(row) };
  });
}

/**
 * Another adult becomes a guardian of a participant this venue already
 * knows, on their own declaration of relationship and authority made in
 * person to the member of staff signed in (docs/features/venue-operations.md#a-second-guardian-at-the-counter):
 * the adult at the counter who is not yet a recorded guardian, instead of a
 * second record of the same child. Named by contact details (`name`,
 * `phone`: front desk or a manager), or by a MySenam account (`email`, with
 * a reason: a manager only, as the route decides, because an account then
 * reaches the participant online, which otherwise takes an existing
 * guardian's code). Provenance `counter`, the staff member and the venue
 * recorded; never `staff_review`, so an activity that asks for the adult's
 * authority to be reviewed (`guardianCheck`) still asks. A number typed in
 * makes nobody a guardian: only this declaration does. Nothing is merged,
 * moved or matched; the existing guardians stay as they are.
 */
export async function addGuardianAtVenue(input: {
  venueId: number;
  participantId: number;
  admin: { id: number | null; name: string };
  guardian: { name?: unknown; phone?: unknown; email?: unknown; relationship: unknown; authority: unknown };
  reason?: unknown;
  note?: unknown;
}): Promise<{ ok: true; guardianshipId: number; guardianName: string; account: boolean; otherGuardians: number } | ParticipantRefusal> {
  const relationship = readRelationship(input.guardian.relationship);
  if (isRefusal(relationship)) return relationship;
  const byAccount = input.guardian.email !== undefined && input.guardian.email !== null;
  let guardianName = "";
  let phone = "";
  let email = "";
  if (byAccount) {
    email = typeof input.guardian.email === "string" ? input.guardian.email.trim() : "";
    if (!email) return refused("PTC_GUARDIAN_EMAIL", "Give the email of the guardian's account.");
  } else {
    guardianName = typeof input.guardian.name === "string" ? input.guardian.name.trim().replace(/\s+/g, " ") : "";
    if (guardianName.length < 2 || guardianName.length > 80) return refused("PTC_GUARDIAN_NAME", "Give the guardian's name.");
    phone = typeof input.guardian.phone === "string" ? phoneKey(input.guardian.phone) : "";
    if (phone.length < 7) return refused("PTC_GUARDIAN_PHONE", "Give a number to reach the guardian on.");
  }
  if (input.guardian.authority !== true)
    return refused("PTC_COUNTER_AUTHORITY", "Confirm the guardian declared to you that they are the parent, legal guardian or another person with authority to act for them.");
  const why = reasonOf(input.reason);
  if (byAccount && !why) return refused("PTC_REASON_NEEDED", "Say why, in a few words.");
  const note = why ?? (typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 200) : null);
  const db = getDb();
  const added = withTransaction(async () => {
    if (!(await visibleToVenue(input.venueId, input.participantId))) return refused("PTC_NOT_FOUND", "No such participant here.", 404);
    // One change to who acts for them at a time: the record itself is written, so a counter
    // adding the same adult at the same moment waits, then reads again what this one added.
    const p = (await db
      .prepare("UPDATE participants SET updated_at = now() WHERE id = ? RETURNING id, display_name, linked_user_id")
      .get(input.participantId)) as { id: number; display_name: string; linked_user_id: number | null } | undefined;
    if (!p) return refused("PTC_NOT_FOUND", "No such participant here.", 404);
    let userId: number | null = null;
    if (byAccount) {
      const account = (await db.prepare("SELECT id, name FROM users WHERE email = ?").get(email)) as { id: number; name: string } | undefined;
      if (!account) return refused("PTC_NO_ACCOUNT", "No account has that email.", 404);
      if (p.linked_user_id === account.id) return refused("PTC_GUARDIAN_OWN_LOGIN", "That account is their own login: it cannot be their guardian too.", 409);
      if (await db.prepare("SELECT 1 FROM participant_guardians WHERE participant_id = ? AND user_id = ? AND revoked_at IS NULL").get(p.id, account.id))
        return refused("PTC_GUARDIAN_ALREADY", "That account already acts for them.", 409);
      const limit = await underLimit(account.id);
      if (limit) return limit;
      userId = account.id;
      guardianName = account.name;
    } else if (
      await db
        .prepare(
          `SELECT 1 FROM participant_guardians g LEFT JOIN users u ON u.id = g.user_id
            WHERE g.participant_id = ? AND g.revoked_at IS NULL AND (phone_key(u.phone) = ? OR phone_key(g.contact_phone) = ?)`
        )
        .get(p.id, phone, phone)
    )
      return refused("PTC_GUARDIAN_ON_NUMBER", "Somebody on this number already acts for them.", 409);
    const otherGuardians = ((await db
      .prepare("SELECT COUNT(*)::int AS n FROM participant_guardians WHERE participant_id = ? AND revoked_at IS NULL")
      .get(p.id)) as { n: number }).n;
    const g = (await db
      .prepare(
        `INSERT INTO participant_guardians (participant_id, user_id, contact_name, contact_phone, relationship, authority_declared_at, provenance,
           recorded_by_admin_id, recorded_by_name, venue_id, note)
         VALUES (?, ?, ?, ?, ?, now(), 'counter', ?, ?, ?, ?) RETURNING id`
      )
      .get(p.id, userId, userId === null ? guardianName : null, userId === null ? phone : null, relationship, input.admin.id, input.admin.name, input.venueId, note)) as {
      id: number;
    };
    await participantEvent(p.id, "guardian.added", { adminId: input.admin.id, name: input.admin.name }, {
      venueId: input.venueId,
      detail: `at the counter; ${guardianName}${userId !== null ? " (their account)" : ""} declared ${relationship} to staff${why ? `: ${why}` : ""}`,
    });
    return { ok: true as const, guardianshipId: g.id, guardianName, account: userId !== null, otherGuardians };
  });
  // The same account added twice at once: one relationship (uq_participant_guardians_live), the other refused.
  return added.catch((err) => {
    if (isUniqueViolation(err, "participant_guardians")) return refused("PTC_GUARDIAN_ALREADY", "That account already acts for them.", 409);
    throw err;
  });
}

// ------------------------------------------------------------------ bookings

/** SQL: booking `alias` is taken by its own customer: it names nobody else, or names them as taking a place too. */
export const CUSTOMER_TAKES_PART = (alias = "b") =>
  `(NOT EXISTS (SELECT 1 FROM booking_participants bpx WHERE bpx.booking_id = ${alias}.id AND bpx.takes_part_as = 'participant')
    OR EXISTS (SELECT 1 FROM booking_participants bpx WHERE bpx.booking_id = ${alias}.id AND bpx.takes_part_as = 'customer'))`;

/** SQL: participant `?` takes a place on booking `alias`. */
export const PARTICIPANT_TAKES_PART = (alias = "b") =>
  `EXISTS (SELECT 1 FROM booking_participants bpx WHERE bpx.booking_id = ${alias}.id AND bpx.participant_id = ?)`;

/** SQL: booking `alias` names somebody other than its customer. */
export const NAMES_PARTICIPANTS = (alias = "b") =>
  `EXISTS (SELECT 1 FROM booking_participants bpx WHERE bpx.booking_id = ${alias}.id AND bpx.takes_part_as = 'participant')`;

/** One person taking a place on a booking: a participant (by id; null once erased), or (`participant: null, customer: true`) its customer. */
export interface Place {
  customer: boolean;
  participantId: number | null;
  name: string | null;
}

/**
 * Who takes part in a booking: its participants, and its customer where they
 * take a place too; where it names nobody, its customer alone. The one
 * answer to "who took part".
 */
export async function bookingPlaces(bookingId: number): Promise<Place[]> {
  const rows = (await getDb()
    .prepare("SELECT takes_part_as, participant_id, name FROM booking_participants WHERE booking_id = ? ORDER BY id")
    .all(bookingId)) as { takes_part_as: "customer" | "participant"; participant_id: number | null; name: string | null }[];
  if (!rows.some((r) => r.takes_part_as === "participant")) return [{ customer: true, participantId: null, name: null }];
  return rows.map((r) => ({ customer: r.takes_part_as === "customer", participantId: r.participant_id, name: r.name }));
}

/**
 * Record who takes part on a booking just made, in its transaction: each
 * participant, and the customer where they take a place alongside them.
 * Nothing for a booking the customer takes alone.
 */
export async function placeParticipants(
  bookingId: number,
  input: { participants: { id: number; name: string }[]; customerTakesPart?: boolean; customerName: string; addedBy: { userId?: number | null; adminId?: number | null } }
): Promise<void> {
  if (input.participants.length === 0) return;
  const db = getDb();
  if (input.customerTakesPart)
    await db
      .prepare("INSERT INTO booking_participants (booking_id, takes_part_as, name, added_by_user_id, added_by_admin_id) VALUES (?, 'customer', ?, ?, ?)")
      .run(bookingId, input.customerName, input.addedBy.userId ?? null, input.addedBy.adminId ?? null);
  for (const p of input.participants)
    await db
      .prepare("INSERT INTO booking_participants (booking_id, takes_part_as, participant_id, name, added_by_user_id, added_by_admin_id) VALUES (?, 'participant', ?, ?, ?, ?)")
      .run(bookingId, p.id, p.name, input.addedBy.userId ?? null, input.addedBy.adminId ?? null);
}

// ------------------------------------------------------------------ inductions

/**
 * Has this participant been shown round here, and not since withdrawn? Their
 * own induction, or, once linked to their own login, that account's own (by
 * the number it proved). Never a guardian's, a sibling's, or the number the
 * participant's was recorded on.
 */
export async function participantInducted(venueId: number, participantId: number): Promise<boolean> {
  return !!(await getDb()
    .prepare(
      `SELECT 1 FROM inductions i WHERE i.venue_id = ? AND i.revoked_at IS NULL
          AND (i.participant_id = ?
               OR (NOT i.for_participant AND EXISTS (SELECT 1 FROM participants p JOIN users u ON u.id = p.linked_user_id
                                                      WHERE p.id = ? AND u.phone_verified_at IS NOT NULL AND phone_key(u.phone) = phone_key(i.phone))))
        LIMIT 1`
    )
    .get(venueId, participantId, participantId));
}

/**
 * Has the customer of a booking been shown round here, taking part as
 * themself? Their number's own induction (never one recorded for a
 * participant on it), or that of a participant linked to their account.
 */
export async function customerInducted(venueId: number, phone: string, userId: number | null): Promise<boolean> {
  return !!(await getDb()
    .prepare(
      `SELECT 1 FROM inductions i WHERE i.venue_id = ? AND i.revoked_at IS NULL
          AND ((NOT i.for_participant AND phone_key(i.phone) = phone_key(?))
               OR (i.participant_id IS NOT NULL AND i.participant_id IN (SELECT p.id FROM participants p WHERE p.linked_user_id = ?)))
        LIMIT 1`
    )
    .get(venueId, phone, userId ?? -1));
}

/** Is everybody taking part in this booking inducted here? Each by their own induction. */
export async function placesInducted(venueId: number, booking: { id: number; phone: string; userId?: number | null }): Promise<boolean> {
  for (const place of await bookingPlaces(booking.id)) {
    if (place.customer) {
      if (!(await customerInducted(venueId, booking.phone, booking.userId ?? null))) return false;
    } else if (place.participantId === null || !(await participantInducted(venueId, place.participantId))) return false;
  }
  return true;
}

/**
 * The audited way to give an existing number-keyed induction to the
 * participant it was really for, or (`participantId: null`) to confirm it is
 * the number holder's own, closing a review flag. Staff choose; the reason is
 * required and kept, with who and when, and the name it was filed under.
 * Bounded: one induction at a time, at this venue; only a participant this
 * venue knows whose guardian is on that number; never one already theirs.
 * Nothing here is ever done on matching contact details alone.
 */
export async function assignInduction(input: {
  venueId: number;
  inductionId: number;
  participantId: number | null;
  admin: { id: number | null; name: string };
  reason: unknown;
}): Promise<{ ok: true } | ParticipantRefusal> {
  const why = reasonOf(input.reason);
  if (!why) return refused("PTC_REASON_NEEDED", "Say why, in a few words.");
  const db = getDb();
  return withTransaction(async () => {
    const ind = (await db
      .prepare("SELECT id, phone, name, for_participant, revoked_at FROM inductions WHERE id = ? AND venue_id = ? FOR UPDATE")
      .get(input.inductionId, input.venueId)) as { id: number; phone: string; name: string; for_participant: boolean; revoked_at: string | null } | undefined;
    if (!ind) return refused("PTC_NOT_FOUND", "Induction not found.", 404);
    if (ind.for_participant) return refused("PTC_INDUCTION_TAKEN", "This induction is already a participant's.", 409);
    if (input.participantId === null) {
      await db
        .prepare("UPDATE inductions SET reviewed_at = now(), reviewed_by_admin_id = ?, reviewed_by_name = ?, review_note = ? WHERE id = ?")
        .run(input.admin.id, input.admin.name, `Kept as the number holder's: ${why}`, ind.id);
      return { ok: true as const };
    }
    const candidates = await participantsForVenue(input.venueId, ind.phone);
    const target = candidates.find((c) => c.id === input.participantId);
    if (!target) return refused("PTC_NOT_CANDIDATE", "Only somebody this venue knows, whose guardian is on this number, can be given it.", 409);
    if (target.inductionId !== null) return refused("PTC_ALREADY_INDUCTED", "They already have their own induction here.", 409);
    await db
      .prepare(
        `UPDATE inductions SET participant_id = ?, for_participant = true, assigned_from_name = name, name = ?,
           reviewed_at = now(), reviewed_by_admin_id = ?, reviewed_by_name = ?, review_note = ? WHERE id = ?`
      )
      .run(target.id, target.displayName, input.admin.id, input.admin.name, why, ind.id);
    await participantEvent(target.id, "induction.assigned", { adminId: input.admin.id, name: input.admin.name }, {
      venueId: input.venueId,
      detail: `induction ${ind.id} filed as ${ind.name} on their guardian's number: ${why}`,
    });
    return { ok: true as const };
  });
}

// ------------------------------------------------------------------ personal data

/**
 * A guardian's account is being erased (lib/privacy.ts eraseCustomer),
 * before the account goes: their relationships go with it. A participant who
 * still has another guardian (an account or one a venue recorded) or their
 * own linked login stays, with everything that is theirs; one left with
 * nobody, and no application resting on them, is erased: a sign-off or
 * induction in force for them is taken back first, and links from the
 * venue's records (bookings, sign-offs, waivers, inductions) are cleared,
 * those records staying as the venue's, counting for nobody.
 */
export async function eraseGuardian(userId: number): Promise<void> {
  const db = getDb();
  const mine = (await db.prepare("SELECT DISTINCT participant_id AS id FROM participant_guardians WHERE user_id = ?").all(userId)) as { id: number }[];
  const linked = (await db.prepare("SELECT id FROM participants WHERE linked_user_id = ?").all(userId)) as { id: number }[];
  await db.prepare("DELETE FROM participant_guardians WHERE user_id = ?").run(userId);
  await db.prepare("UPDATE participant_invites SET cancelled_at = now() WHERE created_by_user_id = ? AND used_at IS NULL AND cancelled_at IS NULL").run(userId);
  await db.prepare("UPDATE participants SET linked_user_id = NULL WHERE linked_user_id = ?").run(userId);
  for (const { id } of [...mine, ...linked]) {
    const kept = (await db
      .prepare(
        `SELECT 1 FROM participants p WHERE p.id = ? AND (p.linked_user_id IS NOT NULL
            OR EXISTS (SELECT 1 FROM participant_guardians g WHERE g.participant_id = p.id AND g.revoked_at IS NULL)
            OR EXISTS (SELECT 1 FROM approval_requests r WHERE r.managed_person_id = p.id))`
      )
      .get(id)) as unknown;
    if (kept) continue;
    await eraseParticipant(id, "Account closed");
  }
}

/** Erase one participant: what was in force for them taken back, the venue's records unlinked and kept, the record gone. */
export async function eraseParticipant(id: number, why: string): Promise<void> {
  const db = getDb();
  // In the erasure ledger, so a restore from an earlier backup erases them again (lib/erasure-ledger.ts).
  await (await import("./erasure-ledger")).recordParticipantErasure(id);
  await db.prepare("UPDATE sign_offs SET revoked_at = datetime('now'), revoke_reason = ? WHERE revoked_at IS NULL AND managed_person_id = ?").run(why, id);
  await db.prepare("UPDATE sign_offs SET managed_person_id = NULL WHERE managed_person_id = ?").run(id);
  await db.prepare("UPDATE inductions SET revoked_at = COALESCE(revoked_at, datetime('now')), participant_id = NULL WHERE participant_id = ?").run(id);
  await db.prepare("UPDATE booking_participants SET participant_id = NULL, name = NULL WHERE participant_id = ?").run(id);
  // A waiting-list entry for them is offered to nobody (lib/store.ts entryStillTheirs).
  await db.prepare("UPDATE waitlist_participants SET participant_id = NULL, name = NULL WHERE participant_id = ?").run(id);
  await db.prepare("UPDATE waiver_signatures SET managed_person_id = NULL WHERE managed_person_id = ?").run(id);
  await db.prepare("DELETE FROM participants WHERE id = ?").run(id);
}

/** What one participant's record holds, for an export: their sign-offs, inductions, places on bookings and waivers agreed for them. */
async function participantRecord(id: number): Promise<Record<string, unknown>> {
  const db = getDb();
  return {
    signOffs: await db
      .prepare(
        `SELECT COALESCE(v.name, b.name) AS venue, s.sport, s.kind, s.reference, s.expires_on, s.created_at, s.revoked_at, s.revoke_reason
           FROM sign_offs s LEFT JOIN venues v ON v.id = s.venue_id LEFT JOIN businesses b ON b.id = s.business_id
          WHERE s.managed_person_id = ? ORDER BY s.id`
      )
      .all(id),
    inductions: await db
      .prepare("SELECT v.name AS venue, i.created_at, i.revoked_at FROM inductions i JOIN venues v ON v.id = i.venue_id WHERE i.participant_id = ? ORDER BY i.id")
      .all(id),
    bookings: await db
      .prepare(
        `SELECT v.name AS venue, c.name AS court, bk.date, bk.start_min, bk.end_min, bk.status, ci.checked_in_at
           FROM booking_participants bp JOIN bookings bk ON bk.id = bp.booking_id JOIN courts c ON c.id = bk.court_id JOIN venues v ON v.id = c.venue_id
           LEFT JOIN check_ins ci ON ci.booking_id = bk.id
          WHERE bp.participant_id = ? ORDER BY bk.date DESC, bk.start_min DESC`
      )
      .all(id),
    waivers: await db
      .prepare(
        `SELECT v.name AS venue, s.name AS agreed_by, s.signed_at FROM waiver_signatures s JOIN venue_waivers w ON w.id = s.waiver_id JOIN venues v ON v.id = w.venue_id
          WHERE s.managed_person_id = ? ORDER BY s.signed_at`
      )
      .all(id),
  };
}

/**
 * For an account's export (lib/privacy.ts): the participants it manages (not
 * revoked), with what is held of each and their record; relationships it
 * ended, as the relationship alone; and, where the account is a participant's
 * own login, that participant's record, which is theirs.
 */
export async function participantsExport(userId: number): Promise<{ managed: unknown[]; ended: unknown[]; asParticipant: unknown | null }> {
  const db = getDb();
  const managed: unknown[] = [];
  for (const { participant: p, guardianship: g, otherGuardians } of await guardianshipsOf(userId, { archived: true }))
    managed.push({
      name: p.displayName,
      declaredBirthYear: p.birthYear,
      declaredRelationship: g.relationship,
      authorityDeclaredAt: g.authorityDeclaredAt,
      established: g.provenance,
      addedAt: g.createdAt,
      archivedAt: g.archivedAt,
      otherGuardians,
      ownLoginLinked: p.linked,
      ...(await participantRecord(p.id)),
    });
  const ended = await db
    .prepare("SELECT relationship, created_at, revoked_at, revoke_reason FROM participant_guardians WHERE user_id = ? AND revoked_at IS NOT NULL ORDER BY id")
    .all(userId);
  const own = await linkedParticipantOf(userId);
  return {
    managed,
    ended,
    asParticipant: own ? { name: own.displayName, declaredBirthYear: own.birthYear, linkedFrom: own.createdAt, ...(await participantRecord(own.id)) } : null,
  };
}

/**
 * SQL for the retention rule (lib/privacy.ts): a participant nobody acts for
 * any more and nothing rests on, once a year has passed. No account guardian
 * whose relationship is live or ended less than `days` ago; no linked login;
 * no application; no sign-off or induction in force; no booking in the last
 * `days` or to come; and, for one a venue added, made over `days` ago (the
 * one `?`).
 */
export function unusedParticipantsWhere(days: number): string {
  return `participants.linked_user_id IS NULL
      AND (participants.origin = 'account' OR participants.created_at < ?::timestamptz)
      AND NOT EXISTS (SELECT 1 FROM participant_guardians g WHERE g.participant_id = participants.id AND g.user_id IS NOT NULL
                       AND ((g.revoked_at IS NULL AND g.archived_at IS NULL) OR COALESCE(g.revoked_at, g.archived_at) > now() - interval '${days} days'))
      AND NOT EXISTS (SELECT 1 FROM approval_requests r WHERE r.managed_person_id = participants.id)
      AND NOT EXISTS (SELECT 1 FROM sign_offs s WHERE s.managed_person_id = participants.id AND s.revoked_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM inductions i WHERE i.participant_id = participants.id AND i.revoked_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM booking_participants bp JOIN bookings b ON b.id = bp.booking_id
                       WHERE bp.participant_id = participants.id AND b.status = 'confirmed' AND b.date >= to_char(now() - interval '${days} days', 'YYYY-MM-DD'))`;
}
