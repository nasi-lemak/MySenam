import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { getDb } from "../src/lib/db";
import { houseRuleRefusal, venueAheadDays } from "../src/lib/house-rules";
import { aboveMemberRate, benefitsOf, createPlan, planById, setPlanBenefits } from "../src/lib/membership-plans";
import { suspendMembership } from "../src/lib/membership-suspensions";
import { NO_PRICING_RULES, priceBooking } from "../src/lib/pricing";
import { createBooking, createCourt, createVenue, listMembershipsForVenue, membershipById, sellMembership, updateCourt } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * A membership keeps the benefits it was sold with (MEMB D6 / DEC-34, ADR 0071): editing a tier changes terms sold after, a
 * renewal takes the tier as it is then, an upgrade starts on its own date, staff see which benefits a term has, a row from before
 * the snapshot reads its tier as it is. And a tier is never silently priced above the member rate (D19): the editor asks for
 * confirmation, and no member pays more than a non-member for the same slot.
 */

let venueId: number;
let courtId: number;
let n = 0;
const phone = () => `0123330${String(++n).padStart(3, "0")}`;
const today = () => todayISO();
// Every hour at 20 (member rate 15): time of day and weekday decide nothing.
const date = () => addDays(today(), 1);
// One court-hour for every booking made on a date.
const used = new Map<string, number>();
const nextHour = (on: string) => {
  const h = 8 + (used.get(on) ?? 0);
  used.set(on, (used.get(on) ?? 0) + 1);
  return h;
};

const sell = async (who: string, opts: { tierId?: number; planId?: number; startsOn?: string; expiresOn?: string } = {}) => {
  const sold = await sellMembership({
    venueId,
    holderName: "Member",
    holderPhone: who,
    startsOn: opts.startsOn ?? today(),
    expiresOn: opts.expiresOn ?? addDays(today(), 60),
    price: 100,
    ...(opts.tierId ? { tierId: opts.tierId } : {}),
    ...(opts.planId ? { planId: opts.planId } : {}),
  });
  if (!sold.ok) throw new Error(sold.error);
  return sold.membership;
};

const priceFor = async (who: string, on = date()) => {
  const b = await createBooking({ courtId, date: on, hours: [nextHour(on)], name: "Booker", phone: who });
  if (!b.ok) throw new Error(b.error);
  return b.booking.totalPrice;
};

const plan = async (name: string, input: Record<string, unknown>) => {
  const made = await createPlan(venueId, { name, months: 12, price: 500, ...input });
  if (!made.ok) throw new Error(made.error);
  return made.plan;
};

beforeAll(async () => {
  const v = await createVenue({ name: "Kelab Tier", area: "Ampang", address: "x", phone: "0344441111" });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  const c = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!c.ok) throw new Error("court");
  courtId = c.court.id;
  await updateCourt(courtId, { memberOffPeakRate: 15, memberPeakRate: 15 });
});

