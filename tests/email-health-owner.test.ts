import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { raiseAlert } from "../src/lib/alerts";
import { getDb } from "../src/lib/db";
import { emailConfigState } from "../src/lib/email-config";
import { emailHealth, sanitizedReason } from "../src/lib/email-health";
import { createVenue } from "../src/lib/store";
import { GET as systemGet } from "../src/app/api/admin/system/route";

/**
 * What the owner's *Email* section is given (`GET /api/admin/system`, `email`; lib/email-health.ts): configuration, the queue, what the provider accepted,
 * what failed or was given up (security mail apart), recent reasons with nothing of the message in them, the open email alerts and the warnings, and a
 * no-data state. Read from the outbox only: no provider is asked, and "accepted" is never "delivered".
 */

const SES = { SES_ACCESS_KEY_ID: "AKIAFAKEKEY000777", SES_SECRET_ACCESS_KEY: "fake/secret+PanelKey0123456789", SES_REGION: "ap-southeast-1", MAIL_FROM: "MySenam <no-reply@mail.example.my>" };
const SMTP_PASSWORD = "Sm7pPassw0rdXyz";
const SMTP_URL = `smtp://mailer:${SMTP_PASSWORD}@smtp.example.my:587`;
const PRODUCTION = { NODE_ENV: "production", MYSENAM_MARKETPLACE: "on" };
let ownerCookie: string;
let managerCookie: string;
let deskCookie: string;
let seq = 0;

const insert = (status: string, extra: { kind?: string; minutesAgo?: number; triedMinutesAgo?: number | null; error?: string | null; sentMinutesAgo?: number } = {}) =>
  getDb()
    .prepare(
      `INSERT INTO messages (venue_id, kind, channel, recipient, subject, body, status, attempts, last_error, created_at, last_attempt_at, sent_at)
       VALUES (NULL, ?, 'email', ?, 's', 'b', ?, 1, ?, datetime('now', ?), ${extra.triedMinutesAgo === null || extra.triedMinutesAgo === undefined ? "NULL" : "datetime('now', ?)"}, ${extra.sentMinutesAgo === undefined ? "NULL" : "datetime('now', ?)"})`
    )
    .run(
      extra.kind ?? "staff_alert",
      `panel${++seq}@private.example`,
      status,
      extra.error ?? null,
      `-${extra.minutesAgo ?? 0} minutes`,
      ...(extra.triedMinutesAgo === null || extra.triedMinutesAgo === undefined ? [] : [`-${extra.triedMinutesAgo} minutes`]),
      ...(extra.sentMinutesAgo === undefined ? [] : [`-${extra.sentMinutesAgo} minutes`])
    );

const get = async (cookie: string) => systemGet(new NextRequest("http://localhost/api/admin/system", { headers: { cookie } }));

