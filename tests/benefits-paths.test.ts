import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { createApiKey } from "../src/lib/api-keys";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { setCancelPolicy } from "../src/lib/cancel-policy";
import { saveConcession } from "../src/lib/concessions";
import { getDb } from "../src/lib/db";
import { setDiscountStacking } from "../src/lib/discounts";
import { setHouseRules } from "../src/lib/house-rules";
import { blockPhone, mayBookOn } from "../src/lib/limits";
import { addManaged } from "../src/lib/managed-people";
import { coveredUntil } from "../src/lib/membership-purchases";
import { notifyPendingOffers } from "../src/lib/notify";
import { createAtVenue } from "../src/lib/participants";
import { setLastMinute } from "../src/lib/peak";
import { createResources } from "../src/lib/resources";
import { staffTranslator } from "../src/lib/staff-i18n";
import {
  cancelBooking,
  claimWaitlistOffer,
  createBookingSeries,
  createClassSessions,
  createPromoCode,
  createVenue,
  enrolPeople,
  getBookingById,
  getClass,
  rescheduleBooking,
  sellMembership,
  setPaymentStatus,
} from "../src/lib/store";
import { addDays, slotStartsAt, todayISO } from "../src/lib/time";
import * as adminWaitlist from "../src/app/api/admin/waitlist/route";
import * as apiBookings from "../src/app/api/v1/bookings/route";
import * as apiWaitlist from "../src/app/api/v1/waitlist/route";
import * as bookingsRoute from "../src/app/api/bookings/route";
import * as membershipsRoute from "../src/app/api/admin/memberships/route";
import * as waitlistRoute from "../src/app/api/waitlist/route";

/**
 * Benefits and waiting lists the same on every path (docs/features/pricing.md,
 * docs/features/booking.md#waitlists, docs/architecture/http-api.md):
 *
 * - a membership sold at the counter refuses cover somebody already has, as
 *   buying online does, with the same reason;
 * - the venue's API key books with the discounts the booking form and the
 *   counter give (lib/booking-discounts.ts): the same request, the same price,
 *   place shares, limits and refusals; and it asks of the number what the
 *   counter asks (lib/limits.ts `mayBookOn`);
 * - a last-minute price takes no other discount on any path, and a move keeps
 *   the discounts as given, repricing only the court time;
 * - a waiting-list offer and claim ask what the booking would ask on the path
 *   the entry was made: the house rules, the unpaid-bookings limit and no-show
 *   strikes too, a class place not held to the house rules as an enrolment is
 *   not; and an offer message not yet sent to a number the venue refuses
 *   since is taken out of the outbox.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (k: number) => addDays(todayISO(ZONE), k);
const at = (h: number) => h * 60;
let n = 0;
const phone = () => `0176${String(++n).padStart(6, "0")}`;

type Staff = { id: number; name: string; cookie: string };
type Adult = { id: number; name: string; phone: string; cookie: string };

let together: number; // a venue allowing a concession and a code together
let never: number; // one discount at a time (the default)
let pool: number;
let hall: number;
let dearHall: number;
let neverHall: number;
let strict: number; // house rules and strikes
let strictHall: number;
let strictHall2: number;
let strictFloor: number;
let manager: Staff;
let neverManager: Staff;
let strictManager: Staff;
let key: string;
let neverKey: string;
let strictKey: string;

async function staffMember(venueId: number, name: string, role: "manager" | "desk" = "manager"): Promise<Staff> {
  const made = await createAdmin({ name, email: `${name.toLowerCase().replace(/\W/g, "")}${++n}@bn6.test`, password: "a long enough password", venueId, role });
  if (!made.ok) throw new Error(made.error);
  return { id: made.admin.id, name, cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}` };
}

async function adult(name: string): Promise<Adult> {
  const ph = phone();
  const made = await registerUser({ name: `${name} ${++n}`, email: `bn6${n}@bn6.test`, phone: ph, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now'), verified_phone = phone WHERE id = ?").run(made.user.id);
  return { id: made.user.id, name: made.user.name, phone: ph, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}

async function child(parent: Adult, displayName: string) {
  const made = await addManaged(parent.id, { displayName, relationship: "parent", authority: true }, parent.name);
  if (!made.ok) throw new Error(`${made.code}: ${made.error}`);
  return { id: made.person.id, name: made.person.displayName };
}

const req = (url: string, method: string, cookie: string | null, body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.61.${++n % 250}.${n % 200}`, ...(cookie ? { cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

type Booked = { id: number; code: string; totalPrice: number };
type Answer = { status: number; body: Record<string, unknown> & { booking: Booked; code?: string } };
/** The booking form (no staff session), or the counter (a staff session: the same route). */
const form = async (cookie: string | null, body: Record<string, unknown>): Promise<Answer> => {
  const res = await bookingsRoute.POST(req("http://localhost/api/bookings", "POST", cookie, body));
  return { status: res.status, body: await res.json() };
};
/** The venue's own system, with its write key. */
const api = async (writeKey: string, body: Record<string, unknown>): Promise<Answer> => {
  const res = await apiBookings.POST(req("http://localhost/api/v1/bookings", "POST", null, body, { authorization: `Bearer ${writeKey}` }));
  const data = (await res.json()) as Answer["body"] & { booking: { code: string; totalPrice: number } };
  // The API's booking carries its code, not its id: read the id back for the checks below.
  if (res.status === 201) {
    const row = (await getDb().prepare("SELECT id FROM bookings WHERE code = ?").get(data.booking.code)) as { id: number };
    data.booking = { ...data.booking, id: row.id };
  }
  return { status: res.status, body: data };
};

