import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { POST as closeDay } from "../src/app/api/admin/venues/[id]/closures/route";
import { POST as settleRoute } from "../src/app/api/admin/bookings/owed/route";
import { GET as dayRoute } from "../src/app/api/admin/bookings/route";
import { POST as apiCancel } from "../src/app/api/v1/bookings/[code]/cancel/route";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { createApiKey } from "../src/lib/api-keys";
import { registerUser } from "../src/lib/auth";
import { cashUp } from "../src/lib/cash-up";
import { COUNTER_REFUSALS, counterOwed, counterPayoutsOn, OWED_REFUSALS, settleOwed, type OwedRefund } from "../src/lib/counter-refunds";
import { getDb } from "../src/lib/db";
import { cancelClassAndTell } from "../src/lib/notify";
import { createOutage } from "../src/lib/outages";
import { rainOut } from "../src/lib/rain-outs";
import {
  createBooking,
  createClassSessions,
  createCourt,
  createVenue,
  enrolInClass,
  getWalletBalance,
  setPaymentStatus,
  topUpWallet,
  payBookingFromWallet,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * The venue's own cancellations (closing a day, a court out of service, a
 * rain-out, its API key, a class called off) and money paid at the counter:
 * owed back, listed for staff, settled later as a staff cancellation settles
 * (handed back, with who and how, in that day's cash-up; or as stored credit),
 * once. Nobody is asked booking by booking at the moment of the bulk cancel.
 */

let venueId: number;
let otherVenueId: number;
let manager: { id: number; name: string; role: "manager" };
let desk: { id: number; name: string; role: "desk" };
let managerCookie: string;
let deskCookie: string;
let otherDeskCookie: string;
let writeKey: string;
let n = 0;
const phone = () => `0177700${String(++n).padStart(3, "0")}`;
const today = () => todayISO();

async function court(name: string, capacity = 1) {
  const made = await createCourt({ venueId, name, sport: "badminton", offPeakRate: 20, peakRate: 20, capacity });
  if (!made.ok) throw new Error(made.error);
  return made.court.id;
}

async function customer() {
  const made = await registerUser({ name: `Owed ${++n}`, email: `owed${n}@example.com`, phone: phone(), password: "password1" });
  if (!made.ok) throw new Error("user");
  return made.user;
}

async function book(courtId: number, days: number, hour: number, opts: { via?: "cash" | "qr" | "card" | "transfer"; userId?: number } = {}) {
  const made = await createBooking({ courtId, date: addDays(today(), days), hours: [hour], name: "Owed Customer", phone: phone(), ...(opts.userId ? { userId: opts.userId } : {}) });
  if (!made.ok) throw new Error(made.error);
  if (opts.via) {
    const paid = await setPaymentStatus(made.booking.code, true, opts.via);
    if (!paid.ok) throw new Error(paid.error);
  }
  return made.booking;
}

const creditNote = async (bookingId: number) =>
  (await getDb().prepare("SELECT id, total::float AS total, paid_via, staff_name FROM receipts WHERE source = ? AND kind = 'credit_note'").get(`booking:${bookingId}`)) as
    | { id: number; total: number; paid_via: string; staff_name: string | null }
    | undefined;
const payouts = async (bookingId: number) =>
  (await getDb().prepare("SELECT amount::float AS amount, via, admin_name, credit_note_id FROM counter_payouts WHERE booking_id = ?").all(bookingId)) as {
    amount: number;
    via: string | null;
    admin_name: string;
    credit_note_id: number | null;
  }[];
const owedFor = async (bookingId: number): Promise<OwedRefund | undefined> => (await counterOwed(null, "manager")).find((o) => o.bookingId === bookingId);
const status = async (bookingId: number) => ((await getDb().prepare("SELECT status FROM bookings WHERE id = ?").get(bookingId)) as { status: string }).status;
const paidEarlier = (bookingId: number) =>
  getDb().prepare("UPDATE bookings SET paid_at = ? WHERE id = ?").run(`${addDays(today(), -2)}T03:00:00.000Z`, bookingId);

const post = (handler: (req: NextRequest) => Promise<Response>, path: string, cookie: string, body: object) =>
  handler(new NextRequest(`http://localhost${path}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }));

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const made = await createVenue({ name: "Owed Hall", area: "Ipoh", address: "x", phone: "0355550101", openHour: 7, closeHour: 23 });
  const other = await createVenue({ name: "Other Hall", area: "Ipoh", address: "y", phone: "0355550102", openHour: 7, closeHour: 23 });
  if (!made.ok || !other.ok) throw new Error("venue");
  venueId = made.venue.id;
  otherVenueId = other.venue.id;
  const m = await createAdmin({ name: "Mona Manager", email: "mona@owed.my", password: "manager-pass-1", venueId });
  const d = await createAdmin({ name: "Dani Desk", email: "dani@owed.my", password: "desk-password-1", venueId, role: "desk" });
  const o = await createAdmin({ name: "Oli Other", email: "oli@other.my", password: "desk-password-2", venueId: otherVenueId, role: "desk" });
  if (!m.ok || !d.ok || !o.ok) throw new Error("staff");
  manager = { id: m.admin.id, name: m.admin.name, role: "manager" };
  desk = { id: d.admin.id, name: d.admin.name, role: "desk" };
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(m.admin.id)).token}`;
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(d.admin.id)).token}`;
  otherDeskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(o.admin.id)).token}`;
  const w = await createApiKey(venueId, { name: "Website", scope: "write" }, null);
  if (!w.ok) throw new Error("key");
  writeKey = w.key;
});

