// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

import { OnlinePaymentsPanel } from "../../src/components/admin/OnlinePaymentsPanel";
import type { ManagedVenue } from "../../src/components/admin/shared";

/**
 * Front desk sees the payments that came through online, not the venue's
 * payment account or its hold policy, which are a manager's: the panel does
 * not ask for them, so the desk is not shown a manager-only refusal on
 * opening the tab. Found by the acceptance scenarios (round 7).
 */

let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown, ok = true, status = ok ? 200 : 403) => ({ ok, status, json: async () => body });
const payment = { id: 7, billId: "bill-7", url: "https://pay.test/7", venueId: 3, amount: 40, status: "paid", payerName: "Aina", payerPhone: "0123456789", createdAt: "2026-10-28 10:00:00", paidAt: "2026-10-28 10:01:00", providerName: "Billplz", refundOwed: 0, refunded: 0, refundsByApi: false, bookingCodes: ["ABC123"], purpose: "booking" };

beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => {
    if (url.includes("/payment-settings")) return json({ error: "Front-desk accounts cannot change this. Ask a manager.", code: "MANAGER_ONLY" }, false);
    if (url.startsWith("/api/admin/online-payments")) return json({ payments: [payment], refundsOwed: [], refundsInFlight: [], disputes: [], workload: null, refundWithinDays: 7 });
    if (url.startsWith("/api/admin/hold-policy")) return json({ error: "Front-desk accounts cannot change this. Ask a manager.", code: "MANAGER_ONLY" }, false);
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const venues = [{ id: 3, name: "Desk Hall", courts: [] }] as unknown as ManagedVenue[];

describe("online payments for the front desk", () => {
  it("lists what came through without asking for the account or the hold policy", async () => {
    render(<OnlinePaymentsPanel venues={venues} desk />);
    await act(async () => {});
    const asked = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(asked.some((u) => u.includes("/payment-settings"))).toBe(false);
    expect(asked.some((u) => u.startsWith("/api/admin/hold-policy"))).toBe(false);
    expect(asked.some((u) => u.startsWith("/api/admin/online-payments"))).toBe(true);
    expect(screen.queryByText(/Ask a manager/)).toBeNull();
    expect(screen.getByText(/ABC123/)).toBeTruthy();
  });

  it("a manager still sees and asks for the account", async () => {
    render(<OnlinePaymentsPanel venues={venues} />);
    await act(async () => {});
    expect(fetchMock.mock.calls.map((c) => String(c[0])).some((u) => u.includes("/payment-settings"))).toBe(true);
  });
});
