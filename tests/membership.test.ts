import { describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import {
  activeMembership,
  computePrice,
  createBooking,
  getCourt,
  hasMemberRate,
  listMembershipsFor,
  listMembershipsForVenue,
  listVenues,
  sellMembership,
  updateCourt,
  voidMembership,
  extendMembership,
} from "../src/lib/store";
import { registerUser } from "../src/lib/auth";
import { authenticateAdmin, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { addDays, isPeak, todayISO } from "../src/lib/time";

const PHONE = "0123456789";
await ensureBootstrapAdmin();
const ADMIN_ID = (await authenticateAdmin("admin@mysenam.my", "mysenam-admin"))!.id;

const venue = async () => (await listVenues())[0];
const future = (o = 3) => addDays(todayISO(), o);

/** Peak covers the whole weekend, so find a real weekday to test off-peak on. */
function nextWeekday(from = 3): string {
  for (let o = from; o < from + 7; o++) {
    const d = future(o);
    if (!isPeak(d, 10)) return d;
  }
  throw new Error("no weekday in range");
}

async function sell(over: Partial<Parameters<typeof sellMembership>[0]> = {}) {
  const r = await sellMembership({
    venueId: (await venue()).id,
    holderName: "Aisyah Rahman",
    holderPhone: PHONE,
    startsOn: todayISO(),
    expiresOn: addDays(todayISO(), 365),
    price: 300,
    adminId: ADMIN_ID,
    ...over,
  });
  if (!r.ok) throw new Error(r.error);
  return r.membership;
}

describe("selling a membership", () => {
  it("records it live and findable by phone", async () => {
    const m = await sell();
    expect(m.code).toMatch(/^MB-[A-Z2-9]{6}$/);
    expect(m).toMatchObject({ status: "active", price: 300 });
    expect(m.unusableReason).toBeUndefined();
    expect((await activeMembership((await venue()).id, PHONE))?.id).toBe(m.id);
    // Held against the number, so the international form works too.
    expect((await activeMembership((await venue()).id, "+60 12-345 6789"))?.id).toBe(m.id);
  });

  it("refuses nonsense and overlapping terms", async () => {
    const base = {
      venueId: (await venue()).id, holderName: "Tan Wei Ming", holderPhone: "0127778888",
      startsOn: todayISO(), expiresOn: addDays(todayISO(), 30), price: 100, adminId: ADMIN_ID,
    };
    expect(await sellMembership({ ...base, venueId: 9999 })).toMatchObject({ ok: false, error: "Venue not found." });
    expect(await sellMembership({ ...base, holderName: "A" })).toMatchObject({ ok: false });
    expect(await sellMembership({ ...base, holderPhone: "123" })).toMatchObject({ ok: false });
    expect(await sellMembership({ ...base, price: -1 })).toMatchObject({ ok: false });
    expect(await sellMembership({ ...base, expiresOn: "nonsense" })).toMatchObject({ ok: false });
    expect(await sellMembership({ ...base, expiresOn: addDays(todayISO(), -1) })).toMatchObject({ ok: false });
    expect(await sellMembership({ ...base, startsOn: addDays(todayISO(), 10), expiresOn: addDays(todayISO(), 5) }))
      .toMatchObject({ ok: false, error: "The end date is before the start date." });
    expect(await sellMembership({ ...base, expiresOn: addDays(todayISO(), 365 * 5) })).toMatchObject({ ok: false });

    expect(await sellMembership(base)).toMatchObject({ ok: true });
    // A second overlapping term would make "which rate?" ambiguous.
    expect(await sellMembership({ ...base, startsOn: addDays(todayISO(), 10) }))
      .toMatchObject({ ok: false, error: expect.stringContaining("already has a membership here") });
    // Consecutive terms are fine.
    expect(await sellMembership({
      ...base, startsOn: addDays(todayISO(), 31), expiresOn: addDays(todayISO(), 60),
    })).toMatchObject({ ok: true });
  });

  it("is dead before it starts, after it ends, and once cancelled", async () => {
    const later = await sell({ holderPhone: "0191110000", startsOn: addDays(todayISO(), 5), expiresOn: addDays(todayISO(), 40) });
    expect(later.unusableReason).toBe(`This membership starts on ${later.startsOn}.`);
    expect(await activeMembership((await venue()).id, "0191110000")).toBeNull();
    // ...but it is live for a booking inside its term.
    expect((await activeMembership((await venue()).id, "0191110000", addDays(todayISO(), 10)))?.id).toBe(later.id);

    const cancelled = await sell({ holderPhone: "0192220000" });
    expect(await voidMembership(cancelled.id)).toMatchObject({ ok: true, membership: { status: "void" } });
    expect(await voidMembership(cancelled.id)).toMatchObject({ ok: false });
    expect(await activeMembership((await venue()).id, "0192220000")).toBeNull();

    const lapsed = await sell({ holderPhone: "0193330000" });
    await getDb().prepare("UPDATE memberships SET expires_on = ? WHERE id = ?")
      .run(addDays(todayISO(), -1), lapsed.id);
    expect(await activeMembership((await venue()).id, "0193330000")).toBeNull();
  });

  it("can be given days back, while it is still running", async () => {
    const m = await sell({ holderPhone: "0193330000" });
    expect(await extendMembership(m.id, 0)).toMatchObject({ ok: false });
    expect(await extendMembership(m.id, 91)).toMatchObject({ ok: false });
    expect(await extendMembership(m.id, 14)).toMatchObject({ ok: true, membership: { expiresOn: addDays(m.expiresOn, 14) } });
    await voidMembership(m.id);
    expect(await extendMembership(m.id, 7)).toMatchObject({ ok: false });
  });

  it("is per venue", async () => {
    await sell({ holderPhone: "0194440000" });
    expect(await activeMembership((await venue()).id, "0194440000")).not.toBeNull();
    expect(await activeMembership((await listVenues())[1].id, "0194440000")).toBeNull();
  });
});

describe("member rates", () => {
  it("only applies where the court sets one", async () => {
    const weekday = nextWeekday();
    const court = (await venue()).courts.find((c) => c.sport === "badminton")!;
    expect(hasMemberRate(court)).toBe(false);
    // With no member rate, a member pays the public price.
    expect(computePrice(court, weekday, [10, 10.5], true)).toBe(computePrice(court, weekday, [10, 10.5], false));

    expect(await updateCourt(court.id, { memberOffPeakRate: 10 })).toMatchObject({ ok: true });
    const rated = (await getCourt(court.id))!;
    expect(hasMemberRate(rated)).toBe(true);
    expect(computePrice(rated, weekday, [10, 10.5], true)).toBe(10);
    expect(computePrice(rated, weekday, [10, 10.5], false)).toBe(rated.offPeakRate);

    // Peak is untouched until its own member rate is set.
    expect(computePrice(rated, weekday, [19, 19.5], true)).toBe(rated.peakRate);
    await updateCourt(court.id, { memberPeakRate: 18 });
    expect(computePrice((await getCourt(court.id))!, weekday, [19, 19.5], true)).toBe(18);

    // Clearing it puts members back on the public rate.
    await updateCourt(court.id, { memberOffPeakRate: null, memberPeakRate: null });
    expect(hasMemberRate((await getCourt(court.id))!)).toBe(false);
  });

  it("refuses a member rate above the public one", async () => {
    const court = (await venue()).courts.find((c) => c.sport === "badminton")!;
    expect(await updateCourt(court.id, { memberOffPeakRate: court.offPeakRate + 1 }))
      .toMatchObject({ ok: false, error: "The off-peak member rate is higher than the public one." });
    expect(await updateCourt(court.id, { memberPeakRate: court.peakRate + 1 }))
      .toMatchObject({ ok: false, error: "The peak member rate is higher than the public one." });
    expect(await updateCourt(court.id, { memberOffPeakRate: -1 })).toMatchObject({ ok: false });
  });

  it("charges a member the member rate when they book", async () => {
    const weekday = nextWeekday(5);
    expect(isPeak(weekday, 10)).toBe(false);
    const court = (await venue()).courts.filter((c) => c.sport === "badminton")[1];
    await updateCourt(court.id, { memberOffPeakRate: 9 });
    await sell({ holderPhone: "0195550000", holderName: "Member Mei" });

    const asMember = await createBooking({
      courtId: court.id, date: weekday, hours: [10, 11], name: "Member Mei", phone: "0195550000",
    });
    expect(asMember).toMatchObject({ ok: true });
    if (asMember.ok) expect(asMember.booking.totalPrice).toBe(18); // 9 + 9

    const asGuest = await createBooking({
      courtId: court.id, date: weekday, hours: [12, 13], name: "Guest", phone: "0198887777",
    });
    expect(asGuest).toMatchObject({ ok: true });
    if (asGuest.ok) expect(asGuest.booking.totalPrice).toBe((await getCourt(court.id))!.offPeakRate * 2);

    await updateCourt(court.id, { memberOffPeakRate: null });
  });

  it("prices each week of a series against that week's membership", async () => {
    const court = (await venue()).courts.filter((c) => c.sport === "badminton")[2];
    await updateCourt(court.id, { memberOffPeakRate: 5, memberPeakRate: 5 });
    const phone = "0196660000";
    // A term that covers the first two weeks only.
    // A term ending inside the 14-day booking window, so both sessions below
    // are bookable but only the first is covered.
    const m = await sell({ holderPhone: phone, holderName: "Short Term", expiresOn: addDays(todayISO(), 6) });
    expect(m.expiresOn).toBe(addDays(todayISO(), 6));

    // Inside the term: the flat member rate, whether the hour is peak or not.
    const covered = future(4);
    const r = await createBooking({
      courtId: court.id, date: covered, hours: [14], name: "Short Term", phone,
    });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.booking.totalPrice).toBe(5);

    // Past the expiry: the public rate for that date, peak or off-peak.
    const lapsedDate = addDays(todayISO(), 10);
    const after = await createBooking({
      courtId: court.id, date: lapsedDate, hours: [14], name: "Short Term", phone,
    });
    expect(after).toMatchObject({ ok: true });
    if (after.ok)
      expect(after.booking.totalPrice).toBe(computePrice((await getCourt(court.id))!, lapsedDate, [14, 14.5], false));

    await updateCourt(court.id, { memberOffPeakRate: null, memberPeakRate: null });
  });

  it("lists an account's memberships and a venue's own", async () => {
    const phone = "0197770000";
    const holder = await registerUser({
      name: "Lister",
      email: "lister@example.com",
      phone,
      password: "a-password",
    });
    if (!holder.ok) throw new Error(holder.error);
    const m = await sell({ holderPhone: phone, holderName: "Lister", userId: holder.user.id });

    expect((await listMembershipsFor(holder.user.id)).map((x) => x.id)).toContain(m.id);
    // A membership sold to somebody else is not this account's, whatever
    // number it was sold against.
    const theirs = await sell({ holderPhone: "0197779999", holderName: "Somebody Else" });
    expect((await listMembershipsFor(holder.user.id)).map((x) => x.id)).not.toContain(theirs.id);
    const venueList = await listMembershipsForVenue((await venue()).id);
    const here = (await venue()).id;
    expect(venueList.every((x) => x.venueId === here)).toBe(true);
    expect(venueList[0].id).toBeGreaterThanOrEqual(m.id);
  });
});
