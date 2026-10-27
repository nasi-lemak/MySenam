// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import CoachBooking from "../../src/components/CoachBooking";

/**
 * Booking a lesson at a venue that assigns the coach (lib/lesson-coaches.ts):
 * the times any coach of the sport is free, no coach named in what is sent,
 * and the coach given shown on the confirmation. A named coach is booked as
 * before.
 */

let fetchMock: ReturnType<typeof vi.fn>;
let posted: Record<string, unknown> | null;

beforeEach(() => {
  posted = null;
  fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (url.startsWith("/api/coaching/slots"))
      return { ok: true, json: async () => ({ starts: [{ minute: 600, maxLength: 120 }], policy: { lengths: [60], minLength: 60, maxLength: 120, step: 30, defaultLength: 60 } }) };
    if (url === "/api/bookings" && init?.method === "POST") {
      posted = JSON.parse(init.body ?? "{}");
      return {
        ok: true,
        json: async () => ({
          booking: { id: 9, code: "MS-LES123", date: "2026-11-02", startMin: 600, endMin: 660, totalPrice: 100, paymentStatus: "unpaid", phone: "0123456789", coachId: 7 },
          bookings: [],
          lessonCoach: { id: 7, name: "Ben Tan" },
        }),
      };
    }
    return { ok: true, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

async function bookIt() {
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "10:00 AM" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Siti Aminah" } });
  fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "0123456789" } });
  await act(async () => {
    fireEvent.submit(screen.getByRole("button", { name: /^Book/ }).closest("form")!);
  });
}

describe("a lesson the venue assigns", () => {
  it("offers the times any coach is free, sends no coach, and names the coach given", async () => {
    render(<CoachBooking venueId={3} coach={{ id: null, name: "", sports: ["tennis"] }} dates={["2026-11-02"]} payOnline={false} timeZone="Asia/Kuala_Lumpur" />);
    await act(async () => {});
    expect(fetchMock.mock.calls.map((c) => c[0])).toContain("/api/coaching/slots?venueId=3&date=2026-11-02&sport=tennis");
    expect(screen.getByRole("button", { name: "10:00 AM" })).toBeTruthy();
    await bookIt();
    expect(posted).toMatchObject({ venueId: 3, sport: "tennis", assignCoach: true });
    expect(posted).not.toHaveProperty("coachId");
    expect(screen.getByText(/Your coach: Ben Tan/)).toBeTruthy();
  });

  it("a coach by name, where the customer chooses, is booked as before", async () => {
    render(<CoachBooking venueId={3} coach={{ id: 7, name: "Ben Tan", sports: ["tennis"] }} dates={["2026-11-02"]} payOnline={false} timeZone="Asia/Kuala_Lumpur" />);
    await act(async () => {});
    expect(fetchMock.mock.calls.map((c) => c[0])).toContain("/api/coaching/slots?coachId=7&date=2026-11-02&sport=tennis");
    await bookIt();
    expect(posted).toMatchObject({ coachId: 7 });
    expect(posted).not.toHaveProperty("assignCoach");
    expect(screen.getByText(/With Ben Tan/)).toBeTruthy();
  });
});
