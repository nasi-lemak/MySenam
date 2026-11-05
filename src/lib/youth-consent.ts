import { getDb } from "./db";

/**
 * Guardians' consent for a minor's group messaging, and what happens when guardians disagree (docs/features/player-messages.md
 * #supervised-youth-groups; ADR 0049, which amends ADR 0044 on exactly this).
 *
 * - **Authority is data per guardian link** (`participant_guardians.messaging_authority`), never assumed equal: `decides` may consent and object
 *   (every link that exists today), `objects_only` may only switch it off and never counts towards restoring it, `none` has no say. A venue's
 *   manager (or the platform's owner) sets it, with a short note: what the venue was shown, as declared, never verified by the app.
 * - **An objection** is opened by any guardian at `decides` or `objects_only` switching messaging off. Opening it ends every consent in force,
 *   so a consent that is live while it is open was given after it. While it is open no consent counts unless **every** guardian at `decides` has
 *   one (their own withdrawal of the objection is that guardian switching it on again), or a safeguarding administrator settles it with a reason.
 *   An administrator settling it does not switch messaging on: a deciding guardian's consent is still needed.
 * - **One lock per child and group** (`lockConsentState`) serialises every consent change, objection, level change and resolution; a message
 *   being written takes it `FOR SHARE` first. A racing "on" can therefore never win over a concurrent "off", whichever commits first.
 * - **Minimal disclosure**: who objected is in the audit entry and for safeguarding administrators only; nothing here is shown to the group,
 *   the child, a supervisor or other guardians beyond "off, and needs agreement from all guardians who decide".
 *
 * This module touches only the database: refusals and notices are the callers' (lib/youth-messages.ts, lib/youth-safeguarding.ts).
 */

export const AUTHORITY_LEVELS = ["decides", "objects_only", "none"] as const;
export type AuthorityLevel = (typeof AUTHORITY_LEVELS)[number];

/** The longest note a venue may keep with a level: a few words about what it was shown. */
export const AUTHORITY_NOTE_MAX = 200;

/**
 * SQL that is true when any live guardian link of the child (the participant whose own login this is) is `disputed` or `unclear`: youth messaging for that
 * child is **off, whatever consents exist**, until an authorised operator has reviewed it (ADR 0052). A conservative interim measure, not a legal determination.
 */
export function authorityHoldSql(minor: string): string {
  return `EXISTS (SELECT 1 FROM participants pah JOIN participant_guardians gah ON gah.participant_id = pah.id
                   WHERE pah.linked_user_id = ${minor} AND gah.revoked_at IS NULL AND gah.archived_at IS NULL AND gah.authority_status IN ('disputed', 'unclear'))`;
}

/** Whether youth messaging for this child is held off by a guardian link whose authority is disputed or unclear. */
export async function authorityHold(minorId: number): Promise<boolean> {
  return Boolean(await getDb().prepare(`SELECT 1 FROM (SELECT ?::int AS mid) x WHERE ${authorityHoldSql("x.mid")}`).get(minorId));
}

/**
 * SQL that is true when a child's consent for a group is in force, for the `group` and `minor` expressions given (columns, or `x.gid`/`x.mid`
 * of a one-row subquery): a live consent from a live guardian at `decides`, and no open objection that some live deciding guardian has not
 * agreed again after. Read live on every call; nothing is copied.
 */
