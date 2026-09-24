import { describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import {
  blockSlots,
  courtsForAnyBooking,
  createBooking,
  createCourt,
  getAdminSlots,
  getAvailability,
  getOccupancy,
  joinSlotWaitlist,
  listVenues,
  moveBooking,
  moveTargetsFor,
  searchAvailability,
  unblockSlots,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

const PHONE = "0123456789";
const future = (o = 3) => addDays(todayISO(), o);
const venue = () => listVenues()[0];

/** A kayak fleet: the case partial blocks exist for. */
function fleet(capacity = 6) {
  const r = createCourt({
    venueId: venue().id,
    name: `Kayak Fleet ${Math.random().toString(36).slice(2, 6)}`,
    sport: "kayak",
    offPeakRate: 20,
    peakRate: 30,
    capacity,
  });
  if (!r.ok) throw new Error(r.error);
  return r.court;
}

function rent(courtId: number, hours: number[], date: string, who = "Renter", phone = PHONE) {
  const r = createBooking({ courtId, date, hours, name: who, phone });
  if (!r.ok) throw new Error(r.error);
  return r.booking;
}

function slotFor(courtId: number, date: string, hour: number) {
  const grid = getAvailability(venue().id, date).find((a) => a.court.id === courtId)!;
  return grid.slots.find((s) => s.hour === hour)!;
}

describe("kayak hire as a sport", () => {
  it("is a resource like any other, with places rather than a court", () => {
    const k = fleet(6);
    expect(k.sport).toBe("kayak");
    expect(k.capacity).toBe(6);
    const date = future(3);
    expect(slotFor(k.id, date, 10)).toMatchObject({ available: true, booked: 0, capacity: 6 });
    rent(k.id, [10], date);
    expect(slotFor(k.id, date, 10)).toMatchObject({ available: true, booked: 1 });
  });
});

describe("taking some places out of service", () => {
  it("shrinks the fleet without closing the hour", () => {
    const k = fleet(6);
    const date = future(4);
    expect(blockSlots(k.id, date, [10], "Two hulls cracked", 2)).toMatchObject({ ok: true, changed: 1 });

    const slot = slotFor(k.id, date, 10);
    expect(slot).toMatchObject({ available: true, capacity: 6, blockedPlaces: 2 });
    expect(slot.blocked).toBeUndefined();

    // Four can still go out; the fifth cannot.
    for (let i = 0; i < 4; i++) rent(k.id, [10], date, `Renter ${i}`, `01900000${i}0`);
    expect(slotFor(k.id, date, 10)).toMatchObject({ available: false, booked: 4 });
    expect(createBooking({ courtId: k.id, date, hours: [10], name: "Fifth", phone: "0198887777" }))
      .toMatchObject({ ok: false });
  });

  it("still supports blocking the whole thing", () => {
    const k = fleet(4);
    const date = future(5);
    expect(blockSlots(k.id, date, [11], "Storm")).toMatchObject({ ok: true, changed: 1 });
    const slot = slotFor(k.id, date, 11);
    expect(slot).toMatchObject({ available: false, blocked: true });
    expect(slot.blockedPlaces).toBeUndefined();
    expect(createBooking({ courtId: k.id, date, hours: [11], name: "A", phone: PHONE }))
      .toMatchObject({ ok: false });
  });

  it("refuses to take out more places than are free", () => {
    const k = fleet(4);
    const date = future(6);
    rent(k.id, [12], date, "Already out");
    rent(k.id, [12], date, "Also out", "0197776666");

    // Two of four gone, so two can be taken out but not three.
    expect(blockSlots(k.id, date, [12], "Repair", 3)).toMatchObject({ ok: false });
    expect(blockSlots(k.id, date, [12], "Repair", 2)).toMatchObject({ ok: true, changed: 1 });
    expect(slotFor(k.id, date, 12)).toMatchObject({ available: false, booked: 2 });
  });

  it("revises an hour that is already blocked rather than duplicating it", () => {
    const k = fleet(6);
    const date = future(7);
    expect(blockSlots(k.id, date, [9], "One out", 1)).toMatchObject({ ok: true, changed: 1 });
    expect(slotFor(k.id, date, 9).blockedPlaces).toBe(1);
    expect(blockSlots(k.id, date, [9], "Three out now", 3)).toMatchObject({ ok: true, changed: 1 });
    expect(slotFor(k.id, date, 9).blockedPlaces).toBe(3);
    expect(unblockSlots(k.id, date, [9])).toMatchObject({ ok: true, changed: 1 });
    expect(slotFor(k.id, date, 9).blockedPlaces).toBeUndefined();
  });

  it("rejects a partial block on an exclusive court and a silly count", () => {
    const court = venue().courts.find((c) => c.sport === "badminton")!;
    const date = future(8);
    expect(blockSlots(court.id, date, [10], "Nope", 1)).toMatchObject({
      ok: false, error: "An exclusive court is blocked whole, not in parts.",
    });
    const k = fleet(5);
    expect(blockSlots(k.id, date, [10], "Nope", 0)).toMatchObject({ ok: false });
    expect(blockSlots(k.id, date, [10], "Nope", 6)).toMatchObject({ ok: false, error: "Places out must be 1–5." });
  });
});

describe("a partial block everywhere else it matters", () => {
  it("is honoured by cross-venue search and by 'any court'", () => {
    const k = fleet(2);
    const date = future(9);
    expect(blockSlots(k.id, date, [14], "One out", 1)).toMatchObject({ ok: true });

    // One place left, so it still shows.
    expect(searchAvailability({ sport: "kayak", date, fromHour: 14, toHour: 14 })
      .some((r) => r.court.id === k.id)).toBe(true);
    expect(courtsForAnyBooking({ venueId: venue().id, sport: "kayak", date, hours: [14] })
      .some((c) => c.id === k.id)).toBe(true);

    rent(k.id, [14], date, "Last one");
    // Now the block has taken the last place.
    expect(searchAvailability({ sport: "kayak", date, fromHour: 14, toHour: 14 })
      .some((r) => r.court.id === k.id)).toBe(false);
    expect(courtsForAnyBooking({ venueId: venue().id, sport: "kayak", date, hours: [14] })
      .some((c) => c.id === k.id)).toBe(false);
  });

  it("is honoured when moving a booking onto the fleet", () => {
    const from = fleet(3);
    const to = fleet(3);
    const date = future(10);
    const b = rent(from.id, [15], date, "Mover");

    expect(blockSlots(to.id, date, [15], "One out", 1)).toMatchObject({ ok: true });
    expect(moveTargetsFor(b.code).some((c) => c.id === to.id)).toBe(true);

    // Fill the two places that remain, and the target drops out.
    rent(to.id, [15], date, "A", "0191110001");
    rent(to.id, [15], date, "B", "0191110002");
    expect(moveTargetsFor(b.code).some((c) => c.id === to.id)).toBe(false);
    expect(moveBooking(b.code, to.id)).toMatchObject({ ok: false });
  });

  it("lets someone queue only once the last place is gone", () => {
    const k = fleet(2);
    const date = future(11);
    blockSlots(k.id, date, [16], "One out", 1);
    // A place is still free, so there is nothing to wait for.
    expect(joinSlotWaitlist({
      courtId: k.id, date, startHour: 16, endHour: 17, name: "Waiter", phone: "0196660000",
    })).toMatchObject({ ok: false, error: "That slot is free — book it instead." });

    rent(k.id, [16], date, "Took it");
    expect(joinSlotWaitlist({
      courtId: k.id, date, startHour: 16, endHour: 17, name: "Waiter", phone: "0196660000",
    })).toMatchObject({ ok: true });
  });

  it("counts only full blocks against the occupancy report", () => {
    const k = fleet(4);
    const date = future(12);
    blockSlots(k.id, date, [10, 11], "Two out", 2);
    const partial = getOccupancy(venue().id, date, 1)
      .days[0].perCourt.find((c) => c.courtId === k.id)!;
    expect(partial.blocked).toBe(0);

    blockSlots(k.id, date, [12], "All out");
    const full = getOccupancy(venue().id, date, 1)
      .days[0].perCourt.find((c) => c.courtId === k.id)!;
    expect(full.blocked).toBe(1);
  });

  it("shows staff the places out while the hour is still sellable", () => {
    const k = fleet(5);
    const date = future(13);
    blockSlots(k.id, date, [9], "Two in for repair", 2);
    const row = getAdminSlots(venue().id, date).find((a) => a.court.id === k.id)!;
    const slot = row.slots.find((s) => s.hour === 9)!;
    expect(slot.status).toBe("free");
    expect(slot.blockedPlaces).toBe(2);
    expect(slot.blockReason).toBe("Two in for repair");

    blockSlots(k.id, date, [9], "All in for repair", 5);
    const shut = getAdminSlots(venue().id, date)
      .find((a) => a.court.id === k.id)!.slots.find((s) => s.hour === 9)!;
    expect(shut.status).toBe("blocked");
    expect(shut.blockedPlaces).toBeUndefined();
  });
});
