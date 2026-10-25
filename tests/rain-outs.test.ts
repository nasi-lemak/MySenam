import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { getDb } from "../src/lib/db";
import { rainOut } from "../src/lib/rain-outs";
import { createBooking, createClassSessions, createCourt, createVenue, enrolInClass, findBooking, getAvailability, getClass, listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { rememberLocale } from "../src/lib/notify";

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

describe("the reason each customer is told", () => {
  const day = addDays(todayISO(), 3);
  const bookWith = async (hour: number, phone: string, email: string, locale: "en" | "ms") => {
    const made = await createBooking({ courtId: outdoor, date: day, hours: [hour], name: "Siti", phone, email });
    if (!made.ok) throw new Error(made.error);
    await rememberLocale([made.booking.id], locale);
    return made.booking;
  };
  const toldTo = async (email: string) =>
    (await getDb()
      .prepare("SELECT body, params FROM messages WHERE recipient = ? AND kind = 'booking_cancelled_by_venue'")
      .get(email)) as { body: string; params: string } | undefined;

  it("gives the built-in reason in each customer's own language when staff leave it", async () => {
    const malay = await bookWith(10, "0123000101", "siti.ms@example.test", "ms");
    await bookWith(11, "0123000102", "sam.en@example.test", "en");
    // The panel sends the staff's own language for the schedule's label, and the preset for customers.
    const done = await rainOut({ venueId, courtIds: [outdoor], date: day, fromHour: 10, untilHour: 12, reason: "因雨取消", reasonPreset: "rained_off" });
    expect(done).toMatchObject({ ok: true });
    expect((await findBooking(malay.code, "0123000101"))?.status).toBe("cancelled");
    const ms = await toldTo("siti.ms@example.test");
    const en = await toldTo("sam.en@example.test");
    expect(ms?.body).toContain("Sebab: Dibatalkan kerana hujan");
    expect(ms?.body).not.toContain("因雨取消");
    expect(en?.body).toContain("Reason: Rained off");
    // On WhatsApp it rides in the same parameter as what is owed: the template is unchanged.
    expect(Object.keys(JSON.parse(ms!.params)).sort()).toEqual(["ack", "code", "money", "name", "venue", "when", "where"]);
    // The schedule shows staff what the panel showed them.
    const label = (await getDb()
      .prepare("SELECT reason FROM blocks WHERE court_id = ? AND date = ? AND start_min <= 600 AND end_min > 600")
      .get(outdoor, day)) as { reason: string } | undefined;
    expect(label?.reason).toBe("因雨取消");
  });

  it("gives what staff typed as typed, whatever the customer's language", async () => {
    const malay = await bookWith(14, "0123000103", "aina.ms@example.test", "ms");
    expect(await rainOut({ venueId, courtIds: [outdoor], date: day, fromHour: 14, untilHour: 15, reason: "Court flooded after the storm" })).toMatchObject({ ok: true });
    expect((await findBooking(malay.code, "0123000103"))?.status).toBe("cancelled");
    const ms = await toldTo("aina.ms@example.test");
    expect(ms?.body).toContain("Sebab: Court flooded after the storm");
    expect(ms?.body).not.toContain("hujan");
  });

  it("gives the built-in reason when none is given at all", async () => {
    await bookWith(16, "0123000104", "hana.ms@example.test", "ms");
    expect(await rainOut({ venueId, courtIds: [outdoor], date: day, fromHour: 16, untilHour: 17 })).toMatchObject({ ok: true });
    expect((await toldTo("hana.ms@example.test"))?.body).toContain("Sebab: Dibatalkan kerana hujan");
  });
});
