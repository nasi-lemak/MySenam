// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { BookingsTab } from "../../src/components/admin/BookingsTab";

/**
 * A customer's cancellation of a booking paid at the counter (ADR 0074) on the list staff settle from: the customer and booking, the amount, how
 * it was paid, why, the day it arose, its status, the credit note (which is not money paid), whether the customer was told, what to do, and a choice
 * of the method it is handed back by.
 */

const base = {
  groupCode: null, venueId: 1, venueName: "Arena MySenam", courtDeposit: 0, sport: "badminton", date: "2026-11-03", endHour: 11, email: null, status: "confirmed",
  checkedOutAt: null, noShow: false, priorNoShows: 0, hire: null, classId: null, people: [], sharesPaid: 0, checkedInAt: null,
};
const booking = { ...base, id: 3, code: "MS-WEEKLY", courtId: 1, courtName: "Court 1", startHour: 10, name: "Liga", phone: "0175556666", totalPrice: 20, paymentStatus: "unpaid", seriesCode: null };

const row = {
  venueId: 1, name: "Aina Binti", date: "2026-11-05", startMin: 600, owedSince: "2026-11-03T02:00:00Z", paidAt: "2026-11-03T01:00:00Z", account: false, managerOnly: false, settled: null,
  status: "owed", byCustomer: true, via: "cash", cause: "customer_cancelled", creditNote: "CN-000012",
};
const owed = [
  { ...row, id: 21, bookingId: 210, bookingCode: "MS-CUST01", amount: 20, notifiedAt: "2026-11-03T02:01:00Z", hasEmail: true },
  { ...row, id: 22, bookingId: 220, bookingCode: "MS-CUST02", amount: 15, notifiedAt: null, hasEmail: false, cause: "place_withdrawn", via: null },
  { ...row, id: 23, bookingId: 230, bookingCode: "MS-CUST03", amount: 10, notifiedAt: null, hasEmail: true },
  { ...row, id: 24, bookingId: 240, bookingCode: "MS-RAIN01", amount: 30, byCustomer: false, creditNote: null, cause: "rain", notifiedAt: null, hasEmail: true },
];

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "POST" && String(url).startsWith("/api/admin/bookings/owed")) return { ok: true, json: async () => ({ settled: { outcome: "back" } }) };
    return { ok: true, json: async () => ({ bookings: [booking], payouts: [], owed, revenue: 0, collected: 0, outstanding: 0 }) };
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const posts = () => fetchMock.mock.calls.filter((c) => c[1]?.method === "POST" && String(c[0]).startsWith("/api/admin/bookings/owed")).map((c) => JSON.parse(c[1].body));

async function show() {
  render(<BookingsTab venues={[{ id: 1, name: "Arena MySenam" }]} />);
  await act(async () => {});
}

describe("a customer's cancellation on the list of money owed back at the counter", () => {
  it("shows who, how much, how it was paid, why, when, the status, the credit note, whether they were told and what to do", async () => {
    await show();
    const box = screen.getByTestId("owed");
    const details = within(box).getAllByTestId("owed-detail").map((d) => d.textContent ?? "");
    expect(box.textContent).toContain("MS-CUST01");
    expect(box.textContent).toContain("Aina Binti");
    expect(box.textContent).toContain("the customer cancelled it");
    expect(box.textContent).toContain("the customer took a person off it");
    // The first: told, with the credit note named and its words saying it is not money paid.
    expect(details[0]).toContain("Owed: not handed back yet");
    expect(details[0]).toContain("Arose");
    expect(details[0]).toContain("Credit note CN-000012");
    expect(details[0]).toContain("Customer told on");
    expect(details[0]).toContain("A credit note is not money paid");
    // Not told, no address: staff are asked to say it at the counter; with an address not yet reached, the other.
    expect(details[1]).toContain("No email address: tell the customer the venue will return it at the counter");
    expect(details[2]).toContain("Customer not told yet: tell them at the counter");
    // The venue's own cause says nothing of a customer.
    expect(details[3]).not.toContain("Customer");
    expect(details[3]).not.toContain("Credit note");
  });

  it("hands it back the way it was paid by default, or by the method the customer agreed to, which is sent and said", async () => {
    await show();
    const box = screen.getByTestId("owed");
    const selects = within(box).getAllByRole("combobox") as HTMLSelectElement[];
    // Only a customer's cancellations offer a choice.
    expect(selects).toHaveLength(3);
    expect(selects[0].value).toBe("");
    expect(within(selects[0]).getAllByRole("option").map((o) => o.textContent)).toEqual(["As paid (Cash)", expect.stringContaining("QR"), "Bank transfer", "Card terminal"]);
    await act(async () => {
      fireEvent.click(within(box).getAllByRole("button", { name: "Handed back RM20" })[0]);
    });
    expect(posts()).toEqual([{ id: 21, outcome: "back" }]);
    fireEvent.change(selects[0], { target: { value: "transfer" } });
    await act(async () => {
      fireEvent.click(within(box).getAllByRole("button", { name: "Handed back RM20" })[0]);
    });
    expect(posts()[1]).toEqual({ id: 21, outcome: "back", via: "transfer" });
    expect(screen.getByText(/handed back for MS-CUST01, by Bank transfer, not the way it was paid/)).toBeTruthy();
  });
});
