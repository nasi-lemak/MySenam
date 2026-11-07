import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { chargeToAccount, issueInvoice, listAccounts, saveAccount } from "../src/lib/accounts";
import { createAdmin } from "../src/lib/admin-auth";
import { registerUser } from "../src/lib/auth";
import { xSignature } from "../src/lib/billplz";
import { bookingCancelTerms, setCancelPolicy } from "../src/lib/cancel-policy";
import { counterOwed } from "../src/lib/counter-refunds";
import { getDb } from "../src/lib/db";
import { holdNewBookings, releaseExpiredHolds, setHoldPolicy } from "../src/lib/holds";
import { createPlan, setPlanBenefits } from "../src/lib/membership-plans";
import { createOutage } from "../src/lib/outages";
import { markRefunded, refundOnline, refundsOwed, savePaymentSettings, settleBill, startBookingPayment, startSplitPayment } from "../src/lib/payments";
import { splitBooking } from "../src/lib/splits";
import {
  cancelBooking,
  createBooking,
  createClassSessions,
  createCourt,
  createVenue,
  enrolInClass,
  findBooking,
  getClass,
  getWalletBalance,
  issuePass,
  joinClassWaitlist,
  payBookingFromWallet,
  payBookingWithPass,
  rescheduleBooking,
  sellMembership,
  setPaymentStatus,
  topUpWallet,
  updateVenue,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { POST as callbackRoute } from "../src/app/api/payments/[provider]/callback/route";

/**
 * Cross-domain regression tests, payments and entitlements: how the money rules of the two rounds hold when they meet (stored
 * credit, a pass, a deposit, split shares, a company's invoice, a late or short payment, snapshots of a membership and of
 * cancellation terms taken at different times). Against stand-ins for Billplz and Stripe only: a fake gateway proves MySenam's
 * arithmetic and guards, not that a provider behaves so; those checks stay INTEGRATION_VERIFICATION_REQUIRED. The race tests
 * are meant for real Postgres too (TEST_DATABASE_URL).
 */

vi.setConfig({ testTimeout: 60_000 });

const KEY = "S-xd-key";
const COLLECTION = "colXD";
let venueId: number;
let managerId: number;
let n = 0;
let slotN = 0;
const phone = () => `01877${String(20000 + ++n)}`;

/** Each booking its own day and hour on a court of its own, so nothing clashes. */
const slot = () => {
  const k = slotN++;
  return { date: addDays(todayISO(), 3 + Math.floor(k / 12)), hour: 9 + (k % 12) };
};
async function court(over: { venue?: number; rate?: number; capacity?: number; sport?: string } = {}) {
  const c = await createCourt({ venueId: over.venue ?? venueId, name: `XD Court ${++n}`, sport: (over.sport ?? "badminton") as "badminton", offPeakRate: over.rate ?? 60, peakRate: over.rate ?? 60, ...(over.capacity ? { capacity: over.capacity } : {}) });
  if (!c.ok) throw new Error("court");
  return c.court.id;
}
async function book(courtId: number, over: { userId?: number; phone?: string; email?: string } = {}) {
  const s = slot();
  const ph = over.phone ?? phone();
  const made = await createBooking({ courtId, date: s.date, hours: [s.hour], name: "Aina", phone: ph, email: over.email ?? "aina@example.my", ...(over.userId ? { userId: over.userId } : {}) });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return { booking: made.booking, phone: ph, ...s };
}
async function user(balance = 0) {
  const u = await registerUser({ name: `XD ${++n}`, email: `xd${n}@xd.test`, phone: `0188${String(400000 + n)}`, password: "a long enough password" });
  if (!u.ok) throw new Error(u.error);
  if (balance) await topUpWallet({ userId: u.user.id, amount: balance, adminId: managerId, venueId });
  return u.user;
}
const status = async (id: number) => (await getDb().prepare("SELECT status, payment_status FROM bookings WHERE id = ?").get(id)) as { status: string; payment_status: string };
const expireHold = (id: number) => getDb().prepare("UPDATE bookings SET hold_until = datetime('now', '-1 minutes') WHERE id = ?").run(id);

let billN = 0;
function fakeBillplz() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const id = `xdbill${++billN}`;
      return Response.json({ id, url: `https://www.billplz-sandbox.com/bills/${id}` });
    })
  );
}
/** The payment page opened for one booking (Billplz), returning the bill. */
async function pageFor(code: string, ph: string, deposit = false) {
  fakeBillplz();
  const started = await startBookingPayment({ codes: [code], phone: ph, ...(deposit ? { deposit: true } : {}) });
  vi.unstubAllGlobals();
  if (!started.ok) throw new Error(JSON.stringify(started));
  return (await getDb().prepare("SELECT id, bill_id FROM online_payments ORDER BY id DESC LIMIT 1").get()) as { id: number; bill_id: string };
}
const payment = async (id: number) =>
  (await getDb()
    .prepare("SELECT status, amount::float AS amount, refund_due::float AS due, refunded::float AS refunded, settlement_issue AS issue FROM online_payments WHERE id = ?")
    .get(id)) as { status: string; amount: number; due: number; refunded: number; issue: string | null };

