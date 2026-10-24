import { getDb } from "./db";
import { hoursOf } from "./interval";
import { venueZoneOf } from "./zones";
import { isPastSlot, todayISO } from "./time";
import { cancelGame, gameById, gamesByIds, invitePlayer, openGame, type Level, type OpenGame, type Visibility } from "./games";
import type { Intensity } from "./player-profiles";
import type { Who } from "./who";

/**
 * A weekly game: the host's own weekly booking (a booking series,
 * bookings.series_code), with an open game on each of its dates.
 *
 * Nothing here holds a court. A date the host has a booking for gets a game;
 * a date without one has none, and the series never books anything itself.
 * When the host extends the booking series, the scheduler opens the new
 * dates' games (extendSeries). Cancelling one date's booking calls off that
 * date's game only, as for any game.
 *
 * Players are never carried from one week to the next without being asked:
 * the host can invite last week's players to this week's game, and each says
 * yes or no as to any invitation.
 */

export interface Series {
  id: number;
  hostId: number;
  bookingSeriesCode: string;
  title: string | null;
  status: "active" | "ended";
  games: OpenGame[];
}

export type SeriesSettings = {
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
};

/** The upcoming confirmed bookings of a booking series, soonest first. */
async function seriesBookings(code: string): Promise<{ id: number; code: string; date: string; start_min: number; time_zone: string | null; lat: number | null; lng: number | null }[]> {
  return (await getDb()
    .prepare(
      `SELECT b.id, b.code, b.date, b.start_min, v.time_zone, v.lat, v.lng FROM bookings b
         JOIN courts c ON c.id = b.court_id JOIN venues v ON v.id = c.venue_id
        WHERE UPPER(b.series_code) = UPPER(?) AND b.status = 'confirmed' AND b.date >= ? ORDER BY b.date, b.start_min`
    )
    .all(code, todayISO())) as { id: number; code: string; date: string; start_min: number; time_zone: string | null; lat: number | null; lng: number | null }[];
}

async function settingsOf(seriesId: number): Promise<SeriesSettings | null> {
  // The newest game in the series carries its settings forward.
  const g = (await getDb()
    .prepare("SELECT id FROM open_games WHERE series_id = ? ORDER BY id DESC LIMIT 1")
    .get(seriesId)) as { id: number } | undefined;
  const game = g ? await gameById(g.id) : null;
  if (!game) return null;
  return {
    spots: game.spots,
    level: game.level,
    share: game.share,
    autoAccept: game.autoAccept,
    note: game.note ?? undefined,
    who: game.who,
    visibility: game.visibility,
    waitlist: game.waitlist,
    intensity: game.intensity,
    adultsOnly: game.adultsOnly,
  };
}

/** Open a game on every upcoming date of the series that has none yet. */
async function openMissing(seriesId: number, hostId: number, code: string, settings: SeriesSettings): Promise<{ opened: number; skipped: { date: string; reason: string }[] }> {
  let opened = 0;
  const skipped: { date: string; reason: string }[] = [];
  for (const b of await seriesBookings(code)) {
    if (isPastSlot(b.date, hoursOf(b.start_min), venueZoneOf(b))) continue;
    if (await getDb().prepare("SELECT 1 FROM open_games WHERE booking_id = ?").get(b.id)) continue;
    const made = await openGame(hostId, { ...settings, bookingCode: b.code, seriesId });
    if (made.ok) opened++;
    else skipped.push({ date: b.date, reason: made.error });
  }
  return { opened, skipped };
}

/**
 * Make one of the host's weekly bookings a weekly game: a game on each of its
 * upcoming dates with these settings. Dates that cannot take one (held until
 * paid, already a game) are skipped and said.
 */
export async function startSeries(
  hostId: number,
  input: SeriesSettings & { bookingCode: string; title?: string }
): Promise<{ ok: true; series: Series; skipped: { date: string; reason: string }[] } | { ok: false; error: string; status?: number }> {
  const db = getDb();
  const booking = (await db.prepare("SELECT user_id, series_code FROM bookings WHERE UPPER(code) = UPPER(?)").get(input.bookingCode.trim())) as
    | { user_id: number | null; series_code: string | null }
    | undefined;
  if (!booking || booking.user_id !== hostId) return { ok: false, error: "That is not one of your bookings.", status: 404 };
  if (!booking.series_code) return { ok: false, error: "That booking does not repeat. Book the court weekly first, then make it a weekly game." };
  if (await db.prepare("SELECT 1 FROM game_series WHERE UPPER(booking_series_code) = UPPER(?)").get(booking.series_code))
    return { ok: false, error: "Those weekly bookings are already a weekly game." };
  const made = await db
    .prepare("INSERT INTO game_series (host_id, booking_series_code, title) VALUES (?, ?, ?)")
    .run(hostId, booking.series_code, input.title?.trim().slice(0, 80) || null);
  const seriesId = made.lastInsertRowid!;
  const { opened, skipped } = await openMissing(seriesId, hostId, booking.series_code, input);
  if (opened === 0) {
    await db.prepare("DELETE FROM game_series WHERE id = ?").run(seriesId);
    return { ok: false, error: skipped[0]?.reason ?? "None of those bookings is still to come." };
  }
  return { ok: true, series: (await seriesView(hostId, seriesId))!, skipped };
}

