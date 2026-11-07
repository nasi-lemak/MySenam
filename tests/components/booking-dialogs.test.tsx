// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import BookingBoard from "../../src/components/BookingBoard";
import Dialog from "../../src/components/Dialog";
import { LanguageProvider } from "../../src/components/Language";
import ClassesPage from "../../src/app/classes/page";
import { shortDate } from "../../src/lib/region";
import { addDays, todayISO } from "../../src/lib/time";

/**
 * The booking form on a phone, and the customer's dialogs (audit R8 X2-6,
 * X2-17): the form is a sheet that says why a booking was refused where it is
 * seen and ends with the Book button, after everything still to choose; the
 * confirmation, the waiting list and the class enrolment are dialogs a
 * keyboard and a screen reader know as such (named, focus moved in and kept
 * there, Escape, focus given back), all through one Dialog component.
 */

const COURT = { id: 1, venueId: 1, name: "Badminton Court 1", sport: "badminton" as const, offPeakRate: 15, peakRate: 25, capacity: 1 };
const HOURLY = { startEvery: 60, startOffset: 0, startTimes: null, lengthStep: 60, minLength: 60, maxLength: 240, lengths: null, defaultLength: 60, noticeMinutes: 0 };
const DAY = addDays(todayISO(), 3);
const slot = (hour: number, available: boolean) => ({ minute: hour * 60, hour, available, rate: 15, booked: available ? 0 : 1, capacity: 1, blocked: false, className: null });
const availability = [
  {
    court: COURT,
    grid: 60,
    unit: 1,
    policy: HOURLY,
    // 10:00 free; 11:00 taken by somebody, to queue for.
    slots: [slot(10, true), slot(11, false)],
    starts: [{ minute: 600, maxLength: 60 }],
  },
];

const confirmation = {
  booking: { id: 5, code: "MS-QB8DLG", courtId: 1, date: DAY, startMin: 600, endMin: 660, startHour: 10, endHour: 11, totalPrice: 15, paymentStatus: "unpaid", phone: "0123456789", players: 1 },
  bookings: [{ id: 5, code: "MS-QB8DLG", courtId: 1, date: DAY, startMin: 600, endMin: 660, startHour: 10, endHour: 11, totalPrice: 15, paymentStatus: "unpaid", phone: "0123456789", players: 1 }],
  skipped: [],
  seriesCode: null,
  court: COURT,
  venue: { name: "Dialog Hall", area: "Cheras" },
};

let bookingAnswer: { ok: boolean; status: number; body: unknown };
/** What the quote adds: a members-only session's lines (components/MembershipEligibility.tsx). */
let quoteExtra: Record<string, unknown>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  bookingAnswer = { ok: true, status: 201, body: confirmation };
  quoteExtra = {};
  fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
    const u = String(url);
    const answer = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
    if (u.includes("/api/availability")) return answer(200, { availability, closure: null, memberRates: false });
    if (u.includes("/api/quote")) return answer(200, { total: 15, court: 15, fees: 0, billedMinutes: 60, allowed: true, others: [], ...quoteExtra });
    if (u.includes("/api/auth/me")) return answer(200, { user: null });
    if (u.includes("/api/bookings") && init?.method === "POST")
      return bookingAnswer.body === "html"
        ? // What the proxy sends while the app restarts: an HTML page, which is no JSON.
          { ok: false, status: 502, json: async () => JSON.parse("<html><body>502 Bad Gateway</body></html>") }
        : answer(bookingAnswer.status, bookingAnswer.body);
    if (u.includes("/api/waitlist") && init?.method === "POST") return answer(201, { position: 2, leaveToken: "0123abcd" });
    if (u.includes("/api/classes")) return answer(200, { classes: [CLASS] });
    return answer(404, {});
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

const settle = (ms = 260) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

async function board() {
  render(
    <LanguageProvider locale="en">
      <BookingBoard venueId={1} venueName="Dialog Hall" sports={["badminton"]} dates={[DAY]} contact={{ phone: "03-4251 7788", whatsapp: "60342517788" }} />
    </LanguageProvider>
  );
  await settle(0);
}

async function openForm() {
  await board();
  await act(async () => within(screen.getByRole("table")).getAllByRole("button")[0].click());
  await settle();
  return screen.getByRole("form", { name: "Your booking" });
}

