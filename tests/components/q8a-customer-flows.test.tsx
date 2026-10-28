// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

// One router for every render: a page that loads on a change of router would otherwise load for ever.
const { push, router } = vi.hoisted(() => {
  const push = vi.fn();
  return { push, router: { push, replace: () => {}, refresh: () => {} } };
});
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/" }));

import LoginPage from "../../src/app/login/page";
import MyBookingPage from "../../src/app/my-booking/page";
import ClaimPage from "../../src/app/waitlist/[token]/page";
import AccountPage from "../../src/app/account/page";
import BookingBoard from "../../src/components/BookingBoard";
import { LanguageProvider } from "../../src/components/Language";
import { addDays, todayISO } from "../../src/lib/time";

/**
 * The customer's pages in the round-8 X2 findings: sign-in shows only its
 * own error words and goes on only to this site; My Booking opens from a
 * link and keeps it; a waiting-list offer says what it is before the claim
 * and, held, how to pay after; the account says a held booking is held and
 * offers what My Booking offers; and a promo code is checked before booking.
 */

let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown, ok = true, status = ok ? 200 : 400) => ({ ok, status, json: async () => body });
type Route = (url: string, init?: { method?: string; body?: string }) => unknown;
let route: Route = () => undefined;

beforeEach(() => {
  push.mockReset();
  route = () => undefined;
  fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => route(String(url), init) ?? json({}));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const at = (path: string) => window.history.replaceState(null, "", path);
const show = async (node: React.ReactNode, locale: "en" | "ms" | "zh" | "ta" = "en") => {
  await act(async () => void render(<LanguageProvider locale={locale}>{node}</LanguageProvider>));
  await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
};
const called = (part: string) => fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.includes(part));

const HOLD_UNTIL = "2030-05-01 10:45:00";
const heldBooking = {
  id: 7,
  code: "MS-HELD01",
  courtId: 3,
  classId: null,
  date: "2030-05-01",
  startHour: 18,
  endHour: 19,
  startMin: 1080,
  endMin: 1140,
  name: "Bala",
  phone: "0123000111",
  email: null,
  status: "confirmed",
  paymentStatus: "unpaid",
  totalPrice: 22,
  sharesPaid: 0,
  holdUntil: HOLD_UNTIL,
  checkInToken: null,
  players: 1,
};

describe("signing in (X2-1)", () => {
  it("shows the general failure for an error it has no words for, never the text in the address", async () => {
    at("/login?error=Your%20account%20is%20locked.%20Call%20012-999%209999");
    await show(<LoginPage />);
    expect(screen.queryByText(/account is locked/)).toBeNull();
    expect(screen.getByText("Something went wrong")).toBeTruthy();
  });

  it("says a known refusal in its own words", async () => {
    at("/login?error=cancelled");
    await show(<LoginPage />, "ms");
    expect(screen.getByText("Log masuk dengan Google telah dibatalkan.")).toBeTruthy();
  });

  it("goes on only to a page on this site after signing in", async () => {
    route = (u) => (u.includes("/api/auth/login") ? json({ user: { id: 1 } }) : u.includes("/api/auth/providers") ? json({ google: false }) : undefined);
    for (const [next, to] of [
      ["/%5Cevil.example/x", "/account"],
      ["/%09/evil.example", "/account"],
      ["//evil.example", "/account"],
      ["/venue/4?date=2030-05-01", "/venue/4?date=2030-05-01"],
    ]) {
      push.mockReset();
      at(`/login?next=${encodeURIComponent(next)}`);
      const { unmount, container } = render(
        <LanguageProvider locale="en">
          <LoginPage />
        </LanguageProvider>
      );
      fireEvent.change(screen.getByPlaceholderText(/@/), { target: { value: "a@b.my" } });
      fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: "secret secret" } });
      await act(async () => void fireEvent.submit(container.querySelector("form")!));
      expect(push, next).toHaveBeenCalledWith(to);
      unmount();
    }
  });
});

