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
  topUpWallet,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { MAX_TOP_UP } from "../src/lib/types";

const futureDate = (offset: number) => addDays(todayISO(), offset);
let seq = 0;

// Top-ups record which operator sold the credit, so a real admin must exist.
ensureBootstrapAdmin();
const ADMIN_ID = authenticateAdmin("admin@mysenam.my", "mysenam-admin")!.id;

function customer(balance = 0) {
  seq++;
  const result = registerUser({
    name: `Wallet User ${seq}`,
    email: `wallet${seq}@example.com`,
    phone: `0170000${String(seq).padStart(3, "0")}`,
    password: "password1",
  });
  if (!result.ok) throw new Error("user not created");
  if (balance > 0) topUpWallet({ userId: result.user.id, amount: balance, adminId: ADMIN_ID });
  return result.user;
}

function book(userId: number, phone: string, offset = 3, hour = 10) {
  const court = listVenues()[0].courts[0];
  return createBooking({
    courtId: court.id,
    date: futureDate(offset),
    hours: [hour],
    name: "Wallet User",
    phone,
    userId,
  });
}

describe("the ledger", () => {
  it("starts empty and sums top-ups into a balance", () => {
    const user = customer();
    expect(getWalletBalance(user.id)).toBe(0);

    expect(topUpWallet({ userId: user.id, amount: 50, adminId: ADMIN_ID })).toMatchObject({
      ok: true,
      balance: 50,
    });
    expect(topUpWallet({ userId: user.id, amount: 30, adminId: ADMIN_ID })).toMatchObject({
      ok: true,
      balance: 80,
    });
    expect(getWalletBalance(user.id)).toBe(80);
    expect(listWalletEntries(user.id)).toHaveLength(2);
  });

  it("rejects a nonsensical top-up or an unknown customer", () => {
    const user = customer();
    for (const amount of [0, -20, 1.5, MAX_TOP_UP + 1]) {
      expect(topUpWallet({ userId: user.id, amount, adminId: ADMIN_ID }), String(amount)).toMatchObject({
        ok: false,
      });
    }
    expect(topUpWallet({ userId: 99999, amount: 10, adminId: ADMIN_ID })).toMatchObject({
      ok: false,
      error: "Customer not found.",
    });
    expect(getWalletBalance(user.id)).toBe(0);
  });

  it("finds a customer by email or phone for the counter", () => {
    const user = customer(25);
    expect(findUserForWallet(user.email)).toMatchObject({ id: user.id, balance: 25 });
    expect(findUserForWallet(user.phone)).toMatchObject({ id: user.id });
    expect(findUserForWallet("nobody@example.com")).toBeNull();
    expect(findUserForWallet("  ")).toBeNull();
  });
});

describe("paying from credit", () => {
  it("debits the balance and marks the booking paid", () => {
    const user = customer(100);
    const booking = book(user.id, user.phone, 3, 10);
    expect(booking.ok).toBe(true);
    if (!booking.ok) return;
    const price = booking.booking.totalPrice;

    const paid = payBookingFromWallet(booking.booking.id);
    expect(paid.ok).toBe(true);
    if (!paid.ok) return;
    expect(paid.balance).toBe(100 - price);
    expect(paid.entry.amount).toBe(-price);
    expect(paid.entry.reason).toContain(booking.booking.code);

    // paying twice is refused
    expect(payBookingFromWallet(booking.booking.id)).toMatchObject({
      ok: false,
      error: "This booking is already paid.",
    });
    expect(getWalletBalance(user.id)).toBe(100 - price);
  });

  it("never lets a balance go negative", () => {
    const user = customer(5);
    const booking = book(user.id, user.phone, 4, 11);
    if (!booking.ok) return;
    expect(booking.booking.totalPrice).toBeGreaterThan(5);

    expect(payBookingFromWallet(booking.booking.id)).toMatchObject({
      ok: false,
      error: expect.stringContaining("Not enough credit"),
    });
    expect(getWalletBalance(user.id)).toBe(5);
    // and nothing was written to the ledger
    expect(listWalletEntries(user.id)).toHaveLength(1);
  });

  it("refuses a guest booking, an unknown one, and a cancelled one", () => {
    expect(payBookingFromWallet(99999)).toMatchObject({ ok: false, error: "Booking not found." });

    const guest = createBooking({
      courtId: listVenues()[0].courts[1].id,
      date: futureDate(5),
      hours: [12],
      name: "Guest",
      phone: "0179999999",
    });
    if (!guest.ok) return;
    expect(payBookingFromWallet(guest.booking.id)).toMatchObject({
      ok: false,
      error: expect.stringContaining("no account"),
    });

    const user = customer(100);
    const booking = book(user.id, user.phone, 6, 13);
    if (!booking.ok) return;
    adminCancelBooking(booking.booking.code);
    expect(payBookingFromWallet(booking.booking.id)).toMatchObject({
      ok: false,
      error: "This booking was cancelled.",
    });
  });
});

describe("refunds", () => {
  it("returns the money when a wallet-paid booking is cancelled", () => {
    const user = customer(100);
    const booking = book(user.id, user.phone, 7, 14);
    if (!booking.ok) return;
    const price = booking.booking.totalPrice;

    payBookingFromWallet(booking.booking.id);
    expect(getWalletBalance(user.id)).toBe(100 - price);

    expect(cancelUserBooking(user.id, booking.booking.id)).toMatchObject({ ok: true });
    expect(getWalletBalance(user.id)).toBe(100);
  });

  it("cannot be claimed twice, so a double cancel cannot mint credit", () => {
    const user = customer(100);
    const booking = book(user.id, user.phone, 8, 15);
    if (!booking.ok) return;
    payBookingFromWallet(booking.booking.id);

    expect(refundBookingToWallet(booking.booking.id)).toMatchObject({ ok: true, balance: 100 });
    expect(refundBookingToWallet(booking.booking.id)).toMatchObject({
      ok: false,
      error: expect.stringContaining("already been refunded"),
    });
    expect(getWalletBalance(user.id)).toBe(100);
  });

  it("does nothing for a booking that was never paid from credit", () => {
    const user = customer(100);
    const booking = book(user.id, user.phone, 9, 16);
    if (!booking.ok) return;

    expect(refundBookingToWallet(booking.booking.id)).toMatchObject({
      ok: false,
      error: expect.stringContaining("not paid from credit"),
    });
    expect(getWalletBalance(user.id)).toBe(100);
  });

  it("refunds enrolments when a class is cancelled", () => {
    const user = customer(100);
    const court = createCourt({
      venueId: listVenues()[0].id,
      name: "Wallet Studio",
      sport: "gym",
      offPeakRate: 5,
      peakRate: 8,
      capacity: 6,
    });
    if (!court.ok) return;

    const session = createClassSessions({
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

    const enrolment = enrolInClass({
      classId,
      name: user.name,
      phone: user.phone,
      userId: user.id,
    });
    expect(enrolment.ok).toBe(true);
    if (!enrolment.ok) return;

    // charged the class price, not the hourly rate
    expect(payBookingFromWallet(enrolment.booking.id)).toMatchObject({ ok: true, balance: 65 });

    expect(cancelClassSession(classId)).toMatchObject({ ok: true, released: 1 });
    expect(getWalletBalance(user.id)).toBe(100);
  });
});
