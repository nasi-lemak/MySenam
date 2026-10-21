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
import { addDays, isPeak, todayISO } from "../src/lib/time";
import { POST as callback } from "../src/app/api/payments/[provider]/callback/route";
import { POST as book } from "../src/app/api/bookings/route";
import { setHoldPolicy } from "../src/lib/holds";

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
  // An off-peak morning, whatever day the suite runs on.
  let offPeak = addDays(todayISO(), 2);
  while (isPeak(offPeak, 9)) offPeak = addDays(offPeak, 1);
  const booked = await createBooking({
    courtId: court.court.id,
    date: offPeak,
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

describe("test or live", () => {
  it("follows the key, whatever the sandbox switch says", async () => {
    const other = await createVenue({ name: "Live Hall", area: "x", address: "x", phone: "61234568" });
    if (!other.ok) throw new Error("venue");
    expect(
      await savePaymentSettings(other.venue.id, { credentials: { secretKey: KEY, webhookSecret: SECRET }, sandbox: false, enabled: true })
    ).toMatchObject({ ok: true, settings: { sandbox: true } });
    expect(
      await savePaymentSettings(other.venue.id, { credentials: { secretKey: "rk_live_abcdefghijklmnop", webhookSecret: SECRET }, sandbox: true, enabled: true })
    ).toMatchObject({ ok: true, settings: { sandbox: false } });
    expect((await paymentSettings(other.venue.id)).choices[0].sandboxFromKey).toBe(true);
  });

  it("checks the key can open Checkout sessions", async () => {
    const other = await createVenue({ name: "Check Hall", area: "x", address: "x", phone: "61234569" });
    if (!other.ok) throw new Error("venue");
    const save = () =>
      savePaymentSettings(other.venue.id, { credentials: { secretKey: KEY, webhookSecret: SECRET }, sandbox: true, enabled: true, check: true });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 403 })));
    expect(await save()).toMatchObject({ ok: false, error: expect.stringContaining("set Checkout Sessions to Write") });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    expect(await save()).toMatchObject({ ok: false, error: expect.stringContaining("did not accept that key") });
    const calls: { url: string; auth?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
        calls.push({ url, auth: init.headers.Authorization });
        return Response.json({ data: [] });
      })
    );
    expect(await save()).toMatchObject({ ok: true });
    expect(calls).toEqual([{ url: "https://api.stripe.com/v1/checkout/sessions?limit=1", auth: `Bearer ${KEY}` }]);
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

describe("a booking held while it is paid for", () => {
  it("gets a page that closes with the hold, and a fresh one once that has run down", async () => {
    expect(await setHoldPolicy(venueId, { on: true, minutes: 15 })).toMatchObject({ ok: true });
    const courtId = (await getDb().prepare("SELECT id FROM courts WHERE venue_id = ?").get(venueId) as { id: number }).id;
    const res = await book(
      new NextRequest("http://localhost/api/bookings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ courtId, date: addDays(todayISO(), 4), hours: [14], name: "Mei", phone: "93456789", email: "mei@example.sg" }),
      })
    );
    expect(res.status).toBe(201);
    const { booking } = await res.json();
    expect(booking.holdUntil).toBeTruthy();

    fakeStripe();
    const first = await startBookingPayment({ codes: [booking.code], phone: "93456789" });
    if (!first.ok) throw new Error(first.error);
    const expiresAt = Number(sent[0].form!.get("expires_at"));
    expect(Math.abs(expiresAt - (Date.now() / 1000 + 30 * 60))).toBeLessThan(60);

    // Pressed again soon after: the same page.
    expect(await startBookingPayment({ codes: [booking.code], phone: "93456789" })).toMatchObject({ reused: true, url: first.url });
    // Pressed again with the page nearly gone: a new one.
    await getDb().prepare("UPDATE online_payments SET created_at = datetime('now', '-26 minutes') WHERE url = ?").run(first.url);
    const again = await startBookingPayment({ codes: [booking.code], phone: "93456789" });
    expect(again).toMatchObject({ ok: true, reused: false });
    expect(again.ok && again.url).not.toBe(first.url);
    await setHoldPolicy(venueId, { on: false });
  });

  it("does not close a page for a booking that is not held", async () => {
    fakeStripe();
    const courtId = (await getDb().prepare("SELECT id FROM courts WHERE venue_id = ?").get(venueId) as { id: number }).id;
    const b = await createBooking({ courtId, date: addDays(todayISO(), 5), hours: [15], name: "Raj", phone: "94567890", email: "raj@example.sg" });
    if (!b.ok) throw new Error(b.error);
    expect((await startBookingPayment({ codes: [b.booking.code], phone: "94567890" })).ok).toBe(true);
    expect(sent[0].form!.get("expires_at")).toBeNull();
  });
});

describe("coming back from Stripe", () => {
  it("is checked with Stripe, not believed", async () => {
    fakeStripe();
    expect(stripe.readRedirect(new URLSearchParams("billplz[id]=x"))).toBeNull();
    expect(stripe.readRedirect(new URLSearchParams("stripe_session=not-a-session"))).toBeNull();
    const inbound = stripe.readRedirect(new URLSearchParams("stripe_session=cs_test_returning1"))!;
    const account = { provider: "stripe" as const, sandbox: true, credentials: { secretKey: KEY, webhookSecret: SECRET } };
    // Unknown to Stripe: nothing.
    expect(await inbound.verify(account)).toBeNull();
    sessions.set("cs_test_returning1", { payment_status: "paid", status: "complete" });
    expect(await inbound.verify(account)).toEqual({ billId: "cs_test_returning1", paid: true, paidAt: null });
    expect(sent.at(-1)).toMatchObject({ method: "GET", url: "https://api.stripe.com/v1/checkout/sessions/cs_test_returning1", auth: `Bearer ${KEY}` });
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
