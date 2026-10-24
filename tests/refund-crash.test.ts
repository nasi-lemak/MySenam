import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.sg";
process.env.MYSENAM_COUNTRY = "SG";

import { getDb } from "../src/lib/db";
import { checkIntegrity } from "../src/lib/integrity";
import {
  refundOnline,
  refundsInFlight,
  refundsOwed,
  savePaymentSettings,
  settleBill,
  settleOwedRefunds,
  settlePendingRefunds,
  settleRefundClaims,
  startBookingPayment,
} from "../src/lib/payments";
import { adminCancelBooking, createBooking, createCourt, createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * A refund through a gateway cannot be part of a database transaction, so it
 * goes in steps, each written down before the next (known limitations M15):
 *
 *   owed       — written with the cancellation, in its transaction;
 *   claimed    — an `online_refunds` row under `claim:<key>`, before the gateway is asked;
 *   accepted   — the claim becomes the gateway's refund id (pending while it goes through);
 *   outcome    — made (pending 0), or failed (owed again, `failed_at` kept as the record).
 *
 * These tests stop the app, or lose an answer, between each step, and show
 * the money goes back exactly once. The Stripe here keeps an idempotency key
 * for a day, as the real one does, and can be made to forget it, as the real
 * one does after a day.
 */

const KEY = "rk_test_abcdefghijklmnop";
let venueId: number;
let courtId: number;
let n = 0;
let day = 0;

interface FakeRefund {
  id: string;
  status: "pending" | "succeeded" | "failed";
  amount: number;
  payment_intent: string;
  metadata: Record<string, string>;
}

/** What the fake Stripe holds, and how it misbehaves. */
const stripe = {
  refunds: [] as FakeRefund[],
  keys: new Map<string, FakeRefund>(),
  /** Make the refund, then lose the answer on the way back. */
  dropAnswer: false,
  /** New refunds start pending rather than made. */
  startPending: false,
  /** Called while a refund request is being handled. */
  during: null as null | (() => Promise<void>),
  posts: 0,
  reset() {
    this.refunds = [];
    this.keys.clear();
    this.dropAnswer = false;
    this.startPending = false;
    this.during = null;
    this.posts = 0;
  },
  /** A day later: Stripe no longer remembers idempotency keys. */
  forgetKeys() {
    this.keys.clear();
  },
};

function fakeStripe() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
      const method = init.method ?? "GET";
      if (url.includes("/refunds?payment_intent=")) {
        const pi = new URL(url).searchParams.get("payment_intent");
        return Response.json({ object: "list", data: stripe.refunds.filter((r) => r.payment_intent === pi) });
      }
      if (url.endsWith("/refunds") && method === "POST") {
        stripe.posts++;
        if (stripe.during) await stripe.during();
        const form = new URLSearchParams(init.body);
        const key = init.headers?.["Idempotency-Key"] ?? "";
        let refund = stripe.keys.get(key);
        if (!refund) {
          refund = {
            id: `re_${++n}`,
            status: stripe.startPending ? "pending" : "succeeded",
            amount: Number(form.get("amount")),
            payment_intent: form.get("payment_intent") ?? "",
            metadata: { mysenam_key: form.get("metadata[mysenam_key]") ?? "" },
          };
          stripe.refunds.push(refund);
          stripe.keys.set(key, refund);
        }
        if (stripe.dropAnswer) throw new TypeError("fetch failed: socket hang up");
        return Response.json(refund);
      }
      if (url.includes("/refunds/")) {
        const found = stripe.refunds.find((r) => r.id === decodeURIComponent(url.split("/").pop()!));
        return found ? Response.json(found) : Response.json({ error: { message: "No such refund" } }, { status: 404 });
      }
      if (method === "POST") {
        const id = `cs_test_crash${++n}`;
        return Response.json({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
      }
      const id = decodeURIComponent(url.split("/").pop()!);
      return Response.json({ id, payment_status: "paid", status: "complete", payment_intent: `pi_for_${id}` });
    })
  );
}

const db = () => getDb();
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString().replace("T", " ").slice(0, 19);

