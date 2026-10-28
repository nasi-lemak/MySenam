// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import BookingBoard from "../../src/components/BookingBoard";
import { LanguageProvider } from "../../src/components/Language";
import { addDays, todayISO } from "../../src/lib/time";

/**
 * At the counter, a refusal of the venue's policies says what staff can do
 * (docs/features/booking.md#the-same-policies-on-every-path): take payment
 * now where that lets it through, override it for this booking with a reason
 * where this member of staff is a manager the venue lets do so, or ask a
 * manager. What is chosen goes with the next try, and nothing else changes.
 */

const COURT = { id: 1, venueId: 1, name: "Court 1", sport: "badminton" as const, offPeakRate: 15, peakRate: 15, capacity: 1 };
const POLICY = { startEvery: 60, startOffset: 0, startTimes: null, lengthStep: 60, minLength: 60, maxLength: 120, lengths: null, defaultLength: 60, noticeMinutes: 0 };
const HOURS = [8, 9, 10];
const DAY = addDays(todayISO(), 1);
const row = {
  court: COURT,
  grid: 60,
  unit: 1,
  policy: POLICY,
  slots: HOURS.map((hour) => ({ minute: hour * 60, hour, available: true, rate: 15, booked: 0, capacity: 1, blocked: false, className: null })),
  starts: HOURS.map((h) => ({ minute: h * 60, maxLength: 60 })),
};

let posts: Record<string, unknown>[] = [];
let refusals: Record<string, unknown>[] = [];

beforeEach(() => {
  posts = [];
  refusals = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const u = String(url);
      if (u.includes("/api/availability"))
        return { ok: true, json: async () => ({ availability: [row], closure: null, memberRates: false, atCounter: true, mayOverride: true }) };
      if (u.includes("/api/quote")) return { ok: true, json: async () => ({ total: 15, court: 15, fees: 0, billedMinutes: 60, allowed: true, others: [] }) };
      if (u.includes("/api/auth/me")) return { ok: true, json: async () => ({ user: null }) };
      if (u.includes("/api/bookings") && init?.method === "POST") {
        posts.push(JSON.parse(init.body!));
        const next = refusals.shift();
        return next ? { ok: false, status: 409, json: async () => next } : { ok: false, status: 409, json: async () => ({ error: "Taken.", code: "SLOT_TAKEN" }) };
      }
      return { ok: true, json: async () => ({}) };
    })
  );
});

afterEach(() => vi.unstubAllGlobals());

async function filledForm() {
  await act(async () => {
    render(
      <LanguageProvider locale="en">
        <BookingBoard venueId={1} sports={["badminton"]} dates={[DAY]} />
      </LanguageProvider>
    );
  });
  await act(async () => within(screen.getByRole("table")).getAllByRole("button")[0].click());
  await act(async () => void (await new Promise((r) => setTimeout(r, 260))));
  await act(async () => void fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Walk In" } }));
  await act(async () => void fireEvent.change(screen.getByLabelText(/^Phone/), { target: { value: "0123456789" } }));
  await act(async () => void fireEvent.submit(screen.getByRole("button", { name: /^Book/ }).closest("form")!));
}

const STRIKES = {
  error: "This number has 2 no-shows or late cancellations here. Take payment now to book it, or ask a manager to override this for one booking where the venue allows it.",
  code: "R9_DESK_STRIKES",
  vars: { n: 2 },
  payNow: true,
  policy: "strikes",
};

describe("a counter booking refused by the venue's policies", () => {
  it("offers to take payment now, sent with the next try", async () => {
    refusals = [{ ...STRIKES, overridable: false, askManager: false }];
    await filledForm();
    expect(posts).toHaveLength(1);
    expect(posts[0].paidAtCounter).toBeUndefined();
    expect(screen.getByText("Take payment now")).toBeTruthy();
    expect(screen.queryByText("Override for this booking")).toBeNull();
    await act(async () => void fireEvent.change(screen.getByLabelText(/Paid by/), { target: { value: "qr" } }));
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Book, paid now" })));
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({ paidAtCounter: "qr", name: "Walk In" });
    expect(posts[1].overridePolicies).toBeUndefined();
  });

  it("offers a manager the override, with a reason, for this booking only", async () => {
    refusals = [{ ...STRIKES, overridable: true, askManager: false }];
    await filledForm();
    const go = () => screen.getByRole("button", { name: "Override and book" }) as HTMLButtonElement;
    // No reason, no override.
    expect(go().disabled).toBe(true);
    await act(async () => void fireEvent.change(screen.getByLabelText(/^Why/), { target: { value: "Regular; the no-show was our error" } }));
    expect(go().disabled).toBe(false);
    await act(async () => void fireEvent.click(go()));
    expect(posts[1]).toMatchObject({ overridePolicies: ["strikes"], overrideReason: "Regular; the no-show was our error" });
    expect(posts[1].paidAtCounter).toBeUndefined();
  });

  it("tells front desk to ask a manager, with no override to send", async () => {
    refusals = [{ ...STRIKES, overridable: false, askManager: true }];
    await filledForm();
    expect(screen.getByText(/Ask a manager: this venue lets its managers override this/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Override and book" })).toBeNull();
  });

  it("offers nothing for a refusal no override and no payment answers", async () => {
    refusals = [{ error: "The venue has blocked this number.", code: "R9_DESK_PHONE_BLOCKED" }];
    await filledForm();
    expect(screen.queryByText("Take payment now")).toBeNull();
    expect(screen.queryByText("Override for this booking")).toBeNull();
  });
});
