import { afterEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import {
  adminCancelBooking,
  cancelClassSession,
  claimWaitlistOffer,
  createClassSessions,
  createCourt,
  enrolInClass,
  getClass,
  joinClassWaitlist,
  joinSlotWaitlist,
  leaveWaitlist,
  listClassWaitlist,
  listVenues,
  listWaitlistFor,
  offerClassPlace,
  offerSlotPlace,
  createBooking,
  cancelBooking,
  blockSlots,
  getAvailability,
  passOnExpiredOffers,
  courtsForAnyBooking,
  moveBooking,
  moveTargetsFor,
  rescheduleBooking,
  searchAvailability,
} from "../src/lib/store";
import { getDb } from "../src/lib/db";
import { setCourtParts } from "../src/lib/court-links";
import { addDays, todayISO } from "../src/lib/time";
import { WAITLIST_OFFER_MINUTES } from "../src/lib/types";

const futureDate = (offset: number) => addDays(todayISO(), offset);
let seq = 0;

/** A class with `capacity` places, already filled. */
async function fullClass(capacity = 1) {
  seq++;
  const court = await createCourt({
    venueId: (await listVenues())[0].id,
    name: `Waitlist Studio ${seq}`,
    sport: "gym",
    offPeakRate: 5,
    peakRate: 8,
    capacity: 20,
  });
  if (!court.ok) throw new Error("court");
  const created = await createClassSessions({
    courtId: court.court.id,
    name: `Spin ${seq}`,
    instructor: "Ravi",
    date: futureDate(3),
    startHour: 18,
    endHour: 19,
    capacity,
    price: 30,
  });
  if (!created.ok) throw new Error("class");
  const classId = created.classes[0].id;

  const holders = [];
  for (let i = 0; i < capacity; i++) {
    const phone = `0180${seq}0${i}000`;
    const enrolled = await enrolInClass({ classId, name: `Holder ${i}`, phone });
    if (!enrolled.ok) throw new Error("enrol");
    holders.push({ phone, booking: enrolled.booking });
  }
  return { classId, holders };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("joining a waitlist", () => {
  it("is only possible once the class is full", async () => {
    const court = await createCourt({
      venueId: (await listVenues())[0].id,
      name: "Roomy Studio",
      sport: "gym",
      offPeakRate: 5,
      peakRate: 8,
      capacity: 10,
    });
    if (!court.ok) return;
    const created = await createClassSessions({
      courtId: court.court.id,
      name: "Roomy",
      instructor: "Sam",
      date: futureDate(4),
      startHour: 9,
      endHour: 10,
      capacity: 5,
      price: 20,
    });
    if (!created.ok) return;

    expect(
      await joinClassWaitlist({ classId: created.classes[0].id, name: "Eager", phone: "0181110001" })
    ).toMatchObject({ ok: false, error: expect.stringContaining("enrol instead") });
  });

  it("queues people in order and refuses duplicates", async () => {
    const { classId, holders } = await fullClass(1);

    const first = await joinClassWaitlist({ classId, name: "First", phone: "0182220001" });
    const second = await joinClassWaitlist({ classId, name: "Second", phone: "0182220002" });
    expect(first).toMatchObject({ ok: true, position: 1 });
    expect(second).toMatchObject({ ok: true, position: 2 });

    expect(
      await joinClassWaitlist({ classId, name: "First", phone: "0182220001" })
    ).toMatchObject({ ok: false, error: expect.stringContaining("already on this waitlist") });

    // somebody already enrolled has no business queuing
    expect(
      await joinClassWaitlist({ classId, name: "Holder", phone: holders[0].phone })
    ).toMatchObject({ ok: false, error: expect.stringContaining("already enrolled") });

    expect((await listClassWaitlist(classId)).map((e) => e.name)).toEqual(["First", "Second"]);
  });

  it("refuses an unknown or cancelled class", async () => {
    expect(await joinClassWaitlist({ classId: 99999, name: "X", phone: "0183330001" })).toMatchObject({
      ok: false,
      error: "Class not found.",
    });
    const { classId } = await fullClass(1);
    await cancelClassSession(classId);
    expect(await joinClassWaitlist({ classId, name: "X", phone: "0183330002" })).toMatchObject({
      ok: false,
      error: "This class was cancelled.",
    });
  });
});

describe("offering a freed place", () => {
  it("goes to whoever has waited longest when an enrolment is cancelled", async () => {
    const { classId, holders } = await fullClass(1);
    await joinClassWaitlist({ classId, name: "First", phone: "0184440001" });
    await joinClassWaitlist({ classId, name: "Second", phone: "0184440002" });

    // cancelling the only enrolment frees the place
    expect(await adminCancelBooking(holders[0].booking.code)).toMatchObject({ ok: true });

    const queue = await listClassWaitlist(classId);
    expect(queue[0]).toMatchObject({ name: "First", status: "offered" });
    expect(queue[1]).toMatchObject({ name: "Second", status: "waiting" });
    expect(queue[0].expiresInSeconds).toBeGreaterThan(0);
  });

  it("holds the place for one person at a time", async () => {
    const { classId, holders } = await fullClass(2);
    await joinClassWaitlist({ classId, name: "First", phone: "0185550001" });
    await joinClassWaitlist({ classId, name: "Second", phone: "0185550002" });

    await adminCancelBooking(holders[0].booking.code);
    await adminCancelBooking(holders[1].booking.code);

    // two places freed, but only one live offer — the queue is served in turn
    const offered = (await listClassWaitlist(classId)).filter((e) => e.status === "offered");
    expect(offered).toHaveLength(1);
    expect(offered[0].name).toBe("First");
  });

  it("passes to the next person once an offer times out", async () => {
    const { classId, holders } = await fullClass(1);
    await joinClassWaitlist({ classId, name: "First", phone: "0186660001" });
    await joinClassWaitlist({ classId, name: "Second", phone: "0186660002" });
    await adminCancelBooking(holders[0].booking.code);
    expect((await listClassWaitlist(classId))[0]).toMatchObject({ name: "First", status: "offered" });

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + (WAITLIST_OFFER_MINUTES + 1) * 60_000));

    // reading the queue expires the stale offer
    const queue = await listClassWaitlist(classId);
    expect(queue.map((e) => e.name)).toEqual(["Second"]);

    expect(await offerClassPlace(classId)).toMatchObject({ name: "Second", status: "offered" });
  });
});