const saved: Record<string, string | undefined> = {};
const setEnv = (vars: Record<string, string>) => {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in saved)) saved[k] = process.env[k];
    process.env[k] = v;
  }
};

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const owner = (await getDb().prepare("SELECT id FROM admins WHERE venue_id IS NULL AND business_id IS NULL ORDER BY id LIMIT 1").get()) as { id: number };
  ownerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(owner.id)).token}`;
  const v = await createVenue({ name: "Panel Venue", area: "PJ", address: "x", phone: "0300000591", openHour: 6, closeHour: 23 });
  if (!v.ok) throw new Error("venue");
  const m = await createAdmin({ name: "Manager", email: "mgr@panel.my", password: "a-long-password-1", venueId: v.venue.id });
  const d = await createAdmin({ name: "Desk", email: "desk@panel.my", password: "a-long-password-1", venueId: v.venue.id, role: "desk" });
  if (!m.ok || !d.ok) throw new Error("admin");
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(m.admin.id)).token}`;
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(d.admin.id)).token}`;
});

beforeEach(async () => {
  await getDb().prepare("DELETE FROM messages").run();
  await getDb().prepare("DELETE FROM system_alerts").run();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete saved[k];
  }
});

describe("the owner's Email section: what the backend gives", () => {
  it("no messages at all is a no-data state, with the configuration still said", async () => {
    const h = await emailHealth({});
    expect(h.noData).toBe(true);
    expect(h.config.state).toBe("not_configured");
    expect(h.warnings).toEqual(["cannot_deliver"]);
    expect(h.queued).toEqual({ count: 0, oldestMinutes: null });
    expect(h.lastDay).toEqual({ sent: 0, failed: 0, lastSentAt: null });
    expect(h.recentFailures).toEqual([]);
  });

  it("counts queued (with the oldest), accepted in the hour and the day, failed, and given up, security mail apart", async () => {
    await insert("queued", { minutesAgo: 12 });
    await insert("queued", { minutesAgo: 3 });
    for (let i = 0; i < 2; i++) await insert("sent", { minutesAgo: 20, triedMinutesAgo: 20, sentMinutesAgo: 20 });
    await insert("sent", { minutesAgo: 300, triedMinutesAgo: 300, sentMinutesAgo: 300 });
    await insert("sent", { minutesAgo: 3000, triedMinutesAgo: 3000, sentMinutesAgo: 3000 });
    await insert("failed", { minutesAgo: 25, triedMinutesAgo: 25, error: "connect ETIMEDOUT" });
    await insert("abandoned", { kind: "auth_email", minutesAgo: 90, error: "Not sent: it ran out before it could go (the link in it no longer works)." });
    await insert("abandoned", { kind: "auth_email", minutesAgo: 90, error: "Not sent: already 10 sign-in and account emails to this address today" });
    await insert("failed", { kind: "auth_email", minutesAgo: 5, triedMinutesAgo: 5, error: "Throttling" });
    await insert("abandoned", { minutesAgo: 60 * 30, error: "old, outside the day" });
    const h = await emailHealth({ ...SES });
    expect(h.noData).toBe(false);
    expect(h.queued.count).toBe(4);
    expect(h.queued.oldestMinutes).toBeGreaterThanOrEqual(24);
    expect(h.lastHour).toMatchObject({ sent: 2, failed: 2 });
    expect(h.lastDay).toMatchObject({ sent: 3, failed: 2 });
    expect(h.lastDay.lastSentAt).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    expect(h.givenUp24h).toEqual({ total: 2, security: 2, securityAllowance: 1, securityExpired: 1 });
    expect(h.securityRetrying).toBe(1);
    expect(h.warnings).toEqual(["unverified", "security_mail"]);
    expect(h.recentFailures.map((f) => [f.kind, f.status, f.reason])).toEqual([
      ["auth_email", "failed", "Throttling"],
      ["staff_alert", "failed", "connect ETIMEDOUT"],
      ["auth_email", "abandoned", "Not sent: already 10 sign-in and account emails to this address today"],
      ["auth_email", "abandoned", "Not sent: it ran out before it could go (the link in it no longer works)."],
    ]);
  });

  it("warns when the provider fails at the alert's rate and when mail has waited past the backlog limit", async () => {
    for (let i = 0; i < 4; i++) await insert("failed", { minutesAgo: 10, triedMinutesAgo: 10, error: "454 Throttling failure" });
    await insert("sent", { minutesAgo: 10, triedMinutesAgo: 10, sentMinutesAgo: 10 });
    await insert("queued", { minutesAgo: 45 });
    const h = await emailHealth({ ...SES });
    expect(h.warnings).toEqual(expect.arrayContaining(["failing", "backlog"]));
    expect(h.recentFailures[0]).toMatchObject({ reason: "454 Throttling failure", count: 4 });
    expect(h.thresholds).toEqual({ failingMinTries: 5, failingShare: 0.5, backlogMinutes: 30 });
  });

  it("delivery verified is the validator's reading, never a value: none, recorded for another provider, or this one", async () => {
    expect((await emailHealth({ ...SES })).config).toMatchObject({ state: "configured_unverified", deliveryCheck: "none" });
    expect((await emailHealth({ ...SES, MAIL_DELIVERY_VERIFIED: "0000000000000000" })).config).toMatchObject({ state: "configured_unverified", deliveryCheck: "other" });
    const fingerprint = emailConfigState({ ...SES }).fingerprint!;
    const verified = await emailHealth({ ...SES, MAIL_DELIVERY_VERIFIED: fingerprint });
    expect(verified.config).toMatchObject({ state: "delivery_verified", deliveryCheck: "verified", provider: "ses" });
    expect(verified.warnings).toEqual([]);
    expect(JSON.stringify(verified)).not.toContain(fingerprint);
  });

  it("a production marketplace with no provider: cannot deliver, account email blocked", async () => {
    const h = await emailHealth({ ...PRODUCTION });
    expect(h.config).toMatchObject({ state: "not_configured", productionMarketplace: true, blocksAccountEmail: true });
    expect(h.warnings).toContain("cannot_deliver");
  });

  it("lists the open alerts that concern email, and not the others", async () => {
    await raiseAlert("email:backlog", "Email is piling up", "detail");
    await raiseAlert("auth-mail-expired", "Security mail ran out", "detail");
    await raiseAlert("disk:warn", "Disk", "detail");
    const keys = (await emailHealth({})).openAlerts.map((a) => a.key).sort();
    expect(keys).toEqual(["auth-mail-expired", "email:backlog"]);
  });

  it("a failure reason carries no recipient address, link, token or configured secret", () => {
    const env = { ...SES, SMTP_URL };
    const raw = `535 Authentication failed for mailer:${SMTP_PASSWORD} key ${SES.SES_ACCESS_KEY_ID} sending to zed.customer@private.example: https://book.example.my/reset-password?token=abcdefABCDEF0123456789abcdefABCDEF`;
    const clean = sanitizedReason(raw, env);
    for (const secret of [SMTP_PASSWORD, SES.SES_ACCESS_KEY_ID, "zed.customer", "private.example", "reset-password", "abcdefABCDEF0123456789"]) expect(clean).not.toContain(secret);
    expect(clean).toContain("535 Authentication failed");
    expect(clean).toContain("[address]");
    expect(clean).toContain("[link]");
    expect(sanitizedReason("x".repeat(500)).length).toBeLessThanOrEqual(200);
  });
});