/** A booking paid online through Stripe and cancelled by the venue, the refund not yet asked for: owed. */
async function owed(): Promise<{ id: number; billId: string }> {
  const made = await createBooking({ courtId, date: addDays(todayISO(), 2 + (day++ % 10)), hours: [10], name: "Crash Test", phone: `9345${String(++n).padStart(4, "0")}` });
  if (!made.ok) throw new Error(made.error);
  const started = await startBookingPayment({ codes: [made.booking.code], phone: made.booking.phone });
  if (!started.ok) throw new Error("payment");
  const billId = started.url.split("/").pop()!;
  await settleBill({ billId, paid: true, paidAt: null });
  // The cancellation commits; the app stops before asking Stripe (the route would call refundCancelled next).
  await adminCancelBooking(made.booking.code);
  const payment = (await refundsOwed(venueId)).find((p) => p.billId === billId)!;
  return { id: payment.id, billId };
}

const refundRows = async (paymentId: number) =>
  (await db()
    .prepare("SELECT provider_ref, pending, failed_at IS NOT NULL AS failed, amount::float AS amount FROM online_refunds WHERE payment_id = ? ORDER BY id")
    .all(paymentId)) as { provider_ref: string; pending: number; failed: boolean; amount: number }[];
const refunded = async (paymentId: number) =>
  ((await db().prepare("SELECT refunded::float AS r, refund_due::float AS d FROM online_payments WHERE id = ?").get(paymentId)) as { r: number; d: number });

