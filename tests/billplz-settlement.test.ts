import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { xSignature } from "../src/lib/billplz";
import { getDb } from "../src/lib/db";
import { billplz as billplzGateway } from "../src/lib/gateways/billplz";
import { holdNewBookings, releaseExpiredHolds } from "../src/lib/holds";
import { paymentChecksSummary, paymentsToCheck, reviewPayment } from "../src/lib/payment-settlement";
import { refundsOwed, savePaymentSettings, settleBill, startBookingPayment, paymentByBill } from "../src/lib/payments";
import { messagesForBooking } from "../src/lib/outbox";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { registerUser } from "../src/lib/auth";
import { adminCancelBooking, createBooking, createCourt, createVenue, findBooking } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { POST as callbackRoute } from "../src/app/api/payments/[provider]/callback/route";
import PaymentReturnPage from "../src/app/payments/return/page";

/**
 * Settling a Billplz payment (audit C19) and a payment after the hold was let go (audit C18 / DEC-14), ADR 0065.
 *
 * Billplz is never called: fetch is stood in for, and the callbacks are signed with the test key exactly as Billplz
 * signs them, with the fields its documentation lists (id, collection_id, paid, state, amount, paid_amount, due_at,
 * email, mobile, name, url, paid_at). What this proves is MySenam's arithmetic and guards. It does not prove that
 * Billplz sends these fields, or that a bill can be short- or over-paid: that is the sandbox check, still pending.
 */

const KEY = "S-settle-key";
const COLLECTION = "colSettle";
const PRICE = 20; // the court's rate: a booking costs RM20, a bill is 2000 sen
let venueId: number;
let courtId: number;
let otherVenueId: number;
let n = 0;
let slot = 0;

/** A fresh hour on a fresh day each time. */
const nextSlot = () => {
  const i = slot++;
  return { date: addDays(todayISO(), 2 + (i % 10)), hour: 8 + Math.floor(i / 10) };
};

let billNumber = 0;
function fakeBillplz() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const id = `settlebill${++billNumber}`;
      return Response.json({ id, url: `https://www.billplz-sandbox.com/bills/${id}` });
    })
  );
}

interface Made {
  bookingId: number;
  code: string;
  phone: string;
  billId: string;
  paymentId: number;
}

/** A held booking (as the venue's pay-to-hold makes one), and the payment page opened for it. */
async function pending(opts: { deposit?: boolean; userId?: number; email?: string; held?: boolean } = {}): Promise<Made> {
  const phone = `0149${String(++n).padStart(7, "0")}`;
  const { date, hour } = nextSlot();
  const made = await createBooking({ courtId, date, hours: [hour], name: "Nadia", phone, email: opts.email, userId: opts.userId });
  if (!made.ok) throw new Error(made.error);
  if (opts.held !== false) await holdNewBookings([made.booking.id], 15);
  fakeBillplz();
  const started = await startBookingPayment({ codes: [made.booking.code], phone, ...(opts.deposit ? { deposit: true } : {}) });
  if (!started.ok) throw new Error(started.error);
  vi.unstubAllGlobals();
  const row = (await getDb().prepare("SELECT id, bill_id FROM online_payments ORDER BY id DESC LIMIT 1").get()) as { id: number; bill_id: string };
  return { bookingId: made.booking.id, code: made.booking.code, phone, billId: row.bill_id, paymentId: row.id };
}

interface CallbackOptions {
  billedSen?: number;
  paidSen?: number | null;
  paid?: boolean;
  state?: string;
  collection?: string;
  key?: string;
  /** When Billplz says the bill was paid, in its own format ("2026-11-07 10:00:00 +0000"); now by default. */
  paidAt?: string;
}

/** A time as Billplz writes `paid_at`. */
const billplzTime = (d: Date) => `${d.toISOString().slice(0, 19).replace("T", " ")} +0000`;

/** The callback Billplz sends when a bill is paid, signed. */
function callbackBody(billId: string, o: CallbackOptions = {}): string {
  const billed = o.billedSen ?? PRICE * 100;
  const paid = o.paid ?? true;
  const fields: Record<string, string> = {
    id: billId,
    collection_id: o.collection ?? COLLECTION,
    paid: paid ? "true" : "false",
    state: o.state ?? (paid ? "paid" : "due"),
    amount: String(billed),
    ...(o.paidSen === null ? {} : { paid_amount: String(o.paidSen ?? (paid ? billed : 0)) }),
    due_at: "2026-12-31",
    email: "",
    mobile: "60123456789",
    name: "NADIA",
    url: `https://www.billplz-sandbox.com/bills/${billId}`,
    paid_at: paid ? (o.paidAt ?? billplzTime(new Date())) : "",
  };
  fields.x_signature = xSignature(fields, o.key ?? KEY);
  return new URLSearchParams(fields).toString();
}

