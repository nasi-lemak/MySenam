import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { EXPIRING_SOON_DAYS, venueReport, walletLiability } from "../src/lib/reports";
import {
  adminCancelBooking,
  blockSlots,
  closeVenueDay,
  createBooking,
  createCourt,
  createVenue,
  issuePass,
  listVenues,
  payBookingWithPass,
  sellMembership,
  setNoShow,
  setPaymentStatus,
  topUpWallet,
} from "../src/lib/store";
import { registerUser } from "../src/lib/auth";
import { ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { addDays, todayISO } from "../src/lib/time";

afterEach(() => {
  vi.useRealTimers();
});

// A venue of its own, so the seed's demo data cannot move the numbers.
let venueId: number;
let courtId: number;
let gymId: number;
const FROM = () => addDays(todayISO(), 1);
const TO = () => addDays(todayISO(), 7);

beforeAll(() => {
  const venue = createVenue({
    name: "Report Arena",
    area: "Shah Alam",
    address: "1 Jalan Report",
    phone: "+60 3-1111 1111",
    openHour: 8,
    closeHour: 18, // ten sellable hours a day
  });
  if (!venue.ok) throw new Error(venue.error);
  venueId = venue.venue.id;

  const court = createCourt({
    venueId,
    name: "Court 1",
    sport: "badminton",
    offPeakRate: 20,
    peakRate: 30,
  });
  if (!court.ok) throw new Error(court.error);
  courtId = court.court.id;

  const gym = createCourt({
    venueId,
    name: "Gym Floor",
    sport: "gym",
    offPeakRate: 5,
    peakRate: 8,
    capacity: 4,
  });
  if (!gym.ok) throw new Error(gym.error);
  gymId = gym.court.id;
});

function book(court: number, date: string, hours: number[], phone: string) {
  const made = createBooking({ courtId: court, date, hours, name: "Player", phone });
  if (!made.ok) throw new Error(made.error);
  return made.booking;
}

describe("a month in the life of a venue", () => {
  it("counts what was sold, what was taken, and what is still owed", () => {
    const date = FROM();
    const paid = book(courtId, date, [9, 10], "0191000001");
    setPaymentStatus(paid.code, true);
    book(courtId, date, [11], "0191000002");

    const report = venueReport(venueId, FROM(), TO())!;
    expect(report.venueName).toBe("Report Arena");
    expect(report.bookings.confirmed).toBe(2);
    expect(report.bookings.hours).toBe(3);
    expect(report.revenue.expected).toBe(paid.totalPrice + report.revenue.outstanding);
    expect(report.revenue.collected).toBe(paid.totalPrice);
    expect(report.revenue.outstanding).toBe(report.revenue.expected - paid.totalPrice);
  });

  it("shows cancellations as their own number rather than lost revenue", () => {
    const date = addDays(FROM(), 1);
    const doomed = book(courtId, date, [9], "0191000003");
    const before = venueReport(venueId, FROM(), TO())!;
    adminCancelBooking(doomed.code);
    const after = venueReport(venueId, FROM(), TO())!;

    expect(after.bookings.cancelled).toBe(before.bookings.cancelled + 1);
    expect(after.bookings.confirmed).toBe(before.bookings.confirmed - 1);
    // A cancelled booking earns nothing and holds no hours.
    expect(after.revenue.expected).toBe(before.revenue.expected - doomed.totalPrice);
    expect(after.bookings.hours).toBe(before.bookings.hours - 1);
  });

  it("counts no-shows without taking the money back off the books", () => {
    const date = addDays(FROM(), 2);
    const ghost = book(courtId, date, [9], "0191000004");
    setPaymentStatus(ghost.code, true);

    // A no-show can only be flagged once the slot has passed, so stand in the
    // day after it.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${addDays(date, 1)}T09:00:00+08:00`));
    expect(setNoShow(ghost.code, true).ok).toBe(true);
    vi.useRealTimers();

    const report = venueReport(venueId, FROM(), TO())!;
    expect(report.bookings.noShows).toBeGreaterThan(0);
    // They paid and did not turn up; the venue still took the money.
    expect(report.revenue.collected).toBeGreaterThanOrEqual(ghost.totalPrice);
  });
});

describe("how full the place was", () => {
  it("measures against the hours that could actually be sold", () => {
    const report = venueReport(venueId, FROM(), TO())!;
    const days = 7;
    const trading = 10; // 8 AM to 6 PM

    const court = report.byCourt.find((c) => c.courtId === courtId)!;
    expect(court.sellableHours).toBe(trading * 1 * days);
    // A shared floor sells places, not hours, so capacity multiplies.
    const gym = report.byCourt.find((c) => c.courtId === gymId)!;
    expect(gym.sellableHours).toBe(trading * 4 * days);

    // Reported apart, because a four-place floor and a one-court hour are not
    // the same unit and blending them lets the bigger one decide the number.
    expect(report.utilisation.courts.sellableHours).toBe(court.sellableHours);
    expect(report.utilisation.shared.sellableHours).toBe(gym.sellableHours);
    expect(report.utilisation.courts.percent).toBeCloseTo(
      report.utilisation.courts.soldHours / report.utilisation.courts.sellableHours,
      6
    );
  });

  it("does not count hours it could not have sold", () => {
    const before = venueReport(venueId, FROM(), TO())!;

    // A whole day shut, and an afternoon of maintenance on one court.
    closeVenueDay(venueId, addDays(FROM(), 3), "Deep clean");
    blockSlots(courtId, addDays(FROM(), 4), [14, 15, 16], "Net repair");

    const after = venueReport(venueId, FROM(), TO())!;
    expect(after.closedDays).toBe(1);
    // The closed day takes a day off every court; the block takes three
    // place-hours off one of them.
    const sellable = (r: typeof after) =>
      r.utilisation.courts.sellableHours + r.utilisation.shared.sellableHours;
    const lostToClosure = 10 * 1 + 10 * 4;
    expect(sellable(after)).toBe(sellable(before) - lostToClosure - 3);
    expect(after.utilisation.courts.percent).toBeGreaterThan(before.utilisation.courts.percent);
  });
});

describe("breakdowns an owner can act on", () => {
  it("splits by sport and by court", () => {
    book(gymId, addDays(FROM(), 5), [19 - 9], "0191000005");
    const report = venueReport(venueId, FROM(), TO())!;

    const badminton = report.bySport.find((s) => s.sport === "badminton")!;
    expect(badminton.bookings).toBeGreaterThan(0);
    expect(badminton.hours).toBeGreaterThan(0);
    // Sport totals are the court totals, regrouped.
    expect(badminton.expected).toBe(
      report.byCourt.filter((c) => c.sport === "badminton").reduce((n, c) => n + c.expected, 0)
    );
    expect(report.bySport.reduce((n, s) => n + s.hours, 0)).toBe(report.bookings.hours);
  });

  it("says where peak really is, within the trading day", () => {
    const report = venueReport(venueId, FROM(), TO())!;
    expect(report.byHour).toHaveLength(10);
    expect(report.byHour[0].hour).toBe(8);
    expect(report.byHour[report.byHour.length - 1].hour).toBe(17);
    expect(report.byHour.reduce((n, h) => n + h.hours, 0)).toBe(report.bookings.hours);
  });

  it("gives a row per month across the period, including quiet ones", () => {
    const report = venueReport(venueId, "2026-01-01", "2026-03-31")!;
    expect(report.byMonth.map((m) => m.month)).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(report.byMonth.every((m) => m.expected === 0)).toBe(true);
  });
});

describe("what the venue still owes", () => {
  it("counts unspent pass entries as hours outstanding", () => {
    ensureBootstrapAdmin();
    const pass = issuePass({
      venueId,
      name: "10 hours badminton",
      entries: 10,
      price: 180,
      holderName: "Pass Holder",
      holderPhone: "0192000001",
      expiresOn: addDays(todayISO(), 60),
      adminId: listAdmins()[0].id,
    });
    if (!pass.ok) throw new Error(pass.error);

    const before = venueReport(venueId, FROM(), TO())!;
    expect(before.liabilities.passEntriesUnspent).toBeGreaterThanOrEqual(10);
    expect(before.liabilities.passesLive).toBeGreaterThan(0);

    // Spending an entry reduces what is owed.
    const booking = book(courtId, addDays(FROM(), 6), [9], "0192000001");
    const spent = payBookingWithPass(booking.id, pass.pass.code);
    expect(spent.ok).toBe(true);

    const after = venueReport(venueId, FROM(), TO())!;
    expect(after.liabilities.passEntriesUnspent).toBe(
      before.liabilities.passEntriesUnspent - 1
    );
  });

  it("counts live memberships and the ones about to lapse", () => {
    ensureBootstrapAdmin();
    const adminId = listAdmins()[0].id;
    const lapsing = sellMembership({
      adminId,
      venueId,
      holderName: "About To Lapse",
      holderPhone: "0192000002",
      startsOn: todayISO(),
      expiresOn: addDays(todayISO(), EXPIRING_SOON_DAYS - 1),
      price: 100,
    });
    const safe = sellMembership({
      adminId,
      venueId,
      holderName: "Renewed Already",
      holderPhone: "0192000003",
      startsOn: todayISO(),
      expiresOn: addDays(todayISO(), EXPIRING_SOON_DAYS + 60),
      price: 100,
    });
    expect(lapsing.ok && safe.ok).toBe(true);

    const report = venueReport(venueId, FROM(), TO())!;
    expect(report.liabilities.membershipsActive).toBe(2);
    expect(report.liabilities.membershipsExpiringSoon).toBe(1);
  });

  it("keeps stored credit at the platform, not the venue", async () => {
    const user = await registerUser({
      name: "Credit Holder",
      email: "credit-report@example.com",
      phone: "0192000004",
      password: "correct horse battery",
    });
    if (!user.ok) throw new Error(user.error);
    ensureBootstrapAdmin();
    const owner = listAdmins()[0];
    const topUp = topUpWallet({
      userId: user.user.id,
      amount: 75,
      adminId: owner.id,
      reason: "Counter top-up",
    });
    expect(topUp.ok).toBe(true);

    const liability = walletLiability();
    expect(liability.balance).toBeGreaterThanOrEqual(75);
    expect(liability.customers).toBeGreaterThan(0);

    // It is deliberately absent from the venue report: credit is bought at one
    // counter and spent at any.
    const report = venueReport(venueId, FROM(), TO())!;
    expect(Object.keys(report.liabilities)).not.toContain("wallet");
  });
});

describe("edges", () => {
  it("returns nothing for a venue that does not exist", () => {
    expect(venueReport(999_999, FROM(), TO())).toBeNull();
  });

  it("handles a single day and a venue with nothing sold", () => {
    const quiet = createVenue({
      name: "Quiet Courts",
      area: "Klang",
      address: "2 Jalan Quiet",
      phone: "+60 3-2222 2222",
    });
    if (!quiet.ok) throw new Error(quiet.error);

    const report = venueReport(quiet.venue.id, FROM(), FROM())!;
    expect(report.days).toBe(1);
    expect(report.bookings.confirmed).toBe(0);
    expect(report.revenue.expected).toBe(0);
    // No courts at all means nothing was sellable, and no division by zero.
    expect(report.utilisation.courts.percent).toBe(0);
    expect(report.utilisation.shared.percent).toBe(0);
    expect(report.byCourt).toHaveLength(0);
  });
});
