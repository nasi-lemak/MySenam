import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { listActivity } from "../src/lib/activity";
import { addManaged } from "../src/lib/managed-people";
import { saveProfile } from "../src/lib/player-profiles";
import { setEventRated } from "../src/lib/ratings";
import { createBooking, createCourt, listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { setPlayerGender } from "../src/lib/who";
import {
  answer,
  challenge,
  confirm,
  confirmHoldAsPlayer,
  createLadder,
  decide,
  dispute,
  freeze,
  joinAs,
  ladderDetail,
  ladderHousekeeping,
  leave,
  myPlaces,
  report,
  staffHold,
  type LadderInput,
} from "../src/lib/ladders";
import { selfEntrant } from "../src/lib/competition-entrants";
import { joinTeam, reportTeamResult, setTeamLineup, teamViews } from "../src/lib/team-ladders";
import { acceptInvitation, archiveTeam, createInviteLink, createTeam, forgetTeamsOfUser, removeMember, teamView, transferCaptain, type Team } from "../src/lib/teams";
import { requestLadderForfeit } from "../src/lib/team-forfeits";
import * as adminLadder from "../src/app/api/admin/ladders/[id]/route";
import * as adminForfeits from "../src/app/api/admin/ladders/[id]/forfeit-requests/route";
import * as adminForfeit from "../src/app/api/admin/ladders/[id]/forfeit-requests/[requestId]/route";
import * as challengeRoute from "../src/app/api/ladders/[id]/challenges/[challengeId]/route";
import * as playerLadder from "../src/app/api/ladders/[id]/route";
import { STAFF_ACTIONS, managerOnly } from "../src/lib/roles";

/**
 * Persistent teams on ladders (lib/team-ladders.ts; ADR 0040; migration 0283): a ladder of teams, entered by a captain, whose matches are made of
 * the sport's games and checked by a team league's own rules; lineups, reports, forfeits (a manager's), teams leaving, privacy and ratings.
 */

vi.setConfig({ testTimeout: 90_000 });

let venueId: number;
let adminId: number;
let futsalCourt: number;
let managerCookie: string;
let deskCookie: string;
let n = 0;
const today = todayISO();

async function adult(name = "Player"): Promise<User> {
  n++;
  const made = await registerUser({ name: `${name} ${n}`, email: `tlad${n}@ladder.test`, phone: `01383${String(n).padStart(5, "0")}`, password: "a long enough password" });
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
  place?: number;
}

/** A team of a captain and `size - 1` others, all adults. */
async function side(label: string, size = 3, sport = "badminton"): Promise<Side> {
  const captain = await adult(`${label} Captain`);
  n++;
  const made = await createTeam(captain.id, { name: `${label} ${n}`, sport });
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

function ok<T>(r: { ok: true; value: T } | { ok: false; error: string; code?: string }): T {
  if (!r.ok) throw new Error(`${r.error} (${r.code ?? ""})`);
  return r.value;
}

const req = (url: string, method: string, cookie?: string, body?: unknown) =>
  new NextRequest(`http://localhost${url}`, { method, headers: { ...(cookie ? { cookie } : {}), origin: "http://localhost", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
const ctx2 = (id: number, other: number) => ({ params: Promise.resolve({ id: String(id), challengeId: String(other), requestId: String(other) }) });
const cookieOf = async (u: User) => `${SESSION_COOKIE}=${(await createSession(u.id)).token}`;
const mail = async (to: string) => (await getDb().prepare("SELECT subject, body FROM messages WHERE kind IN ('programme', 'team_decision') AND recipient = ? ORDER BY id").all(to)) as { subject: string; body: string }[];

beforeAll(async () => {
  await ensureBootstrapAdmin();
  adminId = (await listAdmins())[0].id;
  venueId = (await listVenues())[0].id;
  const f = await createCourt({ venueId, name: "Futsal Ladder Court", sport: "futsal", offPeakRate: 10, peakRate: 12 });
  if (!f.ok) throw new Error(f.error);
  futsalCourt = f.court.id;
  const manager = await createAdmin({ name: "Mina Manager", email: "mina-tlad@venue.my", password: "manager-pass-1", venueId });
  const desk = await createAdmin({ name: "Dan Desk", email: "dan-tlad@venue.my", password: "desk-password-1", venueId, role: "desk" });
  if (!manager.ok || !desk.ok) throw new Error("staff");
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(manager.admin.id)).token}`;
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
});

async function ladder(over: Partial<LadderInput> = {}) {
  n++;
  return ok(await createLadder({ venueId, name: `Team Ladder ${n}`, sport: "badminton", teamSize: 1, level: null, kind: "teams", settings: { cooldownDays: 0 }, ...over }, adminId));
}

async function enter(l: { id: number }, s: Side) {
  const made = ok(await joinTeam(s.captain, l.id, s.team.id));
  s.place = made.playerId;
  return made.playerId;
}

/** A ladder with `size` teams entered (the first at the top). */
async function populated(size: number, over: Partial<LadderInput> = {}) {
  const l = await ladder(over);
  const sides: Side[] = [];
  for (let i = 0; i < size; i++) {
    const s = await side(`T${i + 1}`);
    await enter(l, s);
    sides.push(s);
  }
  return { l, sides };
}

/** Three games, the challenger's side (`home`) winning each. */
const games = (winner: "home" | "away" = "home", count = 3) =>
  Array.from({ length: count }, () => ({ winner, score: winner === "home" ? "21-10, 21-12" : "10-21, 12-21" }));

/** The lower team challenges the one above; accepted. */
async function accepted(l: { id: number }, low: Side, high: Side) {
  const made = ok(await challenge(low.captain.id, l.id, low.place!, high.place!, {}));
  return ok(await answer(high.captain.id, made.id, { accept: true }));
}

describe("setting up a ladder of teams", () => {
  it("takes the sport's template: its games, and the team league's defaults for the rest", async () => {
    const l = await ladder();
    expect(l).toMatchObject({ kind: "teams", audience: "adults", teamSize: 1 });
    expect(l.team).toMatchObject({ rubbers: ["singles", "doubles", "singles"], rubberMinutes: 45, maxRubbersPerPlayer: 2 });
    expect(l.team!.rosterMin).toBeGreaterThanOrEqual(2);
    // Held court time for a team match is its games added up, one court after another as in a team league.
    expect(l.courtTime.matchMinutes).toBe(3 * 45);
  });

  it("refuses what cannot work: a match that could end level, a declining that is a forfeit, juniors, and silly numbers", async () => {
    const make = (over: Partial<LadderInput>) => createLadder({ venueId, name: `Bad Team Ladder ${++n}`, sport: "badminton", teamSize: 1, level: null, kind: "teams", ...over }, adminId);
    expect(await make({ team: { rubbers: ["singles", "doubles"] } })).toMatchObject({ ok: false, code: "LAD2_RUBBERS_ODD" });
    expect(await make({ team: { rubbers: ["singles", "team"] } })).toMatchObject({ ok: false, code: "LAD2_RUBBERS" });
    expect(await make({ team: { rubbers: [] } })).toMatchObject({ ok: false, code: "LAD2_RUBBERS" });
    expect(await make({ settings: { declineIs: "forfeit" } })).toMatchObject({ ok: false, code: "LAD2_TEAM_DECLINE" });
    expect(await make({ audience: "juniors" })).toMatchObject({ ok: false, code: "LAD2_TEAM_AUDIENCE" });
    expect(await make({ team: { rosterMin: 9, rosterMax: 3 } })).toMatchObject({ ok: false, code: "LAD2_TEAM_NUMBERS" });
    expect(await make({ kind: "clubs" as never })).toMatchObject({ ok: false, code: "LAD2_KIND" });
    expect(ok(await make({ team: { rubbers: ["singles", "singles", "singles", "doubles", "doubles"] } })).team!.rubbers).toHaveLength(5);
  });
});

describe("entering a team", () => {
  it("is the captain's, at the bottom, once for the team and once for the captain, by the name the team has", async () => {
    const l = await ladder();
    const a = await side("Alpha");
    const b = await side("Bravo");
    const placeA = await enter(l, a);
    const placeB = await enter(l, b);
    const d = (await ladderDetail(l.id))!;
    expect(d.rows.map((r) => [r.rank, r.name])).toEqual([[1, a.team.name], [2, b.team.name]]);
    expect(d.players).toBe(2);
    expect(placeA).not.toBe(placeB);
    // The captain acts for it.
    expect((await myPlaces(a.captain.id, l.id)).map((p) => [p.playerId, p.rank])).toEqual([[placeA, 1]]);
    expect(await myPlaces(a.players[0].id, l.id)).toEqual([]);
    expect(await joinTeam(a.captain, l.id, a.team.id)).toMatchObject({ ok: false, code: "LD_ALREADY_IN" });
    // A second team of the same captain: one place on a ladder for each account.
    n++;
    const second = ok(await createTeam(a.captain.id, { name: `Alpha Two ${n}`, sport: "badminton" }));
    expect(await joinTeam(a.captain, l.id, second.id)).toMatchObject({ ok: false, code: "LAD2_CAPTAIN_TWICE" });
    // It joins the way people do not: not by joinAs.
    expect(await joinAs(selfEntrant(a.players[0]), l.id, { adult: true })).toMatchObject({ ok: false, code: "LAD2_TEAMS_ONLY" });
  });

  it("is refused to a member who is not the captain, a stranger, a team of another sport, a team too small, and on a ladder of players", async () => {
    const l = await ladder();
    const a = await side("Alpha");
    expect(await joinTeam(a.players[0], l.id, a.team.id)).toMatchObject({ ok: false, code: "TM_ENTRY_CAPTAIN", status: 403 });
    expect(await joinTeam(await adult("Stranger"), l.id, a.team.id)).toMatchObject({ ok: false, status: 404 });
    const squash = await side("Squash", 3, "squash");
    expect(await joinTeam(squash.captain, l.id, squash.team.id)).toMatchObject({ ok: false, code: "TM_ENTRY_SPORT" });
    const small = await ladder({ team: { rosterMin: 4 } });
    expect(await joinTeam(a.captain, small.id, a.team.id)).toMatchObject({ ok: false, code: "LAD2_TEAM_SHORT", vars: { n: 3, min: 4 } });
    const plain = ok(await createLadder({ venueId, name: `Plain ${++n}`, sport: "badminton", teamSize: 1, level: null }, adminId));
    expect(await joinTeam(a.captain, plain.id, a.team.id)).toMatchObject({ ok: false, code: "LAD2_NOT_TEAMS" });
    // The same name twice is refused: a team shows on a ladder by its name alone.
    const c = await side("Alpha");
    await getDb().prepare("UPDATE teams SET name = ? WHERE id = ?").run(a.team.name.toUpperCase(), c.team.id);
    ok(await joinTeam(a.captain, l.id, a.team.id));
    expect(await joinTeam(c.captain, l.id, c.team.id)).toMatchObject({ ok: false, code: "LAD2_NAME_TAKEN" });
  });

  it("checks each member's eligibility by what they declared: a women's ladder takes a team of women", async () => {
    const women = await ladder({ who: "women" });
    const mixed = await side("Mixed");
    expect(await joinTeam(mixed.captain, women.id, mixed.team.id)).toMatchObject({ ok: false, code: "LAD2_TEAM_SHORT", vars: { n: 0 } });
    for (const u of [mixed.captain, ...mixed.players]) await setPlayerGender(u.id, "woman");
    expect(await joinTeam(mixed.captain, women.id, mixed.team.id)).toMatchObject({ ok: true });
  });
});

describe("a challenge between teams", () => {
  it("is made and answered by the captains, within reach, as players': a member is not the captain", async () => {
    const { l, sides } = await populated(3);
    const [, mid, low] = sides;
    expect(await challenge(low.players[0].id, l.id, low.place!, mid.place!, {})).toMatchObject({ ok: false, code: "LD_NOT_YOURS", status: 403 });
    const made = ok(await challenge(low.captain.id, l.id, low.place!, mid.place!, {}));
    expect(made).toMatchObject({ status: "pending", challengerName: low.team.name, challengedName: mid.team.name });
    expect((await mail(mid.captain.email)).some((m) => m.body.includes(low.team.name))).toBe(true);
    // The other captain's number, to arrange it, is given once it is accepted.
    ok(await answer(mid.captain.id, made.id, { accept: true }));
    expect((await myPlaces(low.captain.id, l.id))[0].open[0].contact).toMatchObject({ name: mid.team.name });
    // Out of reach, or in a challenge already, is refused for a team as for a player.
    expect(await challenge(low.captain.id, l.id, low.place!, sides[0].place!, {})).toMatchObject({ ok: false });
  });

  it("names a lineup from the team's members by the team league's rules, until a result is in", async () => {
    const { l, sides } = await populated(2);
    const [top, low] = sides;
    const c = await accepted(l, low, top);
    const picks = (ids: number[]) => [{ rubber: 1, memberIds: [ids[0]] }, { rubber: 2, memberIds: [ids[0], ids[1]] }, { rubber: 3, memberIds: [ids[2]] }];
    expect(await setTeamLineup(low.captain.id, c.id, picks(low.members))).toMatchObject({ ok: true });
    // The rules are a team league's: one pick for each game, singles one, doubles two, only the team, nobody in too many games.
    expect(await setTeamLineup(low.captain.id, c.id, picks(low.members).slice(0, 2))).toMatchObject({ ok: false, code: "TL_LINEUP_COUNT" });
    expect(await setTeamLineup(low.captain.id, c.id, [{ rubber: 1, memberIds: [low.members[0], low.members[1]] }, ...picks(low.members).slice(1)])).toMatchObject({ ok: false, code: "TL_LINEUP_SIZE" });
    expect(await setTeamLineup(low.captain.id, c.id, picks([...top.members]))).toMatchObject({ ok: false, code: "TL_LINEUP_NOT_ROSTER" });
    expect(await setTeamLineup(low.captain.id, c.id, [{ rubber: 1, memberIds: [low.members[0]] }, { rubber: 2, memberIds: [low.members[0], low.members[1]] }, { rubber: 3, memberIds: [low.members[0]] }])).toMatchObject({ ok: false, code: "TL_LINEUP_TOO_MANY" });
    // Only a captain of one of the sides.
    expect(await setTeamLineup(low.players[0].id, c.id, picks(low.members))).toMatchObject({ ok: false, status: 404 });
    // Each side sees its own until the result is reported; staff see both.
    ok(await setTeamLineup(top.captain.id, c.id, picks(top.members)));
    const ladderNow = (await ladderDetail(l.id, { forStaff: true }))!;
    const mine = await teamViews(ladderNow, [c.id], { userId: low.captain.id });
    expect(new Set(mine.get(c.id)!.lineup.map((x) => x.side))).toEqual(new Set(["home"]));
    expect(mine.get(c.id)!.mySide).toBe("home");
    const staff = await teamViews(ladderNow, [c.id], { staff: true });
    expect(new Set(staff.get(c.id)!.lineup.map((x) => x.side))).toEqual(new Set(["home", "away"]));
    expect(await teamViews(ladderNow, [c.id], { userId: (await adult()).id })).toEqual(new Map());
    // The lineup is told to those picked.
    expect((await mail(low.players[0].email)).some((m) => m.subject.includes("lineup"))).toBe(true);
    // A result in locks it.
    ok(await reportTeamResult(low.captain.id, c.id, games("home")));
    expect(await setTeamLineup(low.captain.id, c.id, picks(low.members))).toMatchObject({ ok: false, code: "LAD2_LINEUP_LOCKED" });
    // And both are seen once it is.
    const after = await teamViews((await ladderDetail(l.id, { forStaff: true }))!, [c.id], { userId: top.captain.id });
    expect(new Set(after.get(c.id)!.lineup.map((x) => x.side))).toEqual(new Set(["home", "away"]));
  });

  it("is reported game by game by one captain and confirmed by the other: the winner and the ranks follow, by the team league's checks", async () => {
    const { l, sides } = await populated(3);
    const [top, mid, low] = sides;
    const c = await accepted(l, low, mid);
    // The checks are a team league's: a game for each, scores the sport's scoring allows, a winner for the match.
    expect(await reportTeamResult(low.captain.id, c.id, games("home", 2))).toMatchObject({ ok: false, code: "TL_RUBBER_COUNT" });
    expect(await reportTeamResult(low.captain.id, c.id, [{ winner: "home", score: "banana" }, ...games("home", 2)])).toMatchObject({ ok: false, code: "TL_RUBBER_SCORE" });
    expect(await reportTeamResult(low.captain.id, c.id, games("home").map((g) => ({ ...g, walkover: true })))).toMatchObject({ ok: false, code: "LAD2_USE_REQUEST" });
    // The plain report is for players.
    expect(await report(low.captain.id, c.id, { winner: low.place!, score: "2-1" })).toMatchObject({ ok: false, code: "LAD2_TEAM_REPORT" });
    // Two of three: the challenger wins.
    const made = ok(await reportTeamResult(low.captain.id, c.id, [{ winner: "home", score: "21-10, 21-12" }, { winner: "away", score: "10-21, 12-21" }, { winner: "home", score: "21-15, 21-18" }]));
    expect(made).toMatchObject({ winner: low.place, score: "2-1" });
    expect(await reportTeamResult(mid.captain.id, c.id, games("away"))).toMatchObject({ ok: false, code: "LD_THEY_REPORTED" });
    expect(await confirm(low.captain.id, c.id)).toMatchObject({ ok: false });
    // The other captain sees it, and answers.
    const seen = (await myPlaces(mid.captain.id, l.id))[0].open[0];
    expect(seen).toMatchObject({ status: "reported", score: "2-1" });
    expect(seen.team!.rubbers.map((r) => r.winner)).toEqual(["home", "away", "home"]);
    ok(await confirm(mid.captain.id, c.id, { version: seen.version }));
    const d = (await ladderDetail(l.id))!;
    expect(d.rows.map((r) => r.name)).toEqual([top.team.name, low.team.name, mid.team.name]);
    // The public sees the rank and the confirmed result by team name only: no challenge, no games, no lineup, no member.
    expect(d.results).toEqual([expect.objectContaining({ winnerName: low.team.name, loserName: mid.team.name, score: "2-1" })]);
    const pub = JSON.stringify(d);
    for (const s of sides) for (const u of [s.captain, ...s.players]) expect(pub).not.toContain(u.name);
    expect(pub).not.toContain("lineup");
    // No game's score and no list of games for a challenge: only the ladder's own settings name the games it is made of.
    expect(pub).not.toContain("21-10");
    expect(pub).not.toContain('"played"');
  });

  it("needs a winner: a whole-team match that ends level is refused, and a disputed one is decided by a manager by its games", async () => {
    const court = futsalCourt;
    expect(court).toBeGreaterThan(0);
    const fl = await ladder({ sport: "futsal", team: { rosterMin: 2 } });
    expect(fl.team!.rubbers).toEqual(["team"]);
    const a = await side("FutA", 3, "futsal");
    const b = await side("FutB", 3, "futsal");
    await enter(fl, a);
    await enter(fl, b);
    const c = await accepted(fl, b, a);
    expect(await reportTeamResult(b.captain.id, c.id, [{ winner: null, score: "2-2" }])).toMatchObject({ ok: false, code: "LAD2_DRAW" });
    expect(await reportTeamResult(b.captain.id, c.id, [{ winner: "home", score: "banana" }])).toMatchObject({ ok: false, code: "TL_RUBBER_SCORE" });
    expect(await reportTeamResult(b.captain.id, c.id, [{ winner: "home", score: "3-1" }])).toMatchObject({ ok: true });
    // Disputed, and a manager decides by the games (the team league's checks and winner).
    expect(await dispute(a.captain.id, c.id, "It was a draw")).toMatchObject({ ok: true });
    expect(await decide(c.id, { adminId, name: "Mina Manager" }, { winner: a.place!, score: "1-0" }, "Settled")).toMatchObject({ ok: false, code: "LAD2_TEAM_REPORT" });
    expect(await decide(c.id, { adminId, name: "Mina Manager" }, { rubbers: [{ winner: "away", score: "1-2" }] }, "Replayed from the match sheet")).toMatchObject({ ok: true });
    const view = (await ladderDetail(fl.id, { forStaff: true }))!.challenges!.find((x) => x.id === c.id)!;
    expect(view).toMatchObject({ status: "confirmed", winner: a.place });
    expect(view.team!.rubbers).toEqual([expect.objectContaining({ winner: "away", score: "1-2", played: true })]);
    // Ranks: the challenged won, nobody moves.
    expect((await ladderDetail(fl.id))!.rows.map((r) => r.name)).toEqual([a.team.name, b.team.name]);
  });

  it("stands unanswered after three days, and an ignored challenge lapses with no effect: a forfeit is a manager's", async () => {
    const { l, sides } = await populated(3);
    const [, mid, low] = sides;
    const c = ok(await challenge(low.captain.id, l.id, low.place!, mid.place!, {}));
    await getDb().prepare("UPDATE ladder_challenges SET respond_by = ? WHERE id = ?").run(addDays(today, -1), c.id);
    await ladderHousekeeping();
    expect((await getDb().prepare("SELECT status, winner FROM ladder_challenges WHERE id = ?").get(c.id)) as { status: string; winner: number | null }).toEqual({ status: "lapsed", winner: null });
    expect((await ladderDetail(l.id))!.rows.map((r) => r.name)).toEqual([sides[0].team.name, mid.team.name, low.team.name]);
    expect((await mail(low.captain.email)).some((m) => m.body.includes("lapsed"))).toBe(true);
    // A reported result nobody answers stands.
    const c2 = await accepted(l, low, mid);
    ok(await reportTeamResult(low.captain.id, c2.id, games("home")));
    await getDb().prepare("UPDATE ladder_challenges SET reported_at = datetime('now', '-4 days') WHERE id = ?").run(c2.id);
    await ladderHousekeeping();
    expect((await ladderDetail(l.id))!.rows.map((r) => r.name)).toEqual([sides[0].team.name, low.team.name, mid.team.name]);
  });
});

describe("a forfeit on a ladder of teams is a manager's", () => {
  it("is asked for by a captain or staff, which changes nothing, and decided by a manager", async () => {
    const { l, sides } = await populated(3);
    const [, mid, low] = sides;
    const c = await accepted(l, low, mid);
    const before = JSON.stringify((await ladderDetail(l.id))!.rows);
    // A member is not the captain; a stranger is nobody; the reason is from the list.
    expect(await requestLadderForfeit({ userId: low.players[0].id }, c.id, { forfeitPlayer: mid.place, reason: "no_show" })).toMatchObject({ ok: false, status: 404 });
    expect(await requestLadderForfeit({ userId: low.captain.id }, c.id, { forfeitPlayer: mid.place, reason: "bored" })).toMatchObject({ ok: false, code: "TL_FR_REASON" });
    expect(await requestLadderForfeit({ userId: low.captain.id }, c.id, { forfeitPlayer: 999999, reason: "no_show" })).toMatchObject({ ok: false, code: "LAD2_FR_TEAM" });
    expect(await requestLadderForfeit({ userId: low.captain.id }, c.id, { forfeitPlayer: mid.place, reason: "other" })).toMatchObject({ ok: false, code: "TL_FR_NOTE" });
    const asked = ok(await requestLadderForfeit({ userId: low.captain.id }, c.id, { forfeitPlayer: mid.place, reason: "no_show", note: "Waited 30 minutes" }));
    expect(asked).toMatchObject({ status: "open", by: low.team.name, byKind: "captain", forfeitTeam: { id: mid.place, name: mid.team.name }, mine: true });
    expect(await requestLadderForfeit({ userId: low.captain.id }, c.id, { forfeitPlayer: mid.place, reason: "no_show" })).toMatchObject({ ok: false, code: "LAD2_FR_OPEN" });
    // It changed nothing: no result, no rank, the challenge as it was; the other captain was told.
    expect(JSON.stringify((await ladderDetail(l.id))!.rows)).toBe(before);
    expect((await myPlaces(low.captain.id, l.id))[0].open[0].status).toBe("accepted");
    expect((await mail(mid.captain.email)).some((m) => m.subject.includes("forfeit has been asked for"))).toBe(true);
    // Each captain sees the request on their challenge; the public does not.
    expect((await myPlaces(mid.captain.id, l.id))[0].open[0].forfeitRequests).toHaveLength(1);
    expect(JSON.stringify(await ladderDetail(l.id))).not.toContain("Waited 30 minutes");

    // The desk asks too; only a manager decides (the desk is refused), by the route.
    const askRoute = (cookie: string | undefined, body: unknown) => adminForfeits.POST(req(`/api/admin/ladders/${l.id}/forfeit-requests`, "POST", cookie, body), ctx(l.id));
    expect((await askRoute(undefined, { challengeId: c.id, forfeitPlayer: mid.place, reason: "told_us" })).status).toBe(401);
    expect((await askRoute(deskCookie, { challengeId: 999999, forfeitPlayer: mid.place, reason: "told_us" })).status).toBe(404);
    const byDesk = await askRoute(deskCookie, { challengeId: c.id, forfeitPlayer: mid.place, reason: "told_us" });
    expect(byDesk.status).toBe(201);
    const deskRequest = (await byDesk.json()).request as { id: number };
    const decide1 = (cookie: string, id: number, body: unknown) => adminForfeit.POST(req(`/api/admin/ladders/${l.id}/forfeit-requests/${id}`, "POST", cookie, body), ctx2(l.id, id));
    const refused = await decide1(deskCookie, deskRequest.id, { confirm: true });
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("MANAGER_ONLY");
    expect(managerOnly("POST", `/api/admin/ladders/${l.id}/forfeit-requests/${deskRequest.id}`)).toBe(true);
    expect(STAFF_ACTIONS.ladderForfeitDecide).toBe("POST /api/admin/ladders/1/forfeit-requests/1");
    // The desk takes its own request back.
    const withdrawn = await adminForfeit.DELETE(req(`/api/admin/ladders/${l.id}/forfeit-requests/${deskRequest.id}`, "DELETE", deskCookie), ctx2(l.id, deskRequest.id));
    expect(withdrawn.status).toBe(200);
    // A decline needs a reason and is told to both; the challenge stands.
    expect((await decide1(managerCookie, asked.id, { decline: true, reason: "x" })).status).toBe(400);
    expect((await decide1(managerCookie, asked.id, { decline: true, reason: "They have a medical note" })).status).toBe(200);
    expect((await myPlaces(low.captain.id, l.id))[0].open[0].status).toBe("accepted");
    expect((await mail(mid.captain.email)).some((m) => m.body.includes("They have a medical note"))).toBe(true);
    // Asked again, a manager confirms: the other team wins by default and takes the place; the request keeps who decided.
    const again = ok(await requestLadderForfeit({ userId: low.captain.id }, c.id, { forfeitPlayer: mid.place, reason: "no_show" }));
    const confirmed = await decide1(managerCookie, again.id, { confirm: true });
    expect(confirmed.status).toBe(200);
    expect((await confirmed.json()).request).toMatchObject({ status: "confirmed", decidedBy: "Mina Manager" });
    expect((await ladderDetail(l.id))!.rows.map((r) => r.name)).toEqual([sides[0].team.name, low.team.name, mid.team.name]);
    expect((await getDb().prepare("SELECT status, forfeit FROM ladder_challenges WHERE id = ?").get(c.id)) as { status: string; forfeit: boolean }).toEqual({ status: "walkover", forfeit: true });
    // Deciding it again is refused: it is no longer waiting. The log has every step.
    expect((await decide1(managerCookie, again.id, { confirm: true })).status).toBe(409);
    const actions = (await listActivity([venueId], { limit: 500 })).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["ladder.forfeit_requested", "ladder.forfeit_declined", "ladder.forfeit_confirmed", "ladder.forfeit_request_withdrawn"]));
  });

  it("closes by itself when the challenge ends another way, and expires after fourteen days, the captain told", async () => {
    const { l, sides } = await populated(3);
    const [, mid, low] = sides;
    const c = await accepted(l, low, mid);
    const asked = ok(await requestLadderForfeit({ userId: low.captain.id }, c.id, { forfeitPlayer: mid.place, reason: "no_show" }));
    ok(await reportTeamResult(low.captain.id, c.id, games("home")));
    await ladderHousekeeping();
    const closed = (await getDb().prepare("SELECT status, closed_reason FROM team_forfeit_requests WHERE id = ?").get(asked.id)) as { status: string; closed_reason: string };
    expect(closed).toEqual({ status: "closed", closed_reason: "decided" });
    ok(await decide(c.id, { adminId, name: "Mina" }, { void: true }, "Struck at the desk"));
    const c2 = await accepted(l, low, mid);
    const old = ok(await requestLadderForfeit({ userId: mid.captain.id }, c2.id, { forfeitPlayer: low.place, reason: "told_us" }));
    await getDb().prepare("UPDATE team_forfeit_requests SET expires_at = datetime('now', '-1 days') WHERE id = ?").run(old.id);
    await ladderHousekeeping();
    expect((await getDb().prepare("SELECT status FROM team_forfeit_requests WHERE id = ?").get(old.id)) as { status: string }).toEqual({ status: "expired" });
    expect((await mail(mid.captain.email)).some((m) => m.subject.includes("forfeit request expired"))).toBe(true);
    await ladderHousekeeping();
    expect((await mail(mid.captain.email)).filter((m) => m.subject.includes("forfeit request expired"))).toHaveLength(1);
  });
});

describe("a team leaving", () => {
  it("takes its open challenges with it, the other side told, nobody penalised; the teams below move up", async () => {
    const { l, sides } = await populated(3);
    const [, mid, low] = sides;
    const c = await accepted(l, low, mid);
    ok(await leave(mid.place!));
    expect((await getDb().prepare("SELECT status FROM ladder_challenges WHERE id = ?").get(c.id)) as { status: string }).toEqual({ status: "cancelled" });
    expect((await ladderDetail(l.id))!.rows.map((r) => [r.rank, r.name])).toEqual([[1, sides[0].team.name], [2, low.team.name]]);
    expect((await mail(low.captain.email)).some((m) => m.body.includes("left the ladder"))).toBe(true);
    // The team may come back, at the bottom.
    ok(await joinTeam(mid.captain, l.id, mid.team.id));
    expect((await ladderDetail(l.id))!.rows.map((r) => r.name).at(-1)).toBe(mid.team.name);
  });

  it("cannot be archived while it is on a ladder; and a captain's account erased withdraws it, with nobody to hand it to", async () => {
    const { l, sides } = await populated(3);
    const [, mid, low] = sides;
    expect(await archiveTeam(mid.captain.id, mid.team.id)).toMatchObject({ ok: false, code: "TM_ARCHIVE_ENTERED" });
    // Handed over, the new captain acts for the place.
    expect(await transferCaptain(mid.captain.id, mid.team.id, mid.members[1])).toMatchObject({ ok: true });
    expect((await myPlaces(mid.players[0].id, l.id)).map((p) => p.playerId)).toEqual([mid.place]);
    expect(await myPlaces(mid.captain.id, l.id)).toEqual([]);
    const made = ok(await challenge(low.captain.id, l.id, low.place!, mid.place!, {}));
    const c = ok(await answer(mid.players[0].id, made.id, { accept: true }));
    // The last captain's erasure, with no adult member to take over: off the ladder, its challenge ended, the other side told.
    await getDb().prepare("DELETE FROM player_profiles WHERE user_id IN (SELECT user_id FROM team_members WHERE team_id = ? AND user_id IS NOT NULL AND role <> 'captain')").run(mid.team.id);
    await forgetTeamsOfUser(mid.players[0].id, "(removed)");
    expect((await getDb().prepare("SELECT status FROM ladder_players WHERE id = ?").get(mid.place)) as { status: string }).toEqual({ status: "left" });
    expect((await getDb().prepare("SELECT status FROM ladder_challenges WHERE id = ?").get(c.id)) as { status: string }).toEqual({ status: "cancelled" });
    expect((await ladderDetail(l.id))!.rows.map((r) => r.name)).toEqual([sides[0].team.name, low.team.name]);
  });

  it("drops a member who leaves the team from the lineups still to be played, and anonymises a lineup of somebody erased", async () => {
    const { l, sides } = await populated(2);
    const [top, low] = sides;
    const c = await accepted(l, low, top);
    ok(await setTeamLineup(low.captain.id, c.id, [{ rubber: 1, memberIds: [low.members[1]] }, { rubber: 2, memberIds: [low.members[1], low.members[2]] }, { rubber: 3, memberIds: [low.members[2]] }]));
    expect(await removeMember(low.captain.id, low.team.id, low.members[1])).toMatchObject({ ok: true });
    const rows = (await getDb().prepare("SELECT team_member_id FROM ladder_challenge_lineups WHERE challenge_id = ? ORDER BY id").all(c.id)) as { team_member_id: number }[];
    expect(rows.map((r) => r.team_member_id)).toEqual([low.members[2], low.members[2]]);
  });
});

describe("children on a team: never public, shown to staff and their own side's captain", () => {
  it("names a child in a lineup to staff and the captain of their own side only, and never on a public page", async () => {
    const l = await ladder({ team: { rosterMin: 2 } });
    const a = await side("Kids", 2);
    const b = await side("Rivals", 3);
    const parent = await adult("Parent");
    const made = await addManaged(parent.id, { displayName: "Sofea", relationship: "parent", authority: true }, parent.name);
    if (!made.ok) throw new Error(made.error);
    const link = await createInviteLink(a.captain.id, a.team.id);
    if (!link.ok) throw new Error(link.error);
    await acceptInvitation(parent, new URL(link.value.link).searchParams.get("token"), { participantId: made.person.id });
    await enter(l, a);
    await enter(l, b);
    const c = await accepted(l, b, a);
    const kid = (await teamView(a.team.id, a.captain.id))!.roster!.find((m) => m.junior)!.id;
    const cap = (await teamView(a.team.id, a.captain.id))!.roster!.find((m) => !m.junior)!.id;
    ok(await setTeamLineup(a.captain.id, c.id, [{ rubber: 1, memberIds: [kid] }, { rubber: 2, memberIds: [kid, cap] }, { rubber: 3, memberIds: [cap] }]));
    ok(await setTeamLineup(b.captain.id, c.id, [{ rubber: 1, memberIds: [b.members[0]] }, { rubber: 2, memberIds: [b.members[0], b.members[1]] }, { rubber: 3, memberIds: [b.members[2]] }]));
    ok(await reportTeamResult(b.captain.id, c.id, games("home")));
    const names = (v: Awaited<ReturnType<typeof teamViews>>) => v.get(c.id)!.lineup.filter((x) => x.junior).map((x) => x.name);
    const ladderNow = (await ladderDetail(l.id, { forStaff: true }))!;
    expect(names(await teamViews(ladderNow, [c.id], { staff: true }))).toContain("Sofea");
    expect(names(await teamViews(ladderNow, [c.id], { userId: a.captain.id }))).toContain("Sofea");
    // The other side's captain sees that a junior played, not who.
    expect(names(await teamViews(ladderNow, [c.id], { userId: b.captain.id })).every((x) => x === "")).toBe(true);
    // The guardian is told, naming the child (as a team league's lineup does).
    expect((await mail(parent.email)).some((m) => m.body.includes("Sofea") && m.subject.includes("lineup"))).toBe(true);
    // The public page, a confirmed result and the ladder's JSON carry no child's name.
    ok(await confirm(a.captain.id, c.id));
    expect(JSON.stringify(await ladderDetail(l.id))).not.toContain("Sofea");
    expect(JSON.stringify((await myPlaces(b.captain.id, l.id))[0])).not.toContain("Sofea");
  });
});

describe("ratings", () => {
  it("read a rated ladder of teams as the teams' own results, through the ledger's hook; a forfeit moves nothing", async () => {
    const { l, sides } = await populated(3);
    const [top, mid, low] = sides;
    ok(await setEventRated("ladder", l.id, true));
    const c = await accepted(l, low, mid);
    ok(await reportTeamResult(low.captain.id, c.id, games("home")));
    ok(await confirm(mid.captain.id, c.id));
    const rows = (await getDb().prepare("SELECT format, kind, outcome::float AS outcome, unit_no FROM rated_results WHERE source_kind = 'ladder' AND source_id = ?").all(l.id)) as { format: string; kind: string; outcome: number; unit_no: number }[];
    expect(rows).toEqual([{ format: "team", kind: "played", outcome: 1, unit_no: 0 }]);
    // A challenge given as a forfeit is a walkover, which moves no rating.
    const c2 = await accepted(l, mid, top);
    ok(await decide(c2.id, { adminId, name: "Mina" }, { winner: mid.place!, walkover: true }, "They did not come"));
    const after = (await getDb().prepare("SELECT kind FROM rated_results WHERE source_kind = 'ladder' AND source_id = ? ORDER BY id").all(l.id)) as { kind: string }[];
    expect(after.map((r) => r.kind)).toEqual(["played", "walkover"]);
    // A corrected result replays: the first becomes the other side's win.
    ok(await decide(c.id, { adminId, name: "Mina" }, { rubbers: games("away") }, "Match sheet says the other way"));
    const replay = (await getDb().prepare("SELECT outcome::float AS outcome FROM rated_results WHERE source_kind = 'ladder' AND source_id = ? AND source_match = ? AND voided_at IS NULL").all(l.id, c.id)) as { outcome: number }[];
    expect(replay).toEqual([{ outcome: 0 }]);
  });
});

describe("through the routes", () => {
  it("a captain enters a team and reports through the player's routes; the staff route decides by games; every one is authorised", async () => {
    const l = await ladder();
    const a = await side("RouteA");
    const b = await side("RouteB");
    const post = (user: User | null, body: unknown) => playerLadder.POST(req(`/api/ladders/${l.id}`, "POST", undefined, body), ctx(l.id)).then(async (r) => ({ r, user }));
    expect((await post(null, { action: "join_team", teamId: a.team.id })).r.status).toBe(401);
    const asCaptain = async (u: User, body: unknown) => playerLadder.POST(req(`/api/ladders/${l.id}`, "POST", await cookieOf(u), body), ctx(l.id));
    expect((await asCaptain(a.players[0], { action: "join_team", teamId: a.team.id })).status).toBe(403);
    const joined = await asCaptain(a.captain, { action: "join_team", teamId: a.team.id });
    expect(joined.status).toBe(201);
    expect((await asCaptain(b.captain, { action: "join_team", teamId: b.team.id })).status).toBe(201);
    // The ladder's page lists the teams a signed-in captain may enter.
    const page = await playerLadder.GET(req(`/api/ladders/${l.id}`, "GET", await cookieOf(a.captain)), ctx(l.id));
    expect((await page.json()).teams).toEqual(expect.any(Array));
    const placeA = ((await (await asCaptain(a.captain, { action: "challenge", playerId: 0, target: 0 })).json()) as { error?: string }).error;
    expect(placeA).toBeDefined();
    const mineA = (await myPlaces(a.captain.id, l.id))[0];
    const mineB = (await myPlaces(b.captain.id, l.id))[0];
    const made = await asCaptain(b.captain, { action: "challenge", playerId: mineB.playerId, target: mineA.playerId });
    expect(made.status).toBe(200);
    const challengeId = (await made.json()).result.id as number;
    const onChallenge = async (u: User | null, body: unknown) =>
      challengeRoute.POST(req(`/api/ladders/${l.id}/challenges/${challengeId}`, "POST", u ? await cookieOf(u) : undefined, body), ctx2(l.id, challengeId));
    expect((await onChallenge(a.captain, { action: "accept" })).status).toBe(200);
    expect((await onChallenge(null, { action: "report_team", rubbers: games("home") })).status).toBe(401);
    expect((await onChallenge(a.players[0], { action: "report_team", rubbers: games("home") })).status).toBe(404);
    const bad = await onChallenge(b.captain, { action: "report_team", rubbers: games("home", 1) });
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe("TL_RUBBER_COUNT");
    const lineup = await onChallenge(b.captain, { action: "set_lineup", picks: [{ rubber: 1, memberIds: [b.members[0]] }, { rubber: 2, memberIds: [b.members[0], b.members[1]] }, { rubber: 3, memberIds: [b.members[2]] }] });
    expect(lineup.status).toBe(200);
    const reported = await onChallenge(b.captain, { action: "report_team", rubbers: games("home") });
    expect(reported.status).toBe(200);
    expect((await reported.json()).result).toMatchObject({ score: "3-0" });
    const asked = await onChallenge(a.captain, { action: "request_forfeit", forfeitPlayer: mineB.playerId, reason: "told_us" });
    // Reported already: a forfeit is moot, and the request is refused.
    expect(asked.status).toBe(409);
    expect((await asked.json()).code).toBe("LAD2_NOT_ACCEPTED");
    const staff = (cookie: string, body: unknown) => adminLadder.POST(req(`/api/admin/ladders/${l.id}`, "POST", cookie, body), ctx(l.id));
    expect((await staff(deskCookie, { action: "decide", challengeId, reason: "Match sheet", rubbers: games("away") })).status).toBe(403);
    const decided = await staff(managerCookie, { action: "decide", challengeId, reason: "Match sheet", rubbers: games("away") });
    expect(decided.status).toBe(200);
    const row = (await getDb().prepare("SELECT status, winner FROM ladder_challenges WHERE id = ?").get(challengeId)) as { status: string; winner: number };
    expect(row).toEqual({ status: "confirmed", winner: mineA.playerId });
    // Creating a ladder of teams by the route: a manager's.
    const create = (cookie: string, body: unknown) => import("../src/app/api/admin/ladders/route").then((m) => m.POST(req("/api/admin/ladders", "POST", cookie, body)));
    expect((await create(deskCookie, { venueId, name: "Route Teams Ladder", sport: "badminton", kind: "teams" })).status).toBe(403);
    const created = await create(managerCookie, { venueId, name: "Route Teams Ladder", sport: "badminton", kind: "teams", courtTime: { on: true } });
    expect(created.status).toBe(201);
    expect((await created.json()).ladder).toMatchObject({ kind: "teams", courtTime: { on: true } });
    expect((await create(managerCookie, { venueId, name: "Odd Teams Ladder", sport: "badminton", kind: "clubs" })).status).toBe(400);
  });
});

describe("held court time for a team match", () => {
  it("holds a court for the games added up, one after another, or refuses the acceptance", async () => {
    const court = await createCourt({ venueId, name: "Team Held Court", sport: "badminton", offPeakRate: 10, peakRate: 12 });
    if (!court.ok) throw new Error(court.error);
    const l = await ladder({ courtTime: { on: true, courtIds: [court.court.id] }, settings: { cooldownDays: 0, playDays: 60 } });
    const a = await side("HoldA");
    const b = await side("HoldB");
    await enter(l, a);
    await enter(l, b);
    const day = addDays(today, 6);
    const made = ok(await challenge(b.captain.id, l.id, b.place!, a.place!, { onDate: day, minute: 18 * 60 }));
    const done = ok(await answer(a.captain.id, made.id, { accept: true }));
    // Three games of 45 minutes: 135 minutes on one court.
    expect(done.hold).toMatchObject({ court: "Team Held Court", date: day, startMin: 18 * 60, endMin: 18 * 60 + 135 });
    const taken = await createBooking({ courtId: court.court.id, date: day, hours: [20], name: "Customer", phone: "0123334444", staff: { override: true } });
    expect(taken.ok).toBe(false);
    // A second challenge for a time inside it is refused, with the reason.
    const c = await side("HoldC");
    const dd = await side("HoldD");
    await enter(l, c);
    await enter(l, dd);
    const second = ok(await challenge(dd.captain.id, l.id, dd.place!, c.place!, { onDate: day, minute: 19 * 60 }));
    expect(await answer(c.captain.id, second.id, { accept: true })).toMatchObject({ ok: false, code: "LAD2_NO_COURT" });
    // A forfeit given by a manager lets the court go.
    ok(await decide(made.id, { adminId, name: "Mina" }, { winner: b.place!, walkover: true }, "They did not come"));
    expect((await getDb().prepare("SELECT released_reason FROM ladder_court_holds WHERE challenge_id = ?").get(made.id)) as { released_reason: string }).toEqual({ released_reason: "forfeited" });
    expect(ok(await answer(c.captain.id, second.id, { accept: true })).hold).toMatchObject({ startMin: 19 * 60 });
    void freeze;
  });

  it("is tentative until both captains confirm it, and lapses if they do not (ADR 0048): the games' court time is let go whole", async () => {
    const court = await createCourt({ venueId, name: "Team Confirm Court", sport: "badminton", offPeakRate: 10, peakRate: 12 });
    if (!court.ok) throw new Error(court.error);
    const l = await ladder({ courtTime: { on: true, courtIds: [court.court.id] }, settings: { cooldownDays: 0, playDays: 60 } });
    const a = await side("ConfA");
    const b = await side("ConfB");
    await enter(l, a);
    await enter(l, b);
    const day = addDays(today, 7);
    // The challenged captain accepts the day and a manager holds a court at a time the captains had not agreed, so it is tentative (ADR 0048, ADR 0050); a captain naming a time
    // of their own would be a counter-proposal, which holds nothing (ADR 0051).
    const made = ok(await challenge(b.captain.id, l.id, b.place!, a.place!, { onDate: day }));
    ok(await answer(a.captain.id, made.id, { accept: true }));
    const done = ok(await staffHold(made.id, { adminId, name: "Mina" }, { move: { onDate: day, minute: 18 * 60 } }, "Courts are busy that week"));
    expect(done.hold).toMatchObject({ tentative: true, endMin: 18 * 60 + 135, confirmedBy: { challenger: false, challenged: false } });
    const blocks = async () => ((await getDb().prepare("SELECT c.expires_at FROM claims c JOIN blocks k ON k.id = c.block_id JOIN ladder_court_holds h ON h.id = k.ladder_hold_id WHERE h.challenge_id = ? AND c.active").all(made.id)) as { expires_at: unknown }[]);
    expect((await blocks()).length).toBeGreaterThan(0);
    expect((await blocks()).every((r) => r.expires_at !== null)).toBe(true);
    // The captains confirm for their teams (a member who is not the captain is not a side); the second confirmation completes it.
    expect(ok(await confirmHoldAsPlayer(a.captain.id, made.id)).hold).toMatchObject({ tentative: true, confirmedBy: { challenged: true, challenger: false } });
    expect(ok(await confirmHoldAsPlayer(b.captain.id, made.id)).hold).toMatchObject({ tentative: false });
    expect((await blocks()).every((r) => r.expires_at === null)).toBe(true);
    // A second match that is never confirmed: the whole of its court time is let go, once, both captains told.
    const c = await side("ConfC");
    const dd = await side("ConfD");
    await enter(l, c);
    await enter(l, dd);
    const second = ok(await challenge(dd.captain.id, l.id, dd.place!, c.place!, { onDate: day }));
    ok(await answer(c.captain.id, second.id, { accept: true }));
    ok(await staffHold(second.id, { adminId, name: "Mina" }, { move: { onDate: day, minute: 10 * 60 } }, "Courts are busy that week"));
    await getDb().prepare("UPDATE ladder_court_holds SET confirm_by = now() - interval '1 minute' WHERE challenge_id = ? AND released_at IS NULL").run(second.id);
    await getDb().prepare("UPDATE claims SET expires_at = now() - interval '1 minute' WHERE kind = 'block' AND block_id IN (SELECT k.id FROM blocks k JOIN ladder_court_holds h ON h.id = k.ladder_hold_id WHERE h.challenge_id = ?)").run(second.id);
    await ladderHousekeeping();
    await ladderHousekeeping();
    expect((await getDb().prepare("SELECT released_reason FROM ladder_court_holds WHERE challenge_id = ?").get(second.id)) as { released_reason: string }).toEqual({ released_reason: "expired" });
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM blocks k JOIN ladder_court_holds h ON h.id = k.ladder_hold_id WHERE h.challenge_id = ?").get(second.id)) as { n: number }).n).toBe(0);
    for (const s of [c, dd]) expect((await mail(s.captain.email)).filter((m) => m.subject.includes("Court let go"))).toHaveLength(1);
    // The first match's hold is untouched.
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM blocks k JOIN ladder_court_holds h ON h.id = k.ladder_hold_id WHERE h.challenge_id = ? AND h.released_at IS NULL").get(made.id)) as { n: number }).n).toBeGreaterThan(0);
  });

  it("is confirmed at once when the captains agree an exact time: one proposes it, the other accepts it unchanged (ADR 0050); each captain's agreement is kept", async () => {
    const court = await createCourt({ venueId, name: "Team Agreed Court", sport: "badminton", offPeakRate: 10, peakRate: 12 });
    if (!court.ok) throw new Error(court.error);
    const l = await ladder({ courtTime: { on: true, courtIds: [court.court.id] }, settings: { cooldownDays: 0, playDays: 60 } });
    const a = await side("AgrA");
    const b = await side("AgrB");
    await enter(l, a);
    await enter(l, b);
    const day = addDays(today, 9);
    const made = ok(await challenge(b.captain.id, l.id, b.place!, a.place!, { onDate: day, minute: 18 * 60 }));
    const done = ok(await answer(a.captain.id, made.id, { accept: true }));
    expect(done.hold).toMatchObject({ tentative: false, agreed: true, confirmBy: null, confirmedBy: { challenger: true, challenged: true }, endMin: 18 * 60 + 135 });
    const rows = (await getDb().prepare("SELECT player_id, role, date, start_min FROM ladder_agreed_times WHERE challenge_id = ? ORDER BY role").all(made.id)) as { player_id: number; role: string; date: string; start_min: number }[];
    expect(rows).toEqual([
      { player_id: a.place!, role: "accepted", date: day, start_min: 18 * 60 },
      { player_id: b.place!, role: "proposed", date: day, start_min: 18 * 60 },
    ]);
  });
});
