import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { addHoliday, peakRules, removeHoliday, setPeakRules, upcomingHolidays } from "../src/lib/peak";
import { createBooking, createCourt, createVenue, getAvailability, searchAvailability } from "../src/lib/store";
import { addDays, DEFAULT_PEAK, dayOfWeek, isPeak, todayISO } from "../src/lib/time";

/**
 * Each venue says when its peak rate applies: its own evening hours, its own
 * weekend (Friday and Saturday in some states) and the holidays it prices
 * like the weekend. Until it does, the rule is the one every venue had.
 */

let venueId: number;
let otherId: number;
let n = 0;

/** The next date from three days out falling on `day` (0 = Sunday). */
const next = (day: number) => {
  let d = addDays(todayISO(), 3);
  while (dayOfWeek(d) !== day) d = addDays(d, 1);
  return d;
};

const venue = async (name: string) => {
  const made = await createVenue({ name, area: "Alor Setar", address: "1 Jalan Puncak", phone: "0471234567", openHour: 7, closeHour: 23 });
  if (!made.ok) throw new Error("venue");
  const court = await createCourt({ venueId: made.venue.id, name: "Court 1", sport: "badminton", offPeakRate: 10, peakRate: 20 });
  if (!court.ok) throw new Error("court");
  return made.venue.id;
};

const rateAt = async (id: number, date: string, hour: number) =>
  (await getAvailability(id, date, "badminton"))[0].slots.find((s) => s.hour === hour)!.rate;

beforeAll(async () => {
  venueId = await venue("Peak Hall");
  otherId = await venue("Plain Hall");
});

describe("the rule itself", () => {
  it("by default is weekday evenings from 18:00 and all weekend", () => {
    const wed = next(3);
    const sat = next(6);
    expect(isPeak(wed, 17)).toBe(false);
    expect(isPeak(wed, 18)).toBe(true);
    expect(isPeak(wed, 23)).toBe(true);
    expect(isPeak(sat, 7)).toBe(true);
    expect(DEFAULT_PEAK.weekendDays).toEqual([0, 6]);
  });

  it("follows a venue's own hours, weekend and holidays", () => {
    const rules = { weekdayFrom: 17, weekdayUntil: 22, weekendDays: [5, 6], weekendFrom: 8, weekendUntil: 20, holidays: [next(3)] };
    expect(isPeak(next(1), 16, rules)).toBe(false);
    expect(isPeak(next(1), 17, rules)).toBe(true);
    expect(isPeak(next(1), 22, rules)).toBe(false);
    expect(isPeak(next(5), 8, rules)).toBe(true); // Friday is the weekend here
    expect(isPeak(next(0), 9, rules)).toBe(false); // and Sunday is not
    expect(isPeak(next(6), 21, rules)).toBe(false);
    expect(isPeak(next(3), 10, rules)).toBe(true); // the holiday
  });
});

describe("a venue's settings", () => {
  it("start as the old rule and are checked when changed", async () => {
    expect(await peakRules(venueId)).toEqual(DEFAULT_PEAK);
    const base = { weekdayFrom: 17, weekdayUntil: 22, weekendDays: [5, 6], weekendFrom: 0, weekendUntil: 24 };
    expect(await setPeakRules(venueId, { ...base, weekdayFrom: 23, weekdayUntil: 22 })).toMatchObject({ ok: false });
    expect(await setPeakRules(venueId, { ...base, weekdayFrom: 17.5 })).toMatchObject({ ok: false });
    expect(await setPeakRules(venueId, { ...base, weekendUntil: 25 })).toMatchObject({ ok: false });
    expect(await setPeakRules(venueId, { ...base, weekendDays: [7] })).toMatchObject({ ok: false });
    expect(await setPeakRules(venueId, { ...base, weekendDays: [0, 1, 2, 3] })).toMatchObject({ ok: false });
    expect(await setPeakRules(venueId, { ...base, weekendDays: [6, 5, 6] })).toEqual({ ok: true, rules: { ...base, holidays: [] } });
  });

  it("price the venue's grid, bookings and search, and nobody else's", async () => {
    const mon = next(1);
    const sun = next(0);
    const fri = next(5);
    expect(await rateAt(venueId, mon, 17)).toBe(20);
    expect(await rateAt(venueId, mon, 22)).toBe(10);
    expect(await rateAt(venueId, sun, 10)).toBe(10);
    expect(await rateAt(venueId, fri, 10)).toBe(20);
    // The other venue keeps the old rule.
    expect(await rateAt(otherId, mon, 17)).toBe(10);
    expect(await rateAt(otherId, sun, 10)).toBe(20);

    const court = (await getAvailability(venueId, mon, "badminton"))[0].court;
    const made = await createBooking({ courtId: court.id, date: mon, hours: [16, 17], name: "Aiman", phone: `01922200${++n}0` });
    if (!made.ok) throw new Error(made.error);
    expect(made.booking.totalPrice).toBe(30);

    const found = await searchAvailability({ sport: "badminton", date: fri, fromHour: 10, toHour: 10, venueIds: [venueId, otherId] });
    expect(found.find((r) => r.venue.id === venueId)?.totalPrice).toBe(20);
    expect(found.find((r) => r.venue.id === otherId)?.totalPrice).toBe(10);
  });
});

describe("holidays", () => {
  it("are named dates ahead, priced like the weekend while listed", async () => {
    const tue = next(2);
    expect(await addHoliday(venueId, { date: addDays(todayISO(), -1), name: "Past" })).toMatchObject({ ok: false });
    expect(await addHoliday(venueId, { date: tue, name: "  " })).toMatchObject({ ok: false });
    expect(await addHoliday(venueId, { date: "31-08-2026", name: "Merdeka" })).toMatchObject({ ok: false });
    expect(await rateAt(venueId, tue, 10)).toBe(10);
    expect(await addHoliday(venueId, { date: tue, name: "Hari Kebangsaan" })).toMatchObject({ ok: true });
    // Naming it again renames it rather than listing it twice.
    expect(await addHoliday(venueId, { date: tue, name: "Hari Merdeka" })).toMatchObject({ ok: true });
    expect(await upcomingHolidays(venueId)).toEqual([{ date: tue, name: "Hari Merdeka" }]);
    expect(await rateAt(venueId, tue, 10)).toBe(20);
    expect(await rateAt(otherId, tue, 10)).toBe(10);
    expect(await removeHoliday(venueId, tue)).toBe(true);
    expect(await removeHoliday(venueId, tue)).toBe(false);
    expect(await rateAt(venueId, tue, 10)).toBe(10);
  });
});
