import { getDb, isUniqueViolation, withTransaction } from "./db";
import { translator } from "./i18n";
import { accountLocale, baseUrl, enqueue } from "./outbox";
import {
  INVITE_DAYS,
  OPEN_INVITE,
  guardianshipOf,
  iso,
  isRefusal,
  newInviteCode,
  participantEvent,
  participantForStaff,
  readRelationship,
  refused,
  toParticipant,
  underLimit,
  type Actor,
  type ParticipantRow,
  type OpenInvite,
  type Participant,
  type ParticipantRefusal,
  type Relationship,
} from "./participants";
import { siteName } from "./site";
import { venueBaseUrl } from "./storefront";
import { addDays, installZone, todayISO } from "./time";
import { venueZoneOf } from "./zones";

/**
 * Another guardian by verified consent (ADR 0023, amended 27 October 2026;
 * docs/features/venue-operations.md#another-guardian-by-invitation;
 * docs/architecture/privacy.md#participants).
 *
 * Nobody becomes a guardian of a participant on a name and a number typed in
 * by staff: a phone number proves control of a number, not parental
 * authority. Another guardian is a request (`guardian_requests`), in steps:
 *
 * 1. Somebody authorised starts it: a guardian of the participant (their
 *    code, lib/participants.ts createInvite: starting it is their agreement),
 *    or a venue's staff, front desk or manager, for a participant the venue
 *    knows (`requestAtVenue`), naming the adult, and optionally their
 *    account by its email so that only it may accept.
 * 2. The proposed guardian is invited with a single-use code (hashed, a
 *    week) and accepts it signed in to their own MySenam account, declaring
 *    their own relationship and authority: the relationship binds to an
 *    account that proved itself by signing in, never to a typed number.
 * 3. For a request staff started, an existing guardian with an account
 *    agrees online (`answerRequest`), or a manager (or the platform owner)
 *    records a narrow exception (`recordException`: a category, a reason, a
 *    date to look at it again), for a custody dispute, a guardian who cannot
 *    be reached or has no account, or another safeguarding circumstance.
 *    An exception is recorded as one, never as proof of legal guardianship,
 *    and the relationship it makes is flagged for review.
 * 4. Only then is a relationship made (`participant_guardians`, provenance
 *    `online`: the adult's own declaration online).
 * 5. The participant's other guardians with an account are told by email
 *    (`notifyGuardianChange`), unless the exception requires them not to
 *    be; a failure to tell them undoes nothing.
 * 6. A guardian who reports it as a mistake (`reportMistake`) flags it for a
 *    manager, who keeps it, pauses it (`suspendGuardian`) or revokes it.
 *
 * A request grants nothing until then: no booking, no application, no
 * status, no participant record, no export entry beyond "a request is
 * pending". Who started, accepted, agreed, made the exception, refused,
 * cancelled, paused and revoked is kept, on the request, the relationship
 * and in the participant's history.
 */

export type RequestStatus = "invited" | "awaiting_consent" | "active" | "rejected" | "cancelled";
export const EXCEPTION_CATEGORIES = ["custody_dispute", "guardian_unavailable", "safeguarding"] as const;
export type ExceptionCategory = (typeof EXCEPTION_CATEGORIES)[number];

/** Staff acting: a venue's (for a participant it knows), or the platform owner's (any participant). */
export type StaffScope = { venueId: number } | { owner: true };
export type StaffActor = { id: number | null; name: string };
type Change = "added" | "ended" | "request";

const venueOf = (scope: StaffScope): number | null => ("venueId" in scope ? scope.venueId : null);

const reasonOf = (v: unknown): string | null => {
  const r = typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, 300) : "";
  return r.length >= 5 ? r : null;
};

interface RequestRow {
  id: number;
  participant_id: number;
  status: RequestStatus;
  initiated_as: "guardian" | "staff";
  initiated_by_user_id: number | null;
  initiated_by_name: string;
  venue_id: number | null;
  proposed_name: string | null;
  proposed_user_id: number | null;
  accepted_by_user_id: number | null;
  relationship: Relationship | null;
  consented_by_name: string | null;
  consented_at: unknown;
  exception_category: ExceptionCategory | null;
  exception_reason: string | null;
  exception_review_on: string | null;
  exception_by_name: string | null;
  suppress_notice: boolean;
}

/** One change to who acts for a participant at a time: the participant's row is written, so another waits, then reads again. */
async function lockParticipant(participantId: number): Promise<{ id: number; display_name: string; linked_user_id: number | null } | undefined> {
  return (await getDb()
    .prepare("UPDATE participants SET updated_at = now() WHERE id = ? RETURNING id, display_name, linked_user_id")
    .get(participantId)) as { id: number; display_name: string; linked_user_id: number | null } | undefined;
}

interface Activated {
  participantId: number;
  guardianshipId: number;
  newUserId: number;
  venueId: number | null;
  suppress: boolean;
}

/**
 * Make the relationship a request was for, in the caller's transaction: the
 * request accepted, and agreed to or excepted. Provenance `online` (the
 * adult's own declaration, signed in); never `staff_review`, so an activity
 * that asks for a guardian's authority to be reviewed still asks. One made
 * by an exception is flagged for a manager's review.
 */
