import { afterEach, describe, expect, it, vi } from "vitest";

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
// League housekeeping breaks, to see the scheduler tell somebody.
vi.mock("../src/lib/leagues", async (original) => ({
  ...(await original<typeof import("../src/lib/leagues")>()),
  leagueHousekeeping: async () => {
    throw new Error("relation \"league_seasons\" is broken");
  },
}));

import { ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { checkMessages, raiseAlert, recentAlerts, schedulerAlive } from "../src/lib/alerts";
import { getDb } from "../src/lib/db";
import { runScheduledWork } from "../src/lib/scheduler";
import { GET as health } from "../src/app/api/health/route";

/** When something breaks, the platform owner hears — once, not a thousand times. */

await ensureBootstrapAdmin();

afterEach(() => {
  sent.length = 0;
  delete process.env.MYSENAM_ALERT_WEBHOOK;
  delete process.env.MYSENAM_SCHEDULER;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("an alert", () => {
  it("is told once, counted after, and told again only when it has gone on for hours", async () => {
    const hook = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", hook);
    process.env.MYSENAM_ALERT_WEBHOOK = "https://hooks.example.com/abc";

    expect(await raiseAlert("test", "Something broke", "first")).toBe(true);
    expect(await raiseAlert("test", "Something broke", "second")).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain("Something broke");
    expect(hook).toHaveBeenCalledOnce();
    expect(JSON.parse((hook.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).text).toContain("first");

    await getDb().prepare("UPDATE system_alerts SET last_sent_at = datetime('now', '-7 hours') WHERE key = 'test'").run();
    expect(await raiseAlert("test", "Something broke", "third")).toBe(true);
    expect(sent[1].text).toContain("3 times so far");
    expect((await recentAlerts()).find((a) => a.key === "test")).toMatchObject({ count: 3, lastDetail: "third" });
  });

  it("comes from the scheduler when its work fails, and the rest still runs", async () => {
    await runScheduledWork();
    const alert = (await recentAlerts()).find((a) => a.key.startsWith("scheduler:league"));
    expect(alert?.subject).toBe("Scheduled work failed: league housekeeping");
    expect(alert?.lastDetail).toContain("league_seasons");
    expect(sent.some((m) => m.subject.includes("league housekeeping"))).toBe(true);
  });

  it("comes when messages fail and none get through, not for one bad address", async () => {
    const add = (status: string) =>
      getDb()
        .prepare(
          "INSERT INTO messages (venue_id, kind, channel, recipient, locale, body, status, last_error) VALUES (1, 'booking_confirmed', 'email', 'x@example.com', 'en', 'hi', ?, 'SMTP 535 authentication failed')"
        )
        .run(status);
    await add("failed");
    await checkMessages();
    expect((await recentAlerts()).some((a) => a.key === "messages")).toBe(false);
    for (let i = 0; i < 4; i++) await add("failed");
    await checkMessages();
    expect((await recentAlerts()).find((a) => a.key === "messages")?.lastDetail).toContain("535");
  });
});

describe("the health check", () => {
  it("fails when the scheduler has stopped ticking", async () => {
    process.env.MYSENAM_SCHEDULER = "on";
    await runScheduledWork();
    expect((await health()).status).toBe(200);
    // Long past this process's start, and the last tick an hour ago.
    vi.useFakeTimers({ now: Date.now() + 20 * 60_000, toFake: ["Date"] });
    await getDb().prepare("UPDATE settings SET value = datetime('now', '-1 hours') WHERE key = 'scheduler_heartbeat'").run();
    expect(await schedulerAlive()).toBe(false);
    expect((await health()).status).toBe(503);
  });
});
