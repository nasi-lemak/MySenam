import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { PATCH as correctRoute } from "../src/app/api/admin/bookings/route";
import { moveBookingToDate } from "./helpers/bookings";
import { listActivity } from "../src/lib/activity";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { CORRECTION_REFUSALS, correctBookingDetails } from "../src/lib/booking-corrections";
import { setCancelPolicy } from "../src/lib/cancel-policy";
import { getDb } from "../src/lib/db";
import { blockPhone } from "../src/lib/limits";
import { setVenueOverrides } from "../src/lib/policy-overrides";
import { adminCancelBooking, createBooking, createBookingSeries, createCourt, createVenue, setPaymentStatus } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Staff correcting a booking's name, number or email (X1-3): a new number is
 * asked what a counter booking on it would be (ADR 0026), said as the counter
 * says it, with a manager's override where the venue allows it; the activity
 * log keeps before and after (names as it names customers, a number's last
 * four digits); an erased customer's booking is not given details back.
 */

let venueId: number;
let courtId: number;
let deskCookie: string;
let managerCookie: string;
let managerId: number;
const staff = { id: 0, name: "Dina Desk", role: "desk" as const };
let n = 0;
const phone = () => `0155500${String(++n).padStart(3, "0")}`;
let hour = 7;

async function book(opts: { paid?: boolean; days?: number } = {}) {
  const made = await createBooking({ courtId, date: addDays(todayISO(), opts.days ?? 3), hours: [++hour], name: "Aminah Yusof", phone: phone(), email: "aminah@example.com" });
  if (!made.ok) throw new Error(made.error);
  if (opts.paid) await setPaymentStatus(made.booking.code, true, "cash");
  return made.booking;
}

const rowOf = async (code: string) =>
  (await getDb().prepare("SELECT name, phone, email FROM bookings WHERE code = ?").get(code)) as { name: string; phone: string; email: string | null };

const patch = (cookie: string, body: object) =>
  correctRoute(
    new NextRequest("http://localhost/api/admin/bookings", { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) })
  );

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const made = await createVenue({ name: "Fix Hall", area: "Ipoh", address: "x", phone: "0355557777", openHour: 7, closeHour: 23 });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20, capacity: 1 });
  if (!court.ok) throw new Error(court.error);
  courtId = court.court.id;
  const d = await createAdmin({ name: "Dina Desk", email: "dina@fix.my", password: "desk-password-1", venueId, role: "desk" });
  const m = await createAdmin({ name: "Musa Manager", email: "musa@fix.my", password: "manager-pass-1", venueId });
  if (!d.ok || !m.ok) throw new Error("staff");
  staff.id = d.admin.id;
  managerId = m.admin.id;
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(d.admin.id)).token}`;
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(m.admin.id)).token}`;
});

