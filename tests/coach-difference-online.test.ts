import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import { renderToStaticMarkup } from "react-dom/server";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";
process.env.MYSENAM_PAYMENT_PROVIDERS = "billplz,stripe";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { xSignature } from "../src/lib/billplz";
import { saveCoach, type Coach } from "../src/lib/coaching";
import { getDb } from "../src/lib/db";
import { bookingSale, documentFor } from "../src/lib/documents";
import { checkIntegrity } from "../src/lib/integrity";
import { changeOfPayToken, coachPayPath, coachPayToken, COACH_PAGE_MINUTES } from "../src/lib/lesson-coaches";
import { markRefunded, recordDispute, refundOnline, refundsOwed, refundStatusFor, savePaymentSettings, settleBill } from "../src/lib/payments";
import { adminCancelBooking as adminCancel, createCourt, createVenue, getBookingById, setPaymentStatus } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { POST as book, GET as lookup } from "../src/app/api/bookings/route";
import { GET as dayList } from "../src/app/api/admin/bookings/route";
import * as staffReschedule from "../src/app/api/admin/bookings/reschedule/route";
import * as lessonCoachRoute from "../src/app/api/admin/bookings/lesson-coach/route";
import { POST as staffCancel } from "../src/app/api/admin/bookings/cancel/route";
import { POST as payDifference } from "../src/app/api/payments/coach-difference/route";
import { POST as callback } from "../src/app/api/payments/[provider]/callback/route";
import PaymentReturnPage from "../src/app/payments/return/page";
import CoachDifferencePage from "../src/app/coach-difference/[token]/page";

/**
 * A dearer coach's difference paid online (owner's decision of 28 October
 * 2026; lib/lesson-coaches.ts, lib/payments.ts startCoachDifferencePayment;
 * docs/features/programmes.md#giving-a-lesson-to-another-coach): offered by
 * the email and the customer's booking page where the venue takes payment
 * online, the counter still an option; one owed amount paid once, whichever
 * way, with its own receipt; a failed or expired page leaves it owed; money
 * that comes too late (paid at the counter meanwhile, the lesson cancelled,
 * the coach changed back) is owed back and refunded once, never receipted;
 * cancelling after paying online refunds it with a credit note; the day's
 * figures count it. Against stand-ins for Stripe's and Billplz's APIs and
 * signed callbacks only: no live calls.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (k: number) => addDays(todayISO(ZONE), k);
const H = (h: number) => h * 60;
const STRIPE_SECRET = "whsec_coachdiff1234567890";
const BILLPLZ_SIGNATURE = "S-coach-diff-key";
let n = 0;

type Venue = { id: number; ana: Coach; ben: Coach; cara: Coach; manager: string; desk: string };
let stripeV: Venue;
let billplzV: Venue;
let offlineV: Venue;

let sent: { url: string; method: string; form: URLSearchParams | null }[] = [];
const stripeRefunds: { id: string; payment_intent: string }[] = [];

/** Stripe's and Billplz's APIs as far as these tests need them: pages opened, sessions read, refunds made. */
function fakeGateways() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string; body?: string } = {}) => {
      const form = init.body ? new URLSearchParams(init.body) : null;
      sent.push({ url, method: init.method ?? "GET", form });
      if (url.includes("billplz")) {
        const id = `cdbill${++n}`;
        return Response.json({ id, url: `https://www.billplz-sandbox.com/bills/${id}` });
      }
      if (url.includes("/refunds?payment_intent=")) {
        const pi = new URL(url).searchParams.get("payment_intent");
        return Response.json({ object: "list", data: stripeRefunds.filter((r) => r.payment_intent === pi) });
      }
      if (url.endsWith("/refunds")) {
        const made = { id: `re_cd${++n}`, status: "succeeded", payment_intent: form?.get("payment_intent") ?? "" };
        stripeRefunds.push(made);
        return Response.json(made);
      }
      if (init.method === "POST") {
        const id = `cs_test_cd${++n}`;
        return Response.json({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
      }
      const id = decodeURIComponent(url.split("/").pop()!);
      return Response.json({ id, payment_status: "paid", status: "complete", payment_intent: `pi_for_${id}` });
    })
  );
}

