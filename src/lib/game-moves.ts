import { getDb, withTransaction } from "./db";
import { release } from "./claims";
import { formatMinute, instantOf } from "./interval";
import { baseUrl, emailPlayer, sentences, type Written } from "./outbox";
import { money } from "./region";
import { changeDeadline, rescheduleBooking, type RescheduleResult } from "./store";
import { gameById, gamePlayers, gameTimeChanged, moveOf, pendingMove, resumeGame, type GameMove, type OpenGame } from "./games";
import type { Refusal } from "./types";
import type { CoachChange } from "./lesson-coaches";

/**
 * Moving an open game to another time.
 *
 * The game is its host's booking, so moving the game is moving the booking
 * (lib/store.ts, rescheduleBooking), with the same rules on what is free,
 * how long it may be, what it costs and who may go past the court's rules.
 * What the game adds is the people in it:
 *
 *   - Called off: nothing; the booking moves like any other, and the game
 *     keeps where and when it was (open_games.was_*).
 *   - Nobody in it yet: the game moves with its booking; whoever asked, was
 *     invited, is waiting or holds a place hears the new time.
 *   - Players in it: never moved behind their backs.
 *       · Its host proposes a new time. The new time is held on the court (a
 *         claim of kind 'move', as a waiting-list offer holds one) while the
 *         booking keeps its own; each player says yes or leaves (a share
 *         paid is owed back, as whenever somebody leaves). Once every player
 *         has answered, the booking moves onto the time held, in one
 *         transaction. Silence is not a yes: a proposal nobody finished
 *         answering runs out, the hold goes, and the game stays where it was.
 *       · A venue manager can change it at once, with a reason, when the
 *         venue has to (a court out of action, say). The players are told
 *         why, and each confirms they are still coming or leaves; until they
 *         do, the host sees who has not confirmed.
 *   - Begun or over: its time stays as it was played.
 *
 * Nobody can join while a proposal waits, so nobody is moved without being
 * asked; the places waiting are passed on once it ends.
 */

/** How long a proposal holds the new time, at most. */
export const PROPOSAL_HOURS = 24;
/** A proposal needs at least this long for players to answer before its deadline. */
const MIN_ANSWER_MINUTES = 30;

type To = {
  date: string;
  start: number;
  courtId?: number;
  override?: boolean;
  coachId?: number;
  /** A paid lesson to another coach: the manager's word on the money (lib/lesson-coaches.ts). */
  coachMoney?: "keep" | "adjust";
  changedBy?: { adminId: number | null; name: string };
  /** A lesson's coach told by the caller, once for a series moved together (lib/series-moves.ts). */
  quietCoach?: boolean;
};

export interface MovePreview {
  from: { date: string; startMin: number; endMin: number; courtId: number; courtName: string };
  to: { date: string; startMin: number; endMin: number; courtId: number; courtName: string };
  priceChange: number;
  unchargedDifference: number;
  overrides?: string[];
  /** What would happen: moved at once (nobody in it, or no game), proposed to the players, or the venue's change. */
  outcome: "move" | "proposal" | "venue";
  /** The game on the booking, if there is one still on. */
  gameId: number | null;
  /** Players in the game, first names. */
  players: { name: string; paid: boolean }[];
  /** People who would hear the new time without being in the game yet. */
  pending: { invited: number; requested: number; waitlisted: number; offered: number };
  /** Players with another game or booking of theirs at the new time: how many, never who or what. */
  clashes: number;
  /** Shares players have paid online towards the court: each owed back to a player who leaves rather than move. */
  sharesPaid: number;
  /** A proposal holds the new time until then. */
  expiresAt?: string;
  /** A lesson to another coach: who from and to, and what it would do to the money (lib/lesson-coaches.ts). */
  coachChange?: CoachChange;
}

export type MoveResult =
  | { ok: true; outcome: "move" | "venue"; result: Extract<RescheduleResult, { ok: true }>; move?: GameMove | null }
  | { ok: true; outcome: "proposal"; move: GameMove }
  | (Refusal & { status?: number });

const refused = (error: string, status = 409): Refusal & { status: number } => ({ ok: false, error, status });

