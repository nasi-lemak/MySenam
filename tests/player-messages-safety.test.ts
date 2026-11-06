import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import fs from "fs";
import path from "path";
import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { askToJoin, leaveGame, openGame } from "../src/lib/games";
import { createGroup, decideMember, joinGroup } from "../src/lib/groups";
import { listActivity } from "../src/lib/activity";
import { cutoffFor, messagesExport, pruneMessageReports } from "../src/lib/message-privacy";
import { blockSender, reportMessage, saveMessageSettings, sendMessage, threadView } from "../src/lib/messages";
import { saveProfile } from "../src/lib/player-profiles";
import { eraseCustomer, exportCustomerData, retentionDue } from "../src/lib/privacy";
import { createBooking, listVenues } from "../src/lib/store";
import { acceptInvitation, createInviteLink, createTeam, leaveTeam, type Team } from "../src/lib/teams";
import { addDays, todayISO } from "../src/lib/time";
import type { Sport } from "../src/lib/types";

/**
 * What staff may do about messages between players, who may call each route, what privacy asks of them (export, erasure, retention),
 * that nothing reaches the venue API or the MCP tools, and races: two people writing at once, a member leaving while a message posts
 * (lib/message-moderation.ts, lib/message-privacy.ts, src/app/api/messages, src/app/api/admin/message-moderation; ADR 0039).
 */

let n = 0;
let venues: Awaited<ReturnType<typeof listVenues>>;
let slot = 0;
let ownerCookie: string;
let managerA: string;
let managerB: string;
let deskA: string;