describe("claiming an offer", () => {
  it("enrols the holder and closes their queue entry", async () => {
    const { classId, holders } = await fullClass(1);
    await joinClassWaitlist({ classId, name: "First", phone: "0187770001" });
    await adminCancelBooking(holders[0].booking.code);

    const offer = (await listWaitlistFor("0187770001"))[0];
    expect(offer.status).toBe("offered");
    expect(offer.offerToken).toMatch(/^[a-f0-9]{32}$/);

    const claimed = await claimWaitlistOffer(offer.offerToken!);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    expect(claimed.booking.classId).toBe(classId);
    expect(claimed.booking.totalPrice).toBe(30);
    expect((await getClass(classId))?.enrolled).toBe(1);

    // the token is spent, and they are no longer queuing
    expect(await claimWaitlistOffer(offer.offerToken!)).toMatchObject({ ok: false });
    expect(await listClassWaitlist(classId)).toHaveLength(0);
  });

  it("rejects an unknown token", async () => {
    expect(await claimWaitlistOffer("f".repeat(32))).toMatchObject({
      ok: false,
      error: "This offer is no longer valid.",
    });
    expect(await claimWaitlistOffer("  ")).toMatchObject({ ok: false });
  });
});

describe("leaving a waitlist", () => {
  it("removes the entry and moves the offer along", async () => {
    const { classId, holders } = await fullClass(1);
    const first = await joinClassWaitlist({ classId, name: "First", phone: "0188880001" });
    await joinClassWaitlist({ classId, name: "Second", phone: "0188880002" });
    await adminCancelBooking(holders[0].booking.code);
    if (!first.ok) return;

    // the person holding the offer gives it up
    expect(await leaveWaitlist(first.entry.id, "0188880001")).toMatchObject({ ok: true });

    const queue = await listClassWaitlist(classId);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ name: "Second", status: "offered" });
  });

  it("checks the phone number matches", async () => {
    const { classId } = await fullClass(1);
    const entry = await joinClassWaitlist({ classId, name: "First", phone: "0189990001" });
    if (!entry.ok) return;
    expect(await leaveWaitlist(entry.entry.id, "0000000000")).toMatchObject({ ok: false });
    expect(await leaveWaitlist(99999, "0189990001")).toMatchObject({ ok: false });
  });
});

