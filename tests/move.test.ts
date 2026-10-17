import { describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import {
  adminCancelBooking,
  blockSlots,
  createBooking,
  createClassSessions,
  getPass,
  issuePass,
  listVenues,
  moveBooking,
  moveTargetsFor,
  payBookingWithPass,
  setPaymentStatus,
} from "../src/lib/store";
import { authenticateAdmin, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { addDays, todayISO } from "../src/lib/time";

const PHONE = "0123456789";
await ensureBootstrapAdmin();
const ADMIN_ID = (await authenticateAdmin("admin@mysenam.my", "mysenam-admin"))!.id;

const future = (o = 3) => addDays(todayISO(), o);

/** The seeded PJ venue: four badminton courts, plus other sports. */
async function venue() {
  return (await listVenues())[0];
}
async function courts(sport = "badminton") {
  return (await venue()).courts.filter((c) => c.sport === sport);
}
async function book(courtId: number, hours: number[], date: string, name = "Aisyah") {
  const r = await createBooking({ courtId, date, hours, name, phone: PHONE });
  if (!r.ok) throw new Error(r.error);
  return r.booking;
}
async function slotsOf(bookingId: number) {
  return await getDb()
    .prepare("SELECT court_id, hour, seat FROM booking_slots WHERE booking_id = ? ORDER BY hour")
    .all(bookingId) as { court_id: number; hour: number; seat: number }[];
}

describe("moving a booking to another court", () => {
  it("keeps the booking's identity: code, price, payment and check-in", async () => {
    const date = future(4);
    const [c1, c2] = await courts();
    const b = await book(c1.id, [10, 11], date);
    expect(await setPaymentStatus(b.code, true)).toMatchObject({ ok: true });
    // checkIn() only opens an hour before the slot, so plant the arrival
    // directly: what is under test is that a move preserves it.
    await getDb()
      .prepare("INSERT INTO check_ins (booking_id, checked_in_at) VALUES (?, datetime('now'))")
      .run(b.id);

    const moved = await moveBooking(b.code, c2.id);
    expect(moved).toMatchObject({ ok: true });
    if (!moved.ok) return;

    expect(moved.booking.code).toBe(b.code);
    expect(moved.booking.courtId).toBe(c2.id);
    expect(moved.fromCourt.id).toBe(c1.id);

    const row = await getDb()
      .prepare(
        "SELECT b.court_id, b.total_price, b.payment_status, ci.checked_in_at FROM bookings b LEFT JOIN check_ins ci ON ci.booking_id = b.id WHERE b.id = ?"
      )
      .get(b.id) as { court_id: number; total_price: number; payment_status: string; checked_in_at: string | null };
    expect(row.court_id).toBe(c2.id);
    // The price is what the customer agreed to, even though c1 is the premium court.
    expect(row.total_price).toBe(b.totalPrice);
    expect(row.payment_status).toBe("paid");
    expect(row.checked_in_at).not.toBeNull();

    // The slots followed, and nothing was left behind on the old court.
    const slots = await slotsOf(b.id);
    expect(slots.map((s) => s.hour)).toEqual([10, 11]);
    expect(slots.every((s) => s.court_id === c2.id)).toBe(true);
  });

  it("frees the court it left", async () => {
    const date = future(5);
    const [c1, c2] = await courts();
    const b = await book(c1.id, [9], date);
    expect(await moveBooking(b.code, c2.id)).toMatchObject({ ok: true });
    // The original hour can be sold again.
    expect(await createBooking({ courtId: c1.id, date, hours: [9], name: "Other", phone: "0198887777" }))
      .toMatchObject({ ok: true });
  });

  it("refuses a target that is taken for any one of the hours", async () => {
    const date = future(6);
    const [c1, c2] = await courts();
    const b = await book(c1.id, [14, 15, 16], date);
    // c2 is free at 14 and 16 but not 15.
    await book(c2.id, [15], date, "Someone else");

    const r = await moveBooking(b.code, c2.id);
    expect(r).toMatchObject({ ok: false });
    if (r.ok) return;
    expect(r.error).toContain("already taken");

    // Critically, the booking is untouched — not half-moved.
    const slots = await slotsOf(b.id);
    expect(slots).toHaveLength(3);
    expect(slots.every((s) => s.court_id === c1.id)).toBe(true);
  });

  it("refuses a blocked target, and a target running a class", async () => {
    const date = future(7);
    const [c1, c2, c3] = await courts();
    const b = await book(c1.id, [11], date);

    expect(await blockSlots(c2.id, date, [11], "Net repair")).toMatchObject({ ok: true });
    expect(await moveBooking(b.code, c2.id)).toMatchObject({ ok: false, error: expect.stringContaining("blocked") });

    expect(
      await createClassSessions({
        courtId: c3.id, name: "Junior Drills", instructor: "Coach Lee",
        date, startHour: 11, endHour: 12, capacity: 1, price: 30,
      })
    ).toMatchObject({ ok: true });
    expect(await moveBooking(b.code, c3.id)).toMatchObject({ ok: false, error: expect.stringContaining("Junior Drills") });

    expect((await slotsOf(b.id)).every((s) => s.court_id === c1.id)).toBe(true);
  });

  it("refuses across venues, across sports, and onto itself", async () => {
    const date = future(8);
    const [c1] = await courts();
    const b = await book(c1.id, [12], date);

    expect(await moveBooking(b.code, c1.id)).toMatchObject({ ok: false, error: "That booking is already on that court." });

    const otherVenueCourt = (await listVenues())[1].courts[0];
    expect(await moveBooking(b.code, otherVenueCourt.id)).toMatchObject({
      ok: false, error: "A booking can only move within the same venue.",
    });

    const gym = (await venue()).courts.find((c) => c.sport === "gym")!;
    expect(await moveBooking(b.code, gym.id)).toMatchObject({ ok: false, error: expect.stringContaining("Gym") });
  });

  it("refuses an unknown code, a cancelled booking and one already finished", async () => {
    const date = future(9);
    const [c1, c2] = await courts();
    expect(await moveBooking("MS-NOSUCH", c2.id)).toMatchObject({ ok: false, error: "Booking not found." });

    const b = await book(c1.id, [13], date);
    expect(await adminCancelBooking(b.code)).toMatchObject({ ok: true });
    expect(await moveBooking(b.code, c2.id)).toMatchObject({ ok: false, error: "This booking was cancelled." });

    // Back-date a booking's slots so it reads as finished, as time would.
    const past = await book(c1.id, [20], future(10));
    await getDb().prepare("UPDATE bookings SET date = ? WHERE id = ?").run(addDays(todayISO(), -1), past.id);
    await getDb().prepare("UPDATE booking_slots SET date = ? WHERE booking_id = ?").run(addDays(todayISO(), -1), past.id);
    expect(await moveBooking(past.code, c2.id)).toMatchObject({ ok: false, error: "That booking has already finished." });
  });

  it("keeps a pass-paid booking attached to its pass, without spending another entry", async () => {
    const date = future(11);
    const [c1, c2] = await courts();
    const pass = await issuePass({
      venueId: (await venue()).id, sport: "badminton", name: "10-hour pass", entries: 10, price: 120,
      holderName: "Aisyah", holderPhone: PHONE, expiresOn: addDays(todayISO(), 60), adminId: ADMIN_ID,
    });
    if (!pass.ok) throw new Error(pass.error);

    const b = await book(c1.id, [10, 11], date);
    expect(await payBookingWithPass(b.id, pass.pass.code)).toMatchObject({ ok: true, spent: 2 });
    expect((await getPass(pass.pass.code))?.remaining).toBe(8);

    expect(await moveBooking(b.code, c2.id)).toMatchObject({ ok: true });
    // Moving is not a re-purchase, and not a refund.
    expect((await getPass(pass.pass.code))?.remaining).toBe(8);
  });

  it("offers only courts that are actually free for the whole booking", async () => {
    const date = future(12);
    const [c1, c2, c3, c4] = await courts();
    const b = await book(c1.id, [15, 16], date);
    await book(c2.id, [16], date, "Blocker");           // busy for part of it
    await blockSlots(c3.id, date, [15], "Maintenance"); // blocked for part of it

    const ids = (await moveTargetsFor(b.code)).map((c) => c.id);
    expect(ids).toContain(c4.id);
    expect(ids).not.toContain(c1.id); // never itself
    expect(ids).not.toContain(c2.id);
    expect(ids).not.toContain(c3.id);
    // Never a different sport or venue.
    expect((await moveTargetsFor(b.code)).every((c) => c.sport === "badminton")).toBe(true);
  });

  it("offers nothing for a cancelled booking or an unknown code", async () => {
    const date = future(13);
    const b = await book((await courts())[0].id, [9], date);
    await adminCancelBooking(b.code);
    expect(await moveTargetsFor(b.code)).toEqual([]);
    expect(await moveTargetsFor("MS-NOSUCH")).toEqual([]);
  });
});
