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
import { createApiKey } from "../src/lib/api-keys";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { membersOnlyRefusal, participationLapses, renewPath } from "../src/lib/entitlements";
import { setHouseRules } from "../src/lib/house-rules";
import { addManaged } from "../src/lib/managed-people";
import { flagAfterMembershipLoss, membershipFlags } from "../src/lib/membership-flags";
import { createPlan } from "../src/lib/membership-plans";
import { changeCovers } from "../src/lib/membership-purchases";
import { createAtVenue } from "../src/lib/participants";
import { savePaymentSettings } from "../src/lib/payments";
import { createResources } from "../src/lib/resources";
import {
  accessCodeFor,
  cancelBooking,
  checkIn,
  checkInByToken,
  claimWaitlistOffer,
  createClassSessions,
  createVenue,
  getBookingById,
  offerClassPlace,
  participantMembership,
  recordInduction,
  rescheduleBooking,
  sellMembership,
  setPaymentStatus,
  updateCourt,
  updateVenue,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import * as bookingsRoute from "../src/app/api/bookings/route";
import * as rescheduleRoute from "../src/app/api/bookings/reschedule/route";
import * as enrolRoute from "../src/app/api/classes/enrol/route";
import * as waitlistRoute from "../src/app/api/waitlist/route";
import * as quoteRoute from "../src/app/api/quote/route";
import * as checkInRoute from "../src/app/api/admin/check-in/route";
import * as selfCheckInRoute from "../src/app/api/checkin/route";
import * as accessRoute from "../src/app/api/access/route";
import * as voidRoute from "../src/app/api/admin/memberships/[id]/void/route";
import * as flagsRoute from "../src/app/api/admin/memberships/flags/route";
import * as apiBookingsRoute from "../src/app/api/v1/bookings/route";

/**
 * Membership validity (the owner's decision of 27 October 2026;
 * docs/features/pricing.md#membership-validity; lib/entitlements.ts):
 * booking privileges (members book further ahead) are the account's, asked
 * when the booking is made; participation (a place on a members-only
 * session) is the actual participant's, valid on the session's date, asked
 * by every path with one check, and asked again before they take part: the
 * desk is warned, self check-in and the door refuse. A membership that stops
 * covering somebody flags their bookings for staff; nothing paid is cancelled.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (k: number) => addDays(todayISO(ZONE), k);
const at = (h: number) => h * 60;
let n = 0;
const phone = () => `0176${String(++n).padStart(6, "0")}`;

type Adult = Awaited<ReturnType<typeof adult>>;
async function adult(name = "Parent") {
  const ph = phone();
  const made = await registerUser({ name: `${name} ${++n}`, email: `mv${n}@mv.test`, phone: ph, password: "a long enough password" });
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
    headers: { "content-type": "application/json", "x-forwarded-for": `10.98.${++n % 250}.${n % 200}`, ...(cookie ? { cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
type Body = Record<string, unknown> & { booking: { id: number; code: string; checkInToken: string | null }; code?: string; vars?: Record<string, unknown> };
const book = async (who: { cookie: string; name?: string; phone?: string }, body: Record<string, unknown>) => {
  const res = await bookingsRoute.POST(req("http://localhost/api/bookings", "POST", who.cookie, { ...(who.phone ? { name: who.name, phone: who.phone } : {}), ...body }));
  return { status: res.status, body: (await res.json()) as Body };
};
const quote = async (who: Adult, query: string) =>
  (await (await quoteRoute.GET(req(`http://localhost/api/quote?${query}`, "GET", who.cookie))).json()) as {
    members?: { participantId: number | null; name: string; covered: boolean; lapse?: { kind: string; until?: string }; renew: string }[];
  };

let club: number; // members only
let open: number; // public, members book further ahead
let pool: number;
let floor: number;
let hall: number;
let openHall: number;
let manager: { id: number; name: string; cookie: string };
let desk: { id: number; name: string; cookie: string };

async function staff(venueId: number, role: "manager" | "desk") {
  const made = await createAdmin({ name: `${role} ${++n}`, email: `mv-${role}${n}@mv.test`, password: "a long enough password", venueId, role });
  if (!made.ok) throw new Error(made.error);
  return { id: made.admin.id, name: `${role} ${n}`, cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}` };
}

async function membership(
  holder: { name: string; phone: string; id?: number },
  opts: { venueId?: number; participantId?: number; covers?: number[]; from?: string; until?: string; planId?: number } = {}
) {
  const made = await sellMembership({
    venueId: opts.venueId ?? club,
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
  club = await make("Validity Club", "0312360701");
  open = await make("Validity Centre", "0312360702");
  pool = await resource(club, "swimming", "Club pool", 8, 10);
  floor = await resource(club, "gym", "Gym floor", 6, 10);
  hall = await resource(club, "badminton", "Club hall", 1, 20);
  openHall = await resource(open, "badminton", "Centre hall", 1, 20);
  expect((await setAccessSettings(club, { access: "members" })).ok).toBe(true);
  expect((await setHouseRules(club, { aheadDays: 45 })).ok).toBe(true);
  expect((await setHouseRules(open, { aheadDays: 7, memberAheadDays: 30 })).ok).toBe(true);
  manager = await staff(club, "manager");
  desk = await staff(club, "desk");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("participation: the participant's own membership, on the session's date", () => {
  it("a parent booking today for next month, the child's membership ending before it: refused with the reason and where to renew; booked once renewed", async () => {
    const parent = await adult("Mum");
    const kid = await child(parent, "Aina");
    await membership(parent, { participantId: kid.id, until: day(20) });
    // Live today: but not on the day of the session.
    expect(await participantMembership(club, kid.id, day(0))).not.toBeNull();
    const body = { courtId: pool, date: day(30), start: at(9), end: at(10), participantIds: [kid.id] };
    const refused = await book(parent, body);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "MV6_ENDS_BEFORE", vars: { name: "Aina", until: day(20), date: day(30), renew: "" } });
    expect(String(refused.body.error)).toContain(`ends on ${day(20)}, before the session on ${day(30)}`);
    // The booking form says the same before booking, never "a member" because it is live today.
    const said = await quote(parent, `courtId=${pool}&date=${day(30)}&start=${at(9)}&end=${at(10)}&players=1&participantIds=${kid.id}`);
    expect(said.members).toEqual([{ participantId: kid.id, name: "Aina", covered: false, lapse: { kind: "ended", until: day(20) }, renew: "" }]);
    // Renewed from the day after it ends: now booked.
    await membership(parent, { participantId: kid.id, from: day(21), until: day(120) });
    expect((await quote(parent, `courtId=${pool}&date=${day(30)}&start=${at(9)}&end=${at(10)}&players=1&participantIds=${kid.id}`)).members?.[0]).toMatchObject({ covered: true });
    expect((await book(parent, body)).status).toBe(201);
  });

  it("the customer's own place is theirs on the day too, and the renewal link goes to the venue's plans where it sells them online", async () => {
    const member = await adult("Member");
    await membership(member, { until: day(20) });
    const mine = await book(member, { courtId: pool, date: day(30), start: at(11), end: at(12) });
    expect(mine.body).toMatchObject({ code: "MV6_OWN_ENDS_BEFORE", vars: { until: day(20), date: day(30) } });
    expect((await book(member, { courtId: pool, date: day(10), start: at(11), end: at(12) })).status).toBe(201);
    // A venue selling memberships online sends people to its plans; one that does not, to its counter ("").
    const paying = (await createVenue({ name: "Paying Club", area: "Bangsar", address: "x", phone: "0312360703", openMin: at(7), closeMin: at(23) })) as { ok: true; venue: { id: number } };
    expect((await setAccessSettings(paying.venue.id, { access: "members" })).ok).toBe(true);
    expect((await savePaymentSettings(paying.venue.id, { apiKey: "api-key-1234", collectionId: "col123", xSignatureKey: "S-key", sandbox: true, enabled: true })).ok).toBe(true);
    expect((await createPlan(paying.venue.id, { name: "Junior", months: 12, price: 50, offeredFor: "participant" })).ok).toBe(true);
    expect(await renewPath(paying.venue.id, true)).toBe(`/venue/${paying.venue.id}#membership`);
    expect(await renewPath(paying.venue.id, false)).toBe("");
    expect(await renewPath(club, true)).toBe("");
    const parent = await adult("Dad");
    const kid = await child(parent, "Badri");
    await membership(parent, { venueId: paying.venue.id, participantId: kid.id, until: day(5) });
    const lane = (await createResources({ venueId: paying.venue.id, sport: "swimming", name: "Lane", offPeakRate: 5, peakRate: 5, capacity: 6, maxPlayers: 6 })) as { ok: true; courts: { id: number; capacity: number }[] };
    expect(await membersOnlyRefusal({ venueId: paying.venue.id, court: lane.courts[0], participants: [kid], dates: [day(9)] })).toMatchObject({
      code: "MV6_ENDS_BEFORE",
      vars: { renew: `/venue/${paying.venue.id}#membership` },
    });
  });

  it("a family membership covers exactly the people it names, and its holder", async () => {
    const parent = await adult("Family");
    const named = await child(parent, "Cahaya");
    const other = await child(parent, "Dian");
    await membership(parent, { covers: [named.id] });
    expect((await book(parent, { courtId: pool, date: day(4), start: at(13), end: at(14), participantIds: [named.id], customerTakesPart: true })).status).toBe(201);
    expect((await book(parent, { courtId: pool, date: day(4), start: at(15), end: at(16), participantIds: [other.id] })).body).toMatchObject({
      code: "ENT_MEMBERS_PLACE",
      vars: { name: "Dian" },
    });
  });

  it("the counter, the venue's API key, a class, the waiting list (joining, the offer and its claim) and a move all ask the same check", async () => {
    // At the counter and through the API: a child the venue knows, their membership ending on day 20.
    const ph = phone();
    const known = await createAtVenue({ venueId: club, admin: { id: manager.id, name: manager.name }, displayName: "Elya", guardian: { name: "Puan E", phone: ph, relationship: "parent", authority: true } });
    if (!known.ok) throw new Error(known.error);
    await membership({ name: "Puan E", phone: ph }, { participantId: known.participant.id, until: day(20) });
    const counterBody = { courtId: pool, date: day(30), start: at(17), end: at(18), name: "Puan E", phone: ph, participantIds: [known.participant.id] };
    const atDesk = await book({ cookie: desk.cookie }, counterBody);
    expect(atDesk.body).toMatchObject({ code: "MV6_ENDS_BEFORE", vars: { name: "Elya", until: day(20), date: day(30) } });
    const key = await createApiKey(club, { name: "Club system", scope: "write" }, manager.id);
    if (!key.ok) throw new Error(key.error);
    const api = await apiBookingsRoute.POST(req("http://localhost/api/v1/bookings", "POST", null, counterBody, { authorization: `Bearer ${key.key}` }));
    expect(api.status).toBe(409);
    expect(await api.json()).toMatchObject({ code: "MV6_ENDS_BEFORE", vars: { name: "Elya", until: day(20) } });

    // Online: a class, its waiting list, and a move.
    const parent = await adult("Guardian");
    const kid = await child(parent, "Farah");
    await membership(parent, { participantId: kid.id, until: day(20) });
    const made = await createClassSessions({ courtId: pool, name: "Junior swim", instructor: "Coach", date: day(30), start: at(7), end: at(8), capacity: 1, price: 15 });
    if (!made.ok) throw new Error(made.error);
    const cls = made.classes[0];
    const enrol = (who: Adult, ids: number[]) =>
      enrolRoute.POST(req("http://localhost/api/classes/enrol", "POST", who.cookie, { classId: cls.id, name: who.name, phone: who.phone, participantIds: ids }));
    const refusedClass = await enrol(parent, [kid.id]);
    expect(refusedClass.status).toBe(409);
    expect(await refusedClass.json()).toMatchObject({ code: "MV6_ENDS_BEFORE", vars: { name: "Farah" } });
    // Somebody whose membership covers the day takes the one place.
    const first = await adult("First");
    const firstKid = await child(first, "Gita");
    await membership(first, { participantId: firstKid.id });
    const taken = await enrol(first, [firstKid.id]);
    expect(taken.status).toBe(201);
    const takenCode = ((await taken.json()) as { bookings: { code: string }[] }).bookings[0].code;
    // Farah may not wait for a place she could not take on the day.
    const wait = (who: Adult, ids: number[]) =>
      waitlistRoute.POST(req("http://localhost/api/waitlist", "POST", who.cookie, { classId: cls.id, name: who.name, phone: who.phone, participantIds: ids }));
    const noWait = await wait(parent, [kid.id]);
    expect(noWait.status).toBe(403);
    expect(await noWait.json()).toMatchObject({ code: "MV6_ENDS_BEFORE" });
    // Moving a booking past the day her membership ends: the same answer.
    const swim = await book(parent, { courtId: pool, date: day(15), start: at(9), end: at(10), participantIds: [kid.id] });
    expect(swim.status).toBe(201);
    expect(await rescheduleBooking(swim.body.booking.code, { date: day(25), start: at(9) }, "customer")).toMatchObject({ ok: false, code: "MV6_ENDS_BEFORE" });

    // The offer and its claim: Hana queues while covered; her membership then ends before the class.
    const waiter = await adult("Waiter");
    const hana = await child(waiter, "Hana");
    const hers = await membership(waiter, { participantId: hana.id });
    const queued = await wait(waiter, [hana.id]);
    expect(queued.status).toBe(201);
    const entryId = ((await queued.json()) as { entry: { id: number } }).entry.id;
    const endsOn = (date: string) => getDb().prepare("UPDATE memberships SET expires_on = ? WHERE id = ?").run(date, hers.id);
    await endsOn(day(20));
    // A place frees: not offered to somebody who could not take it; she keeps her place in the queue, to renew.
    expect((await cancelBooking(takenCode, first.phone)).ok).toBe(true);
    const status = async () => ((await getDb().prepare("SELECT status, offer_token FROM waitlist WHERE id = ?").get(entryId)) as { status: string; offer_token: string | null });
    expect((await status()).status).toBe("waiting");
    // Covered again: offered. Lapsed before she claims: refused with the reason, and back to waiting.
    await endsOn(day(60));
    expect((await offerClassPlace(cls.id))?.id).toBe(entryId);
    const token = (await status()).offer_token!;
    await endsOn(day(20));
    expect(await claimWaitlistOffer(token)).toMatchObject({ ok: false, code: "MV6_ENDS_BEFORE", vars: { name: "Hana", until: day(20) } });
    expect((await status()).status).toBe("waiting");
  });
});

describe("booking privileges: the account's, when the booking is made", () => {
  it("a member books further ahead; the booking stands when the membership later goes, and a move asks again", async () => {
    const member = await adult("Ahead");
    const m = await membership(member, { venueId: open, until: day(40) });
    const far = await book(member, { courtId: openHall, date: day(20), start: at(9), end: at(10) });
    expect(far.status).toBe(201);
    // Somebody who is not a member, and a number typed by somebody else: not past everybody's window.
    const other = await adult("Other");
    expect((await book(other, { courtId: openHall, date: day(20), start: at(11), end: at(12) })).body).toMatchObject({ code: "LIMIT_AHEAD_MEMBERS" });
    // A guest booking on the member's number, then moving it into the members' window by that number alone:
    // the account's privilege, never the number's (as booking online asks it).
    const guest = await bookingsRoute.POST(req("http://localhost/api/bookings", "POST", null, { courtId: openHall, date: day(5), start: at(9), end: at(10), name: "Somebody", phone: member.phone }));
    expect(guest.status).toBe(201);
    const guestCode = ((await guest.json()) as Body).booking.code;
    const moveGuest = await rescheduleRoute.POST(req("http://localhost/api/bookings/reschedule", "POST", null, { code: guestCode, phone: member.phone, date: day(21), start: "09:00" }));
    expect(moveGuest.status).toBe(409);
    expect(await moveGuest.json()).toMatchObject({ code: "LIMIT_AHEAD_MEMBERS" });
    // The member's own move, while a member: allowed.
    const moved = await rescheduleRoute.POST(req("http://localhost/api/bookings/reschedule", "POST", null, { code: far.body.booking.code, phone: member.phone, date: day(21), start: "09:00" }));
    expect(moved.status).toBe(200);
    // The membership is cancelled: the booking made with the privilege stands, nothing flagged at a public venue.
    const voided = await voidRoute.POST(req(`http://localhost/api/admin/memberships/${m.id}/void`, "POST", manager.cookie), { params: Promise.resolve({ id: String(m.id) }) });
    expect(voided.status).toBe(403); // another venue's membership: not this manager's
    const openManager = await staff(open, "manager");
    const voidedHere = await voidRoute.POST(req(`http://localhost/api/admin/memberships/${m.id}/void`, "POST", openManager.cookie), { params: Promise.resolve({ id: String(m.id) }) });
    expect(voidedHere.status).toBe(200);
    expect(((await voidedHere.json()) as { flagged: number }).flagged).toBe(0);
    expect((await getBookingById(far.body.booking.id))?.status).toBe("confirmed");
    expect(await participationLapses(far.body.booking.id)).toEqual([]);
    // Moving it again is booking it again for the new day: asked now, and no longer a member.
    const again = await rescheduleRoute.POST(req("http://localhost/api/bookings/reschedule", "POST", null, { code: far.body.booking.code, phone: member.phone, date: day(22), start: "09:00" }));
    expect(await again.json()).toMatchObject({ code: "LIMIT_AHEAD_MEMBERS" });
  });
});

describe("revalidated before taking part, and flagged, never cancelled, when a membership goes", () => {
  it("cancelled after booking: the bookings are flagged; self check-in and the door refuse with the reason; the desk is warned and decides, on the record", async () => {
    expect((await updateVenue(club, { staffedFrom: 0, staffedTo: 0 })).ok).toBe(true);
    expect((await updateCourt(floor, { unmanned: true, accessCode: "2468" })).ok).toBe(true);
    const parent = await adult("Holder");
    const kid = await child(parent, "Iman");
    const family = await membership(parent, { covers: [kid.id] });
    const swim = await book(parent, { courtId: floor, date: day(1), start: at(9), end: at(10), participantIds: [kid.id], customerTakesPart: true });
    expect(swim.status).toBe(201);
    const court = await book(parent, { courtId: hall, date: day(2), start: at(9), end: at(10) });
    expect(court.status).toBe(201);
    expect((await setPaymentStatus(swim.body.booking.code, true, "cash")).ok).toBe(true);
    for (const who of [null, kid])
      expect((await recordInduction({ venueId: club, phone: parent.phone, name: who?.name ?? parent.name, adminId: manager.id, participant: who })).ok).toBe(true);
    expect(await participationLapses(swim.body.booking.id)).toEqual([]);

    // Cancelled at the counter: both bookings flagged for staff, nothing cancelled, nothing refunded.
    const voided = await voidRoute.POST(req(`http://localhost/api/admin/memberships/${family.id}/void`, "POST", manager.cookie), { params: Promise.resolve({ id: String(family.id) }) });
    expect(voided.status).toBe(200);
    expect(((await voided.json()) as { flagged: number }).flagged).toBe(2);
    expect(await getBookingById(swim.body.booking.id)).toMatchObject({ status: "confirmed", paymentStatus: "paid" });
    const flags = await membershipFlags(club);
    const mine = flags.filter((f) => f.membershipId === family.id);
    expect(mine.map((f) => [f.bookingCode, f.name, f.reason, f.kind]).sort()).toEqual(
      [
        [swim.body.booking.code, parent.name, "cancelled", "place"],
        [swim.body.booking.code, "Iman", "cancelled", "place"],
        [court.body.booking.code, parent.name, "cancelled", "reservation"],
      ].sort()
    );
    // Asked again: flagged once.
    expect(await flagAfterMembershipLoss(family.id, "cancelled")).toBe(0);
    // The court reserved whole was the account's privilege when booked: not barred.
    expect(await participationLapses(court.body.booking.id)).toEqual([]);

    const on = day(1);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${on}T08:30:00+08:00`));
    // Self check-in from the QR code: refused, with why.
    const self = await selfCheckInRoute.POST(req("http://localhost/api/checkin", "POST", null, { token: swim.body.booking.checkInToken }));
    expect(self.status).toBe(409);
    expect(await self.json()).toMatchObject({ code: "MV6_CHECKIN_CANCELLED", vars: { name: parent.name, date: on } });
    expect(await checkInByToken(swim.body.booking.checkInToken!)).toMatchObject({ ok: false, code: "MV6_CHECKIN_CANCELLED" });
    // The door code: not given, with why.
    expect(await accessCodeFor(swim.body.booking.code, parent.phone)).toMatchObject({ ok: false, reason: "membership", code: "MV6_DOOR_CANCELLED" });
    const door = await accessRoute.POST(req("http://localhost/api/access", "POST", null, { code: swim.body.booking.code, phone: parent.phone }));
    expect(door.status).toBe(409);
    expect(await door.json()).toMatchObject({ reason: "membership", code: "MV6_DOOR_CANCELLED", vars: { name: parent.name } });
    // The desk: warned, with who and why; admitting them is their decision, kept and logged.
    const warned = await checkInRoute.POST(req("http://localhost/api/admin/check-in", "POST", desk.cookie, { code: swim.body.booking.code }));
    expect(warned.status).toBe(409);
    const warning = (await warned.json()) as { code: string; warnings: { name: string; lapse: { kind: string } }[] };
    expect(warning.code).toBe("MV6_DESK_WARNING");
    expect(warning.warnings.map((w) => [w.name, w.lapse.kind])).toEqual([
      [parent.name, "cancelled"],
      ["Iman", "cancelled"],
    ]);
    expect(await checkIn(swim.body.booking.code)).toMatchObject({ ok: false, code: "MV6_DESK_WARNING" });
    const admitted = await checkInRoute.POST(req("http://localhost/api/admin/check-in", "POST", desk.cookie, { code: swim.body.booking.code, admit: true, note: "Renewing at the counter now" }));
    expect(admitted.status).toBe(200);
    vi.useRealTimers();
    const kept = (await getDb()
      .prepare("SELECT person_name, lapse, admin_name, note FROM membership_admissions WHERE booking_id = ? ORDER BY id")
      .all(swim.body.booking.id)) as { person_name: string; lapse: string; admin_name: string; note: string }[];
    expect(kept).toEqual([
      { person_name: parent.name, lapse: "cancelled", admin_name: desk.name, note: "Renewing at the counter now" },
      { person_name: "Iman", lapse: "cancelled", admin_name: desk.name, note: "Renewing at the counter now" },
    ]);
    const log = await listActivity([club], { bookingCode: swim.body.booking.code });
    expect(log.some((e) => e.action === "checkin.membership_admitted" && /Iman/.test(e.detail ?? "") && /Renewing/.test(e.detail ?? ""))).toBe(true);

    // Staff deal with each flag and say what they did; another venue's staff cannot.
    const listed = await flagsRoute.GET(req(`http://localhost/api/admin/memberships/flags?venueId=${club}`, "GET", desk.cookie));
    const shown = ((await listed.json()) as { flags: { id: number; bookingCode: string }[] }).flags;
    const one = shown.find((f) => f.bookingCode === court.body.booking.code)!;
    const noNote = await flagsRoute.POST(req("http://localhost/api/admin/memberships/flags", "POST", desk.cookie, { venueId: club, flagId: one.id }));
    expect(noNote.status).toBe(400);
    const outsider = await staff(open, "manager");
    expect((await flagsRoute.POST(req("http://localhost/api/admin/memberships/flags", "POST", outsider.cookie, { venueId: club, flagId: one.id, note: "x" }))).status).toBe(403);
    const resolved = await flagsRoute.POST(req("http://localhost/api/admin/memberships/flags", "POST", desk.cookie, { venueId: club, flagId: one.id, note: "Kept: renewed today" }));
    expect(resolved.status).toBe(200);
    expect(((await resolved.json()) as { flags: { id: number }[] }).flags.some((f) => f.id === one.id)).toBe(false);
    expect((await listActivity([club], { bookingCode: court.body.booking.code })).some((e) => e.action === "membership.flag_resolved")).toBe(true);
  });

  it("somebody taken off a family membership: their places are flagged, the others' are not", async () => {
    const plan = await createPlan(club, { name: "Family", months: 12, price: 300, offeredFor: "family", familyLimit: 3 });
    if (!plan.ok) throw new Error(plan.error);
    const parent = await adult("Fam");
    const stays = await child(parent, "Jaya");
    const goes = await child(parent, "Kamal");
    const fam = await membership(parent, { covers: [stays.id, goes.id], planId: plan.plan.id });
    const a = await book(parent, { courtId: pool, date: day(6), start: at(9), end: at(10), participantIds: [stays.id] });
    const b = await book(parent, { courtId: pool, date: day(6), start: at(11), end: at(12), participantIds: [goes.id] });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect((await changeCovers(parent.id, fam.id, [stays.id])).ok).toBe(true);
    const flags = (await membershipFlags(club)).filter((f) => f.membershipId === fam.id);
    expect(flags.map((f) => [f.bookingCode, f.name, f.reason])).toEqual([[b.body.booking.code, "Kamal", "uncovered"]]);
    expect(await participationLapses(a.body.booking.id)).toEqual([]);
    expect((await participationLapses(b.body.booking.id)).map((l) => [l.name, l.lapse?.kind])).toEqual([["Kamal", "none"]]);
  });
});