const callback = (billId: string, o: CallbackOptions = {}) =>
  callbackRoute(
    new NextRequest("http://localhost/api/payments/billplz/callback", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: callbackBody(billId, o),
    }),
    { params: Promise.resolve({ provider: "billplz" }) }
  );

const payment = async (id: number) =>
  (await getDb()
    .prepare(
      `SELECT status, amount::float AS amount, billed_amount::float AS billed, received_amount::float AS received, refund_due::float AS refund_due,
              refunded::float AS refunded, settlement_issue AS issue FROM online_payments WHERE id = ?`
    )
    .get(id)) as { status: string; amount: number; billed: number | null; received: number | null; refund_due: number; refunded: number; issue: string | null };

const receipts = async (id: number) =>
  ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM receipts WHERE source = ? ").get(`payment:${id}`)) as { n: number }).n;

const activity = async (id: number) =>
  ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM staff_actions WHERE action = 'payment.settlement_check' AND detail LIKE ?").get(`Payment ${id} (%`)) as { n: number }).n;

const kindsOf = async (bookingId: number) => (await messagesForBooking(bookingId)).map((m) => m.kind);

beforeAll(async () => {
  const made = await createVenue({ name: "Settle Arena", area: "PJ", address: "x", phone: "0300000316" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: PRICE, peakRate: PRICE });
  if (!court.ok) throw new Error("court");
  courtId = court.court.id;
  const saved = await savePaymentSettings(venueId, { apiKey: "api-key-1234", collectionId: COLLECTION, xSignatureKey: KEY, sandbox: true, enabled: true });
  if (!saved.ok) throw new Error(saved.error);
  const other = await createVenue({ name: "Elsewhere Hall", area: "Klang", address: "y", phone: "0300000317" });
  if (!other.ok) throw new Error("venue");
  otherVenueId = other.venue.id;
  await createCourt({ venueId: otherVenueId, name: "Court X", sport: "badminton", offPeakRate: 10, peakRate: 10 });
  const savedOther = await savePaymentSettings(otherVenueId, { apiKey: "other-key-1234", collectionId: "colOther", xSignatureKey: "S-other-key", sandbox: true, enabled: true });
  if (!savedOther.ok) throw new Error(savedOther.error);
});

afterEach(() => vi.unstubAllGlobals());

