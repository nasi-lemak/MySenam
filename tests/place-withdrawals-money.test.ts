import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { accountById, chargeToAccount, invoiceById, invoiceLines, issueInvoice, markInvoicePaid, saveAccount, withdrawInvoice } from "../src/lib/accounts";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { setCancelPolicy } from "../src/lib/cancel-policy";
import { getDb } from "../src/lib/db";
import { bookingSale } from "../src/lib/documents";
import { setHouseRules } from "../src/lib/house-rules";
import { setHoldPolicy } from "../src/lib/holds";
import { addManaged } from "../src/lib/managed-people";
import { savePaymentSettings, settleBill, startBookingPayment, startSplitPayment } from "../src/lib/payments";
import { withdrawMoney, withdrawOptions, withdrawPlace } from "../src/lib/place-withdrawals";
import { createResources } from "../src/lib/resources";
import { splitBooking, splitFor } from "../src/lib/splits";
import { adminCancelBooking, cancelBooking, createVenue, getBookingById, getPass, issuePass, payBookingWithPasses, setPaymentStatus, updateVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import * as bookingsRoute from "../src/app/api/bookings/route";
import * as withdrawRoute from "../src/app/api/bookings/withdraw/route";
import * as staffWithdrawRoute from "../src/app/api/admin/bookings/withdraw/route";
import AccountInvoicePage from "../src/app/account-invoice/[token]/page";

/**
 * Taking one person off a booking where the money is not simply the booker's
 * (lib/place-withdrawals.ts; docs/features/booking.md#taking-one-person-off-a-booking;
 * the owner's decision of 27 October 2026): a deposit paid online, a company
 * or school account before and after its invoice, a split with friends; and
 * what stays refused, and why. Each on PGlite, and at the same moment on
 * Postgres. Online payments against a stand-in gateway (fetch stubbed).
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (k: number) => addDays(todayISO(ZONE), k);
const at = (h: number) => h * 60;
let n = 0;
const phone = () => `0177${String(++n).padStart(6, "0")}`;

type Adult = Awaited<ReturnType<typeof adult>>;
async function adult(name = "Parent") {
  const ph = phone();
  const made = await registerUser({ name: `${name} ${++n}`, email: `pwm${n}@pwm.test`, phone: ph, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now'), verified_phone = phone WHERE id = ?").run(made.user.id);
  return { ...made.user, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}
async function kids(parent: Adult, ...names: string[]) {
  const out: { id: number; name: string }[] = [];
  for (const displayName of names) {
    const made = await addManaged(parent.id, { displayName, relationship: "parent", authority: true }, parent.name);
    if (!made.ok) throw new Error(`${made.code}: ${made.error}`);
    out.push({ id: made.person.id, name: made.person.displayName });
  }
  return out;
}
const req = (url: string, method: string, cookie: string | null, body?: unknown) =>
  new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.67.${++n % 250}.${n % 200}`, ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const book = async (who: Adult, body: Record<string, unknown>) => {
  const res = await bookingsRoute.POST(req("http://localhost/api/bookings", "POST", who.cookie, { name: who.name, phone: who.phone, ...body }));
  const out = (await res.json()) as { booking: { id: number; code: string; totalPrice: number } };
  if (res.status !== 201) throw new Error(JSON.stringify(out));
  return out.booking;
};
const customer = (who: Adult) => ({ kind: "customer" as const, userId: who.id, name: who.name });
let staff: { kind: "staff"; adminId: number; name: string };
let managerCookie: string;

function fakeGateway() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const id = `pwmbill${++n}`;
      return Response.json({ id, url: `https://www.billplz-sandbox.com/bills/${id}` });
    })
  );
}
/** Pay a deposit on it online, the stand-in gateway saying it arrived; the deposit's payment. */
async function payDeposit(code: string, ph: string): Promise<number> {
  fakeGateway();
  const started = await startBookingPayment({ codes: [code], phone: ph, deposit: true });
  if (!started.ok) throw new Error(JSON.stringify(started));
  const bill = (await getDb().prepare("SELECT id, bill_id FROM online_payments ORDER BY id DESC LIMIT 1").get()) as { id: number; bill_id: string };
  await settleBill({ billId: bill.bill_id, paid: true, paidAt: null });
  return bill.id;
}
const payment = async (id: number) =>
  (await getDb().prepare("SELECT amount::float AS amount, refund_due::float AS due FROM online_payments WHERE id = ?").get(id)) as { amount: number; due: number };
const credited = async (paymentId: number) =>
  Number(
    ((await getDb()
      .prepare("SELECT COALESCE(SUM(c.total), 0)::float AS t FROM receipts c JOIN receipts r ON r.id = c.credits_id WHERE r.source = ? AND c.kind = 'credit_note'")
      .get(`payment:${paymentId}`)) as { t: number }).t
  );
const money = async (id: number) => {
  const b = (await getBookingById(id))!;
  return { total: b.totalPrice, deposit: b.depositPaid ?? 0, shares: b.sharesPaid, players: b.players, status: b.status, paid: b.paymentStatus };
};

let depVenue: number;
let depPool: number;
let lateVenue: number;
let latePool: number;
let acctVenue: number;
let acctPool: number;
let splitVenue: number;
let splitPool: number;
let hall: number;

beforeAll(async () => {
  const make = async (name: string, ph: string) => {
    const v = await createVenue({ name, area: "Bangsar", address: "x", phone: ph, openMin: at(7), closeMin: at(23) });
    if (!v.ok) throw new Error("venue");
    expect((await setHouseRules(v.venue.id, { aheadDays: 45 })).ok).toBe(true);
    return v.venue.id;
  };
  const pool = async (venueId: number, name: string) => {
    const r = await createResources({ venueId, sport: "swimming", name, offPeakRate: 10, peakRate: 10, capacity: 6, maxPlayers: 6 });
    if (!r.ok) throw new Error(r.error);
    return r.courts[0].id;
  };
  const online = async (venueId: number) => {
    const saved = await savePaymentSettings(venueId, { apiKey: "api-key-1234", collectionId: "col123", xSignatureKey: "S-key", sandbox: true, enabled: true });
    if (!saved.ok) throw new Error(saved.error);
  };
  depVenue = await make("Deposit Pool", "0312360801");
  depPool = await pool(depVenue, "Deposit pool");
  await online(depVenue);
  expect((await setHoldPolicy(depVenue, { on: true, depositPercent: 50 })).ok).toBe(true);
  lateVenue = await make("Late Deposit Pool", "0312360802");
  latePool = await pool(lateVenue, "Late pool");
  await online(lateVenue);
  expect((await setHoldPolicy(lateVenue, { on: true, depositPercent: 50 })).ok).toBe(true);
  expect((await updateVenue(lateVenue, { cancelCutoffHours: 48 })).ok).toBe(true);
  await setCancelPolicy(lateVenue, { lateKeep: 50 });
  acctVenue = await make("Account Pool", "0312360803");
  acctPool = await pool(acctVenue, "School pool");
  const h = await createResources({ venueId: acctVenue, sport: "badminton", name: "Hall", offPeakRate: 20, peakRate: 20 });
  if (!h.ok) throw new Error(h.error);
  hall = h.courts[0].id;
  splitVenue = await make("Split Pool", "0312360804");
  splitPool = await pool(splitVenue, "Split pool");
  await online(splitVenue);
  const made = await createAdmin({ name: "Mira", email: `pwm-mgr${++n}@pwm.test`, password: "a long enough password", venueId: acctVenue, role: "manager" });
  if (!made.ok) throw new Error(made.error);
  staff = { kind: "staff", adminId: made.admin.id, name: "Mira" };
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}`;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a deposit paid online to hold the booking", () => {
  it("under-paid: the place's price comes off the balance still owed; the deposit stays whole", async () => {
    const mum = await adult("Mum");
    const k = await kids(mum, "Adi", "Ana", "Asha");
    const b = await book(mum, { courtId: depPool, date: day(5), start: at(9), end: at(10), participantIds: k.map((x) => x.id) });
    const dep = await payDeposit(b.code, mum.phone);
    expect(await money(b.id)).toMatchObject({ total: 30, deposit: 15, shares: 15, status: "confirmed", paid: "unpaid" });
    // What it would do, said the same to the customer and the counter (the counter in full).
    const shown = (await withdrawOptions((await getBookingById(b.id))!, customer(mum))).find((o) => o.participantId === k[0].id)!;
    const atCounter = (await withdrawOptions((await getBookingById(b.id))!, staff)).find((o) => o.participantId === k[0].id)!;
    expect(shown).toMatchObject({ allowed: true, price: 10, owedLess: 10, refund: 0, deposit: 0 });
    expect(atCounter).toMatchObject({ allowed: true, price: 10, owedLess: 10, refund: 0, deposit: 0 });
    const res = await withdrawRoute.POST(req("http://localhost/api/bookings/withdraw", "POST", null, { code: b.code, phone: mum.phone, participantId: k[0].id }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { withdrawal: unknown }).withdrawal).toMatchObject({ price: 10, owedLess: 10, refund: 0, kept: 0, deposit: 0, how: "none" });
    expect(await money(b.id)).toMatchObject({ total: 20, deposit: 15, shares: 15, players: 2 });
    expect((await payment(dep)).due).toBe(0);
    // Cancelled in time: the whole deposit back, once.
    expect((await cancelBooking(b.code, mum.phone)).ok).toBe(true);
    expect((await payment(dep)).due).toBe(15);
    expect(await credited(dep)).toBe(15);
  });

  it("over-paid: the balance first, then what was paid beyond the new total back to the deposit's payment, with a credit note; the rest on cancelling", async () => {
    const mum = await adult("Mum");
    const k = await kids(mum, "Bella", "Ben", "Bo");
    const b = await book(mum, { courtId: depPool, date: day(6), start: at(9), end: at(10), participantIds: k.map((x) => x.id) });
    const dep = await payDeposit(b.code, mum.phone);
    expect((await withdrawPlace(b.id, { participantId: k[0].id }, customer(mum))).ok).toBe(true);
    // RM20 left to pay for, RM15 of it paid: the next place's RM10 is RM5 off the balance and RM5 out of the deposit.
    const res = await withdrawRoute.POST(req("http://localhost/api/bookings/withdraw", "POST", null, { code: b.code, phone: mum.phone, participantId: k[1].id }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { withdrawal: Record<string, unknown>; refunds: { amount: number }[] };
    expect(body.withdrawal).toMatchObject({ price: 10, owedLess: 5, refund: 5, deposit: 5, kept: 0, how: "online" });
    // Sent through the venue's refund path at once, as on a cancellation.
    expect(body.refunds.reduce((s, r) => s + r.amount, 0)).toBe(5);
    expect(await money(b.id)).toMatchObject({ total: 10, deposit: 10, shares: 10, players: 1, paid: "unpaid" });
    expect((await payment(dep)).due).toBe(5);
    expect(await credited(dep)).toBe(5);
    const row = (await getDb().prepare("SELECT paid, deposit_part::float AS part, deposit_refunded::float AS back FROM place_withdrawals WHERE booking_id = ? ORDER BY id DESC LIMIT 1").get(b.id)) as Record<string, unknown>;
    expect(row).toEqual({ paid: false, part: 5, back: 5 });
    // The customer is told both: less to pay, and the deposit's part going back.
    expect(withdrawMoney("en", body.withdrawal as Parameters<typeof withdrawMoney>[1])).toBe(
      "RM5 less to pay. RM5 of the deposit goes back to the card or account it was paid with."
    );
    // Nothing left to pay at the counter: the receipt for the rest is for nothing.
    expect((await bookingSale(b.id))!.total).toBe(0);
    // Cancelled: what is left of the deposit, never more than it took.
    expect((await cancelBooking(b.code, mum.phone)).ok).toBe(true);
    expect(await payment(dep)).toEqual({ amount: 15, due: 15 });
    expect(await credited(dep)).toBe(15);
  });

  it("late, where the venue keeps its share: the balance in full, the deposit's part on the late terms", async () => {
    const mum = await adult("Mum");
    const b = await book(mum, { courtId: latePool, date: day(1), start: at(20), end: at(21), players: 3 });
    const dep = await payDeposit(b.code, mum.phone);
    expect(await money(b.id)).toMatchObject({ total: 30, deposit: 15 });
    // Two places nobody is named on, RM20: RM15 off the balance; RM5 out of the deposit, half kept.
    const done = await withdrawPlace(b.id, { unnamed: 2 }, customer(mum));
    expect(done).toMatchObject({ ok: true, withdrawal: { price: 20, owedLess: 15, refund: 2.5, deposit: 2.5, kept: 2.5, late: true, keptPercent: 50 } });
    expect(await money(b.id)).toMatchObject({ total: 10, deposit: 10, shares: 10, players: 1 });
    expect((await payment(dep)).due).toBe(2.5);
    // Then cancelled late too: half of the deposit left.
    expect((await cancelBooking(b.code, mum.phone)).ok).toBe(true);
    expect((await payment(dep)).due).toBe(7.5);
  });

  it("paid in full at the counter after the deposit: the counter's part goes back by hand first, then the deposit's", async () => {
    const mum = await adult("Mum");
    const k = await kids(mum, "Cai", "Cam", "Cy");
    const b = await book(mum, { courtId: depPool, date: day(7), start: at(9), end: at(10), participantIds: k.map((x) => x.id) });
    const dep = await payDeposit(b.code, mum.phone);
    expect(await setPaymentStatus(b.code, true, "cash")).toMatchObject({ ok: true });
    expect((await bookingSale(b.id))!.total).toBe(15);
    // RM15 paid at the counter: the first place's RM10 by hand.
    expect(await withdrawPlace(b.id, { participantId: k[0].id }, customer(mum))).toMatchObject({ ok: true, withdrawal: { refund: 10, deposit: 0, how: "hand" } });
    // RM5 of the counter's part left: by hand; the other RM5 back to the deposit's payment.
    const second = await withdrawPlace(b.id, { participantId: k[1].id }, customer(mum));
    expect(second).toMatchObject({ ok: true, withdrawal: { refund: 10, deposit: 5, how: "hand", kept: 0 } });
    if (!second.ok) throw new Error("withdraw");
    expect(withdrawMoney("en", second.withdrawal)).toBe(
      "The venue gives back RM5: ask at the counter. RM5 of the deposit goes back to the card or account it was paid with."
    );
    // The booking's sale stays as sold; each place has its credit note; the deposit's receipt is credited RM5.
    expect(await money(b.id)).toMatchObject({ total: 30, deposit: 15, paid: "paid" });
    const notes = (await getDb().prepare("SELECT total::float AS t FROM receipts WHERE kind = 'credit_note' AND source LIKE ? ORDER BY id").all(`booking:${b.id}:place:%`)) as { t: number }[];
    expect(notes.map((x) => x.t)).toEqual([10, 5]);
    expect((await payment(dep)).due).toBe(5);
    // Cancelled: nothing more of the counter's part (all settled), the deposit that is left back.
    expect((await adminCancelBooking(b.code)).ok).toBe(true);
    expect(await payment(dep)).toEqual({ amount: 15, due: 15 });
    expect(await credited(dep)).toBe(15);
    expect(await getDb().prepare("SELECT 1 FROM receipts WHERE kind = 'credit_note' AND source = ?").get(`booking:${b.id}`)).toBeUndefined();
  });
});

describe("a company or school account", () => {
  async function account(name: string) {
    const made = await saveAccount(acctVenue, { name, email: `${name.toLowerCase().replace(/\W/g, "")}${++n}@school.test` });
    if (!made.ok) throw new Error(made.error);
    return made.account.id;
  }

  it("before the month's invoice: the place's price comes off the booking's charge, and off what the account owes", async () => {
    const teacher = await adult("Teacher");
    const k = await kids(teacher, "Dan", "Dee", "Dio");
    const acct = await account("SK Withdraw");
    const b = await book(teacher, { courtId: acctPool, date: day(4), start: at(9), end: at(10), participantIds: k.map((x) => x.id) });
    expect((await chargeToAccount(acctVenue, acct, [b.id])).ok).toBe(true);
    expect((await accountById(acct))!.uninvoiced).toBe(30);
    const res = await withdrawRoute.POST(req("http://localhost/api/bookings/withdraw", "POST", null, { code: b.code, phone: teacher.phone, participantId: k[0].id }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { withdrawal: unknown }).withdrawal).toMatchObject({ price: 10, owedLess: 10, refund: 0, how: "none" });
    expect(await money(b.id)).toMatchObject({ total: 20, players: 2 });
    expect((await accountById(acct))!).toMatchObject({ uninvoiced: 20, credit: 0 });
    // The counter, the same way.
    const opts = await staffWithdrawRoute.GET(req(`http://localhost/api/admin/bookings/withdraw?code=${b.code}`, "GET", managerCookie));
    const { options } = (await opts.json()) as { options: { participantId: number; owedLess: number; allowed: boolean }[] };
    expect(options.map((o) => [o.allowed, o.owedLess])).toEqual([
      [true, 10],
      [true, 10],
    ]);
    const atCounter = await staffWithdrawRoute.POST(req("http://localhost/api/admin/bookings/withdraw", "POST", managerCookie, { code: b.code, participantId: k[1].id }));
    expect(atCounter.status).toBe(200);
    expect((await accountById(acct))!.uninvoiced).toBe(10);
  });

  it("after it: the invoice stays as issued; a credit note on the account, off its next invoice; withdrawn, the credit waits again", async () => {
    const teacher = await adult("Teacher");
    const k = await kids(teacher, "Eda", "Eko", "Eli");
    const acct = await account("SMK Credit");
    const date = day(3);
    const a = await book(teacher, { courtId: acctPool, date, start: at(9), end: at(10), participantIds: k.map((x) => x.id) });
    const next = await book(teacher, { courtId: acctPool, date, start: at(12), end: at(13), players: 3 });
    expect((await chargeToAccount(acctVenue, acct, [a.id])).ok).toBe(true);
    // The morning of the session: it is invoiced (this month so far), not yet played.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${date}T07:00:00+08:00`));
    const first = (await issueInvoice(acct, date.slice(0, 7), { email: false }))!;
    expect(first.total).toBe(30);
    // Taken off at the counter (past the customer's cutoff by now): a credit note on the account.
    const done = await withdrawPlace(a.id, { participantId: k[0].id }, staff, "Unwell");
    if (!done.ok) throw new Error(done.error);
    const w = done.withdrawal;
    expect(w).toMatchObject({ price: 10, refund: 10, owedLess: 0, how: "account", deposit: 0 });
    expect(withdrawMoney("en", w)).toBe("RM10 is a credit note on the account this booking is charged to, taken off its next invoice.");
    // The invoice and its lines are as issued; the booking's charge too.
    expect((await invoiceById(first.id))!).toMatchObject({ total: 30, credited: 0, due: 30 });
    expect((await invoiceLines(first.id)).map((l) => l.amount)).toEqual([30]);
    expect(await money(a.id)).toMatchObject({ total: 30, players: 2 });
    // The credit note, against that invoice, to the account.
    const note = (await getDb()
      .prepare("SELECT r.total::float AS total, r.credits_ref, r.customer_name, c.applied_invoice_id FROM account_credits c JOIN receipts r ON r.id = c.receipt_id WHERE c.account_id = ?")
      .get(acct)) as Record<string, unknown>;
    expect(note).toEqual({ total: 10, credits_ref: first.number, customer_name: "SMK Credit", applied_invoice_id: null });
    expect((await accountById(acct))!).toMatchObject({ owing: 30, credit: 10 });
    // Paid as issued; the next invoice takes the credit off.
    expect((await markInvoicePaid(acctVenue, first.id, "transfer")).ok).toBe(true);
    expect((await chargeToAccount(acctVenue, acct, [next.id])).ok).toBe(true);
    const second = (await issueInvoice(acct, date.slice(0, 7), { email: false }))!;
    expect(second).toMatchObject({ total: 30, credited: 10, due: 20 });
    expect((await accountById(acct))!).toMatchObject({ owing: 20, credit: 0 });
    // The invoice says so, in the account's language.
    const html = renderToStaticMarkup(await AccountInvoicePage({ params: Promise.resolve({ token: second.token }) }));
    expect(html).toContain("Credit note CN-");
    expect(html).toContain("To pay");
    expect(html).toContain("RM20");
    // Withdrawn before it is paid: the credit waits for the next one again.
    expect(await withdrawInvoice(acctVenue, second.id)).toBe(true);
    expect((await accountById(acct))!.credit).toBe(10);
    // A second person off the first booking, its invoice paid: a credit again, never the booking's price changed.
    expect(await withdrawPlace(a.id, { participantId: k[1].id }, staff)).toMatchObject({ ok: true, withdrawal: { refund: 10, how: "account" } });
    expect((await accountById(acct))!.credit).toBe(20);
    expect(await money(a.id)).toMatchObject({ total: 30, players: 1 });
  });
});