describe("editing a tier mid-term (D6)", () => {
  let gold: number;
  const holder = phone();

  it("a term sold keeps its price level and window; terms sold after, and renewals, take the edit", async () => {
    gold = (await plan("Gold", { ratePercent: 70, aheadDays: 30 })).id;
    expect((await planById(gold))!.version).toBe(1);
    const m = await sell(holder, { tierId: gold });
    expect(m).toMatchObject({ ratePercent: 70, aheadDays: 30, benefits: { source: "sold", version: 1, tierVersion: 1, ratePercent: 70 } });
    expect(await priceFor(holder)).toBe(14);

    // Worse for the member on both counts: a dearer price level, a shorter window. 95% of 20 is above the member rate of 15:
    // asked to be confirmed (D19) and nothing saved until it is.
    const asked = await setPlanBenefits(venueId, gold, { ratePercent: 95, aheadDays: 7 });
    expect(asked).toMatchObject({ ok: false, needsConfirm: "above-member-rate" });
    expect((await planById(gold))!).toMatchObject({ ratePercent: 70, aheadDays: 30, version: 1 });
    const edited = await setPlanBenefits(venueId, gold, { ratePercent: 95, aheadDays: 7, confirmAboveMemberRate: true });
    expect(edited).toMatchObject({ ok: true, plan: { ratePercent: 95, aheadDays: 7, version: 2 } });

    // The term already paid for: the same price and the same window.
    expect(await membershipById(m.id)).toMatchObject({ ratePercent: 70, aheadDays: 30, benefits: { source: "sold", version: 1, tierVersion: 2 } });
    expect(await priceFor(holder)).toBe(14);
    const far = addDays(today(), 25);
    expect(await houseRuleRefusal({ venueId, phone: holder, dates: [far] })).toBeNull();
    // The venue's outer window still reaches as far as that running term does, though the plan now says 7.
    expect(await venueAheadDays(venueId)).toBe(30);

    // A purchase after the edit sees the updated tier.
    const fresh = phone();
    const newer = await sell(fresh, { tierId: gold });
    expect(newer).toMatchObject({ ratePercent: 95, aheadDays: 7, benefits: { source: "sold", version: 2, tierVersion: 2 } });
    expect(await priceFor(fresh)).toBe(19);
    expect(await houseRuleRefusal({ venueId, phone: fresh, dates: [far] })).not.toBeNull();
  });

  it("a renewal, sold when its charge comes in, takes the tier as it is then; the running term runs out as sold", async () => {
    const who = phone();
    const first = await sell(who, { planId: gold, startsOn: addDays(today(), -30), expiresOn: addDays(today(), 3) });
    // Sold now (the plan as edited): a term bought online is its plan's.
    expect(first.benefits).toMatchObject({ version: 2, ratePercent: 95 });
    // Edited again before the renewal; this one comes in at 80% (16, above the member rate: confirmed).
    expect(await setPlanBenefits(venueId, gold, { ratePercent: 80, aheadDays: 7, confirmAboveMemberRate: true })).toMatchObject({ ok: true, plan: { version: 3 } });
    const renewal = await sell(who, { planId: gold, startsOn: addDays(today(), 4), expiresOn: addDays(today(), 400 - 36) });
    expect(renewal.benefits).toMatchObject({ source: "sold", version: 3, ratePercent: 80 });
    // Each term as sold, on its own dates: 95% (19) in the first, 80% (16) from the day the renewal starts.
    expect(await priceFor(who, addDays(today(), 2))).toBe(19);
    expect(await priceFor(who, addDays(today(), 5))).toBe(16);
  });

  it("an upgrade or a downgrade is a new term from an explicit date; the term before is not changed", async () => {
    const silver = (await plan("Silver", { ratePercent: 80, aheadDays: 14, confirmAboveMemberRate: true })).id;
    const platinum = (await plan("Platinum", { ratePercent: 50, aheadDays: 30 })).id;
    const who = phone();
    const first = await sell(who, { tierId: silver, expiresOn: addDays(today(), 3) });
    const upgrade = await sell(who, { tierId: platinum, startsOn: addDays(today(), 4), expiresOn: addDays(today(), 60) });
    expect([first.startsOn, first.expiresOn, upgrade.startsOn]).toEqual([today(), addDays(today(), 3), addDays(today(), 4)]);
    expect(await priceFor(who, addDays(today(), 3))).toBe(16);
    expect(await priceFor(who, addDays(today(), 4))).toBe(10);
  });

  it("staff see the benefits each term has, and that the plan has been edited since", async () => {
    const rows = await listMembershipsForVenue(venueId, 200);
    const old = rows.find((r) => r.holderPhone === holder)!;
    expect(old.benefits).toMatchObject({ source: "sold", version: 1, ratePercent: 70, aheadDays: 30 });
    expect(old.benefits!.tierVersion).toBeGreaterThan(old.benefits!.version!);
  });

  it("the same edit made twice, or made at once with sales, never gives a term a mixture of two versions", async () => {
    const mid = (await plan("Mid", { ratePercent: 70, aheadDays: 21 })).id;
    // Saving what it already is does not make a new version.
    expect(await setPlanBenefits(venueId, mid, { ratePercent: 70, aheadDays: 21 })).toMatchObject({ ok: true, plan: { version: 1 } });
    expect(await setPlanBenefits(venueId, mid, { ratePercent: 70, aheadDays: 21, offeredFor: "account" })).toMatchObject({ ok: true, plan: { version: 1 } });
    const phones = Array.from({ length: 8 }, () => phone());
    const results = await Promise.all([
      ...phones.slice(0, 4).map((p) => sell(p, { planId: mid })),
      setPlanBenefits(venueId, mid, { ratePercent: 75, aheadDays: 28 }),
      ...phones.slice(4).map((p) => sell(p, { planId: mid })),
      setPlanBenefits(venueId, mid, { ratePercent: 75, aheadDays: 28 }),
    ]);
    const sold = results.filter((r): r is Awaited<ReturnType<typeof sell>> => "benefits" in r);
    expect(sold).toHaveLength(8);
    // Whole old terms (70%, 21 days, v1) or whole new ones (75%, 28 days, v2), and the two identical edits made one version.
    for (const m of sold) {
      const b = m.benefits!;
      expect([b.ratePercent, b.aheadDays, b.version]).toSatisfy((x: unknown[]) => (x[0] === 70 && x[1] === 21 && x[2] === 1) || (x[0] === 75 && x[1] === 28 && x[2] === 2));
    }
    expect((await planById(mid))!.version).toBe(2);
  });

  it("a plan edited so that it admits, or stops extending a suspension, does not change a term already sold", async () => {
    const flexi = (await plan("Flexi", { extendOnSuspension: true })).id;
    const who = phone();
    const m = await sell(who, { planId: flexi });
    expect(m.benefits).toMatchObject({ extendOnSuspension: true });
    expect(await setPlanBenefits(venueId, flexi, { ratePercent: null, aheadDays: null, extendOnSuspension: false })).toMatchObject({ ok: true, plan: { version: 2 } });
    // Its plan no longer extends; this term, sold when it did, still does.
    const from = addDays(today(), 1);
    const done = await suspendMembership({ id: null, name: "Manager" }, m.id, { from, until: addDays(today(), 5), reason: "Injury" });
    expect(done).toMatchObject({ ok: true, extension: { moved: 5 } });
    expect((await membershipById(m.id))!.expiresOn).toBe(addDays(today(), 65));
    // A term sold after the edit does not.
    const later = await sell(phone(), { planId: flexi });
    const none = await suspendMembership({ id: null, name: "Manager" }, later.id, { from, until: addDays(today(), 5), reason: "Injury" });
    expect(none).toMatchObject({ ok: true, extension: { moved: 0 } });
  });

  it("a row with no snapshot (written by something that does not know the column) is read from its tier as it is", async () => {
    const live = (await plan("Live", { ratePercent: 60, aheadDays: 20 })).id;
    const who = phone();
    const m = await sell(who, { tierId: live });
    await getDb().prepare("UPDATE memberships SET benefits = NULL, benefits_version = NULL, benefits_source = NULL WHERE id = ?").run(m.id);
    expect(await membershipById(m.id)).toMatchObject({ ratePercent: 60, aheadDays: 20, benefits: { source: "live" } });
    expect(await setPlanBenefits(venueId, live, { ratePercent: 65, aheadDays: 20 })).toMatchObject({ ok: true });
    expect(await membershipById(m.id)).toMatchObject({ ratePercent: 65 });
  });

  it("a membership on no plan carries the plain benefits", async () => {
    const m = await sell(phone());
    expect(m.benefits).toMatchObject({ source: "sold", ratePercent: null, aheadDays: null, scope: "booking", admitsEntry: false, version: null });
    expect(benefitsOf((await planById(gold))!)).toMatchObject({ ratePercent: 80, aheadDays: 7, scope: "booking" });
  });
});

