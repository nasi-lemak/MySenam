import { isActivity } from "./activities";
import { getDb, isBusy, withTransaction } from "./db";
import { scoreRefusal, standings, type Standing, type TableResult } from "./brackets";
import { templateByKey, templateFor, type RubberKind } from "./competition-templates";
import { courtsForNight, fewestNights, placeOnNights, teamRoundRobin } from "./fixtures";
import { LEVELS, type Level } from "./games";
import { formatMinute } from "./interval";
import { baseUrl, emailPlayer, sentences, type Written } from "./outbox";
import { tellVenueStaffEach } from "./owner-alerts";
import { blockSlots, offerSlotPlace, venueHours } from "./store";
import { parseRules, RANK_KEYS, readRules, type CompetitionRules, type RankKey, type ScoringRules } from "./tournament-rules";
import { addDays, isValidDateString, todayISO } from "./time";
import { rosterRefusal, teamForEntry, teamRefusal, tellMemberById, tellRoster, firstName, type EventRules, type TeamRefusal, type TeamResult } from "./teams";
import type { Category } from "./who";

/**
 * Leagues of teams, with fixture lists (docs/features/tournaments.md#team-leagues;
 * migration 0269).
 *
 * A venue sets one up for a season: the sport (whose template says how a game
 * is scored and what a team match is made of: badminton's singles, doubles,
 * singles; football's one match of the whole team), the courts it plays on, and
 * who may enter. Teams (lib/teams.ts) enter with a roster picked from their
 * members, checked per member as a tournament's team entry is. The manager
 * sets the match nights and the **fixture generator** (lib/fixtures.ts) makes a
 * single or double round robin on them, with home courts, home and away
 * alternating, a bye for the odd team out, and nobody on a date they cannot;
 * each fixture's court time is held as a block the league owns, so every
 * booking path treats it as taken.
 *
 * A captain sets the lineup from the league roster (singles, doubles, the
 * whole team); after the match either captain reports the games' scores and the
 * other confirms, or says it is wrong and the venue's staff decide; a report
 * nobody answers stands after three days, as a box league's does. Every score
 * is checked, and the table ranked, by the same competition rules as a
 * tournament's (`scoreRefusal`, `standings`; lib/brackets.ts), from the sport's
 * template; results are written only here, on the fixture's locked row and only
 * as it was last seen (its `version`). Fixtures are moved by managers only; a
 * team that does not play forfeits, the other side awarded every game.
 */

export const CONFIRM_DAYS = 3;
export const MAX_RUBBERS = 9;
export const MAX_BLACKOUTS = 40;

export type TeamLeagueStatus = "forming" | "scheduled" | "finished" | "closed";
export type FixtureStatus = "scheduled" | "reported" | "confirmed" | "disputed" | "forfeit" | "void";
export type Side = "home" | "away";

/** How a team match earns table points when it is made of several games. */
export interface TableRules {
  tablePoints: { win: number; draw: number; loss: number };
  rankBy: RankKey[];
}

export const DEFAULT_TABLE: TableRules = { tablePoints: { win: 3, draw: 1, loss: 0 }, rankBy: ["points", "point_diff", "points_for", "head_to_head"] };

export interface TeamLeague {
  id: number;
  venueId: number;
  venueName: string;
  name: string;
  sport: string;
  template: string | null;
  rules: CompetitionRules;
  rubbers: RubberKind[];
  table: TableRules;
  legs: 1 | 2;
  category: "open" | "women" | "men";
  ageRange: { min: number | null; max: number | null } | null;
  membersOnly: boolean;
  /** The venue marked it as rated: its results count towards players' and teams' ratings (lib/ratings.ts). */
  rated: boolean;
  level: Level | null;
  description: string | null;
  startsOn: string;
  endsOn: string;
  slotsPerNight: number;
  maxTeams: number;
  entriesCloseOn: string | null;
  rosterMin: number;
  rosterMax: number;
  maxRubbersPerPlayer: number;
  rubberMinutes: number;
  status: TeamLeagueStatus;
  courts: { id: number; name: string }[];
  nights: { id: number; no: number; date: string; startMin: number }[];
  teams: number;
}

interface LeagueRow {
  id: number;
  venue_id: number;
  venue_name: string;
  name: string;
  sport: string;
  template: string | null;
  rules: string;
  rubbers: string;
  table_rules: string;
  legs: number;
  category: "open" | "women" | "men";
  age_min: number | null;
  age_max: number | null;
  members_only: boolean;
  rated?: boolean | null;
  level: Level | null;
  description: string | null;
  starts_on: string;
  ends_on: string;
  slots_per_night: number;
  max_teams: number;
  entries_close_on: string | null;
  roster_min: number;
  roster_max: number;
  max_rubbers_per_player: number;
  rubber_minutes: number;
  status: TeamLeagueStatus;
}

const LEAGUE_SELECT = `SELECT l.*, v.name AS venue_name FROM team_leagues l JOIN venues v ON v.id = l.venue_id`;

function readTable(raw: string): TableRules {
  try {
    const t = JSON.parse(raw) as Partial<TableRules>;
    const n = (v: unknown, d: number) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 10 ? (v as number) : d);
    const rank = Array.isArray(t.rankBy) ? (t.rankBy.filter((k) => RANK_KEYS.includes(k as RankKey)) as RankKey[]) : [];
    return {
      tablePoints: { win: n(t.tablePoints?.win, 3), draw: n(t.tablePoints?.draw, 1), loss: n(t.tablePoints?.loss, 0) },
      rankBy: rank.length > 0 ? [...new Set(rank)] : DEFAULT_TABLE.rankBy,
    };
  } catch {
    return DEFAULT_TABLE;
  }
}

async function toLeague(r: LeagueRow): Promise<TeamLeague> {
  const db = getDb();
  const courts = (await db
    .prepare("SELECT c.id, c.name FROM team_league_courts x JOIN courts c ON c.id = x.court_id WHERE x.league_id = ? ORDER BY c.id")
    .all(r.id)) as { id: number; name: string }[];
  const nights = (await db.prepare("SELECT id, night_no, date, start_min FROM team_league_nights WHERE league_id = ? ORDER BY night_no").all(r.id)) as {
    id: number;
    night_no: number;
    date: string;
    start_min: number;
  }[];
  const { n } = (await db.prepare("SELECT COUNT(*)::int AS n FROM team_league_teams WHERE league_id = ? AND status = 'entered'").get(r.id)) as { n: number };
  let rubbers: RubberKind[] = ["team"];
  try {
    const parsed = JSON.parse(r.rubbers) as RubberKind[];
    if (Array.isArray(parsed) && parsed.length > 0) rubbers = parsed;
  } catch {
    /* the default */
  }
  return {
    id: r.id,
    venueId: r.venue_id,
    venueName: r.venue_name,
    name: r.name,
    sport: r.sport,
    template: r.template,
    rules: readRules(r.rules),
    rubbers,
    table: readTable(r.table_rules),
    legs: r.legs === 2 ? 2 : 1,
    category: r.category,
    ageRange: r.age_min !== null || r.age_max !== null ? { min: r.age_min, max: r.age_max } : null,
    membersOnly: r.members_only === true,
    rated: r.rated === true,
    level: r.level,
    description: r.description,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    slotsPerNight: r.slots_per_night,
    maxTeams: r.max_teams,
    entriesCloseOn: r.entries_close_on,
    rosterMin: r.roster_min,
    rosterMax: r.roster_max,
    maxRubbersPerPlayer: r.max_rubbers_per_player,
    rubberMinutes: r.rubber_minutes,
    status: r.status,
    courts,
    nights: nights.map((x) => ({ id: x.id, no: x.night_no, date: x.date, startMin: x.start_min })),
    teams: n,
  };
}

export async function teamLeagueById(id: number): Promise<TeamLeague | null> {
  const r = (await getDb().prepare(`${LEAGUE_SELECT} WHERE l.id = ?`).get(id)) as LeagueRow | undefined;
  return r ? toLeague(r) : null;
}

export async function listTeamLeagues(venueIds: number[]): Promise<TeamLeague[]> {
  if (venueIds.length === 0) return [];
  const rows = (await getDb()
    .prepare(`${LEAGUE_SELECT} WHERE l.venue_id IN (${venueIds.map(() => "?").join(",")}) ORDER BY l.id DESC`)
    .all(...venueIds)) as LeagueRow[];
  return Promise.all(rows.map(toLeague));
}

/** Leagues anybody can see: those taking teams or under way, newest first. */
export async function publicTeamLeagues(filter: { sport?: string; venueIds?: number[] } = {}): Promise<TeamLeague[]> {
  const clauses = ["l.status IN ('forming', 'scheduled')"];
  const params: (string | number)[] = [];
  if (filter.sport) {
    clauses.push("l.sport = ?");
    params.push(filter.sport);
  }
  if (filter.venueIds && filter.venueIds.length > 0) {
    clauses.push(`l.venue_id IN (${filter.venueIds.map(() => "?").join(",")})`);
    params.push(...filter.venueIds);
  }
  const rows = (await getDb().prepare(`${LEAGUE_SELECT} WHERE ${clauses.join(" AND ")} ORDER BY l.id DESC LIMIT 100`).all(...params)) as LeagueRow[];
  return Promise.all(rows.map(toLeague));
}

const zoneToday = async (venueId: number) => todayISO((await venueHours(venueId)).zone);

// ------------------------------------------------------------ setting one up

export interface TeamLeagueInput {
  venueId: number;
  name: unknown;
  sport: unknown;
  template?: unknown;
  rules?: unknown;
  rubbers?: unknown;
  tableRules?: unknown;
  legs?: unknown;
  category?: unknown;
  ageMin?: unknown;
  ageMax?: unknown;
  membersOnly?: unknown;
  level?: unknown;
  description?: unknown;
  startsOn: unknown;
  endsOn: unknown;
  slotsPerNight?: unknown;
  maxTeams?: unknown;
  entriesCloseOn?: unknown;
  rosterMin?: unknown;
  rosterMax?: unknown;
  maxRubbersPerPlayer?: unknown;
  rubberMinutes?: unknown;
  courtIds: unknown;
}

const RUBBER_KINDS: RubberKind[] = ["singles", "doubles", "team"];

function whole(v: unknown, lo: number, hi: number, fallback: number, what: string): number | TeamRefusal {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : teamRefusal("TL_NUMBER", { what }, 400);
}