async function activateInside(requestId: number, actor: Actor): Promise<Activated> {
  const db = getDb();
  const r = (await db
    .prepare("SELECT *, to_char(exception_review_on, 'YYYY-MM-DD') AS exception_review_on FROM guardian_requests WHERE id = ? FOR UPDATE")
    .get(requestId)) as RequestRow;
  const accepted = (await db.prepare("SELECT name FROM users WHERE id = ?").get(r.accepted_by_user_id)) as { name: string };
  const exception = r.exception_category !== null;
  const g = (await db
    .prepare(
      `INSERT INTO participant_guardians (participant_id, user_id, relationship, authority_declared_at, provenance, venue_id, note, request_id,
         review_reason, review_flagged_at, review_note)
       SELECT participant_id, accepted_by_user_id, relationship, authority_declared_at, 'online', venue_id, ?, id, ?, ?, ? FROM guardian_requests WHERE id = ?
       RETURNING id`
    )
    .get(
      `Invited by ${r.initiated_by_name}`.slice(0, 200),
      exception ? "exception" : null,
      exception ? new Date().toISOString() : null,
      exception ? `Exception (${r.exception_category}) by ${r.exception_by_name}: ${r.exception_reason}; review by ${r.exception_review_on}` : null,
      r.id
    )) as { id: number };
  await db.prepare("UPDATE guardian_requests SET status = 'active', guardianship_id = ?, activated_at = now() WHERE id = ?").run(g.id, r.id);
  const how = exception ? `exception (${r.exception_category}) recorded by ${r.exception_by_name}` : `agreed by ${r.consented_by_name}`;
  await participantEvent(r.participant_id, "guardian.added", actor, {
    venueId: r.venue_id,
    detail: `${accepted.name} (their account) declared ${r.relationship} online, invited by ${r.initiated_by_name}; ${how}`,
  });
  return { participantId: r.participant_id, guardianshipId: g.id, newUserId: r.accepted_by_user_id!, venueId: r.venue_id, suppress: r.suppress_notice };
}

/** After a relationship was made: the other guardians told, or (an exception requiring it) not, and that recorded. */
async function afterActivation(a: Activated, alsoExcept: number[] = []): Promise<void> {
  if (a.suppress) {
    await participantEvent(a.participantId, "guardian.notice_suppressed", { system: true }, { venueId: a.venueId, detail: "an exception requires the other guardians not to be told" });
    return;
  }
  await notifyGuardianChange(a.participantId, "added", { exceptUserIds: [a.newUserId, ...alsoExcept], venueId: a.venueId, about: a.guardianshipId });
}

const toRefusal = (err: unknown): ParticipantRefusal => {
  if (isUniqueViolation(err, "participant_guardians")) return refused("PTC_ALREADY_GUARDIAN", "You already manage them.", 409);
  if (isUniqueViolation(err, "guardian_requests")) return refused("GV_ALREADY_PENDING", "You already accepted a request for them; it is waiting for agreement.", 409);
  throw err;
};

// ------------------------------------------------------------------ starting a request

/**
 * A venue's staff (front desk or a manager) start a request for another
 * adult to become a guardian of a participant this venue knows, the adult
 * having asked in person: named as staff know them (`proposedName`), and
 * optionally by their MySenam account's email (`email`), so that only that
 * account may accept. Makes a single-use code, shown this once, for the
 * adult to accept signed in. Grants nothing: an existing guardian's
 * agreement, or a manager's exception, is still needed.
 */
export async function requestAtVenue(input: {
  venueId: number;
  participantId: number;
  admin: StaffActor;
  proposedName?: unknown;
  email?: unknown;
}): Promise<{ ok: true; requestId: number; code: string; expiresAt: string; consentPossible: boolean; proposedName: string } | ParticipantRefusal> {
  const db = getDb();
  const name = typeof input.proposedName === "string" ? input.proposedName.trim().replace(/\s+/g, " ") : "";
  const email = typeof input.email === "string" ? input.email.trim() : "";
  if (name && (name.length < 2 || name.length > 80)) return refused("PTC_GUARDIAN_NAME", "Give the guardian's name.");
  if (!name && !email) return refused("GV_PROPOSED_NEEDED", "Give the adult's name, or the email of their MySenam account.");
  const { shown, hash } = newInviteCode();
  return withTransaction(async () => {
    const p = await participantForStaff({ venueId: input.venueId }, input.participantId);
    if (!p) return refused("PTC_NOT_FOUND", "No such participant here.", 404);
    let proposedUserId: number | null = null;
    let proposed = name;
    if (email) {
      const account = (await db.prepare("SELECT id, name FROM users WHERE email = ?").get(email)) as { id: number; name: string } | undefined;
      if (!account) return refused("PTC_NO_ACCOUNT", "No account has that email.", 404);
      const linked = (await db.prepare("SELECT linked_user_id FROM participants WHERE id = ?").get(p.id)) as { linked_user_id: number | null };
      if (linked.linked_user_id === account.id) return refused("PTC_GUARDIAN_OWN_LOGIN", "That account is their own login: it cannot be their guardian too.", 409);
      if (await db.prepare("SELECT 1 FROM participant_guardians WHERE participant_id = ? AND user_id = ? AND revoked_at IS NULL").get(p.id, account.id))
        return refused("PTC_GUARDIAN_ALREADY", "That account already acts for them.", 409);
      proposedUserId = account.id;
      proposed = proposed || account.name;
    }
    const req = (await db
      .prepare(
        `INSERT INTO guardian_requests (participant_id, initiated_as, initiated_by_admin_id, initiated_by_name, venue_id, proposed_name, proposed_user_id)
         VALUES (?, 'staff', ?, ?, ?, ?, ?) RETURNING id`
      )
      .get(p.id, input.admin.id, input.admin.name, input.venueId, proposed.slice(0, 80), proposedUserId)) as { id: number };
    const inv = (await db
      .prepare(
        `INSERT INTO participant_invites (participant_id, purpose, code_hash, created_by_admin_id, created_by_name, request_id, expires_at)
         VALUES (?, 'guardian', ?, ?, ?, ?, now() + interval '${INVITE_DAYS} days') RETURNING expires_at`
      )
      .get(p.id, hash, input.admin.id, input.admin.name, req.id)) as { expires_at: unknown };
    await participantEvent(p.id, "guardian.requested", { adminId: input.admin.id, name: input.admin.name }, {
      venueId: input.venueId,
      detail: `invitation for ${proposed}${proposedUserId !== null ? " (their account)" : ""}; nothing granted until accepted and agreed`,
    });
    return {
      ok: true as const,
      requestId: req.id,
      code: shown,
      expiresAt: iso(inv.expires_at) ?? "",
      consentPossible: await consentPossible(p.id, proposedUserId),
      proposedName: proposed,
    };
  });
}

