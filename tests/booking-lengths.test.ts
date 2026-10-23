import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { houseRules, seriesWeeks, setHouseRules } from "../src/lib/house-rules";
import { getDb } from "../src/lib/db";
import {
  createBooking,
  createBookingOnAnyCourt,
  createBookingSeries,
  createCourt,
  createVenue,
  joinSlotWaitlist,
  searchAvailability,
} from "../src/lib/store";
import { policySettings, updatePolicy } from "../src/lib/booking-policy";
import { addDays, todayISO } from "../src/lib/time";

/**
 * How long one booking may be, court by court (futsal two hours at least, a
 * hall for an afternoon), and how many weeks a weekly booking may run.
 */

let venueId: number;
let pitch: number;
let small: number;
let hall: number;
let n = 0;
const date = addDays(todayISO(), 2);
const phone = () => `0188880${String(++n).padStart(3, "0")}`;
const hours = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i);

beforeAll(async () => {
  await getDb().prepare("UPDATE venues SET published_at = NULL").run();
  const made = await createVenue({ name: "Arena Panjang", area: "Klang", address: "x", phone: "0333330000", openMin: 8 * 60, closeMin: 23 * 60 });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  await getDb().prepare("UPDATE venues SET published_at = datetime('now') WHERE id = ?").run(venueId);
  const make = async (name: string, sport: string, rate: number) => {
    const c = await createCourt({ venueId, name, sport: sport as never, offPeakRate: rate, peakRate: rate });
    if (!c.ok) throw new Error(c.error);
    return c.court.id;
  };
  pitch = await make("Futsal A", "futsal", 100);
  small = await make("Futsal B", "futsal", 120);
  hall = await make("Main hall", "badminton", 50);
});

describe("a court's own booking length", () => {
  it("is the court's booking policy, in whole minutes, the shortest no longer than the longest", async () => {
    expect(await updatePolicy({ court: pitch }, { minLength: 0.5 })).toMatchObject({ ok: false });
    expect(await updatePolicy({ court: pitch }, { minLength: 300, maxLength: 240 })).toMatchObject({ ok: false });
    expect(await updatePolicy({ court: hall }, { maxLength: 13 * 60 })).toMatchObject({ ok: false });
    expect(await updatePolicy({ court: pitch }, { minLength: 120 })).toMatchObject({ ok: true, settings: { minLength: 120 } });
    expect(await updatePolicy({ court: hall }, { maxLength: 360 })).toMatchObject({ ok: true, settings: { maxLength: 360 } });
    // Left unset, the rest is inherited: the hour steps and four hours at most.
    expect(await policySettings({ court: pitch })).toMatchObject({ minLength: 120, maxLength: null });
  });

  it("refuses a booking shorter than the court's shortest, or longer than its longest", async () => {
    expect(await createBooking({ courtId: pitch, date, hours: [10], name: "Short", phone: phone() })).toMatchObject({
      ok: false,
      code: "MIN_HOURS",
    });
    expect((await createBooking({ courtId: pitch, date, hours: [10, 11], name: "Two", phone: phone() })).ok).toBe(true);
    expect((await createBooking({ courtId: hall, date, hours: hours(12, 6), name: "Afternoon", phone: phone() })).ok).toBe(true);
    expect(await createBooking({ courtId: hall, date: addDays(date, 1), hours: hours(12, 7), name: "Too long", phone: phone() })).toMatchObject({
      ok: false,
      code: "MAX_HOURS",
    });
    // The usual four hours elsewhere.
    expect(await createBooking({ courtId: small, date, hours: hours(14, 5), name: "Long", phone: phone() })).toMatchObject({ ok: false, code: "MAX_HOURS" });
  });

  it("any court: one hour goes to the court that takes an hour", async () => {
    const made = await createBookingOnAnyCourt({ venueId, sport: "futsal", date, hours: [16], name: "Any", phone: phone() });
    if (!made.ok) throw new Error(made.error);
    expect(made.bookings[0].courtId).toBe(small);
  });

  it("search leaves out a court that will not take that long a booking", async () => {
    const one = await searchAvailability({ sport: "futsal", date, venueIds: [venueId], fromHour: 18, toHour: 18 });
    expect(one.map((r) => r.court.id)).toEqual([small]);
    const two = await searchAvailability({ sport: "futsal", date, venueIds: [venueId], fromHour: 18, toHour: 18, duration: 2 });
    expect(two.map((r) => r.court.id)).toEqual([pitch]);
  });

  it("search and the waiting list take as long a booking as the court does", async () => {
    // The hall takes up to six hours: search finds five, and a waiter can queue for five.
    const day = addDays(date, 1);
    const five = await searchAvailability({ sport: "badminton", date: day, venueIds: [venueId], fromHour: 9, toHour: 9, duration: 5 });
    expect(five.map((r) => [r.court.id, r.endHour - r.startHour])).toEqual([[hall, 5]]);
    const held = await createBooking({ courtId: hall, date: day, hours: hours(12, 5), name: "Long", phone: phone() });
    if (!held.ok) throw new Error(held.error);
    expect(
      await joinSlotWaitlist({ courtId: hall, date: day, startHour: 12, endHour: 17, name: "Waiter", phone: phone() })
    ).toMatchObject({ ok: true });
    // Not past the court's own longest.
    expect(await joinSlotWaitlist({ courtId: hall, date: day, startHour: 12, endHour: 19, name: "Waiter", phone: phone() })).toMatchObject({
      ok: false,
    });
  });
});

describe("weeks in one weekly booking", () => {
  it("is eight unless the venue says, and up to 26", async () => {
    expect(await seriesWeeks(venueId)).toBe(8);
    expect(await createBookingSeries({ courtId: small, date, hours: [9], weeks: 9, name: "Team", phone: phone() })).toMatchObject({
      ok: false,
      code: "WEEKS_RANGE",
    });
    expect(await setHouseRules(venueId, { seriesWeeks: 1 })).toMatchObject({ ok: false });
    expect(await setHouseRules(venueId, { seriesWeeks: 27 })).toMatchObject({ ok: false });
    expect(await setHouseRules(venueId, { seriesWeeks: 26 })).toMatchObject({ ok: true, rules: { seriesWeeks: 26 } });
    const term = await createBookingSeries({ courtId: small, date, hours: [9], weeks: 13, name: "School term", phone: phone() });
    if (!term.ok) throw new Error(term.error);
    expect(term.bookings).toHaveLength(13);
    expect(term.bookings[12].date).toBe(addDays(date, 84));
  });

  it("is not a fair-use rule: setting it alone shows no house rules", async () => {
    const rules = await houseRules(venueId);
    expect(rules).toMatchObject({ upcoming: null, perWeek: null, perDay: null, aheadDays: null, seriesWeeks: 26 });
    const { hasRules } = await import("../src/lib/house-rules");
    expect(hasRules(rules)).toBe(false);
  });
});
