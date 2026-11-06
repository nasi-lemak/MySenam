import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { listActivity } from "../src/lib/activity";
import { createApiKey } from "../src/lib/api-keys";
import {
  apply,
  customerAct,
  decide,
  expireApprovals,
  linkCoachAccount,
  recoverLatePayments,
  requestById,
  saveRequirement,
  type ApplyInput,
  type Reviewer,
} from "../src/lib/approvals";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { attachCoach, coachById, saveCoach } from "../src/lib/coaching";
import { getDb } from "../src/lib/db";
import { releaseExpiredHolds, setHoldPolicy } from "../src/lib/holds";
import { refundsOwed, savePaymentSettings, settleBill, startBookingPayment } from "../src/lib/payments";
import { createResources } from "../src/lib/resources";
import { signOffHolds } from "../src/lib/sign-offs";
import { accessCodeFor, adminCancelBooking, createBooking, createBookingSeries, createVenue, findBooking, recordInduction, setPaymentStatus, updateCourt, updateVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import * as adminRoute from "../src/app/api/admin/approvals/route";
import * as reviewersRoute from "../src/app/api/admin/approvals/reviewers/route";
import * as supervisedRoute from "../src/app/api/admin/approvals/supervised/route";
import * as signOffsRoute from "../src/app/api/admin/sign-offs/route";
import * as bookingsRoute from "../src/app/api/bookings/route";
import * as reviewsRoute from "../src/app/api/my/reviews/route";
import * as v1Route from "../src/app/api/v1/bookings/route";

/**
 * The approval workflow as the owner decided it (ADR 0020;
 * docs/features/activities.md#registering-online-for-approval):
 *
 * - approval establishes eligibility, never payment: at a venue asking
 *   payment to hold, the booking made on approval is held by the ordinary
 *   booking hold and confirmed only when paid; a late payment becomes the
 *   booking if the slot is still free, or stays owed back;
 * - no path gives a door code to somebody whose approval is pending,
 *   refused, lapsed or revoked, whoever made the booking; supervised
 *   attendance is never a door code;
 * - a safety assessment is granted only by those authorised for it; a coach
 *   decides only signed in to their own account;
 * - revoking stops future access and online booking, and flags the person's
 *   bookings for staff instead of cancelling them.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (n: number) => addDays(todayISO(ZONE), n);
const at = (h: number) => h * 60;
let n = 0;
const phone = () => `0179${String(++n).padStart(6, "0")}`;

let payVenue: number;
let lanePay: number;
let doorVenue: number;
let doorLane: number;
let manager: Staff;
let desk: Staff;
let delegated: Staff;
let doorManager: Staff;
let doorDesk: Staff;

type Staff = { id: number; name: string; cookie: string };
const staff = (s: { id: number; name: string }): Reviewer => ({ kind: "staff", admin: s });

async function customer() {
  const made = await registerUser({ name: `Archer ${++n}`, email: `wf${n}@wf.test`, phone: phone(), password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now') WHERE id = ?").run(made.user.id);
  return { ...made.user, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}
type Customer = Awaited<ReturnType<typeof customer>>;

async function staffMember(venueId: number, name: string, role: "manager" | "desk" = "manager"): Promise<Staff> {
  const made = await createAdmin({ name, email: `${name.toLowerCase().replace(/\W/g, "")}${++n}@wf.test`, password: "a long enough password", venueId, role });
  if (!made.ok) throw new Error(made.error);
  return { id: made.admin.id, name, cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}` };
}

const req = (url: string, method: string, cookie: string | null, body?: unknown, extra: Record<string, string> = {}) =>
  new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.88.${++n % 250}.${n % 200}`, ...(cookie ? { cookie } : {}), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const archery = (venueId: number, extra: Partial<ApplyInput> = {}): ApplyInput => ({ venueId, sport: "archery", declaration: true, adult: true, ...extra });

async function applied(user: Customer, input: ApplyInput) {
  const made = await apply(user, input);
  if (!made.ok) throw new Error(`${made.code}: ${made.error}`);
  return made.request;
}

function fakeBillplz() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const id = `wfbill${++n}`;
      return Response.json({ id, url: `https://www.billplz-sandbox.com/bills/${id}` });
    })
  );
}

/** Open the payment page for a booking, as the customer does: the bill it made. */
async function startPay(code: string, ph: string): Promise<{ id: number; bill_id: string }> {
  fakeBillplz();
  const started = await startBookingPayment({ codes: [code], phone: ph });
  vi.unstubAllGlobals();
  if (!started.ok) throw new Error(started.error);
  return (await getDb()
    .prepare(
      `SELECT p.id, p.bill_id FROM online_payments p JOIN online_payment_bookings pb ON pb.payment_id = p.id
         JOIN bookings b ON b.id = pb.booking_id WHERE b.code = ? ORDER BY p.id DESC LIMIT 1`
    )
    .get(code)) as { id: number; bill_id: string };
}
const settle = (billId: string) => settleBill({ billId, paid: true, paidAt: null });

const payment = async (id: number) =>
  (await getDb().prepare("SELECT status, amount::float AS amount, refund_due::float AS refund_due, refunded::float AS refunded FROM online_payments WHERE id = ?").get(id)) as {
    status: string;
    amount: number;
    refund_due: number;
    refunded: number;
  };

/** Confirmed bookings on a slot, whoever holds them. */
const onSlot = async (courtId: number, date: string, start: number) =>
  ((await getDb()
    .prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE court_id = ? AND date = ? AND start_min = ? AND status = 'confirmed'")
    .get(courtId, date, start)) as { n: number }).n;

const kinds = async (bookingId: number) =>
  ((await getDb().prepare("SELECT kind FROM messages WHERE booking_id = ?").all(bookingId)) as { kind: string }[]).map((m) => m.kind);

const lastMail = async (email: string) =>
  (await getDb().prepare("SELECT subject, body FROM messages WHERE recipient = ? ORDER BY id DESC LIMIT 1").get(email)) as { subject: string; body: string };

const holdPast = (bookingId: number) => getDb().prepare("UPDATE bookings SET hold_until = datetime('now', '-1 minutes') WHERE id = ?").run(bookingId);

/** Applied with a slot at the pay-to-hold venue, and approved by its manager. */
async function approvedWithSlot(user: Customer, date: string, start: number, opts: { payLater?: boolean } = {}) {
  const r = await applied(user, archery(payVenue, { slot: { courtId: lanePay, date, start: at(start), end: at(start + 1) } }));
  const done = await decide(staff(manager), r.id, "approve", { venueId: payVenue, payLater: opts.payLater });
  if (!done.ok) throw new Error(done.error);
  return done;
}

beforeAll(async () => {
  const venue = async (name: string, ph: string) => {
    const v = await createVenue({ name, area: "Cheras", address: "x", phone: ph, openMin: at(7), closeMin: at(23) });
    if (!v.ok) throw new Error("venue");
    return v.venue.id;
  };
  payVenue = await venue("Pay Range", "0312349201");
  doorVenue = await venue("Night Range", "0312349202");
  const lane = async (venueId: number, sport: string, name: string, also?: { sport: string }[]) => {
    const r = await createResources({ venueId, sport, name, offPeakRate: 30, peakRate: 30, capacity: 1, ...(also ? { also } : {}) });
    if (!r.ok) throw new Error(r.error);
    return r.courts[0].id;
  };
  lanePay = await lane(payVenue, "archery", "Lane P");
  doorLane = await lane(doorVenue, "archery", "Night lane");
  manager = await staffMember(payVenue, "Mona Manager");
  desk = await staffMember(payVenue, "Danny Desk", "desk");
  delegated = await staffMember(payVenue, "Dee Delegated", "desk");
  doorManager = await staffMember(doorVenue, "Nora Night");
  doorDesk = await staffMember(doorVenue, "Nick Counter", "desk");

  // The pay venue asks payment online to hold a booking.
  const saved = await savePaymentSettings(payVenue, { apiKey: "api-key-1234", collectionId: "col123", xSignatureKey: "S-key", sandbox: true, enabled: true });
  if (!saved.ok) throw new Error(saved.error);
  const held = await setHoldPolicy(payVenue, { on: true, minutes: 15 });
  if (!held.ok) throw new Error(held.error);

  for (const [venueId, input] of [
    [payVenue, { sport: "archery", declaration: "I have shot at a range before and know its whistle signals.", validDays: 365, holdHours: 24, payHours: 6, delegateIds: [delegated.id] }],
    [doorVenue, { sport: "archery", declaration: "I will follow the range officer's calls at all times.", validDays: 365 }],
  ] as const) {
    const s = await saveRequirement(venueId, input as unknown as Record<string, unknown>);
    if (!s.ok) throw new Error(s.error);
  }

  // The door venue is unstaffed at every hour; its lane has a keypad.
  const opened = await updateCourt(doorLane, { unmanned: true, accessCode: "7788" });
  if (!opened.ok) throw new Error(opened.error);
  await updateVenue(doorVenue, { staffedFrom: 0, staffedTo: 0 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------------------------- approval, then payment

describe("approval followed by payment, at a venue asking payment to hold", () => {
  it("holds the booking made on approval for payment, and confirms it only when paid", async () => {
    const me = await customer();
    const date = day(5);
    const done = await approvedWithSlot(me, date, 10);
    expect(done.request).toMatchObject({ status: "approved", slot: { status: "awaiting_payment", due: 30 } });
    const booking = done.booking!;
    // Never a confirmed unpaid booking: held by the ordinary booking hold, for the activity's payment hours.
    expect(booking.holdUntil).toBeTruthy();
    const stored = (await findBooking(booking.code, me.phone))!;
    expect(stored).toMatchObject({ status: "confirmed", paymentStatus: "unpaid" });
    expect(Date.parse(`${stored.holdUntil!.replace(" ", "T")}Z`) - Date.now()).toBeGreaterThan(5 * 3_600_000);
    expect(await kinds(booking.id)).not.toContain("booking_confirmed");
    // Eligibility is in force regardless of the payment.
    expect(await signOffHolds({ venueId: payVenue, sport: "archery", until: date, phone: me.phone, userId: me.id, channel: "customer", need: "any" })).toBe(true);
    // Told: approved, and to pay by when.
    expect((await lastMail(me.email)).body).toContain(booking.code);
    expect((await lastMail(me.email)).body).toMatch(/pay for it by/);

    const bill = await startPay(booking.code, me.phone);
    await settle(bill.bill_id);
    expect((await requestById(done.request.id))!.slot).toMatchObject({ status: "booked", payBy: null });
    expect(await findBooking(booking.code, me.phone)).toMatchObject({ paymentStatus: "paid", holdUntil: null });
    expect(await kinds(booking.id)).toContain("booking_confirmed");
    expect((await requestById(done.request.id))!.events.map((e) => e.action)).toEqual(expect.arrayContaining(["approved", "slot_booked", "payment_requested", "paid"]));
  });

  it("lets the slot go if not paid in time; the approval stands, and the customer is told", async () => {
    const me = await customer();
    const date = day(6);
    const done = await approvedWithSlot(me, date, 10);
    await holdPast(done.booking!.id);
    expect(await releaseExpiredHolds()).toBeGreaterThanOrEqual(1);
    await expireApprovals();
    const after = (await requestById(done.request.id))!;
    expect(after).toMatchObject({ status: "approved", revoked: false, slot: { status: "payment_lapsed" } });
    expect((await lastMail(me.email)).subject).toMatch(/not paid in time/);
    // Free for anybody again; and the approved customer can book another time the ordinary way.
    expect(await onSlot(lanePay, date, at(10))).toBe(0);
    expect((await createBooking({ courtId: lanePay, date: day(7), start: at(9), end: at(10), name: me.name, phone: me.phone, userId: me.id })).ok).toBe(true);
  });

  it("a payment arriving just as the hold runs out: one paid booking, nothing owed back, whichever comes first", async () => {
    const me = await customer();
    const date = day(8);
    const done = await approvedWithSlot(me, date, 10);
    const bill = await startPay(done.booking!.code, me.phone);
    await holdPast(done.booking!.id);
    await Promise.all([settle(bill.bill_id), releaseExpiredHolds()]);
    await expireApprovals();
    expect(await onSlot(lanePay, date, at(10))).toBe(1);
    const paid = (await getDb()
      .prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE court_id = ? AND date = ? AND status = 'confirmed' AND payment_status = 'paid'")
      .get(lanePay, date)) as { n: number };
    expect(paid.n).toBe(1);
    const p = await payment(bill.id);
    expect(p.refund_due).toBeCloseTo(0);
    expect((await requestById(done.request.id))!.slot).toMatchObject({ status: "booked" });
  });

  it("never lets go a held booking with a deposit paid, even before its hold is cleared", async () => {
    const me = await customer();
    const done = await approvedWithSlot(me, day(1), 20);
    // The deposit is counted and the hold not yet cleared (lib/payments.ts clears it just after): it stands.
    await getDb().prepare("UPDATE bookings SET shares_paid = 9, deposit_paid = 9 WHERE id = ?").run(done.booking!.id);
    await holdPast(done.booking!.id);
    await releaseExpiredHolds();
    expect(await findBooking(done.booking!.code, me.phone)).toMatchObject({ status: "confirmed" });
    await expireApprovals();
    expect((await requestById(done.request.id))!.slot).toMatchObject({ status: "booked" });
  });

  it("a payment after the hold was let go becomes the booking again while the slot is free; told twice, it counts once", async () => {
    const me = await customer();
    const date = day(9);
    const done = await approvedWithSlot(me, date, 10);
    const bill = await startPay(done.booking!.code, me.phone);
    await holdPast(done.booking!.id);
    await releaseExpiredHolds();
    await expireApprovals();
    expect((await requestById(done.request.id))!.slot).toMatchObject({ status: "payment_lapsed" });
    // The money lands late: a recorded, paid booking, and nothing left owed back.
    await settle(bill.bill_id);
    const after = (await requestById(done.request.id))!;
    expect(after.slot).toMatchObject({ status: "booked" });
    expect(after.bookingCode).not.toBe(done.booking!.code);
    expect(await findBooking(after.bookingCode!, me.phone)).toMatchObject({ status: "confirmed", paymentStatus: "paid" });
    expect(await payment(bill.id)).toMatchObject({ status: "paid", refund_due: 0 });
    expect(after.events.map((e) => e.action)).toContain("late_payment_booked");
    // The gateway tells us again, and the scheduler looks again: nothing changes.
    await settle(bill.bill_id);
    expect(await recoverLatePayments()).toEqual({ booked: 0, owed: 0 });
    await expireApprovals();
    expect(await onSlot(lanePay, date, at(10))).toBe(1);
    expect(await payment(bill.id)).toMatchObject({ refund_due: 0 });
  });

  it("a payment after the hold was let go and the slot taken is owed back, on record, never lost", async () => {
    const me = await customer();
    const date = day(10);
    const done = await approvedWithSlot(me, date, 10);
    const bill = await startPay(done.booking!.code, me.phone);
    await holdPast(done.booking!.id);
    await releaseExpiredHolds();
    // Somebody else, signed off, books the freed slot.
    const other = await customer();
    await getDb().prepare("INSERT INTO sign_offs (venue_id, sport, phone, name, user_id) VALUES (?, 'archery', ?, ?, ?)").run(payVenue, other.phone, other.name, other.id);
    expect((await createBooking({ courtId: lanePay, date, start: at(10), end: at(11), name: other.name, phone: other.phone, userId: other.id })).ok).toBe(true);
    await settle(bill.bill_id);
    const p = await payment(bill.id);
    expect(p.refund_due).toBeCloseTo(p.amount);
    expect((await refundsOwed(payVenue)).some((x) => x.id === bill.id)).toBe(true);
    expect(await onSlot(lanePay, date, at(10))).toBe(1);
    const after = (await requestById(done.request.id))!;
    expect(after.events.map((e) => e.action)).toContain("late_payment_refund");
    expect((await lastMail(me.email)).subject).toMatch(/owed back/);
    // Once only.
    expect(await recoverLatePayments(bill.id)).toEqual({ booked: 0, owed: 0 });
  });

  it("staff cancelling the session while the customer pays: the payment is owed back, not turned into a booking", async () => {
    const me = await customer();
    const date = day(11);
    const done = await approvedWithSlot(me, date, 10);
    const bill = await startPay(done.booking!.code, me.phone);
    expect((await adminCancelBooking(done.booking!.code)).ok).toBe(true);
    await settle(bill.bill_id);
    const p = await payment(bill.id);
    expect(p.refund_due).toBeCloseTo(p.amount);
    expect(await onSlot(lanePay, date, at(10))).toBe(0);
    expect((await requestById(done.request.id))!.slot).toMatchObject({ status: "released" });
  });

  it("an approval revoked before the booking is paid lets the booking go; a payment after is owed back", async () => {
    const me = await customer();
    const date = day(12);
    const done = await approvedWithSlot(me, date, 10);
    const bill = await startPay(done.booking!.code, me.phone);
    expect(await decide(staff(manager), done.request.id, "revoke", { venueId: payVenue, reason: "Unsafe at the line yesterday." })).toMatchObject({ ok: true });
    expect(await findBooking(done.booking!.code, me.phone)).toMatchObject({ status: "cancelled" });
    await settle(bill.bill_id);
    expect((await payment(bill.id)).refund_due).toBeCloseTo((await payment(bill.id)).amount);
    expect(await onSlot(lanePay, date, at(10))).toBe(0);
  });

  it("recovers a payment whose processing stopped part-way, on the scheduler's tick", async () => {
    const me = await customer();
    const date = day(13);
    const done = await approvedWithSlot(me, date, 10);
    const bill = await startPay(done.booking!.code, me.phone);
    await holdPast(done.booking!.id);
    await releaseExpiredHolds();
    // The payment was recorded and owed back, and the app stopped before turning it into the booking.
    await getDb().prepare("UPDATE online_payments SET status = 'paid', paid_at = datetime('now'), refund_due = amount WHERE id = ?").run(bill.id);
    await expireApprovals();
    expect((await requestById(done.request.id))!.slot).toMatchObject({ status: "booked" });
    expect(await payment(bill.id)).toMatchObject({ refund_due: 0 });
    expect(await onSlot(lanePay, date, at(10))).toBe(1);
  });

  it("an approval interrupted part-way leaves nothing behind: no sign-off, no booking, the slot still held", async () => {
    const me = await customer();
    const r = await applied(me, archery(payVenue, { slot: { courtId: lanePay, date: day(14), start: at(10), end: at(11) } }));
    // The sign-off cannot be written (a broken number): the whole decision rolls back.
    await getDb().prepare("UPDATE users SET phone = '12' WHERE id = ?").run(me.id);
    await expect(decide(staff(manager), r.id, "approve", { venueId: payVenue })).rejects.toThrow();
    await getDb().prepare("UPDATE users SET phone = ? WHERE id = ?").run(me.phone, me.id);
    const after = (await requestById(r.id))!;
    expect(after).toMatchObject({ status: "pending", slot: { status: "held" } });
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE user_id = ?").get(me.id)) as { n: number }).n).toBe(0);
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM sign_offs WHERE user_id = ?").get(me.id)) as { n: number }).n).toBe(0);
    expect(await decide(staff(manager), r.id, "approve", { venueId: payVenue })).toMatchObject({ ok: true, request: { slot: { status: "awaiting_payment" } } });
  });

  it("two approved applicants for the last place: one booked and held for payment, the other told it is gone", async () => {
    const date = day(4);
    const slot = { courtId: lanePay, date, start: at(16), end: at(17) };
    const first = await customer();
    const second = await customer();
    const a = await applied(first, archery(payVenue, { slot }));
    await getDb().prepare("UPDATE claims SET expires_at = now() - interval '1 minute' WHERE approval_id = ?").run(a.id);
    const b = await applied(second, archery(payVenue, { slot }));
    const [x, y] = await Promise.all([
      decide(staff(manager), a.id, "approve", { venueId: payVenue }),
      decide(staff(manager), b.id, "approve", { venueId: payVenue }),
    ]);
    expect(x.ok && y.ok).toBe(true);
    const statuses = [(await requestById(a.id))!.slot!.status, (await requestById(b.id))!.slot!.status].sort();
    expect(statuses).toEqual(["awaiting_payment", "taken"]);
    expect(await onSlot(lanePay, date, at(16))).toBe(1);
  });

  it("the customer may book another slot instead: the ordinary booking path, held for payment as any", async () => {
    const me = await customer();
    const done = await approvedWithSlot(me, day(3), 10);
    const res = await bookingsRoute.POST(
      req("http://localhost/api/bookings", "POST", me.cookie, { courtId: lanePay, date: day(3), start: at(12), end: at(13), name: me.name, phone: me.phone, email: me.email })
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { holdUntil: string | null }).holdUntil).toBeTruthy();
    await holdPast(done.booking!.id);
    await releaseExpiredHolds();
    await expireApprovals();
    expect((await requestById(done.request.id))!).toMatchObject({ status: "approved", slot: { status: "payment_lapsed" } });
  });

  it("staff may approve without holding for payment, as an exception on record; a coach may not", async () => {
    const me = await customer();
    const done = await approvedWithSlot(me, day(2), 10, { payLater: true });
    expect(done.booking).toMatchObject({ status: "confirmed", paymentStatus: "unpaid" });
    expect(done.booking!.holdUntil ?? null).toBeNull();
    expect(done.request.slot).toMatchObject({ status: "booked" });
    expect(done.request.events.map((e) => e.action)).toContain("pay_exception");
    expect((await listActivity([payVenue])).find((a) => a.action === "approval.approved" && (a.detail ?? "").includes("not held for payment"))).toBeDefined();
    const other = await customer();
    const r = await applied(other, archery(payVenue));
    expect(await decide({ kind: "coach", coach: { id: 1, name: "X", venueId: payVenue, active: true }, userId: other.id }, r.id, "approve", { payLater: true })).toMatchObject({
      ok: false,
      status: 403,
    });
  });
});

// ---------------------------------------------------------------------------------------------- who may grant

describe("who may grant a safety approval", () => {
  it("front desk asks, checks and refuses, but approves a safety assessment only when delegated", async () => {
    const me = await customer();
    const r = await applied(me, archery(payVenue));
    expect(await decide(staff(desk), r.id, "approve", { venueId: payVenue })).toMatchObject({ ok: false, code: "APR_SAFETY_AUTHORITY", status: 403 });
    expect(await decide(staff(desk), r.id, "check", { venueId: payVenue })).toMatchObject({ ok: true, request: { adminCheckedBy: "Danny Desk" } });
    expect(await decide(staff(desk), r.id, "check", { venueId: payVenue })).toMatchObject({ ok: false, code: "APR_WRONG_STATUS" });
    expect(await decide(staff(desk), r.id, "ask", { venueId: payVenue, reason: "Where did you shoot before?" })).toMatchObject({ ok: true });
    await customerAct(me, r.id, "answer", { answer: "At the club in Shah Alam." });
    // Through the route, as the dashboard does: the session's role, not the caller's say.
    const res = await adminRoute.POST(req("http://localhost/api/admin/approvals", "POST", desk.cookie, { venueId: payVenue, id: r.id, action: "approve" }));
    expect(res.status).toBe(403);
    expect(await decide(staff(delegated), r.id, "approve", { venueId: payVenue })).toMatchObject({ ok: true, request: { status: "approved" } });
    const events = (await requestById(r.id))!.events;
    expect(events.find((e) => e.action === "checked")).toMatchObject({ actor: "staff", actorName: "Danny Desk" });
    expect(events.find((e) => e.action === "approved")).toMatchObject({ actorName: "Dee Delegated" });
    // Refusing grants nothing, so the desk may.
    const other = await customer();
    const r2 = await applied(other, archery(payVenue));
    expect(await decide(staff(desk), r2.id, "reject", { venueId: payVenue, reason: "Not a member here." })).toMatchObject({ ok: true, request: { status: "rejected" } });
  });

  it("an administrative check any staff may approve", async () => {
    const s = await saveRequirement(payVenue, { sport: "badminton", declaration: "I am a member of the club and hold a valid membership.", reviewLevel: "administrative" });
    expect(s.ok).toBe(true);
    const me = await customer();
    const r = await applied(me, { venueId: payVenue, sport: "badminton", declaration: true, adult: true });
    expect(await decide(staff(desk), r.id, "approve", { venueId: payVenue })).toMatchObject({ ok: true, request: { status: "approved" } });
  });

  it("the desk cannot record a safety sign-off directly either, unless delegated", async () => {
    const body = (who: string) => ({ venueId: payVenue, sport: "archery", phone: phone(), name: who });
    expect((await signOffsRoute.POST(req("http://localhost/api/admin/sign-offs", "POST", desk.cookie, body("Walk In")))).status).toBe(403);
    expect((await signOffsRoute.POST(req("http://localhost/api/admin/sign-offs", "POST", desk.cookie, { ...body("Anything"), sport: null }))).status).toBe(403);
    expect((await signOffsRoute.POST(req("http://localhost/api/admin/sign-offs", "POST", delegated.cookie, body("Walk In Two")))).status).toBe(201);
    expect((await signOffsRoute.POST(req("http://localhost/api/admin/sign-offs", "POST", manager.cookie, body("Walk In Three")))).status).toBe(201);
  });

  it("a coach decides only signed in to the account a manager linked; unlinked, nothing", async () => {
    const made = await saveCoach(payVenue, { name: "Rui Range", sports: ["archery"], rate: 40, hours: [] });
    if (!made.ok) throw new Error(made.error);
    const s = await saveRequirement(payVenue, {
      sport: "archery",
      declaration: "I have shot at a range before and know its whistle signals.",
      validDays: 365,
      holdHours: 24,
      payHours: 6,
      delegateIds: [delegated.id],
      coachIds: [made.coach.id],
    });
    expect(s.ok).toBe(true);
    const coachUser = await customer();
    // Linking is a manager's.
    expect((await reviewersRoute.POST(req("http://localhost/api/admin/approvals/reviewers", "POST", desk.cookie, { venueId: payVenue, coachId: made.coach.id, email: coachUser.email }))).status).toBe(403);
    expect((await reviewersRoute.POST(req("http://localhost/api/admin/approvals/reviewers", "POST", manager.cookie, { venueId: payVenue, coachId: made.coach.id, email: "nobody@wf.test" }))).status).toBe(400);
    expect((await reviewersRoute.POST(req("http://localhost/api/admin/approvals/reviewers", "POST", manager.cookie, { venueId: payVenue, coachId: made.coach.id, email: coachUser.email }))).status).toBe(200);
    const me = await customer();
    const r = await applied(me, archery(payVenue));
    const list = (await (await reviewsRoute.GET(req("http://localhost/api/my/reviews", "GET", coachUser.cookie))).json()) as { requests: { id: number }[] };
    expect(list.requests.some((x) => x.id === r.id)).toBe(true);
    // The coach's own account decides, under their name; a revocation too.
    expect((await reviewsRoute.POST(req("http://localhost/api/my/reviews", "POST", coachUser.cookie, { id: r.id, action: "approve" }))).status).toBe(200);
    expect((await requestById(r.id))!.events.find((e) => e.action === "approved")).toMatchObject({ actor: "coach", actorName: "Rui Range" });
    expect((await reviewsRoute.POST(req("http://localhost/api/my/reviews", "POST", coachUser.cookie, { id: r.id, action: "revoke", reason: "Ignored the whistle." }))).status).toBe(200);
    expect((await requestById(r.id))!.revoked).toBe(true);
    // Unlinked: the same account reviews nothing.
    expect((await linkCoachAccount(payVenue, made.coach.id, null)).ok).toBe(true);
    const r2 = await applied(await customer(), archery(payVenue));
    expect((await reviewsRoute.POST(req("http://localhost/api/my/reviews", "POST", coachUser.cookie, { id: r2.id, action: "approve" }))).status).toBe(403);
    const coach = (await coachById(made.coach.id))!;
    expect(await decide({ kind: "coach", coach, userId: coachUser.id }, r2.id, "approve")).toMatchObject({ ok: false, code: "APR_NOT_REVIEWER" });
  });
});

// ---------------------------------------------------------------------------------------------- door codes

describe("door codes never bypass eligibility, however the booking was made", () => {
  /** Paid, inducted, and asked for at a quarter past the hour it starts. */
  async function door(code: string, ph: string, date: string, hour: number) {
    await setPaymentStatus(code, true, "cash");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${date}T${String(hour).padStart(2, "0")}:15:00+08:00`));
    const result = await accessCodeFor(code, ph);
    vi.useRealTimers();
    return result;
  }
  async function person() {
    const me = await customer();
    await recordInduction({ venueId: doorVenue, phone: me.phone, name: me.name });
    return me;
  }
  async function approvedAtDoor(me: Customer) {
    const r = await applied(me, archery(doorVenue));
    const done = await decide(staff(doorManager), r.id, "approve", { venueId: doorVenue });
    if (!done.ok) throw new Error(done.error);
    return r;
  }

  it("customer self-service: approved, booked online, paid: the code", async () => {
    const me = await person();
    await approvedAtDoor(me);
    const b = await createBooking({ courtId: doorLane, date: day(2), start: at(8), end: at(9), name: me.name, phone: me.phone, userId: me.id });
    if (!b.ok) throw new Error(b.error);
    expect(await door(b.booking.code, me.phone, day(2), 8)).toMatchObject({ ok: true, accessCode: "7788" });
  });

  it("front desk: refused without a sign-off; with one, the code", async () => {
    const me = await person();
    expect(await createBooking({ by: "staff", courtId: doorLane, date: day(2), start: at(9), end: at(10), name: me.name, phone: me.phone })).toMatchObject({ ok: false, code: "SIGN_OFF_NEEDED" });
    const signed = await signOffsRoute.POST(req("http://localhost/api/admin/sign-offs", "POST", doorManager.cookie, { venueId: doorVenue, sport: "archery", phone: me.phone, name: me.name }));
    expect(signed.status).toBe(201);
    const b = await createBooking({ by: "staff", courtId: doorLane, date: day(2), start: at(9), end: at(10), name: me.name, phone: me.phone });
    if (!b.ok) throw new Error(b.error);
    expect(await door(b.booking.code, me.phone, day(2), 9)).toMatchObject({ ok: true });
  });

  it("a manager's override books it, but opens no door; a pending, refused or lapsed application none either", async () => {
    const me = await person();
    const b = await createBookingSeries({ by: "staff", staff: { override: true }, courtId: doorLane, date: day(3), start: at(10), end: at(11), weeks: 1, name: me.name, phone: me.phone });
    if (!b.ok) throw new Error(b.error);
    const code = b.bookings[0].code;
    expect(await door(code, me.phone, day(3), 10)).toMatchObject({ ok: false, reason: "approval-needed" });
    const r = await applied(me, archery(doorVenue));
    expect(await door(code, me.phone, day(3), 10)).toMatchObject({ ok: false, reason: "approval-needed" });
    await decide(staff(doorManager), r.id, "reject", { venueId: doorVenue, reason: "Did not attend the briefing." });
    expect(await door(code, me.phone, day(3), 10)).toMatchObject({ ok: false, reason: "approval-needed" });
    // Approved after the booking was made: now the door opens.
    const again = await applied(me, archery(doorVenue));
    await decide(staff(doorManager), again.id, "approve", { venueId: doorVenue });
    expect(await door(code, me.phone, day(3), 10)).toMatchObject({ ok: true });
    // Run out: closed again.
    await getDb().prepare("UPDATE sign_offs SET expires_on = ? WHERE id = (SELECT sign_off_id FROM approval_requests WHERE id = ?)").run(day(1), again.id);
    expect(await door(code, me.phone, day(3), 10)).toMatchObject({ ok: false, reason: "approval-needed" });
  });

  it("the venue's API key: refused without approval; approved, the code; revoked, none", async () => {
    const key = await createApiKey(doorVenue, { name: "Kiosk", scope: "write" }, doorManager.id);
    if (!key.ok) throw new Error(key.error);
    const me = await person();
    const body = { courtId: doorLane, date: day(4), start: at(11), end: at(12), name: me.name, phone: me.phone };
    const auth = { authorization: `Bearer ${key.key}` };
    expect((await v1Route.POST(req("http://localhost/api/v1/bookings", "POST", null, body, auth))).status).toBe(409);
    const r = await approvedAtDoor(me);
    const res = await v1Route.POST(req("http://localhost/api/v1/bookings", "POST", null, body, auth));
    expect(res.status).toBe(201);
    const code = ((await res.json()) as { booking: { code: string } }).booking.code;
    expect(await door(code, me.phone, day(4), 11)).toMatchObject({ ok: true });
    expect(await decide(staff(doorDesk), r.id, "revoke", { venueId: doorVenue, reason: "Shot before the whistle." })).toMatchObject({ ok: true });
    expect(await door(code, me.phone, day(4), 11)).toMatchObject({ ok: false, reason: "approval-needed" });
  });

  it("a coach's lesson booked past the rules opens no door without the person's own approval", async () => {
    const made = await saveCoach(doorVenue, { name: "Lee Lesson", sports: ["archery"], rate: 40, hours: [] });
    if (!made.ok) throw new Error(made.error);
    const me = await person();
    const b = await createBookingSeries({ by: "staff", staff: { override: true }, courtId: doorLane, date: day(5), start: at(12), end: at(13), weeks: 1, name: me.name, phone: me.phone });
    if (!b.ok) throw new Error(b.error);
    await attachCoach(b.bookings[0].id, made.coach);
    expect(await door(b.bookings[0].code, me.phone, day(5), 12)).toMatchObject({ ok: false, reason: "approval-needed" });
  });

  it("supervised attendance is met by staff: never a door code, and no sign-off for later", async () => {
    const me = await person();
    const b = await createBookingSeries({ by: "staff", staff: { override: true }, courtId: doorLane, date: day(6), start: at(13), end: at(14), weeks: 1, name: me.name, phone: me.phone });
    if (!b.ok) throw new Error(b.error);
    const code = b.bookings[0].code;
    const body = { venueId: doorVenue, code, supervised: true, note: "Range officer Nora supervises, procedure RS-2" };
    expect((await supervisedRoute.POST(req("http://localhost/api/admin/approvals/supervised", "POST", doorDesk.cookie, body))).status).toBe(403);
    expect((await supervisedRoute.POST(req("http://localhost/api/admin/approvals/supervised", "POST", doorManager.cookie, { ...body, note: "" }))).status).toBe(400);
    expect((await supervisedRoute.POST(req("http://localhost/api/admin/approvals/supervised", "POST", doorManager.cookie, body))).status).toBe(200);
    expect((await listActivity([doorVenue])).find((a) => a.action === "booking.supervised" && a.bookingCode === code)).toBeDefined();
    expect(await door(code, me.phone, day(6), 13)).toMatchObject({ ok: false, reason: "supervised" });
    expect(await signOffHolds({ venueId: doorVenue, sport: "archery", until: day(7), phone: me.phone, userId: me.id, channel: "customer", need: "any" })).toBe(false);
    // Even approved later, a supervised booking stays met by staff.
    await approvedAtDoor(me);
    expect(await door(code, me.phone, day(6), 13)).toMatchObject({ ok: false, reason: "supervised" });
  });

  it("asks for the booked activity's approval on a resource that offers several", async () => {
    const r = await createResources({ venueId: doorVenue, sport: "badminton", name: "Hall", offPeakRate: 20, peakRate: 20, capacity: 1, also: [{ sport: "archery" }] });
    if (!r.ok) throw new Error(r.error);
    const hall = r.courts[0].id;
    expect((await updateCourt(hall, { unmanned: true, accessCode: "5150" })).ok).toBe(true);
    const me = await person();
    const b = await createBookingSeries({ by: "staff", staff: { override: true }, courtId: hall, sport: "archery", date: day(7), start: at(14), end: at(15), weeks: 1, name: me.name, phone: me.phone });
    if (!b.ok) throw new Error(b.error);
    expect(await door(b.bookings[0].code, me.phone, day(7), 14)).toMatchObject({ ok: false, reason: "approval-needed" });
    // Its main activity needs nothing: that opens.
    const c = await createBooking({ by: "staff", courtId: hall, date: day(7), start: at(16), end: at(17), name: me.name, phone: me.phone });
    if (!c.ok) throw new Error(c.error);
    expect(await door(c.booking.code, me.phone, day(7), 16)).toMatchObject({ ok: true, accessCode: "5150" });
  });

  it("an activity the venue takes approvals for needs one at the door, whatever its booking rules say", async () => {
    const r = await createResources({ venueId: doorVenue, sport: "badminton", name: "Court night", offPeakRate: 20, peakRate: 20, capacity: 1 });
    if (!r.ok) throw new Error(r.error);
    const court = r.courts[0].id;
    expect((await updateCourt(court, { unmanned: true, accessCode: "2468" })).ok).toBe(true);
    expect((await saveRequirement(doorVenue, { sport: "badminton", declaration: "I know the hall's night rules and emergency exits." })).ok).toBe(true);
    const me = await person();
    // Sold at an unstaffed time, the same ask is made at booking (ADR 0058): a customer without the approval is refused there.
    expect(await createBooking({ courtId: court, date: day(8), start: at(15), end: at(16), name: me.name, phone: me.phone, userId: me.id })).toMatchObject({ ok: false, code: "SIGN_OFF_NEEDED" });
    // A manager going past the rules still gets no door code for it: the door asks again.
    const b = await createBookingSeries({ by: "staff", staff: { override: true }, courtId: court, date: day(8), start: at(15), end: at(16), weeks: 1, name: me.name, phone: me.phone, userId: me.id });
    if (!b.ok) throw new Error(b.error);
    const code = b.bookings[0].code;
    expect(await door(code, me.phone, day(8), 15)).toMatchObject({ ok: false, reason: "approval-needed" });
    const a = await applied(me, { venueId: doorVenue, sport: "badminton", declaration: true, adult: true });
    await decide(staff(doorManager), a.id, "approve", { venueId: doorVenue });
    expect(await door(code, me.phone, day(8), 15)).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------------------------- revoking

describe("revoking an approval", () => {
  it("stops online booking and the door, flags the person's bookings for staff instead of cancelling, and is told", async () => {
    const me = await customer();
    const r = await applied(me, archery(doorVenue));
    await decide(staff(doorManager), r.id, "approve", { venueId: doorVenue });
    const b = await createBooking({ courtId: doorLane, date: day(9), start: at(8), end: at(9), name: me.name, phone: me.phone, userId: me.id });
    if (!b.ok) throw new Error(b.error);
    expect(await decide(staff(doorManager), r.id, "revoke", { venueId: doorVenue })).toMatchObject({ ok: false, code: "APR_REASON_NEEDED" });
    expect(await decide(staff(doorManager), r.id, "revoke", { venueId: doorVenue, reason: "Unsafe nocking at the line." })).toMatchObject({
      ok: true,
      request: { status: "approved", revoked: true, revokeReason: "Unsafe nocking at the line." },
    });
    // Nothing more online.
    expect(await createBooking({ courtId: doorLane, date: day(10), start: at(8), end: at(9), name: me.name, phone: me.phone, userId: me.id })).toMatchObject({
      ok: false,
      code: "SIGN_OFF_NEEDED",
    });
    // The booking already made stands, flagged for staff.
    expect(await findBooking(b.booking.code, me.phone)).toMatchObject({ status: "confirmed" });
    const list = (await (await adminRoute.GET(req(`http://localhost/api/admin/approvals?venueId=${doorVenue}`, "GET", doorDesk.cookie))).json()) as {
      flags: { id: number; bookingCode: string }[];
    };
    const flag = list.flags.find((f) => f.bookingCode === b.booking.code)!;
    expect(flag).toBeDefined();
    expect((await lastMail(me.email)).subject).toMatch(/taken back/);
    const events = (await requestById(r.id))!.events.map((e) => e.action);
    expect(events).toEqual(expect.arrayContaining(["revoked", "bookings_flagged"]));
    // Staff deal with it, and say how.
    expect((await adminRoute.POST(req("http://localhost/api/admin/approvals", "POST", doorDesk.cookie, { venueId: doorVenue, flagId: flag.id, action: "resolve_flag", note: "" }))).status).toBe(400);
    const done = await adminRoute.POST(req("http://localhost/api/admin/approvals", "POST", doorDesk.cookie, { venueId: doorVenue, flagId: flag.id, action: "resolve_flag", note: "Called: kept, a range officer supervises." }));
    expect(((await done.json()) as { flags: { id: number }[] }).flags.some((f) => f.id === flag.id)).toBe(false);
    // Taken back once; and it can be applied for again.
    expect(await decide(staff(doorManager), r.id, "revoke", { venueId: doorVenue, reason: "Again." })).toMatchObject({ ok: false, code: "APR_WRONG_STATUS" });
    expect((await apply(me, archery(doorVenue))).ok).toBe(true);
  });

  it("a sign-off an approval wrote, taken back in the Sign-offs tab, revokes the approval the same way", async () => {
    const me = await customer();
    const r = await applied(me, archery(doorVenue));
    await decide(staff(doorManager), r.id, "approve", { venueId: doorVenue });
    const b = await createBooking({ courtId: doorLane, date: day(11), start: at(8), end: at(9), name: me.name, phone: me.phone, userId: me.id });
    if (!b.ok) throw new Error(b.error);
    const signOff = ((await getDb().prepare("SELECT sign_off_id FROM approval_requests WHERE id = ?").get(r.id)) as { sign_off_id: number }).sign_off_id;
    const res = await signOffsRoute.DELETE(
      req(`http://localhost/api/admin/sign-offs?venueId=${doorVenue}&id=${signOff}&reason=${encodeURIComponent("Failed a spot check")}`, "DELETE", doorManager.cookie)
    );
    expect(res.status).toBe(200);
    const after = (await requestById(r.id))!;
    expect(after).toMatchObject({ revoked: true });
    expect(after.events.at(-2)).toMatchObject({ action: "revoked", actorName: "Nora Night" });
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM approval_booking_flags WHERE request_id = ?").get(r.id)) as { n: number }).n).toBe(1);
  });
});
