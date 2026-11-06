import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

// A customer books while the venue is closing the day: the route calls tickOutbox after cancelling.
let onTick: (() => Promise<void>) | null = null;
vi.mock("../src/lib/notify", async (original) => {
  const real = await original<typeof import("../src/lib/notify")>();
  return {
    ...real,
    tickOutbox: async () => {
      const hook = onTick;
      onTick = null;
      if (hook) await hook();
      return real.tickOutbox();
    },
  };
});

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { createOutage, endOutage } from "../src/lib/outages";
import { cancelClassAndTell } from "../src/lib/notify";
import {
  claimWaitlistOffer,
  closeVenueDay,
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
 * Closing a day and taking a court out of service: the closure is the decision, taken before anything is cancelled
 * (nothing is offered, claimed or booked on that time afterwards), and what has been played is left alone.
 */

const ZONE = "Asia/Kuala_Lumpur";
let venueId: number;
let ownerId: number;
let cookie: string;
let seq = 0;
afterEach(() => vi.useRealTimers());

beforeAll(async () => {
  await ensureBootstrapAdmin();
  ownerId = (await listAdmins())[0].id;
  venueId = (await listVenues())[0].id;
  const desk = await createAdmin({ name: "Desk", email: "desk@closures-first.my", password: "desk-password", venueId });
  if (!desk.ok) throw new Error("desk");
  cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
});

async function court(name = "Court") {
  seq++;
  const c = await createCourt({ venueId, name: `CF ${name} ${seq}`, sport: "badminton", offPeakRate: 15, peakRate: 25, capacity: 1 });
  if (!c.ok) throw new Error("court");
  return c.court;
}

async function studio() {
  seq++;
  const c = await createCourt({ venueId, name: `CF Studio ${seq}`, sport: "gym", offPeakRate: 5, peakRate: 8, capacity: 20 });
  if (!c.ok) throw new Error("studio");
  return c.court;
}

const phone = () => `01${String(40_000_000 + ++seq)}`;
const status = async (id: number) => ((await getDb().prepare("SELECT status FROM bookings WHERE id = ?").get(id)) as { status: string }).status;

async function closeDay(body: Record<string, unknown>) {
  const { POST } = await import("../src/app/api/admin/venues/[id]/closures/route");
  const res = await POST(
    new NextRequest(`http://localhost/api/admin/venues/${venueId}/closures`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-forwarded-for": "10.7.7.7" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: String(venueId) }) }
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("closing a day", () => {
  it("offers the freed slot to nobody: the waiter for the closed day stays waiting, and no offer can be claimed", async () => {
    const c = await court();
    const date = addDays(todayISO(), 6);
    const held = await createBooking({ courtId: c.id, date, hours: [15], name: "Holder", phone: phone() });
    if (!held.ok) throw new Error("booking");
    const waiterPhone = phone();
    expect((await joinSlotWaitlist({ courtId: c.id, date, startHour: 15, endHour: 16, name: "Waiter", phone: waiterPhone })).ok).toBe(true);
    const done = await closeDay({ date, reason: "Flood", cancelAffected: true });
    expect(done.status).toBe(201);
    expect(await status(held.booking.id)).toBe("cancelled");
    const w = (await getDb().prepare("SELECT status, offer_token FROM waitlist WHERE phone = ?").get(waiterPhone)) as { status: string; offer_token: string | null };
    expect(w.status).toBe("waiting");
    expect(w.offer_token).toBeNull();
    expect(await getDb().prepare("SELECT 1 FROM claims WHERE court_id = ? AND kind = 'offer' AND active", ).get(c.id)).toBeUndefined();
  });

  it("lets go a live offer for the day it closes: the claim is released and cannot be taken up", async () => {
    const c = await court();
    const date = addDays(todayISO(), 7);
    const held = await createBooking({ courtId: c.id, date, hours: [15], name: "Holder", phone: phone() });
    if (!held.ok) throw new Error("booking");
    const waiterPhone = phone();
    await joinSlotWaitlist({ courtId: c.id, date, startHour: 15, endHour: 16, name: "Waiter", phone: waiterPhone });
    const { adminCancelBooking } = await import("../src/lib/store");
    expect((await adminCancelBooking(held.booking.code)).ok).toBe(true);
    const offered = (await getDb().prepare("SELECT status, offer_token FROM waitlist WHERE phone = ?").get(waiterPhone)) as { status: string; offer_token: string };
    expect(offered.status).toBe("offered");

    expect((await closeVenueDay(venueId, date, "Holiday")).ok).toBe(true);
    const after = (await getDb().prepare("SELECT status, offer_token FROM waitlist WHERE phone = ?").get(waiterPhone)) as { status: string; offer_token: string | null };
    expect(after.status).toBe("waiting");
    const claimed = await claimWaitlistOffer(offered.offer_token);
    expect(claimed.ok).toBe(false);
  });

  it("refuses a past date before cancelling or refunding anything", async () => {
    const c = await court();
    const date = addDays(todayISO(), 3);
    const made = await createBooking({ courtId: c.id, date, hours: [19], name: "Evening", phone: phone() });
    if (!made.ok) throw new Error("booking");
    // The day after: the date is past.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(slotStartsAt(addDays(date, 1), 10, ZONE));
    const done = await closeDay({ date, reason: "Too late", cancelAffected: true });
    expect(done.status).toBe(400);
    expect(await status(made.booking.id)).toBe("confirmed");
    expect(await getDb().prepare("SELECT 1 FROM venue_closures WHERE venue_id = ? AND date = ?").get(venueId, date)).toBeUndefined();
  });

  it("leaves a class that has ended alone and calls off one that is still to come (or under way)", async () => {
    const gym = await studio();
    const date = addDays(todayISO(), 4);
    const morning = await createClassSessions({ courtId: gym.id, name: "CF Morning", instructor: "Lee", date, startHour: 9, endHour: 10, capacity: 5, price: 30 });
    const evening = await createClassSessions({ courtId: gym.id, name: "CF Evening", instructor: "Lee", date, startHour: 18, endHour: 19, capacity: 5, price: 30 });
    if (!morning.ok || !evening.ok) throw new Error("class");
    const a = await enrolInClass({ classId: morning.classes[0].id, name: "Mei", phone: phone() });
    const b = await enrolInClass({ classId: evening.classes[0].id, name: "Ravi", phone: phone() });
    if (!a.ok || !b.ok) throw new Error("enrol");
    await getDb().prepare("UPDATE bookings SET payment_status = 'paid', paid_via = 'card', paid_at = datetime('now') WHERE id = ?").run(a.booking.id);

    // 15:00 on the day: a storm, the venue shuts for the rest of the day.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(slotStartsAt(date, 15, ZONE));
    const done = await closeDay({ date, reason: "Storm", cancelAffected: true });
    expect(done.status).toBe(201);
    expect(await status(a.booking.id)).toBe("confirmed");
    expect((await getClass(morning.classes[0].id))!.status).toBe("scheduled");
    expect(await status(b.booking.id)).toBe("cancelled");
    expect((await getClass(evening.classes[0].id))!.status).toBe("cancelled");
    expect(done.body.cancelled).toBe(1);
  });

  it("leaves a booking that has been played alone, and does not count it when asking whether to cancel", async () => {
    const c = await court();
    const date = addDays(todayISO(), 5);
    const morning = await createBooking({ courtId: c.id, date, hours: [9], name: "Morning", phone: phone() });
    if (!morning.ok) throw new Error("booking");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(slotStartsAt(date, 15, ZONE));
    const done = await closeDay({ date, reason: "Power cut", cancelAffected: true });
    expect(done.status).toBe(201);
    expect(await status(morning.booking.id)).toBe("confirmed");
  });

  it("names a booking with kit still out for the desk, and closes the day over the rest", async () => {
    seq++;
    const fleet = await createCourt({ venueId, name: `CF Fleet ${seq}`, sport: "kayak", offPeakRate: 15, peakRate: 20, capacity: 4, deposit: 50 });
    if (!fleet.ok) throw new Error(fleet.error);
    // Tomorrow: the desk's session (real time) must still be valid at the faked moment.
    const date = addDays(todayISO(), 1);
    const out = await createBooking({ courtId: fleet.court.id, date, hours: [12], name: "Paddler", phone: phone() });
    const other = await court();
    const plain = await createBooking({ courtId: other.id, date, hours: [13], name: "Plain", phone: phone() });
    if (!out.ok || !plain.ok) throw new Error("booking");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(slotStartsAt(date, 12.25, ZONE));
    expect((await takeHire(out.booking.code)).ok).toBe(true);
    vi.setSystemTime(slotStartsAt(date, 12.5, ZONE));

    const done = await closeDay({ date, reason: "Storm", cancelAffected: true });
    expect(done.status).toBe(201);
    const left = done.body.left as { ref: string; why: string }[];
    expect(left.map((l) => l.ref)).toContain(out.booking.code);
    expect(left.find((l) => l.ref === out.booking.code)!.why).toMatch(/kit/i);
    expect((await findBookingByCode(out.booking.code))!.status).toBe("confirmed");
    expect(await status(plain.booking.id)).toBe("cancelled");
    expect(await getDb().prepare("SELECT 1 FROM venue_closures WHERE venue_id = ? AND date = ?").get(venueId, date)).toBeDefined();
  });

  it("refuses a booking attempted while the day is being closed, and nothing stands on the closed day", async () => {
    const a = await court("A");
    const b = await court("B");
    const date = addDays(todayISO(), 11);
    const first = await createBooking({ courtId: a.id, date, hours: [15], name: "First", phone: phone() });
    if (!first.ok) throw new Error("booking");
    let attempt: Awaited<ReturnType<typeof createBooking>> | null = null;
    onTick = async () => {
      attempt = await createBooking({ courtId: b.id, date, hours: [16], name: "Late arrival", phone: phone() });
    };
    const done = await closeDay({ date, reason: "Flood", cancelAffected: true });
    expect(done.status).toBe(201);
    expect(attempt).not.toBeNull();
    expect(attempt!.ok).toBe(false);
    const standing = (await getDb()
      .prepare("SELECT COUNT(*)::int AS n FROM bookings b JOIN courts c ON c.id = b.court_id WHERE c.venue_id = ? AND b.date = ? AND b.status = 'confirmed'")
      .get(venueId, date)) as { n: number };
    expect(standing.n).toBe(0);
  });

  it("without cancelAffected, is refused inside the closing transaction if a booking is there (nothing is closed)", async () => {
    const c = await court();
    const date = addDays(todayISO(), 12);
    const made = await createBooking({ courtId: c.id, date, hours: [10], name: "Standing", phone: phone() });
    if (!made.ok) throw new Error("booking");
    const refused = await closeVenueDay(venueId, date, "Nope", { refuseIfBooked: true });
    expect(refused.ok).toBe(false);
    expect(await getDb().prepare("SELECT 1 FROM venue_closures WHERE venue_id = ? AND date = ?").get(venueId, date)).toBeUndefined();
    expect(await status(made.booking.id)).toBe("confirmed");
  });
});

describe("calling a class off by hand", () => {
  it("is refused for a class that was held this morning, and refunds nobody", async () => {
    const gym = await studio();
    const date = addDays(todayISO(), 2);
    const made = await createClassSessions({ courtId: gym.id, name: "CF Held", instructor: "Lee", date, startHour: 9, endHour: 10, capacity: 5, price: 30 });
    if (!made.ok) throw new Error("class");
    const e = await enrolInClass({ classId: made.classes[0].id, name: "Mei", phone: phone() });
    if (!e.ok) throw new Error("enrol");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(slotStartsAt(date, 15, ZONE));
    const r = await cancelClassAndTell(made.classes[0].id);
    expect(r.ok).toBe(false);
    expect((await getClassRoster(made.classes[0].id)).find((b) => b.id === e.booking.id)!.status).toBe("confirmed");
  });

  it("may still call off a class that is under way", async () => {
    const gym = await studio();
    const date = addDays(todayISO(), 2);
    const made = await createClassSessions({ courtId: gym.id, name: "CF Under way", instructor: "Lee", date, startHour: 9, endHour: 11, capacity: 5, price: 30 });
    if (!made.ok) throw new Error("class");
    const e = await enrolInClass({ classId: made.classes[0].id, name: "Mei", phone: phone() });
    if (!e.ok) throw new Error("enrol");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(slotStartsAt(date, 10, ZONE));
    const r = await cancelClassAndTell(made.classes[0].id);
    expect(r.ok).toBe(true);
    expect(await status(e.booking.id)).toBe("cancelled");
  });
});

describe("taking a court out of service", () => {
  it("goes ahead over a booking somebody waits for: the waiter is offered nothing and the court is out", async () => {
    const c = await court();
    const date = addDays(todayISO(), 8);
    const held = await createBooking({ courtId: c.id, date, hours: [16], name: "Holder", phone: phone() });
    if (!held.ok) throw new Error("booking");
    const waiterPhone = phone();
    expect((await joinSlotWaitlist({ courtId: c.id, date, startHour: 16, endHour: 17, name: "Waiter", phone: waiterPhone })).ok).toBe(true);
    const made = await createOutage({ courtId: c.id, startsOn: date, endsOn: date, reason: "Resurfacing", adminId: ownerId, cancelAffected: true });
    expect(made.ok).toBe(true);
    expect(await status(held.booking.id)).toBe("cancelled");
    const w = (await getDb().prepare("SELECT status FROM waitlist WHERE phone = ?").get(waiterPhone)) as { status: string };
    expect(w.status).toBe("waiting");
    // Out of service: nothing can be booked in it.
    expect((await createBooking({ courtId: c.id, date, hours: [16], name: "Late", phone: phone() })).ok).toBe(false);
  });

  it("lets go a live offer in the days it is out, so the outage's claim is not in its way", async () => {
    const c = await court();
    const date = addDays(todayISO(), 13);
    const held = await createBooking({ courtId: c.id, date, hours: [16], name: "Holder", phone: phone() });
    if (!held.ok) throw new Error("booking");
    const waiterPhone = phone();
    await joinSlotWaitlist({ courtId: c.id, date, startHour: 16, endHour: 17, name: "Waiter", phone: waiterPhone });
    const { adminCancelBooking } = await import("../src/lib/store");
    await adminCancelBooking(held.booking.code);
    const offered = (await getDb().prepare("SELECT status, offer_token FROM waitlist WHERE phone = ?").get(waiterPhone)) as { status: string; offer_token: string };
    expect(offered.status).toBe("offered");
    const made = await createOutage({ courtId: c.id, startsOn: date, endsOn: date, adminId: ownerId });
    expect(made.ok).toBe(true);
    expect((await claimWaitlistOffer(offered.offer_token)).ok).toBe(false);
  });

  it("from this afternoon is not refused because a booking this morning was played, and cancels the evening's", async () => {
    const c = await court();
    const date = addDays(todayISO(ZONE), 3);
    const morning = await createBooking({ courtId: c.id, date, hours: [9], name: "Morning", phone: phone() });
    const evening = await createBooking({ courtId: c.id, date, hours: [19], name: "Evening", phone: phone() });
    if (!morning.ok || !evening.ok) throw new Error("setup");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(slotStartsAt(date, 15, ZONE));
    const made = await createOutage({ courtId: c.id, startsOn: date, endsOn: addDays(date, 3), reason: "Net torn", adminId: ownerId, cancelAffected: true });
    expect(made.ok).toBe(true);
    expect(await status(evening.booking.id)).toBe("cancelled");
    expect(await status(morning.booking.id)).toBe("confirmed");
    // Ending it later claims the same time again, played hours not included, without a clash.
    vi.setSystemTime(slotStartsAt(addDays(date, 2), 10, ZONE));
    if (made.ok) expect((await endOutage(made.outage.id)).ok).toBe(true);
  });

  it("leaves a class that has ended alone", async () => {
    const gym = await studio();
    const date = addDays(todayISO(ZONE), 3);
    const morning = await createClassSessions({ courtId: gym.id, name: "CF Out morning", instructor: "Lee", date, startHour: 9, endHour: 10, capacity: 5, price: 30 });
    if (!morning.ok) throw new Error("class");
    const e = await enrolInClass({ classId: morning.classes[0].id, name: "Mei", phone: phone() });
    if (!e.ok) throw new Error("enrol");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(slotStartsAt(date, 15, ZONE));
    const made = await createOutage({ courtId: gym.id, startsOn: date, endsOn: date, adminId: ownerId, cancelAffected: true });
    expect(made.ok).toBe(true);
    expect((await getClass(morning.classes[0].id))!.status).toBe("scheduled");
    expect(await status(e.booking.id)).toBe("confirmed");
  });

  it("with kit still out is refused with nothing changed: no booking cancelled, no outage written", async () => {
    seq++;
    const fleet = await createCourt({ venueId, name: `CF Outage fleet ${seq}`, sport: "kayak", offPeakRate: 15, peakRate: 20, capacity: 1, deposit: 50 });
    if (!fleet.ok) throw new Error(fleet.error);
    const date = addDays(todayISO(), 14);
    const out = await createBooking({ courtId: fleet.court.id, date, hours: [10], name: "Paddler", phone: phone() });
    const later = await createBooking({ courtId: fleet.court.id, date, hours: [15], name: "Later", phone: phone() });
    if (!out.ok || !later.ok) throw new Error("booking");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(slotStartsAt(date, 10.25, ZONE));
    expect((await takeHire(out.booking.code)).ok).toBe(true);
    const made = await createOutage({ courtId: fleet.court.id, startsOn: date, endsOn: date, adminId: ownerId, cancelAffected: true });
    expect(made.ok).toBe(false);
    if (!made.ok) expect(made.error).toContain(out.booking.code);
    expect(await status(later.booking.id)).toBe("confirmed");
    expect(await status(out.booking.id)).toBe("confirmed");
    expect(await getDb().prepare("SELECT 1 FROM court_outages WHERE court_id = ?").get(fleet.court.id)).toBeUndefined();
  });
});
