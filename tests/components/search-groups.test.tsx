// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import SearchClient from "../../src/app/search/SearchClient";
import { addDays, todayISO } from "../../src/lib/time";

/**
 * Search shows kinds of kit under their heading: each kind with its own
 * price, places left and rules, a free one straight to booking it on the
 * venue's grid with the heading shown, and the heading to all of them.
 */

const DATE = addDays(todayISO(), 1);
const json = (body: unknown) => ({ ok: true, json: async () => body });

const KAYAKS = { id: 21, venueId: 7, name: "Single kayak", sport: "kayak", offPeakRate: 30, peakRate: 30, capacity: 6, heading: "Kayaks", activities: [] };
const venue = { id: 7, name: "Tasik Kayak", area: "Putrajaya", amenities: [], access: "public" };
const result = {
  venue,
  court: KAYAKS,
  startMin: 540,
  endMin: 600,
  startHour: 9,
  endHour: 10,
  totalPrice: 30,
  // The doubles, the touring kayaks and a court of something not under the heading.
  alsoFree: 3,
  pricesVary: true,
  needs: null,
  groups: [
    {
      heading: "Kayaks",
      kinds: [
        { courtId: 21, name: "Single kayak", free: true, totalPrice: 30, perPlayer: false, capacity: 6, placesLeft: 2, needs: null },
        { courtId: 22, name: "Double kayak", free: true, totalPrice: 45, perPlayer: false, capacity: 3, placesLeft: 3, needs: "signOff" },
        { courtId: 24, name: "Touring kayak", free: true, totalPrice: 60, perPlayer: false, capacity: 2, placesLeft: 1, needs: "certification" },
        { courtId: 23, name: "Sea kayak", free: false, totalPrice: 50, perPlayer: false, capacity: 2, placesLeft: 0, needs: null },
      ],
    },
  ],
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ date: DATE, sport: "kayak", results: [result], areas: ["Putrajaya"], covers: {}, needsArea: false }))
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("kinds under a heading in search results", () => {
  it("lists each kind as itself, links to it on the venue's grid with the heading, and counts nothing twice", async () => {
    render(<SearchClient sports={["kayak"]} start={{ sport: "kayak", date: DATE }} />);
    await act(async () => {});
    const group = screen.getByTestId("group-Kayaks");
    expect(within(group).getByText(/Kayaks: pick a kind/)).toBeTruthy();
    // The result names the heading with its kind, as the booking form does.
    expect(screen.getByText(/Kayaks · Single kayak/)).toBeTruthy();

    const singles = within(screen.getByTestId("kind-21")).getByRole("link");
    expect(singles.textContent).toBe("Single kayak · RM30 each · 2 left");
    expect(singles.getAttribute("href")).toBe(`/venue/7?date=${DATE}&sport=kayak&court=21&start=540&minutes=60&heading=Kayaks`);

    // A kind that needs a sign-off or a certification first says so.
    expect(within(screen.getByTestId("kind-22")).getByText("needs the venue's sign-off")).toBeTruthy();
    expect(within(screen.getByTestId("kind-24")).getByText("needs a recorded certification")).toBeTruthy();

    // One not free then is shown, not offered.
    const full = screen.getByTestId("kind-23");
    expect(within(full).queryByRole("link")).toBeNull();
    expect(full.textContent).toContain("not free then");

    // The heading opens the venue's grid at that time with every kind under it, none picked.
    const all = within(group).getByRole("link", { name: "See all Kayaks here" });
    expect(all.getAttribute("href")).toBe(`/venue/7?date=${DATE}&sport=kayak&start=540&minutes=60&heading=Kayaks`);

    // Of the three others free, two are listed above: one more is counted.
    expect(screen.getByText(/\+1 more court free/)).toBeTruthy();
  });
});
