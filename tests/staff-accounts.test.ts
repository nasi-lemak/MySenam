import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import {
  ADMIN_SESSION_COOKIE,
  authenticateAdmin,
  createAdmin,
  createAdminSession,
  ensureBootstrapAdmin,
  getAdminById,
  getAdminByToken,
  listAdmins,
  type Admin,
} from "../src/lib/admin-auth";
import { listActivity } from "../src/lib/activity";
import { getDb } from "../src/lib/db";
import { setTransport } from "../src/lib/outbox";
import { STAFF_REFUSALS } from "../src/lib/staff-i18n";
import { INVITE_DAYS } from "../src/lib/staff-accounts";
import { createVenue } from "../src/lib/store";
import { GET as list, POST as add } from "../src/app/api/admin/admins/route";
import { DELETE as remove, PATCH as change } from "../src/app/api/admin/admins/[id]/route";
import { DELETE as withdraw, POST as resend } from "../src/app/api/admin/admins/invitations/[id]/route";
import { POST as accept } from "../src/app/api/admin/auth/invitation/route";

/**
 * Staff accounts (audit R8 X1-14; lib/staff-accounts.ts): new staff are
 * invited by email to choose their own password, an invitation can be sent
 * again or withdrawn, a branch manager runs their own branch's front desk
 * and nobody else, removing someone signs them out at once, names and
 * addresses can be corrected (a new address is invited), and nothing here
 * says whether an address has an account the caller cannot see.
 */

let ownerCookie: string;
let business: number;
let branchA: number;
let branchB: number;
let elsewhere: number;
let bizManager: Admin;
let branchManagerA: Admin;
let deskA: Admin;
let otherManager: Admin;

const cookieFor = async (id: number) => `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(id)).token}`;
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
const req = (path: string, method: string, cookie: string, body?: unknown) =>
  new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function venue(name: string): Promise<number> {
  const made = await createVenue({ name, area: "PJ", address: "1 Jalan Ujian", phone: "0377770000" });
  if (!made.ok) throw new Error(made.error);
  return made.venue.id;
}

async function staff(input: { name: string; email: string; venueId?: number | null; businessId?: number | null; role?: "desk" | "manager" }): Promise<Admin> {
  const made = await createAdmin({ password: "a long enough password", venueId: null, ...input });
  if (!made.ok) throw new Error(made.error);
  return made.admin;
}

/** The emails queued to an address, newest last. */
async function mailTo(address: string): Promise<{ subject: string; body: string; locale: string }[]> {
  return (await getDb().prepare("SELECT subject, body, locale FROM messages WHERE recipient = ? ORDER BY id").all(address)) as {
    subject: string;
    body: string;
    locale: string;
  }[];
}

const tokenIn = (body: string) => /token=([A-Za-z0-9_-]+)/.exec(body)?.[1] ?? "";

const sent: string[] = [];

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const owner = (await authenticateAdmin("admin@mysenam.my", "mysenam-admin"))!;
  ownerCookie = await cookieFor(owner.id);
  branchA = await venue("Smash A");
  branchB = await venue("Smash B");
  elsewhere = await venue("Elsewhere Courts");
  business = ((await getDb().prepare("INSERT INTO businesses (name) VALUES ('Smash Chain') RETURNING id").get()) as { id: number }).id;
  await getDb().prepare("UPDATE venues SET business_id = ? WHERE id IN (?, ?)").run(business, branchA, branchB);
  bizManager = await staff({ name: "Bina Business", email: "bina@smash.my", businessId: business });
  branchManagerA = await staff({ name: "Mira Manager", email: "mira@smash.my", venueId: branchA, role: "manager" });
  deskA = await staff({ name: "Dina Desk", email: "dina@smash.my", venueId: branchA, role: "desk" });
  otherManager = await staff({ name: "Omar Other", email: "omar@elsewhere.my", venueId: elsewhere, role: "manager" });
});

beforeEach(() => {
  // A transport, as an install with email has: invitations can go out.
  setTransport({ name: "test", send: async (m) => void sent.push(m.recipient) });
});

afterEach(() => {
  setTransport(null);
  delete process.env.SMTP_URL;
  delete process.env.MAIL_FROM;
});

