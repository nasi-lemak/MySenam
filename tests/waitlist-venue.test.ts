import { beforeAll, describe, expect, it, vi } from "vitest";

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
import { getDb } from "../src/lib/db";
import { setHouseRules } from "../src/lib/house-rules";
import { blockPhone } from "../src/lib/limits";
import { notifyPendingOffers } from "../src/lib/notify";
import { bookingPlaces, createAtVenue, revokeGuardianship } from "../src/lib/participants";
import { createResources } from "../src/lib/resources";
import { addSignOff } from "../src/lib/sign-offs";
import { cancelBooking, claimWaitlistOffer, createBookingSeries, createClassSessions, createVenue, enrolPeople, getClass, listWaitlistFor } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { setWaiver } from "../src/lib/waivers";
import * as adminWaitlist from "../src/app/api/admin/waitlist/route";
import * as apiWaitlist from "../src/app/api/v1/waitlist/route";
import * as waitlistRoute from "../src/app/api/waitlist/route";
import * as claimRoute from "../src/app/api/waitlist/claim/route";

/**
 * The waiting list at the counter and through the venue's API key
 * (lib/waitlist-venue.ts; docs/features/booking.md#at-the-counter-and-through-the-api):
 * staff queue a caller for court time or a class place on their word for the
 * name and number, as a counter booking; the venue's write key does the
 * same. The rules are joining online's; participants are only those the
 * venue knows with a guardian on that number, checked again at the offer and
 * the claim; the offer books exactly those people; staff see who made each
 * entry and take off the ones the venue made.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (k: number) => addDays(todayISO(ZONE), k);
const at = (h: number) => h * 60;
let n = 0;
const phone = () => `0166${String(++n).padStart(6, "0")}`;

type Staff = { id: number; name: string; cookie: string };

let venue: number;
let otherVenue: number;
let club: number;
let hall: number;
let hall2: number;
let floor: number;
let lane: number;
let otherCourt: number;
let clubPool: number;
let manager: Staff;
let desk: Staff;
let otherManager: Staff;
let clubDesk: Staff;
let writeKey: string;
let readKey: string;
let otherKey: string;

async function staffMember(venueId: number, name: string, role: "manager" | "desk" = "manager"): Promise<Staff> {
  const made = await createAdmin({ name, email: `${name.toLowerCase().replace(/\W/g, "")}${++n}@wl5.test`, password: "a long enough password", venueId, role });
  if (!made.ok) throw new Error(made.error);
  return { id: made.admin.id, name, cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}` };
}

const req = (url: string, method: string, cookie: string | null, body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.55.${++n % 250}.${n % 200}`, ...(cookie ? { cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

type Answer = { status: number; body: Record<string, unknown> & { entry: { id: number; madeBy: string; places: number; participantNames?: string[] }; position: number; code?: string } };
const counter = async (who: Staff | null, body: Record<string, unknown>): Promise<Answer> => {
  const res = await adminWaitlist.POST(req("http://localhost/api/admin/waitlist", "POST", who?.cookie ?? null, { venueId: venue, ...body }));
  return { status: res.status, body: await res.json() };
};
const viaApi = async (key: string, body: Record<string, unknown>): Promise<Answer> => {
  const res = await apiWaitlist.POST(req("http://localhost/api/v1/waitlist", "POST", null, body, { authorization: `Bearer ${key}` }));
  return { status: res.status, body: await res.json() };
};
const remove = async (who: Staff, entryId: number, venueId = venue) => {
  const res = await adminWaitlist.DELETE(req("http://localhost/api/admin/waitlist", "DELETE", who.cookie, { venueId, entryId }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const state = async (id: number) => ((await getDb().prepare("SELECT status, offer_token FROM waitlist WHERE id = ?").get(id)) as { status: string; offer_token: string | null });

/** Somebody the venue knows, with their guardian's declaration taken at the counter, on `ph`. */
async function known(displayName: string, ph: string, venueId = venue, admin: Staff = manager) {
  const made = await createAtVenue({ venueId, admin: { id: admin.id, name: admin.name }, displayName, guardian: { name: `Guardian of ${displayName}`, phone: ph, relationship: "parent", authority: true } });
  if (!made.ok) throw new Error(made.error);
  return { id: made.participant.id, guardianshipId: made.guardianshipId };
}

