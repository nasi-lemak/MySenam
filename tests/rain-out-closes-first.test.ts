import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { getDb } from "../src/lib/db";
import { rainOut } from "../src/lib/rain-outs";
import {
  adminCancelBooking,
  claimWaitlistOffer,
  createBooking,
  createClassSessions,
  createCourt,
  enrolInClass,
  findBookingByCode,
  getClass,
  getClassRoster,
  joinSlotWaitlist,
  listVenues,
  takeHire,
} from "../src/lib/store";
import { addDays, slotStartsAt, todayISO } from "../src/lib/time";

/**
 * A rain-out blocks the hours first, so nothing in them is offered, claimed or booked afterwards; what is booked is called
 * off in a transaction that also blocks the time it frees; what has finished is left alone; what cannot be called off
 * (kit still out) is named.
 */

const ZONE = "Asia/Kuala_Lumpur";
let venueId: number;
let seq = 0;
afterEach(() => vi.useRealTimers());

beforeAll(async () => {
  venueId = (await listVenues())[0].id;
});

async function outdoor(capacity = 1) {
  seq++;
  const o = await createCourt({ venueId, name: `RO Outdoor ${seq}`, sport: "tennis", offPeakRate: 30, peakRate: 40, capacity });
  if (!o.ok) throw new Error("court");
  return o.court;
}
const phone = () => `01${String(50_000_000 + ++seq)}`;

describe("rain-out and the waiting list", () => {
  it("offers the freed hour to nobody: the waiter keeps waiting and cannot claim a rained-off hour", async () => {
    const court = await outdoor();
    const date = addDays(todayISO(), 2);
    const held = await createBooking({ courtId: court.id, date, hours: [16], name: "Holder", phone: phone() });
    if (!held.ok) throw new Error("booking");
    const waiterPhone = phone();
    expect((await joinSlotWaitlist({ courtId: court.id, date, startHour: 16, endHour: 17, name: "Waiter", phone: waiterPhone })).ok).toBe(true);

    const done = await rainOut({ venueId, courtIds: [court.id], date, fromHour: 14, untilHour: 18, reason: "Thunderstorm" });
    expect(done.ok).toBe(true);
    const w = (await getDb().prepare("SELECT status, offer_token FROM waitlist WHERE phone = ?").get(waiterPhone)) as { status: string; offer_token: string | null };
    expect(w.status).toBe("waiting");
    expect(w.offer_token).toBeNull();
    // The hour is blocked: nobody can book it.
    expect((await createBooking({ courtId: court.id, date, hours: [16], name: "Late", phone: phone() })).ok).toBe(false);
  });

  it("lets go a live offer in the hours, which can then not be claimed", async () => {
    const court = await outdoor();
    const date = addDays(todayISO(), 3);
    const held = await createBooking({ courtId: court.id, date, hours: [16], name: "Holder", phone: phone() });
    if (!held.ok) throw new Error("booking");
    const waiterPhone = phone();
    await joinSlotWaitlist({ courtId: court.id, date, startHour: 16, endHour: 17, name: "Waiter", phone: waiterPhone });
    expect((await adminCancelBooking(held.booking.code)).ok).toBe(true);
    const offered = (await getDb().prepare("SELECT status, offer_token FROM waitlist WHERE phone = ?").get(waiterPhone)) as { status: string; offer_token: string };
    expect(offered.status).toBe("offered");

    const done = await rainOut({ venueId, courtIds: [court.id], date, fromHour: 14, untilHour: 18, reason: "Thunderstorm" });
    expect(done.ok).toBe(true);
    const claimed = await claimWaitlistOffer(offered.offer_token);
    expect(claimed.ok).toBe(false);
    expect(await getDb().prepare("SELECT 1 FROM bookings WHERE court_id = ? AND date = ? AND status = 'confirmed'").get(court.id, date)).toBeUndefined();
  });
});

describe("rain-out and what has been played", () => {
  async function heldMorningClass() {
    seq++;
    const studio = await createCourt({ venueId, name: `RO Studio ${seq}`, sport: "gym", offPeakRate: 5, peakRate: 8, capacity: 10 });
    if (!studio.ok) throw new Error("studio");
    const date = addDays(todayISO(), 2);
    const made = await createClassSessions({ courtId: studio.court.id, name: "RO morning class", instructor: "Aina", date, startHour: 9, endHour: 10, capacity: 5, price: 20 });
    if (!made.ok) throw new Error(made.error);
    const e = await enrolInClass({ classId: made.classes[0].id, name: "Attendee", phone: phone() });
    if (!e.ok) throw new Error(e.error);
    return { court: studio.court, cl: made.classes[0], e: e.booking, date };
  }

  it("a rain-out declared in the afternoon leaves this morning's finished class alone", async () => {
    const { court, cl, e, date } = await heldMorningClass();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(slotStartsAt(date, 15, ZONE));
    const r = await rainOut({ venueId, courtIds: [court.id], date, fromMin: 8 * 60, untilMin: 21 * 60, reason: "storm" });
    expect(r.ok).toBe(true);
    expect((await getClass(cl.id))!.status).toBe("scheduled");
    expect((await getClassRoster(cl.id)).find((b) => b.id === e.id)!.status).toBe("confirmed");
    // And the preview does not count it.
    const preview = await rainOut({ venueId, courtIds: [court.id], date, fromMin: 8 * 60, untilMin: 21 * 60, preview: true });
    expect(preview).toMatchObject({ ok: true, classes: 0 });
  });

  it("calls off a class that is under way, and a booking under way", async () => {
    const { court, cl, e, date } = await heldMorningClass();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(slotStartsAt(date, 9.5, ZONE));
    const r = await rainOut({ venueId, courtIds: [court.id], date, fromMin: 8 * 60, untilMin: 21 * 60, reason: "storm" });
    expect(r).toMatchObject({ ok: true, classes: 1 });
    expect((await getClass(cl.id))!.status).toBe("cancelled");
    expect((await getClassRoster(cl.id)).find((b) => b.id === e.id)!.status).toBe("cancelled");
  });
});

describe("rain-out over kit still out", () => {
  it("names the booking for the desk instead of skipping it silently, and calls off the rest", async () => {
    seq++;
    const fleet = await createCourt({ venueId, name: `RO Fleet ${seq}`, sport: "kayak", offPeakRate: 15, peakRate: 20, capacity: 4, deposit: 50 });
    if (!fleet.ok) throw new Error(fleet.error);
    const date = addDays(todayISO(), 1);
    const out = await createBooking({ courtId: fleet.court.id, date, hours: [12], name: "Paddler", phone: phone() });
    const later = await createBooking({ courtId: fleet.court.id, date, hours: [14], name: "Later", phone: phone() });
    if (!out.ok || !later.ok) throw new Error("booking");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(slotStartsAt(date, 12.25, ZONE));
    expect((await takeHire(out.booking.code, undefined, "cash")).ok).toBe(true);
    vi.setSystemTime(slotStartsAt(date, 12.5, ZONE));
    const r = await rainOut({ venueId, courtIds: [fleet.court.id], date, fromMin: 12 * 60, untilMin: 17 * 60, reason: "Thunderstorm" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.left).toEqual([expect.objectContaining({ ref: out.booking.code, name: "Paddler", why: expect.stringMatching(/kit/i) })]);
    expect((await findBookingByCode(out.booking.code))!.status).toBe("confirmed");
    expect((await findBookingByCode(later.booking.code))!.status).toBe("cancelled");
  });
});
