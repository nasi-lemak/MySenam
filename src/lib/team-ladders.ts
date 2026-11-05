import { flipScore } from "./brackets";
import { categoryOfWho, entrantVenueRefusal, selfEntrant } from "./competition-entrants";
import type { RubberKind } from "./competition-templates";
import { getDb } from "./db";
import {
  addEvent,
  fmtMin,
  ladderRefusal,
  leave,
  lockedChallenge,
  playersOf,
  settle,
  tellPlayer,
  venueToday,
  withLadder,
  challengeFor,
  type ChallengeRow,
  type Ladder,
  type LadderRefusal,
  type LadderResult,
} from "./ladders";
import { OPEN_TO_CUSTOMERS } from "./listing";
import { sentences } from "./outbox";
import { checkRubbers, fixtureOutcome, isWholeFixtureWalkover, lineupRefusal, type CheckedRubber, type LineupPick, type Side } from "./team-leagues";
import { rosterRefusal, teamForEntry, teamRefusal, tellMemberById, type EventRules, type TeamRefusal } from "./teams";
import { baseUrl } from "./outbox";

/**
 * Persistent teams on ladders (ADR 0040, docs/features/tournaments.md#team-ladders; migration 0283).
 *
 * A **ladder of teams** is a club ladder (lib/ladders.ts) whose places are persistent teams (lib/teams.ts) instead of players: a team has one
 * place, enters at the bottom through its **captain** (who acts for it from then on, whoever the captain is now), and challenges a team
 * within reach above. Everything about the ladder itself is the ladder's own: the ledger, the rank rule, reach, freezes, drops, seasons, the
 * replay. What is different is the match:
 *
 *  - a team match is **made of games from the sport's template** (a team league's rubbers: singles, doubles, or one whole-team match);
 *  - each game is checked by the same rules as a team league's (`checkRubbers` in lib/team-leagues.ts: `scoreRefusal` and the walkover and draw
 *    rules) and the match's winner is what the team league's `fixtureOutcome` says: the side that won more games. Nothing here scores a match.
 *    A match has to have a winner, so a ladder's games are an odd number (or the one whole-team match) and a drawn match is refused;
 *  - each captain names the **lineup** from the team's members (one lineup function for leagues and ladders: `lineupRefusal`), each member
 *    still eligible by the ladder's category, by what they declared. A child is shown only to staff, the captain of their own side and their
 *    own guardian; never public;
 *  - one captain reports the games and the other confirms, or says it is wrong and staff decide (the ladder's own `confirm`, `dispute`,
 *    `decide`); a report nobody answers stands after three days;
 *  - a **forfeit is a manager's** to give, as in a team league (lib/team-forfeits.ts): a captain or a member of staff asks, a manager decides.
 *    So on a ladder of teams a challenge nobody answers lapses with no effect, instead of being forfeited by the scheduler, and declining is free.
 */

const asLadder = (r: TeamRefusal): LadderRefusal => ({ ...r, status: r.status ?? 409 });

const eventRulesOf = (ladder: Ladder, today: string): EventRules => ({
  venueId: ladder.venueId,
  name: ladder.name,
  sport: ladder.sport,
  category: categoryOfWho(ladder.who),
  ageRange: null,
  startsOn: today,
  membersOnly: false,
});

// ------------------------------------------------------------ entering and leaving

/**
 * A team's captain puts the team on a ladder of teams, at the bottom: the team's own sport, a captain with the team active, a place
 * for the team once (and for the captain once), its name not already on the ladder, and enough members still eligible by the ladder's
 * category, each by what they declared. The name it is entered under is the name the captain gave the team, shown on the ladder.
 */