describe("inviting staff", () => {
  it("emails a link in their own language; no account exists, and nothing signs in, until it is used", async () => {
    const res = await add(req("/api/admin/admins", "POST", await cookieFor(bizManager.id), { name: "Nur Aina", email: "aina@smash.my", venueId: branchA, role: "desk", locale: "ms" }));
    expect(res.status).toBe(201);
    const { invitation } = await res.json();
    expect(invitation).toMatchObject({ name: "Nur Aina", email: "aina@smash.my", venueId: branchA, role: "desk" });
    expect((await listAdmins()).some((a) => a.email === "aina@smash.my")).toBe(false);
    expect(await authenticateAdmin("aina@smash.my", "")).toBeNull();

    const [mail] = await mailTo("aina@smash.my");
    expect(mail.locale).toBe("ms");
    expect(mail.subject).toContain("dijemput");
    expect(mail.body).toContain("/reset-password?kind=invite&token=");
    expect(mail.body).toContain(`${INVITE_DAYS} hari`);
    // Only a keyed hash of the link is kept.
    const token = tokenIn(mail.body);
    const stored = (await getDb().prepare("SELECT token_hash FROM staff_invitations WHERE email = 'aina@smash.my'").get()) as { token_hash: string };
    expect(stored.token_hash).not.toContain(token);

    // The invitation is listed for the manager, as not yet accepted.
    const listed = await (await list(req("/api/admin/admins", "GET", await cookieFor(bizManager.id)))).json();
    expect(listed.invitations.map((i: { email: string }) => i.email)).toContain("aina@smash.my");
    expect(listed.invitationsPossible).toBe(true);
    expect((await listActivity([branchA])).some((a) => a.action === "staff.invited" && a.detail?.includes("aina@smash.my"))).toBe(true);
  });

  it("makes the account with the password they chose, once, and signs them in", async () => {
    const token = tokenIn((await mailTo("aina@smash.my"))[0].body);
    expect((await accept(req("/api/admin/auth/invitation", "POST", "", { token, password: "short" }))).status).toBe(400);
    const res = await accept(req("/api/admin/auth/invitation", "POST", "", { token, password: "aina's own password" }));
    expect(res.status).toBe(200);
    const session = res.cookies.get(ADMIN_SESSION_COOKIE)?.value;
    const signedIn = await getAdminByToken(session!);
    expect(signedIn).toMatchObject({ email: "aina@smash.my", venueId: branchA, role: "desk", locale: "ms" });
    expect(await authenticateAdmin("aina@smash.my", "aina's own password")).not.toBeNull();
    // Used once: the same link again is refused, with the code the page says in its language.
    const again = await accept(req("/api/admin/auth/invitation", "POST", "", { token, password: "another password" }));
    expect(again.status).toBe(400);
    expect((await again.json()).code).toBe("RESET_INVALID");
    expect((await listActivity([branchA])).some((a) => a.action === "staff.joined" && a.adminName === "Nur Aina")).toBe(true);
  });

  it("can be sent again (the old link stops working) or withdrawn (its link stops working)", async () => {
    const cookie = await cookieFor(bizManager.id);
    const made = await (await add(req("/api/admin/admins", "POST", cookie, { name: "Kumar", email: "kumar@smash.my", venueId: branchB, role: "desk" }))).json();
    const first = tokenIn((await mailTo("kumar@smash.my"))[0].body);
    expect((await resend(req(`/api/admin/admins/invitations/${made.invitation.id}`, "POST", cookie, {}), ctx(made.invitation.id))).status).toBe(200);
    const mails = await mailTo("kumar@smash.my");
    expect(mails).toHaveLength(2);
    const second = tokenIn(mails[1].body);
    expect(second).not.toBe(first);
    expect((await (await accept(req("/api/admin/auth/invitation", "POST", "", { token: first, password: "kumar's password" }))).json()).code).toBe("RESET_INVALID");

    expect((await withdraw(req(`/api/admin/admins/invitations/${made.invitation.id}`, "DELETE", cookie), ctx(made.invitation.id))).status).toBe(200);
    expect((await accept(req("/api/admin/auth/invitation", "POST", "", { token: second, password: "kumar's password" }))).status).toBe(400);
    expect((await listAdmins()).some((a) => a.email === "kumar@smash.my")).toBe(false);
    const actions = (await listActivity([branchB])).map((a) => a.action);
    expect(actions).toContain("staff.invitation_resent");
    expect(actions).toContain("staff.invitation_withdrawn");
  });

  it("runs out after its days", async () => {
    const cookie = await cookieFor(bizManager.id);
    await add(req("/api/admin/admins", "POST", cookie, { name: "Late Lee", email: "late@smash.my", venueId: branchB, role: "desk" }));
    const token = tokenIn((await mailTo("late@smash.my"))[0].body);
    await getDb().prepare("UPDATE staff_invitations SET expires_at = datetime('now', '-1 minute') WHERE email = 'late@smash.my'").run();
    expect((await accept(req("/api/admin/auth/invitation", "POST", "", { token, password: "late's password" }))).status).toBe(400);
    const listed = await (await list(req("/api/admin/admins", "GET", cookie))).json();
    expect(listed.invitations.find((i: { email: string }) => i.email === "late@smash.my").expired).toBe(true);
  });

  it("says nothing about an address with an account the inviter cannot see; only its holder is told, on opening the link", async () => {
    // omar@elsewhere.my works at another venue: the chain's manager cannot see him.
    const res = await add(req("/api/admin/admins", "POST", await cookieFor(bizManager.id), { name: "Omar", email: "omar@elsewhere.my", venueId: branchA, role: "desk" }));
    expect(res.status).toBe(201);
    expect(Object.keys(await res.json())).toEqual(["invitation"]);
    const token = tokenIn((await mailTo("omar@elsewhere.my")).at(-1)!.body);
    const opened = await accept(req("/api/admin/auth/invitation", "POST", "", { token, password: "omar's new password" }));
    expect(opened.status).toBe(409);
    expect((await opened.json()).code).toBe("R9A_ADDRESS_TAKEN");
    // His own account is untouched.
    expect(await getAdminById(otherManager.id)).toMatchObject({ venueId: elsewhere, role: "manager" });
    expect(await authenticateAdmin("omar@elsewhere.my", "a long enough password")).not.toBeNull();
    // Within what the inviter can see, the clash is said at once.
    const seen = await add(req("/api/admin/admins", "POST", await cookieFor(bizManager.id), { name: "Dina", email: "dina@smash.my", venueId: branchB, role: "desk" }));
    expect(seen.status).toBe(409);
  });
});

