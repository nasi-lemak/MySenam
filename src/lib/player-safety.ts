import { getDb, withTransaction } from "./db";

/**
 * Keeping players safe from each other: blocking, and reporting somebody to
 * the platform's owners.
 *
 * A block works both ways and says nothing: neither is suggested to the
 * other, neither can invite the other, and neither can join a game the other
 * hosts or is playing in — refused in the same words as any game that is not
 * open to them, so a block cannot be found out by trying. Blocking also
 * withdraws any invitation between them and turns down anything the blocked
 * player asked of the blocker's games still waiting for an answer, quietly.
 * Somebody already in the blocker's game stays until the host takes them
 * out, because a paid share may hang on it (lib/games.ts, decide).
 *
 * Somebody can block or report only a person they have come across here:
 * a host and a player in their game, two players in the same game, an
 * invitation either way, or the same community group. Nobody can walk
 * account numbers to learn names.
 */

export const REASONS = ["no_show", "abuse", "spam", "safety", "other"] as const;
export type ReportReason = (typeof REASONS)[number];
/** Reports one player can make in a day: plenty for real trouble, too few to flood. */
export const REPORTS_PER_DAY = 10;

/** Whether either of the two has blocked the other. */
export async function blockedBetween(a: number, b: number): Promise<boolean> {
  return Boolean(
    await getDb()
      .prepare("SELECT 1 FROM player_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)")
      .get(a, b, b, a)
  );
}

/** Whether somebody and the host, or anybody in the game or holding a place in it, have blocked one another. */
export async function blockedInGame(userId: number, gameId: number): Promise<boolean> {
  return Boolean(
    await getDb()
      .prepare(
        `SELECT 1 FROM player_blocks k
          WHERE (k.blocker_id = ? AND k.blocked_id IN (SELECT host_id FROM open_games WHERE id = ?
                   UNION SELECT user_id FROM open_game_players WHERE game_id = ? AND status IN ('accepted', 'offered')))
             OR (k.blocked_id = ? AND k.blocker_id IN (SELECT host_id FROM open_games WHERE id = ?
                   UNION SELECT user_id FROM open_game_players WHERE game_id = ? AND status IN ('accepted', 'offered')))
          LIMIT 1`
      )
      .get(userId, gameId, gameId, userId, gameId, gameId)
  );
}

/** Whether the two have come across each other here (see above). */
export async function related(a: number, b: number): Promise<boolean> {
  if (a === b) return false;
  return Boolean(
    await getDb()
      .prepare(
        `SELECT 1 FROM open_game_players p JOIN open_games g ON g.id = p.game_id
          WHERE (g.host_id = ? AND p.user_id = ?) OR (g.host_id = ? AND p.user_id = ?)
             OR (p.user_id = ? AND p.invited_by = ?) OR (p.user_id = ? AND p.invited_by = ?)
         UNION ALL
         SELECT 1 FROM open_game_players p1 JOIN open_game_players p2 ON p2.game_id = p1.game_id
          WHERE p1.user_id = ? AND p2.user_id = ? AND p1.status = 'accepted' AND p2.status = 'accepted'
         UNION ALL
         SELECT 1 FROM group_members m1 JOIN group_members m2 ON m2.group_id = m1.group_id
           JOIN community_groups cg ON cg.id = m1.group_id AND cg.status = 'active'
          WHERE m1.user_id = ? AND m2.user_id = ? AND m1.status = 'member' AND m2.status = 'member'
          LIMIT 1`
      )
      .get(a, b, b, a, a, b, b, a, a, b, a, b)
  );
}

export type SafetyResult = { ok: true } | { ok: false; error: string; status?: number };

/** `opts.related`: the caller has already shown the two share a context (a message thread, lib/messages.ts), so `related` is not asked again. */
export async function blockPlayer(blockerId: number, blockedId: number, opts: { related?: boolean } = {}): Promise<SafetyResult> {
  if (blockerId === blockedId) return { ok: false, error: "You can block only somebody you have played with or been invited by.", status: 404 };
  if (!opts.related && !(await related(blockerId, blockedId))) return { ok: false, error: "You can block only somebody you have played with or been invited by.", status: 404 };
  await withTransaction(async () => {
    const db = getDb();
    await db.prepare("INSERT INTO player_blocks (blocker_id, blocked_id) VALUES (?, ?) ON CONFLICT DO NOTHING").run(blockerId, blockedId);
    // Invitations either way are withdrawn.
    await db
      .prepare(
        `UPDATE open_game_players SET status = 'removed', decided_at = datetime('now')
          WHERE status = 'invited' AND ((user_id = ? AND invited_by = ?) OR (user_id = ? AND invited_by = ?))`
      )
      .run(blockerId, blockedId, blockedId, blockerId);
    // What they asked of the blocker's games and is still waiting is turned down.
    await db
      .prepare(
        `UPDATE open_game_players SET status = 'declined', decided_at = datetime('now')
          WHERE user_id = ? AND status IN ('requested', 'waitlisted', 'invited')
            AND game_id IN (SELECT id FROM open_games WHERE host_id = ?)`
      )
      .run(blockedId, blockerId);
    await db
      .prepare(
        `UPDATE group_members SET status = 'declined' WHERE user_id = ? AND status IN ('invited', 'requested')
            AND group_id IN (SELECT id FROM community_groups WHERE organiser_id = ?)`
      )
      .run(blockedId, blockerId);
  });
  return { ok: true };
}