export async function joinTeam(user: { id: number; name: string }, ladderId: number, teamId: unknown): Promise<LadderResult<{ playerId: number }>> {
  return withLadder(ladderId, async (ladder, season) => {
    const db = getDb();
    if (ladder.kind !== "teams" || !ladder.team) return ladderRefusal("LAD2_NOT_TEAMS", {}, 400);
    if (ladder.status !== "open") return ladderRefusal("LD_CLOSED");
    const open = (await db.prepare(`SELECT (${OPEN_TO_CUSTOMERS}) AS open FROM venues v WHERE v.id = ?`).get(ladder.venueId)) as { open: boolean };
    if (!open.open) return ladderRefusal("LD_VENUE_CLOSED");
    const today = await venueToday(ladder.venueId);
    const notHere = await entrantVenueRefusal(ladder.venueId, selfEntrant(user), today);
    if (notHere) return { ...notHere, ok: false, status: notHere.status ?? 403 } as LadderRefusal;
    const team = await teamForEntry(user.id, teamId, ladder.sport);
    if (!team.ok) return asLadder(team);
    if (await db.prepare("SELECT 1 FROM ladder_players WHERE ladder_id = ? AND team_id = ? AND status = 'active'").get(ladderId, team.value.id)) return ladderRefusal("LD_ALREADY_IN", { name: team.value.name });
    if (await db.prepare("SELECT 1 FROM ladder_players WHERE ladder_id = ? AND status = 'active' AND lower(name) = lower(?)").get(ladderId, team.value.name)) return ladderRefusal("LAD2_NAME_TAKEN", { name: team.value.name });
    // A captain acts for one place on a ladder (an account on both sides of a challenge could answer for neither).
    if (await db.prepare("SELECT 1 FROM ladder_players lp JOIN teams t ON t.id = lp.team_id WHERE lp.ladder_id = ? AND lp.status = 'active' AND t.captain_user_id = ?").get(ladderId, user.id))
      return ladderRefusal("LAD2_CAPTAIN_TWICE");
    const members = (await db.prepare("SELECT id FROM team_members WHERE team_id = ? AND status = 'member'").all(team.value.id)) as { id: number }[];
    const rules = eventRulesOf(ladder, today);
    let eligible = 0;
    for (const m of members) if ((await rosterRefusal(team.value.id, [m.id], rules, today, { min: 1, max: 1 })).ok) eligible++;
    if (eligible < ladder.team.rosterMin) return ladderRefusal("LAD2_TEAM_SHORT", { n: eligible, min: ladder.team.rosterMin });
    const made = (await db
      .prepare("INSERT INTO ladder_players (ladder_id, user_id, team_id, name, entered_by_name) VALUES (?, NULL, ?, ?, NULL) RETURNING id")
      .get(ladderId, team.value.id, team.value.name.slice(0, 130))) as { id: number };
    await addEvent(ladderId, season.id, "join", made.id, null, today, {});
    const ranks = await settle(season.id);
    await tellPlayer(
      made.id,
      ladder,
      (tr) => tr("ld.mail.joined.s", { l: ladder.name }),
      (tr) => tr("ld.mail.joined.b", { l: ladder.name, venue: ladder.venueName, rank: ranks.find((r) => r.playerId === made.id)!.rank })
    );
    return { ok: true, value: { playerId: made.id } };
  });
}

// ------------------------------------------------------------ the lineup

interface MemberName {
  id: number;
  name: string;
  junior: boolean;
}

async function membersOf(teamId: number): Promise<MemberName[]> {
  return (await getDb()
    .prepare(
      `SELECT m.id, COALESCE(p.display_name, u.name) AS name, (m.participant_id IS NOT NULL) AS junior
         FROM team_members m LEFT JOIN users u ON u.id = m.user_id LEFT JOIN participants p ON p.id = m.participant_id
        WHERE m.team_id = ? AND m.status = 'member' ORDER BY m.id`
    )
    .all(teamId)) as MemberName[];
}

