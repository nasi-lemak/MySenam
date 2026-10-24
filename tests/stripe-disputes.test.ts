import crypto from "crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.sg";
process.env.MYSENAM_COUNTRY = "SG";

const emails: { to: string; subject: string; text: string }[] = [];
// Emails to staff, applicants and account holders are queued (lib/outbox.ts, emailPlain); each one queued is also noted here.
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
import { createAdmin } from "../src/lib/admin-auth";
import { documentFor } from "../src/lib/documents";
import { disputesFor, savePaymentSettings, settleBill, startBookingPayment, startTopUpPayment } from "../src/lib/payments";
import { registerUser } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { cancelBooking, createBooking, createCourt, createVenue, findBooking, getWalletBalance, setPaymentStatus } from "../src/lib/store";
import { setHoldPolicy } from "../src/lib/holds";
import { salesJournal } from "../src/lib/accounting";
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
// Payment pages have their own count, so each paid booking below takes the next free hour.
let pages = 0;

function fakeStripe() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string } = {}) => {
      if (url.includes("/checkout/sessions?payment_intent=")) {
        const pi = new URL(url).searchParams.get("payment_intent")!;
        return Response.json({ object: "list", data: [{ id: pi.replace("pi_for_", "") }] });
      }
      if (init.method === "POST") {
        const id = `cs_test_disputed${++pages}`;
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

const paymentId = async (billId: string) =>
  ((await getDb().prepare("SELECT id FROM online_payments WHERE bill_id = ?").get(billId)) as { id: number }).id;
const creditNoteFor = async (number: string) => {
  const row = (await getDb().prepare("SELECT source FROM receipts WHERE kind = 'credit_note' AND credits_ref = ?").get(number)) as
    | { source: string }
    | undefined;
  return row ? documentFor(row.source) : null;
};

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
    // Its receipt is kept as a document of its own, and that is what is credited.
    const receipt = (await documentFor(`booking-paid:${booking.id}:${await paymentId(billId)}`))!;
    expect(receipt).toMatchObject({ kind: "receipt", total: 20 });
    expect(await creditNoteFor(receipt.number)).toMatchObject({ kind: "credit_note", note: "receipt.why.disputed", total: 20 });
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

  it("lost long after it was paid: the sale stays in its own period, the credit note in this one", async () => {
    const { booking, billId } = await paidBooking();
    const then = addDays(todayISO(), -40);
    await getDb().prepare("UPDATE bookings SET paid_at = ? WHERE id = ?").run(`${then}T04:00:00.000Z`, booking.id);
    const net = async (day: string) => (await salesJournal(venueId, day, day)).reduce((sum, r) => sum + r.gross, 0);
    expect(await net(then)).toBe(20);
    const today = await net(todayISO());
    await send("charge.dispute.closed", { id: "dp_6", payment_intent: `pi_for_${billId}`, amount: 2000, reason: "fraudulent", status: "lost" });
    expect(await net(then)).toBe(20);
    expect((await salesJournal(venueId, then, then)).map((r) => r.category)).toEqual(["Court hire"]);
    expect((await net(todayISO())) - today).toBe(-20);
  });

  it("lost on a deposit: the deposit no longer counts, so the whole price is due", async () => {
    fakeStripe();
    expect((await setHoldPolicy(venueId, { on: true, depositPercent: 30 })).ok).toBe(true);
    try {
      const made = await createBooking({ courtId, date: addDays(todayISO(), 5), hours: [9], name: "Deposit Payer", phone: "91238001" });
      if (!made.ok) throw new Error(made.error);
      const started = await startBookingPayment({ codes: [made.booking.code], phone: made.booking.phone, deposit: true });
      if (!started.ok) throw new Error("payment");
      const billId = started.url.split("/").pop()!;
      await settleBill({ billId, paid: true, paidAt: null });
      const owed = async () =>
        (await getDb()
          .prepare("SELECT (total_price - shares_paid)::float AS due, deposit_paid::float AS deposit FROM bookings WHERE id = ?")
          .get(made.booking.id)) as { due: number; deposit: number };
      expect(await owed()).toEqual({ due: 14, deposit: 6 });
      // The deposit is sold as part of the court hire it holds.
      const deposit = (await salesJournal(venueId, todayISO(), todayISO())).find((r) => r.gross === 6);
      expect(deposit?.category).toBe("Court hire");
      await send("charge.dispute.closed", { id: "dp_7", payment_intent: `pi_for_${billId}`, amount: 600, reason: "fraudulent", status: "lost" });
      expect(await owed()).toEqual({ due: 20, deposit: 0 });
      const receipt = (await documentFor(`payment:${await paymentId(billId)}`))!;
      expect(await creditNoteFor(receipt.number)).toMatchObject({ total: 6, note: "receipt.why.disputed" });
    } finally {
      await setHoldPolicy(venueId, { on: false });
    }
  });

  it("lost on a deposit after the rest was paid at the counter: the cash stands, the deposit is owed again", async () => {
    fakeStripe();
    expect((await setHoldPolicy(venueId, { on: true, depositPercent: 30 })).ok).toBe(true);
    try {
      const made = await createBooking({ courtId, date: addDays(todayISO(), 6), hours: [9], name: "Counter Payer", phone: "91238003" });
      if (!made.ok) throw new Error(made.error);
      const started = await startBookingPayment({ codes: [made.booking.code], phone: made.booking.phone, deposit: true });
      if (!started.ok) throw new Error("payment");
      const billId = started.url.split("/").pop()!;
      await settleBill({ billId, paid: true, paidAt: null });
      expect((await setPaymentStatus(made.booking.code, true, "cash")).ok).toBe(true);
      const net = async () => (await salesJournal(venueId, todayISO(), todayISO())).reduce((sum, r) => sum + r.gross, 0);
      const before = await net();

      await send("charge.dispute.closed", { id: "dp_12", payment_intent: `pi_for_${billId}`, amount: 600, reason: "fraudulent", status: "lost" });
      const after = (await findBooking(made.booking.code, made.booking.phone))!;
      expect(after.paymentStatus).toBe("unpaid");
      const due = (await getDb().prepare("SELECT (total_price - shares_paid)::float AS due FROM bookings WHERE id = ?").get(made.booking.id)) as {
        due: number;
      };
      expect(due.due).toBe(6);
      // The cash taken at the counter keeps its receipt; the deposit's is credited.
      const cash = (await documentFor(`booking-paid:${made.booking.id}:${await paymentId(billId)}`))!;
      expect(cash).toMatchObject({ total: 14, paidVia: expect.stringMatching(/cash/i) });
      const deposit = (await documentFor(`payment:${await paymentId(billId)}`))!;
      expect(await creditNoteFor(deposit.number)).toMatchObject({ total: 6, note: "receipt.why.disputed" });
      expect((await net()) - before).toBe(-6);

      // Collected again at the counter: a receipt for what was owed, and the books whole.
      expect((await setPaymentStatus(made.booking.code, true, "cash")).ok).toBe(true);
      expect((await net()) - before).toBe(0);
    } finally {
      await setHoldPolicy(venueId, { on: false });
    }
  });

  it("lost on a deposit after the rest was paid online: the rest stands and is still owed back if called off; the deposit is owed again", async () => {
    fakeStripe();
    expect((await setHoldPolicy(venueId, { on: true, depositPercent: 30 })).ok).toBe(true);
    try {
      const made = await createBooking({ courtId, date: addDays(todayISO(), 7), hours: [9], name: "Online Payer", phone: "91238005" });
      if (!made.ok) throw new Error(made.error);
      const deposit = await startBookingPayment({ codes: [made.booking.code], phone: made.booking.phone, deposit: true });
      if (!deposit.ok) throw new Error("deposit");
      const depositBill = deposit.url.split("/").pop()!;
      await settleBill({ billId: depositBill, paid: true, paidAt: null });
      const rest = await startBookingPayment({ codes: [made.booking.code], phone: made.booking.phone });
      if (!rest.ok) throw new Error("rest");
      const restBill = rest.url.split("/").pop()!;
      await settleBill({ billId: restBill, paid: true, paidAt: null });
      expect((await findBooking(made.booking.code, made.booking.phone))!.paymentStatus).toBe("paid");

      await send("charge.dispute.closed", { id: "dp_14", payment_intent: `pi_for_${depositBill}`, amount: 600, reason: "fraudulent", status: "lost" });
      // Before, the booking still read as paid in full; now the deposit's part is owed again.
      expect((await findBooking(made.booking.code, made.booking.phone))!.paymentStatus).toBe("unpaid");
      const due = (await getDb().prepare("SELECT (total_price - shares_paid)::float AS due FROM bookings WHERE id = ?").get(made.booking.id)) as {
        due: number;
      };
      expect(due.due).toBe(6);
      // What was paid online for the rest keeps its receipt, under that payment's own key.
      expect(await documentFor(`booking-paid:${made.booking.id}:${await paymentId(restBill)}`)).toMatchObject({ total: 14 });

      // Called off: the rest paid online is still owed back, in full.
      expect((await cancelBooking(made.booking.code, made.booking.phone)).ok).toBe(true);
      const owed = (await getDb().prepare("SELECT refund_due::float AS due FROM online_payments WHERE bill_id = ?").get(restBill)) as { due: number };
      expect(owed.due).toBe(14);
    } finally {
      await setHoldPolicy(venueId, { on: false });
    }
  });

  it("lost on a deposit for a booking since called off: nothing more is owed", async () => {
    fakeStripe();
    expect((await setHoldPolicy(venueId, { on: true, depositPercent: 30 })).ok).toBe(true);
    try {
      const made = await createBooking({ courtId, date: addDays(todayISO(), 6), hours: [10], name: "Called Off", phone: "91238004" });
      if (!made.ok) throw new Error(made.error);
      const started = await startBookingPayment({ codes: [made.booking.code], phone: made.booking.phone, deposit: true });
      if (!started.ok) throw new Error("payment");
      const billId = started.url.split("/").pop()!;
      await settleBill({ billId, paid: true, paidAt: null });
      expect((await setPaymentStatus(made.booking.code, true, "cash")).ok).toBe(true);
      expect((await cancelBooking(made.booking.code, made.booking.phone)).ok).toBe(true);
      await send("charge.dispute.closed", { id: "dp_13", payment_intent: `pi_for_${billId}`, amount: 600, reason: "fraudulent", status: "lost" });
      const row = (await getDb().prepare("SELECT status, payment_status FROM bookings WHERE id = ?").get(made.booking.id)) as {
        status: string;
        payment_status: string;
      };
      expect(row.status).toBe("cancelled");
      expect(await documentFor(`booking-paid:${made.booking.id}:${await paymentId(billId)}`)).toBeNull();
    } finally {
      await setHoldPolicy(venueId, { on: false });
    }
  });

  it("lost in part: only the part disputed is taken back", async () => {
    const { booking, billId } = await paidBooking();
    await send("charge.dispute.closed", { id: "dp_8", payment_intent: `pi_for_${billId}`, amount: 500, reason: "general", status: "lost" });
    const row = (await getDb()
      .prepare("SELECT payment_status, (total_price - shares_paid)::float AS due FROM bookings WHERE id = ?")
      .get(booking.id)) as { payment_status: string; due: number };
    expect(row).toEqual({ payment_status: "unpaid", due: 5 });
    const receipt = (await documentFor(`booking-paid:${booking.id}:${await paymentId(billId)}`))!;
    expect(receipt.total).toBe(20);
    expect((await creditNoteFor(receipt.number))!.total).toBe(5);
    const pay = (await getDb().prepare("SELECT refunded::float AS refunded FROM online_payments WHERE bill_id = ?").get(billId)) as { refunded: number };
    expect(pay.refunded).toBe(5);

    // Called off afterwards: what the bank left is owed back, and credited.
    expect((await cancelBooking(booking.code, booking.phone)).ok).toBe(true);
    const after = (await getDb().prepare("SELECT refund_due::float AS due FROM online_payments WHERE bill_id = ?").get(billId)) as { due: number };
    expect(after.due).toBe(20);
    const notes = (await getDb()
      .prepare("SELECT total::float AS total FROM receipts WHERE kind = 'credit_note' AND credits_id = ? ORDER BY id")
      .all(receipt.id)) as { total: number }[];
    expect(notes.map((x) => x.total)).toEqual([5, 15]);
  });

  it("lost, told twice at once: taken back once", async () => {
    fakeStripe();
    const user = await registerUser({ name: "Twice", email: "twice@dispute.sg", phone: "91238002", password: "long enough password" });
    if (!user.ok) throw new Error(user.error);
    const started = await startTopUpPayment(user.user, venueId, 30);
    if (!started.ok) throw new Error("topup");
    const billId = started.url.split("/").pop()!;
    await settleBill({ billId, paid: true, paidAt: null });
    const lost = { id: "dp_10", payment_intent: `pi_for_${billId}`, amount: 3000, reason: "fraudulent", status: "lost" };
    await Promise.all([send("charge.dispute.closed", lost), send("charge.dispute.closed", lost)]);
    expect(await getWalletBalance(user.user.id, venueId)).toBe(0);
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

describe("a chargeback on what a venue paid the platform", () => {
  const PLATFORM_SECRET = "whsec_platformsecret1234567890";

  it("is written down and put to the platform owners, not the venue; lost, the invoice is owed again", async () => {
    vi.stubEnv("MYSENAM_PAYMENT_PROVIDER", "stripe");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_platformkey123456");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", PLATFORM_SECRET);
    try {
      fakeStripe();
      await createAdmin({ name: "Owner", email: "owner@platform.sg", password: "long enough password", venueId: null });
      const db = getDb();
      const invoice = (await db
        .prepare(
          `INSERT INTO venue_invoices (venue_id, period, amount, status, issued_on, due_on, paid_at, paid_via)
           VALUES (?, '2026-09', 99, 'paid', '2026-10-01', '2026-10-15', '2026-10-02 10:00:00', 'online') RETURNING id`
        )
        .get(venueId)) as { id: number };
      await db
        .prepare(
          `INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, payer_name, purpose, invoice_id, status)
           VALUES ('stripe', 'cs_test_invoicepaid', 'https://checkout.stripe.com/c/pay/x', ?, 99, 'Mgr', 'invoice', ?, 'paid')`
        )
        .run(venueId, invoice.id);
      emails.length = 0;

      const dispute = { id: "dp_platform", payment_intent: "pi_for_cs_test_invoicepaid", amount: 9900, reason: "general" };
      const opened = await send("charge.dispute.created", { ...dispute, status: "needs_response" }, PLATFORM_SECRET);
      expect(opened.status).toBe(200);
      expect(emails.map((e) => e.to)).toEqual(["owner@platform.sg"]);
      expect(emails[0].text).toContain(`its invoice (number ${invoice.id})`);
      // Not the venue's to answer, nor shown among its customers' disputes.
      expect((await disputesFor(venueId)).find((d) => d.providerDisputeId === "dp_platform")).toBeUndefined();

      emails.length = 0;
      await send("charge.dispute.closed", { ...dispute, status: "lost" }, PLATFORM_SECRET);
      await send("charge.dispute.closed", { ...dispute, status: "lost" }, PLATFORM_SECRET);
      expect(emails.map((e) => e.subject)).toEqual([expect.stringContaining("Dispute lost")]);
      expect(emails[0].text).toContain("owed again");
      const row = (await db.prepare("SELECT outcome FROM payment_disputes WHERE provider_dispute_id = 'dp_platform'").get()) as { outcome: string };
      expect(row.outcome).toBe("lost");
      // The money went back, so the invoice is not paid: owed again, with a fresh fortnight, not overdue at once.
      expect(await db.prepare("SELECT status, paid_at, due_on FROM venue_invoices WHERE id = ?").get(invoice.id)).toEqual({
        status: "due",
        paid_at: null,
        due_on: addDays(todayISO(), 14),
      });

      // A WhatsApp pack lost the same way: owed again, and its messages taken back, those already sent below nothing.
      const pack = (await db
        .prepare("INSERT INTO whatsapp_packs (venue_id, messages, amount, status, paid_at, paid_via) VALUES (?, 100, 30, 'paid', datetime('now'), 'online') RETURNING id")
        .get(venueId)) as { id: number };
      await db.prepare("INSERT INTO whatsapp_credit (venue_id, delta, reason, pack_id) VALUES (?, 100, 'pack', ?)").run(venueId, pack.id);
      await db.prepare("INSERT INTO whatsapp_credit (venue_id, delta, reason) VALUES (?, -40, 'sent')").run(venueId);
      const balance = async () => Number(((await db.prepare("SELECT COALESCE(SUM(delta), 0) AS n FROM whatsapp_credit WHERE venue_id = ?").get(venueId)) as { n: number }).n);
      const before = await balance();
      await db
        .prepare(
          `INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, payer_name, purpose, pack_id, status)
           VALUES ('stripe', 'cs_test_packpaid', 'https://checkout.stripe.com/c/pay/y', ?, 30, 'Mgr', 'pack', ?, 'paid')`
        )
        .run(venueId, pack.id);
      const packDispute = { id: "dp_pack", payment_intent: "pi_for_cs_test_packpaid", amount: 3000, reason: "general" };
      await send("charge.dispute.created", { ...packDispute, status: "needs_response" }, PLATFORM_SECRET);
      await send("charge.dispute.closed", { ...packDispute, status: "lost" }, PLATFORM_SECRET);
      expect(((await db.prepare("SELECT status FROM whatsapp_packs WHERE id = ?").get(pack.id)) as { status: string }).status).toBe("due");
      expect((await balance()) - before).toBe(-100);

      // Signed by nobody we know: still refused.
      expect((await send("charge.dispute.created", { ...dispute, id: "dp_forged", status: "needs_response" }, "whsec_somebodyelse12345678")).status).toBe(400);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
