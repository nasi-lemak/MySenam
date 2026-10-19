import { describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, authenticateAdmin, createAdmin, createAdminSession, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { bookingsCsv, toCsv } from "../src/lib/export";
import { createBooking, listVenues, setPaymentStatus } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { GET } from "../src/app/api/admin/export/route";

/** What the accountant is handed: every booking, opened straight in Excel. */

await ensureBootstrapAdmin();
const date = addDays(todayISO(), 2);

describe("a spreadsheet", () => {
  it("is safe and readable in Excel", () => {
    const csv = toCsv(["Name", "Note"], [["Aisyah \"Ash\"", "=HYPERLINK(\"x\")"], ["Lee", null]]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain('"Aisyah ""Ash"""');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv.split("\r\n")).toHaveLength(4);
  });

  it("lists bookings with how they were paid", async () => {
    const venue = (await listVenues())[0];
    const made = await createBooking({ courtId: venue.courts[0].id, date, hours: [10, 11], name: "Siti Aminah", phone: "0171112222" });
    if (!made.ok) throw new Error(made.error);
    await setPaymentStatus(made.booking.code, true, "qr");
    const csv = await bookingsCsv(venue.id, date, date);
    const line = csv.split("\r\n").find((l) => l.includes(made.booking.code))!;
    expect(line).toContain('"Siti Aminah"');
    expect(line).toContain('"10:00","12:00"');
    expect(line).toContain('"paid","DuitNow QR / e-wallet"');
  });

  it("is a download for managers, not front desk", async () => {
    const venue = (await listVenues())[0];
    const owner = (await authenticateAdmin("admin@mysenam.my", "mysenam-admin"))!;
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(owner.id)).token}`;
    const url = `http://localhost/api/admin/export?venueId=${venue.id}&from=${date}&to=${date}`;
    const res = await GET(new NextRequest(url, { headers: { cookie } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect((await GET(new NextRequest(`${url}&kind=payments`, { headers: { cookie } }))).status).toBe(200);

    const desk = await createAdmin({ name: "Desk", email: "csv-desk@venue.my", password: "desk-password-1", venueId: venue.id, role: "desk" });
    if (!desk.ok) throw new Error(desk.error);
    const deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
    expect((await GET(new NextRequest(url, { headers: { cookie: deskCookie } }))).status).toBe(403);
    expect((await GET(new NextRequest(`http://localhost/api/admin/export?venueId=${venue.id}&from=${date}&to=2020-01-01`, { headers: { cookie } }))).status).toBe(400);
  });
});
