import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";
process.env.MYSENAM_PAYMENT_PROVIDERS = "billplz,stripe";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import * as deskRoute from "../src/app/api/admin/entries/route";
import * as selfRoute from "../src/app/api/entries/route";
import { GET as venueApi } from "../src/app/api/v1/venue/route";
import { BUILTIN_ACTIVITIES } from "../src/lib/activity-catalogue";
import { listActivity } from "../src/lib/activity";
import { setAccessSettings } from "../src/lib/access";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { createApiKey } from "../src/lib/api-keys";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { policyFor, updatePolicy, validateSettings } from "../src/lib/booking-policy";
import { getDb } from "../src/lib/db";
import { admitEntry, closeEndedEntries, entryCount, entryOptions, entryResource, openEntries, publicEntries, type AdmitInput } from "../src/lib/entries";
import { availableCapabilities, requireCapability } from "../src/lib/guide/capabilities";
import { playbookFor } from "../src/lib/guide/playbook/server";
import { blockPhone } from "../src/lib/limits";
import { createPlan, setPlanBenefits } from "../src/lib/membership-plans";
import { createPassProduct } from "../src/lib/pass-products";
import { createAtVenue } from "../src/lib/participants";
import { savePaymentSettings, settleBill, startPassPayment } from "../src/lib/payments";
import { resetRateLimits } from "../src/lib/rate-limit";
import { createResources } from "../src/lib/resources";
import { addSignOff } from "../src/lib/sign-offs";
import { createBooking, createVenue, getLiveOccupancy, getOccupancy, issuePass, listPassesFor, payBookingWithPass, sellMembership, voidPass } from "../src/lib/store";
import { suspendMembership } from "../src/lib/membership-suspensions";
import { addDays, todayISO } from "../src/lib/time";
import { setWaiver } from "../src/lib/waivers";

/**
 * Entry with no set time (docs/features/venue-operations.md#entry-with-no-set-time;
 * lib/entries.ts): a resource with places that lets people in as they come,
 * off until the venue turns it on; admitted on a membership whose plan admits,
 * a pass (one entry each), a day pass (one entry, then all that day) or a
 * walk-in sold at the counter; counted against the places bookings do not
 * hold now, under the resource's lock; with every check a booking makes.
 */

let venueId: number;
let wall: number; // bouldering, 3 places, entry on, walk-in RM20
let gym: number; // gym floor, 10 places, entry on, free walk-in, self check-in
let climb: number; // climbing (sign-off asked by the catalogue), entry on
let plain: number; // bouldering at another venue, entry never turned on
let plainVenue: number;
let manager: { id: number; name: string };
let deskCookie: string;
let n = 0;
const phone = () => `0166${String(++n).padStart(6, "0")}`;
const today = todayISO();

const req = (url: string, init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) =>
  new NextRequest(`http://localhost${url}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${n % 250}`, ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers ?? {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });

const desk = (courtId: number, who: { name: string; phone: string; participantId?: number | null }, by: AdmitInput["by"], extra: Partial<AdmitInput> = {}) =>
  admitEntry({ courtId, person: { participantId: who.participantId ?? null, name: who.name, phone: who.phone }, by, channel: "desk", staff: manager, ...extra });

