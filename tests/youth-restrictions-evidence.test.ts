import { afterEach, beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.YOUTH_QUIET_HOURS = "off";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, type Admin } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { createGroup, decideMember, joinGroup } from "../src/lib/groups";
import { addManaged } from "../src/lib/managed-people";
import { reviewMessageReport } from "../src/lib/message-moderation";
import { cutoffFor, forgetMessagesOfUser, messagesExport, pruneMessageReports, pruneYouthMessages } from "../src/lib/message-privacy";
import { reportMessage, saveMessageSettings, sendMessage, threadView } from "../src/lib/messages";
import { acceptInvite, createInvite } from "../src/lib/participants";
import { saveProfile } from "../src/lib/player-profiles";
import { pruneOldData, retentionDue } from "../src/lib/privacy";
import { staffTranslator } from "../src/lib/staff-i18n";
import { listVenues } from "../src/lib/store";
import type { Sport } from "../src/lib/types";
import { safeguardingEvidenceRetentionDays } from "../src/lib/youth-launch";
import {
  createHold, listHolds, pruneSafeguardingEvidence, recordRetentionReview, releaseHold, reviewHold, safeguardingReviewDue, tellOwnersReviewDue,
} from "../src/lib/youth-evidence";
import { endYouthGroup, markYouthGroup, muteSender, requestVenue, setConsent, setMinorOptIn, setYouthAdult } from "../src/lib/youth-messages";
import { caseStep, caseView } from "../src/lib/youth-report-cases";
import { askForReview, decideAppeal, listAppeals, myReviewState, restrictionHousekeeping, safeguardingAttention, youthHousekeeping } from "../src/lib/youth-restrictions";
import { staffAnswerVenue } from "../src/lib/youth-safeguarding";

/**
 * A restriction on an adult in a youth group's conversation, and the evidence kept (migration 0294; ADR 0052, which amends ADR 0049 and ADR 0044):
 * protective or a decision, a date to be reviewed by that never lifts or converts by itself, a request for a review that reveals nothing and goes to somebody
 * who did not apply the restriction, an escalation for safeguarding that tells the owner at once and sends nothing to any authority, the reporter's
 * confidentiality on every new surface, and four classes of evidence: no invented period, no deletion of an active case, controlled legal holds.
 */

const env = process.env as Record<string, string | undefined>;
let n = 0;
let ip = 0;
let sport: Sport;
let venues: Awaited<ReturnType<typeof listVenues>>;
let owner: Admin;
let managerA: Admin;
let managerA2: Admin;
let managerB: Admin;
let deskCookie: string;

type Person = User & { cookie: string };

async function adult(name = "Alex", email?: string): Promise<Person> {
  n++;
  const made = await registerUser({ name: `${name} Re${n}`, email: email ?? `re${n}@restrict.test`, phone: `01392${String(n).padStart(5, "0")}`, password: "a long enough password" });
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
  const reg = await registerUser({ name, email: `rk${n}@restrict.test`, phone: `01393${String(n).padStart(5, "0")}`, password: "a long enough password" });
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
 * A marked group (venue 0 accepted it unless `venue: false`): the organiser and a coach (supervisors), `acc` (Alan, an adult let in, who will be reported),
 * `vol` (Vera, who reports), and two children with every consent on. The thread is open.
 */
async function world(opts: { venue?: boolean } = {}) {
  const org = await adult("Orla");
  const coach = await adult("Colm");
  const acc = await adult("Alan");
  const vol = await adult("Vera");
  const grp = await createGroup(org.id, { name: `Restricted juniors ${n}`, sport });
  if (!grp.ok) throw new Error(grp.error);
  const g = grp.group.id;
  await markYouthGroup(org.id, g);
  for (const [u, role, declaredRole] of [[coach, "supervisor", "coach"], [acc, "adult", "volunteer"], [vol, "adult", "parent"]] as const) {
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
  if (opts.venue !== false) {
    expect(await requestVenue(org.id, g, venues[0].id)).toMatchObject({ ok: true });
    expect(await staffAnswerVenue(managerA, g, true)).toMatchObject({ ok: true });
  }
  /** Vera reports Alan's message: Alan is restricted at once, protectively. */
  const report = async (reporter: User = vol, messageId = accMsg) => {
    const r = await reportMessage(reporter.id, "group", g, { messageId, reason: "abuse" });
    if (!r.ok) throw new Error(`report: ${r.error}`);
    return ((await getDb().prepare("SELECT id FROM player_message_reports WHERE context_id = ? AND message_id = ? AND reporter_id = ?").get(g, messageId, reporter.id)) as { id: number }).id;
  };
  return { org, coach, acc, vol, g, a, b, say, accMsg, volMsg, report };
}

const call = (url: string, method: string, cookie: string | null, body?: unknown) =>
  new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.7.${Math.floor(++ip / 250) % 250}.${(ip % 250) + 1}`, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const reply = async (res: Response) => ({ status: res.status, body: ((await res.json().catch(() => null)) ?? {}) as Record<string, any> });
const mailTo = async (email: string) =>
  (await getDb().prepare("SELECT id, kind, subject, body FROM messages WHERE recipient = ? ORDER BY id").all(email)) as { id: number; kind: string; subject: string; body: string }[];
const allMail = async () => (await getDb().prepare("SELECT id, kind, recipient, subject, body FROM messages ORDER BY id").all()) as { id: number; kind: string; recipient: string; subject: string; body: string }[];
const actionsOf = async (reportId: number) =>
  (await getDb().prepare("SELECT action, actor_name, detail FROM youth_report_actions WHERE report_id = ? ORDER BY id").all(reportId)) as { action: string; actor_name: string; detail: string | null }[];
const muteOf = async (reportId: number) =>
  (await getDb().prepare("SELECT * FROM youth_thread_mutes WHERE report_id = ? ORDER BY id DESC LIMIT 1").get(reportId)) as Record<string, string | null> | undefined;
const exists = async (sql: string, ...args: unknown[]) => Boolean(await getDb().prepare(sql).get(...args));

beforeAll(async () => {
  venues = (await listVenues()).filter((v) => v.courts.length > 0);
  sport = ((await getDb().prepare("SELECT sport FROM courts WHERE id = ?").get(venues[0].courts[0].id)) as { sport: Sport }).sport;
  const mk = async (name: string, email: string, venueId: number | null, role?: "desk") => {
    const r = await createAdmin({ name, email, password: "a-staff-password-1", venueId, role });
    if (!r.ok) throw new Error(r.error);
    return r.admin;
  };
  managerA = await mk("Mia Manager", "mia@restrict.test", venues[0].id);
  managerA2 = await mk("Max Manager", "max@restrict.test", venues[0].id);
  managerB = await mk("Ben Manager", "ben@restrict.test", venues[1].id);
  owner = await mk("Olive Owner", "olive@restrict.test", null);
  const desk = await mk("Dee Desk", "dee@restrict.test", venues[0].id, "desk");
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.id)).token}`;
}, 120_000);

