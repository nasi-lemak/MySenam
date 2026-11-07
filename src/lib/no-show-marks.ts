import { getDb, withTransaction } from "./db";
import { canAccessVenue, isOwner, type Admin } from "./admin-auth";
import { logAction } from "./activity";
import { baseUrl, emailPlayer, type Written } from "./outbox";
import { gameById, NO_SHOW_DAYS, type OpenGame } from "./games";
import { declaredAdult } from "./player-profiles";
import { formatHour, addDays, todayISO } from "./time";

/**
 * A host's no-show mark: reviewable and correctable (ADR 0072, the owner's decision DEC-50).
 *
 * A host marks somebody who was in the game and did not come. The mark used to be a flag that told nobody, could be answered by no
 * one and counted at every venue on the platform, so a misclick or a rival host could shut a person out of every open game. Now a
 * mark is a record on the player's row of the game (`open_game_players`, migration 0341), with:
 *
 * - **a reason**, written by the host, which the player is told (a mark without one is refused);
 * - **a venue**: the venue of the game. By default a mark counts only there (`scope` "venue"): three of them in 90 days stop the
 *   player joining games at that venue. A mark counts at every venue (`scope` "platform") only after the platform owner has reviewed
 *   it and written why; a legacy one whose venue could not be found is `legacy_platform` until the owner reviews it;
 * - **a notice** to the player when it is made and when it is decided (by email; not to an account that said it is under 18, as the
 *   venue's other notices to account holders: such a player's marks are on their own *My games* page and the venue's manager can see
 *   them), and **a way to answer**: the player says what happened, and from then until a reviewer has looked, the mark does not count;
 * - **a review** by the venue's manager (or the platform owner): reverse it, or let it stand; the owner may also make it count at
 *   every venue, with a written justification. A reversal sets `no_show` back to 0 and keeps the row, the reason and who reversed it;
 * - **the host's own way out**: a host can take back a mark they made (a misclick), whatever its state, with no review needed.
 *
 * Against fraud (each limit is a constant below): a mark can be made only in the days after the game, a host can make only so many in
 * a week, a player has only so many answers open at once and loses the right to answer new marks after repeated answers that a
 * reviewer did not accept, and a host whose marks are often reversed is shown to the venue's staff and the owner (`noShowAttention`).
 * Every state change is made under the row's lock, so two answers, or a reversal and a new mark, cannot both win.
 */

/** A mark has a reason of this many characters (after trimming); the player is shown it. */
export const MARK_REASON_MIN = 3;
export const MARK_REASON_MAX = 300;
/** A host can mark somebody only this many days after the game. */
export const MARK_WINDOW_DAYS = 7;
/** The most marks one host can make in seven days. */
export const HOST_MARKS_PER_WEEK = 12;
/** What a player says in answer to a mark. */
export const ANSWER_MIN = 3;
export const ANSWER_MAX = 500;
/** Answers a player can have waiting for a review at once. */
export const MAX_OPEN_ANSWERS = 3;
/** After this many answers a reviewer let stand in DISPUTE_CAP_DAYS, new marks cannot be answered here: ask the venue. */
export const DISPUTE_LOSS_CAP = 3;
export const DISPUTE_CAP_DAYS = 180;
/** A host with this many marks reversed by a reviewer in HOST_FLAG_DAYS is shown to staff. */
export const HOST_REVERSED_FLAG = 3;
export const HOST_FLAG_DAYS = 180;

export type MarkStatus = "in_force" | "disputed" | "upheld" | "reversed" | "withdrawn";
export type MarkScope = "venue" | "platform" | "legacy_platform";

export type MarkResult = { ok: true } | { ok: false; error: string; status?: number; code?: string; vars?: Record<string, string | number> };

const refuse = (error: string, code: string, status = 409): MarkResult => ({ ok: false, error, code, status });

/** Whole days since a stored UTC stamp ("2026-11-07 09:30:00"). */
const daysSince = (stamp: string) => Math.max(0, Math.floor((Date.now() - Date.parse(`${stamp.replace(" ", "T")}Z`)) / 86_400_000));

