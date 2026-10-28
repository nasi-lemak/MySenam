import { isActivity } from "./activities";
import { getDb, isBusy, withTransaction } from "./db";
import { receiptFee } from "./documents";
import { boxSizes, intoBoxes, ladder, seasonMoves, type Move } from "./boxes";
import { flipScore, scoreRefusal, standings, type Standing } from "./brackets";
import { templateByKey, templateFor } from "./competition-templates";
import { parseRules, readRules, type CompetitionRules } from "./tournament-rules";
import { LEVELS, type Level } from "./games";
import { isPartnerGender, isWho, type Who } from "./who";
import { categoryOfWho, declaredGender, entrantCategoryRefusal, entrantParticipantId, entrantUserId, entrantVenueRefusal, recordEntered, selfEntrant, type Entrant } from "./competition-entrants";
import { refuse } from "./entitlements";
import { ACTS_FOR } from "./participants";
import { listRule, OPEN_TO_CUSTOMERS } from "./listing";
import { baseUrl, emailPlayer, sentences, type Written } from "./outbox";
import { tellVenueStaff } from "./owner-alerts";
import { toWhatsAppNumber } from "./transports";
import { addDays, isValidDateString, todayISO } from "./time";
import { type CounterMethod, type Sport } from "./types";
import { money } from "./region";

/**
 * Box leagues run by venues.
 *
 * A league runs season after season, a month or so each. Every season its
 * players are put into boxes of four to six at about the same standard, and
 * everybody plays everybody else in their box before the season ends —
 * arranging it between themselves, and booking the court like anybody else.
 * Box-mates see each other's phone number for that, and only box-mates.
 *
 * Either player reports a result; the other confirms it, or says it is wrong
 * and the venue's staff decide. A result nobody objects to in three days
 * stands. When the season is over, the best of each box go up one and the
 * worst go down one, newcomers come in at the bottom (or where staff put
 * them), and the next season's boxes are made from that.
 *
 * Seasons start and end by themselves on their dates; staff can do either
 * sooner. The fee is per season, paid online to the venue or at its counter.
 *
 * Scores are checked, and boxes ranked, by the same competition rules as a
 * tournament (lib/tournament-rules.ts): sets best of three or five, a tally,
 * table points (or points by set score), the ranking order — from the
 * sport's template unless the league chose another (ADR 0013). A league
 * match always has a winner: a level tally is refused.
 */

/** A reported result stands if the other side says nothing for this long. */
export const CONFIRM_DAYS = 3;
/** Results can still come in for this long after a season's last day. */
export const LATE_DAYS = 3;

export type LeagueStatus = "running" | "closed";
export type SeasonStatus = "forming" | "running" | "finished";
export type MatchStatus = "unplayed" | "reported" | "confirmed" | "disputed" | "walkover" | "void";

export interface Season {
  id: number;
  number: number;
  startsOn: string;
  endsOn: string;
  status: SeasonStatus;
}

export interface League {
  id: number;
  venueId: number;
  venueName: string;
  area: string;
  name: string;
  sport: Sport;
  teamSize: 1 | 2;
  /** Anyone, women only or men only (lib/who.ts); a pair's partner is the same. */
  who: Who;
  level: Level | null;
  boxSize: number;
  moves: number;
  seasonDays: number;
  fee: number;
  description: string | null;
  status: LeagueStatus;
  /** Signed up and not left. */
  players: number;
  /** The season forming or being played, if any. */
  current: Season | null;
  payOnline: boolean;
  /** How its matches are scored and its boxes ranked; the template they came from. */
  rules: CompetitionRules;
  template: string | null;
}

export interface LeaguePlayer {
  id: number;
  name: string;
  status: "active" | "left";
  /** Only for staff. */
  userId?: number | null;
  startBox?: number | null;
  level?: Level | null;
  /** Only for staff: the participant who plays, where a guardian or the counter entered one (ADR 0023). */
  participantId?: number | null;
  /** Only for staff: added at the counter, by whom, and the number given (a contact, not proof of who they are). */
  atCounter?: { by: string; phone: string | null } | null;
}

export interface Place {
  id: number;
  playerId: number;
  boxNo: number;
  finish: number | null;
  move: Move | null;
  paid: boolean;
  withdrawn: boolean;
}

export interface LeagueMatch {
  id: number;
  boxNo: number;
  a: number;
  b: number;
  score: string | null;
  winner: number | null;
  status: MatchStatus;
  reportedBy: number | null;
  reportedAt: string | null;
  /** Goes up whenever the result changes: a player confirming or disputing, or staff deciding, names the one they saw. */
  version: number;
  /** Only for staff. */
  disputeNote?: string | null;
}

export interface Box {
  boxNo: number;
  /** Best first; those who withdrew last. */
  table: Standing[];
}

export interface LeagueDetail extends League {
  seasons: Season[];
  /** The season shown: asked for, or the one being played, or the last one played. */
  viewing: Season | null;
  boxes: Box[];
  places: Place[];
  matches: LeagueMatch[];
  /** Everybody named on the page: the season's players and whoever has signed up. */
  people: LeaguePlayer[];
}

export interface MyLeague {
  playerId: number;
  name: string;
  /** In the season being played. */
  place: Place | null;
  /** Box-mates, to arrange matches with. */
  contacts: { playerId: number; name: string; phone: string; whatsapp: string }[];
  /** A place held for somebody the account acts for: the participant. */
  participantId?: number;
}

const L_SELECT = `
  SELECT l.*, v.name AS venue_name, v.area,
         (SELECT COUNT(*)::int FROM league_players p WHERE p.league_id = l.id AND p.status = 'active') AS player_count,
         EXISTS (SELECT 1 FROM venue_payment_accounts a WHERE a.venue_id = v.id AND a.enabled = 1) AS pay_online
    FROM leagues l JOIN venues v ON v.id = l.venue_id`;

interface LRow {
  id: number;
  venue_id: number;
  venue_name: string;
  area: string;
  name: string;
  sport: Sport;
  team_size: number;
  who: Who;
  level: Level | null;
  box_size: number;
  moves: number;
  season_days: number;
  fee: number | string;
  description: string | null;
  status: LeagueStatus;
  player_count: number;
  pay_online: boolean;
  rules: string | null;
  template: string | null;
}

interface SRow {
  id: number;
  league_id: number;
  number: number;
  starts_on: string;
  ends_on: string;
  status: SeasonStatus;
}

const toSeason = (s: SRow): Season => ({ id: s.id, number: s.number, startsOn: s.starts_on, endsOn: s.ends_on, status: s.status });

async function currentSeason(leagueId: number): Promise<Season | null> {
  const row = (await getDb()
    .prepare("SELECT * FROM league_seasons WHERE league_id = ? AND status <> 'finished'")
    .get(leagueId)) as SRow | undefined;
  return row ? toSeason(row) : null;
}

