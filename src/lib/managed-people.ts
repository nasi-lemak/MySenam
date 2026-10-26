import { getDb } from "./db";

/**
 * People an adult manages from their own account (ADR 0022;
 * docs/features/activities.md#applying-for-somebody-you-manage;
 * docs/architecture/privacy.md#people-an-adult-manages).
 *
 * A parent, legal guardian or other person with authority applies for an
 * activity, agrees to a waiver, books and is told on behalf of somebody who
 * has no login of their own: a child, most often. That person is a small
 * record under the adult's account, never a user: no email, no phone, no
 * photo, school or identity number, so nothing that finds or contacts users
 * (player discovery, suggestions, profiles, invitations) can reach them.
 *
 * What is held is the adult's word: a name the family uses, a birth year only
 * where an activity needs an age, the relationship as the adult declares it,
 * and when the adult declared their authority to act for them. Recorded as
 * declared, never verified; an account proves nobody's guardianship, so an
 * activity may ask its staff to review it before approval (lib/approvals.ts).
 * Whatever age a rule uses is that rule's configuration, not a legal fact.
 *
 * Eligibility is the person's own: a sign-off written for them counts for
 * them alone (lib/sign-offs.ts), never for the adult or a sibling, and the
 * adult's never for them.
 */

export type Relationship = "parent" | "guardian" | "other";
export const RELATIONSHIPS: Relationship[] = ["parent", "guardian", "other"];
/** At most this many people on one account, archived ones apart. */
export const MAX_MANAGED = 12;

export interface ManagedPerson {
  id: number;
  displayName: string;
  /** As the adult declared it; null where none was given. */
  birthYear: number | null;
  relationship: Relationship;
  /** When the adult last declared their authority to act for them. */
  authorityDeclaredAt: string;
  createdAt: string;
  archivedAt: string | null;
}

export type ManagedRefusal = { ok: false; error: string; code: string; status: number; vars?: Record<string, string | number> };
const refused = (code: string, error: string, status = 400, vars?: Record<string, string | number>): ManagedRefusal => ({
  ok: false,
  error,
  code,
  status,
  ...(vars ? { vars } : {}),
});

interface Row {
  id: number;
  user_id: number;
  display_name: string;
  birth_year: number | null;
  relationship: Relationship;
  authority_declared_at: unknown;
  created_at: unknown;
  archived_at: unknown;
}

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));

const toPerson = (r: Row): ManagedPerson => ({
  id: r.id,
  displayName: r.display_name,
  birthYear: r.birth_year,
  relationship: r.relationship,
  authorityDeclaredAt: iso(r.authority_declared_at) ?? "",
  createdAt: iso(r.created_at) ?? "",
  archivedAt: iso(r.archived_at),
});

/** The only things held; anything else sent (an email, a phone, a photo, a school, an ID number) is refused, never stored. */
const FIELDS = new Set(["displayName", "birthYear", "relationship", "authority"]);

/** A name that is a name: not an email address or a phone number. */
function readName(v: unknown): string | ManagedRefusal {
  const name = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  if (name.length < 1 || name.length > 40) return refused("GUARD_NAME_NEEDED", "Give a first name, or what the family calls them (up to 40 characters).");
  if (name.includes("@") || (name.match(/\d/g) ?? []).length >= 5)
    return refused("GUARD_NAME_NEEDED", "Give a first name, or what the family calls them (up to 40 characters).");
  return name;
}

function readBirthYear(v: unknown): number | null | ManagedRefusal {
  if (v === undefined || v === null || v === "") return null;
  const year = Number(v);
  const now = new Date().getUTCFullYear();
  if (!Number.isInteger(year) || year > now || year < now - 120) return refused("GUARD_BIRTH_YEAR_BAD", "A birth year, as four digits, or leave it out.");
  return year;
}

