// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import BookingBoard from "../../src/components/BookingBoard";
import { LanguageProvider } from "../../src/components/Language";
import { BookingsTab } from "../../src/components/admin/BookingsTab";
import { GoLiveBanner } from "../../src/components/admin/GoLiveBanner";
import { LessonCoach } from "../../src/components/admin/LessonCoach";
import { buildTopic } from "../../src/lib/guide/playbook/topics";
import { emptyProfile } from "../../src/lib/guide/profile-types";
import { addDays, todayISO } from "../../src/lib/time";

/**
 * The tips on the screens that are small enough to draw alone, or reached by
 * one action: the cancel panel, the coach of a lesson, the go-live banner and
 * the counter's refusals (and not the customer's page). The big tabs, with the
 * editors for buffers, peak prices, discounts and the cancellation terms, are
 * in guide-help-screens.test.tsx, against the real routes.
 */

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, headers: new Headers({ "content-type": "application/json" }), json: async () => body, text: async () => JSON.stringify(body) });
const places = (root: ParentNode = document) => Array.from(root.querySelectorAll("[data-help]")).map((el) => el.getAttribute("data-help"));

let fetchMock: ReturnType<typeof vi.fn>;
afterEach(() => vi.unstubAllGlobals());

describe("the cancel panel of a booking", () => {
  const booking = {
    id: 1, code: "MS-59FNSZ", seriesCode: null, venueId: 4, venueName: "Arena MySenam", courtName: "Court 1", courtDeposit: 0, sport: "badminton",
    date: "2026-10-02", startHour: 20, endHour: 21, name: "Priya Devi", phone: "0163211606", totalPrice: 25, status: "confirmed", paymentStatus: "unpaid",
    checkedInAt: null, checkedOutAt: null, noShow: false, priorNoShows: 0, hire: null, classId: null, people: [],
  };
  const preview = { code: "MS-59FNSZ", name: "Priya Devi", date: "2026-10-02", startHour: 20, endHour: 21, seriesCode: null, paid: 0, paidVia: null, paidAt: null, how: "none", deposit: 0, late: false, cutoffHours: 24, keptPercent: null, options: [{ outcome: "back", refund: 0, kept: 0 }], managerOnly: false, kitOut: false, account: false };

  it("carries the tip on who refunds what, for the booking's own venue", async () => {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("/api/admin/bookings/cancel") && init?.method === "POST") return json({ preview });
      if (String(url).startsWith("/api/admin/guide/topic")) return json({ venueId: 4, role: "desk", topic: buildTopic("refunds", emptyProfile(4), "desk"), guide: null });
      return json({ bookings: [booking], revenue: 25, collected: 0, outstanding: 25 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<BookingsTab />);
    await act(async () => {});
    expect(places()).toEqual([]);
    await act(async () => screen.getAllByRole("button", { name: "Cancel" })[0].click());
    await screen.findByTestId("cancel-panel");
    expect(places(screen.getByTestId("cancel-panel"))).toEqual(["bookings.cancel"]);
    // Nothing is read until it is used, and then for that booking's venue.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).startsWith("/api/admin/guide/topic"))).toBe(false);
    await act(async () => within(screen.getByTestId("cancel-panel")).getByRole("button", { name: /^Help: / }).click());
    expect(fetchMock.mock.calls.find((c) => String(c[0]).startsWith("/api/admin/guide/topic"))![0]).toBe("/api/admin/guide/topic?venueId=4&id=refunds");
  });
});

describe("the coach of a lesson", () => {
  it("carries the tip on assigning another coach beside what it explains", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ coaches: [] })));
    render(<LessonCoach venueId={1} sport="tennis" coachId={1} coachName="Ana Lim" value={1} onChange={() => undefined} />);
    await act(async () => {});
    expect(places()).toEqual(["bookings.coach"]);
    expect(screen.getByRole("button", { name: "Help: How do I assign another coach?" })).toBeTruthy();
  });
});

describe("the go-live banner", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("/api/admin/test-bookings")) return json({ live: false, bookings: [{ code: "TST001", date: "2026-11-02", startHour: 10, endHour: 11, courtName: "Court 1", name: "Tess", paymentStatus: "unpaid", paidVia: null, counterPaid: false }] });
        if (url.startsWith("/api/admin/go-live")) return json({ state: "draft", suspension: null, request: { status: "draft", reason: null }, missing: [] });
        return json({});
      })
    );
  });

  it("carries the tip on test bookings once for a draft: in the banner, not again in the list under it", async () => {
    render(<GoLiveBanner venueId={7} refreshKey="x" onChange={() => undefined} />);
    await act(async () => {});
    expect(places()).toEqual(["golive.draft"]);
  });

  it("carries it in the list of a live venue's test bookings, where there is no draft banner", async () => {
    render(<GoLiveBanner venueId={7} refreshKey="x" onChange={() => undefined} live />);
    await act(async () => {});
    expect(places()).toEqual(["golive.tests"]);
  });
});