describe("splitting the cost with friends", () => {
  it("nobody has paid a share yet: allowed, and the split worked out again on the new price; a friend paying now, or paid, refuses it", async () => {
    const mum = await adult("Mum");
    const k = await kids(mum, "Fay", "Fin", "Flo");
    const b = await book(mum, { courtId: splitPool, date: day(8), start: at(9), end: at(10), participantIds: k.map((x) => x.id) });
    const split = await splitBooking(b.code, mum.phone, 3);
    if (!split.ok) throw new Error(split.error);
    expect(split.split.share).toBe(10);
    expect(await withdrawPlace(b.id, { participantId: k[0].id }, customer(mum))).toMatchObject({ ok: true, withdrawal: { owedLess: 10 } });
    expect((await splitFor(b.id))!.share).toBe(6.66);
    // A friend's page open: what it asks was worked out from the price, so nobody comes off now.
    fakeGateway();
    expect((await startSplitPayment(split.split.token, { name: "Friend", phone: "0123334444" })).ok).toBe(true);
    expect(await withdrawPlace(b.id, { participantId: k[1].id }, customer(mum))).toMatchObject({ ok: false, code: "ENT_WITHDRAW_PAGE_OPEN" });
    // Paid: each share was a part of the whole price. Refused for the customer and the counter alike.
    const bill = (await getDb().prepare("SELECT bill_id FROM online_payments WHERE purpose = 'split' ORDER BY id DESC LIMIT 1").get()) as { bill_id: string };
    await settleBill({ billId: bill.bill_id, paid: true, paidAt: null });
    expect(await withdrawPlace(b.id, { participantId: k[1].id }, customer(mum))).toMatchObject({ ok: false, code: "ENT_WITHDRAW_SHARED" });
    expect(await withdrawPlace(b.id, { participantId: k[1].id }, staff)).toMatchObject({ ok: false, code: "ENT_WITHDRAW_SHARED" });
    expect(await money(b.id)).toMatchObject({ total: 20, shares: 6.66, players: 2 });
  });
});

