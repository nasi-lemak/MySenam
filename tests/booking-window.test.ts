import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { registerUser, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { aheadFor, houseRules, setHouseRules } from "../src/lib/house-rules";
import { customerMayBook } from "../src/lib/limits";
import { createBooking, createCourt, createVenue, rescheduleOptions, sellMembership } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * How far ahead a venue takes bookings: the site's two weeks unless it says
 * otherwise, up to 90 days, and further for its members than for everybody
 * else, so members have first pick.
 */

let venueId: number;
let courtId: number;
let adminId: number;
let member: User;
let stranger: User;
const MEMBER = "0128880001";
const OTHER = "0128880002";
const ahead = (n: number) => addDays(todayISO(), n);
const may = (phone: string, days: number, userId?: number) =>
  customerMayBook({ venueId, phone, signedIn: userId !== undefined, userId, dates: [ahead(days)] });

beforeAll(async () => {
  await ensureBootstrapAdmin();
  adminId = ((await getDb().prepare("SELECT id FROM admins ORDER BY id LIMIT 1").get()) as { id: number }).id;
  const made = await createVenue({ name: "Window Club", area: "Bangsar", address: "1 Jalan Kelab", phone: "0322220000" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const court = await createCourt({ venueId, name: "Court 1", sport: "tennis", offPeakRate: 30, peakRate: 30 });
  if (!court.ok) throw new Error("court");
  courtId = court.court.id;
  const sold = await sellMembership({
    venueId, holderName: "Mei Ling", holderPhone: MEMBER, startsOn: todayISO(), expiresOn: ahead(365), price: 500, adminId,
  });
  if (!sold.ok) throw new Error(sold.error);
  const a = await registerUser({ name: "Mei Ling", email: "meiling@example.my", phone: MEMBER, password: "a long enough password" });
  const b = await registerUser({ name: "Kumar", email: "kumar@example.my", phone: OTHER, password: "a long enough password" });
  if (!a.ok || !b.ok) throw new Error("users");
  member = a.user;
  stranger = b.user;
});

describe("a venue's own window", () => {
  it("is the site's 14 days unless it says otherwise", async () => {
    expect(await may(OTHER, 14)).toBeNull();
    const made = await createBooking({ courtId, date: ahead(15), hours: [9], name: "Kumar", phone: OTHER });
    expect(made).toMatchObject({ ok: false, code: "DATE_OUT_OF_WINDOW_FIRST" });
  });

  it("can be longer, up to 90 days", async () => {
    expect(await setHouseRules(venueId, { aheadDays: 91 })).toMatchObject({ ok: false });
    expect(await setHouseRules(venueId, { aheadDays: 30 })).toMatchObject({ ok: true, rules: { aheadDays: 30 } });
    expect(await may(OTHER, 30)).toBeNull();
    expect(await createBooking({ courtId, date: ahead(30), hours: [9], name: "Kumar", phone: OTHER })).toMatchObject({ ok: true });
    expect(await may(OTHER, 31)).toMatchObject({ code: "LIMIT_AHEAD", vars: { n: 30 } });
    expect(await createBooking({ courtId, date: ahead(31), hours: [9], name: "Kumar", phone: OTHER })).toMatchObject({ ok: false });
  });
});

describe("members first", () => {
  it("must be a longer window than everybody's", async () => {
    expect(await setHouseRules(venueId, { aheadDays: 7, memberAheadDays: 7 })).toMatchObject({ ok: false });
    expect(await setHouseRules(venueId, { aheadDays: null, memberAheadDays: 10 })).toMatchObject({ ok: false });
    expect(await setHouseRules(venueId, { aheadDays: 7, memberAheadDays: 91 })).toMatchObject({ ok: false });
    expect(await setHouseRules(venueId, { aheadDays: 7, memberAheadDays: 21 })).toMatchObject({ ok: true });
    expect(await houseRules(venueId)).toMatchObject({ aheadDays: 7, memberAheadDays: 21 });
  });

  it("lets a member book further ahead than everybody else", async () => {
    expect(await may(OTHER, 7)).toBeNull();
    expect(await may(OTHER, 10)).toMatchObject({ code: "LIMIT_AHEAD_MEMBERS", vars: { n: 7, m: 21 } });
    expect(await may(MEMBER, 10)).toBeNull();
    expect(await may(MEMBER, 21)).toBeNull();
    expect(await may(MEMBER, 22)).toMatchObject({ code: "LIMIT_AHEAD", vars: { n: 21 } });
  });

  it("knows a member by their account's number too", async () => {
    // Booking for somebody else's number from a member's account.
    expect(await may("0128880099", 15, member.id)).toBeNull();
    expect(await may("0128880099", 15, stranger.id)).toMatchObject({ code: "LIMIT_AHEAD_MEMBERS" });
  });

  it("shows each viewer their own window", async () => {
    expect(await aheadFor(venueId, member.id)).toBe(21);
    expect(await aheadFor(venueId, stranger.id)).toBe(7);
    expect(await aheadFor(venueId, null)).toBe(7);
  });

  it("is the outer edge for staff booking at the counter, and for moving a booking", async () => {
    const made = await createBooking({ courtId, date: ahead(20), hours: [10], name: "Kumar", phone: OTHER });
    expect(made).toMatchObject({ ok: true });
    expect(await createBooking({ courtId, date: ahead(22), hours: [10], name: "Kumar", phone: OTHER })).toMatchObject({ ok: false });
    if (!made.ok) return;
    expect((await rescheduleOptions(made.booking.code, ahead(21))).length).toBeGreaterThan(0);
    expect(await rescheduleOptions(made.booking.code, ahead(22))).toEqual([]);
  });
});
