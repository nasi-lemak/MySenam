import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { addAccess, setAccessSettings } from "../src/lib/access";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { createApiKey } from "../src/lib/api-keys";
import { registerUser } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { setHouseRules } from "../src/lib/house-rules";
import { translator } from "../src/lib/i18n";
import { blockPhone, unblockPhone } from "../src/lib/limits";
import { notifyPendingOffers } from "../src/lib/notify";
import { createResources } from "../src/lib/resources";
import { cancelBooking, claimWaitlistOffer, createBookingSeries, createClassSessions, createVenue, enrolPeople, getClass, joinSlotWaitlist } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import * as adminWaitlist from "../src/app/api/admin/waitlist/route";
import * as apiWaitlist from "../src/app/api/v1/waitlist/route";
import * as waitlistRoute from "../src/app/api/waitlist/route";
import * as claimRoute from "../src/app/api/waitlist/claim/route";

/**
 * The venue's say, asked again when a waiting-list place is offered and when
 * it is claimed (lib/store.ts `entryRefused`;
 * docs/features/booking.md#waitlists), for an entry made online, at the
 * counter or through the API: a number the venue refuses after it joined
 * leaves the queue and the place goes to the next; a venue not open to
 * customers, or one whose access no longer admits the account that queued
 * online, offers it nothing while so, and the entry keeps its place. And the
 * counter asks the caller's language: the offer goes in it.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (k: number) => addDays(todayISO(ZONE), k);
const at = (h: number) => h * 60;
let n = 0;
const phone = () => `0177${String(++n).padStart(6, "0")}`;

type Staff = { id: number; name: string; cookie: string };

let venue: number;
let gated: number;
let hall: number;
let hall2: number;
let floor: number;
let gatedCourt: number;
let manager: Staff;
let desk: Staff;
let writeKey: string;

async function staffMember(venueId: number, name: string, role: "manager" | "desk" = "manager"): Promise<Staff> {
  const made = await createAdmin({ name, email: `${name.toLowerCase().replace(/\W/g, "")}${++n}@wl5b.test`, password: "a long enough password", venueId, role });
  if (!made.ok) throw new Error(made.error);
  return { id: made.admin.id, name, cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}` };
}

const req = (url: string, method: string, cookie: string | null, body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.66.${++n % 250}.${n % 200}`, ...(cookie ? { cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

type Answer = { status: number; body: { entry: { id: number; locale: string }; position: number; code?: string } };
const counter = async (who: Staff, body: Record<string, unknown>): Promise<Answer> => {
  const res = await adminWaitlist.POST(req("http://localhost/api/admin/waitlist", "POST", who.cookie, { venueId: venue, ...body }));
  return { status: res.status, body: await res.json() };
};
const viaApi = async (body: Record<string, unknown>): Promise<Answer> => {
  const res = await apiWaitlist.POST(req("http://localhost/api/v1/waitlist", "POST", null, body, { authorization: `Bearer ${writeKey}` }));
  return { status: res.status, body: await res.json() };
};
const online = async (body: Record<string, unknown>): Promise<Answer> => {
  const res = await waitlistRoute.POST(req("http://localhost/api/waitlist", "POST", null, body));
  return { status: res.status, body: await res.json() };
};
const state = async (id: number) => (await getDb().prepare("SELECT status, offer_token FROM waitlist WHERE id = ?").get(id)) as { status: string; offer_token: string | null };
const holds = async (id: number) => ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM claims WHERE waitlist_id = ? AND active").get(id)) as { n: number }).n;
const bookedOn = async (ph: string) => ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE phone_key = phone_key(?)").get(ph)) as { n: number }).n;
const refuse = (ph: string, venueId = venue) => blockPhone({ venueId, phone: ph, reason: "Abusive on the phone", adminId: manager.id });
const unlist = (venueId: number) => getDb().prepare("UPDATE venues SET suspended_at = datetime('now') WHERE id = ?").run(venueId);
const relist = (venueId: number) => getDb().prepare("UPDATE venues SET suspended_at = NULL WHERE id = ?").run(venueId);

/** The court taken from `start` for an hour by somebody else. */
async function take(courtId: number, date: string, start: number, players?: number) {
  const made = await createBookingSeries({ courtId, date, start, end: start + 60, weeks: 1, name: "Taken By", phone: phone(), by: "staff", ...(players ? { players } : {}) });
  if (!made.ok) throw new Error(made.error);
  return made.bookings[0];
}

