import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { createOutage } from "../src/lib/outages";
import { setSportRules } from "../src/lib/sport-rules";
import { venueReport } from "../src/lib/reports";
import {
  createBooking,
  createClassSessions,
  createCourt,
  createVenue,
  getAdminSlots,
  getAvailability,
  rescheduleBooking,
  scheduleUnit,
  searchAvailability,
  sellUnit,
  sellUnits,
  setSlotMinutes,
  unitFor,
} from "../src/lib/store";
import { addDays, formatHour, isPeak, slotsBetween, todayISO } from "../src/lib/time";

/**
 * Every court's diary is half hours; each sport is sold by the hour or the
 * half hour (ADR 0009). A venue selling by the half hour: slots at :00 and
 * :30, each at half the hourly rate, booked, moved and reported by the half
 * hour; switching to and from it moving nothing; and a hall selling padel by
 * the half hour beside badminton on the hour.
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

  it("moves nothing: an hour sold by the hour is already stored as its two halves", async () => {
    const before = await createBooking({ courtId, date, hours: [12], name: "Hourly", phone: phone() });
    if (!before.ok) throw new Error(before.error);
    const halves = [
      { hour: 12, span: 0.5 },
      { hour: 12.5, span: 0.5 },
    ];
    expect(await rows(before.booking.id)).toEqual(halves);
    expect(await setSlotMinutes(venueId, 30)).toEqual({ ok: true, slotMinutes: 30 });
    expect(await rows(before.booking.id)).toEqual(halves);
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
  it("leaves half-hour bookings where they are, and sells hours again", async () => {
    const half = (await getDb()
      .prepare("SELECT id, start_hour FROM bookings WHERE court_id = ? AND status = 'confirmed' AND name = 'Aina'")
      .get(courtId)) as { id: number; start_hour: number };
    expect(await setSlotMinutes(venueId, 60)).toEqual({ ok: true, slotMinutes: 60 });
    expect(Number(half.start_hour)).toBe(9.5);
    expect((await rows(half.id)).map((r) => r.hour)).toEqual([9.5, 10, 10.5]);
    const slots = await slotsOf();
    expect(slots.map((s) => s.hour).slice(0, 3)).toEqual([8, 9, 10]);
    // An hour with either half taken is not free.
    expect(slots.find((s) => s.hour === 9)!.available).toBe(false);
    expect(slots.find((s) => s.hour === 10)!.available).toBe(false);
    expect(slots.find((s) => s.hour === 8)!.available).toBe(true);
    expect((await createBooking({ courtId, date, hours: [13.5], name: "x", phone: phone() })).ok).toBe(false);
  });
});

describe("sold by the sport, in one hall", () => {
  let hall: number;
  let padel: number;
  let badminton: number;
  let day: string;

  beforeAll(async () => {
    const made = await createVenue({ name: "Mixed Hall", area: "PJ", address: "x", phone: "0312348888", openHour: 8, closeHour: 22 });
    if (!made.ok) throw new Error("venue");
    hall = made.venue.id;
    const court = async (name: string, sport: "padel" | "badminton") => {
      const c = await createCourt({ venueId: hall, name, sport, offPeakRate: 40, peakRate: 40 });
      if (!c.ok) throw new Error(c.error);
      return c.court.id;
    };
    padel = await court("Padel 1", "padel");
    badminton = await court("Badminton 1", "badminton");
    day = addDays(date, 2);
  });

  it("sells padel by the half hour and badminton by the hour, at a venue selling hours", async () => {
    expect(unitFor("padel", 60, null)).toBe(0.5);
    expect(unitFor("badminton", 60, null)).toBe(1);
    expect(unitFor("badminton", 30, null)).toBe(0.5);
    expect(unitFor("padel", 30, 60)).toBe(1);
    expect(await sellUnits(hall)).toMatchObject({ padel: 0.5, badminton: 1 });
    const grid = await getAvailability(hall, day);
    const of = (id: number) => grid.find((g) => g.court.id === id)!;
    expect(of(padel).unit).toBe(0.5);
    expect(of(padel).slots.map((s) => s.hour).slice(0, 3)).toEqual([8, 8.5, 9]);
    expect(of(badminton).unit).toBe(1);
    expect(of(badminton).slots.map((s) => s.hour).slice(0, 3)).toEqual([8, 9, 10]);
    // An hour of badminton costs the hour's rate; half an hour of padel half.
    expect(of(badminton).slots[0].rate).toBe(40);
    expect(of(padel).slots[0].rate).toBe(20);
  });

  it("starts padel on the half hour and refuses badminton there", async () => {
    const game = await createBooking({ courtId: padel, date: day, hours: [9.5, 10, 10.5], name: "Four", phone: phone() });
    expect(game).toMatchObject({ ok: true, booking: { startHour: 9.5, endHour: 11, totalPrice: 60 } });
    expect((await createBooking({ courtId: badminton, date: day, hours: [9.5], name: "x", phone: phone() })).ok).toBe(false);
    const hour = await createBooking({ courtId: badminton, date: day, hours: [9, 10], name: "Pair", phone: phone() });
    if (!hour.ok) throw new Error(hour.error);
    // Two hours sold by the hour, stored as four halves.
    expect((await rows(hour.booking.id)).map((r) => r.hour)).toEqual([9, 9.5, 10, 10.5]);
    expect(hour.booking).toMatchObject({ startHour: 9, endHour: 11, totalPrice: 80 });
  });

  it("finds padel's 90 minutes from the half hour, and badminton only on the hour", async () => {
    const games = await searchAvailability({ sport: "padel", date: day, venueIds: [hall], fromHour: 11, toHour: 12, duration: 1.5 });
    expect(games.map((r) => r.startHour)).toEqual([11, 11.5, 12]);
    const hours = await searchAvailability({ sport: "badminton", date: day, venueIds: [hall], fromHour: 11, toHour: 12, duration: 1.5 });
    expect(hours).toEqual([]);
  });

  it("gives the staff schedule the finest unit any sport here is sold by", async () => {
    expect(await scheduleUnit(hall)).toBe(0.5);
    const sheet = await getAdminSlots(hall, day);
    const bad = sheet.find((c) => c.court.id === badminton)!;
    expect(bad.slots.find((s) => s.hour === 10.5)!.status).toBe("booked");
    expect(bad.slots.find((s) => s.hour === 11)!.status).toBe("free");
  });

  it("follows a sport's own rule, which changes nothing already booked", async () => {
    expect(await setSportRules(hall, "padel", { slotMinutes: 45 })).toMatchObject({ ok: false });
    expect(await setSportRules(hall, "padel", { slotMinutes: 60 })).toMatchObject({ ok: true, rules: { slotMinutes: 60 } });
    expect(await sellUnit(hall, "padel")).toBe(1);
    expect((await createBooking({ courtId: padel, date: day, hours: [12.5], name: "x", phone: phone() })).ok).toBe(false);
    // The 9:30 game stands; the hour from 10 is not free while it does.
    const slots = (await getAvailability(hall, day, "padel"))[0].slots;
    expect(slots.find((s) => s.hour === 10)!.available).toBe(false);
    expect(slots.find((s) => s.hour === 11)!.available).toBe(true);

    expect(await setSportRules(hall, "badminton", { slotMinutes: 30 })).toMatchObject({ ok: true });
    expect(await sellUnit(hall, "badminton")).toBe(0.5);
    // Half an hour inside the badminton booked by the hour is still taken.
    const clash = await createBooking({ courtId: badminton, date: day, hours: [10.5], name: "x", phone: phone() });
    expect(clash).toMatchObject({ ok: false });
    expect(await createBooking({ courtId: badminton, date: day, hours: [11.5], name: "Late", phone: phone() })).toMatchObject({ ok: true });
    // Back to the venue's: all null removes the sport's own rule.
    expect(await setSportRules(hall, "padel", {})).toEqual({ ok: true, rules: null });
    expect(await sellUnit(hall, "padel")).toBe(0.5);
  });
});

describe("migration 0088", () => {
  it("splits slots stored by the hour into halves, holding what they held", async () => {
    const made = await createBooking({ courtId, date: addDays(date, 5), hours: [15], name: "Old", phone: phone() });
    if (!made.ok) throw new Error(made.error);
    const day = addDays(date, 5);
    const db = getDb();
    // As an hourly venue stored them before: one row an hour.
    await db.prepare("DELETE FROM booking_slots WHERE booking_id = ? AND hour = 15.5").run(made.booking.id);
    await db.prepare("UPDATE booking_slots SET span = 1 WHERE booking_id = ?").run(made.booking.id);
    await db.prepare("INSERT INTO slot_blocks (court_id, date, hour, reason, span) VALUES (?, ?, 17, 'Old block', 1)").run(courtId, day);
    expect((await slotsOf(courtId, day)).find((s) => s.hour === 15.5)).toBeUndefined();

    await db.exec(fs.readFileSync(path.join(__dirname, "..", "db", "migrations", "0088_half_hour_diary.sql"), "utf8"));

    expect(await rows(made.booking.id)).toEqual([
      { hour: 15, span: 0.5 },
      { hour: 15.5, span: 0.5 },
    ]);
    const blocks = (await db
      .prepare("SELECT hour, span, reason FROM slot_blocks WHERE court_id = ? AND date = ? ORDER BY hour")
      .all(courtId, day)) as { hour: number; span: number; reason: string }[];
    expect(blocks).toEqual([
      { hour: 17, span: 0.5, reason: "Old block" },
      { hour: 17.5, span: 0.5, reason: "Old block" },
    ]);
    // Run again, it changes nothing.
    await db.exec(fs.readFileSync(path.join(__dirname, "..", "db", "migrations", "0088_half_hour_diary.sql"), "utf8"));
    expect((await rows(made.booking.id)).length).toBe(2);
  });
});
