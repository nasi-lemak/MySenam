// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

import { OccupancyTab } from "../../src/components/admin/OccupancyTab";

/** The occupancy grid measures against what could have been sold: places taken out of service come off it. */

const split = (soldHours: number, sellableHours: number) => ({ soldHours, sellableHours, percent: soldHours / sellableHours });

function serve(totals: { courts: unknown; shared: unknown }) {
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
        totals,
      },
    ],
  };
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => report })));
}
afterEach(() => vi.unstubAllGlobals());

async function show() {
  render(<OccupancyTab venues={[{ id: 7, name: "Arena", courts: [] }] as never} />);
  await act(async () => {});
}

describe("the occupancy tab", () => {
  it("reads each court against its sellable places, and says how many were taken out", async () => {
    serve({ courts: split(4, 10), shared: split(9, 36) });
    await show();
    const kayaks = screen.getByTitle("9/36 places booked; 4 more taken out of service");
    expect(kayaks.textContent).toContain("25%");
    expect(screen.getByTitle("4/10 places booked").textContent).toBe("40%");
  });

  it("gives the courts' floor and the shared facilities a row each, as the server measured them, never blended", async () => {
    // The server's floor figure counts a pitch and its courts once (lib/reports.ts measureUse); the grid shows it as given.
    serve({ courts: split(2, 28), shared: split(9, 36) });
    await show();
    const floor = screen.getByText("Courts, floor counted once").closest("tr")!;
    const shared = screen.getByText("Shared facilities").closest("tr")!;
    expect(floor.textContent).toContain("7%");
    expect(shared.textContent).toContain("25%");
    expect(screen.getByTitle("2 of 28 hours of the courts' floor in use; a pitch and the courts under it counted once")).toBeTruthy();
    expect(screen.getByTitle("9 of 36 place-hours booked on shared facilities, measured apart from the courts")).toBeTruthy();
    // Not the lines added up: 13 of 46 would read 28%.
    expect(screen.queryByText("28%")).toBeNull();
  });

  it("leaves out the row for a kind the venue does not have", async () => {
    serve({ courts: split(4, 10), shared: null });
    await show();
    expect(screen.getByText("Courts, floor counted once")).toBeTruthy();
    expect(screen.queryByText("Shared facilities")).toBeNull();
  });

  it("shows only the shared facilities' row at a venue with no courts", async () => {
    serve({ courts: null, shared: split(9, 36) });
    await show();
    expect(screen.queryByText("Courts, floor counted once")).toBeNull();
    expect(screen.getByText("Shared facilities").closest("tr")!.textContent).toContain("25%");
  });
});
