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
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { WAITLIST_OFFER_MINUTES } from "../src/lib/types";

const futureDate = (offset: number) => addDays(todayISO(), offset);
let seq = 0;

/** A class with `capacity` places, already filled. */
function fullClass(capacity = 1) {
  seq++;
  const court = createCourt({
    venueId: listVenues()[0].id,
    name: `Waitlist Studio ${seq}`,
    sport: "gym",
    offPeakRate: 5,
    peakRate: 8,
    capacity: 20,
  });
  if (!court.ok) throw new Error("court");
  const created = createClassSessions({
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
    const enrolled = enrolInClass({ classId, name: `Holder ${i}`, phone });
    if (!enrolled.ok) throw new Error("enrol");
    holders.push({ phone, booking: enrolled.booking });
  }
  return { classId, holders };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("joining a waitlist", () => {
  it("is only possible once the class is full", () => {
    const court = createCourt({
      venueId: listVenues()[0].id,
      name: "Roomy Studio",
      sport: "gym",
      offPeakRate: 5,
      peakRate: 8,
      capacity: 10,
    });
    if (!court.ok) return;
    const created = createClassSessions({
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
      joinClassWaitlist({ classId: created.classes[0].id, name: "Eager", phone: "0181110001" })
    ).toMatchObject({ ok: false, error: expect.stringContaining("enrol instead") });
  });

  it("queues people in order and refuses duplicates", () => {
    const { classId, holders } = fullClass(1);

    const first = joinClassWaitlist({ classId, name: "First", phone: "0182220001" });
    const second = joinClassWaitlist({ classId, name: "Second", phone: "0182220002" });
    expect(first).toMatchObject({ ok: true, position: 1 });
    expect(second).toMatchObject({ ok: true, position: 2 });

    expect(
      joinClassWaitlist({ classId, name: "First", phone: "0182220001" })
    ).toMatchObject({ ok: false, error: expect.stringContaining("already on this waitlist") });

    // somebody already enrolled has no business queuing
    expect(
      joinClassWaitlist({ classId, name: "Holder", phone: holders[0].phone })
    ).toMatchObject({ ok: false, error: expect.stringContaining("already enrolled") });

    expect(listClassWaitlist(classId).map((e) => e.name)).toEqual(["First", "Second"]);
  });

  it("refuses an unknown or cancelled class", () => {
    expect(joinClassWaitlist({ classId: 99999, name: "X", phone: "0183330001" })).toMatchObject({
      ok: false,
      error: "Class not found.",
    });
    const { classId } = fullClass(1);
    cancelClassSession(classId);
    expect(joinClassWaitlist({ classId, name: "X", phone: "0183330002" })).toMatchObject({
      ok: false,
      error: "This class was cancelled.",
    });
  });
});

describe("offering a freed place", () => {
  it("goes to whoever has waited longest when an enrolment is cancelled", () => {
    const { classId, holders } = fullClass(1);
    joinClassWaitlist({ classId, name: "First", phone: "0184440001" });
    joinClassWaitlist({ classId, name: "Second", phone: "0184440002" });

    // cancelling the only enrolment frees the place
    expect(adminCancelBooking(holders[0].booking.code)).toMatchObject({ ok: true });

    const queue = listClassWaitlist(classId);
    expect(queue[0]).toMatchObject({ name: "First", status: "offered" });
    expect(queue[1]).toMatchObject({ name: "Second", status: "waiting" });
    expect(queue[0].expiresInSeconds).toBeGreaterThan(0);
  });

  it("holds the place for one person at a time", () => {
    const { classId, holders } = fullClass(2);
    joinClassWaitlist({ classId, name: "First", phone: "0185550001" });
    joinClassWaitlist({ classId, name: "Second", phone: "0185550002" });

    adminCancelBooking(holders[0].booking.code);
    adminCancelBooking(holders[1].booking.code);

    // two places freed, but only one live offer — the queue is served in turn
    const offered = listClassWaitlist(classId).filter((e) => e.status === "offered");
    expect(offered).toHaveLength(1);
    expect(offered[0].name).toBe("First");
  });

  it("passes to the next person once an offer times out", () => {
    const { classId, holders } = fullClass(1);
    joinClassWaitlist({ classId, name: "First", phone: "0186660001" });
    joinClassWaitlist({ classId, name: "Second", phone: "0186660002" });
    adminCancelBooking(holders[0].booking.code);
    expect(listClassWaitlist(classId)[0]).toMatchObject({ name: "First", status: "offered" });

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + (WAITLIST_OFFER_MINUTES + 1) * 60_000));

    // reading the queue expires the stale offer
    const queue = listClassWaitlist(classId);
    expect(queue.map((e) => e.name)).toEqual(["Second"]);

    expect(offerClassPlace(classId)).toMatchObject({ name: "Second", status: "offered" });
  });
});

describe("claiming an offer", () => {
  it("enrols the holder and closes their queue entry", () => {
    const { classId, holders } = fullClass(1);
    joinClassWaitlist({ classId, name: "First", phone: "0187770001" });
    adminCancelBooking(holders[0].booking.code);

    const offer = listWaitlistFor("0187770001")[0];
    expect(offer.status).toBe("offered");
    expect(offer.offerToken).toMatch(/^[a-f0-9]{32}$/);

    const claimed = claimWaitlistOffer(offer.offerToken!);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    expect(claimed.booking.classId).toBe(classId);
    expect(claimed.booking.totalPrice).toBe(30);
    expect(getClass(classId)?.enrolled).toBe(1);

    // the token is spent, and they are no longer queuing
    expect(claimWaitlistOffer(offer.offerToken!)).toMatchObject({ ok: false });
    expect(listClassWaitlist(classId)).toHaveLength(0);
  });

  it("rejects an unknown token", () => {
    expect(claimWaitlistOffer("f".repeat(32))).toMatchObject({
      ok: false,
      error: "This offer is no longer valid.",
    });
    expect(claimWaitlistOffer("  ")).toMatchObject({ ok: false });
  });
});

describe("leaving a waitlist", () => {
  it("removes the entry and moves the offer along", () => {
    const { classId, holders } = fullClass(1);
    const first = joinClassWaitlist({ classId, name: "First", phone: "0188880001" });
    joinClassWaitlist({ classId, name: "Second", phone: "0188880002" });
    adminCancelBooking(holders[0].booking.code);
    if (!first.ok) return;

    // the person holding the offer gives it up
    expect(leaveWaitlist(first.entry.id, "0188880001")).toMatchObject({ ok: true });

    const queue = listClassWaitlist(classId);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ name: "Second", status: "offered" });
  });

  it("checks the phone number matches", () => {
    const { classId } = fullClass(1);
    const entry = joinClassWaitlist({ classId, name: "First", phone: "0189990001" });
    if (!entry.ok) return;
    expect(leaveWaitlist(entry.entry.id, "0000000000")).toMatchObject({ ok: false });
    expect(leaveWaitlist(99999, "0189990001")).toMatchObject({ ok: false });
  });
});

