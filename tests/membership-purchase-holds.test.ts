import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "crypto";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";
process.env.MYSENAM_PAYMENT_PROVIDERS = "billplz,stripe";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { xSignature } from "../src/lib/billplz";
import { getDb } from "../src/lib/db";
import { billplz } from "../src/lib/gateways/billplz";
import { stripe } from "../src/lib/gateways/stripe";
import { addManaged } from "../src/lib/managed-people";
import { addDays, todayISO } from "../src/lib/time";
import { addMonths, createPlan } from "../src/lib/membership-plans";
import { attachPayment, HOLD_MINUTES, releaseLapsedPurchases } from "../src/lib/membership-purchases";
import {
  markRefunded,
  membershipPageMinutes,
  paymentByBill,
  refundOnline,
  refundsOwed,
  savePaymentSettings,
  settleBill,
  startMembershipPayment,
  stopRenewal,
  renewalsFor,
} from "../src/lib/payments";
import { createVenue, listMembershipsFor, participantMembership } from "../src/lib/store";
import * as myMembership from "../src/app/api/my/membership/route";
import * as voidRoute from "../src/app/api/admin/memberships/[id]/void/route";
import { POST as callback } from "../src/app/api/payments/[provider]/callback/route";

/**
 * A membership purchase's hold against each gateway's own payment page
 * (lib/membership-purchases.ts; docs/features/payments-and-credit.md): the
 * owner's decision of 27 October 2026 that the 60-minute hold stays where the
 * gateway fits it. Stripe can close its page at a set time (30 minutes to a
 * day), so it closes when the hold does; Billplz cannot, so its page outlives
 * the hold and late money is settled as such. Both through stand-ins for the
 * gateways' APIs and signed callbacks: no live calls.
 */

const STRIPE_SECRET = "whsec_holdsecret1234567890";
const BILLPLZ_SIGNATURE = "S-hold-signature-key";
let stripeVenue: number;
let billplzVenue: number;
let plans: { stripeKid: number; stripeOther: number; billplzKid: number };
let manager: string;
let n = 0;
let sent: { url: string; method: string; form: URLSearchParams | null }[] = [];
const refunds: { id: string; payment_intent: string; metadata: Record<string, string>; status: string }[] = [];

