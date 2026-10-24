import crypto from "node:crypto";
import { getDb, withTransaction } from "./db";
import { hoursOf } from "./interval";
import { venueZoneOf } from "./zones";
import { isBlocked } from "./limits";
import { accessRefusal } from "./access";
import { listRule, OPEN_TO_CUSTOMERS } from "./listing";
import { distanceM } from "./geo";
import { baseUrl, emailPlayer } from "./outbox";
import { addDays, formatHour, isPastSlot, slotStartsAt, todayISO } from "./time";
import type { Near } from "./store";
import { isWho, whoRefusal, type Who } from "./who";
import type { Sport } from "./types";
import { money } from "./region";
import { signOffHolds } from "./sign-offs";
import { blockedBetween, blockedInGame, related } from "./player-safety";
import { declaredAdult, type Intensity } from "./player-profiles";

/**
 * Player matching: open games.
 *
 * A player who has booked a court can open it to others — "two more for
 * doubles, intermediate, RM8 each". Others find it by sport, day, level and
 * distance, and ask to join; the host says yes or no, or lets everybody in.
 * Whoever joins pays their share to the venue, online, towards the host's
 * booking, so the platform still never holds anybody's money and the host
 * is not left chasing three people for RM8.
 *
 * Nobody sees anybody's phone number: a first name and a level, and the
 * court, the time and the booking it is under. Somebody who joins and does
 * not come is marked so by the host; three in ninety days, and they cannot
 * join games until those age out.
 *
 * Everything here needs an account — a player is who they say they are only
 * as far as an account and its email make them, which is as far as anything
 * here can.
 *
 * Each person has one row per game, and its status is where they stand:
 *
 *   invited     asked in by the host or a player, until the invitation expires
 *   requested   asked to join; waiting for the host
 *   accepted    in the game
 *   declined    the host said no (or turned them down by blocking them)
 *   left        dropped out, or turned down an invitation or a freed place
 *   removed     taken out by the host, or an invitation withdrawn
 *   waitlisted  asked when the game was full; in line for a place
 *   offered     a freed place held for them until it expires
 *   expired     an invitation or a held place that ran out
 *
 * A place is taken by somebody accepted or offered one, and nobody else gets
 * it: every change that could take or free a place runs in one transaction
 * that locks the game's row first, so two people answering at once cannot
 * both have the last place. A freed place goes to whoever has waited longest:
 * held for them for OFFER_MINUTES where the host lets everybody in, or put to
 * the host as an ordinary request where the host decides. Joining never
 * books a court; the game is the host's booking, and only that.
 *
 * A private game is never listed: only its host's invitations and links
 * (game_links, which keep only a hash of their secret) lead to it.
 */

export const LEVELS = ["beginner", "intermediate", "advanced", "competitive"] as const;
export type Level = (typeof LEVELS)[number];
export const MAX_SPOTS = 10;
/** Joining stops after this many no-shows in NO_SHOW_DAYS. */
export const MAX_NO_SHOWS = 3;
export const NO_SHOW_DAYS = 90;

export type GameStatus = "open" | "closed" | "cancelled";
export type PlayerStatus = "requested" | "accepted" | "declined" | "left" | "removed" | "invited" | "waitlisted" | "offered" | "expired";
export type Visibility = "public" | "private";
/** Where somebody stands who is still part of a game, or waiting to be. */
export const ACTIVE: PlayerStatus[] = ["invited", "requested", "accepted", "waitlisted", "offered"];
const ACTIVE_SQL = ACTIVE.map((s) => `'${s}'`).join(", ");
/** How long a freed place is held for the next in line. */
export const OFFER_MINUTES = 120;
/** How long an invitation stands. */
export const INVITE_HOURS = 48;
/** Invitations one person can send in a day, to games and groups together. */
export const INVITES_PER_DAY = 30;
/** Invitations waiting for an answer in one game, at most, per place in it. */
export const OPEN_INVITES_PER_SPOT = 3;
/** The longest a shareable link lasts. */
export const LINK_MAX_HOURS = 24 * 14;

export interface GamePlayer {
  id: number;
  userId: number;
  /** First name only. */
  name: string;
  level: Level | null;
  status: PlayerStatus;
  paid: boolean;
  noShow: boolean;
  /** An invitation or a held place: when it runs out. */
  expiresAt: string | null;
  /** Invited, rather than asking. */
  invited: boolean;
}

export interface OpenGame {
  id: number;
  bookingId: number;
  bookingCode: string;
  hostId: number;
  hostName: string;
  hostLevel: Level | null;
  venueId: number;
  venueName: string;
  area: string;
  /** The venue's time zone, which the game's times are in. */
  timeZone: string;
  courtName: string;
  sport: Sport;
  date: string;
  startHour: number;
  endHour: number;
  level: Level | null;
  /** Anyone, women only, or men only (lib/who.ts). */
  who: Who;
  spots: number;
  /** Accepted so far. */
  joined: number;
  /** Places held for somebody, not yet taken up. */
  held: number;
  /** In line for a place. */
  waiting: number;
  visibility: Visibility;
  /** A full game takes a waiting list. */
  waitlist: boolean;
  intensity: Intensity;
  /** Open only to players who say they are 18 or over. */
  adultsOnly: boolean;
  seriesId: number | null;
  share: number;
  autoAccept: boolean;
  note: string | null;
  status: GameStatus;
  distanceKm?: number;
  /** For whoever is asking: their place in it, if any. */
  mine?: { playerId: number; status: PlayerStatus; paid: boolean; expiresAt: string | null } | null;
  /** For whoever is asking: it is their own game. */
  yours?: boolean;
  /** For its host: everybody who asked. */
  players?: GamePlayer[];
  /** Whether the venue takes shares online. */
  payOnline: boolean;
}

