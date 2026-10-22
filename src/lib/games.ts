import { getDb } from "./db";
import { venueZoneOf } from "./zones";
import { isBlocked } from "./limits";
import { accessRefusal } from "./access";
import { listRule, OPEN_TO_CUSTOMERS } from "./listing";
import { siteName } from "./site";
import { distanceM } from "./geo";
import { baseUrl } from "./outbox";
import { sendPlainEmail } from "./transports";
import { addDays, formatHour, isPastSlot, todayISO } from "./time";
import type { Near } from "./store";
import { isWho, whoRefusal, type Who } from "./who";
import type { Sport } from "./types";
import { money } from "./region";

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
 */

export const LEVELS = ["beginner", "intermediate", "advanced", "competitive"] as const;
export type Level = (typeof LEVELS)[number];
export const MAX_SPOTS = 10;
/** Joining stops after this many no-shows in NO_SHOW_DAYS. */
export const MAX_NO_SHOWS = 3;
export const NO_SHOW_DAYS = 90;

export type GameStatus = "open" | "closed" | "cancelled";
export type PlayerStatus = "requested" | "accepted" | "declined" | "left" | "removed";

export interface GamePlayer {
  id: number;
  userId: number;
  /** First name only. */
  name: string;
  level: Level | null;
  status: PlayerStatus;
  paid: boolean;
  noShow: boolean;
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
  share: number;
  autoAccept: boolean;
  note: string | null;
  status: GameStatus;
  distanceKm?: number;
  /** For whoever is asking: their place in it, if any. */
  mine?: { playerId: number; status: PlayerStatus; paid: boolean } | null;
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
  start_hour: number;
  end_hour: number;
  level: Level | null;
  who: Who;
  spots: number;
  joined: number;
  share: number;
  auto_accept: number;
  note: string | null;
  status: GameStatus;
  pay_online: boolean;
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

const GAME_SELECT = `
  SELECT g.id, g.booking_id, b.code AS booking_code, g.host_id, u.name AS host_name, hl.level AS host_level,
         v.id AS venue_id, v.name AS venue_name, v.area, v.lat, v.lng, v.time_zone, c.name AS court_name, c.sport,
         b.date, b.start_hour, b.end_hour, g.level, g.who, g.spots,
         (SELECT COUNT(*)::int FROM open_game_players p WHERE p.game_id = g.id AND p.status = 'accepted') AS joined,
         g.share::float AS share, g.auto_accept, g.note, g.status,
         EXISTS (SELECT 1 FROM venue_payment_accounts a WHERE a.venue_id = v.id AND a.enabled = 1) AS pay_online
    FROM open_games g
    JOIN bookings b ON b.id = g.booking_id
    JOIN courts c ON c.id = b.court_id
    JOIN venues v ON v.id = c.venue_id
    JOIN users u ON u.id = g.host_id
    LEFT JOIN player_levels hl ON hl.user_id = g.host_id AND hl.sport = c.sport`;

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
    startHour: r.start_hour,
    endHour: r.end_hour,
    level: r.level,
    who: r.who,
    spots: r.spots,
    joined: r.joined,
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
  input: { bookingCode: string; spots: number; level: Level | null; share: number; autoAccept: boolean; note?: string; who?: Who }
): Promise<GameResult> {
  const db = getDb();
  const booking = (await db
    .prepare(
      `SELECT b.id, b.user_id, b.date, b.start_hour, b.status, b.class_id, b.total_price::float AS total_price,
              b.hold_until, b.payment_status, v.time_zone, v.lat, v.lng, (${OPEN_TO_CUSTOMERS}) AS open
         FROM bookings b JOIN courts c ON c.id = b.court_id JOIN venues v ON v.id = c.venue_id
        WHERE UPPER(b.code) = UPPER(?)`
    )
    .get(input.bookingCode.trim())) as
    | {
        id: number; user_id: number | null; date: string; start_hour: number; status: string; class_id: number | null;
        total_price: number; open: boolean; time_zone: string | null; lat: number | null; lng: number | null;
        hold_until: string | null; payment_status: string;
      }
    | undefined;
  if (!booking || booking.user_id !== hostId) return { ok: false, error: "That is not one of your bookings.", status: 404 };
  if (booking.status !== "confirmed") return { ok: false, error: "That booking is cancelled." };
  if (booking.class_id !== null) return { ok: false, error: "A class place cannot be shared." };
  if (isPastSlot(booking.date, booking.start_hour, venueZoneOf(booking))) return { ok: false, error: "That booking has already started." };
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

  const info = await db
    .prepare(
      "INSERT INTO open_games (booking_id, host_id, level, who, spots, share, auto_accept, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      booking.id,
      hostId,
      input.level,
      who,
      input.spots,
      Math.round(input.share * 100) / 100,
      input.autoAccept ? 1 : 0,
      input.note?.trim().slice(0, 300) || null
    );
  return { ok: true, game: (await gameById(info.lastInsertRowid as number))! };
}

