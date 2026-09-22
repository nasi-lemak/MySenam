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
  usablePassesFor,
  voidPass,
} from "../src/lib/store";
import { authenticateAdmin, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { addDays, todayISO } from "../src/lib/time";
import { MAX_PASS_ENTRIES } from "../src/lib/types";

const PHONE = "0123456789";
const OTHER_PHONE = "0198887777";

ensureBootstrapAdmin();
const ADMIN_ID = authenticateAdmin("admin@mysenam.my", "mysenam-admin")!.id;

function futureDate(offset = 3): string {
  return addDays(todayISO(), offset);
}

function sell(over: Partial<Parameters<typeof issuePass>[0]> = {}) {
  const venue = listVenues()[0];
  const result = issuePass({
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

function book(hours: number[], phone = PHONE, offset = 3) {
  const court = listVenues()[0].courts[0];
  const made = createBooking({
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
  it("records the sale and starts with every entry unspent", () => {
    const pass = sell();
    expect(pass.code).toMatch(/^PS-[A-Z2-9]{6}$/);
    expect(pass).toMatchObject({ entries: 10, remaining: 10, status: "active", price: 120 });
    expect(pass.unusableReason).toBeUndefined();
    expect(getPass(pass.code)?.id).toBe(pass.id);
    // Codes are matched case-insensitively, like booking codes.
    expect(getPass(pass.code.toLowerCase())?.id).toBe(pass.id);
  });

  it("refuses nonsense", () => {
    const venue = listVenues()[0];
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
    expect(issuePass({ ...base, venueId: 9999 })).toMatchObject({ ok: false, error: "Venue not found." });
    expect(issuePass({ ...base, entries: 0 })).toMatchObject({ ok: false });
    expect(issuePass({ ...base, entries: MAX_PASS_ENTRIES + 1 })).toMatchObject({ ok: false });
    expect(issuePass({ ...base, price: -1 })).toMatchObject({ ok: false });
    expect(issuePass({ ...base, holderName: "A", holderPhone: "123" })).toMatchObject({ ok: false });
    expect(issuePass({ ...base, expiresOn: "not-a-date" })).toMatchObject({ ok: false });
    expect(issuePass({ ...base, expiresOn: addDays(todayISO(), -1) })).toMatchObject({
      ok: false,
      error: "The expiry date has already passed.",
    });
    expect(issuePass({ ...base, expiresOn: addDays(todayISO(), 365 * 5) })).toMatchObject({ ok: false });
    // The seeded first venue has no tennis courts.
    expect(issuePass({ ...base, sport: "tennis" })).toMatchObject({
      ok: false,
      error: "That venue has no courts for that sport.",
    });
  });

  it("is still good on its expiry date, and dead the day after", () => {
    const expiringToday = sell({ expiresOn: todayISO() });
    expect(expiringToday.unusableReason).toBeUndefined();

    // issuePass refuses a past date, so back-date the row to age the pass the
    // way time would, then read it again.
    const lapsed = sell();
    getDb()
      .prepare("UPDATE passes SET expires_on = ? WHERE id = ?")
      .run(addDays(todayISO(), -1), lapsed.id);
    expect(getPass(lapsed.code)?.unusableReason).toBe(
      `This pass expired on ${addDays(todayISO(), -1)}.`
    );
  });
});

describe("spending a pass", () => {
  it("takes one entry per booked hour, all or nothing", () => {
    const pass = sell();
    const booking = book([10, 11]);

    const paid = payBookingWithPass(booking.id, pass.code);
    expect(paid).toMatchObject({ ok: true, spent: 2 });
    if (!paid.ok) return;
    expect(paid.pass.remaining).toBe(8);
    expect(getPass(pass.code)?.remaining).toBe(8);

    const entries = listPassEntries(pass.id);
    expect(entries[0]).toMatchObject({ delta: -2, bookingId: booking.id });
  });

  it("refuses a booking bigger than what is left", () => {
    const pass = sell({ entries: 1 });
    const booking = book([14, 15, 16]);
    expect(payBookingWithPass(booking.id, pass.code)).toMatchObject({
      ok: false,
      error: "This pass has 1 entry left, and this booking needs 3.",
    });
    // Nothing was taken.
    expect(getPass(pass.code)?.remaining).toBe(1);
  });

  it("will not pay the same booking twice", () => {
    const pass = sell();
    const booking = book([9]);
    expect(payBookingWithPass(booking.id, pass.code)).toMatchObject({ ok: true });
    expect(payBookingWithPass(booking.id, pass.code)).toMatchObject({
      ok: false,
      error: "This booking is already paid.",
    });
    expect(getPass(pass.code)?.remaining).toBe(9);
  });

  it("refuses a pass belonging to someone else", () => {
    const pass = sell();
    const booking = book([13], OTHER_PHONE);
    expect(payBookingWithPass(booking.id, pass.code)).toMatchObject({
      ok: false,
      error: "That pass belongs to a different phone number.",
    });
  });

  it("refuses a pass from another venue or another sport", () => {
    const elsewhere = sell({ venueId: listVenues()[1].id });
    const booking = book([12]);
    expect(payBookingWithPass(booking.id, elsewhere.code)).toMatchObject({
      ok: false,
      error: "That pass is for a different venue.",
    });

    const gymOnly = sell({ sport: "gym" });
    const badmintonBooking = book([21]);
    expect(payBookingWithPass(badmintonBooking.id, gymOnly.code)).toMatchObject({
      ok: false,
      error: "That pass only covers Gym.",
    });
  });

  it("refuses an unknown pass, a cancelled pass and a spent one", () => {
    const booking = book([17]);
    expect(payBookingWithPass(booking.id, "PS-NOSUCH")).toMatchObject({
      ok: false,
      error: "Pass not found.",
    });

    const cancelled = sell();
    expect(voidPass(cancelled.id)).toMatchObject({ ok: true, pass: { status: "void" } });
    expect(voidPass(cancelled.id)).toMatchObject({ ok: false });
    expect(payBookingWithPass(booking.id, cancelled.code)).toMatchObject({
      ok: false,
      error: "This pass was cancelled.",
    });

    const empty = sell({ entries: 1 });
    const first = book([18]);
    expect(payBookingWithPass(first.id, empty.code)).toMatchObject({ ok: true });
    expect(getPass(empty.code)).toMatchObject({
      remaining: 0,
      unusableReason: "This pass has no entries left.",
    });
    expect(payBookingWithPass(booking.id, empty.code)).toMatchObject({
      ok: false,
      error: "This pass has no entries left.",
    });
  });

  it("refuses a pass that lapsed between issue and use", () => {
    const pass = sell();
    const booking = book([22]);
    const yesterday = addDays(todayISO(), -1);
    getDb().prepare("UPDATE passes SET expires_on = ? WHERE id = ?").run(yesterday, pass.id);
    expect(payBookingWithPass(booking.id, pass.code)).toMatchObject({
      ok: false,
      error: `This pass expired on ${yesterday}.`,
    });
    expect(getPass(pass.code)?.remaining).toBe(10);
  });

  it("matches the holder on digits, not on formatting", () => {
    const pass = sell({ holderPhone: "+60 12-345 6789" });
    const booking = book([19], "0123456789");
    expect(payBookingWithPass(booking.id, pass.code)).toMatchObject({ ok: true });
  });
});

describe("returning entries", () => {
  it("gives the entries back when the booking is cancelled", () => {
    const pass = sell();
    const booking = book([10, 11], PHONE, 5);
    expect(payBookingWithPass(booking.id, pass.code)).toMatchObject({ ok: true });
    expect(getPass(pass.code)?.remaining).toBe(8);

    expect(cancelBooking(booking.code, PHONE)).toMatchObject({ ok: true });
    expect(getPass(pass.code)?.remaining).toBe(10);
  });

  it("refuses to refund twice, so a double cancellation cannot mint entries", () => {
    const pass = sell();
    const booking = book([14], PHONE, 6);
    payBookingWithPass(booking.id, pass.code);
    expect(refundBookingToPass(booking.id)).toMatchObject({ ok: true });
    expect(getPass(pass.code)?.remaining).toBe(10);
    expect(refundBookingToPass(booking.id)).toMatchObject({
      ok: false,
      error: "This booking has already been refunded.",
    });
    expect(getPass(pass.code)?.remaining).toBe(10);
  });

  it("refunds on an admin cancellation too", () => {
    const pass = sell();
    const booking = book([15, 16], PHONE, 7);
    payBookingWithPass(booking.id, pass.code);
    expect(getPass(pass.code)?.remaining).toBe(8);
    expect(adminCancelBooking(booking.code)).toMatchObject({ ok: true });
    expect(getPass(pass.code)?.remaining).toBe(10);
  });

  it("says nothing to refund for a booking that was not pass-paid", () => {
    const booking = book([20], PHONE, 8);
    expect(refundBookingToPass(booking.id)).toMatchObject({
      ok: false,
      error: "This booking was not paid with a pass.",
    });
  });
});

describe("finding a customer's passes", () => {
  beforeEach(() => {
    // Nothing to reset: each test sells its own passes.
  });

  it("lists by phone, newest first, and keeps spent ones visible", () => {
    const phone = "0175550000";
    const first = sell({ holderPhone: phone, name: "Old pass" });
    const second = sell({ holderPhone: phone, name: "New pass" });
    const mine = listPassesFor({ phone });
    expect(mine.map((p) => p.id)).toEqual([second.id, first.id]);
  });

  it("only offers passes that can actually pay for this court", () => {
    const phone = "0175551111";
    const venue = listVenues()[0];
    const badmintonCourt = venue.courts.find((c) => c.sport === "badminton")!;
    const gymCourt = venue.courts.find((c) => c.sport === "gym")!;

    const anySport = sell({ holderPhone: phone, sport: null, name: "Any sport" });
    const badmintonOnly = sell({ holderPhone: phone, sport: "badminton", name: "Badminton only" });
    const otherVenue = sell({ holderPhone: phone, venueId: listVenues()[1].id, sport: null });
    const cancelled = sell({ holderPhone: phone, sport: null });
    voidPass(cancelled.id);

    const forBadminton = usablePassesFor(phone, badmintonCourt.id).map((p) => p.id);
    expect(forBadminton).toContain(anySport.id);
    expect(forBadminton).toContain(badmintonOnly.id);
    expect(forBadminton).not.toContain(otherVenue.id);
    expect(forBadminton).not.toContain(cancelled.id);

    const forGym = usablePassesFor(phone, gymCourt.id).map((p) => p.id);
    expect(forGym).toContain(anySport.id);
    expect(forGym).not.toContain(badmintonOnly.id);

    expect(usablePassesFor("123", badmintonCourt.id)).toEqual([]);
    expect(usablePassesFor(phone, 99999)).toEqual([]);
  });

  it("lists a venue's own passes for the counter", () => {
    const venue = listVenues()[2];
    const pass = sell({ venueId: venue.id, sport: null, name: "Bangsar 5-pack", entries: 5 });
    const listed = listPassesForVenue(venue.id);
    expect(listed[0].id).toBe(pass.id);
    expect(listed.every((p) => p.venueId === venue.id)).toBe(true);
  });
});
