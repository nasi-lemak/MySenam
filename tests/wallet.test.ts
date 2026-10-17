import { describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { registerUser } from "../src/lib/auth";
import { authenticateAdmin, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import {
  adminCancelBooking,
  cancelClassSession,
  cancelUserBooking,
  createBooking,
  createClassSessions,
  createCourt,
  enrolInClass,
  findUserForWallet,
  getWalletBalance,
  listWalletEntries,
  listVenues,
  payBookingFromWallet,
  refundBookingToWallet,
  claimPayment,
  setPaymentStatus,
  topUpWallet,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { MAX_TOP_UP } from "../src/lib/types";

const futureDate = (offset: number) => addDays(todayISO(), offset);
let seq = 0;

// Top-ups record which operator sold the credit, so a real admin must exist.
await ensureBootstrapAdmin();
const ADMIN_ID = (await authenticateAdmin("admin@mysenam.my", "mysenam-admin"))!.id;

async function customer(balance = 0) {
  seq++;
  const result = await registerUser({
    name: `Wallet User ${seq}`,
    email: `wallet${seq}@example.com`,
    phone: `0170000${String(seq).padStart(3, "0")}`,
    password: "password1",
  });
  if (!result.ok) throw new Error("user not created");
  if (balance > 0) await topUpWallet({ userId: result.user.id, amount: balance, adminId: ADMIN_ID });
  return result.user;
}

async function book(userId: number, phone: string, offset = 3, hour = 10) {
  const court = (await listVenues())[0].courts[0];
  return await createBooking({
    courtId: court.id,
    date: futureDate(offset),
    hours: [hour],
    name: "Wallet User",
    phone,
    userId,
  });
}

describe("the ledger", () => {
  it("starts empty and sums top-ups into a balance", async () => {
    const user = await customer();
    expect(await getWalletBalance(user.id)).toBe(0);

    expect(await topUpWallet({ userId: user.id, amount: 50, adminId: ADMIN_ID })).toMatchObject({
      ok: true,
      balance: 50,
    });
    expect(await topUpWallet({ userId: user.id, amount: 30, adminId: ADMIN_ID })).toMatchObject({
      ok: true,
      balance: 80,
    });
    expect(await getWalletBalance(user.id)).toBe(80);
    expect(await listWalletEntries(user.id)).toHaveLength(2);
  });

  it("rejects a nonsensical top-up or an unknown customer", async () => {
    const user = await customer();
    for (const amount of [0, -20, 1.5, MAX_TOP_UP + 1]) {
      expect(await topUpWallet({ userId: user.id, amount, adminId: ADMIN_ID }), String(amount)).toMatchObject({
        ok: false,
      });
    }
    expect(await topUpWallet({ userId: 99999, amount: 10, adminId: ADMIN_ID })).toMatchObject({
      ok: false,
      error: "Customer not found.",
    });
    expect(await getWalletBalance(user.id)).toBe(0);
  });

  it("finds a customer by email or phone for the counter", async () => {
    const user = await customer(25);
    expect(await findUserForWallet(user.email)).toMatchObject({ id: user.id, balance: 25 });
    expect(await findUserForWallet(user.phone)).toMatchObject({ id: user.id });
    expect(await findUserForWallet("nobody@example.com")).toBeNull();
    expect(await findUserForWallet("  ")).toBeNull();
  });
});

describe("paying from credit", () => {
  it("debits the balance and marks the booking paid", async () => {
    const user = await customer(100);
    const booking = await book(user.id, user.phone, 3, 10);
    expect(booking.ok).toBe(true);
    if (!booking.ok) return;
    const price = booking.booking.totalPrice;

    const paid = await payBookingFromWallet(booking.booking.id);
    expect(paid.ok).toBe(true);
    if (!paid.ok) return;
    expect(paid.balance).toBe(100 - price);
    expect(paid.entry.amount).toBe(-price);
    expect(paid.entry.reason).toContain(booking.booking.code);

    // paying twice is refused
    expect(await payBookingFromWallet(booking.booking.id)).toMatchObject({
      ok: false,
      error: "This booking is already paid.",
    });
    expect(await getWalletBalance(user.id)).toBe(100 - price);
  });

  it("never lets a balance go negative", async () => {
    const user = await customer(5);
    const booking = await book(user.id, user.phone, 4, 11);
    if (!booking.ok) return;
    expect(booking.booking.totalPrice).toBeGreaterThan(5);

    expect(await payBookingFromWallet(booking.booking.id)).toMatchObject({
      ok: false,
      error: expect.stringContaining("Not enough credit"),
    });
    expect(await getWalletBalance(user.id)).toBe(5);
    // and nothing was written to the ledger
    expect(await listWalletEntries(user.id)).toHaveLength(1);
  });

  it("refuses a guest booking, an unknown one, and a cancelled one", async () => {
    expect(await payBookingFromWallet(99999)).toMatchObject({ ok: false, error: "Booking not found." });

    const guest = await createBooking({
      courtId: (await listVenues())[0].courts[1].id,
      date: futureDate(5),
      hours: [12],
      name: "Guest",
      phone: "0179999999",
    });
    if (!guest.ok) return;
    expect(await payBookingFromWallet(guest.booking.id)).toMatchObject({
      ok: false,
      error: expect.stringContaining("no account"),
    });

    const user = await customer(100);
    const booking = await book(user.id, user.phone, 6, 13);
    if (!booking.ok) return;
    await adminCancelBooking(booking.booking.code);
    expect(await payBookingFromWallet(booking.booking.id)).toMatchObject({
      ok: false,
      error: "This booking was cancelled.",
    });
  });
});

describe("refunds", () => {
  it("returns the money when a wallet-paid booking is cancelled", async () => {
    const user = await customer(100);
    const booking = await book(user.id, user.phone, 7, 14);
    if (!booking.ok) return;
    const price = booking.booking.totalPrice;

    await payBookingFromWallet(booking.booking.id);
    expect(await getWalletBalance(user.id)).toBe(100 - price);

    expect(await cancelUserBooking(user.id, booking.booking.id)).toMatchObject({ ok: true });
    expect(await getWalletBalance(user.id)).toBe(100);
  });

  it("cannot be claimed twice, so a double cancel cannot mint credit", async () => {
    const user = await customer(100);
    const booking = await book(user.id, user.phone, 8, 15);
    if (!booking.ok) return;
    await payBookingFromWallet(booking.booking.id);

    expect(await refundBookingToWallet(booking.booking.id)).toMatchObject({ ok: true, balance: 100 });
    expect(await refundBookingToWallet(booking.booking.id)).toMatchObject({
      ok: false,
      error: expect.stringContaining("already been refunded"),
    });
    expect(await getWalletBalance(user.id)).toBe(100);
  });

  it("does nothing for a booking that was never paid from credit", async () => {
    const user = await customer(100);
    const booking = await book(user.id, user.phone, 9, 16);
    if (!booking.ok) return;

    expect(await refundBookingToWallet(booking.booking.id)).toMatchObject({
      ok: false,
      error: expect.stringContaining("not paid from credit"),
    });
    expect(await getWalletBalance(user.id)).toBe(100);
  });

  it("refunds enrolments when a class is cancelled", async () => {
    const user = await customer(100);
    const court = await createCourt({
      venueId: (await listVenues())[0].id,
      name: "Wallet Studio",
      sport: "gym",
      offPeakRate: 5,
      peakRate: 8,
      capacity: 6,
    });
    if (!court.ok) return;

    const session = await createClassSessions({
      courtId: court.court.id,
      name: "Pilates",
      instructor: "Nadia",
      date: futureDate(10),
      startHour: 11,
      endHour: 12,
      capacity: 4,
      price: 35,
    });
    if (!session.ok) return;
    const classId = session.classes[0].id;

    const enrolment = await enrolInClass({
      classId,
      name: user.name,
      phone: user.phone,
      userId: user.id,
    });
    expect(enrolment.ok).toBe(true);
    if (!enrolment.ok) return;

    // charged the class price, not the hourly rate
    expect(await payBookingFromWallet(enrolment.booking.id)).toMatchObject({ ok: true, balance: 65 });

    expect(await cancelClassSession(classId)).toMatchObject({ ok: true, released: 1 });
    expect(await getWalletBalance(user.id)).toBe(100);
  });
});

describe("a booking can only be paid for once", () => {
  it("refuses a second settlement, so nothing is charged twice", async () => {
    const user = await customer(500);
    const made = await book(user.id, user.phone, 3, 9);
    expect(made.ok).toBe(true);
    if (!made.ok) return;

    expect((await payBookingFromWallet(made.booking.id)).ok).toBe(true);
    const afterOne = await getWalletBalance(user.id);

    // Whatever route the second attempt comes in by, the booking is spoken for.
    const second = await payBookingFromWallet(made.booking.id);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("ALREADY_PAID");
    expect(await getWalletBalance(user.id)).toBe(afterOne);
  });

  it("takes nothing when the counter settles it first", async () => {
    const user = await customer(500);
    const made = await book(user.id, user.phone, 3, 11);
    if (!made.ok) return;

    await setPaymentStatus(made.booking.code, true);
    const before = await getWalletBalance(user.id);
    const entries = async () => (await listWalletEntries(user.id)).filter((e) => e.bookingId === made.booking.id);
    const had = (await entries()).length;

    const paid = await payBookingFromWallet(made.booking.id);
    expect(paid.ok).toBe(false);
    if (!paid.ok) expect(paid.code).toBe("ALREADY_PAID");
    expect(await getWalletBalance(user.id)).toBe(before);
    expect((await entries()).length).toBe(had);
  });
});

/**
 * The guard underneath the guard.
 *
 * Every payment path checks "already paid?" before opening its transaction,
 * and on one SQLite file with one writer that is enough — nothing can
 * interleave between the check and the write. `claimPayment` is what keeps it
 * true without that assumption, so it is tested on its own: through the public
 * functions the outer check always gets there first, and a test that went that
 * way would pass with the guard removed.
 */
describe("claiming a payment", () => {
  it("succeeds exactly once, however many times it is called", async () => {
    const user = await customer(500);
    const made = await book(user.id, user.phone, 4, 14);
    if (!made.ok) return;

    expect(await claimPayment(made.booking.id)).toBe(true);
    expect(await claimPayment(made.booking.id)).toBe(false);
    expect(await claimPayment(made.booking.id)).toBe(false);
  });

  it("will not claim a booking somebody already settled", async () => {
    const user = await customer(500);
    const made = await book(user.id, user.phone, 4, 15);
    if (!made.ok) return;
    await setPaymentStatus(made.booking.code, true);
    expect(await claimPayment(made.booking.id)).toBe(false);
  });

  it("claims again once a refund puts it back to unpaid", async () => {
    const user = await customer(500);
    const made = await book(user.id, user.phone, 4, 16);
    if (!made.ok) return;
    expect(await claimPayment(made.booking.id)).toBe(true);
    await setPaymentStatus(made.booking.code, false);
    expect(await claimPayment(made.booking.id)).toBe(true);
  });
});
