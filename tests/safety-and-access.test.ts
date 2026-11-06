import { afterEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { moveClasses } from "../src/lib/class-moves";
import { getDb } from "../src/lib/db";
import { blockPhone, unblockPhone } from "../src/lib/limits";
import { reviewable } from "../src/lib/reviews";
import { safetyFlags, settleCoveredFlags } from "../src/lib/safety-flags";
import { createResources } from "../src/lib/resources";
import { addSignOff } from "../src/lib/sign-offs";
import {
  accessCodeFor,
  adminCancelBooking,
  attendanceVerified,
  checkIn,
  checkInByToken,
  createBooking,
  createClassSessions,
  createCourt,
  createVenue,
  enrolInClass,
  findBookingByCode,
  inductionStillNeeded,
  listBookingsForDate,
  recordInduction,
  setNoShow,
  setPaymentStatus,
  updateCourt,
  updateVenue,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import * as attentionRoute from "../src/app/api/admin/attention/route";
import { DELETE as signOffsDelete } from "../src/app/api/admin/sign-offs/route";
import { DELETE as inductionsDelete } from "../src/app/api/admin/inductions/[id]/route";
import { POST as blockedPost } from "../src/app/api/admin/venues/[id]/blocked-phones/route";

/**
 * Safety and access after a booking was made (ADR 0058): a number the venue refuses loses the door and the QR code at once and
 * its bookings are left for a decision; an unstaffed time asks what the door asks, at booking; a sign-off, certification or
 * induction taken back flags the bookings it affected, the customer told once; and a customer's own check-in is not verified
 * attendance until staff confirm it.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (n: number) => addDays(todayISO(ZONE), n);
let seq = 0;
const phone = () => `0165${String(++seq).padStart(6, "0")}`;
const email = () => `cust${seq}@fx9.test`;

afterEach(() => vi.useRealTimers());

async function newVenue(label: string, staffing: "always" | "never" = "always") {
  const v = await createVenue({ name: `FX9 ${label} ${++seq}`, area: "Setapak", address: "x", phone: `03123${String(seq).padStart(5, "0")}`, openMin: 6 * 60, closeMin: 23 * 60 });
  if (!v.ok) throw new Error("venue");
  await getDb().prepare("UPDATE venues SET published_at = now() WHERE id = ?").run(v.venue.id);
  if (staffing === "never") {
    const done = await updateVenue(v.venue.id, { staffedFrom: 0, staffedTo: 0 });
    if (!done.ok) throw new Error(done.error);
  }
  return v.venue.id;
}

async function doorCourt(venueId: number, sport = "badminton") {
  const made = await createCourt({ venueId, name: `Night court ${++seq}`, sport, offPeakRate: 15, peakRate: 25, capacity: 1 });
  if (!made.ok) throw new Error(made.error);
  const open = await updateCourt(made.court.id, { unmanned: true, accessCode: "4821" });
  if (!open.ok) throw new Error(open.error);
  return made.court.id;
}

async function staffCookie(venueId: number, role: "manager" | "desk" = "manager") {
  const made = await createAdmin({ name: `Staff ${++seq}`, email: `staff${seq}@fx9.test`, password: "a long enough password", venueId, role });
  if (!made.ok) throw new Error(made.error);
  return { id: made.admin.id, name: made.admin.name, cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}` };
}

const call = (route: typeof attentionRoute, who: { cookie: string }, method: "GET" | "POST", body?: unknown) => {
  const req = new NextRequest("http://localhost/api/admin/attention", {
    method,
    headers: { "content-type": "application/json", cookie: who.cookie },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return method === "GET" ? route.GET(req) : route.POST(req);
};

async function book(courtId: number, who: string, date: string, hour: number, extra: { email?: string; by?: "staff" } = {}) {
  const made = await createBooking({ courtId, date, hours: [hour], name: "Customer", phone: who, ...extra });
  if (!made.ok) throw new Error(made.error);
  return made.booking;
}

/** A two-hour climb (the wall sells time in lengths of its own). */
async function climb(wall: number, who: string, date: string, from = 9, extra: { email?: string } = {}) {
  const made = await createBooking({ courtId: wall, date, start: from * 60, end: (from + 2) * 60, name: "Climber", phone: who, by: "staff", ...extra });
  if (!made.ok) throw new Error(made.error);
  return made.booking;
}

describe("E2: a number the venue refuses", () => {
  it("gets no door code, even paid, inducted and booked before", async () => {
    const venueId = await newVenue("Blocked door", "never");
    const court = await doorCourt(venueId);
    const who = phone();
    expect((await recordInduction({ venueId, phone: who, name: "Troublemaker" })).ok).toBe(true);
    const date = day(2);
    const booking = await book(court, who, date, 12);
    await setPaymentStatus(booking.code, true, "cash");
    const admin = await staffCookie(venueId);
    const blocked = await blockPhone({ venueId, phone: who, reason: "Vandalised the gym", adminId: admin.id, adminName: admin.name });
    expect(blocked).toMatchObject({ ok: true, flagged: 1 });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${date}T11:30:00+08:00`));
    expect(await accessCodeFor(booking.code, who)).toMatchObject({ ok: false, reason: "blocked", code: "FX9_DOOR_BLOCKED" });
    // Nothing was cancelled, nothing was checked in.
    expect((await findBookingByCode(booking.code))?.status).toBe("confirmed");
    expect((await findBookingByCode(booking.code))?.checkedInAt).toBeNull();
    // Another number's booking at the same venue is untouched.
    const other = phone();
    await recordInduction({ venueId, phone: other, name: "Fine" });
    vi.useRealTimers();
    const fine = await book(court, other, date, 13);
    await setPaymentStatus(fine.code, true, "cash");
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${date}T12:30:00+08:00`));
    expect(await accessCodeFor(fine.code, other)).toMatchObject({ ok: true, accessCode: "4821" });
  });

  it("lists the number's upcoming bookings once, shows the count, cancels none, and lets the manager cancel or leave", async () => {
    const venueId = await newVenue("Blocked list");
    const gym = await createCourt({ venueId, name: `Gym ${++seq}`, sport: "gym", offPeakRate: 5, peakRate: 8, capacity: 10 });
    if (!gym.ok) throw new Error("gym");
    const who = phone();
    const a = await book(gym.court.id, who, day(3), 10);
    const b = await book(gym.court.id, who, day(4), 10);
    const elsewhere = await newVenue("Elsewhere");
    const elseCourt = await createCourt({ venueId: elsewhere, name: `Other ${++seq}`, sport: "gym", offPeakRate: 5, peakRate: 8, capacity: 10 });
    if (!elseCourt.ok) throw new Error("court");
    const far = await book(elseCourt.court.id, who, day(3), 10);
    const manager = await staffCookie(venueId);
    const desk = await staffCookie(venueId, "desk");
    const req = (body: unknown) => new NextRequest("http://x/api", { method: "POST", headers: { "content-type": "application/json", cookie: manager.cookie }, body: JSON.stringify(body) });
    const res = await blockedPost(req({ phone: who, reason: "Harassed staff" }), { params: Promise.resolve({ id: String(venueId) }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { flagged: number }).flagged).toBe(2);
    // Asking again does not list the same bookings twice.
    expect(await blockPhone({ venueId, phone: who, reason: "Harassed staff", adminId: manager.id, adminName: manager.name })).toMatchObject({ ok: true, flagged: 2 });
    const listed = (await safetyFlags([venueId])).filter((f) => f.kind === "blocked");
    expect(listed.map((f) => f.bookingCode).sort()).toEqual([a.code, b.code].sort());
    expect(listed[0]).toMatchObject({ what: "blocked", venueId });
    expect((await safetyFlags([elsewhere])).length).toBe(0);
    expect((await findBookingByCode(a.code))?.status).toBe("confirmed");
    expect((await findBookingByCode(far.code))?.status).toBe("confirmed");
    // The needs-attention list carries them, to the desk too; only a manager leaves one.
    const seen = (await (await call(attentionRoute, desk, "GET")).json()) as { safetyFlags: { bookingCode: string; reason: string }[] };
    expect(seen.safetyFlags.map((f) => f.bookingCode).sort()).toEqual([a.code, b.code].sort());
    expect(seen.safetyFlags[0].reason).toBe("Harassed staff");
    const flagId = listed[0].id;
    expect((await call(attentionRoute, desk, "POST", { action: "safetyFlag", flagId, note: "fine" })).status).toBe(403);
    expect((await call(attentionRoute, manager, "POST", { action: "safetyFlag", flagId })).status).toBe(400);
    const other = await staffCookie(elsewhere);
    expect((await call(attentionRoute, other, "POST", { action: "safetyFlag", flagId, note: "not mine" })).status).toBe(403);
    expect((await call(attentionRoute, manager, "POST", { action: "safetyFlag", flagId, note: "Paid in full, supervised by staff" })).status).toBe(200);
    expect((await safetyFlags([venueId])).map((f) => f.bookingCode)).toEqual([listed.find((f) => f.id !== flagId)!.bookingCode]);
    // Cancelled by staff (with the refund the ordinary way): it leaves the list on its own.
    const left = listed.find((f) => f.id !== flagId)!;
    expect((await adminCancelBooking(left.bookingCode)).ok).toBe(true);
    expect(await safetyFlags([venueId])).toEqual([]);
  });

  it("settles what was listed when the number is taken off the refused list", async () => {
    const venueId = await newVenue("Unblock");
    const gym = await createCourt({ venueId, name: `Gym ${++seq}`, sport: "gym", offPeakRate: 5, peakRate: 8, capacity: 10 });
    if (!gym.ok) throw new Error("gym");
    const who = phone();
    await book(gym.court.id, who, day(3), 10);
    await blockPhone({ venueId, phone: who, adminId: 1, adminName: "Mgr" });
    expect((await safetyFlags([venueId])).length).toBe(1);
    expect(await unblockPhone(venueId, who, "Mgr")).toBe(true);
    expect(await safetyFlags([venueId])).toEqual([]);
  });

  it("leaves out a booking that is over, and lists a class enrolment of the number too", async () => {
    const venueId = await newVenue("Class block");
    const studio = await createCourt({ venueId, name: `Studio ${++seq}`, sport: "gym", offPeakRate: 5, peakRate: 8, capacity: 10 });
    if (!studio.ok) throw new Error("studio");
    const made = await createClassSessions({ courtId: studio.court.id, name: "FX9 class", instructor: "Aina", date: day(5), startHour: 18, endHour: 19, capacity: 5, price: 20 });
    if (!made.ok) throw new Error(made.error);
    const who = phone();
    const e = await enrolInClass({ classId: made.classes[0].id, name: "Pupil", phone: who });
    if (!e.ok) throw new Error(e.error);
    // One that is long over (set directly: a booking cannot be made in the past).
    const over = await book(studio.court.id, who, day(2), 10);
    await getDb().prepare("UPDATE bookings SET date = ?, starts_at = now() - interval '3 days', ends_at = now() - interval '3 days' + interval '1 hour' WHERE id = ?").run(day(-3), over.id);
    const out = await blockPhone({ venueId, phone: who, adminId: 1, adminName: "Mgr" });
    expect(out).toMatchObject({ ok: true, flagged: 1 });
    expect((await safetyFlags([venueId]))[0]).toMatchObject({ bookingCode: e.booking.code, classId: made.classes[0].id });
  });

  it("refuses the QR check-in of a refused number, while the desk (a person looking at them) can still check them in", async () => {
    const venueId = await newVenue("Blocked QR");
    const gym = await createCourt({ venueId, name: `Gym ${++seq}`, sport: "gym", offPeakRate: 5, peakRate: 8, capacity: 10 });
    if (!gym.ok) throw new Error("gym");
    const who = phone();
    const date = todayISO(ZONE);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${date}T08:30:00+08:00`));
    const booking = await book(gym.court.id, who, date, 10);
    await blockPhone({ venueId, phone: who, adminId: 1, adminName: "Mgr" });
    vi.setSystemTime(new Date(`${date}T10:05:00+08:00`));
    const token = ((await getDb().prepare("SELECT check_in_token FROM bookings WHERE id = ?").get(booking.id)) as { check_in_token: string }).check_in_token;
    expect(await checkInByToken(token)).toMatchObject({ ok: false, code: "FX9_DOOR_BLOCKED" });
    expect((await findBookingByCode(booking.code))?.checkedInAt).toBeNull();
    expect((await checkIn(booking.code)).ok).toBe(true);
  });
});

describe("E3: an unstaffed time asks, at booking, what the door will ask", () => {
  it("refuses a customer without the sign-off an activity asks, and books one who holds it", async () => {
    const venueId = await newVenue("Asks sign-off", "never");
    const court = await doorCourt(venueId, "badminton");
    await getDb().prepare("INSERT INTO approval_requirements (venue_id, sport, declaration) VALUES (?, 'badminton', 'I can play safely.')").run(venueId);
    const stranger = phone();
    expect(await createBooking({ courtId: court, date: day(3), hours: [12], name: "Stranger", phone: stranger })).toMatchObject({ ok: false, code: "SIGN_OFF_NEEDED" });
    const signed = phone();
    expect((await addSignOff({ venueId, sport: "badminton", phone: signed, name: "Signed", adminId: null })).ok).toBe(true);
    expect((await createBooking({ courtId: court, date: day(3), hours: [12], name: "Signed", phone: signed, by: "staff" })).ok).toBe(true);
  });

  it("keeps a staffed time's flow: the same activity is booked without it where the counter is open", async () => {
    const venueId = await newVenue("Staffed asks", "always");
    const court = await doorCourt(venueId, "badminton");
    await getDb().prepare("INSERT INTO approval_requirements (venue_id, sport, declaration) VALUES (?, 'badminton', 'I can play safely.')").run(venueId);
    expect((await createBooking({ courtId: court, date: day(3), hours: [12], name: "Walk", phone: phone() })).ok).toBe(true);
  });

  it("tells, not refuses, an induction still to be had (it is taken at the desk before play)", async () => {
    const venueId = await newVenue("Induction told", "never");
    const court = await doorCourt(venueId);
    const fresh = phone();
    const booking = await book(court, fresh, day(3), 12);
    expect(await inductionStillNeeded(booking)).toBe(true);
    expect((await recordInduction({ venueId, phone: fresh, name: "Fresh" })).ok).toBe(true);
    expect(await inductionStillNeeded(booking)).toBe(false);
    // The door's own check is still the second line.
    const uninducted = phone();
    const second = await book(court, uninducted, day(3), 14);
    await setPaymentStatus(second.code, true, "cash");
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${day(3)}T13:30:00+08:00`));
    expect(await accessCodeFor(second.code, uninducted)).toMatchObject({ ok: false, reason: "no-induction" });
  });

  it("says nothing of an induction where the counter is open", async () => {
    const venueId = await newVenue("Staffed induction", "always");
    const court = await doorCourt(venueId);
    const booking = await book(court, phone(), day(3), 12);
    expect(await inductionStillNeeded(booking)).toBe(false);
  });
});