const clean = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

interface Row {
  id: number;
  user_id: number;
  status: string;
  no_show_status: MarkStatus | null;
  no_show_scope: MarkScope | null;
  no_show_venue_id: number | null;
  no_show_at: string | null;
  game_id: number;
  host_id: number;
  date: string;
  venue_id: number;
}

/** A player's row of a game, locked until the transaction ends, with what a decision about its mark needs. */
async function lockRow(playerId: number): Promise<Row | undefined> {
  return (await getDb()
    .prepare(
      `SELECT p.id, p.user_id, p.status, COALESCE(p.no_show_status, CASE WHEN p.no_show = 1 THEN 'in_force' END) AS no_show_status, p.no_show_scope, p.no_show_venue_id, p.no_show_at,
              g.id AS game_id, g.host_id, b.date, c.venue_id
         FROM open_game_players p
         JOIN open_games g ON g.id = p.game_id
         JOIN bookings b ON b.id = g.booking_id
         JOIN courts c ON c.id = b.court_id
        WHERE p.id = ? FOR UPDATE OF p`
    )
    .get(playerId)) as Row | undefined;
}

// ------------------------------------------------------------ telling the player

type Told = "marked" | "reversed" | "upheld" | "platform";

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;
const whenOf = (g: OpenGame, locale: string) => `${g.date} ${formatHour(g.startHour, locale)}–${formatHour(g.endHour, locale)}`;

/**
 * The player's email about their mark, in their language, through the outbox (`no_show_notice`: the venue's decision about a person,
 * so not held to the day's limit). Not to an account that said it is under 18 (the venue's other notices to account holders do the same).
 * Once per change: keyed by the mark and the stamp of what happened.
 */
async function tell(playerRow: { id: number; user_id: number }, game: OpenGame, what: Told, stamp: string, reason?: string | null): Promise<void> {
  if ((await declaredAdult(playerRow.user_id)) === false) return;
  const vars = (tr: { locale: string }) => ({
    venue: game.venueName,
    host: firstName(game.hostName),
    when: whenOf(game, tr.locale),
    reason: reason ?? "",
    days: NO_SHOW_DAYS,
    n: 3,
  });
  const subject: Written = (tr) => tr(`ppl.mail.${what}.s`, vars(tr));
  const body: Written = (tr) => tr(`ppl.mail.${what}.b`, vars(tr));
  await emailPlayer({
    venueId: game.venueId,
    userId: playerRow.user_id,
    subject,
    body,
    link: `${baseUrl()}/games`,
    kind: "no_show_notice",
    dedupeKey: `no-show:${what}:${playerRow.id}:${stamp}`,
  });
}

// ------------------------------------------------------------ the host

/**
 * The host marks somebody who was in the game and did not come, with the reason. The checks that decide() makes (the game's
 * host, the player was in it, the game has started) are made again here under the row's lock.
 */