async function customer(name: string) {
  const p = phone();
  const made = await registerUser({ name, email: `entry${++n}@example.my`, phone: p, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  // A proved number, as a customer's own membership online asks.
  await getDb().prepare("UPDATE users SET verified_phone = phone, phone_verified_at = now() WHERE id = ?").run(made.user.id);
  return { id: made.user.id, name, phone: p, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}

async function pass(courtVenue: number, holder: { name: string; phone: string; userId?: number }, opts: { entries?: number; dayPass?: boolean; scope?: "booking" | "participant" | "places"; participantId?: number | null } = {}) {
  const made = await issuePass({
    venueId: courtVenue,
    name: opts.dayPass ? "Day pass" : "Ten climbs",
    entries: opts.dayPass ? 1 : (opts.entries ?? 10),
    entryMinutes: null,
    price: opts.dayPass ? 25 : 150,
    holderName: holder.name,
    holderPhone: holder.phone,
    expiresOn: addDays(today, 30),
    adminId: manager.id,
    userId: holder.userId,
    scope: opts.dayPass ? "participant" : (opts.scope ?? "booking"),
    holderParticipantId: opts.participantId ?? null,
    dayPass: opts.dayPass === true,
    paidVia: "Cash",
  });
  if (!made.ok) throw new Error(made.error);
  return made.pass;
}

const left = async (passId: number) =>
  ((await getDb().prepare("SELECT entries + COALESCE((SELECT SUM(delta) FROM pass_entries WHERE pass_id = ?), 0) AS n FROM passes WHERE id = ?").get(passId, passId)) as { n: number }).n;

beforeAll(async () => {
  const v = await createVenue({ name: "Crux Climbing", area: "Petaling Jaya", address: "1 Jalan Batu", phone: "0312340000", openMin: 0, closeMin: 24 * 60 });
  if (!v.ok) throw new Error(v.error);
  venueId = v.venue.id;
  const mk = async (sport: string, capacity: number) => {
    const made = await createResources({ venueId, sport, count: 1, offPeakRate: 20, peakRate: 20, capacity, maxPlayers: Math.min(6, capacity) });
    if (!made.ok) throw new Error(made.error);
    return made.courts[0].id;
  };
  wall = await mk("bouldering", 3);
  gym = await mk("gym", 10);
  climb = await mk("climbing", 10);
  const other = await createVenue({ name: "Boulder Barn", area: "Petaling Jaya", address: "2 Jalan Batu", phone: "0312340001", openMin: 0, closeMin: 24 * 60 });
  if (!other.ok) throw new Error(other.error);
  plainVenue = other.venue.id;
  const p = await createResources({ venueId: plainVenue, sport: "bouldering", count: 1, offPeakRate: 20, peakRate: 20, capacity: 20, maxPlayers: 6 });
  if (!p.ok) throw new Error(p.error);
  plain = p.courts[0].id;

  const m = await createAdmin({ name: "Mona Manager", email: "manager@crux.test", password: "a long enough password", venueId, role: "manager" });
  if (!m.ok) throw new Error("admin");
  manager = { id: m.admin.id, name: m.admin.name };
  const d = await createAdmin({ name: "Dani Desk", email: "desk@crux.test", password: "a long enough password", venueId, role: "desk" });
  if (!d.ok) throw new Error("admin");
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(d.admin.id)).token}`;

  // Entry turned on where the venue says, and nowhere else.
  expect((await updatePolicy({ court: wall }, { entryMode: true, entryPrice: 20, entryMaxStay: 180 })).ok).toBe(true);
  expect((await updatePolicy({ court: gym }, { entryMode: true, entryPrice: 0, entrySelfCheckIn: true })).ok).toBe(true);
  expect((await updatePolicy({ court: climb }, { entryMode: true, entryPrice: 30 })).ok).toBe(true);
});

afterEach(async () => {
  await resetRateLimits();
});

describe("the catalogue and the rules", () => {
  it("marks climbing, bouldering and a gym as suited to entry, fully supported, and turns it on nowhere by itself", async () => {
    for (const key of ["climbing", "bouldering", "gym"]) {
      const a = BUILTIN_ACTIVITIES.find((x) => x.key === key)!;
      expect([a.support, a.supportNote, a.entrySuited]).toEqual(["full", null, true]);
      expect(a.policy.entryMode).toBeUndefined();
    }
    const policy = await policyFor({ id: plain, venueId: plainVenue, sport: "bouldering" });
    expect([policy.entryMode, policy.entryPrice, policy.entryMaxStay, policy.entrySelfCheckIn]).toEqual([false, null, 240, false]);
    expect(await entryResource(plain)).toBeNull();
    expect(validateSettings({ entryMaxStay: 10 })).toMatchObject({ ok: false });
    expect(validateSettings({ entryMode: "yes" })).toMatchObject({ ok: false });
    expect(validateSettings({ entryMode: true, entryPrice: 12.5, entryMaxStay: 120, entrySelfCheckIn: false })).toMatchObject({ ok: true });
  });

  it("refuses an entry where the resource does not take them, and books it as before (regression)", async () => {
    const who = { name: "Plain Pat", phone: phone() };
    expect(await desk(plain, who, { kind: "walk_in", via: "cash" })).toMatchObject({ ok: false, code: "NBK_NOT_ENTRY" });
    const booked = await createBooking({ courtId: plain, date: addDays(today, 2), start: 10 * 60, end: 11 * 60, name: who.name, phone: who.phone, players: 2 });
    expect(booked.ok).toBe(true);
    // A resource of one place never takes entries, whatever its rules say.
    const court = await createResources({ venueId: plainVenue, sport: "badminton", count: 1, offPeakRate: 20, peakRate: 20 });
    if (!court.ok) throw new Error(court.error);
    await updatePolicy({ court: court.courts[0].id }, { entryMode: true });
    expect(await entryResource(court.courts[0].id)).toBeNull();
  });
});

describe("what lets somebody in", () => {
  it("a membership whose plan admits, at the activity it is for; a plan that does not admit lets nobody in", async () => {
    const admits = await createPlan(venueId, { name: "Gym monthly", months: 1, price: 120, admitsEntry: true, admitsEntrySport: "gym" });
    const plainPlan = await createPlan(venueId, { name: "Supporter", months: 1, price: 50 });
    if (!admits.ok || !plainPlan.ok) throw new Error("plans");
    expect(admits.plan).toMatchObject({ admitsEntry: true, admitsEntrySport: "gym" });
    const member = { name: "Gym Gita", phone: phone() };
    const sold = await sellMembership({ venueId, holderName: member.name, holderPhone: member.phone, startsOn: today, expiresOn: addDays(today, 30), price: 120, adminId: manager.id, tierId: admits.plan.id });
    expect(sold.ok).toBe(true);
    const ok = await desk(gym, member, { kind: "membership" });
    expect(ok).toMatchObject({ ok: true, admittedBy: "membership" });
    // Gym only: not the wall.
    expect(await desk(wall, member, { kind: "membership" })).toMatchObject({ ok: false, code: "NBK_NO_MEMBERSHIP" });
    const supporter = { name: "Sam Supporter", phone: phone() };
    await sellMembership({ venueId, holderName: supporter.name, holderPhone: supporter.phone, startsOn: today, expiresOn: addDays(today, 30), price: 50, adminId: manager.id, tierId: plainPlan.plan.id });
    expect(await desk(gym, supporter, { kind: "membership" })).toMatchObject({ ok: false, code: "NBK_NO_MEMBERSHIP" });
    // Turned on later for that plan: its members come in from now.
    expect((await setPlanBenefits(venueId, plainPlan.plan.id, { ratePercent: null, aheadDays: null, admitsEntry: true })).ok).toBe(true);
    expect(await desk(gym, supporter, { kind: "membership" })).toMatchObject({ ok: true });
  });

  it("a membership suspended today lets nobody in", async () => {
    const plan = await createPlan(venueId, { name: "Floor pass", months: 1, price: 90, admitsEntry: true });
    if (!plan.ok) throw new Error(plan.error);
    const who = { name: "Paused Pam", phone: phone() };
    const sold = await sellMembership({ venueId, holderName: who.name, holderPhone: who.phone, startsOn: today, expiresOn: addDays(today, 30), price: 90, adminId: manager.id, tierId: plan.plan.id });
    if (!sold.ok) throw new Error(sold.error);
    expect((await suspendMembership(manager, sold.membership.id, { from: today, until: addDays(today, 2), reason: "Behaviour review" })).ok).toBe(true);
    expect(await desk(gym, who, { kind: "membership" })).toMatchObject({ ok: false, code: "NBK_NO_MEMBERSHIP" });
  });

  it("a pass spends one entry an admission, and the same person is not let in twice at once", async () => {
    const who = { name: "Pass Priya", phone: phone() };
    const p = await pass(venueId, who);
    const first = await desk(wall, who, { kind: "pass", passId: p.id });
    expect(first).toMatchObject({ ok: true, admittedBy: "pass", pass: { code: p.code, remaining: 9, dayPass: false } });
    expect(await left(p.id)).toBe(9);
    expect(await desk(wall, who, { kind: "pass", passId: p.id })).toMatchObject({ ok: false, code: "NBK_ALREADY_IN" });
    expect(await left(p.id)).toBe(9);
    // The ledger names the entry.
    const line = (await getDb().prepare("SELECT reason, entry_id FROM pass_entries WHERE pass_id = ?").get(p.id)) as { reason: string; entry_id: number };
    expect(line.entry_id).toBe(first.ok ? first.id : -1);
    // Somebody else's pass is not theirs to use.
    expect(await desk(gym, { name: "Other Olu", phone: phone() }, { kind: "pass", passId: p.id })).toMatchObject({ ok: false, code: "NBK_PASS" });
  });

  it("a day pass: one entry, then in and out all that day, and nothing on another day; it pays for no booking", async () => {
    const who = { name: "Day Dewi", phone: phone() };
    const day = await pass(venueId, who, { dayPass: true });
    const first = await desk(wall, who, { kind: "pass", passId: day.id });
    expect(first).toMatchObject({ ok: true, admittedBy: "day_pass" });
    expect(await left(day.id)).toBe(0);
    expect(((await getDb().prepare("SELECT day_used_on::text AS d FROM passes WHERE id = ?").get(day.id)) as { d: string }).d).toBe(today);
    // Out, and back in the same day (and into another resource): nothing more spent.
    const out = await deskRoute.POST(req("/api/admin/entries", { method: "POST", cookie: deskCookie, body: { venueId, entryId: first.ok ? first.id : 0, out: true } }));
    expect(out.status).toBe(200);
    expect(await desk(wall, who, { kind: "pass", passId: day.id })).toMatchObject({ ok: true, admittedBy: "day_pass" });
    expect(await desk(gym, who, { kind: "pass", passId: day.id })).toMatchObject({ ok: true });
    expect(await left(day.id)).toBe(0);
    // The next day it is used up.
    await getDb().prepare("UPDATE passes SET day_used_on = ?::date WHERE id = ?").run(addDays(today, -1), day.id);
    await getDb().prepare("UPDATE entries SET checked_out_at = now(), out_reason = 'checked_out' WHERE pass_id = ? AND checked_out_at IS NULL").run(day.id);
    expect(await desk(wall, who, { kind: "pass", passId: day.id })).toMatchObject({ ok: false, code: "NBK_PASS" });
    // Not a way to pay for a booking.
    const booked = await createBooking({ courtId: wall, date: addDays(today, 3), start: 10 * 60, end: 11 * 60, name: who.name, phone: who.phone, players: 1 });
    if (!booked.ok) throw new Error(booked.error);
    const fresh = await pass(venueId, who, { dayPass: true });
    expect(await payBookingWithPass(booked.booking.id, fresh.code)).toMatchObject({ ok: false });
  });

  it("refunds a day pass as any pass: unused in full, used nothing", async () => {
    const who = { name: "Refund Ravi", phone: phone() };
    const unused = await pass(venueId, who, { dayPass: true });
    expect(await voidPass(unused.id, { refund: true })).toMatchObject({ ok: true, refunded: 25 });
    const used = await pass(venueId, who, { dayPass: true });
    expect(await desk(gym, who, { kind: "pass", passId: used.id })).toMatchObject({ ok: true });
    expect(await voidPass(used.id, { refund: true })).toMatchObject({ ok: true, refunded: 0 });
  });

  it("a walk-in at the resource's price is a counter sale with its receipt; none where no price is set, and how it was paid is asked", async () => {
    const who = { name: "Walk Wan", phone: phone() };
    expect(await desk(climb, { name: "No Way", phone: phone() }, { kind: "walk_in", via: "nonsense" })).toMatchObject({ ok: false, code: "NBK_VIA" });
    await addSignOff({ venueId, sport: "climbing", phone: who.phone, name: who.name, adminId: manager.id });
    const made = await desk(climb, who, { kind: "walk_in", via: "cash" });
    expect(made).toMatchObject({ ok: true, admittedBy: "walk_in" });
    if (!made.ok) return;
    expect(made.receipt?.number).toBeTruthy();
    const sale = (await getDb().prepare("SELECT total::float AS total, paid_via, customer_phone FROM counter_sales WHERE id = ?").get(made.saleId)) as { total: number; paid_via: string; customer_phone: string };
    expect(sale).toEqual({ total: 30, paid_via: "cash", customer_phone: who.phone });
    const receipt = (await getDb().prepare("SELECT total::float AS total, kind FROM receipts WHERE source = ?").get(`sale:${made.saleId}`)) as { total: number; kind: string };
    expect(receipt).toEqual({ total: 30, kind: "receipt" });
    // A resource with no price sells no walk-in.
    await updatePolicy({ court: wall }, { entryMode: true, entryPrice: null, entryMaxStay: 180 });
    expect(await desk(wall, { name: "No Price", phone: phone() }, { kind: "walk_in", via: "cash" })).toMatchObject({ ok: false, code: "NBK_NO_WALK_IN" });
    await updatePolicy({ court: wall }, { entryMode: true, entryPrice: 20, entryMaxStay: 180 });
  });
});

describe("capacity", () => {
  it("counts places a booking holds now, refuses the last-but-none, and a check-out frees a place", async () => {
    // A fresh resource of four places, two of them held by a session overlapping now.
    const made = await createResources({ venueId, sport: "bouldering", count: 1, offPeakRate: 20, peakRate: 20, capacity: 4, maxPlayers: 4 });
    if (!made.ok) throw new Error(made.error);
    const room = made.courts[0].id;
    await updatePolicy({ court: room }, { entryMode: true, entryPrice: 0 });
    const booked = await createBooking({ courtId: room, date: addDays(today, 2), start: 10 * 60, end: 11 * 60, name: "Session Sue", phone: phone(), players: 2 });
    if (!booked.ok) throw new Error(booked.error);
    // The session moved to now (a booked session overlapping this moment).
    await getDb()
      .prepare(
        `UPDATE claims SET during = tstzrange(date_trunc('minute', now()) - interval '10 minutes', date_trunc('minute', now()) + interval '50 minutes'),
                occupied = tstzrange(date_trunc('minute', now()) - interval '10 minutes', date_trunc('minute', now()) + interval '50 minutes') WHERE booking_id = ?`
      )
      .run(booked.booking.id);
    const resource = (await entryResource(room))!;
    expect(await entryCount(resource)).toMatchObject({ entries: 0, held: 2, free: 2 });
    const a = await desk(room, { name: "First In", phone: phone() }, { kind: "walk_in", via: "cash" });
    const b = await desk(room, { name: "Second In", phone: phone() }, { kind: "walk_in", via: "cash" });
    expect([a.ok, b.ok]).toEqual([true, true]);
    expect(await desk(room, { name: "Third Out", phone: phone() }, { kind: "walk_in", via: "cash" })).toMatchObject({ ok: false, code: "NBK_FULL" });
    expect(await entryCount(resource)).toMatchObject({ entries: 2, held: 2, free: 0, level: "full" });
    // One leaves: room for one more.
    const out = await deskRoute.POST(req("/api/admin/entries", { method: "POST", cookie: deskCookie, body: { venueId, entryId: a.ok ? a.id : 0, out: true } }));
    expect(out.status).toBe(200);
    expect(await desk(room, { name: "Third In", phone: phone() }, { kind: "walk_in", via: "cash" })).toMatchObject({ ok: true });
    // Checking out twice is refused.
    const again = await deskRoute.POST(req("/api/admin/entries", { method: "POST", cookie: deskCookie, body: { venueId, entryId: a.ok ? a.id : 0, out: true } }));
    expect(again.status).toBe(409);
  });

  it("lets nobody in beyond the places when several come at once (the resource's lock)", async () => {
    const made = await createResources({ venueId, sport: "gym", count: 1, offPeakRate: 20, peakRate: 20, capacity: 3, maxPlayers: 3 });
    if (!made.ok) throw new Error(made.error);
    const room = made.courts[0].id;
    await updatePolicy({ court: room }, { entryMode: true, entryPrice: 0 });
    const tries = await Promise.all(Array.from({ length: 8 }, (_, i) => desk(room, { name: `Rush ${i}`, phone: phone() }, { kind: "walk_in", via: "cash" })));
    expect(tries.filter((t) => t.ok)).toHaveLength(3);
    expect(tries.filter((t) => !t.ok).every((t) => !t.ok && t.code === "NBK_FULL")).toBe(true);
    const { n: inside } = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM entries WHERE court_id = ?").get(room)) as { n: number };
    expect(inside).toBe(3);
  });

  it("stops counting an entry past the longest stay without any job, and the tidy closes it", async () => {
    const made = await createResources({ venueId, sport: "gym", count: 1, offPeakRate: 20, peakRate: 20, capacity: 2, maxPlayers: 2 });
    if (!made.ok) throw new Error(made.error);
    const room = made.courts[0].id;
    await updatePolicy({ court: room }, { entryMode: true, entryPrice: 0, entryMaxStay: 30 });
    const a = await desk(room, { name: "Long Stay", phone: phone() }, { kind: "walk_in", via: "cash" });
    if (!a.ok) throw new Error(a.error);
    expect(new Date(a.stayUntil).getTime() - Date.now()).toBeLessThanOrEqual(30 * 60_000);
    const resource = (await entryResource(room))!;
    expect((await entryCount(resource)).entries).toBe(1);
    await getDb().prepare("UPDATE entries SET admitted_at = now() - interval '2 hours', stay_until = now() - interval '1 minute' WHERE id = ?").run(a.id);
    expect((await entryCount(resource)).entries).toBe(0);
    expect((await openEntries(venueId)).some((e) => e.id === a.id)).toBe(false);
    expect(await closeEndedEntries()).toBeGreaterThanOrEqual(1);
    expect(((await getDb().prepare("SELECT out_reason FROM entries WHERE id = ?").get(a.id)) as { out_reason: string }).out_reason).toBe("stay_ended");
  });
});

describe("what every admission asks, as a booking does", () => {
  it("the waiver, agreed on paper at the desk and kept", async () => {
    const v = await createVenue({ name: "Waiver Walls", area: "Klang", address: "3 Jalan Batu", phone: "0312340002", openMin: 0, closeMin: 24 * 60 });
    if (!v.ok) throw new Error(v.error);
    const made = await createResources({ venueId: v.venue.id, sport: "bouldering", count: 1, offPeakRate: 20, peakRate: 20, capacity: 10, maxPlayers: 6 });
    if (!made.ok) throw new Error(made.error);
    const room = made.courts[0].id;
    await updatePolicy({ court: room }, { entryMode: true, entryPrice: 0 });
    await setWaiver(v.venue.id, "Climbing is dangerous. You climb at your own risk.");
    const who = { name: "Wary Wei", phone: phone() };
    expect(await desk(room, who, { kind: "walk_in", via: "cash" })).toMatchObject({ ok: false, code: "WAIVER_NEEDED" });
    expect(await desk(room, who, { kind: "walk_in", via: "cash" }, { agreeWaiver: true })).toMatchObject({ ok: true });
    const signed = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM waiver_signatures WHERE phone_key = phone_key(?)").get(who.phone)) as { n: number };
    expect(signed.n).toBe(1);
  });

  it("the activity's sign-off (a belay check on the climbing wall)", async () => {
    const who = { name: "Belay Ben", phone: phone() };
    expect(await desk(climb, who, { kind: "walk_in", via: "cash" })).toMatchObject({ ok: false, code: "SIGN_OFF_NEEDED" });
  });

  it("a refused number, and who a members-only venue is for", async () => {
    const blocked = { name: "Barred Bo", phone: phone() };
    await blockPhone({ venueId, phone: blocked.phone, adminId: manager.id });
    expect(await desk(wall, blocked, { kind: "walk_in", via: "cash" })).toMatchObject({ ok: false, code: "PHONE_BLOCKED" });
    const v = await createVenue({ name: "Members Gym", area: "Klang", address: "4 Jalan Batu", phone: "0312340003", openMin: 0, closeMin: 24 * 60 });
    if (!v.ok) throw new Error(v.error);
    const made = await createResources({ venueId: v.venue.id, sport: "gym", count: 1, offPeakRate: 0, peakRate: 0, capacity: 10, maxPlayers: 1 });
    if (!made.ok) throw new Error(made.error);
    await updatePolicy({ court: made.courts[0].id }, { entryMode: true, entryPrice: 10 });
    await setAccessSettings(v.venue.id, { access: "members" });
    expect(await desk(made.courts[0].id, { name: "Not A Member", phone: phone() }, { kind: "walk_in", via: "cash" })).toMatchObject({ ok: false, code: "R9_NOT_MEMBER" });
  });

  it("a child is let in as themself, only on a guardian's number", async () => {
    const guardian = { name: "Parent Pua", phone: phone() };
    const child = await createAtVenue({
      venueId,
      admin: manager,
      displayName: "Kid Kai",
      birthYear: 2015,
      guardian: { name: guardian.name, phone: guardian.phone, relationship: "parent", authority: true },
    });
    if (!child.ok) throw new Error(child.error);
    const kid = child.participant.id;
    // On somebody else's number: refused.
    expect(await desk(wall, { name: "Kid Kai", phone: phone(), participantId: kid }, { kind: "walk_in", via: "cash" })).toMatchObject({ ok: false, code: "PBK_NOT_GUARDIAN" });
    // Their own day pass, on the guardian's number.
    const day = await pass(venueId, guardian, { dayPass: true, participantId: kid });
    // The guardian's own options do not include the child's pass.
    const resource = (await entryResource(wall))!;
    expect((await entryOptions(resource, { participantId: null, name: guardian.name, phone: guardian.phone }, "desk")).passes.map((p) => p.id)).not.toContain(day.id);
    const made = await desk(wall, { name: "Kid Kai", phone: guardian.phone, participantId: kid }, { kind: "pass", passId: day.id });
    expect(made).toMatchObject({ ok: true, admittedBy: "day_pass" });
    const row = (await getDb().prepare("SELECT takes_part_as, participant_id, user_id FROM entries WHERE id = ?").get(made.ok ? made.id : 0)) as Record<string, unknown>;
    expect(row).toEqual({ takes_part_as: "participant", participant_id: kid, user_id: null });
    // Through the desk's screen: the child appears on the guardian's number with their own options.
    const found = await deskRoute.GET(req(`/api/admin/entries?venueId=${venueId}&courtId=${wall}&phone=${guardian.phone}`, { cookie: deskCookie }));
    const body = await found.json();
    expect(body.participants.map((p: { id: number }) => p.id)).toContain(kid);
  });
});

describe("letting yourself in", () => {
  it("only where the resource allows it, on the account's own pass, and never a walk-in", async () => {
    const me = await customer("Self Siti");
    const mine = await pass(venueId, { name: me.name, phone: me.phone, userId: me.id });
    // The wall lets nobody check themself in.
    const off = await selfRoute.POST(req("/api/entries", { method: "POST", cookie: me.cookie, body: { courtId: wall, by: "pass", passId: mine.id } }));
    expect(off.status).toBe(409);
    expect((await off.json()).code).toBe("NBK_SELF_OFF");
    // Signed out: asked to sign in.
    expect((await selfRoute.POST(req("/api/entries", { method: "POST", body: { courtId: gym, by: "pass", passId: mine.id } }))).status).toBe(401);
    // The gym does: what the account holds is offered, and used.
    const page = await (await selfRoute.GET(req(`/api/entries?courtId=${gym}`, { cookie: me.cookie }))).json();
    expect(page.mine.passes.map((p: { id: number }) => p.id)).toContain(mine.id);
    expect(page.mine.walkIn).toBeNull();
    const done = await selfRoute.POST(req("/api/entries", { method: "POST", cookie: me.cookie, body: { courtId: gym, by: "pass", passId: mine.id } }));
    expect(done.status).toBe(201);
    expect(await left(mine.id)).toBe(9);
    const row = (await getDb().prepare("SELECT channel, user_id, admin_id FROM entries WHERE pass_id = ? ORDER BY id DESC LIMIT 1").get(mine.id)) as Record<string, unknown>;
    expect(row).toEqual({ channel: "self", user_id: me.id, admin_id: null });
    // A walk-in is not sold to yourself.
    expect(await admitEntry({ courtId: gym, person: { participantId: null, name: me.name, phone: me.phone, userId: me.id }, by: { kind: "walk_in", via: "cash" }, channel: "self" })).toMatchObject({
      ok: false,
      code: "NBK_SELF_PAID",
    });
    // Another customer's pass is not offered or usable.
    const other = await customer("Other Omar");
    const page2 = await (await selfRoute.GET(req(`/api/entries?courtId=${gym}`, { cookie: other.cookie }))).json();
    expect(page2.mine.passes).toEqual([]);
    const theirs = await selfRoute.POST(req("/api/entries", { method: "POST", cookie: other.cookie, body: { courtId: gym, by: "pass", passId: mine.id } }));
    expect((await theirs.json()).code).toBe("NBK_PASS");
  });

  it("a day pass bought online (passes sold online) and then used to let yourself in", async () => {
    const saved = await savePaymentSettings(venueId, { provider: "billplz", apiKey: "api-key-entry", collectionId: "colentry", xSignatureKey: "S-entry-signature", sandbox: true, enabled: true });
    if (!saved.ok) throw new Error(saved.error);
    const product = await createPassProduct(venueId, { name: "Gym day pass", price: 25, validDays: 30, dayPass: true, soldOnline: true }, manager.id);
    if (!product.ok) throw new Error(product.error);
    expect(product.product).toMatchObject({ dayPass: true, entries: 1, scope: "participant", kind: "session" });
    const me = await customer("Online Ong");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ id: `entrybill${++n}`, url: `https://www.billplz-sandbox.com/bills/entrybill${n}` }))
    );
    const started = await startPassPayment({ id: me.id, name: me.name, email: `x${n}@example.my`, phone: me.phone } as never, venueId, { productId: product.product.id, participantId: null });
    if (!started.ok) throw new Error(started.error);
    const bill = started.url.split("/").pop()!;
    await settleBill({ billId: bill, paid: true, paidAt: null });
    vi.unstubAllGlobals();
    const bought = (await listPassesFor(me.id)).find((p) => p.name === "Gym day pass")!;
    expect(bought).toMatchObject({ dayPass: true, remaining: 1 });
    const done = await selfRoute.POST(req("/api/entries", { method: "POST", cookie: me.cookie, body: { courtId: gym, by: "pass", passId: bought.id } }));
    expect(done.status).toBe(201);
    expect((await done.json()).admission.admittedBy).toBe("day_pass");
  });
});

