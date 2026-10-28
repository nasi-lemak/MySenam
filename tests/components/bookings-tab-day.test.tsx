// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { BookingsTab } from "../../src/components/admin/BookingsTab";
import { ScheduleTab } from "../../src/components/admin/ScheduleTab";

/**
 * The counter's day (X1-18, X1-1, X1-3, X1-10, X1-9): the list filtered and
 * printable, the venue column only for several venues, actions in one menu;
 * cancelling a paid booking shown first and settled as chosen; a booking's
 * details corrected; weeks of a series cancelled; a booking started from the
 * tab or a free schedule cell.
 */

const base = {
  seriesCode: null,
  groupCode: null,
  venueId: 1,
  venueName: "Arena MySenam",
  courtDeposit: 0,
  sport: "badminton",
  date: "2026-10-30",
  endHour: 21,
  email: null,
  status: "confirmed",
  checkedOutAt: null,
  noShow: false,
  priorNoShows: 0,
  hire: null,
  classId: null,
  people: [],
  sharesPaid: 0,
};
const paidIn = { ...base, id: 1, code: "MS-PAIDIN", courtId: 1, courtName: "Court 1", startHour: 18, name: "Priya Devi", phone: "0163211606", totalPrice: 20, paymentStatus: "paid", paidVia: "cash", checkedInAt: "2026-10-30T10:00:00Z" };
const unpaid = { ...base, id: 2, code: "MS-UNPAID", courtId: 2, courtName: "Court 2", startHour: 19, name: "Ali Hassan", phone: "0123334444", totalPrice: 20, paymentStatus: "unpaid", checkedInAt: null };
const weekly = { ...base, id: 3, code: "MS-WEEKLY", courtId: 1, courtName: "Court 1", startHour: 20, name: "Liga", phone: "0175556666", totalPrice: 20, paymentStatus: "paid", paidVia: "cash", checkedInAt: null, seriesCode: "SR-ABC123" };

const preview = {
  code: "MS-PAIDIN",
  name: "Priya Devi",
  date: "2026-10-30",
  startHour: 18,
  endHour: 19,
  seriesCode: null,
  paid: 20,
  paidVia: "cash",
  paidAt: "2026-10-30T02:00:00Z",
  how: "counter",
  deposit: 0,
  late: true,
  cutoffHours: 24,
  keptPercent: 50,
  options: [
    { outcome: "back", refund: 20, kept: 0 },
    { outcome: "credit", refund: 20, kept: 0 },
    { outcome: "keep", refund: 10, kept: 10 },
  ],
  managerOnly: false,
  kitOut: false,
  account: true,
};

let fetchMock: ReturnType<typeof vi.fn>;
let day: { bookings: object[]; payouts?: object[] };
let answers: Record<string, unknown>;

