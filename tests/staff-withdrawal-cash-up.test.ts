import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { POST as withdrawRoute } from "../src/app/api/admin/bookings/withdraw/route";
import { asStaff } from "../src/lib/acting-staff";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { registerUser } from "../src/lib/auth";
import { cashUp } from "../src/lib/cash-up";
import { counterOwed, counterPayoutsOn, staffCancel, type CancellingStaff } from "../src/lib/counter-refunds";
import { getDb } from "../src/lib/db";
import { setHouseRules } from "../src/lib/house-rules";
import { withdrawPlace } from "../src/lib/place-withdrawals";
import { createResources } from "../src/lib/resources";
import { createBookingSeries, createVenue, getWalletBalance, payBookingFromWallet, setPaymentStatus, topUpWallet } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Brief WDRAW (ADR 0077): a member of staff taking one person off a booking paid at the counter hands the money over as they do it. The
 * credit note was the only trace, and it carried nobody: so a desk's own cash-up (ADR 0075: what each took and gave back) never lowered the
 * till by what it had handed over, and the till's list of money handed back did not show it. Now the route acts as the member of staff and
 * the withdrawal writes the payout it is, on its credit note, as a staff cancellation does. Every scenario is dated on days of its own, in
 * the past, so nothing depends on today, the time of day or the weekday.
 */

const ZONE = "Asia/Kuala_Lumpur";
const today = () => todayISO(ZONE);
const at = (h: number) => h * 60;

let venueId: number;
let pool: number; // RM10 a place
let managerId: number;
let deskId: number;
let otherDeskId: number;
let manager: CancellingStaff;
let managerCookie: string;
let deskCookie: string;
let n = 0;
let slotN = 0;
let run = 0;
const db = () => getDb();

function slot() {
  const k = slotN++;
  return { date: addDays(today(), 3 + Math.floor(k / 12)), hour: 8 + (k % 12) };
}
/** Days of the story, far in the past and apart from every other scenario's. */
function days() {
  const P = addDays("2026-02-01", 5 * run++);
  return { P, D: addDays(P, 1), E: addDays(P, 2) };
}
const local = (day: string) => `${day} 04:00:00`;
const noon = (day: string) => `${day}T04:00:00Z`;

async function paidPool(places: number, via: "cash" | "qr" | "card" | "transfer" = "cash", userId?: number) {
  const s = slot();
  const made = await createBookingSeries({
    weeks: 1,
    name: `Wan ${++n}`,
    phone: `0178${String(100000 + n)}`,
    ...(userId ? { userId } : {}),
    by: "staff",
    date: s.date,
    start: at(s.hour),
    end: at(s.hour + 1),
    courtId: pool,
    players: places,
  });
  if (!made.ok) throw new Error(made.error);
  const booking = made.bookings[0];
  expect((await setPaymentStatus(booking.code, true, via)).ok).toBe(true);
  return booking;
}

const post = (cookie: string, body: object) =>
  withdrawRoute(
    new NextRequest("http://localhost/api/admin/bookings/withdraw", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-forwarded-for": `198.51.100.${(++n % 200) + 1}` },
      body: JSON.stringify(body),
    })
  );
const whenPaid = (bookingId: number, day: string) => db().prepare("UPDATE bookings SET paid_at = ? WHERE id = ?").run(local(day), bookingId);
const whenNote = (bookingId: number, day: string) =>
  db().prepare("UPDATE receipts SET issued_at = ? WHERE kind = 'credit_note' AND source LIKE ?").run(local(day), `booking:${bookingId}%`);
const whenPaidOut = (bookingId: number, day: string) => db().prepare("UPDATE counter_payouts SET paid_out_at = ?::timestamptz WHERE booking_id = ?").run(noon(day), bookingId);
const notesOf = async (bookingId: number) =>
  (await db()
    .prepare("SELECT id, total::float AS total, paid_via, staff_id, staff_name FROM receipts WHERE kind = 'credit_note' AND source LIKE ? ORDER BY id")
    .all(`booking:${bookingId}%`)) as { id: number; total: number; paid_via: string; staff_id: number | null; staff_name: string | null }[];
