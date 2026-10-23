import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { bookingTerms } from "../src/lib/booking-terms";
import { getDb } from "../src/lib/db";
import { setSportRules, sportRules } from "../src/lib/sport-rules";
import { cancelBooking, createBooking, createCourt, createVenue, getAvailability } from "../src/lib/store";
import { addDays, dayOfWeek, todayISO } from "../src/lib/time";

/** One sport's own rules at a venue, over the venue's: cancellation and peak hours. */

let venueId: number;
let tennis: number;
let badminton: number;
let n = 0;
const phone = () => `0133330${String(++n).padStart(3, "0")}`;
let weekday = addDays(todayISO(), 1);
while ([0, 6].includes(dayOfWeek(weekday))) weekday = addDays(weekday, 1);
const tomorrow = addDays(todayISO(), 1);

beforeAll(async () => {
  const v = await createVenue({ name: "Racquet Centre", area: "KL", address: "x", phone: "0311112222" });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  await getDb().prepare("UPDATE venues SET cancel_cutoff_hours = 2 WHERE id = ?").run(venueId);
  const t = await createCourt({ venueId, name: "Tennis 1", sport: "tennis", offPeakRate: 40, peakRate: 60 });
  const b = await createCourt({ venueId, name: "Badminton 1", sport: "badminton", offPeakRate: 20, peakRate: 30 });
  if (!t.ok || !b.ok) throw new Error("court");
  tennis = t.court.id;
  badminton = b.court.id;
});

describe("a sport's own rules", () => {
  it("are checked, and all on the venue's takes the sport back to them", async () => {
    expect(await setSportRules(venueId, "curling", { cutoffHours: 2 })).toMatchObject({ ok: false });
    expect(await setSportRules(venueId, "tennis", { cutoffHours: 100 })).toMatchObject({ ok: false });
    expect(await setSportRules(venueId, "tennis", { lateKeep: 120 })).toMatchObject({ ok: false });
    expect(await setSportRules(venueId, "tennis", { peak: { weekdayFrom: 20 * 60, weekdayUntil: 18 * 60, weekendFrom: 0 * 60, weekendUntil: 24 * 60 } })).toMatchObject({ ok: false });
    expect(await setSportRules(venueId, "pickleball", { cutoffHours: 6 })).toMatchObject({ ok: true });
    expect(await setSportRules(venueId, "pickleball", {})).toEqual({ ok: true, rules: null });
    expect(await sportRules(venueId)).toEqual([]);
  });

  it("move the peak hours for that sport only", async () => {
    const set = await setSportRules(venueId, "tennis", { peak: { weekdayFrom: 17 * 60, weekdayUntil: 24 * 60, weekendFrom: 0 * 60, weekendUntil: 24 * 60 } });
    expect(set).toMatchObject({ ok: true, rules: { peak: { weekdayFrom: 17 * 60 } } });
    const day = await getAvailability(venueId, weekday);
    const at = (court: number, hour: number) => day.find((d) => d.court.id === court)!.slots.find((s) => s.hour === hour)!;
    expect(at(tennis, 17)).toMatchObject({ rate: 60, peak: true });
    expect(at(badminton, 17).rate).toBe(20);
    expect(at(badminton, 18)).toMatchObject({ rate: 30, peak: true });
  });

  it("give that sport its own cancellation cutoff and late-cancel share", async () => {
    await setSportRules(venueId, "tennis", { cutoffHours: 48, lateKeep: 50, peak: null });
    const t = await createBooking({ courtId: tennis, date: tomorrow, hours: [20], name: "Tennis", phone: phone() });
    const b = await createBooking({ courtId: badminton, date: tomorrow, hours: [20], name: "Shuttle", phone: phone() });
    if (!t.ok || !b.ok) throw new Error("book");
    // Inside tennis's 48 hours: late, the venue keeps half of what was paid (nothing was).
    expect(await cancelBooking(t.booking.code, t.booking.phone)).toMatchObject({ ok: true, kept: 0, booking: { status: "cancelled" } });
    expect((await getDb().prepare("SELECT late_cancelled FROM bookings WHERE id = ?").get(t.booking.id)) as object).toEqual({ late_cancelled: 1 });
    // Badminton keeps the venue's two hours: free.
    const free = await cancelBooking(b.booking.code, b.booking.phone);
    expect(free.ok && "kept" in free).toBe(false);
  });

  it("no cancelling online for that sport after its cutoff", async () => {
    await setSportRules(venueId, "tennis", { cutoffHours: 48, lateKeep: "none" });
    const t = await createBooking({ courtId: tennis, date: tomorrow, hours: [21], name: "Tennis", phone: phone() });
    if (!t.ok) throw new Error("book");
    expect(await cancelBooking(t.booking.code, t.booking.phone)).toMatchObject({ ok: false });
  });

  it("are the terms shown before booking that sport", async () => {
    await setSportRules(venueId, "tennis", { cutoffHours: 48, lateKeep: 50 });
    expect(await bookingTerms(venueId, "tennis")).toMatchObject({ cutoffHours: 48, lateKeep: 50 });
    expect(await bookingTerms(venueId, "badminton")).toMatchObject({ cutoffHours: 2, lateKeep: null });
    expect((await bookingTerms(venueId))!.cutoffHours).toBe(2);
  });
});
