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
ensureBootstrapAdmin();
const ADMIN_ID = authenticateAdmin("admin@mysenam.my", "mysenam-admin")!.id;

const future = (o = 3) => addDays(todayISO(), o);

/** The seeded PJ venue: four badminton courts, plus other sports. */
function venue() {
  return listVenues()[0];
}
function courts(sport = "badminton") {
  return venue().courts.filter((c) => c.sport === sport);
}
function book(courtId: number, hours: number[], date: string, name = "Aisyah") {
  const r = createBooking({ courtId, date, hours, name, phone: PHONE });
  if (!r.ok) throw new Error(r.error);
  return r.booking;
}
function slotsOf(bookingId: number) {
  return getDb()
    .prepare("SELECT court_id, hour, seat FROM booking_slots WHERE booking_id = ? ORDER BY hour")
    .all(bookingId) as { court_id: number; hour: number; seat: number }[];
}

describe("moving a booking to another court", () => {
  it("keeps the booking's identity: code, price, payment and check-in", () => {
    const date = future(4);
    const [c1, c2] = courts();
    const b = book(c1.id, [10, 11], date);
    expect(setPaymentStatus(b.code, true)).toMatchObject({ ok: true });
    // checkIn() only opens an hour before the slot, so plant the arrival
    // directly: what is under test is that a move preserves it.
    getDb()
      .prepare("INSERT INTO check_ins (booking_id, checked_in_at) VALUES (?, datetime('now'))")
      .run(b.id);

    const moved = moveBooking(b.code, c2.id);
    expect(moved).toMatchObject({ ok: true });
    if (!moved.ok) return;

    expect(moved.booking.code).toBe(b.code);
    expect(moved.booking.courtId).toBe(c2.id);
    expect(moved.fromCourt.id).toBe(c1.id);

    const row = getDb()
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
    const slots = slotsOf(b.id);
    expect(slots.map((s) => s.hour)).toEqual([10, 11]);
    expect(slots.every((s) => s.court_id === c2.id)).toBe(true);
  });

  it("frees the court it left", () => {
    const date = future(5);
    const [c1, c2] = courts();
    const b = book(c1.id, [9], date);
    expect(moveBooking(b.code, c2.id)).toMatchObject({ ok: true });
    // The original hour can be sold again.
    expect(createBooking({ courtId: c1.id, date, hours: [9], name: "Other", phone: "0198887777" }))
      .toMatchObject({ ok: true });
  });

  it("refuses a target that is taken for any one of the hours", () => {
    const date = future(6);
    const [c1, c2] = courts();
    const b = book(c1.id, [14, 15, 16], date);
    // c2 is free at 14 and 16 but not 15.
    book(c2.id, [15], date, "Someone else");

    const r = moveBooking(b.code, c2.id);
    expect(r).toMatchObject({ ok: false });
    if (r.ok) return;
    expect(r.error).toContain("already taken");

    // Critically, the booking is untouched — not half-moved.
    const slots = slotsOf(b.id);
    expect(slots).toHaveLength(3);
    expect(slots.every((s) => s.court_id === c1.id)).toBe(true);
  });

  it("refuses a blocked target, and a target running a class", () => {
    const date = future(7);
    const [c1, c2, c3] = courts();
    const b = book(c1.id, [11], date);

    expect(blockSlots(c2.id, date, [11], "Net repair")).toMatchObject({ ok: true });
    expect(moveBooking(b.code, c2.id)).toMatchObject({ ok: false, error: expect.stringContaining("blocked") });

    expect(
      createClassSessions({
        courtId: c3.id, name: "Junior Drills", instructor: "Coach Lee",
        date, startHour: 11, endHour: 12, capacity: 1, price: 30,
      })
    ).toMatchObject({ ok: true });
    expect(moveBooking(b.code, c3.id)).toMatchObject({ ok: false, error: expect.stringContaining("Junior Drills") });

    expect(slotsOf(b.id).every((s) => s.court_id === c1.id)).toBe(true);
  });

  it("refuses across venues, across sports, and onto itself", () => {
    const date = future(8);
    const [c1] = courts();
    const b = book(c1.id, [12], date);

    expect(moveBooking(b.code, c1.id)).toMatchObject({ ok: false, error: "That booking is already on that court." });

    const otherVenueCourt = listVenues()[1].courts[0];
    expect(moveBooking(b.code, otherVenueCourt.id)).toMatchObject({
      ok: false, error: "A booking can only move within the same venue.",
    });

    const gym = venue().courts.find((c) => c.sport === "gym")!;
    expect(moveBooking(b.code, gym.id)).toMatchObject({ ok: false, error: expect.stringContaining("Gym") });
  });

  it("refuses an unknown code, a cancelled booking and one already finished", () => {
    const date = future(9);
    const [c1, c2] = courts();
    expect(moveBooking("MS-NOSUCH", c2.id)).toMatchObject({ ok: false, error: "Booking not found." });

    const b = book(c1.id, [13], date);
    expect(adminCancelBooking(b.code)).toMatchObject({ ok: true });
    expect(moveBooking(b.code, c2.id)).toMatchObject({ ok: false, error: "This booking was cancelled." });

    // Back-date a booking's slots so it reads as finished, as time would.
    const past = book(c1.id, [20], future(10));
    getDb().prepare("UPDATE bookings SET date = ? WHERE id = ?").run(addDays(todayISO(), -1), past.id);
    getDb().prepare("UPDATE booking_slots SET date = ? WHERE booking_id = ?").run(addDays(todayISO(), -1), past.id);
    expect(moveBooking(past.code, c2.id)).toMatchObject({ ok: false, error: "That booking has already finished." });
  });

  it("keeps a pass-paid booking attached to its pass, without spending another entry", () => {
    const date = future(11);
    const [c1, c2] = courts();
    const pass = issuePass({
      venueId: venue().id, sport: "badminton", name: "10-hour pass", entries: 10, price: 120,
      holderName: "Aisyah", holderPhone: PHONE, expiresOn: addDays(todayISO(), 60), adminId: ADMIN_ID,
    });
    if (!pass.ok) throw new Error(pass.error);

    const b = book(c1.id, [10, 11], date);
    expect(payBookingWithPass(b.id, pass.pass.code)).toMatchObject({ ok: true, spent: 2 });
    expect(getPass(pass.pass.code)?.remaining).toBe(8);

    expect(moveBooking(b.code, c2.id)).toMatchObject({ ok: true });
    // Moving is not a re-purchase, and not a refund.
    expect(getPass(pass.pass.code)?.remaining).toBe(8);
  });

  it("offers only courts that are actually free for the whole booking", () => {
    const date = future(12);
    const [c1, c2, c3, c4] = courts();
    const b = book(c1.id, [15, 16], date);
    book(c2.id, [16], date, "Blocker");           // busy for part of it
    blockSlots(c3.id, date, [15], "Maintenance"); // blocked for part of it

    const ids = moveTargetsFor(b.code).map((c) => c.id);
    expect(ids).toContain(c4.id);
    expect(ids).not.toContain(c1.id); // never itself
    expect(ids).not.toContain(c2.id);
    expect(ids).not.toContain(c3.id);
    // Never a different sport or venue.
    expect(moveTargetsFor(b.code).every((c) => c.sport === "badminton")).toBe(true);
  });

  it("offers nothing for a cancelled booking or an unknown code", () => {
    const date = future(13);
    const b = book(courts()[0].id, [9], date);
    adminCancelBooking(b.code);
    expect(moveTargetsFor(b.code)).toEqual([]);
    expect(moveTargetsFor("MS-NOSUCH")).toEqual([]);
  });
});
