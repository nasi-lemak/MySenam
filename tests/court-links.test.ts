import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { courtLinks, linkedTo, setCourtParts } from "../src/lib/court-links";
import { getDb } from "../src/lib/db";
import { createOutage } from "../src/lib/outages";
import { venueReport } from "../src/lib/reports";
import {
  adminCancelBooking,
  blockSlots,
  createBooking,
  createClassSessions,
  createCourt,
  createVenue,
  getAvailability,
  rescheduleBooking,
  updateCourt,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * A multi-purpose hall: one futsal pitch, or badminton courts on the same
 * floor. Booking the pitch takes them; booking one of them takes the pitch;
 * they do not take each other.
 */

let venueId: number;
let pitch: number;
let a: number;
let b: number;
let c: number;
let shared: number;
let n = 0;
/** Bookings of Badminton 3 that clash with the pitch once it is linked. */
const clashing: string[] = [];
const date = addDays(todayISO(), 4);
const phone = () => `0177770${String(++n).padStart(3, "0")}`;

async function court(name: string, sport: string, capacity = 1): Promise<number> {
  const made = await createCourt({ venueId, name, sport: sport as never, offPeakRate: 20, peakRate: 20, capacity });
  if (!made.ok) throw new Error(made.error);
  return made.court.id;
}

async function free(courtId: number, hour: number, on = date): Promise<boolean> {
  const day = await getAvailability(venueId, on);
  return day.find((d) => d.court.id === courtId)!.slots.find((s) => s.hour === hour)!.available;
}

const book = (courtId: number, hour: number, on = date) => createBooking({ courtId, date: on, hours: [hour], name: "Player", phone: phone() });

beforeAll(async () => {
  const made = await createVenue({ name: "Dewan Serbaguna", area: "Shah Alam", address: "x", phone: "0355550000", openHour: 8, closeHour: 23 });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  pitch = await court("Futsal pitch", "futsal");
  a = await court("Badminton 1", "badminton");
  b = await court("Badminton 2", "badminton");
  c = await court("Badminton 3", "badminton");
  shared = await court("Gym floor", "gym", 10);
});

describe("linking courts", () => {
  it("takes only courts booked whole, at the venue, one level deep", async () => {
    expect(await setCourtParts(pitch, [shared])).toMatchObject({ ok: false });
    expect(await setCourtParts(pitch, [pitch])).toMatchObject({ ok: false });
    expect(await setCourtParts(pitch, [a, b])).toEqual({ ok: true, parts: [a, b] });
    expect(await courtLinks(venueId)).toEqual([
      { wholeId: pitch, partId: a },
      { wholeId: pitch, partId: b },
    ]);
    expect(await linkedTo(a)).toEqual([pitch]);
    // A part cannot take others, nor the pitch be part of something.
    expect(await setCourtParts(a, [c])).toMatchObject({ ok: false });
    expect(await setCourtParts(c, [pitch])).toMatchObject({ ok: false });
    // Nor a linked court start selling places.
    expect(await updateCourt(a, { capacity: 4 })).toMatchObject({ ok: false });
  });
});

describe("booking across a link", () => {
  it("booking the pitch takes its courts, and not the others", async () => {
    const made = await book(pitch, 10);
    expect(made.ok).toBe(true);
    expect(await free(a, 10)).toBe(false);
    expect(await free(b, 10)).toBe(false);
    expect(await free(c, 10)).toBe(true);
    expect(await book(a, 10)).toMatchObject({ ok: false });
    const own = await book(c, 10);
    if (!own.ok) throw new Error(own.error);
    clashing.push(own.booking.code);
  });

  it("booking a court takes the pitch, while the courts do not take each other", async () => {
    expect((await book(a, 11)).ok).toBe(true);
    expect(await free(pitch, 11)).toBe(false);
    expect((await book(b, 11)).ok).toBe(true);
    expect(await book(pitch, 11)).toMatchObject({ ok: false });
  });

  it("holds when two people try the pitch and a court at the same moment", async () => {
    const [x, y] = await Promise.all([book(pitch, 12), book(b, 12)]);
    expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1);
  });

  it("frees the courts when the pitch is cancelled, and follows a booking that moves", async () => {
    const made = await book(pitch, 13);
    if (!made.ok) throw new Error(made.error);
    expect(await free(a, 13)).toBe(false);
    expect(await adminCancelBooking(made.booking.code)).toMatchObject({ ok: true });
    expect(await free(a, 13)).toBe(true);

    const court1 = await book(a, 14);
    if (!court1.ok) throw new Error(court1.error);
    expect(await rescheduleBooking(court1.booking.code, { date, startHour: 15 }, "staff")).toMatchObject({ ok: true });
    expect(await free(pitch, 14)).toBe(true);
    expect(await free(pitch, 15)).toBe(false);
  });

  it("counts time sold once, on the court that was booked", async () => {
    const report = await venueReport(venueId, date, date);
    const real = (await getDb()
      .prepare("SELECT COALESCE(SUM(k.end_min - k.start_min), 0)::float / 60 AS h FROM bookings k WHERE k.date = ? AND k.status = 'confirmed' AND k.court_id IN (?, ?, ?, ?)")
      .get(date, pitch, a, b, c)) as { h: number };
    // Sold on its own court, once; the floor measure (tests/reports-floor.test.ts) counts the floor each covers.
    const exclusive = report!.byCourt.filter((line) => line.courtId !== shared);
    expect(exclusive.reduce((sum, line) => sum + line.hours, 0)).toBe(real.h);
  });
});

