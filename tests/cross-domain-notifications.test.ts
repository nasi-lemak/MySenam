import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { setCancelPolicy } from "../src/lib/cancel-policy";
import { counterOwed, settleOwed, type CancellingStaff } from "../src/lib/counter-refunds";
import { getDb } from "../src/lib/db";
import { drainOutbox, maxMessageAgeDays, messageById, messagesForBooking, outboxSummary, retryFailedMessages, setTransport, type OutboxMessage } from "../src/lib/outbox";
import { refundsOwed, savePaymentSettings, settleBill, startBookingPayment } from "../src/lib/payments";
import {
  cancelSeries,
  createBooking,
  createBookingSeries,
  createCourt,
  createVenue,
  seriesCancelPlan,
  setPaymentStatus,
  updateVenue,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { POST as closeDayRoute } from "../src/app/api/admin/venues/[id]/closures/route";

/**
 * Cross-domain regression tests, notifications and recovery: what the venue's cancellations do to money and to the messages that tell
 * the customer while a provider is down, when a message is given up, and when part of a weekly series is cancelled by the venue and
 * the rest by the customer on the terms it was sold on (ADR 0053, 0056, 0066, 0069). The scenarios the existing suites already hold on
 * their own (outbox-reliability, webhook-failed-deliveries, billplz-settlement's out-of-order callbacks and no-contact payers,
 * outbox reminders for moved bookings) are listed in the round's report. Stand-in transports only: no provider, email address or
 * customer is contacted, and nothing here is a delivery check against a real provider.
 */

vi.setConfig({ testTimeout: 60_000 });

let venueId: number;
let managerCookie: string;
let n = 0;
let dayN = 0;
const manager: CancellingStaff = { id: null, name: "Mira (manager)", role: "manager" };
const phone = () => `01899${String(30000 + ++n)}`;
const sent: OutboxMessage[] = [];
const recorder = () =>
  setTransport({
    name: "recorder",
    async send(m) {
      sent.push(m);
    },
  });
const down = (why = "401 token expired") =>
  setTransport({
    name: "down",
    async send() {
      throw new Error(why);
    },
  });
const everythingDue = () => getDb().prepare("UPDATE messages SET next_attempt_at = datetime('now', '-1 minute') WHERE status IN ('queued','failed')").run();

afterEach(() => {
  setTransport(null);
  sent.length = 0;
  vi.unstubAllGlobals();
});

beforeAll(async () => {
  const made = await createVenue({ name: "Cross Notices", area: "PJ", address: "x", phone: "0300000077", openMin: 8 * 60, closeMin: 22 * 60 });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  await getDb().prepare("UPDATE venues SET book_ahead_days = 60 WHERE id = ?").run(venueId);
  await updateVenue(venueId, { cancelCutoffHours: 48 });
  const mgr = await createAdmin({ name: "Mira", email: "xn-mgr@xn.test", password: "a long enough password", venueId, role: "manager" });
  if (!mgr.ok) throw new Error(mgr.error);
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(mgr.admin.id)).token}`;
  const saved = await savePaymentSettings(venueId, { apiKey: "api-key-1234", collectionId: "colXN", xSignatureKey: "S-xn-key", sandbox: true, enabled: true });
  if (!saved.ok) throw new Error(saved.error);
});

async function court(rate = 20) {
  const c = await createCourt({ venueId, name: `XN Court ${++n}`, sport: "badminton", offPeakRate: rate, peakRate: rate });
  if (!c.ok) throw new Error("court");
  return c.court.id;
}
/** A day of its own that a test may close. */
const closableDay = () => addDays(todayISO(), 10 + dayN++);

const closeDay = (date: string) =>
  closeDayRoute(
    new NextRequest(`http://localhost/api/admin/venues/${venueId}/closures`, {
      method: "POST",
      headers: { cookie: managerCookie, "content-type": "application/json", "x-forwarded-for": "10.7.7.12" },
      body: JSON.stringify({ date, reason: "Flood", cancelAffected: true }),
    }),
    { params: Promise.resolve({ id: String(venueId) }) }
  );

let billN = 0;
async function paidOnline(courtId: number, date: string, hour: number, email: string | null) {
  const ph = phone();
  const made = await createBooking({ courtId, date, hours: [hour], name: "Aina", phone: ph, ...(email ? { email } : {}) });
  if (!made.ok) throw new Error(JSON.stringify(made));
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: `xnbill${++billN}`, url: `https://www.billplz-sandbox.com/bills/xnbill${billN}` })));
  const started = await startBookingPayment({ codes: [made.booking.code], phone: ph });
  vi.unstubAllGlobals();
  if (!started.ok) throw new Error(JSON.stringify(started));
  const row = (await getDb().prepare("SELECT id, bill_id FROM online_payments ORDER BY id DESC LIMIT 1").get()) as { id: number; bill_id: string };
  await settleBill({ billId: row.bill_id, paid: true, paidAt: null });
  return { booking: made.booking, paymentId: row.id };
}
const payment = async (id: number) =>
  (await getDb().prepare("SELECT amount::float AS amount, refund_due::float AS due, refunded::float AS refunded FROM online_payments WHERE id = ?").get(id)) as { amount: number; due: number; refunded: number };