/** The game on a booking, by its code, if one is still on. */
async function liveGameFor(bookingCode: string): Promise<OpenGame | null> {
  const row = (await getDb()
    .prepare("SELECT g.id FROM open_games g JOIN bookings b ON b.id = g.booking_id WHERE UPPER(b.code) = UPPER(?) AND g.status <> 'cancelled'")
    .get(bookingCode.trim())) as { id: number } | undefined;
  return row ? gameById(row.id) : null;
}

async function acceptedCount(gameId: number): Promise<number> {
  const row = (await getDb()
    .prepare("SELECT COUNT(*)::int AS n FROM open_game_players WHERE game_id = ? AND status = 'accepted'")
    .get(gameId)) as { n: number };
  return row.n;
}

/** Players in a game with something else of theirs at that time: another game they are in, or a booking of their own. */
async function clashesAt(game: OpenGame, to: { date: string; startMin: number; endMin: number }): Promise<number> {
  const from = instantOf(to.date, to.startMin, game.timeZone).toISOString();
  const until = instantOf(to.date, to.endMin, game.timeZone).toISOString();
  const row = (await getDb()
    .prepare(
      `SELECT COUNT(DISTINCT p.user_id)::int AS n FROM open_game_players p
        WHERE p.game_id = ? AND p.status = 'accepted' AND (
          EXISTS (SELECT 1 FROM bookings b WHERE b.user_id = p.user_id AND b.status = 'confirmed' AND b.id <> ?
                     AND b.starts_at < ?::timestamptz AND b.ends_at > ?::timestamptz)
          OR EXISTS (SELECT 1 FROM open_game_players q JOIN open_games g2 ON g2.id = q.game_id JOIN bookings b2 ON b2.id = g2.booking_id
                      WHERE q.user_id = p.user_id AND q.status = 'accepted' AND g2.id <> p.game_id AND g2.status <> 'cancelled'
                        AND b2.status = 'confirmed' AND b2.starts_at < ?::timestamptz AND b2.ends_at > ?::timestamptz))`
    )
    .get(game.id, game.bookingId, until, from, until, from)) as { n: number };
  return row.n;
}

async function sharesPaid(gameId: number): Promise<number> {
  const row = (await getDb()
    .prepare(
      `SELECT COALESCE(SUM(op.amount - op.refund_due), 0)::float AS paid FROM online_payments op
         JOIN open_game_players p ON p.id = op.game_player_id
        WHERE p.game_id = ? AND p.status = 'accepted' AND op.purpose = 'share' AND op.status = 'paid'`
    )
    .get(gameId)) as { paid: number };
  return Math.round(Number(row.paid) * 100) / 100;
}

/** Until when a host's proposal can hold the new time: a day at most, and never past when the booking may still be changed or the new time begins. */
async function proposalDeadline(game: OpenGame, to: { date: string; startMin: number }): Promise<Date | null> {
  const limits = [Date.now() + PROPOSAL_HOURS * 3_600_000, instantOf(to.date, to.startMin, game.timeZone).getTime()];
  const deadline = await changeDeadline(game.bookingId);
  if (deadline) limits.push(deadline.getTime());
  const at = Math.min(...limits);
  return at - Date.now() < MIN_ANSWER_MINUTES * 60_000 ? null : new Date(Math.floor(at / 60_000) * 60_000);
}

/**
 * What moving a booking to `to` would do, changing nothing: where it would
 * go, what it would cost, and, for a game on it, who is in it, who would
 * hear, how many have something else then, and what is owed back to anybody
 * who leaves rather than move. As its host (`by` "customer") or as staff.
 */
