import { describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import {
  createBooking,
  createBookingSeries,
  createCourt,
  getAvailability,
  getAdminSlots,
  getCourt,
  listVenues,
  searchAvailability,
  updateCourt,
  cancelBooking,
} from "../src/lib/store";
import { getDb } from "../src/lib/db";
import { addDays, todayISO } from "../src/lib/time";
import { busyness, isShared } from "../src/lib/types";

const futureDate = (offset: number) => addDays(todayISO(), offset);

async function makeGym(capacity: number, name: string) {
  const venue = (await listVenues())[0];
  const created = await createCourt({
    venueId: venue.id,
    name,
    sport: "gym",
    offPeakRate: 5,
    peakRate: 8,
    capacity,
  });
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error("gym not created");
  return { venue, court: created.court };
}

describe("shared-capacity resources", () => {
  it("defaults a court to exclusive use and keeps that behaviour", async () => {
    const court = (await listVenues())[0].courts[0];
    expect(court.capacity).toBe(1);
    expect(isShared(court)).toBe(false);

    const date = futureDate(3);
    expect((await createBooking({ courtId: court.id, date, hours: [10], name: "A", phone: "0120000001" })).ok)
      .toBe(true);
    // the second person is turned away, exactly as before
    expect(
      await createBooking({ courtId: court.id, date, hours: [10], name: "B", phone: "0120000002" })
    ).toMatchObject({ ok: false, error: expect.stringContaining("booked") });
  });

  it("lets capacity people hold the same hour, then fills up", async () => {
    const { venue, court } = await makeGym(3, "Test Gym Floor");
    const date = futureDate(4);

    for (let i = 0; i < 3; i++) {
      const result = await createBooking({
        courtId: court.id, date, hours: [10], name: `P${i}`, phone: `012000010${i}`,
      });
      expect(result.ok, `booking ${i}`).toBe(true);
    }

    const full = await createBooking({
      courtId: court.id, date, hours: [10], name: "Late", phone: "0120000199",
    });
    expect(full).toMatchObject({ ok: false, error: expect.stringContaining("filled up") });

    const slot = (await getAvailability(venue.id, date))
      .find((a) => a.court.id === court.id)!
      .slots.find((s) => s.hour === 10)!;
    expect(slot).toMatchObject({ booked: 3, capacity: 3, available: false });

    // a neighbouring hour is untouched
    const next = (await getAvailability(venue.id, date))
      .find((a) => a.court.id === court.id)!
      .slots.find((s) => s.hour === 11)!;
    expect(next).toMatchObject({ booked: 0, available: true });
  });

  it("gives every booking a distinct place, and frees it on cancel", async () => {
    const { court } = await makeGym(2, "Seat Check Gym");
    const date = futureDate(5);

    const a = await createBooking({ courtId: court.id, date, hours: [14], name: "A", phone: "0120000201" });
    const b = await createBooking({ courtId: court.id, date, hours: [14], name: "B", phone: "0120000202" });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    const seats = await getDb()
      .prepare("SELECT seat FROM booking_slots WHERE court_id = ? AND date = ? AND hour = 14 ORDER BY seat")
      .all(court.id, date) as { seat: number }[];
    expect(seats.map((s) => s.seat)).toEqual([0, 1]);

    // full, then one cancels and the place is reusable
    expect(
      (await createBooking({ courtId: court.id, date, hours: [14], name: "C", phone: "0120000203" })).ok
    ).toBe(false);
    await cancelBooking(a.booking.code, "0120000201");
    const c = await createBooking({ courtId: court.id, date, hours: [14], name: "C", phone: "0120000203" });
    expect(c.ok).toBe(true);
  });

  it("is still the database that prevents overbooking", async () => {
    const { court } = await makeGym(1, "Constraint Gym");
    const date = futureDate(6);
    const db = getDb();
    const booking = await createBooking({
      courtId: court.id, date, hours: [9], name: "A", phone: "0120000301",
    });
    expect(booking.ok).toBe(true);
    if (!booking.ok) return;

    // taking the same place twice violates UNIQUE (court, date, hour, seat)
    await expect(
      db
        .prepare("INSERT INTO booking_slots (booking_id, court_id, date, hour, seat) VALUES (?, ?, ?, ?, ?)")
        .run(booking.booking.id, court.id, date, 9, 0)
    ).rejects.toThrow(/duplicate key value violates unique constraint/);
  });

  it("hides a full shared slot from cross-venue search", async () => {
    const { court } = await makeGym(1, "Search Gym");
    const date = futureDate(7);
    const before = await searchAvailability({ sport: "gym", date, fromHour: 16, toHour: 16 });
    expect(before.some((r) => r.court.id === court.id)).toBe(true);

    await createBooking({ courtId: court.id, date, hours: [16], name: "A", phone: "0120000401" });
    const after = await searchAvailability({ sport: "gym", date, fromHour: 16, toHour: 16 });
    expect(after.some((r) => r.court.id === court.id)).toBe(false);
  });

  it("reports places taken in the admin grid", async () => {
    const { venue, court } = await makeGym(4, "Grid Gym");
    const date = futureDate(8);
    await createBooking({ courtId: court.id, date, hours: [12], name: "A", phone: "0120000501" });
    await createBooking({ courtId: court.id, date, hours: [12], name: "B", phone: "0120000502" });

    const slots = (await getAdminSlots(venue.id, date)).find((c) => c.court.id === court.id)!.slots;
    const noon = slots.find((s) => s.hour === 12)!;
    expect(noon).toMatchObject({ booked: 2, status: "free" });
    // an exclusive court still surfaces its booking code
    expect(noon.bookingCode).toBeUndefined();
  });

  it("refuses to shrink capacity below what is already booked", async () => {
    const { court } = await makeGym(5, "Shrink Gym");
    const date = futureDate(9);
    for (let i = 0; i < 3; i++) {
      await createBooking({ courtId: court.id, date, hours: [18], name: `P${i}`, phone: `012000060${i}` });
    }
    expect(await updateCourt(court.id, { capacity: 2 })).toMatchObject({
      ok: false,
      error: expect.stringContaining("already booked"),
    });
    // down to exactly what is booked is fine, and growing always is
    expect(await updateCourt(court.id, { capacity: 3 })).toMatchObject({ ok: true });
    expect(await updateCourt(court.id, { capacity: 50 })).toMatchObject({
      ok: true,
      court: { capacity: 50 },
    });
    expect((await getCourt(court.id))?.capacity).toBe(50);
  });

  it("books a shared facility as a weekly series", async () => {
    const { court } = await makeGym(2, "Series Gym");
    const date = futureDate(2);
    const series = await createBookingSeries({
      courtId: court.id, date, hours: [7 + 1], weeks: 3, name: "Regular", phone: "0120000701",
    });
    expect(series.ok).toBe(true);
    if (!series.ok) return;
    expect(series.bookings).toHaveLength(3);
    // someone else can still take the other place each week
    const other = await createBookingSeries({
      courtId: court.id, date, hours: [8], weeks: 3, name: "Other", phone: "0120000702",
    });
    expect(other.ok).toBe(true);
  });
});

describe("busyness levels", () => {
  it("maps fullness to a crowd label", () => {
    expect(busyness(0, 40)).toBe("quiet");
    expect(busyness(15, 40)).toBe("quiet");
    expect(busyness(20, 40)).toBe("filling");
    expect(busyness(31, 40)).toBe("busy");
    expect(busyness(40, 40)).toBe("full");
    expect(busyness(41, 40)).toBe("full");
    expect(busyness(0, 0)).toBe("full");
  });
});
