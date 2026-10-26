import { getDb, withTransaction } from "./db";
import {
  createForAccount,
  eraseGuardian,
  guardianshipOf,
  guardianshipsOf,
  isRefusal,
  linkedParticipantOf,
  participantEvent,
  participantsExport,
  readBirthYear,
  readName,
  readRelationship,
  refused,
  revokeGuardianship,
  underLimit,
  type Participant,
  type ParticipantRefusal,
  type Relationship,
} from "./participants";

/**
 * People an adult manages from their own account (ADR 0022, ADR 0023;
 * docs/features/activities.md#applying-for-somebody-you-manage;
 * docs/architecture/privacy.md#participants): the account-holder's side of
 * participants (lib/participants.ts).
 *
 * A parent, legal guardian or other person with authority applies for an
 * activity, agrees to a waiver, books and is told on behalf of somebody who
 * has no login of their own: a child, most often. That person is a
 * participant, never a user: no email, no phone, no photo, school or
 * identity number, so nothing that finds or contacts users (player
 * discovery, suggestions, profiles, invitations) can reach them. The adult's
 * relationship to them is a guardianship: the relationship as the adult
 * declares it, and when they declared their authority to act for them.
 * Recorded as declared, never verified; an account proves nobody's
 * guardianship, so an activity may ask its staff to review it before
 * approval (lib/approvals.ts). Whatever age a rule uses is that rule's
 * configuration, not a legal fact.
 *
 * Another adult can become a guardian too, and the person's own login can
 * take them over, each by a code the adult gives and the other accepts
 * (lib/participants.ts). Ending a relationship stops this adult acting for
 * them; nothing they made is deleted.
 *
 * Eligibility is the person's own: a sign-off written for them counts for
 * them alone (lib/sign-offs.ts), never for the adult or a sibling, and the
 * adult's never for them.
 */

export type { Relationship } from "./participants";
export { RELATIONSHIPS, MAX_MANAGED } from "./participants";

export interface ManagedPerson {
  id: number;
  displayName: string;
  /** As the adult declared it; null where none was given. */
  birthYear: number | null;
  /** This adult's relationship to them, as declared. */
  relationship: Relationship;
  /** When this adult last declared their authority to act for them. */
  authorityDeclaredAt: string;
  createdAt: string;
  /** No longer managed by this adult for now. */
  archivedAt: string | null;
  /** Other guardians acting for them (a second parent, or one a venue recorded). */
  otherGuardians: number;
  /** Their own login is linked. */
  linked: boolean;
}

export type ManagedRefusal = ParticipantRefusal;

const toPerson = (p: Participant, g: { relationship: Relationship; authorityDeclaredAt: string; archivedAt: string | null }, otherGuardians = 0): ManagedPerson => ({
  id: p.id,
  displayName: p.displayName,
  birthYear: p.birthYear,
  relationship: g.relationship,
  authorityDeclaredAt: g.authorityDeclaredAt,
  createdAt: p.createdAt,
  archivedAt: g.archivedAt,
  otherGuardians,
  linked: p.linked,
});

/** The only things held; anything else sent (an email, a phone, a photo, a school, an ID number) is refused, never stored. */
const FIELDS = new Set(["displayName", "birthYear", "relationship", "authority"]);

function extraFields(input: Record<string, unknown>): ManagedRefusal | null {
  const extra = Object.keys(input).filter((k) => !FIELDS.has(k));
  return extra.length > 0
    ? refused(
        "GUARD_EXTRA_FIELD",
        "Only a name, a birth year if wanted, and your relationship are kept: no email, phone, photo, school or identity number.",
        400,
        { fields: extra.slice(0, 5).join(", ") }
      )
    : null;
}

/** The people this account manages, oldest first; those it stopped managing (archived) only when asked. */
export async function listManaged(userId: number, opts: { archived?: boolean } = {}): Promise<ManagedPerson[]> {
  return (await guardianshipsOf(userId, opts)).map((x) => toPerson(x.participant, x.guardianship, x.otherGuardians));
}

/**
 * One person this account manages, or null: somebody it has no live
 * relationship to (another adult's, one it ended or that staff revoked), or
 * (with `live`) one it archived. Every use goes through here, so nobody acts
 * for a person another adult manages.
 */
export async function managedPerson(userId: number, id: unknown, opts: { live?: boolean } = {}): Promise<ManagedPerson | null> {
  const found = await guardianshipOf(userId, id, opts);
  return found ? toPerson(found.participant, found.guardianship) : null;
}

/** The participant this account is, where it is linked to one as their own login. */
export async function ownParticipant(userId: number): Promise<Participant | null> {
  return linkedParticipantOf(userId);
}

/**
 * Add somebody the adult manages: a name, a birth year if wanted, the
 * relationship, and the adult's declaration that they have the authority to
 * act for them (its time recorded).
 */
export async function addManaged(userId: number, input: Record<string, unknown>, name?: string | null): Promise<{ ok: true; person: ManagedPerson } | ManagedRefusal> {
  const extra = extraFields(input);
  if (extra) return extra;
  const displayName = readName(input.displayName);
  if (isRefusal(displayName)) return displayName;
  const birthYear = readBirthYear(input.birthYear);
  if (isRefusal(birthYear)) return birthYear;
  const relationship = readRelationship(input.relationship);
  if (isRefusal(relationship)) return relationship;
  if (input.authority !== true)
    return refused("GUARD_AUTHORITY_NEEDED", "Confirm that you are their parent, legal guardian or another person with authority to act for them.");
  const limit = await underLimit(userId);
  if (limit) return limit;
  const participant = await createForAccount({ id: userId, name }, { displayName, birthYear, relationship });
  return { ok: true, person: (await managedPerson(userId, participant.id))! };
}

