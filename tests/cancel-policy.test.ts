import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { registerUser, type User } from "../src/lib/auth";
import { cancelPolicy, setCancelPolicy, strikesFor, struckOut } from "../src/lib/cancel-policy";
import { getDb } from "../src/lib/db";
import { documentFor } from "../src/lib/documents";
import { customerMayBook } from "../src/lib/limits";
import { savePaymentSettings } from "../src/lib/payments";
import {
  cancelBooking,
  createBooking,
  createCourt,
  createVenue,
  getWalletBalance,
  issuePass,
  payBookingFromWallet,
  payBookingWithPass,
  setPaymentStatus,
  topUpWallet,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { GET as lookup, POST as book } from "../src/app/api/bookings/route";
import { POST as cancelRoute } from "../src/app/api/bookings/cancel/route";

/**
 * What a late cancellation or a no-show costs: a venue may let customers
 * cancel after the cutoff for a share of the price, and a number that keeps
 * not turning up pays online to book, or books at the counter.
 */

let venueId: number;
let courtId: number;
let adminId: number;
let customer: User;
const PHONE = "0197770001";
// Tomorrow evening is always inside a 48-hour cutoff, and never past.
const soon = addDays(todayISO(), 1);
const later = addDays(todayISO(), 5);
let hour = 8;

async function booked(date = soon, phone = PHONE, userId?: number) {
  const made = await createBooking({ courtId, date, hours: [hour++], name: "Aisyah", phone, userId });
  if (!made.ok) throw new Error(made.error);
  return made.booking;
}

const lateCancelled = async (id: number) =>
  ((await getDb().prepare("SELECT late_cancelled FROM bookings WHERE id = ?").get(id)) as { late_cancelled: number }).late_cancelled;

beforeAll(async () => {
  await ensureBootstrapAdmin();
  adminId = ((await getDb().prepare("SELECT id FROM admins ORDER BY id LIMIT 1").get()) as { id: number }).id;
  const made = await createVenue({ name: "Strike Hall", area: "PJ", address: "1 Jalan Batal", phone: "0312345678" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  await getDb().prepare("UPDATE venues SET cancel_cutoff_hours = 48 WHERE id = ?").run(venueId);
  const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 40, peakRate: 40 });
  if (!court.ok) throw new Error("court");
  courtId = court.court.id;
  const user = await registerUser({ name: "Aisyah", email: "aisyah@example.my", phone: PHONE, password: "a long enough password" });
  if (!user.ok) throw new Error(user.error);
  customer = user.user;
});

afterEach(() => vi.unstubAllGlobals());

describe("the policy", () => {
  it("is off by default: no late cancelling online, no strikes", async () => {
    expect(await cancelPolicy(venueId)).toEqual({ lateKeep: null, strikeLimit: null, strikeDays: 90 });
    const b = await booked();
    const result = await cancelBooking(b.code, PHONE);
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? "" : result.error).toContain("48 hours");
  });

  it("checks what a manager sets", async () => {
    expect(await setCancelPolicy(venueId, { lateKeep: 101 })).toMatchObject({ ok: false });
    expect(await setCancelPolicy(venueId, { lateKeep: 10.5 })).toMatchObject({ ok: false });
    expect(await setCancelPolicy(venueId, { strikeLimit: 0 })).toMatchObject({ ok: false });
    expect(await setCancelPolicy(venueId, { strikeDays: 3 })).toMatchObject({ ok: false });
    expect(await setCancelPolicy(venueId, { lateKeep: 25, strikeLimit: null, strikeDays: 30 })).toEqual({
      ok: true,
      policy: { lateKeep: 25, strikeLimit: null, strikeDays: 30 },
    });
  });
});