/** A new league of teams, forming: teams enter, then the manager sets the match nights and makes the fixtures. */
export async function createTeamLeague(input: TeamLeagueInput, adminId: number): Promise<TeamResult<TeamLeague>> {
  const db = getDb();
  const name = typeof input.name === "string" ? input.name.trim().replace(/\s+/g, " ") : "";
  if (name.length < 3 || name.length > 80) return teamRefusal("TL_NAME", {}, 400);
  if (typeof input.sport !== "string" || !(await isActivity(input.sport))) return teamRefusal("TM_SPORT", {}, 400);
  const sport = input.sport;
  const venue = await db.prepare("SELECT 1 FROM venues WHERE id = ?").get(input.venueId);
  if (!venue) return teamRefusal("TL_NOT_FOUND", {}, 404);
  const template = (typeof input.template === "string" && templateByKey(input.template)) || templateFor(sport);
  if (template.rules.performance) return teamRefusal("TL_TEMPLATE", {}, 400);
  const parsed = parseRules(input.rules, template.rules);
  if (!parsed.ok) return { ok: false, error: parsed.error, status: 400 };
  if (parsed.rules.performance) return teamRefusal("TL_TEMPLATE", {}, 400);
  const rules = parsed.rules;
  // What a team match is made of.
  let rubbers: RubberKind[] = template.rubbers ? [...template.rubbers] : ["team"];
  if (input.rubbers !== undefined) {
    const given = Array.isArray(input.rubbers) ? input.rubbers : [];
    if (given.length < 1 || given.length > MAX_RUBBERS || given.some((k) => !RUBBER_KINDS.includes(k as RubberKind)) || (given.includes("team") && given.length !== 1))
      return teamRefusal("TL_RUBBERS", { n: MAX_RUBBERS }, 400);
    rubbers = given as RubberKind[];
  }
  // How a team match earns table points, where it is several games: the template's own scoring decides a one-match fixture.
  let table = DEFAULT_TABLE;
  if (input.tableRules !== undefined && input.tableRules !== null) {
    const t = input.tableRules as { tablePoints?: Partial<TableRules["tablePoints"]>; rankBy?: unknown };
    const points = { ...DEFAULT_TABLE.tablePoints, ...(t.tablePoints ?? {}) };
    const bad = Object.values(points).some((v) => !Number.isInteger(v) || v < 0 || v > 10);
    const rank = t.rankBy === undefined ? DEFAULT_TABLE.rankBy : t.rankBy;
    if (bad || !Array.isArray(rank) || rank.length === 0 || rank.some((k) => !RANK_KEYS.includes(k as RankKey))) return teamRefusal("TL_TABLE", {}, 400);
    table = { tablePoints: points, rankBy: [...new Set(rank as RankKey[])] };
  }
  const legs = input.legs === 2 || input.legs === "2" ? 2 : 1;
  const category = input.category === undefined || input.category === "" || input.category === "open" ? "open" : input.category === "women" || input.category === "men" ? input.category : null;
  if (category === null) return teamRefusal("TL_CATEGORY", {}, 400);
  const ageMin = input.ageMin === undefined || input.ageMin === null || input.ageMin === "" ? null : whole(input.ageMin, 0, 120, 0, "Youngest age");
  const ageMax = input.ageMax === undefined || input.ageMax === null || input.ageMax === "" ? null : whole(input.ageMax, 0, 120, 0, "Oldest age");
  if (typeof ageMin === "object" && ageMin !== null) return ageMin;
  if (typeof ageMax === "object" && ageMax !== null) return ageMax;
  if (ageMin !== null && ageMax !== null && ageMin > ageMax) return teamRefusal("TL_NUMBER", { what: "Ages" }, 400);
  const level = input.level === undefined || input.level === null || input.level === "" ? null : (input.level as Level);
  if (level !== null && !LEVELS.includes(level)) return teamRefusal("TL_NUMBER", { what: "Level" }, 400);
  const today = await zoneToday(input.venueId);
  const startsOn = String(input.startsOn ?? "");
  const endsOn = String(input.endsOn ?? "");
  if (!isValidDateString(startsOn) || !isValidDateString(endsOn) || startsOn < today || endsOn < startsOn || endsOn > addDays(startsOn, 366)) return teamRefusal("TL_DATES", {}, 400);
  const closes = input.entriesCloseOn === undefined || input.entriesCloseOn === null || input.entriesCloseOn === "" ? null : String(input.entriesCloseOn);
  if (closes !== null && (!isValidDateString(closes) || closes > startsOn)) return teamRefusal("TL_DATES", {}, 400);
  const slots = whole(input.slotsPerNight, 1, 8, 2, "Games a court holds a night");
  const maxTeams = whole(input.maxTeams, 2, 24, 12, "Most teams");
  const rosterMin = whole(input.rosterMin, 1, 40, Math.max(2, rubbers.includes("team") ? (template.roster?.min ?? 5) : 2), "Fewest on a roster");
  const rosterMax = whole(input.rosterMax, 1, 40, rubbers.includes("team") ? (template.roster?.max ?? 14) : 12, "Most on a roster");
  const cap = whole(input.maxRubbersPerPlayer, 1, 10, 2, "Most games a player plays in a match");
  const minutes = whole(input.rubberMinutes, 5, 300, template.matchMinutes, "Minutes held for a game");
  for (const n of [slots, maxTeams, rosterMin, rosterMax, cap, minutes]) if (typeof n === "object") return n;
  if ((rosterMin as number) > (rosterMax as number)) return teamRefusal("TL_NUMBER", { what: "Roster sizes" }, 400);
  // The venue's courts for the sport it plays on.
  const courtIds = Array.isArray(input.courtIds) ? [...new Set(input.courtIds.map(Number).filter((n) => Number.isInteger(n)))] : [];
  if (courtIds.length === 0) return teamRefusal("TL_COURTS", {}, 400);
  for (const id of courtIds) {
    const ok = await db
      .prepare("SELECT 1 FROM courts c WHERE c.id = ? AND c.venue_id = ? AND EXISTS (SELECT 1 FROM court_activities ca WHERE ca.court_id = c.id AND ca.sport = ?)")
      .get(id, input.venueId, sport);
    if (!ok) return teamRefusal("TL_COURTS", {}, 400);
  }
  const made = await withTransaction(async () => {
    const row = (await db
      .prepare(
        `INSERT INTO team_leagues (venue_id, name, sport, template, rules, rubbers, table_rules, legs, category, age_min, age_max, members_only, level, description,
                                   starts_on, ends_on, slots_per_night, max_teams, entries_close_on, roster_min, roster_max, max_rubbers_per_player, rubber_minutes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .get(
        input.venueId,
        name,
        sport,
        template.key,
        JSON.stringify(rules),
        JSON.stringify(rubbers),
        JSON.stringify(table),
        legs,
        category,
        ageMin,
        ageMax,
        input.membersOnly === true,
        level,
        typeof input.description === "string" ? input.description.trim().slice(0, 500) || null : null,
        startsOn,
        endsOn,
        slots,
        maxTeams,
        closes,
        rosterMin,
        rosterMax,
        cap,
        minutes,
        adminId
      )) as { id: number };
    for (const id of courtIds) await db.prepare("INSERT INTO team_league_courts (league_id, court_id) VALUES (?, ?)").run(row.id, id);
    return row.id;
  });
  return { ok: true, value: (await teamLeagueById(made))! };
}

/** Stop a league: its fixtures still to play are called off and their court time goes back. */
export async function closeTeamLeague(leagueId: number): Promise<TeamResult<TeamLeague>> {
  const league = await teamLeagueById(leagueId);
  if (!league) return teamRefusal("TL_NOT_FOUND", {}, 404);
  if (league.status === "closed" || league.status === "finished") return teamRefusal("TL_SEASON_OVER");
  const freed = await withTransaction(async () => {
    const db = getDb();
    await db.prepare("SELECT id FROM team_leagues WHERE id = ? FOR UPDATE").get(leagueId);
    const open = (await db.prepare("SELECT id FROM team_fixtures WHERE league_id = ? AND status IN ('scheduled', 'reported', 'disputed')").all(leagueId)) as { id: number }[];
    const days = (await db
      .prepare("SELECT DISTINCT court_id, date FROM blocks WHERE team_league_id = ? AND date >= ?")
      .all(leagueId, todayISO())) as { court_id: number; date: string }[];
    for (const f of open) await db.prepare("UPDATE team_fixtures SET status = 'void', version = version + 1, updated_at = datetime('now') WHERE id = ?").run(f.id);
    await db.prepare("DELETE FROM blocks WHERE team_league_id = ?").run(leagueId);
    await db.prepare("UPDATE team_leagues SET status = 'closed' WHERE id = ?").run(leagueId);
    return days;
  });
  await ratingsAfter(leagueId);
  for (const d of freed) await offerSlotPlace(d.court_id, d.date);
  return { ok: true, value: (await teamLeagueById(leagueId))! };
}

// ------------------------------------------------------------ teams enter

export interface LeagueTeamRow {
  id: number;
  league_id: number;
  team_id: number | null;
  name: string;
  home_court_id: number | null;
  status: "entered" | "withdrawn";
  captain_user_id: number | null;
}

const LT_SELECT = `SELECT x.id, x.league_id, x.team_id, x.name, x.home_court_id, x.status, t.captain_user_id
                     FROM team_league_teams x LEFT JOIN teams t ON t.id = x.team_id`;

export async function leagueTeam(id: number): Promise<LeagueTeamRow | undefined> {
  return (await getDb().prepare(`${LT_SELECT} WHERE x.id = ?`).get(id)) as LeagueTeamRow | undefined;
}

function eventRulesOf(league: TeamLeague): EventRules {
  return { venueId: league.venueId, name: league.name, sport: league.sport, category: league.category as Category, ageRange: league.ageRange, startsOn: league.startsOn, membersOnly: league.membersOnly };
}

/** The members already on another team's roster in this league, if the roster picked has any of them. */
async function rosteredElsewhere(leagueId: number, leagueTeamId: number | null, memberIds: number[]): Promise<{ name: string } | null> {
  if (memberIds.length === 0) return null;
  // The same person (an account, or a child) on another team's roster: by who they are, not the team's row for them.
  const row = (await getDb()
    .prepare(
      `SELECT r.name FROM team_league_roster r
         JOIN team_league_teams x ON x.id = r.league_team_id
         JOIN team_members m ON m.id = r.team_member_id
         JOIN team_members p ON (m.user_id IS NOT NULL AND p.user_id = m.user_id) OR (m.participant_id IS NOT NULL AND p.participant_id = m.participant_id)
        WHERE x.league_id = ? AND x.status = 'entered' AND x.id <> ? AND p.id IN (${memberIds.map(() => "?").join(",")}) LIMIT 1`
    )
    .get(leagueId, leagueTeamId ?? 0, ...memberIds)) as { name: string } | undefined;
  return row ?? null;
}

export interface EnterTeamInput {
  teamId: unknown;
  memberIds: unknown;
  homeCourtId?: unknown;
  blackouts?: unknown;
}

function readBlackouts(raw: unknown, league: TeamLeague): string[] | TeamRefusal {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_BLACKOUTS) return teamRefusal("TL_BLACKOUT_DATES", { n: MAX_BLACKOUTS }, 400);
  const dates = [...new Set(raw.map(String))];
  if (dates.some((d) => !isValidDateString(d) || d < league.startsOn || d > league.endsOn)) return teamRefusal("TL_BLACKOUT_DATES", { n: MAX_BLACKOUTS }, 400);
  return dates;
}

/**
 * A team's captain entering it, with the roster picked from its members (each
 * checked against the league's rules, by what they declared) and, where wanted,
 * a home court and the dates the team cannot play. Counted and written under
 * the league's row lock, so of captains entering for the last place at once,
 * one is in. Everybody on the roster is told (a child's guardian, naming
 * the child).
 */
export async function enterTeam(userId: number, leagueId: number, input: EnterTeamInput): Promise<TeamResult<{ leagueTeamId: number }>> {
  try {
    const done = await withTransaction(async (): Promise<TeamResult<{ leagueTeamId: number; members: number[] }>> => {
      const db = getDb();
      await db.prepare("SELECT id FROM team_leagues WHERE id = ? FOR UPDATE").get(leagueId);
      const league = await teamLeagueById(leagueId);
      if (!league) return teamRefusal("TL_NOT_FOUND", {}, 404);
      if (league.status !== "forming") return teamRefusal("TL_CLOSED");
      const today = await zoneToday(league.venueId);
      if (league.entriesCloseOn && today > league.entriesCloseOn) return teamRefusal("TL_ENTRIES_CLOSED", { date: league.entriesCloseOn });
      if (league.teams >= league.maxTeams) return teamRefusal("TL_FULL", { n: league.maxTeams });
      const team = await teamForEntry(userId, input.teamId, league.sport);
      if (!team.ok) return team;
      if (await db.prepare("SELECT 1 FROM team_league_teams WHERE league_id = ? AND team_id = ? AND status = 'entered'").get(leagueId, team.value.id))
        return teamRefusal("TL_ALREADY_IN", { team: team.value.name });
      if (await db.prepare("SELECT 1 FROM team_league_teams WHERE league_id = ? AND status = 'entered' AND lower(name) = lower(?)").get(leagueId, team.value.name))
        return teamRefusal("TL_NAME_TAKEN");
      if (await db.prepare(`${LT_SELECT} WHERE x.league_id = ? AND x.status = 'entered' AND t.captain_user_id = ?`).get(leagueId, userId)) return teamRefusal("TL_CAPTAIN_TWICE");
      const picked = await rosterRefusal(team.value.id, input.memberIds, eventRulesOf(league), today, { min: league.rosterMin, max: league.rosterMax });
      if (!picked.ok) return picked;
      const elsewhere = await rosteredElsewhere(leagueId, null, picked.value.map((p) => p.memberId));
      if (elsewhere) return teamRefusal("TL_MEMBER_ELSEWHERE", { name: elsewhere.name });
      let home: number | null = null;
      if (input.homeCourtId !== undefined && input.homeCourtId !== null && input.homeCourtId !== "") {
        home = Number(input.homeCourtId);
        if (!league.courts.some((c) => c.id === home)) return teamRefusal("TL_COURT", {}, 400);
      }
      const blackouts = readBlackouts(input.blackouts, league);
      if (!Array.isArray(blackouts)) return blackouts;
      const made = (await db
        .prepare("INSERT INTO team_league_teams (league_id, team_id, name, home_court_id, entered_by) VALUES (?, ?, ?, ?, ?) RETURNING id")
        .get(leagueId, team.value.id, team.value.name, home, userId)) as { id: number };
      for (const p of picked.value) await db.prepare("INSERT INTO team_league_roster (league_team_id, team_member_id, name) VALUES (?, ?, ?)").run(made.id, p.memberId, p.name);
      for (const d of blackouts) await db.prepare("INSERT INTO team_league_blackouts (league_team_id, date) VALUES (?, ?)").run(made.id, d);
      return { ok: true, value: { leagueTeamId: made.id, members: picked.value.map((p) => p.memberId) } };
    });
    if (!done.ok) return done;
    const league = (await teamLeagueById(leagueId))!;
    await tellRoster(done.value.members, league.name, league.venueId, `${baseUrl()}/team-leagues/${leagueId}`, "league");
    return { ok: true, value: { leagueTeamId: done.value.leagueTeamId } };
  } catch (err) {
    if (isBusy(err)) return teamRefusal("BUSY", {}, 503);
    throw err;
  }
}

/** The captain changing the league roster of a team that is entered: checked again, one person on one roster. A lineup they were in stands only if they are still on it. */
export async function setLeagueRoster(userId: number, leagueTeamId: number, memberIds: unknown): Promise<TeamResult<null>> {
  return withTransaction(async (): Promise<TeamResult<null>> => {
    const db = getDb();
    const lt = await leagueTeam(leagueTeamId);
    if (!lt || lt.status !== "entered" || lt.captain_user_id !== userId || lt.team_id === null) return teamRefusal("TL_NOT_FOUND", {}, 404);
    await db.prepare("SELECT id FROM team_leagues WHERE id = ? FOR UPDATE").get(lt.league_id);
    const league = (await teamLeagueById(lt.league_id))!;
    if (league.status === "finished" || league.status === "closed") return teamRefusal("TL_SEASON_OVER");
    const picked = await rosterRefusal(lt.team_id, memberIds, eventRulesOf(league), await zoneToday(league.venueId), { min: league.rosterMin, max: league.rosterMax });
    if (!picked.ok) return picked;
    const elsewhere = await rosteredElsewhere(lt.league_id, lt.id, picked.value.map((p) => p.memberId));
    if (elsewhere) return teamRefusal("TL_MEMBER_ELSEWHERE", { name: elsewhere.name });
    const keep = picked.value.map((p) => p.memberId);
    await db.prepare(`DELETE FROM team_league_roster WHERE league_team_id = ? ${keep.length ? `AND team_member_id NOT IN (${keep.map(() => "?").join(",")})` : ""}`).run(lt.id, ...keep);
    const have = new Set(((await db.prepare("SELECT team_member_id FROM team_league_roster WHERE league_team_id = ?").all(lt.id)) as { team_member_id: number }[]).map((r) => r.team_member_id));
    for (const p of picked.value) if (!have.has(p.memberId)) await db.prepare("INSERT INTO team_league_roster (league_team_id, team_member_id, name) VALUES (?, ?, ?)").run(lt.id, p.memberId, p.name);
    // Somebody taken off the roster is out of the lineups still to be played.
    await db
      .prepare(
        `DELETE FROM team_fixture_lineups WHERE fixture_id IN (SELECT id FROM team_fixtures WHERE status = 'scheduled' AND (home_team = ? OR away_team = ?))
           AND team_member_id IS NOT NULL ${keep.length ? `AND team_member_id NOT IN (${keep.map(() => "?").join(",")})` : ""}
           AND team_member_id IN (SELECT team_member_id FROM team_members WHERE team_id = ?)`
      )
      .run(lt.id, lt.id, ...keep, lt.team_id);
    return { ok: true, value: null };
  });
}

/** The captain giving the dates the team cannot play, within the season; the generator keeps its fixtures off them. */
export async function setBlackouts(userId: number, leagueTeamId: number, dates: unknown): Promise<TeamResult<{ clashes: string[] }>> {
  const lt = await leagueTeam(leagueTeamId);
  if (!lt || lt.status !== "entered" || lt.captain_user_id !== userId) return teamRefusal("TL_NOT_FOUND", {}, 404);
  const league = (await teamLeagueById(lt.league_id))!;
  if (league.status === "finished" || league.status === "closed") return teamRefusal("TL_SEASON_OVER");
  const list = readBlackouts(dates, league);
  if (!Array.isArray(list)) return list;
  const db = getDb();
  await withTransaction(async () => {
    await db.prepare("DELETE FROM team_league_blackouts WHERE league_team_id = ?").run(lt.id);
    for (const d of list) await db.prepare("INSERT INTO team_league_blackouts (league_team_id, date) VALUES (?, ?)").run(lt.id, d);
  });
  // Fixtures already made on those dates are the venue's to move: say which.
  const clashes = list.length
    ? (
        (await db
          .prepare(`SELECT DISTINCT date FROM team_fixtures WHERE status = 'scheduled' AND (home_team = ? OR away_team = ?) AND date IN (${list.map(() => "?").join(",")}) ORDER BY date`)
          .all(lt.id, lt.id, ...list)) as { date: string }[]
      ).map((r) => r.date)
    : [];
  return { ok: true, value: { clashes } };
}

/**
 * A team out of a league: by its captain, or the venue's staff. Before the
 * fixtures are made it simply leaves. After, every fixture it has still to
 * play is a forfeit to the other side (their court time goes back) and
 * what was played still counts for the opponents; the opposing captains are told.
 */
export async function withdrawTeam(by: { userId: number } | { adminId: number | null }, leagueTeamId: number): Promise<TeamResult<null>> {
  const freed: { court_id: number; date: string }[] = [];
  const told: { fixtureId: number; other: number; mine: string }[] = [];
  const done = await withTransaction(async (): Promise<TeamResult<null>> => {
    freed.length = 0;
    told.length = 0;
    const db = getDb();
    const lt = await leagueTeam(leagueTeamId);
    if (!lt || lt.status !== "entered") return teamRefusal("TL_NOT_FOUND", {}, 404);
    if ("userId" in by && lt.captain_user_id !== by.userId) return teamRefusal("TL_NOT_FOUND", {}, 404);
    await db.prepare("SELECT id FROM team_leagues WHERE id = ? FOR UPDATE").get(lt.league_id);
    const league = (await teamLeagueById(lt.league_id))!;
    if (league.status === "finished" || league.status === "closed") return teamRefusal("TL_SEASON_OVER");
    await db.prepare("UPDATE team_league_teams SET status = 'withdrawn', withdrawn_at = datetime('now') WHERE id = ?").run(lt.id);
    const open = (await db
      .prepare("SELECT id, home_team, away_team FROM team_fixtures WHERE league_id = ? AND (home_team = ? OR away_team = ?) AND status IN ('scheduled', 'reported', 'disputed')")
      .all(lt.league_id, lt.id, lt.id)) as { id: number; home_team: number; away_team: number }[];
    for (const f of open) {
      freed.push(...((await db.prepare("SELECT DISTINCT court_id, date FROM blocks WHERE team_fixture_id = ? AND date >= ?").all(f.id, todayISO())) as { court_id: number; date: string }[]));
      await forfeitFixture(f.id, lt.id, "adminId" in by ? by.adminId : null);
      told.push({ fixtureId: f.id, other: f.home_team === lt.id ? f.away_team : f.home_team, mine: lt.name });
    }
    await settleLeague(lt.league_id);
    return { ok: true, value: null };
  });
  if (!done.ok) return done;
  await ratingsAfter((await leagueTeam(leagueTeamId))!.league_id);
  for (const d of freed) await offerSlotPlace(d.court_id, d.date);
  for (const t of told) await tellCaptainOf(t.other, (tr) => tr("tm.mail.forfeitWon.s", { team: t.mine }), (tr) => tr("tm.mail.forfeitWon.b", { team: t.mine }));
  return { ok: true, value: null };
}

// ------------------------------------------------------------ fixtures

export interface FixtureRow {
  id: number;
  league_id: number;
  night_id: number | null;
  leg: number;
  round_no: number;
  home_team: number;
  away_team: number;
  court_id: number | null;
  date: string;
  start_min: number;
  minutes: number;
  status: FixtureStatus;
  forfeit_by: number | null;
  reported_by: number | null;
  reported_at: string | null;
  dispute_note: string | null;
  version: number;
}

export async function fixtureRow(id: number, lock = false): Promise<FixtureRow | undefined> {
  return (await getDb().prepare(`SELECT * FROM team_fixtures WHERE id = ?${lock ? " FOR UPDATE" : ""}`).get(id)) as FixtureRow | undefined;
}

/** A fixture's length on court: its games' time. */
export const fixtureMinutes = (league: Pick<TeamLeague, "rubbers" | "rubberMinutes">) => league.rubbers.length * league.rubberMinutes;

/** Hold a fixture's court time as blocks the league owns; whether all of it is held. Nothing is left half held. */
async function holdFixture(league: TeamLeague, fixtureId: number, courtId: number, date: string, startMin: number, minutes: number): Promise<boolean> {
  return withTransaction(async () => {
    const db = getDb();
    const held = await blockSlots(courtId, date, { start: startMin, end: startMin + minutes }, `Team league: ${league.name}`, undefined, { teamLeagueId: league.id, teamFixtureId: fixtureId });
    const covered = held.ok
      ? ((await db
          .prepare("SELECT COALESCE(SUM(LEAST(end_min, ?) - GREATEST(start_min, ?)), 0)::int AS n FROM blocks WHERE team_fixture_id = ? AND court_id = ? AND date = ?")
          .get(startMin + minutes, startMin, fixtureId, courtId, date)) as { n: number }).n
      : 0;
    if (covered >= minutes) return true;
    await db.prepare("DELETE FROM blocks WHERE team_fixture_id = ?").run(fixtureId);
    return false;
  });
}

async function releaseFixtureTime(fixtureId: number): Promise<{ court_id: number; date: string }[]> {
  const db = getDb();
  const days = (await db.prepare("SELECT DISTINCT court_id, date FROM blocks WHERE team_fixture_id = ? AND date >= ?").all(fixtureId, todayISO())) as { court_id: number; date: string }[];
  await db.prepare("DELETE FROM blocks WHERE team_fixture_id = ?").run(fixtureId);
  return days;
}

export interface NightInput {
  date: unknown;
  startMin: unknown;
}

/**
 * Make the fixture list: every team that is entered meeting every other once
 * (or home and away), on the match nights the manager gives. Refused, with
 * nothing changed, if the nights are too few or cannot be used given the dates
 * teams cannot play, or a court is not free for a fixture (the court is
 * changed for another of the league's, or the night's other time, before
 * refusing). It can be made again until a lineup or a result is in. Everybody
 * on every roster is told.
 */
export async function generateFixtures(leagueId: number, nightsInput: unknown): Promise<TeamResult<TeamLeague>> {
  const outcome = await withTransaction(async (): Promise<TeamResult<{ tellings: { leagueTeamId: number; name: string; first: string; n: number }[] }>> => {
    const db = getDb();
    await db.prepare("SELECT id FROM team_leagues WHERE id = ? FOR UPDATE").get(leagueId);
    const league = await teamLeagueById(leagueId);
    if (!league) return teamRefusal("TL_NOT_FOUND", {}, 404);
    if (league.status !== "forming" && league.status !== "scheduled") return teamRefusal("TL_SEASON_OVER");
    const decided = await db
      .prepare("SELECT 1 FROM team_fixtures f WHERE f.league_id = ? AND (f.status <> 'scheduled' OR EXISTS (SELECT 1 FROM team_fixture_lineups l WHERE l.fixture_id = f.id)) LIMIT 1")
      .get(leagueId);
    if (decided) return teamRefusal("TL_RESULTS_IN");
    const teams = (await db.prepare("SELECT id, name, home_court_id FROM team_league_teams WHERE league_id = ? AND status = 'entered' ORDER BY id").all(leagueId)) as {
      id: number;
      name: string;
      home_court_id: number | null;
    }[];
    if (teams.length < 2) return teamRefusal("TL_FEW_TEAMS");
    const today = await zoneToday(league.venueId);
    const raw = Array.isArray(nightsInput) ? (nightsInput as NightInput[]) : [];
    const nights = raw.map((n) => ({ date: String(n?.date ?? ""), startMin: Number(n?.startMin) }));
    const dates = new Set(nights.map((n) => n.date));
    if (
      nights.length === 0 ||
      dates.size !== nights.length ||
      nights.some((n) => !isValidDateString(n.date) || n.date < league.startsOn || n.date > league.endsOn || n.date < today || !Number.isInteger(n.startMin) || n.startMin < 0 || n.startMin > 1439)
    )
      return teamRefusal("TL_NIGHTS", {}, 400);
    nights.sort((a, b) => (a.date < b.date ? -1 : 1));
    const capacity = league.courts.length * league.slotsPerNight;
    const need = fewestNights(teams.length, league.legs, capacity);
    if (nights.length < need) return teamRefusal("TL_NIGHTS_FEW", { n: need });
    const blackouts = new Map<number, Set<string>>();
    for (const t of teams)
      blackouts.set(t.id, new Set(((await db.prepare("SELECT date FROM team_league_blackouts WHERE league_team_id = ?").all(t.id)) as { date: string }[]).map((r) => r.date)));
    const plan = teamRoundRobin(
      teams.map((t) => t.id),
      league.legs
    );
    const placed = placeOnNights(plan.fixtures, nights.map((n) => n.date), { capacity, blackouts });
    const nameOf = new Map(teams.map((t) => [t.id, t.name]));
    if (!placed.ok) {
      const f = placed.unplaced[0];
      return teamRefusal("TL_NO_PLACEMENT", { n: placed.unplaced.length, a: nameOf.get(f.home) ?? "", b: nameOf.get(f.away) ?? "" });
    }
    // Who plays where on each night, worked out before anything is changed: a refusal leaves what was there as it was.
    const minutes = fixtureMinutes(league);
    const homeCourt = new Map(teams.map((t) => [t.id, t.home_court_id]));
    const courtIds = league.courts.map((c) => c.id);
    const courtName = new Map(league.courts.map((c) => [c.id, c.name]));
    const perNight: ReturnType<typeof courtsForNight>[] = [];
    for (let night = 0; night < nights.length; night++) {
      const here = placed.placed.filter((p) => p.night === night).map((p) => p.fixture);
      const assigned = here.length === 0 ? [] : courtsForNight(here, courtIds, league.slotsPerNight, homeCourt);
      if (!assigned) return teamRefusal("TL_NO_PLACEMENT", { n: here.length, a: nameOf.get(here[0].home) ?? "", b: nameOf.get(here[0].away) ?? "" });
      perNight.push(assigned);
    }
    // What was made before goes: its holds with it.
    await db.prepare("DELETE FROM team_fixtures WHERE league_id = ?").run(leagueId);
    await db.prepare("DELETE FROM team_league_nights WHERE league_id = ?").run(leagueId);
    const nightIds: number[] = [];
    for (let i = 0; i < nights.length; i++) {
      const row = (await db
        .prepare("INSERT INTO team_league_nights (league_id, night_no, date, start_min) VALUES (?, ?, ?, ?) RETURNING id")
        .get(leagueId, i + 1, nights[i].date, nights[i].startMin)) as { id: number };
      nightIds.push(row.id);
    }
    const made: { home: number; away: number; date: string }[] = [];
    for (let night = 0; night < nights.length; night++) {
      const assigned = perNight[night]!;
      if (assigned.length === 0) continue;
      // A slot used (taken for a fixture), so another fixture of the night does not land on it.
      const used = new Set(assigned.map((a) => `${a.slot}:${a.court}`));
      for (const a of assigned) {
        const row = (await db
          .prepare(
            `INSERT INTO team_fixtures (league_id, night_id, leg, round_no, home_team, away_team, date, start_min, minutes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
          )
          .get(leagueId, nightIds[night], a.fixture.leg, a.fixture.round, a.fixture.home, a.fixture.away, nights[night].date, nights[night].startMin, minutes)) as { id: number };
        // The planned court and time first; then the night's other courts and times, before giving up on this fixture.
        const candidates: { court: number; slot: number }[] = [{ court: a.court, slot: a.slot }];
        for (let slot = 0; slot < league.slotsPerNight; slot++)
          for (const court of courtIds) if (!used.has(`${slot}:${court}`)) candidates.push({ court, slot });
        let held: { court: number; slot: number } | null = null;
        for (const c of candidates) {
          const start = nights[night].startMin + c.slot * minutes;
          if (await holdFixture(league, row.id, c.court, nights[night].date, start, minutes)) {
            held = c;
            await db.prepare("UPDATE team_fixtures SET court_id = ?, start_min = ? WHERE id = ?").run(c.court, start, row.id);
            used.add(`${c.slot}:${c.court}`);
            break;
          }
        }
        if (!held) {
          // Nothing for a refusal to leave behind: the whole making is undone.
          throw new FixtureRefusal(teamRefusal("TL_NO_COURT", { court: courtName.get(a.court) ?? "", time: `${formatMinute(nights[night].startMin)}–${formatMinute(nights[night].startMin + minutes)}`, date: nights[night].date }));
        }
        for (let i = 0; i < league.rubbers.length; i++)
          await db.prepare("INSERT INTO team_fixture_rubbers (fixture_id, rubber_no, kind) VALUES (?, ?, ?)").run(row.id, i + 1, league.rubbers[i]);
        made.push({ home: a.fixture.home, away: a.fixture.away, date: nights[night].date });
      }
    }
    await db.prepare("UPDATE team_leagues SET status = 'scheduled' WHERE id = ?").run(leagueId);
    const tellings = teams.map((t) => {
      const mine = made.filter((m) => m.home === t.id || m.away === t.id).sort((x, y) => (x.date < y.date ? -1 : 1));
      return { leagueTeamId: t.id, name: t.name, first: mine[0]?.date ?? "", n: mine.length };
    });
    return { ok: true, value: { tellings } };
  }).catch((err) => {
    if (err instanceof FixtureRefusal) return err.refusal;
    throw err;
  });
  if (!outcome.ok) return outcome;
  const league = (await teamLeagueById(leagueId))!;
  for (const t of outcome.value.tellings)
    await tellLeagueTeam(
      t.leagueTeamId,
      (tr) => tr("tm.mail.fixtures.s", { league: league.name }),
      (tr) => tr("tm.mail.fixtures.b", { league: league.name, team: t.name, n: t.n, first: t.first }),
      `${baseUrl()}/team-leagues/${leagueId}`
    );
  return { ok: true, value: league };
}

