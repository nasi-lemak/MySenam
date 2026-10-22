import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { eraseCustomer, exportPhoneData } from "../src/lib/privacy";
import { createBooking, createCourt, createVenue, listBookingsForDate } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { currentWaiver, setWaiver, waiverSigned } from "../src/lib/waivers";
import { registerUser } from "../src/lib/auth";
import { POST as book } from "../src/app/api/bookings/route";
import { POST as paper } from "../src/app/api/admin/waiver/sign/route";
import { POST as saveRoute } from "../src/app/api/admin/waiver/route";

/** A venue's waiver: agreed to once per version, refused until it is, signed on paper at the desk. */

let venueId: number;
let courtId: number;
const date = addDays(todayISO(), 2);
const WORDS =
  "I climb at my own risk. I am fit to climb, I will follow the wall's rules and the staff's instructions, and I will use the safety equipment as shown.";
let hour = 9;
const post = (body: Record<string, unknown>) =>
  book(
    new NextRequest("http://localhost/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ courtId, date, hours: [hour++], name: "Mei Ling", phone: "0168881111", ...body }),
    })
  );

beforeAll(async () => {
  const made = await createVenue({ name: "Dinding Panjat", area: "Puchong", address: "x", phone: "0377771111" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const c = await createCourt({ venueId, name: "Wall A", sport: "badminton", offPeakRate: 30, peakRate: 30 });
  if (!c.ok) throw new Error("court");
  courtId = c.court.id;
});

describe("a venue's waiver", () => {
  it("is asked for nowhere until the venue writes one", async () => {
    expect(await waiverSigned(venueId, "0168881111")).toBe(true);
    expect((await post({})).status).toBe(201);
    expect(await setWaiver(venueId, "Too short.")).toMatchObject({ ok: false });
    expect((await setWaiver(venueId, WORDS)).ok).toBe(true);
  });

  it("refuses a booking until the box is ticked, then remembers the agreement", async () => {
    const refused = await post({});
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe("WAIVER_NEEDED");
    expect((await post({ agreeWaiver: true })).status).toBe(201);
    // The same number, however typed, is not asked again.
    expect((await post({ phone: "+60168881111" })).status).toBe(201);
    const sig = (await getDb().prepare("SELECT name, booking_id FROM waiver_signatures").all()) as { name: string; booking_id: number }[];
    expect(sig).toEqual([expect.objectContaining({ name: "Mei Ling" })]);
  });

  it("is agreed to afresh when the words change; the same words change nothing", async () => {
    const first = await currentWaiver(venueId);
    expect((await setWaiver(venueId, WORDS)).ok).toBe(true);
    expect((await currentWaiver(venueId))?.id).toBe(first?.id);
    await setWaiver(venueId, `${WORDS} Children under 12 climb with an adult.`);
    expect(await waiverSigned(venueId, "0168881111")).toBe(false);
    expect((await post({})).status).toBe(409);
  });

  it("can be signed on paper at the desk, and the bookings list says who has not", async () => {
    const b = await createBooking({ courtId, date, hours: [15], name: "Walk-in Raj", phone: "0168882222" });
    if (!b.ok) throw new Error(b.error);
    const row = () => listBookingsForDate(date, venueId).then((rows) => rows.find((r) => r.code === b.booking.code)!);
    expect((await row()).waiverSigned).toBe(false);
    const desk = await createAdmin({ name: "Desk", email: "desk@panjat.my", password: "desk-password-1", venueId, role: "desk" });
    if (!desk.ok) throw new Error(desk.error);
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
    const res = await paper(new NextRequest("http://localhost/api/admin/waiver/sign", { method: "POST", headers: { cookie }, body: JSON.stringify({ bookingId: b.booking.id }) }));
    expect(res.status).toBe(200);
    expect((await row()).waiverSigned).toBe(true);
    // Writing the waiver is a manager's.
    const save = await saveRoute(
      new NextRequest("http://localhost/api/admin/waiver", { method: "POST", headers: { cookie }, body: JSON.stringify({ venueId, text: "" }) })
    );
    expect(save.status).toBe(403);
  });

  it("goes out with the customer's data, and is kept when they erase their account", async () => {
    const held = await exportPhoneData([venueId], "0168882222");
    expect(held.waivers).toEqual([expect.objectContaining({ name: "Walk-in Raj", recorded_by: "Desk" })]);
    const u = await registerUser({ name: "Raj", email: "raj@example.com", phone: "0168882222", password: "password-123" });
    if (!u.ok) throw new Error(u.error);
    await eraseCustomer(u.user.id);
    expect(await waiverSigned(venueId, "0168882222")).toBe(true);
  });

  it("empty, asks nobody", async () => {
    await setWaiver(venueId, "");
    expect(await currentWaiver(venueId)).toBeNull();
    expect((await post({ phone: "0168883333" })).status).toBe(201);
  });
});