export async function unblockPlayer(blockerId: number, blockedId: number): Promise<void> {
  await getDb().prepare("DELETE FROM player_blocks WHERE blocker_id = ? AND blocked_id = ?").run(blockerId, blockedId);
}

/** Who somebody has blocked, by first name, to undo it. */
export async function myBlocks(userId: number): Promise<{ userId: number; name: string; since: string }[]> {
  const rows = (await getDb()
    .prepare("SELECT k.blocked_id, u.name, k.created_at FROM player_blocks k JOIN users u ON u.id = k.blocked_id WHERE k.blocker_id = ? ORDER BY k.created_at DESC")
    .all(userId)) as { blocked_id: number; name: string; created_at: string }[];
  return rows.map((r) => ({ userId: r.blocked_id, name: r.name.trim().split(/\s+/)[0], since: r.created_at }));
}

export async function reportPlayer(
  reporterId: number,
  input: { userId: number; gameId?: number | null; reason: unknown; note?: unknown }
): Promise<SafetyResult> {
  if (!(REASONS as readonly unknown[]).includes(input.reason)) return { ok: false, error: "What is the report about?" };
  if (!(await related(reporterId, input.userId))) return { ok: false, error: "You can report only somebody you have played with or been invited by.", status: 404 };
  const db = getDb();
  const today = (await db
    .prepare("SELECT COUNT(*)::int AS n FROM player_reports WHERE reporter_id = ? AND created_at >= datetime('now', '-1 day')")
    .get(reporterId)) as { n: number };
  if (today.n >= REPORTS_PER_DAY) return { ok: false, error: "You have sent a lot of reports today. Please try again tomorrow.", status: 429 };
  // One open report about the same person is enough; a second adds nothing.
  if (await db.prepare("SELECT 1 FROM player_reports WHERE reporter_id = ? AND reported_id = ? AND status = 'open'").get(reporterId, input.userId))
    return { ok: true };
  await db
    .prepare("INSERT INTO player_reports (reporter_id, reported_id, game_id, reason, note) VALUES (?, ?, ?, ?, ?)")
    .run(reporterId, input.userId, input.gameId ?? null, input.reason, typeof input.note === "string" ? input.note.trim().slice(0, 1000) || null : null);
  return { ok: true };
}

export interface PlayerReport {
  id: number;
  reason: ReportReason;
  note: string | null;
  status: "open" | "reviewed";
  createdAt: string;
  reporter: { id: number; name: string; email: string } | null;
  reported: { id: number; name: string; email: string; reports: number } | null;
  gameId: number | null;
}

/** For the platform's owners: reports, open first, newest first, a page at a time. */
export async function listPlayerReports(filter: { status?: "open" | "reviewed"; before?: number; limit?: number } = {}): Promise<PlayerReport[]> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const rows = (await getDb()
    .prepare(
      `SELECT r.id, r.reason, r.note, r.status, r.created_at, r.game_id,
              a.id AS a_id, a.name AS a_name, a.email AS a_email,
              b.id AS b_id, b.name AS b_name, b.email AS b_email,
              (SELECT COUNT(*)::int FROM player_reports x WHERE x.reported_id = r.reported_id) AS b_reports
         FROM player_reports r LEFT JOIN users a ON a.id = r.reporter_id LEFT JOIN users b ON b.id = r.reported_id
        WHERE (?::text IS NULL OR r.status = ?) AND (?::int IS NULL OR r.id < ?)
        ORDER BY r.id DESC LIMIT ?`
    )
    .all(filter.status ?? null, filter.status ?? null, filter.before ?? null, filter.before ?? null, limit)) as {
    id: number; reason: ReportReason; note: string | null; status: "open" | "reviewed"; created_at: string; game_id: number | null;
    a_id: number | null; a_name: string | null; a_email: string | null; b_id: number | null; b_name: string | null; b_email: string | null; b_reports: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    reason: r.reason,
    note: r.note,
    status: r.status,
    createdAt: r.created_at,
    gameId: r.game_id,
    reporter: r.a_id === null ? null : { id: r.a_id, name: r.a_name!, email: r.a_email! },
    reported: r.b_id === null ? null : { id: r.b_id, name: r.b_name!, email: r.b_email!, reports: r.b_reports },
  }));
}

export async function reviewPlayerReport(id: number): Promise<boolean> {
  const done = await getDb()
    .prepare("UPDATE player_reports SET status = 'reviewed', reviewed_at = datetime('now') WHERE id = ? AND status = 'open'")
    .run(id);
  return done.changes > 0;
}
