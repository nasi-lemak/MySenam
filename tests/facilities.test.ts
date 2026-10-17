import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import {
  cleanAmenities,
  highlights,
  readFacilityFilters,
  summariseCourts,
} from "../src/lib/facilities";
import { getVenue, listVenuePage, listVenues, searchAvailability, setCourtFeatures, setVenueAmenities } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/** What venues offer and what their courts are like: shown, compared and searched by. */

let cookie: string;

beforeAll(async () => {
  await ensureBootstrapAdmin();
  cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession((await listAdmins())[0].id)).token}`;
});

describe("the vocabulary", () => {
  it("keeps only known facilities, once each, in the list's order", () => {
    expect(cleanAmenities(["wifi", "showers", "jacuzzi", "showers", 7])).toEqual(["showers", "wifi"]);
    expect(cleanAmenities(null)).toEqual([]);
    expect(readFacilityFilters("aircon,showers,parking,nonsense,aircon")).toEqual({ amenities: ["showers", "parking"], courts: ["aircon"] });
    expect(readFacilityFilters(null)).toEqual({ amenities: [], courts: [] });
  });

  it("works out per sport how many courts, from what price, and what they are like", () => {
    const court = (sport: "badminton" | "tennis", rate: number, f: Partial<{ setting: "indoor" | "outdoor"; aircon: boolean; floodlit: boolean; surface: "mat" | "hard" }>) => ({
      sport,
      offPeakRate: rate,
      setting: f.setting ?? null,
      aircon: f.aircon ?? false,
      floodlit: f.floodlit ?? false,
      surface: f.surface ?? null,
    });
    const summary = summariseCourts([
      court("badminton", 15, { setting: "indoor", aircon: true, surface: "mat" }),
      court("badminton", 12, { setting: "indoor", surface: "mat" }),
      court("tennis", 30, { setting: "outdoor", floodlit: true, surface: "hard" }),
    ]);
    expect(summary).toEqual([
      { sport: "badminton", courts: 2, from: 12, indoor: 2, outdoor: 0, aircon: 1, floodlit: 0, surfaces: ["mat"] },
      { sport: "tennis", courts: 1, from: 30, indoor: 0, outdoor: 1, aircon: 0, floodlit: 1, surfaces: ["hard"] },
    ]);
  });

  it("puts what players look for first on a card, four at most", () => {
    const aircon = { setting: "indoor" as const, aircon: true, floodlit: false, surface: null };
    const indoor = { ...aircon, aircon: false };
    expect(highlights([aircon], ["wifi", "surau", "showers", "transit", "free_parking"]).map((h) => h.key)).toEqual([
      "aircon",
      "showers",
      "free_parking",
      "surau",
    ]);
    expect(highlights([indoor], []).map((h) => h.key)).toEqual(["indoor"]);
    expect(highlights([], [])).toEqual([]);
  });
});

describe("the starter venues", () => {
  it("come described", async () => {
    const arena = (await listVenues()).find((v) => v.name.startsWith("Arena"))!;
    expect(arena.amenities).toContain("showers");
    expect(arena.courts.find((c) => c.sport === "badminton")).toMatchObject({ setting: "indoor", aircon: true, surface: "mat" });
  });
});

describe("searching by them", () => {
  it("finds venues with every facility asked for, parking free or paid", async () => {
    const all = await listVenuePage({ pageSize: 100 });
    const showers = await listVenuePage({ amenities: ["showers"], pageSize: 100 });
    expect(showers.venues.every((v) => v.amenities.includes("showers"))).toBe(true);
    expect(showers.total).toBeLessThan(all.total);
    const parking = await listVenuePage({ amenities: ["parking"], pageSize: 100 });
    expect(parking.venues.every((v) => v.amenities.includes("free_parking") || v.amenities.includes("paid_parking"))).toBe(true);
    const both = await listVenuePage({ amenities: ["parking", "surau", "showers"], pageSize: 100 });
    expect(both.venues.map((v) => v.name).sort()).toEqual(["Arena MySenam @ Petaling Jaya", "SmashPoint Sports Centre"]);
  });

  it("finds courts with the feature asked for, of the sport asked for", async () => {
    // Air-con pickleball: Arena and Bangsar; air-con tennis: nowhere.
    const pickleball = await listVenuePage({ sport: "pickleball", courtFilters: ["aircon"], pageSize: 100 });
    expect(pickleball.venues.map((v) => v.name).sort()).toEqual(["Arena MySenam @ Petaling Jaya", "Bangsar Racquet Club"]);
    expect((await listVenuePage({ sport: "tennis", courtFilters: ["aircon"] })).total).toBe(0);
    expect((await listVenuePage({ sport: "tennis", courtFilters: ["floodlit", "outdoor"] })).total).toBe(2);

    const date = addDays(todayISO(), 1);
    const any = await searchAvailability({ sport: "badminton", date });
    const cool = await searchAvailability({ sport: "badminton", date, courtFilters: ["aircon"] });
    expect(any.some((r) => !r.court.aircon)).toBe(true);
    expect(cool.length).toBeGreaterThan(0);
    expect(cool.every((r) => r.court.aircon && r.venue.amenities.length > 0)).toBe(true);
    expect(await searchAvailability({ sport: "badminton", date, amenities: ["wheelchair"] })).toEqual([]);
  });
});

describe("staff", () => {
  const patch = async (path: string, mod: { PATCH: (req: NextRequest, ctx: never) => Promise<Response> }, id: number, body: object) =>
    mod.PATCH(
      new NextRequest(`http://localhost${path}`, { method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }),
      { params: Promise.resolve({ id: String(id) }) } as never
    );

  it("tick facilities from the list, and nothing else", async () => {
    const venues = await import("../src/app/api/admin/venues/[id]/route");
    const lakeside = (await listVenues()).find((v) => v.name.startsWith("Putrajaya"))!;
    expect((await patch("/api/admin/venues/x", venues, lakeside.id, { amenities: ["showers", "hot tub"] })).status).toBe(400);
    expect((await patch("/api/admin/venues/x", venues, lakeside.id, { amenities: "showers" })).status).toBe(400);
    const ok = await patch("/api/admin/venues/x", venues, lakeside.id, { amenities: ["wifi", "showers"] });
    expect(ok.status).toBe(200);
    expect((await ok.json()).venue.amenities).toEqual(["showers", "wifi"]);
    await setVenueAmenities(lakeside.id, []);
    expect((await getVenue(lakeside.id))?.amenities).toEqual([]);
  });

  it("say what each court is like", async () => {
    const courts = await import("../src/app/api/admin/courts/[id]/route");
    const court = (await listVenues()).find((v) => v.name.startsWith("Bangsar"))!.courts[0];
    expect((await patch("/api/admin/courts/x", courts, court.id, { setting: "underwater" })).status).toBe(400);
    expect((await patch("/api/admin/courts/x", courts, court.id, { surface: "lava" })).status).toBe(400);
    expect((await patch("/api/admin/courts/x", courts, court.id, { aircon: "yes" })).status).toBe(400);
    const ok = await patch("/api/admin/courts/x", courts, court.id, { setting: "indoor", aircon: true, surface: "clay" });
    expect((await ok.json()).court).toMatchObject({ setting: "indoor", aircon: true, surface: "clay", floodlit: true });
    // With other changes, both are saved; a refused change saves neither.
    const both = await patch("/api/admin/courts/x", courts, court.id, { name: "Centre Court", floodlit: false });
    expect((await both.json()).court).toMatchObject({ name: "Centre Court", floodlit: false });
    expect((await patch("/api/admin/courts/x", courts, court.id, { offPeakRate: -5, aircon: false })).status).toBeGreaterThanOrEqual(400);
    expect((await getVenue(court.venueId))!.courts[0].aircon).toBe(true);
    expect(await setCourtFeatures(999999, { aircon: true })).toBeNull();
  });
});
