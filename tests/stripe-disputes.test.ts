import crypto from "crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.sg";
process.env.MYSENAM_COUNTRY = "SG";

import { NextRequest } from "next/server";
import { createAdmin } from "../src/lib/admin-auth";
import { documentFor } from "../src/lib/documents";
import { disputesFor, savePaymentSettings, settleBill, startBookingPayment, startTopUpPayment } from "../src/lib/payments";
import { registerUser } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { createBooking, createCourt, createVenue, findBooking, getWalletBalance } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { POST as callback } from "../src/app/api/payments/[provider]/callback/route";

/**
 * A customer disputing a card payment with their bank: written down against
 * the payment, the venue told when to answer by, and if lost, the booking
 * unpaid again with its receipt credited.
 */

const SECRET = "whsec_disputesecret1234567890";
let venueId: number;
let courtId: number;
let n = 0;

function fakeStripe() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string } = {}) => {
      if (url.includes("/checkout/sessions?payment_intent=")) {
        const pi = new URL(url).searchParams.get("payment_intent")!;
        return Response.json({ object: "list", data: [{ id: pi.replace("pi_for_", "") }] });
      }
      if (init.method === "POST") {
        const id = `cs_test_disputed${++n}`;
        return Response.json({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
      }
      const id = decodeURIComponent(url.split("/").pop()!);
      return Response.json({ id, payment_status: "paid", status: "complete", payment_intent: `pi_for_${id}` });
    })
  );
}

function signed(body: string, secret = SECRET) {
  const at = Math.floor(Date.now() / 1000);
  return `t=${at},v1=${crypto.createHmac("sha256", secret).update(`${at}.${body}`).digest("hex")}`;
}

const send = (type: string, dispute: Record<string, unknown>, secret = SECRET) => {
  const body = JSON.stringify({ type, created: Math.floor(Date.now() / 1000), data: { object: { object: "dispute", ...dispute } } });
  return callback(
    new NextRequest("http://localhost/api/payments/stripe/callback", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signed(body, secret) },
      body,
    }),
    { params: Promise.resolve({ provider: "stripe" }) }
  );
};

async function paidBooking() {
  fakeStripe();
  const made = await createBooking({ courtId, date: addDays(todayISO(), 4), hours: [8 + (n % 10)], name: "Wei Ling", phone: `9123${String(++n).padStart(4, "0")}` });
  if (!made.ok) throw new Error(made.error);
  const started = await startBookingPayment({ codes: [made.booking.code], phone: made.booking.phone });
  if (!started.ok) throw new Error("payment");
  const billId = started.url.split("/").pop()!;
  await settleBill({ billId, paid: true, paidAt: null });
  return { booking: made.booking, billId };
}

