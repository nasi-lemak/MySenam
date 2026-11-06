import { describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, authenticateAdmin, createAdminSession, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { venueReport } from "../src/lib/reports";
import { claimPayment, createBookingSeries, createBooking, listVenues, setPaymentStatus } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { POST } from "../src/app/api/admin/payments/route";

/** How the desk took the money, so the till and the bank can be squared. */

await ensureBootstrapAdmin();
const owner = (await authenticateAdmin("admin@mysenam.my", "mysenam-admin"))!;
const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(owner.id)).token}`;
const date = addDays(todayISO(), 3);

let n = 0;
async function booking(hour: number) {
  const court = (await listVenues())[0].courts[0];
  const made = await createBooking({ courtId: court.id, date, hours: [hour], name: "Faiz", phone: `0133${String(++n).padStart(6, "0")}` });
  if (!made.ok) throw new Error(made.error);
  return made.booking;
}
const pay = (body: unknown) =>
  POST(new NextRequest("http://localhost/api/admin/payments", { method: "POST", headers: { cookie }, body: JSON.stringify(body) }));
const viaOf = async (id: number) =>
  ((await getDb().prepare("SELECT paid_via FROM bookings WHERE id = ?").get(id)) as { paid_via: string | null }).paid_via;

describe("recording how a booking was paid", () => {
  it("keeps the desk's method, and clears it when marked unpaid", async () => {
    const b = await booking(9);
    const res = await pay({ code: b.code, paid: true, via: "qr" });
    expect(res.status).toBe(200);
    expect((await res.json()).booking).toMatchObject({ paymentStatus: "paid", paidVia: "qr", paidOnline: false });
    expect(await viaOf(b.id)).toBe("qr");
    await setPaymentStatus(b.code, false);
    expect(await viaOf(b.id)).toBeNull();
  });

  it("refuses a method it does not know, and leaves one not given unrecorded", async () => {
    const b = await booking(10);
    expect((await pay({ code: b.code, paid: true, via: "bitcoin" })).status).toBe(400);
    expect((await pay({ code: b.code, paid: true })).status).toBe(200);
    expect(await viaOf(b.id)).toBeNull();
  });

  it("records a whole series, a pass and stored credit", async () => {
    const court = (await listVenues())[0].courts[1];
    const series = await createBookingSeries({ courtId: court.id, date, hours: [11], weeks: 2, name: "Faiz", phone: "0139999999" });
    if (!series.ok) throw new Error(series.error);
    expect((await pay({ seriesCode: series.seriesCode, via: "transfer" })).status).toBe(200);
    for (const b of series.bookings) expect(await viaOf(b.id)).toBe("transfer");

    const a = await booking(12);
    const c = await booking(13);
    expect(await claimPayment(a.id, "pass")).toBe(true);
    expect(await claimPayment(c.id, "credit")).toBe(true);
    expect(await viaOf(a.id)).toBe("pass");
    expect(await viaOf(c.id)).toBe("credit");
  });

  it("splits what was collected by method in the report", async () => {
    const b = await booking(14);
    await setPaymentStatus(b.code, true, "cash");
    const venue = (await listVenues())[0];
    const report = (await venueReport(venue.id, date, date))!;
    const by = Object.fromEntries(report.collectedBy.map((c) => [c.via, c.amount]));
    expect(by.cash).toBe(b.totalPrice);
    expect(by.unrecorded).toBeGreaterThan(0);
    // A booking paid with a pass is not takings (the pass sale was the money, ADR 0055): no line of its own.
    expect(by.pass).toBeUndefined();
    expect(report.revenue.passPaid.bookings).toBeGreaterThan(0);
    expect(report.collectedBy.reduce((sum, c) => sum + c.amount, 0)).toBeCloseTo(report.revenue.collected, 2);
  });
});