interface GameRow {
  id: number;
  booking_id: number;
  booking_code: string;
  host_id: number;
  host_name: string;
  host_level: Level | null;
  venue_id: number;
  venue_name: string;
  area: string;
  lat: number | null;
  lng: number | null;
  time_zone: string | null;
  court_name: string;
  sport: Sport;
  date: string;
  start_min: number;
  end_min: number;
  level: Level | null;
  who: Who;
  spots: number;
  joined: number;
  held: number;
  waiting: number;
  visibility: Visibility;
  waitlist: number;
  intensity: Intensity;
  adults_only: number;
  series_id: number | null;
  share: number;
  auto_accept: number;
  note: string | null;
  status: GameStatus;
  pay_online: boolean;
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

const GAME_SELECT = `
  SELECT g.id, g.booking_id, b.code AS booking_code, g.host_id, u.name AS host_name, hl.level AS host_level,
         v.id AS venue_id, v.name AS venue_name, v.area, v.lat, v.lng, v.time_zone, c.name AS court_name, b.sport,
         b.date, b.start_min, b.end_min, g.level, g.who, g.spots,
         (SELECT COUNT(*)::int FROM open_game_players p WHERE p.game_id = g.id AND p.status = 'accepted') AS joined,
         (SELECT COUNT(*)::int FROM open_game_players p WHERE p.game_id = g.id AND p.status = 'offered') AS held,
         (SELECT COUNT(*)::int FROM open_game_players p WHERE p.game_id = g.id AND p.status = 'waitlisted') AS waiting,
         g.visibility, g.waitlist, g.intensity, g.adults_only, g.series_id,
         g.share::float AS share, g.auto_accept, g.note, g.status,
         EXISTS (SELECT 1 FROM venue_payment_accounts a WHERE a.venue_id = v.id AND a.enabled = 1) AS pay_online
    FROM open_games g
    JOIN bookings b ON b.id = g.booking_id
    JOIN courts c ON c.id = b.court_id
    JOIN venues v ON v.id = c.venue_id
    JOIN users u ON u.id = g.host_id
    LEFT JOIN player_levels hl ON hl.user_id = g.host_id AND hl.sport = b.sport`;

function toGame(r: GameRow): OpenGame {
  return {
    id: r.id,
    bookingId: r.booking_id,
    bookingCode: r.booking_code,
    hostId: r.host_id,
    hostName: firstName(r.host_name),
    hostLevel: r.host_level,
    venueId: r.venue_id,
    venueName: r.venue_name,
    area: r.area,
    timeZone: venueZoneOf(r),
    courtName: r.court_name,
    sport: r.sport,
    date: r.date,
    startHour: hoursOf(r.start_min),
    endHour: hoursOf(r.end_min),
    level: r.level,
    who: r.who,
    spots: r.spots,
    joined: r.joined,
    held: r.held,
    waiting: r.waiting,
    visibility: r.visibility,
    waitlist: r.waitlist === 1,
    intensity: r.intensity,
    adultsOnly: r.adults_only === 1,
    seriesId: r.series_id,
    share: Number(r.share),
    autoAccept: r.auto_accept === 1,
    note: r.note,
    status: r.status,
    payOnline: Boolean(r.pay_online),
  };
}

export async function gameById(id: number): Promise<OpenGame | null> {
  const row = (await getDb().prepare(`${GAME_SELECT} WHERE g.id = ?`).get(id)) as GameRow | undefined;
  return row ? toGame(row) : null;
}

/** Several games in one query, in the order of `ids`. */
export async function gamesByIds(ids: number[]): Promise<OpenGame[]> {
  if (ids.length === 0) return [];
  const rows = (await getDb().prepare(`${GAME_SELECT} WHERE g.id IN (${ids.map(() => "?").join(",")})`).all(...ids)) as GameRow[];
  const byId = new Map(rows.map((r) => [r.id, toGame(r)]));
  return ids.map((id) => byId.get(id)).filter((g): g is OpenGame => g !== undefined);
}

// ------------------------------------------------------------ levels

export async function playerLevels(userId: number): Promise<Partial<Record<Sport, Level>>> {
  const rows = (await getDb()
    .prepare("SELECT sport, level FROM player_levels WHERE user_id = ?")
    .all(userId)) as { sport: Sport; level: Level }[];
  return Object.fromEntries(rows.map((r) => [r.sport, r.level]));
}

export async function setPlayerLevel(userId: number, sport: Sport, level: Level | null): Promise<void> {
  if (level === null) {
    await getDb().prepare("DELETE FROM player_levels WHERE user_id = ? AND sport = ?").run(userId, sport);
    return;
  }
  await getDb()
    .prepare(
      `INSERT INTO player_levels (user_id, sport, level) VALUES (?, ?, ?)
       ON CONFLICT (user_id, sport) DO UPDATE SET level = excluded.level, updated_at = datetime('now')`
    )
    .run(userId, sport, level);
}

// ------------------------------------------------------------ hosting

export type GameResult = { ok: true; game: OpenGame } | { ok: false; error: string; status?: number; code?: string };

/** A share that splits the court evenly among everybody playing, to the 50 sen. */
export function suggestedShare(totalPrice: number, spots: number): number {
  return Math.ceil((totalPrice / (spots + 1)) * 2) / 2;
}

export async function openGame(
  hostId: number,
  input: {
    bookingCode: string;
    spots: number;
    level: Level | null;
    share: number;
    autoAccept: boolean;
    note?: string;
    who?: Who;
    visibility?: Visibility;
    waitlist?: boolean;
    intensity?: Intensity;
    adultsOnly?: boolean;
    seriesId?: number | null;
  }
): Promise<GameResult> {
  const db = getDb();
  const booking = (await db
    .prepare(
      `SELECT b.id, b.user_id, b.date, b.start_min, b.status, b.class_id, b.total_price::float AS total_price,
              b.hold_until, b.payment_status, v.time_zone, v.lat, v.lng, (${OPEN_TO_CUSTOMERS}) AS open
         FROM bookings b JOIN courts c ON c.id = b.court_id JOIN venues v ON v.id = c.venue_id
        WHERE UPPER(b.code) = UPPER(?)`
    )
    .get(input.bookingCode.trim())) as
    | {
        id: number; user_id: number | null; date: string; start_min: number; status: string; class_id: number | null;
        total_price: number; open: boolean; time_zone: string | null; lat: number | null; lng: number | null;
        hold_until: string | null; payment_status: string;
      }
    | undefined;
  if (!booking || booking.user_id !== hostId) return { ok: false, error: "That is not one of your bookings.", status: 404 };
  if (booking.status !== "confirmed") return { ok: false, error: "That booking is cancelled." };
  if (booking.class_id !== null) return { ok: false, error: "A class place cannot be shared." };
  if (isPastSlot(booking.date, hoursOf(booking.start_min), venueZoneOf(booking))) return { ok: false, error: "That booking has already started." };
  if (!booking.open) return { ok: false, error: "That venue is not taking bookings at the moment." };
  // Held only until paid: players' shares could arrive after it was let go.
  if (booking.hold_until && booking.payment_status === "unpaid")
    return { ok: false, error: "Pay for the court first: this venue holds it only until it is paid." };
  if (!Number.isInteger(input.spots) || input.spots < 1 || input.spots > MAX_SPOTS)
    return { ok: false, error: `Look for 1 to ${MAX_SPOTS} players.` };
  if (input.level !== null && !LEVELS.includes(input.level)) return { ok: false, error: "Unknown level." };
  if (!Number.isFinite(input.share) || input.share < 0 || input.share > booking.total_price)
    return { ok: false, error: `Each share must be between ${money(0)} and the court's ${money(booking.total_price)}.` };
  if (await db.prepare("SELECT 1 FROM open_games WHERE booking_id = ?").get(booking.id))
    return { ok: false, error: "That booking is already open to other players." };
  const who = input.who ?? "anyone";
  if (!isWho(who)) return { ok: false, error: "Anyone, women only or men only." };
  // The host plays too: a women-only game is opened by a woman, so nobody can
  // use the label to draw people in.
  const notFor = await whoRefusal(hostId, who);
  if (notFor) return { ok: false, error: notFor.error, code: notFor.code, status: 403 };
  const visibility = input.visibility ?? "public";
  if (visibility !== "public" && visibility !== "private") return { ok: false, error: "Public or private." };
  const intensity = input.intensity ?? "any";
  if (!["casual", "competitive", "any"].includes(intensity)) return { ok: false, error: "Casual, competitive or either." };

  const info = await db
    .prepare(
      `INSERT INTO open_games (booking_id, host_id, level, who, spots, share, auto_accept, note, visibility, waitlist, intensity, adults_only, series_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      booking.id,
      hostId,
      input.level,
      who,
      input.spots,
      Math.round(input.share * 100) / 100,
      input.autoAccept ? 1 : 0,
      input.note?.trim().slice(0, 300) || null,
      visibility,
      input.waitlist ? 1 : 0,
      intensity,
      input.adultsOnly ? 1 : 0,
      input.seriesId ?? null
    );
  return { ok: true, game: (await gameById(info.lastInsertRowid as number))! };
}

/** The host's view of a game: everybody who asked, and how they stand. */
export async function gamePlayers(gameId: number): Promise<GamePlayer[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT p.id, p.user_id, u.name, pl.level, p.status, p.paid_at, p.no_show, p.expires_at, p.invited_by
         FROM open_game_players p
         JOIN users u ON u.id = p.user_id
         JOIN open_games g ON g.id = p.game_id
         JOIN bookings b ON b.id = g.booking_id
         JOIN courts c ON c.id = b.court_id
         LEFT JOIN player_levels pl ON pl.user_id = p.user_id AND pl.sport = b.sport
        WHERE p.game_id = ? ORDER BY p.id`
    )
    .all(gameId)) as {
    id: number; user_id: number; name: string; level: Level | null; status: PlayerStatus; paid_at: string | null; no_show: number;
    expires_at: string | null; invited_by: number | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    name: firstName(r.name),
    level: r.level,
    status: r.status,
    paid: r.paid_at !== null,
    noShow: r.no_show === 1,
    expiresAt: r.expires_at,
    invited: r.invited_by !== null,
  }));
}

