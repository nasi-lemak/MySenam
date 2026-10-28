import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

// The customer's language, as the switch in the header sets it.
let cookieLang: string | undefined;
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: (name: string) => (name === "ms_lang" && cookieLang ? { value: cookieLang } : undefined) }),
}));

// A gateway's signed return, stood in for: the bill in the address is believed, and it says not paid.
vi.mock("../src/lib/gateways", async (actual) => ({
  ...(await actual<typeof import("../src/lib/gateways")>()),
  allGateways: () => [
    {
      id: "billplz",
      readRedirect: (q: URLSearchParams) => {
        const billId = q.get("bill");
        return billId ? { billId, verify: async () => ({ billId, paid: false }) } : null;
      },
    },
  ],
}));

import { getDb } from "../src/lib/db";
import { holdNewBookings, releaseExpiredHolds, setHoldPolicy } from "../src/lib/holds";
import { savePaymentSettings, startBookingPayment } from "../src/lib/payments";
import { checkBookingLink } from "../src/lib/booking-access";
import { createBooking, createCourt, createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import PaymentReturnPage from "../src/app/payments/return/page";

/**
 * Coming back from a payment that failed or was abandoned (X2-3): the page
 * shows the booking's code, says a held booking is held until when and let
 * go after (never "pay at the counter"), one already let go says so, and
 * each still to pay can be paid again by its signed link.
 */

let n = 0;
let venueId: number;
let courtId: number;
const date = addDays(todayISO(), 3);
const page = async (bill: string) => renderToStaticMarkup(await PaymentReturnPage({ searchParams: Promise.resolve({ bill }) }));

function fakeBillplz() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const id = `retbill${++n}`;
      return Response.json({ id, url: `https://www.billplz-sandbox.com/bills/${id}` });
    })
  );
}

/** A booking, held or not, and a payment for it started and then not completed. */
async function failedPayment(hour: number, held: boolean) {
  const phone = `0148${String(++n).padStart(6, "0")}`;
  const made = await createBooking({ courtId, date, hours: [hour], name: "Bala", phone });
  if (!made.ok) throw new Error(made.error);
  if (held) await holdNewBookings([made.booking.id], 15);
  fakeBillplz();
  const started = await startBookingPayment({ codes: [made.booking.code], phone });
  if (!started.ok) throw new Error(started.error);
  vi.unstubAllGlobals();
  const bill = (await getDb().prepare("SELECT bill_id FROM online_payments ORDER BY id DESC LIMIT 1").get()) as { bill_id: string };
  return { booking: made.booking, bill: bill.bill_id };
}

beforeAll(async () => {
  const v = await createVenue({ name: "SmashPoint", area: "PJ", address: "x", phone: "0377771234" });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  const c = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 22, peakRate: 22 });
  if (!c.ok) throw new Error("court");
  courtId = c.court.id;
  const saved = await savePaymentSettings(venueId, { apiKey: "api-key-1234", collectionId: "col123", xSignatureKey: "S-key", sandbox: true, enabled: true });
  if (!saved.ok) throw new Error(saved.error);
  expect(await setHoldPolicy(venueId, { on: true, minutes: 15 })).toMatchObject({ ok: true });
});

afterEach(() => {
  cookieLang = undefined;
  vi.unstubAllGlobals();
});

describe("coming back from a payment not completed", () => {
  it("a held booking: its code, held until when and let go after, and pay again; never the counter", async () => {
    const { booking, bill } = await failedPayment(9, true);
    const html = await page(bill);
    expect(html).toContain("Payment not completed");
    expect(html).toContain(booking.code);
    expect(html).toContain("held for you only until the time below");
    expect(html).toMatch(/Held until \d{1,2}:\d{2}\s?(AM|PM|am|pm) while you pay online/);
    expect(html).toContain("Pay again to keep it");
    expect(html).toContain("Pay RM22 online");
    expect(html).not.toContain("pay at the counter");
    // My Booking opens on it by its signed link, the phone never in the address.
    const link = /href="(\/my-booking\?code=[^"]+)"/.exec(html)![1].replace(/&amp;/g, "&");
    const t = new URL(link, "http://x").searchParams.get("t")!;
    expect(checkBookingLink(booking.code, t)).toBe("ok");
    expect(link).not.toContain(booking.phone);
  });

  it("in the customer's language, the hold's end too", async () => {
    const { bill } = await failedPayment(10, true);
    cookieLang = "zh";
    const html = await page(bill);
    expect(html).toContain("您的预订仅保留至下方时间");
    expect(html).toMatch(/在线付款期间保留至 (上午|下午)\d{1,2}:\d{2}/);
  });

  it("a hold already run out: the booking was let go, and nothing to pay", async () => {
    const { booking, bill } = await failedPayment(11, true);
    await getDb().prepare("UPDATE bookings SET hold_until = '2000-01-01 00:00:00' WHERE id = ?").run(booking.id);
    await releaseExpiredHolds();
    const html = await page(bill);
    expect(html).toContain("the booking was let go because it was not paid in time");
    expect(html).not.toContain("Pay again");
    expect(html).not.toContain("pay at the counter");
  });

  it("a booking not held: it still stands, at the counter or paid again here", async () => {
    const { booking, bill } = await failedPayment(12, false);
    const html = await page(bill);
    expect(html).toContain("Your booking still stands: pay at the counter");
    expect(html).toContain(booking.code);
    expect(html).toContain("Pay again to keep it");
    expect(html).not.toContain("Held until");
  });
});
