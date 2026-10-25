import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { createOutage, endOutage, listOutages, outagesMissingLateHours, repairLateHours } from "../src/lib/outages";
import { instantOf } from "../src/lib/interval";
import {
  adminCancelBooking,
  courtZone,
  createBooking,
  createClassSessions,
  createCourt,
  createVenue,
  getAvailability,
  getClass,
  listVenues,
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
    const booked = await createBooking({ courtId, date: day(4), hours: [9, 10], name: "Siti", phone: "0125556666", email: "siti@example.my" });
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
    // Told it was the venue, with a link to say they have seen it.
    expect(told.map((m) => m.kind)).toContain("booking_cancelled_by_venue");
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

describe("a booking made while a court is being taken out", () => {
  for (let round = 0; round < 3; round++)
    it(`does not survive inside the outage (round ${round + 1})`, async () => {
      const [ownerId] = (await listAdmins()).map((a) => a.id);
      const venue = (await listVenues())[0];
      const made = await createCourt({ venueId: venue.id, name: `Race Court ${round}`, sport: "badminton", offPeakRate: 10, peakRate: 10 });
      if (!made.ok) throw new Error(made.error);
      const on = addDays(todayISO(), 9 + round);
      const first = await createBooking({ courtId: made.court.id, date: on, hours: [9], name: "First", phone: `01788800${round}1` });
      if (!first.ok) throw new Error(first.error);
      await Promise.all([
        createOutage({ courtId: made.court.id, startsOn: on, endsOn: on, reason: "Flood", adminId: ownerId, cancelAffected: true }),
        createBooking({ courtId: made.court.id, date: on, hours: [15], name: "Second", phone: `01788800${round}2` }),
      ]);
      const left = (await getDb()
        .prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE court_id = ? AND date = ? AND status = 'confirmed'")
        .get(made.court.id, on)) as { n: number };
      const outages = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM court_outages WHERE court_id = ?").get(made.court.id)) as { n: number };
      // Out of service, and nothing confirmed inside it.
      expect({ outages: outages.n, confirmed: left.n }).toEqual({ outages: 1, confirmed: 0 });
    });
});

describe("a court out of service at a venue open past midnight", () => {
  it("takes the late hours of its last night too, and leaves the night before's", async () => {
    const late = await createVenue({ name: "Night Courts", area: "Bangsar", address: "x", phone: "0322223333", openMin: 18 * 60, closeMin: 26 * 60 });
    if (!late.ok) throw new Error("venue");
    const c = await createCourt({ venueId: late.venue.id, name: "Late 1", sport: "futsal", offPeakRate: 50, peakRate: 50 });
    if (!c.ok) throw new Error(c.error);
    const out = await createOutage({ courtId: c.court.id, startsOn: day(5), endsOn: day(6), reason: "Resurfacing", adminId: ownerId });
    expect(out).toMatchObject({ ok: true });
    const book = (date: string, startMin: number) =>
      createBooking({ by: "staff", courtId: c.court.id, date, start: startMin, end: startMin + 60, name: "Night", phone: "0193334444" });
    // 01:00 after the last day is that day's late hour: out of service.
    expect(await book(day(6), 25 * 60)).toMatchObject({ ok: false });
    // 01:00 after the day before is that night's, not the first day's: still bookable.
    expect((await book(day(4), 25 * 60)).ok).toBe(true);
    // And the evening after the stretch is back.
    expect((await book(day(7), 19 * 60)).ok).toBe(true);
  });
});

describe("an outage from before migration 0090, at a venue open past midnight", () => {
  /**
   * The shape migration 0090 wrote: whole calendar days of its dates, from
   * midnight of the first to midnight after the last, so the last night's
   * hours after midnight (here 00:00–02:00) were left open.
   */
  async function legacy(courtId: number, startsOn: string, endsOn: string): Promise<number> {
    const out = await createOutage({ courtId, startsOn, endsOn, reason: "Resurfacing", adminId: ownerId });
    if (!out.ok) throw new Error(out.error);
    const zone = await courtZone(courtId);
    await getDb()
      .prepare("UPDATE claims SET during = ?::tstzrange, occupied = ?::tstzrange WHERE outage_id = ?")
      .run(
        `[${instantOf(startsOn, 0, zone).toISOString()},${instantOf(endsOn, 24 * 60, zone).toISOString()})`,
        `[${instantOf(startsOn, 0, zone).toISOString()},${instantOf(endsOn, 24 * 60, zone).toISOString()})`,
        out.outage.id
      );
    return out.outage.id;
  }
  let late: number;
  let lateVenue: number;
  const book = (courtId: number, date: string, startMin: number, phone = "0193335555") =>
    createBooking({ by: "staff", courtId, date, start: startMin, end: startMin + 60, name: "Night owl", phone });

  beforeAll(async () => {
    const v = await createVenue({ name: "Midnight Futsal", area: "Cheras", address: "x", phone: "0322224444", openMin: 18 * 60, closeMin: 26 * 60 });
    if (!v.ok) throw new Error("venue");
    lateVenue = v.venue.id;
    const c = await createCourt({ venueId: lateVenue, name: "Pitch L", sport: "futsal", offPeakRate: 50, peakRate: 50 });
    if (!c.ok) throw new Error(c.error);
    late = c.court.id;
  });

  it("leaves its last night's late hours bookable, and staff are shown it", async () => {
    const id = await legacy(late, day(8), day(9));
    // A booking sold since, in those hours: 00:00 after the last day.
    expect(await book(late, day(9), 24 * 60)).toMatchObject({ ok: true });
    expect((await outagesMissingLateHours([lateVenue])).map((m) => m.outage.id)).toEqual([id]);
    // Its first evening is closed as it always was.
    expect((await book(late, day(8), 19 * 60)).ok).toBe(false);
  });

  it("is repaired where the hours are free, listing the booking in the way and leaving it as it is", async () => {
    const id = (await outagesMissingLateHours([lateVenue]))[0].outage.id;
    const [repair] = await repairLateHours({ venueIds: [lateVenue] });
    expect(repair).toMatchObject({ outageId: id, date: day(9), claimed: [{ start: 25 * 60, end: 26 * 60 }] });
    expect(repair.collisions).toEqual([expect.objectContaining({ kind: "booking", date: day(9), startMin: 24 * 60, name: "Night owl" })]);
    // The booking stands; the hour after it is closed now.
    const code = repair.collisions[0].ref;
    expect((await getDb().prepare("SELECT status FROM bookings WHERE code = ?").get(code)) as { status: string }).toEqual({ status: "confirmed" });
    expect(await book(late, day(9), 25 * 60, "0193335556")).toMatchObject({ ok: false });
    // Nothing was put over the booking: the database holds one claim at 00:30.
    const at = instantOf(day(9), 24 * 60 + 30, await courtZone(late)).toISOString();
    const holding = (await getDb()
      .prepare("SELECT kind FROM claims WHERE court_id = ? AND active AND during @> ?::timestamptz ORDER BY kind")
      .all(late, at)) as { kind: string }[];
    expect(holding).toEqual([{ kind: "booking" }]);
  });

  it("run again, takes nothing twice and lists the booking still there; once it is gone, closes its hour too", async () => {
    const [again] = await repairLateHours({ venueIds: [lateVenue] });
    expect(again.claimed).toEqual([]);
    expect(again.collisions).toHaveLength(1);
    expect(await adminCancelBooking(again.collisions[0].ref)).toMatchObject({ ok: true });
    const [last] = await repairLateHours({ venueIds: [lateVenue] });
    expect(last.claimed).toEqual([{ start: 24 * 60, end: 25 * 60 }]);
    expect(last.collisions).toEqual([]);
    expect(await outagesMissingLateHours([lateVenue])).toEqual([]);
    expect(await repairLateHours({ venueIds: [lateVenue] })).toEqual([]);
    // That hour is closed to new bookings now.
    expect((await book(late, day(9), 24 * 60, "0193335557")).ok).toBe(false);
  });

  it("leaves alone outages made since, open-ended ones, and venues that close by midnight", async () => {
    const c = await createCourt({ venueId: lateVenue, name: "Pitch M", sport: "futsal", offPeakRate: 50, peakRate: 50 });
    if (!c.ok) throw new Error(c.error);
    expect((await createOutage({ courtId: c.court.id, startsOn: day(12), endsOn: day(13), adminId: ownerId })).ok).toBe(true);
    const d = await createCourt({ venueId: lateVenue, name: "Pitch N", sport: "futsal", offPeakRate: 50, peakRate: 50 });
    if (!d.ok) throw new Error(d.error);
    expect((await createOutage({ courtId: d.court.id, startsOn: day(12), endsOn: null, adminId: ownerId })).ok).toBe(true);
    // At a venue closing at 22:00 a whole calendar day is every hour it opens.
    const early = await court();
    await legacy(early, day(14), day(15));
    expect(await outagesMissingLateHours([lateVenue, venueId])).toEqual([]);
  });

  it("is a manager's action on the dashboard, for their own venue", async () => {
    const id = await legacy(late, day(20), day(20));
    const { GET, PATCH } = await import("../src/app/api/admin/outages/route");
    const manager = await createAdmin({ name: "Night manager", email: "night@midnight.my", password: "night-password-1", venueId: lateVenue });
    const other = await createAdmin({ name: "Day manager", email: "day@outage.my", password: "day-password-1", venueId });
    if (!manager.ok || !other.ok) throw new Error("admin");
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(manager.admin.id)).token}`;
    const otherCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(other.admin.id)).token}`;
    const seen = await (await GET(new NextRequest(`http://localhost/api/admin/outages?venueId=${lateVenue}`, { headers: { cookie } }))).json();
    expect(seen.lateHoursOpen).toEqual([id]);
    const patch = (as: string, body: unknown) =>
      PATCH(new NextRequest("http://localhost/api/admin/outages", { method: "PATCH", headers: { cookie: as, "content-type": "application/json" }, body: JSON.stringify(body) }));
    expect((await patch(otherCookie, { venueId: lateVenue, id })).status).toBe(403);
    const res = await patch(cookie, { venueId: lateVenue, id });
    expect(res.status).toBe(200);
    expect((await res.json()).repairs).toEqual([expect.objectContaining({ outageId: id, claimed: [{ start: 24 * 60, end: 26 * 60 }], collisions: [] })]);
    const after = await (await GET(new NextRequest(`http://localhost/api/admin/outages?venueId=${lateVenue}`, { headers: { cookie } }))).json();
    expect(after.lateHoursOpen).toEqual([]);
  });
});