export async function markNoShow(hostId: number, playerId: number, reason: unknown): Promise<MarkResult> {
  const why = clean(reason);
  if (why.length < MARK_REASON_MIN || why.length > MARK_REASON_MAX)
    return refuse(`Say what happened, in a few words (at most ${MARK_REASON_MAX} characters): the player is shown it.`, "NS_REASON", 400);
  const db = getDb();
  const done = await withTransaction(async (): Promise<MarkResult & { stamp?: string }> => {
    const row = await lockRow(playerId);
    if (!row || row.host_id !== hostId) return { ok: false, error: "Not found.", status: 404 };
    if (row.status !== "accepted") return refuse("Only somebody who was in the game can miss it.", "NS_NOT_IN", 409);
    if (row.no_show_status === "reversed" || row.no_show_status === "withdrawn")
      return refuse("That mark was taken back, so it cannot be made again.", "NS_TAKEN_BACK");
    // A double click, or a second tab: the mark is made once, and the player told once.
    if (row.no_show_status !== null) return { ok: true };
    if (row.date < addDays(todayISO(), -MARK_WINDOW_DAYS))
      return refuse(`A mark can be made only within ${MARK_WINDOW_DAYS} days of the game.`, "NS_TOO_LATE");
    const week = (await db
      .prepare(
        `SELECT COUNT(*)::int AS n FROM open_game_players p JOIN open_games g ON g.id = p.game_id
          WHERE g.host_id = ? AND p.no_show_at >= datetime('now', '-7 days')`
      )
      .get(hostId)) as { n: number };
    if (week.n >= HOST_MARKS_PER_WEEK) return refuse(`You have marked ${HOST_MARKS_PER_WEEK} players in the last 7 days. Ask the venue to look at the rest.`, "NS_HOST_LIMIT", 429);
    await db
      .prepare(
        `UPDATE open_game_players
            SET no_show = 1, no_show_status = 'in_force', no_show_scope = 'venue', no_show_venue_id = ?, no_show_reason = ?, no_show_at = datetime('now'),
                no_show_dispute_note = NULL, no_show_disputed_at = NULL, no_show_reviewed_by = NULL, no_show_reviewed_at = NULL,
                no_show_review_note = NULL, no_show_platform_note = NULL
          WHERE id = ?`
      )
      .run(row.venue_id, why, playerId);
    const at = (await db.prepare("SELECT no_show_at FROM open_game_players WHERE id = ?").get(playerId)) as { no_show_at: string };
    return { ok: true, stamp: at.no_show_at };
  });
  if (!done.ok || !done.stamp) return done;
  const row = (await db.prepare("SELECT id, user_id, game_id FROM open_game_players WHERE id = ?").get(playerId)) as { id: number; user_id: number; game_id: number };
  const game = await gameById(row.game_id);
  if (game) await tell(row, game, "marked", done.stamp, why);
  return { ok: true };
}

/** The host takes back a mark they made (a misclick, a player who did come): no review is needed, and the player is told. */
export async function withdrawNoShow(hostId: number, playerId: number): Promise<MarkResult> {
  const db = getDb();
  const done = await withTransaction(async (): Promise<MarkResult & { stamp?: string }> => {
    const row = await lockRow(playerId);
    if (!row || row.host_id !== hostId) return { ok: false, error: "Not found.", status: 404 };
    if (row.no_show_status !== "in_force" && row.no_show_status !== "disputed" && row.no_show_status !== "upheld")
      return refuse("There is no mark to take back.", "NS_NONE");
    // A mark a reviewer let stand, or the owner made count everywhere, is theirs to undo, not the host's.
    if (row.no_show_status === "upheld") return refuse("A reviewer let this mark stand: ask the venue to take it back.", "NS_REVIEWED");
    await db
      .prepare(
        `UPDATE open_game_players SET no_show = 0, no_show_status = 'withdrawn', no_show_reviewed_at = datetime('now'), no_show_review_note = 'Taken back by the host'
          WHERE id = ?`
      )
      .run(playerId);
    const at = (await db.prepare("SELECT no_show_reviewed_at AS at FROM open_game_players WHERE id = ?").get(playerId)) as { at: string };
    return { ok: true, stamp: at.at };
  });
  if (!done.ok || !done.stamp) return done;
  const game = await gameById(((await db.prepare("SELECT game_id FROM open_game_players WHERE id = ?").get(playerId)) as { game_id: number }).game_id);
  const row = (await db.prepare("SELECT id, user_id FROM open_game_players WHERE id = ?").get(playerId)) as { id: number; user_id: number };
  if (game) await tell(row, game, "reversed", done.stamp);
  return { ok: true };
}

// ------------------------------------------------------------ the player

