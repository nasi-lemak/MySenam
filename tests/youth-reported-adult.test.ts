import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.YOUTH_QUIET_HOURS = "off";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, type Admin } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { createGroup, decideMember, joinGroup } from "../src/lib/groups";
import { addManaged } from "../src/lib/managed-people";
import { sendDueDigests } from "../src/lib/message-digest";
import { listMessageReports, reviewMessageReport } from "../src/lib/message-moderation";
import { cutoffFor, forgetMessagesOfUser, messagesExport, pruneMessageReports } from "../src/lib/message-privacy";
import { blockSender, myThreads, reportMessage, saveMessageSettings, sendMessage, threadView, unreadCount } from "../src/lib/messages";
import { listMessages, listPlatformMessages } from "../src/lib/outbox";
import { acceptInvite, createInvite } from "../src/lib/participants";
import { saveProfile } from "../src/lib/player-profiles";
import { listVenues } from "../src/lib/store";
import { listActivity } from "../src/lib/activity";
import type { Sport } from "../src/lib/types";
import { caseStep, caseView } from "../src/lib/youth-report-cases";
import {
  endYouthGroup, markYouthGroup, muteSender, myYouthGroups, removeMessage, requestVenue, setConsent, setGroupQuiet, setMinorOptIn, setSupervisedThreadState, setYouthAdult, unmute,
  youthGroupState, youthSeats,
} from "../src/lib/youth-messages";
import { staffAnswerVenue } from "../src/lib/youth-safeguarding";

/**
 * A reported adult is not told (lib/youth-report-cases.ts, lib/youth-messages.ts, lib/messages.ts, lib/message-moderation.ts, migration 0291; ADR 0049,
 * which amends ADR 0044): a report in a youth group's thread restricts the reported person's seat at once (a hold, not a finding, shown as one neutral
 * line that is the same for any reason), goes only to safeguarding personnel (never the reported person, nor staff who are the same person), its
 * evidence is read one report at a time with each reading recorded and held while the report or its restriction stands, and a moderator alone decides
 * what, if anything, the reported adult is told later. Every channel the reported adult could use is tried.
 */

let n = 0;
let ip = 0;
let sport: Sport;
let venues: Awaited<ReturnType<typeof listVenues>>;
let owner: Admin;
let ownerCookie: string;
let managerA: Admin;
let managerA2: Admin;
let managerACookie: string;
let managerB: Admin;
let deskCookie: string;

type Person = User & { cookie: string };

