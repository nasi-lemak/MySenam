import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { addAccess, setAccessSettings } from "../src/lib/access";
import { ADMIN_SESSION_COOKIE, authenticateAdmin, createAdminSession, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { houseRuleRefusal, houseRules, setHouseRules } from "../src/lib/house-rules";
import { customerMayBook } from "../src/lib/limits";
import { createBooking, createCourt, createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { POST as book } from "../src/app/api/bookings/route";
import { POST as createCourtRoute } from "../src/app/api/admin/courts/route";
import { POST as rulesPost } from "../src/app/api/admin/house-rules/route";

/**
 * A condominium's courts: free to book, and shared fairly — so many bookings
 * a week for each household, however many people live in it.
 */

let venueId: number;
let courtId: number;
let ownerId: number;
let ownerCookie: string;

/** The Monday at least a week ahead, so a whole Monday-to-Sunday week is in the window. */
function nextMonday(): string {
  let d = addDays(todayISO(), 1);
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = addDays(d, 1);
  return d;
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const owner = (await authenticateAdmin("admin@mysenam.my", "mysenam-admin"))!;
  ownerId = owner.id;
  ownerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(owner.id)).token}`;
  const made = await createVenue({ name: "Kondo Seri Courts", area: "Cheras", address: "x", phone: "0300000000" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const court = await createCourt({ venueId, name: "Tennis", sport: "tennis", offPeakRate: 0, peakRate: 0 });
  if (!court.ok) throw new Error("court");
  courtId = court.court.id;
});

describe("a free court", () => {
  it("can be made by staff, and its bookings owe nothing", async () => {
    const res = await createCourtRoute(
      new NextRequest("http://localhost/api/admin/courts", {
        method: "POST",
        headers: { cookie: ownerCookie },
        body: JSON.stringify({ venueId, name: "Pool lane", sport: "swimming", offPeakRate: 0, peakRate: 0 }),
      })
    );
    expect(res.status).toBe(201);
    const made = await createBooking({ courtId, date: addDays(todayISO(), 1), hours: [8], name: "Lee", phone: "0181110000" });
    expect(made.ok && made.booking.totalPrice).toBe(0);
  });

  it("does not count towards the cap on unpaid bookings", async () => {
    // The platform allows 3 unpaid bookings ahead at a venue; free ones are not unpaid.
    for (const h of [9, 10, 11, 12]) await createBooking({ courtId, date: addDays(todayISO(), 2), hours: [h], name: "Lee", phone: "0181110001" });
    expect(await customerMayBook({ venueId, phone: "0181110001", signedIn: false })).toBeNull();
  });
});

describe("house rules", () => {
  it("are saved, and refused when they make no sense", async () => {
    expect(await setHouseRules(venueId, { upcoming: "", perWeek: 2, perDay: 1, aheadDays: 7 })).toMatchObject({
      ok: true,
      rules: { upcoming: null, perWeek: 2, perDay: 1, aheadDays: 7 },
    });
    expect(await setHouseRules(venueId, { perWeek: 0 })).toMatchObject({ ok: false });
    expect(await setHouseRules(venueId, { aheadDays: 30 })).toMatchObject({ ok: false });
    expect(await houseRules(venueId)).toMatchObject({ perWeek: 2 });
  });

  it("limit a household — everyone in one unit — not just one number", async () => {
    await setHouseRules(venueId, { perWeek: 2, perDay: null, upcoming: null, aheadDays: null });
    await addAccess(
      venueId,
      [
        { phone: "0182220001", name: "Mother", label: "B-07-2" },
        { phone: "0182220002", name: "Son", label: "B-07-2" },
      ],
      ownerId
    );
    const monday = nextMonday();
    expect((await createBooking({ courtId, date: monday, hours: [20], name: "Mother", phone: "0182220001" })).ok).toBe(true);
    expect((await createBooking({ courtId, date: addDays(monday, 2), hours: [20], name: "Son", phone: "0182220002" })).ok).toBe(true);
    // The week is the unit's, whoever books it.
    expect(await houseRuleRefusal({ venueId, phone: "0182220002", dates: [addDays(monday, 4)] })).toMatchObject({
      code: "LIMIT_WEEK",
      vars: { n: 2 },
    });
    // The next week is free; a neighbour's allowance is their own.
    expect(await houseRuleRefusal({ venueId, phone: "0182220002", dates: [addDays(monday, 7)] })).toBeNull();
    expect(await houseRuleRefusal({ venueId, phone: "0189990000", dates: [addDays(monday, 4)] })).toBeNull();
  });

  it("limit bookings at once, a day, and how far ahead", async () => {
    await setHouseRules(venueId, { upcoming: 2, perDay: 1, perWeek: null, aheadDays: 3 });
    const phone = "0183330000";
    const day = addDays(todayISO(), 1);
    expect((await createBooking({ courtId, date: day, hours: [15], name: "A", phone })).ok).toBe(true);
    expect(await houseRuleRefusal({ venueId, phone, dates: [day] })).toMatchObject({ code: "LIMIT_DAY" });
    expect(await houseRuleRefusal({ venueId, phone, dates: [addDays(todayISO(), 5)] })).toMatchObject({ code: "LIMIT_AHEAD", vars: { n: 3 } });
    expect((await createBooking({ courtId, date: addDays(day, 1), hours: [15], name: "A", phone })).ok).toBe(true);
    expect(await houseRuleRefusal({ venueId, phone, dates: [addDays(day, 2)] })).toMatchObject({ code: "LIMIT_UPCOMING" });
    // A weekly series is all its weeks.
    expect(await houseRuleRefusal({ venueId, phone: "0183339999", dates: [day, addDays(day, 7), addDays(day, 14)] })).toMatchObject({
      code: "LIMIT_AHEAD",
    });
  });

  it("follow the account as well as the number typed on the booking", async () => {
    await setHouseRules(venueId, { upcoming: 1, perDay: null, perWeek: null, aheadDays: null });
    const user = await registerUser({ name: "Rina", email: "rina@example.com", phone: "0184440000", password: "password-123" });
    if (!user.ok) throw new Error(user.error);
    const cookie = `${SESSION_COOKIE}=${(await createSession(user.user.id)).token}`;
    const post = (phone: string, hour: number) =>
      book(
        new NextRequest("http://localhost/api/bookings", {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ courtId, date: addDays(todayISO(), 3), hours: [hour], name: "Rina", phone }),
        })
      );
    expect((await post("0184440000", 16)).status).toBe(201);
    // Another number typed in does not buy another booking.
    const second = await post("0184449999", 17);
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ code: "LIMIT_UPCOMING" });
  });

  it("are set by the venue's staff", async () => {
    await setAccessSettings(venueId, { access: "public" });
    const res = await rulesPost(
      new NextRequest("http://localhost/api/admin/house-rules", {
        method: "POST",
        headers: { cookie: ownerCookie },
        body: JSON.stringify({ venueId, upcoming: 3, perWeek: "", perDay: "", aheadDays: "" }),
      })
    );
    expect(await res.json()).toEqual({ rules: { upcoming: 3, perWeek: null, perDay: null, aheadDays: null } });
    const anonymous = await rulesPost(
      new NextRequest("http://localhost/api/admin/house-rules", { method: "POST", body: JSON.stringify({ venueId }) })
    );
    expect(anonymous.status).toBe(401);
  });
});
