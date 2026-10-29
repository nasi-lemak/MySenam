import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_MARKETPLACE = "on";
process.env.MYSENAM_GEOCODER = "off";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { journalCsv, salesJournal } from "../src/lib/accounting";
import { ADMIN_SESSION_COOKIE, authenticateAdmin, createAdmin, createAdminSession, type Admin } from "../src/lib/admin-auth";
import { listActivity } from "../src/lib/activity";
import { approveApplication, goLiveStatus, submitApplication } from "../src/lib/applications";
import { registerUser } from "../src/lib/auth";
import { cashUp } from "../src/lib/cash-up";
import { COUNTER_REFUSALS, counterOwed, counterPayoutsOn, settleOwed } from "../src/lib/counter-refunds";
import { getDb } from "../src/lib/db";
import { bookingsCsv } from "../src/lib/export";
import { checkIntegrity } from "../src/lib/integrity";
import { listOnlinePayments, refundsOwed, savePaymentSettings, settleBill, startBookingPayment } from "../src/lib/payments";
import { REVIEW_CHECKS } from "../src/lib/review-checks";
import { venueReport } from "../src/lib/reports";
import { staffRefusal } from "../src/lib/staff-i18n";
import {
  createBooking,
  createCourt,
  findBookingByCode,
  getWalletBalance,
  issuePass,
  payBookingFromWallet,
  payBookingWithPass,
  setPaymentStatus,
  topUpWallet,
} from "../src/lib/store";
import { clearTestBookings, keepTestBookings, paidStandingTests, standingTestBookings } from "../src/lib/test-bookings";
import { addDays, todayISO } from "../src/lib/time";
import { GET as dayGet } from "../src/app/api/admin/bookings/route";
import { POST as testsPost } from "../src/app/api/admin/test-bookings/route";
import { POST as goLivePost } from "../src/app/api/admin/go-live/route";
import { POST as owedPost } from "../src/app/api/admin/bookings/owed/route";

/**
 * R10A: test bookings can never conceal real money.
 *
 * Marking a booking a test leaves its payments, refunds owed, counter payouts and receipts exactly where staff
 * and the owner look for money; clearing one with a counter payment asks whether real money was taken; real money
 * after going live is never a test (migration 0259); and a venue cannot go live with a paid test standing.
 * Online money is a stand-in gateway's (fetch is stubbed), never a live check.
 */

const today = todayISO("Asia/Kuala_Lumpur");
const PHONE = "0127770001";
let tag = 0;
let slot = 0;

interface Draft {
  venueId: number;
  courtId: number;
  applicationId: number;
  manager: Admin;
  asManager: string;
  asDesk: string;
  desk: Admin;
}

/** A venue still a draft, with a court, a manager and a front desk account. */
async function newDraft(): Promise<Draft> {
  const k = ++tag;
  const applied = await submitApplication({
    businessName: `Money Courts ${k}`,
    area: "Shah Alam",
    address: `${k} Jalan Wang, Shah Alam`,
    venuePhone: `03555${String(k).padStart(5, "0")}`,
    contactName: "Tan",
    email: `tan${k}@money.my`,
    password: "a long enough password",
    lat: 3.07 + k * 0.02,
    lng: 101.52,
  });
  if (!applied.ok) throw new Error(applied.error);
  const venueId = applied.application.venueId!;
  const manager = (await authenticateAdmin(`tan${k}@money.my`, "a long enough password"))!;
  const c = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!c.ok) throw new Error("court");
  const made = await createAdmin({ name: `Dina Desk ${k}`, email: `dina${k}@money.my`, password: "desk-password-1", venueId, role: "desk" });
  if (!made.ok) throw new Error("desk");
  return {
    venueId,
    courtId: c.court.id,
    applicationId: applied.application.id,
    manager,
    asManager: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(manager.id)).token}`,
    asDesk: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}`,
    desk: made.admin,
  };
}

