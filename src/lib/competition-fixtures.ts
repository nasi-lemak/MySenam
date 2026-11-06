import { getDb } from "./db";
import { formatMinute } from "./interval";
import { addDays, todayISO } from "./time";
import { venueHours } from "./store";
import { tellEntry, tournamentById } from "./tournaments";
import { leagueTeam, teamLeagueById } from "./team-leagues";
import { baseUrl, emailPlayer, sentences, type Written } from "./outbox";

/**
 * Competition fixtures on a court that is no longer available, and a tournament nobody drew (ADR 0059; docs/features/tournaments.md#when-a-court-or-the-venue-is-lost-after-the-draw).
 *
 * A court taken out of service or a venue closed for a day gives up the court time a tournament or a team league held, but not the fixtures drawn
 * on it. The booking side cancels, refunds and tells; the competition side used to say nothing. Now, when an outage is made or a day is closed:
 *
 * - staff are **shown** the fixtures it strands (the response lists them; the dashboard's needs-attention panel lists any that still stand on an
 *   unavailable court or day until they are moved or the court is back: `strandedFixtures`, derived, never a second record that can go stale);
 * - the **entrants and captains are told** through the outbox, once per fixture and person (`tellFixturesLost`: the match cannot go ahead where
 *   it is; the venue will rearrange it);
 * - staff have **one action** to postpone the day: `postponeTournamentDay` (lib/tournaments.ts) and `postponeLeagueDay` (lib/team-leagues.ts) move
 *   the day's fixtures to another day by the same checks as moving one fixture, and tell each side.
 *
 * Ladder holds are not here: they have their own notice (lib/ladders.ts `tellLostHolds`).
 */

export type FixtureLoss = "outage" | "closure";

export interface CompetitionFixture {
  kind: "tournament" | "team_league";
  /** The match (`tournament_matches`) or fixture (`team_fixtures`) id. */
  id: number;
  /** The tournament or the team league. */
  ownerId: number;
  name: string;
  venueId: number;
  date: string;
  startMin: number;
  minutes: number;
  courtId: number;
  courtName: string;
  /** Why the court is not available then, where it was asked for (`strandedFixtures`). */
  why?: FixtureLoss;
}

interface Row {
  id: number;
  owner_id: number;
  name: string;
  venue_id: number;
  date: string;
  start_min: number;
  minutes: number;
  court_id: number;
  court_name: string;
}

const toFixture = (kind: CompetitionFixture["kind"], r: Row, why?: FixtureLoss): CompetitionFixture => ({
  kind,
  id: r.id,
  ownerId: r.owner_id,
  name: r.name,
  venueId: r.venue_id,
  date: r.date,
  startMin: r.start_min,
  minutes: Number(r.minutes),
  courtId: r.court_id,
  courtName: r.court_name,
  ...(why ? { why } : {}),
});

const TOURNAMENT_SQL = `SELECT m.id, t.id AS owner_id, t.name, t.venue_id, m.date, m.start_min, COALESCE(m.minutes, t.match_minutes) AS minutes, m.court_id, c.name AS court_name
                          FROM tournament_matches m JOIN tournaments t ON t.id = m.tournament_id JOIN courts c ON c.id = m.court_id
                         WHERE m.status = 'scheduled' AND t.status = 'drawn' AND m.court_id IS NOT NULL AND m.date IS NOT NULL AND m.start_min IS NOT NULL`;
const TEAM_SQL = `SELECT f.id, l.id AS owner_id, l.name, l.venue_id, f.date, f.start_min, f.minutes, f.court_id, c.name AS court_name
                    FROM team_fixtures f JOIN team_leagues l ON l.id = f.league_id JOIN courts c ON c.id = f.court_id
                   WHERE f.status = 'scheduled' AND l.status = 'scheduled' AND f.court_id IS NOT NULL`;

/** A court and every court that shares its floor (an outage closes them too: lib/court-links.ts). */
async function courtsWith(courtId: number): Promise<number[]> {
  const rows = (await getDb()
    .prepare("SELECT DISTINCT cs2.court_id FROM court_spaces cs1 JOIN court_spaces cs2 ON cs2.space_id = cs1.space_id WHERE cs1.court_id = ?")
    .all(courtId)) as { court_id: number }[];
  return [...new Set([courtId, ...rows.map((r) => r.court_id)])];
}