describe("blocks and outages across a link", () => {
  it("a block on a court closes the pitch then, and the pitch's closes the courts", async () => {
    expect((await blockSlots(b, date, [16], "Net repair")).ok).toBe(true);
    expect(await free(pitch, 16)).toBe(false);
    expect(await free(a, 16)).toBe(true);
    expect((await blockSlots(pitch, date, [17], "School event")).ok).toBe(true);
    expect(await free(a, 17)).toBe(false);
    expect(await free(b, 17)).toBe(false);
    expect(await book(a, 17)).toMatchObject({ ok: false });
  });

  it("a court out of service takes the pitch out with it", async () => {
    await ensureBootstrapAdmin();
    const owner = (await listAdmins())[0].id;
    const later = addDays(date, 7);
    const made = await createOutage({ courtId: a, startsOn: later, endsOn: later, reason: "Resurfacing", adminId: owner });
    expect(made.ok).toBe(true);
    expect(await free(pitch, 9, later)).toBe(false);
    expect(await free(b, 9, later)).toBe(true);
  });

  it("taking the pitch out of service names a class on one of its courts", async () => {
    await ensureBootstrapAdmin();
    const owner = (await listAdmins())[0].id;
    const when = addDays(date, 9);
    const session = await createClassSessions({ courtId: b, name: "Junior smash", instructor: "Lee", date: when, startHour: 18, endHour: 19, capacity: 1, price: 10 });
    if (!session.ok) throw new Error(session.error);
    const refused = await createOutage({ courtId: pitch, startsOn: when, endsOn: when, reason: "Floor sanding", adminId: owner });
    expect(refused).toMatchObject({ ok: false });
    if (!refused.ok) expect(refused.affected?.map((x) => x.name)).toContain("Junior smash");
  });
});

describe("changing the links", () => {
  it("will not link two courts already booked at the same time, and names the first such day", async () => {
    const other = addDays(date, 1);
    expect((await book(pitch, 18, other)).ok).toBe(true);
    const own = await book(c, 18, other);
    if (!own.ok) throw new Error(own.error);
    clashing.push(own.booking.code);
    const refused = await setCourtParts(pitch, [a, b, c]);
    expect(refused).toMatchObject({ ok: false });
    // Badminton 3 and the pitch are both booked at 10 on the first day too.
    if (!refused.ok) expect(refused.error).toContain(date);
    expect(await linkedTo(c)).toEqual([]);
  });

  it("linked, what is already sold takes the new court too; unlinked, it lets go", async () => {
    const third = addDays(date, 2);
    expect((await book(pitch, 9, third)).ok).toBe(true);
    expect(await free(c, 9, third)).toBe(true);
    // Badminton 3's own bookings at the pitch's times go first.
    for (const code of clashing) expect(await adminCancelBooking(code)).toMatchObject({ ok: true });
    expect(await setCourtParts(pitch, [a, b, c])).toEqual({ ok: true, parts: [a, b, c] });
    expect(await free(c, 9, third)).toBe(false);
    expect(await setCourtParts(pitch, [a])).toEqual({ ok: true, parts: [a] });
    expect(await free(b, 9, third)).toBe(true);
    expect(await free(c, 9, third)).toBe(true);
    expect(await free(a, 9, third)).toBe(false);
  });
});

describe("two big courts over the same small one", () => {
  let hallA: number;
  let hallB: number;
  let middle: number;
  const day = addDays(date, 5);

  beforeAll(async () => {
    hallA = await court("Hall A (netball)", "netball");
    hallB = await court("Hall B (futsal)", "futsal");
    middle = await court("Middle court", "badminton");
    expect((await setCourtParts(hallA, [middle])).ok).toBe(true);
    expect((await setCourtParts(hallB, [middle])).ok).toBe(true);
  });

  it("booking one shows the other taken, as booking it would fail", async () => {
    expect((await book(hallA, 9, day)).ok).toBe(true);
    expect(await free(middle, 9, day)).toBe(false);
    expect(await free(hallB, 9, day)).toBe(false);
    expect(await book(hallB, 9, day)).toMatchObject({ ok: false });
    // An hour neither has is free on both.
    expect(await free(hallB, 10, day)).toBe(true);
  });

  it("a block on one closes the other too", async () => {
    expect((await blockSlots(hallA, day, [12], "Maintenance")).ok).toBe(true);
    expect(await free(hallB, 12, day)).toBe(false);
  });

  it("linked later, what is already sold takes the new big court too", async () => {
    const hallC = await court("Hall C (volleyball)", "volleyball");
    expect((await book(hallA, 15, day)).ok).toBe(true);
    expect(await free(hallC, 15, day)).toBe(true);
    expect((await setCourtParts(hallC, [middle])).ok).toBe(true);
    expect(await free(hallC, 15, day)).toBe(false);
    // And unlinked, lets go again.
    expect((await setCourtParts(hallC, [])).ok).toBe(true);
    expect(await free(hallC, 15, day)).toBe(true);
  });
});