async function person(opts: { name?: string } = {}): Promise<User & { cookie: string }> {
  n++;
  const made = await registerUser({ name: `${opts.name ?? "Lou"} Ng${n}`, email: `ps${n}@safety.test`, phone: `01392${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await saveProfile(made.user.id, { adult: true });
  const done = await saveMessageSettings(made.user.id, { enabled: true, understood: true });
  if (!done.ok) throw new Error(done.error);
  return { ...made.user, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}

/** A game at a court of venue `v`, with these players accepted. */
async function gameAt(v: number, host: User, players: User[] = []) {
  const venue = venues[v];
  const court = venue.courts[0];
  slot++;
  const b = await createBooking({ courtId: court.id, date: addDays(todayISO(), 2 + (slot % 9)), hours: [10 + Math.floor(slot / 9)], name: host.name, phone: host.phone, userId: host.id });
  if (!b.ok) throw new Error(`booking: ${b.error}`);
  const g = await openGame(host.id, { bookingCode: b.booking.code, spots: 8, level: null, share: 0, autoAccept: true });
  if (!g.ok) throw new Error(g.error);
  for (const p of players) await askToJoin({ id: p.id, phone: p.phone }, g.game.id);
  return g.game;
}

const call = (url: string, method: string, cookie: string | null, body?: unknown) =>
  new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.8.${n % 250}.${(slot % 250) + 1}`, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ctxParams = (kind: string, id: number) => ({ params: Promise.resolve({ kind, id: String(id) }) });

/** A report about `bad`'s message in a game of venue `v`; its id and the thread's. */
async function reported(v: number) {
  const host = await person();
  const bad = await person({ name: "Bad" });
  const g = await gameAt(v, host, [bad]);
  await sendMessage(bad.id, "game", g.id, "rude words here");
  const view = await threadView(host.id, "game", g.id);
  if (!view.ok) throw new Error(view.error);
  const done = await reportMessage(host.id, "game", g.id, { messageId: view.view.messages[0].id, reason: "abuse" });
  if (!done.ok) throw new Error(done.error);
  const report = (await getDb().prepare("SELECT id, thread_id FROM player_message_reports WHERE reported_id = ? ORDER BY id DESC LIMIT 1").get(bad.id)) as { id: number; thread_id: number };
  return { host, bad, g, reportId: report.id, threadId: report.thread_id };
}

beforeAll(async () => {
  venues = (await listVenues()).filter((v) => v.courts.length > 0);
  const a = await createAdmin({ name: "Mia Manager", email: "mia@safety.test", password: "manager-pass-1", venueId: venues[0].id });
  const b = await createAdmin({ name: "Ben Manager", email: "ben@safety.test", password: "manager-pass-2", venueId: venues[1].id });
  const d = await createAdmin({ name: "Dee Desk", email: "dee@safety.test", password: "desk-password-1", venueId: venues[0].id, role: "desk" });
  const o = await createAdmin({ name: "Olive Owner", email: "olive@safety.test", password: "owner-password-1", venueId: null });
  if (!a.ok || !b.ok || !d.ok || !o.ok) throw new Error("admins");
  const cookie = async (id: number) => `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(id)).token}`;
  managerA = await cookie(a.admin.id);
  managerB = await cookie(b.admin.id);
  deskA = await cookie(d.admin.id);
  ownerCookie = await cookie(o.admin.id);
  // Four staff accounts hash four passwords: slow on a busy machine, not a thing under test.
}, 120_000);

const mod = () => import("../src/app/api/admin/message-moderation/route");
const list = async (cookie: string, q = "") => {
  const res = await (await mod()).GET(call(`http://localhost/api/admin/message-moderation${q}`, "GET", cookie));
  return { status: res.status, body: await res.json() };
};
const act = async (cookie: string, body: object) => {
  const res = await (await mod()).POST(call("http://localhost/api/admin/message-moderation", "POST", cookie, body));
  return { status: res.status, body: await res.json() };
};

describe("who sees a report", () => {
  it("is a venue's manager for its own conversations, the owner for those with no venue, and nobody else", async () => {
    const r = await reported(0);
    // Front desk and the signed-out are turned away; the manager of the other venue sees nothing; the owner none of a venue's.
    expect((await list(deskA)).status).toBe(403);
    expect((await (await mod()).GET(call("http://localhost/api/admin/message-moderation", "GET", null))).status).toBe(401);
    expect((await list(managerB)).body.reports.map((x: { id: number }) => x.id)).not.toContain(r.reportId);
    expect((await list(ownerCookie)).body.reports.map((x: { id: number }) => x.id)).not.toContain(r.reportId);
    const mine = await list(managerA);
    expect(mine.status).toBe(200);
    const report = mine.body.reports.find((x: { id: number }) => x.id === r.reportId);
    expect(report).toMatchObject({ reason: "abuse", status: "open", kind: "game", contextId: r.g.id, reported: { userId: r.bad.id, suspended: false } });
    // The copy frozen with the report is what staff read: the reported line marked.
    expect(report.lines).toEqual([expect.objectContaining({ body: "rude words here", flagged: true })]);
    // Nobody on staff can read an ordinary message: there is no route to a thread's messages.
    expect(Object.keys(await import("../src/app/api/admin/message-moderation/route")).sort()).toEqual(["GET", "POST", "dynamic"]);

    // A group has no venue: the owner's.
    const org = await person();
    const m = await person({ name: "Mal" });
    const grp = await createGroup(org.id, { name: "Sunday crowd", sport: venues[0].courts[0].sport as Sport });
    if (!grp.ok) throw new Error(grp.error);
    await joinGroup(m.id, grp.group.id);
    const row = (await getDb().prepare("SELECT id FROM group_members WHERE group_id = ? AND user_id = ?").get(grp.group.id, m.id)) as { id: number };
    await decideMember(org.id, row.id, "accept");
    await sendMessage(m.id, "group", grp.group.id, "nasty note");
    const gv = await threadView(org.id, "group", grp.group.id);
    if (!gv.ok) throw new Error(gv.error);
    await reportMessage(org.id, "group", grp.group.id, { messageId: gv.view.messages[0].id, reason: "spam" });
    const gr = (await getDb().prepare("SELECT id, venue_id FROM player_message_reports WHERE reported_id = ?").get(m.id)) as { id: number; venue_id: number | null };
    expect(gr.venue_id).toBeNull();
    expect((await list(ownerCookie)).body.reports.map((x: { id: number }) => x.id)).toContain(gr.id);
    expect((await list(managerA)).body.reports.map((x: { id: number }) => x.id)).not.toContain(gr.id);
    expect((await act(managerA, { action: "review", id: gr.id, outcome: "no_action" })).status).toBe(404);
    expect((await act(ownerCookie, { action: "review", id: gr.id, outcome: "action_taken" })).status).toBe(200);
  });
});

describe("what staff may do", () => {
  it("deals with a report, once, by number and reason, with no message text in the log", async () => {
    const r = await reported(0);
    expect((await act(deskA, { action: "review", id: r.reportId, outcome: "no_action" })).status).toBe(403);
    expect((await act(managerB, { action: "review", id: r.reportId, outcome: "no_action" })).status).toBe(404);
    expect((await act(managerA, { action: "review", id: r.reportId, outcome: "maybe" })).status).toBe(400);
    expect((await act(managerA, { action: "review", id: r.reportId, outcome: "action_taken" })).status).toBe(200);
    expect((await act(managerA, { action: "review", id: r.reportId, outcome: "action_taken" })).status).toBe(404);
    expect((await list(managerA, "?status=open")).body.reports.map((x: { id: number }) => x.id)).not.toContain(r.reportId);
    const done = (await list(managerA, "?status=reviewed")).body.reports.find((x: { id: number }) => x.id === r.reportId);
    expect(done).toMatchObject({ status: "reviewed", outcome: "action_taken", reviewedBy: "Mia Manager" });
    const log = await listActivity([venues[0].id]);
    const line = log.find((l) => l.action === "messages.report_reviewed" && l.detail?.includes(`Report ${r.reportId}`));
    expect(line).toBeTruthy();
    expect(JSON.stringify(log)).not.toContain("rude words");
  });

  it("pauses a thread, closes it for good, and opens a paused one again, for its own venue only", async () => {
    const r = await reported(0);
    expect((await act(managerA, { action: "thread", id: r.threadId, state: "muted", reason: "" })).status).toBe(400);
    expect((await act(managerB, { action: "thread", id: r.threadId, state: "muted", reason: "cooling off" })).status).toBe(404);
    expect((await act(ownerCookie, { action: "thread", id: r.threadId, state: "muted", reason: "cooling off" })).status).toBe(404);
    expect((await act(managerA, { action: "thread", id: r.threadId, state: "muted", reason: "cooling off" })).status).toBe(200);
    expect(await sendMessage(r.host.id, "game", r.g.id, "hello")).toMatchObject({ ok: false, code: "PM_PAUSED" });
    expect(await threadView(r.host.id, "game", r.g.id)).toMatchObject({ ok: true, view: { phase: "paused", canSend: false } });
    expect((await act(managerA, { action: "thread", id: r.threadId, state: "open", reason: "all calm" })).status).toBe(200);
    expect(await sendMessage(r.host.id, "game", r.g.id, "hello again")).toMatchObject({ ok: true });
    expect((await act(managerA, { action: "thread", id: r.threadId, state: "closed", reason: "enough" })).status).toBe(200);
    expect(await sendMessage(r.host.id, "game", r.g.id, "still there?")).toMatchObject({ ok: false, code: "PM_CLOSED" });
    expect(await threadView(r.bad.id, "game", r.g.id)).toMatchObject({ ok: false, code: "PM_CLOSED" });
    expect((await act(managerA, { action: "thread", id: r.threadId, state: "open", reason: "second thoughts" })).status).toBe(409);
    const logged = (await listActivity([venues[0].id])).filter((l) => l.action === "messages.thread_state" && l.detail?.includes(`Conversation ${r.threadId}`));
    expect(logged).toHaveLength(3);
  });

  it("suspends somebody's messaging for a venue only with a report in hand, everywhere for the owner, and lifts it with a reason", async () => {
    const r = await reported(0);
    const other = await reported(0);
    expect((await act(managerA, { action: "suspend", userId: r.bad.id, reason: "rude" })).status).toBe(400);
    expect((await act(managerA, { action: "suspend", userId: r.bad.id, reportId: other.reportId, reason: "rude" })).status).toBe(404);
    expect((await act(managerB, { action: "suspend", userId: r.bad.id, reportId: r.reportId, reason: "rude" })).status).toBe(404);
    expect((await act(managerA, { action: "suspend", userId: r.bad.id, reportId: r.reportId, reason: "" })).status).toBe(400);
    const made = await act(managerA, { action: "suspend", userId: r.bad.id, reportId: r.reportId, reason: "abusive to players" });
    expect(made.status).toBe(200);
    expect((await act(managerA, { action: "suspend", userId: r.bad.id, reportId: r.reportId, reason: "again" })).status).toBe(409);
    // In that venue's contexts they cannot write; in another venue's, or a group's, they can.
    expect(await sendMessage(r.bad.id, "game", r.g.id, "hello")).toMatchObject({ ok: false, code: "PM_SUSPENDED" });
    const elsewhereHost = await person();
    const elsewhere = await gameAt(1, elsewhereHost, [r.bad]);
    expect(await sendMessage(r.bad.id, "game", elsewhere.id, "hello there")).toMatchObject({ ok: true });
    // Neither the other venue's manager nor the owner can lift a venue's suspension; its own manager does, with a reason.
    const id = made.body.id as number;
    expect((await act(managerB, { action: "lift", id, reason: "fine" })).status).toBe(404);
    expect((await act(ownerCookie, { action: "lift", id, reason: "fine" })).status).toBe(404);
    expect((await act(managerA, { action: "lift", id, reason: "" })).status).toBe(400);
    expect((await act(managerA, { action: "lift", id, reason: "apologised" })).status).toBe(200);
    expect(await sendMessage(r.bad.id, "game", r.g.id, "sorry")).toMatchObject({ ok: true });
    // The owner suspends by account number, everywhere.
    expect((await act(ownerCookie, { action: "suspend", userId: r.bad.id, reason: "repeated abuse" })).status).toBe(200);
    expect(await sendMessage(r.bad.id, "game", elsewhere.id, "hello there")).toMatchObject({ ok: false, code: "PM_SUSPENDED" });
    expect((await list(ownerCookie)).body.suspensions.map((s: { userId: number }) => s.userId)).toContain(r.bad.id);
    expect((await list(managerA)).body.suspensions.map((s: { userId: number }) => s.userId)).not.toContain(r.bad.id);
    const log = await listActivity(null);
    expect(log.filter((l) => l.action === "messages.suspended" && l.detail?.includes(`Person ${r.bad.id}`)).length).toBeGreaterThanOrEqual(2);
    expect(log.some((l) => l.action === "messages.suspension_lifted")).toBe(true);
  });

  it("leaves an automatic suspension to the owner: lifted, or kept as a decision of theirs", async () => {
    const bad = await person({ name: "Pest" });
    const reporters: User[] = [await person(), await person(), await person()];
    for (const [i, rep] of reporters.entries()) {
      // Reports from two venues' games: the suspension is across venues (one resting on a single venue's reports is that venue's manager's too: message-suspension-review.test.ts).
      const g = await gameAt(i === 1 ? 1 : 0, rep, [bad]);
      await sendMessage(bad.id, "game", g.id, "spam spam");
      const v = await threadView(rep.id, "game", g.id);
      if (!v.ok) throw new Error(v.error);
      await reportMessage(rep.id, "game", g.id, { messageId: v.view.messages[0].id, reason: "spam" });
    }
    const susp = (await list(ownerCookie)).body.suspensions.find((s: { userId: number }) => s.userId === bad.id);
    expect(susp).toMatchObject({ source: "automatic", pendingReview: true, venueId: null });
    // A venue cannot touch it: it is across venues.
    expect((await act(managerA, { action: "lift", id: susp.id, reason: "not mine to lift" })).status).toBe(404);
    expect((await act(managerA, { action: "confirm", id: susp.id, reason: "not mine to confirm" })).status).toBe(404);
    expect((await act(ownerCookie, { action: "confirm", id: susp.id, reason: "three genuine reports" })).status).toBe(200);
    const kept = (await list(ownerCookie)).body.suspensions.find((s: { userId: number }) => s.userId === bad.id);
    expect(kept).toMatchObject({ source: "staff", pendingReview: false });
    expect(kept.reason).toContain("three genuine reports");
    expect((await act(ownerCookie, { action: "confirm", id: susp.id, reason: "again" })).status).toBe(404);
    expect((await act(ownerCookie, { action: "lift", id: susp.id, reason: "reviewed, fine" })).status).toBe(200);
    expect((await list(ownerCookie)).body.suspensions.map((s: { userId: number }) => s.userId)).not.toContain(bad.id);
  });
});

describe("the player's routes", () => {
  it("need an account, show nothing of other people's conversations, and take a message, a mute, a block and a report", async () => {
    const host = await person();
    const a = await person();
    const stranger = await person();
    const g = await gameAt(0, host, [a]);
    const base = await import("../src/app/api/messages/[kind]/[id]/route");
    const reportRoute = await import("../src/app/api/messages/[kind]/[id]/report/route");
    const blockRoute = await import("../src/app/api/messages/[kind]/[id]/block/route");
    const listRoute = await import("../src/app/api/messages/route");
    const settingsRoute = await import("../src/app/api/messages/settings/route");
    const url = `http://localhost/api/messages/game/${g.id}`;

    expect((await base.GET(call(url, "GET", null), ctxParams("game", g.id))).status).toBe(401);
    expect((await base.POST(call(url, "POST", null, { body: "hi" }), ctxParams("game", g.id))).status).toBe(401);
    expect((await listRoute.GET(call("http://localhost/api/messages", "GET", null))).status).toBe(401);
    expect((await settingsRoute.GET(call("http://localhost/api/messages/settings", "GET", null))).status).toBe(401);
    // Somebody not in the game: 404, whatever they try, and the same for a kind or number that is not one.
    for (const [m, req] of [
      ["GET", call(url, "GET", stranger.cookie)],
      ["POST", call(url, "POST", stranger.cookie, { body: "hi" })],
      ["PATCH", call(url, "PATCH", stranger.cookie, { muted: true })],
    ] as const) {
      const res = await (base as unknown as Record<string, (r: NextRequest, c: unknown) => Promise<Response>>)[m](req, ctxParams("game", g.id));
      expect(res.status, m).toBe(404);
    }
    expect((await base.GET(call(url, "GET", host.cookie), ctxParams("nonsense", g.id))).status).toBe(404);
    expect((await base.GET(call(url, "GET", host.cookie), ctxParams("game", 0))).status).toBe(404);

    const sent = await base.POST(call(url, "POST", a.cookie, { body: "see you at eight" }), ctxParams("game", g.id));
    expect(sent.status).toBe(201);
    const refusal = await base.POST(call(url, "POST", a.cookie, { body: "call 012 345 6789" }), ctxParams("game", g.id));
    expect(refusal.status).toBe(400);
    expect(await refusal.json()).toMatchObject({ code: "PM_CONTACT" });
    const got = await (await base.GET(call(`${url}?read=1`, "GET", host.cookie), ctxParams("game", g.id))).json();
    expect(got).toMatchObject({ kind: "game", id: g.id, phase: "open", canSend: true, messages: [{ body: "see you at eight", mine: false }] });
    // No user ids ride along with a message: nobody can learn an account number from a thread.
    expect(JSON.stringify(got)).not.toContain(`"senderId"`);
    expect(JSON.stringify(got.messages)).not.toContain(`"userId"`);
    const list = await (await listRoute.GET(call("http://localhost/api/messages", "GET", host.cookie))).json();
    expect(list.threads).toEqual([expect.objectContaining({ kind: "game", id: g.id, people: 1, unread: 0 })]);
    expect((await base.PATCH(call(url, "PATCH", host.cookie, { muted: true }), ctxParams("game", g.id))).status).toBe(200);
    expect((await base.PATCH(call(url, "PATCH", host.cookie, { muted: "yes" }), ctxParams("game", g.id))).status).toBe(400);
    const messageId = got.messages[0].id as number;
    expect((await reportRoute.POST(call(`${url}/report`, "POST", host.cookie, { messageId, reason: "other" }), ctxParams("game", g.id))).status).toBe(200);
    expect((await reportRoute.POST(call(`${url}/report`, "POST", host.cookie, { messageId, reason: "nope" }), ctxParams("game", g.id))).status).toBe(400);
    expect((await reportRoute.POST(call(`${url}/report`, "POST", stranger.cookie, { messageId, reason: "other" }), ctxParams("game", g.id))).status).toBe(404);
    expect((await blockRoute.POST(call(`${url}/block`, "POST", stranger.cookie, { messageId }), ctxParams("game", g.id))).status).toBe(404);
    expect((await blockRoute.POST(call(`${url}/block`, "POST", host.cookie, { messageId }), ctxParams("game", g.id))).status).toBe(200);
    // Blocked: what a writes no longer shows to host, and a is not told.
    const after = await base.POST(call(url, "POST", a.cookie, { body: "hello?" }), ctxParams("game", g.id));
    expect(after.status).toBe(201);
    const seen = await (await base.GET(call(url, "GET", host.cookie), ctxParams("game", g.id))).json();
    expect(seen.messages).toEqual([]);

    // The settings: on needs the first screen once and an adult; off and the emails are free.
    const set = async (cookie: string, body: object) => settingsRoute.PUT(call("http://localhost/api/messages/settings", "PUT", cookie, body));
    n++;
    const fresh = await registerUser({ name: `Fresh Ng${n}`, email: `ps${n}@safety.test`, phone: `01393${String(n).padStart(5, "0")}`, password: "a long enough password" });
    if (!fresh.ok) throw new Error(fresh.error);
    const freshCookie = `${SESSION_COOKIE}=${(await createSession(fresh.user.id)).token}`;
    expect(await (await set(freshCookie, { enabled: true, understood: true })).json()).toMatchObject({ code: "PM_ADULTS" });
    await saveProfile(fresh.user.id, { adult: true });
    expect(await (await set(freshCookie, { enabled: true })).json()).toMatchObject({ code: "PM_UNDERSTOOD" });
    expect(await (await set(freshCookie, { enabled: true, understood: true })).json()).toMatchObject({ settings: { enabled: true, explained: true } });
    expect(await (await set(freshCookie, { emailNotices: false })).json()).toMatchObject({ settings: { emailNotices: false, enabled: true } });
    expect(await (await set(freshCookie, { enabled: false })).json()).toMatchObject({ settings: { enabled: false } });
  });
});

describe("privacy", () => {
  it("exports what a person wrote and was shown, and counts the reports about them without showing them", async () => {
    const host = await person();
    const a = await person();
    const g = await gameAt(0, host, [a]);
    await sendMessage(a.id, "game", g.id, "export me please");
    await sendMessage(host.id, "game", g.id, "and the reply");
    const mine = (await messagesExport(a.id)) as { settings: { enabled: number }; threads: { context_kind: string; messages: { body: string; mine: boolean }[] }[]; reportsAboutYou: number };
    expect(mine.settings).toMatchObject({ enabled: 1 });
    expect(mine.threads).toHaveLength(1);
    expect(mine.threads[0].messages.map((m) => [m.body, m.mine])).toEqual([["export me please", true], ["and the reply", false]]);
    const whole = (await exportCustomerData(a.id)) as unknown as { playerMessages: { threads: unknown[] } };
    expect(whole.playerMessages.threads).toHaveLength(1);
    // Somebody they blocked is not in what they were shown.
    const v = await threadView(a.id, "game", g.id);
    if (!v.ok) throw new Error(v.error);
    await blockSender(a.id, "game", g.id, v.view.messages.find((m) => !m.mine)!.id);
    const after = (await messagesExport(a.id)) as { threads: { messages: { body: string }[] }[] };
    expect(after.threads[0].messages.map((m) => m.body)).toEqual(["export me please"]);
  });

  it("replaces what an erased person wrote with 'message removed', keeps the others' for them, and clears what they said in reports", async () => {
    const host = await person();
    const leaving = await person({ name: "Leaver" });
    const g = await gameAt(0, host, [leaving]);
    await sendMessage(leaving.id, "game", g.id, "words that will go");
    await sendMessage(host.id, "game", g.id, "words that stay");
    // A report by them with a note, about a message of the host; and a report about them by the host.
    const v = await threadView(host.id, "game", g.id);
    if (!v.ok) throw new Error(v.error);
    await reportMessage(host.id, "game", g.id, { messageId: v.view.messages.find((m) => !m.mine)!.id, reason: "other", note: "host's note" });
    const w = await threadView(leaving.id, "game", g.id);
    if (!w.ok) throw new Error(w.error);
    await reportMessage(leaving.id, "game", g.id, { messageId: w.view.messages.find((m) => !m.mine)!.id, reason: "other", note: "leaver's own note" });
    expect((await eraseCustomer(leaving.id)).ok).toBe(true);
    const after = await threadView(host.id, "game", g.id);
    if (!after.ok) throw new Error(after.error);
    expect(after.view.messages.map((m) => [m.body, m.from === null])).toEqual([[null, true], ["words that stay", false]]);
    const db = getDb();
    const lines = (await db.prepare("SELECT body, sender_label FROM player_message_report_lines WHERE sender_id IS NULL ORDER BY id").all()) as { body: string | null; sender_label: string | null }[];
    expect(lines.every((l) => l.body === null && l.sender_label === null)).toBe(true);
    const notes = (await db.prepare("SELECT note FROM player_message_reports WHERE reporter_id IS NULL AND note IS NOT NULL").all()) as unknown[];
    expect(notes).toEqual([]);
    expect(JSON.stringify(await db.prepare("SELECT * FROM player_messages").all())).not.toContain("words that will go");
    expect(JSON.stringify(await db.prepare("SELECT * FROM player_message_report_lines").all())).not.toContain("words that will go");
    // Their own setting, mutes and suspensions went with the account.
    expect(((await db.prepare("SELECT COUNT(*)::int AS n FROM player_message_settings WHERE user_id = ?").get(leaving.id)) as { n: number }).n).toBe(0);
  });

  it("keeps a report until it was dealt with and then the install's period, and counts what retention will do", async () => {
    const r = await reported(0);
    const db = getDb();
    await pruneMessageReports(cutoffFor(365));
    expect(((await db.prepare("SELECT COUNT(*)::int AS n FROM player_message_reports WHERE id = ?").get(r.reportId)) as { n: number }).n).toBe(1);
    // Open ones stay however old; reviewed ones go after the period, with their copy.
    await db.prepare("UPDATE player_message_reports SET created_at = ? WHERE id = ?").run(`${addDays(todayISO(), -800)} 10:00:00`, r.reportId);
    await pruneMessageReports(cutoffFor(365));
    expect(((await db.prepare("SELECT COUNT(*)::int AS n FROM player_message_reports WHERE id = ?").get(r.reportId)) as { n: number }).n).toBe(1);
    await db.prepare("UPDATE player_message_reports SET status = 'reviewed', outcome = 'no_action', reviewed_at = ? WHERE id = ?").run(`${addDays(todayISO(), -400)} 10:00:00`, r.reportId);
    const due = (await retentionDue()).filter((l) => l.what.includes("messages between players") || l.what.includes("Conversations between players"));
    expect(due.map((l) => l.action)).toEqual(["deleted", "deleted"]);
    expect(due.find((l) => l.what.startsWith("Reports"))!.affected).toBeGreaterThanOrEqual(1);
    await pruneMessageReports(cutoffFor(365));
    expect(((await db.prepare("SELECT COUNT(*)::int AS n FROM player_message_reports WHERE id = ?").get(r.reportId)) as { n: number }).n).toBe(0);
    expect(((await db.prepare("SELECT COUNT(*)::int AS n FROM player_message_report_lines WHERE report_id = ?").get(r.reportId)) as { n: number }).n).toBe(0);
  });
});

describe("what is not exposed", () => {
  it("is in neither the venue's API nor the MCP tools nor the public pages", () => {
    const root = path.join(__dirname, "..", "src");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
      }
    };
    walk(path.join(root, "lib", "mcp"));
    walk(path.join(root, "app", "api", "v1"));
    walk(path.join(root, "app", "api", "mcp"));
    walk(path.join(root, "app", "tournaments"));
    walk(path.join(root, "app", "venue"));
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.filter((f) => /player_message|lib\/messages|message-contexts|message-moderation|message-privacy|\.\/messages"/.test(fs.readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("races", () => {
  it("keeps every message of eight people writing at once, in an order, in one thread", async () => {
    const host = await person();
    const players = await Promise.all(Array.from({ length: 7 }, () => person()));
    const g = await gameAt(0, host, players);
    const results = await Promise.all([host, ...players].map((u, i) => sendMessage(u.id, "game", g.id, `at once ${i}`)));
    expect(results.every((r) => r.ok)).toBe(true);
    const db = getDb();
    const threads = (await db.prepare("SELECT id, message_count FROM player_message_threads WHERE context_kind = 'game' AND context_id = ?").all(g.id)) as { id: number; message_count: number }[];
    expect(threads).toHaveLength(1);
    expect(threads[0].message_count).toBe(8);
    const rows = (await db.prepare("SELECT id, body FROM player_messages WHERE thread_id = ? ORDER BY id").all(threads[0].id)) as { id: number; body: string }[];
    expect(rows.map((r) => r.body).sort()).toEqual(Array.from({ length: 8 }, (_, i) => `at once ${i}`).sort());
    // Everybody reads the same eight.
    for (const u of [host, ...players]) {
      const v = await threadView(u.id, "game", g.id);
      expect(v.ok && v.view.messages.length).toBe(8);
    }
  });

  it("never keeps a message from a member who has left, or loses one written before they did", async () => {
    for (let round = 0; round < 4; round++) {
      const host = await person();
      const a = await person();
      const g = await gameAt(0, host, [a]);
      await sendMessage(host.id, "game", g.id, "before");
      const [sent, left] = await Promise.all([sendMessage(a.id, "game", g.id, "racing"), leaveGame(a.id, g.id)]);
      expect(left.ok).toBe(true);
      const kept = ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM player_messages WHERE sender_id = ? AND body = 'racing'").get(a.id)) as { n: number }).n;
      // Either the message was written while they were in (and is kept) or they were already out (and it was refused as if they never were).
      if (sent.ok) expect(kept).toBe(1);
      else {
        expect(sent).toMatchObject({ code: "PM_NOT_FOUND" });
        expect(kept).toBe(0);
      }
      expect(await sendMessage(a.id, "game", g.id, "after")).toMatchObject({ ok: false, code: "PM_NOT_FOUND" });
    }
  });

  it("does the same for a team member leaving while a message posts", async () => {
    for (let round = 0; round < 3; round++) {
      const cap = await person();
      const m = await person();
      n++;
      const made = await createTeam(cap.id, { name: `Racers ${n}`, sport: "badminton" });
      if (!made.ok) throw new Error(made.error);
      const t: Team = made.value;
      const link = await createInviteLink(cap.id, t.id);
      if (!link.ok) throw new Error(link.error);
      const joined = await acceptInvitation(m, new URL(link.value.link).searchParams.get("token")!, {});
      if (!joined.ok) throw new Error(joined.error);
      const [sent, left] = await Promise.all([sendMessage(m.id, "team", t.id, "team race"), leaveTeam(m.id, t.id)]);
      expect(left.ok).toBe(true);
      const kept = ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM player_messages WHERE sender_id = ?").get(m.id)) as { n: number }).n;
      expect(kept).toBe(sent.ok ? 1 : 0);
      expect(await threadView(m.id, "team", t.id)).toMatchObject({ ok: false, code: "PM_NOT_FOUND" });
    }
  });

  it("makes one report of the same message however often and however fast it is reported", async () => {
    const host = await person();
    const bad = await person();
    const g = await gameAt(0, host, [bad]);
    await sendMessage(bad.id, "game", g.id, "once only");
    const v = await threadView(host.id, "game", g.id);
    if (!v.ok) throw new Error(v.error);
    const id = v.view.messages[0].id;
    const all = await Promise.all(Array.from({ length: 4 }, () => reportMessage(host.id, "game", g.id, { messageId: id, reason: "spam" })));
    expect(all.every((r) => r.ok)).toBe(true);
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM player_message_reports WHERE reported_id = ?").get(bad.id)) as { n: number }).n).toBe(1);
  });
});
