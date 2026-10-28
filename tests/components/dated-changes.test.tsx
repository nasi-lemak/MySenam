// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { CourtChangesFromDate, HoursFromDate } from "../../src/components/admin/DatedChanges";
import { LanguageProvider } from "../../src/components/Language";
import type { Court } from "../../src/lib/types";

/**
 * The dashboard's hours and rates from a later date (ADR 0027): the changes
 * waiting listed, a new one sent as a whole, one changed or withdrawn, and a
 * refusal over bookings shown with every booking in the way, in the staff
 * member's language.
 */

const WAITING = [{ id: 7, from: "2027-01-04", openMin: 600, closeMin: 1200, weekHours: ["closed", null, null, null, null, null, null] }];
const COURTS = [
  {
    id: 11,
    venueId: 3,
    name: "Court 1",
    sport: "badminton",
    offPeakRate: 20,
    peakRate: 30,
    memberOffPeakRate: null,
    memberPeakRate: null,
    activities: [
      { sport: "badminton", offPeakRate: null, peakRate: null },
      { sport: "pickleball", offPeakRate: 10, peakRate: 12 },
    ],
  },
] as unknown as Court[];
const COURT_WAITING = [{ courtId: 11, court: "Court 1", rates: [{ id: 9, from: "2027-01-01", offPeakRate: 25, peakRate: 35, memberOffPeakRate: null, memberPeakRate: null, activities: [] }], hours: [] }];

let fetchMock: ReturnType<typeof vi.fn>;
let sent: { url: string; method: string; body: unknown }[];
let refuse: { status: number; body: unknown } | null;
const json = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body });

beforeEach(() => {
  sent = [];
  refuse = null;
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      sent.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return refuse ? json(refuse.body, refuse.status) : json({ ok: true }, method === "POST" ? 201 : 200);
    }
    return url.includes("court-changes") ? json({ courts: COURT_WAITING }) : json({ changes: WAITING });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("confirm", () => true);
});
afterEach(() => vi.unstubAllGlobals());

const field = (label: string) => screen.getByLabelText(label, { exact: false, selector: "input,select" }) as HTMLInputElement;
const click = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
};

describe("hours from a date", () => {
  const current = { openMin: 480, closeMin: 1320, weekHours: null };

  it("lists the changes waiting, and sends a new one as a whole", async () => {
    render(<HoursFromDate venueId={3} current={current} />);
    await act(async () => {});
    expect(fetchMock.mock.calls[0][0]).toBe("/api/admin/venues/3/hours-changes");
    expect(screen.getByText("From 2027-01-04")).toBeTruthy();
    expect(screen.getByText("10:00 AM–8:00 PM · Sunday: Closed")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("From", { selector: "input" }), { target: { value: "2027-02-01" } });
    await click("Set from this date");
    expect(sent).toEqual([{ url: "/api/admin/venues/3/hours-changes", method: "POST", body: { from: "2027-02-01", openMin: 480, closeMin: 1320, weekHours: null } }]);
  });

  it("changes one waiting, and withdraws one", async () => {
    render(<HoursFromDate venueId={3} current={current} />);
    await act(async () => {});
    await click("Change");
    await click("Save the change");
    expect(sent[0]).toMatchObject({ url: "/api/admin/venues/3/hours-changes/7", method: "PATCH", body: { from: "2027-01-04", openMin: 600, closeMin: 1200 } });
    await click("Withdraw");
    expect(sent[1]).toEqual({ url: "/api/admin/venues/3/hours-changes/7", method: "DELETE", body: undefined });
  });

  it("shows a refusal over bookings with every booking in the way, in the staff member's language", async () => {
    refuse = {
      status: 409,
      body: {
        error: "2 bookings already made fall outside those hours. Move or cancel them first.",
        stranded: [
          { code: "AB12CD", date: "2027-01-04", startMin: 480, endMin: 540, court: "Court 1" },
          { code: "EF34GH", date: "2027-01-05", startMin: 1260, endMin: 1320, court: "Court 2" },
        ],
      },
    };
    render(
      <LanguageProvider locale="ms">
        <HoursFromDate venueId={3} current={current} />
      </LanguageProvider>
    );
    await act(async () => {});
    await click("Tetapkan mulai tarikh ini");
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("2 tempahan yang sudah dibuat berada di luar waktu itu.");
    expect(alert.textContent).toContain("AB12CD");
    expect(alert.textContent).toContain("2027-01-05");
    expect(alert.textContent).toContain("Court 2");
    expect(alert.querySelectorAll("li")).toHaveLength(2);
  });
});

describe("a court's rates from a date", () => {
  it("lists the rates waiting, and sends new rates with the court's other activities' own", async () => {
    render(<CourtChangesFromDate venueId={3} courts={COURTS} />);
    await act(async () => {});
    expect(fetchMock.mock.calls[0][0]).toBe("/api/admin/venues/3/court-changes");
    expect(screen.getByText("RM25 off-peak, RM35 peak")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("From", { selector: "input" }), { target: { value: "2027-03-01" } });
    fireEvent.change(field("Off-peak ("), { target: { value: "22" } });
    await click("Set from this date");
    expect(sent).toEqual([
      {
        url: "/api/admin/courts/11/changes",
        method: "POST",
        body: {
          kind: "rates",
          from: "2027-03-01",
          offPeakRate: 22,
          peakRate: 30,
          memberOffPeakRate: null,
          memberPeakRate: null,
          activities: [{ sport: "pickleball", offPeakRate: 10, peakRate: 12 }],
        },
      },
    ]);
  });

  it("withdraws rates waiting", async () => {
    render(<CourtChangesFromDate venueId={3} courts={COURTS} />);
    await act(async () => {});
    await click("Withdraw");
    expect(sent).toEqual([{ url: "/api/admin/courts/11/changes/9", method: "DELETE", body: undefined }]);
  });
});
