import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.sg";
process.env.MYSENAM_COUNTRY = "SG";

import { getDb } from "../src/lib/db";
import { savePaymentSettings, settleBill, startBookingPayment } from "../src/lib/payments";
import { createBooking, createCourt, createVenue, rescheduleBooking } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * A booking paid by card through Stripe and moved to a cheaper time (ADR 0067): the difference is owed back on the payment and sent
 * through Stripe's refund call at once, for exactly that sum, once. Against a stand-in for Stripe only: this proves what MySenam asks
 * of the gateway, not that Stripe refunds it (a live check is still to be made, as for every refund).
 */

let venueId: number;
let dear: number;
let cheap: number;
let n = 0;
let failRefund = false;
const posted: { amount: number; key: string }[] = [];

function fakeStripe() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method ?? "GET";
      const form = init.body ? new URLSearchParams(init.body) : null;
      if (url.includes("/refunds?payment_intent=")) return Response.json({ object: "list", data: [] });
      if (url.endsWith("/refunds") && method === "POST") {
        if (failRefund) return Response.json({ error: { message: "declined" } }, { status: 400 });
        posted.push({ amount: Number(form?.get("amount")), key: form?.get("metadata[mysenam_key]") ?? "" });
        return Response.json({ id: `re_move_${++n}`, amount: Number(form?.get("amount")), status: "succeeded", metadata: {}, payment_intent: form?.get("payment_intent") ?? "" });
      }
      if (url.includes("/checkout/sessions?payment_intent=")) return Response.json({ object: "list", data: [{ id: new URL(url).searchParams.get("payment_intent")!.replace("pi_for_", "") }] });
      if (method === "POST") {
        const id = `cs_test_move${++n}`;
        return Response.json({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
      }
      const id = decodeURIComponent(url.split("/").pop()!);
      return Response.json({ id, payment_status: "paid", status: "complete", payment_intent: `pi_for_${id}` });
    })
  );
}

let slot = 0;
async function paid() {
  fakeStripe();
  const phone = `9125${String(++n).padStart(4, "0")}`;
  const date = addDays(todayISO(), 3 + Math.floor(slot / 8));
  const hour = 9 + (slot++ % 8);
  const made = await createBooking({ courtId: dear, date, hours: [hour], name: "Wei Ling", phone });
  if (!made.ok) throw new Error(made.error);
  const started = await startBookingPayment({ codes: [made.booking.code], phone });
  if (!started.ok) throw new Error("payment");
  const billId = started.url.split("/").pop()!;
  await settleBill({ billId, paid: true, paidAt: null });
  const payment = (await getDb().prepare("SELECT id FROM online_payments WHERE bill_id = ?").get(billId)) as { id: number };
  posted.length = 0;
  return { booking: made.booking, date, hour, paymentId: payment.id };
}
const money = async (id: number) => (await getDb().prepare("SELECT refund_due::float AS due, refunded::float AS refunded FROM online_payments WHERE id = ?").get(id)) as { due: number; refunded: number };

beforeAll(async () => {
  const made = await createVenue({ name: "Card Courts", area: "Bishan", address: "x", phone: "61230222" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const a = await createCourt({ venueId, name: "Dear", sport: "badminton", offPeakRate: 60, peakRate: 60 });
  const b = await createCourt({ venueId, name: "Cheap", sport: "badminton", offPeakRate: 25, peakRate: 25 });
  if (!a.ok || !b.ok) throw new Error("court");
  dear = a.court.id;
  cheap = b.court.id;
  const saved = await savePaymentSettings(venueId, { credentials: { secretKey: "rk_test_movecheaper123456", webhookSecret: "whsec_movecheaper1234567890" }, sandbox: true, enabled: true });
  if (!saved.ok) throw new Error(saved.error);
});
afterEach(() => {
  failRefund = false;
  vi.unstubAllGlobals();
});
afterAll(() => {
  delete process.env.MYSENAM_COUNTRY;
});

describe("a card payment through Stripe, moved to a cheaper time", () => {
  it("sends exactly the difference to Stripe once, and records it as refunded", async () => {
    const b = await paid();
    const moved = await rescheduleBooking(b.booking.code, { date: b.date, start: b.hour * 60, courtId: cheap }, "customer");
    expect(moved).toMatchObject({ ok: true, money: { settles: "refund", refund: { amount: 35, how: "online", sent: { how: "gateway" } } } });
    expect(posted).toHaveLength(1);
    expect(posted[0].amount).toBe(3500);
    expect(await money(b.paymentId)).toEqual({ due: 35, refunded: 35 });
    // The same request again changes nothing and asks Stripe for nothing.
    expect(await rescheduleBooking(b.booking.code, { date: b.date, start: b.hour * 60, courtId: cheap }, "customer")).toMatchObject({ ok: false, code: "RESCHEDULE_SAME" });
    expect(posted).toHaveLength(1);
  });

  it("a refund Stripe declines stays owed for staff, listed, never recorded as refunded", async () => {
    const b = await paid();
    failRefund = true;
    const moved = await rescheduleBooking(b.booking.code, { date: b.date, start: b.hour * 60, courtId: cheap }, "customer");
    expect(moved).toMatchObject({ ok: true, money: { refund: { amount: 35, how: "online" } } });
    expect(await money(b.paymentId)).toEqual({ due: 35, refunded: 0 });
    expect(moved.ok && moved.money.refund?.sent).toMatchObject({ how: "staff" });
  });
});