/** The place's own team (the place this account acts for), if it still has one. */
async function teamOfPlace(playerId: number): Promise<{ teamId: number; name: string } | null> {
  const row = (await getDb().prepare("SELECT team_id, name FROM ladder_players WHERE id = ?").get(playerId)) as { team_id: number | null; name: string } | undefined;
  return row?.team_id ? { teamId: row.team_id, name: row.name } : null;
}

/**
 * A captain naming who plays each game from the team's members, until a result is in: the same checks as a team league's (a singles game one
 * player, doubles two, the whole-team match its squad; nobody in more games than the ladder allows; only members of the team) and each still
 * eligible by what they declared. Those newly picked are told (a child's guardian, naming the child).
 */
export async function setTeamLineup(userId: number, challengeId: number, picks: unknown): Promise<LadderResult<null>> {
  const found = await challengeFor(userId, challengeId);
  if (!found) return ladderRefusal("LD_NO_CHALLENGE", {}, 404);
  const newly: number[] = [];
  const done = await withLadder(found.ch.ladder_id, async (ladder, season) => {
    newly.length = 0;
    const db = getDb();
    const ch = await lockedChallenge(challengeId);
    if (!ch || ch.season_id !== season.id) return ladderRefusal("LD_NO_CHALLENGE", {}, 404);
    if (ladder.kind !== "teams" || !ladder.team) return ladderRefusal("LAD2_NOT_TEAMS", {}, 400);
    if (ch.status !== "accepted") return ladderRefusal("LAD2_LINEUP_LOCKED");
    const side: Side = found.myId === ch.challenger ? "home" : "away";
    const mine = await teamOfPlace(found.myId);
    if (!mine) return ladderRefusal("LD_NOT_YOURS", {}, 403);
    const list = Array.isArray(picks) ? (picks as LineupPick[]) : [];
    const sizes = ladder.team.rubbers;
    if (list.length !== sizes.length) return asLadder(teamRefusal("TL_LINEUP_COUNT", { n: sizes.length }, 400));
    const members = await membersOf(mine.teamId);
    const roster = new Map(members.map((m) => [m.id, m.name]));
    const bad = lineupRefusal(list, sizes, roster, ladder.team, mine.name);
    if (bad) return asLadder(bad);
    const all = [...new Set(list.flatMap((p) => p.memberIds))];
    const today = await venueToday(ladder.venueId);
    const eligible = await rosterRefusal(mine.teamId, all, eventRulesOf(ladder, today), today, { min: 1, max: 40 });
    if (!eligible.ok) return asLadder(eligible);
    const before = new Set(((await db.prepare("SELECT team_member_id FROM ladder_challenge_lineups WHERE challenge_id = ? AND side = ? AND team_member_id IS NOT NULL").all(ch.id, side)) as { team_member_id: number }[]).map((r) => r.team_member_id));
    await db.prepare("DELETE FROM ladder_challenge_lineups WHERE challenge_id = ? AND side = ?").run(ch.id, side);
    const junior = new Map(members.map((m) => [m.id, m.junior === true]));
    for (let i = 0; i < sizes.length; i++)
      for (const id of [...new Set(list[i].memberIds)])
        await db.prepare("INSERT INTO ladder_challenge_lineups (challenge_id, rubber_no, side, team_member_id, name, is_junior) VALUES (?, ?, ?, ?, ?, ?)").run(ch.id, i + 1, side, id, roster.get(id) ?? "", junior.get(id) === true);
    for (const id of all) if (!before.has(id)) newly.push(id);
    return { ok: true, value: null };
  });
  if (!done.ok) return done;
  const ch = (await getDb().prepare("SELECT * FROM ladder_challenges WHERE id = ?").get(challengeId)) as ChallengeRow;
  const people = await playersOf(ch.ladder_id);
  const ladder = (await getDb().prepare("SELECT id, venue_id, name FROM ladders WHERE id = ?").get(ch.ladder_id)) as { id: number; venue_id: number; name: string };
  const when = ch.agreed_on ? `${ch.agreed_on}${ch.agreed_min === null ? "" : ` ${fmtMin(ch.agreed_min)}`}` : "";
  for (const id of newly)
    await tellMemberById(
      id,
      ladder.venue_id,
      (tr) => tr("lad2.mail.lineup.s", { l: ladder.name }),
      (tr) => sentences(tr, tr("lad2.mail.lineup.b", { l: ladder.name, a: people.get(ch.challenger)?.name ?? "", b: people.get(ch.challenged)?.name ?? "" }), when && tr("lad2.mail.lineup.when", { when })),
      `${baseUrl()}/ladders/${ladder.id}`,
      true
    );
  return { ok: true, value: null };
}