const stripeSigned = (body: string) => {
  const at = Math.floor(Date.now() / 1000);
  return `t=${at},v1=${crypto.createHmac("sha256", STRIPE_SECRET).update(`${at}.${body}`).digest("hex")}`;
};
async function stripeEvent(id: string, type: string, object: Record<string, unknown>) {
  const body = JSON.stringify({ id: `evt_${id}_${type}_${++n}`, type, created: Math.floor(Date.now() / 1000), data: { object: { id, object: "checkout.session", ...object } } });
  const res = await callback(
    new NextRequest("http://localhost/api/payments/stripe/callback", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": stripeSigned(body) },
      body,
    }),
    { params: Promise.resolve({ provider: "stripe" }) }
  );
  expect(res.status).toBe(200);
}
const stripePaid = (bill: string) => stripeEvent(bill, "checkout.session.completed", { payment_status: "paid", status: "complete" });
/** Billplz's server-to-server callback, signed with the venue's X Signature key. */
async function billplzSays(billId: string, paid: boolean) {
  // As Billplz documents the callback: the bill's collection, what it was for and what was paid (ADR 0065).
  const sen = String(Math.round(((await getDb().prepare("SELECT amount::float AS amount FROM online_payments WHERE bill_id = ?").get(billId)) as { amount: number }).amount * 100));
  const fields: Record<string, string> = { id: billId, collection_id: "colcd", paid: paid ? "true" : "false", amount: sen, paid_amount: paid ? sen : "0", paid_at: paid ? new Date().toISOString() : "", state: paid ? "paid" : "due" };
  fields.x_signature = xSignature(fields, BILLPLZ_SIGNATURE);
  const res = await callback(
    new NextRequest("http://localhost/api/payments/billplz/callback", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    }),
    { params: Promise.resolve({ provider: "billplz" }) }
  );
  expect(res.status).toBe(200);
}

const ip = () => `198.19.${++n % 250}.${n % 200}`;
type Lesson = { code: string; phone: string; id: number };
async function lesson(v: Venue, coach: Coach, date: string, hour: number): Promise<Lesson> {
  const phone = `01388${String(++n).padStart(5, "0")}`;
  const res = await book(
    new NextRequest("http://localhost/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip() },
      body: JSON.stringify({ venueId: v.id, sport: "tennis", date, start: H(hour), end: H(hour + 1), name: `Pupil ${n}`, phone, email: `cd${n}@learn.test`, coachId: coach.id }),
    })
  );
  const body = await res.json();
  if (res.status !== 201) throw new Error(JSON.stringify(body));
  return { code: body.booking.code, phone, id: body.booking.id };
}
const change = (cookie: string, body: Record<string, unknown>) =>
  staffReschedule.POST(
    new NextRequest("http://localhost/api/admin/bookings/reschedule", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) })
  );
const collect = (cookie: string, body: Record<string, unknown>) =>
  lessonCoachRoute.POST(
    new NextRequest("http://localhost/api/admin/bookings/lesson-coach", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) })
  );
const startPay = (body: Record<string, unknown>) =>
  payDifference(new NextRequest("http://localhost/api/payments/coach-difference", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip() }, body: JSON.stringify(body) }));
const customerView = async (l: Lesson) =>
  (await (
    await lookup(new NextRequest(`http://localhost/api/bookings?code=${l.code}&phone=${l.phone}`, { headers: { "x-forwarded-for": ip() } }))
  ).json()) as { payOnline: boolean; coachDifferences: { changeId: number; amount: number; coach: string; state: string; via: string | null; receiptUrl: string | null }[]; refunds: { owed: number }[] };
const figures = async (v: Venue, date: string) =>
  (await (await dayList(new NextRequest(`http://localhost/api/admin/bookings?date=${date}`, { headers: { cookie: v.manager } }))).json()) as {
    revenue: number;
    collected: number;
    outstanding: number;
    bookings: { code: string; coachOwed?: { changeId: number; amount: number; pageOpenUntil?: string }[]; coachPaid?: { changeId: number; via: string }[] }[];
  };
const changeRow = async (id: number) =>
  (await getDb()
    .prepare(
      `SELECT owed::float AS owed, owed_paid_at IS NOT NULL AS paid, owed_paid_via, owed_payment_id, owed_cleared_at IS NOT NULL AS cleared, owed_cleared_why,
              owed_pages, COALESCE(owed_page_until > now(), false) AS page_open
         FROM lesson_coach_changes WHERE id = ?`
    )
    .get(id)) as { owed: number; paid: boolean; owed_paid_via: string | null; owed_payment_id: number | null; cleared: boolean; owed_cleared_why: string | null; owed_pages: number; page_open: boolean };
const paymentsOf = async (changeId: number) =>
  (await getDb()
    .prepare("SELECT id, bill_id, status, amount::float AS amount, refund_due::float AS refund_due, refunded::float AS refunded, coach_attempt FROM online_payments WHERE coach_change_id = ? ORDER BY id")
    .all(changeId)) as { id: number; bill_id: string; status: string; amount: number; refund_due: number; refunded: number; coach_attempt: number }[];
const receiptsFor = async (changeId: number) =>
  (await getDb()
    .prepare(
      `SELECT kind, total::float AS total, paid_via FROM receipts
        WHERE source = ? OR source LIKE ? OR credits_id IN (SELECT id FROM receipts WHERE source = ? OR source LIKE ?) ORDER BY id`
    )
    .all(`lesson-coach:${changeId}`, `lesson-coach:${changeId}:%`, `lesson-coach:${changeId}`, `lesson-coach:${changeId}:%`)) as {
    kind: string;
    total: number;
    paid_via: string | null;
  }[];
