import crypto from "crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.sg";
process.env.MYSENAM_COUNTRY = "SG";

const emails: { to: string; subject: string; text: string }[] = [];
vi.mock("../src/lib/outbox", async (original) => {
  const real = await original<typeof import("../src/lib/outbox")>();
  return {
    ...real,
    emailPlain: async (input: Parameters<typeof real.emailPlain>[0]) => {
      const queued = await real.emailPlain(input);
      emails.push({ to: input.to, subject: input.subject, text: input.text });
      return queued;
    },
  };
});

import { NextRequest } from "next/server";
import { listActivity } from "../src/lib/activity";
import { createAdmin } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { checkIntegrity } from "../src/lib/integrity";
import { markRefunded, reconcileRefunds, refundCancelled, refundOnline, refundsOwed, savePaymentSettings, settleBill, startBookingPayment } from "../src/lib/payments";
import { adminCancelBooking, createBooking, createCourt, createVenue, findBookingByCode as findBooking } from "../src/lib/store";
import { setCancelPolicy } from "../src/lib/cancel-policy";
import { addDays, todayISO } from "../src/lib/time";
import { POST as callback } from "../src/app/api/payments/[provider]/callback/route";

/**
 * A refund made in the venue's own Stripe dashboard (`charge.refunded`,
 * `charge.refund.updated`), which MySenam did not ask for: written down once,
 * never counted twice with a refund MySenam made (matched by its key or id),
 * matched to a refund marked by hand or to what was owed, and otherwise
 * raised to staff (email, activity log, integrity check) with no booking or
 * membership changed; counting towards what is owed later so Stripe is not
 * asked for the same money twice. Against a stand-in for Stripe only.
 */

const SECRET = "whsec_gatewayrefunds1234567890";
let venueId: number;
let courtId: number;
let n = 0;
let failListing = false;

/** Stripe's refunds, as it lists them; MySenam's carry their key in the metadata. */
const refunds: { id: string; amount: number; status: string; metadata: Record<string, string>; payment_intent: string }[] = [];
let asked: { url: string; method: string }[] = [];

function fakeStripe() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string; body?: string } = {}) => {
      const method = init.method ?? "GET";
      asked.push({ url, method });
      const form = init.body ? new URLSearchParams(init.body) : null;
      if (url.includes("/refunds?payment_intent=")) {
        if (failListing) return Response.json({ error: { message: "down" } }, { status: 500 });
        const pi = new URL(url).searchParams.get("payment_intent");
        return Response.json({ object: "list", data: refunds.filter((r) => r.payment_intent === pi) });
      }
      if (url.endsWith("/refunds") && method === "POST") {
        const r = {
          id: `re_app_${++n}`,
          amount: Number(form?.get("amount")),
          status: "succeeded",
          metadata: { mysenam_key: form?.get("metadata[mysenam_key]") ?? "" },
          payment_intent: form?.get("payment_intent") ?? "",
        };
        refunds.push(r);
        return Response.json(r);
      }
      if (url.includes("/checkout/sessions?payment_intent=")) {
        const pi = new URL(url).searchParams.get("payment_intent")!;
        return Response.json({ object: "list", data: [{ id: pi.replace("pi_for_", "") }] });
      }
      if (method === "POST") {
        const id = `cs_test_gwrefund${++n}`;
        return Response.json({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
      }
      const id = decodeURIComponent(url.split("/").pop()!);
      return Response.json({ id, payment_status: "paid", status: "complete", payment_intent: `pi_for_${id}` });
    })
  );
}

function signed(body: string, secret = SECRET) {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

/** Stripe telling of a refund on the payment: the charge refunded, or one of its refunds moving on. */
const tell = (billId: string, opts: { type?: string; secret?: string } = {}) => {
  const type = opts.type ?? "charge.refunded";
  const object = type === "charge.refunded" ? { id: `ch_${billId}`, object: "charge", payment_intent: `pi_for_${billId}` } : { id: `re_x${++n}`, object: "refund", payment_intent: `pi_for_${billId}` };
  const body = JSON.stringify({ type, created: Math.floor(Date.now() / 1000), data: { object } });
  return callback(
    new NextRequest("http://localhost/api/payments/stripe/callback", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signed(body, opts.secret) },
      body,
    }),
    { params: Promise.resolve({ provider: "stripe" }) }
  );
};

/** A refund made in the venue's Stripe dashboard: no key of MySenam's on it. */
const dashboardRefund = (billId: string, amount: number, status = "succeeded") => {
  const r = { id: `re_dash_${++n}`, amount: Math.round(amount * 100), status, metadata: {}, payment_intent: `pi_for_${billId}` };
  refunds.push(r);
  return r;
};

