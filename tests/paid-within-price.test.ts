import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { authenticateAdmin, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { applyConcession, saveConcession } from "../src/lib/concessions";
import { getDb } from "../src/lib/db";
import { documentFor } from "../src/lib/documents";
import { holdPolicy, setHoldPolicy } from "../src/lib/holds";
import { savePaymentSettings, settleBill, startBookingPayment } from "../src/lib/payments";
import {
  adminCancelBooking,
  applyPromo,
  createBooking,
  createCourt,
  createPromoCode,
  createVenue,
  findBooking,
  rescheduleBooking,
  setPaymentStatus,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Whatever lowers an unpaid booking's price (a move to a cheaper court, a promo code, a concession) never leaves more
 * paid on it (a deposit, friends' shares) than it now costs without it being owed back, or the change refused
 * (lib/paid-within-price.ts; ADR 0054).
 */

await ensureBootstrapAdmin();
const ADMIN_ID = (await authenticateAdmin("admin@mysenam.my", "mysenam-admin"))!.id;
let venueId: number;
let dear: number; // RM40
let cheap: number; // RM10
let n = 0;
let slot = 0;
const date = addDays(todayISO(), 3);
const phone = () => `01944${String(10000 + ++n)}`;

function fakeBillplz() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const id = `pwpbill${++n}`;
      return Response.json({ id, url: `https://www.billplz-sandbox.com/bills/${id}` });
    })
  );
}

/** An RM40 booking with its deposit (50 percent: RM20) paid online and settled. */
async function withDeposit(courtId = dear) {
  const ph = phone();
  const hour = 8 + (slot++ % 12);
  const made = await createBooking({ courtId, date, hours: [hour], name: "Aina", phone: ph, email: "aina@example.my" });
  if (!made.ok) throw new Error(JSON.stringify(made));
  fakeBillplz();
  const started = await startBookingPayment({ codes: [made.booking.code], phone: ph, deposit: true });
  if (!started.ok) throw new Error(JSON.stringify(started));
  const bill = (await getDb().prepare("SELECT id, bill_id FROM online_payments ORDER BY id DESC LIMIT 1").get()) as { id: number; bill_id: string };
  await settleBill({ billId: bill.bill_id, paid: true, paidAt: null });
  const b = (await findBooking(made.booking.code, ph))!;
  expect(b).toMatchObject({ totalPrice: 40, depositPaid: 20, sharesPaid: 20 });
  return { booking: made.booking, phone: ph, hour, paymentId: bill.id };
}

const paymentRow = async (id: number) =>
  (await getDb().prepare("SELECT amount::float AS amount, refund_due::float AS due FROM online_payments WHERE id = ?").get(id)) as { amount: number; due: number };

beforeAll(async () => {
  const made = await createVenue({ name: "Lower Hall", area: "PJ", address: "x", phone: "0300000097" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const a = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 40, peakRate: 40 });
  const b = await createCourt({ venueId, name: "Court 2", sport: "badminton", offPeakRate: 10, peakRate: 10 });
  if (!a.ok || !b.ok) throw new Error("court");
  dear = a.court.id;
  cheap = b.court.id;
  const saved = await savePaymentSettings(venueId, { apiKey: "api-key-1234", collectionId: "col123", xSignatureKey: "S-key", sandbox: true, enabled: true });
  if (!saved.ok) throw new Error(saved.error);
  await setHoldPolicy(venueId, { on: true, depositPercent: 50 });
  expect((await holdPolicy(venueId)).depositPercent).toBe(50);
});
afterEach(() => vi.unstubAllGlobals());

describe("a deposit and a move to a cheaper court", () => {
  it("owes back what the deposit is above the new price, with a credit note, and lets the rest be paid at the counter", async () => {
    const d = await withDeposit();
    const moved = await rescheduleBooking(d.booking.code, { date, startHour: d.hour, courtId: cheap }, "staff");
    expect(moved).toMatchObject({ ok: true, owedBack: 10 });
    const b = (await findBooking(d.booking.code, d.phone))!;
    // Price 10 now; the deposit that stays is the whole price, the other 10 of it is owed back.
    expect(b).toMatchObject({ totalPrice: 10, depositPaid: 10, sharesPaid: 10, paymentStatus: "unpaid" });
    expect(await paymentRow(d.paymentId)).toMatchObject({ amount: 20, due: 10 });
    const note = await documentFor(`credit:${(await documentFor(`payment:${d.paymentId}`))!.id}:${b.code}:lowered:1000`);
    expect(note).toMatchObject({ kind: "credit_note", total: 10 });
    // Nothing more to take at the counter: marking it paid counts the deposit as what it was.
    expect(await setPaymentStatus(d.booking.code, true, "cash")).toMatchObject({ ok: true });
  });

  it("does the same for the customer's own move, and the whole deposit is owed back on a free move cheaper than nothing", async () => {
    const d = await withDeposit();
    expect(await rescheduleBooking(d.booking.code, { date, startHour: d.hour, courtId: cheap }, "customer")).toMatchObject({ ok: true, owedBack: 10 });
    expect(await paymentRow(d.paymentId)).toMatchObject({ due: 10 });
  });

  it("a deposit under the new price is left alone", async () => {
    const ph = phone();
    // Deposit 20 of 40, then a move to a court costing 25: still above the deposit, nothing owed.
    const mid = await createCourt({ venueId, name: `Court mid ${n}`, sport: "badminton", offPeakRate: 25, peakRate: 25 });
    if (!mid.ok) throw new Error("court");
    const made = await createBooking({ courtId: dear, date, hours: [20], name: "Aina", phone: ph, email: "a@example.my" });
    if (!made.ok) throw new Error("booking");
    fakeBillplz();
    const started = await startBookingPayment({ codes: [made.booking.code], phone: ph, deposit: true });
    if (!started.ok) throw new Error("start");
    const bill = (await getDb().prepare("SELECT id, bill_id FROM online_payments ORDER BY id DESC LIMIT 1").get()) as { id: number; bill_id: string };
    await settleBill({ billId: bill.bill_id, paid: true, paidAt: null });
    const moved = await rescheduleBooking(made.booking.code, { date, startHour: 20, courtId: mid.court.id }, "staff");
    expect(moved).toMatchObject({ ok: true });
    expect(moved.ok && moved.owedBack).toBeUndefined();
    expect(await paymentRow(bill.id)).toMatchObject({ due: 0 });
    expect(await findBooking(made.booking.code, ph)).toMatchObject({ totalPrice: 25, depositPaid: 20 });
  });

  it("a preview shows the amount owed back and changes nothing", async () => {
    const d = await withDeposit();
    const preview = await rescheduleBooking(d.booking.code, { date, startHour: d.hour, courtId: cheap, preview: true }, "staff");
    expect(preview).toMatchObject({ ok: true, preview: true, owedBack: 10 });
    expect(await paymentRow(d.paymentId)).toMatchObject({ due: 0 });
    expect(await findBooking(d.booking.code, d.phone)).toMatchObject({ totalPrice: 40, depositPaid: 20 });
  });

  it("cancelling afterwards gives back what is left of the deposit, and no more than it took", async () => {
    const d = await withDeposit();
    await rescheduleBooking(d.booking.code, { date, startHour: d.hour, courtId: cheap }, "staff");
    expect((await adminCancelBooking(d.booking.code)).ok).toBe(true);
    // 10 owed at the move, 10 more on the cancellation: the 20 paid, never more.
    expect(await paymentRow(d.paymentId)).toMatchObject({ amount: 20, due: 20 });
  });
});

