import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
import { createPlan } from "../src/lib/membership-plans";
import { reconcileRenewalPauses, savePaymentSettings, startMembershipPayment } from "../src/lib/payments";
import { createVenue } from "../src/lib/store";
import { liftVenue, suspendVenue } from "../src/lib/suspensions";
import { POST as callback } from "../src/app/api/payments/[provider]/callback/route";

/**
 * Audit 9, FX11 (ADR 0063): a membership that renews by itself is charged by the gateway, so while its venue is suspended the
 * subscription is paused there, and carried on when the venue is back. Tested against a fake Stripe only: not verified against the
 * real service.
 */

const SECRET = "whsec_testsecret1234567890";
const KEY = "rk_test_abcdefghijklmnop";
let venueId: number;
let planId: number;
let n = 0;
let sent: { url: string; method: string; form: URLSearchParams | null }[] = [];
let refuse: number | null = null;

function fakeStripe() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string; body?: string }) => {
      sent.push({ url, method: init.method ?? "GET", form: init.body ? new URLSearchParams(init.body) : null });
      if (url.includes("/subscriptions/")) {
        if (refuse !== null) return Response.json({ error: { message: "no" } }, { status: refuse });
        return Response.json({ id: url.split("/").pop(), object: "subscription", status: "active" });
      }
      const id = `cs_test_pause${++n}`;
      return Response.json({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
    })
  );
}

const post = (event: object) => {
  const body = JSON.stringify(event);
  const at = Math.floor(Date.now() / 1000);
  const signature = `t=${at},v1=${crypto.createHmac("sha256", SECRET).update(`${at}.${body}`).digest("hex")}`;
  return callback(
    new NextRequest("http://localhost/api/payments/stripe/callback", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      body,
    }),
    { params: Promise.resolve({ provider: "stripe" }) }
  );
};

async function subscribe(name: string, email: string, subscription: string) {
  const u = await registerUser({ name, email, phone: `9123${String(++n).padStart(4, "0")}`, password: "a long enough password" });
  if (!u.ok) throw new Error(u.error);
  fakeStripe();
  const started = await startMembershipPayment(u.user, planId, { autoRenew: true });
  expect(started.ok, JSON.stringify(started)).toBe(true);
  const session = `cs_test_pause${n}`;
  expect(
    (await post({ id: `evt_${session}`, type: "checkout.session.completed", created: Math.floor(Date.now() / 1000), data: { object: { id: session, object: "checkout.session", payment_status: "paid", subscription } } })).status
  ).toBe(200);
  sent = [];
}

const pausedAt = async (subscription: string) =>
  ((await getDb().prepare("SELECT paused_at FROM membership_subscriptions WHERE subscription_id = ?").get(subscription)) as { paused_at: string | null }).paused_at;

beforeAll(async () => {
  const made = await createVenue({ name: "Pause Club", area: "Tanjong Pagar", address: "x", phone: "61234111" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const saved = await savePaymentSettings(venueId, { credentials: { secretKey: KEY, webhookSecret: SECRET }, sandbox: true, enabled: true });
  if (!saved.ok) throw new Error(saved.error);
  const plan = await createPlan(venueId, { name: "Quarterly", months: 3, price: 120 });
  if (!plan.ok) throw new Error("plan");
  planId = plan.plan.id;
});

afterEach(() => {
  vi.unstubAllGlobals();
  sent = [];
  refuse = null;
});

describe("a subscription at a suspended venue", () => {
  it("is paused at the gateway, once, and carried on when the venue is lifted", async () => {
    await subscribe("Mei Ling", "mei-pause@example.sg", "sub_pause_a");
    expect(await pausedAt("sub_pause_a")).toBeNull();

    fakeStripe();
    expect(await suspendVenue(venueId, "a complaint about refunds")).toMatchObject({ ok: true });
    const pause = sent.filter((s) => s.url.endsWith("/subscriptions/sub_pause_a"));
    expect(pause).toHaveLength(1);
    expect(pause[0].method).toBe("POST");
    expect(pause[0].form!.get("pause_collection[behavior]")).toBe("void");
    expect(await pausedAt("sub_pause_a")).not.toBeNull();

    // Looked at again: nothing more is asked of the gateway.
    sent = [];
    expect(await reconcileRenewalPauses()).toEqual({ paused: 0, resumed: 0, failed: 0 });
    expect(sent).toHaveLength(0);

    expect(await liftVenue(venueId)).toEqual({ ok: true });
    const resume = sent.filter((s) => s.url.endsWith("/subscriptions/sub_pause_a"));
    expect(resume).toHaveLength(1);
    expect(resume[0].form!.get("pause_collection")).toBe("");
    expect(await pausedAt("sub_pause_a")).toBeNull();
    // The member's membership was never touched: pausing charges nothing and changes no term.
    expect(((await getDb().prepare("SELECT status FROM membership_subscriptions WHERE subscription_id = 'sub_pause_a'").get()) as { status: string }).status).toBe("active");
  });

  it("is left as it was, and the owner told, when the gateway will not pause it; it is tried again", async () => {
    await subscribe("Raj", "raj-pause@example.sg", "sub_pause_b");
    refuse = 403;
    fakeStripe();
    expect(await suspendVenue(venueId, "checking a complaint")).toMatchObject({ ok: true });
    expect(await pausedAt("sub_pause_b")).toBeNull();
    const alert = (await getDb().prepare("SELECT subject, last_detail FROM system_alerts WHERE key = ?").get(`renewal-pause:${venueId}`)) as { subject: string; last_detail: string } | undefined;
    expect(alert).toBeDefined();
    expect(alert!.last_detail).toContain("Subscriptions");

    refuse = null;
    sent = [];
    expect(await reconcileRenewalPauses()).toMatchObject({ paused: 2, failed: 0 });
    expect(await pausedAt("sub_pause_b")).not.toBeNull();
    await liftVenue(venueId);
    expect(await pausedAt("sub_pause_b")).toBeNull();
  });

  it("does not touch a subscription that has been stopped", async () => {
    await subscribe("Siti", "siti-pause@example.sg", "sub_pause_c");
    await getDb().prepare("UPDATE membership_subscriptions SET status = 'stopped', stopped_at = datetime('now') WHERE subscription_id = 'sub_pause_c'").run();
    fakeStripe();
    await suspendVenue(venueId, "a reason");
    expect(sent.filter((s) => s.url.endsWith("/sub_pause_c"))).toHaveLength(0);
    await liftVenue(venueId);
    expect(sent.filter((s) => s.url.endsWith("/sub_pause_c"))).toHaveLength(0);
  });
});
