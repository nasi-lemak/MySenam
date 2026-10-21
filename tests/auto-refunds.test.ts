import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.sg";
process.env.MYSENAM_COUNTRY = "SG";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { registerUser, type User } from "../src/lib/auth";
import { setCancelPolicy, type OnlineRefunds } from "../src/lib/cancel-policy";
import { refundCancelled, refundsOwed, savePaymentSettings, settleBill, startBookingPayment } from "../src/lib/payments";
import { cancelBooking, createBookingSeries, createCourt, createVenue, getWalletBalance } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { POST as cancelRoute } from "../src/app/api/bookings/cancel/route";
import { POST as cancelSeriesRoute } from "../src/app/api/bookings/cancel-series/route";

/**
 * Money a customer paid online goes back when they cancel, as the venue
 * chose: left to staff (as before), straight back through Stripe, or as
 * credit. Whatever cannot go back that way stays owed for staff.
 */

let venueId: number;
let courtId: number;
let customer: User;
let n = 0;
let refundCalls = 0;
let hour = 8;
const date = addDays(todayISO(), 3);

function fakeStripe(refund: () => Response = () => Response.json({ id: `re_${++n}`, status: "succeeded" })) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string }) => {
      if (url.endsWith("/refunds")) {
        refundCalls++;
        return refund();
      }
      if (init.method === "POST") {
        const id = `cs_test_auto${++n}`;
        return Response.json({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
      }
      const id = decodeURIComponent(url.split("/").pop()!);
      return Response.json({ id, payment_status: "paid", status: "complete", payment_intent: `pi_for_${id}` });
    })
  );
}

/** A booking paid online through Stripe, from an account or without one. */
async function paid(opts: { account?: boolean; weeks?: number } = {}) {
  fakeStripe();
  const made = await createBookingSeries({
    courtId,
    date,
    hours: [hour++],
    name: "Wei Ling",
    phone: opts.account ? customer.phone : `9123${String(++n).padStart(4, "0")}`,
    userId: opts.account ? customer.id : undefined,
    weeks: opts.weeks ?? 1,
  });
  if (!made.ok) throw new Error(made.error);
  const codes = made.bookings.map((b) => b.code);
  const started = await startBookingPayment({ codes, phone: made.bookings[0].phone });
  if (!started.ok) throw new Error("payment");
  await settleBill({ billId: started.url.split("/").pop()!, paid: true, paidAt: null });
  refundCalls = 0;
  return { ...made, booking: made.bookings[0] };
}

const choose = (onlineRefunds: OnlineRefunds) => setCancelPolicy(venueId, { onlineRefunds });

beforeAll(async () => {
  const made = await createVenue({ name: "Tampines Courts", area: "Tampines", address: "x", phone: "61230001" });
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
  const user = await registerUser({ name: "Wei Ling", email: "weiling@example.sg", phone: "91234567", password: "a long enough password" });
  if (!user.ok) throw new Error(user.error);
  customer = user.user;
});

afterEach(() => vi.unstubAllGlobals());
afterAll(() => {
  delete process.env.MYSENAM_COUNTRY;
});

describe("when a customer cancels", () => {
  it("is left to staff by default, and the customer is told the venue will refund it", async () => {
    const made = await paid();
    const res = await cancelRoute(
      new NextRequest("http://localhost/api/bookings/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: made.booking.code, phone: made.booking.phone }),
      })
    );
    expect(await res.json()).toMatchObject({ booking: { status: "cancelled" }, refunds: [{ how: "staff", amount: 20 }] });
    expect(refundCalls).toBe(0);
    expect(await refundsOwed(venueId)).toEqual(expect.arrayContaining([expect.objectContaining({ refundOwed: 20 })]));
  });

  it("goes straight back through Stripe when the venue chooses", async () => {
    await choose("gateway");
    const made = await paid();
    expect(await cancelBooking(made.booking.code, made.booking.phone)).toMatchObject({ ok: true });
    const before = (await refundsOwed(venueId)).length;
    expect(await refundCancelled([made.booking.id])).toEqual([{ how: "gateway", amount: 20 }]);
    expect(refundCalls).toBe(1);
    expect(await refundsOwed(venueId)).toHaveLength(before - 1);
    // Asked again (a retried request): nothing more is owed, nothing more is sent.
    expect(await refundCancelled([made.booking.id])).toEqual([]);
    expect(refundCalls).toBe(1);
  });

  it("stays with staff when Stripe refuses", async () => {
    const made = await paid();
    await cancelBooking(made.booking.code, made.booking.phone);
    fakeStripe(() => Response.json({ error: { message: "The provided key does not have the required permissions" } }, { status: 403 }));
    const before = (await refundsOwed(venueId)).length;
    expect(await refundCancelled([made.booking.id])).toEqual([{ how: "staff", amount: 20 }]);
    expect(await refundsOwed(venueId)).toHaveLength(before);
  });

  it("becomes credit on the account that booked, once", async () => {
    await choose("credit");
    const made = await paid({ account: true });
    const balance = await getWalletBalance(customer.id, venueId);
    await cancelBooking(made.booking.code, made.booking.phone);
    const before = (await refundsOwed(venueId)).length;
    expect(await refundCancelled([made.booking.id])).toEqual([{ how: "credit", amount: 20 }]);
    expect(await getWalletBalance(customer.id, venueId)).toBe(balance + 20);
    expect(await refundsOwed(venueId)).toHaveLength(before - 1);
    expect(refundCalls).toBe(0);
    expect(await refundCancelled([made.booking.id])).toEqual([]);
    expect(await getWalletBalance(customer.id, venueId)).toBe(balance + 20);
  });

  it("stays with staff as credit when there is no account to put it on", async () => {
    const made = await paid();
    await cancelBooking(made.booking.code, made.booking.phone);
    expect(await refundCancelled([made.booking.id])).toEqual([{ how: "staff", amount: 20 }]);
  });

  it("covers every session of a series cancelled together", async () => {
    const made = await paid({ account: true, weeks: 3 });
    expect(made.bookings).toHaveLength(3);
    const balance = await getWalletBalance(customer.id, venueId);
    const res = await cancelSeriesRoute(
      new NextRequest("http://localhost/api/bookings/cancel-series", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seriesCode: made.seriesCode, phone: made.booking.phone }),
      })
    );
    expect(await res.json()).toEqual({ cancelled: 3, refunds: [{ how: "credit", amount: 60 }] });
    expect(await getWalletBalance(customer.id, venueId)).toBe(balance + 60);
  });
});