export async function seriesView(hostId: number, seriesId: number): Promise<Series | null> {
  const row = (await getDb().prepare("SELECT * FROM game_series WHERE id = ? AND host_id = ?").get(seriesId, hostId)) as
    | { id: number; host_id: number; booking_series_code: string; title: string | null; status: "active" | "ended" }
    | undefined;
  if (!row) return null;
  const ids = (await getDb().prepare("SELECT id FROM open_games WHERE series_id = ? ORDER BY id").all(seriesId)) as { id: number }[];
  const games = (await gamesByIds(ids.map((g) => g.id))).sort((a, b) => a.date.localeCompare(b.date));
  return { id: row.id, hostId: row.host_id, bookingSeriesCode: row.booking_series_code, title: row.title, status: row.status, games };
}

export async function mySeries(hostId: number): Promise<Series[]> {
  const rows = (await getDb().prepare("SELECT id FROM game_series WHERE host_id = ? AND status = 'active' ORDER BY id").all(hostId)) as { id: number }[];
  return (await Promise.all(rows.map((r) => seriesView(hostId, r.id)))).filter((s): s is Series => s !== null);
}

/**
 * The host ending the weekly game: no more dates get a game. With
 * `callOffUpcoming`, the games still to come are called off too (players
 * told, shares owed back); the court bookings stay the host's either way.
 */
export async function endSeries(hostId: number, seriesId: number, callOffUpcoming = false): Promise<{ ok: true; calledOff: number } | { ok: false; error: string; status: number }> {
  const done = await getDb().prepare("UPDATE game_series SET status = 'ended' WHERE id = ? AND host_id = ? AND status = 'active'").run(seriesId, hostId);
  if (done.changes === 0) return { ok: false, error: "Not found.", status: 404 };
  let calledOff = 0;
  if (callOffUpcoming) {
    const games = (await getDb().prepare("SELECT id FROM open_games WHERE series_id = ? AND status IN ('open', 'closed')").all(seriesId)) as { id: number }[];
    for (const g of games) if ((await cancelGame(hostId, g.id)).ok) calledOff++;
  }
  return { ok: true, calledOff };
}

/**
 * Invite the players of the series' previous game to this one: each through
 * the ordinary invitation, so each still says yes or no, and the usual limits
 * and blocks apply.
 */
export async function inviteRegulars(hostId: number, gameId: number): Promise<{ ok: true; invited: number } | { ok: false; error: string; status: number }> {
  const game = await gameById(gameId);
  if (!game || game.hostId !== hostId || game.seriesId === null) return { ok: false, error: "Not found.", status: 404 };
  const previous = (await getDb()
    .prepare(
      `SELECT g.id FROM open_games g JOIN bookings b ON b.id = g.booking_id
        WHERE g.series_id = ? AND b.date < ? ORDER BY b.date DESC LIMIT 1`
    )
    .get(game.seriesId, game.date)) as { id: number } | undefined;
  if (!previous) return { ok: true, invited: 0 };
  const players = (await getDb()
    .prepare("SELECT user_id FROM open_game_players WHERE game_id = ? AND status = 'accepted' AND no_show = 0 ORDER BY id")
    .all(previous.id)) as { user_id: number }[];
  let invited = 0;
  for (const p of players) {
    const sent = await invitePlayer(hostId, gameId, p.user_id);
    if (sent.ok) invited++;
    else if (sent.status === 429) break;
  }
  return { ok: true, invited };
}

/** For the scheduler, once an hour: dates added to a weekly game's bookings get their games. */
export async function extendSeriesIfDue(now = new Date()): Promise<number> {
  const hour = now.toISOString().slice(0, 13);
  const last = (await getDb().prepare("SELECT value FROM settings WHERE key = 'game_series_last_run'").get()) as { value: string } | undefined;
  if (last?.value === hour) return 0;
  await getDb()
    .prepare("INSERT INTO settings (key, value) VALUES ('game_series_last_run', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .run(hour);
  return extendSeries();
}

/** Dates added to a weekly game's bookings get their games. */
export async function extendSeries(): Promise<number> {
  const rows = (await getDb().prepare("SELECT id, host_id, booking_series_code FROM game_series WHERE status = 'active'").all()) as {
    id: number;
    host_id: number;
    booking_series_code: string;
  }[];
  let opened = 0;
  for (const s of rows) {
    const settings = await settingsOf(s.id);
    if (!settings) continue;
    opened += (await openMissing(s.id, s.host_id, s.booking_series_code, settings)).opened;
  }
  return opened;
}
