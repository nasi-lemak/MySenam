import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { getDb } from "../src/lib/db";
import { createPlan } from "../src/lib/membership-plans";
import { reactivateMembership, suspendMembership, suspensionHistory } from "../src/lib/membership-suspensions";
import { activeMembership, createVenue, extendMembership, membershipById, sellMembership } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Audit 9 D7 and D12 (ADR 0062): giving days back never runs a membership into its own renewal; an open-ended suspension of a membership
 * that renews by itself, which the gateway keeps charging, gives the days back when it is lifted, whatever its plan says.
 */

const ZONE = "Asia/Kuala_Lumpur";
// Fixed at load, so a test that moves the clock still reads the same days.
const base = todayISO(ZONE);
const day = (k: number) => addDays(base, k);
const mgr = { id: null, name: "Test manager" };
let venueId: number;
let n = 0;
const phone = () => `0125${String(++n).padStart(6, "0")}`;

beforeAll(async () => {
  const made = await createVenue({ name: "Renewal Courts", area: "PJ", address: "x", phone: "0355550000" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
});

afterEach(() => {
  vi.useRealTimers();
});

async function term(ph: string, from: number, until: number, planId?: number) {
  const made = await sellMembership({ venueId, holderName: "Aina", holderPhone: ph, startsOn: day(from), expiresOn: day(until), price: 100, ...(planId ? { planId } : {}) });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.membership;
}
let sub = 0;
/** A subscription renewing this membership: the gateway charges again each term, and says which term its latest charge made. */
async function renewing(membershipId: number) {
  await getDb()
    .prepare("INSERT INTO membership_subscriptions (venue_id, provider, subscription_id, membership_id) VALUES (?, 'stripe', ?, ?)")
    .run(venueId, `sub_fx8_${++sub}`, membershipId);
}
/** The gateway's next charge made `membershipId`: the subscription now stands on it. */
const renewedAs = (from: number, to: number) => getDb().prepare("UPDATE membership_subscriptions SET membership_id = ? WHERE membership_id = ?").run(to, from);
const liftedOn = (k: number) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${day(k)}T10:00:00+08:00`));
};
const overlapping = async (ph: string) =>
  ((await getDb()
    .prepare(
      "SELECT COUNT(*)::int AS n FROM memberships a JOIN memberships b ON a.id < b.id AND phone_key(a.holder_phone) = phone_key(b.holder_phone) AND a.venue_id = b.venue_id AND a.status = 'active' AND b.status = 'active' AND a.starts_on <= b.expires_on AND b.starts_on <= a.expires_on WHERE phone_key(a.holder_phone) = phone_key(?)"
    )
    .get(ph)) as { n: number }).n;

describe("D7: giving days back on a membership whose renewal has already been sold", () => {
  it("is refused when the days would run into the next term, saying how many fit; the term is left as it was", async () => {
    const ph = phone();
    const first = await term(ph, -10, 20);
    await term(ph, 31, 90);
    // 10 days run to day 30: fits (the next term starts on day 31).
    const refused = await extendMembership(first.id, 11);
    expect(refused).toMatchObject({ ok: false, code: "FX8_EXTEND_INTO_NEXT", vars: { date: day(31), max: 10 } });
    expect((await membershipById(first.id))!.expiresOn).toBe(day(20));
    expect(await extendMembership(first.id, 10)).toMatchObject({ ok: true, membership: { expiresOn: day(30) } });
    expect(await overlapping(ph)).toBe(0);
    // Nothing more fits now.
    expect(await extendMembership(first.id, 1)).toMatchObject({ ok: false, code: "FX8_EXTEND_NEXT_FOLLOWS" });
    expect(await activeMembership(venueId, ph, day(25))).toMatchObject({ id: first.id });
    expect(await activeMembership(venueId, ph, day(40))).not.toBeNull();
  });

  it("the renewal starting the day after it ends leaves no day to give back; with no next term the days are given as before", async () => {
    const ph = phone();
    const first = await term(ph, -10, 20);
    await term(ph, 21, 80);
    expect(await extendMembership(first.id, 5)).toMatchObject({ ok: false, code: "FX8_EXTEND_NEXT_FOLLOWS", vars: { max: 0 } });
    const alone = await term(phone(), -10, 20);
    expect(await extendMembership(alone.id, 14)).toMatchObject({ ok: true, membership: { expiresOn: day(34) } });
  });

  it("a void next term is not in the way", async () => {
    const ph = phone();
    const first = await term(ph, -10, 20);
    const next = await term(ph, 21, 80);
    await getDb().prepare("UPDATE memberships SET status = 'void' WHERE id = ?").run(next.id);
    expect(await extendMembership(first.id, 14)).toMatchObject({ ok: true });
  });
});

describe("D12: an open-ended suspension of a membership that renews by itself", () => {
  it("extends the end by the days it took when it is lifted, whatever the plan says; nothing moves while it is open", async () => {
    const ph = phone();
    const m = await term(ph, -10, 20);
    await renewing(m.id);
    expect(await suspendMembership(mgr, m.id, { from: day(5), reason: "Committee decision" })).toMatchObject({ ok: true, expiresOn: day(20) });
    expect((await suspensionHistory(m.id))[0]).toMatchObject({ extendedDays: 0, until: null });
    liftedOn(12);
    // Suspended from day 5 to day 11: seven days, given back.
    expect(await reactivateMembership(mgr, m.id, { reason: "Back" })).toMatchObject({ ok: true, expiresOn: day(27), extension: { moved: 7 } });
    vi.useRealTimers();
    expect((await suspensionHistory(m.id))[0].extendedDays).toBe(7);
    expect((await membershipById(m.id))!.expiresOn).toBe(day(27));
  });

  it("a membership that does not renew by itself keeps the rule it had: the end stays unless the plan says so", async () => {
    const ph = phone();
    const m = await term(ph, -10, 20);
    expect((await suspendMembership(mgr, m.id, { from: day(5), reason: "Committee decision" })).ok).toBe(true);
    liftedOn(12);
    expect(await reactivateMembership(mgr, m.id, { reason: "Back" })).toMatchObject({ ok: true, expiresOn: day(20), extension: { moved: 0 } });
  });

  it("a dated suspension of a renewing membership still follows its plan (not extended where the plan does not say so)", async () => {
    const ph = phone();
    const m = await term(ph, -10, 20);
    await renewing(m.id);
    expect(await suspendMembership(mgr, m.id, { from: day(5), until: day(9), reason: "Injury" })).toMatchObject({ ok: true, expiresOn: day(20), extension: { moved: 0 } });
  });

  it("a renewal charged while it is open carries it on; lifting it gives back every term's days, on the last term", async () => {
    const ph = phone();
    const first = await term(ph, -10, 20);
    await renewing(first.id);
    expect((await suspendMembership(mgr, first.id, { from: day(15), reason: "Committee decision" })).ok).toBe(true);
    // The gateway charges again on day 21: the next term is made and the subscription stands on it.
    const second = await term(ph, 21, 80);
    await renewedAs(first.id, second.id);
    expect(second.suspensions).toEqual([expect.objectContaining({ from: day(21), until: null, endsOn: null })]);
    liftedOn(40);
    // Suspended from day 15 to day 39: six days of the first term (15..20) and nineteen of the second (21..39).
    expect(await reactivateMembership(mgr, second.id, { reason: "Lifted" })).toMatchObject({ ok: true, expiresOn: day(105), extension: { moved: 25 } });
    vi.useRealTimers();
    expect((await membershipById(first.id))!.expiresOn).toBe(day(20));
    expect((await membershipById(second.id))!.expiresOn).toBe(day(105));
    expect((await suspensionHistory(first.id))[0].extensionNote).toMatch(/^Carried to MB-/);
    expect((await suspensionHistory(second.id))[0].extendedDays).toBe(25);
    expect(await overlapping(ph)).toBe(0);
    // Lifting again changes nothing, and it is never added twice.
    expect(await reactivateMembership(mgr, second.id, { reason: "Again" })).toMatchObject({ ok: false, code: "MS7_NOT_SUSPENDED" });
    expect((await membershipById(second.id))!.expiresOn).toBe(day(105));
  });

  it("three terms charged while open: the days of all of them land on the last", async () => {
    const ph = phone();
    const first = await term(ph, -10, 20);
    await renewing(first.id);
    expect((await suspendMembership(mgr, first.id, { from: day(15), reason: "Committee decision" })).ok).toBe(true);
    const second = await term(ph, 21, 50);
    await renewedAs(first.id, second.id);
    const third = await term(ph, 51, 80);
    await renewedAs(second.id, third.id);
    liftedOn(60);
    // 15..20 = 6, 21..50 = 30, 51..59 = 9: 45 days on the last term.
    expect(await reactivateMembership(mgr, third.id, { reason: "Lifted" })).toMatchObject({ ok: true, expiresOn: day(125), extension: { moved: 45 } });
    vi.useRealTimers();
    expect((await membershipById(first.id))!.expiresOn).toBe(day(20));
    expect((await membershipById(second.id))!.expiresOn).toBe(day(50));
    expect(await overlapping(ph)).toBe(0);
  });

  it("lifting from the first term's screen lifts the chain the same way", async () => {
    const ph = phone();
    const first = await term(ph, -10, 20);
    await renewing(first.id);
    expect((await suspendMembership(mgr, first.id, { from: day(15), reason: "Committee decision" })).ok).toBe(true);
    const second = await term(ph, 21, 80);
    await renewedAs(first.id, second.id);
    liftedOn(30);
    expect((await reactivateMembership(mgr, first.id, { reason: "Lifted" })).ok).toBe(true);
    vi.useRealTimers();
    // 15..20 = 6 and 21..29 = 9.
    expect((await membershipById(second.id))!.expiresOn).toBe(day(95));
  });
});

describe("D12 race: a renewal while it is being lifted", () => {
  it("never two live terms for the same days, and never a renewal left suspended after the suspension was lifted", async () => {
    const ph = phone();
    const first = await term(ph, -10, 20);
    await renewing(first.id);
    expect((await suspendMembership(mgr, first.id, { from: day(15), reason: "Committee decision" })).ok).toBe(true);
    liftedOn(30);
    // The lift and the renewal's making arrive together: whichever the database orders first, the other sees it.
    const [lifted, sold] = await Promise.all([
      reactivateMembership(mgr, first.id, { reason: "Lifted" }),
      sellMembership({ venueId, holderName: "Aina", holderPhone: ph, startsOn: day(21), expiresOn: day(80), price: 100 }),
    ]);
    vi.useRealTimers();
    expect(lifted.ok).toBe(true);
    expect(await overlapping(ph)).toBe(0);
    if (sold.ok) {
      // The renewal was made first (the suspension carried to it and lifted with the chain), or the lift came first and the renewal
      // is a fresh term: either way it is not suspended.
      expect(await getDb().prepare("SELECT COUNT(*)::int AS n FROM membership_suspensions WHERE membership_id = ? AND lifted_at IS NULL").get(sold.membership.id)).toEqual({ n: 0 });
    }
  });
});

describe("a plan that extends on suspension still does", () => {
  it("and an open-ended one on a renewing membership on such a plan is not extended twice", async () => {
    const plan = await createPlan(venueId, { name: "Flexi", months: 12, price: 200, extendOnSuspension: true });
    if (!plan.ok) throw new Error(plan.error);
    const ph = phone();
    const m = await term(ph, -10, 20, plan.plan.id);
    await renewing(m.id);
    expect((await suspendMembership(mgr, m.id, { from: day(5), reason: "Travel" })).ok).toBe(true);
    liftedOn(12);
    expect(await reactivateMembership(mgr, m.id, { reason: "Back" })).toMatchObject({ ok: true, expiresOn: day(27), extension: { moved: 7 } });
  });
});
