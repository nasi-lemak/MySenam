import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { setCourtParts } from "../src/lib/court-links";
import { measureUse, venueReport, type UseRecords } from "../src/lib/reports";
import { blockSlots, closeVenueDay, createBooking, createCourt, createVenue, getOccupancy } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * The occupancy grid's venue totals are measured as the reports measure
 * utilisation (docs/features/reporting.md, B11): the courts' floor once, a
 * pitch and the courts under it being the same floor, and shared facilities'
 * places apart, never blended with it. Not the sum of the courts' lines.
 */

let venueId: number;
let pitch: number;
let a: number;
let b: number;
let gym: number;
let n = 0;
const date = addDays(todayISO(), 5);
const blocked = addDays(todayISO(), 6);
const shut = addDays(todayISO(), 7);

async function court(name: string, sport: string, capacity = 1): Promise<number> {
  const made = await createCourt({ venueId, name, sport: sport as never, offPeakRate: 20, peakRate: 20, capacity });
  if (!made.ok) throw new Error(made.error);
  return made.court.id;
}

async function book(courtId: number, hours: number[], on = date, players?: number): Promise<void> {
  const made = await createBooking({
    by: "staff",
    courtId,
    date: on,
    hours,
    name: "Player",
    phone: `0177772${String(++n).padStart(3, "0")}`,
    ...(players ? { players } : {}),
  });
  if (!made.ok) throw new Error(made.error);
}

const totalsOn = async (d: string) => (await getOccupancy(venueId, d, 1)).days[0].totals;

beforeAll(async () => {
  const made = await createVenue({ name: "Dewan Grid", area: "Klang", address: "x", phone: "0355553333", openHour: 8, closeHour: 22 });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  pitch = await court("Futsal pitch", "futsal");
  a = await court("Badminton 1", "badminton");
  b = await court("Badminton 2", "badminton");
  expect(await setCourtParts(pitch, [a, b])).toMatchObject({ ok: true });
});

describe("the occupancy grid's venue totals", () => {
  it("counts a pitch over two courts booked for an hour as that floor once", async () => {
    await book(pitch, [18]);
    const totals = await totalsOn(date);
    // Two pieces of floor, fourteen open hours each; the pitch is not a third.
    expect(totals.courts).toMatchObject({ soldHours: 2, sellableHours: 28 });
    expect(totals.courts!.percent).toBeCloseTo(2 / 28);
    // The courts' own lines still show each court in use under the pitch: 3 of 42 if added up.
    const lines = (await getOccupancy(venueId, date, 1)).days[0].perCourt;
    expect(lines.reduce((s, c) => s + c.booked, 0)).toBe(3);
    // No shared facility yet: no row for it.
    expect(totals.shared).toBeNull();
  });

  it("keeps a shared facility apart: booking its places does not move the courts' percentage", async () => {
    const before = (await totalsOn(date)).courts!;
    gym = await court("Gym floor", "gym", 10);
    await book(gym, [9, 10], date, 3);
    const totals = await totalsOn(date);
    expect(totals.courts).toEqual(before);
    // Three places for two hours, of ten places for fourteen hours.
    expect(totals.shared).toMatchObject({ soldHours: 6, sellableHours: 140 });
    expect(totals.shared!.percent).toBeCloseTo(6 / 140);
  });

  it("takes a block on the pitch off both courts' floor once, and a partial block off the shared places", async () => {
    expect((await blockSlots(pitch, blocked, [10, 11], "School event")).ok).toBe(true);
    expect((await blockSlots(gym, blocked, [12], "Four mats out", 4)).ok).toBe(true);
    await book(a, [15], blocked);
    const totals = await totalsOn(blocked);
    expect(totals.courts).toMatchObject({ soldHours: 1, sellableHours: 28 - 4 });
    expect(totals.shared).toMatchObject({ soldHours: 0, sellableHours: 140 - 4 });
  });

  it("offers nothing on a closed day", async () => {
    expect((await closeVenueDay(venueId, shut, "Hari Raya")).ok).toBe(true);
    const totals = await totalsOn(shut);
    expect(totals.courts).toMatchObject({ soldHours: 0, sellableHours: 0, percent: 0 });
    expect(totals.shared).toMatchObject({ soldHours: 0, sellableHours: 0, percent: 0 });
  });

  it("equals the period report for the same day", async () => {
    const grid = await getOccupancy(venueId, date, 3);
    for (const day of grid.days) {
      const report = (await venueReport(venueId, day.date, day.date))!;
      expect(day.totals.courts).toEqual(report.utilisation.courts);
      expect(day.totals.shared).toEqual(report.utilisation.shared);
    }
    // And the days together are the period's report.
    const period = (await venueReport(venueId, date, addDays(date, 2)))!;
    const sum = (k: "courts" | "shared", f: "soldHours" | "sellableHours") =>
      grid.days.reduce((s, d) => s + d.totals[k]![f], 0);
    expect(period.utilisation.courts.soldHours).toBeCloseTo(sum("courts", "soldHours"));
    expect(period.utilisation.courts.sellableHours).toBeCloseTo(sum("courts", "sellableHours"));
    expect(period.utilisation.shared.soldHours).toBeCloseTo(sum("shared", "soldHours"));
    expect(period.utilisation.shared.sellableHours).toBeCloseTo(sum("shared", "sellableHours"));
  });

  it("counts every place a booking takes on a shared facility in the report, as the grid's line does", async () => {
    const report = (await venueReport(venueId, date, date))!;
    const line = report.byCourt.find((c) => c.courtId === gym)!;
    const cell = (await getOccupancy(venueId, date, 1)).days[0].perCourt.find((c) => c.courtId === gym)!;
    expect(line.hours).toBe(6);
    expect(cell.booked).toBe(6);
    expect(line.inUseHours).toBe(6);
    // The period report's other hours count places the same way: by sport, by month, by hour and in all.
    expect(report.bySport.find((s) => s.sport === "gym")!.hours).toBe(6);
    const allCourts = report.byCourt.reduce((n, c) => n + c.hours, 0);
    expect(report.bookings.hours).toBe(allCourts);
    expect(report.byMonth.reduce((n, m) => n + m.hours, 0)).toBe(allCourts);
    expect(report.byHour.reduce((n, h) => n + h.hours, 0)).toBe(allCourts);
  });

  it("has no courts' row for a venue of shared facilities only", async () => {
    const made = await createVenue({ name: "Kayak Jetty", area: "Klang", address: "x", phone: "0355554444", openHour: 8, closeHour: 18 });
    if (!made.ok) throw new Error("venue");
    const save = venueId;
    venueId = made.venue.id;
    await court("Kayaks", "kayak", 6);
    const totals = await totalsOn(date);
    expect(totals.courts).toBeNull();
    expect(totals.shared).toMatchObject({ soldHours: 0, sellableHours: 60 });
    venueId = save;
  });
});

