import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

const sent: { to: string; subject: string; text: string }[] = [];
// Emails to staff, applicants and account holders are queued (lib/outbox.ts, emailPlain); each one queued is also noted here.
vi.mock("../src/lib/outbox", async (original) => {
  const real = await original<typeof import("../src/lib/outbox")>();
  return {
    ...real,
    emailPlain: async (input: Parameters<typeof real.emailPlain>[0]) => {
      const queued = await real.emailPlain(input);
      sent.push({ to: input.to, subject: input.subject, text: input.text });
      return queued;
    },
  };
});

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, authenticateAdmin, createAdmin, createAdminSession, ensureBootstrapAdmin, getAdminByToken } from "../src/lib/admin-auth";
import { authenticate, createSession, getUserByToken, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { translateError, translator } from "../src/lib/i18n";
import { changePassword, hasPassword, requestReset, resetPassword, RESETS_PER_HOUR, settleResetRequests } from "../src/lib/password-reset";
import { resetRateLimits } from "../src/lib/rate-limit";
import { POST as forgotUser } from "../src/app/api/auth/forgot/route";
import { POST as resetUser } from "../src/app/api/auth/reset/route";
import { POST as forgotAdmin } from "../src/app/api/admin/auth/forgot/route";
import { POST as resetAdmin } from "../src/app/api/admin/auth/reset/route";
import { GET as myPasswordStatus, POST as changeMine } from "../src/app/api/my/password/route";
import { GET as adminPasswordStatus, POST as changeAdmin } from "../src/app/api/admin/auth/password/route";

/** The token in the last link emailed to this address. */
function linkTokenFor(email: string): string {
  const mail = [...sent].reverse().find((m) => m.to === email);
  if (!mail) throw new Error(`nothing emailed to ${email}`);
  const match = /reset-password\?kind=(?:user|admin)&token=([A-Za-z0-9_-]+)/.exec(mail.text);
  if (!match) throw new Error("no link in the email");
  return match[1];
}

function req(path: string, body: unknown, cookie?: string, method = "POST") {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  });
}

let userId: number;

/** Ask for a link, and wait for the request to be worked through: that happens after the reply (lib/password-reset.ts). */
async function ask(...args: Parameters<typeof requestReset>) {
  // A while after the last request, whose email has gone: asking again makes a new link (ADR 0073 holds a request made within a minute of
  // the last, or while its email has not gone, to the link already out; tests/auth-mail-allowance.test.ts covers that).
  await getDb().prepare("UPDATE messages SET status = 'sent' WHERE kind = 'auth_email' AND status IN ('queued', 'failed')").run();
  await getDb().prepare("UPDATE password_resets SET created_at = datetime(created_at, '-2 minutes')").run();
  const answer = await requestReset(...args);
  await settleResetRequests();
  return answer;
}

beforeAll(async () => {
  const user = await registerUser({ name: "Aisyah Rahman", email: "aisyah@example.com", phone: "0121112222", password: "old-password-1" });
  if (!user.ok) throw new Error(user.error);
  userId = user.user.id;
  await ensureBootstrapAdmin();
});

beforeEach(async () => {
  await settleResetRequests();
  sent.length = 0;
  resetRateLimits();
});

