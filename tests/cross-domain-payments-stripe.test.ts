import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.sg";
process.env.MYSENAM_COUNTRY = "SG";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { createAdmin } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { holdNewBookings, releaseExpiredHolds } from "../src/lib/holds";
import { markRefunded, refundOnline, refundsOwed, savePaymentSettings, settleBill, startBookingPayment } from "../src/lib/payments";
import { createBooking, createCourt, createVenue, findBooking } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Cross-domain: a Stripe payment that arrives after the hold was let go (ADR 0065) is owed back, shows on the refunds worklist
 * (ADR 0066), and is settled through the gateway or by a hand mark exactly once however the two race. Against a stand-in for
 * Stripe only: this proves MySenam's claim-before-asking and idempotency, not that Stripe behaves so. A real Stripe test-mode
 * check stays INTEGRATION_VERIFICATION_REQUIRED. Meant for real Postgres too (TEST_DATABASE_URL).
 */

vi.setConfig({ testTimeout: 60_000 });

let venueId: number;
let managerId: number;
let courtId: number;
let n = 0;
let calls: { key: string; amount: number }[] = [];
const phone = () => `9133${String(++n).padStart(4, "0")}`;

/** Stripe's refunds by idempotency key: asked again under the same key, Stripe answers with the refund it already made. */
const refundsByKey = new Map<string, string>();
let refundSeq = 0;

function fakeStripe() {
  let sessions = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string; body?: string } = {}) => {
      if (url.includes("/refunds?payment_intent=")) return Response.json({ object: "list", data: [] });
      if (url.endsWith("/refunds")) {
        const form = new URLSearchParams(init.body ?? "");
        const key = form.get("metadata[mysenam_key]") ?? "";
        calls.push({ key, amount: Number(form.get("amount")) });
        if (!refundsByKey.has(key)) refundsByKey.set(key, `re_xds_${++refundSeq}`);
        return Response.json({ id: refundsByKey.get(key), status: "succeeded" });
      }
      if (init.method === "POST") {
        const id = `cs_test_xds${n}_${++sessions}`;
        return Response.json({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
      }
      const id = decodeURIComponent(url.split("/").pop()!);
      return Response.json({ id, payment_status: "paid", status: "complete", payment_intent: `pi_${id}` });
    })
  );
}

const payment = async (id: number) =>
  (await getDb().prepare("SELECT status, amount::float AS amount, refund_due::float AS due, refunded::float AS refunded, settlement_issue AS issue FROM online_payments WHERE id = ?").get(id)) as {
    status: string;
    amount: number;
    due: number;
    refunded: number;
    issue: string | null;
  };

/** A booking whose hold was let go, and whose payment then arrives. */
async function lateStripePayment(hour: number) {
  const ph = phone();
  const made = await createBooking({ courtId, date: addDays(todayISO(), 5), hours: [hour], name: "Wei Ling", phone: ph });
  if (!made.ok) throw new Error(JSON.stringify(made));
  await holdNewBookings([made.booking.id], 15);
  fakeStripe();
  const started = await startBookingPayment({ codes: [made.booking.code], phone: ph });
  if (!started.ok) throw new Error(JSON.stringify(started));
  const billId = started.url.split("/").pop()!;
  await getDb().prepare("UPDATE bookings SET hold_until = datetime('now', '-1 minutes') WHERE id = ?").run(made.booking.id);
  await releaseExpiredHolds();
  await settleBill({ billId, paid: true, paidAt: null });
  const row = (await getDb().prepare("SELECT id FROM online_payments WHERE bill_id = ?").get(billId)) as { id: number };
  return { booking: made.booking, phone: ph, paymentId: row.id, billId };
}

beforeAll(async () => {
  const made = await createVenue({ name: "Cross Stripe", area: "Bishan", address: "x", phone: "61230333" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!court.ok) throw new Error("court");
  courtId = court.court.id;
  const saved = await savePaymentSettings(venueId, { credentials: { secretKey: "rk_test_xdcrossstripe123456", webhookSecret: "whsec_xdcross1234567890" }, sandbox: true, enabled: true });
  if (!saved.ok) throw new Error(saved.error);
  const admin = await createAdmin({ name: "Mgr", email: "mgr@xdstripe.sg", password: "long enough password", venueId });
  if (!admin.ok) throw new Error("admin");
  managerId = admin.admin.id;
});

afterEach(() => {
  calls = [];
  vi.unstubAllGlobals();
});
afterAll(() => {
  delete process.env.MYSENAM_COUNTRY;
});

describe("a late Stripe payment, the worklist and the settling (BILL late path, ADR 0066 worklist)", () => {
  it("is owed back whole, listed as owed and not as refunded, and the booking stays cancelled and unpaid", async () => {
    const late = await lateStripePayment(9);
    expect(await payment(late.paymentId)).toMatchObject({ status: "paid", amount: 20, due: 20, refunded: 0, issue: "hold_lapsed" });
    expect(await findBooking(late.booking.code, late.phone)).toMatchObject({ status: "cancelled", paymentStatus: "unpaid" });
    expect((await refundsOwed(venueId)).find((p) => p.id === late.paymentId)).toMatchObject({ refundOwed: 20, refunded: 0 });
    expect(calls).toHaveLength(0);
  });

  it("one click refunds it through the gateway once; asking again, or marking it by hand, finds nothing owed", async () => {
    const late = await lateStripePayment(10);
    expect(await refundOnline(late.paymentId, venueId, managerId)).toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].amount).toBe(2000);
    expect(await payment(late.paymentId)).toMatchObject({ due: 20, refunded: 20 });
    expect((await refundsOwed(venueId)).some((p) => p.id === late.paymentId)).toBe(false);
    expect(await refundOnline(late.paymentId, venueId, managerId)).toMatchObject({ ok: false });
    expect(await markRefunded(late.paymentId, venueId, managerId, "dashboard")).toMatchObject({ ok: false });
    expect(calls).toHaveLength(1);
  });

  it("three clicks and a hand mark at once refund it once: never 40 of a 20 payment, the gateway asked at most once", async () => {
    const late = await lateStripePayment(11);
    await Promise.all([refundOnline(late.paymentId, venueId, managerId), refundOnline(late.paymentId, venueId, managerId), refundOnline(late.paymentId, venueId, managerId), markRefunded(late.paymentId, venueId, managerId, "dashboard")]);
    const p = await payment(late.paymentId);
    expect(p.refunded).toBe(20);
    expect(p.due).toBe(20);
    // However the four met, the books hold one refund of 20; and when the gateway was asked it was asked under the one idempotency
    // key, so Stripe could only ever have made one refund.
    const rows = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM online_refunds WHERE payment_id = ?").get(late.paymentId)) as { n: number };
    expect(rows.n).toBe(1);
    expect(new Set(calls.map((c) => c.key)).size).toBeLessThanOrEqual(1);
    expect((await refundsOwed(venueId)).some((x) => x.id === late.paymentId)).toBe(false);
  });

  it("another venue's manager cannot settle it", async () => {
    const late = await lateStripePayment(12);
    const other = await createVenue({ name: "Elsewhere Courts", area: "Toa Payoh", address: "y", phone: "61230334" });
    if (!other.ok) throw new Error("venue");
    expect(await refundOnline(late.paymentId, other.venue.id, managerId)).toMatchObject({ ok: false });
    expect(await markRefunded(late.paymentId, other.venue.id, managerId, "no")).toMatchObject({ ok: false });
    expect(await payment(late.paymentId)).toMatchObject({ due: 20, refunded: 0 });
    expect(calls).toHaveLength(0);
  });
});