class FixtureRefusal extends Error {
  constructor(readonly refusal: TeamRefusal) {
    super(refusal.error);
  }
}

export interface MoveInput {
  date: unknown;
  startMin: unknown;
  courtId?: unknown;
}

/**
 * A manager moving a fixture still to play to another court or time: the new
 * time must be free (held for the league first, never over a booking), not in
 * the past, neither team playing another fixture then or on a date it said it
 * cannot. Atomic: it moves and its time is held, or nothing changes. Both
 * captains (and the lineup) are told.
 */
export async function moveFixture(fixtureId: number, to: MoveInput, expected: { version?: number } = {}): Promise<TeamResult<null>> {
  const freed: { court_id: number; date: string }[] = [];
  const done = await withTransaction(async (): Promise<TeamResult<{ leagueId: number }>> => {
    freed.length = 0;
    const db = getDb();
    const first = await fixtureRow(fixtureId);
    if (!first) return teamRefusal("TL_NOT_FOUND", {}, 404);
    await db.prepare("SELECT id FROM team_leagues WHERE id = ? FOR UPDATE").get(first.league_id);
    const f = (await fixtureRow(fixtureId, true))!;
    if (expected.version !== undefined && expected.version !== f.version) return teamRefusal("TL_CHANGED");
    const league = (await teamLeagueById(f.league_id))!;
    if (league.status !== "scheduled") return teamRefusal("TL_SEASON_OVER");
    if (f.status !== "scheduled") return teamRefusal("TL_FIXTURE_DECIDED");
    const date = String(to.date ?? "");
    const startMin = Number(to.startMin);
    const courtId = to.courtId === undefined || to.courtId === null || to.courtId === "" ? (f.court_id ?? league.courts[0].id) : Number(to.courtId);
    if (!isValidDateString(date) || !Number.isInteger(startMin) || startMin < 0 || startMin > 1439 || !league.courts.some((c) => c.id === courtId)) return teamRefusal("TL_NIGHTS", {}, 400);
    const today = await zoneToday(league.venueId);
    if (date < today) return teamRefusal("TL_MOVE_PAST");
    const end = startMin + f.minutes;
    for (const lt of [f.home_team, f.away_team]) {
      const t = (await leagueTeam(lt))!;
      const blacked = await db.prepare("SELECT 1 FROM team_league_blackouts WHERE league_team_id = ? AND date = ?").get(lt, date);
      if (blacked) return teamRefusal("TL_MOVE_BLACKOUT", { team: t.name, date });
      const clash = await db
        .prepare(
          `SELECT 1 FROM team_fixtures WHERE league_id = ? AND id <> ? AND status IN ('scheduled', 'reported', 'confirmed', 'disputed') AND date = ?
              AND (home_team = ? OR away_team = ?) AND start_min < ? AND start_min + minutes > ?`
        )
        .get(f.league_id, f.id, date, lt, lt, end, startMin);
      if (clash) return teamRefusal("TL_MOVE_CLASH", { team: t.name });
    }
    // The old hold goes first, so a move to an overlapping time does not clash with itself; if the new time cannot be held the whole move is undone (FixtureRefusal rolls the transaction back).
    const old = (await db.prepare("SELECT id FROM blocks WHERE team_fixture_id = ?").all(f.id)) as { id: number }[];
    freed.push(...((await db.prepare("SELECT DISTINCT court_id, date FROM blocks WHERE team_fixture_id = ? AND date >= ?").all(f.id, todayISO())) as { court_id: number; date: string }[]));
    if (old.length > 0) await db.prepare(`DELETE FROM blocks WHERE id IN (${old.map(() => "?").join(",")})`).run(...old.map((o) => o.id));
    if (!(await holdFixture(league, f.id, courtId, date, startMin, f.minutes))) {
      // Put back as it was: nothing changes.
      throw new FixtureRefusal(teamRefusal("TL_NO_COURT", { court: league.courts.find((c) => c.id === courtId)?.name ?? "", time: `${formatMinute(startMin)}–${formatMinute(end)}`, date }));
    }
    await db
      .prepare("UPDATE team_fixtures SET court_id = ?, date = ?, start_min = ?, night_id = (SELECT id FROM team_league_nights WHERE league_id = ? AND date = ?), moved_at = datetime('now'), version = version + 1, updated_at = datetime('now') WHERE id = ?")
      .run(courtId, date, startMin, f.league_id, date, f.id);
    return { ok: true, value: { leagueId: f.league_id } };
  }).catch((err) => {
    if (err instanceof FixtureRefusal) return err.refusal;
    throw err;
  });
  if (!done.ok) return done;
  for (const d of freed) await offerSlotPlace(d.court_id, d.date);
  const f = (await fixtureRow(fixtureId))!;
  const league = (await teamLeagueById(done.value.leagueId))!;
  const names = await sidesOf(f);
  const when = `${f.date} ${formatMinute(f.start_min)}`;
  for (const lt of [f.home_team, f.away_team])
    await tellLeagueTeamCaptainAndLineup(
      f,
      lt,
      (tr) => tr("tm.mail.moved.s", { league: league.name }),
      (tr) => tr("tm.mail.moved.b", { league: league.name, a: names.home, b: names.away, when })
    );
  return { ok: true, value: null };
}