describe("forgot password", () => {
  it("emails a link that sets a new password once, and signs the account out everywhere", async () => {
    const elsewhere = await createSession(userId);
    expect(await ask("user", "aisyah@example.com")).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toMatch(/new password/);
    expect(sent[0].text).toContain("Hi Aisyah");
    const token = linkTokenFor("aisyah@example.com");

    // Only a keyed hash is kept: the token itself is nowhere in the database.
    const rows = (await getDb().prepare("SELECT token_hash FROM password_resets").all()) as { token_hash: string }[];
    expect(rows.some((r) => r.token_hash === token)).toBe(false);

    expect(await resetPassword("user", token, "new-password-2")).toEqual({ ok: true, accountId: userId });
    expect(await authenticate("aisyah@example.com", "new-password-2")).toMatchObject({ id: userId });
    expect(await authenticate("aisyah@example.com", "old-password-1")).toBeNull();
    expect(await getUserByToken(elsewhere.token)).toBeNull();
    // The link went to the address, so the password is its owner's: recorded as proved (lib/oauth.ts keeps it).
    expect(((await getDb().prepare("SELECT email_confirmed_at FROM users WHERE id = ?").get(userId)) as { email_confirmed_at: string | null }).email_confirmed_at).not.toBeNull();

    // Used once, it is spent.
    expect(await resetPassword("user", token, "third-password-3")).toMatchObject({ ok: false, code: "RESET_INVALID" });
  });

  it("never says whether an address has an account", async () => {
    expect(await ask("user", "nobody@example.com")).toEqual({ ok: true });
    expect(sent).toHaveLength(0);
    const res = await forgotUser(req("/api/auth/forgot", { email: "nobody@example.com" }));
    const known = await forgotUser(req("/api/auth/forgot", { email: "aisyah@example.com" }));
    expect(res.status).toBe(200);
    expect(known.status).toBe(200);
    expect(await res.json()).toEqual(await known.json());
  });

  it("runs out after 30 minutes", async () => {
    await ask("user", "aisyah@example.com");
    const token = linkTokenFor("aisyah@example.com");
    await getDb().prepare("UPDATE password_resets SET expires_at = datetime('now', '-1 minutes') WHERE used_at IS NULL").run();
    expect(await resetPassword("user", token, "new-password-9")).toMatchObject({ ok: false, code: "RESET_INVALID" });
  });

  it("voids the other links still out once one is used", async () => {
    await getDb().prepare("DELETE FROM password_resets").run();
    await ask("user", "aisyah@example.com");
    const first = linkTokenFor("aisyah@example.com");
    await ask("user", "aisyah@example.com");
    const second = linkTokenFor("aisyah@example.com");
    expect(first).not.toBe(second);
    expect((await resetPassword("user", second, "new-password-4")).ok).toBe(true);
    expect(await resetPassword("user", first, "new-password-5")).toMatchObject({ ok: false, code: "RESET_INVALID" });
  });

  it("sends at most three links an hour to an account", async () => {
    await getDb().prepare("DELETE FROM password_resets").run();
    for (let i = 0; i < RESETS_PER_HOUR + 2; i++) await ask("user", "aisyah@example.com");
    expect(sent).toHaveLength(RESETS_PER_HOUR);
  });

  it("refuses a short password, a made-up token, and a customer link used for staff", async () => {
    await getDb().prepare("DELETE FROM password_resets").run();
    await ask("user", "aisyah@example.com");
    const token = linkTokenFor("aisyah@example.com");
    expect(await resetPassword("user", token, "short")).toMatchObject({ ok: false, code: "PASSWORD_WEAK" });
    expect(await resetPassword("user", "x".repeat(201), "long-enough-1")).toMatchObject({ ok: false, code: "RESET_INVALID" });
    expect(await resetPassword("user", "not a token!", "long-enough-1")).toMatchObject({ ok: false, code: "RESET_INVALID" });
    expect(await resetPassword("admin", token, "long-enough-1")).toMatchObject({ ok: false, code: "RESET_INVALID" });
    // Still good for what it was for.
    expect((await resetPassword("user", token, "long-enough-1")).ok).toBe(true);
  });

  it("writes to the customer in their language", async () => {
    await getDb().prepare("DELETE FROM password_resets").run();
    await ask("user", "aisyah@example.com", "ms");
    expect(sent[0].subject).toMatch(/kata laluan baharu/);
  });

  it("is said in Malay when refused", () => {
    const ms = translator("ms");
    expect(translateError(ms, { error: "x", code: "RESET_INVALID" })).toMatch(/Pautan itu/);
    expect(translateError(ms, { error: "x", code: "PASSWORD_WEAK", vars: { n: 8 } })).toMatch(/8 aksara/);
  });
});

