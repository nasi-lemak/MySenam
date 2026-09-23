import { describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import {
  blockSlots,
  closeVenueDay,
  courtsForAnyBooking,
  createBooking,
  createBookingOnAnyCourt,
  createClassSessions,
  listVenues,
  reopenVenueDay,
  updateCourt,
} from "../src/lib/store";
import { addDays, isPeak, todayISO } from "../src/lib/time";
import { computePrice } from "../src/lib/store";

const PHONE = "0123456789";
const future = (o = 3) => addDays(todayISO(), o);

/**
 * Peak covers the whole of a weekend, so a test that needs off-peak rates has
 * to land on a weekday. Walk forward from `from` until the weekday matches,
 * which keeps these stable whatever day the suite runs on.
 */
function nextWeekday(from = 3): string {
  for (let o = from; o < from + 7; o++) {
    const d = future(o);
    if (!isPeak(d, 10)) return d;
  }
  throw new Error("no weekday in range");
}
function nextWeekend(from = 3): string {
  for (let o = from; o < from + 7; o++) {
    const d = future(o);
    if (isPeak(d, 10)) return d;
  }
  throw new Error("no weekend in range");
}
const venue = () => listVenues()[0];
const badminton = () => venue().courts.filter((c) => c.sport === "badminton");

function fill(courtId: number, hours: number[], date: string, who: string) {
  const r = createBooking({ courtId, date, hours, name: who, phone: "0198887777" });
  if (!r.ok) throw new Error(r.error);
  return r.booking;
}

describe("booking without naming a court", () => {
  it("orders candidates cheapest first, by what that slot actually costs", () => {
    const weekday = nextWeekday();
    expect(isPeak(weekday, 10)).toBe(false);

    // The seed prices every badminton court alike, so make one dearer — that
    // is the difference this test is about.
    const premium = badminton()[0];
    expect(updateCourt(premium.id, { offPeakRate: 30, peakRate: 45 })).toMatchObject({ ok: true });

    const morning = courtsForAnyBooking({ venueId: venue().id, sport: "badminton", date: weekday, hours: [10] });
    expect(morning.length).toBe(badminton().length);
    for (let i = 1; i < morning.length; i++) {
      expect(computePrice(morning[i - 1], weekday, [10]))
        .toBeLessThanOrEqual(computePrice(morning[i], weekday, [10]));
    }
    // The dear one sorts last whichever slot is asked for.
    expect(morning[0].id).not.toBe(premium.id);
    expect(morning[morning.length - 1].id).toBe(premium.id);

    // A weekend morning is peak, so the ordering is by peak rate instead.
    const weekend = nextWeekend();
    expect(isPeak(weekend, 10)).toBe(true);
    const wk = courtsForAnyBooking({ venueId: venue().id, sport: "badminton", date: weekend, hours: [10] });
    for (let i = 1; i < wk.length; i++) {
      expect(computePrice(wk[i - 1], weekend, [10]))
        .toBeLessThanOrEqual(computePrice(wk[i], weekend, [10]));
    }
    expect(wk[wk.length - 1].id).toBe(premium.id);

    // Put it back so later tests see the seeded prices.
    updateCourt(premium.id, { offPeakRate: 15, peakRate: 25 });
  });

  it("takes the cheapest court that is actually free", () => {
    const date = future(4);
    const order = courtsForAnyBooking({ venueId: venue().id, sport: "badminton", date, hours: [10, 11] });
    const cheapest = order[0];
    fill(cheapest.id, [10, 11], date, "Early bird");

    const nextCheapest = courtsForAnyBooking({ venueId: venue().id, sport: "badminton", date, hours: [10, 11] })[0];
    expect(nextCheapest.id).not.toBe(cheapest.id);

    const r = createBookingOnAnyCourt({
      venueId: venue().id, sport: "badminton", date, hours: [10, 11], name: "Aisyah", phone: PHONE,
    });
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(r.bookings[0].courtId).toBe(nextCheapest.id);
    // And it costs what that court costs, not what the premium one would.
    expect(r.bookings[0].totalPrice).toBe(computePrice(nextCheapest, date, [10, 11]));
  });

  it("only offers a court free for every hour, not just some of them", () => {
    const date = future(5);
    const [c1, c2] = badminton();
    fill(c1.id, [15], date, "Blocker");           // free at 14 and 16, not 15
    blockSlots(c2.id, date, [16], "Maintenance"); // free at 14 and 15, not 16

    const ids = courtsForAnyBooking({
      venueId: venue().id, sport: "badminton", date, hours: [14, 15, 16],
    }).map((c) => c.id);
    expect(ids).not.toContain(c1.id);
    expect(ids).not.toContain(c2.id);
    expect(ids.length).toBeGreaterThan(0);
  });

  it("skips a court running a class", () => {
    const date = future(6);
    const [c1] = badminton();
    const scheduled = createClassSessions({
      courtId: c1.id, name: "Drills", instructor: "Coach", date,
      startHour: 9, endHour: 10, capacity: 1, price: 30,
    });
    expect(scheduled).toMatchObject({ ok: true });
    const ids = courtsForAnyBooking({ venueId: venue().id, sport: "badminton", date, hours: [9] }).map((c) => c.id);
    expect(ids).not.toContain(c1.id);
  });

  it("falls back through the list when the cheapest is taken mid-flight", () => {
    const date = future(7);
    const order = courtsForAnyBooking({ venueId: venue().id, sport: "badminton", date, hours: [12] });
    // Fill every court but the dearest, as if the cheap ones went while the
    // customer was typing their name.
    for (const c of order.slice(0, -1)) fill(c.id, [12], date, "Rush");

    const r = createBookingOnAnyCourt({
      venueId: venue().id, sport: "badminton", date, hours: [12], name: "Aisyah", phone: PHONE,
    });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.bookings[0].courtId).toBe(order[order.length - 1].id);
  });

  it("gives the real reason when nothing is free, not a flat refusal", () => {
    const date = future(8);
    for (const c of badminton()) fill(c.id, [13], date, "Full house");
    const r = createBookingOnAnyCourt({
      venueId: venue().id, sport: "badminton", date, hours: [13], name: "Aisyah", phone: PHONE,
    });
    // Not "someone just took it" — nothing was ever free.
    expect(r).toMatchObject({
      ok: false,
      error: "No court is free for that whole time. Please pick another time.",
    });

    // A closed day reads as closed, not as "no court free".
    const closedDate = future(9);
    closeVenueDay(venue().id, closedDate, "Hari Raya");
    const closed = createBookingOnAnyCourt({
      venueId: venue().id, sport: "badminton", date: closedDate, hours: [13], name: "A", phone: PHONE,
    });
    expect(closed).toMatchObject({ ok: false, error: "The venue is closed that day." });
    reopenVenueDay(venue().id, closedDate);

    // Outside trading hours reads as such.
    const early = createBookingOnAnyCourt({
      venueId: venue().id, sport: "badminton", date: future(10), hours: [6], name: "A", phone: PHONE,
    });
    expect(early).toMatchObject({ ok: false, error: "Selected hours are outside operating hours." });
  });

  it("rejects an unknown venue, an unknown sport and a sport the venue lacks", () => {
    const date = future(11);
    expect(createBookingOnAnyCourt({
      venueId: 9999, sport: "badminton", date, hours: [10], name: "A", phone: PHONE,
    })).toMatchObject({ ok: false, error: "Venue not found." });

    expect(createBookingOnAnyCourt({
      venueId: venue().id, sport: "hopscotch" as never, date, hours: [10], name: "A", phone: PHONE,
    })).toMatchObject({ ok: false, error: "Unknown sport." });

    // The seeded PJ venue has no tennis courts.
    expect(createBookingOnAnyCourt({
      venueId: venue().id, sport: "tennis", date, hours: [10], name: "A", phone: PHONE,
    })).toMatchObject({ ok: false, error: "That venue has no Tennis courts." });
  });

  it("works for a weekly series too, keeping every week on one court", () => {
    const date = future(12);
    const r = createBookingOnAnyCourt({
      venueId: venue().id, sport: "badminton", date, hours: [16], weeks: 3,
      name: "Liga", phone: PHONE,
    });
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(r.bookings).toHaveLength(3);
    expect(new Set(r.bookings.map((b) => b.courtId)).size).toBe(1);
    expect(r.seriesCode).not.toBeNull();
  });

  it("handles a shared facility by place, not by whole court", () => {
    const date = future(13);
    const gym = venue().courts.find((c) => c.sport === "gym")!;
    expect(updateCourt(gym.id, { capacity: 3 })).toMatchObject({ ok: true });
    for (let i = 0; i < 2; i++) fill(gym.id, [17], date, `Gym goer ${i}`);
    // Two of three places gone, so the gym is still a candidate.
    const ids = courtsForAnyBooking({ venueId: venue().id, sport: "gym", date, hours: [17] }).map((c) => c.id);
    expect(ids).toContain(gym.id);

    expect(createBookingOnAnyCourt({
      venueId: venue().id, sport: "gym", date, hours: [17], name: "Third", phone: PHONE,
    })).toMatchObject({ ok: true });

    // Now full, so it drops out.
    expect(courtsForAnyBooking({ venueId: venue().id, sport: "gym", date, hours: [17] })).toEqual([]);
  });
});