describe("C19: a report of payment is believed for the amount the page asked for", () => {
  it("settles what was asked when Billplz reports exactly that, and records what it took", async () => {
    const m = await pending();
    expect((await callback(m.billId)).status).toBe(200);
    expect(await payment(m.paymentId)).toMatchObject({ status: "paid", amount: PRICE, received: PRICE, billed: null, refund_due: 0, issue: null });
    expect((await findBooking(m.code, m.phone))!).toMatchObject({ paymentStatus: "paid", paidOnline: true });
    expect(await paymentsToCheck(venueId, (id) => id)).toEqual([]);
  });

  it("turns a forged callback away, and one signed under another venue's key, whichever bill it names", async () => {
    const mine = await pending();
    expect((await callback(mine.billId, { key: "guessed" })).status).toBe(400);
    // Another business's valid key does not settle this venue's bill ...
    expect((await callback(mine.billId, { key: "S-other-key" })).status).toBe(400);
    expect(await payment(mine.paymentId)).toMatchObject({ status: "pending", received: null });
    expect((await findBooking(mine.code, mine.phone))!.paymentStatus).toBe("unpaid");
    // ... and this venue's key does not settle the other venue's bill (a bill made through its own account).
    const otherBill = `otherbill${++n}`;
    await getDb()
      .prepare("INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, payer_name, payer_phone) VALUES ('billplz', ?, 'https://x', ?, 10, 'Z', '0100000000')")
      .run(otherBill, otherVenueId);
    expect((await callback(otherBill, { billedSen: 1000, key: KEY })).status).toBe(400);
    expect((await getDb().prepare("SELECT status FROM online_payments WHERE bill_id = ?").get(otherBill)) as { status: string }).toEqual({ status: "pending" });
  });

  it("does not take a report that says paid under a state that is not paid", async () => {
    const m = await pending();
    expect((await callback(m.billId, { state: "due" })).status).toBe(200);
    expect(await payment(m.paymentId)).toMatchObject({ status: "pending" });
    expect((await findBooking(m.code, m.phone))!.paymentStatus).toBe("unpaid");
  });

  it("a short payment settles nothing: what came is owed back whole, and it is on the list to check", async () => {
    const m = await pending({ email: `short${++n}@example.my` });
    expect((await callback(m.billId, { paidSen: 1200 })).status).toBe(200);
    expect(await payment(m.paymentId)).toMatchObject({ status: "paid", amount: 12, received: 12, billed: PRICE, refund_due: 12, issue: "underpaid" });
    const booking = (await findBooking(m.code, m.phone))!;
    expect(booking).toMatchObject({ paymentStatus: "unpaid", status: "confirmed" });
    expect(await receipts(m.paymentId)).toBe(0);
    // A refund OWED is not a refund PAID.
    expect((await refundsOwed(venueId)).find((p) => p.billId === m.billId)).toMatchObject({ refundOwed: 12, refunded: 0, settlementIssue: "underpaid", billedAmount: PRICE });
    const checks = (await paymentsToCheck(venueId, (id) => id)).filter((c) => c.billId === m.billId);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ issue: "underpaid", amount: 12, billedAmount: PRICE, refundOwed: 12, contact: "unverified" });
    expect(await activity(m.paymentId)).toBe(1);
    // Billplz retries, and the redirect comes after: nothing changes, nothing is written twice.
    expect((await callback(m.billId, { paidSen: 1200 })).status).toBe(200);
    expect(await payment(m.paymentId)).toMatchObject({ amount: 12, refund_due: 12, billed: PRICE });
    expect(await activity(m.paymentId)).toBe(1);
    // The customer can still pay the booking in full on a new page: the obligation was left open.
    fakeBillplz();
    const again = await startBookingPayment({ codes: [m.code], phone: m.phone });
    expect(again).toMatchObject({ ok: true, amount: PRICE, reused: false });
    vi.unstubAllGlobals();
  });

  it("an excess settles what was asked and owes the rest back, once", async () => {
    const m = await pending();
    await callback(m.billId, { paidSen: 2500 });
    expect(await payment(m.paymentId)).toMatchObject({ status: "paid", amount: 25, billed: PRICE, received: 25, refund_due: 5, issue: "overpaid" });
    expect((await findBooking(m.code, m.phone))!).toMatchObject({ paymentStatus: "paid", paidOnline: true });
    expect((await refundsOwed(venueId)).find((p) => p.billId === m.billId)).toMatchObject({ refundOwed: 5 });
    await callback(m.billId, { paidSen: 2500 });
    await callback(m.billId, { paidSen: 2500 });
    expect(await payment(m.paymentId)).toMatchObject({ amount: 25, refund_due: 5 });
    expect(await activity(m.paymentId)).toBe(1);
    // Cancelling after paying owes back the price AND the excess: all 25 are owed, none silently kept.
    await adminCancelBooking(m.code);
    expect(await payment(m.paymentId)).toMatchObject({ amount: 25, refund_due: 25, refunded: 0 });
  });

  it("a bill that is not the one we asked for, in another collection, or without its amounts, applies nothing", async () => {
    const wrongBill = await pending();
    await callback(wrongBill.billId, { billedSen: 3500, paidSen: 3500 });
    expect(await payment(wrongBill.paymentId)).toMatchObject({ status: "paid", issue: "bill_amount", refund_due: 35 });
    expect((await findBooking(wrongBill.code, wrongBill.phone))!.paymentStatus).toBe("unpaid");

    const elsewhere = await pending();
    await callback(elsewhere.billId, { collection: "colSomewhereElse" });
    expect(await payment(elsewhere.paymentId)).toMatchObject({ status: "paid", issue: "collection", refund_due: PRICE });
    expect((await findBooking(elsewhere.code, elsewhere.phone))!.paymentStatus).toBe("unpaid");

    const bare = await pending();
    await callback(bare.billId, { paidSen: null });
    expect(await payment(bare.paymentId)).toMatchObject({ status: "paid", issue: "unverified", refund_due: PRICE });
    expect((await findBooking(bare.code, bare.phone))!.paymentStatus).toBe("unpaid");
    for (const m of [wrongBill, elsewhere, bare]) expect((await paymentsToCheck(venueId, (id) => id)).some((c) => c.billId === m.billId)).toBe(true);
  });

  it("a report that carries no amounts at all settles the page's amount, as a renewal charge or a test always did", async () => {
    const m = await pending();
    await settleBill({ billId: m.billId, paid: true, paidAt: null });
    expect(await payment(m.paymentId)).toMatchObject({ status: "paid", amount: PRICE, received: null, issue: null });
    expect((await findBooking(m.code, m.phone))!.paymentStatus).toBe("paid");
  });

  it("a report that disagrees after the payment was applied is recorded and flagged, never undone", async () => {
    const m = await pending();
    await settleBill({ billId: m.billId, paid: true, paidAt: null });
    await callback(m.billId, { paidSen: 1500 });
    expect(await payment(m.paymentId)).toMatchObject({ status: "paid", amount: PRICE, received: 15, refund_due: 0, issue: "short_after_settled" });
    expect((await findBooking(m.code, m.phone))!.paymentStatus).toBe("paid");
    expect((await paymentsToCheck(venueId, (id) => id)).find((c) => c.billId === m.billId)).toMatchObject({ issue: "short_after_settled" });
    await callback(m.billId, { paidSen: 1500 });
    expect(await activity(m.paymentId)).toBe(1);
  });

  it("staff mark a payment checked once; another venue's staff cannot, and the list keeps only what nobody has looked at", async () => {
    const m = await pending();
    await callback(m.billId, { paidSen: 1000 });
    const desk = await createAdmin({ name: "Desk", email: `desk-settle-${++n}@example.com`, password: "desk-password", venueId });
    if (!desk.ok) throw new Error(desk.error);
    const staff = { id: desk.admin.id, name: "Desk" };
    expect(await reviewPayment(m.paymentId, otherVenueId, staff, "x")).toMatchObject({ ok: false, status: 409 });
    expect(await reviewPayment(m.paymentId, venueId, staff, "Rang the payer, refunding in Billplz")).toEqual({ ok: true });
    expect(await reviewPayment(m.paymentId, venueId, staff, null)).toMatchObject({ ok: false, status: 409 });
    expect((await paymentsToCheck(venueId, (id) => id)).some((c) => c.billId === m.billId)).toBe(false);
    expect((await paymentChecksSummary([otherVenueId])).length).toBe(0);
    // Looking does not move money: it is still owed until it is refunded.
    expect((await refundsOwed(venueId)).find((p) => p.billId === m.billId)).toMatchObject({ refundOwed: 10 });
    const logged = (await getDb().prepare("SELECT detail FROM staff_actions WHERE action = 'payment.settlement_reviewed' ORDER BY id DESC LIMIT 1").get()) as { detail: string };
    expect(logged.detail).toContain("Rang the payer");
  });

  it("two callbacks and a return at once settle once, and a short one is held once", async () => {
    const whole = await pending();
    await Promise.all([callback(whole.billId), callback(whole.billId), callback(whole.billId), callback(whole.billId)]);
    expect(await payment(whole.paymentId)).toMatchObject({ status: "paid", amount: PRICE, received: PRICE, refund_due: 0 });
    expect(await receipts(whole.paymentId)).toBeLessThanOrEqual(1);
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE id = ? AND payment_status = 'paid'").get(whole.bookingId)) as { n: number }).n).toBe(1);

    const short = await pending();
    await Promise.all([1, 2, 3, 4, 5].map(() => callback(short.billId, { paidSen: 800 })));
    expect(await payment(short.paymentId)).toMatchObject({ status: "paid", amount: 8, refund_due: 8, billed: PRICE, issue: "underpaid" });
    expect(await activity(short.paymentId)).toBe(1);

    const over = await pending();
    await Promise.all([1, 2, 3, 4, 5].map(() => callback(over.billId, { paidSen: 3000 })));
    expect(await payment(over.paymentId)).toMatchObject({ amount: 30, refund_due: 10, billed: PRICE });
    expect(await activity(over.paymentId)).toBe(1);
  });
});