describe("staff", () => {
  it("reset their own password by email, and are signed in by the link", async () => {
    const made = await createAdmin({ name: "Desk Staff", email: "desk@venue.my", password: "desk-password-1", venueId: null });
    if (!made.ok) throw new Error(made.error);
    const old = await createAdminSession(made.admin.id);

    const asked = await forgotAdmin(req("/api/admin/auth/forgot", { email: "desk@venue.my" }));
    expect(asked.status).toBe(200);
    await settleResetRequests();
    expect(sent[0].text).toContain("kind=admin");
    const token = linkTokenFor("desk@venue.my");

    const res = await resetAdmin(req("/api/admin/auth/reset", { token, password: "desk-password-2" }));
    expect(res.status).toBe(200);
    const cookie = res.cookies.get(ADMIN_SESSION_COOKIE)?.value;
    expect(cookie).toBeTruthy();
    expect(await getAdminByToken(cookie!)).toMatchObject({ id: made.admin.id });
    expect(await getAdminByToken(old.token)).toBeNull();
    expect(await authenticateAdmin("desk@venue.my", "desk-password-2")).toMatchObject({ id: made.admin.id });
  });

  it("change their password while signed in, keeping this session and ending the others", async () => {
    const admin = await authenticateAdmin("desk@venue.my", "desk-password-2");
    const here = await createAdminSession(admin!.id);
    const there = await createAdminSession(admin!.id);
    const cookie = `${ADMIN_SESSION_COOKIE}=${here.token}`;

    const status = await adminPasswordStatus(req("/api/admin/auth/password", null, cookie, "GET"));
    expect(await status.json()).toEqual({ hasPassword: true });

    const wrong = await changeAdmin(req("/api/admin/auth/password", { current: "nope", next: "desk-password-3" }, cookie));
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ code: "PASSWORD_WRONG" });

    const right = await changeAdmin(req("/api/admin/auth/password", { current: "desk-password-2", next: "desk-password-3" }, cookie));
    expect(right.status).toBe(200);
    expect(await getAdminByToken(here.token)).not.toBeNull();
    expect(await getAdminByToken(there.token)).toBeNull();
    expect(await authenticateAdmin("desk@venue.my", "desk-password-3")).not.toBeNull();
  });

  it("must be signed in to change a password", async () => {
    expect((await changeAdmin(req("/api/admin/auth/password", { current: "a", next: "bbbbbbbb" }))).status).toBe(401);
    expect((await adminPasswordStatus(req("/api/admin/auth/password", null, undefined, "GET"))).status).toBe(401);
  });
});

describe("customers signed in", () => {
  it("change their password, and are signed in after a reset through the route", async () => {
    await getDb().prepare("DELETE FROM password_resets").run();
    // The earlier tests asked for more links than one address is sent in a day (the security-mail allowance, ADR 0073).
    await getDb().prepare("DELETE FROM messages WHERE kind = 'auth_email'").run();
    await forgotUser(req("/api/auth/forgot", { email: "aisyah@example.com" }));
    await settleResetRequests();
    const token = linkTokenFor("aisyah@example.com");
    const res = await resetUser(req("/api/auth/reset", { token, password: "route-password-1" }));
    expect(res.status).toBe(200);
    const session = res.cookies.get(SESSION_COOKIE)?.value;
    expect(await getUserByToken(session!)).toMatchObject({ id: userId });

    const cookie = `${SESSION_COOKIE}=${session}`;
    const changed = await changeMine(req("/api/my/password", { current: "route-password-1", next: "route-password-2" }, cookie));
    expect(changed.status).toBe(200);
    expect(await getUserByToken(session!)).not.toBeNull();
    expect(await authenticate("aisyah@example.com", "route-password-2")).not.toBeNull();

    const weak = await changeMine(req("/api/my/password", { current: "route-password-2", next: "short" }, cookie));
    expect(await weak.json()).toMatchObject({ code: "PASSWORD_WEAK" });
  });

  it("who signed up with Google can set a password without one to give", async () => {
    const info = await getDb()
      .prepare("INSERT INTO users (name, email, phone, password_hash) VALUES (?, ?, '', '')")
      .run("Google Person", "g@example.com");
    const id = Number(info.lastInsertRowid);
    expect(await hasPassword("user", id)).toBe(false);
    const session = await createSession(id);
    const cookie = `${SESSION_COOKIE}=${session.token}`;
    expect(await (await myPasswordStatus(req("/api/my/password", null, cookie, "GET"))).json()).toEqual({ hasPassword: false });
    expect(await changePassword("user", id, "", "google-password-1", session.token)).toEqual({ ok: true });
    expect(await hasPassword("user", id)).toBe(true);
    expect(await authenticate("g@example.com", "google-password-1")).toMatchObject({ id });
    // Now there is one, it has to be given.
    expect(await changePassword("user", id, "", "google-password-2", session.token)).toMatchObject({ code: "PASSWORD_WRONG" });
  });

  it("refuses bad requests", async () => {
    expect((await forgotUser(req("/api/auth/forgot", {}))).status).toBe(400);
    expect((await resetUser(req("/api/auth/reset", { token: 1 }))).status).toBe(400);
    const bad = new NextRequest("http://localhost/api/auth/forgot", { method: "POST", body: "{not json" });
    expect((await forgotUser(bad)).status).toBe(400);
    expect((await changeMine(req("/api/my/password", { next: "whatever1" }))).status).toBe(401);
    const session = await createSession(userId);
    expect((await changeMine(req("/api/my/password", {}, `${SESSION_COOKIE}=${session.token}`))).status).toBe(400);
  });

  it("are slowed down like signing in", async () => {
    let last = 200;
    for (let i = 0; i < 12; i++) last = (await forgotUser(req("/api/auth/forgot", { email: "aisyah@example.com" }))).status;
    expect(last).toBe(429);
  });
});
