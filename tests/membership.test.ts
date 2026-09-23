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
} from "../src/lib/store";
import { authenticateAdmin, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { addDays, isPeak, todayISO } from "../src/lib/time";

const PHONE = "0123456789";
ensureBootstrapAdmin();
const ADMIN_ID = authenticateAdmin("admin@mysenam.my", "mysenam-admin")!.id;

const venue = () => listVenues()[0];
const future = (o = 3) => addDays(todayISO(), o);

/** Peak covers the whole weekend, so find a real weekday to test off-peak on. */
function nextWeekday(from = 3): string {
  for (let o = from; o < from + 7; o++) {
    const d = future(o);
    if (!isPeak(d, 10)) return d;
  }
  throw new Error("no weekday in range");
}

function sell(over: Partial<Parameters<typeof sellMembership>[0]> = {}) {
  const r = sellMembership({
    venueId: venue().id,
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
  it("records it live and findable by phone", () => {
    const m = sell();
    expect(m.code).toMatch(/^MB-[A-Z2-9]{6}$/);
    expect(m).toMatchObject({ status: "active", price: 300 });
    expect(m.unusableReason).toBeUndefined();
    expect(activeMembership(venue().id, PHONE)?.id).toBe(m.id);
    // Held against the number, so the international form works too.
    expect(activeMembership(venue().id, "+60 12-345 6789")?.id).toBe(m.id);
  });

  it("refuses nonsense and overlapping terms", () => {
    const base = {
      venueId: venue().id, holderName: "Tan Wei Ming", holderPhone: "0127778888",
      startsOn: todayISO(), expiresOn: addDays(todayISO(), 30), price: 100, adminId: ADMIN_ID,
    };
    expect(sellMembership({ ...base, venueId: 9999 })).toMatchObject({ ok: false, error: "Venue not found." });
    expect(sellMembership({ ...base, holderName: "A" })).toMatchObject({ ok: false });
    expect(sellMembership({ ...base, holderPhone: "123" })).toMatchObject({ ok: false });
    expect(sellMembership({ ...base, price: -1 })).toMatchObject({ ok: false });
    expect(sellMembership({ ...base, expiresOn: "nonsense" })).toMatchObject({ ok: false });
    expect(sellMembership({ ...base, expiresOn: addDays(todayISO(), -1) })).toMatchObject({ ok: false });
    expect(sellMembership({ ...base, startsOn: addDays(todayISO(), 10), expiresOn: addDays(todayISO(), 5) }))
      .toMatchObject({ ok: false, error: "The end date is before the start date." });
    expect(sellMembership({ ...base, expiresOn: addDays(todayISO(), 365 * 5) })).toMatchObject({ ok: false });

    expect(sellMembership(base)).toMatchObject({ ok: true });
    // A second overlapping term would make "which rate?" ambiguous.
    expect(sellMembership({ ...base, startsOn: addDays(todayISO(), 10) }))
      .toMatchObject({ ok: false, error: expect.stringContaining("already has a membership here") });
    // Consecutive terms are fine.
    expect(sellMembership({
      ...base, startsOn: addDays(todayISO(), 31), expiresOn: addDays(todayISO(), 60),
    })).toMatchObject({ ok: true });
  });

  it("is dead before it starts, after it ends, and once cancelled", () => {
    const later = sell({ holderPhone: "0191110000", startsOn: addDays(todayISO(), 5), expiresOn: addDays(todayISO(), 40) });
    expect(later.unusableReason).toBe(`This membership starts on ${later.startsOn}.`);
    expect(activeMembership(venue().id, "0191110000")).toBeNull();
    // ...but it is live for a booking inside its term.
    expect(activeMembership(venue().id, "0191110000", addDays(todayISO(), 10))?.id).toBe(later.id);

    const cancelled = sell({ holderPhone: "0192220000" });
    expect(voidMembership(cancelled.id)).toMatchObject({ ok: true, membership: { status: "void" } });
    expect(voidMembership(cancelled.id)).toMatchObject({ ok: false });
    expect(activeMembership(venue().id, "0192220000")).toBeNull();

    const lapsed = sell({ holderPhone: "0193330000" });
    getDb().prepare("UPDATE memberships SET expires_on = ? WHERE id = ?")
      .run(addDays(todayISO(), -1), lapsed.id);
    expect(activeMembership(venue().id, "0193330000")).toBeNull();
  });

  it("is per venue", () => {
    sell({ holderPhone: "0194440000" });
    expect(activeMembership(venue().id, "0194440000")).not.toBeNull();
    expect(activeMembership(listVenues()[1].id, "0194440000")).toBeNull();
  });
});

describe("member rates", () => {
  it("only applies where the court sets one", () => {
    const weekday = nextWeekday();
    const court = venue().courts.find((c) => c.sport === "badminton")!;
    expect(hasMemberRate(court)).toBe(false);
    // With no member rate, a member pays the public price.
    expect(computePrice(court, weekday, [10], true)).toBe(computePrice(court, weekday, [10], false));

    expect(updateCourt(court.id, { memberOffPeakRate: 10 })).toMatchObject({ ok: true });
    const rated = getCourt(court.id)!;
    expect(hasMemberRate(rated)).toBe(true);
    expect(computePrice(rated, weekday, [10], true)).toBe(10);
    expect(computePrice(rated, weekday, [10], false)).toBe(rated.offPeakRate);

    // Peak is untouched until its own member rate is set.
    expect(computePrice(rated, weekday, [19], true)).toBe(rated.peakRate);
    updateCourt(court.id, { memberPeakRate: 18 });
    expect(computePrice(getCourt(court.id)!, weekday, [19], true)).toBe(18);

    // Clearing it puts members back on the public rate.
    updateCourt(court.id, { memberOffPeakRate: null, memberPeakRate: null });
    expect(hasMemberRate(getCourt(court.id)!)).toBe(false);
  });

  it("refuses a member rate above the public one", () => {
    const court = venue().courts.find((c) => c.sport === "badminton")!;
    expect(updateCourt(court.id, { memberOffPeakRate: court.offPeakRate + 1 }))
      .toMatchObject({ ok: false, error: "The off-peak member rate is higher than the public one." });
    expect(updateCourt(court.id, { memberPeakRate: court.peakRate + 1 }))
      .toMatchObject({ ok: false, error: "The peak member rate is higher than the public one." });
    expect(updateCourt(court.id, { memberOffPeakRate: -1 })).toMatchObject({ ok: false });
  });

  it("charges a member the member rate when they book", () => {
    const weekday = nextWeekday(5);
    expect(isPeak(weekday, 10)).toBe(false);
    const court = venue().courts.filter((c) => c.sport === "badminton")[1];
    updateCourt(court.id, { memberOffPeakRate: 9 });
    sell({ holderPhone: "0195550000", holderName: "Member Mei" });

    const asMember = createBooking({
      courtId: court.id, date: weekday, hours: [10, 11], name: "Member Mei", phone: "0195550000",
    });
    expect(asMember).toMatchObject({ ok: true });
    if (asMember.ok) expect(asMember.booking.totalPrice).toBe(18); // 9 + 9

    const asGuest = createBooking({
      courtId: court.id, date: weekday, hours: [12, 13], name: "Guest", phone: "0198887777",
    });
    expect(asGuest).toMatchObject({ ok: true });
    if (asGuest.ok) expect(asGuest.booking.totalPrice).toBe(getCourt(court.id)!.offPeakRate * 2);

    updateCourt(court.id, { memberOffPeakRate: null });
  });

  it("prices each week of a series against that week's membership", () => {
    const court = venue().courts.filter((c) => c.sport === "badminton")[2];
    updateCourt(court.id, { memberOffPeakRate: 5, memberPeakRate: 5 });
    const phone = "0196660000";
    // A term that covers the first two weeks only.
    // A term ending inside the 14-day booking window, so both sessions below
    // are bookable but only the first is covered.
    const m = sell({ holderPhone: phone, holderName: "Short Term", expiresOn: addDays(todayISO(), 6) });
    expect(m.expiresOn).toBe(addDays(todayISO(), 6));

    // Inside the term: the flat member rate, whether the hour is peak or not.
    const covered = future(4);
    const r = createBooking({
      courtId: court.id, date: covered, hours: [14], name: "Short Term", phone,
    });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.booking.totalPrice).toBe(5);

    // Past the expiry: the public rate for that date, peak or off-peak.
    const lapsedDate = addDays(todayISO(), 10);
    const after = createBooking({
      courtId: court.id, date: lapsedDate, hours: [14], name: "Short Term", phone,
    });
    expect(after).toMatchObject({ ok: true });
    if (after.ok)
      expect(after.booking.totalPrice).toBe(computePrice(getCourt(court.id)!, lapsedDate, [14], false));

    updateCourt(court.id, { memberOffPeakRate: null, memberPeakRate: null });
  });

  it("lists a holder's memberships and a venue's own", () => {
    const phone = "0197770000";
    const m = sell({ holderPhone: phone, holderName: "Lister" });
    expect(listMembershipsFor({ phone }).map((x) => x.id)).toContain(m.id);
    expect(listMembershipsFor({})).toEqual([]);
    const venueList = listMembershipsForVenue(venue().id);
    expect(venueList.every((x) => x.venueId === venue().id)).toBe(true);
    expect(venueList[0].id).toBeGreaterThanOrEqual(m.id);
  });
});