/** The tournament matches and team-league fixtures still to play on this court (and the courts that share its floor) from one day to another (or on). */
export async function fixturesOnCourt(courtId: number, startsOn: string, endsOn: string | null): Promise<CompetitionFixture[]> {
  const from = startsOn < todayISO() ? todayISO() : startsOn;
  const to = endsOn ?? "9999-12-31";
  const courts = await courtsWith(courtId);
  const db = getDb();
  const marks = courts.map(() => "?").join(",");
  const matches = (await db.prepare(`${TOURNAMENT_SQL} AND m.court_id IN (${marks}) AND m.date >= ? AND m.date <= ? ORDER BY m.date, m.start_min, m.id`).all(...courts, from, to)) as Row[];
  const fixtures = (await db.prepare(`${TEAM_SQL} AND f.court_id IN (${marks}) AND f.date >= ? AND f.date <= ? ORDER BY f.date, f.start_min, f.id`).all(...courts, from, to)) as Row[];
  return [...matches.map((r) => toFixture("tournament", r, "outage")), ...fixtures.map((r) => toFixture("team_league", r, "outage"))].sort(
    (a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin
  );
}

/** The tournament matches and team-league fixtures still to play at this venue on a day it has closed. */
export async function fixturesOnVenueDay(venueId: number, date: string): Promise<CompetitionFixture[]> {
  const db = getDb();
  const matches = (await db.prepare(`${TOURNAMENT_SQL} AND t.venue_id = ? AND m.date = ? ORDER BY m.start_min, m.id`).all(venueId, date)) as Row[];
  const fixtures = (await db.prepare(`${TEAM_SQL} AND l.venue_id = ? AND f.date = ? ORDER BY f.start_min, f.id`).all(venueId, date)) as Row[];
  return [...matches.map((r) => toFixture("tournament", r, "closure")), ...fixtures.map((r) => toFixture("team_league", r, "closure"))].sort((a, b) => a.startMin - b.startMin);
}

/** A court out of service on a day: the court itself, or one that shares its floor. */
const OUT_OF_SERVICE = (court: string, date: string) => `EXISTS (
  SELECT 1 FROM court_outages o
   WHERE o.starts_on <= ${date} AND (o.ends_on IS NULL OR o.ends_on >= ${date})
     AND (o.court_id = ${court} OR o.court_id IN (SELECT cs2.court_id FROM court_spaces cs1 JOIN court_spaces cs2 ON cs2.space_id = cs1.space_id WHERE cs1.court_id = ${court})))`;
const CLOSED = (venue: string, date: string) => `EXISTS (SELECT 1 FROM venue_closures vc WHERE vc.venue_id = ${venue} AND vc.date = ${date})`;

/**
 * Fixtures still to play, from today, on a court that is out of service that day or at a venue closed that day, at these venues (every venue where
 * null): what staff must move or postpone. Derived from the outages and closures as they stand, so a court back in service, or a fixture moved, leaves the list.
 */
export async function strandedFixtures(venueIds: number[] | null): Promise<CompetitionFixture[]> {
  if (venueIds && venueIds.length === 0) return [];
  const db = getDb();
  const today = addDays(todayISO("UTC"), -1);
  const only = (column: string) => (venueIds ? ` AND ${column} IN (${venueIds.map(() => "?").join(",")})` : "");
  const args = venueIds ?? [];
  const out: CompetitionFixture[] = [];
  const fetch = async (kind: CompetitionFixture["kind"], sql: string, date: string, court: string, venue: string, venueColumn: string) => {
    const rows = (await db
      .prepare(`${sql} AND ${date} >= ?${only(venueColumn)} AND (${OUT_OF_SERVICE(court, date)} OR ${CLOSED(venue, date)}) ORDER BY ${date}, ${kind === "tournament" ? "m.start_min" : "f.start_min"}`)
      .all(today, ...args)) as (Row & { gone: boolean })[];
    for (const r of rows) {
      const courts = await courtsWith(r.court_id);
      const outage = (await db
        .prepare(`SELECT 1 FROM court_outages o WHERE o.starts_on <= ? AND (o.ends_on IS NULL OR o.ends_on >= ?) AND o.court_id IN (${courts.map(() => "?").join(",")}) LIMIT 1`)
        .get(r.date, r.date, ...courts)) as unknown;
      out.push(toFixture(kind, r, outage ? "outage" : "closure"));
    }
  };
  await fetch("tournament", TOURNAMENT_SQL, "m.date", "m.court_id", "t.venue_id", "t.venue_id");
  await fetch("team_league", TEAM_SQL, "f.date", "f.court_id", "l.venue_id", "l.venue_id");
  // A fixture is today's or later in the venue's own day: one gone by in its zone is not stranded.
  const zones = new Map<number, string>();
  const live: CompetitionFixture[] = [];
  for (const f of out) {
    if (!zones.has(f.venueId)) zones.set(f.venueId, (await venueHours(f.venueId)).zone);
    if (f.date >= todayISO(zones.get(f.venueId)!)) live.push(f);
  }
  return live.sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin);
}

