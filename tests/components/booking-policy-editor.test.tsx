// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { BookingPolicyEditor } from "../../src/components/admin/BookingPolicyEditor";
import { LanguageProvider } from "../../src/components/Language";
import { PLATFORM_POLICY } from "../../src/lib/booking-rules";
import type { Court } from "../../src/lib/types";

/**
 * The booking-rules editor on the dashboard (lib/booking-policy.ts): a
 * venue's own rules read into the form, what is left blank inherited and shown
 * as such, what is typed sent as numbers, times and prices (or refused before
 * anything is sent when it does not read), a court's own weekly hours, and a
 * refusal from the server said in the staff member's words.
 */

const COURTS = [
  { id: 11, venueId: 3, name: "Court 1", sport: "badminton", activities: [{ sport: "badminton" }] },
  // A court that also sells a second activity: a booking product of its own.
  { id: 12, venueId: 3, name: "Court 2", sport: "badminton", activities: [{ sport: "badminton" }, { sport: "pickleball" }] },
] as unknown as Court[];

/** What a court's rules come to, everything inherited: the platform's, starting on the half hour. */
const effectiveCourt = {
  ...Object.fromEntries(Object.entries(PLATFORM_POLICY).filter(([k]) => !["rateMode", "billStep", "minBilled", "minCharge", "fixedPrices", "setupFee", "cleanupFee"].includes(k))),
  startEvery: 30,
  bufferAfter: 10,
  operationalAfter: 15,
  pricing: { rateMode: "split", billStep: null, minBilled: null, minCharge: null, fixedPrices: null, setupFee: 0, cleanupFee: 0 },
  summary: "Starts every 30 min, 60 to 240 min",
};

const LEVELS = {
  levels: {
    venue: { startEvery: 30, minLength: 60, maxLength: 180, signOff: false },
    business: null,
    sports: {},
    courts: {},
    products: {},
  },
  effective: { sports: { badminton: effectiveCourt }, courts: { 11: effectiveCourt, 12: effectiveCourt }, products: { 12: { pickleball: effectiveCourt } } },
};

let fetchMock: ReturnType<typeof vi.fn>;
let posted: Record<string, unknown>[];
let refuse: { status: number; body: unknown } | null;
const json = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body });

beforeEach(() => {
  posted = [];
  refuse = null;
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posted.push(JSON.parse(String(init.body)));
      return refuse ? json(refuse.body, refuse.status) : json({ ok: true });
    }
    return json(LEVELS);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

async function editor(locale?: "ms") {
  render(
    locale ? (
      <LanguageProvider locale={locale}>
        <BookingPolicyEditor venueId={3} courts={COURTS} />
      </LanguageProvider>
    ) : (
      <BookingPolicyEditor venueId={3} courts={COURTS} />
    )
  );
  await act(async () => {});
}

const field = (label: string) => screen.getByLabelText(label, { exact: false, selector: "input,textarea,select" }) as HTMLInputElement;
const type = (label: string, value: string) => fireEvent.change(field(label), { target: { value } });
const save = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
  });
};

