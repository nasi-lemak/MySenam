import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE, type User } from "../src/lib/auth";
import { occupantsOn } from "../src/lib/claims";
import { getDb } from "../src/lib/db";
import { instantOf } from "../src/lib/interval";
import { confirmDeadline, holdViews, resolveHoldLimits } from "../src/lib/ladder-holds";
import { sweepExpiredHolds } from "../src/lib/ladder-hold-sweep";
import {
  answer,
  answerMove,
  challenge,
  changeCourtTime,
  confirmHoldAsPlayer,
  createLadder,
  ladderDetail,
  ladderHousekeeping,
  myPlaces,
  proposeMove,
  join,
  staffHold,
  withdraw,
  type LadderInput,
} from "../src/lib/ladders";
import { listActivity } from "../src/lib/activity";
import { blockSlots, createBooking, createCourt, createVenue, listVenues, venueHours } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import * as adminLadder from "../src/app/api/admin/ladders/[id]/route";
import * as challengeRoute from "../src/app/api/ladders/[id]/challenges/[challengeId]/route";

/**
 * The owner's decision of 5 November 2026 on court time held for ladder challenges (ADR 0048; migration 0290; lib/ladder-holds.ts):
 * the caps are configurable defaults (ladder, then venue, then install, inside install bounds), a hold is tentative until both players or a manager
 * confirm it and expires (by the scheduler and lazily, on every read and claim), no two holds can overlap on a court, and a limit only ever refuses.
 * tests/ladder-held-court-time.test.ts holds the round 10 behaviour these build on.
 */

vi.setConfig({ testTimeout: 120_000 });

let venueId: number;
let adminId: number;
let courtA: number;
let courtB: number;
let managerCookie: string;
let deskCookie: string;
let otherManagerCookie: string;
let n = 0;
let dayNo = 0;
const today = todayISO();
/** Each scenario plays on a day of its own, so what one holds another does not find taken. */
const freshDay = () => addDays(today, 5 + dayNo++);
const START = 18 * 60;
const db = () => getDb();