const venueCancelNotices = async (bookingId: number) => (await messagesForBooking(bookingId)).filter((m) => m.kind === "booking_cancelled_by_venue");

describe("a day closed while the message provider is down (ADR 0053 + 0056 + 0066)", () => {
  it("the money is owed and listed at once, the notices wait and go out once when the provider is back, however many sweeps race", async () => {
    const date = closableDay();
    const c = await court(20);
    down();
    const online = await paidOnline(c, date, 9, "online@xn.test");
    const noMail = await paidOnline(c, date, 10, null);
    const counterMade = await createBooking({ courtId: c, date, hours: [11], name: "Budi", phone: phone(), email: "counter@xn.test" });
    if (!counterMade.ok) throw new Error(JSON.stringify(counterMade));
    expect(await setPaymentStatus(counterMade.booking.code, true, "cash")).toMatchObject({ ok: true });

    expect((await closeDay(date)).status).toBe(201);
    // The money does not wait for the provider: online money owed and listed, counter money on the counter list, with or without an address.
    expect(await payment(online.paymentId)).toEqual({ amount: 20, due: 20, refunded: 0 });
    expect(await payment(noMail.paymentId)).toEqual({ amount: 20, due: 20, refunded: 0 });
    const owedOnline = (await refundsOwed(venueId)).filter((p) => [online.paymentId, noMail.paymentId].includes(p.id));
    expect(owedOnline).toHaveLength(2);
    expect((await counterOwed([venueId], "manager")).filter((o) => o.bookingCode === counterMade.booking.code)).toMatchObject([{ amount: 20, cause: "closure" }]);

    // The notices are written (an email where there is an address, a WhatsApp message to the number) and not lost through hours of failures.
    const told = [...(await venueCancelNotices(online.booking.id)), ...(await venueCancelNotices(counterMade.booking.id)), ...(await venueCancelNotices(noMail.booking.id))];
    expect(told.map((m) => m.channel).sort()).toEqual(["email", "email", "whatsapp", "whatsapp", "whatsapp"]);
    expect((await venueCancelNotices(noMail.booking.id)).map((m) => m.channel)).toEqual(["whatsapp"]);
    for (let i = 0; i < 6; i++) {
      await everythingDue();
      await drainOutbox();
    }
    for (const m of told) expect(await messageById(m.id)).toMatchObject({ status: "failed" });
    expect(sent).toHaveLength(0);
    // The outage does not touch the money: still exactly what was owed.
    expect(await payment(online.paymentId)).toEqual({ amount: 20, due: 20, refunded: 0 });

    // The provider is back, and two sweeps run at once: each notice is sent once.
    recorder();
    await everythingDue();
    await Promise.all([drainOutbox(), drainOutbox()]);
    for (const m of told) expect((await messageById(m.id))!.status).toBe("sent");
    const goneOut = () => sent.filter((m) => m.kind === "booking_cancelled_by_venue").map((m) => m.id).sort((a, b) => a - b);
    expect(goneOut()).toEqual(told.map((m) => m.id).sort((a, b) => a - b));
    await everythingDue();
    await drainOutbox();
    expect(goneOut()).toHaveLength(told.length);
    // And the money is still owed: delivering a notice settles nothing.
    expect(await payment(online.paymentId)).toEqual({ amount: 20, due: 20, refunded: 0 });
  });

  it("a notice given up for age is counted for the venue and is not resent, a fresh one still is, once; and what the customer is owed is on the worklist throughout", async () => {
    const date = closableDay();
    const c = await court(20);
    const stale = await paidOnline(c, date, 9, "stale@xn.test");
    const fresh = await paidOnline(c, date, 10, "fresh@xn.test");
    down("SES account suspended");
    expect((await closeDay(date)).status).toBe(201);
    const [staleNotice] = (await venueCancelNotices(stale.booking.id)).filter((m) => m.channel === "email");
    const [freshNotice] = (await venueCancelNotices(fresh.booking.id)).filter((m) => m.channel === "email");
    expect(staleNotice && freshNotice).toBeTruthy();
    // One has been tried for longer than any is kept: given up, and visible as such. The other is only waiting for its next try.
    await getDb().prepare("UPDATE messages SET created_at = datetime('now', ?) WHERE id = ?").run(`-${maxMessageAgeDays() + 1} days`, staleNotice.id);
    await everythingDue();
    await drainOutbox();
    expect(await messageById(staleNotice.id)).toMatchObject({ status: "abandoned" });
    expect(await messageById(freshNotice.id)).toMatchObject({ status: "failed" });
    expect((await outboxSummary(venueId)).abandoned).toBeGreaterThanOrEqual(1);
    // Neither customer's refund depends on a message: both are on the worklist.
    expect((await refundsOwed(venueId)).filter((p) => [stale.paymentId, fresh.paymentId].includes(p.id))).toHaveLength(2);
    // Staff send the failed ones again once the provider works: the fresh notice goes once; the stale one is skipped, not sent weeks late.
    recorder();
    const stamp = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
    const window = { since: stamp(Date.now() - 30 * 86_400_000), until: stamp(Date.now() + 60_000) };
    const done = await retryFailedMessages(venueId, window);
    expect(done.skipped.stale).toBeGreaterThanOrEqual(1);
    await everythingDue();
    await Promise.all([drainOutbox(), drainOutbox()]);
    expect(await messageById(freshNotice.id)).toMatchObject({ status: "sent" });
    expect(await messageById(staleNotice.id)).toMatchObject({ status: "abandoned" });
    expect(sent.filter((m) => m.id === freshNotice.id)).toHaveLength(1);
    expect(sent.some((m) => m.id === staleNotice.id)).toBe(false);
    expect(await payment(stale.paymentId)).toEqual({ amount: 20, due: 20, refunded: 0 });
  });
});