beforeAll(async () => {
  const made = await createVenue({ name: "Crash Courts", area: "Bishan", address: "x", phone: "61239999" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!court.ok) throw new Error("court");
  courtId = court.court.id;
  const saved = await savePaymentSettings(venueId, { credentials: { secretKey: KEY, webhookSecret: "whsec_testsecret1234567890" }, sandbox: true, enabled: true });
  if (!saved.ok) throw new Error(saved.error);
  fakeStripe();
});

afterEach(async () => {
  stripe.reset();
  fakeStripe();
  // Each test's payments are its own: what one leaves owed is settled, so the next test's sweep does not find it.
  await db().prepare("UPDATE online_payments SET refund_due = refunded WHERE refund_due > refunded").run();
});

describe("the app stops before the gateway is asked", () => {
  it("with the claim written: asked once by the scheduler, under the claim's key", async () => {
    const { id } = await owed();
    const key = `mysenam-refund-${id}-2000`;
    // What refundOnline writes before asking, and nothing after: the process died here.
    await db().prepare("UPDATE online_payments SET refunded = refunded + 20 WHERE id = ?").run(id);
    await db().prepare("INSERT INTO online_refunds (payment_id, amount, provider_ref, pending, created_at) VALUES (?, 20, ?, 1, ?)").run(id, `claim:${key}`, ago(30));
    expect((await refundsInFlight(venueId)).find((r) => r.paymentId === id)).toMatchObject({ state: "asked" });

    expect(await settleRefundClaims()).toBe(1);
    expect(stripe.refunds).toHaveLength(1);
    expect(stripe.refunds[0]).toMatchObject({ amount: 2000, metadata: { mysenam_key: key } });
    expect(await refundRows(id)).toEqual([{ provider_ref: stripe.refunds[0].id, pending: 0, failed: false, amount: 20 }]);
    expect(await refunded(id)).toEqual({ r: 20, d: 20 });
    // Run again, by the next tick: nothing left to do.
    expect(await settleRefundClaims()).toBe(0);
    expect(stripe.posts).toBe(1);
  });

  it("before even the claim, after the cancellation committed: the sweep asks, once, where the venue refunds by itself", async () => {
    await db().prepare("UPDATE venues SET online_refunds = 'gateway' WHERE id = ?").run(venueId);
    try {
      const { id } = await owed();
      // First sight is only noted: the request that cancelled may still be asking.
      expect(await settleOwedRefunds()).toBe(0);
      expect(stripe.posts).toBe(0);
      await db().prepare("UPDATE online_payments SET refund_seen_at = ? WHERE id = ?").run(ago(11), id);
      expect(await settleOwedRefunds()).toBe(1);
      expect(stripe.refunds).toHaveLength(1);
      expect(await refunded(id)).toEqual({ r: 20, d: 20 });
      // Again, and again: nothing more is sent.
      expect(await settleOwedRefunds()).toBe(0);
      expect(await settleRefundClaims()).toBe(0);
      expect(stripe.posts).toBe(1);
    } finally {
      await db().prepare("UPDATE venues SET online_refunds = 'staff' WHERE id = ?").run(venueId);
    }
  });

  it("leaves alone what a venue refunds by hand, what is disputed, and what a refusal left owed today", async () => {
    await db().prepare("UPDATE venues SET online_refunds = 'gateway' WHERE id = ?").run(venueId);
    try {
      const disputed = await owed();
      await db()
        .prepare("INSERT INTO payment_disputes (payment_id, provider_dispute_id, amount, reason, status) VALUES (?, 'dp_crash', 20, 'fraudulent', 'needs_response')")
        .run(disputed.id);
      const tried = await owed();
      await db().prepare("UPDATE online_payments SET auto_refund_tried_at = datetime('now') WHERE id = ?").run(tried.id);
      await db().prepare("UPDATE online_payments SET refund_seen_at = ? WHERE id IN (?, ?)").run(ago(30), disputed.id, tried.id);
      expect(await settleOwedRefunds()).toBe(0);
      expect(stripe.posts).toBe(0);
    } finally {
      await db().prepare("UPDATE venues SET online_refunds = 'staff' WHERE id = ?").run(venueId);
    }
    // At a venue whose staff refund by hand, nothing is sent at all.
    const byHand = await owed();
    await db().prepare("UPDATE online_payments SET refund_seen_at = ? WHERE id = ?").run(ago(30), byHand.id);
    expect(await settleOwedRefunds()).toBe(0);
    expect(stripe.posts).toBe(0);
  });
});

describe("the gateway accepted, and the answer was lost", () => {
  it("is found under its key, even a day later when Stripe has forgotten the key, and recorded once", async () => {
    const { id } = await owed();
    stripe.dropAnswer = true;
    const lost = await refundOnline(id, venueId);
    expect(lost).toMatchObject({ ok: false, unknown: true });
    // Stripe made it; we do not know. It is not owed (so nobody refunds it by hand), and not yet recorded as made.
    expect(stripe.refunds).toHaveLength(1);
    expect((await refundsOwed(venueId)).find((p) => p.id === id)).toBeUndefined();
    expect((await refundRows(id))[0].provider_ref).toMatch(/^claim:/);

    stripe.dropAnswer = false;
    stripe.forgetKeys();
    await db().prepare("UPDATE online_refunds SET created_at = ? WHERE payment_id = ?").run(ago(24 * 60 + 5), id);
    expect(await settleRefundClaims()).toBe(1);
    // Found, not made again.
    expect(stripe.refunds).toHaveLength(1);
    expect(stripe.posts).toBe(1);
    expect(await refundRows(id)).toEqual([{ provider_ref: stripe.refunds[0].id, pending: 0, failed: false, amount: 20 }]);
    expect(await refunded(id)).toEqual({ r: 20, d: 20 });
  });

  it("when the database fails writing the answer down: the claim stays, and the next run records it once", async () => {
    const { id } = await owed();
    await db().exec(`
      CREATE OR REPLACE FUNCTION refuse_refund_record() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.provider_ref LIKE 'claim:%' AND NEW.provider_ref NOT LIKE 'claim:%' THEN RAISE EXCEPTION 'injected failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER refuse_refund_record BEFORE UPDATE ON online_refunds FOR EACH ROW EXECUTE FUNCTION refuse_refund_record();
    `);
    try {
      await expect(refundOnline(id, venueId)).rejects.toThrow("injected failure");
    } finally {
      await db().exec("DROP TRIGGER refuse_refund_record ON online_refunds; DROP FUNCTION refuse_refund_record();");
    }
    expect(stripe.refunds).toHaveLength(1);
    expect((await refundRows(id))[0].provider_ref).toMatch(/^claim:/);
    await db().prepare("UPDATE online_refunds SET created_at = ? WHERE payment_id = ?").run(ago(30), id);
    expect(await settleRefundClaims()).toBe(1);
    expect(stripe.refunds).toHaveLength(1);
    expect(await refundRows(id)).toEqual([{ provider_ref: stripe.refunds[0].id, pending: 0, failed: false, amount: 20 }]);
    expect(await refunded(id)).toEqual({ r: 20, d: 20 });
  });
});

describe("during reconciliation", () => {
  it("two runs at once, and a run that dies part-way, still make and record it once", async () => {
    const a = await owed();
    const b = await owed();
    for (const p of [a, b]) {
      await db().prepare("UPDATE online_payments SET refunded = refunded + 20 WHERE id = ?").run(p.id);
      await db()
        .prepare("INSERT INTO online_refunds (payment_id, amount, provider_ref, pending, created_at) VALUES (?, 20, ?, 1, ?)")
        .run(p.id, `claim:mysenam-refund-${p.id}-2000`, ago(30));
    }
    // The first run dies after Stripe made the first refund (the answer never gets back).
    stripe.dropAnswer = true;
    await settleRefundClaims();
    stripe.dropAnswer = false;
    expect(stripe.refunds).toHaveLength(2);
    // Then two runs at once (a second instance, a slow tick).
    await Promise.all([settleRefundClaims(), settleRefundClaims()]);
    expect(stripe.refunds).toHaveLength(2);
    for (const p of [a, b]) {
      const rows = await refundRows(p.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].provider_ref).toMatch(/^re_/);
      expect(await refunded(p.id)).toEqual({ r: 20, d: 20 });
    }
  });
});