const payoutsOf = async (bookingId: number) =>
  (await db()
    .prepare("SELECT amount::float AS amount, via, kept_percent, credit_note_id, admin_id, admin_name FROM counter_payouts WHERE booking_id = ? ORDER BY id")
    .all(bookingId)) as { amount: number; via: string | null; kept_percent: number | null; credit_note_id: number | null; admin_id: number | null; admin_name: string }[];
const owedOf = async (bookingId: number) => (await counterOwed(null, "manager")).filter((o) => o.bookingId === bookingId);
/** One day's cash-up, for everybody or for one member of staff, with the cash and QR tills' expected amounts. */
const dayOf = async (day: string, staff: number | null = null) => {
  const up = await cashUp(venueId, day, staff);
  return { up, cash: up.expected.find((e) => e.method === "cash")?.expected ?? 0, qr: up.expected.find((e) => e.method === "qr")?.expected ?? 0 };
};

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const v = await createVenue({ name: "Withdraw Hall", area: "Ipoh", address: "x", phone: "0355550401", openMin: at(7), closeMin: at(23) });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  await db().prepare("UPDATE venues SET published_at = datetime('now') WHERE id = ?").run(venueId);
  const r = await createResources({ venueId, sport: "swimming", name: "Pool", offPeakRate: 10, peakRate: 10, capacity: 4, maxPlayers: 4 });
  if (!r.ok) throw new Error(r.error);
  pool = r.courts[0].id;
  expect((await setHouseRules(venueId, { aheadDays: 45 })).ok).toBe(true);
  const m = await createAdmin({ name: "Mona Manager", email: "mona@wd.test", password: "a long enough password", venueId, role: "manager" });
  const d = await createAdmin({ name: "Dani Desk", email: "dani@wd.test", password: "a long enough password", venueId, role: "desk" });
  const o = await createAdmin({ name: "Olli Desk", email: "olli@wd.test", password: "a long enough password", venueId, role: "desk" });
  if (!m.ok || !d.ok || !o.ok) throw new Error("staff");
  managerId = m.admin.id;
  deskId = d.admin.id;
  otherDeskId = o.admin.id;
  manager = { id: m.admin.id, name: m.admin.name, role: "manager" };
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(m.admin.id)).token}`;
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(d.admin.id)).token}`;
});

describe("(a) staff take a person off a cash booking at the counter and hand the cash over at that moment", () => {
  it("the day's till is lowered once, in the drawer of the member of staff who handed it over, and the payout is listed", async () => {
    const { P, D } = days();
    const booking = await paidPool(3, "cash");
    await whenPaid(booking.id, P);
    const res = await post(deskCookie, { code: booking.code, unnamed: 1 });
    expect(res.status).toBe(200);
    await whenNote(booking.id, D);
    await whenPaidOut(booking.id, D);

    // The record: one credit note of RM10, by the desk, and the payout it is, on that note, by the method it was paid.
    const notes = await notesOf(booking.id);
    expect(notes).toMatchObject([{ total: 10, paid_via: "Cash", staff_id: deskId, staff_name: "Dani Desk" }]);
    expect(await payoutsOf(booking.id)).toEqual([{ amount: 10, via: "cash", kept_percent: null, credit_note_id: notes[0].id, admin_id: deskId, admin_name: "Dani Desk" }]);
    // Nothing is owed: it was handed over.
    expect(await owedOf(booking.id)).toEqual([]);

    // Received RM30 on P; on D the RM10 leaves the drawer once (the note is the record, the payout the cash).
    expect((await dayOf(P)).cash).toBe(30);
    const d = await dayOf(D);
    expect(d.cash).toBe(-10);
    expect(d.up.expected.find((e) => e.method === "cash")).toMatchObject({ journalNet: -10, refundNotes: 10, handedBack: 10 });
    expect(d.up.refunds.handed).toMatchObject([{ reference: booking.code, amount: 10, method: "cash", paidWith: "cash", countedAs: "payout", staffName: "Dani Desk" }]);
    expect(d.up.refunds.owedTotal).toBe(0);
    // The journal is as the accountant has it: the credit note, on D.
    expect(d.up.byMethod.find((m) => m.method === "cash")).toMatchObject({ taken: 0, givenBack: 10, net: -10 });
    // Over the two days the drawer ends where the money is: 30 in, 10 out.
    expect((await dayOf(P)).cash + d.cash).toBe(20);
  });

  it("the member of staff's own cash-up is lowered by what they handed over; nobody else's is", async () => {
    const { P, D } = days();
    const booking = await paidPool(3, "cash");
    await whenPaid(booking.id, P);
    expect((await post(deskCookie, { code: booking.code, unnamed: 1 })).status).toBe(200);
    await whenNote(booking.id, D);
    await whenPaidOut(booking.id, D);

    // Before this change the desk's own till showed 0 here: counted against it, the drawer was RM10 short.
    expect((await dayOf(D, deskId)).cash).toBe(-10);
    expect((await dayOf(D, otherDeskId)).cash).toBe(0);
    expect((await dayOf(D, managerId)).cash).toBe(0);
    expect((await dayOf(D)).cash).toBe(-10);
    // The payout and its note are one movement in the desk's own sheet, not two.
    const own = await dayOf(D, deskId);
    expect(own.up.expected.find((e) => e.method === "cash")).toMatchObject({ journalNet: -10, refundNotes: 10, handedBack: 10 });
    expect(own.up.refunds.handed).toHaveLength(1);
  });

  it("a manager's withdrawal is the manager's; it is on the till's list of money handed back with the note's number", async () => {
    const booking = await paidPool(3, "cash");
    expect((await post(managerCookie, { code: booking.code, unnamed: 1 })).status).toBe(200);
    const notes = await notesOf(booking.id);
    expect(notes).toMatchObject([{ staff_id: managerId }]);
    const listed = (await counterPayoutsOn([venueId], todayISO(ZONE))).filter((p) => p.bookingCode === booking.code);
    expect(listed).toMatchObject([{ kind: "booking", amount: 10, via: "cash", adminName: "Mona Manager" }]);
    expect(listed[0].creditNote).not.toBeNull();
  });
});

