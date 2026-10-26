// @vitest-environment jsdom
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/account" }));

import AccountPage from "../../src/app/account/page";
import ClaimPage from "../../src/app/waitlist/[token]/page";
import { LanguageProvider } from "../../src/components/Language";
import { WhoTakesPart } from "../../src/components/WhoTakesPart";
import { translator } from "../../src/lib/i18n";
import { ACTION_LABELS } from "../../src/lib/activity-labels";
import { STAFF_DICTIONARIES } from "../../src/lib/staff-i18n";
import { addDays, todayISO } from "../../src/lib/time";

/**
 * Found by the participant acceptance scenarios (tests/uat/participants.uat.ts):
 * a parent booking for two children could not tell, on their own pages,
 * which child a booking was for; a place claimed from the waiting list did
 * not say whose it was; the "who is taking part" rows were 16px tap
 * targets on a phone; and the staff activity log showed a booking made at
 * the counter for a child by its internal action name.
 */

const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => body });
let routes: Record<string, unknown>;

beforeEach(() => {
  routes = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => json(routes[new URL(String(url), "http://localhost").pathname] ?? {}))
  );
});
afterEach(() => vi.unstubAllGlobals());

const booking = (participantName: string | null, code: string) => ({
  id: code.length,
  code,
  courtId: 5,
  sport: "archery",
  date: addDays(todayISO(), 3),
  startHour: 14,
  endHour: 15,
  status: "confirmed",
  totalPrice: 20,
  paymentStatus: "unpaid",
  name: "Mum Tester",
  phone: "0123456789",
  participantName,
  courtName: "Lane 1",
  venueName: "Range Tujuh",
  venueArea: "Petaling Jaya",
  venueAddress: "3 Jalan SS 2/24",
  venueTimeZone: "Asia/Kuala_Lumpur",
  venueCancelCutoffHours: 2,
  venueLateCancelKeep: null,
  venueStrikeLimit: null,
  reviewUrl: null,
  mostSpots: 10,
  seriesCode: null,
  checkInToken: null,
  checkedInAt: null,
});

describe("whose a booking is, on the customer's own pages", () => {
  it("the account page says which child each booking is for, and nothing for the adult's own", async () => {
    routes["/api/auth/me"] = { user: { id: 1, name: "Mum Tester", email: "mum@x.test", phone: "0123456789" } };
    routes["/api/my/bookings"] = { bookings: [booking("Alya", "MS-ALYA1"), booking("Bilal", "MS-BILAL1"), booking(null, "MS-MUM1")], refunds: [] };
    routes["/api/my/people"] = { people: [], own: null };
    routes["/api/my/waitlist"] = { entries: [] };
    routes["/api/my/receipts"] = { receipts: [] };
    routes["/api/my/passes"] = { passes: [] };
    routes["/api/my/venues"] = { venues: [] };
    routes["/api/my/guests"] = { invites: [] };
    render(
      <LanguageProvider locale="en">
        <AccountPage />
      </LanguageProvider>
    );
    await screen.findByText("MS-ALYA1");
    const card = (code: string) => screen.getByText(code).closest("div.rounded-xl") as HTMLElement;
    expect(card("MS-ALYA1").textContent).toContain("For Alya");
    expect(card("MS-BILAL1").textContent).toContain("For Bilal");
    expect(card("MS-BILAL1").textContent).not.toContain("Alya");
    expect(card("MS-MUM1").textContent).not.toContain("For ");
  });

  it("a place claimed from the waiting list says whom it was booked for", async () => {
    routes["/api/waitlist/claim"] = { booking: { ...booking("Alya", "MS-CLAIM1"), classId: null }, bookings: [], session: null };
    const params = Promise.resolve({ token: "a".repeat(32) });
    await act(async () => {
      render(
        <LanguageProvider locale="en">
          <Suspense fallback={null}>
            <ClaimPage params={params} />
          </Suspense>
        </LanguageProvider>
      );
    });
    fireEvent.click(await screen.findByRole("button", { name: "Claim my place" }));
    await screen.findByText("MS-CLAIM1");
    expect(screen.getByText("For Alya")).toBeTruthy();
  });
});

describe("who is taking part, on a phone", () => {
  it("each row is a tap target at least 24px high", () => {
    render(
      <WhoTakesPart
        t={translator("en")}
        people={[
          { id: 1, displayName: "Alya" },
          { id: 2, displayName: "Bilal" },
        ]}
        ids={[]}
        meToo
        onChange={() => {}}
      />
    );
    const rows = screen.getAllByRole("checkbox").map((box) => box.closest("label")!);
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.className.split(" ")).toContain("min-h-6");
  });
});

describe("the staff activity log", () => {
  it("names bookings and enrolments made at the counter for a participant, in every staff language", () => {
    expect(ACTION_LABELS["booking.for_participant"]).toBe("Booked for a participant at the counter");
    expect(ACTION_LABELS["class.enrol_participant"]).toBe("Enrolled a participant in a class at the counter");
    for (const key of ["pua.act.bookedFor", "pua.act.enrolledFor"])
      for (const locale of ["en", "ms", "zh"] as const) expect(STAFF_DICTIONARIES[locale][key as keyof (typeof STAFF_DICTIONARIES)["en"]], `${locale} ${key}`).toBeTruthy();
  });
});