// ------------------------------------------------------------ the games and who played them

export interface TeamChallengeView {
  /** The kinds of the games in order, and which side the viewer is (the challenger's is `home`). */
  kinds: RubberKind[];
  mySide: Side | null;
  rubbers: { no: number; kind: RubberKind; score: string | null; winner: Side | null; played: boolean; walkover: boolean }[];
  /** Lineups as the viewer may see them: staff's, the viewer's own side's, and both once a result is in. A child's name only to staff and their own captain. */
  lineup: { rubber: number; side: Side; name: string; junior: boolean; memberId: number | null }[];
  /** For the captain of a side: their own team's members, to name a lineup from (a child by name: this captain's own side). */
  roster?: { id: number; name: string; junior: boolean }[];
}

const firstWord = (name: string) => name.trim().split(/\s+/)[0] ?? name;
const DECIDED = new Set(["reported", "disputed", "confirmed", "walkover"]);

/** The games and lineups of these challenges for staff, or for the account that captains one of the sides. */
export async function teamViews(ladder: Ladder, challengeIds: number[], viewer: { staff: true } | { userId: number }): Promise<Map<number, TeamChallengeView>> {
  const out = new Map<number, TeamChallengeView>();
  if (ladder.kind !== "teams" || !ladder.team || challengeIds.length === 0) return out;
  const db = getDb();
  const marks = challengeIds.map(() => "?").join(",");
  const challenges = (await db
    .prepare(
      `SELECT c.id, c.status, t1.captain_user_id AS home_captain, t2.captain_user_id AS away_captain, p1.team_id AS home_team, p2.team_id AS away_team
         FROM ladder_challenges c
         JOIN ladder_players p1 ON p1.id = c.challenger LEFT JOIN teams t1 ON t1.id = p1.team_id
         JOIN ladder_players p2 ON p2.id = c.challenged LEFT JOIN teams t2 ON t2.id = p2.team_id
        WHERE c.id IN (${marks})`
    )
    .all(...challengeIds)) as { id: number; status: string; home_captain: number | null; away_captain: number | null; home_team: number | null; away_team: number | null }[];
  const rubbers = (await db
    .prepare(`SELECT challenge_id, rubber_no, kind, score, winner, played, walkover FROM ladder_challenge_rubbers WHERE challenge_id IN (${marks}) ORDER BY challenge_id, rubber_no`)
    .all(...challengeIds)) as { challenge_id: number; rubber_no: number; kind: RubberKind; score: string | null; winner: Side | null; played: boolean; walkover: boolean }[];
  const lineups = (await db
    .prepare(`SELECT challenge_id, rubber_no, side, name, is_junior, team_member_id FROM ladder_challenge_lineups WHERE challenge_id IN (${marks}) ORDER BY challenge_id, rubber_no, id`)
    .all(...challengeIds)) as { challenge_id: number; rubber_no: number; side: Side; name: string; is_junior: boolean; team_member_id: number | null }[];
  for (const c of challenges) {
    const staff = "staff" in viewer;
    const mySide: Side | null = staff ? null : c.home_captain === viewer.userId ? "home" : c.away_captain === viewer.userId ? "away" : null;
    if (!staff && mySide === null) continue;
    const decided = DECIDED.has(c.status);
    const ownTeam = mySide === "home" ? c.home_team : mySide === "away" ? c.away_team : null;
    out.set(c.id, {
      ...(ownTeam !== null ? { roster: await membersOf(ownTeam) } : {}),
      kinds: ladder.team.rubbers,
      mySide,
      rubbers: rubbers
        .filter((r) => r.challenge_id === c.id)
        .map((r) => ({ no: r.rubber_no, kind: r.kind, score: r.score, winner: r.winner, played: r.played === true, walkover: r.walkover === true })),
      lineup: lineups
        .filter((l) => l.challenge_id === c.id && (staff || l.side === mySide || decided))
        .map((l) => {
          const own = staff || l.side === mySide;
          // A child is named to staff and the captain of their own side; to everybody else a child is not named at all.
          const name = l.is_junior === true ? (own ? l.name : "") : own ? l.name : firstWord(l.name);
          return { rubber: l.rubber_no, side: l.side, name, junior: l.is_junior === true, memberId: own ? l.team_member_id : null };
        }),
    });
  }
  return out;
}

