import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { registerUser } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { authMailPerRecipientPerDay, drainOutbox, enqueue, emailPlain, retryMessage, retryFailedMessages, sentToday, setTransport, listPlatformMessages, type OutboxMessage } from "../src/lib/outbox";
import { AUTH_MAIL_COOLDOWN_SECONDS, processResetRequests, requestReset, resetPassword, RESETS_PER_HOUR, settleResetRequests } from "../src/lib/password-reset";
import { completeRegistration, processRegistrationRequests, requestRegistration, settleRegistrationRequests, registrationLink } from "../src/lib/registration";
import { resetRateLimits } from "../src/lib/rate-limit";
import { PermanentSendError } from "../src/lib/send-errors";
import { POST as forgotUser } from "../src/app/api/auth/forgot/route";
import { POST as forgotAdmin } from "../src/app/api/admin/auth/forgot/route";
import { POST as startSignUp } from "../src/app/api/auth/register/route";
import { createAdmin } from "../src/lib/admin-auth";

/**
 * Security-critical mail (sign-up links, password-reset links, security notices) is its own class of message, `auth_email`
 * (ADR 0073): it is not held to, and never counted in, the day's limit for ordinary mail; it has an allowance of its own, a cooldown
 * between links, and no second link while one is waiting. Past its allowance a message is written off with the reason, the owners
 * are told, and its link is void. A provider outage delays it (tried again soon, while the link is valid); a link that ran out is
 * dropped unsent and the owners are told. Nothing here ever says whether an address has an account.
 */

let seq = 0;
let ip = 0;
const IP = () => `10.44.${Math.floor(++ip / 250)}.${ip % 250}`;
const address = (prefix: string) => `${prefix}${++seq}@authmail.my`;

function req(path: string, body: unknown, from: string = IP()) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": from },
    body: JSON.stringify(body),
  });
}

async function customer(email: string): Promise<number> {
  const made = await registerUser({ name: "Test Person", email, phone: "0123456789", password: "a first password" });
  if (!made.ok) throw new Error(made.error);
  return made.user.id;
}

/** Eight ordinary messages to an address (a day's limit for ordinary mail), as booking confirmations would be. */
async function ordinary(to: string, n = 8): Promise<void> {
  for (let i = 0; i < n; i++)
    await enqueue({ venueId: null, kind: "programme", channel: "email", recipient: to, subject: "msg.programmeSubject", body: "msg.programmeBody", vars: { subject: "A game", text: `message ${i}` } });
}

interface Row {
  id: number;
  kind: string;
  status: string;
  attempts: number;
  last_error: string | null;
  body: string;
  sent_at: string | null;
  expires_at: string | null;
}
const rowsFor = async (to: string, kind = "auth_email"): Promise<Row[]> =>
  (await getDb()
    .prepare("SELECT id, kind, status, attempts, last_error, body, sent_at, expires_at FROM messages WHERE lower(recipient) = lower(?) AND kind = ? ORDER BY id")
    .all(to, kind)) as Row[];
const count = async (sql: string, ...args: unknown[]) => ((await getDb().prepare(sql).get(...args)) as { n: number }).n;

const RESET_TOKEN = /reset-password\?kind=(?:user|admin)&token=([A-Za-z0-9_-]+)/;
const SIGN_UP_TOKEN = /register\?token=([A-Za-z0-9_-]+)/;
const tokenIn = (body: string, pattern: RegExp) => pattern.exec(body)?.[1] ?? null;

async function askReset(email: string) {
  const answer = await requestReset("user", email, "en");
  await settleResetRequests();
  return answer;
}
async function askSignUp(email: string) {
  const answer = await requestRegistration(email, "en");
  await settleRegistrationRequests();
  return answer;
}

/** The time a cooldown takes, without waiting: the last links were made two minutes ago. */
async function minutesLater() {
  await getDb().prepare("UPDATE password_resets SET created_at = datetime(created_at, '-2 minutes')").run();
  await getDb().prepare("UPDATE registration_links SET created_at = datetime(created_at, '-2 minutes')").run();
}

