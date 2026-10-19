import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { getDb } from "../src/lib/db";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { savePaymentSettings, settleBill, startTopUpPayment } from "../src/lib/payments";
import { createBooking, createCourt, createVenue, getWalletBalance } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { GET as wallet, POST as topUp } from "../src/app/api/my/wallet/route";

/**
 * Buying stored credit online, into the venue's own account, so a regular
 * need not queue at the counter to put money on their account.
 */

let venueId: number;
let otherVenueId: number;
let user: { id: number; name: string; email: string; phone: string };
let cookie: string;
let n = 0;

function fakeBillplz() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const id = `topbill${++n}`;
      return Response.json({ id, url: `https://www.billplz-sandbox.com/bills/${id}` });
    })
  );
}

function withModes(env: { marketplace?: string; scope?: string }) {
  const before = { m: process.env.MYSENAM_MARKETPLACE, s: process.env.MYSENAM_CREDIT_SCOPE };
  if (env.marketplace === undefined) delete process.env.MYSENAM_MARKETPLACE;
  else process.env.MYSENAM_MARKETPLACE = env.marketplace;
  if (env.scope === undefined) delete process.env.MYSENAM_CREDIT_SCOPE;
  else process.env.MYSENAM_CREDIT_SCOPE = env.scope;
  return () => {
    if (before.m === undefined) delete process.env.MYSENAM_MARKETPLACE;
    else process.env.MYSENAM_MARKETPLACE = before.m;
    if (before.s === undefined) delete process.env.MYSENAM_CREDIT_SCOPE;
    else process.env.MYSENAM_CREDIT_SCOPE = before.s;
  };
}

const lastBill = async () =>
  ((await getDb().prepare("SELECT bill_id FROM online_payments ORDER BY id DESC LIMIT 1").get()) as { bill_id: string }).bill_id;

const asUser = (method: "GET" | "POST", body?: Record<string, unknown>, signedIn = true) =>
  new NextRequest("http://localhost/api/my/wallet", {
    method,
    headers: { "content-type": "application/json", ...(signedIn ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

beforeAll(async () => {
  const made = await createVenue({ name: "Top-Up Hall", area: "PJ", address: "x", phone: "0300000000" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const other = await createVenue({ name: "Counter Only Hall", area: "PJ", address: "x", phone: "0300000001" });
  if (!other.ok) throw new Error("venue");
  otherVenueId = other.venue.id;
  const saved = await savePaymentSettings(venueId, {
    apiKey: "api-key-1234",
    collectionId: "col123",
    xSignatureKey: "S-key",
    sandbox: true,
    enabled: true,
  });
  if (!saved.ok) throw new Error(saved.error);
  const registered = await registerUser({ name: "Aina", email: "aina@example.my", phone: "0192223333", password: "rahsia-123" });
  if (!registered.ok) throw new Error(registered.error);
  user = registered.user;
  cookie = `${SESSION_COOKIE}=${(await createSession(user.id)).token}`;

  // She has played at both.
  for (const id of [venueId, otherVenueId]) {
    const court = await createCourt({ venueId: id, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 30 });
    if (!court.ok) throw new Error("court");
    const booked = await createBooking({
      courtId: court.court.id,
      date: addDays(todayISO(), 2),
      hours: [9],
      name: user.name,
      phone: user.phone,
      userId: user.id,
    });
    if (!booked.ok) throw new Error("booking");
  }
});

afterEach(() => vi.unstubAllGlobals());

describe("online credit top-ups", () => {
  it("offers only venues she has played at that take payment online", async () => {
    const restore = withModes({ marketplace: "on" });
    try {
      const body = await (await wallet(asUser("GET"))).json();
      expect(body.topUpVenues).toEqual([{ id: venueId, name: "Top-Up Hall" }]);
    } finally {
      restore();
    }
  });

  it("adds the credit at that venue once it is paid, and only once", async () => {
    const restore = withModes({ marketplace: "on" });
    try {
      fakeBillplz();
      const res = await topUp(asUser("POST", { venueId, amount: 50 }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ amount: 50, url: expect.stringContaining("billplz") });
      expect(await getWalletBalance(user.id, venueId)).toBe(0);

      const billId = await lastBill();
      await settleBill({ billId, paid: true, paidAt: null });
      await settleBill({ billId, paid: true, paidAt: null });
      expect(await getWalletBalance(user.id, venueId)).toBe(50);
      // The venue's credit, not spendable at the next one.
      expect(await getWalletBalance(user.id, otherVenueId)).toBe(0);
      const entry = (await getDb()
        .prepare("SELECT reason, venue_id FROM wallet_entries WHERE user_id = ? ORDER BY id DESC LIMIT 1")
        .get(user.id)) as { reason: string; venue_id: number };
      expect(entry).toEqual({ reason: "Online top-up", venue_id: venueId });
    } finally {
      restore();
    }
  });

  it("adds nothing for a bill that was not paid", async () => {
    const restore = withModes({ marketplace: "on" });
    try {
      fakeBillplz();
      expect((await startTopUpPayment(user, venueId, 30)).ok).toBe(true);
      await settleBill({ billId: await lastBill(), paid: false, paidAt: null });
      expect(await getWalletBalance(user.id, venueId)).toBe(50);
    } finally {
      restore();
    }
  });

  it("checks the amount and the venue", async () => {
    const restore = withModes({ marketplace: "on" });
    try {
      fakeBillplz();
      for (const amount of [5, 10.5, 5000, Number.NaN])
        expect(await startTopUpPayment(user, venueId, amount)).toMatchObject({ ok: false, status: 400 });
      expect(await startTopUpPayment(user, otherVenueId, 50)).toMatchObject({ ok: false, status: 409 });
      expect((await topUp(asUser("POST", { amount: 50 }))).status).toBe(400);
    } finally {
      restore();
    }
  });

  it("is never offered where the platform would hold credit spent at other venues", async () => {
    const restore = withModes({ marketplace: "on", scope: "platform" });
    try {
      expect((await (await wallet(asUser("GET"))).json()).topUpVenues).toEqual([]);
      expect(await startTopUpPayment(user, venueId, 50)).toMatchObject({ ok: false, status: 409 });
    } finally {
      restore();
    }
  });

  it("works on a single business's own copy, credit spendable anywhere there", async () => {
    const restore = withModes({});
    try {
      fakeBillplz();
      expect((await startTopUpPayment(user, venueId, 20)).ok).toBe(true);
      await settleBill({ billId: await lastBill(), paid: true, paidAt: null });
      const entry = (await getDb()
        .prepare("SELECT amount::float AS amount, venue_id FROM wallet_entries WHERE user_id = ? ORDER BY id DESC LIMIT 1")
        .get(user.id)) as { amount: number; venue_id: number | null };
      expect(entry).toEqual({ amount: 20, venue_id: null });
    } finally {
      restore();
    }
  });

  it("needs an account", async () => {
    expect((await topUp(asUser("POST", { venueId, amount: 50 }, false))).status).toBe(401);
    expect((await wallet(asUser("GET", undefined, false))).status).toBe(401);
  });
});
