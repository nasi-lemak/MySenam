import { afterEach, describe, expect, it, vi } from "vitest";

process.env.MUDAHTEMPAH_DB = ":memory:";

import {
  adminCancelBooking,
  cancelClassSession,
  claimWaitlistOffer,
  createClassSessions,
  createCourt,
  enrolInClass,
  getClass,
  joinClassWaitlist,
  leaveWaitlist,
  listClassWaitlist,
  listVenues,
  listWaitlistFor,
  offerClassPlace,
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
