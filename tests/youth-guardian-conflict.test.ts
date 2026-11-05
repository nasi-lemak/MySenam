import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.YOUTH_QUIET_HOURS = "off";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, type Admin } from "../src/lib/admin-auth";
import { registerUser, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { createGroup, decideMember, joinGroup } from "../src/lib/groups";
import { addManaged } from "../src/lib/managed-people";
import { saveMessageSettings, sendMessage } from "../src/lib/messages";
import { acceptInvite, createInvite } from "../src/lib/participants";
import { saveProfile } from "../src/lib/player-profiles";
import { listVenues } from "../src/lib/store";
import type { Sport } from "../src/lib/types";
import { lockConsentState, openObjectionOf } from "../src/lib/youth-consent";
import {
  guardianBlock, guardianOverview, markYouthGroup, myYouthGroups, requestVenue, setConsent, setGuardianNoticeMode, setMinorOptIn, setYouthAdult, switchOffAll, youthGroupState, youthSeats,
} from "../src/lib/youth-messages";
import {
  guardianThreadView, listYouthGroupsForStaff, staffAnswerVenue, staffResolveObjection, staffSafeguardingView, staffSetGuardianAuthority, youthExportForGuardian,
} from "../src/lib/youth-safeguarding";

/**
 * Guardians in conflict (lib/youth-consent.ts, lib/youth-messages.ts, lib/youth-safeguarding.ts, migration 0291; ADR 0049, which amends ADR 0044):
 * authority per guardian link (`decides`, `objects_only`, `none`), an objection that no other guardian can reverse on their own, restoring by every
 * guardian who decides or by a safeguarding administrator with a reason, minimal disclosure, an audit trail, and races between simultaneous
 * consent changes (on PGlite one connection queues the work; on Postgres, `TEST_DATABASE_URL`, the locks are real).
 */

let n = 0;
let sport: Sport;
let venues: Awaited<ReturnType<typeof listVenues>>;
let owner: Admin;
let managerA: Admin;
let managerB: Admin;
let deskCookie: string;

async function adult(name = "Alex"): Promise<User> {
  n++;
  const made = await registerUser({ name: `${name} Gc${n}`, email: `gc${n}@conflict.test`, phone: `01380${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await saveProfile(made.user.id, { adult: true });
  const on = await saveMessageSettings(made.user.id, { enabled: true, understood: true });
  if (!on.ok) throw new Error(on.error);
  return made.user;
}

async function join(user: User, groupId: number, org: User): Promise<void> {
  const j = await joinGroup(user.id, groupId);
  if (!j.ok) throw new Error(j.error);
  const row = (await getDb().prepare("SELECT id FROM group_members WHERE group_id = ? AND user_id = ?").get(groupId, user.id)) as { id: number };
  const d = await decideMember(org.id, row.id, "accept");
  if (!d.ok) throw new Error(d.error);
}

/** A marked group (the organiser a supervisor, one more adult let in) with one child with every consent on, and a second guardian who decides. */
async function world() {
  const org = await adult("Orla");
  const other = await adult("Olly");
  const grp = await createGroup(org.id, { name: `Conflict juniors ${n}`, sport });
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
  const reg = await registerUser({ name: "Aina Lee", email: `gk${n}@conflict.test`, phone: `01381${String(n).padStart(5, "0")}`, password: "a long enough password" });
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
  return { org, other, g, kid, pid, g1, g2, link, seat };
}

const events = async (g: number) =>
  (await getDb().prepare("SELECT actor_kind, action, detail, actor_user_id FROM youth_message_events WHERE group_id = ? ORDER BY id").all(g)) as { actor_kind: string; action: string; detail: string | null; actor_user_id: number | null }[];

const mailTo = async (email: string) =>
  (await getDb().prepare("SELECT kind, subject, body, params FROM messages WHERE recipient = ? ORDER BY id").all(email)) as { kind: string; subject: string; body: string; params: string }[];

beforeAll(async () => {
  venues = (await listVenues()).filter((v) => v.courts.length > 0);
  sport = ((await getDb().prepare("SELECT sport FROM courts WHERE id = ?").get(venues[0].courts[0].id)) as { sport: Sport }).sport;
  const a = await createAdmin({ name: "Mia Manager", email: "mia@conflict.test", password: "manager-pass-1", venueId: venues[0].id });
  const b = await createAdmin({ name: "Ben Manager", email: "ben@conflict.test", password: "manager-pass-2", venueId: venues[1].id });
  const d = await createAdmin({ name: "Dee Desk", email: "dee@conflict.test", password: "desk-password-1", venueId: venues[0].id, role: "desk" });
  const o = await createAdmin({ name: "Olive Owner", email: "olive@conflict.test", password: "owner-password-1", venueId: null });
  if (!a.ok || !b.ok || !d.ok || !o.ok) throw new Error("admins");
  managerA = a.admin;
  managerB = b.admin;
  owner = o.admin;
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(d.admin.id)).token}`;
}, 120_000);

describe("authority per guardian link", () => {
  it("is `decides` for every link that exists; a guardian who decides switches messaging off and on", async () => {
    const { g, pid, g1, g2, seat } = await world();
    const levels = (await getDb().prepare("SELECT messaging_authority FROM participant_guardians WHERE participant_id = ?").all(pid)) as { messaging_authority: string }[];
    expect(levels.map((l) => l.messaging_authority)).toEqual(["decides", "decides"]);
    expect(await seat()).toBe(true);
    expect(await setConsent(g2.id, pid, g, true)).toMatchObject({ ok: true });
    expect(await setConsent(g1.id, pid, g, false)).toMatchObject({ ok: true });
    expect(await seat()).toBe(false);
  });

  it("lets a guardian who may only object switch messaging off, never on, and never counts them towards restoring it", async () => {
    const { g, pid, g1, g2, link, seat } = await world();
    expect(await staffSetGuardianAuthority(owner, { guardianshipId: await link(g2), level: "objects_only", status: "verified", basis: "legal_guardian", note: "Shown a contact order, 3 Nov" })).toMatchObject({ ok: true });
    expect(await setConsent(g2.id, pid, g, true)).toMatchObject({ ok: false, code: "YG_OBJECTS_ONLY", status: 403 });
    // They can object: messaging goes off, and one open objection is recorded at their level.
    expect(await setConsent(g2.id, pid, g, false)).toMatchObject({ ok: true });
    expect(await seat()).toBe(false);
    const kid = ((await getDb().prepare("SELECT linked_user_id FROM participants WHERE id = ?").get(pid)) as { linked_user_id: number }).linked_user_id;
    expect(await openObjectionOf(g, kid)).toMatchObject({ level: "objects_only", guardianId: g2.id });
    // Restoring needs every guardian who decides (here, one): their consent ends the hold; the guardian who only objects is not asked.
    expect(await setConsent(g1.id, pid, g, true)).toMatchObject({ ok: true, restored: true, needsAgreement: false });
    expect(await seat()).toBe(true);
    // Their own consent never counted: a row they could not make.
    expect(await getDb().prepare("SELECT 1 FROM youth_message_consents WHERE guardian_user_id = ?").get(g2.id)).toBeUndefined();
  });

  it("gives a guardian with no say none of it: refused everywhere, shown nothing, told nothing", async () => {
    const { g, pid, g1, g2, link, seat } = await world();
    expect(await staffSetGuardianAuthority(owner, { guardianshipId: await link(g2), level: "none", status: "verified", basis: "legal_guardian", note: "Court-ordered restriction shown to the venue" })).toMatchObject({ ok: true });
    for (const r of [
      await setConsent(g2.id, pid, g, false),
      await setConsent(g2.id, pid, g, true),
      await switchOffAll(g2.id, pid),
      await setGuardianNoticeMode(g2.id, pid, "off"),
      await guardianBlock(g2.id, pid, g, g1.id),
      await guardianThreadView(g2.id, pid, g),
    ])
      expect(r).toMatchObject({ ok: false, code: "YG_NO_SAY", status: 403 });
    expect(await guardianOverview(g2.id)).toEqual([]);
    expect(await youthExportForGuardian(g2.id)).toEqual([]);
    // Nothing changed for the child, and the guardian is not told when the others change anything.
    expect(await seat()).toBe(true);
    const before = (await mailTo(g2.email)).length;
    expect(await setConsent(g1.id, pid, g, false)).toMatchObject({ ok: true });
    expect((await mailTo(g2.email)).length).toBe(before);
    // A guardian who does not decide does not count: the other guardian's own switch-on ends the hold.
    expect(await setConsent(g1.id, pid, g, true)).toMatchObject({ ok: true, restored: true });
    expect(await seat()).toBe(true);
  });

  it("is set by the owner or a manager in scope, with a short note and no identity numbers, and audited", async () => {
    const { org, g, pid, g1, g2, link } = await world();
    const id = await link(g2);
    expect(await staffSetGuardianAuthority(owner, { guardianshipId: id, level: "sometimes" })).toMatchObject({ ok: false, code: "YG_LEVEL" });
    expect(await staffSetGuardianAuthority(owner, { guardianshipId: id, level: "none", note: "IC 900101-14-5566 shown" })).toMatchObject({ ok: false, code: "YG_NOTE_ID" });
    expect(await staffSetGuardianAuthority(owner, { guardianshipId: 987_654, level: "none" })).toMatchObject({ ok: false, code: "YG_NOT_FOUND" });
    // A manager of a venue that has nothing to do with the child or the group has no say; neither has one who is a guardian of the child.
    expect(await staffSetGuardianAuthority(managerA, { guardianshipId: id, level: "none" })).toMatchObject({ ok: false, code: "YG_NOT_FOUND" });
    const mine = await createAdmin({ name: "Gia Staff", email: g1.email, password: "staff-password-9", venueId: null });
    if (!mine.ok) throw new Error("admin");
    expect(await staffSetGuardianAuthority(mine.admin, { guardianshipId: id, level: "none" })).toMatchObject({ ok: false, code: "YG_NOT_FOUND" });
    // A manager whose venue accepted the group may.
    expect(await requestVenue(org.id, g, venues[0].id)).toMatchObject({ ok: true });
    expect(await staffAnswerVenue(managerA, g, true)).toMatchObject({ ok: true });
    // The venue that only looks after the group is not one that manages the child: it may record what it was shown, which is an assertion (and, for a restriction,
    // sets the link to unclear), never a verified decision (ADR 0052).
    expect(await staffSetGuardianAuthority(managerA, { guardianshipId: id, level: "objects_only", status: "verified", basis: "legal_guardian" })).toMatchObject({ ok: false, code: "YG_VERIFY" });
    expect(await staffSetGuardianAuthority(managerA, { guardianshipId: id, level: "objects_only", note: "  Shown a contact order  " })).toMatchObject({ ok: true, status: "unclear", level: "decides" });
    const row = (await getDb().prepare("SELECT messaging_authority, messaging_authority_by, messaging_authority_note, messaging_authority_at, authority_status, authority_restrictions, authority_standard FROM participant_guardians WHERE id = ?").get(id)) as Record<string, string>;
    expect(row).toMatchObject({ messaging_authority: "decides", messaging_authority_by: "Mia Manager", messaging_authority_note: "Shown a contact order", authority_status: "unclear", authority_restrictions: "may_object_only", authority_standard: "interim: pending legal review" });
    expect(row.messaging_authority_at).toBeTruthy();
    const logged = (await getDb().prepare("SELECT action, detail FROM staff_actions WHERE action = 'messages.youth_authority' ORDER BY id DESC LIMIT 1").get()) as { action: string; detail: string };
    expect(logged.detail).toBe(`Guardian link ${id}: status asserted to unclear, restrictions none to may_object_only, basis not_stated`);
    expect(logged.detail).not.toContain("contact order");
    expect((await events(g)).filter((e) => e.action === "authority_decided")).toEqual([
      expect.objectContaining({ actor_kind: "staff", detail: `guardian ${g2.id}: asserted to unclear; basis not_stated; restrictions may_object_only; interim: pending legal review` }),
    ]);
    void pid;
  });
});

describe("an objection", () => {
  it("holds: another guardian switching messaging on cannot reverse it; every guardian who decides has to agree", async () => {
    const { g, pid, g1, g2, seat } = await world();
    expect(await setConsent(g2.id, pid, g, true)).toMatchObject({ ok: true });
    expect(await seat()).toBe(true);
    // One guardian says no: it is off, and an objection is open.
    expect(await setConsent(g1.id, pid, g, false)).toMatchObject({ ok: true, needsAgreement: true });
    expect(await seat()).toBe(false);
    expect((await guardianOverview(g2.id))[0].groups[0]).toMatchObject({ consentOn: false, needsAgreement: true, myConsent: false });
    // The other guardian switching it on records their consent and changes nothing.
    expect(await setConsent(g2.id, pid, g, true)).toMatchObject({ ok: true, restored: false, needsAgreement: true });
    expect(await seat()).toBe(false);
    expect((await guardianOverview(g2.id))[0].groups[0]).toMatchObject({ consentOn: false, needsAgreement: true, myConsent: true });
    // The objector agreeing again is their withdrawal: now every guardian who decides has agreed, and the hold ends.
    expect(await setConsent(g1.id, pid, g, true)).toMatchObject({ ok: true, restored: true, needsAgreement: false });
    expect(await seat()).toBe(true);
    const kid = ((await getDb().prepare("SELECT linked_user_id FROM participants WHERE id = ?").get(pid)) as { linked_user_id: number }).linked_user_id;
    expect(await openObjectionOf(g, kid)).toBeNull();
    const closed = (await getDb().prepare("SELECT close_kind, closed_by FROM youth_message_objections WHERE group_id = ?").get(g)) as { close_kind: string; closed_by: string };
    expect(closed).toEqual({ close_kind: "agreed", closed_by: "guardians" });
  });

  it("is a single hold however many guardians switch messaging off, and is left only when all agree again", async () => {
    const { g, pid, g1, g2, seat } = await world();
    expect(await setConsent(g1.id, pid, g, false)).toMatchObject({ ok: true });
    expect(await setConsent(g2.id, pid, g, false)).toMatchObject({ ok: true });
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM youth_message_objections WHERE group_id = ?").get(g)) as { n: number }).n).toBe(1);
    const kinds = (await events(g)).map((e) => e.action).filter((a) => a.startsWith("objection"));
    expect(kinds).toEqual(["objection_opened", "objection_added"]);
    expect(await setConsent(g1.id, pid, g, true)).toMatchObject({ ok: true, restored: false });
    expect(await seat()).toBe(false);
    expect(await setConsent(g2.id, pid, g, true)).toMatchObject({ ok: true, restored: true });
    expect(await seat()).toBe(true);
  });

  it("is ended by one guardian alone when they are the only one who decides: their own off, then on", async () => {
    const { g, pid, g1, seat } = await world();
    await getDb().prepare("DELETE FROM participant_guardians WHERE participant_id = ? AND user_id <> ?").run(pid, g1.id);
    expect(await setConsent(g1.id, pid, g, false)).toMatchObject({ ok: true });
    expect(await seat()).toBe(false);
    expect(await setConsent(g1.id, pid, g, true)).toMatchObject({ ok: true, restored: true });
    expect(await seat()).toBe(true);
  });

  it("stops counting a guardian who is demoted by the venue, and ends the hold if the rest have agreed", async () => {
    const { g, pid, g1, g2, link, seat } = await world();
    expect(await setConsent(g1.id, pid, g, false)).toMatchObject({ ok: true });
    expect(await setConsent(g1.id, pid, g, true)).toMatchObject({ ok: true, restored: false });
    expect(await seat()).toBe(false);
    // The venue records that the second guardian has no say in messaging: the first guardian's agreement is now every guardian who decides.
    expect(await staffSetGuardianAuthority(owner, { guardianshipId: await link(g2), level: "none", status: "verified", basis: "legal_guardian" })).toMatchObject({ ok: true });
    expect(await seat()).toBe(true);
    expect((await events(g)).map((e) => e.action)).toEqual(expect.arrayContaining(["authority_decided", "objection_agreed"]));
  });

  it("is also opened by switching messaging off everywhere, in each youth group the child is in", async () => {
    const { org, g, kid, pid, g1, g2 } = await world();
    const second = await createGroup(org.id, { name: `Second conflict group ${n}`, sport });
    if (!second.ok) throw new Error(second.error);
    await markYouthGroup(org.id, second.group.id);
    await join(kid, second.group.id, org);
    expect(await switchOffAll(g1.id, pid)).toMatchObject({ ok: true, groups: 1 });
    expect(await openObjectionOf(g, kid.id)).toMatchObject({ guardianId: g1.id });
    expect(await openObjectionOf(second.group.id, kid.id)).toMatchObject({ guardianId: g1.id });
    // The other guardian cannot switch it back on for the child in either group.
    expect(await setConsent(g2.id, pid, g, true)).toMatchObject({ ok: true, needsAgreement: true });
    expect((await youthSeats(g)).some((s) => s.userId === kid.id)).toBe(false);
  });
});

describe("a safeguarding administrator settles a hold", () => {
  async function held() {
    const w = await world();
    expect(await setConsent(w.g1.id, w.pid, w.g, false)).toMatchObject({ ok: true });
    const open = await openObjectionOf(w.g, w.kid.id);
    if (!open) throw new Error("no hold");
    return { ...w, hold: open.id };
  }

  it("is the platform's owner for a group with no venue, with a reason; settling it does not switch messaging on", async () => {
    const { g, pid, g2, hold, seat } = await held();
    expect(await staffResolveObjection(owner, hold, "")).toMatchObject({ ok: false, code: "YG_REASON" });
    expect(await staffResolveObjection(managerA, hold, "Settled with both families")).toMatchObject({ ok: false, code: "YG_NO_HOLD" });
    expect(await staffResolveObjection(owner, 987_654, "Settled with both families")).toMatchObject({ ok: false, code: "YG_NO_HOLD" });
    expect(await staffResolveObjection(owner, hold, "Settled with both families")).toMatchObject({ ok: true });
    // The hold is gone, and the child still has no seat: a guardian who decides has to consent again.
    expect(await openObjectionOf(g, (await getDb().prepare("SELECT linked_user_id FROM participants WHERE id = ?").get(pid) as { linked_user_id: number }).linked_user_id)).toBeNull();
    expect(await seat()).toBe(false);
    expect(await setConsent(g2.id, pid, g, true)).toMatchObject({ ok: true, restored: false, needsAgreement: false });
    expect(await seat()).toBe(true);
    const closed = (await getDb().prepare("SELECT close_kind, closed_by, close_reason FROM youth_message_objections WHERE id = ?").get(hold)) as Record<string, string>;
    expect(closed).toEqual({ close_kind: "admin", closed_by: "Olive Owner", close_reason: "Settled with both families" });
    expect(await staffResolveObjection(owner, hold, "Again")).toMatchObject({ ok: false, code: "YG_NO_HOLD" });
    const logged = (await getDb().prepare("SELECT detail FROM staff_actions WHERE action = 'messages.youth_objection_resolved' ORDER BY id DESC LIMIT 1").get()) as { detail: string };
    expect(logged.detail).toContain(`hold ${hold}`);
    expect((await events(g)).filter((e) => e.action === "objection_resolved")).toHaveLength(1);
  });

  it("is the manager of the accepted venue for its group, never a venue that was not asked", async () => {
    const { org, g, pid, g2, hold } = await held();
    expect(await requestVenue(org.id, g, venues[0].id)).toMatchObject({ ok: true });
    expect(await staffAnswerVenue(managerA, g, true)).toMatchObject({ ok: true });
    expect(await staffResolveObjection(owner, hold, "Not the owner's any more")).toMatchObject({ ok: false, code: "YG_NO_HOLD" });
    expect(await staffResolveObjection(managerB, hold, "Another venue's")).toMatchObject({ ok: false, code: "YG_NO_HOLD" });
    expect(await staffResolveObjection(managerA, hold, "Settled with both families")).toMatchObject({ ok: true });
    expect(await setConsent(g2.id, pid, g, true)).toMatchObject({ ok: true, needsAgreement: false });
  });

  it("is never the child's supervisor or a guardian of the child, even when they are staff too", async () => {
    const { org, g1, g2, hold, g } = await held();
    for (const who of [org, g1, g2]) {
      const staff = await createAdmin({ name: `Staff ${who.name}`, email: who.email, password: "staff-password-9", venueId: null });
      if (!staff.ok) throw new Error(staff.error);
      expect(await staffResolveObjection(staff.admin, hold, "Settled with both families"), who.name).toMatchObject({ ok: false, code: "YG_NO_HOLD" });
      expect(await staffSafeguardingView(staff.admin, g), who.name).toMatchObject({ ok: true, children: [] });
    }
  });

  it("shows who objected, at what level, and each guardian's level and note, only to safeguarding administrators, each reading recorded", async () => {
    const { org, g, g1, g2, link, pid } = await held();
    expect(await staffSetGuardianAuthority(owner, { guardianshipId: await link(g2), level: "objects_only", status: "verified", basis: "legal_guardian", note: "Shown a contact order" })).toMatchObject({ ok: true });
    const view = await staffSafeguardingView(owner, g);
    if (!view.ok) throw new Error(view.error);
    expect(view.children).toHaveLength(1);
    const child = view.children[0];
    expect(child).toMatchObject({ participantId: pid, child: "Aina L.", consentInForce: false, objection: { by: expect.stringContaining("Gia"), level: "decides" } });
    expect(child.guardians.map((x) => [x.name.startsWith("Gus") ? "g2" : "g1", x.authority, x.note])).toEqual([["g1", "decides", null], ["g2", "objects_only", "Shown a contact order"]]);
    // The group's other screens never carry it.
    for (const seen of [await youthGroupState(org.id, g), await listYouthGroupsForStaff(owner), await myYouthGroups((await getDb().prepare("SELECT linked_user_id FROM participants WHERE id = ?").get(pid) as { linked_user_id: number }).linked_user_id), await guardianOverview(g2.id)]) {
      const text = JSON.stringify(seen);
      expect(text).not.toContain("Shown a contact order");
      expect(text).not.toContain(g1.name.split(" ")[0] + " Gc");
    }
    // Another venue's manager, and a venue's manager for a group with no venue, see nothing.
    expect(await staffSafeguardingView(managerA, g)).toMatchObject({ ok: false, code: "YG_NOT_FOUND" });
    expect(await staffSafeguardingView(managerB, g)).toMatchObject({ ok: false, code: "YG_NOT_FOUND" });
    // Each reading is recorded, never with the note.
    const reads = (await getDb().prepare("SELECT detail FROM staff_actions WHERE action = 'messages.youth_safeguarding_viewed'").all()) as { detail: string }[];
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.map((r) => r.detail).join()).not.toContain("contact order");
    expect((await events(g)).filter((e) => e.action === "safeguarding_read").length).toBeGreaterThan(0);
  });

  it("is the manager's route only: front desk is turned away", async () => {
    const { g, hold } = await held();
    const route = await import("../src/app/api/admin/youth-groups/route");
    const req = (method: string, body?: unknown, q = "") =>
      new NextRequest(`http://localhost/api/admin/youth-groups${q}`, { method, headers: { "content-type": "application/json", cookie: deskCookie, "x-forwarded-for": "10.9.9.9" }, body: body === undefined ? undefined : JSON.stringify(body) });
    expect((await route.GET(req("GET", undefined, `?safeguarding=${g}`))).status).toBe(403);
    expect((await route.POST(req("POST", { action: "resolve", objectionId: hold, reason: "Settled with both families" }))).status).toBe(403);
    expect((await route.POST(req("POST", { action: "authority", guardianshipId: 1, level: "none" }))).status).toBe(403);
  });
});

describe("minimal disclosure and the audit trail", () => {
  it("tells the other guardians only that messaging is off and needs agreement from all who decide, never who or why", async () => {
    const { g, pid, g1, g2 } = await world();
    expect(await setConsent(g1.id, pid, g, false)).toMatchObject({ ok: true });
    const told = (await mailTo(g2.email)).filter((m) => m.kind === "safeguarding_notice");
    expect(told.length).toBeGreaterThan(0);
    const text = told.map((m) => m.body + m.subject + m.params).join(" ");
    expect(text).toContain("needs agreement from all guardians who decide");
    expect(text).toContain("Aina L.");
    expect(text).not.toContain(g1.name);
    expect(text).not.toContain(g1.name.split(" ")[0] + " ");
    // The objector is told nothing about the others' side, and an agreement is told as agreement only.
    expect(await setConsent(g2.id, pid, g, true)).toMatchObject({ ok: true });
    expect(await setConsent(g1.id, pid, g, true)).toMatchObject({ ok: true, restored: true });
    const after = (await mailTo(g2.email)).map((m) => m.body).join(" ");
    expect(after).toContain("have all agreed");
  });

  it("shows the child, the supervisors and the group only that messaging is unavailable", async () => {
    const { org, g, kid, pid, g1 } = await world();
    expect(await setConsent(g1.id, pid, g, false)).toMatchObject({ ok: true });
    const mine = await myYouthGroups(kid.id);
    expect(mine.groups[0]).toMatchObject({ guardianOn: false, active: false });
    const text = JSON.stringify([mine, await youthGroupState(org.id, g), await listYouthGroupsForStaff(owner), await youthSeats(g)]);
    expect(text).not.toMatch(/objection/i);
    expect(await sendMessage(kid.id, "group", g, "hello")).toMatchObject({ ok: false, code: "PM_NOT_FOUND" });
  });

  it("keeps who, what, when and the level at the time in the group's record, without any narrative", async () => {
    const { g, pid, g1, g2 } = await world();
    await setConsent(g1.id, pid, g, false);
    await setConsent(g2.id, pid, g, true);
    await setConsent(g1.id, pid, g, true);
    const trail = (await events(g)).filter((e) => e.actor_kind === "guardian" || e.action.startsWith("objection"));
    expect(trail.map((e) => `${e.action}:${e.detail ?? ""}`)).toEqual([
      "consent_on:level decides",
      "objection_opened:level decides",
      "consent_off:level decides",
      "consent_on:level decides",
      "consent_on:level decides",
      "objection_agreed:objection " + ((await getDb().prepare("SELECT id FROM youth_message_objections WHERE group_id = ?").get(g)) as { id: number }).id,
    ]);
    expect(trail.filter((e) => e.actor_user_id !== null).map((e) => e.actor_user_id)).toEqual([g1.id, g1.id, g1.id, g2.id, g1.id]);
  });
});

/** Holds a child's consent lock in a transaction until released, so calls made meanwhile queue behind it in the order they arrive. */
function holding(g: number, minorId: number) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const ready = new Promise<void>((resolve) => (locked = resolve));
  const run = getDb().transaction(async () => {
    await lockConsentState([g], minorId);
    locked();
    await held;
  })();
  return { ready, release, done: run };
}
const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

