import { afterEach, beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { registerUser } from "../src/lib/auth";
import { ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import {
  adminCancelBooking,
  createBooking,
  createCourt,
  createVenue,
  getWalletBalance,
  listVenues,
  payBookingFromWallet,
  topUpWallet,
  walletBalances,
} from "../src/lib/store";
import { venueCreditLiability, walletLiability } from "../src/lib/reports";
import { creditScope } from "../src/lib/mode";
import { getDb } from "../src/lib/db";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Whose stored credit is.
 *
 * On a marketplace, credit bought at one venue is that venue's: spendable
 * there, owed by it. Credit from before an install switched over stays
 * spendable anywhere, so nobody's balance shrinks overnight.
 */

let adminId: number;
let venueA: number;
let venueB: number;
let courtA: number;
let courtB: number;
let n = 0;

async function customer() {
  const made = await registerUser({
    name: `Customer ${++n}`,
    email: `credit${n}@example.com`,
    phone: `01900000${String(n).padStart(2, "0")}`,
    password: "correct horse battery",
  });
  if (!made.ok) throw new Error(made.error);
  return made.user;
}

async function bookAt(courtId: number, userId: number, phone: string) {
  const made = await createBooking({
    courtId,
    date: addDays(todayISO(), 1 + (n % 10)),
    hours: [8 + (n % 12)],
    name: "Somebody",
    phone,
    userId,
  });
  if (!made.ok) throw new Error(made.error);
  return made.booking;
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  adminId = (await listAdmins())[0].id;
  venueA = (await listVenues())[0].id;
  courtA = (await listVenues())[0].courts.find((c) => c.capacity === 1)!.id;
  const b = await createVenue({ name: "Other Business", area: "Klang", address: "x", phone: "0300000000" });
  if (!b.ok) throw new Error("venue");
  venueB = b.venue.id;
  const c = await createCourt({ venueId: venueB, name: "Court B", sport: "badminton", offPeakRate: 10, peakRate: 10 });
  if (!c.ok) throw new Error("court");
  courtB = c.court.id;
});

afterEach(() => {
  delete process.env.MYSENAM_CREDIT_SCOPE;
  delete process.env.MYSENAM_MARKETPLACE;
});

describe("which way it is", () => {
  it("is platform-wide unless the install is a marketplace", () => {
    expect(creditScope()).toBe("platform");
    process.env.MYSENAM_MARKETPLACE = "on";
    expect(creditScope()).toBe("venue");
    process.env.MYSENAM_CREDIT_SCOPE = "platform";
    expect(creditScope()).toBe("platform");
  });
});

describe("platform-wide credit", () => {
  it("is bought anywhere and spent anywhere, as it always was", async () => {
    const user = await customer();
    await topUpWallet({ userId: user.id, amount: 50, adminId });
    const booking = await bookAt(courtB, user.id, user.phone);
    expect((await payBookingFromWallet(booking.id)).ok).toBe(true);
    expect(await getWalletBalance(user.id)).toBe(50 - booking.totalPrice);
    // Nothing is tagged to a venue, so a later switch finds it all spendable anywhere.
    const tagged = await getDb()
      .prepare("SELECT COUNT(*) AS n FROM wallet_entries WHERE user_id = ? AND venue_id IS NOT NULL")
      .get(user.id) as { n: number };
    expect(tagged.n).toBe(0);
  });
});

describe("per-venue credit", () => {
  it("must say which venue sold it", async () => {
    process.env.MYSENAM_CREDIT_SCOPE = "venue";
    const user = await customer();
    expect((await topUpWallet({ userId: user.id, amount: 50, adminId })).ok).toBe(false);
    expect((await topUpWallet({ userId: user.id, amount: 50, adminId, venueId: venueA })).ok).toBe(true);
  });

  it("is spendable only at the venue that sold it", async () => {
    process.env.MYSENAM_CREDIT_SCOPE = "venue";
    const user = await customer();
    await topUpWallet({ userId: user.id, amount: 100, adminId, venueId: venueA });

    expect(await getWalletBalance(user.id, venueA)).toBe(100);
    expect(await getWalletBalance(user.id, venueB)).toBe(0);

    const elsewhere = await bookAt(courtB, user.id, user.phone);
    const refused = await payBookingFromWallet(elsewhere.id);
    expect(refused.ok).toBe(false);

    const here = await bookAt(courtA, user.id, user.phone);
    expect((await payBookingFromWallet(here.id)).ok).toBe(true);
    expect(await getWalletBalance(user.id, venueA)).toBe(100 - here.totalPrice);
  });

  it("keeps older credit spendable anywhere, and spends the venue's own first", async () => {
    const user = await customer();
    // Bought before the switch: platform-wide.
    await topUpWallet({ userId: user.id, amount: 30, adminId });
    process.env.MYSENAM_CREDIT_SCOPE = "venue";
    await topUpWallet({ userId: user.id, amount: 5, adminId, venueId: venueA });

    expect(await getWalletBalance(user.id, venueA)).toBe(35);
    expect(await getWalletBalance(user.id, venueB)).toBe(30);

    const booking = await bookAt(courtA, user.id, user.phone);
    expect(booking.totalPrice).toBeGreaterThan(5);
    expect((await payBookingFromWallet(booking.id)).ok).toBe(true);

    // The venue's own 5 went first; the rest came from the older credit.
    const pots = Object.fromEntries((await walletBalances(user.id)).map((b) => [b.venueId ?? "any", b.balance]));
    expect(pots[venueA]).toBeUndefined();
    expect(pots.any).toBe(30 - (booking.totalPrice - 5));

    // Cancelling puts each part back where it came from.
    await adminCancelBooking(booking.code);
    const after = Object.fromEntries((await walletBalances(user.id)).map((b) => [b.venueId ?? "any", b.balance]));
    expect(after[venueA]).toBe(5);
    expect(after.any).toBe(30);
  });

  it("is owed by the venue that sold it, not the platform", async () => {
    process.env.MYSENAM_CREDIT_SCOPE = "venue";
    const before = (await venueCreditLiability(venueB)).balance;
    const platformBefore = (await walletLiability()).balance;
    const user = await customer();
    await topUpWallet({ userId: user.id, amount: 40, adminId, venueId: venueB });
    expect((await venueCreditLiability(venueB)).balance).toBe(before + 40);
    expect((await walletLiability()).balance).toBe(platformBefore);
  });
});