/**
 * The people in these fixtures are told, once each (the notice is keyed by the fixture's place and time and the person, so a repeat, a second
 * outage over the same day or a closure as well tells nobody twice): a tournament's two sides, a team league's captains. The match cannot go ahead
 * where it is; the venue will rearrange it. Nothing says what else happened.
 */
export async function tellFixturesLost(fixtures: CompetitionFixture[], why: FixtureLoss): Promise<void> {
  for (const f of fixtures) {
    const place = `${f.date}:${f.startMin}:${f.courtId}`;
    const reason = (tr: Parameters<Written>[0]) => tr(why === "outage" ? "fx10.lost.why.outage" : "fx10.lost.why.closure");
    if (f.kind === "tournament") {
      const t = await tournamentById(f.ownerId);
      const sides = (await getDb().prepare("SELECT entry_a, entry_b FROM tournament_matches WHERE id = ?").get(f.id)) as { entry_a: number | null; entry_b: number | null } | undefined;
      if (!t || !sides) continue;
      for (const entryId of [sides.entry_a, sides.entry_b])
        if (entryId !== null)
          await tellEntry(
            entryId,
            t,
            (tr) => tr("fx10.lost.s", { t: t.name }),
            (tr) => tr("fx10.lost.b", { t: t.name, date: f.date, time: formatMinute(f.startMin, tr.locale), court: f.courtName, why: reason(tr) }),
            `fixture-lost:t${f.id}:${place}:${entryId}`
          );
      continue;
    }
    const league = await teamLeagueById(f.ownerId);
    const fx = (await getDb().prepare("SELECT home_team, away_team FROM team_fixtures WHERE id = ?").get(f.id)) as { home_team: number; away_team: number } | undefined;
    if (!league || !fx) continue;
    for (const side of [fx.home_team, fx.away_team]) {
      const lt = await leagueTeam(side);
      if (!lt?.captain_user_id) continue;
      await emailPlayer({
        venueId: league.venueId,
        userId: lt.captain_user_id,
        subject: (tr) => tr("fx10.lost.s", { t: league.name }),
        body: (tr) => sentences(tr, tr("fx10.lost.b", { t: league.name, date: f.date, time: formatMinute(f.startMin, tr.locale), court: f.courtName, why: reason(tr) })),
        link: `${baseUrl()}/team-leagues/${league.id}`,
        decision: true,
        dedupeKey: `fixture-lost:l${f.id}:${place}:${side}`,
      });
    }
  }
}

// ------------------------------------------------------------ a tournament nobody drew

export interface UndrawnTournament {
  id: number;
  name: string;
  venueId: number;
  startsOn: string;
  endsOn: string;
  status: "open" | "closed";
  entered: number;
  /** The court time still held for it, by court and day. */
  held: { courtName: string; date: string; startMin: number; endMin: number }[];
}

/**
 * Tournaments at these venues whose first day has arrived (in the venue's day) and that nobody has drawn, called off or finished: what staff must
 * draw or call off. The court time held for each is listed, so it is not forgotten. Derived, so a draw or a cancellation clears it.
 */
export async function undrawnTournaments(venueIds: number[] | null): Promise<UndrawnTournament[]> {
  if (venueIds && venueIds.length === 0) return [];
  const db = getDb();
  const rows = (await db
    .prepare(
      `SELECT t.id, t.name, t.venue_id, t.starts_on, t.ends_on, t.status,
              (SELECT COUNT(*)::int FROM tournament_entries e WHERE e.tournament_id = t.id AND e.status = 'entered') AS entered
         FROM tournaments t WHERE t.status IN ('open', 'closed') AND t.starts_on <= ?${venueIds ? ` AND t.venue_id IN (${venueIds.map(() => "?").join(",")})` : ""}
        ORDER BY t.starts_on, t.id`
    )
    .all(addDays(todayISO("UTC"), 1), ...(venueIds ?? []))) as { id: number; name: string; venue_id: number; starts_on: string; ends_on: string; status: "open" | "closed"; entered: number }[];
  const out: UndrawnTournament[] = [];
  for (const r of rows) {
    if (r.starts_on > todayISO((await venueHours(r.venue_id)).zone)) continue;
    const held = (await db
      .prepare("SELECT c.name AS court_name, b.date, b.start_min, b.end_min FROM blocks b JOIN courts c ON c.id = b.court_id WHERE b.tournament_id = ? ORDER BY b.date, b.start_min, c.name")
      .all(r.id)) as { court_name: string; date: string; start_min: number; end_min: number }[];
    out.push({
      id: r.id,
      name: r.name,
      venueId: r.venue_id,
      startsOn: r.starts_on,
      endsOn: r.ends_on,
      status: r.status,
      entered: r.entered,
      held: held.map((h) => ({ courtName: h.court_name, date: h.date, startMin: h.start_min, endMin: h.end_min })),
    });
  }
  return out;
}
