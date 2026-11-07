import { getDb } from "./db";
import { logAction } from "./activity";
import type { Admin } from "./admin-auth";

/**
 * Who an API key or a webhook address belongs to, and what happens to it when that changes (ADR 0064, audit A13).
 *
 * A credential is one of two things, said when it is made:
 *
 *   - a **person's** (`ownership = 'person'`, `owner_admin_id`): made by a manager for their own use. It works only while that account is a
 *     manager of the credential's venue (the platform owner, a business manager of the venue's business, or a branch manager of the venue).
 *     When the person is removed, made front desk, or no longer reaches the venue, it stops, and the log says which stopped and why;
 *   - the **venue's** (`ownership = 'venue'`): the venue's own website, accounting or door system. It does not depend on whoever made it.
 *     It is kept when that person leaves, listed with who made it, and a manager can hand it to a person, take it over, or rotate it.
 *
 * Authority is read on every use (`OWNER_AUTHORITY`, joined into the authenticating query), not swept: nothing has to run for a person's
 * access to end, so it ends at once, and a path that forgot to sweep still cannot leave a credential working. The sweep
 * (`endOwnedCredentials`) exists to write down what stopped, and to mark the rows so the list can say why.
 *
 * Rows from before migration 0312 are the venue's: an integration in use keeps working and is listed as made by whoever made it.
 */

export type Ownership = "venue" | "person";

/**
 * SQL that is true while the admin in `ownerCol` may hold a credential at the venue in `venueCol`: the platform owner, a manager of the
 * venue's business, or a manager (not front desk) of that branch. False for an account that does not exist.
 */
export const OWNER_AUTHORITY = (ownerCol: string, venueCol: string): string =>
  `EXISTS (
     SELECT 1 FROM admins oa JOIN venues ov ON ov.id = ${venueCol}
      WHERE oa.id = ${ownerCol}
        AND ((oa.venue_id IS NULL AND oa.business_id IS NULL)
             OR (oa.business_id IS NOT NULL AND oa.business_id = ov.business_id)
             OR (oa.venue_id = ov.id AND oa.role <> 'desk')))`;

/** SQL that is true while a credential works as far as who owns it goes: the venue's, or a person's whose owner still has authority. */
export const OWNER_CURRENT = (alias: string): string =>
  `(${alias}.ownership = 'venue' OR (${alias}.owner_admin_id IS NOT NULL AND ${OWNER_AUTHORITY(`${alias}.owner_admin_id`, `${alias}.venue_id`)}))`;

/** Whether this account may hold a credential at this venue now (the fragment names the venue first, then the account). */
export async function mayHoldCredentialAt(adminId: number, venueId: number): Promise<boolean> {
  return !!(await getDb().prepare(`SELECT 1 AS x WHERE ${OWNER_AUTHORITY("?", "?")}`).get(venueId, adminId));
}

export interface StoppedCredential {
  kind: "key" | "webhook";
  id: number;
  venueId: number;
  name: string;
}

/**
 * Stop the credentials a person owns that they no longer have the authority for, and write each down in the staff log (no secret in it):
 * `all` for an account being removed (everything it owns, the account being about to go), otherwise only what its present role and place
 * no longer reach (a manager made front desk). A person's own access ends at the next use whether or not this ran; this is the record.
 */
export async function endOwnedCredentials(
  by: Admin,
  ownerId: number,
  ownerName: string,
  opts: { all: boolean; reason: "owner_removed" | "owner_demoted"; why: string }
): Promise<StoppedCredential[]> {
  const db = getDb();
  const stopped: StoppedCredential[] = [];
  const lost = opts.all ? "TRUE" : `NOT ${OWNER_AUTHORITY("k.owner_admin_id", "k.venue_id")}`;
  const keys = (await db
    .prepare(
      `UPDATE venue_api_keys k SET revoked_at = datetime('now'), revoked_reason = ?
        WHERE k.owner_admin_id = ? AND k.ownership = 'person' AND k.revoked_at IS NULL AND ${lost}
        RETURNING k.id, k.venue_id, k.name`
    )
    .all(opts.reason, ownerId)) as { id: number; venue_id: number; name: string }[];
  for (const k of keys) stopped.push({ kind: "key", id: k.id, venueId: k.venue_id, name: k.name });
  const hooks = (await db
    .prepare(
      `UPDATE webhook_endpoints k SET active = 0, stopped_reason = ?
        WHERE k.owner_admin_id = ? AND k.ownership = 'person' AND k.active = 1 AND ${lost}
        RETURNING k.id, k.venue_id, k.url`
    )
    .all(opts.reason, ownerId)) as { id: number; venue_id: number; url: string }[];
  for (const h of hooks) stopped.push({ kind: "webhook", id: h.id, venueId: h.venue_id, name: h.url });
  for (const s of stopped)
    await logAction(by, {
      venueId: s.venueId,
      action: "integration.changed",
      detail: `${s.kind === "key" ? "API key" : "Webhook"} stopped: ${s.name}. It belonged to ${ownerName}, ${opts.why}`,
    });
  return stopped;
}

export interface CredentialsToReview {
  keys: number;
  webhooks: number;
  /** Whether the venue's calendar feed address is on (anybody who was a manager could have seen it). */
  calendarFeeds: number;
}

/**
 * What a person who is leaving made for their venues that is the venue's (so it was not stopped), and the calendar feeds those venues
 * share: shown to the manager removing them, so each can be rotated if the person is not to be trusted with it. Counts only.
 */
export async function credentialsToReview(adminId: number, venueIds: number[]): Promise<CredentialsToReview> {
  const db = getDb();
  const n = async (sql: string, ...args: unknown[]) => ((await db.prepare(sql).get(...args)) as { n: number }).n;
  const keys = await n("SELECT COUNT(*)::int AS n FROM venue_api_keys WHERE admin_id = ? AND ownership = 'venue' AND revoked_at IS NULL", adminId);
  const webhooks = await n("SELECT COUNT(*)::int AS n FROM webhook_endpoints WHERE admin_id = ? AND ownership = 'venue' AND active = 1", adminId);
  const calendarFeeds =
    venueIds.length === 0
      ? 0
      : await n(`SELECT COUNT(*)::int AS n FROM venues WHERE id IN (${venueIds.map(() => "?").join(",")}) AND calendar_feed_hash IS NOT NULL`, ...venueIds);
  return { keys, webhooks, calendarFeeds };
}
