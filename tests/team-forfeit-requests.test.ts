import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { saveProfile } from "../src/lib/player-profiles";
import { createCourt, listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { acceptInvitation, createInviteLink, createTeam, teamView, type Team } from "../src/lib/teams";
import { setEventRated } from "../src/lib/ratings";
import { STAFF_ACTIONS, managerOnly, staffMay } from "../src/lib/roles";
import { confirmFixture, createTeamLeague, decideFixture, enterTeam, generateFixtures, moveFixture, reportFixture, teamLeagueById, teamLeagueDetail, teamLeagueHousekeeping, withdrawTeam, type TeamLeagueInput } from "../src/lib/team-leagues";
import { decideForfeitRequest, requestForfeit, withdrawForfeitRequest } from "../src/lib/team-forfeits";
import { listActivity } from "../src/lib/activity";
import * as adminFixture from "../src/app/api/admin/team-leagues/[id]/fixtures/[fixtureId]/route";
import * as adminForfeit from "../src/app/api/admin/team-leagues/[id]/fixtures/[fixtureId]/forfeit/route";
import * as adminAsk from "../src/app/api/admin/team-leagues/[id]/fixtures/[fixtureId]/forfeit-requests/route";
import * as adminDecide from "../src/app/api/admin/team-leagues/[id]/forfeit-requests/[requestId]/route";
import * as publicLeague from "../src/app/api/team-leagues/[id]/route";

/**
 * Forfeits in a league of teams are a manager's (lib/team-forfeits.ts; migration 0276). A captain, or a member of staff, may ask for one;
 * a request changes nothing else; a manager confirms it (the existing forfeit path) or declines it; and every decision is audited.
 */

vi.setConfig({ testTimeout: 90_000 });

let ownerId: number;
let venueId: number;
let courts: number[];
let managerCookie: string;
let deskCookie: string;
let managerId: number;
let deskId: number;
let managerMail: string;
let deskMail: string;
let n = 0;
const today = todayISO();

afterEach(() => vi.useRealTimers());

async function adult(name = "Player"): Promise<User> {
  n++;
  const made = await registerUser({ name: `${name} ${n}`, email: `ff${n}@leagues.test`, phone: `01391${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now'), verified_phone = phone WHERE id = ?").run(made.user.id);
  await saveProfile(made.user.id, { adult: true });
  return made.user;
}

interface Side {
  captain: User;
  team: Team;
  members: number[];
  players: User[];
  leagueTeamId?: number;
}

async function side(label: string, size = 3): Promise<Side> {
  const captain = await adult(`${label} Captain`);
  n++;
  const made = await createTeam(captain.id, { name: `${label} ${n}`, sport: "badminton" });
  if (!made.ok) throw new Error(made.error);
  const players: User[] = [];
  for (let i = 1; i < size; i++) {
    const p = await adult(`${label} Player`);
    const link = await createInviteLink(captain.id, made.value.id);
    if (!link.ok) throw new Error(link.error);
    const done = await acceptInvitation(p, new URL(link.value.link).searchParams.get("token"), {});
    if (!done.ok) throw new Error(done.error);
    players.push(p);
  }
  const view = (await teamView(made.value.id, captain.id))!;
  return { captain, team: made.value, members: view.roster!.map((m) => m.id), players };
}

let seasons = 0;
const fresh = () => addDays(today, 3 + 80 * seasons++);
const nights = (count: number, from: string, gap = 7, startMin = 9 * 60) => Array.from({ length: count }, (_, i) => ({ date: addDays(from, i * gap), startMin }));

async function made(size: number, over: Partial<TeamLeagueInput> = {}, count = 8, rated = false) {
  n++;
  const startsOn = fresh();
  const lg = await createTeamLeague({ venueId, name: `Forfeit League ${n}`, sport: "badminton", startsOn, endsOn: addDays(startsOn, 300), courtIds: courts, ...over }, ownerId);
  if (!lg.ok) throw new Error(lg.error);
  if (rated) expect(await setEventRated("team_league", lg.value.id, true)).toMatchObject({ ok: true });
  const sides: Side[] = [];
  for (let i = 0; i < size; i++) {
    const s = await side(`T${i + 1}`);
    const done = await enterTeam(s.captain.id, lg.value.id, { teamId: s.team.id, memberIds: s.members });
    if (!done.ok) throw new Error(done.error);
    s.leagueTeamId = done.value.leagueTeamId;
    sides.push(s);
  }
  const gen = await generateFixtures(lg.value.id, nights(count, lg.value.startsOn));
  if (!gen.ok) throw new Error(gen.error);
  return { l: (await teamLeagueById(lg.value.id))!, sides };
}

const detail = async (id: number) => (await teamLeagueDetail(id, { forStaff: true }))!;
const asViewer = async (id: number, viewerId: number) => (await teamLeagueDetail(id, { viewerId }))!;
const mail = async (to: string) => (await getDb().prepare("SELECT subject, body FROM messages WHERE kind IN ('programme', 'team_decision') AND recipient = ? ORDER BY id").all(to)) as { subject: string; body: string }[];
const staffMail = async (to: string) => ((await getDb().prepare("SELECT params AS vars FROM messages WHERE kind = 'staff_alert' AND recipient = ? ORDER BY id").all(to)) as { vars: string }[]).map((m) => m.vars);
const games = (count: number, winner: "home" | "away" = "home", score = "21-10, 21-12") =>
  Array.from({ length: count }, () => ({ winner, score: winner === "home" ? score : score.replace(/(\d+)-(\d+)/g, "$2-$1") }));
const heldMinutes = async (fixtureId: number) =>
  ((await getDb().prepare("SELECT COALESCE(SUM(end_min - start_min), 0)::int AS n FROM blocks WHERE team_fixture_id = ?").get(fixtureId)) as { n: number }).n;
const requestRows = async (fixtureId: number) => (await getDb().prepare("SELECT * FROM team_forfeit_requests WHERE fixture_id = ? ORDER BY id").all(fixtureId)) as Record<string, unknown>[];
const fixtureOf = async (leagueId: number, a: number, b: number) => (await detail(leagueId)).fixtures.find((f) => [f.home.id, f.away.id].sort().join() === [a, b].sort().join())!;
const sideOf = (sides: Side[], leagueTeamId: number) => sides.find((s) => s.leagueTeamId === leagueTeamId)!;

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Response | Promise<Response>;
const call = (handler: unknown, method: string, url: string, cookie: string, body: unknown, params: Record<string, string>) =>
  (handler as Handler)(new NextRequest(`http://localhost${url}`, { method, headers: { "content-type": "application/json", cookie, origin: "http://localhost" }, body: method === "DELETE" ? undefined : JSON.stringify(body) }), {
    params: Promise.resolve(params),
  });

beforeAll(async () => {
  await ensureBootstrapAdmin();
  ownerId = (await listAdmins())[0].id;
  const venue = (await listVenues())[0];
  venueId = venue.id;
  courts = venue.courts.filter((c) => c.sport === "badminton").slice(0, 3).map((c) => c.id);
  while (courts.length < 2) {
    const c = await createCourt({ venueId, name: `Forfeit Court ${courts.length}`, sport: "badminton", offPeakRate: 10, peakRate: 12 });
    if (!c.ok) throw new Error(c.error);
    courts.push(c.court.id);
  }
  managerMail = "mina-ff@venue.my";
  deskMail = "dan-ff@venue.my";
  const manager = await createAdmin({ name: "Mina Manager", email: managerMail, password: "manager-pass-1", venueId });
  const desk = await createAdmin({ name: "Dan Desk", email: deskMail, password: "desk-password-1", venueId, role: "desk" });
  if (!manager.ok || !desk.ok) throw new Error("staff");
  managerId = manager.admin.id;
  deskId = desk.admin.id;
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(manager.admin.id)).token}`;
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
});

describe("giving a forfeit is a manager's", () => {
  it("is on the manager-only list and in what the dashboard asks about; the desk is refused at every address that gives one, and still enters results", async () => {
    const { l } = await made(2, { legs: 2 }, 4);
    const f = (await detail(l.id)).fixtures[0];
    const forfeitUrl = `/api/admin/team-leagues/${l.id}/fixtures/${f.id}/forfeit`;
    expect(managerOnly("POST", forfeitUrl)).toBe(true);
    expect(managerOnly("POST", `/api/admin/team-leagues/${l.id}/forfeit-requests/1`)).toBe(true);
    // Asking for one is not: the desk may.
    expect(managerOnly("POST", `${forfeitUrl}-requests`)).toBe(false);
    expect(managerOnly("DELETE", `/api/admin/team-leagues/${l.id}/forfeit-requests/1`)).toBe(false);
    expect(STAFF_ACTIONS.teamFixtureForfeit).toMatch(/forfeit$/);
    expect(staffMay("desk").teamFixtureForfeit).toBe(false);
    expect(staffMay("desk").teamForfeitDecide).toBe(false);
    expect(staffMay("manager").teamFixtureForfeit).toBe(true);

    const params = { id: String(l.id), fixtureId: String(f.id) };
    const body = { forfeitBy: f.home.id, version: f.version };
    // The dedicated address.
    const denied = await call(adminForfeit.POST, "POST", forfeitUrl, deskCookie, body, params);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "MANAGER_ONLY" });
    // The fixture's general address, which used to take a forfeit from the desk.
    const old = await call(adminFixture.POST, "POST", `/api/admin/team-leagues/${l.id}/fixtures/${f.id}`, deskCookie, body, params);
    expect(old.status).toBe(403);
    expect(await old.json()).toMatchObject({ code: "MANAGER_ONLY" });
    // A whole fixture given by walkover is a forfeit in everything but its name.
    const allWalkover = { rubbers: [0, 1, 2].map(() => ({ winner: "away", walkover: true })), version: f.version };
    expect((await call(adminFixture.POST, "POST", `/api/admin/team-leagues/${l.id}/fixtures/${f.id}`, deskCookie, allWalkover, params)).status).toBe(403);
    // Nothing happened.
    expect((await detail(l.id)).fixtures.find((x) => x.id === f.id)).toMatchObject({ status: "scheduled", version: f.version });
    expect(await heldMinutes(f.id)).toBeGreaterThan(0);
    // The desk still enters an ordinary result, a single game by walkover included.
    const ordinary = { rubbers: [{ winner: "home", score: "21-10, 21-12" }, { winner: "home", walkover: true }, { winner: "away", score: "10-21, 12-21" }], version: f.version };
    expect((await call(adminFixture.POST, "POST", `/api/admin/team-leagues/${l.id}/fixtures/${f.id}`, deskCookie, ordinary, params)).status).toBe(200);
    expect((await detail(l.id)).fixtures.find((x) => x.id === f.id)).toMatchObject({ status: "confirmed" });
    // A manager gives a forfeit on another fixture, at either address.
    const g = (await detail(l.id)).fixtures[1];
    const done = await call(adminForfeit.POST, "POST", `/api/admin/team-leagues/${l.id}/fixtures/${g.id}/forfeit`, managerCookie, { forfeitBy: g.away.id }, { id: String(l.id), fixtureId: String(g.id) });
    expect(done.status).toBe(200);
    expect((await detail(l.id)).fixtures.find((x) => x.id === g.id)).toMatchObject({ status: "forfeit", forfeitBy: g.away.id });
    expect((await listActivity([venueId])).some((a) => a.action === "team_league.fixture_forfeit" && a.adminName === "Mina Manager")).toBe(true);
  });

  it("a captain cannot report a whole fixture by walkover: that is a forfeit, and they ask for one", async () => {
    const { l, sides } = await made(2, {}, 3);
    const f = (await detail(l.id)).fixtures[0];
    await getDb().prepare("UPDATE team_fixtures SET date = ? WHERE id = ?").run(today, f.id);
    const home = sideOf(sides, f.home.id);
    const all = [0, 1, 2].map(() => ({ winner: "home", walkover: true }));
    expect(await reportFixture(home.captain.id, f.id, all)).toMatchObject({ ok: false, code: "TL_FR_USE_REQUEST" });
    // One game by walkover is an ordinary report.
    expect(await reportFixture(home.captain.id, f.id, [{ winner: "home", walkover: true }, ...games(2)])).toMatchObject({ ok: true });
  });
});

describe("a captain's request", () => {
  it("changes nothing but the request: no result, no table, no scheduling, no court time; the managers and the other captain are told, the desk is not", async () => {
    const { l, sides } = await made(3, {}, 4);
    const before = await detail(l.id);
    const f = before.fixtures[0];
    const home = sideOf(sides, f.home.id);
    const away = sideOf(sides, f.away.id);
    const blocksBefore = ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM blocks WHERE team_league_id = ?").get(l.id)) as { n: number }).n;
    const made1 = await requestForfeit({ userId: away.captain.id }, f.id, { forfeitTeam: f.home.id, reason: "no_show", note: "Nobody turned up by 9:30." });
    expect(made1).toMatchObject({ ok: true, value: { status: "open", by: away.team.name, byKind: "captain", reason: "no_show", note: "Nobody turned up by 9:30.", forfeitTeam: { id: f.home.id }, mine: true } });
    const after = await detail(l.id);
    // The fixture, every other fixture, the table and the league are exactly as they were.
    expect(after.fixtures.map((x) => ({ id: x.id, status: x.status, version: x.version, date: x.date, startMin: x.startMin, courtId: x.courtId, result: x.result }))).toEqual(
      before.fixtures.map((x) => ({ id: x.id, status: x.status, version: x.version, date: x.date, startMin: x.startMin, courtId: x.courtId, result: x.result }))
    );
    expect(after.standings).toEqual(before.standings);
    expect(after.status).toBe(before.status);
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM blocks WHERE team_league_id = ?").get(l.id)) as { n: number }).n).toBe(blocksBefore);
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM team_fixture_rubbers WHERE fixture_id = ? AND played = true").get(f.id)) as { n: number }).n).toBe(0);
    // The other captain is told, in their language; the requester is not told about their own request.
    expect((await mail(home.captain.email)).some((m) => m.subject.includes("forfeit has been asked for"))).toBe(true);
    expect((await mail(away.captain.email)).some((m) => m.subject.includes("forfeit has been asked for"))).toBe(false);
    // The league's managers are told, with the reason and the note; the front desk is not.
    const toManager = await staffMail(managerMail);
    expect(toManager.some((v) => v.includes("asks for a forfeit") && v.includes(f.home.name) && v.includes("Nobody turned up"))).toBe(true);
    expect((await staffMail(deskMail)).some((v) => v.includes("asks for a forfeit"))).toBe(false);
    // It is in the staff log under the captain's team, and on the manager's fixture.
    expect((await listActivity([venueId])).some((a) => a.action === "team_league.forfeit_requested" && a.adminName === `Captain of ${away.team.name}`)).toBe(true);
    expect((await detail(l.id)).fixtures.find((x) => x.id === f.id)!.forfeitRequests).toMatchObject([{ by: away.team.name, status: "open", reason: "no_show" }]);
    expect((await requestRows(f.id)).length).toBe(1);
  });

  it("is checked: a captain of the fixture, a reason from the list, one of its two teams, a note that fits, a fixture still to play", async () => {
    const { l, sides } = await made(3, {}, 4);
    const f = (await detail(l.id)).fixtures[0];
    const home = sideOf(sides, f.home.id);
    const outsider = sides.find((s) => s.leagueTeamId !== f.home.id && s.leagueTeamId !== f.away.id)!;
    const ask = (userId: number, over: Record<string, unknown> = {}) => requestForfeit({ userId }, f.id, { forfeitTeam: f.away.id, reason: "told_us", ...over });
    expect(await ask(outsider.captain.id)).toMatchObject({ ok: false, code: "TL_NOT_CAPTAIN" });
    expect(await ask(home.players[0].id)).toMatchObject({ ok: false, code: "TL_NOT_CAPTAIN" });
    expect(await ask(home.captain.id, { reason: "because" })).toMatchObject({ ok: false, code: "TL_FR_REASON" });
    expect(await ask(home.captain.id, { forfeitTeam: outsider.leagueTeamId })).toMatchObject({ ok: false, code: "TL_FORFEIT_TEAM" });
    expect(await ask(home.captain.id, { note: "x".repeat(301) })).toMatchObject({ ok: false, code: "TL_FR_NOTE" });
    expect(await ask(home.captain.id, { reason: "other" })).toMatchObject({ ok: false, code: "TL_FR_NOTE" });
    expect(await ask(home.captain.id, { reason: "other", note: "x".repeat(300) })).toMatchObject({ ok: true });
    expect(await requestForfeit({ userId: home.captain.id }, 999999, { forfeitTeam: f.away.id, reason: "no_show" })).toMatchObject({ ok: false, code: "TL_NOT_FOUND" });
    // A fixture already decided takes none.
    const g = (await detail(l.id)).fixtures[1];
    await decideFixture(g.id, ownerId, { rubbers: games(3) });
    expect(await requestForfeit({ userId: sideOf(sides, g.home.id).captain.id }, g.id, { forfeitTeam: g.away.id, reason: "no_show" })).toMatchObject({ ok: false, code: "TL_FIXTURE_DECIDED" });
  });

  it("is one open request per fixture and requester; the other captain has their own; a withdrawn one makes room for a new one; only the requester withdraws", async () => {
    const { l, sides } = await made(2, {}, 3);
    const f = (await detail(l.id)).fixtures[0];
    const home = sideOf(sides, f.home.id);
    const away = sideOf(sides, f.away.id);
    const first = await requestForfeit({ userId: home.captain.id }, f.id, { forfeitTeam: f.away.id, reason: "no_show" });
    if (!first.ok) throw new Error(first.error);
    expect(await requestForfeit({ userId: home.captain.id }, f.id, { forfeitTeam: f.away.id, reason: "told_us" })).toMatchObject({ ok: false, code: "TL_FR_OPEN" });
    const theirs = await requestForfeit({ userId: away.captain.id }, f.id, { forfeitTeam: f.home.id, reason: "short_handed" });
    expect(theirs).toMatchObject({ ok: true });
    // Each sees both requests on their fixture; the view says which is theirs.
    const asHome = (await asViewer(l.id, home.captain.id)).fixtures.find((x) => x.id === f.id)!;
    expect(asHome.forfeitRequests!.map((r) => [r.by, r.mine])).toEqual(expect.arrayContaining([[home.team.name, true], [away.team.name, false]]));
    // Nobody else's request is theirs to take back.
    if (!theirs.ok) throw new Error(theirs.error);
    expect(await withdrawForfeitRequest({ userId: home.captain.id }, theirs.value.id)).toMatchObject({ ok: false, code: "TL_NOT_FOUND" });
    expect(await withdrawForfeitRequest({ userId: home.players[0].id }, first.value.id)).toMatchObject({ ok: false, code: "TL_NOT_FOUND" });
    expect(await withdrawForfeitRequest({ userId: home.captain.id }, first.value.id)).toMatchObject({ ok: true });
    expect(await withdrawForfeitRequest({ userId: home.captain.id }, first.value.id)).toMatchObject({ ok: false, code: "TL_FR_GONE" });
    // The other captain is told it was withdrawn; nothing about the fixture changed.
    expect((await mail(away.captain.email)).some((m) => m.subject.includes("forfeit request was withdrawn"))).toBe(true);
    expect((await detail(l.id)).fixtures.find((x) => x.id === f.id)).toMatchObject({ status: "scheduled", version: f.version });
    expect(await requestForfeit({ userId: home.captain.id }, f.id, { forfeitTeam: f.away.id, reason: "told_us" })).toMatchObject({ ok: true });
    // A manager cannot confirm a withdrawn request.
    expect(await decideForfeitRequest(first.value.id, { id: managerId, name: "Mina Manager" }, { confirm: true })).toMatchObject({ ok: false, code: "TL_FR_GONE" });
    expect((await listActivity([venueId])).some((a) => a.action === "team_league.forfeit_request_withdrawn")).toBe(true);
  });

  it("is shown to the captains of the fixture and to staff, and to nobody else; the public table does not move", async () => {
    const { l, sides } = await made(3, {}, 4);
    const f = (await detail(l.id)).fixtures[0];
    const home = sideOf(sides, f.home.id);
    const outsider = sides.find((s) => s.leagueTeamId !== f.home.id && s.leagueTeamId !== f.away.id)!;
    await requestForfeit({ userId: home.captain.id }, f.id, { forfeitTeam: f.away.id, reason: "no_show" });
    const seen = async (viewerId: number | null) => (await teamLeagueDetail(l.id, viewerId === null ? {} : { viewerId }))!.fixtures.find((x) => x.id === f.id)!.forfeitRequests;
    expect(await seen(home.captain.id)).toHaveLength(1);
    expect(await seen(sideOf(sides, f.away.id).captain.id)).toHaveLength(1);
    expect(await seen(outsider.captain.id)).toBeUndefined();
    expect(await seen(null)).toBeUndefined();
    // The public route is the same view.
    const res = await publicLeague.GET(new NextRequest(`http://localhost/api/team-leagues/${l.id}`), { params: Promise.resolve({ id: String(l.id) }) });
    const body = (await res.json()) as { league: { fixtures: { id: number; forfeitRequests?: unknown[] }[] } };
    expect(body.league.fixtures.find((x) => x.id === f.id)!.forfeitRequests).toBeUndefined();
  });
});

