// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { LanguageProvider } from "../../src/components/Language";
import { WithdrawPeople, withdrawMoneyLine } from "../../src/components/WithdrawPeople";
import { translator } from "../../src/lib/i18n";

/**
 * Taking one person off a booking from the customer's own pages
 * (src/components/WithdrawPeople.tsx; lib/place-withdrawals.ts): who is on
 * it, what taking each off would do to the money before anything is done,
 * why not where not, and the request it sends.
 */

const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 409, json: async () => body });
let calls: { url: string; init?: RequestInit }[];

const options = [
  { who: "participant", placeId: 11, participantId: 7, name: "Alya", allowed: true, price: 10, refund: 0, kept: 0, owedLess: 10, units: 0, how: "none" },
  {
    who: "participant",
    placeId: 12,
    participantId: 8,
    name: "Bilal",
    allowed: false,
    refusal: { error: "Bilal has already been marked at the door, so their place stays on the record.", code: "ENT_WITHDRAW_ATTENDED", vars: { name: "Bilal" } },
  },
  { who: "unnamed", placeId: null, participantId: null, name: null, allowed: true, price: 10, refund: 5, kept: 5, owedLess: 0, units: 0, how: "credit" },
];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (init?.method === "POST") return json({ booking: { id: 3 }, withdrawal: { name: "Alya", price: 10, owedLess: 10, refund: 0, kept: 0, units: 0, how: "none" } });
      return json({ options });
    })
  );
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("who is on a booking, and taking one of them off", () => {
  it("lists each person with what it would do, says why not, and sends who comes off", async () => {
    const done = vi.fn();
    render(
      <LanguageProvider locale="en">
        <WithdrawPeople source={{ code: "MS-ABC123", phone: "0123456789" }} onDone={done} />
      </LanguageProvider>
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Take somebody off" }));
    });
    expect(calls[0].url).toBe("/api/bookings/withdraw?code=MS-ABC123&phone=0123456789");
    expect(screen.getByText("Alya")).toBeTruthy();
    expect(screen.getByText(/less to pay/)).toBeTruthy();
    // Why not, in words.
    expect(screen.getByText(/Cannot be taken off: Bilal has already been marked at the door/)).toBeTruthy();
    // A place nobody is named on: given up, the venue keeping its late share.
    expect(screen.getByText("A place nobody is named on")).toBeTruthy();
    expect(screen.getByText(/The venue keeps .* for a late change\. .* goes back to your credit\./)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Take off" })[0]);
    });
    const post = calls.find((c) => c.init?.method === "POST")!;
    expect(post.url).toBe("/api/bookings/withdraw");
    expect(JSON.parse(String(post.init!.body))).toEqual({ code: "MS-ABC123", phone: "0123456789", participantId: 7 });
    expect(done).toHaveBeenCalledWith({ id: 3 }, expect.stringContaining("Alya is off the booking."));
  });

  it("the account's own booking by its id, in Malay", async () => {
    render(
      <LanguageProvider locale="ms">
        <WithdrawPeople source={{ bookingId: 42 }} onDone={vi.fn()} />
      </LanguageProvider>
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Keluarkan seseorang" }));
    });
    expect(calls[0].url).toBe("/api/my/bookings/withdraw?bookingId=42");
    expect(screen.getAllByRole("button", { name: "Keluarkan" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Lepaskan satu tempat" })).toBeTruthy();
  });

  it("says plainly when nothing is priced per person, and when the booking was paid for as a whole", () => {
    const t = translator("en");
    expect(withdrawMoneyLine(t, { price: 0, units: 0 })).toBe("Nothing on this booking is priced per person, so its price is unchanged.");
    expect(withdrawMoneyLine(t, { price: 10, refund: 0, units: 0, how: "pass" })).toBe("It was paid for as a whole, so nothing goes back for one person.");
    expect(withdrawMoneyLine(t, { price: 10, units: 1, how: "pass" })).toBe("1 back on the pass (entries, or minutes on a time pass).");
  });
});
