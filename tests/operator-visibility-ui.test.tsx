// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { AttentionPanel } from "../src/components/admin/AttentionPanel";
import { SystemHealth } from "../src/components/admin/SystemHealth";

/**
 * What the owner and the venue's staff read (ADR 0076): the scheduler line on the dashboard is always there and says "healthy", "stale", "no heartbeat
 * yet", "starting" or "off" in words (a missing heartbeat is never green), and the counter refunds owed back are a line in Needs attention that is red when
 * any has waited long. The data is the routes' own shape; the routes are proved against the real database in tests/operator-visibility.test.ts.
 */

const json = (body: unknown) => ({ ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => body, text: async () => JSON.stringify(body) });
const serve = (body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => json(body)));

const heartbeat = (over: Record<string, unknown>) => ({
  state: "healthy",
  lastAt: new Date(Date.now() - 60_000).toISOString(),
  ageSeconds: 60,
  staleAfterMinutes: 5,
  lastFailure: null,
  ...over,
});
const system = (hb: Record<string, unknown>, alive = true, alerts: unknown[] = []) => ({ alerts, scheduler: { enabled: hb.state !== "off", alive, heartbeat: hb } });

afterEach(() => vi.unstubAllGlobals());

async function line(hb: Record<string, unknown>, alive = true) {
  serve(system(hb, alive));
  const { findByTestId } = render(
    <SystemHealth />
  );
  return findByTestId("scheduler-heartbeat");
}

describe("the scheduler line on the owner's dashboard", () => {
  it("healthy says so, with the time since", async () => {
    const el = await line(heartbeat({}));
    expect(el.getAttribute("data-state")).toBe("healthy");
    expect(el.textContent).toContain("Scheduler");
    expect(el.textContent).toContain("healthy");
    expect(el.textContent).toContain("1 min ago");
  });

  it("stale is not green and says what may have stopped", async () => {
    const el = await line(heartbeat({ state: "stale", ageSeconds: 1800 }));
    expect(el.getAttribute("data-state")).toBe("stale");
    expect(el.textContent).toContain("STALE");
    expect(el.textContent).toContain("30 min ago");
    expect(el.textContent).not.toContain("healthy");
    expect(el.className).not.toContain("emerald");
  });

  it("no heartbeat yet is its own words, and 'starting' is labelled as a grace of two minutes", async () => {
    const never = await line(heartbeat({ state: "never", lastAt: null, ageSeconds: null }));
    expect(never.textContent).toContain("NO HEARTBEAT YET");
    expect(never.textContent).not.toContain("healthy");
  });

  it("starting is labelled", async () => {
    const el = await line(heartbeat({ state: "starting", lastAt: null, ageSeconds: null }));
    expect(el.textContent).toContain("starting");
    expect(el.textContent).toContain("two minutes only");
    expect(el.textContent).not.toContain("healthy");
  });

  it("off says it is off, and the last outstanding failure and a pointer show", async () => {
    const off = await line(heartbeat({ state: "off" }));
    expect(off.textContent).toContain("switched off");
    document.body.innerHTML = "";
    const failing = await line(
      heartbeat({ lastFailure: { key: "scheduler:ratings-failed", subject: "Scheduled work failed: ratings", subjectPhrase: null, at: new Date().toISOString(), count: 3 } })
    );
    expect(failing.textContent).toContain("Last scheduler failure still outstanding: Scheduled work failed: ratings");
    expect(failing.textContent).toContain("Backups panel");
  });
});

describe("the counter refunds line in Needs attention", () => {
  const attention = (counterOwed: unknown[]) => ({ open: [], recent: [], counterOwed });

  it("shows nothing when nothing is owed", async () => {
    serve(attention([]));
    const { container } = render(
      <AttentionPanel />
    );
    await waitFor(() => expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(0));
    expect(container.querySelector('[data-testid="counter-owed"]')).toBeNull();
  });

  it("names the venue, how many, the sum, the oldest and how many are overdue; red when any is", async () => {
    serve(attention([{ venueId: 1, venueName: "Alpha Arena", count: 3, amount: 60, oldestDays: 4, overdue: 2, overdueAfterDays: 2 }]));
    const { findByTestId } = render(
      <AttentionPanel />
    );
    const el = await findByTestId("counter-owed");
    expect(el.textContent).toContain("Owed back at the counter");
    expect(el.textContent).toContain("Alpha Arena: 3 waiting");
    expect(el.textContent).toContain("the oldest 4 days, 2 past 2 days");
    expect(el.textContent).toContain("A credit note is not the refund");
    expect(el.className).toContain("red");
  });

  it("is amber when none has waited long", async () => {
    serve(attention([{ venueId: 1, venueName: "Alpha Arena", count: 1, amount: 20, oldestDays: 0, overdue: 0, overdueAfterDays: 2 }]));
    const { findByTestId } = render(
      <AttentionPanel />
    );
    expect((await findByTestId("counter-owed")).className).toContain("amber");
  });
});

describe("the words of the line and the message, in English, Malay and Chinese", () => {
  it("fill every placeholder", async () => {
    const { staffTranslator } = await import("../src/lib/staff-i18n");
    const { englishOf, said } = await import("../src/lib/staff-text");
    const unfilled = /\{\w+\}/;
    for (const locale of ["en", "ms", "zh"] as const) {
      const t = staffTranslator(locale);
      for (const n of [1, 3]) {
        const lines = [
          t.plural("vis.att.counterVenue", n, { venue: "Alpha", count: n, amount: "RM60", days: 4, overdue: 2, limit: 2 }),
          t.plural("vis.mail.owed.s", n, { venue: "Alpha" }),
          t.plural("vis.mail.owed.b", n, { venue: "Alpha", amount: "RM60", days: 4 }),
          t.plural("vis.mail.owed.overdue", n, { limit: 2 }),
          t("vis.hb.healthy", { ago: "1 min", when: "now" }),
          t("vis.hb.stale", { ago: "9 min", when: "then" }),
          t("vis.hb.failure", { what: "x", when: "now", n }),
        ];
        for (const line of lines) expect(line, `${locale}: ${line}`).not.toMatch(unfilled);
      }
      const detail = said("srv.vis.pay.d", { ref: "bill1", amount: "RM12", venue: "Alpha", issue: said("srv.vis.issue.underpaid"), owed: said("srv.vis.pay.nothingOwed") });
      expect(t.say(detail), locale).toContain("bill1");
      expect(t.say(detail), locale).not.toMatch(unfilled);
      expect(t.say(said("srv.vis.pay.many.d", { n: 7, venue: "Alpha", each: 5 })), locale).not.toMatch(unfilled);
    }
    expect(englishOf(said("srv.vis.pay.s", { venue: "Alpha" }))).toBe("A payment at Alpha needs checking");
  });
});
