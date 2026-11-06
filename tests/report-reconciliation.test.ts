import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { salesJournal, totals } from "../src/lib/accounting";
import { createAdmin } from "../src/lib/admin-auth";
import { registerUser } from "../src/lib/auth";
import { setCancelPolicy } from "../src/lib/cancel-policy";
import { getDb } from "../src/lib/db";
import { setHoldPolicy } from "../src/lib/holds";
import { savePaymentSettings, settleBill, startBookingPayment, startSplitPayment } from "../src/lib/payments";
import { adjustBookingPrice } from "../src/lib/price-adjustments";
import { venueReport } from "../src/lib/reports";
import { splitBooking } from "../src/lib/splits";
import {
  cancelBooking,
  createBooking,
  createCourt,
  createVenue,
  findBooking,
  issuePass,
  payBookingFromWallet,
  payBookingWithPass,
  setPaymentStatus,
  topUpWallet,
} from "../src/lib/store";
import { setVenueTax } from "../src/lib/tax";
import { addDays, todayISO } from "../src/lib/time";
import { POST as book } from "../src/app/api/bookings/route";

/**
 * The period report's booking money is the sales journal's (ADR 0055, docs/features/reporting.md): a scenario set,
 * every booking paid and played inside one period, asserting that the report's `collected` (and its tax, its split by
 * how it was paid, by sport and by month) equals what the journal holds for bookings, and that the report's
 * `expected` is accounted for by collected, outstanding, given back and pass-paid. Audit 9 G3, G4, G5, C8.
 */
let venueId: number;
let courtId: number;
let mgr: number;
let n = 0;
const today = todayISO();
const to = addDays(today, 8);
const day = (offset: number) => addDays(today, offset);

function fakeBillplz() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const id = `recon${++n}`;
      return Response.json({ id, url: `https://www.billplz-sandbox.com/bills/${id}` });
    })
  );
}
const billOf = (url: string) => url.split("/").pop()!;
afterEach(() => vi.unstubAllGlobals());

beforeAll(async () => {
  const v = await createVenue({ name: "Recon Hall", area: "PJ", address: "1", phone: "0312345600" });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  expect((await setVenueTax(venueId, { registered: true, rate: 8, regNo: "SST-1" })).ok).toBe(true);
  const c = await createCourt({ venueId, name: "C1", sport: "badminton", offPeakRate: 40, peakRate: 40 });
  if (!c.ok) throw new Error("court");
  courtId = c.court.id;
  const a = await createAdmin({ name: "Manager", email: "mgr@recon.my", password: "manager-password", venueId });
  if (!a.ok) throw new Error("admin");
  mgr = a.admin.id;
  const saved = await savePaymentSettings(venueId, { apiKey: "api-key-1234", collectionId: "col123", xSignatureKey: "S-key", sandbox: true, enabled: true });
  if (!saved.ok) throw new Error(saved.error);
  await getDb().prepare("UPDATE venues SET cancel_cutoff_hours = 2 WHERE id = ?").run(venueId);
});

async function plain(offset: number, hour: number, phone: string) {
  const b = await createBooking({ courtId, date: day(offset), hours: [hour], name: "Plain", phone });
  if (!b.ok) throw new Error(JSON.stringify(b));
  return b.booking;
}

/** A booking made through the form, held for a 30% deposit (RM12 on RM40), the deposit paid online. */
async function withDeposit(offset: number, hour: number, phone: string) {
  const res = await book(
    new NextRequest("http://localhost/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ courtId, date: day(offset), name: "Dep", email: `dep${hour}@example.my`, hours: [hour], phone }),
    })
  );
  const made = await res.json();
  fakeBillplz();
  const started = await startBookingPayment({ codes: [made.booking.code], phone, deposit: true });
  if (!started.ok) throw new Error("start");
  const bill = (await getDb().prepare("SELECT bill_id FROM online_payments ORDER BY id DESC LIMIT 1").get()) as { bill_id: string };
  await settleBill({ billId: bill.bill_id, paid: true, paidAt: null });
  const booking = (await findBooking(made.booking.code, phone))!;
  expect(booking.depositPaid).toBe(12);
  return booking;
}

