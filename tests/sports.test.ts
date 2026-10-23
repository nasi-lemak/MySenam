import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { getDb } from "../src/lib/db";
import { LOCALES } from "../src/lib/i18n";
import { activity, activityName, activityIcon, activityKeys } from "../src/lib/activity-registry";
import {
  createBooking,
  createCourt,
  createVenue,
  searchAvailability,
  sportsOfferedAt,
} from "../src/lib/store";
import { updatePolicy, usualMinutes } from "../src/lib/booking-policy";
import { addDays, todayISO } from "../src/lib/time";
import { type Sport } from "../src/lib/types";
import { GET as searchGet } from "../src/app/api/search/route";
import { GET as sportsGet } from "../src/app/api/sports/route";

/**
 * The sports a court can be: the racquet and team sports Malaysian and
 * Singaporean venues sell, padel among them in its 90-minute games, from any
 * half hour wherever it is unless the venue says otherwise (ADR 0010).
 */

const ADDED: Sport[] = ["padel", "squash", "table_tennis", "football", "basketball", "volleyball", "netball", "sepak_takraw"];
const date = addDays(todayISO(), 2);
let n = 0;
const phone = () => `0177770${String(++n).padStart(3, "0")}`;

let halfHourVenue: number;
let hourVenue: number;
let padel: number;

beforeAll(async () => {
  await getDb().prepare("UPDATE venues SET published_at = NULL").run();
  const venue = async (name: string) => {
    const made = await createVenue({ name, area: "Mont Kiara", address: "x", phone: `03${String(++n).padStart(8, "0")}`, openMin: 8 * 60, closeMin: 23 * 60 });
    if (!made.ok) throw new Error("venue");
    await getDb().prepare("UPDATE venues SET published_at = datetime('now') WHERE id = ?").run(made.venue.id);
    return made.venue.id;
  };
  halfHourVenue = await venue("Padel & Shuttle");
  hourVenue = await venue("Old Hall");
  expect(await updatePolicy({ venue: halfHourVenue }, { startEvery: 30, lengthStep: 30 })).toMatchObject({ ok: true });
  const court = async (venueId: number, name: string, sport: Sport) => {
    const c = await createCourt({ venueId, name, sport, offPeakRate: 80, peakRate: 80 });
    if (!c.ok) throw new Error(c.error);
    return c.court.id;
  };
  padel = await court(halfHourVenue, "Padel 1", "padel");
  await court(halfHourVenue, "Badminton 1", "badminton");
  await court(hourVenue, "Padel A", "padel");
});

describe("the sports", () => {
  it("each have a name and an icon, and a name in every language", () => {
    expect(activityKeys()).toEqual(expect.arrayContaining(ADDED));
    for (const s of activityKeys()) {
      expect(activityName(s)).toBeTruthy();
      expect(activityIcon(s)).toBeTruthy();
      for (const locale of LOCALES) expect(activity(s).names[locale], `${locale} ${s}`).toBeTruthy();
    }
    expect(activityName("football", "ms")).toBe("Bola sepak");
    expect(activityName("table_tennis", "zh")).toBe("乒乓球");
  });

  it("can each be a court, and court sports say what they are played on", async () => {
    for (const s of ADDED) {
      const made = await createCourt({ venueId: hourVenue, name: `${activityName(s)} court`, sport: s, offPeakRate: 30, peakRate: 40 });
      expect(made, s).toMatchObject({ ok: true, court: { sport: s } });
    }
    // Table tennis is played on a table, not a surface worth naming.
    expect(ADDED.filter((s) => !activity(s).surfaced)).toEqual(["table_tennis"]);
  });

  it("are offered only where somebody has a court for them, in the catalogue's order", async () => {
    const here = await sportsOfferedAt([halfHourVenue]);
    expect(here).toEqual(["badminton", "padel"]);
    const res = await sportsGet(new NextRequest("http://localhost/api/sports"));
    const { sports } = (await res.json()) as { sports: Sport[] };
    expect(sports).toEqual(expect.arrayContaining(ADDED));
    expect(sports).toEqual(activityKeys().filter((s) => sports.includes(s)));
  });
});

