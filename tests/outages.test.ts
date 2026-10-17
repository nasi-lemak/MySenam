import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { createOutage, endOutage, listOutages } from "../src/lib/outages";
import {
  createBooking,
  createClassSessions,
  createCourt,
  createVenue,
  getAvailability,
  getClass,
  searchAvailability,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/** A court out of service for days at a time, or until further notice. */

let venueId: number;
let ownerId: number;
let n = 0;

async function court(capacity = 1) {
  const c = await createCourt({ venueId, name: `Court ${++n}`, sport: "tennis", offPeakRate: 30, peakRate: 40, capacity });
  if (!c.ok) throw new Error("court");
  return c.court.id;
}

const day = (d: number) => addDays(todayISO(), d);

async function open(courtId: number, date: string): Promise<boolean[]> {
  const grid = await getAvailability(venueId, date);
  return grid.find((g) => g.court.id === courtId)!.slots.map((s) => s.available);
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  ownerId = (await listAdmins())[0].id;
  const v = await createVenue({ name: "Outage Club", area: "Bangsar", address: "1 Jalan Bangsar", phone: "0322222222" });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
});

describe("a court out of service", () => {
  it("cannot be booked or found on any day of the stretch, and can either side of it", async () => {
    const courtId = await court();
    const made = await createOutage({ courtId, startsOn: day(3), endsOn: day(5), reason: "Resurfacing", adminId: ownerId });
    expect(made).toMatchObject({ ok: true, cancelled: 0 });

    expect((await open(courtId, day(4))).every((a) => !a)).toBe(true);
    expect((await open(courtId, day(2))).some((a) => a)).toBe(true);
    expect((await open(courtId, day(6))).some((a) => a)).toBe(true);

    expect((await createBooking({ courtId, date: day(4), hours: [10], name: "Tan", phone: "0123334444" })).ok).toBe(false);
    const found = await searchAvailability({ sport: "tennis", date: day(5), area: "Bangsar" });
    expect(found.some((r) => r.court.id === courtId)).toBe(false);
    expect((await listOutages([venueId])).find((o) => o.courtId === courtId)).toMatchObject({
      startsOn: day(3),
      endsOn: day(5),
      reason: "Resurfacing",
    });
  });

  it("can be out until further notice, and back in service today", async () => {
    const courtId = await court();
    const made = await createOutage({ courtId, startsOn: todayISO(), endsOn: null, reason: "Net torn", adminId: ownerId });
    if (!made.ok) throw new Error(made.error);
    expect((await open(courtId, day(13))).every((a) => !a)).toBe(true);

    // Back today: under way, so it ended yesterday — nothing ahead is closed.
    await getDb().prepare("UPDATE court_outages SET starts_on = ? WHERE id = ?").run(day(-2), made.outage.id);
    expect(await endOutage(made.outage.id)).toEqual({ ok: true });
    expect((await open(courtId, day(13))).some((a) => a)).toBe(true);
    expect(await endOutage(made.outage.id)).toEqual({ ok: false, error: "That is over already." });
  });

  it("called off before it starts is simply gone", async () => {
    const courtId = await court();
    const made = await createOutage({ courtId, startsOn: day(7), endsOn: day(8), adminId: ownerId });
    if (!made.ok) throw new Error(made.error);
    await endOutage(made.outage.id);
    expect((await listOutages([venueId])).some((o) => o.id === made.outage.id)).toBe(false);
  });

  it("will not close over bookings unless told to cancel them, and then refunds and tells them", async () => {
    const courtId = await court();
    const booked = await createBooking({ courtId, date: day(4), hours: [9, 10], name: "Siti", phone: "0125556666" });
    if (!booked.ok) throw new Error("booking");

    const refused = await createOutage({ courtId, startsOn: day(3), endsOn: day(5), adminId: ownerId });
    expect(refused).toMatchObject({
      ok: false,
      affected: [{ kind: "booking", ref: booked.booking.code, date: day(4), startHour: 9, name: "Siti" }],
    });

    const done = await createOutage({ courtId, startsOn: day(3), endsOn: day(5), adminId: ownerId, cancelAffected: true });
    expect(done).toMatchObject({ ok: true, cancelled: 1 });
    expect(
      ((await getDb().prepare("SELECT status FROM bookings WHERE id = ?").get(booked.booking.id)) as { status: string }).status
    ).toBe("cancelled");
    const told = await getDb()
      .prepare("SELECT kind FROM messages WHERE booking_id = ?")
      .all(booked.booking.id) as { kind: string }[];
    expect(told.map((m) => m.kind)).toContain("booking_cancelled");
  });

  it("cancels a class in the stretch too, when told to", async () => {
    const courtId = await court(10);
    const cls = await createClassSessions({
      courtId,
      name: "Cardio tennis",
      instructor: "Ahmad",
      date: day(4),
      startHour: 18,
      endHour: 19,
      capacity: 8,
      price: 25,
    });
    if (!cls.ok) throw new Error("class");
    const done = await createOutage({ courtId, startsOn: day(4), endsOn: day(4), adminId: ownerId, cancelAffected: true });
    expect(done).toMatchObject({ ok: true, cancelled: 1 });
    expect((await getClass(cls.classes[0].id))?.status).toBe("cancelled");
  });

  it("is out once at a time", async () => {
    const courtId = await court();
    expect((await createOutage({ courtId, startsOn: day(3), endsOn: day(6), adminId: ownerId })).ok).toBe(true);
    const again = await createOutage({ courtId, startsOn: day(5), endsOn: null, adminId: ownerId });
    expect(again).toMatchObject({ ok: false, error: expect.stringContaining("already out of service") });
    expect((await createOutage({ courtId, startsOn: day(7), endsOn: day(8), adminId: ownerId })).ok).toBe(true);
  });

  it("refuses a stretch that makes no sense", async () => {
    const courtId = await court();
    expect(await createOutage({ courtId, startsOn: day(-1), endsOn: null, adminId: ownerId })).toMatchObject({ ok: false });
    expect(await createOutage({ courtId, startsOn: day(5), endsOn: day(4), adminId: ownerId })).toMatchObject({ ok: false });
    expect(await createOutage({ courtId: 999999, startsOn: day(5), endsOn: null, adminId: ownerId })).toMatchObject({
      ok: false,
      error: "Court not found.",
    });
  });
});

describe("the route", () => {
  it("is for the venue's own staff", async () => {
    const courtId = await court();
    const other = await createVenue({ name: "Elsewhere", area: "Klang", address: "2 Jalan Klang", phone: "0333333333" });
    if (!other.ok) throw new Error("venue");
    const staff = await createAdmin({ name: "Desk", email: "desk@elsewhere.my", password: "desk-password", venueId: other.venue.id });
    if (!staff.ok) throw new Error(staff.error);
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(staff.admin.id)).token}`;
    const { POST } = await import("../src/app/api/admin/outages/route");
    const res = await POST(
      new NextRequest("http://localhost/api/admin/outages", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ courtId, startsOn: day(2), endsOn: null }),
      })
    );
    expect(res.status).toBe(403);
  });
});