beforeAll(async () => {
  const made = await createVenue({ name: "Dispute Courts", area: "Bishan", address: "x", phone: "61230099" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!court.ok) throw new Error("court");
  courtId = court.court.id;
  const saved = await savePaymentSettings(venueId, {
    credentials: { secretKey: "rk_test_disputekey123456", webhookSecret: SECRET },
    sandbox: true,
    enabled: true,
  });
  if (!saved.ok) throw new Error(saved.error);
  await createAdmin({ name: "Mgr", email: "mgr@dispute.sg", password: "long enough password", venueId });
});

afterEach(() => vi.unstubAllGlobals());
afterAll(() => {
  delete process.env.MYSENAM_COUNTRY;
});

describe("a chargeback", () => {
  it("is written down against the payment, with the date to answer by", async () => {
    const { booking, billId } = await paidBooking();
    const due = Math.floor(Date.now() / 1000) + 7 * 86400;
    const res = await send("charge.dispute.created", {
      id: "dp_1", payment_intent: `pi_for_${billId}`, amount: 2000, reason: "fraudulent", status: "needs_response",
      evidence_details: { due_by: due },
    });
    expect(res.status).toBe(200);
    const [d] = await disputesFor(venueId);
    expect(d).toMatchObject({ providerDisputeId: "dp_1", amount: 20, reason: "fraudulent", status: "needs_response", outcome: null, bookingCodes: [booking.code] });
    expect(d.dueBy!.slice(0, 10)).toBe(new Date(due * 1000).toISOString().slice(0, 10));
  });

  it("is told about once, however often Stripe repeats it", async () => {
    await send("charge.dispute.updated", { id: "dp_1", payment_intent: "pi_x", amount: 2000, reason: "fraudulent", status: "under_review" });
    expect(await disputesFor(venueId)).toHaveLength(1);
  });

  it("lost: the booking is unpaid again and its receipt credited", async () => {
    const { booking, billId } = await paidBooking();
    await send("charge.dispute.created", { id: "dp_2", payment_intent: `pi_for_${billId}`, amount: 2000, reason: "product_not_received", status: "needs_response" });
    await send("charge.dispute.closed", { id: "dp_2", payment_intent: `pi_for_${billId}`, amount: 2000, reason: "product_not_received", status: "lost" });
    const after = (await findBooking(booking.code, booking.phone))!;
    expect(after).toMatchObject({ paymentStatus: "unpaid", status: "confirmed" });
    expect(await documentFor(`booking:${booking.id}`)).toMatchObject({ kind: "credit_note", note: "receipt.why.disputed" });
    expect((await disputesFor(venueId)).find((d) => d.providerDisputeId === "dp_2")).toMatchObject({ outcome: "lost" });
  });

  it("lost on a top-up: the credit it bought goes, and nothing more is owed on it", async () => {
    fakeStripe();
    const user = await registerUser({ name: "Top Up", email: "topup@dispute.sg", phone: "91239999", password: "long enough password" });
    if (!user.ok) throw new Error(user.error);
    const started = await startTopUpPayment(user.user, venueId, 50);
    if (!started.ok) throw new Error("topup");
    const billId = started.url.split("/").pop()!;
    await settleBill({ billId, paid: true, paidAt: null });
    expect(await getWalletBalance(user.user.id, venueId)).toBe(50);
    await send("charge.dispute.created", { id: "dp_9", payment_intent: `pi_for_${billId}`, amount: 5000, reason: "fraudulent", status: "needs_response" });
    await send("charge.dispute.closed", { id: "dp_9", payment_intent: `pi_for_${billId}`, amount: 5000, reason: "fraudulent", status: "lost" });
    expect(await getWalletBalance(user.user.id, venueId)).toBe(0);
    const row = (await getDb().prepare("SELECT refund_due::float AS due, refunded::float AS refunded FROM online_payments WHERE bill_id = ?").get(billId)) as {
      due: number;
      refunded: number;
    };
    expect(row).toEqual({ due: 50, refunded: 50 });
  });

  it("won: nothing changes but the record", async () => {
    const { booking, billId } = await paidBooking();
    await send("charge.dispute.created", { id: "dp_3", payment_intent: `pi_for_${billId}`, amount: 2000, reason: "duplicate", status: "needs_response" });
    await send("charge.dispute.closed", { id: "dp_3", payment_intent: `pi_for_${billId}`, amount: 2000, reason: "duplicate", status: "won" });
    expect((await findBooking(booking.code, booking.phone))!.paymentStatus).toBe("paid");
    expect((await disputesFor(venueId)).find((d) => d.providerDisputeId === "dp_3")).toMatchObject({ outcome: "won" });
  });

  it("is refused when no venue's key signed it", async () => {
    const res = await send("charge.dispute.created", { id: "dp_4", payment_intent: "pi_for_x", amount: 1, reason: "general", status: "needs_response" }, "whsec_somebodyelse");
    expect(res.status).toBe(400);
  });
});

describe("the set-up a venue follows", () => {
  it("names every event the webhook handles, disputes included", async () => {
    const { stripe, HANDLED_EVENTS } = await import("../src/lib/gateways/stripe");
    expect(HANDLED_EVENTS).toEqual(expect.arrayContaining(["charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed"]));
    for (const event of HANDLED_EVENTS) expect(stripe.setup).toContain(event);
  });
});
