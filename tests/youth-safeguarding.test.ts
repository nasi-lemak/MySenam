import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.YOUTH_QUIET_HOURS = "off";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { createGroup, decideMember, joinGroup } from "../src/lib/groups";
import { addManaged } from "../src/lib/managed-people";
import { MESSAGES_PER_RECIPIENT_PER_DAY, emailPlayer } from "../src/lib/outbox";
import { reportMessage, saveMessageSettings, sendMessage, threadView } from "../src/lib/messages";
import { acceptInvite, createInvite } from "../src/lib/participants";
import { saveProfile } from "../src/lib/player-profiles";
import { listVenues } from "../src/lib/store";
import type { Sport } from "../src/lib/types";
import { markYouthGroup, requestVenue, setConsent, setMinorOptIn, setYouthAdult } from "../src/lib/youth-messages";

/**
 * The safeguarding side of supervised youth groups (lib/youth-safeguarding.ts, lib/message-moderation.ts, the routes; ADR 0044): an urgent
 * report (immediate, uncapped, never the text, a longer frozen copy, the reported person paused until review), a venue accepting a group and
 * its staff reading the thread with every reading audited, and who may call each route.
 */

let n = 0;
let ip = 0;
let sport: Sport;
let venues: Awaited<ReturnType<typeof listVenues>>;
let ownerCookie: string;
let managerA: string;
let managerB: string;
let deskA: string;

