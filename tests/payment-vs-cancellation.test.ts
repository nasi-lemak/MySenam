import { describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { registerUser } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { authenticateAdmin, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import {
  adminCancelBooking,
  claimPayment,
  createBooking,
  createCourt,
  getWalletBalance,
  issuePass,
  listVenues,
  payBookingFromWallet,
  payBookingWithPass,
  topUpWallet,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Paying a booking from stored credit or a pass is decided with the booking's status, inside the paying
 * transaction and under the booking's row lock (ADR 0054): credit or entries are never taken for a booking that is
 * cancelled, and one cancelled just after is refunded by the usual path. The race shows on Postgres only
 * (`TEST_DATABASE_URL=postgres://… npx vitest run tests/payment-vs-cancellation.test.ts`).
 */

await ensureBootstrapAdmin();
const ADMIN_ID = (await authenticateAdmin("admin@mysenam.my", "mysenam-admin"))!.id;
let n = 0;

async function setup(name: string) {
  const venueId = (await listVenues())[0].id;
  const c = await createCourt({ venueId, name, sport: "badminton", offPeakRate: 15, peakRate: 25 });
  if (!c.ok) throw new Error("court");
  const reg = await registerUser({ name, email: `${name.replace(/\W/g, "")}${++n}@pay-cancel.test`, phone: `01611${String(10000 + n)}`, password: "password1" });
  if (!reg.ok) throw new Error("user");
  await topUpWallet({ userId: reg.user.id, amount: 1000, adminId: ADMIN_ID });
  return { court: c.court, user: reg.user };
}

describe("paying a booking that is cancelled", () => {
  it("claimPayment does not mark a cancelled booking paid", async () => {
    const { court, user } = await setup("Claim Court");
    const made = await createBooking({ courtId: court.id, date: addDays(todayISO(), 3), hours: [10], name: "X", phone: user.phone, userId: user.id });
    if (!made.ok) throw new Error("booking");
    expect((await adminCancelBooking(made.booking.code)).ok).toBe(true);
    expect(await claimPayment(made.booking.id, "credit")).toBe(false);
    expect(await claimPayment(made.booking.id, "pass")).toBe(false);
  });

  it("refuses to take credit for a cancelled booking and leaves the balance alone", async () => {
    const { court, user } = await setup("Credit Court");
    const made = await createBooking({ courtId: court.id, date: addDays(todayISO(), 3), hours: [11], name: "X", phone: user.phone, userId: user.id });
    if (!made.ok) throw new Error("booking");
    await adminCancelBooking(made.booking.code);
    const before = await getWalletBalance(user.id);
    expect(await payBookingFromWallet(made.booking.id)).toMatchObject({ ok: false, code: "BOOKING_WAS_CANCELLED" });
    expect(await getWalletBalance(user.id)).toBe(before);
  });

  it("refuses to spend a pass entry on a cancelled booking", async () => {
    const { court, user } = await setup("Pass Court");
    const venueId = (await listVenues())[0].id;
    const p = await issuePass({ venueId, name: "Five", entries: 5, price: 50, holderName: "Holder", holderPhone: user.phone, expiresOn: addDays(todayISO(), 60), adminId: null });
    if (!p.ok) throw new Error(JSON.stringify(p));
    const made = await createBooking({ courtId: court.id, date: addDays(todayISO(), 4), hours: [11], name: "X", phone: user.phone, userId: user.id });
    if (!made.ok) throw new Error("booking");
    await adminCancelBooking(made.booking.code);
    expect(await payBookingWithPass(made.booking.id, p.pass.code)).toMatchObject({ ok: false, code: "BOOKING_WAS_CANCELLED" });
    const spent = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM pass_entries WHERE booking_id = ? AND delta < 0").get(made.booking.id)) as { n: number };
    expect(spent.n).toBe(0);
  });

  it("paid, then cancelled: the credit goes back once (the existing refund path)", async () => {
    const { court, user } = await setup("Refund Court");
    const made = await createBooking({ courtId: court.id, date: addDays(todayISO(), 5), hours: [9], name: "X", phone: user.phone, userId: user.id });
    if (!made.ok) throw new Error("booking");
    const before = await getWalletBalance(user.id);
    expect((await payBookingFromWallet(made.booking.id)).ok).toBe(true);
    expect(await getWalletBalance(user.id)).toBeLessThan(before);
    await adminCancelBooking(made.booking.code);
    expect(await getWalletBalance(user.id)).toBe(before);
  });

  it("stress: paying from credit while the venue cancels never leaves credit taken for a cancelled booking", async () => {
    const { court, user } = await setup("Stress Court");
    let bad = 0;
    for (let i = 0; i < 30; i++) {
      const made = await createBooking({ courtId: court.id, date: addDays(todayISO(), 4 + (i % 10)), hours: [8 + Math.floor(i / 10)], name: "Stress", phone: user.phone, userId: user.id });
      if (!made.ok) continue;
      const before = await getWalletBalance(user.id);
      await Promise.all([payBookingFromWallet(made.booking.id), adminCancelBooking(made.booking.code)]);
      const row = (await getDb().prepare("SELECT status FROM bookings WHERE id = ?").get(made.booking.id)) as { status: string };
      // Cancelled, whichever came first: the credit is whole again.
      if (row.status === "cancelled" && (await getWalletBalance(user.id)) !== before) bad++;
    }
    expect(bad).toBe(0);
  });

  it("stress: the same with a pass", async () => {
    const { court, user } = await setup("Pass Stress");
    const venueId = (await listVenues())[0].id;
    const p = await issuePass({ venueId, name: "Many", entries: 40, price: 400, holderName: "Holder", holderPhone: user.phone, expiresOn: addDays(todayISO(), 60), adminId: null });
    if (!p.ok) throw new Error(JSON.stringify(p));
    let bad = 0;
    for (let i = 0; i < 20; i++) {
      const made = await createBooking({ courtId: court.id, date: addDays(todayISO(), 4 + (i % 10)), hours: [8 + Math.floor(i / 10)], name: "Stress", phone: user.phone, userId: user.id });
      if (!made.ok) continue;
      await Promise.all([payBookingWithPass(made.booking.id, p.pass.code), adminCancelBooking(made.booking.code)]);
      const net = (await getDb().prepare("SELECT COALESCE(SUM(delta), 0)::int AS net FROM pass_entries WHERE booking_id = ?").get(made.booking.id)) as { net: number };
      const row = (await getDb().prepare("SELECT status FROM bookings WHERE id = ?").get(made.booking.id)) as { status: string };
      if (row.status === "cancelled" && net.net !== 0) bad++;
    }
    expect(bad).toBe(0);
  });
});