// ------------------------------------------------------------ reporting

/** The games checked by the team league's rules, and what they add up to: the winning place and the score kept with the challenge (the challenger's games first). */
export interface TeamOutcome {
  winner: number;
  score: string | null;
  walkover: boolean;
  checked: CheckedRubber[];
}

export function teamOutcome(ladder: Ladder, ch: Pick<ChallengeRow, "challenger" | "challenged">, given: unknown): LadderResult<TeamOutcome> {
  if (ladder.kind !== "teams" || !ladder.team) return ladderRefusal("LAD2_NOT_TEAMS", {}, 400);
  const checked = checkRubbers({ rubbers: ladder.team.rubbers, rules: ladder.rules }, given);
  if (!Array.isArray(checked)) return asLadder(checked);
  const o = fixtureOutcome(checked, ladder.team.rubbers);
  // A ladder match has a winner.
  if (o.winner === "draw") return ladderRefusal("LAD2_DRAW", {}, 400);
  return { ok: true, value: { winner: o.winner === "home" ? ch.challenger : ch.challenged, score: o.score, walkover: isWholeFixtureWalkover(given), checked } };
}

export async function writeRubbers(challengeId: number, kinds: RubberKind[], checked: CheckedRubber[]): Promise<void> {
  const db = getDb();
  await db.prepare("DELETE FROM ladder_challenge_rubbers WHERE challenge_id = ?").run(challengeId);
  for (let i = 0; i < checked.length; i++)
    await db
      .prepare("INSERT INTO ladder_challenge_rubbers (challenge_id, rubber_no, kind, score, winner, played, walkover) VALUES (?, ?, ?, ?, ?, true, ?)")
      .run(challengeId, i + 1, kinds[i], checked[i].score, checked[i].winner, checked[i].walkover);
}

/**
 * Either captain saying how a team match went: each game's score and winner, the challenger's side first (the team league's order: `home`
 * is the challenger). They can put it right until the other captain answers; the other confirms (`confirm`) or disputes (`dispute`) as on any
 * ladder, and staff decide a dispute. Every game is checked by the team league's rules, and a match has to have a winner. A whole match given by
 * walkover is a forfeit, and a forfeit is a manager's: the captain asks for one.
 */
