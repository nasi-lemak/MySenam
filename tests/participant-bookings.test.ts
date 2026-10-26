import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { listActivity } from "../src/lib/activity";
import { createApiKey } from "../src/lib/api-keys";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { setHoldPolicy } from "../src/lib/holds";
import { addManaged } from "../src/lib/managed-people";
import { notifyPendingOffers } from "../src/lib/notify";
import { bookingPlaces, createAtVenue, participantHistory, revokeGuardianship } from "../src/lib/participants";
import { releaseExpiredHolds } from "../src/lib/holds";
import { savePaymentSettings, settleBill, startBookingPayment } from "../src/lib/payments";
import { createResources } from "../src/lib/resources";
import { saveRequirement } from "../src/lib/approvals";
import { addSignOff, revokeSignOff } from "../src/lib/sign-offs";
import {
  accessCodeFor,
  cancelBooking,
  claimWaitlistOffer,
  createBookingSeries,
  createClassSessions,
  createGroupBooking,
  createVenue,
  enrolInTerm,
  enrolPeople,
  findBooking,
  getClass,
  getWalletBalance,
  hireFor,
  joinClassWaitlist,
  joinSlotWaitlist,
  listBookingsForDate,
  listWaitlistForAccount,
  markPlace,
  offerClassPlace,
  offerSlotPlace,
  recordInduction,
  sellMembership,
  setPaymentStatus,
  takeHire,
  topUpWallet,
  updateCourt,
  updateVenue,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { setWaiver } from "../src/lib/waivers";
import { setHouseRules } from "../src/lib/house-rules";
import { saveCoach } from "../src/lib/coaching";
import { coachLessons } from "../src/lib/coach-schedule";
import * as bookingsRoute from "../src/app/api/bookings/route";
import * as enrolRoute from "../src/app/api/classes/enrol/route";
import * as waitlistRoute from "../src/app/api/waitlist/route";
import * as claimRoute from "../src/app/api/waitlist/claim/route";
import * as apiBookingsRoute from "../src/app/api/v1/bookings/route";
import * as apiBookingRoute from "../src/app/api/v1/bookings/[code]/route";
import * as checkInRoute from "../src/app/api/admin/check-in/route";
import * as quoteRoute from "../src/app/api/quote/route";
import * as participantsRoute from "../src/app/api/admin/participants/route";

/**
 * Every booking path participant-aware (ADR 0023;
 * lib/participant-bookings.ts; docs/features/booking.md#booking-for-somebody-else):
 * a guardian books for themself, for a child they act for, or for several
 * people; the venue's staff and its own system book for a child the venue
 * knows, with a guardian on the booking's number; each person takes a place
 * and is checked on their own; the guardian takes a place only when they
 * take part. Waiting lists keep who they are for, classes and terms enrol
 * each person, attendance is per person, and messages name who it is for.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (k: number) => addDays(todayISO(ZONE), k);
const at = (h: number) => h * 60;
let n = 0;
const phone = () => `0177${String(++n).padStart(6, "0")}`;

type Staff = { id: number; name: string; cookie: string };
type Adult = Awaited<ReturnType<typeof adult>>;

let venue: number;
let otherVenue: number;
let hall: number;
let hall2: number;
let floor: number;
let floor2: number;
let lane: number;
let kayak: number;
let otherCourt: number;
let manager: Staff;
let otherManager: Staff;

async function adult(name = "Parent") {
  const ph = phone();
  const made = await registerUser({ name: `${name} ${++n}`, email: `pb${n}@pbk.test`, phone: ph, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now'), verified_phone = phone WHERE id = ?").run(made.user.id);
  return { ...made.user, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}

async function staffMember(venueId: number, name: string, role: "manager" | "desk" = "manager"): Promise<Staff> {
  const made = await createAdmin({ name, email: `${name.toLowerCase().replace(/\W/g, "")}${++n}@pbk.test`, password: "a long enough password", venueId, role });
  if (!made.ok) throw new Error(made.error);
  return { id: made.admin.id, name, cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}` };
}

const req = (url: string, method: string, cookie: string | null, body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.77.${++n % 250}.${n % 200}`, ...(cookie ? { cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function child(parent: Adult, displayName: string) {
  const made = await addManaged(parent.id, { displayName, relationship: "parent", authority: true }, parent.name);
  if (!made.ok) throw new Error(`${made.code}: ${made.error}`);
  return { id: made.person.id, name: made.person.displayName };
}

const book = (who: Adult | Staff, body: Record<string, unknown>, asStaff = false) =>
  bookingsRoute.POST(req("http://localhost/api/bookings", "POST", who.cookie, { ...(asStaff ? {} : { name: (who as Adult).name, phone: (who as Adult).phone }), ...body }));

const placesHeld = async (courtId: number, date: string) =>
  Number(
    ((await getDb()
      .prepare(
        "SELECT COALESCE(SUM(c.places), 0) AS n FROM claims c JOIN bookings b ON b.id = c.booking_id WHERE c.court_id = ? AND c.active AND b.date = ?"
      )
      .get(courtId, date)) as { n: number | string }).n
  );

async function resource(venueId: number, sport: string, name: string, capacity = 1, rate = 20) {
  const r = await createResources({ venueId, sport, name, offPeakRate: rate, peakRate: rate, capacity, ...(capacity > 1 ? { maxPlayers: capacity } : {}) });
  if (!r.ok) throw new Error(r.error);
  return r.courts[0].id;
}

beforeAll(async () => {
  const make = async (name: string, ph: string) => {
    const v = await createVenue({ name, area: "Bangsar", address: "x", phone: ph, openMin: at(7), closeMin: at(23) });
    if (!v.ok) throw new Error("venue");
    return v.venue.id;
  };
  venue = await make("Family Centre", "0312350401");
  otherVenue = await make("Other Centre", "0312350402");
  hall = await resource(venue, "badminton", "Hall 1");
  hall2 = await resource(venue, "badminton", "Hall 2");
  floor = await resource(venue, "gym", "Gym floor", 6, 10);
  floor2 = await resource(venue, "gym", "Studio floor", 6, 10);
  lane = await resource(venue, "archery", "Range lane");
  kayak = await resource(venue, "kayak", "Kayaks", 4, 10);
  await updateCourt(kayak, { deposit: 50 });
  otherCourt = await resource(otherVenue, "badminton", "Other hall");
  const s = await saveRequirement(venue, { sport: "archery", declaration: "I will follow the range officer's calls.", validDays: 365 });
  if (!s.ok) throw new Error(s.error);
  // Nobody on the desk: door codes decide (lib/store.ts accessCodeFor).
  expect((await updateVenue(venue, { staffedFrom: 0, staffedTo: 0 })).ok).toBe(true);
  // Bookings a few weeks out, so each test has days of its own.
  expect((await setHouseRules(venue, { aheadDays: 45 })).ok).toBe(true);
  manager = await staffMember(venue, "Mira Manager");
  otherManager = await staffMember(otherVenue, "Oskar Other");
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------- online

describe("online: myself, a child I act for, or several people", () => {
  it("two children take two places, the guardian none unless taking part; each named, nobody else's child", async () => {
    const mum = await adult("Mum");
    const a = await child(mum, "Alya");
    const b = await child(mum, "Bilal");
    const res = await book(mum, { courtId: floor, date: day(2), start: at(9), end: at(10), participantIds: [a.id, b.id] });
    expect(res.status).toBe(201);
    const { booking } = (await res.json()) as { booking: { id: number; players: number; participantName: string; name: string } };
    expect(booking).toMatchObject({ players: 2, participantName: "Alya, Bilal", name: mum.name });
    expect(await bookingPlaces(booking.id)).toEqual([
      { customer: false, participantId: a.id, name: "Alya" },
      { customer: false, participantId: b.id, name: "Bilal" },
    ]);
    expect(await placesHeld(floor, day(2))).toBe(2);
    // Who did it, on whose behalf: in each child's history.
    expect((await participantHistory(a.id)).some((e) => e.action === "booking.made" && e.venueId === venue && e.detail?.startsWith("online:"))).toBe(true);

    // With the guardian taking part too: three places, three names.
    const res2 = await book(mum, { courtId: floor, date: day(2), start: at(11), end: at(12), participantIds: [a.id, b.id], customerTakesPart: true });
    expect(res2.status).toBe(201);
    const withMum = ((await res2.json()) as { booking: { id: number; players: number } }).booking;
    expect(withMum.players).toBe(3);
    expect((await bookingPlaces(withMum.id)).map((p) => p.customer)).toEqual([true, false, false]);

    // Somebody else's child, the same child twice, an empty list: refused, nothing booked.
    const other = await adult("Stranger");
    expect((await book(other, { courtId: floor, date: day(2), start: at(13), end: at(14), participantIds: [a.id] })).status).toBe(404);
    const twice = await book(mum, { courtId: floor, date: day(2), start: at(13), end: at(14), participantIds: [a.id, a.id] });
    expect(twice.status).toBe(400);
    expect(((await twice.json()) as { code: string }).code).toBe("PBK_TWICE");
    expect(await placesHeld(floor, day(2))).toBe(5);
    // A guest names nobody.
    expect(
      (await bookingsRoute.POST(req("http://localhost/api/bookings", "POST", null, { courtId: floor, date: day(2), start: at(15), end: at(16), name: "Guest", phone: phone(), participantIds: [a.id] }))).status
    ).toBe(404);
  });

  it("each is checked on their own: one child's sign-off never covers a sibling", async () => {
    const dad = await adult("Dad");
    const a = await child(dad, "Arif");
    const b = await child(dad, "Batrisya");
    await addSignOff({ venueId: venue, sport: "archery", phone: dad.phone, name: "Arif", adminId: manager.id, managedPersonId: a.id });
    const both = await book(dad, { courtId: lane, date: day(3), start: at(9), end: at(10), participantIds: [a.id, b.id] });
    expect(both.status).toBe(409);
    expect(((await both.json()) as { code: string }).code).toBe("SIGN_OFF_NEEDED");
    // Arif alone is fine; the father taking part needs his own too.
    expect((await book(dad, { courtId: lane, date: day(3), start: at(9), end: at(10), participantIds: [a.id], customerTakesPart: true })).status).toBe(409);
    expect((await book(dad, { courtId: lane, date: day(3), start: at(9), end: at(10), participantIds: [a.id] })).status).toBe(201);
  });

  it("a qualification that runs out before the day booked does not count", async () => {
    const mum = await adult("Mum");
    const a = await child(mum, "Aqil");
    await addSignOff({ venueId: venue, sport: "archery", phone: mum.phone, name: "Aqil", adminId: manager.id, managedPersonId: a.id, expiresOn: day(4) });
    expect((await book(mum, { courtId: lane, date: day(5), start: at(9), end: at(10), participantIds: [a.id] })).status).toBe(409);
    expect((await book(mum, { courtId: lane, date: day(4), start: at(9), end: at(10), participantIds: [a.id] })).status).toBe(201);
    // Nor, for a weekly series, if it runs out before the last week.
    expect((await book(mum, { courtId: lane, date: day(4), start: at(11), end: at(12), weeks: 2, participantIds: [a.id] })).status).toBe(409);
  });

  it("a membership prices a booking its holder takes part in, not one made only for a child", async () => {
    const mum = await adult("Member");
    const a = await child(mum, "Ayra");
    const sold = await sellMembership({ venueId: venue, holderName: mum.name, holderPhone: mum.phone, startsOn: todayISO(ZONE), expiresOn: day(60), price: 100, userId: mum.id });
    if (!sold.ok) throw new Error(sold.error);
    const priced = await updateCourt(hall2, { memberOffPeakRate: 5, memberPeakRate: 5 });
    if (!priced.ok) throw new Error(priced.error);
    const own = (await (await book(mum, { courtId: hall2, date: day(6), start: at(9), end: at(10) })).json()) as { booking: { totalPrice: number } };
    expect(own.booking.totalPrice).toBe(5);
    const forChild = (await (await book(mum, { courtId: hall2, date: day(6), start: at(10), end: at(11), participantIds: [a.id] })).json()) as { booking: { totalPrice: number } };
    expect(forChild.booking.totalPrice).toBe(20);
    const together = (await (await book(mum, { courtId: hall2, date: day(6), start: at(11), end: at(12), participantIds: [a.id], customerTakesPart: true })).json()) as {
      booking: { totalPrice: number };
    };
    expect(together.booking.totalPrice).toBe(5);
    // The price shown before booking says the same.
    const quote = async (extra: string) =>
      ((await (await quoteRoute.GET(req(`http://localhost/api/quote?courtId=${hall2}&date=${day(6)}&start=${at(13)}&end=${at(14)}${extra}`, "GET", mum.cookie))).json()) as { total: number }).total;
    expect(await quote("")).toBe(5);
    expect(await quote("&forOthers=1")).toBe(20);
  });

  it("the confirmation goes to the guardian and names who it is for", async () => {
    await getDb().prepare("UPDATE venues SET published_at = COALESCE(published_at, datetime('now')) WHERE id = ?").run(venue);
    const mum = await adult("Told");
    const a = await child(mum, "Aisyah");
    const res = await book(mum, { courtId: hall, date: day(7), start: at(9), end: at(10), email: mum.email, participantIds: [a.id] });
    expect(res.status).toBe(201);
    const { booking } = (await res.json()) as { booking: { id: number } };
    const msg = (await getDb().prepare("SELECT recipient, body FROM messages WHERE booking_id = ? AND kind = 'booking_confirmed' AND channel = 'email'").get(booking.id)) as
      | { recipient: string; body: string }
      | undefined;
    expect(msg?.recipient).toBe(mum.email);
    expect(msg?.body).toContain("for Aisyah");
  });
});

// ---------------------------------------------------------------------------------------------- several courts

describe("coaching: the child is the student; the adult books, pays and is told", () => {
  it("a lesson for a child names them to the coach", async () => {
    const hours = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: at(8), until: at(21) }));
    const coach = await saveCoach(venue, { name: "Coach Ana", sports: ["badminton"], rate: 40, hours });
    if (!coach.ok) throw new Error(coach.error);
    const mum = await adult("Mum");
    const a = await child(mum, "Amani");
    const res = await book(mum, { courtId: hall2, date: day(29), start: at(15), end: at(16), coachId: coach.coach.id, participantIds: [a.id] });
    expect(res.status).toBe(201);
    const { booking } = (await res.json()) as { booking: { code: string; coachId: number; participantName: string; name: string } };
    expect(booking).toMatchObject({ coachId: coach.coach.id, participantName: "Amani", name: mum.name });
    const lessons = await coachLessons(coach.coach.id, day(29), day(29));
    expect(lessons.find((l) => l.code === booking.code)).toMatchObject({ student: "Amani", phone: mum.phone });
  });
});

describe("several courts at once: people with the court they are on", () => {
  it("each court its own children; the guardian on none; nobody on two", async () => {
    const mum = await adult("Mum");
    const a = await child(mum, "Adam");
    const b = await child(mum, "Batrisyia");
    const res = await book(mum, { courtId: hall, date: day(8), start: at(9), end: at(10), participantIds: [a.id], moreCourts: [{ courtId: hall2, participantIds: [b.id] }] });
    expect(res.status).toBe(201);
    const { bookings } = (await res.json()) as { bookings: { id: number; courtId: number; groupCode: string }[] };
    const onHall = bookings.find((x) => x.courtId === hall)!;
    const onHall2 = bookings.find((x) => x.courtId === hall2)!;
    expect(await bookingPlaces(onHall.id)).toEqual([{ customer: false, participantId: a.id, name: "Adam" }]);
    expect(await bookingPlaces(onHall2.id)).toEqual([{ customer: false, participantId: b.id, name: "Batrisyia" }]);
    expect(onHall.groupCode).toBe(onHall2.groupCode);
    // The same child on two courts at the same time: refused, nothing held.
    const twice = await book(mum, { courtId: hall, date: day(8), start: at(11), end: at(12), participantIds: [a.id], moreCourts: [{ courtId: hall2, participantIds: [a.id] }] });
    expect(twice.status).toBe(409);
    expect((await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE court_id IN (?, ?) AND date = ? AND start_min = ?").get(hall, hall2, day(8), at(11))) as { n: number }).toEqual({ n: 0 });
  });

  it("places on shared resources follow who is on each; a court with nobody named is the customer's party", async () => {
    const dad = await adult("Dad");
    const a = await child(dad, "Ali");
    const b = await child(dad, "Badrul");
    const made = await createGroupBooking({
      courtIds: [floor, floor2],
      date: day(9),
      start: at(9),
      end: at(10),
      name: dad.name,
      phone: dad.phone,
      userId: dad.id,
      by: "staff",
      assign: { [floor]: { participants: [a, b], customerTakesPart: false } },
      placesByCourt: { [floor2]: 3 },
    });
    if (!made.ok) throw new Error(made.error);
    expect(await placesHeld(floor, day(9))).toBe(2);
    expect(await placesHeld(floor2, day(9))).toBe(3);
    const onFloor2 = made.bookings.find((x) => x.courtId === floor2)!;
    expect(await bookingPlaces(onFloor2.id)).toEqual([{ customer: true, participantId: null, name: null }]);
  });
});

// ---------------------------------------------------------------------------------------------- classes

async function aClass(capacity: number, k: number, weeks = 1) {
  const made = await createClassSessions({ courtId: floor, name: `Kids gym ${++n}`, instructor: "Coach Lim", date: day(k), start: at(17), end: at(18), capacity, price: 15, weeks });
  if (!made.ok) throw new Error(made.error);
  return made.classes;
}

describe("classes and terms: a place and an enrolment for each person", () => {
  it("two children, two enrolments; all or none; each child once, siblings on one number distinct", async () => {
    const [cls] = await aClass(3, 10);
    const mum = await adult("Mum");
    const a = await child(mum, "Amira");
    const b = await child(mum, "Bakri");
    const res = await enrolRoute.POST(req("http://localhost/api/classes/enrol", "POST", mum.cookie, { classId: cls.id, name: mum.name, phone: mum.phone, participantIds: [a.id, b.id] }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { bookings: { id: number; totalPrice: number; participantName: string }[] };
    expect(body.bookings.map((x) => x.participantName)).toEqual(["Amira", "Bakri"]);
    expect(body.bookings.map((x) => x.totalPrice)).toEqual([15, 15]);
    expect((await getClass(cls.id))!.enrolled).toBe(2);
    // Amira again: refused; the mother herself: her own place.
    expect((await enrolPeople({ classId: cls.id, name: mum.name, phone: mum.phone, userId: mum.id, people: [a] })).ok).toBe(false);
    // One place left, two children asked: neither.
    const dad = await adult("Dad");
    const c = await child(dad, "Chen");
    const d = await child(dad, "Dina");
    expect(await enrolPeople({ classId: cls.id, name: dad.name, phone: dad.phone, userId: dad.id, people: [c, d] })).toMatchObject({ ok: false, code: "CLASS_FULL" });
    expect((await getClass(cls.id))!.enrolled).toBe(2);
    const own = await enrolPeople({ classId: cls.id, name: mum.name, phone: mum.phone, userId: mum.id, people: [null] });
    expect(own.ok).toBe(true);
    expect((await getClass(cls.id))!.enrolled).toBe(3);
  });

  it("a term: both children in every session that can take both, a session that cannot skipped and said", async () => {
    const sessions = await aClass(2, 11, 3);
    const mum = await adult("Mum");
    const a = await child(mum, "Aiman");
    const b = await child(mum, "Batrisha");
    // The second session has one place left.
    const other = await adult("Other");
    expect((await enrolPeople({ classId: sessions[1].id, name: other.name, phone: other.phone, userId: other.id, people: [null] })).ok).toBe(true);
    const joined = await enrolInTerm({ classId: sessions[0].id, name: mum.name, phone: mum.phone, userId: mum.id, people: [a, b] });
    if (!joined.ok) throw new Error(joined.error);
    expect(joined.bookings).toHaveLength(4);
    expect(joined.skipped.map((s) => s.date)).toEqual([sessions[1].date]);
    expect((await getClass(sessions[1].id))!.enrolled).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------- waiting lists

describe("waiting lists keep who they are for", () => {
  it("a class entry for two children waits for two places, and is booked for them, never the guardian", async () => {
    const [cls] = await aClass(2, 12);
    const first = await adult("First");
    const f1 = await child(first, "Faris");
    const f2 = await child(first, "Fatin");
    expect((await enrolPeople({ classId: cls.id, name: first.name, phone: first.phone, userId: first.id, people: [f1, f2] })).ok).toBe(true);
    const mum = await adult("Mum");
    const a = await child(mum, "Anis");
    const b = await child(mum, "Basyir");
    const res = await waitlistRoute.POST(
      req("http://localhost/api/waitlist", "POST", mum.cookie, { classId: cls.id, name: mum.name, phone: mum.phone, email: mum.email, participantIds: [a.id, b.id] })
    );
    expect(res.status).toBe(201);
    const { entry } = (await res.json()) as { entry: { id: number; places: number; participantNames: string[]; customerTakesPart: boolean } };
    expect(entry).toMatchObject({ places: 2, participantNames: ["Anis", "Basyir"], customerTakesPart: false });
    // The same child again: refused. Their mother queuing for herself: her own entry.
    expect(await joinClassWaitlist({ classId: cls.id, name: mum.name, phone: mum.phone, userId: mum.id, people: { participants: [a], customerTakesPart: false } })).toMatchObject({
      ok: false,
      code: "ALREADY_WAITING",
    });
    // One place frees: too few for both, so no offer is made for them.
    const firstBookings = (await getDb().prepare("SELECT code FROM bookings WHERE class_id = ? ORDER BY id").all(cls.id)) as { code: string }[];
    expect((await cancelBooking(firstBookings[0].code, first.phone)).ok).toBe(true);
    expect(await offerClassPlace(cls.id)).toBeNull();
    // Both free: offered, both places held against anybody else.
    expect((await cancelBooking(firstBookings[1].code, first.phone)).ok).toBe(true);
    const offer = (await getDb().prepare("SELECT offer_token, status FROM waitlist WHERE id = ?").get(entry.id)) as { offer_token: string; status: string };
    expect(offer.status).toBe("offered");
    const stranger = await adult("Stranger");
    expect(await enrolPeople({ classId: cls.id, name: stranger.name, phone: stranger.phone, userId: stranger.id, people: [null] })).toMatchObject({ ok: false, code: "CLASS_FULL" });
    // The offer names them, and goes to the guardian.
    await notifyPendingOffers();
    const told = (await getDb().prepare("SELECT recipient, body FROM messages WHERE dedupe_key = ?").get(`offer:${offer.offer_token}`)) as { recipient: string; body: string } | undefined;
    expect(told?.recipient).toBe(mum.email);
    expect(told?.body).toContain("for Anis, Basyir");
    // Claimed: both children, each their own enrolment; the guardian is not enrolled.
    const claimed = await claimRoute.POST(req("http://localhost/api/waitlist/claim", "POST", null, { token: offer.offer_token }));
    expect(claimed.status).toBe(200);
    const { bookings } = (await claimed.json()) as { bookings: { id: number; participantName: string }[] };
    expect(bookings.map((x) => x.participantName)).toEqual(["Anis", "Basyir"]);
    for (const x of bookings) expect((await bookingPlaces(x.id)).every((p) => !p.customer)).toBe(true);
    expect((await getClass(cls.id))!.enrolled).toBe(2);
    // The account sees its entries with who they were for.
    expect(await listWaitlistForAccount(mum.id)).toEqual([]);
  });

  it("revalidated at the offer: a guardian who no longer acts for the child gets no offer, and nobody books the guardian instead", async () => {
    const [cls] = await aClass(1, 13);
    const filler = await adult("Filler");
    expect((await enrolPeople({ classId: cls.id, name: filler.name, phone: filler.phone, userId: filler.id, people: [null] })).ok).toBe(true);
    const dad = await adult("Dad");
    const a = await child(dad, "Azri");
    const joined = await joinClassWaitlist({ classId: cls.id, name: dad.name, phone: dad.phone, userId: dad.id, people: { participants: [a], customerTakesPart: false } });
    if (!joined.ok) throw new Error(joined.error);
    const next = await adult("Next");
    const queued = await joinClassWaitlist({ classId: cls.id, name: next.name, phone: next.phone, userId: next.id });
    if (!queued.ok) throw new Error(queued.error);
    const g = (await getDb().prepare("SELECT id FROM participant_guardians WHERE participant_id = ? AND user_id = ?").get(a.id, dad.id)) as { id: number };
    expect(await revokeGuardianship(g.id, { userId: dad.id, name: dad.name }, "Moved away")).toEqual({ ok: true });
    const fillerCode = ((await getDb().prepare("SELECT code FROM bookings WHERE class_id = ?").get(cls.id)) as { code: string }).code;
    expect((await cancelBooking(fillerCode, filler.phone)).ok).toBe(true);
    // The father's entry left the queue; the place went to the next.
    const states = (await getDb().prepare("SELECT id, status FROM waitlist WHERE class_id = ? ORDER BY id").all(cls.id)) as { id: number; status: string }[];
    expect(states).toEqual([
      { id: joined.entry.id, status: "cancelled" },
      { id: queued.entry.id, status: "offered" },
    ]);
    expect((await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE class_id = ? AND phone = ? ").get(cls.id, dad.phone)) as { n: number }).toEqual({ n: 0 });
  });

  it("a time on a shared resource: the entry waits for a place each, the offer holds them all, the claim books them", async () => {
    const date = day(14);
    const crowd = await adult("Crowd");
    const full = await createBookingSeries({ courtId: kayak, date, start: at(9), end: at(10), weeks: 1, name: crowd.name, phone: crowd.phone, userId: crowd.id, players: 4, by: "staff" });
    if (!full.ok) throw new Error(full.error);
    const mum = await adult("Mum");
    const a = await child(mum, "Aqila");
    const b = await child(mum, "Bunga");
    const res = await waitlistRoute.POST(req("http://localhost/api/waitlist", "POST", mum.cookie, { courtId: kayak, date, start: at(9), end: at(10), name: mum.name, phone: mum.phone, participantIds: [a.id, b.id] }));
    expect(res.status).toBe(201);
    const { entry } = (await res.json()) as { entry: { id: number; places: number } };
    expect(entry.places).toBe(2);
    // The crowd goes: the offer holds two places, never one.
    expect((await cancelBooking(full.bookings[0].code, crowd.phone)).ok).toBe(true);
    const offer = (await getDb().prepare("SELECT offer_token, status FROM waitlist WHERE id = ?").get(entry.id)) as { offer_token: string; status: string };
    expect(offer.status).toBe("offered");
    expect(Number(((await getDb().prepare("SELECT places FROM claims WHERE waitlist_id = ? AND active").get(entry.id)) as { places: number }).places)).toBe(2);
    const claimed = await claimWaitlistOffer(offer.offer_token);
    if (!claimed.ok) throw new Error(claimed.error);
    expect(claimed.booking.players).toBe(2);
    expect(await bookingPlaces(claimed.booking.id)).toEqual([
      { customer: false, participantId: a.id, name: "Aqila" },
      { customer: false, participantId: b.id, name: "Bunga" },
    ]);
    expect(await placesHeld(kayak, date)).toBe(2);
  });

  it("eligibility at the offer: a child whose sign-off was withdrawn while waiting is not offered the time", async () => {
    const date = day(15);
    const holder = await adult("Holder");
    await addSignOff({ venueId: venue, sport: "archery", phone: holder.phone, name: holder.name, adminId: manager.id });
    const taken = await createBookingSeries({ courtId: lane, date, start: at(14), end: at(15), weeks: 1, name: holder.name, phone: holder.phone, userId: holder.id, by: "staff" });
    if (!taken.ok) throw new Error(taken.error);
    const mum = await adult("Mum");
    const a = await child(mum, "Ammar");
    const signed = await addSignOff({ venueId: venue, sport: "archery", phone: mum.phone, name: "Ammar", adminId: manager.id, managedPersonId: a.id });
    if (!signed.ok) throw new Error(signed.error);
    const joined = await joinSlotWaitlist({ courtId: lane, date, start: at(14), end: at(15), name: mum.name, phone: mum.phone, userId: mum.id, people: { participants: [a], customerTakesPart: false } });
    if (!joined.ok) throw new Error(joined.error);
    // The mother has no sign-off of her own: she could not have queued for herself.
    expect(
      await joinSlotWaitlist({ courtId: lane, date, start: at(14), end: at(15), name: mum.name, phone: mum.phone, userId: mum.id, people: { participants: [a], customerTakesPart: true } })
    ).toMatchObject({ ok: false, code: "SIGN_OFF_NEEDED" });
    expect(await revokeSignOff(venue, signed.signOff.id, { adminId: manager.id, reason: "Unsafe on the line" })).toBe(true);
    expect((await cancelBooking(taken.bookings[0].code, holder.phone)).ok).toBe(true);
    expect(((await getDb().prepare("SELECT status FROM waitlist WHERE id = ?").get(joined.entry.id)) as { status: string }).status).toBe("waiting");
    expect(await offerSlotPlace(lane, date)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------- the counter

describe("the counter: staff register or choose a child with a guardian, and are on record", () => {
  it("registers a child with the guardian's declaration, books for them, and records who did it", async () => {
    const ph = phone();
    const made = await participantsRoute.POST(
      req("http://localhost/api/admin/participants", "POST", manager.cookie, {
        venueId: venue,
        displayName: "Danish",
        birthYear: 2016,
        guardianName: "Puan Rohana",
        guardianPhone: ph,
        relationship: "parent",
        authority: true,
      })
    );
    expect(made.status).toBe(201);
    const kid = ((await made.json()) as { participant: { id: number } }).participant;
    const res = await book(manager, { courtId: hall, date: day(16), start: at(9), end: at(10), name: "Puan Rohana", phone: ph, participantIds: [kid.id] }, true);
    expect(res.status).toBe(201);
    const { booking } = (await res.json()) as { booking: { id: number; code: string; name: string; participantName: string } };
    expect(booking).toMatchObject({ name: "Puan Rohana", participantName: "Danish" });
    const row = (await getDb().prepare("SELECT added_by_admin_id, added_by_user_id FROM booking_participants WHERE booking_id = ?").get(booking.id)) as {
      added_by_admin_id: number;
      added_by_user_id: number | null;
    };
    expect(row).toEqual({ added_by_admin_id: manager.id, added_by_user_id: null });
    const log = await listActivity([venue], { bookingCode: booking.code });
    expect(log.some((e) => e.action === "booking.for_participant" && e.adminName === "Mira Manager" && (e.detail ?? "").includes("Danish"))).toBe(true);
    expect((await participantHistory(kid.id)).some((e) => e.action === "booking.made" && e.actorName === "Mira Manager" && e.detail?.startsWith("counter:"))).toBe(true);
  });

  it("a number typed in establishes nothing; another venue's child is not reachable", async () => {
    const madeHere = await createAtVenue({
      venueId: venue,
      admin: { id: manager.id, name: manager.name },
      displayName: "Elena",
      guardian: { name: "Encik Faiz", phone: phone(), relationship: "parent", authority: true },
    });
    if (!madeHere.ok) throw new Error(madeHere.error);
    // Booked with somebody else's number: refused.
    const wrong = await book(manager, { courtId: hall, date: day(16), start: at(11), end: at(12), name: "Someone", phone: phone(), participantIds: [madeHere.participant.id] }, true);
    expect(wrong.status).toBe(409);
    expect(((await wrong.json()) as { code: string }).code).toBe("PBK_NOT_GUARDIAN");
    // Another venue's staff cannot reach her at all.
    const elsewhere = await bookingsRoute.POST(
      req("http://localhost/api/bookings", "POST", otherManager.cookie, { courtId: otherCourt, date: day(16), start: at(11), end: at(12), name: "Encik Faiz", phone: "0123", participantIds: [madeHere.participant.id] })
    );
    expect([400, 404]).toContain(elsewhere.status);
    const elsewhere2 = await bookingsRoute.POST(
      req("http://localhost/api/bookings", "POST", otherManager.cookie, { courtId: otherCourt, date: day(16), start: at(11), end: at(12), name: "Encik Faiz", phone: "0123456789", participantIds: [madeHere.participant.id] })
    );
    expect(elsewhere2.status).toBe(404);
  });

  it("a class at the counter: the child enrolled, staff on record", async () => {
    const [cls] = await aClass(4, 17);
    const ph = phone();
    const madeHere = await createAtVenue({
      venueId: venue,
      admin: { id: manager.id, name: manager.name },
      displayName: "Farah",
      guardian: { name: "Puan Gee", phone: ph, relationship: "guardian", authority: true },
    });
    if (!madeHere.ok) throw new Error(madeHere.error);
    const res = await enrolRoute.POST(req("http://localhost/api/classes/enrol", "POST", manager.cookie, { classId: cls.id, name: "Puan Gee", phone: ph, participantIds: [madeHere.participant.id] }));
    expect(res.status).toBe(201);
    const { booking } = (await res.json()) as { booking: { code: string; participantName: string } };
    expect(booking.participantName).toBe("Farah");
    expect((await listActivity([venue], { bookingCode: booking.code })).some((e) => e.action === "class.enrol_participant")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------- the venue's API key

describe("the venue's API key: participants the venue knows, with their guardian, nothing more", () => {
  let key: string;
  const api = (body: Record<string, unknown>, k = key) =>
    apiBookingsRoute.POST(req("http://localhost/api/v1/bookings", "POST", null, body, { authorization: `Bearer ${k}` }));

  beforeAll(async () => {
    const made = await createApiKey(venue, { name: "Front desk system", scope: "write" }, manager.id);
    if (!made.ok) throw new Error(made.error);
    key = made.key;
  });

  it("books for a known child with their guardian's number, and says who takes part", async () => {
    const ph = phone();
    const kid = await createAtVenue({ venueId: venue, admin: { id: manager.id, name: manager.name }, displayName: "Ganesh", guardian: { name: "Mr Hari", phone: ph, relationship: "parent", authority: true } });
    if (!kid.ok) throw new Error(kid.error);
    const res = await api({ courtId: floor, date: day(18), start: at(9), end: at(10), name: "Mr Hari", phone: ph, participantIds: [kid.participant.id] });
    expect(res.status).toBe(201);
    const { booking } = (await res.json()) as { booking: { code: string; players: number; participants: unknown[] } };
    expect(booking.players).toBe(1);
    expect(booking.participants).toEqual([{ participantId: kid.participant.id, name: "Ganesh", customer: false }]);
    const read = await apiBookingRoute.GET(req(`http://localhost/api/v1/bookings/${booking.code}`, "GET", null, undefined, { authorization: `Bearer ${key}` }), {
      params: Promise.resolve({ code: booking.code }),
    });
    expect(((await read.json()) as { booking: { participants: unknown[] } }).booking.participants).toHaveLength(1);
    // Adults booked as before: nobody named, no participants.
    const adultRes = await api({ courtId: floor, date: day(18), start: at(11), end: at(12), name: "Walk In", phone: phone() });
    expect(((await adultRes.json()) as { booking: { participants: unknown[] } }).booking.participants).toEqual([]);
  });

  it("refuses unrelated participants, other venues', a number that is not a guardian's, missing sign-offs and missing waivers", async () => {
    const mum = await adult("Mum");
    const unknownHere = await child(mum, "Hana");
    // Known to nobody at this venue: no booking, application or record here.
    expect((await api({ courtId: floor, date: day(19), start: at(9), end: at(10), name: mum.name, phone: mum.phone, participantIds: [unknownHere.id] })).status).toBe(404);
    // Another venue's.
    const ph = phone();
    const theirs = await createAtVenue({ venueId: otherVenue, admin: { id: otherManager.id, name: otherManager.name }, displayName: "Ilham", guardian: { name: "Puan Jaya", phone: ph, relationship: "parent", authority: true } });
    if (!theirs.ok) throw new Error(theirs.error);
    expect((await api({ courtId: floor, date: day(19), start: at(9), end: at(10), name: "Puan Jaya", phone: ph, participantIds: [theirs.participant.id] })).status).toBe(404);
    // Known here, but the caller names somebody else's number: no impersonating a guardian.
    const ph2 = phone();
    const known = await createAtVenue({ venueId: venue, admin: { id: manager.id, name: manager.name }, displayName: "Kamal", guardian: { name: "Encik Lee", phone: ph2, relationship: "parent", authority: true } });
    if (!known.ok) throw new Error(known.error);
    expect((await api({ courtId: floor, date: day(19), start: at(9), end: at(10), name: "Encik Lee", phone: phone(), participantIds: [known.participant.id] })).status).toBe(409);
    // A safety approval the child does not hold.
    const lanePlay = await api({ courtId: lane, date: day(19), start: at(9), end: at(10), name: "Encik Lee", phone: ph2, participantIds: [known.participant.id] });
    expect(lanePlay.status).toBe(409);
    expect(((await lanePlay.json()) as { code: string }).code).toBe("SIGN_OFF_NEEDED");
    // The guardian's agreement to the waiver must be on record: a key cannot give it.
    expect((await setWaiver(venue, "Climbing, paddling and lifting carry risks; follow the staff's instructions at all times.")).ok).toBe(true);
    try {
      const noWaiver = await api({ courtId: floor, date: day(19), start: at(9), end: at(10), name: "Encik Lee", phone: ph2, participantIds: [known.participant.id] });
      expect(noWaiver.status).toBe(409);
      expect(((await noWaiver.json()) as { code: string }).code).toBe("WAIVER_NEEDED");
    } finally {
      await setWaiver(venue, "");
    }
    // A read key books nothing.
    const readKey = await createApiKey(venue, { name: "Reports", scope: "read" }, manager.id);
    if (!readKey.ok) throw new Error(readKey.error);
    expect((await api({ courtId: floor, date: day(19), start: at(9), end: at(10), name: "Encik Lee", phone: ph2, participantIds: [known.participant.id] }, readKey.key)).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------------------------- at the venue

describe("at the venue: attendance, kit, door codes, money", () => {
  it("attendance per person: who came and who did not; the booking a no-show only when nobody came", async () => {
    const mum = await adult("Mum");
    const a = await child(mum, "Ain");
    const b = await child(mum, "Bob");
    const date = day(20);
    const made = await createBookingSeries({ courtId: floor, date, start: at(9), end: at(10), weeks: 1, name: mum.name, phone: mum.phone, userId: mum.id, participants: [a, b], by: "staff" });
    if (!made.ok) throw new Error(made.error);
    const booking = made.bookings[0];
    const places = (await getDb().prepare("SELECT id FROM booking_participants WHERE booking_id = ? ORDER BY id").all(booking.id)) as { id: number }[];
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${date}T09:20:00+08:00`));
    const staff = { id: manager.id, name: manager.name };
    // Signed in at that moment.
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(manager.id)).token}`;
    const arrived = await checkInRoute.POST(req("http://localhost/api/admin/check-in", "POST", cookie, { code: booking.code, placeId: places[0].id, mark: "arrived" }));
    expect(arrived.status).toBe(200);
    const marked = await markPlace(booking.code, places[1].id, "no_show", staff);
    if (!marked.ok) throw new Error(marked.error);
    expect(marked.places.map((p) => [p.name, !!p.arrivedAt, p.noShow])).toEqual([
      ["Ain", true, false],
      ["Bob", false, true],
    ]);
    expect(marked.booking).toMatchObject({ noShow: false });
    expect(marked.booking.checkedInAt).toBeTruthy();
    // Ain arrived: she cannot be a no-show.
    expect(await markPlace(booking.code, places[0].id, "no_show", staff)).toMatchObject({ ok: false });
    // A place on another booking is not one of these.
    expect(await markPlace(booking.code, 999999, "arrived", staff)).toMatchObject({ ok: false });
    const rows = await listBookingsForDate(date, venue);
    expect(rows.find((r) => r.id === booking.id)!.people.map((p) => [p.name, p.noShow])).toEqual([
      ["Ain", false],
      ["Bob", true],
    ]);
    vi.useRealTimers();

    // Nobody of a second booking came: then the booking is a no-show.
    const made2 = await createBookingSeries({ courtId: floor, date, start: at(11), end: at(12), weeks: 1, name: mum.name, phone: mum.phone, userId: mum.id, participants: [a, b], by: "staff" });
    if (!made2.ok) throw new Error(made2.error);
    const places2 = (await getDb().prepare("SELECT id FROM booking_participants WHERE booking_id = ? ORDER BY id").all(made2.bookings[0].id)) as { id: number }[];
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${date}T11:30:00+08:00`));
    await markPlace(made2.bookings[0].code, places2[0].id, "no_show", staff);
    const both = await markPlace(made2.bookings[0].code, places2[1].id, "no_show", staff);
    expect(both).toMatchObject({ ok: true, booking: { noShow: true } });
    const cleared = await markPlace(made2.bookings[0].code, places2[1].id, "clear", staff);
    expect(cleared).toMatchObject({ ok: true, booking: { noShow: false } });
  });

  it("kit hired for a child: the guardian holds the deposit, the record says who has it", async () => {
    const mum = await adult("Mum");
    const a = await child(mum, "Ahmad");
    const date = day(21);
    const made = await createBookingSeries({ courtId: kayak, date, start: at(9), end: at(10), weeks: 1, name: mum.name, phone: mum.phone, userId: mum.id, participants: [a], by: "staff" });
    if (!made.ok) throw new Error(made.error);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${date}T09:05:00+08:00`));
    const taken = await takeHire(made.bookings[0].code);
    vi.useRealTimers();
    if (!taken.ok) throw new Error(taken.error);
    expect(await hireFor(made.bookings[0].id)).toMatchObject({ name: mum.name, phone: mum.phone, participantName: "Ahmad", deposit: 50 });
  });

  it("door codes per participant, and none once a child's approval is revoked", async () => {
    expect((await updateCourt(hall, { unmanned: true, accessCode: "4444" })).ok).toBe(true);
    const mum = await adult("Mum");
    const a = await child(mum, "Arissa");
    const b = await child(mum, "Bazli");
    const date = day(22);
    const made = await createBookingSeries({ courtId: hall, date, start: at(9), end: at(10), weeks: 1, name: mum.name, phone: mum.phone, userId: mum.id, participants: [a, b], by: "staff" });
    if (!made.ok) throw new Error(made.error);
    const code = made.bookings[0].code;
    await setPaymentStatus(code, true, "cash");
    const door = async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(`${date}T09:15:00+08:00`));
      try {
        return await accessCodeFor(code, mum.phone);
      } finally {
        vi.useRealTimers();
      }
    };
    expect((await recordInduction({ venueId: venue, phone: mum.phone, name: "Arissa", adminId: manager.id, participant: a })).ok).toBe(true);
    expect(await door()).toMatchObject({ ok: false, reason: "no-induction" });
    expect((await recordInduction({ venueId: venue, phone: mum.phone, name: "Bazli", adminId: manager.id, participant: b })).ok).toBe(true);
    expect(await door()).toMatchObject({ ok: true, accessCode: "4444" });

    // An archery booking whose child's approval was revoked opens nothing.
    await updateCourt(lane, { unmanned: true, accessCode: "5555" });
    const signed = await addSignOff({ venueId: venue, sport: "archery", phone: mum.phone, name: "Arissa", adminId: manager.id, managedPersonId: a.id });
    if (!signed.ok) throw new Error(signed.error);
    const onLane = await createBookingSeries({ courtId: lane, date, start: at(9), end: at(10), weeks: 1, name: mum.name, phone: mum.phone, userId: mum.id, participants: [a], by: "customer" });
    if (!onLane.ok) throw new Error(onLane.error);
    await setPaymentStatus(onLane.bookings[0].code, true, "cash");
    expect((await recordInduction({ venueId: venue, phone: mum.phone, name: "x", adminId: manager.id, participant: a })).ok).toBe(false);
    expect(await revokeSignOff(venue, signed.signOff.id, { adminId: manager.id, reason: "Safety concern" })).toBe(true);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${date}T09:15:00+08:00`));
    const laneDoor = await accessCodeFor(onLane.bookings[0].code, mum.phone);
    vi.useRealTimers();
    expect(laneDoor).toMatchObject({ ok: false, reason: "approval-needed" });
  });

  it("cancelling a booking for two children releases both places and refunds the payer", async () => {
    const mum = await adult("Mum");
    const a = await child(mum, "Aryan");
    const b = await child(mum, "Balqis");
    await topUpWallet({ userId: mum.id, amount: 50, adminId: manager.id, venueId: venue });
    const res = await book(mum, { courtId: floor, date: day(23), start: at(9), end: at(10), participantIds: [a.id, b.id], payFromWallet: true });
    expect(res.status).toBe(201);
    const { booking } = (await res.json()) as { booking: { code: string; totalPrice: number; paymentStatus: string } };
    expect(booking).toMatchObject({ totalPrice: 20, paymentStatus: "paid" });
    const before = await getWalletBalance(mum.id, venue);
    expect(await placesHeld(floor, day(23))).toBe(2);
    expect((await cancelBooking(booking.code, mum.phone)).ok).toBe(true);
    expect(await placesHeld(floor, day(23))).toBe(0);
    expect(await getWalletBalance(mum.id, venue)).toBe(before + 20);
  });

  it("a hold while paying, paid in time; one paid too late is owed back and never takes a place another child has", async () => {
    const saved = await savePaymentSettings(venue, { apiKey: "api-key-1234", collectionId: "col123", xSignatureKey: "S-key", sandbox: true, enabled: true });
    if (!saved.ok) throw new Error(saved.error);
    expect((await setHoldPolicy(venue, { on: true, minutes: 10 })).ok).toBe(true);
    let bill = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const id = `pbkbill${++bill}`;
        return Response.json({ id, url: `https://www.billplz-sandbox.com/bills/${id}` });
      })
    );
    try {
      const mum = await adult("Mum");
      const a = await child(mum, "Aidil");
      const res = await book(mum, { courtId: hall2, date: day(24), start: at(9), end: at(10), participantIds: [a.id] });
      const held = (await res.json()) as { holdUntil: string | null; booking: { id: number; code: string } };
      expect(held.holdUntil).not.toBeNull();
      expect((await startBookingPayment({ codes: [held.booking.code], phone: mum.phone })).ok).toBe(true);
      const lastBill = async () => ((await getDb().prepare("SELECT bill_id FROM online_payments ORDER BY id DESC LIMIT 1").get()) as { bill_id: string }).bill_id;
      const first = await lastBill();
      expect((await settleBill({ billId: first, paid: true, paidAt: null }))?.newlyPaid.map((x) => x.id)).toEqual([held.booking.id]);
      // The webhook again: nothing twice.
      expect((await settleBill({ billId: first, paid: true, paidAt: null }))?.newlyPaid).toEqual([]);
      expect(await findBooking(held.booking.code, mum.phone)).toMatchObject({ paymentStatus: "paid", status: "confirmed" });

      // Another child's hold runs out before the money comes.
      const dad = await adult("Dad");
      const c = await child(dad, "Cempaka");
      const late = (await (await book(dad, { courtId: hall2, date: day(24), start: at(11), end: at(12), participantIds: [c.id] })).json()) as { booking: { id: number; code: string } };
      expect((await startBookingPayment({ codes: [late.booking.code], phone: dad.phone })).ok).toBe(true);
      const second = await lastBill();
      await getDb().prepare("UPDATE bookings SET hold_until = datetime('now', '-1 minutes') WHERE id = ?").run(late.booking.id);
      await releaseExpiredHolds();
      // Somebody else's child takes the time meanwhile.
      const third = await adult("Third");
      const d = await child(third, "Dahlia");
      expect((await book(third, { courtId: hall2, date: day(24), start: at(11), end: at(12), participantIds: [d.id] })).status).toBe(201);
      const settled = await settleBill({ billId: second, paid: true, paidAt: null });
      expect(settled?.newlyPaid ?? []).toEqual([]);
      expect(await findBooking(late.booking.code, dad.phone)).toMatchObject({ status: "cancelled" });
      const owed = (await getDb().prepare("SELECT refund_due FROM online_payments WHERE bill_id = ?").get(second)) as { refund_due: number | string };
      expect(Number(owed.refund_due)).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
      await setHoldPolicy(venue, { on: false });
    }
  });
});

// ---------------------------------------------------------------------------------------------- at the same moment

const AT_ONCE = 6;
const together = <T>(fn: (i: number) => Promise<T>) => Promise.all(Array.from({ length: AT_ONCE }, (_, i) => fn(i)));

describe("at the same moment (real concurrency on Postgres)", () => {
  it("guardians taking the last places for different children: never more than there are", async () => {
    const date = day(25);
    const families = await Promise.all(
      Array.from({ length: AT_ONCE }, async (_, i) => {
        const parent = await adult(`Racer${i}`);
        return { parent, kids: [await child(parent, `Kid${i}a`), await child(parent, `Kid${i}b`)] };
      })
    );
    // Six places, six families of two: three get in, whole.
    const results = await together((i) =>
      createBookingSeries({ courtId: floor, date, start: at(9), end: at(10), weeks: 1, name: families[i].parent.name, phone: families[i].parent.phone, userId: families[i].parent.id, participants: families[i].kids, by: "staff" })
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(await placesHeld(floor, date)).toBe(6);

    // A class with two places: six guardians, one child each, at once.
    const [cls] = await aClass(2, 28);
    const enrolled = await together((i) => enrolPeople({ classId: cls.id, name: families[i].parent.name, phone: families[i].parent.phone, userId: families[i].parent.id, people: [families[i].kids[0]] }));
    expect(enrolled.filter((r) => r.ok)).toHaveLength(2);
    expect((await getClass(cls.id))!.enrolled).toBe(2);
  });

  it("a waiting-list offer claimed while others try to book the places it holds", async () => {
    const date = day(26);
    const crowd = await adult("Crowd");
    const full = await createBookingSeries({ courtId: kayak, date, start: at(9), end: at(10), weeks: 1, name: crowd.name, phone: crowd.phone, userId: crowd.id, players: 4, by: "staff" });
    if (!full.ok) throw new Error(full.error);
    const mum = await adult("Mum");
    const kids = [await child(mum, "Wan"), await child(mum, "Wafa")];
    const joined = await joinSlotWaitlist({ courtId: kayak, date, start: at(9), end: at(10), name: mum.name, phone: mum.phone, userId: mum.id, people: { participants: kids, customerTakesPart: false } });
    if (!joined.ok) throw new Error(joined.error);
    // Two of the four places come back: they are offered to the family, held for them.
    const crowdBooking = full.bookings[0];
    await getDb().prepare("UPDATE bookings SET players = 2 WHERE id = ?").run(crowdBooking.id);
    await getDb().prepare("UPDATE claims SET places = 2 WHERE booking_id = ?").run(crowdBooking.id);
    expect(await offerSlotPlace(kayak, date)).not.toBeNull();
    const token = ((await getDb().prepare("SELECT offer_token FROM waitlist WHERE id = ?").get(joined.entry.id)) as { offer_token: string }).offer_token;
    const others = await Promise.all(Array.from({ length: AT_ONCE }, async (_, i) => adult(`Grab${i}`)));
    const [claimed, ...grabs] = await Promise.all([
      claimWaitlistOffer(token),
      ...others.map((o) => createBookingSeries({ courtId: kayak, date, start: at(9), end: at(10), weeks: 1, name: o.name, phone: o.phone, userId: o.id, by: "staff" })),
    ]);
    expect(claimed.ok).toBe(true);
    expect(grabs.filter((g) => g.ok)).toHaveLength(0);
    expect(await placesHeld(kayak, date)).toBe(4);
  });

  it("one group booking against single bookings for the same places", async () => {
    const date = day(27);
    const mum = await adult("Mum");
    const kids = [await child(mum, "Gina"), await child(mum, "Gus"), await child(mum, "Gwen"), await child(mum, "Gary")];
    const singles = await Promise.all(Array.from({ length: AT_ONCE }, async (_, i) => adult(`Single${i}`)));
    const [group, ...rest] = await Promise.all([
      createGroupBooking({
        courtIds: [floor, floor2],
        date,
        start: at(9),
        end: at(10),
        name: mum.name,
        phone: mum.phone,
        userId: mum.id,
        by: "staff",
        assign: { [floor]: { participants: kids.slice(0, 2), customerTakesPart: false }, [floor2]: { participants: kids.slice(2), customerTakesPart: false } },
      }),
      ...singles.map((s) => createBookingSeries({ courtId: floor, date, start: at(9), end: at(10), weeks: 1, name: s.name, phone: s.phone, userId: s.id, by: "staff" })),
    ]);
    const held = await placesHeld(floor, date);
    expect(held).toBeLessThanOrEqual(6);
    const singlesIn = rest.filter((r) => r.ok).length;
    // All or nothing for the group: both its courts, or neither.
    if (group.ok) {
      expect(held).toBe(2 + singlesIn);
      expect(await placesHeld(floor2, date)).toBe(2);
    } else {
      expect(held).toBe(singlesIn);
      expect(await placesHeld(floor2, date)).toBe(0);
    }
  });
});