export async function previewMove(bookingCode: string, to: To, by: "customer" | "staff"): Promise<{ ok: true; preview: MovePreview } | Refusal> {
  const game = await liveGameFor(bookingCode);
  const r = await rescheduleBooking(bookingCode, { ...to, preview: true, game: true }, by);
  if (!r.ok) return r;
  const players = game ? (await gamePlayers(game.id)).filter((p) => p.status === "accepted") : [];
  const everyone = game ? await gamePlayers(game.id) : [];
  const pending = {
    invited: everyone.filter((p) => p.status === "invited").length,
    requested: everyone.filter((p) => p.status === "requested").length,
    waitlisted: everyone.filter((p) => p.status === "waitlisted").length,
    offered: everyone.filter((p) => p.status === "offered").length,
  };
  const outcome = players.length === 0 ? "move" : by === "customer" ? "proposal" : "venue";
  const preview: MovePreview = {
    from: { ...r.from, courtName: (await courtName(r.from.courtId)) ?? "" },
    to: r.to,
    priceChange: r.priceChange,
    unchargedDifference: r.unchargedDifference,
    ...(r.overrides ? { overrides: r.overrides } : {}),
    outcome,
    gameId: game?.id ?? null,
    players: players.map((p) => ({ name: p.name, paid: p.paid })),
    pending,
    clashes: game && players.length > 0 ? await clashesAt(game, r.to) : 0,
    sharesPaid: game ? await sharesPaid(game.id) : 0,
    ...(r.coachChange ? { coachChange: r.coachChange } : {}),
  };
  if (outcome === "proposal" && game) {
    const until = await proposalDeadline(game, r.to);
    if (!until) return refused("The game is too close to its start to ask its players. Ask the venue to change it.");
    preview.expiresAt = until.toISOString();
  }
  return { ok: true, preview };
}

async function courtName(courtId: number): Promise<string | null> {
  const row = (await getDb().prepare("SELECT name FROM courts WHERE id = ?").get(courtId)) as { name: string } | undefined;
  return row?.name ?? null;
}

/** A refusal from inside a transaction: thrown to undo it, returned to the caller. */
class Undo extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.error);
  }
}

/**
 * Its host moving their game. With nobody in it yet, the booking moves at
 * once by the customer's rules. With players, the new time is proposed to
 * them and held while they answer.
 */
