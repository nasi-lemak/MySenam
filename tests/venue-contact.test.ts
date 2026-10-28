import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { registerUser } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { createResources } from "../src/lib/resources";
import { createBookingSeries, createVenue, getVenue, listUserBookings } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { venueContact } from "../src/lib/venue-contact";
import * as venueRoute from "../src/app/api/admin/venues/[id]/route";
import * as bookingsRoute from "../src/app/api/bookings/route";

/**
 * The venue's number wherever a customer may be told to call it (audit R8
 * X2-10; docs/features/venue-operations.md#the-venues-number): with the
 * booking looked up on My Booking, with each of an account's bookings, and
 * its WhatsApp chat where the venue says its number takes WhatsApp (off until
 * it does).
 */

let venue: number;
let court: number;
let cookie: string;
let n = 0;

const req = (url: string, method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.68.${++n % 250}.${n % 200}`, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const patch = (body: unknown) =>
  venueRoute.PATCH(req(`http://localhost/api/admin/venues/${venue}`, "PATCH", body, { cookie }), { params: Promise.resolve({ id: String(venue) }) });

beforeAll(async () => {
  const v = await createVenue({ name: "Contact Courts", area: "Ampang", address: "2 Jalan Ujian", phone: "03-4251 7788" });
  if (!v.ok) throw new Error("venue");
  venue = v.venue.id;
  const r = await createResources({ venueId: venue, sport: "badminton", name: "Court A", offPeakRate: 20, peakRate: 20 });
  if (!r.ok) throw new Error(r.error);
  court = r.courts[0].id;
  const admin = await createAdmin({ name: "Mona Manager", email: "mona@contact.test", password: "a long enough password", venueId: venue, role: "manager" });
  if (!admin.ok) throw new Error(admin.error);
  cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(admin.admin.id)).token}`;
});

describe("venueContact", () => {
  it("gives the number, and WhatsApp only where the venue says its number takes it", () => {
    expect(venueContact({ phone: "03-4251 7788" })).toEqual({ phone: "03-4251 7788", whatsapp: null });
    expect(venueContact({ phone: "012-345 6789", phoneWhatsapp: true })).toEqual({ phone: "012-345 6789", whatsapp: "60123456789" });
    expect(venueContact({ phone: "+65 9123 4567", phoneWhatsapp: true })?.whatsapp).toBe("6591234567");
    // No number worth calling: nothing to show.
    expect(venueContact({ phone: "" })).toBeNull();
    expect(venueContact({ phone: null })).toBeNull();
  });
});

describe("a venue saying its number takes WhatsApp", () => {
  it("is off until a manager turns it on, and is kept", async () => {
    expect((await getVenue(venue))?.phoneWhatsapp).toBe(false);
    const on = await patch({ phoneWhatsapp: true });
    expect(on.status).toBe(200);
    expect((await on.json()).venue.phoneWhatsapp).toBe(true);
    expect((await getVenue(venue))?.phoneWhatsapp).toBe(true);
    // Other details saved later leave it as it is.
    expect((await patch({ address: "3 Jalan Ujian" })).status).toBe(200);
    expect((await getVenue(venue))?.phoneWhatsapp).toBe(true);
    // In the activity log, as every change to the venue's details is.
    const logged = (await getDb()
      .prepare("SELECT detail FROM staff_actions WHERE venue_id = ? AND action = 'settings.changed' ORDER BY id DESC LIMIT 2")
      .all(venue)) as { detail: string }[];
    expect(logged.some((l) => l.detail.includes("phoneWhatsapp"))).toBe(true);
    expect((await patch({ phoneWhatsapp: "yes" })).status).toBe(400);
    expect((await patch({ phoneWhatsapp: false })).status).toBe(200);
    expect((await getVenue(venue))?.phoneWhatsapp).toBe(false);
  });
});

describe("where a customer reads their booking", () => {
  it("My Booking's lookup carries the venue's number, and its WhatsApp once on", async () => {
    const made = await createBookingSeries({ courtId: court, date: addDays(todayISO(), 3), start: 600, end: 660, weeks: 1, name: "Kay Caller", phone: "0161112233" });
    if (!made.ok) throw new Error(made.error);
    const look = async () =>
      (await (await bookingsRoute.GET(req(`http://localhost/api/bookings?code=${made.bookings[0].code}&phone=0161112233`, "GET"))).json()).venue.contact;
    expect(await look()).toEqual({ phone: "03-4251 7788", whatsapp: null });
    await patch({ phone: "012-777 8899", phoneWhatsapp: true });
    expect(await look()).toEqual({ phone: "012-777 8899", whatsapp: "60127778899" });
  });

  it("each of an account's bookings carries it too", async () => {
    const user = await registerUser({ name: "Acc Holder", email: "acc@contact.test", phone: "0162223344", password: "a long enough password" });
    if (!user.ok) throw new Error(user.error);
    const made = await createBookingSeries({ courtId: court, date: addDays(todayISO(), 4), start: 600, end: 660, weeks: 1, name: "Acc Holder", phone: "0162223344", userId: user.user.id });
    if (!made.ok) throw new Error(made.error);
    const [mine] = await listUserBookings(user.user.id);
    expect(mine.venueContact).toEqual({ phone: "012-777 8899", whatsapp: "60127778899" });
  });
});