async function adult(name = "Alex"): Promise<User & { cookie: string }> {
  n++;
  const made = await registerUser({ name: `${name} Ho${n}`, email: `sg${n}@safeguard.test`, phone: `01398${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await saveProfile(made.user.id, { adult: true });
  const on = await saveMessageSettings(made.user.id, { enabled: true, understood: true });
  if (!on.ok) throw new Error(on.error);
  return { ...made.user, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}

async function child(guardian: User, name: string): Promise<{ kid: User & { cookie: string }; pid: number }> {
  const made = await addManaged(guardian.id, { displayName: name, birthYear: 2014, relationship: "parent", authority: true }, guardian.name);
  if (!made.ok) throw new Error(made.error);
  const code = await createInvite(guardian, made.person.id, "link");
  if (!code.ok) throw new Error(code.error);
  n++;
  const reg = await registerUser({ name, email: `sk${n}@safeguard.test`, phone: `01399${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!reg.ok) throw new Error(reg.error);
  await saveProfile(reg.user.id, { adult: false });
  const linked = await acceptInvite(reg.user, { code: code.code });
  if (!linked.ok) throw new Error(linked.error);
  return { kid: { ...reg.user, cookie: `${SESSION_COOKIE}=${(await createSession(reg.user.id)).token}` }, pid: made.person.id };
}

async function join(user: User, groupId: number, org: User): Promise<void> {
  const j = await joinGroup(user.id, groupId);
  if (!j.ok) throw new Error(j.error);
  const row = (await getDb().prepare("SELECT id FROM group_members WHERE group_id = ? AND user_id = ?").get(groupId, user.id)) as { id: number };
  const d = await decideMember(org.id, row.id, "accept");
  if (!d.ok) throw new Error(d.error);
}

/** A marked group with its organiser, a second adult let in, and two children with every consent on; the conversation begun. */
async function world() {
  const org = await adult("Orla");
  const other = await adult("Olly");
  const grp = await createGroup(org.id, { name: `Juniors ${n}`, sport });
  if (!grp.ok) throw new Error(grp.error);
  const g = grp.group.id;
  await markYouthGroup(org.id, g);
  await join(other, g, org);
  await setYouthAdult(org.id, g, { memberUserId: other.id, role: "adult", declaredRole: "coach" });
  const young = async (name: string) => {
    const guardian = await adult("Gia");
    const { kid, pid } = await child(guardian, name);
    await join(kid, g, org);
    await setMinorOptIn(kid.id, g, true);
    await setConsent(guardian.id, pid, g, true);
    return { kid, pid, guardian };
  };
  const a = await young("Aina Lee");
  const b = await young("Bo Tan");
  const first = await sendMessage(org.id, "group", g, "Welcome everybody");
  if (!first.ok) throw new Error(first.error);
  return { org, other, g, a, b };
}

const call = (url: string, method: string, cookie: string | null, body?: unknown) =>
  new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.7.${Math.floor(++ip / 250) % 250}.${(ip % 250) + 1}`, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
// A reply read loosely: the routes' answers are checked field by field below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const reply = async (res: Response) => ({ status: res.status, body: ((await res.json().catch(() => null)) ?? {}) as Record<string, any> });

const adminRoute = () => import("../src/app/api/admin/youth-groups/route");
const moderation = () => import("../src/app/api/admin/message-moderation/route");
const staffList = async (cookie: string | null, q = "") => reply(await (await adminRoute()).GET(call(`http://localhost/api/admin/youth-groups${q}`, "GET", cookie)));
const staffAct = async (cookie: string | null, body: object) => reply(await (await adminRoute()).POST(call("http://localhost/api/admin/youth-groups", "POST", cookie, body)));
const modAct = async (cookie: string, body: object) => reply(await (await moderation()).POST(call("http://localhost/api/admin/message-moderation", "POST", cookie, body)));
const modList = async (cookie: string) => reply(await (await moderation()).GET(call("http://localhost/api/admin/message-moderation", "GET", cookie)));

const mailTo = async (email: string, kind?: string) =>
  (await getDb()
    .prepare(`SELECT kind, status, subject, body, params FROM messages WHERE recipient = ?${kind ? " AND kind = ?" : ""} ORDER BY id`)
    .all(...(kind ? [email, kind] : [email]))) as { kind: string; status: string; subject: string; body: string; params: string }[];

beforeAll(async () => {
  venues = (await listVenues()).filter((v) => v.courts.length > 0);
  sport = ((await getDb().prepare("SELECT sport FROM courts WHERE id = ?").get(venues[0].courts[0].id)) as { sport: Sport }).sport;
  const a = await createAdmin({ name: "Mia Manager", email: "mia@safeguard.test", password: "manager-pass-1", venueId: venues[0].id });
  const b = await createAdmin({ name: "Ben Manager", email: "ben@safeguard.test", password: "manager-pass-2", venueId: venues[1].id });
  const d = await createAdmin({ name: "Dee Desk", email: "dee@safeguard.test", password: "desk-password-1", venueId: venues[0].id, role: "desk" });
  const o = await createAdmin({ name: "Olive Owner", email: "olive@safeguard.test", password: "owner-password-1", venueId: null });
  if (!a.ok || !b.ok || !d.ok || !o.ok) throw new Error("admins");
  const cookie = async (id: number) => `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(id)).token}`;
  managerA = await cookie(a.admin.id);
  managerB = await cookie(b.admin.id);
  deskA = await cookie(d.admin.id);
  ownerCookie = await cookie(o.admin.id);
}, 120_000);

describe("an urgent report in a youth group's thread", () => {
  it("is told at once to the supervisors, the guardians involved and the platform's owners, never with the text, and not held to the daily limit", async () => {
    const { org, other, g, a, b } = await world();
    const secret = "the-secret-word-cardamom";
    // Sixty lines in the thread first, to see how much is frozen: fifty, more than an ordinary report's twenty.
    const thread = (await getDb().prepare("SELECT id FROM player_message_threads WHERE context_kind = 'group' AND context_id = ?").get(g)) as { id: number };
    for (let i = 0; i < 60; i++) await getDb().prepare("INSERT INTO player_messages (thread_id, sender_id, sender_label, body) VALUES (?, ?, ?, ?)").run(thread.id, org.id, JSON.stringify({ n: "Orla", r: "supervisor" }), `line ${i}`);
    const said = await sendMessage(b.kid.id, "group", g, `a rude remark about ${secret}`);
    if (!said.ok) throw new Error("send");
    expect(await reportMessage(a.kid.id, "group", g, { messageId: said.message.id, reason: "abuse" })).toMatchObject({ ok: true });
    const report = (await getDb().prepare("SELECT id, urgent, reported_id FROM player_message_reports WHERE context_id = ?").get(g)) as { id: number; urgent: number; reported_id: number };
    expect(report).toMatchObject({ urgent: 1, reported_id: b.kid.id });
    const lines = (await getDb().prepare("SELECT COUNT(*)::int AS n, SUM(flagged)::int AS flagged FROM player_message_report_lines WHERE report_id = ?").get(report.id)) as { n: number; flagged: number };
    expect(lines).toEqual({ n: 50, flagged: 1 });
    // The reported person is paused in the thread until the report is reviewed; they can still read. The reporter is not paused.
    expect(await sendMessage(b.kid.id, "group", g, "my turn")).toMatchObject({ ok: false, code: "PM_YOUTH_MUTED" });
    expect(await threadView(b.kid.id, "group", g)).toMatchObject({ ok: true, view: { canSend: false, whyNot: "PM_YOUTH_MUTED" } });
    expect(await sendMessage(a.kid.id, "group", g, "I am still here")).toMatchObject({ ok: true });
    // Told at once: the supervisors (not the person reported), each child's guardian, the platform's owners (a group with no venue).
    const sup = await mailTo(org.email, "safeguarding_notice");
    expect(sup.length).toBeGreaterThan(0);
    expect((await mailTo(a.guardian.email, "safeguarding_notice")).some((m) => m.body.includes("made a report"))).toBe(true);
    expect((await mailTo(b.guardian.email, "safeguarding_notice")).some((m) => m.body.includes("about a message by"))).toBe(true);
    expect((await mailTo("olive@safeguard.test", "staff_alert")).some((m) => m.subject.includes("youth group"))).toBe(true);
    expect(await mailTo(other.email, "safeguarding_notice")).toEqual([]);
    // Never the text, never WhatsApp; each queued to send, not written off.
    const all = (await getDb().prepare("SELECT body, params, subject, channel, status FROM messages WHERE kind IN ('safeguarding_notice', 'staff_alert')").all()) as { body: string; params: string; subject: string; channel: string; status: string }[];
    for (const m of all) {
      expect(m.body + m.params + m.subject).not.toContain(secret);
      expect(m.channel).toBe("email");
    }
    expect(all.filter((m) => m.status === "abandoned")).toEqual([]);
  });

  it("is a message kind of its own, uncapped like a team decision: more than a day's limit still goes out", async () => {
    const guardian = await adult("Gia");
    for (let i = 0; i < MESSAGES_PER_RECIPIENT_PER_DAY + 4; i++)
      await emailPlayer({ kind: "safeguarding_notice", venueId: null, userId: guardian.id, subject: (t) => t("pmy.mail.subject", { site: "x" }), body: (t) => t("pmy.mail.suspended"), link: "https://example.test/messages", dedupeKey: `test-uncapped-${guardian.id}-${i}` });
    const sent = await mailTo(guardian.email, "safeguarding_notice");
    expect(sent).toHaveLength(MESSAGES_PER_RECIPIENT_PER_DAY + 4);
    expect(sent.filter((m) => m.status === "abandoned")).toEqual([]);
    // An ordinary programme email to the same person is capped.
    for (let i = 0; i < MESSAGES_PER_RECIPIENT_PER_DAY + 2; i++)
      await emailPlayer({ kind: "programme", venueId: null, userId: guardian.id, subject: () => "s", body: () => "b", link: "https://example.test/x", dedupeKey: `test-capped-${guardian.id}-${i}` });
    expect((await mailTo(guardian.email, "programme")).filter((m) => m.status === "abandoned").length).toBeGreaterThan(0);
  });

  it("is lifted by a review that needed no action, kept by one that took action, and shows as urgent to staff", async () => {
    const { g, a, b, other } = await world();
    const said = await sendMessage(b.kid.id, "group", g, "a rude remark");
    if (!said.ok) throw new Error("send");
    await reportMessage(other.id, "group", g, { messageId: said.message.id, reason: "abuse" });
    expect(await sendMessage(b.kid.id, "group", g, "paused?")).toMatchObject({ ok: false, code: "PM_YOUTH_MUTED" });
    // A group with no venue: the platform owner's. A venue's manager sees nothing of it.
    const reports = (await modList(ownerCookie)).body.reports as { id: number; urgent: boolean; kind: string; contextId: number }[];
    const mine = reports.find((r) => r.contextId === g)!;
    expect(mine).toMatchObject({ urgent: true, kind: "group" });
    expect((await modList(managerA)).body.reports.map((r: { id: number }) => r.id)).not.toContain(mine.id);
    // Action taken: the pause stays until a supervisor or staff lift it (a report's pause is not a supervisor's to lift).
    expect(await modAct(ownerCookie, { action: "review", id: mine.id, outcome: "action_taken" })).toMatchObject({ status: 200 });
    expect(await sendMessage(b.kid.id, "group", g, "still paused")).toMatchObject({ ok: false, code: "PM_YOUTH_MUTED" });
    // Another report, found to need nothing: the pause is lifted.
    const again = await sendMessage(a.kid.id, "group", g, "a fair question");
    if (!again.ok) throw new Error("send");
    await reportMessage(other.id, "group", g, { messageId: again.message.id, reason: "other" });
    expect(await sendMessage(a.kid.id, "group", g, "paused too")).toMatchObject({ ok: false, code: "PM_YOUTH_MUTED" });
    const second = ((await modList(ownerCookie)).body.reports as { id: number; contextId: number; reason: string }[]).find((r) => r.contextId === g && r.reason === "other")!;
    expect(await modAct(ownerCookie, { action: "review", id: second.id, outcome: "no_action" })).toMatchObject({ status: 200 });
    expect(await sendMessage(a.kid.id, "group", g, "back again")).toMatchObject({ ok: true });
  });

  it("tells the supervisors and the minors' guardians at once when staff close the conversation, and the person when their messaging is paused", async () => {
    const { g, a, org } = await world();
    const thread = (await getDb().prepare("SELECT id FROM player_message_threads WHERE context_kind = 'group' AND context_id = ?").get(g)) as { id: number };
    expect(await modAct(ownerCookie, { action: "thread", id: thread.id, state: "closed", reason: "Safeguarding review" })).toMatchObject({ status: 200 });
    expect((await mailTo(a.guardian.email, "safeguarding_notice")).some((m) => m.body.includes("has been closed"))).toBe(true);
    expect((await mailTo(org.email, "safeguarding_notice")).some((m) => m.body.includes("has been closed"))).toBe(true);
    expect(await sendMessage(org.id, "group", g, "after")).toMatchObject({ ok: false, code: "PM_CLOSED" });
    // A staff suspension of somebody: told to them at once, and to a minor's guardian.
    const w = await world();
    const said = await sendMessage(w.b.kid.id, "group", w.g, "rude");
    if (!said.ok) throw new Error("send");
    await reportMessage(w.other.id, "group", w.g, { messageId: said.message.id, reason: "abuse" });
    const report = (await getDb().prepare("SELECT id FROM player_message_reports WHERE context_id = ?").get(w.g)) as { id: number };
    expect(await modAct(ownerCookie, { action: "suspend", userId: w.b.kid.id, reportId: report.id, reason: "Repeated rude messages" })).toMatchObject({ status: 200 });
    expect((await mailTo(w.b.guardian.email, "safeguarding_notice")).some((m) => m.body.includes("has been paused"))).toBe(true);
    expect((await mailTo(w.b.kid.email, "safeguarding_notice")).some((m) => m.body.includes("has been paused"))).toBe(true);
  });
});

describe("a venue looking after a youth group", () => {
  it("sees a group only once it asked, reads its thread only once it accepted, and every reading is audited; another venue and front desk see nothing", async () => {
    const { org, g } = await world();
    const ordinary = await createGroup(org.id, { name: "Plain adults", sport });
    if (!ordinary.ok) throw new Error(ordinary.error);
    // Before any request: nothing for a venue; the platform's owner has the group.
    expect((await staffList(managerA)).body.groups).toEqual([]);
    expect((await staffList(ownerCookie)).body.groups.map((x: { groupId: number }) => x.groupId)).toContain(g);
    // The organiser asks venue A; it is waiting for its manager, who sees it as pending and cannot read the thread yet.
    expect(await requestVenue(org.id, g, 999_999)).toMatchObject({ ok: false, code: "YG_VENUE" });
    expect(await requestVenue(org.id, g, venues[0].id)).toMatchObject({ ok: true });
    const pending = (await staffList(managerA)).body.groups as { groupId: number; pending: boolean; supervisors: { declaredRole: string }[]; minors: number; messages: number }[];
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ groupId: g, pending: true, minors: 2, supervisors: [{ declaredRole: "organiser" }] });
    expect(JSON.stringify(pending)).not.toContain("Welcome everybody");
    expect((await staffList(managerA, `?group=${g}`)).status).toBe(404);
    expect((await staffList(managerB)).body.groups).toEqual([]);
    expect((await staffList(deskA)).status).toBe(403);
    expect((await staffList(null)).status).toBe(401);
    expect((await staffAct(deskA, { action: "answer", groupId: g, accept: true })).status).toBe(403);
    // Venue B's manager cannot accept a request made to venue A, and a group that never asked is not found.
    expect((await staffAct(managerB, { action: "answer", groupId: g, accept: true })).status).toBe(404);
    expect((await staffAct(managerA, { action: "answer", groupId: ordinary.group.id, accept: true })).status).toBe(404);
    // Accepting: the group is the venue's; the owner no longer has it.
    expect((await staffAct(managerA, { action: "answer", groupId: g, accept: true })).status).toBe(200);
    expect((await staffList(ownerCookie)).body.groups.map((x: { groupId: number }) => x.groupId)).not.toContain(g);
    expect((await staffList(managerB, `?group=${g}`)).status).toBe(404);
    expect((await staffList(ownerCookie, `?group=${g}`)).status).toBe(404);
    expect((await staffList(deskA, `?group=${g}`)).status).toBe(403);
    // Reading is recorded, in the staff activity log and the group's own record; an ordinary group's thread cannot be read.
    const before = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM staff_actions WHERE action = 'messages.youth_viewed'").get()) as { n: number };
    const read = await staffList(managerA, `?group=${g}`);
    expect(read.status).toBe(200);
    expect(read.body.messages.map((m: { body: string }) => m.body)).toContain("Welcome everybody");
    const after = (await getDb().prepare("SELECT COUNT(*)::int AS n, MAX(detail) AS detail FROM staff_actions WHERE action = 'messages.youth_viewed'").get()) as { n: number; detail: string };
    expect(after.n).toBe(before.n + 1);
    expect(after.detail).toContain(`youth group ${g}`);
    expect(after.detail).not.toContain("Welcome everybody");
    const record = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM youth_message_events WHERE group_id = ? AND action = 'staff_read'").get(g)) as { n: number };
    expect(record.n).toBe(1);
    expect((await staffList(managerA, `?group=${ordinary.group.id}`)).status).toBe(404);
    expect((await staffList(ownerCookie, `?group=${ordinary.group.id}`)).status).toBe(404);
  });

  it("moves the group's reports to the venue once it accepts, and lets staff take an adult out or end the group, each logged, telling the guardians", async () => {
    const { org, other, g, a, b } = await world();
    const said = await sendMessage(b.kid.id, "group", g, "a rude remark");
    if (!said.ok) throw new Error("send");
    await reportMessage(other.id, "group", g, { messageId: said.message.id, reason: "abuse" });
    const reportId = ((await getDb().prepare("SELECT id FROM player_message_reports WHERE context_id = ?").get(g)) as { id: number }).id;
    expect((await modList(ownerCookie)).body.reports.map((r: { id: number }) => r.id)).toContain(reportId);
    await requestVenue(org.id, g, venues[0].id);
    expect((await staffAct(managerA, { action: "answer", groupId: g, accept: true })).status).toBe(200);
    expect((await modList(ownerCookie)).body.reports.map((r: { id: number }) => r.id)).not.toContain(reportId);
    expect((await modList(managerA)).body.reports.map((r: { id: number }) => r.id)).toContain(reportId);
    expect((await modList(managerB)).body.reports.map((r: { id: number }) => r.id)).not.toContain(reportId);
    // Taking an adult out of the conversation: a reason, the venue's own group, never the organiser.
    expect((await staffAct(managerA, { action: "removeAdult", groupId: g, memberUserId: other.id, reason: "" })).status).toBe(400);
    expect((await staffAct(managerB, { action: "removeAdult", groupId: g, memberUserId: other.id, reason: "Safeguarding review" })).status).toBe(404);
    expect((await staffAct(managerA, { action: "removeAdult", groupId: g, memberUserId: org.id, reason: "Safeguarding review" })).status).toBe(409);
    expect((await staffAct(managerA, { action: "removeAdult", groupId: g, memberUserId: other.id, reason: "Safeguarding review" })).status).toBe(200);
    expect(await threadView(other.id, "group", g)).toMatchObject({ ok: false });
    // Ending the group: closed for good, the guardians told, logged.
    expect((await staffAct(managerB, { action: "end", groupId: g, reason: "Wrong venue" })).status).toBe(404);
    expect((await staffAct(managerA, { action: "end", groupId: g, reason: "Winding the group up" })).status).toBe(200);
    expect(await sendMessage(org.id, "group", g, "after")).toMatchObject({ ok: false });
    expect((await mailTo(a.guardian.email, "safeguarding_notice")).some((m) => m.body.includes("has been closed"))).toBe(true);
    const logged = (await getDb().prepare("SELECT action FROM staff_actions WHERE detail LIKE ? ORDER BY id").all(`%youth group ${g}%`)) as { action: string }[];
    expect(logged.map((l) => l.action)).toEqual(expect.arrayContaining(["messages.youth_group_answered", "messages.youth_adult_removed", "messages.youth_group_ended"]));
    // A group that asked and was declined goes back to the owner.
    const w = await world();
    await requestVenue(w.org.id, w.g, venues[1].id);
    expect((await staffAct(managerB, { action: "answer", groupId: w.g, accept: false })).status).toBe(200);
    expect((await staffList(managerB)).body.groups).toEqual([]);
    expect((await staffList(ownerCookie)).body.groups.map((x: { groupId: number }) => x.groupId)).toContain(w.g);
  });
});

