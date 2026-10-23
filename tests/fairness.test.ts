import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

const sent: string[] = [];
vi.mock("../src/lib/transports", async (original) => ({
  ...(await original<typeof import("../src/lib/transports")>()),
  sendPlainEmail: async (_to: string, subject: string) => {
    sent.push(subject);
    return true;
  },
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { VENUE_CAPS } from "../src/lib/limits";
import { createCourt, createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * One venue's operator cannot crowd everybody else off the platform: not by
 * adding courts, and not by filling the classes page.
 */

let venueId: number;
let courtId: number;
let cookie: string;

const post = (path: string, body: object) =>
  new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const v = await createVenue({ name: "Crowding Hall", area: "Ipoh", address: "Jalan Crowd", phone: "0500000000" });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  const c = await createCourt({ venueId, name: "Studio", sport: "gym", offPeakRate: 10, peakRate: 10, capacity: 20 });
  if (!c.ok) throw new Error("court");
  courtId = c.court.id;
  const op = await createAdmin({ name: "Op", email: "op-crowd@example.my", password: "op-password-1", venueId });
  if (!op.ok) throw new Error(op.error);
  cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(op.admin.id)).token}`;
});

describe("courts a venue adds itself", () => {
  it("tell the platform owner every ten, and stop at the cap", async () => {
    const { POST } = await import("../src/app/api/admin/courts/route");
    const add = (i: number) =>
      POST(post("/api/admin/courts", { venueId, name: `Court ${i}`, sport: "badminton", offPeakRate: 10, peakRate: 15 }));

    sent.length = 0;
    // From one court (the studio) to ten.
    for (let i = 2; i <= 10; i++) expect((await add(i)).status).toBe(201);
    expect(sent).toEqual(["Crowding Hall now has 10 courts"]);

    // Up to the cap, quickly, then one more through the front door.
    await getDb()
      .prepare(
        `INSERT INTO courts (venue_id, name, sport, off_peak_rate, peak_rate)
         SELECT ?, 'Filler ' || g, 'badminton', 10, 10 FROM generate_series(1, ?) g`
      )
      .run(venueId, VENUE_CAPS.courts - 10);
    const refused = await add(999);
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toContain(`up to ${VENUE_CAPS.courts} courts`);
  });
});

describe("class sessions a venue schedules itself", () => {
  it("stop at the cap", async () => {
    const { POST } = await import("../src/app/api/admin/classes/route");
    await getDb()
      .prepare(
        `INSERT INTO classes (court_id, name, instructor, date, start_min, end_min, capacity, price)
         SELECT ?, 'Filler', 'Coach', to_char(current_date + (g % 60) + 1, 'YYYY-MM-DD'), (6 + (g % 14)) * 60, (7 + (g % 14)) * 60, 10, 20
           FROM generate_series(1, ?) g`
      )
      .run(courtId, VENUE_CAPS.upcomingClassSessions - 1);
    const four = await POST(
      post("/api/admin/classes", {
        courtId,
        name: "Spin",
        instructor: "Mei",
        date: addDays(todayISO(), 70),
        startHour: 20,
        endHour: 21,
        capacity: 10,
        price: 20,
        weeks: 4,
      })
    );
    expect(four.status).toBe(409);
  });
});

describe("the classes page", () => {
  it("shows a few of one venue's classes a day, and two weeks ahead", async () => {
    const { GET } = await import("../src/app/api/classes/route");
    const listed = async (query = "") =>
      (await (await GET(new NextRequest(`http://localhost/api/classes${query}`))).json()).classes as {
        venueId: number;
        date: string;
      }[];
    const ours = (await listed()).filter((c) => c.venueId === venueId);
    const perDay = new Map<string, number>();
    for (const c of ours) perDay.set(c.date, (perDay.get(c.date) ?? 0) + 1);
    expect(Math.max(...perDay.values())).toBeLessThanOrEqual(6);
    expect(ours.every((c) => c.date <= addDays(todayISO(), 14))).toBe(true);

    // On the venue's own page, all of them.
    const own = await listed(`?venueId=${venueId}`);
    expect(own.length).toBeGreaterThan(ours.length);
  });
});
