import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_MARKETPLACE = "on";
process.env.MYSENAM_GEOCODER = "off";

import { NextRequest } from "next/server";
import { journalCsv, salesJournal } from "../src/lib/accounting";
import { ADMIN_SESSION_COOKIE, authenticateAdmin, createAdmin, createAdminSession, type Admin } from "../src/lib/admin-auth";
import { listActivity } from "../src/lib/activity";
import { submitApplication } from "../src/lib/applications";
import { registerUser } from "../src/lib/auth";
import { strikesFor } from "../src/lib/cancel-policy";
import { cashUp } from "../src/lib/cash-up";
import { customerReport } from "../src/lib/customer-report";
import { getDb } from "../src/lib/db";
import { bookingsCsv } from "../src/lib/export";
import { consolidate } from "../src/lib/myinvois";
import { venueReport } from "../src/lib/reports";
import {
  createBooking,
  createCourt,
  createVenue,
  findBookingByCode,
  getWalletBalance,
  issuePass,
  payBookingFromWallet,
  payBookingWithPass,
  setPaymentStatus,
  topUpWallet,
} from "../src/lib/store";
import { clearTestBookings, keepTestBookings, standingTestBookings } from "../src/lib/test-bookings";
import { addDays, todayISO } from "../src/lib/time";
import { GET as testsGet, POST as testsPost } from "../src/app/api/admin/test-bookings/route";
import { POST as goLivePost } from "../src/app/api/admin/go-live/route";

/**
 * X1-16: bookings made while a venue is a draft are tests. They keep their
 * receipts and credit notes, are left out of the venue's performance figures,
 * are marked for staff, and are cleared (everything given back, nobody
 * messaged) or kept as real ones by a manager. R10A: marking a booking a test
 * never takes money out of the financial records, and a manager clearing one
 * with a counter payment says whether real money was taken.
 */

const ZONE = "Asia/Kuala_Lumpur";
const today = todayISO(ZONE);
const month = today.slice(0, 7);
let manager: Admin;
let draft: number;
let draftCourt: number;
let live: number;
let liveCourt: number;
let asManager: string;
let asDesk: string;
let userId: number;
let n = 0;

const call = (handler: (req: NextRequest) => Promise<Response>, url: string, cookie: string, body?: unknown) =>
  handler(
    new NextRequest(`http://localhost${url}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  );

async function book(courtId: number, days: number, extra: Record<string, unknown> = {}) {
  const b = await createBooking({ courtId, date: addDays(today, days), hours: [8 + (n++ % 12)], name: "Tess Tester", phone: "0127770001", ...extra });
  if (!b.ok) throw new Error(b.error);
  return b.booking;
}

const isTest = async (code: string) =>
  ((await getDb().prepare("SELECT test FROM bookings WHERE code = ?").get(code)) as { test: boolean }).test;
const messages = async () => Number(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages").get()) as { n: number }).n);

beforeAll(async () => {
  const applied = await submitApplication({
    businessName: "Trial Courts",
    area: "Shah Alam",
    address: "1 Jalan Ujian, Shah Alam",
    venuePhone: "0355500001",
    contactName: "Tan",
    email: "tan@trial.my",
    password: "a long enough password",
    lat: 3.07,
    lng: 101.52,
  });
  if (!applied.ok) throw new Error(applied.error);
  draft = applied.application.venueId!;
  manager = (await authenticateAdmin("tan@trial.my", "a long enough password"))!;
  const c = await createCourt({ venueId: draft, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!c.ok) throw new Error("court");
  draftCourt = c.court.id;
  const v = await createVenue({ name: "Already Live Hall", area: "Klang", address: "Jalan Hidup", phone: "0330000001" });
  if (!v.ok) throw new Error("venue");
  live = v.venue.id;
  const lc = await createCourt({ venueId: live, name: "Court A", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!lc.ok) throw new Error("court");
  liveCourt = lc.court.id;
  asManager = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(manager.id)).token}`;
  const desk = await createAdmin({ name: "Dina Desk", email: "dina@trial.my", password: "desk-password-1", venueId: draft, role: "desk" });
  if (!desk.ok) throw new Error("desk");
  asDesk = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
  const u = await registerUser({ name: "Wan Wallet", email: "wan@trial.my", phone: "0127770002", password: "a long enough password" });
  if (!u.ok) throw new Error("user");
  userId = u.user.id;
});

