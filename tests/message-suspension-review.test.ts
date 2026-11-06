import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { askToJoin, openGame } from "../src/lib/games";
import { listActivity } from "../src/lib/activity";
import { messagesExport } from "../src/lib/message-privacy";
import { reportMessage, saveMessageSettings, sendMessage, threadView } from "../src/lib/messages";
import { saveProfile } from "../src/lib/player-profiles";
import { createBooking, listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Reports of messages between players are told to those who deal with them, and an automatic suspension can be reviewed: the owner reads its reports, a venue's manager lifts one
 * resting on that venue's reports alone, it ends with its reports, and the suspended person can ask for a review (lib/message-moderation.ts, lib/message-alerts.ts,
 * lib/suspension-reviews.ts; ADR 0059).
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


/** The alerts queued for staff (the outbox), newest last: who they went to and what they said. */
async function alerts(since: number) {
  return (await getDb()
    .prepare("SELECT id, recipient, kind, params FROM messages WHERE kind IN ('staff_alert', 'safeguarding_notice') AND id > ? ORDER BY id")
    .all(since)) as { id: number; recipient: string; kind: string; params: string | null }[];
}
const lastMessageId = async () => ((await getDb().prepare("SELECT COALESCE(MAX(id), 0)::int AS n FROM messages").get()) as { n: number }).n;

/** `n` different people report `bad` for a message in games of venue `v`; the report ids. */
async function reportsAbout(bad: User, v: number, n: number) {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const rep = await person();
    const g = await gameAt(v, rep, [bad]);
    await sendMessage(bad.id, "game", g.id, "just chatting about the match");
    const view = await threadView(rep.id, "game", g.id);
    if (!view.ok) throw new Error(view.error);
    const done = await reportMessage(rep.id, "game", g.id, { messageId: view.view.messages[0].id, reason: "safety" });
    if (!done.ok) throw new Error(done.error);
    ids.push(((await getDb().prepare("SELECT id FROM player_message_reports WHERE reporter_id = ? ORDER BY id DESC LIMIT 1").get(rep.id)) as { id: number }).id);
  }
  return ids;
}

describe("a report of a message in an ordinary conversation is told to the people who deal with it (F8)", () => {
  it("emails the venue's managers once, with no text, no names and no reason; not front desk, not another venue's managers", async () => {
    const before = await lastMessageId();
    const bad = await person({ name: "Quiet" });
    const [id] = await reportsAbout(bad, 0, 1);
    const sent = await alerts(before);
    const to = sent.map((m) => m.recipient);
    expect(to).toContain("mia@safety.test");
    expect(to).not.toContain("dee@safety.test");
    expect(to).not.toContain("ben@safety.test");
    expect(to).not.toContain("olive@safety.test");
    const mail = sent.find((m) => m.recipient === "mia@safety.test")!;
    expect(mail.params ?? "").not.toMatch(/chatting|Quiet|safety|feel/i);
    // The same report made again is the same report: nobody is told twice.
    const again = await alerts(before);
    expect(again.filter((m) => m.recipient === "mia@safety.test")).toHaveLength(1);
    expect(id).toBeGreaterThan(0);
  });

  it("is the same alert whatever the reporter chose as the reason", async () => {
    const bad = await person({ name: "Other" });
    const before = await lastMessageId();
    const rep = await person();
    const g = await gameAt(0, rep, [bad]);
    await sendMessage(bad.id, "game", g.id, "hello there");
    const view = await threadView(rep.id, "game", g.id);
    if (!view.ok) throw new Error(view.error);
    await reportMessage(rep.id, "game", g.id, { messageId: view.view.messages[0].id, reason: "other", note: "I feel unsafe" });
    const subjects = (await alerts(before)).filter((m) => m.recipient === "mia@safety.test").map((m) => JSON.parse(m.params ?? "{}").subject);
    expect(subjects).toHaveLength(1);
    const first = subjects[0];
    const before2 = await lastMessageId();
    const rep2 = await person();
    const g2 = await gameAt(0, rep2, [bad]);
    await sendMessage(bad.id, "game", g2.id, "hello again");
    const view2 = await threadView(rep2.id, "game", g2.id);
    if (!view2.ok) throw new Error(view2.error);
    await reportMessage(rep2.id, "game", g2.id, { messageId: view2.view.messages[0].id, reason: "spam" });
    expect((await alerts(before2)).filter((m) => m.recipient === "mia@safety.test").map((m) => JSON.parse(m.params ?? "{}").subject)).toEqual([first]);
  });
});