/** Each payment on a day of its own, within the booking window. */
let days = 0;
async function paid(hours: number[][] = [[10]]) {
  fakeStripe();
  const phone = `9124${String(++n).padStart(4, "0")}`;
  const date = addDays(todayISO(), 2 + ++days);
  const codes: string[] = [];
  for (const h of hours) {
    const made = await createBooking({ courtId, date, hours: h, name: "Wei Ling", phone });
    if (!made.ok) throw new Error(made.error);
    codes.push(made.booking.code);
  }
  const started = await startBookingPayment({ codes, phone });
  if (!started.ok) throw new Error("payment");
  const billId = started.url.split("/").pop()!;
  await settleBill({ billId, paid: true, paidAt: null });
  const payment = (await getDb().prepare("SELECT id FROM online_payments WHERE bill_id = ?").get(billId)) as { id: number };
  asked = [];
  emails.length = 0;
  return { codes, billId, paymentId: payment.id, phone };
}

const money = async (paymentId: number) =>
  (await getDb().prepare("SELECT refund_due::float AS due, refunded::float AS refunded FROM online_payments WHERE id = ?").get(paymentId)) as { due: number; refunded: number };
const seen = async (paymentId: number) =>
  (await getDb()
    .prepare("SELECT provider_refund_id, amount::float AS amount, matched_hand::float AS hand, matched_owed::float AS owed, unasked::float AS unasked, unasked_left::float AS left FROM gateway_refunds WHERE payment_id = ? ORDER BY id")
    .all(paymentId)) as { provider_refund_id: string; amount: number; hand: number; owed: number; unasked: number; left: number }[];
const askedToRefund = () => asked.filter((a) => a.method === "POST" && a.url.endsWith("/refunds"));