async function sidesOf(f: Pick<FixtureRow, "home_team" | "away_team">): Promise<{ home: string; away: string }> {
  return { home: (await leagueTeam(f.home_team))?.name ?? "", away: (await leagueTeam(f.away_team))?.name ?? "" };
}

// ------------------------------------------------------------ lineups

export interface LineupPick {
  rubber: number;
  memberIds: number[];
}

/**
 * Whether a lineup is a lineup: one pick per game, a singles game one player, doubles two different players, the whole-team match its squad, only
 * people on the roster, and nobody in more games than allowed. A ladder of teams checks its challenges' lineups with the same function
 * (lib/team-ladders.ts), so the rule is one.
 */
export function lineupRefusal(
  list: LineupPick[],
  sizes: RubberKind[],
  roster: Map<number, string>,
  limits: { rosterMax: number; maxRubbersPerPlayer: number },
  teamName: string
): TeamRefusal | null {
  const plays = new Map<number, number>();
  for (let i = 0; i < sizes.length; i++) {
    const ids = Array.isArray(list[i]?.memberIds) ? [...new Set(list[i].memberIds.filter((x) => Number.isInteger(x)))] : [];
    if (list[i]?.rubber !== i + 1) return teamRefusal("TL_LINEUP_COUNT", { n: sizes.length }, 400);
    const want = sizes[i] === "singles" ? 1 : sizes[i] === "doubles" ? 2 : 0;
    if ((want > 0 && ids.length !== want) || (want === 0 && (ids.length < 1 || ids.length > limits.rosterMax))) return teamRefusal("TL_LINEUP_SIZE", { n: i + 1, size: want || limits.rosterMax });
    for (const id of ids) {
      if (!roster.has(id)) return teamRefusal("TL_LINEUP_NOT_ROSTER", { team: teamName });
      if (sizes[i] !== "team") plays.set(id, (plays.get(id) ?? 0) + 1);
    }
  }
  for (const [id, n] of plays) if (n > limits.maxRubbersPerPlayer) return teamRefusal("TL_LINEUP_TOO_MANY", { name: roster.get(id) ?? "", n: limits.maxRubbersPerPlayer });
  return null;
}

