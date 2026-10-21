import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.sg";
process.env.MYSENAM_COUNTRY = "SG";

import { getDb } from "../src/lib/db";
import { markRefunded, refundOnline, refundsOwed, savePaymentSettings, settleBill, startBookingPayment } from "../src/lib/payments";
import { adminCancelBooking, createBooking, createCourt, createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Money owed back on a Stripe payment goes back with one click, through the
 * venue's own Stripe account, once and only once. Billplz has no refund API:
 * there staff refund in its dashboard and mark it done, as before.
 */

const KEY = "rk_test_abcdefghijklmnop";
let venueId: number;
let courtId: number;
let n = 0;
let sent: { url: string; method: string; key: string | null; form: URLSearchParams | null }[] = [];

/** Stripe as far as these tests need it: sessions to pay, and refunds of them. */
function fakeStripe(refund: () => Response = () => Response.json({ id: `re_${++n}`, status: "succeeded" })) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
      sent.push({
        url,
        method: init.method ?? "GET",
        key: init.headers?.["Idempotency-Key"] ?? null,
        form: init.body ? new URLSearchParams(init.body) : null,
      });
      if (url.endsWith("/refunds")) return refund();
      if (init.method === "POST") {
        const id = `cs_test_refundable${++n}`;
        return Response.json({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
      }
      const id = decodeURIComponent(url.split("/").pop()!);
      return Response.json({ id, payment_status: "paid", status: "complete", payment_intent: `pi_for_${id}` });
    })
  );
}

/** A booking paid online through Stripe and then cancelled by the venue: owed back. */
async function owed(): Promise<{ id: number; billId: string }> {
  fakeStripe();
  const made = await createBooking({ courtId, date: addDays(todayISO(), 3), hours: [8 + (n % 10)], name: "Wei Ling", phone: `9123${String(++n).padStart(4, "0")}` });
  if (!made.ok) throw new Error(made.error);
  const started = await startBookingPayment({ codes: [made.booking.code], phone: made.booking.phone });
  if (!started.ok) throw new Error("payment");
  const billId = started.url.split("/").pop()!;
  await settleBill({ billId, paid: true, paidAt: null });
  await adminCancelBooking(made.booking.code);
  const payment = (await refundsOwed(venueId)).find((p) => p.billId === billId)!;
  sent = [];
  return { id: payment.id, billId };
}

beforeAll(async () => {
  const made = await createVenue({ name: "Bishan Courts", area: "Bishan", address: "x", phone: "61230000" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 18.5, peakRate: 18.5 });
  if (!court.ok) throw new Error("court");
  courtId = court.court.id;
  const saved = await savePaymentSettings(venueId, {
    credentials: { secretKey: KEY, webhookSecret: "whsec_testsecret1234567890" },
    sandbox: true,
    enabled: true,
  });
  if (!saved.ok) throw new Error(saved.error);
});

afterEach(() => {
  vi.unstubAllGlobals();
  sent = [];
});

afterAll(() => {
  delete process.env.MYSENAM_COUNTRY;
});

describe("refunding through Stripe", () => {
  it("is offered for a Stripe payment, and refunds what is owed in cents against its payment", async () => {
    const { id, billId } = await owed();
    const listed = (await refundsOwed(venueId)).find((p) => p.id === id)!;
    expect(listed).toMatchObject({ refundOwed: 18.5, refundsByApi: true, providerName: "Stripe" });

    fakeStripe();
    const done = await refundOnline(id, venueId);
    expect(done).toMatchObject({ ok: true, pending: false, payment: { refundOwed: 0, refunded: 18.5 } });
    const refund = sent.find((s) => s.url === "https://api.stripe.com/v1/refunds")!;
    expect(refund.form!.get("payment_intent")).toBe(`pi_for_${billId}`);
    expect(refund.form!.get("amount")).toBe("1850");
    expect(refund.key).toBe(`mysenam-refund-${id}-1850`);
    expect((await refundsOwed(venueId)).find((p) => p.id === id)).toBeUndefined();
    const rows = await getDb().prepare("SELECT amount::float AS amount, provider_ref FROM online_refunds WHERE payment_id = ?").all(id);
    expect(rows).toEqual([{ amount: 18.5, provider_ref: expect.stringMatching(/^re_/) }]);

    // Clicked again: nothing is owed, and Stripe is not asked.
    sent = [];
    expect(await refundOnline(id, venueId)).toMatchObject({ ok: false });
    expect(sent).toEqual([]);
  });

  it("counts a refund Stripe reports twice once", async () => {
    const { id } = await owed();
    // Stripe answers a retry under the same key with the refund it already made.
    fakeStripe(() => Response.json({ id: "re_same", status: "pending" }));
    const [a, b] = await Promise.all([refundOnline(id, venueId), refundOnline(id, venueId)]);
    expect([a.ok, b.ok]).toContain(true);
    const { total } = (await getDb()
      .prepare("SELECT SUM(amount)::float AS total FROM online_refunds WHERE payment_id = ?")
      .get(id)) as { total: number };
    expect(total).toBe(18.5);
    expect(a.ok && a.pending).toBe(true);
  });

  it("says what to do when the key cannot refund, and leaves it owed", async () => {
    const { id } = await owed();
    fakeStripe(() => Response.json({ error: { message: "The provided key does not have the required permissions" } }, { status: 403 }));
    const refused = await refundOnline(id, venueId);
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("set Refunds to Write") });
    expect((await refundsOwed(venueId)).find((p) => p.id === id)!.refundOwed).toBe(18.5);
    // Refunded in Stripe's dashboard instead, and marked so.
    expect(await markRefunded(id, venueId)).toMatchObject({ ok: true, payment: { refundOwed: 0 } });
  });

  it("is not another venue's to make", async () => {
    const { id } = await owed();
    const other = await createVenue({ name: "Other Courts", area: "x", address: "x", phone: "61230001" });
    if (!other.ok) throw new Error("venue");
    fakeStripe();
    expect(await refundOnline(id, other.venue.id)).toMatchObject({ ok: false });
    expect(sent).toEqual([]);
  });
});

describe("what is owed back", () => {
  it("includes fees and top-ups paid to the venue, not just bookings", async () => {
    const db = getDb();
    await db
      .prepare(
        `INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, status, payer_name, payer_phone, purpose, refund_due)
         VALUES ('stripe', 'cs_test_entryfee', 'https://x', ?, 30, 'paid', 'Hui Min', '91110000', 'entry', 30)`
      )
      .run(venueId);
    expect((await refundsOwed(venueId)).find((p) => p.billId === "cs_test_entryfee")).toMatchObject({ purpose: "entry", refundOwed: 30 });
  });

  it("is refunded by hand where the gateway has no refund API", async () => {
    const db = getDb();
    const { id } = (await db
      .prepare(
        `INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, status, payer_name, payer_phone, purpose, refund_due)
         VALUES ('billplz', 'bp_refundme', 'https://x', ?, 20, 'paid', 'Ali', '91110001', 'booking', 20) RETURNING id`
      )
      .get(venueId)) as { id: number };
    expect((await refundsOwed(venueId)).find((p) => p.id === id)).toMatchObject({ refundsByApi: false, providerName: "Billplz" });
    expect(await refundOnline(id, venueId)).toMatchObject({ ok: false, error: expect.stringContaining("its own dashboard") });
    expect(await markRefunded(id, venueId)).toMatchObject({ ok: true });
  });
});