async function toLeague(r: LRow): Promise<League> {
  return {
    id: r.id,
    venueId: r.venue_id,
    venueName: r.venue_name,
    area: r.area,
    name: r.name,
    sport: r.sport,
    teamSize: r.team_size === 2 ? 2 : 1,
    who: r.who ?? "anyone",
    level: r.level,
    boxSize: r.box_size,
    moves: r.moves,
    seasonDays: r.season_days,
    fee: Number(r.fee),
    description: r.description,
    status: r.status,
    players: r.player_count,
    current: await currentSeason(r.id),
    payOnline: Boolean(r.pay_online),
    rules: readRules(r.rules),
    template: r.template,
  };
}

export async function leagueById(id: number): Promise<League | null> {
  const row = (await getDb().prepare(`${L_SELECT} WHERE l.id = ?`).get(id)) as LRow | undefined;
  return row ? await toLeague(row) : null;
}

/** A venue's own leagues, for its staff. */
export async function listLeagues(venueIds: number[]): Promise<League[]> {
  if (venueIds.length === 0) return [];
  const rows = (await getDb()
    .prepare(`${L_SELECT} WHERE l.venue_id IN (${venueIds.map(() => "?").join(",")}) ORDER BY l.status, l.id DESC`)
    .all(...venueIds)) as LRow[];
  return Promise.all(rows.map(toLeague));
}

/** Leagues the public can see and join: still running, at venues customers can reach. */
export async function publicLeagues(filter: { sport?: Sport; venueIds?: number[] } = {}): Promise<League[]> {
  const clauses = [listRule(filter.venueIds), "l.status = 'running'"];
  const params: (string | number)[] = [];
  if (filter.sport) {
    clauses.push("l.sport = ?");
    params.push(filter.sport);
  }
  if (filter.venueIds) {
    if (filter.venueIds.length === 0) return [];
    clauses.push(`l.venue_id IN (${filter.venueIds.map(() => "?").join(",")})`);
    params.push(...filter.venueIds);
  }
  const rows = (await getDb()
    .prepare(`${L_SELECT} WHERE ${clauses.join(" AND ")} ORDER BY l.name, l.id LIMIT 100`)
    .all(...params)) as LRow[];
  return Promise.all(rows.map(toLeague));
}

export async function leagueDetail(id: number, opts: { season?: number; forStaff?: boolean } = {}): Promise<LeagueDetail | null> {
  const league = await leagueById(id);
  if (!league) return null;
  const db = getDb();
  const seasons = ((await db.prepare("SELECT * FROM league_seasons WHERE league_id = ? ORDER BY number DESC").all(id)) as SRow[]).map(toSeason);
  const viewing =
    (opts.season !== undefined ? seasons.find((s) => s.number === opts.season) : undefined) ??
    seasons.find((s) => s.status === "running") ??
    seasons.find((s) => s.status === "finished") ??
    null;

  let places: Place[] = [];
  let matches: LeagueMatch[] = [];
  if (viewing && viewing.status !== "forming") {
    places = (
      (await db
        .prepare("SELECT * FROM league_places WHERE season_id = ? ORDER BY box_no, finish NULLS LAST, id")
        .all(viewing.id)) as {
        id: number;
        player_id: number;
        box_no: number;
        finish: number | null;
        move: Move | null;
        paid_at: string | null;
        withdrawn_at: string | null;
      }[]
    ).map((p) => ({
      id: p.id,
      playerId: p.player_id,
      boxNo: p.box_no,
      finish: p.finish,
      move: p.move,
      paid: p.paid_at !== null,
      withdrawn: p.withdrawn_at !== null,
    }));
    matches = (await matchesOf(viewing.id)).map((m) => (opts.forStaff ? m : { ...m, disputeNote: undefined }));
  }
  const boxes = [...new Set(places.map((p) => p.boxNo))].sort((a, b) => a - b).map((boxNo) => ({
    boxNo,
    table: boxTable(
      places.filter((p) => p.boxNo === boxNo),
      matches.filter((m) => m.boxNo === boxNo),
      league.rules.scoring
    ),
  }));

  const placed = new Set(places.map((p) => p.playerId));
  const people = (
    (await db
      .prepare(
        `SELECT p.id, p.name, p.status, p.user_id, p.start_box, pl.level, p.participant_id, p.contact_phone, p.entered_by_name
           FROM league_players p
           LEFT JOIN player_levels pl ON pl.user_id = p.user_id AND p.participant_id IS NULL AND pl.sport = ?
          WHERE p.league_id = ? ORDER BY p.joined_at, p.id`
      )
      .all(league.sport, id)) as {
      id: number;
      name: string;
      status: "active" | "left";
      user_id: number | null;
      start_box: number | null;
      level: Level | null;
      participant_id: number | null;
      contact_phone: string | null;
      entered_by_name: string | null;
    }[]
  )
    .filter((p) => p.status === "active" || placed.has(p.id))
    .map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      level: p.level,
      ...(opts.forStaff
        ? {
            userId: p.user_id,
            startBox: p.start_box,
            participantId: p.participant_id,
            atCounter: p.entered_by_name ? { by: p.entered_by_name, phone: p.contact_phone } : null,
          }
        : {}),
    }));
  return { ...league, seasons, viewing, boxes, places, matches, people };
}

async function matchesOf(seasonId: number): Promise<LeagueMatch[]> {
  return (
    (await getDb()
      .prepare("SELECT * FROM league_matches WHERE season_id = ? ORDER BY box_no, id")
      .all(seasonId)) as {
      id: number;
      box_no: number;
      player_a: number;
      player_b: number;
      score: string | null;
      winner: number | null;
      status: MatchStatus;
      reported_by: number | null;
      reported_at: string | null;
      dispute_note: string | null;
      version: number;
    }[]
  ).map((m) => ({
    id: m.id,
    boxNo: m.box_no,
    a: m.player_a,
    b: m.player_b,
    score: m.score,
    winner: m.winner,
    status: m.status,
    reportedBy: m.reported_by,
    reportedAt: m.reported_at,
    version: Number(m.version ?? 0),
    disputeNote: m.dispute_note,
  }));
}

/** Only results that are settled count: confirmed, or a walkover. */
const counts = (m: LeagueMatch) => m.status === "confirmed" || m.status === "walkover";

/** A box's table: by the league's rules, as a tournament group's, and anybody who withdrew at the foot. */
function boxTable(places: Place[], matches: LeagueMatch[], scoring: CompetitionRules["scoring"]): Standing[] {
  const table = standings(
    places.map((p) => p.playerId),
    matches.map((m) => ({ a: m.a, b: m.b, winner: counts(m) ? m.winner : null, score: m.status === "confirmed" ? m.score : null, walkover: m.status === "walkover" })),
    scoring
  );
  const gone = new Set(places.filter((p) => p.withdrawn).map((p) => p.playerId));
  return [...table.filter((s) => !gone.has(s.entryId)), ...table.filter((s) => gone.has(s.entryId))];
}

// ------------------------------------------------------------ setting one up

export type Result<T = League> = { ok: true; value: T } | { ok: false; error: string; code?: string; vars?: Record<string, string | number> };