/**
 * The captain of one side picking who plays each game from the league roster:
 * a singles game one player, doubles two different players, the whole-team
 * match its squad; nobody in more games than the league allows; each still
 * eligible by the league's rules. Until a result is in. Those newly picked are
 * told (a child's guardian, naming the child).
 */
export async function setLineup(userId: number, fixtureId: number, picks: unknown): Promise<TeamResult<null>> {
  const newly: number[] = [];
  const done = await withTransaction(async (): Promise<TeamResult<{ leagueId: number }>> => {
    newly.length = 0;
    const db = getDb();
    const first = await fixtureRow(fixtureId);
    if (!first) return teamRefusal("TL_NOT_FOUND", {}, 404);
    await db.prepare("SELECT id FROM team_leagues WHERE id = ? FOR UPDATE").get(first.league_id);
    const f = (await fixtureRow(fixtureId, true))!;
    const league = (await teamLeagueById(f.league_id))!;
    const mine = await sideOfCaptain(f, userId);
    if (!mine) return teamRefusal("TL_NOT_CAPTAIN", {}, 403);
    if (league.status !== "scheduled") return teamRefusal("TL_SEASON_OVER");
    if (f.status !== "scheduled") return teamRefusal("TL_LINEUP_LOCKED");
    const lt = (await leagueTeam(mine.leagueTeamId))!;
    const list = Array.isArray(picks) ? (picks as LineupPick[]) : [];
    const sizes = league.rubbers;
    if (list.length !== sizes.length) return teamRefusal("TL_LINEUP_COUNT", { n: sizes.length }, 400);
    const roster = new Map(
      ((await db.prepare("SELECT team_member_id, name FROM team_league_roster WHERE league_team_id = ? AND team_member_id IS NOT NULL").all(lt.id)) as { team_member_id: number; name: string }[]).map((r) => [r.team_member_id, r.name])
    );
    const bad = lineupRefusal(list, sizes, roster, league, lt.name);
    if (bad) return bad;
    // Still eligible, by what each declared: the same check as entering.
    const all = [...new Set(list.flatMap((p) => p.memberIds))];
    const eligible = await rosterRefusal(lt.team_id!, all, eventRulesOf(league), await zoneToday(league.venueId), { min: 1, max: 40 });
    if (!eligible.ok) return eligible;
    const before = new Set(((await db.prepare("SELECT team_member_id FROM team_fixture_lineups WHERE fixture_id = ? AND side = ? AND team_member_id IS NOT NULL").all(f.id, mine.side)) as { team_member_id: number }[]).map((r) => r.team_member_id));
    await db.prepare("DELETE FROM team_fixture_lineups WHERE fixture_id = ? AND side = ?").run(f.id, mine.side);
    const junior = new Map(
      ((await db.prepare(`SELECT id, participant_id IS NOT NULL AS junior FROM team_members WHERE id IN (${all.map(() => "?").join(",") || "NULL"})`).all(...all)) as { id: number; junior: boolean }[]).map((r) => [r.id, r.junior])
    );
    for (let i = 0; i < sizes.length; i++)
      for (const id of [...new Set(list[i].memberIds)])
        await db
          .prepare("INSERT INTO team_fixture_lineups (fixture_id, rubber_no, side, team_member_id, name, is_junior) VALUES (?, ?, ?, ?, ?, ?)")
          .run(f.id, i + 1, mine.side, id, roster.get(id) ?? "", junior.get(id) === true);
    for (const id of all) if (!before.has(id)) newly.push(id);
    return { ok: true, value: { leagueId: f.league_id } };
  });
  if (!done.ok) return done;
  const f = (await fixtureRow(fixtureId))!;
  const league = (await teamLeagueById(done.value.leagueId))!;
  const names = await sidesOf(f);
  const when = `${f.date} ${formatMinute(f.start_min)}`;
  for (const id of newly)
    await tellMemberById(
      id,
      league.venueId,
      (tr) => tr("tm.mail.lineup.s", { league: league.name }),
      (tr) => tr("tm.mail.lineup.b", { league: league.name, a: names.home, b: names.away, when }),
      `${baseUrl()}/team-leagues/${league.id}`,
      true
    );
  return { ok: true, value: null };
}

/** Which side this account is the captain of, if either (a person captains one team of a league). */
export async function sideOfCaptain(f: Pick<FixtureRow, "home_team" | "away_team">, userId: number): Promise<{ side: Side; leagueTeamId: number } | null> {
  const home = await leagueTeam(f.home_team);
  if (home?.captain_user_id === userId && home.status === "entered") return { side: "home", leagueTeamId: home.id };
  const away = await leagueTeam(f.away_team);
  if (away?.captain_user_id === userId && away.status === "entered") return { side: "away", leagueTeamId: away.id };
  return null;
}

// ------------------------------------------------------------ results

export interface RubberInput {
  winner?: unknown;
  score?: unknown;
  walkover?: unknown;
}

export interface CheckedRubber {
  winner: Side | null;
  score: string | null;
  walkover: boolean;
}

/**
 * Each game's result, checked by the league's scoring rules (`scoreRefusal`,
 * the same check a tournament's or a box league's score gets): the score is
 * written home side first and must be a score the winner could have won; a
 * level score is a draw only where the rules allow draws; a walkover is a
 * forfeited game, won by the other side with no score.
 */
export function checkRubbers(league: Pick<TeamLeague, "rubbers" | "rules">, given: unknown): CheckedRubber[] | TeamRefusal {
  const list = Array.isArray(given) ? (given as RubberInput[]) : [];
  if (list.length !== league.rubbers.length) return teamRefusal("TL_RUBBER_COUNT", { n: league.rubbers.length }, 400);
  const scoring = league.rules.scoring;
  const out: CheckedRubber[] = [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i] ?? {};
    const winner = r.winner === "home" || r.winner === "away" ? (r.winner as Side) : null;
    const walkover = r.walkover === true;
    if (walkover) {
      if (!winner) return teamRefusal("TL_RUBBER_WINNER", { n: i + 1 }, 400);
      out.push({ winner, score: null, walkover: true });
      continue;
    }
    const score = typeof r.score === "string" ? r.score.trim() : "";
    // A level tally is a draw where the rules allow it: no winner is named.
    if (winner === null) {
      if (!(scoring.kind === "tally" && scoring.draws)) return teamRefusal("TL_RUBBER_WINNER", { n: i + 1 }, 400);
      const why = scoreRefusal(score, null, scoring, { drawAllowed: true });
      if (why) return teamRefusal("TL_RUBBER_SCORE", { n: i + 1, why }, 400);
      out.push({ winner: null, score, walkover: false });
      continue;
    }
    const why = scoreRefusal(score, winner === "home", scoring);
    if (why) return teamRefusal("TL_RUBBER_SCORE", { n: i + 1, why }, 400);
    out.push({ winner, score, walkover: false });
  }
  return out;
}

/**
 * Every game given by walkover to one side is a forfeit in everything but its name: it changes the table as one does. Such a
 * result is not entered by the desk, nor reported by a captain: a manager gives the forfeit (lib/team-forfeits.ts).
 */
export function isWholeFixtureWalkover(rubbers: unknown): boolean {
  if (!Array.isArray(rubbers) || rubbers.length === 0) return false;
  const list = rubbers as RubberInput[];
  const winner = list[0]?.winner;
  return (winner === "home" || winner === "away") && list.every((r) => r?.walkover === true && r.winner === winner);
}

async function writeRubbers(fixtureId: number, rubbers: CheckedRubber[]): Promise<void> {
  const db = getDb();
  for (let i = 0; i < rubbers.length; i++)
    await db
      .prepare("UPDATE team_fixture_rubbers SET score = ?, winner = ?, played = true, walkover = ? WHERE fixture_id = ? AND rubber_no = ?")
      .run(rubbers[i].score, rubbers[i].winner, rubbers[i].walkover, fixtureId, i + 1);
}

async function clearRubbers(fixtureId: number): Promise<void> {
  await getDb().prepare("UPDATE team_fixture_rubbers SET score = NULL, winner = NULL, played = false, walkover = false WHERE fixture_id = ?").run(fixtureId);
}

/** A forfeit: the other side awarded every game, the forfeiting team named. */
async function forfeitFixture(fixtureId: number, forfeitingLeagueTeam: number, adminId: number | null): Promise<void> {
  const db = getDb();
  const f = (await fixtureRow(fixtureId))!;
  const winner: Side = f.home_team === forfeitingLeagueTeam ? "away" : "home";
  await db.prepare("UPDATE team_fixture_rubbers SET score = NULL, winner = ?, played = true, walkover = true WHERE fixture_id = ?").run(winner, fixtureId);
  await db
    .prepare("UPDATE team_fixtures SET status = 'forfeit', forfeit_by = ?, decided_by = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?")
    .run(forfeitingLeagueTeam, adminId, fixtureId);
  await releaseFixtureTime(fixtureId);
}

/** What a fixture's games add up to: games won each, and who won it (or a draw). */
export function fixtureOutcome(rubbers: { winner: Side | null; score: string | null }[], kinds: RubberKind[]): { home: number; away: number; winner: Side | "draw"; score: string | null } {
  const home = rubbers.filter((r) => r.winner === "home").length;
  const away = rubbers.filter((r) => r.winner === "away").length;
  // One match of the whole team: its own score is the fixture's.
  if (kinds.length === 1) return { home, away, winner: home > away ? "home" : away > home ? "away" : "draw", score: rubbers[0]?.score ?? null };
  return { home, away, winner: home > away ? "home" : away > home ? "away" : "draw", score: `${home}-${away}` };
}

