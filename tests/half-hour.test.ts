import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { createOutage } from "../src/lib/outages";
import { venueReport } from "../src/lib/reports";
import {
  adminCancelBooking,
  createBooking,
  createClassSessions,
  createCourt,
  createVenue,
  getAvailability,
  rescheduleBooking,
  searchAvailability,
  setSlotMinutes,
} from "../src/lib/store";
import { addDays, formatHour, isPeak, slotsBetween, todayISO } from "../src/lib/time";

/**
 * A venue that sells its courts by the half hour: slots at :00 and :30, each
 * at half the hourly rate, booked, moved and reported by the half hour, and
 * the switch to and from it leaving what is in the diary where it was.
 */

let venueId: number;
let courtId: number;
let adminId: number;
let date: string;
let n = 0;

const phone = () => `0197770${String(++n).padStart(3, "0")}`;
const slotsOf = async (id = courtId, on = date) => (await getAvailability(venueId, on)).find((c) => c.court.id === id)!.slots;
const rows = async (bookingId: number) =>
  (await getDb()
    .prepare("SELECT hour, span FROM booking_slots WHERE booking_id = ? ORDER BY hour")
    .all(bookingId)) as { hour: number; span: number }[];

beforeAll(async () => {
  await ensureBootstrapAdmin();
  adminId = ((await getDb().prepare("SELECT id FROM admins ORDER BY id LIMIT 1").get()) as { id: number }).id;
  const made = await createVenue({ name: "Half Hall", area: "PJ", address: "x", phone: "0312349999", openHour: 8, closeHour: 22 });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 30 });
  if (!court.ok) throw new Error("court");
  courtId = court.court.id;
  date = addDays(todayISO(), 3);
  while (isPeak(date, 9)) date = addDays(date, 1);
});

describe("the clock", () => {
  it("writes and counts half hours", () => {
    expect(formatHour(18.5)).toBe("6:30 PM");
    expect(formatHour(0.5)).toBe("12:30 AM");
    expect(slotsBetween(9, 10.5, 0.5)).toEqual([9, 9.5, 10]);
    expect(slotsBetween(9, 11)).toEqual([9, 10]);
  });
});

describe("switching a venue to half hours", () => {
  it("takes 30 or 60 minutes and nothing else", async () => {
    expect(await setSlotMinutes(venueId, 45)).toMatchObject({ ok: false });
  });

  it("splits what is already booked into its halves, each in its place", async () => {
    const before = await createBooking({ courtId, date, hours: [12], name: "Hourly", phone: phone() });
    if (!before.ok) throw new Error(before.error);
    expect(await setSlotMinutes(venueId, 30)).toEqual({ ok: true, slotMinutes: 30 });
    expect(await rows(before.booking.id)).toEqual([
      { hour: 12, span: 0.5 },
      { hour: 12.5, span: 0.5 },
    ]);
    // So its second half is still taken.
    const clash = await createBooking({ courtId, date, hours: [12.5], name: "Late", phone: phone() });
    expect(clash.ok).toBe(false);
  });
});

