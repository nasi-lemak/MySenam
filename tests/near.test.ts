import { describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { listVenuePage, NEAR_DEFAULT_KM, NEAR_MAX_KM, readNear, searchAvailability } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Courts near me, or near a place: the four starter venues are pinned in
 * Petaling Jaya, Subang Jaya, Bangsar and Putrajaya.
 */

const BANGSAR = { lat: 3.146, lng: 101.67 };

describe("a point to search around", () => {
  it("is read from the address, in Malaysia, at most so far out", () => {
    expect(readNear("3.146,101.67", "5")).toEqual({ ...BANGSAR, km: 5 });
    expect(readNear("3.146, 101.67")).toEqual({ ...BANGSAR, km: NEAR_DEFAULT_KM });
    expect(readNear("3.146,101.67", "500")?.km).toBe(NEAR_MAX_KM);
    expect(readNear("51.5,-0.12")).toBeNull();
    expect(readNear("Bangsar")).toBeNull();
    expect(readNear(undefined)).toBeNull();
  });
});

describe("the venue list near somewhere", () => {
  it("has what is within reach, nearest first, with how far", async () => {
    const page = await listVenuePage({ near: { ...BANGSAR, km: 10 } });
    expect(page.venues.map((v) => v.name)).toEqual(["Bangsar Racquet Club", "Arena MySenam @ Petaling Jaya"]);
    expect(page.total).toBe(2);
    expect(page.venues[0].distanceKm).toBe(0);
    expect(page.venues[1].distanceKm).toBeGreaterThan(4);
    expect(page.venues[1].distanceKm).toBeLessThan(7);

    const wider = await listVenuePage({ near: { ...BANGSAR, km: 50 } });
    expect(wider.venues.map((v) => v.name).at(-1)).toBe("Putrajaya Lakeside Watersports");
  });
});

describe("searching near somewhere", () => {
  it("finds free courts within reach only, nearest first at each time", async () => {
    const date = addDays(todayISO(), 2);
    const results = await searchAvailability({ sport: "badminton", date, near: { ...BANGSAR, km: 15 } });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.distanceKm !== undefined && r.distanceKm <= 15)).toBe(true);
    const atTen = results.filter((r) => r.startHour === 10);
    const distances = atTen.map((r) => r.distanceKm!);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
  });

  it("through the route, needs a place in Malaysia", async () => {
    const { GET } = await import("../src/app/api/search/route");
    const ask = (q: string) => GET(new NextRequest(`http://localhost/api/search?sport=badminton&${q}`));
    expect((await ask("near=51.5,-0.12")).status).toBe(400);
    const res = await ask(`near=${BANGSAR.lat},${BANGSAR.lng}&km=10`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.needsArea).toBe(false);
    expect(new Set(body.results.map((r: { venue: { name: string } }) => r.venue.name))).not.toContain(
      "Putrajaya Lakeside Watersports"
    );
  });

  it("is in the venues API too", async () => {
    const { GET } = await import("../src/app/api/venues/route");
    const res = await GET(new NextRequest(`http://localhost/api/venues?near=${BANGSAR.lat},${BANGSAR.lng}&km=5`));
    const body = await res.json();
    expect(body.venues.map((v: { name: string }) => v.name)).toEqual(["Bangsar Racquet Club"]);
  });
});

describe("sorting a search", () => {
  const date = addDays(todayISO(), 1);
  const near = { ...BANGSAR, km: 50 };

  it("nearest keeps each venue's hours together, the closest venue first", async () => {
    const nearest = await searchAvailability({ sport: "badminton", date, near, sort: "nearest", limit: 200 });
    expect([...new Set(nearest.map((r) => r.venue.name))]).toEqual(["Arena MySenam @ Petaling Jaya", "SmashPoint Sports Centre"]);
    const firstOther = nearest.findIndex((r) => r.venue.name.startsWith("SmashPoint"));
    expect(nearest.slice(firstOther).every((r) => r.venue.name.startsWith("SmashPoint"))).toBe(true);
    // Still one row per venue and time, its cheapest court.
    expect(new Set(nearest.map((r) => `${r.venue.id}:${r.startHour}`)).size).toBe(nearest.length);
  });

  it("cheapest puts the cheapest hour first; nearest with nowhere to be near is soonest", async () => {
    const cheapest = await searchAvailability({ sport: "badminton", date, sort: "cheapest", limit: 200 });
    expect(cheapest[0].venue.name).toBe("SmashPoint Sports Centre");
    expect(cheapest.every((r, i) => i === 0 || cheapest[i - 1].totalPrice <= r.totalPrice)).toBe(true);
    const nowhere = await searchAvailability({ sport: "badminton", date, sort: "nearest" });
    expect(nowhere.every((r, i) => i === 0 || nowhere[i - 1].startHour <= r.startHour)).toBe(true);
  });

  it("through the route, asks for nearest only with a place, and says which it used", async () => {
    const { GET } = await import("../src/app/api/search/route");
    const without = await (await GET(new NextRequest(`http://localhost/api/search?sport=badminton&date=${date}&sort=nearest`))).json();
    expect(without.sort).toBe("soonest");
    const withPlace = await (
      await GET(new NextRequest(`http://localhost/api/search?sport=badminton&date=${date}&sort=nearest&near=3.146,101.67&km=50`))
    ).json();
    expect(withPlace.sort).toBe("nearest");
    expect(withPlace.results[0].venue.name).toBe("Arena MySenam @ Petaling Jaya");
    const odd = await (await GET(new NextRequest(`http://localhost/api/search?sport=badminton&date=${date}&sort=sideways`))).json();
    expect(odd.sort).toBe("soonest");
  });
});
