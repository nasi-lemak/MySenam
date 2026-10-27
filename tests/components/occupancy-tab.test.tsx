// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

import { OccupancyTab } from "../../src/components/admin/OccupancyTab";

/** The occupancy grid measures against what could have been sold: places taken out of service come off it. */

beforeEach(() => {
  const report = {
    totalSlotsPerDay: 10,
    courts: [
      { id: 1, name: "Kayaks", sport: "kayak", capacity: 4 },
      { id: 2, name: "Court 1", sport: "badminton", capacity: 1 },
    ],
    days: [
      {
        date: "2026-11-02",
        perCourt: [
          // Two kayaks of four out for two hours: 36 place-hours left to sell, 9 sold.
          { courtId: 1, booked: 9, blocked: 4, sellable: 36 },
          { courtId: 2, booked: 4, blocked: 0, sellable: 10 },
        ],
      },
    ],
  };
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => report })));
});
afterEach(() => vi.unstubAllGlobals());

describe("the occupancy tab", () => {
  it("reads each court against its sellable places, and says how many were taken out", async () => {
    render(<OccupancyTab venues={[{ id: 7, name: "Arena", courts: [] }] as never} />);
    await act(async () => {});
    const kayaks = screen.getByTitle("9/36 places booked; 4 more taken out of service");
    expect(kayaks.textContent).toContain("25%");
    expect(screen.getByTitle("4/10 places booked").textContent).toBe("40%");
    // The venue: 13 of 46 sellable, not 13 of 50.
    expect(screen.getByText("28%")).toBeTruthy();
  });
});