describe("(b) the method and the day: the withdrawal hands the money back the way it was paid, at that moment", () => {
  it("paid by DuitNow: the QR till is lowered, never the drawer; there is no 'hand it back later' for a staff withdrawal", async () => {
    const { P, D } = days();
    const booking = await paidPool(3, "qr");
    await whenPaid(booking.id, P);
    expect((await post(deskCookie, { code: booking.code, unnamed: 1 })).status).toBe(200);
    await whenNote(booking.id, D);
    await whenPaidOut(booking.id, D);
    expect(await payoutsOf(booking.id)).toMatchObject([{ amount: 10, via: "qr" }]);
    expect((await dayOf(P)).qr).toBe(30);
    const d = await dayOf(D);
    expect(d.qr).toBe(-10);
    expect(d.cash).toBe(0);
    // Staff have no other choice to make here: nothing is written as owed, and no other method can be named. Handing the money over another
    // way or another day than the withdrawal is the same as for a staff cancellation: not expressible, so not reconciled (ADR 0077).
    expect(await owedOf(booking.id)).toEqual([]);
  });

  it("the payout and its credit note are one movement on the same day, and the sum over the days is the money that moved", async () => {
    const { P, D, E } = days();
    const booking = await paidPool(3, "cash");
    await whenPaid(booking.id, P);
    expect((await post(deskCookie, { code: booking.code, unnamed: 1 })).status).toBe(200);
    await whenNote(booking.id, D);
    await whenPaidOut(booking.id, D);
    // Then staff cancel what is left: RM20 more, handed back on E.
    // A manager: front desk hands back only a payment taken today, and this one was taken on P.
    const cancelled = await asStaff({ id: manager.id!, name: manager.name }, () => staffCancel(booking.code, manager));
    expect(cancelled.result.ok).toBe(true);
    await db().prepare("UPDATE receipts SET issued_at = ? WHERE kind = 'credit_note' AND source = ?").run(local(E), `booking:${booking.id}`);
    await db().prepare("UPDATE counter_payouts SET paid_out_at = ?::timestamptz WHERE booking_id = ? AND amount = 20").run(noon(E), booking.id);
    const payouts = await payoutsOf(booking.id);
    expect(payouts.map((p) => p.amount).sort()).toEqual([10, 20]);
    const cash = [(await dayOf(P)).cash, (await dayOf(D)).cash, (await dayOf(E)).cash];
    expect(cash).toEqual([30, -10, -20]);
    expect(cash.reduce((s, x) => s + x, 0)).toBe(0);
  });
});

