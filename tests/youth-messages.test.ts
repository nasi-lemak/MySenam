import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";
// The rest hours are pinned off so a test never depends on the time of day it runs at; the tests of the rest hours set their own.
process.env.YOUTH_QUIET_HOURS = "off";

import { registerUser, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { askToJoin, openGame } from "../src/lib/games";
import { closeGroup, createGroup, decideMember, joinGroup, leaveGroup } from "../src/lib/groups";
import { addManaged } from "../src/lib/managed-people";
import { cutoffFor, forgetMessagesOfUser, messagesExport, pruneYouthMessages } from "../src/lib/message-privacy";
import { LIMITS, YOUTH_LIMITS, contactDetail, myThreads, saveMessageSettings, sendMessage, threadView } from "../src/lib/messages";
import { acceptInvite, createInvite, revokeGuardianship } from "../src/lib/participants";
import { saveProfile } from "../src/lib/player-profiles";
import { region } from "../src/lib/region";
import { createBooking, listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import type { Sport } from "../src/lib/types";
import {
  clockOfMinute, guardianBlock, guardianOverview, installQuietWindow, localMinutes, markYouthGroup, muteSender, myYouthGroups, quietNow, removeMessage,
  setConsent, setGroupQuiet, setGuardianNoticeMode, setMinorOptIn, setSupervisedThreadState, setYouthAdult, switchOffAll, unmute, youthContactPattern, youthSeats,
} from "../src/lib/youth-messages";
import { guardianThreadView } from "../src/lib/youth-safeguarding";

/**
 * Supervised group messaging for eligible minors (lib/youth-messages.ts, lib/messages.ts, migration 0286; ADR 0044): who is an eligible minor
 * (all three consents, read live), never private, supervision and its powers, guardian controls, the rest hours (time zones, daylight saving),
 * stricter limits and a stricter text check, and retention, export and erasure.
 */

let n = 0;
let sport: Sport;
let courtId: number;
let slot = 0;

async function adult(name = "Alex"): Promise<User> {
  n++;
  const made = await registerUser({ name: `${name} Tan${n}`, email: `ym${n}@youth.test`, phone: `01395${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await saveProfile(made.user.id, { adult: true });
  const on = await saveMessageSettings(made.user.id, { enabled: true, understood: true });
  if (!on.ok) throw new Error(on.error);
  return made.user;
}

/** A child: a participant a guardian manages whose own login (a declared-under-18 account) is linked, as the guardian's code allows. */
async function child(guardian: User, name = "Aina Lee"): Promise<{ kid: User; pid: number }> {
  const made = await addManaged(guardian.id, { displayName: name, birthYear: 2014, relationship: "parent", authority: true }, guardian.name);
  if (!made.ok) throw new Error(made.error);
  const code = await createInvite(guardian, made.person.id, "link");
  if (!code.ok) throw new Error(code.error);
  n++;
  const reg = await registerUser({ name, email: `yk${n}@youth.test`, phone: `01396${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!reg.ok) throw new Error(reg.error);
  await saveProfile(reg.user.id, { adult: false });
  const linked = await acceptInvite(reg.user, { code: code.code });
  if (!linked.ok) throw new Error(linked.error);
  return { kid: reg.user, pid: made.person.id };
}

async function groupOf(org: User): Promise<number> {
  const g = await createGroup(org.id, { name: `Junior crowd ${n}`, sport });
  if (!g.ok) throw new Error(g.error);
  return g.group.id;
}

async function join(user: User, groupId: number, org: User): Promise<void> {
  const j = await joinGroup(user.id, groupId);
  if (!j.ok) throw new Error(j.error);
  const row = (await getDb().prepare("SELECT id FROM group_members WHERE group_id = ? AND user_id = ?").get(groupId, user.id)) as { id: number };
  const d = await decideMember(org.id, row.id, "accept");
  if (!d.ok) throw new Error(d.error);
}

/** A marked youth group: the organiser (a supervisor), one more adult let in, and nobody young yet. */
async function youthGroup(): Promise<{ org: User; other: User; g: number }> {
  const org = await adult("Orla");
  const other = await adult("Olly");
  const g = await groupOf(org);
  const marked = await markYouthGroup(org.id, g);
  if (!marked.ok) throw new Error(marked.error);
  await join(other, g, org);
  const let_in = await setYouthAdult(org.id, g, { memberUserId: other.id, role: "adult", declaredRole: "volunteer" });
  if (!let_in.ok) throw new Error(let_in.error);
  return { org, other, g };
}

/** A child in the group with every consent on. */
async function youngMember(org: User, g: number, name = "Aina Lee"): Promise<{ kid: User; pid: number; guardian: User }> {
  const guardian = await adult("Gia");
  const { kid, pid } = await child(guardian, name);
  await join(kid, g, org);
  const a = await setMinorOptIn(kid.id, g, true);
  if (!a.ok) throw new Error(a.error);
  const b = await setConsent(guardian.id, pid, g, true);
  if (!b.ok) throw new Error(b.error);
  return { kid, pid, guardian };
}

const texts = async (u: User, g: number) => {
  const v = await threadView(u.id, "group", g);
  if (!v.ok) throw new Error(v.error);
  return v.view.messages.map((m) => m.body);
};

beforeAll(async () => {
  const v = (await listVenues()).find((x) => x.courts.length > 0)!;
  courtId = v.courts[0].id;
  sport = ((await getDb().prepare("SELECT sport FROM courts WHERE id = ?").get(courtId)) as { sport: Sport }).sport;
});

describe("who is an eligible minor", () => {
  it("needs the group marked, their own opt-in and a live guardian's consent: all three, and none alone", async () => {
    const { org, other, g } = await youthGroup();
    const guardian = await adult("Gia");
    const { kid, pid } = await child(guardian);
    await join(kid, g, org);
    const gone = { ok: false, code: "PM_NOT_FOUND", status: 404 };
    // Nothing yet: a member of the group, and no seat in its conversation.
    expect(await sendMessage(kid.id, "group", g, "hi")).toMatchObject(gone);
    expect(await threadView(kid.id, "group", g)).toMatchObject(gone);
    // Their own opt-in alone is not enough.
    expect(await setMinorOptIn(kid.id, g, true)).toMatchObject({ ok: true });
    expect(await threadView(kid.id, "group", g)).toMatchObject(gone);
    // A guardian's consent alone is not enough either.
    expect(await setMinorOptIn(kid.id, g, false)).toMatchObject({ ok: true });
    expect(await setConsent(guardian.id, pid, g, true)).toMatchObject({ ok: true });
    expect(await threadView(kid.id, "group", g)).toMatchObject(gone);
    // All three: a seat. (Two adults and the child: three who can read it.)
    expect(await setMinorOptIn(kid.id, g, true)).toMatchObject({ ok: true });
    expect((await youthSeats(g)).some((s) => s.userId === kid.id && s.minor === true)).toBe(true);
    expect(await sendMessage(org.id, "group", g, "Welcome to the Sunday group")).toMatchObject({ ok: true });
    expect(await threadView(kid.id, "group", g)).toMatchObject({ ok: true, view: { canSend: true, youth: { role: "minor" } } });
    expect(await sendMessage(kid.id, "group", g, "Hello, I am Aina")).toMatchObject({ ok: true, message: { from: { n: "Aina L." } } });
    expect(await texts(other, g)).toEqual(["Welcome to the Sunday group", "Hello, I am Aina"]);
  });

  it("is off by default and a guardian's switch-off takes effect at once, in one group or everywhere; any live guardian's off wins", async () => {
    const { org, g } = await youthGroup();
    const second = await groupOf(org);
    await markYouthGroup(org.id, second);
    const { kid, pid, guardian } = await youngMember(org, g);
    await join(kid, second, org);
    await setMinorOptIn(kid.id, second, true);
    expect((await guardianOverview(guardian.id))[0].groups.map((x) => [x.groupId, x.consentOn])).toEqual([[g, true], [second, false]]);
    // Everything on for the first group; the second has no consent.
    expect(await sendMessage(org.id, "group", g, "start")).toMatchObject({ ok: true });
    expect(await sendMessage(kid.id, "group", g, "one")).toMatchObject({ ok: true });
    expect(await setConsent(guardian.id, pid, g, false)).toMatchObject({ ok: true });
    expect(await sendMessage(kid.id, "group", g, "two")).toMatchObject({ ok: false, code: "PM_NOT_FOUND" });
    expect(await threadView(kid.id, "group", g)).toMatchObject({ ok: false });
    // On again, then everywhere at once.
    await setConsent(guardian.id, pid, g, true);
    await setConsent(guardian.id, pid, second, true);
    expect(await switchOffAll(guardian.id, pid)).toMatchObject({ ok: true, groups: 2 });
    expect((await youthSeats(g)).some((s) => s.userId === kid.id)).toBe(false);
    expect((await youthSeats(second)).some((s) => s.userId === kid.id)).toBe(false);
    // Off everywhere also took back the child's own opt-in: a guardian turning it on again is not enough on its own.
    await setConsent(guardian.id, pid, g, true);
    expect((await youthSeats(g)).some((s) => s.userId === kid.id)).toBe(false);

    // A second guardian: their off ends the first guardian's consent too.
    const { kid: kid2, pid: pid2, guardian: g1 } = await youngMember(org, g, "Bao Lim");
    const g2 = await adult("Gus");
    await getDb().prepare("INSERT INTO participant_guardians (participant_id, user_id, relationship, authority_declared_at, provenance) VALUES (?, ?, 'parent', now(), 'online')").run(pid2, g2.id);
    expect((await youthSeats(g)).some((s) => s.userId === kid2.id)).toBe(true);
    expect(await setConsent(g2.id, pid2, g, false)).toMatchObject({ ok: true });
    expect((await youthSeats(g)).some((s) => s.userId === kid2.id)).toBe(false);
    // The other guardian was told (immediately, as a safeguarding notice).
    const told = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages WHERE kind = 'safeguarding_notice' AND recipient = ?").get(g1.email)) as { n: number };
    expect(told.n).toBeGreaterThan(0);
  });

  it("ends when the guardian's relationship is revoked, the child leaves the group, the opt-in is withdrawn or the group stops being a youth group", async () => {
    const { org, g } = await youthGroup();
    const a = await youngMember(org, g, "Ana Ong");
    const b = await youngMember(org, g, "Bea Ong");
    const c = await youngMember(org, g, "Cai Ong");
    const d = await youngMember(org, g, "Dan Ong");
    const seats = async () => (await youthSeats(g)).filter((s) => s.minor).map((s) => s.userId);
    expect(await seats()).toEqual([a.kid.id, b.kid.id, c.kid.id, d.kid.id]);
    // A's guardian stops managing them: the consent lapses with the relationship, never copied.
    const rel = (await getDb().prepare("SELECT id FROM participant_guardians WHERE participant_id = ? AND user_id = ?").get(a.pid, a.guardian.id)) as { id: number };
    expect(await revokeGuardianship(rel.id, { userId: a.guardian.id }, "no longer")).toMatchObject({ ok: true });
    expect(await seats()).toEqual([b.kid.id, c.kid.id, d.kid.id]);
    // B leaves the group, C withdraws.
    expect(await leaveGroup(b.kid.id, g)).toMatchObject({ ok: true });
    await setMinorOptIn(c.kid.id, g, false);
    expect(await seats()).toEqual([d.kid.id]);
    // The group stops being a youth group: no seat, the conversation closed for good.
    const { endYouthGroup } = await import("../src/lib/youth-messages");
    await sendMessage(org.id, "group", g, "before the end");
    expect(await endYouthGroup({ userId: org.id }, g, "Winding up the group")).toMatchObject({ ok: true });
    expect(await seats()).toEqual([]);
    expect(await sendMessage(org.id, "group", g, "after")).toMatchObject({ ok: false });
    expect(await threadView(d.kid.id, "group", g)).toMatchObject({ ok: false });
  });

  it("is only for an account that has not declared 18 or over, linked to a guardian's record", async () => {
    const { org, g } = await youthGroup();
    const grown = await adult();
    await join(grown, g, org);
    expect(await setMinorOptIn(grown.id, g, true)).toMatchObject({ ok: false, code: "YG_OPTIN_ADULT" });
    // A child with no guardian linked has nobody to consent: nothing starts.
    n++;
    const lone = await registerUser({ name: `Lone Kid${n}`, email: `yl${n}@youth.test`, phone: `01397${String(n).padStart(5, "0")}`, password: "a long enough password" });
    if (!lone.ok) throw new Error(lone.error);
    await saveProfile(lone.user.id, { adult: false });
    await join(lone.user, g, org);
    expect(await setMinorOptIn(lone.user.id, g, true)).toMatchObject({ ok: false, code: "YG_NO_GUARDIAN" });
    expect(await myYouthGroups(lone.user.id)).toMatchObject({ eligible: true, linked: false, groups: [{ groupId: g, optedIn: false, guardianOn: false, active: false }] });
    expect(await myYouthGroups(grown.id)).toEqual({ eligible: false, linked: false, groups: [], enabled: true });
    // A guardian cannot switch it on for somebody else's child, or for a person with no login linked.
    const stranger = await adult();
    const { pid } = await child(await adult());
    expect(await setConsent(stranger.id, pid, g, true)).toMatchObject({ ok: false, code: "YG_GUARDIAN" });
    const guardian = await adult();
    const made = await addManaged(guardian.id, { displayName: "Zed Ng", birthYear: 2015, relationship: "parent", authority: true }, guardian.name);
    if (!made.ok) throw new Error(made.error);
    expect(await setConsent(guardian.id, made.person.id, g, true)).toMatchObject({ ok: false, code: "YG_CHILD_NO_LOGIN" });
    // Consent needs the child to be a member of a marked group.
    const { pid: pid2, guardian: g2 } = await youngMember(org, g);
    const plain = await groupOf(org);
    expect(await setConsent(g2.id, pid2, plain, true)).toMatchObject({ ok: false, code: "YG_NOT_YOUTH" });
    const other = await groupOf(await adult());
    await markYouthGroup((await getDb().prepare("SELECT organiser_id FROM community_groups WHERE id = ?").get(other).then((r) => (r as { organiser_id: number }).organiser_id)) as number, other);
    expect(await setConsent(g2.id, pid2, other, true)).toMatchObject({ ok: false, code: "YG_CHILD_NOT_IN" });
  });
});

describe("never private", () => {
  it("opens only with a supervisor and at least two others who can read it, and a supervisor starts it, never a minor", async () => {
    const org = await adult("Orla");
    const g = await groupOf(org);
    await markYouthGroup(org.id, g);
    const a = await youngMember(org, g, "Cal Yeo");
    // A supervisor and one child is a private conversation: refused for both.
    expect(await sendMessage(org.id, "group", g, "hello")).toMatchObject({ ok: false, code: "PM_YOUTH_FEW" });
    expect(await sendMessage(a.kid.id, "group", g, "hello")).toMatchObject({ ok: false, code: "PM_YOUTH_FEW" });
    expect(await threadView(a.kid.id, "group", g)).toMatchObject({ ok: true, view: { canSend: false, whyNot: "PM_YOUTH_FEW" } });
    // A second child: three can read it. Nobody young can start it.
    const b = await youngMember(org, g, "Dee Yeo");
    expect(await sendMessage(a.kid.id, "group", g, "who starts?")).toMatchObject({ ok: false, code: "PM_YOUTH_NEW_THREAD" });
    expect(await threadView(a.kid.id, "group", g)).toMatchObject({ ok: true, view: { canSend: false, whyNot: "PM_YOUTH_NEW_THREAD" } });
    expect(await sendMessage(org.id, "group", g, "Welcome both")).toMatchObject({ ok: true });
    expect(await sendMessage(a.kid.id, "group", g, "thank you")).toMatchObject({ ok: true });
    // One leaves: a supervisor and one child again, so nobody may write, the supervisor included.
    await leaveGroup(b.kid.id, g);
    expect(await sendMessage(org.id, "group", g, "just us")).toMatchObject({ ok: false, code: "PM_YOUTH_FEW" });
    expect(await sendMessage(a.kid.id, "group", g, "just us")).toMatchObject({ ok: false, code: "PM_YOUTH_FEW" });
    // The conversation can still be read.
    expect((await texts(a.kid, g)).length).toBe(2);
  });

  it("has no seat for a minor anywhere else, and the database refuses what no code path may do", async () => {
    const { org, other, g } = await youthGroup();
    const a = await youngMember(org, g);
    await sendMessage(org.id, "group", g, "start");
    // An ordinary group, a game: the child is in them and has no messaging (the adults' rule is unchanged).
    const plain = await groupOf(org);
    await join(a.kid, plain, org);
    expect(await sendMessage(a.kid.id, "group", plain, "hi")).toMatchObject({ ok: false, code: "PM_ADULTS" });
    expect(await sendMessage(org.id, "group", plain, "hi")).toMatchObject({ ok: false, code: "PM_NOBODY" });
    n++;
    const slotDate = addDays(todayISO(), 3 + (slot++ % 8));
    const b = await createBooking({ courtId, date: slotDate, hours: [8 + (slot % 9)], name: org.name, phone: org.phone, userId: org.id });
    if (b.ok) {
      const game = await openGame(org.id, { bookingCode: b.booking.code, spots: 4, level: null, share: 0, autoAccept: true });
      if (game.ok) {
        await askToJoin({ id: a.kid.id, phone: a.kid.phone }, game.game.id);
        expect(await sendMessage(a.kid.id, "game", game.game.id, "hi")).toMatchObject({ ok: false, code: "PM_ADULTS" });
        expect(await sendMessage(other.id, "game", game.game.id, "hi")).toMatchObject({ ok: false });
      }
    }
    // The database: a message from somebody not declared 18 or over is accepted only in a youth group's thread.
    const ordinary = await adult();
    const t = (await getDb().prepare("INSERT INTO player_message_threads (context_kind, context_id) VALUES ('team', 987654) RETURNING id").get()) as { id: number };
    await expect(getDb().prepare("INSERT INTO player_messages (thread_id, sender_id, body) VALUES (?, ?, 'x')").run(t.id, a.kid.id)).rejects.toThrow(/supervised youth group/);
    await expect(getDb().prepare("INSERT INTO player_messages (thread_id, sender_id, body) VALUES (?, ?, 'x')").run(t.id, ordinary.id)).resolves.toBeDefined();
    // Every message a minor ever wrote is in a youth group's thread, whatever else happened.
    const stray = (await getDb()
      .prepare(
        `SELECT COUNT(*)::int AS n FROM player_messages m JOIN player_message_threads t ON t.id = m.thread_id
          WHERE m.sender_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM player_profiles p WHERE p.user_id = m.sender_id AND p.adult = 1)
            AND NOT (t.youth = 1 AND t.context_kind = 'group')`
      )
      .get()) as { n: number };
    expect(stray.n).toBe(0);
    // And a minor's thread listing holds only groups.
    expect((await myThreads(a.kid.id)).threads.map((x) => x.kind)).toEqual(["group"]);
  });

  it("has no way to reply privately: a minor's only routes lead to the group's own thread", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === "route.ts") files.push(p);
      }
    };
    walk(path.join(__dirname, "..", "src", "app", "api", "messages"));
    // The thread routes take a context kind and number; none takes a person.
    const routes = files.map((f) => path.relative(path.join(__dirname, "..", "src", "app", "api", "messages"), f).replace(/\\/g, "/")).sort();
    expect(routes).toEqual(["[kind]/[id]/block/route.ts", "[kind]/[id]/report/route.ts", "[kind]/[id]/route.ts", "route.ts", "settings/route.ts", "suspension-review/route.ts", "youth/review/route.ts", "youth/route.ts"]);
    for (const f of files) expect(fs.readFileSync(f, "utf8")).not.toMatch(/recipient|toUser|userId:\s*body|body\.userId/);
  });
});