/** The court taken from `start` for an hour by somebody else. */
async function take(courtId: number, date: string, start: number, players?: number) {
  const ph = phone();
  // Somebody the range has signed off, where it needs that.
  if (courtId === lane) await addSignOff({ venueId: venue, sport: "archery", phone: ph, name: "Taken By", adminId: manager.id });
  const made = await createBookingSeries({ courtId, date, start, end: start + 60, weeks: 1, name: "Taken By", phone: ph, by: "staff", ...(players ? { players } : {}) });
  if (!made.ok) throw new Error(made.error);
  return made.bookings[0];
}

beforeAll(async () => {
  const make = async (name: string, ph: string) => {
    const v = await createVenue({ name, area: "Bangsar", address: "x", phone: ph, openMin: at(7), closeMin: at(23) });
    if (!v.ok) throw new Error("venue");
    return v.venue.id;
  };
  const resource = async (venueId: number, sport: string, name: string, capacity = 1, rate = 20) => {
    const r = await createResources({ venueId, sport, name, offPeakRate: rate, peakRate: rate, capacity, ...(capacity > 1 ? { maxPlayers: capacity } : {}) });
    if (!r.ok) throw new Error(r.error);
    return r.courts[0].id;
  };
  venue = await make("Counter Centre", "0312350801");
  otherVenue = await make("Elsewhere Centre", "0312350802");
  club = await make("Members Pool Club", "0312350803");
  hall = await resource(venue, "badminton", "Hall 1");
  hall2 = await resource(venue, "badminton", "Hall 2");
  floor = await resource(venue, "gym", "Gym floor", 4, 10);
  lane = await resource(venue, "archery", "Range lane");
  otherCourt = await resource(otherVenue, "badminton", "Other hall");
  clubPool = await resource(club, "swimming", "Club pool", 8, 10);
  await setAccessSettings(club, { access: "members" });
  for (const v of [venue, otherVenue, club]) expect((await setHouseRules(v, { aheadDays: 45 })).ok).toBe(true);
  manager = await staffMember(venue, "Mira Manager");
  desk = await staffMember(venue, "Dina Desk", "desk");
  otherManager = await staffMember(otherVenue, "Oskar Other");
  clubDesk = await staffMember(club, "Chen Club", "desk");
  const w = await createApiKey(venue, { name: "Front desk system", scope: "write" }, manager.id);
  const r = await createApiKey(venue, { name: "Reports", scope: "read" }, manager.id);
  const o = await createApiKey(otherVenue, { name: "Their system", scope: "write" }, otherManager.id);
  if (!w.ok || !r.ok || !o.ok) throw new Error("keys");
  writeKey = w.key;
  readKey = r.key;
  otherKey = o.key;
});

// ---------------------------------------------------------------------------------------------- the counter