describe("a booking made while the venue is a draft", () => {
  it("is a test, marked by the database whatever path made it; one at a live venue is not", async () => {
    const t = await book(draftCourt, 2);
    expect(await isTest(t.code)).toBe(true);
    expect((await findBookingByCode(t.code))!.test).toBe(true);
    const real = await book(liveCourt, 2);
    expect(await isTest(real.code)).toBe(false);
    expect((await findBookingByCode(real.code))!.test).toBeUndefined();
  });

  it("is out of the performance figures and the e-invoice, but its money is in the journal, the cash-up's own block, the period report and the export, marked", async () => {
    const paid = await book(draftCourt, 3);
    expect((await setPaymentStatus(paid.code, true, "cash")).ok).toBe(true);

    const report = (await venueReport(draft, today, addDays(today, 30)))!;
    expect(report.bookings.confirmed).toBe(0);
    expect(report.revenue.expected).toBe(0);
    expect(report.revenue.collected).toBe(0);
    expect(report.bookings.hours).toBe(0);
    // What was paid on it is said apart, never added into the figures above.
    expect(report.testTakings).toEqual({ bookings: 1, collected: 20 });
    // The accountant's export lists it, marked, with what was paid and how.
    const csv = await bookingsCsv(draft, today, addDays(today, 30));
    const line = csv.split("\r\n").find((l) => l.includes(paid.code))!;
    expect(line).toContain('"paid","Cash"');
    expect(line.endsWith('"Yes, before going live"')).toBe(true);
    expect((await customerReport(draft, today, addDays(today, 30))).customers).toBe(0);

    const journal = await salesJournal(draft, today, today);
    expect(journal.find((r) => r.number === paid.code)).toMatchObject({ type: "Receipt", gross: 20, test: true });
    expect(await journalCsv(draft, today, today)).toContain("Yes, before going live");
    const day = await cashUp(draft, today, null);
    expect(day.entries.map((e) => e.number)).not.toContain(paid.code);
    expect(day.totals.taken).toBe(0);
    // Shown in a block of its own, with its own lines and totals; nothing of it in the real ones.
    expect(day.test.entries.map((e) => e.number)).toContain(paid.code);
    expect(day.test.byMethod).toEqual([expect.objectContaining({ method: "cash", taken: 20, givenBack: 0, net: 20, count: 1 })]);
    expect(day.test.totals).toEqual({ taken: 20, givenBack: 0, net: 20 });
    expect(day.byMethod).toEqual([]);
  });

  it("is nobody's strike", async () => {
    const t = await book(draftCourt, 4, { phone: "0127779999" });
    await getDb().prepare("UPDATE bookings SET no_show = 1 WHERE code = ?").run(t.code);
    expect(await strikesFor(draft, "0127779999", 365)).toBe(0);
    await getDb().prepare("UPDATE bookings SET no_show = 0 WHERE code = ?").run(t.code);
  });
});

describe("keeping one as a real booking", () => {
  it("is a manager's; it is then in the figures and the month's e-invoice", async () => {
    const real = await book(draftCourt, 5, { name: "Rina Regular", phone: "0127770003" });
    expect((await setPaymentStatus(real.code, true, "cash")).ok).toBe(true);
    const desk = await call(testsPost, "/api/admin/test-bookings", asDesk, { venueId: draft, action: "keep", codes: [real.code] });
    expect(desk.status).toBe(403);
    expect((await desk.json()).code).toBe("MANAGER_ONLY");
    const res = await call(testsPost, "/api/admin/test-bookings", asManager, { venueId: draft, action: "keep", codes: [real.code, "NOPE1"] });
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.done).toEqual([real.code]);
    expect(out.refused.map((r: { code: string }) => r.code)).toEqual(["NOPE1"]);
    expect(await isTest(real.code)).toBe(false);

    const report = (await venueReport(draft, today, addDays(today, 30)))!;
    expect(report.bookings.confirmed).toBe(1);
    expect(report.revenue.collected).toBe(20);
    expect((await cashUp(draft, today, null)).totals.taken).toBe(20);
    // The month's consolidated e-invoice carries the real one only.
    const made = await consolidate(draft, month);
    expect(made.find((e) => e.kind === "consolidated")?.total).toBe(20);
    expect((await listActivity([draft], { bookingCode: real.code })).map((a) => a.action)).toContain("booking.test_kept");
  });

  it("is refused once its receipt's month has gone to LHDN without it", async () => {
    const late = await book(draftCourt, 6);
    expect((await setPaymentStatus(late.code, true, "cash")).ok).toBe(true);
    const out = await keepTestBookings(manager, draft, [late.code]);
    expect(out.done).toEqual([]);
    expect(out.refused[0].error).toMatch(/LHDN/);
    expect(await isTest(late.code)).toBe(true);
  });
});

