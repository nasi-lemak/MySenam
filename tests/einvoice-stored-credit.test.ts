import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { registerUser } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { salesJournal } from "../src/lib/accounting";
import { consolidate, einvoiceSettings, listEInvoices, saveEInvoiceSettings, seventhDayAfter, storedValueSales, STORED_VALUE_REFUSAL } from "../src/lib/myinvois";
import { staffRefusal } from "../src/lib/staff-i18n";
import { sellVoucher } from "../src/lib/vouchers";
import { createBooking, createCourt, createVenue, payBookingFromWallet, topUpWallet } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Stored credit, gift vouchers and e-invoicing (audit C2, owner decision DEC-19).
 *
 * What a consolidated e-invoice should do with prepaid value is a tax question nobody here may answer
 * (docs/operations/einvoice-stored-credit-memo.md). Until the tax adviser has, the first test below pins what the code
 * does TODAY, labelled as pending policy so it is ready to be changed when the policy is, and the rest keep
 * e-invoicing from being switched on by accident at a venue that has sold credit or vouchers.
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
  const made = await createVenue({ name, area: "PJ", address: "x", phone: `03000${String(++n).padStart(5, "0")}` });
  if (!made.ok) throw new Error("venue");
  const court = await createCourt({ venueId: made.venue.id, name: "Court 1", sport: "badminton", offPeakRate: 30, peakRate: 30 });
  if (!court.ok) throw new Error("court");
  const manager = await createAdmin({ name: "Mira", email: `mgr-${name.replace(/\W/g, "")}-${n}@x.test`, password: "a long enough password", venueId: made.venue.id, role: "manager" });
  if (!manager.ok) throw new Error(manager.error);
  return { venueId: made.venue.id, courtId: court.court.id, managerId: manager.admin.id };
}

async function customer(label: string) {
  const u = await registerUser({ name: `Cred ${label}`, email: `${label}-${++n}@x.test`, phone: `0177${String(400000 + n)}`, password: "a long enough password" });
  if (!u.ok) throw new Error(u.error);
  return u.user;
}

afterEach(() => vi.unstubAllGlobals());

describe("C2 (PENDING POLICY, DEC-19): what a consolidated e-invoice carries of credit sold and spent", () => {
  it("PENDING POLICY: today an RM100 top-up and the RM30 booking paid from it are both in the consolidated e-invoice, RM130 for RM30 of sales", async () => {
    // This asserts what the code does now, NOT what is right. It is written so that when the tax adviser has answered
    // (docs/operations/einvoice-stored-credit-memo.md), the expected figure here changes with the policy: RM30
    // (exclude the credit receipt, e-invoice the booking) or RM100 (e-invoice the receipt, exclude the credit-paid booking).
    const v = await venueWith("Pending Policy Hall");
    const u = await customer("rm100");
    await topUpWallet({ userId: u.id, amount: 100, adminId: v.managerId, venueId: v.venueId, via: "cash" });
    const booking = await createBooking({ courtId: v.courtId, date: addDays(todayISO(), 2), hours: [10], name: "Cred", phone: "0177400001", userId: u.id });
    if (!booking.ok) throw new Error(booking.error);
    expect((await payBookingFromWallet(booking.booking.id)).ok).toBe(true);

    const period = todayISO().slice(0, 7);
    const journal = await salesJournal(v.venueId, `${period}-01`, `${period}-31`);
    // The journal's own view, which the policy will be settled against: the credit is owed to the customer, the booking is the sale.
    expect(journal.filter((r) => r.type === "Receipt" && r.revenue).reduce((s, r) => s + r.gross, 0)).toBe(30);
    expect(journal.filter((r) => r.type === "Receipt" && !r.revenue).reduce((s, r) => s + r.gross, 0)).toBe(100);

    const made = await consolidate(v.venueId, period);
    const consolidated = made.find((e) => e.kind === "consolidated");
    // PENDING POLICY: 130, the credit sold AND the booking it paid for (audit C2). Not resolved, not a decision.
    expect(consolidated?.total).toBe(130);
    expect((await listEInvoices(v.venueId)).find((e) => e.kind === "consolidated")?.sentLines).toBeNull(); // nothing was sent anywhere
  });
});

