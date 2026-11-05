import fs from "fs";
import path from "path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.YOUTH_QUIET_HOURS = "off";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, type Admin } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { createGroup, decideMember, joinGroup } from "../src/lib/groups";
import { addManaged } from "../src/lib/managed-people";
import { liftSuspension, suspendMessaging } from "../src/lib/message-moderation";
import { reportMessage, saveMessageSettings, sendMessage, threadView } from "../src/lib/messages";
import { acceptInvite, createInvite } from "../src/lib/participants";
import { saveProfile } from "../src/lib/player-profiles";
import { listVenues } from "../src/lib/store";
import type { Sport } from "../src/lib/types";
import { authorityHold, openObjectionOf } from "../src/lib/youth-consent";
import { authorityHousekeeping, closeAuthorityReview, escalateAuthorityReview, listAuthorityReviews } from "../src/lib/youth-authority";
import { youthMessagingEnabled } from "../src/lib/youth-launch";
import {
  guardianBlock, guardianOverview, markYouthGroup, myYouthGroups, requestVenue, setConsent, setMinorOptIn, setSupervisedThreadState, setYouthAdult, youthGroupState, youthSeats,
} from "../src/lib/youth-messages";
import {
  guardianThreadView, listYouthGroupsForStaff, staffAnswerVenue, staffReadYouthThread, staffSafeguardingView, staffSetGuardianAuthority, youthGroupsOverview,
} from "../src/lib/youth-safeguarding";

