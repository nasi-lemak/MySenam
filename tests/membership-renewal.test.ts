import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "crypto";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.sg";
process.env.MYSENAM_COUNTRY = "SG";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { getDb } from "../src/lib/db";
import { registerUser } from "../src/lib/auth";
import { addMonths, createPlan } from "../src/lib/membership-plans";
import { documentsForUser } from "../src/lib/documents";
import { renewalFor, renewsByItself, savePaymentSettings, startMembershipPayment, stopRenewal, stopRenewalOf } from "../src/lib/payments";
import { createVenue, listMembershipsFor } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { POST as callback } from "../src/app/api/payments/[provider]/callback/route";

/**
 * A membership that renews itself through the venue's Stripe: the first
 * payment starts a subscription, each later charge makes the next
 * membership run on from the last, and the member or the venue can stop it.
 */

const SECRET = "whsec_testsecret1234567890";
const KEY = "rk_test_abcdefghijklmnop";
let venueId: number;
let planId: number;
let user: { id: number; name: string; email: string };
let n = 0;
let sent: { url: string; method: string; form: URLSearchParams | null }[] = [];

function fakeStripe() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string; body?: string }) => {
      sent.push({ url, method: init.method ?? "GET", form: init.body ? new URLSearchParams(init.body) : null });
      if (init.method === "DELETE") return Response.json({ id: url.split("/").pop(), object: "subscription", status: "canceled" });
      const id = `cs_test_member${++n}`;
      return Response.json({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
    })
  );
}

function signed(body: string) {
  const at = Math.floor(Date.now() / 1000);
  return `t=${at},v1=${crypto.createHmac("sha256", SECRET).update(`${at}.${body}`).digest("hex")}`;
}

const post = (event: object) => {
  const body = JSON.stringify(event);
  return callback(
    new NextRequest("http://localhost/api/payments/stripe/callback", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signed(body) },
      body,
    }),
    { params: Promise.resolve({ provider: "stripe" }) }
  );
};

const completed = (sessionId: string, subscription: string) => ({
  id: `evt_${sessionId}`,
  type: "checkout.session.completed",
  created: Math.floor(Date.now() / 1000),
  data: { object: { id: sessionId, object: "checkout.session", payment_status: "paid", subscription } },
});

const invoicePaid = (invoice: string, subscription: string, reason = "subscription_cycle", amount = 12000) => ({
  id: `evt_${invoice}`,
  type: "invoice.paid",
  created: Math.floor(Date.now() / 1000),
  data: { object: { id: invoice, object: "invoice", billing_reason: reason, amount_paid: amount, parent: { subscription_details: { subscription } } } },
});

