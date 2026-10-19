import { describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, authenticateAdmin, createAdmin, createAdminSession, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { createVenue, listVenues } from "../src/lib/store";
import { venueBookingUrl } from "../src/lib/venue-link";
import { GET as qr } from "../src/app/api/venues/[id]/qr/route";
import { GET as link } from "../src/app/api/admin/booking-link/route";

/** A venue's booking link and its QR code, for the counter and the WhatsApp group. */

await ensureBootstrapAdmin();
const owner = (await authenticateAdmin("admin@mysenam.my", "mysenam-admin"))!;
const ownerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(owner.id)).token}`;
const params = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

describe("the booking link", () => {
  it("is the venue's page, as a QR code anybody can scan", async () => {
    const venue = (await listVenues())[0];
    expect(await venueBookingUrl(venue.id)).toBe(`https://book.example.my/venue/${venue.id}`);
    const res = await qr(new NextRequest(`http://localhost/api/venues/${venue.id}/qr`), params(venue.id));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(await res.text()).toContain("<svg");
  });

  it("keeps a draft's code to its own staff", async () => {
    const made = await createVenue({ name: "Draft Hall", area: "PJ", address: "x", phone: "0300000000" });
    if (!made.ok) throw new Error("venue");
    await getDb().prepare("UPDATE venues SET published_at = NULL WHERE id = ?").run(made.venue.id);
    expect((await qr(new NextRequest(`http://localhost/api/venues/${made.venue.id}/qr`), params(made.venue.id))).status).toBe(404);
    const staffed = await qr(
      new NextRequest(`http://localhost/api/venues/${made.venue.id}/qr`, { headers: { cookie: ownerCookie } }),
      params(made.venue.id)
    );
    expect(staffed.status).toBe(200);
  });

  it("is given to a venue's own staff only", async () => {
    const [a, b] = await listVenues();
    const desk = await createAdmin({ name: "Desk", email: "link-desk@venue.my", password: "desk-password-1", venueId: a.id });
    if (!desk.ok) throw new Error(desk.error);
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
    const mine = await link(new NextRequest(`http://localhost/api/admin/booking-link?venueId=${a.id}`, { headers: { cookie } }));
    expect(await mine.json()).toEqual({ url: `https://book.example.my/venue/${a.id}` });
    expect((await link(new NextRequest(`http://localhost/api/admin/booking-link?venueId=${b.id}`, { headers: { cookie } }))).status).toBe(403);
  });
});
