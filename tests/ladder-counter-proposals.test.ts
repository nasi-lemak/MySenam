import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { saveProfile } from "../src/lib/player-profiles";
import { holdViews } from "../src/lib/ladder-holds";
import {
  answer,
  answerMove,
  challenge,
  changeCourtTime,
  createLadder,
  ladderDetail,
  ladderHousekeeping,
  myPlaces,
  previewHoldFor,
  proposeMove,
  join,
  staffHold,
  withdraw,
  type ChallengeView,
  type LadderInput,
} from "../src/lib/ladders";
import { joinTeam } from "../src/lib/team-ladders";
import { acceptInvitation, createInviteLink, createTeam, teamView, type Team } from "../src/lib/teams";
import { blockSlots, createBooking, createCourt } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import * as challengeRoute from "../src/app/api/ladders/[id]/challenges/[challengeId]/route";
import * as adminLadder from "../src/app/api/admin/ladders/[id]/route";

/**
 * The owner's decision of 5 November 2026 on ladder counter-proposals (ADR 0051, which amends ADR 0050; migration 0293; lib/ladders.ts, lib/ladder-holds.ts):
 * a fully specified time one player names in answer to the other's is a counter-proposal, which is that player's recorded agreement to that exact specification,
 * reserves nothing, replaces the proposal before it, and waits for the other player's explicit acceptance of exactly it (whereupon the hold is made confirmed, once).
 * Every proposal has a revision; an act answers the revision it saw; a superseded proposal can never be accepted; a proposal lapses with the challenge's response
 * window; nothing is bypassed (the claim path, the exclusion constraints, hours, limits, eligibility); and nobody is blamed for a timeout.
 * The anti-abuse side of the same decision is tested in tests/ladder-agreement-and-active-holds.test.ts.
 */

vi.setConfig({ testTimeout: 120_000 });

let venueId: number;
let adminId: number;
let courtA: number;
let courtB: number;
let managerCookie: string;
let n = 0;
let dayNo = 0;
const today = todayISO();
const freshDay = () => addDays(today, 5 + (dayNo++ % 50));
const START = 18 * 60;
const db = () => getDb();