describe("benefits by their scope", () => {
  it("a pass for the court hired whole gives back nothing for one player, and the court stays paid", async () => {
    const dad = await adult("Dad");
    const k = await kids(dad, "Gus", "Gia");
    const pass = await issuePass({ venueId: acctVenue, name: "Court hours", entries: 5, entryMinutes: 60, price: 90, holderName: dad.name, holderPhone: dad.phone, userId: dad.id, expiresOn: day(60), adminId: staff.adminId, scope: "resource" });
    if (!pass.ok) throw new Error(pass.error);
    const b = await book(dad, { courtId: hall, date: day(9), start: at(9), end: at(10), participantIds: k.map((x) => x.id) });
    expect((await payBookingWithPasses(b.id, [pass.pass.code])).ok).toBe(true);
    expect((await getPass(pass.pass.code))!.remaining).toBe(4);
    expect(await withdrawPlace(b.id, { participantId: k[1].id }, customer(dad))).toMatchObject({ ok: true, withdrawal: { price: 0, refund: 0, units: 0 } });
    expect((await getPass(pass.pass.code))!.remaining).toBe(4);
    expect(await money(b.id)).toMatchObject({ total: 20, paid: "paid" });
  });
});

const AT_ONCE = 4;

describe("at the same moment (real concurrency on Postgres)", () => {
  it("two people off a deposit booking at once: the balance first, the deposit's part back once", async () => {
    const mum = await adult("Mum");
    const k = await kids(mum, "Hani", "Hadi", "Huda");
    const b = await book(mum, { courtId: depPool, date: day(10), start: at(9), end: at(10), participantIds: k.map((x) => x.id) });
    const dep = await payDeposit(b.code, mum.phone);
    const both = await Promise.all([withdrawPlace(b.id, { participantId: k[0].id }, customer(mum)), withdrawPlace(b.id, { participantId: k[1].id }, customer(mum))]);
    expect(both.every((r) => r.ok)).toBe(true);
    expect(await money(b.id)).toMatchObject({ total: 10, deposit: 10, shares: 10, players: 1 });
    expect((await payment(dep)).due).toBe(5);
    // The same person twice at once: once.
    const again = await Promise.all(Array.from({ length: AT_ONCE }, () => withdrawPlace(b.id, { participantId: k[2].id }, customer(mum))));
    expect(again.filter((r) => r.ok)).toHaveLength(0);
    expect((await payment(dep)).due).toBe(5);
  });

  it("a withdrawal racing the booking's cancellation: the deposit goes back once, in full", async () => {
    const mum = await adult("Mum");
    const k = await kids(mum, "Ira", "Ivy", "Iza");
    const b = await book(mum, { courtId: depPool, date: day(11), start: at(9), end: at(10), participantIds: k.map((x) => x.id) });
    const dep = await payDeposit(b.code, mum.phone);
    expect((await withdrawPlace(b.id, { participantId: k[0].id }, customer(mum))).ok).toBe(true);
    const [w, c] = await Promise.all([withdrawPlace(b.id, { participantId: k[1].id }, customer(mum)), adminCancelBooking(b.code)]);
    expect(c.ok).toBe(true);
    if (w.ok) expect(w.withdrawal.deposit).toBe(5);
    else expect(w.code).toBe("ALREADY_CANCELLED");
    expect(await payment(dep)).toEqual({ amount: 15, due: 15 });
    expect(await credited(dep)).toBe(15);
  });

  it("a withdrawal racing the month's invoice: either it comes off the charge before, or it is a credit note after; never both, never neither", async () => {
    const teacher = await adult("Teacher");
    const k = await kids(teacher, "Jo", "Jay", "Jen");
    const made = await saveAccount(acctVenue, { name: "SK Race", email: `race${++n}@school.test` });
    if (!made.ok) throw new Error(made.error);
    const date = day(12);
    const b = await book(teacher, { courtId: acctPool, date, start: at(9), end: at(10), participantIds: k.map((x) => x.id) });
    expect((await chargeToAccount(acctVenue, made.account.id, [b.id])).ok).toBe(true);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${date}T07:00:00+08:00`));
    const [w, invoice] = await Promise.all([withdrawPlace(b.id, { participantId: k[0].id }, staff), issueInvoice(made.account.id, date.slice(0, 7), { email: false })]);
    expect(w.ok).toBe(true);
    if (!w.ok || !invoice) throw new Error("race");
    const credit = Number(((await getDb().prepare("SELECT COALESCE(SUM(amount), 0)::float AS c FROM account_credits WHERE booking_id = ?").get(b.id)) as { c: number }).c);
    // What the account is charged for, in all: two places.
    expect(roundTo(invoice.total - credit)).toBe(20);
    expect(w.withdrawal.how === "account" ? [30, 10] : [20, 0]).toEqual([invoice.total, credit]);
    // The invoice withdrawn while a second person comes off: the booking back to be invoiced, the money once either way.
    const before = (await accountById(made.account.id))!;
    const [w2, gone] = await Promise.all([withdrawPlace(b.id, { participantId: k[1].id }, staff), withdrawInvoice(acctVenue, invoice.id)]);
    expect(w2.ok && gone).toBe(true);
    const after = (await accountById(made.account.id))!;
    // To invoice, less the credit waiting: the one place left.
    expect(roundTo(after.uninvoiced - after.credit)).toBe(10);
    expect(after.owing).toBe(0);
    expect(before.uninvoiced).toBe(0);
  });
});

const roundTo = (x: number) => Math.round(x * 100) / 100;