describe("cancelling late", () => {
  it("gives back the rest of credit, and says what was kept", async () => {
    const topped = await topUpWallet({ userId: customer.id, amount: 100, adminId, venueId });
    if (!topped.ok) throw new Error(topped.error);
    const b = await booked(soon, PHONE, customer.id);
    expect(await payBookingFromWallet(b.id)).toMatchObject({ ok: true });
    expect(await getWalletBalance(customer.id, venueId)).toBe(60);
    const result = await cancelBooking(b.code, PHONE);
    expect(result).toMatchObject({ ok: true, kept: 10 });
    expect(await getWalletBalance(customer.id, venueId)).toBe(90);
    expect(await lateCancelled(b.id)).toBe(1);
  });

  it("credits the receipt for the share given back", async () => {
    const b = await booked();
    await setPaymentStatus(b.code, true, "cash");
    await cancelBooking(b.code, PHONE);
    const credit = (await documentFor(`booking:${b.id}`))!;
    expect(credit).toMatchObject({ kind: "credit_note", credits: b.code, total: 30, note: "receipt.why.lateCancelled" });
    expect(credit.lines).toEqual([expect.objectContaining({ description: `75% of ${b.code}, cancelled late`, amount: 30 })]);
  });

  it("owes back the share of an online payment", async () => {
    const b = await booked();
    const db = getDb();
    await db.prepare("UPDATE bookings SET payment_status = 'paid', paid_via = 'online' WHERE id = ?").run(b.id);
    const { id } = (await db
      .prepare(
        `INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, status, payer_name, payer_phone, purpose)
         VALUES ('billplz', 'bp_late', 'https://x', ?, 40, 'paid', 'Aisyah', ?, 'booking') RETURNING id`
      )
      .get(venueId, PHONE)) as { id: number };
    await db.prepare("INSERT INTO online_payment_bookings (payment_id, booking_id) VALUES (?, ?)").run(id, b.id);
    expect(await cancelBooking(b.code, PHONE)).toMatchObject({ ok: true, kept: 10 });
    const due = (await db.prepare("SELECT refund_due FROM online_payments WHERE id = ?").get(id)) as { refund_due: number };
    expect(Number(due.refund_due)).toBe(30);
  });

  it("gives back whole pass entries, rounded down", async () => {
    const sold = await issuePass({
      venueId, name: "10-hour pass", entries: 10, price: 300, holderName: "Aisyah", holderPhone: PHONE,
      expiresOn: addDays(todayISO(), 60), adminId, userId: customer.id,
    });
    if (!sold.ok) throw new Error(sold.error);
    const made = await createBooking({ courtId, date: soon, hours: [hour, hour + 1], name: "Aisyah", phone: PHONE, userId: customer.id });
    hour += 2;
    if (!made.ok) throw new Error(made.error);
    const paid = await payBookingWithPass(made.booking.id, sold.pass.code);
    if (!paid.ok) throw new Error(paid.error);
    expect(paid.pass.remaining).toBe(8);
    await cancelBooking(made.booking.code, PHONE);
    const left = (await getDb()
      .prepare("SELECT SUM(delta) AS n FROM pass_entries WHERE pass_id = ?")
      .get(sold.pass.id)) as { n: number };
    // Two spent, one of them back: 9 of the 10 left.
    expect(10 + Number(left.n)).toBe(9);
  });

  it("before the cutoff still gives everything back, and is not late", async () => {
    const b = await booked(later, PHONE, customer.id);
    const before = await getWalletBalance(customer.id, venueId);
    await payBookingFromWallet(b.id);
    const result = await cancelBooking(b.code, PHONE);
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.kept).toBeUndefined();
    expect(await getWalletBalance(customer.id, venueId)).toBe(before);
    expect(await lateCancelled(b.id)).toBe(0);
  });

  it("is shown on the booking, and its cost comes back from cancelling", async () => {
    const b = await booked();
    await setPaymentStatus(b.code, true, "cash");
    const res = await lookup(new NextRequest(`http://localhost/api/bookings?code=${b.code}&phone=${PHONE}`));
    expect((await res.json()).venue).toMatchObject({ cancelCutoffHours: 48, lateCancelKeep: 25 });
    const cancelled = await cancelRoute(
      new NextRequest("http://localhost/api/bookings/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: b.code, phone: PHONE }),
      })
    );
    expect(await cancelled.json()).toMatchObject({ booking: { status: "cancelled" }, kept: 10 });
  });
});

describe("strikes", () => {
  const OTHER = "0197770002";

  it("are no-shows and unpaid late cancellations, not paid ones", async () => {
    await setCancelPolicy(venueId, { lateKeep: 0, strikeLimit: 2, strikeDays: 30 });
    // Paid, cancelled late: the fee is the cost of it (here nothing). No strike.
    const paid = await booked(soon, OTHER);
    await setPaymentStatus(paid.code, true, "cash");
    await cancelBooking(paid.code, OTHER);
    expect(await strikesFor(venueId, OTHER)).toBe(0);
    // Unpaid, cancelled late: one.
    const unpaid = await booked(soon, OTHER);
    expect(await cancelBooking(unpaid.code, OTHER)).toMatchObject({ ok: true, kept: 0 });
    expect(await strikesFor(venueId, OTHER)).toBe(1);
    expect(await struckOut(venueId, OTHER)).toEqual({ out: false, strikes: 1 });
    // A no-show: two.
    const missed = await booked(later, OTHER);
    await getDb().prepare("UPDATE bookings SET no_show = 1 WHERE id = ?").run(missed.id);
    expect(await struckOut(venueId, OTHER)).toEqual({ out: true, strikes: 2 });
  });

  it("send a number to the counter where the venue takes nothing online", async () => {
    expect(await customerMayBook({ venueId, phone: OTHER, signedIn: false })).toMatchObject({
      code: "STRIKES_COUNTER",
      vars: { n: 2 },
    });
    expect(await customerMayBook({ venueId, phone: "0197770003", signedIn: false })).toBeNull();
  });

  it("make a number pay online to book where it can", async () => {
    const saved = await savePaymentSettings(venueId, {
      apiKey: "api-key-1234",
      collectionId: "col123",
      xSignatureKey: "S-key",
      sandbox: true,
      enabled: true,
    });
    if (!saved.ok) throw new Error(saved.error);
    const post = (phone: string) =>
      book(
        new NextRequest("http://localhost/api/bookings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ courtId, date: later, hours: [hour++], name: "Aisyah", phone }),
        })
      );
    const struck = await post(OTHER);
    expect(struck.status).toBe(201);
    expect((await struck.json()).holdUntil).toBeTruthy();
    const fine = await post("0197770003");
    expect(fine.status).toBe(201);
    expect((await fine.json()).holdUntil).toBeNull();
  });

  it("are counted only in the window", async () => {
    await getDb().prepare("UPDATE bookings SET date = ? WHERE phone_key LIKE ? AND no_show = 1").run(addDays(todayISO(), -40), "%197770002");
    expect(await strikesFor(venueId, OTHER)).toBe(1);
  });
});