beforeAll(async () => {
  const made = await createVenue({ name: "Refund Courts", area: "Bishan", address: "x", phone: "61230111" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!court.ok) throw new Error("court");
  courtId = court.court.id;
  const saved = await savePaymentSettings(venueId, { credentials: { secretKey: "rk_test_gwrefundkey123456", webhookSecret: SECRET }, sandbox: true, enabled: true });
  if (!saved.ok) throw new Error(saved.error);
  await createAdmin({ name: "Mgr", email: "mgr@gwrefund.sg", password: "long enough password", venueId });
});

afterEach(() => {
  failListing = false;
  vi.unstubAllGlobals();
});
afterAll(() => {
  delete process.env.MYSENAM_COUNTRY;
});

describe("a refund made in Stripe's own dashboard", () => {
  it("that nothing here owed: written down once, told to staff and the log, raised by the integrity check; the booking unchanged", async () => {
    const { codes, billId, paymentId } = await paid();
    const r = dashboardRefund(billId, 20);
    expect((await tell(billId)).status).toBe(200);
    expect(await seen(paymentId)).toEqual([{ provider_refund_id: r.id, amount: 20, hand: 0, owed: 0, unasked: 20, left: 20 }]);
    // Nothing changed by itself: still booked, still paid, nothing counted as refunded.
    const booking = (await findBooking(codes[0]))!;
    expect(booking).toMatchObject({ status: "confirmed", paymentStatus: "paid" });
    expect(await money(paymentId)).toEqual({ due: 0, refunded: 0 });
    expect(emails.filter((e) => e.subject.includes("did not ask for"))).toHaveLength(1);
    expect(emails[0].text).toContain(codes[0]);
    const logged = (await listActivity([venueId])).filter((a) => a.action === "payment.gateway_refund");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ adminId: null, adminName: "Stripe", bookingCode: codes[0] });
    expect((await checkIntegrity([venueId])).filter((p) => p.kind === "refund_unasked").map((p) => p.detail)).toEqual([expect.stringContaining(r.id)]);
    // Reported again (and as the refund moving on): nothing new.
    await tell(billId);
    await tell(billId, { type: "charge.refund.updated" });
    expect(await seen(paymentId)).toHaveLength(1);
    expect(emails.filter((e) => e.subject.includes("did not ask for"))).toHaveLength(1);
    expect((await listActivity([venueId])).filter((a) => a.action === "payment.gateway_refund")).toHaveLength(1);
  });

  it("counts towards what is owed once the venue cancels: Stripe is not asked for the same money again, and only the rest is refunded", async () => {
    const { codes, billId, paymentId } = await paid([[9], [10]]);
    dashboardRefund(billId, 20);
    await tell(billId);
    expect((await seen(paymentId))[0]).toMatchObject({ unasked: 20, left: 20 });
    // One of the two bookings cancelled: the 20 Stripe already gave back is that refund.
    expect((await adminCancelBooking(codes[0])).ok).toBe(true);
    const first = await refundCancelled([(await findBooking(codes[0]))!.id], { byVenue: true });
    expect(first).toEqual([{ how: "gateway", amount: 20 }]);
    expect(askedToRefund()).toHaveLength(0);
    expect(await money(paymentId)).toEqual({ due: 20, refunded: 20 });
    expect((await seen(paymentId))[0]).toMatchObject({ left: 0 });
    expect((await checkIntegrity([venueId])).some((p) => p.kind === "refund_unasked" && p.detail.includes(billId))).toBe(false);
    // The other: nothing of the dashboard's left, so this one goes to Stripe, once.
    expect((await adminCancelBooking(codes[1])).ok).toBe(true);
    await setCancelPolicy(venueId, { onlineRefunds: "gateway" });
    await refundCancelled([(await findBooking(codes[1]))!.id], { byVenue: true });
    await setCancelPolicy(venueId, { onlineRefunds: "staff" });
    expect(askedToRefund()).toHaveLength(1);
    expect(await money(paymentId)).toEqual({ due: 40, refunded: 40 });
  });

  it("is not counted twice with a refund MySenam made: by its key, or by its id where it carries none", async () => {
    const { codes, billId, paymentId } = await paid();
    expect((await adminCancelBooking(codes[0])).ok).toBe(true);
    const payment = (await refundsOwed(venueId)).find((p) => p.billId === billId)!;
    expect((await refundOnline(payment.id, venueId)).ok).toBe(true);
    expect(await money(paymentId)).toEqual({ due: 20, refunded: 20 });
    // Stripe tells of it: it carries MySenam's key.
    await tell(billId);
    expect(await seen(paymentId)).toEqual([]);
    expect(await money(paymentId)).toEqual({ due: 20, refunded: 20 });
    // A refund MySenam recorded under its id before refunds carried a key: known by the id.
    const old = refunds.find((r) => r.payment_intent === `pi_for_${billId}`)!;
    old.metadata = {};
    await tell(billId);
    expect(await seen(paymentId)).toEqual([]);
    expect(emails.filter((e) => e.subject.includes("did not ask for"))).toHaveLength(0);
  });

  it("of what was owed back: recorded as that refund, so it is neither owed nor asked of Stripe again", async () => {
    const { codes, billId, paymentId } = await paid();
    expect((await adminCancelBooking(codes[0])).ok).toBe(true);
    expect(await money(paymentId)).toEqual({ due: 20, refunded: 0 });
    const r = dashboardRefund(billId, 20);
    await tell(billId);
    expect(await seen(paymentId)).toEqual([{ provider_refund_id: r.id, amount: 20, hand: 0, owed: 20, unasked: 0, left: 0 }]);
    expect(await money(paymentId)).toEqual({ due: 20, refunded: 20 });
    expect((await refundsOwed(venueId)).some((p) => p.billId === billId)).toBe(false);
    expect(await getDb().prepare("SELECT 1 FROM online_refunds WHERE provider_ref = ?").get(r.id)).toBeTruthy();
    expect(await markRefunded(paymentId, venueId)).toMatchObject({ ok: false });
    await reconcileRefunds();
    expect(askedToRefund()).toHaveLength(0);
    // Nothing unasked: no email, but on the log.
    expect(emails.filter((e) => e.subject.includes("did not ask for"))).toHaveLength(0);
    expect((await listActivity([venueId])).filter((a) => a.action === "payment.gateway_refund" && a.detail?.includes(r.id))).toHaveLength(1);
  });

  it("marked as made by hand first: the same money, tied to Stripe's id, not counted again", async () => {
    const { codes, billId, paymentId } = await paid();
    expect((await adminCancelBooking(codes[0])).ok).toBe(true);
    expect((await markRefunded(paymentId, venueId, null, "Refunded in Stripe")).ok).toBe(true);
    const r = dashboardRefund(billId, 20);
    await tell(billId);
    expect(await seen(paymentId)).toEqual([{ provider_refund_id: r.id, amount: 20, hand: 20, owed: 0, unasked: 0, left: 0 }]);
    expect(await money(paymentId)).toEqual({ due: 20, refunded: 20 });
    expect((await getDb().prepare("SELECT note FROM online_refunds WHERE provider_ref = ?").get(r.id)) as { note: string }).toEqual({ note: "Refunded in Stripe" });
    expect(emails.filter((e) => e.subject.includes("did not ask for"))).toHaveLength(0);
  });

  it("still pending is written down once it succeeds; one that failed is not money back", async () => {
    const { billId, paymentId } = await paid();
    const pending = dashboardRefund(billId, 5, "pending");
    dashboardRefund(billId, 7, "failed");
    await tell(billId);
    expect(await seen(paymentId)).toEqual([]);
    pending.status = "succeeded";
    await tell(billId, { type: "charge.refund.updated" });
    expect((await seen(paymentId)).map((s) => [s.provider_refund_id, s.unasked])).toEqual([[pending.id, 5]]);
  });

  it("is believed only under the venue's signing key, and asked again when Stripe cannot list the refunds", async () => {
    const { billId, paymentId } = await paid();
    dashboardRefund(billId, 20);
    expect((await tell(billId, { secret: "whsec_somebodyelse12345678" })).status).toBe(400);
    expect(await seen(paymentId)).toEqual([]);
    failListing = true;
    expect((await tell(billId)).status).toBe(503);
    expect(await seen(paymentId)).toEqual([]);
    failListing = false;
    expect((await tell(billId)).status).toBe(200);
    expect(await seen(paymentId)).toHaveLength(1);
  });

  it("is in the set-up the venue is told to make", async () => {
    const { stripe, HANDLED_EVENTS } = await import("../src/lib/gateways/stripe");
    expect(HANDLED_EVENTS).toEqual(expect.arrayContaining(["charge.refunded", "charge.refund.updated"]));
    for (const event of HANDLED_EVENTS) expect(stripe.setup).toContain(event);
  });
});
