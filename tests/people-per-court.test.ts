import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { setHouseRules } from "../src/lib/house-rules";
import { addManaged } from "../src/lib/managed-people";
import { bookingPlaces, createAtVenue } from "../src/lib/participants";
import { CUSTOMER, groupRequest, splitByCourt } from "../src/lib/people-per-court";
import { createResources } from "../src/lib/resources";
import { createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import * as bookingsRoute from "../src/app/api/bookings/route";

/**
 * What the booking page sends for people on a booking of several courts
 * (lib/people-per-court.ts groupRequest, as components/BookingBoard.tsx
 * sends it), taken by `POST /api/bookings` as it stands: each court books
 * its own people, a court nobody is named on is the party's, online and at
 * the counter alike. The shape is exactly the form's, built by the same code.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (k: number) => addDays(todayISO(ZONE), k);
const at = (h: number) => h * 60;
let n = 0;
const phone = () => `0199${String(++n).padStart(6, "0")}`;

let venue: number;
let c1: number;
let c2: number;
let c3: number;
let floorA: number;
let floorB: number;
let desk: { id: number; cookie: string };

async function adult(name: string) {
  const made = await registerUser({ name, email: `ppc${++n}@ppc.test`, phone: phone(), password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now'), verified_phone = phone WHERE id = ?").run(made.user.id);
  return { ...made.user, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}

async function child(parentId: number, displayName: string) {
  const made = await addManaged(parentId, { displayName, relationship: "parent", authority: true });
  if (!made.ok) throw new Error(made.error);
  return made.person.id;
}

const post = (cookie: string, body: Record<string, unknown>) =>
  bookingsRoute.POST(
    new NextRequest("http://localhost/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `10.99.${++n % 250}.${n % 200}`, cookie },
      body: JSON.stringify(body),
    })
  );

async function resource(name: string, sport: string, capacity = 1) {
  const r = await createResources({ venueId: venue, sport, name, offPeakRate: 20, peakRate: 20, capacity, ...(capacity > 1 ? { maxPlayers: capacity } : {}) });
  if (!r.ok) throw new Error(r.error);
  return r.courts[0].id;
}

beforeAll(async () => {
  const v = await createVenue({ name: "Court Split Centre", area: "Bangsar", address: "x", phone: "0312350601", openMin: at(7), closeMin: at(23) });
  if (!v.ok) throw new Error("venue");
  venue = v.venue.id;
  c1 = await resource("Court One", "badminton");
  c2 = await resource("Court Two", "badminton");
  c3 = await resource("Court Three", "badminton");
  floorA = await resource("Floor A", "gym", 6);
  floorB = await resource("Floor B", "gym", 6);
  expect((await setHouseRules(venue, { aheadDays: 45 })).ok).toBe(true);
  const made = await createAdmin({ name: "Desk Dina", email: `dina${++n}@ppc.test`, password: "a long enough password", venueId: venue, role: "desk" });
  if (!made.ok) throw new Error(made.error);
  desk = { id: made.admin.id, cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}` };
});

describe("the form's people per court, as the route takes them", () => {
  it("online: a child on each of two courts, the parent with one of them, the third court the party's", async () => {
    const mum = await adult("Mak Su");
    const aisha = await child(mum.id, "Aisha");
    const ben = await child(mum.id, "Ben");
    const people = groupRequest({ courtIds: [c1, c2, c3], named: [aisha, ben], customerTakesPart: true, courtOf: { [String(ben)]: c2, [CUSTOMER]: c2 } });
    expect(people).toEqual({ participantIds: [aisha], customerTakesPart: false, moreCourts: [{ courtId: c2, participantIds: [ben], customerTakesPart: true }, c3] });
    const res = await post(mum.cookie, { courtId: c1, date: day(3), start: at(9), end: at(10), name: mum.name, phone: mum.phone, ...people });
    expect(res.status).toBe(201);
    const { bookings } = (await res.json()) as { bookings: { id: number; courtId: number }[] };
    const on = (courtId: number) => bookingPlaces(bookings.find((b) => b.courtId === courtId)!.id);
    expect(await on(c1)).toEqual([{ customer: false, participantId: aisha, name: "Aisha" }]);
    expect(await on(c2)).toEqual([
      { customer: true, participantId: null, name: mum.name },
      { customer: false, participantId: ben, name: "Ben" },
    ]);
    expect(await on(c3)).toEqual([{ customer: true, participantId: null, name: null }]);
  });

  it("places on shared resources: at least one each for those put on them, as the form sends", async () => {
    const dad = await adult("Pak Ngah");
    const ali = await child(dad.id, "Ali");
    const badrul = await child(dad.id, "Badrul");
    const people = groupRequest({ courtIds: [floorA, floorB], named: [ali, badrul], customerTakesPart: false, courtOf: { [String(badrul)]: floorB }, places: { [floorB]: 2 } });
    expect(people).toEqual({ participantIds: [ali], customerTakesPart: false, moreCourts: [{ courtId: floorB, places: 2, participantIds: [badrul], customerTakesPart: false }] });
    const res = await post(dad.cookie, { courtId: floorA, date: day(4), start: at(9), end: at(10), name: dad.name, phone: dad.phone, ...people });
    expect(res.status).toBe(201);
    const held = (courtId: number) =>
      getDb()
        .prepare("SELECT COALESCE(SUM(c.places), 0)::int AS n FROM claims c JOIN bookings b ON b.id = c.booking_id WHERE c.court_id = ? AND c.active AND b.date = ?")
        .get(courtId, day(4)) as Promise<{ n: number }>;
    expect((await held(floorA)).n).toBe(1);
    expect((await held(floorB)).n).toBe(2);
  });

  it("at the counter: children the venue knows, each on their court, booked with their guardian's number", async () => {
    const ph = phone();
    const ids: number[] = [];
    for (const name of ["Chong", "Dahlia"]) {
      const made = await createAtVenue({ venueId: venue, admin: { id: desk.id, name: "Desk Dina" }, displayName: name, guardian: { name: "Puan Esah", phone: ph, relationship: "parent", authority: true } });
      if (!made.ok) throw new Error(made.error);
      ids.push(made.participant.id);
    }
    const people = groupRequest({ courtIds: [c1, c2], named: ids, customerTakesPart: false, courtOf: { [String(ids[1])]: c2 } });
    const res = await post(desk.cookie, { courtId: c1, date: day(5), start: at(9), end: at(10), name: "Puan Esah", phone: ph, ...people });
    expect(res.status).toBe(201);
    const { bookings } = (await res.json()) as { bookings: { id: number; courtId: number }[] };
    expect(await bookingPlaces(bookings.find((b) => b.courtId === c1)!.id)).toEqual([{ customer: false, participantId: ids[0], name: "Chong" }]);
    expect(await bookingPlaces(bookings.find((b) => b.courtId === c2)!.id)).toEqual([{ customer: false, participantId: ids[1], name: "Dahlia" }]);
  });

  it("never sends what the route refuses: each person on one court, the customer on one, a court outside the group means the first", () => {
    const split = splitByCourt({ courtIds: [c1, c2, c3], named: [7, 8, 9], customerTakesPart: true, courtOf: { "7": c2, "8": 999, [CUSTOMER]: c3 } });
    const everyone = split.flatMap((c) => c.participantIds);
    expect(everyone.sort()).toEqual([7, 8, 9]);
    expect(new Set(everyone).size).toBe(everyone.length);
    expect(split.find((c) => c.courtId === c1)!.participantIds).toEqual([8, 9]);
    // The customer was put on a court nobody is named on: that court is theirs as the party; they are beside nobody.
    expect(split.filter((c) => c.customerTakesPart)).toHaveLength(0);
    expect(split.find((c) => c.courtId === c3)!.participantIds).toEqual([]);
  });
});