afterEach(() => {
  delete env.SAFEGUARDING_EVIDENCE_RETENTION_DAYS;
  delete env.SAFEGUARDING_REVIEW_MONTHS;
  delete env.YOUTH_PROTECTIVE_REVIEW_DAYS;
});

describe("a restriction on an adult: protective, or a decision", () => {
  it("is protective when a report places it, with a date to be reviewed by, and not a finding in any word it uses", async () => {
    const w = await world();
    const id = await w.report();
    const mute = await muteOf(id);
    expect(mute).toMatchObject({ kind: "protective", source: "report", decision_outcome: null });
    expect(await exists("SELECT 1 FROM youth_thread_mutes WHERE report_id = ? AND review_by > datetime('now', '+6 days') AND review_by <= datetime('now', '+8 days')", id)).toBe(true);
    const seen = await caseView(managerA, id);
    if (!seen.ok) throw new Error(seen.error);
    expect(seen.case.restriction).toMatchObject({ kind: "protective", ageDays: 0, overdue: false, decision: null });
    expect(seen.case.restriction?.reviewBy).toBeTruthy();
    // What the restricted adult is told says nothing of a report, and is not a finding.
    const view = await threadView(w.acc.id, "group", w.g);
    expect(view).toMatchObject({ ok: true, view: { whyNot: "PM_ACCESS_PAUSED" } });
    const sent = await sendMessage(w.acc.id, "group", w.g, "may I?");
    expect(sent).toMatchObject({ ok: false, code: "PM_ACCESS_PAUSED", error: "Your access to this conversation is paused while the venue reviews it. This is not a finding." });
    // The period is operational and can be set.
    env.YOUTH_PROTECTIVE_REVIEW_DAYS = "3";
    const second = await world();
    const id2 = await second.report();
    expect(await exists("SELECT 1 FROM youth_thread_mutes WHERE report_id = ? AND review_by > datetime('now', '+2 days') AND review_by <= datetime('now', '+4 days')", id2)).toBe(true);
  });

  it("becomes a moderator's recorded decision with its reason, worded differently, never presenting an allegation as proven", async () => {
    const w = await world();
    const id = await w.report();
    expect(await caseStep(managerA, id, { step: "decide", outcome: "everything", reason: "Because" })).toMatchObject({ ok: false });
    expect(await caseStep(managerA, id, { step: "decide", outcome: "messaging_suspended", reason: "" })).toMatchObject({ ok: false });
    expect(await caseStep(managerA, id, { step: "decide", outcome: "messaging_suspended", reason: "Pending the venue's own inquiry" })).toMatchObject({ ok: true });
    expect(await caseStep(managerA, id, { step: "decide", outcome: "removed_from_group", reason: "Again" })).toMatchObject({ ok: false, error: "A decision has already been recorded for this restriction." });
    expect(await muteOf(id)).toMatchObject({ kind: "decision", decision_outcome: "messaging_suspended", decision_reason: "Pending the venue's own inquiry", decided_by: "Mia Manager", review_by: null });
    const seen = await caseView(managerA, id);
    if (!seen.ok) throw new Error(seen.error);
    expect(seen.case.restriction).toMatchObject({ kind: "decision", reviewBy: null, overdue: false, decision: { outcome: "messaging_suspended", by: "Mia Manager" } });
    // What the person sees is worded differently (a review has changed their access) and still says nothing of why.
    const view = await threadView(w.acc.id, "group", w.g);
    expect(view).toMatchObject({ ok: true, view: { whyNot: "PM_ACCESS_DECIDED", messages: [], people: 0 } });
    const sent = await sendMessage(w.acc.id, "group", w.g, "may I?");
    expect(sent).toMatchObject({ ok: false, code: "PM_ACCESS_DECIDED", status: 403 });
    if (sent.ok) throw new Error("sent");
    expect(sent.error).not.toMatch(/report|alleg|abuse|guilt|proven|finding/i);
    // It is a decision the moderator may still lift; it does not become anything by itself.
    expect(await caseStep(managerA, id, { step: "lift", reason: "Reviewed again" })).toMatchObject({ ok: true });
    expect(await sendMessage(w.acc.id, "group", w.g, "thank you")).toMatchObject({ ok: true });
  });

  it("is recorded for a reported adult only", async () => {
    const w = await world();
    // Reporting a child's message makes the child the reported one: a decision is recorded for a reported adult only.
    const kidMsg = await w.say(w.a.kid, "I like the juniors");
    const reportOnKid = await w.report(w.vol, kidMsg);
    expect(await caseStep(managerA, reportOnKid, { step: "decide", outcome: "messaging_suspended", reason: "Not for a child" })).toMatchObject({ ok: false, status: 409 });
  });

  it("is reviewed: continuing it with a reason starts the date again, and a restriction past its date is overdue but never changed", async () => {
    const w = await world();
    const id = await w.report();
    await getDb().prepare("UPDATE youth_thread_mutes SET review_by = datetime('now', '-1 days') WHERE report_id = ?").run(id);
    const late = await caseView(managerA, id);
    if (!late.ok) throw new Error(late.error);
    expect(late.case.restriction).toMatchObject({ overdue: true });
    expect(await caseStep(managerA, id, { step: "confirm", reason: "" })).toMatchObject({ ok: false });
    expect(await caseStep(managerA, id, { step: "confirm", reason: "Still needs the venue's inquiry" })).toMatchObject({ ok: true });
    const after = await caseView(managerA, id);
    if (!after.ok) throw new Error(after.error);
    expect(after.case.restriction).toMatchObject({ overdue: false, kind: "protective" });
    expect(await muteOf(id)).toMatchObject({ last_reviewed_by: "Mia Manager", overdue_notified_at: null });
    // Extending it is a review too.
    await getDb().prepare("UPDATE youth_thread_mutes SET review_by = datetime('now', '-1 days') WHERE report_id = ?").run(id);
    expect(await caseStep(managerA, id, { step: "extend", reason: "Keep it" })).toMatchObject({ ok: true });
    expect(await exists("SELECT 1 FROM youth_thread_mutes WHERE report_id = ? AND review_by > datetime('now', '+6 days')", id)).toBe(true);
  });
});

