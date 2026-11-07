import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { listActivity } from "../src/lib/activity";
import { ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { logCancelled, previewStaffCancel, staffCancel } from "../src/lib/counter-refunds";
import {
  accessCodeFor,
  accessGivenTo,
  cancelBooking,
  cancelSeries,
  checkIn,
  checkInByToken,
  createBooking,
  createBookingSeries,
  createCourt,
  listVenues,
  recordInduction,
  seriesCancelPlan,
  setPaymentStatus,
  updateCourt,
  updateVenue,
} from "../src/lib/store";
import { todayISO } from "../src/lib/time";

/**
 * ADR 0069 / DEC-45: a customer must not get both a full refund and continued use of a court without the venue's say. Cancelling
 * after access was given is judged on what was given: nothing, or only a door code shown on their phone (the booking's own terms:
 * nothing is taken for having looked), against their own check-in or a staff-verified arrival (online cancelling goes to staff).
 * Staff's own cancellation stays, on the record, as the explicit exception.
 *
 * The clock is fixed to the hour before a noon session, so none of this depends on the time of day.
 */

const HOUR = 12;
let venueId: number;
let adminId: number;
let n = 0;
const phone = () => `0179922${String(++n).padStart(4, "0")}`;
const date = () => {
  vi.useRealTimers();
  const d = todayISO();
  vi.useFakeTimers({ toFake: ["Date"] });
  return d;
};

/** A paid booking for noon today, with the clock at 11:40 (inside the 60 minutes check-in opens before the start). */
async function soon(courtId: number, opts: { paid?: boolean; hour?: number } = {}) {
  const day = date();
  const hour = opts.hour ?? HOUR;
  vi.setSystemTime(new Date(`${day}T${String(hour - 1).padStart(2, "0")}:30:00+08:00`));
  const who = phone();
  const made = await createBooking({ courtId, date: day, hours: [hour], name: "Mei", phone: who });
  if (!made.ok) throw new Error(made.error);
  if (opts.paid !== false) await setPaymentStatus(made.booking.code, true);
  vi.setSystemTime(new Date(`${day}T${String(hour - 1).padStart(2, "0")}:40:00+08:00`));
  return { ...made.booking, who };
}

async function newCourt(unmanned = false) {
  const made = await createCourt({ venueId, name: `Arrival Court ${++n}`, sport: "badminton", offPeakRate: 20, peakRate: 20, capacity: 1 });
  if (!made.ok) throw new Error(made.error);
  if (!unmanned) return made.court;
  const open = await updateCourt(made.court.id, { unmanned: true, accessCode: "4821" });
  if (!open.ok) throw new Error(open.error);
  return open.court;
}

const status = async (code: string) =>
  ((await getDb().prepare("SELECT status FROM bookings WHERE code = ?").get(code)) as { status: string }).status;
const creditNotes = async (code: string) =>
  ((await getDb()
    .prepare("SELECT COUNT(*)::int AS c FROM receipts WHERE kind = 'credit_note' AND source = (SELECT 'booking:' || id FROM bookings WHERE code = ?)")
    .get(code)) as { c: number }).c;
const checkInRows = async (code: string) =>
  ((await getDb().prepare("SELECT COUNT(*)::int AS c FROM check_ins WHERE booking_id = (SELECT id FROM bookings WHERE code = ?)").get(code)) as { c: number }).c;

beforeAll(async () => {
  await ensureBootstrapAdmin();
  adminId = (await listAdmins())[0].id;
  venueId = (await listVenues())[0].id;
  // A venue that lets customers cancel up to the start: the case where the refund and the use of the court can coincide.
  await updateVenue(venueId, { cancelCutoffHours: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("cancelling when nothing was given", () => {
  it("is free and refunded, as before", async () => {
    const court = await newCourt();
    const b = await soon(court.id);
    expect(await accessGivenTo(b.id)).toBe("none");
    expect(await cancelBooking(b.code, b.who)).toMatchObject({ ok: true });
    expect(await status(b.code)).toBe("cancelled");
    expect(await creditNotes(b.code)).toBe(1);
  });
});

describe("only a door code shown on the customer's phone", () => {
  it("cancels on the booking's own terms, the refund is not taken for having looked, and the code stops working for the cancelled booking", async () => {
    await updateVenue(venueId, { staffedFrom: 0, staffedTo: 0 });
    const court = await newCourt(true);
    const b = await soon(court.id);
    expect((await recordInduction({ venueId, phone: b.who, name: "Mei" })).ok).toBe(true);
    const shown = await accessCodeFor(b.code, b.who);
    expect(shown).toMatchObject({ ok: true, accessCode: "4821" });
    expect(await accessGivenTo(b.id)).toBe("code_viewed");

    const done = await cancelBooking(b.code, b.who);
    expect(done).toMatchObject({ ok: true });
    expect(await status(b.code)).toBe("cancelled");
    expect(await creditNotes(b.code)).toBe(1);
    // The code for the cancelled booking is no longer given.
    expect(await accessCodeFor(b.code, b.who)).toMatchObject({ ok: false, reason: "cancelled" });
    await updateVenue(venueId, { staffedFrom: null, staffedTo: null });
  });
});

describe("the customer's own check-in", () => {
  it("is not verified attendance, but the court is in use: online cancelling goes to staff and nothing is refunded or released", async () => {
    const court = await newCourt();
    const b = await soon(court.id);
    expect(await checkInByToken(b.checkInToken!)).toMatchObject({ ok: true });
    expect(await accessGivenTo(b.id)).toBe("self_checked_in");

    const refused = await cancelBooking(b.code, b.who);
    expect(refused).toMatchObject({ ok: false, code: "CANCEL_AFTER_ARRIVAL" });
    expect(await status(b.code)).toBe("confirmed");
    expect(await creditNotes(b.code)).toBe(0);
  });

  it("staff confirming it makes it verified attendance; cancelling stays with staff", async () => {
    const court = await newCourt();
    const b = await soon(court.id);
    await checkInByToken(b.checkInToken!);
    expect(await checkIn(b.code, { by: { adminId: null, name: "Desk" } })).toMatchObject({ ok: true });
    expect(await accessGivenTo(b.id)).toBe("verified");
    expect(await cancelBooking(b.code, b.who)).toMatchObject({ ok: false, code: "CANCEL_AFTER_ARRIVAL" });
  });
});

describe("a desk's check-in", () => {
  it("is verified attendance: the customer cannot cancel online", async () => {
    const court = await newCourt();
    const b = await soon(court.id);
    expect(await checkIn(b.code)).toMatchObject({ ok: true });
    expect(await accessGivenTo(b.id)).toBe("verified");
    expect(await cancelBooking(b.code, b.who)).toMatchObject({ ok: false, code: "CANCEL_AFTER_ARRIVAL" });
    expect(await status(b.code)).toBe("confirmed");
  });

  it("staff may still cancel it and refund it (a genuine inability, a venue fault): the explicit exception, with what was given on the record", async () => {
    const court = await newCourt();
    const b = await soon(court.id);
    await checkIn(b.code);
    const seen = await previewStaffCancel(b.code, "manager");
    if (!seen.ok) throw new Error(seen.error);
    expect(seen.preview).toMatchObject({ access: "verified", terms: "booked" });

    const cancelled = await staffCancel(b.code, { id: adminId, name: "Manager", role: "manager" }, { outcome: "back" });
    expect(cancelled.result.ok).toBe(true);
    expect(cancelled.settled).toMatchObject({ outcome: "back", refund: 20, access: "verified" });
    if (!cancelled.result.ok) return;
    await logCancelled({ id: adminId, name: "Manager" }, venueId, cancelled.result.booking, cancelled.settled);
    const log = await listActivity([venueId], { bookingCode: b.code });
    expect(log.find((a) => a.action === "booking.cancelled")?.detail).toContain("the customer had checked in");
    expect(await creditNotes(b.code)).toBe(1);
  });
});

describe("a weekly series", () => {
  it("a week the customer has arrived for stays, for staff; the others cancel as before", async () => {
    const day = date();
    vi.setSystemTime(new Date(`${day}T10:30:00+08:00`));
    const court = await newCourt();
    const who = phone();
    const made = await createBookingSeries({ courtId: court.id, date: day, hours: [HOUR], weeks: 2, name: "Liga", phone: who });
    if (!made.ok) throw new Error(made.error);
    vi.setSystemTime(new Date(`${day}T11:40:00+08:00`));
    await checkInByToken(made.bookings[0].checkInToken!);

    const plan = await seriesCancelPlan(made.seriesCode!, who);
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.weeks[0]).toMatchObject({ outcome: "stays", reason: "arrived" });
    expect(plan.weeks[1].outcome).toBe("free");
    const done = await cancelSeries(made.seriesCode!, who);
    if (!done.ok) throw new Error(done.error);
    expect(done.cancelled).toBe(1);
    expect(await status(made.bookings[0].code)).toBe("confirmed");
    expect(await status(made.bookings[1].code)).toBe("cancelled");
    // Asking for the week they arrived at by name does not cancel it either.
    expect(await cancelSeries(made.seriesCode!, who, { codes: [made.bookings[0].code] })).toMatchObject({ ok: false });
  });
});

describe("a check-in and a cancellation at the same moment", () => {
  it("is one or the other, never a cancelled and refunded booking that was also arrived at", async () => {
    const outcomes = new Set<string>();
    for (let round = 0; round < 8; round++) {
      const court = await newCourt();
      const b = await soon(court.id);
      const [inn, out] = await Promise.all([checkInByToken(b.checkInToken!), cancelBooking(b.code, b.who)]);
      const st = await status(b.code);
      const rows = await checkInRows(b.code);
      const notes = await creditNotes(b.code);
      // Either the arrival won (confirmed, a check-in, no refund), or the cancellation did (cancelled, refunded, no check-in).
      if (st === "confirmed") {
        expect(rows).toBe(1);
        expect(notes).toBe(0);
        expect(out).toMatchObject({ ok: false });
      } else {
        expect(rows).toBe(0);
        expect(notes).toBe(1);
        expect(inn).toMatchObject({ ok: false });
      }
      outcomes.add(st);
    }
    expect(outcomes.size).toBeGreaterThan(0);
  });
});