describe("My Booking from a link (X2-8, X2-4)", () => {
  const found = {
    booking: heldBooking,
    court: { id: 3, name: "Court 1", unmanned: false },
    venue: { name: "SmashPoint", area: "PJ", address: "1 Jalan", cancelCutoffHours: 0, timeZone: "Asia/Kuala_Lumpur" },
    payOnline: true,
    depositPercent: null,
    link: "/my-booking?code=MS-HELD01&t=abc.def",
  };

  it("opens the booking the link names without the phone typed, held as held in the reader's language", async () => {
    at("/my-booking?code=MS-HELD01&t=abc.def");
    route = (u) => (u.startsWith("/api/bookings?") ? json(found) : undefined);
    await show(<MyBookingPage />, "zh");
    expect(called("/api/bookings?")[0]).toBe("/api/bookings?code=MS-HELD01&t=abc.def");
    expect(screen.getByTestId("hold-notice").textContent).toMatch(/在线付款期间保留至 下午6:45/);
    expect(screen.getByRole("button", { name: /RM22/ })).toBeTruthy();
    // Paying sends the phone the link answered with, as typing it would.
    route = (u, init) => (u === "/api/payments" ? json({ error: JSON.parse(init!.body!).phone }, false) : undefined);
    await act(async () => void screen.getByRole("button", { name: /RM22/ }).click());
    expect(screen.getByText("0123000111")).toBeTruthy();
  });

  it("a court given back late, all of it kept, says nothing is refunded, never that the rest goes back", async () => {
    const paid = { ...heldBooking, holdUntil: null, paymentStatus: "paid", date: addDays(todayISO(), 1) };
    at("/my-booking?code=MS-HELD01&t=abc.def");
    route = (u, init) =>
      u.startsWith("/api/bookings?")
        ? json({ ...found, booking: paid, venue: { ...found.venue, cancelCutoffHours: 1000, lateCancelKeep: null, lateGiveBack: true } })
        : u === "/api/bookings/cancel" && init?.method === "POST"
          ? json({ booking: { ...paid, status: "cancelled" }, kept: 22, refunds: [] })
          : undefined;
    await show(<MyBookingPage />);
    const asked = vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => void screen.getByRole("button", { name: "Give the court back (no refund)" }).click());
    asked.mockRestore();
    expect(screen.getByText("Cancelled. The venue kept the RM22 you paid; nothing is refunded.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("the rest goes back");
  });

  it("a lookup by code and phone puts the booking's link, never the phone, in the address", async () => {
    at("/my-booking");
    route = (u) => (u.startsWith("/api/bookings?") ? json(found) : undefined);
    await show(<MyBookingPage />);
    fireEvent.change(screen.getByPlaceholderText("MS-XXXXXX"), { target: { value: "ms-held01" } });
    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: "0123000111" } });
    await act(async () => void fireEvent.submit(screen.getByRole("button", { name: "Find my booking" }).closest("form")!));
    expect(window.location.pathname + window.location.search).toBe("/my-booking?code=MS-HELD01&t=abc.def");
    expect(window.location.search).not.toContain("0123000111");
  });
});

describe("a waiting-list offer (X2-2)", () => {
  const offer = {
    venue: { id: 2, name: "SmashPoint", area: "PJ", address: "1 Jalan", timeZone: "Asia/Kuala_Lumpur" },
    kind: "court",
    what: "Court 1",
    instructor: null,
    date: "2030-05-03",
    startMin: 1080,
    endMin: 1140,
    places: 1,
    forNames: [],
    price: 22,
    offerEnds: "2030-05-01 10:30:00",
    holdMinutes: 15,
    payOnline: true,
  };

  it("says what is offered before claiming, and that it is then held until paid; claimed, how to pay, never the counter", async () => {
    route = (u, init) =>
      u.startsWith("/api/waitlist/claim?")
        ? json({ offer })
        : u === "/api/waitlist/claim" && init?.method === "POST"
          ? json({
              booking: { ...heldBooking, date: "2030-05-03" },
              bookings: [{ ...heldBooking, date: "2030-05-03" }],
              session: null,
              holdUntil: HOLD_UNTIL,
              court: { id: 3, name: "Court 1" },
              venue: offer.venue,
              payOnline: true,
              depositPercent: null,
              link: "tok.sig",
            })
          : undefined;
    await show(<ClaimPage params={Promise.resolve({ token: "abc" })} />);
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    const details = screen.getByTestId("offer-details");
    expect(within(details).getByText("SmashPoint (PJ)")).toBeTruthy();
    expect(within(details).getByText("Court 1")).toBeTruthy();
    expect(within(details).getByText(/6:00 PM – 7:00 PM/)).toBeTruthy();
    expect(within(details).getByText(/^RM22/)).toBeTruthy();
    expect(screen.getByTestId("offer-ends").textContent).toContain("6:30 PM");
    expect(screen.getByTestId("offer-hold").textContent).toContain("held for 15 minutes");

    await act(async () => void screen.getByRole("button", { name: "Claim my place" }).click());
    expect(screen.getByText("MS-HELD01")).toBeTruthy();
    expect(screen.getByTestId("hold-notice").textContent).toContain("Held until 6:45 PM");
    expect(screen.getByRole("button", { name: /Pay RM22 online/ })).toBeTruthy();
    expect(document.body.textContent).not.toContain("payable at the counter");
    expect(screen.getByRole("link", { name: "Go to My Booking" }).getAttribute("href")).toBe("/my-booking?code=MS-HELD01&t=tok.sig");
    expect(screen.getByRole("link", { name: "Back to the venue" }).getAttribute("href")).toBe("/venue/2");
  });
});