export type PlayerAction = "accept" | "decline" | "remove" | "no_show";

/** A game's row, locked until the transaction ends, with its places counted. */
async function lockPlaces(gameId: number): Promise<{ spots: number; taken: number; requested: number; status: GameStatus; autoAccept: boolean; waitlist: boolean } | undefined> {
  const db = getDb();
  const g = (await db.prepare("SELECT spots, status, auto_accept, waitlist FROM open_games WHERE id = ? FOR UPDATE").get(gameId)) as
    | { spots: number; status: GameStatus; auto_accept: number; waitlist: number }
    | undefined;
  if (!g) return undefined;
  // A held place that has run out no longer counts, before anybody has tidied it up.
  const c = (await db
    .prepare(
      `SELECT COUNT(*) FILTER (WHERE status = 'accepted' OR (status = 'offered' AND expires_at >= datetime('now')))::int AS taken,
              COUNT(*) FILTER (WHERE status = 'requested')::int AS requested
         FROM open_game_players WHERE game_id = ?`
    )
    .get(gameId)) as { taken: number; requested: number };
  return { spots: g.spots, taken: c.taken, requested: c.requested, status: g.status, autoAccept: g.auto_accept === 1, waitlist: g.waitlist === 1 };
}

/** `minutes` from now, or the game's start if that is sooner, as stored. */
function untilAtMost(game: OpenGame, minutes: number): string {
  const start = slotStartsAt(game.date, game.startHour, game.timeZone).getTime();
  return new Date(Math.min(Date.now() + minutes * 60_000, start)).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Freed places to whoever has waited longest. Called inside the transaction
 * that freed them. Where the host lets everybody in, the place is held for
 * them until OFFER_MINUTES pass (or the game starts); where the host decides,
 * they become an ordinary request, as many as there are places not already
 * asked for. Somebody blocked by, or blocking, a player now in the game is
 * passed over and keeps their place in line.
 */
async function fillPlaces(game: OpenGame): Promise<void> {
  const places = await lockPlaces(game.id);
  if (!places || places.status !== "open" || isPastSlot(game.date, game.startHour, game.timeZone)) return;
  let room = places.spots - places.taken - (places.autoAccept ? 0 : places.requested);
  if (room <= 0) return;
  const db = getDb();
  const line = (await db
    .prepare("SELECT id, user_id FROM open_game_players WHERE game_id = ? AND status = 'waitlisted' ORDER BY created_at, id LIMIT 50")
    .all(game.id)) as { id: number; user_id: number }[];
  for (const p of line) {
    if (room <= 0) break;
    if (await blockedInGame(p.user_id, game.id)) continue;
    room--;
    if (places.autoAccept) {
      const until = untilAtMost(game, OFFER_MINUTES);
      await db.prepare("UPDATE open_game_players SET status = 'offered', expires_at = ?, decided_at = datetime('now') WHERE id = ?").run(until, p.id);
      await tellPlayer(p.user_id, game, "offered", { dedupeKey: `game-offer:${p.id}:${until}` });
    } else {
      await db.prepare("UPDATE open_game_players SET status = 'requested', decided_at = NULL WHERE id = ?").run(p.id);
      await tellHost(game, "asked");
    }
  }
}

/** The host deciding about one player: in, not this time, out, or did not come. */
export async function decide(hostId: number, playerId: number, action: PlayerAction): Promise<GameResult> {
  const db = getDb();
  const row = (await db
    .prepare("SELECT p.status, g.id AS game_id, g.host_id FROM open_game_players p JOIN open_games g ON g.id = p.game_id WHERE p.id = ?")
    .get(playerId)) as { status: PlayerStatus; game_id: number; host_id: number } | undefined;
  if (!row || row.host_id !== hostId) return { ok: false, error: "Not found.", status: 404 };
  const game = (await gameById(row.game_id))!;

  if (action === "no_show") {
    if (row.status !== "accepted") return { ok: false, error: "Only somebody who was in the game can miss it." };
    if (!isPastSlot(game.date, game.startHour, game.timeZone)) return { ok: false, error: "Only once the game has started." };
    await db.prepare("UPDATE open_game_players SET no_show = 1 WHERE id = ?").run(playerId);
    return { ok: true, game: (await gameById(game.id))! };
  }
  if (game.status !== "open") return { ok: false, error: "That game is closed." };
  if (isPastSlot(game.date, game.startHour, game.timeZone)) return { ok: false, error: "That game has started." };

  const refused = await withTransaction(async (): Promise<string | null> => {
    const places = (await lockPlaces(game.id))!;
    const p = (await db.prepare("SELECT status, user_id FROM open_game_players WHERE id = ?").get(playerId)) as { status: PlayerStatus; user_id: number };
    const set = (status: PlayerStatus) =>
      db.prepare("UPDATE open_game_players SET status = ?, decided_at = datetime('now'), expires_at = NULL WHERE id = ?").run(status, playerId);
    if (action === "accept") {
      if (p.status !== "requested" && p.status !== "waitlisted") return "They are not waiting for an answer.";
      if (places.taken >= places.spots) return "The game is full.";
      await set("accepted");
      await tellPlayer(p.user_id, game, "accepted");
    } else if (action === "decline") {
      if (p.status !== "requested" && p.status !== "waitlisted") return "They are not waiting for an answer.";
      await set("declined");
      await tellPlayer(p.user_id, game, "declined");
      await fillPlaces(game);
    } else {
      if (!ACTIVE.includes(p.status)) return "They are not in the game.";
      await set("removed");
      // A withdrawn invitation goes quietly; anybody who asked or was in hears.
      if (p.status === "accepted") await shareOwedBack(playerId);
      if (p.status !== "invited") await tellPlayer(p.user_id, game, "removed");
      await fillPlaces(game);
    }
    return null;
  });
  if (refused) return { ok: false, error: refused };
  return { ok: true, game: (await gameById(game.id))! };
}

/** No more requests. Whoever is in stays in. */
export async function closeGame(hostId: number, gameId: number): Promise<GameResult> {
  const done = await getDb()
    .prepare("UPDATE open_games SET status = 'closed' WHERE id = ? AND host_id = ? AND status = 'open'")
    .run(gameId, hostId);
  if (done.changes === 0) return { ok: false, error: "That game is not open.", status: 404 };
  return { ok: true, game: (await gameById(gameId))! };
}

/**
 * The host calling the game off while keeping the court: everybody in it, or
 * waiting, hears; shares paid are owed back by the venue, and the booking owes
 * them again, as when a player leaves.
 */
export async function cancelGame(hostId: number, gameId: number): Promise<GameResult> {
  const game = await gameById(gameId);
  if (!game || game.hostId !== hostId) return { ok: false, error: "Not found.", status: 404 };
  if (game.status === "cancelled") return { ok: false, error: "That game is already called off." };
  if (isPastSlot(game.date, game.startHour, game.timeZone)) return { ok: false, error: "That game has started." };
  await withTransaction(async () => {
    const db = getDb();
    await db.prepare("SELECT id FROM open_games WHERE id = ? FOR UPDATE").get(gameId);
    await db.prepare("UPDATE open_games SET status = 'cancelled' WHERE id = ?").run(gameId);
    const players = (await db
      .prepare(`SELECT id, user_id, status FROM open_game_players WHERE game_id = ? AND status IN (${ACTIVE_SQL})`)
      .all(gameId)) as { id: number; user_id: number; status: PlayerStatus }[];
    for (const p of players) {
      if (p.status === "accepted") await shareOwedBack(p.id);
      if (p.status !== "invited") await tellPlayer(p.user_id, game, "calledOff");
    }
    await db.prepare("UPDATE game_links SET revoked_at = datetime('now') WHERE game_id = ? AND revoked_at IS NULL").run(gameId);
  });
  return { ok: true, game: (await gameById(gameId))! };
}

// ------------------------------------------------------------ joining

/** No-shows somebody has had marked against them lately. */
export async function recentNoShows(userId: number): Promise<number> {
  const row = (await getDb()
    .prepare(
      `SELECT COUNT(*)::int AS n FROM open_game_players p
         JOIN open_games g ON g.id = p.game_id JOIN bookings b ON b.id = g.booking_id
        WHERE p.user_id = ? AND p.no_show = 1 AND b.date >= ?`
    )
    .get(userId, addDays(todayISO(), -NO_SHOW_DAYS))) as { n: number };
  return row.n;
}

/** Refused in these words whatever the reason, so a block or a private game cannot be found out by trying. */
const NOT_TAKING = "That game is not taking players.";

/**
 * Why this person cannot play in this game at all, whatever the host says,
 * or null: the game's rule on who, adults only, missed games, the venue's
 * blocked numbers, access and sign-offs, and blocks.
 */
async function eligibility(user: { id: number; phone: string }, game: OpenGame): Promise<{ error: string; code?: string; status?: number } | null> {
  const notFor = await whoRefusal(user.id, game.who);
  if (notFor) return { error: notFor.error, code: notFor.code, status: 403 };
  if (game.adultsOnly && (await declaredAdult(user.id)) !== true)
    return { error: "This game is for players who say they are 18 or over.", code: "ADULTS_ONLY", status: 403 };
  if ((await recentNoShows(user.id)) >= MAX_NO_SHOWS)
    return { error: `You missed ${MAX_NO_SHOWS} games you joined in the last ${NO_SHOW_DAYS} days, so you cannot join games for now.` };
  if (await isBlocked(game.venueId, user.phone)) return { error: "This venue is not taking bookings from your number." };
  const notHere = await accessRefusal(game.venueId, user.id);
  if (notHere) return { error: notHere.error, code: notHere.code, status: 403 };
  const unsigned = await signOffRefusal(game.id, user);
  if (unsigned) return { error: unsigned, code: "SIGN_OFF_NEEDED", status: 403 };
  if (await blockedInGame(user.id, game.id)) return { error: NOT_TAKING, status: 409 };
  return null;
}

/**
 * Join, ask to join, or join the waiting list — or take up an invitation or
 * a place held for you. A private game needs an invitation, a held place, or
 * one of its host's links. An invitation from the host is the host's yes; one
 * from another player still leaves a host who decides to decide.
 */
export async function askToJoin(user: { id: number; phone: string }, gameId: number, opts: { link?: string } = {}): Promise<GameResult> {
  const game = await gameById(gameId);
  if (!game) return { ok: false, error: "That game is not there any more.", status: 404 };
  if (game.hostId === user.id) return { ok: false, error: "It is your own game." };
  if (game.status !== "open") return { ok: false, error: NOT_TAKING };
  if (isPastSlot(game.date, game.startHour, game.timeZone)) return { ok: false, error: "That game has started." };
  const place = await myPlace(user.id, gameId);
  if (game.visibility === "private" && !(place && ACTIVE.includes(place.status)) && !(opts.link && (await linkLeadsTo(opts.link, gameId))))
    return { ok: false, error: "That game is not there any more.", status: 404 };
  const refused = await eligibility(user, game);
  if (refused) return { ok: false, ...refused };

  const db = getDb();
  const outcome = await withTransaction(async (): Promise<{ error: string } | { status: PlayerStatus; fromOffer: boolean }> => {
    const places = await lockPlaces(gameId);
    if (!places || places.status !== "open") return { error: NOT_TAKING };
    const existing = (await db
      .prepare(
        `SELECT id, status, invited_by, (expires_at IS NOT NULL AND expires_at < datetime('now')) AS lapsed
           FROM open_game_players WHERE game_id = ? AND user_id = ?`
      )
      .get(gameId, user.id)) as { id: number; status: PlayerStatus; invited_by: number | null; lapsed: boolean } | undefined;
    if (existing) {
      if (existing.status === "accepted") return { error: "You are in this game already." };
      if (existing.status === "requested") return { error: "You have asked already." };
      if (existing.status === "waitlisted") return { error: "You are on the waiting list already." };
      if (existing.status === "declined" || existing.status === "removed") return { error: "The host has said no." };
      if ((existing.status === "invited" || existing.status === "offered") && existing.lapsed) {
        await db.prepare("UPDATE open_game_players SET status = 'expired' WHERE id = ?").run(existing.id);
        if (existing.status === "offered") await fillPlaces(game);
        return { error: existing.status === "offered" ? "The place held for you has gone to the next in line." : "That invitation has expired." };
      }
    }
    let status: PlayerStatus;
    const fromOffer = existing?.status === "offered";
    if (fromOffer) status = "accepted";
    else if (places.taken >= places.spots) {
      if (!places.waitlist) return { error: "That game is full." };
      status = "waitlisted";
    } else {
      const hostSaidYes = existing?.status === "invited" && existing.invited_by === game.hostId;
      status = places.autoAccept || hostSaidYes ? "accepted" : "requested";
    }
    if (existing)
      await db
        .prepare(
          `UPDATE open_game_players SET status = ?, decided_at = NULL, expires_at = NULL,
                  created_at = CASE WHEN ? = 1 THEN created_at ELSE datetime('now') END WHERE id = ?`
        )
        .run(status, fromOffer ? 1 : 0, existing.id);
    else await db.prepare("INSERT INTO open_game_players (game_id, user_id, status) VALUES (?, ?, ?)").run(gameId, user.id, status);
    if (status === "accepted") await tellHost(game, "joined");
    else if (status === "requested") await tellHost(game, "asked");
    return { status, fromOffer };
  });
  if ("error" in outcome) return { ok: false, error: outcome.error };
  return { ok: true, game: (await gameById(gameId))! };
}

/**
 * An activity that asks for a staff sign-off asks it of everyone who plays,
 * not only the host who booked: each player's own, on their account
 * (lib/sign-offs.ts). Null when there is nothing to refuse.
 */
async function signOffRefusal(gameId: number, user: { id: number; phone: string }): Promise<string | null> {
  const row = (await getDb()
    .prepare(
      `SELECT b.court_id, b.sport, b.date, c.venue_id FROM open_games g JOIN bookings b ON b.id = g.booking_id JOIN courts c ON c.id = b.court_id
        WHERE g.id = ?`
    )
    .get(gameId)) as { court_id: number; sport: Sport; date: string; venue_id: number } | undefined;
  if (!row) return null;
  // Imported here: lib/booking-policy.ts reaches lib/store.ts, which reads this module.
  const { policiesFor } = await import("./booking-policy");
  const policy = (await policiesFor([{ id: row.court_id, venueId: row.venue_id, sport: row.sport }])).get(row.court_id);
  const need = policy?.certification ? "certification" : policy?.signOff ? "any" : null;
  if (!need) return null;
  const held = await signOffHolds({ venueId: row.venue_id, sport: row.sport, until: row.date, phone: user.phone, userId: user.id, channel: "customer", need });
  return held ? null : "Everyone playing here needs their own sign-off from the venue's staff first. Ask at the counter.";
}

/**
 * Dropping out before the game: leaving it, withdrawing a request, leaving
 * the waiting list, or turning down an invitation or a held place. A place
 * freed goes to the next in line.
 */
export async function leaveGame(userId: number, gameId: number): Promise<GameResult> {
  const db = getDb();
  const game = await gameById(gameId);
  if (!game) return { ok: false, error: "You are not in that game.", status: 404 };
  if (isPastSlot(game.date, game.startHour, game.timeZone)) return { ok: false, error: "That game has started." };
  const refused = await withTransaction(async (): Promise<string | null> => {
    await lockPlaces(gameId);
    const row = (await db.prepare("SELECT id, status FROM open_game_players WHERE game_id = ? AND user_id = ?").get(gameId, userId)) as
      | { id: number; status: PlayerStatus }
      | undefined;
    if (!row || !ACTIVE.includes(row.status)) return "You are not in that game.";
    await db.prepare("UPDATE open_game_players SET status = 'left', decided_at = datetime('now'), expires_at = NULL WHERE id = ?").run(row.id);
    if (row.status === "accepted") {
      await shareOwedBack(row.id);
      await tellHost(game, "left");
    }
    if (row.status === "accepted" || row.status === "offered") await fillPlaces(game);
    return null;
  });
  if (refused) return { ok: false, error: refused, status: 404 };
  return { ok: true, game: (await gameById(gameId))! };
}

// ------------------------------------------------------------ invitations and links

/**
 * Whether one person may invite another, and why not. A declared adult can
 * be invited by somebody they have come across here (lib/player-safety.ts,
 * related) or, if they have opted in to being found or invited, by anybody.
 * Somebody under 18, or who has not said, only by somebody in a community
 * group with them: never out of the blue. Never across a block.
 */
async function mayInvite(inviterId: number, inviteeId: number): Promise<boolean> {
  if (inviterId === inviteeId || (await blockedBetween(inviterId, inviteeId))) return false;
  const profile = (await getDb().prepare("SELECT adult, discoverable, invitable FROM player_profiles WHERE user_id = ?").get(inviteeId)) as
    | { adult: number | null; discoverable: number; invitable: number }
    | undefined;
  const sameGroup = Boolean(
    await getDb()
      .prepare(
        `SELECT 1 FROM group_members a JOIN group_members b ON b.group_id = a.group_id
          WHERE a.user_id = ? AND b.user_id = ? AND a.status = 'member' AND b.status = 'member' LIMIT 1`
      )
      .get(inviterId, inviteeId)
  );
  if (profile?.adult !== 1) return sameGroup;
  return sameGroup || profile.invitable === 1 || profile.discoverable === 1 || (await related(inviterId, inviteeId));
}

/** Invitations somebody has sent in the last day, to games and groups together. */
export async function invitesToday(userId: number): Promise<number> {
  const row = (await getDb()
    .prepare(
      `SELECT (SELECT COUNT(*) FROM open_game_players WHERE invited_by = ? AND created_at >= datetime('now', '-1 day'))
            + (SELECT COUNT(*) FROM group_members WHERE invited_by = ? AND created_at >= datetime('now', '-1 day')) AS n`
    )
    .get(userId, userId)) as { n: number | string };
  return Number(row.n);
}

export type InviteResult = { ok: true; game: OpenGame } | { ok: false; error: string; status?: number };

/**
 * Invite somebody to a game: its host, or a player in it where the game is
 * public. It stands for INVITE_HOURS, or until the game starts.
 */
export async function invitePlayer(inviterId: number, gameId: number, inviteeId: number): Promise<InviteResult> {
  const game = await gameById(gameId);
  if (!game || game.status !== "open") return { ok: false, error: NOT_TAKING, status: 404 };
  if (isPastSlot(game.date, game.startHour, game.timeZone)) return { ok: false, error: "That game has started." };
  const db = getDb();
  const byHost = game.hostId === inviterId;
  if (!byHost) {
    const mine = await myPlace(inviterId, gameId);
    if (mine?.status !== "accepted" || game.visibility === "private") return { ok: false, error: "Only the host can invite people to this game.", status: 403 };
  }
  if (inviteeId === game.hostId) return { ok: false, error: "They cannot be invited to this game." };
  if (!(await mayInvite(inviterId, inviteeId)) || (await blockedInGame(inviteeId, gameId)))
    return { ok: false, error: "They cannot be invited to this game." };
  if (game.adultsOnly && (await declaredAdult(inviteeId)) !== true) return { ok: false, error: "They cannot be invited to this game." };
  if ((await invitesToday(inviterId)) >= INVITES_PER_DAY) return { ok: false, error: "You have sent a lot of invitations today. Please try again tomorrow.", status: 429 };

  const until = untilAtMost(game, INVITE_HOURS * 60);
  const refused = await withTransaction(async (): Promise<string | null> => {
    await lockPlaces(gameId);
    const open = (await db.prepare("SELECT COUNT(*)::int AS n FROM open_game_players WHERE game_id = ? AND status = 'invited'").get(gameId)) as { n: number };
    if (open.n >= game.spots * OPEN_INVITES_PER_SPOT) return "Wait for some of the invitations already sent to be answered.";
    const existing = (await db.prepare("SELECT id, status FROM open_game_players WHERE game_id = ? AND user_id = ?").get(gameId, inviteeId)) as
      | { id: number; status: PlayerStatus }
      | undefined;
    if (existing && ACTIVE.includes(existing.status)) return "They are already in the game, asking, or invited.";
    // Somebody the host turned down is invited again only by the host.
    if (existing && (existing.status === "declined" || existing.status === "removed") && !byHost) return "They cannot be invited to this game.";
    let rowId: number;
    if (existing) {
      await db
        .prepare("UPDATE open_game_players SET status = 'invited', invited_by = ?, expires_at = ?, decided_at = NULL, created_at = datetime('now') WHERE id = ?")
        .run(inviterId, until, existing.id);
      rowId = existing.id;
    } else
      rowId = (await db
        .prepare("INSERT INTO open_game_players (game_id, user_id, status, invited_by, expires_at) VALUES (?, ?, 'invited', ?, ?)")
        .run(gameId, inviteeId, inviterId, until)).lastInsertRowid!;
    const inviter = (await db.prepare("SELECT name FROM users WHERE id = ?").get(inviterId)) as { name: string };
    await tellPlayer(inviteeId, game, "invited", { by: firstName(inviter.name), dedupeKey: `game-invite:${rowId}:${until}` });
    return null;
  });
  if (refused) return { ok: false, error: refused };
  return { ok: true, game: (await gameById(gameId))! };
}

/**
 * Invite by email address. The answer is the same whether or not the address
 * has an account here and whether or not they may be invited, so nobody can
 * use it to find out who uses MySenam; only those who may be invited are.
 */
export async function inviteByEmail(inviterId: number, gameId: number, email: string): Promise<InviteResult> {
  const game = await gameById(gameId);
  if (!game || (game.hostId !== inviterId && (await myPlace(inviterId, gameId))?.status !== "accepted"))
    return { ok: false, error: "Not found.", status: 404 };
  const user = (await getDb().prepare("SELECT id FROM users WHERE LOWER(email) = LOWER(?)").get(email.trim())) as { id: number } | undefined;
  if (user) {
    const sent = await invitePlayer(inviterId, gameId, user.id);
    // Limits and a game not taking players are the inviter's to hear; nothing about the invitee is.
    if (!sent.ok && (sent.status === 429 || sent.status === 404 || sent.status === 403)) return sent;
  }
  return { ok: true, game: (await gameById(gameId))! };
}

const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

/**
 * A link to the game for the host to pass on, as a private game's way in:
 * only the hash of its secret is kept, it lasts `hours` (at most
 * LINK_MAX_HOURS, never past the game), and the host can withdraw it.
 * Anybody holding it can see the game and ask; the host still decides
 * unless they let everybody in.
 */
export async function createGameLink(
  hostId: number,
  gameId: number,
  hours = 72
): Promise<{ ok: true; token: string; url: string; expiresAt: string } | { ok: false; error: string; status?: number }> {
  const game = await gameById(gameId);
  if (!game || game.hostId !== hostId) return { ok: false, error: "Not found.", status: 404 };
  if (game.status !== "open") return { ok: false, error: NOT_TAKING };
  if (!Number.isInteger(hours) || hours < 1 || hours > LINK_MAX_HOURS) return { ok: false, error: `A link lasts 1 to ${LINK_MAX_HOURS} hours.` };
  const live = (await getDb()
    .prepare("SELECT COUNT(*)::int AS n FROM game_links WHERE game_id = ? AND revoked_at IS NULL AND expires_at > datetime('now')")
    .get(gameId)) as { n: number };
  if (live.n >= 5) return { ok: false, error: "This game has enough links; withdraw them to make a new one." };
  const token = crypto.randomBytes(24).toString("base64url");
  const expiresAt = untilAtMost(game, hours * 60);
  await getDb().prepare("INSERT INTO game_links (game_id, token_hash, created_by, expires_at) VALUES (?, ?, ?, ?)").run(gameId, hashToken(token), hostId, expiresAt);
  return { ok: true, token, url: `${baseUrl()}/games?game=${gameId}&link=${token}`, expiresAt };
}

/** Withdraw every link to a game; invitations already sent stand. */
export async function revokeGameLinks(hostId: number, gameId: number): Promise<number> {
  const done = await getDb()
    .prepare(
      `UPDATE game_links SET revoked_at = datetime('now')
        WHERE game_id = ? AND revoked_at IS NULL AND game_id IN (SELECT id FROM open_games WHERE host_id = ?)`
    )
    .run(gameId, hostId);
  return done.changes;
}

async function linkLeadsTo(token: string, gameId: number): Promise<boolean> {
  return Boolean(
    await getDb()
      .prepare("SELECT 1 FROM game_links WHERE token_hash = ? AND game_id = ? AND revoked_at IS NULL AND expires_at > datetime('now')")
      .get(hashToken(token), gameId)
  );
}

/**
 * One game as this person may see it: a public game to anybody; a private one
 * to its host, to whoever has a place in it or an invitation, and to whoever
 * holds a live link. Null otherwise, the same as no game at all.
 */
export async function gameForViewer(gameId: number, viewerId: number | null, link?: string): Promise<OpenGame | null> {
  const game = await gameById(gameId);
  if (!game) return null;
  const yours = viewerId !== null && game.hostId === viewerId;
  const mine = viewerId !== null && !yours ? await myPlace(viewerId, gameId) : null;
  if (game.visibility === "private" && !yours && !(mine && ACTIVE.includes(mine.status)) && !(link && (await linkLeadsTo(link, gameId)))) return null;
  game.yours = yours;
  game.mine = mine;
  if (yours) game.players = await gamePlayers(gameId);
  return game;
}

/**
 * Invitations and held places that ran out: expired, and each freed place
 * passed to the next in line. Safe to run on several servers at once: each
 * row changes once, and passing a place on happens under the game's lock.
 */
export async function expireHolds(): Promise<{ invitations: number; offers: number }> {
  const db = getDb();
  const invitations = await db
    .prepare("UPDATE open_game_players SET status = 'expired' WHERE status = 'invited' AND expires_at < datetime('now') RETURNING id")
    .all();
  const offers = (await db
    .prepare("UPDATE open_game_players SET status = 'expired' WHERE status = 'offered' AND expires_at < datetime('now') RETURNING game_id")
    .all()) as { game_id: number }[];
  for (const gameId of new Set(offers.map((o) => o.game_id))) {
    const game = await gameById(gameId);
    if (game) await withTransaction(() => fillPlaces(game));
  }
  return { invitations: invitations.length, offers: offers.length };
}

// ------------------------------------------------------------ finding

export async function findGames(filter: {
  sport?: Sport;
  date?: string;
  area?: string;
  near?: Near;
  level?: Level;
  /** Only games with this rule: `women` finds women-only games. */
  who?: Who;
  venueIds?: number[];
  forUser?: number;
  limit?: number;
}): Promise<OpenGame[]> {
  const today = todayISO();
  const clauses = [
    "g.status = 'open'",
    "g.visibility = 'public'",
    "b.status = 'confirmed'",
    listRule(filter.venueIds),
    "b.date >= ?",
    "b.date <= ?",
    // Full games only where they keep a waiting list.
    "(g.waitlist = 1 OR (SELECT COUNT(*) FROM open_game_players p WHERE p.game_id = g.id AND p.status IN ('accepted', 'offered')) < g.spots)",
  ];
  const params: (string | number)[] = [filter.date ?? today, filter.date ?? addDays(today, 14)];
  if (filter.sport) {
    clauses.push("b.sport = ?");
    params.push(filter.sport);
  }
  if (filter.area && !filter.near) {
    clauses.push("v.area = ?");
    params.push(filter.area);
  }
  if (filter.level) {
    clauses.push("(g.level IS NULL OR g.level = ?)");
    params.push(filter.level);
  }
  if (filter.who) {
    clauses.push("g.who = ?");
    params.push(filter.who);
  }
  if (filter.venueIds) {
    if (filter.venueIds.length === 0) return [];
    clauses.push(`v.id IN (${filter.venueIds.map(() => "?").join(",")})`);
    params.push(...filter.venueIds);
  }
  if (filter.near) {
    const dLat = filter.near.km / 111;
    const dLng = filter.near.km / (111 * Math.max(Math.cos((filter.near.lat * Math.PI) / 180), 0.01));
    clauses.push("v.lat BETWEEN ? AND ? AND v.lng BETWEEN ? AND ?");
    params.push(filter.near.lat - dLat, filter.near.lat + dLat, filter.near.lng - dLng, filter.near.lng + dLng);
  }
  const rows = (await getDb()
    .prepare(`${GAME_SELECT} WHERE ${clauses.join(" AND ")} ORDER BY b.date, b.start_min, g.id LIMIT 200`)
    .all(...params)) as GameRow[];

  const games: OpenGame[] = [];
  for (const r of rows) {
    if (isPastSlot(r.date, hoursOf(r.start_min), venueZoneOf(r))) continue;
    const game = toGame(r);
    if (filter.near) {
      const km = Math.round(distanceM(filter.near, { lat: r.lat!, lng: r.lng! }) / 100) / 10;
      if (km > filter.near.km) continue;
      game.distanceKm = km;
    }
    games.push(game);
  }
  if (filter.near) games.sort((a, b) => a.date.localeCompare(b.date) || a.startHour - b.startHour || (a.distanceKm ?? 0) - (b.distanceKm ?? 0));
  const shown = games.slice(0, filter.limit ?? 60);
  if (filter.forUser !== undefined)
    for (const g of shown) {
      g.yours = g.hostId === filter.forUser;
      g.mine = g.yours ? null : await myPlace(filter.forUser, g.id);
    }
  return shown;
}

async function myPlace(userId: number, gameId: number): Promise<OpenGame["mine"]> {
  const row = (await getDb()
    .prepare("SELECT id, status, paid_at, expires_at FROM open_game_players WHERE game_id = ? AND user_id = ?")
    .get(gameId, userId)) as { id: number; status: PlayerStatus; paid_at: string | null; expires_at: string | null } | undefined;
  return row ? { playerId: row.id, status: row.status, paid: row.paid_at !== null, expiresAt: row.expires_at } : null;
}

/** A player's own games: those they host, with who asked, and those they are in, asked, invited to or waiting for. */
export async function myGames(userId: number): Promise<{ hosting: OpenGame[]; playing: OpenGame[] }> {
  const since = addDays(todayISO(), -7);
  const db = getDb();
  const hosting = ((await db
    .prepare(`${GAME_SELECT} WHERE g.host_id = ? AND b.date >= ? ORDER BY b.date, b.start_min`)
    .all(userId, since)) as GameRow[]).map(toGame);
  for (const g of hosting) g.players = await gamePlayers(g.id);
  const playing = ((await db
    .prepare(
      `${GAME_SELECT} WHERE b.date >= ? AND g.id IN (
         SELECT game_id FROM open_game_players WHERE user_id = ? AND status IN (${ACTIVE_SQL}))
       ORDER BY b.date, b.start_min`
    )
    .all(since, userId)) as GameRow[]).map(toGame);
  for (const g of playing) g.mine = await myPlace(userId, g.id);
  return { hosting, playing };
}

// ------------------------------------------------------------ money

/**
 * A player who paid their share and is no longer playing — they left, were
 * removed, or the booking went — is owed it back, by the venue, like any
 * online payment for something that did not happen.
 *
 * Where the game goes on without them, their share comes off what the booking
 * has had paid towards it, so the host owes it again: the venue is not out of
 * pocket for a share it handed back. A booking that shares alone had paid
 * for is unpaid again, unless the host paid for it too.
 */
async function shareOwedBack(playerId: number, bookingGone = false): Promise<void> {
  const db = getDb();
  const repaid = (await db
    .prepare(
      `UPDATE online_payments SET refund_due = amount
        WHERE game_player_id = ? AND purpose = 'share' AND status = 'paid' AND refund_due < amount
        RETURNING amount::float AS amount`
    )
    .all(playerId)) as { amount: number }[];
  const total = Math.round(repaid.reduce((sum, r) => sum + Number(r.amount), 0) * 100) / 100;
  if (total <= 0 || bookingGone) return;
  const place = (await db
    .prepare("SELECT g.booking_id FROM open_game_players p JOIN open_games g ON g.id = p.game_id WHERE p.id = ?")
    .get(playerId)) as { booking_id: number } | undefined;
  await db.prepare("UPDATE open_game_players SET paid_at = NULL WHERE id = ?").run(playerId);
  if (place) await unpayShare(place.booking_id, total);
}

/**
 * A share paid towards a booking (a game player's, a friend's in a split) no
 * longer counts: the booking owes it again, and one that shares alone had paid
 * for is unpaid again.
 *
 * One the booker had paid the rest of online is short by the share, and the
 * booker owes just that. What they paid becomes a part paid, as a deposit is:
 * on a receipt of its own, dated when it was paid so it stays in that period,
 * and counted towards the booking, which is unpaid for the share.
 */
export async function unpayShare(bookingId: number, amount: number): Promise<void> {
  const db = getDb();
  const before = (await db
    .prepare(
      `SELECT b.code, b.user_id, b.name, b.phone, b.payment_status, b.paid_via, b.paid_at, b.total_price::float AS total_price,
              b.shares_paid::float AS shares_paid, c.venue_id
         FROM bookings b JOIN courts c ON c.id = b.court_id WHERE b.id = ?`
    )
    .get(bookingId)) as
    | { code: string; user_id: number | null; name: string; phone: string; payment_status: string; paid_via: string | null;
        paid_at: string | null; total_price: number; shares_paid: number; venue_id: number }
    | undefined;
  if (!before) return;
  const sharesNow = Math.max(0, Math.round((before.shares_paid - amount) * 100) / 100);
  await db.prepare("UPDATE bookings SET shares_paid = ? WHERE id = ?").run(sharesNow, bookingId);
  if (before.payment_status !== "paid" || before.paid_via !== "online" || sharesNow >= before.total_price) return;

  const parts = (await db
    .prepare(
      `SELECT op.id, pb.amount::float AS amount FROM online_payment_bookings pb JOIN online_payments op ON op.id = pb.payment_id
        WHERE pb.booking_id = ? AND op.status = 'paid' AND op.deposit = 0 AND op.purpose = 'booking'
          AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.source = 'booking-part:' || pb.booking_id || ':' || op.id)
        ORDER BY op.id`
    )
    .all(bookingId)) as { id: number; amount: number | null }[];
  // A page made before what it billed was recorded asked for what was due then.
  const paid = parts.map((p) => ({ id: p.id, amount: p.amount === null ? before.total_price - before.shares_paid : Number(p.amount) }));
  const part = Math.round(paid.reduce((sum, p) => sum + p.amount, 0) * 100) / 100;
  await db
    .prepare(
      `UPDATE bookings SET payment_status = 'unpaid', paid_at = NULL, paid_via = NULL,
              shares_paid = shares_paid + ?, deposit_paid = deposit_paid + ? WHERE id = ?`
    )
    .run(part, part, bookingId);
  const { issueReceipt } = await import("./documents");
  const issuedAt = before.paid_at ? before.paid_at.replace("T", " ").slice(0, 19) : null;
  for (const p of paid)
    await issueReceipt({
      source: `booking-part:${bookingId}:${p.id}`,
      venueId: before.venue_id,
      userId: before.user_id,
      name: before.name,
      phone: before.phone,
      lines: [{ description: `Paid online towards ${before.code}`, amount: Math.round(p.amount * 100) / 100 }],
      paidVia: "online",
      taxable: true,
      issuedAt,
    });
}

/**
 * The booking under a game was cancelled: the game goes, everybody in it
 * hears, and any share paid is owed back. Called wherever a booking is.
 */
export async function bookingCancelled(bookingId: number): Promise<void> {
  const db = getDb();
  const game = (await db
    .prepare("UPDATE open_games SET status = 'cancelled' WHERE booking_id = ? AND status <> 'cancelled' RETURNING id")
    .get(bookingId)) as { id: number } | undefined;
  if (!game) return;
  const players = (await db
    .prepare(`SELECT id, user_id, status FROM open_game_players WHERE game_id = ? AND status IN (${ACTIVE_SQL})`)
    .all(game.id)) as { id: number; user_id: number; status: PlayerStatus }[];
  const details = await gameById(game.id);
  for (const p of players) {
    await shareOwedBack(p.id, true);
    if (details && p.status !== "invited") await tellPlayer(p.user_id, details, "cancelled");
  }
}

/**
 * Somebody closing their account: out of every game still to come that they
 * asked to join, are in, are invited to or waiting for, with any share they
 * paid owed back, its host told, and a place freed passed on. Their own games
 * go with the bookings under them.
 */
export async function forgetPlayer(userId: number): Promise<void> {
  const rows = (await getDb()
    .prepare(
      `SELECT p.id, p.status, g.id AS game_id FROM open_game_players p
         JOIN open_games g ON g.id = p.game_id JOIN bookings b ON b.id = g.booking_id
        WHERE p.user_id = ? AND p.status IN (${ACTIVE_SQL}) AND b.date >= ?`
    )
    .all(userId, todayISO())) as { id: number; status: PlayerStatus; game_id: number }[];
  for (const r of rows) {
    const game = await gameById(r.game_id);
    await withTransaction(async () => {
      if (game) await lockPlaces(game.id);
      await getDb().prepare("UPDATE open_game_players SET status = 'left', expires_at = NULL WHERE id = ?").run(r.id);
      await shareOwedBack(r.id);
      if (game && r.status === "accepted") await tellHost(game, "left");
      if (game && (r.status === "accepted" || r.status === "offered") && !isPastSlot(game.date, game.startHour, game.timeZone)) await fillPlaces(game);
    });
  }
}

// ------------------------------------------------------------ telling people

const when = (g: OpenGame) => `${g.date} ${formatHour(g.startHour)}–${formatHour(g.endHour)}`;

async function emailUser(userId: number, venueId: number, subject: string, body: string, dedupeKey?: string): Promise<void> {
  await emailPlayer({ venueId, userId, subject, body, link: `${baseUrl()}/games`, dedupeKey });
}

async function tellPlayer(
  userId: number,
  g: OpenGame,
  what: "accepted" | "declined" | "removed" | "cancelled" | "calledOff" | "offered" | "invited",
  opts: { by?: string; dedupeKey?: string } = {}
): Promise<void> {
  const game = `${g.courtName} at ${g.venueName}, ${when(g)}`;
  const lines = {
    accepted: [
      `You're in: ${g.venueName}, ${when(g)}`,
      `${g.hostName} has you in their game: ${game}. The court is booked under ${g.bookingCode}.` +
        (g.share > 0
          ? g.payOnline
            ? ` Your share is ${money(g.share.toFixed(2))}; pay it from My games.`
            : ` Your share is ${money(g.share.toFixed(2))}, paid at the venue.`
          : ""),
    ],
    declined: [`Not this time: ${g.venueName}, ${when(g)}`, `${g.hostName}'s game (${game}) is full or not the right fit this time.`],
    removed: [`You're out of a game: ${g.venueName}, ${when(g)}`, `${g.hostName} has taken you out of their game (${game}). Any share you paid online will be refunded by the venue.`],
    cancelled: [`Game called off: ${g.venueName}, ${when(g)}`, `The booking for ${g.hostName}'s game (${game}) was cancelled. Any share you paid online will be refunded by the venue.`],
    calledOff: [`Game called off: ${g.venueName}, ${when(g)}`, `${g.hostName} has called off their game (${game}). Any share you paid online will be refunded by the venue.`],
    offered: [
      `A place is free for you: ${g.venueName}, ${when(g)}`,
      `A place has come up in ${g.hostName}'s game (${game}), and it is held for you for ${OFFER_MINUTES / 60} hours. Take it or let it go under My games; after that it goes to the next in line.`,
    ],
    invited: [
      `${opts.by ?? g.hostName} invited you to a game: ${g.venueName}, ${when(g)}`,
      `${opts.by ?? g.hostName} has invited you to ${g.hostName}'s game: ${game}.` +
        (g.share > 0 ? ` Each player's share is ${money(g.share.toFixed(2))}.` : "") +
        ` Say yes or no under My games; the invitation lasts ${INVITE_HOURS} hours. Nothing is booked or paid until you say yes.`,
    ],
  }[what];
  await emailUser(userId, g.venueId, lines[0], lines[1], opts.dedupeKey);
}

async function tellHost(g: OpenGame, what: "asked" | "joined" | "left"): Promise<void> {
  const lines = {
    asked: [`Somebody wants to join your game, ${when(g)}`, `A player has asked to join your game at ${g.venueName}, ${when(g)}. Say yes or no under My games.`],
    joined: [`A player joined your game, ${when(g)}`, `A player has joined your game at ${g.venueName}, ${when(g)}.`],
    left: [`A player left your game, ${when(g)}`, `A player has dropped out of your game at ${g.venueName}, ${when(g)}. It is open for somebody else.`],
  }[what];
  await emailUser(g.hostId, g.venueId, lines[0], lines[1]);
}