describe("closing a day over a booking paid at the counter", () => {
  it("cancels it with the money owed back, not said to have gone back; the desk hands it back later, in that day's till", async () => {
    const date = addDays(today(), 9);
    const b = await book((await court("Court Close")), 9, 10, { via: "cash" });
    const res = await post(
      (req) => closeDay(req, { params: Promise.resolve({ id: String(venueId) }) }),
      `/api/admin/venues/${venueId}/closures`,
      managerCookie,
      { date, reason: "Flood", cancelAffected: true }
    );
    expect(res.status).toBe(201);
    expect(await status(b.id)).toBe("cancelled");
    // Nothing has left the till: no credit note, no payout, but owed.
    expect(await creditNote(b.id)).toBeUndefined();
    expect(await payouts(b.id)).toEqual([]);
    const owed = await owedFor(b.id);
    expect(owed).toMatchObject({ amount: 20, via: "cash", cause: "closure", account: false, managerOnly: false, settled: null });

    // On the day list for the venue's staff, whatever day is shown.
    const day = await dayRoute(new NextRequest(`http://localhost/api/admin/bookings?date=${today()}`, { headers: { cookie: deskCookie } }));
    const body = (await day.json()) as { owed: OwedRefund[] };
    expect(body.owed.some((o) => o.bookingId === b.id)).toBe(true);
    // Another venue's desk neither sees it nor settles it.
    const other = (await (await dayRoute(new NextRequest(`http://localhost/api/admin/bookings?date=${today()}`, { headers: { cookie: otherDeskCookie } }))).json()) as {
      owed: OwedRefund[];
    };
    expect(other.owed.some((o) => o.bookingId === b.id)).toBe(false);
    expect((await post(settleRoute, "/api/admin/bookings/owed", otherDeskCookie, { id: owed!.id, outcome: "back" })).status).toBe(403);

    // The desk hands it back: credit note and payout written now, by the desk, in today's payouts and cash-up.
    const settled = await post(settleRoute, "/api/admin/bookings/owed", deskCookie, { id: owed!.id, outcome: "back" });
    expect(settled.status).toBe(200);
    const note = await creditNote(b.id);
    expect(note).toMatchObject({ total: 20, paid_via: "Cash", staff_name: "Dani Desk" });
    expect(await payouts(b.id)).toEqual([{ amount: 20, via: "cash", admin_name: "Dani Desk", credit_note_id: note!.id }]);
    expect((await counterPayoutsOn([venueId], today())).some((p) => p.bookingCode === b.code)).toBe(true);
    const till = await cashUp(venueId, today(), desk.id);
    const { number } = (await getDb().prepare("SELECT number FROM receipts WHERE id = ?").get(note!.id)) as { number: string };
    expect(till.entries.find((e) => e.number === number)).toMatchObject({
      type: "Credit note",
      method: "cash",
      gross: -20,
      staffName: "Dani Desk",
    });
    // Off the list, settled with who and how; a second go is refused.
    expect(await owedFor(b.id)).toBeUndefined();
    const again = await post(settleRoute, "/api/admin/bookings/owed", deskCookie, { id: owed!.id, outcome: "back" });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe(OWED_REFUSALS.settled);
    const row = (await getDb().prepare("SELECT outcome, admin_name, settled_at FROM counter_refunds_owed WHERE id = ?").get(owed!.id)) as {
      outcome: string;
      admin_name: string;
      settled_at: unknown;
    };
    expect(row).toMatchObject({ outcome: "back", admin_name: "Dani Desk" });
    expect(row.settled_at).toBeTruthy();
    const logged = (await getDb().prepare("SELECT action, admin_name FROM staff_actions WHERE booking_code = ? ORDER BY id").all(b.code)) as { action: string; admin_name: string }[];
    expect(logged).toContainEqual({ action: "payment.paid_out", admin_name: "Dani Desk" });
  });
});

