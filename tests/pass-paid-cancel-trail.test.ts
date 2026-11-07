import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { createAdmin } from "../src/lib/admin-auth";
import { listActivity, logCancelledBookings } from "../src/lib/activity";
import { getDb } from "../src/lib/db";
import { logCancelled, staffCancel } from "../src/lib/counter-refunds";
import { adminCancelBooking, cancelBooking, createBooking, createCourt, createVenue, getPass, issuePass, listPassEntries, payBookingWithPass, setPaymentStatus } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Hardening, brief MONEY, D16 (ADR 0068): a booking a pass paid gives ENTRIES back when it is cancelled, never money. No credit note is
 * written for money that was never taken (the journal already hid such notes, which left gaps in the credit-note numbers); the trail is
 * the pass's own ledger (an entry given back, with the booking) and, for staff, the activity log saying so.
 */

let venueId: number;
let courtId: number;
const today = todayISO();
let n = 0;
let day = 3;
const phone = () => `0197${String(++n).padStart(6, "0")}`;

beforeAll(async () => {
  const v = await createVenue({ name: "Trail Courts", area: "PJ", address: "x", phone: "0355550000" });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  const c = await createCourt({ venueId, name: "C1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!c.ok) throw new Error("court");
  courtId = c.court.id;
});

async function passBooking(ph: string, entries = 10) {
  const p = await issuePass({ venueId, name: "Ten", entries, price: 150, holderName: "Aisyah", holderPhone: ph, expiresOn: addDays(today, 90), adminId: null });
  if (!p.ok) throw new Error(JSON.stringify(p));
  const b = await createBooking({ courtId, date: addDays(today, ++day), hours: [10], name: "Aisyah", phone: ph });
  if (!b.ok) throw new Error(JSON.stringify(b));
  expect((await payBookingWithPass(b.booking.id, p.pass.code)).ok).toBe(true);
  return { pass: p.pass, booking: b.booking };
}
const notesFor = async (bookingId: number) =>
  (await getDb().prepare("SELECT number, total::float AS total FROM receipts WHERE kind = 'credit_note' AND (source = ? OR source LIKE ?) ORDER BY id").all(`booking:${bookingId}`, `booking:${bookingId}:%`)) as {
    number: string;
    total: number;
  }[];

describe("D16: cancelling a booking that a pass paid", () => {
  it("the customer's cancellation gives the entry back and writes no credit note", async () => {
    const ph = phone();
    const { pass, booking } = await passBooking(ph);
    expect((await getPass(pass.code))!.remaining).toBe(9);
    expect((await cancelBooking(booking.code, ph)).ok).toBe(true);
    expect(await notesFor(booking.id)).toEqual([]);
    expect((await getPass(pass.code))!.remaining).toBe(10);
    const history = await listPassEntries(pass.id);
    expect(history.find((e) => e.delta === 1)?.reason).toContain(booking.code);
  });

  it("the venue's cancellation and a staff cancellation (the front desk or a manager) write none either, and staff are told the entries went back", async () => {
    const ph = phone();
    const one = await passBooking(ph);
    expect((await adminCancelBooking(one.booking.code)).ok).toBe(true);
    expect(await notesFor(one.booking.id)).toEqual([]);

    const two = await passBooking(phone());
    const made = await createAdmin({ name: "Musa Manager", email: "musa@trail.my", password: "manager-pass-1", venueId });
    if (!made.ok) throw new Error(made.error);
    const staff = { id: made.admin.id, name: "Musa Manager", role: "manager" as const };
    const done = await staffCancel(two.booking.code, staff, { outcome: "back" });
    if (!done.result.ok) throw new Error(done.result.error);
    // As the route does after a staff cancellation.
    await logCancelled(staff, venueId, done.result.booking, done.settled);
    expect(await notesFor(two.booking.id)).toEqual([]);
    expect((await getPass(two.pass.code))!.remaining).toBe(10);
    const logged = (await listActivity([venueId])).find((e) => e.action === "booking.cancelled" && e.bookingCode === two.booking.code);
    expect(logged?.detail).toContain("1 entry went back to the pass");
    expect(logged?.detail).toContain("no money");
    // The venue's own bulk cancellations (a closed day, a rain-out) say the same.
    const three = await passBooking(phone());
    const cancelled = await adminCancelBooking(three.booking.code);
    if (!cancelled.ok) throw new Error(cancelled.error);
    await logCancelledBookings(staff, venueId, [cancelled.booking], "closed for the day");
    const bulk = (await listActivity([venueId])).find((e) => e.action === "booking.cancelled" && e.bookingCode === three.booking.code);
    expect(bulk?.detail).toContain("closed for the day; 1 entry went back to the pass, no money paid out");
  });

  it("said twice (a retry, a double click) the entry goes back once and still no note is written", async () => {
    const ph = phone();
    const { pass, booking } = await passBooking(ph);
    const results = await Promise.all([cancelBooking(booking.code, ph), cancelBooking(booking.code, ph), adminCancelBooking(booking.code)]);
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect((await getPass(pass.code))!.remaining).toBe(10);
    expect(await notesFor(booking.id)).toEqual([]);
  });

  it("a booking paid with money still gets its credit note, and the numbers run without a gap", async () => {
    const ph = phone();
    const b = await createBooking({ courtId, date: addDays(today, ++day), hours: [11], name: "Ben", phone: ph });
    if (!b.ok) throw new Error(JSON.stringify(b));
    expect((await setPaymentStatus(b.booking.code, true, "cash")).ok).toBe(true);
    // A pass-paid cancellation between two money ones takes no number.
    const before = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM receipts WHERE kind = 'credit_note'").get()) as { n: number };
    const pass = await passBooking(phone());
    expect((await cancelBooking(pass.booking.code, pass.booking.phone)).ok).toBe(true);
    expect((await getDb().prepare("SELECT COUNT(*)::int AS n FROM receipts WHERE kind = 'credit_note'").get()) as { n: number }).toEqual(before);
    expect((await cancelBooking(b.booking.code, ph)).ok).toBe(true);
    expect(await notesFor(b.booking.id)).toEqual([{ number: expect.any(String), total: 20 }]);
  });

  it("a credit note written before this change stays as it was (history is never rewritten)", async () => {
    const ph = phone();
    const { booking } = await passBooking(ph);
    // As an earlier release left it.
    await getDb()
      .prepare(
        `INSERT INTO receipts (venue_id, kind, seq, number, source, customer_name, lines, total, paid_via, note)
         VALUES (?, 'credit_note', 900, 'CN-000900', ?, 'Aisyah', '[]', 20, 'Pass', 'receipt.why.cancelled')`
      )
      .run(venueId, `booking:${booking.id}`);
    expect((await cancelBooking(booking.code, ph)).ok).toBe(true);
    expect((await notesFor(booking.id)).map((x) => x.number)).toEqual(["CN-000900"]);
  });
});