/**
 * Change what is held, or archive (`archived: true`) or bring back
 * (`archived: false`) a person. Archiving deletes nothing: an application
 * still under review, a hold, a sign-off or a booking stays as it is, and the
 * adult can still withdraw it; nothing new is made for them until they are
 * brought back. A changed relationship needs the declaration again, and is a
 * correction: the old declaration is ended ("Corrected") and a new one made,
 * so the history keeps both. Another guardian's relationship is theirs.
 */
export async function editManaged(
  userId: number,
  id: unknown,
  input: Record<string, unknown>,
  name?: string | null
): Promise<{ ok: true; person: ManagedPerson } | ManagedRefusal> {
  const { archived, ...fields } = input;
  const extra = extraFields(fields);
  if (extra) return extra;
  const found = await guardianshipOf(userId, id);
  if (!found) return refused("GUARD_NOT_FOUND", "Not one of the people you manage.", 404);
  const { participant: person, guardianship: mine } = found;
  const displayName = fields.displayName === undefined ? person.displayName : readName(fields.displayName);
  if (isRefusal(displayName)) return displayName;
  const birthYear = fields.birthYear === undefined ? person.birthYear : readBirthYear(fields.birthYear);
  if (isRefusal(birthYear)) return birthYear;
  const relationship = fields.relationship === undefined ? mine.relationship : readRelationship(fields.relationship);
  if (isRefusal(relationship)) return relationship;
  const corrected = relationship !== mine.relationship;
  if (corrected && fields.authority !== true)
    return refused("GUARD_AUTHORITY_NEEDED", "Confirm that you are their parent, legal guardian or another person with authority to act for them.");
  if (archived === false && mine.archivedAt) {
    const limit = await underLimit(userId);
    if (limit) return limit;
  }
  const actor = { userId, name };
  await withTransaction(async () => {
    const db = getDb();
    if (displayName !== person.displayName || birthYear !== person.birthYear) {
      await db.prepare("UPDATE participants SET display_name = ?, birth_year = ?, updated_at = now() WHERE id = ?").run(displayName, birthYear, person.id);
      await participantEvent(person.id, "participant.edited", actor);
    }
    let current = mine.id;
    if (corrected) {
      await db
        .prepare("UPDATE participant_guardians SET revoked_at = now(), revoked_by_user_id = ?, revoked_by_name = ?, revoke_reason = 'Corrected' WHERE id = ?")
        .run(userId, name ?? null, mine.id);
      current = ((await db
        .prepare(
          "INSERT INTO participant_guardians (participant_id, user_id, relationship, authority_declared_at, provenance, archived_at) VALUES (?, ?, ?, now(), 'online', ?) RETURNING id"
        )
        .get(person.id, userId, relationship, mine.archivedAt)) as { id: number }).id;
      await participantEvent(person.id, "guardian.corrected", actor, { detail: `${mine.relationship} -> ${relationship}` });
    } else if (fields.authority === true) {
      await db.prepare("UPDATE participant_guardians SET authority_declared_at = now() WHERE id = ?").run(mine.id);
      await participantEvent(person.id, "guardian.redeclared", actor);
    }
    if (archived === true)
      await db.prepare("UPDATE participant_guardians SET archived_at = COALESCE(archived_at, now()) WHERE id = ?").run(current);
    if (archived === false) await db.prepare("UPDATE participant_guardians SET archived_at = NULL WHERE id = ?").run(current);
    if (archived === true || (archived === false && mine.archivedAt)) await participantEvent(person.id, archived ? "guardian.archived" : "guardian.restored", actor);
  });
  return { ok: true, person: (await managedPerson(userId, person.id))! };
}

/**
 * Stop being their guardian for good (`reason` optional): this adult makes
 * nothing new for them from now on; what they made stays. Another guardian,
 * or their own login, carries on; nobody left, and they go a year on
 * (lib/privacy.ts).
 */
export async function endManaging(userId: number, id: unknown, reason: unknown, name?: string | null): Promise<{ ok: true } | ManagedRefusal> {
  const found = await guardianshipOf(userId, id);
  if (!found) return refused("GUARD_NOT_FOUND", "Not one of the people you manage.", 404);
  return revokeGuardianship(found.guardianship.id, { userId, name }, reason);
}

/** Each person the adult manages, with what is held of them and their record (the rest of the export is lib/participants.ts participantsExport). */
export async function managedExport(userId: number): Promise<unknown[]> {
  return (await participantsExport(userId)).managed;
}

/**
 * On the adult's erasure (lib/privacy.ts eraseCustomer), before the account
 * goes: their relationships go; a person somebody else still acts for (or
 * whose own login is linked) stays with what is theirs; one left with nobody
 * is erased, a sign-off or induction still in force for them taken back
 * first, so that nothing left behind counts for anybody (lib/participants.ts).
 */
export async function eraseManaged(userId: number): Promise<void> {
  await eraseGuardian(userId);
}