describe("booking by the half hour", () => {
  it("offers every half hour at half the hourly rate", async () => {
    const slots = await slotsOf();
    expect(slots.map((s) => s.hour).slice(0, 4)).toEqual([8, 8.5, 9, 9.5]);
    expect(slots.find((s) => s.hour === 9.5)!.rate).toBe(10);
    expect(slots.find((s) => s.hour === 12.5)!.available).toBe(false);
  });

  it("books an hour and a half from the half hour, and holds exactly that", async () => {
    const made = await createBooking({ courtId, date, hours: [9.5, 10, 10.5], name: "Aina", phone: phone() });
    if (!made.ok) throw new Error(made.error);
    expect(made.booking).toMatchObject({ startHour: 9.5, endHour: 11, totalPrice: 30 });
    const slots = await slotsOf();
    expect(slots.find((s) => s.hour === 9)!.available).toBe(true);
    expect(slots.find((s) => s.hour === 10.5)!.available).toBe(false);
    expect(slots.find((s) => s.hour === 11)!.available).toBe(true);
  });

  it("refuses times between slots, gaps, and more than the longest booking", async () => {
    expect((await createBooking({ courtId, date, hours: [8.25], name: "x", phone: phone() })).ok).toBe(false);
    expect((await createBooking({ courtId, date, hours: [8, 9], name: "x", phone: phone() })).ok).toBe(false);
    const tooLong = slotsBetween(13, 17.5, 0.5); // 4½ hours
    expect(await createBooking({ courtId, date, hours: tooLong, name: "x", phone: phone() })).toMatchObject({ ok: false, code: "MAX_HOURS" });
  });

  it("moves to another half hour, keeping its length", async () => {
    const made = await createBooking({ courtId, date, hours: [15, 15.5], name: "Bala", phone: phone() });
    if (!made.ok) throw new Error(made.error);
    const moved = await rescheduleBooking(made.booking.code, { date, startHour: 16.5 }, "staff");
    expect(moved.ok).toBe(true);
    const rowsNow = await rows(made.booking.id);
    expect(rowsNow.map((r) => r.hour)).toEqual([16.5, 17]);
  });

  it("is found by search, a whole hour made of its halves", async () => {
    const found = await searchAvailability({ sport: "badminton", date, fromHour: 13, toHour: 13, venueIds: [venueId] });
    expect(found[0]).toMatchObject({ startHour: 13, endHour: 14, totalPrice: 20 });
  });
});

describe("the rest of the diary, by the half hour", () => {
  it("a class on the hour holds both halves", async () => {
    const made = await createClassSessions({ courtId, name: "Clinic", instructor: "Coach", date, startHour: 19, endHour: 20, capacity: 1, price: 10 });
    expect(made.ok).toBe(true);
    const slots = await slotsOf();
    expect(slots.find((s) => s.hour === 19)!.className).toBe("Clinic");
    expect(slots.find((s) => s.hour === 19.5)!.className).toBe("Clinic");
  });

  it("a court out of service is out every half hour", async () => {
    const court = await createCourt({ venueId, name: "Court 2", sport: "badminton", offPeakRate: 20, peakRate: 30 });
    if (!court.ok) throw new Error("court");
    const day = addDays(date, 1);
    const out = await createOutage({ courtId: court.court.id, startsOn: day, endsOn: day, reason: "Resurfacing", adminId });
    expect(out.ok).toBe(true);
    const slots = await slotsOf(court.court.id, day);
    expect(slots.every((s) => s.blocked)).toBe(true);
    expect(slots.map((s) => s.hour)).toContain(21.5);
  });

  it("is reported in hours", async () => {
    const report = (await venueReport(venueId, date, date))!;
    // 1 (split) + 1.5 + 1 (moved) hours of court time.
    expect(report.bookings.hours).toBe(3.5);
  });
});

describe("switching back to hours", () => {
  it("is refused while a booking starts or ends on the half hour, and puts the halves back together after", async () => {
    expect(await setSlotMinutes(venueId, 60)).toMatchObject({ ok: false });
    const onHalf = (await getDb()
      .prepare("SELECT code FROM bookings WHERE court_id = ? AND status = 'confirmed' AND (start_hour <> FLOOR(start_hour) OR end_hour <> FLOOR(end_hour))")
      .all(courtId)) as { code: string }[];
    for (const b of onHalf) await adminCancelBooking(b.code);
    expect(await setSlotMinutes(venueId, 60)).toEqual({ ok: true, slotMinutes: 60 });
    const hourly = (await getDb().prepare("SELECT id FROM bookings WHERE court_id = ? AND name = 'Hourly'").get(courtId)) as { id: number };
    expect(await rows(hourly.id)).toEqual([{ hour: 12, span: 1 }]);
    expect((await slotsOf()).map((s) => s.hour).slice(0, 3)).toEqual([8, 9, 10]);
  });
});