function callbackBody(billId: string, o: { billedSen: number; paidSen: number }) {
  const fields: Record<string, string> = {
    id: billId,
    collection_id: COLLECTION,
    paid: "true",
    state: "paid",
    amount: String(o.billedSen),
    paid_amount: String(o.paidSen),
    due_at: "2026-12-31",
    email: "",
    mobile: "60123456789",
    name: "AINA",
    url: `https://www.billplz-sandbox.com/bills/${billId}`,
    paid_at: `${new Date().toISOString().slice(0, 19).replace("T", " ")} +0000`,
  };
  fields.x_signature = xSignature(fields, KEY);
  return new URLSearchParams(fields).toString();
}
const callback = (billId: string, o: { billedSen: number; paidSen: number }) =>
  callbackRoute(new NextRequest("http://localhost/api/payments/billplz/callback", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: callbackBody(billId, o) }), {
    params: Promise.resolve({ provider: "billplz" }),
  });

beforeAll(async () => {
  const made = await createVenue({ name: "Cross Payments", area: "PJ", address: "x", phone: "0300000074", openMin: 8 * 60, closeMin: 22 * 60 });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  await getDb().prepare("UPDATE venues SET book_ahead_days = 60 WHERE id = ?").run(venueId);
  const mgr = await createAdmin({ name: "Mira", email: "xd-mgr@xd.test", password: "a long enough password", venueId, role: "manager" });
  if (!mgr.ok) throw new Error(mgr.error);
  managerId = mgr.admin.id;
  const saved = await savePaymentSettings(venueId, { apiKey: "api-key-1234", collectionId: COLLECTION, xSignatureKey: KEY, sandbox: true, enabled: true });
  if (!saved.ok) throw new Error(saved.error);
});

afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------------------------------------------------
describe("an entitlement spent as the hold runs out (ADR 0054 + 0062)", () => {
  async function held(courtId: number, userId?: number, phoneNo?: string) {
    const b = await book(courtId, { userId, phone: phoneNo });
    await holdNewBookings([b.booking.id], 15);
    await expireHold(b.booking.id);
    return b;
  }

  it("a pass entry is spent on a booking that stands, or not at all: never on one the sweep let go", async () => {
    let stood = 0;
    let letGo = 0;
    for (let round = 0; round < 6; round++) {
      const c = await court();
      const ph = phone();
      const pass = await issuePass({ venueId, name: "XD Pass", entries: 3, price: 90, holderName: "Aina", holderPhone: ph, expiresOn: addDays(todayISO(), 60), adminId: null });
      if (!pass.ok) throw new Error(JSON.stringify(pass));
      const b = await held(c, undefined, ph);
      const [paid] = await Promise.all([payBookingWithPass(b.booking.id, pass.pass.code), releaseExpiredHolds()]);
      const after = await status(b.booking.id);
      const left = 3 + ((await getDb().prepare("SELECT COALESCE(SUM(delta), 0)::int AS n FROM pass_entries WHERE pass_id = ?").get(pass.pass.id)) as { n: number }).n;
      if (after.status === "confirmed") {
        expect(paid.ok).toBe(true);
        expect(after.payment_status).toBe("paid");
        expect(left).toBe(2);
        stood++;
      } else {
        // Let go first: the pass refused the cancelled booking and every entry is still on it.
        expect(paid.ok).toBe(false);
        expect(left).toBe(3);
        letGo++;
      }
    }
    expect(stood + letGo).toBe(6);
  });

  it("stored credit is taken for a booking that stands, or not at all: the balance and the booking never disagree", async () => {
    let stood = 0;
    let letGo = 0;
    for (let round = 0; round < 6; round++) {
      const u = await user(100);
      const c = await court();
      const b = await held(c, u.id, u.phone);
      await Promise.all([payBookingFromWallet(b.booking.id), releaseExpiredHolds()]);
      const after = await status(b.booking.id);
      const balance = await getWalletBalance(u.id, venueId);
      if (after.status === "confirmed") {
        expect(after.payment_status).toBe("paid");
        expect(balance).toBe(40);
        stood++;
      } else {
        expect(after.payment_status).toBe("unpaid");
        expect(balance).toBe(100);
        letGo++;
      }
    }
    expect(stood + letGo).toBe(6);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("a deposit paid online, the rest at the counter, moved cheaper, then cancelled by the venue (ADR 0067 + 0053 + 0065)", () => {
  let depVenue: number;
  let depDear: number;
  let depMid: number;
  beforeAll(async () => {
    const v = await createVenue({ name: "Cross Deposit", area: "PJ", address: "x", phone: "0300000076", openMin: 8 * 60, closeMin: 22 * 60 });
    if (!v.ok) throw new Error("venue");
    depVenue = v.venue.id;
    await getDb().prepare("UPDATE venues SET book_ahead_days = 60 WHERE id = ?").run(depVenue);
    depDear = await court({ venue: depVenue, rate: 60 });
    depMid = await court({ venue: depVenue, rate: 40 });
    const saved = await savePaymentSettings(depVenue, { apiKey: "api-key-5678", collectionId: "col456", xSignatureKey: "S-key2", sandbox: true, enabled: true });
    if (!saved.ok) throw new Error(saved.error);
    await setHoldPolicy(depVenue, { on: true, depositPercent: 50 });
  });

  it("the deposit goes back whole, the counter part only what is left after the move: RM60 paid, RM60 given back, never RM80", async () => {
    const s = slot();
    const ph = phone();
    const made = await createBooking({ courtId: depDear, date: s.date, hours: [s.hour], name: "Aina", phone: ph, email: "aina@example.my" });
    if (!made.ok) throw new Error(JSON.stringify(made));
    fakeBillplz();
    const started = await startBookingPayment({ codes: [made.booking.code], phone: ph, deposit: true });
    vi.unstubAllGlobals();
    if (!started.ok) throw new Error(JSON.stringify(started));
    const page = (await getDb().prepare("SELECT id, bill_id FROM online_payments ORDER BY id DESC LIMIT 1").get()) as { id: number; bill_id: string };
    await settleBill({ billId: page.bill_id, paid: true, paidAt: null });
    expect((await setPaymentStatus(made.booking.code, true, "cash")).ok).toBe(true);
    // RM30 online as the deposit and RM30 at the counter; moved to RM40: RM20 goes back, from the counter part (move-cheaper.test.ts).
    expect(await rescheduleBooking(made.booking.code, { date: s.date, start: s.hour * 60, courtId: depMid }, "customer")).toMatchObject({ ok: true, money: { refund: { amount: 20, how: "counter" } } });
    expect((await createOutage({ courtId: depMid, startsOn: s.date, endsOn: s.date, adminId: managerId, cancelAffected: true })).ok).toBe(true);
    expect((await status(made.booking.id)).status).toBe("cancelled");
    // Online: the deposit's RM30, whole. At the counter: the RM20 for the move and the RM10 left of the counter part for the outage.
    expect(await payment(page.id)).toMatchObject({ amount: 30, due: 30, refunded: 0 });
    const counter = (await counterOwed([depVenue], "manager")).filter((o) => o.bookingCode === made.booking.code);
    expect(counter.map((o) => [o.cause, o.amount]).sort()).toEqual([["moved_cheaper", 20], ["outage", 10]].sort());
    expect(30 + counter.reduce((sum, o) => sum + o.amount, 0)).toBe(60);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("a split booking with several payers, cancelled by the venue (ADR 0053 + 0065)", () => {
  async function splitOfThree() {
    const c = await court({ rate: 30 });
    const b = await book(c);
    const made = await splitBooking(b.booking.code, b.phone, 3);
    if (!made.ok) throw new Error(made.error);
    return { b, court: c, token: made.split.token };
  }
  async function friendPays(token: string, i: number) {
    fakeBillplz();
    const started = await startSplitPayment(token, { name: `Friend ${i}`, phone: phone(), email: `f${++n}@example.my` });
    vi.unstubAllGlobals();
    if (!started.ok) throw new Error(JSON.stringify(started));
    const row = (await getDb().prepare("SELECT id, bill_id FROM online_payments ORDER BY id DESC LIMIT 1").get()) as { id: number; bill_id: string };
    return row;
  }

  it("each friend's paid share is owed back whole, once; the booker pays nothing; a late third share is owed back too", async () => {
    const { b, court: c, token } = await splitOfThree();
    const one = await friendPays(token, 1);
    const two = await friendPays(token, 2);
    await settleBill({ billId: one.bill_id, paid: true, paidAt: null });
    expect((await findBooking(b.booking.code, b.phone))!.sharesPaid).toBe(10);
    // The second friend has the page open when the venue cancels, and pays after it.
    expect((await createOutage({ courtId: c, startsOn: b.date, endsOn: b.date, adminId: managerId, cancelAffected: true })).ok).toBe(true);
    expect((await status(b.booking.id)).status).toBe("cancelled");
    expect(await payment(one.id)).toMatchObject({ amount: 10, due: 10, refunded: 0 });
    await settleBill({ billId: two.bill_id, paid: true, paidAt: null });
    await settleBill({ billId: two.bill_id, paid: true, paidAt: null });
    // Not counted into a cancelled booking, owed back whole, once; and no payer is owed more than they paid.
    expect(await payment(two.id)).toMatchObject({ status: "paid", amount: 10, due: 10, refunded: 0 });
    expect((await findBooking(b.booking.code, b.phone))!.sharesPaid).toBe(10);
    const all = (await refundsOwed(venueId)).filter((p) => [one.id, two.id].includes(p.id));
    expect(all.map((p) => p.refundOwed)).toEqual([10, 10]);
  });

  it("a share settling as the venue cancels ends owed back whole, never counted into the cancelled booking", async () => {
    let bad = 0;
    for (let round = 0; round < 4; round++) {
      const { b, court: c, token } = await splitOfThree();
      const one = await friendPays(token, 1);
      await Promise.all([
        settleBill({ billId: one.bill_id, paid: true, paidAt: null }),
        createOutage({ courtId: c, startsOn: b.date, endsOn: b.date, adminId: managerId, cancelAffected: true }),
      ]);
      const after = await status(b.booking.id);
      const p = await payment(one.id);
      if (after.status === "cancelled" && p.status === "paid" && p.due !== p.amount) bad++;
    }
    expect(bad).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("a company invoice, a cheaper move and a venue cancellation (ADR 0061 + 0067 + 0053)", () => {
  it("the account is credited for the difference, then for the rest: together the booking's price once, the invoice as issued", async () => {
    const dear = await court({ rate: 20 });
    const cheap = await court({ rate: 10 });
    const acct = await saveAccount(venueId, { name: `Co ${++n}`, email: `co${n}@co.test` });
    if (!acct.ok) throw new Error(acct.error);
    const date = addDays(todayISO(), 4);
    const made = await createBooking({ courtId: dear, date, hours: [9], name: "Cikgu", phone: phone() });
    if (!made.ok) throw new Error(JSON.stringify(made));
    expect((await chargeToAccount(venueId, acct.account.id, [made.booking.id])).ok).toBe(true);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${date}T07:00:00+08:00`));
    const invoice = (await issueInvoice(acct.account.id, date.slice(0, 7), { email: false }))!;
    vi.useRealTimers();
    expect(invoice).toBeTruthy();
    const total = invoice.total;
    const moved = await rescheduleBooking(made.booking.code, { date, start: 9 * 60, courtId: cheap }, "staff");
    expect(moved).toMatchObject({ ok: true, accountCredited: 10 });
    const out = await createOutage({ courtId: cheap, startsOn: date, endsOn: date, adminId: managerId, cancelAffected: true });
    expect(out.ok).toBe(true);
    expect((await status(made.booking.id)).status).toBe("cancelled");
    const credit = (await listAccounts(venueId)).find((a) => a.id === acct.account.id)!.credit;
    // 10 for the move and 10 for the cancellation: the 20 charged, once, never above it.
    expect(credit).toBe(20);
    expect(credit).toBeLessThanOrEqual(total);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("a payment that arrives late or short, and the worklist that follows (ADR 0065 + 0066 + 0070)", () => {
  async function lapsedAndPaid() {
    const c = await court({ rate: 20 });
    const b = await book(c);
    await holdNewBookings([b.booking.id], 15);
    const page = await pageFor(b.booking.code, b.phone);
    await expireHold(b.booking.id);
    await releaseExpiredHolds();
    await callback(page.bill_id, { billedSen: 2000, paidSen: 2000 });
    return { b, page };
  }

  it("Billplz late payment: owed back whole, on the refunds worklist, and marked refunded once by staff (a hand mark is not a gateway refund)", async () => {
    const { b, page } = await lapsedAndPaid();
    expect(await payment(page.id)).toMatchObject({ amount: 20, due: 20, refunded: 0, issue: "hold_lapsed" });
    expect((await status(b.booking.id)).status).toBe("cancelled");
    expect((await refundsOwed(venueId)).some((p) => p.id === page.id)).toBe(true);
    const marks = await Promise.all([markRefunded(page.id, venueId, managerId, "bank transfer ref 1"), markRefunded(page.id, venueId, managerId, "bank transfer ref 1")]);
    expect(marks.filter((m) => m.ok)).toHaveLength(1);
    expect(await payment(page.id)).toMatchObject({ due: 20, refunded: 20 });
    expect((await refundsOwed(venueId)).some((p) => p.id === page.id)).toBe(false);
    // The booking itself is still cancelled and unpaid: refunding the money never revives it.
    expect(await status(b.booking.id)).toEqual({ status: "cancelled", payment_status: "unpaid" });
  });

  it("Billplz has no refund API: asking the gateway to refund it is refused, with the money still owed", async () => {
    const { page } = await lapsedAndPaid();
    const asked = await refundOnline(page.id, venueId, managerId);
    expect(asked.ok).toBe(false);
    expect(await payment(page.id)).toMatchObject({ due: 20, refunded: 0 });
  });

  it("a short payment on a held class place: the place stays held until the hold ends, then the waiting list is offered it and the short money stays owed whole", async () => {
    const studio = await court({ rate: 5, capacity: 20, sport: "gym" });
    const made = await createClassSessions({ courtId: studio, name: `XD Spin ${++n}`, instructor: "Ravi", date: addDays(todayISO(), 9), startHour: 18, endHour: 19, capacity: 1, price: 30 });
    if (!made.ok) throw new Error(made.error);
    const cls = made.classes[0];
    const ph = phone();
    const e = await enrolInClass({ classId: cls.id, name: "Holder", phone: ph, email: "holder@example.my" });
    if (!e.ok) throw new Error(e.error);
    await holdNewBookings([e.booking.id], 10);
    const waiterPhone = phone();
    expect((await joinClassWaitlist({ classId: cls.id, name: "Waiter", phone: waiterPhone })).ok).toBe(true);
    const page = await pageFor(e.booking.code, ph);
    // Billplz reports RM12 of the RM30 asked: nothing settles, the hold is not cleared, and the place is nobody else's yet.
    await callback(page.bill_id, { billedSen: 3000, paidSen: 1200 });
    expect(await payment(page.id)).toMatchObject({ amount: 12, due: 12, issue: "underpaid" });
    expect(await status(e.booking.id)).toEqual({ status: "confirmed", payment_status: "unpaid" });
    expect((await getClass(cls.id))!.enrolled).toBe(1);
    expect(((await getDb().prepare("SELECT status FROM waitlist WHERE phone = ?").get(waiterPhone)) as { status: string }).status).toBe("waiting");
    // The customer opens a page for the rest while the hold still runs.
    const rest = await pageFor(e.booking.code, ph);
    // The hold ends: the place is let go and offered; the short money is still owed back whole, listed.
    await expireHold(e.booking.id);
    expect(await releaseExpiredHolds()).toBeGreaterThanOrEqual(1);
    expect(await status(e.booking.id)).toEqual({ status: "cancelled", payment_status: "unpaid" });
    expect(((await getDb().prepare("SELECT status FROM waitlist WHERE phone = ?").get(waiterPhone)) as { status: string }).status).toBe("offered");
    expect(await payment(page.id)).toMatchObject({ amount: 12, due: 12, refunded: 0 });
    expect((await refundsOwed(venueId)).find((p) => p.id === page.id)).toMatchObject({ refundOwed: 12 });
    // The rest, from a page opened while the hold still ran, arrives after the place was let go: owed back too, it never revives the
    // booking, and the place offered to the waiting list is not taken.
    await callback(rest.bill_id, { billedSen: 3000, paidSen: 3000 });
    expect(await status(e.booking.id)).toEqual({ status: "cancelled", payment_status: "unpaid" });
    expect(await payment(rest.id)).toMatchObject({ amount: 30, due: 30, issue: "hold_lapsed" });
    expect(((await getDb().prepare("SELECT status FROM waitlist WHERE phone = ?").get(waiterPhone)) as { status: string }).status).toBe("offered");
    expect((await getClass(cls.id))!.enrolled).toBe(0);
    expect((await refundsOwed(venueId)).filter((p) => [page.id, rest.id].includes(p.id)).map((p) => p.refundOwed).sort((a, b) => a - b)).toEqual([12, 30]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("a membership's benefits, a booking's cancellation terms and a cheaper move, each sold or taken at a different time (ADR 0069 + 0071 + 0067)", () => {
  it("edits made after the sale change none of the three: the move prices on the member's term, the cancel on the booking's terms, and the money adds up", async () => {
    const dear = await court({ rate: 20 });
    const cheap = await court({ rate: 10 });
    await updateVenue(venueId, { cancelCutoffHours: 2 });
    expect((await setCancelPolicy(venueId, { lateKeep: null, giveBack: false })).ok).toBe(true);
    const plan = await createPlan(venueId, { name: `XD Gold ${n}`, months: 12, price: 500, ratePercent: 70, aheadDays: 30 });
    if (!plan.ok) throw new Error(plan.error);
    const ph = phone();
    const sold = await sellMembership({ venueId, holderName: "Member", holderPhone: ph, startsOn: todayISO(), expiresOn: addDays(todayISO(), 90), price: 100, planId: plan.plan.id });
    if (!sold.ok) throw new Error(sold.error);

    // Booked two days ahead as a member: 70% of 20 = 14. Its terms (a two-hour cutoff, no late share) are taken now.
    const b = await book(dear, { phone: ph });
    const date = b.date;
    expect(b.booking.totalPrice).toBe(14);
    expect(await setPaymentStatus(b.booking.code, true, "cash")).toMatchObject({ ok: true });
    const snap = await bookingCancelTerms(b.booking.id);
    expect(snap).toMatchObject({ source: "booked", cutoffHours: 2 });

    // After the sale: the plan is made worse (95%), the venue's cutoff becomes three days and keeps the whole price.
    expect((await setPlanBenefits(venueId, plan.plan.id, { ratePercent: 95, aheadDays: 7, confirmAboveMemberRate: true })).ok).toBe(true);
    await updateVenue(venueId, { cancelCutoffHours: 72 });
    expect((await setCancelPolicy(venueId, { lateKeep: 100, giveBack: false })).ok).toBe(true);

    // The move keeps the discount the member was sold (RM6 off the RM20, ADR 0067 D3): RM10 less RM6 is RM4, so RM10 goes back.
    // The plan edit (95%) is not asked.
    const moved = await rescheduleBooking(b.booking.code, { date, start: b.hour * 60, courtId: cheap }, "customer");
    expect(moved).toMatchObject({ ok: true, money: { settles: "refund", newPrice: 4, refund: { amount: 10, how: "counter" } } });
    // A member sold after the edit is priced on the edited plan: the edit is real, it is just not retroactive.
    const later = await sellMembership({ venueId, holderName: "Later", holderPhone: phone(), startsOn: todayISO(), expiresOn: addDays(todayISO(), 90), price: 100, planId: plan.plan.id });
    if (!later.ok) throw new Error(later.error);
    expect((await book(dear, { phone: later.membership.holderPhone })).booking.totalPrice).toBe(19);
    // The cancellation terms are still the booking's own after the move and after the edit.
    expect(await bookingCancelTerms(b.booking.id)).toMatchObject({ source: "booked", cutoffHours: 2, lateKeep: null });

    // Cancelled by the customer on those terms: free (the new 72-hour rule, which would refuse it, never applied), and the credit
    // note is for the rest (4), so with the move's 10 the whole 14 is accounted for once.
    const cancelled = await cancelBooking(b.booking.code, ph);
    expect(cancelled).toMatchObject({ ok: true });
    expect((await status(b.booking.id)).status).toBe("cancelled");
    const note = (await getDb().prepare("SELECT COALESCE(SUM(total), 0)::float AS total FROM receipts WHERE source = ? AND kind = 'credit_note'").get(`booking:${b.booking.id}`)) as { total: number };
    expect(note.total).toBe(4);
    const owed = (await counterOwed([venueId], "manager")).filter((o) => o.bookingCode === b.booking.code);
    expect(owed.map((o) => [o.cause, o.amount])).toEqual([["moved_cheaper", 10]]);
  });
});