describe("a typed password", () => {
  it("is refused where the install sends email, and the only way where it cannot", async () => {
    const cookie = await cookieFor(bizManager.id);
    process.env.SMTP_URL = "smtp://user:pass@mail.invalid:587";
    process.env.MAIL_FROM = "MySenam <no-reply@mysenam.test>";
    const refused = await add(req("/api/admin/admins", "POST", cookie, { name: "Typed", email: "typed@smash.my", password: "a long enough password", venueId: branchA, role: "desk" }));
    expect(refused.status).toBe(400);
    const said = (await refused.json()).error;
    expect(STAFF_REFUSALS[said]).toBeTruthy();
    delete process.env.SMTP_URL;
    delete process.env.MAIL_FROM;

    setTransport(null);
    const prev = process.env.MYSENAM_SEND;
    delete process.env.MYSENAM_SEND;
    try {
      const noInvite = await add(req("/api/admin/admins", "POST", cookie, { name: "No Mail", email: "nomail@smash.my", venueId: branchA, role: "desk" }));
      expect(noInvite.status).toBe(400);
      expect(STAFF_REFUSALS[(await noInvite.json()).error]).toBeTruthy();
      const typed = await add(req("/api/admin/admins", "POST", cookie, { name: "No Mail", email: "nomail@smash.my", password: "a long enough password", venueId: branchA, role: "desk" }));
      expect(typed.status).toBe(201);
      expect(await authenticateAdmin("nomail@smash.my", "a long enough password")).not.toBeNull();
      const listed = await (await list(req("/api/admin/admins", "GET", cookie))).json();
      expect(listed).toMatchObject({ invitationsPossible: false, typedPassword: true });
    } finally {
      if (prev !== undefined) process.env.MYSENAM_SEND = prev;
    }
  });
});

