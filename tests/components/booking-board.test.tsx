// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import BookingBoard from "../../src/components/BookingBoard";
import { LanguageProvider } from "../../src/components/Language";
import { addDays, todayISO } from "../../src/lib/time";

/**
 * The board is where a customer books: a start and a length, picked on the
 * grid or in the form, within what the court's rules offer, priced by the
 * server before anything is booked. A board that lets you pick what the
 * server will refuse wastes the attempt and reads as a bug.
 */

const COURT = {
  id: 1,
  venueId: 1,
  name: "Badminton Court 1",
  sport: "badminton" as const,
  offPeakRate: 15,
  peakRate: 25,
  capacity: 1,
};

const SHARED = { ...COURT, id: 2, name: "Gym Floor", sport: "gym" as const, capacity: 20 };

/** On the hour, an hour to four, an hour first: the platform's own rules. */
const HOURLY = {
  startEvery: 60,
  startOffset: 0,
  startTimes: null,
  lengthStep: 60,
  minLength: 60,
  maxLength: 240,
  lengths: null,
  defaultLength: 60,
  noticeMinutes: 0,
};

function slots(hours: number[], free = true, extra: Record<string, unknown> = {}) {
  return hours.map((hour) => ({
    minute: hour * 60,
    hour,
    available: free,
    rate: hour >= 18 ? 25 : 15,
    booked: 0,
    capacity: 1,
    blocked: false,
    className: null,
    ...extra,
  }));
}

/** The court open 08:00 to 13:00: starts each hour, as long as the day and four hours allow. */
const HOURS = [8, 9, 10, 11, 12];
const CLOSE = 13 * 60;
const starts = (hours: number[], policy = HOURLY) =>
  hours.map((h) => ({ minute: h * 60, maxLength: Math.min(policy.maxLength, CLOSE - h * 60) }));

const row = (extra: Record<string, unknown> = {}) => ({
  court: COURT,
  grid: 60,
  unit: 1,
  policy: HOURLY,
  slots: slots(HOURS),
  starts: starts(HOURS),
  ...extra,
});

// Days still ahead, so no hour on the board has already passed.
const DAY = addDays(todayISO(), 1);
const NEXT_DAY = addDays(todayISO(), 2);

function reply(availability: unknown[], extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    json: async () => ({ availability, closure: null, memberRates: false, ...extra }),
  };
}

/** The server's quote: 15 an hour, to the minute. */
function quote(url: string) {
  const q = new URL(url, "http://localhost").searchParams;
  const minutes = Number(q.get("end")) - Number(q.get("start"));
  const total = Math.round(15 * minutes) / 60;
  return { ok: true, json: async () => ({ total, court: total, fees: 0, billedMinutes: minutes, allowed: true, others: [] }) };
}

let fetchMock: ReturnType<typeof vi.fn>;
let availability: unknown[] = [row()];
let extra: Record<string, unknown> = {};

