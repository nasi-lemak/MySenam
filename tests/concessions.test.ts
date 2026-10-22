import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { checkConcession, listConcessions, rememberUntil, retireConcession, saveConcession } from "../src/lib/concessions";
import { getDb } from "../src/lib/db";
import { exportPhoneData } from "../src/lib/privacy";
import { applyPromo, createCourt, createVenue, findBooking, setPaymentStatus } from "../src/lib/store";
import { addDays, dayOfWeek, todayISO } from "../src/lib/time";
import { POST as book } from "../src/app/api/bookings/route";

/**
 * Concession prices: a share off for students, seniors, children or OKU,
 * chosen at booking and checked at the counter. Proof is looked at, never
 * kept; only the fact that it was seen, and until when.
 */

let venueId: number;
let courtId: number;
let tennisId: number;
let student: number;
let senior: number;
let n = 0;
const phone = () => `0155550${String(++n).padStart(3, "0")}`;

/** The next weekday from tomorrow, when 9 AM is off-peak and 7 PM peak. */
let date = addDays(todayISO(), 1);
while ([0, 6].includes(dayOfWeek(date))) date = addDays(date, 1);

const post = async (body: Record<string, unknown>) => {
  const res = await book(
    new NextRequest("http://localhost/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ courtId, date, name: "Nurul", ...body }),
    })
  );
  return { status: res.status, body: await res.json() };
};