describe("C19: the browser coming back carries no amount, so Billplz is asked for the bill", () => {
  const account = { provider: "billplz" as const, sandbox: true, credentials: { apiKey: "api-key-1234", collectionId: COLLECTION, xSignatureKey: KEY } };

  const redirectQuery = (billId: string, paid = true) => {
    const fields = { billplzid: billId, billplzpaid: paid ? "true" : "false", billplzpaid_at: paid ? "2026-11-07 10:00:00 +0800" : "" };
    return new URLSearchParams({
      "billplz[id]": billId,
      "billplz[paid]": fields.billplzpaid,
      "billplz[paid_at]": fields.billplzpaid_at,
      "billplz[x_signature]": xSignature(fields, KEY),
    });
  };

  /** Billplz answering `GET /api/v3/bills/:id` with the bill as it stands. */
  const billAnswers = (bill: Record<string, unknown> | "down" | "notfound") =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (bill === "down") throw new Error("network");
        if (bill === "notfound") return new Response("{}", { status: 404 });
        return Response.json(bill);
      })
    );

  it("a paid redirect settles only what the bill itself says was paid in full", async () => {
    const m = await pending();
    billAnswers({ id: m.billId, collection_id: COLLECTION, paid: true, state: "paid", amount: 2000, paid_amount: 2000 });
    const result = await billplzGateway.readRedirect(redirectQuery(m.billId))!.verify(account);
    expect(result).toMatchObject({ billId: m.billId, paid: true, billedMinor: 2000, receivedMinor: 2000, currency: "MYR" });
    await settleBill(result!);
    expect((await findBooking(m.code, m.phone))!.paymentStatus).toBe("paid");
    expect(await payment(m.paymentId)).toMatchObject({ received: PRICE, issue: null });
  });

  it("a paid redirect for a bill the API says was short applies nothing", async () => {
    const m = await pending();
    billAnswers({ id: m.billId, collection_id: COLLECTION, paid: true, state: "paid", amount: 2000, paid_amount: 500 });
    await settleBill((await billplzGateway.readRedirect(redirectQuery(m.billId))!.verify(account))!);
    expect((await findBooking(m.code, m.phone))!.paymentStatus).toBe("unpaid");
    expect(await payment(m.paymentId)).toMatchObject({ status: "paid", amount: 5, refund_due: 5, issue: "underpaid" });
  });

  it("with Billplz unreachable, or the bill not paid there, the outcome is unknown and the callback decides", async () => {
    const m = await pending();
    for (const answer of ["down", { id: m.billId, collection_id: COLLECTION, paid: false, state: "due", amount: 2000, paid_amount: 0 }, "notfound"] as const) {
      billAnswers(answer);
      const result = await billplzGateway.readRedirect(redirectQuery(m.billId))!.verify(account);
      expect(result).toMatchObject({ billId: m.billId, unconfirmed: true });
      // Settling it applies nothing and lets nothing go.
      await settleBill(result!);
    }
    expect(await payment(m.paymentId)).toMatchObject({ status: "pending", received: null });
    expect((await findBooking(m.code, m.phone))!).toMatchObject({ paymentStatus: "unpaid", status: "confirmed" });
    vi.unstubAllGlobals();
    await callback(m.billId);
    expect((await findBooking(m.code, m.phone))!.paymentStatus).toBe("paid");
  });

  it("a redirect that says not paid needs no question, and a forged one is nothing", async () => {
    const m = await pending();
    expect(await billplzGateway.readRedirect(redirectQuery(m.billId, false))!.verify(account)).toMatchObject({ paid: false });
    const forged = redirectQuery(m.billId);
    forged.set("billplz[paid]", "false");
    expect(await billplzGateway.readRedirect(forged)!.verify(account)).toBeNull();
  });

  it("the return page does not say a short payment was received, thank you", async () => {
    const m = await pending();
    await callback(m.billId, { paidSen: 700 });
    billAnswers({ id: m.billId, collection_id: COLLECTION, paid: true, state: "paid", amount: 2000, paid_amount: 700 });
    const query = Object.fromEntries(redirectQuery(m.billId));
    const html = renderToStaticMarkup(await PaymentReturnPage({ searchParams: Promise.resolve(query) }));
    expect(html).toContain('data-testid="payment-not-applied"');
    expect(html).toContain("Payment received, not applied");
    expect(html).not.toContain("Thank you");
  });
});