async function person(name = "Cora"): Promise<User> {
  n++;
  const made = await registerUser({ name: `${name} Counter${n}`, email: `cora${n}@counter.test`, phone: `01386${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await db().prepare("UPDATE users SET phone_verified_at = datetime('now'), verified_phone = phone WHERE id = ?").run(made.user.id);
  await saveProfile(made.user.id, { adult: true });
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
  const venue = (await (await import("../src/lib/store")).listVenues())[0];
  venueId = venue.id;
  const made: number[] = [];
  for (const name of ["Counter Court A", "Counter Court B"]) {
    const c = await createCourt({ venueId, name, sport: "badminton", offPeakRate: 10, peakRate: 12 });
    if (!c.ok) throw new Error("courts");
    made.push(c.court.id);
  }
  [courtA, courtB] = made;
  const manager = await createAdmin({ name: "Mina Manager", email: "mina-counter@venue.my", password: "manager-pass-1", venueId });
  if (!manager.ok) throw new Error("staff");
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(manager.admin.id)).token}`;
});

afterEach(async () => {
  await db().prepare("UPDATE ladder_court_holds SET released_at = datetime('now'), released_reason = 'test cleanup' WHERE released_at IS NULL").run();
  await db().prepare("DELETE FROM blocks WHERE court_id IN (?, ?)").run(courtA, courtB);
  await db().prepare("DELETE FROM bookings WHERE court_id IN (?, ?)").run(courtA, courtB);
});

type Pl = { user: User; id: number };

async function ladder(over: Partial<LadderInput> = {}, count = 3) {
  n++;
  const { settings, ...rest } = over;
  const l = ok(await createLadder({ venueId, name: `Counter Ladder ${n}`, sport: "badminton", teamSize: 1, level: null, settings: { cooldownDays: 0, playDays: 60, ...settings }, courtTime: { on: true, courtIds: [courtA] }, ...rest }, adminId));
  const people: Pl[] = [];
  for (let i = 0; i < count; i++) {
    const user = await person();
    people.push({ user, id: ok(await join(user, l.id, { adult: true })).playerId });
  }
  return { l, people };
}

const propose = async (l: { id: number }, low: Pl, high: Pl, day: string, minute?: number) =>
  ok(await challenge(low.user.id, l.id, low.id, high.id, minute === undefined ? { onDate: day } : { onDate: day, minute }));
const count = async (sql: string) => ((await db().prepare(sql).get()) as { n: number }).n;
const row = async (id: number) => (await db().prepare("SELECT * FROM ladder_challenges WHERE id = ?").get(id)) as { status: string; version: number; proposal_rev: number; proposed_on: string | null; proposed_min: number | null; proposed_by: number | null; awaiting: string; respond_by: string | null; move_on: string | null; move_min: number | null; move_by: number | null; move_respond_by: string | null; agreed_min: number | null };
const revOf = async (id: number) => (await row(id)).proposal_rev;
const holdRows = async (id: number) => (await db().prepare("SELECT * FROM ladder_court_holds WHERE challenge_id = ? ORDER BY id").all(id)) as { id: number; court_id: number; start_min: number; released_reason: string | null; confirm_by: unknown; cancelled_place: number | null }[];
const agreements = async (id: number) =>
  (await db().prepare("SELECT * FROM ladder_agreed_times WHERE challenge_id = ? ORDER BY id").all(id)) as { held_id: number | null; player_id: number; role: string; start_min: number; rev: number | null; superseded_at: unknown; superseded_reason: string | null }[];
const events = async (id: number) => (await db().prepare("SELECT kind, place_id, reserved_capacity, rev, start_min FROM ladder_hold_events WHERE challenge_id = ? ORDER BY id").all(id)) as { kind: string; place_id: number | null; reserved_capacity: boolean; rev: number | null; start_min: number | null }[];
const mail = async (to: string) => (await db().prepare("SELECT subject, body FROM messages WHERE kind IN ('programme', 'team_decision') AND recipient = ? ORDER BY id").all(to)) as { subject: string; body: string }[];
const mailAbout = async (to: string, text: string) => (await mail(to)).filter((m) => m.subject.includes(text) || m.body.includes(text));
const send = (cookie: string | undefined, ladderId: number, body: unknown) => adminLadder.POST(req(`/api/admin/ladders/${ladderId}`, "POST", cookie, body), ctx(ladderId));
const post = async (u: User, l: { id: number }, challengeId: number, body: unknown) => challengeRoute.POST(req(`/api/ladders/${l.id}/challenges/${challengeId}`, "POST", await cookieOf(u), body), ctx2(l.id, challengeId));
const staff = { get adminId() { return adminId; }, name: "Mina Manager" };
const noOverlap = async (court: number, day: string) =>
  count(`SELECT COUNT(*)::int AS n FROM blocks a JOIN blocks b ON a.court_id = b.court_id AND a.date = b.date AND a.id < b.id WHERE a.court_id = ${court} AND a.date = '${day}' AND a.start_min < b.end_min AND b.start_min < a.end_min`);

// ============================================================================ a counter-proposal is an agreement, and holds nothing

describe("a counter-proposal is its maker's agreement, reserves nothing, and the other player's acceptance makes the hold", () => {
  it("B's counter by accepting with a time of their own: B's agreement is on record, no hold, A's explicit acceptance makes the confirmed hold, and B is not asked again", async () => {
    const s = await ladder({}, 3);
    const [, top, low] = s.people;
    const day = freshDay();
    const made = await propose(s.l, low, top, day, START);
    const countered = ok(await answer(top.user.id, made.id, { accept: true, onDate: day, minute: START + 60 }, { rev: await revOf(made.id) }));
    expect(countered).toMatchObject({ status: "pending", hold: null, proposedBy: top.id, proposedMin: START + 60, awaiting: "challenger", rev: 2 });
    expect(await holdRows(made.id)).toEqual([]);
    expect(await count("SELECT COUNT(*)::int AS n FROM claims WHERE active AND kind = 'block' AND block_id IN (SELECT id FROM blocks WHERE ladder_hold_id IS NOT NULL AND date = '" + day + "')")).toBe(0);
    // B's agreement to that exact specification is on record (role `countered`); A's own earlier agreement is history, flagged superseded.
    const rows = await agreements(made.id);
    expect(rows.find((r) => r.role === "countered")).toMatchObject({ player_id: top.id, start_min: START + 60, held_id: null, rev: 2, superseded_at: null });
    expect(rows.find((r) => r.player_id === low.id && r.role === "proposed")).toMatchObject({ start_min: START, held_id: null, rev: 1 });
    expect(rows.find((r) => r.player_id === low.id && r.role === "proposed")!.superseded_at).not.toBeNull();
    // A is told it is a proposal, not a reservation.
    expect((await mailAbout(low.user.email, "A proposal reserves nothing")).length).toBe(1);
    // A's explicit acceptance of exactly it: the hold is made, confirmed, once; B is not asked to confirm anything.
    const done = ok(await answer(low.user.id, made.id, { accept: true }, { rev: await revOf(made.id) }));
    expect(done).toMatchObject({ status: "accepted", agreedMin: START + 60, hold: { tentative: false, agreed: true, startMin: START + 60, confirmBy: null, confirmedBy: { challenger: true, challenged: true } } });
    const held = (await agreements(made.id)).filter((r) => r.held_id !== null);
    expect(held.map((r) => [r.role, r.player_id]).sort()).toEqual([["accepted", low.id], ["countered", top.id]]);
    expect(held.every((r) => r.superseded_at === null)).toBe(true);
    expect(await mailAbout(top.user.email, "Please confirm the court")).toHaveLength(0);
    expect(await mailAbout(top.user.email, "You both agreed this exact time")).toHaveLength(1);
    expect((await events(made.id)).map((e) => e.kind)).toEqual(["proposed", "countered", "accepted", "held"]);
    expect((await events(made.id)).map((e) => e.reserved_capacity)).toEqual([false, false, true, true]);
  });

  it("B's counter by the `propose` act is the same: a recorded agreement, no hold, and the hold only when A accepts", async () => {
    const s = await ladder({}, 3);
    const [, top, low] = s.people;
    const day = freshDay();
    const made = await propose(s.l, low, top, day);
    ok(await answer(top.user.id, made.id, { propose: true, onDate: day, minute: START }, { rev: await revOf(made.id) }));
    expect(await holdRows(made.id)).toEqual([]);
    expect((await agreements(made.id)).filter((r) => r.superseded_at === null)).toEqual([expect.objectContaining({ role: "countered", player_id: top.id })]);
    expect(ok(await answer(low.user.id, made.id, { accept: true }, { rev: await revOf(made.id) })).hold).toMatchObject({ tentative: false, agreed: true, startMin: START });
  });

  it("the counter is never a hold on one player's say-so: a different time, a day alone, and a time with no proposal at all", async () => {
    const s = await ladder({}, 4);
    const [, top, low, third] = s.people;
    // No proposal at all, the challenged names a time: a proposal for the challenger to accept.
    const bare = await propose(s.l, low, top, freshDay());
    expect(ok(await answer(top.user.id, bare.id, { accept: true, onDate: bare.proposedOn!, minute: START }))).toMatchObject({ status: "pending", hold: null, proposedBy: top.id });
    // A day alone is still accepted as a day, with no court (ADR 0050).
    const dayOnly = await propose(s.l, third, s.people[0], freshDay());
    expect(ok(await answer(s.people[0].user.id, dayOnly.id, { accept: true }))).toMatchObject({ status: "accepted", hold: null });
    expect(await count(`SELECT COUNT(*)::int AS n FROM ladder_court_holds WHERE challenge_id IN (${bare.id}, ${dayOnly.id})`)).toBe(0);
  });

  it("on a ladder that holds no court time nothing of this applies: a time named in answer is simply accepted, as before", async () => {
    const s = await ladder({ courtTime: { on: false } }, 4);
    const [, top, low] = s.people;
    const made = await propose(s.l, low, top, freshDay(), START);
    const done = ok(await answer(top.user.id, made.id, { accept: true, onDate: made.proposedOn!, minute: START + 30 }));
    expect(done).toMatchObject({ status: "accepted", agreedMin: START + 30, hold: null });
    // Nothing is recorded for a ladder that holds nothing, and no revision is asked for by the route.
    expect(await agreements(made.id)).toEqual([]);
    const another = await propose(s.l, s.people[3], s.people[0], freshDay());
    expect((await post(s.people[0].user, s.l, another.id, { action: "accept" })).status).toBe(200);
  });

  it("an acceptance that carries the very same time as the proposal is an exact acceptance, never a counter", async () => {
    const s = await ladder({}, 3);
    const [, top, low] = s.people;
    const day = freshDay();
    const made = await propose(s.l, low, top, day, START);
    expect(ok(await answer(top.user.id, made.id, { accept: true, onDate: day, minute: START })).hold).toMatchObject({ tentative: false, agreed: true });
  });
});

// ============================================================================ revisions

describe("every proposal has a revision, and a superseded proposal can never be accepted", () => {
  it("a chain of counters: A proposes, B counters, A counters, B accepts the last; each earlier revision is superseded and is refused if answered", async () => {
    const s = await ladder({}, 3);
    const [, top, low] = s.people;
    const day = freshDay();
    const made = await propose(s.l, low, top, day, START);
    expect(await revOf(made.id)).toBe(1);
    ok(await answer(top.user.id, made.id, { propose: true, onDate: day, minute: START + 30 }, { rev: 1 }));
    expect(await revOf(made.id)).toBe(2);
    ok(await answer(low.user.id, made.id, { propose: true, onDate: day, minute: START + 60 }, { rev: 2 }));
    expect(await revOf(made.id)).toBe(3);
    // The old revisions are history: flagged superseded, never toward a hold.
    const before = await agreements(made.id);
    expect(before.filter((r) => r.superseded_at !== null).map((r) => r.rev).sort()).toEqual([1, 2]);
    expect(before.filter((r) => r.superseded_at === null).map((r) => [r.player_id, r.rev])).toEqual([[low.id, 3]]);
    // B answers the revision they saw before the last counter: refused, with the current proposal returned, and nothing changes.
    const version = (await row(made.id)).version;
    const stale = await answer(top.user.id, made.id, { accept: true }, { rev: 2 });
    expect(stale).toMatchObject({ ok: false, code: "LAD5_STALE", status: 409 });
    if (stale.ok) throw new Error("stale");
    expect(stale.challenge).toMatchObject({ rev: 3, proposedMin: START + 60, proposedBy: low.id });
    expect((await row(made.id)).version).toBe(version);
    expect(await holdRows(made.id)).toEqual([]);
    // The current revision is accepted: only the last time is held, with the last two agreements.
    const done = ok(await answer(top.user.id, made.id, { accept: true }, { rev: 3 }));
    expect(done.hold).toMatchObject({ startMin: START + 60, agreed: true });
    expect((await agreements(made.id)).filter((r) => r.held_id !== null).map((r) => [r.role, r.player_id]).sort()).toEqual([["accepted", top.id], ["countered", low.id]]);
  });

  it("an act that names a stale revision is refused LAD5_STALE for accept, counter, withdraw and move acts alike, and the route answers with the current challenge", async () => {
    const s = await ladder({}, 3);
    const [, top, low] = s.people;
    const day = freshDay();
    const made = await propose(s.l, low, top, day, START);
    ok(await answer(top.user.id, made.id, { propose: true, onDate: day, minute: START + 30 }, { rev: 1 }));
    // accept, counter, withdraw at revision 1 while the proposal is at 2
    expect(await answer(low.user.id, made.id, { accept: true }, { rev: 1 })).toMatchObject({ ok: false, code: "LAD5_STALE" });
    expect(await answer(low.user.id, made.id, { propose: true, onDate: day, minute: START + 90 }, { rev: 1 })).toMatchObject({ ok: false, code: "LAD5_STALE" });
    expect(await withdraw(low.user.id, made.id, { rev: 1 })).toMatchObject({ ok: false, code: "LAD5_STALE" });
    const r = await post(low.user, s.l, made.id, { action: "accept", rev: 1 });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ code: "LAD5_STALE", challenge: { rev: 2, proposedMin: START + 30 } });
    expect(await holdRows(made.id)).toEqual([]);
    expect((await row(made.id)).status).toBe("pending");
    // move acts: once accepted, an asked move is answered by revision as well
    const ok2 = ok(await answer(low.user.id, made.id, { accept: true }, { rev: 2 }));
    expect(ok2.hold).not.toBeNull();
    const rev = await revOf(made.id);
    ok(await proposeMove(low.user.id, made.id, { onDate: freshDay(), minute: START + 120 }, { rev }));
    expect(await answerMove(top.user.id, made.id, true, { rev })).toMatchObject({ ok: false, code: "LAD5_STALE" });
    expect(await answerMove(top.user.id, made.id, false, { rev })).toMatchObject({ ok: false, code: "LAD5_STALE" });
    expect(await proposeMove(top.user.id, made.id, { onDate: freshDay(), minute: START + 150 }, { rev })).toMatchObject({ ok: false, code: "LAD5_STALE" });
    // the preview is refused the same way, so the screen never shows a superseded proposal as current
    expect(await previewHoldFor(top.user.id, made.id, { kind: "agree_move", rev })).toMatchObject({ ok: false, code: "LAD5_STALE" });
    expect((await holdViews([made.id])).get(made.id)).toMatchObject({ startMin: START + 30 });
  });

  it("on a ladder that holds court time the route refuses an act with no revision (400), never taking it as current; a stranger is still told nothing", async () => {
    const s = await ladder({}, 3);
    const [, top, low] = s.people;
    const made = await propose(s.l, low, top, freshDay(), START);
    for (const body of [{ action: "accept" }, { action: "propose", onDate: made.proposedOn, minute: START + 30 }, { action: "withdraw" }, { action: "propose_move", onDate: made.proposedOn, minute: START }, { action: "agree_move" }, { action: "decline_move" }, { action: "withdraw_move" }]) {
      const r = await post(top.user, s.l, made.id, body);
      expect(r.status).toBe(400);
      expect(await r.json()).toMatchObject({ code: "LAD5_REV_NEEDED" });
    }
    expect((await post(await person("Stranger"), s.l, made.id, { action: "accept" })).status).toBe(404);
    expect((await row(made.id)).status).toBe("pending");
    expect((await post(top.user, s.l, made.id, { action: "accept", rev: await revOf(made.id) })).status).toBe(200);
  });

  it("a material change ends every agreement recorded for the earlier specification: a manager's move does, and a pending request does", async () => {
    const s = await ladder({}, 3);
    const [, top, low] = s.people;
    const day = freshDay();
    const made = await propose(s.l, low, top, day, START);
    ok(await answer(top.user.id, made.id, { accept: true }, { rev: 1 }));
    ok(await proposeMove(low.user.id, made.id, { onDate: day, minute: START + 60 }, { rev: await revOf(made.id) }));
    const open = (await agreements(made.id)).filter((r) => r.held_id === null && r.superseded_at === null);
    expect(open).toEqual([expect.objectContaining({ player_id: low.id, role: "proposed", start_min: START + 60 })]);
    const revBefore = await revOf(made.id);
    expect((await send(managerCookie, s.l.id, { action: "hold_move", challengeId: made.id, onDate: day, minute: START + 120, reason: "A tournament needs the court" })).status).toBe(200);
    expect(await revOf(made.id)).toBeGreaterThan(revBefore);
    const after = await agreements(made.id);
    // The request and the first agreement both ended with the venue's own time; nothing is left open and nothing superseded counts toward the new tentative hold.
    expect(after.filter((r) => r.superseded_at === null)).toEqual([]);
    expect(after.filter((r) => r.superseded_reason === "moved by the venue").length).toBeGreaterThanOrEqual(2);
    expect((await row(made.id)).move_on).toBeNull();
    expect((await holdViews([made.id])).get(made.id)).toMatchObject({ tentative: true, agreed: false, startMin: START + 120 });
    // The players' request of the old revision cannot be agreed any more.
    expect(await answerMove(top.user.id, made.id, true, { rev: revBefore })).toMatchObject({ ok: false, code: "LAD5_STALE" });
  });

  it("the match length changing after a time was proposed ends that proposal: what its maker agreed is not what would be held, nothing is agreed or held", async () => {
    const s = await ladder({}, 3);
    const [, top, low] = s.people;
    const made = await propose(s.l, low, top, freshDay(), START);
    ok(await answer(top.user.id, made.id, { propose: true, onDate: made.proposedOn!, minute: START + 30 }, { rev: 1 }));
    ok(await changeCourtTime(s.l.id, { minutes: 70 }));
    const refused = await answer(low.user.id, made.id, { accept: true }, { rev: 2 });
    expect(refused).toMatchObject({ ok: false, code: "LAD5_TERMS" });
    expect(await holdRows(made.id)).toEqual([]);
    expect(await row(made.id)).toMatchObject({ status: "pending", proposed_by: null, proposal_rev: 3 });
    expect((await agreements(made.id)).filter((r) => r.superseded_at === null)).toEqual([]);
    expect((await events(made.id)).at(-1)).toMatchObject({ kind: "superseded" });
  });
});