describe("correcting a booking's details", () => {
  it("puts right the name, number and email, and logs before and after without the whole number", async () => {
    const b = await book();
    const res = await patch(deskCookie, { code: b.code, name: "Aminah Yusoff", phone: "0123456789", email: "aminah.y@example.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ codes: [b.code], changed: { name: true, phone: true, email: true } });
    expect(await rowOf(b.code)).toEqual({ name: "Aminah Yusoff", phone: "0123456789", email: "aminah.y@example.com" });
    const [entry] = await listActivity([venueId], { bookingCode: b.code });
    expect(entry).toMatchObject({ action: "booking.details_corrected", adminName: "Dina Desk" });
    expect(entry.detail).toContain("name Aminah Yusof → Aminah Yusoff");
    expect(entry.detail).toContain(`number ending ${b.phone.slice(-4)} → ending 6789`);
    expect(entry.detail).toContain("email a…@example.com → a…@example.com");
    expect(entry.detail).not.toContain("0123456789");
    expect(entry.detail).not.toContain(b.phone);
  });

  it("clears an email, and asks nothing of the venue's policies for a name or email alone", async () => {
    const b = await book();
    await blockPhone({ venueId, phone: b.phone, adminId: managerId });
    const done = await correctBookingDetails({ code: b.code, name: "Aminah binti Yusof", email: null, staff });
    expect(done).toMatchObject({ ok: true, changed: { name: true, phone: false, email: true } });
    expect(await rowOf(b.code)).toMatchObject({ name: "Aminah binti Yusof", email: null });
  });

  it("refuses nothing to correct, a bad number or email, and a cancelled booking", async () => {
    const b = await book();
    expect(await correctBookingDetails({ code: b.code, name: "Aminah Yusof", staff })).toMatchObject({ ok: false, error: CORRECTION_REFUSALS.nothing });
    expect(await correctBookingDetails({ code: b.code, phone: "12", staff })).toMatchObject({ ok: false, error: CORRECTION_REFUSALS.phone });
    expect(await correctBookingDetails({ code: b.code, email: "not-an-email", staff })).toMatchObject({ ok: false, error: CORRECTION_REFUSALS.email });
    await adminCancelBooking(b.code);
    expect(await correctBookingDetails({ code: b.code, name: "Someone Else", staff })).toMatchObject({ ok: false, error: CORRECTION_REFUSALS.cancelled });
  });

  it("does not give an erased customer's booking details back", async () => {
    const b = await book();
    await getDb().prepare("UPDATE bookings SET name = '(removed)', phone = '', email = NULL WHERE id = ?").run(b.id);
    expect(await correctBookingDetails({ code: b.code, name: "Aminah Yusof", phone: "0123000111", staff })).toMatchObject({
      ok: false,
      error: CORRECTION_REFUSALS.erased,
    });
  });
});

describe("a new number is asked what a counter booking on it would be", () => {
  it("is refused for a blocked number, as the counter says it, and nothing changes", async () => {
    const b = await book({ paid: true });
    const blocked = phone();
    await blockPhone({ venueId, phone: blocked, adminId: managerId });
    const res = await patch(managerCookie, { code: b.code, phone: blocked });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "R9_DESK_PHONE_BLOCKED" });
    expect((await rowOf(b.code)).phone).toBe(b.phone);
  });

  it("is refused at the unpaid-bookings limit of the new number", async () => {
    const other = phone();
    for (let i = 0; i < 3; i++) {
      const made = await createBooking({ courtId, date: addDays(todayISO(), 5), hours: [8 + i], name: "Other", phone: other });
      if (!made.ok) throw new Error(made.error);
    }
    const b = await book();
    const res = await patch(deskCookie, { code: b.code, phone: other });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "R9_DESK_UNPAID_VENUE" });
  });

  it("past its no-show strikes: refused unpaid, let through paid, and overridden by a manager where the venue allows it, on the record", async () => {
    await setCancelPolicy(venueId, { strikeLimit: 1 });
    const struck = phone();
    const old = await createBooking({ courtId, date: addDays(todayISO(), 6), hours: [9], name: "Struck", phone: struck });
    if (!old.ok) throw new Error(old.error);
    await moveBookingToDate(old.booking.id, addDays(todayISO(), -2));
    await getDb().prepare("UPDATE bookings SET no_show = 1 WHERE id = ?").run(old.booking.id);

    const unpaid = await book();
    const refusedDesk = await patch(deskCookie, { code: unpaid.code, phone: struck });
    expect(refusedDesk.status).toBe(409);
    expect(await refusedDesk.json()).toMatchObject({ code: "R9_DESK_STRIKES", policy: "strikes", overridable: false });
    // Paid already: as paid at the counter, which is what the strikes ask.
    const paid = await book({ paid: true });
    expect((await patch(deskCookie, { code: paid.code, phone: struck })).status).toBe(200);

    // The desk never overrides; a manager may, once the venue allows it, with a reason.
    const ask = { code: unpaid.code, phone: struck, overridePolicies: ["strikes"], overrideReason: "Regular, the no-show was our mistake" };
    expect((await patch(deskCookie, ask)).status).toBe(403);
    expect((await patch(managerCookie, ask)).status).toBe(403);
    await setVenueOverrides(venueId, ["strikes"], managerId);
    const done = await patch(managerCookie, ask);
    expect(done.status).toBe(200);
    expect((await rowOf(unpaid.code)).phone).toBe(struck);
    const kept = (await getDb().prepare("SELECT policy, reason, admin_name FROM booking_policy_overrides WHERE booking_id = ?").all(unpaid.id)) as object[];
    expect(kept).toEqual([{ policy: "strikes", reason: "Regular, the no-show was our mistake", admin_name: "Musa Manager" }]);
    const log = (await listActivity([venueId], { bookingCode: unpaid.code })).map((l) => l.action).sort();
    expect(log).toEqual(["booking.details_corrected", "booking.policy_overridden"]);
    await setCancelPolicy(venueId, { strikeLimit: null });
  });
});

describe("a whole series", () => {
  it("corrects the weeks still carrying the details, not a week given to somebody else", async () => {
    const who = phone();
    const made = await createBookingSeries({ courtId, date: addDays(todayISO(), 1), hours: [20], weeks: 3, name: "Liga Selasa", phone: who });
    if (!made.ok) throw new Error(made.error);
    const [w1, w2, w3] = made.bookings;
    // Week 2 was put in another player's name since.
    expect(await correctBookingDetails({ code: w2.code, name: "Other Captain", phone: "0199998888", staff })).toMatchObject({ ok: true });
    expect(await correctBookingDetails({ code: w1.code, scope: "series", name: "Liga Selasa KL", staff })).toMatchObject({
      ok: true,
      codes: [w1.code, w3.code],
    });
    expect((await rowOf(w1.code)).name).toBe("Liga Selasa KL");
    expect((await rowOf(w2.code)).name).toBe("Other Captain");
    expect((await rowOf(w3.code)).name).toBe("Liga Selasa KL");
    expect(await correctBookingDetails({ code: (await book()).code, scope: "series", name: "Nobody", staff })).toMatchObject({
      ok: false,
      error: CORRECTION_REFUSALS.noSeries,
    });
  });
});
