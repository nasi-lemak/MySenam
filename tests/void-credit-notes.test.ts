import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { salesJournal, totals } from "../src/lib/accounting";
import { documentFor } from "../src/lib/documents";
import { adminCancelBooking, createBooking, createCourt, createVenue, issuePass, payBookingWithPass, sellMembership, voidMembership, voidPass } from "../src/lib/store";
import { setVenueTax } from "../src/lib/tax";
import { venueReport } from "../src/lib/reports";
import { addDays, todayISO } from "../src/lib/time";
import { POST as voidPassRoute } from "../src/app/api/admin/passes/[id]/void/route";
import { POST as voidMembershipRoute } from "../src/app/api/admin/memberships/[id]/void/route";

/**
 * Voiding a pass or a membership is not a refund (audit R8, X3-2): the sale
 * stays sold, with no credit note; only what is handed back is credited, and
 * entries spent stay revenue. The sales journal and the tax figures agree.
 */

let venueId: number;
let courtId: number;
let manager: string;
const today = todayISO();

beforeAll(async () => {
  const v = await createVenue({ name: "Pass Hall", area: "PJ", address: "1", phone: "0312345678" });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  expect((await setVenueTax(venueId, { registered: true, rate: 8, regNo: "SST-1" })).ok).toBe(true);
  const c = await createCourt({ venueId, name: "C1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!c.ok) throw new Error("court");
  courtId = c.court.id;
  const m = await createAdmin({ name: "Manager", email: "mgr@passhall.my", password: "manager-password-1", venueId });
  if (!m.ok) throw new Error(m.error);
  manager = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(m.admin.id)).token}`;
});

async function passWithOneSpent(phone: string) {
  const p = await issuePass({ venueId, name: "Two hours", entries: 2, price: 100, holderName: "Aisyah", holderPhone: phone, expiresOn: addDays(today, 90), adminId: null });
  if (!p.ok) throw new Error(JSON.stringify(p));
  const b = await createBooking({ courtId, date: addDays(today, 2), hours: [9 + Number(phone.slice(-1))], name: "Aisyah", phone });
  if (!b.ok) throw new Error(JSON.stringify(b));
  expect((await payBookingWithPass(b.booking.id, p.pass.code)).ok).toBe(true);
  return p.pass;
}

const journal = async () => salesJournal(venueId, today, addDays(today, 3));
const post = (url: string, body: unknown) =>
  new NextRequest(url, { method: "POST", headers: { "content-type": "application/json", cookie: manager }, body: JSON.stringify(body) });

describe("voiding a pass", () => {
  it("writes no credit note: the sale and its tax stay, an entry having been played", async () => {
    const pass = await passWithOneSpent("0197770001");
    const receipt = (await documentFor(`pass:${pass.id}`))!;
    expect(receipt).toMatchObject({ total: 100, tax: { rate: 8, amount: 7.41 } });
    expect(await voidPass(pass.id)).toMatchObject({ ok: true, pass: { status: "void" } });
    expect(await documentFor(`credit:${receipt.id}`)).toBeNull();
    expect((await journal()).filter((r) => r.number === receipt.number || r.type === "Credit note")).toEqual([
      expect.objectContaining({ type: "Receipt", gross: 100, tax: 7.41 }),
    ]);
  });

  it("with the unused part handed back, credits that part only, at the tax it was sold at", async () => {
    const pass = await passWithOneSpent("0197770002");
    const receipt = (await documentFor(`pass:${pass.id}`))!;
    const res = await voidPassRoute(post(`http://localhost/api/admin/passes/${pass.id}/void`, { refund: true }), { params: Promise.resolve({ id: String(pass.id) }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ pass: { status: "void" }, refunded: 50 });
    expect(await documentFor(`credit:${receipt.id}:unused`)).toMatchObject({ kind: "credit_note", total: 50, tax: { rate: 8, amount: 3.7 }, note: "receipt.why.voided" });
    const rows = (await journal()).filter((r) => r.customer === "Aisyah" && r.category === "Passes");
    // The pass sold: this one (100) and the one before (100); 50 of this one handed back.
    expect(totals(rows).takings).toMatchObject({ gross: 150, tax: 11.12 });
  });

  it("a booking it paid for, cancelled, gives the entry back and no money: the journal keeps the pass sold", async () => {
    const p = await issuePass({ venueId, name: "Two hours", entries: 2, price: 100, holderName: "Dina", holderPhone: "0197770004", expiresOn: addDays(today, 90), adminId: null });
    if (!p.ok) throw new Error(JSON.stringify(p));
    const b = await createBooking({ courtId, date: addDays(today, 3), hours: [16], name: "Dina", phone: "0197770004" });
    if (!b.ok) throw new Error(JSON.stringify(b));
    expect((await payBookingWithPass(b.booking.id, p.pass.code)).ok).toBe(true);
    expect((await adminCancelBooking(b.booking.code)).ok).toBe(true);
    const rows = (await journal()).filter((r) => r.customer === "Dina");
    expect(rows.map((r) => [r.type, r.category, r.gross])).toEqual([["Receipt", "Passes", 100]]);
  });

  it("with nothing unused, hands nothing back", async () => {
    const p = await issuePass({ venueId, name: "One hour", entries: 1, price: 50, holderName: "Ben", holderPhone: "0197770003", expiresOn: addDays(today, 90), adminId: null });
    if (!p.ok) throw new Error(JSON.stringify(p));
    const b = await createBooking({ courtId, date: addDays(today, 3), hours: [15], name: "Ben", phone: "0197770003" });
    if (!b.ok) throw new Error(JSON.stringify(b));
    expect((await payBookingWithPass(b.booking.id, p.pass.code)).ok).toBe(true);
    expect(await voidPass(p.pass.id, { refund: true })).toMatchObject({ ok: true, refunded: 0 });
    expect(await documentFor(`credit:${(await documentFor(`pass:${p.pass.id}`))!.id}`)).toBeNull();
  });
});

describe("voiding a membership", () => {
  async function sold(phone: string) {
    const m = await sellMembership({ venueId, holderName: "Chong", holderPhone: phone, startsOn: today, expiresOn: addDays(today, 30), price: 54 });
    if (!m.ok) throw new Error(JSON.stringify(m));
    return m.membership;
  }

  it("without the money back, writes no credit note: the sale stays sold", async () => {
    const m = await sold("0197770011");
    const res = await voidMembershipRoute(post(`http://localhost/api/admin/memberships/${m.id}/void`, {}), { params: Promise.resolve({ id: String(m.id) }) });
    expect(res.status).toBe(200);
    expect(await documentFor(`credit:${(await documentFor(`membership:${m.id}`))!.id}`)).toBeNull();
    // Its tax stays in the period's tax, in the report as in the sales journal.
    const report = (await venueReport(venueId, today, today))!;
    const journalled = totals(await salesJournal(venueId, today, today));
    expect(journalled.byCategory.find((c) => c.category === "Memberships")).toMatchObject({ gross: 54, tax: 4 });
    expect(report.revenue.tax?.amount).toBe(journalled.takings.tax);
  });

  it("with the money back, credits its receipt in full", async () => {
    const m = await sold("0197770012");
    expect(await voidMembership(m.id, { refund: true })).toMatchObject({ ok: true });
    const receipt = (await documentFor(`membership:${m.id}`))!;
    expect(await documentFor(`credit:${receipt.id}`)).toMatchObject({ kind: "credit_note", total: 54, tax: { rate: 8, amount: 4 } });
  });
});
