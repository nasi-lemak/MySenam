import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { createAdmin } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { holdStrandedBookings, releaseExpiredHolds, setHoldPolicy } from "../src/lib/holds";
import { savePaymentSettings } from "../src/lib/payments";
import { createApiKey } from "../src/lib/api-keys";
import { POST as apiBook } from "../src/app/api/v1/bookings/route";
import { createCourt, createPromoCode, createVenue, getWalletBalance, topUpWallet } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { POST as book } from "../src/app/api/bookings/route";

/**
 * Nothing is charged at a price the customer did not accept (ADR 0054): a promo code or concession refused on a
 * request that settles at once is a refusal with nothing kept; `expectedTotal` (cents) refuses a booking that now costs
 * another price; a failed credit payment says so in the answer and leaves a held, unpaid, resolvable booking.
 */

let venueId: number;
let holdVenueId: number;
let managerId: number;
let writeKey: string;
let apiCourt: number;
let n = 0;
let k = 0;
// Each booking its own slot: fourteen hours a day, then the next day.
const slotOf = () => ({ date: addDays(todayISO(), 4 + Math.floor(k / 14)), hours: [8 + (k++ % 14)] });

async function customer() {
  const made = await registerUser({ name: `Handshake ${++n}`, email: `hs${n}@hs.test`, phone: `0177300${String(n).padStart(3, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return { ...made.user, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}
const post = (who: { cookie: string; name: string; phone: string }, body: Record<string, unknown>, vid = venueId) =>
  book(
    new NextRequest("http://localhost/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${++n % 250}`, cookie: who.cookie },
      body: JSON.stringify({ venueId: vid, sport: "badminton", ...slotOf(), name: who.name, phone: who.phone, ...body }),
    })
  );
const bookings = async (phone: string) =>
  (await getDb().prepare("SELECT id, status, payment_status, total_price::float AS total, hold_until FROM bookings WHERE phone_key = phone_key(?) ORDER BY id").all(phone)) as {
    id: number; status: string; payment_status: string; total: number; hold_until: string | null;
  }[];

beforeAll(async () => {
  const made = await createVenue({ name: "Handshake Hall", area: "Bangsar", address: "1 Jalan HS", phone: "0322224400" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const c = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 30, peakRate: 30 });
  if (!c.ok) throw new Error("court");
  const admin = await createAdmin({ name: "Mira", email: "hs-mgr@hs.test", password: "a long enough password", venueId, role: "manager" });
  if (!admin.ok) throw new Error(admin.error);
  managerId = admin.admin.id;
  const promo = await createPromoCode({ venueId, code: "ONEUSE", description: "one use only", kind: "amount", value: 10, validFrom: todayISO(), validTo: addDays(todayISO(), 60), maxUses: 1, adminId: managerId });
  if (!promo.ok) throw new Error(JSON.stringify(promo));
  apiCourt = c.court.id;
  const key = await createApiKey(venueId, { name: "Desk system", scope: "write" }, managerId);
  if (!key.ok) throw new Error("key");
  writeKey = key.key;
  // A venue that asks for payment online to hold a booking.
  const h = await createVenue({ name: "Holding Hall", area: "PJ", address: "2 Jalan HS", phone: "0322224401" });
  if (!h.ok) throw new Error("venue");
  holdVenueId = h.venue.id;
  const hc = await createCourt({ venueId: holdVenueId, name: "Court H", sport: "badminton", offPeakRate: 30, peakRate: 30 });
  if (!hc.ok) throw new Error("court");
  const saved = await savePaymentSettings(holdVenueId, { apiKey: "api-key-1234", collectionId: "col123", xSignatureKey: "S-key", sandbox: true, enabled: true });
  if (!saved.ok) throw new Error(saved.error);
  const hold = await setHoldPolicy(holdVenueId, { on: true, minutes: 15 });
  if (!hold.ok) throw new Error(hold.error);
  // Holds have been asked for since yesterday, so bookings made a few minutes ago are ones it applies to.
  await getDb().prepare("UPDATE venues SET pay_to_hold_since = datetime('now', '-1 days') WHERE id = ?").run(holdVenueId);
});

