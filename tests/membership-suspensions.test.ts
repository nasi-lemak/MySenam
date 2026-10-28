import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { setAccessSettings } from "../src/lib/access";
import { listActivity } from "../src/lib/activity";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { participationLapses } from "../src/lib/entitlements";
import { setHouseRules } from "../src/lib/house-rules";
import { addManaged } from "../src/lib/managed-people";
import { membershipFlags } from "../src/lib/membership-flags";
import { createPlan, setPlanBenefits } from "../src/lib/membership-plans";
import { reactivateMembership, suspendMembership, suspensionHistory } from "../src/lib/membership-suspensions";
import { exportCustomerData } from "../src/lib/privacy";
import { createResources } from "../src/lib/resources";
import {
  accessCodeFor,
  activeMembership,
  checkIn,
  checkInByToken,
  createVenue,
  getBookingById,
  membershipById,
  memberPricing,
  participantMembership,
  recordInduction,
  sellMembership,
  setPaymentStatus,
  updateCourt,
  updateVenue,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import * as bookingsRoute from "../src/app/api/bookings/route";
import * as quoteRoute from "../src/app/api/quote/route";
import * as checkInRoute from "../src/app/api/admin/check-in/route";
import * as suspensionRoute from "../src/app/api/admin/memberships/[id]/suspension/route";
import * as reactivateRoute from "../src/app/api/admin/memberships/[id]/reactivate/route";

/**
 * Suspending a membership and reactivating it (the owner's decision of
 * 28 October 2026; docs/features/pricing.md#suspending-a-membership;
 * lib/membership-suspensions.ts): on its dates it covers nobody it names,
 * judged on the participation date and again at check-in and the door;
 * bookings already made are flagged, never cancelled or refunded; its end
 * does not move unless its plan says so; the holder is emailed; managers
 * only, and only their own venue's.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (k: number) => addDays(todayISO(ZONE), k);
const at = (h: number) => h * 60;
let n = 0;
const phone = () => `0177${String(++n).padStart(6, "0")}`;

type Adult = Awaited<ReturnType<typeof adult>>;
async function adult(name = "Parent") {
  const ph = phone();
  const made = await registerUser({ name: `${name} ${++n}`, email: `ms${n}@ms7.test`, phone: ph, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now'), verified_phone = phone WHERE id = ?").run(made.user.id);
  return { ...made.user, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}
async function child(parent: Adult, displayName: string) {
  const made = await addManaged(parent.id, { displayName, relationship: "parent", authority: true }, parent.name);
  if (!made.ok) throw new Error(`${made.code}: ${made.error}`);
  return { id: made.person.id, name: made.person.displayName };
}
const req = (url: string, method: string, cookie: string | null, body?: unknown) =>
  new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.97.${++n % 250}.${n % 200}`, ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
type Body = Record<string, unknown> & { booking: { id: number; code: string; checkInToken: string | null }; code?: string; vars?: Record<string, unknown> };
const book = async (who: { cookie: string; name: string; phone: string }, body: Record<string, unknown>) => {
  const res = await bookingsRoute.POST(req("http://localhost/api/bookings", "POST", who.cookie, { name: who.name, phone: who.phone, ...body }));
  return { status: res.status, body: (await res.json()) as Body };
};

let club: number; // members only
let other: number; // another business
let pool: number;
let floor: number;
let manager: { id: number; name: string; cookie: string };
let desk: { id: number; name: string; cookie: string };
let outsider: { id: number; name: string; cookie: string };

async function staff(venueId: number, role: "manager" | "desk") {
  const made = await createAdmin({ name: `${role} ${++n}`, email: `ms7-${role}${n}@ms7.test`, password: "a long enough password", venueId, role });
  if (!made.ok) throw new Error(made.error);
  return { id: made.admin.id, name: `${role} ${n}`, cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}` };
}

async function membership(
  holder: { name: string; phone: string; id?: number },
  opts: { participantId?: number; covers?: number[]; from?: string; until?: string; planId?: number } = {}
) {
  const made = await sellMembership({
    venueId: club,
    holderName: holder.name,
    holderPhone: holder.phone,
    ...(holder.id ? { userId: holder.id } : {}),
    startsOn: opts.from ?? todayISO(ZONE),
    expiresOn: opts.until ?? day(60),
    price: 100,
    adminId: manager.id,
    ...(opts.participantId ? { holderParticipantId: opts.participantId } : {}),
    ...(opts.covers ? { covers: opts.covers } : {}),
    ...(opts.planId ? { planId: opts.planId } : {}),
  });
  if (!made.ok) throw new Error(made.error);
  return made.membership;
}

const suspendVia = (who: { cookie: string }, id: number, body: Record<string, unknown>) =>
  suspensionRoute.POST(req(`http://localhost/api/admin/memberships/${id}/suspension`, "POST", who.cookie, body), { params: Promise.resolve({ id: String(id) }) });
const reactivateVia = (who: { cookie: string }, id: number, body: Record<string, unknown>) =>
  reactivateRoute.POST(req(`http://localhost/api/admin/memberships/${id}/reactivate`, "POST", who.cookie, body), { params: Promise.resolve({ id: String(id) }) });
const mgr = () => ({ id: manager.id, name: manager.name });

beforeAll(async () => {
  const make = async (name: string, ph: string) => {
    const v = await createVenue({ name, area: "Bangsar", address: "x", phone: ph, openMin: at(7), closeMin: at(23) });
    if (!v.ok) throw new Error("venue");
    return v.venue.id;
  };
  const resource = async (venueId: number, sport: string, name: string, capacity: number) => {
    const r = await createResources({ venueId, sport, name, offPeakRate: 10, peakRate: 10, capacity, ...(capacity > 1 ? { maxPlayers: capacity } : {}) });
    if (!r.ok) throw new Error(r.error);
    return r.courts[0].id;
  };
  club = await make("Suspension Club", "0312370701");
  other = await make("Elsewhere Club", "0312370702");
  pool = await resource(club, "swimming", "Club pool", 8);
  floor = await resource(club, "gym", "Gym floor", 6);
  expect((await setAccessSettings(club, { access: "members" })).ok).toBe(true);
  expect((await setHouseRules(club, { aheadDays: 45 })).ok).toBe(true);
  manager = await staff(club, "manager");
  desk = await staff(club, "desk");
  outsider = await staff(other, "manager");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a suspension covers nobody on its dates, and everybody it covers together", () => {
  it("inside the period: no member, no member's price, no place; outside it: as before. Bookings already made are flagged, never cancelled or refunded", async () => {
    const parent = await adult("Holder");
    const kid = await child(parent, "Aina");
    const fam = await membership(parent, { covers: [kid.id] });
    const inside = await book(parent, { courtId: pool, date: day(5), start: at(9), end: at(10), participantIds: [kid.id], customerTakesPart: true });
    const outside = await book(parent, { courtId: pool, date: day(20), start: at(9), end: at(10), participantIds: [kid.id], customerTakesPart: true });
    expect([inside.status, outside.status]).toEqual([201, 201]);
    expect((await setPaymentStatus(inside.body.booking.code, true, "cash")).ok).toBe(true);

    const res = await suspendVia(manager, fam.id, { from: day(3), until: day(10), reason: "Unpaid locker fees" });
    expect(res.status).toBe(200);
    const done = (await res.json()) as { flagged: number; expiresOn: string; suspension: { from: string; until: string } };
    expect(done).toMatchObject({ flagged: 1, expiresOn: day(60), suspension: { from: day(3), until: day(10) } });

    // The holder and the dependant together, judged on the date asked.
    for (const d of [day(3), day(5), day(10)]) {
      expect(await activeMembership(club, parent.phone, d)).toBeNull();
      expect(await participantMembership(club, kid.id, d)).toBeNull();
      expect(await memberPricing(club, parent.phone, d)).toBe(false);
    }
    for (const d of [day(0), day(2), day(11), day(20)]) {
      expect((await activeMembership(club, parent.phone, d))?.id).toBe(fam.id);
      expect((await participantMembership(club, kid.id, d))?.id).toBe(fam.id);
    }
    expect(await memberPricing(club, parent.phone, day(11))).toBe(true);

    // Already booked inside it: still confirmed and paid, flagged for staff, person by person; outside it: nothing.
    expect(await getBookingById(inside.body.booking.id)).toMatchObject({ status: "confirmed", paymentStatus: "paid" });
    expect(await getBookingById(outside.body.booking.id)).toMatchObject({ status: "confirmed" });
    const flags = (await membershipFlags(club)).filter((f) => f.membershipId === fam.id);
    expect(flags.map((f) => [f.bookingCode, f.name, f.reason]).sort()).toEqual(
      [
        [inside.body.booking.code, parent.name, "suspended"],
        [inside.body.booking.code, "Aina", "suspended"],
      ].sort()
    );
    expect(await participationLapses(outside.body.booking.id)).toEqual([]);
    expect((await participationLapses(inside.body.booking.id)).map((l) => [l.name, l.lapse?.kind])).toEqual([
      [parent.name, "suspended"],
      ["Aina", "suspended"],
    ]);

    // Booking a members' place inside it is refused with why, for each person; outside it, booked.
    expect((await book(parent, { courtId: pool, date: day(6), start: at(11), end: at(12), participantIds: [kid.id] })).body).toMatchObject({
      code: "MS7_SUSPENDED",
      vars: { name: "Aina", date: day(6) },
    });
    const own = await book(parent, { courtId: pool, date: day(6), start: at(11), end: at(12) });
    expect(own.status).toBe(409);
    expect(own.body).toMatchObject({ code: "MS7_OWN_SUSPENDED", vars: { date: day(6) } });
    expect((await book(parent, { courtId: pool, date: day(12), start: at(11), end: at(12), participantIds: [kid.id] })).status).toBe(201);
    // The booking form says so before booking.
    const quote = (await (
      await quoteRoute.GET(req(`http://localhost/api/quote?courtId=${pool}&date=${day(6)}&start=${at(11)}&end=${at(12)}&players=1&participantIds=${kid.id}`, "GET", parent.cookie))
    ).json()) as { members?: { name: string; covered: boolean; lapse?: { kind: string; from?: string; until?: string | null } }[] };
    expect(quote.members?.[0]).toMatchObject({ name: "Aina", covered: false, lapse: { kind: "suspended", from: day(3), until: day(10) } });

    // In the activity log, and on the membership for staff and its holder.
    expect((await listActivity([club])).some((e) => e.action === "membership.suspended" && /Unpaid locker fees/.test(e.detail ?? "") && e.adminName === manager.name)).toBe(true);
    expect((await membershipById(fam.id))?.suspensions).toEqual([
      { id: expect.any(Number), from: day(3), until: day(10), endsOn: day(10), reason: "Unpaid locker fees", liftedAt: null, liftReason: null, extendedDays: 0 },
    ]);
    const events = (await getDb().prepare("SELECT action FROM participant_events WHERE participant_id = ? AND action = 'membership.suspended'").all(kid.id)) as unknown[];
    expect(events).toHaveLength(1);
  });

  it("check-in and the door on a day inside it: refused with the reason; the desk is warned, and admitting them is kept as such", async () => {
    expect((await updateVenue(club, { staffedFrom: 0, staffedTo: 0 })).ok).toBe(true);
    expect((await updateCourt(floor, { unmanned: true, accessCode: "1357" })).ok).toBe(true);
    const member = await adult("Lifter");
    const m = await membership(member);
    const gym = await book(member, { courtId: floor, date: day(1), start: at(9), end: at(10) });
    expect(gym.status).toBe(201);
    expect((await recordInduction({ venueId: club, phone: member.phone, name: member.name, adminId: manager.id })).ok).toBe(true);
    const done = await suspendMembership(mgr(), m.id, { from: day(1), until: day(1), reason: "Behaviour review" });
    expect(done.ok).toBe(true);

    const on = day(1);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${on}T08:30:00+08:00`));
    expect(await checkInByToken(gym.body.booking.checkInToken!)).toMatchObject({ ok: false, code: "MS7_CHECKIN_SUSPENDED", vars: { name: member.name, date: on } });
    expect(await accessCodeFor(gym.body.booking.code, member.phone)).toMatchObject({ ok: false, reason: "membership", code: "MS7_DOOR_SUSPENDED" });
    const warned = await checkInRoute.POST(req("http://localhost/api/admin/check-in", "POST", desk.cookie, { code: gym.body.booking.code }));
    expect(warned.status).toBe(409);
    expect(((await warned.json()) as { warnings: { lapse: { kind: string } }[] }).warnings.map((w) => w.lapse.kind)).toEqual(["suspended"]);
    expect(await checkIn(gym.body.booking.code)).toMatchObject({ ok: false, code: "MV6_DESK_WARNING" });
    const admitted = await checkInRoute.POST(req("http://localhost/api/admin/check-in", "POST", desk.cookie, { code: gym.body.booking.code, admit: true, note: "Manager agreed" }));
    expect(admitted.status).toBe(200);
    vi.useRealTimers();
    expect(await getDb().prepare("SELECT lapse, note FROM membership_admissions WHERE booking_id = ?").all(gym.body.booking.id)).toEqual([{ lapse: "suspended", note: "Manager agreed" }]);
  });
});

describe("reactivating, the end, the holder told", () => {
  it("reactivated early: covered again from today, history kept, flags left for staff, expiry unchanged; the holder is emailed in their language each time", async () => {
    const holder = await adult("Mail");
    await getDb().prepare("UPDATE users SET locale = 'ms' WHERE id = ?").run(holder.id);
    const m = await membership(holder);
    const swim = await book(holder, { courtId: pool, date: day(2), start: at(14), end: at(15) });
    expect(swim.status).toBe(201);
    const res = await suspendVia(manager, m.id, { from: day(0), reason: "Card dispute" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { suspension: { until: string | null } }).suspension.until).toBeNull();
    expect(await activeMembership(club, holder.phone, day(0))).toBeNull();
    expect(await activeMembership(club, holder.phone, day(300))).toBeNull(); // open-ended (and past its end anyway)
    expect(await activeMembership(club, holder.phone, day(40))).toBeNull();

    // Another suspension overlapping an open-ended one: refused.
    expect(await suspendMembership(mgr(), m.id, { from: day(30), until: day(31), reason: "Second" })).toMatchObject({ ok: false, code: "MS7_OVERLAP_OPEN" });

    const lifted = await reactivateVia(manager, m.id, { reason: "Dispute settled" });
    expect(lifted.status).toBe(200);
    expect((await activeMembership(club, holder.phone, day(0)))?.id).toBe(m.id);
    expect((await activeMembership(club, holder.phone, day(40)))?.id).toBe(m.id);
    expect((await membershipById(m.id))?.expiresOn).toBe(day(60));
    const [row] = await suspensionHistory(m.id);
    expect(row).toMatchObject({ from: day(0), until: null, endsOn: day(-1), reason: "Card dispute", by: manager.name, liftedBy: manager.name, liftReason: "Dispute settled", extendedDays: 0 });
    expect(row.liftedAt).not.toBeNull();
    // The flag it raised stays for staff to decide.
    expect((await membershipFlags(club)).some((f) => f.membershipId === m.id && f.bookingCode === swim.body.booking.code && f.reason === "suspended")).toBe(true);
    expect((await listActivity([club])).some((e) => e.action === "membership.reactivated" && /Dispute settled/.test(e.detail ?? ""))).toBe(true);
    // Nothing left to lift.
    expect((await reactivateVia(manager, m.id, { reason: "Again" })).status).toBe(409);

    const mails = (await getDb()
      .prepare("SELECT kind, channel, recipient, locale, subject, body FROM messages WHERE recipient = ? ORDER BY id")
      .all(holder.email)) as { kind: string; channel: string; recipient: string; locale: string; subject: string; body: string }[];
    expect(mails.map((x) => [x.kind, x.channel, x.locale])).toEqual([
      ["account_email", "email", "ms"],
      ["account_email", "email", "ms"],
    ]);
    expect(mails[0].subject).toBe("Keahlian anda di Suspension Club digantung");
    expect(mails[0].body).toContain(`dari ${day(0)} sehingga pusat mengaktifkannya semula`);
    expect(mails[0].body).toContain("Card dispute");
    expect(mails[1].subject).toBe("Keahlian anda di Suspension Club aktif semula");
    expect(mails[1].body).toContain(`aktif semula mulai ${day(0)}`);
  });

  it("nobody it covers is written to, and no account that said it is under 18", async () => {
    const teen = await adult("Teen");
    await getDb().prepare("INSERT INTO player_profiles (user_id, adult) VALUES (?, 0)").run(teen.id);
    const m = await membership(teen);
    expect((await suspendMembership(mgr(), m.id, { from: day(1), until: day(2), reason: "Holiday closure" })).ok).toBe(true);
    expect(await getDb().prepare("SELECT id FROM messages WHERE recipient = ?").all(teen.email)).toEqual([]);
  });

  it("its end moves only where the plan says so: once, corrected when lifted early, applied to an open-ended one when it is lifted, and never into a later term", async () => {
    const plan = await createPlan(club, { name: "Flexi", months: 12, price: 200, extendOnSuspension: true });
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.plan.extendOnSuspension).toBe(true);
    const off = await createPlan(club, { name: "Fixed", months: 12, price: 200 });
    if (!off.ok) throw new Error(off.error);
    expect(off.plan.extendOnSuspension).toBe(false);

    const a = await adult("Flexi");
    const m = await membership(a, { planId: plan.plan.id });
    const dated = await suspendMembership(mgr(), m.id, { from: day(10), until: day(19), reason: "Injury" });
    expect(dated).toMatchObject({ ok: true, expiresOn: day(70), extension: { moved: 10, blockedBy: null } });
    expect((await suspensionHistory(m.id))[0].extendedDays).toBe(10);
    expect((await listActivity([club])).some((e) => e.action === "membership.suspended" && e.detail?.includes(`end moved to ${day(70)}`))).toBe(true);
    // Lifted before it began: no day was suspended, so the end goes back.
    expect(await reactivateMembership(mgr(), m.id, { reason: "Recovered early" })).toMatchObject({ ok: true, expiresOn: day(60) });
    expect((await suspensionHistory(m.id))[0].extendedDays).toBe(0);

    // Open-ended: nothing moves until it is lifted, then by the days it took out; never twice.
    expect(await suspendMembership(mgr(), m.id, { from: day(0), reason: "Travel" })).toMatchObject({ ok: true, expiresOn: day(60) });
    const fiveDaysOn = day(5);
    const extended = day(65);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${fiveDaysOn}T10:00:00+08:00`));
    expect(await reactivateMembership(mgr(), m.id, { reason: "Back" })).toMatchObject({ ok: true, expiresOn: extended, extension: { moved: 5 } });
    expect(await reactivateMembership(mgr(), m.id, { reason: "Back again" })).toMatchObject({ ok: false, code: "MS7_NOT_SUSPENDED" });
    vi.useRealTimers();
    expect((await membershipById(m.id))?.expiresOn).toBe(extended);

    // A plan without the setting: the end stays.
    const b = await adult("Fixed");
    const fixed = await membership(b, { planId: off.plan.id });
    expect(await suspendMembership(mgr(), fixed.id, { from: day(1), until: day(9), reason: "Injury" })).toMatchObject({ ok: true, expiresOn: day(60), extension: { moved: 0 } });

    // A later term already follows it: the end is not moved into it, and staff are told why.
    const c = await adult("Renewed");
    const first = await membership(c, { planId: plan.plan.id, until: day(30) });
    await membership(c, { planId: plan.plan.id, from: day(31), until: day(90) });
    const blocked = await suspendMembership(mgr(), first.id, { from: day(5), until: day(9), reason: "Injury" });
    expect(blocked).toMatchObject({ ok: true, expiresOn: day(30), extension: { moved: 0, blockedBy: expect.stringMatching(/^MB-/) } });
    expect((await suspensionHistory(first.id))[0].extensionNote).toMatch(/Not moved/);

    // The plan setting is a manager's, through the plan editor.
    expect((await setPlanBenefits(club, off.plan.id, { extendOnSuspension: true })).ok).toBe(true);
    expect((await setPlanBenefits(club, off.plan.id, { extendOnSuspension: "yes" })).ok).toBe(false);
  });

  it("a renewal starting inside an open-ended suspension is still made, and carries it on; reactivating lifts both", async () => {
    const a = await adult("Renewing");
    const first = await membership(a, { until: day(20) });
    expect((await suspendMembership(mgr(), first.id, { from: day(15), reason: "Committee decision" })).ok).toBe(true);
    const next = await membership(a, { from: day(21), until: day(80) });
    expect(next.suspensions).toEqual([expect.objectContaining({ from: day(21), until: null, endsOn: null, reason: "Committee decision" })]);
    expect(await activeMembership(club, a.phone, day(30))).toBeNull();
    expect((await listActivity([club])).some((e) => e.action === "membership.suspended" && e.adminName === "MySenam" && e.detail?.includes(next.code))).toBe(true);
    expect((await reactivateMembership(mgr(), next.id, { reason: "Committee lifted it" })).ok).toBe(true);
    expect((await activeMembership(club, a.phone, day(30)))?.id).toBe(next.id);
    expect((await suspensionHistory(first.id))[0]).toMatchObject({ endsOn: day(-1), liftReason: "Committee lifted it" });
  });
});

describe("who may, and what is refused", () => {
  it("managers of its venue only; dates and reasons checked; overlaps refused", async () => {
    const a = await adult("Rules");
    const m = await membership(a);
    expect((await suspendVia(desk, m.id, { from: day(1), until: day(2), reason: "Desk try" })).status).toBe(403);
    expect((await reactivateVia(desk, m.id, { reason: "Desk try" })).status).toBe(403);
    expect((await suspendVia(outsider, m.id, { from: day(1), until: day(2), reason: "Other venue" })).status).toBe(403);
    // The desk reads the history.
    const seen = await suspensionRoute.GET(req(`http://localhost/api/admin/memberships/${m.id}/suspension`, "GET", desk.cookie), { params: Promise.resolve({ id: String(m.id) }) });
    expect(seen.status).toBe(200);

    expect(await suspendMembership(mgr(), m.id, { from: day(1), until: day(2) })).toMatchObject({ ok: false, code: "MS7_REASON" });
    expect(await suspendMembership(mgr(), m.id, { from: day(-1), until: day(2), reason: "Backdated" })).toMatchObject({ ok: false, code: "MS7_FROM_PAST" });
    expect(await suspendMembership(mgr(), m.id, { from: day(5), until: day(2), reason: "Backwards" })).toMatchObject({ ok: false, code: "MS7_DATES" });
    expect(await suspendMembership(mgr(), m.id, { from: day(61), reason: "After its end" })).toMatchObject({ ok: false, code: "MS7_AFTER_END" });
    expect((await suspendMembership(mgr(), m.id, { from: day(5), until: day(9), reason: "First" })).ok).toBe(true);
    for (const [from, until] of [
      [day(9), day(12)],
      [day(1), day(5)],
      [day(6), day(7)],
      [day(1), null],
    ])
      expect(await suspendMembership(mgr(), m.id, { from, until, reason: "Overlap" })).toMatchObject({ ok: false, code: "MS7_OVERLAP", vars: { from: day(5), until: day(9) } });
    // Next to it is fine.
    expect((await suspendMembership(mgr(), m.id, { from: day(10), until: day(11), reason: "Next" })).ok).toBe(true);
    expect((await suspensionHistory(m.id)).map((s) => [s.from, s.endsOn])).toEqual([
      [day(5), day(9)],
      [day(10), day(11)],
    ]);
  });

  it("the account's data export lists each suspension of its memberships", async () => {
    const a = await adult("Export");
    const m = await membership(a);
    expect((await suspendMembership(mgr(), m.id, { from: day(2), until: day(4), reason: "Medical leave" })).ok).toBe(true);
    const data = await exportCustomerData(a.id);
    const row = (data?.memberships as { code: string; suspensions: { from: string; until: string; reason: string }[] }[]).find((x) => x.code === m.code);
    expect(row?.suspensions).toEqual([expect.objectContaining({ from: day(2), until: day(4), endsOn: day(4), reason: "Medical leave", reactivatedAt: null, daysAddedToEnd: 0 })]);
  });
});

describe("suspending while somebody books a day inside it (both engines: Postgres with TEST_DATABASE_URL)", () => {
  it("a booking made before the suspension commits is flagged; one after is refused; never a booking left unflagged and uncovered", async () => {
    // The suspension sent a little later each time, so that some bookings commit first and some after.
    const delays = [0, 5, 15, 30, 60, 120];
    for (let i = 0; i < delays.length; i++) {
      const a = await adult(`Race${i}`);
      const m = await membership(a);
      const date = day(7 + (i % 5));
      const [suspended, booked] = await Promise.all([
        new Promise((r) => setTimeout(r, delays[i])).then(() => suspendMembership(mgr(), m.id, { from: day(6), until: day(12), reason: "Race" })),
        book(a, { courtId: pool, date, start: at(16), end: at(17) }),
      ]);
      expect(suspended.ok).toBe(true);
      if (booked.status === 201) {
        // Booked first: still confirmed, and flagged for staff by the suspension.
        expect(await getBookingById(booked.body.booking.id)).toMatchObject({ status: "confirmed" });
        expect((await membershipFlags(club)).some((f) => f.membershipId === m.id && f.bookingCode === booked.body.booking.code && f.reason === "suspended")).toBe(true);
      } else {
        expect(booked.status).toBe(409);
        expect(booked.body.code).toBe("MS7_OWN_SUSPENDED");
      }
    }
  });
});