describe("measureUse, the measure the report and the grid share", () => {
  const records = (): UseRecords => ({
    courts: [
      { id: 1, capacity: 1 }, // the pitch
      { id: 2, capacity: 1 },
      { id: 3, capacity: 1 },
      { id: 4, capacity: 8 }, // a gym floor
    ],
    openOn: new Map([
      ["2026-11-02", { start: 480, end: 1320 }],
      ["2026-11-03", { start: 480, end: 1320 }],
    ]),
    // The pitch covers its own space (10) and its courts' (20, 30).
    cover: [
      { court_id: 1, space_id: 10, owner: 1 },
      { court_id: 1, space_id: 20, owner: 2 },
      { court_id: 1, space_id: 30, owner: 3 },
      { court_id: 2, space_id: 20, owner: 2 },
      { court_id: 3, space_id: 30, owner: 3 },
    ],
    sold: [
      { court_id: 1, date: "2026-11-02", start_min: 1080, end_min: 1140, places: 1 },
      { court_id: 2, date: "2026-11-02", start_min: 540, end_min: 600, places: 1 },
      { court_id: 4, date: "2026-11-02", start_min: 540, end_min: 660, places: 3 },
      { court_id: 2, date: "2026-11-03", start_min: 540, end_min: 600, places: 1 },
    ],
    blocks: [],
    outages: [],
  });

  it("measures one day: the pitch's hour fills both courts, the shared places stay apart", () => {
    const use = measureUse(records(), ["2026-11-02"]);
    expect(use.courts).toMatchObject({ soldHours: 3, sellableHours: 28 });
    expect(use.shared).toMatchObject({ soldHours: 6, sellableHours: 112 });
    expect(use.floorCourts).toBe(2);
    expect(use.sharedCourts).toBe(1);
    expect(use.perCourt.get(1)).toMatchObject({ soldHours: 1, inUseHours: 2 });
  });

  it("measures only the days asked for", () => {
    expect(measureUse(records(), ["2026-11-03"]).courts).toMatchObject({ soldHours: 1, sellableHours: 28 });
    expect(measureUse(records(), ["2026-11-02", "2026-11-03"]).courts).toMatchObject({ soldHours: 4, sellableHours: 56 });
    expect(measureUse(records(), ["2026-11-04"]).courts).toMatchObject({ soldHours: 0, sellableHours: 0, percent: 0 });
  });
});