describe("the account's bookings (X2-4, X2-11)", () => {
  const tomorrow = addDays(todayISO(), 1);
  const row = (over: Record<string, unknown>) => ({
    ...heldBooking,
    date: tomorrow,
    courtName: "Court 1",
    sport: "badminton",
    venueId: 2,
    venueName: "SmashPoint",
    venueArea: "PJ",
    venueAddress: "1 Jalan",
    venueTimeZone: "Asia/Kuala_Lumpur",
    venueCancelCutoffHours: 0,
    venueLateCancelKeep: null,
    venueLateGiveBack: false,
    venueStrikeLimit: null,
    reviewUrl: null,
    mostSpots: 4,
    seriesCode: null,
    payOnline: true,
    depositPercent: null,
    lastDate: addDays(todayISO(), 14),
    ...over,
  });
  const account = (bookings: unknown[]) => {
    route = (u) =>
      u.startsWith("/api/auth/me")
        ? json({ user: { id: 1, name: "Bala", email: "bala@x.my", phone: "0123000111" } })
        : u.startsWith("/api/my/bookings")
          ? json({ bookings, refunds: [] })
          : json({ passes: [], memberships: [], receipts: [], entries: [], venues: [], guests: [], people: [], invites: [], balance: 0, balances: [], vouchers: [] });
  };

  it("says a held booking is held, until when, with the same pay and change actions as My Booking", async () => {
    account([row({})]);
    await show(<AccountPage />);
    expect(screen.getByTestId("booking-pill").textContent).toBe("Held");
    expect(document.body.textContent).not.toContain("(pay at counter)");
    expect(screen.getByText("RM22: pay online to keep it")).toBeTruthy();
    expect(screen.getByTestId("hold-notice").textContent).toContain("Held until");
    expect(screen.getByRole("button", { name: /Pay RM22 online/ })).toBeTruthy();
    await act(async () => void screen.getByRole("button", { name: "Change date or time" }).click());
    expect(called("/api/bookings/reschedule?code=MS-HELD01&phone=0123000111").length).toBeGreaterThan(0);
  });

  it("past the cutoff, where the venue lets a court be given back, offers that, nothing refunded", async () => {
    account([row({ holdUntil: null, paymentStatus: "paid", venueCancelCutoffHours: 1000, venueLateGiveBack: true })]);
    await show(<AccountPage />);
    expect(screen.getByRole("button", { name: "Give the court back (no refund)" })).toBeTruthy();
    const asked = vi.spyOn(window, "confirm").mockReturnValue(false);
    await act(async () => void screen.getByRole("button", { name: "Give the court back (no refund)" }).click());
    expect(asked.mock.calls[0][0]).toContain("giving the court back refunds nothing");
    asked.mockRestore();
  });

  it("given back, says the venue kept what was paid and nothing is refunded, never that the rest goes back; a share kept still says the rest goes back", async () => {
    for (const [kept, said] of [
      [22, "Cancelled. The venue kept the RM22 you paid; nothing is refunded."],
      [11, "Cancelled. The venue kept RM11; the rest goes back the way you paid."],
    ] as const) {
      account([row({ holdUntil: null, paymentStatus: "paid", venueCancelCutoffHours: 1000, venueLateGiveBack: true })]);
      const answer = route;
      route = (u, init) => (u === "/api/my/bookings/cancel" && init?.method === "POST" ? json({ kept, refunds: [] }) : answer(u, init));
      await show(<AccountPage />);
      const asked = vi.spyOn(window, "confirm").mockReturnValue(true);
      await act(async () => void screen.getByRole("button", { name: "Give the court back (no refund)" }).click());
      await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
      asked.mockRestore();
      expect(screen.getByText(said)).toBeTruthy();
      expect(document.body.textContent?.includes("the rest goes back")).toBe(kept < 22);
      cleanup();
    }
  });

  it("where it does not, the cancel button is as before", async () => {
    account([row({ holdUntil: null, venueCancelCutoffHours: 1000 })]);
    await show(<AccountPage />);
    expect(screen.queryByRole("button", { name: /Give the court back/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel booking" })).toBeTruthy();
  });
});

describe("a promo code checked before booking (X2-5)", () => {
  const COURT = { id: 1, venueId: 1, name: "Court 1", sport: "badminton" as const, offPeakRate: 20, peakRate: 20, capacity: 1 };
  const HOURLY = { startEvery: 60, startOffset: 0, startTimes: null, lengthStep: 60, minLength: 60, maxLength: 240, lengths: null, defaultLength: 60, noticeMinutes: 0 };
  const HOURS = [8, 9, 10, 11, 12];
  const row = {
    court: COURT,
    grid: 60,
    unit: 1,
    policy: HOURLY,
    slots: HOURS.map((hour) => ({ minute: hour * 60, hour, available: true, rate: 20, booked: 0, capacity: 1, blocked: false, className: null })),
    starts: HOURS.map((h) => ({ minute: h * 60, maxLength: Math.min(240, 13 * 60 - h * 60) })),
  };
  const DAY = addDays(todayISO(), 1);

  const board = async () => {
    route = (u) => {
      if (u.includes("/api/availability")) return json({ availability: [row], closure: null, memberRates: false, concessions: [] });
      if (u.includes("/api/quote")) {
        const code = new URL(u, "http://localhost").searchParams.get("promoCode");
        const promo =
          code === "TENOFF"
            ? { ok: true, code: "TENOFF", kind: "percent", value: 10, combinable: false, discount: 2 }
            : code
              ? { ok: false, error: "That code is not valid at this venue." }
              : undefined;
        return json({ total: 20, court: 20, fees: 0, billedMinutes: 60, allowed: true, others: [], ...(promo ? { promo } : {}) });
      }
      if (u.includes("/api/auth/me")) return json({ user: null });
      return undefined;
    };
    await act(async () => void render(
      <LanguageProvider locale="en">
        <BookingBoard venueId={1} sports={["badminton"]} dates={[DAY]} />
      </LanguageProvider>
    ));
    await act(async () => within(screen.getByRole("table")).getAllByRole("button")[0].click());
    await act(async () => void (await new Promise((r) => setTimeout(r, 260))));
  };
  const typeCode = async (code: string) => {
    await act(async () => void fireEvent.change(screen.getByLabelText("Promo code?"), { target: { value: code } }));
    await act(async () => void (await new Promise((r) => setTimeout(r, 260))));
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
  };

  it("a wrong code is refused with the reason before booking, and the form waits for it to be put right", async () => {
    await board();
    await typeCode("WRONGCODE");
    expect(called("promoCode=WRONGCODE").length).toBeGreaterThan(0);
    expect(screen.getByTestId("promo-refused").textContent).toContain("That code is not valid at this venue.");
    expect((screen.getByRole("button", { name: /^Book/ }) as HTMLButtonElement).disabled).toBe(true);
    await typeCode("");
    expect((screen.getByRole("button", { name: /^Book/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a good code shows what it takes off, in the total on the button", async () => {
    await board();
    expect(screen.getByRole("button", { name: /^Book/ }).textContent).toContain("20");
    await typeCode("tenoff");
    expect(screen.getByTestId("promo-applied").textContent).toBe("TENOFF takes RM2 off; the total includes it.");
    expect(screen.getByRole("button", { name: /^Book/ }).textContent).toContain("18");
  });
});
