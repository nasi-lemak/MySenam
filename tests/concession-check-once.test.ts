import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { applyAskedDiscounts } from "../src/lib/booking-discounts";
import { checkConcession, saveConcession } from "../src/lib/concessions";
import { getDb } from "../src/lib/db";
import { createBooking, createCourt, createVenue, getBookingById, setPaymentStatus } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Audit 9 D2 (ADR 0062): the desk's "no proof shown" is decided once, under the booking's row lock. A double click, a second desk or a
 * retry cannot charge the concession back twice; a proof marked seen stays seen.
 */

let venueId: number;
let courtId: number;
let student: number;
const today = todayISO();
const together = <T>(n: number, fn: (i: number) => Promise<T>) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));

beforeAll(async () => {
  const v = await createVenue({ name: "Concession Once Hall", area: "PJ", address: "1", phone: "0312345678" });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  const c = await createCourt({ venueId, name: "C1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!c.ok) throw new Error("court");
  courtId = c.court.id;
  const s = await saveConcession(venueId, { name: "Student", percent: 50, proof: "your student card" });
  if (!s.ok) throw new Error("concession");
  student = s.concession.id;
});

async function conc(phone: string, hour: number) {
  const b = await createBooking({ courtId, date: addDays(today, 3), hours: [hour], name: "Nurul", phone });
  if (!b.ok) throw new Error(JSON.stringify(b));
  await applyAskedDiscounts([b.booking], { concessionId: student });
  const row = (await getBookingById(b.booking.id))!;
  expect(row.totalPrice).toBe(10);
  return row;
}
const check = (bookingId: number, outcome: "seen" | "refused", via?: string) => checkConcession({ bookingId, venueIds: null, adminId: null, outcome, ...(via ? { via } : {}) });

describe("a desk double-click on 'no proof shown'", () => {
  it("charges the full price back once on an unpaid booking, however many clicks arrive together", async () => {
    const b = await conc("0192220001", 9);
    const results = await together(4, () => check(b.id, "refused"));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.error === "The full price is already charged on this one.")).toBe(true);
    // The 10.00 concession comes back onto the bill once: 20.00, never 30.00 or 40.00.
    expect((await getBookingById(b.id))!.totalPrice).toBe(20);
  });

  it("sells the difference at the counter once on a paid booking", async () => {
    const b = await conc("0192220002", 10);
    expect((await setPaymentStatus(b.code, true, "cash", "manager", null)).ok).toBe(true);
    const results = await together(3, () => check(b.id, "refused", "cash"));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const sales = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM receipts WHERE customer_phone = ? AND source LIKE 'sale:%'").get("0192220002")) as { n: number };
    expect(sales.n).toBe(1);
  });

  it("a repeat, one after the other, is refused and charges nothing more", async () => {
    const b = await conc("0192220005", 14);
    expect(await check(b.id, "refused")).toMatchObject({ ok: true, charged: 10 });
    expect(await check(b.id, "refused")).toMatchObject({ ok: false });
    expect((await getBookingById(b.id))!.totalPrice).toBe(20);
  });

  it("a proof already marked seen is not turned into a charge by a later click; seen again is harmless", async () => {
    const b = await conc("0192220003", 11);
    expect((await check(b.id, "seen")).ok).toBe(true);
    expect(await check(b.id, "refused")).toMatchObject({ ok: false, error: "The proof was already marked as seen." });
    expect((await check(b.id, "seen")).ok).toBe(true);
    expect((await getBookingById(b.id))!.totalPrice).toBe(10);
  });

  it("seen and refused together: one wins and the other finds what it left", async () => {
    const b = await conc("0192220004", 12);
    const [seen, refused] = await Promise.all([check(b.id, "seen"), check(b.id, "refused")]);
    const total = (await getBookingById(b.id))!.totalPrice;
    // Either the proof was seen first (nothing charged, the refusal turned away) or the refusal came first (charged once, the sighting turned away).
    if (seen.ok) {
      expect(refused.ok).toBe(false);
      expect(total).toBe(10);
    } else {
      expect(refused.ok).toBe(true);
      expect(total).toBe(20);
    }
  });
});
