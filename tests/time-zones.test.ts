import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { getDb } from "../src/lib/db";
import { createBooking, createCourt, createVenue, getAvailability, setVenuePin, venueHours } from "../src/lib/store";
import { isBookableDate, isPastSlot, slotStartsAt, todayISO, zoneOffsetMinutes } from "../src/lib/time";
import { setVenueZone, zoneForPin, zoneSettings } from "../src/lib/zones";
import { icsContent } from "../src/lib/booking-links";

/**
 * Each venue keeps its courts' times on its own clock: worked out from its
 * map pin, or chosen by staff, and turned into moments with that zone's rules,
 * daylight saving included.
 */

let venueId: number;
let n = 0;

async function venue(name: string) {
  const made = await createVenue({ name, area: "x", address: "x", phone: `03123${String(++n).padStart(5, "0")}`, openHour: 6, closeHour: 23 });
  if (!made.ok) throw new Error("venue");
  const court = await createCourt({ venueId: made.venue.id, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!court.ok) throw new Error("court");
  return { venueId: made.venue.id, courtId: court.court.id };
}

beforeAll(async () => {
  venueId = (await venue("Kota Kinabalu Courts")).venueId;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a venue's zone, from its pin", () => {
  it("is where the pin is, within the country", () => {
    expect(zoneForPin(3.1185, 101.623)).toBe("Asia/Kuala_Lumpur"); // Petaling Jaya
    expect(zoneForPin(5.98, 116.07)).toBe("Asia/Kuching"); // Kota Kinabalu
    expect(zoneForPin(null, null)).toBe("Asia/Kuala_Lumpur");
    // Jakarta is not a Malaysian zone: the country's own instead.
    expect(zoneForPin(-6.2, 106.8)).toBe("Asia/Kuala_Lumpur");
  });

  it("follows the pin until staff choose, and then stays", async () => {
    expect((await venueHours(venueId)).zone).toBe("Asia/Kuala_Lumpur");
    await setVenuePin(venueId, { lat: 5.98, lng: 116.07 });
    expect(await zoneSettings(venueId)).toMatchObject({ zone: "Asia/Kuching", chosen: false, fromPin: "Asia/Kuching" });

    expect(await setVenueZone(venueId, "America/New_York")).toMatchObject({ ok: false });
    expect(await setVenueZone(venueId, "Asia/Kuala_Lumpur")).toMatchObject({ ok: true, settings: { zone: "Asia/Kuala_Lumpur", chosen: true } });
    await setVenuePin(venueId, { lat: 5.9, lng: 116.1 });
    expect((await venueHours(venueId)).zone).toBe("Asia/Kuala_Lumpur");

    expect(await setVenueZone(venueId, null)).toMatchObject({ ok: true, settings: { zone: "Asia/Kuching", chosen: false } });
  });
});

describe("turning a venue's clock into moments", () => {
  it("knows each zone's offset, daylight saving and all", () => {
    expect(zoneOffsetMinutes(new Date("2026-10-21T00:00:00Z"), "Asia/Kuala_Lumpur")).toBe(480);
    expect(zoneOffsetMinutes(new Date("2026-01-15T12:00:00Z"), "America/New_York")).toBe(-300);
    expect(zoneOffsetMinutes(new Date("2026-07-15T12:00:00Z"), "America/New_York")).toBe(-240);
  });

  it("puts 18:00 at the right moment either side of a clock change", () => {
    expect(slotStartsAt("2026-10-21", 18, "Asia/Kuching").toISOString()).toBe("2026-10-21T10:00:00.000Z");
    expect(slotStartsAt("2026-10-21", 18.5, "Asia/Singapore").toISOString()).toBe("2026-10-21T10:30:00.000Z");
    // New York springs forward at 02:00 on 8 March 2026.
    expect(slotStartsAt("2026-03-07", 18, "America/New_York").toISOString()).toBe("2026-03-07T23:00:00.000Z");
    expect(slotStartsAt("2026-03-09", 18, "America/New_York").toISOString()).toBe("2026-03-09T22:00:00.000Z");
    // And falls back on 1 November.
    expect(slotStartsAt("2026-11-02", 9, "America/New_York").toISOString()).toBe("2026-11-02T14:00:00.000Z");
  });

  it("decides what has passed, and what today is, by the venue's clock", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-21T15:00:00Z")); // 23:00 in Kuala Lumpur, 11:00 in New York
    expect(todayISO("Asia/Kuala_Lumpur")).toBe("2026-10-21");
    expect(isPastSlot("2026-10-21", 12, "Asia/Kuala_Lumpur")).toBe(true);
    expect(isPastSlot("2026-10-21", 12, "America/New_York")).toBe(false);
    vi.setSystemTime(new Date("2026-10-21T17:00:00Z")); // past midnight in Kuala Lumpur, 13:00 in New York
    expect(todayISO("Asia/Kuala_Lumpur")).toBe("2026-10-22");
    expect(todayISO("America/New_York")).toBe("2026-10-21");
    expect(isBookableDate("2026-10-21", "Asia/Kuala_Lumpur")).toBe(false);
    expect(isBookableDate("2026-10-21", "America/New_York")).toBe(true);
  });
});

describe("booking at a venue on another clock", () => {
  it("lets a slot be booked that has passed at the install but not at the venue", async () => {
    const home = await venue("Home Courts");
    const away = await venue("Away Courts");
    // A zone outside the country, set directly: what an install spanning zones would hold.
    await getDb().prepare("UPDATE venues SET time_zone = 'America/New_York' WHERE id = ?").run(away.venueId);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-21T15:00:00Z"));
    const date = "2026-10-21";
    expect((await createBooking({ courtId: home.courtId, date, hours: [12], name: "x", phone: "0191110001" })).ok).toBe(false);
    const made = await createBooking({ courtId: away.courtId, date, hours: [12], name: "Sam", phone: "0191110002" });
    expect(made.ok).toBe(true);
    const slots = (await getAvailability(away.venueId, date))[0].slots;
    expect(slots.find((s) => s.hour === 10)!.available).toBe(false); // 10:00 has passed there
    expect(slots.find((s) => s.hour === 14)!.available).toBe(true);
  });

  it("puts the booking in calendars at the venue's time", () => {
    const ics = icsContent({ code: "MS-ZONE", date: "2026-03-09", startHour: 18, endHour: 19, courtName: "Court 1", venueName: "Away", totalPrice: 20, timeZone: "America/New_York" });
    expect(ics).toContain("DTSTART:20260309T220000Z");
    expect(ics).toContain("DTEND:20260309T230000Z");
  });
});
