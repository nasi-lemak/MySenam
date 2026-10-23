import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { bookingsCsv } from "../src/lib/export";
import { createBooking, createCourt, createVenue, searchBookings } from "../src/lib/store";
import { updatePolicy } from "../src/lib/booking-policy";
import { addDays, todayISO } from "../src/lib/time";

/** The desk finding a booking for the customer in front of it, and the export reading half hours right. */

let venueId: number;
let otherVenueId: number;
let courtId: number;
let otherCourtId: number;
let code: string;

beforeAll(async () => {
  const a = await createVenue({ name: "Desk Hall", area: "PJ", address: "x", phone: "0312345555", openHour: 8, closeHour: 22 });
  const b = await createVenue({ name: "Other Hall", area: "PJ", address: "x", phone: "0312345556", openHour: 8, closeHour: 22 });
  if (!a.ok || !b.ok) throw new Error("venue");
  venueId = a.venue.id;
  otherVenueId = b.venue.id;
  const c = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  const d = await createCourt({ venueId: otherVenueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!c.ok || !d.ok) throw new Error("court");
  courtId = c.court.id;
  otherCourtId = d.court.id;
  await updatePolicy({ venue: venueId }, { startEvery: 30, lengthStep: 30 });
  const made = await createBooking({ courtId, date: addDays(todayISO(), 3), hours: [10.5, 11], name: "Nurul Aina", phone: "012-555 4321", email: "Aina@Example.my" });
  if (!made.ok) throw new Error(made.error);
  code = made.booking.code;
  const elsewhere = await createBooking({ courtId: otherCourtId, date: addDays(todayISO(), 3), hours: [10], name: "Nurul Aina", phone: "0125554321" });
  if (!elsewhere.ok) throw new Error(elsewhere.error);
});

describe("finding a booking at the desk", () => {
  it("by code, number however typed, email or part of a name", async () => {
    for (const q of [code.toLowerCase(), "+60 12-555 4321", "aina@example.my", "nurul"]) {
      const hits = await searchBookings(q, [venueId]);
      expect(hits.map((h) => h.code)).toEqual([code]);
    }
    expect(await searchBookings("zz", [venueId])).toEqual([]);
  });

  it("only at the venues the staff work at", async () => {
    expect((await searchBookings("nurul", [venueId, otherVenueId])).length).toBe(2);
    expect((await searchBookings("nurul", [])).length).toBe(0);
  });
});

describe("the bookings export", () => {
  it("writes a half hour as :30", async () => {
    const csv = await bookingsCsv(venueId, addDays(todayISO(), -1), addDays(todayISO(), 10));
    expect(csv).toContain('"10:30","11:30"');
  });
});
