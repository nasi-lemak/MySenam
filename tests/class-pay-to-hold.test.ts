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
import { getDb } from "../src/lib/db";
import { extendHolds, holdNewBookings, releaseExpiredHolds, setHoldPolicy } from "../src/lib/holds";
import { instantOf, minuteOfDay } from "../src/lib/interval";
import { addManaged } from "../src/lib/managed-people";
import { savePaymentSettings, settleBill, startBookingPayment } from "../src/lib/payments";
import {
  claimWaitlistOffer,
  createClassSessions,
  createCourt,
  createVenue,
  enrolPeople,
  findBooking,
  getClass,
  joinClassWaitlist,
  listClassWaitlist,
  listWaitlistFor,
  topUpWallet,
  venueHours,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import * as enrolRoute from "../src/app/api/classes/enrol/route";
import * as claimRoute from "../src/app/api/waitlist/claim/route";

/**
 * Pay to hold, for class places (ADR 0070, DEC-11): a venue that asks for payment online to hold what is booked holds a
 * class enrolment made online and still to pay, as it holds a court and as it already held a place claimed from a
 * waiting list. Paid, it stands; not paid in time, it is let go and the place offered to the class's waiting list; a
 * payment that comes after is owed back (the booking's own late-payment path). Run on PGlite and on Postgres
 * (TEST_DATABASE_URL): the races hold on both.
 */

const ZONE = "Asia/Kuala_Lumpur";
let n = 0;
const phone = () => `0166${String(++n).padStart(7, "0")}`;
const day = (k: number) => addDays(todayISO(ZONE), k);

let venueId: number;
let deskCookie: string;
let deskId: number;
let bill = 0;

const req = (body: unknown, cookie?: string) =>
  new NextRequest("http://localhost/api/classes/enrol", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.66.${++n % 250}.${n % 200}`, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

type Enrolled = {
  status: number;
  body: { booking?: { id: number; code: string; holdUntil?: string | null; paymentStatus: string }; bookings?: { id: number; code: string; holdUntil?: string | null; paymentStatus: string }[]; holdUntil?: string | null; timeZone?: string | null; code?: string; error?: string; walletError?: string | null; seriesCode?: string };
};

async function enrol(classId: number, who: { name?: string; phone?: string } = {}, extra: Record<string, unknown> = {}, cookie?: string): Promise<Enrolled & { phone: string }> {
  const ph = who.phone ?? phone();
  const res = await enrolRoute.POST(req({ classId, name: who.name ?? "Hafiz", phone: ph, email: `g${ph}@cph.test`, ...extra }, cookie));
  return { status: res.status, body: await res.json(), phone: ph };
}

/** A class on a studio of its own (a class holds its court whole), `k` days ahead. */
async function aClass(capacity: number, k: number, weeks = 1, startHour = 17) {
  const studio = await createCourt({ venueId, name: `Studio ${++n}`, sport: "gym", offPeakRate: 5, peakRate: 8, capacity: 40 });
  if (!studio.ok) throw new Error(studio.error);
  const courtId = studio.court.id;
  const made = await createClassSessions({ courtId, name: `Hold Spin ${++n}`, instructor: "Coach Ravi", date: day(k), startHour, endHour: startHour + 1, capacity, price: 30, weeks });
  if (!made.ok) throw new Error(made.error);
  return made.classes;
}

function fakeBillplz() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const id = `classholdbill${++bill}`;
      return Response.json({ id, url: `https://www.billplz-sandbox.com/bills/${id}` });
    })
  );
}
const lastBill = async () => ((await getDb().prepare("SELECT bill_id FROM online_payments ORDER BY id DESC LIMIT 1").get()) as { bill_id: string }).bill_id;
const expire = (...ids: number[]) =>
  getDb().prepare(`UPDATE bookings SET hold_until = datetime('now', '-1 minutes') WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
const row = async (id: number) =>
  (await getDb().prepare("SELECT status, payment_status, hold_until, released_unpaid FROM bookings WHERE id = ?").get(id)) as {
    status: string;
    payment_status: string;
    hold_until: string | null;
    released_unpaid: number | boolean;
  };
const kinds = async (bookingId: number) =>
  ((await getDb().prepare("SELECT kind FROM messages WHERE booking_id = ?").all(bookingId)) as { kind: string }[]).map((m) => m.kind);
const enrolled = async (classId: number) => (await getClass(classId))!.enrolled;

async function adult(name: string) {
  const ph = phone();
  const made = await registerUser({ name: `${name} ${++n}`, email: `cph${n}@cph.test`, phone: ph, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now'), verified_phone = phone WHERE id = ?").run(made.user.id);
  return { ...made.user, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}

beforeAll(async () => {
  const v = await createVenue({ name: "Hold Studio", area: "Bangsar", address: "x", phone: "0312340001", openMin: 7 * 60, closeMin: 23 * 60 });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  await getDb().prepare("UPDATE venues SET published_at = datetime('now') WHERE id = ?").run(venueId);
  const saved = await savePaymentSettings(venueId, { apiKey: "api-key-1234", collectionId: "col123", xSignatureKey: "S-key", sandbox: true, enabled: true });
  if (!saved.ok) throw new Error(saved.error);
  const desk = await createAdmin({ name: "Hold Desk", email: "holddesk@cph.test", password: "a long enough password", venueId, role: "manager" });
  if (!desk.ok) throw new Error(desk.error);
  deskId = desk.admin.id;
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
  expect((await setHoldPolicy(venueId, { on: true, minutes: 10 })).ok).toBe(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("a class enrolment online at a venue that holds for payment", () => {
  it("is held for the venue's minutes, counts as a place, and says nothing until it is paid", async () => {
    const [cls] = await aClass(5, 6);
    const r = await enrol(cls.id);
    expect(r.status).toBe(201);
    expect(r.body.holdUntil).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(r.body.booking!.holdUntil).toBe(r.body.holdUntil);
    expect(r.body.timeZone).toBe(ZONE);
    expect((await row(r.body.booking!.id)).hold_until).toBe(r.body.holdUntil);
    // The place is taken while it is held.
    expect(await enrolled(cls.id)).toBe(1);
    // Nobody is told it is theirs yet.
    expect(await kinds(r.body.booking!.id)).not.toContain("class_enrolled");
    expect(await kinds(r.body.booking!.id)).not.toContain("booking_confirmed");
  });

  it("stands once paid, is confirmed, and is never let go afterwards", async () => {
    const [cls] = await aClass(5, 6);
    const r = await enrol(cls.id);
    const b = r.body.booking!;
    fakeBillplz();
    expect((await startBookingPayment({ codes: [b.code], phone: r.phone })).ok).toBe(true);
    const bill1 = await lastBill();
    expect((await settleBill({ billId: bill1, paid: true, paidAt: null }))?.newlyPaid.map((x) => x.id)).toEqual([b.id]);
    // The callback again, and the return page: nothing twice.
    expect((await settleBill({ billId: bill1, paid: true, paidAt: null }))?.newlyPaid).toEqual([]);
    expect(await row(b.id)).toMatchObject({ status: "confirmed", payment_status: "paid", hold_until: null });
    expect(await kinds(b.id)).toContain("booking_confirmed");
    await getDb().prepare("UPDATE bookings SET hold_until = datetime('now', '-1 minutes') WHERE id = ?").run(b.id);
    await releaseExpiredHolds();
    expect(await row(b.id)).toMatchObject({ status: "confirmed", payment_status: "paid" });
    expect(await enrolled(cls.id)).toBe(1);
  });

  it("not paid in time is let go, once, and the place is offered to the class's waiting list", async () => {
    const [cls] = await aClass(1, 7);
    const held = await enrol(cls.id);
    expect(await enrolled(cls.id)).toBe(1);
    // The class is full: the next person waits.
    const waiter = phone();
    expect(await joinClassWaitlist({ classId: cls.id, name: "Waiter", phone: waiter })).toMatchObject({ ok: true });
    expect((await enrol(cls.id)).status).toBe(409);

    await expire(held.body.booking!.id);
    expect(await releaseExpiredHolds()).toBeGreaterThanOrEqual(1);
    expect(await row(held.body.booking!.id)).toMatchObject({ status: "cancelled" });
    expect(Number((await row(held.body.booking!.id)).released_unpaid)).toBe(1);
    expect(await enrolled(cls.id)).toBe(0);
    // No active claim is left by the enrolment.
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM claims WHERE booking_id = ? AND active").get(held.body.booking!.id)) as { n: number }).n).toBe(0);
    // The freed place went to the class's list, as a class place (not as court time).
    expect((await listWaitlistFor(waiter))[0]).toMatchObject({ status: "offered" });
    // Run again, or twice at once: nothing more is let go and nothing is offered twice.
    expect(await releaseExpiredHolds()).toBe(0);
    await Promise.all([releaseExpiredHolds(), releaseExpiredHolds()]);
    expect((await listClassWaitlist(cls.id)).filter((e) => e.status === "offered")).toHaveLength(1);
  });

  it("is not held when the venue does not hold, when it is paid from credit, or when it is free", async () => {
    // Paid at once from the account's credit: nothing to hold.
    const [cls] = await aClass(5, 8);
    const mum = await adult("Mum");
    await topUpWallet({ userId: mum.id, amount: 100, adminId: deskId, venueId });
    const paid = await enrol(cls.id, { name: mum.name, phone: mum.phone }, { payFromWallet: true }, mum.cookie);
    expect(paid.status).toBe(201);
    expect(paid.body.holdUntil ?? null).toBeNull();
    expect(paid.body.booking).toMatchObject({ paymentStatus: "paid" });
    expect(await kinds(paid.body.booking!.id)).toContain("class_enrolled");

    // A venue not asking for it: as before, on trust.
    expect((await setHoldPolicy(venueId, { on: false })).ok).toBe(true);
    const off = await enrol(cls.id);
    expect(off.status).toBe(201);
    expect(off.body.holdUntil ?? null).toBeNull();
    expect((await row(off.body.booking!.id)).hold_until).toBeNull();
    expect(await kinds(off.body.booking!.id)).toContain("class_enrolled");
    expect((await setHoldPolicy(venueId, { on: true, minutes: 10 })).ok).toBe(true);
  });

  it("is not held at the counter: staff enrol paid as it is made, or on the venue's word to pay later", async () => {
    const [cls] = await aClass(5, 9);
    const later = await enrol(cls.id, { name: "Puan Siti" }, {}, deskCookie);
    expect(later.status).toBe(201);
    expect(later.body.holdUntil ?? null).toBeNull();
    expect(await row(later.body.booking!.id)).toMatchObject({ status: "confirmed", payment_status: "unpaid", hold_until: null });
    expect(await kinds(later.body.booking!.id)).toContain("class_enrolled");
    const now = await enrol(cls.id, { name: "Encik Lee" }, { paidAtCounter: "cash" }, deskCookie);
    expect(now.status).toBe(201);
    expect(now.body.booking).toMatchObject({ paymentStatus: "paid" });
    expect((await row(now.body.booking!.id)).hold_until).toBeNull();
    // A hold sweep never lets a counter enrolment go.
    await releaseExpiredHolds();
    expect((await row(later.body.booking!.id)).status).toBe("confirmed");
  });
});

describe("every way of enrolling is held the same way", () => {
  it("a family: each child's enrolment held, paid in one bill, or let go together", async () => {
    const [cls] = await aClass(6, 10);
    const mum = await adult("Mum");
    const a = await addManaged(mum.id, { displayName: "Alya", relationship: "parent", authority: true }, mum.name);
    const b = await addManaged(mum.id, { displayName: "Bilal", relationship: "parent", authority: true }, mum.name);
    if (!a.ok || !b.ok) throw new Error("children");
    const r = await enrol(cls.id, { name: mum.name, phone: mum.phone }, { participantIds: [a.person.id, b.person.id] }, mum.cookie);
    expect(r.status).toBe(201);
    expect(r.body.bookings).toHaveLength(2);
    for (const x of r.body.bookings!) expect((await row(x.id)).hold_until).not.toBeNull();
    expect(await enrolled(cls.id)).toBe(2);
    expect(r.body.holdUntil).not.toBeNull();

    fakeBillplz();
    expect((await startBookingPayment({ codes: r.body.bookings!.map((x) => x.code), phone: mum.phone })).ok).toBe(true);
    const paidBill = await lastBill();
    expect((await settleBill({ billId: paidBill, paid: true, paidAt: null }))?.newlyPaid.map((x) => x.id).sort()).toEqual(r.body.bookings!.map((x) => x.id).sort());
    for (const x of r.body.bookings!) expect(await row(x.id)).toMatchObject({ payment_status: "paid", hold_until: null });

    // Another family not paying: both places let go together.
    const dad = await adult("Dad");
    const c = await addManaged(dad.id, { displayName: "Chen", relationship: "parent", authority: true }, dad.name);
    const d = await addManaged(dad.id, { displayName: "Dina", relationship: "parent", authority: true }, dad.name);
    if (!c.ok || !d.ok) throw new Error("children");
    const r2 = await enrol(cls.id, { name: dad.name, phone: dad.phone }, { participantIds: [c.person.id, d.person.id] }, dad.cookie);
    expect(r2.status).toBe(201);
    expect(await enrolled(cls.id)).toBe(4);
    await expire(...r2.body.bookings!.map((x) => x.id));
    await releaseExpiredHolds();
    for (const x of r2.body.bookings!) expect(await row(x.id)).toMatchObject({ status: "cancelled" });
    expect(await enrolled(cls.id)).toBe(2);
  });

  it("a term: every session's place held, paid in one bill; unpaid, every session's place let go and offered", async () => {
    const sessions = await aClass(3, 11, 3);
    const r = await enrol(sessions[0].id, {}, { term: true });
    expect(r.status).toBe(201);
    expect(r.body.bookings).toHaveLength(3);
    expect(r.body.holdUntil).not.toBeNull();
    for (const x of r.body.bookings!) expect((await row(x.id)).hold_until).not.toBeNull();
    for (const s of sessions) expect(await enrolled(s.id)).toBe(1);
    expect(await kinds(r.body.bookings![0].id)).not.toContain("booking_series_confirmed");

    fakeBillplz();
    expect((await startBookingPayment({ codes: r.body.bookings!.map((x) => x.code), phone: r.phone })).ok).toBe(true);
    await settleBill({ billId: await lastBill(), paid: true, paidAt: null });
    for (const x of r.body.bookings!) expect(await row(x.id)).toMatchObject({ payment_status: "paid", hold_until: null });
    // One confirmation for the whole term, once it is paid.
    const told = (await Promise.all(r.body.bookings!.map((x) => kinds(x.id)))).flat();
    expect(told.filter((k) => k === "booking_series_confirmed")).toHaveLength(1);

    // A term not paid: all three sessions' places come back, and a list waiting on the last is offered it.
    const other = await enrol(sessions[0].id, {}, { term: true });
    const waiter = phone();
    expect((await enrol(sessions[2].id)).status).toBe(201);
    expect(await joinClassWaitlist({ classId: sessions[2].id, name: "Waiter", phone: waiter })).toMatchObject({ ok: true });
    await expire(...other.body.bookings!.map((x) => x.id));
    await releaseExpiredHolds();
    for (const x of other.body.bookings!) expect(await row(x.id)).toMatchObject({ status: "cancelled" });
    expect(await enrolled(sessions[0].id)).toBe(1);
    expect((await listWaitlistFor(waiter))[0]).toMatchObject({ status: "offered" });
  });
});

describe("a hold on a class place never runs past the class's start", () => {
  async function startingIn(classId: number, minutes: number) {
    const cls = (await getClass(classId))!;
    const zone = (await venueHours(cls.venueId)).zone;
    const at = new Date(Date.now() + minutes * 60_000);
    const date = todayISO(zone);
    const min = minuteOfDay(at, date, zone);
    await getDb().prepare("UPDATE classes SET date = ?, start_min = ?, end_min = ? WHERE id = ?").run(date, min, min + 60, classId);
    return instantOf(date, min, zone).toISOString().replace("T", " ").slice(0, 19);
  }
  const holdOf = async (id: number) => (await row(id)).hold_until!;

  it("holds to the start, not the venue's ten minutes, when the class begins sooner; an open payment page does not extend it", async () => {
    const [cls] = await aClass(5, 12);
    const r = await enrol(cls.id);
    const id = r.body.booking!.id;
    const starts = await startingIn(cls.id, 4);
    expect(await holdNewBookings([id], 10)).toBe(starts);
    expect(await holdOf(id)).toBe(starts);
    // The payment page opening gives a court 30 minutes; a class place only until the class begins.
    await extendHolds([id]);
    expect(await holdOf(id)).toBe(starts);

    // A class further off keeps the venue's minutes in full, and the page's extension.
    const [far] = await aClass(5, 13);
    const f = await enrol(far.id);
    const fid = f.body.booking!.id;
    const before = await holdOf(fid);
    expect(before < (await startingIn(far.id, 600))).toBe(true);
    await getDb().prepare("UPDATE bookings SET hold_until = datetime('now', '+1 minutes') WHERE id = ?").run(fid);
    await extendHolds([fid]);
    expect(await holdOf(fid) > before).toBe(true);
  });

  it("a hold for a class that has begun is let go at once, and the place is not offered into the session", async () => {
    const [cls] = await aClass(1, 14);
    const held = await enrol(cls.id);
    const waiter = phone();
    await joinClassWaitlist({ classId: cls.id, name: "Waiter", phone: waiter });
    await startingIn(cls.id, -5);
    await getDb().prepare("UPDATE bookings SET hold_until = datetime('now', '-1 minutes') WHERE id = ?").run(held.body.booking!.id);
    await releaseExpiredHolds();
    expect((await row(held.body.booking!.id)).status).toBe("cancelled");
    // Nothing is offered for a class that has begun (ADR 0060).
    expect((await listWaitlistFor(waiter))[0].status).not.toBe("offered");
  });
});

describe("a payment around the moment a hold runs out", () => {
  it("one that comes after the place was let go is owed back, never revives it, never takes another's", async () => {
    const [cls] = await aClass(1, 15);
    const late = await enrol(cls.id);
    fakeBillplz();
    expect((await startBookingPayment({ codes: [late.body.booking!.code], phone: late.phone })).ok).toBe(true);
    const lateBill = await lastBill();
    await expire(late.body.booking!.id);
    await releaseExpiredHolds();
    // Somebody else takes the place meanwhile.
    const second = await enrol(cls.id);
    expect(second.status).toBe(201);
    const settled = await settleBill({ billId: lateBill, paid: true, paidAt: null });
    expect(settled?.newlyPaid ?? []).toEqual([]);
    expect(await row(late.body.booking!.id)).toMatchObject({ status: "cancelled", payment_status: "unpaid" });
    const owed = (await getDb().prepare("SELECT amount, refund_due FROM online_payments WHERE bill_id = ?").get(lateBill)) as { amount: number | string; refund_due: number | string };
    expect(Number(owed.refund_due)).toBe(Number(owed.amount));
    expect(await enrolled(cls.id)).toBe(1);
    // Said again: still once.
    await settleBill({ billId: lateBill, paid: true, paidAt: null });
    const again = (await getDb().prepare("SELECT refund_due FROM online_payments WHERE bill_id = ?").get(lateBill)) as { refund_due: number | string };
    expect(Number(again.refund_due)).toBe(Number(owed.amount));
  });

  it("a payment racing the release ends as paid and held no longer, or let go and owed back; never both, never lost", async () => {
    let paid = 0;
    let owedBack = 0;
    for (let round = 0; round < 6; round++) {
      const [cls] = await aClass(1, 16 + round);
      const r = await enrol(cls.id);
      const id = r.body.booking!.id;
      fakeBillplz();
      expect((await startBookingPayment({ codes: [r.body.booking!.code], phone: r.phone })).ok).toBe(true);
      const b = await lastBill();
      await expire(id);
      const [settled] = await Promise.all([settleBill({ billId: b, paid: true, paidAt: null }), releaseExpiredHolds()]);
      expect(settled).not.toBeNull();
      const after = await row(id);
      const pay = (await getDb().prepare("SELECT status, amount, refund_due FROM online_payments WHERE bill_id = ?").get(b)) as { status: string; amount: number | string; refund_due: number | string };
      expect(pay.status).toBe("paid");
      if (after.status === "confirmed") {
        expect(after.payment_status).toBe("paid");
        expect(after.hold_until).toBeNull();
        expect(Number(pay.refund_due)).toBe(0);
        expect(await enrolled(cls.id)).toBe(1);
        paid++;
      } else {
        expect(after.status).toBe("cancelled");
        expect(after.payment_status).toBe("unpaid");
        expect(Number(pay.refund_due)).toBe(Number(pay.amount));
        expect(await enrolled(cls.id)).toBe(0);
        owedBack++;
      }
    }
    expect(paid + owedBack).toBe(6);
  });
});

describe("races for the last place", () => {
  it("several people enrolling at once into the last place: one is held, the rest refused, never oversold", async () => {
    const [cls] = await aClass(1, 23);
    const results = await Promise.all(Array.from({ length: 6 }, () => enrol(cls.id)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status !== 201).every((r) => r.status === 409)).toBe(true);
    expect(await enrolled(cls.id)).toBe(1);
    const winner = results.find((r) => r.status === 201)!;
    expect((await row(winner.body.booking!.id)).hold_until).not.toBeNull();
  });

  it("the same person enrolling twice at once is held once", async () => {
    const [cls] = await aClass(5, 24);
    const ph = phone();
    const results = await Promise.all(Array.from({ length: 4 }, () => enrol(cls.id, { phone: ph })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await enrolled(cls.id)).toBe(1);
  });

  it("a place let go is the list's: a stranger enrolling directly is refused while the offer stands, and the claim wins", async () => {
    const [cls] = await aClass(1, 25);
    const held = await enrol(cls.id);
    const waiter = phone();
    await joinClassWaitlist({ classId: cls.id, name: "Waiter", phone: waiter });
    await expire(held.body.booking!.id);
    await releaseExpiredHolds();
    const offer = (await listWaitlistFor(waiter))[0];
    expect(offer.status).toBe("offered");
    // At the same moment: the direct enrolment and the claim of the offered place.
    const [direct, claimed] = await Promise.all([enrol(cls.id), claimWaitlistOffer(offer.offerToken!)]);
    expect(claimed.ok).toBe(true);
    expect(direct.status).toBe(409);
    expect(await enrolled(cls.id)).toBe(1);
    const roster = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE class_id = ? AND status = 'confirmed'").get(cls.id)) as { n: number };
    expect(roster.n).toBe(1);
  });

  it("a claim through its link is held as a direct enrolment is: the same minutes, never past the start", async () => {
    const [cls] = await aClass(1, 26);
    const held = await enrol(cls.id);
    const waiter = phone();
    await joinClassWaitlist({ classId: cls.id, name: "Waiter", phone: waiter });
    await expire(held.body.booking!.id);
    await releaseExpiredHolds();
    const offer = (await listWaitlistFor(waiter))[0];
    const res = await claimRoute.POST(
      new NextRequest("http://localhost/api/waitlist/claim", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `10.67.${++n % 250}.${n % 200}` },
        body: JSON.stringify({ token: offer.offerToken }),
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { holdUntil: string | null; booking: { id: number } };
    expect(body.holdUntil).not.toBeNull();
    expect((await row(body.booking.id)).hold_until).toBe(body.holdUntil);
    // Not paid: let go again, and the place is free for the next.
    await expire(body.booking.id);
    await releaseExpiredHolds();
    expect(await enrolled(cls.id)).toBe(0);
  });

  it("the enrolment engine alone never takes more places than there are, held or not (library level)", async () => {
    const [cls] = await aClass(3, 27);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => enrolPeople({ classId: cls.id, name: `Lib ${i}`, phone: phone(), people: [null] }))
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(await enrolled(cls.id)).toBe(3);
    expect(await findBooking("NOPE", "0100000000")).toBeNull();
  });
});
