import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { listActivity } from "../src/lib/activity";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { saveCoach } from "../src/lib/coaching";
import { setCancelPolicy } from "../src/lib/cancel-policy";
import { saveConcession } from "../src/lib/concessions";
import { getDb } from "../src/lib/db";
import { placeBenefitsFor } from "../src/lib/entitlements";
import { setHouseRules } from "../src/lib/house-rules";
import { addManaged } from "../src/lib/managed-people";
import { participantHistory } from "../src/lib/participants";
import { savePaymentSettings, settleBill, startBookingPayment } from "../src/lib/payments";
import { withdrawPlace, withdrawOptions } from "../src/lib/place-withdrawals";
import { createResources } from "../src/lib/resources";
import { updatePolicy } from "../src/lib/booking-policy";
import {
  adminCancelBooking,
  cancelBooking,
  createBookingSeries,
  createClassSessions,
  createVenue,
  enrolPeople,
  getBookingById,
  getClass,
  getPass,
  getWalletBalance,
  issuePass,
  joinSlotWaitlist,
  payBookingWithPasses,
  topUpWallet,
  updateCourt,
  updateVenue,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import * as bookingsRoute from "../src/app/api/bookings/route";
import * as withdrawRoute from "../src/app/api/bookings/withdraw/route";
import * as myWithdrawRoute from "../src/app/api/my/bookings/withdraw/route";
import * as staffWithdrawRoute from "../src/app/api/admin/bookings/withdraw/route";

/**
 * Taking one person off a booking, the others staying booked (ADR 0025;
 * lib/place-withdrawals.ts; docs/features/booking.md#taking-one-person-off-a-booking):
 * a child withdrawn from a session, a place given up, a player off a court
 * hired whole; the money, the passes, the places held, the waiting list and
 * the record each as they should be; refused, with the reason, where it
 * cannot be done; and at the same moment, on Postgres.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (k: number) => addDays(todayISO(ZONE), k);
const at = (h: number) => h * 60;
let n = 0;
const phone = () => `0176${String(++n).padStart(6, "0")}`;

type Adult = Awaited<ReturnType<typeof adult>>;
async function adult(name = "Parent") {
  const ph = phone();
  const made = await registerUser({ name: `${name} ${++n}`, email: `pw${n}@pw.test`, phone: ph, password: "a long enough password" });
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
    headers: { "content-type": "application/json", "x-forwarded-for": `10.66.${++n % 250}.${n % 200}`, ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const book = async (who: Adult, body: Record<string, unknown>) => {
  const res = await bookingsRoute.POST(req("http://localhost/api/bookings", "POST", who.cookie, { name: who.name, phone: who.phone, ...body }));
  const out = (await res.json()) as { booking: { id: number; code: string; totalPrice: number; paymentStatus: string } };
  if (res.status !== 201) throw new Error(JSON.stringify(out));
  return out.booking;
};
const engine = (who: Adult, input: Partial<Parameters<typeof createBookingSeries>[0]>) =>
  createBookingSeries({ weeks: 1, name: who.name, phone: who.phone, userId: who.id, by: "staff", date: day(2), start: at(9), end: at(10), courtId: pool, ...input } as Parameters<typeof createBookingSeries>[0]);

const placesHeld = async (bookingId: number) =>
  Number(((await getDb().prepare("SELECT COALESCE(SUM(places), 0) AS n FROM claims WHERE booking_id = ? AND active").get(bookingId)) as { n: number | string }).n);
const names = async (bookingId: number) =>
  ((await getDb().prepare("SELECT name FROM booking_participants WHERE booking_id = ? ORDER BY id").all(bookingId)) as { name: string }[]).map((r) => r.name);
const customer = (who: Adult) => ({ kind: "customer" as const, userId: who.id, name: who.name });

let venue: number;
let lateVenue: number;
let pool: number;
let hall: number;
let pickle: number;
let latePool: number;
let manager: { id: number; name: string; cookie: string };

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
  venue = await make("Withdraw Centre", "0312350801");
  lateVenue = await make("Late Centre", "0312350802");
  pool = await resource(venue, "swimming", "Pool", 4, 10);
  hall = await resource(venue, "badminton", "Hall", 1, 20);
  pickle = await resource(venue, "pickleball", "Pickle", 1, 8);
  latePool = await resource(lateVenue, "swimming", "Late pool", 4, 10);
  expect((await updateCourt(pickle, { perPlayer: true })).ok).toBe(true);
  for (const v of [venue, lateVenue]) expect((await setHouseRules(v, { aheadDays: 45 })).ok).toBe(true);
  // Late: inside 48 hours, where the venue keeps half.
  expect((await updateVenue(lateVenue, { cancelCutoffHours: 48 })).ok).toBe(true);
  await setCancelPolicy(lateVenue, { lateKeep: 50 });
  const made = await createAdmin({ name: "Mira", email: `pw-mgr${++n}@pw.test`, password: "a long enough password", venueId: venue, role: "manager" });
  if (!made.ok) throw new Error(made.error);
  manager = { id: made.admin.id, name: "Mira", cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}` };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a place on a shared session", () => {
  it("one child withdrawn: the others stay, the place is released, its price comes off what is owed, the guardian is told", async () => {
    const mum = await adult("Mum");
    const kids = [await child(mum, "Alya"), await child(mum, "Bilal"), await child(mum, "Cik")];
    const b = await book(mum, { courtId: pool, date: day(3), start: at(9), end: at(10), participantIds: kids.map((k) => k.id), email: "mum@pw.test" });
    expect(b.totalPrice).toBe(30);
    expect(await placesHeld(b.id)).toBe(3);

    // What it would do, before it is done.
    const options = await withdrawOptions((await getBookingById(b.id))!, customer(mum));
    expect(options.map((o) => [o.name, o.allowed, o.owedLess])).toEqual([
      ["Alya", true, 10],
      ["Bilal", true, 10],
      ["Cik", true, 10],
    ]);

    const res = await withdrawRoute.POST(req("http://localhost/api/bookings/withdraw", "POST", null, { code: b.code, phone: mum.phone, participantId: kids[1].id }));
    expect(res.status).toBe(200);
    const done = (await res.json()) as { booking: { totalPrice: number; players: number; status: string }; withdrawal: { name: string; owedLess: number; released: number } };
    expect(done.withdrawal).toMatchObject({ name: "Bilal", owedLess: 10, released: 1 });
    expect(done.booking).toMatchObject({ totalPrice: 20, players: 2, status: "confirmed" });
    expect(await placesHeld(b.id)).toBe(2);
    expect(await names(b.id)).toEqual(["Alya", "Cik"]);
    expect((await getBookingById(b.id))!.participantName).toBe("Alya, Cik");
    // The guardian sees it on their bookings as the others still booked.
    expect(await withdrawOptions((await getBookingById(b.id))!, customer(mum))).toHaveLength(2);
    // On the record: who, by whom; in Bilal's history.
    const kept = (await getDb().prepare("SELECT takes_part_as, participant_id, name, price, paid, by_kind FROM place_withdrawals WHERE booking_id = ?").all(b.id)) as Record<string, unknown>[];
    expect(kept).toEqual([{ takes_part_as: "participant", participant_id: kids[1].id, name: "Bilal", price: kept[0].price, paid: false, by_kind: "customer" }]);
    expect(Number(kept[0].price)).toBe(10);
    expect((await participantHistory(kids[1].id)).some((e) => e.action === "booking.withdrawn")).toBe(true);
    // Told, naming him.
    const msg = (await getDb().prepare("SELECT subject, body FROM messages WHERE booking_id = ? AND dedupe_key LIKE 'withdrawn:%'").get(b.id)) as { subject: string; body: string };
    expect(msg.subject).toContain("Bilal");
    expect(msg.body).toContain("Everybody else on it stays booked");
    // Twice: he is no longer on it.
    expect(await withdrawPlace(b.id, { participantId: kids[1].id }, customer(mum))).toMatchObject({ ok: false, code: "ENT_WITHDRAW_NOT_ON" });
    // His record erased: his name goes from the record of the place he gave up; what it cost stays.
    await getDb().prepare("DELETE FROM participants WHERE id = ?").run(kids[1].id);
    expect(await getDb().prepare("SELECT name, participant_id, price::float AS price FROM place_withdrawals WHERE booking_id = ?").get(b.id)).toEqual({ name: null, participant_id: null, price: 10 });
  });

  it("the place freed is offered to whoever has waited for it", async () => {
    const date = day(4);
    const mum = await adult("Mum");
    const kids = [await child(mum, "Dina"), await child(mum, "Danial")];
    const crowd = await adult("Crowd");
    const full = await engine(crowd, { date, players: 2 });
    if (!full.ok) throw new Error(full.error);
    const fam = await engine(mum, { date, participants: kids });
    if (!fam.ok) throw new Error(fam.error);
    const waiter = await adult("Waiter");
    const queued = await joinSlotWaitlist({ courtId: pool, date, start: at(9), end: at(10), name: waiter.name, phone: waiter.phone, userId: waiter.id });
    if (!queued.ok) throw new Error(queued.error);
    expect((await withdrawPlace(fam.bookings[0].id, { participantId: kids[0].id }, customer(mum))).ok).toBe(true);
    const entry = (await getDb().prepare("SELECT status FROM waitlist WHERE id = ?").get(queued.entry.id)) as { status: string };
    expect(entry.status).toBe("offered");
  });

  it("a group gives up a place nobody is named on: one fewer held, one place's price off", async () => {
    const dad = await adult("Dad");
    const made = await engine(dad, { date: day(5), players: 4 });
    if (!made.ok) throw new Error(made.error);
    const id = made.bookings[0].id;
    const res = await myWithdrawRoute.POST(req("http://localhost/api/my/bookings/withdraw", "POST", dad.cookie, { bookingId: id, unnamed: 1 }));
    expect(res.status).toBe(200);
    expect((await getBookingById(id))!).toMatchObject({ players: 3, totalPrice: 30 });
    expect(await placesHeld(id)).toBe(3);
    // Not more places than there are, and never the last.
    expect(await withdrawPlace(id, { unnamed: 3 }, customer(dad))).toMatchObject({ ok: false, code: "ENT_WITHDRAW_NO_PLACES" });
    // Somebody else's booking is not theirs to change.
    const other = await adult("Other");
    expect((await myWithdrawRoute.POST(req("http://localhost/api/my/bookings/withdraw", "POST", other.cookie, { bookingId: id, unnamed: 1 }))).status).toBe(404);
  });

  it("one child withdrawn from a class: their own enrolment cancelled, the sibling's stays, the place offered", async () => {
    const mum = await adult("Mum");
    const kids = [await child(mum, "Eli"), await child(mum, "Ema")];
    const made = await createClassSessions({ courtId: pool, name: "Junior swim", instructor: "Coach", date: day(6), start: at(17), end: at(18), capacity: 2, price: 15 });
    if (!made.ok) throw new Error(made.error);
    const cls = made.classes[0];
    const enrolled = await enrolPeople({ classId: cls.id, name: mum.name, phone: mum.phone, userId: mum.id, people: kids });
    if (!enrolled.ok) throw new Error(enrolled.error);
    // Each place in a class is its own enrolment: taking somebody off one names that.
    expect(await withdrawPlace(enrolled.bookings[0].id, { participantId: kids[0].id }, customer(mum))).toMatchObject({ ok: false, code: "ENT_WITHDRAW_CLASS" });
    expect((await cancelBooking(enrolled.bookings[0].code, mum.phone)).ok).toBe(true);
    expect((await getClass(cls.id))!.enrolled).toBe(1);
    expect((await getBookingById(enrolled.bookings[1].id))!.status).toBe("confirmed");
  });
});

describe("money, the way it was paid", () => {
  it("paid from credit: the place's price back to credit with its own credit note; a later cancellation gives back only the rest", async () => {
    const mum = await adult("Mum");
    const kids = [await child(mum, "Farah"), await child(mum, "Fikri")];
    await topUpWallet({ userId: mum.id, amount: 100, adminId: manager.id, venueId: venue });
    const before = await getWalletBalance(mum.id, venue);
    const b = await book(mum, { courtId: pool, date: day(7), start: at(9), end: at(10), participantIds: kids.map((k) => k.id), payFromWallet: true });
    expect(b.paymentStatus).toBe("paid");
    expect(await getWalletBalance(mum.id, venue)).toBe(before - 20);
    const done = await withdrawPlace(b.id, { participantId: kids[0].id }, customer(mum));
    expect(done).toMatchObject({ ok: true, withdrawal: { refund: 10, how: "credit", kept: 0 } });
    expect(await getWalletBalance(mum.id, venue)).toBe(before - 10);
    // The sale stays as sold; the place's credit note says what went back.
    expect((await getBookingById(b.id))!.totalPrice).toBe(20);
    const notes = (await getDb().prepare("SELECT total::float AS total FROM receipts WHERE kind = 'credit_note' AND source LIKE ?").all(`booking:${b.id}:place:%`)) as { total: number }[];
    expect(notes.map((x) => x.total)).toEqual([10]);
    // Cancelled: the rest, and never more than was paid.
    expect((await cancelBooking(b.code, mum.phone)).ok).toBe(true);
    expect(await getWalletBalance(mum.id, venue)).toBe(before);
  });

  it("late, where the venue keeps its share: half the place's price back, half kept, on the record", async () => {
    const mum = await adult("Mum");
    const kids = [await child(mum, "Gita"), await child(mum, "Gopal")];
    await topUpWallet({ userId: mum.id, amount: 100, adminId: manager.id, venueId: lateVenue });
    const b = await book(mum, { courtId: latePool, date: day(1), start: at(20), end: at(21), participantIds: kids.map((k) => k.id), payFromWallet: true });
    const done = await withdrawPlace(b.id, { participantId: kids[0].id }, customer(mum));
    expect(done).toMatchObject({ ok: true, withdrawal: { refund: 5, kept: 5, late: true, keptPercent: 50 } });
    // Then the booking itself, late too: half of what is left.
    const balance = await getWalletBalance(mum.id, lateVenue);
    const cancelled = await cancelBooking(b.code, mum.phone);
    expect(cancelled).toMatchObject({ ok: true, kept: 5 });
    expect(await getWalletBalance(mum.id, lateVenue)).toBe(balance + 5);
    // Staff at the counter: in full, even late.
    const dad = await adult("Dad");
    const kids2 = [await child(dad, "Hana"), await child(dad, "Haris")];
    await topUpWallet({ userId: dad.id, amount: 100, adminId: manager.id, venueId: lateVenue });
    const b2 = await book(dad, { courtId: latePool, date: day(1), start: at(21), end: at(22), participantIds: kids2.map((k) => k.id), payFromWallet: true });
    expect(await withdrawPlace(b2.id, { participantId: kids2[0].id }, { kind: "staff", adminId: manager.id, name: manager.name })).toMatchObject({
      ok: true,
      withdrawal: { refund: 10, kept: 0 },
    });
  });

  it("paid online: the place's price owed back on the payment, through the venue's refund path; the rest on cancelling, never more than was taken", async () => {
    const online = (await createVenue({ name: "Online Centre", area: "Bangsar", address: "x", phone: "0312350803", openMin: at(7), closeMin: at(23) })) as { ok: true; venue: { id: number } };
    const oPool = (await createResources({ venueId: online.venue.id, sport: "swimming", name: "Online pool", offPeakRate: 10, peakRate: 10, capacity: 4, maxPlayers: 4 })) as { ok: true; courts: { id: number }[] };
    expect((await setHouseRules(online.venue.id, { aheadDays: 45 })).ok).toBe(true);
    const saved = await savePaymentSettings(online.venue.id, { apiKey: "api-key-1234", collectionId: "col123", xSignatureKey: "S-key", sandbox: true, enabled: true });
    if (!saved.ok) throw new Error(saved.error);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: `pwbill${++n}`, url: `https://www.billplz-sandbox.com/bills/pwbill${n}` })));
    const mum = await adult("Mum");
    const kids = [await child(mum, "Ilham"), await child(mum, "Iman")];
    const b = await book(mum, { courtId: oPool.courts[0].id, date: day(8), start: at(9), end: at(10), participantIds: kids.map((k) => k.id) });
    expect((await startBookingPayment({ codes: [b.code], phone: mum.phone })).ok).toBe(true);
    const bill = ((await getDb().prepare("SELECT bill_id FROM online_payments ORDER BY id DESC LIMIT 1").get()) as { bill_id: string }).bill_id;
    await settleBill({ billId: bill, paid: true, paidAt: null });
    expect((await getBookingById(b.id))!.paymentStatus).toBe("paid");
    const res = await withdrawRoute.POST(req("http://localhost/api/bookings/withdraw", "POST", null, { code: b.code, phone: mum.phone, participantId: kids[0].id }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { withdrawal: { refund: number; how: string }; refunds: { how: string; amount: number }[] };
    expect(body.withdrawal).toMatchObject({ refund: 10, how: "online" });
    expect(body.refunds.reduce((s, r) => s + r.amount, 0)).toBe(10);
    const due = async () => Number(((await getDb().prepare("SELECT refund_due::float AS d FROM online_payments WHERE bill_id = ?").get(bill)) as { d: number }).d);
    expect(await due()).toBe(10);
    expect((await cancelBooking(b.code, mum.phone)).ok).toBe(true);
    expect(await due()).toBe(20);
  });

  it("passes: one person's pass gives back that place's entries; a pass for the booking as a whole gives back nothing for one person", async () => {
    const mum = await adult("Mum");
    const kids = [await child(mum, "Jaz"), await child(mum, "Juli")];
    const own = (k: { id: number }) =>
      issuePass({ venueId: venue, name: "Swim", entries: 10, entryMinutes: 60, price: 100, holderName: mum.name, holderPhone: mum.phone, userId: mum.id, expiresOn: day(60), adminId: manager.id, scope: "participant", holderParticipantId: k.id });
    const pa = await own(kids[0]);
    const pb = await own(kids[1]);
    if (!pa.ok || !pb.ok) throw new Error("pass");
    const b = await book(mum, { courtId: pool, date: day(9), start: at(9), end: at(10), participantIds: kids.map((k) => k.id), payWithPasses: [pa.pass.code, pb.pass.code] });
    expect(b.paymentStatus).toBe("paid");
    expect(await withdrawPlace(b.id, { participantId: kids[0].id }, customer(mum))).toMatchObject({ ok: true, withdrawal: { units: 1, how: "pass", refund: 0 } });
    expect((await getPass(pa.pass.code))!.remaining).toBe(10);
    expect((await getPass(pb.pass.code))!.remaining).toBe(9);
    // Cancelled: Juli's back; Jaz's not twice.
    expect((await cancelBooking(b.code, mum.phone)).ok).toBe(true);
    expect((await getPass(pa.pass.code))!.remaining).toBe(10);
    expect((await getPass(pb.pass.code))!.remaining).toBe(10);

    const whole = await issuePass({ venueId: venue, name: "Ten", entries: 10, entryMinutes: 60, price: 100, holderName: mum.name, holderPhone: mum.phone, userId: mum.id, expiresOn: day(60), adminId: manager.id });
    if (!whole.ok) throw new Error(whole.error);
    const b2 = await book(mum, { courtId: pool, date: day(9), start: at(11), end: at(12), participantIds: kids.map((k) => k.id), payWithPass: whole.pass.code });
    expect(await withdrawPlace(b2.id, { participantId: kids[0].id }, customer(mum))).toMatchObject({ ok: true, withdrawal: { units: 0, refund: 0 } });
    expect((await getPass(whole.pass.code))!.remaining).toBe(9);
  });

  it("a child's own concession goes with their place, a sibling's stays", async () => {
    const mum = await adult("Mum");
    const kids = [await child(mum, "Kai"), await child(mum, "Kia")];
    const c = await saveConcession(venue, { name: "Child", percent: 50, proof: "their school card", scope: "participant" });
    if (!c.ok) throw new Error(c.error);
    const b = await book(mum, {
      courtId: pool,
      date: day(10),
      start: at(9),
      end: at(10),
      participantIds: kids.map((k) => k.id),
      placeConcessions: [{ participantId: kids[0].id, concessionId: c.concession.id }],
    });
    expect(b.totalPrice).toBe(15);
    // Kai's place cost RM5 with his concession: that comes off, and his concession goes with it.
    expect(await withdrawPlace(b.id, { participantId: kids[0].id }, customer(mum))).toMatchObject({ ok: true, withdrawal: { owedLess: 5 } });
    expect((await getBookingById(b.id))!.totalPrice).toBe(10);
    expect(await placeBenefitsFor(b.id)).toEqual([]);
  });
});

describe("what is not priced per person, and what cannot be split", () => {
  it("a player off a court hired whole: named no longer, the court booked and paid as it was, nothing refunded", async () => {
    const dad = await adult("Dad");
    const kids = [await child(dad, "Luqman"), await child(dad, "Lina")];
    await topUpWallet({ userId: dad.id, amount: 50, adminId: manager.id, venueId: venue });
    const b = await book(dad, { courtId: hall, date: day(11), start: at(9), end: at(10), participantIds: kids.map((k) => k.id), payFromWallet: true });
    const balance = await getWalletBalance(dad.id, venue);
    const claims = async () => Number(((await getDb().prepare("SELECT COUNT(*) AS n FROM claims WHERE booking_id = ? AND active").get(b.id)) as { n: number | string }).n);
    const held = await claims();
    expect(held).toBeGreaterThan(0);
    expect(await withdrawPlace(b.id, { participantId: kids[1].id }, customer(dad))).toMatchObject({ ok: true, withdrawal: { price: 0, refund: 0, released: 0, how: "none" } });
    expect((await getBookingById(b.id))!).toMatchObject({ status: "confirmed", totalPrice: 20, paymentStatus: "paid", participantName: "Luqman" });
    expect(await getWalletBalance(dad.id, venue)).toBe(balance);
    // The court is held as it was.
    expect(await claims()).toBe(held);
  });

  it("a player off a court priced per player: that player's price, the court still held", async () => {
    const dad = await adult("Dad");
    const kids = [await child(dad, "Mei"), await child(dad, "Ming"), await child(dad, "Moe")];
    const b = await book(dad, { courtId: pickle, date: day(11), start: at(9), end: at(10), participantIds: kids.map((k) => k.id) });
    expect(b.totalPrice).toBe(24);
    expect(await withdrawPlace(b.id, { participantId: kids[2].id }, customer(dad))).toMatchObject({ ok: true, withdrawal: { owedLess: 8, released: 0 } });
    expect((await getBookingById(b.id))!).toMatchObject({ totalPrice: 16, players: 2 });
  });

  it("refused, with the reason: the last person, a lesson, places sold together, somebody already at the door, past the cutoff", async () => {
    const mum = await adult("Mum");
    const kids = [await child(mum, "Nur"), await child(mum, "Nina")];
    const solo = await book(mum, { courtId: pool, date: day(12), start: at(9), end: at(10), participantIds: [kids[0].id] });
    expect(await withdrawPlace(solo.id, { participantId: kids[0].id }, customer(mum))).toMatchObject({ ok: false, code: "ENT_WITHDRAW_LAST", vars: { name: "Nur" } });
    // A lesson is booked as one.
    const hours = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: at(8), until: at(21) }));
    const coach = await saveCoach(venue, { name: "Coach Tan", sports: ["swimming"], rate: 30, hours });
    if (!coach.ok) throw new Error(coach.error);
    const lesson = await book(mum, { courtId: pool, date: day(12), start: at(11), end: at(12), participantIds: kids.map((k) => k.id), coachId: coach.coach.id });
    expect(await withdrawPlace(lesson.id, { participantId: kids[0].id }, customer(mum))).toMatchObject({ ok: false, code: "ENT_WITHDRAW_LESSON" });
    // Somebody already marked at the door.
    const both = await engine(mum, { date: day(12), start: at(13), end: at(14), participants: kids });
    if (!both.ok) throw new Error(both.error);
    const place = ((await getDb().prepare("SELECT id FROM booking_participants WHERE booking_id = ? AND participant_id = ?").get(both.bookings[0].id, kids[1].id)) as { id: number }).id;
    await getDb().prepare("INSERT INTO place_attendance (place_id, booking_id, no_show, recorded_by_name) VALUES (?, ?, true, 'Mira')").run(place, both.bookings[0].id);
    expect(await withdrawPlace(both.bookings[0].id, { participantId: kids[1].id }, customer(mum))).toMatchObject({ ok: false, code: "ENT_WITHDRAW_ATTENDED" });
    // The venue sells these places together.
    expect((await updatePolicy({ court: pool }, { separatePlaces: false })).ok).toBe(true);
    expect(await withdrawPlace(both.bookings[0].id, { participantId: kids[0].id }, customer(mum))).toMatchObject({ ok: false, code: "ENT_WITHDRAW_SOLD_WHOLE" });
    expect((await updatePolicy({ court: pool }, { separatePlaces: null })).ok).toBe(true);
    // Past the cutoff where the venue lets nobody cancel late.
    await setCancelPolicy(lateVenue, { lateKeep: null });
    const dad = await adult("Dad");
    const k2 = [await child(dad, "Omar"), await child(dad, "Ola")];
    const late = await book(dad, { courtId: latePool, date: day(1), start: at(19), end: at(20), participantIds: k2.map((k) => k.id) });
    expect(await withdrawPlace(late.id, { participantId: k2[0].id }, customer(dad))).toMatchObject({ ok: false, code: "ENT_WITHDRAW_CUTOFF", vars: { n: 48 } });
    await setCancelPolicy(lateVenue, { lateKeep: 50 });
    // The options say why too.
    const options = await withdrawOptions((await getBookingById(lesson.id))!, customer(mum));
    expect(options.every((o) => !o.allowed && o.refusal?.code === "ENT_WITHDRAW_LESSON")).toBe(true);
  });

  it("staff at the counter: by place, on the record with the reason", async () => {
    const mum = await adult("Mum");
    const kids = [await child(mum, "Pia"), await child(mum, "Puan")];
    const b = await book(mum, { courtId: pool, date: day(13), start: at(9), end: at(10), participantIds: kids.map((k) => k.id) });
    const opts = await staffWithdrawRoute.GET(req(`http://localhost/api/admin/bookings/withdraw?code=${b.code}`, "GET", manager.cookie));
    const { options } = (await opts.json()) as { options: { placeId: number; name: string; allowed: boolean }[] };
    expect(options.map((o) => [o.name, o.allowed])).toEqual([
      ["Pia", true],
      ["Puan", true],
    ]);
    const res = await staffWithdrawRoute.POST(req("http://localhost/api/admin/bookings/withdraw", "POST", manager.cookie, { code: b.code, placeId: options[0].placeId, reason: "Unwell" }));
    expect(res.status).toBe(200);
    const log = await listActivity([venue], { bookingCode: b.code });
    expect(log.some((e) => e.action === "booking.place_withdrawn" && /Pia taken off/.test(e.detail ?? "") && /Unwell/.test(e.detail ?? ""))).toBe(true);
    const row = (await getDb().prepare("SELECT by_kind, by_admin_id, reason FROM place_withdrawals WHERE booking_id = ?").get(b.id)) as Record<string, unknown>;
    expect(row).toEqual({ by_kind: "staff", by_admin_id: manager.id, reason: "Unwell" });
    // Another venue's staff: not theirs.
    const other = await createVenue({ name: "Elsewhere", area: "x", address: "x", phone: "0312350809", openMin: at(7), closeMin: at(23) });
    if (!other.ok) throw new Error("venue");
    const stranger = await createAdmin({ name: "Zed", email: `pw-zed${++n}@pw.test`, password: "a long enough password", venueId: other.venue.id, role: "manager" });
    if (!stranger.ok) throw new Error(stranger.error);
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(stranger.admin.id)).token}`;
    expect((await staffWithdrawRoute.POST(req("http://localhost/api/admin/bookings/withdraw", "POST", cookie, { code: b.code, placeId: options[1].placeId }))).status).toBe(403);
  });
});

const AT_ONCE = 4;

describe("at the same moment (real concurrency on Postgres)", () => {
  it("two children of a booking of two taken off at once: one goes, the other is the last and stays", async () => {
    const mum = await adult("Mum");
    const kids = [await child(mum, "Qi"), await child(mum, "Qu")];
    const b = await engine(mum, { date: day(14), participants: kids });
    if (!b.ok) throw new Error(b.error);
    const id = b.bookings[0].id;
    const results = await Promise.all(kids.map((k) => withdrawPlace(id, { participantId: k.id }, customer(mum))));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ code: "ENT_WITHDRAW_LAST" });
    expect(await placesHeld(id)).toBe(1);
    expect((await getBookingById(id))!.players).toBe(1);
  });

  it("the same child taken off twice at once, and a withdrawal racing the whole booking's cancellation: the money goes back once", async () => {
    const mum = await adult("Mum");
    const kids = [await child(mum, "Ria"), await child(mum, "Rin"), await child(mum, "Rio")];
    await topUpWallet({ userId: mum.id, amount: 100, adminId: manager.id, venueId: venue });
    const start = await getWalletBalance(mum.id, venue);
    const b = await book(mum, { courtId: pool, date: day(15), start: at(9), end: at(10), participantIds: kids.map((k) => k.id), payFromWallet: true });
    const twice = await Promise.all(Array.from({ length: AT_ONCE }, () => withdrawPlace(b.id, { participantId: kids[0].id }, customer(mum))));
    expect(twice.filter((r) => r.ok)).toHaveLength(1);
    expect(await getWalletBalance(mum.id, venue)).toBe(start - 20);
    const [w, c] = await Promise.all([withdrawPlace(b.id, { participantId: kids[1].id }, customer(mum)), adminCancelBooking(b.code)]);
    expect(c.ok || w.ok).toBe(true);
    // Whichever came first: everything paid is back, once.
    if (!c.ok) expect((await adminCancelBooking(b.code)).ok).toBe(true);
    expect(await getWalletBalance(mum.id, venue)).toBe(start);
  });

  it("a withdrawal freeing a place on a full session, while others try to book it: never more than there are", async () => {
    const date = day(16);
    const mum = await adult("Mum");
    const kids = [await child(mum, "Sam"), await child(mum, "Sara")];
    const crowd = await adult("Crowd");
    const full = await engine(crowd, { date, players: 2 });
    if (!full.ok) throw new Error(full.error);
    const fam = await engine(mum, { date, participants: kids });
    if (!fam.ok) throw new Error(fam.error);
    const others = await Promise.all(Array.from({ length: AT_ONCE }, (_, i) => adult(`Grab${i}`)));
    const [freed, ...grabs] = await Promise.all([
      withdrawPlace(fam.bookings[0].id, { participantId: kids[0].id }, customer(mum)),
      ...others.map((o) => engine(o, { date })),
    ]);
    expect(freed.ok).toBe(true);
    const held = Number(
      ((await getDb()
        .prepare("SELECT COALESCE(SUM(c.places), 0) AS n FROM claims c JOIN bookings b ON b.id = c.booking_id WHERE c.court_id = ? AND c.active AND b.date = ?")
        .get(pool, date)) as { n: number | string }).n
    );
    expect(held).toBeLessThanOrEqual(4);
    expect(held).toBe(3 + grabs.filter((g) => g.ok).length);
    expect(grabs.filter((g) => g.ok).length).toBeLessThanOrEqual(1);
  });
});

describe("a pass spent per place on a group", () => {
  it("a places pass: one place given up gives back one place's entries", async () => {
    const dad = await adult("Dad");
    const p = await issuePass({ venueId: venue, name: "Family", entries: 10, entryMinutes: 60, price: 100, holderName: dad.name, holderPhone: dad.phone, userId: dad.id, expiresOn: day(60), adminId: manager.id, scope: "places" });
    if (!p.ok) throw new Error(p.error);
    const made = await engine(dad, { date: day(17), players: 3 });
    if (!made.ok) throw new Error(made.error);
    expect((await payBookingWithPasses(made.bookings[0].id, [p.pass.code])).ok).toBe(true);
    expect((await getPass(p.pass.code))!.remaining).toBe(7);
    expect(await withdrawPlace(made.bookings[0].id, { unnamed: 1 }, customer(dad))).toMatchObject({ ok: true, withdrawal: { units: 1 } });
    expect((await getPass(p.pass.code))!.remaining).toBe(8);
    expect((await cancelBooking(made.bookings[0].code, dad.phone)).ok).toBe(true);
    expect((await getPass(p.pass.code))!.remaining).toBe(10);
  });
});
