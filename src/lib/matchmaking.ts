import { getDb } from "./db";
import type { Written } from "./outbox";
import { distanceM } from "./geo";
import { hoursOf } from "./interval";
import { listRule } from "./listing";
import { isBlocked } from "./limits";
import { accessRefusal } from "./access";
import { venueZoneOf } from "./zones";
import { addDays, isPastSlot, todayISO } from "./time";
import { allows, playerGender, type Gender, type Who } from "./who";
import { blockedInGame } from "./player-safety";
import { dayPart, playerProfile, toProfile, type DayPart, type Intensity, type PlayerProfile, type ProfileRow } from "./player-profiles";
import { gameById, gamesByIds, LEVELS, NO_SHOW_DAYS, MAX_NO_SHOWS, playerLevels, recentNoShows, type Level, type OpenGame } from "./games";
import type { Sport } from "./types";

/**
 * Matchmaking: which open games suit a player, and which players might suit
 * a host's game — worked out by fixed rules anybody can read here, with the
 * reasons shown beside every suggestion. No learning, no hidden signals.
 *
 * It runs in two steps. **Hard constraints** decide whether a game can be
 * suggested at all: the player could actually join it (the game's rule on
 * who plays, adults only, missed games, the venue taking them, a block) and
 * it is within what they said they want (distance, the most they would pay,
 * a level no more than one step from theirs). Then **preferences** rank what
 * is left, by the points in WEIGHTS, and each point scored is a reason.
 *
 * Levels and ages are what players say about themselves; a reason never
 * says more than that ("matches the level you gave"). Nothing here ranks by
 * gender, age, race or religion: the only rules on who plays are the game's
 * own, set by its host, and the same ones joining enforces (lib/games.ts).
 *
 * For hosts, only players who have opted in (discoverable, and declared 18
 * or over) are ever suggested, with a first name, a level and a distance
 * band — never a point on the map, a phone number or anything about their
 * calendar. Inviting them goes through MySenam (lib/games.ts, invitePlayer).
 */

/** Points for each preference met. Changing one changes every ranking; the tests pin them. */
export const WEIGHTS = {
  /** A sport the player has given a level for. */
  sport: 20,
  levelExact: 25,
  levelAdjacent: 10,
  /** A game open to every level. */
  levelOpen: 12,
  /** At the player's point: the most; falling to none at the edge of how far they will go. */
  distanceMax: 20,
  /** No point given, but the venue is in the area they named. */
  area: 12,
  day: 10,
  time: 10,
  intensity: 10,
  withinBudget: 5,
  /** Only the waiting list is left. */
  waitlistOnly: -15,
} as const;

/** How many candidates are read from the database for one ranking, at most. */
const CANDIDATES = 300;
const DAYS_AHEAD = 14;

export type ReasonCode =
  | "SPORT_YOU_PLAY"
  | "LEVEL_EXACT"
  | "LEVEL_ADJACENT"
  | "LEVEL_OPEN"
  | "NEAR"
  | "IN_YOUR_AREA"
  | "DAY_SUITS"
  | "TIME_SUITS"
  | "INTENSITY_MATCH"
  | "WITHIN_BUDGET"
  | "FREE"
  | "WAITLIST_ONLY"
  | "HOST_APPROVES"
  | "LAST_PLACE";

export interface Reason {
  code: ReasonCode;
  points: number;
  vars?: Record<string, string | number>;
}

/** Why a game was left out. Blocks and venue refusals are one code, so neither can be told apart. */
export type ExclusionCode = "WHO" | "ADULTS_ONLY" | "TOO_FAR" | "OVER_BUDGET" | "LEVEL_GAP" | "UNAVAILABLE" | "FULL";

export interface GameMatch extends OpenGame {
  match: { score: number; reasons: Reason[] };
}

export interface GameRecommendations {
  games: GameMatch[];
  /** Games looked at and left out, by why. */
  excluded: Partial<Record<ExclusionCode, number>>;
  considered: number;
  /** Set when nothing can be suggested at all, and why. */
  stopped?: "NO_SHOWS";
  /** What the ranking used, for the page to say. */
  basis: { levels: Partial<Record<Sport, Level>>; hasPoint: boolean; area: string | null };
}

