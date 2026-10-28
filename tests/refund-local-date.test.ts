import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
// Stripe, as the installs it serves take it; Singapore is UTC+8, as Malaysia is.
process.env.MYSENAM_COUNTRY = "SG";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { setCancelPolicy } from "../src/lib/cancel-policy";
import { getDb } from "../src/lib/db";
import { issueReceipt } from "../src/lib/documents";
import { translator } from "../src/lib/i18n";
import { markRefunded, refundCancelled, refundClock, refundStatusFor, savePaymentSettings, settleBill, startBookingPayment } from "../src/lib/payments";
import { refundStatusLine } from "../src/lib/refund-text";
import { cancelBooking, createBookingSeries, createCourt, createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { GET as myReceipts } from "../src/app/api/my/receipts/route";

/**
 * The dates customers and staff are told about money are the venue's
 * calendar dates, not UTC's (Malaysia is UTC+8): the day a refund by hand is
 * due (lib/payments.ts `refundClock`, in the cancellation answer, the
 * booking's refund line and the staff panel), the day it was made, and the
 * day a receipt was issued. Anything noted between 00:00 and 08:00 in
 * Malaysia used to be dated a day early.
 */

const ZONE = "Asia/Singapore";
let venueId: number;
let courtId: number;
let n = 0;
let hour = 8;

function fakeStripe() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string } = {}) => {
      if (url.includes("/refunds?payment_intent=")) return Response.json({ object: "list", data: [] });
      if (url.endsWith("/refunds")) return Response.json({ id: `re_${++n}`, status: "succeeded" });
      if (init.method === "POST") {
        const id = `cs_test_local${++n}`;
        return Response.json({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
      }
      const id = decodeURIComponent(url.split("/").pop()!);
      return Response.json({ id, payment_status: "paid", status: "complete", payment_intent: `pi_for_${id}` });
    })
  );
}

beforeAll(async () => {
  const made = await createVenue({ name: "Tampines East Courts", area: "Tampines", address: "x", phone: "61230002" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!court.ok) throw new Error("court");
  courtId = court.court.id;
  const saved = await savePaymentSettings(venueId, {
    credentials: { secretKey: "rk_test_abcdefghijklmnop", webhookSecret: "whsec_testsecret1234567890" },
    sandbox: true,
    enabled: true,
  });
  if (!saved.ok) throw new Error(saved.error);
  expect(await setCancelPolicy(venueId, { onlineRefunds: "staff", refundWithinDays: 7 })).toMatchObject({ ok: true });
});

afterEach(() => vi.unstubAllGlobals());

describe("the day a refund by hand is due", () => {
  it("is the venue's calendar date: owed from 02:30 on the 5th there, due on the 12th, not the 11th", () => {
    const now = new Date("2026-10-06T00:00:00Z");
    // 18:30 UTC on the 4th is 02:30 on the 5th at UTC+8.
    expect(refundClock("2026-10-04 18:30:00", 7, now, ZONE)).toMatchObject({ dueBy: "2026-10-12", overdue: false });
    // The install's zone where none is given.
    expect(refundClock("2026-10-04 18:30:00", 7, now).dueBy).toBe("2026-10-12");
    // After 08:00 there, the two calendars agree.
    expect(refundClock("2026-10-05 03:00:00", 7, now, ZONE).dueBy).toBe("2026-10-12");
    // Overdue is still the instant: 02:30 on the 12th there.
    expect(refundClock("2026-10-04 18:30:00", 7, new Date("2026-10-11T18:29:00Z"), ZONE).overdue).toBe(false);
    expect(refundClock("2026-10-04 18:30:00", 7, new Date("2026-10-11T18:31:00Z"), ZONE).overdue).toBe(true);
  });

  it("is said so to the customer who cancels, on the booking's refund line, and once made, on the day it was made", async () => {
    fakeStripe();
    const made = await createBookingSeries({ courtId, date: addDays(todayISO(ZONE), 3), hours: [hour++], name: "Aisyah", phone: `9124${String(++n).padStart(4, "0")}`, weeks: 1 });
    if (!made.ok) throw new Error(made.error);
    const booking = made.bookings[0];
    const started = await startBookingPayment({ codes: [booking.code], phone: booking.phone });
    if (!started.ok) throw new Error("payment");
    await settleBill({ billId: started.url.split("/").pop()!, paid: true, paidAt: null });
    expect(await cancelBooking(booking.code, booking.phone)).toMatchObject({ ok: true });
    expect(await refundCancelled([booking.id])).toEqual([{ how: "staff", amount: 20, dueBy: addDays(todayISO(ZONE), 7) }]);

    const paymentId = ((await getDb().prepare("SELECT payment_id FROM online_payment_bookings WHERE booking_id = ?").get(booking.id)) as { payment_id: number }).payment_id;
    await getDb().prepare("UPDATE online_payments SET refund_seen_at = '2026-10-04 18:30:00', refund_seen_policy = 'manual' WHERE id = ?").run(paymentId);
    const owed = (await refundStatusFor([booking.id]))[0];
    expect(owed.clock?.dueBy).toBe("2026-10-12");

    expect(await markRefunded(paymentId, venueId, null, "Transfer 4411")).toMatchObject({ ok: true });
    await getDb().prepare("UPDATE online_refunds SET created_at = '2026-10-09 17:00:00' WHERE payment_id = ?").run(paymentId);
    const done = (await refundStatusFor([booking.id]))[0];
    expect(done).toMatchObject({ refundedAt: "2026-10-09 17:00:00", refundedOn: "2026-10-10" });
    expect(refundStatusLine(translator("en"), done).text).toMatch(/refunded on 2026-10-10\.$/);
  });
});

describe("a customer's receipts", () => {
  it("are dated as the venue's calendar has it", async () => {
    const u = await registerUser({ name: "Receipt Reader", email: "receipts@local-date.my", phone: "91299901", password: "a long enough password" });
    if (!u.ok) throw new Error(u.error);
    await issueReceipt({ source: "test:local-date", venueId, userId: u.user.id, name: "Receipt Reader", lines: [{ description: "Racket hire", amount: 10 }], paidVia: "cash", taxable: false, issuedAt: "2026-10-04 18:30:00" });
    const res = await myReceipts(new NextRequest("http://localhost/api/my/receipts", { headers: { cookie: `${SESSION_COOKIE}=${(await createSession(u.user.id)).token}` } }));
    const { receipts } = (await res.json()) as { receipts: { issuedAt: string; issuedOn: string }[] };
    expect(receipts).toEqual([expect.objectContaining({ issuedAt: "2026-10-04 18:30:00", issuedOn: "2026-10-05" })]);
  });
});