beforeEach(() => {
  day = { bookings: [paidIn, unpaid, weekly], payouts: [] };
  answers = {};
  fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const key = `${init?.method ?? "GET"} ${url.split("?")[0]}${init?.body && JSON.parse(init.body).preview ? " preview" : ""}`;
    if (key in answers) return { ok: true, json: async () => answers[key] };
    return { ok: true, json: async () => ({ ...day, revenue: 60, collected: 40, outstanding: 20 }) };
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const posts = () => fetchMock.mock.calls.filter((c) => c[1]?.method && c[1].method !== "GET");
const rows = () => [...screen.getByRole("table").querySelectorAll("tbody tr")] as HTMLElement[];
const rowOf = (code: string) => rows().find((r) => r.textContent?.includes(code))!;

async function show(venues = [{ id: 1, name: "Arena MySenam" }]) {
  render(<BookingsTab venues={venues} />);
  await act(async () => {});
}

describe("the day list", () => {
  it("leaves the venue column out for one venue, and shows it where bookings of several are listed", async () => {
    await show();
    expect(screen.getByRole("table").querySelector("thead")!.textContent).not.toContain("Venue");
    day.bookings = [paidIn, { ...unpaid, venueId: 2, venueName: "Arena Dua" }];
    await act(async () => fireEvent.change(screen.getByLabelText("Day to show"), { target: { value: "2026-10-31" } }));
    expect(screen.getByRole("table").querySelector("thead")!.textContent).toContain("Venue");
    expect(screen.getByLabelText("Venue")).toBeTruthy();
  });

  it("filters to the unpaid, those not checked in, and one court, saying how many are shown", async () => {
    await show();
    expect(rows()).toHaveLength(3);
    await act(async () => fireEvent.click(screen.getByLabelText("Unpaid")));
    expect(rows().map((r) => r.textContent)).toEqual([expect.stringContaining("MS-UNPAID")]);
    expect(screen.getByText("1 of 3 shown")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByLabelText("Unpaid")));
    await act(async () => fireEvent.click(screen.getByLabelText("Not checked in")));
    expect(rows()).toHaveLength(2);
    await act(async () => fireEvent.click(screen.getByLabelText("Not checked in")));
    await act(async () => fireEvent.change(screen.getByLabelText("Court"), { target: { value: "2" } }));
    expect(rows()).toHaveLength(1);
  });

  it("keeps each row's actions in one menu, and prints the day sheet", async () => {
    const print = vi.fn();
    vi.stubGlobal("print", print);
    await show();
    const menu = rowOf("MS-PAIDIN").querySelector("details")!;
    expect(within(menu).getByText(/Actions/)).toBeTruthy();
    for (const name of ["Move", "Correct details", "Cancel"]) expect(within(menu).getByText(name)).toBeTruthy();
    expect(within(rowOf("MS-WEEKLY")).getByText("Cancel weeks of the series")).toBeTruthy();
    expect(document.getElementById("day-sheet")).toBeTruthy();
    await act(async () => screen.getByText("Print day sheet").click());
    expect(print).toHaveBeenCalled();
  });

  it("opens the venue's booking page on the day shown for a new booking", async () => {
    await show();
    const link = screen.getByText("New booking").closest("a")!;
    expect(link.getAttribute("href")).toMatch(/^\/venue\/1\?date=\d{4}-\d{2}-\d{2}$/);
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("lists what was handed back at the counter that day, for the till", async () => {
    day.payouts = [
      { id: 1, venueId: 1, bookingCode: "MS-GONE01", amount: 20, via: "cash", keptPercent: null, creditNote: "CN-000004", adminName: "Dina Desk", paidOutAt: "2026-10-30T05:00:00Z" },
    ];
    await show();
    const box = screen.getByTestId("payouts");
    expect(box.textContent).toContain("RM20");
    expect(box.textContent).toContain("MS-GONE01 (CN-000004)");
    expect(box.textContent).toContain("Dina Desk");
    expect(box.textContent).toContain("In all: RM20");
  });
});

describe("cancelling a paid booking", () => {
  it("shows what was paid and the venue's terms, then cancels as chosen on the amount shown", async () => {
    answers["POST /api/admin/bookings/cancel preview"] = { preview };
    await show();
    await act(async () => within(rowOf("MS-PAIDIN")).getByText("Cancel").click());
    const panel = screen.getByTestId("cancel-panel");
    expect(panel.textContent).toContain("Paid RM20 by Cash");
    expect(panel.textContent).toContain("leaves the venue 50%");
    for (const label of ["Hand RM20 back from the till (Cash)", "Give RM20 as stored credit", "Keep RM10 (50%), give RM10 back"])
      expect(within(panel).getByText(label)).toBeTruthy();
    answers["POST /api/admin/bookings/cancel"] = { settled: { outcome: "keep", refund: 10, kept: 10, paidOut: { amount: 10, via: "cash" } } };
    await act(async () => within(panel).getByText("Keep RM10 (50%), give RM10 back").click());
    const sent = posts().map((c) => JSON.parse(c[1].body));
    expect(sent.at(-1)).toEqual({ code: "MS-PAIDIN", outcome: "keep", expectRefund: 10 });
    expect(screen.getByText("Booking MS-PAIDIN cancelled. Hand RM10 back from the till.")).toBeTruthy();
  });

  it("tells the front desk a counter payment from an earlier day is a manager's, and offers no refund", async () => {
    answers["POST /api/admin/bookings/cancel preview"] = { preview: { ...preview, managerOnly: true, late: false, keptPercent: null, options: preview.options.slice(0, 2) } };
    await show();
    await act(async () => within(rowOf("MS-PAIDIN")).getByText("Cancel").click());
    const panel = screen.getByTestId("cancel-panel");
    expect(panel.textContent).toContain("only a manager can give it back");
    expect((within(panel).getByText("Hand RM20 back from the till (Cash)") as HTMLButtonElement).disabled).toBe(true);
    expect((within(panel).getByText("Give RM20 as stored credit") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("correcting a booking's details", () => {
  it("sends the corrected details, and a manager's override with the reason asked for", async () => {
    await show();
    await act(async () => within(rowOf("MS-UNPAID")).getByText("Correct details").click());
    const panel = screen.getByTestId("correct-details");
    fireEvent.change(within(panel).getByLabelText("Phone number"), { target: { value: "0129998888" } });
    let call = 0;
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method === "PATCH")
        return ++call === 1
          ? { ok: false, json: async () => ({ error: "This number has no-shows.", code: "R9_DESK_STRIKES", policy: "strikes", overridable: true }) }
          : { ok: true, json: async () => ({ codes: ["MS-UNPAID"], changed: { name: false, phone: true, email: false }, overridden: [] }) };
      return { ok: true, json: async () => ({ ...day, revenue: 0, collected: 0, outstanding: 0 }) };
    });
    vi.stubGlobal("prompt", () => "Regular customer, our mistake");
    await act(async () => within(panel).getByText("Save the correction").click());
    const patches = fetchMock.mock.calls.filter((c) => c[1]?.method === "PATCH").map((c) => JSON.parse(c[1].body));
    expect(patches[0]).toEqual({ code: "MS-UNPAID", name: "Ali Hassan", phone: "0129998888", email: null, scope: "booking" });
    expect(patches[1]).toMatchObject({ overridePolicies: ["strikes"], overrideReason: "Regular customer, our mistake" });
    expect(screen.getByText("Details corrected on MS-UNPAID.")).toBeTruthy();
  });

  it("offers the whole series for a weekly booking", async () => {
    await show();
    await act(async () => within(rowOf("MS-WEEKLY")).getByText("Correct details").click());
    expect(screen.getByLabelText("Every week of its series with these details")).toBeTruthy();
  });
});

describe("cancelling weeks of a series", () => {
  it("lists each week with its terms, and cancels the weeks ticked, settled as chosen", async () => {
    const week = (code: string, date: string, late: boolean) => ({ ...preview, code, date, late, keptPercent: late ? 50 : null, seriesCode: "SR-ABC123", open: true, options: late ? preview.options : preview.options.slice(0, 2) });
    answers["POST /api/admin/bookings/cancel-series preview"] = { weeks: [week("MS-WEEK01", "2026-10-30", true), week("MS-WEEK02", "2026-11-06", false)] };
    await show();
    await act(async () => within(rowOf("MS-WEEKLY")).getByText("Cancel weeks of the series").click());
    const panel = screen.getByTestId("series-cancel");
    expect(panel.textContent).toContain("past the cutoff");
    expect(panel.textContent).toContain("free to cancel");
    expect(panel.textContent).toContain("2 weeks chosen: RM40 back, RM0 kept.");
    await act(async () => fireEvent.click(within(panel).getByLabelText(/Keep the venue's late share/)));
    expect(panel.textContent).toContain("2 weeks chosen: RM30 back, RM10 kept.");
    answers["POST /api/admin/bookings/cancel-series"] = { cancelled: [{ code: "MS-WEEK01" }, { code: "MS-WEEK02" }], left: [] };
    await act(async () => within(panel).getByText("Cancel the weeks chosen").click());
    const body = JSON.parse(posts().at(-1)![1].body);
    expect(body).toEqual({ seriesCode: "SR-ABC123", codes: ["MS-WEEK01", "MS-WEEK02"], outcome: "keep", expect: { "MS-WEEK01": 10, "MS-WEEK02": 20 } });
    expect(screen.getByText("Weeks cancelled: 2.")).toBeTruthy();
  });
});

describe("a free cell on the court schedule", () => {
  it("asks whether to book it at the counter or block it", async () => {
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () =>
        url.startsWith("/api/admin/slots")
          ? {
              courts: [
                {
                  court: { id: 7, name: "Court 7", sport: "badminton", capacity: 1, venueId: 1 },
                  grid: 60,
                  slots: [{ minute: 1080, hour: 18, status: "free", booked: 0 }],
                  entries: [],
                },
              ],
            }
          : {},
    }));
    render(<ScheduleTab venues={[{ id: 1, name: "Arena MySenam", courts: [] } as never]} />);
    await act(async () => {});
    await act(async () => screen.getByTitle("Free: click to book it or block it").click());
    const choice = screen.getByTestId("free-cell-choice");
    expect(fetchMock.mock.calls.filter((c) => c[1]?.method === "POST")).toHaveLength(0);
    expect(within(choice).getByText("Book this").closest("a")!.getAttribute("href")).toMatch(/^\/venue\/1\?court=7&date=\d{4}-\d{2}-\d{2}&start=1080&sport=badminton$/);
    await act(async () => within(choice).getByText("Block").click());
    const blocks = fetchMock.mock.calls.filter((c) => c[1]?.method === "POST");
    expect(String(blocks[0][0])).toBe("/api/admin/blocks");
    expect(JSON.parse(blocks[0][1].body)).toMatchObject({ courtId: 7, hours: [18] });
  });
});