// ============================================================================ simultaneous counters

describe("simultaneous counters", () => {
  for (const first of ["challenger", "challenged"] as const) {
    it(`both ask for a different time at once, each having seen the same revision (${first} listed first): one wins by revision, the other is refused as stale with the winner's proposal returned, no hold`, async () => {
      for (let round = 0; round < 3; round++) {
        const s = await ladder({}, 3);
        const [, top, low] = s.people;
        const day = freshDay();
        const made = await propose(s.l, low, top, day, START);
        ok(await answer(top.user.id, made.id, { accept: true }, { rev: 1 }));
        const rev = await revOf(made.id);
        const lowAsks = () => proposeMove(low.user.id, made.id, { onDate: day, minute: START + 30 }, { rev });
        const topAsks = () => proposeMove(top.user.id, made.id, { onDate: day, minute: START + 90 }, { rev });
        const done = first === "challenger" ? await Promise.all([lowAsks(), topAsks()]) : (await Promise.all([topAsks(), lowAsks()])).reverse();
        const [lowResult, topResult] = done;
        expect(Number(lowResult.ok) + Number(topResult.ok)).toBe(1);
        const loser = lowResult.ok ? topResult : lowResult;
        const winner = lowResult.ok ? lowResult : topResult;
        if (loser.ok || !winner.ok) throw new Error("one wins");
        expect(loser).toMatchObject({ code: "LAD5_STALE" });
        // The refusal carries the winner's proposal, so the screen shows it; nothing was merged or reused.
        expect(loser.challenge).toMatchObject({ rev: rev + 1, move: { minute: winner.value.move!.minute, by: winner.value.move!.by } });
        expect((await row(made.id)).move_by).toBe(winner.value.move!.by);
        expect((await agreements(made.id)).filter((r) => r.held_id === null && r.superseded_at === null)).toHaveLength(1);
        // No hold was made by the race, and the one hold the challenge had is untouched.
        expect((await holdRows(made.id)).filter((h) => h.released_reason === null)).toHaveLength(1);
        expect(await noOverlap(courtA, day)).toBe(0);
      }
    });
  }

  it("an acceptance and a counter of the same revision at once: whichever is second is refused (stale or no longer waiting) and at most one hold is made", async () => {
    for (let round = 0; round < 3; round++) {
      const s = await ladder({}, 3);
      const [, top, low] = s.people;
      const day = freshDay();
      const made = await propose(s.l, low, top, day, START);
      // B counters while A, who proposed, takes the proposal back: the challenge ends one way or the other, never both.
      const [counter, taken] = await Promise.all([answer(top.user.id, made.id, { propose: true, onDate: day, minute: START + 30 }, { rev: 1 }), withdraw(low.user.id, made.id, { rev: 1 })]);
      expect(Number(counter.ok) + Number(taken.ok)).toBeGreaterThanOrEqual(1);
      if (counter.ok && taken.ok) expect((await row(made.id)).status).toBe("cancelled");
      expect(await holdRows(made.id)).toEqual([]);
    }
  });
});