/** Could an existing guardian agree online: one with an account, acting for them now (not the adult proposed)? */
async function consentPossible(participantId: number, notUserId: number | null): Promise<boolean> {
  return !!(await getDb()
    .prepare(
      `SELECT 1 FROM participant_guardians WHERE participant_id = ? AND user_id IS NOT NULL AND user_id IS DISTINCT FROM ?
          AND revoked_at IS NULL AND suspended_at IS NULL AND archived_at IS NULL LIMIT 1`
    )
    .get(participantId, notUserId));
}

// ------------------------------------------------------------------ accepting

/**
 * The proposed guardian accepts a `guardian` code, signed in, with their own
 * declaration (lib/participants.ts acceptInvite sends it here). A guardian's
 * own code makes the relationship now: the guardian who gave it agreed, and
 * must still act for them. A code staff gave waits for an existing
 * guardian's agreement or a manager's exception (made now if one is already
 * recorded); the existing guardians are told there is something to look at.
 */
export async function acceptGuardianInvite(
  user: { id: number; name?: string | null },
  codeHash: string,
  input: Record<string, unknown>
): Promise<{ ok: true; participant: Participant; as: "guardian" } | { ok: true; as: "pending"; displayName: string } | ParticipantRefusal> {
  const db = getDb();
  const invalid = () => refused("PTC_INVITE_INVALID", "That code is not one we know, or it has run out.", 404);
  let done: { ok: true; participantId: number; displayName: string; activated: Activated | null; venueId: number | null; requestId: number } | ParticipantRefusal;
  try {
    done = await withTransaction(async () => {
      const inv = (await db.prepare(`${OPEN_INVITE} FOR UPDATE OF i`).get(codeHash)) as OpenInvite | undefined;
      if (!inv || inv.purpose !== "guardian") return invalid();
      const p = await lockParticipant(inv.participant_id);
      if (!p) return invalid();
      let req = inv.request_id ? ((await db.prepare("SELECT * FROM guardian_requests WHERE id = ? FOR UPDATE").get(inv.request_id)) as RequestRow | undefined) : undefined;
      if (!req) {
        // A guardian's code given before requests were kept (migration 0152): a request of theirs.
        if (inv.created_by_user_id === null) return invalid();
        req = (await db
          .prepare("INSERT INTO guardian_requests (participant_id, initiated_as, initiated_by_user_id, initiated_by_name) VALUES (?, 'guardian', ?, ?) RETURNING *")
          .get(p.id, inv.created_by_user_id, inv.by_name)) as RequestRow;
      }
      if (req.status !== "invited") return invalid();
      // A guardian's own code: they must still act for them. A code staff gave for one account: that account only.
      if (req.initiated_as === "guardian" && (req.initiated_by_user_id === null || !(await guardianshipOf(req.initiated_by_user_id, p.id, { live: true })))) return invalid();
      if (req.proposed_user_id !== null && req.proposed_user_id !== user.id) return invalid();
      if (await db.prepare("SELECT 1 FROM participant_guardians WHERE participant_id = ? AND user_id = ? AND revoked_at IS NULL").get(p.id, user.id))
        return refused("PTC_ALREADY_GUARDIAN", "You already manage them.", 409);
      if (p.linked_user_id === user.id) return refused("PTC_LINK_SELF", "This is their own login: it cannot be their guardian too.", 409);
      if (await db.prepare("SELECT 1 FROM guardian_requests WHERE participant_id = ? AND accepted_by_user_id = ? AND status = 'awaiting_consent'").get(p.id, user.id))
        return refused("GV_ALREADY_PENDING", "You already accepted a request for them; it is waiting for agreement.", 409);
      const relationship = readRelationship(input.relationship);
      if (isRefusal(relationship)) return relationship;
      if (input.authority !== true) return refused("GUARD_AUTHORITY_NEEDED", "Confirm that you are their parent, legal guardian or another person with authority to act for them.");
      const limit = await underLimit(user.id);
      if (limit) return limit;
      await db.prepare("UPDATE participant_invites SET used_at = now(), used_by_user_id = ? WHERE id = ?").run(user.id, inv.id);
      const own = req.initiated_as === "guardian";
      await db
        .prepare(
          `UPDATE guardian_requests SET status = 'awaiting_consent', accepted_by_user_id = ?, accepted_at = now(), relationship = ?, authority_declared_at = now(),
             consented_by_user_id = CASE WHEN ? THEN initiated_by_user_id ELSE consented_by_user_id END,
             consented_by_name = CASE WHEN ? THEN initiated_by_name ELSE consented_by_name END,
             consented_at = CASE WHEN ? THEN now() ELSE consented_at END
           WHERE id = ?`
        )
        .run(user.id, relationship, own, own, own, req.id);
      await participantEvent(p.id, "guardian.request_accepted", { userId: user.id, name: user.name }, {
        venueId: req.venue_id,
        detail: `declared ${relationship} online, signed in, accepting the code ${inv.by_name} gave`,
      });
      const activated = own || req.exception_category !== null ? await activateInside(req.id, { userId: user.id, name: user.name }) : null;
      return { ok: true as const, participantId: p.id, displayName: p.display_name, activated, venueId: req.venue_id, requestId: req.id };
    });
  } catch (err) {
    done = toRefusal(err);
  }
  if (!done.ok) return done;
  if (done.activated) {
    await afterActivation(done.activated);
    const row = (await db.prepare("SELECT * FROM participants WHERE id = ?").get(done.participantId)) as ParticipantRow;
    return { ok: true, participant: toParticipant(row), as: "guardian" };
  }
  // Waiting: the guardians who could agree are told there is a request to look at.
  await notifyGuardianChange(done.participantId, "request", { exceptUserIds: [user.id], venueId: done.venueId, about: done.requestId });
  return { ok: true, as: "pending", displayName: done.displayName };
}