beforeAll(async () => {
  const made = await createVenue({ name: "Tanjong Club", area: "Tanjong Pagar", address: "x", phone: "61234000" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const saved = await savePaymentSettings(venueId, { credentials: { secretKey: KEY, webhookSecret: SECRET }, sandbox: true, enabled: true });
  if (!saved.ok) throw new Error(saved.error);
  const plan = await createPlan(venueId, { name: "Quarterly", months: 3, price: 120 });
  if (!plan.ok) throw new Error("plan");
  planId = plan.plan.id;
  const u = await registerUser({ name: "Mei Ling", email: "mei@example.sg", phone: "91230000", password: "a long enough password" });
  if (!u.ok) throw new Error(u.error);
  user = u.user;
});

afterEach(() => {
  vi.unstubAllGlobals();
  sent = [];
});

afterAll(() => {
  delete process.env.MYSENAM_COUNTRY;
});

describe("joining with auto-renewal", () => {
  it("is offered where the venue's gateway can charge each period", async () => {
    expect(await renewsByItself(venueId)).toBe(true);
  });

  it("opens a Stripe subscription for the plan's price every plan period", async () => {
    fakeStripe();
    const started = await startMembershipPayment(user, planId, { autoRenew: true });
    expect(started.ok).toBe(true);
    const form = sent[0].form!;
    expect(form.get("mode")).toBe("subscription");
    expect(form.get("line_items[0][price_data][recurring][interval]")).toBe("month");
    expect(form.get("line_items[0][price_data][recurring][interval_count]")).toBe("3");
    expect(form.get("line_items[0][price_data][unit_amount]")).toBe("12000");
  });

  it("makes the membership and remembers the subscription once the first payment is in", async () => {
    expect((await post(completed("cs_test_member1", "sub_mei"))).status).toBe(200);
    const [first] = await listMembershipsFor(user.id);
    expect(first).toMatchObject({ startsOn: todayISO(), expiresOn: addDays(addMonths(todayISO(), 3), -1) });
    expect(await renewalFor(user.id, venueId)).toMatchObject({ until: first.expiresOn });
  });
});

describe("each later charge", () => {
  it("makes the next membership, run on from the last, with its receipt", async () => {
    const before = (await renewalFor(user.id, venueId))!.until!;
    expect((await post(invoicePaid("in_mei_2", "sub_mei"))).status).toBe(200);
    // Stripe retries: the same charge again changes nothing.
    expect((await post(invoicePaid("in_mei_2", "sub_mei"))).status).toBe(200);
    const memberships = await listMembershipsFor(user.id);
    expect(memberships).toHaveLength(2);
    const next = memberships.find((m) => m.startsOn === addDays(before, 1))!;
    expect(next.expiresOn).toBe(addDays(addMonths(addDays(before, 1), 3), -1));
    expect(await renewalFor(user.id, venueId)).toMatchObject({ until: next.expiresOn });
    const receipts = (await documentsForUser(user.id)).filter((d) => d.lines[0].description.startsWith("Membership"));
    expect(receipts).toHaveLength(2);
    expect(receipts[0]).toMatchObject({ total: 120, paidVia: "Online (Stripe)" });
  });

  it("is not counted for the first invoice, which the checkout already settled", async () => {
    expect((await post(invoicePaid("in_mei_1", "sub_mei", "subscription_create"))).status).toBe(200);
    expect(await listMembershipsFor(user.id)).toHaveLength(2);
  });

  it("is ignored for a subscription that is not a membership's", async () => {
    expect((await post(invoicePaid("in_other", "sub_someone_else"))).status).toBe(200);
    expect((await getDb().prepare("SELECT COUNT(*)::int AS n FROM online_payments WHERE bill_id = 'in_other'").get()) as { n: number }).toEqual({ n: 0 });
  });

  it("must be signed by the venue's Stripe", async () => {
    const body = JSON.stringify(invoicePaid("in_forged", "sub_mei"));
    const res = await callback(
      new NextRequest("http://localhost/api/payments/stripe/callback", {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=00" },
        body,
      }),
      { params: Promise.resolve({ provider: "stripe" }) }
    );
    expect(res.status).toBe(400);
    expect(await listMembershipsFor(user.id)).toHaveLength(2);
  });
});

describe("stopping", () => {
  it("the member stops it: Stripe is told, and nothing more is charged", async () => {
    const renewal = (await renewalFor(user.id, venueId))!;
    fakeStripe();
    expect(await stopRenewal(user.id + 1, renewal.id)).toMatchObject({ ok: false }); // not theirs
    expect(await stopRenewal(user.id, renewal.id)).toEqual({ ok: true });
    expect(sent).toEqual([expect.objectContaining({ method: "DELETE", url: "https://api.stripe.com/v1/subscriptions/sub_mei" })]);
    expect(await renewalFor(user.id, venueId)).toBeNull();
    // The memberships already paid for run to their end.
    expect((await listMembershipsFor(user.id)).every((m) => m.status === "active")).toBe(true);
  });

  it("the venue voiding the membership stops it too", async () => {
    const u = await registerUser({ name: "Raj", email: "raj@example.sg", phone: "91230001", password: "a long enough password" });
    if (!u.ok) throw new Error(u.error);
    fakeStripe();
    await startMembershipPayment(u.user, planId, { autoRenew: true });
    const session = sent[0] ? `cs_test_member${n}` : "";
    await post(completed(session, "sub_raj"));
    const [m] = await listMembershipsFor(u.user.id);
    sent = [];
    expect(await stopRenewalOf(m.id)).toBeNull();
    expect(sent).toEqual([expect.objectContaining({ method: "DELETE", url: "https://api.stripe.com/v1/subscriptions/sub_raj" })]);
  });

  it("Stripe ending it is heard", async () => {
    const u = await registerUser({ name: "Siti", email: "siti@example.sg", phone: "91230002", password: "a long enough password" });
    if (!u.ok) throw new Error(u.error);
    fakeStripe();
    await startMembershipPayment(u.user, planId, { autoRenew: true });
    await post(completed(`cs_test_member${n}`, "sub_siti"));
    expect(await renewalFor(u.user.id, venueId)).not.toBeNull();
    const ended = {
      id: "evt_end", type: "customer.subscription.deleted", created: Math.floor(Date.now() / 1000),
      data: { object: { id: "sub_siti", object: "subscription" } },
    };
    expect((await post(ended)).status).toBe(200);
    expect(await renewalFor(u.user.id, venueId)).toBeNull();
  });
});
