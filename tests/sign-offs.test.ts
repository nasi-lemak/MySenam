import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { registerUser } from "../src/lib/auth";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { updatePolicy } from "../src/lib/booking-policy";
import { getDb } from "../src/lib/db";
import { askToJoin, openGame } from "../src/lib/games";
import { createResources } from "../src/lib/resources";
import { addSignOff, revokeSignOff, signOffHolds } from "../src/lib/sign-offs";
import { createBooking, createBookingSeries, createVenue, joinSlotWaitlist, rescheduleBooking } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { DELETE as signOffsDelete, POST as signOffsPost } from "../src/app/api/admin/sign-offs/route";

/**
 * Sign-offs and certifications (docs/features/activities.md#sign-offs): a
 * typed phone number proves nothing, so online only the customer's own
 * account books on one; staff at the counter answer for who is in front of
 * them; a manager may go past it, on record; and no other way in — a weekly
 * series, a reschedule, a waiting list, an open game, a group of places —
 * gets round it.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (n: number) => addDays(todayISO(ZONE), n);
const at = (h: number) => h * 60;
let n = 0;
const phone = () => `0177${String(++n).padStart(6, "0")}`;

let business: number;
let venueId: number;
let branchId: number;
let wall: number;
let branchWall: number;
let lane: number;
let staffId: number;

/** A customer account, its number proved or not. */
async function customer(proved: boolean, number = phone()) {
  const made = await registerUser({ name: `Climber ${n}`, email: `climber${++n}@so.test`, phone: number, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  if (proved) await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now') WHERE id = ?").run(made.user.id);
  return { id: made.user.id, phone: number };
}

beforeAll(async () => {
  business = ((await getDb().prepare("INSERT INTO businesses (name) VALUES ('Crag Group') RETURNING id").get()) as { id: number }).id;
  const make = async (name: string, ph: string) => {
    const v = await createVenue({ name, area: "Puchong", address: "x", phone: ph, openMin: at(7), closeMin: at(23) });
    if (!v.ok) throw new Error("venue");
    await getDb().prepare("UPDATE venues SET business_id = ? WHERE id = ?").run(business, v.venue.id);
    return v.venue.id;
  };
  venueId = await make("Crag Puchong", "0312340101");
  branchId = await make("Crag Cheras", "0312340102");
  const res = async (venue: number, sport: string, name: string, capacity: number) => {
    const r = await createResources({ venueId: venue, sport, name, offPeakRate: 30, peakRate: 30, capacity });
    if (!r.ok) throw new Error(r.error);
    return r.courts[0].id;
  };
  wall = await res(venueId, "climbing", "Lead wall", 20);
  branchWall = await res(branchId, "climbing", "Branch wall", 20);
  lane = await res(venueId, "archery", "Lane A", 1);
  const admin = await createAdmin({ name: "Sam Staff", email: "sam@crag.my", password: "a long enough password", venueId });
  if (!admin.ok) throw new Error(admin.error);
  staffId = admin.admin.id;
});

describe("an activity that asks for a sign-off", () => {
  it("is refused to a guest, and to an account whose number is only typed", async () => {
    const who = phone();
    await addSignOff({ venueId, sport: "climbing", phone: who, name: "Typed", adminId: staffId });
    // The same number typed by a guest, or by an account that has not proved it, is not them.
    expect(await createBooking({ courtId: wall, date: day(3), start: at(9), end: at(11), name: "Guest", phone: who })).toMatchObject({
      ok: false,
      code: "SIGN_OFF_NEEDED",
    });
    const unproved = await customer(false, who);
    expect(await createBooking({ courtId: wall, date: day(3), start: at(9), end: at(11), name: "U", phone: who, userId: unproved.id })).toMatchObject({
      ok: false,
      code: "SIGN_OFF_NEEDED",
    });
  });

  it("books for the account that proved the number, or the one staff named", async () => {
    const proved = await customer(true);
    await addSignOff({ venueId, sport: "climbing", phone: proved.phone, name: "Proved", adminId: staffId });
    expect((await createBooking({ courtId: wall, date: day(3), start: at(12), end: at(14), name: "P", phone: proved.phone, userId: proved.id })).ok).toBe(true);
    // Named by email: that account, whatever number it types.
    const named = await customer(false);
    const so = await addSignOff({ venueId, sport: "climbing", phone: phone(), name: "Named", email: `climber${n - 1}@so.test`, adminId: staffId });
    expect(so).toMatchObject({ ok: true, signOff: { userId: named.id, adminId: staffId } });
    expect((await createBooking({ courtId: wall, date: day(3), start: at(15), end: at(17), name: "N", phone: named.phone, userId: named.id })).ok).toBe(true);
  });

  it("is booked at the counter for whoever staff see, and past the rules only on record", async () => {
    const who = phone();
    await addSignOff({ venueId, sport: "climbing", phone: who, name: "Walk-in", adminId: staffId });
    expect((await createBooking({ by: "staff", courtId: wall, date: day(4), start: at(9), end: at(11), name: "W", phone: who })).ok).toBe(true);
    expect(await createBooking({ by: "staff", courtId: wall, date: day(4), start: at(9), end: at(11), name: "X", phone: phone() })).toMatchObject({ ok: false });
    const past = await createBookingSeries({ by: "staff", staff: { override: true }, courtId: wall, date: day(4), start: at(9), end: at(11), weeks: 1, name: "Y", phone: phone() });
    expect(past).toMatchObject({ ok: true, overrides: ["SIGN_OFF"] });
  });

  it("covers one person: more places are booked at the counter", async () => {
    const proved = await customer(true);
    await addSignOff({ venueId, sport: "climbing", phone: proved.phone, name: "Group", adminId: staffId });
    expect(
      await createBooking({ courtId: wall, date: day(5), start: at(9), end: at(11), name: "G", phone: proved.phone, userId: proved.id, players: 3 })
    ).toMatchObject({ ok: false, code: "SIGN_OFF_EACH" });
  });

  it("must hold on the last week of a series, and on the day a booking moves to", async () => {
    const proved = await customer(true);
    await addSignOff({ venueId, sport: "climbing", phone: proved.phone, name: "Expiring", expiresOn: day(10), adminId: staffId });
    const series = await createBookingSeries({ courtId: wall, date: day(3), start: at(18), end: at(20), weeks: 3, name: "S", phone: proved.phone, userId: proved.id });
    expect(series).toMatchObject({ ok: false, code: "SIGN_OFF_NEEDED" });
    const one = await createBooking({ courtId: wall, date: day(3), start: at(18), end: at(20), name: "S", phone: proved.phone, userId: proved.id });
    if (!one.ok) throw new Error(one.error);
    expect(await rescheduleBooking(one.booking.code, { date: day(12), start: at(18) }, "customer")).toMatchObject({ ok: false, code: "SIGN_OFF_NEEDED" });
    expect(await rescheduleBooking(one.booking.code, { date: day(9), start: at(18) }, "customer")).toMatchObject({ ok: true });
  });

  it("stops when taken back, with who and why kept", async () => {
    const proved = await customer(true);
    const so = await addSignOff({ venueId, sport: "climbing", phone: proved.phone, name: "Revoked", adminId: staffId });
    if (!so.ok) throw new Error(so.error);
    expect(await revokeSignOff(venueId, so.signOff.id, { adminId: staffId, reason: "Unsafe belaying" })).toBe(true);
    expect(await createBooking({ courtId: wall, date: day(6), start: at(9), end: at(11), name: "R", phone: proved.phone, userId: proved.id })).toMatchObject({
      ok: false,
    });
    expect(await getDb().prepare("SELECT revoked_by, revoke_reason FROM sign_offs WHERE id = ?").get(so.signOff.id)).toEqual({
      revoked_by: staffId,
      revoke_reason: "Unsafe belaying",
    });
  });

  it("holds at every branch only when given for the business", async () => {
    const proved = await customer(true);
    await addSignOff({ venueId, sport: "climbing", phone: proved.phone, name: "Here only", adminId: staffId });
    const branch = (u: number) => createBooking({ courtId: branchWall, date: day(3), start: at(9), end: at(11), name: "B", phone: proved.phone, userId: u });
    expect(await branch(proved.id)).toMatchObject({ ok: false });
    await addSignOff({ venueId, wholeBusiness: true, sport: "climbing", phone: proved.phone, name: "Everywhere", adminId: staffId });
    expect((await branch(proved.id)).ok).toBe(true);
  });

  it("keeps people off the waiting list and out of open games without one", async () => {
    const guest = await customer(true);
    expect(await joinSlotWaitlist({ courtId: wall, date: day(7), start: at(9), end: at(11), name: "W", phone: guest.phone, userId: guest.id })).toMatchObject({
      ok: false,
      code: "SIGN_OFF_NEEDED",
    });
    // An archer signed off opens a game on their lane; another without one cannot join it.
    const host = await customer(true);
    await addSignOff({ venueId, sport: "archery", phone: host.phone, name: "Host", adminId: staffId });
    const booked = await createBooking({ courtId: lane, date: day(7), start: at(10), end: at(11), name: "H", phone: host.phone, userId: host.id });
    if (!booked.ok) throw new Error(booked.error);
    const game = await openGame(host.id, { bookingCode: booked.booking.code, spots: 2, level: null, share: 5, autoAccept: true });
    if (!game.ok) throw new Error(game.error);
    expect(await askToJoin({ id: guest.id, phone: guest.phone }, game.game.id)).toMatchObject({ ok: false, code: "SIGN_OFF_NEEDED" });
    await addSignOff({ venueId, sport: "archery", phone: guest.phone, name: "Guest", adminId: staffId });
    expect((await askToJoin({ id: guest.id, phone: guest.phone }, game.game.id)).ok).toBe(true);
  });
});

describe("a certification", () => {
  it("is what counts where the rules ask for one, and needs what was seen and an expiry", async () => {
    expect(await updatePolicy({ venue: venueId, sport: "archery" }, { certification: true })).toMatchObject({ ok: true });
    const proved = await customer(true);
    await addSignOff({ venueId, sport: "archery", phone: proved.phone, name: "Operational only", adminId: staffId });
    const book = () => createBooking({ courtId: lane, date: day(8), start: at(9), end: at(10), name: "C", phone: proved.phone, userId: proved.id });
    expect(await book()).toMatchObject({ ok: false, code: "CERTIFICATION_NEEDED" });
    expect(await addSignOff({ venueId, sport: "archery", kind: "certification", phone: proved.phone, name: "C", adminId: staffId })).toMatchObject({ ok: false });
    expect(
      await addSignOff({ venueId, sport: "archery", kind: "certification", reference: "NAM-12345, National Archery", expiresOn: day(300), phone: proved.phone, name: "Certified archer", adminId: staffId })
    ).toMatchObject({ ok: true, signOff: { kind: "certification" } });
    expect((await book()).ok).toBe(true);
    expect(await updatePolicy({ venue: venueId, sport: "archery" }, { certification: null })).toMatchObject({ ok: true });
  });

  it("is told apart from a sign-off when checked", async () => {
    const proved = await customer(true);
    await addSignOff({ venueId, sport: "climbing", phone: proved.phone, name: "Op", adminId: staffId });
    const base = { venueId, sport: "climbing", until: day(3), phone: proved.phone, userId: proved.id, channel: "customer" as const };
    expect(await signOffHolds({ ...base, need: "any" })).toBe(true);
    expect(await signOffHolds({ ...base, need: "certification" })).toBe(false);
  });
});

describe("the sign-offs route", () => {
  const call = async (adminId: number, method: "POST" | "DELETE", body?: unknown, query = "") => {
    const { token } = await createAdminSession(adminId);
    const req = new NextRequest(`http://localhost/api/admin/sign-offs${query}`, {
      method,
      headers: { "content-type": "application/json", cookie: `${ADMIN_SESSION_COOKIE}=${token}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return method === "POST" ? signOffsPost(req) : signOffsDelete(req);
  };

  it("takes the giver from the session, keeps every branch for the business, and records why one was taken back", async () => {
    const made = await call(staffId, "POST", { venueId, sport: "climbing", phone: phone(), name: "Route" });
    expect(made.status).toBe(201);
    const { signOff } = (await made.json()) as { signOff: { id: number; adminId: number } };
    expect(signOff.adminId).toBe(staffId);
    // A branch's staff cannot speak for every branch.
    expect((await call(staffId, "POST", { venueId, sport: "climbing", phone: phone(), name: "All", wholeBusiness: true })).status).toBe(403);
    const manager = await createAdmin({ name: "Group Manager", email: "gm@crag.my", password: "a long enough password", venueId: null, businessId: business });
    if (!manager.ok) throw new Error(manager.error);
    expect((await call(manager.admin.id, "POST", { venueId, sport: "climbing", phone: phone(), name: "All", wholeBusiness: true })).status).toBe(201);
    expect((await call(staffId, "DELETE", undefined, `?venueId=${venueId}&id=${signOff.id}&reason=Moved%20away`)).status).toBe(200);
    expect(await getDb().prepare("SELECT revoke_reason FROM sign_offs WHERE id = ?").get(signOff.id)).toEqual({ revoke_reason: "Moved away" });
  });
});
