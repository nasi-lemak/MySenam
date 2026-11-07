import { afterEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { createAdmin } from "../src/lib/admin-auth";
import { registerUser } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { consolidate, listEInvoices, saveEInvoiceSettings, storedValueSales, STORED_VALUE_REFUSAL } from "../src/lib/myinvois";
import { createOutage } from "../src/lib/outages";
import { redeemVoucher, sellVoucher, voidVoucher } from "../src/lib/vouchers";
import { createBooking, createCourt, createVenue, getWalletBalance, payBookingFromWallet, topUpWallet } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Cross-domain: stored credit and gift vouchers crossing the e-invoice boundary (audit C2, DEC-19, ADR 0065) with the cancellation
 * paths of the other rounds. What a consolidated e-invoice should carry of prepaid value is a tax question nobody here may answer
 * (docs/operations/einvoice-stored-credit-memo.md): the numbers below are what the code does TODAY and are labelled PENDING POLICY
 * where they would change with the adviser's answer. Nothing is sent to LHDN here (UNVERIFIED against the sandbox).
 */

const SETTINGS = {
  enabled: true,
  sandbox: true,
  mode: "own",
  clientId: "client-123",
  clientSecret: "secret-456",
  tin: "C1234567890",
  brn: "202001000001",
  msicCode: "93119",
  msicName: "Operation of sports facilities",
  legalName: "Courts Sdn Bhd",
  addressLine: "1 Jalan Sukan",
  city: "Petaling Jaya",
  postcode: "46000",
  stateCode: "10",
  phone: "+60312345678",
  email: "finance@courts.my",
};

let n = 0;
async function venueWith(name: string) {
  const made = await createVenue({ name, area: "PJ", address: "x", phone: `03001${String(++n).padStart(5, "0")}`, openMin: 8 * 60, closeMin: 22 * 60 });
  if (!made.ok) throw new Error("venue");
  const court = await createCourt({ venueId: made.venue.id, name: "Court 1", sport: "badminton", offPeakRate: 30, peakRate: 30 });
  if (!court.ok) throw new Error("court");
  const manager = await createAdmin({ name: "Mira", email: `mgr-xe-${n}@x.test`, password: "a long enough password", venueId: made.venue.id, role: "manager" });
  if (!manager.ok) throw new Error(manager.error);
  return { venueId: made.venue.id, courtId: court.court.id, managerId: manager.admin.id };
}
async function customer(label: string) {
  const u = await registerUser({ name: `XE ${label}`, email: `${label}-${++n}@xe.test`, phone: `0177${String(500000 + n)}`, password: "a long enough password" });
  if (!u.ok) throw new Error(u.error);
  return u.user;
}

afterEach(() => vi.unstubAllGlobals());

describe("credit and a voucher sold, spent on a booking the venue then cancels, and the consolidated e-invoice", () => {
  it("the guard keeps its word after the acknowledgement, the customer's money is whole, and the numbers are the pending-policy ones", async () => {
    const v = await venueWith("Boundary Hall");
    const u = await customer("boundary");
    // Credit and a voucher sold: the guard asks for the manager's word before e-invoicing is switched on.
    await topUpWallet({ userId: u.id, amount: 100, adminId: v.managerId, venueId: v.venueId, via: "cash" });
    const sold = await sellVoucher({ venueId: v.venueId, amount: 60, buyerName: "Siti", recipientName: "Farah", adminId: v.managerId, via: "cash" });
    if (!sold.ok) throw new Error(JSON.stringify(sold));
    expect(await storedValueSales(v.venueId)).toEqual({ credit: true, vouchers: true });
    expect(await saveEInvoiceSettings(v.venueId, SETTINGS)).toEqual({ ok: false, error: STORED_VALUE_REFUSAL });
    expect(await saveEInvoiceSettings(v.venueId, { ...SETTINGS, acknowledgeStoredValue: true })).toMatchObject({ ok: true, settings: { enabled: true } });

    // The voucher is redeemed into the customer's credit, a booking is paid from it, and the venue then cancels the booking.
    expect(await redeemVoucher(u.id, sold.voucher.code)).toMatchObject({ ok: true });
    expect(await getWalletBalance(u.id, v.venueId)).toBe(160);
    const date = addDays(todayISO(), 3);
    const made = await createBooking({ courtId: v.courtId, date, hours: [10], name: "XE", phone: u.phone, userId: u.id });
    if (!made.ok) throw new Error(JSON.stringify(made));
    expect((await payBookingFromWallet(made.booking.id)).ok).toBe(true);
    expect(await getWalletBalance(u.id, v.venueId)).toBe(130);
    expect((await createOutage({ courtId: v.courtId, startsOn: date, endsOn: date, adminId: v.managerId, cancelAffected: true })).ok).toBe(true);
    // Whatever the tax treatment, the customer is whole: all RM160 of credit back, none lost, none doubled.
    expect(await getWalletBalance(u.id, v.venueId)).toBe(160);
    // A redeemed voucher cannot be voided afterwards to take the value back twice.
    expect(await voidVoucher(sold.voucher.id, v.venueId)).toMatchObject({ ok: false });
    expect(await getWalletBalance(u.id, v.venueId)).toBe(160);

    const period = todayISO().slice(0, 7);
    const made1 = await consolidate(v.venueId, period);
    const consolidated = made1.find((e) => e.kind === "consolidated");
    const credit = made1.find((e) => e.kind === "consolidated_credit");
    // PENDING POLICY (DEC-19): the credit receipt and the booking paid from it are both in the consolidated e-invoice, and the
    // booking's credit note reverses only the booking, so the consolidated e-invoice and its credit note differ by the credit sold.
    // Pinned so that a change in the guard or the cancellation paths shows here; the figure is the adviser's to decide, not code's.
    expect(consolidated?.total).toBe(190); // RM100 credit + RM60 voucher + the RM30 booking paid from them
    expect(credit?.total).toBe(30); // the booking only; the credit and the voucher are not reversed
    expect(credit?.refersCode).toBe(consolidated?.codeNumber);
    // Once a month: a second call makes nothing, and nothing was sent anywhere.
    expect(await consolidate(v.venueId, period)).toEqual([]);
    expect((await listEInvoices(v.venueId)).every((e) => e.sentLines === null)).toBe(true);
    // The row count is the same after asking twice.
    const rows = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM e_invoices WHERE venue_id = ?").get(v.venueId)) as { n: number };
    expect(rows.n).toBe(made1.length);
  });

  it("credit sold after e-invoicing was already on is not stopped, and is seen by the guard from then on", async () => {
    const v = await venueWith("Late Credit Hall");
    expect(await saveEInvoiceSettings(v.venueId, SETTINGS)).toMatchObject({ ok: true, settings: { enabled: true } });
    const u = await customer("later");
    await topUpWallet({ userId: u.id, amount: 50, adminId: v.managerId, venueId: v.venueId, via: "cash" });
    expect(await storedValueSales(v.venueId)).toEqual({ credit: true, vouchers: false });
    // A venue already on is edited without being asked again; one switched off and on again is asked.
    expect(await saveEInvoiceSettings(v.venueId, { ...SETTINGS, legalName: "Courts Berhad" })).toMatchObject({ ok: true });
    expect(await saveEInvoiceSettings(v.venueId, { ...SETTINGS, enabled: false })).toMatchObject({ ok: true });
    expect(await saveEInvoiceSettings(v.venueId, SETTINGS)).toEqual({ ok: false, error: STORED_VALUE_REFUSAL });
  });
});
