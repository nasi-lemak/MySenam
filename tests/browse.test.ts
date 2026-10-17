import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { getDb } from "../src/lib/db";
import {
  countSearchCourts,
  createCourt,
  createVenue,
  listAreaCounts,
  listAreas,
  listVenuePage,
  listVenues,
  SEARCH_COURT_LIMIT,
  searchAvailability,
  sportsOfferedAt,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Browsing a marketplace with thousands of venues.
 *
 * The venue list and the search used to read every venue and every court on
 * every request. Measured with two thousand venues, the home page was 4 MB and
 * stopped answering under load, and a search with no area took eight seconds.
 * These hold the shape that replaced it: a page at a time, by area, and a
 * search that asks where before it looks everywhere.
 */

const get = (path: string) => new NextRequest(`http://localhost${path}`);

beforeAll(async () => {
  // Sixty more venues across three new areas, five badminton courts each,
  // written in one go rather than through the front door: this is about the
  // shape of a big list, not about making venues.
  const db = getDb();
  await db
    .prepare(
      `INSERT INTO venues (name, area, address, phone)
       SELECT 'Hall ' || lpad(g::text, 3, '0'), 'Zone ' || (g % 3), 'Somewhere', '0300000000'
         FROM generate_series(1, 60) g`
    )
    .run();
  await db
    .prepare(
      `INSERT INTO courts (venue_id, name, sport, off_peak_rate, peak_rate)
       SELECT v.id, 'Court ' || c, 'badminton', 15, 25
         FROM venues v, generate_series(1, 5) c WHERE v.name LIKE 'Hall %'`
    )
    .run();
});

describe("the venue list", () => {
  it("comes a page at a time, with how many there are in all", async () => {
    const first = await listVenuePage({ pageSize: 25 });
    const everyone = (await listVenues()).length;
    expect(first.total).toBe(everyone);
    expect(first.venues).toHaveLength(25);
    const last = await listVenuePage({ pageSize: 25, page: Math.ceil(everyone / 25) });
    expect(last.venues.length).toBe(everyone - 25 * (last.page - 1));
    // Each venue still comes with its courts.
    expect(first.venues.every((v) => v.courts.length > 0)).toBe(true);
    // And no venue is on two pages.
    const second = await listVenuePage({ pageSize: 25, page: 2 });
    const ids = new Set(first.venues.map((v) => v.id));
    expect(second.venues.some((v) => ids.has(v.id))).toBe(false);
  });

  it("narrows to an area, or a sport", async () => {
    const zone = await listVenuePage({ area: "Zone 1", pageSize: 100 });
    expect(zone.total).toBe(20);
    expect(zone.venues.every((v) => v.area === "Zone 1")).toBe(true);
    const futsal = await listVenuePage({ sport: "futsal", pageSize: 100 });
    expect(futsal.venues.every((v) => v.courts.some((c) => c.sport === "futsal"))).toBe(true);
    expect(futsal.total).toBeLessThan(zone.total);
  });

  it("counts venues by area", async () => {
    const areas = await listAreaCounts();
    expect(areas.find((a) => a.area === "Zone 2")?.venues).toBe(20);
    expect(areas.reduce((n, a) => n + a.venues, 0)).toBe((await listVenues()).length);
  });

  it("knows which sports are played, everywhere or at some venues", async () => {
    const zone = (await listVenuePage({ area: "Zone 0", pageSize: 1 })).venues[0];
    expect(await sportsOfferedAt([zone.id])).toEqual(["badminton"]);
    expect((await sportsOfferedAt()).length).toBeGreaterThan(1);
  });

  it("leaves out a venue with nothing to book yet, until its first court", async () => {
    const made = await createVenue({ name: "Not Ready Hall", area: "Empty Town", address: "Somewhere 1", phone: "0300000001" });
    if (!made.ok) throw new Error("venue");
    const listed = async () => (await listVenuePage({ pageSize: 100, area: "Empty Town" })).total;
    expect(await listed()).toBe(0);
    expect((await listAreaCounts()).some((a) => a.area === "Empty Town")).toBe(false);
    expect(await listAreas()).not.toContain("Empty Town");

    await createCourt({ venueId: made.venue.id, name: "Court 1", sport: "badminton", offPeakRate: 10, peakRate: 10 });
    expect(await listed()).toBe(1);
    expect(await listAreas()).toContain("Empty Town");
  });

  it("is what /api/venues answers, a page at a time", async () => {
    const { GET } = await import("../src/app/api/venues/route");
    const page = await (await GET(get("/api/venues?area=Zone%202&pageSize=7&page=2"))).json();
    expect(page.venues).toHaveLength(7);
    expect(page.total).toBe(20);
    expect(page.page).toBe(2);
    // Never more than 100 at once, whatever is asked for.
    expect((await (await GET(get("/api/venues?pageSize=5000"))).json()).pageSize).toBe(100);
    expect((await GET(get("/api/venues?sport=curling"))).status).toBe(400);
  });
});

describe("a venue with many courts", () => {
  it("gets one place in search per time, however many courts it adds", async () => {
    const date = addDays(todayISO(), 3);
    const [hall] = (await listVenuePage({ area: "Zone 0", pageSize: 1 })).venues;
    const results = await searchAvailability({ sport: "badminton", date, area: "Zone 0", fromHour: 10, toHour: 10 });
    const forHall = results.filter((r) => r.venue.id === hall.id);
    expect(forHall).toHaveLength(1);
    // Its other free courts are counted, not listed.
    expect(forHall[0].alsoFree).toBe(hall.courts.filter((c) => c.sport === "badminton").length - 1);
    // Every venue in the area still has its turn.
    expect(new Set(results.map((r) => r.venue.id)).size).toBe(20);
  });
});

describe("searching a big marketplace", () => {
  const date = addDays(todayISO(), 2);

  beforeAll(async () => {
    // Enough courts that a search with no area is past the limit.
    await getDb()
      .prepare(
        `INSERT INTO courts (venue_id, name, sport, off_peak_rate, peak_rate)
         SELECT v.id, 'Extra ' || c, 'badminton', 15, 25
           FROM venues v, generate_series(1, 6) c WHERE v.name LIKE 'Hall %'`
      )
      .run();
    expect(await countSearchCourts({ sport: "badminton" })).toBeGreaterThan(SEARCH_COURT_LIMIT);
  });

  it("asks for an area before looking at every court in the country", async () => {
    const { GET } = await import("../src/app/api/search/route");
    const res = await (await GET(get(`/api/search?sport=badminton&date=${date}`))).json();
    expect(res.needsArea).toBe(true);
    expect(res.results).toEqual([]);
    // The areas to choose from still come back.
    expect(res.areas).toContain("Zone 1");
  });

  it("searches an area as before", async () => {
    const { GET } = await import("../src/app/api/search/route");
    const res = await (await GET(get(`/api/search?sport=badminton&date=${date}&area=Zone%201`))).json();
    expect(res.needsArea).toBe(false);
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results.every((r: { venue: { area: string } }) => r.venue.area === "Zone 1")).toBe(true);
  });

  it("still searches everywhere when everywhere is small", async () => {
    const { GET } = await import("../src/app/api/search/route");
    // Futsal is played at only a few venues, so all of them is cheap.
    const res = await (await GET(get(`/api/search?sport=futsal&date=${date}`))).json();
    expect(res.needsArea).toBe(false);
    expect(res.results.length).toBeGreaterThan(0);
  });
});
