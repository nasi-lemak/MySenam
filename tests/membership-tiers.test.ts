import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { aheadFor, houseRuleRefusal, venueAheadDays } from "../src/lib/house-rules";
import { createPlan, setPlanBenefits } from "../src/lib/membership-plans";
import { createBooking, createCourt, createVenue, getAvailability, sellMembership, updateCourt } from "../src/lib/store";
import { addDays, dayOfWeek, todayISO } from "../src/lib/time";

/** Membership tiers: a plan with its own price level and booking window, however the membership was sold. */

let venueId: number;
let courtId: number;
let gold: number;
let n = 0;
const phone = () => `0122220${String(++n).padStart(3, "0")}`;
let date = addDays(todayISO(), 1);
while ([0, 6].includes(dayOfWeek(date))) date = addDays(date, 1);

const member = async (who: string, tierId?: number) => {
  const sold = await sellMembership({
    venueId,
    holderName: "Member",
    holderPhone: who,
    startsOn: todayISO(),
    expiresOn: addDays(todayISO(), 60),
    price: 100,
    ...(tierId ? { tierId } : {}),
  });
  if (!sold.ok) throw new Error(sold.error);
  return sold.membership;
};

beforeAll(async () => {
  const v = await createVenue({ name: "Kelab Raket", area: "Ampang", address: "x", phone: "0344440000" });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  const c = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 30 });
  if (!c.ok) throw new Error("court");
  courtId = c.court.id;
  // Every member: RM15 off-peak at the court's member rate.
  await updateCourt(courtId, { memberOffPeakRate: 15, memberPeakRate: 25 });
});

describe("a plan as a tier", () => {
  it("carries a price level and a booking window, each checked", async () => {
    expect(await createPlan(venueId, { name: "Gold", months: 12, price: 500, ratePercent: 5 })).toMatchObject({ ok: false });
    expect(await createPlan(venueId, { name: "Gold", months: 12, price: 500, aheadDays: 120 })).toMatchObject({ ok: false });
    const made = await createPlan(venueId, { name: "Gold", months: 12, price: 500, ratePercent: 70, aheadDays: 30 });
    if (!made.ok) throw new Error(made.error);
    gold = made.plan.id;
    expect(made.plan).toMatchObject({ ratePercent: 70, aheadDays: 30 });
    expect(await setPlanBenefits(venueId, gold, { ratePercent: 60, aheadDays: 30 })).toMatchObject({ ok: true, plan: { ratePercent: 60 } });
  });

  it("prices its members at its own share of the public price; others pay member rates", async () => {
    const goldMember = phone();
    const plainMember = phone();
    const m = await member(goldMember, gold);
    expect(m).toMatchObject({ tierName: "Gold", ratePercent: 60, aheadDays: 30 });
    await member(plainMember);
    const a = await createBooking({ courtId, date, hours: [9], name: "Gold", phone: goldMember });
    const b = await createBooking({ courtId, date, hours: [10], name: "Plain", phone: plainMember });
    const c = await createBooking({ courtId, date, hours: [11], name: "Guest", phone: phone() });
    expect([a.ok && a.booking.totalPrice, b.ok && b.booking.totalPrice, c.ok && c.booking.totalPrice]).toEqual([12, 15, 20]);
    // The grid shows a tier member their own price.
    const grid = await getAvailability(venueId, date, undefined, 60);
    expect(grid[0].slots.find((s) => s.hour === 12)!.rate).toBe(12);
  });

  it("lets its members book further ahead than anybody else", async () => {
    const goldMember = phone();
    const plainMember = phone();
    await member(goldMember, gold);
    await member(plainMember);
    expect(await venueAheadDays(venueId)).toBe(30);
    const far = addDays(todayISO(), 25);
    expect(await houseRuleRefusal({ venueId, phone: goldMember, dates: [far] })).toBeNull();
    expect(await houseRuleRefusal({ venueId, phone: plainMember, dates: [far] })).toMatchObject({ code: "LIMIT_AHEAD", vars: { n: 14 } });
    expect(await houseRuleRefusal({ venueId, phone: phone(), dates: [far] })).toMatchObject({ code: "LIMIT_AHEAD_MEMBERS" });
    expect(await houseRuleRefusal({ venueId, phone: goldMember, dates: [addDays(todayISO(), 31)] })).toMatchObject({ code: "LIMIT_AHEAD" });
    // Signed out, nobody is a member: everybody's window.
    expect(await aheadFor(venueId, null)).toBe(14);
  });
});
