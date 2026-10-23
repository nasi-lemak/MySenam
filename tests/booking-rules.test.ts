import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

// The booking route reads the customer's language from a cookie.
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { updatePolicy } from "../src/lib/booking-policy";
import { NextRequest } from "next/server";
import { ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { setLastMinute } from "../src/lib/peak";
import { resetRateLimits } from "../src/lib/rate-limit";
import {
  adminCancelBooking,
  applyPromo,
  cancelBooking,
  closeVenueDay,
  createBooking,
  createBookingSeries,
  createCourt,
  createPromoCode,
  createVenue,
  findBooking,
  rescheduleBooking,
} from "../src/lib/store";
import { addDays, slotStartsAt, todayISO } from "../src/lib/time";

/**
 * The booking rules the audit tightened: half hours through the public route,
 * a phone number however it is typed, weeks the venue is shut, a booking
 * cancelled twice at once, and last-minute prices that cannot be gamed.
 */

const ZONE = "Asia/Kuala_Lumpur";
let venueId: number;
let courtId: number;
let adminId: number;
let n = 0;
const phone = () => `0198880${String(++n).padStart(3, "0")}`;

afterEach(() => vi.useRealTimers());

beforeAll(async () => {
  await ensureBootstrapAdmin();
  adminId = ((await getDb().prepare("SELECT id FROM admins ORDER BY id LIMIT 1").get()) as { id: number }).id;
  const made = await createVenue({ name: "Rules Hall", area: "PJ", address: "x", phone: "0312348888", openMin: 8 * 60, closeMin: 22 * 60 });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!court.ok) throw new Error("court");
  courtId = court.court.id;
});

describe("half hours through the public route", () => {
  it("takes a booking that starts on the half hour, where the venue sells them", async () => {
    // A venue of its own: one with half-hour bookings in its diary cannot go back to hours.
    const made = await createVenue({ name: "Half Rules", area: "PJ", address: "x", phone: "0312348887", openMin: 8 * 60, closeMin: 22 * 60 });
    if (!made.ok) throw new Error("venue");
    const court = await createCourt({ venueId: made.venue.id, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
    if (!court.ok) throw new Error("court");
    const courtId = court.court.id;
    // Its booking rules: a start every half hour, lengths by the half hour.
    expect(await updatePolicy({ venue: made.venue.id }, { startEvery: 30, lengthStep: 30, minLength: 30 })).toMatchObject({ ok: true });
    resetRateLimits();
    const { POST } = await import("../src/app/api/bookings/route");
    const res = await POST(
      new NextRequest("http://localhost/api/bookings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ courtId, date: addDays(todayISO(ZONE), 2), hours: [10.5, 11], name: "Half Past", phone: phone() }),
      })
    );
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.booking).toMatchObject({ startHour: 10.5, endHour: 11.5 });
    // Not a quarter past, though: the court's rules say so, in the customer's words.
    const odd = await POST(
      new NextRequest("http://localhost/api/bookings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ courtId, date: addDays(todayISO(ZONE), 2), start: "12:15", minutes: 60, name: "Quarter", phone: phone() }),
      })
    );
    expect(odd.status).toBe(409);
    expect(await odd.json()).toMatchObject({ code: "POLICY_START" });
    // Exact minutes, where the court's rules allow any minute: 18:07 to 19:23.
    expect(await updatePolicy({ court: courtId }, { startEvery: 1, lengthStep: 1, minLength: 5 })).toMatchObject({ ok: true });
    const exact = await POST(
      new NextRequest("http://localhost/api/bookings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ courtId, date: addDays(todayISO(ZONE), 2), start: "18:07", end: "19:23", name: "To The Minute", phone: phone() }),
      })
    );
    expect(exact.status).toBe(201);
    expect((await exact.json()).booking).toMatchObject({ startMin: 18 * 60 + 7, endMin: 19 * 60 + 23 });
  });
});

describe("finding a booking by phone", () => {
  it("matches the number however it is written", async () => {
    const made = await createBooking({ courtId, date: addDays(todayISO(ZONE), 3), hours: [9], name: "Typed", phone: "012-345 6700" });
    if (!made.ok) throw new Error(made.error);
    expect(await findBooking(made.booking.code, "+60123456700")).not.toBeNull();
    expect(await findBooking(made.booking.code.toLowerCase(), "0123456700")).not.toBeNull();
    expect(await findBooking(made.booking.code, "0123456799")).toBeNull();
  });
});

