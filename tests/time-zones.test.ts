import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { getDb } from "../src/lib/db";
import { createBooking, createCourt, createVenue, setVenuePin, venueHours } from "../src/lib/store";
import { isBookableDate, isPastSlot, keepsOneOffset, slotStartsAt, todayISO, zoneOffsetMinutes } from "../src/lib/time";
import { setVenueZone, zoneForPin, zoneSettings } from "../src/lib/zones";
import { allRegions } from "../src/lib/region";
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

  it("stays exact on the day a clock changes, however often it is asked", () => {
    // New York goes from -5 to -4 at 07:00 UTC on 8 March 2026; ask either side twice.
    for (let i = 0; i < 2; i++) {
      expect(zoneOffsetMinutes(new Date("2026-03-08T06:59:00Z"), "America/New_York")).toBe(-300);
      expect(zoneOffsetMinutes(new Date("2026-03-08T07:00:00Z"), "America/New_York")).toBe(-240);
      expect(zoneOffsetMinutes(new Date("2026-03-08T23:59:59Z"), "America/New_York")).toBe(-240);
      expect(zoneOffsetMinutes(new Date("2026-03-08T00:00:00Z"), "America/New_York")).toBe(-300);
    }
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
  it("keeps the country's clock when a zone outside it was stored by hand", async () => {
    const away = await venue("Away Courts");
    await getDb().prepare("UPDATE venues SET time_zone = 'America/New_York' WHERE id = ?").run(away.venueId);
    vi.useFakeTimers({ toFake: ["Date"] });
    // 23:00 in Kuala Lumpur, 11:00 in New York: noon is past here, so it is past there too.
    vi.setSystemTime(new Date("2026-10-21T15:00:00Z"));
    expect((await createBooking({ courtId: away.courtId, date: "2026-10-21", hours: [12], name: "x", phone: "0191110001" })).ok).toBe(false);
    vi.useRealTimers();
  });

  it("works out moments on any clock that keeps one offset, for when other countries come", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-21T15:00:00Z"));
    // 10:00 in Bogotá (UTC-5, no daylight saving): noon there is still to come, 09:00 has passed.
    expect(isPastSlot("2026-10-21", 12, "America/Bogota")).toBe(false);
    expect(isPastSlot("2026-10-21", 9, "America/Bogota")).toBe(true);
    expect(slotStartsAt("2026-10-21", 12, "America/Bogota").toISOString()).toBe("2026-10-21T17:00:00.000Z");
    vi.useRealTimers();
  });

  it("puts the booking in calendars at the venue's time", () => {
    const ics = icsContent({ code: "MS-ZONE", date: "2026-03-09", startHour: 18, endHour: 19, courtName: "Court 1", venueName: "Away", totalPrice: 20, timeZone: "America/New_York" });
    expect(ics).toContain("DTSTART:20260309T220000Z");
    expect(ics).toContain("DTEND:20260309T230000Z");
  });
});

describe("the zones a venue may be in", () => {
  // Bookings are wall-clock times turned into moments by the zone. Where the
  // clocks go forward an hour, some wall-clock times never happen and others
  // happen twice; nothing yet decides what a booking at one of them means
  // (known limitations). Until something does, no country's zones have it.
  it("keep one offset all year, in every country", () => {
    for (const r of allRegions())
      for (const zone of r.timeZones) expect(keepsOneOffset(zone), `${r.country} ${zone} changes its clocks: see known limitations before adding it`).toBe(true);
    // The check itself tells a zone with daylight saving apart.
    expect(keepsOneOffset("Europe/London")).toBe(false);
    expect(keepsOneOffset("Australia/Sydney")).toBe(false);
    expect(keepsOneOffset("Asia/Jakarta")).toBe(true);
  });

  it("cannot be one that changes its clocks, however it got there", async () => {
    const made = await createVenue({ name: "Clock Hall", area: "KL", address: "x", phone: "0312348888" });
    if (!made.ok) throw new Error("venue");
    // Not one of the country's, so not offered; and a zone stored by hand is not used.
    expect(await setVenueZone(made.venue.id, "Europe/London")).toMatchObject({ ok: false });
    await getDb().prepare("UPDATE venues SET time_zone = 'Europe/London' WHERE id = ?").run(made.venue.id);
    expect((await zoneSettings(made.venue.id))!.zone).toBe("Asia/Kuala_Lumpur");
  });
});
