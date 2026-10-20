import { afterAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_COUNTRY = "SG";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, authenticateAdmin, createAdminSession, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { createBooking, createVenue, sellMembership } from "../src/lib/store";
import { getDb } from "../src/lib/db";
import { addDays, isPeak, todayISO } from "../src/lib/time";
import { POST as addCourt } from "../src/app/api/admin/courts/route";

/** Prices with cents, as Singapore's are: S$4.80 an hour, not only S$5. */

afterAll(() => {
  delete process.env.MYSENAM_COUNTRY;
});

describe("prices to the cent", () => {
  it("are accepted, added up exactly, and refused past the cent", async () => {
    await ensureBootstrapAdmin();
    const owner = (await authenticateAdmin("admin@mysenam.my", "mysenam-admin"))!;
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(owner.id)).token}`;
    const made = await createVenue({ name: "Toa Payoh Hall", area: "Toa Payoh", address: "x", phone: "61234567" });
    if (!made.ok) throw new Error("venue");
    const post = (body: Record<string, unknown>) =>
      addCourt(
        new NextRequest("http://localhost/api/admin/courts", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ venueId: made.venue.id, name: "Court 1", sport: "badminton", ...body }),
        })
      );
    expect((await post({ offPeakRate: 4.805, peakRate: 6 })).status).toBe(400);
    const res = await post({ offPeakRate: 4.8, peakRate: 6.3, deposit: 2.5 });
    expect(res.status).toBe(201);
    const { court } = await res.json();
    expect(court).toMatchObject({ offPeakRate: 4.8, peakRate: 6.3, deposit: 2.5 });

    let date = addDays(todayISO(), 2);
    while (isPeak(date, 9)) date = addDays(date, 1);
    const booked = await createBooking({ courtId: court.id, date, hours: [9, 10, 11], name: "Siti", phone: "91234567" });
    if (!booked.ok) throw new Error(booked.error);
    // 4.8 × 3 is 14.399999… in floating point; the price is 14.40.
    expect(booked.booking.totalPrice).toBe(14.4);
    const stored = (await getDb().prepare("SELECT total_price::text AS p FROM bookings WHERE id = ?").get(booked.booking.id)) as { p: string };
    expect(stored.p).toBe("14.40");
  });

  it("go for memberships too", async () => {
    const v = (await getDb().prepare("SELECT id FROM venues LIMIT 1").get()) as { id: number };
    const sold = await sellMembership({
      venueId: v.id,
      holderName: "Siti",
      holderPhone: "91234567",
      startsOn: todayISO(),
      expiresOn: addDays(todayISO(), 30),
      price: 49.9,
    });
    expect(sold).toMatchObject({ ok: true, membership: { price: 49.9 } });
    expect(await sellMembership({ venueId: v.id, holderName: "Ah Kow", holderPhone: "92345678", startsOn: todayISO(), expiresOn: addDays(todayISO(), 30), price: 49.999 })).toMatchObject({ ok: false });
  });
});
