import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { registerUser, type User } from "../src/lib/auth";
import { moveClasses } from "../src/lib/class-moves";
import { counterOwed, settleOwed, type CancellingStaff } from "../src/lib/counter-refunds";
import { getDb } from "../src/lib/db";
import { holdNewBookings, releaseExpiredHolds } from "../src/lib/holds";
import { createOutage } from "../src/lib/outages";
import { refundsOwed, savePaymentSettings, settleBill, startBookingPayment } from "../src/lib/payments";
import {
  adminCancelBooking,
  claimWaitlistOffer,
  closeVenueDay,
  createBooking,
  createClassSessions,
  createCourt,
  createVenue,
  enrolInClass,
  getClass,
  getClassRoster,
  getWalletBalance,
  joinSlotWaitlist,
  payBookingFromWallet,
  rescheduleBooking,
  setPaymentStatus,
  topUpWallet,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { POST as closeDayRoute } from "../src/app/api/admin/venues/[id]/closures/route";
import { createTeamLeague, enterTeam, generateFixtures, moveFixture, postponeLeagueDay, teamLeagueById, teamLeagueDetail, type TeamLeagueInput } from "../src/lib/team-leagues";
import { saveProfile } from "../src/lib/player-profiles";
import { createTournament, enter, makeDraw, moveMatch, postponeTournamentDay, tournamentDetail } from "../src/lib/tournaments";
import { acceptInvitation, createInviteLink, createTeam, teamView, type Team } from "../src/lib/teams";

/**
 * Cross-domain regression tests, closures and bookings: how the venue taking time away (a closed day, a court out of
 * service, a rain-out), a booking moved or part-refunded earlier, a class move, the waiting list, a team league and a
 * hold's sweep behave when they meet. Each test names the fixes it holds together. The scenarios the existing suites
 * already cover are listed in the report of the round (closure-races, venue-closures-first, rain-out-closes-first,
 * team-league-fixtures-lost, class-waitlist-closing, billplz-settlement); these are the interactions between them.
 *
 * Against stand-ins only: Billplz and Stripe are never called. The race tests are meant for real Postgres too
 * (TEST_DATABASE_URL), where requests really overlap.
 */

vi.setConfig({ testTimeout: 60_000 });

let venueId: number;
let dear: number; // RM60
let managerId: number;
let managerCookie: string;
let n = 0;
let slotN = 0;
const manager: CancellingStaff = { id: null, name: "Mira (manager)", role: "manager" };
const phone = () => `01866${String(10000 + ++n)}`;
/** Each booking its own day and hour so none clash. */
function slot() {
  const k = slotN++;
  return { date: addDays(todayISO(), 3 + Math.floor(k / 13)), hour: 8 + (k % 13) };
}

beforeAll(async () => {
  const made = await createVenue({ name: "Cross Closures", area: "PJ", address: "x", phone: "0300000073", openMin: 8 * 60, closeMin: 22 * 60 });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const first = await createCourt({ venueId, name: "Dear", sport: "badminton", offPeakRate: 60, peakRate: 60 });
  if (!first.ok) throw new Error("court");
  dear = first.court.id;
  const mgr = await createAdmin({ name: "Mira", email: "cd-mgr@cd.test", password: "a long enough password", venueId, role: "manager" });
  if (!mgr.ok) throw new Error(mgr.error);
  managerId = mgr.admin.id;
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(managerId)).token}`;
  await getDb().prepare("UPDATE venues SET book_ahead_days = 60 WHERE id = ?").run(venueId);
  const saved = await savePaymentSettings(venueId, { apiKey: "api-key-1234", collectionId: "colCD", xSignatureKey: "S-cd-key", sandbox: true, enabled: true });
  if (!saved.ok) throw new Error(saved.error);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A dear and a cheaper court of a test's own, so an outage on one never meets another test's bookings. */
async function pair() {
  const ids: number[] = [];
  for (const rate of [60, 25]) {
    const c = await createCourt({ venueId, name: `CD Pair ${++n}`, sport: "badminton", offPeakRate: rate, peakRate: rate });
    if (!c.ok) throw new Error("court");
    ids.push(c.court.id);
  }
  return { dear: ids[0], cheap: ids[1] };
}

/** A day of its own that a test may close: nothing else is ever booked on it. */
let closableN = 0;
const closableDayOffset = () => 22 + closableN++;
const closableDay = () => addDays(todayISO(), closableDayOffset());

async function book(over: { court?: number; userId?: number; phone?: string; closable?: boolean } = {}) {
  const s = over.closable ? { date: closableDay(), hour: 10 } : slot();
  const ph = over.phone ?? phone();
  const made = await createBooking({ courtId: over.court ?? dear, date: s.date, hours: [s.hour], name: "Aina", phone: ph, email: "aina@example.my", ...(over.userId ? { userId: over.userId } : {}) });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return { booking: made.booking, phone: ph, ...s };
}

const status = async (id: number) => ((await getDb().prepare("SELECT status FROM bookings WHERE id = ?").get(id)) as { status: string }).status;

function fakeBillplz() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const id = `cdbill${++n}`;
      return Response.json({ id, url: `https://www.billplz-sandbox.com/bills/${id}` });
    })
  );
}