function readRelationship(v: unknown): Relationship | ManagedRefusal {
  return RELATIONSHIPS.includes(v as Relationship)
    ? (v as Relationship)
    : refused("GUARD_RELATIONSHIP_NEEDED", "Say how you are related: parent, legal guardian, or another person with authority.");
}

const isRefusal = (x: unknown): x is ManagedRefusal => typeof x === "object" && x !== null && (x as ManagedRefusal).ok === false;

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

/** The people this account manages, newest first; archived ones only when asked. */
export async function listManaged(userId: number, opts: { archived?: boolean } = {}): Promise<ManagedPerson[]> {
  const rows = (await getDb()
    .prepare(`SELECT * FROM managed_people WHERE user_id = ?${opts.archived ? "" : " AND archived_at IS NULL"} ORDER BY archived_at NULLS FIRST, id`)
    .all(userId)) as Row[];
  return rows.map(toPerson);
}

/**
 * One person this account manages, or null: another account's, or (with
 * `live`) archived. Every use goes through here, so nobody acts for a person
 * another adult manages.
 */
export async function managedPerson(userId: number, id: unknown, opts: { live?: boolean } = {}): Promise<ManagedPerson | null> {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  const row = (await getDb().prepare("SELECT * FROM managed_people WHERE id = ? AND user_id = ?").get(n, userId)) as Row | undefined;
  if (!row || (opts.live && row.archived_at !== null && row.archived_at !== undefined)) return null;
  return toPerson(row);
}

/**
 * Add somebody the adult manages: a name, a birth year if wanted, the
 * relationship, and the adult's declaration that they have the authority to
 * act for them (its time recorded).
 */
export async function addManaged(userId: number, input: Record<string, unknown>): Promise<{ ok: true; person: ManagedPerson } | ManagedRefusal> {
  const extra = extraFields(input);
  if (extra) return extra;
  const name = readName(input.displayName);
  if (isRefusal(name)) return name;
  const birthYear = readBirthYear(input.birthYear);
  if (isRefusal(birthYear)) return birthYear;
  const relationship = readRelationship(input.relationship);
  if (isRefusal(relationship)) return relationship;
  if (input.authority !== true)
    return refused("GUARD_AUTHORITY_NEEDED", "Confirm that you are their parent, legal guardian or another person with authority to act for them.");
  const db = getDb();
  const count = (await db.prepare("SELECT COUNT(*)::int AS n FROM managed_people WHERE user_id = ? AND archived_at IS NULL").get(userId)) as { n: number };
  if (count.n >= MAX_MANAGED) return refused("GUARD_TOO_MANY", `Up to ${MAX_MANAGED} people on one account.`, 409, { n: MAX_MANAGED });
  const row = (await db
    .prepare("INSERT INTO managed_people (user_id, display_name, birth_year, relationship, authority_declared_at) VALUES (?, ?, ?, ?, now()) RETURNING *")
    .get(userId, name, birthYear, relationship)) as Row;
  return { ok: true, person: toPerson(row) };
}

/**
 * Change what is held, or archive (`archived: true`) or bring back
 * (`archived: false`) a person. Archiving deletes nothing: an application
 * still under review, a hold, a sign-off or a booking stays as it is, and the
 * adult can still withdraw it; nothing new is made for them until they are
 * brought back. A changed relationship needs the declaration again.
 */
