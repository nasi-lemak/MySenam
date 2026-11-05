import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { BUILTIN_ACTIVITIES } from "../src/lib/activity-catalogue";
import { activity, activityFilters, activityName, activityTerms, findActivities, isKnownActivity } from "../src/lib/activity-registry";
import { catalogue, createActivity, updateActivity } from "../src/lib/activities";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { updatePolicy } from "../src/lib/booking-policy";
import { getDb } from "../src/lib/db";
import { createResources, setCourtActivities } from "../src/lib/resources";
import {
  createBooking,
  createCourt,
  createVenue,
  getAvailability,
  getCourt,
  rescheduleBooking,
  activitiesByPopularity,
  searchAvailability,
  sportsOfferedAt,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { POST as activitiesPost } from "../src/app/api/admin/activities/route";
import { POST as courtsPost } from "../src/app/api/admin/courts/route";
import { GET as searchGet } from "../src/app/api/search/route";
import { GET as quoteGet } from "../src/app/api/quote/route";

/**
 * Activities as data (ADR 0011): what a resource is booked for is the
 * catalogue's, not the code's; a resource may offer several; operators add
 * their own; and every one of them is booked by the same engine, under the
 * same conflict protection, rules and prices.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (n: number) => addDays(todayISO(ZONE), n);
const at = (h: number, m = 0) => h * 60 + m;
let n = 0;
const phone = () => `0166660${String(++n).padStart(3, "0")}`;

let business: number;
let venueId: number;
let otherVenue: number;

beforeAll(async () => {
  business = ((await getDb().prepare("INSERT INTO businesses (name) VALUES ('Sports Hub Group') RETURNING id").get()) as { id: number }).id;
  const made = await createVenue({ name: "Sports Hub", area: "Cheras", address: "x", phone: "0312344444", openMin: at(7), closeMin: at(23) });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  await getDb().prepare("UPDATE venues SET business_id = ? WHERE id = ?").run(business, venueId);
  const other = await createVenue({ name: "Elsewhere", area: "Klang", address: "y", phone: "0312345555" });
  if (!other.ok) throw new Error("venue");
  otherVenue = other.venue.id;
});

describe("the catalogue", () => {
  it("has 32 built-in activities, each below full support saying what is not built", () => {
    expect(BUILTIN_ACTIVITIES).toHaveLength(32);
    const count = (level: string) => BUILTIN_ACTIVITIES.filter((a) => a.support === level).length;
    expect([count("full"), count("basic"), count("specialised")]).toEqual([28, 4, 0]);
    for (const a of BUILTIN_ACTIVITIES) if (a.support !== "full") expect(a.supportNote, a.key).toMatch(/Not built/);
  });

  it("holds every built-in, named in every language, and the code names none of them", async () => {
    const all = await catalogue();
    for (const b of BUILTIN_ACTIVITIES) {
      const a = all.find((x) => x.key === b.key);
      expect(a, b.key).toMatchObject({ builtin: true, active: true, category: b.category });
      for (const l of ["en", "ms", "zh", "ta"] as const) expect(a!.names[l], `${b.key} ${l}`).toBeTruthy();
      expect(["full", "basic", "specialised"]).toContain(a!.support);
      // Anything short of full says what is missing.
      if (a!.support !== "full") expect(a!.supportNote, b.key).toBeTruthy();
    }
    expect(all.length).toBeGreaterThanOrEqual(32);
  });

  it("is found by any name or alias, in any language", () => {
    expect(findActivities("ping pong")[0]).toBe("table_tennis");
    expect(findActivities("SUP")[0]).toBe("paddleboard");
    expect(findActivities("羽毛球")[0]).toBe("badminton");
    expect(findActivities("bola sepak")[0]).toBe("football");
    expect(findActivities("boulder")).toContain("bouldering");
    expect(findActivities("zzz")).toEqual([]);
  });

  it("names an activity as the country does", () => {
    expect(activityName("sepak_takraw", "en", "MY")).toBe("Sepak takraw");
    expect(activityName("sepak_takraw", "en", "TH")).toBe("Takraw");
    expect(activityTerms("sepak_takraw", "PH")).toContain("Sipa");
    // A language the activity has no name in falls back to English.
    expect(activityName("floorball", "xx")).toBe("Floorball");
  });

  it("keeps what the database says even when the code is ahead of it", async () => {
    // Every key in use is in the table, so no booking can name an activity that is not.
    await expect(
      getDb().prepare("INSERT INTO courts (venue_id, name, sport, off_peak_rate, peak_rate) VALUES (?, 'Ghost', 'not_a_sport', 1, 1)").run(venueId)
    ).rejects.toMatchObject({ code: "23503" });
  });
});

describe("operators' own activities", () => {
  it("are added without code, offered on their courts, and found in search like any other", async () => {
    const made = await createActivity(
      { names: { en: "Sky Yoga", ms: "Yoga Langit" }, category: "studio", model: "class", noun: "studio", capacity: 15, aliases: ["aerial yoga"] },
      { businessId: business, venueId: null, platform: false }
    );
    if (!made.ok) throw new Error(made.error);
    expect(made.activity).toMatchObject({ key: "sky_yoga", businessId: business, support: "basic" });
    expect(isKnownActivity("sky_yoga")).toBe(true);
    expect(findActivities("aerial")).toContain("sky_yoga");
    // Its name is one per owner: the platform's yoga is taken.
    expect(
      await createActivity({ names: { en: "Yoga" }, category: "studio", model: "class", noun: "studio" }, { businessId: business, venueId: null, platform: false })
    ).toMatchObject({ ok: false });

    const studio = await createCourt({ venueId, name: "Roof Studio", sport: "sky_yoga", offPeakRate: 30, peakRate: 30, capacity: 15 });
    expect(studio).toMatchObject({ ok: true, court: { sport: "sky_yoga" } });
    expect(await sportsOfferedAt([venueId])).toContain("sky_yoga");
    // Another business's venue cannot use it.
    expect(await createCourt({ venueId: otherVenue, name: "Copy", sport: "sky_yoga", offPeakRate: 1, peakRate: 1 })).toMatchObject({ ok: false });
  });

  it("can be retired: no new courts, but what was booked keeps its name", async () => {
    const owner = { businessId: business, venueId: null, platform: false };
    expect(await updateActivity("sky_yoga", { active: false }, owner)).toMatchObject({ ok: true, activity: { active: false } });
    expect(await createCourt({ venueId, name: "Studio 2", sport: "sky_yoga", offPeakRate: 30, peakRate: 30, capacity: 15 })).toMatchObject({ ok: false });
    expect(activityName("sky_yoga")).toBe("Sky Yoga");
    // Built-ins are the code's: an operator cannot change one.
    expect(await updateActivity("badminton", { active: false }, owner)).toMatchObject({ ok: false });
  });

  it("are made through the dashboard's route by managers, not the front desk", async () => {
    const manager = await createAdmin({ name: "M", email: "m@hub.my", password: "a long enough password", venueId });
    const desk = await createAdmin({ name: "D", email: "d@hub.my", password: "a long enough password", venueId, role: "desk" });
    if (!manager.ok || !desk.ok) throw new Error("admins");
    const post = async (id: number, body: unknown) =>
      activitiesPost(
        new NextRequest("http://localhost/api/admin/activities", {
          method: "POST",
          headers: { "content-type": "application/json", cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(id)).token}` },
          body: JSON.stringify(body),
        })
      );
    const body = { venueId, names: { en: "Teqball" }, category: "racket", model: "exclusive", noun: "table" };
    expect((await post(desk.admin.id, body)).status).toBe(403);
    const res = await post(manager.admin.id, body);
    expect(res.status).toBe(201);
    expect((await res.json()).activity).toMatchObject({ key: "teqball", category: "racket" });
  });
});

describe("a resource offering several activities", () => {
  let hall: number;

  beforeAll(async () => {
    const made = await createCourt({ venueId, name: "Hall A", sport: "badminton", offPeakRate: 20, peakRate: 20 });
    if (!made.ok) throw new Error(made.error);
    hall = made.court.id;
    // Pickleball on the same floor, at its own rates; volleyball at the hall's.
    expect(
      await setCourtActivities(hall, [{ sport: "pickleball", offPeakRate: 30, peakRate: 30 }, { sport: "volleyball" }])
    ).toMatchObject({ ok: true, court: { activities: [{ sport: "badminton" }, { sport: "pickleball", offPeakRate: 30 }, { sport: "volleyball", offPeakRate: null }] } });
    // Pickleball here starts on the half hour; badminton on the hour.
    expect(await updatePolicy({ court: hall, sport: "pickleball" }, { startEvery: 30, lengthStep: 30 })).toMatchObject({ ok: true });
  });

  it("shows under each activity, at that activity's rates and rules", async () => {
    const pickle = (await getAvailability(venueId, day(3), "pickleball")).find((c) => c.court.id === hall)!;
    expect(pickle.court).toMatchObject({ sport: "pickleball", offPeakRate: 30 });
    expect(pickle.starts.some((s) => s.minute === at(9, 30))).toBe(true);
    const bad = (await getAvailability(venueId, day(3), "badminton")).find((c) => c.court.id === hall)!;
    expect(bad.court).toMatchObject({ sport: "badminton", offPeakRate: 20 });
    expect(bad.starts.some((s) => s.minute === at(9, 30))).toBe(false);
  });

  it("is booked for one activity at a time: the floor is one resource", async () => {
    const pickle = await createBooking({ courtId: hall, sport: "pickleball", date: day(4), start: at(9, 30), end: at(10, 30), name: "P", phone: phone() });
    if (!pickle.ok) throw new Error(pickle.error);
    expect(pickle.booking).toMatchObject({ sport: "pickleball", totalPrice: 30 });
    // Badminton on the same floor at the same time is refused by the same constraint.
    expect(await createBooking({ courtId: hall, sport: "badminton", date: day(4), start: at(10), end: at(11), name: "B", phone: phone() })).toMatchObject({ ok: false });
    // Something the court does not offer is refused outright.
    expect(await createBooking({ courtId: hall, sport: "tennis", date: day(4), start: at(12), end: at(13), name: "T", phone: phone() })).toMatchObject({
      ok: false,
      code: "SPORT_NOT_HERE",
    });
  });

  it("is found by search under each activity it offers", async () => {
    const found = await searchAvailability({ sport: "volleyball", date: day(5), fromMin: at(9), toMin: at(9), venueIds: [venueId] });
    expect(found.map((r) => r.court.id)).toContain(hall);
  });

  it("will not drop an activity that is still booked", async () => {
    expect(await setCourtActivities(hall, [{ sport: "volleyball" }])).toMatchObject({ ok: false });
    // Its main activity is the database's to keep.
    await expect(getDb().prepare("DELETE FROM court_activities WHERE court_id = ? AND sport = 'badminton'").run(hall)).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("moves a booking only to courts offering what was booked", async () => {
    const other = await createCourt({ venueId, name: "Badminton 9", sport: "badminton", offPeakRate: 20, peakRate: 20 });
    if (!other.ok) throw new Error(other.error);
    const pickle = await createBooking({ courtId: hall, sport: "pickleball", date: day(6), start: at(15), end: at(16), name: "Q", phone: phone() });
    if (!pickle.ok) throw new Error(pickle.error);
    expect(await rescheduleBooking(pickle.booking.code, { date: day(6), start: at(17), courtId: other.court.id }, "staff")).toMatchObject({ ok: false });
    expect(await rescheduleBooking(pickle.booking.code, { date: day(6), start: at(17) }, "staff")).toMatchObject({ ok: true, booking: { courtId: hall, sport: "pickleball" } });
  });
});

describe("resources from templates", () => {
  it("makes lanes in one go, numbered on from any already there", async () => {
    const first = await createResources({ venueId, sport: "golf_simulator", count: 2, offPeakRate: 60, peakRate: 80 });
    if (!first.ok) throw new Error(first.error);
    expect(first.courts.map((c) => c.name)).toEqual(["Bay 1", "Bay 2"]);
    const more = await createResources({ venueId, sport: "golf_simulator", count: 1, offPeakRate: 60, peakRate: 80 });
    if (!more.ok) throw new Error(more.error);
    expect(more.courts.map((c) => c.name)).toEqual(["Bay 3"]);
    // "Any bay": the cheapest free one, by the same engine.
    const grid = await getAvailability(venueId, day(3), "golf_simulator");
    expect(grid).toHaveLength(3);
  });

  it("goes through the courts route with a count", async () => {
    const manager = await createAdmin({ name: "M2", email: "m2@hub.my", password: "a long enough password", venueId });
    if (!manager.ok) throw new Error("admin");
    const res = await courtsPost(
      new NextRequest("http://localhost/api/admin/courts", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(manager.admin.id)).token}` },
        body: JSON.stringify({ venueId, sport: "archery", count: 3, offPeakRate: 25, peakRate: 25, perPlayer: true, maxPlayers: 4 }),
      })
    );
    expect(res.status).toBe(201);
    const { courts } = await res.json();
    expect(courts.map((c: { name: string }) => c.name)).toEqual(["Lane 1", "Lane 2", "Lane 3"]);
    expect(courts[0]).toMatchObject({ perPlayer: true, maxPlayers: 4 });
  });
});

describe("hire and shared places", () => {
  let fleet: number;

  beforeAll(async () => {
    const made = await createResources({ venueId, sport: "paddleboard", name: "SUP fleet", offPeakRate: 25, peakRate: 25, capacity: 10, deposit: 50 });
    if (!made.ok) throw new Error(made.error);
    fleet = made.courts[0].id;
  });

  it("hires several at once, priced per board, never more than the fleet has", async () => {
    const four = await createBooking({ courtId: fleet, date: day(3), start: at(9), end: at(10), players: 4, name: "Four", phone: phone() });
    if (!four.ok) throw new Error(four.error);
    expect(four.booking).toMatchObject({ players: 4, totalPrice: 100 });
    // Six left: seven is refused, six is not.
    expect(await createBooking({ courtId: fleet, date: day(3), start: at(9, 30), end: at(10, 30), players: 7, name: "Seven", phone: phone() })).toMatchObject({ ok: false });
    expect((await createBooking({ courtId: fleet, date: day(3), start: at(9, 30), end: at(10, 30), players: 6, name: "Six", phone: phone() })).ok).toBe(true);
    // The database holds the same line: four and six places from 9:30.
    const held = (await getDb()
      .prepare("SELECT SUM(places)::int AS n FROM claims WHERE court_id = ? AND active AND kind = 'booking'")
      .get(fleet)) as { n: number };
    expect(held.n).toBe(10);
  });

  it("quotes per board, as many as one booking may take", async () => {
    const quote = async (players: number) =>
      (await (await quoteGet(new NextRequest(`http://localhost/api/quote?courtId=${fleet}&date=${day(8)}&start=${at(9)}&end=${at(10)}&players=${players}`))).json()) as {
        court: number;
      };
    expect((await quote(3)).court).toBe(75);
    // Asking for more is priced at what one booking can take: eight, unless the venue says otherwise.
    expect((await quote(50)).court).toBe(200);
  });
});

describe("the court row", () => {
  it("lists its activities as the database keeps them", async () => {
    const c = await createCourt({ venueId, name: "Net 1", sport: "cricket", offPeakRate: 40, peakRate: 40 });
    if (!c.ok) throw new Error(c.error);
    expect(c.court.activities).toEqual([{ sport: "cricket", offPeakRate: null, peakRate: null }]);
    await getDb().prepare("UPDATE courts SET sport = 'futsal' WHERE id = ?").run(c.court.id);
    // The new main one is offered, first; the old one stays offered until taken off.
    expect((await getCourt(c.court.id))!.activities.map((a) => a.sport)).toEqual(["futsal", "cricket"]);
    expect(activity("futsal").template.noun).toBe("court");
  });
});

describe("finding an activity in search", () => {
  beforeAll(async () => {
    const made = await createCourt({ venueId: otherVenue, name: "Takraw 1", sport: "sepak_takraw", offPeakRate: 15, peakRate: 15 });
    if (!made.ok) throw new Error(made.error);
  });

  it("takes the words people use for it", async () => {
    const res = await searchGet(new NextRequest(`http://localhost/api/search?q=takraw&date=${day(2)}&from=9&to=9`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sport).toBe("sepak_takraw");
    expect(body.results.map((r: { venue: { id: number } }) => r.venue.id)).toContain(otherVenue);
    // Words for nothing in the catalogue say so, rather than searching for something else.
    expect((await searchGet(new NextRequest(`http://localhost/api/search?q=quidditch&date=${day(2)}`))).status).toBe(404);
  });

  it("puts what is booked most around here first on the home page, and keeps search in the catalogue's order", async () => {
    // Takraw at the other venue is booked three times; badminton, offered at both, not at all there.
    for (const h of [9, 10, 11]) {
      const court = (await getAvailability(otherVenue, day(2), "sepak_takraw"))[0].court.id;
      expect((await createBooking({ courtId: court, date: day(2), start: at(h), end: at(h + 1), name: "T", phone: phone() })).ok).toBe(true);
    }
    const local = await activitiesByPopularity({ venueIds: [otherVenue] });
    expect(local[0]).toBe("sepak_takraw");
    // Where nothing is booked, more venues first, then the catalogue's order; nothing is left out.
    const everywhere = await sportsOfferedAt([venueId, otherVenue]);
    expect(new Set(await activitiesByPopularity({ venueIds: [venueId, otherVenue] }))).toEqual(new Set(everywhere));
    expect(everywhere.indexOf("badminton")).toBeLessThan(everywhere.indexOf("sepak_takraw"));
    // In an area with none of it, takraw is not pushed up by bookings elsewhere, but stays on the list.
    const cheras = await activitiesByPopularity({ venueIds: [venueId, otherVenue], area: "Cheras" });
    expect(cheras.indexOf("sepak_takraw")).toBeGreaterThan(cheras.indexOf("badminton"));
    expect(cheras).toContain("sepak_takraw");
  });

  it("offers the filters that mean something for the activity", () => {
    expect(activityFilters("swimming")).not.toContain("floodlit");
    expect(activityFilters("badminton")).toContain("aircon");
    expect(activityFilters("kayak")).toEqual([]);
  });
});
