import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { getDb } from "../src/lib/db";
import { customerMayBook, GUEST_SURGE_PER_HOUR, guestSurge } from "../src/lib/limits";
import { createBooking, createCourt, createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * A venue's evening filled from a script under made-up numbers: each number
 * is held to three unpaid bookings, but the venue as a whole notices too many
 * guests in an hour and asks the next to pay online, or to sign in.
 */

let venueId: number;

beforeAll(async () => {
  const made = await createVenue({ name: "Surge Hall", area: "PJ", address: "x", phone: "0312346666", openHour: 7, closeHour: 23 });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  await getDb().prepare("UPDATE venues SET published_at = datetime('now') WHERE id = ?").run(venueId);
  const courts: number[] = [];
  for (let i = 1; i <= 4; i++) {
    const c = await createCourt({ venueId, name: `Court ${i}`, sport: "badminton", offPeakRate: 20, peakRate: 20 });
    if (!c.ok) throw new Error("court");
    courts.push(c.court.id);
  }
  for (let i = 0; i < GUEST_SURGE_PER_HOUR; i++) {
    const made = await createBooking({
      courtId: courts[i % 4],
      date: addDays(todayISO(), 1 + Math.floor(i / 64)),
      hours: [7 + (Math.floor(i / 4) % 16)],
      name: `Guest ${i}`,
      phone: `0190000${String(i).padStart(3, "0")}`,
    });
    if (!made.ok) throw new Error(made.error);
  }
});

describe("a flood of guest bookings", () => {
  it("asks the next guest to sign in where the venue takes nothing online", async () => {
    expect(await guestSurge(venueId)).toBe(true);
    const guest = { venueId, phone: "0198887777", signedIn: false, dates: [addDays(todayISO(), 2)] };
    expect(await customerMayBook(guest)).toMatchObject({ ok: false, code: "GUEST_SURGE" });
    // Signed in, or able to pay online to hold it, they book as usual.
    expect(await customerMayBook({ ...guest, signedIn: true })).toBeNull();
    expect(await customerMayBook({ ...guest, canPayOnline: true })).toBeNull();
  });

  it("is over an hour later", async () => {
    await getDb().prepare("UPDATE bookings SET created_at = datetime('now', '-2 hours')").run();
    expect(await guestSurge(venueId)).toBe(false);
  });
});