describe("E4: a sign-off, certification or induction taken back after bookings were made", () => {
  async function climbingVenue() {
    const venueId = await newVenue("Crag");
    const r = await createResources({ venueId, sport: "climbing", name: `Wall ${++seq}`, offPeakRate: 30, peakRate: 30, capacity: 20 });
    if (!r.ok) throw new Error(r.error);
    return { venueId, wall: r.courts[0].id };
  }
  const takeBack = async (staff: { id: number; cookie: string }, venueId: number, id: number, reason: string) =>
    signOffsDelete(
      new NextRequest(`http://localhost/api/admin/sign-offs?venueId=${venueId}&id=${id}&reason=${encodeURIComponent(reason)}`, {
        method: "DELETE",
        headers: { cookie: staff.cookie },
      })
    );

  it("flags the person's upcoming bookings with who, when and why, tells the customer once, cancels nothing", async () => {
    const { venueId, wall } = await climbingVenue();
    const staff = await staffCookie(venueId);
    const who = phone();
    const so = await addSignOff({ venueId, sport: "climbing", phone: who, name: "Climber", adminId: staff.id });
    if (!so.ok) throw new Error(so.error);
    const booking = await climb(wall, who, day(3), 9, { email: email() });
    // A stranger cannot book it: the rule asks for a sign-off.
    expect(await createBooking({ courtId: wall, date: day(3), start: 9 * 60, end: 11 * 60, name: "Stranger", phone: phone() })).toMatchObject({ ok: false, code: "SIGN_OFF_NEEDED" });
    const res = await takeBack(staff, venueId, so.signOff.id, "Unsafe belaying");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { flagged: number }).flagged).toBe(1);
    expect((await findBookingByCode(booking.code))?.status).toBe("confirmed");
    const flags = await safetyFlags([venueId]);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ kind: "eligibility", what: "sign-off", reason: "Unsafe belaying", by: staff.name, bookingCode: booking.code, told: true });
    expect(flags[0].createdAt).not.toBe("");
    const told = (await getDb().prepare("SELECT recipient, kind, body FROM messages WHERE kind = 'booking_safety_notice' AND booking_id = ?").all(booking.id)) as { recipient: string; body: string }[];
    expect(told).toHaveLength(1);
    expect(told[0].body).toContain(booking.code);
    expect(told[0].body).toContain("Unsafe belaying");
    // Asking again (the same person's other sign-off, or a repeat) tells nobody twice.
    const again = await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages WHERE kind = 'booking_safety_notice' AND booking_id = ?").get(booking.id);
    expect(again).toEqual({ n: 1 });
  });

  it("is told by staff when the booking has no email, and a plain flag for each booking", async () => {
    const { venueId, wall } = await climbingVenue();
    const staff = await staffCookie(venueId);
    const who = phone();
    const so = await addSignOff({ venueId, sport: "climbing", phone: who, name: "No Mail", adminId: staff.id });
    if (!so.ok) throw new Error(so.error);
    await climb(wall, who, day(3));
    await climb(wall, who, day(4));
    await takeBack(staff, venueId, so.signOff.id, "Moved away");
    const flags = await safetyFlags([venueId]);
    expect(flags).toHaveLength(2);
    expect(flags.every((f) => f.told === false)).toBe(true);
  });

  it("flags nothing when another sign-off still covers the person", async () => {
    const { venueId, wall } = await climbingVenue();
    const staff = await staffCookie(venueId);
    const who = phone();
    const first = await addSignOff({ venueId, sport: "climbing", phone: who, name: "Twice", adminId: staff.id });
    if (!first.ok) throw new Error(first.error);
    // An anything-here sign-off is a different one (it replaces only its own kind and activity).
    const second = await addSignOff({ venueId, sport: null, phone: who, name: "Twice", adminId: staff.id });
    if (!second.ok) throw new Error(second.error);
    await climb(wall, who, day(3));
    const res = await takeBack(staff, venueId, first.signOff.id, "Replaced by the general one");
    expect(((await res.json()) as { flagged: number }).flagged).toBe(0);
    expect(await safetyFlags([venueId])).toEqual([]);
    // Taking the last one back does flag it.
    const last = await takeBack(staff, venueId, second.signOff.id, "Gone");
    expect(((await last.json()) as { flagged: number }).flagged).toBe(1);
  });

  it("holds the door code until staff decide, at an unstaffed hour; a staffed venue's booking is flagged, not blocked", async () => {
    const venueId = await newVenue("Door flags", "never");
    const court = await doorCourt(venueId, "badminton");
    await getDb().prepare("INSERT INTO approval_requirements (venue_id, sport, declaration) VALUES (?, 'badminton', 'I can play safely.')").run(venueId);
    const staff = await staffCookie(venueId);
    const who = phone();
    const so = await addSignOff({ venueId, sport: "badminton", phone: who, name: "Member", adminId: staff.id });
    if (!so.ok) throw new Error(so.error);
    await recordInduction({ venueId, phone: who, name: "Member" });
    const date = day(2);
    const booking = await book(court, who, date, 12, { by: "staff" });
    await setPaymentStatus(booking.code, true, "cash");
    await takeBack(staff, venueId, so.signOff.id, "Failed a re-check");
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${date}T11:30:00+08:00`));
    expect(await accessCodeFor(booking.code, who)).toMatchObject({ ok: false, reason: "flagged", code: "FX9_DOOR_FLAGGED" });
    vi.useRealTimers();
    // Granted again: the flag settles on its own and the door gives the code.
    expect((await addSignOff({ venueId, sport: "badminton", phone: who, name: "Member", adminId: staff.id })).ok).toBe(true);
    expect(await safetyFlags([venueId])).toEqual([]);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${date}T11:30:00+08:00`));
    expect(await accessCodeFor(booking.code, who)).toMatchObject({ ok: true, accessCode: "4821" });
  });

  it("does not block a staffed venue's flagged booking at the desk", async () => {
    const { venueId, wall } = await climbingVenue();
    const staff = await staffCookie(venueId);
    const who = phone();
    const so = await addSignOff({ venueId, sport: "climbing", phone: who, name: "Desk", adminId: staff.id });
    if (!so.ok) throw new Error(so.error);
    const date = day(2);
    const booking = await createBooking({ courtId: wall, date, start: 9 * 60, end: 11 * 60, name: "Desk", phone: who, by: "staff" });
    if (!booking.ok) throw new Error(booking.error);
    await takeBack(staff, venueId, so.signOff.id, "Reassessed");
    expect((await safetyFlags([venueId])).length).toBe(1);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${date}T09:10:00+08:00`));
    expect((await checkIn(booking.booking.code)).ok).toBe(true);
  });

  it("flags bookings at an unmanned door when an induction is withdrawn, and settles them when it is given again", async () => {
    const venueId = await newVenue("Induction flags", "never");
    const court = await doorCourt(venueId);
    const staff = await staffCookie(venueId);
    const who = phone();
    const ind = await recordInduction({ venueId, phone: who, name: "Inducted" });
    if (!ind.ok) throw new Error(ind.error);
    const booking = await book(court, who, day(3), 12, { email: email() });
    const res = await inductionsDelete(new NextRequest(`http://localhost/api/admin/inductions/${ind.induction.id}`, { method: "DELETE", headers: { cookie: staff.cookie } }), {
      params: Promise.resolve({ id: String(ind.induction.id) }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { flagged: number }).flagged).toBe(1);
    expect(await safetyFlags([venueId])).toHaveLength(1);
    expect((await safetyFlags([venueId]))[0]).toMatchObject({ kind: "eligibility", what: "induction", bookingCode: booking.code });
    expect(await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages WHERE kind = 'booking_safety_notice' AND booking_id = ?").get(booking.id)).toEqual({ n: 1 });
    expect((await recordInduction({ venueId, phone: who, name: "Inducted" })).ok).toBe(true);
    expect(await safetyFlags([venueId])).toEqual([]);
    expect(await settleCoveredFlags(venueId)).toBe(0);
  });

  it("flags nothing on a staffed court when an induction is withdrawn (the desk is there)", async () => {
    const venueId = await newVenue("Staffed induction flags", "always");
    const gym = await createCourt({ venueId, name: `Gym ${++seq}`, sport: "gym", offPeakRate: 5, peakRate: 8, capacity: 10 });
    if (!gym.ok) throw new Error("gym");
    const who = phone();
    const ind = await recordInduction({ venueId, phone: who, name: "Staffed" });
    if (!ind.ok) throw new Error(ind.error);
    await book(gym.court.id, who, day(3), 12);
    const staff = await staffCookie(venueId);
    const res = await inductionsDelete(new NextRequest(`http://localhost/api/admin/inductions/${ind.induction.id}`, { method: "DELETE", headers: { cookie: staff.cookie } }), {
      params: Promise.resolve({ id: String(ind.induction.id) }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { flagged: number }).flagged).toBe(0);
    expect(await safetyFlags([venueId])).toEqual([]);
  });
});

