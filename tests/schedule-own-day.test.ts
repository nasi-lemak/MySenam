import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { createBooking, createCourt, createVenue, getAdminSlots } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * The staff schedule's list to the minute shows the day's own occupants
 * (X1-6): not the day before's or after's bookings as zero-minute lines, and
 * an after-midnight booking on the day it belongs to, however the days
 * either side are read for what runs over into this one.
 */

let courtId: number;
let venueId: number;
const day = addDays(todayISO(), 5);

beforeAll(async () => {
  // Open 08:00 to 02:00 the next morning: the small hours belong to the evening before.
  const venue = await createVenue({ name: "Late Night Courts", area: "Cheras", address: "1 Jalan Malam", phone: "+60 3-1111 2222", openMin: 8 * 60, closeMin: 26 * 60 });
  if (!venue.ok) throw new Error(venue.error);
  venueId = venue.venue.id;
  const court = await createCourt({ venueId, name: "Night Court", sport: "badminton", offPeakRate: 20, peakRate: 30 });
  if (!court.ok) throw new Error("court");
  courtId = court.court.id;
});

const book = async (date: string, start: number, end: number, name: string) => {
  const made = await createBooking({ courtId, date, start, end, name, phone: "0123334444" });
  if (!made.ok) throw new Error(made.error);
  return made.booking;
};

describe("the schedule's list to the minute", () => {
  it("lists only the day's own bookings, each on the day it belongs to", async () => {
    const yesterdayEvening = await book(addDays(day, -1), 21 * 60, 22 * 60, "Yesterday Evening");
    // 00:00 to 01:00 after the evening before: that day's booking, in this day's small hours.
    const afterMidnight = await book(addDays(day, -1), 24 * 60, 25 * 60, "After Midnight");
    const today = await book(day, 10 * 60, 11 * 60, "This Morning");
    const tonight = await book(day, 25 * 60, 26 * 60, "Tonight Late");
    const tomorrow = await book(addDays(day, 1), 9 * 60, 10 * 60, "Tomorrow Morning");

    const court = (await getAdminSlots(venueId, day)).find((c) => c.court.id === courtId)!;
    const listed = court.entries.filter((e) => e.kind === "booking");
    expect(listed.map((e) => e.bookingCode).sort()).toEqual([today.code, tonight.code].sort());
    // No zero-minute line for anything.
    expect(court.entries.every((e) => e.end > e.start)).toBe(true);
    expect(listed.find((e) => e.bookingCode === tonight.code)).toMatchObject({ start: 25 * 60, end: 26 * 60 });

    // The day before lists its own evening and its after-midnight booking, and nothing of this day.
    const before = (await getAdminSlots(venueId, addDays(day, -1))).find((c) => c.court.id === courtId)!;
    const theirs = before.entries.filter((e) => e.kind === "booking").map((e) => e.bookingCode).sort();
    expect(theirs).toEqual([yesterdayEvening.code, afterMidnight.code].sort());
    expect(before.entries.find((e) => e.bookingCode === afterMidnight.code)).toMatchObject({ start: 24 * 60, end: 25 * 60 });

    // And the day after shows its morning only, not tonight's late booking.
    const after = (await getAdminSlots(venueId, addDays(day, 1))).find((c) => c.court.id === courtId)!;
    expect(after.entries.filter((e) => e.kind === "booking").map((e) => e.bookingCode)).toEqual([tomorrow.code]);
  });
});
