import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.sg";
process.env.MYSENAM_COUNTRY = "SG";

import { getDb } from "../src/lib/db";
import { markRefunded, refundOnline, refundsOwed, savePaymentSettings, settleBill, settleRefundClaims, startBookingPayment } from "../src/lib/payments";
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

/** Refunds the fake Stripe has made, as it lists them: with the metadata they were made with. */
let made: { id: string; status: string; metadata: Record<string, string>; payment_intent: string }[] = [];

/** Stripe as far as these tests need it: sessions to pay, refunds of them, and the refunds made so far. */
function fakeStripe(refund: () => Response = () => Response.json({ id: `re_${++n}`, status: "succeeded" })) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
      const form = init.body ? new URLSearchParams(init.body) : null;
      sent.push({ url, method: init.method ?? "GET", key: init.headers?.["Idempotency-Key"] ?? null, form });
      if (url.includes("/refunds?payment_intent=")) {
        const pi = new URL(url).searchParams.get("payment_intent");
        return Response.json({ object: "list", data: made.filter((r) => r.payment_intent === pi) });
      }
      if (url.endsWith("/refunds")) {
        const res = await refund();
        const body = (await res.clone().json().catch(() => null)) as { id?: string; status?: string } | null;
        if (res.ok && body?.id && !made.some((r) => r.id === body.id))
          made.push({
            id: body.id,
            status: body.status ?? "succeeded",
            metadata: { mysenam_key: form?.get("metadata[mysenam_key]") ?? "" },
            payment_intent: form?.get("payment_intent") ?? "",
          });
        return res;
      }
      if (url.includes("/refunds/")) {
        const found = made.find((r) => r.id === decodeURIComponent(url.split("/").pop()!));
        return found ? Response.json(found) : Response.json({ error: { message: "No such refund" } }, { status: 404 });
      }
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
  made = [];
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
    sent = [];
    const results = await Promise.all([refundOnline(id, venueId), refundOnline(id, venueId)]);
    // The claim is taken before Stripe is asked, so exactly one of the two goes
    // ahead — whichever got there first — and the other is told it is under way.
    const won = results.filter((r) => r.ok);
    const lost = results.filter((r) => !r.ok);
    expect(won).toHaveLength(1);
    expect(won[0]).toMatchObject({ pending: true });
    expect(lost).toEqual([expect.objectContaining({ ok: false, error: expect.stringMatching(/being refunded/) })]);
    // Stripe was asked once, and one refund is on the books, for what was owed.
    expect(sent.filter((r) => r.url === "https://api.stripe.com/v1/refunds")).toHaveLength(1);
    const rows = await getDb()
      .prepare("SELECT amount::float AS amount, provider_ref FROM online_refunds WHERE payment_id = ?")
      .all(id);
    expect(rows).toEqual([{ amount: 18.5, provider_ref: "re_same" }]);
  });

  it("cannot also be marked refunded by hand while the Stripe refund is on its way", async () => {
    const { id } = await owed();
    let byHand: Awaited<ReturnType<typeof markRefunded>> | undefined;
    // While Stripe is still answering, somebody at the desk marks it refunded.
    fakeStripe((async () => {
      byHand = await markRefunded(id, venueId);
      return Response.json({ id: "re_inflight", status: "succeeded" });
    }) as unknown as () => Response);
    const online = await refundOnline(id, venueId);
    expect(online, JSON.stringify(online)).toMatchObject({ ok: true });
    expect(byHand).toMatchObject({ ok: false });
    const rows = (await getDb().prepare("SELECT amount::float AS amount, provider_ref FROM online_refunds WHERE payment_id = ?").all(id)) as {
      amount: number;
      provider_ref: string | null;
    }[];
    expect(rows).toEqual([{ amount: 18.5, provider_ref: "re_inflight" }]);
  });

  it("asks Stripe again, under the same key, for a refund interrupted mid-call", async () => {
    const db = getDb();
    // The app stopped after claiming the refund and before Stripe answered.
    const claim = async (age: string) => {
      const { id } = await owed();
      const key = `mysenam-refund-${id}-1850`;
      await db.prepare("UPDATE online_payments SET refunded = refunded + 18.5 WHERE id = ?").run(id);
      await db
        .prepare("INSERT INTO online_refunds (payment_id, amount, provider_ref, pending, created_at) VALUES (?, 18.5, ?, 1, ?)")
        .run(id, `claim:${key}`, age);
      return { id, key };
    };
    const anHourAgo = new Date(Date.now() - 3_600_000).toISOString().replace("T", " ").slice(0, 19);
    const made = await claim(anHourAgo);
    expect((await refundsOwed(venueId)).find((p) => p.id === made.id)).toBeUndefined();

    fakeStripe(() => Response.json({ id: "re_after_restart", status: "succeeded" }));
    sent = [];
    expect(await settleRefundClaims()).toBe(1);
    expect(sent.filter((s) => s.url.endsWith("/refunds")).map((s) => s.key)).toEqual([made.key]);
    expect(await db.prepare("SELECT provider_ref, pending FROM online_refunds WHERE payment_id = ?").all(made.id)).toEqual([
      { provider_ref: "re_after_restart", pending: 0 },
    ]);

    // Refused when asked again: owed once more, and refundable by hand.
    const refused = await claim(anHourAgo);
    fakeStripe(() => Response.json({ error: { message: "No such payment_intent" } }, { status: 400 }));
    expect(await settleRefundClaims()).toBe(1);
    expect((await refundsOwed(venueId)).find((p) => p.id === refused.id)).toMatchObject({ refundOwed: 18.5 });
    expect(await db.prepare("SELECT 1 FROM online_refunds WHERE payment_id = ?").all(refused.id)).toEqual([]);

    // One still being asked about is left alone.
    const fresh = await claim(new Date().toISOString().replace("T", " ").slice(0, 19));
    sent = [];
    expect(await settleRefundClaims()).toBe(0);
    expect(sent).toEqual([]);
    expect((await refundsOwed(venueId)).find((p) => p.id === fresh.id)).toBeUndefined();
  });

  it("keeps the claim when Stripe gives no clear answer, and finishes it when asked again", async () => {
    const { id } = await owed();
    fakeStripe(() => Response.json({ error: { message: "Something went wrong on Stripe's end." } }, { status: 500 }));
    const unclear = await refundOnline(id, venueId);
    expect(unclear).toMatchObject({ ok: false, unknown: true });
    // Stripe may have made it: not owed, so not refundable by hand meanwhile.
    expect(await markRefunded(id, venueId)).toMatchObject({ ok: false });
    expect((await refundsOwed(venueId)).find((p) => p.id === id)).toBeUndefined();
    // Still unclear when asked again: kept for next time.
    await getDb().prepare("UPDATE online_refunds SET created_at = '2000-01-01 00:00:00' WHERE payment_id = ?").run(id);
    expect(await settleRefundClaims()).toBe(0);
    fakeStripe(() => Response.json({ id: "re_made_after_all", status: "succeeded" }));
    expect(await settleRefundClaims()).toBe(1);
    expect(await getDb().prepare("SELECT provider_ref FROM online_refunds WHERE payment_id = ?").all(id)).toEqual([{ provider_ref: "re_made_after_all" }]);
  });

  it("leaves it owed, and refundable by hand, when Stripe refuses", async () => {
    const { id } = await owed();
    fakeStripe(() => Response.json({ error: { message: "No such payment_intent" } }, { status: 400 }));
    expect(await refundOnline(id, venueId)).toMatchObject({ ok: false });
    expect((await refundsOwed(venueId)).find((p) => p.id === id)).toMatchObject({ refundOwed: 18.5 });
    expect(await markRefunded(id, venueId)).toMatchObject({ ok: true });
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
