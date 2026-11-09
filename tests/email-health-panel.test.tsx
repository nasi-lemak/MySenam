// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { SystemHealth } from "../src/components/admin/SystemHealth";
import type { EmailHealth } from "../src/lib/email-health";

/**
 * The *Email* section of the owner's System health (ADR 0079): read-only, in the words Queued, Accepted by provider, Failed, Abandoned and Delivery verified
 * (separately confirmed), never "delivered"; amber with its warnings; a no-data state; and nothing at all for anybody the route refuses. The last test takes
 * the route's real answer, with fake SES keys and an SMTP password set, and renders it: none of them reaches the page.
 */

const json = (body: unknown, status = 200) => ({
  ok: status < 400,
  status,
  headers: new Headers({ "content-type": "application/json" }),
  json: async () => body,
  text: async () => JSON.stringify(body),
});
const serve = (body: unknown, status = 200) => vi.stubGlobal("fetch", vi.fn(async () => json(body, status)));

const healthy = { state: "healthy", lastAt: new Date(Date.now() - 60_000).toISOString(), ageSeconds: 60, staleAfterMinutes: 5, lastFailure: null };

function email(over: Partial<Omit<EmailHealth, "config">> & { config?: Partial<EmailHealth["config"]> } = {}): EmailHealth {
  const { config, ...rest } = over;
  return {
    config: {
      state: "delivery_verified",
      provider: "ses",
      problems: [],
      productionMarketplace: true,
      blocksAccountEmail: false,
      syntheticLog: false,
      deliveryCheck: "verified",
      ...config,
    },
    lastHour: { sent: 4, failed: 0, failureRate: 0 },
    lastDay: { sent: 31, failed: 0, lastSentAt: "2031-05-12 01:59:00" },
    queued: { count: 0, oldestMinutes: null },
    givenUp24h: { total: 0, security: 0, securityAllowance: 0, securityExpired: 0 },
    securityRetrying: 0,
    recentFailures: [],
    openAlerts: [],
    warnings: [],
    thresholds: { failingMinTries: 5, failingShare: 0.5, backlogMinutes: 30 },
    noData: false,
    ...rest,
  };
}

