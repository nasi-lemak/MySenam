import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { authenticateAdmin, ensureBootstrapAdmin, createAdmin } from "../src/lib/admin-auth";
import { ADMIN_SESSION_COOKIE, createAdminSession } from "../src/lib/admin-auth";
import { chargeToAccount, issueInvoice, listAccounts, markInvoicePaid, saveAccount } from "../src/lib/accounts";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { applyAskedDiscounts } from "../src/lib/booking-discounts";
import { saveConcession } from "../src/lib/concessions";
import { counterOwed, counterPaymentOn, settleOwed, type CancellingStaff } from "../src/lib/counter-refunds";
import { listActivity } from "../src/lib/activity";
import { getDb } from "../src/lib/db";
import { documentFor } from "../src/lib/documents";
import { setLastMinute } from "../src/lib/peak";
import { setHoldPolicy } from "../src/lib/holds";
import { savePaymentSettings, settleBill, startBookingPayment } from "../src/lib/payments";
import {
  adminCancelBooking,
  cancelBooking,
  createBooking,
  createBookingSeries,
  createCourt,
  createVenue,
  findBooking,
  getBookingById,
  getWalletBalance,
  issuePass,
  payBookingFromWallet,
  payBookingWithPass,
  rescheduleBooking,
  setPaymentStatus,
  topUpWallet,
} from "../src/lib/store";
import { moveSeries, previewSeriesMove } from "../src/lib/series-moves";
import { addDays, slotStartsAt, todayISO } from "../src/lib/time";
import { POST as customerReschedule } from "../src/app/api/bookings/reschedule/route";
import { POST as staffReschedule } from "../src/app/api/admin/bookings/reschedule/route";

/**
 * A paid booking moved to a cheaper time gives the difference back the way it was paid (ADR 0067; audit B16 = C12 = D15, DEC-16):
 * paid at the counter it is owed back on the counter list, paid online it is owed back on the payment, from credit it goes back to
 * credit, with a pass nothing moves, on an issued company invoice it is a credit note on the account. Cash is never turned into
 * credit; a price is never made free by a kept discount (D3); a last-minute price stays where its terms hold (B11).
 */

const ZONE = "Asia/Kuala_Lumpur";
await ensureBootstrapAdmin();
const owner = (await authenticateAdmin("admin@mysenam.my", "mysenam-admin"))!;
const ownerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(owner.id)).token}`;
const manager: CancellingStaff = { id: null, name: "Mira (manager)", role: "manager" };

let venueId: number;
let dear: number; // RM60, flat
let cheap: number; // RM25, flat
let lowest: number; // RM20, flat
let managerId: number;
let deskCookie: string;
let n = 0;
let slotN = 0;
const phone = () => `01877${String(10000 + ++n)}`;

/** Each booking its own day and hour so none clash on the same court. */
function slot() {
  const k = slotN++;
  return { date: addDays(todayISO(ZONE), 3 + Math.floor(k / 8)), hour: 9 + (k % 8) };
}

async function book(over: { court?: number; phone?: string; userId?: number } = {}) {
  const s = slot();
  const ph = over.phone ?? phone();
  const made = await createBooking({ courtId: over.court ?? dear, date: s.date, hours: [s.hour], name: "Aina", phone: ph, email: "aina@example.my", ...(over.userId ? { userId: over.userId } : {}) });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return { booking: made.booking, phone: ph, ...s };
}

async function userWith(balance: number) {
  const made = await registerUser({ name: `Credit ${++n}`, email: `mc${n}@mc.test`, phone: `0188${String(100000 + n)}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await topUpWallet({ userId: made.user.id, amount: balance, adminId: managerId, venueId });
  return { ...made.user, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}

function fakeBillplz() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const id = `mcbill${++n}`;
      return Response.json({ id, url: `https://www.billplz-sandbox.com/bills/${id}` });
    })
  );
}

async function paidOnline() {
  const b = await book();
  fakeBillplz();
  const started = await startBookingPayment({ codes: [b.booking.code], phone: b.phone });
  if (!started.ok) throw new Error(JSON.stringify(started));
  const bill = (await getDb().prepare("SELECT id, bill_id FROM online_payments ORDER BY id DESC LIMIT 1").get()) as { id: number; bill_id: string };
  await settleBill({ billId: bill.bill_id, paid: true, paidAt: null });
  expect(await findBooking(b.booking.code, b.phone)).toMatchObject({ paymentStatus: "paid", paidVia: "online", totalPrice: 60 });
  return { ...b, paymentId: bill.id };
}

const payment = async (id: number) =>
  (await getDb().prepare("SELECT amount::float AS amount, refund_due::float AS due, refunded::float AS refunded FROM online_payments WHERE id = ?").get(id)) as { amount: number; due: number; refunded: number };
const moves = async (bookingId: number) =>
  (await getDb()
    .prepare("SELECT amount::float AS amount, how, moved_by, paid_before::float AS paid_before, price_after::float AS price_after FROM booking_move_refunds WHERE booking_id = ? ORDER BY id")
    .all(bookingId)) as { amount: number; how: string; moved_by: string; paid_before: number; price_after: number }[];
const moveNotes = async (bookingId: number) =>
  (await getDb().prepare("SELECT total::float AS total, paid_via FROM receipts WHERE kind = 'credit_note' AND source LIKE ?").all(`booking:${bookingId}:move:%`)) as { total: number; paid_via: string | null }[];
