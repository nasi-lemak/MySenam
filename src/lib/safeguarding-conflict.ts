import { getDb } from "./db";

/**
 * The conflict-of-interest guard for safeguarding (docs/features/player-messages.md#a-reported-adult-is-not-told; ADR 0049).
 *
 * A member of staff is the same person as a player's account when the app has the data to say so: the staff login's email is the account's email
 * (both are unique and case-insensitive). When the person a report names is the viewer, or the same person as the viewer's staff login, the report
 * does not exist for the viewer: it is left out of every list, notice and panel, the route answers as it does for anything that is not there, and
 * the group's moderating powers are not theirs while it stands. Nothing here says anything about a report to the person it names.
 */

/** Whether this staff login is the same person as this account. */
export async function adminIsUser(admin: { email: string }, userId: number | null): Promise<boolean> {
  if (userId === null) return false;
  return Boolean(await getDb().prepare("SELECT 1 FROM users WHERE id = ? AND email = ?").get(userId, admin.email));
}

/** SQL that is true for a report in a youth thread that names the same person as this staff login (a report row aliased `alias`). */
export function namesTheViewerSql(alias: string, admin: { email: string }): { sql: string; args: string[] } {
  return { sql: `(${alias}.urgent = 1 AND EXISTS (SELECT 1 FROM users ux WHERE ux.id = ${alias}.reported_id AND ux.email = ?))`, args: [admin.email] };
}

/**
 * Whether this staff login is the same person as somebody a report in this group's thread names, while the report stands (open, or its hold in
 * force): their powers over the group are suspended, and the group is not shown to them as theirs to look after.
 */
export async function adminIsAccusedIn(admin: { email: string }, groupId: number): Promise<boolean> {
  return Boolean(
    await getDb()
      .prepare(
        `SELECT 1 FROM player_message_reports r JOIN users u ON u.id = r.reported_id
          WHERE r.urgent = 1 AND r.context_kind = 'group' AND r.context_id = ? AND u.email = ?
            AND (r.status = 'open' OR EXISTS (SELECT 1 FROM youth_thread_mutes m WHERE m.report_id = r.id AND m.lifted_at IS NULL))
          LIMIT 1`
      )
      .get(groupId, admin.email)
  );
}

/** Whether somebody's account is also a staff login that looks after this venue (its branch staff, its business's managers, or the platform's owner). */
export async function isStaffOfVenue(userId: number, venueId: number): Promise<boolean> {
  return Boolean(
    await getDb()
      .prepare(
        `SELECT 1 FROM admins a JOIN users u ON u.email = a.email
          WHERE u.id = ? AND ((a.venue_id IS NULL AND a.business_id IS NULL) OR a.venue_id = ? OR a.business_id = (SELECT business_id FROM venues WHERE id = ?))
          LIMIT 1`
      )
      .get(userId, venueId, venueId)
  );
}

/** The staff login emails of this account, if it is also staff: left out of whatever safeguarding personnel are told about a report that names it. */
export async function staffEmailsOf(userId: number | null): Promise<string[]> {
  if (userId === null) return [];
  const rows = (await getDb().prepare("SELECT a.email FROM admins a JOIN users u ON u.email = a.email WHERE u.id = ?").all(userId)) as { email: string }[];
  return rows.map((r) => r.email);
}

/** Whether this staff login is a guardian of the child whose own login this is, or a live supervisor of the group: never the one who settles a hold on that child's messaging. */
export async function adminIsGuardianOrSupervisor(admin: { email: string }, groupId: number, minorId: number): Promise<boolean> {
  const db = getDb();
  const guardian = await db
    .prepare(
      `SELECT 1 FROM participants pt JOIN participant_guardians g ON g.participant_id = pt.id JOIN users u ON u.id = g.user_id
        WHERE pt.linked_user_id = ? AND u.email = ? LIMIT 1`
    )
    .get(minorId, admin.email);
  if (guardian) return true;
  return Boolean(
    await db
      .prepare(
        `SELECT 1 FROM youth_group_adults a JOIN users u ON u.id = a.user_id WHERE a.group_id = ? AND a.removed_at IS NULL AND a.role = 'supervisor' AND u.email = ? LIMIT 1`
      )
      .get(groupId, admin.email)
  );
}

/** The staff login emails of accounts that are guardians of the child whose own login this is: left out of whatever safeguarding personnel are told about the child. */
export async function guardianStaffEmails(minorId: number): Promise<string[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT DISTINCT a.email FROM admins a JOIN users u ON u.email = a.email JOIN participant_guardians g ON g.user_id = u.id JOIN participants pt ON pt.id = g.participant_id
        WHERE pt.linked_user_id = ?`
    )
    .all(minorId)) as { email: string }[];
  return rows.map((r) => r.email);
}