// ============================================================================ expiry

describe("a proposal lapses with the challenge's response window", () => {
  it("an expired proposal cannot be accepted or countered (LAD5_EXPIRED), nothing changes, and the ladder's own outcome for no response is as before; a counter before the lapse works", async () => {
    const s = await ladder({}, 5);
    const [, top, low] = s.people;
    const day = freshDay();
    const made = await propose(s.l, low, top, day, START);
    // Before the lapse a counter works.
    const live = await propose(s.l, s.people[4], s.people[3], day, START + 120);
    ok(await answer(s.people[3].user.id, live.id, { propose: true, onDate: day, minute: START + 150 }, { rev: 1 }));
    // The last day passes without an answer.
    await db().prepare("UPDATE ladder_challenges SET respond_by = ? WHERE id = ?").run(addDays(today, -1), made.id);
    const version = (await row(made.id)).version;
    expect(await answer(top.user.id, made.id, { accept: true }, { rev: 1 })).toMatchObject({ ok: false, code: "LAD5_EXPIRED", vars: { date: addDays(today, -1) } });
    expect(await answer(top.user.id, made.id, { propose: true, onDate: day, minute: START + 30 }, { rev: 1 })).toMatchObject({ ok: false, code: "LAD5_EXPIRED" });
    expect(await holdRows(made.id)).toEqual([]);
    expect((await row(made.id)).version).toBe(version);
    expect((await agreements(made.id)).filter((r) => r.held_id !== null)).toEqual([]);
    // The ladder's own rule for an unanswered challenge is unchanged (here the challenged ignored it: forfeited by them), and nobody is penalised beyond it.
    await ladderHousekeeping();
    expect((await row(made.id)).status).toBe("walkover");
    expect((await events(made.id)).at(-1)).toMatchObject({ kind: "no_response", place_id: null });
    expect(await count(`SELECT COUNT(*)::int AS n FROM ladder_court_holds WHERE challenge_id = ${made.id}`)).toBe(0);
  });

  it("a request to move the time that nobody answers in time cannot be agreed (LAD5_EXPIRED), is ended by the scheduler once with both told, and can still be declined before", async () => {
    const s = await ladder({}, 3);
    const [, top, low] = s.people;
    const day = freshDay();
    const made = await propose(s.l, low, top, day, START);
    const c = ok(await answer(top.user.id, made.id, { accept: true }, { rev: 1 }));
    expect(c.hold).not.toBeNull();
    ok(await proposeMove(low.user.id, made.id, { onDate: day, minute: START + 90 }, { rev: await revOf(made.id) }));
    expect((await row(made.id)).move_respond_by).not.toBeNull();
    await db().prepare("UPDATE ladder_challenges SET move_respond_by = ? WHERE id = ?").run(addDays(today, -1), made.id);
    const rev = await revOf(made.id);
    expect(await answerMove(top.user.id, made.id, true, { rev })).toMatchObject({ ok: false, code: "LAD5_EXPIRED" });
    expect((await holdViews([made.id])).get(made.id)).toMatchObject({ startMin: START });
    await ladderHousekeeping();
    await ladderHousekeeping();
    expect((await row(made.id)).move_on).toBeNull();
    expect(await revOf(made.id)).toBeGreaterThan(rev);
    expect((await events(made.id)).filter((e) => e.kind === "no_response")).toHaveLength(1);
    for (const p of [low, top]) expect(await mailAbout(p.user.email, "was not answered in time")).toHaveLength(1);
    // The challenge stands as it was, nobody is at fault, and either can ask again.
    expect((await holdViews([made.id])).get(made.id)).toMatchObject({ startMin: START });
    ok(await proposeMove(top.user.id, made.id, { onDate: day, minute: START + 90 }, { rev: await revOf(made.id) }));
  });
});

