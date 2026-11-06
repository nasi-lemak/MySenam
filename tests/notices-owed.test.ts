import { afterEach, beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

import { getDb } from "../src/lib/db";
import { notifyBookingConfirmed, notifyVenueCancelled, tellOwedNotices, tickOutbox } from "../src/lib/notify";
import { owingCustomer } from "../src/lib/notices-owed";
import { messagesForBooking, setTransport } from "../src/lib/outbox";
import { adminCancelBooking, cancelBooking, createBooking, createBookingSeries, listVenues } from "../src/lib/store";
import { createNotice, openNotices } from "../src/lib/urgent";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Audit 9, G11 and C17: a request that stops after the booking, the venue's cancellation or the customer's cancellation is committed and
 * before its message is written. The transaction that made the fact also wrote a `notices_owed` row; the outbox's tick finds a row whose
 * message does not exist and writes it, once, on any number of servers. The stop is simulated by not calling the notify function the route
 * would have called.
 */
let venueId: number;
let courtId: number;
let n = 0;
let bookings = 0;

beforeAll(async () => {
  const v = (await listVenues()).find((x) => x.courts.some((c) => c.capacity === 1 && c.sport === "badminton"))!;
  venueId = v.id;
  courtId = v.courts.find((c) => c.capacity === 1 && c.sport === "badminton")!.id;
});
afterEach(() => setTransport(null));

// A distinct day and hour for each booking, so none meets another (the days stay inside the booking window).
const slot = () => {
  const i = bookings++;
  return { date: addDays(todayISO(), 3 + (i % 6)), hour: 9 + Math.floor(i / 6) };
};
const person = () => ({ name: "Owed Person", phone: `0165${String(++n).padStart(6, "0")}`, email: `owed${n}@example.my` });
/** Long enough ago that the request that made it must have finished. */
const aged = () => getDb().prepare("UPDATE notices_owed SET created_at = datetime('now', '-10 minutes') WHERE told_at IS NULL").run();
// By email: the venue also writes urgent news on WhatsApp, a second copy of the same message.
const kindsFor = async (id: number) => (await messagesForBooking(id)).filter((m) => m.channel === "email").map((m) => m.kind);

/** The booking route's creation, up to the stop: made under `owingCustomer`, never told. */
async function bookedThenStopped() {
  const { date, hour } = slot();
  const made = await owingCustomer("booking_confirmed", () => createBooking({ courtId, date, hours: [hour], ...person() }));
  if (!made.ok) throw new Error(made.error);
  return made.booking;
}

describe("a booking whose confirmation was never written", () => {
  it("is found again by the tick, once the request that made it must be over, and the customer gets the confirmation once", async () => {
    const b = await bookedThenStopped();
    expect(await getDb().prepare("SELECT kind, told_at FROM notices_owed WHERE booking_id = ?").get(b.id)).toEqual({ kind: "booking_confirmed", told_at: null });
    setTransport({ name: "recorder", async send() {} });
    // The request may still be running: nothing yet.
    await tickOutbox();
    expect(await kindsFor(b.id)).toEqual([]);
    await aged();
    await tickOutbox();
    expect(await kindsFor(b.id)).toEqual(["booking_confirmed"]);
    expect(await getDb().prepare("SELECT told_at IS NOT NULL AS told FROM notices_owed WHERE booking_id = ?").get(b.id)).toEqual({ told: true });
    await tickOutbox();
    await tickOutbox();
    expect(await kindsFor(b.id)).toEqual(["booking_confirmed"]);
  });

  it("two servers sweeping at the same moment write it once", async () => {
    const b = await bookedThenStopped();
    await aged();
    await Promise.all([tellOwedNotices(), tellOwedNotices(), tellOwedNotices()]);
    expect((await kindsFor(b.id)).filter((k) => k === "booking_confirmed")).toHaveLength(1);
  });

  it("is not told twice when the request did write it: the sweep only marks the row", async () => {
    const b = await bookedThenStopped();
    await notifyBookingConfirmed([b], "en", null);
    await aged();
    expect(await tellOwedNotices()).toBe(0);
    expect(await kindsFor(b.id)).toEqual(["booking_confirmed"]);
    expect(await getDb().prepare("SELECT told_at IS NOT NULL AS told FROM notices_owed WHERE booking_id = ?").get(b.id)).toEqual({ told: true });
  });

  it("owes nothing for a booking made some other way (the desk, a key, a test): those tell nobody here", async () => {
    const at = slot();
    const made = await createBooking({ courtId, date: at.date, hours: [at.hour], ...person() });
    if (!made.ok) throw new Error(made.error);
    expect(await getDb().prepare("SELECT COUNT(*)::int AS n FROM notices_owed WHERE booking_id = ?").get(made.booking.id)).toEqual({ n: 0 });
    await aged();
    await tickOutbox();
    expect(await kindsFor(made.booking.id)).toEqual([]);
  });

  it("waits for a booking held for payment (it is told when paid), says nothing for one released, and tells one paid", async () => {
    const held = await bookedThenStopped();
    await getDb().prepare("UPDATE bookings SET hold_until = datetime('now', '+10 minutes') WHERE id = ?").run(held.id);
    const released = await bookedThenStopped();
    await getDb().prepare("UPDATE bookings SET hold_until = datetime('now', '-1 minutes'), status = 'cancelled' WHERE id = ?").run(released.id);
    await aged();
    await tickOutbox();
    expect(await kindsFor(held.id)).toEqual([]);
    expect(await kindsFor(released.id)).toEqual([]);
    expect(await getDb().prepare("SELECT told_at IS NULL AS owed FROM notices_owed WHERE booking_id = ?").get(held.id)).toEqual({ owed: true });
    expect(await getDb().prepare("SELECT told_at IS NOT NULL AS told FROM notices_owed WHERE booking_id = ?").get(released.id)).toEqual({ told: true });
    // Paid, and the server stopped before the confirmation that follows payment.
    await getDb().prepare("UPDATE bookings SET payment_status = 'paid', hold_until = NULL WHERE id = ?").run(held.id);
    await tickOutbox();
    expect(await kindsFor(held.id)).toEqual(["booking_confirmed"]);
  });

  it("a series is one confirmation for all its weeks", async () => {
    const at = slot();
    const made = await owingCustomer("booking_confirmed", () => createBookingSeries({ courtId, date: at.date, hours: [at.hour], weeks: 3, ...person() }));
    if (!made.ok) throw new Error(made.error);
    expect(made.bookings).toHaveLength(3);
    await aged();
    await tickOutbox();
    const all = (await Promise.all(made.bookings.map((b) => messagesForBooking(b.id)))).flat();
    expect(all.filter((m) => m.kind === "booking_series_confirmed")).toHaveLength(1);
    expect(await getDb().prepare("SELECT COUNT(*)::int AS n FROM notices_owed WHERE told_at IS NULL AND booking_id IN (?, ?, ?)").get(...made.bookings.map((b) => b.id))).toEqual({ n: 0 });
  });
});

describe("a booking the venue cancelled whose customer was never told", () => {
  it("is found again: the customer is told, and the desk's list has the notice, once", async () => {
    const b = await bookedThenStopped();
    await notifyBookingConfirmed([b], "en", null);
    const off = await owingCustomer("booking_cancelled_by_venue", () => adminCancelBooking(b.code));
    expect(off.ok).toBe(true);
    // (the server stopped here: notifyVenueCancelled was never reached)
    setTransport({ name: "recorder", async send() {} });
    await aged();
    await tickOutbox();
    await tickOutbox();
    expect((await kindsFor(b.id)).filter((k) => k === "booking_cancelled_by_venue")).toHaveLength(1);
    expect((await openNotices([venueId])).filter((x) => x.bookingId === b.id)).toHaveLength(1);
  });

  it("is not told twice when the request did tell them", async () => {
    const b = await bookedThenStopped();
    const off = await owingCustomer("booking_cancelled_by_venue", () => adminCancelBooking(b.code));
    if (!off.ok) throw new Error("cancel");
    await notifyVenueCancelled(off.booking);
    await aged();
    await tickOutbox();
    expect((await kindsFor(b.id)).filter((k) => k === "booking_cancelled_by_venue")).toHaveLength(1);
    expect((await openNotices([venueId])).filter((x) => x.bookingId === b.id)).toHaveLength(1);
  });

  it("does not make a second notice when the request stopped between the notice and the message", async () => {
    const b = await bookedThenStopped();
    const off = await owingCustomer("booking_cancelled_by_venue", () => adminCancelBooking(b.code));
    if (!off.ok) throw new Error("cancel");
    await createNotice({ venueId, bookingId: b.id, kind: "cancelled", name: b.name, phone: b.phone, email: b.email ?? null, date: b.date, startMin: b.startMin, summary: "cancelled" });
    await aged();
    await tickOutbox();
    expect((await kindsFor(b.id)).filter((k) => k === "booking_cancelled_by_venue")).toHaveLength(1);
    expect((await openNotices([venueId])).filter((x) => x.bookingId === b.id)).toHaveLength(1);
    const message = (await messagesForBooking(b.id)).find((m) => m.kind === "booking_cancelled_by_venue")!;
    expect(message.body).toContain("/ack/");
  });

  it("a cancellation by other means (not under the route that tells the customer) owes nothing", async () => {
    const at = slot();
    const made = await createBooking({ courtId, date: at.date, hours: [at.hour], ...person() });
    if (!made.ok) throw new Error(made.error);
    expect((await adminCancelBooking(made.booking.code)).ok).toBe(true);
    expect(await getDb().prepare("SELECT COUNT(*)::int AS n FROM notices_owed WHERE booking_id = ?").get(made.booking.id)).toEqual({ n: 0 });
  });
});

describe("a customer's cancellation whose message was never written (C17)", () => {
  it("is found again: the customer is told it is cancelled, once", async () => {
    const b = await bookedThenStopped();
    await notifyBookingConfirmed([b], "en", null);
    const done = await cancelBooking(b.code, b.phone);
    expect(done.ok).toBe(true);
    // (the server stopped here, before refundCancelled and notifyBookingCancelled)
    expect(await getDb().prepare("SELECT kind FROM notices_owed WHERE booking_id = ? AND kind = 'booking_cancelled'").get(b.id)).toEqual({ kind: "booking_cancelled" });
    setTransport({ name: "recorder", async send() {} });
    await aged();
    await tickOutbox();
    await tickOutbox();
    const told = (await messagesForBooking(b.id)).filter((m) => m.kind === "booking_cancelled");
    expect(told).toHaveLength(1);
    expect(told[0].body).toContain(b.code);
  });

  it("says what is owed back from the refund as it stands, not that nothing is owed, for money paid online", async () => {
    const b = await bookedThenStopped();
    await getDb().prepare("UPDATE bookings SET payment_status = 'paid' WHERE id = ?").run(b.id);
    const payment = (await getDb()
      .prepare("INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, status, payer_name, refund_due) VALUES ('fake', ?, 'x', ?, 30, 'paid', 'P', 30) RETURNING id")
      .get(`owed-${b.id}`, venueId)) as { id: number };
    await getDb().prepare("INSERT INTO online_payment_bookings (payment_id, booking_id) VALUES (?, ?)").run(payment.id, b.id);
    expect((await cancelBooking(b.code, b.phone)).ok).toBe(true);
    await aged();
    await tickOutbox();
    const told = (await messagesForBooking(b.id)).find((m) => m.kind === "booking_cancelled")!;
    expect(told.body).not.toContain("Nothing is owed");
    expect(told.body).toMatch(/refund/i);
  });

  it("does not tell twice when the route did", async () => {
    const b = await bookedThenStopped();
    const done = await cancelBooking(b.code, b.phone);
    if (!done.ok) throw new Error("cancel");
    const { notifyBookingCancelled } = await import("../src/lib/notify");
    await notifyBookingCancelled(done.booking, "en", {});
    await aged();
    await tickOutbox();
    expect((await kindsFor(b.id)).filter((k) => k === "booking_cancelled")).toHaveLength(1);
  });
});
