import { beforeAll, describe, expect, it, vi } from "vitest";
process.env.MYSENAM_DB = ":memory:";
vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "localhost:3000" }), cookies: async () => ({ get: () => undefined }) }));
import { counterOwed, settleOwed, staffCancel, type CancellingStaff } from "../src/lib/counter-refunds";
import { getDb } from "../src/lib/db";
import { createBooking, createCourt, createVenue, rescheduleBooking, setPaymentStatus } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

const manager: CancellingStaff = { id: null, name: "Mira (manager)", role: "manager" };
let venueId: number, dear: number, cheap: number, lowest: number;
beforeAll(async () => {
  const made = await createVenue({ name: "Repro", area: "PJ", address: "x", phone: "0300000099", openMin: 8 * 60, closeMin: 22 * 60 });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const mk = async (name: string, rate: number) => { const c = await createCourt({ venueId, name, sport: "badminton", offPeakRate: rate, peakRate: rate }); if (!c.ok) throw new Error("c"); return c.court.id; };
  dear = await mk("Dear", 60); cheap = await mk("Cheap", 25); lowest = await mk("Lowest", 20);
});
async function paid(hour: number) {
  const date = addDays(todayISO(), 4);
  const b = await createBooking({ courtId: dear, date, hours: [hour], name: "A", phone: `0187700${hour}0` });
  if (!b.ok) throw new Error("b");
  await setPaymentStatus(b.booking.code, true, "cash");
  return { code: b.booking.code, id: b.booking.id, date, hour };
}
async function payouts(bookingId: number) {
  return (await getDb().prepare("SELECT amount::float AS amount FROM counter_payouts WHERE booking_id = ? ORDER BY id").all(bookingId)) as { amount: number }[];
}

// A booking can be handed back at the counter more than once: each cheaper move owes its own
// difference and a cancellation owes the rest (migration 0342 dropped `counter_payouts_booking_id_key`).
describe("more than one hand-back at the counter for one booking", () => {
  it("moved cheaper twice: both differences are handed back, nothing stays owed", async () => {
    const b = await paid(9);
    await rescheduleBooking(b.code, { date: b.date, start: b.hour * 60, courtId: cheap }, "customer");
    await rescheduleBooking(b.code, { date: b.date, start: b.hour * 60, courtId: lowest }, "customer");
    const owed = (await counterOwed([venueId], "manager")).filter((o) => o.bookingCode === b.code);
    expect(owed).toHaveLength(2);
    expect((await settleOwed(owed[0].id, "back", manager)).ok).toBe(true);
    expect((await settleOwed(owed[1].id, "back", manager)).ok).toBe(true);
    expect((await counterOwed([venueId], "manager")).filter((o) => o.bookingCode === b.code)).toHaveLength(0);
    const rows = await payouts(b.id);
    expect(rows).toHaveLength(2);
    expect(rows.reduce((t, r) => t + r.amount, 0)).toBe(40);
  });

  it("moved cheaper, the difference handed back, then staff cancel: the rest goes back and the booking is cancelled", async () => {
    const b = await paid(10);
    await rescheduleBooking(b.code, { date: b.date, start: b.hour * 60, courtId: cheap }, "customer");
    const owed = (await counterOwed([venueId], "manager")).filter((o) => o.bookingCode === b.code);
    expect((await settleOwed(owed[0].id, "back", manager)).ok).toBe(true);
    const cancelled = await staffCancel(b.code, manager, { outcome: "back" });
    expect(cancelled.result.ok).toBe(true);
    expect(((await getDb().prepare("SELECT status FROM bookings WHERE id = ?").get(b.id)) as { status: string }).status).toBe("cancelled");
    const rows = await payouts(b.id);
    expect(rows).toHaveLength(2);
    // What was paid, handed back in two parts: no more and no less.
    expect(rows.reduce((t, r) => t + r.amount, 0)).toBe(60);
  });

  it("two staff settling the same difference at once: it is handed back once", async () => {
    const b = await paid(11);
    await rescheduleBooking(b.code, { date: b.date, start: b.hour * 60, courtId: cheap }, "customer");
    const owed = (await counterOwed([venueId], "manager")).filter((o) => o.bookingCode === b.code);
    const results = await Promise.all([settleOwed(owed[0].id, "back", manager), settleOwed(owed[0].id, "back", manager)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await payouts(b.id)).toHaveLength(1);
  });
});