export async function reportTeamResult(userId: number, challengeId: number, rubbers: unknown, expected: { version?: number } = {}): Promise<LadderResult<{ winner: number; score: string | null }>> {
  const found = await challengeFor(userId, challengeId);
  if (!found) return ladderRefusal("LD_NO_CHALLENGE", {}, 404);
  return withLadder(found.ch.ladder_id, async (ladder, season) => {
    const db = getDb();
    const ch = await lockedChallenge(challengeId);
    if (!ch || ch.season_id !== season.id) return ladderRefusal("LD_NO_CHALLENGE", {}, 404);
    if (expected.version !== undefined && expected.version !== Number(ch.version)) return ladderRefusal("LD_CHANGED");
    if (ladder.kind !== "teams" || !ladder.team) return ladderRefusal("LAD2_NOT_TEAMS", {}, 400);
    const mine = found.myId;
    if (ch.status === "reported" && ch.reported_by !== mine) return ladderRefusal("LD_THEY_REPORTED");
    if (ch.status === "disputed") return ladderRefusal("LD_DISPUTED");
    if (ch.status === "pending") return ladderRefusal("LD_NOT_ACCEPTED");
    if (ch.status !== "accepted" && ch.status !== "reported") return ladderRefusal("LD_RESULT_SETTLED");
    if (isWholeFixtureWalkover(rubbers)) return ladderRefusal("LAD2_USE_REQUEST");
    const outcome = teamOutcome(ladder, ch, rubbers);
    if (!outcome.ok) return outcome;
    await writeRubbers(ch.id, ladder.team.rubbers, outcome.value.checked);
    await db
      .prepare(`UPDATE ladder_challenges SET status = 'reported', winner = ?, score = ?, reported_by = ?, reported_at = datetime('now'), version = version + 1, updated_at = datetime('now') WHERE id = ?`)
      .run(outcome.value.winner, outcome.value.score, mine, ch.id);
    const people = await playersOf(ladder.id);
    const other = mine === ch.challenger ? ch.challenged : ch.challenger;
    const score = outcome.value.score ?? "";
    await tellPlayer(
      other,
      ladder,
      (tr) => tr("ld.mail.reported.s", { l: ladder.name, a: people.get(mine)?.shown ?? "" }),
      (tr) =>
        tr("ld.mail.reported.b", {
          l: ladder.name,
          a: people.get(mine)?.shown ?? "",
          score: mine === ch.challenger ? score : flipScore(score),
          winner: outcome.value.winner === mine ? tr("ld.they") : tr("ld.you"),
          days: 3,
        })
    );
    return { ok: true, value: { winner: outcome.value.winner, score: outcome.value.score } };
  });
}

// ------------------------------------------------------------ a team leaving, and its members

/** Ladders a team is on now (open ones), by name, for the refusal to archive it. */
export async function ladderNamesOfTeam(teamId: number): Promise<string[]> {
  return ((await getDb()
    .prepare("SELECT l.name FROM ladder_players lp JOIN ladders l ON l.id = lp.ladder_id WHERE lp.team_id = ? AND lp.status = 'active' AND l.status = 'open' ORDER BY l.id")
    .all(teamId)) as { name: string }[]).map((r) => r.name);
}

/**
 * A team with nobody to captain it (its captain's account erased): off every ladder it is on, as a team league's withdrawal is. Its open
 * challenges end with no effect (the other side told) and the teams below move up.
 */
export async function withdrawTeamFromLadders(teamId: number): Promise<void> {
  const rows = (await getDb().prepare("SELECT id FROM ladder_players WHERE team_id = ? AND status = 'active'").all(teamId)) as { id: number }[];
  for (const r of rows) await leave(r.id).catch(() => null);
}

/** A member gone from the team: out of the lineups of challenges not yet played. Nothing about results already in changes. */
export async function dropFromLadderLineups(memberId: number): Promise<void> {
  await getDb()
    .prepare("DELETE FROM ladder_challenge_lineups WHERE team_member_id = ? AND challenge_id IN (SELECT id FROM ladder_challenges WHERE status IN ('pending', 'accepted'))")
    .run(memberId);
}

/** A person erased: the name a lineup kept for them is replaced, so what they played stays and who they were does not. */
export async function anonymiseLadderLineups(memberId: number, anonymous: string): Promise<void> {
  await getDb().prepare("UPDATE ladder_challenge_lineups SET name = ? WHERE team_member_id = ?").run(anonymous, memberId);
}
