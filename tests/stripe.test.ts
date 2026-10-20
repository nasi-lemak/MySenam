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
import { offeredGateways } from "../src/lib/gateways";
import { stripe, stripeSignatureValid } from "../src/lib/gateways/stripe";
import { paymentByBill, paymentSettings, savePaymentSettings, startBookingPayment } from "../src/lib/payments";
import { createBooking, createCourt, createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { POST as callback } from "../src/app/api/payments/[provider]/callback/route";

/**
 * Stripe Checkout for a Singapore install: the venue's own Stripe account,
 * reports by signed webhook, and a return address that is checked with Stripe
 * rather than believed.
 */

const SECRET = "whsec_testsecret1234567890";
const KEY = "rk_test_abcdefghijklmnop";
let venueId: number;
let code: string;
let sent: { url: string; method: string; auth: string | null; form: URLSearchParams | null }[] = [];
let n = 0;
/** What the fake Stripe says a session looks like when asked. */
const sessions = new Map<string, { payment_status: string; status: string }>();

function fakeStripe() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
      sent.push({
        url,
        method: init.method ?? "GET",
        auth: init.headers?.Authorization ?? null,
        form: init.body ? new URLSearchParams(init.body) : null,
      });
      if (init.method === "POST") {
        const id = `cs_test_session${++n}`;
        sessions.set(id, { payment_status: "unpaid", status: "open" });
        return Response.json({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
      }
      const id = decodeURIComponent(url.split("/").pop()!);
      const s = sessions.get(id);
      return s ? Response.json({ id, ...s }) : Response.json({ error: { message: "No such session" } }, { status: 404 });
    })
  );
}

function signed(body: string, secret = SECRET, at = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac("sha256", secret).update(`${at}.${body}`).digest("hex");
  return `t=${at},v1=${sig}`;
}

function event(type: string, sessionId: string, paymentStatus = "paid") {
  return JSON.stringify({
    id: `evt_${sessionId}`,
    type,
    created: 1_790_000_000,
    data: { object: { id: sessionId, object: "checkout.session", payment_status: paymentStatus } },
  });
}

const post = (body: string, signature: string | null) =>
  callback(
    new NextRequest("http://localhost/api/payments/stripe/callback", {
      method: "POST",
      headers: { "content-type": "application/json", ...(signature ? { "stripe-signature": signature } : {}) },
      body,
    }),
    { params: Promise.resolve({ provider: "stripe" }) }
  );

beforeAll(async () => {
  const made = await createVenue({ name: "Kallang Courts", area: "Kallang", address: "x", phone: "61234567" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 18.5, peakRate: 24 });
  if (!court.ok) throw new Error("court");
  const booked = await createBooking({
    courtId: court.court.id,
    date: addDays(todayISO(), 2),
    hours: [9],
    name: "Wei Ling",
    phone: "91234567",
    email: "weiling@example.sg",
  });
  if (!booked.ok) throw new Error(booked.error);
  code = booked.booking.code;
});

afterEach(() => {
  vi.unstubAllGlobals();
  sent = [];
});

afterAll(() => {
  delete process.env.MYSENAM_COUNTRY;
});

describe("connecting a Stripe account", () => {
  it("is what a Singapore install offers", () => {
    expect(offeredGateways().map((g) => g.id)).toEqual(["stripe"]);
  });

  it("checks the key and the signing secret look right", async () => {
    expect(await savePaymentSettings(venueId, { credentials: { secretKey: "pk_live_nope", webhookSecret: SECRET }, sandbox: true, enabled: true })).toMatchObject({
      ok: false,
    });
    expect(await savePaymentSettings(venueId, { credentials: { secretKey: KEY, webhookSecret: "nope" }, sandbox: true, enabled: true })).toMatchObject({
      ok: false,
    });
    const saved = await savePaymentSettings(venueId, { credentials: { secretKey: KEY, webhookSecret: SECRET }, sandbox: true, enabled: true });
    expect(saved).toMatchObject({ ok: true, settings: { provider: "stripe", details: { secretKey: "mnop", webhookSecret: "7890" } } });
    const settings = await paymentSettings(venueId);
    expect(settings.choices[0]).toMatchObject({ id: "stripe", callbackUrl: "https://book.example.sg/api/payments/stripe/callback" });
  });
});