async function person(name = "Lim"): Promise<User> {
  n++;
  const made = await registerUser({ name: `${name} Player${n}`, email: `lim${n}@ladder.test`, phone: `01384${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return made.user;
}

function ok<T>(r: { ok: true; value: T } | { ok: false; error: string; code?: string }): T {
  if (!r.ok) throw new Error(`${r.error} (${r.code ?? ""})`);
  return r.value;
}

const req = (url: string, method: string, cookie?: string, body?: unknown) =>
  new NextRequest(`http://localhost${url}`, { method, headers: { ...(cookie ? { cookie } : {}), origin: "http://localhost", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
const ctx2 = (id: number, challengeId: number) => ({ params: Promise.resolve({ id: String(id), challengeId: String(challengeId) }) });
const cookieOf = async (u: User) => `${SESSION_COOKIE}=${(await createSession(u.id)).token}`;

beforeAll(async () => {
  await ensureBootstrapAdmin();
  adminId = (await listAdmins())[0].id;
  const venue = (await listVenues())[0];
  venueId = venue.id;
  const a = await createCourt({ venueId, name: "Limit Court A", sport: "badminton", offPeakRate: 10, peakRate: 12 });
  const b = await createCourt({ venueId, name: "Limit Court B", sport: "badminton", offPeakRate: 10, peakRate: 12 });
  if (!a.ok || !b.ok) throw new Error("courts");
  courtA = a.court.id;
  courtB = b.court.id;
  const manager = await createAdmin({ name: "Mina Manager", email: "mina-lim@venue.my", password: "manager-pass-1", venueId });
  const desk = await createAdmin({ name: "Dan Desk", email: "dan-lim@venue.my", password: "desk-password-1", venueId, role: "desk" });
  const other = await createVenue({ name: "Another Venue", area: "Elsewhere", address: "2 Other Road", phone: "0312345678" });
  if (!manager.ok || !desk.ok || !other.ok) throw new Error("staff");
  const rival = await createAdmin({ name: "Rita Rival", email: "rita-lim@venue.my", password: "manager-pass-2", venueId: other.venue.id });
  if (!rival.ok) throw new Error("rival");
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(manager.admin.id)).token}`;
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
  otherManagerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(rival.admin.id)).token}`;
});

type Pl = { user: User; id: number };

/** A ladder that holds court time on the courts given (default: court A alone), with `count` players joined. */
async function ladder(over: Partial<LadderInput> = {}, count = 4) {
  n++;
  const { settings, ...rest } = over;
  const l = ok(await createLadder({ venueId, name: `Limit Ladder ${n}`, sport: "badminton", teamSize: 1, level: null, settings: { cooldownDays: 0, playDays: 60, ...settings }, courtTime: { on: true, courtIds: [courtA] }, ...rest }, adminId));
  const people: Pl[] = [];
  for (let i = 0; i < count; i++) {
    const user = await person();
    people.push({ user, id: ok(await join(user, l.id, { adult: true })).playerId });
  }
  return { l, people };
}

/** The player lower on the ladder challenges the one above at a day and time; the other accepts (the proposal is the agreed time). */
async function accept(l: { id: number }, low: Pl, high: Pl, day: string, minute = START) {
  const made = ok(await challenge(low.user.id, l.id, low.id, high.id, { onDate: day, minute }));
  return answer(high.user.id, made.id, { accept: true });
}

async function held(over: Partial<LadderInput> = {}) {
  const s = await ladder(over);
  const [, top, low] = s.people;
  const day = freshDay();
  const c = ok(await accept(s.l, low, top, day));
  return { ...s, top, low, c, day };
}

type HoldRow = {
  id: number;
  court_id: number;
  date: string;
  start_min: number;
  released_at: string | null;
  released_reason: string | null;
  released_by: string | null;
  confirm_by: Date | string | null;
  confirmed_at: Date | string | null;
  confirmed_by: string | null;
  extended_at: Date | string | null;
  extended_by: string | null;
  extend_note: string | null;
  expiry_told_at: Date | string | null;
};
const holdRows = async (challengeId: number) => (await db().prepare("SELECT * FROM ladder_court_holds WHERE challenge_id = ? ORDER BY id").all(challengeId)) as HoldRow[];
const lastHold = async (challengeId: number) => (await holdRows(challengeId)).at(-1)!;
const liveBlocks = async (challengeId: number) =>
  (await db()
    .prepare("SELECT b.court_id, b.date, b.start_min, b.end_min FROM blocks b JOIN ladder_court_holds h ON h.id = b.ladder_hold_id WHERE h.challenge_id = ? AND h.released_at IS NULL ORDER BY b.start_min")
    .all(challengeId)) as { court_id: number; date: string; start_min: number; end_min: number }[];
/** The lapse moment carried by the claims of a hold's blocks (null: none). */
const claimExpiries = async (challengeId: number) =>
  ((await db()
    .prepare("SELECT c.expires_at FROM claims c JOIN blocks b ON b.id = c.block_id JOIN ladder_court_holds h ON h.id = b.ladder_hold_id WHERE h.challenge_id = ? AND c.active")
    .all(challengeId)) as { expires_at: Date | string | null }[]).map((r) => (r.expires_at === null ? null : new Date(r.expires_at).getTime()));
const count = async (sql: string) => ((await db().prepare(sql).get()) as { n: number }).n;
const mail = async (to: string) => (await db().prepare("SELECT subject, body FROM messages WHERE kind IN ('programme', 'team_decision') AND recipient = ? ORDER BY id").all(to)) as { subject: string; body: string }[];
const mailAbout = async (to: string, text: string) => (await mail(to)).filter((m) => m.subject.includes(text));
const ms = (d: Date | string | null) => (d === null ? null : new Date(d).getTime());

/** Time passes: the hold's confirm-by moment, and the one its claims carry, are a minute ago (the scheduler has not run). */
async function lapse(challengeId: number) {
  await db().prepare("UPDATE ladder_court_holds SET confirm_by = now() - interval '1 minute' WHERE challenge_id = ? AND released_at IS NULL").run(challengeId);
  await db()
    .prepare("UPDATE claims SET expires_at = now() - interval '1 minute' WHERE kind = 'block' AND block_id IN (SELECT b.id FROM blocks b JOIN ladder_court_holds h ON h.id = b.ladder_hold_id WHERE h.challenge_id = ?)")
    .run(challengeId);
}

const send = (cookie: string | undefined, ladderId: number, body: unknown) => adminLadder.POST(req(`/api/admin/ladders/${ladderId}`, "POST", cookie, body), ctx(ladderId));
const view = async (l: { id: number }, challengeId: number) => (await ladderDetail(l.id, { forStaff: true }))!.challenges!.find((c) => c.id === challengeId)!;
const limitsOf = async (l: { id: number }) => (await ladderDetail(l.id, { forStaff: true }))!.holdLimits!;

/** A manager sets caps by the route; it must be accepted. */
async function caps(ladderId: number, body: Record<string, unknown>) {
  const r = await send(managerCookie, ladderId, { action: "hold_limits", scope: "ladder", ...body });
  expect(r.status).toBe(200);
}

/** Run `fn` and put the venue's setting back as it was, so one scenario's caps never reach another's. */
async function clean(fn: () => Promise<void>) {
  try {
    await fn();
  } finally {
    await db().prepare("DELETE FROM venue_ladder_hold_limits WHERE venue_id = ?").run(venueId);
    await db().prepare("UPDATE ladder_hold_limits SET max_live_per_ladder = 8, max_per_player_week = 4, live_min = 1, live_max = 50, week_min = 1, week_max = 20, confirm_hours = 48, min_notice_minutes = 120, extend_hours = 24 WHERE id = 1").run();
  }
}

describe("the caps are configurable defaults", () => {
  it("resolves ladder override, then venue setting, then install default, and says where each comes from", async () => {
    await clean(async () => {
      const one = await ladder({}, 2);
      const two = await ladder({}, 2);
      expect(await limitsOf(one.l)).toMatchObject({ maxLivePerLadder: 8, maxPerPlayerWeek: 4, from: { live: "install", week: "install" }, bounds: { liveMin: 1, liveMax: 50, weekMin: 1, weekMax: 20 }, inUse: 0 });
      // The venue's setting reaches every ladder of the venue that has none of its own.
      expect((await send(managerCookie, one.l.id, { action: "hold_limits", scope: "venue", maxLive: 3, maxWeek: 2 })).status).toBe(200);
      expect(await limitsOf(one.l)).toMatchObject({ maxLivePerLadder: 3, maxPerPlayerWeek: 2, from: { live: "venue", week: "venue" } });
      expect(await limitsOf(two.l)).toMatchObject({ maxLivePerLadder: 3, maxPerPlayerWeek: 2 });
      // A ladder's own override beats the venue's, one number at a time.
      expect((await send(managerCookie, one.l.id, { action: "hold_limits", scope: "ladder", maxLive: 6 })).status).toBe(200);
      expect(await limitsOf(one.l)).toMatchObject({ maxLivePerLadder: 6, maxPerPlayerWeek: 2, from: { live: "ladder", week: "venue" }, ladder: { maxLivePerLadder: 6, maxPerPlayerWeek: null } });
      expect(await limitsOf(two.l)).toMatchObject({ maxLivePerLadder: 3 });
      // null goes back to the default above it.
      expect((await send(managerCookie, one.l.id, { action: "hold_limits", scope: "ladder", maxLive: null })).status).toBe(200);
      expect(await limitsOf(one.l)).toMatchObject({ maxLivePerLadder: 3, from: { live: "venue" } });
      expect((await send(managerCookie, one.l.id, { action: "hold_limits", scope: "venue", maxLive: null, maxWeek: null })).status).toBe(200);
      expect(await limitsOf(one.l)).toMatchObject({ maxLivePerLadder: 8, maxPerPlayerWeek: 4, from: { live: "install", week: "install" } });
      // The resolution is the one the hold uses: the same function.
      expect(await resolveHoldLimits({ id: one.l.id, venueId })).toMatchObject({ maxLivePerLadder: 8, maxPerPlayerWeek: 4 });
    });
  });

  it("refuses a number outside the install's bounds, with the bounds, and changes nothing", async () => {
    await clean(async () => {
      const s = await ladder({}, 2);
      for (const bad of [0, -1, 51, 2.5, "many", 1e9]) {
        const r = await send(managerCookie, s.l.id, { action: "hold_limits", scope: "ladder", maxLive: bad });
        expect(r.status).toBe(400);
        expect(await r.json()).toMatchObject({ code: "LAD3_BOUNDS", vars: { what: "live", min: 1, max: 50 } });
      }
      for (const bad of [0, 21]) {
        const r = await send(managerCookie, s.l.id, { action: "hold_limits", scope: "venue", maxWeek: bad });
        expect(r.status).toBe(400);
        expect(await r.json()).toMatchObject({ code: "LAD3_BOUNDS", vars: { what: "week", min: 1, max: 20 } });
      }
      // One good and one bad value change neither.
      expect((await send(managerCookie, s.l.id, { action: "hold_limits", scope: "ladder", maxLive: 5, maxWeek: 99 })).status).toBe(400);
      expect(await limitsOf(s.l)).toMatchObject({ ladder: { maxLivePerLadder: null, maxPerPlayerWeek: null }, venue: { maxLivePerLadder: null, maxPerPlayerWeek: null } });
      // The edges are allowed.
      expect((await send(managerCookie, s.l.id, { action: "hold_limits", scope: "ladder", maxLive: 50, maxWeek: 20 })).status).toBe(200);
      expect((await send(managerCookie, s.l.id, { action: "hold_limits", scope: "ladder", maxLive: 1, maxWeek: 1 })).status).toBe(200);
      // The bounds are install data: a stricter install refuses what the default bounds would take.
      await db().prepare("UPDATE ladder_hold_limits SET live_max = 10 WHERE id = 1").run();
      const r = await send(managerCookie, s.l.id, { action: "hold_limits", scope: "ladder", maxLive: 11 });
      expect(await r.json()).toMatchObject({ code: "LAD3_BOUNDS", vars: { min: 1, max: 10 } });
    });
  });

  it("is a manager's: the desk, a signed-out visitor and another venue's manager cannot; the desk can see, players and the public cannot", async () => {
    await clean(async () => {
      const s = await ladder({}, 3);
      const body = { action: "hold_limits", scope: "venue", maxLive: 2 };
      expect((await send(deskCookie, s.l.id, body)).status).toBe(403);
      expect((await send(undefined, s.l.id, body)).status).toBe(401);
      expect((await send(otherManagerCookie, s.l.id, body)).status).toBe(403);
      expect((await send(otherManagerCookie, s.l.id, { action: "court_time", needsConfirmation: false })).status).toBe(403);
      expect((await limitsOf(s.l)).venue.maxLivePerLadder).toBeNull();
      // The desk reads the ladder with its limits (the dashboard), by the staff route.
      const read = await adminLadder.GET(req(`/api/admin/ladders/${s.l.id}`, "GET", deskCookie), ctx(s.l.id));
      expect(read.status).toBe(200);
      expect((await read.json()).ladder.holdLimits).toMatchObject({ maxLivePerLadder: 8, maxPerPlayerWeek: 4 });
      // Nobody else is shown them: not the public, not a player's own place.
      expect(JSON.stringify(await ladderDetail(s.l.id))).not.toContain("holdLimits");
      expect(JSON.stringify(await myPlaces(s.people[0].user.id, s.l.id))).not.toContain("maxLivePerLadder");
    });
  });

  it("logs every change with who made it, what it was and what it became, and the reason when there is one", async () => {
    await clean(async () => {
      const s = await ladder({}, 2);
      expect((await send(managerCookie, s.l.id, { action: "hold_limits", scope: "ladder", maxLive: 5, maxWeek: 3, reason: "Busy season, more matches" })).status).toBe(200);
      expect((await send(managerCookie, s.l.id, { action: "hold_limits", scope: "venue", maxLive: 12 })).status).toBe(200);
      const log = (await listActivity([venueId], { limit: 500 })).filter((e) => e.action === "ladder.hold_limits");
      const ladderEntry = log.find((e) => e.detail?.includes("Busy season"))!;
      expect(ladderEntry.adminName).toBe("Mina Manager");
      expect(ladderEntry.detail).toContain("this ladder's caps");
      expect(ladderEntry.detail).toContain("live per ladder default to 5");
      expect(ladderEntry.detail).toContain("per player in 7 days default to 3");
      const venueEntry = log.find((e) => e.detail?.includes("the venue's caps") && e.detail.includes("to 12"))!;
      expect(venueEntry.detail).toContain("live per ladder default to 12");
      // A refused change is not logged.
      const before = log.length;
      await send(managerCookie, s.l.id, { action: "hold_limits", scope: "ladder", maxLive: 0 });
      expect((await listActivity([venueId], { limit: 500 })).filter((e) => e.action === "ladder.hold_limits")).toHaveLength(before);
    });
  });

  it("a ladder's weekly cap counts the holds made for a player; raising it lets the pending acceptance through, held through the claim as ever", async () => {
    await clean(async () => {
      const s = await ladder({}, 3);
      const [, top, low] = s.people;
      await caps(s.l.id, { maxWeek: 1 });
      const first = ok(await accept(s.l, low, top, freshDay()));
      expect(first.hold).not.toBeNull();
      // Withdrawing and asking again cannot churn a court: the first hold, released, still counts.
      ok(await withdraw(low.user.id, first.id));
      expect(await accept(s.l, low, top, freshDay())).toMatchObject({ ok: false, code: "LAD2_CAP_PLAYER", vars: { n: 1 } });
      await caps(s.l.id, { maxWeek: 2 });
      const open = (await myPlaces(low.user.id, s.l.id))[0].open[0];
      expect(ok(await answer(top.user.id, open.id, { accept: true })).hold).toMatchObject({ court: "Limit Court A" });
    });
  });
});

describe("a limit changed never lets go of a hold, and never stops a manager freeing or moving one", () => {
  it("lowered below what is in use: every hold stays, new holds are refused, and a move or release still works", async () => {
    await clean(async () => {
      const s = await ladder({}, 10);
      const [, p2, p3, p4, p5, p6, p7, p8, p9] = s.people;
      const a = ok(await accept(s.l, p3, p2, freshDay()));
      const b = ok(await accept(s.l, p5, p4, freshDay()));
      const c = ok(await accept(s.l, p7, p6, freshDay()));
      expect((await limitsOf(s.l)).inUse).toBe(3);
      await caps(s.l.id, { maxLive: 1 });
      // All three are still held: nothing was released by the change.
      for (const x of [a, b, c]) expect(await liveBlocks(x.id)).toHaveLength(1);
      expect(await count(`SELECT COUNT(*)::int AS n FROM ladder_court_holds WHERE ladder_id = ${s.l.id} AND released_at IS NULL`)).toBe(3);
      expect(await limitsOf(s.l)).toMatchObject({ maxLivePerLadder: 1, inUse: 3 });
      // A new hold is refused with the reason; the challenge stays pending.
      expect(await accept(s.l, p9, p8, freshDay())).toMatchObject({ ok: false, code: "LAD2_CAP_LADDER" });
      expect((await myPlaces(p8.user.id, s.l.id))[0].open[0].status).toBe("pending");
      // A manager moves one of them: it replaces a hold and adds none, so it is not capped.
      const day = freshDay();
      const moved = await send(managerCookie, s.l.id, { action: "hold_move", challengeId: a.id, onDate: day, minute: START, reason: "Re-laid court" });
      expect(moved.status).toBe(200);
      expect((await liveBlocks(a.id))[0]).toMatchObject({ date: day });
      // And releases one: the others stay, and the cap still counts them.
      expect((await send(managerCookie, s.l.id, { action: "hold_release", challengeId: b.id, reason: "Booked by themselves" })).status).toBe(200);
      expect(await liveBlocks(b.id)).toEqual([]);
      expect(await limitsOf(s.l)).toMatchObject({ inUse: 2 });
    });
  });

  it("a ladder at its cap refuses the next acceptance, leaves the challenge pending, and takes it once a hold is let go", async () => {
    await clean(async () => {
      const s = await ladder({}, 6);
      const [, p2, p3, p4, p5] = s.people;
      await caps(s.l.id, { maxLive: 1 });
      const first = ok(await accept(s.l, p3, p2, freshDay()));
      const second = await accept(s.l, p5, p4, freshDay());
      expect(second).toMatchObject({ ok: false, code: "LAD2_CAP_LADDER", vars: { n: 1 } });
      expect((await myPlaces(p4.user.id, s.l.id))[0].open[0].status).toBe("pending");
      expect((await send(managerCookie, s.l.id, { action: "hold_release", challengeId: first.id, reason: "No longer needed" })).status).toBe(200);
      const open = (await myPlaces(p4.user.id, s.l.id))[0].open[0];
      expect(ok(await answer(p4.user.id, open.id, { accept: true })).hold).not.toBeNull();
    });
  });
});

describe("a hold is tentative until both players, or a manager, confirm it", () => {
  it("is made tentative on acceptance: the court is held, the claims carry the lapse moment, and both are asked to confirm", async () => {
    const a = await held();
    expect(a.c.hold).toMatchObject({ tentative: true, confirmedBy: { challenger: false, challenged: false }, extended: false });
    const row = await lastHold(a.c.id);
    // 48 hours from now, by the install's window (the match is days away).
    const wait = ms(row.confirm_by)! - Date.now();
    expect(wait).toBeGreaterThan(47.9 * 3_600_000);
    expect(wait).toBeLessThanOrEqual(48 * 3_600_000);
    expect(new Date(a.c.hold!.confirmBy!).getTime()).toBe(ms(row.confirm_by));
    expect(await claimExpiries(a.c.id)).toEqual([ms(row.confirm_by)]);
    // Held all the same: nobody can book it.
    const stranger = await person("Stranger");
    expect((await createBooking({ courtId: courtA, date: a.day, hours: [START / 60], name: stranger.name, phone: stranger.phone, userId: stranger.id, staff: { override: true } })).ok).toBe(false);
    // The one asked to answer is told to confirm, and by when.
    const told = (await mail(a.low.user.email)).find((m) => m.body.includes("confirm the court by"));
    expect(told).toBeDefined();
    expect(told!.body).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  });

  it("is confirmed when both players have, the first confirmation telling the other, a repeat changing and telling nobody", async () => {
    const a = await held();
    const sentBefore = (await mail(a.low.user.email)).length;
    const first = ok(await confirmHoldAsPlayer(a.top.user.id, a.c.id));
    expect(first.hold).toMatchObject({ tentative: true, confirmedBy: { challenger: false, challenged: true } });
    expect(await mailAbout(a.low.user.email, "Please confirm the court")).toHaveLength(1);
    // Again: nothing changes, nobody is told again.
    ok(await confirmHoldAsPlayer(a.top.user.id, a.c.id));
    expect(await mailAbout(a.low.user.email, "Please confirm the court")).toHaveLength(1);
    expect((await mail(a.low.user.email)).length).toBe(sentBefore + 1);
    const second = ok(await confirmHoldAsPlayer(a.low.user.id, a.c.id));
    expect(second.hold).toMatchObject({ tentative: false, confirmBy: null });
    const row = await lastHold(a.c.id);
    expect(row.confirmed_at).not.toBeNull();
    // The claims no longer carry a lapse moment: the court is the hold's until it is let go.
    expect(await claimExpiries(a.c.id)).toEqual([null]);
    expect(await mailAbout(a.top.user.email, "Court confirmed")).toHaveLength(1);
    // A confirmed hold does not expire, whatever the clock says.
    expect(await sweepExpiredHolds()).toEqual([]);
    expect(await liveBlocks(a.c.id)).toHaveLength(1);
  });

  it("is confirmed through the player's route; a stranger and a signed-out visitor are refused", async () => {
    const a = await held();
    const post = async (u: User | null, body: unknown) => challengeRoute.POST(req(`/api/ladders/${a.l.id}/challenges/${a.c.id}`, "POST", u ? await cookieOf(u) : undefined, body), ctx2(a.l.id, a.c.id));
    expect((await post(null, { action: "confirm_hold" })).status).toBe(401);
    expect((await post(await person("Stranger"), { action: "confirm_hold" })).status).toBe(404);
    const done = await post(a.top.user, { action: "confirm_hold" });
    expect(done.status).toBe(200);
    expect((await done.json()).challenge.hold).toMatchObject({ tentative: true, confirmedBy: { challenged: true, challenger: false } });
    const both = await post(a.low.user, { action: "confirm_hold" });
    expect((await both.json()).challenge.hold).toMatchObject({ tentative: false });
    // Nothing left to confirm: a repeat is not an error.
    expect((await post(a.low.user, { action: "confirm_hold" })).status).toBe(200);
  });

  it("is confirmed for both by a manager, logged, and told to both; a desk member cannot", async () => {
    const a = await held();
    expect((await send(deskCookie, a.l.id, { action: "hold_confirm", challengeId: a.c.id })).status).toBe(403);
    expect((await send(otherManagerCookie, a.l.id, { action: "hold_confirm", challengeId: a.c.id })).status).toBe(403);
    expect((await send(managerCookie, a.l.id, { action: "hold_confirm", challengeId: 999999 })).status).toBe(404);
    const done = await send(managerCookie, a.l.id, { action: "hold_confirm", challengeId: a.c.id, reason: "They told the desk" });
    expect(done.status).toBe(200);
    expect((await view(a.l, a.c.id)).hold).toMatchObject({ tentative: false });
    expect((await lastHold(a.c.id)).confirmed_by).toBe("Mina Manager");
    expect(await claimExpiries(a.c.id)).toEqual([null]);
    for (const p of [a.low, a.top]) expect(await mailAbout(p.user.email, "Court confirmed")).toHaveLength(1);
    const log = (await listActivity([venueId], { limit: 500 })).find((e) => e.action === "ladder.hold_confirmed");
    expect(log?.adminName).toBe("Mina Manager");
    expect(log?.detail).toContain("They told the desk");
    // Again: no second notice.
    expect((await send(managerCookie, a.l.id, { action: "hold_confirm", challengeId: a.c.id })).status).toBe(200);
    expect(await mailAbout(a.low.user.email, "Court confirmed")).toHaveLength(1);
  });

  it("is confirmed at once on a ladder whose manager turned the requirement off, and turning it on or off touches no hold already made", async () => {
    const s = await ladder({}, 6);
    const [, p2, p3, p4, p5] = s.people;
    expect(s.l.courtTime.needsConfirmation).toBe(true);
    const before = ok(await accept(s.l, p3, p2, freshDay()));
    expect(before.hold).toMatchObject({ tentative: true });
    expect((await send(deskCookie, s.l.id, { action: "court_time", needsConfirmation: false })).status).toBe(403);
    const off = await send(managerCookie, s.l.id, { action: "court_time", needsConfirmation: false });
    expect(off.status).toBe(200);
    expect((await off.json()).ladder.courtTime).toMatchObject({ on: true, needsConfirmation: false });
    // The hold made before is as it was; the next is confirmed when made, as round 10's were.
    expect((await view(s.l, before.id)).hold).toMatchObject({ tentative: true });
    const after = ok(await accept(s.l, p5, p4, freshDay()));
    expect(after.hold).toMatchObject({ tentative: false, confirmBy: null });
    expect((await lastHold(after.id)).confirm_by).toBeNull();
    expect(await claimExpiries(after.id)).toEqual([null]);
    expect(await mailAbout(p5.user.email, "Court confirmed")).toHaveLength(0);
    const log = (await listActivity([venueId], { limit: 500 })).find((e) => e.action === "ladder.court_time" && e.detail?.includes("confirmed when made"));
    expect(log).toBeDefined();
    expect((await send(managerCookie, s.l.id, { action: "court_time", needsConfirmation: "no" })).status).toBe(400);
  });

  it("treats a hold made before confirmation existed (no confirm-by) as confirmed: shown so, never expired, and confirming it is a repeat", async () => {
    const a = await held();
    await db().prepare("UPDATE ladder_court_holds SET confirm_by = NULL, held_during = NULL WHERE challenge_id = ?").run(a.c.id);
    await db().prepare("UPDATE claims SET expires_at = NULL WHERE kind = 'block' AND block_id IN (SELECT id FROM blocks WHERE ladder_hold_id IN (SELECT id FROM ladder_court_holds WHERE challenge_id = ?))").run(a.c.id);
    expect((await view(a.l, a.c.id)).hold).toMatchObject({ tentative: false, confirmBy: null });
    expect(await sweepExpiredHolds()).toEqual([]);
    await ladderHousekeeping();
    expect(await liveBlocks(a.c.id)).toHaveLength(1);
    expect(ok(await confirmHoldAsPlayer(a.top.user.id, a.c.id)).hold).toMatchObject({ tentative: false });
    expect(await mailAbout(a.low.user.email, "Please confirm the court")).toHaveLength(0);
    // A manager moves it: a confirmed hold stays confirmed.
    const day = freshDay();
    expect((await send(managerCookie, a.l.id, { action: "hold_move", challengeId: a.c.id, onDate: day, minute: START, reason: "Re-laid court" })).status).toBe(200);
    expect((await view(a.l, a.c.id)).hold).toMatchObject({ tentative: false, date: day });
  });

  it("keeps the confirmed state through a move the players agree, and a manager's hold is always confirmed; a move of a tentative hold stays tentative with a fresh window", async () => {
    // Confirmed, then moved by agreement: confirmed (both agreed to the move).
    const a = await held();
    ok(await confirmHoldAsPlayer(a.top.user.id, a.c.id));
    ok(await confirmHoldAsPlayer(a.low.user.id, a.c.id));
    const day2 = freshDay();
    ok(await proposeMove(a.low.user.id, a.c.id, { onDate: day2, minute: START }));
    expect(ok(await answerMove(a.top.user.id, a.c.id, true)).hold).toMatchObject({ date: day2, tentative: false });
    // Tentative, then moved: still tentative, a fresh window.
    const b = await held();
    const first = ms((await lastHold(b.c.id)).confirm_by)!;
    await new Promise((r) => setTimeout(r, 15));
    const day3 = freshDay();
    ok(await proposeMove(b.low.user.id, b.c.id, { onDate: day3, minute: START }));
    const moved = ok(await answerMove(b.top.user.id, b.c.id, true));
    expect(moved.hold).toMatchObject({ date: day3, tentative: true });
    expect(ms((await lastHold(b.c.id)).confirm_by)!).toBeGreaterThan(first);
    // A manager's move of a tentative hold: confirmed.
    const c = await held();
    expect((await send(managerCookie, c.l.id, { action: "hold_move", challengeId: c.c.id, onDate: freshDay(), minute: START, reason: "Re-laid court" })).status).toBe(200);
    expect((await view(c.l, c.c.id)).hold).toMatchObject({ tentative: false });
    expect((await lastHold(c.c.id)).confirm_by).toBeNull();
  });

  it("is tentative too for the first specific time agreed after a day alone, by asking and agreeing", async () => {
    const s = await ladder({}, 3);
    const [, top, low] = s.people;
    const day = freshDay();
    const made = ok(await challenge(low.user.id, s.l.id, low.id, top.id, { onDate: day }));
    ok(await answer(top.user.id, made.id, { accept: true }));
    ok(await proposeMove(low.user.id, made.id, { onDate: day, minute: START }));
    expect(ok(await answerMove(top.user.id, made.id, true)).hold).toMatchObject({ tentative: true });
  });
});

describe("a hold expires", () => {
  it("at the install's window, but never past the match's start less the notice; at the latest at the start", async () => {
    await clean(async () => {
      const zone = (await venueHours(venueId)).zone;
      const day = addDays(today, 5);
      const start = instantOf(day, START, zone).getTime();
      // The window: 48 hours from now.
      const normal = (await confirmDeadline(day, START, zone)).getTime();
      expect(Math.abs(normal - (Date.now() + 48 * 3_600_000))).toBeLessThan(5_000);
      // A long window is cut to the match's start less the minimum notice (2 hours by default).
      await db().prepare("UPDATE ladder_hold_limits SET confirm_hours = 720 WHERE id = 1").run();
      expect((await confirmDeadline(day, START, zone)).getTime()).toBe(start - 120 * 60_000);
      await db().prepare("UPDATE ladder_hold_limits SET min_notice_minutes = 60 WHERE id = 1").run();
      expect((await confirmDeadline(day, START, zone)).getTime()).toBe(start - 60 * 60_000);
      // A match arranged so late that the notice has already gone (2 days away, 3 days' notice): at the latest at the start, never after it.
      await db().prepare("UPDATE ladder_hold_limits SET min_notice_minutes = 4320 WHERE id = 1").run();
      const soon = addDays(today, 2);
      expect((await confirmDeadline(soon, START, zone)).getTime()).toBe(instantOf(soon, START, zone).getTime());
      // And whatever the settings, a deadline is never after the start.
      for (const [hours, notice] of [[1, 0], [720, 0], [24, 4320]]) {
        await db().prepare("UPDATE ladder_hold_limits SET confirm_hours = ?, min_notice_minutes = ? WHERE id = 1").run(hours, notice);
        expect((await confirmDeadline(day, START, zone)).getTime()).toBeLessThanOrEqual(start);
      }
    });
  });

  it("by the scheduler: let go with the reason, by the system, its blocks and claims gone; both told once; the challenge back to arranging a time", async () => {
    const a = await held();
    expect(await liveBlocks(a.c.id)).toHaveLength(1);
    await lapse(a.c.id);
    await ladderHousekeeping();
    const row = await lastHold(a.c.id);
    expect(row).toMatchObject({ released_reason: "expired", released_by: "system" });
    expect(row.released_at).not.toBeNull();
    expect(await liveBlocks(a.c.id)).toEqual([]);
    expect(await claimExpiries(a.c.id)).toEqual([]);
    for (const p of [a.low, a.top]) expect(await mailAbout(p.user.email, "Court let go")).toHaveLength(1);
    // The challenge stands, with the day and no time, and no court held.
    const ch = (await db().prepare("SELECT status, agreed_on, agreed_min FROM ladder_challenges WHERE id = ?").get(a.c.id)) as { status: string; agreed_on: string; agreed_min: number | null };
    expect(ch).toMatchObject({ status: "accepted", agreed_on: a.day, agreed_min: null });
    expect((await myPlaces(a.low.user.id, a.l.id))[0].open[0]).toMatchObject({ status: "accepted", hold: null });
    // Again: nobody is told twice, nothing changes.
    await ladderHousekeeping();
    await ladderHousekeeping();
    for (const p of [a.low, a.top]) expect(await mailAbout(p.user.email, "Court let go")).toHaveLength(1);
    expect(await holdRows(a.c.id)).toHaveLength(1);
    // They agree a time again and a court is held (tentative, a fresh window).
    ok(await proposeMove(a.low.user.id, a.c.id, { onDate: a.day, minute: START + 60 }));
    expect(ok(await answerMove(a.top.user.id, a.c.id, true)).hold).toMatchObject({ startMin: START + 60, tentative: true });
  });

  it("lazily: a lapsed hold is gone to every read before the scheduler has run: availability treats it as free and a booking takes the court", async () => {
    const a = await held();
    await lapse(a.c.id);
    const court = { id: courtA, venueId, capacity: 1 };
    const zone = (await venueHours(venueId, a.day)).zone;
    // The claims read (what every availability read is made of) no longer shows it, though nothing has let it go.
    // (Only this day's own: what runs into it from the evening before is another scenario's.)
    expect(((await occupantsOn([court], a.day, zone)).get(courtA) ?? []).filter((o) => o.span.start >= 0)).toEqual([]);
    expect((await lastHold(a.c.id)).released_at).toBeNull();
    // The challenge's own views no longer show a court held.
    expect((await myPlaces(a.low.user.id, a.l.id))[0].open[0].hold).toBeNull();
    expect((await view(a.l, a.c.id)).hold).toBeNull();
    // A booking for the very time succeeds: its claim finds the lapsed one in the way, lets it go, and goes in.
    const stranger = await person("Stranger");
    const booked = await createBooking({ courtId: courtA, date: a.day, hours: [START / 60], name: stranger.name, phone: stranger.phone, userId: stranger.id, staff: { override: true } });
    expect(booked.ok).toBe(true);
    expect(await lastHold(a.c.id)).toMatchObject({ released_reason: "expired", released_by: "system" });
    expect(await liveBlocks(a.c.id)).toEqual([]);
    // The scheduler then tells both, once.
    await ladderHousekeeping();
    await ladderHousekeeping();
    expect(await mailAbout(a.top.user.email, "Court let go")).toHaveLength(1);
  });

  it("lazily, for a staff block and for another ladder's hold wanting the same court and time", async () => {
    const a = await held();
    await lapse(a.c.id);
    const blocked = await blockSlots(courtA, a.day, { start: START, end: START + 45 }, "Maintenance");
    expect(blocked.ok).toBe(true);
    expect(await lastHold(a.c.id)).toMatchObject({ released_reason: "expired" });
    // A second ladder asking for the same court and time while a lapsed hold of the first is unswept gets it.
    const b = await held();
    await lapse(b.c.id);
    const other = await ladder({}, 3);
    const made = ok(await challenge(other.people[2].user.id, other.l.id, other.people[2].id, other.people[1].id, { onDate: b.day, minute: START }));
    expect(ok(await answer(other.people[1].user.id, made.id, { accept: true })).hold).toMatchObject({ court: "Limit Court A", date: b.day, startMin: START });
    expect(await lastHold(b.c.id)).toMatchObject({ released_reason: "expired" });
  });

  it("refuses a confirmation after it has lapsed, by a player and by a manager, swept or not, and cannot be extended", async () => {
    const a = await held();
    await lapse(a.c.id);
    // Not yet swept: the lapse is already the answer.
    expect(await confirmHoldAsPlayer(a.top.user.id, a.c.id)).toMatchObject({ ok: false, code: "LAD3_EXPIRED" });
    expect((await send(managerCookie, a.l.id, { action: "hold_confirm", challengeId: a.c.id })).status).toBe(409);
    expect(await staffHold(a.c.id, { adminId, name: "Mina" }, { extend: true }, "More time please")).toMatchObject({ ok: false, code: "LAD3_NOT_TENTATIVE" });
    await ladderHousekeeping();
    expect(await confirmHoldAsPlayer(a.low.user.id, a.c.id)).toMatchObject({ ok: false, code: "LAD3_EXPIRED" });
    const manager = await send(managerCookie, a.l.id, { action: "hold_confirm", challengeId: a.c.id });
    expect(manager.status).toBe(409);
    expect((await manager.json()).code).toBe("LAD3_EXPIRED");
    // Nothing came back to life.
    expect(await liveBlocks(a.c.id)).toEqual([]);
  });

  it("counts towards the week's cap, so not confirming and asking again cannot churn a court", async () => {
    await clean(async () => {
      const s = await ladder({}, 3);
      const [, top, low] = s.people;
      await caps(s.l.id, { maxWeek: 1 });
      const day = freshDay();
      const c = ok(await accept(s.l, low, top, day));
      await lapse(c.id);
      await ladderHousekeeping();
      ok(await proposeMove(low.user.id, c.id, { onDate: day, minute: START + 60 }));
      expect(await answerMove(top.user.id, c.id, true)).toMatchObject({ ok: false, code: "LAD2_CAP_PLAYER" });
    });
  });

  it("is freed to the waiting list when the scheduler lets it go (once)", async () => {
    const a = await held();
    await lapse(a.c.id);
    // The scheduler's own pass is what offers the freed time; it must not fail or repeat.
    await ladderHousekeeping();
    await ladderHousekeeping();
    expect((await lastHold(a.c.id)).expiry_told_at).not.toBeNull();
  });
});

describe("a manager extends the time to confirm, once", () => {
  it("by the install's extension, with a reason, kept with the hold, logged, told to both, the claims following", async () => {
    const a = await held();
    const was = ms((await lastHold(a.c.id)).confirm_by)!;
    expect((await send(deskCookie, a.l.id, { action: "hold_extend", challengeId: a.c.id, reason: "They asked the desk" })).status).toBe(403);
    expect((await send(managerCookie, a.l.id, { action: "hold_extend", challengeId: a.c.id })).status).toBe(400);
    const done = await send(managerCookie, a.l.id, { action: "hold_extend", challengeId: a.c.id, reason: "They asked the desk" });
    expect(done.status).toBe(200);
    const row = await lastHold(a.c.id);
    expect(ms(row.confirm_by)! - was).toBe(24 * 3_600_000);
    expect(row).toMatchObject({ extended_by: "Mina Manager", extend_note: "They asked the desk" });
    expect(await claimExpiries(a.c.id)).toEqual([ms(row.confirm_by)]);
    expect((await view(a.l, a.c.id)).hold).toMatchObject({ tentative: true, extended: true });
    for (const p of [a.low, a.top]) expect(await mailAbout(p.user.email, "More time to confirm")).toHaveLength(1);
    const log = (await listActivity([venueId], { limit: 500 })).find((e) => e.action === "ladder.hold_extended");
    expect(log?.detail).toContain("They asked the desk");
    // Once only.
    const again = await send(managerCookie, a.l.id, { action: "hold_extend", challengeId: a.c.id, reason: "Once more please" });
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe("LAD3_EXTENDED");
    expect(ms((await lastHold(a.c.id)).confirm_by)).toBe(ms(row.confirm_by));
  });

  it("never past the match's start, nothing to extend once that is reached, and nothing to extend on a confirmed hold", async () => {
    const a = await held();
    const zone = (await venueHours(venueId, a.day)).zone;
    const start = instantOf(a.day, START, zone).getTime();
    // Set the moment 10 minutes before the start: the extension stops at the start.
    const near = new Date(start - 10 * 60_000).toISOString();
    await db().prepare("UPDATE ladder_court_holds SET confirm_by = ?::timestamptz WHERE challenge_id = ? AND released_at IS NULL").run(near, a.c.id);
    await db().prepare("UPDATE claims SET expires_at = ?::timestamptz WHERE kind = 'block' AND block_id IN (SELECT b.id FROM blocks b JOIN ladder_court_holds h ON h.id = b.ladder_hold_id WHERE h.challenge_id = ?)").run(near, a.c.id);
    ok(await staffHold(a.c.id, { adminId, name: "Mina" }, { extend: true }, "A little more time"));
    expect(ms((await lastHold(a.c.id)).confirm_by)).toBe(start);
    // At the start already: nothing more to give (and, being once only, the answer is that it was extended).
    const b = await held();
    const startB = instantOf(b.day, START, zone).getTime();
    const atStart = new Date(startB).toISOString();
    await db().prepare("UPDATE ladder_court_holds SET confirm_by = ?::timestamptz WHERE challenge_id = ? AND released_at IS NULL").run(atStart, b.c.id);
    expect(await staffHold(b.c.id, { adminId, name: "Mina" }, { extend: true }, "A little more time")).toMatchObject({ ok: false, code: "LAD3_NO_EXTENSION" });
    // Confirmed: nothing to extend.
    const c = await held();
    ok(await staffHold(c.c.id, { adminId, name: "Mina" }, { confirm: true }, ""));
    expect(await staffHold(c.c.id, { adminId, name: "Mina" }, { extend: true }, "A little more time")).toMatchObject({ ok: false, code: "LAD3_NOT_TENTATIVE" });
  });

  it("keeps a hold alive past its old moment: the scheduler leaves it, and it lapses at the new one", async () => {
    const a = await held();
    ok(await staffHold(a.c.id, { adminId, name: "Mina" }, { extend: true }, "More time please"));
    // The extended moment is a day beyond the original, which the scheduler respects.
    expect(ms((await lastHold(a.c.id)).confirm_by)! - Date.now()).toBeGreaterThan(71 * 3_600_000);
    await ladderHousekeeping();
    expect(await liveBlocks(a.c.id)).toHaveLength(1);
    await lapse(a.c.id);
    await ladderHousekeeping();
    expect(await lastHold(a.c.id)).toMatchObject({ released_reason: "expired" });
  });
});

describe("no two holds, or a hold and anything else, overlap on a court", () => {
  /** Every pair of claims on a court is apart: nothing anywhere holds a minute twice. */
  const overlaps = async (court: number, day: string) =>
    count(
      `SELECT COUNT(*)::int AS n FROM blocks a JOIN blocks b ON a.court_id = b.court_id AND a.date = b.date AND a.id < b.id
        WHERE a.court_id = ${court} AND a.date = '${day}' AND a.start_min < b.end_min AND b.start_min < a.end_min`
    );

  it("two ladders, the same or different: the second hold for a time already held goes to another court or is refused", async () => {
    const day = freshDay();
    const one = await ladder({}, 3);
    const two = await ladder({}, 3);
    const three = await ladder({ courtTime: { on: true, courtIds: [courtA, courtB] } }, 3);
    const a = ok(await accept(one.l, one.people[2], one.people[1], day));
    expect(a.hold).toMatchObject({ courtId: courtA });
    // The same court named, the same time: refused, nothing held, the challenge pending.
    expect(await accept(two.l, two.people[2], two.people[1], day)).toMatchObject({ ok: false, code: "LAD2_NO_COURT" });
    // A ladder that may use both goes to the other one; a time that overlaps by a minute is still refused on A.
    const c = ok(await accept(three.l, three.people[2], three.people[1], day, START + 20));
    expect(c.hold).toMatchObject({ courtId: courtB });
    expect(await overlaps(courtA, day)).toBe(0);
    expect(await overlaps(courtB, day)).toBe(0);
  });

  it("a hold and a booking, a staff block, a class's time: whichever is there first, the other cannot overlap it", async () => {
    const s = await ladder({}, 6);
    const [, p2, p3, p4, p5] = s.people;
    // A booking first: the hold cannot be made over it.
    const day = freshDay();
    const stranger = await person("Stranger");
    expect((await createBooking({ courtId: courtA, date: day, hours: [START / 60], name: stranger.name, phone: stranger.phone, userId: stranger.id, staff: { override: true } })).ok).toBe(true);
    expect(await accept(s.l, p3, p2, day)).toMatchObject({ ok: false, code: "LAD2_NO_COURT" });
    // A staff block first, the same.
    const day2 = freshDay();
    expect((await blockSlots(courtA, day2, { start: START - 30, end: START + 30 }, "Maintenance")).ok).toBe(true);
    expect(await accept(s.l, p5, p4, day2)).toMatchObject({ ok: false, code: "LAD2_NO_COURT" });
    // A hold first: a booking and a block cannot take its time.
    const day3 = freshDay();
    const open = (await myPlaces(p4.user.id, s.l.id))[0].open[0];
    ok(await answer(p4.user.id, open.id, { accept: true, onDate: day3, minute: START }));
    expect((await createBooking({ courtId: courtA, date: day3, hours: [START / 60], name: stranger.name, phone: stranger.phone, userId: stranger.id, staff: { override: true } })).ok).toBe(false);
    for (const d of [day, day2, day3]) expect(await overlaps(courtA, d)).toBe(0);
  });

  it("the table of holds is itself under a constraint: two live holds of a court overlapping is refused by the database; apart, released, or on another court is not", async () => {
    // Two accepted challenges on a ladder that holds nothing, so the rows below are the only holds there are.
    const s = await ladder({ courtTime: { on: false } }, 5);
    const [, p2, p3, p4, p5] = s.people;
    const day = freshDay();
    const c1 = ok(await accept(s.l, p3, p2, day));
    const c2 = ok(await accept(s.l, p5, p4, day));
    const zone = (await venueHours(venueId, day)).zone;
    const insert = (challengeId: number, court: number, from: number, to: number) =>
      db()
        .prepare(
          `INSERT INTO ladder_court_holds (ladder_id, challenge_id, court_id, date, start_min, end_min, held_from, held_to, held_during)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::tstzrange) RETURNING id`
        )
        .get(s.l.id, challengeId, court, day, from, to, from, to, `[${instantOf(day, from, zone).toISOString()},${instantOf(day, to, zone).toISOString()})`) as Promise<{ id: number }>;
    const first = await insert(c1.id, courtA, START, START + 60);
    await expect(insert(c2.id, courtA, START + 30, START + 90)).rejects.toMatchObject({ code: "23P01" });
    // Back to back is not overlapping; another court is not; and a released hold lets go of its time.
    const second = await insert(c2.id, courtA, START + 60, START + 120);
    expect(second.id).toBeGreaterThan(first.id);
    await db().prepare("UPDATE ladder_court_holds SET released_at = now()::text, released_reason = 'staff' WHERE id = ?").run(first.id);
    await db().prepare("UPDATE ladder_court_holds SET released_at = now()::text, released_reason = 'staff' WHERE id = ?").run(second.id);
    expect((await insert(c1.id, courtA, START, START + 120)).id).toBeGreaterThan(second.id);
    await db().prepare("UPDATE ladder_court_holds SET released_at = now()::text, released_reason = 'staff' WHERE challenge_id = ? AND released_at IS NULL").run(c1.id);
    const live = await insert(c1.id, courtB, START, START + 120);
    expect(live.id).toBeGreaterThan(second.id);
    // A hold with no court recorded, or none of its time (a hold of round 10), conflicts with nothing.
    await db().prepare("UPDATE ladder_court_holds SET released_at = now()::text, released_reason = 'staff' WHERE id = ?").run(live.id);
    await db().prepare("INSERT INTO ladder_court_holds (ladder_id, challenge_id, court_id, date, start_min, end_min, held_from, held_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(s.l.id, c1.id, courtA, day, START, START + 60, START, START + 60);
    await db().prepare("INSERT INTO ladder_court_holds (ladder_id, challenge_id, court_id, date, start_min, end_min, held_from, held_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(s.l.id, c2.id, courtA, day, START, START + 60, START, START + 60);
  });

  it("a move claims the new time before it lets go of the old, so a move onto a time held by another is refused and leaves the old held; onto its own time works", async () => {
    const day = freshDay();
    const one = await ladder({ courtTime: { on: true, courtIds: [courtA, courtB] } }, 4);
    const [, p2, p3, p4] = one.people;
    const a = ok(await accept(one.l, p3, p2, day, START));
    const b = ok(await accept(one.l, p4, one.people[0], day, START + 60));
    // The manager asks for the other's court and time: refused, and nothing moved.
    const was = await liveBlocks(a.id);
    const target = (await liveBlocks(b.id))[0];
    expect(target.court_id).toBe(was[0].court_id);
    const r = await send(managerCookie, one.l.id, { action: "hold_move", challengeId: a.id, onDate: day, minute: target.start_min, courtId: target.court_id, reason: "Swap courts" });
    expect(r.status).toBe(409);
    expect(await liveBlocks(a.id)).toEqual(was);
    // Onto its own time again (overlapping the old one exactly) works.
    expect((await send(managerCookie, one.l.id, { action: "hold_move", challengeId: a.id, onDate: day, minute: START + 15, courtId: was[0].court_id, reason: "Quarter later" })).status).toBe(200);
    expect(await overlaps(courtA, day)).toBe(0);
    expect(await overlaps(courtB, day)).toBe(0);
  });
});

describe("races", () => {
  it("two ladders accepting at once for one court and time: one holds it, the other is refused, and the database holds one claim", async () => {
    const day = freshDay();
    const one = await ladder({}, 3);
    const two = await ladder({}, 3);
    const x = ok(await challenge(one.people[2].user.id, one.l.id, one.people[2].id, one.people[1].id, { onDate: day, minute: START }));
    const y = ok(await challenge(two.people[2].user.id, two.l.id, two.people[2].id, two.people[1].id, { onDate: day, minute: START }));
    const done = await Promise.all([answer(one.people[1].user.id, x.id, { accept: true }), answer(two.people[1].user.id, y.id, { accept: true })]);
    expect(done.filter((r) => r.ok)).toHaveLength(1);
    expect(done.filter((r) => !r.ok)[0]).toMatchObject({ code: "LAD2_NO_COURT" });
    expect(await count(`SELECT COUNT(*)::int AS n FROM claims c JOIN blocks k ON k.id = c.block_id WHERE k.court_id = ${courtA} AND k.date = '${day}' AND c.active`)).toBe(1);
    expect(await count(`SELECT COUNT(*)::int AS n FROM ladder_court_holds WHERE court_id = ${courtA} AND date = '${day}' AND released_at IS NULL`)).toBe(1);
  });

  it("both players confirming at once: confirmed, once, whichever goes first", async () => {
    const a = await held();
    const done = await Promise.all([confirmHoldAsPlayer(a.top.user.id, a.c.id), confirmHoldAsPlayer(a.low.user.id, a.c.id)]);
    expect(done.every((r) => r.ok)).toBe(true);
    const row = await lastHold(a.c.id);
    expect(row.confirmed_at).not.toBeNull();
    expect(await claimExpiries(a.c.id)).toEqual([null]);
    expect((await holdViews([a.c.id])).get(a.c.id)).toMatchObject({ tentative: false });
  });

  it("the scheduler (twice), a manager's release and a confirmation at once on a lapsed hold: it is let go once, nobody is told twice, no court is left held", async () => {
    const a = await held();
    await lapse(a.c.id);
    const done = await Promise.all([
      ladderHousekeeping(),
      ladderHousekeeping(),
      staffHold(a.c.id, { adminId, name: "Mina" }, { release: true }, "Players gave it up"),
      confirmHoldAsPlayer(a.top.user.id, a.c.id),
    ]);
    expect(done).toHaveLength(4);
    const rows = await holdRows(a.c.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].released_at).not.toBeNull();
    expect(["expired", "staff"]).toContain(rows[0].released_reason);
    expect(await liveBlocks(a.c.id)).toEqual([]);
    expect(await claimExpiries(a.c.id)).toEqual([]);
    // Players are told of the expiry at most once each (not at all if a manager released it first).
    for (const p of [a.low, a.top]) expect((await mailAbout(p.user.email, "Court let go")).length).toBeLessThanOrEqual(1);
    expect(rows[0].confirmed_at).toBeNull();
  });

  it("a booking and the scheduler at once on a lapsed hold: the booking gets the court, the hold is let go once", async () => {
    const a = await held();
    await lapse(a.c.id);
    const stranger = await person("Stranger");
    const [booked] = await Promise.all([
      createBooking({ courtId: courtA, date: a.day, hours: [START / 60], name: stranger.name, phone: stranger.phone, userId: stranger.id, staff: { override: true } }),
      ladderHousekeeping(),
      ladderHousekeeping(),
    ]);
    expect(booked.ok).toBe(true);
    expect(await holdRows(a.c.id)).toHaveLength(1);
    expect(await lastHold(a.c.id)).toMatchObject({ released_reason: "expired" });
    expect(await liveBlocks(a.c.id)).toEqual([]);
    for (const p of [a.low, a.top]) expect((await mailAbout(p.user.email, "Court let go")).length).toBe(1);
  });

  it("two managers moving two challenges onto one court and time at once: one gets it, the other is refused and keeps what it had", async () => {
    const day = freshDay();
    const s = await ladder({ courtTime: { on: true, courtIds: [courtA, courtB] } }, 5);
    const [, p2, p3, p4, p5] = s.people;
    const a = ok(await accept(s.l, p3, p2, day, START));
    const b = ok(await accept(s.l, p5, p4, day, START + 120));
    const target = { onDate: day, minute: START + 240, courtId: courtA };
    const [x, y] = await Promise.all([
      send(managerCookie, s.l.id, { action: "hold_move", challengeId: a.id, ...target, reason: "Re-laid court" }),
      send(managerCookie, s.l.id, { action: "hold_move", challengeId: b.id, ...target, reason: "Re-laid court" }),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const at = await count(`SELECT COUNT(*)::int AS n FROM blocks WHERE court_id = ${courtA} AND date = '${day}' AND start_min = ${START + 240}`);
    expect(at).toBe(1);
    expect(await liveBlocks(a.id)).toHaveLength(1);
    expect(await liveBlocks(b.id)).toHaveLength(1);
  });
});

describe("a limit never bypasses what is free", () => {
  it("raised as far as it goes, with the court blocked all day: no hold, no row, no claim", async () => {
    await clean(async () => {
      const day = freshDay();
      const s = await ladder({}, 3);
      const [, top, low] = s.people;
      expect((await send(managerCookie, s.l.id, { action: "hold_limits", scope: "venue", maxLive: 50, maxWeek: 20 })).status).toBe(200);
      expect((await send(managerCookie, s.l.id, { action: "hold_limits", scope: "ladder", maxLive: 50, maxWeek: 20 })).status).toBe(200);
      expect(await limitsOf(s.l)).toMatchObject({ maxLivePerLadder: 50, maxPerPlayerWeek: 20 });
      expect((await blockSlots(courtA, day, { start: 8 * 60, end: 23 * 60 }, "Closed for a tournament")).ok).toBe(true);
      const claims = await count("SELECT COUNT(*)::int AS n FROM claims");
      expect(await accept(s.l, low, top, day)).toMatchObject({ ok: false, code: "LAD2_NO_COURT" });
      expect(await count(`SELECT COUNT(*)::int AS n FROM ladder_court_holds WHERE ladder_id = ${s.l.id}`)).toBe(0);
      expect(await count("SELECT COUNT(*)::int AS n FROM claims")).toBe(claims);
    });
  });

  it("with the whole venue booked for the time, a ladder naming no courts at all gets nothing either", async () => {
    await clean(async () => {
      const day = freshDay();
      const s = await ladder({ courtTime: { on: true, courtIds: [] } }, 3);
      const [, top, low] = s.people;
      await caps(s.l.id, { maxLive: 50, maxWeek: 20 });
      const courts = (await db().prepare("SELECT c.id FROM courts c JOIN court_activities ca ON ca.court_id = c.id AND ca.sport = 'badminton' WHERE c.venue_id = ? AND c.capacity = 1").all(venueId)) as { id: number }[];
      for (const c of courts) expect((await blockSlots(c.id, day, { start: START - 60, end: START + 120 }, "Venue hired")).ok).toBe(true);
      expect(await accept(s.l, low, top, day)).toMatchObject({ ok: false, code: "LAD2_NO_COURT" });
      expect(await count(`SELECT COUNT(*)::int AS n FROM ladder_court_holds WHERE ladder_id = ${s.l.id}`)).toBe(0);
    });
  });

  it("a manager's move cannot double-allocate, whatever the limits: refused, both holds intact, nothing overlapping", async () => {
    await clean(async () => {
      const day = freshDay();
      const s = await ladder({}, 5);
      const [, p2, p3, p4, p5] = s.people;
      await caps(s.l.id, { maxLive: 50, maxWeek: 20 });
      const a = ok(await accept(s.l, p3, p2, day, START));
      const b = ok(await accept(s.l, p5, p4, day, START + 120));
      const r = await send(managerCookie, s.l.id, { action: "hold_move", challengeId: b.id, onDate: day, minute: START + 15, courtId: courtA, reason: "Squeeze it in" });
      expect(r.status).toBe(409);
      expect((await r.json()).code).toBe("LAD2_NO_COURT");
      expect(await liveBlocks(a.id)).toEqual([{ court_id: courtA, date: day, start_min: START, end_min: START + 45 }]);
      expect(await liveBlocks(b.id)).toEqual([{ court_id: courtA, date: day, start_min: START + 120, end_min: START + 165 }]);
    });
  });

  it("a ladder with its cap raised past the default holds more than the default, each through the claim, none overlapping", async () => {
    await clean(async () => {
      const s = await ladder({}, 20);
      await caps(s.l.id, { maxLive: 12 });
      const day = freshDay();
      const made: number[] = [];
      for (let i = 0; i < 9; i++) {
        const high = s.people[2 * i];
        const low = s.people[2 * i + 1];
        const c = await accept(s.l, low, high, day, 8 * 60 + 60 * i);
        if (!c.ok) throw new Error(`${c.error} (${c.code})`);
        made.push(c.value.id);
      }
      // Nine on a ladder whose default is eight.
      expect(await count(`SELECT COUNT(*)::int AS n FROM ladder_court_holds WHERE ladder_id = ${s.l.id} AND released_at IS NULL`)).toBe(9);
      expect(await count(`SELECT COUNT(*)::int AS n FROM blocks a JOIN blocks b ON a.court_id = b.court_id AND a.date = b.date AND a.id < b.id WHERE a.date = '${day}' AND a.start_min < b.end_min AND b.start_min < a.end_min AND a.ladder_hold_id IS NOT NULL AND b.ladder_hold_id IS NOT NULL`)).toBe(0);
      // The same ladder at the default would have been refused the ninth.
      await caps(s.l.id, { maxLive: null });
      expect(await accept(s.l, s.people[19], s.people[18], day, 18 * 60 + 15)).toMatchObject({ ok: false });
    });
  });

  it("a lapsed hold counts as free to availability and to the cap, so a full ladder takes a new hold once a tentative one has lapsed", async () => {
    await clean(async () => {
      const s = await ladder({}, 6);
      const [, p2, p3, p4, p5] = s.people;
      await caps(s.l.id, { maxLive: 1 });
      const first = ok(await accept(s.l, p3, p2, freshDay()));
      expect(await accept(s.l, p5, p4, freshDay())).toMatchObject({ ok: false, code: "LAD2_CAP_LADDER" });
      await lapse(first.id);
      const open = (await myPlaces(p4.user.id, s.l.id))[0].open[0];
      expect(ok(await answer(p4.user.id, open.id, { accept: true })).hold).not.toBeNull();
      expect(await lastHold(first.id)).toMatchObject({ released_reason: "expired" });
    });
  });
});

describe("the staff and player views", () => {
  it("shows staff the hold's confirmation and its extension, and a player only their own challenge's", async () => {
    const a = await held();
    ok(await confirmHoldAsPlayer(a.top.user.id, a.c.id));
    const staff = (await view(a.l, a.c.id)).hold!;
    expect(staff).toMatchObject({ tentative: true, confirmedBy: { challenger: false, challenged: true }, extended: false });
    expect(typeof staff.confirmBy).toBe("string");
    const mine = (await myPlaces(a.low.user.id, a.l.id))[0].open[0].hold!;
    expect(mine).toMatchObject({ tentative: true });
    // A stranger has no view of it.
    const stranger = await person("Stranger");
    expect(await myPlaces(stranger.id, a.l.id)).toEqual([]);
    expect(JSON.stringify(await ladderDetail(a.l.id))).not.toContain("confirmBy");
  });

  it("changing the court-time settings still answers as before for a ladder that has not opened them", async () => {
    const plain = ok(await createLadder({ venueId, name: `Plain ${++n}`, sport: "badminton", teamSize: 1, level: null }, adminId));
    expect(plain.courtTime).toMatchObject({ on: false, needsConfirmation: true });
    const changed = ok(await changeCourtTime(plain.id, { on: true, courtIds: [courtA] }));
    expect(changed.courtTime).toMatchObject({ on: true, needsConfirmation: true });
    expect(await changeCourtTime(plain.id, { needsConfirmation: "yes" })).toMatchObject({ ok: false });
  });
});
