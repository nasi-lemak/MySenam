import { beforeEach, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import {
  blockSlots,
  closeVenueDay,
  createBooking,
  createBookingSeries,
  createClassSessions,
  getAdminSlots,
  getAvailability,
  getOccupancy,
  getVenue,
  getVenueClosure,
  joinSlotWaitlist,
  listVenueClosures,
  listVenues,
  reopenVenueDay,
  searchAvailability,
  updateVenue,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { DEFAULT_CLOSE_HOUR, DEFAULT_OPEN_HOUR } from "../src/lib/types";

const PHONE = "0123456789";

function futureDate(offset = 3): string {
  return addDays(todayISO(), offset);
}

describe("per-venue operating hours", () => {
  it("seeds each venue with its own trading hours", async () => {
    const venues = await listVenues();
    expect(venues[0]).toMatchObject({ openHour: 8, closeHour: 23 });
    // The pool venue opens early for the before-work swim.
    expect(venues[1]).toMatchObject({ openHour: 7, closeHour: 22 });
    expect(venues[2]).toMatchObject({ openHour: 9, closeHour: 22 });
  });

  it("sizes the availability grid to the venue's own day", async () => {
    const early = (await listVenues())[1];
    const slots = (await getAvailability(early.id, futureDate()))[0].slots;
    expect(slots[0].hour).toBe(7);
    expect(slots[slots.length - 1].hour).toBe(21);
    expect(slots).toHaveLength(22 - 7);

    const late = (await listVenues())[2];
    const lateSlots = (await getAvailability(late.id, futureDate()))[0].slots;
    expect(lateSlots[0].hour).toBe(9);
    expect(lateSlots[lateSlots.length - 1].hour).toBe(21);
  });

  it("sizes the admin schedule and occupancy report the same way", async () => {
    const venue = (await listVenues())[1];
    const adminSlots = (await getAdminSlots(venue.id, futureDate()))[0].slots;
    expect(adminSlots[0].hour).toBe(7);
    expect(adminSlots).toHaveLength(15);
    expect((await getOccupancy(venue.id, futureDate(), 3)).totalSlotsPerDay).toBe(15);
  });

  it("refuses bookings, classes, blocks and waitlists outside those hours", async () => {
    const venue = (await listVenues())[2]; // 9:00 – 22:00
    const court = venue.courts[0];
    const date = futureDate();

    expect(await createBooking({ courtId: court.id, date, hours: [8], name: "A", phone: PHONE }))
      .toMatchObject({ ok: false, error: "Selected hours are outside operating hours." });
    expect(await createBooking({ courtId: court.id, date, hours: [22], name: "A", phone: PHONE }))
      .toMatchObject({ ok: false });
    expect(await createBooking({ courtId: court.id, date, hours: [9], name: "A", phone: PHONE }))
      .toMatchObject({ ok: true });

    expect(
      await createClassSessions({
        courtId: court.id,
        name: "Drills",
        instructor: "Coach",
        date,
        startHour: 8,
        endHour: 9,
        capacity: 1,
        price: 30,
      })
    ).toMatchObject({ ok: false, error: "Class hours are outside operating hours." });

    expect(await blockSlots(court.id, date, [8, 10])).toMatchObject({ ok: true, changed: 1 });

    expect(
      await joinSlotWaitlist({
        courtId: court.id,
        date,
        startHour: 8,
        endHour: 9,
        name: "B",
        phone: "0198888888",
      })
    ).toMatchObject({ ok: false, error: "Those hours are outside operating hours." });
  });

  it("clamps cross-venue search to each venue's own hours", async () => {
    const date = futureDate(4);
    // 07:00 exists only at the early venue; 22:00 only at the late-closing one.
    const early = await searchAvailability({ sport: "swimming", date, fromHour: 7, toHour: 7 });
    expect(early.length).toBeGreaterThan(0);
    expect(early.every((r) => r.venue.openHour === 7)).toBe(true);

    const tennisAtEight = await searchAvailability({ sport: "tennis", date, fromHour: 8, toHour: 8 });
    // SmashPoint opens at 7, Bangsar at 9 — only the former can offer 8:00.
    expect(tennisAtEight.length).toBeGreaterThan(0);
    expect(tennisAtEight.every((r) => r.venue.openHour === 7)).toBe(true);

    // A 2-hour block must still finish by close: 21:00 at a venue shutting at 22.
    const twoHours = await searchAvailability({
      sport: "tennis", date, fromHour: 21, toHour: 23, duration: 2,
    });
    expect(twoHours).toHaveLength(0);
  });

  it("validates hours when they are edited, and defends existing bookings", async () => {
    const venue = (await listVenues())[0];
    expect(await updateVenue(venue.id, { openHour: 10, closeHour: 10 })).toMatchObject({
      ok: false,
      error: "A venue must be open for at least an hour.",
    });
    expect(await updateVenue(venue.id, { openHour: -1 })).toMatchObject({ ok: false });
    // Past midnight is fine, to 4 AM; not later.
    expect(await updateVenue(venue.id, { closeHour: 29 })).toMatchObject({ ok: false });

    const date = futureDate(5);
    const court = venue.courts[0];
    expect(await createBooking({ courtId: court.id, date, hours: [9], name: "A", phone: PHONE }))
      .toMatchObject({ ok: true });
    expect(await updateVenue(venue.id, { openHour: 12 })).toMatchObject({
      ok: false,
      error: `Bookings already exist outside those hours (the first on ${date}). Cancel or move them first.`,
    });

    expect(await updateVenue(venue.id, { openHour: 6 })).toMatchObject({
      ok: true,
      venue: { openHour: 6, closeHour: DEFAULT_CLOSE_HOUR },
    });
    expect((await getVenue(venue.id))?.openHour).toBe(6);
    await updateVenue(venue.id, { openHour: DEFAULT_OPEN_HOUR });
  });
});

describe("whole-day closures", () => {
  const date = futureDate(6);
  let venueId = 0;

  beforeEach(async () => {
    venueId = (await listVenues())[0].id;
    await reopenVenueDay(venueId, date);
  });

  it("records and lifts a closure", async () => {
    expect(await getVenueClosure(venueId, date)).toBeNull();
    expect(await closeVenueDay(venueId, date, " Hari Raya ")).toMatchObject({
      ok: true,
      closure: { date, reason: "Hari Raya" },
    });
    expect(await getVenueClosure(venueId, date)).toMatchObject({ reason: "Hari Raya" });
    expect((await listVenueClosures(venueId, todayISO())).some((c) => c.date === date)).toBe(true);

    // Closing the same day again just rewrites the reason.
    expect(await closeVenueDay(venueId, date, "Private hire")).toMatchObject({ ok: true });
    expect((await getVenueClosure(venueId, date))?.reason).toBe("Private hire");

    expect(await reopenVenueDay(venueId, date)).toEqual({ ok: true });
    expect(await getVenueClosure(venueId, date)).toBeNull();
    expect(await reopenVenueDay(venueId, date)).toEqual({ ok: false });
  });

  it("rejects a bad date or an unknown venue", async () => {
    expect(await closeVenueDay(venueId, "31-12-2026")).toMatchObject({ ok: false });
    expect(await closeVenueDay(9999, date)).toMatchObject({ ok: false, error: "Venue not found." });
  });

  it("shuts every slot, booking path and waitlist for that day", async () => {
    const court = (await listVenues())[0].courts[0];
    await closeVenueDay(venueId, date, "Hari Raya");

    const slots = (await getAvailability(venueId, date))[0].slots;
    expect(slots.every((s) => !s.available && s.blocked)).toBe(true);

    expect(await createBooking({ courtId: court.id, date, hours: [10], name: "A", phone: PHONE }))
      .toMatchObject({ ok: false, error: "The venue is closed that day." });
    expect(
      await createBookingSeries({
        courtId: court.id, date, hours: [10], weeks: 2, name: "A", phone: PHONE,
      })
    ).toMatchObject({ ok: false, error: "The venue is closed that day." });
    expect(
      await joinSlotWaitlist({
        courtId: court.id, date, startHour: 10, endHour: 11, name: "B", phone: "0198888888",
      })
    ).toMatchObject({ ok: false, error: "The venue is closed that day." });

    expect(
      await createClassSessions({
        courtId: court.id,
        name: "Drills",
        instructor: "Coach",
        date,
        startHour: 10,
        endHour: 11,
        capacity: 4,
        price: 30,
      })
    ).toMatchObject({ ok: false, error: "The venue is closed that day." });

    // Staff still see the day, marked closed rather than empty.
    const adminSlots = (await getAdminSlots(venueId, date))[0].slots;
    expect(adminSlots.every((s) => s.status === "blocked" || s.status === "past")).toBe(true);
    expect(adminSlots[adminSlots.length - 1].blockReason).toBe("Hari Raya");
  });

  it("drops a closed venue out of cross-venue search without hiding the others", async () => {
    const before = await searchAvailability({ sport: "badminton", date, fromHour: 10, toHour: 10 });
    expect(new Set(before.map((r) => r.venue.id)).size).toBeGreaterThan(1);

    await closeVenueDay(venueId, date);
    const after = await searchAvailability({ sport: "badminton", date, fromHour: 10, toHour: 10 });
    expect(after.some((r) => r.venue.id === venueId)).toBe(false);
    expect(after.length).toBeGreaterThan(0);
  });

  it("leaves other dates and other venues alone", async () => {
    await closeVenueDay(venueId, date);
    const otherDate = futureDate(7);
    expect(await getVenueClosure(venueId, otherDate)).toBeNull();
    expect(await getVenueClosure((await listVenues())[1].id, date)).toBeNull();
    const slots = (await getAvailability(venueId, otherDate))[0].slots;
    expect(slots.some((s) => s.available)).toBe(true);
  });
});