describe("paying", () => {
  it("opens a Checkout session in dollars and cents, with the venue's key", async () => {
    fakeStripe();
    const started = await startBookingPayment({ codes: [code], phone: "91234567" });
    expect(started).toMatchObject({ ok: true, amount: 18.5, url: "https://checkout.stripe.com/c/pay/cs_test_session1" });
    const call = sent[0];
    expect(call.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(call.auth).toBe(`Bearer ${KEY}`);
    expect(call.form!.get("line_items[0][price_data][currency]")).toBe("sgd");
    expect(call.form!.get("line_items[0][price_data][unit_amount]")).toBe("1850");
    expect(call.form!.get("customer_email")).toBe("weiling@example.sg");
    expect(call.form!.get("success_url")).toBe("https://book.example.sg/payments/return?stripe_session={CHECKOUT_SESSION_ID}");
    const row = (await getDb().prepare("SELECT provider FROM online_payments WHERE bill_id = 'cs_test_session1'").get()) as { provider: string };
    expect(row.provider).toBe("stripe");
  });

  it("settles on a signed webhook, and only a signed one", async () => {
    const body = event("checkout.session.completed", "cs_test_session1");
    expect((await post(body, null)).status).toBe(400);
    expect((await post(body, signed(body, "whsec_guessed1234567890"))).status).toBe(400);
    // Replayed long after it was sent.
    expect((await post(body, signed(body, SECRET, Math.floor(Date.now() / 1000) - 3600))).status).toBe(400);
    expect((await paymentByBill("cs_test_session1"))?.status).toBe("pending");

    expect((await post(body, signed(body))).status).toBe(200);
    expect((await paymentByBill("cs_test_session1"))?.status).toBe("paid");
    // Stripe retries; the same event again changes nothing and is still OK.
    expect((await post(body, signed(body))).status).toBe(200);
  });

  it("waits for PayNow-style payments that complete later", async () => {
    fakeStripe();
    const other = await createBooking({
      courtId: (await getDb().prepare("SELECT id FROM courts WHERE venue_id = ?").get(venueId) as { id: number }).id,
      date: addDays(todayISO(), 3),
      hours: [10],
      name: "Arjun",
      phone: "92345678",
      email: "arjun@example.sg",
    });
    if (!other.ok) throw new Error(other.error);
    await startBookingPayment({ codes: [other.booking.code], phone: "92345678" });
    const id = "cs_test_session2";
    const unpaid = event("checkout.session.completed", id, "unpaid");
    expect((await post(unpaid, signed(unpaid))).status).toBe(200);
    expect((await paymentByBill(id))?.status).toBe("pending");
    const later = event("checkout.session.async_payment_succeeded", id);
    expect((await post(later, signed(later))).status).toBe(200);
    expect((await paymentByBill(id))?.status).toBe("paid");
  });

  it("answers OK to other events on the account, and settles nothing", async () => {
    const body = JSON.stringify({ id: "evt_x", type: "customer.created", data: { object: { id: "cus_1", object: "customer" } } });
    expect((await post(body, signed(body))).status).toBe(200);
  });
});

describe("coming back from Stripe", () => {
  it("is checked with Stripe, not believed", async () => {
    fakeStripe();
    expect(stripe.readRedirect(new URLSearchParams("billplz[id]=x"))).toBeNull();
    expect(stripe.readRedirect(new URLSearchParams("stripe_session=not-a-session"))).toBeNull();
    const inbound = stripe.readRedirect(new URLSearchParams("stripe_session=cs_test_session3"))!;
    const account = { provider: "stripe" as const, sandbox: true, credentials: { secretKey: KEY, webhookSecret: SECRET } };
    // Unknown to Stripe: nothing.
    expect(await inbound.verify(account)).toBeNull();
    sessions.set("cs_test_session3", { payment_status: "paid", status: "complete" });
    expect(await inbound.verify(account)).toEqual({ billId: "cs_test_session3", paid: true, paidAt: null });
    expect(sent.at(-1)).toMatchObject({ method: "GET", url: "https://api.stripe.com/v1/checkout/sessions/cs_test_session3", auth: `Bearer ${KEY}` });
  });
});

describe("the signature check", () => {
  it("accepts any of several v1 signatures while a secret is rolled", () => {
    const body = "{}";
    const at = Math.floor(Date.now() / 1000);
    const good = crypto.createHmac("sha256", SECRET).update(`${at}.${body}`).digest("hex");
    expect(stripeSignatureValid(body, `t=${at},v1=${"0".repeat(64)},v1=${good}`, SECRET)).toBe(true);
    expect(stripeSignatureValid(body, `t=${at},v0=${good}`, SECRET)).toBe(false);
    expect(stripeSignatureValid(body, `v1=${good}`, SECRET)).toBe(false);
    expect(stripeSignatureValid("{ }", `t=${at},v1=${good}`, SECRET)).toBe(false);
  });
});