async function fillAndBook(form: HTMLElement) {
  fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Siti Test" } });
  fireEvent.change(within(form).getByLabelText("Phone"), { target: { value: "0123456789" } });
  await act(async () => void fireEvent.submit(form));
  await settle(0);
}

describe("the booking form on a phone", () => {
  it("is a sheet no taller than part of the screen, scrolling inside, with a way to close it", async () => {
    const form = await openForm();
    for (const c of ["fixed", "bottom-0", "max-h-[60vh]", "overflow-y-auto", "sm:sticky"]) expect(form.className).toContain(c);
    await act(async () => within(form).getByRole("button", { name: "Close, and choose another time" }).click());
    expect(screen.queryByRole("form", { name: "Your booking" })).toBeNull();
  });

  it("writes the day with its weekday", async () => {
    const form = await openForm();
    expect(within(form).getByText(new RegExp(shortDate(DAY, "en", true)))).toBeTruthy();
  });

  it("ends with the Book button, after who takes part, the promo code and the venue's terms", async () => {
    const form = await openForm();
    const buttons = form.querySelectorAll("button");
    const book = within(form).getByRole("button", { name: /^Book · / });
    expect(buttons[buttons.length - 1]).toBe(book);
    const promo = within(form).getByLabelText(/promo/i);
    expect(promo.compareDocumentPosition(book) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("says why a booking was refused inside the form, by the button, with the venue's number, and gives it the focus", async () => {
    bookingAnswer = { ok: false, status: 400, body: { error: "Please provide a valid phone number." } };
    const form = await openForm();
    await fillAndBook(form);
    const alert = within(form).getByRole("alert");
    expect(alert.textContent).toContain("Please provide a valid phone number.");
    expect(document.activeElement).toBe(alert);
    expect(within(alert).getByRole("link", { name: "03-4251 7788" }).getAttribute("href")).toBe("tel:0342517788");
    expect(within(alert).getByRole("link", { name: "Chat on WhatsApp" }).getAttribute("href")).toContain("https://wa.me/60342517788");
    // Not also above the grid, behind the sheet.
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("closes when the renewal link of a members' session is followed, so the sheet does not cover the venue's plans", async () => {
    quoteExtra = {
      members: [{ participantId: null, name: "Siti", covered: false, lapse: { kind: "ended", until: DAY }, renew: "/venue/1#membership" }],
    };
    const form = await openForm();
    const link = within(within(form).getByRole("alert")).getByRole("link", { name: "Renew or buy a membership" });
    expect(link.getAttribute("href")).toBe("/venue/1#membership");
    await act(async () => link.click());
    expect(screen.queryByRole("form", { name: "Your booking" })).toBeNull();
  });

  it("an answer that is not the app's is said as such, never as a JSON parser error", async () => {
    bookingAnswer = { ok: false, status: 502, body: "html" };
    const form = await openForm();
    await fillAndBook(form);
    const alert = within(form).getByRole("alert");
    expect(alert.textContent).toContain("The site did not answer properly");
    expect(alert.textContent).not.toMatch(/Unexpected token|JSON/);
  });
});

describe("the confirmation", () => {
  it("is a dialog named by its title, described by the code, with the focus inside; Escape closes it", async () => {
    const form = await openForm();
    await fillAndBook(form);
    const dialog = screen.getByRole("dialog", { name: "Booking confirmed!" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(dialog.getAttribute("aria-describedby")!)?.textContent).toBe("MS-QB8DLG");
    expect(dialog.contains(document.activeElement)).toBe(true);
    // The date with its weekday.
    expect(within(dialog).getByText(shortDate(DAY, "en", true))).toBeTruthy();
    // Tab from the last control comes back to the first, never out to the page behind.
    const focusable = dialog.querySelectorAll<HTMLElement>("a[href], button:not([disabled])");
    focusable[focusable.length - 1].focus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(focusable[0]);
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(focusable[focusable.length - 1]);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the waiting list on the grid", () => {
  it("is a dialog named by the court, opening on the first field; joined, it gives the link to leave; Escape closes it and gives the focus back", async () => {
    await board();
    const queue = within(screen.getByRole("table")).getAllByRole("button")[1];
    queue.focus();
    await act(async () => queue.click());
    const dialog = screen.getByRole("dialog", { name: "Badminton Court 1" });
    expect(document.activeElement).toBe(within(dialog).getByLabelText("Name"));
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Siti Test" } });
    fireEvent.change(within(dialog).getByLabelText("Phone"), { target: { value: "0123456789" } });
    await act(async () => void fireEvent.submit(dialog.querySelector("form")!));
    await settle(0);
    const joined = screen.getByRole("dialog", { name: "You're on the waitlist" });
    expect(within(joined).getByRole("link", { name: /Leave the waiting list/ }).getAttribute("href")).toBe("/waitlist/leave/0123abcd");
    fireEvent.keyDown(joined, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(queue);
  });
});

const CLASS = {
  id: 77,
  venueId: 1,
  venueName: "Dialog Hall",
  venueArea: "Cheras",
  courtId: 3,
  name: "Morning Spin",
  instructor: "Ravi",
  sport: "gym",
  date: DAY,
  startHour: 9,
  endHour: 10,
  startMin: 540,
  endMin: 600,
  capacity: 10,
  enrolled: 10,
  price: 20,
  who: "anyone",
  seriesCode: null,
};

describe("enrolling in a class", () => {
  it("is the same dialog: named, the focus on the first field, the leave link once queued, Escape to close", async () => {
    render(
      <LanguageProvider locale="en">
        <ClassesPage />
      </LanguageProvider>
    );
    await settle(0);
    await act(async () => screen.getByRole("button", { name: "Join waitlist" }).click());
    const dialog = screen.getByRole("dialog", { name: "Morning Spin" });
    expect(document.activeElement).toBe(within(dialog).getByLabelText("Name"));
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Siti Test" } });
    fireEvent.change(within(dialog).getByLabelText("Phone"), { target: { value: "0123456789" } });
    await act(async () => void fireEvent.submit(dialog.querySelector("form")!));
    await settle(0);
    const queued = screen.getByRole("dialog", { name: "You're on the waitlist" });
    expect(within(queued).getByRole("link", { name: /Leave the waiting list/ }).getAttribute("href")).toBe("/waitlist/leave/0123abcd");
    fireEvent.keyDown(queued, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a place held until it is paid says so, and until when, instead of calling the customer enrolled (ADR 0070)", async () => {
    const open = { ...CLASS, enrolled: 4 };
    const enrolled = { id: 9, code: "MS-HELD01", totalPrice: 20, paymentStatus: "unpaid", holdUntil: "2031-01-02 03:04:05" };
    const answer = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string }) => {
        const u = String(url);
        if (u.includes("/api/classes/enrol") && init?.method === "POST")
          return answer(201, { booking: enrolled, bookings: [enrolled], holdUntil: enrolled.holdUntil, timeZone: "Asia/Kuala_Lumpur", payOnline: true, link: "tok", session: open });
        if (u.includes("/api/auth/me")) return answer(200, { user: null });
        if (u.includes("/api/classes")) return answer(200, { classes: [open] });
        return answer(404, {});
      })
    );
    render(
      <LanguageProvider locale="en">
        <ClassesPage />
      </LanguageProvider>
    );
    await settle(0);
    await act(async () => screen.getByRole("button", { name: /Enrol|Join/ }).click());
    const dialog = screen.getByRole("dialog", { name: "Morning Spin" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Siti Test" } });
    fireEvent.change(within(dialog).getByLabelText("Phone"), { target: { value: "0123456789" } });
    await act(async () => void fireEvent.submit(dialog.querySelector("form")!));
    await settle(0);
    const held = screen.getByRole("dialog", { name: "Held for you: pay to confirm" });
    // 03:04 UTC is 11:04 in Malaysia, on the day it falls.
    expect(within(held).getByTestId("hold-notice").textContent).toMatch(/Pay online by .*11:04/);
    expect(screen.queryByText("You're enrolled")).toBeNull();
    expect(within(held).getByText("MS-HELD01")).toBeTruthy();
  });
});

describe("Dialog", () => {
  it("with nothing to focus inside, keeps the focus on itself", () => {
    const onClose = vi.fn();
    render(
      <>
        <button>outside</button>
        <Dialog labelledBy="t" onClose={onClose}>
          <h2 id="t">Plain</h2>
        </Dialog>
      </>
    );
    const dialog = screen.getByRole("dialog", { name: "Plain" });
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