export interface LeagueInput {
  venueId: number;
  name: string;
  sport: Sport;
  teamSize: 1 | 2;
  who?: Who;
  level: Level | null;
  boxSize?: number;
  moves?: number;
  seasonDays?: number;
  fee: number;
  /** When the first season starts. */
  startsOn: string;
  description?: string;
  /** The competition template to score and rank by (lib/competition-templates.ts); the sport's own unless given. */
  template?: string | null;
  /** Its rules, laid over the template's (lib/tournament-rules.ts). */
  rules?: unknown;
}

export async function createLeague(input: LeagueInput, adminId: number): Promise<Result> {
  const db = getDb();
  const name = input.name.trim();
  if (name.length < 3 || name.length > 100) return { ok: false, error: "Give it a name." };
  if (!(await isActivity(input.sport))) return { ok: false, error: "Unknown sport." };
  if (input.level !== null && !LEVELS.includes(input.level)) return { ok: false, error: "Unknown level." };
  const who = input.who ?? "anyone";
  if (!isWho(who)) return { ok: false, error: "Anyone, women only or men only." };
  const boxSize = input.boxSize ?? 4;
  if (!Number.isInteger(boxSize) || boxSize < 3 || boxSize > 6) return { ok: false, error: "A box holds 3 to 6." };
  const moves = input.moves ?? 1;
  if (moves !== 1 && moves !== 2) return { ok: false, error: "One or two go up and down." };
  const seasonDays = input.seasonDays ?? 28;
  if (!Number.isInteger(seasonDays) || seasonDays < 14 || seasonDays > 62) return { ok: false, error: "A season is 2 to 8 weeks." };
  if (!Number.isFinite(input.fee) || input.fee < 0 || input.fee > 10000) return { ok: false, error: "Check the fee." };
  if (!isValidDateString(input.startsOn) || input.startsOn <= todayISO())
    return { ok: false, error: "The first season has to start after today, so players can join." };
  if (!(await db.prepare("SELECT 1 FROM court_activities ca JOIN courts c ON c.id = ca.court_id WHERE c.venue_id = ? AND ca.sport = ?").get(input.venueId, input.sport)))
    return { ok: false, error: "This venue has no courts for that sport." };
  // Scored and ranked as a head-to-head competition: the sport's template unless another is chosen.
  const own = templateFor(input.sport);
  const template = input.template ? templateByKey(input.template) : own.rules.performance ? templateByKey("custom") : own;
  if (!template) return { ok: false, error: "Unknown template." };
  if (template.rules.performance) return { ok: false, error: "A league's matches are head to head: choose a template scored in sets or a tally." };
  const parsed = parseRules(input.rules ?? null, template.rules);
  if (!parsed.ok) return parsed;
  if (parsed.rules.performance) return { ok: false, error: "A league's matches are head to head." };

  let id = 0;
  await db.transaction(async () => {
    const info = await db
      .prepare(
        `INSERT INTO leagues (venue_id, name, sport, team_size, who, level, box_size, moves, season_days, fee, description, created_by, rules, template)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.venueId,
        name,
        input.sport,
        input.teamSize === 2 ? 2 : 1,
        who,
        input.level,
        boxSize,
        moves,
        seasonDays,
        Math.round(input.fee * 100) / 100,
        input.description?.trim().slice(0, 2000) || null,
        adminId,
        JSON.stringify(parsed.rules),
        template.key
      );
    id = info.lastInsertRowid as number;
    await db
      .prepare("INSERT INTO league_seasons (league_id, number, starts_on, ends_on) VALUES (?, 1, ?, ?)")
      .run(id, input.startsOn, addDays(input.startsOn, seasonDays - 1));
  })();
  return { ok: true, value: (await leagueById(id))! };
}

/** Change when the coming season starts, before it does. */
export async function planSeason(leagueId: number, startsOn: string): Promise<Result> {
  const league = await leagueById(leagueId);
  if (!league?.current || league.current.status !== "forming") return { ok: false, error: "No season is waiting to start." };
  if (!isValidDateString(startsOn) || startsOn < todayISO()) return { ok: false, error: "Pick a day from today on." };
  await getDb()
    .prepare("UPDATE league_seasons SET starts_on = ?, ends_on = ? WHERE id = ?")
    .run(startsOn, addDays(startsOn, league.seasonDays - 1), league.current.id);
  return { ok: true, value: (await leagueById(leagueId))! };
}

/** No more seasons. Only between seasons: a season being played is ended first. */
export async function closeLeague(leagueId: number): Promise<Result> {
  const db = getDb();
  const league = await leagueById(leagueId);
  if (!league || league.status === "closed") return { ok: false, error: "That league is not running." };
  if (league.current?.status === "running") return { ok: false, error: "End the season being played first." };
  await db.transaction(async () => {
    await db.prepare("DELETE FROM league_seasons WHERE league_id = ? AND status = 'forming'").run(leagueId);
    await db.prepare("UPDATE leagues SET status = 'closed' WHERE id = ?").run(leagueId);
  })();
  for (const p of await activePlayers(leagueId))
    if (p.user_id)
      await tellPlayer(p.user_id, league, (tr) => tr("mail.league.stopped.s", { l: league.name }), (tr) => tr("mail.league.stopped.b", { l: league.name, venue: league.venueName }));
  return { ok: true, value: (await leagueById(leagueId))! };
}

// ------------------------------------------------------------ players

/** What joining says besides who joins: a doubles partner and their declared gender, and an entrant's own where they have no account. */
export interface JoinInput {
  partnerName?: string;
  partnerGender?: string;
  /** An entrant with no account of their own (a participant, or at the counter): their gender as declared, in a women's or men's league. */
  gender?: string;
}

/** Join a league as the account holder, for themself (`joinAs`). */
export async function join(user: { id: number; name: string }, leagueId: number, input: JoinInput = {}): Promise<Result<LeaguePlayer>> {
  return joinAs(selfEntrant(user), leagueId, input);
}

/**
 * Join a league: the account holder for themself, a guardian for a
 * participant they manage, or staff at the counter
 * (lib/competition-entrants.ts), one set of checks for each: the venue's
 * rule on who it is for (a participant's own membership at a members-only
 * venue, ADR 0025), and in a women's or men's league the player and, in
 * pairs, the partner, as declared (lib/who.ts), as a tournament asks it.
 */
export async function joinAs(entrant: Entrant, leagueId: number, input: JoinInput = {}): Promise<Result<LeaguePlayer>> {
  // Checked and written in one transaction under the league's row lock, as tournament entries are: the same player
  // joining twice at once is in once, the second told so, rather than failing on the database's own check.
  try {
    return await withTransaction(async () => {
      await getDb().prepare("SELECT id FROM leagues WHERE id = ? FOR UPDATE").get(leagueId);
      return await joinLocked(entrant, leagueId, input);
    });
  } catch (err) {
    if (isBusy(err)) return { ok: false, error: "So many people are joining at once that this could not be finished. Nothing was changed: please try again.", code: "BUSY" };
    throw err;
  }
}

/** `joinAs`, inside its transaction, under the league's lock. */
async function joinLocked(entrant: Entrant, leagueId: number, input: JoinInput): Promise<Result<LeaguePlayer>> {
  const db = getDb();
  const league = await leagueById(leagueId);
  if (!league || league.status !== "running") return { ok: false, error: "That league is not taking players." };
  const open = (await db.prepare(`SELECT (${OPEN_TO_CUSTOMERS}) AS open FROM venues v WHERE v.id = ?`).get(league.venueId)) as { open: boolean };
  if (!open.open) return { ok: false, error: "That venue is not taking players at the moment." };
  const notHere = await entrantVenueRefusal(league.venueId, entrant, todayISO());
  if (notHere) return { ok: false, error: notHere.error, code: notHere.code, ...(notHere.vars ? { vars: notHere.vars } : {}) };
  // A women's or men's league: the player, and a pair's partner too, as declared.
  const category = categoryOfWho(league.who);
  const partnerGender = league.teamSize === 2 && isPartnerGender(input.partnerGender) ? input.partnerGender : null;
  const notFor = await entrantCategoryRefusal(entrant, category, league.teamSize === 2 ? { partnerGender } : null, input.gender);
  if (notFor) return { ok: false, error: notFor.error, code: notFor.code, ...(notFor.vars ? { vars: notFor.vars } : {}) };
  const partner = input.partnerName?.trim() ?? "";
  if (league.teamSize === 2 && (partner.length < 2 || partner.length > 60)) return { ok: false, error: "Name your partner." };
  const name = (league.teamSize === 2 ? `${entrant.name} / ${partner}` : entrant.name).slice(0, 130);
  const userId = entrantUserId(entrant);
  const participantId = entrantParticipantId(entrant);

  // The same player back again: the account holder's own place, or the participant's, whoever enters them.
  const before =
    participantId !== null
      ? ((await db.prepare("SELECT id, status FROM league_players WHERE league_id = ? AND participant_id = ? ORDER BY id DESC LIMIT 1").get(leagueId, participantId)) as
          | { id: number; status: "active" | "left" }
          | undefined)
      : userId !== null
        ? ((await db
            .prepare("SELECT id, status FROM league_players WHERE league_id = ? AND user_id = ? AND participant_id IS NULL ORDER BY id DESC LIMIT 1")
            .get(leagueId, userId)) as { id: number; status: "active" | "left" } | undefined)
        : undefined;
  if (before?.status === "active") return entrant.kind === "self" ? { ok: false, error: "You are in this league already." } : refuse("LG5_JOINED_ALREADY", { name: entrant.name });
  const gender = declaredGender(entrant, category, input.gender);
  const counter = entrant.kind === "counter" ? entrant : null;
  let id: number;
  if (before) {
    // Back again: the same player, so last season's finish still counts.
    await db
      .prepare(
        `UPDATE league_players SET status = 'active', left_at = NULL, name = ?, partner_name = ?, partner_gender = ?, user_id = ?, entrant_gender = ?,
                contact_phone = ?, entered_by_admin_id = ?, entered_by_name = ? WHERE id = ?`
      )
      .run(name, partner || null, partnerGender, userId, gender, counter?.phone ?? null, counter?.adminId ?? null, counter?.adminName ?? null, before.id);
    id = before.id;
  } else {
    id = (
      await db
        .prepare(
          `INSERT INTO league_players (league_id, user_id, name, partner_name, partner_gender, participant_id, entrant_gender, contact_phone, entered_by_admin_id, entered_by_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(leagueId, userId, name, partner || null, partnerGender, participantId, gender, counter?.phone ?? null, counter?.adminId ?? null, counter?.adminName ?? null)
    ).lastInsertRowid as number;
  }
  await recordEntered(entrant, league.venueId, "league.joined", league.name);
  const next = league.current;
  if (userId !== null)
    await tellPlayer(
      userId,
      league,
      (tr) => tr("mail.league.joined.s", { l: league.name }),
      (tr) =>
        sentences(
          tr,
          entrant.kind === "participant" && tr("lg5.mail.placeFor", { name: entrant.name }),
          tr("mail.league.joined.b", { l: league.name, venue: league.venueName }),
          next?.status === "forming" && tr("mail.league.joined.forming", { n: next.number, date: next.startsOn }),
          next?.status === "running" && tr("mail.league.joined.running", { date: next.endsOn }),
          league.fee > 0 && tr("mail.league.feeSeason", { fee: money(league.fee.toFixed(2)) })
        )
    );
  return { ok: true, value: (await playerById(id))! };
}

async function playerById(id: number): Promise<LeaguePlayer | null> {
  const r = (await getDb().prepare("SELECT id, name, status, user_id, start_box FROM league_players WHERE id = ?").get(id)) as
    | { id: number; name: string; status: "active" | "left"; user_id: number | null; start_box: number | null }
    | undefined;
  return r ? { id: r.id, name: r.name, status: r.status, userId: r.user_id, startBox: r.start_box } : null;
}

async function activePlayers(leagueId: number) {
  return (await getDb()
    .prepare("SELECT id, user_id, name FROM league_players WHERE league_id = ? AND status = 'active' ORDER BY joined_at, id")
    .all(leagueId)) as { id: number; user_id: number | null; name: string }[];
}

/**
 * Out of the league. In a season being played, every match they have not
 * played is a walkover to the other side, and they finish at the foot of
 * their box; what they played still counts for their opponents.
 */
export async function leave(playerId: number): Promise<Result<LeaguePlayer>> {
  const db = getDb();
  const p = (await db.prepare("SELECT id, league_id, status FROM league_players WHERE id = ?").get(playerId)) as
    | { id: number; league_id: number; status: string }
    | undefined;
  if (!p || p.status !== "active") return { ok: false, error: "That player is not in the league." };
  await db.transaction(async () => {
    await db.prepare("UPDATE league_players SET status = 'left', left_at = datetime('now') WHERE id = ?").run(playerId);
    const season = await currentSeason(p.league_id);
    if (season?.status !== "running") return;
    await db
      .prepare("UPDATE league_places SET withdrawn_at = datetime('now') WHERE season_id = ? AND player_id = ? AND withdrawn_at IS NULL")
      .run(season.id, playerId);
    await db
      .prepare(
        `UPDATE league_matches
            SET status = 'walkover', score = NULL, winner = CASE WHEN player_a = ? THEN player_b ELSE player_a END,
                updated_at = datetime('now')
          WHERE season_id = ? AND (player_a = ? OR player_b = ?) AND status IN ('unplayed', 'reported', 'disputed')`
      )
      .run(playerId, season.id, playerId, playerId);
  })();
  return { ok: true, value: (await playerById(playerId))! };
}

/** The player's own place in a league, if they are in it. */
export async function myLeague(userId: number, leagueId: number): Promise<MyLeague | null> {
  const p = (await getDb()
    .prepare("SELECT id, name FROM league_players WHERE league_id = ? AND user_id = ? AND participant_id IS NULL AND status = 'active'")
    .get(leagueId, userId)) as { id: number; name: string } | undefined;
  return p ? placeOf(leagueId, p) : null;
}

/** Places this account holds for people it still acts for (a guardian's), each with its box-mates to arrange matches with. */
export async function managedLeague(userId: number, leagueId: number): Promise<MyLeague[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT lp.id, lp.name, lp.participant_id FROM league_players lp JOIN participants p ON p.id = lp.participant_id
        WHERE lp.league_id = ? AND lp.user_id = ? AND lp.status = 'active' AND ${ACTS_FOR("p")} ORDER BY lp.id`
    )
    .all(leagueId, userId, userId, userId)) as { id: number; name: string; participant_id: number }[];
  return Promise.all(rows.map(async (r) => ({ ...(await placeOf(leagueId, r)), participantId: r.participant_id })));
}

async function placeOf(leagueId: number, p: { id: number; name: string }): Promise<MyLeague> {
  const db = getDb();
  const season = await currentSeason(leagueId);
  if (season?.status !== "running") return { playerId: p.id, name: p.name, place: null, contacts: [] };
  const place = (await db.prepare("SELECT * FROM league_places WHERE season_id = ? AND player_id = ?").get(season.id, p.id)) as
    | { id: number; box_no: number; finish: number | null; move: Move | null; paid_at: string | null; withdrawn_at: string | null }
    | undefined;
  if (!place) return { playerId: p.id, name: p.name, place: null, contacts: [] };
  // Box-mates, still playing, and how to reach them: what joining agreed to. A
  // participant's is their guardian's number; one added at the counter, the number given there.
  const contacts = (await db
    .prepare(
      `SELECT p.id, p.name, COALESCE(u.phone, p.contact_phone) AS phone FROM league_places lp
         JOIN league_players p ON p.id = lp.player_id
         LEFT JOIN users u ON u.id = p.user_id
        WHERE lp.season_id = ? AND lp.box_no = ? AND lp.player_id <> ? AND lp.withdrawn_at IS NULL
          AND COALESCE(u.phone, p.contact_phone) IS NOT NULL
        ORDER BY p.name`
    )
    .all(season.id, place.box_no, p.id)) as { id: number; name: string; phone: string }[];
  return {
    playerId: p.id,
    name: p.name,
    place: {
      id: place.id,
      playerId: p.id,
      boxNo: place.box_no,
      finish: place.finish,
      move: place.move,
      paid: place.paid_at !== null,
      withdrawn: place.withdrawn_at !== null,
    },
    contacts: contacts.map((c) => ({ playerId: c.id, name: c.name, phone: c.phone, whatsapp: toWhatsAppNumber(c.phone) })),
  };
}

/** Staff: where a newcomer starts. */
export async function setStartBox(playerId: number, box: number | null): Promise<Result<LeaguePlayer>> {
  if (box !== null && (!Number.isInteger(box) || box < 1 || box > 99)) return { ok: false, error: "A box is 1 or more." };
  await getDb().prepare("UPDATE league_players SET start_box = ? WHERE id = ?").run(box, playerId);
  const p = await playerById(playerId);
  return p ? { ok: true, value: p } : { ok: false, error: "Not found." };
}

/** Staff: a season's fee paid at the counter, or not. */
export async function setPlacePaid(
  placeId: number,
  paid: boolean,
  /** How the desk took the fee, for its receipt and the cash-up (lib/cash-up.ts). */
  via?: CounterMethod | null
): Promise<Result<{ id: number; paid: boolean }>> {
  const db = getDb();
  const was = (await db.prepare("SELECT paid_at FROM league_places WHERE id = ?").get(placeId)) as { paid_at: string | null } | undefined;
  if (!was) return { ok: false, error: "Not found." };
  // A fee paid online is refunded from the online payments list, not unmarked here.
  const { paidOnline } = await import("./tournaments");
  if (!paid && (await paidOnline("league_place_id", placeId)))
    return { ok: false, error: "This fee was paid online. Refund it from the online payments list instead." };
  // One statement, so two marks at once receipt it once.
  const changed = await db
    .prepare(`UPDATE league_places SET paid_at = ${paid ? "datetime('now')" : "NULL"} WHERE id = ? AND paid_at IS ${paid ? "NULL" : "NOT NULL"}`)
    .run(placeId);
  if (changed.changes === 1) await receiptFee("place", placeId, paid, via);
  return { ok: true, value: { id: placeId, paid } };
}

// ------------------------------------------------------------ seasons

const LEVEL_RANK: Record<Level, number> = { beginner: 1, intermediate: 2, advanced: 3, competitive: 4 };

/**
 * Make the boxes and start the season: everybody signed up goes into one,
 * by last season's finish and moves, newcomers by where staff put them or
 * else at the bottom by the level they gave; and every match in each box.
 */
export async function startSeason(leagueId: number, opts: { startsOn?: string; endsOn?: string } = {}, today = todayISO()): Promise<Result<LeagueDetail>> {
  const db = getDb();
  const league = await leagueById(leagueId);
  const season = league?.current;
  if (!league || league.status !== "running" || !season || season.status !== "forming")
    return { ok: false, error: "No season is waiting to start." };
  const startsOn = opts.startsOn ?? (season.startsOn < today ? today : season.startsOn);
  const endsOn = opts.endsOn ?? addDays(startsOn, league.seasonDays - 1);
  if (!isValidDateString(startsOn) || !isValidDateString(endsOn) || startsOn < today) return { ok: false, error: "Start it today or later." };
  if (endsOn < addDays(startsOn, 6) || endsOn > addDays(startsOn, 61)) return { ok: false, error: "A season is 1 to 9 weeks." };

  const players = (await db
    .prepare(
      `SELECT p.id, p.user_id, p.name, p.start_box, pl.level, p.participant_id,
              last.box_no AS last_box, last.finish AS last_finish, last.move AS last_move
         FROM league_players p
         LEFT JOIN player_levels pl ON pl.user_id = p.user_id AND p.participant_id IS NULL AND pl.sport = ?
         LEFT JOIN league_places last ON last.player_id = p.id
              AND last.season_id = (SELECT id FROM league_seasons WHERE league_id = ? AND number = ?)
        WHERE p.league_id = ? AND p.status = 'active'
        ORDER BY p.joined_at, p.id`
    )
    .all(league.sport, leagueId, season.number - 1, leagueId)) as {
    id: number;
    user_id: number | null;
    participant_id: number | null;
    name: string;
    start_box: number | null;
    level: Level | null;
    last_box: number | null;
    last_finish: number | null;
    last_move: Move | null;
  }[];
  if (players.length < 3) return { ok: false, error: "At least 3 players are needed." };

  const ranked = ladder(
    players.map((p) => ({
      id: p.id,
      last: p.last_box !== null && p.last_finish !== null && p.last_move !== null ? { box: p.last_box, finish: p.last_finish, move: p.last_move } : null,
      startBox: p.start_box,
      level: p.level ? LEVEL_RANK[p.level] : 0,
    }))
  );
  const boxes = intoBoxes(ranked, boxSizes(ranked.length, league.boxSize));

  await db.transaction(async () => {
    const claimed = await db
      .prepare("UPDATE league_seasons SET status = 'running', starts_on = ?, ends_on = ? WHERE id = ? AND status = 'forming'")
      .run(startsOn, endsOn, season.id);
    if (claimed.changes === 0) return;
    for (const [i, box] of boxes.entries()) {
      for (const id of box)
        await db.prepare("INSERT INTO league_places (season_id, player_id, box_no) VALUES (?, ?, ?)").run(season.id, id, i + 1);
      for (let x = 0; x < box.length; x++)
        for (let y = x + 1; y < box.length; y++)
          await db
            .prepare("INSERT INTO league_matches (season_id, box_no, player_a, player_b) VALUES (?, ?, ?, ?)")
            .run(season.id, i + 1, box[x], box[y]);
    }
    // A newcomer is placed now; next time they are where they finished.
    await db.prepare("UPDATE league_players SET start_box = NULL WHERE league_id = ?").run(leagueId);
  })();

  const names = new Map(players.map((p) => [p.id, p.name]));
  for (const [i, box] of boxes.entries())
    for (const id of box) {
      const p = players.find((x) => x.id === id)!;
      if (!p.user_id) continue;
      const others = box.filter((o) => o !== id).map((o) => names.get(o)).join(", ");
      await tellPlayer(
        p.user_id,
        league,
        (tr) => tr("mail.league.started.s", { n: season.number, box: i + 1 }),
        (tr) =>
          [
            p.participant_id !== null && tr("lg5.mail.placeFor", { name: p.name }),
            tr("mail.league.started.b", { n: season.number, l: league.name, from: startsOn, to: endsOn, box: i + 1, others }),
            tr("mail.league.started.how"),
            league.fee > 0 && tr(league.payOnline ? "mail.league.feeOnline" : "mail.league.feeVenue", { fee: money(league.fee.toFixed(2)) }),
          ]
            .filter(Boolean)
            .join("\n\n")
      );
    }
  return { ok: true, value: (await leagueDetail(leagueId, { forStaff: true }))! };
}

/**
 * The season is over: results waiting for a reply stand, disputes nobody
 * settled do not count, everybody gets their finish and their move, and the
 * next season is set up to start the day after.
 */
export async function endSeason(leagueId: number, today = todayISO()): Promise<Result<LeagueDetail>> {
  const db = getDb();
  const league = await leagueById(leagueId);
  const season = league?.current;
  if (!league || !season || season.status !== "running") return { ok: false, error: "No season is being played." };

  const changed = await db.transaction(async () => {
    const claimed = await db.prepare("UPDATE league_seasons SET status = 'finished' WHERE id = ? AND status = 'running'").run(season.id);
    if (claimed.changes === 0) return false;
    await db.prepare("UPDATE league_matches SET status = 'confirmed', updated_at = datetime('now') WHERE season_id = ? AND status = 'reported'").run(season.id);
    await db.prepare("UPDATE league_matches SET status = 'void', updated_at = datetime('now') WHERE season_id = ? AND status = 'disputed'").run(season.id);

    const detail = (await leagueDetail(leagueId, { season: season.number }))!;
    const withdrawn = new Set(detail.places.filter((p) => p.withdrawn).map((p) => p.playerId));
    const finishing = detail.boxes.map((b) => b.table.map((s) => s.entryId).filter((id) => !withdrawn.has(id)));
    const moves = seasonMoves(finishing, league.moves);
    for (const box of finishing)
      for (const [i, playerId] of box.entries())
        await db
          .prepare("UPDATE league_places SET finish = ?, move = ? WHERE season_id = ? AND player_id = ?")
          .run(i + 1, moves.get(playerId)!, season.id, playerId);
    if (league.status === "running") {
      // Straight on, whether it ended early with every match played or late for the last results.
      const startsOn = addDays(today, 1);
      await db
        .prepare("INSERT INTO league_seasons (league_id, number, starts_on, ends_on) VALUES (?, ?, ?, ?)")
        .run(leagueId, season.number + 1, startsOn, addDays(startsOn, league.seasonDays - 1));
    }
    return true;
  })();
  if (!changed) return { ok: false, error: "No season is being played." };

  const after = (await leagueDetail(leagueId, { season: season.number, forStaff: true }))!;
  const next = (await currentSeason(leagueId)) ?? null;
  for (const place of after.places) {
    const p = after.people.find((x) => x.id === place.playerId);
    if (!p?.userId || p.status !== "active" || place.finish === null) continue;
    const finish = place.finish;
    const move: Written = (tr) =>
      place.move === "up"
        ? tr("mail.league.up", { box: place.boxNo - 1 })
        : place.move === "down"
          ? tr("mail.league.down", { box: place.boxNo + 1 })
          : tr("mail.league.stay", { box: place.boxNo });
    await tellPlayer(
      p.userId,
      league,
      (tr) => tr("mail.league.over.s", { n: season.number, l: league.name }),
      (tr) =>
        sentences(
          tr,
          // A place held for somebody the account acts for says whose it is.
          p.participantId ? tr("lg5.mail.placeFor", { name: p.name }) : null,
          // English says "2nd"; the others write the number into their own phrase.
          tr("mail.league.over.b", { n: season.number, l: league.name, place: tr.locale === "en" ? ordinal(finish) : finish, box: place.boxNo, move: move(tr) }),
          next && tr("mail.league.next", { n: next.number, date: next.startsOn })
        )
    );
  }
  return { ok: true, value: after };
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${s}`;
}

/**
 * What happens by itself, from the scheduler: results nobody answered
 * stand, seasons past their last day (and a few days for late results)
 * end, and seasons due to start do, if there are players enough.
 */
export async function leagueHousekeeping(today = todayISO()): Promise<{ confirmed: number; ended: number; started: number }> {
  const db = getDb();
  const confirmed = (
    await db
      .prepare(
        `UPDATE league_matches SET status = 'confirmed', updated_at = datetime('now')
          WHERE status = 'reported' AND reported_at < datetime('now', '-${CONFIRM_DAYS} days')`
      )
      .run()
  ).changes;
  let ended = 0;
  const due = (await db
    .prepare("SELECT league_id FROM league_seasons WHERE status = 'running' AND ends_on < ?")
    .all(addDays(today, -LATE_DAYS))) as { league_id: number }[];
  for (const s of due) if ((await endSeason(s.league_id, today)).ok) ended++;
  let started = 0;
  const ready = (await db
    .prepare(
      `SELECT s.league_id FROM league_seasons s JOIN leagues l ON l.id = s.league_id JOIN venues v ON v.id = l.venue_id
        WHERE s.status = 'forming' AND s.starts_on <= ? AND l.status = 'running' AND ${OPEN_TO_CUSTOMERS}`
    )
    .all(today)) as { league_id: number }[];
  for (const s of ready) if ((await startSeason(s.league_id, {}, today)).ok) started++;
  return { confirmed, ended, started };
}

// ------------------------------------------------------------ results

interface MatchRow {
  id: number;
  season_id: number;
  box_no: number;
  player_a: number;
  player_b: number;
  status: MatchStatus;
  reported_by: number | null;
  winner: number | null;
  score: string | null;
  league_id: number;
  season_status: SeasonStatus;
  user_a: number | null;
  user_b: number | null;
  name_a: string;
  name_b: string;
  version: number;
}

/**
 * The match with its sides. `lock`: its row locked for the rest of the
 * transaction, so nothing changes it between this read and the write that
 * follows (migration 0177).
 */
async function matchRow(matchId: number, lock = false): Promise<MatchRow | undefined> {
  const row = (await getDb()
    .prepare(
      `SELECT m.*, s.league_id, s.status AS season_status, pa.user_id AS user_a, pb.user_id AS user_b, pa.name AS name_a, pb.name AS name_b
         FROM league_matches m
         JOIN league_seasons s ON s.id = m.season_id
         JOIN league_players pa ON pa.id = m.player_a
         JOIN league_players pb ON pb.id = m.player_b
        WHERE m.id = ?${lock ? " FOR UPDATE OF m" : ""}`
    )
    .get(matchId)) as MatchRow | undefined;
  return row ? { ...row, version: Number(row.version ?? 0) } : undefined;
}

/**
 * Which side the account acts for, if either: its own place, or a
 * participant's it entered. An account on both sides (a guardian whose two
 * children play each other) answers for neither: staff enter that result.
 */
function sideOf(m: MatchRow, userId: number): { me: number; them: number; theirUser: number | null } | null {
  if (m.user_a === userId && m.user_b === userId) return null;
  if (m.user_a === userId) return { me: m.player_a, them: m.player_b, theirUser: m.user_b };
  if (m.user_b === userId) return { me: m.player_b, them: m.player_a, theirUser: m.user_a };
  return null;
}

/** What a stale answer gets: the result changed since it was read. */
const changed = (): { ok: false; error: string; code: string } => ({
  ok: false,
  error: "The result changed while you were looking at it. Look at it again, then answer.",
  code: "LG5_RESULT_CHANGED",
});

/** Was a version given that is not the one the match has now? */
const stale = (m: MatchRow, expected: { version?: number }) => expected.version !== undefined && expected.version !== m.version;

/** Why a score cannot stand for this winner, by the league's rules (first-named side's score first), or null. */
function checkScore(winner: number, a: number, b: number, score: string, scoring: CompetitionRules["scoring"]): string | null {
  if (winner !== a && winner !== b) return "The winner has to be one of the two.";
  return scoreRefusal(score, winner === a, scoring);
}

export { flipScore };

/**
 * A player says how their match went. They can put it right until the other
 * side answers. One transaction on the match's locked row: a report never
 * lands on a result that was confirmed, disputed or decided meanwhile.
 * `expected.version`, where given: the result as the player last saw it.
 */
export async function reportResult(
  userId: number,
  matchId: number,
  input: { winner: number; score: string },
  expected: { version?: number } = {}
): Promise<Result<LeagueMatch>> {
  const done = await withTransaction(async (): Promise<{ ok: false; error: string; code?: string } | { ok: true; m: MatchRow; side: NonNullable<ReturnType<typeof sideOf>>; typed: string }> => {
    const m = await matchRow(matchId, true);
    const side = m ? sideOf(m, userId) : null;
    if (!m || !side) return { ok: false, error: "That is not your match." };
    if (m.season_status !== "running") return { ok: false, error: "That season is over." };
    if (m.status === "reported" && m.reported_by !== side.me) return { ok: false, error: "They have reported it: confirm it, or say it is wrong." };
    if (m.status === "disputed") return { ok: false, error: "The venue is deciding this one." };
    if (m.status !== "unplayed" && m.status !== "reported") return { ok: false, error: "This result is settled. Ask the venue if it is wrong." };
    if (stale(m, expected)) return changed();
    // A player writes their own games first; it is kept with the first-named side's first.
    const typed = input.score.trim();
    const score = side.me === m.player_a ? typed : flipScore(typed);
    const rules = (await leagueById(m.league_id))!.rules;
    const wrong = checkScore(input.winner, m.player_a, m.player_b, score, rules.scoring);
    if (wrong) return { ok: false, error: wrong };
    const wrote = await getDb()
      .prepare(
        `UPDATE league_matches SET status = 'reported', winner = ?, score = ?, reported_by = ?, reported_at = datetime('now'),
                updated_at = datetime('now') WHERE id = ? AND version = ? AND status IN ('unplayed', 'reported')`
      )
      .run(input.winner, score, side.me, matchId, m.version);
    if (wrote.changes !== 1) return changed();
    return { ok: true, m, side, typed };
  });
  if (!done.ok) return done;
  const { m, side, typed } = done;
  if (side.theirUser) {
    const league = (await leagueById(m.league_id))!;
    const me = side.me === m.player_a ? m.name_a : m.name_b;
    await tellPlayer(
      side.theirUser,
      league,
      (tr) => tr("mail.league.reported.s", { me }),
      (tr) =>
        sentences(
          tr,
          tr(input.winner === side.me ? "mail.league.reported.they" : "mail.league.reported.you", { me, l: league.name, score: typed }),
          tr("mail.league.reported.ask", { days: CONFIRM_DAYS })
        )
    );
  }
  return { ok: true, value: (await matchesOf(m.season_id)).find((x) => x.id === matchId)! };
}

/**
 * The other side's answer to a report, on the match's locked row: it stands
 * only on the result they saw (`expected.version`; a correction made since
 * is refused as changed), and only while it is still a report.
 */
async function answerReport(
  userId: number,
  matchId: number,
  to: "confirmed" | "disputed",
  note: string | null,
  expected: { version?: number }
): Promise<{ ok: false; error: string; code?: string } | { ok: true; m: MatchRow; side: NonNullable<ReturnType<typeof sideOf>> }> {
  return withTransaction(async () => {
    const m = await matchRow(matchId, true);
    const side = m ? sideOf(m, userId) : null;
    if (!m || !side) return { ok: false, error: "That is not your match." };
    if (m.status !== "reported" || m.reported_by === side.me)
      return stale(m, expected) ? changed() : { ok: false, error: to === "confirmed" ? "There is nothing for you to confirm." : "There is nothing for you to dispute." };
    if (stale(m, expected)) return changed();
    const wrote = await getDb()
      .prepare(
        `UPDATE league_matches SET status = ?, dispute_note = COALESCE(?, dispute_note), updated_at = datetime('now')
          WHERE id = ? AND status = 'reported' AND version = ?`
      )
      .run(to, note, matchId, m.version);
    if (wrote.changes !== 1) return changed();
    return { ok: true, m, side };
  });
}

/** The other side agrees, with the result they saw (`expected.version`). */
export async function confirmResult(userId: number, matchId: number, expected: { version?: number } = {}): Promise<Result<LeagueMatch>> {
  const done = await answerReport(userId, matchId, "confirmed", null, expected);
  if (!done.ok) return done;
  return { ok: true, value: (await matchesOf(done.m.season_id)).find((x) => x.id === matchId)! };
}

/** The other side says it did not go like that, about the result they saw: the venue decides. */
export async function disputeResult(userId: number, matchId: number, note: string, expected: { version?: number } = {}): Promise<Result<LeagueMatch>> {
  const why = note.trim().slice(0, 500);
  if (why.length < 3) {
    // Said too little; but a match that is not theirs, or not theirs to answer, says so first.
    const m = await matchRow(matchId);
    const side = m ? sideOf(m, userId) : null;
    if (!m || !side) return { ok: false, error: "That is not your match." };
    if (m.status !== "reported" || m.reported_by === side.me) return { ok: false, error: "There is nothing for you to dispute." };
    return { ok: false, error: "Say what really happened." };
  }
  const done = await answerReport(userId, matchId, "disputed", why, expected);
  if (!done.ok) return done;
  const { m, side } = done;
  const league = (await leagueById(m.league_id))!;
  await tellVenueStaff(
    league.venueId,
    `A league result is disputed: ${league.name}`,
    `${m.name_a} v ${m.name_b} (box ${m.box_no}) was reported as ${m.score}, won by ${m.winner === m.player_a ? m.name_a : m.name_b}. ` +
      `${side.me === m.player_a ? m.name_a : m.name_b} says: "${why}"\n\nDecide it under Leagues in the admin: ${baseUrl()}/admin`
  );
  return { ok: true, value: (await matchesOf(m.season_id)).find((x) => x.id === matchId)! };
}

/**
 * Staff decide a result — a dispute, a walkover, a correction — or strike
 * it, or clear it to be played: on the match's locked row, and, where
 * `expected.version` is given, only on the result staff were looking at (a
 * player's report or answer since is refused as changed, to be looked at
 * again). Both sides are then emailed what the venue decided, in their own
 * language, through the outbox.
 */
export async function decideResult(
  matchId: number,
  adminId: number,
  input: { winner: number; score?: string; walkover?: boolean } | { void: true } | { clear: true },
  expected: { version?: number } = {}
): Promise<Result<LeagueMatch>> {
  const db = getDb();
  const done = await withTransaction(async (): Promise<{ ok: false; error: string; code?: string } | { ok: true; m: MatchRow; score: string | null }> => {
    const m = await matchRow(matchId, true);
    if (!m) return { ok: false, error: "Match not found." };
    if (m.season_status !== "running") return { ok: false, error: "That season is over." };
    if (stale(m, expected)) return changed();
    let wrote;
    let score: string | null = null;
    if ("void" in input || "clear" in input) {
      wrote = await db
        .prepare(
          `UPDATE league_matches SET status = ?, winner = NULL, score = NULL, reported_by = NULL, reported_at = NULL,
                  decided_by = ?, updated_at = datetime('now') WHERE id = ? AND version = ?`
        )
        .run("void" in input ? "void" : "unplayed", adminId, matchId, m.version);
    } else {
      score = input.score?.trim() || null;
      if (score) {
        const wrong = checkScore(input.winner, m.player_a, m.player_b, score, (await leagueById(m.league_id))!.rules.scoring);
        if (wrong) return { ok: false, error: wrong };
      } else if (!input.walkover) return { ok: false, error: "Give the score, or mark it a walkover." };
      else if (input.winner !== m.player_a && input.winner !== m.player_b) return { ok: false, error: "The winner has to be one of the two." };
      wrote = await db
        .prepare("UPDATE league_matches SET status = ?, winner = ?, score = ?, decided_by = ?, updated_at = datetime('now') WHERE id = ? AND version = ?")
        .run(score ? "confirmed" : "walkover", input.winner, score, adminId, matchId, m.version);
    }
    if (wrote.changes !== 1) return changed();
    return { ok: true, m, score };
  });
  if (!done.ok) return done;
  await tellDecision(done.m, input, done.score);
  return { ok: true, value: (await matchesOf(done.m.season_id)).find((x) => x.id === matchId)! };
}

/** Both sides of a match, told what the venue's staff decided about it (once each, where one account acts for both). */
async function tellDecision(
  m: MatchRow,
  input: { winner: number; score?: string; walkover?: boolean } | { void: true } | { clear: true },
  score: string | null
): Promise<void> {
  const league = (await leagueById(m.league_id))!;
  const vars = { l: league.name, a: m.name_a, b: m.name_b };
  const said: Written =
    "void" in input
      ? (tr) => tr("lg5.mail.void.b", vars)
      : "clear" in input
        ? (tr) => tr("lg5.mail.cleared.b", vars)
        : (tr) =>
            tr(score ? "lg5.mail.decided.b" : "lg5.mail.walkover.b", {
              ...vars,
              winner: input.winner === m.player_a ? m.name_a : m.name_b,
              score: score ?? "",
            });
  for (const userId of new Set([m.user_a, m.user_b]))
    if (userId !== null)
      await tellPlayer(
        userId,
        league,
        (tr) => tr("lg5.mail.decided.s", vars),
        (tr) => sentences(tr, said(tr), tr("lg5.mail.decided.ask"))
      );
}

// ------------------------------------------------------------ telling people

/** An email to a player, written in their language (subject and body take the lookup). */
async function tellPlayer(userId: number, league: League, subject: Written, body: Written): Promise<void> {
  await emailPlayer({ venueId: league.venueId, userId, subject, body, link: `${baseUrl()}/leagues/${league.id}` });
}

// ------------------------------------------------------------ their own data

/**
 * Out of every league, and off every box, past or not, by name. A place
 * held for a participant the account acted for stays the participant's: only
 * the account comes off it (their record is erased on its own,
 * `forgetLeagueParticipant`, when nobody else acts for them).
 */
export async function forgetLeaguePlayer(userId: number, anonymous: string): Promise<void> {
  const db = getDb();
  const rows = (await db.prepare("SELECT id FROM league_players WHERE user_id = ? AND participant_id IS NULL AND status = 'active'").all(userId)) as { id: number }[];
  for (const r of rows) await leave(r.id);
  await db.prepare("UPDATE league_players SET user_id = NULL WHERE user_id = ? AND participant_id IS NOT NULL").run(userId);
  await db.prepare("UPDATE league_players SET name = ?, partner_name = NULL, user_id = NULL WHERE user_id = ?").run(anonymous, userId);
}

/** A participant's record erased (lib/participants.ts): out of their leagues, and their name off every box. */
export async function forgetLeagueParticipant(participantId: number, anonymous: string): Promise<void> {
  const db = getDb();
  const rows = (await db.prepare("SELECT id FROM league_players WHERE participant_id = ? AND status = 'active'").all(participantId)) as { id: number }[];
  for (const r of rows) await leave(r.id);
  await db
    .prepare("UPDATE league_players SET name = ?, partner_name = NULL, user_id = NULL, contact_phone = NULL, participant_id = NULL WHERE participant_id = ?")
    .run(anonymous, participantId);
}
