import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { moveBookingToDate } from "./helpers/bookings";
import { ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { savePaymentSettings, settleBill, startBookingPayment } from "../src/lib/payments";
import {
  adminCancelBooking,
  applyPromo,
  closeVenueDay,
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
 * Money the audit found could go astray: a payment page settled after the
 * price moved, a tick that undoes a payment, refunds for hours played, a
 * code one person keeps using, a move friends had paid towards.
 */

const ZONE = "Asia/Kuala_Lumpur";
let venueId: number;
let courtId: number;
let dearCourtId: number;
let adminId: number;
let n = 0;
const phone = () => `0177770${String(++n).padStart(3, "0")}`;
const day = (d = 3) => addDays(todayISO(ZONE), d);

let billNumber = 0;
function fakeBillplz() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const id = `money${++billNumber}`;
      return Response.json({ id, url: `https://www.billplz-sandbox.com/bills/${id}` });
    })
  );
}
const lastBill = () => `money${billNumber}`;

async function book(hour: number, who = phone(), on = day(), court = courtId) {
  const made = await createBooking({ courtId: court, date: on, hours: [hour], name: "Payer", phone: who });
  if (!made.ok) throw new Error(made.error);
  return made.booking;
}

afterEach(() => vi.unstubAllGlobals());

beforeAll(async () => {
  await ensureBootstrapAdmin();
  adminId = ((await getDb().prepare("SELECT id FROM admins ORDER BY id LIMIT 1").get()) as { id: number }).id;
  const made = await createVenue({ name: "Money Hall", area: "PJ", address: "x", phone: "0312347777", openHour: 8, closeHour: 22 });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const cheap = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  const dear = await createCourt({ venueId, name: "Court 2", sport: "badminton", offPeakRate: 30, peakRate: 30 });
  if (!cheap.ok || !dear.ok) throw new Error("court");
  courtId = cheap.court.id;
  dearCourtId = dear.court.id;
  await savePaymentSettings(venueId, { apiKey: "key-123", collectionId: "col-123", xSignatureKey: "sig-123", sandbox: true, enabled: true });
  const promo = await createPromoCode({
    venueId,
    code: "ONCE10",
    description: "Ten off, once each",
    kind: "amount",
    value: 10,
    validFrom: todayISO(ZONE),
    validTo: day(30),
    maxPerCustomer: 1,
    adminId,
  });
  if (!promo.ok) throw new Error(promo.error);
});

describe("a payment page", () => {
  it("paid after a code took money off: the booking is paid and the difference owed back", async () => {
    fakeBillplz();
    const b = await book(9);
    expect(await startBookingPayment({ codes: [b.code], phone: b.phone })).toMatchObject({ ok: true, amount: 20 });
    expect(await applyPromo(b.id, "ONCE10")).toMatchObject({ ok: true, newTotal: 10 });
    await settleBill({ billId: lastBill(), paid: true, paidAt: null });
    expect((await findBooking(b.code, b.phone))!.paymentStatus).toBe("paid");
    const row = (await getDb().prepare("SELECT refund_due::float AS due FROM online_payments WHERE bill_id = ?").get(lastBill())) as { due: number };
    expect(row.due).toBe(10);
  });

  it("still open stops a move to a dearer time, which it would settle short", async () => {
    fakeBillplz();
    const b = await book(10);
    expect(await startBookingPayment({ codes: [b.code], phone: b.phone })).toMatchObject({ ok: true });
    expect(await rescheduleBooking(b.code, { date: b.date, startHour: 11, courtId: dearCourtId }, "staff")).toMatchObject({
      ok: false,
      code: "RESCHEDULE_PAGE_OPEN",
    });
    // The same price is fine.
    expect(await rescheduleBooking(b.code, { date: b.date, startHour: 11, courtId }, "staff")).toMatchObject({ ok: true });
  });
});

describe("marking a booking unpaid", () => {
  it("is not how money paid online goes back", async () => {
    fakeBillplz();
    const b = await book(12);
    await startBookingPayment({ codes: [b.code], phone: b.phone });
    await settleBill({ billId: lastBill(), paid: true, paidAt: null });
    expect(await setPaymentStatus(b.code, false)).toMatchObject({ ok: false, code: "UNPAY_NOT_COUNTER" });
  });

  it("is the desk's only for its own counter tick, the same day", async () => {
    const today = await book(13);
    expect(await setPaymentStatus(today.code, true, "cash", "desk")).toMatchObject({ ok: true });
    expect(await setPaymentStatus(today.code, false, null, "desk")).toMatchObject({ ok: true });
    const older = await book(14);
    await setPaymentStatus(older.code, true, "cash");
    await getDb().prepare("UPDATE bookings SET paid_at = ? WHERE id = ?").run(`${addDays(todayISO(ZONE), -2)}T03:00:00.000Z`, older.id);
    expect(await setPaymentStatus(older.code, false, null, "desk")).toMatchObject({ ok: false, code: "UNPAY_MANAGER" });
    expect(await setPaymentStatus(older.code, false, null, "manager")).toMatchObject({ ok: true });
  });
});

describe("cancelling by staff", () => {
  it("is not for an hour already played, nor is closing a day gone by", async () => {
    const b = await book(15);
    await moveBookingToDate(b.id, addDays(todayISO(ZONE), -1));
    expect(await adminCancelBooking(b.code)).toMatchObject({ ok: false, code: "CANCEL_PLAYED" });
    expect(await closeVenueDay(venueId, addDays(todayISO(ZONE), -1))).toMatchObject({ ok: false, code: "CLOSURE_PAST" });
  });
});

describe("a code with a limit per customer", () => {
  it("is used once by one phone number, however it is typed", async () => {
    const first = await book(16, "012-777 1234");
    expect(await applyPromo(first.id, "ONCE10")).toMatchObject({ ok: true });
    const again = await book(17, "+60127771234");
    expect(await applyPromo(again.id, "ONCE10")).toMatchObject({ ok: false, code: "PROMO_YOUR_LIMIT" });
    const someoneElse = await book(18);
    expect(await applyPromo(someoneElse.id, "ONCE10")).toMatchObject({ ok: true });
  });
});

describe("moving a booking friends paid towards", () => {
  it("is for the venue, not the customer", async () => {
    const b = await book(19);
    await getDb().prepare("UPDATE bookings SET shares_paid = 5 WHERE id = ?").run(b.id);
    expect(await rescheduleBooking(b.code, { date: b.date, startHour: 20 }, "customer")).toMatchObject({ ok: false, code: "RESCHEDULE_SHARED" });
    expect(await rescheduleBooking(b.code, { date: b.date, startHour: 20 }, "staff")).toMatchObject({ ok: true });
  });
});
