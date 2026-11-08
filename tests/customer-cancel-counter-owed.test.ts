import fs from "fs";
import path from "path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { POST as settleRoute } from "../src/app/api/admin/bookings/owed/route";
import { GET as dayRoute } from "../src/app/api/admin/bookings/route";
import { POST as cancelRoute } from "../src/app/api/bookings/cancel/route";
import { POST as cancelSeriesRoute } from "../src/app/api/bookings/cancel-series/route";
import { POST as myCancelRoute } from "../src/app/api/my/bookings/cancel/route";
import { listActivity } from "../src/lib/activity";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { createApiKey } from "../src/lib/api-keys";
import { cashUp } from "../src/lib/cash-up";
import { setCancelPolicy } from "../src/lib/cancel-policy";
import {
  counterOwed,
  counterPayoutsOn,
  counterRefundLines,
  oweCounterToCustomer,
  OWED_REFUSALS,
  owedRefund,
  settleOwed,
  staffCancel,
  type CancellingStaff,
} from "../src/lib/counter-refunds";
import { getDb } from "../src/lib/db";
import { setHouseRules } from "../src/lib/house-rules";
import { setHoldPolicy } from "../src/lib/holds";
import { cancelClassAndTell } from "../src/lib/notify";
import { savePaymentSettings, settleBill, startBookingPayment } from "../src/lib/payments";
import { withdrawPlace } from "../src/lib/place-withdrawals";
import { createResources } from "../src/lib/resources";
import {
  cancelBooking,
  cancelForErasure,
  cancelSeries,
  cancelUserBooking,
  createBooking,
  createBookingSeries,
  createClassSessions,
  createCourt,
  createVenue,
  enrolInClass,
  getBookingById,
  getWalletBalance,
  payBookingFromWallet,
  rescheduleBooking,
  setPaymentStatus,
  topUpWallet,
  updateVenue,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * A customer cancelling a booking paid at the counter (ADR 0074; brief REFUND): the credit note is written as it always was, and it is not
 * the refund. The money is written down as owed back on the list staff settle from (`counter_refunds_owed`, causes `customer_cancelled` and
 * `place_withdrawn`), less the venue's late share under the terms the booking was sold on, once; staff say when it is handed back, with
 * their name and the method used; and the customer is told the venue will return it at the counter, never that it has been returned.
 */

const ZONE = "Asia/Kuala_Lumpur";
const today = () => todayISO(ZONE);
const at = (h: number) => h * 60;

let venueId: number;
let lateVenueId: number;
let otherVenueId: number;
let depositVenueId: number;
let flat: number; // RM20
let dear: number; // RM60
let cheap: number; // RM25
let lateCourt: number; // RM20, 72-hour cutoff, the venue keeps 25%
let depositCourt: number; // RM60, a 50% deposit
let pool: number; // RM10 a place
let studio: number; // RM20, six places, for classes
let manager: CancellingStaff;
let desk: CancellingStaff;
let managerCookie: string;
let otherDeskCookie: string;
let n = 0;
let slotN = 0;
const phone = () => `0176${String(100000 + ++n)}`;

/** Each booking its own day and hour, so none clashes on the same court and none depends on the time of day. */
function slot() {
  const k = slotN++;
  return { date: addDays(today(), 3 + Math.floor(k / 12)), hour: 8 + (k % 12) };
}

async function user() {
  const made = await registerUser({ name: `Cancel ${++n}`, email: `cc${n}@cc.test`, phone: phone(), password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return { ...made.user, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}

async function book(over: { court?: number; userId?: number; email?: string | null } = {}) {
  const s = slot();
  const ph = phone();
  const made = await createBooking({
    courtId: over.court ?? flat,
    date: s.date,
    hours: [s.hour],
    name: "Aina",
    phone: ph,
    ...(over.email === null ? {} : { email: over.email ?? "aina@cc.test" }),
    ...(over.userId ? { userId: over.userId } : {}),
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return { booking: made.booking, phone: ph, ...s };
}

async function paidAtCounter(over: Parameters<typeof book>[0] = {}, via: "cash" | "qr" | "card" | "transfer" = "cash") {
  const b = await book(over);
  const paid = await setPaymentStatus(b.booking.code, true, via);
  if (!paid.ok) throw new Error(paid.error);
  return b;
}

type OwedRow = {
  id: number;
  cause: string;
  amount: number;
  via: string | null;
  settled_at: string | null;
  outcome: string | null;
  settled_via: string | null;
  withdrawal_id: number | null;
  customer_notified_at: string | null;
};
const owedRows = async (bookingId: number) =>
  (await getDb()
    .prepare(
      `SELECT id, cause, amount::float AS amount, via, settled_at, outcome, settled_via, withdrawal_id, customer_notified_at
         FROM counter_refunds_owed WHERE booking_id = ? ORDER BY id`
    )
    .all(bookingId)) as OwedRow[];
const notes = async (bookingId: number) =>
  (await getDb()
    .prepare("SELECT id, source, total::float AS total, paid_via, staff_name FROM receipts WHERE kind = 'credit_note' AND source LIKE ? ORDER BY id")
    .all(`booking:${bookingId}%`)) as { id: number; source: string; total: number; paid_via: string; staff_name: string | null }[];
const payouts = async (bookingId: number) =>
  (await getDb()
    .prepare("SELECT amount::float AS amount, via, kept_percent, admin_name, credit_note_id FROM counter_payouts WHERE booking_id = ? ORDER BY id")
    .all(bookingId)) as { amount: number; via: string | null; kept_percent: number | null; admin_name: string; credit_note_id: number | null }[];
const status = async (bookingId: number) => ((await getDb().prepare("SELECT status FROM bookings WHERE id = ?").get(bookingId)) as { status: string }).status;
const owedFor = async (bookingId: number) => (await counterOwed(null, "manager")).filter((o) => o.bookingId === bookingId);
const post = (handler: (req: NextRequest) => Promise<Response>, url: string, cookie: string | null, body: object) =>
  handler(
    new NextRequest(`http://localhost${url}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${(++n % 200) + 1}`, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    })
  );

function fakeBillplz() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const id = `ccbill${++n}`;
      return Response.json({ id, url: `https://www.billplz-sandbox.com/bills/${id}` });
    })
  );
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const make = async (name: string, ph: string) => {
    const v = await createVenue({ name, area: "Ipoh", address: "x", phone: ph, openMin: at(7), closeMin: at(23) });
    if (!v.ok) throw new Error("venue");
    // Live, so customers are told (a venue that has never been live tells nobody).
    await getDb().prepare("UPDATE venues SET published_at = datetime('now') WHERE id = ?").run(v.venue.id);
    return v.venue.id;
  };
  const court = async (venue: number, name: string, rate: number, capacity = 1) => {
    const c = await createCourt({ venueId: venue, name, sport: "badminton", offPeakRate: rate, peakRate: rate, capacity });
    if (!c.ok) throw new Error(c.error);
    return c.court.id;
  };
  venueId = await make("Cancel Hall", "0355550201");
  otherVenueId = await make("Other Hall", "0355550202");
  lateVenueId = await make("Late Hall", "0355550203");
  depositVenueId = await make("Deposit Hall", "0355550204");
  flat = await court(venueId, "Flat", 20);
  dear = await court(venueId, "Dear", 60);
  cheap = await court(venueId, "Cheap", 25);
  lateCourt = await court(lateVenueId, "Late", 20);
  depositCourt = await court(depositVenueId, "Deposit", 60);
  studio = await court(venueId, "Studio", 20, 6);
  const r = await createResources({ venueId, sport: "swimming", name: "Pool", offPeakRate: 10, peakRate: 10, capacity: 4, maxPlayers: 4 });
  if (!r.ok) throw new Error(r.error);
  pool = r.courts[0].id;
  expect((await setHouseRules(venueId, { aheadDays: 45 })).ok).toBe(true);
  // Late: inside 72 hours, where the venue keeps a quarter.
  expect((await updateVenue(lateVenueId, { cancelCutoffHours: 72 })).ok).toBe(true);
  expect((await setCancelPolicy(lateVenueId, { lateKeep: 25 })).ok).toBe(true);
  const saved = await savePaymentSettings(depositVenueId, { apiKey: "api-key-9012", collectionId: "col789", xSignatureKey: "S-key3", sandbox: true, enabled: true });
  if (!saved.ok) throw new Error(saved.error);
  await setHoldPolicy(depositVenueId, { on: true, depositPercent: 50 });
  const m = await createAdmin({ name: "Mona Manager", email: "mona@cc.test", password: "a long enough password", venueId, role: "manager" });
  const d = await createAdmin({ name: "Dani Desk", email: "dani@cc.test", password: "a long enough password", venueId, role: "desk" });
  const o = await createAdmin({ name: "Oli Other", email: "oli@cc.test", password: "a long enough password", venueId: otherVenueId, role: "desk" });
  if (!m.ok || !d.ok || !o.ok) throw new Error("staff");
  manager = { id: m.admin.id, name: m.admin.name, role: "manager" };
  desk = { id: d.admin.id, name: d.admin.name, role: "desk" };
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(m.admin.id)).token}`;
  otherDeskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(o.admin.id)).token}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("a customer cancelling a booking paid at the counter", () => {
  it("writes the credit note as ever AND an obligation to hand the money back, with no payout until staff say so", async () => {
    const b = await paidAtCounter({}, "cash");
    const done = await cancelBooking(b.booking.code, b.phone);
    expect(done.ok).toBe(true);
    expect(await status(b.booking.id)).toBe("cancelled");
    // The tax document is there, and says what was sold back.
    expect(await notes(b.booking.id)).toMatchObject([{ source: `booking:${b.booking.id}`, total: 20, paid_via: "Cash" }]);
    // The money owed back is a row of its own, in the way it was paid, and nothing has been handed over.
    const rows = await owedRows(b.booking.id);
    expect(rows).toMatchObject([{ cause: "customer_cancelled", amount: 20, via: "cash", settled_at: null, outcome: null, withdrawal_id: null }]);
    expect(await payouts(b.booking.id)).toEqual([]);
    const listed = (await owedFor(b.booking.id))[0];
    expect(listed).toMatchObject({
      status: "owed",
      byCustomer: true,
      amount: 20,
      via: "cash",
      cause: "customer_cancelled",
      hasEmail: true,
      settled: null,
    });
    // The credit note's number is on the line, and the line does not pretend it was a refund.
    expect(listed.creditNote).toMatch(/^CN-/);
  });

  it("through the signed-in account, the same", async () => {
    const who = await user();
    const b = await paidAtCounter({ userId: who.id }, "qr");
    expect((await cancelUserBooking(who.id, b.booking.id)).ok).toBe(true);
    expect(await owedRows(b.booking.id)).toMatchObject([{ cause: "customer_cancelled", amount: 20, via: "qr" }]);
    expect(await notes(b.booking.id)).toHaveLength(1);
  });

  it("a booking paid with a tick that never recorded a method is owed too, as 'not recorded'", async () => {
    const b = await book();
    expect((await setPaymentStatus(b.booking.code, true, null)).ok).toBe(true);
    expect((await cancelBooking(b.booking.code, b.phone)).ok).toBe(true);
    expect(await owedRows(b.booking.id)).toMatchObject([{ cause: "customer_cancelled", amount: 20, via: null }]);
  });

  it("not paid, paid online, from credit: nothing is owed at the counter", async () => {
    const unpaid = await book();
    expect((await cancelBooking(unpaid.booking.code, unpaid.phone)).ok).toBe(true);
    expect(await owedRows(unpaid.booking.id)).toEqual([]);

    const who = await user();
    await topUpWallet({ userId: who.id, amount: 50, adminId: manager.id!, venueId });
    const withCredit = await book({ userId: who.id });
    expect(await payBookingFromWallet(withCredit.booking.id)).toMatchObject({ ok: true });
    expect((await cancelUserBooking(who.id, withCredit.booking.id)).ok).toBe(true);
    expect(await owedRows(withCredit.booking.id)).toEqual([]);
    expect(await getWalletBalance(who.id, venueId)).toBe(50);

    const online = await book({ court: depositCourt });
    fakeBillplz();
    const started = await startBookingPayment({ codes: [online.booking.code], phone: online.phone });
    if (!started.ok) throw new Error(JSON.stringify(started));
    const bill = (await getDb().prepare("SELECT bill_id FROM online_payments ORDER BY id DESC LIMIT 1").get()) as { bill_id: string };
    await settleBill({ billId: bill.bill_id, paid: true, paidAt: null });
    expect((await cancelBooking(online.booking.code, online.phone)).ok).toBe(true);
    expect(await owedRows(online.booking.id)).toEqual([]);
  });

  it("a late cancellation: only what the venue does not keep is owed, on the terms the booking was sold on", async () => {
    const s = slot();
    const ph = phone();
    // Sold on a 72-hour cutoff keeping 25%; tomorrow is late.
    const made = await createBooking({ courtId: lateCourt, date: addDays(today(), 1), hours: [s.hour], name: "Mei", phone: ph, email: "mei@cc.test" });
    if (!made.ok) throw new Error(JSON.stringify(made));
    expect((await setPaymentStatus(made.booking.code, true, "cash")).ok).toBe(true);
    // The venue then changes its terms: the booking is cancelled on the ones it was sold on.
    expect((await setCancelPolicy(lateVenueId, { lateKeep: 90 })).ok).toBe(true);
    const done = await cancelBooking(made.booking.code, ph);
    expect(done).toMatchObject({ ok: true, kept: 5 });
    expect((await setCancelPolicy(lateVenueId, { lateKeep: 25 })).ok).toBe(true);
    expect(await owedRows(made.booking.id)).toMatchObject([{ cause: "customer_cancelled", amount: 15, via: "cash" }]);
    expect(await notes(made.booking.id)).toMatchObject([{ total: 15 }]);
    // Settled: the payout says the share the venue kept.
    const owed = (await owedFor(made.booking.id))[0];
    expect(await settleOwed(owed.id, "back", manager)).toMatchObject({ ok: true, settled: { paidOut: { amount: 15, via: "cash" } } });
    expect(await payouts(made.booking.id)).toMatchObject([{ amount: 15, via: "cash", kept_percent: 25, admin_name: "Mona Manager" }]);
  });
});

describe("the customer is told honestly", () => {
  it("the cancel route says the venue will return the money at the counter, and the message the same; the obligation records it was told", async () => {
    const b = await paidAtCounter({}, "cash");
    const res = await post(cancelRoute, "/api/bookings/cancel", null, { code: b.booking.code, phone: b.phone });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { refunds: { how: string; amount: number }[] };
    expect(body.refunds).toEqual([{ how: "counter", amount: 20 }]);
    const msg = (await getDb().prepare("SELECT body, status FROM messages WHERE booking_id = ? AND kind = 'booking_cancelled'").get(b.booking.id)) as { body: string; status: string };
    expect(msg.body).toContain("will return RM20 to you at the counter");
    expect(msg.body).toContain("has not been returned yet");
    expect(msg.body).not.toContain("Nothing is owed for it");
    expect((await owedRows(b.booking.id))[0].customer_notified_at).not.toBeNull();
    expect((await owedFor(b.booking.id))[0].notifiedAt).not.toBeNull();
  });

  it("no address to write to: the obligation says the customer was not told, so staff tell them", async () => {
    const b = await paidAtCounter({ email: null }, "cash");
    const res = await post(cancelRoute, "/api/bookings/cancel", null, { code: b.booking.code, phone: b.phone });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { refunds: unknown[] }).refunds).toEqual([{ how: "counter", amount: 20 }]);
    expect((await owedRows(b.booking.id))[0].customer_notified_at).toBeNull();
    expect((await owedFor(b.booking.id))[0]).toMatchObject({ notifiedAt: null, hasEmail: false });
  });

  it("the signed-in route says it too, in the customer's language", async () => {
    const who = await user();
    const b = await paidAtCounter({ userId: who.id }, "card");
    const res = await post(myCancelRoute, "/api/my/bookings/cancel", who.cookie, { bookingId: b.booking.id });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { refunds: unknown[] }).refunds).toEqual([{ how: "counter", amount: 20 }]);
  });

  it("the words exist in all four languages and none says it was returned", async () => {
    const { DICTIONARIES } = await import("../src/lib/i18n");
    const en = DICTIONARIES.en["rf74.refundCounter"];
    for (const locale of ["en", "ms", "zh", "ta"] as const) {
      const text = DICTIONARIES[locale]["rf74.refundCounter"];
      expect(text).toBeTruthy();
      expect(text).toContain("{amount}");
      expect(text.length).toBeGreaterThan(30);
    }
    expect(en).not.toMatch(/has been (returned|refunded)|was refunded/i);
  });
});

describe("a week of a weekly series, a class place, an account closed", () => {
  it("each week cancelled owes its own money back, once", async () => {
    const ph = phone();
    const date = addDays(today(), 8);
    const made = await createBookingSeries({ courtId: flat, date, hours: [9], weeks: 3, name: "Liga", phone: ph });
    if (!made.ok) throw new Error(made.error);
    const codes = ((await getDb().prepare("SELECT code, id FROM bookings WHERE series_code = ? ORDER BY date").all(made.seriesCode)) as { code: string; id: number }[]);
    for (const c of codes) expect((await setPaymentStatus(c.code, true, "cash")).ok).toBe(true);
    const done = await cancelSeries(made.seriesCode!, ph, { codes: codes.map((c) => c.code).slice(0, 2) });
    expect(done).toMatchObject({ ok: true, cancelled: 2 });
    for (const c of codes.slice(0, 2)) expect(await owedRows(c.id)).toMatchObject([{ cause: "customer_cancelled", amount: 20, via: "cash" }]);
    expect(await owedRows(codes[2].id)).toEqual([]);
    expect((await status(codes[2].id))).toBe("confirmed");
    // Asked again: nothing twice.
    const again = await cancelSeries(made.seriesCode!, ph, { codes: codes.map((c) => c.code).slice(0, 2) });
    expect(again.ok).toBe(false);
    expect((await getDb().prepare("SELECT COUNT(*)::int AS n FROM counter_refunds_owed WHERE booking_id IN (?, ?)").get(codes[0].id, codes[1].id)) as { n: number }).toEqual({ n: 2 });
  });

  it("the series route tells the customer, one line for the weeks", async () => {
    const ph = phone();
    const made = await createBookingSeries({ courtId: flat, date: addDays(today(), 15), hours: [10], weeks: 2, name: "Liga", phone: ph, email: "liga@cc.test" });
    if (!made.ok) throw new Error(made.error);
    const codes = ((await getDb().prepare("SELECT code, id FROM bookings WHERE series_code = ? ORDER BY date").all(made.seriesCode)) as { code: string; id: number }[]);
    for (const c of codes) await setPaymentStatus(c.code, true, "qr");
    const res = await post(cancelSeriesRoute, "/api/bookings/cancel-series", null, { seriesCode: made.seriesCode, phone: ph, codes: codes.map((c) => c.code) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { refunds: unknown[] }).refunds).toEqual([{ how: "counter", amount: 40 }]);
    const msg = (await getDb().prepare("SELECT body FROM messages WHERE booking_id = ? AND kind = 'booking_cancelled'").get(codes[0].id)) as { body: string };
    expect(msg.body).toContain("will return RM40 to you at the counter");
  });

  it("a class place the customer cancels is owed back like any booking", async () => {
    const made = await createClassSessions({ courtId: studio, name: "Yoga", instructor: "Nadia", date: addDays(today(), 9), startHour: 18, endHour: 19, capacity: 4, price: 30 });
    if (!made.ok) throw new Error(made.error);
    const who = await user();
    const enrolled = await enrolInClass({ classId: made.classes[0].id, name: "Student", phone: who.phone, userId: who.id });
    if (!enrolled.ok) throw new Error(enrolled.error);
    expect((await setPaymentStatus(enrolled.booking.code, true, "cash")).ok).toBe(true);
    expect((await cancelUserBooking(who.id, enrolled.booking.id)).ok).toBe(true);
    expect(await owedRows(enrolled.booking.id)).toMatchObject([{ cause: "customer_cancelled", amount: 30, via: "cash" }]);
  });

  it("a class the venue calls off is still owed with its own cause: one row, not two", async () => {
    const made = await createClassSessions({ courtId: studio, name: "Pilates", instructor: "Nadia", date: addDays(today(), 10), startHour: 18, endHour: 19, capacity: 4, price: 30 });
    if (!made.ok) throw new Error(made.error);
    const enrolled = await enrolInClass({ classId: made.classes[0].id, name: "Student", phone: phone() });
    if (!enrolled.ok) throw new Error(enrolled.error);
    expect((await setPaymentStatus(enrolled.booking.code, true, "cash")).ok).toBe(true);
    expect((await cancelClassAndTell(made.classes[0].id)).ok).toBe(true);
    expect(await owedRows(enrolled.booking.id)).toMatchObject([{ cause: "class", amount: 30 }]);
    expect(await notes(enrolled.booking.id)).toEqual([]);
  });
});

describe("a person the customer takes off a booking paid at the counter", () => {
  async function paidPool(players: number) {
    const who = await user();
    const s = slot();
    const made = await createBookingSeries({ weeks: 1, name: who.name, phone: who.phone, userId: who.id, by: "staff", date: s.date, start: at(s.hour), end: at(s.hour + 1), courtId: pool, players });
    if (!made.ok) throw new Error(made.error);
    const booking = made.bookings[0];
    expect((await setPaymentStatus(booking.code, true, "cash")).ok).toBe(true);
    return { who, booking };
  }
  const customer = (who: { id: number; name: string }) => ({ kind: "customer" as const, userId: who.id, name: who.name });

  it("owes back that place's part, then cancelling owes back what is left: two obligations, both settleable", async () => {
    const { who, booking } = await paidPool(3);
    const withdrawn = await withdrawPlace(booking.id, { unnamed: 1 }, customer(who));
    expect(withdrawn).toMatchObject({ ok: true, withdrawal: { how: "hand", refund: 10 } });
    let rows = await owedRows(booking.id);
    expect(rows).toMatchObject([{ cause: "place_withdrawn", amount: 10, via: "cash" }]);
    expect(rows[0].withdrawal_id).not.toBeNull();
    // That place has its own credit note; the booking's receipt is not turned over.
    expect((await notes(booking.id)).map((x) => x.total)).toEqual([10]);

    expect((await cancelUserBooking(who.id, booking.id)).ok).toBe(true);
    rows = await owedRows(booking.id);
    expect(rows.map((r) => [r.cause, r.amount])).toEqual([
      ["place_withdrawn", 10],
      ["customer_cancelled", 20],
    ]);
    // Together they are exactly what was paid.
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBe(30);
    for (const r of rows) expect(await settleOwed(r.id, "back", manager)).toMatchObject({ ok: true });
    expect((await payouts(booking.id)).map((p) => p.amount)).toEqual([10, 20]);
    expect((await owedFor(booking.id))).toEqual([]);
  });

  it("the same withdrawal asked twice is owed once", async () => {
    const { who, booking } = await paidPool(3);
    const first = await withdrawPlace(booking.id, { unnamed: 1 }, customer(who));
    expect(first.ok).toBe(true);
    const rows = await owedRows(booking.id);
    expect(await oweCounterToCustomer(booking.id, 1, { id: rows[0].withdrawal_id!, amount: 10 })).toBe(false);
    expect(await owedRows(booking.id)).toHaveLength(1);
  });

  it("the venue's own system through its API key has no till: it is owed back there, as for the customer", async () => {
    const { booking } = await paidPool(3);
    const key = await createApiKey(venueId, { name: "Website", scope: "write" }, null);
    if (!key.ok) throw new Error("key");
    const keyId = (await getDb().prepare("SELECT id FROM venue_api_keys WHERE venue_id = ? ORDER BY id DESC LIMIT 1").get(venueId)) as { id: number };
    const done = await withdrawPlace(booking.id, { unnamed: 1 }, { kind: "api", keyId: keyId.id, name: "Website" });
    expect(done.ok).toBe(true);
    expect(await owedRows(booking.id)).toMatchObject([{ cause: "place_withdrawn", amount: 10, via: "cash" }]);
  });

  it("staff at the counter hand it over themselves: nothing is owed", async () => {
    const { booking } = await paidPool(3);
    const done = await withdrawPlace(booking.id, { unnamed: 1 }, { kind: "staff", adminId: manager.id!, name: manager.name });
    expect(done.ok).toBe(true);
    expect(await owedRows(booking.id)).toEqual([]);
  });
});

describe("a customer's account closed over a booking paid at the counter", () => {
  it("cancels it on their terms like their own cancellation, and the money is owed back at the counter", async () => {
    const who = await user();
    const b = await paidAtCounter({ userId: who.id }, "cash");
    const freed = await cancelForErasure(b.booking.id);
    expect(freed).not.toBeNull();
    expect(await owedRows(b.booking.id)).toMatchObject([{ cause: "customer_cancelled", amount: 20, via: "cash" }]);
    expect(await notes(b.booking.id)).toHaveLength(1);
  });
});

describe("a deposit paid online and the rest at the counter", () => {
  it("only the counter part is owed at the counter; the deposit goes back online as it always did", async () => {
    const ph = phone();
    const made = await createBooking({ courtId: depositCourt, date: addDays(today(), 4), hours: [9], name: "Aina", phone: ph, email: "dep@cc.test" });
    if (!made.ok) throw new Error(JSON.stringify(made));
    fakeBillplz();
    const started = await startBookingPayment({ codes: [made.booking.code], phone: ph, deposit: true });
    if (!started.ok) throw new Error(JSON.stringify(started));
    const bill = (await getDb().prepare("SELECT id, bill_id FROM online_payments ORDER BY id DESC LIMIT 1").get()) as { id: number; bill_id: string };
    await settleBill({ billId: bill.bill_id, paid: true, paidAt: null });
    expect((await setPaymentStatus(made.booking.code, true, "cash")).ok).toBe(true);
    expect((await cancelBooking(made.booking.code, ph)).ok).toBe(true);
    expect(await owedRows(made.booking.id)).toMatchObject([{ cause: "customer_cancelled", amount: 30, via: "cash" }]);
    const payment = (await getDb().prepare("SELECT amount::float AS amount, refund_due::float AS due FROM online_payments WHERE id = ?").get(bill.id)) as { amount: number; due: number };
    expect(payment).toEqual({ amount: 30, due: 30 });
  });
});

describe("settling: once, by a named member of staff, never marked paid before", () => {
  it("handed back the way it was paid: a payout with who, how much and the method, on the credit note already written; no second note", async () => {
    const b = await paidAtCounter({}, "cash");
    await cancelBooking(b.booking.code, b.phone);
    const [note] = await notes(b.booking.id);
    const owed = (await owedFor(b.booking.id))[0];
    const done = await settleOwed(owed.id, "back", desk);
    expect(done).toMatchObject({ ok: true, settled: { outcome: "back", paidOut: { amount: 20, via: "cash" } } });
    expect(await payouts(b.booking.id)).toEqual([{ amount: 20, via: "cash", kept_percent: null, admin_name: "Dani Desk", credit_note_id: note.id }]);
    expect(await notes(b.booking.id)).toHaveLength(1);
    const after = (await owedRefund(owed.id, "manager"))!;
    expect(after).toMatchObject({ status: "completed", settled: { outcome: "back", by: "Dani Desk", via: null } });
    expect(await owedFor(b.booking.id)).toEqual([]);
    // In the day's list of money handed back.
    const listed = await counterPayoutsOn([venueId], today());
    expect(listed.find((p) => p.bookingCode === b.booking.code)).toMatchObject({ amount: 20, via: "cash", adminName: "Dani Desk", creditNote: note.id ? expect.stringMatching(/^CN-/) : null });
    // Settled, it is not offered again; staff are told so.
    expect(await settleOwed(owed.id, "back", desk)).toMatchObject({ ok: false, error: OWED_REFUSALS.settled });
    expect(await payouts(b.booking.id)).toHaveLength(1);
  });

  it("an agreed alternative method is recorded as the method used, beside the one it was paid with", async () => {
    const b = await paidAtCounter({}, "cash");
    await cancelBooking(b.booking.code, b.phone);
    const owed = (await owedFor(b.booking.id))[0];
    const done = await settleOwed(owed.id, "back", manager, { via: "transfer" });
    expect(done).toMatchObject({ ok: true, settled: { paidOut: { amount: 20, via: "transfer" } } });
    expect(await payouts(b.booking.id)).toMatchObject([{ amount: 20, via: "transfer" }]);
    expect(await owedRows(b.booking.id)).toMatchObject([{ via: "cash", settled_via: "transfer", outcome: "back" }]);
    expect((await owedRefund(owed.id, "manager"))!.settled).toMatchObject({ via: "transfer" });
    // The credit note is not rewritten: it stays as it was written.
    expect(await notes(b.booking.id)).toMatchObject([{ total: 20, paid_via: "Cash" }]);
  });

  it("an alternative method is refused where it makes no sense: as credit, an unknown method, a venue's own cancellation", async () => {
    const who = await user();
    const b = await paidAtCounter({ userId: who.id }, "cash");
    await cancelUserBooking(who.id, b.booking.id);
    const owed = (await owedFor(b.booking.id))[0];
    expect(await settleOwed(owed.id, "credit", manager, { via: "qr" })).toMatchObject({ ok: false, error: OWED_REFUSALS.otherWay });
    expect(await settleOwed(owed.id, "back", manager, { via: "bitcoin" as never })).toMatchObject({ ok: false, error: OWED_REFUSALS.otherWay });
    const day = await post(settleRoute, "/api/admin/bookings/owed", managerCookie, { id: owed.id, outcome: "back", via: "bitcoin" });
    expect(day.status).toBe(400);
    expect((await owedRows(b.booking.id))[0].settled_at).toBeNull();
    expect(await payouts(b.booking.id)).toEqual([]);

    const closed = await paidAtCounter({}, "cash");
    const rain = await getDb().prepare("INSERT INTO counter_refunds_owed (venue_id, booking_id, amount, via, cause) VALUES (?, ?, 20, 'cash', 'closure') RETURNING id").get(venueId, closed.booking.id);
    expect(await settleOwed((rain as { id: number }).id, "back", manager, { via: "qr" })).toMatchObject({ ok: false, error: OWED_REFUSALS.otherWay });
  });

  it("given as stored credit instead (an account): the credit is the amount owed, the credit note stays, no payout", async () => {
    const who = await user();
    const b = await paidAtCounter({ userId: who.id }, "cash");
    await cancelUserBooking(who.id, b.booking.id);
    expect(await getWalletBalance(who.id, venueId)).toBe(0);
    const owed = (await owedFor(b.booking.id))[0];
    expect(owed.account).toBe(true);
    expect(await settleOwed(owed.id, "credit", manager)).toMatchObject({ ok: true, settled: { outcome: "credit", credited: 20 } });
    expect(await getWalletBalance(who.id, venueId)).toBe(20);
    expect(await payouts(b.booking.id)).toEqual([]);
    expect(await notes(b.booking.id)).toHaveLength(1);
    // Not for a booking made without an account.
    const guest = await paidAtCounter({}, "cash");
    await cancelBooking(guest.booking.code, guest.phone);
    const g = (await owedFor(guest.booking.id))[0];
    expect(await settleOwed(g.id, "credit", manager)).toMatchObject({ ok: false });
  });

  it("the front desk hands back a payment taken today; one taken on an earlier day is a manager's", async () => {
    const b = await paidAtCounter({}, "cash");
    await getDb().prepare("UPDATE bookings SET paid_at = ? WHERE id = ?").run(`${addDays(today(), -2)}T03:00:00.000Z`, b.booking.id);
    await cancelBooking(b.booking.code, b.phone);
    const owed = (await counterOwed(null, "desk")).find((o) => o.bookingId === b.booking.id)!;
    expect(owed.managerOnly).toBe(true);
    expect(await settleOwed(owed.id, "back", desk)).toMatchObject({ ok: false });
    expect(await payouts(b.booking.id)).toEqual([]);
    expect(await settleOwed(owed.id, "back", manager)).toMatchObject({ ok: true });
  });

  it("another venue's staff see and settle nothing of it; the route records the method and the log says so", async () => {
    const b = await paidAtCounter({}, "cash");
    await cancelBooking(b.booking.code, b.phone);
    const owed = (await owedFor(b.booking.id))[0];
    expect((await post(settleRoute, "/api/admin/bookings/owed", otherDeskCookie, { id: owed.id, outcome: "back" })).status).toBe(403);
    expect((await owedRows(b.booking.id))[0].settled_at).toBeNull();
    const ok = await post(settleRoute, "/api/admin/bookings/owed", managerCookie, { id: owed.id, outcome: "back", via: "qr" });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { owed: { status: string; settled: { by: string; via: string } }; settled: { paidOut: { via: string } } };
    expect(body.owed).toMatchObject({ status: "completed", settled: { by: "Mona Manager", via: "qr" } });
    const logged = (await listActivity([venueId], { bookingCode: b.booking.code })).find((e) => e.action === "payment.paid_out" && e.bookingCode === b.booking.code);
    expect(logged?.detail).toContain("by DuitNow QR");
    expect(logged?.detail).toContain("not the way it was paid (Cash)");
    expect(logged?.detail).toContain("the customer cancelled it");
  });

  it("the day's list shows it with who, why, how much, how it was paid and the credit note", async () => {
    const b = await paidAtCounter({}, "card");
    await cancelBooking(b.booking.code, b.phone);
    const res = await dayRoute(new NextRequest(`http://localhost/api/admin/bookings?date=${b.date}`, { headers: { cookie: managerCookie } }));
    expect(res.status).toBe(200);
    const day = (await res.json()) as { owed: { bookingCode: string; byCustomer: boolean; status: string; cause: string; creditNote: string | null; hasEmail: boolean }[] };
    expect(day.owed.find((o) => o.bookingCode === b.booking.code)).toMatchObject({ byCustomer: true, status: "owed", cause: "customer_cancelled", hasEmail: true });
  });
});

