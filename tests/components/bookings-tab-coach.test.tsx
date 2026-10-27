// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { BookingsTab } from "../../src/components/admin/BookingsTab";

/**
 * A lesson at the counter (lib/lesson-coaches.ts): a difference owed for a
 * dearer coach, taken here on its own receipt; and a paid lesson given to
 * another coach, the manager's word on the money asked before any time is
 * offered, and sent with the change.
 */

const lesson = {
  id: 1,
  code: "MS-LES001",
  seriesCode: null,
  venueId: 1,
  venueName: "Arena MySenam",
  courtName: "Court 1",
  courtDeposit: 0,
  sport: "tennis",
  date: "2026-10-02",
  startHour: 10,
  endHour: 11,
  startMin: 600,
  endMin: 660,
  name: "Priya Devi",
  phone: "0163211606",
  totalPrice: 100,
  sharesPaid: 0,
  status: "confirmed",
  paymentStatus: "paid",
  paidVia: "cash",
  checkedInAt: null,
  checkedOutAt: null,
  noShow: false,
  priorNoShows: 0,
  hire: null,
  classId: null,
  people: [],
  coachId: 1,
  coachName: "Ana Lim",
  coachFee: 80,
};
const coach = (id: number, name: string) => ({ id, venueId: 1, name, bio: null, sports: ["tennis"], rate: 80, active: true, hours: [], timeOff: [] });
const terms = { fromCoach: { id: 1, name: "Ana Lim" }, toCoach: { id: 2, name: "Ben Tan" }, fromFee: 80, toFee: 100, difference: 20, paid: true, refundHow: "hand", owed: 0, refund: 0, absorbed: 0 };

let fetchMock: ReturnType<typeof vi.fn>;
let row: Record<string, unknown>;

beforeEach(() => {
  row = { ...lesson };
  fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
    if (url.startsWith("/api/admin/coaches")) return { ok: true, json: async () => ({ coaches: [coach(1, "Ana Lim"), coach(2, "Ben Tan")] }) };
    if (url.startsWith("/api/admin/bookings/lesson-coach") && init?.method !== "POST")
      return { ok: true, json: async () => ({ keep: { ...terms, absorbed: 20 }, adjust: { ...terms, owed: 20 } }) };
    if (url.startsWith("/api/admin/bookings/lesson-coach")) return { ok: true, json: async () => ({ ok: true, changeId: 5, amount: 20, receipt: "R9" }) };
    if (url.startsWith("/api/admin/bookings/reschedule") && init?.method !== "POST")
      return { ok: true, json: async () => ({ options: [{ startMin: 600, startHour: 10, courtId: 1, courtName: "Court 1", price: 20, difference: 0 }] }) };
    if (url.startsWith("/api/admin/bookings/reschedule"))
      return { ok: true, json: async () => ({ preview: { from: { date: "2026-10-02", startMin: 600, endMin: 660, courtId: 1, courtName: "Court 1" }, to: { date: "2026-10-02", startMin: 600, endMin: 660, courtId: 1, courtName: "Court 1" }, priceChange: 0, unchargedDifference: 0, outcome: "move", gameId: null, players: [], pending: { invited: 0, requested: 0, waitlisted: 0, offered: 0 }, clashes: 0, sharesPaid: 0 } }) };
    return { ok: true, json: async () => ({ bookings: [row], revenue: 100, collected: 100, outstanding: 0 }) };
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const posts = (prefix: string) => fetchMock.mock.calls.filter((c) => String(c[0]).startsWith(prefix) && c[1]?.method === "POST").map((c) => JSON.parse(c[1].body));

describe("a lesson at the counter", () => {
  it("shows a difference owed for a dearer coach, and takes it by the method chosen", async () => {
    row = { ...lesson, coachName: "Ben Tan", coachFee: 100, coachOwed: [{ changeId: 5, amount: 20, coach: "Ben Tan" }] };
    render(<BookingsTab />);
    await act(async () => {});
    const tr = screen.getByRole("table").querySelector("tbody tr")! as HTMLElement;
    const owed = within(tr).getByText(/owed for Ben Tan's fee: take it/);
    await act(async () => owed.click());
    await act(async () => within(tr).getByText("cash").click());
    expect(posts("/api/admin/bookings/lesson-coach")).toEqual([{ venueId: 1, changeId: 5, method: "cash" }]);
  });

  it("a paid lesson to another coach: no time is offered until keep or adjust is chosen, and the choice goes with the change", async () => {
    render(<BookingsTab />);
    await act(async () => {});
    const tr = screen.getByRole("table").querySelector("tbody tr")! as HTMLElement;
    await act(async () => within(tr).getByText("Change time").click());
    expect(screen.getByText("Change to when?")).toBeTruthy();
    await act(async () => {
      fireEvent.change(screen.getByDisplayValue("Ana Lim (as booked)"), { target: { value: "2" } });
    });
    expect(screen.queryByText("Change to when?")).toBeNull();
    expect(screen.getByTestId("coach-terms").textContent).toContain("It is paid");
    await act(async () => {
      fireEvent.click(screen.getAllByRole("radio")[0]);
    });
    expect(screen.getByText("Change to when?")).toBeTruthy();
    const asked = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/admin/bookings/reschedule?"));
    expect(asked.at(-1)).toContain("coachId=2");
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button").find((x) => (x.textContent ?? "").includes("Court 1 ·"))!);
    });
    expect(posts("/api/admin/bookings/reschedule").at(-1)).toMatchObject({ code: "MS-LES001", coachId: 2, coachMoney: "keep", preview: true });
  });
});
