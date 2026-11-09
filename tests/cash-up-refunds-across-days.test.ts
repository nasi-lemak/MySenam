import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { GET as cashUpGet } from "../src/app/api/admin/cash-up/route";
import { asStaff } from "../src/lib/acting-staff";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { registerUser, createSession } from "../src/lib/auth";
import { cashUp, cashUpAs, type CashUp } from "../src/lib/cash-up";
import { setCancelPolicy } from "../src/lib/cancel-policy";
import { counterOwed, settleOwed, staffCancel, venueCancel, type CancellingStaff } from "../src/lib/counter-refunds";
import { getDb } from "../src/lib/db";
import { creditBookingMove } from "../src/lib/documents";
import { settleEntryFee } from "../src/lib/entry-fee-refunds";
import { savePaymentSettings, settleBill, startBookingPayment } from "../src/lib/payments";
import { setHoldPolicy } from "../src/lib/holds";
import {
  cancelBooking,
  cancelUserBooking,
  createBooking,
  createCourt,
  createVenue,
  issuePass,
  rescheduleBooking,
  setPaymentStatus,
  updateVenue,
  voidPass,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Brief CASH (ADR 0075): the cash-up compares a till with the cash actually received and actually handed back on the day. A customer who
 * cancels on day D is owed money on D; if staff hand it over on D+1, the cash leaves the till on D+1. The credit note is the record of the
 * cancellation (it stays in the journal, dated as written) and is not a till movement; the payout is. An obligation not yet paid is shown as
 * *still owed back*, never as money gone.
 *
 * Every scenario lives on its own run of days in the past (events are written now and then dated), so nothing depends on today, on the time of
 * day or on the weekday. `TRACE=1` prints each scenario's day-by-day numbers.
 */

const ZONE = "Asia/Kuala_Lumpur";
const today = () => todayISO(ZONE);
let venueId: number;
let lateVenueId: number;
let depositVenueId: number;
let flat: number; // RM20
let dear: number; // RM60
let cheap: number; // RM25
let lateCourt: number; // RM20, 72-hour cutoff, the venue keeps 25%
let depositCourt: number; // RM60, 50% deposit online
let manager: CancellingStaff;
let desk: CancellingStaff;
let otherDesk: CancellingStaff;
let managerCookie: string;
let n = 0;
let slotN = 0;
let run = 0;
const phone = () => `0177${String(100000 + ++n)}`;

/** A run of days of its own for each scenario: paid P, then D, E, F, none shared with another scenario. */
function days() {
  const P = addDays("2026-01-01", 5 * run++);
  return { P, D: addDays(P, 1), E: addDays(P, 2), F: addDays(P, 3) };
}
/** Noon on the venue's day (Kuala Lumpur, UTC+8). */
const noon = (day: string) => `${day}T04:00:00Z`;
const local = (day: string) => `${day} 04:00:00`;

function slot() {
  const k = slotN++;
  return { date: addDays(today(), 3 + Math.floor(k / 12)), hour: 8 + (k % 12) };
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
    ...(over.email === null ? {} : { email: over.email ?? "aina@cash.test" }),
    ...(over.userId ? { userId: over.userId } : {}),
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return { booking: made.booking, phone: ph, ...s };
}

async function paidAtCounter(over: Parameters<typeof book>[0] = {}, via: "cash" | "qr" | "card" | "transfer" | null = "cash") {
  const b = await book(over);
  const paid = await setPaymentStatus(b.booking.code, true, via);
  if (!paid.ok) throw new Error(paid.error);
  return b;
}

/* Dating what happened: the code writes everything "now"; the days of the story are set afterwards. */
const db = () => getDb();
// Dated last: front desk may only hand back a payment taken today, so a payment's date moves after the settling.
const pendingPaid: [number, string][] = [];
const whenPaid = async (bookingId: number, day: string) => void pendingPaid.push([bookingId, day]);
async function flushPaid() {
  for (const [id, d] of pendingPaid.splice(0)) await db().prepare("UPDATE bookings SET paid_at = ? WHERE id = ?").run(local(d), id);
}
const whenNote = (source: string, day: string) => db().prepare("UPDATE receipts SET issued_at = ? WHERE kind = 'credit_note' AND source = ?").run(local(day), source);
const whenOwed = (bookingId: number, day: string, cause?: string) =>
  db().prepare(`UPDATE counter_refunds_owed SET owed_since = ?::timestamptz WHERE booking_id = ?${cause ? " AND cause = ?" : ""}`).run(...([noon(day), bookingId, ...(cause ? [cause] : [])] as [string, number, string?]));
const whenHanded = async (bookingId: number, day: string, cause?: string) => {
  await db()
    .prepare(`UPDATE counter_refunds_owed SET settled_at = ?::timestamptz WHERE booking_id = ? AND settled_at IS NOT NULL${cause ? " AND cause = ?" : ""}`)
    .run(...([noon(day), bookingId, ...(cause ? [cause] : [])] as [string, number, string?]));
};
const whenPaidOut = (payoutId: number, day: string) => db().prepare("UPDATE counter_payouts SET paid_out_at = ?::timestamptz WHERE id = ?").run(noon(day), payoutId);
const payoutsOf = async (bookingId: number) =>
  (await db().prepare("SELECT id, amount::float AS amount, via, credit_note_id FROM counter_payouts WHERE booking_id = ? ORDER BY id").all(bookingId)) as {
    id: number;
    amount: number;
    via: string | null;
    credit_note_id: number | null;
  }[];
const owedOf = async (bookingId: number) => (await counterOwed(null, "manager")).filter((o) => o.bookingId === bookingId);
const owedRow = async (bookingId: number, cause?: string) => {
  const rows = (await owedOf(bookingId)).filter((o) => !cause || o.cause === cause);
  if (rows.length === 0) throw new Error("no owed row");
  return rows[0];
};
const allOwedRows = async (bookingId: number) =>
  (await db().prepare("SELECT id, cause, amount::float AS amount, via, settled_at, outcome FROM counter_refunds_owed WHERE booking_id = ? ORDER BY id").all(bookingId)) as {
    id: number;
    cause: string;
    amount: number;
    via: string | null;
    settled_at: string | null;
    outcome: string | null;
  }[];

type Till = { journal: number; notesNotCash: number; handed: number; expected: number };
/** One day's cash-up reduced to numbers per till, the day's still-owed total and what the old rule would have shown. */
async function day(v: number, d: string, staff: number | null = null) {
  await flushPaid();
  const up = await cashUp(v, d, staff);
  const t: Record<string, Till> = {};
  for (const e of up.expected) t[e.method] = { journal: e.journalNet, notesNotCash: e.refundNotes, handed: e.handedBack, expected: e.expected };
  return { up, t, expected: (m: string) => up.expected.find((e) => e.method === m)?.expected ?? 0, owed: up.refunds?.owedTotal ?? 0 };
}
function trace(name: string, rows: { day: string; up: CashUp }[]) {
  if (!process.env.TRACE) return;
  const out = rows.map((r) => ({
    day: r.day,
    journal: Object.fromEntries(r.up.byMethod.filter((m) => m.method).map((m) => [m.method, m.net])),
    expected: Object.fromEntries(r.up.expected.map((e) => [e.method, e.expected])),
    handedBack: Object.fromEntries((r.up.refunds?.handedByMethod ?? []).map((m) => [m.method, m.amount])),
    stillOwed: r.up.refunds?.owedTotal ?? null,
  }));
  console.log(`TRACE ${name}\n${JSON.stringify(out)}`);
}
const sum = (rows: Record<string, number>[], m: string) => Math.round(rows.reduce((s, r) => s + (r[m] ?? 0), 0) * 100) / 100;

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const make = async (name: string, ph: string) => {
    const v = await createVenue({ name, area: "Ipoh", address: "x", phone: ph, openMin: 7 * 60, closeMin: 23 * 60 });
    if (!v.ok) throw new Error("venue");
    await getDb().prepare("UPDATE venues SET published_at = datetime('now') WHERE id = ?").run(v.venue.id);
    return v.venue.id;
  };
  const court = async (venue: number, name: string, rate: number) => {
    const c = await createCourt({ venueId: venue, name, sport: "badminton", offPeakRate: rate, peakRate: rate, capacity: 1 });
    if (!c.ok) throw new Error(c.error);
    return c.court.id;
  };
  venueId = await make("Cash Hall", "0355550301");
  lateVenueId = await make("Cash Late Hall", "0355550302");
  depositVenueId = await make("Cash Deposit Hall", "0355550303");
  flat = await court(venueId, "Flat", 20);
  dear = await court(venueId, "Dear", 60);
  cheap = await court(venueId, "Cheap", 25);
  lateCourt = await court(lateVenueId, "Late", 20);
  depositCourt = await court(depositVenueId, "Deposit", 60);
  expect((await updateVenue(lateVenueId, { cancelCutoffHours: 72 })).ok).toBe(true);
  expect((await setCancelPolicy(lateVenueId, { lateKeep: 25 })).ok).toBe(true);
  const saved = await savePaymentSettings(depositVenueId, { apiKey: "api-key-9012", collectionId: "col789", xSignatureKey: "S-key3", sandbox: true, enabled: true });
  if (!saved.ok) throw new Error(saved.error);
  await setHoldPolicy(depositVenueId, { on: true, depositPercent: 50 });
  const m = await createAdmin({ name: "Mona Manager", email: "mona@cash.test", password: "a long enough password", venueId, role: "manager" });
  const d = await createAdmin({ name: "Dani Desk", email: "dani@cash.test", password: "a long enough password", venueId, role: "desk" });
  const o = await createAdmin({ name: "Olli Desk", email: "olli@cash.test", password: "a long enough password", venueId, role: "desk" });
  if (!m.ok || !d.ok || !o.ok) throw new Error("staff");
  manager = { id: m.admin.id, name: m.admin.name, role: "manager" };
  desk = { id: d.admin.id, name: d.admin.name, role: "desk" };
  otherDesk = { id: o.admin.id, name: o.admin.name, role: "desk" };
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(m.admin.id)).token}`;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  // An obligation left open by one scenario would show as still owed on every later scenario's days: each starts clean.
  await getDb().prepare("DELETE FROM counter_refunds_owed WHERE settled_at IS NULL").run();
  await getDb().prepare("DELETE FROM counter_fee_refunds_owed WHERE settled_at IS NULL").run();
});

describe("the owner's example: the customer cancels on D, staff hand the money back on D+1", () => {
  it("cash: the till keeps the cash on D (still owed), loses it on D+1; the credit note stays in the journal on D", async () => {
    const { P, D, E } = days();
    const b = await paidAtCounter({}, "cash");
    await whenPaid(b.booking.id, P);
    expect((await cancelBooking(b.booking.code, b.phone)).ok).toBe(true);
    await whenNote(`booking:${b.booking.id}`, D);
    await whenOwed(b.booking.id, D);
    const owed = await owedRow(b.booking.id);
    expect(await settleOwed(owed.id, "back", desk)).toMatchObject({ ok: true });
    await whenHanded(b.booking.id, E);
    for (const p of await payoutsOf(b.booking.id)) await whenPaidOut(p.id, E);

    const [dp, dd, de] = [await day(venueId, P), await day(venueId, D), await day(venueId, E)];
    trace("cash, cancel D, paid out D+1", [
      { day: P, up: dp.up },
      { day: D, up: dd.up },
      { day: E, up: de.up },
    ]);
    // Received on P.
    expect(dp.expected("cash")).toBe(20);
    expect(dp.owed).toBe(0);
    // Cancelled on D: the credit note is in the journal (the record), and is not cash leaving the till.
    expect(dd.up.byMethod.find((m) => m.method === "cash")).toMatchObject({ taken: 0, givenBack: 20, net: -20 });
    expect(dd.up.entries.map((e) => e.type)).toEqual(["Credit note"]);
    expect(dd.expected("cash")).toBe(0);
    expect(dd.t.cash).toMatchObject({ journal: -20, notesNotCash: 20, handed: 0 });
    // RM20 is owed back at the end of D, on the cash it was paid with, and nothing says it has been paid.
    expect(dd.owed).toBe(20);
    expect(dd.up.refunds.owed).toMatchObject([{ reference: b.booking.code, amount: 20, method: "cash", kind: "booking", customerCancelled: true }]);
    expect(dd.up.refunds.handed).toEqual([]);
    // Handed back on E: the cash leaves the till that day; the credit note is not on that day at all.
    expect(de.up.entries).toEqual([]);
    expect(de.expected("cash")).toBe(-20);
    expect(de.owed).toBe(0);
    expect(de.up.refunds.handed).toMatchObject([{ reference: b.booking.code, amount: 20, method: "cash", paidWith: "cash", countedAs: "payout", staffName: "Dani Desk" }]);
    // Over the three days the till is exactly what it was: only the day each figure falls on moved.
    expect(sum([dp, dd, de].map((x) => ({ c: x.expected("cash") })), "c")).toBe(0);
  });

  it("paid by DuitNow (QR), refunded in cash by agreement: the QR account keeps the money, the cash drawer pays it", async () => {
    const { P, D, E } = days();
    const b = await paidAtCounter({}, "qr");
    await whenPaid(b.booking.id, P);
    expect((await cancelBooking(b.booking.code, b.phone)).ok).toBe(true);
    await whenNote(`booking:${b.booking.id}`, D);
    await whenOwed(b.booking.id, D);
    const owed = await owedRow(b.booking.id);
    expect(await settleOwed(owed.id, "back", desk, { via: "cash" })).toMatchObject({ ok: true, settled: { paidOut: { amount: 20, via: "cash" } } });
    await whenHanded(b.booking.id, E);
    for (const p of await payoutsOf(b.booking.id)) await whenPaidOut(p.id, E);

    const [dp, dd, de] = [await day(venueId, P), await day(venueId, D), await day(venueId, E)];
    trace("QR paid, cash refund D+1", [
      { day: P, up: dp.up },
      { day: D, up: dd.up },
      { day: E, up: de.up },
    ]);
    expect(dp.expected("qr")).toBe(20);
    // D: nothing leaves either till; owed on the way it was paid.
    expect(dd.expected("qr")).toBe(0);
    expect(dd.expected("cash")).toBe(0);
    expect(dd.up.refunds.owed).toMatchObject([{ amount: 20, method: "qr" }]);
    // E: the cash drawer paid it; the QR till has nothing on that day. The payout says both methods.
    expect(de.expected("cash")).toBe(-20);
    expect(de.expected("qr")).toBe(0);
    expect(de.up.refunds.handed).toMatchObject([{ amount: 20, method: "cash", paidWith: "qr", countedAs: "payout" }]);
    // The QR account was paid RM20 and never paid it back, the drawer paid RM20 it never took.
    expect(sum([dp, dd, de].map((x) => ({ q: x.expected("qr") })), "q")).toBe(20);
    expect(sum([dp, dd, de].map((x) => ({ c: x.expected("cash") })), "c")).toBe(-20);
  });

  it("a partial refund (the venue keeps its late share): the till gives back only what was owed, on the day it was handed over", async () => {
    const { P, D, E } = days();
    const s = slot();
    const ph = phone();
    const made = await createBooking({ courtId: lateCourt, date: addDays(today(), 1), hours: [s.hour], name: "Mei", phone: ph, email: "mei@cash.test" });
    if (!made.ok) throw new Error(JSON.stringify(made));
    expect((await setPaymentStatus(made.booking.code, true, "cash")).ok).toBe(true);
    await whenPaid(made.booking.id, P);
    expect(await cancelBooking(made.booking.code, ph)).toMatchObject({ ok: true, kept: 5 });
    await whenNote(`booking:${made.booking.id}`, D);
    await whenOwed(made.booking.id, D);
    const owed = await owedRow(made.booking.id);
    expect(owed.amount).toBe(15);
    expect(await settleOwed(owed.id, "back", manager)).toMatchObject({ ok: true });
    await whenHanded(made.booking.id, E);
    for (const p of await payoutsOf(made.booking.id)) await whenPaidOut(p.id, E);

    const [dp, dd, de] = [await day(lateVenueId, P), await day(lateVenueId, D), await day(lateVenueId, E)];
    trace("partial refund (late share)", [
      { day: P, up: dp.up },
      { day: D, up: dd.up },
      { day: E, up: de.up },
    ]);
    expect(dp.expected("cash")).toBe(20);
    expect(dd.expected("cash")).toBe(0);
    expect(dd.owed).toBe(15);
    expect(de.expected("cash")).toBe(-15);
    // The RM5 the venue keeps stays in the till for good.
    expect(sum([dp, dd, de].map((x) => ({ c: x.expected("cash") })), "c")).toBe(5);
  });

  it("a deposit paid online and the rest in cash: only the cash part is owed at the till", async () => {
    const { P, D, E } = days();
    const ph = phone();
    const made = await createBooking({ courtId: depositCourt, date: addDays(today(), 4), hours: [9], name: "Aina", phone: ph, email: "dep@cash.test" });
    if (!made.ok) throw new Error(JSON.stringify(made));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const id = `cashbill${++n}`;
        return Response.json({ id, url: `https://www.billplz-sandbox.com/bills/${id}` });
      })
    );
    const started = await startBookingPayment({ codes: [made.booking.code], phone: ph, deposit: true });
    if (!started.ok) throw new Error(JSON.stringify(started));
    const bill = (await db().prepare("SELECT bill_id FROM online_payments ORDER BY id DESC LIMIT 1").get()) as { bill_id: string };
    await settleBill({ billId: bill.bill_id, paid: true, paidAt: null });
    expect((await setPaymentStatus(made.booking.code, true, "cash")).ok).toBe(true);
    await whenPaid(made.booking.id, P);
    expect((await cancelBooking(made.booking.code, ph)).ok).toBe(true);
    await whenNote(`booking:${made.booking.id}`, D);
    await whenOwed(made.booking.id, D);
    const owed = await owedRow(made.booking.id);
    expect(owed.amount).toBe(30);
    expect(await settleOwed(owed.id, "back", manager)).toMatchObject({ ok: true });
    await whenHanded(made.booking.id, E);
    for (const p of await payoutsOf(made.booking.id)) await whenPaidOut(p.id, E);

    const [dp, dd, de] = [await day(depositVenueId, P), await day(depositVenueId, D), await day(depositVenueId, E)];
    trace("deposit online + cash rest", [
      { day: P, up: dp.up },
      { day: D, up: dd.up },
      { day: E, up: de.up },
    ]);
    const cash = [dp, dd, de].map((x) => ({ c: x.expected("cash") }));
    // Whatever the journal calls the cash part, the cash drawer takes it in once and pays out exactly RM30 once.
    expect(de.expected("cash")).toBe(-30);
    expect(dd.owed).toBe(30);
    expect(sum(cash, "c")).toBe(sum([{ c: dp.expected("cash") }], "c") - 30);
    expect(dd.expected("cash")).toBe(0);
  });

  it("moved cheaper and then cancelled: two obligations, each leaves the till on the day it is handed over, none twice", async () => {
    const { P, D, E, F } = days();
    const b = await paidAtCounter({ court: dear }, "cash");
    await whenPaid(b.booking.id, P);
    expect(await rescheduleBooking(b.booking.code, { date: b.date, start: b.hour * 60, courtId: cheap }, "customer")).toMatchObject({ ok: true });
    expect((await cancelBooking(b.booking.code, b.phone)).ok).toBe(true);
    await whenNote(`booking:${b.booking.id}`, D);
    await whenOwed(b.booking.id, D);
    const rows = await allOwedRows(b.booking.id);
    expect(rows.map((r) => [r.cause, r.amount])).toEqual([
      ["moved_cheaper", 35],
      ["customer_cancelled", 25],
    ]);
    // The move's difference is handed back on E (its credit note is written then), the cancellation's on F.
    expect(await settleOwed(rows[0].id, "back", manager)).toMatchObject({ ok: true });
    await whenHanded(b.booking.id, E, "moved_cheaper");
    const moveNote = (await db().prepare("SELECT source FROM receipts WHERE kind = 'credit_note' AND source LIKE ?").all(`booking:${b.booking.id}:move:%`)) as { source: string }[];
    expect(moveNote).toHaveLength(1);
    await whenNote(moveNote[0].source, E);
    expect(await settleOwed(rows[1].id, "back", manager)).toMatchObject({ ok: true });
    await whenHanded(b.booking.id, F, "customer_cancelled");
    const ps = await payoutsOf(b.booking.id);
    expect(ps.map((p) => p.amount)).toEqual([35, 25]);
    await whenPaidOut(ps[0].id, E);
    await whenPaidOut(ps[1].id, F);

    const [dp, dd, de, df] = [await day(venueId, P), await day(venueId, D), await day(venueId, E), await day(venueId, F)];
    trace("cheaper move then cancel", [
      { day: P, up: dp.up },
      { day: D, up: dd.up },
      { day: E, up: de.up },
      { day: F, up: df.up },
    ]);
    expect(dp.expected("cash")).toBe(60);
    expect(dd.expected("cash")).toBe(0);
    expect(dd.owed).toBe(60);
    expect(de.expected("cash")).toBe(-35);
    expect(de.owed).toBe(25);
    expect(df.expected("cash")).toBe(-25);
    expect(df.owed).toBe(0);
    expect(sum([dp, dd, de, df].map((x) => ({ c: x.expected("cash") })), "c")).toBe(0);
  });
});

