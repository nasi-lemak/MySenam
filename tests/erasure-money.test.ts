import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { getDb } from "../src/lib/db";
import { ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { registerUser } from "../src/lib/auth";
import { setCancelPolicy } from "../src/lib/cancel-policy";
import { documentFor, documentsForVenue } from "../src/lib/documents";
import { ANONYMOUS, ERASURE_GIVES_BACK, eraseCustomer } from "../src/lib/privacy";
import { createBooking, createCourt, createVenue, getWalletBalance, joinSlotWaitlist, payBookingFromWallet, setPaymentStatus, topUpWallet } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Closing an account cancels its upcoming bookings through the one
 * cancellation money path (audit R8, X3-1): what was paid online is owed
 * back, the receipt is credited (and the credit note names nobody), the
 * freed place goes to the waiting list, a late cancellation keeps the
 * venue's fee, and credit a cancellation would give back refuses the
 * erasure rather than vanishing with the account.
 */

let venueId: number;
let courtId: number;
let strictCourt: number;
let adminId: number;
let n = 0;

async function customer() {
  n++;
  const made = await registerUser({ name: `Zara ${n}`, email: `zara${n}@example.my`, phone: `01977700${String(n).padStart(2, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return made.user;
}

async function book(userId: number, onCourt: number, date: string, hour: number, phone: string) {
  const made = await createBooking({ courtId: onCourt, date, hours: [hour], name: "Zara", phone, userId });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.booking;
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  adminId = (await listAdmins())[0].id;
  const v = await createVenue({ name: "Erase Hall", area: "PJ", address: "1", phone: "0312345678" });
  const strict = await createVenue({ name: "Strict Hall", area: "PJ", address: "2", phone: "0312345679" });
  if (!v.ok || !strict.ok) throw new Error("venue");
  venueId = v.venue.id;
  const c = await createCourt({ venueId, name: "C1", sport: "badminton", offPeakRate: 40, peakRate: 40 });
  const s = await createCourt({ venueId: strict.venue.id, name: "S1", sport: "badminton", offPeakRate: 40, peakRate: 40 });
  if (!c.ok || !s.ok) throw new Error("court");
  courtId = c.court.id;
  strictCourt = s.court.id;
  // Late cancelling: Erase Hall keeps half after a 48-hour cutoff; Strict Hall allows none after its own.
  await getDb().prepare("UPDATE venues SET cancel_cutoff_hours = 48 WHERE id IN (?, ?)").run(venueId, strict.venue.id);
  expect((await setCancelPolicy(venueId, { lateKeep: 50 })).ok).toBe(true);
});

describe("closing an account with paid bookings to come", () => {
  it("owes back what was paid online, credits the receipt, names nobody on it, and offers the court to the waiting list", async () => {
    const u = await customer();
    const date = addDays(todayISO(), 7);
    const b = await book(u.id, courtId, date, 10, u.phone);
    const db = getDb();
    await db.prepare("UPDATE bookings SET payment_status = 'paid', paid_via = 'online', paid_at = datetime('now') WHERE id = ?").run(b.id);
    const { id: paymentId } = (await db
      .prepare(
        `INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, status, payer_name, payer_phone, purpose)
         VALUES ('billplz', 'bp_erase_1', 'https://x', ?, 40, 'paid', 'Zara', ?, 'booking') RETURNING id`
      )
      .get(venueId, u.phone)) as { id: number };
    await db.prepare("INSERT INTO online_payment_bookings (payment_id, booking_id, amount) VALUES (?, ?, 40)").run(paymentId, b.id);
    const waiting = await joinSlotWaitlist({ courtId, date, start: 600, end: 660, name: "Next Person", phone: "0123334444" });
    if (!waiting.ok) throw new Error(waiting.error);

    expect(await eraseCustomer(u.id)).toMatchObject({ ok: true, cancelled: 1 });

    expect(await db.prepare("SELECT status, payment_status, name FROM bookings WHERE id = ?").get(b.id)).toMatchObject({
      status: "cancelled",
      payment_status: "paid",
      name: ANONYMOUS,
    });
    const payment = (await db.prepare("SELECT refund_due::float AS due FROM online_payments WHERE id = ?").get(paymentId)) as { due: number };
    expect(payment.due).toBe(40);
    const credit = await documentFor(`booking:${b.id}`);
    expect(credit).toMatchObject({ kind: "credit_note", total: 40 });
    expect(credit!.customerName).not.toContain("Zara");
    expect(JSON.stringify(await documentsForVenue(venueId))).not.toContain(u.phone);
    const offered = (await db.prepare("SELECT status FROM waitlist WHERE id = ?").get(waiting.entry.id)) as { status: string };
    expect(offered.status).toBe("offered");
  });

  it("keeps the venue's late-cancellation fee inside its cutoff, crediting the rest", async () => {
    const u = await customer();
    const b = await book(u.id, courtId, addDays(todayISO(), 1), 11, u.phone);
    expect((await setPaymentStatus(b.code, true, "cash")).ok).toBe(true);
    expect(await eraseCustomer(u.id)).toMatchObject({ ok: true, cancelled: 1 });
    expect(await getDb().prepare("SELECT status, late_cancelled, late_kept_percent FROM bookings WHERE id = ?").get(b.id)).toMatchObject({
      status: "cancelled",
      late_cancelled: 1,
      late_kept_percent: 50,
    });
    expect(await documentFor(`booking:${b.id}`)).toMatchObject({ kind: "credit_note", total: 20, note: "receipt.why.lateCancelled" });
  });

  it("where the venue allows no late cancelling, frees the court and keeps what was paid; a booking under way stands", async () => {
    const u = await customer();
    const late = await book(u.id, strictCourt, addDays(todayISO(), 1), 12, u.phone);
    expect((await setPaymentStatus(late.code, true, "cash")).ok).toBe(true);
    // One under way: started an hour ago, today.
    const started = await book(u.id, strictCourt, addDays(todayISO(), 3), 9, u.phone);
    const now = new Date();
    await getDb()
      .prepare("UPDATE bookings SET date = ?, start_min = 0, end_min = 1439, starts_at = ?, ends_at = ? WHERE id = ?")
      .run(todayISO(), new Date(now.getTime() - 3_600_000).toISOString(), new Date(now.getTime() + 3_600_000).toISOString(), started.id);
    expect(await eraseCustomer(u.id)).toMatchObject({ ok: true, cancelled: 1 });
    expect(await getDb().prepare("SELECT status, late_cancelled, late_kept_percent FROM bookings WHERE id = ?").get(late.id)).toMatchObject({
      status: "cancelled",
      late_cancelled: 1,
      late_kept_percent: 100,
    });
    expect(await documentFor(`booking:${late.id}`)).toBeNull();
    expect(await getDb().prepare("SELECT status, name FROM bookings WHERE id = ?").get(started.id)).toMatchObject({ status: "confirmed", name: ANONYMOUS });
  });

  it("is refused, with nothing changed, when cancelling would put credit back into the account", async () => {
    const u = await customer();
    expect((await topUpWallet({ userId: u.id, amount: 40, adminId })).ok).toBe(true);
    const b = await book(u.id, courtId, addDays(todayISO(), 9), 13, u.phone);
    expect((await payBookingFromWallet(b.id)).ok).toBe(true);
    expect(await getWalletBalance(u.id)).toBe(0);
    expect(await eraseCustomer(u.id)).toEqual({ ok: false, error: ERASURE_GIVES_BACK });
    expect(await getDb().prepare("SELECT status, payment_status, user_id FROM bookings WHERE id = ?").get(b.id)).toMatchObject({
      status: "confirmed",
      payment_status: "paid",
      user_id: u.id,
    });
    expect(await getWalletBalance(u.id)).toBe(0);
    expect(await documentFor(`booking:${b.id}`)).toBeNull();
    expect(await getDb().prepare("SELECT 1 FROM users WHERE id = ?").get(u.id)).toBeTruthy();
  });
});
