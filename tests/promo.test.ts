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
ensureBootstrapAdmin();
const ADMIN_ID = authenticateAdmin("admin@mysenam.my", "mysenam-admin")!.id;

const venue = () => listVenues()[0];
const court = () => venue().courts.find((c) => c.sport === "badminton")!;
const future = (o = 3) => addDays(todayISO(), o);

function makeCode(over: Partial<Parameters<typeof createPromoCode>[0]> = {}) {
  const r = createPromoCode({
    venueId: venue().id,
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

function book(hours: number[], date: string, courtId = court().id) {
  const r = createBooking({ courtId, date, hours, name: "Aisyah", phone: PHONE });
  if (!r.ok) throw new Error(r.error);
  return r.booking;
}

describe("creating a promo code", () => {
  it("stores it, upper-cased, with no uses yet", () => {
    const p = makeCode({ code: "raya-20" });
    expect(p).toMatchObject({ code: "RAYA-20", kind: "percent", value: 20, used: 0, status: "active" });
    expect(p.unusableReason).toBeUndefined();
    // Codes are matched case-insensitively.
    expect(getPromoCode(venue().id, "raya-20")?.id).toBe(p.id);
  });

  it("refuses nonsense", () => {
    const base = {
      venueId: venue().id, description: "Test", kind: "percent" as const, value: 10,
      validFrom: todayISO(), validTo: addDays(todayISO(), 10), adminId: ADMIN_ID,
    };
    expect(createPromoCode({ ...base, code: "ab" })).toMatchObject({ ok: false });
    expect(createPromoCode({ ...base, code: "HAS SPACE" })).toMatchObject({ ok: false });
    expect(createPromoCode({ ...base, code: "OK1", description: "x" })).toMatchObject({ ok: false });
    expect(createPromoCode({ ...base, code: "OK2", value: 0 })).toMatchObject({ ok: false });
    expect(createPromoCode({ ...base, code: "OK3", value: 101 })).toMatchObject({ ok: false });
    expect(createPromoCode({ ...base, code: "OK4", kind: "amount", value: 9999 })).toMatchObject({ ok: false });
    expect(createPromoCode({ ...base, code: "OK5", minHours: 9 })).toMatchObject({ ok: false });
    expect(createPromoCode({ ...base, code: "OK6", validTo: addDays(todayISO(), -1) }))
      .toMatchObject({ ok: false, error: "The end date is before the start date." });
    expect(createPromoCode({ ...base, code: "OK7", maxUses: 0 })).toMatchObject({ ok: false });
    expect(createPromoCode({ ...base, code: "OK8", venueId: 9999 }))
      .toMatchObject({ ok: false, error: "Venue not found." });
    // The seeded first venue has no tennis courts.
    expect(createPromoCode({ ...base, code: "OK9", sport: "tennis" }))
      .toMatchObject({ ok: false, error: "That venue has no courts for that sport." });
  });

  it("will not take the same code twice at one venue, but will at another", () => {
    makeCode({ code: "TWICE" });
    expect(createPromoCode({
      venueId: venue().id, code: "twice", description: "Dup", kind: "amount", value: 5,
      validFrom: todayISO(), validTo: addDays(todayISO(), 5), adminId: ADMIN_ID,
    })).toMatchObject({ ok: false, error: "TWICE already exists at this venue." });

    expect(createPromoCode({
      venueId: listVenues()[1].id, code: "TWICE", description: "Other venue", kind: "amount", value: 5,
      validFrom: todayISO(), validTo: addDays(todayISO(), 5), adminId: ADMIN_ID,
    })).toMatchObject({ ok: true });
  });
});

describe("quoting a code against a booking", () => {
  it("takes a percentage, rounded down, never below zero", () => {
    const p = makeCode({ code: "PC15", kind: "percent", value: 15 });
    const q = quotePromo({
      venueId: venue().id, code: p.code, sport: "badminton", date: future(), hours: 1, price: 17,
    });
    expect(q).toMatchObject({ ok: true, discount: 2 }); // floor(17 * 0.15)
  });

  it("never discounts more than the price", () => {
    const p = makeCode({ code: "BIG", kind: "amount", value: 100 });
    const q = quotePromo({
      venueId: venue().id, code: p.code, sport: "badminton", date: future(), hours: 1, price: 15,
    });
    expect(q).toMatchObject({ ok: true, discount: 15 });
  });

  it("checks venue, sport, dates and the minimum booking", () => {
    const p = makeCode({ code: "GYMONLY", sport: "gym", minHours: 2 });

    expect(quotePromo({ venueId: listVenues()[1].id, code: p.code, sport: "gym", date: future(), hours: 2, price: 20 }))
      .toMatchObject({ ok: false, error: "That code is not valid at this venue." });
    expect(quotePromo({ venueId: venue().id, code: p.code, sport: "badminton", date: future(), hours: 2, price: 20 }))
      .toMatchObject({ ok: false, error: "This code only covers Gym." });
    expect(quotePromo({ venueId: venue().id, code: p.code, sport: "gym", date: future(), hours: 1, price: 20 }))
      .toMatchObject({ ok: false, error: "This code needs a booking of at least 2 hours." });

    const later = makeCode({ code: "LATER", validFrom: addDays(todayISO(), 10), validTo: addDays(todayISO(), 20) });
    expect(quotePromo({ venueId: venue().id, code: later.code, sport: "badminton", date: future(1), hours: 1, price: 20 }))
      .toMatchObject({ ok: false, error: `This code starts on ${later.validFrom}.` });
    expect(quotePromo({ venueId: venue().id, code: later.code, sport: "badminton", date: addDays(todayISO(), 25), hours: 1, price: 20 }))
      .toMatchObject({ ok: false, error: `This code ran out on ${later.validTo}.` });
  });
});

describe("claiming a code", () => {
  it("reduces what is owed and records the use", () => {
    const p = makeCode({ code: "HALF", kind: "percent", value: 50 });
    const b = book([10, 11], future(4));
    const before = b.totalPrice;

    const r = applyPromo(b.id, "half");
    expect(r).toMatchObject({ ok: true, discount: Math.floor(before / 2) });
    if (!r.ok) return;
    expect(r.newTotal).toBe(before - r.discount);

    const stored = getDb().prepare("SELECT total_price FROM bookings WHERE id = ?").get(b.id) as { total_price: number };
    expect(stored.total_price).toBe(before - r.discount);
    expect(promoUseFor(b.id)).toMatchObject({ code: "HALF", discount: r.discount });
    expect(getPromoCode(venue().id, "HALF")?.used).toBe(1);
  });

  it("will not stack two codes on one booking", () => {
    makeCode({ code: "FIRST", kind: "amount", value: 3 });
    makeCode({ code: "SECOND", kind: "amount", value: 3 });
    const b = book([12], future(5));
    expect(applyPromo(b.id, "FIRST")).toMatchObject({ ok: true });
    expect(applyPromo(b.id, "SECOND")).toMatchObject({
      ok: false, error: "A code has already been used on this booking.",
    });
    expect(getPromoCode(venue().id, "SECOND")?.used).toBe(0);
  });

  it("stops at the usage limit", () => {
    const p = makeCode({ code: "ONLYONE", kind: "amount", value: 2, maxUses: 1 });
    const first = book([9], future(6));
    const second = book([13], future(6));

    expect(applyPromo(first.id, p.code)).toMatchObject({ ok: true });
    expect(applyPromo(second.id, p.code)).toMatchObject({
      ok: false, error: "This code has been fully claimed.",
    });
    expect(getPromoCode(venue().id, p.code)).toMatchObject({
      used: 1, unusableReason: "This code has been fully claimed.",
    });
  });

  it("gives the use back when the booking is cancelled", () => {
    const p = makeCode({ code: "GIVEBACK", kind: "amount", value: 2, maxUses: 1 });
    const b = book([14], future(7));
    expect(applyPromo(b.id, p.code)).toMatchObject({ ok: true });
    expect(getPromoCode(venue().id, p.code)?.used).toBe(1);

    expect(cancelBooking(b.code, PHONE)).toMatchObject({ ok: true });
    expect(getPromoCode(venue().id, p.code)?.used).toBe(0);
    expect(promoUseFor(b.id)).toBeNull();

    // And the freed use is genuinely available again.
    const next = book([15], future(7));
    expect(applyPromo(next.id, p.code)).toMatchObject({ ok: true });
    expect(adminCancelBooking(next.code)).toMatchObject({ ok: true });
    expect(getPromoCode(venue().id, p.code)?.used).toBe(0);
  });

  it("refuses a withdrawn code, and a booking already paid or cancelled", () => {
    const p = makeCode({ code: "GONE", kind: "amount", value: 2 });
    const paid = book([16], future(8));
    setPaymentStatus(paid.code, true);
    expect(applyPromo(paid.id, p.code)).toMatchObject({
      ok: false, error: "This booking is already paid; a code cannot be added now.",
    });

    const cancelled = book([17], future(8));
    adminCancelBooking(cancelled.code);
    expect(applyPromo(cancelled.id, p.code)).toMatchObject({ ok: false, error: "This booking was cancelled." });

    expect(voidPromoCode(p.id)).toMatchObject({ ok: true, promo: { status: "void" } });
    expect(voidPromoCode(p.id)).toMatchObject({ ok: false });
    const fresh = book([18], future(8));
    expect(applyPromo(fresh.id, p.code)).toMatchObject({ ok: false, error: "This code was withdrawn." });
  });

  it("refuses an unknown code and an unknown booking", () => {
    const b = book([19], future(9));
    expect(applyPromo(b.id, "NOSUCH")).toMatchObject({
      ok: false, error: "That code is not valid at this venue.",
    });
    expect(applyPromo(999999, "RAYA20")).toMatchObject({ ok: false, error: "Booking not found." });
  });

  it("lists a venue's codes newest first, and only its own", () => {
    const mine = makeCode({ code: "MINE" });
    const listed = listPromoCodes(venue().id);
    expect(listed[0].id).toBe(mine.id);
    expect(listed.every((p) => p.venueId === venue().id)).toBe(true);
  });
});
