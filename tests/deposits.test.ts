import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { bookingTerms } from "../src/lib/booking-terms";
import { setCancelPolicy, strikesFor } from "../src/lib/cancel-policy";
import { getDb } from "../src/lib/db";
import { bookingSale } from "../src/lib/documents";
import { holdPolicy, setHoldPolicy } from "../src/lib/holds";
import { savePaymentSettings, settleBill, startBookingPayment } from "../src/lib/payments";
import { cancelBooking, createCourt, createVenue, findBooking, rescheduleBooking, setPaymentStatus } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { POST as book } from "../src/app/api/bookings/route";

/**
 * A deposit to hold a booking: a share paid online now, the rest at the
 * counter. It stands the booking like paying in full, goes back like any
 * payment, and a late cancellation with one is not a strike.
 */

let venueId: number;
let courtId: number;
let n = 0;
const date = addDays(todayISO(), 3);

function fakeBillplz() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const id = `depbill${++n}`;
      return Response.json({ id, url: `https://www.billplz-sandbox.com/bills/${id}` });
    })
  );
}

const post = async (body: Record<string, unknown>) =>
  (
    await book(
      new NextRequest("http://localhost/api/bookings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ courtId, date, name: "Aina", email: "aina@example.my", ...body }),
      })
    )
  ).json();

/** Book, pay the deposit, and have the gateway say it arrived. */
async function deposited(hour: number, phone: string) {
  const made = await post({ hours: [hour], phone });
  fakeBillplz();
  const started = await startBookingPayment({ codes: [made.booking.code], phone, deposit: true });
  if (!started.ok) throw new Error("start");
  const bill = (await getDb().prepare("SELECT id, bill_id FROM online_payments ORDER BY id DESC LIMIT 1").get()) as { id: number; bill_id: string };
  await settleBill({ billId: bill.bill_id, paid: true, paidAt: null });
  return { booking: (await findBooking(made.booking.code, phone))!, paymentId: bill.id };
}

const payment = async (id: number) =>
  (await getDb().prepare("SELECT amount::float AS amount, refund_due::float AS refund_due FROM online_payments WHERE id = ?").get(id)) as {
    amount: number;
    refund_due: number;
  };

beforeAll(async () => {
  const made = await createVenue({ name: "Deposit Hall", area: "PJ", address: "x", phone: "0300000001" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 35, peakRate: 35 });
  if (!court.ok) throw new Error("court");
  courtId = court.court.id;
  const saved = await savePaymentSettings(venueId, { apiKey: "api-key-1234", collectionId: "col123", xSignatureKey: "S-key", sandbox: true, enabled: true });
  if (!saved.ok) throw new Error(saved.error);
});

afterEach(() => vi.unstubAllGlobals());