describe("a branch manager", () => {
  it("adds front desk at their own branch, and nobody else anywhere", async () => {
    const cookie = await cookieFor(branchManagerA.id);
    expect((await add(req("/api/admin/admins", "POST", cookie, { name: "Desk Two", email: "desk2@smash.my", venueId: branchA, role: "desk" }))).status).toBe(201);
    // With no role named, what a branch manager adds is front desk.
    const plain = await (await add(req("/api/admin/admins", "POST", cookie, { name: "Desk Three", email: "desk3@smash.my", venueId: branchA }))).json();
    expect(plain.invitation.role).toBe("desk");
    const manager = await add(req("/api/admin/admins", "POST", cookie, { name: "Boss", email: "boss@smash.my", venueId: branchA, role: "manager" }));
    expect(manager.status).toBe(403);
    expect(STAFF_REFUSALS[(await manager.json()).error]).toBeTruthy();
    expect((await add(req("/api/admin/admins", "POST", cookie, { name: "Other", email: "o@smash.my", venueId: branchB, role: "desk" }))).status).toBe(403);
    expect((await add(req("/api/admin/admins", "POST", cookie, { name: "Biz", email: "biz@smash.my", businessId: business }))).status).toBe(403);
    expect((await add(req("/api/admin/admins", "POST", cookie, { name: "Owner", email: "owner2@smash.my" }))).status).toBe(403);
  });

  it("sees their branch's staff, and may change only its front desk", async () => {
    const listed = await (await list(req("/api/admin/admins", "GET", await cookieFor(branchManagerA.id)))).json();
    const emails = listed.admins.map((a: Admin) => a.email);
    expect(emails).toContain("dina@smash.my");
    expect(emails).not.toContain("bina@smash.my");
    expect(emails).not.toContain("omar@elsewhere.my");
    expect(listed.admins.find((a: Admin) => a.email === "dina@smash.my").manageable).toBe(true);
    expect(listed.admins.find((a: Admin) => a.email === "mira@smash.my").manageable).toBe(false);
  });

  it("removes front desk at once (every session ends), but not a manager or anyone at another branch", async () => {
    const cookie = await cookieFor(branchManagerA.id);
    const leaver = await staff({ name: "Leaver", email: "leaver@smash.my", venueId: branchA, role: "desk" });
    const theirSession = (await createAdminSession(leaver.id)).token;
    // Records they made stay, without them (migration 0251): an induction, counter credit.
    await getDb().prepare("INSERT INTO inductions (venue_id, phone, name, admin_id) VALUES (?, '0123000111', 'Ali', ?)").run(branchA, leaver.id);
    expect((await remove(req(`/api/admin/admins/${leaver.id}`, "DELETE", cookie), ctx(leaver.id))).status).toBe(200);
    expect(await getAdminByToken(theirSession)).toBeNull();
    expect(((await getDb().prepare("SELECT admin_id FROM inductions WHERE phone = '0123000111'").get()) as { admin_id: number | null }).admin_id).toBeNull();
    expect((await listActivity([branchA])).some((a) => a.action === "staff.removed" && a.detail?.includes("leaver@smash.my"))).toBe(true);

    const peer = await staff({ name: "Peer Manager", email: "peer@smash.my", venueId: branchA, role: "manager" });
    expect((await remove(req(`/api/admin/admins/${peer.id}`, "DELETE", cookie), ctx(peer.id))).status).toBe(403);
    const deskB = await staff({ name: "Desk B", email: "deskb@smash.my", venueId: branchB, role: "desk" });
    expect((await remove(req(`/api/admin/admins/${deskB.id}`, "DELETE", cookie), ctx(deskB.id))).status).toBe(403);
    expect((await remove(req(`/api/admin/admins/${branchManagerA.id}`, "DELETE", cookie), ctx(branchManagerA.id))).status).toBe(409);
    expect(await getAdminById(peer.id)).not.toBeNull();
    expect(await getAdminById(deskB.id)).not.toBeNull();
  });

  it("may make one of their front desk a manager, who is then theirs no longer", async () => {
    const cookie = await cookieFor(branchManagerA.id);
    const rising = await staff({ name: "Rising Star", email: "rising@smash.my", venueId: branchA, role: "desk" });
    expect((await change(req(`/api/admin/admins/${rising.id}`, "PATCH", cookie, { role: "manager" }), ctx(rising.id))).status).toBe(200);
    expect((await getAdminById(rising.id))!.role).toBe("manager");
    expect((await change(req(`/api/admin/admins/${rising.id}`, "PATCH", cookie, { role: "desk" }), ctx(rising.id))).status).toBe(403);
    // A business manager may still change it back.
    expect((await change(req(`/api/admin/admins/${rising.id}`, "PATCH", await cookieFor(bizManager.id), { role: "desk" }), ctx(rising.id))).status).toBe(200);
    expect((await listActivity([branchA])).filter((a) => a.action === "staff.role").map((a) => a.detail)).toEqual(
      expect.arrayContaining(["Rising Star: desk → manager", "Rising Star: manager → desk"])
    );
  });

  it("cannot withdraw or resend an invitation to another branch", async () => {
    const made = await (await add(req("/api/admin/admins", "POST", await cookieFor(bizManager.id), { name: "Bee", email: "bee@smash.my", venueId: branchB, role: "desk" }))).json();
    const cookie = await cookieFor(branchManagerA.id);
    expect((await withdraw(req(`/api/admin/admins/invitations/${made.invitation.id}`, "DELETE", cookie), ctx(made.invitation.id))).status).toBe(403);
    expect((await resend(req(`/api/admin/admins/invitations/${made.invitation.id}`, "POST", cookie, {}), ctx(made.invitation.id))).status).toBe(403);
  });
});