describe("E7: a customer's own check-in is not verified attendance", () => {
  async function studioCourt(venueId: number, capacity = 10) {
    const made = await createCourt({ venueId, name: `Studio ${++seq}`, sport: "gym", offPeakRate: 5, peakRate: 8, capacity });
    if (!made.ok) throw new Error("court");
    return made.court;
  }
  const tokenOf = async (id: number) => ((await getDb().prepare("SELECT check_in_token FROM bookings WHERE id = ?").get(id)) as { check_in_token: string }).check_in_token;
  const noShowOf = async (id: number) => ((await getDb().prepare("SELECT no_show FROM bookings WHERE id = ?").get(id)) as { no_show: number }).no_show;

  it("does not undo the desk's no-show mark, and is recorded as a self check-in staff can confirm with one tap", async () => {
    const venueId = await newVenue("Self no-show");
    const court = await studioCourt(venueId, 1);
    const date = todayISO(ZONE);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${date}T08:30:00+08:00`));
    const booking = await book(court.id, phone(), date, 10);
    vi.setSystemTime(new Date(`${date}T10:20:00+08:00`));
    expect(await setNoShow(booking.code, true)).toMatchObject({ ok: true });
    vi.setSystemTime(new Date(`${date}T10:30:00+08:00`));
    expect((await checkInByToken(await tokenOf(booking.id))).ok).toBe(true);
    expect(await noShowOf(booking.id)).toBe(1);
    expect(await attendanceVerified(booking.id)).toBe(false);
    // Visible to staff, as the customer's own.
    const shown = (await listBookingsForDate(date, venueId)).find((b) => b.id === booking.id)!;
    expect(shown).toMatchObject({ checkedInAt: expect.any(String), checkInSource: "self", checkInConfirmed: false });
    // One tap by the desk: it counts, and the strike goes.
    expect((await checkIn(booking.code, { by: { adminId: null, name: "Desk" } })).ok).toBe(true);
    expect(await attendanceVerified(booking.id)).toBe(true);
    expect(await noShowOf(booking.id)).toBe(0);
    expect((await listBookingsForDate(date, venueId)).find((b) => b.id === booking.id)).toMatchObject({ checkInSource: "self", checkInConfirmed: true });
    // And a second tap is the plain refusal.
    expect(await checkIn(booking.code)).toMatchObject({ ok: false, error: "Already checked in." });
  });

  it("still lets the desk's own check-in clear a no-show, as before", async () => {
    const venueId = await newVenue("Desk no-show");
    const court = await studioCourt(venueId, 1);
    const date = todayISO(ZONE);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${date}T08:30:00+08:00`));
    const booking = await book(court.id, phone(), date, 10);
    vi.setSystemTime(new Date(`${date}T10:20:00+08:00`));
    await setNoShow(booking.code, true);
    expect((await checkIn(booking.code)).ok).toBe(true);
    expect(await noShowOf(booking.id)).toBe(0);
    expect(await attendanceVerified(booking.id)).toBe(true);
  });

  it("lets staff mark a no-show after a remote tap, but not after they confirmed the arrival", async () => {
    const venueId = await newVenue("Tap then no-show");
    const court = await studioCourt(venueId, 1);
    const date = todayISO(ZONE);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${date}T09:30:00+08:00`));
    const booking = await book(court.id, phone(), date, 10);
    vi.setSystemTime(new Date(`${date}T09:45:00+08:00`));
    expect((await checkInByToken(await tokenOf(booking.id))).ok).toBe(true);
    vi.setSystemTime(new Date(`${date}T10:20:00+08:00`));
    expect(await setNoShow(booking.code, true)).toMatchObject({ ok: true });
    expect(await noShowOf(booking.id)).toBe(1);
    await checkIn(booking.code); // confirmed: the desk saw them
    expect(await noShowOf(booking.id)).toBe(0);
    expect(await setNoShow(booking.code, true)).toMatchObject({ ok: false });
  });

  it("does not freeze a class move, until staff confirm somebody arrived", async () => {
    const venueId = await newVenue("Class move");
    const court = await studioCourt(venueId);
    const other = await studioCourt(venueId);
    const date = day(4);
    const made = await createClassSessions({ courtId: court.id, name: "FX9 move", instructor: "Aina", date, startHour: 18, endHour: 19, capacity: 5, price: 20 });
    if (!made.ok) throw new Error(made.error);
    const cl = made.classes[0];
    const e = await enrolInClass({ classId: cl.id, name: "Early Bird", phone: phone() });
    if (!e.ok) throw new Error(e.error);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${date}T17:05:00+08:00`));
    expect((await checkInByToken(await tokenOf(e.booking.id))).ok).toBe(true);
    // Moved to the other room for the same hour: a remote tap froze it before.
    const moved = await moveClasses({ id: null, name: "Mona" }, cl.id, { date, start: 18 * 60, courtId: other.id });
    expect(moved).toMatchObject({ ok: true });
  });

  it("freezes a class move once the desk confirmed an arrival", async () => {
    const venueId = await newVenue("Class move frozen");
    const court = await studioCourt(venueId);
    const other = await studioCourt(venueId);
    const date = day(5);
    const made = await createClassSessions({ courtId: court.id, name: "FX9 frozen", instructor: "Aina", date, startHour: 18, endHour: 19, capacity: 5, price: 20 });
    if (!made.ok) throw new Error(made.error);
    const cl = made.classes[0];
    const e = await enrolInClass({ classId: cl.id, name: "Early Bird", phone: phone() });
    if (!e.ok) throw new Error(e.error);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${date}T17:05:00+08:00`));
    expect((await checkIn(e.booking.code)).ok).toBe(true);
    const moved = await moveClasses({ id: null, name: "Mona" }, cl.id, { date, start: 18 * 60, courtId: other.id });
    expect(moved).toMatchObject({ ok: false, code: "CLSA_MOVE_ATTENDANCE" });
  });

  it("records a door code revealed as the customer's own, clears no no-show, and counts for the headcount", async () => {
    const venueId = await newVenue("Door self", "never");
    const court = await doorCourt(venueId);
    const who = phone();
    await recordInduction({ venueId, phone: who, name: "Door" });
    const date = day(2);
    const booking = await book(court, who, date, 12);
    await setPaymentStatus(booking.code, true, "cash");
    await getDb().prepare("UPDATE bookings SET no_show = 1 WHERE id = ?").run(booking.id);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${date}T11:30:00+08:00`));
    expect(await accessCodeFor(booking.code, who)).toMatchObject({ ok: true, presentNow: 1 });
    expect(await getDb().prepare("SELECT source FROM check_ins WHERE booking_id = ?").get(booking.id)).toEqual({ source: "door" });
    expect(await noShowOf(booking.id)).toBe(1);
    expect(await attendanceVerified(booking.id)).toBe(false);
  });

  it("does not make an unpaid priced booking reviewable until staff confirm the arrival", async () => {
    const venueId = await newVenue("Review");
    const court = await studioCourt(venueId, 1);
    const date = todayISO(ZONE);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${date}T08:30:00+08:00`));
    const booking = await book(court.id, phone(), date, 10);
    vi.setSystemTime(new Date(`${date}T10:10:00+08:00`));
    expect((await checkInByToken(await tokenOf(booking.id))).ok).toBe(true);
    vi.setSystemTime(new Date(`${date}T12:00:00+08:00`));
    expect(await reviewable(booking.code, new Date())).toMatchObject({ ok: false, code: "REVIEW_NOT_PLAYED" });
    await checkIn(booking.code);
    expect(await reviewable(booking.code, new Date())).toMatchObject({ ok: true });
  });
});