describe("(c) the money is not handed back at the counter: no cash leaves the till", () => {
  it("a booking not yet paid: the price comes off what is owed, no credit note, no payout", async () => {
    const s = slot();
    const made = await createBookingSeries({ weeks: 1, name: "Unpaid", phone: `0178${String(100000 + ++n)}`, by: "staff", date: s.date, start: at(s.hour), end: at(s.hour + 1), courtId: pool, players: 3 });
    if (!made.ok) throw new Error(made.error);
    const booking = made.bookings[0];
    const res = await post(deskCookie, { code: booking.code, unnamed: 1 });
    expect(res.status).toBe(200);
    expect(await notesOf(booking.id)).toEqual([]);
    expect(await payoutsOf(booking.id)).toEqual([]);
  });

  it("a booking paid from stored credit goes back to credit: a credit note in no till, no payout", async () => {
    const user = await registerUser({ name: "Credit Customer", email: `wd${++n}@wd.test`, phone: `0178${String(100000 + ++n)}`, password: "a long enough password" });
    if (!user.ok) throw new Error(user.error);
    await topUpWallet({ userId: user.user.id, amount: 50, adminId: managerId, venueId });
    const booking = await paidPoolUnpaid(3, user.user.id);
    expect(await payBookingFromWallet(booking.id)).toMatchObject({ ok: true });
    const before = await getWalletBalance(user.user.id);
    expect((await post(deskCookie, { code: booking.code, unnamed: 1 })).status).toBe(200);
    expect(await getWalletBalance(user.user.id)).toBe(before + 10);
    expect(await payoutsOf(booking.id)).toEqual([]);
    expect(await owedOf(booking.id)).toEqual([]);
  });

  it("the customer taking someone off the same booking is owed it back, with no payout: nobody is at the till", async () => {
    const who = await registerUser({ name: "Cust", email: `wd${++n}@wd.test`, phone: `0178${String(100000 + ++n)}`, password: "a long enough password" });
    if (!who.ok) throw new Error(who.error);
    const booking = await paidPool(3, "cash", who.user.id);
    const done = await withdrawPlace(booking.id, { unnamed: 1 }, { kind: "customer", userId: who.user.id, name: who.user.name });
    expect(done.ok).toBe(true);
    expect(await payoutsOf(booking.id)).toEqual([]);
    expect(await owedOf(booking.id)).toMatchObject([{ amount: 10, cause: "place_withdrawn" }]);
  });
});

describe("history and repeats", () => {
  it("a withdrawal from before this change (a note, no payout) is counted by its note as it always was; nothing is backfilled", async () => {
    const { P, D } = days();
    const booking = await paidPool(3, "cash");
    await whenPaid(booking.id, P);
    expect((await post(deskCookie, { code: booking.code, unnamed: 1 })).status).toBe(200);
    await whenNote(booking.id, D);
    // As the data stood before: the payout was never written.
    await db().prepare("DELETE FROM counter_payouts WHERE booking_id = ?").run(booking.id);
    const d = await dayOf(D);
    expect(d.cash).toBe(-10);
    expect(d.up.expected.find((e) => e.method === "cash")).toMatchObject({ journalNet: -10, refundNotes: 0, handedBack: 0 });
    expect(d.up.refunds.handed).toEqual([]);
  });

  it("two members of staff taking the last two places off at once: one succeeds, one payout, one note", async () => {
    const booking = await paidPool(2, "cash");
    const both = await Promise.all([post(deskCookie, { code: booking.code, unnamed: 1 }), post(managerCookie, { code: booking.code, unnamed: 1 })]);
    // Taking the second would leave nobody on it: that one is refused, never both.
    expect(both.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await payoutsOf(booking.id)).toHaveLength(1);
    expect(await notesOf(booking.id)).toHaveLength(1);
    expect((await payoutsOf(booking.id))[0].amount).toBe(10);
  });
});

/** A booking for an account, not yet paid. */
async function paidPoolUnpaid(places: number, userId: number) {
  const s = slot();
  const made = await createBookingSeries({
    weeks: 1,
    name: `Acct ${++n}`,
    phone: `0178${String(100000 + ++n)}`,
    userId,
    by: "staff",
    date: s.date,
    start: at(s.hour),
    end: at(s.hour + 1),
    courtId: pool,
    players: places,
  });
  if (!made.ok) throw new Error(made.error);
  return made.bookings[0];
}
