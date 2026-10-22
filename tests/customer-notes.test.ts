import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { registerUser } from "../src/lib/auth";
import { customerNote, MAX_NOTE, setCustomerNote } from "../src/lib/customer-notes";
import { eraseCustomer, exportCustomerData, exportPhoneData } from "../src/lib/privacy";
import { createBooking, createCourt, createVenue, listBookingsForDate } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { POST as noteRoute } from "../src/app/api/admin/customer-notes/route";

/** A venue's own note on a customer: on their bookings, in their data, gone with their account. */

let venueId: number;
let otherVenue: number;
let courtId: number;
const date = addDays(todayISO(), 2);

beforeAll(async () => {
  const made = await createVenue({ name: "Pusat Sukan", area: "Kajang", address: "x", phone: "0388881111" });
  const other = await createVenue({ name: "Elsewhere", area: "Ipoh", address: "x", phone: "0588881111" });
  if (!made.ok || !other.ok) throw new Error("venue");
  venueId = made.venue.id;
  otherVenue = other.venue.id;
  const c = await createCourt({ venueId, name: "Court 3", sport: "badminton", offPeakRate: 20, peakRate: 30 });
  if (!c.ok) throw new Error("court");
  courtId = c.court.id;
});

describe("a note on a customer", () => {
  it("is one per number at the venue, however the number is typed, and shows on their bookings", async () => {
    expect(await setCustomerNote(venueId, "012-777 8888", "x".repeat(MAX_NOTE + 1), null)).toMatchObject({ ok: false });
    expect((await setCustomerNote(venueId, "012-777 8888", "Prefers Court 3. Pays by transfer.", null)).ok).toBe(true);
    expect((await customerNote(venueId, "+60127778888"))?.note).toBe("Prefers Court 3. Pays by transfer.");
    expect(await customerNote(otherVenue, "0127778888")).toBeNull();
    const b = await createBooking({ courtId, date, hours: [10], name: "Farah", phone: "60127778888" });
    if (!b.ok) throw new Error(b.error);
    const row = (await listBookingsForDate(date, venueId)).find((r) => r.code === b.booking.code);
    expect(row?.staffNote).toBe("Prefers Court 3. Pays by transfer.");
  });

  it("is written by the desk, only at its own venue; empty, it goes", async () => {
    const desk = await createAdmin({ name: "Desk", email: "desk@pusat.my", password: "desk-password-1", venueId, role: "desk" });
    if (!desk.ok) throw new Error(desk.error);
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
    const post = (body: unknown) =>
      noteRoute(new NextRequest("http://localhost/api/admin/customer-notes", { method: "POST", headers: { cookie }, body: JSON.stringify(body) }));
    const res = await post({ venueId, phone: "0127778888", note: "Bring the ramp out." });
    expect(res.status).toBe(200);
    expect((await res.json()).note).toMatchObject({ note: "Bring the ramp out.", updatedBy: "Desk" });
    expect((await post({ venueId: otherVenue, phone: "0127778888", note: "x" })).status).toBe(403);
    expect((await post({ venueId, phone: "0127778888", note: "" })).status).toBe(200);
    expect(await customerNote(venueId, "0127778888")).toBeNull();
  });

  it("goes out with the customer's data, and is erased with their account", async () => {
    await setCustomerNote(venueId, "0127778888", "Bring the ramp out.", null);
    expect((await exportPhoneData([venueId], "0127778888")).staffNotes).toEqual([expect.objectContaining({ note: "Bring the ramp out." })]);
    const u = await registerUser({ name: "Farah", email: "farah@example.com", phone: "012-777 8888", password: "password-123" });
    if (!u.ok) throw new Error(u.error);
    expect((await exportCustomerData(u.user.id))?.staffNotes).toEqual([expect.objectContaining({ venue: "Pusat Sukan", note: "Bring the ramp out." })]);
    await eraseCustomer(u.user.id);
    expect(await customerNote(venueId, "0127778888")).toBeNull();
  });
});
