import { describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NO_PRICING_RULES, priceBooking, touchesPeak } from "../src/lib/pricing";
import { instantOf } from "../src/lib/interval";
import { addDays, DEFAULT_PEAK, dayOfWeek, todayISO, type PeakRules } from "../src/lib/time";
import type { PricingPolicy } from "../src/lib/booking-rules";

/**
 * What court time costs (ADR 0010): pro rata to the minute by default, each
 * part at the rate in force then; or fixed prices for set lengths, billing
 * steps and minimums, a minimum charge, setup and cleanup fees apart from the
 * time. Whole minor units throughout, rounded once, half up.
 */

const COURT = { sport: "badminton" as const, offPeakRate: 20, peakRate: 30, memberOffPeakRate: null, memberPeakRate: null, perPlayer: false };
const ZONE = "Asia/Kuala_Lumpur";

/** The next weekday (peak 18:00–24:00 by default). */
const weekday = (() => {
  let d = addDays(todayISO(ZONE), 2);
  while ([0, 6].includes(dayOfWeek(d))) d = addDays(d, 1);
  return d;
})();

const at = (h: number, m = 0) => h * 60 + m;
const price = (start: number, end: number, pricing: Partial<PricingPolicy> = {}, extra: Partial<Parameters<typeof priceBooking>[0]> = {}) =>
  priceBooking({ court: COURT, date: weekday, span: { start, end }, pricing: { ...NO_PRICING_RULES, ...pricing }, ...extra });

describe("pro rata, to the minute", () => {
  it("charges the minutes booked, not the hours they touch", () => {
    expect(price(at(9), at(10, 15)).total).toBe(25);
    expect(price(at(18, 7), at(19, 23)).total).toBe(38);
  });

  it("prices each part at its own rate across the change to peak", () => {
    const q = price(at(17, 30), at(18, 30));
    expect(q.total).toBe(25);
    expect(q.lines.filter((l) => l.kind === "time").map((l) => [l.start, l.minutes, l.peak])).toEqual([
      [at(17, 30), 30, false],
      [at(18), 30, true],
    ]);
  });

  it("changes rate at whatever minute the venue's peak starts", () => {
    const rules: PeakRules = { ...DEFAULT_PEAK, weekdayFrom: at(17, 45) };
    // 15 minutes at 20 an hour, 45 at 30.
    expect(price(at(17, 30), at(18, 30), {}, { rules }).total).toBe(27.5);
    expect(touchesPeak(weekday, { start: at(17), end: at(17, 45) }, rules)).toBe(false);
    expect(touchesPeak(weekday, { start: at(17), end: at(17, 46) }, rules)).toBe(true);
  });

  it("can price the whole booking at the rate when it starts instead", () => {
    expect(price(at(17, 30), at(18, 30), { rateMode: "start" }).total).toBe(20);
    expect(price(at(18), at(19), { rateMode: "start" }).total).toBe(30);
  });

  it("rounds once, half up, in the currency's smallest unit", () => {
    // 7 minutes at 20 an hour is 2.333…
    expect(price(at(9), at(9, 7)).total).toBe(2.33);
    // A minute at 25.50 an hour is 0.425, which rounds up.
    const q = priceBooking({ court: { ...COURT, offPeakRate: 25.5 }, date: weekday, span: { start: at(9), end: at(9, 1) } });
    expect(q.total).toBe(0.43);
  });
});

describe("rules the venue sets", () => {
  it("prices a set length outright, and its peak price when it starts at peak", () => {
    const fixedPrices = [{ minutes: 90, price: 40, peakPrice: 55 }];
    expect(price(at(10), at(11, 30), { fixedPrices }).total).toBe(40);
    expect(price(at(19), at(20, 30), { fixedPrices }).total).toBe(55);
    // Other lengths by the minute.
    expect(price(at(10), at(11), { fixedPrices }).total).toBe(20);
  });

  it("bills in steps, or at least so many minutes, when told", () => {
    const stepped = price(at(9), at(9, 40), { billStep: 30 });
    expect([stepped.billedMinutes, stepped.total]).toEqual([60, 20]);
    const least = price(at(9), at(9, 30), { minBilled: 60 });
    expect([least.billedMinutes, least.total]).toEqual([60, 20]);
    // Without, exactly as booked.
    expect(price(at(9), at(9, 40)).billedMinutes).toBe(40);
  });

  it("charges at least the minimum, saying so", () => {
    const q = price(at(9), at(9, 30), { minCharge: 25 });
    expect(q.total).toBe(25);
    expect(q.lines.find((l) => l.kind === "minimum")?.amount).toBe(15);
  });

  it("adds setup and cleanup fees apart from the time", () => {
    const q = price(at(9), at(10), { setupFee: 5, cleanupFee: 3 });
    expect([q.court, q.fees, q.total]).toEqual([20, 8, 28]);
    expect(q.lines.map((l) => l.kind)).toEqual(["time", "setup", "cleanup"]);
  });

  it("prices per player where the court is, and a member tier's share", () => {
    expect(priceBooking({ court: { ...COURT, perPlayer: true }, date: weekday, span: { start: at(9), end: at(10) }, players: 3 }).total).toBe(60);
    expect(price(at(9), at(10, 15), {}, { member: 80 }).total).toBe(20);
  });
});

describe("last-minute prices", () => {
  it("take off only the minutes that start within the window", () => {
    const start = at(10);
    const rules: PeakRules = { ...DEFAULT_PEAK, lastMinute: { hours: 1, percent: 50, offPeakOnly: true, zone: ZONE } };
    // Booked 45 minutes before: the minutes starting no more than an hour
    // away are its first 16 (10:00 to 10:15 inclusive), at half price.
    const now = instantOf(weekday, start, ZONE).getTime() - 45 * 60_000;
    const q = price(start, start + 60, {}, { rules, at: now });
    expect(q.lines.filter((l) => l.kind === "time").map((l) => [l.minutes, l.rate])).toEqual([
      [16, 10],
      [44, 20],
    ]);
    expect(q.total).toBe(17.33);
    // Without a time of booking (a booking already made, or moved), none.
    expect(price(start, start + 60, {}, { rules }).total).toBe(20);
  });
});