describe("the counter", () => {
  const COURT = { id: 1, venueId: 6, name: "Court 1", sport: "tennis" as const, offPeakRate: 15, peakRate: 15, capacity: 1 };
  const POLICY = { startEvery: 60, startOffset: 0, startTimes: null, lengthStep: 60, minLength: 60, maxLength: 120, lengths: null, defaultLength: 60, noticeMinutes: 0 };
  const HOURS = [8, 9, 10];
  const DAY = addDays(todayISO(), 1);
  const row = {
    court: COURT, grid: 60, unit: 1, policy: POLICY,
    slots: HOURS.map((hour) => ({ minute: hour * 60, hour, available: true, rate: 15, booked: 0, capacity: 1, blocked: false, className: null })),
    starts: HOURS.map((h) => ({ minute: h * 60, maxLength: 60 })),
  };
  let counter = true;
  let quote: Record<string, unknown> = { total: 15, court: 15, fees: 0, billedMinutes: 60, allowed: true, others: [] };

  beforeEach(() => {
    counter = true;
    quote = { total: 15, court: 15, fees: 0, billedMinutes: 60, allowed: true, others: [] };
    fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const u = String(url);
      if (u.includes("/api/availability")) return json({ availability: [row], closure: null, memberRates: false, atCounter: counter, mayOverride: false, guestsOfMembers: false });
      if (u.includes("/api/quote")) return json(quote);
      if (u.includes("/api/auth/me")) return json({ user: null });
      if (u.includes("/api/guide/") || u.includes("/api/admin/guide/topic")) return json({ venueId: 6, role: "desk", topic: buildTopic("cannot-reserve", emptyProfile(6), "desk"), guide: null });
      if (u.includes("/api/bookings") && init?.method === "POST") return json({ error: "Taken.", code: "SLOT_TAKEN" }, 409);
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  async function openForm() {
    await act(async () => {
      render(
        <LanguageProvider locale="en">
          <BookingBoard venueId={6} sports={["tennis"]} dates={[DAY]} />
        </LanguageProvider>
      );
    });
    await act(async () => within(screen.getByRole("table")).getAllByRole("button")[0].click());
    await act(async () => void (await new Promise((r) => setTimeout(r, 260))));
    await act(async () => void fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Ali Walk-in" } }));
    await act(async () => void fireEvent.change(screen.getByLabelText(/^Phone/), { target: { value: "0123456789" } }));
  }
  const submit = async () => act(async () => void fireEvent.submit(screen.getByRole("button", { name: /^Book/ }).closest("form")!));

  it("explains why a customer cannot reserve beside the refusal staff are shown, and reads the topic only when asked", async () => {
    await openForm();
    await submit();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Taken.");
    const tip = await within(alert).findByRole("button", { name: "Help: Why can't this customer reserve this?" });
    expect(tip.getAttribute("data-help")).toBe("counter.refusal");
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("guide/topic"))).toBe(false);
    await act(async () => tip.click());
    const dialog = await screen.findByRole("dialog", { name: "Why can't this customer reserve this?" });
    expect(await within(dialog).findByRole("table")).toBeTruthy();
    expect(fetchMock.mock.calls.find((c) => String(c[0]).includes("guide/topic"))![0]).toBe("/api/admin/guide/topic?venueId=6&id=cannot-reserve");
  });

  it("explains it beside the reason the price check gives before the booking is tried", async () => {
    quote = { total: 15, court: 15, fees: 0, billedMinutes: 60, allowed: false, error: "The venue is closed then.", code: "VENUE_CLOSED", others: [] };
    await openForm();
    const refused = await screen.findByText(/closed|The venue/i);
    expect(refused).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Help: Why can't this customer reserve this?" })).toBeTruthy();
    expect(places()).toEqual(["counter.quote"]);
  });

  it("gives a customer none: it is the counter's, not the public page's", async () => {
    counter = false;
    await openForm();
    await submit();
    await screen.findByRole("alert");
    await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
    expect(places()).toEqual([]);
  });
});