const levelStep = (a: Level, b: Level) => Math.abs(LEVELS.indexOf(a) - LEVELS.indexOf(b));

/** A distance band, never the distance itself to the metre: "within 2 km". */
export function distanceBand(km: number): number {
  return km <= 2 ? 2 : km <= 5 ? 5 : km <= 10 ? 10 : km <= 25 ? 25 : 50;
}

const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** Day, time and intensity: preferences shared by both directions. */
function whenAndHow(
  reasons: Reason[],
  profile: Pick<PlayerProfile, "days" | "times" | "intensity">,
  game: { date: string; startHour: number; intensity: Intensity }
): void {
  const day = weekday(game.date);
  if (profile.days.includes(day)) reasons.push({ code: "DAY_SUITS", points: WEIGHTS.day, vars: { day } });
  const part: DayPart = dayPart(game.startHour);
  if (profile.times.includes(part)) reasons.push({ code: "TIME_SUITS", points: WEIGHTS.time, vars: { part } });
  if (profile.intensity !== "any" && profile.intensity === game.intensity)
    reasons.push({ code: "INTENSITY_MATCH", points: WEIGHTS.intensity, vars: { intensity: game.intensity } });
}

/** Level points for a player's level against a game's, or null where the gap rules it out. */
function levelReason(mine: Level | undefined, wanted: Level | null): Reason | null | undefined {
  if (wanted === null) return { code: "LEVEL_OPEN", points: WEIGHTS.levelOpen };
  if (!mine) return undefined;
  const step = levelStep(mine, wanted);
  if (step === 0) return { code: "LEVEL_EXACT", points: WEIGHTS.levelExact, vars: { level: wanted } };
  if (step === 1) return { code: "LEVEL_ADJACENT", points: WEIGHTS.levelAdjacent, vars: { level: wanted } };
  return null;
}

/**
 * Open games that suit this player, best first. `venueIds` narrows to a
 * storefront's venues, as the games page does.
 */
