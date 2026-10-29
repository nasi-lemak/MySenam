// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

import { ActivityPanel } from "../../src/components/admin/ActivityPanel";
import { AttentionPanel } from "../../src/components/admin/AttentionPanel";
import { BookingsTab } from "../../src/components/admin/BookingsTab";
import { CoachesPanel } from "../../src/components/admin/CoachesPanel";
import { ReportsTab } from "../../src/components/admin/ReportsTab";
import { ScheduleTab } from "../../src/components/admin/ScheduleTab";
import { StaffZones } from "../../src/components/admin/StaffLanguage";
import { WaitlistQueue } from "../../src/components/admin/WaitlistJoin";
import type { ManagedVenue } from "../../src/components/admin/shared";
import { LanguageProvider } from "../../src/components/Language";
import type { Locale } from "../../src/lib/i18n";

/**
 * Times on staff screens in the staff language, in the zone of the venue
 * they belong to (the owner's decision of 28 October 2026; lib/region.ts,
 * components/admin/StaffLanguage.tsx `useStaffClock`): calendar, bookings,
 * lessons, waiting lists, reports, the activity log and the urgent notices
 * that confirm what the venue did. The venue here is in Tokyo (UTC+9), so a
 * moment reads differently there than on the server (UTC in this container)
 * or in the install's own zone (Kuala Lumpur, UTC+8).
 */

const TOKYO = { id: 7, name: "Tokyo Arena", timeZone: "Asia/Tokyo", courts: [] } as unknown as ManagedVenue;

type Answer = (url: string, init?: RequestInit) => unknown;
let answer: Answer;
beforeEach(() => {
  answer = () => ({});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => ({ ok: true, status: 200, json: async () => answer(String(url), init) }))
  );
});
afterEach(() => vi.unstubAllGlobals());

function show(locale: Locale, ui: ReactNode, venues: ManagedVenue[] = [TOKYO]) {
  render(
    <LanguageProvider locale={locale}>
      <StaffZones venues={venues}>{ui}</StaffZones>
    </LanguageProvider>
  );
}

describe("the activity log", () => {
  // 16:30 UTC on the 27th: 1:30 in the morning of the 28th in Tokyo, 12:30 AM in Kuala Lumpur.
  const entry = { id: 1, adminId: 1, adminName: "Mei", venueId: 7, bookingCode: "MS-T0KY0", action: "booking.cancelled", detail: "x", createdAt: "2026-10-27 16:30:00" };
  beforeEach(() => {
    answer = () => ({ actions: [entry] });
  });

  for (const [locale, when] of [
    ["en", "2026-10-28 1:30 AM"],
    ["ms", "2026-10-28 1:30 PG"],
    ["zh", "2026-10-28 上午1:30"],
  ] as const)
    it(`says when, on the venue's clock and day, in ${locale}`, async () => {
      show(locale, <ActivityPanel venueId={7} from="2026-10-01" to="2026-10-31" />);
      await act(async () => {});
      expect(screen.getByText(when)).toBeTruthy();
      // Not the server's day and 24-hour clock, as it used to read.
      expect(screen.queryByText(/2026-10-27/)).toBeNull();
      expect(screen.queryByText(/16:30|00:30/)).toBeNull();
    });

  it("reads a venue the dashboard has no zone for in the install's zone", async () => {
    show("en", <ActivityPanel venueId={7} from="2026-10-01" to="2026-10-31" />, []);
    await act(async () => {});
    expect(screen.getByText("2026-10-28 12:30 AM")).toBeTruthy();
  });
});

