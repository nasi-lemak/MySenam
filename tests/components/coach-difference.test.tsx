// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { LanguageProvider } from "../../src/components/Language";
import { CoachDifference } from "../../src/components/CoachDifference";
import { BookingsTab } from "../../src/components/admin/BookingsTab";

/**
 * A dearer coach's difference on screen (owner's decision of 28 October
 * 2026; lib/lesson-coaches.ts): the customer's booking page and the email's
 * link offer paying it online where the venue takes payment online, the
 * counter still an option; paid, how and its receipt. The counter sees it
 * owed, being paid online (and closes the page to take it here), or paid.
 */

let calls: { url: string; init?: RequestInit }[];
const assign = vi.fn();

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return { ok: true, status: 200, json: async () => ({ url: "https://checkout.stripe.com/c/pay/cs_test_x", amount: 20, reused: false }) };
    })
  );
  Object.defineProperty(window, "location", { value: { ...window.location, assign }, writable: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  assign.mockReset();
});

const owed = { changeId: 5, amount: 20, coach: "Ben Tan", state: "owed" as const, via: null, receiptUrl: null };

describe("the customer's view of a coach's difference", () => {
  it("owed, where the venue takes payment online: pay that amount online, or at the counter; the booking's code and phone go with it", async () => {
    render(
      <LanguageProvider locale="en">
        <CoachDifference items={[owed]} source={{ code: "MS-LES001", phone: "0123456789" }} payOnline />
      </LanguageProvider>
    );
    expect(screen.getByText(/owed for Ben Tan's fee/)).toBeTruthy();
    expect(screen.getByText("Or pay it at the venue's counter.")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Pay RM\s?20(\.00)? online/ }));
    });
    expect(calls[0].url).toBe("/api/payments/coach-difference");
    expect(JSON.parse(String(calls[0].init!.body))).toEqual({ code: "MS-LES001", phone: "0123456789", changeId: 5 });
    expect(assign).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_test_x");
  });

  it("from the email's link: the token goes, nothing else", async () => {
    render(
      <LanguageProvider locale="en">
        <CoachDifference items={[{ ...owed, state: "paying" }]} source={{ token: "5-abc" }} payOnline />
      </LanguageProvider>
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Continue paying/ }));
    });
    expect(JSON.parse(String(calls[0].init!.body))).toEqual({ token: "5-abc" });
  });

  it("where the venue takes no payment online: the counter only; paid: how, and its receipt; in Malay too", () => {
    const { unmount } = render(
      <LanguageProvider locale="en">
        <CoachDifference items={[owed]} source={{ token: "5-abc" }} payOnline={false} />
      </LanguageProvider>
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Pay it at the venue's counter.")).toBeTruthy();
    unmount();
    render(
      <LanguageProvider locale="ms">
        <CoachDifference items={[{ ...owed, state: "paid", via: "online", receiptUrl: "/receipt/R1" }]} source={{ token: "5-abc" }} payOnline />
      </LanguageProvider>
    );
    expect(screen.getByText(/bagi bayaran Ben Tan: dibayar dalam talian/)).toBeTruthy();
    expect(screen.getByRole("link").getAttribute("href")).toBe("/receipt/R1");
  });
});

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
  coachId: 2,
  coachName: "Ben Tan",
  coachFee: 100,
};

describe("the counter's view of a coach's difference", () => {
  function stubDay(row: Record<string, unknown>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        if (String(url).startsWith("/api/admin/bookings/lesson-coach")) return { ok: true, json: async () => ({ ok: true, changeId: 5, amount: 20, receipt: "R9", closedPage: true }) };
        return { ok: true, json: async () => ({ bookings: [row], revenue: 120, collected: 100, outstanding: 20 }) };
      })
    );
  }

  it("being paid online: shown with the page's time; taking it here says it closes the page, and sends that", async () => {
    stubDay({ ...lesson, coachOwed: [{ changeId: 5, amount: 20, coach: "Ben Tan", pageOpenUntil: "2026-10-02T02:30:00.000Z", zone: "Asia/Kuala_Lumpur" }] });
    render(<BookingsTab />);
    await act(async () => {});
    const tr = screen.getByRole("table").querySelector("tbody tr")! as HTMLElement;
    const paying = within(tr).getByText(/the customer is paying online, page open until 10:30/i);
    await act(async () => paying.click());
    expect(within(tr).getByText(/Close their page and take/)).toBeTruthy();
    await act(async () => within(tr).getByText("cash").click());
    const post = calls.find((c) => c.url.startsWith("/api/admin/bookings/lesson-coach") && c.init?.method === "POST")!;
    expect(JSON.parse(String(post.init!.body))).toEqual({ venueId: 1, changeId: 5, method: "cash", closePage: true });
  });

  it("paid: how", async () => {
    stubDay({ ...lesson, coachPaid: [{ changeId: 5, amount: 20, coach: "Ben Tan", via: "online" }] });
    render(<BookingsTab />);
    await act(async () => {});
    const tr = screen.getByRole("table").querySelector("tbody tr")! as HTMLElement;
    expect(within(tr).getByText(/for Ben Tan's fee: paid \(Online\)/)).toBeTruthy();
    expect(within(tr).queryByText(/take it/)).toBeNull();
  });
});