describe("waitlists for ordinary slots", () => {
  /** A court hour that is already taken. */
  async function takenSlot(offset = 5, hour = 14) {
    seq++;
    const court = await createCourt({
      venueId: (await listVenues())[0].id,
      name: `Queue Court ${seq}`,
      sport: "badminton",
      offPeakRate: 15,
      peakRate: 25,
      capacity: 1,
    });
    if (!court.ok) throw new Error("court");
    const date = futureDate(offset);
    const holder = await createBooking({
      courtId: court.court.id,
      date,
      hours: [hour],
      name: "Holder",
      phone: `0171${seq}00000`,
      userId: undefined,
    });
    if (!holder.ok) throw new Error("booking");
    return { court: court.court, date, hour, holder: holder.booking, holderPhone: `0171${seq}00000` };
  }

  it("queues only for a slot that is actually taken", async () => {
    const { court, date, hour } = await takenSlot();

    // the free hour next door is bookable, so queuing is refused
    expect(
      await joinSlotWaitlist({
        courtId: court.id, date, startHour: hour + 1, endHour: hour + 2,
        name: "Eager", phone: "0172220001",
      })
    ).toMatchObject({ ok: false, error: expect.stringContaining("book it instead") });

    expect(
      await joinSlotWaitlist({
        courtId: court.id, date, startHour: hour, endHour: hour + 1,
        name: "Waiter", phone: "0172220002",
      })
    ).toMatchObject({ ok: true, position: 1 });
  });

  it("validates hours, the window and duplicates", async () => {
    const { court, date, hour } = await takenSlot(6, 15);
    const person = { name: "Waiter", phone: "0173330001" };

    expect(
      await joinSlotWaitlist({ courtId: court.id, date, startHour: 6, endHour: 7, ...person })
    ).toMatchObject({ ok: false, error: expect.stringContaining("operating hours") });
    expect(
      await joinSlotWaitlist({ courtId: court.id, date, startHour: 10, endHour: 20, ...person })
    ).toMatchObject({ ok: false, error: expect.stringContaining("Maximum") });
    expect(
      await joinSlotWaitlist({
        courtId: court.id, date: addDays(todayISO(), 60), startHour: hour, endHour: hour + 1, ...person,
      })
    ).toMatchObject({ ok: false, error: expect.stringContaining("window") });
    expect(
      await joinSlotWaitlist({ courtId: 99999, date, startHour: hour, endHour: hour + 1, ...person })
    ).toMatchObject({ ok: false, error: "Court not found." });

    expect(
      await joinSlotWaitlist({ courtId: court.id, date, startHour: hour, endHour: hour + 1, ...person })
    ).toMatchObject({ ok: true });
    expect(
      await joinSlotWaitlist({ courtId: court.id, date, startHour: hour, endHour: hour + 1, ...person })
    ).toMatchObject({ ok: false, error: expect.stringContaining("already on this waitlist") });
  });

  it("offers the slot to the longest waiter when the holder cancels", async () => {
    const { court, date, hour, holder, holderPhone } = await takenSlot(7, 16);
    await joinSlotWaitlist({
      courtId: court.id, date, startHour: hour, endHour: hour + 1,
      name: "First", phone: "0174440001",
    });
    await joinSlotWaitlist({
      courtId: court.id, date, startHour: hour, endHour: hour + 1,
      name: "Second", phone: "0174440002",
    });

    expect(await cancelBooking(holder.code, holderPhone)).toMatchObject({ ok: true });

    const offered = (await listWaitlistFor("0174440001"))[0];
    expect(offered).toMatchObject({ name: "First", status: "offered" });
    expect((await listWaitlistFor("0174440002"))[0].status).toBe("waiting");
  });

  it("claims the slot as a real booking", async () => {
    const { court, date, hour, holder, holderPhone } = await takenSlot(8, 17);
    await joinSlotWaitlist({
      courtId: court.id, date, startHour: hour, endHour: hour + 1,
      name: "First", phone: "0175550001",
    });
    await cancelBooking(holder.code, holderPhone);

    const offer = (await listWaitlistFor("0175550001"))[0];
    const claimed = await claimWaitlistOffer(offer.offerToken!);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    expect(claimed.booking.courtId).toBe(court.id);
    expect(claimed.booking.startHour).toBe(hour);
    expect(claimed.booking.name).toBe("First");

    // the hour is taken again
    const slot = (await getAvailability(court.venueId, date))
      .find((a) => a.court.id === court.id)!
      .slots.find((s) => s.hour === hour)!;
    expect(slot.available).toBe(false);
    expect(await listWaitlistFor("0175550001")).toHaveLength(0);
  });

  it("holds the place for the waiter until they claim it, and passes it on if they do not", async () => {
    const { court, date, hour, holder, holderPhone } = await takenSlot(9, 18);
    await joinSlotWaitlist({
      courtId: court.id, date, startHour: hour, endHour: hour + 1,
      name: "Slow", phone: "0176660001",
    });
    await joinSlotWaitlist({
      courtId: court.id, date, startHour: hour, endHour: hour + 1,
      name: "Next", phone: "0176660003",
    });
    await cancelBooking(holder.code, holderPhone);
    const offer = (await listWaitlistFor("0176660001"))[0];
    expect(offer.status).toBe("offered");

    // nobody else can book it while the offer is live
    expect(
      (await createBooking({
        courtId: court.id, date, hours: [hour], name: "Quick", phone: "0176660002",
      })).ok
    ).toBe(false);

    // the offer runs out: it goes to the next person straight away
    await getDb().prepare("UPDATE waitlist SET offered_at = datetime('now', '-31 minutes') WHERE id = ?").run(offer.id);
    expect(await passOnExpiredOffers()).toBe(1);
    const next = (await listWaitlistFor("0176660003"))[0];
    expect(next.status).toBe("offered");
    expect(await claimWaitlistOffer(next.offerToken!)).toMatchObject({ ok: true });
  });

  it("does not offer a slot that staff have blocked", async () => {
    const { court, date, hour, holder, holderPhone } = await takenSlot(10, 19);
    await joinSlotWaitlist({
      courtId: court.id, date, startHour: hour, endHour: hour + 1,
      name: "Waiter", phone: "0177770001",
    });
    await cancelBooking(holder.code, holderPhone);
    // the freed hour is immediately closed for maintenance
    await blockSlots(court.id, date, [hour], "resurfacing");

    // an expired offer cannot be re-offered while the block stands
    const entry = (await listWaitlistFor("0177770001"))[0];
    if (entry.status === "offered") await leaveWaitlist(entry.id, "0177770001");
    await joinSlotWaitlist({
      courtId: court.id, date, startHour: hour, endHour: hour + 1,
      name: "Waiter2", phone: "0177770002",
    });
    expect(await offerSlotPlace(court.id, date)).toBeNull();
  });
});

