// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import BookingBoard from "../../src/components/BookingBoard";
import { LanguageProvider } from "../../src/components/Language";
import { addDays, todayISO } from "../../src/lib/time";

/**
 * The booking form's discounts and passes (lib/discounts.ts,
 * components/PassAllocation.tsx): where the venue gives one discount at a
 * time, a concession chosen takes the code's field away and no code is sent;
 * where it lets a code go with a concession price, both go to the server,
 * which decides by the code. A signed-in parent says which of their passes
 * pays for which child, and exactly those are sent.
 */

const POOL = { id: 2, venueId: 1, name: "Pool", sport: "swimming" as const, offPeakRate: 10, peakRate: 10, capacity: 8, maxPlayers: 8 };
const HOURLY = { startEvery: 60, startOffset: 0, startTimes: null, lengthStep: 60, minLength: 60, maxLength: 240, lengths: null, defaultLength: 60, noticeMinutes: 0 };
const HOURS = [8, 9, 10, 11, 12];
const slots = HOURS.map((hour) => ({ minute: hour * 60, hour, available: true, rate: 10, booked: 0, capacity: 8, blocked: false, className: null }));
const row = { court: POOL, grid: 60, unit: 1, policy: HOURLY, slots, starts: HOURS.map((h) => ({ minute: h * 60, maxLength: Math.min(240, 13 * 60 - h * 60) })) };
const DAY = addDays(todayISO(), 1);
const CONCESSIONS = [{ id: 7, name: "Child", percent: 50, proof: "their MyKid card", sport: null, offPeakOnly: false, preset: null, scope: "participant" }];

let fetchMock: ReturnType<typeof vi.fn>;
let extra: Record<string, unknown> = {};
let signedIn = false;
let posts: Record<string, unknown>[] = [];

beforeEach(() => {
  extra = {};
  signedIn = false;
  posts = [];
  fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url);
    if (u.includes("/api/availability")) return { ok: true, json: async () => ({ availability: [row], closure: null, memberRates: false, concessions: CONCESSIONS, ...extra }) };
    if (u.includes("/api/quote")) {
      const players = Number(new URL(u, "http://localhost").searchParams.get("players") ?? 1);
      return { ok: true, json: async () => ({ total: 10 * players, court: 10 * players, fees: 0, billedMinutes: 60, allowed: true, others: [] }) };
    }
    if (u.includes("/api/auth/me"))
      return { ok: true, json: async () => ({ user: signedIn ? { id: 1, name: "Mum", phone: "0123456789", email: "mum@x.test" } : null }) };
    if (u.includes("/api/my/people")) return { ok: true, json: async () => ({ people: [{ id: 11, displayName: "Aina" }, { id: 12, displayName: "Badrul" }] }) };
    if (u.includes("/api/my/wallet")) return { ok: true, json: async () => ({ balance: 0 }) };
    if (u.includes("/api/my/accounts")) return { ok: true, json: async () => ({ accounts: [] }) };
    if (u.includes("/api/my/passes"))
      return {
        ok: true,
        json: async () => ({
          passes: [
            { id: 1, code: "PS-AINA", venueId: 1, sport: null, name: "Aina's swim", kind: "session", entryMinutes: 60, maxMinutes: null, remaining: 4, holderName: "Mum", scope: "participant", holderParticipantId: 11, holderParticipantName: "Aina" },
            { id: 2, code: "PS-BADRUL", venueId: 1, sport: null, name: "Badrul's swim", kind: "session", entryMinutes: 60, maxMinutes: null, remaining: 6, holderName: "Mum", scope: "participant", holderParticipantId: 12, holderParticipantName: "Badrul" },
            { id: 3, code: "PS-FAMILY", venueId: 1, sport: null, name: "Family", kind: "session", entryMinutes: null, maxMinutes: null, remaining: 9, holderName: "Mum", scope: "booking" },
          ],
        }),
      };
    if (u.includes("/api/bookings") && init?.method === "POST") {
      posts.push(JSON.parse(init.body!));
      return { ok: false, status: 409, json: async () => ({ error: "stop here" }) };
    }
    return { ok: true, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

async function open() {
  await act(async () => void render(
    <LanguageProvider locale="en">
      <BookingBoard venueId={1} sports={["swimming"]} dates={[DAY]} />
    </LanguageProvider>
  ));
  await act(async () => within(screen.getByRole("table")).getAllByRole("button")[0].click());
  await act(async () => void (await new Promise((r) => setTimeout(r, 260))));
}

async function submit() {
  await act(async () => void fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Mum" } }));
  await act(async () => void fireEvent.change(screen.getByLabelText(/^Phone/), { target: { value: "0123456789" } }));
  await act(async () => void fireEvent.submit(screen.getByRole("button", { name: /^Book/ }).closest("form")!));
}

describe("a concession and a code on the booking form", () => {
  it("one discount at a time: choosing a concession takes the code away, says why, and sends no code", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Promo code?"), { target: { value: "SPLASH10" } });
    fireEvent.change(screen.getByRole("combobox", { name: /Price/ }), { target: { value: "7" } });
    expect(screen.queryByLabelText("Promo code?")).toBeNull();
    expect(screen.getByText(/One discount at a time here/)).toBeTruthy();
    await submit();
    expect(posts[0].promoCode).toBeUndefined();
    expect(posts[0].placeConcessions).toEqual([{ participantId: null, concessionId: 7 }]);
  });

  it("where the venue allows it: the code stays beside the concession and both are sent, the code deciding", async () => {
    extra = { discountStacking: "promotion" };
    await open();
    fireEvent.change(screen.getByRole("combobox", { name: /Price/ }), { target: { value: "7" } });
    expect(screen.getByLabelText("Promo code?")).toBeTruthy();
    expect(screen.getByText("A code goes with a concession price only if the code allows it.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Promo code?"), { target: { value: "splash10" } });
    await submit();
    expect(posts[0]).toMatchObject({ promoCode: "SPLASH10", placeConcessions: [{ participantId: null, concessionId: 7 }] });
  });
});

describe("passes on the booking form", () => {
  it("a parent booking two children says which child's pass pays for whom, and exactly those are sent", async () => {
    signedIn = true;
    await open();
    await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
    // Both children, not the parent.
    fireEvent.click(screen.getByLabelText("Me"));
    fireEvent.click(screen.getByLabelText("Aina (booked by you)"));
    fireEvent.click(screen.getByLabelText("Badrul (booked by you)"));
    const choice = screen.getByRole("combobox", { name: "Which pass pays for whom" });
    fireEvent.change(choice, { target: { value: "__each" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Aina" }), { target: { value: "PS-AINA" } });
    expect(screen.getByText(/Still to pay for: Badrul/)).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Badrul" }), { target: { value: "PS-BADRUL" } });
    expect(screen.getByText("Each place is paid by its own pass.")).toBeTruthy();
    await submit();
    expect(posts[0]).toMatchObject({ participantIds: [11, 12], customerTakesPart: false, payWithPasses: ["PS-AINA", "PS-BADRUL"] });
    expect(posts[0].payWithPass).toBeUndefined();

    // Or one pass for the whole booking.
    fireEvent.change(screen.getByRole("combobox", { name: "Which pass pays for whom" }), { target: { value: "PS-FAMILY" } });
    await submit();
    expect(posts[1]).toMatchObject({ payWithPasses: ["PS-FAMILY"] });
  });
});