describe("a venue's deposit", () => {
  it("is one of the set shares, kept when the hold is saved without one, and none while holding is off", async () => {
    expect(await setHoldPolicy(venueId, { on: true, depositPercent: 15 })).toMatchObject({ ok: false });
    expect(await setHoldPolicy(venueId, { on: true, depositPercent: 30 })).toMatchObject({ ok: true, policy: { depositPercent: 30 } });
    expect(await setHoldPolicy(venueId, { on: true, minutes: 20 })).toMatchObject({ ok: true, policy: { minutes: 20, depositPercent: 30 } });
    expect((await bookingTerms(venueId))!.depositPercent).toBe(30);
    await setHoldPolicy(venueId, { on: false });
    expect((await holdPolicy(venueId)).depositPercent).toBeNull();
    expect((await bookingTerms(venueId))!.depositPercent).toBeUndefined();
    await setHoldPolicy(venueId, { on: true });
    expect((await holdPolicy(venueId)).depositPercent).toBe(30);
  });

  it("is offered at booking, and charges that share of the price", async () => {
    const made = await post({ hours: [9], phone: "0192220001" });
    expect(made.holdUntil).not.toBeNull();
    expect(made.depositPercent).toBe(30);
    fakeBillplz();
    expect(await startBookingPayment({ codes: [made.booking.code], phone: "0192220001", deposit: true })).toMatchObject({
      ok: true,
      amount: 10.5,
      deposit: true,
    });
    // The whole price is still there to pay instead.
    expect(await startBookingPayment({ codes: [made.booking.code], phone: "0192220001" })).toMatchObject({ ok: true, amount: 35 });
  });

  it("paid, stands the booking and confirms it, on a receipt of its own; the rest is the counter's", async () => {
    const { booking, paymentId } = await deposited(10, "0192220002");
    expect(booking).toMatchObject({ status: "confirmed", paymentStatus: "unpaid", holdUntil: null, depositPaid: 10.5, sharesPaid: 10.5 });
    const receipt = (await getDb().prepare("SELECT total::float AS total FROM receipts WHERE source = ? AND kind = 'receipt'").get(`payment:${paymentId}`)) as {
      total: number;
    };
    expect(receipt.total).toBe(10.5);
    const kinds = ((await getDb().prepare("SELECT kind FROM messages WHERE booking_id = ?").all(booking.id)) as { kind: string }[]).map((m) => m.kind);
    expect(kinds).toContain("booking_confirmed");
    // The lookup offers no second deposit, and paying online now is the rest.
    fakeBillplz();
    expect(await startBookingPayment({ codes: [booking.code], phone: "0192220002", deposit: true })).toMatchObject({ ok: true, amount: 24.5 });
    // Ticked paid at the counter, the booking's own sale is what the counter took.
    expect(await setPaymentStatus(booking.code, true, "cash")).toMatchObject({ ok: true });
    expect((await bookingSale(booking.id))!.total).toBe(24.5);
  });

  it("goes back in full when cancelled in time", async () => {
    const { booking, paymentId } = await deposited(11, "0192220003");
    expect(await cancelBooking(booking.code, "0192220003")).toMatchObject({ ok: true });
    expect(await payment(paymentId)).toEqual({ amount: 10.5, refund_due: 10.5 });
    const note = (await getDb()
      .prepare("SELECT total::float AS total FROM receipts WHERE kind = 'credit_note' AND credits_id = (SELECT id FROM receipts WHERE source = ?)")
      .get(`payment:${paymentId}`)) as { total: number };
    expect(note.total).toBe(10.5);
  });

  it("cancelled late, the venue keeps its share of it, and it is not a strike", async () => {
    await setCancelPolicy(venueId, { lateKeep: 50, strikeLimit: 3 });
    await getDb().prepare("UPDATE venues SET cancel_cutoff_hours = 168 WHERE id = ?").run(venueId);
    const { booking, paymentId } = await deposited(12, "0192220004");
    const cancelled = await cancelBooking(booking.code, "0192220004");
    expect(cancelled).toMatchObject({ ok: true, kept: 5.25 });
    expect(await payment(paymentId)).toEqual({ amount: 10.5, refund_due: 5.25 });
    expect(await strikesFor(venueId, "0192220004")).toBe(0);
    // Without a deposit, the same late cancellation is one.
    const held = await post({ hours: [13], phone: "0192220005" });
    await getDb().prepare("UPDATE bookings SET hold_until = NULL WHERE id = ?").run(held.booking.id);
    expect(await cancelBooking(held.booking.code, "0192220005")).toMatchObject({ ok: true, kept: 0 });
    expect(await strikesFor(venueId, "0192220005")).toBe(1);
    await getDb().prepare("UPDATE venues SET cancel_cutoff_hours = 0 WHERE id = ?").run(venueId);
  });

  it("is not for a number past its strikes: it pays the whole price", async () => {
    await setCancelPolicy(venueId, { lateKeep: 50, strikeLimit: 1 });
    await getDb()
      .prepare("UPDATE bookings SET no_show = 1 WHERE id = (SELECT id FROM bookings WHERE phone_key = phone_key('0192220002'))")
      .run();
    const made = await post({ hours: [14], phone: "0192220002" });
    expect(made.holdUntil).not.toBeNull();
    expect(made.depositPercent).toBeNull();
    fakeBillplz();
    const started = await startBookingPayment({ codes: [made.booking.code], phone: "0192220002", deposit: true });
    expect(started).toMatchObject({ ok: true, amount: 35 });
    expect(started.ok && started.deposit).toBeFalsy();
    await setCancelPolicy(venueId, {});
  });

  it("does not stop the customer moving their booking", async () => {
    const { booking } = await deposited(15, "0192220006");
    expect(await rescheduleBooking(booking.code, { date, startHour: 16 }, "customer")).toMatchObject({ ok: true });
  });

  it("on two bookings at once, cancelling one credits that one's part, then the other's", async () => {
    await getDb().prepare("UPDATE venues SET cancel_cutoff_hours = 0 WHERE id = ?").run(venueId);
    const phone = "0192220007";
    const a = await post({ hours: [17], phone });
    const b = await post({ hours: [18], phone });
    fakeBillplz();
    const started = await startBookingPayment({ codes: [a.booking.code, b.booking.code], phone, deposit: true });
    if (!started.ok) throw new Error("start");
    const bill = (await getDb().prepare("SELECT id, bill_id FROM online_payments ORDER BY id DESC LIMIT 1").get()) as { id: number; bill_id: string };
    await settleBill({ billId: bill.bill_id, paid: true, paidAt: null });
    const credited = async () =>
      ((await getDb()
        .prepare(
          `SELECT total::float AS total FROM receipts WHERE kind = 'credit_note'
            AND credits_id = (SELECT id FROM receipts WHERE source = ?) ORDER BY id`
        )
        .all(`payment:${bill.id}`)) as { total: number }[]).map((r) => r.total);
    expect(await cancelBooking(a.booking.code, phone)).toMatchObject({ ok: true });
    expect(await credited()).toEqual([10.5]);
    expect(await cancelBooking(b.booking.code, phone)).toMatchObject({ ok: true });
    expect(await credited()).toEqual([10.5, 10.5]);
    expect(await payment(bill.id)).toEqual({ amount: 21, refund_due: 21 });
  });
});
