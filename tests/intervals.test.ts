import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { updatePolicy } from "../src/lib/booking-policy";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { setCourtParts } from "../src/lib/court-links";
import { getDb } from "../src/lib/db";
import {
  applyPromo,
  cancelBooking,
  createBooking,
  createBookingSeries,
  createCourt,
  createGroupBooking,
  createPromoCode,
  createVenue,
  getAdminSlots,
  getAvailability,
  issuePass,
  joinSlotWaitlist,
  payBookingWithPass,
  quoteFor,
  refundBookingToPass,
} from "../src/lib/store";
import { resetRateLimits } from "../src/lib/rate-limit";
import { addDays, todayISO } from "../src/lib/time";
import { POST as book } from "../src/app/api/bookings/route";

/**
 * Bookings as exact intervals (ADR 0010): any minute a court's rules allow,
 * held by claims the database checks — whatever the grid shows, whoever books,
 * however many at once.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (n: number) => addDays(todayISO(ZONE), n);
const at = (h: number, m = 0) => h * 60 + m;
let n = 0;
const phone = () => `0155550${String(++n).padStart(3, "0")}`;

let venueId: number;
let c1: number;
let c2: number;
let pitch: number;
let gym: number;
let tidy: number;

beforeAll(async () => {
  const made = await createVenue({ name: "Interval Hall", area: "PJ", address: "x", phone: "0312340777", openMin: at(7), closeMin: at(23) });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const court = async (name: string, sport: "badminton" | "futsal" | "gym", capacity = 1) => {
    const c = await createCourt({ venueId, name, sport, offPeakRate: 20, peakRate: 20, capacity });
    if (!c.ok) throw new Error(c.error);
    return c.court.id;
  };
  c1 = await court("Court 1", "badminton");
  c2 = await court("Court 2", "badminton");
  pitch = await court("Pitch", "futsal");
  gym = await court("Gym", "gym", 2);
  tidy = await court("Court 3", "badminton");
  expect(await setCourtParts(pitch, [c1, c2])).toMatchObject({ ok: true });
  // Any minute here, five minutes to four hours.
  expect(await updatePolicy({ venue: venueId }, { startEvery: 1, lengthStep: 1, minLength: 5 })).toMatchObject({ ok: true });
  // Court 3 keeps 15 minutes free after each booking to clean.
  expect(await updatePolicy({ court: tidy }, { bufferAfter: 15 })).toMatchObject({ ok: true });
});

const make = (courtId: number, date: string, start: number, end: number) =>
  createBooking({ courtId, date, start, end, name: "Player", phone: phone() });

describe("any minute", () => {
  it("books 18:07 to 19:23, holds exactly that, and prices exactly that", async () => {
    const made = await make(c1, day(3), at(18, 7), at(19, 23));
    if (!made.ok) throw new Error(made.error);
    expect(made.booking).toMatchObject({ startMin: at(18, 7), endMin: at(19, 23), totalPrice: 25.33 });
    // The minute before and the minute after are free; the minute inside is not.
    expect((await make(c1, day(3), at(17), at(18, 7))).ok).toBe(true);
    expect((await make(c1, day(3), at(19, 23), at(20))).ok).toBe(true);
    expect(await make(c1, day(3), at(19, 22), at(19, 40))).toMatchObject({ ok: false });
  });

  it("holds the court over it too: the pitch is taken while Court 1 is, and free after", async () => {
    expect(await make(pitch, day(3), at(18, 30), at(19))).toMatchObject({ ok: false });
    expect((await make(pitch, day(3), at(20), at(21))).ok).toBe(true);
    // And the pitch holds both courts under it.
    expect(await make(c2, day(3), at(20, 30), at(20, 45))).toMatchObject({ ok: false });
  });

  it("fills a shared facility to its places at every moment, not by the hour", async () => {
    expect((await make(gym, day(4), at(10), at(11))).ok).toBe(true);
    expect((await make(gym, day(4), at(10, 30), at(11, 30))).ok).toBe(true);
    // Three at 10:45 is one too many.
    expect(await make(gym, day(4), at(10, 45), at(11, 15))).toMatchObject({ ok: false });
    // From 11:00 the first has gone: two again.
    expect((await make(gym, day(4), at(11), at(11, 20))).ok).toBe(true);
  });
});

describe("buffers", () => {
  it("keep time free that nobody books, without charging for it", async () => {
    const made = await make(tidy, day(5), at(10), at(11));
    if (!made.ok) throw new Error(made.error);
    expect(made.booking.totalPrice).toBe(20);
    // Not until 11:15 again, and not into the buffer from before either.
    expect(await make(tidy, day(5), at(11), at(11, 30))).toMatchObject({ ok: false });
    expect((await make(tidy, day(5), at(11, 15), at(12))).ok).toBe(true);
    // The quote is the time, not the buffer.
    const quote = await quoteFor({ courtId: tidy, date: day(5), start: at(14), end: at(15) });
    expect(quote).toMatchObject({ ok: true, quote: { total: 20, billedMinutes: 60 } });
  });

  it("show to customers only as time they cannot book, and to staff with what they are for", async () => {
    const grid = (await getAvailability(venueId, day(5), "badminton")).find((c) => c.court.id === tidy)!;
    // 11:00 is partly held (the buffer, then a booking from 11:15): no start there.
    expect(grid.starts.some((s) => s.minute === at(11))).toBe(false);
    expect(JSON.stringify(grid)).not.toContain("buffer");
    const staff = (await getAdminSlots(venueId, day(5))).find((c) => c.court.id === tidy)!;
    expect(staff.entries.filter((e) => e.kind === "buffer").map((e) => [e.start, e.end])).toEqual([
      [at(11), at(11, 15)],
      [at(12), at(12, 15)],
    ]);
  });
});

describe("fees", () => {
  it("are charged apart from the time, and no discount comes off them", async () => {
    const c = await createCourt({ venueId, name: "Court 4", sport: "badminton", offPeakRate: 20, peakRate: 20 });
    if (!c.ok) throw new Error(c.error);
    expect(await updatePolicy({ court: c.court.id }, { setupFee: 6 })).toMatchObject({ ok: true });
    const made = await make(c.court.id, day(6), at(10), at(11));
    if (!made.ok) throw new Error(made.error);
    expect(made.booking).toMatchObject({ totalPrice: 26, feeAmount: 6 });
    const admin = await createAdmin({ name: "Fees", email: "fees@interval.my", password: "a long enough password", venueId });
    if (!admin.ok) throw new Error("admin");
    const promo = await createPromoCode({
      venueId,
      code: "HALF",
      description: "Half off",
      kind: "percent",
      value: 50,
      validFrom: todayISO(ZONE),
      validTo: day(30),
      adminId: admin.admin.id,
    });
    expect(promo).toMatchObject({ ok: true });
    // Half of the court's 20, not of the 26 with the setup fee.
    expect(await applyPromo(made.booking.id, "HALF")).toMatchObject({ ok: true, discount: 10, newTotal: 16 });
  });
});

describe("staff going past the rules", () => {
  let manager: string;
  let desk: string;

  beforeAll(async () => {
    const m = await createAdmin({ name: "Manager", email: "m@interval.my", password: "a long enough password", venueId });
    const d = await createAdmin({ name: "Desk", email: "d@interval.my", password: "a long enough password", venueId, role: "desk" });
    if (!m.ok || !d.ok) throw new Error("admins");
    manager = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(m.admin.id)).token}`;
    desk = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(d.admin.id)).token}`;
    // Court 2 is sold on the hour, by the hour.
    expect(await updatePolicy({ court: c2 }, { startEvery: 60, lengthStep: 60, minLength: 60 })).toMatchObject({ ok: true });
  });

  const post = (body: Record<string, unknown>, cookie?: string) => {
    resetRateLimits();
    return book(
      new NextRequest("http://localhost/api/bookings", {
        method: "POST",
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        body: JSON.stringify({ courtId: c2, date: day(6), name: "Regular", phone: phone(), ...body }),
      })
    );
  };

  it("is refused to customers, in the court's own words", async () => {
    const res = await post({ start: "18:15", minutes: 45 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "POLICY_START" });
  });

  it("is for managers, and is recorded", async () => {
    expect((await post({ start: "18:15", minutes: 45, override: true }, desk)).status).toBe(403);
    expect((await post({ start: "18:15", minutes: 45, override: true })).status).toBe(403);
    const res = await post({ start: "18:15", minutes: 45, override: true }, manager);
    expect(res.status).toBe(201);
    const { booking } = await res.json();
    expect(booking).toMatchObject({ startMin: at(18, 15), endMin: at(19), policyOverride: true });
    const log = (await getDb().prepare("SELECT detail FROM staff_actions WHERE action = 'booking.override' AND booking_code = ?").get(booking.code)) as {
      detail: string;
    };
    expect(log.detail).toContain("start on the hour");
  });

  it("never goes past what holds the court", async () => {
    const res = await post({ start: "18:30", minutes: 60, override: true }, manager);
    expect(res.status).toBe(409);
  });
});

describe("several courts at once", () => {
  it("are all booked or none, to the minute", async () => {
    // Court 2 is taken 09:50–10:10; a booking of both courts from 10:05 cannot be had.
    expect((await createBooking({ courtId: c2, date: day(7), start: at(9), end: at(10), name: "X", phone: phone(), staff: { override: true } })).ok).toBe(true);
    const before = ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings").get()) as { n: number }).n;
    expect(await createGroupBooking({ courtIds: [c1, c2], date: day(7), start: at(9, 30), end: at(10, 30), name: "Team", phone: phone() })).toMatchObject({ ok: false });
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings").get()) as { n: number }).n).toBe(before);
    expect((await createGroupBooking({ courtIds: [c1, tidy], date: day(7), start: at(9, 30), end: at(10, 30), name: "Team", phone: phone() })).ok).toBe(true);
  });

  it("race for the same minutes, and only one gets them", async () => {
    const date = day(8);
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) => createBooking({ courtId: c1, date, start: at(15, i), end: at(16, i), name: `Racer ${i}`, phone: phone() }))
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });
});

describe("weeks, waiting and passes", () => {
  it("books the same minutes every week, skipping a week taken", async () => {
    const date = day(1);
    expect((await make(c1, addDays(date, 7), at(19, 50), at(20, 10))).ok).toBe(true);
    const series = await createBookingSeries({ courtId: c1, date, weeks: 3, start: at(19, 5), end: at(19, 55), skipConflicts: true, name: "Weekly", phone: phone() });
    if (!series.ok) throw new Error(series.error);
    expect(series.bookings.map((b) => [b.date, b.startMin, b.endMin])).toEqual([
      [date, at(19, 5), at(19, 55)],
      [addDays(date, 14), at(19, 5), at(19, 55)],
    ]);
    expect(series.skipped.map((s) => s.date)).toEqual([addDays(date, 7)]);
  });

  it("offers time freed to whoever waits for it, and holds it for them meanwhile", async () => {
    const date = day(10);
    const taken = await make(c2, date, at(12), at(13));
    if (!taken.ok) throw new Error(taken.error);
    expect(await joinSlotWaitlist({ courtId: c2, date, start: at(12), end: at(13), name: "Waiter", phone: phone() })).toMatchObject({ ok: true });
    expect(await cancelBooking(taken.booking.code, taken.booking.phone)).toMatchObject({ ok: true });
    // Offered, and held: nobody else books it while the offer stands.
    expect(await make(c2, date, at(12), at(13))).toMatchObject({ ok: false });
    const offer = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM claims WHERE kind = 'offer' AND active").get()) as { n: number };
    expect(offer.n).toBe(1);
  });

  it("spend minutes from a time pass, an entry from a pass by the booking, and refuse past a pass's longest", async () => {
    const date = day(11);
    const sell = (extra: Record<string, unknown>) =>
      issuePass({ venueId, name: "Pass", entries: 10, price: 100, holderName: "Holder", holderPhone: "0129990000", expiresOn: day(60), adminId: null, ...extra });
    const time = await sell({ kind: "time", entries: 300 });
    const perBooking = await sell({ entryMinutes: null, maxMinutes: 90 });
    if (!time.ok || !perBooking.ok) throw new Error("passes");
    const booking = (start: number, end: number) => createBooking({ courtId: c1, date, start, end, name: "Holder", phone: "0129990000" });

    const ninety = await booking(at(8), at(9, 30));
    if (!ninety.ok) throw new Error(ninety.error);
    expect(await payBookingWithPass(ninety.booking.id, time.pass.code)).toMatchObject({ ok: true, spent: 90, pass: { remaining: 210 } });
    // Given back to the minute when it is refunded.
    expect(await refundBookingToPass(ninety.booking.id)).toMatchObject({ ok: true, pass: { remaining: 300 } });

    const seventyFive = await booking(at(10), at(11, 15));
    if (!seventyFive.ok) throw new Error(seventyFive.error);
    expect(await payBookingWithPass(seventyFive.booking.id, perBooking.pass.code)).toMatchObject({ ok: true, spent: 1, pass: { remaining: 9 } });

    const twoHours = await booking(at(12), at(14));
    if (!twoHours.ok) throw new Error(twoHours.error);
    expect(await payBookingWithPass(twoHours.booking.id, perBooking.pass.code)).toMatchObject({ ok: false });
  });
});