// ============================================================================ booking conflicts

describe("a counter-proposal's acceptance bypasses nothing", () => {
  it("a court taken between the counter and its acceptance: refused, nothing reserved, the challenge and B's agreement unchanged; the preview named the court that is then held", async () => {
    const day = freshDay();
    const s = await ladder({ courtTime: { on: true, courtIds: [courtA, courtB] } }, 3);
    const [, top, low] = s.people;
    const made = await propose(s.l, low, top, day, START);
    ok(await answer(top.user.id, made.id, { propose: true, onDate: day, minute: START + 30 }, { rev: 1 }));
    const looked = ok(await previewHoldFor(low.user.id, made.id, { kind: "accept", rev: 2 }));
    if (!looked.applies) throw new Error("a court should be shown");
    expect(looked).toMatchObject({ date: day, startMin: START + 30, effect: "confirmed" });
    const before = { holds: await count("SELECT COUNT(*)::int AS n FROM ladder_court_holds"), row: await row(made.id), agreements: (await agreements(made.id)).length };
    // The court shown, then taken by the venue: refused with the reason, nothing reserved.
    expect((await blockSlots(looked.courtId!, day, { start: START - 60, end: START + 240 }, "Maintenance")).ok).toBe(true);
    expect(await answer(low.user.id, made.id, { accept: true, courtId: looked.courtId! }, { rev: 2 })).toMatchObject({ ok: false, code: "LAD4_COURT_CHANGED" });
    expect(await count("SELECT COUNT(*)::int AS n FROM ladder_court_holds")).toBe(before.holds);
    expect(await row(made.id)).toEqual(before.row);
    expect((await agreements(made.id)).length).toBe(before.agreements);
    expect((await agreements(made.id)).filter((r) => r.superseded_at === null && r.role === "countered")).toHaveLength(1);
    // The other court is free: accepting without naming one is the deterministic choice and holds exactly that.
    const done = ok(await answer(low.user.id, made.id, { accept: true }, { rev: 2 }));
    expect(done.hold!.courtId).not.toBe(looked.courtId);
    expect(await noOverlap(looked.courtId!, day)).toBe(0);
  });

  it("every court gone: refused, nothing held, and the challenge is left in 'arrange a time' with its proposal still there to be answered", async () => {
    const s = await ladder({}, 3);
    const [, top, low] = s.people;
    const day = freshDay();
    const made = await propose(s.l, low, top, day, START);
    ok(await answer(top.user.id, made.id, { propose: true, onDate: day, minute: START }, { rev: 1 }));
    const stranger = await person("Walker");
    expect((await createBooking({ courtId: courtA, date: day, hours: [START / 60], name: stranger.name, phone: stranger.phone, userId: stranger.id, staff: { override: true } })).ok).toBe(true);
    expect(await answer(low.user.id, made.id, { accept: true }, { rev: 2 })).toMatchObject({ ok: false, code: "LAD2_NO_COURT" });
    expect(await holdRows(made.id)).toEqual([]);
    expect(await row(made.id)).toMatchObject({ status: "pending", proposal_rev: 2, proposed_by: top.id });
  });

  it("an acceptance racing a booking for the last court: whichever is first, the other is refused and nothing overlaps", async () => {
    for (let round = 0; round < 2; round++) {
      const day = freshDay();
      const s = await ladder({}, 3);
      const [, top, low] = s.people;
      const made = await propose(s.l, low, top, day, START);
      ok(await answer(top.user.id, made.id, { propose: true, onDate: day, minute: START }, { rev: 1 }));
      const stranger = await person("Walker");
      const [accepted, booked] = await Promise.all([
        answer(low.user.id, made.id, { accept: true }, { rev: 2 }),
        createBooking({ courtId: courtA, date: day, hours: [START / 60], name: stranger.name, phone: stranger.phone, userId: stranger.id, staff: { override: true } }),
      ]);
      expect(Number(accepted.ok) + Number(booked.ok)).toBe(1);
      if (accepted.ok) expect(accepted.value.hold).toMatchObject({ tentative: false, agreed: true });
      else {
        expect(await holdRows(made.id)).toEqual([]);
        expect((await row(made.id)).status).toBe("pending");
      }
      expect(await noOverlap(courtA, day)).toBe(0);
    }
  });

  it("two counters accepted at once for the same court and time: one hold, one claim", async () => {
    const day = freshDay();
    const one = await ladder({}, 3);
    const two = await ladder({}, 3);
    const a = await propose(one.l, one.people[2], one.people[1], day, START);
    const b = await propose(two.l, two.people[2], two.people[1], day, START);
    ok(await answer(one.people[1].user.id, a.id, { propose: true, onDate: day, minute: START + 15 }, { rev: 1 }));
    ok(await answer(two.people[1].user.id, b.id, { propose: true, onDate: day, minute: START + 15 }, { rev: 1 }));
    const done = await Promise.all([answer(one.people[2].user.id, a.id, { accept: true }, { rev: 2 }), answer(two.people[2].user.id, b.id, { accept: true }, { rev: 2 })]);
    expect(done.filter((r) => r.ok)).toHaveLength(1);
    expect(done.find((r) => !r.ok)).toMatchObject({ code: "LAD2_NO_COURT" });
    expect(await count(`SELECT COUNT(*)::int AS n FROM ladder_court_holds WHERE court_id = ${courtA} AND date = '${day}' AND released_at IS NULL`)).toBe(1);
    expect(await noOverlap(courtA, day)).toBe(0);
  });

  it("the ladder's limits and the other bounds still apply to a counter's acceptance: the live limit, the play-by day and the opening hours", async () => {
    const s = await ladder({}, 7);
    const [, p2, p3, p4, p5, p6, p7] = s.people;
    expect((await send(managerCookie, s.l.id, { action: "hold_limits", scope: "ladder", maxLive: 1 })).status).toBe(200);
    const first = await propose(s.l, p3, p2, freshDay(), START);
    ok(await answer(p2.user.id, first.id, { accept: true }, { rev: 1 }));
    const second = await propose(s.l, p5, p4, freshDay(), START);
    ok(await answer(p4.user.id, second.id, { propose: true, onDate: second.proposedOn!, minute: START + 30 }, { rev: 1 }));
    const version = (await row(second.id)).version;
    expect(await answer(p5.user.id, second.id, { accept: true }, { rev: 2 })).toMatchObject({ ok: false, code: "LAD2_CAP_LADDER" });
    expect(await row(second.id)).toMatchObject({ status: "pending", version });
    await send(managerCookie, s.l.id, { action: "hold_limits", scope: "ladder", maxLive: null });
    // Hours: a counter at three in the morning is accepted as a proposal (nothing is reserved) but its acceptance is refused for the venue's hours, nothing held.
    const night = await propose(s.l, p7, p6, freshDay(), START);
    ok(await answer(p6.user.id, night.id, { propose: true, onDate: night.proposedOn!, minute: 3 * 60 }, { rev: 1 }));
    expect(await answer(p7.user.id, night.id, { accept: true }, { rev: 2 })).toMatchObject({ ok: false, code: "LAD2_CLOSED" });
    expect(await holdRows(night.id)).toEqual([]);
    // The play-by day: a counter beyond it is refused as a counter.
    const f = await ladder({}, 3);
    const far = await propose(f.l, f.people[2], f.people[1], freshDay());
    expect(await answer(f.people[1].user.id, far.id, { propose: true, onDate: addDays(today, 200), minute: START }, { rev: 1 })).toMatchObject({ ok: false, code: "LAD2_AFTER" });
  });

  it("the preview of a counter is a look only: it names the court, says the counter is a proposal and not a reservation, and reserves and changes nothing", async () => {
    const s = await ladder({}, 3);
    const [, top, low] = s.people;
    const day = freshDay();
    const made = await propose(s.l, low, top, day, START);
    const claims = await count("SELECT COUNT(*)::int AS n FROM claims WHERE active");
    const version = (await row(made.id)).version;
    const looked = ok(await previewHoldFor(top.user.id, made.id, { kind: "counter", onDate: day, minute: START + 45, rev: 1 }));
    if (!looked.applies) throw new Error("applies");
    expect(looked).toMatchObject({ court: "Counter Court A", date: day, startMin: START + 45, effect: "proposal", replaces: null });
    expect(await count("SELECT COUNT(*)::int AS n FROM claims WHERE active")).toBe(claims);
    expect((await row(made.id)).version).toBe(version);
    expect(await holdRows(made.id)).toEqual([]);
    expect(await agreements(made.id)).toHaveLength(1);
    // The preview equals the court then held: B's counter, A's acceptance.
    ok(await answer(top.user.id, made.id, { propose: true, onDate: day, minute: START + 45 }, { rev: 1 }));
    const asked = ok(await previewHoldFor(low.user.id, made.id, { kind: "accept", rev: 2 }));
    const done = ok(await answer(low.user.id, made.id, { accept: true, courtId: asked.applies ? asked.courtId! : undefined }, { rev: 2 }));
    expect(done.hold!.court).toBe(looked.court);
  });
});