/**
 * One fixture's result as a table row: its two teams, who won or that it was
 * drawn, a score for the table to count (games as "3-2", or the one match's
 * own), and whether it was a forfeit.
 */
function tableResult(league: TeamLeague, f: FixtureRow, rubbers: { winner: Side | null; score: string | null }[]): TableResult {
  const o = fixtureOutcome(rubbers, league.rubbers);
  return {
    a: f.home_team,
    b: f.away_team,
    winner: o.winner === "draw" ? null : o.winner === "home" ? f.home_team : f.away_team,
    draw: o.winner === "draw",
    score: f.status === "forfeit" ? null : o.score,
    walkover: f.status === "forfeit",
  };
}

/** The scoring the table is ranked by: the sport's own for one match of the whole team; else games won, by the league's table rules. */
export function tableScoring(league: TeamLeague): Pick<ScoringRules, "kind" | "tablePoints" | "rankBy" | "retired"> & Partial<Pick<ScoringRules, "setPoints" | "bestOf" | "walkover">> {
  if (league.rubbers.length === 1) return league.rules.scoring;
  return {
    kind: "tally",
    bestOf: 1,
    tablePoints: league.table.tablePoints,
    rankBy: league.table.rankBy,
    retired: "win_only",
    setPoints: null,
    // A forfeit counts as every game to the other side.
    walkover: `${league.rubbers.length}-0`,
  };
}

export interface TeamStanding extends Standing {
  name: string;
  leagueTeamId: number;
  withdrawn: boolean;
  position: number;
}

async function loadRubbers(fixtureIds: number[]): Promise<Map<number, { no: number; kind: RubberKind; score: string | null; winner: Side | null; played: boolean; walkover: boolean }[]>> {
  const out = new Map<number, { no: number; kind: RubberKind; score: string | null; winner: Side | null; played: boolean; walkover: boolean }[]>();
  if (fixtureIds.length === 0) return out;
  const rows = (await getDb()
    .prepare(`SELECT fixture_id, rubber_no, kind, score, winner, played, walkover FROM team_fixture_rubbers WHERE fixture_id IN (${fixtureIds.map(() => "?").join(",")}) ORDER BY fixture_id, rubber_no`)
    .all(...fixtureIds)) as { fixture_id: number; rubber_no: number; kind: RubberKind; score: string | null; winner: Side | null; played: boolean; walkover: boolean }[];
  for (const r of rows) {
    const list = out.get(r.fixture_id) ?? [];
    list.push({ no: r.rubber_no, kind: r.kind, score: r.score, winner: r.winner, played: r.played === true, walkover: r.walkover === true });
    out.set(r.fixture_id, list);
  }
  return out;
}

/** The table: confirmed results and forfeits count; a team that withdrew is at the foot, its results still counting for the others. */
async function computeStandings(league: TeamLeague): Promise<TeamStanding[]> {
  const db = getDb();
  const teams = (await db.prepare("SELECT id, name, status FROM team_league_teams WHERE league_id = ? ORDER BY id").all(league.id)) as { id: number; name: string; status: string }[];
  const fixtures = (await db.prepare("SELECT * FROM team_fixtures WHERE league_id = ? AND status IN ('confirmed', 'forfeit')").all(league.id)) as FixtureRow[];
  const rubbers = await loadRubbers(fixtures.map((f) => f.id));
  const table = standings(
    teams.map((t) => t.id),
    fixtures.map((f) => tableResult(league, f, rubbers.get(f.id) ?? [])),
    tableScoring(league)
  );
  const info = new Map(teams.map((t) => [t.id, t]));
  const ordered = [...table.filter((s) => info.get(s.entryId)!.status === "entered"), ...table.filter((s) => info.get(s.entryId)!.status !== "entered")];
  return ordered.map((s, i) => ({ ...s, name: info.get(s.entryId)!.name, leagueTeamId: s.entryId, withdrawn: info.get(s.entryId)!.status !== "entered", position: i + 1 }));
}

/** The league is over when every fixture is decided (and there are fixtures). */
async function settleLeague(leagueId: number): Promise<void> {
  const db = getDb();
  // A forfeit asked for on a fixture now decided any other way is closed (lib/team-forfeits.ts).
  await (await import("./team-forfeits")).closeSettledForfeitRequests(leagueId);
  const left = (await db.prepare("SELECT COUNT(*)::int AS n FROM team_fixtures WHERE league_id = ? AND status IN ('scheduled', 'reported', 'disputed')").get(leagueId)) as { n: number };
  const total = (await db.prepare("SELECT COUNT(*)::int AS n FROM team_fixtures WHERE league_id = ?").get(leagueId)) as { n: number };
  if (left.n === 0 && total.n > 0) await db.prepare("UPDATE team_leagues SET status = 'finished' WHERE id = ? AND status = 'scheduled'").run(leagueId);
}

const changed = () => teamRefusal("TL_CHANGED");

/** After a result changes: read the league into the ratings if it is rated (lib/ratings.ts); never fails the change that caused it. */
export async function ratingsAfter(leagueId: number): Promise<void> {
  await (await import("./ratings")).ratedAfter("team_league", leagueId);
}

/**
 * A captain saying how a fixture went: each game's score and winner, home side
 * first. They can put it right until the other captain answers. On the fixture's
 * locked row, and only if the version is still the one they saw: a report never
 * lands on a result confirmed, disputed or decided meanwhile.
 */
export async function reportFixture(userId: number, fixtureId: number, rubbers: unknown, expected: { version?: number } = {}): Promise<TeamResult<null>> {
  const result = await withTransaction(async (): Promise<TeamResult<{ other: number; mine: string; leagueId: number }>> => {
    const db = getDb();
    const first = await fixtureRow(fixtureId);
    if (!first) return teamRefusal("TL_NOT_FOUND", {}, 404);
    await db.prepare("SELECT id FROM team_leagues WHERE id = ? FOR UPDATE").get(first.league_id);
    const f = (await fixtureRow(fixtureId, true))!;
    const league = (await teamLeagueById(f.league_id))!;
    const me = await sideOfCaptain(f, userId);
    if (!me) return teamRefusal("TL_NOT_CAPTAIN", {}, 403);
    if (league.status !== "scheduled") return teamRefusal("TL_SEASON_OVER");
    if (f.status === "reported" && f.reported_by !== me.leagueTeamId) return teamRefusal("TL_REPORTED_BY_THEM");
    if (f.status === "disputed") return teamRefusal("TL_DISPUTED");
    if (f.status !== "scheduled" && f.status !== "reported") return teamRefusal("TL_SETTLED");
    if (expected.version !== undefined && expected.version !== f.version) return changed();
    if (f.date > (await zoneToday(league.venueId))) return teamRefusal("TL_NOT_YET", { date: f.date });
    // A whole fixture by walkover is a forfeit, and a forfeit is the venue's manager's to give: the captain asks for one.
    if (isWholeFixtureWalkover(rubbers)) return teamRefusal("TL_FR_USE_REQUEST");
    const checked = checkRubbers(league, rubbers);
    if (!Array.isArray(checked)) return checked;
    const wrote = await db
      .prepare(
        `UPDATE team_fixtures SET status = 'reported', reported_by = ?, reported_at = datetime('now'), version = version + 1, updated_at = datetime('now')
          WHERE id = ? AND version = ? AND status IN ('scheduled', 'reported')`
      )
      .run(me.leagueTeamId, f.id, f.version);
    if (wrote.changes !== 1) return changed();
    await writeRubbers(f.id, checked);
    const mine = (await leagueTeam(me.leagueTeamId))!.name;
    return { ok: true, value: { other: me.side === "home" ? f.away_team : f.home_team, mine, leagueId: f.league_id } };
  });
  if (!result.ok) return result;
  const f = (await fixtureRow(fixtureId))!;
  const league = (await teamLeagueById(result.value.leagueId))!;
  const o = fixtureOutcomeOf(league, f.id, await loadRubbers([f.id]));
  await tellCaptainOf(
    result.value.other,
    (tr) => tr("tm.mail.reported.s", { team: result.value.mine }),
    (tr) => sentences(tr, tr("tm.mail.reported.b", { team: result.value.mine, league: league.name, score: o }), tr("tm.mail.reported.ask", { days: CONFIRM_DAYS }))
  );
  return { ok: true, value: null };
}

function fixtureOutcomeOf(league: TeamLeague, fixtureId: number, rubbers: Awaited<ReturnType<typeof loadRubbers>>): string {
  const o = fixtureOutcome(rubbers.get(fixtureId) ?? [], league.rubbers);
  return o.score ?? `${o.home}-${o.away}`;
}

async function answerReport(userId: number, fixtureId: number, to: "confirmed" | "disputed", note: string | null, expected: { version?: number }) {
  return withTransaction(async (): Promise<TeamResult<{ reporter: number; mine: string; leagueId: number; f: FixtureRow }>> => {
    const db = getDb();
    const first = await fixtureRow(fixtureId);
    if (!first) return teamRefusal("TL_NOT_FOUND", {}, 404);
    await db.prepare("SELECT id FROM team_leagues WHERE id = ? FOR UPDATE").get(first.league_id);
    const f = (await fixtureRow(fixtureId, true))!;
    const me = await sideOfCaptain(f, userId);
    if (!me) return teamRefusal("TL_NOT_CAPTAIN", {}, 403);
    if (f.status !== "reported" || f.reported_by === me.leagueTeamId) {
      if (expected.version !== undefined && expected.version !== f.version) return changed();
      return teamRefusal(to === "confirmed" ? "TL_NOTHING_TO_CONFIRM" : "TL_NOTHING_TO_DISPUTE");
    }
    if (expected.version !== undefined && expected.version !== f.version) return changed();
    const wrote = await db
      .prepare(`UPDATE team_fixtures SET status = ?, dispute_note = COALESCE(?, dispute_note), version = version + 1, updated_at = datetime('now') WHERE id = ? AND status = 'reported' AND version = ?`)
      .run(to, note, f.id, f.version);
    if (wrote.changes !== 1) return changed();
    if (to === "confirmed") await settleLeague(f.league_id);
    return { ok: true, value: { reporter: f.reported_by!, mine: (await leagueTeam(me.leagueTeamId))!.name, leagueId: f.league_id, f } };
  });
}

/** The other captain agrees, with the result they saw. */
export async function confirmFixture(userId: number, fixtureId: number, expected: { version?: number } = {}): Promise<TeamResult<null>> {
  const done = await answerReport(userId, fixtureId, "confirmed", null, expected);
  if (!done.ok) return done;
  await ratingsAfter(done.value.leagueId);
  const league = (await teamLeagueById(done.value.leagueId))!;
  await tellCaptainOf(done.value.reporter, (tr) => tr("tm.mail.confirmed.s", { team: done.value.mine }), (tr) => tr("tm.mail.confirmed.b", { team: done.value.mine, league: league.name }));
  return { ok: true, value: null };
}

/** The other captain says it did not go like that, about the result they saw: the venue decides. */
export async function disputeFixture(userId: number, fixtureId: number, note: string, expected: { version?: number } = {}): Promise<TeamResult<null>> {
  const why = String(note ?? "").trim().slice(0, 500);
  if (why.length < 3) {
    const f = await fixtureRow(fixtureId);
    if (!f || !(await sideOfCaptain(f, userId))) return teamRefusal("TL_NOT_CAPTAIN", {}, 403);
    return teamRefusal("TL_SAY_WHAT", {}, 400);
  }
  const done = await answerReport(userId, fixtureId, "disputed", why, expected);
  if (!done.ok) return done;
  const league = (await teamLeagueById(done.value.leagueId))!;
  const names = await sidesOf(done.value.f);
  const rubbers = await loadRubbers([done.value.f.id]);
  await tellVenueStaffEach(league.venueId, (t) => ({
    subject: t("tl.alert.dispute.s", { league: league.name }),
    body: t("tl.alert.dispute.b", { a: names.home, b: names.away, score: fixtureOutcomeOf(league, done.value.f.id, rubbers), who: done.value.mine, why, place: t("sh.tab.leagues"), url: `${baseUrl()}/admin` }),
  }));
  return { ok: true, value: null };
}

