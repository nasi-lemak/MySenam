import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { setAccessSettings, eligible } from "../src/lib/access";
import { listActivity } from "../src/lib/activity";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { createApiKey } from "../src/lib/api-keys";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { placeBenefitsFor } from "../src/lib/entitlements";
import { setHouseRules } from "../src/lib/house-rules";
import { addManaged } from "../src/lib/managed-people";
import { createPlan, setPlanBenefits } from "../src/lib/membership-plans";
import { createAtVenue } from "../src/lib/participants";
import { createResources } from "../src/lib/resources";
import {
  activeMembership,
  createBookingSeries,
  createClassSessions,
  createVenue,
  participantMembership,
  rescheduleBooking,
  sellMembership,
  updateCourt,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import * as bookingsRoute from "../src/app/api/bookings/route";
import * as enrolRoute from "../src/app/api/classes/enrol/route";
import * as waitlistRoute from "../src/app/api/waitlist/route";
import * as quoteRoute from "../src/app/api/quote/route";
import * as membershipsRoute from "../src/app/api/admin/memberships/route";
import * as apiBookingsRoute from "../src/app/api/v1/bookings/route";

/**
 * Membership rules by their real scope (ADR 0025; lib/entitlements.ts;
 * docs/features/booking.md#who-a-venue-is-for-public-members-only-private):
 * reserving a court and booking ahead are the account's privileges; a place
 * on a members' session is each person's own to hold (their own membership,
 * or a family one naming them), on every path; a membership's price covers
 * the booking or its members' own places, as its plan says.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (k: number) => addDays(todayISO(ZONE), k);
const at = (h: number) => h * 60;
let n = 0;
const phone = () => `0179${String(++n).padStart(6, "0")}`;

type Adult = Awaited<ReturnType<typeof adult>>;
async function adult(name = "Parent") {
  const ph = phone();
  const made = await registerUser({ name: `${name} ${++n}`, email: `ms${n}@ms.test`, phone: ph, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now'), verified_phone = phone WHERE id = ?").run(made.user.id);
  return { ...made.user, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}
async function child(parent: Adult, displayName: string) {
  const made = await addManaged(parent.id, { displayName, relationship: "parent", authority: true }, parent.name);
  if (!made.ok) throw new Error(`${made.code}: ${made.error}`);
  return { id: made.person.id, name: made.person.displayName };
}
const req = (url: string, method: string, cookie: string | null, body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.99.${++n % 250}.${n % 200}`, ...(cookie ? { cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const book = async (who: { cookie: string; name?: string; phone?: string }, body: Record<string, unknown>) => {
  const res = await bookingsRoute.POST(req("http://localhost/api/bookings", "POST", who.cookie, { ...(who.phone ? { name: who.name, phone: who.phone } : {}), ...body }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & { booking: { id: number; code: string; totalPrice: number } } };
};

let members: number; // a members-only club
let open: number; // a public centre
let pool: number;
let hall: number;
let openPool: number;
let openHall: number;
let manager: { id: number; name: string; cookie: string };
let desk: { id: number; name: string; cookie: string };

async function staff(venueId: number, role: "manager" | "desk") {
  const made = await createAdmin({ name: `${role} ${++n}`, email: `ms-${role}${n}@ms.test`, password: "a long enough password", venueId, role });
  if (!made.ok) throw new Error(made.error);
  return { id: made.admin.id, name: `${role} ${n}`, cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}` };
}

async function membership(holder: Adult, opts: { venueId?: number; participantId?: number; covers?: number[]; until?: string; tierId?: number } = {}) {
  const made = await sellMembership({
    venueId: opts.venueId ?? members,
    holderName: holder.name,
    holderPhone: holder.phone,
    userId: holder.id,
    startsOn: todayISO(ZONE),
    expiresOn: opts.until ?? day(60),
    price: 100,
    adminId: manager.id,
    ...(opts.participantId ? { holderParticipantId: opts.participantId } : {}),
    ...(opts.covers ? { covers: opts.covers } : {}),
    ...(opts.tierId ? { tierId: opts.tierId } : {}),
  });
  if (!made.ok) throw new Error(made.error);
  return made.membership;
}

beforeAll(async () => {
  const make = async (name: string, ph: string) => {
    const v = await createVenue({ name, area: "Bangsar", address: "x", phone: ph, openMin: at(7), closeMin: at(23) });
    if (!v.ok) throw new Error("venue");
    return v.venue.id;
  };
  const resource = async (venueId: number, sport: string, name: string, capacity: number, rate: number) => {
    const r = await createResources({ venueId, sport, name, offPeakRate: rate, peakRate: rate, capacity, ...(capacity > 1 ? { maxPlayers: capacity } : {}) });
    if (!r.ok) throw new Error(r.error);
    return r.courts[0].id;
  };
  members = await make("Members Club", "0312350701");
  open = await make("Open Centre", "0312350702");
  pool = await resource(members, "swimming", "Club pool", 8, 10);
  hall = await resource(members, "badminton", "Club hall", 1, 20);
  openPool = await resource(open, "swimming", "Open pool", 8, 10);
  openHall = await resource(open, "badminton", "Open hall", 1, 20);
  for (const c of [hall, openHall]) expect((await updateCourt(c, { memberOffPeakRate: 10, memberPeakRate: 10 })).ok).toBe(true);
  expect((await setAccessSettings(members, { access: "members" })).ok).toBe(true);
  expect((await setHouseRules(members, { aheadDays: 45 })).ok).toBe(true);
  manager = await staff(members, "manager");
  desk = await staff(members, "desk");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a place on a members' session is each person's own to hold", () => {
  it("online: a member parent cannot put a child who is not a member on it; the child's own or a family membership naming them can", async () => {
    const parent = await adult("Member");
    const notMember = await child(parent, "Kai");
    const ownMember = await child(parent, "Lia");
    const covered = await child(parent, "Mika");
    await membership(parent, { covers: [covered.id] });
    await membership(parent, { participantId: ownMember.id });

    const refused = await book(parent, { courtId: pool, date: day(2), start: at(9), end: at(10), participantIds: [notMember.id] });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "ENT_MEMBERS_PLACE", vars: { name: "Kai" } });
    // With the parent taking part as well: still Kai's own to hold.
    expect((await book(parent, { courtId: pool, date: day(2), start: at(9), end: at(10), participantIds: [notMember.id], customerTakesPart: true })).body).toMatchObject({
      code: "ENT_MEMBERS_PLACE",
    });
    expect((await book(parent, { courtId: pool, date: day(2), start: at(9), end: at(10), participantIds: [ownMember.id] })).status).toBe(201);
    expect((await book(parent, { courtId: pool, date: day(2), start: at(11), end: at(12), participantIds: [covered.id] })).status).toBe(201);
    // The parent's own membership is theirs: not their children's unless it names them.
    expect(await participantMembership(members, notMember.id, day(2))).toBeNull();
    expect((await participantMembership(members, covered.id, day(2)))?.holderParticipantId).toBeNull();
  });

  it("a parent who is not a member books their member child's place; not their own, and not a court", async () => {
    const parent = await adult("Guest");
    const kid = await child(parent, "Nadia");
    await membership(parent, { participantId: kid.id });
    // The child's membership is the child's: it does not make the number's holder a member.
    expect(await activeMembership(members, parent.phone)).toBeNull();
    expect(await eligible(members, parent.id)).toBe(false);
    expect((await book(parent, { courtId: pool, date: day(3), start: at(9), end: at(10), participantIds: [kid.id] })).status).toBe(201);
    const self = await book(parent, { courtId: pool, date: day(3), start: at(11), end: at(12), participantIds: [kid.id], customerTakesPart: true });
    expect(self.body.code).toBe("MEMBERS_ONLY");
    // Reserving a court whole is the booker's privilege: an account that is not a member cannot.
    const court = await book(parent, { courtId: hall, date: day(3), start: at(9), end: at(10), participantIds: [kid.id] });
    expect(court.body.code).toBe("MEMBERS_ONLY");
  });

  it("reserving a court is the booker's privilege: a member reserves one for children who are not members", async () => {
    const parent = await adult("Member");
    await membership(parent);
    const a = await child(parent, "Omar");
    const b = await child(parent, "Ola");
    expect((await book(parent, { courtId: hall, date: day(4), start: at(9), end: at(10), participantIds: [a.id, b.id] })).status).toBe(201);
  });

  it("the counter and the venue's own system are held to it too; a manager may go past it, on the record", async () => {
    const ph = phone();
    const kid = await createAtVenue({ venueId: members, admin: { id: manager.id, name: manager.name }, displayName: "Puteri", guardian: { name: "Puan Q", phone: ph, relationship: "parent", authority: true } });
    if (!kid.ok) throw new Error(kid.error);
    const body = { courtId: pool, date: day(5), start: at(9), end: at(10), name: "Puan Q", phone: ph, participantIds: [kid.participant.id] };
    const atDesk = await book({ cookie: desk.cookie }, body);
    expect(atDesk.status).toBe(409);
    expect(atDesk.body.code).toBe("ENT_MEMBERS_PLACE");
    const key = await createApiKey(members, { name: "Club system", scope: "write" }, manager.id);
    if (!key.ok) throw new Error(key.error);
    const api = await apiBookingsRoute.POST(req("http://localhost/api/v1/bookings", "POST", null, body, { authorization: `Bearer ${key.key}` }));
    expect(api.status).toBe(409);
    expect(((await api.json()) as { code: string }).code).toBe("ENT_MEMBERS_PLACE");
    // A manager going past the rules: booked, and the override recorded with its reason.
    const over = await book({ cookie: manager.cookie }, { ...body, override: true });
    expect(over.status).toBe(201);
    const log = await listActivity([members], { bookingCode: over.body.booking.code });
    expect(log.some((e) => e.action === "booking.override" && e.bookingCode === over.body.booking.code && /members/.test(e.detail ?? ""))).toBe(true);
    // Sold their own membership at the counter, for that child by the guardian's number: the desk books them.
    const sold = await membershipsRoute.POST(
      req("http://localhost/api/admin/memberships", "POST", manager.cookie, {
        venueId: members,
        holderName: "Puan Q",
        holderPhone: ph,
        startsOn: todayISO(ZONE),
        expiresOn: day(40),
        price: 80,
        holderParticipantId: kid.participant.id,
      })
    );
    expect(sold.status).toBe(201);
    expect(((await sold.json()) as { membership: { holderParticipantName: string } }).membership.holderParticipantName).toBe("Puteri");
    expect((await book({ cookie: desk.cookie }, { ...body, start: at(11), end: at(12) })).status).toBe(201);
    // Nobody acting for them on that number: not sold.
    const wrong = await membershipsRoute.POST(
      req("http://localhost/api/admin/memberships", "POST", manager.cookie, {
        venueId: members,
        holderName: "Somebody",
        holderPhone: phone(),
        startsOn: todayISO(ZONE),
        expiresOn: day(40),
        price: 80,
        holderParticipantId: kid.participant.id,
      })
    );
    expect(wrong.status).toBe(409);
  });

  it("classes, waiting lists and moves ask the same", async () => {
    const parent = await adult("Member");
    await membership(parent);
    const kid = await child(parent, "Qistina");
    const member = await child(parent, "Rafiq");
    await membership(parent, { participantId: member.id, until: day(10) });
    const made = await createClassSessions({ courtId: pool, name: "Junior swim", instructor: "Coach", date: day(6), start: at(17), end: at(18), capacity: 1, price: 15 });
    if (!made.ok) throw new Error(made.error);
    const cls = made.classes[0];
    const enrol = (ids: number[]) => enrolRoute.POST(req("http://localhost/api/classes/enrol", "POST", parent.cookie, { classId: cls.id, name: parent.name, phone: parent.phone, participantIds: ids }));
    const no = await enrol([kid.id]);
    expect(no.status).toBe(409);
    expect(((await no.json()) as { code: string }).code).toBe("ENT_MEMBERS_PLACE");
    expect((await enrol([member.id])).status).toBe(201);
    // Full now: Qistina may not even wait for a place she could not take.
    const wait = await waitlistRoute.POST(req("http://localhost/api/waitlist", "POST", parent.cookie, { classId: cls.id, name: parent.name, phone: parent.phone, participantIds: [kid.id] }));
    expect(wait.status).toBe(403);
    expect(((await wait.json()) as { code: string }).code).toBe("ENT_MEMBERS_PLACE");
    // Rafiq's membership ends on day 10: his booking can move within it, not past it.
    const swim = await book(parent, { courtId: pool, date: day(8), start: at(9), end: at(10), participantIds: [member.id] });
    expect(swim.status).toBe(201);
    expect((await rescheduleBooking(swim.body.booking.code, { date: day(9), start: at(9) }, "customer")).ok).toBe(true);
    expect(await rescheduleBooking(swim.body.booking.code, { date: day(12), start: at(9) }, "customer")).toMatchObject({ ok: false, code: "ENT_MEMBERS_PLACE" });
    // A weekly series past it: refused for the weeks it does not cover.
    expect((await book(parent, { courtId: pool, date: day(8), start: at(13), end: at(14), weeks: 2, participantIds: [member.id] })).body).toMatchObject({ code: "ENT_MEMBERS_PLACE" });
  });
});

describe("a membership's price, by what it covers", () => {
  it("a child's own membership prices a booking for them; a parent's does not unless it names them", async () => {
    const parent = await adult("Mum");
    const own = await child(parent, "Sara");
    const plain = await child(parent, "Tariq");
    const named = await child(parent, "Umi");
    await membership(parent, { venueId: open, covers: [named.id] });
    await membership(parent, { venueId: open, participantId: own.id });
    // The engine every path books through, as the customer online (a number holds only so many unpaid bookings through the route).
    let hour = 8;
    const price = async (ids: number[], takesPart = false) => {
      hour++;
      const made = await createBookingSeries({
        courtId: openHall,
        date: day(10),
        start: at(hour),
        end: at(hour + 1),
        weeks: 1,
        name: parent.name,
        phone: parent.phone,
        userId: parent.id,
        by: "customer",
        participants: [own, plain, named].filter((p) => ids.includes(p.id)),
        customerTakesPart: takesPart,
      });
      if (!made.ok) throw new Error(made.error);
      return made.bookings[0].totalPrice;
    };
    expect(await price([own.id])).toBe(10);
    expect(await price([plain.id])).toBe(20);
    expect(await price([named.id])).toBe(10);
    // A court reserved by a member taking part: the member's price whoever else plays.
    expect(await price([plain.id], true)).toBe(10);
  });

  it("a plan for members' own places prices only those places on a session sold by the place; the quote says the same", async () => {
    const plan = await createPlan(open, { name: "Swim member", months: 12, price: 50, ratePercent: 50, scope: "participant" });
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.plan.scope).toBe("participant");
    const parent = await adult("Dad");
    const member = await child(parent, "Vin");
    const other = await child(parent, "Wan");
    await membership(parent, { venueId: open, participantId: member.id, tierId: plan.plan.id });
    // Two places at RM10: Vin's at half, Wan's at the public price.
    const mixed = await book(parent, { courtId: openPool, date: day(11), start: at(9), end: at(10), participantIds: [member.id, other.id] });
    expect(mixed.body.booking.totalPrice).toBe(15);
    const [benefit] = await placeBenefitsFor(mixed.body.booking.id);
    expect(benefit).toMatchObject({ kind: "membership", participantId: member.id, amount: 5 });
    const quote = await quoteRoute.GET(
      req(`http://localhost/api/quote?courtId=${openPool}&date=${day(11)}&start=${at(11)}&end=${at(12)}&players=2&participantIds=${member.id},${other.id}`, "GET", parent.cookie)
    );
    expect(((await quote.json()) as { total: number }).total).toBe(15);
    // A court hired whole: the member's price only where the member is the only one on it.
    expect((await book(parent, { courtId: openHall, date: day(11), start: at(9), end: at(10), participantIds: [member.id] })).body.booking.totalPrice).toBe(10);
    expect((await book(parent, { courtId: openHall, date: day(11), start: at(11), end: at(12), participantIds: [member.id, other.id] })).body.booking.totalPrice).toBe(20);
    // Changing the plan's other benefits keeps what its price covers.
    const changed = await setPlanBenefits(open, plan.plan.id, { ratePercent: 60, aheadDays: null });
    expect(changed.ok && changed.plan.scope).toBe("participant");
  });
});

describe("account-level privileges stay the account's", () => {
  it("a member reserves a court further ahead for their children; the house limits count the account's bookings, whoever they are for", async () => {
    expect((await setHouseRules(open, { aheadDays: 7, memberAheadDays: 21, perWeek: 2 })).ok).toBe(true);
    const parent = await adult("Member");
    await membership(parent, { venueId: open });
    const a = await child(parent, "Xena");
    const other = await adult("NotMember");
    const b = await child(other, "Yus");
    expect((await book(parent, { courtId: openHall, date: day(15), start: at(9), end: at(10), participantIds: [a.id] })).status).toBe(201);
    const far = await book(other, { courtId: openHall, date: day(15), start: at(11), end: at(12), participantIds: [b.id] });
    expect(far.status).toBe(409);
    expect(far.body.code).toBe("LIMIT_AHEAD_MEMBERS");
    // Two a week for the account, children's bookings counted with its own.
    expect((await book(parent, { courtId: openHall, date: day(15), start: at(13), end: at(14), participantIds: [a.id] })).status).toBe(201);
    const third = await book(parent, { courtId: openHall, date: day(15), start: at(15), end: at(16) });
    expect(third.body.code).toBe("LIMIT_WEEK");
    expect((await setHouseRules(open, { aheadDays: 45 })).ok).toBe(true);
  });

  it("the system re-pricing a booking it holds, and a booking made for others only, keep their meaning", async () => {
    const parent = await adult("Member");
    await membership(parent, { venueId: open });
    const a = await child(parent, "Zara");
    const made = await createBookingSeries({ courtId: openHall, date: day(12), start: at(9), end: at(10), weeks: 1, name: parent.name, phone: parent.phone, userId: parent.id, participants: [a], by: "customer" });
    if (!made.ok) throw new Error(made.error);
    // A booking only for a child who is not a member: the public price, as before.
    expect(made.bookings[0].totalPrice).toBe(20);
  });
});