export function consentInForceSql(group: string, minor: string): string {
  return `(NOT ${authorityHoldSql(minor)}
          AND EXISTS (SELECT 1 FROM youth_message_consents c
                     JOIN participants pt ON pt.id = c.participant_id AND pt.linked_user_id = ${minor}
                     JOIN participant_guardians g ON g.participant_id = pt.id AND g.user_id = c.guardian_user_id
                    WHERE c.group_id = ${group} AND c.minor_user_id = ${minor} AND c.revoked_at IS NULL
                      AND g.revoked_at IS NULL AND g.suspended_at IS NULL AND g.archived_at IS NULL AND g.messaging_authority = 'decides')
          AND NOT EXISTS (SELECT 1 FROM youth_message_objections o
                           WHERE o.group_id = ${group} AND o.minor_user_id = ${minor} AND o.closed_at IS NULL
                             AND EXISTS (SELECT 1 FROM participants p2 JOIN participant_guardians g2 ON g2.participant_id = p2.id
                                          WHERE p2.linked_user_id = ${minor} AND g2.user_id IS NOT NULL
                                            AND g2.revoked_at IS NULL AND g2.suspended_at IS NULL AND g2.archived_at IS NULL AND g2.messaging_authority = 'decides'
                                            AND NOT EXISTS (SELECT 1 FROM youth_message_consents c2
                                                             WHERE c2.group_id = ${group} AND c2.minor_user_id = ${minor} AND c2.guardian_user_id = g2.user_id AND c2.revoked_at IS NULL))))`;
}

/** Whether the child's consent for this group is in force now (the same rule as a seat's). */
export async function consentInForce(groupId: number, minorId: number): Promise<boolean> {
  return Boolean(await getDb().prepare(`SELECT 1 FROM (SELECT ?::int AS gid, ?::int AS mid) x WHERE ${consentInForceSql("x.gid", "x.mid")}`).get(groupId, minorId));
}

/** Takes the lock for each group (in order, so two callers never wait on each other in a circle). Inside a transaction. */
export async function lockConsentState(groupIds: number[], minorId: number): Promise<void> {
  const db = getDb();
  for (const g of [...new Set(groupIds)].sort((a, b) => a - b)) {
    await db.prepare("INSERT INTO youth_consent_locks (group_id, minor_user_id) VALUES (?, ?) ON CONFLICT DO NOTHING").run(g, minorId);
    await db.prepare("SELECT 1 FROM youth_consent_locks WHERE group_id = ? AND minor_user_id = ? FOR UPDATE").get(g, minorId);
  }
}

/** What is recorded about a group and its people (the same table as `youthEvent`): who, what, when, the level at the time; never a dispute narrative. */
export async function consentEvent(
  groupId: number,
  actorKind: "guardian" | "staff" | "system",
  action: string,
  opts: { actorId?: number | null; minorId?: number | null; detail?: string | null } = {}
): Promise<void> {
  await getDb()
    .prepare("INSERT INTO youth_message_events (group_id, minor_user_id, actor_user_id, actor_kind, action, detail) VALUES (?, ?, ?, ?, ?, ?)")
    .run(groupId, opts.minorId ?? null, opts.actorId ?? null, actorKind, action, opts.detail?.slice(0, 300) ?? null);
}

export interface Decider {
  guardianshipId: number;
  userId: number;
}