/**
 * Youth messaging's interim safeguards, prepared for legal review (migration 0294; ADR 0052, which amends ADR 0049 and ADR 0044): the launch switch, and
 * custody and authority as a recorded decision (status, basis, restrictions, the standard label), the authority review that follows a dispute, and the
 * conflict guard on who may decide. Nothing here settles a legal question: the tests hold the software to doing only what it says, as an interim measure.
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
  const made = await registerUser({ name: `${name} Is${n}`, email: email ?? `is${n}@interim.test`, phone: `01390${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await saveProfile(made.user.id, { adult: true });
  const on = await saveMessageSettings(made.user.id, { enabled: true, understood: true });
  if (!on.ok) throw new Error(on.error);
  return { ...made.user, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}

async function join(user: User, groupId: number, org: User): Promise<void> {
  const j = await joinGroup(user.id, groupId);
  if (!j.ok) throw new Error(j.error);
  const row = (await getDb().prepare("SELECT id FROM group_members WHERE group_id = ? AND user_id = ?").get(groupId, user.id)) as { id: number };
  const d = await decideMember(org.id, row.id, "accept");
  if (!d.ok) throw new Error(d.error);
}

/** A marked group with no venue (the organiser a supervisor, one more adult let in), one child with every consent on, and a second guardian who decides. */
async function world(opts: { venue?: boolean } = {}) {
  const org = await adult("Orla");
  const other = await adult("Olly");
  const grp = await createGroup(org.id, { name: `Interim juniors ${n}`, sport });
  if (!grp.ok) throw new Error(grp.error);
  const g = grp.group.id;
  await markYouthGroup(org.id, g);
  await join(other, g, org);
  await setYouthAdult(org.id, g, { memberUserId: other.id, role: "adult", declaredRole: "volunteer" });
  const g1 = await adult("Gia");
  const made = await addManaged(g1.id, { displayName: "Aina Lee", birthYear: 2014, relationship: "parent", authority: true }, g1.name);
  if (!made.ok) throw new Error(made.error);
  const code = await createInvite(g1, made.person.id, "link");
  if (!code.ok) throw new Error(code.error);
  n++;
  const reg = await registerUser({ name: "Aina Lee", email: `ik${n}@interim.test`, phone: `01391${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!reg.ok) throw new Error(reg.error);
  await saveProfile(reg.user.id, { adult: false });
  const linked = await acceptInvite(reg.user, { code: code.code });
  if (!linked.ok) throw new Error(linked.error);
  const kid = reg.user;
  const pid = made.person.id;
  await join(kid, g, org);
  await setMinorOptIn(kid.id, g, true);
  const on = await setConsent(g1.id, pid, g, true);
  if (!on.ok) throw new Error(on.error);
  const g2 = await adult("Gus");
  await getDb().prepare("INSERT INTO participant_guardians (participant_id, user_id, relationship, authority_declared_at, provenance) VALUES (?, ?, 'parent', now(), 'online')").run(pid, g2.id);
  const link = async (u: User) => ((await getDb().prepare("SELECT id FROM participant_guardians WHERE participant_id = ? AND user_id = ?").get(pid, u.id)) as { id: number }).id;
  const seat = async () => (await youthSeats(g)).some((s) => s.userId === kid.id);
  if (opts.venue) {
    expect(await requestVenue(org.id, g, venues[0].id)).toMatchObject({ ok: true });
    expect(await staffAnswerVenue(managerA, g, true)).toMatchObject({ ok: true });
  }
  return { org, other, g, kid, pid, g1, g2, link, seat };
}

const reviewsFor = async (admin: Admin, g: number) => (await listAuthorityReviews(admin)).filter((r) => r.groupId === g);
const reviewCount = async (g: number) => ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM youth_authority_reviews WHERE group_id = ?").get(g)) as { n: number }).n;
const events = async (g: number) =>
  (await getDb().prepare("SELECT actor_kind, action, detail FROM youth_message_events WHERE group_id = ? ORDER BY id").all(g)) as { actor_kind: string; action: string; detail: string | null }[];
const mailTo = async (email: string) =>
  (await getDb().prepare("SELECT kind, subject, body FROM messages WHERE recipient = ? ORDER BY id").all(email)) as { kind: string; subject: string; body: string }[];

const call = (url: string, method: string, cookie: string | null, body?: unknown) =>
  new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.9.${Math.floor(++ip / 250) % 250}.${(ip % 250) + 1}`, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const reply = async (res: Response) => ({ status: res.status, body: ((await res.json().catch(() => null)) ?? {}) as Record<string, any> });

beforeAll(async () => {
  venues = (await listVenues()).filter((v) => v.courts.length > 0);
  sport = ((await getDb().prepare("SELECT sport FROM courts WHERE id = ?").get(venues[0].courts[0].id)) as { sport: Sport }).sport;
  const mk = async (name: string, email: string, venueId: number | null, role?: "desk") => {
    const r = await createAdmin({ name, email, password: "a-staff-password-1", venueId, role });
    if (!r.ok) throw new Error(r.error);
    return r.admin;
  };
  managerA = await mk("Mia Manager", "mia@interim.test", venues[0].id);
  managerA2 = await mk("Max Manager", "max@interim.test", venues[0].id);
  managerB = await mk("Ben Manager", "ben@interim.test", venues[1].id);
  owner = await mk("Olive Owner", "olive@interim.test", null);
  const desk = await mk("Dee Desk", "dee@interim.test", venues[0].id, "desk");
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.id)).token}`;
}, 120_000);

afterEach(() => {
  env.NODE_ENV = "test";
  delete env.YOUTH_MESSAGING_LAUNCH_APPROVED;
  delete env.YOUTH_REVIEW_DAYS;
});

describe("the launch switch", () => {
  it("is off in production unless the install sets YOUTH_MESSAGING_LAUNCH_APPROVED=yes, and on in development and tests", () => {
    expect(youthMessagingEnabled()).toBe(true);
    env.NODE_ENV = "production";
    expect(youthMessagingEnabled()).toBe(false);
    env.YOUTH_MESSAGING_LAUNCH_APPROVED = "true";
    expect(youthMessagingEnabled()).toBe(false);
    env.YOUTH_MESSAGING_LAUNCH_APPROVED = "yes";
    expect(youthMessagingEnabled()).toBe(true);
    env.NODE_ENV = "development";
    delete env.YOUTH_MESSAGING_LAUNCH_APPROVED;
    expect(youthMessagingEnabled()).toBe(true);
  });

  it("when off: no group can be marked, no minor has a seat, no youth thread is read or written, guardians and staff are told plainly, and what is stored is kept", async () => {
    const w = await world();
    const say = await sendMessage(w.org.id, "group", w.g, "Welcome everybody");
    expect(say).toMatchObject({ ok: true });
    const fresh = await adult("Fran");
    const plain = await createGroup(fresh.id, { name: `Plain ${n}`, sport });
    if (!plain.ok) throw new Error(plain.error);
    expect(await seatsOf(w.g)).toBe(3);
    env.NODE_ENV = "production";
    const off = { ok: false, code: "YG_OFF", status: 409, error: "Youth messaging is not enabled on this install: it needs safeguarding and legal approval first." };
    // No group can be marked; no seat anywhere; nothing can be read or written in the thread.
    expect(await markYouthGroup(fresh.id, plain.group.id)).toMatchObject(off);
    expect(await youthSeats(w.g)).toEqual([]);
    expect(await sendMessage(w.org.id, "group", w.g, "Anybody there?")).toMatchObject({ ok: false });
    expect(await threadView(w.org.id, "group", w.g)).toMatchObject({ ok: false });
    expect(await threadView(w.kid.id, "group", w.g)).toMatchObject({ ok: false });
    // The child and the guardian are told plainly; a guardian can still switch it off, never on.
    expect(await myYouthGroups(w.kid.id)).toEqual({ eligible: true, linked: false, groups: [], enabled: false });
    expect(await setMinorOptIn(w.kid.id, w.g, true)).toMatchObject(off);
    expect(await setConsent(w.g1.id, w.pid, w.g, true)).toMatchObject(off);
    expect(await guardianThreadView(w.g1.id, w.pid, w.g)).toMatchObject(off);
    expect(await youthGroupState(w.org.id, w.g)).toMatchObject(off);
    expect(await youthGroupState(w.other.id, w.g)).toMatchObject({ ok: false, code: "YG_NOT_FOUND" });
    expect(await setSupervisedThreadState(w.org.id, w.g, "muted", "Pause")).toMatchObject(off);
    expect(await setYouthAdult(w.org.id, w.g, { memberUserId: w.other.id, role: "adult", declaredRole: "coach" })).toMatchObject(off);
    expect(await guardianBlock(w.g1.id, w.pid, w.g, w.other.id)).toMatchObject(off);
    expect(await setConsent(w.g1.id, w.pid, w.g, false)).toMatchObject({ ok: true });
    // Staff: stored groups are shown nowhere, and counted so the screen can say so; reading one without an open case says so plainly.
    expect(await youthGroupsOverview(owner)).toMatchObject({ enabled: false, groups: [] });
    expect((await youthGroupsOverview(owner)).hidden).toBeGreaterThanOrEqual(1);
    expect(await listYouthGroupsForStaff(owner)).toEqual([]);
    expect(await staffReadYouthThread(owner, w.g)).toMatchObject(off);
    // Adults' messaging is unaffected: an ordinary conversation still works.
    const pair = await adultPair();
    expect(await sendMessage(pair.a.id, "group", pair.group, "See you at nine")).toMatchObject({ ok: true });
    // Stored data is kept, and comes back when the switch is on.
    env.NODE_ENV = "test";
    expect(await myYouthGroups(w.kid.id)).toMatchObject({ enabled: true, groups: [{ groupId: w.g }] });
    expect((await getDb().prepare("SELECT COUNT(*)::int AS n FROM player_messages m JOIN player_message_threads t ON t.id = m.thread_id WHERE t.context_id = ? AND t.youth = 1").get(w.g) as { n: number }).n).toBe(1);
  });

  it("lets safeguarding administrators read a group with an open case while off, and nobody else", async () => {
    const w = await world({ venue: true });
    expect(await sendMessage(w.org.id, "group", w.g, "Welcome everybody")).toMatchObject({ ok: true });
    const msg = await sendMessage(w.other.id, "group", w.g, "Hello juniors");
    if (!msg.ok) throw new Error(msg.error);
    expect(await reportMessage(w.org.id, "group", w.g, { messageId: msg.message.id, reason: "abuse" })).toMatchObject({ ok: true });
    env.NODE_ENV = "production";
    expect(await staffReadYouthThread(managerA, w.g)).toMatchObject({ ok: true });
    expect(await youthGroupsOverview(managerA)).toMatchObject({ enabled: false, hidden: 0, groups: [{ groupId: w.g, openReports: 1 }] });
    expect(await staffReadYouthThread(managerB, w.g)).toMatchObject({ ok: false, code: "YG_NOT_FOUND" });
  });

  it("answers the staff route, the guardian's and the organiser's pages plainly (YG_OFF) while off", async () => {
    const w = await world();
    env.NODE_ENV = "production";
    const groups = await import("../src/app/api/groups/[id]/youth/route");
    const ctx = { params: Promise.resolve({ id: String(w.g) }) };
    const state = await reply(await groups.GET(call(`http://localhost/api/groups/${w.g}/youth`, "GET", w.org.cookie), ctx));
    expect(state).toMatchObject({ status: 409, body: { code: "YG_OFF" } });
    const mark = await reply(await groups.POST(call(`http://localhost/api/groups/${w.g}/youth`, "POST", w.org.cookie, { action: "mark" }), ctx));
    expect(mark).toMatchObject({ status: 409, body: { code: "YG_OFF" } });
    const guardians = await import("../src/app/api/my/people/messaging/route");
    const mine = await reply(await guardians.GET(call("http://localhost/api/my/people/messaging", "GET", w.g1.cookie)));
    expect(mine).toMatchObject({ status: 200, body: { enabled: false } });
    const youth = await import("../src/app/api/admin/youth-groups/route");
    const adminCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(owner.id)).token}`;
    const list = await reply(await youth.GET(call("http://localhost/api/admin/youth-groups", "GET", adminCookie)));
    expect(list.body).toMatchObject({ enabled: false, groups: [] });
    expect(list.body.hidden).toBeGreaterThanOrEqual(1);
  });
});

async function seatsOf(g: number): Promise<number> {
  return (await youthSeats(g)).length;
}

/** Two adults in an ordinary community group (not a youth group): a conversation that has nothing to do with youth messaging. */
async function adultPair() {
  const a = await adult("Ada");
  const b = await adult("Bea");
  const grp = await createGroup(a.id, { name: `Ordinary ${n}`, sport });
  if (!grp.ok) throw new Error(grp.error);
  await join(b, grp.group.id, a);
  return { a, b, group: grp.group.id };
}

describe("custody and authority as a recorded decision", () => {
  it("makes an asserted restriction an unclear link, not an effective one: the guardian keeps their say, and messaging for the child stays off", async () => {
    const w = await world();
    const id = await w.link(w.g2);
    expect(await w.seat()).toBe(true);
    const done = await staffSetGuardianAuthority(owner, { guardianshipId: id, restrictions: "no_messaging_say", note: "Told by the other parent" });
    expect(done).toMatchObject({ ok: true, status: "unclear", level: "decides" });
    const row = (await getDb().prepare("SELECT messaging_authority, authority_status, authority_restrictions, authority_basis, authority_standard FROM participant_guardians WHERE id = ?").get(id)) as Record<string, string>;
    expect(row).toEqual({ messaging_authority: "decides", authority_status: "unclear", authority_restrictions: "no_messaging_say", authority_basis: "not_stated", authority_standard: "interim: pending legal review" });
    // The guardian still decides: the restriction did not take effect. But messaging for the child is off, whatever consents exist.
    expect(await setConsent(w.g2.id, w.pid, w.g, true)).toMatchObject({ ok: true });
    expect(await authorityHold(w.kid.id)).toBe(true);
    expect(await w.seat()).toBe(false);
    expect((await guardianOverview(w.g1.id))[0].groups[0]).toMatchObject({ consentOn: false, needsAgreement: true });
  });

  it("converts what a venue had restricted before this (the venue's word) into an asserted restriction that makes the link unclear (migration 0294), and does it once", async () => {
    const w = await world();
    const id = await w.link(w.g2);
    await getDb().prepare("UPDATE participant_guardians SET messaging_authority = 'objects_only', authority_status = 'asserted', authority_restrictions = 'none' WHERE id = ?").run(id);
    const migration = fs.readFileSync(path.join(__dirname, "..", "db", "migrations", "0294_youth_messaging_interim_safeguards.sql"), "utf8");
    const update = migration.match(/UPDATE participant_guardians[\s\S]*?;/)?.[0];
    if (!update) throw new Error("the migration's backfill is not there");
    await getDb().prepare(update).run();
    const row = () => getDb().prepare("SELECT messaging_authority, authority_status, authority_restrictions FROM participant_guardians WHERE id = ?").get(id);
    expect(await row()).toEqual({ messaging_authority: "decides", authority_status: "unclear", authority_restrictions: "may_object_only" });
    expect(await w.seat()).toBe(false);
    // Verified afterwards, it takes effect, and running the statement again changes nothing.
    expect(await staffSetGuardianAuthority(owner, { guardianshipId: id, status: "verified", basis: "parent", restrictions: "may_object_only" })).toMatchObject({ ok: true, level: "objects_only" });
    await getDb().prepare(update).run();
    expect(await row()).toEqual({ messaging_authority: "objects_only", authority_status: "verified", authority_restrictions: "may_object_only" });
  });

  it("applies a verified restriction: a guardian who may only object cannot switch it on; one with no say is refused everywhere", async () => {
    const w = await world();
    const id = await w.link(w.g2);
    expect(await staffSetGuardianAuthority(owner, { guardianshipId: id, status: "verified", basis: "legal_guardian", restrictions: "may_object_only", note: "Seen by the venue" })).toMatchObject({ ok: true, status: "verified", level: "objects_only" });
    expect(await setConsent(w.g2.id, w.pid, w.g, true)).toMatchObject({ ok: false, code: "YG_OBJECTS_ONLY" });
    expect(await authorityHold(w.kid.id)).toBe(false);
    expect(await staffSetGuardianAuthority(owner, { guardianshipId: id, status: "verified", basis: "legal_guardian", restrictions: "no_messaging_say" })).toMatchObject({ ok: true, level: "none" });
    expect(await setConsent(w.g2.id, w.pid, w.g, false)).toMatchObject({ ok: false, code: "YG_NO_SAY" });
    // Verified needs a basis; a status, a basis and a restriction are each a fixed choice.
    expect(await staffSetGuardianAuthority(owner, { guardianshipId: id, status: "verified", basis: "not_stated" })).toMatchObject({ ok: false, code: "YG_AUTH_INPUT" });
    expect(await staffSetGuardianAuthority(owner, { guardianshipId: id, status: "certain" })).toMatchObject({ ok: false, code: "YG_AUTH_INPUT" });
    expect(await staffSetGuardianAuthority(owner, { guardianshipId: id, basis: "court_order" })).toMatchObject({ ok: false, code: "YG_AUTH_INPUT" });
    expect(await staffSetGuardianAuthority(owner, { guardianshipId: id, restrictions: "everything" })).toMatchObject({ ok: false, code: "YG_AUTH_INPUT" });
    expect(await staffSetGuardianAuthority(owner, { guardianshipId: id })).toMatchObject({ ok: false, code: "YG_AUTH_INPUT" });
  });

  it("keeps youth messaging off for a disputed or unclear link, whatever consents exist, while a guardian's objection still counts", async () => {
    const w = await world();
    const id = await w.link(w.g2);
    expect(await setConsent(w.g2.id, w.pid, w.g, true)).toMatchObject({ ok: true });
    expect(await w.seat()).toBe(true);
    expect(await staffSetGuardianAuthority(owner, { guardianshipId: id, status: "disputed", basis: "parent" })).toMatchObject({ ok: true, status: "disputed" });
    expect(await w.seat()).toBe(false);
    expect(await youthSeats(w.g)).toEqual(expect.not.arrayContaining([expect.objectContaining({ userId: w.kid.id })]));
    // The disputed guardian can still switch it off: an objection is recorded at their level.
    expect(await setConsent(w.g2.id, w.pid, w.g, false)).toMatchObject({ ok: true });
    expect(await openObjectionOf(w.g, w.kid.id)).toMatchObject({ guardianId: w.g2.id, level: "decides" });
    // The other guardian's switching on changes nothing while the link is disputed.
    expect(await setConsent(w.g1.id, w.pid, w.g, true)).toMatchObject({ ok: true });
    expect(await w.seat()).toBe(false);
    // The others are told only that it is off and needs agreement: nothing of a dispute.
    const overview = JSON.stringify(await guardianOverview(w.g1.id));
    expect(overview).not.toMatch(/disputed|unclear/i);
    // The authority hold ends only when an authorised operator records a decision that is not disputed or unclear.
    expect(await staffSetGuardianAuthority(owner, { guardianshipId: id, status: "verified", basis: "parent" })).toMatchObject({ ok: true });
    expect(await authorityHold(w.kid.id)).toBe(false);
  });

  it("is recorded by authorised operators only: a venue's manager for a child the venue manages, or the owner, never a supervisor, a guardian or the same person", async () => {
    const w = await world({ venue: true });
    const id = await w.link(w.g2);
    // A venue that only looks after the group may mark a link, never clear it or verify it.
    expect(await staffSetGuardianAuthority(managerA, { guardianshipId: id, status: "verified", basis: "parent" })).toMatchObject({ ok: false, code: "YG_VERIFY", status: 403 });
    expect(await staffSetGuardianAuthority(managerA, { guardianshipId: id, status: "disputed" })).toMatchObject({ ok: true, status: "disputed" });
    expect(await staffSetGuardianAuthority(managerA, { guardianshipId: id, status: "asserted" })).toMatchObject({ ok: false, code: "YG_VERIFY" });
    // A manager of an unrelated venue has no say at all (the answer a missing link gets).
    expect(await staffSetGuardianAuthority(managerB, { guardianshipId: id, status: "verified", basis: "parent" })).toMatchObject({ ok: false, code: "YG_NOT_FOUND" });
    // Staff who are the same person as a guardian of the child, or as a supervisor of the group, are not the ones who decide.
    const asGuardian = await createAdmin({ name: "Gus Staff", email: w.g2.email, password: "staff-password-9", venueId: venues[0].id });
    const asSupervisor = await createAdmin({ name: "Orla Staff", email: w.org.email, password: "staff-password-9", venueId: null });
    if (!asGuardian.ok || !asSupervisor.ok) throw new Error("admins");
    expect(await staffSetGuardianAuthority(asGuardian.admin, { guardianshipId: id, status: "verified", basis: "parent" })).toMatchObject({ ok: false, code: "YG_NOT_FOUND" });
    expect(await staffSetGuardianAuthority(asSupervisor.admin, { guardianshipId: id, status: "verified", basis: "parent" })).toMatchObject({ ok: false, code: "YG_NOT_FOUND" });
    // The owner may.
    expect(await staffSetGuardianAuthority(owner, { guardianshipId: id, status: "verified", basis: "parent" })).toMatchObject({ ok: true, status: "verified" });
    // Front desk is turned away at the route.
    const route = await import("../src/app/api/admin/youth-groups/route");
    const refused = await reply(await route.POST(call("http://localhost/api/admin/youth-groups", "POST", deskCookie, { action: "authority", guardianshipId: id, status: "verified", basis: "parent" })));
    expect(refused.status).toBe(403);
  });

  it("is audited with who, status, basis, restrictions, the standard label and when, only for safeguarding administrators, and takes no document or identity number", async () => {
    const w = await world({ venue: true });
    const id = await w.link(w.g2);
    expect(await staffSetGuardianAuthority(owner, { guardianshipId: id, status: "verified", basis: "legal_guardian", restrictions: "may_object_only", note: "Held by the venue, ref in the file" })).toMatchObject({ ok: true });
    const ev = (await events(w.g)).filter((e) => e.action === "authority_decided");
    expect(ev).toEqual([expect.objectContaining({ actor_kind: "staff", detail: `guardian ${w.g2.id}: asserted to verified; basis legal_guardian; restrictions may_object_only; interim: pending legal review` })]);
    const logged = (await getDb().prepare("SELECT detail FROM staff_actions WHERE action = 'messages.youth_authority' ORDER BY id DESC LIMIT 1").get()) as { detail: string };
    expect(logged.detail).toContain("verified");
    const view = await staffSafeguardingView(managerA, w.g);
    if (!view.ok) throw new Error(view.error);
    expect(view.children[0].guardians.find((g) => g.name.startsWith("Gus"))).toMatchObject({ status: "verified", basis: "legal_guardian", restrictions: "may_object_only", standard: "interim: pending legal review", setBy: "Olive Owner" });
    // Not visible to a guardian, a supervisor, or any member: the view is staff-only and refuses the guardian-staff and other venues.
    expect(await staffSafeguardingView(managerB, w.g)).toMatchObject({ ok: false, code: "YG_NOT_FOUND" });
    expect(JSON.stringify([await guardianOverview(w.g1.id), await guardianOverview(w.g2.id), await youthGroupState(w.org.id, w.g)])).not.toMatch(/interim: pending|legal_guardian|verified/);
    // No document or identity number: a run of digits is refused in the note.
    expect(await staffSetGuardianAuthority(owner, { guardianshipId: id, status: "verified", basis: "parent", note: "Court order 1234567 seen" })).toMatchObject({ ok: false, code: "YG_NOTE_ID" });
    expect(await staffSetGuardianAuthority(owner, { guardianshipId: id, status: "verified", basis: "parent", note: "IC 900101-14-5566" })).toMatchObject({ ok: false, code: "YG_NOTE_ID" });
  });
});

describe("the authority review", () => {
  it("opens when a link becomes disputed or unclear, for each group the child is in, and is seen only by safeguarding administrators", async () => {
    const w = await world({ venue: true });
    const id = await w.link(w.g2);
    expect(await reviewsFor(managerA, w.g)).toEqual([]);
    expect(await staffSetGuardianAuthority(managerA, { guardianshipId: id, status: "unclear", basis: "other_authorised" })).toMatchObject({ ok: true });
    const seen = await reviewsFor(managerA, w.g);
    expect(seen).toEqual([expect.objectContaining({ groupId: w.g, cause: "unclear", child: expect.stringMatching(/^Aina/), escalated: false })]);
    expect(seen[0].guardians.map((g) => g.status).sort()).toEqual(["asserted", "unclear"]);
    expect((await events(w.g)).map((e) => e.action)).toContain("authority_review_opened");
    // Not seen by another venue, by the child's guardian who is staff, or by a supervisor who is staff; the owner sees only what is escalated.
    expect(await reviewsFor(managerB, w.g)).toEqual([]);
    const asGuardian = await createAdmin({ name: "Gia Staff", email: w.g1.email, password: "staff-password-9", venueId: venues[0].id });
    if (!asGuardian.ok) throw new Error("admin");
    expect(await reviewsFor(asGuardian.admin, w.g)).toEqual([]);
    expect(await reviewsFor(owner, w.g)).toEqual([]);
    expect(await escalateAuthorityReview(managerA, seen[0].id)).toMatchObject({ ok: true });
    expect((await reviewsFor(owner, w.g)).map((r) => r.id)).toEqual([seen[0].id]);
    expect(await escalateAuthorityReview(managerA, seen[0].id)).toMatchObject({ ok: false, code: "YG_ESCALATED" });
    expect(await escalateAuthorityReview(owner, seen[0].id)).toMatchObject({ ok: false, code: "YG_ESCALATED" });
    // The owners are told at once, by the safeguarding kind, with the group and a number only.
    const told = (await mailTo(owner.email)).filter((m) => m.kind === "safeguarding_notice");
    expect(told.length).toBeGreaterThan(0);
    expect(told.at(-1)?.body).toContain(`review ${seen[0].id}`);
    expect(told.at(-1)?.body).not.toMatch(/Aina|Gus|Gia/);
  });

  it("opens after YOUTH_REVIEW_DAYS for a guardian conflict that stays unresolved, and again after a review that remains unclear, never twice at once", async () => {
    const w = await world({ venue: true });
    expect(await setConsent(w.g1.id, w.pid, w.g, false)).toMatchObject({ ok: true });
    await authorityHousekeeping();
    expect(await reviewCount(w.g)).toBe(0);
    await getDb().prepare("UPDATE youth_message_objections SET created_at = datetime('now', '-8 days') WHERE group_id = ? AND closed_at IS NULL").run(w.g);
    await authorityHousekeeping();
    await authorityHousekeeping();
    expect(await reviewCount(w.g)).toBe(1);
    const [review] = await reviewsFor(managerA, w.g);
    expect(review).toMatchObject({ cause: "conflict_unresolved" });
    // It cannot be marked resolved while the conflict waits; "remains unclear" closes it, and it is looked at again only after the interval.
    expect(await closeAuthorityReview(managerA, review.id, "resolved", "Settled")).toMatchObject({ ok: false, code: "YG_REVIEW_OPEN" });
    expect(await closeAuthorityReview(managerA, review.id, "maybe", "x y z")).toMatchObject({ ok: false, code: "YG_OUTCOME" });
    expect(await closeAuthorityReview(managerA, review.id, "remains_unclear", "")).toMatchObject({ ok: false, code: "YG_REASON" });
    expect(await closeAuthorityReview(managerB, review.id, "remains_unclear", "Not mine")).toMatchObject({ ok: false, code: "YG_REVIEW" });
    expect(await closeAuthorityReview(managerA, review.id, "remains_unclear", "Still waiting for the family")).toMatchObject({ ok: true });
    await authorityHousekeeping();
    expect(await reviewCount(w.g)).toBe(1);
    await getDb().prepare("UPDATE youth_authority_reviews SET closed_at = datetime('now', '-8 days') WHERE id = ?").run(review.id);
    await authorityHousekeeping();
    expect(await reviewCount(w.g)).toBe(2);
    // The period is operational and can be set: a shorter one opens it sooner.
    env.YOUTH_REVIEW_DAYS = "1";
    const [again] = await reviewsFor(managerA, w.g);
    expect(await closeAuthorityReview(managerA, again.id, "remains_unclear", "Still waiting")).toMatchObject({ ok: true });
    await getDb().prepare("UPDATE youth_authority_reviews SET closed_at = datetime('now', '-2 days') WHERE id = ?").run(again.id);
    await authorityHousekeeping();
    expect(await reviewCount(w.g)).toBe(3);
  });

  it("is resolved once an authorised operator has recorded a decision that is not disputed or unclear, and the guardians are told nothing of it", async () => {
    const w = await world({ venue: true });
    const id = await w.link(w.g2);
    expect(await staffSetGuardianAuthority(managerA, { guardianshipId: id, status: "disputed" })).toMatchObject({ ok: true });
    const [review] = await reviewsFor(managerA, w.g);
    expect(await closeAuthorityReview(managerA, review.id, "resolved", "Looks fine")).toMatchObject({ ok: false, code: "YG_REVIEW_OPEN" });
    expect(await staffSetGuardianAuthority(owner, { guardianshipId: id, status: "verified", basis: "parent" })).toMatchObject({ ok: true });
    expect(await closeAuthorityReview(managerA, review.id, "resolved", "Verified by the owner")).toMatchObject({ ok: true });
    expect(await reviewsFor(managerA, w.g)).toEqual([]);
    const row = (await getDb().prepare("SELECT outcome, closed_by FROM youth_authority_reviews WHERE id = ?").get(review.id)) as { outcome: string; closed_by: string };
    expect(row).toEqual({ outcome: "resolved", closed_by: "Mia Manager" });
    expect(await mailTo(w.g1.email)).toEqual(expect.not.arrayContaining([expect.objectContaining({ body: expect.stringMatching(/disput|unclear|authority review/i) })]));
    expect(await staffSetGuardianAuthority(managerA2, { guardianshipId: id, status: "verified", basis: "parent" })).toMatchObject({ ok: false, code: "YG_VERIFY" });
  });
});

describe("a security review of the youth module", () => {
  it("does not let a member of staff who a youth report names lift the suspension that report brought about, by number or otherwise", async () => {
    const w = await world({ venue: true });
    // A member of staff at the venue who is also an adult in the group, and the person a report names.
    const accused = await adult("Alan", "alan.staff@interim.test");
    await join(accused, w.g, w.org);
    expect(await setYouthAdult(w.org.id, w.g, { memberUserId: accused.id, role: "adult", declaredRole: "volunteer" })).toMatchObject({ ok: true });
    const staff = await createAdmin({ name: "Alan Staff", email: accused.email, password: "staff-password-9", venueId: venues[0].id });
    if (!staff.ok) throw new Error("admin");
    expect(await sendMessage(w.org.id, "group", w.g, "Welcome everybody")).toMatchObject({ ok: true });
    const said = await sendMessage(accused.id, "group", w.g, "Alan says hello");
    if (!said.ok) throw new Error(said.error);
    expect(await reportMessage(w.org.id, "group", w.g, { messageId: said.message.id, reason: "abuse" })).toMatchObject({ ok: true });
    const reportId = ((await getDb().prepare("SELECT id FROM player_message_reports WHERE context_id = ? AND urgent = 1").get(w.g)) as { id: number }).id;
    // A manager of the venue suspends the reported person's messaging with the report in hand.
    const made = await suspendMessaging(managerA, { userId: accused.id, reason: "Pending review", reportId });
    if (!made.ok) throw new Error(made.error);
    // The reported member of staff cannot lift it, whatever number they try: it is not there for them.
    expect(await liftSuspension(staff.admin, made.id, "I would like to be back")).toMatchObject({ ok: false, status: 404 });
    expect(await getDb().prepare("SELECT 1 FROM player_message_suspensions WHERE id = ? AND lifted_at IS NULL").get(made.id)).toBeTruthy();
    // Somebody else may.
    expect(await liftSuspension(managerA2, made.id, "Reviewed")).toMatchObject({ ok: true });
  });

  it("refuses the new write routes to the signed-out, and gives a stranger the answer a missing group gets", async () => {
    const w = await world();
    const route = await import("../src/app/api/messages/youth/review/route");
    expect((await reply(await route.POST(call("http://localhost/api/messages/youth/review", "POST", null, { groupId: w.g })))).status).toBe(401);
    expect((await reply(await route.GET(call(`http://localhost/api/messages/youth/review?groupId=${w.g}`, "GET", null)))).status).toBe(401);
    const stranger = await adult("Sam");
    const asked = await reply(await route.POST(call("http://localhost/api/messages/youth/review", "POST", stranger.cookie, { groupId: w.g, text: "please" })));
    const missing = await reply(await route.POST(call("http://localhost/api/messages/youth/review", "POST", stranger.cookie, { groupId: 987_654, text: "please" })));
    expect(asked).toEqual(missing);
    expect(asked).toMatchObject({ status: 404, body: { code: "YG_NOT_FOUND" } });
    const state = await reply(await route.GET(call(`http://localhost/api/messages/youth/review?groupId=${w.g}`, "GET", stranger.cookie)));
    expect(state.body).toEqual({ state: "none", outcome: null, text: null });
    // Not a minor either: the same answer.
    const kidAsk = await reply(await route.POST(call("http://localhost/api/messages/youth/review", "POST", `${SESSION_COOKIE}=${(await createSession(w.kid.id)).token}`, { groupId: w.g })));
    expect(kidAsk).toMatchObject({ status: 404, body: { code: "YG_NOT_FOUND" } });
  });
});
