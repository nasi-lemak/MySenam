import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { registerUser } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { checkProviderReachable, deliveryRecordInstruction, emailConfigState, senderAddress } from "../src/lib/email-config";
import { checkEmailConfiguration, checkEmailHealth, emailHealth, resetEmailHealthClock } from "../src/lib/email-health";
import { drainOutbox, setTransport } from "../src/lib/outbox";
import { settleResetRequests } from "../src/lib/password-reset";
import { resetRateLimits } from "../src/lib/rate-limit";
import { settleRegistrationRequests } from "../src/lib/registration";
import { translator } from "../src/lib/i18n";
import { GET as systemGet, POST as systemPost } from "../src/app/api/admin/system/route";
import { POST as forgotUser } from "../src/app/api/auth/forgot/route";
import { POST as forgotAdmin } from "../src/app/api/admin/auth/forgot/route";
import { POST as startSignUp } from "../src/app/api/auth/register/route";

/**
 * The install's email configuration, validated in one place (lib/email-config.ts, ADR 0073), what a production marketplace does when it
 * cannot deliver (refuse sign-up and forgotten-password requests, honestly), what the owner can see of email (lib/email-health.ts), and
 * that no token, link or credential reaches a log. A fake provider proves the app's handling, not delivery: nothing here is a live check.
 */

const PRODUCTION: Record<string, string> = { NODE_ENV: "production", MYSENAM_MARKETPLACE: "on" };
const SES = { SES_ACCESS_KEY_ID: "AKIAFAKEKEY000001", SES_SECRET_ACCESS_KEY: "fake/secret+KeyValue0123456789", SES_REGION: "ap-southeast-1", MAIL_FROM: "MySenam <no-reply@mail.example.my>" };
const SMTP = { SMTP_URL: "smtps://mailer:s3cr3t-smtp-pass@smtp.example.my:465", MAIL_FROM: "no-reply@mail.example.my" };

