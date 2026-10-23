import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { getDb } from "../src/lib/db";
import { rainOut } from "../src/lib/rain-outs";
import { createBooking, createClassSessions, createCourt, createVenue, enrolInClass, findBooking, getAvailability, getClass, listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Rained off: every booking and class on the chosen courts in those hours
 * called off at once, each customer told, the hours blocked meanwhile.
 */

let venueId: number;
let outdoor: number;
let indoor: number;
const date = addDays(todayISO(), 2);

beforeAll(async () => {
  venueId = (await listVenues())[0].id;
  const o = await createCourt({ venueId, name: "Outdoor 1", sport: "tennis", offPeakRate: 30, peakRate: 40 });
  const i = await createCourt({ venueId, name: "Hall 1", sport: "tennis", offPeakRate: 30, peakRate: 40 });
  if (!o.ok || !i.ok) throw new Error("court");
  outdoor = o.court.id;
  indoor = i.court.id;
});

const book = async (courtId: number, hours: number[], phone: string) => {
  const made = await createBooking({ courtId, date, hours, name: "Hafiz", phone });
  if (!made.ok) throw new Error(made.error);
  return made.booking;
};

describe("calling off a rained-off afternoon", () => {
  it("first says what it would call off, calling off nothing", async () => {
    const a = await book(outdoor, [15], "0123000001");
    const preview = await rainOut({ venueId, courtIds: [outdoor], date, fromHour: 14, untilHour: 18, preview: true });
    expect(preview).toMatchObject({ ok: true, classes: 0, blocked: 0 });
    if (!preview.ok) return;
    expect(preview.bookings).toEqual([{ code: a.code, name: "Hafiz", startMin: 15 * 60, startHour: 15 }]);
    expect((await findBooking(a.code, "0123000001"))?.status).toBe("confirmed");
  });

  it("then calls off the bookings and classes in those hours, tells each customer, and blocks the hours", async () => {
    const before = await book(outdoor, [12], "0123000002");
    const inside = await book(outdoor, [16, 17], "0123000003");
    const elsewhere = await book(indoor, [16], "0123000004");
    const made = await createClassSessions({ courtId: outdoor, name: "Junior Tennis", instructor: "Coach Lim", date, startHour: 14, endHour: 15, capacity: 1, price: 20 });
    if (!made.ok) throw new Error(made.error);
    const session = made.classes[0];
    expect((await enrolInClass({ classId: session.id, name: "Aina", phone: "0123000005" })).ok).toBe(true);

    const done = await rainOut({ venueId, courtIds: [outdoor], date, fromHour: 14, untilHour: 18, reason: "Thunderstorm" });
    expect(done).toMatchObject({ ok: true, classes: 1, blocked: 1 });
    if (!done.ok) return;
    expect(done.bookings.map((b) => b.code).sort()).toEqual(
      [inside.code, (await getDb().prepare("SELECT code FROM bookings WHERE name = 'Hafiz' AND start_min = 900").get() as { code: string }).code].sort()
    );
    expect((await findBooking(inside.code, "0123000003"))?.status).toBe("cancelled");
    expect((await findBooking(before.code, "0123000002"))?.status).toBe("confirmed");
    expect((await findBooking(elsewhere.code, "0123000004"))?.status).toBe("confirmed");
    expect((await getClass(session.id))?.status).toBe("cancelled");

    // The desk sees each one until the customer has seen it.
    const told = (await getDb()
      .prepare("SELECT name FROM urgent_notices WHERE venue_id = ? AND kind = 'cancelled' ORDER BY name")
      .all(venueId)) as { name: string }[];
    expect(told.map((r) => r.name)).toEqual(expect.arrayContaining(["Aina", "Hafiz"]));

    // Nobody books those hours meanwhile; the hour before is still open.
    const day = (await getAvailability(venueId, date)).find((c) => c.court.id === outdoor)!;
    const slot = (h: number) => day.slots.find((s) => s.hour === h);
    expect(slot(16)?.available).toBe(false);
    expect(slot(13)?.available).toBe(true);
    const blocked = (await getDb()
      .prepare("SELECT reason FROM blocks WHERE court_id = ? AND date = ? AND start_min <= 960 AND end_min > 960")
      .get(outdoor, date)) as { reason: string } | undefined;
    expect(blocked?.reason).toBe("Thunderstorm");
  });

  it("refuses courts at another venue, past days, and hours outside opening", async () => {
    const other = await createVenue({ name: "Taman Tasik", area: "Ipoh", address: "x", phone: "0555551111" });
    if (!other.ok) throw new Error("venue");
    expect(await rainOut({ venueId: other.venue.id, courtIds: [outdoor], date, fromHour: 14, untilHour: 16 })).toMatchObject({ ok: false });
    expect(await rainOut({ venueId, courtIds: [outdoor], date: addDays(todayISO(), -1), fromHour: 14, untilHour: 16 })).toMatchObject({ ok: false });
    expect(await rainOut({ venueId, courtIds: [outdoor], date, fromHour: 16, untilHour: 14 })).toMatchObject({ ok: false });
    expect(await rainOut({ venueId, courtIds: [outdoor], date, fromHour: 2, untilHour: 30 })).toMatchObject({ ok: false });
    expect(await rainOut({ venueId, courtIds: [], date, fromHour: 14, untilHour: 16 })).toMatchObject({ ok: false });
  });
});