/** A class of one place, filled. */
async function fullClass(date: string, start: number) {
  const made = await createClassSessions({ courtId: floor, name: `Circuit ${++n}`, instructor: "Coach", date, start, end: start + 60, capacity: 1, price: 12 });
  if (!made.ok) throw new Error(made.error);
  const filler = phone();
  const filled = await enrolPeople({ classId: made.classes[0].id, name: "Filler", phone: filler, people: [null] });
  if (!filled.ok) throw new Error(filled.error);
  return { cls: made.classes[0], code: filled.bookings[0].code, phone: filler };
}

beforeAll(async () => {
  const make = async (name: string, ph: string) => {
    const v = await createVenue({ name, area: "Bangsar", address: "x", phone: ph, openMin: at(7), closeMin: at(23) });
    if (!v.ok) throw new Error("venue");
    return v.venue.id;
  };
  const resource = async (venueId: number, sport: string, name: string, capacity = 1) => {
    const r = await createResources({ venueId, sport, name, offPeakRate: 20, peakRate: 20, capacity, ...(capacity > 1 ? { maxPlayers: capacity } : {}) });
    if (!r.ok) throw new Error(r.error);
    return r.courts[0].id;
  };
  venue = await make("Recheck Centre", "0312350901");
  gated = await make("Residents' Courts", "0312350902");
  hall = await resource(venue, "badminton", "Hall 1");
  hall2 = await resource(venue, "badminton", "Hall 2");
  floor = await resource(venue, "gym", "Gym floor", 4);
  gatedCourt = await resource(gated, "badminton", "Residents' court");
  await setAccessSettings(gated, { access: "private" });
  for (const v of [venue, gated]) expect((await setHouseRules(v, { aheadDays: 45 })).ok).toBe(true);
  manager = await staffMember(venue, "Mira Manager");
  desk = await staffMember(venue, "Dina Desk", "desk");
  const w = await createApiKey(venue, { name: "Front desk system", scope: "write" }, manager.id);
  if (!w.ok) throw new Error("key");
  writeKey = w.key;
});

// ---------------------------------------------------------------------------------------------- a number refused after joining