describe("weekly bookings", () => {
  it("skip a week the venue is closed rather than booking into it", async () => {
    const first = addDays(todayISO(ZONE), 4);
    expect(await closeVenueDay(venueId, addDays(first, 7), "Renovation")).toMatchObject({ ok: true });
    const made = await createBookingSeries({ courtId, date: first, hours: [15], weeks: 3, skipConflicts: true, name: "Weekly", phone: phone() });
    if (!made.ok) throw new Error(made.error);
    expect(made.bookings.map((b) => b.date)).toEqual([first, addDays(first, 14)]);
    expect(made.skipped).toEqual([{ date: addDays(first, 7), reason: "venue closed" }]);
  });
});

describe("cancelling", () => {
  it("happens once, however many times it is asked for at once", async () => {
    const who = phone();
    const made = await createBooking({ courtId, date: addDays(todayISO(ZONE), 5), hours: [11], name: "Twice", phone: who });
    if (!made.ok) throw new Error(made.error);
    const results = await Promise.all([
      cancelBooking(made.booking.code, who),
      cancelBooking(made.booking.code, who),
      adminCancelBooking(made.booking.code),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });
});

describe("last-minute prices", () => {
  const tomorrow = addDays(todayISO(ZONE), 1);

  it("are not had by cancelling a booking and booking the same day again", async () => {
    await setLastMinute(venueId, { hours: 24, percent: 50, offPeakOnly: false });
    const who = phone();
    // Booked well before the window, whatever the time of day the suite runs.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(slotStartsAt(tomorrow, 20, ZONE).getTime() - 30 * 3_600_000);
    const early = await createBooking({ courtId, date: tomorrow, hours: [20], name: "Gamer", phone: who });
    if (!early.ok) throw new Error(early.error);
    expect(early.booking.totalPrice).toBe(20);
    // It is now within the window; cancel and book it again at half price?
    vi.setSystemTime(slotStartsAt(tomorrow, 20, ZONE).getTime() - 2 * 3_600_000);
    expect(await cancelBooking(early.booking.code, who)).toMatchObject({ ok: true });
    const again = await createBooking({ courtId, date: tomorrow, hours: [20], name: "Gamer", phone: who });
    if (!again.ok) throw new Error(again.error);
    expect(again.booking.totalPrice).toBe(20);
    // Somebody else, who did not, gets the price.
    const other = await createBooking({ courtId, date: tomorrow, hours: [21], name: "Walk-up", phone: phone() });
    if (!other.ok) throw new Error(other.error);
    expect(other.booking.totalPrice).toBe(10);
  });

  it("do not take a promo code on top", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(slotStartsAt(tomorrow, 18, ZONE).getTime() - 2 * 3_600_000);
    const made = await createBooking({ courtId, date: tomorrow, hours: [18], name: "Deal", phone: phone() });
    if (!made.ok) throw new Error(made.error);
    expect(made.booking.totalPrice).toBe(10);
    const promo = await createPromoCode({
      venueId,
      code: "STACK10",
      description: "Ten off",
      kind: "percent",
      value: 10,
      validFrom: todayISO(ZONE),
      validTo: addDays(todayISO(ZONE), 10),
      adminId,
    });
    expect(promo).toMatchObject({ ok: true });
    expect(await applyPromo(made.booking.id, "STACK10")).toMatchObject({ ok: false, code: "PROMO_NOT_LAST_MINUTE" });
  });

  it("are kept when a booking made early is moved into the window, not added", async () => {
    vi.useRealTimers();
    const who = phone();
    const made = await createBooking({ courtId, date: addDays(todayISO(ZONE), 6), hours: [9], name: "Mover", phone: who });
    if (!made.ok) throw new Error(made.error);
    expect(made.booking.totalPrice).toBe(20);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(slotStartsAt(tomorrow, 9, ZONE).getTime() - 2 * 3_600_000);
    const moved = await rescheduleBooking(made.booking.code, { date: tomorrow, startHour: 9 }, "customer");
    if (!moved.ok) throw new Error(moved.error);
    // The price it was booked at, not the one a booking made now would get.
    expect(moved.booking.totalPrice).toBe(20);
  });
});