async function book(courtId: number, extra: Record<string, unknown> = {}) {
  const n = slot++;
  const b = await createBooking({ courtId, date: addDays(today, 1 + (Math.floor(n / 12) % 6)), hours: [8 + (n % 12)], name: "Tess Tester", phone: PHONE, ...extra });
  if (!b.ok) throw new Error(b.error);
  return b.booking;
}

async function paidCash(courtId: number, extra: Record<string, unknown> = {}) {
  const b = await book(courtId, extra);
  expect((await setPaymentStatus(b.code, true, "cash")).ok).toBe(true);
  return b;
}

const call = (handler: (req: NextRequest) => Promise<Response>, url: string, cookie: string, body?: unknown) =>
  handler(
    new NextRequest(`http://localhost${url}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  );
const one = async (sql: string, ...args: unknown[]) => (await getDb().prepare(sql).get(...args)) as Record<string, unknown> | undefined;
const count = async (sql: string, ...args: unknown[]) => Number(((await one(sql, ...args)) as { n: number }).n);
const isTest = async (code: string) => ((await one("SELECT test FROM bookings WHERE code = ?", code)) as { test: boolean }).test;
const goLive = async (venueId: number) => getDb().prepare("UPDATE venues SET published_at = datetime('now') WHERE id = ?").run(venueId);

afterEach(() => vi.unstubAllGlobals());

let userId: number;
beforeAll(async () => {
  const u = await registerUser({ name: "Wan Wallet", email: "wan@money.my", phone: "0127770002", password: "a long enough password" });
  if (!u.ok) throw new Error("user");
  userId = u.user.id;
});

describe("a test booking's money is where staff and the owner look for it", () => {
  it("its counter payment, receipt, online payment and refund owed are all still shown", async () => {
    const d = await newDraft();
    const counter = await paidCash(d.courtId);
    const online = await book(d.courtId, { email: "t@money.my" });
    // An online payment on a test booking is only possible by the stand-in path below (a draft takes none), so it is written as a paid row.
    const paid = (await one(
      `INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, status, payer_name, payer_phone, purpose, paid_at)
       VALUES ('billplz', ?, 'https://x', ?, 20, 'paid', 'Tess Tester', ?, 'booking', datetime('now', '-10 days')) RETURNING id`,
      `bill-test-${tag}`,
      d.venueId,
      PHONE
    )) as { id: number };
    await getDb().prepare("INSERT INTO online_payment_bookings (payment_id, booking_id) VALUES (?, ?)").run(paid.id, online.id);
    await getDb().prepare("UPDATE bookings SET payment_status = 'paid', paid_via = 'online', paid_at = datetime('now') WHERE id = ?").run(online.id);
    expect(await isTest(counter.code)).toBe(true);
    expect(await isTest(online.code)).toBe(true);

    // Before anything is done to them: each is in the journal (marked), the cash-up's test block, the period report and the export.
    const journal = await salesJournal(d.venueId, today, today);
    expect(journal.filter((r) => r.test).map((r) => r.number)).toEqual(expect.arrayContaining([counter.code, online.code]));
    expect(await journalCsv(d.venueId, today, today)).toContain(counter.code);
    const day = await cashUp(d.venueId, today, null);
    expect(day.totals).toEqual({ taken: 0, givenBack: 0, net: 0 });
    expect(day.test.byMethod.map((m) => [m.method, m.taken])).toEqual([["cash", 20], ["online", 20]]);
    expect(day.test.totals.taken).toBe(40);
    expect((await venueReport(d.venueId, today, addDays(today, 60)))!.testTakings).toEqual({ bookings: 2, collected: 40 });
    const csv = await bookingsCsv(d.venueId, today, addDays(today, 60));
    for (const code of [counter.code, online.code]) expect(csv.split("\r\n").find((l) => l.includes(code))).toContain("Yes, before going live");
    expect((await listOnlinePayments(d.venueId)).map((p) => p.billId)).toContain(`bill-test-${tag}`);
    expect(await paidStandingTests(d.venueId)).toEqual(expect.arrayContaining([counter.code, online.code]));

    // The manager says real money was taken: the online part is owed back on the payment, the counter part at the counter.
    const res = await call(testsPost, "/api/admin/test-bookings", d.asManager, { venueId: d.venueId, action: "clear", moneyTaken: "real" });
    expect(res.status).toBe(200);
    expect((await res.json()).refused).toEqual([]);

    const owedOnline = (await refundsOwed(d.venueId)).find((p) => p.billId === `bill-test-${tag}`)!;
    expect(owedOnline.refundOwed).toBe(20);
    expect((await checkIntegrity([d.venueId])).filter((p) => p.kind === "refund_overdue").map((p) => p.detail).join()).toContain(`bill-test-${tag}`);

    // On the day list staff open: the counter money is owed back (cause: the test), nothing handed back, no credit note yet.
    const list = (await (await call(dayGet, `/api/admin/bookings?date=${today}`, d.asManager)).json()) as { owed: { bookingCode: string; amount: number; cause: string; via: string }[]; payouts: unknown[] };
    expect(list.owed).toEqual([expect.objectContaining({ bookingCode: counter.code, amount: 20, cause: "test", via: "cash" })]);
    expect(list.payouts).toEqual([]);
    expect(await count("SELECT COUNT(*)::int AS n FROM counter_payouts WHERE venue_id = ?", d.venueId)).toBe(0);
    expect(await one("SELECT id FROM receipts WHERE source = ? AND kind = 'credit_note'", `booking:${counter.id}`)).toBeUndefined();
    const logged = (await listActivity([d.venueId], { bookingCode: counter.code })).find((a) => a.action === "booking.test_cleared")!;
    expect(logged.detail).toContain("said real money was taken");
    expect(logged.detail).not.toContain("handed back at");
  });

  it("settled from the day list, it writes its credit note and payout as for any owed refund, in the cash-up's test block", async () => {
    const d = await newDraft();
    const b = await paidCash(d.courtId);
    expect((await clearTestBookings(d.manager, d.venueId, [b.code], "real")).done).toEqual([b.code]);
    const owed = (await counterOwed([d.venueId], "manager"))[0];
    expect(owed).toMatchObject({ bookingCode: b.code, amount: 20, cause: "test", via: "cash", settled: null });

    // Taken on an earlier day: the front desk may not hand it back; a manager does.
    await getDb().prepare("UPDATE bookings SET paid_at = ? WHERE id = ?").run(`${addDays(today, -2)}T03:00:00.000Z`, b.id);
    const asked = await call(owedPost, "/api/admin/bookings/owed", d.asDesk, { id: owed.id, outcome: "back" });
    expect(asked.status).toBe(409);
    expect((await asked.json()).error).toBe(COUNTER_REFUSALS.manager);
    expect(await count("SELECT COUNT(*)::int AS n FROM counter_payouts WHERE booking_id = ?", b.id)).toBe(0);

    const done = await call(owedPost, "/api/admin/bookings/owed", d.asManager, { id: owed.id, outcome: "back" });
    expect(done.status).toBe(200);
    const note = (await one("SELECT number, total::float AS total, staff_name FROM receipts WHERE source = ? AND kind = 'credit_note'", `booking:${b.id}`)) as { number: string; total: number; staff_name: string };
    expect(note).toMatchObject({ total: 20, staff_name: d.manager.name });
    expect(await counterPayoutsOn([d.venueId], today)).toEqual([expect.objectContaining({ bookingCode: b.code, amount: 20, via: "cash", adminName: d.manager.name, creditNote: note.number })]);
    // Settling it twice pays out once.
    expect((await call(owedPost, "/api/admin/bookings/owed", d.asManager, { id: owed.id, outcome: "back" })).status).toBe(409);
    expect(await count("SELECT COUNT(*)::int AS n FROM counter_payouts WHERE booking_id = ?", b.id)).toBe(1);
    // The credit note is in today's test block (the booking is still a test), nothing in the real totals.
    const day = await cashUp(d.venueId, today, null);
    expect(day.test.totals).toEqual({ taken: 0, givenBack: 20, net: -20 });
    expect(day.totals).toEqual({ taken: 0, givenBack: 0, net: 0 });
    expect((await salesJournal(d.venueId, today, today)).find((r) => r.number === note.number)).toMatchObject({ type: "Credit note", test: true });
  });

  it("settled as stored credit on the account it was booked from, today's payment by the front desk", async () => {
    const d = await newDraft();
    const b = await paidCash(d.courtId, { userId });
    expect((await clearTestBookings(d.manager, d.venueId, [b.code], "real")).done).toEqual([b.code]);
    const owed = (await counterOwed([d.venueId], "desk"))[0];
    expect(owed).toMatchObject({ bookingCode: b.code, account: true, managerOnly: false });
    const before = await getWalletBalance(userId);
    const done = await settleOwed(owed.id, "credit", { id: d.desk.id, name: d.desk.name, role: "desk" });
    expect(done.ok).toBe(true);
    expect(await getWalletBalance(userId)).toBe(before + 20);
    expect(await count("SELECT COUNT(*)::int AS n FROM counter_payouts WHERE booking_id = ?", b.id)).toBe(0);
  });
});

describe("clearing says whether real money moved", () => {
  it("is refused without the answer where a counter payment stands, and nothing is cancelled", async () => {
    const d = await newDraft();
    const b = await paidCash(d.courtId);
    const unpaid = await book(d.courtId);
    const none = await call(testsPost, "/api/admin/test-bookings", d.asManager, { venueId: d.venueId, action: "clear" });
    expect(none.status).toBe(400);
    expect((await none.json()).error).toMatch(/moneyTaken is none or real/);
    expect((await call(testsPost, "/api/admin/test-bookings", d.asManager, { venueId: d.venueId, action: "clear", moneyTaken: "nope" })).status).toBe(400);
    expect((await findBookingByCode(b.code))!.status).toBe("confirmed");
    // Naming only the unpaid one needs no answer.
    const only = await call(testsPost, "/api/admin/test-bookings", d.asManager, { venueId: d.venueId, action: "clear", codes: [unpaid.code] });
    expect(only.status).toBe(200);
    expect((await only.json()).done).toEqual([unpaid.code]);
    // In the library too: a counter payment is left standing without the answer.
    const lib = await clearTestBookings(d.manager, d.venueId, [b.code]);
    expect(lib.done).toEqual([]);
    expect(lib.refused[0].code).toBe(b.code);
  });

  it("'none': the credit note at once, nothing owed or paid out, logged as declared synthetic by the manager", async () => {
    const d = await newDraft();
    const b = await paidCash(d.courtId);
    const res = await call(testsPost, "/api/admin/test-bookings", d.asManager, { venueId: d.venueId, action: "clear", moneyTaken: "none" });
    expect((await res.json()).done).toEqual([b.code]);
    expect(await one("SELECT id FROM receipts WHERE source = ? AND kind = 'credit_note'", `booking:${b.id}`)).toBeTruthy();
    expect(await count("SELECT COUNT(*)::int AS n FROM counter_refunds_owed WHERE booking_id = ?", b.id)).toBe(0);
    expect(await count("SELECT COUNT(*)::int AS n FROM counter_payouts WHERE booking_id = ?", b.id)).toBe(0);
    const logged = (await listActivity([d.venueId], { bookingCode: b.code })).find((a) => a.action === "booking.test_cleared")!;
    expect(logged.detail).toContain("declared it synthetic");
    expect(logged.detail).toContain(d.manager.name);
  });

  it("is ignored for credit and passes, which go back as they were paid whatever is said", async () => {
    const d = await newDraft();
    expect((await topUpWallet({ userId, amount: 50, adminId: d.manager.id, venueId: d.venueId, via: "cash" })).ok).toBe(true);
    const before = await getWalletBalance(userId, d.venueId);
    const byCredit = await book(d.courtId, { userId, name: "Wan Wallet", phone: "0127770002" });
    expect((await payBookingFromWallet(byCredit.id)).ok).toBe(true);
    const sold = await issuePass({ venueId: d.venueId, sport: "badminton", name: "5 hours", entries: 5, price: 80, holderName: "Pia", holderPhone: "0127770004", expiresOn: addDays(today, 60), adminId: d.manager.id });
    if (!sold.ok) throw new Error(sold.error);
    const byPass = await book(d.courtId, { name: "Pia", phone: "0127770004" });
    expect((await payBookingWithPass(byPass.id, sold.pass.code)).ok).toBe(true);
    // Their top-up and the pass sale were counter money of their own: not bookings, not part of this.
    const res = await call(testsPost, "/api/admin/test-bookings", d.asManager, { venueId: d.venueId, action: "clear", moneyTaken: "real" });
    expect((await res.json()).done).toEqual(expect.arrayContaining([byCredit.code, byPass.code]));
    expect(await getWalletBalance(userId, d.venueId)).toBe(before);
    expect(await count("SELECT COUNT(*)::int AS n FROM counter_refunds_owed WHERE venue_id = ?", d.venueId)).toBe(0);
    expect(await count("SELECT COUNT(*)::int AS n FROM counter_payouts WHERE venue_id = ?", d.venueId)).toBe(0);
  });

  it("keeping one as real says so in the log, naming the manager", async () => {
    const d = await newDraft();
    const b = await paidCash(d.courtId);
    expect((await keepTestBookings(d.manager, d.venueId, [b.code])).done).toEqual([b.code]);
    const logged = (await listActivity([d.venueId], { bookingCode: b.code })).find((a) => a.action === "booking.test_kept")!;
    expect(logged.detail).toContain(`${d.manager.name} said it is real`);
    expect(logged.detail).toContain("in the figures now");
    expect(await paidStandingTests(d.venueId)).toEqual([]);
  });
});

describe("going live with a paid test booking standing", () => {
  it("is refused (409, naming the codes) unless the same request clears them with the answer", async () => {
    const d = await newDraft();
    const paid = await paidCash(d.courtId);
    const unpaid = await book(d.courtId);
    const refused = await call(goLivePost, "/api/admin/go-live", d.asManager, { venueId: d.venueId });
    expect(refused.status).toBe(409);
    const error = (await refused.json()).error as string;
    expect(error).toContain(paid.code);
    expect(error).not.toContain(unpaid.code);
    // In the staff language, the codes put back as they were.
    expect(staffRefusal(error, "ms")).toContain(paid.code);
    expect(staffRefusal(error, "zh")).toContain(paid.code);
    expect((await goLiveStatus(d.venueId))?.request?.status).toBe("draft");

    // Asked to clear, with no answer: refused before anything is done.
    const noAnswer = await call(goLivePost, "/api/admin/go-live", d.asManager, { venueId: d.venueId, clearTests: true });
    expect(noAnswer.status).toBe(400);
    expect((await findBookingByCode(paid.code))!.status).toBe("confirmed");
    expect((await call(goLivePost, "/api/admin/go-live", d.asManager, { venueId: d.venueId, clearTests: true, moneyTaken: "maybe" })).status).toBe(400);

    const sent = await call(goLivePost, "/api/admin/go-live", d.asManager, { venueId: d.venueId, clearTests: true, moneyTaken: "real" });
    expect(sent.status).toBe(200);
    const body = await sent.json();
    expect(body.cleared.done).toEqual(expect.arrayContaining([paid.code, unpaid.code]));
    expect(body.status.request.status).toBe("pending");
    // The counter payment is owed back, as the venue's bulk cancellations owe it.
    expect((await counterOwed([d.venueId], "manager")).map((o) => [o.bookingCode, o.cause])).toEqual([[paid.code, "test"]]);
  });

  it("is allowed with only unpaid tests, which may remain", async () => {
    const d = await newDraft();
    const unpaid = await book(d.courtId);
    const sent = await call(goLivePost, "/api/admin/go-live", d.asManager, { venueId: d.venueId });
    expect(sent.status).toBe(200);
    expect((await findBookingByCode(unpaid.code))!.status).toBe("confirmed");
  });

  it("is allowed once the paid test is kept as real", async () => {
    const d = await newDraft();
    const paid = await paidCash(d.courtId);
    expect((await call(goLivePost, "/api/admin/go-live", d.asManager, { venueId: d.venueId })).status).toBe(409);
    expect((await keepTestBookings(d.manager, d.venueId, [paid.code])).done).toEqual([paid.code]);
    expect((await call(goLivePost, "/api/admin/go-live", d.asManager, { venueId: d.venueId })).status).toBe(200);
  });

  it("is refused to the platform owner with the count, for a test paid after the request, until the venue has dealt with it", async () => {
    const d = await newDraft();
    expect((await call(goLivePost, "/api/admin/go-live", d.asManager, { venueId: d.venueId })).status).toBe(200);
    // Paid after the request was sent, while the venue is still a draft: still a test.
    const late = await paidCash(d.courtId);
    expect(await isTest(late.code)).toBe(true);
    const checks = REVIEW_CHECKS.map((c) => c.id);
    const refused = await approveApplication(d.applicationId, d.manager.id, checks);
    expect(refused.ok).toBe(false);
    const error = !refused.ok ? refused.error : "";
    expect(error).toContain("(1)");
    expect(staffRefusal(error, "ms")).toContain("(1)");
    expect((await one("SELECT published_at FROM venues WHERE id = ?", d.venueId))!.published_at).toBeNull();

    expect((await clearTestBookings(d.manager, d.venueId, [late.code], "none")).done).toEqual([late.code]);
    expect((await approveApplication(d.applicationId, d.manager.id, checks)).ok).toBe(true);
    expect((await one("SELECT published_at FROM venues WHERE id = ?", d.venueId))!.published_at).not.toBeNull();
  });
});

describe("real money after going live is never a test (migration 0259)", () => {
  const SIGNATURE_KEY = "S-test-signature-key";

  it("a payment at the counter, in credit or by a pass makes it a real sale, in the figures at once", async () => {
    const d = await newDraft();
    const cash = await book(d.courtId);
    const credit = await book(d.courtId, { userId, name: "Wan Wallet", phone: "0127770002" });
    const pass = await book(d.courtId, { name: "Pia", phone: "0127770004" });
    const stays = await book(d.courtId);
    for (const b of [cash, credit, pass, stays]) expect(await isTest(b.code)).toBe(true);
    await goLive(d.venueId);
    // Going live changes nothing about what was made before.
    for (const b of [cash, credit, pass, stays]) expect(await isTest(b.code)).toBe(true);
    // Something else changing on a test is not a payment.
    await getDb().prepare("UPDATE bookings SET name = 'Tess T' WHERE id = ?").run(stays.id);
    expect(await isTest(stays.code)).toBe(true);

    expect((await setPaymentStatus(cash.code, true, "cash")).ok).toBe(true);
    expect(await isTest(cash.code)).toBe(false);
    expect((await topUpWallet({ userId, amount: 50, adminId: d.manager.id, venueId: d.venueId, via: "cash" })).ok).toBe(true);
    expect((await payBookingFromWallet(credit.id)).ok).toBe(true);
    expect(await isTest(credit.code)).toBe(false);
    const sold = await issuePass({ venueId: d.venueId, sport: "badminton", name: "5 hours", entries: 5, price: 80, holderName: "Pia", holderPhone: "0127770004", expiresOn: addDays(today, 60), adminId: d.manager.id });
    if (!sold.ok) throw new Error(sold.error);
    expect((await payBookingWithPass(pass.id, sold.pass.code)).ok).toBe(true);
    expect(await isTest(pass.code)).toBe(false);
    expect(await isTest(stays.code)).toBe(true);

    // The cash is in the real cash-up and the report, not in the test block.
    const day = await cashUp(d.venueId, today, null);
    expect(day.entries.map((e) => e.number)).toContain(cash.code);
    expect(day.test.entries.map((e) => e.number)).not.toContain(cash.code);
    expect((await venueReport(d.venueId, today, addDays(today, 60)))!.revenue.collected).toBeGreaterThanOrEqual(20);
    // Unpaid, then paid, then unpaid and paid again: it stays real.
    expect((await setPaymentStatus(cash.code, false)).ok).toBe(true);
    expect((await setPaymentStatus(cash.code, true, "qr")).ok).toBe(true);
    expect(await isTest(cash.code)).toBe(false);
  });

  it("an online payment confirmed makes it a real sale; one at a venue still a draft stays a test", async () => {
    const d = await newDraft();
    const online = await book(d.courtId, { email: "t@money.my", phone: PHONE });
    const onDraft = await paidCash(d.courtId);
    expect(await isTest(onDraft.code)).toBe(true);
    await goLive(d.venueId);
    const saved = await savePaymentSettings(d.venueId, { apiKey: "api-key-1234", collectionId: "col123", xSignatureKey: SIGNATURE_KEY, sandbox: true, enabled: true });
    if (!saved.ok) throw new Error(saved.error);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: `billreal${tag}`, url: `https://www.billplz-sandbox.com/bills/billreal${tag}` })));
    const started = await startBookingPayment({ codes: [online.code], phone: PHONE });
    if (!started.ok) throw new Error(started.error);
    expect(await isTest(online.code)).toBe(true);
    await settleBill({ billId: `billreal${tag}`, paid: true, paidAt: null });
    expect((await one("SELECT payment_status, paid_via FROM bookings WHERE id = ?", online.id))).toMatchObject({ payment_status: "paid", paid_via: "online" });
    expect(await isTest(online.code)).toBe(false);
    // The test paid while the venue was a draft stays a test, and is what the banner still lists.
    expect(await isTest(onDraft.code)).toBe(true);
    expect((await standingTestBookings(d.venueId)).bookings.map((b) => b.code)).toEqual([onDraft.code]);
  });

  it("a booking at a venue that is still a draft stays a test when paid, by any path", async () => {
    const d = await newDraft();
    const b = await book(d.courtId, { userId, name: "Wan Wallet", phone: "0127770002" });
    expect((await topUpWallet({ userId, amount: 50, adminId: d.manager.id, venueId: d.venueId, via: "cash" })).ok).toBe(true);
    expect((await payBookingFromWallet(b.id)).ok).toBe(true);
    expect(await isTest(b.code)).toBe(true);
  });

  it("the migration can be run again: its function and trigger are replaced, its check re-made", async () => {
    const sql = fs.readFileSync(path.join(__dirname, "../db/migrations/0259_real_money_is_never_a_test.sql"), "utf8");
    await getDb().exec(sql);
    const d = await newDraft();
    const b = await book(d.courtId);
    await goLive(d.venueId);
    expect((await setPaymentStatus(b.code, true, "cash")).ok).toBe(true);
    expect(await isTest(b.code)).toBe(false);
    expect(await count("SELECT COUNT(*)::int AS n FROM pg_trigger WHERE tgname = 'bookings_paid_real'")).toBe(1);
  });
});
