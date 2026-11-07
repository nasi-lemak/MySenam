import fs from "fs";
import path from "path";
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { GET as lookup } from "../src/app/api/bookings/route";
import { bookingTerms } from "../src/lib/booking-terms";
import { bookingCancelTerms, readStoredTerms, setCancelPolicy } from "../src/lib/cancel-policy";
import { getDb } from "../src/lib/db";
import { setSportRules } from "../src/lib/sport-rules";
import {
  cancelBooking,
  cancelSeries,
  createBooking,
  createBookingSeries,
  createCourt,
  createVenue,
  listUserBookings,
  rescheduleBooking,
  seriesCancelPlan,
  setPaymentStatus,
  updateVenue,
} from "../src/lib/store";
import { previewStaffCancel, staffCancel } from "../src/lib/counter-refunds";
import { addDays, todayISO } from "../src/lib/time";

/**
 * ADR 0069 / DEC-09: the cancellation terms a customer was shown when they booked are the terms that govern that booking. A manager
 * editing the cutoff, the late-cancel share or the give-back changes what the next booking is sold on and nothing already sold. A
 * booking from before the snapshot existed (NULL) is read on the venue's current terms, as it always was.
 *
 * Dates are days ahead and the cutoffs are chosen so that the booking is clearly inside or outside them whatever the time of day.
 */

let venueId: number;
let n = 0;
const phone = () => `0178811${String(++n).padStart(4, "0")}`;
const FAR = 72; // hours: a booking made for tomorrow or the day after is always inside a cutoff this long
const NEAR = 2;

async function newCourt() {
  const made = await createCourt({ venueId, name: `Snapshot Court ${++n}`, sport: "badminton", offPeakRate: 20, peakRate: 20, capacity: 1 });
  if (!made.ok) throw new Error(made.error);
  return made.court;
}

async function book(courtId: number, who = phone(), daysAhead = 1, hour = 18) {
  const made = await createBooking({ courtId, date: addDays(todayISO(), daysAhead), hours: [hour], name: "Mei", phone: who });
  if (!made.ok) throw new Error(made.error);
  return { ...made.booking, who };
}

const snapshotOf = async (code: string) =>
  ((await getDb().prepare("SELECT cancel_terms FROM bookings WHERE code = ?").get(code)) as { cancel_terms: Record<string, unknown> | null }).cancel_terms;

const rowOf = async (code: string) =>
  (await getDb().prepare("SELECT status, late_cancelled, late_kept_percent FROM bookings WHERE code = ?").get(code)) as {
    status: string;
    late_cancelled: number;
    late_kept_percent: number | null;
  };

async function terms(t: { cutoff: number; keep: number | null; giveBack?: boolean }) {
  await updateVenue(venueId, { cancelCutoffHours: t.cutoff });
  const done = await setCancelPolicy(venueId, { lateKeep: t.keep, giveBack: t.giveBack ?? false });
  if (!done.ok) throw new Error(done.error);
}

beforeAll(async () => {
  const made = await createVenue({ name: "Snapshot Hall", area: "Ipoh", address: "x", phone: "0355554444", openHour: 8, closeHour: 23 });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
});

describe("the terms shown at booking are kept on the booking", () => {
  it("writes the cutoff, the late share, the give-back and the digest of what was shown, once, at booking", async () => {
    await terms({ cutoff: NEAR, keep: 50 });
    const court = await newCourt();
    const b = await book(court.id);
    const kept = await snapshotOf(b.code);
    expect(kept).toMatchObject({ v: 1, cutoffHours: NEAR, lateKeep: 50, giveBack: false, onlineRefunds: "staff", refundWithinDays: 7 });
    expect(Number.isNaN(Date.parse(String(kept!.takenAt)))).toBe(false);
    // The digest is the one the terms endpoint shows a customer, so a dispute can match the two.
    expect(kept!.version).toBe((await bookingTerms(venueId, "badminton"))!.version);
    expect(readStoredTerms(kept)).not.toBeNull();
    expect(await bookingCancelTerms(b.id)).toMatchObject({ source: "booked", cutoffHours: NEAR, lateKeep: 50, version: kept!.version });
  });

  it("takes the sport's own cutoff and share where the venue gave the sport rules of its own", async () => {
    await terms({ cutoff: NEAR, keep: 50 });
    const own = await setSportRules(venueId, "badminton", { cutoffHours: 12, lateKeep: 20 });
    if (!own.ok) throw new Error(own.error);
    const court = await newCourt();
    const b = await book(court.id);
    expect(await snapshotOf(b.code)).toMatchObject({ cutoffHours: 12, lateKeep: 20 });
    await setSportRules(venueId, "badminton", { cutoffHours: null, lateKeep: null });
  });
});