describe("C18 / DEC-14: a payment after the hold was let go is owed back, never turned into the booking", () => {
  /** The hold has run out; `release` lets the booking go as the scheduler's tick would. */
  async function lapse(m: Made, release: boolean) {
    await getDb().prepare("UPDATE bookings SET hold_until = datetime('now', '-1 minutes') WHERE id = ?").run(m.bookingId);
    if (release) await releaseExpiredHolds();
  }

  it("is the control: paid inside the hold, the booking stands paid", async () => {
    const m = await pending();
    await callback(m.billId);
    expect(await findBooking(m.code, m.phone)).toMatchObject({ paymentStatus: "paid", status: "confirmed", holdUntil: null });
    expect(await payment(m.paymentId)).toMatchObject({ issue: null, refund_due: 0 });
  });

  it("after the booking was let go: owed back whole, recorded as hold lapsed, the booking stays cancelled, the slot stays free", async () => {
    const m = await pending();
    await lapse(m, true);
    expect(await findBooking(m.code, m.phone)).toMatchObject({ status: "cancelled", releasedUnpaid: true });
    await callback(m.billId);
    expect(await payment(m.paymentId)).toMatchObject({ status: "paid", amount: PRICE, refund_due: PRICE, refunded: 0, issue: "hold_lapsed" });
    expect(await findBooking(m.code, m.phone)).toMatchObject({ status: "cancelled", paymentStatus: "unpaid" });
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM claims WHERE booking_id = ? AND active").get(m.bookingId)) as { n: number }).n).toBe(0);
    expect(await receipts(m.paymentId)).toBe(0);
    // On the staff's refunds worklist and the list to check; the customer's page says so.
    expect((await refundsOwed(venueId)).find((p) => p.billId === m.billId)).toMatchObject({ refundOwed: PRICE, settlementIssue: "hold_lapsed" });
    expect((await paymentsToCheck(venueId, (id) => id)).find((c) => c.billId === m.billId)).toMatchObject({ issue: "hold_lapsed", refundOwed: PRICE });
    expect(await activity(m.paymentId)).toBe(1);
    expect((await paymentByBill(m.billId))!.settlementIssue).toBe("hold_lapsed");
  });

  it("whose hold has run out but the tick has not let go yet: not taken into the booking either, and let go now", async () => {
    const m = await pending();
    await lapse(m, false);
    expect((await findBooking(m.code, m.phone))!.status).toBe("confirmed");
    await callback(m.billId);
    expect(await findBooking(m.code, m.phone)).toMatchObject({ status: "cancelled", paymentStatus: "unpaid", releasedUnpaid: true });
    expect(await payment(m.paymentId)).toMatchObject({ refund_due: PRICE, issue: "hold_lapsed" });
  });

  it("paid inside the hold but reported after it ran out (Billplz retries): the payer's own time counts, so the booking stands paid", async () => {
    const m = await pending();
    await getDb().prepare("UPDATE online_payments SET created_at = datetime('now', '-30 minutes') WHERE id = ?").run(m.paymentId);
    await lapse(m, false);
    const heldUntil = (await getDb().prepare("SELECT hold_until FROM bookings WHERE id = ?").get(m.bookingId)) as { hold_until: string };
    const ended = new Date(`${heldUntil.hold_until.replace(" ", "T")}Z`);
    // Paid 30 seconds before the hold ended; the callback is only now.
    await callback(m.billId, { paidAt: billplzTime(new Date(ended.getTime() - 30_000)) });
    expect(await findBooking(m.code, m.phone)).toMatchObject({ paymentStatus: "paid", status: "confirmed" });
    expect(await payment(m.paymentId)).toMatchObject({ issue: null, refund_due: 0 });
    // The same a minute after the hold ended is late, whenever the callback arrives.
    const late = await pending();
    await getDb().prepare("UPDATE online_payments SET created_at = datetime('now', '-30 minutes') WHERE id = ?").run(late.paymentId);
    await lapse(late, false);
    const lateEnd = new Date(`${((await getDb().prepare("SELECT hold_until FROM bookings WHERE id = ?").get(late.bookingId)) as { hold_until: string }).hold_until.replace(" ", "T")}Z`);
    await callback(late.billId, { paidAt: billplzTime(new Date(lateEnd.getTime() + 30_000)) });
    expect(await findBooking(late.code, late.phone)).toMatchObject({ status: "cancelled", paymentStatus: "unpaid" });
    expect(await payment(late.paymentId)).toMatchObject({ issue: "hold_lapsed", refund_due: PRICE });
  });

  it("a double callback, and the redirect after, owe it back once and tell once", async () => {
    const user = await registerUser({ name: "Verified Vera", email: `vera${++n}@example.my`, phone: `0173${String(n).padStart(7, "0")}`, password: "a long enough password" });
    if (!user.ok) throw new Error(user.error);
    await getDb().prepare("UPDATE users SET email_confirmed_at = datetime('now') WHERE id = ?").run(user.user.id);
    const m = await pending({ userId: user.user.id, email: user.user.email });
    await lapse(m, true);
    await Promise.all([callback(m.billId), callback(m.billId), callback(m.billId)]);
    await callback(m.billId);
    expect(await payment(m.paymentId)).toMatchObject({ amount: PRICE, refund_due: PRICE, issue: "hold_lapsed" });
    expect(await activity(m.paymentId)).toBe(1);
    // Told once, by email, to the address the account proved; the generic refund notice does not say it again.
    const told = (await messagesForBooking(m.bookingId)).filter((x) => x.kind === "payment_not_applied");
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ channel: "email" });
    expect(told[0].body).toContain("arrived after");
    expect((await paymentsToCheck(venueId, (id) => id)).find((c) => c.billId === m.billId)).toMatchObject({ contact: "verified", payerTold: true });
  });

  it("a payer with no address their account has proved is not written to: staff see no usable contact", async () => {
    const typed = await pending({ email: `typed${++n}@example.my` });
    await lapse(typed, true);
    await callback(typed.billId);
    expect(await kindsOf(typed.bookingId)).not.toContain("payment_not_applied");
    const row = (await paymentsToCheck(venueId, (id) => id)).find((c) => c.billId === typed.billId)!;
    expect(row).toMatchObject({ issue: "hold_lapsed", contact: "unverified", payerTold: false });
    const bare = await pending();
    await lapse(bare, true);
    await callback(bare.billId);
    expect((await paymentsToCheck(venueId, (id) => id)).find((c) => c.billId === bare.billId)).toMatchObject({ contact: "none" });
  });

  it("the slot was booked by somebody else meanwhile: theirs stands untouched, and the late payment takes nothing", async () => {
    const late = await pending();
    await lapse(late, true);
    const { date, hour } = (await getDb().prepare("SELECT date, start_min / 60 AS hour FROM bookings WHERE id = ?").get(late.bookingId)) as { date: string; hour: number };
    const taker = await createBooking({ courtId, date, hours: [Number(hour)], name: "Somebody else", phone: `0150${String(++n).padStart(7, "0")}` });
    if (!taker.ok) throw new Error(taker.error);
    await callback(late.billId);
    expect(await findBooking(late.code, late.phone)).toMatchObject({ status: "cancelled", paymentStatus: "unpaid" });
    expect((await getDb().prepare("SELECT status FROM bookings WHERE id = ?").get(taker.booking.id)) as { status: string }).toEqual({ status: "confirmed" });
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM claims WHERE booking_id = ? AND active").get(taker.booking.id)) as { n: number }).n).toBeGreaterThan(0);
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM claims WHERE booking_id = ? AND active").get(late.bookingId)) as { n: number }).n).toBe(0);
    expect(await payment(late.paymentId)).toMatchObject({ refund_due: PRICE, issue: "hold_lapsed" });
  });

  it("a deposit that comes after the hold was let go is owed back too", async () => {
    const m = await pending({ deposit: true });
    // The deposit page's amount is the venue's share; Billplz reports what the page asked for.
    const asked = (await payment(m.paymentId)).amount;
    await lapse(m, true);
    await callback(m.billId, { billedSen: Math.round(asked * 100), paidSen: Math.round(asked * 100) });
    expect(await payment(m.paymentId)).toMatchObject({ refund_due: asked, issue: "hold_lapsed" });
    expect(await findBooking(m.code, m.phone)).toMatchObject({ status: "cancelled", depositPaid: 0 });
  });

  it("the return page says the booking was not confirmed and the money is owed back", async () => {
    const m = await pending();
    await lapse(m, true);
    await callback(m.billId);
    const fields = { billplzid: m.billId, billplzpaid: "true", billplzpaid_at: "2026-11-07 10:00:00 +0800" };
    const query = {
      "billplz[id]": m.billId,
      "billplz[paid]": "true",
      "billplz[paid_at]": fields.billplzpaid_at,
      "billplz[x_signature]": xSignature(fields, KEY),
    };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: m.billId, collection_id: COLLECTION, paid: true, state: "paid", amount: 2000, paid_amount: 2000 })));
    const html = renderToStaticMarkup(await PaymentReturnPage({ searchParams: Promise.resolve(query) }));
    expect(html).toContain("Payment received, booking not confirmed");
    expect(html).toContain("owed back to you");
    expect(html).not.toContain("Thank you");
  });
});

