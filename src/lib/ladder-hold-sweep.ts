import { getDb } from "./db";

/**
 * A ladder hold that was not confirmed in time lets go of its court (docs/architecture/decisions/0048-ladder-hold-limits-and-expiry.md).
 *
 * This is the whole of it, and it depends on nothing but the database, so the claim path (lib/claims.ts `releaseExpiredOffers`) can run it
 * without a cycle: the hold is marked released (reason `expired`, by `system`) and the blocks it owns are deleted, which takes their claims with
 * them. It is atomic and idempotent: the UPDATE only finds a hold that is still unreleased, unconfirmed and past its time, so two sweeps, a
 * sweep and a confirmation, or a sweep and a manager's release each act on a hold at most once, and the loser finds nothing to do. It tells
 * nobody and touches no challenge: the scheduler does that, once (lib/ladders.ts `tellExpiredHolds`), from the rows this leaves with
 * `released_reason = 'expired'` and `expiry_told_at` empty.
 *
 * Availability does not wait for it: a tentative hold's block claims carry the hold's `confirm_by` as their `expires_at`, and every availability
 * read ignores a claim past its time (lib/claims.ts `occupantsOn`), so an expired hold never keeps a court from a booking even if this has not run.
 */
export async function sweepExpiredHolds(): Promise<{ id: number; challengeId: number; ladderId: number }[]> {
  const db = getDb();
  const rows = (await db
    .prepare(
      `UPDATE ladder_court_holds
          SET released_at = datetime('now'), released_reason = 'expired', released_by = 'system'
        WHERE released_at IS NULL AND confirmed_at IS NULL AND confirm_by IS NOT NULL AND confirm_by <= now()
        RETURNING id, challenge_id, ladder_id`
    )
    .all()) as { id: number; challenge_id: number; ladder_id: number }[];
  if (rows.length > 0) await db.prepare(`DELETE FROM blocks WHERE ladder_hold_id IN (${rows.map(() => "?").join(",")})`).run(...rows.map((r) => r.id));
  return rows.map((r) => ({ id: r.id, challengeId: r.challenge_id, ladderId: r.ladder_id }));
}
