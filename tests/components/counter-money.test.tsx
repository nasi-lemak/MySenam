// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { AdjustPrice } from "../../src/components/admin/AdjustPrice";
import { CashUpPanel } from "../../src/components/admin/CashUpPanel";
import { PayMark } from "../../src/components/admin/CounterMethod";
import { FIRST_PAGE, ListFilter, listParams } from "../../src/components/admin/ListFilter";
import { lastMonth, ReportsTab } from "../../src/components/admin/ReportsTab";
import { forgetStaffRole } from "../../src/components/admin/useStaffRole";

/**
 * The counter's money screens (round 8, P8b): the cash-up for the desk's own
 * shift and a manager's everybody's; a fee marked paid saying how; a
 * manager's *Adjust price*, hidden from the desk; the lists' search and
 * pages; and *Last month* on the Reports tab.
 */

const VENUES = [{ id: 1, name: "Arena MySenam" }] as unknown as Parameters<typeof CashUpPanel>[0]["venues"];

const cashUp = (scope: "own" | "all") => ({
  venueId: 1,
  date: "2026-10-28",
  staffId: scope === "own" ? 7 : null,
  scope,
  deskDays: ["2026-10-28", "2026-10-27"],
  staff: scope === "all" ? [{ id: 7, name: "Dee Desk" }, { id: 9, name: "Mo Manager" }] : [],
  byMethod: [
    { method: "cash", taken: 80, givenBack: 0, net: 80, count: 2, money: true },
    { method: "qr", taken: 120, givenBack: 120, net: 0, count: 2, money: true },
    { method: "credit", taken: 30, givenBack: 0, net: 30, count: 1, money: false },
  ],
  totals: { taken: 200, givenBack: 120, net: 80 },
  entries: [
    { at: "2026-10-28T02:00:00.000Z", number: "R-000001", type: "Receipt", customer: "Cara", description: "", category: "Stored credit", method: "cash", gross: 50, staffName: "Dee Desk" },
    { at: "2026-10-28T03:00:00.000Z", number: "CN-000001", type: "Credit note", customer: "Pat", description: "", category: "Passes", method: "qr", gross: -120, staffName: "Mo Manager" },
  ],
});

let role: "manager" | "desk" = "desk";
const calls: { url: string; body?: unknown }[] = [];
beforeEach(() => {
  calls.length = 0;
  forgetStaffRole();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.startsWith("/api/admin/auth/me")) return { ok: true, json: async () => ({ admin: { id: 7, role } }) };
      if (url.startsWith("/api/admin/cash-up")) return { ok: true, json: async () => cashUp(role === "desk" ? "own" : "all") };
      if (url.startsWith("/api/admin/bookings/adjust-price?")) return { ok: true, json: async () => ({ adjustments: [] }) };
      if (url.startsWith("/api/admin/bookings/adjust-price"))
        return { ok: true, json: async () => ({ adjustment: { before: 30, after: 0, delta: -30 }, creditNote: null }) };
      return { ok: true, json: async () => ({}) };
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("the cash-up", () => {
  it("shows the desk its own shift by method, today or yesterday, without anybody else's", async () => {
    role = "desk";
    render(<CashUpPanel venues={VENUES} />);
    await act(async () => {});
    expect(screen.getByText(/What you took and gave back yourself/)).toBeTruthy();
    expect(screen.getByRole("option", { name: "Yesterday (2026-10-27)" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Everybody" })).toBeNull();
    // Cash, QR and what credit paid, which is no money.
    expect(screen.getByText(/no money changed hands/)).toBeTruthy();
    expect(screen.getByText("(credit note)")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Print the cash-up" }).getAttribute("href")).toBe("/admin/cash-up?venueId=1&date=2026-10-28");
  });

  it("lets a manager choose one member of staff, the printout following", async () => {
    role = "manager";
    render(<CashUpPanel venues={VENUES} />);
    await act(async () => {});
    const who = screen.getByRole("combobox", { name: "Whose" });
    await act(async () => {
      fireEvent.change(who, { target: { value: "7" } });
    });
    expect(calls.some((c) => c.url.includes("staffId=7"))).toBe(true);
    expect(screen.getByRole("link", { name: "Print the cash-up" }).getAttribute("href")).toContain("staffId=7");
  });
});

describe("a fee marked paid", () => {
  it("asks how, and says it", () => {
    const paid = vi.fn();
    render(<PayMark paid={false} paidLabel="Paid" unpaidLabel="Unpaid" onPaid={paid} onUnpaid={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Unpaid" }));
    fireEvent.click(screen.getByRole("button", { name: "Card terminal" }));
    expect(paid).toHaveBeenCalledWith("card");
  });
});

describe("adjusting a booking's price", () => {
  const booking = { code: "MS-ADJ001", status: "confirmed", paymentStatus: "unpaid", paidVia: null, totalPrice: 30, sharesPaid: 0 };

  it("is not offered to the desk", async () => {
    role = "desk";
    render(<AdjustPrice b={booking} onDone={() => {}} />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Adjust price" })).toBeNull();
  });

  it("is not offered for one paid online", async () => {
    role = "manager";
    render(<AdjustPrice b={{ ...booking, paymentStatus: "paid", paidVia: "online" }} onDone={() => {}} />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Adjust price" })).toBeNull();
  });

  it("sends a manager's complimentary with the reason", async () => {
    role = "manager";
    const done = vi.fn();
    render(<AdjustPrice b={booking} onDone={done} />);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Adjust price" }));
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Complimentary" }));
    fireEvent.change(screen.getByPlaceholderText("e.g. lights failed last week"), { target: { value: "Sponsor's hour" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save the price" }));
    });
    expect(calls.find((c) => c.url === "/api/admin/bookings/adjust-price")?.body).toEqual({ code: "MS-ADJ001", complimentary: true, reason: "Sponsor's hour" });
    expect(done).toHaveBeenCalled();
    expect(screen.getByText(/Price RM30.* → RM0/)).toBeTruthy();
  });
});

describe("the lists' search", () => {
  it("searches from the first page, and pages on", () => {
    const change = vi.fn();
    render(<ListFilter query={{ ...FIRST_PAGE, page: 2 }} onChange={change} more statuses={[{ value: "lapsing", label: "p8b.list.lapsing" }]} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: " Aminah " } });
    fireEvent.submit(screen.getByRole("search"));
    expect(change).toHaveBeenLastCalledWith({ q: "Aminah", status: "", page: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Older" }));
    expect(change).toHaveBeenLastCalledWith({ q: "", status: "", page: 3 });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "lapsing" } });
    expect(change).toHaveBeenLastCalledWith({ q: "", status: "lapsing", page: 1 });
    expect(listParams({ q: "a b", status: "lapsing", page: 2 })).toBe("&q=a%20b&status=lapsing&page=2");
  });
});

describe("Reports: last month", () => {
  it("is the calendar month before, first day to last, whatever the day today", () => {
    expect(lastMonth("2026-11-03")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(lastMonth("2026-03-31")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(lastMonth("2027-01-01")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });

  it("sets the period and the accountant's downloads", async () => {
    render(<ReportsTab venues={VENUES} />);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Last month" }));
    });
    const { from, to } = lastMonth();
    expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe(from);
    expect(screen.getByRole("link", { name: /Sales journal/ }).getAttribute("href")).toContain(`from=${from}&to=${to}&kind=journal`);
  });
});