export type DecideInput = { rubbers: unknown } | { void: true } | { clear: true } | { forfeitBy: number };

/**
 * Staff deciding a fixture: its games' results (taken as confirmed), a forfeit
 * by one of the teams, striking it, or putting it back to be played (its court
 * time held again, or refused if the court is no longer free). On the fixture's
 * locked row and, where `expected.version` is given, only on the result staff
 * were looking at. Both captains are told what was decided.
 */
export async function decideFixture(fixtureId: number, adminId: number, input: DecideInput, expected: { version?: number } = {}): Promise<TeamResult<null>> {
  const freed: { court_id: number; date: string }[] = [];
  const done = await withTransaction(async (): Promise<TeamResult<{ leagueId: number }>> => {
    freed.length = 0;
    const db = getDb();
    const first = await fixtureRow(fixtureId);
    if (!first) return teamRefusal("TL_NOT_FOUND", {}, 404);
    await db.prepare("SELECT id FROM team_leagues WHERE id = ? FOR UPDATE").get(first.league_id);
    const f = (await fixtureRow(fixtureId, true))!;
    const league = (await teamLeagueById(f.league_id))!;
    if (league.status !== "scheduled" && league.status !== "finished") return teamRefusal("TL_SEASON_OVER");
    if (expected.version !== undefined && expected.version !== f.version) return changed();
    if ("rubbers" in input) {
      const checked = checkRubbers(league, input.rubbers);
      if (!Array.isArray(checked)) return checked;
      await writeRubbers(f.id, checked);
      await db
        .prepare("UPDATE team_fixtures SET status = 'confirmed', forfeit_by = NULL, decided_by = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?")
        .run(adminId, f.id);
    } else if ("forfeitBy" in input) {
      if (input.forfeitBy !== f.home_team && input.forfeitBy !== f.away_team) return teamRefusal("TL_FORFEIT_TEAM", {}, 400);
      freed.push(...((await db.prepare("SELECT DISTINCT court_id, date FROM blocks WHERE team_fixture_id = ? AND date >= ?").all(f.id, todayISO())) as { court_id: number; date: string }[]));
      await forfeitFixture(f.id, input.forfeitBy, adminId);
    } else if ("void" in input) {
      freed.push(...((await db.prepare("SELECT DISTINCT court_id, date FROM blocks WHERE team_fixture_id = ? AND date >= ?").all(f.id, todayISO())) as { court_id: number; date: string }[]));
      await clearRubbers(f.id);
      await db.prepare("UPDATE team_fixtures SET status = 'void', forfeit_by = NULL, reported_by = NULL, reported_at = NULL, decided_by = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?").run(adminId, f.id);
      await releaseFixtureTime(f.id);
    } else {
      // Back to be played: its time is held again if it was let go, and it is refused if the court is no longer free.
      const held = await db.prepare("SELECT 1 FROM blocks WHERE team_fixture_id = ?").get(f.id);
      if (!held && f.court_id !== null && f.date >= (await zoneToday(league.venueId)) && !(await holdFixture(league, f.id, f.court_id, f.date, f.start_min, f.minutes)))
        throw new FixtureRefusal(teamRefusal("TL_NO_COURT", { court: league.courts.find((c) => c.id === f.court_id)?.name ?? "", time: `${formatMinute(f.start_min)}–${formatMinute(f.start_min + f.minutes)}`, date: f.date }));
      await clearRubbers(f.id);
      await db.prepare("UPDATE team_fixtures SET status = 'scheduled', forfeit_by = NULL, reported_by = NULL, reported_at = NULL, dispute_note = NULL, decided_by = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?").run(adminId, f.id);
      await db.prepare("UPDATE team_leagues SET status = 'scheduled' WHERE id = ? AND status = 'finished'").run(f.league_id);
    }
    await settleLeague(f.league_id);
    return { ok: true, value: { leagueId: f.league_id } };
  }).catch((err) => {
    if (err instanceof FixtureRefusal) return err.refusal;
    throw err;
  });
  if (!done.ok) return done;
  await ratingsAfter(done.value.leagueId);
  for (const d of freed) await offerSlotPlace(d.court_id, d.date);
  const f = (await fixtureRow(fixtureId))!;
  const league = (await teamLeagueById(done.value.leagueId))!;
  const names = await sidesOf(f);
  const rubbers = await loadRubbers([f.id]);
  const what =
    f.status === "forfeit"
      ? "tm.mail.decided.forfeit"
      : f.status === "void"
        ? "tm.mail.decided.void"
        : f.status === "scheduled"
          ? "tm.mail.decided.cleared"
          : "tm.mail.decided.result";
  for (const lt of [f.home_team, f.away_team])
    await tellCaptainOf(
      lt,
      (tr) => tr("tm.mail.decided.s", { league: league.name }),
      (tr) =>
        sentences(
          tr,
          tr(what, { league: league.name, a: names.home, b: names.away, score: fixtureOutcomeOf(league, f.id, rubbers), loser: f.forfeit_by === f.home_team ? names.home : names.away }),
          tr("tm.mail.decided.ask")
        )
    );
  return { ok: true, value: null };
}

// ------------------------------------------------------------ telling people

export async function tellCaptainOf(leagueTeamId: number, subject: Written, body: Written): Promise<void> {
  const lt = await leagueTeam(leagueTeamId);
  if (!lt?.captain_user_id) return;
  const league = (await teamLeagueById(lt.league_id))!;
  await emailPlayer({ venueId: league.venueId, userId: lt.captain_user_id, subject, body, link: `${baseUrl()}/team-leagues/${lt.league_id}`, decision: true });
}

/** Everybody on a team's roster in a league (the captain among them; a child's guardian, naming the child). */
async function tellLeagueTeam(leagueTeamId: number, subject: Written, body: Written, link: string): Promise<void> {
  const lt = await leagueTeam(leagueTeamId);
  if (!lt) return;
  const league = (await teamLeagueById(lt.league_id))!;
  const rows = (await getDb().prepare("SELECT team_member_id FROM team_league_roster WHERE league_team_id = ? AND team_member_id IS NOT NULL").all(leagueTeamId)) as { team_member_id: number }[];
  for (const r of rows) await tellMemberById(r.team_member_id, league.venueId, subject, body, link, true);
}

/** The captain, and whoever is in the lineup (if one is set; else the whole roster is not troubled). */
async function tellLeagueTeamCaptainAndLineup(f: FixtureRow, leagueTeamId: number, subject: Written, body: Written): Promise<void> {
  await tellCaptainOf(leagueTeamId, subject, body);
  const side: Side = f.home_team === leagueTeamId ? "home" : "away";
  const league = (await teamLeagueById(f.league_id))!;
  const lt = await leagueTeam(leagueTeamId);
  const rows = (await getDb().prepare("SELECT DISTINCT team_member_id FROM team_fixture_lineups WHERE fixture_id = ? AND side = ? AND team_member_id IS NOT NULL").all(f.id, side)) as { team_member_id: number }[];
  const captainMember = lt?.captain_user_id
    ? ((await getDb().prepare("SELECT id FROM team_members WHERE team_id = ? AND user_id = ? AND status = 'member'").get(lt.team_id ?? 0, lt.captain_user_id)) as { id: number } | undefined)
    : undefined;
  for (const r of rows) if (r.team_member_id !== captainMember?.id) await tellMemberById(r.team_member_id, league.venueId, subject, body, `${baseUrl()}/team-leagues/${f.league_id}`, true);
}

// ------------------------------------------------------------ what people see

export interface FixtureView {
  id: number;
  leg: number;
  round: number;
  nightNo: number | null;
  date: string;
  startMin: number;
  minutes: number;
  courtId: number | null;
  courtName: string | null;
  home: { id: number; name: string };
  away: { id: number; name: string };
  status: FixtureStatus;
  version: number;
  forfeitBy: number | null;
  reportedBy: number | null;
  disputeNote?: string | null;
  /** Games won by each side, and the fixture's winner; null until it is decided. */
  result: { home: number; away: number; winner: Side | "draw"; score: string | null } | null;
  rubbers: { no: number; kind: RubberKind; score: string | null; winner: Side | null; played: boolean; walkover: boolean }[];
  /** Lineups as the viewer may see them: their own team's, staff's, and both once a result is in. Names of juniors only where allowed. */
  lineup?: { rubber: number; side: Side; name: string; junior: boolean; memberId: number | null }[];
  /** For a viewer who captains a side of it. */
  mine?: { side: Side; leagueTeamId: number };
  /** Staff: a team's date it said it cannot play falls on this fixture. */
  blackoutClash?: boolean;
  /** Forfeit requests (lib/team-forfeits.ts): all of them for staff, those on a fixture of a team they captain for a captain. */
  forfeitRequests?: import("./team-forfeits").ForfeitRequestView[];
}

export interface TeamLeagueDetail extends TeamLeague {
  entered: { id: number; name: string; withdrawn: boolean; homeCourtId: number | null; teamId?: number | null; captain?: boolean; blackouts?: string[]; roster?: { memberId: number | null; name: string; junior: boolean }[] }[];
  fixtures: FixtureView[];
  standings: TeamStanding[];
  /** The league teams this viewer captains, or is on (their member ids on the roster). */
  mine?: { leagueTeamId: number; captain: boolean }[];
}

/**
 * A league as this person may see it. Anybody: the teams by name, the
 * fixtures and results, the table, never a player. A member of an entered team:
 * its roster and lineups; a captain: also the dates the team cannot play. Staff
 * of the venue: everything, a child's name included, as for any entry.
 */