describe("the staff routes keep to the venue", () => {
  it("lists and checks only the admin's own venue's payments, and the needs-attention line follows", async () => {
    const m = await pending();
    await callback(m.billId, { paidSen: 500 });
    const deskHere = await createAdmin({ name: "Desk here", email: `desk-here-${++n}@example.com`, password: "desk-password", venueId });
    const deskThere = await createAdmin({ name: "Desk there", email: `desk-there-${++n}@example.com`, password: "desk-password", venueId: otherVenueId });
    if (!deskHere.ok || !deskThere.ok) throw new Error("admin");
    const cookie = async (id: number) => `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(id)).token}`;
    const route = await import("../src/app/api/admin/online-payments/route");
    const attention = await import("../src/app/api/admin/attention/route");
    const get = async (as: number, venue: number) =>
      route.GET(new NextRequest(`http://localhost/api/admin/online-payments?venueId=${venue}`, { headers: { cookie: await cookie(as) } }));
    const review = async (as: number, venue: number) =>
      route.POST(
        new NextRequest("http://localhost/api/admin/online-payments", {
          method: "POST",
          headers: { cookie: await cookie(as), "content-type": "application/json" },
          body: JSON.stringify({ venueId: venue, paymentId: m.paymentId, action: "review", note: "Looked" }),
        })
      );

    expect((await get(deskThere.admin.id, venueId)).status).toBe(403);
    expect((await review(deskThere.admin.id, venueId)).status).toBe(403);
    const mine = await get(deskHere.admin.id, venueId);
    expect(mine.status).toBe(200);
    expect(((await mine.json()).paymentsToCheck as { billId: string }[]).some((c) => c.billId === m.billId)).toBe(true);
    const attentionOf = async (as: number) =>
      (await (await attention.GET(new NextRequest("http://localhost/api/admin/attention", { headers: { cookie: await cookie(as) } }))).json()).paymentChecks as { venueId: number; count: number }[];
    expect((await attentionOf(deskHere.admin.id)).find((v) => v.venueId === venueId)?.count).toBeGreaterThan(0);
    expect((await attentionOf(deskThere.admin.id)).some((v) => v.venueId === venueId)).toBe(false);

    expect((await review(deskHere.admin.id, venueId)).status).toBe(200);
    expect((await review(deskHere.admin.id, venueId)).status).toBe(409);
    expect(((await (await get(deskHere.admin.id, venueId)).json()).paymentsToCheck as { billId: string }[]).some((c) => c.billId === m.billId)).toBe(false);
  });
});

