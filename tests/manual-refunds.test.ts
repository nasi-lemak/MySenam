import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.sg";
process.env.MYSENAM_COUNTRY = "SG";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { setCancelPolicy } from "../src/lib/cancel-policy";
import {
  markRefunded,
  overdueRefunds,
  reconcileRefunds,
  refundCancelled,
  refundClock,
  refundsOwed,
  refundStatusFor,
  refundWorkload,
  savePaymentSettings,
  settleBill,
  startBookingPayment,
} from "../src/lib/payments";
import { cancelBooking, createBookingSeries, createCourt, createVenue } from "../src/lib/store";
import { getDb } from "../src/lib/db";
import { addDays, todayISO } from "../src/lib/time";
import { translator } from "../src/lib/i18n";
import { refundStatusLine } from "../src/lib/refund-text";
import { GET as lookup } from "../src/app/api/bookings/route";
import { GET as attention } from "../src/app/api/admin/attention/route";
import { GET as paymentsGet, POST as paymentsPost } from "../src/app/api/admin/online-payments/route";

/**
 * Refunds a venue makes by hand (Billplz has no refund API): the customer is
 * told a date and can follow it; staff see how long each has been owed and
 * which are past the date, record each with a reference, once; overdue ones
 * reach the dashboard; and the work they make is counted month by month.
 */

let venueId: number;
let courtId: number;
let ownerCookie = "";
let n = 0;
let hour = 8;
const date = addDays(todayISO(), 3);

function fakeStripe() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string } = {}) => {
      if (url.includes("/refunds?payment_intent=")) return Response.json({ object: "list", data: [] });
      if (url.endsWith("/refunds")) return Response.json({ id: `re_${++n}`, status: "succeeded" });
      if (init.method === "POST") {
        const id = `cs_test_manual${++n}`;
        return Response.json({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
      }
      const id = decodeURIComponent(url.split("/").pop()!);
      return Response.json({ id, payment_status: "paid", status: "complete", payment_intent: `pi_for_${id}` });
    })
  );
}

/** A booking paid online, then cancelled: RM20 owed back. */
async function cancelledAfterPaying() {
  fakeStripe();
  const made = await createBookingSeries({ courtId, date, hours: [hour++], name: "Wei Ling", phone: `9123${String(++n).padStart(4, "0")}`, weeks: 1 });
  if (!made.ok) throw new Error(made.error);
  const booking = made.bookings[0];
  const started = await startBookingPayment({ codes: [booking.code], phone: booking.phone });
  if (!started.ok) throw new Error("payment");
  await settleBill({ billId: started.url.split("/").pop()!, paid: true, paidAt: null });
  expect(await cancelBooking(booking.code, booking.phone)).toMatchObject({ ok: true });
  const refunds = await refundCancelled([booking.id]);
  const paymentId = ((await getDb().prepare("SELECT payment_id FROM online_payment_bookings WHERE booking_id = ?").get(booking.id)) as { payment_id: number }).payment_id;
  return { booking, refunds, paymentId };
}

/** As if reconciliation first saw it owed this many days ago. */
const owedFor = (paymentId: number, days: number) =>
  getDb().prepare("UPDATE online_payments SET refund_seen_at = ?, refund_seen_policy = 'manual' WHERE id = ?").run(
    new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19).replace("T", " "),
    paymentId
  );

