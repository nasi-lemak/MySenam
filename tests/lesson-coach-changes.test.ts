import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { salesJournal } from "../src/lib/accounting";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { notifyCoaches, setCoachEmail } from "../src/lib/coach-schedule";
import { retireCoach, saveCoach, type Coach } from "../src/lib/coaching";
import { getDb } from "../src/lib/db";
import { bookingSale, documentFor } from "../src/lib/documents";
import { checkIntegrity } from "../src/lib/integrity";
import { savePaymentSettings, settleBill, startBookingPayment } from "../src/lib/payments";
import {
  adminCancelBooking,
  createCourt,
  createVenue,
  getBookingById,
  getWalletBalance,
  issuePass,
  listBookingsForDate,
  paidPartLeft,
  rescheduleBooking,
  setPaymentStatus,
  topUpWallet,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { POST as book } from "../src/app/api/bookings/route";
import * as staffReschedule from "../src/app/api/admin/bookings/reschedule/route";
import * as lessonCoachRoute from "../src/app/api/admin/bookings/lesson-coach/route";

/**
 * Giving a booked lesson to another coach (owner's decisions of 27 October
 * 2026; lib/lesson-coaches.ts; docs/features/programmes.md#giving-a-lesson-to-another-coach):
 * a manager's explicit change, with or without a new time, unpaid or paid —
 * the price kept as paid (the venue absorbs it, on the record) or adjusted (a
 * dearer coach's difference owed and taken at the counter on its own receipt;
 * a cheaper one's given back the way it was paid with its own credit note) —
 * the receipt as sold never rewritten, a later cancellation giving back only
 * what is left; the refusals; the customer and both coaches told; and a
 * change racing a new lesson for the new coach's time.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (k: number) => addDays(todayISO(ZONE), k);
const H = (h: number) => h * 60;
let n = 0;
let venueId: number;
let ana: Coach;
let ben: Coach;
let cara: Coach;
let dan: Coach;
let swimCoach: Coach;
let manager: { id: number; cookie: string };
let deskCookie: string;

const ip = () => `198.18.${++n % 250}.${n % 200}`;
type Lesson = { code: string; phone: string; id: number; totalPrice: number };
async function lesson(coach: Coach, date: string, hour: number, extra: Record<string, unknown> = {}, cookie?: string): Promise<Lesson> {
  const phone = (extra.phone as string | undefined) ?? `01377${String(++n).padStart(5, "0")}`;
  const res = await book(
    new NextRequest("http://localhost/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip(), ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ venueId, sport: "tennis", date, start: H(hour), end: H(hour + 1), name: `Pupil ${n}`, phone, email: `pupil${n}@learn.test`, coachId: coach.id, ...extra }),
    })
  );
  const body = await res.json();
  if (res.status !== 201) throw new Error(JSON.stringify(body));
  return { code: body.booking.code, phone, id: body.booking.id, totalPrice: body.booking.totalPrice };
}
const tryLesson = (coach: Coach, date: string, hour: number) =>
  book(
    new NextRequest("http://localhost/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip() },
      body: JSON.stringify({ venueId, sport: "tennis", date, start: H(hour), end: H(hour + 1), name: `Rival ${++n}`, phone: `01399${String(n).padStart(5, "0")}`, coachId: coach.id }),
    })
  );
const change = (cookie: string, body: Record<string, unknown>) =>
  staffReschedule.POST(
    new NextRequest("http://localhost/api/admin/bookings/reschedule", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) })
  );
const terms = async (code: string, coachId: number) =>
  lessonCoachRoute.GET(new NextRequest(`http://localhost/api/admin/bookings/lesson-coach?code=${code}&coachId=${coachId}`, { headers: { cookie: manager.cookie } }));
const collect = (cookie: string, body: Record<string, unknown>) =>
  lessonCoachRoute.POST(
    new NextRequest("http://localhost/api/admin/bookings/lesson-coach", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) })
  );
const coachHeld = async (bookingId: number) =>
  ((await getDb().prepare("SELECT coach_id FROM coach_claims WHERE booking_id = ? AND active").all(bookingId)) as { coach_id: number }[]).map((r) => r.coach_id);
const changes = async (bookingId: number) =>
  (await getDb()
    .prepare("SELECT money, absorbed::float AS absorbed, owed::float AS owed, refunded::float AS refunded, refund_how, from_coach_name, to_coach_name, by_name FROM lesson_coach_changes WHERE booking_id = ? ORDER BY id")
    .all(bookingId)) as { money: string; absorbed: number; owed: number; refunded: number; refund_how: string | null; from_coach_name: string; to_coach_name: string; by_name: string }[];
const logged = async (code: string, action: string) =>
  ((await getDb().prepare("SELECT admin_name, detail FROM staff_actions WHERE booking_code = ? AND action = ? ORDER BY id").all(code, action)) as { admin_name: string; detail: string }[]);
const mails = async (bookingId: number) =>
  (await getDb()
    .prepare("SELECT kind, recipient, locale, subject, body FROM messages WHERE booking_id = ? AND channel = 'email' ORDER BY id")
    .all(bookingId)) as { kind: string; recipient: string; locale: string; subject: string; body: string }[];

async function customer(name: string) {
  const phone = `01466${String(++n).padStart(5, "0")}`;
  const made = await registerUser({ name, email: `cust${n}@learn.test`, phone, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now'), verified_phone = phone WHERE id = ?").run(made.user.id);
  return { id: made.user.id, phone, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}

beforeAll(async () => {
  const made = await createVenue({ name: "Coach Swap Club", area: "Bangsar", address: "1 Jalan Tukar", phone: "0322225555" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  // Live, so its customers are told.
  await getDb().prepare("UPDATE venues SET published_at = now() WHERE id = ?").run(venueId);
  for (const name of ["Court 1", "Court 2", "Court 3"]) {
    const c = await createCourt({ venueId, name, sport: "tennis", offPeakRate: 20, peakRate: 20 });
    if (!c.ok) throw new Error("court");
  }
  await createCourt({ venueId, name: "Pool", sport: "swimming", offPeakRate: 10, peakRate: 10 });
  const hours = (from: number, until: number) => [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: H(from), until: H(until) }));
  const save = async (name: string, rate: number, sport: string) => {
    const s = await saveCoach(venueId, { name, sports: [sport], rate, hours: hours(8, 20) });
    if (!s.ok) throw new Error(s.error);
    return s.coach;
  };
  ana = await save("Ana Lim", 80, "tennis");
  ben = await save("Ben Tan", 100, "tennis");
  cara = await save("Cara Ong", 60, "tennis");
  dan = await save("Dan Retired", 70, "tennis");
  swimCoach = await save("Sam Swim", 50, "swimming");
  for (const [k, email] of [
    [ana, "ana@coach.test"],
    [ben, "ben@coach.test"],
    [cara, "cara@coach.test"],
  ] as const)
    expect((await setCoachEmail(k.id, venueId, email)).ok).toBe(true);
  const staff = async (name: string, role: "manager" | "desk") => {
    const a = await createAdmin({ name, email: `${name.toLowerCase().replace(/\W/g, "")}@swap.test`, password: "a long enough password", venueId, role });
    if (!a.ok) throw new Error(a.error);
    return { id: a.admin.id, cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(a.admin.id)).token}` };
  };
  manager = await staff("Mei Manager", "manager");
  deskCookie = (await staff("Dino Desk", "desk")).cookie;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("an unpaid lesson to another coach", () => {
  it("a manager gives it at the same time or another: the new fee on the price, the change on the record, the customer and both coaches told", async () => {
    const date = day(4);
    const l = await lesson(ana, date, 10);
    await getDb().prepare("UPDATE bookings SET locale = 'ms' WHERE id = ?").run(l.id);
    await notifyCoaches(); // Ana has heard of it.
    // The price effect is shown before anything changes.
    const seen = (await (await terms(l.code, ben.id)).json()) as { keep: { fromFee: number; toFee: number; difference: number; paid: boolean } };
    expect(seen.keep).toMatchObject({ fromFee: 80, toFee: 100, difference: 20, paid: false });
    const preview = await change(manager.cookie, { code: l.code, date, start: H(10), coachId: ben.id, preview: true });
    expect((await preview.json()).preview).toMatchObject({ priceChange: 20, coachChange: { money: "repriced", fromFee: 80, toFee: 100 } });
    expect(await coachHeld(l.id)).toEqual([ana.id]);
    expect(await changes(l.id)).toEqual([]);

    const res = await change(manager.cookie, { code: l.code, date, start: H(10), coachId: ben.id });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.booking).toMatchObject({ startMin: H(10), coachId: ben.id, coachFee: 100, totalPrice: 120, paymentStatus: "unpaid" });
    expect(body.coachChange).toMatchObject({ money: "repriced", difference: 20 });
    expect(await coachHeld(l.id)).toEqual([ben.id]);
    expect(await changes(l.id)).toEqual([expect.objectContaining({ money: "repriced", from_coach_name: "Ana Lim", to_coach_name: "Ben Tan", by_name: "Mei Manager" })]);
    const log = await logged(l.code, "lesson.coach_changed");
    expect(log).toHaveLength(1);
    expect(log[0].admin_name).toBe("Mei Manager");
    expect(log[0].detail).toContain("Ana Lim → Ben Tan");
    expect(log[0].detail).toContain("price +");
    // Told: the customer once, in the language they booked in; Ana that it is no longer hers; Ben of a lesson with him.
    const sent = await mails(l.id);
    const toCustomer = sent.filter((m) => m.kind === "booking_rescheduled");
    expect(toCustomer).toHaveLength(1);
    expect(toCustomer[0]).toMatchObject({ recipient: expect.stringMatching(/@learn\.test$/), locale: "ms" });
    expect(toCustomer[0].subject).toContain("kini bersama Ben Tan");
    expect(toCustomer[0].body).toContain("menggantikan Ana Lim");
    const coaches = sent.filter((m) => m.kind === "coach_lesson").map((m) => m.recipient);
    expect(coaches).toEqual(["ana@coach.test", "ben@coach.test", "ana@coach.test"]);
    // Nobody else heard of it.
    expect(sent.every((m) => [toCustomer[0].recipient, "ana@coach.test", "ben@coach.test"].includes(m.recipient))).toBe(true);

    // And with a new time as well, to a cheaper coach.
    const moved = await change(manager.cookie, { code: l.code, date, start: H(14), coachId: cara.id });
    expect(moved.status).toBe(200);
    expect((await moved.json()).booking).toMatchObject({ startMin: H(14), coachId: cara.id, coachFee: 60, totalPrice: 80 });
    expect(await checkIntegrity()).toEqual([]);
  });

  it("is a manager's: the front desk moves a lesson with its coach, and is refused another coach", async () => {
    const date = day(5);
    const l = await lesson(ana, date, 9);
    const res = await change(deskCookie, { code: l.code, date, start: H(9), coachId: ben.id });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "COACH_CHANGE_MANAGER" });
    expect((await change(deskCookie, { code: l.code, date, start: H(11) })).status).toBe(200);
    expect(await coachHeld(l.id)).toEqual([ana.id]);
  });

  it("refuses a retired coach, a coach of another sport and a coach already teaching then; a customer cannot change the coach", async () => {
    const date = day(6);
    const l = await lesson(ana, date, 10);
    expect(await retireCoach(dan.id, venueId)).toBe(true);
    expect(await (await change(manager.cookie, { code: l.code, date, start: H(10), coachId: dan.id })).json()).toMatchObject({ code: "COACH_NOT_FOUND" });
    expect(await (await change(manager.cookie, { code: l.code, date, start: H(10), coachId: swimCoach.id })).json()).toMatchObject({ code: "COACH_NOT_FOUND" });
    await lesson(ben, date, 10);
    expect(await (await change(manager.cookie, { code: l.code, date, start: H(10), coachId: ben.id })).json()).toMatchObject({ code: "COACH_TAKEN" });
    expect(await rescheduleBooking(l.code, { date, start: H(10), coachId: cara.id }, "customer")).toMatchObject({ ok: false, code: "RESCHEDULE_COACH" });
    // Nothing changed.
    expect(await coachHeld(l.id)).toEqual([ana.id]);
    expect(await getBookingById(l.id)).toMatchObject({ coachId: ana.id, coachFee: 80, totalPrice: 100 });
    expect(await changes(l.id)).toEqual([]);
  });
});

describe("a paid lesson to another coach", () => {
  it("is refused without the manager's word on the money, and with a lesson pack for its coach", async () => {
    const date = day(7);
    const l = await lesson(ana, date, 10);
    await setPaymentStatus(l.code, true, "cash");
    expect(await (await change(manager.cookie, { code: l.code, date, start: H(10), coachId: ben.id })).json()).toMatchObject({ code: "RESCHEDULE_COACH_PAID" });

    const pupil = await customer("Pack Holder");
    const pack = await issuePass({ venueId, name: "Five with Ana", entries: 5, entryMinutes: 60, price: 400, holderName: "Pack Holder", holderPhone: pupil.phone, userId: pupil.id, expiresOn: day(60), adminId: manager.id, coachId: ana.id });
    if (!pack.ok) throw new Error(pack.error);
    const packed = await lesson(ana, date, 12, { phone: pupil.phone, payWithPass: pack.pass.code }, pupil.cookie);
    expect((await getBookingById(packed.id))!.paymentStatus).toBe("paid");
    const res = await change(manager.cookie, { code: packed.code, date, start: H(12), coachId: ben.id, coachMoney: "keep" });
    expect(await res.json()).toMatchObject({ code: "LESSON_COACH_PASS", vars: { name: "Ana Lim" } });
    expect(await (await terms(packed.code, ben.id)).json()).toMatchObject({ code: "LESSON_COACH_PASS" });
    expect(await coachHeld(packed.id)).toEqual([ana.id]);
  });

  it("keeping the price as paid: the venue absorbs the difference, on the record; the receipt as sold is not rewritten", async () => {
    const date = day(8);
    const l = await lesson(ana, date, 10);
    await setPaymentStatus(l.code, true, "card");
    const before = await bookingSale(l.id);
    const res = await change(manager.cookie, { code: l.code, date, start: H(10), coachId: ben.id, coachMoney: "keep" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.booking).toMatchObject({ coachId: ben.id, coachFee: 100, totalPrice: 100, paymentStatus: "paid" });
    expect(body.unchargedDifference).toBe(0);
    expect(body.coachChange).toMatchObject({ money: "kept", absorbed: 20, owed: 0, refund: 0 });
    expect(await changes(l.id)).toEqual([expect.objectContaining({ money: "kept", absorbed: 20, owed: 0, refunded: 0 })]);
    expect((await logged(l.code, "lesson.coach_changed"))[0].detail).toContain("the venue absorbs");
    // What the customer paid for, as it was sold.
    expect(await bookingSale(l.id)).toEqual(before);
    expect(before!.lines.find((x) => x.description.startsWith("Coaching"))).toMatchObject({ description: "Coaching with Ana Lim", amount: 80 });
    const toCustomer = (await mails(l.id)).filter((m) => m.kind === "booking_rescheduled");
    expect(toCustomer.at(-1)!.body).toContain("The price stays as you paid it.");
    // The coach is owed their own fee.
    expect((await getBookingById(l.id))!.coachFee).toBe(100);
  });

  it("adjusting to a dearer coach: the difference is owed on the booking, taken once at the counter on its own receipt, and credited if it is cancelled", async () => {
    const date = day(9);
    const l = await lesson(ana, date, 10);
    await setPaymentStatus(l.code, true, "cash");
    const seen = (await (await terms(l.code, ben.id)).json()) as { keep: { absorbed: number }; adjust: { owed: number; refund: number } };
    expect(seen.keep.absorbed).toBe(20);
    expect(seen.adjust).toMatchObject({ owed: 20, refund: 0 });
    const res = await change(manager.cookie, { code: l.code, date, start: H(11), coachId: ben.id, coachMoney: "adjust" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.coachChange).toMatchObject({ money: "adjusted", owed: 20 });
    // Still paid as sold; the difference owed beside it, where the counter sees it.
    expect(body.booking).toMatchObject({ totalPrice: 100, paymentStatus: "paid", startMin: H(11) });
    const row = (await listBookingsForDate(date, venueId)).find((b) => b.code === l.code)!;
    expect(row.coachOwed).toEqual([{ changeId: expect.any(Number), amount: 20, coach: "Ben Tan" }]);
    expect((await mails(l.id)).filter((m) => m.subject.includes("is now with")).at(-1)!.body).toContain("more is owed for the new coach's fee");
    // A new time as well: the venue's change of time, as ever, which the customer acknowledges.
    expect((await mails(l.id)).filter((m) => m.kind === "booking_rescheduled" && !m.subject.includes("is now with"))).toHaveLength(1);

    const changeId = row.coachOwed![0].changeId;
    expect((await collect(deskCookie, { venueId, changeId, method: "bitcoin" })).status).toBe(400);
    const [a, b] = await Promise.all([collect(deskCookie, { venueId, changeId, method: "cash" }), collect(manager.cookie, { venueId, changeId, method: "qr" })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const receipt = await documentFor(`lesson-coach:${changeId}`);
    expect(receipt).toMatchObject({ kind: "receipt", total: 20 });
    expect(receipt!.lines[0].description).toContain("Coaching with Ben Tan in place of Ana Lim");
    expect((await listBookingsForDate(date, venueId)).find((x) => x.code === l.code)!.coachOwed).toBeUndefined();
    const journal = await salesJournal(venueId, todayISO(ZONE), day(1));
    expect(journal.find((r) => r.number === receipt!.number)).toMatchObject({ category: "Coaching", gross: 20 });

    // Cancelled by the venue: the lesson as sold and the difference taken are both credited.
    expect((await adminCancelBooking(l.code)).ok).toBe(true);
    const credit = (await getDb().prepare("SELECT total::float AS total FROM receipts WHERE kind = 'credit_note' AND credits_id = ?").get(receipt!.id)) as { total: number };
    expect(credit.total).toBe(20);
    expect(await documentFor(`booking:${l.id}`)).toMatchObject({ kind: "credit_note", total: 100 });
  });

  it("an owed difference not yet taken is no longer owed once the lesson is cancelled", async () => {
    const date = day(9);
    const l = await lesson(ana, date, 15);
    await setPaymentStatus(l.code, true, "cash");
    expect((await change(manager.cookie, { code: l.code, date, start: H(15), coachId: ben.id, coachMoney: "adjust" })).status).toBe(200);
    const changeId = (await listBookingsForDate(date, venueId)).find((x) => x.code === l.code)!.coachOwed![0].changeId;
    expect((await adminCancelBooking(l.code)).ok).toBe(true);
    expect(await collect(deskCookie, { venueId, changeId, method: "cash" }).then((r) => r.json())).toMatchObject({ code: "LESSON_COACH_NOTHING_OWED" });
  });

  it("adjusting to a cheaper coach, paid from credit: the difference back to credit with a credit note of its own; cancelling later gives back only the rest", async () => {
    const date = day(10);
    const pupil = await customer("Credit Pupil");
    expect((await topUpWallet({ userId: pupil.id, amount: 300, adminId: manager.id, venueId })).ok).toBe(true);
    const start = await getWalletBalance(pupil.id, venueId);
    const l = await lesson(ana, date, 10, { phone: pupil.phone, payFromWallet: true }, pupil.cookie);
    expect((await getBookingById(l.id))!.paymentStatus).toBe("paid");
    expect(await getWalletBalance(pupil.id, venueId)).toBe(start - 100);
    const before = await bookingSale(l.id);

    const res = await change(manager.cookie, { code: l.code, date, start: H(10), coachId: cara.id, coachMoney: "adjust" });
    expect(res.status).toBe(200);
    expect((await res.json()).coachChange).toMatchObject({ money: "adjusted", refund: 20, refundHow: "credit" });
    expect(await getWalletBalance(pupil.id, venueId)).toBe(start - 80);
    const note = await documentFor(`booking:${l.id}:coach:${(await getDb().prepare("SELECT id FROM lesson_coach_changes WHERE booking_id = ?").get(l.id) as { id: number }).id}`);
    expect(note).toMatchObject({ kind: "credit_note", total: 20, note: "receipt.why.coachChanged" });
    // The sale as it was sold; four fifths of it still paid.
    expect(await bookingSale(l.id)).toEqual(before);
    expect(await paidPartLeft(l.id)).toBeCloseTo(0.8, 5);
    expect((await mails(l.id)).filter((m) => m.subject.includes("is now with")).at(-1)!.body).toContain("has gone back to your credit");

    // Cancelled: the 80 left, and never the 20 twice.
    expect((await adminCancelBooking(l.code)).ok).toBe(true);
    expect(await getWalletBalance(pupil.id, venueId)).toBe(start);
    expect(await documentFor(`booking:${l.id}`)).toMatchObject({ kind: "credit_note", total: 80 });
  });

  it("adjusting to a cheaper coach, paid online: the difference owed back on the payment, the rest on cancelling, never more than was taken", async () => {
    const saved = await savePaymentSettings(venueId, { apiKey: "api-key-1234", collectionId: "col123", xSignatureKey: "S-key", sandbox: true, enabled: true });
    if (!saved.ok) throw new Error(saved.error);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: `cobill${++n}`, url: `https://www.billplz-sandbox.com/bills/cobill${n}` })));
    const date = day(11);
    const l = await lesson(ana, date, 10);
    expect((await startBookingPayment({ codes: [l.code], phone: l.phone })).ok).toBe(true);
    const bill = ((await getDb().prepare("SELECT bill_id FROM online_payments ORDER BY id DESC LIMIT 1").get()) as { bill_id: string }).bill_id;
    await settleBill({ billId: bill, paid: true, paidAt: null });
    expect((await getBookingById(l.id))!.paymentStatus).toBe("paid");
    const due = async () => Number(((await getDb().prepare("SELECT refund_due::float AS d FROM online_payments WHERE bill_id = ?").get(bill)) as { d: number }).d);

    const res = await change(manager.cookie, { code: l.code, date, start: H(10), coachId: cara.id, coachMoney: "adjust" });
    expect(res.status).toBe(200);
    expect((await res.json()).coachChange).toMatchObject({ refund: 20, refundHow: "online" });
    expect(await due()).toBe(20);
    expect((await mails(l.id)).filter((m) => m.subject.includes("is now with")).at(-1)!.body).toContain("is being refunded the way you paid");
    expect((await adminCancelBooking(l.code)).ok).toBe(true);
    expect(await due()).toBe(100);
  });

  it("adjusting to a cheaper coach, paid at the counter: a credit note, the money given back by hand", async () => {
    const date = day(12);
    const l = await lesson(ana, date, 10);
    await setPaymentStatus(l.code, true, "cash");
    const res = await change(manager.cookie, { code: l.code, date, start: H(10), coachId: cara.id, coachMoney: "adjust" });
    expect((await res.json()).coachChange).toMatchObject({ refund: 20, refundHow: "hand" });
    expect(await changes(l.id)).toEqual([expect.objectContaining({ money: "adjusted", refunded: 20, refund_how: "hand" })]);
    expect((await logged(l.code, "lesson.coach_changed"))[0].detail).toContain("back by hand");
    expect((await mails(l.id)).filter((m) => m.subject.includes("is now with")).at(-1)!.body).toContain("The venue will give you back");
  });
});

describe("at the same moment as a new lesson for the new coach's time", () => {
  it("a change to Ben and a lesson booked with Ben for the same hour: exactly one gets him", async () => {
    for (let round = 0; round < 4; round++) {
      const date = day([1, 2, 3, 13][round]);
      const l = await lesson(ana, date, 9);
      const [moved, rival] = await Promise.all([
        rescheduleBooking(l.code, { date, start: H(16), coachId: ben.id, changedBy: { adminId: manager.id, name: "Mei Manager" } }, "staff"),
        tryLesson(ben, date, 16),
      ]);
      const rivalWon = rival.status === 201;
      expect(moved.ok !== rivalWon).toBe(true);
      if (!moved.ok) {
        expect(moved.code).toBe("COACH_TAKEN");
        // The loser left nothing behind: still Ana's, at 9, no change recorded.
        expect(await coachHeld(l.id)).toEqual([ana.id]);
        expect(await changes(l.id)).toEqual([]);
      } else expect(await rival.json()).toMatchObject({ code: "COACH_TAKEN" });
      const held = (await getDb()
        .prepare("SELECT COUNT(*)::int AS n FROM coach_claims c JOIN bookings b ON b.id = c.booking_id WHERE c.coach_id = ? AND c.active AND b.date = ? AND b.start_min = ?")
        .get(ben.id, date, H(16))) as { n: number };
      expect(held.n).toBe(1);
    }
    expect(await checkIntegrity()).toEqual([]);
  });

  it("two managers giving the same paid lesson to a cheaper coach at once: it is settled once", async () => {
    const date = day(14);
    const l = await lesson(ana, date, 10);
    await setPaymentStatus(l.code, true, "cash");
    const go = () => rescheduleBooking(l.code, { date, start: H(10), coachId: cara.id, coachMoney: "adjust", changedBy: { adminId: manager.id, name: "Mei Manager" } }, "staff");
    const results = await Promise.all([go(), go()]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await changes(l.id)).toHaveLength(1);
    const notes = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM receipts WHERE source LIKE ?").get(`booking:${l.id}:coach:%`)) as { n: number };
    expect(notes.n).toBe(1);
  });
});