/** Why this player cannot answer a new mark here (the limits above), or null. */
async function answerRefusal(userId: number): Promise<MarkResult | null> {
  const db = getDb();
  const open = (await db.prepare("SELECT COUNT(*)::int AS n FROM open_game_players WHERE user_id = ? AND no_show_status = 'disputed'").get(userId)) as { n: number };
  if (open.n >= MAX_OPEN_ANSWERS) return refuse("You already have answers waiting for a review. Wait for them to be looked at, or ask the venue.", "NS_OPEN_LIMIT", 429);
  const lost = (await db
    .prepare(
      `SELECT COUNT(*)::int AS n FROM open_game_players
        WHERE user_id = ? AND no_show_disputed_at IS NOT NULL AND no_show_status = 'upheld' AND no_show_reviewed_at >= datetime('now', ?)`
    )
    .get(userId, `-${DISPUTE_CAP_DAYS} days`)) as { n: number };
  if (lost.n >= DISPUTE_LOSS_CAP) return refuse("Several of your answers were looked at and the marks stand. Please ask the venue about this one.", "NS_DISPUTE_CAP", 429);
  return null;
}

/**
 * The player says a mark is wrong. From now until a reviewer has looked, it does not count. Once per mark; an answer is not a second
 * chance after a review. Held to the limits above.
 */
export async function answerNoShow(userId: number, playerId: number, note: unknown): Promise<MarkResult> {
  const said = clean(note);
  if (said.length < ANSWER_MIN || said.length > ANSWER_MAX) return refuse(`Say what happened, in a few words (at most ${ANSWER_MAX} characters).`, "NS_ANSWER", 400);
  return withTransaction(async (): Promise<MarkResult> => {
    const row = await lockRow(playerId);
    if (!row || row.user_id !== userId) return { ok: false, error: "Not found.", status: 404 };
    if (row.no_show_status === null) return { ok: false, error: "Not found.", status: 404 };
    if (row.no_show_status === "disputed") return refuse("You have answered this already: it is waiting for a review.", "NS_ANSWERED");
    if (row.no_show_status === "upheld") return refuse("This mark was looked at and stands. Please ask the venue.", "NS_REVIEWED");
    if (row.no_show_status !== "in_force") return refuse("That mark was taken back.", "NS_TAKEN_BACK");
    if (row.date < addDays(todayISO(), -NO_SHOW_DAYS)) return refuse("That mark no longer counts.", "NS_EXPIRED");
    const blocked = await answerRefusal(userId);
    if (blocked) return blocked;
    await getDb()
      .prepare("UPDATE open_game_players SET no_show_status = 'disputed', no_show_dispute_note = ?, no_show_disputed_at = datetime('now') WHERE id = ?")
      .run(said, playerId);
    return { ok: true };
  });
}

export interface MyMark {
  playerId: number;
  gameId: number;
  venueName: string;
  date: string;
  startHour: number;
  hostName: string;
  /** Null for a mark made before reasons were kept. */
  reason: string | null;
  status: MarkStatus;
  scope: MarkScope;
  /** What the player answered. */
  answer: string | null;
  /** The mark stands, and the player may still answer it. */
  canAnswer: boolean;
  /** Counts towards stopping them joining games (a mark answered and waiting for a review does not). */
  counts: boolean;
}