describe("the booking-rules editor", () => {
  it("reads the venue's own rules into the form, and offers each level they can be set at", async () => {
    await editor();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/admin/booking-policies?venueId=3");
    expect(field("Starts every (minutes)").value).toBe("30");
    expect(field("Longest booking (minutes)").value).toBe("180");
    // Left blank: inherited from the platform, and said so.
    expect(field("Book at least this far ahead (minutes)").value).toBe("");
    expect(field("Book at least this far ahead (minutes)").placeholder).toBe("inherits: 0");
    const levels = [...(screen.getByLabelText("Applies to") as HTMLSelectElement).options].map((o) => o.textContent);
    expect(levels).toEqual(["The whole venue", "Badminton here", "Pickleball here", "Court 1", "Court 2", "Pickleball on Court 2"]);
    // A venue on its own, in no business: no "every branch".
    expect(levels).not.toContain("Every branch of the business");
  });

  it("sends what is typed as numbers, times and prices, and blank as inherited", async () => {
    await editor();
    type("Starts every (minutes)", "");
    type("Shortest booking (minutes)", "90");
    type("Or only at these times", "18:00, 19:30 21:00");
    type("Prices for set lengths", "60 = 20 / 30\n90 = 28");
    fireEvent.change(field("Staff sign-off first"), { target: { value: "yes" } });
    await save();
    expect(posted).toHaveLength(1);
    const sent = posted[0] as { venueId: number; level: string; settings: Record<string, unknown> };
    expect(sent.venueId).toBe(3);
    expect(sent.level).toBe("venue");
    expect(sent.settings).toMatchObject({
      startEvery: null,
      minLength: 90,
      maxLength: 180,
      noticeMinutes: null,
      startTimes: [18 * 60, 19 * 60 + 30, 21 * 60],
      fixedPrices: [
        { minutes: 60, price: 20, peakPrice: 30 },
        { minutes: 90, price: 28, peakPrice: null },
      ],
      signOff: true,
      certification: null,
      rateMode: null,
      weekHours: null,
    });
    await screen.findByText(/^Saved\. New bookings follow it/);
    // Read again after saving, so the form shows what the server kept.
    expect(fetchMock.mock.calls.filter(([, init]) => !init?.method)).toHaveLength(2);
  });

  it("refuses a time or a price line it cannot read, sending nothing", async () => {
    await editor();
    type("Or only at these times", "18:00, half past six");
    await save();
    expect(screen.getByText('"half" is not a time (use 18:00).')).toBeTruthy();
    type("Or only at these times", "");
    type("Prices for set lengths", "an hour for twenty");
    await save();
    expect(screen.getByText('"an hour for twenty" is not "minutes = price" (or "minutes = price / peak price").')).toBeTruthy();
    expect(posted).toHaveLength(0);
  });

  it("sets a court's own rules, showing what it inherits now, and its own weekly hours", async () => {
    await editor();
    fireEvent.change(screen.getByLabelText("Applies to"), { target: { value: "court:11" } });
    await act(async () => {});
    expect(screen.getByText("Now: Starts every 30 min, 60 to 240 min.")).toBeTruthy();
    // Nothing of its own yet: every field inherits what applies to it now.
    expect(field("Starts every (minutes)").value).toBe("");
    expect(field("Starts every (minutes)").placeholder).toBe("inherits: 30");
    expect(screen.getByText("Now: at least 0 min free before and 10 min after; setup 0 min, cleaning 15 min")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Monday hours"), { target: { value: "closed" } });
    type("Longest booking (minutes)", "120");
    await save();
    const sent = posted[0] as { level: string; courtId: number; settings: { weekHours: unknown[]; maxLength: number; startEvery: null } };
    expect([sent.level, sent.courtId]).toEqual(["court", 11]);
    expect(sent.settings.maxLength).toBe(120);
    expect(sent.settings.startEvery).toBeNull();
    expect(sent.settings.weekHours).toEqual([null, "closed", null, null, null, null, null]);
  });

  it("sets one activity on a court that sells several apart from the court's", async () => {
    await editor();
    fireEvent.change(screen.getByLabelText("Applies to"), { target: { value: "product:12:pickleball" } });
    await act(async () => {});
    type("Shortest booking (minutes)", "30");
    await save();
    expect(posted[0]).toMatchObject({ level: "court", courtId: 12, sport: "pickleball", settings: { minLength: 30 } });
  });

  it("clears every setting back to inherited", async () => {
    await editor();
    fireEvent.click(screen.getByRole("button", { name: "Clear (inherit everything)" }));
    expect(field("Starts every (minutes)").value).toBe("");
    await save();
    const settings = (posted[0] as { settings: Record<string, unknown> }).settings;
    expect(Object.values(settings).every((v) => v === null)).toBe(true);
  });

  it("says why the server refused, and keeps what was typed", async () => {
    // The server's own check (lib/booking-policy.ts), as the route returns it.
    refuse = { status: 400, body: { ok: false, error: "The longest booking is shorter than the shortest." } };
    await editor();
    type("Shortest booking (minutes)", "240");
    await save();
    expect(screen.queryByText(/^Saved\./)).toBeNull();
    expect(screen.getByText("The longest booking is shorter than the shortest.")).toBeTruthy();
    expect(field("Shortest booking (minutes)").value).toBe("240");
  });

  it("is in Malay for a Malay-speaking manager, the server's refusal too", async () => {
    refuse = { status: 400, body: { ok: false, error: "The longest booking is shorter than the shortest." } };
    await editor("ms");
    expect(screen.getByText("Peraturan tempahan")).toBeTruthy();
    expect(screen.getByLabelText("Terpakai untuk")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Simpan/ }));
    });
    expect(screen.getByText("Tempahan terpanjang lebih pendek daripada tempahan terpendek.")).toBeTruthy();
  });
});