describe("a manager decides", () => {
  it("confirming gives the forfeit by the template's scoring: the table, the points, the court time and the next fixture; both captains are told; the decision is audited with the table before and after", async () => {
    const { l, sides } = await made(3, {}, 4);
    const [A, B, C] = sides;
    // One result already in, so the table has something in it: A beat B.
    const ab = await fixtureOf(l.id, A.leagueTeamId!, B.leagueTeamId!);
    await decideFixture(ab.id, ownerId, { rubbers: games(3, ab.home.id === A.leagueTeamId ? "home" : "away") });
    const f = await fixtureOf(l.id, A.leagueTeamId!, C.leagueTeamId!);
    const next = await fixtureOf(l.id, B.leagueTeamId!, C.leagueTeamId!);
    const before = await detail(l.id);
    const asking = sideOf(sides, f.home.id === C.leagueTeamId ? f.home.id : f.away.id); // C asks for A's forfeit
    expect(asking).toBe(C);
    const req = await requestForfeit({ userId: C.captain.id }, f.id, { forfeitTeam: A.leagueTeamId!, reason: "no_show" });
    if (!req.ok) throw new Error(req.error);
    expect(await heldMinutes(f.id)).toBeGreaterThan(0);
    const nextHeld = await heldMinutes(next.id);

    const done = await decideForfeitRequest(req.value.id, { id: managerId, name: "Mina Manager" }, { confirm: true }, { version: f.version });
    expect(done).toMatchObject({ ok: true, value: { status: "confirmed", decidedBy: "Mina Manager" } });
    const after = await detail(l.id);
    const now = after.fixtures.find((x) => x.id === f.id)!;
    // The sport's template's forfeit: every game to the other side by walkover, A named as the forfeiting team.
    expect(now).toMatchObject({ status: "forfeit", forfeitBy: A.leagueTeamId, result: { winner: f.home.id === A.leagueTeamId ? "away" : "home" } });
    expect(now.rubbers.every((r) => r.walkover && r.winner === (f.home.id === A.leagueTeamId ? "away" : "home"))).toBe(true);
    // The table: C has the win (3 points), A keeps its earlier win and takes a loss; B is as it was.
    const row = (d: typeof after, id: number) => d.standings.find((s) => s.leagueTeamId === id)!;
    expect(row(after, C.leagueTeamId!)).toMatchObject({ played: before.standings.find((s) => s.leagueTeamId === C.leagueTeamId)!.played + 1, won: 1, points: 3 });
    expect(row(after, A.leagueTeamId!)).toMatchObject({ played: 2, won: 1, lost: 1, points: 3 });
    expect(row(after, B.leagueTeamId!)).toEqual(row(before, B.leagueTeamId!));
    // Ranked through the same `standings`: ordered by points, then the published tie-break (point difference first).
    const ranked = after.standings.map((s) => s.leagueTeamId);
    expect(after.standings.map((s) => s.position)).toEqual([1, 2, 3]);
    expect([...after.standings].sort((a, b) => b.points - a.points || b.pointDiff - a.pointDiff).map((s) => s.leagueTeamId)).toEqual(ranked);
    // Court time: the forfeited fixture's is given back; the next fixture's is untouched and still to play.
    expect(await heldMinutes(f.id)).toBe(0);
    expect(await heldMinutes(next.id)).toBe(nextHeld);
    expect(after.fixtures.find((x) => x.id === next.id)).toMatchObject({ status: "scheduled", version: next.version, date: next.date, startMin: next.startMin });
    // Both captains are told by the forfeit itself.
    for (const s of [A, C]) expect((await mail(s.captain.email)).some((m) => m.body.includes("forfeit"))).toBe(true);
    // The request kept who asked, who decided and the table before and after.
    const [row0] = await requestRows(f.id);
    expect(row0).toMatchObject({ status: "confirmed", decided_by_admin_id: managerId, decided_by_name: "Mina Manager", reason: "no_show", requested_by_name: C.team.name });
    expect(JSON.parse(row0.standings_before as string).find((s: { teamId: number }) => s.teamId === C.leagueTeamId)).toMatchObject({ points: 0 });
    expect(JSON.parse(row0.standings_after as string).find((s: { teamId: number }) => s.teamId === C.leagueTeamId)).toMatchObject({ points: 3, position: row(after, C.leagueTeamId!).position });
    const log = (await listActivity([venueId])).find((a) => a.action === "team_league.forfeit_confirmed")!;
    expect(log.adminName).toBe("Mina Manager");
    expect(log.detail).toMatch(/asked by .* \(no_show\)\. Table before: .*; after: /);
    // It cannot be decided twice.
    expect(await decideForfeitRequest(req.value.id, { id: managerId, name: "Mina Manager" }, { confirm: true })).toMatchObject({ ok: false, code: "TL_FR_GONE" });
    expect(await decideForfeitRequest(req.value.id, { id: managerId, name: "Mina Manager" }, { decline: true, reason: "too late" })).toMatchObject({ ok: false, code: "TL_FR_GONE" });
  });

  it("a rated league reads the forfeit into the ratings as walkovers, which move nothing, as a manager's own forfeit does", async () => {
    const { l, sides } = await made(2, {}, 3, true);
    const f = (await detail(l.id)).fixtures[0];
    const live = async () => (await getDb().prepare("SELECT kind FROM rated_results WHERE source_kind = 'team_league' AND source_id = ? AND voided_at IS NULL").all(l.id)) as { kind: string }[];
    expect(await live()).toEqual([]);
    const req = await requestForfeit({ userId: sideOf(sides, f.away.id).captain.id }, f.id, { forfeitTeam: f.home.id, reason: "no_show" });
    if (!req.ok) throw new Error(req.error);
    // Asking rates nothing.
    expect(await live()).toEqual([]);
    expect(await decideForfeitRequest(req.value.id, { id: managerId, name: "Mina Manager" }, { confirm: true })).toMatchObject({ ok: true });
    const rows = await live();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.kind === "walkover")).toBe(true);
    // Put back to be played, the rated rows go with it (a replay, not an accumulation).
    expect(await decideFixture(f.id, ownerId, { clear: true })).toMatchObject({ ok: true });
    expect(await live()).toEqual([]);
  });

  it("a stale version leaves the request open and the fixture as it was", async () => {
    const { l, sides } = await made(2, {}, 3);
    const f = (await detail(l.id)).fixtures[0];
    const req = await requestForfeit({ userId: sideOf(sides, f.away.id).captain.id }, f.id, { forfeitTeam: f.home.id, reason: "no_show" });
    if (!req.ok) throw new Error(req.error);
    expect(await decideForfeitRequest(req.value.id, { id: managerId, name: "Mina Manager" }, { confirm: true }, { version: f.version + 9 })).toMatchObject({ ok: false, code: "TL_CHANGED" });
    expect((await requestRows(f.id))[0]).toMatchObject({ status: "open" });
    expect((await detail(l.id)).fixtures.find((x) => x.id === f.id)!.status).toBe("scheduled");
    expect(await heldMinutes(f.id)).toBeGreaterThan(0);
  });

  it("declining needs a reason, tells both captains, changes nothing, and is audited", async () => {
    const { l, sides } = await made(2, {}, 3);
    const f = (await detail(l.id)).fixtures[0];
    const home = sideOf(sides, f.home.id);
    const away = sideOf(sides, f.away.id);
    const before = await detail(l.id);
    const req = await requestForfeit({ userId: home.captain.id }, f.id, { forfeitTeam: f.away.id, reason: "told_us" });
    if (!req.ok) throw new Error(req.error);
    expect(await decideForfeitRequest(req.value.id, { id: managerId, name: "Mina Manager" }, { decline: true, reason: "" })).toMatchObject({ ok: false, code: "TL_FR_WHY" });
    expect(await decideForfeitRequest(req.value.id, { id: managerId, name: "Mina Manager" }, { decline: true, reason: "x".repeat(301) })).toMatchObject({ ok: false, code: "TL_FR_WHY" });
    expect(await decideForfeitRequest(req.value.id, { id: managerId, name: "Mina Manager" }, { decline: true, reason: "They have confirmed they are coming." })).toMatchObject({
      ok: true,
      value: { status: "declined", decisionNote: "They have confirmed they are coming.", decidedBy: "Mina Manager" },
    });
    const after = await detail(l.id);
    expect(after.standings).toEqual(before.standings);
    expect(after.fixtures.find((x) => x.id === f.id)).toMatchObject({ status: "scheduled", version: f.version });
    for (const s of [home, away]) expect((await mail(s.captain.email)).some((m) => m.subject.includes("forfeit request was declined") && m.body.includes("They have confirmed they are coming."))).toBe(true);
    expect((await listActivity([venueId])).find((a) => a.action === "team_league.forfeit_declined")).toMatchObject({ adminName: "Mina Manager" });
    // The captain sees where it stands; another can then be asked for.
    expect((await asViewer(l.id, home.captain.id)).fixtures.find((x) => x.id === f.id)!.forfeitRequests).toMatchObject([{ status: "declined", decisionNote: "They have confirmed they are coming." }]);
    expect(await requestForfeit({ userId: home.captain.id }, f.id, { forfeitTeam: f.away.id, reason: "no_show" })).toMatchObject({ ok: true });
  });
});