const mailsTo = async (bookingId: number) =>
  (await getDb().prepare("SELECT kind, subject, body, dedupe_key FROM messages WHERE booking_id = ? AND channel = 'email' ORDER BY id").all(bookingId)) as {
    kind: string;
    subject: string;
    body: string;
    dedupe_key: string | null;
  }[];
const returnPage = async (bill: string) => renderToStaticMarkup(await PaymentReturnPage({ searchParams: Promise.resolve({ stripe_session: bill }) }));

/** A lesson with Ana, paid at the counter, given by the manager to Ben (dearer by 20), the price adjusted: 20 owed. */
async function owing(v: Venue, k: number, hour = 10): Promise<Lesson & { changeId: number; date: string }> {
  const date = day(k);
  const l = await lesson(v, v.ana, date, hour);
  await setPaymentStatus(l.code, true, "cash");
  const res = await change(v.manager, { code: l.code, date, start: H(hour), coachId: v.ben.id, coachMoney: "adjust" });
  const body = await res.json();
  if (res.status !== 200) throw new Error(JSON.stringify(body));
  expect(body.coachChange).toMatchObject({ owed: 20 });
  return { ...l, changeId: body.coachChange.id as number, date };
}
/** Open a page for it from the email's link, through the stand-in gateway: the bill's id. */
async function openPage(changeId: number): Promise<string> {
  fakeGateways();
  const res = await startPay({ token: coachPayToken(changeId) });
  vi.unstubAllGlobals();
  const body = await res.json();
  if (res.status !== 200) throw new Error(JSON.stringify(body));
  return body.url.split("/").pop();
}

async function makeVenue(name: string, gateway: "stripe" | "billplz" | null): Promise<Venue> {
  const made = await createVenue({ name, area: "Bangsar", address: "1 Jalan Beza", phone: `03222${String(++n).padStart(5, "0")}` });
  if (!made.ok) throw new Error("venue");
  const id = made.venue.id;
  await getDb().prepare("UPDATE venues SET published_at = now() WHERE id = ?").run(id);
  for (const court of ["Court 1", "Court 2", "Court 3"]) {
    const c = await createCourt({ venueId: id, name: court, sport: "tennis", offPeakRate: 20, peakRate: 20 });
    if (!c.ok) throw new Error("court");
  }
  const hours = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: H(7), until: H(22) }));
  const save = async (coach: string, rate: number) => {
    const s = await saveCoach(id, { name: coach, sports: ["tennis"], rate, hours });
    if (!s.ok) throw new Error(s.error);
    return s.coach;
  };
  const staff = async (who: string, role: "manager" | "desk") => {
    const a = await createAdmin({ name: who, email: `${who.toLowerCase().replace(/\W/g, "")}${n}@diff.test`, password: "a long enough password", venueId: id, role });
    if (!a.ok) throw new Error(a.error);
    return `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(a.admin.id)).token}`;
  };
  if (gateway === "stripe") {
    const saved = await savePaymentSettings(id, { provider: "stripe", credentials: { secretKey: "rk_test_coachdiff1234567", webhookSecret: STRIPE_SECRET }, sandbox: true, enabled: true });
    if (!saved.ok) throw new Error(saved.error);
  } else if (gateway === "billplz") {
    const saved = await savePaymentSettings(id, { provider: "billplz", apiKey: "api-key-coachdiff", collectionId: "colcd", xSignatureKey: BILLPLZ_SIGNATURE, sandbox: true, enabled: true });
    if (!saved.ok) throw new Error(saved.error);
  }
  return { id, ana: await save("Ana Lim", 80), ben: await save("Ben Tan", 100), cara: await save("Cara Ong", 60), manager: await staff(`Mei ${name}`, "manager"), desk: await staff(`Dino ${name}`, "desk") };
}