export async function hostMove(hostId: number, gameId: number, to: To): Promise<MoveResult> {
  const game = await gameById(gameId);
  if (!game || game.hostId !== hostId) return refused("Not found.", 404);
  if (game.status === "cancelled") return refused("That game is called off.");
  // The court the host chose among the times offered, if they chose one; the venue's rules still decide.
  const where = { date: to.date, start: to.start, ...(to.courtId !== undefined ? { courtId: to.courtId } : {}) };
  if ((await acceptedCount(gameId)) === 0) {
    const r = await rescheduleBooking(game.bookingCode, where, "customer");
    if (!r.ok) return r;
    return { ok: true, outcome: "move", result: r };
  }
  const preview = await previewMove(game.bookingCode, where, "customer");
  if (!preview.ok) return preview;
  const until = new Date(preview.preview.expiresAt!);
  const length = game.endHour * 60 - game.startHour * 60;
  try {
    const moveId = await withTransaction(async () => {
      const db = getDb();
      await db.prepare("SELECT id FROM open_games WHERE id = ? FOR UPDATE").get(gameId);
      if ((await pendingMove(gameId)) !== null) throw new Undo(refused("A new time is already waiting for the players' answers."));
      const b = (await db.prepare("SELECT date, start_min, end_min, court_id FROM bookings WHERE id = ?").get(game.bookingId)) as {
        date: string; start_min: number; end_min: number; court_id: number;
      };
      const made = (await db
        .prepare(
          `INSERT INTO game_moves (game_id, booking_id, kind, host_id, from_date, from_start_min, from_end_min, from_court_id,
                                   to_date, to_start_min, to_end_min, status, expires_at)
           VALUES (?, ?, 'proposal', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?) RETURNING id`
        )
        .get(gameId, game.bookingId, hostId, b.date, b.start_min, b.end_min, b.court_id, to.date, to.start, to.start + Math.round(length), until.toISOString())) as {
        id: number;
      };
      const r = await rescheduleBooking(game.bookingCode, { ...where, game: true, hold: { moveId: made.id, expiresAt: until } }, "customer");
      if (!r.ok) throw new Undo(r);
      await db
        .prepare("UPDATE game_moves SET to_court_id = ?, to_end_min = ?, price_change = ? WHERE id = ?")
        .run(r.to.courtId, r.to.endMin, r.priceChange, made.id);
      await db.prepare("UPDATE open_game_players SET move_id = ? WHERE game_id = ? AND status = 'accepted'").run(made.id, gameId);
      const asked = (await db.prepare("SELECT id, user_id FROM open_game_players WHERE game_id = ? AND status = 'accepted'").all(gameId)) as {
        id: number; user_id: number;
      }[];
      for (const p of asked)
        await tell(
          p.user_id,
          game,
          (tr) => tr("mail.move.ask.s", { host: game.hostName, venue: game.venueName }),
          (tr) =>
            sentences(
              tr,
              tr("mail.move.ask.b", {
                host: game.hostName,
                from: when(preview.preview.from, tr.locale),
                fromCourt: preview.preview.from.courtName,
                to: when(r.to, tr.locale),
                toCourt: r.to.courtName,
                venue: game.venueName,
              }),
              tr(game.share > 0 ? "mail.move.ask.keepRefund" : "mail.move.ask.keep", {
                until: new Intl.DateTimeFormat(DATE_LOCALE[tr.locale], { timeZone: game.timeZone, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(until),
              }),
              tr("mail.move.ask.else")
            ),
          `game-move:${made.id}:${p.id}`
        );
      return made.id;
    });
    return { ok: true, outcome: "proposal", move: (await moveOf(gameId)) ?? (await moveById(moveId))! };
  } catch (err) {
    if (err instanceof Undo) return err.refusal;
    throw err;
  }
}

async function moveById(id: number): Promise<GameMove | null> {
  const row = (await getDb().prepare("SELECT game_id FROM game_moves WHERE id = ?").get(id)) as { game_id: number } | undefined;
  return row ? moveOf(row.game_id) : null;
}

/** A player's answer to a change of time: they keep their place at the new time. (Leaving is lib/games.ts, leaveGame.) */
export async function keepPlace(userId: number, gameId: number): Promise<{ ok: true } | (Refusal & { status?: number })> {
  const db = getDb();
  const row = (await db
    .prepare("SELECT id, move_id FROM open_game_players WHERE game_id = ? AND user_id = ? AND status = 'accepted'")
    .get(gameId, userId)) as { id: number; move_id: number | null } | undefined;
  if (!row) return refused("You are not in that game.", 404);
  if (row.move_id === null) return refused("There is nothing to answer.");
  await withTransaction(async () => {
    await db
      .prepare("INSERT INTO game_move_answers (move_id, player_id, answer) VALUES (?, ?, 'yes') ON CONFLICT (move_id, player_id) DO NOTHING")
      .run(row.move_id, row.id);
    await db.prepare("UPDATE open_game_players SET move_id = NULL WHERE id = ? AND move_id = ?").run(row.id, row.move_id);
  });
  await settleMove(gameId);
  return { ok: true };
}

/**
 * A proposal every player has answered moves the game: the booking goes onto
 * the time held, in one transaction, and everybody hears. Nothing to do while
 * anybody is still to answer, or when there is no proposal.
 */
export async function settleMove(gameId: number): Promise<void> {
  const moveId = await pendingMove(gameId);
  if (moveId === null) return;
  const game = await gameById(gameId);
  if (!game) return;
  const outcome = await withTransaction(async (): Promise<"waiting" | "gone" | RescheduleResult> => {
    const db = getDb();
    await db.prepare("SELECT id FROM open_games WHERE id = ? FOR UPDATE").get(gameId);
    const m = (await db.prepare("SELECT status, to_date, to_start_min, to_court_id FROM game_moves WHERE id = ? FOR UPDATE").get(moveId)) as
      | { status: string; to_date: string; to_start_min: number; to_court_id: number | null }
      | undefined;
    if (!m || m.status !== "pending" || m.to_court_id === null) return "gone";
    const waiting = (await db
      .prepare("SELECT COUNT(*)::int AS n FROM open_game_players WHERE move_id = ? AND status = 'accepted'")
      .get(moveId)) as { n: number };
    if (waiting.n > 0) return "waiting";
    const r = await rescheduleBooking(
      game.bookingCode,
      { date: m.to_date, start: m.to_start_min, courtId: m.to_court_id, game: true, fromHold: moveId },
      "customer"
    );
    if (r.ok)
      await db
        .prepare("UPDATE game_moves SET status = 'applied', decided_at = now(), price_change = ?, outcome = 'Every player answered.' WHERE id = ?")
        .run(r.priceChange, moveId);
    return r;
  });
  if (outcome === "waiting" || outcome === "gone") return;
  if (!outcome.ok) {
    await endMove(gameId, "failed", outcome.error);
    return;
  }
  const moved = (await gameById(gameId))!;
  const { notifyRescheduled } = await import("./notify");
  await notifyRescheduled(outcome.booking, "customer", outcome.priceChange, { date: game.date, startMin: Math.round(game.startHour * 60) });
  const kept = (await getDb()
    .prepare(
      `SELECT p.user_id FROM game_move_answers a JOIN open_game_players p ON p.id = a.player_id
        WHERE a.move_id = ? AND a.answer = 'yes' AND p.status = 'accepted'`
    )
    .all(moveId)) as { user_id: number }[];
  for (const p of kept)
    await tell(
      p.user_id,
      moved,
      (tr) => tr("mail.move.done.s", { venue: moved.venueName, when: when(outcome.to, tr.locale) }),
      (tr) => tr("mail.move.done.b", { host: moved.hostName, when: when(outcome.to, tr.locale), court: outcome.to.courtName, venue: moved.venueName }),
      `game-moved:${moveId}:${p.user_id}`
    );
  await gameTimeChanged(gameId);
  await resumeGame(gameId);
}

/**
 * A pending proposal ends without moving anything: withdrawn by its host,
 * run out, failed, or gone with its game. The time held is let go, nobody is
 * waited for any more, and places waiting are passed on.
 */
export async function endMove(gameId: number, status: "withdrawn" | "expired" | "failed", why: string, opts: { quiet?: boolean } = {}): Promise<boolean> {
  const db = getDb();
  const ended = (await db
    .prepare("UPDATE game_moves SET status = ?, decided_at = now(), outcome = ? WHERE game_id = ? AND status = 'pending' RETURNING id")
    .get(status, why, gameId)) as { id: number } | undefined;
  if (!ended) return false;
  await release({ kind: "move", moveId: ended.id });
  const asked = (await db
    .prepare("UPDATE open_game_players SET move_id = NULL WHERE move_id = ? AND status = 'accepted' RETURNING user_id")
    .all(ended.id)) as { user_id: number }[];
  if (opts.quiet) return true;
  const game = await gameById(gameId);
  if (!game) return true;
  const answered = (await db
    .prepare("SELECT p.user_id FROM game_move_answers a JOIN open_game_players p ON p.id = a.player_id WHERE a.move_id = ? AND a.answer = 'yes'")
    .all(ended.id)) as { user_id: number }[];
  const told = new Set([...asked, ...answered].map((p) => p.user_id));
  const subject: Written = (tr) =>
    tr("mail.move.stays.s", { venue: game.venueName, when: when({ date: game.date, startMin: game.startHour * 60, endMin: game.endHour * 60 }, tr.locale) });
  const where = { host: game.hostName, court: game.courtName, venue: game.venueName, date: game.date };
  const body: Written = (tr) =>
    status === "withdrawn"
      ? tr("mail.move.stays.withdrawn", where)
      : status === "expired"
        ? tr("mail.move.stays.expired", where)
        : tr("mail.move.stays.failed", { ...where, why });
  for (const u of told) await tell(u, game, subject, body, `game-move-end:${ended.id}:${u}`);
  if (status !== "withdrawn") await tell(game.hostId, game, subject, body, `game-move-end:${ended.id}:host`);
  await resumeGame(gameId);
  return true;
}

/** Its host withdrawing a proposal. */
export async function withdrawMove(hostId: number, gameId: number): Promise<{ ok: true } | (Refusal & { status?: number })> {
  const game = await gameById(gameId);
  if (!game || game.hostId !== hostId) return refused("Not found.", 404);
  if (!(await endMove(gameId, "withdrawn", "Withdrawn by the host."))) return refused("There is no new time waiting.");
  return { ok: true };
}

/** Proposals past their time: ended, their holds let go. Safe on several servers: each ends once. */
export async function expireMoves(): Promise<number> {
  const due = (await getDb()
    .prepare("SELECT game_id FROM game_moves WHERE status = 'pending' AND expires_at <= now()")
    .all()) as { game_id: number }[];
  let n = 0;
  for (const d of due) if (await endMove(d.game_id, "expired", "Not every player answered in time.")) n++;
  return n;
}

/**
 * Staff moving a booking. One with no game, or a game nobody is in yet,
 * moves as any booking does. A game with players moves only as the venue's
 * change: by a manager, with a reason the players are given, and each player
 * then confirms they are still coming or leaves.
 */
export async function staffMove(
  admin: { id: number; role: string },
  bookingCode: string,
  to: To,
  reason: string | null
): Promise<MoveResult> {
  const game = await liveGameFor(bookingCode);
  if (!game || (await acceptedCount(game.id)) === 0) {
    const r = await rescheduleBooking(bookingCode, { ...to }, "staff");
    if (!r.ok) return r;
    return { ok: true, outcome: "move", result: r };
  }
  if (admin.role === "desk") return refused("This booking's open game has players in it: only a manager can change its time.", 403);
  const why = reason?.trim().slice(0, 300) ?? "";
  if (why.length < 3) return refused("Say why the venue is moving it: the players are told.", 400);
  try {
    const out = await withTransaction(async () => {
      const db = getDb();
      await db.prepare("SELECT id FROM open_games WHERE id = ? FOR UPDATE").get(game.id);
      // The venue's change takes the place of a host's proposal still waiting: the players hear the venue's.
      await endMove(game.id, "withdrawn", "The venue changed the game's time.", { quiet: true });
      const r = await rescheduleBooking(bookingCode, { ...to, game: true }, "staff");
      if (!r.ok) throw new Undo(r);
      const made = (await db
        .prepare(
          `INSERT INTO game_moves (game_id, booking_id, kind, admin_id, reason, from_date, from_start_min, from_end_min, from_court_id,
                                   to_date, to_start_min, to_end_min, to_court_id, price_change, status, decided_at, outcome)
           VALUES (?, ?, 'venue', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'applied', now(), 'Made by the venue.') RETURNING id`
        )
        .get(game.id, game.bookingId, admin.id, why, r.from.date, r.from.startMin, r.from.endMin, r.from.courtId, r.to.date, r.to.startMin, r.to.endMin, r.to.courtId, r.priceChange)) as {
        id: number;
      };
      const players = (await db
        .prepare("UPDATE open_game_players SET move_id = ? WHERE game_id = ? AND status = 'accepted' RETURNING id, user_id")
        .all(made.id, game.id)) as { id: number; user_id: number }[];
      const moved = (await gameById(game.id))!;
      for (const p of players)
        await tell(
          p.user_id,
          moved,
          (tr) => tr("mail.move.venue.s", { venue: moved.venueName, when: when(r.to, tr.locale) }),
          (tr) =>
            sentences(
              tr,
              tr("mail.move.venue.b", { venue: moved.venueName, host: moved.hostName, from: when(r.from, tr.locale), to: when(r.to, tr.locale), court: r.to.courtName, why }),
              moved.share > 0 ? tr("mail.move.venue.askRefund", { share: money(moved.share.toFixed(2)) }) : tr("mail.move.venue.ask")
            ),
          `game-venue-move:${made.id}:${p.id}`
        );
      return { r, moveId: made.id };
    });
    await gameTimeChanged(game.id);
    return { ok: true, outcome: "venue", result: out.r, move: await moveOf(game.id) };
  } catch (err) {
    if (err instanceof Undo) return err.refusal;
    throw err;
  }
}

// ------------------------------------------------------------ telling people

const when = (d: { date: string; startMin: number; endMin: number }, locale = "en") => `${d.date} ${formatMinute(d.startMin, locale)}–${formatMinute(d.endMin, locale)}`;

/** How each language writes the date a proposal must be answered by. */
const DATE_LOCALE: Record<string, string> = { en: "en-GB", ms: "ms-MY", zh: "zh-CN", ta: "ta-IN" };

/** An email to a player about their game's time, in their language. */
async function tell(userId: number, game: OpenGame, subject: Written, body: Written, dedupeKey: string): Promise<void> {
  await emailPlayer({ venueId: game.venueId, userId, subject, body, link: `${baseUrl()}/games`, dedupeKey });
}