describe("supervision", () => {
  it("lets an adult member in only by a supervisor, with a declared role, and never a minor as an adult", async () => {
    const org = await adult("Orla");
    const g = await groupOf(org);
    await markYouthGroup(org.id, g);
    const mum = await adult("Mel");
    await join(mum, g, org);
    // A member who is an adult and was not let in has no seat.
    expect((await youthSeats(g)).map((s) => s.userId)).toEqual([org.id]);
    expect(await sendMessage(mum.id, "group", g, "hi")).toMatchObject({ ok: false, code: "PM_NOT_FOUND" });
    expect(await setYouthAdult(org.id, g, { memberUserId: mum.id, role: "adult", declaredRole: "wizard" })).toMatchObject({ ok: false, code: "YG_ROLE" });
    expect(await setYouthAdult(mum.id, g, { memberUserId: mum.id, role: "supervisor", declaredRole: "parent" })).toMatchObject({ ok: false, code: "YG_ORGANISER" });
    expect(await setYouthAdult(org.id, g, { memberUserId: mum.id, role: "adult", declaredRole: "parent" })).toMatchObject({ ok: true });
    expect((await youthSeats(g)).find((s) => s.userId === mum.id)).toMatchObject({ role: "adult", from: { r: "adult" } });
    // Not a member, or not declared an adult: refused. The organiser cannot be taken out.
    const outsider = await adult();
    expect(await setYouthAdult(org.id, g, { memberUserId: outsider.id, role: "adult", declaredRole: "other" })).toMatchObject({ ok: false, code: "YG_MEMBER" });
    const a = await youngMember(org, g);
    expect(await setYouthAdult(org.id, g, { memberUserId: a.kid.id, role: "supervisor", declaredRole: "other" })).toMatchObject({ ok: false, code: "YG_PERSON_ADULT" });
    expect(await setYouthAdult(org.id, g, { memberUserId: org.id, role: "adult", declaredRole: "other", remove: true })).toMatchObject({ ok: false, code: "YG_LAST_SUPERVISOR" });
    // Taking an adult out ends their seat at once.
    expect(await setYouthAdult(org.id, g, { memberUserId: mum.id, role: "adult", declaredRole: "parent", remove: true })).toMatchObject({ ok: true });
    expect(await threadView(mum.id, "group", g)).toMatchObject({ ok: false });
    // Only the organiser marks, and only a declared adult organiser.
    const g2 = await groupOf(org);
    expect(await markYouthGroup(mum.id, g2)).toMatchObject({ ok: false, code: "YG_ORGANISER" });
    expect(await markYouthGroup(org.id, g)).toMatchObject({ ok: false, code: "YG_ALREADY" });
  });

  it("gives a supervisor the powers to remove a message, mute a member and close the conversation, and nobody else", async () => {
    const { org, other, g } = await youthGroup();
    const a = await youngMember(org, g);
    const b = await youngMember(org, g, "Bo Tan");
    await sendMessage(org.id, "group", g, "Welcome");
    const sent = await sendMessage(a.kid.id, "group", g, "an unkind word");
    if (!sent.ok) throw new Error("send");
    const mid = sent.message.id;
    // Not a supervisor: refused, whoever they are.
    expect(await removeMessage(other.id, g, mid, "no reason")).toMatchObject({ ok: false, code: "YG_SUPERVISOR" });
    expect(await removeMessage(a.kid.id, g, mid, "no reason")).toMatchObject({ ok: false, code: "YG_SUPERVISOR" });
    expect(await muteSender(b.kid.id, g, mid, "no reason")).toMatchObject({ ok: false, code: "YG_SUPERVISOR" });
    expect(await setSupervisedThreadState(other.id, g, "closed", "no reason")).toMatchObject({ ok: false, code: "YG_SUPERVISOR" });
    // A reason is needed.
    expect(await removeMessage(org.id, g, mid, "")).toMatchObject({ ok: false, code: "YG_REASON" });
    // Removing: members see "removed", the words are not sent to them; the guardian is told.
    expect(await removeMessage(org.id, g, mid, "Unkind to another member")).toMatchObject({ ok: true });
    const seen = await threadView(b.kid.id, "group", g);
    if (!seen.ok) throw new Error(seen.error);
    expect(seen.view.messages.find((m) => m.id === mid)).toMatchObject({ body: null, removed: true });
    expect(await removeMessage(org.id, g, mid, "again")).toMatchObject({ ok: false, code: "YG_TARGET" });
    const note = (await getDb().prepare("SELECT body FROM messages WHERE kind = 'safeguarding_notice' AND recipient = ?").get(a.guardian.email)) as { body: string } | undefined;
    expect(note?.body).toContain("removed a message");
    expect(note?.body).not.toContain("unkind word");
    // Muting: can read, cannot write; lifting restores; supervisors cannot be muted.
    const second = await sendMessage(a.kid.id, "group", g, "another word");
    if (!second.ok) throw new Error("send");
    expect(await muteSender(org.id, g, second.message.id, "Keeps going")).toMatchObject({ ok: true });
    expect(await sendMessage(a.kid.id, "group", g, "still here")).toMatchObject({ ok: false, code: "PM_YOUTH_MUTED" });
    expect(await threadView(a.kid.id, "group", g)).toMatchObject({ ok: true, view: { canSend: false, whyNot: "PM_YOUTH_MUTED" } });
    const view = await threadView(org.id, "group", g);
    if (!view.ok) throw new Error(view.error);
    expect(view.view.youth).toMatchObject({ role: "supervisor", muted: [expect.objectContaining({ source: "supervisor" })] });
    const muteId = view.view.youth!.muted![0].id;
    expect(await unmute(org.id, g, muteId)).toMatchObject({ ok: true });
    expect(await sendMessage(a.kid.id, "group", g, "sorry")).toMatchObject({ ok: true });
    const mine = await sendMessage(org.id, "group", g, "a note from me");
    if (!mine.ok) throw new Error("send");
    expect(await muteSender(org.id, g, mine.message.id, "x y z")).toMatchObject({ ok: false });
    // Pausing and closing: closed is for good.
    expect(await setSupervisedThreadState(org.id, g, "muted", "Cooling off")).toMatchObject({ ok: true, state: "muted" });
    expect(await sendMessage(b.kid.id, "group", g, "hello")).toMatchObject({ ok: false, code: "PM_PAUSED" });
    expect(await setSupervisedThreadState(org.id, g, "open", "Back")).toMatchObject({ ok: true });
    expect(await setSupervisedThreadState(org.id, g, "closed", "Done for the term")).toMatchObject({ ok: true });
    expect(await sendMessage(b.kid.id, "group", g, "hello")).toMatchObject({ ok: false, code: "PM_CLOSED" });
    expect(await setSupervisedThreadState(org.id, g, "open", "Oops")).toMatchObject({ ok: false });
    // The group's own record says who did what, and holds no text.
    const events = (await getDb().prepare("SELECT action, detail FROM youth_message_events WHERE group_id = ? ORDER BY id").all(g)) as { action: string; detail: string | null }[];
    expect(events.map((e) => e.action)).toEqual(expect.arrayContaining(["marked", "message_removed", "muted", "unmuted", "thread_muted", "thread_closed"]));
    expect(JSON.stringify(events)).not.toContain("unkind word");
  });

  it("is never a space no adult is in: a supervisor reads everything, even from somebody a child's guardian blocked", async () => {
    const { org, other, g } = await youthGroup();
    const a = await youngMember(org, g);
    const b = await youngMember(org, g, "Bo Tan");
    await sendMessage(org.id, "group", g, "Welcome");
    // The guardian blocks the other adult for the child; blocking a supervisor is refused.
    expect(await guardianBlock(a.guardian.id, a.pid, g, other.id)).toMatchObject({ ok: true });
    expect(await guardianBlock(a.guardian.id, a.pid, g, org.id)).toMatchObject({ ok: false, code: "PM_YOUTH_BLOCK_SUPERVISOR" });
    expect(await guardianBlock(a.guardian.id, a.pid, g, a.kid.id)).toMatchObject({ ok: false, code: "YG_BLOCK_TARGET" });
    expect(await guardianBlock(b.guardian.id, a.pid, g, other.id)).toMatchObject({ ok: false, code: "YG_GUARDIAN" });
    await sendMessage(other.id, "group", g, "from the volunteer");
    await sendMessage(a.kid.id, "group", g, "from Aina");
    // The child does not see the blocked adult's message; the adult does not see the child's; the supervisor sees both.
    expect(await texts(a.kid, g)).toEqual(["Welcome", "from Aina"]);
    expect(await texts(other, g)).toEqual(["Welcome", "from the volunteer"]);
    expect(await texts(org, g)).toEqual(["Welcome", "from the volunteer", "from Aina"]);
    // A child cannot block a supervisor from their own screen either.
    const { blockSender } = await import("../src/lib/messages");
    const view = await threadView(b.kid.id, "group", g);
    if (!view.ok) throw new Error(view.error);
    expect(await blockSender(b.kid.id, "group", g, view.view.messages[0].id)).toMatchObject({ ok: false, code: "PM_YOUTH_BLOCK_SUPERVISOR" });
  });
});