describe("no restriction goes unreviewed for ever", () => {
  it("escalates a restriction past its review date to the platform's owner, repeats at the interval, and never lifts or converts it", async () => {
    const w = await world();
    const id = await w.report();
    const groupName = ((await getDb().prepare("SELECT name FROM community_groups WHERE id = ?").get(w.g)) as { name: string }).name;
    const owners = async () => (await mailTo(owner.email)).filter((m) => m.kind === "safeguarding_notice" && m.subject.includes(groupName) && /review date/.test(m.subject));
    expect(await restrictionHousekeeping()).toBe(0);
    expect(await owners()).toHaveLength(0);
    await getDb().prepare("UPDATE youth_thread_mutes SET review_by = datetime('now', '-1 days') WHERE report_id = ?").run(id);
    expect(await restrictionHousekeeping()).toBe(1);
    expect(await owners()).toHaveLength(1);
    expect((await owners())[0].body).not.toMatch(/Vera|Alan|says hello/);
    // Told once, not every minute; still in force and still protective: nothing was lifted or converted.
    expect(await restrictionHousekeeping()).toBe(0);
    expect(await muteOf(id)).toMatchObject({ lifted_at: null, kind: "protective", source: "report" });
    expect((await actionsOf(id)).map((a) => a.action)).toContain("review_overdue");
    // The needs-attention line is the owner's, not a manager's, and it is there until somebody reviews.
    expect((await safeguardingAttention(owner)).overdue.map((o) => o.reportId)).toContain(id);
    expect((await safeguardingAttention(managerA)).overdue).toEqual([]);
    // Repeated at the review interval.
    await getDb().prepare("UPDATE youth_thread_mutes SET overdue_notified_at = datetime('now', '-8 days') WHERE report_id = ?").run(id);
    expect(await restrictionHousekeeping()).toBe(1);
    expect(await owners()).toHaveLength(2);
    // A review resets it: no longer overdue, no longer on the owner's list.
    expect(await caseStep(managerA, id, { step: "confirm", reason: "Looked at it" })).toMatchObject({ ok: true });
    expect((await safeguardingAttention(owner)).overdue.map((o) => o.reportId)).not.toContain(id);
    expect(await restrictionHousekeeping()).toBe(0);
  });

  it("closes a request for a review whose restriction was lifted another way, on the scheduler's next tick", async () => {
    const w = await world();
    const id = await w.report();
    expect(await askForReview(w.acc.id, w.g, "Please look again")).toMatchObject({ ok: true });
    expect(await caseStep(managerA, id, { step: "lift", reason: "Cleared on review" })).toMatchObject({ ok: true });
    expect((await youthHousekeeping()).overdue).toBe(0);
    expect(await myReviewState(w.acc.id, w.g)).toMatchObject({ state: "decided", outcome: "lifted" });
  });
});