describe("a policy edit after booking changes nothing already sold", () => {
  it("raising the cutoff from 2 hours to 72 does not make an existing booking uncancellable; a new booking is on the new cutoff", async () => {
    await terms({ cutoff: NEAR, keep: null });
    const court = await newCourt();
    const before = await book(court.id, phone(), 1);
    await updateVenue(venueId, { cancelCutoffHours: FAR });
    const after = await book(court.id, phone(), 2);

    // Before the edit it was free to cancel; after it, still: what the customer was shown.
    const done = await cancelBooking(before.code, before.who);
    expect(done).toMatchObject({ ok: true });
    expect(await rowOf(before.code)).toMatchObject({ status: "cancelled", late_cancelled: 0 });
    // The booking made after the edit is on the longer cutoff, which keeps no late cancelling.
    const refused = await cancelBooking(after.code, after.who);
    expect(refused).toMatchObject({ ok: false });
    expect((await rowOf(after.code)).status).toBe("confirmed");
  });

  it("changing 'keep 50%' to 'keep 100%' leaves an existing booking on 50%; a new one is on 100%", async () => {
    await terms({ cutoff: FAR, keep: 50 });
    const court = await newCourt();
    const old = await book(court.id, phone(), 1);
    await setPaymentStatus(old.code, true);
    await setCancelPolicy(venueId, { lateKeep: 100 });
    const fresh = await book(court.id, phone(), 2);
    await setPaymentStatus(fresh.code, true);

    const a = await cancelBooking(old.code, old.who);
    expect(a).toMatchObject({ ok: true, kept: 10 });
    expect(await rowOf(old.code)).toMatchObject({ late_cancelled: 1, late_kept_percent: 50 });
    const b = await cancelBooking(fresh.code, fresh.who);
    expect(b).toMatchObject({ ok: true, kept: 20 });
    expect(await rowOf(fresh.code)).toMatchObject({ late_kept_percent: 100 });
  });

  it("holds both ways: a venue that later allows late cancelling does not change a booking sold without it", async () => {
    await terms({ cutoff: FAR, keep: null });
    const court = await newCourt();
    const b = await book(court.id);
    await setCancelPolicy(venueId, { lateKeep: 10 });
    expect(await cancelBooking(b.code, b.who)).toMatchObject({ ok: false });
    expect((await rowOf(b.code)).status).toBe("confirmed");
  });

  it("turning the give-back off after booking leaves a booking sold with it able to give the court back", async () => {
    await terms({ cutoff: FAR, keep: null, giveBack: true });
    const court = await newCourt();
    const b = await book(court.id);
    await setPaymentStatus(b.code, true);
    await setCancelPolicy(venueId, { lateKeep: null, giveBack: false });
    const done = await cancelBooking(b.code, b.who);
    expect(done).toMatchObject({ ok: true, kept: 20 });
    expect(await rowOf(b.code)).toMatchObject({ status: "cancelled", late_cancelled: 1, late_kept_percent: 100 });
  });

  it("a customer's own views show the terms the booking was sold on: the lookup, and the account's list", async () => {
    await terms({ cutoff: NEAR, keep: 40 });
    const court = await newCourt();
    const b = await book(court.id);
    await terms({ cutoff: FAR, keep: 90 });

    const res = await lookup(new NextRequest(`http://localhost/api/bookings?code=${b.code}&phone=${b.who}`));
    expect(res.status).toBe(200);
    expect((await res.json()).venue).toMatchObject({ cancelCutoffHours: NEAR, lateCancelKeep: 40 });

    // The account's list: a booking carrying a user id is read through the same columns.
    const user = (await getDb().prepare("INSERT INTO users (email, phone, password_hash, name) VALUES (?, '0100000', 'x', 'Mei') RETURNING id").get(`snap${n}@example.com`)) as { id: number };
    await getDb().prepare("UPDATE bookings SET user_id = ? WHERE code = ?").run(user.id, b.code);
    const listed = (await listUserBookings(user.id)).find((x) => x.code === b.code)!;
    expect(listed).toMatchObject({ venueCancelCutoffHours: NEAR, venueLateCancelKeep: 40, venueLateGiveBack: false });
  });
});