describe("GET /api/admin/system, email: the owner only, and nothing secret in it", () => {
  it("the owner gets the section; a venue's manager and its front desk are refused as before", async () => {
    await insert("sent", { minutesAgo: 5, triedMinutesAgo: 5, sentMinutesAgo: 5 });
    const owner = await get(ownerCookie);
    expect(owner.status).toBe(200);
    const body = (await owner.json()) as { email: { lastHour: { sent: number }; noData: boolean; warnings: string[] } };
    expect(body.email.lastHour.sent).toBe(1);
    expect(body.email.noData).toBe(false);
    for (const cookie of [managerCookie, deskCookie]) {
      const res = await get(cookie);
      expect(res.status).toBe(403);
      expect(JSON.stringify(await res.json())).not.toContain("lastHour");
    }
  });

  it("with SES keys and an SMTP password set, and a provider error quoting them, none of them is in the answer; the word 'delivered' is not either", async () => {
    setEnv({ ...SES, SMTP_URL, MAIL_DELIVERY_VERIFIED: "abcdef0123456789" });
    await insert("failed", {
      minutesAgo: 2,
      triedMinutesAgo: 2,
      error: `Invalid login: mailer:${SMTP_PASSWORD} (${SES.SES_SECRET_ACCESS_KEY}) for owner.inbox@private.example via ${SMTP_URL}`,
    });
    const res = await get(ownerCookie);
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const secret of [SES.SES_ACCESS_KEY_ID, SES.SES_SECRET_ACCESS_KEY, SMTP_PASSWORD, SMTP_URL, "abcdef0123456789", "owner.inbox@private.example"]) expect(text).not.toContain(secret);
    const body = JSON.parse(text) as { email: { config: { state: string; problems: string[] } } };
    expect(body.email.config.state).toBe("contradictory");
    expect(body.email.config.problems.join(" ")).toContain("SMTP_URL");
    expect(text).not.toMatch(/delivered/i);
  });
});
