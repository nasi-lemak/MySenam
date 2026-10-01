// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";

import BookingBoard from "../../src/components/BookingBoard";
import { LanguageProvider } from "../../src/components/Language";
import { MAX_HOURS_PER_BOOKING } from "../../src/lib/types";

/**
 * The grid is where a customer actually books, and the rules it enforces are
 * rules the server enforces too — but a board that lets you select something
 * the server will refuse wastes the attempt and reads as a bug.
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

function slots(hours: number[], free = true, extra: Record<string, unknown> = {}) {
  return hours.map((hour) => ({
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

const HOURS = [8, 9, 10, 11, 12];

function reply(availability: unknown[], extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    json: async () => ({ availability, closure: null, memberRates: false, ...extra }),
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes("/api/availability"))
      return reply([{ court: COURT, slots: slots(HOURS) }]);
    if (String(url).includes("/api/auth/me")) return { ok: true, json: async () => ({ user: null }) };
    return { ok: true, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

function board(initial?: Record<string, unknown>) {
  return render(
    <LanguageProvider locale="en">
      <BookingBoard
        venueId={1}
        sports={["badminton"]}
        dates={["2026-10-04", "2026-10-05"]}
        initial={initial}
      />
    </LanguageProvider>
  );
}

const cells = () => within(screen.getByRole("table")).getAllByRole("button");

describe("choosing hours", () => {
  it("shows a price on every free hour", async () => {
    await act(async () => void board());
    const buttons = cells();
    expect(buttons.length).toBe(HOURS.length);
    expect(buttons.map((b) => b.textContent)).toEqual(["15", "15", "15", "15", "15"]);
  });

  it("opens the booking form once an hour is picked", async () => {
    await act(async () => void board());
    await act(async () => cells()[0].click());
    expect(screen.getByRole("button", { name: /Book · RM15/ })).toBeTruthy();
  });

  it("adds a touching hour to the same booking", async () => {
    await act(async () => void board());
    await act(async () => cells()[0].click());
    await act(async () => cells()[1].click());
    expect(screen.getByRole("button", { name: /Book · RM30/ })).toBeTruthy();
  });

  it("starts again rather than booking two hours with a gap between them", async () => {
    // 8 and 10 are not one booking; picking 10 after 8 means you meant 10.
    await act(async () => void board());
    await act(async () => cells()[0].click());
    await act(async () => cells()[2].click());
    expect(screen.getByRole("button", { name: /Book · RM15/ })).toBeTruthy();
  });

  it("will not let you select more hours than a booking may hold", async () => {
    await act(async () => void board());
    for (let i = 0; i < HOURS.length; i++) {
      await act(async () => cells()[i].click());
    }
    const book = screen.getByRole("button", { name: /Book · RM/ });
    // Four hours at 15, and the fifth click refused rather than accepted.
    expect(book.textContent).toContain(`RM${15 * MAX_HOURS_PER_BOOKING}`);
  });

  it("drops the hour again when you click it twice", async () => {
    await act(async () => void board());
    await act(async () => cells()[0].click());
    await act(async () => cells()[1].click());
    await act(async () => cells()[1].click());
    expect(screen.getByRole("button", { name: /Book · RM15/ })).toBeTruthy();
  });
});

describe("hours that cannot be booked", () => {
  it("offers the waitlist on a taken hour rather than nothing", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/api/availability"))
        return reply([
          {
            court: COURT,
            slots: [
              ...slots([8], false),
              ...slots([9, 10, 11, 12]),
            ],
          },
        ]);
      return { ok: true, json: async () => ({ user: null }) };
    });
    await act(async () => void board());
    const taken = cells()[0];
    expect(taken.textContent).toBe("+");
    expect(taken.hasAttribute("disabled")).toBe(false);
    await act(async () => taken.click());
    expect(screen.getByRole("button", { name: /Join waitlist/ })).toBeTruthy();
  });

  it("refuses an hour reserved for a class, because no cancellation frees it", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/api/availability"))
        return reply([
          {
            court: COURT,
            slots: [
              ...slots([8], false, { className: "Yoga Flow" }),
              ...slots([9, 10, 11, 12]),
            ],
          },
        ]);
      return { ok: true, json: async () => ({ user: null }) };
    });
    await act(async () => void board());
    const reserved = cells()[0];
    expect(reserved.hasAttribute("disabled")).toBe(true);
    expect(reserved.getAttribute("title")).toContain("Yoga Flow");
  });
});

describe("a shared facility", () => {
  it("counts places left rather than showing a price", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/api/availability"))
        return reply([
          {
            court: SHARED,
            slots: slots([8], true, { capacity: 20, booked: 12 }),
          },
        ]);
      return { ok: true, json: async () => ({ user: null }) };
    });
    await act(async () => void board());
    expect(cells()[0].textContent).toBe("8");
    expect(cells()[0].getAttribute("title")).toContain("8 of 20 places left");
  });
});

describe("the day the venue is shut", () => {
  it("says so instead of showing an empty grid", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/api/availability"))
        return reply([{ court: COURT, slots: slots(HOURS, false) }], {
          closure: { date: "2026-10-04", reason: "Public holiday" },
        });
      return { ok: true, json: async () => ({ user: null }) };
    });
    await act(async () => void board());
    expect(screen.getByText(/Closed on 2026-10-04/)).toBeTruthy();
    expect(screen.getByText("Public holiday")).toBeTruthy();
  });
});

describe("member prices", () => {
  it("tells a member the rates they are looking at are theirs", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/api/availability"))
        return reply([{ court: COURT, slots: slots(HOURS) }], { memberRates: true });
      return { ok: true, json: async () => ({ user: null }) };
    });
    await act(async () => void board());
    expect(screen.getByText(/You are a member here/)).toBeTruthy();
  });
});

describe("in Bahasa Malaysia", () => {
  it("labels the grid and the form in Malay", async () => {
    render(
      <LanguageProvider locale="ms">
        <BookingBoard venueId={1} sports={["badminton"]} dates={["2026-10-04"]} />
      </LanguageProvider>
    );
    await act(async () => {});
    expect(screen.getByText("Gelanggang")).toBeTruthy();
    await act(async () => cells()[0].click());
    expect(screen.getByRole("button", { name: /Tempah · RM15/ })).toBeTruthy();
  });
});
