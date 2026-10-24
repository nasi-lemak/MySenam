import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE, type User } from "../src/lib/auth";
import { askToJoin, openGame, setPlayerLevel } from "../src/lib/games";
import { createBooking, listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { getDb } from "../src/lib/db";
import type { Sport } from "../src/lib/types";

/** The matchmaking routes: who may call them, and what they will and will not say. */

let n = 0;
let courtId: number;
let sport: Sport;
let slot = 0;

async function player(): Promise<User & { cookie: string }> {
  n++;
  const made = await registerUser({ name: `Route Player ${n}`, email: `rp${n}@route.my`, phone: `01350${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return { ...made.user, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}

async function hostGame(over: Partial<Parameters<typeof openGame>[1]> = {}) {
  const host = await player();
  slot++;
  const b = await createBooking({ courtId, date: addDays(todayISO(), 2 + (slot % 10)), hours: [9 + Math.floor(slot / 10)], name: host.name, phone: host.phone, userId: host.id });
  if (!b.ok) throw new Error("booking");
  const g = await openGame(host.id, { bookingCode: b.booking.code, spots: 2, level: null, share: 5, autoAccept: true, ...over });
  if (!g.ok) throw new Error(g.error);
  return { host, game: g.game };
}

const json = (url: string, method: string, cookie: string | null, body?: unknown) =>
  new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.9.${n}.1`, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const params = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

beforeAll(async () => {
  const v = (await listVenues()).find((x) => x.courts.length > 0)!;
  courtId = v.courts[0].id;
  sport = ((await getDb().prepare("SELECT sport FROM courts WHERE id = ?").get(courtId)) as { sport: Sport }).sport;
});

describe("profile and suggestions", () => {
  it("need an account, refuse a minor being found, and explain every suggestion", async () => {
    const me = await player();
    const profile = await import("../src/app/api/my/profile/route");
    expect((await profile.GET(json("http://localhost/api/my/profile", "GET", null))).status).toBe(401);
    expect((await profile.PUT(json("http://localhost/api/my/profile", "PUT", me.cookie, { adult: false, discoverable: true }))).status).toBe(400);
    const saved = await profile.PUT(json("http://localhost/api/my/profile", "PUT", me.cookie, { adult: true, discoverable: true, intensity: "casual" }));
    expect(saved.status).toBe(200);
    expect((await saved.json()).profile).toMatchObject({ adult: true, discoverable: true, intensity: "casual" });

    await setPlayerLevel(me.id, sport, "beginner");
    const { game } = await hostGame({ level: "beginner" });
    const rec = await import("../src/app/api/games/recommended/route");
    expect((await rec.GET(json("http://localhost/api/games/recommended", "GET", null))).status).toBe(401);
    const res = await rec.GET(json("http://localhost/api/games/recommended?limit=50", "GET", me.cookie));
    const body = await res.json();
    const found = body.games.find((g: { id: number }) => g.id === game.id);
    expect(found.match.reasons.map((r: { code: string }) => r.code)).toEqual(expect.arrayContaining(["SPORT_YOU_PLAY", "LEVEL_EXACT"]));
    expect((await rec.GET(json("http://localhost/api/games/recommended?sport=nonsense", "GET", me.cookie))).status).toBe(400);
  });
});

describe("one game", () => {
  it("shows a private game only to its host, its invitees and link holders, and lets only the host run it", async () => {
    const { host, game } = await hostGame({ visibility: "private" });
    const stranger = await player();
    const route = await import("../src/app/api/games/[id]/route");
    const get = (cookie: string | null, query = "") => route.GET(json(`http://localhost/api/games/${game.id}${query}`, "GET", cookie), params(game.id));
    expect((await get(stranger.cookie)).status).toBe(404);
    expect((await get(null)).status).toBe(404);
    const hosted = await (await get(host.cookie)).json();
    expect(hosted.game).toMatchObject({ id: game.id, yours: true, players: [] });

    const post = (cookie: string, body: object) => route.POST(json(`http://localhost/api/games/${game.id}`, "POST", cookie, body), params(game.id));
    expect((await post(stranger.cookie, { action: "link" })).status).toBe(404);
    const made = await (await post(host.cookie, { action: "link", hours: 6 })).json();
    const link = new URL(made.url).searchParams.get("link")!;
    expect((await get(stranger.cookie, `?link=${link}`)).status).toBe(200);
    expect((await post(stranger.cookie, { action: "join", link })).status).toBe(200);
    expect((await post(stranger.cookie, { action: "cancel" })).status).toBe(404);
    expect(await (await post(host.cookie, { action: "unlink" })).json()).toEqual({ revoked: 1 });
    expect((await get(null, `?link=${link}`)).status).toBe(404);

    // Inviting answers alike for an address with an account and one without.
    const a = await post(host.cookie, { action: "invite", email: "nobody@nowhere.my" });
    const b = await post(host.cookie, { action: "invite", email: stranger.email });
    expect([a.status, b.status]).toEqual([200, 200]);
    expect((await post(host.cookie, { action: "cancel" })).status).toBe(200);
  });

  it("lists suggested players to the host alone", async () => {
    const { host, game } = await hostGame();
    const route = await import("../src/app/api/games/[id]/candidates/route");
    const stranger = await player();
    const call = (cookie: string | null) => route.GET(json(`http://localhost/api/games/${game.id}/candidates`, "GET", cookie), params(game.id));
    expect((await call(null)).status).toBe(401);
    expect((await call(stranger.cookie)).status).toBe(404);
    expect((await call(host.cookie)).status).toBe(200);
  });
});

describe("blocks and reports", () => {
  it("block, list and unblock somebody met in a game; report them to the owner, who alone sees reports", async () => {
    const { host, game } = await hostGame();
    const p = await player();
    await askToJoin(p, game.id);
    const blocks = await import("../src/app/api/players/blocks/route");
    const stranger = await player();
    expect((await blocks.POST(json("http://localhost/api/players/blocks", "POST", stranger.cookie, { userId: host.id }))).status).toBe(404);
    const done = await blocks.POST(json("http://localhost/api/players/blocks", "POST", host.cookie, { userId: p.id }));
    expect((await done.json()).blocks).toEqual([expect.objectContaining({ userId: p.id })]);
    const undone = await blocks.DELETE(json("http://localhost/api/players/blocks", "DELETE", host.cookie, { userId: p.id }));
    expect((await undone.json()).blocks).toEqual([]);

    const reports = await import("../src/app/api/players/reports/route");
    expect((await reports.POST(json("http://localhost/api/players/reports", "POST", p.cookie, { userId: host.id, reason: "spam", gameId: game.id }))).status).toBe(200);

    const admin = await import("../src/app/api/admin/player-reports/route");
    const desk = await createAdmin({ name: "Desk", email: "desk@route.my", password: "desk-password-1", venueId: (await listVenues())[0].id });
    const owner = await createAdmin({ name: "Owner", email: "owner@route.my", password: "owner-password-1", venueId: null });
    if (!desk.ok || !owner.ok) throw new Error("admins");
    const deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
    const ownerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(owner.admin.id)).token}`;
    expect((await admin.GET(json("http://localhost/api/admin/player-reports", "GET", deskCookie))).status).toBe(403);
    const list = await (await admin.GET(json("http://localhost/api/admin/player-reports?status=open", "GET", ownerCookie))).json();
    const report = list.reports.find((r: { reported: { id: number } }) => r.reported.id === host.id);
    expect(report).toMatchObject({ reason: "spam", gameId: game.id });
    expect((await admin.POST(json("http://localhost/api/admin/player-reports", "POST", ownerCookie, { id: report.id }))).status).toBe(200);
    expect((await admin.POST(json("http://localhost/api/admin/player-reports", "POST", ownerCookie, { id: report.id }))).status).toBe(404);
  });
});
