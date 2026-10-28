// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { BookingsTab } from "../../src/components/admin/BookingsTab";

/**
 * The day list's two R9E parts: counter payments owed back on bookings the
 * venue cancelled, each settled with one button (handed back, or as credit
 * where booked from an account; a manager's where paid on an earlier day),
 * and moving a weekly series in one step, previewed week by week first.
 */

const base = {
  groupCode: null,
  venueId: 1,
  venueName: "Arena MySenam",
  courtDeposit: 0,
  sport: "badminton",
  date: "2026-11-03",
  endHour: 11,
  email: null,
  status: "confirmed",
  checkedOutAt: null,
  noShow: false,
  priorNoShows: 0,
  hire: null,
  classId: null,
  people: [],
  sharesPaid: 0,
  checkedInAt: null,
};
const weekly = { ...base, id: 3, code: "MS-WEEKLY", courtId: 1, courtName: "Court 1", startHour: 10, name: "Liga", phone: "0175556666", totalPrice: 20, paymentStatus: "unpaid", seriesCode: "SR-ABC123" };

const owed = [
  { id: 7, venueId: 1, bookingId: 70, bookingCode: "MS-FLOOD1", name: "Priya Devi", date: "2026-11-05", startMin: 600, amount: 20, via: "cash", cause: "closure", owedSince: "2026-11-01T02:00:00Z", paidAt: "2026-11-01T01:00:00Z", account: true, managerOnly: false, settled: null },
  { id: 8, venueId: 1, bookingId: 80, bookingCode: "MS-RAIN01", name: "Ali Hassan", date: "2026-11-05", startMin: 900, amount: 30, via: "qr", cause: "rain", owedSince: "2026-11-01T02:00:00Z", paidAt: "2026-10-28T01:00:00Z", account: false, managerOnly: true, settled: null },
];

const weeks = [
  { code: "MS-WEEKLY", from: { date: "2026-11-03", startMin: 600, endMin: 660, courtId: 1, courtName: "Court 1" }, to: { date: "2026-11-05", startMin: 1080, endMin: 1140, courtId: 1, courtName: "Court 1" }, movable: true, priceChange: 10, unchargedDifference: 0, outcome: "move" },
  { code: "MS-WEEK2", from: { date: "2026-11-10", startMin: 600, endMin: 660, courtId: 1, courtName: "Court 1" }, to: { date: "2026-11-12", startMin: 1080, endMin: 1140, courtId: 1, courtName: null }, movable: false, priceChange: 0, unchargedDifference: 0, refusal: { error: "That time is taken.", code: "RESCHEDULE_TAKEN" } },
];

let fetchMock: ReturnType<typeof vi.fn>;
let answers: Record<string, unknown>;

beforeEach(() => {
  answers = {
    "GET /api/admin/bookings/move-series": { weekday: 2, start: 600, courtId: 1, weeks: 2, courts: [{ id: 1, name: "Court 1" }, { id: 2, name: "Court 2" }] },
    "POST /api/admin/bookings/move-series preview": { weeks },
    "POST /api/admin/bookings/move-series": { moved: [{ code: "MS-WEEKLY" }], left: [] },
    "POST /api/admin/bookings/owed": { settled: { outcome: "back" } },
  };
  fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const key = `${init?.method ?? "GET"} ${url.split("?")[0]}${init?.body && JSON.parse(init.body).preview ? " preview" : ""}`;
    if (key in answers) return { ok: true, json: async () => answers[key] };
    return { ok: true, json: async () => ({ bookings: [weekly], payouts: [], owed, revenue: 20, collected: 0, outstanding: 20 }) };
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const posts = (path: string) => fetchMock.mock.calls.filter((c) => c[1]?.method === "POST" && String(c[0]).startsWith(path)).map((c) => JSON.parse(c[1].body));

async function show() {
  render(<BookingsTab venues={[{ id: 1, name: "Arena MySenam" }]} />);
  await act(async () => {});
}

describe("money owed back after the venue cancelled", () => {
  it("lists each with why, settles one with a button, and leaves an earlier day's payment to a manager", async () => {
    await show();
    const box = screen.getByTestId("owed");
    expect(box.textContent).toContain("MS-FLOOD1");
    expect(box.textContent).toContain("the venue closed that day");
    expect(box.textContent).toContain("rained off");
    expect(box.textContent).toContain("a manager hands it back");
    // Credit only where booked from an account; nothing to press on the manager's one.
    expect(within(box).getAllByRole("button").map((b) => b.textContent)).toEqual(["Handed back RM20", "Give RM20 as credit"]);
    await act(async () => {
      fireEvent.click(within(box).getByRole("button", { name: "Give RM20 as credit" }));
    });
    expect(posts("/api/admin/bookings/owed")).toEqual([{ id: 7, outcome: "credit" }]);
    expect(screen.getByText(/given as stored credit for MS-FLOOD1/)).toBeTruthy();
  });
});

describe("moving a weekly series", () => {
  it("previews the weeks, ticks those that can move, says why one cannot, and moves the ones ticked", async () => {
    await show();
    const [button] = screen.getAllByRole("button", { name: "Move the series" });
    await act(async () => {
      fireEvent.click(button);
    });
    const panel = screen.getByTestId("series-move");
    // Starts from the series as it is.
    expect((within(panel).getByLabelText("Day") as HTMLSelectElement).value).toBe("2");
    expect((within(panel).getByLabelText("Start") as HTMLInputElement).value).toBe("10:00");
    fireEvent.change(within(panel).getByLabelText("Day"), { target: { value: "4" } });
    fireEvent.change(within(panel).getByLabelText("Start"), { target: { value: "18:00" } });
    fireEvent.change(within(panel).getByLabelText("Court"), { target: { value: "1" } });
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "Show the weeks" }));
    });
    expect(posts("/api/admin/bookings/move-series")[0]).toEqual({ seriesCode: "SR-ABC123", start: 1080, weekday: 4, courtId: 1, preview: true });
    const boxes = within(panel).getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((b) => [b.checked, b.disabled])).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(panel.textContent).toContain("price +RM10");
    expect(panel.textContent).toContain("cannot move:");
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "Move 1 week" }));
    });
    expect(posts("/api/admin/bookings/move-series")[1]).toEqual({ seriesCode: "SR-ABC123", start: 1080, weekday: 4, courtId: 1, codes: ["MS-WEEKLY"] });
    expect(screen.getByText(/Weeks moved: 1/)).toBeTruthy();
    expect(screen.queryByTestId("series-move")).toBeNull();
  });
});
