// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";

import { BookingsTab } from "../../src/components/admin/BookingsTab";

/**
 * A booking shows up twice — as a card on a phone and as a table row on a
 * screen — and a control that exists in one and not the other is a control
 * somebody at a counter cannot find. CSS decides which is visible; both are
 * always rendered, so both can be checked here.
 */

const booking = {
  id: 1,
  code: "MS-59FNSZ",
  seriesCode: null,
  venueId: 1,
  venueName: "Arena MySenam",
  courtName: "Badminton Court 1",
  courtDeposit: 0,
  sport: "badminton",
  date: "2026-10-02",
  startHour: 20,
  endHour: 21,
  name: "Priya Devi",
  phone: "0163211606",
  totalPrice: 25,
  status: "confirmed",
  paymentStatus: "paid",
  checkedInAt: null,
  checkedOutAt: null,
  noShow: false,
  priorNoShows: 0,
  hire: null,
  classId: null,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () =>
    ({ ok: true, json: async () => ({ bookings: [booking], revenue: 25, collected: 25, outstanding: 0 }) })
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

async function show() {
  render(<BookingsTab />);
  await act(async () => {});
}

describe("a booking at the counter", () => {
  it("offers the same controls in the card and in the row", async () => {
    await show();
    const card = screen.getByRole("list").querySelector("li")!;
    const row = screen.getByRole("table").querySelector("tbody tr")!;

    for (const name of ["✓ paid", "check in", "no-show?", "Move", "Change time", "Cancel"]) {
      expect(within(card as HTMLElement).getByText(name), `card is missing "${name}"`).toBeTruthy();
      expect(within(row as HTMLElement).getByText(name), `row is missing "${name}"`).toBeTruthy();
    }
  });

  it("makes the number callable on the card, where a phone is what you are holding", async () => {
    await show();
    const card = screen.getByRole("list").querySelector("li")!;
    const tel = within(card as HTMLElement).getByRole("link", { name: "0163211606" });
    expect(tel.getAttribute("href")).toBe("tel:0163211606");
  });

  it("hides the card list from a wide screen and the table from a narrow one", async () => {
    await show();
    expect(screen.getByRole("list").className).toContain("lg:hidden");
    expect(screen.getByRole("table").parentElement!.className).toContain("hidden");
    expect(screen.getByRole("table").parentElement!.className).toContain("lg:block");
  });

  it("marks a booking unpaid from either one, once staff confirm", async () => {
    vi.stubGlobal("confirm", () => true);
    await show();
    const card = screen.getByRole("list").querySelector("li")!;
    await act(async () => within(card as HTMLElement).getByText("✓ paid").click());
    const posts = fetchMock.mock.calls.filter((c) => c[1]?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0][1].body)).toMatchObject({ code: "MS-59FNSZ", paid: false });
  });

  it("asks how an unpaid booking was paid: cash, QR, transfer or card", async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ bookings: [{ ...booking, paymentStatus: "unpaid" }], revenue: 25, collected: 0, outstanding: 25 }),
    }));
    await show();
    const row = screen.getByRole("table").querySelector("tbody tr")! as HTMLElement;
    await act(async () => within(row).getByText("unpaid").click());
    for (const m of ["cash", "QR", "transfer", "card"]) expect(within(row).getByText(m)).toBeTruthy();
    await act(async () => within(row).getByText("QR").click());
    const posts = fetchMock.mock.calls.filter((c) => c[1]?.method === "POST");
    expect(JSON.parse(posts[0][1].body)).toEqual({ code: "MS-59FNSZ", paid: true, via: "qr" });
  });

  it("says plainly when a day has nothing on it", async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ bookings: [], revenue: 0, collected: 0, outstanding: 0 }),
    }));
    await show();
    expect(screen.getByText(/No bookings on/)).toBeTruthy();
  });

  it("gives the date picker a name a screen reader can say", async () => {
    await show();
    expect(screen.getByLabelText("Day to show")).toBeTruthy();
  });
});