async function paidOnline(court?: number) {
  const b = await book({ court });
  fakeBillplz();
  const started = await startBookingPayment({ codes: [b.booking.code], phone: b.phone });
  if (!started.ok) throw new Error(JSON.stringify(started));
  const row = (await getDb().prepare("SELECT id, bill_id FROM online_payments ORDER BY id DESC LIMIT 1").get()) as { id: number; bill_id: string };
  await settleBill({ billId: row.bill_id, paid: true, paidAt: null });
  vi.unstubAllGlobals();
  return { ...b, paymentId: row.id };
}

const payment = async (id: number) =>
  (await getDb().prepare("SELECT amount::float AS amount, refund_due::float AS due, refunded::float AS refunded FROM online_payments WHERE id = ?").get(id)) as { amount: number; due: number; refunded: number };

// ---------------------------------------------------------------------------------------------------------------------
describe("the venue takes the time away from a booking that a cheaper move already part-refunded (ADR 0053 + 0067)", () => {
  it("counter money: the move's difference and the outage's share add up to what was paid, never above it", async () => {
    const { dear, cheap } = await pair();
    const b = await book({ court: dear });
    expect(await setPaymentStatus(b.booking.code, true, "cash")).toMatchObject({ ok: true });
    expect(await rescheduleBooking(b.booking.code, { date: b.date, start: b.hour * 60, courtId: cheap }, "customer")).toMatchObject({ ok: true, money: { refund: { amount: 35, how: "counter" } } });
    const out = await createOutage({ courtId: cheap, startsOn: b.date, endsOn: b.date, reason: "Floor", adminId: managerId, cancelAffected: true });
    expect(out.ok).toBe(true);
    expect(await status(b.booking.id)).toBe("cancelled");
    const mine = (await counterOwed([venueId], "manager")).filter((o) => o.bookingCode === b.booking.code);
    expect(mine.map((o) => [o.cause, o.amount]).sort()).toEqual([["moved_cheaper", 35], ["outage", 25]].sort());
    expect(mine.reduce((s, o) => s + o.amount, 0)).toBe(60);
    // The outage's share is handed back once, as the 25 left and not the 60 paid; settling it again is refused.
    const share = mine.find((o) => o.cause === "outage")!;
    expect(await settleOwed(share.id, "back", manager)).toMatchObject({ ok: true, settled: { refund: 25, paidOut: { amount: 25, via: "cash" } } });
    expect(await settleOwed(share.id, "back", manager)).toMatchObject({ ok: false });
    const paidOut = (await getDb().prepare("SELECT COALESCE(SUM(amount), 0)::float AS s FROM counter_payouts WHERE booking_id = ?").get(b.booking.id)) as { s: number };
    expect(paidOut.s).toBe(25);
  });

  it("online money: the payment is owed 35 for the move and 25 for the outage, 60 in all, listed once as owed and never as refunded", async () => {
    const { dear, cheap } = await pair();
    const b = await paidOnline(dear);
    expect(await rescheduleBooking(b.booking.code, { date: b.date, start: b.hour * 60, courtId: cheap }, "customer")).toMatchObject({ ok: true, money: { refund: { amount: 35, how: "online" } } });
    const out = await createOutage({ courtId: cheap, startsOn: b.date, endsOn: b.date, adminId: managerId, cancelAffected: true });
    expect(out.ok).toBe(true);
    expect(await status(b.booking.id)).toBe("cancelled");
    // Billplz has no refund API: owed for staff, 60 of 60, none claimed as paid.
    expect(await payment(b.paymentId)).toEqual({ amount: 60, due: 60, refunded: 0 });
    expect((await refundsOwed(venueId)).filter((p) => p.id === b.paymentId)).toHaveLength(1);
  });

  it("stored credit: the move's credit and the outage's credit leave the customer where they started, once, with the outage racing a repeated sweep", async () => {
    const who = await registerUser({ name: `Credit ${++n}`, email: `cd${n}@cd.test`, phone: `0188${String(300000 + n)}`, password: "a long enough password" });
    if (!who.ok) throw new Error(who.error);
    await topUpWallet({ userId: who.user.id, amount: 100, adminId: managerId, venueId });
    const { dear, cheap } = await pair();
    const b = await book({ court: dear, userId: who.user.id, phone: who.user.phone });
    expect(await payBookingFromWallet(b.booking.id)).toMatchObject({ ok: true });
    expect(await getWalletBalance(who.user.id, venueId)).toBe(40);
    expect(await rescheduleBooking(b.booking.code, { date: b.date, start: b.hour * 60, courtId: cheap }, "customer")).toMatchObject({ ok: true, money: { refund: { amount: 35, how: "credit" } } });
    expect(await getWalletBalance(who.user.id, venueId)).toBe(75);
    const same = { courtId: cheap, startsOn: b.date, endsOn: b.date, adminId: managerId, cancelAffected: true };
    await Promise.all([createOutage(same), createOutage(same)]);
    expect(await status(b.booking.id)).toBe("cancelled");
    expect(await getWalletBalance(who.user.id, venueId)).toBe(100);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("a class moved onto a day the venue closes (ADR 0053 + 0069 B14 + 0043)", () => {
  async function aClass(daysAhead: number, capacity = 6) {
    const gym = await createCourt({ venueId, name: `CD Studio ${++n}`, sport: "gym", offPeakRate: 5, peakRate: 8, capacity: 20 });
    if (!gym.ok) throw new Error("studio");
    const made = await createClassSessions({ courtId: gym.court.id, name: `CD Pilates ${n}`, instructor: "Aina", date: addDays(todayISO(), daysAhead), startHour: 18, endHour: 19, capacity, price: 20 });
    if (!made.ok) throw new Error(made.error);
    return made.classes[0];
  }
  const admin = { id: null as number | null, name: "Mona" };

  it("is refused on a closed day, nothing changed: the class, its enrolments and its place stay", async () => {
    const cl = await aClass(closableDayOffset());
    const e = await enrolInClass({ classId: cl.id, name: "Mei", phone: phone() });
    if (!e.ok) throw new Error(e.error);
    const target = closableDay();
    expect((await closeVenueDay(venueId, target, "Holiday")).ok).toBe(true);
    const moved = await moveClasses(admin, cl.id, { date: target, start: 18 * 60 });
    expect(moved.ok).toBe(false);
    expect(await getClass(cl.id)).toMatchObject({ date: cl.date, status: "scheduled" });
    expect((await getClassRoster(cl.id)).map((r) => r.status)).toEqual(["confirmed"]);
  });

  it("a move and the closing of its target day at once: never a scheduled class with confirmed places on a closed day", async () => {
    let stray = 0;
    for (let round = 0; round < 5; round++) {
      const cl = await aClass(closableDayOffset());
      for (let i = 0; i < 2; i++) await enrolInClass({ classId: cl.id, name: `Early ${i}`, phone: phone() });
      const target = closableDay();
      const req = () =>
        closeDayRoute(
          new NextRequest(`http://localhost/api/admin/venues/${venueId}/closures`, {
            method: "POST",
            headers: { cookie: managerCookie, "content-type": "application/json", "x-forwarded-for": "10.7.7.8" },
            body: JSON.stringify({ date: target, reason: "Flood", cancelAffected: true }),
          }),
          { params: Promise.resolve({ id: String(venueId) }) }
        );
      await Promise.all([moveClasses(admin, cl.id, { date: target, start: 18 * 60 }), req()]);
      const closed = await getDb().prepare("SELECT 1 FROM venue_closures WHERE venue_id = ? AND date = ?").get(venueId, target);
      const after = (await getClass(cl.id))!;
      const roster = await getClassRoster(cl.id);
      // Closed day: the class is either left on its old day, or on the closed day and called off with nobody confirmed.
      if (closed && after.date === target && (after.status === "scheduled" || roster.some((r) => r.status === "confirmed"))) stray++;
    }
    expect(stray).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("waiting-list entries on a day the venue closes (ADR 0053 + 0060)", () => {
  it("a join for a closed day is refused; an entry made before stays waiting and a later cancellation offers it nothing", async () => {
    const b = await book({ closable: true });
    const waiter = phone();
    expect((await joinSlotWaitlist({ courtId: dear, date: b.date, startHour: b.hour, endHour: b.hour + 1, name: "Waiter", phone: waiter })).ok).toBe(true);
    // Closed over the booking without cancelling it (the venue will cancel by hand), then the booking is cancelled.
    expect((await closeVenueDay(venueId, b.date, "Power cut")).ok).toBe(true);
    const late = await joinSlotWaitlist({ courtId: dear, date: b.date, startHour: b.hour + 2, endHour: b.hour + 3, name: "Late", phone: phone() });
    expect(late.ok).toBe(false);
    expect((await adminCancelBooking(b.booking.code)).ok).toBe(true);
    const w = (await getDb().prepare("SELECT status, offer_token FROM waitlist WHERE phone = ?").get(waiter)) as { status: string; offer_token: string | null };
    expect(w.status).toBe("waiting");
    expect(w.offer_token).toBeNull();
    expect(await getDb().prepare("SELECT 1 FROM claims WHERE court_id = ? AND kind = 'offer' AND active").get(dear)).toBeUndefined();
  });

  it("an offer claimed at the moment the day is closed ends as a booking that is then called off by the closure, or as nothing: never confirmed on the closed day", async () => {
    let strays = 0;
    for (let round = 0; round < 5; round++) {
      const b = await book({ closable: true });
      const waiter = phone();
      await joinSlotWaitlist({ courtId: dear, date: b.date, startHour: b.hour, endHour: b.hour + 1, name: "Waiter", phone: waiter });
      await adminCancelBooking(b.booking.code);
      const offer = (await getDb().prepare("SELECT offer_token FROM waitlist WHERE phone = ?").get(waiter)) as { offer_token: string };
      const req = new NextRequest(`http://localhost/api/admin/venues/${venueId}/closures`, {
        method: "POST",
        headers: { cookie: managerCookie, "content-type": "application/json", "x-forwarded-for": "10.7.7.9" },
        body: JSON.stringify({ date: b.date, reason: "Storm", cancelAffected: true }),
      });
      await Promise.all([claimWaitlistOffer(offer.offer_token), closeDayRoute(req, { params: Promise.resolve({ id: String(venueId) }) })]);
      const standing = (await getDb()
        .prepare("SELECT COUNT(*)::int AS n FROM bookings bk JOIN courts c ON c.id = bk.court_id WHERE c.venue_id = ? AND bk.date = ? AND bk.status = 'confirmed'")
        .get(venueId, b.date)) as { n: number };
      const closed = await getDb().prepare("SELECT 1 FROM venue_closures WHERE venue_id = ? AND date = ?").get(venueId, b.date);
      if (closed && standing.n > 0) strays++;
    }
    expect(strays).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("a hold made and released around the scheduler's sweep (ADR 0054 + 0065 + 0060)", () => {
  /** The venue holds for payment; this booking's hold has run out, as at the moment of the sweep. */
  async function lapsed() {
    const b = await book();
    await holdNewBookings([b.booking.id], 15);
    await getDb().prepare("UPDATE bookings SET hold_until = datetime('now', '-1 minutes') WHERE id = ?").run(b.booking.id);
    return b;
  }

  it("two sweeps at once let the booking go once, and offer the place to the waiter once", async () => {
    const b = await lapsed();
    const waiter = phone();
    expect((await joinSlotWaitlist({ courtId: dear, date: b.date, startHour: b.hour, endHour: b.hour + 1, name: "Waiter", phone: waiter })).ok).toBe(true);
    const counts = await Promise.all([releaseExpiredHolds(), releaseExpiredHolds(), releaseExpiredHolds()]);
    expect(counts.reduce((s, c) => s + c, 0)).toBe(1);
    expect(await status(b.booking.id)).toBe("cancelled");
    const w = (await getDb().prepare("SELECT status FROM waitlist WHERE phone = ?").get(waiter)) as { status: string };
    expect(w.status).toBe("offered");
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM claims WHERE court_id = ? AND kind = 'offer' AND active").get(dear)) as { n: number }).n).toBe(1);
    // A sweep run again changes nothing.
    expect(await releaseExpiredHolds()).toBe(0);
  });

  it("a payment arriving as the sweep runs ends paid and held no longer, or let go and owed back: never both, never lost", async () => {
    let paidEnd = 0;
    let lapsedEnd = 0;
    for (let round = 0; round < 6; round++) {
      const b = await book();
      await holdNewBookings([b.booking.id], 15);
      fakeBillplz();
      const started = await startBookingPayment({ codes: [b.booking.code], phone: b.phone });
      if (!started.ok) throw new Error(JSON.stringify(started));
      const row = (await getDb().prepare("SELECT id, bill_id FROM online_payments ORDER BY id DESC LIMIT 1").get()) as { id: number; bill_id: string };
      vi.unstubAllGlobals();
      await getDb().prepare("UPDATE bookings SET hold_until = datetime('now', '-1 minutes') WHERE id = ?").run(b.booking.id);
      await Promise.all([settleBill({ billId: row.bill_id, paid: true, paidAt: null }), releaseExpiredHolds()]);
      const bk = (await getDb().prepare("SELECT status, payment_status FROM bookings WHERE id = ?").get(b.booking.id)) as { status: string; payment_status: string };
      const p = await payment(row.id);
      if (bk.status === "confirmed" && bk.payment_status === "paid") {
        paidEnd++;
        expect(p.due).toBe(0);
      } else {
        lapsedEnd++;
        expect(bk).toEqual({ status: "cancelled", payment_status: "unpaid" });
        // The money is owed back whole, never lost.
        expect(p.due).toBe(p.amount);
        expect(p.amount).toBe(60);
      }
      // Whatever the order, nobody holds the slot twice.
      const live = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM claims WHERE booking_id = ? AND active").get(b.booking.id)) as { n: number };
      expect(live.n).toBe(bk.status === "confirmed" ? 1 : 0);
    }
    expect(paidEnd + lapsedEnd).toBe(6);
  });

  it("a new customer taking the slot while the sweep lets the old hold go: one confirmed booking at most, and the waiter's offer never double-books it", async () => {
    let doubles = 0;
    for (let round = 0; round < 6; round++) {
      const b = await lapsed();
      const waiter = phone();
      await joinSlotWaitlist({ courtId: dear, date: b.date, startHour: b.hour, endHour: b.hour + 1, name: "Waiter", phone: waiter });
      await Promise.all([
        releaseExpiredHolds(),
        createBooking({ courtId: dear, date: b.date, hours: [b.hour], name: "Stranger", phone: phone() }),
        releaseExpiredHolds(),
      ]);
      const confirmed = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE court_id = ? AND date = ? AND start_min = ? AND status = 'confirmed'").get(dear, b.date, b.hour * 60)) as { n: number };
      const live = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM claims WHERE court_id = ? AND active AND kind IN ('booking', 'offer') AND booking_id IN (SELECT id FROM bookings WHERE date = ? AND start_min = ?)").get(dear, b.date, b.hour * 60)) as { n: number };
      if (confirmed.n > 1 || live.n > 1) doubles++;
    }
    expect(doubles).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("a team league's postponement meets the court's other uses (ADR 0059 + 0053)", () => {
  let ownerId: number;
  let leagueCourts: number[];
  let pn = 0;

  async function adult(): Promise<User> {
    pn++;
    const made = await registerUser({ name: `Player ${pn}`, email: `cdl${pn}@leagues.test`, phone: `01391${String(pn).padStart(5, "0")}`, password: "a long enough password" });
    if (!made.ok) throw new Error(made.error);
    await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now'), verified_phone = phone WHERE id = ?").run(made.user.id);
    await saveProfile(made.user.id, { adult: true });
    return made.user;
  }
  async function side(label: string) {
    const captain = await adult();
    pn++;
    const t = await createTeam(captain.id, { name: `${label} ${pn}`, sport: "badminton" });
    if (!t.ok) throw new Error(t.error);
    const team: Team = t.value;
    for (let i = 1; i < 3; i++) {
      const p = await adult();
      const link = await createInviteLink(captain.id, team.id);
      if (!link.ok) throw new Error(link.error);
      const done = await acceptInvitation(p, new URL(link.value.link).searchParams.get("token"), {});
      if (!done.ok) throw new Error(done.error);
    }
    const view = (await teamView(team.id, captain.id))!;
    return { captain, team, members: view.roster!.map((m) => m.id) };
  }
  /** Each league has two courts of its own, so what one holds another never finds taken. */
  async function aLeague(first?: string) {
    pn++;
    leagueCourts = [];
    for (let i = 0; i < 2; i++) {
      const c = await createCourt({ venueId, name: `CD League Court ${pn}-${i}`, sport: "badminton", offPeakRate: 10, peakRate: 12 });
      if (!c.ok) throw new Error(c.error);
      leagueCourts.push(c.court.id);
    }
    const startsOn = first ?? addDays(todayISO(), 4);
    const made = await createTeamLeague({ venueId, name: `CD League ${pn}`, sport: "badminton", startsOn, endsOn: addDays(startsOn, 40), courtIds: leagueCourts } as TeamLeagueInput, ownerId);
    if (!made.ok) throw new Error(made.error);
    for (let i = 0; i < 2; i++) {
      const s = await side(`T${i + 1}`);
      const done = await enterTeam(s.captain.id, made.value.id, { teamId: s.team.id, memberIds: s.members });
      if (!done.ok) throw new Error(done.error);
    }
    const nights = [0, 1, 2].map((i) => ({ date: addDays(startsOn, i * 7), startMin: 9 * 60 }));
    const gen = await generateFixtures(made.value.id, nights);
    if (!gen.ok) throw new Error(gen.error);
    return (await teamLeagueById(made.value.id))!;
  }
  const scheduledOn = async (leagueId: number, date: string) =>
    (await getDb().prepare("SELECT id, court_id, start_min FROM team_fixtures WHERE league_id = ? AND date = ? AND status = 'scheduled' ORDER BY id").all(leagueId, date)) as { id: number; court_id: number; start_min: number }[];

  beforeAll(async () => {
    ownerId = managerId;
  });

  it("onto a day the venue has closed: no fixture is moved, each is answered with why, and every one stays where it was", async () => {
    const l = await aLeague(closableDay());
    const nights = (await teamLeagueDetail(l.id, { forStaff: true }))!.nights;
    const from = nights[0].date;
    const to = closableDay();
    const before = await scheduledOn(l.id, from);
    expect(before.length).toBeGreaterThan(0);
    expect((await closeVenueDay(venueId, to, "Holiday")).ok).toBe(true);
    const done = await postponeLeagueDay(l.id, from, to);
    if (!done.ok) throw new Error(done.error);
    expect(done.value.moved).toBe(0);
    expect(done.value.left).toHaveLength(before.length);
    expect(await scheduledOn(l.id, from)).toEqual(before);
    expect(await scheduledOn(l.id, to)).toEqual([]);
    // By hand too: the same refusal, with its own words in every language.
    expect(await moveFixture(before[0].id, { date: to, startMin: before[0].start_min })).toMatchObject({ ok: false, code: "TL_MOVE_CLOSED" });
  });

  it("onto a court out of service: that court is not used, the fixture goes to the league's other court if it is free, or stays and says why", async () => {
    const l = await aLeague();
    const nights = (await teamLeagueDetail(l.id, { forStaff: true }))!.nights;
    const from = nights[0].date;
    const to = addDays(from, 2);
    const before = await scheduledOn(l.id, from);
    // Both courts out on the target day: nothing can be placed.
    for (const c of leagueCourts) expect((await createOutage({ courtId: c, startsOn: to, endsOn: to, adminId: ownerId })).ok).toBe(true);
    const done = await postponeLeagueDay(l.id, from, to);
    if (!done.ok) throw new Error(done.error);
    expect(done.value.moved).toBe(0);
    expect(done.value.left).toHaveLength(before.length);
    expect(await scheduledOn(l.id, from)).toEqual(before);
  });

  it("a customer booking the target time as the night is postponed: the court time is the fixture's or the booking's, never both", async () => {
    let doubles = 0;
    for (let round = 0; round < 5; round++) {
      const l = await aLeague();
      const nights = (await teamLeagueDetail(l.id, { forStaff: true }))!.nights;
      const from = nights[0].date;
      const to = addDays(from, 2);
      await Promise.all([
        postponeLeagueDay(l.id, from, to),
        ...leagueCourts.map((c) => createBooking({ courtId: c, date: to, hours: [9], name: "Walk-in", phone: phone() })),
      ]);
      for (const c of leagueCourts) {
        const booked = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE court_id = ? AND date = ? AND start_min = ? AND status = 'confirmed'").get(c, to, 9 * 60)) as { n: number };
        const fixtures = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM team_fixtures WHERE court_id = ? AND date = ? AND start_min = ? AND status = 'scheduled'").get(c, to, 9 * 60)) as { n: number };
        if (booked.n + fixtures.n > 1) doubles++;
      }
    }
    expect(doubles).toBe(0);
  });
});

describe("a tournament's matches moved onto a day the venue has closed (ADR 0059 + 0053)", () => {
  async function drawnCup(startDay: string) {
    const cs: number[] = [];
    for (let i = 0; i < 2; i++) {
      const c = await createCourt({ venueId, name: `CD Cup Court ${++n}`, sport: "badminton", offPeakRate: 10, peakRate: 12 });
      if (!c.ok) throw new Error(c.error);
      cs.push(c.court.id);
    }
    const made = await createTournament(
      { venueId, name: `CD Cup ${n}`, sport: "badminton", format: "knockout", teamSize: 1, level: null, entryFee: 0, maxEntries: 8, startsOn: startDay, endsOn: startDay, startHour: 9, endHour: 12, courtIds: cs },
      managerId
    );
    if (!made.ok) throw new Error(made.error);
    for (let i = 0; i < 4; i++) {
      const p = await registerUser({ name: `Cup Player ${++n}`, email: `cdcup${n}@cup.my`, phone: `01341${String(n).padStart(5, "0")}`, password: "a long enough password" });
      if (!p.ok) throw new Error(p.error);
      const e = await enter(p.user, made.value.id);
      if (!e.ok) throw new Error(e.error);
    }
    const drawn = await makeDraw(made.value.id, () => 0.42);
    if (!drawn.ok) throw new Error(drawn.error);
    return made.value;
  }
  const pending = async (id: number) => (await tournamentDetail(id))!.matches.filter((m) => m.status === "scheduled");

  it("a postponed day is refused when the target day is closed: nothing moves, nothing is held there", async () => {
    const t = await drawnCup(closableDay());
    const before = await pending(t.id);
    const to = closableDay();
    expect((await closeVenueDay(venueId, to, "Holiday")).ok).toBe(true);
    const moved = await postponeTournamentDay(t.id, t.startsOn, to);
    expect(moved).toMatchObject({ ok: false, error: expect.stringContaining("closed") });
    expect((await pending(t.id)).map((m) => [m.id, m.date, m.minute, m.courtId])).toEqual(before.map((m) => [m.id, m.date, m.minute, m.courtId]));
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM blocks WHERE tournament_id = ? AND date = ?").get(t.id, to)) as { n: number }).n).toBe(0);
    // An open day is still fine.
    expect((await postponeTournamentDay(t.id, t.startsOn, closableDay())).ok).toBe(true);
  });

  it("one match moved by hand to a closed day is refused, nothing changed", async () => {
    const t = await drawnCup(closableDay());
    const first = (await pending(t.id))[0];
    const closed = closableDay();
    expect((await closeVenueDay(venueId, closed, "Holiday")).ok).toBe(true);
    expect(await moveMatch(first.id, { date: closed, startMin: 9 * 60, courtId: first.courtId! })).toMatchObject({ ok: false, error: expect.stringContaining("closed") });
    expect((await tournamentDetail(t.id))!.matches.find((m) => m.id === first.id)).toMatchObject({ date: t.startsOn });
  });
});