let seq = 0;
let ip = 0;
const address = (p: string) => `${p}${++seq}@emailcfg.my`;
function req(path: string, body: unknown, cookie?: string) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.55.${Math.floor(++ip / 250)}.${ip % 250}`, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}
const count = async (sql: string, ...args: unknown[]) => ((await getDb().prepare(sql).get(...args)) as { n: number }).n;

/** Make this process look like an install: production, a marketplace, and these settings, with every other provider setting cleared. */
function install(env: Record<string, string>) {
  for (const name of ["SES_ACCESS_KEY_ID", "SES_SECRET_ACCESS_KEY", "SES_REGION", "SES_SESSION_TOKEN", "SMTP_URL", "MAIL_FROM", "MYSENAM_SEND", "MYSENAM_SYNTHETIC_DATA", "MAIL_DELIVERY_VERIFIED"])
    vi.stubEnv(name, "");
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
});
beforeEach(async () => {
  await resetRateLimits();
  resetEmailHealthClock();
});
afterEach(() => {
  setTransport(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the validator", () => {
  it("development with nothing set up is not configured and blocks nothing", () => {
    expect(emailConfigState({})).toMatchObject({ state: "not_configured", provider: null, productionMarketplace: false, blocksAccountEmail: false });
    expect(emailConfigState({ NODE_ENV: "test", MYSENAM_MARKETPLACE: "on" }).blocksAccountEmail).toBe(false);
  });

  it("a production marketplace with no provider, a half-set one, a bad one, both, or no sender cannot deliver and blocks", () => {
    const cases: [string, Record<string, string>, string][] = [
      ["none", {}, "not_configured"],
      ["a sender and no provider", { MAIL_FROM: "a@b.my" }, "not_configured"],
      ["a provider and no sender (SES)", { SES_ACCESS_KEY_ID: SES.SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY: SES.SES_SECRET_ACCESS_KEY, SES_REGION: SES.SES_REGION }, "missing_sender"],
      ["a provider and no sender (SMTP)", { SMTP_URL: SMTP.SMTP_URL }, "missing_sender"],
      ["half of SES", { SES_REGION: "ap-southeast-1", MAIL_FROM: "a@b.my" }, "invalid"],
      ["a region that is not one", { ...SES, SES_REGION: "somewhere" }, "invalid"],
      ["an SMTP address that is not one", { SMTP_URL: "http://smtp.example.my", MAIL_FROM: "a@b.my" }, "invalid"],
      ["a sender that is not an address", { ...SMTP, MAIL_FROM: "MySenam bookings" }, "invalid"],
      ["SES and SMTP together", { ...SES, SMTP_URL: SMTP.SMTP_URL }, "contradictory"],
    ];
    for (const [name, env, state] of cases) {
      const found = emailConfigState({ ...PRODUCTION, ...env });
      expect(found.state, name).toBe(state);
      expect(found.blocksAccountEmail, name).toBe(true);
      expect(found.problems.length, name).toBeGreaterThan(0);
      // Naming the setting, never the value.
      expect(JSON.stringify(found), name).not.toMatch(/AKIAFAKEKEY|KeyValue0123|s3cr3t-smtp-pass/);
    }
  });

  it("a production install that is not a marketplace is told, and not blocked", () => {
    expect(emailConfigState({ NODE_ENV: "production" })).toMatchObject({ state: "not_configured", productionMarketplace: false, blocksAccountEmail: false });
  });

  it("valid-looking settings are configured, unverified, and block nothing; a delivery check recorded for exactly them verifies", () => {
    for (const env of [SES, SMTP]) {
      const found = emailConfigState({ ...PRODUCTION, ...env });
      expect(found).toMatchObject({ state: "configured_unverified", problems: [], blocksAccountEmail: false });
      expect(found.fingerprint).toMatch(/^[0-9a-f]{16}$/);
      const verified = emailConfigState({ ...PRODUCTION, ...env, MAIL_DELIVERY_VERIFIED: found.fingerprint!.toUpperCase() });
      expect(verified.state).toBe("delivery_verified");
      // Not for another sender, another region or host, or any other text.
      expect(emailConfigState({ ...PRODUCTION, ...env, MAIL_FROM: "other@mail.example.my", MAIL_DELIVERY_VERIFIED: found.fingerprint! }).state).toBe("configured_unverified");
      expect(emailConfigState({ ...PRODUCTION, ...env, MAIL_DELIVERY_VERIFIED: "yes" }).state).toBe("configured_unverified");
    }
    expect(emailConfigState({ ...PRODUCTION, ...SES, SES_REGION: "us-east-1", MAIL_DELIVERY_VERIFIED: emailConfigState({ ...PRODUCTION, ...SES }).fingerprint! }).state).toBe("configured_unverified");
    // Presence of credentials alone never verifies.
    expect(emailConfigState({ ...PRODUCTION, ...SES }).state).not.toBe("delivery_verified");
  });

  it("MYSENAM_SEND=log writes links to the log: refused on a production marketplace, unless synthetic data is declared", () => {
    expect(emailConfigState({ ...PRODUCTION, ...SES, MYSENAM_SEND: "log" })).toMatchObject({ state: "log_only", blocksAccountEmail: true, syntheticLog: false });
    expect(emailConfigState({ ...PRODUCTION, MYSENAM_SEND: "log" }).blocksAccountEmail).toBe(true);
    expect(emailConfigState({ ...PRODUCTION, MYSENAM_SEND: "log", MYSENAM_SYNTHETIC_DATA: "on" })).toMatchObject({ state: "log_only", blocksAccountEmail: false, syntheticLog: true });
    // The declaration is no bypass for an install with nothing set up that does not log.
    expect(emailConfigState({ ...PRODUCTION, MYSENAM_SYNTHETIC_DATA: "on" }).blocksAccountEmail).toBe(true);
    expect(emailConfigState({ ...PRODUCTION, ...SES, MYSENAM_SEND: "log", MYSENAM_SYNTHETIC_DATA: "on", MAIL_DELIVERY_VERIFIED: "x" }).state).toBe("log_only");
    // Development keeps logging.
    expect(emailConfigState({ MYSENAM_SEND: "log" })).toMatchObject({ state: "log_only", blocksAccountEmail: false });
  });

  it("reads a sender as a name and address, or an address", () => {
    expect(senderAddress("MySenam <no-reply@mail.example.my>")).toBe("no-reply@mail.example.my");
    expect(senderAddress("no-reply@mail.example.my")).toBe("no-reply@mail.example.my");
    expect(senderAddress("MySenam")).toBeNull();
    expect(senderAddress("a b@c.my")).toBeNull();
    expect(senderAddress(undefined)).toBeNull();
  });

  it("tells the operator how to record a delivery check, naming the provider and sender, and never records one itself", () => {
    const how = deliveryRecordInstruction({ ...PRODUCTION, ...SES })!;
    expect(how).toContain(`MAIL_DELIVERY_VERIFIED=${emailConfigState({ ...PRODUCTION, ...SES }).fingerprint}`);
    expect(how).toMatch(/confirmed in the inbox/);
    expect(deliveryRecordInstruction({ ...PRODUCTION })).toBeNull();
  });
});

describe("a production marketplace that cannot deliver", () => {
  it("refuses sign-up and forgotten-password requests honestly, the same for every address, and writes nothing down", async () => {
    install({ NODE_ENV: "production", MYSENAM_MARKETPLACE: "on" });
    const known = address("known");
    await registerUser({ name: "Test Person", email: known, phone: "0123456789", password: "a first password" });
    const before = {
      reset: await count("SELECT COUNT(*)::int AS n FROM password_reset_requests"),
      signUp: await count("SELECT COUNT(*)::int AS n FROM registration_requests"),
      mail: await count("SELECT COUNT(*)::int AS n FROM messages"),
    };
    const sentence = translator("en")("err.EMAIL_UNAVAILABLE");
    const bodies = [];
    for (const [route, call] of [
      ["customer reset", () => forgotUser(req("/api/auth/forgot", { email: known }))],
      ["customer reset, unknown", () => forgotUser(req("/api/auth/forgot", { email: address("nobody") }))],
      ["staff reset", () => forgotAdmin(req("/api/admin/auth/forgot", { email: "admin@mysenam.my" }))],
      ["sign-up", () => startSignUp(req("/api/auth/register", { email: known }))],
      ["sign-up, unknown", () => startSignUp(req("/api/auth/register", { email: address("fresh") }))],
    ] as const) {
      const res = await call();
      expect(res.status, route).toBe(503);
      expect(res.headers.get("cache-control"), route).toBe("no-store");
      const body = await res.json();
      expect(body, route).toEqual({ error: sentence, code: "EMAIL_UNAVAILABLE" });
      bodies.push(JSON.stringify(body));
    }
    expect(new Set(bodies).size).toBe(1);
    expect(sentence).toMatch(/contact the venue/);
    await settleResetRequests();
    await settleRegistrationRequests();
    expect(await count("SELECT COUNT(*)::int AS n FROM password_reset_requests")).toBe(before.reset);
    expect(await count("SELECT COUNT(*)::int AS n FROM registration_requests")).toBe(before.signUp);
    expect(await count("SELECT COUNT(*)::int AS n FROM messages")).toBe(before.mail);
  });

  it("says so in all four languages", () => {
    for (const locale of ["en", "ms", "zh", "ta"] as const) expect(translator(locale)("err.EMAIL_UNAVAILABLE")).not.toBe("err.EMAIL_UNAVAILABLE");
  });

  it("refuses with MYSENAM_SEND=log, with an invalid or contradictory setup, and with a missing sender", async () => {
    for (const env of [{ MYSENAM_SEND: "log" }, { ...SES, SES_REGION: "nowhere" }, { ...SES, SMTP_URL: SMTP.SMTP_URL }, { SES_ACCESS_KEY_ID: SES.SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY: SES.SES_SECRET_ACCESS_KEY, SES_REGION: SES.SES_REGION }]) {
      install({ ...PRODUCTION, ...(env as unknown as Record<string, string>) });
      expect((await forgotUser(req("/api/auth/forgot", { email: address("x") }))).status).toBe(503);
      expect((await startSignUp(req("/api/auth/register", { email: address("y") }))).status).toBe(503);
    }
  });

  it("allows the log only for an install that declares synthetic data, and stays loud about it", async () => {
    install({ ...PRODUCTION, MYSENAM_SEND: "log", MYSENAM_SYNTHETIC_DATA: "on" } as Record<string, string>);
    expect((await startSignUp(req("/api/auth/register", { email: address("synthetic") }))).status).toBe(202);
    const told = await checkEmailConfiguration();
    expect(told?.level).toBe("warn");
    expect(await count("SELECT COUNT(*)::int AS n FROM system_alerts WHERE key = 'config:email'")).toBe(1);
  });

  it("development and tests keep mock and log transports and are never blocked", async () => {
    install({});
    expect((await startSignUp(req("/api/auth/register", { email: address("dev") }))).status).toBe(202);
    expect((await forgotUser(req("/api/auth/forgot", { email: address("dev") }))).status).toBe(200);
    install({ MYSENAM_SEND: "log" });
    expect((await forgotUser(req("/api/auth/forgot", { email: address("dev") }))).status).toBe(200);
  });

  it("a venue's own install (not a marketplace) with no email is warned about, and not blocked", async () => {
    install({ NODE_ENV: "production" });
    expect((await forgotUser(req("/api/auth/forgot", { email: address("single") }))).status).toBe(200);
    expect(await checkEmailConfiguration()).toMatchObject({ level: "warn" });
  });
});

describe("what the owners are told at start-up, and when it is put right", () => {
  const alert = async () => (await getDb().prepare("SELECT subject, last_detail FROM system_alerts WHERE key = 'config:email'").get()) as { subject: string; last_detail: string } | undefined;

  it("an error and an alert while requests are refused; a warning and an alert while unverified; nothing once verified", async () => {
    const none = await checkEmailConfiguration({ ...PRODUCTION });
    expect(none?.level).toBe("error");
    expect(none?.message).toMatch(/refused/);
    expect((await alert())?.subject).toMatch(/sign-up and forgotten-password requests are switched off/);

    const unverified = await checkEmailConfiguration({ ...PRODUCTION, ...SES });
    expect(unverified?.level).toBe("warn");
    expect(unverified?.message).not.toMatch(/AKIAFAKEKEY|KeyValue0123/);
    expect((await alert())?.subject).toMatch(/has not been verified/);

    const fingerprint = emailConfigState({ ...PRODUCTION, ...SES }).fingerprint!;
    expect(await checkEmailConfiguration({ ...PRODUCTION, ...SES, MAIL_DELIVERY_VERIFIED: fingerprint })).toBeNull();
    expect(await alert()).toBeUndefined();
    // A development machine is never told.
    expect(await checkEmailConfiguration({})).toBeNull();
  });
});

describe("a provider that is down, then back", () => {
  it("queues the request, tells the person nothing false, alerts the owners, and sends the link after recovery while it is valid", async () => {
    install({ ...PRODUCTION, ...SES } as Record<string, string>);
    const logged: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" ")));
    const calls: { url: string; method: string }[] = [];
    let up = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | string, init?: RequestInit) => {
        calls.push({ url: String(url), method: init?.method ?? "GET" });
        if (!up) throw new TypeError(`fetch failed: connect ETIMEDOUT while signing with ${SES.SES_ACCESS_KEY_ID} / ${SES.SES_SECRET_ACCESS_KEY}`);
        return new Response(JSON.stringify({ MessageId: "ses-accepted-1" }), { status: 200, headers: { "content-type": "application/json" } });
      })
    );
    const to = address("outage");
    await registerUser({ name: "Test Person", email: to, phone: "0123456789", password: "a first password" });

    // Not blocked: the install looks configured. The reply is the usual one; nothing is claimed sent.
    const res = await forgotUser(req("/api/auth/forgot", { email: to }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await settleResetRequests();
    const message = async () => (await getDb().prepare("SELECT id, status, attempts, sent_at, last_error, body, params, expires_at FROM messages WHERE recipient = ? AND kind = 'auth_email'").get(to)) as {
      id: number; status: string; attempts: number; sent_at: string | null; last_error: string | null; body: string; params: string | null; expires_at: string;
    };
    const first = await message();
    expect(first.status).toBe("failed");
    expect(first.sent_at).toBeNull();
    expect(first.last_error).toMatch(/could not be reached/);
    expect(first.last_error).not.toMatch(/AKIAFAKEKEY|KeyValue0123/);
    const token = /token=([A-Za-z0-9_-]+)/.exec(first.body)![1];
    expect(emailConfigState().state).toBe("configured_unverified");

    // The owners can see the provider failing, once enough was tried.
    for (let i = 0; i < 5; i++)
      await getDb().prepare("INSERT INTO messages (venue_id, kind, channel, recipient, subject, body, status, attempts, last_error, last_attempt_at) VALUES (NULL, 'programme', 'email', ?, 's', 'b', 'failed', 1, 'Amazon SES is throttling or unavailable (503)', datetime('now'))").run(`filler${i}@emailcfg.my`);
    await checkEmailHealth(Date.now());
    expect(await count("SELECT COUNT(*)::int AS n FROM system_alerts WHERE key = 'email:failing'")).toBe(1);

    // Back up inside the link's life: it goes, once, and nothing else is sent to the person.
    up = true;
    await getDb().prepare("UPDATE messages SET next_attempt_at = datetime('now', '-1 minutes') WHERE id = ?").run(first.id);
    await drainOutbox();
    const after = await message();
    expect(after).toMatchObject({ status: "sent", attempts: 2 });
    expect(after.sent_at).not.toBeNull();
    expect(after.body).not.toMatch(/token=/);
    expect(after.params).toBeNull();
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/v2/email/outbound-emails"))).toBe(true);
    const providerId = (await getDb().prepare("SELECT provider_id FROM messages WHERE id = ?").get(first.id)) as { provider_id: string };
    expect(providerId.provider_id).toBe("ses-accepted-1");

    // No token, link or credential in any log, or kept beside the messages.
    const everything = logged.join("\n");
    for (const secret of [token, "reset-password", SES.SES_ACCESS_KEY_ID, SES.SES_SECRET_ACCESS_KEY]) expect(everything).not.toContain(secret);
    const kept = await getDb().prepare("SELECT body, params, last_error FROM messages WHERE kind = 'auth_email' OR last_error IS NOT NULL").all();
    expect(JSON.stringify(kept)).not.toContain(token);
    expect(JSON.stringify(kept)).not.toContain(SES.SES_SECRET_ACCESS_KEY);
    expect(JSON.stringify(await getDb().prepare("SELECT last_detail, subject FROM system_alerts").all())).not.toMatch(/AKIAFAKEKEY|KeyValue0123|reset-password/);
  });
});

describe("what the owner can see", () => {
  const insert = (status: string, extra: { kind?: string; lastAttempt?: string | null; created?: string; error?: string | null } = {}) =>
    getDb()
      .prepare(
        `INSERT INTO messages (venue_id, kind, channel, recipient, subject, body, status, attempts, last_error, created_at, last_attempt_at)
         VALUES (NULL, ?, 'email', ?, 's', 'b', ?, 1, ?, COALESCE(?, datetime('now')), ?)`
      )
      .run(extra.kind ?? "programme", `health${++seq}@emailcfg.my`, status, extra.error ?? null, extra.created ?? null, extra.lastAttempt === undefined ? null : extra.lastAttempt);

  it("counts the last hour's tries, the oldest waiting, and what was given up, security mail apart", async () => {
    await getDb().prepare("DELETE FROM messages").run();
    for (let i = 0; i < 3; i++) await insert("sent", { lastAttempt: "2999-01-01 00:00:00" });
    await insert("failed", { lastAttempt: "2999-01-01 00:00:00", error: "refused" });
    await insert("queued", { created: new Date(Date.now() - 50 * 60_000).toISOString().replace("T", " ").slice(0, 19) });
    await insert("abandoned", { kind: "auth_email", error: "Not sent: already 10 sign-in and account emails to this address today" });
    await insert("abandoned", { kind: "auth_email", error: "Not sent: it ran out before it could go (the link in it no longer works)." });
    await insert("abandoned", { error: "Not sent: already 8 messages to this recipient today." });
    const health = await emailHealth({ ...PRODUCTION, ...SES });
    expect(health.config).toMatchObject({ state: "configured_unverified", provider: "ses" });
    expect(health.lastHour).toEqual({ sent: 3, failed: 1, failureRate: 0.25 });
    expect(health.queued.count).toBe(2);
    expect(health.queued.oldestMinutes).toBeGreaterThanOrEqual(49);
    expect(health.givenUp24h).toEqual({ total: 3, security: 2, securityAllowance: 1 });
  });

  it("raises an alert when mail piles up, and when the provider mostly fails; and clears each when it stops", async () => {
    await getDb().prepare("DELETE FROM messages").run();
    await getDb().prepare("DELETE FROM system_alerts").run();
    await insert("queued", { created: new Date(Date.now() - 45 * 60_000).toISOString().replace("T", " ").slice(0, 19) });
    for (let i = 0; i < 6; i++) await insert("failed", { lastAttempt: "2999-01-01 00:00:00", error: "Amazon SES is throttling or unavailable (503): slow down" });
    await checkEmailHealth(Date.now());
    const keys = ((await getDb().prepare("SELECT key FROM system_alerts ORDER BY key").all()) as { key: string }[]).map((r) => r.key);
    expect(keys).toEqual(expect.arrayContaining(["email:backlog", "email:failing"]));
    // At most every five minutes.
    await getDb().prepare("DELETE FROM messages").run();
    await checkEmailHealth(Date.now() + 60_000);
    expect(await count("SELECT COUNT(*)::int AS n FROM system_alerts WHERE key IN ('email:backlog', 'email:failing')")).toBe(2);
    await checkEmailHealth(Date.now() + 6 * 60_000);
    expect(await count("SELECT COUNT(*)::int AS n FROM system_alerts WHERE key IN ('email:backlog', 'email:failing')")).toBe(0);
  });

  it("does not take a venue's campaign still waiting its turn for a backlog", async () => {
    await getDb().prepare("DELETE FROM messages").run();
    await insert("queued", { kind: "campaign", created: new Date(Date.now() - 90 * 60_000).toISOString().replace("T", " ").slice(0, 19) });
    expect((await emailHealth()).queued).toEqual({ count: 0, oldestMinutes: null });
  });

  it("is in the owner's system answer, and the reachable check is the owner's to ask", async () => {
    const owner = await createAdmin({ name: "Owner Two", email: address("owner"), password: "a long enough password", venueId: null, businessId: null });
    if (!owner.ok) throw new Error(owner.error);
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(owner.admin.id)).token}`;
    const get = (c?: string) => new NextRequest("http://localhost/api/admin/system", { headers: c ? { cookie: c } : {} });
    expect((await systemGet(get())).status).toBe(401);
    const answer = await (await systemGet(get(cookie))).json();
    expect(answer.email).toMatchObject({ config: { state: expect.any(String) }, lastHour: { sent: expect.any(Number) }, queued: { count: expect.any(Number) }, givenUp24h: { security: expect.any(Number) } });

    install({ ...SES });
    const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) => new Response(JSON.stringify({ SendingEnabled: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const asked = await systemPost(new NextRequest("http://localhost/api/admin/system", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ check: "email" }) }));
    expect((await asked.json()).email).toMatchObject({ reachable: true });
    // It asked the account, and sent nothing.
    expect(fetchMock.mock.calls.every(([url, init]) => String(url).endsWith("/v2/email/account") && (init as RequestInit).method === "GET")).toBe(true);
    expect((await systemPost(new NextRequest("http://localhost/api/admin/system", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ check: "email" }) }))).status).toBe(401);
  });
});

