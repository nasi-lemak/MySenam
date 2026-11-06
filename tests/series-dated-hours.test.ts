import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { setHoursChange } from "../src/lib/dated-changes";
import { setHouseRules } from "../src/lib/house-rules";
import { createBookingSeries, createCourt, createVenue } from "../src/lib/store";
import { addDays, dayOfWeek, todayISO } from "../src/lib/time";

/**
 * A weekly series keeps to the hours and the closed weekdays in force on each of its dates, as its price is each week's
 * own: a change of hours from a later date reaches the weeks that fall after it (ADR 0027).
 */

const at = (h: number) => h * 60;
let venueId: number;
let courtSeq = 0;
let phoneSeq = 0;
/** A court of its own for each test, so one test's weeks never stand in the way of another's. */
async function freshCourt(): Promise<number> {
  const c = await createCourt({ venueId, name: `Court ${++courtSeq}`, sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!c.ok) throw new Error("court");
  return c.court.id;
}
const phone = () => `0177${String(100_000 + ++phoneSeq)}`;

/** The first Monday at least ten days ahead, so the weeks are fixed whatever day the suite runs on. */
function monday(): string {
  let d = addDays(todayISO(), 10);
  while (dayOfWeek(d) !== 1) d = addDays(d, 1);
  return d;
}

beforeAll(async () => {
  const made = await createVenue({ name: "Series Hours Hall", area: "PJ", address: "x", phone: "0312349191", openMin: at(8), closeMin: at(23) });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  expect((await setHouseRules(venueId, { aheadDays: 60 })).ok).toBe(true);
});

describe("a weekly series across a change of hours", () => {
  const D = monday();

  it("skips the weeks that fall outside the hours in force on their dates, and says why", async () => {
    // From D the venue closes at 20:00 instead of 23:00 (nothing is booked yet, so this is accepted).
    expect((await setHoursChange(venueId, { from: D, openMin: at(8), closeMin: at(20) })).ok).toBe(true);
    const series = await createBookingSeries({ courtId: await freshCourt(), date: addDays(D, -7), weeks: 3, start: at(21), minutes: 60, name: "Weekly", phone: phone(), skipConflicts: true });
    if (!series.ok) throw new Error(series.error);
    expect(series.bookings.map((b) => b.date)).toEqual([addDays(D, -7)]);
    expect(series.skipped.map((s) => s.date)).toEqual([D, addDays(D, 7)]);
    expect(series.skipped[0].reason).toMatch(/opening hours/);
  });

  it("without skipping, refuses the whole series, naming the first week that does not fit", async () => {
    const refused = await createBookingSeries({ courtId: await freshCourt(), date: addDays(D, -7), weeks: 3, start: at(21), minutes: 60, name: "Weekly", phone: phone() });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain(D);
  });

  it("keeps every week that fits the later hours", async () => {
    const series = await createBookingSeries({ courtId: await freshCourt(), date: addDays(D, -7), weeks: 3, start: at(18), minutes: 60, name: "Early weekly", phone: phone() });
    if (!series.ok) throw new Error(series.error);
    expect(series.bookings).toHaveLength(3);
  });

  it("lets staff who may go past the court's rules book the weeks anyway, recorded as an override", async () => {
    const series = await createBookingSeries({
      courtId: await freshCourt(),
      date: addDays(D, -7),
      weeks: 3,
      start: at(21),
      minutes: 60,
      name: "Staff weekly",
      phone: phone(),
      by: "staff",
      staff: { override: true },
    });
    if (!series.ok) throw new Error(series.error);
    expect(series.bookings).toHaveLength(3);
    expect(series.overrides).toContain("HOURS");
  });

  it("skips a week that falls on a weekday the venue is closed on from a later date", async () => {
    const E = addDays(monday(), 28);
    // From E Mondays are closed.
    const week = Array.from({ length: 7 }, (_, i) => (i === 1 ? ("closed" as const) : null));
    expect((await setHoursChange(venueId, { from: E, openMin: at(8), closeMin: at(23), weekHours: week })).ok).toBe(true);
    const series = await createBookingSeries({ courtId: await freshCourt(), date: addDays(E, -14), weeks: 4, start: at(10), minutes: 60, name: "Mondays", phone: phone(), skipConflicts: true });
    if (!series.ok) throw new Error(series.error);
    expect(series.bookings.map((b) => b.date)).toEqual([addDays(E, -14), addDays(E, -7)]);
    expect(series.skipped.map((s) => s.date)).toEqual([E, addDays(E, 7)]);
  });
});