describe("a rain-out over a booking paid at the counter on an earlier day", () => {
  it("is a manager's to hand back, as when staff cancel; credit only for a booking made from an account", async () => {
    const courtId = await court("Court Rain");
    const b = await book(courtId, 4, 15, { via: "qr" });
    await paidEarlier(b.id);
    const done = await rainOut({ venueId, courtIds: [courtId], date: b.date, fromHour: 14, untilHour: 18 });
    expect(done.ok).toBe(true);
    const owed = (await counterOwed([venueId], "desk")).find((o) => o.bookingId === b.id);
    expect(owed).toMatchObject({ cause: "rain", via: "qr", managerOnly: true });
    expect(await settleOwed(owed!.id, "back", desk)).toMatchObject({ ok: false, error: COUNTER_REFUSALS.manager });
    expect((await post(settleRoute, "/api/admin/bookings/owed", deskCookie, { id: owed!.id, outcome: "back" })).status).toBe(409);
    expect(await settleOwed(owed!.id, "credit", manager)).toMatchObject({ ok: false, error: COUNTER_REFUSALS.noAccount });
    const back = await settleOwed(owed!.id, "back", manager);
    expect(back).toMatchObject({ ok: true, settled: { outcome: "back", refund: 20, paidOut: { amount: 20, via: "qr" } } });
    expect(await payouts(b.id)).toEqual([expect.objectContaining({ amount: 20, via: "qr", admin_name: "Mona Manager" })]);
  });
});

describe("a court taken out of service over a booking made from an account", () => {
  it("can be settled as stored credit: the credit on the account, the credit note saying so, nothing paid out", async () => {
    const courtId = await court("Court Out");
    const user = await customer();
    const b = await book(courtId, 6, 9, { via: "cash", userId: user.id });
    const out = await createOutage({ courtId, startsOn: b.date, endsOn: b.date, reason: "Leak", adminId: manager.id, cancelAffected: true });
    expect(out.ok).toBe(true);
    const owed = await owedFor(b.id);
    expect(owed).toMatchObject({ cause: "outage", account: true });
    const before = await getWalletBalance(user.id);
    const res = await post(settleRoute, "/api/admin/bookings/owed", deskCookie, { id: owed!.id, outcome: "credit" });
    expect(res.status).toBe(200);
    expect(await getWalletBalance(user.id)).toBe(before + 20);
    expect(await creditNote(b.id)).toMatchObject({ total: 20, paid_via: "Stored credit", staff_name: "Dani Desk" });
    expect(await payouts(b.id)).toEqual([]);
    const logged = (await getDb().prepare("SELECT action FROM staff_actions WHERE booking_code = ?").all(b.code)) as { action: string }[];
    expect(logged.map((l) => l.action)).toContain("payment.owed_credited");
  });
});