describe("a booking made before the terms were kept", () => {
  it("is read on the venue's current terms, as it always was (nothing is invented for it)", async () => {
    await terms({ cutoff: NEAR, keep: 50 });
    const court = await newCourt();
    const legacy = await book(court.id, phone(), 1);
    // The state before the migration: no snapshot on the row.
    await getDb().prepare("UPDATE bookings SET cancel_terms = NULL WHERE code = ?").run(legacy.code);
    expect(await bookingCancelTerms(legacy.id)).toMatchObject({ source: "current", cutoffHours: NEAR, lateKeep: 50, version: null });
    await terms({ cutoff: FAR, keep: 100 });
    expect(await bookingCancelTerms(legacy.id)).toMatchObject({ source: "current", cutoffHours: FAR, lateKeep: 100 });
    await setPaymentStatus(legacy.code, true);
    expect(await cancelBooking(legacy.code, legacy.who)).toMatchObject({ ok: true, kept: 20 });
    expect(await rowOf(legacy.code)).toMatchObject({ late_kept_percent: 100 });
  });

  it("a malformed snapshot is no snapshot: the current terms apply and nothing throws", async () => {
    await terms({ cutoff: NEAR, keep: 50 });
    const court = await newCourt();
    const b = await book(court.id);
    await getDb().prepare("UPDATE bookings SET cancel_terms = '{}'::jsonb WHERE code = ?").run(b.code);
    expect(await bookingCancelTerms(b.id)).toMatchObject({ source: "current", cutoffHours: NEAR });
    await expect(getDb().prepare("UPDATE bookings SET cancel_terms = '[]'::jsonb WHERE code = ?").run(b.code)).rejects.toThrow();
  });
});

describe("migration 0330", () => {
  it("is safe to run again over bookings of both kinds: nothing is rewritten and nothing is backfilled", async () => {
    await terms({ cutoff: NEAR, keep: 50 });
    const court = await newCourt();
    const kept = await book(court.id, phone(), 1, 18);
    const legacy = await book(court.id, phone(), 2, 18);
    await getDb().prepare("UPDATE bookings SET cancel_terms = NULL WHERE code = ?").run(legacy.code);
    const before = await snapshotOf(kept.code);

    const sql = fs.readFileSync(path.join(__dirname, "..", "db", "migrations", "0330_booking_cancellation_terms_snapshot.sql"), "utf8");
    await getDb().exec(sql);
    await getDb().exec(sql);

    expect(await snapshotOf(kept.code)).toEqual(before);
    // A booking from before the column stays without terms: the venue's current ones apply, none are invented.
    expect(await snapshotOf(legacy.code)).toBeNull();
    const check = (await getDb()
      .prepare("SELECT convalidated FROM pg_constraint WHERE conname = 'bookings_cancel_terms_object_check'")
      .get()) as { convalidated: boolean };
    expect(check.convalidated).toBe(true);
  });
});

describe("a weekly series carries the terms current when it was booked", () => {
  it("every week has the same snapshot, a later edit changes none of them, and a series booked after the edit is on the new terms", async () => {
    await terms({ cutoff: FAR, keep: 50 });
    const court = await newCourt();
    const who = phone();
    const made = await createBookingSeries({ courtId: court.id, date: addDays(todayISO(), 1), hours: [19], weeks: 3, name: "Liga", phone: who });
    if (!made.ok) throw new Error(made.error);
    for (const bk of made.bookings) await setPaymentStatus(bk.code, true);
    const kept = await Promise.all(made.bookings.map((bk) => snapshotOf(bk.code)));
    expect(new Set(kept.map((k) => JSON.stringify(k))).size).toBe(1);
    expect(kept[0]).toMatchObject({ lateKeep: 50, cutoffHours: FAR });

    await terms({ cutoff: FAR, keep: 100 });
    const later = await createBookingSeries({ courtId: court.id, date: addDays(todayISO(), 2), hours: [20], weeks: 2, name: "Liga 2", phone: phone() });
    if (!later.ok) throw new Error(later.error);
    expect(await snapshotOf(later.bookings[0].code)).toMatchObject({ lateKeep: 100 });

    const plan = await seriesCancelPlan(made.seriesCode!, who);
    if (!plan.ok) throw new Error(plan.error);
    // Tomorrow's week is inside the cutoff it was sold on, and goes on its 50%, not the 100% the venue changed to; the later weeks are free.
    expect(plan.weeks.map((w) => w.outcome)).toEqual(["late", "free", "free"]);
    expect(plan.weeks[0]).toMatchObject({ keptPercent: 50, kept: 10, refund: 10 });
    const done = await cancelSeries(made.seriesCode!, who, { codes: made.bookings.map((x) => x.code), acceptLate: [made.bookings[0].code] });
    if (!done.ok) throw new Error(done.error);
    expect(done.cancelled).toBe(3);
    expect(await rowOf(made.bookings[0].code)).toMatchObject({ late_cancelled: 1, late_kept_percent: 50 });
    expect(await rowOf(made.bookings[1].code)).toMatchObject({ late_cancelled: 0 });
  });
});

