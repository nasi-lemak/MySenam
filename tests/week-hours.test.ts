import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { createOutage } from "../src/lib/outages";
import { venueReport } from "../src/lib/reports";
import {
  createBooking,
  createBookingSeries,
  createCourt,
  createVenue,
  getAvailability,
  getVenue,
  searchAvailability,
  updateVenue,
} from "../src/lib/store";
import { addDays, dayOfWeek, isPastSlot, slotStartsAt, todayISO } from "../src/lib/time";
import { hoursOn, validateWeekHours, weekLines } from "../src/lib/week-hours";

/**
 * Hours that differ by weekday, a weekday closed every week, and hours that
 * run past midnight: booked, shown, searched, reported, and kept from running
 * into the next morning's opening.
 */

const ZONE = "Asia/Kuala_Lumpur";
let venueId: number;
let courtId: number;
let n = 0;
const phone = () => `0166660${String(++n).padStart(3, "0")}`;

/** The next date, from tomorrow, falling on this weekday (0 is Sunday). */
function next(weekday: number, after = 1): string {
  let d = addDays(todayISO(ZONE), after);
  while (dayOfWeek(d) !== weekday) d = addDays(d, 1);
  return d;
}

const MONDAY = 1;
const THURSDAY = 4;
const FRIDAY = 5;

afterEach(() => vi.useRealTimers());

beforeAll(async () => {
  await getDb().prepare("UPDATE venues SET published_at = NULL").run();
  const made = await createVenue({ name: "Night Futsal", area: "PJ", address: "x", phone: "0312343333", openHour: 16, closeHour: 24 });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  await getDb().prepare("UPDATE venues SET published_at = datetime('now') WHERE id = ?").run(venueId);
  const court = await createCourt({ venueId, name: "Pitch 1", sport: "futsal", offPeakRate: 100, peakRate: 100 });
  if (!court.ok) throw new Error("court");
  courtId = court.court.id;
});

describe("a week of hours", () => {
  it("is checked: each day open, within bounds, and not running into the next morning", () => {
    const usual = { openHour: 16, closeHour: 24 };
    expect(validateWeekHours(null, usual)).toEqual({ ok: true, week: null });
    expect(validateWeekHours([null, null, null, null, null, null, null], usual)).toEqual({ ok: true, week: null });
    expect(validateWeekHours([null], usual)).toMatchObject({ ok: false });
    expect(validateWeekHours([null, { open: 20, close: 19 }, null, null, null, null, null], usual)).toMatchObject({ ok: false });
    expect(validateWeekHours([null, null, null, null, null, { open: 16, close: 29 }, null], usual)).toMatchObject({ ok: false });
    // Friday until 2 AM is fine while Saturday opens at 8 AM; not if Saturday opens at 1 AM.
    expect(validateWeekHours([null, null, null, null, null, { open: 16, close: 26 }, { open: 8, close: 24 }], usual)).toMatchObject({ ok: true });
    expect(validateWeekHours([null, null, null, null, null, { open: 16, close: 26 }, { open: 1, close: 24 }], usual)).toMatchObject({ ok: false });
    // Unless Saturday is closed.
    expect(validateWeekHours([null, null, null, null, null, { open: 16, close: 26 }, "closed"], usual)).toMatchObject({ ok: true });
  });

  it("reads as runs of days for a page", () => {
    const venue = { openHour: 16, closeHour: 24, weekHours: ["closed", "closed", null, null, null, { open: 16, close: 26 }, { open: 8, close: 26 }] as never };
    expect(weekLines(venue)).toEqual([
      { from: 1, to: 1, hours: "closed" },
      { from: 2, to: 4, hours: { open: 16, close: 24 } },
      { from: 5, to: 5, hours: { open: 16, close: 26 } },
      { from: 6, to: 6, hours: { open: 8, close: 26 } },
      { from: 0, to: 0, hours: "closed" },
    ]);
    expect(hoursOn(venue, next(FRIDAY))).toEqual({ openHour: 16, closeHour: 26, closed: false });
  });
});