// ============================================================================ team ladders

describe("a ladder of teams works the same through the captains", () => {
  async function adult(name: string): Promise<User> {
    n++;
    const made = await registerUser({ name: `${name} ${n}`, email: `tcount${n}@counter.test`, phone: `01387${String(n).padStart(5, "0")}`, password: "a long enough password" });
    if (!made.ok) throw new Error(made.error);
    await db().prepare("UPDATE users SET phone_verified_at = datetime('now'), verified_phone = phone WHERE id = ?").run(made.user.id);
    await saveProfile(made.user.id, { adult: true });
    return made.user;
  }
  async function side(label: string) {
    const captain = await adult(`${label} Captain`);
    n++;
    const made = await createTeam(captain.id, { name: `${label} ${n}`, sport: "badminton" });
    if (!made.ok) throw new Error(made.error);
    for (let i = 1; i < 3; i++) {
      const p = await adult(`${label} Player`);
      const link = await createInviteLink(captain.id, made.value.id);
      if (!link.ok) throw new Error(link.error);
      const done = await acceptInvitation(p, new URL(link.value.link).searchParams.get("token"), {});
      if (!done.ok) throw new Error(done.error);
    }
    void (await teamView(made.value.id, captain.id));
    const team: Team = made.value;
    return { captain, team };
  }

  it("a captain's counter is the team's agreement, holds nothing, and the other captain's acceptance holds the court for the games added up, confirmed", async () => {
    const l = ok(await createLadder({ venueId, name: `Counter Team Ladder ${++n}`, sport: "badminton", teamSize: 1, level: null, kind: "teams", settings: { cooldownDays: 0, playDays: 60 }, courtTime: { on: true, courtIds: [courtA] } }, adminId));
    const a = await side("CtrA");
    const b = await side("CtrB");
    const pa = ok(await joinTeam(a.captain, l.id, a.team.id)).playerId;
    const pb = ok(await joinTeam(b.captain, l.id, b.team.id)).playerId;
    const day = freshDay();
    const made = ok(await challenge(b.captain.id, l.id, pb, pa, { onDate: day, minute: START }));
    const countered = ok(await answer(a.captain.id, made.id, { propose: true, onDate: day, minute: START + 60 }, { rev: await revOf(made.id) }));
    expect(countered).toMatchObject({ status: "pending", hold: null, proposedBy: pa });
    expect(await holdRows(made.id)).toEqual([]);
    expect((await agreements(made.id)).filter((r) => r.superseded_at === null)).toEqual([expect.objectContaining({ role: "countered", player_id: pa })]);
    // A stale acceptance is refused for the captain as for a player.
    expect(await answer(b.captain.id, made.id, { accept: true }, { rev: 1 })).toMatchObject({ ok: false, code: "LAD5_STALE" });
    const done = ok(await answer(b.captain.id, made.id, { accept: true }, { rev: 2 }));
    expect(done.hold).toMatchObject({ tentative: false, agreed: true, startMin: START + 60, endMin: START + 60 + 135 });
    expect((await agreements(made.id)).filter((r) => r.held_id !== null).map((r) => r.role).sort()).toEqual(["accepted", "countered"]);
  });
});