describe("one week of a weekly series cancelled by the venue, the rest by the customer on the terms it was sold on (ADR 0053 + 0069)", () => {
  async function paidSeries() {
    const c = await court(20);
    const who = phone();
    const made = await createBookingSeries({ courtId: c, date: addDays(todayISO(), 12), hours: [17], weeks: 3, name: "Liga", phone: who, email: "liga@xn.test" });
    if (!made.ok) throw new Error(made.error);
    const rows = (await getDb().prepare("SELECT id, code, date FROM bookings WHERE series_code = ? ORDER BY date").all(made.seriesCode)) as { id: number; code: string; date: string }[];
    for (const r of rows) expect((await setPaymentStatus(r.code, true, "cash")).ok).toBe(true);
    return { seriesCode: made.seriesCode!, phone: who, rows };
  }
  const state = async (code: string) => ((await getDb().prepare("SELECT status FROM bookings WHERE code = ?").get(code)) as { status: string }).status;
  const notes = async (seriesCode: string) =>
    ((await getDb()
      .prepare("SELECT COUNT(*)::int AS n FROM receipts WHERE kind = 'credit_note' AND source IN (SELECT 'booking:' || id FROM bookings WHERE series_code = ?)")
      .get(seriesCode)) as { n: number }).n;

  it("the closed week is owed once by the venue's cancellation and never again by the series' cancel; the others go on their own terms, each credited once", async () => {
    await setCancelPolicy(venueId, { lateKeep: 50 });
    const s = await paidSeries();
    // The series was sold on a 48-hour cutoff and a half-price late share; the venue then stops allowing late cancels altogether.
    await setCancelPolicy(venueId, { lateKeep: null });
    // The second week's day is closed (counter money owed back), and the customer then cancels the whole series.
    expect((await closeDay(s.rows[1].date)).status).toBe(201);
    expect(await state(s.rows[1].code)).toBe("cancelled");
    const owed = (await counterOwed([venueId], "manager")).filter((o) => o.bookingCode === s.rows[1].code);
    expect(owed).toMatchObject([{ amount: 20, cause: "closure" }]);
    const plan = await seriesCancelPlan(s.seriesCode, s.phone);
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.weeks.map((w) => w.code)).not.toContain(s.rows[1].code);
    const done = await cancelSeries(s.seriesCode, s.phone);
    expect(done).toMatchObject({ ok: true, cancelled: 2 });
    expect((await state(s.rows[0].code)) + (await state(s.rows[2].code))).toBe("cancelledcancelled");
    // Asked twice at once: nothing is cancelled or credited a second time.
    const again = await Promise.all([cancelSeries(s.seriesCode, s.phone), cancelSeries(s.seriesCode, s.phone)]);
    expect(again.reduce((sum, r) => sum + (r.ok ? r.cancelled : 0), 0)).toBe(0);
    expect(await notes(s.seriesCode)).toBe(2);
    // Settling the closed week's owed money adds its own credit note, once, and the three weeks' credit notes are the three weeks paid.
    expect(await settleOwed(owed[0].id, "back", manager)).toMatchObject({ ok: true, settled: { refund: 20 } });
    expect(await settleOwed(owed[0].id, "back", manager)).toMatchObject({ ok: false });
    expect(await notes(s.seriesCode)).toBe(3);
    const paidOut = (await getDb().prepare("SELECT COALESCE(SUM(amount), 0)::float AS s FROM counter_payouts WHERE booking_id = ?").get((await getDb().prepare("SELECT id FROM bookings WHERE code = ?").get(s.rows[1].code) as { id: number }).id)) as { s: number };
    expect(paidOut.s).toBe(20);
  });
});