describe("a tier above the member rate (D19)", () => {
  beforeAll(async () => {
    const v = await createVenue({ name: "Kelab Dear", area: "Ampang", address: "x", phone: "0344442222" });
    if (!v.ok) throw new Error("venue");
    venueId = v.venue.id;
    const c = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
    if (!c.ok) throw new Error("court");
    await updateCourt(c.court.id, { memberOffPeakRate: 15, memberPeakRate: 15 });
  });

  it("is asked to be confirmed when it is made or changed, and not when it is at or below the member rate or no share", async () => {
    // 80% of 20 is 16, above the member rate of 15.
    const asked = await createPlan(venueId, { name: "Dear", months: 12, price: 300, ratePercent: 80 });
    expect(asked).toMatchObject({ ok: false, needsConfirm: "above-member-rate" });
    expect(!asked.ok && asked.error).toContain("RM16 an hour");
    expect(!asked.ok && asked.error).toContain("member rate of RM15");
    const sentences = await getDb().prepare("SELECT name FROM membership_plans WHERE venue_id = ? AND name = 'Dear'").all(venueId);
    expect(sentences).toEqual([]);
    expect(await createPlan(venueId, { name: "Dear", months: 12, price: 300, ratePercent: 80, confirmAboveMemberRate: true })).toMatchObject({ ok: true });
    // At the member rate (75% of 20 is 15), below it, or with no share of its own: nothing to ask.
    expect(await createPlan(venueId, { name: "Even", months: 12, price: 300, ratePercent: 75 })).toMatchObject({ ok: true });
    expect(await createPlan(venueId, { name: "Cheap", months: 12, price: 300, ratePercent: 50 })).toMatchObject({ ok: true });
    expect(await aboveMemberRate(venueId, null)).toBeNull();
    expect(await aboveMemberRate(venueId, 75)).toBeNull();
    expect(await aboveMemberRate(venueId, 76)).toMatchObject({ court: "Court 1", tier: 15.2, member: 15 });
  });

  it("a plan already so is not asked again when something else about it changes", async () => {
    const dear = (await getDb().prepare("SELECT id FROM membership_plans WHERE venue_id = ? AND name = 'Dear'").get(venueId)) as { id: number };
    expect(await setPlanBenefits(venueId, dear.id, { ratePercent: 80, aheadDays: 21 })).toMatchObject({ ok: true });
  });

  it("no member pays more than a non-member for the same slot, whatever a rate or a share says", () => {
    const court = { sport: "badminton" as const, offPeakRate: 20, peakRate: 20, memberOffPeakRate: 25, memberPeakRate: 25, perPlayer: false };
    const at = (m: number) => ({ start: m * 60, end: m * 60 + 60 });
    const price = (member: boolean | number) =>
      priceBooking({ court, date: addDays(today(), 3), span: at(9), member, pricing: NO_PRICING_RULES }).total;
    // A member rate above the public rate (a dated change that slipped past), a share over 100%: held to the public price.
    expect(price(false)).toBe(20);
    expect(price(true)).toBe(20);
    expect(price(150)).toBe(20);
    // And a share below it is the share.
    expect(price(70)).toBe(14);
    // A fixed price for a length is held the same way.
    const fixed = { ...NO_PRICING_RULES, fixedPrices: [{ minutes: 60, price: 30, peakPrice: null }] };
    expect(priceBooking({ court, date: addDays(today(), 3), span: at(9), member: 150, pricing: fixed }).total).toBe(30);
  });
});
