import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { setCourtParts } from "../src/lib/court-links";
import { venueReport } from "../src/lib/reports";
import { blockSlots, createBooking, createCourt, createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * B11: a hall sold as one pitch or as the two courts under it is measured as
 * the floor it is. Selling the pitch uses both courts' floor; the pitch is not
 * a third court's worth of hours to sell.
 */

let venueId: number;
let pitch: number;
let a: number;
let b: number;
let n = 0;
const date = addDays(todayISO(), 5);
const other = addDays(todayISO(), 6);

async function court(name: string, sport: string, capacity = 1): Promise<number> {
  const made = await createCourt({ venueId, name, sport: sport as never, offPeakRate: 20, peakRate: 20, capacity });
  if (!made.ok) throw new Error(made.error);
  return made.court.id;
}

async function book(courtId: number, hours: number[], on = date): Promise<void> {
  const made = await createBooking({ courtId, date: on, hours, name: "Player", phone: `0177771${String(++n).padStart(3, "0")}` });
  if (!made.ok) throw new Error(made.error);
}

beforeAll(async () => {
  const made = await createVenue({ name: "Dewan Floor", area: "Klang", address: "x", phone: "0355551111", openHour: 8, closeHour: 22 });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  pitch = await court("Futsal pitch", "futsal");
  a = await court("Badminton 1", "badminton");
  b = await court("Badminton 2", "badminton");
  expect(await setCourtParts(pitch, [a, b])).toMatchObject({ ok: true });
  // The evening sold as the pitch, a morning hour on each court.
  await book(pitch, [18, 19, 20]);
  await book(a, [9]);
  await book(b, [9]);
});

describe("utilisation of a hall sold as a pitch or as its courts", () => {
  it("counts the floor once: two courts' hours to sell, the pitch's evening filling both", async () => {
    const report = (await venueReport(venueId, date, date))!;
    // 14 open hours on each of two pieces of floor; the pitch is not a third.
    expect(report.utilisation.courts.sellableHours).toBe(28);
    // Three pitch hours cover both courts (6), plus an hour on each.
    expect(report.utilisation.courts.soldHours).toBe(8);
    expect(report.utilisation.courts.percent).toBeCloseTo(8 / 28);
  });

  it("shows each court in use while the pitch over it is, and the pitch in use while a court under it is", async () => {
    const report = (await venueReport(venueId, date, date))!;
    const line = (id: number) => report.byCourt.find((c) => c.courtId === id)!;
    expect(line(a)).toMatchObject({ hours: 1, inUseHours: 4 });
    expect(line(b)).toMatchObject({ hours: 1, inUseHours: 4 });
    // Both courts at nine are one hour of the pitch, not two.
    expect(line(pitch)).toMatchObject({ hours: 3, inUseHours: 4 });
  });

  it("gives what the floor took per hour it could have been sold", async () => {
    const report = (await venueReport(venueId, date, date))!;
    const takings = report.byCourt.reduce((sum, c) => sum + Number(c.expected), 0);
    expect(report.utilisation.revenuePerHour).toBeCloseTo(takings / 28, 2);
  });

  it("takes a block on the pitch off both courts' floor, once", async () => {
    expect((await blockSlots(pitch, other, [10, 11], "School event")).ok).toBe(true);
    const report = (await venueReport(venueId, other, other))!;
    expect(report.utilisation.courts.sellableHours).toBe(28 - 4);
    expect(report.utilisation.courts.soldHours).toBe(0);
  });

  it("measures a venue whose courts share nothing as before", async () => {
    const made = await createVenue({ name: "Plain Courts", area: "Klang", address: "x", phone: "0355552222", openHour: 8, closeHour: 22 });
    if (!made.ok) throw new Error("venue");
    const save = venueId;
    venueId = made.venue.id;
    const one = await court("Court 1", "badminton");
    await court("Court 2", "badminton");
    await book(one, [10, 11]);
    const report = (await venueReport(venueId, date, date))!;
    expect(report.utilisation.courts).toMatchObject({ soldHours: 2, sellableHours: 28 });
    expect(report.byCourt.find((c) => c.courtId === one)).toMatchObject({ hours: 2, inUseHours: 2 });
    venueId = save;
  });
});
