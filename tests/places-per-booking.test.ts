import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { createApiKey } from "../src/lib/api-keys";
import { registerUser } from "../src/lib/auth";
import { mostPerBookingAllowed, mostSpots, placesPerBooking } from "../src/lib/court-activities";
import { openGame } from "../src/lib/games";
import { createActivity } from "../src/lib/activities";
import { createResources } from "../src/lib/resources";
import { createBooking, createCourt, createGroupBooking, getCourt, listUserBookings, listVenues, updateCourt } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { DEFAULT_MAX_PLAYERS } from "../src/lib/types";
import { POST as book } from "../src/app/api/bookings/route";
import { POST as apiBook } from "../src/app/api/v1/bookings/route";

/**
 * How many places one booking may take: eight unless the venue sets more, up
 * to every place the resource has, and the same on every way of booking.
 */

let venueId: number;
let fleet: number; // 30 kayaks
let doubles: number; // 25 double kayaks
let futsal: number; // a pitch priced per player
const date = addDays(todayISO(), 4);
let n = 0;
const phone = () => `0177000${String(++n).padStart(3, "0")}`;

beforeAll(async () => {
  venueId = (await listVenues())[0].id;
  const made = await createResources({ venueId, sport: "kayak", name: "Single kayak", offPeakRate: 25, peakRate: 25, capacity: 30 });
  const two = await createResources({ venueId, sport: "kayak", name: "Double kayak", offPeakRate: 40, peakRate: 40, capacity: 25 });
  if (!made.ok || !two.ok) throw new Error(made.ok ? (two as { error: string }).error : made.error);
  fleet = made.courts[0].id;
  doubles = two.courts[0].id;
  const pitch = await createCourt({ venueId, name: "Pitch P", sport: "futsal", offPeakRate: 10, peakRate: 10 });
  if (!pitch.ok) throw new Error("pitch");
  futsal = pitch.court.id;
  expect((await updateCourt(futsal, { perPlayer: true })).ok).toBe(true);
  // The kayak template sets its own most per booking; start from none set.
  expect((await updateCourt(fleet, { maxPlayers: null })).ok).toBe(true);
  expect((await updateCourt(doubles, { maxPlayers: null })).ok).toBe(true);
});

const at = (hour: number) => ({ date, hours: [hour] });

