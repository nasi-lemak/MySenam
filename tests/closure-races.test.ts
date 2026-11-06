import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { createOutage } from "../src/lib/outages";
import { rainOut } from "../src/lib/rain-outs";
import {
  adminCancelBooking,
  cancelClassSession,
  claimWaitlistOffer,
  createBooking,
  createClassSessions,
  createCourt,
  enrolInClass,
  getClass,
  getClassRoster,
  joinClassWaitlist,
  joinSlotWaitlist,
  listVenues,
  listWaitlistFor,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { POST as closeDay } from "../src/app/api/admin/venues/[id]/closures/route";

/**
 * Closing time, and somebody booking, enrolling or claiming it at the same moment. Each of these is meant to be run
 * against real Postgres too (TEST_DATABASE_URL), where requests really overlap: whoever is first, nothing may be left
 * confirmed on time that was closed, and no confirmed enrolment in a class that was called off.
 */

let venueId: number;
let ownerId: number;
let cookie: string;
let seq = 0;
const phone = () => `01${String(60_000_000 + ++seq)}`;

beforeAll(async () => {
  await ensureBootstrapAdmin();
  ownerId = (await listAdmins())[0].id;
  venueId = (await listVenues())[0].id;
  const desk = await createAdmin({ name: "Desk", email: "desk@closure-races.my", password: "desk-password", venueId });
  if (!desk.ok) throw new Error("desk");
  cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
});

async function classOf(capacity: number, daysAhead: number) {
  seq++;
  const court = await createCourt({ venueId, name: `CR Studio ${seq}`, sport: "gym", offPeakRate: 5, peakRate: 8, capacity: 20 });
  if (!court.ok) throw new Error("court");
  const created = await createClassSessions({
    courtId: court.court.id,
    name: `CR Spin ${seq}`,
    instructor: "Ravi",
    date: addDays(todayISO(), daysAhead),
    startHour: 18,
    endHour: 19,
    capacity,
    price: 30,
  });
  if (!created.ok) throw new Error("class");
  return created.classes[0];
}

describe("a class called off while people enrol or claim a place", () => {
  it("an enrolment racing the class being called off never leaves a confirmed enrolment in a cancelled class", async () => {
    let bad = 0;
    for (let round = 0; round < 8; round++) {
      const cl = await classOf(15, 3 + round);
      for (let i = 0; i < 3; i++) await enrolInClass({ classId: cl.id, name: `Early${i}`, phone: phone() });
      await Promise.all([cancelClassSession(cl.id), ...Array.from({ length: 4 }, (_, i) => enrolInClass({ classId: cl.id, name: `Late${i}`, phone: phone() }))]);
      const s = await getClass(cl.id);
      const roster = await getClassRoster(cl.id);
      if (s!.status === "cancelled" && roster.some((b) => b.status === "confirmed")) bad++;
    }
    expect(bad).toBe(0);
  });

  it("an enrolment arriving after the class is called off is refused", async () => {
    const cl = await classOf(5, 20);
    expect((await cancelClassSession(cl.id)).ok).toBe(true);
    const late = await enrolInClass({ classId: cl.id, name: "Late", phone: phone() });
    expect(late).toMatchObject({ ok: false, code: "CLASS_CANCELLED" });
  });

  it("a waiting-list claim racing the class being called off never leaves a confirmed enrolment", async () => {
    let bad = 0;
    for (let round = 0; round < 8; round++) {
      const cl = await classOf(1, 3 + round);
      const a = await enrolInClass({ classId: cl.id, name: "A", phone: phone() });
      if (!a.ok) throw new Error("enrol");
      const waiterPhone = phone();
      await joinClassWaitlist({ classId: cl.id, name: "B", phone: waiterPhone });
      await adminCancelBooking(a.booking.code);
      const offer = (await listWaitlistFor(waiterPhone))[0];
      await Promise.all([claimWaitlistOffer(offer.offerToken!), cancelClassSession(cl.id)]);
      const s = await getClass(cl.id);
      const roster = await getClassRoster(cl.id);
      if (s!.status === "cancelled" && roster.some((b) => b.status === "confirmed")) bad++;
    }
    expect(bad).toBe(0);
  });
});

describe("a day closed while customers keep booking it", () => {
  it("leaves nothing confirmed on the closed day, whoever was first", async () => {
    let strays = 0;
    for (let round = 0; round < 8; round++) {
      const date = addDays(todayISO(), 20 + round);
      const court = await createCourt({ venueId, name: `CR Court ${round} ${++seq}`, sport: "badminton", offPeakRate: 10, peakRate: 10, capacity: 1 });
      if (!court.ok) throw new Error("court");
      const cl = await classOf(15, 20 + round);
      for (let i = 0; i < 4; i++) {
        await createBooking({ courtId: court.court.id, date, hours: [8 + i], name: `Early ${i}`, phone: phone() });
        await enrolInClass({ classId: cl.id, name: `Early ${i}`, phone: phone() });
      }
      const req = new NextRequest(`http://localhost/api/admin/venues/${venueId}/closures`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ date, reason: "Flood", cancelAffected: true }),
      });
      await Promise.all([
        closeDay(req, { params: Promise.resolve({ id: String(venueId) }) }),
        ...Array.from({ length: 6 }, (_, i) => createBooking({ courtId: court.court.id, date, hours: [12 + i], name: `Late ${i}`, phone: phone() })),
        ...Array.from({ length: 6 }, (_, i) => enrolInClass({ classId: cl.id, name: `Late ${i}`, phone: phone() })),
      ]);
      const left = (await getDb()
        .prepare("SELECT COUNT(*)::int AS n FROM bookings b JOIN courts c ON c.id = b.court_id WHERE c.venue_id = ? AND b.date = ? AND b.status = 'confirmed'")
        .get(venueId, date)) as { n: number };
      const closed = await getDb().prepare("SELECT 1 FROM venue_closures WHERE venue_id = ? AND date = ?").get(venueId, date);
      if (closed && left.n > 0) strays++;
    }
    expect(strays).toBe(0);
  });
});

