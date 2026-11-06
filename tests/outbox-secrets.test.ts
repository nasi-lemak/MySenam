import { afterEach, beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin, getAdminByToken, type Admin } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { enqueue, setTransport } from "../src/lib/outbox";
import { tickOutbox } from "../src/lib/notify";
import { resendInvitation } from "../src/lib/staff-accounts";
import { createVenue } from "../src/lib/store";
import { POST as add } from "../src/app/api/admin/admins/route";
import { POST as accept } from "../src/app/api/admin/auth/invitation/route";
import { GET as outbox } from "../src/app/api/admin/messages/route";

/**
 * A staff invitation is an email with a single-use link that makes a MANAGER account (lib/staff-accounts.ts). It is filed
 * under the venue, and the venue's outbox screen is open to front desk, so the link must never be in what that screen
 * lists, however the message went (queued, failed while the mail provider was down, sent). Resending gives a new link
 * and gives the old unsent message up.
 */
let business: number;
let branch: number;
let bizManager: Admin;
let desk: Admin;

const cookieFor = async (id: number) => `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(id)).token}`;
const req = (path: string, method: string, cookie: string, body?: unknown) =>
  new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const tokenIn = (text: string) => /kind=invite&(?:amp;)?token=([A-Za-z0-9_-]+)/.exec(text)?.[1];
const listAs = async (admin: Admin, venueId = branch) => outbox(req(`/api/admin/messages?venueId=${venueId}`, "GET", await cookieFor(admin.id)));

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const v = await createVenue({ name: "Smash A", area: "PJ", address: "1 Jalan Ujian", phone: "0377770000" });
  if (!v.ok) throw new Error(v.error);
  branch = v.venue.id;
  business = ((await getDb().prepare("INSERT INTO businesses (name) VALUES ('Smash Chain') RETURNING id").get()) as { id: number }).id;
  await getDb().prepare("UPDATE venues SET business_id = ? WHERE id = ?").run(business, branch);
  const b = await createAdmin({ name: "Bina", email: "bina@smash.my", password: "a long enough password", venueId: null, businessId: business });
  const d = await createAdmin({ name: "Dina Desk", email: "dina@smash.my", password: "a long enough password", venueId: branch, role: "desk" });
  if (!b.ok || !d.ok) throw new Error("staff");
  bizManager = b.admin;
  desk = d.admin;
});

afterEach(() => setTransport(null));

describe("a manager invitation while the mail provider is down", () => {
  it("does not hand its link to the branch's front desk, who cannot become a manager with it", async () => {
    setTransport({ name: "down", send: async () => { throw new Error("smtp down"); } });
    const res = await add(req("/api/admin/admins", "POST", await cookieFor(bizManager.id), { name: "New Manager", email: "newmgr@smash.my", venueId: branch, role: "manager" }));
    expect(res.status).toBe(201);
    await tickOutbox();

    const listed = await listAs(desk);
    expect(listed.status).toBe(200);
    const text = await listed.text();
    const token = tokenIn(text);
    // If it could, this is the escalation: the desk accepts the manager's invitation first.
    let becameManager = false;
    if (token) {
      const done = await accept(req("/api/admin/auth/invitation", "POST", "", { token, password: "the desk chose this one" }));
      const session = done.cookies.get(ADMIN_SESSION_COOKIE)?.value;
      const who = session ? await getAdminByToken(session) : null;
      becameManager = who?.role === "manager" && who.venueId === branch;
    }
    expect(token, "the front desk can read the invitation link in the venue's outbox").toBeUndefined();
    expect(text).not.toContain("reset-password");
    expect(becameManager, "and used it to become a manager").toBe(false);
    // What staff do see: that an invitation went (or failed), to whom, and how it went.
    const { messages } = JSON.parse(text) as { messages: { kind: string; recipient: string; status: string; body: string }[] };
    const invitation = messages.find((m) => m.recipient === "newmgr@smash.my");
    expect(invitation).toMatchObject({ kind: "account_email" });
    expect(invitation!.status).not.toBe("sent");
  });

  it("is hidden from the business manager's own outbox screen too, and from the platform list", async () => {
    const text = await (await listAs(bizManager)).text();
    expect(text).not.toContain("token=");
    const owner = (await getDb().prepare("SELECT id FROM admins WHERE venue_id IS NULL AND business_id IS NULL ORDER BY id LIMIT 1").get()) as { id: number };
    const platform = await outbox(req("/api/admin/messages?platform=1", "GET", await cookieFor(owner.id)));
    expect(await platform.text()).not.toContain("token=");
  });

  it("is resent with a new link: the old link stops working and the old unsent email is given up, unkept", async () => {
    const before = (await getDb().prepare("SELECT id FROM staff_invitations WHERE email = 'newmgr@smash.my'").get()) as { id: number };
    const oldBody = (await getDb().prepare("SELECT body FROM messages WHERE recipient = 'newmgr@smash.my' ORDER BY id DESC LIMIT 1").get()) as { body: string };
    const oldToken = tokenIn(oldBody.body)!;
    expect(oldToken).toBeTruthy();

    const seen: string[] = [];
    setTransport({ name: "up", send: async (m) => void seen.push(m.body) });
    const again = await resendInvitation(bizManager, before.id);
    expect(again.ok).toBe(true);
    await tickOutbox();

    // The first email (never delivered) is given up and no longer holds its link.
    const first = (await getDb().prepare("SELECT status, body FROM messages WHERE recipient = 'newmgr@smash.my' ORDER BY id ASC LIMIT 1").get()) as { status: string; body: string };
    expect(first.status).toBe("abandoned");
    expect(first.body).not.toContain(oldToken);
    // The new one is delivered with a different link; the old link is dead, the new one works.
    expect(seen).toHaveLength(1);
    const newToken = tokenIn(seen[0])!;
    expect(newToken).toBeTruthy();
    expect(newToken).not.toBe(oldToken);
    const dead = await accept(req("/api/admin/auth/invitation", "POST", "", { token: oldToken, password: "the desk chose this one" }));
    expect(dead.status).toBeGreaterThanOrEqual(400);
    const ok = await accept(req("/api/admin/auth/invitation", "POST", "", { token: newToken, password: "the manager chose this one" }));
    const session = ok.cookies.get(ADMIN_SESSION_COOKIE)?.value;
    const who = session ? await getAdminByToken(session) : null;
    expect(who).toMatchObject({ role: "manager", venueId: branch, email: "newmgr@smash.my" });
  });

  it("hides any other link carrying a secret in a message filed under the venue", async () => {
    await enqueue({
      venueId: branch,
      kind: "programme",
      channel: "email",
      recipient: "someone@example.my",
      locale: "en",
      subject: "msg.programmeSubject",
      body: "msg.programmeBody",
      vars: { subject: "An invitation", text: "Join: https://book.example.my/player-invitation?token=SECRETSECRET123 see you" },
    });
    const text = await (await listAs(desk)).text();
    expect(text).not.toContain("SECRETSECRET123");
    expect(text).toContain("(link hidden)");
  });

  it("is not listed to staff of another venue at all", async () => {
    const other = await createVenue({ name: "Elsewhere", area: "JB", address: "1 Jalan X", phone: "0377770009" });
    if (!other.ok) throw new Error("venue");
    expect((await listAs(desk, other.venue.id)).status).toBe(403);
  });
});