describe("waitlists for ordinary slots", () => {
  /** A court hour that is already taken. */
  function takenSlot(offset = 5, hour = 14) {
    seq++;
    const court = createCourt({
      venueId: listVenues()[0].id,
      name: `Queue Court ${seq}`,
      sport: "badminton",
      offPeakRate: 15,
      peakRate: 25,
      capacity: 1,
    });
    if (!court.ok) throw new Error("court");
    const date = futureDate(offset);
    const holder = createBooking({
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

  it("queues only for a slot that is actually taken", () => {
    const { court, date, hour } = takenSlot();

    // the free hour next door is bookable, so queuing is refused
    expect(
      joinSlotWaitlist({
        courtId: court.id, date, startHour: hour + 1, endHour: hour + 2,
        name: "Eager", phone: "0172220001",
      })
    ).toMatchObject({ ok: false, error: expect.stringContaining("book it instead") });

    expect(
      joinSlotWaitlist({
        courtId: court.id, date, startHour: hour, endHour: hour + 1,
        name: "Waiter", phone: "0172220002",
      })
    ).toMatchObject({ ok: true, position: 1 });
  });

  it("validates hours, the window and duplicates", () => {
    const { court, date, hour } = takenSlot(6, 15);
    const person = { name: "Waiter", phone: "0173330001" };

    expect(
      joinSlotWaitlist({ courtId: court.id, date, startHour: 6, endHour: 7, ...person })
    ).toMatchObject({ ok: false, error: expect.stringContaining("operating hours") });
    expect(
      joinSlotWaitlist({ courtId: court.id, date, startHour: 10, endHour: 20, ...person })
    ).toMatchObject({ ok: false, error: expect.stringContaining("Maximum") });
    expect(
      joinSlotWaitlist({
        courtId: court.id, date: addDays(todayISO(), 60), startHour: hour, endHour: hour + 1, ...person,
      })
    ).toMatchObject({ ok: false, error: expect.stringContaining("window") });
    expect(
      joinSlotWaitlist({ courtId: 99999, date, startHour: hour, endHour: hour + 1, ...person })
    ).toMatchObject({ ok: false, error: "Court not found." });

    expect(
      joinSlotWaitlist({ courtId: court.id, date, startHour: hour, endHour: hour + 1, ...person })
    ).toMatchObject({ ok: true });
    expect(
      joinSlotWaitlist({ courtId: court.id, date, startHour: hour, endHour: hour + 1, ...person })
    ).toMatchObject({ ok: false, error: expect.stringContaining("already on this waitlist") });
  });

  it("offers the slot to the longest waiter when the holder cancels", () => {
    const { court, date, hour, holder, holderPhone } = takenSlot(7, 16);
    joinSlotWaitlist({
      courtId: court.id, date, startHour: hour, endHour: hour + 1,
      name: "First", phone: "0174440001",
    });
    joinSlotWaitlist({
      courtId: court.id, date, startHour: hour, endHour: hour + 1,
      name: "Second", phone: "0174440002",
    });

    expect(cancelBooking(holder.code, holderPhone)).toMatchObject({ ok: true });

    const offered = listWaitlistFor("0174440001")[0];
    expect(offered).toMatchObject({ name: "First", status: "offered" });
    expect(listWaitlistFor("0174440002")[0].status).toBe("waiting");
  });

  it("claims the slot as a real booking", () => {
    const { court, date, hour, holder, holderPhone } = takenSlot(8, 17);
    joinSlotWaitlist({
      courtId: court.id, date, startHour: hour, endHour: hour + 1,
      name: "First", phone: "0175550001",
    });
    cancelBooking(holder.code, holderPhone);

    const offer = listWaitlistFor("0175550001")[0];
    const claimed = claimWaitlistOffer(offer.offerToken!);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    expect(claimed.booking.courtId).toBe(court.id);
    expect(claimed.booking.startHour).toBe(hour);
    expect(claimed.booking.name).toBe("First");

    // the hour is taken again
    const slot = getAvailability(court.venueId, date)
      .find((a) => a.court.id === court.id)!
      .slots.find((s) => s.hour === hour)!;
    expect(slot.available).toBe(false);
    expect(listWaitlistFor("0175550001")).toHaveLength(0);
  });

  it("keeps a waiter's place if the slot is gone by the time they claim", () => {
    const { court, date, hour, holder, holderPhone } = takenSlot(9, 18);
    joinSlotWaitlist({
      courtId: court.id, date, startHour: hour, endHour: hour + 1,
      name: "Slow", phone: "0176660001",
    });
    cancelBooking(holder.code, holderPhone);
    const offer = listWaitlistFor("0176660001")[0];
    expect(offer.status).toBe("offered");

    // somebody books it directly before the offer is claimed
    expect(
      createBooking({
        courtId: court.id, date, hours: [hour], name: "Quick", phone: "0176660002",
      }).ok
    ).toBe(true);

    expect(claimWaitlistOffer(offer.offerToken!)).toMatchObject({ ok: false });
    // they go back in the queue rather than losing their turn
    expect(listWaitlistFor("0176660001")[0].status).toBe("waiting");
  });

  it("does not offer a slot that staff have blocked", () => {
    const { court, date, hour, holder, holderPhone } = takenSlot(10, 19);
    joinSlotWaitlist({
      courtId: court.id, date, startHour: hour, endHour: hour + 1,
      name: "Waiter", phone: "0177770001",
    });
    cancelBooking(holder.code, holderPhone);
    // the freed hour is immediately closed for maintenance
    blockSlots(court.id, date, [hour], "resurfacing");

    // an expired offer cannot be re-offered while the block stands
    const entry = listWaitlistFor("0177770001")[0];
    if (entry.status === "offered") leaveWaitlist(entry.id, "0177770001");
    joinSlotWaitlist({
      courtId: court.id, date, startHour: hour, endHour: hour + 1,
      name: "Waiter2", phone: "0177770002",
    });
    expect(offerSlotPlace(court.id, date)).toBeNull();
  });
});