const shares = async (bookingId: number) =>
  (
    (await getDb()
      .prepare("SELECT place_id, amount::float AS amount FROM promo_place_shares WHERE booking_id = ? AND reversed_at IS NULL ORDER BY place_id")
      .all(bookingId)) as { amount: number }[]
  ).map((r) => r.amount);
const placeConcessions = async (bookingId: number) =>
  ((await getDb().prepare("SELECT amount::float AS amount FROM place_benefits WHERE booking_id = ? AND kind = 'concession' ORDER BY place_id").all(bookingId)) as { amount: number }[]).map(
    (r) => r.amount
  );
const codeTakenOff = async (bookingId: number) =>
  ((await getDb().prepare("SELECT discount::float AS discount FROM promo_uses WHERE booking_id = ?").get(bookingId)) as { discount: number } | undefined)?.discount ?? null;
const checkOf = async (bookingId: number) =>
  ((await getDb().prepare("SELECT concession_check FROM bookings WHERE id = ?").get(bookingId)) as { concession_check: string | null }).concession_check;

async function concession(venueId: number, scope: "booking" | "participant", percent: number) {
  const made = await saveConcession(venueId, { name: `Concession ${++n}`, percent, proof: "their card", scope });
  if (!made.ok) throw new Error(made.error);
  return made.concession;
}

async function promo(venueId: number, adminId: number, over: Partial<Parameters<typeof createPromoCode>[0]> = {}) {
  const made = await createPromoCode({
    venueId,
    code: `BNSIX${++n}`,
    description: "Ten percent off",
    kind: "percent",
    value: 10,
    validFrom: todayISO(),
    validTo: day(60),
    adminId,
    ...over,
  });
  if (!made.ok) throw new Error(made.error);
  return made.promo;
}