describe("the provider-reachable check", () => {
  it("is explicit: it asks Amazon SES for the account and never sends a message", async () => {
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET" });
      return new Response(JSON.stringify({ SendingEnabled: true }), { status: 200 });
    }));
    expect(await checkProviderReachable({ ...PRODUCTION, ...SES })).toMatchObject({ reachable: true });
    expect(calls).toEqual([{ url: "https://email.ap-southeast-1.amazonaws.com/v2/email/account", method: "GET" }]);
  });

  it("says no when the key is refused, a provider that is down, and nothing when there is nothing to ask", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "The security token included in the request is invalid." }), { status: 403, headers: { "x-amzn-errortype": "UnrecognizedClientException" } })));
    const refused = await checkProviderReachable({ ...PRODUCTION, ...SES });
    expect(refused.reachable).toBe(false);
    expect(refused.detail).not.toMatch(/KeyValue0123|AKIAFAKEKEY/);
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError(`connect ETIMEDOUT ${SES.SES_SECRET_ACCESS_KEY}`);
    }));
    const down = await checkProviderReachable({ ...PRODUCTION, ...SES });
    expect(down.reachable).toBe(false);
    expect(down.detail).not.toContain(SES.SES_SECRET_ACCESS_KEY);
    expect(await checkProviderReachable({})).toMatchObject({ reachable: null });
    expect(await checkProviderReachable({ ...SES, SMTP_URL: SMTP.SMTP_URL })).toMatchObject({ reachable: null });
  });

  it("tries an SMTP server without sending, and never reports its password", async () => {
    const found = await checkProviderReachable({ SMTP_URL: "smtp://mailer:s3cr3t-smtp-pass@127.0.0.1:1", MAIL_FROM: "a@b.my" });
    expect(found.reachable).toBe(false);
    expect(found.detail).not.toContain("s3cr3t-smtp-pass");
  });
});

describe("the owners' text", () => {
  it("is written in all three staff languages", async () => {
    const { default: area } = await import("../src/lib/staff-i18n/server");
    for (const key of Object.keys(area.en).filter((k) => k.startsWith("srv.email.") || k.startsWith("srv.authmail.") || k === "srv.msgKind.auth_email")) {
      expect(area.ms[key as keyof typeof area.en], key).toBeTruthy();
      expect(area.zh[key as keyof typeof area.en], key).toBeTruthy();
    }
  });
});