describe("a number the venue refuses after it joined", () => {
  it("online: gets no offer, leaves the queue, and the place goes to the next", async () => {
    const date = day(3);
    const taken = await take(hall, date, at(18));
    const ph = phone();
    const first = await online({ courtId: hall, date, start: at(18), end: at(19), name: "Online Omar", phone: ph });
    expect(first.status).toBe(201);
    const second = await online({ courtId: hall, date, start: at(18), end: at(19), name: "Next Nadia", phone: phone() });
    expect(second.status).toBe(201);
    await refuse(ph);
    expect((await cancelBooking(taken.code, taken.phone)).ok).toBe(true);
    expect((await state(first.body.entry.id)).status).toBe("cancelled");
    expect(await holds(first.body.entry.id)).toBe(0);
    expect((await state(second.body.entry.id)).status).toBe("offered");
  });

  it("online: refused at the claim when refused after the offer, booked nothing, and the place passes on", async () => {
    const date = day(4);
    const taken = await take(hall2, date, at(10));
    const ph = phone();
    const first = await online({ courtId: hall2, date, start: at(10), end: at(11), name: "Online Ola", phone: ph });
    const second = await online({ courtId: hall2, date, start: at(10), end: at(11), name: "Next Nora", phone: phone() });
    expect((await cancelBooking(taken.code, taken.phone)).ok).toBe(true);
    const offer = await state(first.body.entry.id);
    expect(offer.status).toBe("offered");
    await refuse(ph);
    const claimed = await claimRoute.POST(req("http://localhost/api/waitlist/claim", "POST", null, { token: offer.offer_token }));
    expect(claimed.status).toBe(409);
    expect(((await claimed.json()) as { code: string }).code).toBe("PHONE_BLOCKED");
    expect(await bookedOn(ph)).toBe(0);
    expect((await state(first.body.entry.id)).status).toBe("cancelled");
    expect(await holds(first.body.entry.id)).toBe(0);
    expect((await state(second.body.entry.id)).status).toBe("offered");
    // The token is spent: asking again changes nothing.
    expect((await claimWaitlistOffer(offer.offer_token!)).ok).toBe(false);
  });

  it("at the counter, a class place: refused at the offer and at the claim; the next is enrolled instead", async () => {
    const date = day(5);
    const full = await fullClass(date, at(16));
    const refusedFirst = phone();
    const a = await counter(desk, { classId: full.cls.id, name: "Encik Ali", phone: refusedFirst });
    const refusedLater = phone();
    const b = await counter(desk, { classId: full.cls.id, name: "Encik Badrul", phone: refusedLater });
    const nextPhone = phone();
    const c = await counter(desk, { classId: full.cls.id, name: "Puan Chong", phone: nextPhone });
    for (const x of [a, b, c]) expect(x.status).toBe(201);
    // Refused before any offer: passed over at the offer, out of the queue.
    await refuse(refusedFirst);
    expect((await cancelBooking(full.code, full.phone)).ok).toBe(true);
    expect((await state(a.body.entry.id)).status).toBe("cancelled");
    const offer = await state(b.body.entry.id);
    expect(offer.status).toBe("offered");
    // Refused while the offer is out: the claim is refused, nobody enrolled, and the place goes to the next.
    await refuse(refusedLater);
    const claimed = await claimWaitlistOffer(offer.offer_token!);
    expect(claimed.ok).toBe(false);
    if (!claimed.ok) expect(claimed.code).toBe("PHONE_BLOCKED");
    expect((await getClass(full.cls.id))!.enrolled).toBe(0);
    expect((await state(b.body.entry.id)).status).toBe("cancelled");
    const next = await state(c.body.entry.id);
    expect(next.status).toBe("offered");
    const enrolled = await claimWaitlistOffer(next.offer_token!);
    expect(enrolled.ok).toBe(true);
    expect((await getClass(full.cls.id))!.enrolled).toBe(1);
  });

  it("through the API: passed over at the offer; lifting the refusal later does not bring the entry back", async () => {
    const date = day(6);
    const taken = await take(floor, date, at(9), 4);
    const ph = phone();
    const first = await viaApi({ courtId: floor, date, start: "09:00", end: "10:00", name: "System Sara", phone: ph });
    expect(first.status).toBe(201);
    const second = await viaApi({ courtId: floor, date, start: "09:00", end: "10:00", name: "System Sam", phone: phone() });
    expect(second.status).toBe(201);
    await refuse(ph);
    expect((await cancelBooking(taken.code, taken.phone)).ok).toBe(true);
    expect((await state(first.body.entry.id)).status).toBe("cancelled");
    expect((await state(second.body.entry.id)).status).toBe("offered");
    expect(await unblockPhone(venue, ph)).toBe(true);
    expect((await state(first.body.entry.id)).status).toBe("cancelled");
    expect(await bookedOn(ph)).toBe(0);
  });

  it("another venue's refusal of the number changes nothing here", async () => {
    const date = day(7);
    const taken = await take(hall, date, at(12));
    const ph = phone();
    const joined = await counter(manager, { courtId: hall, date, start: at(12), end: at(13), name: "Elsewhere Refused", phone: ph });
    expect(joined.status).toBe(201);
    await refuse(ph, gated);
    expect((await cancelBooking(taken.code, taken.phone)).ok).toBe(true);
    const offer = await state(joined.body.entry.id);
    expect(offer.status).toBe("offered");
    expect((await claimWaitlistOffer(offer.offer_token!)).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------- not open, not admitted

describe("a venue not open, or no longer admitting the account", () => {
  it("unlisted: nobody is offered a place, a live offer cannot be claimed and goes back to waiting; nobody loses their place", async () => {
    const date = day(8);
    const taken = await take(hall2, date, at(14));
    const ph = phone();
    const first = await counter(desk, { courtId: hall2, date, start: at(14), end: at(15), name: "Counter Kim", phone: ph });
    const second = await online({ courtId: hall2, date, start: at(14), end: at(15), name: "Online Lim", phone: phone() });
    expect(second.status).toBe(201);
    await unlist(venue);
    try {
      expect((await cancelBooking(taken.code, taken.phone)).ok).toBe(true);
      expect((await state(first.body.entry.id)).status).toBe("waiting");
      expect((await state(second.body.entry.id)).status).toBe("waiting");
    } finally {
      await relist(venue);
    }

    // Offered once open again (a place freeing), then unlisted before the claim.
    const again = await take(hall2, date, at(14));
    expect((await cancelBooking(again.code, again.phone)).ok).toBe(true);
    const offer = await state(first.body.entry.id);
    expect(offer.status).toBe("offered");
    await unlist(venue);
    try {
      const claimed = await claimWaitlistOffer(offer.offer_token!);
      expect(claimed.ok).toBe(false);
      if (!claimed.ok) expect(claimed.code).toBe("VENUE_NOT_OPEN");
      expect(await bookedOn(ph)).toBe(0);
      expect((await state(first.body.entry.id)).status).toBe("waiting");
      expect(await holds(first.body.entry.id)).toBe(0);
      expect((await state(second.body.entry.id)).status).toBe("waiting");
    } finally {
      await relist(venue);
    }
  });

  it("made online at a private venue: off its list, the account is passed over and keeps its place; the next is offered", async () => {
    const date = day(9);
    const taken = await take(gatedCourt, date, at(19));
    const residentPhone = phone();
    const reg = await registerUser({ name: "Resident Rina", email: `rina${++n}@wl5b.test`, phone: residentPhone, password: "a long enough password" });
    if (!reg.ok) throw new Error(reg.error);
    const nextPhone = phone();
    const neighbour = await registerUser({ name: "Neighbour Ng", email: `ng${++n}@wl5b.test`, phone: nextPhone, password: "a long enough password" });
    if (!neighbour.ok) throw new Error(neighbour.error);
    expect((await addAccess(gated, [{ phone: residentPhone }, { phone: nextPhone }], null)).ok).toBe(true);
    // Queued as the online route queues a signed-in resident (its own checks passed while on the list).
    const first = await joinSlotWaitlist({ courtId: gatedCourt, date, start: at(19), end: at(20), name: "Resident Rina", phone: residentPhone, userId: reg.user.id });
    const second = await joinSlotWaitlist({ courtId: gatedCourt, date, start: at(19), end: at(20), name: "Neighbour Ng", phone: nextPhone, userId: neighbour.user.id });
    if (!first.ok || !second.ok) throw new Error("joined");
    await getDb().prepare("DELETE FROM venue_access_list WHERE venue_id = ? AND phone_key = phone_key(?)").run(gated, residentPhone);
    expect((await cancelBooking(taken.code, taken.phone)).ok).toBe(true);
    expect((await state(first.entry.id)).status).toBe("waiting");
    const offer = await state(second.entry.id);
    expect(offer.status).toBe("offered");
    // Off the list while the offer is out: refused at the claim, back to waiting, its hold let go.
    await getDb().prepare("DELETE FROM venue_access_list WHERE venue_id = ? AND phone_key = phone_key(?)").run(gated, nextPhone);
    const claimed = await claimWaitlistOffer(offer.offer_token!);
    expect(claimed.ok).toBe(false);
    if (!claimed.ok) expect(claimed.code).toBe("PRIVATE_VENUE");
    expect((await state(second.entry.id)).status).toBe("waiting");
    expect(await holds(second.entry.id)).toBe(0);
    expect(await bookedOn(nextPhone)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------- the caller's language

describe("the language the counter or the API gives", () => {
  it("is kept on the entry and the offer goes in it", async () => {
    const date = day(10);
    const taken = await take(hall, date, at(20));
    const joined = await counter(desk, { courtId: hall, date, start: at(20), end: at(21), name: "Encik Tan", phone: phone(), email: "tan@wl5b.test", locale: "zh" });
    expect(joined.status).toBe(201);
    expect(joined.body.entry.locale).toBe("zh");
    expect((await cancelBooking(taken.code, taken.phone)).ok).toBe(true);
    const offer = await state(joined.body.entry.id);
    expect(offer.status).toBe("offered");
    await notifyPendingOffers();
    const told = (await getDb().prepare("SELECT channel, locale, subject FROM messages WHERE dedupe_key = ?").all(`offer:${offer.offer_token}`)) as {
      channel: string;
      locale: string;
      subject: string | null;
    }[];
    expect(told.length).toBeGreaterThan(0);
    expect(told.every((m) => m.locale === "zh")).toBe(true);
    const email = told.find((m) => m.channel === "email");
    expect(email?.subject).toBe(translator("zh")("msg.offerSubject", { venue: "Recheck Centre" }));
  });

  it("through the API too; English when none is given; a language the site does not have is refused", async () => {
    const date = day(11);
    await take(hall2, date, at(8));
    const ta = await viaApi({ courtId: hall2, date, start: "08:00", end: "09:00", name: "System Tamil", phone: phone(), locale: "ta" });
    expect(ta.status).toBe(201);
    expect(ta.body.entry.locale).toBe("ta");
    const none = await counter(desk, { courtId: hall2, date, start: at(8), end: at(9), name: "No Language", phone: phone() });
    expect(none.body.entry.locale).toBe("en");
    const bad = await counter(desk, { courtId: hall2, date, start: at(8), end: at(9), name: "Bad Language", phone: phone(), locale: "fr" });
    expect(bad.status).toBe(400);
  });
});