export async function teamLeagueDetail(id: number, opts: { viewerId?: number | null; forStaff?: boolean } = {}): Promise<TeamLeagueDetail | null> {
  const league = await teamLeagueById(id);
  if (!league) return null;
  const db = getDb();
  const viewer = opts.viewerId ?? null;
  const teams = (await db.prepare(`${LT_SELECT} WHERE x.league_id = ? ORDER BY x.id`).all(id)) as LeagueTeamRow[];
  const mineRows = viewer === null ? [] : ((await db
    .prepare(
      `SELECT x.id AS league_team_id, (t.captain_user_id = ?) AS captain FROM team_league_teams x JOIN teams t ON t.id = x.team_id
        WHERE x.league_id = ? AND EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = t.id AND m.status = 'member' AND (m.user_id = ? OR m.acting_user_id = ?))`
    )
    .all(viewer, id, viewer, viewer)) as { league_team_id: number; captain: boolean }[]);
  const mine = mineRows.map((r) => ({ leagueTeamId: r.league_team_id, captain: r.captain === true }));
  const mineIds = new Set(mine.map((m) => m.leagueTeamId));
  const fixtures = (await db
    .prepare("SELECT f.*, n.night_no, c.name AS court_name FROM team_fixtures f LEFT JOIN team_league_nights n ON n.id = f.night_id LEFT JOIN courts c ON c.id = f.court_id WHERE f.league_id = ? ORDER BY f.date, f.start_min, f.id")
    .all(id)) as (FixtureRow & { night_no: number | null; court_name: string | null })[];
  const rubbers = await loadRubbers(fixtures.map((f) => f.id));
  const names = new Map(teams.map((t) => [t.id, t.name]));
  const blackouts = new Map<number, Set<string>>();
  if (opts.forStaff)
    for (const t of teams) blackouts.set(t.id, new Set(((await db.prepare("SELECT date FROM team_league_blackouts WHERE league_team_id = ?").all(t.id)) as { date: string }[]).map((r) => r.date)));
  // Who may be named in a lineup: a child only to staff, the captain of their own side, and their own guardian.
  const lineups = (await db
    .prepare(
      `SELECT l.fixture_id, l.rubber_no, l.side, l.name, l.is_junior, l.team_member_id,
              m.acting_user_id, m.user_id
         FROM team_fixture_lineups l LEFT JOIN team_members m ON m.id = l.team_member_id
        WHERE l.fixture_id IN (${fixtures.map((f) => f.id).join(",") || "NULL"}) ORDER BY l.fixture_id, l.rubber_no, l.id`
    )
    .all()) as { fixture_id: number; rubber_no: number; side: Side; name: string; is_junior: boolean; team_member_id: number | null; acting_user_id: number | null; user_id: number | null }[];
  const fixtureViews: FixtureView[] = fixtures.map((f) => {
    const mineSide: FixtureView["mine"] = (() => {
      if (mineIds.has(f.home_team) && mine.find((m) => m.leagueTeamId === f.home_team)?.captain) return { side: "home", leagueTeamId: f.home_team };
      if (mineIds.has(f.away_team) && mine.find((m) => m.leagueTeamId === f.away_team)?.captain) return { side: "away", leagueTeamId: f.away_team };
      return undefined;
    })();
    const playedRubbers = rubbers.get(f.id) ?? [];
    const decided = f.status === "confirmed" || f.status === "forfeit" || f.status === "reported";
    const view: FixtureView = {
      id: f.id,
      leg: f.leg,
      round: f.round_no,
      nightNo: f.night_no,
      date: f.date,
      startMin: f.start_min,
      minutes: f.minutes,
      courtId: f.court_id,
      courtName: f.court_name,
      home: { id: f.home_team, name: names.get(f.home_team) ?? "" },
      away: { id: f.away_team, name: names.get(f.away_team) ?? "" },
      status: f.status,
      version: f.version,
      forfeitBy: f.forfeit_by,
      reportedBy: f.reported_by,
      ...(opts.forStaff || mineSide ? { disputeNote: f.dispute_note } : {}),
      result: decided ? fixtureOutcome(playedRubbers, league.rubbers) : null,
      rubbers: playedRubbers,
      ...(mineSide ? { mine: mineSide } : {}),
      ...(opts.forStaff && ((blackouts.get(f.home_team)?.has(f.date) ?? false) || (blackouts.get(f.away_team)?.has(f.date) ?? false)) && f.status === "scheduled" ? { blackoutClash: true } : {}),
    };
    // Lineups: staff; members of a side see their own; both sides' once a result is reported.
    const seeSide = (side: Side) => opts.forStaff || mineIds.has(side === "home" ? f.home_team : f.away_team) || (decided && mineIds.size > 0 && (mineIds.has(f.home_team) || mineIds.has(f.away_team)));
    const rows = lineups.filter((l) => l.fixture_id === f.id && seeSide(l.side));
    if (rows.length > 0)
      view.lineup = rows.map((l) => {
        const ownSideCaptain = mine.some((m) => m.captain && m.leagueTeamId === (l.side === "home" ? f.home_team : f.away_team));
        const ownGuardian = viewer !== null && l.acting_user_id === viewer;
        // A child is named only to staff, their own side's captain and their own guardian; an adult by first name, staff by the full name.
        const name = l.is_junior ? (opts.forStaff || ownSideCaptain || ownGuardian ? l.name : "") : opts.forStaff ? l.name : firstName(l.name);
        return { rubber: l.rubber_no, side: l.side, name, junior: l.is_junior, memberId: l.team_member_id };
      });
    return view;
  });
  // Forfeit requests: staff see them all, a captain those on their own fixtures.
  const requests = await (await import("./team-forfeits")).forfeitRequestsOfLeague(id, {
    forStaff: opts.forStaff === true,
    viewerId: viewer,
    fixtureIds: new Set(fixtureViews.filter((v) => v.mine !== undefined).map((v) => v.id)),
  });
  for (const v of fixtureViews) if (requests.has(v.id)) v.forfeitRequests = requests.get(v.id);
  const entered: TeamLeagueDetail["entered"] = [];
  for (const t of teams) {
    const own = mine.find((m) => m.leagueTeamId === t.id);
    const row: TeamLeagueDetail["entered"][number] = { id: t.id, name: t.name, withdrawn: t.status !== "entered", homeCourtId: t.home_court_id };
    if (own || opts.forStaff) {
      const roster = (await db
        .prepare(
          `SELECT r.team_member_id, r.name, (m.participant_id IS NOT NULL) AS junior, m.acting_user_id FROM team_league_roster r
             LEFT JOIN team_members m ON m.id = r.team_member_id WHERE r.league_team_id = ? ORDER BY r.id`
        )
        .all(t.id)) as { team_member_id: number | null; name: string; junior: boolean | null; acting_user_id: number | null }[];
      row.roster = roster.map((r) => ({
        memberId: r.team_member_id,
        junior: r.junior === true,
        name: r.junior === true ? (opts.forStaff || own?.captain || r.acting_user_id === viewer ? r.name : "") : opts.forStaff ? r.name : firstName(r.name),
      }));
      row.teamId = t.team_id;
    }
    if (own?.captain) {
      row.captain = true;
      row.blackouts = ((await db.prepare("SELECT date FROM team_league_blackouts WHERE league_team_id = ? ORDER BY date").all(t.id)) as { date: string }[]).map((r) => r.date);
    } else if (opts.forStaff) row.blackouts = [...(blackouts.get(t.id) ?? [])].sort();
    entered.push(row);
  }
  return { ...league, entered, fixtures: fixtureViews, standings: await computeStandings(league), ...(viewer !== null ? { mine } : {}) };
}

export interface LeagueHistory {
  leagueId: number;
  league: string;
  venue: string;
  status: string;
  fixtures: { fixtureId: number; date: string; opponent: string; home: boolean; status: string; score: string | null; won: boolean | null }[];
}

/** A team's league fixtures and how they went, for its members (lib/teams.ts `teamHistory`). */
export async function teamLeagueHistory(teamId: number): Promise<LeagueHistory[]> {
  const db = getDb();
  const entries = (await db
    .prepare(
      `SELECT x.id, x.league_id, l.name, v.name AS venue, l.status FROM team_league_teams x JOIN team_leagues l ON l.id = x.league_id JOIN venues v ON v.id = l.venue_id
        WHERE x.team_id = ? ORDER BY l.starts_on DESC, x.id DESC`
    )
    .all(teamId)) as { id: number; league_id: number; name: string; venue: string; status: string }[];
  const out: LeagueHistory[] = [];
  for (const e of entries) {
    const league = (await teamLeagueById(e.league_id))!;
    const fixtures = (await db.prepare("SELECT * FROM team_fixtures WHERE league_id = ? AND (home_team = ? OR away_team = ?) ORDER BY date, start_min").all(e.league_id, e.id, e.id)) as FixtureRow[];
    const rubbers = await loadRubbers(fixtures.map((f) => f.id));
    const names = new Map(((await db.prepare("SELECT id, name FROM team_league_teams WHERE league_id = ?").all(e.league_id)) as { id: number; name: string }[]).map((r) => [r.id, r.name]));
    out.push({
      leagueId: e.league_id,
      league: e.name,
      venue: e.venue,
      status: e.status,
      fixtures: fixtures.map((f) => {
        const home = f.home_team === e.id;
        const counted = f.status === "confirmed" || f.status === "forfeit";
        const o = counted ? fixtureOutcome(rubbers.get(f.id) ?? [], league.rubbers) : null;
        return {
          fixtureId: f.id,
          date: f.date,
          opponent: names.get(home ? f.away_team : f.home_team) ?? "",
          home,
          status: f.status,
          score: o ? (home ? o.score : (o.score ?? "").split("-").reverse().join("-")) : null,
          won: o === null || o.winner === "draw" ? null : (o.winner === "home") === home,
        };
      }),
    });
  }
  return out;
}

// ------------------------------------------------------------ people leaving, housekeeping

/** A member gone from the team: off the league rosters not yet over, and out of the lineups still to be played. The captain is told if the roster is now short. */
export async function dropFromLeagueRosters(memberId: number, _why: "left" | "removed"): Promise<void> {
  void _why;
  const db = getDb();
  const rows = (await db
    .prepare(
      `SELECT r.id, r.league_team_id, l.name AS league, l.roster_min AS min, x.team_id
         FROM team_league_roster r JOIN team_league_teams x ON x.id = r.league_team_id JOIN team_leagues l ON l.id = x.league_id
        WHERE r.team_member_id = ? AND x.status = 'entered' AND l.status IN ('forming', 'scheduled')`
    )
    .all(memberId)) as { id: number; league_team_id: number; league: string; min: number; team_id: number }[];
  for (const r of rows) {
    await db.prepare("DELETE FROM team_league_roster WHERE id = ?").run(r.id);
    await db
      .prepare("DELETE FROM team_fixture_lineups WHERE team_member_id = ? AND fixture_id IN (SELECT id FROM team_fixtures WHERE status = 'scheduled' AND (home_team = ? OR away_team = ?))")
      .run(memberId, r.league_team_id, r.league_team_id);
    const { n } = (await db.prepare("SELECT COUNT(*)::int AS n FROM team_league_roster WHERE league_team_id = ?").get(r.league_team_id)) as { n: number };
    if (n < r.min)
      await tellCaptainOf(
        r.league_team_id,
        (tr) => tr("tm.mail.short.s", { event: r.league }),
        (tr) => tr("tm.mail.short.b", { event: r.league, n, min: r.min })
      );
  }
}

/** A team with nobody to captain it (its captain's account erased): withdrawn from every league still to be played and every tournament not yet over. */
export async function withdrawTeamFromEvents(teamId: number): Promise<void> {
  const db = getDb();
  const leagues = (await db
    .prepare("SELECT x.id FROM team_league_teams x JOIN team_leagues l ON l.id = x.league_id WHERE x.team_id = ? AND x.status = 'entered' AND l.status IN ('forming', 'scheduled')")
    .all(teamId)) as { id: number }[];
  for (const l of leagues) await withdrawTeam({ adminId: null }, l.id).catch(() => null);
  const entries = (await db
    .prepare(
      `SELECT e.id FROM tournament_entries e JOIN tournaments t ON t.id = e.tournament_id
        WHERE e.team_id = ? AND e.status <> 'withdrawn' AND t.status IN ('open', 'closed', 'drawn')`
    )
    .all(teamId)) as { id: number }[];
  const { withdraw } = await import("./tournaments");
  for (const e of entries) await withdraw(e.id);
  // And the ladders of teams it is on (lib/team-ladders.ts): its open challenges end with no effect and the teams below move up.
  await (await import("./team-ladders")).withdrawTeamFromLadders(teamId);
}

/**
 * The scheduler's daily work for team leagues: a result reported and not
 * answered in three days stands (as a box league's, and a tournament's player
 * reports), told to both captains; and a league whose every fixture is decided
 * is over. Returns how many reports stood.
 */
export async function teamLeagueHousekeeping(): Promise<{ confirmed: number }> {
  const db = getDb();
  const stale = (await db
    .prepare(`SELECT id FROM team_fixtures WHERE status = 'reported' AND reported_at < datetime('now', '-${CONFIRM_DAYS} days')`)
    .all()) as { id: number }[];
  let confirmed = 0;
  for (const s of stale) {
    const ok = await withTransaction(async () => {
      const f = await fixtureRow(s.id, true);
      if (!f || f.status !== "reported") return null;
      await db.prepare("UPDATE team_fixtures SET status = 'confirmed', version = version + 1, updated_at = datetime('now') WHERE id = ? AND status = 'reported'").run(f.id);
      await settleLeague(f.league_id);
      return f;
    });
    if (!ok) continue;
    confirmed++;
    await ratingsAfter(ok.league_id);
    const league = (await teamLeagueById(ok.league_id))!;
    const names = await sidesOf(ok);
    const rubbers = await loadRubbers([ok.id]);
    for (const lt of [ok.home_team, ok.away_team])
      await tellCaptainOf(
        lt,
        (tr) => tr("tm.mail.stood.s", { league: league.name }),
        (tr) => tr("tm.mail.stood.b", { league: league.name, a: names.home, b: names.away, score: fixtureOutcomeOf(league, ok.id, rubbers), days: CONFIRM_DAYS })
      );
  }
  await (await import("./team-forfeits")).expireForfeitRequests();
  return { confirmed };
}