const customerMove = (b: { booking: { code: string }; phone: string; date: string }, hour: number, extra: Record<string, unknown> = {}) =>
  customerReschedule(
    new NextRequest("http://localhost/api/bookings/reschedule", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${(++n % 200) + 1}` },
      body: JSON.stringify({ code: b.booking.code, phone: b.phone, date: b.date, start: hour * 60, ...extra }),
    })
  );

beforeAll(async () => {
  const made = await createVenue({ name: "Cheaper Hall", area: "PJ", address: "x", phone: "0300000067", openMin: 8 * 60, closeMin: 22 * 60 });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  for (const [name, rate] of [["Dear", 60], ["Cheap", 25], ["Lowest", 20]] as const) {
    const c = await createCourt({ venueId, name, sport: "badminton", offPeakRate: rate, peakRate: rate });
    if (!c.ok) throw new Error("court");
    if (name === "Dear") dear = c.court.id;
    if (name === "Cheap") cheap = c.court.id;
    if (name === "Lowest") lowest = c.court.id;
  }
  const saved = await savePaymentSettings(venueId, { apiKey: "api-key-1234", collectionId: "col123", xSignatureKey: "S-key", sandbox: true, enabled: true });
  if (!saved.ok) throw new Error(saved.error);
  const mgr = await createAdmin({ name: "Mira", email: "mc-mgr@mc.test", password: "a long enough password", venueId, role: "manager" });
  if (!mgr.ok) throw new Error(mgr.error);
  managerId = mgr.admin.id;
  const desk = await createAdmin({ name: "Dewi", email: "mc-desk@mc.test", password: "a long enough password", venueId, role: "desk" });
  if (!desk.ok) throw new Error(desk.error);
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
  await getDb().prepare("UPDATE venues SET published_at = datetime('now') WHERE id = ?").run(venueId);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("paid at the counter, moved to a cheaper time", () => {
  it("is owed back on the counter list, never said to be paid, and the receipt and price stay as sold", async () => {
    const b = await book();
    expect(await setPaymentStatus(b.booking.code, true, "cash")).toMatchObject({ ok: true });
    const moved = await rescheduleBooking(b.booking.code, { date: b.date, start: b.hour * 60, courtId: cheap }, "customer");
    expect(moved).toMatchObject({ ok: true, priceChange: 0, unchargedDifference: 0, money: { settles: "refund", oldPrice: 60, newPrice: 25, difference: -35, refund: { amount: 35, how: "counter" } } });
    // The price stays as sold; what is owed back is a row of its own and a line on the list staff settle from.
    expect(await findBooking(b.booking.code, b.phone)).toMatchObject({ totalPrice: 60, paymentStatus: "paid", paidVia: "cash", courtId: cheap });
    expect(await moves(b.booking.id)).toEqual([{ amount: 35, how: "counter", moved_by: "customer", paid_before: 60, price_after: 25 }]);
    const owed = (await counterOwed([venueId], "manager")).find((o) => o.bookingCode === b.booking.code)!;
    expect(owed).toMatchObject({ amount: 35, cause: "moved_cheaper", via: "cash", settled: null });
    // Nothing has left the till: no credit note, no payout until staff hand it back.
    expect(await moveNotes(b.booking.id)).toEqual([]);
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM counter_payouts WHERE booking_id = ?").get(b.booking.id)) as { n: number }).n).toBe(0);
    // A cancellation now owes back only what is left paid: 25, never the 60 again.
    expect(await counterPaymentOn(b.booking.id)).toBe(25);
  });

  it("staff settle it once: handed back the way it was paid, with its own credit note and a payout; settling twice is refused", async () => {
    const b = await book();
    await setPaymentStatus(b.booking.code, true, "qr");
    await rescheduleBooking(b.booking.code, { date: b.date, start: b.hour * 60, courtId: lowest }, "customer");
    const owed = (await counterOwed([venueId], "manager")).find((o) => o.bookingCode === b.booking.code)!;
    expect(owed.amount).toBe(40);
    const done = await settleOwed(owed.id, "back", manager);
    expect(done).toMatchObject({ ok: true, settled: { outcome: "back", refund: 40, paidOut: { amount: 40, via: "qr" } } });
    expect(await moveNotes(b.booking.id)).toEqual([{ total: 40, paid_via: "DuitNow QR / e-wallet" }]);
    expect(await settleOwed(owed.id, "back", manager)).toMatchObject({ ok: false });
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM counter_payouts WHERE booking_id = ?").get(b.booking.id)) as { n: number }).n).toBe(1);
  });

  it("is given as stored credit only when staff settle it so, for an account (cash is never turned into credit by the move itself)", async () => {
    const who = await userWith(0);
    const b = await book({ userId: who.id });
    await setPaymentStatus(b.booking.code, true, "cash");
    await rescheduleBooking(b.booking.code, { date: b.date, start: b.hour * 60, courtId: cheap }, "customer");
    expect(await getWalletBalance(who.id, venueId)).toBe(0);
    const owed = (await counterOwed([venueId], "manager")).find((o) => o.bookingCode === b.booking.code)!;
    expect(await settleOwed(owed.id, "credit", manager)).toMatchObject({ ok: true, settled: { outcome: "credit", credited: 35 } });
    expect(await getWalletBalance(who.id, venueId)).toBe(35);
    expect(await moveNotes(b.booking.id)).toEqual([{ total: 35, paid_via: "Stored credit" }]);
  });

  it("moved twice cheaper: each difference once, never more than was paid", async () => {
    const b = await book();
    await setPaymentStatus(b.booking.code, true, "cash");
    expect(await rescheduleBooking(b.booking.code, { date: b.date, start: b.hour * 60, courtId: cheap }, "customer")).toMatchObject({ ok: true, money: { refund: { amount: 35 } } });
    expect(await rescheduleBooking(b.booking.code, { date: b.date, start: b.hour * 60, courtId: lowest }, "customer")).toMatchObject({ ok: true, money: { refund: { amount: 5 } } });
    expect((await moves(b.booking.id)).map((m) => m.amount)).toEqual([35, 5]);
    expect(await counterPaymentOn(b.booking.id)).toBe(20);
  });
});

describe("paid online, moved to a cheaper time", () => {
  it("is owed back on the original payment with a credit note, never more than it took, listed as owed and not as refunded", async () => {
    const b = await paidOnline();
    const moved = await rescheduleBooking(b.booking.code, { date: b.date, start: b.hour * 60, courtId: cheap }, "customer");
    expect(moved).toMatchObject({ ok: true, priceChange: 0, money: { settles: "refund", refund: { amount: 35, how: "online" } } });
    expect(await payment(b.paymentId)).toEqual({ amount: 60, due: 35, refunded: 0 });
    expect(await moves(b.booking.id)).toMatchObject([{ amount: 35, how: "online" }]);
    expect(await moveNotes(b.booking.id)).toEqual([{ total: 35, paid_via: "Online" }]);
    // Billplz has no refund API: it stays owed for staff, with a due date, and is not claimed as paid.
    expect(moved.ok && moved.money.refund?.sent).toMatchObject({ how: "staff" });
    expect((await payment(b.paymentId)).refunded).toBe(0);
    // A cancellation afterwards owes back what is left (25), so the payment is owed 60 in all and never more.
    expect((await cancelBooking(b.booking.code, b.phone)).ok).toBe(true);
    expect(await payment(b.paymentId)).toEqual({ amount: 60, due: 60, refunded: 0 });
  });

  it("a repeated request is one refund: the second finds the booking already there", async () => {
    const b = await paidOnline();
    const first = await customerMove(b, b.hour, { courtId: cheap });
    // The customer route never takes a court: it moves to another time on the same court. Use staff's route for the court.
    expect(first.status).toBeLessThan(500);
    const to = { date: b.date, start: b.hour * 60, courtId: cheap };
    expect(await rescheduleBooking(b.booking.code, to, "customer")).toMatchObject({ ok: true });
    expect(await rescheduleBooking(b.booking.code, to, "customer")).toMatchObject({ ok: false, code: "RESCHEDULE_SAME" });
    expect((await payment(b.paymentId)).due).toBe(35);
    expect(await moves(b.booking.id)).toHaveLength(1);
  });

  it("two identical requests at once make one refund", async () => {
    const b = await paidOnline();
    const to = { date: b.date, start: b.hour * 60, courtId: cheap };
    const both = await Promise.all([rescheduleBooking(b.booking.code, to, "customer"), rescheduleBooking(b.booking.code, to, "customer")]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect((await payment(b.paymentId)).due).toBe(35);
    expect(await moves(b.booking.id)).toHaveLength(1);
  });

  it("a payment that cannot be found refuses the move, the booking staying where it was", async () => {
    const b = await paidOnline();
    await getDb().prepare("UPDATE online_payments SET refund_due = amount WHERE id = ?").run(b.paymentId);
    const refused = await rescheduleBooking(b.booking.code, { date: b.date, start: b.hour * 60, courtId: cheap }, "customer");
    expect(refused).toMatchObject({ ok: false, code: "MOVE_DIFFERENCE_UNTRACED" });
    expect(await findBooking(b.booking.code, b.phone)).toMatchObject({ courtId: dear });
    expect(await moves(b.booking.id)).toEqual([]);
  });
});

describe("paid from stored credit, moved to a cheaper time", () => {
  it("goes back to credit with a credit note, and cancelling afterwards gives back only the rest: the credit ends where it started", async () => {
    const who = await userWith(100);
    const b = await book({ userId: who.id, phone: who.phone });
    expect(await payBookingFromWallet(b.booking.id)).toMatchObject({ ok: true });
    expect(await getWalletBalance(who.id, venueId)).toBe(40);
    const moved = await rescheduleBooking(b.booking.code, { date: b.date, start: b.hour * 60, courtId: cheap }, "customer");
    expect(moved).toMatchObject({ ok: true, money: { settles: "refund", refund: { amount: 35, how: "credit" } } });
    expect(await getWalletBalance(who.id, venueId)).toBe(75);
    expect(await moveNotes(b.booking.id)).toHaveLength(1);
    expect((await cancelBooking(b.booking.code, who.phone)).ok).toBe(true);
    expect(await getWalletBalance(who.id, venueId)).toBe(100);
  });

  it("a move and a cancellation at once give the credit back exactly once, whichever wins", async () => {
    const who = await userWith(100);
    const b = await book({ userId: who.id, phone: who.phone });
    await payBookingFromWallet(b.booking.id);
    await Promise.all([
      rescheduleBooking(b.booking.code, { date: b.date, start: b.hour * 60, courtId: cheap }, "customer"),
      cancelBooking(b.booking.code, who.phone),
    ]);
    expect(await getWalletBalance(who.id, venueId)).toBe(100);
    expect((await getBookingById(b.booking.id))!.status).toBe("cancelled");
  });
});

describe("paid with a pass, moved to a cheaper time", () => {
  it("moves no money: the same pass covers the new time", async () => {
    const ph = phone();
    const pass = await issuePass({ venueId, name: "Pass", entries: 5, price: 100, holderName: "Aina", holderPhone: ph, expiresOn: addDays(todayISO(ZONE), 60), adminId: null });
    if (!pass.ok) throw new Error(JSON.stringify(pass));
    const b = await book({ phone: ph });
    expect((await payBookingWithPass(b.booking.id, pass.pass.code)).ok).toBe(true);
    const before = ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM pass_entries WHERE pass_id = ?").get(pass.pass.id)) as { n: number }).n;
    const moved = await rescheduleBooking(b.booking.code, { date: b.date, start: b.hour * 60, courtId: cheap }, "customer");
    expect(moved).toMatchObject({ ok: true, money: { settles: "pass" } });
    expect(await moves(b.booking.id)).toEqual([]);
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM pass_entries WHERE pass_id = ?").get(pass.pass.id)) as { n: number }).n).toBe(before);
    expect((await counterOwed([venueId], "manager")).some((o) => o.bookingCode === b.booking.code)).toBe(false);
  });
});

describe("others' money in a paid booking", () => {
  it("a split with friends' shares: a customer is refused, staff are refused too unless they keep the difference", async () => {
    const b = await book();
    await getDb().prepare("UPDATE bookings SET payment_status = 'paid', paid_via = 'cash', paid_at = now(), shares_paid = 20 WHERE id = ?").run(b.booking.id);
    expect(await rescheduleBooking(b.booking.code, { date: b.date, start: b.hour * 60, courtId: cheap }, "customer")).toMatchObject({ ok: false, code: "RESCHEDULE_SHARED" });
    expect(await rescheduleBooking(b.booking.code, { date: b.date, start: b.hour * 60, courtId: cheap }, "staff")).toMatchObject({ ok: false, code: "MOVE_DIFFERENCE_SHARED" });
    expect(await findBooking(b.booking.code, b.phone)).toMatchObject({ courtId: dear });
    const kept = await rescheduleBooking(b.booking.code, { date: b.date, start: b.hour * 60, courtId: cheap, difference: "keep" }, "staff");
    expect(kept).toMatchObject({ ok: true, priceChange: 0, unchargedDifference: -35, money: { settles: "kept" } });
    expect(await moves(b.booking.id)).toEqual([]);
  });
});

describe("staff moves and the cutoff", () => {
  it("staff's move of a paid booking cheaper gives the difference back by default, and keeps it only when they say so", async () => {
    const a = await book();
    await setPaymentStatus(a.booking.code, true, "cash");
    const kept = await rescheduleBooking(a.booking.code, { date: a.date, start: a.hour * 60, courtId: cheap, difference: "keep" }, "staff");
    expect(kept).toMatchObject({ ok: true, unchargedDifference: -35, money: { settles: "kept", canKeep: true } });
    expect(await moves(a.booking.id)).toEqual([]);
    const b = await book();
    await setPaymentStatus(b.booking.code, true, "cash");
    expect(await rescheduleBooking(b.booking.code, { date: b.date, start: b.hour * 60, courtId: cheap }, "staff")).toMatchObject({ ok: true, money: { settles: "refund", refund: { amount: 35 } } });
    expect(await moves(b.booking.id)).toMatchObject([{ amount: 35, moved_by: "staff" }]);
  });

  it("at the cutoff: before it the difference goes back by default, inside it staff's default is to keep and a customer cannot move at all", async () => {
    const s = slot();
    const ph = phone();
    const made = await createBooking({ courtId: dear, date: s.date, hours: [s.hour], name: "Aina", phone: ph });
    if (!made.ok) throw new Error(JSON.stringify(made));
    await setPaymentStatus(made.booking.code, true, "cash");
    const start = slotStartsAt(s.date, s.hour, ZONE).getTime();
    vi.useFakeTimers({ toFake: ["Date"] });
    // The venue's cutoff is 2 hours: a minute before it, the customer may still change it.
    vi.setSystemTime(start - 2 * 3_600_000 - 60_000);
    const before = await rescheduleBooking(made.booking.code, { date: s.date, start: s.hour * 60, courtId: cheap, preview: true }, "staff");
    expect(before).toMatchObject({ ok: true, preview: true, money: { settles: "refund", refund: { amount: 35 } } });
    // A minute after it: the customer is refused; staff's default is to keep it.
    vi.setSystemTime(start - 2 * 3_600_000 + 60_000);
    expect(await rescheduleBooking(made.booking.code, { date: s.date, start: s.hour * 60, courtId: cheap }, "customer")).toMatchObject({ ok: false, code: "RESCHEDULE_CUTOFF" });
    expect(await rescheduleBooking(made.booking.code, { date: s.date, start: s.hour * 60, courtId: cheap, preview: true }, "staff")).toMatchObject({ ok: true, money: { settles: "kept" } });
    // Staff may still choose to give it back.
    expect(await rescheduleBooking(made.booking.code, { date: s.date, start: s.hour * 60, courtId: cheap, difference: "refund" }, "staff")).toMatchObject({ ok: true, money: { refund: { amount: 35 } } });
  });

  it("a dearer move: a customer is still refused, staff's keeps the price as paid and says what was not charged", async () => {
    const b = await book({ court: cheap });
    await setPaymentStatus(b.booking.code, true, "cash");
    expect(await rescheduleBooking(b.booking.code, { date: b.date, start: b.hour * 60, courtId: dear }, "customer")).toMatchObject({ ok: false, code: "RESCHEDULE_DEARER" });
    expect(await rescheduleBooking(b.booking.code, { date: b.date, start: b.hour * 60, courtId: dear }, "staff")).toMatchObject({ ok: true, priceChange: 0, unchargedDifference: 35, money: { settles: "kept", difference: 35 } });
    expect(await moves(b.booking.id)).toEqual([]);
  });
});

describe("the quote shown before the change", () => {
  it("a preview carries the old price, the new price and the difference, and changes nothing: nothing owed, no rows", async () => {
    const b = await book();
    await setPaymentStatus(b.booking.code, true, "cash");
    const seen = await rescheduleBooking(b.booking.code, { date: b.date, start: b.hour * 60, courtId: cheap, preview: true }, "customer");
    expect(seen).toMatchObject({ ok: true, preview: true, money: { oldPrice: 60, newPrice: 25, difference: -35, settles: "refund", refund: { amount: 35, how: "counter" } } });
    expect(await findBooking(b.booking.code, b.phone)).toMatchObject({ courtId: dear });
    expect(await moves(b.booking.id)).toEqual([]);
    expect((await counterOwed([venueId], "manager")).some((o) => o.bookingCode === b.booking.code)).toBe(false);
  });

  it("an unpaid booking's quote is the new price, and the customer's route answers a preview with it", async () => {
    const b = await book();
    // The route moves to another time on the same court: all the courts here are flat, so the price does not change.
    const res = await customerMove(b, b.hour + 1 > 20 ? 9 : b.hour + 1, { preview: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { preview: { money: { settles: string; oldPrice: number; newPrice: number }; to: { startMin: number } } };
    expect(body.preview.money).toMatchObject({ settles: "none", oldPrice: 60, newPrice: 60 });
    expect(await findBooking(b.booking.code, b.phone)).toMatchObject({ startHour: b.hour });
  });

  it("the staff route takes difference keep|refund and answers with the money", async () => {
    const b = await book();
    await setPaymentStatus(b.booking.code, true, "cash");
    const post = (body: Record<string, unknown>) =>
      staffReschedule(new NextRequest("http://localhost/api/admin/bookings/reschedule", { method: "POST", headers: { "content-type": "application/json", cookie: ownerCookie }, body: JSON.stringify(body) }));
    const bad = await post({ code: b.booking.code, date: b.date, start: b.hour * 60, courtId: cheap, difference: "maybe" });
    expect(bad.status).toBe(400);
    const seen = await post({ code: b.booking.code, date: b.date, start: b.hour * 60, courtId: cheap, preview: true });
    expect(((await seen.json()) as { preview: { money: { settles: string } } }).preview.money.settles).toBe("refund");
    const done = await post({ code: b.booking.code, date: b.date, start: b.hour * 60, courtId: cheap });
    expect(done.status).toBe(200);
    expect(((await done.json()) as { money: { refund: { amount: number } } }).money.refund.amount).toBe(35);
  });
});

describe("a deposit paid online and the rest at the counter", () => {
  let depVenue: number;
  let depDear: number;
  let depMid: number;
  let depCheap: number;
  beforeAll(async () => {
    const v = await createVenue({ name: "Deposit Hall", area: "PJ", address: "x", phone: "0300000070", openMin: 8 * 60, closeMin: 22 * 60 });
    if (!v.ok) throw new Error("venue");
    depVenue = v.venue.id;
    const mk = async (name: string, rate: number) => {
      const c = await createCourt({ venueId: depVenue, name, sport: "badminton", offPeakRate: rate, peakRate: rate });
      if (!c.ok) throw new Error("court");
      return c.court.id;
    };
    depDear = await mk("Dear", 60);
    depMid = await mk("Mid", 40);
    depCheap = await mk("Cheap", 25);
    const saved = await savePaymentSettings(depVenue, { apiKey: "api-key-5678", collectionId: "col456", xSignatureKey: "S-key2", sandbox: true, enabled: true });
    if (!saved.ok) throw new Error(saved.error);
    await setHoldPolicy(depVenue, { on: true, depositPercent: 50 });
  });

  async function withDeposit(hour: number) {
    const ph = phone();
    const date = addDays(todayISO(ZONE), 3);
    const made = await createBooking({ courtId: depDear, date, hours: [hour], name: "Aina", phone: ph, email: "aina@example.my" });
    if (!made.ok) throw new Error(JSON.stringify(made));
    fakeBillplz();
    const started = await startBookingPayment({ codes: [made.booking.code], phone: ph, deposit: true });
    if (!started.ok) throw new Error(JSON.stringify(started));
    const bill = (await getDb().prepare("SELECT bill_id FROM online_payments ORDER BY id DESC LIMIT 1").get()) as { bill_id: string };
    await settleBill({ billId: bill.bill_id, paid: true, paidAt: null });
    expect((await setPaymentStatus(made.booking.code, true, "cash")).ok).toBe(true);
    expect(await findBooking(made.booking.code, ph)).toMatchObject({ totalPrice: 60, depositPaid: 30, paymentStatus: "paid", paidVia: "cash" });
    return { booking: made.booking, phone: ph, date, hour };
  }

  it("moved to a time that still costs more than the deposit: only the counter part is owed back, the deposit untouched", async () => {
    const d = await withDeposit(9);
    const moved = await rescheduleBooking(d.booking.code, { date: d.date, start: d.hour * 60, courtId: depMid }, "customer");
    // Paid 30 online and 30 at the counter for RM60; RM40 costs RM40: RM20 goes back, from the counter part.
    expect(moved).toMatchObject({ ok: true, money: { settles: "refund", oldPrice: 60, newPrice: 40, refund: { amount: 20, how: "counter" } } });
    expect(await moves(d.booking.id)).toMatchObject([{ amount: 20, how: "counter" }]);
    expect(await findBooking(d.booking.code, d.phone)).toMatchObject({ depositPaid: 30, sharesPaid: 30, totalPrice: 60 });
  });

  it("moved to a time that costs less than the deposit: refused, the booking staying put", async () => {
    const d = await withDeposit(10);
    expect(await rescheduleBooking(d.booking.code, { date: d.date, start: d.hour * 60, courtId: depCheap }, "customer")).toMatchObject({ ok: false, code: "MOVE_DIFFERENCE_BELOW_PAID" });
    expect(await findBooking(d.booking.code, d.phone)).toMatchObject({ courtId: depDear });
    expect(await moves(d.booking.id)).toEqual([]);
  });
});

describe("who may keep the difference, and what the customer is told", () => {
  const staffPost = (cookie: string, body: Record<string, unknown>) =>
    staffReschedule(new NextRequest("http://localhost/api/admin/bookings/reschedule", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));

  it("the front desk gives the difference back and cannot keep it; a manager can, and it is in the activity log", async () => {
    const a = await book();
    await setPaymentStatus(a.booking.code, true, "cash");
    const denied = await staffPost(deskCookie, { code: a.booking.code, date: a.date, start: a.hour * 60, courtId: cheap, difference: "keep" });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { code: string }).code).toBe("MOVE_KEEP_MANAGER");
    expect(await findBooking(a.booking.code, a.phone)).toMatchObject({ courtId: dear });
    // The desk's default is to give it back (before the cutoff).
    const gave = await staffPost(deskCookie, { code: a.booking.code, date: a.date, start: a.hour * 60, courtId: cheap });
    expect(gave.status).toBe(200);
    expect(await moves(a.booking.id)).toMatchObject([{ amount: 35, moved_by: "staff" }]);
    const b = await book();
    await setPaymentStatus(b.booking.code, true, "cash");
    expect((await staffPost(ownerCookie, { code: b.booking.code, date: b.date, start: b.hour * 60, courtId: cheap, difference: "keep" })).status).toBe(200);
    expect(await moves(b.booking.id)).toEqual([]);
    const logged = (await listActivity([venueId])).find((a) => a.action === "booking.rescheduled" && a.bookingCode === b.booking.code);
    expect(logged?.detail).toContain("difference kept by the venue");
  });

  it("the customer is told what goes back in the notice of the change, in place of 'same price'", async () => {
    const b = await book();
    await setPaymentStatus(b.booking.code, true, "cash");
    const res = await customerMove(b, 20);
    // The customer's own route keeps the same court, which prices the same: nothing goes back, and the notice says so.
    expect(res.status).toBe(200);
    const same = (await getDb().prepare("SELECT params FROM messages WHERE booking_id = ? AND kind = 'booking_rescheduled' AND channel = 'email'").get(b.booking.id)) as { params: string };
    expect(JSON.parse(same.params).money).toBe("Same price.");
    const c = await book();
    await setPaymentStatus(c.booking.code, true, "cash");
    const staff = await staffPost(ownerCookie, { code: c.booking.code, date: c.date, start: c.hour * 60, courtId: cheap });
    expect(staff.status).toBe(200);
    const told = (await getDb().prepare("SELECT body FROM messages WHERE booking_id = ? AND channel = 'email' ORDER BY id DESC LIMIT 1").get(c.booking.id)) as { body: string } | undefined;
    expect(told?.body ?? "").toMatch(/less than you paid; the venue owes you that back/);
  });
});

describe("D3: a discount kept as an amount never makes the time free", () => {
  it("a 50% concession on RM60 moved to an RM20 court costs RM10, not nothing", async () => {
    const s = await saveConcession(venueId, { name: `Student ${++n}`, percent: 50, proof: "your student card" });
    if (!s.ok) throw new Error("concession");
    const b = await book();
    await applyAskedDiscounts([b.booking], { concessionId: s.concession.id });
    expect((await getBookingById(b.booking.id))!.totalPrice).toBe(30);
    const moved = await rescheduleBooking(b.booking.code, { date: b.date, start: b.hour * 60, courtId: lowest }, "customer");
    expect(moved).toMatchObject({ ok: true, priceChange: -20, money: { settles: "price", newPrice: 10 } });
    expect((await getBookingById(b.booking.id))!.totalPrice).toBe(10);
  });

  it("a discount that still leaves a price keeps its amount, as decided (RM60 less RM30 moved to RM40 stays RM10 under it)", async () => {
    const s = await saveConcession(venueId, { name: `Staff ${++n}`, percent: 50, proof: "your staff card" });
    if (!s.ok) throw new Error("concession");
    const mid = await createCourt({ venueId, name: `Mid ${n}`, sport: "badminton", offPeakRate: 40, peakRate: 40 });
    if (!mid.ok) throw new Error("court");
    const b = await book();
    await applyAskedDiscounts([b.booking], { concessionId: s.concession.id });
    const moved = await rescheduleBooking(b.booking.code, { date: b.date, start: b.hour * 60, courtId: mid.court.id }, "customer");
    expect(moved).toMatchObject({ ok: true, priceChange: -20 });
    expect((await getBookingById(b.booking.id))!.totalPrice).toBe(10);
  });

  it("a paid, discounted booking moved cheaper gives back only what leaves a price: never the whole of it", async () => {
    const s = await saveConcession(venueId, { name: `Paid ${++n}`, percent: 50, proof: "your student card" });
    if (!s.ok) throw new Error("concession");
    const b = await book();
    await applyAskedDiscounts([b.booking], { concessionId: s.concession.id });
    await setPaymentStatus(b.booking.code, true, "cash");
    const moved = await rescheduleBooking(b.booking.code, { date: b.date, start: b.hour * 60, courtId: lowest }, "customer");
    // Paid 30 for an RM60 hour at half price; the RM20 hour at half price is 10: 20 goes back, 10 is what it costs.
    expect(moved).toMatchObject({ ok: true, money: { settles: "refund", oldPrice: 30, newPrice: 10, refund: { amount: 20 } } });
  });
});

describe("B11: a last-minute price stays where its terms still hold", () => {
  let lmVenue: number;
  let lmCourt: number;
  let lmN = 0;
  beforeAll(async () => {
    const v = await createVenue({ name: "Late Hall", area: "PJ", address: "x", phone: "0300000068", openMin: 8 * 60, closeMin: 22 * 60 });
    if (!v.ok) throw new Error("venue");
    lmVenue = v.venue.id;
    const c = await createCourt({ venueId: lmVenue, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
    if (!c.ok) throw new Error("court");
    lmCourt = c.court.id;
    expect((await setLastMinute(lmVenue, { hours: 24, percent: 20, offPeakOnly: false })).ok).toBe(true);
  });

  async function lastMinuteBooking(hour: number) {
    const day = addDays(todayISO(ZONE), 2 + lmN++);
    const at = slotStartsAt(day, hour, ZONE).getTime() - 4 * 3_600_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at);
    const made = await createBooking({ courtId: lmCourt, date: day, hours: [hour], name: "Late", phone: `01222${String(30000 + ++n)}` });
    if (!made.ok) throw new Error(JSON.stringify(made));
    // Written as made, whichever clock the database keeps.
    await getDb().prepare("UPDATE bookings SET created_at = to_char(?::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?").run(new Date(at).toISOString(), made.booking.id);
    expect(made.booking.totalPrice).toBe(16);
    return { booking: made.booking, day };
  }

  it("moved to another time that also qualifies, it costs what it did: no price change, no discount lost", async () => {
    const m = await lastMinuteBooking(9);
    const moved = await rescheduleBooking(m.booking.code, { date: m.day, start: 11 * 60 }, "customer");
    expect(moved).toMatchObject({ ok: true, priceChange: 0, money: { settles: "none", newPrice: 16 } });
    expect(moved.ok && moved.money.lastMinuteLost).toBeUndefined();
    expect((await getBookingById(m.booking.id))!.totalPrice).toBe(16);
  });

  it("moved to a time the window no longer reaches, the discount goes with the time, and the quote says so before it is confirmed", async () => {
    const m = await lastMinuteBooking(9);
    const later = addDays(m.day, 3);
    const seen = await rescheduleBooking(m.booking.code, { date: later, start: 9 * 60, preview: true }, "customer");
    expect(seen).toMatchObject({ ok: true, priceChange: 4, money: { settles: "price", oldPrice: 16, newPrice: 20, lastMinuteLost: true } });
    expect((await getBookingById(m.booking.id))!.totalPrice).toBe(16);
  });

  it("a booking that never had the discount never earns one by moving into the window", async () => {
    const day = addDays(todayISO(ZONE), 2 + lmN++);
    const made = await createBooking({ courtId: lmCourt, date: day, hours: [18], name: "Early", phone: `01222${String(30000 + ++n)}` });
    if (!made.ok) throw new Error(JSON.stringify(made));
    expect(made.booking.totalPrice).toBe(20);
    // Six hours before it: a fresh booking at 17:00 would be in the window, this one was never given the price.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(slotStartsAt(day, 18, ZONE).getTime() - 6 * 3_600_000);
    expect(await rescheduleBooking(made.booking.code, { date: day, start: 17 * 60 }, "customer")).toMatchObject({ ok: true, priceChange: 0 });
    expect((await getBookingById(made.booking.id))!.totalPrice).toBe(20);
  });
});

describe("a company or school invoice", () => {
  let acctVenue: number;
  let courtA: number;
  let courtB: number;
  beforeAll(async () => {
    const v = await createVenue({ name: "Invoice Hall", area: "Klang", address: "1", phone: "0300000069" });
    if (!v.ok) throw new Error("venue");
    acctVenue = v.venue.id;
    const a = await createCourt({ venueId: acctVenue, name: "A", sport: "badminton", offPeakRate: 20, peakRate: 20 });
    const b = await createCourt({ venueId: acctVenue, name: "B", sport: "badminton", offPeakRate: 10, peakRate: 10 });
    if (!a.ok || !b.ok) throw new Error("court");
    courtA = a.court.id;
    courtB = b.court.id;
  });

  async function invoiced(hour: number) {
    const acct = await saveAccount(acctVenue, { name: `Co ${++n}`, email: `co${n}@co.test` });
    if (!acct.ok) throw new Error(acct.error);
    const date = addDays(todayISO(ZONE), 6);
    const made = await createBooking({ courtId: courtA, date, hours: [hour], name: "Cikgu", phone: phone() });
    if (!made.ok) throw new Error(JSON.stringify(made));
    expect((await chargeToAccount(acctVenue, acct.account.id, [made.booking.id])).ok).toBe(true);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${date}T07:00:00+08:00`));
    const invoice = (await issueInvoice(acct.account.id, date.slice(0, 7), { email: false }))!;
    vi.useRealTimers();
    return { booking: made.booking, accountId: acct.account.id, date, hour, invoice };
  }

  it("cheaper: a credit note on the account, the invoice as issued; the same when the invoice is already paid", async () => {
    const i = await invoiced(9);
    const moved = await rescheduleBooking(i.booking.code, { date: i.date, start: 9 * 60, courtId: courtB }, "customer");
    expect(moved).toMatchObject({ ok: true, priceChange: 0, accountCredited: 10, money: { settles: "account", account: 10 } });
    expect((await listAccounts(acctVenue)).find((a) => a.id === i.accountId)!.credit).toBe(10);
    // Paid: the same credit, the booking's price and the invoice untouched.
    const paid = await invoiced(10);
    expect((await markInvoicePaid(acctVenue, paid.invoice.id, "transfer")).ok).toBe(true);
    const movedPaid = await rescheduleBooking(paid.booking.code, { date: paid.date, start: 10 * 60, courtId: courtB }, "staff");
    expect(movedPaid).toMatchObject({ ok: true, unchargedDifference: 0, accountCredited: 10 });
    expect((await listAccounts(acctVenue)).find((a) => a.id === paid.accountId)!.credit).toBe(10);
  });

  it("dearer, by staff: refused with the reason, nothing moved or billed (audit C5)", async () => {
    const i = await invoiced(11);
    await rescheduleBooking(i.booking.code, { date: i.date, start: 11 * 60, courtId: courtB }, "staff");
    const dearer = await rescheduleBooking(i.booking.code, { date: i.date, start: 11 * 60, courtId: courtA }, "staff");
    expect(dearer).toMatchObject({ ok: false, code: "RESCHEDULE_INVOICED_DEARER" });
    expect(((await getBookingById(i.booking.id))!).courtId).toBe(courtB);
    // Customers are refused as before.
    expect(await rescheduleBooking(i.booking.code, { date: i.date, start: 11 * 60, courtId: courtA }, "customer")).toMatchObject({ ok: false, code: "RESCHEDULE_DEARER" });
  });
});