describe("a request ends when its fixture is decided, withdrawn, or too old", () => {
  it("expires after 14 days (never answerable, even before the scheduler runs), and the captain who asked is told", async () => {
    const { l, sides } = await made(2, {}, 3);
    const f = (await detail(l.id)).fixtures[0];
    const home = sideOf(sides, f.home.id);
    const req = await requestForfeit({ userId: home.captain.id }, f.id, { forfeitTeam: f.away.id, reason: "no_show" });
    if (!req.ok) throw new Error(req.error);
    const days = ((await getDb().prepare("SELECT (expires_at::timestamp - created_at::timestamp) < interval '14 days 1 minute' AND (expires_at::timestamp - created_at::timestamp) > interval '13 days 23 hours' AS ok FROM team_forfeit_requests WHERE id = ?").get(req.value.id)) as { ok: boolean }).ok;
    expect(days).toBe(true);
    await getDb().prepare("UPDATE team_forfeit_requests SET expires_at = datetime('now', '-1 minutes') WHERE id = ?").run(req.value.id);
    // Before the sweep it already reads as expired and cannot be confirmed.
    expect((await detail(l.id)).fixtures.find((x) => x.id === f.id)!.forfeitRequests![0].status).toBe("expired");
    expect(await decideForfeitRequest(req.value.id, { id: managerId, name: "Mina Manager" }, { confirm: true })).toMatchObject({ ok: false, code: "TL_FR_GONE" });
    expect((await detail(l.id)).fixtures.find((x) => x.id === f.id)!.status).toBe("scheduled");
    await teamLeagueHousekeeping();
    expect((await requestRows(f.id))[0]).toMatchObject({ status: "expired" });
    expect((await mail(home.captain.email)).some((m) => m.subject.includes("forfeit request expired"))).toBe(true);
    // Running it again tells nobody twice.
    const told = (await mail(home.captain.email)).length;
    await teamLeagueHousekeeping();
    expect((await mail(home.captain.email)).length).toBe(told);
    // The captain can ask afresh.
    expect(await requestForfeit({ userId: home.captain.id }, f.id, { forfeitTeam: f.away.id, reason: "no_show" })).toMatchObject({ ok: true });
  });

  it("closes by itself when the fixture is played and confirmed, struck, forfeited another way, or its team withdraws; a request on a fixture put back to be played stays", async () => {
    const { l, sides } = await made(3, {}, 4);
    const [A, B, C] = sides;
    const open = async (a: Side, b: Side, asker: Side) => {
      const f = await fixtureOf(l.id, a.leagueTeamId!, b.leagueTeamId!);
      const r = await requestForfeit({ userId: asker.captain.id }, f.id, { forfeitTeam: asker === a ? b.leagueTeamId! : a.leagueTeamId!, reason: "no_show" });
      if (!r.ok) throw new Error(r.error);
      return { f, id: r.value.id };
    };
    const status = async (id: number) => ((await getDb().prepare("SELECT status, closed_reason FROM team_forfeit_requests WHERE id = ?").get(id)) as { status: string; closed_reason: string | null });
    // Played: one captain reports, the other confirms.
    const played = await open(A, B, A);
    await getDb().prepare("UPDATE team_fixtures SET date = ? WHERE id = ?").run(today, played.f.id);
    const reporter = sideOf(sides, played.f.home.id);
    const answerer = sideOf(sides, played.f.away.id);
    expect(await reportFixture(reporter.captain.id, played.f.id, games(3), {})).toMatchObject({ ok: true });
    // Reported, not yet decided: the request is still open and can still be answered.
    expect((await status(played.id)).status).toBe("open");
    expect(await confirmFixture(answerer.captain.id, played.f.id, {})).toMatchObject({ ok: true });
    expect(await status(played.id)).toEqual({ status: "closed", closed_reason: "decided" });
    expect(await decideForfeitRequest(played.id, { id: managerId, name: "Mina Manager" }, { confirm: true })).toMatchObject({ ok: false, code: "TL_FR_GONE" });
    expect((await detail(l.id)).fixtures.find((x) => x.id === played.f.id)).toMatchObject({ status: "confirmed" });
    // Struck by staff.
    const struck = await open(A, C, C);
    await decideFixture(struck.f.id, ownerId, { void: true });
    expect((await status(struck.id)).status).toBe("closed");
    // A fixture put back to be played is not decided: a request on it stays.
    const kept = await open(B, C, B);
    await decideFixture(kept.f.id, ownerId, { clear: true });
    expect((await status(kept.id)).status).toBe("open");
    // Its team withdraws: the fixture is forfeited by the withdrawal, so the request is closed, not confirmed.
    expect(await withdrawTeam({ userId: C.captain.id }, C.leagueTeamId!)).toMatchObject({ ok: true });
    expect((await status(kept.id)).status).toBe("closed");
    expect((await detail(l.id)).fixtures.find((x) => x.id === kept.f.id)).toMatchObject({ status: "forfeit", forfeitBy: C.leagueTeamId });
  });

  it("a fixture moved to another night keeps its request; the move is the manager's alone and the request does not make it", async () => {
    const { l, sides } = await made(2, {}, 3);
    const f = (await detail(l.id)).fixtures[0];
    const req = await requestForfeit({ userId: sideOf(sides, f.home.id).captain.id }, f.id, { forfeitTeam: f.away.id, reason: "short_handed" });
    if (!req.ok) throw new Error(req.error);
    expect((await detail(l.id)).fixtures.find((x) => x.id === f.id)).toMatchObject({ date: f.date, startMin: f.startMin });
    expect(await moveFixture(f.id, { date: addDays(f.date, 1), startMin: f.startMin + 60 })).toMatchObject({ ok: true });
    expect((await requestRows(f.id))[0]).toMatchObject({ status: "open" });
  });
});

