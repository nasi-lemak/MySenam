import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { headedRows } from "../src/lib/court-activities";
import { getDb } from "../src/lib/db";
import { createResources, setCourtHeading } from "../src/lib/resources";
import { createBooking, createGroupBooking, createVenue, getAvailability, searchAvailability } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { PATCH } from "../src/app/api/admin/courts/[id]/route";

/**
 * Kinds of kit under one heading: "Kayaks" over "Single kayak" and "Double
 * kayak". Only how they are shown; each kind is still booked and counted as
 * itself, and several can be taken in one booking, all or nothing.
 */

let venueId: number;
let singles: number;
let doubles: number;
let boards: number;
const date = addDays(todayISO(), 3);
let n = 0;
const phone = () => `0166000${String(++n).padStart(3, "0")}`;

beforeAll(async () => {
  const v = await createVenue({ name: "Tasik Paddle", area: "Putrajaya", address: "x", phone: "0388881111" });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  const make = async (name: string, capacity: number) => {
    const made = await createResources({ venueId, sport: "kayak", name, offPeakRate: 30, peakRate: 30, capacity, maxPlayers: capacity });
    if (!made.ok) throw new Error(made.error);
    return made.courts[0].id;
  };
  singles = await make("Single kayak", 6);
  boards = await make("Paddleboards", 4);
  doubles = await make("Double kayak", 3);
});

describe("a heading over kinds of kit", () => {
  it("is set by the venue's manager, one spelling per venue, and taken off with a blank", async () => {
    const manager = await createAdmin({ name: "Paddle manager", email: "m@paddle.my", password: "paddle-password-1", venueId });
    if (!manager.ok) throw new Error("admin");
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(manager.admin.id)).token}`;
    const patch = (id: number, body: unknown) =>
      PATCH(new NextRequest(`http://localhost/api/admin/courts/${id}`, { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }), {
        params: Promise.resolve({ id: String(id) }),
      });
    const res = await patch(singles, { heading: "Kayaks" });
    expect(res.status).toBe(200);
    expect((await res.json()).court).toMatchObject({ heading: "Kayaks" });
    // Typed again in other capitals, it joins the one already there.
    expect(await setCourtHeading(doubles, "  kayaks ")).toMatchObject({ ok: true, court: { heading: "Kayaks" } });
    expect((await patch(boards, { heading: "K" })).status).toBe(400);
    expect(await setCourtHeading(boards, "x".repeat(41))).toMatchObject({ ok: false });
    expect(await setCourtHeading(boards, 5)).toMatchObject({ ok: false });
    expect(await setCourtHeading(boards, "Boards")).toMatchObject({ ok: true, court: { heading: "Boards" } });
    expect(await setCourtHeading(boards, "")).toMatchObject({ ok: true, court: { heading: null } });
    const log = (await getDb().prepare("SELECT detail FROM staff_actions WHERE venue_id = ? AND detail LIKE '%listed under%'").all(venueId)) as { detail: string }[];
    expect(log.map((l) => l.detail)).toEqual(["Single kayak: listed under Kayaks"]);
  });

  it("shows customers one heading with its kinds beneath it, together, the rest after", async () => {
    const day = await getAvailability(venueId, date, "kayak");
    expect(day.map((d) => d.court.name)).toEqual(["Single kayak", "Paddleboards", "Double kayak"]);
    const rows = headedRows(day).map((r) => [r.heading, r.court.name, r.under]);
    expect(rows).toEqual([
      ["Kayaks", "Single kayak", true],
      [null, "Double kayak", true],
      [null, "Paddleboards", false],
    ]);
  });

  it("leaves each kind booked and counted as itself, and search finding the venue", async () => {
    expect(await createBooking({ courtId: singles, date, hours: [9], name: "Solo", phone: phone(), players: 6 })).toMatchObject({ ok: true });
    const day = await getAvailability(venueId, date, "kayak");
    const at9 = (id: number) => day.find((d) => d.court.id === id)!.slots.find((s) => s.minute === 9 * 60)!;
    expect(at9(singles).available).toBe(false);
    expect(at9(doubles).available).toBe(true);
    expect(at9(doubles).capacity).toBe(3);
    const found = await searchAvailability({ sport: "kayak", date, area: "Putrajaya" });
    expect(found.some((r) => r.venue.id === venueId)).toBe(true);
  });

  it("still lets a booking take some of several kinds under it, all or nothing", async () => {
    const both = await createGroupBooking({ courtIds: [singles, doubles], date, hours: [11], name: "Keluarga", phone: phone(), placesByCourt: { [singles]: 4, [doubles]: 2 } });
    expect(both).toMatchObject({ ok: true });
    if (both.ok) expect(both.bookings.map((b) => [b.courtId, b.players])).toEqual(expect.arrayContaining([[singles, 4], [doubles, 2]]));
    // Two doubles more would be past its three: neither kind is booked.
    const before = ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE court_id = ? AND status = 'confirmed'").get(singles)) as { n: number }).n;
    const over = await createGroupBooking({ courtIds: [singles, doubles], date, hours: [11], name: "Kawan", phone: phone(), placesByCourt: { [singles]: 2, [doubles]: 2 } });
    expect(over).toMatchObject({ ok: false });
    const after = ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE court_id = ? AND status = 'confirmed'").get(singles)) as { n: number }).n;
    expect(after).toBe(before);
  });
});