export async function recommendGames(
  userId: number,
  opts: { sport?: Sport; limit?: number; offset?: number; venueIds?: number[] } = {}
): Promise<GameRecommendations> {
  const [profile, levels, gender, noShows] = await Promise.all([playerProfile(userId), playerLevels(userId), playerGender(userId), recentNoShows(userId)]);
  const basis = { levels, hasPoint: profile.near !== null, area: profile.area };
  if (noShows >= MAX_NO_SHOWS) return { games: [], excluded: {}, considered: 0, stopped: "NO_SHOWS", basis };

  const today = todayISO();
  const clauses = [
    "g.status = 'open'",
    "g.visibility = 'public'",
    "b.status = 'confirmed'",
    listRule(opts.venueIds),
    "b.date BETWEEN ? AND ?",
    "g.host_id <> ?",
    // Nothing already between them and this game, but having left it or let something lapse.
    "NOT EXISTS (SELECT 1 FROM open_game_players p WHERE p.game_id = g.id AND p.user_id = ? AND p.status NOT IN ('left', 'expired'))",
  ];
  const params: (string | number)[] = [today, addDays(today, DAYS_AHEAD), userId, userId];
  const sports = opts.sport ? [opts.sport] : (Object.keys(levels) as Sport[]);
  if (sports.length > 0) {
    clauses.push(`b.sport IN (${sports.map(() => "?").join(",")})`);
    params.push(...sports);
  }
  if (opts.venueIds) {
    if (opts.venueIds.length === 0) return { games: [], excluded: {}, considered: 0, basis };
    clauses.push(`v.id IN (${opts.venueIds.map(() => "?").join(",")})`);
    params.push(...opts.venueIds);
  }
  if (profile.near) {
    const dLat = profile.maxKm / 111;
    const dLng = profile.maxKm / (111 * Math.max(Math.cos((profile.near.lat * Math.PI) / 180), 0.01));
    clauses.push("v.lat BETWEEN ? AND ? AND v.lng BETWEEN ? AND ?");
    params.push(profile.near.lat - dLat, profile.near.lat + dLat, profile.near.lng - dLng, profile.near.lng + dLng);
  }
  const rows = (await getDb()
    .prepare(
      `SELECT g.id, v.lat, v.lng, v.area, v.time_zone, b.date, b.start_min FROM open_games g
         JOIN bookings b ON b.id = g.booking_id JOIN courts c ON c.id = b.court_id JOIN venues v ON v.id = c.venue_id
        WHERE ${clauses.join(" AND ")} ORDER BY b.date, b.start_min, g.id LIMIT ${CANDIDATES}`
    )
    .all(...params)) as { id: number; lat: number | null; lng: number | null; area: string; time_zone: string | null; date: string; start_min: number }[];

  const excluded: Partial<Record<ExclusionCode, number>> = {};
  const leaveOut = (code: ExclusionCode) => (excluded[code] = (excluded[code] ?? 0) + 1);
  const venueOk = new Map<number, boolean>();
  const user = (await getDb().prepare("SELECT phone FROM users WHERE id = ?").get(userId)) as { phone: string };
  const matches: (GameMatch & { km: number | null })[] = [];
  const upcoming = rows.filter((r) => !isPastSlot(r.date, hoursOf(r.start_min), venueZoneOf(r)));
  const games = new Map((await gamesByIds(upcoming.map((r) => r.id))).map((g) => [g.id, g]));
  for (const r of upcoming) {
    const game = games.get(r.id);
    if (!game) continue;
    const reasons: Reason[] = [];
    // Hard constraints: could they join, and is it within what they asked for.
    if (!allows(game.who as Who, gender as Gender | null)) {
      leaveOut("WHO");
      continue;
    }
    if (game.adultsOnly && profile.adult !== true) {
      leaveOut("ADULTS_ONLY");
      continue;
    }
    const full = game.joined + game.held >= game.spots;
    if (full && !game.waitlist) {
      leaveOut("FULL");
      continue;
    }
    let km: number | null = null;
    if (profile.near && r.lat !== null && r.lng !== null) {
      km = Math.round(distanceM(profile.near, { lat: Number(r.lat), lng: Number(r.lng) }) / 100) / 10;
      if (km > profile.maxKm) {
        leaveOut("TOO_FAR");
        continue;
      }
    }
    if (profile.maxShare !== null && game.share > profile.maxShare) {
      leaveOut("OVER_BUDGET");
      continue;
    }
    const level = levelReason(levels[game.sport], game.level);
    if (level === null) {
      leaveOut("LEVEL_GAP");
      continue;
    }
    if (!venueOk.has(game.venueId))
      venueOk.set(game.venueId, !(await isBlocked(game.venueId, user.phone)) && !(await accessRefusal(game.venueId, userId)));
    if (!venueOk.get(game.venueId) || (await blockedInGame(userId, game.id))) {
      leaveOut("UNAVAILABLE");
      continue;
    }

    // Preferences: each one met is points, and a reason.
    if (levels[game.sport]) reasons.push({ code: "SPORT_YOU_PLAY", points: WEIGHTS.sport, vars: { sport: game.sport } });
    if (level) reasons.push(level);
    if (km !== null) reasons.push({ code: "NEAR", points: Math.round(WEIGHTS.distanceMax * (1 - km / profile.maxKm)), vars: { km: distanceBand(km) } });
    else if (profile.area && profile.area.toLowerCase() === game.area.toLowerCase())
      reasons.push({ code: "IN_YOUR_AREA", points: WEIGHTS.area, vars: { area: game.area } });
    whenAndHow(reasons, profile, game);
    if (game.share === 0) reasons.push({ code: "FREE", points: WEIGHTS.withinBudget });
    else if (profile.maxShare !== null) reasons.push({ code: "WITHIN_BUDGET", points: WEIGHTS.withinBudget, vars: { share: game.share } });
    if (full) reasons.push({ code: "WAITLIST_ONLY", points: WEIGHTS.waitlistOnly });
    else if (game.spots - game.joined - game.held === 1) reasons.push({ code: "LAST_PLACE", points: 0 });
    if (!game.autoAccept) reasons.push({ code: "HOST_APPROVES", points: 0 });

    game.distanceKm = km ?? undefined;
    game.yours = false;
    game.mine = null;
    matches.push({ ...game, km, match: { score: reasons.reduce((sum, x) => sum + x.points, 0), reasons } });
  }
  // Best first; then soonest, nearest, and the older game, so the order never wobbles.
  matches.sort(
    (a, b) =>
      b.match.score - a.match.score ||
      a.date.localeCompare(b.date) ||
      a.startHour - b.startHour ||
      (a.km ?? Infinity) - (b.km ?? Infinity) ||
      a.id - b.id
  );
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  return {
    games: matches.slice(offset, offset + limit).map(({ km: _km, ...g }) => g),
    excluded,
    considered: rows.length,
    basis,
  };
}