describe("the venue's API key cancelling", () => {
  it("owes back a counter payment, and leaves money paid with credit and an unpaid booking as they always were", async () => {
    const courtId = await court("Court Api");
    const cash = await book(courtId, 5, 9, { via: "transfer" });
    const call = (code: string) =>
      apiCancel(
        new NextRequest(`http://localhost/api/v1/bookings/${code}/cancel`, {
          method: "POST",
          headers: { authorization: `Bearer ${writeKey}`, "content-type": "application/json", "x-forwarded-for": "203.0.113.70" },
        }),
        { params: Promise.resolve({ code }) }
      );
    expect((await call(cash.code)).status).toBe(200);
    expect(await owedFor(cash.id)).toMatchObject({ cause: "api", via: "transfer", amount: 20 });
    expect(await creditNote(cash.id)).toBeUndefined();

    // Paid from stored credit: given back to credit at once, as before; nothing owed at the counter.
    const user = await customer();
    await topUpWallet({ userId: user.id, amount: 50, adminId: manager.id, venueId, via: "cash" });
    const wallet = await book(courtId, 5, 11, { userId: user.id });
    expect((await payBookingFromWallet(wallet.id)).ok).toBe(true);
    expect((await call(wallet.code)).status).toBe(200);
    expect(await getWalletBalance(user.id)).toBe(50);
    expect(await owedFor(wallet.id)).toBeUndefined();

    const unpaid = await book(courtId, 5, 13);
    expect((await call(unpaid.code)).status).toBe(200);
    expect(await owedFor(unpaid.id)).toBeUndefined();
  });
});

describe("a class called off", () => {
  it("owes back each enrolment paid at the counter", async () => {
    const courtId = await court("Studio", 6);
    const made = await createClassSessions({ courtId, name: "Yoga", instructor: "Nadia", date: addDays(today(), 8), startHour: 18, endHour: 19, capacity: 4, price: 30 });
    if (!made.ok) throw new Error(made.error);
    const classId = made.classes[0].id;
    const enrolled = await enrolInClass({ classId, name: "Owed Student", phone: phone() });
    if (!enrolled.ok) throw new Error(enrolled.error);
    expect((await setPaymentStatus(enrolled.booking.code, true, "cash")).ok).toBe(true);
    const off = await cancelClassAndTell(classId);
    expect(off.ok).toBe(true);
    expect(await owedFor(enrolled.booking.id)).toMatchObject({ cause: "class", amount: 30, via: "cash" });
    expect(await creditNote(enrolled.booking.id)).toBeUndefined();
  });
});

describe("two members of staff settling at the same moment", () => {
  it("settle it once: one credit note, one payout", async () => {
    const courtId = await court("Court Twice");
    const b = await book(courtId, 7, 9, { via: "card" });
    const date = b.date;
    const closed = await post(
      (req) => closeDay(req, { params: Promise.resolve({ id: String(venueId) }) }),
      `/api/admin/venues/${venueId}/closures`,
      managerCookie,
      { date, cancelAffected: true }
    );
    expect(closed.status).toBe(201);
    const owed = await owedFor(b.id);
    const [a, c] = await Promise.all([settleOwed(owed!.id, "back", manager), settleOwed(owed!.id, "back", desk)]);
    expect([a.ok, c.ok].filter(Boolean)).toHaveLength(1);
    expect(await payouts(b.id)).toHaveLength(1);
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM receipts WHERE source = ? AND kind = 'credit_note'").get(`booking:${b.id}`)) as { n: number }).n).toBe(1);
  });
});

describe("refusals", () => {
  it("refuses a malformed request and a refund that is not owed", async () => {
    expect((await post(settleRoute, "/api/admin/bookings/owed", deskCookie, { id: "x", outcome: "back" })).status).toBe(400);
    expect((await post(settleRoute, "/api/admin/bookings/owed", deskCookie, { id: 1, outcome: "keep" })).status).toBe(400);
    expect((await post(settleRoute, "/api/admin/bookings/owed", deskCookie, { id: 999999, outcome: "back" })).status).toBe(404);
  });
});