async function adult(name = "Alex", email?: string): Promise<Person> {
  n++;
  const made = await registerUser({ name: `${name} Ra${n}`, email: email ?? `ra${n}@reported.test`, phone: `01382${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await saveProfile(made.user.id, { adult: true });
  const on = await saveMessageSettings(made.user.id, { enabled: true, understood: true });
  if (!on.ok) throw new Error(on.error);
  return { ...made.user, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}

async function child(guardian: User, name: string): Promise<{ kid: Person; pid: number }> {
  const made = await addManaged(guardian.id, { displayName: name, birthYear: 2014, relationship: "parent", authority: true }, guardian.name);
  if (!made.ok) throw new Error(made.error);
  const code = await createInvite(guardian, made.person.id, "link");
  if (!code.ok) throw new Error(code.error);
  n++;
  const reg = await registerUser({ name, email: `rk${n}@reported.test`, phone: `01383${String(n).padStart(5, "0")}`, password: "a long enough password" });
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

/**
 * A marked group with no venue: the organiser, a coach (a second supervisor), two adults let in (`acc`, who will be reported, and `vol`), and two
 * children with every consent on. Each adult has written a message; the thread is open.
 */
async function world(opts: { coach?: boolean; accEmail?: string } = {}) {
  const org = await adult("Orla");
  const coach = opts.coach === false ? null : await adult("Colm");
  const acc = await adult("Alan", opts.accEmail);
  const vol = await adult("Vera");
  const grp = await createGroup(org.id, { name: `Reported juniors ${n}`, sport });
  if (!grp.ok) throw new Error(grp.error);
  const g = grp.group.id;
  await markYouthGroup(org.id, g);
  for (const [u, role, declaredRole] of [[coach, "supervisor", "coach"], [acc, "adult", "volunteer"], [vol, "adult", "parent"]] as const) {
    if (!u) continue;
    await join(u, g, org);
    const let_in = await setYouthAdult(org.id, g, { memberUserId: u.id, role, declaredRole });
    if (!let_in.ok) throw new Error(let_in.error);
  }
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
  const say = async (u: User, text: string) => {
    const r = await sendMessage(u.id, "group", g, text);
    if (!r.ok) throw new Error(`${text}: ${r.error}`);
    return r.message.id;
  };
  await say(org, "Welcome everybody");
  const accMsg = await say(acc, "Alan says hello to the juniors");
  const volMsg = await say(vol, "Vera says hello to the juniors");
  const report = async (reporter: User, messageId: number, reason: "abuse" | "safety" | "other" = "abuse") => {
    const r = await reportMessage(reporter.id, "group", g, { messageId, reason });
    if (!r.ok) throw new Error(`report: ${r.error}`);
    return ((await getDb().prepare("SELECT id FROM player_message_reports WHERE context_id = ? AND message_id = ? AND reporter_id = ?").get(g, messageId, reporter.id)) as { id: number }).id;
  };
  return { org, coach, acc, vol, g, a, b, say, accMsg, volMsg, report };
}

/** The same group asked a venue and its manager accepted: the venue's own. */
async function venueWorld(accEmail?: string) {
  const w = await world({ accEmail });
  expect(await requestVenue(w.org.id, w.g, venues[0].id)).toMatchObject({ ok: true });
  expect(await staffAnswerVenue(managerA, w.g, true)).toMatchObject({ ok: true });
  return w;
}

const call = (url: string, method: string, cookie: string | null, body?: unknown) =>
  new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.8.${Math.floor(++ip / 250) % 250}.${(ip % 250) + 1}`, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const reply = async (res: Response) => ({ status: res.status, body: ((await res.json().catch(() => null)) ?? {}) as Record<string, any> });
const moderation = () => import("../src/app/api/admin/message-moderation/route");
const youthRoute = () => import("../src/app/api/admin/youth-groups/route");
const messagesRoute = () => import("../src/app/api/admin/messages/route");
const modGet = async (cookie: string, q = "") => reply(await (await moderation()).GET(call(`http://localhost/api/admin/message-moderation${q}`, "GET", cookie)));
const modPost = async (cookie: string, body: object) => reply(await (await moderation()).POST(call("http://localhost/api/admin/message-moderation", "POST", cookie, body)));
const ygGet = async (cookie: string, q = "") => reply(await (await youthRoute()).GET(call(`http://localhost/api/admin/youth-groups${q}`, "GET", cookie)));
const ygPost = async (cookie: string, body: object) => reply(await (await youthRoute()).POST(call("http://localhost/api/admin/youth-groups", "POST", cookie, body)));
const threadRoute = () => import("../src/app/api/messages/[kind]/[id]/route");
const ctx = (id: number) => ({ params: Promise.resolve({ kind: "group", id: String(id) }) });

const mailTo = async (email: string) =>
  (await getDb().prepare("SELECT id, kind, subject, body, params FROM messages WHERE recipient = ? ORDER BY id").all(email)) as { id: number; kind: string; subject: string; body: string; params: string }[];
/** What safeguarding sends: the kinds a reported person must never be sent by the system. */
const safeMail = async (email: string) => (await mailTo(email)).filter((m) => ["safeguarding_notice", "staff_alert", "player_message"].includes(m.kind));
const actionsOf = async (reportId: number) =>
  (await getDb().prepare("SELECT action, actor_name, detail FROM youth_report_actions WHERE report_id = ? ORDER BY id").all(reportId)) as { action: string; actor_name: string; detail: string | null }[];
const liveMute = async (g: number, userId: number) => Boolean(await getDb().prepare("SELECT 1 FROM youth_thread_mutes WHERE group_id = ? AND user_id = ? AND lifted_at IS NULL").get(g, userId));

beforeAll(async () => {
  venues = (await listVenues()).filter((v) => v.courts.length > 0);
  sport = ((await getDb().prepare("SELECT sport FROM courts WHERE id = ?").get(venues[0].courts[0].id)) as { sport: Sport }).sport;
  const mk = async (name: string, email: string, venueId: number | null, role?: "desk") => {
    const r = await createAdmin({ name, email, password: "a-staff-password-1", venueId, role });
    if (!r.ok) throw new Error(r.error);
    return r.admin;
  };
  managerA = await mk("Mia Manager", "mia@reported.test", venues[0].id);
  managerA2 = await mk("Max Manager", "max@reported.test", venues[0].id);
  managerB = await mk("Ben Manager", "ben@reported.test", venues[1].id);
  owner = await mk("Olive Owner", "olive@reported.test", null);
  const desk = await mk("Dee Desk", "dee@reported.test", venues[0].id, "desk");
  const cookie = async (a: Admin) => `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(a.id)).token}`;
  ownerCookie = await cookie(owner);
  managerACookie = await cookie(managerA);
  deskCookie = await cookie(desk);
}, 120_000);

describe("the reported adult's seat", () => {
  it("is restricted at once with one neutral line, the same for a supervisor's pause, and nothing of it reaches them by any channel", async () => {
    const w = await world();
    // They chose to be told at once of every message: the strongest case for a notice reaching them.
    await saveMessageSettings(w.acc.id, { noticeMode: "immediate" });
    const before = (await mailTo(w.acc.email)).length;
    // A supervisor pauses another adult for comparison: what that person sees is what the reported adult must see.
    expect(await muteSender(w.org.id, w.g, w.volMsg, "Needs a break")).toMatchObject({ ok: true });
    const reportId = await w.report(w.a.kid, w.accMsg);
    // Sending: one neutral refusal, 403, with no mention of a report, a reporter or content.
    const refused = await sendMessage(w.acc.id, "group", w.g, "may I?");
    expect(refused).toMatchObject({ ok: false, code: "PM_ACCESS_PAUSED", status: 403, error: "Your access to this conversation is paused while the venue reviews it. This is not a finding." });
    expect(await sendMessage(w.vol.id, "group", w.g, "may I?")).toEqual(refused);
    // Reading: no messages, no thread number, nobody counted; the very same view as the one a supervisor's pause gives.
    const seen = await threadView(w.acc.id, "group", w.g);
    expect(seen).toMatchObject({ ok: true, view: { canSend: false, whyNot: "PM_ACCESS_PAUSED", messages: [], people: 0, threadId: null } });
    if (!seen.ok) throw new Error(seen.error);
    expect(Object.keys(seen.view)).not.toContain("youth");
    expect(await threadView(w.vol.id, "group", w.g)).toEqual(seen);
    // The routes answer the same way: the page reads 200 with the line, a message is 403 with its code.
    const get = await reply(await (await threadRoute()).GET(call(`http://localhost/api/messages/group/${w.g}`, "GET", w.acc.cookie), ctx(w.g)));
    expect(get).toMatchObject({ status: 200, body: { canSend: false, whyNot: "PM_ACCESS_PAUSED", messages: [] } });
    const post = await reply(await (await threadRoute()).POST(call(`http://localhost/api/messages/group/${w.g}`, "POST", w.acc.cookie, { body: "hello" }), ctx(w.g)));
    expect(post).toMatchObject({ status: 403, body: { code: "PM_ACCESS_PAUSED" } });
    // Counts and lists: the conversation is listed with nothing unread, however much is written after.
    await w.say(w.org, "A message after the pause");
    const mine = await myThreads(w.acc.id);
    expect(mine.threads).toEqual([expect.objectContaining({ id: w.g, unread: 0, people: 0, lastAt: null })]);
    expect(await unreadCount(w.acc.id)).toBe(0);
    expect((await myThreads(w.vol.id)).threads).toEqual(mine.threads);
    // Evidence, ids and the thread cannot be asked for: a report or a block of a message is not found.
    expect(await reportMessage(w.acc.id, "group", w.g, { messageId: w.volMsg, reason: "abuse" })).toMatchObject({ ok: false, code: "PM_NOT_FOUND" });
    expect(await blockSender(w.acc.id, "group", w.g, w.volMsg)).toMatchObject({ ok: false, code: "PM_NOT_FOUND" });
    // Email and the outbox: nothing was queued for them, at once or in a digest, however long after.
    await sendDueDigests({ now: Date.now() + 48 * 3_600_000, force: true });
    const mails = await mailTo(w.acc.email);
    expect(mails.length).toBe(before);
    // The export holds no sign of it: no count, no evidence, a pause with no source.
    const exported = (await messagesExport(w.acc.id)) as { reportsAboutYou: number; youthMessaging: { pausedInGroups: Record<string, unknown>[] } };
    expect(exported.reportsAboutYou).toBe(0);
    expect(exported.youthMessaging.pausedInGroups).toEqual([expect.objectContaining({ group_id: w.g })]);
    expect(Object.keys(exported.youthMessaging.pausedInGroups[0])).not.toContain("source");
    expect(JSON.stringify(exported)).not.toMatch(/abuse|report_id|Aina/);
    expect(await mailTo(w.a.guardian.email)).not.toEqual([]);
    // And lifting it restores everything: a hold, never a finding.
    expect(await caseStep(owner, reportId, { step: "lift", reason: "Nothing found on review" })).toMatchObject({ ok: true });
    expect(await sendMessage(w.acc.id, "group", w.g, "thank you")).toMatchObject({ ok: true });
  }, 120_000);

  it("makes a supervisor's earlier pause the report's hold, which no supervisor can lift", async () => {
    const w = await world();
    expect(await muteSender(w.org.id, w.g, w.accMsg, "Needs a break")).toMatchObject({ ok: true });
    const pause = (await getDb().prepare("SELECT id FROM youth_thread_mutes WHERE group_id = ? AND user_id = ? AND lifted_at IS NULL").get(w.g, w.acc.id)) as { id: number };
    await w.report(w.vol, w.accMsg);
    expect(await unmute(w.org.id, w.g, pause.id)).toMatchObject({ ok: false, code: "YG_TARGET" });
    expect(await liveMute(w.g, w.acc.id)).toBe(true);
    // Nor does a supervisor see the report's hold among the pauses they may lift.
    const view = await threadView(w.org.id, "group", w.g);
    if (!view.ok) throw new Error(view.error);
    expect(view.view.youth?.muted ?? []).toEqual([]);
  });

  it("treats an adult-on-adult report the same, and never tells a reported guardian through the reporter's family", async () => {
    const w = await world();
    // The reported adult is also the second guardian of the child who reports: a notice to the child's guardians must not reach them.
    await getDb().prepare("INSERT INTO participant_guardians (participant_id, user_id, relationship, authority_declared_at, provenance) VALUES (?, ?, 'parent', now(), 'online')").run(w.a.pid, w.acc.id);
    const before = (await mailTo(w.acc.email)).length;
    await w.report(w.a.kid, w.accMsg);
    expect(await sendMessage(w.acc.id, "group", w.g, "may I?")).toMatchObject({ ok: false, code: "PM_ACCESS_PAUSED" });
    expect((await mailTo(w.acc.email)).length).toBe(before);
    expect((await mailTo(w.a.guardian.email)).some((m) => m.body.includes("made a report"))).toBe(true);
    // An adult reporting an adult: the same.
    const v = await world();
    const mailsBefore = (await mailTo(v.acc.email)).length;
    await v.report(v.vol, v.accMsg, "safety");
    expect(await sendMessage(v.acc.id, "group", v.g, "may I?")).toMatchObject({ ok: false, code: "PM_ACCESS_PAUSED" });
    expect((await mailTo(v.acc.email)).length).toBe(mailsBefore);
  });

  it("says nothing of reports in an automatic suspension, and tells the reported adult nothing of it", async () => {
    const w = await world();
    const second = await w.say(w.acc, "Alan has more to say");
    const third = await w.say(w.acc, "And a third thing from Alan");
    const before = (await mailTo(w.acc.email)).length;
    await w.report(w.a.kid, w.accMsg);
    await w.report(w.b.kid, second);
    await w.report(w.vol, third);
    const suspension = (await getDb().prepare("SELECT source, reason FROM player_message_suspensions WHERE user_id = ?").get(w.acc.id)) as { source: string; reason: string } | undefined;
    expect(suspension).toEqual({ source: "automatic", reason: "Paused pending review" });
    expect((await mailTo(w.acc.email)).length).toBe(before);
    const exported = JSON.stringify(await messagesExport(w.acc.id));
    expect(exported).not.toMatch(/different people|Reported by/);
  });
});

describe("a reported supervisor or organiser", () => {
  it("has no supervisor's powers while restricted, and is no longer shown as supervising", async () => {
    const w = await world();
    const coach = w.coach!;
    const coachMsg = await w.say(coach, "Colm here");
    await w.report(w.vol, coachMsg);
    const sampleMsg = await w.say(w.org, "A message the coach might act on");
    expect(await removeMessage(coach.id, w.g, sampleMsg, "off topic")).toMatchObject({ ok: false, code: "YG_SUPERVISOR" });
    expect(await muteSender(coach.id, w.g, w.volMsg, "break")).toMatchObject({ ok: false, code: "YG_SUPERVISOR" });
    expect(await setSupervisedThreadState(coach.id, w.g, "closed", "closing")).toMatchObject({ ok: false, code: "YG_SUPERVISOR" });
    expect(await youthGroupState(coach.id, w.g)).toMatchObject({ ok: false, code: "YG_NOT_FOUND" });
    expect((await youthSeats(w.g)).find((s) => s.userId === coach.id)).toMatchObject({ role: "adult", restricted: true });
    const view = await threadView(w.org.id, "group", w.g);
    if (!view.ok) throw new Error(view.error);
    expect(view.view.youth?.supervisors.join()).not.toContain("Colm");
    expect((await myYouthGroups(w.a.kid.id)).groups[0].supervisors.map((s) => s.name).join()).not.toContain("Colm");
    // The reporter and the rest of the thread are unaffected.
    expect(await sendMessage(w.org.id, "group", w.g, "carrying on")).toMatchObject({ ok: true });
  }, 120_000);

  it("has no organiser's powers while restricted, and the conversation waits for a supervisor", async () => {
    const w = await world({ coach: false });
    await w.report(w.vol, ((await getDb().prepare("SELECT id FROM player_messages WHERE sender_id = ?").get(w.org.id)) as { id: number }).id);
    for (const refusal of [
      await setYouthAdult(w.org.id, w.g, { memberUserId: w.vol.id, role: "supervisor", declaredRole: "coach" }),
      await endYouthGroup({ userId: w.org.id }, w.g, "closing it down"),
      await requestVenue(w.org.id, w.g, venues[0].id),
      await setGroupQuiet(w.org.id, w.g, { from: "21:00", to: "07:00" }),
      await youthGroupState(w.org.id, w.g),
    ])
      expect(refusal).toMatchObject({ ok: false, code: "YG_NOT_FOUND", status: 404 });
    // With no supervisor able to supervise, the children's conversation does not carry on unsupervised.
    expect(await threadView(w.a.kid.id, "group", w.g)).toMatchObject({ ok: true, view: { canSend: false, whyNot: "PM_YOUTH_FEW" } });
  }, 120_000);
});

describe("who is told, and who is not", () => {
  it("goes to the guardians involved and safeguarding personnel only; when the person reported is the venue's own staff the owner is told instead", async () => {
    const staffAdmin = await createAdmin({ name: "Stan Staff", email: "stan@reported.test", password: "a-staff-password-1", venueId: venues[0].id });
    if (!staffAdmin.ok) throw new Error(staffAdmin.error);
    const w = await venueWorld("stan@reported.test");
    const reportId = await w.report(w.a.kid, w.accMsg);
    const gname = ((await getDb().prepare("SELECT name FROM community_groups WHERE id = ?").get(w.g)) as { name: string }).name;
    const subjects = async (email: string) => (await mailTo(email)).filter((m) => m.kind === "safeguarding_notice" && m.subject.includes("youth group") && (m.subject + m.body).includes(gname));
    // The venue's other managers and the platform's owner are told; the supervisors, the other adults and the reported person (a staff member too) are not.
    expect((await subjects(managerA.email)).length).toBe(1);
    expect((await subjects(managerA2.email)).length).toBe(1);
    expect((await subjects(owner.email)).length).toBe(1);
    expect(await safeMail("stan@reported.test")).toEqual([]);
    for (const quiet of [w.org, w.coach!, w.vol, w.b.guardian, managerB]) expect((await mailTo(quiet.email)).filter((m) => m.kind === "safeguarding_notice")).toEqual([]);
    // Neither is in the venue's outbox screen nor in the owner's: they are not listed at all, and are never the text of a message.
    expect((await listMessages(venues[0].id, 500)).some((m) => m.kind === "safeguarding_notice" || m.kind === "staff_alert")).toBe(false);
    expect((await listPlatformMessages(500)).some((m) => m.kind === "safeguarding_notice")).toBe(false);
    const queued = (await getDb().prepare("SELECT venue_id, kind FROM messages WHERE recipient = ? AND kind = 'safeguarding_notice' ORDER BY id DESC").get(managerA.email)) as { venue_id: number | null; kind: string } | undefined;
    expect(queued).toEqual({ venue_id: null, kind: "safeguarding_notice" });
    // A report naming staff at the venue is escalated automatically: the owner sees it, as the other managers do.
    expect(((await modGet(ownerCookie)).body.reports as { id: number; escalated: boolean }[]).find((r) => r.id === reportId)).toMatchObject({ escalated: true });
    expect(((await modGet(managerACookie)).body.reports as { id: number }[]).map((r) => r.id)).toContain(reportId);
  }, 120_000);

  it("is not told to the supervisors, and only the reporter's and the reported minor's guardians learn that a report was made", async () => {
    const w = await world();
    const bMsg = await w.say(w.b.kid, "a clumsy remark");
    await w.report(w.a.kid, bMsg);
    expect((await mailTo(w.org.email)).filter((m) => m.kind === "safeguarding_notice")).toEqual([]);
    expect((await mailTo(w.coach!.email)).filter((m) => m.kind === "safeguarding_notice")).toEqual([]);
    expect((await mailTo(w.a.guardian.email)).some((m) => m.body.includes("made a report") && !m.body.includes("supervisors"))).toBe(true);
    expect((await mailTo(w.b.guardian.email)).some((m) => m.body.includes("about a message by") && !m.body.includes("supervisors"))).toBe(true);
  }, 120_000);
});

describe("the report is not here for the reported member of staff", () => {
  it("is left out of every list, route and panel, answered as anything that does not exist, and never in the activity feed or outbox", async () => {
    const staff = await createAdmin({ name: "Sam Staff", email: "sam@reported.test", password: "a-staff-password-1", venueId: venues[0].id });
    if (!staff.ok) throw new Error(staff.error);
    const staffCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(staff.admin.id)).token}`;
    const w = await venueWorld("sam@reported.test");
    const reportId = await w.report(w.a.kid, w.accMsg);
    const thread = ((await getDb().prepare("SELECT id FROM player_message_threads WHERE context_kind = 'group' AND context_id = ?").get(w.g)) as { id: number }).id;
    const missing = 987_654;
    // The list, one report, every action on it: the same as for a report that is not there.
    expect(((await modGet(staffCookie)).body.reports as { id: number }[]).map((r) => r.id)).not.toContain(reportId);
    expect(await modGet(staffCookie, `?report=${reportId}`)).toEqual(await modGet(staffCookie, `?report=${missing}`));
    expect((await modGet(staffCookie, `?report=${reportId}`)).status).toBe(404);
    for (const action of [
      { action: "review", outcome: "no_action" },
      { action: "review", outcome: "restriction_continues" },
      { action: "case", step: "lift", reason: "nothing found" },
      { action: "case", step: "note", text: "a note about it" },
    ])
      expect(await modPost(staffCookie, { ...action, id: reportId }), JSON.stringify(action)).toEqual(await modPost(staffCookie, { ...action, id: missing }));
    expect(await modPost(staffCookie, { action: "suspend", userId: w.acc.id, reportId, reason: "stop" })).toMatchObject({ status: 404 });
    expect(await modPost(staffCookie, { action: "thread", id: thread, state: "closed", reason: "closing" })).toEqual(await modPost(staffCookie, { action: "thread", id: 987_655, state: "closed", reason: "closing" }));
    // The group's own screens: not listed, not read, not looked after.
    expect((await ygGet(staffCookie)).body.groups.map((x: { groupId: number }) => x.groupId)).not.toContain(w.g);
    expect(await ygGet(staffCookie, `?group=${w.g}`)).toEqual(await ygGet(staffCookie, `?group=${missing}`));
    expect(await ygGet(staffCookie, `?safeguarding=${w.g}`)).toEqual(await ygGet(staffCookie, `?safeguarding=${missing}`));
    expect(await ygPost(staffCookie, { action: "end", groupId: w.g, reason: "closing it" })).toEqual(await ygPost(staffCookie, { action: "end", groupId: missing, reason: "closing it" }));
    expect(await ygPost(staffCookie, { action: "removeAdult", groupId: w.g, memberUserId: w.vol.id, reason: "removing" })).toEqual(await ygPost(staffCookie, { action: "removeAdult", groupId: missing, memberUserId: w.vol.id, reason: "removing" }));
    // Another manager of the same venue sees everything: the report, the group, the evidence.
    expect(((await modGet(managerACookie)).body.reports as { id: number; urgent: boolean }[]).find((r) => r.id === reportId)).toMatchObject({ urgent: true });
    expect((await ygGet(managerACookie)).body.groups.map((x: { groupId: number }) => x.groupId)).toContain(w.g);
    // The activity feed and the outbox screen hold nothing about it: not what moderators do, nor what the system sent.
    expect(await caseStep(managerA2, reportId, { step: "note", text: "Spoke to the organiser" })).toMatchObject({ ok: true });
    expect(await reviewMessageReport(managerA2, reportId, "restriction_continues")).toMatchObject({ ok: true });
    const feed = await listActivity([venues[0].id], { limit: 500 });
    expect(feed.filter((a) => a.action.startsWith("messages.") && a.action !== "messages.youth_group_answered")).toEqual([]);
    const outbox = await reply(await (await messagesRoute()).GET(call(`http://localhost/api/admin/messages?venueId=${venues[0].id}`, "GET", staffCookie)));
    expect(outbox.status).toBe(200);
    expect(JSON.stringify(outbox.body.messages)).not.toMatch(/youth group|report/i);
    // And what is never theirs by being staff: the player side of it.
    expect(await sendMessage(w.acc.id, "group", w.g, "may I?")).toMatchObject({ ok: false, code: "PM_ACCESS_PAUSED" });
    expect(await safeMail("sam@reported.test")).toEqual([]);
  }, 180_000);

  it("is also not here, as a list entry or a count, for the same person's player account under another name", async () => {
    // The staff login and the player account are the same person when they share a login email; nothing else says so.
    const staff = await createAdmin({ name: "Sue Staff", email: "sue@reported.test", password: "a-staff-password-1", venueId: null });
    if (!staff.ok) throw new Error(staff.error);
    const staffCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(staff.admin.id)).token}`;
    const w = await world({ accEmail: "sue@reported.test" });
    const reportId = await w.report(w.a.kid, w.accMsg);
    // The owner (a venue-less group is the owner's): the reported owner sees none of it, another owner sees it.
    expect(((await modGet(staffCookie)).body.reports as { id: number }[]).map((r) => r.id)).not.toContain(reportId);
    expect(((await modGet(ownerCookie)).body.reports as { id: number }[]).map((r) => r.id)).toContain(reportId);
    expect((await ygGet(staffCookie)).body.groups.map((x: { groupId: number }) => x.groupId)).not.toContain(w.g);
    expect((await ygGet(ownerCookie)).body.groups.find((x: { groupId: number }) => x.groupId === w.g)).toMatchObject({ openReports: 1 });
    // The other owners are told, never the reported one.
    expect((await mailTo(owner.email)).filter((m) => m.subject.includes("youth group")).length).toBeGreaterThan(0);
    expect(await safeMail("sue@reported.test")).toEqual([]);
  }, 120_000);
});

describe("the evidence", () => {
  it("is held back from lists, read one report at a time with each reading recorded, and held while the report or its restriction stands", async () => {
    const w = await world();
    const reportId = await w.report(w.a.kid, w.accMsg);
    const listed = (await listMessageReports(owner)).find((r) => r.id === reportId)!;
    expect(listed).toMatchObject({ urgent: true, linesHeld: true, lines: [], restricted: true });
    expect(JSON.stringify(await modGet(ownerCookie))).not.toContain("Alan says hello");
    // Reading: only those whose report it is, each reading recorded.
    expect(await caseView(managerB, reportId)).toMatchObject({ ok: false, status: 404 });
    expect(await modGet(deskCookie, `?report=${reportId}`)).toMatchObject({ status: 403 });
    const read = await caseView(owner, reportId);
    if (!read.ok) throw new Error(read.error);
    expect(read.case.lines.map((l) => l.body)).toEqual(expect.arrayContaining(["Welcome everybody", "Alan says hello to the juniors"]));
    expect(read.case.lines.filter((l) => l.flagged).map((l) => l.body)).toEqual(["Alan says hello to the juniors"]);
    expect(read.case).toMatchObject({ restricted: true, reported: { adult: true }, escalated: null });
    await caseView(owner, reportId);
    expect((await actionsOf(reportId)).filter((a) => a.action === "read").map((a) => a.actor_name)).toEqual(["Olive Owner", "Olive Owner"]);
    // The shared activity log has none of it.
    const logged = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM staff_actions WHERE action LIKE 'messages.report%'").get()) as { n: number };
    expect(logged.n).toBe(0);
    // Dealt with, the restriction continues: the report is reviewed and old, and still held; erasure of the reported account keeps the evidence.
    expect(await reviewMessageReport(owner, reportId, "restriction_continues")).toMatchObject({ ok: true });
    await getDb().prepare("UPDATE player_message_reports SET reviewed_at = '2020-01-01 00:00:00' WHERE id = ?").run(reportId);
    await pruneMessageReports(cutoffFor(-5));
    expect(await getDb().prepare("SELECT 1 FROM player_message_reports WHERE id = ?").get(reportId)).toBeTruthy();
    await forgetMessagesOfUser(w.acc.id);
    const kept = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM player_message_report_lines WHERE report_id = ? AND sender_id = ? AND body IS NOT NULL").get(reportId, w.acc.id)) as { n: number };
    expect(kept.n).toBe(1);
    // Once the restriction is lifted the hold ends: erasure takes what the person wrote. A report in a youth thread is safeguarding evidence: the ordinary
    // retention job invents no period for it and never deletes it (ADR 0052), so the report and what was done about it stay.
    expect(await caseStep(owner, reportId, { step: "lift", reason: "Cleared" })).toMatchObject({ ok: true });
    await forgetMessagesOfUser(w.acc.id);
    const after = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM player_message_report_lines WHERE report_id = ? AND sender_id = ? AND body IS NOT NULL").get(reportId, w.acc.id)) as { n: number };
    expect(after.n).toBe(0);
    await pruneMessageReports(cutoffFor(-5));
    expect(await getDb().prepare("SELECT 1 FROM player_message_reports WHERE id = ?").get(reportId)).toBeTruthy();
    expect((await actionsOf(reportId)).length).toBeGreaterThan(0);
  }, 120_000);

  it("is kept while the report is still open, however old", async () => {
    const w = await world();
    const reportId = await w.report(w.vol, w.accMsg);
    await getDb().prepare("UPDATE player_message_reports SET created_at = '2020-01-01 00:00:00' WHERE id = ?").run(reportId);
    await pruneMessageReports(cutoffFor(-5));
    await forgetMessagesOfUser(w.acc.id);
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM player_message_report_lines WHERE report_id = ? AND sender_id = ? AND body IS NOT NULL").get(reportId, w.acc.id)) as { n: number }).n).toBe(1);
  });
});

describe("a moderator manages the case", () => {
  it("confirms, extends, lifts, adds notes, escalates and reviews, each with a reason and each recorded", async () => {
    const w = await venueWorld();
    const reportId = await w.report(w.a.kid, w.accMsg);
    expect(await caseStep(managerA, reportId, { step: "nonsense" })).toMatchObject({ ok: false, error: "Choose what to do." });
    expect(await caseStep(managerA, reportId, { step: "confirm" })).toMatchObject({ ok: false, error: "Say why, in a few words." });
    expect(await caseStep(managerA, reportId, { step: "confirm", reason: "Reviewed the copy; it stands" })).toMatchObject({ ok: true });
    // Lifting restores the person; lifting what is not in force is refused; extending puts it back.
    expect(await caseStep(managerA, reportId, { step: "lift", reason: "Pending the organiser's account" })).toMatchObject({ ok: true });
    expect(await sendMessage(w.acc.id, "group", w.g, "back")).toMatchObject({ ok: true });
    expect(await caseStep(managerA, reportId, { step: "lift", reason: "Again" })).toMatchObject({ ok: false, status: 409 });
    expect(await caseStep(managerA, reportId, { step: "confirm", reason: "Still" })).toMatchObject({ ok: false, status: 409 });
    expect(await caseStep(managerA, reportId, { step: "extend", reason: "More came to light" })).toMatchObject({ ok: true });
    expect(await sendMessage(w.acc.id, "group", w.g, "again")).toMatchObject({ ok: false, code: "PM_ACCESS_PAUSED" });
    expect(await caseStep(managerA, reportId, { step: "note", text: "  Spoke to the venue's welfare lead  " })).toMatchObject({ ok: true });
    expect(await caseStep(managerA, reportId, { step: "note", text: "x" })).toMatchObject({ ok: false });
    // Escalating: a venue's manager passes it to the owner (recorded, the owner told); the owner cannot escalate to the owner.
    expect(await caseStep(owner, reportId, { step: "note", text: "Not the owner's yet" })).toMatchObject({ ok: false, status: 404 });
    expect(await caseStep(managerA, reportId, { step: "escalate", reason: "Needs the owner's view" })).toMatchObject({ ok: true });
    expect(await caseStep(managerA, reportId, { step: "escalate", reason: "Again" })).toMatchObject({ ok: false, status: 409 });
    expect(await caseStep(owner, reportId, { step: "escalate", reason: "Self" })).toMatchObject({ ok: false, status: 409 });
    expect(await caseStep(owner, reportId, { step: "note", text: "Owner has seen it" })).toMatchObject({ ok: true });
    expect((await mailTo(owner.email)).some((m) => m.kind === "safeguarding_notice" && m.body.includes(`${reportId}`))).toBe(true);
    // Review outcomes: the third keeps the restriction; the report is dealt with once.
    expect(await reviewMessageReport(managerA, reportId, "restriction_continues")).toMatchObject({ ok: true });
    expect(await reviewMessageReport(managerA, reportId, "no_action")).toMatchObject({ ok: false, status: 404 });
    expect(await liveMute(w.g, w.acc.id)).toBe(true);
    const trail = await actionsOf(reportId);
    expect(trail.map((a) => a.action)).toEqual([
      "restriction_confirmed", "restriction_lifted", "restriction_extended", "note", "escalated", "note", "reviewed",
    ]);
    expect(trail.find((a) => a.action === "note")?.detail).toBe("Spoke to the venue's welfare lead");
    expect(JSON.stringify(trail)).not.toContain("Alan says hello");
    // A venue that is not the group's, front desk and the signed-out have no part in it.
    expect(await caseStep(managerB, reportId, { step: "note", text: "Not mine to note" })).toMatchObject({ ok: false, status: 404 });
    expect(await modPost(deskCookie, { action: "case", id: reportId, step: "note", text: "A note from the desk" })).toMatchObject({ status: 403 });
    expect((await (await moderation()).POST(call("http://localhost/api/admin/message-moderation", "POST", null, { action: "case", id: reportId, step: "note", text: "x y z" }))).status).toBe(401);
  }, 180_000);

  it("is the only way the reported adult is ever told: in a moderator's own words, never naming the reporter or repeating the report", async () => {
    const w = await world();
    await saveMessageSettings(w.acc.id, { noticeMode: "immediate" });
    const reportId = await w.report(w.a.kid, w.accMsg);
    expect((await mailTo(w.acc.email)).filter((m) => m.kind === "safeguarding_notice")).toEqual([]);
    // Refused: too short; a reporter's name; the reported words; a minor (a child's guardians follow the usual notices).
    expect(await caseStep(owner, reportId, { step: "notify", text: "short" })).toMatchObject({ ok: false });
    expect(await caseStep(owner, reportId, { step: "notify", text: "Aina has told us you upset her, so we paused you." })).toMatchObject({ ok: false, error: "Do not name who made the report or repeat what was reported." });
    expect(await caseStep(owner, reportId, { step: "notify", text: "We looked at 'Alan says hello to the juniors' and paused you." })).toMatchObject({ ok: false, error: "Do not name who made the report or repeat what was reported." });
    const bMsg = await w.say(w.b.kid, "a clumsy remark here");
    const minorReport = await w.report(w.vol, bMsg);
    expect(await caseStep(owner, minorReport, { step: "notify", text: "We would like to talk to you about the group." })).toMatchObject({ ok: false, status: 409 });
    expect((await mailTo(w.acc.email)).filter((m) => m.kind === "safeguarding_notice")).toEqual([]);
    // Written by a moderator: sent, recorded with what was said, and never automatic.
    const text = "Your access to the group is paused while we review something. This is not a finding. We will be in touch.";
    expect(await caseStep(owner, reportId, { step: "notify", text })).toMatchObject({ ok: true });
    const got = (await mailTo(w.acc.email)).filter((m) => m.kind === "safeguarding_notice");
    expect(got).toHaveLength(1);
    expect(got[0].body).toContain(text);
    expect(got[0].body + got[0].params).not.toMatch(/Aina|abuse/i);
    expect((await actionsOf(reportId)).filter((a) => a.action === "notified_reported")).toEqual([{ action: "notified_reported", actor_name: "Olive Owner", detail: text }]);
    // Nobody else, and no other way: the reported person cannot ask for the case.
    expect(await caseView(managerA, reportId)).toMatchObject({ ok: false, status: 404 });
  }, 180_000);
});
