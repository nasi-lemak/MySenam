import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { peakRules, setLastMinute } from "../src/lib/peak";
import { computePrice, createBooking, createCourt, createVenue, getAvailability } from "../src/lib/store";
import { addDays, lastMinuteOffAt, slotStartsAt, todayISO, DEFAULT_PEAK, type PeakRules } from "../src/lib/time";

/**
 * Last-minute prices: an hour still free shortly before it starts costs less,
 * for a booking made then; off-peak only unless the venue says otherwise.
 */

const ZONE = "Asia/Kuala_Lumpur";
let venueId: number;
let courtId: number;
const tomorrow = addDays(todayISO(ZONE), 1);
// Tomorrow is a working day or not; pick hours that are off-peak and peak by the default rules either way.
const weekend = [0, 6].includes(new Date(`${tomorrow}T00:00:00Z`).getUTCDay());
const OFF_PEAK_HOUR = weekend ? null : 10;
const PEAK_HOUR = 19;

afterEach(() => vi.useRealTimers());

beforeAll(async () => {
  const made = await createVenue({ name: "Late Deals", area: "PJ", address: "x", phone: "0322220000" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 30 });
  if (!court.ok) throw new Error("court");
  courtId = court.court.id;
});

describe("the rule", () => {
  const rules: PeakRules = { ...DEFAULT_PEAK, lastMinute: { hours: 3, percent: 25, offPeakOnly: true, zone: ZONE } };
  const day = "2026-11-03"; // a Tuesday
  const start = slotStartsAt(day, 10, ZONE).getTime();

  it("applies within the window before the start, not earlier, not after", () => {
    expect(lastMinuteOffAt(day, 10 * 60, rules, start - 2 * 3_600_000)).toBe(25);
    expect(lastMinuteOffAt(day, 10 * 60, rules, start - 3 * 3_600_000)).toBe(25);
    expect(lastMinuteOffAt(day, 10 * 60, rules, start - 4 * 3_600_000)).toBe(0);
    expect(lastMinuteOffAt(day, 10 * 60, rules, start + 60_000)).toBe(0);
  });

  it("leaves peak hours alone unless told", () => {
    const evening = slotStartsAt(day, 19, ZONE).getTime() - 3_600_000;
    expect(lastMinuteOffAt(day, 19 * 60, rules, evening)).toBe(0);
    expect(lastMinuteOffAt(day, 19 * 60, { ...rules, lastMinute: { ...rules.lastMinute!, offPeakOnly: false } }, evening)).toBe(25);
  });

  it("prices only a booking being made, not one already made", () => {
    const court = { offPeakRate: 20, peakRate: 30, memberOffPeakRate: 16, memberPeakRate: null } as Parameters<typeof computePrice>[0];
    expect(computePrice(court, day, { start: 600, end: 660 }, false, rules, start - 3_600_000)).toBe(15);
    expect(computePrice(court, day, { start: 600, end: 660 }, true, rules, start - 3_600_000)).toBe(12);
    expect(computePrice(court, day, { start: 600, end: 660 }, false, rules)).toBe(20);
  });
});

describe("a venue's setting", () => {
  it("is checked, and can be turned off", async () => {
    expect(await setLastMinute(venueId, { hours: 0, percent: 20 })).toMatchObject({ ok: false });
    expect(await setLastMinute(venueId, { hours: 3, percent: 80 })).toMatchObject({ ok: false });
    expect(await setLastMinute(venueId, { hours: 24, percent: 20 })).toMatchObject({ ok: true, lastMinute: { hours: 24, percent: 20, offPeakOnly: true } });
    expect((await peakRules(venueId)).lastMinute).toMatchObject({ hours: 24, percent: 20, offPeakOnly: true, zone: ZONE });
    await setLastMinute(venueId, { off: true });
    expect((await peakRules(venueId)).lastMinute).toBeUndefined();
  });

  it("shows on the grid and is what the booking costs, for hours that qualify", async () => {
    await setLastMinute(venueId, { hours: 24, percent: 20, offPeakOnly: true });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(slotStartsAt(tomorrow, 9, ZONE).getTime() - 3_600_000);
    const [row] = await getAvailability(venueId, tomorrow, "badminton");
    const peak = row.slots.find((s) => s.hour === PEAK_HOUR)!;
    expect(peak.lastMinute).toBeUndefined();
    if (OFF_PEAK_HOUR !== null) {
      const slot = row.slots.find((s) => s.hour === OFF_PEAK_HOUR)!;
      expect(slot).toMatchObject({ lastMinute: 20, rate: 16 });
      const made = await createBooking({ courtId, date: tomorrow, hours: [OFF_PEAK_HOUR], name: "Late Comer", phone: "0122220001" });
      if (!made.ok) throw new Error(made.error);
      expect(made.booking.totalPrice).toBe(16);
    }
    const full = await createBooking({ courtId, date: tomorrow, hours: [PEAK_HOUR], name: "Evening", phone: "0122220002" });
    if (!full.ok) throw new Error(full.error);
    expect(full.booking.totalPrice).toBe(30);
  });
});