/** A provider that takes everything, and keeps what it was given. */
function goodProvider() {
  const taken: OutboxMessage[] = [];
  setTransport({
    name: "good",
    send: async (m) => {
      taken.push(m);
      return { providerId: `p-${m.id}` };
    },
  });
  return taken;
}
function downProvider(error: Error = new Error("connect ECONNREFUSED smtp")) {
  setTransport({
    name: "down",
    send: async () => {
      throw error;
    },
  });
}
const makeDue = () => getDb().prepare("UPDATE messages SET next_attempt_at = datetime('now', '-1 minutes') WHERE status IN ('queued', 'failed')").run();

beforeAll(async () => {
  await ensureBootstrapAdmin();
});

beforeEach(async () => {
  await settleResetRequests();
  await settleRegistrationRequests();
  await resetRateLimits();
});

afterEach(() => {
  setTransport(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("eight ordinary messages to an address", () => {
  it("do not make its password-reset link vanish", async () => {
    const to = address("reset");
    await customer(to);
    await ordinary(to);
    expect(await sentToday("email", to)).toBe(8);
    await askReset(to);
    const [mail] = await rowsFor(to);
    expect(mail).toMatchObject({ kind: "auth_email", status: "queued", last_error: null });
    expect(tokenIn(mail.body, RESET_TOKEN)).not.toBeNull();
    // Sent when the provider takes it; the link is not kept afterwards.
    const taken = goodProvider();
    await drainOutbox();
    expect(taken.filter((m) => m.kind === "auth_email")).toHaveLength(1);
    expect(taken.find((m) => m.kind === "auth_email")!.body).toMatch(RESET_TOKEN);
    const [after] = await rowsFor(to);
    expect(after.status).toBe("sent");
    expect(after.body).not.toMatch(/token=/);
  });

  it("do not make a sign-up link vanish either, nor the notice an existing account is sent", async () => {
    const fresh = address("signup");
    await ordinary(fresh);
    await askSignUp(fresh);
    const [link] = await rowsFor(fresh);
    expect(link).toMatchObject({ kind: "auth_email", status: "queued" });
    expect(tokenIn(link.body, SIGN_UP_TOKEN)).not.toBeNull();
    expect(await registrationLink(tokenIn(link.body, SIGN_UP_TOKEN)!)).toMatchObject({ ok: true, email: fresh });

    const existing = address("existing");
    await customer(existing);
    await ordinary(existing);
    await askSignUp(existing);
    const [notice] = await rowsFor(existing);
    expect(notice).toMatchObject({ kind: "auth_email", status: "queued" });
  });

  it("are still all sent: the ordinary limit is unchanged, and a ninth ordinary message is still written off", async () => {
    const to = address("limit");
    await customer(to);
    await ordinary(to);
    await askReset(to);
    const ninth = await enqueue({ venueId: null, kind: "programme", channel: "email", recipient: to, subject: "msg.programmeSubject", body: "msg.programmeBody", vars: { subject: "s", text: "ninth" } });
    expect(ninth.status).toBe("abandoned");
    expect(ninth.lastError).toMatch(/already 8 messages/);
  });
});

describe("security mail is counted apart from ordinary mail", () => {
  it("a flood of reset links to a victim never uses up their booking confirmations, and stops at its own allowance", async () => {
    const victim = address("victim");
    const ceiling = authMailPerRecipientPerDay();
    expect(ceiling).toBe(10);
    for (let i = 0; i < ceiling; i++) expect((await emailPlain({ to: victim, subject: "Reset", text: `link ${i}`, kind: "auth_email" })).status).toBe("queued");
    const over = await emailPlain({ to: victim, subject: "Reset", text: "one more", kind: "auth_email" });
    expect(over).toMatchObject({ status: "abandoned" });
    expect(over.lastError).toMatch(/security mail/);
    // A full day of security mail left every ordinary message to the address untouched.
    expect(await sentToday("email", victim, undefined, ["auth_email"])).toBe(0);
    for (let i = 0; i < 8; i++) expect((await enqueue({ venueId: null, kind: "programme", channel: "email", recipient: victim, subject: "msg.programmeSubject", body: "msg.programmeBody", vars: { subject: "s", text: `m${i}` } })).status).toBe("queued");
  });

  it("is a configurable allowance, from 5 to 100 a day", () => {
    vi.stubEnv("MYSENAM_AUTH_MAIL_PER_RECIPIENT_PER_DAY", "7");
    expect(authMailPerRecipientPerDay()).toBe(7);
    vi.stubEnv("MYSENAM_AUTH_MAIL_PER_RECIPIENT_PER_DAY", "2");
    expect(authMailPerRecipientPerDay()).toBe(10);
    vi.stubEnv("MYSENAM_AUTH_MAIL_PER_RECIPIENT_PER_DAY", "nonsense");
    expect(authMailPerRecipientPerDay()).toBe(10);
  });

  it("is handled like any account email: the link is hidden from staff, never readdressed, never put back by staff", async () => {
    const to = address("hidden");
    await customer(to);
    await askReset(to);
    const [mail] = await rowsFor(to);
    const listed = (await listPlatformMessages(200)).find((m) => m.id === mail.id)!;
    expect(listed.kind).toBe("auth_email");
    expect(listed.body).not.toMatch(/token=/);
    expect(listed.params).toBeNull();
    // Given up (the provider refused it for good), it cannot be sent again to anybody by staff.
    setTransport({ name: "refuses", send: async () => { throw new PermanentSendError("not an address"); } });
    await drainOutbox();
    expect(await retryMessage(mail.id)).toMatchObject({ ok: false });
    expect(await retryMessage(mail.id, "someone.else@authmail.my")).toMatchObject({ ok: false });
    expect(await retryFailedMessages(1, { since: "2000-01-01 00:00:00", until: "2100-01-01 00:00:00" })).toMatchObject({ requeued: 0 });
  });
});

describe("repeated and concurrent requests", () => {
  it("five clicks in a row make one link and one email, and every reply is the same", async () => {
    const to = address("clicks");
    await customer(to);
    const replies = [];
    for (let i = 0; i < 5; i++) replies.push(await askReset(to));
    expect(new Set(replies.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(await rowsFor(to)).toHaveLength(1);
    expect(await count("SELECT COUNT(*)::int AS n FROM password_resets WHERE account_id = (SELECT id FROM users WHERE email = ?)", to)).toBe(1);
  });

  it("asked again while the first email has not gone (the provider is down), reuses it even after the cooldown", async () => {
    const to = address("waiting");
    await customer(to);
    downProvider();
    await askReset(to);
    await drainOutbox();
    expect((await rowsFor(to))[0].status).toBe("failed");
    await minutesLater();
    await askReset(to);
    await askReset(to);
    expect(await rowsFor(to)).toHaveLength(1);
    // Back up: that one link goes, the one the person has been waiting for.
    const taken = goodProvider();
    await makeDue();
    await drainOutbox();
    expect(taken.filter((m) => m.recipient === to)).toHaveLength(1);
    expect((await rowsFor(to))[0].status).toBe("sent");
  });

  it("asked again after the first has gone and the cooldown passed, makes a second link, up to three an hour", async () => {
    const to = address("hourly");
    await customer(to);
    goodProvider();
    for (let i = 0; i < RESETS_PER_HOUR + 3; i++) {
      await askReset(to);
      await drainOutbox();
      await minutesLater();
    }
    expect(await rowsFor(to)).toHaveLength(RESETS_PER_HOUR);
    expect(AUTH_MAIL_COOLDOWN_SECONDS).toBe(60);
  });

  it("cannot be used to mail-bomb an address: many requests from many places for one account make three emails at most", async () => {
    const victim = address("bomb");
    await customer(victim);
    goodProvider();
    for (let i = 0; i < 40; i++) {
      const res = await forgotUser(req("/api/auth/forgot", { email: victim }));
      expect(res.status).toBe(200);
      if (i % 5 === 4) {
        await settleResetRequests();
        await drainOutbox();
        await minutesLater();
      }
    }
    await settleResetRequests();
    expect((await rowsFor(victim)).length).toBeLessThanOrEqual(RESETS_PER_HOUR);
    expect((await rowsFor(victim)).length).toBeGreaterThanOrEqual(1);
  });

  it("requests that arrive together make one link and one email", async () => {
    const to = address("race");
    await customer(to);
    await Promise.all(Array.from({ length: 12 }, () => requestReset("user", to, "en")));
    // Several workers at once, as two servers would be.
    await Promise.all(Array.from({ length: 4 }, () => processResetRequests(3)));
    await settleResetRequests();
    await processResetRequests();
    expect(await rowsFor(to)).toHaveLength(1);
    expect(await count("SELECT COUNT(*)::int AS n FROM password_resets WHERE account_id = (SELECT id FROM users WHERE email = ?)", to)).toBe(1);
  });

  it("sign-up requests that arrive together make one link and one email", async () => {
    const to = address("signrace");
    await Promise.all(Array.from({ length: 12 }, () => requestRegistration(to, "en")));
    await Promise.all(Array.from({ length: 4 }, () => processRegistrationRequests(3)));
    await settleRegistrationRequests();
    await processRegistrationRequests();
    expect(await rowsFor(to)).toHaveLength(1);
    expect(await count("SELECT COUNT(*)::int AS n FROM registration_links WHERE email = ?", to)).toBe(1);
  });
});

describe("the allowance used up", () => {
  async function useUpAllowance(to: string) {
    for (let i = 0; i < authMailPerRecipientPerDay(); i++) await emailPlain({ to, subject: "Earlier", text: `earlier ${i}`, kind: "auth_email" });
  }

  it("writes a reset email off with its reason, voids its link, tells the owners once, and never says sent", async () => {
    const to = address("full");
    await customer(to);
    await useUpAllowance(to);
    const taken = goodProvider();
    const answer = await askReset(to);
    expect(answer).toEqual({ ok: true });
    const rows = await rowsFor(to);
    const last = rows[rows.length - 1];
    expect(last.status).toBe("abandoned");
    expect(last.last_error).toMatch(/^Not sent: already 10 sign-in and account emails/);
    expect(last.body).not.toMatch(/token=/);
    // Its link is void: nobody holds it, and nothing can use it.
    expect(await count("SELECT COUNT(*)::int AS n FROM password_resets WHERE account_id = (SELECT id FROM users WHERE email = ?) AND used_at IS NULL", to)).toBe(0);
    await drainOutbox();
    expect(taken.some((m) => m.id === last.id)).toBe(false);
    expect((await rowsFor(to)).find((r) => r.id === last.id)!.status).toBe("abandoned");
    expect((await rowsFor(to)).find((r) => r.id === last.id)!.sent_at).toBeNull();
    // The owners are told, once, without the address.
    const alert = (await getDb().prepare("SELECT subject, last_detail, count FROM system_alerts WHERE key = 'auth-mail-ceiling'").get()) as { subject: string; last_detail: string; count: number };
    expect(alert.subject).toMatch(/security-mail allowance/);
    expect(alert.last_detail).not.toContain(to);
    await minutesLater();
    await askReset(to);
    expect(await count("SELECT COUNT(*)::int AS n FROM system_alerts WHERE key = 'auth-mail-ceiling'")).toBe(1);
    // The owner sees it in the platform's messages, as not sent, with the reason.
    const listed = (await listPlatformMessages(500)).find((m) => m.id === last.id)!;
    expect(listed).toMatchObject({ status: "abandoned", kind: "auth_email" });
    expect(listed.lastError).toMatch(/Not sent/);
  });

  it("writes a sign-up link off the same way, and the reply is the one everybody gets", async () => {
    const to = address("fullsign");
    await useUpAllowance(to);
    const res = await startSignUp(req("/api/auth/register", { email: to }));
    const other = await startSignUp(req("/api/auth/register", { email: address("fresh") }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual(await other.json());
    await settleRegistrationRequests();
    const rows = await rowsFor(to);
    const last = rows[rows.length - 1];
    expect(last.status).toBe("abandoned");
    expect(await count("SELECT COUNT(*)::int AS n FROM registration_links WHERE email = ? AND kind = 'link' AND replaced_at IS NULL AND used_at IS NULL", to)).toBe(0);
  });
});

describe("the provider failing", () => {
  it("a temporary failure is tried again soon, while the link is valid, and the link is not lost meanwhile", async () => {
    const to = address("outage");
    await customer(to);
    downProvider(new Error("Amazon SES is throttling or unavailable (503): try later"));
    await askReset(to);
    await drainOutbox();
    const [failed] = await rowsFor(to);
    expect(failed).toMatchObject({ status: "failed", attempts: 1, sent_at: null });
    expect(failed.last_error).toMatch(/throttling/);
    // Not "sent", and still holding the link, which is still valid.
    expect(failed.body).toMatch(RESET_TOKEN);
    // The next try is within the link's life: a minute, then two, five, ten (not the half hour the ordinary backoff reaches).
    expect(await count("SELECT COUNT(*)::int AS n FROM messages WHERE id = ? AND next_attempt_at > datetime('now') AND next_attempt_at <= datetime('now', '+2 minutes')", failed.id)).toBe(1);
    await makeDue();
    await drainOutbox();
    expect(await count("SELECT COUNT(*)::int AS n FROM messages WHERE id = ? AND attempts = 2 AND next_attempt_at > datetime('now', '+1 minutes') AND next_attempt_at <= datetime('now', '+3 minutes')", failed.id)).toBe(1);
    // Recovered: it goes, once, and the link is not kept.
    const taken = goodProvider();
    await makeDue();
    await drainOutbox();
    expect(taken.filter((m) => m.id === failed.id)).toHaveLength(1);
    const [sent] = await rowsFor(to);
    expect(sent).toMatchObject({ status: "sent", attempts: 3 });
    expect(sent.sent_at).not.toBeNull();
    expect(sent.body).not.toMatch(/token=/);
    // The one-time token still works once, and then no more.
    const token = tokenIn(taken.find((m) => m.id === failed.id)!.body, RESET_TOKEN)!;
    expect(await resetPassword("user", token, "a new password 1")).toMatchObject({ ok: true });
    expect(await resetPassword("user", token, "a new password 2")).toMatchObject({ ok: false, code: "RESET_INVALID" });
  });

  it("a permanent refusal is given up at once, with its reason, and its link is not kept", async () => {
    const to = address("refused");
    await customer(to);
    setTransport({ name: "refuses", send: async () => { throw new PermanentSendError(`${to} is not an email address.`); } });
    await askReset(to);
    await drainOutbox();
    const [given] = await rowsFor(to);
    expect(given).toMatchObject({ status: "abandoned", attempts: 1 });
    expect(given.last_error).toMatch(/is not an email address/);
    expect(given.body).not.toMatch(/token=/);
    expect(given.sent_at).toBeNull();
  });

  it("a link that ran out before delivery is dropped unsent, the owners are told, and the token is dead", async () => {
    const to = address("late");
    await customer(to);
    downProvider();
    await askReset(to);
    await drainOutbox();
    const [waiting] = await rowsFor(to);
    const token = tokenIn(waiting.body, RESET_TOKEN)!;
    // The provider is back only after the link stopped working.
    await getDb().prepare("UPDATE messages SET expires_at = datetime('now', '-1 minutes') WHERE id = ?").run(waiting.id);
    await getDb().prepare("UPDATE password_resets SET expires_at = datetime('now', '-1 minutes') WHERE used_at IS NULL").run();
    const taken = goodProvider();
    await makeDue();
    await drainOutbox();
    expect(taken.some((m) => m.id === waiting.id)).toBe(false);
    const [dropped] = await rowsFor(to);
    expect(dropped).toMatchObject({ status: "abandoned", sent_at: null });
    expect(dropped.last_error).toMatch(/ran out before it could go/);
    expect(dropped.body).not.toMatch(/token=/);
    expect(await resetPassword("user", token, "a new password 3")).toMatchObject({ ok: false, code: "RESET_INVALID" });
    const alert = (await getDb().prepare("SELECT subject FROM system_alerts WHERE key = 'auth-mail-expired'").get()) as { subject: string } | undefined;
    expect(alert?.subject).toMatch(/ran out before they could be sent/);
    // Asking again, a minute or more later, makes a new link (the old one is neither waiting nor cooling).
    await minutesLater();
    await askReset(to);
    const rows = await rowsFor(to);
    expect(rows).toHaveLength(2);
    expect(rows[1].status).toBe("sent");
  });

  it("a sign-up link is single-use, and only the newest for an address works", async () => {
    const to = address("once");
    await askSignUp(to);
    const token = tokenIn((await rowsFor(to))[0].body, SIGN_UP_TOKEN)!;
    expect(await completeRegistration(token, { name: "Nur Aina", phone: "0123456789", password: "a long enough password" })).toMatchObject({ ok: true });
    expect(await completeRegistration(token, { name: "Nur Aina", phone: "0123456789", password: "a long enough password" })).toMatchObject({ ok: false, code: "REGISTRATION_INVALID" });
  });
});

describe("challenges written before the message was linked to them (migration 0344)", () => {
  it("a reset link of the old shape, with no message beside it, is not waiting and not cooling: a new request makes a new link", async () => {
    const to = address("legacy");
    const id = await customer(to);
    await getDb()
      .prepare("INSERT INTO password_resets (kind, account_id, token_hash, expires_at, created_at) VALUES ('user', ?, 'legacy-hash-0001', datetime('now', '+20 minutes'), datetime('now', '-10 minutes'))")
      .run(id);
    await getDb().prepare("INSERT INTO registration_links (email, kind, token_hash, locale, expires_at, created_at) VALUES (?, 'link', 'legacy-hash-0002', 'en', datetime('now', '+50 minutes'), datetime('now', '-10 minutes'))").run(address("legacyreg"));
    await askReset(to);
    expect(await rowsFor(to)).toHaveLength(1);
    expect(await count("SELECT COUNT(*)::int AS n FROM password_resets WHERE account_id = ?", id)).toBe(2);
  });
});

describe("nothing about accounts is revealed", () => {
  it("an unknown address gets the same reply as a known one, and no email, link or row", async () => {
    const known = address("known");
    await customer(known);
    const a = await forgotUser(req("/api/auth/forgot", { email: known }));
    const b = await forgotUser(req("/api/auth/forgot", { email: address("nobody") }));
    expect(a.status).toBe(b.status);
    expect(await a.json()).toEqual(await b.json());
    expect([...a.headers.entries()].filter(([k]) => /^(content-type|cache-control)$/.test(k))).toEqual([...b.headers.entries()].filter(([k]) => /^(content-type|cache-control)$/.test(k)));
    await settleResetRequests();
    expect(await rowsFor(known)).toHaveLength(1);
    expect(await count("SELECT COUNT(*)::int AS n FROM messages WHERE recipient LIKE 'nobody%@authmail.my'")).toBe(0);
    expect(await count("SELECT COUNT(*)::int AS n FROM password_resets")).toBeGreaterThanOrEqual(1);
  });

  it("an exhausted allowance and a cooling request answer exactly as a first request does", async () => {
    const to = address("same");
    await customer(to);
    const first = await forgotUser(req("/api/auth/forgot", { email: to }));
    await settleResetRequests();
    const second = await forgotUser(req("/api/auth/forgot", { email: to }));
    expect(second.status).toBe(first.status);
    expect(await second.json()).toEqual(await first.json());
  });
});

describe("several customers behind one network", () => {
  it("ten customers asking for resets from one address all get their links (30 an hour per address)", async () => {
    const site = "203.0.113.7";
    const people = Array.from({ length: 10 }, () => address("lounge"));
    for (const p of people) await customer(p);
    for (const p of people) expect((await forgotUser(req("/api/auth/forgot", { email: p }, site))).status).toBe(200);
    await settleResetRequests();
    for (const p of people) expect(await rowsFor(p)).toHaveLength(1);
  });

  it("the sixth sign-up from one address in an hour is turned away (5 an hour per address), a different address is not", async () => {
    const site = "203.0.113.8";
    for (let i = 0; i < 5; i++) expect((await startSignUp(req("/api/auth/register", { email: address("wifi") }, site))).status).toBe(202);
    expect((await startSignUp(req("/api/auth/register", { email: address("wifi") }, site))).status).toBe(429);
    expect((await startSignUp(req("/api/auth/register", { email: address("wifi") }, "203.0.113.9"))).status).toBe(202);
  });

  it("an operator can raise the per-address limits for a shared network", async () => {
    vi.stubEnv("MYSENAM_SIGNUPS_PER_ADDRESS_PER_HOUR", "20");
    vi.stubEnv("MYSENAM_RESETS_PER_ADDRESS_PER_HOUR", "not a number");
    vi.resetModules();
    const fresh = await import("../src/lib/rate-limit");
    expect(fresh.POLICIES.register.limit).toBe(20);
    expect(fresh.POLICIES.forgot.limit).toBe(30);
  });

  it("staff asking for a reset are held to the same, and a staff account's link is security mail too", async () => {
    const owner = await createAdmin({ name: "Staff Person", email: address("staff"), password: "a long enough password", venueId: null, businessId: null });
    if (!owner.ok) throw new Error(owner.error);
    const res = await forgotAdmin(req("/api/admin/auth/forgot", { email: owner.admin.email }));
    expect(res.status).toBe(200);
    await minutesLater();
    await requestReset("admin", owner.admin.email, "en");
    await settleResetRequests();
    const rows = await rowsFor(owner.admin.email);
    expect(rows).toHaveLength(1);
    expect(tokenIn(rows[0].body, RESET_TOKEN)).not.toBeNull();
  });
});
