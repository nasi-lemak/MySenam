// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { ReportsTab } from "../../src/components/admin/ReportsTab";

/**
 * Staff with several venues switch the Reports tab from one to another. The
 * first venue's figures and activity log, asked for when the tab opened, can
 * answer after the second's: they must not then show under the second
 * venue's name. (Found by acceptance scenario Documents I,
 * tests/uat/round4.uat.ts: the owner chose a venue and read the first venue's
 * empty activity log beneath it.)
 */

const VENUES = [
  { id: 1, name: "Arena MySenam" },
  { id: 2, name: "Panahan Rawang" },
] as unknown as Parameters<typeof ReportsTab>[0]["venues"];

const report = (venueId: number, venueName: string) => ({
  report: {
    venueId,
    venueName,
    from: "2026-09-28",
    to: "2026-10-27",
    days: 30,
    closedDays: 0,
    bookings: { confirmed: 0, cancelled: 0, noShows: 0, hours: 0 },
    revenue: { expected: 0, collected: 0, outstanding: 0, lateKept: 0, adjusted: 0, passPaid: { bookings: 0, value: 0 }, tax: 0 },
    testTakings: { bookings: 0, collected: 0 },
    collectedBy: [],
    counterSales: { sales: 0, total: 0 },
    utilisation: { courts: { soldHours: 0, sellableHours: 0, percent: 0 }, shared: { soldHours: 0, sellableHours: 0, percent: 0 }, revenuePerHour: 0 },
    bySport: [],
    byCourt: [],
    byMonth: [],
    byHour: [],
    liabilities: {
      passEntriesUnspent: 0,
      passesLive: 0,
      membershipsActive: 0,
      membershipsExpiringSoon: 0,
      owed: { storedCredit: null, giftVouchers: 0, giftVouchersLapsed: 0, bookingDeposits: 0, hireDeposits: 0, refunds: 0, passValue: 0, total: 0 },
    },
  },
  wallet: null,
});

const action = (detail: string) => ({ id: 1, adminId: 1, adminName: "Platform Owner", venueId: 2, bookingCode: null, action: "approval.scan_retry", detail, createdAt: "2026-10-27T03:00:00.000Z" });

/** Answers held back until released, per venue: the first venue's arrive last. */
let release: (() => void)[] = [];
beforeEach(() => {
  release = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const venueId = Number(new URL(url, "http://x").searchParams.get("venueId"));
      const body = url.startsWith("/api/admin/reports?")
        ? report(venueId, VENUES[venueId - 1].name)
        : url.startsWith("/api/admin/activity?")
          ? { actions: venueId === 2 ? [action("Asked for supporting document 5 to be scanned again")] : [] }
          : {};
      if (venueId === 1 && (url.startsWith("/api/admin/reports?") || url.startsWith("/api/admin/activity?")))
        await new Promise<void>((resolve) => release.push(resolve));
      return { ok: true, json: async () => body };
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("switching venue on the Reports tab", () => {
  it("shows the venue chosen, even when the one shown first answers last", async () => {
    render(<ReportsTab venues={VENUES} />);
    await act(async () => {});
    await act(async () => {
      fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "2" } });
    });
    expect(screen.getByText(/Nothing was booked at Panahan Rawang/)).toBeTruthy();
    expect(screen.getByText(/Asked for supporting document 5 to be scanned again/)).toBeTruthy();
    // The first venue's answers arrive now, late.
    await act(async () => {
      for (const r of release) r();
    });
    expect(screen.getByText(/Nothing was booked at Panahan Rawang/)).toBeTruthy();
    expect(screen.queryByText(/Nothing was booked at Arena MySenam/)).toBeNull();
    expect(screen.getByText(/Asked for supporting document 5 to be scanned again/)).toBeTruthy();
  });
});