describe("through the staff routes", () => {
  it("the desk may ask for a forfeit and take its own request back, but not decide it; the manager confirms or declines; each is logged", async () => {
    const { l, sides } = await made(2, { legs: 2 }, 4);
    const [f, g] = (await detail(l.id)).fixtures;
    const base = `/api/admin/team-leagues/${l.id}`;
    const ask = (fixtureId: number, cookie: string, body: unknown) => call(adminAsk.POST, "POST", `${base}/fixtures/${fixtureId}/forfeit-requests`, cookie, body, { id: String(l.id), fixtureId: String(fixtureId) });
    const decide = (requestId: number, cookie: string, body: unknown) => call(adminDecide.POST, "POST", `${base}/forfeit-requests/${requestId}`, cookie, body, { id: String(l.id), requestId: String(requestId) });
    const withdraw = (requestId: number, cookie: string) => call(adminDecide.DELETE, "DELETE", `${base}/forfeit-requests/${requestId}`, cookie, undefined, { id: String(l.id), requestId: String(requestId) });

    // The desk asks; nothing but the request is written.
    expect((await ask(f.id, deskCookie, { forfeitTeam: f.home.id, reason: "other" })).status).toBe(400); // "other" needs a note
    const asked = await ask(f.id, deskCookie, { forfeitTeam: f.home.id, reason: "no_show", note: "Home team not in the building." });
    expect(asked.status).toBe(201);
    const { request } = (await asked.json()) as { request: { id: number; by: string; byKind: string } };
    expect(request).toMatchObject({ by: "Dan Desk", byKind: "staff" });
    expect((await detail(l.id)).fixtures.find((x) => x.id === f.id)!.status).toBe("scheduled");
    expect((await listActivity([venueId])).find((a) => a.action === "team_league.forfeit_requested")).toMatchObject({ adminName: "Dan Desk" });
    // Staff asking tells the managers, and nobody on the teams.
    expect((await staffMail(managerMail)).some((v) => v.includes("Dan Desk asks for a forfeit"))).toBe(true);
    expect((await mail(sideOf(sides, f.home.id).captain.email)).some((m) => m.subject.includes("forfeit has been asked for"))).toBe(false);
    // The desk cannot decide it, and the refusal is the usual one.
    const refused = await decide(request.id, deskCookie, { confirm: true });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "MANAGER_ONLY" });
    expect((await requestRows(f.id))[0]).toMatchObject({ status: "open" });
    // A manager cannot withdraw the desk's request as if it were theirs, the desk can, and then can ask again.
    expect((await withdraw(request.id, managerCookie)).status).toBe(404);
    expect((await withdraw(request.id, deskCookie)).status).toBe(200);
    const again = await ask(f.id, deskCookie, { forfeitTeam: f.home.id, reason: "no_show" });
    const second = ((await again.json()) as { request: { id: number } }).request;
    // The manager sees it on the fixture, and confirms it.
    const staffView = (await detail(l.id)).fixtures.find((x) => x.id === f.id)!.forfeitRequests!;
    expect(staffView.map((r) => r.status).sort()).toEqual(["open", "withdrawn"]);
    expect((await decide(second.id, managerCookie, {})).status).toBe(400);
    const confirmed = await decide(second.id, managerCookie, { confirm: true, version: f.version });
    expect(confirmed.status).toBe(200);
    expect((await detail(l.id)).fixtures.find((x) => x.id === f.id)).toMatchObject({ status: "forfeit", forfeitBy: f.home.id });
    // Another fixture: declined by the manager through the route, with a reason.
    const asked2 = (await (await ask(g.id, deskCookie, { forfeitTeam: g.away.id, reason: "told_us" })).json()) as { request: { id: number } };
    expect((await decide(asked2.request.id, managerCookie, { decline: true, reason: "" })).status).toBe(400);
    expect((await decide(asked2.request.id, managerCookie, { decline: true, reason: "Checked: they are on their way." })).status).toBe(200);
    expect((await detail(l.id)).fixtures.find((x) => x.id === g.id)!.status).toBe("scheduled");
    const actions = (await listActivity([venueId])).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["team_league.forfeit_requested", "team_league.forfeit_request_withdrawn", "team_league.forfeit_confirmed", "team_league.forfeit_declined"]));
    // A request of another league is not found through this one.
    const other = await made(2, {}, 3);
    const otherFixture = (await detail(other.l.id)).fixtures[0];
    expect((await call(adminAsk.POST, "POST", `${base}/fixtures/${otherFixture.id}/forfeit-requests`, managerCookie, { forfeitTeam: otherFixture.home.id, reason: "no_show" }, { id: String(l.id), fixtureId: String(otherFixture.id) })).status).toBe(404);
    void deskId;
  });

  it("a captain asks and withdraws through the public route; a member who is not the captain is refused", async () => {
    const { l, sides } = await made(2, {}, 3);
    const f = (await detail(l.id)).fixtures[0];
    const home = sideOf(sides, f.home.id);
    const cookieOf = async (u: User) => `${SESSION_COOKIE}=${(await createSession(u.id)).token}`;
    const post = async (u: User, body: unknown) =>
      publicLeague.POST(new NextRequest(`http://localhost/api/team-leagues/${l.id}`, { method: "POST", headers: { "content-type": "application/json", cookie: await cookieOf(u), origin: "http://localhost" }, body: JSON.stringify(body) }), {
        params: Promise.resolve({ id: String(l.id) }),
      });
    const refused = await post(home.players[0], { action: "forfeit_request", fixtureId: f.id, forfeitTeam: f.away.id, reason: "no_show" });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "TL_NOT_CAPTAIN" });
    const asked = await post(home.captain, { action: "forfeit_request", fixtureId: f.id, forfeitTeam: f.away.id, reason: "short_handed", note: "Only two of them are here." });
    expect(asked.status).toBe(200);
    const body = (await asked.json()) as { league: { fixtures: { id: number; forfeitRequests?: { id: number; status: string; mine: boolean }[] }[] } };
    const mine = body.league.fixtures.find((x) => x.id === f.id)!.forfeitRequests![0];
    expect(mine).toMatchObject({ status: "open", mine: true });
    expect((await detail(l.id)).fixtures.find((x) => x.id === f.id)!.status).toBe("scheduled");
    // Reported as a whole-fixture walkover: refused with the pointer to the request.
    await getDb().prepare("UPDATE team_fixtures SET date = ? WHERE id = ?").run(today, f.id);
    const all = await post(home.captain, { action: "report", fixtureId: f.id, rubbers: [0, 1, 2].map(() => ({ winner: "home", walkover: true })) });
    expect(all.status).toBe(409);
    expect(await all.json()).toMatchObject({ code: "TL_FR_USE_REQUEST" });
    const gone = await post(home.captain, { action: "forfeit_withdraw", requestId: mine.id });
    expect(gone.status).toBe(200);
    expect((await requestRows(f.id))[0]).toMatchObject({ status: "withdrawn" });
  });
});