export interface PlayerSuggestion {
  userId: number;
  /** First name only. */
  name: string;
  level: Level;
  /** "within N km" of the venue, from the point they gave; null if they gave none. */
  withinKm: number | null;
  score: number;
  reasons: Reason[];
}

/**
 * Players who might suit a host's game: only those who opted in to being
 * found and say they are 18 or over, who play the sport, for whom the game is
 * within their distance and price, at a level one step or less from the
 * game's, who could join it (the game's rule on who plays, missed games), and
 * between whom and the host or anybody in the game there is no block.
 */
export async function recommendPlayers(
  hostId: number,
  gameId: number,
  opts: { limit?: number; offset?: number } = {}
): Promise<{ ok: true; players: PlayerSuggestion[] } | { ok: false; error: string; status: number }> {
  const game = await gameById(gameId);
  if (!game || game.hostId !== hostId) return { ok: false, error: "Not found.", status: 404 };
  if (game.status !== "open" || isPastSlot(game.date, game.startHour, game.timeZone)) return { ok: false, error: "That game is not taking players.", status: 409 };
  const venue = (await getDb().prepare("SELECT lat, lng, area FROM venues WHERE id = ?").get(game.venueId)) as { lat: number | null; lng: number | null; area: string };
  const rows = (await getDb()
    .prepare(
      `SELECT pp.*, u.name, u.gender, pl.level FROM player_profiles pp
         JOIN users u ON u.id = pp.user_id
         JOIN player_levels pl ON pl.user_id = pp.user_id AND pl.sport = ?
        WHERE pp.discoverable = 1 AND pp.adult = 1 AND pp.user_id <> ?
          AND NOT EXISTS (SELECT 1 FROM open_game_players p WHERE p.game_id = ? AND p.user_id = pp.user_id AND p.status NOT IN ('left', 'expired'))
          AND (SELECT COUNT(*) FROM open_game_players p JOIN open_games og ON og.id = p.game_id JOIN bookings ob ON ob.id = og.booking_id
                WHERE p.user_id = pp.user_id AND p.no_show = 1 AND ob.date >= ?) < ?
          AND NOT EXISTS (SELECT 1 FROM player_blocks k
                           WHERE (k.blocker_id = pp.user_id AND (k.blocked_id = ? OR k.blocked_id IN (SELECT user_id FROM open_game_players WHERE game_id = ? AND status IN ('accepted', 'offered'))))
                              OR (k.blocked_id = pp.user_id AND (k.blocker_id = ? OR k.blocker_id IN (SELECT user_id FROM open_game_players WHERE game_id = ? AND status IN ('accepted', 'offered')))))
        ORDER BY pp.user_id LIMIT 500`
    )
    .all(game.sport, hostId, gameId, addDays(todayISO(), -NO_SHOW_DAYS), MAX_NO_SHOWS, hostId, gameId, hostId, gameId)) as (Record<string, unknown> & {
    user_id: number; name: string; gender: Gender | null; level: Level;
  })[];

  const suggestions: PlayerSuggestion[] = [];
  for (const r of rows) {
    const profile = toProfile(r as unknown as ProfileRow);
    if (!allows(game.who, r.gender)) continue;
    if (profile.maxShare !== null && game.share > profile.maxShare) continue;
    const level = levelReason(r.level, game.level);
    if (level === null) continue;
    const reasons: Reason[] = [{ code: "SPORT_YOU_PLAY", points: WEIGHTS.sport, vars: { sport: game.sport } }];
    if (level) reasons.push(level);
    let withinKm: number | null = null;
    if (profile.near && venue.lat !== null && venue.lng !== null) {
      const km = distanceM(profile.near, { lat: Number(venue.lat), lng: Number(venue.lng) }) / 1000;
      if (km > profile.maxKm) continue;
      withinKm = distanceBand(km);
      reasons.push({ code: "NEAR", points: Math.round(WEIGHTS.distanceMax * (1 - km / profile.maxKm)), vars: { km: withinKm } });
    } else if (profile.area && profile.area.toLowerCase() === venue.area.toLowerCase())
      reasons.push({ code: "IN_YOUR_AREA", points: WEIGHTS.area, vars: { area: venue.area } });
    whenAndHow(reasons, profile, game);
    suggestions.push({
      userId: r.user_id,
      name: r.name.trim().split(/\s+/)[0],
      level: r.level,
      withinKm,
      score: reasons.reduce((sum, x) => sum + x.points, 0),
      reasons,
    });
  }
  suggestions.sort((a, b) => b.score - a.score || a.userId - b.userId);
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  return { ok: true, players: suggestions.slice(offset, offset + limit) };
}