async function section(e: EmailHealth, alerts: unknown[] = []) {
  serve({ alerts, scheduler: { enabled: true, alive: true, heartbeat: healthy }, email: e });
  const { findByTestId } = render(<SystemHealth />);
  return findByTestId("email-health");
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("the Email section of System health", () => {
  it("shows the counts in its own words, and acceptance by the provider is never called delivery", async () => {
    const el = await section(email({ queued: { count: 3, oldestMinutes: 7 }, lastHour: { sent: 4, failed: 1, failureRate: 0.2 }, lastDay: { sent: 31, failed: 2, lastSentAt: "2031-05-12 01:59:00" } }));
    const text = el.textContent ?? "";
    expect(text).toContain("Email");
    expect(text).toContain("Queued: 3, the oldest waiting 7 min.");
    expect(text).toContain("Accepted by provider: 4 in the last hour, 31 in the last 24 hours.");
    expect(text).toContain("Last accepted by provider: ");
    expect(text).toContain("Failed, to be tried again: 1 in the last hour, 2 in the last 24 hours.");
    expect(text).toContain("Abandoned (given up) in the last 24 hours: 0");
    expect(text).toContain("Delivery verified (separately confirmed): yes");
    expect(text).toContain("It is not proof that it reached an inbox.");
    expect(text).not.toMatch(/delivered/i);
    expect(el.getAttribute("data-warnings")).toBe("");
    expect(el.className).not.toContain("amber");
  });

  it("an empty queue says none", async () => {
    const el = await section(email());
    expect(el.textContent).toContain("Queued: none.");
  });

  it("no messages ever: a no-data line, the configuration still said", async () => {
    const el = await section(email({ noData: true, lastDay: { sent: 0, failed: 0, lastSentAt: null }, lastHour: { sent: 0, failed: 0, failureRate: null } }));
    expect(el.querySelector('[data-testid="email-no-data"]')?.textContent).toBe("No email has been written on this install yet.");
    expect(el.querySelector('[data-testid="email-counts"]')).toBeNull();
    expect(el.textContent).toContain("Configuration: configured, delivery verified. Provider: Amazon SES. Production marketplace: yes.");
  });

  it("active failures: the warning with the numbers, the reasons by kind, the open email alerts and the procedure", async () => {
    const el = await section(
      email({
        lastHour: { sent: 1, failed: 5, failureRate: 5 / 6 },
        warnings: ["failing"],
        recentFailures: [{ kind: "staff_alert", status: "failed", reason: "454 Throttling failure sending to [address]", count: 5, lastAt: "2031-05-12 01:58:00" }],
        openAlerts: [{ key: "email:failing", subject: "The email provider is failing", subjectPhrase: null, count: 2, lastAt: "2031-05-12 01:58:00" }],
      })
    );
    const text = el.textContent ?? "";
    expect(el.getAttribute("data-warnings")).toBe("failing");
    expect(el.className).toContain("amber");
    expect(text).toContain("The provider is failing: 5 of the last hour's 6 tries failed.");
    expect(el.querySelector('[data-testid="email-failures"]')?.textContent).toContain("staff_alert · failed · 454 Throttling failure sending to [address] (5×");
    expect(text).toContain("Open email alerts: The email provider is failing");
    expect(text).toContain("docs/operations/email-ses-checklist.md");
  });

  it("security mail given up or run out is its own warning, with the expired ones counted", async () => {
    const el = await section(
      email({
        givenUp24h: { total: 3, security: 2, securityAllowance: 0, securityExpired: 2 },
        securityRetrying: 1,
        warnings: ["security_mail"],
        recentFailures: [{ kind: "auth_email", status: "abandoned", reason: "Not sent: it ran out before it could go (the link in it no longer works).", count: 2, lastAt: "2031-05-12 01:00:00" }],
      })
    );
    const text = el.textContent ?? "";
    expect(text).toContain("Abandoned (given up) in the last 24 hours: 3; security mail 2 of them (2 ran out before they could go, 0 held by the daily allowance).");
    expect(text).toContain("Security mail failed and being tried again: 1.");
    expect(text).toContain("Security mail (sign-up, password reset) was given up or is failing");
    expect(text).toContain("security mail · abandoned · Not sent: it ran out");
  });

  it("no provider on a production marketplace: not configured, the problem named, account email refused, and a warning", async () => {
    const el = await section(
      email({
        config: {
          state: "not_configured",
          provider: null,
          problems: ["No email provider is set up: set SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY, SES_REGION and MAIL_FROM (Amazon SES), or SMTP_URL and MAIL_FROM (SMTP)."],
          blocksAccountEmail: true,
          deliveryCheck: "none",
        },
        warnings: ["cannot_deliver"],
        noData: true,
      })
    );
    const text = el.textContent ?? "";
    expect(text).toContain("Configuration: not configured. Provider: none.");
    expect(text).toContain("No email provider is set up");
    expect(text).toContain("Sign-up and forgotten-password requests are being refused");
    expect(text).toContain("Production email is not configured: messages cannot go out.");
    expect(text).toContain("Delivery verified (separately confirmed): no. Nobody has recorded a delivery check.");
  });

  it("SES configured but not verified: says so, and that accepted is not delivery", async () => {
    const el = await section(email({ config: { state: "configured_unverified", deliveryCheck: "other" }, warnings: ["unverified"] }));
    const text = el.textContent ?? "";
    expect(text).toContain("Configuration: configured, delivery not verified. Provider: Amazon SES.");
    expect(text).toContain("A check is recorded for another provider or sender, so it does not count.");
    expect(text).toContain("Delivery has not been verified: run the email check and confirm the inbox");
    expect(text).toContain("Accepted by provider: 4 in the last hour");
    expect(text).not.toMatch(/delivered/i);
  });

  it("the words exist in Malay and Chinese with the same placeholders filled", async () => {
    const { staffTranslator } = await import("../src/lib/staff-i18n");
    for (const locale of ["ms", "zh"] as const) {
      const t = staffTranslator(locale);
      for (const line of [
        t("eh.accepted", { hour: 1, day: 2 }),
        t("eh.abandoned", { n: 1, security: 1, expired: 1, allowance: 0 }),
        t("eh.warn.backlog", { minutes: 40, limit: 30 }),
        t("dig.venue.open", { venue: "Alpha", n: 2, amount: "RM40", days: 3, overdue: 1, limit: 2 }),
      ])
        expect(line).not.toMatch(/\{\w+\}/);
    }
  });

  it("a venue's manager or front desk is refused by the route, and the panel shows nothing at all", async () => {
    serve({ error: "Only the platform owner can do that." }, 403);
    const { container } = render(<SystemHealth />);
    await waitFor(() => expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector('[data-testid="email-health"]')).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("the route's real answer, with fake SES keys and an SMTP password set and a provider error quoting them, puts none of them on the page", async () => {
    const secrets = { SES_ACCESS_KEY_ID: "AKIAFAKEPANEL0000001", SES_SECRET_ACCESS_KEY: "fake/Panel+Secret0123456789", SMTP_PASSWORD: "Pw4SmtpPanel99" };
    const before = { ...process.env };
    Object.assign(process.env, {
      SES_ACCESS_KEY_ID: secrets.SES_ACCESS_KEY_ID,
      SES_SECRET_ACCESS_KEY: secrets.SES_SECRET_ACCESS_KEY,
      SES_REGION: "ap-southeast-1",
      MAIL_FROM: "MySenam <no-reply@mail.example.my>",
      SMTP_URL: `smtp://mailer:${secrets.SMTP_PASSWORD}@smtp.example.my:587`,
    });
    try {
      const { ADMIN_SESSION_COOKIE, createAdminSession, ensureBootstrapAdmin } = await import("../src/lib/admin-auth");
      const { getDb } = await import("../src/lib/db");
      const { GET } = await import("../src/app/api/admin/system/route");
      await ensureBootstrapAdmin();
      const owner = (await getDb().prepare("SELECT id FROM admins WHERE venue_id IS NULL AND business_id IS NULL ORDER BY id LIMIT 1").get()) as { id: number };
      await getDb()
        .prepare(
          `INSERT INTO messages (venue_id, kind, channel, recipient, subject, body, status, attempts, last_error, created_at, last_attempt_at)
           VALUES (NULL, 'auth_email', 'email', 'someone@private.example', 's', 'b', 'failed', 1, ?, datetime('now'), datetime('now'))`
        )
        .run(`535 login mailer:${secrets.SMTP_PASSWORD} key ${secrets.SES_ACCESS_KEY_ID}/${secrets.SES_SECRET_ACCESS_KEY} to someone@private.example https://book.example.my/reset-password?token=Tok3nTok3nTok3nTok3nTok3n`);
      const res = await GET(new NextRequest("http://localhost/api/admin/system", { headers: { cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(owner.id)).token}` } }));
      expect(res.status).toBe(200);
      const body = await res.json();
      serve(body);
      const { findByTestId } = render(<SystemHealth />);
      await findByTestId("email-health");
      const html = document.body.innerHTML;
      for (const s of [...Object.values(secrets), "someone@private.example", "reset-password", "Tok3nTok3n"]) expect(html).not.toContain(s);
      expect(html).toContain("535 login");
      expect(html).not.toMatch(/delivered/i);
    } finally {
      for (const k of ["SES_ACCESS_KEY_ID", "SES_SECRET_ACCESS_KEY", "SES_REGION", "MAIL_FROM", "SMTP_URL"]) {
        if (before[k] === undefined) delete process.env[k];
        else process.env[k] = before[k];
      }
    }
  });
});