describe("places per booking", () => {
  it("are eight by default, whatever the resource holds", async () => {
    const court = (await getCourt(fleet))!;
    expect(court.maxPlayers).toBeNull();
    expect(placesPerBooking(court)).toBe(DEFAULT_MAX_PLAYERS);
    expect(DEFAULT_MAX_PLAYERS).toBe(8);
    expect(await createBooking({ courtId: fleet, ...at(8), name: "Group", phone: phone(), players: 8 })).toMatchObject({ ok: true });
    expect(await createBooking({ courtId: fleet, ...at(9), name: "Group", phone: phone(), players: 9 })).toMatchObject({ ok: false, code: "PLAYERS_RANGE" });
  });

  it("can be raised by the venue, and a venue that permits 20 sells 20 in one booking on every path", async () => {
    expect(await updateCourt(fleet, { maxPlayers: 20 })).toMatchObject({ ok: true, court: { maxPlayers: 20 } });
    // The store, as every path reaches it.
    const direct = await createBooking({ courtId: fleet, ...at(10), name: "School trip", phone: phone(), players: 20 });
    expect(direct).toMatchObject({ ok: true, booking: { players: 20 } });
    expect(await createBooking({ courtId: fleet, ...at(11), name: "Too many", phone: phone(), players: 21 })).toMatchObject({ ok: false, code: "PLAYERS_RANGE" });

    // The booking form online (and the desk, which books through the same route).
    const res = await book(
      new NextRequest("http://localhost/api/bookings", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.7" },
        body: JSON.stringify({ courtId: fleet, date, start: 12 * 60, end: 13 * 60, name: "Kelab Kayak", phone: phone(), players: 20 }),
      })
    );
    expect(res.status).toBe(201);
    expect((await res.json()).booking).toMatchObject({ players: 20 });

    // The venue's own system, with a write key.
    const key = await createApiKey(venueId, { name: "Website", scope: "write" }, null);
    if (!key.ok) throw new Error("key");
    const api = await apiBook(
      new NextRequest("http://localhost/api/v1/bookings", {
        method: "POST",
        headers: { authorization: `Bearer ${key.key}`, "content-type": "application/json", "x-forwarded-for": "198.51.100.8" },
        body: JSON.stringify({ courtId: fleet, date, start: 13 * 60, end: 14 * 60, name: "Tour operator", phone: phone(), players: 20 }),
      })
    );
    expect(api.status).toBe(201);
    expect((await api.json()).booking).toMatchObject({ players: 20 });
    const tooMany = await apiBook(
      new NextRequest("http://localhost/api/v1/bookings", {
        method: "POST",
        headers: { authorization: `Bearer ${key.key}`, "content-type": "application/json", "x-forwarded-for": "198.51.100.8" },
        body: JSON.stringify({ courtId: fleet, date, start: 14 * 60, end: 15 * 60, name: "Tour operator", phone: phone(), players: 21 }),
      })
    );
    expect(tooMany.status).toBe(409);
    expect((await tooMany.json()).code).toBe("PLAYERS_RANGE");
  });

  it("take several kinds in one booking, each up to its own limit, all or nothing", async () => {
    expect((await updateCourt(doubles, { maxPlayers: 20 })).ok).toBe(true);
    const both = await createGroupBooking({ courtIds: [fleet, doubles], date, hours: [15], name: "Family day", phone: phone(), placesByCourt: { [fleet]: 20, [doubles]: 20 } });
    expect(both).toMatchObject({ ok: true });
    if (both.ok) expect(both.bookings.map((b) => b.players).sort()).toEqual([20, 20]);
    // Past one kind's limit, neither is booked.
    const over = await createGroupBooking({ courtIds: [fleet, doubles], date, hours: [16], name: "Family day", phone: phone(), placesByCourt: { [fleet]: 20, [doubles]: 21 } });
    expect(over).toMatchObject({ ok: false });
    expect(await createBooking({ courtId: fleet, ...at(16), name: "Then", phone: phone(), players: 20 })).toMatchObject({ ok: true });
  });

  it("are still held within the resource's places by the database", async () => {
    // 20 already out at 8 AM? 8 are; 20 more would be 28 of 30, and 3 more past it.
    expect(await createBooking({ courtId: fleet, ...at(8), name: "More", phone: phone(), players: 20 })).toMatchObject({ ok: true });
    expect(await createBooking({ courtId: fleet, ...at(8), name: "Past it", phone: phone(), players: 3 })).toMatchObject({ ok: false });
  });

  it("cannot be set above the resource's places, and follow them down when they shrink", async () => {
    expect(mostPerBookingAllowed(30)).toBe(30);
    expect(await updateCourt(fleet, { maxPlayers: 31 })).toMatchObject({ ok: false, error: "Up to 1 to 30 in one booking." });
    expect(await updateCourt(fleet, { maxPlayers: 30 })).toMatchObject({ ok: true, court: { maxPlayers: 30 } });
    // A resource made with a limit past its places is refused too.
    expect(await createResources({ venueId, sport: "kayak", name: "Canoe", offPeakRate: 20, peakRate: 20, capacity: 6, maxPlayers: 7 })).toMatchObject({
      ok: false,
      error: "Up to 1 to 6 in one booking.",
    });
    // An activity's template, the same.
    expect(
      await createActivity({ names: { en: "Dragon boat hire" }, category: "water", model: "hire", noun: "boat", capacity: 4, maxPlayers: 5 }, { businessId: null, venueId, platform: false })
    ).toMatchObject({ ok: false, error: "Up to 1 to 4 in one booking." });
    // Fewer places than the limit: the limit comes down with them.
    const small = await createResources({ venueId, sport: "kayak", name: "Spare kayaks", offPeakRate: 20, peakRate: 20, capacity: 12, maxPlayers: 12 });
    if (!small.ok) throw new Error(small.error);
    expect(await updateCourt(small.courts[0].id, { capacity: 5 })).toMatchObject({ ok: true, court: { capacity: 5, maxPlayers: 5 } });
  });

  it("on a court priced per player go up to fifty players", async () => {
    expect(placesPerBooking((await getCourt(futsal))!)).toBe(8);
    expect(await updateCourt(futsal, { maxPlayers: 14 })).toMatchObject({ ok: true });
    expect(await createBooking({ courtId: futsal, ...at(9), name: "Two teams", phone: phone(), players: 14 })).toMatchObject({ ok: true, booking: { players: 14 } });
    expect(await updateCourt(futsal, { maxPlayers: 51 })).toMatchObject({ ok: false, error: "Up to 2 to 50 in one booking." });
  });

  it("let an open game look for as many players as the booking may take", async () => {
    const host = await registerUser({ name: "Hakim Host", email: "host@places.my", phone: "0177999001", password: "a long enough password" });
    if (!host.ok) throw new Error(host.error);
    const made = await createBooking({ courtId: futsal, ...at(11), name: "Hakim Host", phone: "0177999001", userId: host.user.id, players: 2 });
    if (!made.ok) throw new Error(made.error);
    const court = (await getCourt(futsal))!;
    expect(mostSpots(court)).toBe(13);
    const mine = (await listUserBookings(host.user.id)).find((b) => b.code === made.booking.code)!;
    expect(mine.mostSpots).toBe(13);
    expect(await openGame(host.user.id, { bookingCode: made.booking.code, spots: 14, level: null, share: 0, autoAccept: true })).toMatchObject({
      ok: false,
      error: "Look for 1 to 13 players.",
    });
    expect(await openGame(host.user.id, { bookingCode: made.booking.code, spots: 13, level: null, share: 0, autoAccept: true })).toMatchObject({ ok: true });
    // A court that takes one booking whole, whoever plays, still looks for up to ten.
    expect(mostSpots({ capacity: 1, perPlayer: false, maxPlayers: null })).toBe(10);
  });
});