describe("a place offered to somebody waiting", () => {
  /** A court hour offered to a waiter: free in the database, but theirs for now. */
  async function offered(offset: number, hour: number, capacity = 1) {
    seq++;
    const venue = (await listVenues())[0];
    const court = await createCourt({ venueId: venue.id, name: `Held Court ${seq}`, sport: "pickleball", offPeakRate: 15, peakRate: 15, capacity });
    if (!court.ok) throw new Error("court");
    const date = futureDate(offset);
    const phone = `0172${seq}00000`;
    const holders = [];
    for (let i = 0; i < capacity; i++) {
      const made = await createBooking({ courtId: court.court.id, date, hours: [hour], name: "Holder", phone: `0172${seq}0000${i}` });
      if (!made.ok) throw new Error(made.error);
      holders.push(made.booking);
    }
    expect((await joinSlotWaitlist({ courtId: court.court.id, date, startHour: hour, endHour: hour + 1, name: "Waiter", phone })).ok).toBe(true);
    await adminCancelBooking(holders[0].code);
    expect((await listWaitlistFor(phone))[0].status).toBe("offered");
    return { venueId: venue.id, court: court.court, date, hour };
  }

  it("is not found by search or by any court", async () => {
    const { venueId, court, date, hour } = await offered(6, 9);
    const found = await searchAvailability({ sport: "pickleball", date, fromHour: hour, toHour: hour, venueIds: [venueId] });
    expect(found.some((r) => r.court.id === court.id && r.startHour === hour)).toBe(false);
    expect((await courtsForAnyBooking({ venueId, sport: "pickleball", date, hours: [hour] })).some((c) => c.id === court.id)).toBe(false);
  });

  it("cannot be taken by moving or rescheduling another booking into it", async () => {
    const { venueId, court, date, hour } = await offered(6, 10);
    const other = await createCourt({ venueId, name: `Other Court ${seq}`, sport: "pickleball", offPeakRate: 15, peakRate: 15 });
    if (!other.ok) throw new Error("court");
    const there = await createBooking({ courtId: other.court.id, date, hours: [hour], name: "Mover", phone: "0179990001" });
    if (!there.ok) throw new Error(there.error);
    expect((await moveTargetsFor(there.booking.code)).some((c) => c.id === court.id)).toBe(false);
    expect((await moveBooking(there.booking.code, court.id)).ok).toBe(false);
    const earlier = await createBooking({ courtId: court.id, date, hours: [hour - 2], name: "Shifter", phone: "0179990002" });
    if (!earlier.ok) throw new Error(earlier.error);
    expect((await rescheduleBooking(earlier.booking.code, { date, startHour: hour, courtId: court.id }, "staff")).ok).toBe(false);
  });

  it("once past its time, gives way to a booking even before anything has let it go", async () => {
    const { court, date, hour } = await offered(7, 12);
    // Lapsed but still marked held: what the scheduler has not yet got round to.
    await getDb().prepare("UPDATE claims SET expires_at = now() - interval '1 minute' WHERE court_id = ? AND kind = 'offer' AND active").run(court.id);
    const taken = await createBooking({ courtId: court.id, date, hours: [hour], name: "After", phone: "0179990004" });
    expect(taken.ok).toBe(true);
    const offers = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM claims WHERE court_id = ? AND kind = 'offer' AND active").get(court.id)) as { n: number };
    expect(offers.n).toBe(0);
  });

  it("still in its time, keeps the court from anybody else", async () => {
    const { court, date, hour } = await offered(7, 13);
    expect((await createBooking({ courtId: court.id, date, hours: [hour], name: "Too soon", phone: "0179990005" })).ok).toBe(false);
  });

  it("on a court under a pitch, keeps the pitch from being sold over it, and leaves the court beside it free", async () => {
    const venue = (await listVenues())[0];
    const make = async (name: string, sport: string) => {
      const made = await createCourt({ venueId: venue.id, name: `${name} ${++seq}`, sport: sport as never, offPeakRate: 15, peakRate: 15 });
      if (!made.ok) throw new Error(made.error);
      return made.court.id;
    };
    const pitch = await make("Linked pitch", "futsal");
    const a = await make("Linked A", "badminton");
    const b = await make("Linked B", "badminton");
    expect(await setCourtParts(pitch, [a, b])).toMatchObject({ ok: true });
    const date = futureDate(8);
    const holder = await createBooking({ courtId: a, date, hours: [15], name: "Holder", phone: "0172880001" });
    if (!holder.ok) throw new Error(holder.error);
    expect((await joinSlotWaitlist({ courtId: a, date, startHour: 15, endHour: 16, name: "Waiter", phone: "0172880002" })).ok).toBe(true);
    await adminCancelBooking(holder.booking.code);
    expect((await listWaitlistFor("0172880002"))[0].status).toBe("offered");

    // The offer holds court A's floor, so the pitch over it cannot be sold then; B, beside it, can.
    expect((await createBooking({ courtId: pitch, date, hours: [15], name: "Pitch", phone: "0172880003" })).ok).toBe(false);
    const grid = await getAvailability(venue.id, date);
    expect(grid.find((d) => d.court.id === pitch)!.slots.find((x) => x.hour === 15)!.available).toBe(false);
    expect((await createBooking({ courtId: b, date, hours: [15], name: "Beside", phone: "0172880004" })).ok).toBe(true);
  });

  it("on a shared floor partly blocked, leaves no place to sell past what the grid shows", async () => {
    // Three places: one blocked, one booked, one offered to the waiter.
    const { venueId, court, date, hour } = await offered(6, 11, 2);
    await getDb().prepare("UPDATE courts SET capacity = 3 WHERE id = ?").run(court.id);
    expect((await blockSlots(court.id, date, [hour], "Repairs", 1)).ok).toBe(true);
    const grid = (await getAvailability(venueId, date)).find((d) => d.court.id === court.id)!;
    expect(grid.slots.find((s) => s.hour === hour)!.available).toBe(false);
    expect((await createBooking({ courtId: court.id, date, hours: [hour], name: "Extra", phone: "0179990003" })).ok).toBe(false);
  });
});
