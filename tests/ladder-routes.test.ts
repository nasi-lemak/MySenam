/// <reference types="vite/client" />
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { createLadder, join } from "../src/lib/ladders";
import { listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { createTournament, enter, makeDraw, tournamentDetail } from "../src/lib/tournaments";
import * as publicList from "../src/app/api/ladders/route";
import * as publicOne from "../src/app/api/ladders/[id]/route";
import * as publicChallenge from "../src/app/api/ladders/[id]/challenges/[challengeId]/route";
import * as adminList from "../src/app/api/admin/ladders/route";
import * as adminOne from "../src/app/api/admin/ladders/[id]/route";
import * as adminPlayers from "../src/app/api/admin/ladders/[id]/players/route";
import * as adminTournament from "../src/app/api/admin/tournaments/[id]/route";

/**
 * The routes of ladders and of a Swiss event's rounds (ADR 0033): who may do what, what is logged, and what the public sees.
 */

let venueId: number;
let managerCookie: string;
let deskCookie: string;
let n = 0;

beforeAll(async () => {
  await ensureBootstrapAdmin();
  venueId = (await listVenues())[0].id;
  const manager = await createAdmin({ name: "Musa Ladder", email: "musa@ladder-routes.test", password: "manager-pass-1", venueId });
  const desk = await createAdmin({ name: "Dina Ladder", email: "dina@ladder-routes.test", password: "desk-password-1", venueId, role: "desk" });
  if (!manager.ok || !desk.ok) throw new Error("staff");
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(manager.admin.id)).token}`;
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
});

async function player(): Promise<{ user: User; cookie: string }> {
  n++;
  const made = await registerUser({ name: `Route Player${n}`, email: `lr${n}@ladder-routes.test`, phone: `01390${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return { user: made.user, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}

const req = (url: string, method: string, cookie?: string, body?: unknown) =>
  new NextRequest(`http://localhost${url}`, { method, headers: cookie ? { cookie } : {}, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
const ctx2 = (id: number, challengeId: number) => ({ params: Promise.resolve({ id: String(id), challengeId: String(challengeId) }) });
const create = (cookie: string, over: Record<string, unknown> = {}) =>
  adminList.POST(req("/api/admin/ladders", "POST", cookie, { venueId, name: `Route Ladder ${++n}`, sport: "badminton", ...over }));

describe("ladders, for staff", () => {
  it("are set up, changed and run by a manager; the desk reads and adds players at the counter; each in the activity log", async () => {
    expect((await create(deskCookie)).status).toBe(403);
    expect((await adminList.POST(req("/api/admin/ladders", "POST"))).status).toBe(401);
    const made = await create(managerCookie, { settings: { reach: 2 } });
    expect(made.status).toBe(201);
    const ladder = (await made.json()).ladder as { id: number; settings: { reach: number } };
    expect(ladder.settings.reach).toBe(2);
    expect((await create(managerCookie, { settings: { reach: 99 } })).status).toBe(400);
    expect((await adminList.GET(req(`/api/admin/ladders?venueId=${venueId}`, "GET", deskCookie))).status).toBe(200);
    expect((await adminOne.GET(req(`/api/admin/ladders/${ladder.id}`, "GET", deskCookie), ctx(ladder.id))).status).toBe(200);
    // The desk cannot decide, move, remove or change settings.
    for (const body of [{ action: "settings", settings: { reach: 3 } }, { action: "move", playerId: 1, rank: 1, reason: "x y z" }, { action: "end_season" }]) {
      const res = await adminOne.POST(req(`/api/admin/ladders/${ladder.id}`, "POST", deskCookie, body), ctx(ladder.id));
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("MANAGER_ONLY");
    }
    // The desk adds a player at the counter; the player says they are 18 or over, on staff's word.
    const noAdult = await adminPlayers.POST(req(`/api/admin/ladders/${ladder.id}/players`, "POST", deskCookie, { phone: "0123456789", name: "Walk In" }), ctx(ladder.id));
    expect(noAdult.status).toBe(400);
    expect((await noAdult.json()).code).toBe("LD_ADULT_DECLARE");
    const added = await adminPlayers.POST(req(`/api/admin/ladders/${ladder.id}/players`, "POST", deskCookie, { phone: "0123456789", name: "Walk In", adult: true }), ctx(ladder.id));
    expect(added.status).toBe(201);
    const playerId = ((await added.json()).player as { playerId: number }).playerId;
    // A manager moves, freezes and removes, each with a reason where it needs one.
    const second = await adminPlayers.POST(req(`/api/admin/ladders/${ladder.id}/players`, "POST", managerCookie, { phone: "0123456780", name: "Second Walk In", adult: true }), ctx(ladder.id));
    const secondId = ((await second.json()).player as { playerId: number }).playerId;
    const step = (body: Record<string, unknown>) => adminOne.POST(req(`/api/admin/ladders/${ladder.id}`, "POST", managerCookie, body), ctx(ladder.id));
    expect((await step({ action: "move", playerId: secondId, rank: 1 })).status).toBe(400);
    expect((await step({ action: "move", playerId: secondId, rank: 1, reason: "Returning champion" })).status).toBe(200);
    expect((await step({ action: "move", playerId: 999999, rank: 1, reason: "Returning champion" })).status).toBe(404);
    expect((await step({ action: "freeze", playerId, until: addDays(todayISO(), 10) })).status).toBe(200);
    expect((await step({ action: "thaw", playerId })).status).toBe(200);
    expect((await step({ action: "rated", rated: true })).status).toBe(200);
    expect((await step({ action: "settings", settings: { reach: 4 } })).status).toBe(200);
    expect((await step({ action: "remove", playerId, reason: "Moved away" })).status).toBe(200);
    expect((await step({ action: "nonsense" })).status).toBe(400);
    const body = (await (await adminOne.GET(req(`/api/admin/ladders/${ladder.id}`, "GET", managerCookie), ctx(ladder.id))).json()).ladder as { rows: { playerId: number }[]; events: unknown[]; rated: boolean; settings: { reach: number } };
    expect(body.rows.map((r) => r.playerId)).toEqual([secondId]);
    expect(body.events.length).toBeGreaterThan(3);
    expect(body.rated).toBe(true);
    expect(body.settings.reach).toBe(4);
    expect((await step({ action: "end_season" })).status).toBe(200);
    expect((await step({ action: "close" })).status).toBe(200);
    const logged = ((await getDb().prepare("SELECT action FROM staff_actions WHERE action LIKE 'ladder.%' ORDER BY id").all()) as { action: string }[]).map((l) => l.action);
    expect(logged).toEqual(expect.arrayContaining(["ladder.created", "ladder.joined_at_counter", "ladder.moved", "ladder.frozen", "ladder.thawed", "ladder.rated", "ladder.settings", "ladder.removed", "ladder.season_ended", "ladder.closed"]));
    const note = (await getDb().prepare("SELECT detail FROM staff_actions WHERE action = 'ladder.moved'").get()) as { detail: string };
    expect(note.detail).toContain("Returning champion");
  });
});

describe("ladders, for players and the public", () => {
  it("lists open ladders and shows a ladder to anybody, with names as the ladder shows them and nothing private", async () => {
    const made = await createLadder({ venueId, name: `Public Ladder ${++n}`, sport: "badminton", teamSize: 1, level: null }, 1);
    if (!made.ok) throw new Error(made.error);
    const a = await player();
    const b = await player();
    expect((await join(a.user, made.value.id, { adult: true })).ok).toBe(true);
    expect((await join(b.user, made.value.id, { adult: true })).ok).toBe(true);
    const list = await publicList.GET(req("/api/ladders", "GET"));
    expect(((await list.json()).ladders as { id: number }[]).some((l) => l.id === made.value.id)).toBe(true);
    expect((await publicList.GET(req("/api/ladders?sport=nonsense", "GET"))).status).toBe(400);
    const one = await publicOne.GET(req(`/api/ladders/${made.value.id}`, "GET"), ctx(made.value.id));
    expect(one.status).toBe(200);
    const text = JSON.stringify(await one.json());
    expect(text).not.toContain("0139");
    expect(text).not.toContain("@ladder-routes.test");
    expect((await publicOne.GET(req("/api/ladders/999999", "GET"), ctx(999999))).status).toBe(404);
    // Signed out: nothing to do here.
    expect((await publicOne.POST(req(`/api/ladders/${made.value.id}`, "POST", undefined, { action: "leave", playerId: 1 }), ctx(made.value.id))).status).toBe(401);
    // Signed in: a challenge and its answers through the routes, in the player's own name.
    const mine = (await (await publicOne.GET(req(`/api/ladders/${made.value.id}`, "GET", b.cookie), ctx(made.value.id))).json()).mine as { playerId: number; targets: { playerId: number; not: unknown }[] }[];
    expect(mine).toHaveLength(1);
    expect(mine[0].targets).toHaveLength(1);
    const target = mine[0].targets[0].playerId;
    expect((await publicOne.POST(req(`/api/ladders/${made.value.id}`, "POST", a.cookie, { action: "challenge", playerId: mine[0].playerId, target }), ctx(made.value.id))).status).toBe(404);
    const issued = await publicOne.POST(req(`/api/ladders/${made.value.id}`, "POST", b.cookie, { action: "challenge", playerId: mine[0].playerId, target }), ctx(made.value.id));
    expect(issued.status).toBe(200);
    const challenge = ((await issued.json()).result as { id: number; version: number });
    const answer = (cookie: string, body: Record<string, unknown>) =>
      publicChallenge.POST(req(`/api/ladders/${made.value.id}/challenges/${challenge.id}`, "POST", cookie, body), ctx2(made.value.id, challenge.id));
    // The challenger cannot accept their own challenge.
    expect((await answer(b.cookie, { action: "accept", version: challenge.version })).status).toBe(409);
    const accepted = await answer(a.cookie, { action: "accept", version: challenge.version });
    expect(accepted.status).toBe(200);
    const view = (await accepted.json()).challenge as { version: number };
    // A stale answer names the version it saw: refused as changed, with its code.
    const stale = await answer(a.cookie, { action: "accept", version: challenge.version });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe("LD_CHANGED");
    expect((await answer(b.cookie, { action: "report", winner: mine[0].playerId, score: "21-10, 21-12", version: view.version })).status).toBe(200);
    // Confirming needs the version.
    expect((await answer(a.cookie, { action: "confirm" })).status).toBe(400);
    expect((await answer(a.cookie, { action: "nonsense" })).status).toBe(400);
  });
});

describe("a Swiss event's rounds, through the route", () => {
  it("is a manager's: the desk is refused; closing a round and ending early are answered and logged", async () => {
    const venue = (await listVenues())[0];
    const courts = venue.courts.filter((c) => c.sport === "badminton").slice(0, 2).map((c) => c.id);
    const day = addDays(todayISO(), 120);
    const made = await createTournament({ venueId, name: "Route Swiss", sport: "badminton", format: "swiss", teamSize: 1, level: null, entryFee: 0, maxEntries: 16, startsOn: day, endsOn: addDays(day, 2), startHour: 9, endHour: 21, courtIds: courts, rules: { swiss: { rounds: 3 } } }, 1);
    if (!made.ok) throw new Error(made.error);
    for (let i = 0; i < 4; i++) {
      const p = await player();
      const e = await enter(p.user, made.value.id);
      if (!e.ok) throw new Error(e.error);
    }
    const drawn = await makeDraw(made.value.id, () => 0.4);
    if (!drawn.ok) throw new Error(drawn.error);
    const post = (cookie: string, body: Record<string, unknown>) => adminTournament.POST(req(`/api/admin/tournaments/${made.value.id}`, "POST", cookie, body), ctx(made.value.id));
    expect((await post(deskCookie, { action: "swiss_pair" })).status).toBe(403);
    expect((await post(deskCookie, { action: "swiss_end" })).status).toBe(403);
    // Nothing is due to pair yet: round 1 is not decided.
    expect((await post(managerCookie, { action: "swiss_pair" })).status).toBe(409);
    const open = (await tournamentDetail(made.value.id))!.matches.filter((m) => m.status === "scheduled");
    expect((await post(managerCookie, { action: "swiss_close_round", round: 1, resolutions: [{ matchId: open[0].id, winner: open[0].a }] })).status).toBe(409);
    const closed = await post(managerCookie, {
      action: "swiss_close_round",
      round: 1,
      resolutions: [{ matchId: open[0].id, winner: open[0].a }, { matchId: open[1].id, winner: null }],
    });
    expect(closed.status).toBe(200);
    const tn = (await closed.json()).tournament as { swiss: { rounds: unknown[] } };
    expect(tn.swiss.rounds).toHaveLength(2);
    expect((await post(managerCookie, { action: "swiss_end" })).status).toBe(200);
    const logged = ((await getDb().prepare("SELECT action FROM staff_actions WHERE action LIKE 'tournament.swiss_%' ORDER BY id").all()) as { action: string }[]).map((l) => l.action);
    expect(logged).toEqual(["tournament.swiss_round_closed", "tournament.swiss_ended"]);
    // The public page of the event carries the standings and why each pairing was made, never an entry's contact.
    const detail = JSON.stringify(await tournamentDetail(made.value.id));
    expect(detail).toContain("standings");
    expect(detail).not.toContain("@ladder-routes.test");
  });
});