describe("at the counter", () => {
  it("the desk queues a caller for taken court time; the offer reaches them and books them; the log says who", async () => {
    const date = day(3);
    const taken = await take(hall, date, at(18));
    const ph = phone();
    // Free time is booked, not queued for.
    expect((await counter(desk, { courtId: hall, date, start: at(19), end: at(20), name: "Encik Caller", phone: ph })).body.code).toBe("SLOT_FREE_BOOK_IT");
    const joined = await counter(desk, { courtId: hall, date, start: at(18), end: at(19), name: "Encik Caller", phone: ph, email: "caller@wl5.test", locale: "ms" });
    expect(joined.status).toBe(201);
    expect(joined.body.position).toBe(1);
    expect(joined.body.entry).toMatchObject({ madeBy: "staff", madeByName: "Dina Desk", places: 1 });
    // On the record, and in the day's queues with who made it.
    const log = await listActivity([venue]);
    expect(log.some((e) => e.action === "waitlist.added" && e.adminName === "Dina Desk" && (e.detail ?? "").includes(`entry ${joined.body.entry.id}`))).toBe(true);
    const listed = (await (await adminWaitlist.GET(req(`http://localhost/api/admin/waitlist?venueId=${venue}&date=${date}`, "GET", desk.cookie))).json()) as {
      entries: { id: number; madeBy: string; offerToken: string | null }[];
    };
    expect(listed.entries.find((e) => e.id === joined.body.entry.id)).toMatchObject({ madeBy: "staff", offerToken: null });
    // The same number again: refused, as online.
    expect((await counter(manager, { courtId: hall, date, start: at(18), end: at(19), name: "Encik Caller", phone: ph })).body.code).toBe("ALREADY_WAITING");
    // Nor can they join online on top of it.
    const online = await waitlistRoute.POST(req("http://localhost/api/waitlist", "POST", null, { courtId: hall, date, start: at(18), end: at(19), name: "Encik Caller", phone: ph }));
    expect(((await online.json()) as { code: string }).code).toBe("ALREADY_WAITING");
    // The customer sees it on their number, as their own.
    expect((await listWaitlistFor(ph)).map((e) => e.id)).toContain(joined.body.entry.id);

    // The booking goes: offered to them, by the usual channels, in the language staff noted.
    expect((await cancelBooking(taken.code, taken.phone)).ok).toBe(true);
    const offer = await state(joined.body.entry.id);
    expect(offer.status).toBe("offered");
    await notifyPendingOffers();
    const told = (await getDb().prepare("SELECT recipient FROM messages WHERE dedupe_key = ?").all(`offer:${offer.offer_token}`)) as { recipient: string }[];
    expect(told.map((m) => m.recipient)).toContain("caller@wl5.test");
    const claimed = await claimRoute.POST(req("http://localhost/api/waitlist/claim", "POST", null, { token: offer.offer_token }));
    expect(claimed.status).toBe(200);
    const { booking } = (await claimed.json()) as { booking: { name: string; phone: string; startMin: number; courtId: number } };
    expect(booking).toMatchObject({ name: "Encik Caller", courtId: hall, startMin: at(18) });
    expect((await state(joined.body.entry.id)).status).toBe("claimed");
  });

  it("queues a known child with their guardian's number; the offer books exactly them, never the guardian", async () => {
    const date = day(4);
    const full = await take(floor, date, at(9), 4);
    const ph = phone();
    const a = await known("Aiman", ph);
    const b = await known("Batrisya", ph);
    const joined = await counter(desk, { courtId: floor, date, start: at(9), end: at(10), name: "Puan Guardian", phone: ph, participantIds: [a.id, b.id] });
    expect(joined.status).toBe(201);
    expect(joined.body.entry).toMatchObject({ places: 2, participantNames: ["Aiman", "Batrisya"], customerTakesPart: false });
    // The same child again, even on another entry: refused. A sibling on the same number is somebody else.
    const c = await known("Chinta", ph);
    expect((await counter(desk, { courtId: floor, date, start: at(9), end: at(10), name: "Puan Guardian", phone: ph, participantIds: [a.id] })).body.code).toBe("ALREADY_WAITING");
    expect((await counter(desk, { courtId: floor, date, start: at(9), end: at(10), name: "Puan Guardian", phone: ph, participantIds: [c.id] })).status).toBe(201);
    // The crowd goes: two places held, then booked for the two children only.
    expect((await cancelBooking(full.code, full.phone)).ok).toBe(true);
    const offer = await state(joined.body.entry.id);
    expect(offer.status).toBe("offered");
    const claimed = await claimWaitlistOffer(offer.offer_token!);
    if (!claimed.ok) throw new Error(claimed.error);
    expect(claimed.booking.players).toBe(2);
    expect(await bookingPlaces(claimed.booking.id)).toEqual([
      { customer: false, participantId: a.id, name: "Aiman" },
      { customer: false, participantId: b.id, name: "Batrisya" },
    ]);
    // Who put them on it: the member of staff who queued them.
    const added = (await getDb().prepare("SELECT added_by_admin_id FROM booking_participants WHERE booking_id = ? ORDER BY id").all(claimed.booking.id)) as { added_by_admin_id: number }[];
    expect(added.map((r) => r.added_by_admin_id)).toEqual([desk.id, desk.id]);
  });

  it("refuses a participant the venue does not know, or one whose guardian is not on that number", async () => {
    const date = day(5);
    await take(hall2, date, at(10));
    const elsewhere = await known("Elsewhere Kid", phone(), otherVenue, otherManager);
    const ph = phone();
    const notHere = await counter(desk, { courtId: hall2, date, start: at(10), end: at(11), name: "Puan X", phone: ph, participantIds: [elsewhere.id] });
    expect(notHere.status).toBe(404);
    expect(notHere.body.code).toBe("PTC_NOT_FOUND");
    const kid = await known("Danial", phone());
    const notGuardian = await counter(desk, { courtId: hall2, date, start: at(10), end: at(11), name: "Puan X", phone: ph, participantIds: [kid.id] });
    expect(notGuardian.status).toBe(409);
    expect(notGuardian.body.code).toBe("PBK_NOT_GUARDIAN");
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM waitlist WHERE phone = ?").get(ph)) as { n: number }).n).toBe(0);
  });

  it("revalidated at the offer: a guardian no longer acting for the child gets no offer, and the place goes to the next", async () => {
    const date = day(6);
    const taken = await take(hall2, date, at(15));
    const ph = phone();
    const kid = await known("Elena", ph);
    const first = await counter(desk, { courtId: hall2, date, start: at(15), end: at(16), name: "Encik Faiz", phone: ph, participantIds: [kid.id] });
    expect(first.status).toBe(201);
    const second = await counter(desk, { courtId: hall2, date, start: at(15), end: at(16), name: "Next In Line", phone: phone() });
    expect(second.status).toBe(201);
    expect(await revokeGuardianship(kid.guardianshipId, { venueId: venue, participantId: kid.id, admin: { id: manager.id, name: manager.name } }, "Not the guardian after all")).toEqual({ ok: true });
    expect((await cancelBooking(taken.code, taken.phone)).ok).toBe(true);
    expect((await state(first.body.entry.id)).status).toBe("cancelled");
    expect((await state(second.body.entry.id)).status).toBe("offered");
  });

  it("checked as the counter checks: a sign-off on the number counts, at the join and at the claim", async () => {
    const date = day(7);
    const taken = await take(lane, date, at(14));
    const ph = phone();
    // Nobody signed off on that number: not queued (online without an account it could never be).
    expect((await counter(desk, { courtId: lane, date, start: at(14), end: at(15), name: "Archer", phone: ph })).body.code).toBe("SIGN_OFF_NEEDED");
    await addSignOff({ venueId: venue, sport: "archery", phone: ph, name: "Archer", adminId: manager.id });
    const joined = await counter(desk, { courtId: lane, date, start: at(14), end: at(15), name: "Archer", phone: ph });
    expect(joined.status).toBe(201);
    expect((await cancelBooking(taken.code, taken.phone)).ok).toBe(true);
    const offer = await state(joined.body.entry.id);
    expect(offer.status).toBe("offered");
    const claimed = await claimWaitlistOffer(offer.offer_token!);
    expect(claimed.ok).toBe(true);
  });

  it("the same rules as online: a refused number, members' places each person's own, a women-only class said for", async () => {
    const date = day(8);
    await take(hall, date, at(11));
    const refused = phone();
    await blockPhone({ venueId: venue, phone: refused, adminId: manager.id });
    const blocked = await counter(desk, { courtId: hall, date, start: at(11), end: at(12), name: "Refused", phone: refused });
    expect(blocked.status).toBe(403);
    // Said for staff at the counter (ADR 0026).
    expect(blocked.body.code).toBe("R9_DESK_PHONE_BLOCKED");

    // A members' session at a members-only club: the child needs their own membership even to wait (asked before anything else).
    const made = await createClassSessions({ courtId: clubPool, name: "Junior swim", instructor: "Coach", date, start: at(17), end: at(18), capacity: 1, price: 15 });
    if (!made.ok) throw new Error(made.error);
    const ph = phone();
    const kid = await known("Hana", ph, club, clubDesk);
    const notMember = await adminWaitlist.POST(
      req("http://localhost/api/admin/waitlist", "POST", clubDesk.cookie, { venueId: club, classId: made.classes[0].id, name: "Puan Hana", phone: ph, participantIds: [kid.id] })
    );
    expect(notMember.status).toBe(403);
    expect(((await notMember.json()) as { code: string }).code).toBe("ENT_MEMBERS_PLACE");

    // A women-only class: staff say so for whoever it is, or nothing is queued.
    const ladies = await createClassSessions({ courtId: floor, name: "Ladies' circuit", instructor: "Coach", date, start: at(19), end: at(20), capacity: 1, price: 15, who: "women" });
    if (!ladies.ok) throw new Error(ladies.error);
    const cls = ladies.classes[0];
    expect((await enrolPeople({ classId: cls.id, name: "First Lady", phone: phone(), people: [null] })).ok).toBe(true);
    const unsaid = await counter(desk, { classId: cls.id, name: "Puan Siti", phone: phone() });
    expect(unsaid.status).toBe(403);
    expect(unsaid.body.code).toBe("WHO_CONFIRM_WOMEN");
    const said = await counter(desk, { classId: cls.id, name: "Puan Siti", phone: phone(), confirmWho: true });
    expect(said.status).toBe(201);
  });

  it("a full class: queued at the counter, offered when a place frees, and the child enrolled, not the guardian", async () => {
    const date = day(9);
    const made = await createClassSessions({ courtId: floor, name: "Kids circuit", instructor: "Coach", date, start: at(16), end: at(17), capacity: 1, price: 12 });
    if (!made.ok) throw new Error(made.error);
    const cls = made.classes[0];
    const fillerPhone = phone();
    const filled = await enrolPeople({ classId: cls.id, name: "Filler", phone: fillerPhone, people: [null] });
    if (!filled.ok) throw new Error(filled.error);
    const ph = phone();
    const kid = await known("Irfan", ph);
    const joined = await counter(desk, { classId: cls.id, name: "Puan Irfan", phone: ph, participantIds: [kid.id] });
    expect(joined.status).toBe(201);
    // In the class's queue, as staff see it, with who made it.
    expect((await adminWaitlist.GET(req(`http://localhost/api/admin/waitlist?venueId=${venue}&date=${date}`, "GET", manager.cookie))).status).toBe(200);
    expect((await cancelBooking(filled.bookings[0].code, fillerPhone)).ok).toBe(true);
    const offer = await state(joined.body.entry.id);
    expect(offer.status).toBe("offered");
    const claimed = await claimWaitlistOffer(offer.offer_token!);
    if (!claimed.ok) throw new Error(claimed.error);
    expect(claimed.bookings).toHaveLength(1);
    expect(await bookingPlaces(claimed.bookings[0].id)).toEqual([{ customer: false, participantId: kid.id, name: "Irfan" }]);
    expect((await getClass(cls.id))!.enrolled).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------- who may

describe("who may: the desk and managers of the venue, nobody else; entries the venue made", () => {
  it("signed out, or another venue's staff: refused; another venue's court or entry is not there", async () => {
    const date = day(10);
    await take(hall, date, at(9));
    const body = { courtId: hall, date, start: at(9), end: at(10), name: "Someone", phone: phone() };
    expect((await counter(null, body)).status).toBe(401);
    // Another venue's manager, at this venue: refused; at their own venue, with this venue's court: not there.
    expect((await counter(otherManager, body)).status).toBe(403);
    const theirs = await adminWaitlist.POST(req("http://localhost/api/admin/waitlist", "POST", otherManager.cookie, { venueId: otherVenue, ...body }));
    expect(theirs.status).toBe(404);
    // Nor this venue's desk, with another venue's court.
    const otherDate = await take(otherCourt, date, at(9));
    expect(otherDate.code).toBeTruthy();
    expect((await counter(desk, { ...body, courtId: otherCourt })).status).toBe(404);
    expect((await adminWaitlist.GET(req(`http://localhost/api/admin/waitlist?venueId=${venue}&date=${date}`, "GET", otherManager.cookie))).status).toBe(403);
    // The desk at its own venue: queued, and can take it off again.
    const joined = await counter(desk, body);
    expect(joined.status).toBe(201);
    expect((await remove(otherManager, joined.body.entry.id, otherVenue)).status).toBe(404);
    expect((await remove(otherManager, joined.body.entry.id)).status).toBe(403);
    expect((await state(joined.body.entry.id)).status).toBe("waiting");
    const gone = await remove(desk, joined.body.entry.id);
    expect(gone.status).toBe(200);
    expect((await state(joined.body.entry.id)).status).toBe("cancelled");
    expect((await listActivity([venue])).some((e) => e.action === "waitlist.removed" && e.adminName === "Dina Desk" && (e.detail ?? "").includes(`entry ${joined.body.entry.id}`))).toBe(true);
  });

  it("a customer's own online entry is theirs to leave; taking off a live offer passes it to the next", async () => {
    const date = day(11);
    const taken = await take(hall2, date, at(9));
    const online = await waitlistRoute.POST(req("http://localhost/api/waitlist", "POST", null, { courtId: hall2, date, start: at(9), end: at(10), name: "Online Olivia", phone: phone() }));
    expect(online.status).toBe(201);
    const onlineId = ((await online.json()) as { entry: { id: number } }).entry.id;
    const mine = await remove(manager, onlineId);
    expect(mine.status).toBe(409);
    expect((await state(onlineId)).status).toBe("waiting");

    // Two the counter queued for the same time; the first is offered it, then taken off: the next has it.
    const later = await adminWaitlist.POST(req("http://localhost/api/admin/waitlist", "POST", manager.cookie, { venueId: venue, courtId: hall2, date, start: at(9), end: at(10), name: "Counter Carl", phone: phone() }));
    const laterId = ((await later.json()) as { entry: { id: number } }).entry.id;
    expect((await leave(onlineId)).ok).toBe(true);
    expect((await cancelBooking(taken.code, taken.phone)).ok).toBe(true);
    expect((await state(laterId)).status).toBe("offered");
    const third = await counter(desk, { courtId: hall2, date, start: at(9), end: at(10), name: "Third Tan", phone: phone() });
    expect((await remove(desk, laterId)).status).toBe(200);
    expect((await state(laterId)).status).toBe("cancelled");
    expect((await state(third.body.entry.id)).status).toBe("offered");
    // Nothing left holding the time for the one taken off.
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM claims WHERE waitlist_id = ? AND active").get(laterId)) as { n: number }).n).toBe(0);
  });
});

async function leave(entryId: number) {
  const row = (await getDb().prepare("SELECT phone FROM waitlist WHERE id = ?").get(entryId)) as { phone: string };
  const res = await waitlistRoute.DELETE(req("http://localhost/api/waitlist", "DELETE", null, { entryId, phone: row.phone }));
  return { ok: res.status === 200 };
}

// ---------------------------------------------------------------------------------------------- the venue's API key

describe("the venue's API key", () => {
  it("a write key queues for its own venue only; a read key sees, and queues nothing", async () => {
    const date = day(12);
    const taken = await take(hall, date, at(13));
    const ph = phone();
    const body = { courtId: hall, date, start: "13:00", end: "14:00", name: "Rang The System", phone: ph, email: "system@wl5.test" };
    expect((await viaApi(readKey, body)).status).toBe(403);
    expect((await viaApi("ms_w_notakeyatallnotakeyatall", body)).status).toBe(401);
    // Another venue's key: this venue's court is not there for it.
    const foreign = await viaApi(otherKey, body);
    expect(foreign.status).toBe(404);
    const joined = await viaApi(writeKey, body);
    expect(joined.status).toBe(201);
    expect(joined.body.entry).toMatchObject({ madeBy: "api", start: at(13), end: at(14), places: 1 });
    expect(JSON.stringify(joined.body)).not.toContain("offerToken");
    expect((await viaApi(writeKey, body)).body.code).toBe("ALREADY_WAITING");
    // On the record, as the key.
    expect((await listActivity([venue])).some((e) => e.action === "waitlist.added" && e.adminId === null && /^API key \d+$/.test(e.adminName))).toBe(true);
    // A read key sees the day's queues, without anybody's token; another venue's key sees none of them.
    const seen = (await (await apiWaitlist.GET(req(`http://localhost/api/v1/waitlist?date=${date}`, "GET", null, undefined, { authorization: `Bearer ${readKey}` }))).json()) as {
      entries: { id: number; madeBy: string }[];
    };
    expect(seen.entries.map((e) => e.id)).toContain(joined.body.entry.id);
    const theirs = (await (await apiWaitlist.GET(req(`http://localhost/api/v1/waitlist?date=${date}`, "GET", null, undefined, { authorization: `Bearer ${otherKey}` }))).json()) as {
      entries: unknown[];
    };
    expect(theirs.entries).toEqual([]);
    // Another venue's key cannot take it off; a read key cannot; the venue's write key can.
    const del = (key: string) => apiWaitlist.DELETE(req("http://localhost/api/v1/waitlist", "DELETE", null, { entryId: joined.body.entry.id }, { authorization: `Bearer ${key}` }));
    expect((await del(otherKey)).status).toBe(404);
    expect((await del(readKey)).status).toBe(403);
    expect((await state(joined.body.entry.id)).status).toBe("waiting");
    // Offered by the usual channels once the time frees.
    expect((await cancelBooking(taken.code, taken.phone)).ok).toBe(true);
    expect((await state(joined.body.entry.id)).status).toBe("offered");
    expect((await del(writeKey)).status).toBe(200);
    expect((await state(joined.body.entry.id)).status).toBe("cancelled");
  });

  it("participants as for a booking through the API: known here, guardian on the number, waiver on record", async () => {
    const date = day(13);
    await take(floor, date, at(9), 4);
    const ph = phone();
    const kid = await known("Kamal", ph);
    const body = { courtId: floor, date, start: at(9), end: at(10), name: "Encik Lee", phone: ph, participantIds: [kid.id] };
    expect((await viaApi(writeKey, { ...body, phone: phone() })).body.code).toBe("PBK_NOT_GUARDIAN");
    const elsewhere = await known("Ilham", phone(), otherVenue, otherManager);
    expect((await viaApi(writeKey, { ...body, participantIds: [elsewhere.id] })).status).toBe(404);
    expect((await setWaiver(venue, "Climbing, paddling and lifting carry risks; follow the staff's instructions at all times.")).ok).toBe(true);
    try {
      const noWaiver = await viaApi(writeKey, body);
      expect(noWaiver.status).toBe(409);
      expect(noWaiver.body.code).toBe("WAIVER_NEEDED");
    } finally {
      await setWaiver(venue, "");
    }
    const joined = await viaApi(writeKey, body);
    expect(joined.status).toBe(201);
    expect(joined.body.entry).toMatchObject({ madeBy: "api", participants: ["Kamal"], customerTakesPart: false });
  });
});
