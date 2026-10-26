// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import BookingBoard from "../../src/components/BookingBoard";
import { LanguageProvider } from "../../src/components/Language";
import { addDays, todayISO } from "../../src/lib/time";

/**
 * Naming people per court on a booking of several courts
 * (components/WhoTakesPart.tsx PeoplePerCourt; lib/people-per-court.ts;
 * docs/features/booking.md#booking-for-somebody-else): a signed-in parent
 * ticks the children taking part and another court or two; each child is on
 * exactly one court (the first unless moved), the parent too where they take
 * part; a court nobody is named on is the party's, and says so; the request
 * carries each court's own people as the route reads them.
 */

const court = (id: number) => ({ id, venueId: 1, name: `Court ${id}`, sport: "badminton" as const, offPeakRate: 15, peakRate: 15, capacity: 1 });
const HOURLY = { startEvery: 60, startOffset: 0, startTimes: null, lengthStep: 60, minLength: 60, maxLength: 240, lengths: null, defaultLength: 60, noticeMinutes: 0 };
const HOURS = [8, 9, 10];
const row = (id: number) => ({
  court: court(id),
  grid: 60,
  unit: 1,
  policy: HOURLY,
  slots: HOURS.map((hour) => ({ minute: hour * 60, hour, available: true, rate: 15, booked: 0, capacity: 1, blocked: false, className: null })),
  starts: HOURS.map((h) => ({ minute: h * 60, maxLength: 60 * (11 - h) })),
});
const DAY = addDays(todayISO(), 1);
const AISHA = 21;
const BEN = 22;

const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 409, json: async () => body });
let posts: Record<string, unknown>[];

beforeEach(() => {
  posts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const u = String(url);
      if (u.includes("/api/availability")) return json({ availability: [row(1), row(2), row(3)], closure: null, memberRates: false });
      if (u.includes("/api/quote")) return json({ total: 15, court: 15, fees: 0, billedMinutes: 60, allowed: true, others: [] });
      if (u.includes("/api/auth/me")) return json({ user: { name: "Mak Long", phone: "0123456789", email: "mak@example.my" } });
      if (u.includes("/api/my/people")) return json({ people: [{ id: AISHA, displayName: "Aisha" }, { id: BEN, displayName: "Ben" }], own: null });
      if (u.includes("/api/my/accounts")) return json({ accounts: [] });
      if (u.includes("/api/my/wallet")) return json({ balance: 0 });
      if (u.includes("/api/my/passes")) return json({ passes: [] });
      if (u.includes("/api/bookings") && init?.method === "POST") {
        posts.push(JSON.parse(init.body!));
        return json({ error: "Stop here." }, false);
      }
      return json({});
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 260))));

async function open() {
  render(
    <LanguageProvider locale="en">
      <BookingBoard venueId={1} sports={["badminton"]} dates={[DAY]} />
    </LanguageProvider>
  );
  await act(async () => {});
  // The first row is "any court"; Court 1's first hour follows it.
  await act(async () => within(screen.getByRole("table")).getAllByRole("button")[HOURS.length].click());
  await settle();
}

const tick = (label: RegExp) => act(async () => void fireEvent.click(screen.getByLabelText(label)));
const choose = (who: string, courtId: number) =>
  act(async () => void fireEvent.change(screen.getByLabelText(`Court for ${who}`), { target: { value: String(courtId) } }));
const lines = () => within(screen.getByTestId("people-per-court")).getAllByRole("listitem").map((li) => li.textContent);

describe("naming people per court on a booking of several courts", () => {
  it("puts each person on one court, says which court is the party's, and sends each court's own people", async () => {
    await open();
    await tick(/Aisha \(booked by you\)/);
    await tick(/Ben \(booked by you\)/);
    // One court only: nothing to assign.
    expect(screen.queryByTestId("people-per-court")).toBeNull();
    await tick(/^Court 2$/);
    await tick(/^Court 3$/);
    const box = screen.getByTestId("people-per-court");
    expect(within(box).getByText("Who is on which court?")).toBeTruthy();
    // Everybody starts on the court picked first; one choice each, so nobody can be on two.
    expect(lines()).toEqual(["Court 1: Aisha, Ben, You", "Court 2: nobody named, so it is booked for the party as a number of places", "Court 3: nobody named, so it is booked for the party as a number of places"]);
    const benCourt = screen.getByLabelText("Court for Ben") as HTMLSelectElement;
    expect(Array.from(benCourt.options).map((o) => o.textContent)).toEqual(["Court 1", "Court 2", "Court 3"]);
    // Readable on a phone: each row wraps, and a choice never runs wider than the form.
    expect(benCourt.className).toContain("max-w-full");
    expect(benCourt.closest("label")!.className).toContain("flex-wrap");

    await choose("Ben", 2);
    await choose("You", 2);
    expect(lines()).toEqual(["Court 1: Aisha", "Court 2: Ben, You", "Court 3: nobody named, so it is booked for the party as a number of places"]);

    await act(async () => void fireEvent.submit(screen.getByRole("button", { name: /^Book/ }).closest("form")!));
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      courtId: 1,
      participantIds: [AISHA],
      customerTakesPart: false,
      moreCourts: [{ courtId: 2, participantIds: [BEN], customerTakesPart: true }, 3],
    });
  });

  it("a court dropped from the booking sends its people back to the first court", async () => {
    await open();
    await tick(/Aisha \(booked by you\)/);
    await tick(/^Me$/);
    await tick(/^Court 2$/);
    await choose("Aisha", 2);
    expect(lines()).toEqual(["Court 1: nobody named, so it is booked for the party as a number of places", "Court 2: Aisha"]);
    await tick(/^Court 2$/);
    expect(screen.queryByTestId("people-per-court")).toBeNull();
    await act(async () => void fireEvent.submit(screen.getByRole("button", { name: /^Book/ }).closest("form")!));
    expect(posts[0]).toMatchObject({ courtId: 1, participantIds: [AISHA], customerTakesPart: false });
    expect(posts[0].moreCourts).toBeUndefined();
  });
});