describe("friends' shares above the new price", () => {
  it("refuses the move, for the venue to square with them, and changes nothing", async () => {
    const ph = phone();
    const made = await createBooking({ courtId: dear, date, hours: [21], name: "Aina", phone: ph, email: "a@example.my" });
    if (!made.ok) throw new Error("booking");
    // Friends have paid RM30 in shares.
    await getDb().prepare("UPDATE bookings SET shares_paid = 30 WHERE id = ?").run(made.booking.id);
    const moved = await rescheduleBooking(made.booking.code, { date, startHour: 21, courtId: cheap }, "staff");
    expect(moved).toMatchObject({ ok: false, code: "PAID_ABOVE_PRICE" });
    expect(await findBooking(made.booking.code, ph)).toMatchObject({ totalPrice: 40, sharesPaid: 30 });
    // To a court still above what they paid, it goes.
    const mid = await createCourt({ venueId, name: `Court 35 ${n}`, sport: "badminton", offPeakRate: 35, peakRate: 35 });
    if (!mid.ok) throw new Error("court");
    expect(await rescheduleBooking(made.booking.code, { date, startHour: 21, courtId: mid.court.id }, "staff")).toMatchObject({ ok: true });
  });
});

describe("a promo code or a concession taking the price below the deposit", () => {
  it("a code: the excess of the deposit is owed back", async () => {
    const d = await withDeposit();
    const code = await createPromoCode({ venueId, code: `SIXTY${n}`, description: "60 off", kind: "percent", value: 60, validFrom: todayISO(), validTo: addDays(todayISO(), 30), adminId: ADMIN_ID });
    if (!code.ok) throw new Error(JSON.stringify(code));
    const applied = await applyPromo(d.booking.id, `SIXTY${n}`);
    expect(applied).toMatchObject({ ok: true, newTotal: 16 });
    // Price 16, deposit 20: 4 owed back.
    expect(await findBooking(d.booking.code, d.phone)).toMatchObject({ totalPrice: 16, depositPaid: 16, sharesPaid: 16 });
    expect(await paymentRow(d.paymentId)).toMatchObject({ due: 4 });
  });

  it("a concession: the same", async () => {
    const d = await withDeposit();
    const c = await saveConcession(venueId, { name: `Eighty ${n}`, percent: 80, proof: "a card", scope: "booking" });
    if (!c.ok) throw new Error(c.error);
    const applied = await applyConcession(d.booking.id, c.concession.id);
    expect(applied).toMatchObject({ ok: true });
    expect(await findBooking(d.booking.code, d.phone)).toMatchObject({ totalPrice: 8, depositPaid: 8, sharesPaid: 8 });
    expect(await paymentRow(d.paymentId)).toMatchObject({ due: 12 });
  });

  it("a code with friends' shares above the price it would leave is refused, and not used up", async () => {
    const ph = phone();
    const made = await createBooking({ courtId: dear, date, hours: [22], name: "Aina", phone: ph, email: "a@example.my" });
    if (!made.ok) throw new Error("booking");
    await getDb().prepare("UPDATE bookings SET shares_paid = 30 WHERE id = ?").run(made.booking.id);
    const code = await createPromoCode({ venueId, code: `HALF${n}`, description: "50 off", kind: "percent", value: 50, validFrom: todayISO(), validTo: addDays(todayISO(), 30), adminId: ADMIN_ID });
    if (!code.ok) throw new Error(JSON.stringify(code));
    expect(await applyPromo(made.booking.id, `HALF${n}`)).toMatchObject({ ok: false, code: "PAID_ABOVE_PRICE" });
    expect(await findBooking(made.booking.code, ph)).toMatchObject({ totalPrice: 40, sharesPaid: 30 });
    const used = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM promo_uses WHERE booking_id = ?").get(made.booking.id)) as { n: number };
    expect(used.n).toBe(0);
  });
});