describe("one refund is never taken out of the till twice", () => {
  it("settled twice (and at the same moment): one payout, one subtraction", async () => {
    const { P, D, E } = days();
    const b = await paidAtCounter({}, "cash");
    await whenPaid(b.booking.id, P);
    await cancelBooking(b.booking.code, b.phone);
    await whenNote(`booking:${b.booking.id}`, D);
    await whenOwed(b.booking.id, D);
    const owed = await owedRow(b.booking.id);
    const both = await Promise.all([settleOwed(owed.id, "back", desk), settleOwed(owed.id, "back", manager)]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(await settleOwed(owed.id, "back", desk)).toMatchObject({ ok: false });
    await whenHanded(b.booking.id, E);
    for (const p of await payoutsOf(b.booking.id)) await whenPaidOut(p.id, E);
    expect(await payoutsOf(b.booking.id)).toHaveLength(1);
    expect((await day(venueId, D)).expected("cash")).toBe(0);
    expect((await day(venueId, E)).expected("cash")).toBe(-20);
  });

  it("staff cancelling at the counter (credit note and payout the same moment): RM20 out, not RM40", async () => {
    const { P, D } = days();
    const b = await paidAtCounter({}, "cash");
    await whenPaid(b.booking.id, P);
    const done = await asStaff({ id: desk.id!, name: desk.name }, () => staffCancel(b.booking.code, desk));
    expect(done.result.ok).toBe(true);
    await whenNote(`booking:${b.booking.id}`, D);
    for (const p of await payoutsOf(b.booking.id)) await whenPaidOut(p.id, D);
    const dd = await day(venueId, D);
    expect(dd.expected("cash")).toBe(-20);
    expect(dd.up.refunds.handed).toMatchObject([{ reference: b.booking.code, amount: 20, countedAs: "payout" }]);
    expect(dd.up.refunds.owed).toEqual([]);
    expect(dd.t.cash).toMatchObject({ journal: -20, notesNotCash: 20, handed: 20 });
    // The desk's own till has the same, by who gave it back.
    expect((await day(venueId, D, desk.id)).expected("cash")).toBe(-20);
    expect((await day(venueId, D, otherDesk.id)).expected("cash")).toBe(0);
  });

  it("the venue's own cancellation (closure): owed with no credit note; when settled the note and the payout come the same day and count once", async () => {
    const { P, D, E } = days();
    const b = await paidAtCounter({}, "cash");
    await whenPaid(b.booking.id, P);
    expect((await venueCancel(b.booking.code, "closure")).ok).toBe(true);
    await whenOwed(b.booking.id, D);
    const dd = await day(venueId, D);
    // No credit note yet: nothing in the journal, nothing out of the till, RM20 still owed.
    expect(dd.up.entries).toEqual([]);
    expect(dd.expected("cash")).toBe(0);
    expect(dd.up.refunds.owed).toMatchObject([{ amount: 20, method: "cash", customerCancelled: false }]);
    const owed = await owedRow(b.booking.id);
    expect(await settleOwed(owed.id, "back", manager)).toMatchObject({ ok: true });
    await whenHanded(b.booking.id, E);
    await whenNote(`booking:${b.booking.id}`, E);
    for (const p of await payoutsOf(b.booking.id)) await whenPaidOut(p.id, E);
    const de = await day(venueId, E);
    trace("venue closure settled E", [
      { day: D, up: dd.up },
      { day: E, up: de.up },
    ]);
    expect(de.expected("cash")).toBe(-20);
    expect(de.owed).toBe(0);
  });

  it("settled as stored credit (the customer agreed): the cash never leaves the till, on any day", async () => {
    const { P, D, E } = days();
    const made = await registerUser({ name: "Cleo", email: "cleo@cash.test", phone: phone(), password: "a long enough password" });
    if (!made.ok) throw new Error(made.error);
    await createSession(made.user.id);
    const b = await paidAtCounter({ userId: made.user.id }, "cash");
    await whenPaid(b.booking.id, P);
    expect((await cancelUserBooking(made.user.id, b.booking.id)).ok).toBe(true);
    await whenNote(`booking:${b.booking.id}`, D);
    await whenOwed(b.booking.id, D);
    const owed = await owedRow(b.booking.id);
    expect(await settleOwed(owed.id, "credit", desk)).toMatchObject({ ok: true });
    await whenHanded(b.booking.id, E);
    expect(await payoutsOf(b.booking.id)).toEqual([]);
    const [dp, dd, de] = [await day(venueId, P), await day(venueId, D), await day(venueId, E)];
    expect(dp.expected("cash")).toBe(20);
    expect(dd.expected("cash")).toBe(0);
    expect(dd.owed).toBe(20);
    expect(de.expected("cash")).toBe(0);
    expect(de.owed).toBe(0);
    expect(de.up.refunds.handed).toEqual([]);
  });
});

describe("a tournament entry fee and a pass handed back on another day", () => {
  it("a pass voided with a refund on D (credit note then), handed over on D+1: still owed on D, out of the till on D+1", async () => {
    const { D, E } = days();
    const pass = await issuePass({ venueId, name: "Ten", entries: 10, price: 100, holderName: "Aisyah", holderPhone: phone(), expiresOn: addDays(today(), 60), adminId: null, paidVia: "Cash" });
    if (!pass.ok) throw new Error(JSON.stringify(pass));
    await db().prepare("UPDATE receipts SET issued_at = ? WHERE kind = 'receipt' AND source LIKE ?").run(local(addDays(D, -1)), `pass:${pass.pass.id}%`);
    expect((await voidPass(pass.pass.id, { refund: true })).ok).toBe(true);
    const row = (await db().prepare("SELECT id, credit_note_id FROM counter_fee_refunds_owed WHERE pass_id = ?").get(pass.pass.id)) as { id: number; credit_note_id: number };
    await db().prepare("UPDATE receipts SET issued_at = ? WHERE id = ?").run(local(D), row.credit_note_id);
    await db().prepare("UPDATE counter_fee_refunds_owed SET owed_since = ?::timestamptz WHERE id = ?").run(noon(D), row.id);
    expect(await settleEntryFee(row.id, manager as { id: number; name: string; role: "manager" })).toMatchObject({ ok: true });
    await db().prepare("UPDATE counter_fee_refunds_owed SET settled_at = ?::timestamptz WHERE id = ?").run(noon(E), row.id);
    const [dd, de] = [await day(venueId, D), await day(venueId, E)];
    trace("pass refund", [
      { day: D, up: dd.up },
      { day: E, up: de.up },
    ]);
    expect(dd.up.entries.some((e) => e.type === "Credit note" && e.gross === -100)).toBe(true);
    expect(dd.expected("cash")).toBe(0);
    expect(dd.up.refunds.owed).toMatchObject([{ kind: "pass", amount: 100, method: "cash" }]);
    expect(de.expected("cash")).toBe(-100);
    expect(de.up.refunds.handed).toMatchObject([{ kind: "pass", amount: 100, method: "cash", countedAs: "payout" }]);
    expect(de.owed).toBe(0);
  });
});

describe("rows from before the newer fields: read as they always were, never double counted", () => {
  it("a customer cancellation from before the obligation existed (no owed row, no payout): its credit note leaves the till on its day, as it did", async () => {
    const { P, D } = days();
    const b = await paidAtCounter({}, "cash");
    await whenPaid(b.booking.id, P);
    expect((await cancelBooking(b.booking.code, b.phone)).ok).toBe(true);
    await db().prepare("DELETE FROM counter_refunds_owed WHERE booking_id = ?").run(b.booking.id);
    await whenNote(`booking:${b.booking.id}`, D);
    const dd = await day(venueId, D);
    expect(dd.expected("cash")).toBe(-20);
    expect(dd.up.refunds.owed).toEqual([]);
    expect(dd.t.cash).toMatchObject({ journal: -20, notesNotCash: 0, handed: 0 });
  });

  it("a payout that names no credit note (written before the link): counted by its credit note as before, listed, never subtracted a second time", async () => {
    const { P, D } = days();
    const b = await paidAtCounter({}, "cash");
    await whenPaid(b.booking.id, P);
    expect((await staffCancel(b.booking.code, desk)).result.ok).toBe(true);
    await whenNote(`booking:${b.booking.id}`, D);
    await db().prepare("UPDATE counter_payouts SET credit_note_id = NULL WHERE booking_id = ?").run(b.booking.id);
    for (const p of await payoutsOf(b.booking.id)) await whenPaidOut(p.id, D);
    const dd = await day(venueId, D);
    expect(dd.expected("cash")).toBe(-20);
    expect(dd.up.refunds.handed).toMatchObject([{ reference: b.booking.code, amount: 20, countedAs: "credit note" }]);
  });

  it("a booking whose tick never recorded a method: its refund is in no till, as before (not recorded is never cash)", async () => {
    const { P, D, E } = days();
    const b = await paidAtCounter({}, null);
    await whenPaid(b.booking.id, P);
    expect((await cancelBooking(b.booking.code, b.phone)).ok).toBe(true);
    await whenNote(`booking:${b.booking.id}`, D);
    await whenOwed(b.booking.id, D);
    const dd = await day(venueId, D);
    expect(dd.expected("cash")).toBe(0);
    expect(dd.up.refunds.owed).toMatchObject([{ amount: 20, method: null }]);
    const owed = await owedRow(b.booking.id);
    expect(await settleOwed(owed.id, "back", manager)).toMatchObject({ ok: true });
    await whenHanded(b.booking.id, E);
    for (const p of await payoutsOf(b.booking.id)) await whenPaidOut(p.id, E);
    const de = await day(venueId, E);
    expect(de.up.expected.every((e) => e.expected === 0)).toBe(true);
    expect(de.up.refunds.handed).toMatchObject([{ amount: 20, method: null }]);
  });
});

describe("who sees it, and the screen's route", () => {
  it("a desk's own till has the payouts it handed over (and the credit note, which names nobody, is not in it); a manager sees everyone's", async () => {
    const { P, D, E } = days();
    const b = await paidAtCounter({}, "cash");
    await whenPaid(b.booking.id, P);
    await cancelBooking(b.booking.code, b.phone);
    await whenNote(`booking:${b.booking.id}`, D);
    await whenOwed(b.booking.id, D);
    const owed = await owedRow(b.booking.id);
    expect(await settleOwed(owed.id, "back", desk)).toMatchObject({ ok: true });
    await whenHanded(b.booking.id, E);
    for (const p of await payoutsOf(b.booking.id)) await whenPaidOut(p.id, E);
    expect((await day(venueId, E, desk.id)).expected("cash")).toBe(-20);
    expect((await day(venueId, E, otherDesk.id)).expected("cash")).toBe(0);
    expect((await day(venueId, E, null)).expected("cash")).toBe(-20);
    // The customer's credit note has no member of staff on it: not in a desk's own till, so nothing is added back there either.
    expect((await day(venueId, D, desk.id)).expected("cash")).toBe(0);
    expect((await day(venueId, D, null)).expected("cash")).toBe(0);
    // The day's route returns the same, for a manager of the venue.
    const res = await cashUpGet(new NextRequest(`http://localhost/api/admin/cash-up?venueId=${venueId}&date=${E}`, { headers: { cookie: managerCookie } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as CashUp;
    expect(body.expected.find((e) => e.method === "cash")).toMatchObject({ handedBack: 20, expected: -20 });
    expect(body.refunds.handed).toMatchObject([{ reference: b.booking.code, amount: 20 }]);
    const asked = await cashUpAs({ id: manager.id!, role: "manager" }, venueId, { date: D });
    expect(asked.ok && asked.cashUp.refunds.owedTotal).toBe(20);
  });

  it("another venue's cash-up has none of it", async () => {
    const { P, D, E } = days();
    const b = await paidAtCounter({}, "cash");
    await whenPaid(b.booking.id, P);
    await cancelBooking(b.booking.code, b.phone);
    await whenNote(`booking:${b.booking.id}`, D);
    await whenOwed(b.booking.id, D);
    const other = await day(lateVenueId, D);
    expect(other.up.refunds.owed).toEqual([]);
    expect(other.owed).toBe(0);
    expect((await day(lateVenueId, E)).up.refunds.handed).toEqual([]);
  });

  it("the count saved against the day is worked out from the new expected amount", async () => {
    const { P, D } = days();
    const b = await paidAtCounter({}, "cash");
    await whenPaid(b.booking.id, P);
    await cancelBooking(b.booking.code, b.phone);
    await whenNote(`booking:${b.booking.id}`, D);
    await whenOwed(b.booking.id, D);
    await flushPaid();
    const up = await cashUp(venueId, D, null);
    expect(up.expected.find((e) => e.method === "cash")!.expected).toBe(0);
  });
});

describe("the review table for earlier cancellations (read only)", () => {
  const script = fs.readFileSync(path.join(__dirname, "..", "scripts", "reconcile-counter-cancellations.sql"), "utf8");
  const rows = async () => (await db().prepare(script).all()) as Record<string, unknown>[];

  it("lists, per booking: code, venue, cancellation date, amount, original method, payout evidence, possible duplicate and the action; no name or phone", async () => {
    const { P, D } = days();
    const legacy = await paidAtCounter({}, "qr");
    await whenPaid(legacy.booking.id, P);
    await cancelBooking(legacy.booking.code, legacy.phone);
    await db().prepare("DELETE FROM counter_refunds_owed WHERE booking_id = ?").run(legacy.booking.id);
    await whenNote(`booking:${legacy.booking.id}`, D);
    const found = (await rows()).find((r) => r.booking_code === legacy.booking.code)!;
    expect(found).toMatchObject({
      venue: "Cash Hall",
      booking_code: legacy.booking.code,
      cancelled_on: D,
      amount_possibly_owed: 20,
      paid_with: "qr",
      payout_evidence: "none found",
      possible_duplicate: "no",
      credit_note: expect.stringMatching(/^CN-/),
    });
    expect(String(found.staff_action)).toMatch(/hand|asked|ask/i);
    expect(Object.keys(found).sort()).toEqual(
      // `what` (ADR 0078): a whole cancellation or a person taken off, since the table lists withdrawals' credit notes too.
      ["amount_possibly_owed", "booking_code", "cancelled_on", "credit_note", "paid_with", "payout_evidence", "possible_duplicate", "staff_action", "venue", "what"].sort()
    );
  });

  it("is read only; leaves out what is already an obligation or a payout; flags other credit notes and a logged payout as evidence", async () => {
    const { P, D } = days();
    // Cancelled by the customer with the obligation already written: not a candidate.
    const owedNow = await paidAtCounter({}, "cash");
    await whenPaid(owedNow.booking.id, P);
    await cancelBooking(owedNow.booking.code, owedNow.phone);
    // Handed back by a payout: not a candidate.
    const handed = await paidAtCounter({}, "cash");
    await cancelBooking(handed.booking.code, handed.phone);
    await db().prepare("DELETE FROM counter_refunds_owed WHERE booking_id = ?").run(handed.booking.id);
    await db().prepare("INSERT INTO counter_payouts (venue_id, booking_id, amount, via, admin_name) VALUES (?, ?, 20, 'cash', 'Dani Desk')").run(venueId, handed.booking.id);
    // From before the obligation existed, after a move to a cheaper time whose difference was credited then: the other credit note is evidence.
    const moved = await paidAtCounter({ court: dear }, "cash");
    await whenPaid(moved.booking.id, P);
    await rescheduleBooking(moved.booking.code, { date: moved.date, start: moved.hour * 60, courtId: cheap }, "customer");
    await cancelBooking(moved.booking.code, moved.phone);
    await db().prepare("DELETE FROM counter_refunds_owed WHERE booking_id = ?").run(moved.booking.id);
    expect(await creditBookingMove(moved.booking.id, 9001, 35)).not.toBeNull();
    await whenNote(`booking:${moved.booking.id}`, D);
    // From before the obligation existed, with a log line saying money was paid out for it (the payout row is not there): evidence.
    const logged = await paidAtCounter({}, "transfer");
    await cancelBooking(logged.booking.code, logged.phone);
    await db().prepare("DELETE FROM counter_refunds_owed WHERE booking_id = ?").run(logged.booking.id);
    await whenNote(`booking:${logged.booking.id}`, D);
    await db().prepare("INSERT INTO staff_actions (admin_name, venue_id, booking_code, action, detail) VALUES ('Dani Desk', ?, ?, 'payment.paid_out', 'RM20 handed back')").run(venueId, logged.booking.code);

    const counts = async () =>
      await db().prepare("SELECT (SELECT COUNT(*) FROM counter_refunds_owed)::int AS o, (SELECT COUNT(*) FROM counter_payouts)::int AS p, (SELECT COUNT(*) FROM receipts)::int AS r, (SELECT COUNT(*) FROM wallet_entries)::int AS w").get();
    const before = await counts();
    const out = await rows();
    expect(out.find((r) => r.booking_code === owedNow.booking.code)).toBeUndefined();
    expect(out.find((r) => r.booking_code === handed.booking.code)).toBeUndefined();
    const movedRow = out.find((r) => r.booking_code === moved.booking.code)!;
    expect(movedRow).toMatchObject({ amount_possibly_owed: 25, paid_with: "cash", payout_evidence: "none found", cancelled_on: D });
    expect(String(movedRow.possible_duplicate)).toMatch(/^yes: 1 other credit note\(s\) totalling RM35\.00$/);
    expect(String(movedRow.staff_action)).toMatch(/^Check the evidence first/);
    const loggedRow = out.find((r) => r.booking_code === logged.booking.code)!;
    expect(loggedRow).toMatchObject({ amount_possibly_owed: 20, paid_with: "transfer", payout_evidence: "activity log: payment.paid_out", possible_duplicate: "no" });
    expect(String(loggedRow.staff_action)).toMatch(/^Check the evidence first/);
    // Read only: it created no refund, no task, no payout, no credit and no note.
    expect(await counts()).toEqual(before);
  });

  it("the script is a single read-only query", () => {
    const code = script
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(code).not.toMatch(/\b(insert|update|delete|drop|alter|create|truncate)\b/i);
    expect(/^\s*(select|with)\b/i.test(code)).toBe(true);
    expect(code).not.toMatch(/\b(phone|b\.name|customer_name|email)\b/i);
  });
});
