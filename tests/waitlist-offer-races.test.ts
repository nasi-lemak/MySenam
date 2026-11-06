import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { getDb } from "../src/lib/db";
import {
  adminCancelBooking,
  cancelBooking,
  cancelClassSession,
  claimWaitlistOffer,
  createBooking,
  createClassSessions,
  createCourt,
  enrolInClass,
  getClass,
  getClassRoster,
  joinClassWaitlist,
  joinSlotWaitlist,
  listVenues,
  listWaitlistFor,
  passOnExpiredOffers,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Waiting-list offers under concurrency (ADR 0060): two people claiming at once, a claim racing an expiry, a claim racing the
 * class being called off. Run on PGlite and on Postgres (TEST_DATABASE_URL): the invariants hold on both.
 */

let venueId: number;
let seq = 0;
beforeAll(async () => {
  venueId = (await listVenues())[0].id;
});
afterEach(() => vi.useRealTimers());

const phone = (i: number) => `0163${String(++seq).padStart(3, "0")}${String(i).padStart(4, "0")}`;

async function court() {
  const c = await createCourt({ venueId, name: `WOR Court ${++seq}`, sport: "badminton", offPeakRate: 15, peakRate: 25, capacity: 1 });
  if (!c.ok) throw new Error("court");
  return c.court;
}

async function fullClass(date: string) {
  const studio = await createCourt({ venueId, name: `WOR Studio ${++seq}`, sport: "gym", offPeakRate: 5, peakRate: 8, capacity: 20 });
  if (!studio.ok) throw new Error("studio");
  const made = await createClassSessions({ courtId: studio.court.id, name: `WOR Spin ${seq}`, instructor: "Ravi", date, startHour: 18, endHour: 19, capacity: 1, price: 30 });
  if (!made.ok) throw new Error(made.error);
  return made.classes[0];
}

describe("races on waiting-list offers", () => {
  const date = addDays(todayISO(), 6);

  it("two people claiming their own offers at once are both booked, each in their own time", async () => {
    const c = await court();
    const h10 = await createBooking({ courtId: c.id, date, hours: [10], name: "Holder10", phone: phone(1) });
    const h15 = await createBooking({ courtId: c.id, date, hours: [15], name: "Holder15", phone: phone(2) });
    if (!h10.ok || !h15.ok) throw new Error("setup");
    const alice = phone(3);
    const bob = phone(4);
    await joinSlotWaitlist({ courtId: c.id, date, startHour: 10, endHour: 11, name: "Alice", phone: alice });
    await joinSlotWaitlist({ courtId: c.id, date, startHour: 15, endHour: 16, name: "Bob", phone: bob });
    await cancelBooking(h10.booking.code, h10.booking.phone);
    await cancelBooking(h15.booking.code, h15.booking.phone);
    const [a] = await listWaitlistFor(alice);
    const [b] = await listWaitlistFor(bob);
    expect([a.status, b.status]).toEqual(["offered", "offered"]);
    const [ra, rb] = await Promise.all([claimWaitlistOffer(a.offerToken!), claimWaitlistOffer(b.offerToken!)]);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    const live = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM claims WHERE court_id = ? AND active AND kind = 'booking'").get(c.id)) as { n: number };
    expect(live.n).toBe(2);
  });

  it("the same offer claimed twice at once is taken once", async () => {
    const c = await court();
    const h = await createBooking({ courtId: c.id, date, hours: [11], name: "Holder", phone: phone(1) });
    if (!h.ok) throw new Error("setup");
    const waiter = phone(2);
    await joinSlotWaitlist({ courtId: c.id, date, startHour: 11, endHour: 12, name: "Waiter", phone: waiter });
    await cancelBooking(h.booking.code, h.booking.phone);
    const [offer] = await listWaitlistFor(waiter);
    const results = await Promise.all(Array.from({ length: 4 }, () => claimWaitlistOffer(offer.offerToken!)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const booked = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE court_id = ? AND date = ? AND status = 'confirmed'").get(c.id, date)) as { n: number };
    expect(booked.n).toBe(1);
  });

  it("a claim racing the offer running out ends as either a booking or the place passed on, never both", async () => {
    let both = 0;
    let neither = 0;
    for (let round = 0; round < 6; round++) {
      const c = await court();
      const day = addDays(todayISO(), 7 + round);
      const h = await createBooking({ courtId: c.id, date: day, hours: [12], name: "Holder", phone: phone(1) });
      if (!h.ok) throw new Error("setup");
      const first = phone(2);
      const second = phone(3);
      await joinSlotWaitlist({ courtId: c.id, date: day, startHour: 12, endHour: 13, name: "First", phone: first });
      await joinSlotWaitlist({ courtId: c.id, date: day, startHour: 12, endHour: 13, name: "Second", phone: second });
      await cancelBooking(h.booking.code, h.booking.phone);
      const [offer] = await listWaitlistFor(first);
      // The offer is at its very end.
      await getDb().prepare("UPDATE waitlist SET offered_at = datetime('now', '-30 minutes') WHERE phone = ?").run(first);
      await Promise.all([claimWaitlistOffer(offer.offerToken!), passOnExpiredOffers()]);
      const booked = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE court_id = ? AND date = ? AND status = 'confirmed'").get(c.id, day)) as { n: number };
      const live = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM claims WHERE court_id = ? AND active AND kind = 'offer'").get(c.id)) as { n: number };
      if (booked.n > 0 && live.n > 0) both++;
      if (booked.n === 0 && live.n === 0) neither++;
      expect(booked.n + live.n).toBeLessThanOrEqual(1);
    }
    expect(both).toBe(0);
    // An offer past its end cannot be claimed: the place went to the next each time.
    expect(neither).toBe(0);
  });

  it("a claim racing the class being called off leaves no confirmed enrolment, and no entry still waiting", async () => {
    let bad = 0;
    for (let round = 0; round < 8; round++) {
      const cl = await fullClass(addDays(todayISO(), 3 + round));
      const holder = await enrolInClass({ classId: cl.id, name: "Holder", phone: phone(1) });
      if (!holder.ok) throw new Error("enrol");
      const first = phone(2);
      await joinClassWaitlist({ classId: cl.id, name: "First", phone: first });
      await joinClassWaitlist({ classId: cl.id, name: "Second", phone: phone(3) });
      await adminCancelBooking(holder.booking.code);
      const [offer] = await listWaitlistFor(first);
      await Promise.all([claimWaitlistOffer(offer.offerToken!), cancelClassSession(cl.id)]);
      const s = await getClass(cl.id);
      const roster = await getClassRoster(cl.id);
      const open = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM waitlist WHERE class_id = ? AND status IN ('waiting','offered')").get(cl.id)) as { n: number };
      if (s!.status === "cancelled" && (roster.some((b) => b.status === "confirmed") || open.n > 0)) bad++;
    }
    expect(bad).toBe(0);
  });

  it("two people joining a class's list while it is called off are closed with the rest or refused", async () => {
    let bad = 0;
    for (let round = 0; round < 6; round++) {
      const cl = await fullClass(addDays(todayISO(), 3 + round));
      const holder = await enrolInClass({ classId: cl.id, name: "Holder", phone: phone(1) });
      if (!holder.ok) throw new Error("enrol");
      await Promise.all([
        cancelClassSession(cl.id),
        joinClassWaitlist({ classId: cl.id, name: "Late A", phone: phone(2) }),
        joinClassWaitlist({ classId: cl.id, name: "Late B", phone: phone(3) }),
      ]);
      const open = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM waitlist WHERE class_id = ? AND status IN ('waiting','offered')").get(cl.id)) as { n: number };
      if (open.n > 0) bad++;
    }
    expect(bad).toBe(0);
  });
});