describe("the bookings list", () => {
  const booking = {
    id: 1,
    code: "MS-59FNSZ",
    seriesCode: null,
    venueId: 7,
    venueName: "Tokyo Arena",
    courtName: "Court 1",
    courtDeposit: 0,
    sport: "badminton",
    date: "2026-10-02",
    startHour: 20,
    endHour: 21.5,
    name: "Priya Devi",
    phone: "0163211606",
    totalPrice: 25,
    status: "confirmed",
    paymentStatus: "paid",
    // 11:05 UTC is 8:05 PM in Tokyo.
    checkedInAt: "2026-10-02 11:05:00",
    checkedOutAt: null,
    noShow: false,
    priorNoShows: 0,
    hire: null,
    classId: null,
    people: [],
  };
  beforeEach(() => {
    answer = () => ({ bookings: [booking], revenue: 25, collected: 25, outstanding: 0 });
  });

  it("writes the hours and the arrival in Malay, the arrival on the venue's clock", async () => {
    show("ms", <BookingsTab />);
    await act(async () => {});
    expect(screen.getAllByText(/8:00 PTG\s*–\s*9:30 PTG/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/8:05 PTG/).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/\b(AM|PM)\b|20:05|11:05/);
  });

  it("and in English, as the counter always read the hours", async () => {
    show("en", <BookingsTab />);
    await act(async () => {});
    expect(screen.getAllByText(/8:00 PM\s*–\s*9:30 PM/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/8:05 PM/).length).toBeGreaterThan(0);
  });
});

describe("the calendar of the day", () => {
  beforeEach(() => {
    answer = (url) =>
      url.startsWith("/api/admin/slots")
        ? {
            courts: [
              {
                court: { id: 3, name: "Court 1", sport: "badminton", venueId: 7, places: 1 },
                grid: 60,
                slots: [9, 18].map((hour) => ({ minute: hour * 60, hour, status: "free", booked: 0 })),
                entries: [],
              },
            ],
          }
        : { entries: [] };
  });

  for (const [locale, morning, evening] of [
    ["en", "9AM", "6PM"],
    ["ms", "9 PG", "6 PTG"],
    ["zh", "上午9", "下午6"],
  ] as const)
    it(`heads its columns with the hours in ${locale}`, async () => {
      show(locale, <ScheduleTab venues={[{ ...TOKYO, courts: [] }]} />);
      await act(async () => {});
      const headings = [...document.querySelectorAll("thead th")].map((th) => th.textContent);
      expect(headings.slice(1)).toEqual([morning, evening]);
    });
});

describe("lessons: a coach's hours and link", () => {
  beforeEach(() => {
    answer = () => ({
      coaches: [{ id: 4, name: "Ana Lim", sports: ["tennis"], rate: 80, active: true, hours: [{ weekday: 1, from: 9 * 60, until: 18 * 60 + 30 }], timeOff: [] }],
      // 16:30 UTC on 31 December is already New Year's Day in Tokyo.
      contacts: { 4: { email: null, linkUntil: "2026-12-31 16:30:00" } },
      choice: "customer",
    });
  });

  it("are written in Chinese, the link's last day the venue's", async () => {
    show("zh", <CoachesPanel venue={{ ...TOKYO, courts: [{ id: 1, sport: "tennis", activities: [] }] } as unknown as ManagedVenue} />);
    await act(async () => {});
    expect(screen.getByText(/上午9:00–下午6:30/)).toBeTruthy();
    expect(screen.getByText("链接有效至 2027-01-01")).toBeTruthy();
  });
});

