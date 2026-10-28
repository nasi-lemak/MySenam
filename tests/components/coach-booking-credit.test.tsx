// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import CoachBooking from "../../src/components/CoachBooking";

/**
 * Paying for a lesson from stored credit, as the court booking form does: the
 * choice offered to a signed-in customer holding credit at the venue, sent as
 * `payFromWallet` (the same path a court takes, lib/store.ts
 * payBookingFromWallet), and the confirmation saying whether it was paid that
 * way. Nobody signed in, or no credit, is not offered it.
 */

let posted: Record<string, unknown> | null = null;

function stub(opts: { user: boolean; balance: number; paid: boolean; walletError?: string }) {
  posted = null;
  const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (url === "/api/auth/me")
      return { ok: true, json: async () => (opts.user ? { user: { name: "Siti Aminah", phone: "0123456789", email: "siti@example.my" } } : {}) };
    if (url.startsWith("/api/my/wallet")) return { ok: opts.user, json: async () => ({ balance: opts.balance }) };
    if (url.startsWith("/api/coaching/slots"))
      return { ok: true, json: async () => ({ starts: [{ minute: 600, maxLength: 120 }], policy: { lengths: [60], minLength: 60, maxLength: 120, step: 30, defaultLength: 60 } }) };
    if (url === "/api/bookings" && init?.method === "POST") {
      posted = JSON.parse(init.body ?? "{}");
      const booking = { id: 9, code: "MS-LES777", date: "2026-11-02", startMin: 600, endMin: 660, totalPrice: 100, paymentStatus: opts.paid ? "paid" : "unpaid", phone: "0123456789", coachId: 7 };
      return { ok: true, json: async () => ({ booking, bookings: [booking], walletError: opts.walletError ?? null }) };
    }
    return { ok: true, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
afterEach(() => vi.unstubAllGlobals());

const form = () => <CoachBooking venueId={3} coach={{ id: 7, name: "Ben Tan", sports: ["tennis"] }} dates={["2026-11-02"]} payOnline={false} timeZone="Asia/Kuala_Lumpur" />;

async function chooseTime() {
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "10:00 AM" }));
}
async function submit() {
  await act(async () => {
    fireEvent.submit(screen.getByRole("button", { name: /^Book/ }).closest("form")!);
  });
}

describe("a lesson paid from credit", () => {
  it("is offered with the venue's credit balance, sent as payFromWallet, and confirmed as paid that way", async () => {
    const fetchMock = stub({ user: true, balance: 150, paid: true });
    render(form());
    await chooseTime();
    expect(fetchMock.mock.calls.map((c) => c[0])).toContain("/api/my/wallet?venueId=3");
    const box = screen.getByLabelText(/Pay from my credit balance/);
    fireEvent.click(box);
    await submit();
    expect(posted).toMatchObject({ coachId: 7, payFromWallet: true });
    expect(screen.getByText("Paid from your credit balance.")).toBeTruthy();
  });

  it("not ticked, nothing is asked of credit", async () => {
    stub({ user: true, balance: 150, paid: false });
    render(form());
    await chooseTime();
    await submit();
    expect(posted).not.toHaveProperty("payFromWallet");
    expect(screen.queryByText("Paid from your credit balance.")).toBeNull();
  });

  it("says so when credit could not pay for it, the lesson standing unpaid", async () => {
    stub({ user: true, balance: 20, paid: false, walletError: "Not enough credit." });
    render(form());
    await chooseTime();
    fireEvent.click(screen.getByLabelText(/Pay from my credit balance/));
    await submit();
    expect(posted).toMatchObject({ payFromWallet: true });
    expect(screen.getByText("It could not be paid from your credit balance, so it is not paid yet.")).toBeTruthy();
  });

  it("is not offered to somebody not signed in, nor with no credit", async () => {
    stub({ user: false, balance: 0, paid: false });
    const { unmount } = render(form());
    await chooseTime();
    expect(screen.queryByLabelText(/Pay from my credit balance/)).toBeNull();
    unmount();
    stub({ user: true, balance: 0, paid: false });
    render(form());
    await chooseTime();
    expect(screen.queryByLabelText(/Pay from my credit balance/)).toBeNull();
  });
});
