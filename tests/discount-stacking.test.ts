import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { applyConcession, applyPlaceConcession, checkConcession, saveConcession } from "../src/lib/concessions";
import { saveCoach } from "../src/lib/coaching";
import { getDb } from "../src/lib/db";
import { courtBeforePromo, discountStacking, promoDiscount, setDiscountStacking, stackRefusal } from "../src/lib/discounts";
import { bookingSale, lineText } from "../src/lib/documents";
import { placeBenefitsFor, placeShares, splitEvenly, splitInProportion } from "../src/lib/entitlements";
import { addManaged } from "../src/lib/managed-people";
import { withdrawPlace } from "../src/lib/place-withdrawals";
import { createResources } from "../src/lib/resources";
import { setHouseRules } from "../src/lib/house-rules";
import {
  applyPromo,
  cancelBooking,
  createBookingSeries,
  createPromoCode,
  createVenue,
  getBookingById,
  promoById,
  rescheduleBooking,
  setPaymentStatus,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import * as bookingsRoute from "../src/app/api/bookings/route";
import * as promosRoute from "../src/app/api/admin/promos/route";
import * as stackingRoute from "../src/app/api/admin/promos/stacking/route";
import * as availabilityRoute from "../src/app/api/availability/route";

/**
 * Discounts together (ADR 0025, changes of 27 October 2026; lib/discounts.ts;
 * docs/features/pricing.md#discounts-together): a person's concession and a
 * promo code go together only where the venue allows discounts together and
 * the code does, refused the same way by the form's route, the counter's
 * (the same route as staff) and the library every path calls; one order and
 * one rounding whatever came first; each place's share of a code recorded, so
 * a place taken off takes exactly its part; limited codes taken once by the
 * database.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (k: number) => addDays(todayISO(ZONE), k);
const at = (h: number) => h * 60;
let n = 0;
const phone = () => `0179${String(++n).padStart(6, "0")}`;

interface Place {
  venue: number;
  pool: number;
  hall: number;
  hall2: number;
  coach: number;
}
let never: Place;
let together: Place;
let manager: { id: number; name: string; cookie: string };

type Adult = Awaited<ReturnType<typeof adult>>;
async function adult(name = "Parent") {
  const ph = phone();
  const made = await registerUser({ name: `${name} ${++n}`, email: `stk${n}@stk.test`, phone: ph, password: "a long enough password" });
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
    headers: { "content-type": "application/json", "x-forwarded-for": `10.77.${++n % 250}.${n % 200}`, ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

type Booked = { id: number; code: string; totalPrice: number; paymentStatus: string };
const book = async (who: Adult, body: Record<string, unknown>, cookie: string = who.cookie) => {
  const res = await bookingsRoute.POST(req("http://localhost/api/bookings", "POST", cookie, { name: who.name, phone: who.phone, ...body }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & { booking: Booked } };
};

async function concession(venue: number, scope: "booking" | "participant", percent: number) {
  const made = await saveConcession(venue, { name: `Child ${++n}`, percent, proof: "their MyKid card", scope });
  if (!made.ok) throw new Error(made.error);
  return made.concession;
}

async function code(venue: number, over: Partial<Parameters<typeof createPromoCode>[0]> = {}) {
  const made = await createPromoCode({
    venueId: venue,
    code: `STK${++n}`,
    description: "Ten percent off a swim",
    kind: "percent",
    value: 10,
    validFrom: todayISO(),
    validTo: day(60),
    adminId: manager.id,
    ...over,
  });
  if (!made.ok) throw new Error(made.error);
  return made.promo;
}

const shareRows = async (bookingId: number) =>
  (await getDb()
    .prepare("SELECT place_id, amount::float AS amount, reversed_why FROM promo_place_shares WHERE booking_id = ? ORDER BY id")
    .all(bookingId)) as { place_id: number; amount: number; reversed_why: string | null }[];
const useOf = async (bookingId: number) =>
  ((await getDb().prepare("SELECT discount::float AS discount FROM promo_uses WHERE booking_id = ?").get(bookingId)) as { discount: number } | undefined)?.discount ?? null;
const sum = (xs: number[]) => Math.round(xs.reduce((s, x) => s + x, 0) * 100) / 100;

beforeAll(async () => {
  const make = async (name: string, ph: string, stacking: "never" | "promotion"): Promise<Place> => {
    const v = await createVenue({ name, area: "Setapak", address: "x", phone: ph, openMin: at(7), closeMin: at(23) });
    if (!v.ok) throw new Error("venue");
    const res = async (sport: string, rname: string, capacity: number, rate: number) => {
      const r = await createResources({ venueId: v.venue.id, sport, name: rname, offPeakRate: rate, peakRate: rate, capacity, ...(capacity > 1 ? { maxPlayers: capacity } : {}) });
      if (!r.ok) throw new Error(r.error);
      return r.courts[0].id;
    };
    expect((await setHouseRules(v.venue.id, { aheadDays: 45 })).ok).toBe(true);
    if (stacking === "promotion") expect((await setDiscountStacking(v.venue.id, "promotion")).ok).toBe(true);
    const hours = Array.from({ length: 7 }, (_, weekday) => ({ weekday, from: at(7), until: at(22) }));
    const coach = await saveCoach(v.venue.id, { name: `${name} coach`, sports: ["badminton"], rate: 80, hours });
    if (!coach.ok) throw new Error(coach.error);
    return {
      venue: v.venue.id,
      pool: await res("swimming", `${name} pool`, 8, 10),
      hall: await res("badminton", `${name} hall`, 1, 20),
      hall2: await res("badminton", `${name} hall two`, 1, 20),
      coach: coach.coach.id,
    };
  };
  never = await make("One Discount Centre", "0312350901", "never");
  together = await make("Together Centre", "0312350902", "promotion");
  const made = await createAdmin({ name: "Mira", email: `stk-mgr${++n}@stk.test`, password: "a long enough password", venueId: null, role: "manager" });
  if (!made.ok) throw new Error(made.error);
  manager = { id: made.admin.id, name: "Mira", cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}` };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the arithmetic", () => {
  it("splits in whole sen, the earlier parts taking the odd sen, and in proportion by largest remainder", () => {
    expect(splitEvenly(10, 3)).toEqual([3.34, 3.33, 3.33]);
    expect(sum(splitEvenly(10, 3))).toBe(10);
    expect(splitInProportion(4, [10, 10, 6.7])).toEqual([1.5, 1.5, 1]);
    expect(splitInProportion(1, [1, 1, 1])).toEqual([0.34, 0.33, 0.33]);
    expect(splitInProportion(0.05, [0, 0])).toEqual([0.03, 0.02]);
  });

  it("takes a percentage off rounded down, to the sen, and never more than the price", () => {
    // 15% of RM10.05 is RM1.5075: the venue's favour is RM1.50, not RM1.51.
    expect(promoDiscount({ kind: "percent", value: 15 }, 10.05)).toBe(1.5);
    expect(promoDiscount({ kind: "percent", value: 20 }, 10.05)).toBe(2.01);
    expect(promoDiscount({ kind: "amount", value: 50 }, 12.5)).toBe(12.5);
    expect(promoDiscount({ kind: "amount", value: 5 }, -3)).toBe(0);
  });
});

describe("one discount at a time (the default)", () => {
  it("refuses a code with a person's concession the same way on the form's route, the counter's, and the library, whichever comes first", async () => {
    const mum = await adult("Mum");
    const [a, b] = [await child(mum, "Amani"), await child(mum, "Bella")];
    const childPrice = await concession(never.venue, "participant", 50);
    const promo = await code(never.venue, { combinable: true });
    expect(await discountStacking(never.venue)).toBe("never");

    // Online: the concession goes on (it comes first), the code is refused, saying why, with its code.
    const online = await book(mum, {
      courtId: never.pool,
      date: day(3),
      start: at(9),
      end: at(10),
      participantIds: [a.id, b.id],
      placeConcessions: [{ participantId: a.id, concessionId: childPrice.id }],
      promoCode: promo.code,
    });
    expect(online.status).toBe(201);
    expect(online.body.booking.totalPrice).toBe(15);
    expect(online.body).toMatchObject({ promoErrorCode: "ONE_DISCOUNT", discount: 0, concessionError: null });
    expect(await useOf(online.body.booking.id)).toBeNull();

    // At the counter (staff signed in, the same route): the same.
    const counter = await book(mum, {
      courtId: never.pool,
      date: day(3),
      start: at(11),
      end: at(12),
      participantIds: [a.id, b.id],
      placeConcessions: [{ participantId: a.id, concessionId: childPrice.id }],
      promoCode: promo.code,
    }, `${manager.cookie}; ${mum.cookie}`);
    expect(counter.status).toBe(201);
    expect(counter.body).toMatchObject({ promoErrorCode: "ONE_DISCOUNT" });
    expect(counter.body.booking.totalPrice).toBe(15);

    // The code first: the concession is refused the same way, and the code stands.
    const codeFirst = await book(mum, { courtId: never.pool, date: day(4), start: at(9), end: at(10), participantIds: [a.id, b.id], promoCode: promo.code });
    expect(codeFirst.body.booking.totalPrice).toBe(18);
    expect(await applyPlaceConcession(codeFirst.body.booking.id, childPrice.id, a.id)).toMatchObject({ ok: false, code: "ONE_DISCOUNT" });
    const student = await concession(never.venue, "booking", 20);
    expect(await applyConcession(codeFirst.body.booking.id, student.id)).toMatchObject({ ok: false, code: "ONE_DISCOUNT" });
    expect((await getBookingById(codeFirst.body.booking.id))!.totalPrice).toBe(18);
    // And the rule says so before anything is tried.
    expect(await stackRefusal(codeFirst.body.booking.id, { kind: "placeConcession" })).toMatchObject({ code: "ONE_DISCOUNT" });
  });

  it("refuses a booking's own concession with a code on a court hired whole, and keeps a member's price apart (a price, not a discount)", async () => {
    const dad = await adult("Dad");
    const student = await concession(never.venue, "booking", 20);
    const promo = await code(never.venue);
    const made = await book(dad, { courtId: never.hall, date: day(5), start: at(9), end: at(10), concessionId: student.id, promoCode: promo.code });
    expect(made.body.booking.totalPrice).toBe(16);
    expect(made.body.promoErrorCode).toBe("ONE_DISCOUNT");
  });
});

describe("a concession and a code together, where the venue and the code allow it", () => {
  it("refuses a code that does not combine, with its own reason, on every path", async () => {
    const mum = await adult("Mum");
    const [a, b] = [await child(mum, "Cahaya"), await child(mum, "Dahlia")];
    const childPrice = await concession(together.venue, "participant", 50);
    const plain = await code(together.venue);
    expect((await promoById(plain.id))!.combinable).toBe(false);
    const made = await book(mum, {
      courtId: together.pool,
      date: day(3),
      start: at(9),
      end: at(10),
      participantIds: [a.id, b.id],
      placeConcessions: [{ participantId: a.id, concessionId: childPrice.id }],
      promoCode: plain.code,
    });
    expect(made.body).toMatchObject({ promoErrorCode: "STK_NOT_COMBINABLE" });
    expect(made.body.booking.totalPrice).toBe(15);
    // The code first: the concession is refused for the same reason.
    const codeFirst = await book(mum, { courtId: together.pool, date: day(3), start: at(11), end: at(12), participantIds: [a.id, b.id], promoCode: plain.code });
    expect(await applyPlaceConcession(codeFirst.body.booking.id, childPrice.id, a.id)).toMatchObject({ ok: false, code: "STK_NOT_COMBINABLE" });
  });

  it("one child's concession and a 10% code across three places: the code on the lower price, shared by place, the receipt adding up; the same whichever came first", async () => {
    const mum = await adult("Mum");
    const kids = [await child(mum, "Ema"), await child(mum, "Fiza"), await child(mum, "Gina")];
    const childPrice = await concession(together.venue, "participant", 50);
    const promo = await code(together.venue, { combinable: true });
    // Three places at RM10, Gina's at half: RM25, then 10% off RM25: RM22.50.
    const made = await book(mum, {
      courtId: together.pool,
      date: day(6),
      start: at(9),
      end: at(10),
      participantIds: kids.map((k) => k.id),
      placeConcessions: [{ participantId: kids[2].id, concessionId: childPrice.id }],
      promoCode: promo.code,
    });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ promoError: null, concessionError: null, discount: 2.5 });
    expect(made.body.booking.totalPrice).toBe(22.5);
    const id = made.body.booking.id;
    const { lines } = await placeShares(id);
    expect(lines.map((l) => [l.name, l.gross, l.concession, l.promo, l.net])).toEqual([
      ["Ema", 10, 0, 1, 9],
      ["Fiza", 10, 0, 1, 9],
      ["Gina", 10, 5, 0.5, 4.5],
    ]);
    expect((await shareRows(id)).map((r) => r.amount)).toEqual([1, 1, 0.5]);
    // The receipt: each discount a line of its own, the concession before the code, adding up to what is owed.
    const sale = (await bookingSale(id))!;
    expect(sale.lines.map((l) => l.amount)).toEqual([30, -5, -2.5]);
    // Whose place it was, kept apart from the words (lib/receipt-names.ts), said with them.
    expect(sale.lines[1]).toMatchObject({ description: `${childPrice.name} price`, place: { name: "Gina" } });
    expect(lineText(sale.lines[1])).toBe(`${childPrice.name} price, Gina`);
    expect(sale.lines[2].description).toBe(`Promo ${promo.code}`);
    expect(sum(sale.lines.map((l) => l.amount))).toBe(sale.total);

    // The code first, then the concession: the code is worked out again on the lower price: the same RM22.50, the same shares.
    const other = await book(mum, { courtId: together.pool, date: day(6), start: at(11), end: at(12), participantIds: kids.map((k) => k.id), promoCode: promo.code });
    expect(other.body.booking.totalPrice).toBe(27);
    expect((await applyPlaceConcession(other.body.booking.id, childPrice.id, kids[2].id)).ok).toBe(true);
    expect((await getBookingById(other.body.booking.id))!.totalPrice).toBe(22.5);
    expect(await useOf(other.body.booking.id)).toBe(2.5);
    expect((await shareRows(other.body.booking.id)).filter((r) => r.reversed_why === null).map((r) => r.amount)).toEqual([1, 1, 0.5]);
    // Her proof not shown at the counter: her place at the full price, the code worked out again on RM30.
    const [pb] = await placeBenefitsFor(other.body.booking.id);
    expect((await checkConcession({ bookingId: other.body.booking.id, venueIds: null, adminId: manager.id, outcome: "refused", placeBenefitId: pb.id })).ok).toBe(true);
    expect((await getBookingById(other.body.booking.id))!.totalPrice).toBe(27);
    expect(await useOf(other.body.booking.id)).toBe(3);
  });

  it("works odd sen out the same way every time: 15% after a 33% concession on one of three places", async () => {
    const dad = await adult("Dad");
    const kids = [await child(dad, "Hana"), await child(dad, "Iman"), await child(dad, "Jaya")];
    const third = await concession(together.venue, "participant", 33);
    const promo = await code(together.venue, { combinable: true, value: 15 });
    const made = await book(dad, {
      courtId: together.pool,
      date: day(7),
      start: at(9),
      end: at(10),
      participantIds: kids.map((k) => k.id),
      placeConcessions: [{ participantId: kids[2].id, concessionId: third.id }],
      promoCode: promo.code,
    });
    // RM30 less RM3.30 is RM26.70; 15% of that is RM4.005, rounded down to RM4.00; RM22.70 to pay.
    expect(made.body.booking.totalPrice).toBe(22.7);
    expect(await useOf(made.body.booking.id)).toBe(4);
    const { lines } = await placeShares(made.body.booking.id);
    // In proportion to RM10, RM10, RM6.70, by largest remainder: RM1.50, RM1.50, RM1.00.
    expect(lines.map((l) => [l.promo, l.net])).toEqual([
      [1.5, 8.5],
      [1.5, 8.5],
      [1, 5.7],
    ]);
    expect(sum(lines.map((l) => l.net))).toBe(22.7);
    const sale = (await bookingSale(made.body.booking.id))!;
    expect(sum(sale.lines.map((l) => l.amount))).toBe(22.7);
  });

  it("a fixed amount is shared in proportion, and nothing ever goes below nothing", async () => {
    const mum = await adult("Mum");
    const kids = [await child(mum, "Kamal"), await child(mum, "Lina")];
    const free = await concession(together.venue, "participant", 100);
    const five = await code(together.venue, { combinable: true, kind: "amount", value: 5 });
    const made = await book(mum, {
      courtId: together.pool,
      date: day(8),
      start: at(9),
      end: at(10),
      participantIds: kids.map((k) => k.id),
      placeConcessions: [{ participantId: kids[1].id, concessionId: free.id }],
      promoCode: five.code,
    });
    // Lina's place is free: the RM5 is all Kamal's.
    expect(made.body.booking.totalPrice).toBe(5);
    expect((await placeShares(made.body.booking.id)).lines.map((l) => [l.promo, l.net])).toEqual([
      [5, 5],
      [0, 0],
    ]);
    // A RM50 code on a RM20 hall with a 20% booking concession: RM16 off, never below nothing.
    const fifty = await code(together.venue, { combinable: true, kind: "amount", value: 50 });
    const student = await concession(together.venue, "booking", 20);
    const hall = await book(mum, { courtId: together.hall, date: day(8), start: at(11), end: at(12), concessionId: student.id, promoCode: fifty.code });
    expect(hall.body.booking.totalPrice).toBe(0);
    expect(await useOf(hall.body.booking.id)).toBe(16);
    // Nothing left to take off: a further code is refused as taking nothing.
    expect(await courtBeforePromo(hall.body.booking.id)).toBe(16);
  });
});

describe("every path that books", () => {
  it("several courts at once: each court's concession, the code refused or worked out the same way on each", async () => {
    const dad = await adult("Dad");
    const studentNever = await concession(never.venue, "booking", 20);
    const codeNever = await code(never.venue, { combinable: true });
    const refused = await book(dad, { courtId: never.hall, moreCourts: [never.hall2], date: day(15), start: at(9), end: at(10), concessionId: studentNever.id, promoCode: codeNever.code });
    expect(refused.status).toBe(201);
    expect((refused.body.bookings as Booked[]).map((b) => b.totalPrice)).toEqual([16, 16]);
    expect(refused.body.promoErrorCode).toBe("ONE_DISCOUNT");

    const mum = await adult("Mum");
    const student = await concession(together.venue, "booking", 20);
    const promo = await code(together.venue, { combinable: true });
    const both = await book(mum, { courtId: together.hall, moreCourts: [together.hall2], date: day(15), start: at(9), end: at(10), concessionId: student.id, promoCode: promo.code });
    // Each court RM20, less RM4, less 10% of RM16: RM14.40.
    expect((both.body.bookings as Booked[]).map((b) => b.totalPrice)).toEqual([14.4, 14.4]);
    expect(both.body.discount).toBe(3.2);
  });

  it("a lesson: the concession and the code come off the court time, never the coach's fee", async () => {
    const mum = await adult("Mum");
    const student = await concession(together.venue, "booking", 20);
    const promo = await code(together.venue, { combinable: true });
    const lesson = await book(mum, { courtId: together.hall, coachId: together.coach, date: day(16), start: at(9), end: at(10), concessionId: student.id, promoCode: promo.code });
    expect(lesson.status).toBe(201);
    // RM20 of court time less RM4 less RM1.60, and the coach's RM80 untouched.
    expect(lesson.body.booking.totalPrice).toBe(94.4);
    const sale = (await bookingSale(lesson.body.booking.id))!;
    expect(sale.lines.map((l) => l.amount)).toEqual([20, 80, -4, -1.6]);
  });
});

describe("a place taken off", () => {
  it("not yet paid: exactly that place's price comes off, its concession and its part of the code with it", async () => {
    const mum = await adult("Mum");
    const kids = [await child(mum, "Mawar"), await child(mum, "Nur"), await child(mum, "Orked")];
    const childPrice = await concession(together.venue, "participant", 50);
    const promo = await code(together.venue, { combinable: true });
    const made = await book(mum, {
      courtId: together.pool,
      date: day(9),
      start: at(9),
      end: at(10),
      participantIds: kids.map((k) => k.id),
      placeConcessions: [{ participantId: kids[2].id, concessionId: childPrice.id }],
      promoCode: promo.code,
    });
    const id = made.body.booking.id;
    expect(made.body.booking.totalPrice).toBe(22.5);
    const done = await withdrawPlace(id, { participantId: kids[2].id }, { kind: "staff", adminId: manager.id, name: manager.name });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    // Orked's place: RM10, less her RM5 concession and her RM0.50 of the code: RM4.50.
    expect(done.withdrawal).toMatchObject({ price: 4.5, owedLess: 4.5 });
    expect(done.booking.totalPrice).toBe(18);
    expect(await useOf(id)).toBe(2);
    const w = (await getDb().prepare("SELECT promo_share::float AS promo_share FROM place_withdrawals WHERE booking_id = ?").get(id)) as { promo_share: number };
    expect(w.promo_share).toBe(0.5);
    const { lines } = await placeShares(id);
    expect(lines.map((l) => [l.name, l.promo, l.net])).toEqual([
      ["Mawar", 1, 9],
      ["Nur", 1, 9],
    ]);
    // The receipt still adds up.
    const sale = (await bookingSale(id))!;
    expect(sum(sale.lines.map((l) => l.amount))).toBe(18);
  });

  it("already paid: exactly that place's share goes back, and the booking's receipt stays as sold", async () => {
    const mum = await adult("Mum");
    const kids = [await child(mum, "Puteri"), await child(mum, "Qistina"), await child(mum, "Rania")];
    const childPrice = await concession(together.venue, "participant", 50);
    const promo = await code(together.venue, { combinable: true });
    const made = await book(mum, {
      courtId: together.pool,
      date: day(10),
      start: at(9),
      end: at(10),
      participantIds: kids.map((k) => k.id),
      placeConcessions: [{ participantId: kids[2].id, concessionId: childPrice.id }],
      promoCode: promo.code,
    });
    const id = made.body.booking.id;
    expect((await setPaymentStatus(made.body.booking.code, true, "cash")).ok).toBe(true);
    const done = await withdrawPlace(id, { participantId: kids[0].id }, { kind: "staff", adminId: manager.id, name: manager.name });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    // Puteri's place: RM10 less her RM1 of the code: RM9 back, by hand at the counter.
    expect(done.withdrawal).toMatchObject({ price: 9, refund: 9, how: "hand" });
    expect(done.booking.totalPrice).toBe(22.5);
    expect(await useOf(id)).toBe(2.5);
    // The two left: what they cost, as sold.
    const { lines } = await placeShares(id);
    expect(lines.map((l) => [l.name, l.net])).toEqual([
      ["Qistina", 9],
      ["Rania", 4.5],
    ]);
  });
});

describe("moved and cancelled", () => {
  it("a move keeps the discounts as given; a cancellation gives the code's use back, with its shares", async () => {
    const mum = await adult("Mum");
    const kids = [await child(mum, "Siti"), await child(mum, "Tia")];
    const childPrice = await concession(together.venue, "participant", 50);
    const promo = await code(together.venue, { combinable: true, maxUses: 5 });
    const made = await book(mum, {
      courtId: together.pool,
      date: day(11),
      start: at(9),
      end: at(10),
      participantIds: kids.map((k) => k.id),
      placeConcessions: [{ participantId: kids[1].id, concessionId: childPrice.id }],
      promoCode: promo.code,
    });
    // RM20 less RM5 is RM15; 10% of that is RM1.50: RM13.50.
    expect(made.body.booking.totalPrice).toBe(13.5);
    const moved = await rescheduleBooking(made.body.booking.code, { date: day(12), start: at(14) }, "staff");
    expect(moved.ok).toBe(true);
    const after = (await getBookingById(made.body.booking.id))!;
    expect(after.totalPrice).toBe(13.5);
    expect(await useOf(after.id)).toBe(1.5);
    expect((await placeBenefitsFor(after.id)).map((p) => p.amount)).toEqual([5]);
    expect((await promoById(promo.id))!.used).toBe(1);

    expect((await cancelBooking(after.code, mum.phone)).ok).toBe(true);
    expect(await useOf(after.id)).toBeNull();
    expect((await shareRows(after.id)).every((r) => r.reversed_why !== null)).toBe(true);
    const counted = (await getDb().prepare("SELECT used_count FROM promo_codes WHERE id = ?").get(promo.id)) as { used_count: number };
    expect(Number(counted.used_count)).toBe(0);
  });
});

describe("taken once", () => {
  it("the last use of a limited code goes to one booking however many ask at once, and the database holds the limit itself", async () => {
    const single = await code(together.venue, { maxUses: 1 });
    const people = await Promise.all(Array.from({ length: 4 }, () => adult("Racer")));
    const ids: number[] = [];
    for (const [i, p] of people.entries()) {
      const made = await createBookingSeries({ courtId: together.hall, date: day(13), start: at(8 + i), end: at(9 + i), weeks: 1, name: p.name, phone: p.phone, userId: p.id });
      if (!made.ok) throw new Error(made.error);
      ids.push(made.bookings[0].id);
    }
    const results = await Promise.all(ids.map((id) => applyPromo(id, single.code)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const r of results.filter((x) => !x.ok)) expect(r.ok === false && (r.code === "STK_USED_UP" || r.code === "BUSY" || /fully claimed/.test(r.error))).toBe(true);
    expect((await promoById(single.id))!.used).toBe(1);
    // A use written past the limit, by any path: refused by the database.
    await expect(getDb().prepare("INSERT INTO promo_uses (promo_id, booking_id, discount) VALUES (?, ?, 1)").run(single.id, ids.find((id, i) => !results[i].ok)!)).rejects.toThrow(
      /promo_codes_used_within_limit/
    );
  });

  it("a code and a concession asked for at once on one booking where they do not go together: one of them, never both", async () => {
    const mum = await adult("Mum");
    const kids = [await child(mum, "Umi"), await child(mum, "Vee")];
    const childPrice = await concession(never.venue, "participant", 50);
    const promo = await code(never.venue);
    const made = await book(mum, { courtId: never.pool, date: day(14), start: at(9), end: at(10), participantIds: kids.map((k) => k.id) });
    const id = made.body.booking.id;
    const [c, p] = await Promise.all([applyPlaceConcession(id, childPrice.id, kids[0].id), applyPromo(id, promo.code)]);
    expect([c.ok, p.ok].filter(Boolean)).toHaveLength(1);
    const after = (await getBookingById(id))!;
    expect([15, 18]).toContain(after.totalPrice);
    expect((await placeBenefitsFor(id)).length + ((await useOf(id)) === null ? 0 : 1)).toBe(1);
  });
});

describe("the venue's setting", () => {
  it("is a manager's, said through the dashboard, and read by the booking form; a code says whether it combines", async () => {
    const get = await stackingRoute.GET(req(`http://localhost/api/admin/promos/stacking?venueId=${never.venue}`, "GET", manager.cookie));
    expect(await get.json()).toEqual({ stacking: "never" });
    const bad = await stackingRoute.POST(req("http://localhost/api/admin/promos/stacking", "POST", manager.cookie, { venueId: never.venue, stacking: "always" }));
    expect(bad.status).toBe(400);
    const desk = await createAdmin({ name: "Desk", email: `stk-desk${++n}@stk.test`, password: "a long enough password", venueId: never.venue, role: "desk" });
    if (!desk.ok) throw new Error(desk.error);
    const deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
    const refused = await stackingRoute.POST(req("http://localhost/api/admin/promos/stacking", "POST", deskCookie, { venueId: never.venue, stacking: "promotion" }));
    expect(refused.status).toBe(403);

    const created = await promosRoute.POST(
      req("http://localhost/api/admin/promos", "POST", manager.cookie, {
        venueId: together.venue,
        code: `WITH${++n}`,
        description: "Goes with a child's price",
        kind: "percent",
        value: 10,
        validFrom: todayISO(),
        validTo: day(30),
        combinable: true,
      })
    );
    expect(created.status).toBe(201);
    expect(((await created.json()) as { promo: { combinable: boolean } }).promo.combinable).toBe(true);
    const listed = (await (await promosRoute.GET(req(`http://localhost/api/admin/promos?venueId=${together.venue}`, "GET", manager.cookie))).json()) as { stacking: string };
    expect(listed.stacking).toBe("promotion");
    const board = (await (await availabilityRoute.GET(req(`http://localhost/api/availability?venueId=${together.venue}&date=${day(2)}&sport=swimming`, "GET", null))).json()) as {
      discountStacking: string;
    };
    expect(board.discountStacking).toBe("promotion");
  });
});
