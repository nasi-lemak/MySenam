import { describe, expect, it } from "vitest";

process.env.MUDAHTEMPAH_DB = ":memory:";

import {
  cancelClassSession,
  createBooking,
  createClassSessions,
  createCourt,
  enrolInClass,
  getAvailability,
  getClass,
  getClassRoster,
  listClasses,
  listVenues,
  searchAvailability,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

const futureDate = (offset: number) => addDays(todayISO(), offset);

function studio(capacity: number, name: string) {
  const created = createCourt({
    venueId: listVenues()[0].id,
    name,
    sport: "gym",
    offPeakRate: 5,
    peakRate: 8,
    capacity,
  });
  if (!created.ok) throw new Error("studio not created");
  return created.court;
}

function schedule(courtId: number, overrides: Partial<Parameters<typeof createClassSessions>[0]> = {}) {
  return createClassSessions({
    courtId,
    name: "Yoga Flow",
    instructor: "Mei Ling",
    date: futureDate(3),
    startHour: 19,
    endHour: 20,
    capacity: 3,
    price: 25,
    ...overrides,
  });
}

describe("scheduling classes", () => {
  it("creates a session that shows up in the listing", () => {
    const court = studio(10, "Studio A");
    const result = schedule(court.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const session = result.classes[0];
    expect(session).toMatchObject({
      name: "Yoga Flow",
      instructor: "Mei Ling",
      capacity: 3,
      price: 25,
      enrolled: 0,
      status: "scheduled",
    });
    expect(result.seriesCode).toBeNull();
    expect(listClasses({ venueId: court.venueId }).some((c) => c.id === session.id)).toBe(true);
  });

  it("repeats weekly for a term under one series code", () => {
    const court = studio(10, "Studio Term");
    const result = schedule(court.id, { weeks: 4, startHour: 7 + 1, endHour: 9 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.classes).toHaveLength(4);
    expect(result.seriesCode).toMatch(/^CL-[A-Z2-9]{6}$/);
    result.classes.forEach((c, i) => {
      expect(c.date).toBe(addDays(futureDate(3), i * 7));
      expect(c.seriesCode).toBe(result.seriesCode);
    });
  });

  it("rejects bad hours, over-capacity and a past start", () => {
    const court = studio(4, "Studio Limits");
    expect(schedule(court.id, { startHour: 6, endHour: 7 })).toMatchObject({
      ok: false,
      error: expect.stringContaining("operating hours"),
    });
    expect(schedule(court.id, { startHour: 20, endHour: 20 })).toMatchObject({ ok: false });
    expect(schedule(court.id, { capacity: 99 })).toMatchObject({
      ok: false,
      error: expect.stringContaining("capacity of"),
    });
    expect(schedule(court.id, { date: addDays(todayISO(), -1) })).toMatchObject({ ok: false });
    expect(schedule(9999)).toMatchObject({ ok: false, error: "Court not found." });
  });

  it("will not schedule over existing bookings or another class", () => {
    const court = studio(10, "Studio Clash");
    const date = futureDate(4);
    createBooking({ courtId: court.id, date, hours: [19], name: "Walk In", phone: "0160000001" });
    expect(schedule(court.id, { date })).toMatchObject({
      ok: false,
      error: expect.stringContaining("already has bookings"),
    });

    const clear = futureDate(5);
    expect(schedule(court.id, { date: clear }).ok).toBe(true);
    expect(schedule(court.id, { date: clear })).toMatchObject({
      ok: false,
      error: expect.stringContaining("already has a class"),
    });
  });
});

describe("a class reserves its resource", () => {
  it("hides those hours from general booking and search", () => {
    const court = studio(10, "Studio Reserved");
    const date = futureDate(6);
    const result = schedule(court.id, { date });
    expect(result.ok).toBe(true);

    const slot = getAvailability(court.venueId, date)
      .find((a) => a.court.id === court.id)!
      .slots.find((s) => s.hour === 19)!;
    expect(slot.available).toBe(false);
    expect(slot.className).toBe("Yoga Flow");

    expect(
      createBooking({ courtId: court.id, date, hours: [19], name: "Walk In", phone: "0160000101" })
    ).toMatchObject({ ok: false, error: expect.stringContaining("reserved for a class") });

    expect(
      searchAvailability({ sport: "gym", date, fromHour: 19, toHour: 19 }).some(
        (r) => r.court.id === court.id
      )
    ).toBe(false);

    // the hour either side is untouched
    expect(
      createBooking({ courtId: court.id, date, hours: [18], name: "Walk In", phone: "0160000102" }).ok
    ).toBe(true);
  });
});

describe("enrolment", () => {
  it("takes a place, prices at the class rate and fills up", () => {
    const court = studio(10, "Studio Enrol");
    const date = futureDate(7);
    const result = schedule(court.id, { date, capacity: 2 });
    if (!result.ok) return;
    const classId = result.classes[0].id;

    const first = enrolInClass({ classId, name: "Aisyah", phone: "0160000201" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // the class price, not the court's hourly rate
    expect(first.booking.totalPrice).toBe(25);
    expect(first.booking.classId).toBe(classId);
    expect(first.booking.checkInToken).toMatch(/^[a-f0-9]{32}$/);

    expect(enrolInClass({ classId, name: "Ben", phone: "0160000202" }).ok).toBe(true);
    expect(getClass(classId)?.enrolled).toBe(2);

    expect(enrolInClass({ classId, name: "Chandra", phone: "0160000203" })).toMatchObject({
      ok: false,
      error: "This class is full.",
    });
  });

  it("refuses a double enrolment from the same phone", () => {
    const court = studio(10, "Studio Double");
    const result = schedule(court.id, { date: futureDate(8) });
    if (!result.ok) return;
    const classId = result.classes[0].id;

    expect(enrolInClass({ classId, name: "Dina", phone: "0160000301" }).ok).toBe(true);
    expect(enrolInClass({ classId, name: "Dina", phone: "0160000301" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("already enrolled"),
    });
  });

  it("refuses an unknown or cancelled class", () => {
    expect(enrolInClass({ classId: 99999, name: "X", phone: "0160000401" })).toMatchObject({
      ok: false,
      error: "Class not found.",
    });
  });
});

describe("cancelling a class", () => {
  it("releases every enrolment and frees the resource again", () => {
    const court = studio(10, "Studio Cancel");
    const date = futureDate(9);
    const result = schedule(court.id, { date });
    if (!result.ok) return;
    const classId = result.classes[0].id;

    enrolInClass({ classId, name: "Eve", phone: "0160000501" });
    enrolInClass({ classId, name: "Farid", phone: "0160000502" });
    expect(getClassRoster(classId)).toHaveLength(2);

    const cancelled = cancelClassSession(classId);
    expect(cancelled).toMatchObject({ ok: true, released: 2 });
    expect(getClass(classId)?.status).toBe("cancelled");
    expect(getClassRoster(classId).every((b) => b.status === "cancelled")).toBe(true);

    // cancelling twice is refused, and enrolling is no longer possible
    expect(cancelClassSession(classId)).toMatchObject({ ok: false });
    expect(enrolInClass({ classId, name: "Late", phone: "0160000503" })).toMatchObject({
      ok: false,
      error: "This class was cancelled.",
    });

    // the hour returns to general booking
    const slot = getAvailability(court.venueId, date)
      .find((a) => a.court.id === court.id)!
      .slots.find((s) => s.hour === 19)!;
    expect(slot.available).toBe(true);
    expect(slot.className).toBeUndefined();
    expect(
      createBooking({ courtId: court.id, date, hours: [19], name: "Walk In", phone: "0160000504" }).ok
    ).toBe(true);
  });
});