describe("padel's 90 minutes", () => {
  it("are what search asks for when padel is picked; other sports an hour", () => {
    expect(usualMinutes("padel")).toBe(90);
    expect(usualMinutes("badminton")).toBe(60);
    expect(usualMinutes("football")).toBe(60);
  });

  it("are found at a venue selling half hours, starting on the hour and the half hour", async () => {
    const found = await searchAvailability({ sport: "padel", date, venueIds: [halfHourVenue], fromHour: 9, toHour: 11, duration: 1.5 });
    expect(found.every((r) => r.court.id === padel && r.endHour - r.startHour === 1.5)).toBe(true);
    expect(found.map((r) => r.startHour)).toEqual([9, 9.5, 10, 10.5, 11]);
    // 90 minutes at 80 an hour.
    expect(found[0].totalPrice).toBe(120);
  });

  it("are found where the venue sells its other sports by the hour, padel being sold by the half hour", async () => {
    const found = await searchAvailability({ sport: "padel", date, venueIds: [hourVenue], fromHour: 9, toHour: 10, duration: 1.5 });
    expect(found.map((r) => [r.venue.id, r.startHour, r.endHour])).toEqual([
      [hourVenue, 9, 10.5],
      [hourVenue, 9.5, 11],
      [hourVenue, 10, 11.5],
    ]);
  });

  it("are not offered where the venue sells padel by the hour, which cannot make them", async () => {
    expect(await updatePolicy({ venue: hourVenue, sport: "padel" }, { startEvery: 60, lengthStep: 60 })).toMatchObject({ ok: true });
    const found = await searchAvailability({ sport: "padel", date, venueIds: [hourVenue], fromHour: 9, toHour: 12, duration: 1.5 });
    expect(found).toEqual([]);
    const hours = await searchAvailability({ sport: "padel", date, venueIds: [hourVenue], fromHour: 9, toHour: 9, duration: 2 });
    // One result per venue and start time: here the cheaper of its two padel courts.
    expect(hours.map((r) => [r.venue.id, r.court.sport, r.endHour - r.startHour])).toEqual([[hourVenue, "padel", 2]]);
    expect(await updatePolicy({ venue: hourVenue, sport: "padel" }, { startEvery: null, lengthStep: null })).toMatchObject({ ok: true });
  });

  it("can be booked, and the game after it found back to back", async () => {
    const made = await createBooking({ courtId: padel, date, start: 9 * 60 + 30, minutes: 90, name: "Four Friends", phone: phone() });
    expect(made).toMatchObject({ ok: true, booking: { startHour: 9.5, endHour: 11 } });
    const found = await searchAvailability({ sport: "padel", date, venueIds: [halfHourVenue], fromHour: 8, toHour: 12, duration: 1.5 });
    expect(found.map((r) => r.startHour)).toEqual([8, 11, 11.5, 12]);
  });

  it("can be the shortest a court sells, so search leaves it out of an hour's game", async () => {
    expect(await updatePolicy({ court: padel }, { minLength: 90 })).toMatchObject({ ok: true, settings: { minLength: 90 } });
    expect(await searchAvailability({ sport: "padel", date, venueIds: [halfHourVenue], fromHour: 8, toHour: 8, duration: 1 })).toEqual([]);
    const short = await createBooking({ courtId: padel, date, start: 14 * 60, minutes: 60, name: "Quick", phone: phone() });
    expect(short.ok).toBe(false);
    expect(await updatePolicy({ court: padel }, { minLength: null })).toMatchObject({ ok: true });
  });

  it("are asked for in minutes by the search address, or in hours", async () => {
    const ask = (query: string) => searchGet(new NextRequest(`http://localhost/api/search?sport=padel&date=${date}&${query}`));
    expect((await ask("minutes=90")).status).toBe(200);
    expect((await ask("minutes=75")).status).toBe(200);
    expect((await ask("duration=1.5")).status).toBe(200);
    expect((await ask("minutes=0")).status).toBe(400);
    expect((await ask("minutes=7.5")).status).toBe(400);
  });
});