describe("clearing test bookings", () => {
  it("cancels each, gives everything back the way it was paid, reverses receipts by credit notes, and messages nobody", async () => {
    // Credit, a pass, and one already played.
    expect((await topUpWallet({ userId, amount: 50, adminId: manager.id, venueId: draft, via: "cash" })).ok).toBe(true);
    const before = await getWalletBalance(userId, draft);
    const byCredit = await book(draftCourt, 7, { userId, name: "Wan Wallet", phone: "0127770002" });
    expect((await payBookingFromWallet(byCredit.id)).ok).toBe(true);
    const sold = await issuePass({
      venueId: draft,
      sport: "badminton",
      name: "5 hours",
      entries: 5,
      price: 80,
      holderName: "Pia Pass",
      holderPhone: "0127770004",
      expiresOn: addDays(today, 60),
      adminId: manager.id,
    });
    if (!sold.ok) throw new Error(sold.error);
    const byPass = await book(draftCourt, 8, { name: "Pia Pass", phone: "0127770004" });
    expect((await payBookingWithPass(byPass.id, sold.pass.code)).ok).toBe(true);
    const played = await book(draftCourt, 9);
    await getDb().prepare("UPDATE bookings SET date = ? WHERE id = ?").run(addDays(today, -3), played.id);

    const standing = await standingTestBookings(draft);
    expect(standing.live).toBe(false);
    expect(standing.bookings.map((b) => b.code)).toEqual(expect.arrayContaining([byCredit.code, byPass.code, played.code]));
    const desk = await call(testsGet, `/api/admin/test-bookings?venueId=${draft}`, asDesk);
    expect(desk.status).toBe(200);

    const sent = await messages();
    const refusedToDesk = await call(testsPost, "/api/admin/test-bookings", asDesk, { venueId: draft, action: "clear" });
    expect(refusedToDesk.status).toBe(403);
    // A counter payment stands among them (the cash ones above): the manager is asked whether real money was taken.
    const unanswered = await call(testsPost, "/api/admin/test-bookings", asManager, { venueId: draft, action: "clear" });
    expect(unanswered.status).toBe(400);
    expect((await unanswered.json()).error).toMatch(/moneyTaken is none or real/);
    expect((await call(testsPost, "/api/admin/test-bookings", asManager, { venueId: draft, action: "clear", moneyTaken: "maybe" })).status).toBe(400);
    expect((await standingTestBookings(draft)).bookings.length).toBeGreaterThan(3);
    const res = await call(testsPost, "/api/admin/test-bookings", asManager, { venueId: draft, action: "clear", moneyTaken: "none" });
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.refused).toEqual([]);
    expect(out.done).toEqual(expect.arrayContaining([byCredit.code, byPass.code, played.code]));
    expect((await standingTestBookings(draft)).bookings).toEqual([]);
    expect(await messages()).toBe(sent);

    expect(await getWalletBalance(userId, draft)).toBe(before);
    const left = (await getDb()
      .prepare("SELECT p.entries + COALESCE((SELECT SUM(e.delta) FROM pass_entries e WHERE e.pass_id = p.id), 0) AS n FROM passes p WHERE p.id = ?")
      .get(sold.pass.id)) as { n: number };
    expect(Number(left.n)).toBe(5);
    expect((await findBookingByCode(played.code))!.status).toBe("cancelled");

    // The cash receipt of the test from before is reversed by a credit note: both kept, both marked, neither in the till.
    const paid = (await getDb().prepare("SELECT id, code FROM bookings WHERE court_id = ? AND test AND payment_status = 'paid' AND paid_via = 'cash' ORDER BY id LIMIT 1").get(draftCourt)) as { id: number; code: string };
    const note = (await getDb().prepare("SELECT number FROM receipts WHERE source = ? AND kind = 'credit_note'").get(`booking:${paid.id}`)) as { number: string };
    expect(note).toBeTruthy();
    const journal = await salesJournal(draft, today, today);
    expect(journal.find((r) => r.number === note.number)).toMatchObject({ type: "Credit note", test: true });
    expect(journal.find((r) => r.number === paid.code)).toMatchObject({ type: "Receipt", test: true });
    // Not in the real till; in the test block, beside the receipt it reverses.
    const day = await cashUp(draft, today, null);
    expect(day.entries.map((e) => e.number)).not.toContain(note.number);
    expect(day.test.entries.map((e) => e.number)).toEqual(expect.arrayContaining([note.number, paid.code]));
    // No money was handed back at the counter for a test.
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM counter_payouts WHERE venue_id = ?").get(draft)) as { n: number }).n).toBe(0);
    expect((await listActivity([draft], { bookingCode: played.code })).map((a) => a.action)).toContain("booking.test_cleared");
    // Declared synthetic, by whom: in the log of the one that had a counter payment.
    const declared = (await listActivity([draft], { bookingCode: paid.code })).find((a) => a.action === "booking.test_cleared")!;
    expect(declared.detail).toContain("declared it synthetic");
    expect(declared.detail).toContain(manager.name);
  });

  it("refuses a booking that is not a test, and is offered when the venue is sent to go live", async () => {
    const real = await book(liveCourt, 3);
    expect((await clearTestBookings(manager, live, [real.code])).done).toEqual([]);
    const t = await book(draftCourt, 10);
    const res = await call(goLivePost, "/api/admin/go-live", asManager, { venueId: draft, clearTests: true, moneyTaken: "none" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cleared.done).toEqual([t.code]);
    expect((await findBookingByCode(t.code))!.status).toBe("cancelled");
  });
});