describe("who may call each route", () => {
  const youthRoute = () => import("../src/app/api/messages/youth/route");
  const groupRoute = () => import("../src/app/api/groups/[id]/youth/route");
  const guardianRoute = () => import("../src/app/api/my/people/messaging/route");
  const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

  it("turns the signed-out away and gives a stranger the answer a missing group gets", async () => {
    const { org, other, g, a, b } = await world();
    const stranger = await adult("Sam");
    // Signed out: 401 on every player route.
    expect((await (await youthRoute()).GET(call("http://localhost/api/messages/youth", "GET", null))).status).toBe(401);
    expect((await (await youthRoute()).POST(call("http://localhost/api/messages/youth", "POST", null, { groupId: g, on: true }))).status).toBe(401);
    expect((await (await groupRoute()).GET(call(`http://localhost/api/groups/${g}/youth`, "GET", null), ctx(g))).status).toBe(401);
    expect((await (await groupRoute()).POST(call(`http://localhost/api/groups/${g}/youth`, "POST", null, { action: "mark" }), ctx(g))).status).toBe(401);
    expect((await (await guardianRoute()).GET(call("http://localhost/api/my/people/messaging", "GET", null))).status).toBe(401);
    expect((await (await guardianRoute()).POST(call("http://localhost/api/my/people/messaging", "POST", null, { action: "allOff", participantId: a.pid }))).status).toBe(401);
    // The group's youth settings: its organiser and supervisors only; anybody else is told it is not there, as for a group that does not exist.
    const settings = async (who: { cookie: string }, id = g) => reply(await (await groupRoute()).GET(call(`http://localhost/api/groups/${id}/youth`, "GET", who.cookie), ctx(id)));
    expect((await settings(org)).status).toBe(200);
    expect((await settings(org)).body.state).toMatchObject({ marked: true, organiser: true, supervisor: true });
    for (const who of [other, stranger, b.kid]) expect(await settings(who)).toMatchObject({ status: 404, body: { code: "YG_NOT_FOUND" } });
    expect(await settings(org, 987_654)).toMatchObject({ status: 404 });
    const act = async (who: { cookie: string }, body: object, id = g) => reply(await (await groupRoute()).POST(call(`http://localhost/api/groups/${id}/youth`, "POST", who.cookie, body), ctx(id)));
    // Only the organiser marks, asks a venue, sets rest hours, lets adults in, ends it.
    for (const body of [{ action: "mark" }, { action: "venue", venueId: venues[0].id }, { action: "quiet", from: "21:00", to: "07:00" }, { action: "adult", memberUserId: other.id, role: "supervisor", declaredRole: "coach" }, { action: "end", reason: "no longer" }])
      expect((await act(other, body)).status, JSON.stringify(body)).toBe(403);
    expect((await act(org, { action: "nonsense" })).status).toBe(400);
    // A supervisor's powers belong to supervisors; the adult let in has none.
    const said = await sendMessage(a.kid.id, "group", g, "a message");
    if (!said.ok) throw new Error("send");
    for (const body of [{ action: "removeMessage", messageId: said.message.id, reason: "off topic" }, { action: "mute", messageId: said.message.id, reason: "off topic" }, { action: "thread", state: "muted", reason: "break" }])
      expect((await act(other, body)).status, JSON.stringify(body)).toBe(403);
    expect((await act(org, { action: "removeMessage", messageId: said.message.id, reason: "off topic" })).status).toBe(200);
    // Making a supervisor of the other adult gives them the powers; a child can never be one.
    expect((await act(org, { action: "adult", memberUserId: other.id, role: "supervisor", declaredRole: "coach" })).status).toBe(200);
    expect((await act(other, { action: "thread", state: "muted", reason: "break" })).status).toBe(200);
    expect((await act(org, { action: "adult", memberUserId: a.kid.id, role: "supervisor", declaredRole: "other" })).status).toBe(409);
    // The child's own opt-in route: a declared adult is told it is not for them.
    expect((await reply(await (await youthRoute()).POST(call("http://localhost/api/messages/youth", "POST", stranger.cookie, { groupId: g, on: true })))).status).toBe(404);
    expect((await reply(await (await youthRoute()).POST(call("http://localhost/api/messages/youth", "POST", a.kid.cookie, { groupId: "x" })))).status).toBe(400);
    expect((await reply(await (await youthRoute()).GET(call("http://localhost/api/messages/youth", "GET", stranger.cookie)))).body).toEqual({ eligible: false, linked: false, groups: [] });
    expect((await reply(await (await youthRoute()).GET(call("http://localhost/api/messages/youth", "GET", a.kid.cookie)))).body).toMatchObject({ eligible: true, linked: true, groups: [{ groupId: g, active: true }] });
  });

  it("lets a guardian act only for the child they manage", async () => {
    const { g, a, b } = await world();
    const post = async (who: { cookie: string }, body: object) => reply(await (await guardianRoute()).POST(call("http://localhost/api/my/people/messaging", "POST", who.cookie, body)));
    const get = async (who: { cookie: string }, q = "") => reply(await (await guardianRoute()).GET(call(`http://localhost/api/my/people/messaging${q}`, "GET", who.cookie)));
    expect((await get(a.guardian)).body.children).toHaveLength(1);
    expect((await get(a.guardian)).body.children[0]).toMatchObject({ participantId: a.pid, groups: [{ groupId: g, consentOn: true }] });
    // Another guardian: not their child; nothing of it read, switched or blocked.
    expect(await post(b.guardian, { action: "consent", participantId: a.pid, groupId: g, on: false })).toMatchObject({ status: 404, body: { code: "YG_GUARDIAN" } });
    expect(await post(b.guardian, { action: "allOff", participantId: a.pid })).toMatchObject({ status: 404 });
    expect(await post(b.guardian, { action: "notices", participantId: a.pid, mode: "off" })).toMatchObject({ status: 404 });
    expect(await post(b.guardian, { action: "block", participantId: a.pid, groupId: g, userId: b.kid.id })).toMatchObject({ status: 404 });
    expect(await get(b.guardian, `?participantId=${a.pid}&groupId=${g}`)).toMatchObject({ status: 404, body: { code: "YG_GUARDIAN" } });
    expect((await get(a.guardian, `?participantId=${a.pid}&groupId=${g}`)).body).toMatchObject({ child: "Aina L.", messages: expect.any(Array) });
    expect((await get(a.guardian, `?participantId=${a.pid}`)).status).toBe(404);
    // A child's own account is not a guardian: nothing for it here.
    expect((await get(a.kid)).body.children).toEqual([]);
    expect(await post(a.kid, { action: "consent", participantId: a.pid, groupId: g, on: true })).toMatchObject({ status: 404 });
    // The guardian's own switch-off works at once and the page's answer shows it.
    expect(await post(a.guardian, { action: "consent", participantId: a.pid, groupId: g, on: false })).toMatchObject({ status: 200, body: { children: [{ groups: [{ consentOn: false, active: false }] }] } });
    expect(await post(a.guardian, { action: "nonsense" })).toMatchObject({ status: 400 });
    expect(await post(a.guardian, { action: "consent", participantId: a.pid, groupId: g })).toMatchObject({ status: 400 });
  });
});