const admin = (url: string, init: { method?: string; body?: unknown } = {}) =>
  new NextRequest(url, {
    method: init.method ?? "GET",
    headers: { cookie: ownerCookie, "content-type": "application/json", origin: "http://localhost" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

beforeAll(async () => {
  const made = await createVenue({ name: "Tampines Courts", area: "Tampines", address: "x", phone: "61230001" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!court.ok) throw new Error("court");
  courtId = court.court.id;
  const saved = await savePaymentSettings(venueId, {
    credentials: { secretKey: "rk_test_abcdefghijklmnop", webhookSecret: "whsec_testsecret1234567890" },
    sandbox: true,
    enabled: true,
  });
  if (!saved.ok) throw new Error(saved.error);
  // Somebody at the venue for the daily reminder to reach.
  await createAdmin({ name: "Musa Manager", email: "musa@tampines.sg", password: "manager-pass-1", venueId });
  await ensureBootstrapAdmin();
  const owner = (await getDb().prepare("SELECT id FROM admins WHERE venue_id IS NULL AND business_id IS NULL ORDER BY id LIMIT 1").get()) as { id: number };
  ownerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(owner.id)).token}`;
});

afterEach(() => vi.unstubAllGlobals());

describe("the date a refund by hand is due", () => {
  it("is the venue's promise, configurable from 1 to 30 days, and counted from when it was first owed", async () => {
    expect(await setCancelPolicy(venueId, { onlineRefunds: "staff", refundWithinDays: 0 })).toMatchObject({ ok: false });
    expect(await setCancelPolicy(venueId, { onlineRefunds: "staff", refundWithinDays: 31 })).toMatchObject({ ok: false });
    expect(await setCancelPolicy(venueId, { onlineRefunds: "staff", refundWithinDays: 3 })).toMatchObject({ ok: true, policy: { refundWithinDays: 3 } });
    // Left out, it is kept.
    expect(await setCancelPolicy(venueId, { onlineRefunds: "staff" })).toMatchObject({ ok: true, policy: { refundWithinDays: 3 } });
    const now = new Date("2026-10-24T03:00:00Z");
    expect(refundClock("2026-10-20 03:00:00", 3, now)).toEqual({ since: "2026-10-20 03:00:00", dueBy: "2026-10-23", days: 4, overdue: true });
    expect(refundClock("2026-10-22 03:00:00", 3, now)).toMatchObject({ dueBy: "2026-10-25", days: 2, overdue: false });
    expect(refundClock(null, 3, now)).toMatchObject({ dueBy: "2026-10-27", days: 0, overdue: false });
  });
});

describe("a customer whose refund the venue makes by hand", () => {
  it("is told the date when cancelling, and can follow it by looking the booking up, until it is refunded", async () => {
    const { booking, refunds, paymentId } = await cancelledAfterPaying();
    expect(refunds).toEqual([{ how: "staff", amount: 20, dueBy: addDays(todayISO("UTC"), 3) }]);

    const looked = await (await lookup(new NextRequest(`http://localhost/api/bookings?code=${booking.code}&phone=${booking.phone}`))).json();
    expect(looked.refunds).toEqual([expect.objectContaining({ paymentId, owed: 20, how: "staff", refundedAt: null, clock: expect.objectContaining({ overdue: false }) })]);
    const t = translator("en");
    expect(refundStatusLine(t, looked.refunds[0])).toEqual({ text: expect.stringMatching(/will refund the S\$20 you paid online by \d{4}-\d{2}-\d{2}/), late: false });

    // Past the date: the customer is told to contact the venue.
    await owedFor(paymentId, 5);
    const late = (await refundStatusFor([booking.id]))[0];
    expect(late.clock).toMatchObject({ overdue: true, days: 5 });
    expect(refundStatusLine(t, late)).toEqual({ text: expect.stringMatching(/has not marked it refunded yet\. Please contact the venue/), late: true });

    expect(await markRefunded(paymentId, venueId, null, "DBS transfer 8812")).toMatchObject({ ok: true });
    const done = (await refundStatusFor([booking.id]))[0];
    expect(done).toMatchObject({ owed: 0, refunded: 20, clock: null, refundedAt: expect.any(String) });
    expect(refundStatusLine(t, done).text).toMatch(/^S\$20 refunded on \d{4}-\d{2}-\d{2}\.$/);
  });
});