// ------------------------------------------------------------------ agreeing, the exception, closing

/**
 * An existing guardian's answer to a request waiting for agreement: `agree`
 * makes the relationship; otherwise it is refused, with the reason if given.
 * Only a guardian acting for the participant now (not the adult proposed).
 */
export async function answerRequest(
  user: { id: number; name?: string | null },
  requestId: unknown,
  agree: unknown,
  reason?: unknown
): Promise<{ ok: true; status: RequestStatus } | ParticipantRefusal> {
  const id = Number(requestId);
  const notFound = () => refused("GV_REQUEST_NOT_FOUND", "No such request.", 404);
  if (!Number.isInteger(id) || id <= 0) return notFound();
  if (agree !== true && agree !== false) return refused("GV_ANSWER_NEEDED", "Say whether you agree.");
  const db = getDb();
  let done: { ok: true; status: RequestStatus; activated: Activated | null } | ParticipantRefusal;
  try {
    done = await withTransaction(async () => {
      const r = (await db.prepare("SELECT * FROM guardian_requests WHERE id = ? FOR UPDATE").get(id)) as RequestRow | undefined;
      if (!r || r.accepted_by_user_id === user.id || !(await guardianshipOf(user.id, r.participant_id, { live: true }))) return notFound();
      if (r.status !== "awaiting_consent") return refused("GV_REQUEST_CLOSED", "This request is no longer waiting for an answer.", 409);
      await lockParticipant(r.participant_id);
      if (agree) {
        await db.prepare("UPDATE guardian_requests SET consented_by_user_id = ?, consented_by_name = ?, consented_at = now() WHERE id = ?").run(user.id, user.name ?? null, r.id);
        await participantEvent(r.participant_id, "guardian.request_agreed", { userId: user.id, name: user.name }, { venueId: r.venue_id });
        return { ok: true as const, status: "active" as const, activated: await activateInside(r.id, { userId: user.id, name: user.name }) };
      }
      const why = typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 300) : null;
      await db
        .prepare("UPDATE guardian_requests SET status = 'rejected', closed_at = now(), closed_by_user_id = ?, closed_by_name = ?, close_reason = ? WHERE id = ?")
        .run(user.id, user.name ?? null, why ?? "Refused by a guardian", r.id);
      await participantEvent(r.participant_id, "guardian.request_refused", { userId: user.id, name: user.name }, { venueId: r.venue_id, detail: why });
      return { ok: true as const, status: "rejected" as const, activated: null };
    });
  } catch (err) {
    done = toRefusal(err);
  }
  if (!done.ok) return done;
  if (done.activated) await afterActivation(done.activated, [user.id]);
  return { ok: true, status: done.status };
}

/**
 * A manager's (or the platform owner's) narrow exception to an existing
 * guardian's agreement: a custody dispute, a guardian who cannot be reached
 * or has no account to agree with, or another safeguarding circumstance;
 * a reason in words and a date to look at it again (within a year), and
 * whether the other guardians are to be told. Recorded as an exception,
 * never as proof of legal guardianship. The relationship is made once the
 * adult has accepted (now, if they have), flagged for review.
 */
