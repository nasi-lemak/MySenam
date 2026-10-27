import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { checkIntegrity, checkIntegrityIfDue } from "../src/lib/integrity";
import { adminCancelBooking, createBooking, createClassSessions, createCourt, createVenue, enrolInClass } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { GET as integrityGet } from "../src/app/api/admin/integrity/route";

/**
 * The integrity check (lib/integrity.ts): every live booking holds its court
 * time, at the time and on the court it says, and nothing cancelled holds
 * any. The engine keeps them together; this proves the check would notice if
 * something went round it.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (n: number) => addDays(todayISO(ZONE), n);
let venueId: number;
let courtId: number;
let n = 0;
const book = async (start: number) => {
  const made = await createBooking({ courtId, date: day(2), start: start * 60, end: (start + 1) * 60, name: "I", phone: `0177770${String(++n).padStart(3, "0")}` });
  if (!made.ok) throw new Error(made.error);
  return made.booking;
};
const kinds = async () => (await checkIntegrity()).map((p) => p.kind).sort();

beforeAll(async () => {
  const v = await createVenue({ name: "Integrity Hall", area: "Ampang", address: "x", phone: "0312340001", openMin: 7 * 60, closeMin: 23 * 60 });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  const c = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!c.ok) throw new Error(c.error);
  courtId = c.court.id;
});

describe("the integrity check", () => {
  it("finds nothing where everything went through the engine", async () => {
    await book(9);
    // A place in a class holds no time of its own: the class holds the room.
    const studio = await createCourt({ venueId, name: "Studio", sport: "yoga", offPeakRate: 10, peakRate: 10, capacity: 12 });
    if (!studio.ok) throw new Error(studio.error);
    const made = await createClassSessions({ courtId: studio.court.id, name: "Flow", instructor: "Coach", date: day(3), startHour: 18, endHour: 19, capacity: 4, price: 10 });
    if (!made.ok) throw new Error(made.error);
    expect((await enrolInClass({ classId: made.classes[0].id, name: "Pupil", phone: "0177779999" })).ok).toBe(true);
    const cancelled = await book(10);
    expect((await adminCancelBooking(cancelled.code)).ok).toBe(true);
    expect(await checkIntegrity()).toEqual([]);
  });

  it("finds a booking that holds nothing, one held at the wrong time, and a cancelled one still holding", async () => {
    const unheld = await book(12);
    await getDb().prepare("UPDATE claims SET active = false WHERE booking_id = ?").run(unheld.id);
    const moved = await book(14);
    await getDb().prepare("UPDATE bookings SET start_min = start_min + 30 WHERE id = ?").run(moved.id);
    const gone = await book(16);
    await getDb().prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(gone.id);
    expect(await kinds()).toEqual(["booking_mistimed", "booking_unheld", "claim_orphaned"]);
    const problems = await checkIntegrity();
    expect(problems.find((p) => p.kind === "booking_unheld")).toMatchObject({ venueId, bookingId: unheld.id });
    // Put right, and the check is clean again.
    await getDb().prepare("UPDATE bookings SET status = 'cancelled' WHERE id IN (?, ?)").run(unheld.id, moved.id);
    await getDb().prepare("UPDATE claims SET active = false WHERE booking_id IN (?, ?)").run(moved.id, gone.id);
    expect(await checkIntegrity()).toEqual([]);
  });

  it("finds a booking for an activity its court has stopped offering", async () => {
    const b = await book(18);
    // Round the code, which refuses this while the booking stands.
    await getDb().prepare("UPDATE bookings SET sport = 'futsal' WHERE id = ?").run(b.id);
    expect(await kinds()).toEqual(["activity_not_offered"]);
    await getDb().prepare("UPDATE bookings SET sport = 'badminton' WHERE id = ?").run(b.id);
  });

  it("runs once a day from the scheduler", async () => {
    const now = new Date();
    expect(await checkIntegrityIfDue(now)).toEqual([]);
    expect(await checkIntegrityIfDue(new Date(now.getTime() + 3_600_000))).toBeNull();
    expect(await checkIntegrityIfDue(new Date(now.getTime() + 86_400_001))).toEqual([]);
  });

  it("is the platform owner's to ask for every venue, a manager's for their own, never front desk's", async () => {
    const other = await createVenue({ name: "Elsewhere Hall", area: "Ampang", address: "x", phone: "0312340002", openMin: 7 * 60, closeMin: 23 * 60 });
    if (!other.ok) throw new Error("venue");
    const otherCourt = await createCourt({ venueId: other.venue.id, name: "Court 9", sport: "badminton", offPeakRate: 20, peakRate: 20 });
    if (!otherCourt.ok) throw new Error(otherCourt.error);
    const there = await createBooking({ courtId: otherCourt.court.id, date: day(2), start: 9 * 60, end: 10 * 60, name: "E", phone: "0177771999" });
    if (!there.ok) throw new Error(there.error);
    const here = await book(20);
    const call = async (role: "owner" | "manager" | "desk", at: number | null = venueId) => {
      const admin = await createAdmin({
        name: role,
        email: `${role}${++n}@integrity.test`,
        password: "a long enough password",
        venueId: role === "owner" ? null : at,
        role: role === "desk" ? "desk" : "manager",
      });
      if (!admin.ok) throw new Error(admin.error);
      const { token } = await createAdminSession(admin.admin.id);
      return integrityGet(new NextRequest("http://localhost/api/admin/integrity", { headers: { cookie: `${ADMIN_SESSION_COOKIE}=${token}` } }));
    };
    // Nothing wrong anywhere: everybody allowed to ask hears so.
    expect(await (await call("manager")).json()).toEqual({ ok: true, problems: [] });
    expect(await (await call("owner")).json()).toEqual({ ok: true, problems: [] });
    // Round the code: each venue now has a booking that holds nothing.
    await getDb().prepare("UPDATE claims SET active = false WHERE booking_id IN (?, ?)").run(here.id, there.booking.id);
    const desk = await call("desk");
    expect(desk.status).toBe(403);
    expect((await desk.json()).code).toBe("MANAGER_ONLY");
    // A manager here: this venue's problem, never the other's.
    const mine = await call("manager");
    expect(mine.status).toBe(200);
    const seen = (await mine.json()) as { ok: boolean; problems: { venueId: number; bookingId?: number }[] };
    expect(seen.ok).toBe(false);
    expect(seen.problems.map((p) => p.bookingId)).toEqual([here.id]);
    expect(seen.problems.every((p) => p.venueId === venueId)).toBe(true);
    // The other venue's manager: theirs alone.
    const theirs = (await (await call("manager", other.venue.id)).json()) as { problems: { bookingId?: number }[] };
    expect(theirs.problems.map((p) => p.bookingId)).toEqual([there.booking.id]);
    // The platform owner: both.
    const all = (await (await call("owner")).json()) as { problems: { bookingId?: number }[] };
    expect(all.problems.map((p) => p.bookingId).sort((a, b) => a! - b!)).toEqual([here.id, there.booking.id].sort((a, b) => a - b));
    // A business running both: both, as its own.
    const business = ((await getDb().prepare("INSERT INTO businesses (name) VALUES ('Both Halls') RETURNING id").get()) as { id: number }).id;
    await getDb().prepare("UPDATE venues SET business_id = ? WHERE id IN (?, ?)").run(business, venueId, other.venue.id);
    const runs = await createAdmin({ name: "Runs both", email: `both${++n}@integrity.test`, password: "a long enough password", venueId: null, businessId: business });
    if (!runs.ok) throw new Error(runs.error);
    const both = await integrityGet(
      new NextRequest("http://localhost/api/admin/integrity", { headers: { cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(runs.admin.id)).token}` } })
    );
    expect(((await both.json()) as { problems: unknown[] }).problems).toHaveLength(2);
    // Scoped in the query itself: an empty scope looks for nothing.
    expect(await checkIntegrity([])).toEqual([]);
    expect((await checkIntegrity([other.venue.id])).map((p) => p.bookingId)).toEqual([there.booking.id]);
    await getDb().prepare("UPDATE bookings SET status = 'cancelled' WHERE id IN (?, ?)").run(here.id, there.booking.id);
    expect(await checkIntegrity()).toEqual([]);
  });
});
