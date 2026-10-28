import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, getActingStaffByToken } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { mayShowVenue } from "../src/lib/listing";
import { createResources } from "../src/lib/resources";
import { createClassSessions, createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { base32Decode, confirmSetup, currentStep, startSetup, totpCode } from "../src/lib/two-factor";
import * as availabilityRoute from "../src/app/api/availability/route";
import * as adminBookings from "../src/app/api/admin/bookings/route";
import * as bookingsRoute from "../src/app/api/bookings/route";
import * as enrolRoute from "../src/app/api/classes/enrol/route";

/**
 * The install's two-factor rule (MYSENAM_STAFF_2FA) holds wherever a request
 * is treated as staff, not only in the admin routes: the counter booking and
 * enrolling through the public routes, staff-only rooms and the manager's
 * override in availability, and a preview of a venue not yet open. A staff
 * account that has not set two-factor sign-in up is told to, where it asks for
 * something only staff do, and is otherwise nobody's staff (lib/admin-auth.ts
 * `getActingStaff`).
 */

const ZONE = "Asia/Kuala_Lumpur";
const at = (h: number) => h * 60;
let n = 0;

let venueId: number;
let draftId: number;
let hall: number;
let studio: number;
let classId: number;
let adminId: number;
let token: string;
let cookie: string;
// Staff of the venue not open yet, signed in with a password only.
let draftAdminId: number;
let draftToken: string;

const req = (url: string, method: string, body?: unknown, as = cookie) =>
  new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.88.${++n % 250}.${n % 200}`, cookie: as },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const book = async (body: Record<string, unknown>) => {
  const res = await bookingsRoute.POST(req("http://localhost/api/bookings", "POST", body));
  return { status: res.status, body: await res.json() };
};
const enrol = async (body: Record<string, unknown>) => {
  const res = await enrolRoute.POST(req("http://localhost/api/classes/enrol", "POST", body));
  return { status: res.status, body: await res.json() };
};
const availability = async () => {
  const res = await availabilityRoute.GET(req(`http://localhost/api/availability?venueId=${venueId}&date=${addDays(todayISO(ZONE), 5)}`, "GET"));
  return (await res.json()) as { atCounter: boolean; mayOverride: boolean };
};
const bookingCount = async () => ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings").get()) as { n: number }).n;
const counterBooking = (h: number) => ({
  courtId: hall,
  date: addDays(todayISO(ZONE), 3),
  start: at(h),
  end: at(h + 1),
  name: "Walk In",
  phone: `0123${String(++n).padStart(6, "0")}`,
  paidAtCounter: "cash",
  override: true,
});

beforeAll(async () => {
  process.env.MYSENAM_STAFF_2FA = "all";
  const v = await createVenue({ name: "Gate Courts", area: "Ampang", address: "x", phone: "0312988001", openMin: at(7), closeMin: at(23) });
  const d = await createVenue({ name: "Draft Courts", area: "Ampang", address: "x", phone: "0312988002", openMin: at(7), closeMin: at(23), draft: true });
  if (!v.ok || !d.ok) throw new Error("venue");
  venueId = v.venue.id;
  draftId = d.venue.id;
  const r = await createResources({ venueId, sport: "badminton", name: "Court 1", offPeakRate: 20, peakRate: 20 });
  const s = await createResources({ venueId, sport: "gym", name: "Studio", offPeakRate: 20, peakRate: 20, capacity: 6, maxPlayers: 6 });
  if (!r.ok || !s.ok) throw new Error("resource");
  hall = r.courts[0].id;
  studio = s.courts[0].id;
  const made = await createClassSessions({ courtId: studio, name: "Circuit", instructor: "Coach", date: addDays(todayISO(ZONE), 6), start: at(18), end: at(19), capacity: 6, price: 15 });
  if (!made.ok) throw new Error(made.error);
  classId = made.classes[0].id;
  // A manager, signed in with a password only.
  const a = await createAdmin({ name: "Mgr", email: "gate-manager@x.my", password: "a long enough password", venueId, role: "manager" });
  const b = await createAdmin({ name: "Draft Mgr", email: "gate-draft@x.my", password: "a long enough password", venueId: draftId, role: "manager" });
  if (!a.ok || !b.ok) throw new Error("admin");
  adminId = a.admin.id;
  token = (await createAdminSession(adminId)).token;
  cookie = `${ADMIN_SESSION_COOKIE}=${token}`;
  draftAdminId = b.admin.id;
  draftToken = (await createAdminSession(draftAdminId)).token;
});

afterAll(() => {
  delete process.env.MYSENAM_STAFF_2FA;
});

describe("a staff account the install requires two-factor sign-in of, before it has set it up", () => {
  it("is refused by the admin routes, as before", async () => {
    const res = await adminBookings.GET(req(`http://localhost/api/admin/bookings?date=${todayISO(ZONE)}`, "GET"));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("TWO_FACTOR_REQUIRED");
  });

  it("cannot book at the counter past the rules or mark a booking paid through the public booking route", async () => {
    const before = await bookingCount();
    const both = await book(counterBooking(10));
    expect(both.status).toBe(403);
    expect(both.body.code).toBe("TWO_FACTOR_REQUIRED");
    const paidOnly = await book({ ...counterBooking(11), override: undefined });
    expect(paidOnly.status).toBe(403);
    expect(paidOnly.body.code).toBe("TWO_FACTOR_REQUIRED");
    expect(await bookingCount()).toBe(before);
  });

  it("cannot enrol somebody as paid at the counter", async () => {
    const res = await enrol({ classId, name: "Walk In", phone: "0123999001", paidAtCounter: "card" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("TWO_FACTOR_REQUIRED");
  });

  it("is not the counter in availability: no staff-only rooms, no override", async () => {
    expect(await availability()).toMatchObject({ atCounter: false, mayOverride: false });
  });

  it("does not preview a venue that is not open yet", async () => {
    expect((await mayShowVenue(draftId, req("http://localhost/venue", "GET", undefined, `${ADMIN_SESSION_COOKIE}=${draftToken}`))).show).toBe(false);
    expect(await getActingStaffByToken(draftToken)).toBeNull();
  });

  it("still books as anybody may, without staff powers", async () => {
    const res = await book({ courtId: hall, date: addDays(todayISO(ZONE), 4), start: at(9), end: at(10), name: "Mgr Herself", phone: "0123999002" });
    expect(res.status).toBe(201);
    expect(res.body.booking.paymentStatus).not.toBe("paid");
  });
});

describe("the same account, once it has set two-factor sign-in up", () => {
  beforeAll(async () => {
    for (const id of [adminId, draftAdminId]) {
      const setup = (await startSetup(id))!;
      const done = await confirmSetup(id, totpCode(base32Decode(setup.secret), currentStep()));
      if (!done.ok) throw new Error(done.error);
    }
  });

  it("acts as the counter on every one of these paths", async () => {
    const booked = await book(counterBooking(12));
    expect(booked.status).toBe(201);
    expect(booked.body.booking).toMatchObject({ paymentStatus: "paid", paidVia: "cash" });
    const enrolled = await enrol({ classId, name: "Walk In", phone: "0123999003", paidAtCounter: "card" });
    expect(enrolled.status).toBe(201);
    expect(await availability()).toMatchObject({ atCounter: true, mayOverride: true });
    expect((await mayShowVenue(draftId, req("http://localhost/venue", "GET", undefined, `${ADMIN_SESSION_COOKIE}=${draftToken}`))).show).toBe(true);
    expect((await getActingStaffByToken(draftToken))?.id).toBe(draftAdminId);
  });
});