export async function recordException(
  scope: StaffScope,
  admin: StaffActor,
  requestId: unknown,
  input: { category: unknown; reason: unknown; reviewOn: unknown; suppressNotice?: unknown; participantId?: number }
): Promise<{ ok: true; active: boolean; participantId: number } | ParticipantRefusal> {
  const id = Number(requestId);
  if (!EXCEPTION_CATEGORIES.includes(input.category as ExceptionCategory))
    return refused("GV_EXCEPTION_CATEGORY", "Choose why: a custody dispute, a guardian who cannot agree, or another safeguarding reason.");
  const why = reasonOf(input.reason);
  if (!why) return refused("PTC_REASON_NEEDED", "Say why, in a few words.");
  const today = todayISO();
  const reviewOn = typeof input.reviewOn === "string" ? input.reviewOn : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewOn) || reviewOn <= today || reviewOn > addDays(today, 365))
    return refused("GV_REVIEW_DATE", "Give a date within the next year to look at it again.");
  const suppress = input.suppressNotice === true;
  const db = getDb();
  let done: { ok: true; active: boolean; participantId: number; activated: Activated | null } | ParticipantRefusal;
  try {
    done = await withTransaction(async () => {
      const r = (await db.prepare("SELECT * FROM guardian_requests WHERE id = ? FOR UPDATE").get(Number.isInteger(id) && id > 0 ? id : 0)) as RequestRow | undefined;
      if (!r || (input.participantId !== undefined && r.participant_id !== input.participantId) || !(await participantForStaff(scope, r.participant_id)))
        return refused("GV_REQUEST_NOT_FOUND", "No such request.", 404);
      if (r.status !== "invited" && r.status !== "awaiting_consent") return refused("GV_REQUEST_CLOSED", "This request is no longer waiting for an answer.", 409);
      await lockParticipant(r.participant_id);
      await db
        .prepare(
          `UPDATE guardian_requests SET exception_category = ?, exception_reason = ?, exception_review_on = ?, exception_by_admin_id = ?, exception_by_name = ?,
             exception_at = now(), suppress_notice = ? WHERE id = ?`
        )
        .run(input.category, why, reviewOn, admin.id, admin.name, suppress, r.id);
      await participantEvent(r.participant_id, "guardian.exception", { adminId: admin.id, name: admin.name }, {
        venueId: venueOf(scope),
        detail: `${input.category}: ${why}; review by ${reviewOn}${suppress ? "; the other guardians not told" : ""}; not proof of legal guardianship`,
      });
      const activated = r.status === "awaiting_consent" ? await activateInside(r.id, { adminId: admin.id, name: admin.name }) : null;
      return { ok: true as const, active: activated !== null, participantId: r.participant_id, activated };
    });
  } catch (err) {
    done = toRefusal(err);
  }
  if (!done.ok) return done;
  if (done.activated) await afterActivation(done.activated);
  return { ok: true, active: done.active, participantId: done.participantId };
}

/** Staff close a request still open, with a reason: refused if it was accepted, cancelled if not; its code stops working. */
export async function closeRequest(
  scope: StaffScope,
  admin: StaffActor,
  requestId: unknown,
  reason: unknown,
  participantId?: number
): Promise<{ ok: true; participantId: number } | ParticipantRefusal> {
  const why = reasonOf(reason);
  if (!why) return refused("PTC_REASON_NEEDED", "Say why, in a few words.");
  const id = Number(requestId);
  const db = getDb();
  return withTransaction(async () => {
    const r = (await db.prepare("SELECT * FROM guardian_requests WHERE id = ? FOR UPDATE").get(Number.isInteger(id) && id > 0 ? id : 0)) as RequestRow | undefined;
    if (!r || (participantId !== undefined && r.participant_id !== participantId) || !(await participantForStaff(scope, r.participant_id)))
      return refused("GV_REQUEST_NOT_FOUND", "No such request.", 404);
    if (r.status !== "invited" && r.status !== "awaiting_consent") return refused("GV_REQUEST_CLOSED", "This request is no longer waiting for an answer.", 409);
    await db
      .prepare("UPDATE guardian_requests SET status = ?, closed_at = now(), closed_by_admin_id = ?, closed_by_name = ?, close_reason = ? WHERE id = ?")
      .run(r.status === "awaiting_consent" ? "rejected" : "cancelled", admin.id, admin.name, why, r.id);
    await db.prepare("UPDATE participant_invites SET cancelled_at = now() WHERE request_id = ? AND used_at IS NULL AND cancelled_at IS NULL").run(r.id);
    await participantEvent(r.participant_id, "guardian.request_closed", { adminId: admin.id, name: admin.name }, { venueId: venueOf(scope), detail: why });
    return { ok: true as const, participantId: r.participant_id };
  });
}

// ------------------------------------------------------------------ review: reported, paused, kept

/**
 * A guardian reports another guardian's relationship to a participant they
 * both act for as a mistake: it is flagged for a manager of a venue that
 * knows the participant (or the platform owner), with their note. Nothing
 * else changes until a manager decides.
 */