describe("a weekly series of paid weeks moved to a cheaper court", () => {
  it("each paid week is owed its own difference once, and the preview says so before anything moves", async () => {
    const s = slot();
    const first = s.date;
    const made = await createBookingSeries({ courtId: dear, date: first, hours: [s.hour], weeks: 2, name: "Siti", phone: phone(), by: "staff" });
    if (!made.ok || !made.seriesCode) throw new Error(JSON.stringify(made));
    for (const w of made.bookings) await setPaymentStatus(w.code, true, "cash");
    const to = { start: s.hour * 60, courtId: cheap };
    const seen = await previewSeriesMove(made.seriesCode, to);
    expect(seen.ok && seen.weeks.map((w) => w.refund)).toEqual([{ amount: 35, how: "counter" }, { amount: 35, how: "counter" }]);
    expect(await moves(made.bookings[0].id)).toEqual([]);
    const done = await moveSeries({ id: managerId, name: "Mira", role: "manager" }, made.seriesCode, to);
    expect(done.ok && done.moved.map((m) => m.refund?.amount)).toEqual([35, 35]);
    for (const w of made.bookings) expect((await moves(w.id)).map((m) => m.amount)).toEqual([35]);
    // Moving them again to the same court changes nothing and owes nothing more.
    const again = await moveSeries({ id: managerId, name: "Mira", role: "manager" }, made.seriesCode, to);
    expect(again.ok && again.moved).toEqual([]);
    for (const w of made.bookings) expect(await moves(w.id)).toHaveLength(1);
  });
});

describe("a credit note of its own, found with the booking", () => {
  it("is keyed to the booking and the move, so it is found by the booking's receipts", async () => {
    const b = await paidOnline();
    await rescheduleBooking(b.booking.code, { date: b.date, start: b.hour * 60, courtId: cheap }, "customer");
    const m = (await getDb().prepare("SELECT id FROM booking_move_refunds WHERE booking_id = ?").get(b.booking.id)) as { id: number };
    expect(await documentFor(`booking:${b.booking.id}:move:${m.id}`)).toMatchObject({ kind: "credit_note", total: 35 });
  });
});

void adminCancelBooking;
