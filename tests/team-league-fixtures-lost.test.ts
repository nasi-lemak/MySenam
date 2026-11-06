import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { registerUser, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { saveProfile } from "../src/lib/player-profiles";
import { createCourt, listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { setPlayerGender } from "../src/lib/who";
import { acceptInvitation, createInviteLink, createTeam, teamView, type Team } from "../src/lib/teams";
import { createTeamLeague, enterTeam, generateFixtures, postponeLeagueDay, teamLeagueById, teamLeagueDetail, type TeamLeagueInput } from "../src/lib/team-leagues";
import * as adminLeague from "../src/app/api/admin/team-leagues/[id]/route";
import { fixturesOnCourt, strandedFixtures, tellFixturesLost } from "../src/lib/competition-fixtures";
import { createOutage } from "../src/lib/outages";

/**
 * Leagues of teams (lib/team-leagues.ts, lib/fixtures.ts; migration 0269): setting one up, teams entering with a roster
 * picked per member, the fixture list on the manager's nights with each fixture's court time held, lineups,
 * results by the sport's scoring rules and the table, forfeits, moves (managers only) and what the public sees.
 */

vi.setConfig({ testTimeout: 60_000 });

let ownerId: number;
let venueId: number;
let courts: number[];
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
});

describe("a team league's fixtures on a court that is gone (F3)", () => {
  const scheduled = async (leagueId: number, date: string) =>
    (await getDb().prepare("SELECT id, court_id, start_min, date FROM team_fixtures WHERE league_id = ? AND date = ? AND status = 'scheduled' ORDER BY start_min, id").all(leagueId, date)) as {
      id: number;
      court_id: number;
      start_min: number;
      date: string;
    }[];
  const lost = async (like: string) => (await getDb().prepare("SELECT recipient, body FROM messages WHERE dedupe_key LIKE ? ORDER BY id").all(like)) as { recipient: string; body: string }[];

  it("shows the fixtures a court outage strands, tells both captains once, and lists them until postponed", async () => {
    const { l, sides } = await made(4, { courtIds: courts.slice(0, 2) }, 4);
    const night = (await detail(l.id)).nights[1].date;
    const day = await scheduled(l.id, night);
    expect(day.length).toBeGreaterThan(0);
    const court = day[0].court_id;
    const on = day.filter((f) => f.court_id === court);
    const found = await fixturesOnCourt(court, night, night);
    expect(found.filter((f) => f.kind === "team_league" && f.ownerId === l.id).map((f) => f.id).sort()).toEqual(on.map((f) => f.id).sort());
    const out = await createOutage({ courtId: court, startsOn: night, endsOn: night, reason: "Roof leak", adminId: ownerId });
    if (!out.ok) throw new Error(out.error);
    expect(out.fixtures!.filter((f) => f.ownerId === l.id).length).toBe(on.length);
    const captains = new Set(sides.map((s) => s.captain.email));
    const told = await lost("fixture-lost:l%");
    expect(told.length).toBe(on.length * 2);
    expect(told.every((m) => captains.has(m.recipient) && m.body.includes("cannot go ahead") && m.body.includes("out of service"))).toBe(true);
    // Once: a repeat tells nobody again.
    await tellFixturesLost(out.fixtures!, "outage");
    expect((await lost("fixture-lost:l%")).length).toBe(told.length);
    expect((await strandedFixtures(null)).filter((f) => f.kind === "team_league" && f.ownerId === l.id).map((f) => f.id).sort()).toEqual(on.map((f) => f.id).sort());
  });

  it("postpones a night: each fixture moves to the same time the next day, both captains told, the rest of the league untouched", async () => {
    const { l, sides } = await made(4, { courtIds: courts.slice(0, 2) }, 4);
    const nightsList = (await detail(l.id)).nights;
    const night = nightsList[0].date;
    const to = addDays(night, 2);
    const before = await scheduled(l.id, night);
    const otherNight = await scheduled(l.id, nightsList[1].date);
    const moved = await postponeLeagueDay(l.id, night, to);
    if (!moved.ok) throw new Error(moved.error);
    expect(moved.value.left).toEqual([]);
    expect(moved.value.moved).toBe(before.length);
    const after = await scheduled(l.id, to);
    expect(after.map((f) => f.start_min).sort()).toEqual(before.map((f) => f.start_min).sort());
    expect(await scheduled(l.id, night)).toEqual([]);
    expect(await scheduled(l.id, nightsList[1].date)).toEqual(otherNight);
    // Held for the league on the new day.
    const held = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM blocks WHERE team_league_id = ? AND date = ?").get(l.id, to)) as { n: number };
    expect(held.n).toBeGreaterThan(0);
    const captains = sides.map((s) => s.captain.email);
    for (const c of captains) expect((await mail(c)).some((m) => m.body.includes(to))).toBe(true);
  });

  it("says which fixtures could not be placed and leaves them where they were", async () => {
    const { l } = await made(4, { courtIds: courts.slice(0, 2) }, 4);
    const nightsList = (await detail(l.id)).nights;
    // Onto the next match night: the same teams already play there at the same time.
    const moved = await postponeLeagueDay(l.id, nightsList[0].date, nightsList[1].date);
    if (!moved.ok) throw new Error(moved.error);
    expect(moved.value.moved + moved.value.left.length).toBeGreaterThan(0);
    for (const left of moved.value.left) expect((await getDb().prepare("SELECT date FROM team_fixtures WHERE id = ?").get(left.fixtureId))).toMatchObject({ date: nightsList[0].date });
    expect(await postponeLeagueDay(l.id, nightsList[0].date, nightsList[0].date)).toMatchObject({ ok: false });
    expect(await postponeLeagueDay(999999, nightsList[0].date, addDays(nightsList[0].date, 1))).toMatchObject({ ok: false, status: 404 });
  });

  it("is a manager's action through the league route", async () => {
    const { l } = await made(4, { courtIds: courts.slice(0, 2) }, 4);
    const night = (await detail(l.id)).nights[0].date;
    const manager = await createAdmin({ name: `Mina ${n}`, email: `mina-pd${n}@venue.my`, password: "manager-pass-1", venueId });
    const desk = await createAdmin({ name: `Dan ${n}`, email: `dan-pd${n}@venue.my`, password: "desk-password-1", venueId, role: "desk" });
    if (!manager.ok || !desk.ok) throw new Error("staff");
    const cookie = async (id: number) => `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(id)).token}`;
    const post = async (c: string, body: object) =>
      adminLeague.POST(new NextRequest(`http://localhost/api/admin/team-leagues/${l.id}`, { method: "POST", headers: { "content-type": "application/json", cookie: c }, body: JSON.stringify(body) }), {
        params: Promise.resolve({ id: String(l.id) }),
      });
    expect((await post(await cookie(desk.admin.id), { action: "postpone_day", from: night, to: addDays(night, 2) })).status).toBeGreaterThanOrEqual(401);
    const done = await post(await cookie(manager.admin.id), { action: "postpone_day", from: night, to: addDays(night, 2) });
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ moved: expect.any(Number), left: [] });
  });
});