/** The host's view of a game: everybody who asked, and how they stand. */
export async function gamePlayers(gameId: number): Promise<GamePlayer[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT p.id, p.user_id, u.name, pl.level, p.status, p.paid_at, p.no_show
         FROM open_game_players p
         JOIN users u ON u.id = p.user_id
         JOIN open_games g ON g.id = p.game_id
         JOIN bookings b ON b.id = g.booking_id
         JOIN courts c ON c.id = b.court_id
         LEFT JOIN player_levels pl ON pl.user_id = p.user_id AND pl.sport = c.sport
        WHERE p.game_id = ? ORDER BY p.id`
    )
    .all(gameId)) as { id: number; user_id: number; name: string; level: Level | null; status: PlayerStatus; paid_at: string | null; no_show: number }[];
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    name: firstName(r.name),
    level: r.level,
    status: r.status,
    paid: r.paid_at !== null,
    noShow: r.no_show === 1,
  }));
}

export type PlayerAction = "accept" | "decline" | "remove" | "no_show";

/** The host deciding about one player. */
export async function decide(hostId: number, playerId: number, action: PlayerAction): Promise<GameResult> {
  const db = getDb();
  const row = (await db
    .prepare(
      `SELECT p.id, p.status, p.user_id, p.paid_at, g.id AS game_id, g.host_id, g.status AS game_status, g.spots
         FROM open_game_players p JOIN open_games g ON g.id = p.game_id WHERE p.id = ?`
    )
    .get(playerId)) as
    | { id: number; status: PlayerStatus; user_id: number; paid_at: string | null; game_id: number; host_id: number; game_status: GameStatus; spots: number }
    | undefined;
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

  if (action === "accept") {
    if (row.status !== "requested") return { ok: false, error: "They are not waiting for an answer." };
    if (game.joined >= game.spots) return { ok: false, error: "The game is full." };
    await db
      .prepare("UPDATE open_game_players SET status = 'accepted', decided_at = datetime('now') WHERE id = ?")
      .run(playerId);
    await tellPlayer(row.user_id, game, "accepted");
  } else if (action === "decline") {
    if (row.status !== "requested") return { ok: false, error: "They are not waiting for an answer." };
    await db
      .prepare("UPDATE open_game_players SET status = 'declined', decided_at = datetime('now') WHERE id = ?")
      .run(playerId);
    await tellPlayer(row.user_id, game, "declined");
  } else {
    if (row.status !== "accepted" && row.status !== "requested")
      return { ok: false, error: "They are not in the game." };
    await db
      .prepare("UPDATE open_game_players SET status = 'removed', decided_at = datetime('now') WHERE id = ?")
      .run(playerId);
    await shareOwedBack(playerId);
    await tellPlayer(row.user_id, game, "removed");
  }
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

export async function askToJoin(user: { id: number; phone: string }, gameId: number): Promise<GameResult> {
  const game = await gameById(gameId);
  if (!game) return { ok: false, error: "That game is not there any more.", status: 404 };
  if (game.hostId === user.id) return { ok: false, error: "It is your own game." };
  if (game.status !== "open") return { ok: false, error: "That game is not taking players." };
  if (isPastSlot(game.date, game.startHour, game.timeZone)) return { ok: false, error: "That game has started." };
  if (game.joined >= game.spots) return { ok: false, error: "That game is full." };
  const notFor = await whoRefusal(user.id, game.who);
  if (notFor) return { ok: false, error: notFor.error, code: notFor.code, status: 403 };
  if ((await recentNoShows(user.id)) >= MAX_NO_SHOWS)
    return {
      ok: false,
      error: `You missed ${MAX_NO_SHOWS} games you joined in the last ${NO_SHOW_DAYS} days, so you cannot join games for now.`,
    };
  if (await isBlocked(game.venueId, user.phone)) return { ok: false, error: "This venue is not taking bookings from your number." };
  const notHere = await accessRefusal(game.venueId, user.id);
  if (notHere) return { ok: false, error: notHere.error, code: notHere.code, status: 403 };

  const db = getDb();
  const existing = (await db
    .prepare("SELECT id, status FROM open_game_players WHERE game_id = ? AND user_id = ?")
    .get(gameId, user.id)) as { id: number; status: PlayerStatus } | undefined;
  if (existing && existing.status !== "left")
    return { ok: false, error: existing.status === "declined" || existing.status === "removed" ? "The host has said no." : "You have asked already." };

  const status: PlayerStatus = game.autoAccept ? "accepted" : "requested";
  if (existing)
    await db
      .prepare("UPDATE open_game_players SET status = ?, decided_at = NULL, created_at = datetime('now') WHERE id = ?")
      .run(status, existing.id);
  else
    await db
      .prepare("INSERT INTO open_game_players (game_id, user_id, status) VALUES (?, ?, ?)")
      .run(gameId, user.id, status);
  await tellHost(game, status === "accepted" ? "joined" : "asked");
  return { ok: true, game: (await gameById(gameId))! };
}

/** Somebody who asked, or is in, dropping out before the game. */
export async function leaveGame(userId: number, gameId: number): Promise<GameResult> {
  const db = getDb();
  const game = await gameById(gameId);
  const row = (await db
    .prepare("SELECT id, status FROM open_game_players WHERE game_id = ? AND user_id = ?")
    .get(gameId, userId)) as { id: number; status: PlayerStatus } | undefined;
  if (!game || !row || (row.status !== "requested" && row.status !== "accepted"))
    return { ok: false, error: "You are not in that game.", status: 404 };
  if (isPastSlot(game.date, game.startHour, game.timeZone)) return { ok: false, error: "That game has started." };
  await db.prepare("UPDATE open_game_players SET status = 'left', decided_at = datetime('now') WHERE id = ?").run(row.id);
  await shareOwedBack(row.id);
  if (row.status === "accepted") await tellHost(game, "left");
  return { ok: true, game: (await gameById(gameId))! };
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
    "b.status = 'confirmed'",
    listRule(filter.venueIds),
    "b.date >= ?",
    "b.date <= ?",
    "(SELECT COUNT(*) FROM open_game_players p WHERE p.game_id = g.id AND p.status = 'accepted') < g.spots",
  ];
  const params: (string | number)[] = [filter.date ?? today, filter.date ?? addDays(today, 14)];
  if (filter.sport) {
    clauses.push("c.sport = ?");
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
    .prepare(`${GAME_SELECT} WHERE ${clauses.join(" AND ")} ORDER BY b.date, b.start_hour, g.id LIMIT 200`)
    .all(...params)) as GameRow[];

  const games: OpenGame[] = [];
  for (const r of rows) {
    if (isPastSlot(r.date, r.start_hour, venueZoneOf(r))) continue;
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
    .prepare("SELECT id, status, paid_at FROM open_game_players WHERE game_id = ? AND user_id = ?")
    .get(gameId, userId)) as { id: number; status: PlayerStatus; paid_at: string | null } | undefined;
  return row ? { playerId: row.id, status: row.status, paid: row.paid_at !== null } : null;
}

/** A player's own games: those they host, with who asked, and those they are in. */
export async function myGames(userId: number): Promise<{ hosting: OpenGame[]; playing: OpenGame[] }> {
  const since = addDays(todayISO(), -7);
  const db = getDb();
  const hosting = ((await db
    .prepare(`${GAME_SELECT} WHERE g.host_id = ? AND b.date >= ? ORDER BY b.date, b.start_hour`)
    .all(userId, since)) as GameRow[]).map(toGame);
  for (const g of hosting) g.players = await gamePlayers(g.id);
  const playing = ((await db
    .prepare(
      `${GAME_SELECT} WHERE b.date >= ? AND g.id IN (
         SELECT game_id FROM open_game_players WHERE user_id = ? AND status IN ('requested', 'accepted'))
       ORDER BY b.date, b.start_hour`
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
    .prepare("SELECT id, user_id FROM open_game_players WHERE game_id = ? AND status IN ('requested', 'accepted')")
    .all(game.id)) as { id: number; user_id: number }[];
  const details = await gameById(game.id);
  for (const p of players) {
    await shareOwedBack(p.id, true);
    if (details) await tellPlayer(p.user_id, details, "cancelled");
  }
}

/**
 * Somebody closing their account: out of every game still to come that they
 * asked to join or are in, with any share they paid owed back, and its host
 * told. Their own games go with the bookings under them.
 */
export async function forgetPlayer(userId: number): Promise<void> {
  const rows = (await getDb()
    .prepare(
      `SELECT p.id, p.status, g.id AS game_id FROM open_game_players p
         JOIN open_games g ON g.id = p.game_id JOIN bookings b ON b.id = g.booking_id
        WHERE p.user_id = ? AND p.status IN ('requested', 'accepted') AND b.date >= ?`
    )
    .all(userId, todayISO())) as { id: number; status: PlayerStatus; game_id: number }[];
  for (const r of rows) {
    await getDb().prepare("UPDATE open_game_players SET status = 'left' WHERE id = ?").run(r.id);
    await shareOwedBack(r.id);
    const game = await gameById(r.game_id);
    if (game && r.status === "accepted") await tellHost(game, "left");
  }
}

// ------------------------------------------------------------ telling people

const when = (g: OpenGame) => `${g.date} ${formatHour(g.startHour)}–${formatHour(g.endHour)}`;

async function emailUser(userId: number, subject: string, body: string): Promise<void> {
  const user = (await getDb().prepare("SELECT name, email FROM users WHERE id = ?").get(userId)) as
    | { name: string; email: string }
    | undefined;
  if (!user) return;
  await sendPlainEmail(user.email, subject, `Hi ${firstName(user.name)},\n\n${body}\n\n${baseUrl()}/games\n\n${siteName()}`);
}

async function tellPlayer(userId: number, g: OpenGame, what: "accepted" | "declined" | "removed" | "cancelled"): Promise<void> {
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
  }[what];
  await emailUser(userId, lines[0], lines[1]);
}

async function tellHost(g: OpenGame, what: "asked" | "joined" | "left"): Promise<void> {
  const lines = {
    asked: [`Somebody wants to join your game, ${when(g)}`, `A player has asked to join your game at ${g.venueName}, ${when(g)}. Say yes or no under My games.`],
    joined: [`A player joined your game, ${when(g)}`, `A player has joined your game at ${g.venueName}, ${when(g)}.`],
    left: [`A player left your game, ${when(g)}`, `A player has dropped out of your game at ${g.venueName}, ${when(g)}. It is open for somebody else.`],
  }[what];
  await emailUser(g.hostId, lines[0], lines[1]);
}