describe("C2: e-invoicing is not switched on by accident where credit or vouchers have been sold", () => {
  it("a venue that has sold neither is not held back", async () => {
    const v = await venueWith("Plain Hall");
    expect(await storedValueSales(v.venueId)).toEqual({ credit: false, vouchers: false });
    expect(await saveEInvoiceSettings(v.venueId, SETTINGS)).toMatchObject({ ok: true, settings: { enabled: true, storedValueSales: { credit: false, vouchers: false } } });
  });

  it("a venue that has sold credit is refused without its manager's word, and allowed with it", async () => {
    const v = await venueWith("Credit Hall");
    const u = await customer("credit");
    await topUpWallet({ userId: u.id, amount: 50, adminId: v.managerId, venueId: v.venueId, via: "cash" });
    expect(await storedValueSales(v.venueId)).toEqual({ credit: true, vouchers: false });

    const refused = await saveEInvoiceSettings(v.venueId, SETTINGS);
    expect(refused).toEqual({ ok: false, error: STORED_VALUE_REFUSAL });
    expect((await einvoiceSettings(v.venueId)).enabled).toBe(false);
    // Saying so is not enough while switching it off, or leaving it off.
    expect(await saveEInvoiceSettings(v.venueId, { ...SETTINGS, enabled: false })).toMatchObject({ ok: true });
    expect(await saveEInvoiceSettings(v.venueId, { ...SETTINGS, acknowledgeStoredValue: "yes" })).toMatchObject({ ok: false });
    // A manager who has said so can turn it on; it is theirs to answer for, and a venue already on can still be edited.
    expect(await saveEInvoiceSettings(v.venueId, { ...SETTINGS, acknowledgeStoredValue: true })).toMatchObject({ ok: true, settings: { enabled: true } });
    expect(await saveEInvoiceSettings(v.venueId, { ...SETTINGS, legalName: "Courts Berhad" })).toMatchObject({ ok: true });
    // Nothing is excluded from the journal or the e-invoice on a guess: the double count above stands until the policy is settled.
  });

  it("a gift voucher sold counts too, and the refusal is said in Malay and Chinese", async () => {
    const v = await venueWith("Voucher Hall");
    await sellVoucher({ venueId: v.venueId, amount: 60, buyerName: "Siti", recipientName: "Farah", adminId: v.managerId, via: "cash" });
    expect(await storedValueSales(v.venueId)).toEqual({ credit: false, vouchers: true });
    expect(await saveEInvoiceSettings(v.venueId, SETTINGS)).toEqual({ ok: false, error: STORED_VALUE_REFUSAL });
    expect(staffRefusal(STORED_VALUE_REFUSAL, "ms")).toContain("baucar hadiah");
    expect(staffRefusal(STORED_VALUE_REFUSAL, "zh")).toContain("礼券");
  });

  it("credit sold at another venue is not this venue's", async () => {
    const a = await venueWith("Seller Hall");
    const b = await venueWith("Bystander Hall");
    const u = await customer("elsewhere");
    await topUpWallet({ userId: u.id, amount: 20, adminId: a.managerId, venueId: a.venueId, via: "cash" });
    expect((await storedValueSales(b.venueId)).credit).toBe(false);
    expect(await saveEInvoiceSettings(b.venueId, SETTINGS)).toMatchObject({ ok: true });
  });

  it("the route refuses it with the explanation, records the acknowledgement, and stays inside the venue", async () => {
    const v = await venueWith("Route Hall");
    const other = await venueWith("Other Route Hall");
    await sellVoucher({ venueId: v.venueId, amount: 40, buyerName: "Siti", adminId: v.managerId, via: "cash" });
    const route = await import("../src/app/api/admin/einvoicing/route");
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(v.managerId)).token}`;
    const post = (venueId: number, body: Record<string, unknown>) =>
      route.POST(new NextRequest("http://localhost/api/admin/einvoicing", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ venueId, action: "save", ...SETTINGS, ...body }) }));

    const refused = await post(v.venueId, {});
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toBe(STORED_VALUE_REFUSAL);
    expect((await post(v.venueId, { acknowledgeStoredValue: true })).status).toBe(200);
    const logged = (await getDb().prepare("SELECT detail FROM staff_actions WHERE action = 'einvoice.settings' AND venue_id = ? ORDER BY id DESC LIMIT 1").get(v.venueId)) as { detail: string };
    expect(logged.detail).toContain("acknowledged that stored credit or vouchers have been sold");
    // Another venue's manager cannot touch this venue's settings.
    expect((await post(other.venueId, {})).status).toBe(403);
    const info = await route.GET(new NextRequest(`http://localhost/api/admin/einvoicing?venueId=${v.venueId}`, { headers: { cookie } }));
    expect((await info.json()).settings.storedValueSales).toEqual({ credit: false, vouchers: true });
  });
});

describe("G15: a consolidated e-invoice sent after day 7 is marked late, and nothing else changes", () => {
  it("the seventh day after a period", () => {
    expect(seventhDayAfter("2026-10")).toBe("2026-11-07");
    expect(seventhDayAfter("2026-12")).toBe("2027-01-07");
  });

  it("is late when it is sent (or, unsent, now) after the 7th of the next month, and not before", async () => {
    const v = await venueWith("Late Hall");
    // A period long gone, so "now" is certainly after its seventh day: a draft is late the day it is looked at.
    const old = await getDb()
      .prepare("INSERT INTO e_invoices (venue_id, kind, type_code, code_number, period, total) VALUES (?, 'consolidated', '01', 'CON-2020-01', '2020-01', 10) RETURNING id")
      .get(v.venueId) as { id: number };
    // A document sent on the 7th of the next month is on time; on the 8th it is late.
    await getDb()
      .prepare("INSERT INTO e_invoices (venue_id, kind, type_code, code_number, period, total, status, submitted_at) VALUES (?, 'consolidated', '01', 'CON-2020-02', '2020-02', 10, 'valid', '2020-03-07 12:00:00')")
      .run(v.venueId);
    await getDb()
      .prepare("INSERT INTO e_invoices (venue_id, kind, type_code, code_number, period, total, status, submitted_at) VALUES (?, 'consolidated', '01', 'CON-2020-03', '2020-03', 10, 'valid', '2020-04-08 12:00:00')")
      .run(v.venueId);
    await getDb()
      .prepare("INSERT INTO e_invoices (venue_id, kind, type_code, code_number, period, receipt_ref, receipt_number, total) VALUES (?, 'individual', '01', 'EI-X', '2020-01', 'R1', 'R-1', 10)")
      .run(v.venueId);
    const list = await listEInvoices(v.venueId);
    const by = (code: string) => list.find((e) => e.codeNumber === code)!;
    expect(by("CON-2020-01")).toMatchObject({ late: true, lateAfter: "2020-02-07", status: "pending" });
    expect(by("CON-2020-02")).toMatchObject({ late: false, lateAfter: "2020-03-07" });
    expect(by("CON-2020-03")).toMatchObject({ late: true, lateAfter: "2020-04-07" });
    // A customer's own e-invoice has no seventh day.
    expect(by("EI-X")).toMatchObject({ late: false, lateAfter: null });
    expect(old.id).toBeGreaterThan(0);
  });
});