/** The marks that count against a player or wait for a review, from the last NO_SHOW_DAYS days: what they may answer. */
export async function myNoShowMarks(userId: number): Promise<MyMark[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT p.id, g.id AS game_id, v.name AS venue, b.date, b.start_min, u.name AS host, p.no_show_reason, p.no_show_status, COALESCE(p.no_show_scope, 'legacy_platform') AS scope,
              p.no_show_dispute_note
         FROM open_game_players p
         JOIN open_games g ON g.id = p.game_id JOIN users u ON u.id = g.host_id
         JOIN bookings b ON b.id = g.booking_id JOIN courts c ON c.id = b.court_id JOIN venues v ON v.id = c.venue_id
        WHERE p.user_id = ? AND p.no_show = 1 AND b.date >= ?
        ORDER BY b.date DESC, p.id DESC`
    )
    .all(userId, addDays(todayISO(), -NO_SHOW_DAYS))) as {
    id: number; game_id: number; venue: string; date: string; start_min: number; host: string; no_show_reason: string | null;
    no_show_status: MarkStatus | null; scope: MarkScope; no_show_dispute_note: string | null;
  }[];
  const blocked = rows.some((r) => (r.no_show_status ?? "in_force") === "in_force") ? await answerRefusal(userId) : null;
  return rows.map((r) => {
    const status = r.no_show_status ?? "in_force";
    return {
      playerId: r.id,
      gameId: r.game_id,
      venueName: r.venue,
      date: r.date,
      startHour: r.start_min / 60,
      hostName: firstName(r.host),
      reason: r.no_show_reason,
      status,
      scope: r.scope,
      answer: r.no_show_dispute_note,
      canAnswer: status === "in_force" && blocked === null,
      counts: status === "in_force" || status === "upheld",
    };
  });
}

// ------------------------------------------------------------ the reviewer

export type Decision = "reverse" | "uphold" | "platform";

export interface MarkView {
  id: number;
  gameId: number;
  venueId: number;
  venueName: string;
  date: string;
  startHour: number;
  /** First names only. */
  playerName: string;
  hostName: string;
  /** Null for a mark made before reasons were kept. */
  reason: string | null;
  status: MarkStatus;
  scope: MarkScope;
  markedAt: string | null;
  answer: string | null;
  answeredAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  platformNote: string | null;
  /** Days the player's answer has waited, for an answer not yet reviewed. */
  waitingDays: number | null;
  may: { reverse: boolean; uphold: boolean; platform: boolean };
}

/** What this staff member may do with a mark in this state. A venue's manager: its own venue-scoped marks. The platform owner: any. Front desk: nothing. */
function mayDo(admin: Admin, m: { venueId: number | null; scope: MarkScope; status: MarkStatus }): MarkView["may"] {
  const owner = isOwner(admin);
  const own = !owner && admin.role !== "desk" && m.venueId !== null && canAccessVenue(admin, m.venueId) && m.scope === "venue";
  const open = m.status === "in_force" || m.status === "disputed";
  return {
    reverse: (owner || own) && (open || m.status === "upheld"),
    uphold: (owner || own) && open,
    platform: owner && m.scope !== "platform" && (open || m.status === "upheld"),
  };
}

/** A review: reverse a mark, let it stand, or (the platform owner only, with a written justification) make it count at every venue. */
export async function reviewNoShow(admin: Admin, playerId: number, decision: unknown, note: unknown): Promise<MarkResult> {
  if (decision !== "reverse" && decision !== "uphold" && decision !== "platform") return refuse("Reverse it, let it stand, or make it count everywhere.", "NS_DECISION", 400);
  const why = clean(note);
  if (why.length < ANSWER_MIN || why.length > ANSWER_MAX)
    return refuse(decision === "platform" ? "Write why this mark should count at every venue." : "Say why, in a few words.", "NS_REVIEW_NOTE", 400);
  const db = getDb();
  const done = await withTransaction(async (): Promise<MarkResult & { stamp?: string; venueId?: number | null }> => {
    const row = await lockRow(playerId);
    if (!row || row.no_show_status === null) return { ok: false, error: "Not found.", status: 404 };
    const venueId = row.no_show_venue_id;
    const scope: MarkScope = row.no_show_scope ?? "legacy_platform";
    // A venue's manager is told "not found" for a mark at another venue, as for a game that is not there.
    if (!isOwner(admin) && (venueId === null || !canAccessVenue(admin, venueId))) return { ok: false, error: "Not found.", status: 404 };
    const may = mayDo(admin, { venueId, scope, status: row.no_show_status });
    if (admin.role === "desk" && !isOwner(admin)) return { ok: false, error: "Only a manager reviews a mark.", status: 403, code: "MANAGER_ONLY" };
    if (!may[decision]) {
      if (decision === "platform" || scope !== "venue")
        return { ok: false, error: "Only the platform owner decides a mark that counts at every venue.", status: 403, code: "NS_OWNER_ONLY" };
      return refuse("That mark is not waiting for a decision.", "NS_STATE");
    }
    const set =
      decision === "reverse"
        ? "no_show = 0, no_show_status = 'reversed'"
        : decision === "uphold"
          ? "no_show_status = 'upheld'"
          : "no_show_status = 'upheld', no_show_scope = 'platform', no_show_platform_note = ?";
    await db
      .prepare(`UPDATE open_game_players SET ${set}, no_show_reviewed_by = ?, no_show_reviewed_at = datetime('now'), no_show_review_note = ? WHERE id = ?`)
      .run(...(decision === "platform" ? [why] : []), admin.id, why, playerId);
    const at = (await db.prepare("SELECT no_show_reviewed_at AS at FROM open_game_players WHERE id = ?").get(playerId)) as { at: string };
    return { ok: true, stamp: at.at, venueId };
  });
  if (!done.ok) return done;
  await logAction(admin, { venueId: done.venueId ?? null, action: "no-show.reviewed", detail: `Mark ${playerId}: ${decision}. ${why}`.slice(0, 480) });
  const row = (await db.prepare("SELECT id, user_id, game_id, no_show_reason FROM open_game_players WHERE id = ?").get(playerId)) as { id: number; user_id: number; game_id: number; no_show_reason: string | null };
  const game = await gameById(row.game_id);
  if (game && done.stamp) await tell(row, game, decision === "reverse" ? "reversed" : decision === "uphold" ? "upheld" : "platform", done.stamp);
  return { ok: true };
}

const MARK_SELECT = `SELECT p.id, g.id AS game_id, c.venue_id, v.name AS venue, b.date, b.start_min, pu.name AS player, hu.name AS host,
       p.no_show_reason, COALESCE(p.no_show_status, 'in_force') AS no_show_status, COALESCE(p.no_show_scope, 'legacy_platform') AS scope, p.no_show_at, p.no_show_dispute_note, p.no_show_disputed_at,
       a.name AS reviewer, p.no_show_reviewed_at, p.no_show_review_note, p.no_show_platform_note
  FROM open_game_players p
  JOIN open_games g ON g.id = p.game_id JOIN users pu ON pu.id = p.user_id JOIN users hu ON hu.id = g.host_id
  JOIN bookings b ON b.id = g.booking_id JOIN courts c ON c.id = b.court_id JOIN venues v ON v.id = c.venue_id
  LEFT JOIN admins a ON a.id = p.no_show_reviewed_by`;

/** The staff member's reach: a venue's manager sees marks made at their venues; the platform owner, all. */
function reach(admin: Admin): { sql: string; args: number[] } {
  if (isOwner(admin)) return { sql: "TRUE", args: [] };
  const ids = admin.venueIds ?? [];
  return ids.length === 0 ? { sql: "FALSE", args: [] } : { sql: `c.venue_id IN (${ids.map(() => "?").join(",")})`, args: ids };
}

/**
 * Marks for a manager or the owner: `review` (answers waiting for a decision, oldest first; for the owner also legacy platform-wide marks), or
 * `recent` (every mark from the last NO_SHOW_DAYS days, newest first).
 */
export async function listNoShowMarks(admin: Admin, show: "review" | "recent"): Promise<MarkView[]> {
  if (admin.role === "desk" && !isOwner(admin)) return [];
  const r = reach(admin);
  const where =
    show === "review"
      ? `p.no_show_status = 'disputed'${isOwner(admin) ? " OR (COALESCE(p.no_show_status, 'in_force') = 'in_force' AND p.no_show = 1 AND COALESCE(p.no_show_scope, 'legacy_platform') = 'legacy_platform')" : ""}`
      : "(p.no_show_status IS NOT NULL OR p.no_show = 1) AND b.date >= ?";
  const rows = (await getDb()
    .prepare(`${MARK_SELECT} WHERE (${where}) AND ${r.sql} ORDER BY ${show === "review" ? "COALESCE(p.no_show_disputed_at, '0000') , p.id" : "b.date DESC, p.id DESC"} LIMIT 100`)
    .all(...(show === "recent" ? [addDays(todayISO(), -NO_SHOW_DAYS)] : []), ...r.args)) as {
    id: number; game_id: number; venue_id: number; venue: string; date: string; start_min: number; player: string; host: string;
    no_show_reason: string | null; no_show_status: MarkStatus; scope: MarkScope; no_show_at: string | null; no_show_dispute_note: string | null;
    no_show_disputed_at: string | null; reviewer: string | null; no_show_reviewed_at: string | null; no_show_review_note: string | null;
    no_show_platform_note: string | null;
  }[];
  return rows.map((m) => ({
    id: m.id,
    gameId: m.game_id,
    venueId: m.venue_id,
    venueName: m.venue,
    date: m.date,
    startHour: m.start_min / 60,
    playerName: firstName(m.player),
    hostName: firstName(m.host),
    reason: m.no_show_reason,
    status: m.no_show_status,
    scope: m.scope,
    markedAt: m.no_show_at,
    answer: m.no_show_dispute_note,
    answeredAt: m.no_show_disputed_at,
    reviewedBy: m.reviewer,
    reviewedAt: m.no_show_reviewed_at,
    reviewNote: m.no_show_review_note,
    platformNote: m.no_show_platform_note,
    waitingDays: m.no_show_status === "disputed" && m.no_show_disputed_at ? daysSince(m.no_show_disputed_at) : null,
    may: mayDo(admin, { venueId: m.venue_id, scope: m.scope, status: m.no_show_status }),
  }));
}

export interface FlaggedHost {
  hostId: number;
  /** First name only. */
  name: string;
  reversed: number;
  marked: number;
}

/** Hosts whose marks reviewers reversed HOST_REVERSED_FLAG times or more lately, among the marks this staff member can see. */
export async function flaggedHosts(admin: Admin): Promise<FlaggedHost[]> {
  if (admin.role === "desk" && !isOwner(admin)) return [];
  const r = reach(admin);
  const rows = (await getDb()
    .prepare(
      `SELECT g.host_id, hu.name, COUNT(*) FILTER (WHERE p.no_show_status = 'reversed')::int AS reversed, COUNT(*)::int AS marked
         FROM open_game_players p
         JOIN open_games g ON g.id = p.game_id JOIN users hu ON hu.id = g.host_id
         JOIN bookings b ON b.id = g.booking_id JOIN courts c ON c.id = b.court_id
        WHERE p.no_show_status IS NOT NULL AND b.date >= ? AND ${r.sql}
        GROUP BY g.host_id, hu.name
       HAVING COUNT(*) FILTER (WHERE p.no_show_status = 'reversed') >= ?
        ORDER BY 3 DESC, g.host_id`
    )
    .all(addDays(todayISO(), -HOST_FLAG_DAYS), ...r.args, HOST_REVERSED_FLAG)) as { host_id: number; name: string; reversed: number; marked: number }[];
  return rows.map((h) => ({ hostId: h.host_id, name: firstName(h.name), reversed: h.reversed, marked: h.marked }));
}

export interface NoShowAttention {
  /** Answers waiting for a decision, and the days the oldest has waited. */
  answersWaiting: number;
  oldestWaitingDays: number;
  /** The owner's: marks from before scopes that count everywhere and have not been reviewed. */
  legacyPlatform: number;
  hosts: FlaggedHost[];
}

/** The needs-attention lines about no-show marks for a manager or the owner; null for front desk. */
export async function noShowAttention(admin: Admin): Promise<NoShowAttention | null> {
  if (admin.role === "desk" && !isOwner(admin)) return null;
  const waiting = await listNoShowMarks(admin, "review");
  const answers = waiting.filter((m) => m.status === "disputed");
  return {
    answersWaiting: answers.length,
    oldestWaitingDays: answers.reduce((n, m) => Math.max(n, m.waitingDays ?? 0), 0),
    legacyPlatform: waiting.filter((m) => m.status === "in_force").length,
    hosts: await flaggedHosts(admin),
  };
}