describe("races (the league's lock serialises them)", () => {
  it("two captains asking at once both get a request; one captain asking twice at once gets one", async () => {
    const { l, sides } = await made(2, { legs: 2 }, 4);
    const f = (await detail(l.id)).fixtures[0];
    const home = sideOf(sides, f.home.id);
    const away = sideOf(sides, f.away.id);
    const both = await Promise.all([
      requestForfeit({ userId: home.captain.id }, f.id, { forfeitTeam: f.away.id, reason: "no_show" }),
      requestForfeit({ userId: away.captain.id }, f.id, { forfeitTeam: f.home.id, reason: "no_show" }),
    ]);
    expect(both.map((r) => r.ok)).toEqual([true, true]);
    const twice = await Promise.all([
      requestForfeit({ userId: home.captain.id }, f.id, { forfeitTeam: f.away.id, reason: "told_us" }),
      requestForfeit({ userId: home.captain.id }, f.id, { forfeitTeam: f.away.id, reason: "told_us" }),
    ]);
    expect(twice.filter((r) => r.ok).length).toBe(0); // the first of them is already open
    const g = (await detail(l.id)).fixtures[1];
    const dup = await Promise.all([
      requestForfeit({ userId: sideOf(sides, g.home.id).captain.id }, g.id, { forfeitTeam: g.away.id, reason: "told_us" }),
      requestForfeit({ userId: sideOf(sides, g.home.id).captain.id }, g.id, { forfeitTeam: g.away.id, reason: "told_us" }),
    ]);
    expect(dup.filter((r) => r.ok).length).toBe(1);
    expect(dup.find((r) => !r.ok)).toMatchObject({ code: "TL_FR_OPEN" });
    expect((await requestRows(g.id)).length).toBe(1);
  });

  it("two managers confirming at once forfeit the fixture once; a request racing a result either lands on the open fixture and is closed by the result, or is refused", async () => {
    const { l, sides } = await made(2, { legs: 2 }, 4);
    const [f, g] = (await detail(l.id)).fixtures;
    const req = await requestForfeit({ userId: sideOf(sides, f.away.id).captain.id }, f.id, { forfeitTeam: f.home.id, reason: "no_show" });
    if (!req.ok) throw new Error(req.error);
    const results = await Promise.all([
      decideForfeitRequest(req.value.id, { id: managerId, name: "Mina Manager" }, { confirm: true }),
      decideForfeitRequest(req.value.id, { id: ownerId, name: "Owner" }, { confirm: true }),
    ]);
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ code: "TL_FR_GONE" });
    expect((await detail(l.id)).fixtures.find((x) => x.id === f.id)).toMatchObject({ status: "forfeit" });
    const forfeits = (await listActivity([venueId])).filter((a) => a.action === "team_league.forfeit_confirmed").length;
    expect(forfeits).toBeGreaterThanOrEqual(1);

    // A request racing the fixture's own result.
    const raced = await Promise.all([
      requestForfeit({ userId: sideOf(sides, g.away.id).captain.id }, g.id, { forfeitTeam: g.home.id, reason: "no_show" }),
      decideFixture(g.id, ownerId, { rubbers: games(3) }),
    ]);
    expect(raced[1]).toMatchObject({ ok: true });
    const rows = await requestRows(g.id);
    expect((await detail(l.id)).fixtures.find((x) => x.id === g.id)!.status).toBe("confirmed");
    // Whichever came first: no open request is left on a decided fixture.
    expect(rows.every((r) => r.status !== "open")).toBe(true);
    if (raced[0].ok) expect(rows).toHaveLength(1);
    else expect(raced[0]).toMatchObject({ code: "TL_FIXTURE_DECIDED" });
  });
});