describe("the report's booking money is the journal's", () => {
  it("over a scenario set: cash, deposit then balance, split shares, pass, credit, refund, adjustment, late cancellations", async () => {
    // 1. A plain paid booking, RM40 cash.
    const cash = await plain(1, 8, "0190000001");
    expect((await setPaymentStatus(cash.code, true, "cash")).ok).toBe(true);

    // 2. A deposit (RM12 online), then the balance (RM28) at the counter.
    await setHoldPolicy(venueId, { on: true, depositPercent: 30 });
    const dep = await withDeposit(2, 9, "0190000002");
    await setHoldPolicy(venueId, { on: false });
    expect((await setPaymentStatus(dep.code, true, "cash")).ok).toBe(true);

    // 3. Split two ways: a friend pays RM20 online, the booker RM20 at the counter.
    const split = await plain(2, 10, "0190000003");
    const made = await splitBooking(split.code, split.phone, 2);
    if (!made.ok) throw new Error(made.error);
    fakeBillplz();
    const friend = await startSplitPayment(made.split.token, { name: "Friend", phone: "0190000093", email: "friend@example.my" });
    if (!friend.ok) throw new Error(friend.error);
    await settleBill({ billId: billOf(friend.url), paid: true, paidAt: null });
    expect((await setPaymentStatus(split.code, true, "cash")).ok).toBe(true);

    // 4. Paid with a pass: the pass sale (RM180) is the money, the booking is not.
    const pass = await issuePass({ venueId, name: "10 hours", entries: 10, price: 180, holderName: "Holder", holderPhone: "0190000004", expiresOn: day(60), adminId: null });
    if (!pass.ok) throw new Error(pass.error);
    const passed = await plain(3, 8, "0190000004");
    expect((await payBookingWithPass(passed.id, pass.pass.code)).ok).toBe(true);

    // 5. Paid from stored credit: the top-up is owed to the customer, the booking is the sale.
    const user = await registerUser({ name: "Credit User", email: "credit@recon.my", phone: "0190000005", password: "password1" });
    if (!user.ok) throw new Error("user");
    await topUpWallet({ userId: user.user.id, amount: 100, adminId: mgr });
    const credited = await createBooking({ courtId, date: day(3), hours: [9], name: "Credit User", phone: "0190000005", userId: user.user.id });
    if (!credited.ok) throw new Error(JSON.stringify(credited));
    expect((await payBookingFromWallet(credited.booking.id)).ok).toBe(true);

    // 6. Paid, then cancelled in good time: refunded in full, a credit note for all of it.
    const refunded = await plain(7, 8, "0190000006");
    expect((await setPaymentStatus(refunded.code, true, "cash")).ok).toBe(true);
    expect(await cancelBooking(refunded.code, "0190000006")).toMatchObject({ ok: true });

    // 7. Paid RM40, then a goodwill adjustment to RM30: the receipt stays, a credit note takes RM10.
    const adjusted = await plain(4, 8, "0190000007");
    expect((await setPaymentStatus(adjusted.code, true, "cash")).ok).toBe(true);
    expect((await adjustBookingPrice({ code: adjusted.code, amount: 30, reason: "Goodwill: the lights failed", staff: { id: mgr, name: "Manager", role: "manager" } })).ok).toBe(true);

    // 8. An unpaid booking: all RM40 outstanding.
    await plain(4, 9, "0190000008");

    // 9. Cancelled late, the venue keeping half: RM20 of the RM40 kept (the cut-off is raised only for these).
    await getDb().prepare("UPDATE venues SET cancel_cutoff_hours = 400 WHERE id = ?").run(venueId);
    expect((await setCancelPolicy(venueId, { lateKeep: 50 })).ok).toBe(true);
    const late = await plain(5, 8, "0190000009");
    expect((await setPaymentStatus(late.code, true, "qr")).ok).toBe(true);
    expect(await cancelBooking(late.code, "0190000009")).toMatchObject({ ok: true, kept: 20 });

    // 10. A deposit on a booking cancelled late: half of the RM12 deposit kept.
    await setHoldPolicy(venueId, { on: true, depositPercent: 30 });
    const lateDep = await withDeposit(5, 9, "0190000010");
    await setHoldPolicy(venueId, { on: false });
    expect(await cancelBooking(lateDep.code, "0190000010")).toMatchObject({ ok: true });

    // 11. A friend's share on a booking cancelled late: half of the RM20 share kept, and none of the booker's (unpaid).
    const lateSplit = await plain(6, 8, "0190000011");
    const made2 = await splitBooking(lateSplit.code, lateSplit.phone, 2);
    if (!made2.ok) throw new Error(made2.error);
    fakeBillplz();
    const friend2 = await startSplitPayment(made2.split.token, { name: "Friend Two", phone: "0190000094", email: "friend2@example.my" });
    if (!friend2.ok) throw new Error(friend2.error);
    await settleBill({ billId: billOf(friend2.url), paid: true, paidAt: null });
    expect(await cancelBooking(lateSplit.code, lateSplit.phone)).toMatchObject({ ok: true });

    // The report and the journal, over a period holding every date of every booking above.
    const report = (await venueReport(venueId, today, to))!;
    const journal = totals(await salesJournal(venueId, today, to));
    const category = (name: string) => journal.byCategory.find((c) => c.category === name);

    // Booking money, scenario by scenario, as the journal has it: 40 + (12 + 28) + (20 + 20) + 0 (pass) + 40 (credit)
    // + 0 (refunded) + 30 + 0 + 20 (kept) + 6 (deposit kept) + 10 (share kept).
    const courtHire = category("Court hire")!.gross;
    expect(courtHire).toBe(40 + 40 + 40 + 40 + 30 + 20 + 6 + 10);
    expect(report.revenue.collected).toBe(courtHire);
    expect(report.revenue.lateKept).toBe(20 + 6 + 10);
    // The pass sale is the money for the pass-paid booking, and is not in the booking figures.
    expect(category("Passes")!.gross).toBe(180);
    expect(report.revenue.passPaid).toEqual({ bookings: 1, value: 40 });
    expect(report.collectedBy.find((c) => c.via === "pass")).toBeUndefined();
    // The credit sold is not takings; the booking it paid is.
    expect(category("Stored credit")?.revenue ?? false).toBe(false);
    expect(journal.takings.gross).toBe(courtHire + 180);

    // What the report splits it by adds back to the same figure.
    const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;
    expect(sum(report.collectedBy.map((c) => c.amount))).toBe(report.revenue.collected);
    expect(sum(report.bySport.map((s) => s.collected))).toBe(report.revenue.collected);
    expect(sum(report.byMonth.map((m) => m.collected))).toBe(report.revenue.collected);

    // Outstanding: the unpaid RM40 booking; the others are paid in full or cancelled. Expected is accounted for.
    expect(report.revenue.outstanding).toBe(40);
    expect(report.revenue.adjusted).toBe(10);
    expect(report.revenue.expected).toBe(7 * 40);
    expect(report.revenue.collected - report.revenue.lateKept + report.revenue.outstanding + report.revenue.adjusted + report.revenue.passPaid.value).toBe(
      report.revenue.expected
    );

    // The sales tax inside it is the journal's too (the pass sale, a receipt of its own, is in both).
    expect(report.revenue.tax!.amount).toBe(journal.takings.tax);
  });

  it("with only a deposit paid, collected is the deposit and outstanding the balance", async () => {
    const venue = await createVenue({ name: "Deposit Hall", area: "PJ", address: "1", phone: "0312345601" });
    if (!venue.ok) throw new Error("venue");
    const court = await createCourt({ venueId: venue.venue.id, name: "C1", sport: "badminton", offPeakRate: 40, peakRate: 40 });
    if (!court.ok) throw new Error("court");
    await savePaymentSettings(venue.venue.id, { apiKey: "api-key-5678", collectionId: "col456", xSignatureKey: "S-key2", sandbox: true, enabled: true });
    await setHoldPolicy(venue.venue.id, { on: true, depositPercent: 30 });
    const res = await book(
      new NextRequest("http://localhost/api/bookings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ courtId: court.court.id, date: day(2), name: "Dep", email: "dep2@example.my", hours: [10], phone: "0190000020" }),
      })
    );
    const made = await res.json();
    fakeBillplz();
    const started = await startBookingPayment({ codes: [made.booking.code], phone: "0190000020", deposit: true });
    if (!started.ok) throw new Error("start");
    const bill = (await getDb().prepare("SELECT bill_id FROM online_payments ORDER BY id DESC LIMIT 1").get()) as { bill_id: string };
    await settleBill({ billId: bill.bill_id, paid: true, paidAt: null });
    const report = (await venueReport(venue.venue.id, day(2), day(2)))!;
    const journal = totals(await salesJournal(venue.venue.id, today, day(2)));
    expect(journal.takings.gross).toBe(12);
    expect(report.revenue).toMatchObject({ expected: 40, collected: 12, outstanding: 28, lateKept: 0 });
    expect(report.collectedBy).toEqual([{ via: "online", amount: 12, bookings: 1 }]);
    expect(report.venueName).toBe("Deposit Hall");
  });
});