export async function reportMistake(
  user: { id: number; name?: string | null },
  participantId: unknown,
  guardianshipId: unknown,
  note: unknown
): Promise<{ ok: true } | ParticipantRefusal> {
  const mine = await guardianshipOf(user.id, participantId);
  const gid = Number(guardianshipId);
  if (!mine || !Number.isInteger(gid) || gid <= 0) return refused("GV_CHANGE_NOT_FOUND", "No such change to report.", 404);
  const text = typeof note === "string" ? note.trim().replace(/\s+/g, " ").slice(0, 500) : "";
  const db = getDb();
  return withTransaction(async () => {
    const g = (await db
      .prepare("SELECT id, user_id, venue_id FROM participant_guardians WHERE id = ? AND participant_id = ? AND revoked_at IS NULL FOR UPDATE")
      .get(gid, mine.participant.id)) as { id: number; user_id: number | null; venue_id: number | null } | undefined;
    if (!g || g.user_id === user.id) return refused("GV_CHANGE_NOT_FOUND", "No such change to report.", 404);
    await db
      .prepare(
        `UPDATE participant_guardians SET review_reason = 'reported', review_flagged_at = now(), review_note = ?,
           reviewed_at = NULL, reviewed_by_name = NULL, review_outcome = NULL WHERE id = ?`
      )
      .run(`Reported as a mistake by ${user.name ?? "a guardian"}${text ? `: ${text}` : ""}`, g.id);
    await participantEvent(mine.participant.id, "guardian.reported", { userId: user.id, name: user.name }, { venueId: g.venue_id, detail: text || null });
    return { ok: true as const };
  });
}

/**
 * A manager pauses a relationship while a reported mistake is looked at
 * (`suspend`): it acts for nobody (no booking, application, status or code)
 * until kept or revoked; nothing it made is undone. Or keeps one flagged or
 * paused (`confirm`): the flag closed, the pause lifted, with who and why.
 */
export async function reviewGuardian(
  scope: StaffScope,
  admin: StaffActor,
  participantId: number,
  guardianshipId: unknown,
  action: "suspend" | "confirm",
  reason: unknown
): Promise<{ ok: true } | ParticipantRefusal> {
  const why = reasonOf(reason);
  if (!why) return refused("PTC_REASON_NEEDED", "Say why, in a few words.");
  const gid = Number(guardianshipId);
  const db = getDb();
  return withTransaction(async () => {
    if (!(await participantForStaff(scope, participantId))) return refused("PTC_NOT_FOUND", "No such relationship.", 404);
    const g = (await db
      .prepare(
        "SELECT id, suspended_at, review_reason, reviewed_at FROM participant_guardians WHERE id = ? AND participant_id = ? AND revoked_at IS NULL FOR UPDATE"
      )
      .get(Number.isInteger(gid) && gid > 0 ? gid : 0, participantId)) as { id: number; suspended_at: unknown; review_reason: string | null; reviewed_at: unknown } | undefined;
    if (!g) return refused("PTC_NOT_FOUND", "No such relationship.", 404);
    if (action === "suspend") {
      if (g.suspended_at) return refused("GV_ALREADY_PAUSED", "This relationship is already paused.", 409);
      await db.prepare("UPDATE participant_guardians SET suspended_at = now(), suspended_by_name = ?, suspend_reason = ? WHERE id = ?").run(admin.name, why, g.id);
    } else {
      if (!g.suspended_at && !(g.review_reason && !g.reviewed_at)) return refused("GV_NOTHING_TO_REVIEW", "Nothing about this relationship is waiting for a review.", 409);
      await db
        .prepare(
          "UPDATE participant_guardians SET suspended_at = NULL, reviewed_at = now(), reviewed_by_name = ?, review_outcome = ? WHERE id = ?"
        )
        .run(admin.name, `kept: ${why}`, g.id);
    }
    await participantEvent(participantId, action === "suspend" ? "guardian.suspended" : "guardian.confirmed", { adminId: admin.id, name: admin.name }, {
      venueId: venueOf(scope),
      detail: why,
    });
    return { ok: true as const };
  });
}

// ------------------------------------------------------------------ what each side sees

export interface StaffRequest {
  id: number;
  status: RequestStatus | "expired";
  initiatedAs: "guardian" | "staff";
  initiatedBy: string;
  proposedName: string | null;
  /** The account that accepted, by its name; null until accepted. */
  acceptedName: string | null;
  relationship: Relationship | null;
  /** Could an existing guardian agree online? If not, only an exception completes it. */
  consentPossible: boolean;
  exception: { category: ExceptionCategory; reviewOn: string } | null;
  createdAt: string;
}

