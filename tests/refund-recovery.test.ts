import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { registerUser } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { checkIntegrity } from "../src/lib/integrity";
import { refundsInFlight } from "../src/lib/payments";
import {
  cancelBooking,
  cancelClassSession,
  createBooking,
  createClassSessions,
  createCourt,
  enrolInClass,
  getWalletBalance,
  listVenues,
  payBookingFromWallet,
  topUpWallet,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * A cancellation and its refunds are one change (known limitations M15): a
 * failure part-way leaves the booking booked and nothing given back, never
 * cancelled with half its money returned. What the gateway does cannot be
 * part of that, so it is written down as owed first and sent after; a refund
 * with no answer, or owed too long, is shown to staff and raised by the
 * integrity check.
 */

let adminId: number;
let venueId: number;
let n = 0;

async function court() {
  const made = await createCourt({ venueId, name: `Refund Court ${++n}`, sport: "badminton", offPeakRate: 15, peakRate: 15 });
  if (!made.ok) throw new Error(made.error);
  return made.court;
}

async function customer(credit: number) {
  const reg = await registerUser({ name: `Payer ${++n}`, email: `payer${n}@refund.my`, phone: `0173${String(n).padStart(6, "0")}`, password: "a long enough password" });
  if (!reg.ok) throw new Error(reg.error);
  await topUpWallet({ userId: reg.user.id, amount: credit, adminId });
  return reg.user;
}

const db = () => getDb();
const count = async (sql: string, ...params: unknown[]) => ((await db().prepare(sql).get(...params)) as { n: number }).n;

beforeAll(async () => {
  await ensureBootstrapAdmin();
  adminId = (await listAdmins())[0].id;
  venueId = (await listVenues())[0].id;
});

describe("a cancellation that fails part-way through its refunds", () => {
  it("leaves the booking booked and nothing given back; once it can, it is cancelled and refunded once", async () => {
    const user = await customer(50);
    const c = await court();
    const made = await createBooking({ courtId: c.id, date: addDays(todayISO(), 6), hours: [10], name: "Payer", phone: user.phone, userId: user.id });
    if (!made.ok) throw new Error(made.error);
    expect((await payBookingFromWallet(made.booking.id)).ok).toBe(true);
    expect(await getWalletBalance(user.id)).toBe(35);

    // The credit going back fails, as a crash between steps would.
    await db().exec(`
      CREATE OR REPLACE FUNCTION refuse_refund() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.amount > 0 AND NEW.booking_id IS NOT NULL THEN RAISE EXCEPTION 'injected failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER refuse_refund BEFORE INSERT ON wallet_entries FOR EACH ROW EXECUTE FUNCTION refuse_refund();
    `);
    try {
      await expect(cancelBooking(made.booking.code, user.phone)).rejects.toThrow("injected failure");
    } finally {
      await db().exec("DROP TRIGGER refuse_refund ON wallet_entries; DROP FUNCTION refuse_refund();");
    }
    // Nothing half done: still booked, still holding its court, still paid, no credit note.
    expect(((await db().prepare("SELECT status FROM bookings WHERE id = ?").get(made.booking.id)) as { status: string }).status).toBe("confirmed");
    expect(await count("SELECT COUNT(*)::int AS n FROM claims WHERE booking_id = ? AND active", made.booking.id)).toBe(1);
    expect(await getWalletBalance(user.id)).toBe(35);
    expect(await count("SELECT COUNT(*)::int AS n FROM receipts WHERE kind = 'credit_note' AND source LIKE ?", `%${made.booking.id}%`)).toBe(0);

    // Asked again, twice at once: cancelled and refunded, once.
    const [a, b] = await Promise.all([cancelBooking(made.booking.code, user.phone), cancelBooking(made.booking.code, user.phone)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(await getWalletBalance(user.id)).toBe(50);
    expect(await count("SELECT COUNT(*)::int AS n FROM wallet_entries WHERE booking_id = ? AND amount > 0", made.booking.id)).toBe(1);
    expect(await count("SELECT COUNT(*)::int AS n FROM claims WHERE booking_id = ? AND active", made.booking.id)).toBe(0);
    expect(await checkIntegrity()).toEqual([]);
  });
});

describe("a class called off while somebody cancels their place in it", () => {
  it("refunds that place once", async () => {
    const user = await customer(50);
    const room = await createCourt({ venueId, name: `Refund Studio ${++n}`, sport: "yoga", offPeakRate: 15, peakRate: 15, capacity: 10 });
    if (!room.ok) throw new Error(room.error);
    const c = room.court;
    const session = await createClassSessions({ courtId: c.id, name: "Refund drill", instructor: "Coach", date: addDays(todayISO(), 7), startHour: 18, endHour: 19, capacity: 8, price: 20 });
    if (!session.ok) throw new Error(session.error);
    const place = await enrolInClass({ classId: session.classes[0].id, name: "Payer", phone: user.phone, userId: user.id });
    if (!place.ok) throw new Error(place.error);
    expect((await payBookingFromWallet(place.booking.id)).ok).toBe(true);
    expect(await getWalletBalance(user.id)).toBe(30);
    await Promise.all([cancelClassSession(session.classes[0].id), cancelBooking(place.booking.code, user.phone)]);
    expect(await getWalletBalance(user.id)).toBe(50);
    expect(await count("SELECT COUNT(*)::int AS n FROM wallet_entries WHERE booking_id = ? AND amount > 0", place.booking.id)).toBe(1);
  });
});

describe("refunds staff must see", () => {
  async function payment(bill: string, paidDaysAgo: number, due: number) {
    return ((await db()
      .prepare(
        `INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, payer_name, status, paid_at, refund_due)
         VALUES ('stripe', ?, 'https://pay.example', ?, 30, 'Owed Payer', 'paid', datetime('now', ?), ?) RETURNING id`
      )
      .get(bill, venueId, `-${paidDaysAgo} days`, due)) as { id: number }).id;
  }

  it("one asked of the gateway with no answer is on its way, and raised after an hour", async () => {
    const id = await payment("pi_unanswered", 0, 30);
    await db()
      .prepare(
        `UPDATE online_payments SET refunded = 30 WHERE id = ?`
      )
      .run(id);
    await db()
      .prepare("INSERT INTO online_refunds (payment_id, amount, provider_ref, pending, created_at) VALUES (?, 30, 'claim:mysenam-refund-test', 1, datetime('now', '-2 hours'))")
      .run(id);
    expect((await refundsInFlight(venueId)).find((r) => r.paymentId === id)).toMatchObject({ state: "asked", amount: 30 });
    expect((await checkIntegrity()).filter((p) => p.kind === "refund_unanswered").map((p) => p.detail).join()).toContain("pi_unanswered");
  });

  it("one owed for over a week is raised; one owed since yesterday is not yet", async () => {
    await payment("pi_overdue", 9, 30);
    await payment("pi_recent", 1, 30);
    const raised = (await checkIntegrity()).filter((p) => p.kind === "refund_overdue").map((p) => p.detail).join();
    expect(raised).toContain("pi_overdue");
    expect(raised).not.toContain("pi_recent");
  });
});