/** Stripe's and Billplz's APIs as far as these tests need them: pages opened, sessions read, refunds made. */
function fakeGateways() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string; body?: string } = {}) => {
      const form = init.body ? new URLSearchParams(init.body) : null;
      sent.push({ url, method: init.method ?? "GET", form });
      if (url.includes("billplz")) {
        const id = `holdbill${++n}`;
        return Response.json({ id, url: `https://www.billplz-sandbox.com/bills/${id}` });
      }
      if (url.includes("/refunds?payment_intent=")) {
        const pi = new URL(url).searchParams.get("payment_intent");
        return Response.json({ object: "list", data: refunds.filter((r) => r.payment_intent === pi) });
      }
      if (url.endsWith("/refunds")) {
        const made = { id: `re_hold${++n}`, status: "succeeded", payment_intent: form?.get("payment_intent") ?? "", metadata: { mysenam_key: form?.get("metadata[mysenam_key]") ?? "" } };
        refunds.push(made);
        return Response.json(made);
      }
      if (init.method === "DELETE") return Response.json({ id: url.split("/").pop(), object: "subscription", status: "canceled" });
      if (init.method === "POST") {
        const id = `cs_test_hold${++n}`;
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
/** Billplz's server-to-server callback, signed with the venue's X Signature key. */
async function billplzPaid(billId: string) {
  const fields: Record<string, string> = { id: billId, paid: "true", paid_at: new Date().toISOString(), state: "paid" };
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

type Adult = { id: number; name: string; email: string; phone: string; cookie: string };
async function adult(name: string): Promise<Adult> {
  const k = ++n;
  const phone = `01${String(70000000 + k).padStart(8, "0")}`;
  const made = await registerUser({ name: `${name} ${k}`, email: `hold${k}@example.my`, phone, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return { ...made.user, phone, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}
async function child(parent: Adult, displayName: string) {
  const made = await addManaged(parent.id, { displayName, relationship: "parent", authority: true }, parent.name);
  if (!made.ok) throw new Error(made.error);
  return { id: made.person.id, name: made.person.displayName };
}
async function buy(who: Adult, planId: number, participantId: number, autoRenew = false) {
  fakeGateways();
  const started = await startMembershipPayment(who, planId, { participantId, autoRenew });
  vi.unstubAllGlobals();
  if (!started.ok) throw new Error(`${started.code}: ${started.error}`);
  return started.url.split("/").pop()!;
}
const purchaseOf = async (billId: string) =>
  (await getDb()
    .prepare(
      `SELECT pu.status, pu.why, pu.membership_id, pu.page_closes_at IS NULL AS page_open,
              EXTRACT(EPOCH FROM (pu.hold_until - pu.created_at))::float / 60 AS hold_minutes,
              EXTRACT(EPOCH FROM (pu.hold_until - pu.page_closes_at))::float AS hold_past_page
         FROM membership_purchases pu JOIN online_payments p ON p.id = pu.payment_id WHERE p.bill_id = ?`
    )
    .get(billId)) as { status: string; why: string | null; membership_id: number | null; page_open: boolean; hold_minutes: number; hold_past_page: number | null };
/** The hold lapses: as if an hour had gone by. */
const lapse = (billId: string) =>
  getDb()
    .prepare(
      "UPDATE membership_purchases SET hold_until = now() - interval '1 minute', page_closes_at = CASE WHEN page_closes_at IS NULL THEN NULL ELSE now() - interval '1 minute' END WHERE payment_id = (SELECT id FROM online_payments WHERE bill_id = ?)"
    )
    .run(billId);

beforeAll(async () => {
  const s = await createVenue({ name: "Stripe Swim Club", area: "KL", address: "x", phone: "0312340000" });
  const b = await createVenue({ name: "Billplz Swim Club", area: "PJ", address: "y", phone: "0312340001" });
  if (!s.ok || !b.ok) throw new Error("venue");
  stripeVenue = s.venue.id;
  billplzVenue = b.venue.id;
  const saved = await savePaymentSettings(stripeVenue, { provider: "stripe", credentials: { secretKey: "rk_test_holdkey1234567", webhookSecret: STRIPE_SECRET }, sandbox: true, enabled: true });
  if (!saved.ok) throw new Error(saved.error);
  const savedB = await savePaymentSettings(billplzVenue, { provider: "billplz", apiKey: "api-key-hold", collectionId: "colhold", xSignatureKey: BILLPLZ_SIGNATURE, sandbox: true, enabled: true });
  if (!savedB.ok) throw new Error(savedB.error);
  const plan = async (venueId: number, input: Record<string, unknown>) => {
    const made = await createPlan(venueId, input as Parameters<typeof createPlan>[1]);
    if (!made.ok) throw new Error(made.error);
    return made.plan.id;
  };
  plans = {
    stripeKid: await plan(stripeVenue, { name: "Junior", months: 3, price: 90, offeredFor: "participant" }),
    stripeOther: await plan(stripeVenue, { name: "Junior Plus", months: 6, price: 150, offeredFor: "participant" }),
    billplzKid: await plan(billplzVenue, { name: "Junior", months: 3, price: 80, offeredFor: "participant" }),
  };
  const admin = await createAdmin({ name: "Manager", email: "hold-manager@example.my", password: "a long enough password", venueId: stripeVenue, role: "manager" });
  if (!admin.ok) throw new Error(admin.error);
  manager = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(admin.admin.id)).token}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  sent = [];
});

afterAll(() => {
  delete process.env.MYSENAM_PAYMENT_PROVIDERS;
});

describe("how long a page stays open, gateway by gateway", () => {
  it("is the hold where the gateway can close a page (Stripe: 30 minutes to a day), and nothing where it cannot (Billplz)", () => {
    expect(HOLD_MINUTES).toBe(60);
    expect(membershipPageMinutes(stripe)).toBe(60);
    expect(membershipPageMinutes(billplz)).toBeNull();
    // A gateway that could close a page no sooner than 90 minutes: the hold is kept until it does.
    expect(membershipPageMinutes({ pageExpiry: { minMinutes: 90, maxMinutes: 600 } })).toBe(90);
    expect(membershipPageMinutes({ pageExpiry: { minMinutes: 5, maxMinutes: 45 } })).toBe(45);
  });

  it("Stripe: the page is asked to close when the hold ends, and the hold is kept until it does", async () => {
    const parent = await adult("Stripe");
    const kid = await child(parent, "Aina");
    const before = Math.floor(Date.now() / 1000);
    const bill = await buy(parent, plans.stripeKid, kid.id);
    const opened = sent.find((s) => s.method === "POST" && s.url.endsWith("/checkout/sessions"))!;
    const closesAt = Number(opened.form!.get("expires_at"));
    expect(closesAt - before).toBeGreaterThanOrEqual(60 * 60 - 5);
    expect(closesAt - before).toBeLessThanOrEqual(60 * 60 + 60);
    const purchase = await purchaseOf(bill);
    expect(purchase).toMatchObject({ status: "pending", page_open: false });
    expect(purchase.hold_minutes).toBeGreaterThanOrEqual(60);
    expect(purchase.hold_past_page).toBeGreaterThanOrEqual(0);
  });

  it("Billplz: the page cannot be closed, so none is asked for, and the hold is the hour", async () => {
    const parent = await adult("Billplz");
    const kid = await child(parent, "Badrul");
    const bill = await buy(parent, plans.billplzKid, kid.id);
    const opened = sent.find((s) => s.url.includes("billplz"))!;
    expect([...opened.form!.keys()].some((k) => /due|expir/.test(k))).toBe(false);
    const purchase = await purchaseOf(bill);
    expect(purchase).toMatchObject({ status: "pending", page_open: true });
    expect(Math.round(purchase.hold_minutes)).toBe(60);
  });

  it("a hold attached to a page that closes later than the hold is kept until the page closes", async () => {
    const parent = await adult("Longer");
    const kid = await child(parent, "Cempaka");
    const bill = await buy(parent, plans.billplzKid, kid.id);
    const { id } = (await getDb().prepare("SELECT pu.id, pu.payment_id FROM membership_purchases pu JOIN online_payments p ON p.id = pu.payment_id WHERE p.bill_id = ?").get(bill)) as { id: number };
    const payment = (await getDb().prepare("SELECT id FROM online_payments WHERE bill_id = ?").get(bill)) as { id: number };
    await attachPayment(id, payment.id, 90);
    const purchase = await purchaseOf(bill);
    expect(purchase.hold_past_page).toBeGreaterThanOrEqual(0);
    expect(purchase.hold_minutes).toBeGreaterThanOrEqual(89);
  });
});

describe("a hold that lapses", () => {
  it("expires on its own on the scheduler's tick, and never makes a membership unpaid", async () => {
    const parent = await adult("Lapse");
    const kid = await child(parent, "Dahlia");
    const bill = await buy(parent, plans.billplzKid, kid.id);
    await lapse(bill);
    expect(await releaseLapsedPurchases()).toBeGreaterThanOrEqual(1);
    expect(await purchaseOf(bill)).toMatchObject({ status: "released", why: "expired", membership_id: null });
    expect(await participantMembership(billplzVenue, kid.id)).toBeNull();
    expect(await listMembershipsFor(parent.id)).toEqual([]);
    // Released, and said so: nothing pending.
    const res = await myMembership.GET(new NextRequest("http://localhost/api/my/membership", { headers: { cookie: parent.cookie } }));
    expect(((await res.json()) as { pending: unknown[] }).pending).toEqual([]);
  });

  it("Billplz money that still comes in after the hold lapsed makes the membership while it still can; callback and return, each twice, make one", async () => {
    const parent = await adult("Late");
    const kid = await child(parent, "Ehsan");
    const bill = await buy(parent, plans.billplzKid, kid.id);
    await lapse(bill);
    await releaseLapsedPurchases();
    await billplzPaid(bill);
    await billplzPaid(bill);
    await settleBill({ billId: bill, paid: true, paidAt: null });
    await settleBill({ billId: bill, paid: true, paidAt: null });
    const mine = await listMembershipsFor(parent.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ holderParticipantId: kid.id, price: 80, startsOn: todayISO(), expiresOn: addDays(addMonths(todayISO(), 3), -1) });
    expect(await purchaseOf(bill)).toMatchObject({ status: "made", membership_id: mine[0].id });
    expect(await paymentByBill(bill)).toMatchObject({ status: "paid", refundOwed: 0 });
  });

  it("Billplz money for a lapsed purchase that can no longer be made is owed back, listed for staff, and marked refunded once", async () => {
    const parent = await adult("Twice");
    const kid = await child(parent, "Farah");
    const first = await buy(parent, plans.billplzKid, kid.id);
    await lapse(first);
    // The hold let her go: a second purchase names her, and is paid.
    const second = await buy(parent, plans.billplzKid, kid.id);
    await billplzPaid(second);
    expect(await listMembershipsFor(parent.id)).toHaveLength(1);
    // Then the first page, still payable at Billplz, is paid too.
    await billplzPaid(first);
    await billplzPaid(first);
    expect(await listMembershipsFor(parent.id)).toHaveLength(1);
    expect(await purchaseOf(first)).toMatchObject({ status: "owed_back", why: "MBO_TOO_EARLY", membership_id: null });
    const owed = (await refundsOwed(billplzVenue)).find((p) => p.billId === first);
    expect(owed).toMatchObject({ purpose: "membership", refundOwed: 80 });
    // Billplz has no refund API: staff refund in its dashboard, then mark it done, once.
    expect(await refundOnline(owed!.id, billplzVenue)).toMatchObject({ ok: false });
    expect(await markRefunded(owed!.id, billplzVenue, null, "FPX ref 123")).toMatchObject({ ok: true });
    expect(await markRefunded(owed!.id, billplzVenue)).toMatchObject({ ok: false });
    expect((await refundsOwed(billplzVenue)).some((p) => p.billId === first)).toBe(false);
  });

  it("Stripe money confirmed late (a method that settles after the page closed) is made if it still can be, otherwise owed back and refunded through Stripe once", async () => {
    const parent = await adult("Async");
    const kid = await child(parent, "Gopal");
    const late = await buy(parent, plans.stripeKid, kid.id);
    // The page is completed with the money still on its way: nothing is made, and the hold lets her go.
    await stripeEvent(late, "checkout.session.completed", { payment_status: "unpaid", status: "complete" });
    expect(await purchaseOf(late)).toMatchObject({ status: "released", membership_id: null });
    expect(await participantMembership(stripeVenue, kid.id)).toBeNull();
    // Another purchase for her is paid meanwhile.
    const other = await buy(parent, plans.stripeKid, kid.id);
    await stripeEvent(other, "checkout.session.completed", { payment_status: "paid", status: "complete" });
    expect(await listMembershipsFor(parent.id)).toHaveLength(1);
    // The first one's money lands after all, reported twice: owed back, once.
    await stripeEvent(late, "checkout.session.async_payment_succeeded", { payment_status: "paid", status: "complete" });
    await stripeEvent(late, "checkout.session.async_payment_succeeded", { payment_status: "paid", status: "complete" });
    expect(await listMembershipsFor(parent.id)).toHaveLength(1);
    expect(await purchaseOf(late)).toMatchObject({ status: "owed_back" });
    const owed = (await refundsOwed(stripeVenue)).find((p) => p.billId === late)!;
    expect(owed.refundOwed).toBe(90);
    fakeGateways();
    expect(await refundOnline(owed.id, stripeVenue)).toMatchObject({ ok: true });
    expect(await refundOnline(owed.id, stripeVenue)).toMatchObject({ ok: false });
    expect(sent.filter((s) => s.method === "POST" && s.url.endsWith("/refunds"))).toHaveLength(1);
    expect(sent.find((s) => s.url.endsWith("/refunds"))!.form!.get("amount")).toBe("9000");
  });

  it("Stripe money for a lapsed purchase that is still valid makes the membership", async () => {
    const parent = await adult("Valid");
    const kid = await child(parent, "Hui");
    const bill = await buy(parent, plans.stripeKid, kid.id);
    await stripeEvent(bill, "checkout.session.completed", { payment_status: "unpaid", status: "complete" });
    await lapse(bill);
    await stripeEvent(bill, "checkout.session.async_payment_succeeded", { payment_status: "paid", status: "complete" });
    expect(await listMembershipsFor(parent.id)).toMatchObject([{ holderParticipantId: kid.id, price: 90 }]);
    expect(await purchaseOf(bill)).toMatchObject({ status: "made" });
  });
});

describe("a membership bought online, refunded", () => {
  const voidIt = (id: number, body?: unknown) =>
    voidRoute.POST(
      new NextRequest(`http://localhost/api/admin/memberships/${id}/void`, {
        method: "POST",
        headers: { cookie: manager, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      { params: Promise.resolve({ id: String(id) }) }
    );

  it("cancelled by the venue with the money back: owed back in full in the same change, listed, and refunded through Stripe once", async () => {
    const parent = await adult("Refund");
    const kid = await child(parent, "Indah");
    const bill = await buy(parent, plans.stripeKid, kid.id);
    await stripeEvent(bill, "checkout.session.completed", { payment_status: "paid", status: "complete" });
    const [m] = await listMembershipsFor(parent.id);
    const res = await voidIt(m.id, { refund: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ membership: { status: "void" }, owedBack: 90 });
    expect(await participantMembership(stripeVenue, kid.id)).toBeNull();
    const owed = (await refundsOwed(stripeVenue)).find((p) => p.billId === bill)!;
    expect(owed.refundOwed).toBe(90);
    fakeGateways();
    expect(await refundOnline(owed.id, stripeVenue)).toMatchObject({ ok: true });
    expect(await refundOnline(owed.id, stripeVenue)).toMatchObject({ ok: false });
    // Voided again: refused, and nothing more owed.
    expect((await voidIt(m.id, { refund: true })).status).toBe(409);
    expect(await paymentByBill(bill)).toMatchObject({ refundOwed: 0, refunded: 90 });
    const log = (await getDb().prepare("SELECT detail FROM staff_actions WHERE action = 'membership.voided' ORDER BY id DESC LIMIT 1").get()) as { detail: string };
    expect(log.detail).toContain("owed back");
  });

  it("cancelled without the money back: nothing is owed, as before", async () => {
    const parent = await adult("Keep");
    const kid = await child(parent, "Jaya");
    const bill = await buy(parent, plans.stripeKid, kid.id);
    await stripeEvent(bill, "checkout.session.completed", { payment_status: "paid", status: "complete" });
    const [m] = await listMembershipsFor(parent.id);
    const res = await voidIt(m.id);
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("owedBack");
    expect(await paymentByBill(bill)).toMatchObject({ refundOwed: 0 });
  });
});

describe("another plan for somebody whose membership renews by itself", () => {
  it("is refused until it stops renewing; then it starts when the current one ends, at its own price", async () => {
    const parent = await adult("Tier");
    const kid = await child(parent, "Kamal");
    const bill = await buy(parent, plans.stripeKid, kid.id, true);
    await stripeEvent(bill, "checkout.session.completed", { payment_status: "paid", status: "complete", subscription: "sub_tier" });
    const [current] = await listMembershipsFor(parent.id);
    // Into the renewal window.
    await getDb().prepare("UPDATE memberships SET expires_on = ? WHERE id = ?").run(addDays(todayISO(), 10), current.id);
    fakeGateways();
    expect(await startMembershipPayment(parent, plans.stripeOther, { participantId: kid.id })).toMatchObject({ ok: false, code: "MBO_RENEWS" });
    const [renewal] = await renewalsFor(parent.id, stripeVenue);
    expect((await stopRenewal(parent.id, renewal.id)).ok).toBe(true);
    const next = await buy(parent, plans.stripeOther, kid.id);
    await stripeEvent(next, "checkout.session.completed", { payment_status: "paid", status: "complete" });
    const both = await listMembershipsFor(parent.id);
    expect(both).toHaveLength(2);
    const upgraded = both.find((m) => m.id !== current.id)!;
    // Nothing prorated: the current term stands as paid, the new plan from the day after it, at its price.
    expect(upgraded).toMatchObject({ startsOn: addDays(todayISO(), 11), price: 150, tierId: plans.stripeOther });
    expect((await listMembershipsFor(parent.id)).find((m) => m.id === current.id)).toMatchObject({ price: 90, status: "active" });
  });
});
