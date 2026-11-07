// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { BookingsTab } from "../../src/components/admin/BookingsTab";

/**
 * Hardening, brief MONEY (ADR 0068): what the day list says about money handed back at the counter. Every payout in one list (a booking's, an entry fee's,
 * a pass's refund, a membership's), the refund of a pass or membership sold at the counter as a task that says a credit note is not money paid, and the way to
 * say, once, how a hire deposit taken before its method was recorded was held.
 */

const base = {
  groupCode: null,
  venueId: 1,
  venueName: "Arena MySenam",
  courtDeposit: 40,
  sport: "kayak",
  date: "2026-11-03",
  endHour: 11,
  email: null,
  status: "confirmed",
  checkedOutAt: null,
  noShow: false,
  priorNoShows: 0,
  classId: null,
  people: [],
  sharesPaid: 0,
  checkedInAt: "2026-11-03T02:00:00Z",
  seriesCode: null,
};
const legacyHire = { id: 1, bookingId: 3, bookingCode: "MS-KAYAK1", courtId: 1, courtName: "Kayak", venueId: 1, name: "Paddler", phone: "0175556666", deposit: 40, depositVia: null, depositViaStated: null, takenAt: "2026-11-03T02:10:00Z", returnedAt: null, withheld: null, condition: null, note: null };
const kayak = { ...base, id: 3, code: "MS-KAYAK1", courtId: 1, courtName: "Kayak", startHour: 10, name: "Paddler", phone: "0175556666", totalPrice: 20, paymentStatus: "paid", hire: legacyHire };

const payouts = [
  { id: 1, venueId: 1, kind: "booking", bookingCode: "MS-GONE01", what: "", amount: 20, via: "cash", keptPercent: null, creditNote: "CN-000004", adminName: "Dina Desk", paidOutAt: "2026-11-03T03:00:00Z" },
  { id: 2, venueId: 1, kind: "pass", bookingCode: "", what: "Aisyah, Ten PX12", amount: 100, via: "cash", keptPercent: null, creditNote: "CN-000009", adminName: "Musa Manager", paidOutAt: "2026-11-03T03:30:00Z" },
  { id: 3, venueId: 1, kind: "entry", bookingCode: "", what: "Player One, Handback Cup", amount: 20, via: "qr", keptPercent: null, creditNote: "CN-000010", adminName: "Musa Manager", paidOutAt: "2026-11-03T04:00:00Z" },
];
const feesOwed = [
  { id: 5, venueId: 1, kind: "pass", entryId: null, tournamentId: null, tournamentName: "", what: "Ten PX12", name: "Aisyah", creditNote: "CN-000009", amount: 100, via: "cash", cause: "pass_refunded", owedSince: "2026-11-03T02:00:00Z", paidAt: "2026-11-03T02:00:00Z", managerOnly: false, settled: null },
  { id: 6, venueId: 1, kind: "membership", entryId: null, tournamentId: null, tournamentName: "", what: "MB-77", name: "Nurul", creditNote: "CN-000011", amount: 80, via: null, cause: "membership_refunded", owedSince: "2026-10-29T02:00:00Z", paidAt: "2026-10-29T02:00:00Z", managerOnly: true, settled: null },
  { id: 7, venueId: 1, kind: "entry", entryId: 9, tournamentId: 2, tournamentName: "Handback Cup", what: "Handback Cup", name: "Player Two", creditNote: null, amount: 20, via: "cash", cause: "tournament_cancelled", owedSince: "2026-11-03T02:00:00Z", paidAt: "2026-11-03T01:00:00Z", managerOnly: false, settled: null },
];

let fetchMock: ReturnType<typeof vi.fn>;
let answers: Record<string, unknown>;

beforeEach(() => {
  answers = {
    "POST /api/admin/bookings/owed": { feeOwed: { id: 5 } },
    "GET /api/admin/hire": { hires: [], deductions: [] },
    "POST /api/admin/hire": { hire: { ...legacyHire, depositViaStated: { via: "qr", by: "Dina Desk", at: "2026-11-03T05:00:00Z" } }, changed: true },
  };
  fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const key = `${init?.method ?? "GET"} ${url.split("?")[0]}`;
    if (key in answers) return { ok: true, json: async () => answers[key] };
    return { ok: true, json: async () => ({ bookings: [kayak], payouts, owed: [], feesOwed, revenue: 20, collected: 20, outstanding: 0 }) };
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const posts = (path: string) => fetchMock.mock.calls.filter((c) => c[1]?.method === "POST" && String(c[0]).startsWith(path)).map((c) => JSON.parse(c[1].body));

async function show() {
  render(<BookingsTab venues={[{ id: 1, name: "Arena MySenam" }]} />);
  await act(async () => {});
}

describe("what was handed back at the counter that day", () => {
  it("is one list: a booking's payout, a pass's refund and an entry fee, each with how, the credit note and who", async () => {
    await show();
    const box = screen.getByTestId("payouts");
    expect(box.textContent).toContain("MS-GONE01 (CN-000004)");
    expect(box.textContent).toContain("Pass refund: Aisyah, Ten PX12 (CN-000009)");
    expect(box.textContent).toContain("Entry fee: Player One, Handback Cup (CN-000010)");
    expect(box.textContent).toContain("Musa Manager");
    expect(box.textContent).toContain("In all: RM140");
  });
});

describe("a pass or a membership sold at the counter and cancelled with a refund", () => {
  it("is a task that says a credit note is not money paid, settled with one button, and a manager's where written on an earlier day", async () => {
    await show();
    const box = screen.getByTestId("owed-sales");
    expect(box.textContent).toContain("not money paid");
    expect(box.textContent).toContain("Aisyah · pass Ten PX12 · RM100 by Cash · credit note CN-000009");
    expect(box.textContent).toContain("Nurul · membership MB-77");
    expect(box.textContent).toContain("a manager hands it back");
    // One button, for the one written today; nothing to press on the manager's.
    expect(within(box).getAllByRole("button").map((b) => b.textContent)).toEqual(["Handed back RM100"]);
    await act(async () => {
      fireEvent.click(within(box).getByRole("button", { name: "Handed back RM100" }));
    });
    expect(posts("/api/admin/bookings/owed")).toEqual([{ id: 5, kind: "entry_fee", outcome: "back" }]);
    expect(screen.getByText(/RM100 handed back to Aisyah/)).toBeTruthy();
    // The entry fee is in its own panel, as before.
    expect(screen.getByTestId("owed-fees").textContent).toContain("Player Two · Handback Cup");
    expect(screen.getByTestId("owed-fees").textContent).not.toContain("pass Ten");
  });
});

describe("a hire deposit taken before the method was recorded", () => {
  it("asks how it was held, says it once, and then shows who said it and keeps the marker", async () => {
    await show();
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /out · RM40/ })[0]);
    });
    const panel = screen.getByTestId("deposit-method");
    expect(panel.textContent).toContain("taken before the method was recorded");
    // Nothing to say yet: refused on the screen, nothing sent.
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "Record it" }));
    });
    expect(posts("/api/admin/hire")).toEqual([]);
    fireEvent.change(within(panel).getByRole("combobox"), { target: { value: "qr" } });
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "Record it" }));
    });
    expect(posts("/api/admin/hire")).toEqual([{ code: "MS-KAYAK1", action: "state_method", via: "qr" }]);
    expect(screen.getByTestId("deposit-method").textContent).toContain("Not recorded when it was taken. Held by QR, as Dina Desk said");
    expect(within(screen.getByTestId("deposit-method")).queryByRole("button")).toBeNull();
  });
});