describe("front desk", () => {
  it("manages no accounts at all", async () => {
    const cookie = await cookieFor(deskA.id);
    const listed = await list(req("/api/admin/admins", "GET", cookie));
    expect(listed.status).toBe(403);
    expect((await listed.json()).code).toBe("MANAGER_ONLY");
    expect((await add(req("/api/admin/admins", "POST", cookie, { name: "X", email: "x@smash.my", venueId: branchA, role: "desk" }))).status).toBe(403);
    expect((await remove(req(`/api/admin/admins/${branchManagerA.id}`, "DELETE", cookie), ctx(branchManagerA.id))).status).toBe(403);
  });
});

describe("correcting a member of staff", () => {
  it("changes a name at once, logged", async () => {
    const cookie = await cookieFor(branchManagerA.id);
    const res = await change(req(`/api/admin/admins/${deskA.id}`, "PATCH", cookie, { name: "Dina Abdullah" }), ctx(deskA.id));
    expect(res.status).toBe(200);
    expect((await getAdminById(deskA.id))!.name).toBe("Dina Abdullah");
    expect((await listActivity([branchA])).some((a) => a.action === "staff.corrected" && a.detail === "Dina Desk → Dina Abdullah (dina@smash.my)")).toBe(true);
  });

  it("invites a new address: the old one keeps working and is told, and the account moves when the new one accepts", async () => {
    const cookie = await cookieFor(branchManagerA.id);
    const before = (await createAdminSession(deskA.id)).token;
    const res = await change(req(`/api/admin/admins/${deskA.id}`, "PATCH", cookie, { email: "dina.new@smash.my" }), ctx(deskA.id));
    expect(await res.json()).toEqual({ ok: true, invited: true });
    expect((await getAdminById(deskA.id))!.email).toBe("dina@smash.my");
    expect(await getAdminByToken(before)).not.toBeNull();
    expect((await mailTo("dina@smash.my")).at(-1)!.body).toContain("dina.new@smash.my");
    const token = tokenIn((await mailTo("dina.new@smash.my")).at(-1)!.body);
    const done = await accept(req("/api/admin/auth/invitation", "POST", "", { token, password: "dina's new password" }));
    expect(done.status).toBe(200);
    const moved = await getAdminById(deskA.id);
    expect(moved).toMatchObject({ email: "dina.new@smash.my", venueId: branchA, role: "desk" });
    // Whoever was signed in as the account before is not now.
    expect(await getAdminByToken(before)).toBeNull();
    expect(await authenticateAdmin("dina.new@smash.my", "dina's new password")).not.toBeNull();
    const actions = (await listActivity([branchA])).map((a) => a.action);
    expect(actions).toContain("staff.address_invited");
    expect(actions).toContain("staff.address_changed");
  });

  it("is refused for an account the caller does not manage", async () => {
    const res = await change(req(`/api/admin/admins/${otherManager.id}`, "PATCH", await cookieFor(bizManager.id), { name: "Hijacked" }), ctx(otherManager.id));
    expect(res.status).toBe(403);
    expect((await getAdminById(otherManager.id))!.name).toBe("Omar Other");
  });
});

describe("the platform owner", () => {
  it("keeps every power: invites a business manager and removes them", async () => {
    const res = await add(req("/api/admin/admins", "POST", ownerCookie, { name: "Second Boss", email: "boss2@smash.my", businessId: business }));
    expect(res.status).toBe(201);
    const token = tokenIn((await mailTo("boss2@smash.my"))[0].body);
    expect((await accept(req("/api/admin/auth/invitation", "POST", "", { token, password: "second boss password" }))).status).toBe(200);
    const boss2 = (await listAdmins()).find((a) => a.email === "boss2@smash.my")!;
    expect(boss2.businessId).toBe(business);
    expect((await remove(req(`/api/admin/admins/${boss2.id}`, "DELETE", ownerCookie), ctx(boss2.id))).status).toBe(200);
  });
});