// ============================================================================ nothing blames anyone

describe("no wording blames anyone", () => {
  it("the old cooldown sentence and the abandoned-holds wording are gone from every dictionary, and the staff dictionaries say 'released unplayed' and 'no response'", () => {
    const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
    for (const f of ["src/lib/i18n.ts", "src/lib/i18n-zh.ts", "src/lib/i18n-ta.ts"]) {
      expect(read(f)).not.toContain("LAD4_COOLDOWN");
      expect(read(f)).toContain("err.LAD5_PAUSED");
    }
    const staffText = read("src/lib/staff-i18n/ladders.ts");
    expect(staffText).not.toMatch(/lad4\.adv\.abandon|lad4\.act\.holdCooldown|abandoned holds|Abandoned holds/);
    expect(staffText).toContain("released unplayed");
    expect(staffText).toContain("no response");
    // The pause sentence says it is no penalty, and the lib code has no counters reading the old columns for a limit.
    expect(read("src/lib/i18n.ts")).toContain("This is not a penalty");
    const holds = read("src/lib/ladder-holds.ts");
    expect(holds.match(/abandoned_place|abandoned_at/g) ?? []).toHaveLength(0);
  });

  it("a hold that nobody confirmed is recorded as no response, attributing nothing, and the neutral record names who proposed, countered, accepted and cancelled", async () => {
    const s = await ladder({}, 3);
    const [, top, low] = s.people;
    const day = freshDay();
    const made = await propose(s.l, low, top, day);
    ok(await answer(top.user.id, made.id, { accept: true }, { rev: 1 }));
    expect(ok(await staffHold(made.id, staff, { move: { onDate: day, minute: START } }, "Courts are busy that week")).hold).toMatchObject({ tentative: true });
    await db().prepare("UPDATE ladder_court_holds SET confirm_by = now() - interval '1 minute' WHERE challenge_id = ? AND released_at IS NULL").run(made.id);
    await db().prepare("UPDATE claims SET expires_at = now() - interval '1 minute' WHERE kind = 'block' AND block_id IN (SELECT b.id FROM blocks b JOIN ladder_court_holds h ON h.id = b.ladder_hold_id WHERE h.challenge_id = ?)").run(made.id);
    await ladderHousekeeping();
    const log = await events(made.id);
    expect(log.map((e) => e.kind)).toEqual(["proposed", "accepted", "moved", "no_response"]);
    expect(log.at(-1)).toMatchObject({ place_id: null, reserved_capacity: true });
    expect(log[0]).toMatchObject({ place_id: low.id, reserved_capacity: false });
    // The staff view says so; the proposal that never reserved a court is visibly not a hold.
    const view = (await ladderDetail(s.l.id, { forStaff: true }))!.challenges!.find((c) => c.id === made.id)! as ChallengeView;
    expect(view.history!.map((h) => h.kind)).toEqual(["proposed", "accepted", "moved", "no_response"]);
    // A player is shown none of it.
    expect(JSON.stringify(await myPlaces(top.user.id, s.l.id))).not.toContain("reservedCapacity");
  });
});