describe("guardians", () => {
  it("see which groups messaging is on in, read the child's thread read-only (recorded), choose the notices, and never act for another's child", async () => {
    const { org, other, g } = await youthGroup();
    const a = await youngMember(org, g);
    const b = await youngMember(org, g, "Bo Tan");
    await sendMessage(org.id, "group", g, "Welcome");
    await sendMessage(a.kid.id, "group", g, "Hello from Aina");
    const hidden = await sendMessage(b.kid.id, "group", g, "something else");
    if (!hidden.ok) throw new Error("send");
    await removeMessage(org.id, g, hidden.message.id, "Not for the group");
    const overview = await guardianOverview(a.guardian.id);
    expect(overview).toHaveLength(1);
    expect(overview[0]).toMatchObject({
      displayName: "Aina Lee",
      noticeMode: "digest",
      groups: [{ groupId: g, consentOn: true, childOptedIn: true, active: true, supervisors: [{ declaredRole: "organiser" }], adults: [{ declaredRole: "volunteer" }] }],
    });
    // Reading: the child's messages marked as theirs, the other child by a short name, the removed message as removed; nothing written, a record kept.
    const read = await guardianThreadView(a.guardian.id, a.pid, g);
    if (!read.ok) throw new Error(read.error);
    expect(read).toMatchObject({ group: expect.any(String), child: "Aina L.", consentOn: true });
    expect(read.messages.map((m) => [m.child, m.body, m.removed ?? false])).toEqual([[false, "Welcome", false], [true, "Hello from Aina", false], [false, null, true]]);
    expect(read.messages[2].from).toEqual({ n: "Bo T." });
    expect(JSON.stringify(read)).not.toContain("Bo Tan");
    const seen = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM youth_message_events WHERE group_id = ? AND action = 'guardian_read'").get(g)) as { n: number };
    expect(seen.n).toBe(1);
    // Another guardian cannot read this child's thread, nor an adult who is not their guardian.
    expect(await guardianThreadView(b.guardian.id, a.pid, g)).toMatchObject({ ok: false, code: "YG_GUARDIAN" });
    expect(await guardianThreadView(other.id, a.pid, g)).toMatchObject({ ok: false, code: "YG_GUARDIAN" });
    // Notices: the guardian's choice, checked.
    expect(await setGuardianNoticeMode(a.guardian.id, a.pid, "daily")).toMatchObject({ ok: true });
    expect(await setGuardianNoticeMode(a.guardian.id, a.pid, "hourly")).toMatchObject({ ok: false, code: "YG_MODE" });
    expect(await setGuardianNoticeMode(b.guardian.id, a.pid, "off")).toMatchObject({ ok: false, code: "YG_GUARDIAN" });
    expect((await guardianOverview(a.guardian.id))[0].noticeMode).toBe("daily");
    // Reading is allowed even where consent is off: a guardian's right to see what their child can reach.
    await setConsent(a.guardian.id, a.pid, g, false);
    expect(await guardianThreadView(a.guardian.id, a.pid, g)).toMatchObject({ ok: true, consentOn: false });
  });
});

