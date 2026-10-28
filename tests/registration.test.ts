import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { authenticate, createSession, getUserByToken, hashPassword, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { translator } from "../src/lib/i18n";
import { signInWithIdentity } from "../src/lib/oauth";
import { resetRateLimits, POLICIES } from "../src/lib/rate-limit";
import {
  completeRegistration,
  processRegistrationRequests,
  REGISTRATION_EMAILS_PER_DAY,
  REGISTRATION_EMAILS_PER_HOUR,
  REGISTRATION_MINUTES,
  registrationLink,
  requestRegistration,
  settleRegistrationRequests,
} from "../src/lib/registration";
import { tickOutbox } from "../src/lib/notify";
import { POST as start } from "../src/app/api/auth/register/route";
import { POST as check } from "../src/app/api/auth/register/link/route";
import { POST as complete } from "../src/app/api/auth/register/complete/route";

/**
 * Signing up by an emailed link (lib/registration.ts; the owner's decision of
 * 28 October 2026): the form never says whether an address has an account,
 * the account is made only by the link emailed to the address, and an address
 * that already has one is told so by email, with no link that changes it.
 */

const en = translator("en");
let ip = 0;
const IP = () => `10.7.0.${++ip}`;

function req(path: string, body: unknown, opts: { ip?: string; cookie?: string } = {}) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": opts.ip ?? IP(), ...(opts.cookie ? { cookie: opts.cookie } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

interface Mail {
  subject: string;
  body: string;
  kind: string;
  venue_id: number | null;
  locale: string;
}
const mailsTo = async (address: string) =>
  (await getDb()
    .prepare("SELECT subject, body, kind, venue_id, locale FROM messages WHERE lower(recipient) = lower(?) ORDER BY id")
    .all(address)) as Mail[];

const TOKEN = /\/register\?token=([A-Za-z0-9_-]+)/;
/** The token in the newest link emailed to this address. */
async function tokenFor(address: string): Promise<string> {
  const mail = (await mailsTo(address)).reverse().find((m) => TOKEN.test(m.body));
  if (!mail) throw new Error(`no sign-up link emailed to ${address}`);
  return TOKEN.exec(mail.body)![1];
}

/** Ask to sign up, and wait for the request to be worked through (that happens after the reply). */
async function ask(email: string, locale: "en" | "ms" | "zh" | "ta" = "en") {
  const answer = await requestRegistration(email, locale);
  await settleRegistrationRequests();
  return answer;
}

const usersWith = async (email: string) =>
  ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM users WHERE email = ?").get(email)) as { n: number }).n;

const details = { name: "Nur Aina", phone: "0123456789", password: "a long enough password" };

beforeAll(async () => {
  const made = await registerUser({ name: "Existing Person", email: "existing@signup.my", phone: "0121110000", password: "the existing password" });
  if (!made.ok) throw new Error(made.error);
});

beforeEach(async () => {
  await settleRegistrationRequests();
  await resetRateLimits();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("starting to sign up", () => {
  it("answers the same, status, body and headers, for a new address, an account's, a pending one and one past its caps", async () => {
    await ask("pending@signup.my");
    for (let i = 0; i < REGISTRATION_EMAILS_PER_DAY; i++) await ask("capped@signup.my");
    const answers = [];
    for (const email of ["brand-new@signup.my", "existing@signup.my", "EXISTING@signup.my", "pending@signup.my", "capped@signup.my"]) {
      const res = await start(req("/api/auth/register", { email }));
      answers.push({
        status: res.status,
        body: await res.json(),
        cookie: res.headers.get("set-cookie"),
        headers: [...res.headers.keys()].sort(),
      });
    }
    expect(answers[0]).toEqual({ status: 202, body: { ok: true }, cookie: null, headers: answers[0].headers });
    for (const a of answers) expect(a).toEqual(answers[0]);
    await settleRegistrationRequests();
  });

  it("takes the address only: a name, phone or password sent with it is not kept, and no account is made", async () => {
    const res = await start(req("/api/auth/register", { email: "old-form@signup.my", name: "Old Form", phone: "0129999999", password: "sent-too-early" }));
    expect(res.status).toBe(202);
    const queued = (await getDb().prepare("SELECT * FROM registration_requests WHERE email = 'old-form@signup.my'").get()) as Record<string, unknown>;
    expect(Object.keys(queued).sort()).toEqual(["created_at", "email", "id", "locale"]);
    await settleRegistrationRequests();
    expect(await usersWith("old-form@signup.my")).toBe(0);
    expect(JSON.stringify(await getDb().prepare("SELECT * FROM registration_links WHERE email = 'old-form@signup.my'").all())).not.toContain("Old Form");
  });

  it("refuses what is not an address, whatever it is", async () => {
    for (const body of [{}, { email: "" }, { email: "not-an-address" }, { email: 42 }, { email: `${"a".repeat(320)}@x.my` }]) {
      const res = await start(req("/api/auth/register", body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Please provide a valid email address." });
    }
    expect((await start(req("/api/auth/register", "{not json"))).status).toBe(400);
  });

  it("limits each client address, the same for an account's address as any other", async () => {
    const from = IP();
    for (let i = 0; i < POLICIES.register.limit; i++)
      expect((await start(req("/api/auth/register", { email: i % 2 ? "existing@signup.my" : `ip${i}@signup.my` }, { ip: from }))).status).toBe(202);
    for (const email of ["existing@signup.my", "nobody-ip@signup.my"]) {
      const res = await start(req("/api/auth/register", { email }, { ip: from }));
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBeTruthy();
    }
    await settleRegistrationRequests();
  });

  it("is worked through by the scheduler too, and a request older than a link's life is dropped unsent", async () => {
    await getDb()
      .prepare(`INSERT INTO registration_requests (email, locale, created_at) VALUES ('late@signup.my', 'en', datetime('now', '-${REGISTRATION_MINUTES + 1} minutes'))`)
      .run();
    expect(await processRegistrationRequests()).toBe(0);
    await getDb().prepare("INSERT INTO registration_requests (email, locale) VALUES ('scheduled@signup.my', 'en')").run();
    await tickOutbox();
    expect(await mailsTo("scheduled@signup.my")).toHaveLength(1);
    expect(await mailsTo("late@signup.my")).toHaveLength(0);
    expect((await getDb().prepare("SELECT COUNT(*)::int AS n FROM registration_requests").get()) as { n: number }).toEqual({ n: 0 });
  });
});

describe("the email", () => {
  it("sends a new address a single link to finish, held like a password reset's, its token kept only as a hash", async () => {
    await ask("first-time@signup.my");
    const mails = await mailsTo("first-time@signup.my");
    expect(mails).toHaveLength(1);
    const [mail] = mails;
    expect(mail).toMatchObject({ subject: en("su7.mail.new.s"), kind: "account_email", venue_id: null, locale: "en" });
    const token = await tokenFor("first-time@signup.my");
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(mail.body).toContain(`/register?token=${token}&lang=en`);
    expect(mail.body).toContain(`${REGISTRATION_MINUTES} minutes`);
    const rows = (await getDb().prepare("SELECT token_hash, kind, expires_at, created_at FROM registration_links WHERE email = 'first-time@signup.my'").all()) as {
      token_hash: string;
      kind: string;
      expires_at: string;
      created_at: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("link");
    expect(rows[0].token_hash).not.toContain(token);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(`${rows[0].expires_at.replace(" ", "T")}Z`) - Date.parse(`${rows[0].created_at.replace(" ", "T")}Z`)).toBe(REGISTRATION_MINUTES * 60_000);
    // The email is not sent once the link has run out.
    const expires = (await getDb().prepare("SELECT expires_at FROM messages WHERE recipient = 'first-time@signup.my'").get()) as { expires_at: string | null };
    expect(expires.expires_at).toBeTruthy();
  });

  it("tells an address with an account that it has one, how to sign in and set a new password, and carries nothing that changes it", async () => {
    const before = (await getDb().prepare("SELECT password_hash FROM users WHERE email = 'existing@signup.my'").get()) as { password_hash: string };
    const user = (await getDb().prepare("SELECT id FROM users WHERE email = 'existing@signup.my'").get()) as { id: number };
    const session = await createSession(user.id);
    await getDb().prepare("DELETE FROM registration_links WHERE email = 'existing@signup.my'").run();
    const had = (await mailsTo("existing@signup.my")).length;
    await ask("Existing@Signup.my");
    const mails = await mailsTo("existing@signup.my");
    expect(mails).toHaveLength(had + 1);
    const mail = mails.at(-1)!;
    expect(mail).toMatchObject({ subject: en("su7.mail.existing.s"), kind: "account_email", venue_id: null });
    expect(mail.body).toContain("Hi Existing,");
    expect(mail.body).toContain("/login?lang=en");
    expect(mail.body).toContain("/forgot-password?lang=en");
    expect(mail.body).toContain(en("su7.mail.existing.reset", { link: "" }).trim());
    // Nothing in it creates, changes or links anything: no token of any kind.
    expect(mail.body).not.toMatch(/token=|\/register|\/reset-password|google/i);
    const links = [...mail.body.matchAll(/https?:\/\/\S+/g)].map((m) => new URL(m[0]).pathname).sort();
    expect(links).toEqual(["/forgot-password", "/login"]);
    expect((await getDb().prepare("SELECT token_hash, kind FROM registration_links WHERE email = 'existing@signup.my'").all()) as unknown[]).toEqual([{ token_hash: null, kind: "notice" }]);
    // The account is as it was: the same password, still signed in, no reset link made for it.
    expect((await getDb().prepare("SELECT password_hash FROM users WHERE email = 'existing@signup.my'").get()) as { password_hash: string }).toEqual(before);
    expect(await getUserByToken(session.token)).toMatchObject({ id: user.id });
    expect((await getDb().prepare("SELECT COUNT(*)::int AS n FROM password_resets").get()) as { n: number }).toEqual({ n: 0 });
    expect(await authenticate("existing@signup.my", "the existing password")).toMatchObject({ id: user.id });
  });

  it("tells an account that uses Google to continue with Google, and one with no password how to set one", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "client-123.apps.googleusercontent.com");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "secret");
    const made = await signInWithIdentity({ provider: "google", subject: "g-signup-1", email: "googler@signup.my", emailVerified: true, name: "Gee Person" });
    expect(made).toMatchObject({ ok: true, created: true });
    await ask("googler@signup.my", "ms");
    const [mail] = await mailsTo("googler@signup.my");
    const ms = translator("ms");
    expect(mail.subject).toBe(ms("su7.mail.existing.s"));
    expect(mail.locale).toBe("ms");
    expect(mail.body).toContain(ms("su7.mail.existing.google"));
    expect(mail.body).toContain(ms("su7.mail.existing.setPassword", { link: "" }).trim());
    expect(mail.body).not.toContain(ms("su7.mail.existing.reset", { link: "" }).trim());
    expect(mail.body).toContain("/login?lang=ms");
    expect(mail.body).not.toMatch(/token=/);
    // Where the install offers no Google button, it does not tell them to press one.
    vi.unstubAllEnvs();
    await getDb().prepare("DELETE FROM registration_links WHERE email = 'googler@signup.my'").run();
    await ask("googler@signup.my");
    const [, second] = await mailsTo("googler@signup.my");
    expect(second.body).not.toContain(en("su7.mail.existing.google"));
  });

  it("writes to a new address in the visitor's language, its link opening in it", async () => {
    await ask("bahasa@signup.my", "ms");
    const [mail] = await mailsTo("bahasa@signup.my");
    expect(mail.subject).toBe(translator("ms")("su7.mail.new.s"));
    expect(mail.body).toMatch(/\/register\?token=[A-Za-z0-9_-]+&lang=ms/);
    // The route takes the language the page says it is in.
    const res = await start(req("/api/auth/register", { email: "tamil@signup.my", locale: "ta" }));
    expect(res.status).toBe(202);
    await settleRegistrationRequests();
    expect((await mailsTo("tamil@signup.my"))[0].subject).toBe(translator("ta")("su7.mail.new.s"));
  });

  it("sends an address at most a few an hour and a day, of both kinds, and answers the same past them", async () => {
    for (let i = 0; i < REGISTRATION_EMAILS_PER_HOUR + 2; i++) await ask("hourly@signup.my");
    expect(await mailsTo("hourly@signup.my")).toHaveLength(REGISTRATION_EMAILS_PER_HOUR);
    // An hour on, more may go, up to the day's.
    await getDb().prepare("UPDATE registration_links SET created_at = datetime('now', '-2 hours') WHERE email = 'hourly@signup.my'").run();
    for (let i = 0; i < REGISTRATION_EMAILS_PER_DAY; i++) await ask("hourly@signup.my");
    expect(await mailsTo("hourly@signup.my")).toHaveLength(REGISTRATION_EMAILS_PER_DAY);
    // A day on, the rows that counted are gone, and so is the cap.
    await getDb().prepare("UPDATE registration_links SET created_at = datetime('now', '-25 hours') WHERE email = 'hourly@signup.my'").run();
    await ask("hourly@signup.my");
    expect(await mailsTo("hourly@signup.my")).toHaveLength(REGISTRATION_EMAILS_PER_DAY + 1);
    expect((await getDb().prepare("SELECT COUNT(*)::int AS n FROM registration_links WHERE email = 'hourly@signup.my'").get()) as { n: number }).toEqual({ n: 1 });
    // An account's address is capped the same way.
    await getDb().prepare("DELETE FROM registration_links WHERE email = 'existing@signup.my'").run();
    const had = (await mailsTo("existing@signup.my")).length;
    for (let i = 0; i < REGISTRATION_EMAILS_PER_HOUR + 1; i++) await ask("existing@signup.my");
    expect(await mailsTo("existing@signup.my")).toHaveLength(had + REGISTRATION_EMAILS_PER_HOUR);
  });
});

describe("the link", () => {
  it("shows the address, makes the account once and signs it in; used again it makes nothing", async () => {
    await ask("finisher@signup.my", "zh");
    const token = await tokenFor("finisher@signup.my");
    const shown = await check(req("/api/auth/register/link", { token }));
    expect(shown.status).toBe(200);
    expect(await shown.json()).toEqual({ email: "finisher@signup.my" });

    const res = await complete(req("/api/auth/register/complete", { token, ...details }));
    expect(res.status).toBe(201);
    const { user } = (await res.json()) as { user: { id: number; email: string; name: string; phone: string } };
    expect(user).toMatchObject({ email: "finisher@signup.my", name: "Nur Aina", phone: "0123456789" });
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(await getUserByToken(/ms_session=([^;]+)/.exec(cookie)![1])).toMatchObject({ id: user.id });
    expect(await authenticate("finisher@signup.my", details.password)).toMatchObject({ id: user.id });
    // In the language the sign-up was asked in.
    expect((await getDb().prepare("SELECT locale FROM users WHERE id = ?").get(user.id)) as { locale: string }).toEqual({ locale: "zh" });
    // The link proved the address: Google joining the account later keeps its password (lib/oauth.ts).
    expect(((await getDb().prepare("SELECT email_confirmed_at FROM users WHERE id = ?").get(user.id)) as { email_confirmed_at: string | null }).email_confirmed_at).not.toBeNull();

    const again = await complete(req("/api/auth/register/complete", { token, ...details, name: "Somebody Else" }));
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ code: "REGISTRATION_INVALID", error: en("err.REGISTRATION_INVALID") });
    expect((await check(req("/api/auth/register/link", { token }))).status).toBe(400);
    expect(await usersWith("finisher@signup.my")).toBe(1);
    expect((await getDb().prepare("SELECT name FROM users WHERE email = 'finisher@signup.my'").get()) as { name: string }).toEqual({ name: "Nur Aina" });
  });

  it("checks what the account needs before using the link up", async () => {
    await ask("careful@signup.my");
    const token = await tokenFor("careful@signup.my");
    const refusals = [
      [{ ...details, name: "N" }, "Please provide your name."],
      [{ ...details, phone: "call me" }, "Please provide a valid phone number."],
      [{ ...details, password: "short" }, en("err.PASSWORD_WEAK", { n: 8 })],
      [{ ...details, password: "x".repeat(201) }, en("err.PASSWORD_WEAK", { n: 8 })],
    ] as const;
    for (const [body, error] of refusals) {
      const res = await complete(req("/api/auth/register/complete", { token, ...body }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(error);
    }
    expect((await complete(req("/api/auth/register/complete", { token, name: 3, phone: details.phone, password: details.password }))).status).toBe(400);
    // Still good after all that.
    expect(await registrationLink(token)).toEqual({ ok: true, email: "careful@signup.my" });
  });

  it("runs out after its time", async () => {
    await ask("slow@signup.my");
    const token = await tokenFor("slow@signup.my");
    await getDb().prepare("UPDATE registration_links SET expires_at = datetime('now', '-1 minutes') WHERE email = 'slow@signup.my'").run();
    expect(await registrationLink(token)).toMatchObject({ ok: false, code: "REGISTRATION_INVALID" });
    expect(await completeRegistration(token, details)).toMatchObject({ ok: false, code: "REGISTRATION_INVALID" });
    expect(await usersWith("slow@signup.my")).toBe(0);
  });

  it("works only while it is the newest for its address", async () => {
    await ask("twice@signup.my");
    const first = await tokenFor("twice@signup.my");
    await ask("twice@signup.my");
    const second = await tokenFor("twice@signup.my");
    expect(second).not.toBe(first);
    expect(await registrationLink(first)).toMatchObject({ ok: false, code: "REGISTRATION_INVALID" });
    expect(await completeRegistration(first, details)).toMatchObject({ ok: false, code: "REGISTRATION_INVALID" });
    expect(await completeRegistration(second, details)).toMatchObject({ ok: true });
    // One open link per address at most, whatever writes them.
    await ask("one-open@signup.my");
    await expect(
      getDb()
        .prepare("INSERT INTO registration_links (email, kind, token_hash, locale, expires_at) VALUES ('ONE-OPEN@signup.my', 'link', 'x', 'en', datetime('now', '+1 hour'))")
        .run()
    ).rejects.toThrow();
  });

  it("gives every link that cannot be used one answer, which says to sign in", async () => {
    for (const token of ["", "short", "x".repeat(32), "!".repeat(32)]) {
      expect(await registrationLink(token)).toEqual({ ok: false, error: en("err.REGISTRATION_INVALID"), code: "REGISTRATION_INVALID" });
      expect(await completeRegistration(token, details)).toEqual({ ok: false, error: en("err.REGISTRATION_INVALID"), code: "REGISTRATION_INVALID" });
    }
    expect(en("err.REGISTRATION_INVALID")).toMatch(/Sign in/);
    const res = await check(req("/api/auth/register/link", { token: "x".repeat(32) }));
    expect(res.status).toBe(400);
    expect((await check(req("/api/auth/register/link", {}))).status).toBe(400);
    expect((await complete(req("/api/auth/register/complete", { ...details }))).status).toBe(400);
  });
});

describe("no account taken over, one account per address", () => {
  it("voids a link once the address has an account made with Google first", async () => {
    await ask("google-first@signup.my");
    const token = await tokenFor("google-first@signup.my");
    const google = await signInWithIdentity({ provider: "google", subject: "g-signup-2", email: "google-first@signup.my", emailVerified: true, name: "Google First" });
    expect(google).toMatchObject({ ok: true, created: true });
    expect(await registrationLink(token)).toMatchObject({ ok: false, code: "REGISTRATION_INVALID" });
    expect(await completeRegistration(token, details)).toMatchObject({ ok: false, code: "REGISTRATION_INVALID" });
    expect(await usersWith("google-first@signup.my")).toBe(1);
    // The Google account keeps no password anybody set through the link.
    expect((await getDb().prepare("SELECT password_hash, name FROM users WHERE email = 'google-first@signup.my'").get()) as object).toEqual({ password_hash: "", name: "Google First" });
    // And the link is recorded as void, not used.
    expect((await getDb().prepare("SELECT used_at, replaced_at FROM registration_links WHERE email = 'google-first@signup.my'").get()) as { used_at: string | null; replaced_at: string | null }).toMatchObject({ used_at: null });
  });

  it("voids a link once the address has an account made another way", async () => {
    await ask("other-route@signup.my");
    const token = await tokenFor("other-route@signup.my");
    const made = await registerUser({ name: "Other Route", email: "Other-Route@signup.my", phone: "0128888888", password: "another password" });
    expect(made.ok).toBe(true);
    expect(await completeRegistration(token, details)).toMatchObject({ ok: false, code: "REGISTRATION_INVALID" });
    expect(await usersWith("other-route@signup.my")).toBe(1);
    expect(await authenticate("other-route@signup.my", "another password")).toMatchObject({ name: "Other Route" });
  });

  it("makes one account when the same link is used several times at once", async () => {
    await ask("at-once@signup.my");
    const token = await tokenFor("at-once@signup.my");
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => completeRegistration(token, { ...details, name: `Racer ${i}` })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const r of results.filter((x) => !x.ok)) expect(r).toMatchObject({ code: "REGISTRATION_INVALID" });
    expect(await usersWith("at-once@signup.my")).toBe(1);
  });

  it("makes one account when a link races Google and another route for one address", async () => {
    await ask("three-ways@signup.my");
    const token = await tokenFor("three-ways@signup.my");
    const outcomes = await Promise.allSettled([
      completeRegistration(token, details),
      signInWithIdentity({ provider: "google", subject: "g-signup-3", email: "three-ways@signup.my", emailVerified: true, name: "Three Ways" }),
      registerUser({ name: "Third Way", email: "three-ways@signup.my", phone: "0127777777", password: "a third password" }),
    ]);
    expect(await usersWith("three-ways@signup.my")).toBe(1);
    const byLink = outcomes[0];
    expect(byLink.status).toBe("fulfilled");
    const linkWon = byLink.status === "fulfilled" && byLink.value.ok;
    const id = ((await getDb().prepare("SELECT id FROM users WHERE email = 'three-ways@signup.my'").get()) as { id: number }).id;
    if (linkWon) expect((byLink.value as { ok: true; user: { id: number } }).user.id).toBe(id);
    else expect(byLink.status === "fulfilled" && byLink.value).toMatchObject({ code: "REGISTRATION_INVALID" });
  });

  it("issues one open link when one address's requests are worked through at once", async () => {
    await getDb().prepare("INSERT INTO registration_requests (email, locale) VALUES ('busy@signup.my', 'en'), ('busy@signup.my', 'en'), ('busy@signup.my', 'en')").run();
    await Promise.all([processRegistrationRequests(1), processRegistrationRequests(1), processRegistrationRequests(1)]);
    const open = (await getDb()
      .prepare("SELECT COUNT(*)::int AS n FROM registration_links WHERE email = 'busy@signup.my' AND used_at IS NULL AND replaced_at IS NULL")
      .get()) as { n: number };
    expect(open).toEqual({ n: 1 });
    // Only the newest emailed works.
    const tokens = (await mailsTo("busy@signup.my")).map((m) => TOKEN.exec(m.body)![1]);
    const usable = [];
    for (const t of tokens) if ((await registrationLink(t)).ok) usable.push(t);
    expect(usable).toHaveLength(1);
  });

  it("never lets the existing-account notice set a password: it has no token, and a made-up one does nothing", async () => {
    await getDb().prepare("DELETE FROM registration_links WHERE email = 'existing@signup.my'").run();
    await ask("existing@signup.my");
    const hash = (await getDb().prepare("SELECT password_hash FROM users WHERE email = 'existing@signup.my'").get()) as { password_hash: string };
    expect(await completeRegistration("A".repeat(32), { ...details, password: "attacker password" })).toMatchObject({ ok: false });
    expect((await getDb().prepare("SELECT password_hash FROM users WHERE email = 'existing@signup.my'").get()) as object).toEqual(hash);
    expect(await authenticate("existing@signup.my", "attacker password")).toBeNull();
    // A password hash is never what a link stores.
    expect(hashPassword("x")).not.toBe(hash.password_hash);
  });
});