describe("a discount refused where the request settles at once", () => {
  it("refuses, books nothing and takes nothing from credit when the code they were quoted ran out", async () => {
    const first = await customer();
    expect(((await (await post(first, { promoCode: "ONEUSE" })).json()) as { discount: number }).discount).toBe(10);
    const second = await customer();
    await topUpWallet({ userId: second.id, amount: 100, adminId: managerId, venueId });
    const before = await getWalletBalance(second.id, venueId);
    const res = await post(second, { promoCode: "ONEUSE", payFromWallet: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "DISCOUNT_NOT_APPLIED" });
    expect(await getWalletBalance(second.id, venueId)).toBe(before);
    expect(await bookings(second.phone)).toHaveLength(0);
    // Used up, and the used one still counts once: a refused attempt did not keep a use.
    const uses = (await getDb().prepare("SELECT used_count::int AS n FROM promo_codes WHERE code = 'ONEUSE'").get()) as { n: number };
    expect(uses.n).toBe(1);
  });

  it("without paying, the refused code is told as before and the booking stands at its price", async () => {
    const who = await customer();
    const res = await post(who, { promoCode: "ONEUSE" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { promoError: string | null; booking: { totalPrice: number; paymentStatus: string } };
    expect(body.promoError).toBeTruthy();
    expect(body.booking).toMatchObject({ totalPrice: 30, paymentStatus: "unpaid" });
  });
});

describe("expectedTotal", () => {
  it("books and pays when the price is the one shown", async () => {
    const who = await customer();
    await topUpWallet({ userId: who.id, amount: 100, adminId: managerId, venueId });
    const res = await post(who, { expectedTotal: 3000, payFromWallet: true });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { booking: { paymentStatus: string } }).booking.paymentStatus).toBe("paid");
  });

  it("refuses with the price now, books nothing and charges nothing when it is another", async () => {
    const who = await customer();
    await topUpWallet({ userId: who.id, amount: 100, adminId: managerId, venueId });
    const before = await getWalletBalance(who.id, venueId);
    const res = await post(who, { expectedTotal: 2000, payFromWallet: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "PRICE_CHANGED", vars: { amount: "30.00", cents: 3000 } });
    expect(await getWalletBalance(who.id, venueId)).toBe(before);
    expect(await bookings(who.phone)).toHaveLength(0);
    // Accepted by sending the price now.
    expect((await post(who, { expectedTotal: 3000 })).status).toBe(201);
  });

  it("refuses a total that is no whole number of cents", async () => {
    const who = await customer();
    expect((await post(who, { expectedTotal: 30.5 })).status).toBe(400);
    expect((await post(who, { expectedTotal: "30" })).status).toBe(400);
    expect(await bookings(who.phone)).toHaveLength(0);
  });
});

