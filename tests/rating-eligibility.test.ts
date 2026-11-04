import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { registerUser, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { createLeague, decideResult, disputeResult, join as joinLeague, leagueDetail, reportResult as reportLeagueResult, startSeason } from "../src/lib/leagues";
import { answerReport, reportResult, standUnansweredReports } from "../src/lib/match-reports";
import { saveProfile } from "../src/lib/player-profiles";
import { DEFAULT_RATING_RULES, orderKey, replay, type RatingFormat, type ReplayRow } from "../src/lib/rating-math";
import { DECIDED_STATUS, TREATMENT, UNDECIDED_STATUS, invalidResult, situationOf, type ResultSource, type Situation } from "../src/lib/rating-eligibility";
import { poolStandings, recomputePool, setEventRated, setRankingPolicy, syncRatedEvent } from "../src/lib/ratings";
import { createCourt, createVenue, listVenues } from "../src/lib/store";
import { acceptInvitation, createInviteLink, createTeam, teamView } from "../src/lib/teams";
import { createTeamLeague, decideFixture, enterTeam, generateFixtures, reportFixture, teamLeagueDetail } from "../src/lib/team-leagues";
import { addDays, todayISO } from "../src/lib/time";
import { applyCorrection, cancelTournament, createTournament, enter, makeDraw, previewResult, recordResult, takeOut, tournamentDetail, type TournamentInput } from "../src/lib/tournaments";
import { answer, challenge, confirm, createLadder, decide as decideChallenge, join as joinLadder, ladderHousekeeping, report as reportChallenge } from "../src/lib/ladders";

/**
 * Which results a rating counts, and how each kind of result is treated (lib/rating-eligibility.ts, ADR 0034;
 * docs/features/tournaments.md#which-results-count). One table, `TREATMENT`: every row of it is run here against real events (tournaments in
 * every format that matters, box leagues, leagues of teams, ladders), so the documentation, the table and the ledger cannot say different things.
 * Then: an amended result leaves ratings equal to a replay from scratch, including when a venue changes the number of results that rank a
 * player; the same ledger gives the same ratings in any order; and a result in one pool never moves another's.
 */

const today = todayISO();
const R = DEFAULT_RATING_RULES;
const fixed = () => 0.42;
let ownerId: number;
let venueId: number;
let courts: number[];
let futsalCourts: number[];
let n = 0;
let dayOffset = 3;

async function adult(name = "Player", listed = false): Promise<User> {
  n++;
  const made = await registerUser({ name: `${name} ${n}`, email: `el${n}@eligible.test`, phone: `01370${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  const saved = await saveProfile(made.user.id, listed ? { adult: true, rankPublicly: true, rankName: `${name} Ranked` } : { adult: true });
  if (!saved.ok) throw new Error(saved.error);
  return made.user;
}

async function tournament(over: Partial<TournamentInput> = {}, rated = true) {
  const day = addDays(today, dayOffset);
  dayOffset += 1;
  const sport = over.sport ?? "badminton";
  const made = await createTournament(
    { venueId, name: `Eligible Cup ${dayOffset}`, sport, format: "round_robin", teamSize: 1, level: null, entryFee: 0, maxEntries: 16, startsOn: day, endsOn: day, startHour: 9, endHour: 21, courtIds: sport === "futsal" ? futsalCourts : courts, ...over },
    ownerId
  );
  if (!made.ok) throw new Error(made.error);
  if (rated) {
    const done = await setEventRated("tournament", made.value.id, true);
    if (!done.ok) throw new Error(done.error);
  }
  return made.value;
}

/** A drawn tournament of `count` players. */
async function drawnWith(over: Partial<TournamentInput>, count: number, rated = true) {
  const t = await tournament(over, rated);
  const users: User[] = [];
  for (let i = 0; i < count; i++) {
    const u = await adult();
    const e = await enter(u, t.id);
    if (!e.ok) throw new Error(e.error);
    users.push(u);
  }
  const d = await makeDraw(t.id, fixed);
  if (!d.ok) throw new Error(d.error);
  return { t, users, matches: (await tournamentDetail(t.id))!.matches };
}

const live = async (kind: ResultSource, id: number) =>
  (await getDb()
    .prepare("SELECT source_match, unit_no, kind, outcome, weight FROM rated_results WHERE source_kind = ? AND source_id = ? AND voided_at IS NULL ORDER BY source_match, unit_no")
    .all(kind, id)) as { source_match: number; unit_no: number; kind: string; outcome: string; weight: string | null }[];

async function games(sport: string, format: RatingFormat, userId: number) {
  return (await poolStandings(venueId, sport, format)).find((s) => s.kind === "user" && s.id === userId)?.games ?? 0;
}

/** What the table says about one result: a ledger row or none, and how much it moves and counts. */
async function expectTreatment(situation: Situation, rows: { kind: string; weight: string | null }[], who: { sport: string; format: RatingFormat; userIds: number[] }) {
  const t = TREATMENT[situation];
  expect(rows.length, `${situation}: ledger rows`).toBe(t.row ? 1 : 0);
  if (!t.row) return;
  const weight = Number(rows[0].weight);
  if (t.counts === "full") expect(weight, situation).toBe(1);
  if (t.counts === "half") expect(weight, situation).toBe(R.retirementWeight);
  if (t.counts === "none") expect(weight, situation).toBe(R.walkoverWeight);
  for (const id of who.userIds) expect(await games(who.sport, who.format, id), `${situation}: results counted for ${id}`).toBe(t.counts === "none" ? 0 : 1);
}

const sideUser = async (entryId: number) => ((await getDb().prepare("SELECT user_id FROM tournament_entries WHERE id = ?").get(entryId)) as { user_id: number }).user_id;

beforeAll(async () => {
  await ensureBootstrapAdmin();
  ownerId = (await listAdmins())[0].id;
  const venue = (await listVenues())[0];
  venueId = venue.id;
  courts = venue.courts.filter((c) => c.sport === "badminton").slice(0, 2).map((c) => c.id);
  while (courts.length < 2) {
    const c = await createCourt({ venueId, name: `Eligible Court ${courts.length}`, sport: "badminton", offPeakRate: 10, peakRate: 12 });
    if (!c.ok) throw new Error(c.error);
    courts.push(c.court.id);
  }
  futsalCourts = [];
  for (let i = 0; i < 2; i++) {
    const c = await createCourt({ venueId, name: `Eligible Futsal ${i}`, sport: "futsal", offPeakRate: 10, peakRate: 12 });
    if (!c.ok) throw new Error(c.error);
    futsalCourts.push(c.court.id);
  }
});

// ------------------------------------------------------------ the table, row by row

/** Each row of the table, run against a real event. A row added to `TREATMENT` without a scenario here is a compile error. */
const scenarios: Record<Situation, () => Promise<void>> = {
  async played() {
    const { t, users, matches } = await drawnWith({}, 3);
    const m = matches[0];
    await recordResult(m.id, { winner: m.a!, score: "21-10, 21-12" });
    expect(situationOf("played", 1)).toBe("played");
    await expectTreatment("played", await live("tournament", t.id), { sport: "badminton", format: "singles", userIds: [await sideUser(m.a!), await sideUser(m.b!)] });
    expect(users).toHaveLength(3);
  },

  async draw() {
    // A group match of a sport scored in goals, where the rules allow a level score: a draw, counted in full.
    const { t, matches } = await drawnWith({ sport: "futsal" }, 3);
    const m = matches[0];
    expect((await recordResult(m.id, { winner: null, score: "2-2" })).ok).toBe(true);
    const rows = await live("tournament", t.id);
    expect(situationOf("played", Number(rows[0].outcome))).toBe("draw");
    expect(Number(rows[0].outcome)).toBe(0.5);
    await expectTreatment("draw", rows, { sport: "futsal", format: "singles", userIds: [await sideUser(m.a!), await sideUser(m.b!)] });
  },

  async retired() {
    // The other side stopped part-way: the win counts half.
    const { t, matches } = await drawnWith({}, 3);
    const m = matches[0];
    expect((await recordResult(m.id, { winner: m.a!, score: "21-15, 5-2", retired: true })).ok).toBe(true);
    const rows = await live("tournament", t.id);
    expect(rows[0].kind).toBe("retired");
    expect(situationOf("retired", 1)).toBe("retired");
    await expectTreatment("retired", rows, { sport: "badminton", format: "singles", userIds: [await sideUser(m.a!), await sideUser(m.b!)] });
  },

  async walkover() {
    const { t, matches } = await drawnWith({}, 3);
    const m = matches[0];
    expect((await recordResult(m.id, { winner: m.a!, walkover: true })).ok).toBe(true);
    const rows = await live("tournament", t.id);
    expect(rows[0].kind).toBe("walkover");
    expect(situationOf("walkover", 1)).toBe("walkover");
    await expectTreatment("walkover", rows, { sport: "badminton", format: "singles", userIds: [await sideUser(m.a!), await sideUser(m.b!)] });
  },

  async forfeit() {
    // A league of teams' fixture given as a forfeit: the other side awarded every game; a row that explains and moves nothing.
    const { league, fixtures, teams } = await teamLeague();
    const f = fixtures[2];
    expect((await decideFixture(f.id, ownerId, { forfeitBy: f.away.id })).ok).toBe(true);
    const rows = (await live("team_league", league)).filter((r) => r.source_match === f.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("walkover");
    expect(situationOf("walkover", 1, true)).toBe("forfeit");
    await expectTreatment("forfeit", rows, { sport: "badminton", format: "team", userIds: [] });
    const standing = (await poolStandings(venueId, "badminton", "team")).filter((s) => teams.includes(s.id));
    // The forfeit moved nobody's rating: only the confirmed fixture did.
    expect(standing.every((s) => s.games === 1)).toBe(true);
  },

  async abandoned() {
    // Started and never finished: nothing was decided, so nothing is in the ledger.
    const { t, matches } = await drawnWith({}, 3);
    await getDb().prepare("UPDATE tournament_matches SET started_at = ?::timestamptz WHERE id = ?").run(new Date().toISOString(), matches[0].id);
    await syncRatedEvent("tournament", t.id);
    await expectTreatment("abandoned", await live("tournament", t.id), { sport: "badminton", format: "singles", userIds: [] });
  },

  async bye() {
    const { t, matches } = await drawnWith({ format: "knockout" }, 3);
    expect(matches.some((m) => m.status === "bye")).toBe(true);
    const real = matches.find((m) => m.status === "scheduled" && m.a !== null && m.b !== null)!;
    await recordResult(real.id, { winner: real.a!, score: "21-10, 21-12" });
    // One result, one row: the bye is no match.
    expect(await live("tournament", t.id)).toHaveLength(1);
    await expectTreatment("bye", (await live("tournament", t.id)).filter((r) => r.source_match !== real.id), { sport: "badminton", format: "singles", userIds: [] });
  },

  async unconfirmed() {
    // A player's report waits for the other side: not a result yet. Confirmed, or left to stand, it is recorded like any other.
    const { t, matches } = await drawnWith({}, 4);
    await getDb().prepare("UPDATE tournaments SET results_by = 'players' WHERE id = ?").run(t.id);
    const [m1, m2] = matches.filter((m) => m.status === "scheduled");
    const a1 = await sideUser(m1.a!);
    const b1 = await sideUser(m1.b!);
    expect((await reportResult(a1, m1.id, { winner: m1.a!, score: "21-10, 21-12" })).ok).toBe(true);
    await syncRatedEvent("tournament", t.id);
    await expectTreatment("unconfirmed", await live("tournament", t.id), { sport: "badminton", format: "singles", userIds: [a1, b1] });
    // The other side confirms: now it is a result.
    expect((await answerReport(b1, m1.id, { confirm: true })).ok).toBe(true);
    expect(await live("tournament", t.id)).toHaveLength(1);
    // Another is left unanswered until it stands: recorded through the same checks, and in the ledger.
    const a2 = await sideUser(m2.a!);
    expect((await reportResult(a2, m2.id, { winner: m2.a!, score: "21-9, 21-9" })).ok).toBe(true);
    expect(await live("tournament", t.id)).toHaveLength(1);
    await getDb().prepare("UPDATE tournament_reports SET created_at = datetime('now', '-30 hours') WHERE match_id = ?").run(m2.id);
    expect(await standUnansweredReports()).toBeGreaterThanOrEqual(1);
    expect(await live("tournament", t.id)).toHaveLength(2);
  },

  async disputed() {
    const { t, matches } = await drawnWith({}, 3);
    await getDb().prepare("UPDATE tournaments SET results_by = 'players' WHERE id = ?").run(t.id);
    const m = matches[0];
    const a = await sideUser(m.a!);
    const b = await sideUser(m.b!);
    await reportResult(a, m.id, { winner: m.a!, score: "21-10, 21-12" });
    expect((await answerReport(b, m.id, { dispute: "That is not what happened" })).ok).toBe(true);
    await syncRatedEvent("tournament", t.id);
    await expectTreatment("disputed", await live("tournament", t.id), { sport: "badminton", format: "singles", userIds: [a, b] });
    // The venue decides it: then it is a result.
    expect((await recordResult(m.id, { winner: m.b!, score: "10-21, 12-21" })).ok).toBe(true);
    expect(await live("tournament", t.id)).toHaveLength(1);
  },

  async voided() {
    // A struck or voided result (a box league's, here) and a called-off tournament leave the ledger, and everybody's rating is put right.
    const { league, matches, ids } = await boxLeague(4);
    const [m] = matches;
    expect((await decideResult(m.id, ownerId, { winner: Math.min(m.a, m.b), score: "21-10, 21-12" })).ok).toBe(true);
    expect(await live("league", league)).toHaveLength(1);
    expect((await decideResult(m.id, ownerId, { void: true })).ok).toBe(true);
    await expectTreatment("voided", await live("league", league), { sport: "badminton", format: "singles", userIds: ids });
    const cup = await drawnWith({}, 3);
    await recordResult(cup.matches[0].id, { winner: cup.matches[0].a!, score: "21-10, 21-12" });
    expect(await live("tournament", cup.t.id)).toHaveLength(1);
    expect((await cancelTournament(cup.t.id)).ok).toBe(true);
    expect(await live("tournament", cup.t.id)).toHaveLength(0);
  },

  async out_group_void() {
    // A disqualified entrant's group results are void by default (the event's own rule): no row. Where the event says they stand, they do.
    const { t, matches } = await drawnWith({}, 4);
    const played = matches.filter((m) => m.status === "scheduled").slice(0, 2);
    for (const m of played) await recordResult(m.id, { winner: m.a!, score: "21-10, 21-12" });
    expect(await live("tournament", t.id)).toHaveLength(2);
    const dq = played[0].a!;
    expect((await takeOut(dq, "disqualified", "rule breach")).ok).toBe(true);
    const mine = (await live("tournament", t.id)).map((r) => r.source_match);
    const involvingDq = played.filter((m) => m.a === dq || m.b === dq).map((m) => m.id);
    expect(involvingDq.length).toBeGreaterThan(0);
    for (const id of involvingDq) {
      const row = (await live("tournament", t.id)).filter((r) => r.source_match === id);
      // Void: no row, as the treatment table says (a later walkover to the opponent is a row of its own, never this one).
      expect(row.filter((r) => r.kind !== "walkover")).toHaveLength(0);
      await expectTreatment("out_group_void", row.filter((r) => r.kind !== "walkover"), { sport: "badminton", format: "singles", userIds: [] });
    }
    expect(mine.length).toBeGreaterThanOrEqual(0);
    // The same under a rule that lets them stand.
    const stands = await drawnWith({ rules: { groupResultsOnDisqualification: "stand" } as never }, 4);
    const two = stands.matches.filter((m) => m.status === "scheduled").slice(0, 2);
    for (const m of two) await recordResult(m.id, { winner: m.a!, score: "21-10, 21-12" });
    expect((await takeOut(two[0].a!, "disqualified", "rule breach")).ok).toBe(true);
    const kept = (await live("tournament", stands.t.id)).filter((r) => r.kind === "played");
    expect(kept).toHaveLength(2);
  },

  async invalid() {
    // A result that cannot be one is not counted, however it came to be written: a score the sport's rules refuse, no score, a level score
    // where none is allowed, a partial score that is not a score, and a side against itself.
    const { t, matches } = await drawnWith({}, 4);
    const [ok, wrongWay, garbage, noScore, level, retiredGarbage] = matches.filter((m) => m.status === "scheduled");
    const db = getDb();
    const write = (m: { id: number; a: number | null }, status: string, winner: number | null, score: string | null) =>
      db.prepare("UPDATE tournament_matches SET status = ?, winner = ?, score = ? WHERE id = ?").run(status, winner, score, m.id);
    await write(ok, "done", ok.a, "21-10, 21-12");
    await write(wrongWay, "done", wrongWay.b, "21-10, 21-12");
    await write(garbage, "done", garbage.a, "banana");
    await write(noScore, "done", noScore.a, null);
    await write(level, "done", null, "21-21");
    await write(retiredGarbage, "retired", retiredGarbage.a, "banana");
    await syncRatedEvent("tournament", t.id);
    const rows = await live("tournament", t.id);
    expect(rows.map((r) => r.source_match)).toEqual([ok.id]);
    await expectTreatment("invalid", rows.filter((r) => r.source_match !== ok.id), { sport: "badminton", format: "singles", userIds: [] });
    // The same rules as a pure check.
    const scoring = { kind: "sets" as const, bestOf: 3, draws: false };
    expect(invalidResult({ kind: "played", outcome: 1, score: "21-10, 21-12", scoring, drawsAllowed: false, sidesOverlap: false })).toBeNull();
    expect(invalidResult({ kind: "played", outcome: 0, score: "21-10, 21-12", scoring, drawsAllowed: false, sidesOverlap: false })).toBe("score_refused");
    expect(invalidResult({ kind: "played", outcome: 1, score: null, scoring, drawsAllowed: false, sidesOverlap: false })).toBe("no_score");
    expect(invalidResult({ kind: "played", outcome: 0.5, score: "21-21", scoring, drawsAllowed: false, sidesOverlap: false })).toBe("draw_not_allowed");
    expect(invalidResult({ kind: "played", outcome: 1, score: "21-10, 21-12", scoring, drawsAllowed: false, sidesOverlap: true })).toBe("same_subject");
    expect(invalidResult({ kind: "walkover", outcome: 1, score: null, scoring, drawsAllowed: false, sidesOverlap: false })).toBeNull();
    expect(invalidResult({ kind: "retired", outcome: 1, score: null, scoring, drawsAllowed: false, sidesOverlap: false })).toBeNull();
    // A side against itself (two entries of one account, which the entry rules never allow, so the rule is lifted for this check).
    const self = await drawnWith({}, 3);
    const first = self.matches.find((m) => m.status === "scheduled")!;
    const index = (await db.prepare("SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_tournament_entry_user'").get()) as { indexdef: string };
    await db.exec("DROP INDEX uq_tournament_entry_user");
    try {
      await db.prepare("UPDATE tournament_entries SET user_id = ? WHERE id = ?").run(await sideUser(first.a!), first.b!);
      await db.prepare("UPDATE tournament_matches SET status = 'done', winner = ?, score = '21-10, 21-12' WHERE id = ?").run(first.a, first.id);
      await syncRatedEvent("tournament", self.t.id);
      expect(await live("tournament", self.t.id)).toHaveLength(0);
    } finally {
      await db.prepare("UPDATE tournament_entries SET user_id = NULL WHERE id = ?").run(first.b!);
      await db.exec(index.indexdef);
    }
  },

  async nobody_to_rate() {
    // An entry with no account behind it (a name typed at the counter) is not somebody the app can rate: a match with one on a side is not counted.
    const { t, matches } = await drawnWith({}, 3);
    const m = matches.find((x) => x.status === "scheduled")!;
    await recordResult(m.id, { winner: m.a!, score: "21-10, 21-12" });
    expect(await live("tournament", t.id)).toHaveLength(1);
    await getDb().prepare("UPDATE tournament_entries SET user_id = NULL WHERE id = ?").run(m.b!);
    await syncRatedEvent("tournament", t.id);
    await expectTreatment("nobody_to_rate", await live("tournament", t.id), { sport: "badminton", format: "singles", userIds: [] });
  },
};

// A league of three teams; its first fixture confirmed, its second reported by a captain and left unconfirmed, the rest the caller's.
async function teamLeague() {
  const startsOn = addDays(today, 150 + (n % 20));
  const lg = await createTeamLeague({ venueId, name: `Eligible League ${n}`, sport: "badminton", startsOn, endsOn: addDays(startsOn, 100), courtIds: courts, rosterMin: 2 }, ownerId);
  if (!lg.ok) throw new Error(lg.error);
  expect(await setEventRated("team_league", lg.value.id, true)).toMatchObject({ ok: true });
  const sides: { captain: User; teamId: number; name: string; members: number[] }[] = [];
  for (const label of ["North", "South", "East"]) {
    const captain = await adult(`${label} Captain`);
    n++;
    const made = await createTeam(captain.id, { name: `${label} Side ${n}`, sport: "badminton", published: true });
    if (!made.ok) throw new Error(made.error);
    const p = await adult(`${label} Player`);
    const link = await createInviteLink(captain.id, made.value.id);
    if (!link.ok) throw new Error(link.error);
    await acceptInvitation(p, new URL(link.value.link).searchParams.get("token"), {});
    const members = (await teamView(made.value.id, captain.id))!.roster!.map((m) => m.id);
    const e = await enterTeam(captain.id, lg.value.id, { teamId: made.value.id, memberIds: members });
    if (!e.ok) throw new Error(e.error);
    sides.push({ captain, teamId: made.value.id, name: made.value.name, members });
  }
  const gen = await generateFixtures(lg.value.id, Array.from({ length: 4 }, (_, i) => ({ date: addDays(startsOn, 1 + i * 7), startMin: 9 * 60 })));
  if (!gen.ok) throw new Error(gen.error);
  const fixtures = (await teamLeagueDetail(lg.value.id, { forStaff: true }))!.fixtures;
  const rubbers = [1, 2, 3].map(() => ({ winner: "home", score: "21-10, 21-12" }));
  // The first confirmed by staff, the second reported by the home captain and left unconfirmed.
  expect((await decideFixture(fixtures[0].id, ownerId, { rubbers })).ok).toBe(true);
  const homeCaptain = sides.find((s) => s.name === fixtures[1].home.name)!.captain;
  // A captain reports only once the fixture has been played: it was yesterday.
  await getDb().prepare("UPDATE team_fixtures SET date = ? WHERE id = ?").run(addDays(today, -1), fixtures[1].id);
  const reported = await reportFixture(homeCaptain.id, fixtures[1].id, rubbers);
  expect(reported.ok, JSON.stringify(reported)).toBe(true);
  const rows = await live("team_league", lg.value.id);
  expect(rows.map((r) => r.source_match)).toEqual([fixtures[0].id]);
  return { league: lg.value.id, fixtures, teams: sides.map((s) => s.teamId) };
}

async function boxLeague(count: number) {
  const made = await createLeague({ venueId, name: `Eligible Box ${n}`, sport: "badminton", teamSize: 1, level: null, fee: 0, startsOn: addDays(today, 1) }, ownerId);
  if (!made.ok) throw new Error(made.error);
  expect(await setEventRated("league", made.value.id, true)).toMatchObject({ ok: true });
  const people: { user: User; playerId: number }[] = [];
  for (let i = 0; i < count; i++) {
    const user = await adult("Boxer");
    const joined = await joinLeague(user, made.value.id);
    if (!joined.ok) throw new Error(joined.error);
    people.push({ user, playerId: joined.value.id });
  }
  const s = await startSeason(made.value.id, { startsOn: today }, today);
  if (!s.ok) throw new Error(s.error);
  const matches = (await leagueDetail(made.value.id))!.matches;
  return { league: made.value.id, matches, people, ids: people.map((p) => p.user.id) };
}

describe("the treatment table, every row against a real event", () => {
  for (const situation of Object.keys(TREATMENT) as Situation[])
    it(`${situation}: ${TREATMENT[situation].row ? `a ledger row, ${TREATMENT[situation].counts}` : "no ledger row"}`, async () => {
      await scenarios[situation]();
    });
});

describe("box leagues and ladders follow the same table", () => {
  it("a box league: confirmed counts, a walkover moves nothing, reported, disputed and struck results are not counted", async () => {
    const { league, matches, people } = await boxLeague(4);
    expect(matches.length).toBeGreaterThanOrEqual(5);
    const [m0, m1, m2, m3, m4] = matches;
    const idOf = (playerId: number) => people.find((p) => p.playerId === playerId)!.user.id;
    expect((await decideResult(m0.id, ownerId, { winner: m0.a, score: "21-10, 21-12" })).ok).toBe(true);
    expect((await decideResult(m1.id, ownerId, { winner: m1.a, walkover: true })).ok).toBe(true);
    // A player reports, the other side has not answered: not a result.
    const reporter = people.find((p) => p.playerId === m2.a)!.user;
    expect((await reportLeagueResult(reporter.id, m2.id, { winner: m2.a, score: "21-10, 21-12" })).ok).toBe(true);
    // Another is reported and disputed: staff must decide it.
    const r3 = people.find((p) => p.playerId === m3.a)!.user;
    const o3 = people.find((p) => p.playerId === m3.b)!.user;
    expect((await reportLeagueResult(r3.id, m3.id, { winner: m3.a, score: "21-10, 21-12" })).ok).toBe(true);
    expect((await disputeResult(o3.id, m3.id, "That was not the score")).ok).toBe(true);
    // A third is decided and then struck.
    expect((await decideResult(m4.id, ownerId, { winner: m4.a, score: "21-10, 21-12" })).ok).toBe(true);
    expect((await decideResult(m4.id, ownerId, { void: true })).ok).toBe(true);
    await syncRatedEvent("league", league);
    const rows = await live("league", league);
    expect(rows.map((r) => [r.source_match, r.kind, Number(r.weight)])).toEqual([[m0.id, "played", 1], [m1.id, "walkover", 0]]);
    expect(await games("badminton", "singles", idOf(m0.a))).toBeGreaterThanOrEqual(1);
    const heldBack = await games("badminton", "singles", idOf(m2.a));
    // The reported one, once the other side confirms, is a result.
    const { confirmResult } = await import("../src/lib/leagues");
    expect((await confirmResult(people.find((p) => p.playerId === m2.b)!.user.id, m2.id)).ok).toBe(true);
    expect((await live("league", league)).map((r) => r.source_match)).toContain(m2.id);
    expect(await games("badminton", "singles", idOf(m2.a))).toBe(heldBack + 1);
  });

  it("a ladder: a confirmed result counts, a reported one does not, a forfeit moves nothing, a voided one leaves", async () => {
    const l = await createLadder({ venueId, name: `Eligible Ladder ${n}`, sport: "badminton", teamSize: 1, level: null }, ownerId);
    if (!l.ok) throw new Error(l.error);
    expect((await setEventRated("ladder", l.value.id, true)).ok).toBe(true);
    const players: { user: User; id: number }[] = [];
    for (let i = 0; i < 5; i++) {
      const user = await adult("Lad");
      const done = await joinLadder(user, l.value.id, { adult: true });
      if (!done.ok) throw new Error(done.error);
      players.push({ user, id: done.value.playerId });
    }
    const manager = { adminId: ownerId, name: "Manager" };
    // Played and confirmed.
    const first = await challenge(players[4].user.id, l.value.id, players[4].id, players[3].id);
    if (!first.ok) throw new Error(first.error);
    expect((await answer(players[3].user.id, first.value.id, { accept: true })).ok).toBe(true);
    const rep = await reportChallenge(players[4].user.id, first.value.id, { winner: players[4].id, score: "21-10, 21-12" });
    if (!rep.ok) throw new Error(rep.error);
    // Reported, not yet confirmed: not a result.
    await syncRatedEvent("ladder", l.value.id);
    expect(await live("ladder", l.value.id)).toHaveLength(0);
    expect((await confirm(players[3].user.id, first.value.id, { version: rep.value.version })).ok).toBe(true);
    expect((await live("ladder", l.value.id)).map((r) => r.kind)).toEqual(["played"]);
    // A challenge nobody answered lapses into a forfeit: a row, weight 0.
    const ignored = await challenge(players[3].user.id, l.value.id, players[3].id, players[2].id);
    if (!ignored.ok) throw new Error(ignored.error);
    await getDb().prepare("UPDATE ladder_challenges SET respond_by = ? WHERE id = ?").run(addDays(today, -1), ignored.value.id);
    await ladderHousekeeping();
    await syncRatedEvent("ladder", l.value.id);
    const rows = await live("ladder", l.value.id);
    expect(rows.map((r) => [r.kind, Number(r.weight)])).toEqual([["played", 1], ["walkover", 0]]);
    // A declined, cancelled or never-played challenge is not in it; a voided one leaves.
    expect((await decideChallenge(first.value.id, manager, { void: true }, "Not a ladder match")).ok).toBe(true);
    expect((await live("ladder", l.value.id)).map((r) => r.kind)).toEqual(["walkover"]);
  });
});

describe("every status a result can have is classified once", () => {
  const tables: Record<ResultSource, string> = { tournament: "tournament_matches", league: "league_matches", team_league: "team_fixtures", ladder: "ladder_challenges" };
  for (const source of Object.keys(tables) as ResultSource[])
    it(`${tables[source]}: decided or not, never neither, never both`, async () => {
      const defs = (await getDb()
        .prepare("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = ?::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%status%'")
        .all(tables[source])) as { def: string }[];
      const statuses = new Set(defs.flatMap((d) => [...d.def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])));
      expect(statuses.size).toBeGreaterThan(3);
      const classified = [...DECIDED_STATUS[source], ...UNDECIDED_STATUS[source]];
      expect(new Set(classified).size, "no status in both lists").toBe(classified.length);
      expect([...statuses].sort()).toEqual([...classified].sort());
    });
});

// ------------------------------------------------------------ amendments and the number that ranks

async function fresh(vId: number, sport: string, format: RatingFormat) {
  const db = getDb();
  const rows = (await db
    .prepare(
      `SELECT r.id, r.played_on, r.play_order, r.source_kind, r.source_id, r.source_match, r.unit_no, r.outcome, r.kind, r.margin FROM rated_results r
        WHERE r.venue_id = ? AND r.sport = ? AND r.format = ? AND r.voided_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM rating_exclusions x WHERE x.lifted_at IS NULL AND x.source_kind = r.source_kind AND x.source_id = r.source_id AND x.source_match = r.source_match AND x.unit_no = r.unit_no)`
    )
    .all(vId, sport, format)) as { id: number; played_on: string; play_order: number; source_kind: string; source_id: number; source_match: number; unit_no: number; outcome: string; kind: "played" | "walkover" | "retired"; margin: number | null }[];
  const subs = (await db
    .prepare(
      `SELECT s.id, s.result_id, s.side, s.subject_kind, s.subject_id, s.frozen_rating FROM rated_result_subjects s JOIN rated_results r ON r.id = s.result_id
        WHERE r.venue_id = ? AND r.sport = ? AND r.format = ? AND r.voided_at IS NULL`
    )
    .all(vId, sport, format)) as { id: number; result_id: number; side: "a" | "b"; subject_kind: string; subject_id: number | null; frozen_rating: string | null }[];
  const replayRows: ReplayRow[] = rows.map((r) => {
    const side = (s: "a" | "b") =>
      subs.filter((x) => x.result_id === r.id && x.side === s).map((x) => (x.subject_kind === "removed" ? { key: `removed:${x.id}`, frozen: Number(x.frozen_rating) } : { key: `${x.subject_kind}:${x.subject_id}` }));
    return {
      id: r.id,
      order: orderKey({ playedOn: r.played_on, playOrder: r.play_order, sourceKind: r.source_kind, sourceId: r.source_id, sourceMatch: r.source_match, unitNo: r.unit_no }),
      outcome: Number(r.outcome),
      kind: r.kind,
      margin: r.margin,
      a: side("a"),
      b: side("b"),
    };
  });
  return replay(replayRows, R);
}

async function expectReplayAndClasses(vId: number, sport: string, format: RatingFormat, rankAfter: number) {
  const want = await fresh(vId, sport, format);
  const stored = (await getDb()
    .prepare("SELECT subject_kind, subject_id, rating, games FROM rating_subjects WHERE venue_id = ? AND sport = ? AND format = ?")
    .all(vId, sport, format)) as { subject_kind: string; subject_id: number; rating: string; games: number }[];
  const have = new Map(stored.map((r) => [`${r.subject_kind}:${r.subject_id}`, [Number(r.rating), r.games]]));
  const expected = new Map([...want.subjects].filter(([k, s]) => !k.startsWith("removed:") && s.games > 0).map(([k, s]) => [k, [s.rating, s.games]]));
  expect([...have].sort()).toEqual([...expected].sort());
  // Who is provisional follows the venue's number, applied to the same counted results.
  for (const s of await poolStandings(vId, sport, format)) expect(s.provisional, `${s.kind}:${s.id}`).toBe(s.games < rankAfter);
}

describe("an amended result leaves every rating equal to a replay from scratch, whatever number ranks a player", () => {
  it("a box league: corrected, struck, restored, with the venue changing how many results rank a player in between", async () => {
    const { league, matches, people } = await boxLeague(4);
    expect(matches.length).toBeGreaterThanOrEqual(5);
    const rankAfter = async (after: number | null) => {
      await setRankingPolicy(venueId, { rankAfter: after }, "Test manager");
      return after ?? 8;
    };
    let k = await rankAfter(null);
    for (const m of matches.slice(0, 5)) await decideResult(m.id, ownerId, { winner: Math.min(m.a, m.b), score: "21-10, 21-12" });
    await expectReplayAndClasses(venueId, "badminton", "singles", k);
    // Corrected: the other side won.
    const target = matches[0];
    expect((await decideResult(target.id, ownerId, { winner: Math.max(target.a, target.b), score: "10-21, 12-21" })).ok).toBe(true);
    k = await rankAfter(3);
    await expectReplayAndClasses(venueId, "badminton", "singles", k);
    // Struck.
    expect((await decideResult(target.id, ownerId, { void: true })).ok).toBe(true);
    k = await rankAfter(30);
    await expectReplayAndClasses(venueId, "badminton", "singles", k);
    // Restored.
    expect((await decideResult(target.id, ownerId, { clear: true })).ok).toBe(true);
    expect((await decideResult(target.id, ownerId, { winner: Math.min(target.a, target.b), score: "21-10, 21-12" })).ok).toBe(true);
    k = await rankAfter(4);
    await expectReplayAndClasses(venueId, "badminton", "singles", k);
    // The number moved four times and the ledger's rows are those the results made, no more.
    expect((await live("league", league)).length).toBe(5);
    expect(people).toHaveLength(4);
    await rankAfter(null);
  });

  it("a knockout: a result put right after the final was played, through the organiser's own correction", async () => {
    const { t, matches } = await drawnWith({ format: "knockout" }, 4);
    const semis = matches.filter((m) => m.round === 1 && m.status === "scheduled");
    await recordResult(semis[0].id, { winner: semis[0].a!, score: "21-10, 21-12" });
    await recordResult(semis[1].id, { winner: semis[1].a!, score: "21-10, 21-12" });
    const final = (await tournamentDetail(t.id))!.matches.find((m) => m.round === 2)!;
    await recordResult(final.id, { winner: final.a!, score: "21-10, 21-12" });
    await expectReplayAndClasses(venueId, "badminton", "singles", 8);
    const preview = await previewResult(semis[0].id, { winner: semis[0].b!, score: "18-21, 19-21" });
    if (!preview.ok) throw new Error(preview.error);
    const done = await applyCorrection(semis[0].id, { winner: semis[0].b!, score: "18-21, 19-21" }, { mode: "standings_only", reason: "Wrong side entered", token: preview.value.token }, { id: ownerId, name: "Owner" });
    expect(done.ok).toBe(true);
    await setRankingPolicy(venueId, { rankAfter: 3 }, "Test manager");
    await expectReplayAndClasses(venueId, "badminton", "singles", 3);
    await setRankingPolicy(venueId, { rankAfter: null }, "Test manager");
    await expectReplayAndClasses(venueId, "badminton", "singles", 8);
  });
});

describe("the same ledger gives the same ratings, in any order", () => {
  it("is a pure function of the rows: shuffled a hundred ways, the replay is the same", () => {
    // A small deterministic generator, so a failure can be reproduced.
    let seed = 12345;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const people = Array.from({ length: 9 }, (_, i) => `user:${i + 1}`);
    const rows: ReplayRow[] = Array.from({ length: 80 }, (_, i) => {
      const a = people[Math.floor(rand() * people.length)];
      let b = people[Math.floor(rand() * people.length)];
      if (b === a) b = people[(people.indexOf(a) + 1) % people.length];
      const kinds = ["played", "played", "played", "walkover", "retired"] as const;
      return {
        id: i + 1,
        order: orderKey({ playedOn: addDays("2026-01-01", Math.floor(i / 4)), playOrder: i % 4, sourceKind: "tournament", sourceId: 1 + (i % 3), sourceMatch: i + 1, unitNo: 0 }),
        outcome: [1, 0, 0.5][Math.floor(rand() * 3)],
        kind: kinds[Math.floor(rand() * kinds.length)],
        margin: rand() > 0.5 ? Math.floor(rand() * 6) : null,
        a: [{ key: a }],
        b: [{ key: b }],
      };
    });
    const flat = (r: ReturnType<typeof replay>) => JSON.stringify([[...r.subjects].sort(([x], [y]) => (x < y ? -1 : 1)), [...r.rows].map(([id, o]) => [id, o.weight, o.sideA, o.sideB, [...o.members]]).sort((x, y) => (x[0] as number) - (y[0] as number))]);
    const want = flat(replay(rows, R));
    for (let round = 0; round < 100; round++) {
      const shuffled = [...rows];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      expect(flat(replay(shuffled, R)), `shuffle ${round}`).toBe(want);
    }
  });

  it("is the same in the database: two venues given the same results in opposite orders end at the same ratings", async () => {
    const make = async (name: string) => {
      const v = await createVenue({ name, area: "PJ", address: "x", phone: "0312345678" });
      if (!v.ok) throw new Error(v.error);
      return v.venue.id;
    };
    const one = await make("Order One");
    const two = await make("Order Two");
    const players = [await adult(), await adult(), await adult(), await adult()];
    const facts = Array.from({ length: 12 }, (_, i) => ({ a: players[i % 4].id, b: players[(i + 1 + (i % 3)) % 4].id, outcome: i % 3 === 0 ? 0 : 1, day: addDays(today, -300 + Math.floor(i / 2)), match: i + 1 }));
    const put = async (venue: number, f: (typeof facts)[number]) => {
      const db = getDb();
      const made = (await db
        .prepare(
          `INSERT INTO rated_results (venue_id, sport, format, source_kind, source_id, source_match, unit_no, event_name, played_on, play_order, outcome, kind, fact_hash)
           VALUES (?, 'badminton', 'singles', 'tournament', ?, ?, 0, 'Order Cup', ?, ?, ?, 'played', ?) RETURNING id`
        )
        .get(venue, 9_100_000 + venue, f.match, f.day, f.match % 2, f.outcome, `order${venue}${f.match}`)) as { id: number };
      for (const [side, id] of [["a", f.a], ["b", f.b]] as const) await db.prepare("INSERT INTO rated_result_subjects (result_id, side, subject_kind, subject_id, label) VALUES (?, ?, 'user', ?, '')").run(made.id, side, id);
    };
    for (const f of facts) await put(one, f);
    for (const f of [...facts].reverse()) await put(two, f);
    await recomputePool(one, "badminton", "singles");
    await recomputePool(two, "badminton", "singles");
    const read = async (v: number) =>
      (await getDb().prepare("SELECT subject_id, rating, games, wins, draws, losses FROM rating_subjects WHERE venue_id = ? AND sport = 'badminton' AND format = 'singles' ORDER BY subject_id").all(v)) as unknown[];
    expect(await read(one)).toEqual(await read(two));
    expect((await read(one)).length).toBe(4);
  });
});

describe("a result in one pool never changes another's ratings", () => {
  it("not across formats, sports or venues, even for the same person", async () => {
    const other = await createVenue({ name: "Elsewhere Arena", area: "PJ", address: "x", phone: "0312345678" });
    if (!other.ok) throw new Error(other.error);
    const elsewhere = other.venue.id;
    const [x, y, z] = [await adult(), await adult(), await adult()];
    let seq = 0;
    const put = async (venue: number, sport: string, format: RatingFormat, a: { kind: string; id: number }[], b: { kind: string; id: number }[], outcome: number) => {
      seq++;
      const db = getDb();
      const made = (await db
        .prepare(
          `INSERT INTO rated_results (venue_id, sport, format, source_kind, source_id, source_match, unit_no, event_name, played_on, play_order, outcome, kind, fact_hash)
           VALUES (?, ?, ?, 'tournament', ?, ?, 0, 'Sep Cup', ?, ?, ?, 'played', ?) RETURNING id`
        )
        .get(venue, sport, format, 9_200_000 + venue, 1000 + seq + n * 100, addDays(today, -200 + seq), seq, outcome, `sep${venue}${sport}${format}${seq}`)) as { id: number };
      for (const [side, list] of [["a", a], ["b", b]] as const) for (const s of list) await db.prepare("INSERT INTO rated_result_subjects (result_id, side, subject_kind, subject_id, label) VALUES (?, ?, ?, ?, '')").run(made.id, side, s.kind, s.id);
      await recomputePool(venue, sport, format);
    };
    const U = (u: User) => ({ kind: "user", id: u.id });
    const standingsOf = async (venue: number, sport: string, format: RatingFormat) =>
      JSON.stringify(await getDb().prepare("SELECT subject_kind, subject_id, rating, games, wins, losses FROM rating_subjects WHERE venue_id = ? AND sport = ? AND format = ? ORDER BY subject_kind, subject_id").all(venue, sport, format));
    // The same three people have results in four pools: singles and doubles here, singles of another sport here, singles at another venue.
    await put(venueId, "badminton", "singles", [U(x)], [U(y)], 1);
    await put(venueId, "badminton", "doubles", [U(x), U(y)], [U(z)], 1);
    await put(venueId, "tennis", "singles", [U(x)], [U(z)], 1);
    await put(elsewhere, "badminton", "singles", [U(x)], [U(z)], 0);
    const pools: [number, string, RatingFormat][] = [[venueId, "badminton", "singles"], [venueId, "badminton", "doubles"], [venueId, "tennis", "singles"], [elsewhere, "badminton", "singles"]];
    const before = await Promise.all(pools.map(([v, s, f]) => standingsOf(v, s, f)));
    // A result in the first pool changes the first pool.
    await put(venueId, "badminton", "singles", [U(x)], [U(y)], 1);
    const after = await Promise.all(pools.map(([v, s, f]) => standingsOf(v, s, f)));
    expect(after[0]).not.toBe(before[0]);
    // And none of the others.
    expect(after.slice(1)).toEqual(before.slice(1));
    // A result in the doubles pool, the other sport's, the other venue's: each moves its own and nobody else's.
    for (const target of [1, 2, 3]) {
      const [v, s, f] = pools[target];
      const snap = await Promise.all(pools.map(([pv, ps, pf]) => standingsOf(pv, ps, pf)));
      await put(v, s, f, f === "doubles" ? [U(x), U(y)] : [U(y)], f === "doubles" ? [U(z)] : [U(z)], 1);
      const now = await Promise.all(pools.map(([pv, ps, pf]) => standingsOf(pv, ps, pf)));
      pools.forEach((_, i) => (i === target ? expect(now[i]).not.toBe(snap[i]) : expect(now[i], `pool ${i} after a result in pool ${target}`).toBe(snap[i])));
    }
  });
});