describe("the rest hours", () => {
  it("are 22:00 to 07:00 by default, read on the zone's own clock either side of a daylight-saving change, and only a minor is held to them", async () => {
    const night = [{ from: 22 * 60, to: 7 * 60 }];
    expect(quietNow(new Date("2026-06-10T15:30:00Z"), "Asia/Kuala_Lumpur", night)).toEqual(night[0]); // 23:30 in Kuala Lumpur
    expect(quietNow(new Date("2026-06-10T04:00:00Z"), "Asia/Kuala_Lumpur", night)).toBeNull(); // 12:00
    expect(localMinutes(new Date("2026-06-10T15:30:00Z"), "Asia/Kuala_Lumpur")).toBe(23 * 60 + 30);
    // New York: daylight saving began at 02:00 on 8 March 2026 (07:00 UTC) and ended at 02:00 on 1 November (06:00 UTC).
    // 11:30 UTC on 8 March is 07:30 in the morning (EDT), past the rest hours; at a fixed -05:00 it would have read 06:30.
    expect(quietNow(new Date("2026-03-08T11:30:00Z"), "America/New_York", night)).toBeNull();
    expect(quietNow(new Date("2026-03-08T10:30:00Z"), "America/New_York", night)).toEqual(night[0]); // 06:30 EDT
    // 11:30 UTC on 1 November is 06:30 (EST), still resting; at a fixed -04:00 it would have read 07:30.
    expect(quietNow(new Date("2026-11-01T11:30:00Z"), "America/New_York", night)).toEqual(night[0]);
    expect(quietNow(new Date("2026-11-01T12:30:00Z"), "America/New_York", night)).toBeNull();
    // The night of the change itself: 01:30 EST then (an hour later) 03:30 EDT; both are inside the night.
    expect(quietNow(new Date("2026-03-08T06:30:00Z"), "America/New_York", night)).toEqual(night[0]);
    expect(quietNow(new Date("2026-03-08T07:30:00Z"), "America/New_York", night)).toEqual(night[0]);
    // A window that does not pass midnight.
    expect(quietNow(new Date("2026-06-10T04:00:00Z"), "Asia/Kuala_Lumpur", [{ from: 11 * 60, to: 13 * 60 }])).toEqual({ from: 660, to: 780 });
    expect(clockOfMinute(7 * 60 + 5)).toBe("07:05");
  });

  it("refuse a minor's message in the rest hours (the install's, the group's own longer ones) and never an adult's; off is the install's to choose", async () => {
    const { org, other, g } = await youthGroup();
    const a = await youngMember(org, g);
    const b = await youngMember(org, g, "Bo Tan");
    await sendMessage(org.id, "group", g, "Welcome");
    const zone = region().timeZone;
    const now = localMinutes(new Date(), zone);
    // The install's window around the present moment.
    process.env.YOUTH_QUIET_HOURS = `${clockOfMinute((now + 1440 - 30) % 1440)}-${clockOfMinute((now + 30) % 1440)}`;
    try {
      const refused = await sendMessage(a.kid.id, "group", g, "late night");
      expect(refused).toMatchObject({ ok: false, code: "PM_YOUTH_QUIET", status: 403 });
      expect(refused.ok === false && refused.vars).toEqual({ from: expect.stringMatching(/^\d\d:\d\d$/), to: expect.stringMatching(/^\d\d:\d\d$/) });
      const view = await threadView(a.kid.id, "group", g);
      expect(view).toMatchObject({ ok: true, view: { canSend: false, whyNot: "PM_YOUTH_QUIET", youth: { quiet: expect.any(Object) } } });
      // Adults are not held to it.
      expect(await sendMessage(org.id, "group", g, "supervisor at night")).toMatchObject({ ok: true });
      expect(await sendMessage(other.id, "group", g, "volunteer at night")).toMatchObject({ ok: true });
    } finally {
      process.env.YOUTH_QUIET_HOURS = "off";
    }
    expect(installQuietWindow()).toBeNull();
    expect(await sendMessage(a.kid.id, "group", g, "daytime")).toMatchObject({ ok: true });
    // A group may lengthen the rest hours (a window around now), never shorten the install's: with the install's window on, the group's cannot lift it.
    expect(await setGroupQuiet(org.id, g, { from: clockOfMinute((now + 1440 - 20) % 1440), to: clockOfMinute((now + 20) % 1440) })).toMatchObject({ ok: true });
    expect(await sendMessage(b.kid.id, "group", g, "inside the group's hours")).toMatchObject({ ok: false, code: "PM_YOUTH_QUIET" });
    expect(await setGroupQuiet(org.id, g, null)).toMatchObject({ ok: true });
    expect(await sendMessage(b.kid.id, "group", g, "outside the group's hours")).toMatchObject({ ok: true });
    expect(await setGroupQuiet(org.id, g, { from: "9pm", to: "7" })).toMatchObject({ ok: false, code: "YG_QUIET" });
    expect(await setGroupQuiet(other.id, g, { from: "21:00", to: "07:00" })).toMatchObject({ ok: false, code: "YG_ORGANISER" });
    // A value that does not parse is the default: 22:00 to 07:00.
    process.env.YOUTH_QUIET_HOURS = "whenever";
    expect(installQuietWindow()).toEqual({ from: 22 * 60, to: 7 * 60 });
    process.env.YOUTH_QUIET_HOURS = "off";
  });
});