describe("a venue with its own hours by weekday", () => {
  it("saves them, and closes the weekday it never opens", async () => {
    const week = [null, "closed", null, null, null, { open: 16, close: 26 }, { open: 8, close: 26 }];
    const saved = await updateVenue(venueId, { weekHours: week });
    if (!saved.ok) throw new Error(saved.error);
    expect(saved.venue.weekHours).toEqual(week);
    const monday = await getAvailability(venueId, next(MONDAY));
    expect(monday[0].slots.every((s) => !s.available)).toBe(true);
    expect(await createBooking({ courtId, date: next(MONDAY), hours: [18], name: "Mon", phone: phone() })).toMatchObject({ ok: false, code: "VENUE_CLOSED" });
    expect(await searchAvailability({ sport: "futsal", date: next(MONDAY) })).toEqual([]);
  });

  it("sells Friday until 2 AM, as hours of the Friday, and Thursday only to midnight", async () => {
    const friday = next(FRIDAY);
    const slots = (await getAvailability(venueId, friday))[0].slots.map((s) => s.hour);
    expect(slots[0]).toBe(16);
    expect(slots[slots.length - 1]).toBe(25);
    const late = await createBooking({ courtId, date: friday, hours: [24, 25], name: "Late Kickers", phone: phone() });
    if (!late.ok) throw new Error(late.error);
    expect(late.booking).toMatchObject({ date: friday, startHour: 24, endHour: 26 });
    expect(await createBooking({ courtId, date: next(THURSDAY), hours: [24], name: "Too late", phone: phone() })).toMatchObject({ ok: false });
    // Found by search after midnight too.
    const found = await searchAvailability({ sport: "futsal", date: friday, fromHour: 22 });
    expect(found.some((r) => r.startHour === 22)).toBe(true);
  });

  it("knows 1 AM after a Friday has not passed at half past midnight, and midnight has", () => {
    const friday = next(FRIDAY);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(slotStartsAt(friday, 24.5, ZONE));
    expect(isPastSlot(friday, 25, ZONE)).toBe(false);
    expect(isPastSlot(friday, 24, ZONE)).toBe(true);
    expect(isPastSlot(friday, 23, ZONE)).toBe(true);
  });

  it("weekly bookings skip the weekday it is closed and keep each day's own hours", async () => {
    // A Sunday series: Sundays keep the usual hours.
    const made = await createBookingSeries({ courtId, date: next(0), hours: [20], weeks: 2, skipConflicts: true, name: "Sunday League", phone: phone() });
    if (!made.ok) throw new Error(made.error);
    expect(made.bookings).toHaveLength(2);
  });

  it("a court out of service is out in the late hours too", async () => {
    await ensureBootstrapAdmin();
    const friday = next(FRIDAY, 8);
    const made = await createOutage({ courtId, startsOn: friday, endsOn: friday, reason: "Lights", adminId: (await listAdmins())[0].id });
    expect(made.ok).toBe(true);
    const slots = (await getAvailability(venueId, friday))[0].slots;
    expect(slots.find((s) => s.hour === 25)!.available).toBe(false);
    expect(slots.every((s) => !s.available)).toBe(true);
  });

  it("will not close a weekday, or shorten it, with bookings already sold in the hours that go", async () => {
    const friday = next(FRIDAY);
    const refused = await updateVenue(venueId, { weekHours: [null, "closed", null, null, null, { open: 16, close: 24 }, { open: 8, close: 26 }] });
    expect(refused).toMatchObject({ ok: false });
    if (!refused.ok) expect(refused.error).toContain(friday);
  });

  it("counts a weekday it never opens as a closed day in the report", async () => {
    const monday = next(MONDAY);
    const report = await venueReport(venueId, monday, addDays(monday, 6));
    expect(report!.closedDays).toBe(1);
    expect((await getVenue(venueId))!.weekHours?.[MONDAY]).toBe("closed");
  });
});
