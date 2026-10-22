import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { getDb } from "../src/lib/db";
import { endRepeatBlock, listRepeatBlocks, repeatBlock } from "../src/lib/repeat-blocks";
import { createBooking, createCourt, createVenue, getAvailability } from "../src/lib/store";
import { addDays, dayOfWeek, todayISO } from "../src/lib/time";

/** The same hours out every week, set once; booked hours left to their bookings. */

let venueId: number;
let courtA: number;
let courtB: number;
// The next Tuesday at least two days off, so no hour of it has passed.
let tuesday = addDays(todayISO(), 2);
while (dayOfWeek(tuesday) !== 2) tuesday = addDays(tuesday, 1);

beforeAll(async () => {
  const made = await createVenue({ name: "Dewan Serbaguna", area: "Klang", address: "x", phone: "0333332222" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const a = await createCourt({ venueId, name: "Court A", sport: "badminton", offPeakRate: 20, peakRate: 30 });
  const b = await createCourt({ venueId, name: "Court B", sport: "badminton", offPeakRate: 20, peakRate: 30 });
  if (!a.ok || !b.ok) throw new Error("court");
  courtA = a.court.id;
  courtB = b.court.id;
});

const free = async (courtId: number, date: string, hour: number) =>
  (await getAvailability(venueId, date)).find((c) => c.court.id === courtId)!.slots.find((s) => s.hour === hour)!.available;

describe("blocking the same hours every week", () => {
  it("takes them out each week, leaving booked hours to their bookings and naming them", async () => {
    const booked = await createBooking({ courtId: courtA, date: addDays(tuesday, 7), hours: [9], name: "Lim", phone: "0123334444" });
    if (!booked.ok) throw new Error(booked.error);
    const done = await repeatBlock({
      venueId,
      courtIds: [courtA, courtB],
      from: tuesday,
      days: [2],
      fromHour: 8,
      untilHour: 10,
      weeks: 4,
      reason: "SK Klang PE lessons",
    });
    if (!done.ok) throw new Error(done.error);
    expect(done.blocked).toBe(8);
    expect(done.clashes).toEqual([{ courtName: "Court A", date: addDays(tuesday, 7), hour: 9 }]);
    expect(await free(courtA, tuesday, 8)).toBe(false);
    expect(await free(courtB, addDays(tuesday, 21), 9)).toBe(false);
    // Not the Wednesday, nor the fifth week, nor the hour after.
    expect(await free(courtA, addDays(tuesday, 1), 8)).toBe(true);
    expect(await free(courtA, addDays(tuesday, 28), 8)).toBe(true);
    expect(await free(courtA, tuesday, 10)).toBe(true);
    const reason = (await getDb().prepare("SELECT reason FROM slot_blocks WHERE court_id = ? AND date = ? AND hour = 8").get(courtA, tuesday)) as { reason: string };
    expect(reason.reason).toBe("SK Klang PE lessons");
  });

  it("is listed as one, and ended at once from today", async () => {
    const [run] = await listRepeatBlocks(venueId);
    expect(run).toMatchObject({ reason: "SK Klang PE lessons", courts: ["Court A", "Court B"], days: [2], fromHour: 8, untilHour: 10, next: tuesday, last: addDays(tuesday, 21) });
    expect(await endRepeatBlock(venueId, run.code)).toBe(15);
    expect(await free(courtA, tuesday, 8)).toBe(true);
    expect(await listRepeatBlocks(venueId)).toEqual([]);
    expect(await endRepeatBlock(venueId, run.code)).toBe(0);
  });

  it("refuses what it cannot do", async () => {
    const base = { venueId, courtIds: [courtA], from: tuesday, days: [2], fromHour: 8, untilHour: 10, weeks: 4, reason: "Cleaning" };
    expect(await repeatBlock({ ...base, days: [] })).toMatchObject({ ok: false });
    expect(await repeatBlock({ ...base, weeks: 60 })).toMatchObject({ ok: false });
    expect(await repeatBlock({ ...base, from: addDays(todayISO(), -1) })).toMatchObject({ ok: false });
    expect(await repeatBlock({ ...base, untilHour: 8 })).toMatchObject({ ok: false });
    expect(await repeatBlock({ ...base, reason: "" })).toMatchObject({ ok: false });
    const other = await createVenue({ name: "Elsewhere", area: "Ipoh", address: "x", phone: "0555553333" });
    if (!other.ok) throw new Error("venue");
    expect(await repeatBlock({ ...base, venueId: other.venue.id })).toMatchObject({ ok: false });
    expect(await repeatBlock({ ...base, fromHour: 1, untilHour: 3 })).toMatchObject({ ok: false });
  });
});
