import { beforeEach, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import {
  adminCancelBooking,
  cancelBooking,
  createBooking,
  getPass,
  issuePass,
  listPassEntries,
  listPassesFor,
  listPassesForVenue,
  listVenues,
  payBookingWithPass,
  refundBookingToPass,
  voidPass,
} from "../src/lib/store";
import { authenticateAdmin, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { registerUser } from "../src/lib/auth";
import { addDays, todayISO } from "../src/lib/time";
import { MAX_PASS_ENTRIES } from "../src/lib/types";

const PHONE = "0123456789";
const OTHER_PHONE = "0198887777";

await ensureBootstrapAdmin();
const ADMIN_ID = (await authenticateAdmin("admin@mysenam.my", "mysenam-admin"))!.id;

function futureDate(offset = 3): string {
  return addDays(todayISO(), offset);
}

async function sell(over: Partial<Parameters<typeof issuePass>[0]> = {}) {
  const venue = (await listVenues())[0];
  const result = await issuePass({
    venueId: venue.id,
    sport: "badminton",
    name: "10-hour badminton pass",
    entries: 10,
    price: 120,
    holderName: "Aisyah",
    holderPhone: PHONE,
    expiresOn: addDays(todayISO(), 90),
    adminId: ADMIN_ID,
    ...over,
  });
  if (!result.ok) throw new Error(result.error);
  return result.pass;
}

async function book(hours: number[], phone = PHONE, offset = 3) {
  const court = (await listVenues())[0].courts[0];
  const made = await createBooking({
    courtId: court.id,
    date: futureDate(offset),
    hours,
    name: "Aisyah",
    phone,
  });
  if (!made.ok) throw new Error(made.error);
  return made.booking;
}

describe("issuing a pass", () => {
  it("records the sale and starts with every entry unspent", async () => {
    const pass = await sell();
    expect(pass.code).toMatch(/^PS-[A-Z2-9]{6}$/);
    expect(pass).toMatchObject({ entries: 10, remaining: 10, status: "active", price: 120 });
    expect(pass.unusableReason).toBeUndefined();
    expect((await getPass(pass.code))?.id).toBe(pass.id);
    // Codes are matched case-insensitively, like booking codes.
    expect((await getPass(pass.code.toLowerCase()))?.id).toBe(pass.id);
  });

  it("refuses nonsense", async () => {
    const venue = (await listVenues())[0];
    const base = {
      venueId: venue.id,
      name: "Pass",
      entries: 10,
      price: 100,
      holderName: "Aisyah",
      holderPhone: PHONE,
      expiresOn: addDays(todayISO(), 30),
      adminId: ADMIN_ID,
    };
    expect(await issuePass({ ...base, venueId: 9999 })).toMatchObject({ ok: false, error: "Venue not found." });
    expect(await issuePass({ ...base, entries: 0 })).toMatchObject({ ok: false });
    expect(await issuePass({ ...base, entries: MAX_PASS_ENTRIES + 1 })).toMatchObject({ ok: false });
    expect(await issuePass({ ...base, price: -1 })).toMatchObject({ ok: false });
    expect(await issuePass({ ...base, holderName: "A", holderPhone: "123" })).toMatchObject({ ok: false });
    expect(await issuePass({ ...base, expiresOn: "not-a-date" })).toMatchObject({ ok: false });
    expect(await issuePass({ ...base, expiresOn: addDays(todayISO(), -1) })).toMatchObject({
      ok: false,
      error: "The expiry date has already passed.",
    });
    expect(await issuePass({ ...base, expiresOn: addDays(todayISO(), 365 * 5) })).toMatchObject({ ok: false });
    // The seeded first venue has no tennis courts.
    expect(await issuePass({ ...base, sport: "tennis" })).toMatchObject({
      ok: false,
      error: "That venue has no courts for that sport.",
    });
  });

  it("is still good on its expiry date, and dead the day after", async () => {
    const expiringToday = await sell({ expiresOn: todayISO() });
    expect(expiringToday.unusableReason).toBeUndefined();

    // issuePass refuses a past date, so back-date the row to age the pass the
    // way time would, then read it again.
    const lapsed = await sell();
    await getDb()
      .prepare("UPDATE passes SET expires_on = ? WHERE id = ?")
      .run(addDays(todayISO(), -1), lapsed.id);
    expect((await getPass(lapsed.code))?.unusableReason).toBe(
      `This pass expired on ${addDays(todayISO(), -1)}.`
    );
  });
});

describe("spending a pass", () => {
  it("takes one entry per booked hour, all or nothing", async () => {
    const pass = await sell();
    const booking = await book([10, 11]);

    const paid = await payBookingWithPass(booking.id, pass.code);
    expect(paid).toMatchObject({ ok: true, spent: 2 });
    if (!paid.ok) return;
    expect(paid.pass.remaining).toBe(8);
    expect((await getPass(pass.code))?.remaining).toBe(8);

    const entries = await listPassEntries(pass.id);
    expect(entries[0]).toMatchObject({ delta: -2, bookingId: booking.id });
  });

  it("refuses a booking bigger than what is left", async () => {
    const pass = await sell({ entries: 1 });
    const booking = await book([14, 15, 16]);
    expect(await payBookingWithPass(booking.id, pass.code)).toMatchObject({
      ok: false,
      error: "This pass has 1 entry left, and this booking needs 3.",
    });
    // Nothing was taken.
    expect((await getPass(pass.code))?.remaining).toBe(1);
  });

  it("will not pay the same booking twice", async () => {
    const pass = await sell();
    const booking = await book([9]);
    expect(await payBookingWithPass(booking.id, pass.code)).toMatchObject({ ok: true });
    expect(await payBookingWithPass(booking.id, pass.code)).toMatchObject({
      ok: false,
      error: "This booking is already paid.",
    });
    expect((await getPass(pass.code))?.remaining).toBe(9);
  });

  it("refuses a pass belonging to someone else", async () => {
    const pass = await sell();
    const booking = await book([13], OTHER_PHONE);
    expect(await payBookingWithPass(booking.id, pass.code)).toMatchObject({
      ok: false,
      error: "That pass belongs to a different phone number.",
    });
  });

  it("refuses a pass from another venue or another sport", async () => {
    const elsewhere = await sell({ venueId: (await listVenues())[1].id });
    const booking = await book([12]);
    expect(await payBookingWithPass(booking.id, elsewhere.code)).toMatchObject({
      ok: false,
      error: "That pass is for a different venue.",
    });

    const gymOnly = await sell({ sport: "gym" });
    const badmintonBooking = await book([21]);
    expect(await payBookingWithPass(badmintonBooking.id, gymOnly.code)).toMatchObject({
      ok: false,
      error: "That pass only covers Gym.",
    });
  });

  it("refuses an unknown pass, a cancelled pass and a spent one", async () => {
    const booking = await book([17]);
    expect(await payBookingWithPass(booking.id, "PS-NOSUCH")).toMatchObject({
      ok: false,
      error: "Pass not found.",
    });

    const cancelled = await sell();
    expect(await voidPass(cancelled.id)).toMatchObject({ ok: true, pass: { status: "void" } });
    expect(await voidPass(cancelled.id)).toMatchObject({ ok: false });
    expect(await payBookingWithPass(booking.id, cancelled.code)).toMatchObject({
      ok: false,
      error: "This pass was cancelled.",
    });

    const empty = await sell({ entries: 1 });
    const first = await book([18]);
    expect(await payBookingWithPass(first.id, empty.code)).toMatchObject({ ok: true });
    expect(await getPass(empty.code)).toMatchObject({
      remaining: 0,
      unusableReason: "This pass has no entries left.",
    });
    expect(await payBookingWithPass(booking.id, empty.code)).toMatchObject({
      ok: false,
      error: "This pass has no entries left.",
    });
  });

  it("refuses a pass that lapsed between issue and use", async () => {
    const pass = await sell();
    const booking = await book([22]);
    const yesterday = addDays(todayISO(), -1);
    await getDb().prepare("UPDATE passes SET expires_on = ? WHERE id = ?").run(yesterday, pass.id);
    expect(await payBookingWithPass(booking.id, pass.code)).toMatchObject({
      ok: false,
      error: `This pass expired on ${yesterday}.`,
    });
    expect((await getPass(pass.code))?.remaining).toBe(10);
  });

  it("matches the holder on digits, not on formatting", async () => {
    const pass = await sell({ holderPhone: "+60 12-345 6789" });
    const booking = await book([19], "0123456789");
    expect(await payBookingWithPass(booking.id, pass.code)).toMatchObject({ ok: true });
  });
});

describe("returning entries", () => {
  it("gives the entries back when the booking is cancelled", async () => {
    const pass = await sell();
    const booking = await book([10, 11], PHONE, 5);
    expect(await payBookingWithPass(booking.id, pass.code)).toMatchObject({ ok: true });
    expect((await getPass(pass.code))?.remaining).toBe(8);

    expect(await cancelBooking(booking.code, PHONE)).toMatchObject({ ok: true });
    expect((await getPass(pass.code))?.remaining).toBe(10);
  });

  it("refuses to refund twice, so a double cancellation cannot mint entries", async () => {
    const pass = await sell();
    const booking = await book([14], PHONE, 6);
    await payBookingWithPass(booking.id, pass.code);
    expect(await refundBookingToPass(booking.id)).toMatchObject({ ok: true });
    expect((await getPass(pass.code))?.remaining).toBe(10);
    expect(await refundBookingToPass(booking.id)).toMatchObject({
      ok: false,
      error: "This booking has already been refunded.",
    });
    expect((await getPass(pass.code))?.remaining).toBe(10);
  });

  it("refunds on an admin cancellation too", async () => {
    const pass = await sell();
    const booking = await book([15, 16], PHONE, 7);
    await payBookingWithPass(booking.id, pass.code);
    expect((await getPass(pass.code))?.remaining).toBe(8);
    expect(await adminCancelBooking(booking.code)).toMatchObject({ ok: true });
    expect((await getPass(pass.code))?.remaining).toBe(10);
  });

  it("says nothing to refund for a booking that was not pass-paid", async () => {
    const booking = await book([20], PHONE, 8);
    expect(await refundBookingToPass(booking.id)).toMatchObject({
      ok: false,
      error: "This booking was not paid with a pass.",
    });
  });
});

describe("finding a customer's passes", () => {
  beforeEach(() => {
    // Nothing to reset: each test sells its own passes.
  });

  it("lists an account's passes, newest first, and keeps spent ones visible", async () => {
    const phone = "0175550000";
    const holder = await registerUser({
      name: "Pass Holder",
      email: "pass-holder@example.com",
      phone,
      password: "a-password",
    });
    if (!holder.ok) throw new Error(holder.error);
    const first = await sell({ holderPhone: phone, name: "Old pass", userId: holder.user.id });
    const second = await sell({ holderPhone: phone, name: "New pass", userId: holder.user.id });
    // Sold against the same number but never linked to the account.
    const unlinked = await sell({ holderPhone: phone, name: "Counter pass" });

    const mine = await listPassesFor(holder.user.id);
    expect(mine.map((p) => p.id)).toEqual([second.id, first.id]);
    expect(mine.map((p) => p.id)).not.toContain(unlinked.id);
  });


  it("lists a venue's own passes for the counter", async () => {
    const venue = (await listVenues())[2];
    const pass = await sell({ venueId: venue.id, sport: null, name: "Bangsar 5-pack", entries: 5 });
    const listed = await listPassesForVenue(venue.id);
    expect(listed[0].id).toBe(pass.id);
    expect(listed.every((p) => p.venueId === venue.id)).toBe(true);
  });
});