export async function editManaged(
  userId: number,
  id: unknown,
  input: Record<string, unknown>
): Promise<{ ok: true; person: ManagedPerson } | ManagedRefusal> {
  const { archived, ...fields } = input;
  const extra = extraFields(fields);
  if (extra) return extra;
  const person = await managedPerson(userId, id);
  if (!person) return refused("GUARD_NOT_FOUND", "Not one of the people you manage.", 404);
  const name = fields.displayName === undefined ? person.displayName : readName(fields.displayName);
  if (isRefusal(name)) return name;
  const birthYear = fields.birthYear === undefined ? person.birthYear : readBirthYear(fields.birthYear);
  if (isRefusal(birthYear)) return birthYear;
  const relationship = fields.relationship === undefined ? person.relationship : readRelationship(fields.relationship);
  if (isRefusal(relationship)) return relationship;
  const redeclared = relationship !== person.relationship || fields.authority === true;
  if (relationship !== person.relationship && fields.authority !== true)
    return refused("GUARD_AUTHORITY_NEEDED", "Confirm that you are their parent, legal guardian or another person with authority to act for them.");
  if (archived === false && person.archivedAt) {
    const count = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM managed_people WHERE user_id = ? AND archived_at IS NULL").get(userId)) as { n: number };
    if (count.n >= MAX_MANAGED) return refused("GUARD_TOO_MANY", `Up to ${MAX_MANAGED} people on one account.`, 409, { n: MAX_MANAGED });
  }
  const archive = archived === true ? "now()" : archived === false ? "NULL" : "archived_at";
  const row = (await getDb()
    .prepare(
      `UPDATE managed_people SET display_name = ?, birth_year = ?, relationship = ?,
         authority_declared_at = ${redeclared ? "now()" : "authority_declared_at"},
         archived_at = ${archived === true ? `COALESCE(archived_at, ${archive})` : archive}, updated_at = now()
        WHERE id = ? AND user_id = ? RETURNING *`
    )
    .get(name, birthYear, relationship, person.id, userId)) as Row;
  return { ok: true, person: toPerson(row) };
}

/** For the adult's data export (lib/privacy.ts): each person, and the sign-offs written for them. */
export async function managedExport(userId: number): Promise<unknown[]> {
  const db = getDb();
  const people = await listManaged(userId, { archived: true });
  const out: unknown[] = [];
  for (const p of people) {
    const signOffs = await db
      .prepare(
        `SELECT COALESCE(v.name, b.name) AS venue, s.sport, s.kind, s.reference, s.expires_on, s.created_at, s.revoked_at, s.revoke_reason
           FROM sign_offs s LEFT JOIN venues v ON v.id = s.venue_id LEFT JOIN businesses b ON b.id = s.business_id
          WHERE s.managed_person_id = ? ORDER BY s.id`
      )
      .all(p.id);
    out.push({
      name: p.displayName,
      declaredBirthYear: p.birthYear,
      declaredRelationship: p.relationship,
      authorityDeclaredAt: p.authorityDeclaredAt,
      addedAt: p.createdAt,
      archivedAt: p.archivedAt,
      signOffs,
    });
  }
  return out;
}

/**
 * On the adult's erasure (lib/privacy.ts eraseCustomer), before the account
 * goes (its people go with it): a sign-off still in force for one of them is
 * taken back, so that nothing left behind can count for anybody once nobody
 * manages them. Like every sign-off it stays as the venue's record until its
 * own retention rule.
 */
export async function eraseManaged(userId: number): Promise<void> {
  const db = getDb();
  await db
    .prepare(
      `UPDATE sign_offs SET revoked_at = datetime('now'), revoke_reason = 'Account closed'
        WHERE revoked_at IS NULL AND managed_person_id IN (SELECT id FROM managed_people WHERE user_id = ?)`
    )
    .run(userId);
  // Unlinked before the people go: the account's own rows change in the same deletion, and a link
  // into a row being deleted with them cannot be set aside by the database alone.
  const theirs = "IN (SELECT id FROM managed_people WHERE user_id = ?)";
  await db.prepare(`UPDATE sign_offs SET managed_person_id = NULL WHERE managed_person_id ${theirs}`).run(userId);
  await db.prepare(`UPDATE bookings SET participant_name = NULL, participant_id = NULL WHERE participant_id ${theirs}`).run(userId);
  await db.prepare(`UPDATE waiver_signatures SET managed_person_id = NULL WHERE managed_person_id ${theirs}`).run(userId);
}
