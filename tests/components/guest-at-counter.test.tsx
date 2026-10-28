// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import BookingBoard from "../../src/components/BookingBoard";
import { LanguageProvider } from "../../src/components/Language";
import { addDays, todayISO } from "../../src/lib/time";

/**
 * At the counter of a members-only or private venue, staff say whether the
 * person is a walk-in customer or a member's or resident's guest, and whose
 * (docs/features/booking.md#members-and-residents-guests-at-the-counter-and-through-the-api):
 * a guest is sent with the host's number, and a refusal of the host's guest
 * allowance offers what any overridable refusal does.
 */

const COURT = { id: 1, venueId: 1, name: "Court 1", sport: "tennis" as const, offPeakRate: 15, peakRate: 15, capacity: 1 };
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
let guestsOfMembers = true;

beforeEach(() => {
  posts = [];
  refusals = [];
  guestsOfMembers = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const u = String(url);
      if (u.includes("/api/availability"))
        return { ok: true, json: async () => ({ availability: [row], closure: null, memberRates: false, atCounter: true, mayOverride: false, guestsOfMembers }) };
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

async function openForm() {
  await act(async () => {
    render(
      <LanguageProvider locale="en">
        <BookingBoard venueId={1} sports={["tennis"]} dates={[DAY]} />
      </LanguageProvider>
    );
  });
  await act(async () => within(screen.getByRole("table")).getAllByRole("button")[0].click());
  await act(async () => void (await new Promise((r) => setTimeout(r, 260))));
  await act(async () => void fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Ali Guest" } }));
  await act(async () => void fireEvent.change(screen.getByLabelText(/^Phone/), { target: { value: "0123456789" } }));
}
const submit = async () => act(async () => void fireEvent.submit(screen.getByRole("button", { name: /^Book/ }).closest("form")!));

describe("walk-in customer or a member's guest, at the counter", () => {
  it("a walk-in customer by default: no host is sent", async () => {
    await openForm();
    expect((screen.getByLabelText("A walk-in customer") as HTMLInputElement).checked).toBe(true);
    await submit();
    expect(posts[0].guestOf).toBeUndefined();
  });

  it("a member's or resident's guest goes with the host's number, and the allowance's refusal offers to ask a manager", async () => {
    refusals = [
      {
        error: "The host already has 1 guests on the list.",
        code: "GC8_GUEST_ALLOWANCE",
        vars: { n: 1 },
        policy: "guest_allowance",
        overridable: false,
        askManager: true,
      },
    ];
    await openForm();
    await act(async () => void fireEvent.click(screen.getByLabelText("A member's or resident's guest")));
    expect(screen.getByText(/Counts towards the host's guest allowance/)).toBeTruthy();
    await act(async () => void fireEvent.change(screen.getByLabelText("Host's phone number"), { target: { value: "0121110000" } }));
    await submit();
    expect(posts[0]).toMatchObject({ guestOf: "0121110000", phone: "0123456789" });
    expect(screen.getByText(/The host already has 1 guests on the list/)).toBeTruthy();
    expect(screen.getByText(/Ask a manager/)).toBeTruthy();
  });

  it("not offered at a venue open to everybody", async () => {
    guestsOfMembers = false;
    await openForm();
    expect(screen.queryByLabelText("A member's or resident's guest")).toBeNull();
  });
});
