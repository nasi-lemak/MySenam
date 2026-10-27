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
import { applyPlaceConcession, checkConcession, saveConcession } from "../src/lib/concessions";
import { getDb } from "../src/lib/db";
import { bookingSale } from "../src/lib/documents";
import { placeBenefitsFor, placeShare } from "../src/lib/entitlements";
import { addManaged } from "../src/lib/managed-people";
import { createAtVenue } from "../src/lib/participants";
import { createResources } from "../src/lib/resources";
import { setHouseRules } from "../src/lib/house-rules";
import {
  cancelBooking,
  createBookingSeries,
  createVenue,
  getBookingById,
  getPass,
  issuePass,
  payBookingWithPass,
  payBookingWithPasses,
  refundBookingToPass,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import * as bookingsRoute from "../src/app/api/bookings/route";
import * as passesRoute from "../src/app/api/admin/passes/route";

/**
 * Benefits by the scope they apply to (ADR 0025; lib/entitlements.ts;
 * docs/features/pricing.md#what-a-benefit-applies-to): a pass or concession
 * for the booking as a whole, as every one sold before; one for a resource
 * hired whole; one for one person's place; one spent for each place. Mixed
 * eligibility priced per place on what is sold by the place; booking-wide
 * benefits on what is hired whole; redemptions once, by the database.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (k: number) => addDays(todayISO(ZONE), k);
const at = (h: number) => h * 60;
let n = 0;
const phone = () => `0178${String(++n).padStart(6, "0")}`;

let venue: number;
let pool: number;
let hall: number;
let pickle: number;
let manager: { id: number; name: string; cookie: string };

type Adult = Awaited<ReturnType<typeof adult>>;
async function adult(name = "Parent") {
  const ph = phone();
  const made = await registerUser({ name: `${name} ${++n}`, email: `ent${n}@ent.test`, phone: ph, password: "a long enough password" });
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
    headers: { "content-type": "application/json", "x-forwarded-for": `10.88.${++n % 250}.${n % 200}`, ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const book = async (who: Adult, body: Record<string, unknown>) => {
  const res = await bookingsRoute.POST(req("http://localhost/api/bookings", "POST", who.cookie, { name: who.name, phone: who.phone, ...body }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & { booking: { id: number; code: string; totalPrice: number; paymentStatus: string } } };
};

async function pass(holder: Adult, input: Partial<Parameters<typeof issuePass>[0]> = {}) {
  const made = await issuePass({
    venueId: venue,
    name: "Swim 10",
    entries: 10,
    entryMinutes: 60,
    price: 100,
    holderName: holder.name,
    holderPhone: holder.phone,
    userId: holder.id,
    expiresOn: day(60),
    adminId: manager.id,
    ...input,
  });
  if (!made.ok) throw new Error(made.error);
  return made.pass;
}

async function concession(scope: "booking" | "participant", percent = 50) {
  const made = await saveConcession(venue, { name: scope === "participant" ? `Child ${++n}` : `Student ${++n}`, percent, proof: "their school card", scope });
  if (!made.ok) throw new Error(made.error);
  return made.concession;
}

const spends = async (bookingId: number) =>
  (await getDb()
    .prepare("SELECT pass_id, delta, place_id, settles_entry_id FROM pass_entries WHERE booking_id = ? ORDER BY id")
    .all(bookingId)) as { pass_id: number; delta: number; place_id: number | null; settles_entry_id: number | null }[];

beforeAll(async () => {
  const v = await createVenue({ name: "Scope Centre", area: "Bangsar", address: "x", phone: "0312350601", openMin: at(7), closeMin: at(23) });
  if (!v.ok) throw new Error("venue");
  venue = v.venue.id;
  const make = async (sport: string, name: string, capacity: number, rate: number) => {
    const r = await createResources({ venueId: venue, sport, name, offPeakRate: rate, peakRate: rate, capacity, ...(capacity > 1 ? { maxPlayers: capacity } : {}) });
    if (!r.ok) throw new Error(r.error);
    return r.courts[0].id;
  };
  // A pool sold by the place (RM10 a place), a hall hired whole (RM20), a pickleball court priced per player (RM8).
  pool = await make("swimming", "Pool", 8, 10);
  hall = await make("badminton", "Hall", 1, 20);
  pickle = await make("pickleball", "Pickle", 1, 8);
  const { updateCourt } = await import("../src/lib/store");
  expect((await updateCourt(pickle, { perPlayer: true })).ok).toBe(true);
  expect((await setHouseRules(venue, { aheadDays: 45 })).ok).toBe(true);
  const made = await createAdmin({ name: "Mira", email: `ent-mgr${++n}@ent.test`, password: "a long enough password", venueId: venue, role: "manager" });
  if (!made.ok) throw new Error(made.error);
  manager = { id: made.admin.id, name: "Mira", cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}` };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("what was issued keeps its meaning", () => {
  it("every pass and concession sold before is for the booking as a whole, and pays it whole", async () => {
    const mum = await adult("Mum");
    const a = await child(mum, "Alya");
    const b = await child(mum, "Bilal");
    const p = await pass(mum);
    expect(p.scope).toBe("booking");
    const made = await book(mum, { courtId: pool, date: day(2), start: at(9), end: at(10), participantIds: [a.id, b.id], payWithPass: p.code });
    expect(made.status).toBe(201);
    expect(made.body.booking.paymentStatus).toBe("paid");
    // One entry for the booking, whoever is on it: what an entry always paid.
    expect((await getPass(p.code))!.remaining).toBe(9);
    expect(await spends(made.body.booking.id)).toEqual([{ pass_id: p.id, delta: -1, place_id: null, settles_entry_id: null }]);
    const scopes = (await getDb().prepare("SELECT DISTINCT scope FROM passes UNION SELECT DISTINCT scope FROM concessions UNION SELECT DISTINCT scope FROM membership_plans").all()) as { scope: string }[];
    expect(scopes.map((s) => s.scope)).toEqual(["booking"]);
  });
});

describe("a pass for one person's place", () => {
  it("pays only its holder's place: a booking for two needs each one's own, and each spend is given back once", async () => {
    const mum = await adult("Mum");
    const a = await child(mum, "Aina");
    const b = await child(mum, "Badrul");
    const swimA = await pass(mum, { scope: "participant", holderParticipantId: a.id, name: "Aina's swim pass" });
    const swimB = await pass(mum, { scope: "participant", holderParticipantId: b.id, name: "Badrul's swim pass" });
    expect(swimA).toMatchObject({ scope: "participant", holderParticipantId: a.id, holderParticipantName: "Aina" });

    // Aina alone: her pass pays her place.
    const alone = await book(mum, { courtId: pool, date: day(3), start: at(9), end: at(10), participantIds: [a.id], payWithPass: swimA.code });
    expect(alone.body.booking.paymentStatus).toBe("paid");
    expect((await getPass(swimA.code))!.remaining).toBe(9);
    expect((await spends(alone.body.booking.id))[0].place_id).not.toBeNull();

    // Both children, Aina's pass only: the booking stands, unpaid, and says whose place is still to pay.
    const both = await book(mum, { courtId: pool, date: day(3), start: at(11), end: at(12), participantIds: [a.id, b.id], payWithPass: swimA.code });
    expect(both.status).toBe(201);
    expect(both.body.booking.paymentStatus).toBe("unpaid");
    expect(String(both.body.walletError)).toContain("Badrul");
    expect((await getPass(swimA.code))!.remaining).toBe(9);
    // Each one's own: paid, one spend a place.
    const paid = await payBookingWithPasses(both.body.booking.id, [swimA.code, swimB.code]);
    expect(paid.ok).toBe(true);
    const lines = await spends(both.body.booking.id);
    expect(lines).toHaveLength(2);
    expect(new Set(lines.map((l) => l.place_id)).size).toBe(2);
    expect((await getPass(swimA.code))!.remaining).toBe(8);
    expect((await getPass(swimB.code))!.remaining).toBe(9);

    // Cancelled: each spend back, once; asked again, nothing more.
    expect((await cancelBooking(both.body.booking.code, mum.phone)).ok).toBe(true);
    expect((await getPass(swimA.code))!.remaining).toBe(9);
    expect((await getPass(swimB.code))!.remaining).toBe(10);
    expect((await refundBookingToPass(both.body.booking.id)).ok).toBe(false);
    expect((await getPass(swimB.code))!.remaining).toBe(10);

    // Aina's pass on a booking for Badrul alone: refused, naming her.
    const forB = await book(mum, { courtId: pool, date: day(3), start: at(13), end: at(14), participantIds: [b.id] });
    const wrong = await payBookingWithPass(forB.body.booking.id, swimA.code);
    expect(wrong).toMatchObject({ ok: false, code: "ENT_PASS_NOT_ON_BOOKING", vars: { name: "Aina" } });
    // A booking pass and a person's pass together: refused, not mixed.
    const whole = await pass(mum);
    expect(await payBookingWithPasses(forB.body.booking.id, [whole.code, swimB.code])).toMatchObject({ ok: false, code: "ENT_PASS_MIX" });
  });

  it("is sold at the counter only for somebody the venue knows with a guardian on the holder's number", async () => {
    const ph = phone();
    const kid = await createAtVenue({ venueId: venue, admin: { id: manager.id, name: manager.name }, displayName: "Chandra", guardian: { name: "Mr Raj", phone: ph, relationship: "parent", authority: true } });
    if (!kid.ok) throw new Error(kid.error);
    const sell = (body: Record<string, unknown>) =>
      passesRoute.POST(req("http://localhost/api/admin/passes", "POST", manager.cookie, { venueId: venue, name: "Swim 5", entries: 5, price: 50, holderName: "Mr Raj", holderPhone: ph, expiresOn: day(30), ...body }));
    const ok = await sell({ scope: "participant", holderParticipantId: kid.participant.id });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { pass: { holderParticipantName: string } }).pass.holderParticipantName).toBe("Chandra");
    // On a number nobody acting for them is on: refused.
    expect((await sell({ scope: "participant", holderParticipantId: kid.participant.id, holderPhone: phone() })).status).toBe(409);
    // A whole-booking pass is nobody else's to hold.
    expect((await sell({ scope: "booking", holderParticipantId: kid.participant.id })).status).toBe(400);
    expect((await sell({ scope: "everything" })).status).toBe(400);
  });
});

describe("a pass spent per place, and one for a resource hired whole", () => {
  it("a places pass spends for each place; a resource pass pays a court hired whole and not places", async () => {
    const dad = await adult("Dad");
    const perPlace = await pass(dad, { scope: "places", name: "Family swim" });
    const group = await createBookingSeries({ courtId: pool, date: day(4), start: at(9), end: at(10), weeks: 1, name: dad.name, phone: dad.phone, userId: dad.id, players: 3 });
    if (!group.ok) throw new Error(group.error);
    expect((await payBookingWithPass(group.bookings[0].id, perPlace.code)).ok).toBe(true);
    expect((await getPass(perPlace.code))!.remaining).toBe(7);
    expect(await spends(group.bookings[0].id)).toHaveLength(3);

    const hours = await pass(dad, { scope: "resource", kind: "time", entries: 600, entryMinutes: null, name: "Ten hall hours" });
    const onPool = await createBookingSeries({ courtId: pool, date: day(4), start: at(11), end: at(12), weeks: 1, name: dad.name, phone: dad.phone, userId: dad.id });
    if (!onPool.ok) throw new Error(onPool.error);
    expect(await payBookingWithPass(onPool.bookings[0].id, hours.code)).toMatchObject({ ok: false, code: "ENT_PASS_RESOURCE" });
    const onHall = await createBookingSeries({ courtId: hall, date: day(4), start: at(11), end: at(12), weeks: 1, name: dad.name, phone: dad.phone, userId: dad.id });
    if (!onHall.ok) throw new Error(onHall.error);
    expect((await payBookingWithPass(onHall.bookings[0].id, hours.code)).ok).toBe(true);
    expect((await getPass(hours.code))!.remaining).toBe(540);
  });
});

describe("a concession for one person's place", () => {
  it("comes off that child's place only on a booking priced by the place; a booking's own comes off the whole", async () => {
    const mum = await adult("Mum");
    const a = await child(mum, "Amani");
    const b = await child(mum, "Bella");
    const c = await child(mum, "Cik");
    const childPrice = await concession("participant", 50);
    // Three places at RM10, Amani's at half: RM25.
    const made = await book(mum, {
      courtId: pool,
      date: day(5),
      start: at(9),
      end: at(10),
      participantIds: [a.id, b.id, c.id],
      placeConcessions: [{ participantId: a.id, concessionId: childPrice.id }],
    });
    expect(made.status).toBe(201);
    expect(made.body.booking.totalPrice).toBe(25);
    expect(made.body.concessionError).toBeNull();
    const benefits = await placeBenefitsFor(made.body.booking.id);
    expect(benefits).toHaveLength(1);
    expect(benefits[0]).toMatchObject({ kind: "concession", participantId: a.id, amount: 5, proofCheck: "due", name: "Amani" });
    expect((await placeShare(made.body.booking.id, benefits[0].placeId)).net).toBe(5);
    // The receipt names whose price it was.
    const sale = await bookingSale(made.body.booking.id);
    expect(sale!.lines.some((l) => l.description === `${childPrice.name} price, Amani` && l.amount === -5)).toBe(true);
    expect(sale!.lines.reduce((s, l) => s + l.amount, 0)).toBe(25);

    // A concession for the booking: off the whole of it, as always.
    const student = await concession("booking", 20);
    const whole = await book(mum, { courtId: pool, date: day(5), start: at(11), end: at(12), participantIds: [a.id, b.id], concessionId: student.id });
    expect(whole.body.booking.totalPrice).toBe(16);

    // One person's concession on a hall hired whole: nothing there is per person; it stands at the full price and says why.
    const onHall = await book(mum, { courtId: hall, date: day(5), start: at(13), end: at(14), participantIds: [a.id], placeConcessions: [{ participantId: a.id, concessionId: childPrice.id }] });
    expect(onHall.body.booking.totalPrice).toBe(20);
    expect(onHall.body.concessionError).toMatchObject({ code: "ENT_PLACE_ONLY" });

    // A person's concession given as the booking's on a booking of several: whose must be said.
    // (Another family: a number holds only so many unpaid bookings at once.)
    const dad = await adult("Dad");
    const d = await child(dad, "Darwisy");
    const e = await child(dad, "Elina");
    const f = await child(dad, "Fikri");
    const vague = await book(dad, { courtId: pool, date: day(5), start: at(15), end: at(16), participantIds: [d.id, e.id], concessionId: childPrice.id });
    expect(vague.body.booking.totalPrice).toBe(20);
    expect(vague.body.concessionError).toMatchObject({ code: "ENT_CONCESSION_WHOSE" });
    // On a per-player court: that player's share (RM8 of 3 × RM8).
    const pk = await book(dad, { courtId: pickle, date: day(5), start: at(9), end: at(10), participantIds: [d.id, e.id, f.id], placeConcessions: [{ participantId: f.id, concessionId: childPrice.id }] });
    expect(pk.body.booking.totalPrice).toBe(20);
  });

  it("is redeemed once for a place, however many requests arrive at once", async () => {
    const mum = await adult("Mum");
    const a = await child(mum, "Danial");
    const b = await child(mum, "Dina");
    const childPrice = await concession("participant", 50);
    const made = await book(mum, { courtId: pool, date: day(6), start: at(9), end: at(10), participantIds: [a.id, b.id] });
    const id = made.body.booking.id;
    const results = await Promise.all(Array.from({ length: 4 }, () => applyPlaceConcession(id, childPrice.id, a.id)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && (r.code === "ENT_ALREADY_REDEEMED" || r.code === "BUSY"))).toBe(true);
    expect((await getBookingById(id))!.totalPrice).toBe(15);
    // Dina's own, alongside: both places, each once.
    expect((await applyPlaceConcession(id, childPrice.id, b.id)).ok).toBe(true);
    expect((await getBookingById(id))!.totalPrice).toBe(10);
    // Not with a code on top (one discount), nor for somebody not on it.
    expect(await applyPlaceConcession(id, childPrice.id, 999999)).toMatchObject({ ok: false, code: "ENT_NOT_ON_BOOKING" });
  });

  it("the counter checks the child's own proof, remembered for that child alone; no proof charges that place in full", async () => {
    const mum = await adult("Mum");
    const a = await child(mum, "Eli");
    const b = await child(mum, "Ema");
    const childPrice = await concession("participant", 50);
    const first = await book(mum, { courtId: pool, date: day(7), start: at(9), end: at(10), participantIds: [a.id, b.id], placeConcessions: [{ participantId: a.id, concessionId: childPrice.id }] });
    const [pb] = await placeBenefitsFor(first.body.booking.id);
    const seen = await checkConcession({ bookingId: first.body.booking.id, venueIds: null, adminId: manager.id, outcome: "seen", remember: "twelve", placeBenefitId: pb.id });
    expect(seen.ok).toBe(true);
    expect((await placeBenefitsFor(first.body.booking.id))[0].proofCheck).toBe("seen");
    // Next time Eli's is on file; Ema's is not.
    const next = await book(mum, {
      courtId: pool,
      date: day(7),
      start: at(11),
      end: at(12),
      participantIds: [a.id, b.id],
      placeConcessions: [
        { participantId: a.id, concessionId: childPrice.id },
        { participantId: b.id, concessionId: childPrice.id },
      ],
    });
    const checks = await placeBenefitsFor(next.body.booking.id);
    expect(checks.map((c) => [c.participantId, c.proofCheck])).toEqual([
      [a.id, "seen"],
      [b.id, "due"],
    ]);
    expect(next.body.booking.totalPrice).toBe(10);
    // Ema has no proof: her place at the full price, Eli's still at his.
    const ema = checks.find((c) => c.participantId === b.id)!;
    const refused = await checkConcession({ bookingId: next.body.booking.id, venueIds: null, adminId: manager.id, outcome: "refused", placeBenefitId: ema.id });
    expect(refused).toMatchObject({ ok: true, charged: 5 });
    expect((await getBookingById(next.body.booking.id))!.totalPrice).toBe(15);
    expect(await checkConcession({ bookingId: next.body.booking.id, venueIds: null, adminId: manager.id, outcome: "refused", placeBenefitId: ema.id })).toMatchObject({ ok: false });
    expect((await getBookingById(next.body.booking.id))!.totalPrice).toBe(15);
  });
});

describe("redemptions under concurrency (real concurrency on Postgres)", () => {
  it("two bookings racing for the last entry of a child's pass: one is paid, the pass never goes below nothing", async () => {
    const mum = await adult("Mum");
    const a = await child(mum, "Farah");
    const last = await pass(mum, { scope: "participant", holderParticipantId: a.id, entries: 1, name: "Last swim" });
    const one = await book(mum, { courtId: pool, date: day(8), start: at(9), end: at(10), participantIds: [a.id] });
    const two = await book(mum, { courtId: pool, date: day(8), start: at(11), end: at(12), participantIds: [a.id] });
    const results = await Promise.all([payBookingWithPass(one.body.booking.id, last.code), payBookingWithPass(two.body.booking.id, last.code)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await getPass(last.code))!.remaining).toBe(0);
  });

  it("one booking paid by the counter and the customer at the same moment: paid once, spent once", async () => {
    const mum = await adult("Mum");
    const a = await child(mum, "Gita");
    const b = await child(mum, "Gopal");
    const pa = await pass(mum, { scope: "participant", holderParticipantId: a.id });
    const pbp = await pass(mum, { scope: "participant", holderParticipantId: b.id });
    const made = await book(mum, { courtId: pool, date: day(9), start: at(9), end: at(10), participantIds: [a.id, b.id] });
    const results = await Promise.all(Array.from({ length: 4 }, () => payBookingWithPasses(made.body.booking.id, [pa.code, pbp.code])));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await spends(made.body.booking.id)).toHaveLength(2);
    expect((await getPass(pa.code))!.remaining).toBe(9);
    expect((await getPass(pbp.code))!.remaining).toBe(9);
  });
});
