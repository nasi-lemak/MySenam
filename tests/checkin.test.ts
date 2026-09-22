import { afterEach, describe, expect, it, vi } from "vitest";

process.env.MUDAHTEMPAH_DB = ":memory:";

import {
  adminCancelBooking,
  checkIn,
  checkInByToken,
  checkOut,
  createBooking,
  createCourt,
  getLiveOccupancy,
  listBookingsForDate,
  listVenues,
  setNoShow,
} from "../src/lib/store";
import { todayISO } from "../src/lib/time";
import { CHECK_IN_OPENS_MINUTES_BEFORE } from "../src/lib/types";

const VENUE = () => listVenues()[0];

function gym(capacity: number, name: string) {
  const created = createCourt({
    venueId: VENUE().id,
    name,
    sport: "gym",
    offPeakRate: 5,
    peakRate: 8,
    capacity,
  });
  if (!created.ok) throw new Error("gym not created");
  return created.court;
}

/** Book an hour today that is currently running, then freeze the clock in it. */
function bookRunningNow(courtId: number, phone: string, hour = 12) {
  vi.useRealTimers();
  const date = todayISO();
  vi.useFakeTimers();
  // just before the slot, so booking is allowed
  vi.setSystemTime(new Date(`${date}T${String(hour - 1).padStart(2, "0")}:30:00+08:00`));
  const booking = createBooking({ courtId, date, hours: [hour], name: "P", phone });
  // now inside the slot
  vi.setSystemTime(new Date(`${date}T${String(hour).padStart(2, "0")}:15:00+08:00`));
  return booking;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("check-in", () => {
  it("records an arrival once and refuses repeats, unknown and cancelled bookings", () => {
    const court = gym(5, "Checkin Gym");
    const booking = bookRunningNow(court.id, "0140000001");
    expect(booking.ok).toBe(true);
    if (!booking.ok) return;
    expect(booking.booking.checkedInAt).toBeNull();

    const arrived = checkIn(booking.booking.code);
    expect(arrived.ok).toBe(true);
    if (!arrived.ok) return;
    expect(arrived.booking.checkedInAt).toBeTruthy();
    expect(arrived.booking.checkedOutAt).toBeNull();

    expect(checkIn(booking.booking.code)).toMatchObject({
      ok: false,
      error: "Already checked in.",
    });
    expect(checkIn("MT-NOSUCH")).toMatchObject({ ok: false, error: "Booking not found." });

    const other = bookRunningNow(court.id, "0140000002", 13);
    if (!other.ok) return;
    adminCancelBooking(other.booking.code);
    expect(checkIn(other.booking.code)).toMatchObject({
      ok: false,
      error: expect.stringContaining("cancelled"),
    });
  });

  it("checks out only after checking in", () => {
    const court = gym(5, "Checkout Gym");
    const booking = bookRunningNow(court.id, "0140000101");
    if (!booking.ok) return;

    expect(checkOut(booking.booking.code)).toMatchObject({
      ok: false,
      error: expect.stringContaining("not checked in"),
    });
    checkIn(booking.booking.code);
    const left = checkOut(booking.booking.code);
    expect(left.ok).toBe(true);
    if (!left.ok) return;
    expect(left.booking.checkedOutAt).toBeTruthy();
    expect(checkOut(booking.booking.code)).toMatchObject({
      ok: false,
      error: "Already checked out.",
    });
  });

  it("is incompatible with a no-show in both directions", () => {
    const court = gym(5, "Attendance Gym");
    const booking = bookRunningNow(court.id, "0140000201");
    if (!booking.ok) return;
    checkIn(booking.booking.code);

    // the slot has passed, but they demonstrably turned up
    vi.setSystemTime(new Date(`${todayISO()}T23:00:00+08:00`));
    expect(setNoShow(booking.booking.code, true)).toMatchObject({
      ok: false,
      error: expect.stringContaining("checked in"),
    });
  });

  it("clears a stale no-show flag when the customer turns up late", () => {
    const court = gym(5, "Late Gym");
    const booking = bookRunningNow(court.id, "0140000301", 9);
    if (!booking.ok) return;

    // desk gives up on them
    vi.setSystemTime(new Date(`${todayISO()}T09:50:00+08:00`));
    expect(setNoShow(booking.booking.code, true)).toMatchObject({ ok: true });

    // then they walk in
    const arrived = checkIn(booking.booking.code);
    expect(arrived.ok).toBe(true);
    if (!arrived.ok) return;
    expect(arrived.booking.noShow).toBe(false);
  });

  it("surfaces check-in times on the day list", () => {
    const court = gym(5, "List Gym");
    const booking = bookRunningNow(court.id, "0140000401", 14);
    if (!booking.ok) return;
    checkIn(booking.booking.code);

    const row = listBookingsForDate(booking.booking.date).find(
      (r) => r.code === booking.booking.code
    );
    expect(row?.checkedInAt).toBeTruthy();
    expect(row?.checkedOutAt).toBeNull();
  });
});

describe("live occupancy", () => {
  it("counts people inside now, and stops counting them once they leave", () => {
    const court = gym(10, "Live Gym");
    const venueId = VENUE().id;

    const a = bookRunningNow(court.id, "0140000501", 16);
    const b = bookRunningNow(court.id, "0140000502", 16);
    if (!a.ok || !b.ok) return;

    const idle = getLiveOccupancy(venueId).find((o) => o.courtId === court.id)!;
    expect(idle).toMatchObject({ present: 0, capacity: 10, level: "quiet" });

    checkIn(a.booking.code);
    checkIn(b.booking.code);
    const busy = getLiveOccupancy(venueId).find((o) => o.courtId === court.id)!;
    expect(busy.present).toBe(2);

    checkOut(a.booking.code);
    expect(getLiveOccupancy(venueId).find((o) => o.courtId === court.id)!.present).toBe(1);
  });

  it("stops counting someone whose booking has ended even without a check-out", () => {
    const court = gym(10, "Expiry Gym");
    const venueId = VENUE().id;
    const booking = bookRunningNow(court.id, "0140000601", 10);
    if (!booking.ok) return;
    checkIn(booking.booking.code);
    expect(getLiveOccupancy(venueId).find((o) => o.courtId === court.id)!.present).toBe(1);

    // the 10:00–11:00 slot is over; they are assumed to have left
    vi.setSystemTime(new Date(`${todayISO()}T11:30:00+08:00`));
    expect(getLiveOccupancy(venueId).find((o) => o.courtId === court.id)!.present).toBe(0);
  });

  it("reports a busyness level that tracks how full the room is", () => {
    const court = gym(4, "Level Gym");
    const venueId = VENUE().id;
    const level = () => getLiveOccupancy(venueId).find((o) => o.courtId === court.id)!.level;

    const people = [1, 2, 3, 4].map((i) => bookRunningNow(court.id, `014000070${i}`, 20));
    expect(level()).toBe("quiet");

    for (const [i, p] of people.entries()) {
      if (!p.ok) continue;
      checkIn(p.booking.code);
      if (i === 0) expect(level()).toBe("quiet"); // 1/4
      if (i === 1) expect(level()).toBe("filling"); // 2/4
      if (i === 2) expect(level()).toBe("busy"); // 3/4
      if (i === 3) expect(level()).toBe("full"); // 4/4
    }
  });
});

describe("self-service check-in by QR token", () => {
  it("issues a distinct secret token with every booking", () => {
    const court = gym(5, "Token Gym");
    const a = bookRunningNow(court.id, "0150000001", 15);
    const b = bookRunningNow(court.id, "0150000002", 15);
    if (!a.ok || !b.ok) return;

    expect(a.booking.checkInToken).toMatch(/^[a-f0-9]{32}$/);
    expect(b.booking.checkInToken).toMatch(/^[a-f0-9]{32}$/);
    expect(a.booking.checkInToken).not.toBe(b.booking.checkInToken);
  });

  it("checks the holder in, and rejects an unknown or empty token", () => {
    const court = gym(5, "Scan Gym");
    const booking = bookRunningNow(court.id, "0150000101", 16);
    if (!booking.ok) return;

    const scanned = checkInByToken(booking.booking.checkInToken!);
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(scanned.booking.code).toBe(booking.booking.code);
    expect(scanned.booking.checkedInAt).toBeTruthy();

    // scanning twice is refused, as at the desk
    expect(checkInByToken(booking.booking.checkInToken!)).toMatchObject({
      ok: false,
      error: "Already checked in.",
    });
    expect(checkInByToken("f".repeat(32))).toMatchObject({
      ok: false,
      error: "Booking not found.",
    });
    expect(checkInByToken("  ")).toMatchObject({ ok: false, error: "Booking not found." });
  });

  it("only opens the window shortly before the slot, and closes it at the end", () => {
    const court = gym(5, "Window Gym");
    const booking = bookRunningNow(court.id, "0150000201", 18);
    if (!booking.ok) return;
    const token = booking.booking.checkInToken!;
    const date = booking.booking.date;

    // far too early
    vi.setSystemTime(new Date(`${date}T12:00:00+08:00`));
    expect(checkInByToken(token)).toMatchObject({
      ok: false,
      error: expect.stringContaining(`${CHECK_IN_OPENS_MINUTES_BEFORE} minutes`),
    });

    // once the window opens, an early arrival is fine
    vi.setSystemTime(new Date(`${date}T17:30:00+08:00`));
    expect(checkInByToken(token)).toMatchObject({ ok: true });
  });

  it("refuses once the booking has ended", () => {
    const court = gym(5, "Ended Gym");
    const booking = bookRunningNow(court.id, "0150000301", 8);
    if (!booking.ok) return;

    vi.setSystemTime(new Date(`${booking.booking.date}T22:00:00+08:00`));
    expect(checkInByToken(booking.booking.checkInToken!)).toMatchObject({
      ok: false,
      error: "This booking has already ended.",
    });
  });

  it("applies the same window to staff check-in at the desk", () => {
    const court = gym(5, "Desk Window Gym");
    const booking = bookRunningNow(court.id, "0150000401", 19);
    if (!booking.ok) return;

    vi.setSystemTime(new Date(`${booking.booking.date}T09:00:00+08:00`));
    expect(checkIn(booking.booking.code)).toMatchObject({
      ok: false,
      error: expect.stringContaining("Check-in opens"),
    });
  });
});