describe("a reschedule keeps the terms the booking was sold on", () => {
  it("moving a booking does not take a new snapshot: the original cutoff and share still apply", async () => {
    await terms({ cutoff: NEAR, keep: 30 });
    const court = await newCourt();
    const b = await book(court.id, phone(), 1, 18);
    const first = await snapshotOf(b.code);
    await terms({ cutoff: FAR, keep: 90 });
    const moved = await rescheduleBooking(b.code, { date: addDays(todayISO(), 2), startHour: 19 }, "customer");
    expect(moved).toMatchObject({ ok: true });
    expect(await snapshotOf(b.code)).toEqual(first);
    // Moved to a day that is inside the current (long) cutoff, it is still free to cancel on the cutoff it was sold on.
    expect(await cancelBooking(b.code, b.who)).toMatchObject({ ok: true });
    expect(await rowOf(b.code)).toMatchObject({ status: "cancelled", late_cancelled: 0 });
  });
});

describe("staff overrides stay explicit", () => {
  it("the counter's late share is the booking's own; 'keep' offers it, and cancelling in full is the explicit, logged exception", async () => {
    await terms({ cutoff: FAR, keep: 25 });
    const court = await newCourt();
    const b = await book(court.id);
    await setPaymentStatus(b.code, true);
    await setCancelPolicy(venueId, { lateKeep: 90 });

    const seen = await previewStaffCancel(b.code, "manager");
    if (!seen.ok) throw new Error(seen.error);
    expect(seen.preview).toMatchObject({ late: true, cutoffHours: FAR, keptPercent: 25, terms: "booked", access: "none" });
    expect(seen.preview.termsVersion).toBe((await snapshotOf(b.code))!.version);
    expect(seen.preview.options.map((o) => o.outcome)).toEqual(["back", "keep"]);
    expect(seen.preview.options.find((o) => o.outcome === "keep")).toMatchObject({ kept: 5, refund: 15 });

    // The exception: all of it back although the booking is past its cutoff. Allowed (staff may waive), and it says so.
    const done = await staffCancel(b.code, { id: null, name: "Manager", role: "manager" }, { outcome: "back" });
    expect(done.result.ok).toBe(true);
    expect(done.settled).toMatchObject({ outcome: "back", refund: 20, pastTerms: true });
  });
});

describe("a policy edit made while a booking is being made", () => {
  it("the booking carries the old terms or the new ones, never a mix of them", async () => {
    const court = await newCourt();
    const states = [
      { keep: 50, refunds: "credit" as const },
      { keep: null, refunds: "staff" as const },
    ];
    await setCancelPolicy(venueId, { lateKeep: states[1].keep, onlineRefunds: states[1].refunds });
    const seen = new Set<string>();
    for (let round = 0; round < 6; round++) {
      const next = states[round % 2];
      const who = phone();
      const [, made] = await Promise.all([
        setCancelPolicy(venueId, { lateKeep: next.keep, onlineRefunds: next.refunds }),
        createBooking({ courtId: court.id, date: addDays(todayISO(), 5 + round), hours: [18], name: "Race", phone: who }),
      ]);
      if (!made.ok) throw new Error(made.error);
      const kept = (await snapshotOf(made.booking.code))!;
      seen.add(`${kept.lateKeep}/${kept.onlineRefunds}`);
      // One state or the other, in full.
      expect(["50/credit", "null/staff"]).toContain(`${kept.lateKeep}/${kept.onlineRefunds}`);
    }
    expect(seen.size).toBeGreaterThan(0);
  });
});
