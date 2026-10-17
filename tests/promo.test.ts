import { describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import {
  adminCancelBooking,
  applyPromo,
  cancelBooking,
  createBooking,
  createPromoCode,
  getPromoCode,
  listPromoCodes,
  listVenues,
  promoUseFor,
  quotePromo,
  setPaymentStatus,
  voidPromoCode,
} from "../src/lib/store";
import { authenticateAdmin, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { addDays, todayISO } from "../src/lib/time";

const PHONE = "0123456789";
await ensureBootstrapAdmin();
const ADMIN_ID = (await authenticateAdmin("admin@mysenam.my", "mysenam-admin"))!.id;

const venue = async () => (await listVenues())[0];
const court = async () => (await venue()).courts.find((c) => c.sport === "badminton")!;
const future = (o = 3) => addDays(todayISO(), o);

async function makeCode(over: Partial<Parameters<typeof createPromoCode>[0]> = {}) {
  const r = await createPromoCode({
    venueId: (await venue()).id,
    code: "RAYA20",
    description: "20% off for Raya",
    kind: "percent",
    value: 20,
    validFrom: todayISO(),
    validTo: addDays(todayISO(), 30),
    adminId: ADMIN_ID,
    ...over,
  });
  if (!r.ok) throw new Error(r.error);
  return r.promo;
}

async function book(hours: number[], date: string, courtId?: number) {
  courtId ??= (await court()).id;
  const r = await createBooking({ courtId, date, hours, name: "Aisyah", phone: PHONE });
  if (!r.ok) throw new Error(r.error);
  return r.booking;
}

describe("creating a promo code", () => {
  it("stores it, upper-cased, with no uses yet", async () => {
    const p = await makeCode({ code: "raya-20" });
    expect(p).toMatchObject({ code: "RAYA-20", kind: "percent", value: 20, used: 0, status: "active" });
    expect(p.unusableReason).toBeUndefined();
    // Codes are matched case-insensitively.
    expect((await getPromoCode((await venue()).id, "raya-20"))?.id).toBe(p.id);
  });

  it("refuses nonsense", async () => {
    const base = {
      venueId: (await venue()).id, description: "Test", kind: "percent" as const, value: 10,
      validFrom: todayISO(), validTo: addDays(todayISO(), 10), adminId: ADMIN_ID,
    };
    expect(await createPromoCode({ ...base, code: "ab" })).toMatchObject({ ok: false });
    expect(await createPromoCode({ ...base, code: "HAS SPACE" })).toMatchObject({ ok: false });
    expect(await createPromoCode({ ...base, code: "OK1", description: "x" })).toMatchObject({ ok: false });
    expect(await createPromoCode({ ...base, code: "OK2", value: 0 })).toMatchObject({ ok: false });
    expect(await createPromoCode({ ...base, code: "OK3", value: 101 })).toMatchObject({ ok: false });
    expect(await createPromoCode({ ...base, code: "OK4", kind: "amount", value: 9999 })).toMatchObject({ ok: false });
    expect(await createPromoCode({ ...base, code: "OK5", minHours: 9 })).toMatchObject({ ok: false });
    expect(await createPromoCode({ ...base, code: "OK6", validTo: addDays(todayISO(), -1) }))
      .toMatchObject({ ok: false, error: "The end date is before the start date." });
    expect(await createPromoCode({ ...base, code: "OK7", maxUses: 0 })).toMatchObject({ ok: false });
    expect(await createPromoCode({ ...base, code: "OK8", venueId: 9999 }))
      .toMatchObject({ ok: false, error: "Venue not found." });
    // The seeded first venue has no tennis courts.
    expect(await createPromoCode({ ...base, code: "OK9", sport: "tennis" }))
      .toMatchObject({ ok: false, error: "That venue has no courts for that sport." });
  });

  it("will not take the same code twice at one venue, but will at another", async () => {
    await makeCode({ code: "TWICE" });
    expect(await createPromoCode({
      venueId: (await venue()).id, code: "twice", description: "Dup", kind: "amount", value: 5,
      validFrom: todayISO(), validTo: addDays(todayISO(), 5), adminId: ADMIN_ID,
    })).toMatchObject({ ok: false, error: "TWICE already exists at this venue." });

    expect(await createPromoCode({
      venueId: (await listVenues())[1].id, code: "TWICE", description: "Other venue", kind: "amount", value: 5,
      validFrom: todayISO(), validTo: addDays(todayISO(), 5), adminId: ADMIN_ID,
    })).toMatchObject({ ok: true });
  });
});

describe("quoting a code against a booking", () => {
  it("takes a percentage, rounded down, never below zero", async () => {
    const p = await makeCode({ code: "PC15", kind: "percent", value: 15 });
    const q = await quotePromo({
      venueId: (await venue()).id, code: p.code, sport: "badminton", date: future(), hours: 1, price: 17,
    });
    expect(q).toMatchObject({ ok: true, discount: 2 }); // floor(17 * 0.15)
  });

  it("never discounts more than the price", async () => {
    const p = await makeCode({ code: "BIG", kind: "amount", value: 100 });
    const q = await quotePromo({
      venueId: (await venue()).id, code: p.code, sport: "badminton", date: future(), hours: 1, price: 15,
    });
    expect(q).toMatchObject({ ok: true, discount: 15 });
  });

  it("checks venue, sport, dates and the minimum booking", async () => {
    const p = await makeCode({ code: "GYMONLY", sport: "gym", minHours: 2 });

    expect(await quotePromo({ venueId: (await listVenues())[1].id, code: p.code, sport: "gym", date: future(), hours: 2, price: 20 }))
      .toMatchObject({ ok: false, error: "That code is not valid at this venue." });
    expect(await quotePromo({ venueId: (await venue()).id, code: p.code, sport: "badminton", date: future(), hours: 2, price: 20 }))
      .toMatchObject({ ok: false, error: "This code only covers Gym." });
    expect(await quotePromo({ venueId: (await venue()).id, code: p.code, sport: "gym", date: future(), hours: 1, price: 20 }))
      .toMatchObject({ ok: false, error: "This code needs a booking of at least 2 hours." });

    const later = await makeCode({ code: "LATER", validFrom: addDays(todayISO(), 10), validTo: addDays(todayISO(), 20) });
    expect(await quotePromo({ venueId: (await venue()).id, code: later.code, sport: "badminton", date: future(1), hours: 1, price: 20 }))
      .toMatchObject({ ok: false, error: `This code starts on ${later.validFrom}.` });
    expect(await quotePromo({ venueId: (await venue()).id, code: later.code, sport: "badminton", date: addDays(todayISO(), 25), hours: 1, price: 20 }))
      .toMatchObject({ ok: false, error: `This code ran out on ${later.validTo}.` });
  });
});

describe("claiming a code", () => {
  it("reduces what is owed and records the use", async () => {
    const p = await makeCode({ code: "HALF", kind: "percent", value: 50 });
    const b = await book([10, 11], future(4));
    const before = b.totalPrice;

    const r = await applyPromo(b.id, "half");
    expect(r).toMatchObject({ ok: true, discount: Math.floor(before / 2) });
    if (!r.ok) return;
    expect(r.newTotal).toBe(before - r.discount);

    const stored = await getDb().prepare("SELECT total_price FROM bookings WHERE id = ?").get(b.id) as { total_price: number };
    expect(stored.total_price).toBe(before - r.discount);
    expect(await promoUseFor(b.id)).toMatchObject({ code: "HALF", discount: r.discount });
    expect((await getPromoCode((await venue()).id, "HALF"))?.used).toBe(1);
  });

  it("will not stack two codes on one booking", async () => {
    await makeCode({ code: "FIRST", kind: "amount", value: 3 });
    await makeCode({ code: "SECOND", kind: "amount", value: 3 });
    const b = await book([12], future(5));
    expect(await applyPromo(b.id, "FIRST")).toMatchObject({ ok: true });
    expect(await applyPromo(b.id, "SECOND")).toMatchObject({
      ok: false, error: "A code has already been used on this booking.",
    });
    expect((await getPromoCode((await venue()).id, "SECOND"))?.used).toBe(0);
  });

  it("stops at the usage limit", async () => {
    const p = await makeCode({ code: "ONLYONE", kind: "amount", value: 2, maxUses: 1 });
    const first = await book([9], future(6));
    const second = await book([13], future(6));

    expect(await applyPromo(first.id, p.code)).toMatchObject({ ok: true });
    expect(await applyPromo(second.id, p.code)).toMatchObject({
      ok: false, error: "This code has been fully claimed.",
    });
    expect(await getPromoCode((await venue()).id, p.code)).toMatchObject({
      used: 1, unusableReason: "This code has been fully claimed.",
    });
  });

  it("gives the use back when the booking is cancelled", async () => {
    const p = await makeCode({ code: "GIVEBACK", kind: "amount", value: 2, maxUses: 1 });
    const b = await book([14], future(7));
    expect(await applyPromo(b.id, p.code)).toMatchObject({ ok: true });
    expect((await getPromoCode((await venue()).id, p.code))?.used).toBe(1);

    expect(await cancelBooking(b.code, PHONE)).toMatchObject({ ok: true });
    expect((await getPromoCode((await venue()).id, p.code))?.used).toBe(0);
    expect(await promoUseFor(b.id)).toBeNull();

    // And the freed use is genuinely available again.
    const next = await book([15], future(7));
    expect(await applyPromo(next.id, p.code)).toMatchObject({ ok: true });
    expect(await adminCancelBooking(next.code)).toMatchObject({ ok: true });
    expect((await getPromoCode((await venue()).id, p.code))?.used).toBe(0);
  });

  it("refuses a withdrawn code, and a booking already paid or cancelled", async () => {
    const p = await makeCode({ code: "GONE", kind: "amount", value: 2 });
    const paid = await book([16], future(8));
    await setPaymentStatus(paid.code, true);
    expect(await applyPromo(paid.id, p.code)).toMatchObject({
      ok: false, error: "This booking is already paid; a code cannot be added now.",
    });

    const cancelled = await book([17], future(8));
    await adminCancelBooking(cancelled.code);
    expect(await applyPromo(cancelled.id, p.code)).toMatchObject({ ok: false, error: "This booking was cancelled." });

    expect(await voidPromoCode(p.id)).toMatchObject({ ok: true, promo: { status: "void" } });
    expect(await voidPromoCode(p.id)).toMatchObject({ ok: false });
    const fresh = await book([18], future(8));
    expect(await applyPromo(fresh.id, p.code)).toMatchObject({ ok: false, error: "This code was withdrawn." });
  });

  it("refuses an unknown code and an unknown booking", async () => {
    const b = await book([19], future(9));
    expect(await applyPromo(b.id, "NOSUCH")).toMatchObject({
      ok: false, error: "That code is not valid at this venue.",
    });
    expect(await applyPromo(999999, "RAYA20")).toMatchObject({ ok: false, error: "Booking not found." });
  });

  it("lists a venue's codes newest first, and only its own", async () => {
    const mine = await makeCode({ code: "MINE" });
    const listed = await listPromoCodes((await venue()).id);
    expect(listed[0].id).toBe(mine.id);
    const here = (await venue()).id;
    expect(listed.every((p) => p.venueId === here)).toBe(true);
  });
});