describe("migration 0316 on a table that already holds settled payments", () => {
  it("adds nothing to them: no issue, no received amount, off the list to check, and applying it twice changes nothing", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const legacy = await pending();
    await settleBill({ billId: legacy.billId, paid: true, paidAt: null });
    // Put the table in the shape it had before the migration, with that settled payment in it.
    const db = getDb();
    await db.exec("DROP INDEX IF EXISTS online_payments_to_check");
    await db.exec("ALTER TABLE online_payments DROP CONSTRAINT IF EXISTS online_payments_settlement_issue_check");
    for (const column of ["received_amount", "billed_amount", "settlement_issue", "settlement_issue_at", "settlement_reviewed_at", "settlement_reviewed_by", "settlement_review_note", "settlement_payer_told_at"])
      await db.exec(`ALTER TABLE online_payments DROP COLUMN ${column}`);
    const sql = fs.readFileSync(path.join(process.cwd(), "db", "migrations", "0316_payment_settlement_checks.sql"), "utf8");
    await db.exec(sql);
    await db.exec(sql);
    expect(await payment(legacy.paymentId)).toMatchObject({ status: "paid", amount: PRICE, received: null, billed: null, refund_due: 0, issue: null });
    expect((await paymentsToCheck(venueId, (id) => id)).some((c) => c.billId === legacy.billId)).toBe(false);
    // A later report with figures adds what it saw, once, and money is untouched.
    await callback(legacy.billId);
    expect(await payment(legacy.paymentId)).toMatchObject({ amount: PRICE, received: PRICE, refund_due: 0, issue: null });
    // The constraint is in force again.
    await expect(db.prepare("UPDATE online_payments SET settlement_issue = 'nonsense' WHERE id = ?").run(legacy.paymentId)).rejects.toThrow();
  });
});