beforeAll(async () => {
  stripeV = await makeVenue("Stripe Tennis", "stripe");
  billplzV = await makeVenue("Billplz Tennis", "billplz");
  offlineV = await makeVenue("Counter Tennis", null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  sent = [];
});

afterAll(() => {
  delete process.env.MYSENAM_PAYMENT_PROVIDERS;
});

describe("the link", () => {
  it("names one change, checked by a keyed hash: anything else is no link", () => {
    expect(changeOfPayToken(coachPayToken(42))).toBe(42);
    expect(coachPayPath(42)).toBe(`/coach-difference/${coachPayToken(42)}`);
    expect(changeOfPayToken(coachPayToken(42).replace(/^42/, "43"))).toBeNull();
    expect(changeOfPayToken("42-" + "0".repeat(32))).toBeNull();
    expect(changeOfPayToken("nonsense")).toBeNull();
    expect(changeOfPayToken(undefined)).toBeNull();
  });
});

describe("paying a dearer coach's difference online (Stripe)", () => {
  it("is offered by the email and the booking page; paid once, on its own receipt; the counter waits while the page is open; the day's figures count it", async () => {
    const l = await owing(stripeV, 2);
    const before = await bookingSale(l.id);

    // The email offers the link, and the counter still.
    const told = (await mailsTo(l.id)).filter((m) => m.subject.includes("is now with")).at(-1)!;
    expect(told.body).toContain(coachPayPath(l.changeId));
    expect(told.body).toContain("Or pay it at the venue.");
    // So does the customer's booking page, and the link's own page.
    const seen = await customerView(l);
    expect(seen.payOnline).toBe(true);
    expect(seen.coachDifferences).toEqual([{ changeId: l.changeId, amount: 20, coach: "Ben Tan", state: "owed", via: null, receiptUrl: null }]);
    const linkPage = renderToStaticMarkup(await CoachDifferencePage({ params: Promise.resolve({ token: coachPayToken(l.changeId) }) }));
    expect(linkPage).toContain("Pay RM20 online");
    expect(linkPage).toContain("Or pay it at the venue&#x27;s counter.");

    // Owed, it is expected and outstanding for the day.
    let f = await figures(stripeV, l.date);
    expect(f).toMatchObject({ revenue: 120, collected: 100, outstanding: 20 });

    // A page for exactly the amount, closing when it stops counting as open.
    const opened = Math.floor(Date.now() / 1000);
    const bill = await openPage(l.changeId);
    const checkout = sent.find((s) => s.method === "POST" && s.url.endsWith("/checkout/sessions"))!;
    expect(Number(checkout.form!.get("expires_at")) - opened).toBeGreaterThanOrEqual(COACH_PAGE_MINUTES * 60 - 5);
    expect(Number(checkout.form!.get("expires_at")) - opened).toBeLessThanOrEqual(COACH_PAGE_MINUTES * 60 + 60);
    expect(await paymentsOf(l.changeId)).toEqual([expect.objectContaining({ bill_id: bill, status: "pending", amount: 20, coach_attempt: 1 })]);
    // The booking page sends the customer back to the same page, not a second.
    fakeGateways();
    const again = await startPay({ code: l.code, phone: l.phone, changeId: l.changeId });
    vi.unstubAllGlobals();
    expect(await again.json()).toMatchObject({ url: `https://checkout.stripe.com/c/pay/${bill}`, amount: 20, reused: true });
    expect(sent.filter((s) => s.method === "POST" && s.url.endsWith("/checkout/sessions"))).toHaveLength(1);
    // Somebody else's booking page cannot reach it.
    expect((await startPay({ code: l.code, phone: "0123456789", changeId: l.changeId })).status).toBe(404);

    // The counter sees it being paid, and does not take it meanwhile.
    f = await figures(stripeV, l.date);
    expect(f.bookings.find((b) => b.code === l.code)!.coachOwed![0].pageOpenUntil).toBeTruthy();
    expect((await customerView(l)).coachDifferences[0].state).toBe("paying");
    const refused = await collect(stripeV.desk, { venueId: stripeV.id, changeId: l.changeId, method: "cash" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "LESSON_COACH_PAGE_OPEN", vars: { n: expect.any(Number) } });

    // Paid: the gateway says so twice (callback and return page), and it is settled once.
    fakeGateways();
    await stripePaid(bill);
    const back = await returnPage(bill);
    await stripePaid(bill);
    vi.unstubAllGlobals();
    expect(back).toContain("Difference paid");
    expect(await changeRow(l.changeId)).toMatchObject({ paid: true, owed_paid_via: "online", page_open: false });
    const [payment] = await paymentsOf(l.changeId);
    expect(payment).toMatchObject({ status: "paid", refund_due: 0 });
    expect((await changeRow(l.changeId)).owed_payment_id).toBe(payment.id);
    expect(await receiptsFor(l.changeId)).toEqual([{ kind: "receipt", total: 20, paid_via: "Online (Stripe)" }]);
    expect(await documentFor(`payment:${payment.id}`)).toBeNull();
    // The lesson's own receipt is as it was sold.
    expect(await bookingSale(l.id)).toEqual(before);
    // The customer is sent the receipt, once.
    expect((await mailsTo(l.id)).filter((m) => m.dedupe_key === `coach-paid:${l.changeId}`)).toHaveLength(1);

    // Paid, it is collected; the counter has nothing left to take.
    f = await figures(stripeV, l.date);
    expect(f).toMatchObject({ revenue: 120, collected: 120, outstanding: 0 });
    const row = f.bookings.find((b) => b.code === l.code)!;
    expect(row.coachOwed).toBeUndefined();
    expect(row.coachPaid).toEqual([expect.objectContaining({ changeId: l.changeId, via: "online" })]);
    expect(await (await collect(stripeV.desk, { venueId: stripeV.id, changeId: l.changeId, method: "cash" })).json()).toMatchObject({ code: "LESSON_COACH_NOTHING_OWED" });
    const view = await customerView(l);
    expect(view.coachDifferences[0]).toMatchObject({ state: "paid", via: "online", receiptUrl: expect.stringMatching(/^\/receipt\//) });
    expect(await (await startPay({ token: coachPayToken(l.changeId) })).json()).toMatchObject({ code: "LESSON_COACH_PAID" });
    expect(await checkIntegrity()).toEqual([]);
  });

  it("an expired page leaves the difference owed, nothing reverted; the counter takes it then, and a new page can be opened", async () => {
    const l = await owing(stripeV, 3);
    const bill = await openPage(l.changeId);
    fakeGateways();
    await stripeEvent(bill, "checkout.session.expired", { payment_status: "unpaid", status: "expired" });
    vi.unstubAllGlobals();
    expect(await changeRow(l.changeId)).toMatchObject({ owed: 20, paid: false, cleared: false, page_open: false });
    expect((await getBookingById(l.id))!).toMatchObject({ coachId: stripeV.ben.id, coachFee: 100, totalPrice: 100, paymentStatus: "paid" });
    expect(await receiptsFor(l.changeId)).toEqual([]);
    // A second page is a second attempt.
    const second = await openPage(l.changeId);
    expect(second).not.toBe(bill);
    expect((await paymentsOf(l.changeId)).map((p) => p.coach_attempt)).toEqual([1, 2]);
  });
});

describe("a failed page (Billplz)", () => {
  it("leaves it owed and the counter free; the customer can try again and pay", async () => {
    const l = await owing(billplzV, 2);
    const bill = await openPage(l.changeId);
    // Billplz cannot close a page at a set time: none was asked for.
    expect(sent.find((s) => s.url.includes("billplz"))).toBeDefined();
    await billplzSays(bill, false);
    expect(await changeRow(l.changeId)).toMatchObject({ owed: 20, paid: false, page_open: false });
    expect((await customerView(l)).coachDifferences[0].state).toBe("owed");
    const second = await openPage(l.changeId);
    await billplzSays(second, true);
    await billplzSays(second, true);
    expect(await changeRow(l.changeId)).toMatchObject({ paid: true, owed_paid_via: "online" });
    expect(await receiptsFor(l.changeId)).toEqual([{ kind: "receipt", total: 20, paid_via: "Online (Billplz)" }]);
    // The failed page, paid after all, is a second payment: owed back.
    await billplzSays(bill, true);
    const [first, paid] = await paymentsOf(l.changeId);
    expect(first).toMatchObject({ status: "paid", refund_due: 20 });
    expect(paid).toMatchObject({ status: "paid", refund_due: 0 });
    expect(await receiptsFor(l.changeId)).toHaveLength(1);
  });
});

describe("money that comes too late", () => {
  it("a page paid after the counter took it (the page closed to do so) is owed back and refunded once, never a second receipt", async () => {
    const l = await owing(stripeV, 4);
    const bill = await openPage(l.changeId);
    const taken = await collect(stripeV.desk, { venueId: stripeV.id, changeId: l.changeId, method: "cash", closePage: true });
    expect(taken.status).toBe(200);
    expect(await taken.json()).toMatchObject({ amount: 20, closedPage: true });
    const log = (await getDb().prepare("SELECT detail FROM staff_actions WHERE booking_code = ? AND action = 'lesson.coach_difference_paid'").all(l.code)) as { detail: string }[];
    expect(log.at(-1)!.detail).toContain("open payment page closed");
    // The gateway's page was still payable, and the customer paid it.
    fakeGateways();
    await stripePaid(bill);
    expect(await returnPage(bill)).toContain("Already settled");
    vi.unstubAllGlobals();
    expect(await changeRow(l.changeId)).toMatchObject({ paid: true, owed_paid_via: "cash", owed_payment_id: null });
    const [late] = await paymentsOf(l.changeId);
    expect(late).toMatchObject({ status: "paid", refund_due: 20, refunded: 0 });
    expect(await receiptsFor(l.changeId)).toEqual([{ kind: "receipt", total: 20, paid_via: "Cash" }]);
    expect(await documentFor(`payment:${late.id}`)).toBeNull();
    // Owed back, on the venue's list with the lesson's code, and on the customer's page.
    expect((await refundsOwed(stripeV.id)).find((p) => p.id === late.id)).toMatchObject({ refundOwed: 20, bookingCodes: [l.code], purpose: "coach" });
    expect((await refundStatusFor([l.id])).find((r) => r.paymentId === late.id)).toMatchObject({ owed: 20 });
    // Counted once in the day's figures: as collected at the counter.
    expect(await figures(stripeV, l.date)).toMatchObject({ revenue: 120, collected: 120, outstanding: 0 });
    // Refunded once.
    fakeGateways();
    expect(await refundOnline(late.id, stripeV.id)).toMatchObject({ ok: true });
    expect(await refundOnline(late.id, stripeV.id)).toMatchObject({ ok: false });
    vi.unstubAllGlobals();
    expect(stripeRefunds.filter((r) => r.payment_intent === `pi_for_${bill}`)).toHaveLength(1);
    expect((await paymentsOf(l.changeId))[0]).toMatchObject({ refund_due: 20, refunded: 20 });
  });

  it("a Billplz page paid after it stopped counting as open, the counter having taken it: owed back, marked refunded once", async () => {
    const l = await owing(billplzV, 3);
    const bill = await openPage(l.changeId);
    // No word from Billplz, and the page's time is up: the counter takes it without closing anything.
    await getDb().prepare("UPDATE lesson_coach_changes SET owed_page_until = now() - interval '1 minute' WHERE id = ?").run(l.changeId);
    expect((await collect(billplzV.desk, { venueId: billplzV.id, changeId: l.changeId, method: "qr" })).status).toBe(200);
    await billplzSays(bill, true);
    const [late] = await paymentsOf(l.changeId);
    expect(late).toMatchObject({ refund_due: 20 });
    expect(await receiptsFor(l.changeId)).toHaveLength(1);
    expect(await refundOnline(late.id, billplzV.id)).toMatchObject({ ok: false });
    expect(await markRefunded(late.id, billplzV.id, null, "FPX ref 77")).toMatchObject({ ok: true });
    expect(await markRefunded(late.id, billplzV.id)).toMatchObject({ ok: false });
  });

  it("a Billplz page paid late while the difference is still owed pays it: it is what was owed", async () => {
    const l = await owing(billplzV, 4);
    const bill = await openPage(l.changeId);
    await getDb().prepare("UPDATE lesson_coach_changes SET owed_page_until = now() - interval '1 minute' WHERE id = ?").run(l.changeId);
    await billplzSays(bill, true);
    expect(await changeRow(l.changeId)).toMatchObject({ paid: true, owed_paid_via: "online" });
    expect((await paymentsOf(l.changeId))[0]).toMatchObject({ refund_due: 0 });
  });

  it("the lesson given back to its first coach while the page was open: nothing owed either way, and the page paid later is owed back", async () => {
    const l = await owing(billplzV, 5);
    const bill = await openPage(l.changeId);
    const res = await change(billplzV.manager, { code: l.code, date: l.date, start: H(10), coachId: billplzV.ana.id, coachMoney: "adjust" });
    expect(res.status).toBe(200);
    // Counted from what the customer has paid for (Ana's 80): no difference, no refund, and the 20 no longer owed.
    expect((await res.json()).coachChange).toMatchObject({ owed: 0, refund: 0, earlierOwed: 20 });
    expect(await changeRow(l.changeId)).toMatchObject({ cleared: true, owed_cleared_why: "superseded", page_open: false });
    expect((await mailsTo(l.id)).filter((m) => m.subject.includes("is now with")).at(-1)!.body).toContain("is no longer owed");
    expect(await figures(billplzV, l.date)).toMatchObject({ revenue: 100, collected: 100, outstanding: 0 });
    expect(renderToStaticMarkup(await CoachDifferencePage({ params: Promise.resolve({ token: coachPayToken(l.changeId) }) }))).toContain("Nothing is owed for this any more");
    expect(await (await startPay({ token: coachPayToken(l.changeId) })).json()).toMatchObject({ code: "LESSON_COACH_NOTHING_OWED" });
    await billplzSays(bill, true);
    expect((await paymentsOf(l.changeId))[0]).toMatchObject({ status: "paid", refund_due: 20 });
    expect(await receiptsFor(l.changeId)).toEqual([]);
    const log = (await getDb().prepare("SELECT detail FROM staff_actions WHERE booking_code = ? AND action = 'lesson.coach_changed'").all(l.code)) as { detail: string }[];
    expect(log.at(-1)!.detail).toContain("still owed for an earlier change, no longer owed");
  });

  it("the lesson given to a cheaper coach while 20 is still owed: counted from what was paid for, 20 back and the 20 owed no more", async () => {
    const l = await owing(billplzV, 6);
    const terms = (await (
      await lessonCoachRoute.GET(new NextRequest(`http://localhost/api/admin/bookings/lesson-coach?code=${l.code}&coachId=${billplzV.cara.id}`, { headers: { cookie: billplzV.manager } }))
    ).json()) as { adjust: { owed: number; refund: number; earlierOwed: number }; keep: { absorbed: number } };
    expect(terms.adjust).toMatchObject({ owed: 0, refund: 20, earlierOwed: 20 });
    expect(terms.keep.absorbed).toBe(-20);
    const res = await change(billplzV.manager, { code: l.code, date: l.date, start: H(10), coachId: billplzV.cara.id, coachMoney: "adjust" });
    expect((await res.json()).coachChange).toMatchObject({ refund: 20, refundHow: "hand", earlierOwed: 20 });
    expect(await changeRow(l.changeId)).toMatchObject({ cleared: true, owed_cleared_why: "superseded" });
  });

  it("a page paid after the lesson was cancelled is owed back", async () => {
    const l = await owing(stripeV, 5);
    const bill = await openPage(l.changeId);
    const cancelled = await staffCancel(
      new NextRequest("http://localhost/api/admin/bookings/cancel", { method: "POST", headers: { "content-type": "application/json", cookie: stripeV.manager }, body: JSON.stringify({ code: l.code }) })
    );
    expect(cancelled.status).toBe(200);
    expect(await changeRow(l.changeId)).toMatchObject({ cleared: true, owed_cleared_why: "cancelled" });
    fakeGateways();
    await stripePaid(bill);
    vi.unstubAllGlobals();
    expect((await paymentsOf(l.changeId))[0]).toMatchObject({ status: "paid", refund_due: 20 });
    expect(await receiptsFor(l.changeId)).toEqual([]);
  });
});

describe("cancelling a lesson whose difference was paid online", () => {
  it("credits the difference's receipt and refunds it through the venue's refund path, once, with the lesson", async () => {
    await getDb().prepare("UPDATE venues SET online_refunds = 'gateway' WHERE id = ?").run(stripeV.id);
    try {
      const l = await owing(stripeV, 6);
      const bill = await openPage(l.changeId);
      fakeGateways();
      await stripePaid(bill);
      const res = await staffCancel(
        new NextRequest("http://localhost/api/admin/bookings/cancel", { method: "POST", headers: { "content-type": "application/json", cookie: stripeV.manager }, body: JSON.stringify({ code: l.code }) })
      );
      vi.unstubAllGlobals();
      expect(res.status).toBe(200);
      const receipts = await receiptsFor(l.changeId);
      expect(receipts).toEqual([
        { kind: "receipt", total: 20, paid_via: "Online (Stripe)" },
        expect.objectContaining({ kind: "credit_note", total: 20 }),
      ]);
      // The lesson as sold is credited too, by its own credit note.
      expect(await documentFor(`booking:${l.id}`)).toMatchObject({ kind: "credit_note", total: 100 });
      expect((await paymentsOf(l.changeId))[0]).toMatchObject({ refund_due: 20, refunded: 20 });
      expect(stripeRefunds.filter((r) => r.payment_intent === `pi_for_${bill}`)).toHaveLength(1);
      // Asked again, nothing more goes back.
      fakeGateways();
      expect(await refundOnline((await paymentsOf(l.changeId))[0].id, stripeV.id)).toMatchObject({ ok: false });
      vi.unstubAllGlobals();
      expect(await receiptsFor(l.changeId)).toHaveLength(2);
    } finally {
      await getDb().prepare("UPDATE venues SET online_refunds = 'staff' WHERE id = ?").run(stripeV.id);
    }
  });
});

describe("a difference paid online and lost to a chargeback", () => {
  it("has its receipt credited and is owed again, at the counter or online", async () => {
    const l = await owing(stripeV, 9);
    const bill = await openPage(l.changeId);
    fakeGateways();
    await stripePaid(bill);
    vi.unstubAllGlobals();
    const lost = await recordDispute("stripe", bill, { disputeId: `dp_cd${++n}`, paymentRef: `pi_for_${bill}`, amountMinor: 2000, reason: "fraudulent", status: "lost", dueBy: null, outcome: "lost" });
    expect(lost).not.toBeNull();
    expect(await receiptsFor(l.changeId)).toEqual([
      { kind: "receipt", total: 20, paid_via: "Online (Stripe)" },
      expect.objectContaining({ kind: "credit_note", total: 20 }),
    ]);
    expect(await changeRow(l.changeId)).toMatchObject({ paid: false, owed_payment_id: null, cleared: false });
    expect(await figures(stripeV, l.date)).toMatchObject({ revenue: 120, collected: 100, outstanding: 20 });
    // Paid again at the counter: a receipt of its own; cancelled, that one is credited, the first not twice.
    expect((await collect(stripeV.desk, { venueId: stripeV.id, changeId: l.changeId, method: "card" })).status).toBe(200);
    expect(await documentFor(`lesson-coach:${l.changeId}:2`)).toMatchObject({ kind: "receipt", total: 20, paidVia: "Card terminal" });
    expect((await customerView(l)).coachDifferences[0]).toMatchObject({ state: "paid", via: "card" });
    await adminCancel(l.code);
    expect((await receiptsFor(l.changeId)).map((r) => [r.kind, r.total])).toEqual([
      ["receipt", 20],
      ["credit_note", 20],
      ["receipt", 20],
      ["credit_note", 20],
    ]);
  });
});

describe("where the venue does not take payment online", () => {
  it("the email asks for it at the venue, the booking page says the counter, and no page can be opened", async () => {
    const l = await owing(offlineV, 2);
    const told = (await mailsTo(l.id)).filter((m) => m.subject.includes("is now with")).at(-1)!;
    expect(told.body).toContain("please pay it at the venue");
    expect(told.body).not.toContain("/coach-difference/");
    const seen = await customerView(l);
    expect(seen.payOnline).toBe(false);
    expect(seen.coachDifferences[0]).toMatchObject({ state: "owed", amount: 20 });
    const refused = await startPay({ token: coachPayToken(l.changeId) });
    expect(await refused.json()).toMatchObject({ code: "LESSON_COACH_PAY_OFFLINE" });
    expect(renderToStaticMarkup(await CoachDifferencePage({ params: Promise.resolve({ token: coachPayToken(l.changeId) }) }))).toContain("Pay it at the venue&#x27;s counter.");
  });
});

describe("restrictions kept", () => {
  it("a lesson part paid as a deposit or by others still keeps its coach", async () => {
    const date = day(7);
    const l = await lesson(stripeV, stripeV.ana, date, 10);
    await getDb().prepare("UPDATE bookings SET shares_paid = 20, deposit_paid = 20 WHERE id = ?").run(l.id);
    const res = await change(stripeV.manager, { code: l.code, date, start: H(10), coachId: stripeV.ben.id, coachMoney: "adjust" });
    expect(await res.json()).toMatchObject({ code: "LESSON_COACH_PART_PAID" });
    expect((await getBookingById(l.id))!.coachId).toBe(stripeV.ana.id);
  });
});

describe("at the same moment", () => {
  it("two clicks to pay open one page", async () => {
    const l = await owing(billplzV, 8);
    fakeGateways();
    const [a, b] = await Promise.all([startPay({ token: coachPayToken(l.changeId) }), startPay({ code: l.code, phone: l.phone, changeId: l.changeId })]);
    vi.unstubAllGlobals();
    const bodies = [await a.json(), await b.json()];
    expect(bodies.filter((x) => x.url && x.reused === false)).toHaveLength(1);
    for (const x of bodies) if (!(x.url && x.reused === false)) expect(x.reused === true || x.code === "LESSON_COACH_PAGE_OPENING").toBe(true);
    expect(await paymentsOf(l.changeId)).toHaveLength(1);
    expect(sent.filter((s) => s.url.includes("billplz") && s.method === "POST")).toHaveLength(1);
  });

  it("the counter closing the page and the gateway's word that it was paid: the difference is paid once, and the other money owed back", async () => {
    for (let round = 0; round < 4; round++) {
      const l = await owing(billplzV, 9 + round, 9 + round);
      const bill = await openPage(l.changeId);
      const [counter] = await Promise.all([
        collect(billplzV.desk, { venueId: billplzV.id, changeId: l.changeId, method: "cash", closePage: true }),
        billplzSays(bill, true),
      ]);
      const row = await changeRow(l.changeId);
      const [payment] = await paymentsOf(l.changeId);
      expect(row.paid).toBe(true);
      expect(payment.status).toBe("paid");
      if (counter.status === 200) {
        expect(row.owed_paid_via).toBe("cash");
        expect(payment.refund_due).toBe(20);
      } else {
        expect(await counter.json()).toMatchObject({ code: "LESSON_COACH_NOTHING_OWED" });
        expect(row.owed_paid_via).toBe("online");
        expect(payment.refund_due).toBe(0);
      }
      expect(await receiptsFor(l.changeId)).toHaveLength(1);
    }
    expect(await checkIntegrity()).toEqual([]);
  });

  it("a webhook and the return page at once settle it once", async () => {
    const l = await owing(stripeV, 8);
    const bill = await openPage(l.changeId);
    fakeGateways();
    await Promise.all([stripePaid(bill), returnPage(bill), settleBill({ billId: bill, paid: true, paidAt: null })]);
    vi.unstubAllGlobals();
    expect(await receiptsFor(l.changeId)).toHaveLength(1);
    expect((await paymentsOf(l.changeId))[0]).toMatchObject({ status: "paid", refund_due: 0 });
    expect((await mailsTo(l.id)).filter((m) => m.dedupe_key === `coach-paid:${l.changeId}`)).toHaveLength(1);
  });
});