describe("what customers and staff see", () => {
  it("the venue page says no booking needed, the price and what admits, and how full as a level, never names", async () => {
    const shown = await publicEntries(venueId);
    const w = shown.find((e) => e.courtId === wall)!;
    expect(w).toMatchObject({ price: 20, selfCheckIn: false });
    expect(["quiet", "filling", "busy", "full"]).toContain(w.level);
    expect(JSON.stringify(shown)).not.toContain("Pass Priya");
    const page = await (await selfRoute.GET(req(`/api/entries?courtId=${wall}`))).json();
    expect(Object.keys(page).sort()).toEqual(["level", "mine", "resource", "signedIn", "venue"]);
    expect(JSON.stringify(page)).not.toContain("Priya");
    // Nothing for a venue with no resource taking entries.
    expect(await publicEntries(plainVenue)).toEqual([]);
  });

  it("live occupancy and the occupancy grid count entries", async () => {
    const live = await getLiveOccupancy(venueId);
    const open = await openEntries(venueId);
    const onWall = open.filter((e) => e.courtId === wall).length;
    expect(live.find((o) => o.courtId === wall)!.present).toBeGreaterThanOrEqual(onWall);
    expect(onWall).toBeGreaterThan(0);
    const grid = await getOccupancy(venueId, today, 1);
    expect(grid.days[0].perCourt.find((c) => c.courtId === wall)!.entries).toBeGreaterThan(0);
  });

  it("the desk's screen lists who is in, and admitting and checking out are in the activity log", async () => {
    const who = { name: "Logged Lim", phone: phone() };
    const res = await deskRoute.POST(req("/api/admin/entries", { method: "POST", cookie: deskCookie, body: { venueId, courtId: wall, phone: who.phone, name: who.name, by: "walk_in", via: "qr" } }));
    expect(res.status).toBe(201);
    const { admission } = await res.json();
    const list = await (await deskRoute.GET(req(`/api/admin/entries?venueId=${venueId}`, { cookie: deskCookie }))).json();
    expect(list.inNow.map((e: { id: number }) => e.id)).toContain(admission.id);
    expect(list.resources.find((r: { courtId: number }) => r.courtId === wall).count.entries).toBeGreaterThan(0);
    await deskRoute.POST(req("/api/admin/entries", { method: "POST", cookie: deskCookie, body: { venueId, entryId: admission.id, out: true } }));
    const log = await listActivity([venueId]);
    expect(log.some((a) => a.action === "entry.admitted" && a.detail?.includes("Logged Lim"))).toBe(true);
    expect(log.some((a) => a.action === "entry.checked_out" && a.detail?.includes("Logged Lim"))).toBe(true);
    // Another venue's staff cannot.
    const elsewhere = await createAdmin({ name: "Else Where", email: "else@barn.test", password: "a long enough password", venueId: plainVenue, role: "desk" });
    if (!elsewhere.ok) throw new Error("admin");
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(elsewhere.admin.id)).token}`;
    expect((await deskRoute.GET(req(`/api/admin/entries?venueId=${venueId}`, { cookie }))).status).toBe(403);
  });

  it("the venue API shows which courts take entries, read only", async () => {
    const key = await createApiKey(venueId, { name: "Front system", scope: "read" }, null);
    if (!key.ok) throw new Error(key.error);
    const res = await venueApi(req("/api/v1/venue", { headers: { authorization: `Bearer ${key.key}` } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.venue.courts.find((c: { id: number }) => c.id === wall).entry).toEqual({ price: 20, maxStayMinutes: 180, selfCheckIn: false });
    // A resource not taking entries says nothing of them.
    const other = await createResources({ venueId, sport: "badminton", count: 1, offPeakRate: 20, peakRate: 20 });
    if (!other.ok) throw new Error(other.error);
    const again = await (await venueApi(req("/api/v1/venue", { headers: { authorization: `Bearer ${key.key}` } }))).json();
    expect(again.venue.courts.find((c: { id: number }) => c.id === other.courts[0].id).entry).toBeUndefined();
  });
});

describe("the venue guide", () => {
  it("lists entry without booking and day passes as available, and the playbook says how to admit and check out", async () => {
    expect(requireCapability("gym-walk-in")).toMatchObject({ status: "available", featureRow: "Entry with no set time", activityNote: "gym" });
    expect(requireCapability("open-day-pass")).toMatchObject({ status: "available", featureRow: "Day passes", activityNote: "climbing" });
    expect(availableCapabilities().map((c) => c.id)).toEqual(expect.arrayContaining(["gym-walk-in", "open-day-pass"]));
    const book = await playbookFor(venueId, "manager");
    expect(JSON.stringify(book)).toContain("gp.during.entry.s1");
    const none = await playbookFor(plainVenue, "manager");
    expect(JSON.stringify(none)).not.toContain("gp.during.entry.s1");
  });
});
