// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";

import BookingBoard from "../../src/components/BookingBoard";
import { AttentionPanel } from "../../src/components/admin/AttentionPanel";
import { LanguageProvider } from "../../src/components/Language";
import { addDays, todayISO } from "../../src/lib/time";

/**
 * What a customer sees of a launch or tide window (ADR 0037): the cells outside it say why, in the customer's own
 * language, and the court's row says where the window is and by when a hire must be back. And the desk's
 * needs-attention panel lists what a change left outside a window, saying none has been cancelled.
 */

const DAY = addDays(todayISO(), 1);
const HOURLY = { startEvery: 60, startOffset: 0, startTimes: null, lengthStep: 60, minLength: 60, maxLength: 240, lengths: null, defaultLength: 60, noticeMinutes: 0 };
const COURT = { id: 1, venueId: 1, name: "Kayaks", sport: "kayak" as const, offPeakRate: 15, peakRate: 15, capacity: 1 };
const cell = (hour: number, extra: Record<string, unknown> = {}) => ({ minute: hour * 60, hour, available: true, rate: 15, booked: 0, capacity: 1, ...extra });

let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const availability = [
  {
    court: COURT,
    grid: 60,
    unit: 1,
    policy: HOURLY,
    slots: [
      cell(6, { available: false, outside: true, launchReason: "outside_launch" }),
      cell(8),
      cell(9),
      cell(10, { available: false, outside: true, launchReason: "return_buffer" }),
      cell(12, { available: false, outside: true, launchReason: "low_water" }),
      cell(14, { available: false, outside: true, launchReason: "no_tide_data" }),
    ],
    starts: [
      { minute: 8 * 60, maxLength: 120 },
      { minute: 9 * 60, maxLength: 60 },
    ],
    launch: { windows: [{ start: 7 * 60 + 10, end: 10 * 60 + 40 }], returnBuffer: 30 },
  },
];

beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes("/api/availability")) return json({ availability, closure: null, memberRates: false });
    if (String(url).includes("/api/auth/me")) return json({ user: null });
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const board = (locale: "en" | "ms" | "zh" | "ta") =>
  render(
    <LanguageProvider locale={locale}>
      <BookingBoard venueId={1} sports={["kayak"]} dates={[DAY]} />
    </LanguageProvider>
  );

describe("the booking board with a launch window", () => {
  it("shows the window under the court's name, and by when a hire must be back", async () => {
    board("en");
    await act(async () => {});
    expect(screen.getByTestId("launch-1").textContent).toBe("Launch 7:10 AM–10:40 AM, back by 10:10 AM");
  });

  it("says why a cell is shut, not just that it is: in the customer's language", async () => {
    board("en");
    await act(async () => {});
    const titles = within(screen.getByRole("table"))
      .getAllByRole("button")
      .map((b) => b.getAttribute("title"));
    expect(titles).toEqual(expect.arrayContaining(["Outside the launch window", "Must be back before the window closes", "Low water", "No tide data"]));
  });

  it("is in Malay, Chinese and Tamil too", async () => {
    for (const [locale, line, reason] of [
      ["ms", "Pelancaran", "Air surut"],
      ["zh", "下水", "低潮"],
      ["ta", "இறக்கம்", "கடல் தாழ்வு"],
    ] as const) {
      const { unmount } = board(locale);
      await act(async () => {});
      expect(screen.getByTestId("launch-1").textContent).toContain(line);
      expect(within(screen.getByRole("table")).getAllByRole("button").map((b) => b.getAttribute("title"))).toContain(reason);
      unmount();
    }
  });
});

describe("the desk's needs-attention panel", () => {
  it("lists what a window now leaves outside it, saying none has been cancelled", async () => {
    fetchMock.mockImplementation(async () =>
      json({
        open: [],
        recent: [],
        launchStranded: [
          {
            venueId: 1,
            count: 2,
            items: [
              { kind: "booking", ref: "MS-ABC123", id: 1, date: "2026-11-20", startMin: 720, endMin: 780, courtId: 7, court: "Kayaks", name: "Aina", phone: "0123456789", why: "LAUNCH_WINDOW", windows: [], returnBuffer: 0 },
              { kind: "class", ref: "9", id: 9, date: "2026-11-21", startMin: 1020, endMin: 1080, courtId: 7, court: "Kayaks", name: "Afternoon paddle", phone: null, why: "TIDE_NO_DATA", windows: [], returnBuffer: 0 },
            ],
          },
        ],
      })
    );
    render(<AttentionPanel />);
    await act(async () => {});
    const block = screen.getByTestId("attention-launch");
    expect(block.textContent).toMatch(/2 booked or class times are outside a launch or tide window\. None has been cancelled/);
    expect(block.textContent).toContain("Aina");
    expect(block.textContent).toContain("Class: Afternoon paddle");
  });
});