describe("limits and the text", () => {
  it("holds a minor to shorter messages and fewer of them than an adult", async () => {
    const { org, g } = await youthGroup();
    const a = await youngMember(org, g);
    await sendMessage(org.id, "group", g, "Welcome");
    expect(YOUTH_LIMITS.maxLength).toBeLessThan(LIMITS.maxLength);
    expect(YOUTH_LIMITS.perHour).toBeLessThan(LIMITS.perHour);
    expect(await sendMessage(a.kid.id, "group", g, "x".repeat(YOUTH_LIMITS.maxLength + 1))).toMatchObject({ ok: false, code: "PM_LONG", vars: { n: YOUTH_LIMITS.maxLength } });
    expect(await sendMessage(a.kid.id, "group", g, "y".repeat(YOUTH_LIMITS.maxLength))).toMatchObject({ ok: true });
    // An adult may write the long one.
    expect(await sendMessage(org.id, "group", g, "z".repeat(YOUTH_LIMITS.maxLength + 1))).toMatchObject({ ok: true });
    for (let i = 1; i < YOUTH_LIMITS.perHour; i++) expect(await sendMessage(a.kid.id, "group", g, `message ${i}`)).toMatchObject({ ok: true });
    expect(await sendMessage(a.kid.id, "group", g, "one too many")).toMatchObject({ ok: false, code: "PM_RATE" });
    expect(await sendMessage(org.id, "group", g, "an adult goes on")).toMatchObject({ ok: true });
  });

  it("refuses handles, chat and social services, links and private-chat asks in a youth thread, from anybody, and email and phone as ever", async () => {
    const { org, other, g } = await youthGroup();
    const a = await youngMember(org, g);
    await sendMessage(org.id, "group", g, "Welcome");
    const bad = [
      "find me @aina_k2014",
      "add me on insta",
      "my whatsapp is on my profile",
      "DM me after practice",
      "look at www.example.org",
      "see https://example.com/x",
      "go to example.com",
      "mail aina@example.com",
      "call 012-345 6789",
      "message me on telegram",
      "my number is on the sheet",
    ];
    for (const text of bad) {
      expect(await sendMessage(a.kid.id, "group", g, text), text).toMatchObject({ ok: false, code: "PM_CONTACT" });
      expect(await sendMessage(other.id, "group", g, text), text).toMatchObject({ ok: false, code: "PM_CONTACT" });
    }
    for (const text of ["Great game today, see you Sunday at 9", "We won 21-19 21-17", "Bring a water bottle please", "Court 3 at 10.30"]) {
      expect(youthContactPattern(text), text).toBe(false);
      expect(contactDetail(text), text).toBeNull();
    }
    expect(await sendMessage(a.kid.id, "group", g, "See you Sunday at 9")).toMatchObject({ ok: true });
    // The ordinary adults' check is as it was: a word such as "insta" in an adults' group is not refused.
    expect(youthContactPattern("follow us on insta")).toBe(true);
    expect(contactDetail("follow us on insta")).toBeNull();
  });
});