/** The requests still open for these participants, for a venue's staff (or the platform owner) acting on them. */
export async function openRequestsFor(participantIds: number[]): Promise<Map<number, StaffRequest[]>> {
  const out = new Map<number, StaffRequest[]>();
  if (participantIds.length === 0) return out;
  const rows = (await getDb()
    .prepare(
      `SELECT r.id, r.participant_id, r.status, r.initiated_as, r.initiated_by_name, r.proposed_name, u.name AS accepted_name, r.relationship,
              r.exception_category, to_char(r.exception_review_on, 'YYYY-MM-DD') AS exception_review_on, r.created_at,
              NOT EXISTS (SELECT 1 FROM participant_invites i WHERE i.request_id = r.id AND i.used_at IS NULL AND i.cancelled_at IS NULL AND i.expires_at > now()) AS no_code,
              EXISTS (SELECT 1 FROM participant_guardians g WHERE g.participant_id = r.participant_id AND g.user_id IS NOT NULL
                         AND g.user_id IS DISTINCT FROM r.accepted_by_user_id AND g.user_id IS DISTINCT FROM r.proposed_user_id
                         AND g.revoked_at IS NULL AND g.suspended_at IS NULL AND g.archived_at IS NULL) AS consent_possible
         FROM guardian_requests r LEFT JOIN users u ON u.id = r.accepted_by_user_id
        WHERE r.participant_id IN (${participantIds.map(() => "?").join(",")}) AND r.status IN ('invited', 'awaiting_consent')
        ORDER BY r.id`
    )
    .all(...participantIds)) as {
    id: number;
    participant_id: number;
    status: RequestStatus;
    initiated_as: "guardian" | "staff";
    initiated_by_name: string;
    proposed_name: string | null;
    accepted_name: string | null;
    relationship: Relationship | null;
    exception_category: ExceptionCategory | null;
    exception_review_on: string | null;
    created_at: unknown;
    no_code: boolean;
    consent_possible: boolean;
  }[];
  for (const r of rows)
    out.set(r.participant_id, [
      ...(out.get(r.participant_id) ?? []),
      {
        id: r.id,
        status: r.status === "invited" && r.no_code ? "expired" : r.status,
        initiatedAs: r.initiated_as,
        initiatedBy: r.initiated_by_name,
        proposedName: r.proposed_name,
        acceptedName: r.accepted_name,
        relationship: r.relationship,
        consentPossible: r.consent_possible,
        exception: r.exception_category ? { category: r.exception_category, reviewOn: String(r.exception_review_on) } : null,
        createdAt: iso(r.created_at) ?? "",
      },
    ]);
  return out;
}

export interface AccountRequests {
  /** Waiting for this guardian's answer: who asked (the account that accepted, by name), as what, started by whom. */
  toAnswer: { id: number; participantId: number; displayName: string; proposedName: string; relationship: Relationship; startedBy: string; venueName: string | null; acceptedAt: string }[];
  /** This account accepted, and is waiting: that a request is pending, and for whom. Nothing else. */
  pending: { id: number; displayName: string; since: string }[];
  /** This account's relationships paused while a manager reviews them. */
  paused: { displayName: string; since: string }[];
  /** Changes to who acts for the people this account manages, in the last 90 days, that it may report as a mistake. */
  changes: { participantId: number; guardianshipId: number; kind: "added" | "ended"; at: string; reported: boolean }[];
}

/** What an account sees of guardian requests and changes (its people page). */
export async function accountRequests(userId: number): Promise<AccountRequests> {
  const db = getDb();
  const toAnswer = (await db
    .prepare(
      `SELECT r.id, r.participant_id, p.display_name, u.name AS proposed_name, r.relationship, r.initiated_by_name, v.name AS venue_name, r.accepted_at
         FROM guardian_requests r JOIN participants p ON p.id = r.participant_id JOIN users u ON u.id = r.accepted_by_user_id
         JOIN participant_guardians mine ON mine.participant_id = r.participant_id AND mine.user_id = ?
              AND mine.revoked_at IS NULL AND mine.suspended_at IS NULL AND mine.archived_at IS NULL
         LEFT JOIN venues v ON v.id = r.venue_id
        WHERE r.status = 'awaiting_consent' AND r.accepted_by_user_id <> ?
        ORDER BY r.id`
    )
    .all(userId, userId)) as {
    id: number;
    participant_id: number;
    display_name: string;
    proposed_name: string;
    relationship: Relationship;
    initiated_by_name: string;
    venue_name: string | null;
    accepted_at: unknown;
  }[];
  const pending = (await db
    .prepare(
      `SELECT r.id, p.display_name, r.accepted_at FROM guardian_requests r JOIN participants p ON p.id = r.participant_id
        WHERE r.accepted_by_user_id = ? AND r.status = 'awaiting_consent' ORDER BY r.id`
    )
    .all(userId)) as { id: number; display_name: string; accepted_at: unknown }[];
  const paused = (await db
    .prepare(
      `SELECT p.display_name, g.suspended_at FROM participant_guardians g JOIN participants p ON p.id = g.participant_id
        WHERE g.user_id = ? AND g.revoked_at IS NULL AND g.suspended_at IS NOT NULL ORDER BY g.id`
    )
    .all(userId)) as { display_name: string; suspended_at: unknown }[];
  // Another guardian added (not a correction of one already there) or ended, since this account became a guardian; never one an exception said not to tell.
  const changes = (await db
    .prepare(
      `SELECT g.id, g.participant_id, g.created_at, g.revoked_at, g.created_at > mine.created_at AND g.created_at > now() - interval '90 days' AS added_recently,
              (g.review_reason = 'reported' AND g.reviewed_at IS NULL) AS reported
         FROM participant_guardians g
         JOIN participant_guardians mine ON mine.participant_id = g.participant_id AND mine.user_id = ? AND mine.revoked_at IS NULL AND mine.suspended_at IS NULL
         LEFT JOIN guardian_requests r ON r.id = g.request_id
        WHERE g.id <> mine.id AND g.user_id IS DISTINCT FROM ? AND NOT COALESCE(r.suppress_notice, false)
          AND ((g.created_at > mine.created_at AND g.created_at > now() - interval '90 days'
                AND NOT EXISTS (SELECT 1 FROM participant_guardians o WHERE o.participant_id = g.participant_id AND o.user_id = g.user_id AND o.id < g.id))
               OR (g.revoked_at > now() - interval '90 days' AND g.revoked_at > mine.created_at AND g.revoke_reason IS DISTINCT FROM 'Corrected'))
        ORDER BY g.id`
    )
    .all(userId, userId)) as { id: number; participant_id: number; created_at: unknown; revoked_at: unknown; added_recently: boolean; reported: boolean }[];
  return {
    toAnswer: toAnswer.map((r) => ({
      id: r.id,
      participantId: r.participant_id,
      displayName: r.display_name,
      proposedName: r.proposed_name,
      relationship: r.relationship,
      startedBy: r.initiated_by_name,
      venueName: r.venue_name,
      acceptedAt: iso(r.accepted_at) ?? "",
    })),
    pending: pending.map((r) => ({ id: r.id, displayName: r.display_name, since: iso(r.accepted_at) ?? "" })),
    paused: paused.map((r) => ({ displayName: r.display_name, since: iso(r.suspended_at) ?? "" })),
    changes: changes.flatMap((c) => [
      ...(c.added_recently ? [{ participantId: c.participant_id, guardianshipId: c.id, kind: "added" as const, at: iso(c.created_at) ?? "", reported: !!c.reported }] : []),
      ...(c.revoked_at ? [{ participantId: c.participant_id, guardianshipId: c.id, kind: "ended" as const, at: iso(c.revoked_at) ?? "", reported: false }] : []),
    ]),
  };
}