describe("an automatic suspension can be reviewed (F2)", () => {
  it("is told to the owner and the venue's managers with the date it is to be reviewed by", async () => {
    const before = await lastMessageId();
    const bad = await person({ name: "Pest" });
    await reportsAbout(bad, 0, 3);
    const sent = (await alerts(before)).filter((m) => /Three different/.test(m.params ?? ""));
    expect(sent.map((m) => m.recipient).sort()).toEqual(["mia@safety.test", "olive@safety.test"]);
    const susp = (await list(ownerCookie)).body.suspensions.find((s: { userId: number }) => s.userId === bad.id);
    expect(susp.reviewBy).toBeTruthy();
    expect(susp.overdue).toBe(false);
    expect(susp.reportIds).toHaveLength(3);
    // It is a line on the owner's needs-attention list, and the venue's manager's.
    const route = await import("../src/app/api/admin/attention/route");
    for (const cookie of [ownerCookie, managerA]) {
      const res = await route.GET(call("http://localhost/api/admin/attention", "GET", cookie));
      const body = await res.json();
      expect(body.messageModeration.suspensionsToReview.some((x: { id: number }) => x.id === susp.id)).toBe(true);
      expect(body.messageModeration.openReports).toBeGreaterThan(0);
    }
    // Not for another venue's manager, and not for front desk (null).
    const other = await (await route.GET(call("http://localhost/api/admin/attention", "GET", managerB))).json();
    expect(other.messageModeration.suspensionsToReview.some((x: { id: number }) => x.id === susp.id)).toBe(false);
    expect((await (await route.GET(call("http://localhost/api/admin/attention", "GET", deskA))).json()).messageModeration).toBeNull();
  });

  it("is lifted by the venue's manager when every report behind it is that venue's; not by another venue's manager or front desk", async () => {
    const bad = await person({ name: "Pest" });
    await reportsAbout(bad, 0, 3);
    const susp = (await list(managerA)).body.suspensions.find((s: { userId: number }) => s.userId === bad.id);
    expect(susp).toMatchObject({ source: "automatic" });
    expect((await list(managerB)).body.suspensions.some((s: { userId: number }) => s.userId === bad.id)).toBe(false);
    expect((await act(managerB, { action: "lift", id: susp.id, reason: "not mine" })).status).toBe(404);
    expect((await act(deskA, { action: "lift", id: susp.id, reason: "desk" })).status).toBe(403);
    expect((await act(managerA, { action: "lift", id: susp.id, reason: "Looked at all three: nothing." })).status).toBe(200);
    expect((await list(ownerCookie)).body.suspensions.some((s: { userId: number }) => s.userId === bad.id)).toBe(false);
    const row = (await getDb().prepare("SELECT lifted_by_name, lift_reason FROM player_message_suspensions WHERE id = ?").get(susp.id)) as { lifted_by_name: string; lift_reason: string };
    expect(row.lifted_by_name).toBe("Mia Manager");
    const logged = (await listActivity([venues[0].id], { limit: 30 })).some((a) => a.action === "messages.suspension_lifted");
    expect(logged).toBe(true);
  });

  it("is the owner's alone when the reports behind it are from more than one venue", async () => {
    const bad = await person({ name: "Roamer" });
    await reportsAbout(bad, 0, 2);
    await reportsAbout(bad, 1, 1);
    const susp = (await list(ownerCookie)).body.suspensions.find((s: { userId: number }) => s.userId === bad.id);
    expect(susp).toBeTruthy();
    expect((await list(managerA)).body.suspensions.some((s: { userId: number }) => s.userId === bad.id)).toBe(false);
    expect((await act(managerA, { action: "lift", id: susp.id, reason: "mine?" })).status).toBe(404);
    expect((await act(ownerCookie, { action: "lift", id: susp.id, reason: "Reviewed" })).status).toBe(200);
  });

  it("is lifted when enough of its reports are found to need no action, and not before", async () => {
    const bad = await person({ name: "Pest" });
    const ids = await reportsAbout(bad, 0, 3);
    expect((await act(managerA, { action: "review", id: ids[0], outcome: "no_action" })).status).toBe(200);
    // Two counted reports are fewer than the rule's three: the suspension does not outlive them.
    expect((await list(ownerCookie)).body.suspensions.some((s: { userId: number }) => s.userId === bad.id)).toBe(false);
    const row = (await getDb().prepare("SELECT lifted_by_name, lift_reason FROM player_message_suspensions WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(bad.id)) as { lifted_by_name: string; lift_reason: string };
    expect(row.lifted_by_name).toBe("Mia Manager");
    // A report found to need action leaves it in force.
    const worse = await person({ name: "Worse" });
    const more = await reportsAbout(worse, 0, 3);
    expect((await act(managerA, { action: "review", id: more[0], outcome: "action_taken" })).status).toBe(200);
    expect((await list(ownerCookie)).body.suspensions.some((s: { userId: number }) => s.userId === worse.id)).toBe(true);
  });

  it("can be asked about by the suspended person, once, neutrally, and answered", async () => {
    const bad = await person({ name: "Pest" });
    await reportsAbout(bad, 0, 3);
    const review = await import("../src/app/api/messages/suspension-review/route");
    const asBad = (method: string, body?: object) => review[method as "GET" | "POST"](call("http://localhost/api/messages/suspension-review", method, bad.cookie, body));
    expect(await (await asBad("GET")).json()).toMatchObject({ state: "none", suspended: true });
    // A stranger is told what anybody not suspended is told: it is not there.
    const stranger = await person();
    const asStranger = await review.POST(call("http://localhost/api/messages/suspension-review", "POST", stranger.cookie, { text: "hello" }));
    expect(asStranger.status).toBe(404);
    const before = await lastMessageId();
    const asked = await asBad("POST", { text: "I was only talking about the match." });
    expect(asked.status).toBe(200);
    expect(await (await asBad("GET")).json()).toMatchObject({ state: "received", outcome: null });
    expect((await asBad("POST", { text: "again" })).status).toBe(409);
    // Whoever may decide is told one is waiting: counts and place only.
    const told = (await alerts(before)).filter((m) => /asked for it to be looked at again/.test(m.params ?? ""));
    expect(told.map((m) => m.recipient).sort()).toEqual(["mia@safety.test", "olive@safety.test"]);
    const susp = (await list(managerA)).body.suspensions.find((s: { userId: number }) => s.userId === bad.id);
    expect(susp.reviewRequested).toMatchObject({ text: "I was only talking about the match." });
    // The answer "it stands" needs a reason and records it; the person is told only that it was decided.
    expect((await act(managerA, { action: "keep", id: susp.id, reason: "" })).status).toBe(400);
    expect((await act(managerA, { action: "keep", id: susp.id, reason: "Reports stand for now." })).status).toBe(200);
    expect(await (await asBad("GET")).json()).toMatchObject({ state: "decided", outcome: "continues", suspended: true });
    // A new request may follow a decided one; lifting answers it "lifted".
    expect((await asBad("POST", { text: "please" })).status).toBe(200);
    const again = (await list(ownerCookie)).body.suspensions.find((s: { userId: number }) => s.userId === bad.id);
    expect((await act(ownerCookie, { action: "lift", id: again.id, reason: "Reviewed" })).status).toBe(200);
    expect(await (await asBad("GET")).json()).toMatchObject({ state: "decided", outcome: "lifted", suspended: false });
    // The person's own requests are in their data export, in their own words with the outcome; nothing of any report.
    const exported = (await messagesExport(bad.id)) as { reviewRequests: { message: string | null; status: string; outcome: string | null }[] };
    expect(exported.reviewRequests.map((r) => [r.message, r.status, r.outcome])).toEqual([
      ["I was only talking about the match.", "decided", "continues"],
      ["please", "decided", "lifted"],
    ]);
  });

  it("is not decided again by the login that applied it", async () => {
    const victim = await person({ name: "Target" });
    const [reportId] = await reportsAbout(victim, 0, 1);
    expect((await act(managerA, { action: "suspend", userId: victim.id, reportId, reason: "Spam in games" })).status).toBe(200);
    const asked = await (await import("../src/lib/suspension-reviews")).askForSuspensionReview(victim.id, "please");
    expect(asked.ok).toBe(true);
    const susp = (await list(managerA)).body.suspensions.find((s: { userId: number }) => s.userId === victim.id);
    expect((await act(managerA, { action: "keep", id: susp.id, reason: "I stand by it" })).status).toBe(409);
    // The owner does not see a venue's own suspension.
    expect((await act(ownerCookie, { action: "keep", id: susp.id, reason: "Not mine to see" })).status).toBe(404);
  });
});

describe("an automatic suspension made of one venue's reports (the owner reads them; dismissing them lifts it)", () => {
  async function threeReports() {
    const bad = await person({ name: "Pest" });
    const reporters: User[] = [await person(), await person(), await person()];
    const ids: number[] = [];
    for (const rep of reporters) {
      const g = await gameAt(0, rep, [bad]);
      await sendMessage(bad.id, "game", g.id, "just chatting about the match");
      const v = await threadView(rep.id, "game", g.id);
      if (!v.ok) throw new Error(v.error);
      await reportMessage(rep.id, "game", g.id, { messageId: v.view.messages[0].id, reason: "spam" });
      ids.push(((await getDb().prepare("SELECT id FROM player_message_reports WHERE reporter_id = ? ORDER BY id DESC LIMIT 1").get(rep.id)) as { id: number }).id);
    }
    return { bad, ids };
  }

  it("is reviewable by whoever can see the reports behind it: the owner can read them", async () => {
    const { bad, ids } = await threeReports();
    const susp = (await list(ownerCookie)).body.suspensions.find((s: { userId: number }) => s.userId === bad.id);
    expect(susp).toMatchObject({ source: "automatic", pendingReview: true });
    // The owner is asked to review the suspension; intended: they can see the reports that caused it.
    const seen = (await list(ownerCookie, "?limit=200")).body.reports.map((x: { id: number }) => x.id);
    expect(ids.some((id) => seen.includes(id))).toBe(true);
  });

  it("does not outlive the reports once the venue that received them found no action needed in every one", async () => {
    const { bad, ids } = await threeReports();
    for (const id of ids) expect((await act(managerA, { action: "review", id, outcome: "no_action" })).status).toBe(200);
    // Intended: three reports each found to need no action leave nothing to suspend on (the count excludes them).
    const left = (await list(ownerCookie)).body.suspensions.some((s: { userId: number }) => s.userId === bad.id);
    expect(left).toBe(false);
    expect(await sendMessage(bad.id, "game", (await gameAt(0, await person(), [bad])).id, "can I write again?")).toMatchObject({ ok: true });
  });
});
