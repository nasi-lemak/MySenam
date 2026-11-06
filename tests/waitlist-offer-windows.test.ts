import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { getDb } from "../src/lib/db";
import { holdPolicy, setHoldPolicy } from "../src/lib/holds";
import { notifyPendingOffers } from "../src/lib/notify";
import {
  adminCancelBooking,
  cancelBooking,
  claimWaitlistOffer,
  createBooking,
  createClassSessions,
  createCourt,
  enrolInClass,
  joinClassWaitlist,
  joinSlotWaitlist,
  listClassWaitlist,
  listVenues,
  listWaitlistFor,
  offerClassPlace,
  offerSlotPlace,
  passOnExpiredOffers,
} from "../src/lib/store";
import { translator } from "../src/lib/i18n";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Waiting-list offers (ADR 0060): one live offer per time, not per court and day; no offer for what has begun; every offer
 * ends at the venue's offer window or at the start, whichever is first; a lapsed offer is told once.
 * Dates are fixed by fake clocks where the time to the start matters: nothing here depends on the time of day.
 */

let venueId: number;
let seq = 0;
beforeAll(async () => {
  venueId = (await listVenues())[0].id;
});
afterEach(() => vi.useRealTimers());

const phone = (i: number) => `0165${String(++seq).padStart(3, "0")}${String(i).padStart(4, "0")}`;
const stamp = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);

async function court(capacity = 1) {
  const c = await createCourt({ venueId, name: `WOW Court ${++seq}`, sport: "badminton", offPeakRate: 15, peakRate: 25, capacity });
  if (!c.ok) throw new Error("court");
  return c.court;
}

async function studioClass(capacity: number, opts: { date?: string; startHour?: number } = {}) {
  const studio = await createCourt({ venueId, name: `WOW Studio ${++seq}`, sport: "gym", offPeakRate: 5, peakRate: 8, capacity: 20 });
  if (!studio.ok) throw new Error("studio");
  const made = await createClassSessions({
    courtId: studio.court.id,
    name: `WOW Spin ${seq}`,
    instructor: "Ravi",
    date: opts.date ?? addDays(todayISO(), 3),
    startHour: opts.startHour ?? 18,
    endHour: (opts.startHour ?? 18) + 1,
    capacity,
    price: 30,
  });
  if (!made.ok) throw new Error(made.error);
  return made.classes[0];
}