describe("a request for a review from the neutral line", () => {
  it("is possible for any restricted adult, reveals nothing, and is refused as a missing group is to anybody else", async () => {
    const w = await world();
    const id = await w.report();
    const stranger = await adult("Sam");
    expect(await askForReview(stranger.id, w.g, "hello")).toMatchObject({ ok: false, code: "YG_NOT_FOUND", status: 404 });
    expect(await askForReview(w.vol.id, w.g, "hello")).toMatchObject({ ok: false, code: "YG_NOT_FOUND" });
    expect(await askForReview(w.a.kid.id, w.g, "hello")).toMatchObject({ ok: false, code: "YG_NOT_FOUND" });
    expect(await askForReview(stranger.id, 987_654, "hello")).toEqual(await askForReview(stranger.id, w.g, "hello"));
    expect(await myReviewState(w.acc.id, w.g)).toEqual({ state: "none", outcome: null, text: null });
    const asked = await askForReview(w.acc.id, w.g, "I would like this looked at again");
    expect(asked).toEqual({ ok: true, state: "received" });
    expect(await askForReview(w.acc.id, w.g, "again")).toMatchObject({ ok: false, code: "YG_APPEAL_DUP", status: 409 });
    expect(await myReviewState(w.acc.id, w.g)).toEqual({ state: "received", outcome: null, text: null });
    // The same for a supervisor's pause: nothing tells the one cause from the other.
    expect(await muteSender(w.org.id, w.g, w.volMsg, "Needs a break")).toMatchObject({ ok: true });
    expect(await askForReview(w.vol.id, w.g, "Please")).toEqual(asked);
    // It is recorded in the case and the group's record, and the people who may decide are told one waits (a place and a number, nothing of why).
    expect((await actionsOf(id)).map((a) => a.action)).toContain("review_requested");
    const waiting = (await mailTo(managerA.email)).filter((m) => m.kind === "safeguarding_notice" && /request for a review/.test(m.subject));
    expect(waiting.length).toBeGreaterThan(0);
    expect(waiting.map((m) => m.body).join("\n")).not.toMatch(/Vera|Alan|says hello|abuse/);
  });

  it("goes to somebody who did not apply the restriction: a different manager, else the platform's owner, and it is decided with a reason and recorded", async () => {
    const w = await world();
    const id = await w.report();
    // Mia keeps the restriction in force: she applied it (extended it).
    expect(await caseStep(managerA, id, { step: "extend", reason: "Keep it while the venue asks" })).toMatchObject({ ok: true });
    expect(await askForReview(w.acc.id, w.g, "Please look at this again")).toMatchObject({ ok: true });
    const ids = (await getDb().prepare("SELECT id FROM youth_restriction_appeals WHERE group_id = ?").all(w.g)) as { id: number }[];
    const appeal = ids[0].id;
    // Not Mia, who applied it; not another venue's manager; not front desk; not the owner while another manager of the venue can.
    expect((await listAppeals(managerA)).map((a) => a.id)).not.toContain(appeal);
    expect(await decideAppeal(managerA, appeal, { outcome: "lifted", reason: "I would like to" })).toMatchObject({ ok: false, code: "YG_REVIEW" });
    expect((await listAppeals(managerB)).map((a) => a.id)).not.toContain(appeal);
    expect((await listAppeals(owner)).map((a) => a.id)).not.toContain(appeal);
    const mine = (await listAppeals(managerA2)).find((a) => a.id === appeal);
    expect(mine).toMatchObject({ groupId: w.g, person: expect.stringMatching(/^Alan/), message: "Please look at this again", restriction: { kind: "protective" }, reportId: id });
    // What a reviewer is shown never says who reported or what was said.
    expect(JSON.stringify(mine)).not.toMatch(/Vera|says hello|abuse/);
    const route = await import("../src/app/api/admin/message-moderation/route");
    const desk = await reply(await route.GET(call("http://localhost/api/admin/message-moderation?appeals=1", "GET", deskCookie)));
    expect(desk.status).toBe(403);
    // The decision needs a reason and an outcome, and the words for the person never name the reporter nor repeat what was reported.
    expect(await decideAppeal(managerA2, appeal, { outcome: "continues", reason: "" })).toMatchObject({ ok: false, code: "YG_REASON" });
    expect(await decideAppeal(managerA2, appeal, { outcome: "perhaps", reason: "Because" })).toMatchObject({ ok: false, code: "YG_OUTCOME" });
    expect(await decideAppeal(managerA2, appeal, { outcome: "continues", reason: "Because", text: "Vera made the report about you" })).toMatchObject({ ok: false, code: "YG_APPEAL_TEXT" });
    expect(await decideAppeal(managerA2, appeal, { outcome: "continues", reason: "The venue's inquiry is not finished", text: "Your access stays paused for now." })).toMatchObject({ ok: true });
    expect(await decideAppeal(managerA2, appeal, { outcome: "lifted", reason: "Twice" })).toMatchObject({ ok: false, code: "YG_REVIEW" });
    // They are told the outcome in neutral words, once; nothing else.
    expect(await myReviewState(w.acc.id, w.g)).toEqual({ state: "decided", outcome: "continues", text: "Your access stays paused for now." });
    const told = (await mailTo(w.acc.email)).filter((m) => m.kind === "safeguarding_notice");
    expect(told).toHaveLength(1);
    expect(told[0].body).toContain("the restriction continues");
    expect(told[0].body).not.toMatch(/Vera|says hello|abuse|report/i);
    expect(await exists("SELECT 1 FROM youth_thread_mutes WHERE report_id = ? AND lifted_at IS NULL", id)).toBe(true);
    // It is recorded: who decided, what, and why, in the case and in the group's record.
    expect((await actionsOf(id)).find((a) => a.action === "review_decided")).toMatchObject({ actor_name: "Max Manager", detail: expect.stringContaining("continues: The venue's inquiry is not finished") });
    expect(await exists("SELECT 1 FROM youth_message_events WHERE group_id = ? AND action = 'review_decided'", w.g)).toBe(true);
    // They may ask again; the second request lifted, by the owner once both managers of the venue have applied it: the owner takes it only when nobody else can.
    expect(await askForReview(w.acc.id, w.g, "One more time")).toMatchObject({ ok: true });
    const second = ((await getDb().prepare("SELECT id FROM youth_restriction_appeals WHERE group_id = ? AND status = 'open'").get(w.g)) as { id: number }).id;
    expect(await caseStep(managerA2, id, { step: "extend", reason: "Still reviewing" })).toMatchObject({ ok: true });
    expect((await listAppeals(managerA2)).map((a) => a.id)).not.toContain(second);
    expect((await listAppeals(managerA)).map((a) => a.id)).not.toContain(second);
    expect((await listAppeals(owner)).map((a) => a.id)).toContain(second);
    expect(await decideAppeal(owner, second, { outcome: "lifted", reason: "Reviewed by the owner" })).toMatchObject({ ok: true });
    expect(await sendMessage(w.acc.id, "group", w.g, "thank you")).toMatchObject({ ok: true });
    expect(await myReviewState(w.acc.id, w.g)).toMatchObject({ state: "decided", outcome: "lifted" });
  });

  it("is the owner's for a group with no venue, and answers the routes as it answers the library", async () => {
    const w = await world({ venue: false });
    const id = await w.report();
    expect(await askForReview(w.acc.id, w.g, "Please")).toMatchObject({ ok: true });
    const route = await import("../src/app/api/messages/youth/review/route");
    const dup = await reply(await route.POST(call("http://localhost/api/messages/youth/review", "POST", w.acc.cookie, { groupId: w.g, text: "again" })));
    expect(dup).toMatchObject({ status: 409, body: { code: "YG_APPEAL_DUP" } });
    const state = await reply(await route.GET(call(`http://localhost/api/messages/youth/review?groupId=${w.g}`, "GET", w.acc.cookie)));
    expect(state.body).toEqual({ state: "received", outcome: null, text: null });
    const appeal = ((await getDb().prepare("SELECT id FROM youth_restriction_appeals WHERE group_id = ?").get(w.g)) as { id: number }).id;
    expect((await listAppeals(managerA)).map((a) => a.id)).not.toContain(appeal);
    const adminRoute = await import("../src/app/api/admin/message-moderation/route");
    const ownerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(owner.id)).token}`;
    const list = await reply(await adminRoute.GET(call("http://localhost/api/admin/message-moderation?appeals=1", "GET", ownerCookie)));
    expect(list.body.appeals.map((a: { id: number }) => a.id)).toContain(appeal);
    const decided = await reply(await adminRoute.POST(call("http://localhost/api/admin/message-moderation", "POST", ownerCookie, { action: "appeal", id: appeal, outcome: "lifted", reason: "Nothing found" })));
    expect(decided.status).toBe(200);
    expect(await sendMessage(w.acc.id, "group", w.g, "thank you")).toMatchObject({ ok: true });
    void id;
  });
});

describe("races (on Postgres the locks are real; on PGlite one connection queues the work)", () => {
  it("lets one of two simultaneous requests for a review through, and one of two simultaneous decisions", async () => {
    const w = await world();
    await w.report();
    const asks = await Promise.all([askForReview(w.acc.id, w.g, "One"), askForReview(w.acc.id, w.g, "Two")]);
    expect(asks.filter((a) => a.ok)).toHaveLength(1);
    expect(asks.find((a) => !a.ok)).toMatchObject({ code: "YG_APPEAL_DUP" });
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM youth_restriction_appeals WHERE group_id = ?").get(w.g)) as { n: number }).n).toBe(1);
    const appeal = ((await getDb().prepare("SELECT id FROM youth_restriction_appeals WHERE group_id = ?").get(w.g)) as { id: number }).id;
    // Neither manager applied it (a report placed it): both may decide; one decision stands, one outcome is told.
    const decided = await Promise.all([
      decideAppeal(managerA, appeal, { outcome: "lifted", reason: "Nothing found" }),
      decideAppeal(managerA2, appeal, { outcome: "continues", reason: "Not yet" }),
    ]);
    expect(decided.filter((d) => d.ok)).toHaveLength(1);
    expect(decided.find((d) => !d.ok)).toMatchObject({ code: "YG_REVIEW" });
    const row = (await getDb().prepare("SELECT outcome, decided_by FROM youth_restriction_appeals WHERE id = ?").get(appeal)) as { outcome: string; decided_by: string };
    expect(await exists("SELECT 1 FROM youth_thread_mutes WHERE group_id = ? AND user_id = ? AND lifted_at IS NULL", w.g, w.acc.id)).toBe(row.outcome === "continues");
    expect((await mailTo(w.acc.email)).filter((m) => m.kind === "safeguarding_notice")).toHaveLength(1);
  });

  it("opens one authority review and one overdue notice however many ticks run at once", async () => {
    const w = await world();
    const id = await w.report();
    await getDb().prepare("UPDATE youth_thread_mutes SET review_by = datetime('now', '-1 days') WHERE report_id = ?").run(id);
    const groupName = ((await getDb().prepare("SELECT name FROM community_groups WHERE id = ?").get(w.g)) as { name: string }).name;
    await Promise.all([youthHousekeeping(), youthHousekeeping(), youthHousekeeping()]);
    const told = (await mailTo(owner.email)).filter((m) => m.subject.includes(groupName) && /review date/.test(m.subject));
    expect(told).toHaveLength(1);
  });
});

describe("an escalation for safeguarding", () => {
  it("tells the platform's owner at once, records who, when and why in the case, shows static guidance, and sends nothing to any authority", async () => {
    const w = await world();
    const id = await w.report();
    const groupName = ((await getDb().prepare("SELECT name FROM community_groups WHERE id = ?").get(w.g)) as { name: string }).name;
    const before = (await allMail()).length;
    expect(await caseStep(managerA, id, { step: "safeguarding", kind: "somebody", reason: "Because" })).toMatchObject({ ok: false });
    expect(await caseStep(managerA, id, { step: "safeguarding", kind: "imminent_danger", reason: "" })).toMatchObject({ ok: false });
    expect(await caseStep(managerA, id, { step: "safeguarding", kind: "imminent_danger", reason: "A child said they were frightened" })).toMatchObject({ ok: true });
    // The owner is told at once, by the safeguarding kind, with the group, the kind of escalation and the static guidance, and nothing of the report.
    const told = (await mailTo(owner.email)).filter((m) => m.kind === "safeguarding_notice" && m.subject.includes(groupName) && /escalation/i.test(m.subject));
    expect(told).toHaveLength(1);
    expect(told[0].body).toContain("imminent danger");
    expect(told[0].body).toContain("(999)");
    expect(told[0].body).toContain("pending legal review");
    expect(told[0].body).not.toMatch(/Vera|Alan|says hello|frightened/);
    // Recorded in the case: who, when, why.
    const seen = await caseView(owner, id);
    if (!seen.ok) throw new Error(seen.error);
    expect(seen.case.safeguardingEscalations).toEqual([expect.objectContaining({ by: "Mia Manager", kind: "imminent_danger", reason: "A child said they were frightened" })]);
    expect(seen.case.escalated).toBeTruthy();
    expect((await actionsOf(id)).find((a) => a.action === "safeguarding_escalated")).toMatchObject({ detail: "imminent_danger: A child said they were frightened" });
    expect((await safeguardingAttention(owner)).escalatedCases).toEqual(expect.arrayContaining([expect.objectContaining({ reportId: id, kind: "imminent_danger" })]));
    // Nothing is sent to anybody outside: every message queued since went to a platform owner.
    const sent = (await allMail()).slice(before);
    const ownerEmails = new Set((await getDb().prepare("SELECT email FROM admins WHERE venue_id IS NULL AND business_id IS NULL").all() as { email: string }[]).map((r) => r.email));
    for (const m of sent) expect(ownerEmails.has(m.recipient), `${m.kind} to ${m.recipient}`).toBe(true);
    // The guidance is in every staff language, says what it says and settles nothing.
    for (const locale of ["en", "ms", "zh"] as const) expect(staffTranslator(locale)("msg4.guidance")).toContain("999");
    expect(staffTranslator("en")("msg4.guidance")).toBe(
      "If a child is in immediate danger, contact the emergency services (999) now. Whether and how an incident must be reported to the authorities is pending legal review; follow your own safeguarding policy."
    );
    // The owner may record one too; a member of staff the report names, or another venue, cannot (the case is not there for them).
    expect(await caseStep(owner, id, { step: "safeguarding", kind: "other", reason: "For the record" })).toMatchObject({ ok: true });
    expect(await caseStep(managerB, id, { step: "safeguarding", kind: "other", reason: "Not mine" })).toMatchObject({ ok: false, status: 404 });
  });
});

describe("the reporter's confidentiality, on every new surface", () => {
  it("never reaches the reported adult, an unrelated user, a reviewer, or an owner's notice", async () => {
    const w = await world();
    const id = await w.report();
    const everything: string[] = [];
    const note = (x: unknown) => everything.push(JSON.stringify(x));
    expect(await caseStep(managerA, id, { step: "extend", reason: "Keep it" })).toMatchObject({ ok: true });
    expect(await caseStep(managerA, id, { step: "safeguarding", kind: "suspected_abuse", reason: "Escalated" })).toMatchObject({ ok: true });
    expect(await askForReview(w.acc.id, w.g, "Please")).toMatchObject({ ok: true });
    await getDb().prepare("UPDATE youth_thread_mutes SET review_by = datetime('now', '-2 days') WHERE report_id = ?").run(id);
    await restrictionHousekeeping();
    note((await listAppeals(managerA2)).filter((a) => a.groupId === w.g));
    const appeal = ((await getDb().prepare("SELECT id FROM youth_restriction_appeals WHERE group_id = ?").get(w.g)) as { id: number }).id;
    expect(await decideAppeal(managerA2, appeal, { outcome: "continues", reason: "Not yet", text: "Your access stays as it is for now." })).toMatchObject({ ok: true });
    note(await safeguardingAttention(owner));
    note(await safeguardingAttention(managerA2));
    note(await myReviewState(w.acc.id, w.g));
    note(await threadView(w.acc.id, "group", w.g));
    // Their own export holds the conversation they were a member of, as always, and nothing of a report, a reporter, a restriction's cause or a request's outcome text.
    const exported = JSON.stringify(await messagesExport(w.acc.id));
    expect(exported).not.toMatch(/abuse|report_id|reporter|restriction|Not yet|stays as it is/);
    // What the reported adult could ever see or be sent, and what owners, reviewers and others are shown, holds neither the reporter nor the words.
    for (const text of everything) expect(text).not.toMatch(/Vera|says hello to the juniors/);
    const toAlan = (await mailTo(w.acc.email)).map((m) => `${m.subject} ${m.body}`).join("\n");
    expect(toAlan).not.toMatch(/Vera|says hello|abuse/i);
    const toOwners = (await allMail()).filter((m) => m.recipient === owner.email).map((m) => `${m.subject} ${m.body}`).join("\n");
    // (An owner is told the kind of escalation a moderator chose, "suspected abuse" here: that is the moderator's choice, not the report's reason or words.)
    expect(toOwners).not.toMatch(/Vera|says hello/i);
    // The group's supervisors and the children's guardians are not told of a report about an adult, nor of what followed from it.
    const unrelated = new Set([w.org.email, w.coach.email, w.a.guardian.email, w.b.guardian.email]);
    for (const m of (await allMail()).filter((x) => unrelated.has(x.recipient) && x.kind === "safeguarding_notice")) expect(`${m.subject} ${m.body}`, m.recipient).not.toMatch(/Vera|says hello|Alan/);
  });
});

describe("evidence: four classes, no invented period, no deletion of an active case", () => {
  /** A group that has ended long ago whose thread is old: the ordinary retention timer is due. */
  async function ended(w: Awaited<ReturnType<typeof world>>) {
    expect(await endYouthGroup({ staffName: managerA.name, allowed: true }, w.g, "The season ended")).toMatchObject({ ok: true });
    await getDb().prepare("UPDATE player_message_threads SET ended_at = '2020-01-01 00:00:00' WHERE context_kind = 'group' AND context_id = ?").run(w.g);
  }
  const threadExists = (g: number) => exists("SELECT 1 FROM player_message_threads WHERE context_kind = 'group' AND context_id = ?", g);

  it("skips the thread and the case copy while a report is open or a restriction stands, and resumes only after the case closes", async () => {
    const w = await world();
    const id = await w.report();
    await ended(w);
    await pruneYouthMessages(cutoffFor(60));
    expect(await threadExists(w.g)).toBe(true);
    // Dealt with, but the restriction continues: still active.
    expect(await reviewMessageReport(managerA, id, "restriction_continues")).toMatchObject({ ok: true });
    await pruneYouthMessages(cutoffFor(60));
    expect(await threadExists(w.g)).toBe(true);
    // What a supervisor removed keeps its words while the case is active.
    await getDb().prepare("UPDATE player_messages SET hidden_at = '2020-01-01 00:00:00', hidden_by = 'supervisor' WHERE id = ?").run(w.accMsg);
    await pruneYouthMessages(cutoffFor(60));
    expect(await exists("SELECT 1 FROM player_messages WHERE id = ? AND body IS NOT NULL", w.accMsg)).toBe(true);
    // The restriction lifted: the case is closed, and ordinary retention resumes for the live conversation; the evidence copy stays (class (b)).
    expect(await caseStep(managerA, id, { step: "lift", reason: "Cleared" })).toMatchObject({ ok: true });
    await pruneYouthMessages(cutoffFor(60));
    expect(await threadExists(w.g)).toBe(false);
    expect(await exists("SELECT 1 FROM player_message_reports WHERE id = ?", id)).toBe(true);
    expect(await exists("SELECT 1 FROM player_message_report_lines WHERE report_id = ?", id)).toBe(true);
    expect((await actionsOf(id)).length).toBeGreaterThan(0);
  });

  it("keeps an adults' thread report's retention as it was, and never deletes a youth report's evidence by the ordinary job", async () => {
    const w = await world();
    const youthId = await w.report();
    await reviewMessageReport(managerA, youthId, "no_action");
    await getDb().prepare("UPDATE player_message_reports SET reviewed_at = '2020-01-01 00:00:00' WHERE id = ?").run(youthId);
    // An ordinary (adults') conversation's report.
    const a = await adult("Ada");
    const b = await adult("Bea");
    const grp = await createGroup(a.id, { name: `Plain ${n}`, sport });
    if (!grp.ok) throw new Error(grp.error);
    await join(b, grp.group.id, a);
    const said = await sendMessage(a.id, "group", grp.group.id, "A plain hello");
    if (!said.ok) throw new Error(said.error);
    expect(await reportMessage(b.id, "group", grp.group.id, { messageId: said.message.id, reason: "spam" })).toMatchObject({ ok: true });
    const plainId = ((await getDb().prepare("SELECT id FROM player_message_reports WHERE context_id = ? AND urgent = 0").get(grp.group.id)) as { id: number }).id;
    expect(await reviewMessageReport(owner, plainId, "no_action")).toMatchObject({ ok: true });
    await getDb().prepare("UPDATE player_message_reports SET reviewed_at = '2020-01-01 00:00:00' WHERE id = ?").run(plainId);
    await pruneMessageReports(cutoffFor(365));
    expect(await exists("SELECT 1 FROM player_message_reports WHERE id = ?", plainId)).toBe(false);
    expect(await exists("SELECT 1 FROM player_message_reports WHERE id = ?", youthId)).toBe(true);
    // The retention screen counts the one and not the other.
    const lines = await retentionDue();
    expect(lines.find((l) => /Reports of messages between players/.test(l.what))?.what).toMatch(/ordinary \(adults'\)/);
  });

  it("deletes nothing of the safeguarding evidence or its audit records unless the install sets a period, and only for closed cases when it does", async () => {
    const w = await world();
    const closed = await w.report();
    await caseStep(managerA, closed, { step: "lift", reason: "Cleared" });
    await reviewMessageReport(managerA, closed, "no_action");
    await getDb().prepare("UPDATE player_message_reports SET reviewed_at = '2020-01-01 00:00:00' WHERE id = ?").run(closed);
    await getDb().prepare("INSERT INTO staff_actions (admin_id, admin_name, venue_id, action, detail, created_at) VALUES (NULL, 'Mia Manager', ?, 'messages.youth_authority', 'Guardian link 1', '2020-01-01 00:00:00')").run(venues[0].id);
    await getDb().prepare("INSERT INTO staff_actions (admin_id, admin_name, venue_id, action, detail, created_at) VALUES (NULL, 'Mia Manager', ?, 'messages.report_reviewed', 'Report 1', '2020-01-01 00:00:00')").run(venues[0].id);
    const eventsBefore = ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM youth_message_events WHERE group_id = ?").get(w.g)) as { n: number }).n;
    // Unset: kept, and the screen counts nothing for it.
    expect(safeguardingEvidenceRetentionDays()).toBeNull();
    expect((await retentionDue()).some((l) => /safeguarding cases/.test(l.what))).toBe(false);
    await pruneOldData();
    expect(await exists("SELECT 1 FROM player_message_reports WHERE id = ?", closed)).toBe(true);
    expect((await actionsOf(closed)).length).toBeGreaterThan(0);
    expect(await exists("SELECT 1 FROM staff_actions WHERE action = 'messages.youth_authority' AND created_at < '2021-01-01'")).toBe(true);
    expect(await exists("SELECT 1 FROM staff_actions WHERE action = 'messages.report_reviewed' AND created_at < '2021-01-01'")).toBe(false);
    // An invalid period is no period.
    env.SAFEGUARDING_EVIDENCE_RETENTION_DAYS = "5";
    expect(safeguardingEvidenceRetentionDays()).toBeNull();
    expect(await pruneSafeguardingEvidence()).toBe(0);
    // Set: only a closed case older than the period, with no restriction in force and no hold, is deleted, with its case actions; the group's audit stays.
    env.SAFEGUARDING_EVIDENCE_RETENTION_DAYS = "60";
    expect((await retentionDue()).find((l) => /safeguarding cases/.test(l.what))?.affected).toBeGreaterThanOrEqual(1);
    await pruneOldData();
    expect(await exists("SELECT 1 FROM player_message_reports WHERE id = ?", closed)).toBe(false);
    expect(await exists("SELECT 1 FROM player_message_report_lines WHERE report_id = ?", closed)).toBe(false);
    expect((await actionsOf(closed)).length).toBe(0);
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM youth_message_events WHERE group_id = ?").get(w.g)) as { n: number }).n).toBeGreaterThanOrEqual(eventsBefore);
    expect(await exists("SELECT 1 FROM staff_actions WHERE action = 'messages.youth_authority' AND created_at < '2021-01-01'")).toBe(true);
  }, 120_000);

  it("never deletes an open case, one whose restriction stands, or one under a hold, even with a period set", async () => {
    const w = await world();
    const open = await w.report();
    env.SAFEGUARDING_EVIDENCE_RETENTION_DAYS = "30";
    // Open: an old date does not matter.
    await getDb().prepare("UPDATE player_message_reports SET created_at = '2020-01-01 00:00:00' WHERE id = ?").run(open);
    await pruneOldData();
    expect(await exists("SELECT 1 FROM player_message_reports WHERE id = ?", open)).toBe(true);
    // Reviewed, restriction continues: kept.
    await reviewMessageReport(managerA, open, "restriction_continues");
    await getDb().prepare("UPDATE player_message_reports SET reviewed_at = '2020-01-01 00:00:00' WHERE id = ?").run(open);
    await pruneOldData();
    expect(await exists("SELECT 1 FROM player_message_reports WHERE id = ?", open)).toBe(true);
    // Lifted, but a legal hold stands: kept. Released: deleted.
    await caseStep(managerA, open, { step: "lift", reason: "Cleared" });
    const hold = await createHold(owner, { scope: "case", reportId: open, reason: "Preservation asked for", reference: "Letter from the venue's adviser" });
    if (!hold.ok) throw new Error(hold.error);
    await pruneOldData();
    expect(await exists("SELECT 1 FROM player_message_reports WHERE id = ?", open)).toBe(true);
    expect(await releaseHold(owner, hold.id, "Adviser confirmed it can go")).toMatchObject({ ok: true });
    await pruneOldData();
    expect(await exists("SELECT 1 FROM player_message_reports WHERE id = ?", open)).toBe(false);
  }, 120_000);
});

describe("legal holds", () => {
  it("are the platform owner's alone to set, release and review, with a reason and a digit-safe reference, and are audited where a venue cannot read", async () => {
    const w = await world();
    const id = await w.report();
    expect(await createHold(managerA, { scope: "case", reportId: id, reason: "Please keep it" })).toMatchObject({ ok: false, code: "YG_OWNER_ONLY", status: 403 });
    expect(await listHolds(managerA)).toMatchObject({ ok: false, code: "YG_OWNER_ONLY" });
    expect(await releaseHold(managerA, 1, "No")).toMatchObject({ ok: false, code: "YG_OWNER_ONLY" });
    const route = await import("../src/app/api/admin/youth-groups/route");
    const refused = await reply(await route.POST(call("http://localhost/api/admin/youth-groups", "POST", deskCookie, { action: "holdSet", scope: "case", reportId: id, reason: "Please keep it" })));
    expect(refused.status).toBe(403);
    expect(await createHold(owner, { scope: "case", reportId: id, reason: "" })).toMatchObject({ ok: false, code: "YG_REASON" });
    expect(await createHold(owner, { scope: "case", reportId: id, reason: "Please keep it", reference: "Case 2026-123456" })).toMatchObject({ ok: false, code: "YG_HOLD_REF" });
    expect(await createHold(owner, { scope: "case", reportId: id, reason: "Please keep it", reviewOn: "next week" })).toMatchObject({ ok: false, code: "YG_DATE" });
    expect(await createHold(owner, { scope: "case", reportId: 987_654, reason: "Please keep it" })).toMatchObject({ ok: false, code: "YG_HOLD" });
    expect(await createHold(owner, { scope: "everything", reason: "Please keep it" })).toMatchObject({ ok: false, code: "YG_HOLD" });
    const hold = await createHold(owner, { scope: "case", reportId: id, reason: "Preservation asked for", reference: "A letter from the adviser", reviewOn: "2027-01-31" });
    if (!hold.ok) throw new Error(hold.error);
    const listed = await listHolds(owner);
    if (!listed.ok) throw new Error(listed.error);
    expect(listed.holds).toEqual([expect.objectContaining({ id: hold.id, scope: "case", reportId: id, reason: "Preservation asked for", createdBy: "Olive Owner", reviewDue: false })]);
    // Audited in the case's own record and the group's, and in the activity log with no venue (a venue's staff cannot read it).
    expect((await actionsOf(id)).map((a) => a.action)).toContain("hold_set");
    expect(await exists("SELECT 1 FROM youth_message_events WHERE group_id = ? AND action = 'hold_set'", w.g)).toBe(true);
    expect(await exists("SELECT 1 FROM staff_actions WHERE action = 'messages.youth_hold' AND venue_id IS NULL AND admin_name = 'Olive Owner'")).toBe(true);
    expect(await reviewHold(owner, hold.id, "Still needed", "2027-06-30")).toMatchObject({ ok: true });
    expect(await releaseHold(owner, hold.id, "")).toMatchObject({ ok: false, code: "YG_REASON" });
    expect(await releaseHold(owner, hold.id, "No longer needed")).toMatchObject({ ok: true });
    expect(await releaseHold(owner, hold.id, "Twice")).toMatchObject({ ok: false, code: "YG_HOLD" });
    expect((await actionsOf(id)).map((a) => a.action)).toEqual(expect.arrayContaining(["hold_set", "hold_reviewed", "hold_released"]));
  });

  it("keep the held evidence copy through the erasure of the person's account, which is never refused, and through retention; a child and group hold covers the group's reports", async () => {
    const w = await world();
    const id = await w.report();
    expect(await caseStep(managerA, id, { step: "lift", reason: "Cleared" })).toMatchObject({ ok: true });
    await reviewMessageReport(managerA, id, "no_action");
    const linesOf = async (userId: number) =>
      ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM player_message_report_lines WHERE report_id = ? AND sender_id = ? AND body IS NOT NULL").get(id, userId)) as { n: number }).n;
    // A hold on the child and the group covers every report of the group, here Vera's, the reporter's own copy included.
    const kidId = w.a.kid.id;
    const hold = await createHold(owner, { scope: "child_group", groupId: w.g, minorUserId: kidId, reason: "Preservation asked for" });
    if (!hold.ok) throw new Error(hold.error);
    await forgetMessagesOfUser(w.acc.id);
    await forgetMessagesOfUser(w.vol.id);
    expect(await linesOf(w.acc.id)).toBe(1);
    expect(await linesOf(w.vol.id)).toBe(1);
    expect(await exists("SELECT 1 FROM player_message_reports WHERE id = ? AND reporter_label IS NOT NULL AND reported_label IS NOT NULL", id)).toBe(true);
    // The live conversation's own messages are still the person's to erase: the held copy is the evidence copy only.
    expect(await exists("SELECT 1 FROM player_messages WHERE sender_id = ? AND body IS NOT NULL", w.acc.id)).toBe(false);
    // The hold keeps the group's old thread, too.
    await endYouthGroup({ staffName: managerA.name, allowed: true }, w.g, "The season ended");
    await getDb().prepare("UPDATE player_message_threads SET ended_at = '2020-01-01 00:00:00' WHERE context_kind = 'group' AND context_id = ?").run(w.g);
    await pruneYouthMessages(cutoffFor(60));
    expect(await exists("SELECT 1 FROM player_message_threads WHERE context_kind = 'group' AND context_id = ?", w.g)).toBe(true);
    expect(await releaseHold(owner, hold.id, "Done")).toMatchObject({ ok: true });
    await pruneYouthMessages(cutoffFor(60));
    expect(await exists("SELECT 1 FROM player_message_threads WHERE context_kind = 'group' AND context_id = ?", w.g)).toBe(false);
  });
});

describe("the periodic review prompt", () => {
  it("asks the platform's owner to decide about closed cases and holds kept longer than the interval, for a decision and never a deletion", async () => {
    const w = await world();
    const id = await w.report();
    await caseStep(managerA, id, { step: "lift", reason: "Cleared" });
    await reviewMessageReport(managerA, id, "no_action");
    const youngDue = await safeguardingReviewDue();
    expect(youngDue.cases.map((c) => c.reportId)).not.toContain(id);
    await getDb().prepare("UPDATE player_message_reports SET reviewed_at = datetime('now', '-14 months') WHERE id = ?").run(id);
    const hold = await createHold(owner, { scope: "case", reportId: id, reason: "Preservation asked for" });
    if (!hold.ok) throw new Error(hold.error);
    await getDb().prepare("UPDATE youth_evidence_holds SET created_at = datetime('now', '-14 months') WHERE id = ?").run(hold.id);
    // Held evidence is not a "closed case" to be asked about; the hold itself is what is due.
    let due = await safeguardingReviewDue();
    expect(due.cases.map((c) => c.reportId)).not.toContain(id);
    expect(due.holds.map((h) => h.id)).toContain(hold.id);
    expect(await releaseHold(owner, hold.id, "Done")).toMatchObject({ ok: true });
    due = await safeguardingReviewDue();
    expect(due.cases.map((c) => c.reportId)).toContain(id);
    expect(due.months).toBe(12);
    // The owners are asked once, in counts only, then not again for a while; nothing was deleted.
    expect(await tellOwnersReviewDue()).toBe(true);
    expect(await tellOwnersReviewDue()).toBe(false);
    const asked = (await mailTo(owner.email)).filter((m) => m.kind === "safeguarding_notice" && /to decide about/.test(m.subject));
    expect(asked).toHaveLength(1);
    expect(asked[0].body).toMatch(/not a deletion/);
    expect(asked[0].body).not.toMatch(/Alan|Vera|Restricted juniors/);
    expect((await safeguardingAttention(owner)).retention).toMatchObject({ months: 12 });
    expect((await safeguardingAttention(managerA)).retention).toBeNull();
    expect(await exists("SELECT 1 FROM player_message_reports WHERE id = ?", id)).toBe(true);
    // A decision to keep (owner only, with a reason) takes it off the list until the interval has passed again.
    expect(await recordRetentionReview(managerA, id, "Keep")).toMatchObject({ ok: false, code: "YG_OWNER_ONLY" });
    expect(await recordRetentionReview(owner, id, "")).toMatchObject({ ok: false, code: "YG_REASON" });
    expect(await recordRetentionReview(owner, id, "Kept for the venue's own review")).toMatchObject({ ok: true });
    expect((await safeguardingReviewDue()).cases.map((c) => c.reportId)).not.toContain(id);
    expect(await exists("SELECT 1 FROM player_message_reports WHERE id = ?", id)).toBe(true);
    // The interval is the install's to set.
    env.SAFEGUARDING_REVIEW_MONTHS = "24";
    expect((await safeguardingReviewDue()).months).toBe(24);
  });

  it("keeps the audit records append-only: an action or an event is never edited", async () => {
    const w = await world();
    const id = await w.report();
    await caseStep(managerA, id, { step: "note", text: "A note for the record" });
    await expect(getDb().prepare("UPDATE youth_report_actions SET detail = 'changed' WHERE report_id = ?").run(id)).rejects.toThrow(/not edited/);
    await expect(getDb().prepare("UPDATE youth_message_events SET action = 'changed' WHERE group_id = ?").run(w.g)).rejects.toThrow(/not edited/);
    // A foreign key's own SET NULL (an account erased) is not an edit of what was recorded.
    await expect(getDb().prepare("UPDATE youth_message_events SET actor_user_id = NULL WHERE group_id = ?").run(w.g)).resolves.toBeDefined();
    expect((await actionsOf(id)).map((a) => a.action)).toContain("note");
  });
});
