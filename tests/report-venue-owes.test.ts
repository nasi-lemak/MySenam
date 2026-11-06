import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { createAdmin } from "../src/lib/admin-auth";
import { registerUser } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { setHoldPolicy } from "../src/lib/holds";
import { savePaymentSettings, settleBill, startBookingPayment } from "../src/lib/payments";
import { venueReport } from "../src/lib/reports";
import { cancelBooking, createBooking, createCourt, createVenue, issuePass, payBookingWithPass, topUpWallet } from "../src/lib/store";
import { sellVoucher } from "../src/lib/vouchers";
import { addDays, todayISO } from "../src/lib/time";
import { POST as book } from "../src/app/api/bookings/route";

/**
 * What the venue holds for customers, in ringgit (audit 9 C9, G16; ADR 0055): stored credit where it is the
 * venue's, unredeemed gift vouchers, deposits held on bookings and on hired kit, refunds owed, and the value of
 * unspent passes beside them as an estimate that is not in the total.
 */
let venueId: number;
let courtId: number;
let adminId: number;
let n = 0;
const today = todayISO();

function fakeBillplz() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const id = `owes${++n}`;
      return Response.json({ id, url: `https://www.billplz-sandbox.com/bills/${id}` });
    })
  );
}
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MYSENAM_CREDIT_SCOPE;
});

beforeAll(async () => {
  const v = await createVenue({ name: "Owes Hall", area: "PJ", address: "1", phone: "0312345677" });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  const c = await createCourt({ venueId, name: "C1", sport: "badminton", offPeakRate: 40, peakRate: 40 });
  if (!c.ok) throw new Error("court");
  courtId = c.court.id;
  const a = await createAdmin({ name: "Manager", email: "mgr@owes.my", password: "manager-password", venueId });
  if (!a.ok) throw new Error("admin");
  adminId = a.admin.id;
  const saved = await savePaymentSettings(venueId, { apiKey: "api-key-1234", collectionId: "col123", xSignatureKey: "S-key", sandbox: true, enabled: true });
  if (!saved.ok) throw new Error(saved.error);
});

async function depositBooking(offset: number, hour: number, phone: string) {
  const res = await book(
    new NextRequest("http://localhost/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ courtId, date: addDays(today, offset), name: "Dep", email: `dep${hour}@example.my`, hours: [hour], phone }),
    })
  );
  const made = await res.json();
  fakeBillplz();
  const started = await startBookingPayment({ codes: [made.booking.code], phone, deposit: true });
  if (!started.ok) throw new Error("start");
  const bill = (await getDb().prepare("SELECT bill_id FROM online_payments ORDER BY id DESC LIMIT 1").get()) as { bill_id: string };
  await settleBill({ billId: bill.bill_id, paid: true, paidAt: null });
  return made.booking as { id: number; code: string };
}

describe("the venue's liabilities in ringgit", () => {
  it("is all zero for a venue that holds nothing", async () => {
    const v = await createVenue({ name: "Empty Hall", area: "PJ", address: "1", phone: "0312345678" });
    if (!v.ok) throw new Error("venue");
    const report = (await venueReport(v.venue.id, today, today))!;
    expect(report.liabilities.owed).toEqual({
      storedCredit: null,
      giftVouchers: 0,
      giftVouchersLapsed: 0,
      bookingDeposits: 0,
      hireDeposits: 0,
      refunds: 0,
      passValue: 0,
      total: 0,
    });
  });

  it("adds vouchers, booking and hire deposits, refunds owed and the credit the venue owes; the pass estimate stays beside the total", async () => {
    process.env.MYSENAM_CREDIT_SCOPE = "venue";
    // Gift vouchers: RM50 good, RM20 past its date (counted apart, not in the total).
    expect((await sellVoucher({ venueId, amount: 50, buyerName: "Siti", adminId, via: "cash" })).ok).toBe(true);
    const lapsed = await sellVoucher({ venueId, amount: 20, buyerName: "Lina", adminId, via: "cash" });
    if (!lapsed.ok) throw new Error(lapsed.error);
    await getDb().prepare("UPDATE gift_vouchers SET expires_on = ? WHERE id = ?").run(addDays(today, -1), lapsed.voucher.id);

    // A deposit of RM12 held on a booking still to be played; another cancelled in good time, its RM12 owed back.
    await setHoldPolicy(venueId, { on: true, depositPercent: 30 });
    await depositBooking(3, 8, "0191110001");
    const gone = await depositBooking(3, 9, "0191110002");
    await setHoldPolicy(venueId, { on: false });
    expect(await cancelBooking(gone.code, "0191110002")).toMatchObject({ ok: true });

    // Kit out on hire with RM30 of deposit held.
    const hired = await createBooking({ courtId, date: addDays(today, 1), hours: [14], name: "Paddler", phone: "0191110003" });
    if (!hired.ok) throw new Error(JSON.stringify(hired));
    await getDb().prepare("INSERT INTO hire_records (booking_id, deposit) VALUES (?, 30)").run(hired.booking.id);

    // A pass of RM100 for 10 entries, one spent: nine tenths of it left, RM90 as an estimate.
    const pass = await issuePass({ venueId, name: "10 hours", entries: 10, price: 100, holderName: "Holder", holderPhone: "0191110004", expiresOn: addDays(today, 60), adminId: null });
    if (!pass.ok) throw new Error(pass.error);
    const spent = await createBooking({ courtId, date: addDays(today, 4), hours: [8], name: "Holder", phone: "0191110004" });
    if (!spent.ok) throw new Error(JSON.stringify(spent));
    expect((await payBookingWithPass(spent.booking.id, pass.pass.code)).ok).toBe(true);

    // Credit RM25 held by a customer, the venue's own where credit is per venue.
    const user = await registerUser({ name: "Credit User", email: "credit@owes.my", phone: "0191110005", password: "password1" });
    if (!user.ok) throw new Error("user");
    expect((await topUpWallet({ userId: user.user.id, amount: 25, adminId, venueId })).ok).toBe(true);

    const owed = (await venueReport(venueId, today, addDays(today, 7)))!.liabilities.owed;
    expect(owed).toEqual({
      storedCredit: 25,
      giftVouchers: 50,
      giftVouchersLapsed: 20,
      bookingDeposits: 12,
      hireDeposits: 30,
      refunds: 12,
      passValue: 90,
      total: 25 + 50 + 12 + 30 + 12,
    });
  });

  it("leaves credit out where it is the platform's, bought at one counter and spendable at any", async () => {
    process.env.MYSENAM_CREDIT_SCOPE = "platform";
    const owed = (await venueReport(venueId, today, today))!.liabilities.owed;
    expect(owed.storedCredit).toBeNull();
    expect(owed.total).toBe(50 + 12 + 30 + 12);
  });
});
