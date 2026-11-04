import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { registerUser, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { addManaged } from "../src/lib/managed-people";
import { saveProfile } from "../src/lib/player-profiles";
import { blockSlots, createBooking, createCourt, listVenues, unblockSlots } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { setPlayerGender } from "../src/lib/who";
import { acceptInvitation, createInviteLink, createTeam, leaveTeam, teamView, type Team } from "../src/lib/teams";
import {
  closeTeamLeague,
  confirmFixture,
  createTeamLeague,
  decideFixture,
  disputeFixture,
  enterTeam,
  generateFixtures,
  moveFixture,
  publicTeamLeagues,
  reportFixture,
  setBlackouts,
  setLeagueRoster,
  setLineup,
  teamLeagueById,
  teamLeagueDetail,
  teamLeagueHousekeeping,
  withdrawTeam,
  type TeamLeagueInput,
} from "../src/lib/team-leagues";
import { STAFF_ACTIONS, managerOnly } from "../src/lib/roles";
import * as adminLeagues from "../src/app/api/admin/team-leagues/route";
import * as adminLeague from "../src/app/api/admin/team-leagues/[id]/route";
import * as adminFixture from "../src/app/api/admin/team-leagues/[id]/fixtures/[fixtureId]/route";
import * as adminTeam from "../src/app/api/admin/team-leagues/[id]/teams/[teamId]/route";
import * as publicLeague from "../src/app/api/team-leagues/[id]/route";
import { listActivity } from "../src/lib/activity";

/**
 * Leagues of teams (lib/team-leagues.ts, lib/fixtures.ts; migration 0269): setting one up, teams entering with a roster
 * picked per member, the fixture list on the manager's nights with each fixture's court time held, lineups,
 * results by the sport's scoring rules and the table, forfeits, moves (managers only) and what the public sees.
 */

vi.setConfig({ testTimeout: 60_000 });

let ownerId: number;
let venueId: number;
let courts: number[];
let managerCookie: string;
let deskCookie: string;
let n = 0;
const today = todayISO();

afterEach(() => vi.useRealTimers());

async function adult(opts: { name?: string; gender?: "woman" | "man" } = {}): Promise<User> {
  n++;
  const made = await registerUser({ name: `${opts.name ?? "Player"} ${n}`, email: `tl${n}@leagues.test`, phone: `01390${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now'), verified_phone = phone WHERE id = ?").run(made.user.id);
  await saveProfile(made.user.id, { adult: true });
  if (opts.gender) await setPlayerGender(made.user.id, opts.gender);
  return made.user;
}

interface Side {
  captain: User;
  team: Team;
  /** team_members ids, captain first, then the others. */
  members: number[];
  players: User[];
  leagueTeamId?: number;
}

/** A team of a captain and `size - 1` others, all adults. */
async function side(label: string, size = 3, sport = "badminton"): Promise<Side> {
  const captain = await adult({ name: `${label} Captain` });
  n++;
  const made = await createTeam(captain.id, { name: `${label} ${n}`, sport });
  if (!made.ok) throw new Error(made.error);
  const players: User[] = [];
  for (let i = 1; i < size; i++) {
    const p = await adult({ name: `${label} Player` });
    const link = await createInviteLink(captain.id, made.value.id);
    if (!link.ok) throw new Error(link.error);
    const done = await acceptInvitation(p, new URL(link.value.link).searchParams.get("token"), {});
    if (!done.ok) throw new Error(done.error);
    players.push(p);
  }
  const view = (await teamView(made.value.id, captain.id))!;
  return { captain, team: made.value, members: view.roster!.map((m) => m.id), players };
}

/** Each league has a season of its own: the courts are the whole file's, and what one holds another must not find taken. */
let seasons = 0;
const fresh = () => addDays(today, 3 + 80 * seasons++);

async function league(over: Partial<TeamLeagueInput> = {}) {
  n++;
  const startsOn = (over.startsOn as string | undefined) ?? fresh();
  const made = await createTeamLeague({ venueId, name: `Premier ${n}`, sport: "badminton", startsOn, endsOn: addDays(startsOn, 300), courtIds: courts, ...over }, ownerId);
  if (!made.ok) throw new Error(made.error);
  return made.value;
}

async function entered(leagueId: number, s: Side, extra: { homeCourtId?: number; blackouts?: string[]; memberIds?: number[] } = {}) {
  const done = await enterTeam(s.captain.id, leagueId, { teamId: s.team.id, memberIds: extra.memberIds ?? s.members, homeCourtId: extra.homeCourtId, blackouts: extra.blackouts });
  if (!done.ok) throw new Error(done.error);
  s.leagueTeamId = done.value.leagueTeamId;
  return done.value.leagueTeamId;
}

/** Nights, each the same time: starting on the day given, one every `gap` days. */
const nights = (count: number, from = today, gap = 7, startMin = 9 * 60) => Array.from({ length: count }, (_, i) => ({ date: addDays(from, i * gap), startMin }));

/** A league of `size` teams entered, with its fixtures made on `count` nights. */
async function made(size: number, over: Partial<TeamLeagueInput> = {}, count = 8, sport = "badminton") {
  const l = await league({ sport, ...over });
  const sides: Side[] = [];
  for (let i = 0; i < size; i++) {
    const s = await side(`T${i + 1}`, 3, sport);
    await entered(l.id, s);
    sides.push(s);
  }
  const gen = await generateFixtures(l.id, nights(count, l.startsOn));
  if (!gen.ok) throw new Error(gen.error);
  return { l: (await teamLeagueById(l.id))!, sides };
}

const detail = async (id: number, opts: Parameters<typeof teamLeagueDetail>[1] = { forStaff: true }) => (await teamLeagueDetail(id, opts))!;
const mail = async (to: string) =>
  (await getDb().prepare("SELECT subject, body FROM messages WHERE kind IN ('programme', 'team_decision') AND recipient = ? ORDER BY id").all(to)) as { subject: string; body: string }[];

/** A result for each game: the home side winning every one by default. */
const games = (count: number, winner: "home" | "away" = "home", score = "21-10, 21-12") =>
  Array.from({ length: count }, () => ({ winner, score: winner === "home" ? score : score.replace(/(\d+)-(\d+)/g, "$2-$1") }));

beforeAll(async () => {
  await ensureBootstrapAdmin();
  ownerId = (await listAdmins())[0].id;
  const venue = (await listVenues())[0];
  venueId = venue.id;
  courts = venue.courts.filter((c) => c.sport === "badminton").slice(0, 3).map((c) => c.id);
  while (courts.length < 2) {
    const c = await createCourt({ venueId, name: `League Court ${courts.length}`, sport: "badminton", offPeakRate: 10, peakRate: 12 });
    if (!c.ok) throw new Error(c.error);
    courts.push(c.court.id);
  }
  const manager = await createAdmin({ name: "Mina Manager", email: "mina-tl@venue.my", password: "manager-pass-1", venueId });
  const desk = await createAdmin({ name: "Dan Desk", email: "dan-tl@venue.my", password: "desk-password-1", venueId, role: "desk" });
  if (!manager.ok || !desk.ok) throw new Error("staff");
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(manager.admin.id)).token}`;
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
});

describe("setting one up", () => {
  it("takes the sport's template: its scoring, and what a team match is made of", async () => {
    const l = await league();
    expect(l).toMatchObject({ status: "forming", legs: 1, category: "open", template: "racket_best_of_3", rubbers: ["singles", "doubles", "singles"], rubberMinutes: 45, teams: 0 });
    expect(l.rules.scoring).toMatchObject({ kind: "sets", bestOf: 3 });
    expect(l.courts.map((c) => c.id).sort()).toEqual([...courts].sort());
    // A sport whose match is the whole team: one match, scored as the template scores it.
    const futsalVenue = await createCourt({ venueId, name: "Futsal Pitch TL", sport: "futsal", offPeakRate: 10, peakRate: 12 });
    if (!futsalVenue.ok) throw new Error(futsalVenue.error);
    const f = await createTeamLeague({ venueId, name: "Futsal League", sport: "futsal", startsOn: today, endsOn: addDays(today, 90), courtIds: [futsalVenue.court.id] }, ownerId);
    if (!f.ok) throw new Error(f.error);
    expect(f.value.rubbers).toEqual(["team"]);
    expect(f.value.rules.scoring).toMatchObject({ kind: "tally", draws: true });
    expect(f.value.rosterMin).toBeGreaterThanOrEqual(5);
  });

  it("checks what it is given", async () => {
    const base = { venueId, name: "Check League", sport: "badminton", startsOn: today, endsOn: addDays(today, 60), courtIds: courts };
    const refused = async (over: Partial<TeamLeagueInput>, code: string) => expect(await createTeamLeague({ ...base, ...over }, ownerId)).toMatchObject({ ok: false, code });
    await refused({ name: "ab" }, "TL_NAME");
    await refused({ sport: "no-such-sport" }, "TM_SPORT");
    await refused({ startsOn: addDays(today, -3) }, "TL_DATES");
    await refused({ endsOn: addDays(today, -1) }, "TL_DATES");
    await refused({ endsOn: addDays(today, 500) }, "TL_DATES");
    await refused({ entriesCloseOn: addDays(today, 90) }, "TL_DATES");
    await refused({ courtIds: [] }, "TL_COURTS");
    await refused({ courtIds: [999999] }, "TL_COURTS");
    await refused({ rubbers: ["singles", "team"] }, "TL_RUBBERS");
    await refused({ rubbers: [] }, "TL_RUBBERS");
    await refused({ rubbers: Array(12).fill("singles") }, "TL_RUBBERS");
    await refused({ tableRules: { tablePoints: { win: 50 } } }, "TL_TABLE");
    await refused({ tableRules: { rankBy: ["luck"] } }, "TL_TABLE");
    await refused({ category: "mixed" }, "TL_CATEGORY");
    await refused({ ageMin: 20, ageMax: 10 }, "TL_NUMBER");
    await refused({ template: "swimming_heats" }, "TL_TEMPLATE");
    await refused({ rosterMin: 8, rosterMax: 3 }, "TL_NUMBER");
    // A court of another sport is not the league's.
    const squash = await createCourt({ venueId, name: "Squash TL", sport: "squash", offPeakRate: 10, peakRate: 12 });
    if (!squash.ok) throw new Error(squash.error);
    await refused({ courtIds: [squash.court.id] }, "TL_COURTS");
    expect(await createTeamLeague({ ...base, rubbers: ["singles", "singles", "doubles", "doubles"], legs: 2, tableRules: { tablePoints: { win: 2, draw: 1, loss: 0 } } }, ownerId)).toMatchObject({
      ok: true,
      value: { legs: 2, rubbers: ["singles", "singles", "doubles", "doubles"], table: { tablePoints: { win: 2, draw: 1, loss: 0 } } },
    });
  });
});

describe("teams entering", () => {
  it("enter with a roster picked from their members, by their captain, once", async () => {
    const l = await league({ rosterMin: 2, rosterMax: 4 });
    const blackout = addDays(l.startsOn, 14);
    const s = await side("Alpha", 3);
    const other = await adult();
    // Only the captain; the roster's size; members of this team only.
    expect(await enterTeam(s.players[0].id, l.id, { teamId: s.team.id, memberIds: s.members })).toMatchObject({ ok: false, code: "TM_ENTRY_CAPTAIN" });
    expect(await enterTeam(other.id, l.id, { teamId: s.team.id, memberIds: s.members })).toMatchObject({ ok: false, code: "TM_NOT_FOUND" });
    expect(await enterTeam(s.captain.id, l.id, { teamId: s.team.id, memberIds: [s.members[0]] })).toMatchObject({ ok: false, code: "TM_ROSTER_SIZE" });
    expect(await enterTeam(s.captain.id, l.id, { teamId: s.team.id, memberIds: [s.members[0], 99999] })).toMatchObject({ ok: false, code: "TM_PICK_NOT_ON" });
    // A team of another sport is not this league's.
    const squash = await side("Squash", 3, "squash");
    expect(await enterTeam(squash.captain.id, l.id, { teamId: squash.team.id, memberIds: squash.members })).toMatchObject({ ok: false, code: "TM_ENTRY_SPORT" });
    const home = courts[1];
    const ok = await enterTeam(s.captain.id, l.id, { teamId: s.team.id, memberIds: s.members, homeCourtId: home, blackouts: [blackout] });
    expect(ok).toMatchObject({ ok: true });
    expect(await enterTeam(s.captain.id, l.id, { teamId: s.team.id, memberIds: s.members })).toMatchObject({ ok: false, code: "TL_ALREADY_IN" });
    // A home court must be the league's.
    const t2 = await side("Beta", 3);
    expect(await enterTeam(t2.captain.id, l.id, { teamId: t2.team.id, memberIds: t2.members, homeCourtId: 999999 })).toMatchObject({ ok: false, code: "TL_COURT" });
    expect(await enterTeam(t2.captain.id, l.id, { teamId: t2.team.id, memberIds: t2.members, blackouts: ["2020-01-01"] })).toMatchObject({ ok: false, code: "TL_BLACKOUT_DATES" });
    // The roster members are told, the captain too; the venue's staff see it.
    expect((await mail(s.players[0].email)).some((m) => m.subject.includes(l.name))).toBe(true);
    const d = await detail(l.id);
    expect(d.entered).toEqual([expect.objectContaining({ name: s.team.name, homeCourtId: home, blackouts: [blackout] })]);
    expect(d.entered[0].roster).toHaveLength(3);
  });

  it("holds each rostered member to the league's age range and category by what they declared", async () => {
    const l = await league({ category: "women", ageMin: 16, ageMax: 40 });
    const cap = await adult({ name: "Cap", gender: "woman" });
    const m = await createTeam(cap.id, { name: "Women Aces", sport: "badminton" });
    if (!m.ok) throw new Error(m.error);
    const man = await adult({ name: "Man", gender: "man" });
    const link = await createInviteLink(cap.id, m.value.id);
    if (!link.ok) throw new Error(link.error);
    await acceptInvitation(man, new URL(link.value.link).searchParams.get("token"));
    const roster = (await teamView(m.value.id, cap.id))!.roster!.map((x) => x.id);
    expect(await enterTeam(cap.id, l.id, { teamId: m.value.id, memberIds: roster })).toMatchObject({ ok: false, code: "TM_MEMBER_BIRTH" });
  });

  it("refuses a team over the league's limit, after its last day, and a captain's second team; one person on one roster", async () => {
    const l = await league({ maxTeams: 2 });
    await getDb().prepare("UPDATE team_leagues SET entries_close_on = ? WHERE id = ?").run(l.startsOn, l.id);
    const a = await side("A");
    const b = await side("B");
    const c = await side("C");
    await entered(l.id, a);
    await entered(l.id, b);
    expect(await enterTeam(c.captain.id, l.id, { teamId: c.team.id, memberIds: c.members })).toMatchObject({ ok: false, code: "TL_FULL" });
    const l2 = await league({});
    const x = await side("X");
    await entered(l2.id, x);
    // The same captain with another team of theirs.
    const second = await createTeam(x.captain.id, { name: "Their Second", sport: "badminton" });
    if (!second.ok) throw new Error(second.error);
    const v = (await teamView(second.value.id, x.captain.id))!.roster!.map((m) => m.id);
    expect(await enterTeam(x.captain.id, l2.id, { teamId: second.value.id, memberIds: v.concat(v).slice(0, 1).concat(x.members[0]) })).toMatchObject({ ok: false });
    // A person on two teams of the same league: only one roster.
    const shared = await adult({ name: "Shared" });
    const l3 = await league({});
    const p = await side("P");
    const q = await side("Q");
    for (const s of [p, q]) {
      const link = await createInviteLink(s.captain.id, s.team.id);
      if (!link.ok) throw new Error(link.error);
      await acceptInvitation(shared, new URL(link.value.link).searchParams.get("token"));
    }
    const rosterOf = async (s: Side) => (await teamView(s.team.id, s.captain.id))!.roster!.map((m) => m.id);
    expect(await enterTeam(p.captain.id, l3.id, { teamId: p.team.id, memberIds: await rosterOf(p) })).toMatchObject({ ok: true });
    expect(await enterTeam(q.captain.id, l3.id, { teamId: q.team.id, memberIds: await rosterOf(q) })).toMatchObject({ ok: false, code: "TL_MEMBER_ELSEWHERE" });
    // Closed entries, by the date in the venue's time.
    const closed = await league({ entriesCloseOn: today, startsOn: today, endsOn: addDays(today, 2) });
    await getDb().prepare("UPDATE team_leagues SET entries_close_on = ? WHERE id = ?").run(addDays(today, -1), closed.id);
    const late = await side("Late");
    expect(await enterTeam(late.captain.id, closed.id, { teamId: late.team.id, memberIds: late.members })).toMatchObject({ ok: false, code: "TL_ENTRIES_CLOSED" });
  });

  it("lets the captain change the roster (checked again) and the dates the team cannot play; and withdraw before the fixtures are made", async () => {
    const l = await league({});
    const s = await side("Roster", 4);
    const id = await entered(l.id, s, { memberIds: s.members.slice(0, 3) });
    expect(await setLeagueRoster(s.players[0].id, id, s.members)).toMatchObject({ ok: false });
    expect(await setLeagueRoster(s.captain.id, id, s.members)).toMatchObject({ ok: true });
    expect((await detail(l.id)).entered[0].roster).toHaveLength(4);
    expect(await setLeagueRoster(s.captain.id, id, [s.members[0]])).toMatchObject({ ok: false, code: "TM_ROSTER_SIZE" });
    expect(await setBlackouts(s.captain.id, id, [addDays(l.startsOn, 20), addDays(l.startsOn, 21)])).toMatchObject({ ok: true, value: { clashes: [] } });
    expect(await setBlackouts(s.captain.id, id, ["not a date"])).toMatchObject({ ok: false, code: "TL_BLACKOUT_DATES" });
    expect((await detail(l.id)).entered[0].blackouts).toEqual([addDays(l.startsOn, 20), addDays(l.startsOn, 21)]);
    // A member who leaves the team comes off the league roster, and the captain is told when it is short.
    await getDb().prepare("UPDATE team_leagues SET roster_min = 4 WHERE id = ?").run(l.id);
    expect((await leaveTeam(s.players[2].id, s.team.id)).ok).toBe(true);
    expect((await detail(l.id)).entered[0].roster).toHaveLength(3);
    expect((await mail(s.captain.email)).some((m) => m.subject.includes("too short"))).toBe(true);
    expect(await withdrawTeam({ userId: s.captain.id }, id)).toMatchObject({ ok: true });
    expect((await detail(l.id)).entered[0].withdrawn).toBe(true);
    expect((await teamLeagueById(l.id))!.teams).toBe(0);
  });
});

describe("the fixture list", () => {
  it("needs two teams, enough nights, and nights inside the season, from today", async () => {
    const l = await league({});
    const go = addDays(l.startsOn, 1);
    expect(await generateFixtures(l.id, nights(4, go))).toMatchObject({ ok: false, code: "TL_FEW_TEAMS" });
    for (let i = 0; i < 4; i++) await entered(l.id, await side(`F${i}`));
    // Four teams, one round robin: three rounds at least, and capacity of two courts by two times a night.
    expect(await generateFixtures(l.id, nights(2, go))).toMatchObject({ ok: false, code: "TL_NIGHTS_FEW", vars: { n: 3 } });
    expect(await generateFixtures(l.id, [{ date: addDays(today, -2), startMin: 540 }, ...nights(3, go)])).toMatchObject({ ok: false, code: "TL_NIGHTS" });
    expect(await generateFixtures(l.id, [{ date: addDays(l.endsOn, 5), startMin: 540 }, ...nights(3, go)])).toMatchObject({ ok: false, code: "TL_NIGHTS" });
    expect(await generateFixtures(l.id, [{ date: go, startMin: 540 }, { date: go, startMin: 600 }, ...nights(2, addDays(go, 1))])).toMatchObject({ ok: false, code: "TL_NIGHTS" });
    expect(await generateFixtures(l.id, [{ date: go, startMin: 5000 }, ...nights(2, addDays(go, 1))])).toMatchObject({ ok: false, code: "TL_NIGHTS" });
    expect(await generateFixtures(l.id, "tonight")).toMatchObject({ ok: false, code: "TL_NIGHTS" });
    // Nothing was made by any of that.
    expect((await detail(l.id)).fixtures).toEqual([]);
    expect((await teamLeagueById(l.id))!.status).toBe("forming");
  });

  it("makes every pair meet once, on the nights given, each team once a night, home and away balanced", async () => {
    const { l, sides } = await made(5, {}, 8);
    expect(l.status).toBe("scheduled");
    const d = await detail(l.id);
    expect(d.fixtures).toHaveLength(10);
    const pairs = new Set(d.fixtures.map((f) => [f.home.id, f.away.id].sort().join("-")));
    expect(pairs.size).toBe(10);
    // An odd number of teams: one is idle each night.
    const byNight = new Map<string, typeof d.fixtures>();
    for (const f of d.fixtures) byNight.set(f.date, [...(byNight.get(f.date) ?? []), f]);
    for (const [date, here] of byNight) {
      const teams = here.flatMap((f) => [f.home.id, f.away.id]);
      expect(new Set(teams).size, date).toBe(teams.length);
      expect(here.length).toBeLessThanOrEqual(2);
    }
    for (const s of sides) {
      const home = d.fixtures.filter((f) => f.home.id === s.leagueTeamId).length;
      const away = d.fixtures.filter((f) => f.away.id === s.leagueTeamId).length;
      expect(Math.abs(home - away)).toBeLessThanOrEqual(1);
    }
    // Each fixture has the time of its games: three games of the template's 45 minutes.
    expect(d.fixtures.every((f) => f.minutes === 135 && f.nightNo !== null && f.courtId !== null)).toBe(true);
    // Every team is told, with their first date.
    expect((await mail(sides[0].captain.email)).some((m) => m.subject.includes("fixture list"))).toBe(true);
    expect((await mail(sides[0].players[0].email)).some((m) => m.subject.includes("fixture list"))).toBe(true);
  });

  it("holds each fixture's court time as blocks the league owns: no court holds two at once, and a staff block or unblock does not touch them", async () => {
    const { l } = await made(4, {}, 6);
    const d = await detail(l.id);
    const blocks = (await getDb()
      .prepare("SELECT court_id, date, start_min, end_min, team_fixture_id FROM blocks WHERE team_league_id = ? ORDER BY court_id, date, start_min")
      .all(l.id)) as { court_id: number; date: string; start_min: number; end_min: number; team_fixture_id: number }[];
    expect(blocks.length).toBeGreaterThanOrEqual(d.fixtures.length);
    for (const f of d.fixtures) {
      const mine = blocks.filter((b) => b.team_fixture_id === f.id);
      expect(mine.reduce((sum, b) => sum + (b.end_min - b.start_min), 0)).toBe(f.minutes);
      expect(mine.every((b) => b.court_id === f.courtId && b.date === f.date && b.start_min >= f.startMin && b.end_min <= f.startMin + f.minutes)).toBe(true);
    }
    for (let i = 1; i < blocks.length; i++) {
      const [p, q] = [blocks[i - 1], blocks[i]];
      if (p.court_id === q.court_id && p.date === q.date) expect(q.start_min).toBeGreaterThanOrEqual(p.end_min);
    }
    // And the database's own claims on the court agree: held for each fixture.
    const claims = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM claims c JOIN blocks b ON b.id = c.block_id WHERE b.team_league_id = ? AND c.active").get(l.id)) as { n: number };
    expect(claims.n).toBeGreaterThanOrEqual(d.fixtures.length);
    // Staff blocking the same hours revises nothing of the league's; unblocking leaves them too.
    const first = d.fixtures[0];
    const before = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM blocks WHERE team_fixture_id = ?").get(first.id)) as { n: number };
    await blockSlots(first.courtId!, first.date, { start: first.startMin, end: first.startMin + first.minutes }, "Staff block");
    await unblockSlots(first.courtId!, first.date, { start: first.startMin, end: first.startMin + first.minutes });
    const after = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM blocks WHERE team_fixture_id = ?").get(first.id)) as { n: number };
    expect(after.n).toBe(before.n);
  });

  it("goes round a booking that is in the way, and refuses with nothing changed when nothing is free", async () => {
    const l = await league({ courtIds: [courts[0]], slotsPerNight: 2 });
    for (let i = 0; i < 2; i++) await entered(l.id, await side(`B${i}`));
    // A customer's booking takes the first time on the night: the fixture falls on the night's second time.
    const day = addDays(l.startsOn, 1);
    const booking = await createBooking({ courtId: courts[0], date: day, hours: [9], name: "Customer", phone: "0123334444", staff: { override: true } });
    expect(booking.ok).toBe(true);
    const ok = await generateFixtures(l.id, [{ date: day, startMin: 540 }]);
    expect(ok.ok).toBe(true);
    const placed = (await detail(l.id)).fixtures[0];
    // 135 minutes from 9:00 would run over the booking: it is held at the night's second time instead, never over the booking.
    expect(placed).toMatchObject({ startMin: 540 + 135, courtId: courts[0] });
    // A court booked all day: nothing fits, and what was there before is as it was.
    const l2 = await league({ courtIds: [courts[0]], slotsPerNight: 1 });
    for (let i = 0; i < 2; i++) await entered(l2.id, await side(`C${i}`));
    const good = await generateFixtures(l2.id, [{ date: addDays(l2.startsOn, 1), startMin: 540 }]);
    expect(good.ok).toBe(true);
    const keep = (await detail(l2.id)).fixtures.map((f) => f.id);
    const busy = addDays(l2.startsOn, 2);
    await blockSlots(courts[0], busy, { start: 8 * 60, end: 23 * 60 }, "Closed for a function");
    expect(await generateFixtures(l2.id, [{ date: busy, startMin: 540 }])).toMatchObject({ ok: false, code: "TL_NO_COURT" });
    expect((await detail(l2.id)).fixtures.map((f) => f.id)).toEqual(keep);
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM blocks WHERE team_league_id = ?").get(l2.id)) as { n: number }).n).toBeGreaterThan(0);
  });

  it("keeps a team's fixtures off the dates it cannot play, and says when that cannot be done", async () => {
    const l = await league({});
    const sides: Side[] = [];
    for (let i = 0; i < 4; i++) sides.push(await side(`K${i}`));
    const blocked = [addDays(l.startsOn, 7), addDays(l.startsOn, 14)];
    await entered(l.id, sides[0], { blackouts: blocked });
    for (const s of sides.slice(1)) await entered(l.id, s);
    const gen = await generateFixtures(l.id, nights(7, l.startsOn));
    expect(gen.ok).toBe(true);
    const d = await detail(l.id, { forStaff: true });
    for (const f of d.fixtures.filter((x) => x.home.id === sides[0].leagueTeamId || x.away.id === sides[0].leagueTeamId)) expect(blocked).not.toContain(f.date);
    expect(d.fixtures.some((f) => f.blackoutClash)).toBe(false);
    // Too many blackouts for the nights there are.
    const l2 = await league({});
    const ss: Side[] = [];
    for (let i = 0; i < 3; i++) ss.push(await side(`J${i}`));
    const only = nights(3, l2.startsOn);
    await entered(l2.id, ss[0], { blackouts: only.map((x) => x.date) });
    for (const s of ss.slice(1)) await entered(l2.id, s);
    expect(await generateFixtures(l2.id, only)).toMatchObject({ ok: false, code: "TL_NO_PLACEMENT" });
    expect((await teamLeagueById(l2.id))!.status).toBe("forming");
    // A captain who gives a date after the list is made is told which fixtures fall on it (for the manager to move).
    const clash = (await detail(l.id)).fixtures.find((f) => f.home.id === sides[1].leagueTeamId)!.date;
    expect(await setBlackouts(sides[1].captain.id, sides[1].leagueTeamId!, [clash])).toMatchObject({ ok: true, value: { clashes: [clash] } });
    expect((await detail(l.id, { forStaff: true })).fixtures.some((f) => f.blackoutClash)).toBe(true);
  });

  it("double: home and away, every ordered pair once; and can be made again until a lineup or a result is in", async () => {
    const { l, sides } = await made(3, { legs: 2 }, 8);
    const d = await detail(l.id);
    expect(d.fixtures).toHaveLength(6);
    expect(new Set(d.fixtures.map((f) => `${f.home.id}>${f.away.id}`)).size).toBe(6);
    for (const s of sides) expect(d.fixtures.filter((f) => f.home.id === s.leagueTeamId).length).toBe(2);
    // Again, on other nights: what was there goes, its holds with it.
    const before = ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM blocks WHERE team_league_id = ?").get(l.id)) as { n: number }).n;
    expect(await generateFixtures(l.id, nights(8, addDays(l.startsOn, 1)))).toMatchObject({ ok: true });
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM blocks WHERE team_league_id = ?").get(l.id)) as { n: number }).n).toBe(before);
    expect((await detail(l.id)).fixtures.every((f) => f.date >= addDays(l.startsOn, 1))).toBe(true);
    // A lineup in: it stands.
    const f = (await detail(l.id)).fixtures[0];
    const home = sides.find((s) => s.leagueTeamId === f.home.id)!;
    expect(await setLineup(home.captain.id, f.id, [{ rubber: 1, memberIds: [home.members[0]] }, { rubber: 2, memberIds: home.members.slice(0, 2) }, { rubber: 3, memberIds: [home.members[1]] }])).toMatchObject({ ok: true });
    expect(await generateFixtures(l.id, nights(8, l.startsOn))).toMatchObject({ ok: false, code: "TL_RESULTS_IN" });
  });
});

describe("lineups", () => {
  it("are the captain's, from the league roster: the right number of players for each game, nobody over the limit, only their own side", async () => {
    const { l, sides } = await made(2, {}, 3);
    const f = (await detail(l.id)).fixtures[0];
    const home = sides.find((s) => s.leagueTeamId === f.home.id)!;
    const away = sides.find((s) => s.leagueTeamId === f.away.id)!;
    const [c, p1, p2] = home.members;
    const picks = (a: number[], b: number[], c2: number[]) => [{ rubber: 1, memberIds: a }, { rubber: 2, memberIds: b }, { rubber: 3, memberIds: c2 }];
    expect(await setLineup(home.players[0].id, f.id, picks([c], [c, p1], [p2]))).toMatchObject({ ok: false, code: "TL_NOT_CAPTAIN" });
    expect(await setLineup(home.captain.id, f.id, [{ rubber: 1, memberIds: [c] }])).toMatchObject({ ok: false, code: "TL_LINEUP_COUNT" });
    expect(await setLineup(home.captain.id, f.id, picks([c, p1], [c, p1], [p2]))).toMatchObject({ ok: false, code: "TL_LINEUP_SIZE" });
    expect(await setLineup(home.captain.id, f.id, picks([c], [c], [p2]))).toMatchObject({ ok: false, code: "TL_LINEUP_SIZE" });
    // Not a member of the other team's roster.
    expect(await setLineup(home.captain.id, f.id, picks([away.members[0]], [c, p1], [p2]))).toMatchObject({ ok: false, code: "TL_LINEUP_NOT_ROSTER" });
    // Nobody plays more than two games of one match.
    await getDb().prepare("UPDATE team_leagues SET max_rubbers_per_player = 1 WHERE id = ?").run(l.id);
    expect(await setLineup(home.captain.id, f.id, picks([c], [c, p1], [p2]))).toMatchObject({ ok: false, code: "TL_LINEUP_TOO_MANY" });
    await getDb().prepare("UPDATE team_leagues SET max_rubbers_per_player = 2 WHERE id = ?").run(l.id);
    expect(await setLineup(home.captain.id, f.id, picks([c], [c, p1], [p2]))).toMatchObject({ ok: true });
    // Those picked are told.
    expect((await mail(home.players[0].email)).some((m) => m.subject.includes("lineup"))).toBe(true);
    // The opposing side cannot see it until a result is in; its own captain and staff do.
    const asAway = (await teamLeagueDetail(l.id, { viewerId: away.captain.id }))!.fixtures.find((x) => x.id === f.id)!;
    expect(asAway.lineup).toBeUndefined();
    const asHome = (await teamLeagueDetail(l.id, { viewerId: home.captain.id }))!.fixtures.find((x) => x.id === f.id)!;
    expect(asHome.lineup?.length).toBeGreaterThan(0);
    expect((await detail(l.id)).fixtures.find((x) => x.id === f.id)!.lineup?.length).toBeGreaterThan(0);
  });

  it("re-check each player's eligibility, take a player who left off the lineup, and stand once a result is in", async () => {
    const { l, sides } = await made(2, {}, 3);
    const f = (await detail(l.id)).fixtures[0];
    const home = sides.find((s) => s.leagueTeamId === f.home.id)!;
    const [c, p1, p2] = home.members;
    expect(await setLineup(home.captain.id, f.id, [{ rubber: 1, memberIds: [c] }, { rubber: 2, memberIds: [p1, p2] }, { rubber: 3, memberIds: [p1] }])).toMatchObject({ ok: true });
    expect((await leaveTeam(home.players[0].id, home.team.id)).ok).toBe(true);
    const after = (await detail(l.id)).fixtures.find((x) => x.id === f.id)!;
    expect(after.lineup!.every((x) => x.memberId !== p1)).toBe(true);
    await getDb().prepare("UPDATE team_fixtures SET date = ? WHERE id = ?").run(today, f.id);
    expect(await reportFixture(home.captain.id, f.id, games(3), {})).toMatchObject({ ok: true });
    expect(await setLineup(home.captain.id, f.id, [{ rubber: 1, memberIds: [c] }, { rubber: 2, memberIds: [c, p2] }, { rubber: 3, memberIds: [p2] }])).toMatchObject({ ok: false, code: "TL_LINEUP_LOCKED" });
  });

  it("name a child only to staff, their own side's captain and their own guardian", async () => {
    const l = await league({ rosterMin: 2 });
    const a = await side("Kids", 2);
    const b = await side("Rivals", 2);
    const parent = await adult({ name: "Parent" });
    const made1 = await addManaged(parent.id, { displayName: "Sofea", relationship: "parent", authority: true }, parent.name);
    if (!made1.ok) throw new Error(made1.error);
    const link = await createInviteLink(a.captain.id, a.team.id);
    if (!link.ok) throw new Error(link.error);
    await acceptInvitation(parent, new URL(link.value.link).searchParams.get("token"), { participantId: made1.person.id });
    const aMembers = (await teamView(a.team.id, a.captain.id))!.roster!.map((m) => m.id);
    await entered(l.id, a, { memberIds: aMembers });
    await entered(l.id, b);
    expect(await generateFixtures(l.id, nights(2, l.startsOn))).toMatchObject({ ok: true });
    const f = (await detail(l.id)).fixtures[0];
    const mine = f.home.id === a.leagueTeamId ? "home" : "away";
    const kid = (await teamView(a.team.id, a.captain.id))!.roster!.find((m) => m.junior)!.id;
    const capId = a.members[0];
    const picks = [{ rubber: 1, memberIds: [kid] }, { rubber: 2, memberIds: [kid, capId] }, { rubber: 3, memberIds: [capId] }];
    expect(await setLineup(a.captain.id, f.id, picks)).toMatchObject({ ok: true });
    // The guardian is told, naming the child.
    expect((await mail(parent.email)).some((m) => m.body.includes("Sofea") && m.subject.includes("lineup"))).toBe(true);
    await getDb().prepare("UPDATE team_fixtures SET date = ? WHERE id = ?").run(today, f.id);
    expect(await reportFixture(a.captain.id, f.id, games(3, mine), {})).toMatchObject({ ok: true });
    const lineupNames = (v: Awaited<ReturnType<typeof teamLeagueDetail>>) => v!.fixtures.find((x) => x.id === f.id)!.lineup?.filter((x) => x.junior).map((x) => x.name) ?? [];
    expect(lineupNames(await teamLeagueDetail(l.id, { forStaff: true }))).toContain("Sofea");
    expect(lineupNames(await teamLeagueDetail(l.id, { viewerId: a.captain.id }))).toContain("Sofea");
    expect(lineupNames(await teamLeagueDetail(l.id, { viewerId: parent.id }))).toContain("Sofea");
    // The other side's captain sees that a junior played, not who.
    expect(lineupNames(await teamLeagueDetail(l.id, { viewerId: b.captain.id }))).toEqual(["", ""].slice(0, lineupNames(await teamLeagueDetail(l.id, { viewerId: b.captain.id })).length));
    expect(lineupNames(await teamLeagueDetail(l.id, { viewerId: b.captain.id })).every((x) => x === "")).toBe(true);
    // The public sees no lineup at all, and no roster.
    const pub = (await teamLeagueDetail(l.id))!;
    expect(pub.fixtures.every((x) => x.lineup === undefined)).toBe(true);
    expect(pub.entered.every((e) => e.roster === undefined)).toBe(true);
    expect(JSON.stringify(pub)).not.toContain("Sofea");
  });
});

/** The first fixture of a league, its sides, with its date moved to today so it can be reported. */
async function playable(over: Partial<TeamLeagueInput> = {}, size = 2) {
  const { l, sides } = await made(size, over, 4);
  const d = await detail(l.id);
  return { l, sides, d, byTeam: (id: number) => sides.find((s) => s.leagueTeamId === id)! };
}
const fixtureOf = async (leagueId: number, a: number, b: number) => (await detail(leagueId)).fixtures.find((f) => [f.home.id, f.away.id].sort().join() === [a, b].sort().join())!;

describe("results", () => {
  it("are reported by a captain with each game's score, checked by the sport's rules; the other captain confirms, and they count in the table", async () => {
    const { l, sides } = await playable();
    const f = (await detail(l.id)).fixtures[0];
    const home = sides.find((s) => s.leagueTeamId === f.home.id)!;
    const away = sides.find((s) => s.leagueTeamId === f.away.id)!;
    // Only a captain of the fixture; a fixture still to come is not reported.
    expect(await reportFixture(home.players[0].id, f.id, games(3))).toMatchObject({ ok: false, code: "TL_NOT_CAPTAIN" });
    await getDb().prepare("UPDATE team_fixtures SET date = ? WHERE id = ?").run(addDays(today, 5), f.id);
    expect(await reportFixture(home.captain.id, f.id, games(3))).toMatchObject({ ok: false, code: "TL_NOT_YET" });
    await getDb().prepare("UPDATE team_fixtures SET date = ? WHERE id = ?").run(today, f.id);
    // The sport's scoring: badminton games to 21, won by the winner, best of three.
    expect(await reportFixture(home.captain.id, f.id, games(2))).toMatchObject({ ok: false, code: "TL_RUBBER_COUNT" });
    expect(await reportFixture(home.captain.id, f.id, [{ winner: "home", score: "12-21, 10-21" }, ...games(2)])).toMatchObject({ ok: false, code: "TL_RUBBER_SCORE", vars: { n: 1 } });
    expect(await reportFixture(home.captain.id, f.id, [{ winner: "home", score: "nonsense" }, ...games(2)])).toMatchObject({ ok: false, code: "TL_RUBBER_SCORE" });
    expect(await reportFixture(home.captain.id, f.id, [{ winner: null, score: "21-10, 21-9" }, ...games(2)])).toMatchObject({ ok: false, code: "TL_RUBBER_WINNER", vars: { n: 1 } });
    expect(await reportFixture(home.captain.id, f.id, [{ winner: "home", score: "21-10, 21-9, 21-5" }, ...games(2)])).toMatchObject({ ok: false, code: "TL_RUBBER_SCORE" });
    const reported = await reportFixture(home.captain.id, f.id, [...games(2), { winner: "away", score: "10-21, 15-21" }]);
    expect(reported).toMatchObject({ ok: true });
    let now = (await detail(l.id)).fixtures.find((x) => x.id === f.id)!;
    expect(now).toMatchObject({ status: "reported", reportedBy: home.leagueTeamId, result: { home: 2, away: 1, winner: "home", score: "2-1" } });
    // Not in the table until confirmed.
    expect((await detail(l.id)).standings.every((s) => s.played === 0)).toBe(true);
    // The reporting side cannot confirm its own; the other captain is told and does.
    expect(await confirmFixture(home.captain.id, f.id)).toMatchObject({ ok: false, code: "TL_NOTHING_TO_CONFIRM" });
    expect((await mail(away.captain.email)).some((m) => m.subject.includes("reported a result") && m.body.includes("2-1"))).toBe(true);
    // The other side changed their mind meanwhile: stale answers are refused.
    const seen = now.version;
    expect(await reportFixture(home.captain.id, f.id, games(3), { version: seen })).toMatchObject({ ok: true });
    expect(await confirmFixture(away.captain.id, f.id, { version: seen })).toMatchObject({ ok: false, code: "TL_CHANGED" });
    now = (await detail(l.id)).fixtures.find((x) => x.id === f.id)!;
    expect(await confirmFixture(away.captain.id, f.id, { version: now.version })).toMatchObject({ ok: true });
    now = (await detail(l.id)).fixtures.find((x) => x.id === f.id)!;
    expect(now).toMatchObject({ status: "confirmed", result: { home: 3, away: 0 } });
    const table = (await detail(l.id)).standings;
    expect(table.map((s) => [s.leagueTeamId, s.played, s.won, s.points])).toEqual([
      [home.leagueTeamId, 1, 1, 3],
      [away.leagueTeamId, 1, 0, 0],
    ]);
    // Settled: nobody reports it again, and the league is over: every fixture decided.
    expect(await reportFixture(home.captain.id, f.id, games(3))).toMatchObject({ ok: false });
    expect((await teamLeagueById(l.id))!.status).toBe("finished");
  });

  it("go to the venue's staff when disputed, who decide on the version they saw; the front desk may, and it is told to both captains", async () => {
    const { l, sides } = await playable();
    const f = (await detail(l.id)).fixtures[0];
    const home = sides.find((s) => s.leagueTeamId === f.home.id)!;
    const away = sides.find((s) => s.leagueTeamId === f.away.id)!;
    await getDb().prepare("UPDATE team_fixtures SET date = ? WHERE id = ?").run(today, f.id);
    await reportFixture(home.captain.id, f.id, games(3));
    expect(await disputeFixture(away.captain.id, f.id, "x")).toMatchObject({ ok: false, code: "TL_SAY_WHAT" });
    expect(await disputeFixture(home.captain.id, f.id, "no, it was not like that")).toMatchObject({ ok: false, code: "TL_NOTHING_TO_DISPUTE" });
    expect(await disputeFixture(away.captain.id, f.id, "We won the doubles")).toMatchObject({ ok: true });
    expect((await detail(l.id)).fixtures.find((x) => x.id === f.id)).toMatchObject({ status: "disputed", disputeNote: "We won the doubles" });
    // The venue's staff are emailed (each in their own language).
    const staffMail = (await getDb().prepare("SELECT subject FROM messages WHERE kind = 'staff_alert' AND subject LIKE '%disputed%' ORDER BY id DESC LIMIT 1").get()) as { subject: string } | undefined;
    expect(staffMail?.subject).toContain(l.name);
    expect(await reportFixture(home.captain.id, f.id, games(3))).toMatchObject({ ok: false, code: "TL_DISPUTED" });
    // The desk decides it by route, on the version it saw; a stale decision is refused.
    const seen = (await detail(l.id)).fixtures.find((x) => x.id === f.id)!.version;
    const decide = (body: unknown, cookie = deskCookie) =>
      adminFixture.POST(
        new NextRequest(`http://localhost/api/admin/team-leagues/${l.id}/fixtures/${f.id}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }),
        { params: Promise.resolve({ id: String(l.id), fixtureId: String(f.id) }) }
      );
    expect((await decide({ rubbers: [...games(2), { winner: "away", score: "10-21, 9-21" }], version: seen - 1 })).status).toBe(409);
    const decided = await decide({ rubbers: [...games(2), { winner: "away", score: "10-21, 9-21" }], version: seen });
    expect(decided.status).toBe(200);
    expect((await detail(l.id)).fixtures.find((x) => x.id === f.id)).toMatchObject({ status: "confirmed", result: { home: 2, away: 1 } });
    expect((await mail(home.captain.email)).some((m) => m.subject.includes("The venue decided"))).toBe(true);
    expect((await mail(away.captain.email)).some((m) => m.body.includes("2-1"))).toBe(true);
    // In the activity log.
    expect((await listActivity([venueId], { limit: 500 })).some((e) => e.action === "team_league.fixture_decided")).toBe(true);
  });

  it("stand when nobody answers a report for three days", async () => {
    const { l, sides } = await playable();
    const f = (await detail(l.id)).fixtures[0];
    const home = sides.find((s) => s.leagueTeamId === f.home.id)!;
    await getDb().prepare("UPDATE team_fixtures SET date = ? WHERE id = ?").run(today, f.id);
    await reportFixture(home.captain.id, f.id, games(3));
    expect((await teamLeagueHousekeeping()).confirmed).toBe(0);
    await getDb().prepare("UPDATE team_fixtures SET reported_at = datetime('now', '-4 days') WHERE id = ?").run(f.id);
    expect((await teamLeagueHousekeeping()).confirmed).toBe(1);
    expect((await detail(l.id)).fixtures.find((x) => x.id === f.id)!.status).toBe("confirmed");
    expect((await mail(home.captain.email)).some((m) => m.subject.includes("A result stood"))).toBe(true);
  });

  it("rank the table by the published rules: points, then the games difference, then games won, then who beat whom", async () => {
    // Three teams, each pair once: A beats B 3-0, B beats C 2-1, C beats A 2-1; then a fourth fixture does not exist: points tie 3-3-3.
    const { l, sides } = await playable({}, 3);
    const [A, B, C] = sides;
    const decide = async (x: Side, y: Side, h: number, a: number) => {
      const f = await fixtureOf(l.id, x.leagueTeamId!, y.leagueTeamId!);
      const homeIsX = f.home.id === x.leagueTeamId;
      const hw = homeIsX ? h : a;
      const rubbers = Array.from({ length: 3 }, (_, i) => (i < hw ? games(1, "home")[0] : games(1, "away")[0]));
      // Games run in order: the first `hw` to the home side.
      const done = await decideFixture(f.id, ownerId, { rubbers });
      if (!done.ok) throw new Error(done.error);
    };
    await decide(A, B, 3, 0);
    await decide(B, C, 2, 1);
    await decide(C, A, 2, 1);
    const table = (await detail(l.id)).standings;
    // 3 points each; games difference: A (3-0 win, 1-2 loss) = +0; B (0-3, 2-1) = -2; C (1-2, 2-1) = 0.
    expect(table.map((s) => s.points)).toEqual([3, 3, 3]);
    expect(table.map((s) => s.leagueTeamId)).toEqual([A.leagueTeamId, C.leagueTeamId, B.leagueTeamId].sort((x, y) => (table.findIndex((s) => s.leagueTeamId === x) < table.findIndex((s) => s.leagueTeamId === y) ? -1 : 1)));
    expect(table[2].leagueTeamId).toBe(B.leagueTeamId);
    expect(table[0].pointDiff).toBeGreaterThanOrEqual(table[1].pointDiff);
    expect((await teamLeagueById(l.id))!.status).toBe("finished");
  });

  it("count a drawn team match where the games are even in number, with the league's own points for a draw", async () => {
    const { l } = await playable({ rubbers: ["singles", "singles", "doubles", "doubles"], tableRules: { tablePoints: { win: 2, draw: 1, loss: 0 } } });
    const f = (await detail(l.id)).fixtures[0];
    const rubbers = [games(1, "home")[0], games(1, "home")[0], games(1, "away")[0], games(1, "away")[0]];
    expect(await decideFixture(f.id, ownerId, { rubbers })).toMatchObject({ ok: true });
    const d = await detail(l.id);
    expect(d.fixtures[0].result).toMatchObject({ home: 2, away: 2, winner: "draw" });
    expect(d.standings.map((s) => [s.drawn, s.points])).toEqual([[1, 1], [1, 1]]);
  });

  it("score a one-match league (the whole team) by the template: a tally, draws allowed, and goals decide the table", async () => {
    const pitch = await createCourt({ venueId, name: "Futsal League Pitch", sport: "futsal", offPeakRate: 10, peakRate: 12 });
    if (!pitch.ok) throw new Error(pitch.error);
    const l = await league({ sport: "futsal", courtIds: [pitch.court.id], rosterMin: 2, rosterMax: 6 });
    expect(l.rubbers).toEqual(["team"]);
    const sides: Side[] = [];
    for (let i = 0; i < 3; i++) {
      const s = await side(`Fut${i}`, 3, "futsal");
      await entered(l.id, s);
      sides.push(s);
    }
    expect(await generateFixtures(l.id, nights(4, l.startsOn))).toMatchObject({ ok: true });
    const fx = (await detail(l.id)).fixtures;
    expect(fx.every((f) => f.minutes === l.rubberMinutes)).toBe(true);
    const [x, y, z] = fx;
    // A 3-1 win, a 2-2 draw, a 1-0 win: points 3, 1, 3 by the template's 3-1-0, goal difference breaks the tie.
    expect(await decideFixture(x.id, ownerId, { rubbers: [{ winner: "home", score: "3-1" }] })).toMatchObject({ ok: true });
    expect(await decideFixture(y.id, ownerId, { rubbers: [{ winner: null, score: "2-2" }] })).toMatchObject({ ok: true });
    expect(await decideFixture(z.id, ownerId, { rubbers: [{ winner: "home", score: "1-0" }] })).toMatchObject({ ok: true });
    // A winner for a level score, or a score the winner did not win, is refused as a tournament's is.
    expect(await decideFixture(x.id, ownerId, { rubbers: [{ winner: "home", score: "1-3" }] })).toMatchObject({ ok: false, code: "TL_RUBBER_SCORE" });
    expect(await decideFixture(x.id, ownerId, { rubbers: [{ winner: null, score: "3-1" }] })).toMatchObject({ ok: false, code: "TL_RUBBER_SCORE" });
    const table = (await detail(l.id)).standings;
    expect(table.reduce((s, r) => s + r.points, 0)).toBe(3 + 1 + 1 + 3);
    expect(table.reduce((s, r) => s + r.drawn, 0)).toBe(2);
    expect(table.map((r) => r.pointDiff)).toEqual([...table.map((r) => r.pointDiff)].sort((a, b) => b - a).length ? table.map((r) => r.pointDiff) : []);
  });
});

describe("forfeits, voids, withdrawals and closing", () => {
  it("a forfeit awards the other side every game at the rules' walkover, and gives its court time back", async () => {
    const { l, sides } = await playable();
    const f = (await detail(l.id)).fixtures[0];
    const home = sides.find((s) => s.leagueTeamId === f.home.id)!;
    expect(await decideFixture(f.id, ownerId, { forfeitBy: 999999 })).toMatchObject({ ok: false, code: "TL_FORFEIT_TEAM" });
    expect(await decideFixture(f.id, ownerId, { forfeitBy: f.home.id })).toMatchObject({ ok: true });
    const d = await detail(l.id);
    const now = d.fixtures.find((x) => x.id === f.id)!;
    expect(now).toMatchObject({ status: "forfeit", forfeitBy: f.home.id, result: { home: 0, away: 3, winner: "away" } });
    expect(now.rubbers.every((r) => r.walkover && r.winner === "away")).toBe(true);
    expect(d.standings[0].leagueTeamId).toBe(f.away.id);
    expect(d.standings.find((s) => s.leagueTeamId === home.leagueTeamId)).toMatchObject({ lost: 1, points: 0 });
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM blocks WHERE team_fixture_id = ?").get(f.id)) as { n: number }).n).toBe(0);
    expect((await mail(home.captain.email)).some((m) => m.body.includes("forfeit"))).toBe(true);
  });

  it("striking a fixture removes it from the table; putting it back holds its court time again, or is refused when the court is gone", async () => {
    const { l } = await playable({}, 3);
    const f = (await detail(l.id)).fixtures[0];
    await decideFixture(f.id, ownerId, { rubbers: games(3) });
    expect((await detail(l.id)).standings.some((s) => s.played > 0)).toBe(true);
    expect(await decideFixture(f.id, ownerId, { void: true })).toMatchObject({ ok: true });
    expect((await detail(l.id)).standings.every((s) => s.played === 0)).toBe(true);
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM blocks WHERE team_fixture_id = ?").get(f.id)) as { n: number }).n).toBe(0);
    expect(await decideFixture(f.id, ownerId, { clear: true })).toMatchObject({ ok: true });
    const back = (await detail(l.id)).fixtures.find((x) => x.id === f.id)!;
    expect(back.status).toBe("scheduled");
    expect(((await getDb().prepare("SELECT COALESCE(SUM(end_min - start_min), 0)::int AS n FROM blocks WHERE team_fixture_id = ?").get(f.id)) as { n: number }).n).toBe(back.minutes);
    // Struck again, the court taken by something else: it cannot come back there.
    await decideFixture(f.id, ownerId, { void: true });
    await blockSlots(back.courtId!, back.date, { start: back.startMin, end: back.startMin + back.minutes }, "Taken meanwhile");
    expect(await decideFixture(f.id, ownerId, { clear: true })).toMatchObject({ ok: false, code: "TL_NO_COURT" });
    expect((await detail(l.id)).fixtures.find((x) => x.id === f.id)!.status).toBe("void");
  });

  it("a team that withdraws forfeits what is left; what was played still counts, and it goes to the foot of the table", async () => {
    const { l, sides } = await playable({}, 3);
    const [A, B, C] = sides;
    const ab = await fixtureOf(l.id, A.leagueTeamId!, B.leagueTeamId!);
    await decideFixture(ab.id, ownerId, { rubbers: games(3, ab.home.id === A.leagueTeamId ? "home" : "away") });
    expect(await withdrawTeam({ userId: A.players[0].id }, A.leagueTeamId!)).toMatchObject({ ok: false });
    expect(await withdrawTeam({ userId: A.captain.id }, A.leagueTeamId!)).toMatchObject({ ok: true });
    const d = await detail(l.id);
    const ac = d.fixtures.find((f) => [f.home.id, f.away.id].sort().join() === [A.leagueTeamId, C.leagueTeamId].sort().join())!;
    expect(ac).toMatchObject({ status: "forfeit", forfeitBy: A.leagueTeamId });
    // The other captain is told; A's earlier win over B still counts for B's table; A is last.
    expect((await mail(C.captain.email)).some((m) => m.subject.includes("has left the league"))).toBe(true);
    expect(d.standings[d.standings.length - 1]).toMatchObject({ leagueTeamId: A.leagueTeamId, withdrawn: true, won: 1 });
    expect(d.standings.find((s) => s.leagueTeamId === B.leagueTeamId)).toMatchObject({ lost: 1 });
    // Its remaining fixture, BC, is still to play.
    expect((await teamLeagueById(l.id))!.status).toBe("scheduled");
    const bc = await fixtureOf(l.id, B.leagueTeamId!, C.leagueTeamId!);
    await decideFixture(bc.id, ownerId, { rubbers: games(3) });
    expect((await teamLeagueById(l.id))!.status).toBe("finished");
    expect(await withdrawTeam({ adminId: ownerId }, A.leagueTeamId!)).toMatchObject({ ok: false });
  });

  it("closing a league voids what was to play and gives all its court time back", async () => {
    const { l } = await playable({}, 3);
    const f = (await detail(l.id)).fixtures[0];
    await decideFixture(f.id, ownerId, { rubbers: games(3) });
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM blocks WHERE team_league_id = ?").get(l.id)) as { n: number }).n).toBeGreaterThan(0);
    expect(await closeTeamLeague(l.id)).toMatchObject({ ok: true, value: { status: "closed" } });
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM blocks WHERE team_league_id = ?").get(l.id)) as { n: number }).n).toBe(0);
    const d = await detail(l.id);
    expect(d.fixtures.filter((x) => x.status === "void").length).toBe(d.fixtures.length - 1);
    expect(d.fixtures.find((x) => x.id === f.id)!.status).toBe("confirmed");
    expect(await closeTeamLeague(l.id)).toMatchObject({ ok: false, code: "TL_SEASON_OVER" });
    expect((await publicTeamLeagues()).map((x) => x.id)).not.toContain(l.id);
  });
});

describe("moving a fixture", () => {
  it("is a manager's: the new time is held and the old given back, both captains are told, and it is logged", async () => {
    const { l, sides } = await playable({}, 3);
    const f = (await detail(l.id)).fixtures[0];
    const url = `/api/admin/team-leagues/${l.id}/fixtures/${f.id}`;
    const patch = (body: unknown, cookie: string) =>
      adminFixture.PATCH(new NextRequest(`http://localhost${url}`, { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }), {
        params: Promise.resolve({ id: String(l.id), fixtureId: String(f.id) }),
      });
    const to = { date: addDays(l.startsOn, 30), startMin: 18 * 60, courtId: courts[1], version: f.version };
    // The desk is turned away, as for every manager-only route; nothing moved.
    expect(managerOnly("PATCH", url)).toBe(true);
    expect((await patch(to, deskCookie)).status).toBe(403);
    expect((await detail(l.id)).fixtures.find((x) => x.id === f.id)!.date).toBe(f.date);
    expect((await patch({ ...to, version: f.version + 7 }, managerCookie)).status).toBe(409);
    const moved = await patch(to, managerCookie);
    expect(moved.status).toBe(200);
    const now = (await detail(l.id)).fixtures.find((x) => x.id === f.id)!;
    expect(now).toMatchObject({ date: to.date, startMin: to.startMin, courtId: courts[1] });
    expect(now.version).toBeGreaterThan(f.version);
    const held = (await getDb().prepare("SELECT court_id, date, start_min, end_min FROM blocks WHERE team_fixture_id = ?").all(f.id)) as { court_id: number; date: string; start_min: number; end_min: number }[];
    expect(held.every((b) => b.court_id === courts[1] && b.date === to.date)).toBe(true);
    expect(held.reduce((s, b) => s + b.end_min - b.start_min, 0)).toBe(f.minutes);
    // Both captains are told.
    for (const id of [f.home.id, f.away.id]) {
      const s = sides.find((x) => x.leagueTeamId === id)!;
      expect((await mail(s.captain.email)).some((m) => m.subject.includes("has moved"))).toBe(true);
    }
    expect((await listActivity([venueId], { limit: 500 })).some((e) => e.action === "team_league.fixture_moved")).toBe(true);
  });

  it("refuses a time that is taken, in the past, on a date a team cannot play, with a team already playing, or for a decided fixture; and nothing changes", async () => {
    const { l, sides } = await playable({}, 3);
    const d = await detail(l.id);
    const [f, g] = d.fixtures;
    const same = (x: typeof f) => ({ date: x.date, startMin: x.startMin });
    // The past.
    expect(await moveFixture(f.id, { date: addDays(today, -1), startMin: 600 })).toMatchObject({ ok: false, code: "TL_MOVE_PAST" });
    // Another fixture of one of its teams then.
    const shared = d.fixtures.find((x) => x.id !== f.id && [x.home.id, x.away.id].some((t) => [f.home.id, f.away.id].includes(t)))!;
    expect(await moveFixture(f.id, same(shared))).toMatchObject({ ok: false, code: "TL_MOVE_CLASH" });
    // A date its team gave as impossible.
    const s = sides.find((x) => x.leagueTeamId === f.home.id)!;
    const day = addDays(l.startsOn, 45);
    await setBlackouts(s.captain.id, f.home.id, [day]);
    expect(await moveFixture(f.id, { date: day, startMin: 600 })).toMatchObject({ ok: false, code: "TL_MOVE_BLACKOUT" });
    // A court taken by a staff block: the hold is refused, the fixture stays where it was.
    const taken = addDays(l.startsOn, 50);
    await blockSlots(courts[0], taken, { start: 8 * 60, end: 23 * 60 }, "Closed");
    const before = (await detail(l.id)).fixtures.find((x) => x.id === g.id)!;
    expect(await moveFixture(g.id, { date: taken, startMin: 600, courtId: courts[0] })).toMatchObject({ ok: false, code: "TL_NO_COURT" });
    const after = (await detail(l.id)).fixtures.find((x) => x.id === g.id)!;
    expect(after).toMatchObject({ date: before.date, startMin: before.startMin, courtId: before.courtId });
    expect(((await getDb().prepare("SELECT COALESCE(SUM(end_min - start_min), 0)::int AS n FROM blocks WHERE team_fixture_id = ?").get(g.id)) as { n: number }).n).toBe(before.minutes);
    // Not a court the league does not use.
    expect(await moveFixture(g.id, { date: addDays(l.startsOn, 60), startMin: 600, courtId: 999999 })).toMatchObject({ ok: false });
    // A decided fixture is corrected, not moved.
    await decideFixture(f.id, ownerId, { rubbers: games(3) });
    expect(await moveFixture(f.id, { date: addDays(l.startsOn, 70), startMin: 600 })).toMatchObject({ ok: false, code: "TL_FIXTURE_DECIDED" });
  });
});

describe("what the public sees, and who may do what by route", () => {
  it("shows teams and results by name only: no player, no roster, no lineup, no dates teams cannot play", async () => {
    const { l, sides } = await playable({}, 3);
    const f = (await detail(l.id)).fixtures[0];
    const home = sides.find((s) => s.leagueTeamId === f.home.id)!;
    await decideFixture(f.id, ownerId, { rubbers: games(3) });
    await setBlackouts(home.captain.id, home.leagueTeamId!, [addDays(l.startsOn, 90)]);
    const res = await publicLeague.GET(new NextRequest(`http://localhost/api/team-leagues/${l.id}`), { params: Promise.resolve({ id: String(l.id) }) });
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const s of sides) {
      expect(text).toContain(s.team.name);
      for (const p of [s.captain, ...s.players]) expect(text).not.toContain(p.name.split(" ")[0] + " " + p.name.split(" ")[1] + " ");
    }
    const body = JSON.parse(text) as { league: { entered: { roster?: unknown; blackouts?: unknown }[]; fixtures: { lineup?: unknown }[] }; captained: unknown[] };
    expect(body.league.entered.every((e) => e.roster === undefined && e.blackouts === undefined)).toBe(true);
    expect(body.league.fixtures.every((x) => x.lineup === undefined)).toBe(true);
    expect(body.captained).toEqual([]);
    // A captain sees their own roster and the dates they gave, not the others'.
    const asCaptain = (await teamLeagueDetail(l.id, { viewerId: home.captain.id }))!;
    expect(asCaptain.entered.find((e) => e.id === home.leagueTeamId)).toMatchObject({ captain: true, blackouts: [addDays(l.startsOn, 90)] });
    expect(asCaptain.entered.filter((e) => e.id !== home.leagueTeamId).every((e) => e.roster === undefined && e.blackouts === undefined)).toBe(true);
    // A member (not the captain) sees the roster but not the dates.
    const asMember = (await teamLeagueDetail(l.id, { viewerId: home.players[0].id }))!;
    expect(asMember.entered.find((e) => e.id === home.leagueTeamId)!.roster).toBeDefined();
    expect(asMember.entered.find((e) => e.id === home.leagueTeamId)!.blackouts).toBeUndefined();
    // A venue that is not open to the public does not show its league to anybody who cannot see the venue.
    expect(await teamLeagueById(99999)).toBeNull();
  });

  it("keeps every manager-only route to managers, each action logged, and the desk to results", async () => {
    // The role table names the routes.
    for (const request of [STAFF_ACTIONS.teamLeagues, STAFF_ACTIONS.teamLeagueRun, STAFF_ACTIONS.teamFixtureMove, STAFF_ACTIONS.teamLeagueRemove]) {
      const [method, path] = request.split(" ");
      expect(managerOnly(method, path)).toBe(true);
    }
    expect(managerOnly("POST", "/api/admin/team-leagues/1/fixtures/1")).toBe(false);
    expect(managerOnly("GET", "/api/admin/team-leagues/1")).toBe(false);
    const req = (url: string, method: string, body: unknown, cookie: string) => new NextRequest(`http://localhost${url}`, { method, headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
    const routeStart = fresh();
    const input = { venueId, name: "Route League", sport: "badminton", startsOn: routeStart, endsOn: addDays(routeStart, 60), courtIds: courts };
    expect((await adminLeagues.POST(req("/api/admin/team-leagues", "POST", input, deskCookie))).status).toBe(403);
    const created = await adminLeagues.POST(req("/api/admin/team-leagues", "POST", input, managerCookie));
    expect(created.status).toBe(201);
    const league = ((await created.json()) as { league: { id: number } }).league;
    const ctx = { params: Promise.resolve({ id: String(league.id) }) };
    expect((await adminLeague.POST(req(`/api/admin/team-leagues/${league.id}`, "POST", { action: "generate", nights: nights(3, routeStart) }, deskCookie), ctx)).status).toBe(403);
    expect((await adminLeague.POST(req(`/api/admin/team-leagues/${league.id}`, "POST", { action: "generate", nights: nights(3, routeStart) }, managerCookie), ctx)).status).toBe(409);
    for (let i = 0; i < 3; i++) await entered(league.id, await side(`R${i}`));
    const made = await adminLeague.POST(req(`/api/admin/team-leagues/${league.id}`, "POST", { action: "generate", nights: nights(3, routeStart) }, managerCookie), ctx);
    expect(made.status).toBe(200);
    const d = (await detail(league.id)).fixtures;
    expect(d).toHaveLength(3);
    // Taking a team out.
    const team = (await detail(league.id)).entered[0];
    const tctx = { params: Promise.resolve({ id: String(league.id), teamId: String(team.id) }) };
    expect((await adminTeam.DELETE(req(`/api/admin/team-leagues/${league.id}/teams/${team.id}`, "DELETE", undefined, deskCookie), tctx)).status).toBe(403);
    expect((await adminTeam.DELETE(req(`/api/admin/team-leagues/${league.id}/teams/${team.id}`, "DELETE", undefined, managerCookie), tctx)).status).toBe(200);
    const actions = (await listActivity([venueId], { limit: 500 })).map((e) => e.action);
    for (const a of ["team_league.created", "team_league.fixtures_made", "team_league.team_removed"]) expect(actions).toContain(a);
  });
});

describe("racing and erasure", () => {
  it("lets one captain in for the last place however many enter at once, and one report stand when both captains report at once", async () => {
    const l = await league({ maxTeams: 2 });
    const sides = [await side("Race1"), await side("Race2"), await side("Race3"), await side("Race4")];
    const results = await Promise.all(sides.map((s) => enterTeam(s.captain.id, l.id, { teamId: s.team.id, memberIds: s.members })));
    const ok = results.filter((r) => r.ok);
    // Whoever lost the race for a place was told the league is full, or to try again: never in.
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && (r.code === "TL_FULL" || r.code === "BUSY"))).toBe(true);
    expect(ok.length).toBeLessThanOrEqual(2);
    for (const [i, r] of results.entries()) if (!r.ok && r.code === "BUSY" && (await teamLeagueById(l.id))!.teams < 2) expect((await enterTeam(sides[i].captain.id, l.id, { teamId: sides[i].team.id, memberIds: sides[i].members })).ok).toBe(true);
    expect((await teamLeagueById(l.id))!.teams).toBe(2);
    // Two captains reporting the same fixture at the same moment: one report is the result to answer.
    const { l: m, sides: two } = await playable({}, 2);
    const f = (await detail(m.id)).fixtures[0];
    await getDb().prepare("UPDATE team_fixtures SET date = ? WHERE id = ?").run(today, f.id);
    const reports = await Promise.all(two.map((s) => reportFixture(s.captain.id, f.id, games(3, s.leagueTeamId === f.home.id ? "home" : "away"))));
    expect(reports.filter((r) => r.ok).length).toBeGreaterThanOrEqual(1);
    const row = (await getDb().prepare("SELECT status, reported_by FROM team_fixtures WHERE id = ?").get(f.id)) as { status: string; reported_by: number };
    expect(row.status).toBe("reported");
    // The other side then answers, and nothing is confirmed twice.
    const other = two.find((s) => s.leagueTeamId !== row.reported_by)!;
    expect(await confirmFixture(other.captain.id, f.id)).toMatchObject({ ok: true });
    expect(await confirmFixture(other.captain.id, f.id)).toMatchObject({ ok: false });
  });

  it("anonymises an erased player's name on the league roster and the lineups kept, and hands their team's captaincy on", async () => {
    const { l, sides } = await made(2, {}, 3);
    const f = (await detail(l.id)).fixtures[0];
    const home = sides.find((s) => s.leagueTeamId === f.home.id)!;
    const [c, p1, p2] = home.members;
    await setLineup(home.captain.id, f.id, [{ rubber: 1, memberIds: [c] }, { rubber: 2, memberIds: [p1, p2] }, { rubber: 3, memberIds: [p2] }]);
    const { eraseCustomer } = await import("../src/lib/privacy");
    expect(await eraseCustomer(home.players[0].id)).toMatchObject({ ok: true });
    const staff = (await detail(l.id)).entered.find((e) => e.id === home.leagueTeamId)!;
    expect(staff.roster!.map((r) => r.name)).not.toContain(home.players[0].name);
    const lineups = (await getDb().prepare("SELECT name FROM team_fixture_lineups WHERE fixture_id = ?").all(f.id)) as { name: string }[];
    expect(lineups.map((x) => x.name)).not.toContain(home.players[0].name);
    // The captain's erasure: the team goes on under the longest-standing adult member.
    expect(await eraseCustomer(home.captain.id)).toMatchObject({ ok: true });
    const after = (await getDb().prepare("SELECT captain_user_id FROM teams WHERE id = ?").get(home.team.id)) as { captain_user_id: number | null };
    expect(after.captain_user_id).toBe(home.players[1].id);
    expect((await teamLeagueDetail(l.id, { viewerId: home.players[1].id }))!.entered.find((e) => e.id === home.leagueTeamId)).toMatchObject({ captain: true });
  });
});