describe("the same cancellation from two places at once", () => {
  it("a customer's double submit is one cancellation: one obligation, one credit note", async () => {
    const b = await paidAtCounter({}, "cash");
    const both = await Promise.all([cancelBooking(b.booking.code, b.phone), cancelBooking(b.booking.code, b.phone)]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(await owedRows(b.booking.id)).toHaveLength(1);
    expect(await notes(b.booking.id)).toHaveLength(1);
  });

  it("two members of staff settling at once hand it back once", async () => {
    const b = await paidAtCounter({}, "cash");
    await cancelBooking(b.booking.code, b.phone);
    const owed = (await owedFor(b.booking.id))[0];
    const both = await Promise.all([settleOwed(owed.id, "back", desk), settleOwed(owed.id, "back", manager)]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(await payouts(b.booking.id)).toHaveLength(1);
    expect(await notes(b.booking.id)).toHaveLength(1);
  });

  it("settling as credit and as cash at once: one of them, never both", async () => {
    const who = await user();
    const b = await paidAtCounter({ userId: who.id }, "cash");
    await cancelUserBooking(who.id, b.booking.id);
    const owed = (await owedFor(b.booking.id))[0];
    const both = await Promise.all([settleOwed(owed.id, "back", desk), settleOwed(owed.id, "credit", manager)]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    const credited = await getWalletBalance(who.id, venueId);
    const paid = (await payouts(b.booking.id)).length;
    expect(credited > 0 ? 1 : 0).toBe(1 - paid);
  });

  it("the customer cancelling while staff cancel it: one of them wins, and the money is owed or paid out once, never both", async () => {
    const b = await paidAtCounter({}, "cash");
    const both = await Promise.all([cancelBooking(b.booking.code, b.phone), staffCancel(b.booking.code, desk)]);
    const customerWon = both[0].ok;
    const staffWon = both[1].result.ok;
    expect(customerWon !== staffWon).toBe(true);
    const owed = await owedRows(b.booking.id);
    const paid = await payouts(b.booking.id);
    expect(owed.length + paid.length).toBe(1);
    if (customerWon) expect(owed).toHaveLength(1);
    else expect(paid).toHaveLength(1);
    expect(await notes(b.booking.id)).toHaveLength(1);
  });

  it("the customer cancelling while the desk takes the payment back: the booking is never both cancelled-and-owed and unpaid", async () => {
    const b = await paidAtCounter({}, "cash");
    const both = await Promise.all([cancelBooking(b.booking.code, b.phone), setPaymentStatus(b.booking.code, false, null, "manager")]);
    const booking = (await getBookingById(b.booking.id))!;
    const owed = await owedRows(b.booking.id);
    if (owed.length > 0) expect(booking.paymentStatus).toBe("paid");
    else expect((await notes(b.booking.id)).length).toBe(0);
    expect(both.some((r) => r.ok)).toBe(true);
  });
});

describe("moved cheaper and then cancelled", () => {
  it("is two obligations: the difference from the move and the rest from the cancellation, together exactly what was paid, both settleable", async () => {
    const b = await paidAtCounter({ court: dear }, "cash");
    const moved = await rescheduleBooking(b.booking.code, { date: b.date, start: b.hour * 60, courtId: cheap }, "customer");
    expect(moved).toMatchObject({ ok: true, money: { refund: { amount: 35, how: "counter" } } });
    expect((await cancelBooking(b.booking.code, b.phone)).ok).toBe(true);
    const rows = await owedRows(b.booking.id);
    expect(rows.map((r) => [r.cause, r.amount])).toEqual([
      ["moved_cheaper", 35],
      ["customer_cancelled", 25],
    ]);
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBe(60);
    const settled = [];
    for (const r of rows) settled.push(await settleOwed(r.id, "back", manager));
    expect(settled.every((s) => s.ok)).toBe(true);
    expect((await payouts(b.booking.id)).map((p) => p.amount)).toEqual([35, 25]);
  });

  it("a move and a cancellation at the same moment never owe more than was paid", async () => {
    const b = await paidAtCounter({ court: dear }, "cash");
    await Promise.all([
      rescheduleBooking(b.booking.code, { date: b.date, start: b.hour * 60, courtId: cheap }, "customer"),
      cancelBooking(b.booking.code, b.phone),
    ]);
    const rows = await owedRows(b.booking.id);
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBeLessThanOrEqual(60);
    expect(rows.filter((r) => r.cause === "customer_cancelled").length).toBeLessThanOrEqual(1);
  });
});

describe("the venue closing a day over counter-paid bookings", () => {
  it("is owed with its own cause, once; the customer's cause is never added on top", async () => {
    const b = await paidAtCounter({}, "cash");
    const { venueCancel } = await import("../src/lib/counter-refunds");
    expect((await venueCancel(b.booking.code, "closure")).ok).toBe(true);
    expect(await owedRows(b.booking.id)).toMatchObject([{ cause: "closure", amount: 20 }]);
    expect(await cancelBooking(b.booking.code, b.phone)).toMatchObject({ ok: false });
    expect(await owedRows(b.booking.id)).toHaveLength(1);
    // Settled as before: its credit note is written then, by whoever hands it back.
    const owed = (await owedFor(b.booking.id))[0];
    expect(owed).toMatchObject({ byCustomer: false, creditNote: null });
    expect(await settleOwed(owed.id, "back", desk)).toMatchObject({ ok: true });
    expect(await notes(b.booking.id)).toMatchObject([{ total: 20, paid_via: "Cash" }]);
  });
});

describe("the cash-up and the day's payouts", () => {
  it("the credit note is in the cash-up of the day it was written, the payout in the list of the day it was handed over, for the same amount and method", async () => {
    const b = await paidAtCounter({}, "cash");
    await cancelBooking(b.booking.code, b.phone);
    const [note] = await notes(b.booking.id);
    const till = await cashUp(venueId, today(), null);
    const number = ((await getDb().prepare("SELECT number FROM receipts WHERE id = ?").get(note.id)) as { number: string }).number;
    expect(till.entries.find((e) => e.number === number)).toMatchObject({ type: "Credit note", method: "cash", gross: -20 });
    // A credit note is not proof of a refund: no payout yet.
    expect((await counterPayoutsOn([venueId], today())).some((p) => p.bookingCode === b.booking.code)).toBe(false);
    const owed = (await owedFor(b.booking.id))[0];
    expect((await settleOwed(owed.id, "back", desk)).ok).toBe(true);
    const payout = (await counterPayoutsOn([venueId], today())).find((p) => p.bookingCode === b.booking.code)!;
    expect(payout).toMatchObject({ amount: 20, via: "cash", creditNote: number });
    expect(payout.amount).toBe(-till.entries.find((e) => e.number === number)!.gross);
  });
});

describe("what a mock does not prove, and the old rows", () => {
  it("a credit note alone is not a payout: a cancelled booking with a credit note and no owed row is what the reconciliation lists", async () => {
    const script = fs.readFileSync(path.join(__dirname, "..", "scripts", "reconcile-counter-cancellations.sql"), "utf8");
    // Legacy-shaped: cancelled by the customer before the obligation existed, credit note written, no owed row, no payout.
    const legacy = await paidAtCounter({}, "cash");
    await cancelBooking(legacy.booking.code, legacy.phone);
    await getDb().prepare("DELETE FROM counter_refunds_owed WHERE booking_id = ?").run(legacy.booking.id);
    // One that was handed back by staff (a payout) and one that is owed: neither is a candidate.
    const handed = await paidAtCounter({}, "cash");
    await cancelBooking(handed.booking.code, handed.phone);
    await getDb().prepare("DELETE FROM counter_refunds_owed WHERE booking_id = ?").run(handed.booking.id);
    await getDb().prepare("INSERT INTO counter_payouts (venue_id, booking_id, amount, via, admin_name) VALUES (?, ?, 20, 'cash', 'Dani Desk')").run(venueId, handed.booking.id);
    const owedNow = await paidAtCounter({}, "cash");
    await cancelBooking(owedNow.booking.code, owedNow.phone);
    // Staff's own cancellation is not a customer's.
    const byStaff = await paidAtCounter({}, "cash");
    await staffCancel(byStaff.booking.code, desk);
    // Not paid at the counter: not a candidate.
    const online = await book();
    await cancelBooking(online.booking.code, online.phone);

    const rows = (await getDb().prepare(script).all()) as { booking_code: string; amount_possibly_owed: number; paid_with: string | null; credit_note: string; venue: string }[];
    const codes = rows.map((r) => r.booking_code);
    expect(codes).toContain(legacy.booking.code);
    expect(codes).not.toContain(handed.booking.code);
    expect(codes).not.toContain(owedNow.booking.code);
    expect(codes).not.toContain(byStaff.booking.code);
    expect(codes).not.toContain(online.booking.code);
    expect(rows.find((r) => r.booking_code === legacy.booking.code)).toMatchObject({ paid_with: "cash", venue: "Cancel Hall" });
    expect(Number(rows.find((r) => r.booking_code === legacy.booking.code)!.amount_possibly_owed)).toBe(20);
    // Read only: it changed nothing.
    expect(await owedRows(legacy.booking.id)).toEqual([]);
  });

  it("the reconciliation script is a single read-only query", () => {
    const script = fs.readFileSync(path.join(__dirname, "..", "scripts", "reconcile-counter-cancellations.sql"), "utf8");
    const code = script
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(code).not.toMatch(/\b(insert|update|delete|drop|alter|create|truncate)\b/i);
    expect(code.trim().toLowerCase().startsWith("select") || code.trim().toLowerCase().startsWith("with")).toBe(true);
  });

  it("counter lines for the customer: nothing owed, no line", async () => {
    const b = await book();
    expect(await counterRefundLines([b.booking.id])).toEqual([]);
    expect(await counterRefundLines([])).toEqual([]);
  });
});