/** 18:00 Kuala Lumpur is 10:00 UTC. */
const atKl = (date: string, hour: number, minute: number) => new Date(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+08:00`);

describe("B6: a live offer holds only its own time", () => {
  const date = addDays(todayISO(), 5);

  it("offers independent times on one court and day at once", async () => {
    const c = await court();
    const h10 = await createBooking({ courtId: c.id, date, hours: [10], name: "Holder10", phone: phone(1) });
    const h15 = await createBooking({ courtId: c.id, date, hours: [15], name: "Holder15", phone: phone(2) });
    if (!h10.ok || !h15.ok) throw new Error("setup");
    const alice = phone(3);
    const bob = phone(4);
    await joinSlotWaitlist({ courtId: c.id, date, startHour: 10, endHour: 11, name: "Alice", phone: alice });
    await joinSlotWaitlist({ courtId: c.id, date, startHour: 15, endHour: 16, name: "Bob", phone: bob });

    expect((await cancelBooking(h10.booking.code, h10.booking.phone)).ok).toBe(true);
    expect((await listWaitlistFor(alice))[0].status).toBe("offered");
    expect((await cancelBooking(h15.booking.code, h15.booking.phone)).ok).toBe(true);
    expect((await listWaitlistFor(bob))[0].status).toBe("offered");

    // Each holds its own hour: nobody can book either.
    expect((await createBooking({ courtId: c.id, date, hours: [10], name: "Late", phone: phone(5) })).ok).toBe(false);
    expect((await createBooking({ courtId: c.id, date, hours: [15], name: "Late", phone: phone(6) })).ok).toBe(false);
  });

  it("still serialises an overlapping time: one live offer per interval", async () => {
    const c = await court();
    const h = await createBooking({ courtId: c.id, date, hours: [10, 11], name: "Holder", phone: phone(1) });
    if (!h.ok) throw new Error("setup");
    const alice = phone(2);
    const carol = phone(3);
    await joinSlotWaitlist({ courtId: c.id, date, startHour: 10, endHour: 11, name: "Alice", phone: alice });
    await joinSlotWaitlist({ courtId: c.id, date, startHour: 10, endHour: 12, name: "Carol", phone: carol });
    expect((await cancelBooking(h.booking.code, h.booking.phone)).ok).toBe(true);
    expect((await listWaitlistFor(alice))[0].status).toBe("offered");
    // 10-12 is not free while Alice's offer holds 10-11.
    expect((await listWaitlistFor(carol))[0].status).toBe("waiting");
    const live = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM claims WHERE court_id = ? AND kind = 'offer' AND active").get(c.id)) as { n: number };
    expect(live.n).toBe(1);
  });

  it("offers the other times once an offer is claimed, and the next once one is turned down", async () => {
    const c = await court();
    const h10 = await createBooking({ courtId: c.id, date, hours: [10], name: "Holder10", phone: phone(1) });
    const h15 = await createBooking({ courtId: c.id, date, hours: [15], name: "Holder15", phone: phone(2) });
    if (!h10.ok || !h15.ok) throw new Error("setup");
    const alice = phone(3);
    const bob = phone(4);
    await joinSlotWaitlist({ courtId: c.id, date, startHour: 10, endHour: 11, name: "Alice", phone: alice });
    await joinSlotWaitlist({ courtId: c.id, date, startHour: 15, endHour: 16, name: "Bob", phone: bob });
    // Both hours come free without anything offering them (a path that frees a booking quietly).
    await getDb().prepare("UPDATE bookings SET status = 'cancelled' WHERE id IN (?, ?)").run(h10.booking.id, h15.booking.id);
    await getDb().prepare("UPDATE claims SET active = false WHERE booking_id IN (?, ?)").run(h10.booking.id, h15.booking.id);
    expect((await listWaitlistFor(alice))[0].status).toBe("waiting");
    // Alice is offered hers by the sweep for the day...
    expect(await offerSlotPlace(c.id, date)).toMatchObject({ name: "Alice", status: "offered" });
    // ... which also offered Bob's (independent) hour in the same pass.
    expect((await listWaitlistFor(bob))[0].status).toBe("offered");

    // Now a case where Bob waits un-offered: he lost his offer to the venue not being open, say; put him back to waiting.
    await getDb().prepare("UPDATE waitlist SET status = 'waiting', offered_at = NULL, offer_token = NULL WHERE phone = ?").run(bob);
    await getDb().prepare("UPDATE claims SET active = false WHERE kind = 'offer' AND waitlist_id = (SELECT id FROM waitlist WHERE phone = ?)").run(bob);
    expect((await listWaitlistFor(bob))[0].status).toBe("waiting");
    const alicesOffer = (await listWaitlistFor(alice))[0];
    expect((await claimWaitlistOffer(alicesOffer.offerToken!)).ok).toBe(true);
    // The claim swept the day: Bob, waiting for an hour that has been free all along, is offered it.
    expect((await listWaitlistFor(bob))[0].status).toBe("offered");
  });
});

describe("B7/E5: nothing is offered for what has begun, and no offer outlasts the start", () => {
  it("makes no class offer once the class has started", async () => {
    const cl = await studioClass(1);
    const holder = await enrolInClass({ classId: cl.id, name: "Holder", phone: phone(1) });
    if (!holder.ok) throw new Error("enrol");
    expect((await joinClassWaitlist({ classId: cl.id, name: "Waiter", phone: phone(2) })).ok).toBe(true);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(atKl(cl.date, 18, 10));
    expect((await adminCancelBooking(holder.booking.code)).ok).toBe(true);
    expect((await listClassWaitlist(cl.id))[0].status).toBe("waiting");
    expect(await offerClassPlace(cl.id)).toBeNull();
  });

  it("makes no class offer with only a few minutes to the start, leaving the place to the desk", async () => {
    const cl = await studioClass(1);
    const holder = await enrolInClass({ classId: cl.id, name: "Holder", phone: phone(1) });
    if (!holder.ok) throw new Error("enrol");
    await joinClassWaitlist({ classId: cl.id, name: "Waiter", phone: phone(2) });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(atKl(cl.date, 17, 56));
    expect((await adminCancelBooking(holder.booking.code)).ok).toBe(true);
    expect((await listClassWaitlist(cl.id))[0].status).toBe("waiting");
    // ... and the desk can fill it.
    expect((await enrolInClass({ classId: cl.id, name: "Walk-in", phone: phone(3) })).ok).toBe(true);
  });

  it("caps a class offer at the start, and lets it lapse there", async () => {
    const cl = await studioClass(1);
    const holder = await enrolInClass({ classId: cl.id, name: "Holder", phone: phone(1) });
    if (!holder.ok) throw new Error("enrol");
    await joinClassWaitlist({ classId: cl.id, name: "First", phone: phone(2) });
    await joinClassWaitlist({ classId: cl.id, name: "Second", phone: phone(3) });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(atKl(cl.date, 17, 48));
    expect((await adminCancelBooking(holder.booking.code)).ok).toBe(true);
    // The database stamps the offer with its own clock; put it on the test's.
    await getDb().prepare("UPDATE waitlist SET offered_at = ? WHERE class_id = ? AND status = 'offered'").run(stamp(new Date()), cl.id);
    const [first] = await listClassWaitlist(cl.id);
    expect(first).toMatchObject({ name: "First", status: "offered" });
    // Twelve minutes to the start: the offer is twelve minutes, not thirty.
    expect(first.expiresInSeconds).toBeLessThanOrEqual(12 * 60);
    expect(first.expiresInSeconds).toBeGreaterThan(11 * 60);
    const row = (await getDb().prepare("SELECT offer_minutes FROM waitlist WHERE id = ?").get(first.id)) as { offer_minutes: number };
    expect(row.offer_minutes).toBe(12);
    expect(await enrolInClass({ classId: cl.id, name: "Walk-in", phone: phone(4) })).toMatchObject({ ok: false, code: "CLASS_FULL" });

    // At the start the offer is over; the place goes to nobody (the class has begun) and the desk may fill it.
    vi.setSystemTime(new Date(atKl(cl.date, 18, 0).getTime() + 1_000));
    await passOnExpiredOffers();
    const statuses = (await getDb().prepare("SELECT name, status FROM waitlist WHERE class_id = ? ORDER BY id").all(cl.id)) as { name: string; status: string }[];
    expect(statuses).toEqual([
      { name: "First", status: "expired" },
      { name: "Second", status: "expired" },
    ]);
  });

  it("caps a court offer at the start and refuses the claim after it", async () => {
    const c = await court();
    const date = addDays(todayISO(), 4);
    const held = await createBooking({ courtId: c.id, date, hours: [16], name: "Holder", phone: phone(1) });
    if (!held.ok) throw new Error("booking");
    const waiter = phone(2);
    await joinSlotWaitlist({ courtId: c.id, date, startHour: 16, endHour: 17, name: "Waiter", phone: waiter });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(atKl(date, 15, 50));
    expect((await adminCancelBooking(held.booking.code)).ok).toBe(true);
    await getDb().prepare("UPDATE waitlist SET offered_at = ? WHERE phone = ? AND status = 'offered'").run(stamp(new Date()), waiter);
    const entry = (await listWaitlistFor(waiter))[0];
    expect(entry.status).toBe("offered");
    expect(entry.expiresInSeconds).toBeLessThanOrEqual(10 * 60);
    // Its hold on the court ends with it, never after the start.
    const claim = (await getDb().prepare("SELECT expires_at FROM claims WHERE court_id = ? AND kind = 'offer' AND active").get(c.id)) as { expires_at: Date | string };
    expect(new Date(claim.expires_at).getTime()).toBeLessThanOrEqual(atKl(date, 16, 0).getTime());

    vi.setSystemTime(new Date(atKl(date, 16, 0).getTime() + 1_000));
    // The lapsed offer's link is dead (its token goes with it): nothing is booked.
    expect(await claimWaitlistOffer(entry.offerToken!)).toMatchObject({ ok: false });
    const booked = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE court_id = ? AND date = ? AND status = 'confirmed'").get(c.id, date)) as { n: number };
    expect(booked.n).toBe(0);
  });

  it("makes no court offer for a time that has begun, nor with too little left, and passes to somebody whose time is later", async () => {
    const c = await court();
    const date = addDays(todayISO(), 4);
    const h16 = await createBooking({ courtId: c.id, date, hours: [16], name: "Holder16", phone: phone(1) });
    const h18 = await createBooking({ courtId: c.id, date, hours: [18], name: "Holder18", phone: phone(2) });
    if (!h16.ok || !h18.ok) throw new Error("booking");
    const early = phone(3);
    const late = phone(4);
    await joinSlotWaitlist({ courtId: c.id, date, startHour: 16, endHour: 17, name: "Early", phone: early });
    await joinSlotWaitlist({ courtId: c.id, date, startHour: 18, endHour: 19, name: "Late", phone: late });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(atKl(date, 16, 2));
    expect((await adminCancelBooking(h16.booking.code)).ok).toBe(true);
    expect((await adminCancelBooking(h18.booking.code)).ok).toBe(true);
    // The database stamps the offer with its own clock (PGlite follows the fake one, Postgres does not): put it on the test's.
    await getDb().prepare("UPDATE waitlist SET offered_at = ? WHERE phone = ? AND status = 'offered'").run(stamp(new Date()), late);
    expect((await listWaitlistFor(early))[0].status).toBe("waiting");
    expect((await listWaitlistFor(late))[0].status).toBe("offered");
  });
});

describe("B13: the venue's offer window", () => {
  it("defaults to 30 minutes and is the venue's own setting, 5 to 120", async () => {
    expect((await holdPolicy(venueId)).offerMinutes).toBe(30);
    expect((await setHoldPolicy(venueId, { on: false, offerMinutes: 4 })).ok).toBe(false);
    expect((await setHoldPolicy(venueId, { on: false, offerMinutes: 121 })).ok).toBe(false);
    expect((await setHoldPolicy(venueId, { on: false, offerMinutes: 2.5 })).ok).toBe(false);
    expect((await holdPolicy(venueId)).offerMinutes).toBe(30);
    expect((await setHoldPolicy(venueId, { on: false, offerMinutes: 45 })).ok).toBe(true);
    expect((await holdPolicy(venueId)).offerMinutes).toBe(45);
    // Not given: as it was.
    expect((await setHoldPolicy(venueId, { on: false })).ok).toBe(true);
    expect((await holdPolicy(venueId)).offerMinutes).toBe(45);
    expect((await setHoldPolicy(venueId, { on: false, offerMinutes: 30 })).ok).toBe(true);
  });

  it("gives an offer the venue's window, told in the offer, and keeps it when the setting changes later", async () => {
    expect((await setHoldPolicy(venueId, { on: false, offerMinutes: 10 })).ok).toBe(true);
    try {
      const cl = await studioClass(1);
      const holder = await enrolInClass({ classId: cl.id, name: "Holder", phone: phone(1) });
      if (!holder.ok) throw new Error("enrol");
      const waiting = phone(2);
      await joinClassWaitlist({ classId: cl.id, name: "Waiter", phone: waiting, email: "wow-window@example.com", locale: "ms" });
      expect((await adminCancelBooking(holder.booking.code)).ok).toBe(true);
      const [entry] = await listClassWaitlist(cl.id);
      expect(entry.status).toBe("offered");
      expect(entry.expiresInSeconds).toBeLessThanOrEqual(10 * 60);
      expect(entry.expiresInSeconds).toBeGreaterThan(9 * 60);

      const told = await notifyPendingOffers();
      const mail = told.find((m) => m.recipient === "wow-window@example.com");
      expect(mail?.body).toContain("10 minit");

      // The venue raises the window: the offer already made ends when it was told it would.
      await setHoldPolicy(venueId, { on: false, offerMinutes: 60 });
      const [again] = await listClassWaitlist(cl.id);
      expect(again.expiresInSeconds).toBeLessThanOrEqual(10 * 60);
    } finally {
      await setHoldPolicy(venueId, { on: false, offerMinutes: 30 });
    }
  });

  it("tells a lapsed offer once, in the person's language, instead of silently", async () => {
    const cl = await studioClass(1);
    const holder = await enrolInClass({ classId: cl.id, name: "Holder", phone: phone(1) });
    if (!holder.ok) throw new Error("enrol");
    const zh = phone(2);
    const noMail = phone(3);
    await joinClassWaitlist({ classId: cl.id, name: "Lapse Zh", phone: zh, email: "wow-lapse-zh@example.com", locale: "zh" });
    await joinClassWaitlist({ classId: cl.id, name: "No Mail", phone: noMail });
    expect((await adminCancelBooking(holder.booking.code)).ok).toBe(true);
    expect((await listWaitlistFor(zh))[0].status).toBe("offered");
    // Nobody claims; the offer runs out.
    await getDb().prepare("UPDATE waitlist SET offered_at = datetime('now', '-31 minutes') WHERE phone = ?").run(zh);
    // (Also offers again the idle places of other lapsed offers in the hour: tests share a database.)
    expect(await passOnExpiredOffers()).toBeGreaterThanOrEqual(1);

    const first = await notifyPendingOffers();
    const lapsed = first.filter((m) => m.recipient === "wow-lapse-zh@example.com" && m.kind === "waitlist_ended");
    expect(lapsed).toHaveLength(1);
    expect(lapsed[0].locale).toBe("zh");
    expect(lapsed[0].subject).toBe(translator("zh")("fx2.msg.offerLapsedSubject", { venue: (await listVenues())[0].name }));
    expect(lapsed[0].body).toContain("已转给下一位候补者");
    // Once: the sweep writes nothing again.
    const second = await notifyPendingOffers();
    expect(second.filter((m) => m.kind === "waitlist_ended")).toEqual([]);
    // The next in line (no address) was offered the place and told by the usual offer.
    expect((await listWaitlistFor(noMail))[0].status).toBe("offered");
  });

  it("closes entries still waiting for a class that has begun, quietly", async () => {
    const cl = await studioClass(1);
    const holder = await enrolInClass({ classId: cl.id, name: "Holder", phone: phone(1) });
    if (!holder.ok) throw new Error("enrol");
    const waiter = phone(2);
    await joinClassWaitlist({ classId: cl.id, name: "Waiter", phone: waiter, email: "wow-begun@example.com" });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(atKl(cl.date, 18, 30));
    await passOnExpiredOffers();
    const row = (await getDb().prepare("SELECT status FROM waitlist WHERE phone = ?").get(waiter)) as { status: string };
    expect(row.status).toBe("expired");
    expect((await notifyPendingOffers()).filter((m) => m.recipient === "wow-begun@example.com")).toEqual([]);
  });
});