// ------------------------------------------------------------ telling players of suggested games

/** Players looked at in one go; the rest wait for the next run. */
const NOTICE_BATCH = 25;

/**
 * Email players who asked for them the games suggested for them, each game
 * once ever (match_notices): `digest` players at most once a day, up to five
 * games; `each` players at most once an hour, up to three. Players are taken
 * in the order they were last looked at, so everybody gets a turn; a player
 * with nothing new is simply looked at again later. Safe to run on two
 * servers at once: the notices are keyed, and a game noted twice is noted once.
 */
export async function sendMatchNotices(): Promise<{ checked: number; emailed: number }> {
  const db = getDb();
  const due = (await db
    .prepare(
      `SELECT user_id, notify_matches FROM player_profiles
        WHERE notify_matches <> 'none'
          AND (matches_checked_at IS NULL
               OR (notify_matches = 'digest' AND matches_checked_at < datetime('now', '-20 hours'))
               OR (notify_matches = 'each' AND matches_checked_at < datetime('now', '-1 hours')))
        ORDER BY matches_checked_at NULLS FIRST, user_id LIMIT ${NOTICE_BATCH}`
    )
    .all()) as { user_id: number; notify_matches: "digest" | "each" }[];
  let emailed = 0;
  for (const p of due) {
    await db.prepare("UPDATE player_profiles SET matches_checked_at = datetime('now') WHERE user_id = ?").run(p.user_id);
    const told = new Set(
      ((await db.prepare("SELECT game_id FROM match_notices WHERE user_id = ?").all(p.user_id)) as { game_id: number }[]).map((r) => r.game_id)
    );
    const fresh = (await recommendGames(p.user_id, { limit: 20 })).games.filter((g) => !told.has(g.id)).slice(0, p.notify_matches === "digest" ? 5 : 3);
    if (fresh.length === 0) continue;
    for (const g of fresh) await db.prepare("INSERT INTO match_notices (user_id, game_id) VALUES (?, ?) ON CONFLICT DO NOTHING").run(p.user_id, g.id);
    const { baseUrl, emailPlayer } = await import("./outbox");
    const { formatHour } = await import("./time");
    const lines = (tr: Parameters<Written>[0]) =>
      fresh
        .map((g) => `- ${g.date} ${formatHour(g.startHour)}, ${g.venueName} (${g.courtName})${g.share > 0 ? `, ${tr("mail.match.share", { share: g.share.toFixed(2) })}` : ""}`)
        .join("\n");
    await emailPlayer({
      venueId: fresh[0].venueId,
      userId: p.user_id,
      subject: (tr) => tr.plural("mail.match.s", fresh.length),
      body: (tr) => tr("mail.match.b", { lines: lines(tr) }),
      link: `${baseUrl()}/games`,
      dedupeKey: `match-notice:${p.user_id}:${fresh.map((g) => g.id).join(",")}`,
    });
    emailed++;
  }
  return { checked: due.length, emailed };
}