beforeEach(() => {
  availability = [row()];
  extra = {};
  fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes("/api/availability")) return reply(availability, extra);
    if (String(url).includes("/api/quote")) return quote(String(url));
    if (String(url).includes("/api/auth/me")) return { ok: true, json: async () => ({ user: null }) };
    return { ok: true, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

function board(initial?: Record<string, unknown>, locale: "en" | "ms" = "en") {
  return render(
    <LanguageProvider locale={locale}>
      <BookingBoard venueId={1} sports={["badminton"]} dates={[DAY, NEXT_DAY]} initial={initial} />
    </LanguageProvider>
  );
}

/** Let the form ask the server for its price. */
const priced = () => act(async () => void (await new Promise((r) => setTimeout(r, 260))));
const cells = () => within(screen.getByRole("table")).getAllByRole("button");
const tap = (i: number) => act(async () => cells()[i].click());

describe("choosing a time", () => {
  it("shows a price on every free hour", async () => {
    await act(async () => void board());
    expect(cells().map((b) => b.textContent)).toEqual(["15", "15", "15", "15", "15"]);
  });

  it("picks the court's usual length from the time tapped, priced by the server", async () => {
    await act(async () => void board());
    await tap(0);
    await priced();
    expect(screen.getByRole("button", { name: /Book · RM15/ })).toBeTruthy();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/quote?courtId=1") && String(u).includes("start=480&end=540"))).toBe(true);
  });

  it("stretches to a later cell tapped, through the time between", async () => {
    await act(async () => void board());
    await tap(0);
    await tap(2);
    await priced();
    // 08:00 to 11:00.
    expect(screen.getByRole("button", { name: /Book · RM45/ })).toBeTruthy();
  });

  it("stretches no further than a booking may run", async () => {
    await act(async () => void board());
    await tap(0);
    await tap(4);
    await priced();
    // Four hours from 08:00, not five.
    expect(screen.getByRole("button", { name: /Book · RM60/ })).toBeTruthy();
  });

  it("lets the booking go on a tap inside it", async () => {
    await act(async () => void board());
    await tap(0);
    await tap(1);
    await tap(1);
    expect(screen.queryByRole("button", { name: /Book · RM/ })).toBeNull();
  });

  it("offers the court's starts and lengths in the form, and sends exactly them", async () => {
    await act(async () => void board());
    await tap(1);
    await priced();
    const start = screen.getByLabelText(/Start/) as HTMLSelectElement;
    const length = screen.getByLabelText(/Length/) as HTMLSelectElement;
    expect([...start.options].map((o) => o.value)).toEqual(["480", "540", "600", "660", "720"]);
    // From 09:00, up to the four hours left before closing.
    expect([...length.options].map((o) => o.value)).toEqual(["60", "120", "180", "240"]);
    await act(async () => void fireEvent.change(length, { target: { value: "120" } }));
    await priced();
    expect(screen.getByRole("button", { name: /Book · RM30/ })).toBeTruthy();
  });

  it("takes a minute a court starts at, where the court starts every few minutes", async () => {
    const fine = { ...HOURLY, startEvery: 5, lengthStep: 5, minLength: 30, defaultLength: 75 };
    availability = [
      row({
        policy: fine,
        grid: 15,
        slots: slots(HOURS),
        starts: Array.from({ length: 48 }, (_, i) => ({ minute: 480 + i * 5, maxLength: Math.min(240, CLOSE - 480 - i * 5) })),
      }),
    ];
    await act(async () => void board({ courtId: 1, start: 8 * 60 + 5, minutes: 75 }));
    await priced();
    // 08:05 to 09:20, 75 minutes at 15 an hour.
    expect(screen.getByRole("button", { name: /Book · RM18\.75/ })).toBeTruthy();
  });
});

describe("times that cannot be booked", () => {
  it("offers the waitlist on a taken hour rather than nothing", async () => {
    availability = [row({ slots: [...slots([8], false), ...slots([9, 10, 11, 12])], starts: starts([9, 10, 11, 12]) })];
    await act(async () => void board());
    const taken = cells()[0];
    expect(taken.textContent).toBe("+");
    expect(taken.hasAttribute("disabled")).toBe(false);
    await tap(0);
    expect(screen.getByRole("button", { name: /Join waitlist/ })).toBeTruthy();
  });

  it("refuses an hour reserved for a class, because no cancellation frees it", async () => {
    availability = [row({ slots: [...slots([8], false, { className: "Yoga Flow" }), ...slots([9, 10, 11, 12])], starts: starts([9, 10, 11, 12]) })];
    await act(async () => void board());
    const reserved = cells()[0];
    expect(reserved.hasAttribute("disabled")).toBe(true);
    expect(reserved.getAttribute("title")).toContain("Yoga Flow");
  });

  it("marks an hour held for part of it, and books from where it is free", async () => {
    // Held until 09:20 (a booking to the minute, or a buffer): the 09:00 cell is partly free.
    availability = [
      row({
        slots: [...slots([8], false), ...slots([9], false, { partly: true }), ...slots([10, 11, 12])],
        starts: [{ minute: 9 * 60 + 30, maxLength: 210 }, ...starts([10, 11, 12])],
      }),
    ];
    await act(async () => void board());
    expect(cells()[1].textContent).toBe("½");
    await tap(1);
    await priced();
    expect((screen.getByLabelText(/Start/) as HTMLSelectElement).value).toBe(String(9 * 60 + 30));
  });
});

describe("a shared facility", () => {
  it("counts places left rather than showing a price", async () => {
    availability = [row({ court: SHARED, slots: slots([8], true, { capacity: 20, booked: 12 }), starts: starts([8]) })];
    await act(async () => void board());
    expect(cells()[0].textContent).toBe("8");
    expect(cells()[0].getAttribute("title")).toContain("8 of 20 places left");
  });
});

describe("the day the venue is shut", () => {
  it("says so instead of showing an empty grid", async () => {
    availability = [row({ slots: slots(HOURS, false), starts: [] })];
    extra = { closure: { date: DAY, reason: "Public holiday" } };
    await act(async () => void board());
    expect(screen.getByText(new RegExp(`Closed on ${DAY}`))).toBeTruthy();
    expect(screen.getByText("Public holiday")).toBeTruthy();
  });
});

describe("member prices", () => {
  it("tells a member the rates they are looking at are theirs", async () => {
    extra = { memberRates: true };
    await act(async () => void board());
    expect(screen.getByText(/You are a member here/)).toBeTruthy();
  });
});

describe("a manager", () => {
  it("may book outside the court's rules, and says so", async () => {
    extra = { mayOverride: true };
    await act(async () => void board());
    await tap(0);
    await priced();
    const box = screen.getByLabelText(/Book outside this court's rules/) as HTMLInputElement;
    await act(async () => void fireEvent.click(box));
    // Any minute and any length, typed.
    expect((screen.getByLabelText(/Start/) as HTMLInputElement).type).toBe("time");
    expect((screen.getByLabelText(/Length/) as HTMLInputElement).type).toBe("number");
  });
});

describe("in Bahasa Malaysia", () => {
  it("labels the grid and the form in Malay", async () => {
    await act(async () => void board(undefined, "ms"));
    expect(screen.getByText("Gelanggang")).toBeTruthy();
    await tap(0);
    await priced();
    expect(screen.getByRole("button", { name: /Tempah · RM15/ })).toBeTruthy();
  });
});