beforeAll(async () => {
  const make = async (name: string, ph: string) => {
    const v = await createVenue({ name, area: "Cheras", address: "x", phone: ph, openMin: at(7), closeMin: at(23) });
    if (!v.ok) throw new Error("venue");
    expect((await setHouseRules(v.venue.id, { aheadDays: 45 })).ok).toBe(true);
    return v.venue.id;
  };
  const resource = async (venueId: number, sport: string, name: string, capacity: number, rate: number) => {
    const r = await createResources({ venueId, sport, name, offPeakRate: rate, peakRate: rate, capacity, ...(capacity > 1 ? { maxPlayers: capacity } : {}) });
    if (!r.ok) throw new Error(r.error);
    return r.courts[0].id;
  };
  together = await make("Together Pool", "0312350801");
  never = await make("One At A Time Hall", "0312350802");
  strict = await make("Strict Courts", "0312350803");
  expect((await setDiscountStacking(together, "promotion")).ok).toBe(true);
  pool = await resource(together, "swimming", "Lap pool", 8, 10);
  hall = await resource(together, "badminton", "Hall A", 1, 20);
  dearHall = await resource(together, "badminton", "Hall B", 1, 30);
  neverHall = await resource(never, "badminton", "Only hall", 1, 20);
  strictHall = await resource(strict, "badminton", "Court 1", 1, 20);
  strictHall2 = await resource(strict, "badminton", "Court 2", 1, 20);
  strictFloor = await resource(strict, "gym", "Studio", 4, 15);
  manager = await staffMember(together, "Mira Manager");
  neverManager = await staffMember(never, "Nora Manager");
  strictManager = await staffMember(strict, "Sara Manager");
  const keyFor = async (venueId: number, by: number) => {
    const made = await createApiKey(venueId, { name: "Front desk system", scope: "write" }, by);
    if (!made.ok) throw new Error("key");
    return made.key;
  };
  key = await keyFor(together, manager.id);
  neverKey = await keyFor(never, neverManager.id);
  strictKey = await keyFor(strict, strictManager.id);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------- 1. membership cover at the counter

describe("a membership sold at the counter", () => {
  const sell = (body: Record<string, unknown>, who: Staff = manager) =>
    membershipsRoute.POST(req("http://localhost/api/admin/memberships", "POST", who.cookie, { venueId: together, price: 80, startsOn: todayISO(ZONE), ...body }));

  it("refuses a participant already covered, by a family membership or their own, with the reason buying online gives", async () => {
    const ph = phone();
    const known = async (displayName: string) => {
      const made = await createAtVenue({ venueId: together, admin: { id: manager.id, name: manager.name }, displayName, guardian: { name: "Puan R", phone: ph, relationship: "parent", authority: true } });
      if (!made.ok) throw new Error(made.error);
      return made.participant;
    };
    const [rina, sam] = [await known("Rina"), await known("Sam")];
    // A family membership on the guardian's number, naming Rina, for 60 days.
    const family = await sell({ holderName: "Puan R", holderPhone: ph, expiresOn: day(60), covers: [rina.id] });
    expect(family.status).toBe(201);
    // Rina's own, for any of those days: refused, saying until when, as online.
    const own = await sell({ holderName: "Puan R", holderPhone: ph, expiresOn: day(30), holderParticipantId: rina.id });
    expect(own.status).toBe(400);
    const said = ((await own.json()) as { error: string }).error;
    expect(said).toBe(`Rina is already a member here until ${day(60)}.`);
    expect(await coveredUntil(together, rina.id, todayISO(ZONE), day(30))).toBe(day(60));
    // Staff read it in their own language.
    expect(staffTranslator("ms").err({ error: said })).toBe(`Rina sudah menjadi ahli di sini sehingga ${day(60)}.`);
    // From the day after it ends: sold.
    const after = await sell({ holderName: "Puan R", holderPhone: ph, startsOn: day(61), expiresOn: day(90), holderParticipantId: rina.id });
    expect(after.status).toBe(201);

    // Sam has his own; a family membership naming him for any of those days is refused, naming him.
    expect((await sell({ holderName: "Puan R", holderPhone: ph, expiresOn: day(20), holderParticipantId: sam.id })).status).toBe(201);
    const ph2 = phone();
    const cover = await sellMembership({ venueId: together, holderName: "Encik S", holderPhone: ph2, startsOn: day(10), expiresOn: day(40), price: 50, adminId: manager.id, covers: [sam.id] });
    expect(cover).toMatchObject({ ok: false, error: `Sam is already a member here until ${day(20)}.` });
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM membership_participants WHERE participant_id = ?").get(sam.id)) as { n: number }).n).toBe(0);
  });

  it("two sales naming the same person at once: one is made, the other refused", async () => {
    const ph = phone();
    const made = await createAtVenue({ venueId: together, admin: { id: manager.id, name: manager.name }, displayName: "Tia", guardian: { name: "Puan T", phone: ph, relationship: "parent", authority: true } });
    if (!made.ok) throw new Error(made.error);
    const tia = made.participant;
    const both = await Promise.all([
      sellMembership({ venueId: together, holderName: "Puan T", holderPhone: ph, startsOn: todayISO(ZONE), expiresOn: day(30), price: 50, adminId: manager.id, holderParticipantId: tia.id }),
      sellMembership({ venueId: together, holderName: "Encik T", holderPhone: phone(), startsOn: todayISO(ZONE), expiresOn: day(30), price: 50, adminId: manager.id, covers: [tia.id] }),
    ]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    const refused = both.find((r) => !r.ok);
    expect(refused && !refused.ok && refused.error).toMatch(/^(Tia is already a member here until|Tia already has a membership until)/);
  });
});

// ---------------------------------------------------------------------------------------------- 2. the API's discounts

describe("the venue's API key books with the discounts the form and the counter give", () => {
  it("a person's concession on their place and a code, on a booking priced by the place: the same price and shares on each path", async () => {
    const mum = await adult("Mum");
    const kids = [await child(mum, "Aina"), await child(mum, "Badri"), await child(mum, "Chen")];
    const childPrice = await concession(together, "participant", 50);
    const code = await promo(together, manager.id, { combinable: true });
    const ask = (start: number) => ({
      courtId: pool,
      date: day(4),
      start: at(start),
      end: at(start + 1),
      name: mum.name,
      phone: mum.phone,
      participantIds: kids.map((k) => k.id),
      placeConcessions: [{ participantId: kids[2].id, concessionId: childPrice.id }],
      promoCode: code.code,
    });
    const online = await form(mum.cookie, ask(9));
    const counter = await form(manager.cookie, ask(11));
    const viaApi = await api(key, ask(13));
    for (const made of [online, counter, viaApi]) {
      expect(made.status).toBe(201);
      // RM30 less RM5 for Chen is RM25; 10% of that is RM2.50, shared RM1, RM1 and RM0.50: RM22.50.
      expect(made.body.booking.totalPrice).toBe(22.5);
      expect(made.body).toMatchObject({ discount: 2.5, promoError: null, promoErrorCode: null, concessionError: null });
      expect(await codeTakenOff(made.body.booking.id)).toBe(2.5);
      expect(await shares(made.body.booking.id)).toEqual([1, 1, 0.5]);
      expect(await placeConcessions(made.body.booking.id)).toEqual([5]);
      expect((await getBookingById(made.body.booking.id))!.totalPrice).toBe(22.5);
    }
  });

  it("a booking's concession and a fixed-amount code on a court hired whole, the concession taken on the venue's word as the counter takes it", async () => {
    const student = await concession(together, "booking", 20);
    const code = await promo(together, manager.id, { combinable: true, kind: "amount", value: 5 });
    const ph = phone();
    const ask = (start: number) => ({ courtId: hall, date: day(5), start: at(start), end: at(start + 1), name: "Pelajar", phone: ph, concessionId: student.id, promoCode: code.code });
    const results = [await form(null, ask(8)), await form(manager.cookie, ask(10)), await api(key, ask(12))];
    for (const made of results) {
      expect(made.status).toBe(201);
      // RM20 less 20% is RM16; RM5 off that: RM11.
      expect(made.body.booking.totalPrice).toBe(11);
      expect(made.body.discount).toBe(5);
      // Proof is looked at when they arrive, whichever path booked it.
      expect(await checkOf(made.body.booking.id)).toBe("due");
    }
  });

  it("refuses a second discount the same way on each path, the booking standing at the first", async () => {
    const student = await concession(never, "booking", 20);
    const code = await promo(never, neverManager.id, { combinable: true });
    const ph = phone();
    const ask = (start: number) => ({ courtId: neverHall, date: day(6), start: at(start), end: at(start + 1), name: "Satu", phone: ph, concessionId: student.id, promoCode: code.code });
    for (const made of [await form(null, ask(8)), await form(neverManager.cookie, ask(10)), await api(neverKey, ask(12))]) {
      expect(made.status).toBe(201);
      expect(made.body.booking.totalPrice).toBe(16);
      expect(made.body).toMatchObject({ promoErrorCode: "ONE_DISCOUNT", discount: 0, concessionError: null });
      expect(await codeTakenOff(made.body.booking.id)).toBeNull();
    }
  });

  it("a code's limits count every path's uses: its last use, and one customer's", async () => {
    const limited = await promo(together, manager.id, { maxUses: 2 });
    const ask = (ph: string, start: number) => ({ courtId: hall, date: day(7), start: at(start), end: at(start + 1), name: "Kod", phone: ph, promoCode: limited.code });
    expect((await form(null, ask(phone(), 8))).body.discount).toBe(2);
    expect((await api(key, ask(phone(), 10))).body.discount).toBe(2);
    const third = await form(manager.cookie, ask(phone(), 12));
    expect(third.status).toBe(201);
    expect(third.body).toMatchObject({ promoError: "This code has been fully claimed.", discount: 0 });
    expect(third.body.booking.totalPrice).toBe(20);

    const once = await promo(together, manager.id, { maxPerCustomer: 1 });
    const ph = phone();
    const first = await form(null, { ...ask(ph, 14), promoCode: once.code });
    expect(first.body.discount).toBe(2);
    const again = await api(key, { ...ask(ph, 16), promoCode: once.code });
    expect(again.body).toMatchObject({ promoErrorCode: "PROMO_YOUR_LIMIT", discount: 0 });
  });

  it("checks what it is sent: a concession, a list of places' concessions, a code", async () => {
    const base = { courtId: hall, date: day(8), start: at(9), end: at(10), name: "Bad Body", phone: phone() };
    expect((await api(key, { ...base, concessionId: "student" })).status).toBe(400);
    expect((await api(key, { ...base, placeConcessions: [{ concessionId: 0 }] })).status).toBe(400);
    expect((await api(key, { ...base, promoCode: 10 })).status).toBe(400);
    // A concession of another venue's: the booking stands at the full price, saying why.
    const elsewhere = await concession(never, "booking", 20);
    const made = await api(key, { ...base, concessionId: elsewhere.id });
    expect(made.status).toBe(201);
    expect(made.body.booking.totalPrice).toBe(20);
    expect((made.body.concessionError as { code: string }).code).toBe("CONCESSION_NOT_HERE");
  });
});

// ---------------------------------------------------------------------------------------------- 2b. the API asks what the counter asks

describe("the venue's API key asks of the number what the counter asks", () => {
  it("a number the venue refuses, and too many unpaid bookings, are refused as at the counter", async () => {
    const ph = phone();
    await blockPhone({ venueId: strict, phone: ph, reason: "Abusive", adminId: strictManager.id });
    const body = { courtId: strictHall, date: day(9), start: at(9), end: at(10), name: "Refused", phone: ph };
    const viaApi = await api(strictKey, body);
    expect(viaApi.status).toBe(409);
    expect(viaApi.body.code).toBe("PHONE_BLOCKED");
    const atCounter = await form(strictManager.cookie, body);
    expect(atCounter.body.code).toBe("PHONE_BLOCKED");

    const busy = phone();
    for (const h of [8, 9, 10]) expect((await api(strictKey, { ...body, start: at(h), end: at(h + 1), phone: busy, date: day(10) })).status).toBe(201);
    const fourth = await api(strictKey, { ...body, start: at(11), end: at(12), phone: busy, date: day(10) });
    expect(fourth.status).toBe(409);
    expect(fourth.body.code).toBe("PHONE_LIMIT_VENUE");
    expect(await mayBookOn("staff", { venueId: strict, phone: busy, dates: [day(10)] })).toMatchObject({ code: "PHONE_LIMIT_VENUE" });
  });
});

// ---------------------------------------------------------------------------------------------- 3. last-minute prices and moves

describe("a last-minute price and a move", () => {
  it("a last-minute price takes no concession and no code, on the form, the counter or the API", async () => {
    const tomorrow = day(1);
    expect((await setLastMinute(never, { hours: 24, percent: 50, offPeakOnly: false })).ok).toBe(true);
    try {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(slotStartsAt(tomorrow, 18, ZONE).getTime() - 2 * 3_600_000);
      const student = await concession(never, "booking", 20);
      const code = await promo(never, neverManager.id);
      const ph = phone();
      const ask = (start: number, extra: Record<string, unknown>) => ({ courtId: neverHall, date: tomorrow, start: at(start), end: at(start + 1), name: "Late", phone: ph, ...extra });
      for (const [i, send] of [(b: Record<string, unknown>) => form(null, b), (b: Record<string, unknown>) => form(neverManager.cookie, b), (b: Record<string, unknown>) => api(neverKey, b)].entries()) {
        const withCode = await send(ask(18 + i, { promoCode: code.code }));
        expect(withCode.status).toBe(201);
        // Half of RM20, and no code on top.
        expect(withCode.body.booking.totalPrice).toBe(10);
        expect(withCode.body.promoErrorCode).toBe("PROMO_NOT_LAST_MINUTE");
      }
      const withConcession = await api(neverKey, ask(21, { concessionId: student.id, phone: phone() }));
      expect(withConcession.body.booking.totalPrice).toBe(10);
      expect((withConcession.body.concessionError as { code: string }).code).toBe("ONE_DISCOUNT");
    } finally {
      vi.useRealTimers();
      await setLastMinute(never, { off: true });
    }
  });

  it("a move keeps the discounts as given and changes the price by the court time's difference only", async () => {
    const student = await concession(together, "booking", 20);
    const code = await promo(together, manager.id, { combinable: true, kind: "amount", value: 2 });
    const made = await api(key, { courtId: hall, date: day(12), start: at(9), end: at(10), name: "Mover", phone: phone(), concessionId: student.id, promoCode: code.code });
    // RM20 less RM4 is RM16, less RM2: RM14.
    expect(made.body.booking.totalPrice).toBe(14);
    // To a dearer hall (RM30): RM10 more; the concession stays RM4 and the code RM2, as given.
    const moved = await rescheduleBooking(made.body.booking.code, { date: day(12), start: at(15), courtId: dearHall }, "staff");
    expect(moved).toMatchObject({ ok: true, priceChange: 10 });
    const after = (await getBookingById(made.body.booking.id))!;
    expect(after.totalPrice).toBe(24);
    expect(after.concessionOff).toBe(4);
    expect(await codeTakenOff(after.id)).toBe(2);
    // Paid, moved back by staff to the cheaper hall: what was charged stands, nothing recalculated.
    expect((await setPaymentStatus(after.code, true, "cash")).ok).toBe(true);
    const back = await rescheduleBooking(after.code, { date: day(12), start: at(17), courtId: hall }, "staff");
    expect(back).toMatchObject({ ok: true, priceChange: 0, unchargedDifference: -10 });
    expect((await getBookingById(after.id))!.totalPrice).toBe(24);
  });
});

// ---------------------------------------------------------------------------------------------- 4. waiting-list claims

const state = async (id: number) => (await getDb().prepare("SELECT status, offer_token FROM waitlist WHERE id = ?").get(id)) as { status: string; offer_token: string | null };
const holds = async (id: number) => ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM claims WHERE waitlist_id = ? AND active").get(id)) as { n: number }).n;

async function take(courtId: number, date: string, start: number) {
  const made = await createBookingSeries({ courtId, date, start, end: start + 60, weeks: 1, name: "Taken By", phone: phone(), by: "staff" });
  if (!made.ok) throw new Error(made.error);
  return made.bookings[0];
}
/** Another booking of this number's here, made elsewhere since it joined. */
async function bookAlso(ph: string, date: string, start: number, courtId = strictHall2) {
  const made = await createBookingSeries({ courtId, date, start, end: start + 60, weeks: 1, name: "Also", phone: ph, by: "staff" });
  if (!made.ok) throw new Error(made.error);
  return made.bookings[0];
}
const joinOnline = async (body: Record<string, unknown>) => {
  const res = await waitlistRoute.POST(req("http://localhost/api/waitlist", "POST", null, body));
  return { status: res.status, body: (await res.json()) as { entry: { id: number }; code?: string } };
};
const joinCounter = async (body: Record<string, unknown>) => {
  const res = await adminWaitlist.POST(req("http://localhost/api/admin/waitlist", "POST", strictManager.cookie, { venueId: strict, ...body }));
  return { status: res.status, body: (await res.json()) as { entry: { id: number }; code?: string } };
};
const joinApi = async (body: Record<string, unknown>) => {
  const res = await apiWaitlist.POST(req("http://localhost/api/v1/waitlist", "POST", null, body, { authorization: `Bearer ${strictKey}` }));
  return { status: res.status, body: (await res.json()) as { entry: { id: number }; code?: string } };
};

describe("a waiting-list offer and claim ask what the booking would ask on its path", () => {
  it("the house rules, online: passed over at the offer and keeping its place; refused at the claim and back to waiting", async () => {
    expect((await setHouseRules(strict, { aheadDays: 45, upcoming: 1 })).ok).toBe(true);
    try {
      const date = day(14);
      const taken = await take(strictHall, date, at(18));
      const [a, b] = [phone(), phone()];
      const first = await joinOnline({ courtId: strictHall, date, start: at(18), end: at(19), name: "Online Aida", phone: a });
      const second = await joinOnline({ courtId: strictHall, date, start: at(18), end: at(19), name: "Online Bala", phone: b });
      expect([first.status, second.status]).toEqual([201, 201]);
      // Aida books elsewhere meanwhile: at her one booking coming up, she could not book this one.
      await bookAlso(a, day(15), at(9));
      expect((await cancelBooking(taken.code, taken.phone)).ok).toBe(true);
      expect((await state(first.body.entry.id)).status).toBe("waiting");
      const offer = await state(second.body.entry.id);
      expect(offer.status).toBe("offered");
      // Bala books elsewhere too, before claiming: refused, as the booking would be; nothing booked, back to waiting.
      await bookAlso(b, day(15), at(11));
      const claimed = await claimWaitlistOffer(offer.offer_token!);
      expect(claimed).toMatchObject({ ok: false, code: "LIMIT_UPCOMING" });
      expect((await state(second.body.entry.id)).status).toBe("waiting");
      expect(await holds(second.body.entry.id)).toBe(0);
      expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE court_id = ? AND date = ? AND status = 'confirmed'").get(strictHall, date)) as { n: number }).n).toBe(0);
    } finally {
      await setHouseRules(strict, { aheadDays: 45 });
    }
  });

  it("the house rules at the counter and through the API, as their bookings are asked them", async () => {
    expect((await setHouseRules(strict, { aheadDays: 45, perDay: 1 })).ok).toBe(true);
    try {
      const date = day(16);
      const taken = await take(strictHall, date, at(10));
      const [c, d] = [phone(), phone()];
      const byCounter = await joinCounter({ courtId: strictHall, date, start: at(10), end: at(11), name: "Counter Cik", phone: c });
      const byApi = await joinApi({ courtId: strictHall, date, start: at(10), end: at(11), name: "System Dan", phone: d });
      expect([byCounter.status, byApi.status]).toEqual([201, 201]);
      await bookAlso(c, date, at(14));
      expect((await cancelBooking(taken.code, taken.phone)).ok).toBe(true);
      expect((await state(byCounter.body.entry.id)).status).toBe("waiting");
      const offer = await state(byApi.body.entry.id);
      expect(offer.status).toBe("offered");
      await bookAlso(d, date, at(16));
      expect(await claimWaitlistOffer(offer.offer_token!)).toMatchObject({ ok: false, code: "LIMIT_DAY" });
      expect((await state(byApi.body.entry.id)).status).toBe("waiting");
    } finally {
      await setHouseRules(strict, { aheadDays: 45 });
    }
  });

  it("a class place is not held to the house rules, as an enrolment is not", async () => {
    expect((await setHouseRules(strict, { aheadDays: 45, upcoming: 1 })).ok).toBe(true);
    try {
      const date = day(17);
      const made = await createClassSessions({ courtId: strictFloor, name: "Circuit", instructor: "Coach", date, start: at(9), end: at(10), capacity: 1, price: 12 });
      if (!made.ok) throw new Error(made.error);
      const cls = made.classes[0];
      const filler = phone();
      const filled = await enrolPeople({ classId: cls.id, name: "Filler", phone: filler, people: [null] });
      if (!filled.ok) throw new Error(filled.error);
      const ph = phone();
      const joined = await joinOnline({ classId: cls.id, name: "Class Cara", phone: ph });
      expect(joined.status).toBe(201);
      await bookAlso(ph, day(18), at(9));
      expect((await cancelBooking(filled.bookings[0].code, filler)).ok).toBe(true);
      const offer = await state(joined.body.entry.id);
      expect(offer.status).toBe("offered");
      expect((await claimWaitlistOffer(offer.offer_token!)).ok).toBe(true);
      expect((await getClass(cls.id))!.enrolled).toBe(1);
    } finally {
      await setHouseRules(strict, { aheadDays: 45 });
    }
  });

  it("the unpaid-bookings limit, whoever made the entry", async () => {
    const date = day(19);
    const taken = await take(strictHall, date, at(12));
    const ph = phone();
    const joined = await joinCounter({ courtId: strictHall, date, start: at(12), end: at(13), name: "Unpaid Usha", phone: ph });
    expect(joined.status).toBe(201);
    for (const h of [8, 9, 10]) await bookAlso(ph, day(20), at(h));
    expect((await cancelBooking(taken.code, taken.phone)).ok).toBe(true);
    // Passed over at the offer (nobody else waits): it keeps its place.
    expect((await state(joined.body.entry.id)).status).toBe("waiting");
    expect(await holds(joined.body.entry.id)).toBe(0);
  });

  it("no-show strikes where the venue takes nothing online", async () => {
    expect((await setCancelPolicy(strict, { strikeLimit: 1 })).ok).toBe(true);
    try {
      const date = day(21);
      const taken = await take(strictHall, date, at(14));
      const ph = phone();
      const joined = await joinOnline({ courtId: strictHall, date, start: at(14), end: at(15), name: "Struck Siva", phone: ph });
      expect(joined.status).toBe(201);
      expect((await cancelBooking(taken.code, taken.phone)).ok).toBe(true);
      const offer = await state(joined.body.entry.id);
      expect(offer.status).toBe("offered");
      // A no-show marked against the number before the claim.
      const missed = await bookAlso(ph, day(25), at(9), strictHall2);
      await getDb().prepare("UPDATE bookings SET no_show = 1 WHERE id = ?").run(missed.id);
      expect(await claimWaitlistOffer(offer.offer_token!)).toMatchObject({ ok: false, code: "STRIKES_COUNTER" });
      expect((await state(joined.body.entry.id)).status).toBe("waiting");
    } finally {
      await setCancelPolicy(strict, { strikeLimit: null });
    }
  });
});

describe("an offer message to a number the venue refuses since", () => {
  const messagesFor = async (token: string) =>
    (await getDb().prepare("SELECT status, last_error FROM messages WHERE dedupe_key = ? OR dedupe_key LIKE ?").all(`offer:${token}`, `offer:${token}:%`)) as {
      status: string;
      last_error: string | null;
    }[];

  it("is taken out of the outbox while unsent, and the claim is still refused", async () => {
    const date = day(22);
    const taken = await take(strictHall, date, at(19));
    const ph = phone();
    const joined = await joinCounter({ courtId: strictHall, date, start: at(19), end: at(20), name: "Encik Lim", phone: ph, email: "lim@bn6.test" });
    expect(joined.status).toBe(201);
    expect((await cancelBooking(taken.code, taken.phone)).ok).toBe(true);
    const offer = await state(joined.body.entry.id);
    expect(offer.status).toBe("offered");
    await notifyPendingOffers();
    expect((await messagesFor(offer.offer_token!)).map((m) => m.status)).toContain("queued");
    await blockPhone({ venueId: strict, phone: ph, reason: "Abusive", adminId: strictManager.id });
    const after = await messagesFor(offer.offer_token!);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((m) => m.status === "abandoned" && /refused this number/.test(m.last_error ?? ""))).toBe(true);
    expect(await claimWaitlistOffer(offer.offer_token!)).toMatchObject({ ok: false, code: "PHONE_BLOCKED" });
  });

  it("is never written when the number was refused before the outbox looked; one already sent stays as it was", async () => {
    const date = day(23);
    const taken = await take(strictHall2, date, at(19));
    const ph = phone();
    const joined = await joinCounter({ courtId: strictHall2, date, start: at(19), end: at(20), name: "Encik Wong", phone: ph, email: "wong@bn6.test" });
    expect((await cancelBooking(taken.code, taken.phone)).ok).toBe(true);
    const offer = await state(joined.body.entry.id);
    await blockPhone({ venueId: strict, phone: ph, reason: "Abusive", adminId: strictManager.id });
    await notifyPendingOffers();
    expect(await messagesFor(offer.offer_token!)).toEqual([]);

    // Somebody else's offer, its message sent before their number was refused: left as sent.
    const again = await take(strictHall, date, at(8));
    const other = phone();
    const theirs = await joinCounter({ courtId: strictHall, date, start: at(8), end: at(9), name: "Puan Siti", phone: other, email: "siti@bn6.test" });
    expect(theirs.status).toBe(201);
    expect((await cancelBooking(again.code, again.phone)).ok).toBe(true);
    const sentOffer = await state(theirs.body.entry.id);
    await notifyPendingOffers();
    await getDb().prepare("UPDATE messages SET status = 'sent' WHERE dedupe_key = ?").run(`offer:${sentOffer.offer_token}`);
    await blockPhone({ venueId: strict, phone: other, reason: "Abusive", adminId: strictManager.id });
    expect((await messagesFor(sentOffer.offer_token!)).map((m) => m.status)).toContain("sent");
  });
});