describe("what happens after the gateway accepts", () => {
  it("made later: no longer on its way", async () => {
    const { id } = await owed();
    stripe.startPending = true;
    expect(await refundOnline(id, venueId)).toMatchObject({ ok: true, pending: true });
    expect((await refundsInFlight(venueId)).find((r) => r.paymentId === id)).toMatchObject({ state: "processing" });
    stripe.refunds[0].status = "succeeded";
    expect(await settlePendingRefunds()).toBe(1);
    expect(await refundRows(id)).toEqual([expect.objectContaining({ pending: 0, failed: false })]);
    expect((await refundsInFlight(venueId)).find((r) => r.paymentId === id)).toBeUndefined();
  });

  it("failed later: owed again, shown and raised, not resent by itself; asked again, it is a new refund", async () => {
    await db().prepare("UPDATE venues SET online_refunds = 'gateway' WHERE id = ?").run(venueId);
    try {
      const { id, billId } = await owed();
      stripe.startPending = true;
      expect(await refundOnline(id, venueId)).toMatchObject({ ok: true, pending: true });
      stripe.refunds[0].status = "failed";
      expect(await settlePendingRefunds()).toBe(1);
      expect(await refunded(id)).toEqual({ r: 0, d: 20 });
      expect(await refundRows(id)).toEqual([expect.objectContaining({ failed: true, pending: 0 })]);
      expect((await refundsInFlight(venueId)).find((r) => r.paymentId === id)).toMatchObject({ state: "failed" });
      expect((await checkIntegrity()).filter((p) => p.kind === "refund_failed").map((p) => p.detail).join()).toContain(billId);
      // The sweep does not ask again: the same card would refuse it.
      await db().prepare("UPDATE online_payments SET refund_seen_at = ? WHERE id = ?").run(ago(30), id);
      expect(await settleOwedRefunds()).toBe(0);
      expect(stripe.posts).toBe(1);
      // Staff ask again: a new key, so Stripe makes a new one rather than handing back the failed one.
      stripe.startPending = false;
      expect(await refundOnline(id, venueId)).toMatchObject({ ok: true, pending: false });
      expect(stripe.refunds).toHaveLength(2);
      expect(stripe.refunds[1].metadata.mysenam_key).toBe(`mysenam-refund-${id}-2000-r1`);
      expect(await refunded(id)).toEqual({ r: 20, d: 20 });
    } finally {
      await db().prepare("UPDATE venues SET online_refunds = 'staff' WHERE id = ?").run(venueId);
    }
  });
});

describe("no transaction waits on the gateway", () => {
  it.skipIf(!process.env.TEST_DATABASE_URL)("nothing is idle in a transaction while Stripe is being asked", async () => {
    const { id } = await owed();
    const watcher = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await watcher.connect();
    let open = -1;
    try {
      stripe.during = async () => {
        const r = await watcher.query("SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'");
        open = r.rows[0].n;
      };
      expect(await refundOnline(id, venueId)).toMatchObject({ ok: true });
    } finally {
      await watcher.end();
    }
    expect(open).toBe(0);
  });
});