describe("what is kept, exported and erased", () => {
  it("keeps a youth thread a shorter time, deletes a removed message's words sooner, exports a guardian's child's messages and erases what the child wrote", async () => {
    const { org, g } = await youthGroup();
    const a = await youngMember(org, g);
    const b = await youngMember(org, g, "Bo Tan");
    await sendMessage(org.id, "group", g, "Welcome");
    const mine = await sendMessage(a.kid.id, "group", g, "my first message");
    const removed = await sendMessage(b.kid.id, "group", g, "to be removed");
    if (!mine.ok || !removed.ok) throw new Error("send");
    await removeMessage(org.id, g, removed.message.id, "Off topic");
    // A guardian's own export holds the child's group messages, a removed one without its words; the child's export holds what they did.
    const guardianExport = (await messagesExport(a.guardian.id)) as { youthMessaging: { childrenGroupMessages: { child: string; messages: { body: string | null }[] }[]; consentsYouGave: unknown[] } };
    expect(guardianExport.youthMessaging.consentsYouGave).toHaveLength(1);
    expect(guardianExport.youthMessaging.childrenGroupMessages).toHaveLength(1);
    expect(guardianExport.youthMessaging.childrenGroupMessages[0].child).toBe("Aina Lee");
    expect(guardianExport.youthMessaging.childrenGroupMessages[0].messages.map((m) => m.body)).toEqual(["Welcome", "my first message", null]);
    const childExport = (await messagesExport(a.kid.id)) as { youthMessaging: { optIns: unknown[]; consentsForYou: unknown[] } };
    expect(childExport.youthMessaging.optIns).toHaveLength(1);
    expect(childExport.youthMessaging.consentsForYou).toHaveLength(1);
    // The words of a message removed 31 days ago are deleted; one removed 10 days ago keeps them (for staff review).
    const db = getDb();
    await db.prepare("UPDATE player_messages SET hidden_at = ? WHERE id = ?").run(`${addDays(todayISO(), -31)} 10:00:00`, removed.message.id);
    await pruneYouthMessages(cutoffFor(60));
    expect((await db.prepare("SELECT body, removed_at FROM player_messages WHERE id = ?").get(removed.message.id)) as { body: string | null; removed_at: string | null }).toMatchObject({ body: null, removed_at: expect.any(String) });
    const recent = await sendMessage(a.kid.id, "group", g, "removed recently");
    if (!recent.ok) throw new Error("send");
    await removeMessage(org.id, g, recent.message.id, "Off topic again");
    await db.prepare("UPDATE player_messages SET hidden_at = ? WHERE id = ?").run(`${addDays(todayISO(), -10)} 10:00:00`, recent.message.id);
    await pruneYouthMessages(cutoffFor(60));
    expect(((await db.prepare("SELECT body FROM player_messages WHERE id = ?").get(recent.message.id)) as { body: string | null }).body).toBe("removed recently");
    // The thread: 40 days after the group ended it is kept; 61 days after, deleted (an adults' conversation would be kept to 90).
    await closeGroup(org.id, g);
    await threadView(a.kid.id, "group", g).catch(() => null);
    await db.prepare("UPDATE player_message_threads SET ended_at = ? WHERE context_kind = 'group' AND context_id = ?").run(`${addDays(todayISO(), -40)} 10:00:00`, g);
    await pruneYouthMessages(cutoffFor(60));
    expect(((await db.prepare("SELECT COUNT(*)::int AS n FROM player_message_threads WHERE context_id = ? AND context_kind = 'group'").get(g)) as { n: number }).n).toBe(1);
    await db.prepare("UPDATE player_message_threads SET ended_at = ? WHERE context_kind = 'group' AND context_id = ?").run(`${addDays(todayISO(), -61)} 10:00:00`, g);
    const { pruneMessages } = await import("../src/lib/message-privacy");
    await pruneMessages(cutoffFor(90));
    expect(((await db.prepare("SELECT COUNT(*)::int AS n FROM player_message_threads WHERE context_id = ? AND context_kind = 'group'").get(g)) as { n: number }).n).toBe(1);
    await pruneYouthMessages(cutoffFor(60));
    expect(((await db.prepare("SELECT COUNT(*)::int AS n FROM player_message_threads WHERE context_id = ? AND context_kind = 'group'").get(g)) as { n: number }).n).toBe(0);
  });

  it("erases what a child wrote with their account, and what a child wrote is not shown for a guardian whose consent is gone", async () => {
    const { org, g } = await youthGroup();
    const a = await youngMember(org, g);
    const b = await youngMember(org, g, "Bo Tan");
    await sendMessage(org.id, "group", g, "Welcome");
    await sendMessage(a.kid.id, "group", g, "words that will go");
    await forgetMessagesOfUser(a.kid.id);
    const rows = (await getDb().prepare("SELECT body, sender_label FROM player_messages m JOIN player_message_threads t ON t.id = m.thread_id WHERE t.context_id = ? AND m.sender_id = ?").all(g, a.kid.id)) as { body: string | null; sender_label: string | null }[];
    expect(rows).toEqual([{ body: null, sender_label: null }]);
    expect(await texts(b.kid, g)).toEqual(["Welcome", null]);
  });
});