describe("a rain-out while a waiter claims the hour", () => {
  it("leaves nobody confirmed in the rained-off hours", async () => {
    let strays = 0;
    for (let round = 0; round < 8; round++) {
      seq++;
      const court = await createCourt({ venueId, name: `CR Outdoor ${seq}`, sport: "tennis", offPeakRate: 30, peakRate: 40 });
      if (!court.ok) throw new Error("court");
      const date = addDays(todayISO(), 2 + round);
      const held = await createBooking({ courtId: court.court.id, date, hours: [16], name: "Holder", phone: phone() });
      if (!held.ok) throw new Error("booking");
      const waiterPhone = phone();
      expect((await joinSlotWaitlist({ courtId: court.court.id, date, startHour: 16, endHour: 17, name: "Waiter", phone: waiterPhone })).ok).toBe(true);
      // Somebody else cancels, so the waiter holds a live offer, and claims it just as the rain-out is declared.
      await adminCancelBooking(held.booking.code);
      const offer = (await listWaitlistFor(waiterPhone))[0];
      expect(offer.status).toBe("offered");
      await Promise.all([
        claimWaitlistOffer(offer.offerToken!),
        rainOut({ venueId, courtIds: [court.court.id], date, fromHour: 14, untilHour: 18, reason: "Thunderstorm" }),
      ]);
      const standing = await getDb()
        .prepare("SELECT 1 FROM bookings WHERE court_id = ? AND date = ? AND status = 'confirmed' AND start_min < ? AND end_min > ?")
        .get(court.court.id, date, 18 * 60, 14 * 60);
      if (standing) strays++;
    }
    expect(strays).toBe(0);
  });
});

describe("a court taken out of service while customers book it", () => {
  it("leaves nothing confirmed in the days it is out", async () => {
    let strays = 0;
    for (let round = 0; round < 6; round++) {
      seq++;
      const court = await createCourt({ venueId, name: `CR Outage ${seq}`, sport: "badminton", offPeakRate: 10, peakRate: 10, capacity: 1 });
      if (!court.ok) throw new Error("court");
      const date = addDays(todayISO(), 30 + round);
      for (let i = 0; i < 3; i++) await createBooking({ courtId: court.court.id, date, hours: [8 + i], name: `Early ${i}`, phone: phone() });
      const [made] = await Promise.all([
        createOutage({ courtId: court.court.id, startsOn: date, endsOn: date, adminId: ownerId, cancelAffected: true }),
        ...Array.from({ length: 5 }, (_, i) => createBooking({ courtId: court.court.id, date, hours: [12 + i], name: `Late ${i}`, phone: phone() })),
      ]);
      const outage = await getDb().prepare("SELECT 1 FROM court_outages WHERE court_id = ?").get(court.court.id);
      const standing = await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE court_id = ? AND date = ? AND status = 'confirmed'").get(court.court.id, date) as { n: number };
      // Either the court is out and nothing stands in it, or it said so (try again) and nothing was changed.
      if (outage && standing.n > 0) strays++;
      if (!outage) expect(made.ok).toBe(false);
    }
    expect(strays).toBe(0);
  });
});