describe("expectedTotal on the venue's API", () => {
  const through = async (body: Record<string, unknown>) =>
    apiBook(
      new NextRequest("http://localhost/api/v1/bookings", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${writeKey}` },
        body: JSON.stringify({ courtId: apiCourt, date: addDays(todayISO(), 9), name: "Desk Guest", phone: `0178${String(100000 + ++n)}`, ...body }),
      })
    );

  it("books at the quoted price, and refuses another with nothing kept", async () => {
    const ok = await through({ start: 600, end: 660, expectedTotal: 3000 });
    expect(ok.status).toBe(201);
    const wrong = await through({ start: 660, end: 720, expectedTotal: 2500 });
    expect(wrong.status).toBe(409);
    expect(await wrong.json()).toMatchObject({ code: "PRICE_CHANGED" });
    const kept = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE court_id = ? AND date = ? AND start_min = 660").get(apiCourt, addDays(todayISO(), 9))) as { n: number };
    expect(kept.n).toBe(0);
    expect((await through({ start: 660, end: 720, expectedTotal: "x" })).status).toBe(400);
  });
});

describe("a failed payment from credit", () => {
  it("says so in the answer, and the booking stands unpaid and held, and can still be paid or let go", async () => {
    const who = await customer();
    // No credit at all.
    const res = await post(who, { payFromWallet: true }, holdVenueId);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { booking: { id: number; paymentStatus: string }; walletError: string; walletErrorCode: string; holdUntil: string | null };
    expect(body.walletError).toBeTruthy();
    expect(body.walletErrorCode).toBe("NOT_ENOUGH_CREDIT");
    expect(body.booking.paymentStatus).toBe("unpaid");
    expect(body.holdUntil).toBeTruthy();
    // Still a live booking with its hold: paying it later from credit works, once credit is there.
    await topUpWallet({ userId: who.id, amount: 100, adminId: managerId, venueId: holdVenueId });
    const { payBookingFromWallet } = await import("../src/lib/store");
    expect((await payBookingFromWallet(body.booking.id)).ok).toBe(true);
  });

  it("left unpaid, it is let go when the hold ends", async () => {
    const who = await customer();
    const body = (await (await post(who, { payFromWallet: true }, holdVenueId)).json()) as { booking: { id: number } };
    await getDb().prepare("UPDATE bookings SET hold_until = datetime('now', '-1 minutes') WHERE id = ?").run(body.booking.id);
    await releaseExpiredHolds();
    expect((await bookings(who.phone))[0]).toMatchObject({ status: "cancelled" });
  });
});

describe("a booking whose request died before its hold was applied", () => {
  async function stranded(minutesOld: number, over = "") {
    const who = await customer();
    const made = (await (await post(who, {}, holdVenueId)).json()) as { booking: { id: number } };
    // The request died after the booking was saved: no hold, made some minutes ago.
    await getDb()
      .prepare(`UPDATE bookings SET hold_until = NULL, created_at = datetime('now', '-${minutesOld} minutes') ${over} WHERE id = ?`)
      .run(made.booking.id);
    return { who, id: made.booking.id };
  }

  it("gets the hold it would have had, from when it was made, and is let go once that ends", async () => {
    const fresh = await stranded(10);
    const old = await stranded(40);
    expect(await holdStrandedBookings()).toBeGreaterThanOrEqual(2);
    const f = (await bookings(fresh.who.phone))[0];
    expect(f.hold_until).toBeTruthy();
    expect(f.status).toBe("confirmed");
    // Made 40 minutes ago with 15 minutes to pay: let go at the next release.
    await releaseExpiredHolds();
    expect((await bookings(old.who.phone))[0]).toMatchObject({ status: "cancelled" });
    expect((await bookings(fresh.who.phone))[0]).toMatchObject({ status: "confirmed" });
  });

  it("is safe to run twice or at once, and never moves a hold that is there", async () => {
    const s = await stranded(8);
    const [a, b] = await Promise.all([holdStrandedBookings(), holdStrandedBookings()]);
    expect(a + b).toBeGreaterThanOrEqual(1);
    const first = (await bookings(s.who.phone))[0].hold_until;
    expect(await holdStrandedBookings()).toBe(0);
    expect((await bookings(s.who.phone))[0].hold_until).toBe(first);
  });

  it("leaves alone what the route does not hold: just made, paid, on an account, counter-made, an API booking, before holds were asked for", async () => {
    const justNow = await stranded(1);
    const counter = await stranded(30, ", made_on = 'staff'");
    const api = await stranded(30, ", made_on = 'api'");
    const paid = await stranded(30, ", payment_status = 'paid'");
    const sharesPaid = await stranded(30, ", shares_paid = 5");
    const before = await stranded(30);
    await getDb().prepare("UPDATE venues SET pay_to_hold_since = datetime('now', '+1 minutes') WHERE id = ?").run(holdVenueId);
    await holdStrandedBookings();
    await getDb().prepare("UPDATE venues SET pay_to_hold_since = datetime('now', '-1 days') WHERE id = ?").run(holdVenueId);
    for (const s of [justNow, counter, api, paid, sharesPaid, before]) expect((await bookings(s.who.phone))[0].hold_until).toBeNull();
  });

  it("does nothing at a venue that does not ask for holds", async () => {
    const who = await customer();
    const made = (await (await post(who, {})).json()) as { booking: { id: number } };
    await getDb().prepare("UPDATE bookings SET created_at = datetime('now', '-30 minutes') WHERE id = ?").run(made.booking.id);
    await holdStrandedBookings();
    expect((await bookings(who.phone))[0].hold_until).toBeNull();
  });

  it("turning holds on records since when, and keeps it while on", async () => {
    const v = await createVenue({ name: "Since Hall", area: "PJ", address: "3 Jalan HS", phone: "0322224402" });
    if (!v.ok) throw new Error("venue");
    await savePaymentSettings(v.venue.id, { apiKey: "api-key-1234", collectionId: "col123", xSignatureKey: "S-key", sandbox: true, enabled: true });
    const read = async () => ((await getDb().prepare("SELECT pay_to_hold_since AS s FROM venues WHERE id = ?").get(v.venue.id)) as { s: string | null }).s;
    expect(await read()).toBeNull();
    await setHoldPolicy(v.venue.id, { on: true });
    const since = await read();
    expect(since).toBeTruthy();
    await setHoldPolicy(v.venue.id, { on: true, minutes: 20 });
    expect(await read()).toBe(since);
    await setHoldPolicy(v.venue.id, { on: false });
    expect(await read()).toBeNull();
  });
});