beforeAll(async () => {
  const made = await createVenue({ name: "Kompleks Belia", area: "Shah Alam", address: "x", phone: "0355551111" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const c = await createCourt({ venueId, name: "Court A", sport: "badminton", offPeakRate: 20, peakRate: 30 });
  const t = await createCourt({ venueId, name: "Tennis 1", sport: "tennis", offPeakRate: 40, peakRate: 40 });
  if (!c.ok || !t.ok) throw new Error("court");
  courtId = c.court.id;
  tennisId = t.court.id;
});

describe("a venue's concession prices", () => {
  it("are named, a share off, with what to bring; for one sport or all, off-peak or not", async () => {
    expect(await saveConcession(venueId, { name: "S", percent: 20, proof: "your student card" })).toMatchObject({ ok: false });
    expect(await saveConcession(venueId, { name: "Student", percent: 2, proof: "your student card" })).toMatchObject({ ok: false });
    expect(await saveConcession(venueId, { name: "Student", percent: 20, proof: "" })).toMatchObject({ ok: false });
    const s = await saveConcession(venueId, { name: "Student", percent: 50, proof: "your student card", sport: "badminton", offPeakOnly: true });
    const o = await saveConcession(venueId, { name: "Senior (60+)", percent: 25, proof: "your IC" });
    if (!s.ok || !o.ok) throw new Error("save");
    student = s.concession.id;
    senior = o.concession.id;
    expect((await listConcessions(venueId)).map((c) => c.name)).toEqual(["Student", "Senior (60+)"]);
  });

  it("go on at booking, and say what to bring", async () => {
    const { status, body } = await post({ hours: [9, 10], phone: phone(), concessionId: student });
    expect(status).toBe(201);
    expect(body.booking).toMatchObject({ totalPrice: 20, concessionName: "Student", concessionOff: 20, concessionCheck: "due" });
    expect(body.concession).toMatchObject({ name: "Student", proof: "your student card" });
  });

  it("are refused, the booking standing at full price, where they do not apply", async () => {
    const peak = await post({ hours: [19], phone: phone(), concessionId: student });
    expect(peak.status).toBe(201);
    expect(peak.body.booking.totalPrice).toBe(30);
    expect(peak.body.concessionError).toMatchObject({ code: "CONCESSION_OFF_PEAK" });
    const tennis = await post({ courtId: tennisId, hours: [9], phone: phone(), concessionId: student });
    expect(tennis.body.concessionError).toMatchObject({ code: "CONCESSION_NOT_HERE" });
    // The senior price is any sport, any hour.
    const s = await post({ courtId: tennisId, hours: [19], phone: phone(), concessionId: senior });
    expect(s.body.booking.totalPrice).toBe(30);
  });

  it("are one discount: no promo code on top", async () => {
    const { body } = await post({ hours: [11], phone: phone(), concessionId: senior });
    expect(await applyPromo(body.booking.id, "ANYCODE")).toMatchObject({ ok: false, code: "ONE_DISCOUNT" });
  });

  it("withdrawn, are offered no more", async () => {
    const extra = await saveConcession(venueId, { name: "OKU", percent: 50, proof: "your OKU card" });
    if (!extra.ok) throw new Error("save");
    expect(await retireConcession(venueId, extra.concession.id)).toBe(true);
    const { body } = await post({ hours: [12], phone: phone(), concessionId: extra.concession.id });
    expect(body.concessionError).toMatchObject({ code: "CONCESSION_NOT_HERE" });
  });
});

describe("checking proof at the counter", () => {
  it("seen, stands, and is remembered for the time chosen: the fact only", async () => {
    const who = phone();
    const { body } = await post({ hours: [13], phone: who, concessionId: senior });
    const done = await checkConcession({ bookingId: body.booking.id, venueIds: null, adminId: null, outcome: "seen", remember: "year" });
    expect(done).toMatchObject({ ok: true, charged: 0, booking: { concessionCheck: "seen", totalPrice: 15 } });
    const proofs = await getDb().prepare("SELECT * FROM concession_proofs WHERE phone_key = phone_key(?)").all(who);
    expect(proofs).toHaveLength(1);
    expect(Object.keys(proofs[0] as object).sort()).toEqual(["concession_id", "phone_key", "seen_by", "seen_on", "valid_until", "venue_id"]);
    // Next time, however the number is typed, no need to ask.
    const again = await post({ hours: [14], phone: `+6${who}`, concessionId: senior });
    expect(again.body.booking.concessionCheck).toBe("seen");
    // It goes out with what the venue holds against the number.
    const held = await exportPhoneData([venueId], who);
    expect(held.concessionProofs).toHaveLength(1);
  });

  it("not shown, the full price is charged: added to what is owed", async () => {
    const who = phone();
    const { body } = await post({ hours: [15], phone: who, concessionId: senior });
    const done = await checkConcession({ bookingId: body.booking.id, venueIds: null, adminId: null, outcome: "refused" });
    expect(done).toMatchObject({ ok: true, charged: 5, booking: { totalPrice: 20, concessionCheck: "refused" } });
    expect(await checkConcession({ bookingId: body.booking.id, venueIds: null, adminId: null, outcome: "seen" })).toMatchObject({ ok: false });
  });

  it("not shown on one already paid, the difference is sold at the counter, receipted", async () => {
    const who = phone();
    const { body } = await post({ hours: [16], phone: who, concessionId: senior });
    expect((await setPaymentStatus(body.booking.code, true, "cash")).ok).toBe(true);
    expect(await checkConcession({ bookingId: body.booking.id, venueIds: null, adminId: null, outcome: "refused" })).toMatchObject({ ok: false });
    const done = await checkConcession({ bookingId: body.booking.id, venueIds: null, adminId: null, outcome: "refused", via: "qr" });
    expect(done).toMatchObject({ ok: true, charged: 5 });
    const sale = (await getDb().prepare("SELECT total::float AS total, paid_via FROM counter_sales WHERE phone_key(customer_phone) = phone_key(?)").get(who)) as {
      total: number;
      paid_via: string;
    };
    expect(sale).toEqual({ total: 5, paid_via: "qr" });
    expect(await findBooking(body.booking.code, who)).toMatchObject({ paymentStatus: "paid", concessionCheck: "refused" });
  });

  it("remembers until month end, year end or twelve months; or just this visit", () => {
    expect(rememberUntil("visit", "2026-10-22")).toBeNull();
    expect(rememberUntil("month", "2026-02-10")).toBe("2026-02-28");
    expect(rememberUntil("month", "2026-12-10")).toBe("2026-12-31");
    expect(rememberUntil("year", "2026-10-22")).toBe("2026-12-31");
    expect(rememberUntil("twelve", "2026-10-22")).toBe("2027-10-22");
  });
});