describe("races between simultaneous consent changes", () => {
  it("a racing on never wins over a concurrent off, in either order of commit", async () => {
    for (const offFirst of [false, true]) {
      const { g, kid, pid, g1, g2, seat } = await world();
      expect(await setConsent(g2.id, pid, g, true)).toMatchObject({ ok: true });
      const lock = holding(g, kid.id);
      await lock.ready;
      const off = () => setConsent(g1.id, pid, g, false);
      const on = () => setConsent(g2.id, pid, g, true);
      const calls: Promise<unknown>[] = [];
      calls.push(offFirst ? off() : on());
      await settle();
      calls.push(offFirst ? on() : off());
      await settle();
      lock.release();
      await lock.done;
      const results = (await Promise.all(calls)) as { ok: boolean }[];
      expect(results.every((r) => r.ok)).toBe(true);
      // The order they committed in is the order of the group's record: both orders happen across the two rounds.
      const order = (await events(g)).filter((e) => e.action === "consent_off" || (e.action === "consent_on" && e.actor_user_id === g2.id)).map((e) => e.action);
      expect(order.slice(-2)).toEqual(offFirst ? ["consent_off", "consent_on"] : ["consent_on", "consent_off"]);
      // Whichever committed first, the child has no seat: the objection is open and the objector has not agreed again.
      expect(await seat()).toBe(false);
      expect(await openObjectionOf(g, kid.id)).not.toBeNull();
      expect(await sendMessage(kid.id, "group", g, "too late")).toMatchObject({ ok: false, code: "PM_NOT_FOUND" });
    }
  }, 120_000);

  it("never keeps a seat after an off, however an on interleaves, round after round", async () => {
    const { g, kid, pid, g1, g2, seat } = await world();
    for (let round = 0; round < 6; round++) {
      await setConsent(g1.id, pid, g, true);
      await setConsent(g2.id, pid, g, true);
      const calls = round % 2 === 0 ? [setConsent(g2.id, pid, g, true), setConsent(g1.id, pid, g, false)] : [setConsent(g1.id, pid, g, false), setConsent(g2.id, pid, g, true)];
      const results = (await Promise.all(calls)) as { ok: boolean }[];
      expect(results.every((r) => r.ok)).toBe(true);
      expect(await seat(), `round ${round}`).toBe(false);
      expect(await openObjectionOf(g, kid.id)).not.toBeNull();
    }
  }, 120_000);

  it("ends two simultaneous switch-ons after an objection in agreement, and two simultaneous switch-offs in one hold", async () => {
    const { g, kid, pid, g1, g2, seat } = await world();
    expect(await setConsent(g1.id, pid, g, false)).toMatchObject({ ok: true });
    const ons = (await Promise.all([setConsent(g1.id, pid, g, true), setConsent(g2.id, pid, g, true)])) as { ok: boolean; restored: boolean }[];
    expect(ons.every((r) => r.ok)).toBe(true);
    expect(ons.filter((r) => r.restored)).toHaveLength(1);
    expect(await seat()).toBe(true);
    const offs = await Promise.all([setConsent(g1.id, pid, g, false), setConsent(g2.id, pid, g, false)]);
    expect(offs.every((r) => r.ok)).toBe(true);
    expect(await seat()).toBe(false);
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM youth_message_objections WHERE group_id = ? AND minor_user_id = ? AND closed_at IS NULL").get(g, kid.id)) as { n: number }).n).toBe(1);
  }, 120_000);

  it("ends an objector's withdrawal that races the other guardian's consent in agreement, whichever commits first", async () => {
    for (const objectorFirst of [true, false]) {
      const { g, kid, pid, g1, g2, seat } = await world();
      expect(await setConsent(g1.id, pid, g, false)).toMatchObject({ ok: true });
      const lock = holding(g, kid.id);
      await lock.ready;
      const calls: Promise<unknown>[] = [];
      calls.push(objectorFirst ? setConsent(g1.id, pid, g, true) : setConsent(g2.id, pid, g, true));
      await settle();
      calls.push(objectorFirst ? setConsent(g2.id, pid, g, true) : setConsent(g1.id, pid, g, true));
      await settle();
      lock.release();
      await lock.done;
      await Promise.all(calls);
      expect(await seat()).toBe(true);
      expect(await openObjectionOf(g, kid.id)).toBeNull();
    }
  }, 120_000);

  it("holds a hold back until a message being written has committed, and a message after it is refused", async () => {
    const { org, g, kid, pid, g1, seat } = await world();
    await sendMessage(org.id, "group", g, "Welcome");
    const db = getDb();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const holdingSend = new Promise<void>((resolve) => (locked = resolve));
    const { lockYouthSeat } = await import("../src/lib/youth-messages");
    const writing = db.transaction(async () => {
      await lockYouthSeat(g, kid.id);
      locked();
      await held;
    })();
    await holdingSend;
    let objected = false;
    const objecting = setConsent(g1.id, pid, g, false).then((r) => {
      objected = true;
      return r;
    });
    await settle(400);
    expect(objected, "the objection must wait for the message being written").toBe(false);
    release();
    await writing;
    expect(await objecting).toMatchObject({ ok: true });
    expect(await seat()).toBe(false);
    expect(await sendMessage(kid.id, "group", g, "after the objection")).toMatchObject({ ok: false, code: "PM_NOT_FOUND" });
  }, 120_000);

  it("serialises a venue's change of level with a guardian's switch-off for the same child", async () => {
    const { g, kid, pid, g1, g2, link, seat } = await world();
    const g2Link = await link(g2);
    const lock = holding(g, kid.id);
    await lock.ready;
    const demote = staffSetGuardianAuthority(owner, { guardianshipId: g2Link, level: "none", status: "verified", basis: "legal_guardian" });
    await settle();
    const off = setConsent(g1.id, pid, g, false);
    await settle();
    lock.release();
    await lock.done;
    expect(await demote).toMatchObject({ ok: true });
    expect(await off).toMatchObject({ ok: true });
    // g2 no longer decides; g1's own off is the only objection, g1 agreeing again is every guardian who decides.
    expect(await seat()).toBe(false);
    expect(await setConsent(g1.id, pid, g, true)).toMatchObject({ ok: true, restored: true });
    expect(await seat()).toBe(true);
  }, 120_000);
});