describe("staff, for refunds they make by hand", () => {
  it("see how long each has been owed and which are overdue, here and on the dashboard", async () => {
    const fresh = await cancelledAfterPaying();
    const old = await cancelledAfterPaying();
    await reconcileRefunds();
    await owedFor(old.paymentId, 6);
    const owed = await refundsOwed(venueId);
    expect(owed.find((p) => p.id === old.paymentId)?.owed).toMatchObject({ days: 6, overdue: true });
    expect(owed.find((p) => p.id === fresh.paymentId)?.owed).toMatchObject({ days: 0, overdue: false });

    expect(await overdueRefunds([venueId])).toEqual([{ venueId, venueName: "Tampines Courts", count: 1, amount: 20, oldestDays: 6 }]);
    expect(await overdueRefunds([venueId + 999])).toEqual([]);
    const board = await (await attention(admin("http://localhost/api/admin/attention"))).json();
    expect(board.refundsOverdue).toEqual([expect.objectContaining({ venueId, count: 1, oldestDays: 6 })]);

    // The daily reminder says how many are past the date.
    await getDb().prepare("UPDATE venues SET refund_digest_at = NULL WHERE id = ?").run(venueId);
    await reconcileRefunds();
    const told = (await getDb().prepare("SELECT body FROM messages WHERE subject LIKE '%waiting for you%' ORDER BY id DESC LIMIT 1").get()) as { body: string };
    // The one owed for six days; the fresh one waits a day before staff are reminded of it.
    expect(told.body).toMatch(/1 online payment is owed back.*1 is past the date customers were told/s);

    for (const p of [fresh, old]) expect(await markRefunded(p.paymentId, venueId)).toMatchObject({ ok: true });
  });

  it("record each with its reference, once: a second click or two people at once record it once, and the log says who and how", async () => {
    const { paymentId } = await cancelledAfterPaying();
    const both = await Promise.all([
      paymentsPost(admin("http://localhost/api/admin/online-payments", { method: "POST", body: { venueId, paymentId, note: "Maybank IBG 5521" } })),
      paymentsPost(admin("http://localhost/api/admin/online-payments", { method: "POST", body: { venueId, paymentId, note: "Maybank IBG 5521" } })),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await markRefunded(paymentId, venueId, null, "again")).toMatchObject({ ok: false });
    const rows = (await getDb().prepare("SELECT amount::float AS amount, note, admin_id FROM online_refunds WHERE payment_id = ?").all(paymentId)) as {
      amount: number;
      note: string;
      admin_id: number | null;
    }[];
    expect(rows).toEqual([{ amount: 20, note: "Maybank IBG 5521", admin_id: expect.any(Number) }]);
    expect(((await getDb().prepare("SELECT refunded::float AS r FROM online_payments WHERE id = ?").get(paymentId)) as { r: number }).r).toBe(20);
    const logged = (await getDb().prepare("SELECT detail FROM staff_actions WHERE action = 'payment.refunded' ORDER BY id DESC LIMIT 1").get()) as { detail: string };
    expect(logged.detail).toMatch(/by hand \(Maybank IBG 5521\)/);
  });

  it("see the work refunds by hand make, month by month, against those made automatically; the owner sees every venue's", async () => {
    await getDb().prepare("DELETE FROM online_refunds").run();
    // One by hand, two days late against a three-day promise.
    const late = await cancelledAfterPaying();
    await owedFor(late.paymentId, 5);
    expect(await markRefunded(late.paymentId, venueId)).toMatchObject({ ok: true });
    // One by hand, on time.
    const prompt = await cancelledAfterPaying();
    await owedFor(prompt.paymentId, 1);
    expect(await markRefunded(prompt.paymentId, venueId)).toMatchObject({ ok: true });
    // One straight back through Stripe.
    await setCancelPolicy(venueId, { onlineRefunds: "gateway" });
    expect((await cancelledAfterPaying()).refunds).toEqual([{ how: "gateway", amount: 20 }]);
    await setCancelPolicy(venueId, { onlineRefunds: "staff" });

    const month = new Date().toISOString().slice(0, 7);
    const work = await refundWorkload(venueId);
    expect(work.months).toEqual([{ month, byHand: 2, byHandAmount: 40, automatic: 1, averageDays: 3, late: 1 }]);
    expect(work).toMatchObject({ owed: 0, overdue: 0, oldestDays: null });

    const venueView = await (await paymentsGet(admin(`http://localhost/api/admin/online-payments?venueId=${venueId}`))).json();
    expect(venueView).toMatchObject({ refundWithinDays: 3, workload: { months: [expect.objectContaining({ byHand: 2 })] } });
    const all = await (await paymentsGet(admin("http://localhost/api/admin/online-payments?workload=all"))).json();
    expect(all.workload.months).toEqual([expect.objectContaining({ month, byHand: 2, automatic: 1 })]);
  });
});
