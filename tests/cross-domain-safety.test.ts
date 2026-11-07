import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin, createAdmin, ensureBootstrapAdmin, getAdminById, type Admin } from "../src/lib/admin-auth";
import { apiCaller, createApiKey, type ApiScope } from "../src/lib/api-keys";
import { getDb } from "../src/lib/db";
import { safetyFlags } from "../src/lib/safety-flags";
import { addSignOff } from "../src/lib/sign-offs";
import { removeStaff } from "../src/lib/staff-accounts";
import { liftBusiness, suspendBusiness } from "../src/lib/suspensions";
import {
  accessCodeFor,
  cancelBooking,
  createBooking,
  createCourt,
  createVenue,
  recordInduction,
  rescheduleBooking,
  revokeInduction,
  setPaymentStatus,
  updateCourt,
  updateVenue,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Cross-domain regression tests, safety and access: eligibility is asked of a booking at every moment it can change, not only when it
 * is made (ADR 0058, 0020, 0026, 0064). Scenarios the existing suites already hold on their own (a refused number on every desk path,
 * a customer cancelling after a door code, a self check-in not being verified attendance, a staff account without two-factor on a
 * production marketplace) are listed in the report of the round; these are the interactions between them.
 */

vi.setConfig({ testTimeout: 60_000 });

const ZONE = "Asia/Kuala_Lumpur";
const day = (n: number) => addDays(todayISO(ZONE), n);
let seq = 0;
const phone = () => `0165${String(500000 + ++seq)}`;
afterEach(() => vi.useRealTimers());

/** A venue whose counter is staffed from 6 to 18 only, so 12:00 is a staffed hour and 20:00 is one the door is the way in. */
async function nightVenue() {
  const v = await createVenue({ name: `XS Night ${++seq}`, area: "Setapak", address: "x", phone: `03124${String(seq).padStart(5, "0")}`, openMin: 6 * 60, closeMin: 23 * 60 });
  if (!v.ok) throw new Error("venue");
  await getDb().prepare("UPDATE venues SET published_at = now() WHERE id = ?").run(v.venue.id);
  const staffed = await updateVenue(v.venue.id, { staffedFrom: 6, staffedTo: 18 });
  if (!staffed.ok) throw new Error(staffed.error);
  const court = await createCourt({ venueId: v.venue.id, name: `XS Court ${++seq}`, sport: "badminton", offPeakRate: 15, peakRate: 25, capacity: 1 });
  if (!court.ok) throw new Error(court.error);
  const open = await updateCourt(court.court.id, { unmanned: true, accessCode: "4821" });
  if (!open.ok) throw new Error(open.error);
  await getDb().prepare("INSERT INTO approval_requirements (venue_id, sport, declaration) VALUES (?, 'badminton', 'I can play safely.')").run(v.venue.id);
  return { venueId: v.venue.id, courtId: court.court.id };
}

describe("a booking moved from a staffed hour to an hour the door is the way in (ADR 0058 E3 + the move)", () => {
  it("asks the same sign-off the booking would have been asked for at that hour, and moves nothing when it is lacking", async () => {
    const { venueId, courtId } = await nightVenue();
    const who = phone();
    // At a staffed hour the counter is there: no sign-off is asked at booking.
    const made = await createBooking({ courtId, date: day(3), hours: [12], name: "Walk", phone: who });
    if (!made.ok) throw new Error(JSON.stringify(made));
    // The same hour in the dark is refused at booking, as it was always meant to be.
    expect(await createBooking({ courtId, date: day(3), hours: [20], name: "Walk", phone: phone() })).toMatchObject({ ok: false, code: "SIGN_OFF_NEEDED" });
    // Moving the staffed booking into it must be asked the same: otherwise the door refuses at the gate with the money taken.
    const moved = await rescheduleBooking(made.booking.code, { date: day(3), start: 20 * 60 }, "staff");
    expect(moved).toMatchObject({ ok: false, code: "SIGN_OFF_NEEDED" });
    expect(await getDb().prepare("SELECT start_min FROM bookings WHERE id = ?").get(made.booking.id)).toEqual({ start_min: 12 * 60 });
    // A customer is asked the same, and their own account's sign-off is what they would need (staff's record is for staff).
    expect(await rescheduleBooking(made.booking.code, { date: day(3), start: 20 * 60 }, "customer")).toMatchObject({ ok: false, code: "SIGN_OFF_NEEDED" });
    // With the sign-off the staff move is allowed, and the booking is where it was moved to.
    expect((await addSignOff({ venueId, sport: "badminton", phone: who, name: "Walk", adminId: null })).ok).toBe(true);
    expect((await rescheduleBooking(made.booking.code, { date: day(3), start: 20 * 60 }, "staff")).ok).toBe(true);
    expect(await getDb().prepare("SELECT start_min FROM bookings WHERE id = ?").get(made.booking.id)).toEqual({ start_min: 20 * 60 });
  });

  it("the other way, from the dark into the counter's hours, needs nothing", async () => {
    const { venueId, courtId } = await nightVenue();
    const who = phone();
    expect((await addSignOff({ venueId, sport: "badminton", phone: who, name: "Night", adminId: null })).ok).toBe(true);
    const made = await createBooking({ courtId, date: day(4), hours: [20], name: "Night", phone: who, by: "staff" });
    if (!made.ok) throw new Error(JSON.stringify(made));
    expect((await rescheduleBooking(made.booking.code, { date: day(4), start: 12 * 60 }, "staff")).ok).toBe(true);
  });
});

describe("a certification that runs out between the booking and the day it is moved to (ADR 0058 + the move)", () => {
  it("covers the day booked, is refused for a move past its last day, and the door gives the code on the day it covers", async () => {
    const { venueId, courtId } = await nightVenue();
    await getDb().prepare("UPDATE approval_requirements SET kind = 'certification' WHERE venue_id = ? AND sport = 'badminton'").run(venueId);
    const who = phone();
    const cert = await addSignOff({ venueId, sport: "badminton", kind: "certification", reference: "XS-1, National Federation", expiresOn: day(10), phone: who, name: "Certified", adminId: null });
    if (!cert.ok) throw new Error(cert.error);
    // Booked for day 8 in the dark (the door asks the certification), by staff for the number.
    const made = await createBooking({ courtId, date: day(8), hours: [20], name: "Certified", phone: who, by: "staff" });
    if (!made.ok) throw new Error(JSON.stringify(made));
    // Moved to day 12, after the certification's last day: refused, nothing moved. Day 9, still covered: allowed.
    expect(await rescheduleBooking(made.booking.code, { date: day(12), start: 20 * 60 }, "staff")).toMatchObject({ ok: false, code: "CERTIFICATION_NEEDED" });
    expect(await getDb().prepare("SELECT date FROM bookings WHERE id = ?").get(made.booking.id)).toEqual({ date: day(8) });
    expect((await rescheduleBooking(made.booking.code, { date: day(9), start: 20 * 60 }, "staff")).ok).toBe(true);
    // On the day it covers, with the induction and the money, the door gives its code.
    await setPaymentStatus(made.booking.code, true, "cash");
    expect((await recordInduction({ venueId, phone: who, name: "Certified" })).ok).toBe(true);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${day(9)}T19:30:00+08:00`));
    expect(await accessCodeFor(made.booking.code, who)).toMatchObject({ ok: true, accessCode: "4821" });
  });
});

describe("a sign-off or induction taken back, then the booking moved, cancelled or opened with a code (ADR 0058 + 0069)", () => {
  async function revokeSignOffAndFlag(venueId: number, id: number) {
    const { revokeSignOff, signOffAt } = await import("../src/lib/sign-offs");
    const { signOffTakenBack } = await import("../src/lib/safety-flags");
    const so = (await signOffAt(venueId, id))!;
    expect(await revokeSignOff(venueId, id, { adminId: null, reason: "Failed a re-check" })).toBe(true);
    return signOffTakenBack(so, { name: "Mira" }, "Failed a re-check");
  }
  async function flaggedBooking() {
    const { venueId, courtId } = await nightVenue();
    const who = phone();
    const so = await addSignOff({ venueId, sport: "badminton", phone: who, name: "Member", adminId: null });
    if (!so.ok) throw new Error(so.error);
    expect((await recordInduction({ venueId, phone: who, name: "Member" })).ok).toBe(true);
    const made = await createBooking({ courtId, date: day(5), hours: [20], name: "Member", phone: who, by: "staff", email: `member${seq}@xs.test` });
    if (!made.ok) throw new Error(JSON.stringify(made));
    await setPaymentStatus(made.booking.code, true, "cash");
    expect(await revokeSignOffAndFlag(venueId, so.signOff.id)).toBe(1);
    return { venueId, courtId, who, booking: made.booking };
  }

  it("the door waits for staff, a move to another dark hour is refused, and the customer's cancellation leaves nothing for staff to decide", async () => {
    const { venueId, who, booking } = await flaggedBooking();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${day(5)}T19:30:00+08:00`));
    expect(await accessCodeFor(booking.code, who)).toMatchObject({ ok: false, reason: "flagged" });
    vi.useRealTimers();
    // The sign-off is gone: a move to another hour in the dark is asked the same and refused (no override goes past it).
    expect(await rescheduleBooking(booking.code, { date: day(5), start: 21 * 60 }, "staff")).toMatchObject({ ok: false, code: "SIGN_OFF_NEEDED" });
    expect((await safetyFlags([venueId])).map((f) => f.bookingCode)).toEqual([booking.code]);
    // Cancelling is never taken away from the customer, and a cancelled booking is no decision for staff.
    expect((await cancelBooking(booking.code, who)).ok).toBe(true);
    expect(await safetyFlags([venueId])).toEqual([]);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${day(5)}T19:30:00+08:00`));
    expect(await accessCodeFor(booking.code, who)).toMatchObject({ ok: false });
  });

  it("an induction withdrawn as well leaves one flagged booking, and the customer is told no more than once for each thing taken back", async () => {
    const { venueId, booking } = await flaggedBooking();
    const { inductionTakenBack } = await import("../src/lib/safety-flags");
    const inductions = (await getDb().prepare("SELECT id FROM inductions WHERE venue_id = ? AND revoked_at IS NULL").all(venueId)) as { id: number }[];
    for (const i of inductions) {
      const done = await revokeInduction(i.id);
      if (done.ok) await inductionTakenBack(done.induction, { name: "Mira" });
    }
    const flags = await safetyFlags([venueId]);
    expect(new Set(flags.map((f) => f.bookingCode))).toEqual(new Set([booking.code]));
    expect(flags.map((f) => f.what).sort()).toEqual(["induction", "sign-off"]);
    const told = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages WHERE kind = 'booking_safety_notice' AND booking_id = ?").get(booking.id)) as { n: number };
    expect(told.n).toBe(2);
  });
});

describe("a credential of a removed manager, and a suspended venue (ADR 0064 + 0063)", () => {
  let owner: Admin;
  beforeAll(async () => {
    await ensureBootstrapAdmin();
    owner = (await getAdminById((await authenticateAdmin("admin@mysenam.my", "mysenam-admin"))!.id))!;
  });
  const request = (key: string) => new NextRequest("http://localhost/api/v1/venue", { headers: { authorization: `Bearer ${key}`, "x-forwarded-for": "203.0.113.19" } });
  async function use(key: string, need: ApiScope = "read"): Promise<number> {
    const caller = await apiCaller(request(key), need);
    return caller instanceof NextResponse ? caller.status : 200;
  }
  async function keyOf(venueId: number, by: Admin, scope: ApiScope, ownership: "venue" | "person") {
    const made = await createApiKey(venueId, { name: `XS Key ${++seq}`, scope, ownership }, by.id);
    if (!made.ok) throw new Error(made.error);
    return made.key;
  }

  async function chain() {
    const v = await createVenue({ name: `XS Keys ${++seq}`, area: "PJ", address: "1 Jalan Kunci", phone: `03778${String(seq).padStart(5, "0")}` });
    if (!v.ok) throw new Error(v.error);
    const biz = ((await getDb().prepare("INSERT INTO businesses (name) VALUES (?) RETURNING id").get(`XS Chain ${seq}`)) as { id: number }).id;
    await getDb().prepare("UPDATE venues SET business_id = ? WHERE id = ?").run(biz, v.venue.id);
    const mgr = await createAdmin({ name: `XS Manager ${seq}`, email: `xsmgr${seq}@keys.my`, password: "a long enough password", venueId: v.venue.id, role: "manager" });
    if (!mgr.ok) throw new Error(mgr.error);
    return { venueId: v.venue.id, businessId: biz, manager: mgr.admin };
  }

  it("a removed manager's key is refused during the suspension and after it is lifted; the venue's own key reads while suspended and never writes", async () => {
    const c = await chain();
    const personal = await keyOf(c.venueId, c.manager, "write", "person");
    const shared = await keyOf(c.venueId, c.manager, "write", "venue");
    expect(await suspendBusiness(c.businessId, "A dispute")).toMatchObject({ ok: true });
    // Suspended: the venue's key reads, no key writes.
    expect(await use(shared, "read")).toBe(200);
    expect(await use(shared, "write")).toBe(403);
    expect(await use(personal, "read")).toBe(200);
    expect(await use(personal, "write")).toBe(403);
    // The manager is removed while the venue is suspended: their key is refused at the very next use, reads included.
    expect(await removeStaff(owner, c.manager.id)).toMatchObject({ ok: true, credentials: { stopped: 1 } });
    expect(await use(personal, "read")).toBe(401);
    expect(await use(personal, "write")).toBe(401);
    expect(await use(shared, "read")).toBe(200);
    expect(await use(shared, "write")).toBe(403);
    // Lifted: the venue's key writes again; the removed manager's key is never revived by it.
    expect(await liftBusiness(c.businessId)).toMatchObject({ ok: true });
    expect(await use(shared, "write")).toBe(200);
    expect(await use(personal, "read")).toBe(401);
    expect(await use(personal, "write")).toBe(401);
  });

  it("a key used while its owner is removed and the venue suspended at once is answered or refused, never an error", async () => {
    const c = await chain();
    const personal = await keyOf(c.venueId, c.manager, "write", "person");
    const statuses = await Promise.all([
      use(personal, "write"),
      suspendBusiness(c.businessId, "A dispute").then(() => use(personal, "write")),
      removeStaff(owner, c.manager.id).then(() => use(personal, "read")),
      use(personal, "read"),
    ]);
    for (const s of statuses) expect([200, 401, 403]).toContain(s);
    expect(await use(personal, "read")).toBe(401);
    expect(await use(personal, "write")).toBe(401);
  });
});