describe("the waiting list", () => {
  const entry = {
    id: 1,
    classId: null,
    courtId: 5,
    date: "2026-11-03",
    startMin: 18 * 60,
    endMin: 19 * 60 + 30,
    startHour: 18,
    endHour: 19.5,
    name: "Online Olivia",
    phone: "0123000000",
    status: "waiting",
    offeredAt: null,
    offerToken: null,
    locale: "en",
    createdAt: "2026-10-27 08:00:00",
    label: "Court 1 · 2026-11-03 6:00 PM",
    madeBy: "customer",
    madeByName: null,
  };

  it("says the time waited for in Malay", async () => {
    show("ms", <WaitlistQueue venueId={7} date="2026-11-03" entries={[entry] as never} />);
    await act(async () => {});
    expect(screen.getByText(/6:00 PTG–7:30 PTG/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/6:00 PM/);
  });
});

describe("the reports", () => {
  const report = {
    venueId: 7,
    venueName: "Tokyo Arena",
    from: "2026-09-28",
    to: "2026-10-27",
    days: 30,
    closedDays: 0,
    bookings: { confirmed: 6, cancelled: 0, noShows: 0, hours: 6 },
    revenue: { expected: 150, collected: 150, outstanding: 0, tax: 0 },
    testTakings: { bookings: 0, collected: 0 },
    collectedBy: [],
    counterSales: { sales: 0, total: 0 },
    utilisation: { courts: { soldHours: 6, sellableHours: 400, percent: 1.5 }, shared: { soldHours: 0, sellableHours: 0, percent: 0 }, revenuePerHour: 25 },
    bySport: [],
    byCourt: [],
    byMonth: [],
    byHour: [
      { hour: 9, hours: 1 },
      { hour: 18, hours: 4 },
      { hour: 23, hours: 1 },
    ],
    liabilities: { passEntriesUnspent: 0, passesLive: 0, membershipsActive: 0, membershipsExpiringSoon: 0 },
  };
  beforeEach(() => {
    answer = (url) =>
      url.startsWith("/api/admin/reports?")
        ? { report, wallet: null }
        : url.startsWith("/api/admin/activity?")
          ? { actions: [{ id: 2, adminId: 1, adminName: "Mei", venueId: 7, bookingCode: null, action: "booking.cancelled", detail: "y", createdAt: "2026-10-27T03:00:00.000Z" }] }
          : {};
  });

  it("say the busiest hour, the day's first and last, and the log's times in Chinese", async () => {
    show("zh", <ReportsTab venues={[TOKYO]} />);
    await act(async () => {});
    expect(screen.getByText("最繁忙 下午6:00 · 4 小时")).toBeTruthy();
    expect(screen.getByText("上午9:00")).toBeTruthy();
    expect(screen.getByText("下午11:00")).toBeTruthy();
    // 03:00 UTC is noon in Tokyo.
    expect(screen.getByText("2026-10-27 下午12:00")).toBeTruthy();
  });
});

describe("an urgent notice confirming what the venue did", () => {
  const notice = {
    id: 1,
    venueId: 7,
    bookingId: 9,
    kind: "cancelled",
    name: "Nurul Hana",
    phone: "0161234567",
    email: null,
    date: "2026-10-25",
    startHour: 18,
    summary: "Arena cancelled booking MS-ABC234: Court 1 at Arena, 2026-10-25, 6:00 PM to 7:30 PM.",
    // A notice kept since times went into its phrase as times of day (lib/staff-text.ts `clockValue`).
    summaryPhrase: {
      key: "srv.urgent.cancelled",
      vars: {
        venue: "Arena",
        code: "MS-ABC234",
        where: { key: "srv.urgent.where", vars: { court: "Court 1", venue: "Arena" } },
        when: { key: "srv.urgent.when", vars: { date: "2026-10-25", from: { clock: 1080 }, to: { clock: 1170 } } },
      },
    },
    createdAt: "2026-10-18 10:00:00",
    ackedAt: null,
    resolvedAt: null,
    resolution: null,
    messages: [],
    reach: "unreachable",
  };
  beforeEach(() => {
    answer = () => ({ open: [notice], recent: [] });
  });

  for (const [locale, line] of [
    ["en", "Arena cancelled booking MS-ABC234: Court 1 at Arena, 2026-10-25, 6:00 PM to 7:30 PM."],
    ["ms", /2026-10-25, 6:00 PTG hingga 7:30 PTG/],
    ["zh", /2026-10-25，下午6:00 至 下午7:30/],
  ] as const)
    it(`says when in ${locale}`, async () => {
      show(locale, <AttentionPanel />);
      await act(async () => {});
      expect(screen.getByText(line)).toBeTruthy();
      // The list's own line (date and start) in the same language.
      expect(screen.getAllByText(locale === "en" ? /6:00 PM/ : locale === "ms" ? /6:00 PTG/ : /下午6:00/).length).toBeGreaterThan(0);
    });
});