/** The live guardians (with an account) of the participant whose own login this is, who decide. */
export async function decidersOf(minorId: number): Promise<Decider[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT g.id, g.user_id FROM participants pt JOIN participant_guardians g ON g.participant_id = pt.id
        WHERE pt.linked_user_id = ? AND g.user_id IS NOT NULL AND g.revoked_at IS NULL AND g.suspended_at IS NULL AND g.archived_at IS NULL AND g.messaging_authority = 'decides'
        ORDER BY g.id`
    )
    .all(minorId)) as { id: number; user_id: number }[];
  return rows.map((r) => ({ guardianshipId: r.id, userId: r.user_id }));
}

export interface OpenObjection {
  id: number;
  groupId: number;
  minorId: number;
  guardianId: number | null;
  level: "decides" | "objects_only";
  at: string;
}

export async function openObjectionOf(groupId: number, minorId: number): Promise<OpenObjection | null> {
  const r = (await getDb()
    .prepare("SELECT id, group_id, minor_user_id, guardian_user_id, level_at_time, created_at FROM youth_message_objections WHERE group_id = ? AND minor_user_id = ? AND closed_at IS NULL")
    .get(groupId, minorId)) as { id: number; group_id: number; minor_user_id: number; guardian_user_id: number | null; level_at_time: "decides" | "objects_only"; created_at: string } | undefined;
  return r ? { id: r.id, groupId: r.group_id, minorId: r.minor_user_id, guardianId: r.guardian_user_id, level: r.level_at_time, at: r.created_at } : null;
}

/** Whether every guardian who decides has a live consent for this child and group, and there is at least one. */
export async function allDecidersAgree(groupId: number, minorId: number): Promise<boolean> {
  const deciders = await decidersOf(minorId);
  if (deciders.length === 0) return false;
  const rows = (await getDb()
    .prepare("SELECT guardian_user_id FROM youth_message_consents WHERE group_id = ? AND minor_user_id = ? AND revoked_at IS NULL")
    .all(groupId, minorId)) as { guardian_user_id: number }[];
  const live = new Set(rows.map((r) => r.guardian_user_id));
  return deciders.every((d) => live.has(d.userId));
}

/** An objection is open and has not been agreed away: messaging is off and needs the guardians who decide. */
export async function needsAgreement(groupId: number, minorId: number): Promise<boolean> {
  // A guardian link whose authority is disputed or unclear holds messaging off the same way, and is told the same neutral thing (ADR 0049, 0052).
  if (await authorityHold(minorId)) return true;
  return (await openObjectionOf(groupId, minorId)) !== null && !(await allDecidersAgree(groupId, minorId));
}

/**
 * Inside the lock: closes the open objection if every guardian who decides now has a live consent (a guardian demoted, revoked or paused no
 * longer counts). Returns whether it closed.
 */
export async function settleObjection(groupId: number, minorId: number): Promise<boolean> {
  const open = await openObjectionOf(groupId, minorId);
  if (!open || !(await allDecidersAgree(groupId, minorId))) return false;
  const done = await getDb()
    .prepare("UPDATE youth_message_objections SET closed_at = datetime('now'), close_kind = 'agreed', closed_by = 'guardians' WHERE id = ? AND closed_at IS NULL")
    .run(open.id);
  if (done.changes === 0) return false;
  await consentEvent(groupId, "system", "objection_agreed", { minorId, detail: `objection ${open.id}` });
  return true;
}

/**
 * Inside the lock: a guardian at `decides` or `objects_only` switches messaging off. Every consent in force ends and an objection opens (or, if
 * one is already open, this is recorded as another switch-off and nothing is added). Returns whether a consent was ended and whether a new
 * objection opened.
 */
export async function recordSwitchOff(groupId: number, minorId: number, guardian: { userId: number; participantId: number; level: "decides" | "objects_only" }): Promise<{ ended: number; opened: boolean }> {
  const db = getDb();
  const ended = await db
    .prepare("UPDATE youth_message_consents SET revoked_at = datetime('now'), revoked_by = ? WHERE group_id = ? AND minor_user_id = ? AND revoked_at IS NULL")
    .run(guardian.userId, groupId, minorId);
  const made = (await db
    .prepare(
      `INSERT INTO youth_message_objections (group_id, minor_user_id, participant_id, guardian_user_id, level_at_time) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING RETURNING id`
    )
    .get(groupId, minorId, guardian.participantId, guardian.userId, guardian.level)) as { id: number } | undefined;
  await consentEvent(groupId, "guardian", made ? "objection_opened" : "objection_added", { actorId: guardian.userId, minorId, detail: `level ${guardian.level}` });
  return { ended: ended.changes, opened: Boolean(made) };
}

/** The youth groups (not ended) this account is a member of. */
export async function youthGroupsOfMember(minorId: number): Promise<number[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT m.group_id FROM group_members m JOIN youth_groups y ON y.group_id = m.group_id AND y.ended_at IS NULL
        WHERE m.user_id = ? AND m.status = 'member' ORDER BY m.group_id`
    )
    .all(minorId)) as { group_id: number }[];
  return rows.map((r) => r.group_id);
}