// ------------------------------------------------------------------ telling the other guardians

function moment(at: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const p = (type: string) => parts.find((x) => x.type === type)?.value ?? "";
  return `${p("year")}-${p("month")}-${p("day")} ${p("hour")}:${p("minute")}`;
}

/**
 * Tell a participant's guardians with an account (acting for them now; not
 * those named in `exceptUserIds`) by email, through the outbox, that who
 * acts for them changed: another guardian added, or a guardian's
 * relationship ended, and when; or (`request`) that another adult asked and
 * their answer is wanted. Which participant, the general nature and the
 * moment, how to report a mistake (their people page) and the venue to
 * contact: never the new guardian's details, nor any location, schedule or
 * private detail. Queued, so a mail server being down only delays it; a
 * failure even to queue it is recorded and undoes nothing. Returns how many
 * were queued.
 */
export async function notifyGuardianChange(
  participantId: number,
  change: Change,
  opts: { exceptUserIds: number[]; venueId: number | null; about?: number }
): Promise<number> {
  const db = getDb();
  try {
    const recipients = (await db
      .prepare(
        `SELECT DISTINCT u.id, u.email, u.name FROM participant_guardians g JOIN users u ON u.id = g.user_id
          WHERE g.participant_id = ? AND g.revoked_at IS NULL AND g.suspended_at IS NULL AND u.email IS NOT NULL AND u.email <> ''
          ORDER BY u.id`
      )
      .all(participantId)) as { id: number; email: string; name: string }[];
    const to = recipients.filter((r) => !opts.exceptUserIds.includes(r.id));
    if (to.length === 0) return 0;
    const p = (await db.prepare("SELECT display_name FROM participants WHERE id = ?").get(participantId)) as { display_name: string } | undefined;
    if (!p) return 0;
    const venue = opts.venueId
      ? ((await db.prepare("SELECT name, phone, time_zone, lat, lng FROM venues WHERE id = ?").get(opts.venueId)) as
          | { name: string; phone: string | null; time_zone: string | null; lat: number | null; lng: number | null }
          | undefined)
      : undefined;
    const when = moment(new Date(), venue ? venueZoneOf(venue) : installZone());
    const link = `${opts.venueId && venue ? await venueBaseUrl(opts.venueId) : baseUrl()}/account#people`;
    const ids: number[] = [];
    for (const r of to) {
      const locale = await accountLocale(r.id);
      const t = translator(locale, siteName());
      const vars = { name: p.display_name, when };
      const parts = [
        t(`gv.mail.${change}`, vars),
        t("gv.mail.mistake", { link }),
        venue ? (venue.phone ? t("gv.mail.venue", { venue: venue.name, phone: venue.phone }) : t("gv.mail.venueNoPhone", { venue: venue.name })) : t("gv.mail.platform"),
      ];
      const text = `${t("mail.hi", { name: r.name.split(/\s+/)[0] })}\n\n${parts.join("\n\n")}\n\n${siteName()}`;
      const m = await enqueue({
        venueId: opts.venueId,
        kind: "account_email",
        channel: "email",
        recipient: r.email,
        locale,
        subject: "msg.programmeSubject",
        body: "msg.programmeBody",
        vars: { subject: t(`gv.mail.${change}Subject`, vars), text },
        dedupeKey: opts.about !== undefined ? `guardian-${change}:${participantId}:${opts.about}:${r.id}` : undefined,
      });
      ids.push(m.id);
    }
    await participantEvent(participantId, "guardian.notified", { system: true }, {
      venueId: opts.venueId,
      detail: `${change}: ${ids.length} other guardian(s) told by email (messages ${ids.join(", ")})`,
    });
    return ids.length;
  } catch (err) {
    // The change stands, and is on record; only the telling failed.
    await participantEvent(participantId, "guardian.notice_failed", { system: true }, {
      venueId: opts.venueId,
      detail: `${change}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
    }).catch(() => {});
    return 0;
  }
}
