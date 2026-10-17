import { afterEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

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

const VENUE = async () => (await listVenues())[0];

async function gym(capacity: number, name: string) {
  const created = await createCourt({
    venueId: (await VENUE()).id,
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
async function bookRunningNow(courtId: number, phone: string, hour = 12) {
  vi.useRealTimers();
  const date = todayISO();
  vi.useFakeTimers();
  // just before the slot, so booking is allowed
  vi.setSystemTime(new Date(`${date}T${String(hour - 1).padStart(2, "0")}:30:00+08:00`));
  const booking = await createBooking({ courtId, date, hours: [hour], name: "P", phone });
  // now inside the slot
  vi.setSystemTime(new Date(`${date}T${String(hour).padStart(2, "0")}:15:00+08:00`));
  return booking;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("check-in", () => {
  it("records an arrival once and refuses repeats, unknown and cancelled bookings", async () => {
    const court = await gym(5, "Checkin Gym");
    const booking = await bookRunningNow(court.id, "0140000001");
    expect(booking.ok).toBe(true);
    if (!booking.ok) return;
    expect(booking.booking.checkedInAt).toBeNull();

    const arrived = await checkIn(booking.booking.code);
    expect(arrived.ok).toBe(true);
    if (!arrived.ok) return;
    expect(arrived.booking.checkedInAt).toBeTruthy();
    expect(arrived.booking.checkedOutAt).toBeNull();

    expect(await checkIn(booking.booking.code)).toMatchObject({
      ok: false,
      error: "Already checked in.",
    });
    expect(await checkIn("MS-NOSUCH")).toMatchObject({ ok: false, error: "Booking not found." });

    const other = await bookRunningNow(court.id, "0140000002", 13);
    if (!other.ok) return;
    await adminCancelBooking(other.booking.code);
    expect(await checkIn(other.booking.code)).toMatchObject({
      ok: false,
      error: expect.stringContaining("cancelled"),
    });
  });

  it("checks out only after checking in", async () => {
    const court = await gym(5, "Checkout Gym");
    const booking = await bookRunningNow(court.id, "0140000101");
    if (!booking.ok) return;

    expect(await checkOut(booking.booking.code)).toMatchObject({
      ok: false,
      error: expect.stringContaining("not checked in"),
    });
    await checkIn(booking.booking.code);
    const left = await checkOut(booking.booking.code);
    expect(left.ok).toBe(true);
    if (!left.ok) return;
    expect(left.booking.checkedOutAt).toBeTruthy();
    expect(await checkOut(booking.booking.code)).toMatchObject({
      ok: false,
      error: "Already checked out.",
    });
  });

  it("is incompatible with a no-show in both directions", async () => {
    const court = await gym(5, "Attendance Gym");
    const booking = await bookRunningNow(court.id, "0140000201");
    if (!booking.ok) return;
    await checkIn(booking.booking.code);

    // the slot has passed, but they demonstrably turned up
    vi.setSystemTime(new Date(`${todayISO()}T23:00:00+08:00`));
    expect(await setNoShow(booking.booking.code, true)).toMatchObject({
      ok: false,
      error: expect.stringContaining("checked in"),
    });
  });

  it("clears a stale no-show flag when the customer turns up late", async () => {
    const court = await gym(5, "Late Gym");
    const booking = await bookRunningNow(court.id, "0140000301", 9);
    if (!booking.ok) return;

    // desk gives up on them
    vi.setSystemTime(new Date(`${todayISO()}T09:50:00+08:00`));
    expect(await setNoShow(booking.booking.code, true)).toMatchObject({ ok: true });

    // then they walk in
    const arrived = await checkIn(booking.booking.code);
    expect(arrived.ok).toBe(true);
    if (!arrived.ok) return;
    expect(arrived.booking.noShow).toBe(false);
  });

  it("surfaces check-in times on the day list", async () => {
    const court = await gym(5, "List Gym");
    const booking = await bookRunningNow(court.id, "0140000401", 14);
    if (!booking.ok) return;
    await checkIn(booking.booking.code);

    const row = (await listBookingsForDate(booking.booking.date)).find(
      (r) => r.code === booking.booking.code
    );
    expect(row?.checkedInAt).toBeTruthy();
    expect(row?.checkedOutAt).toBeNull();
  });
});

describe("live occupancy", () => {
  it("counts people inside now, and stops counting them once they leave", async () => {
    const court = await gym(10, "Live Gym");
    const venueId = (await VENUE()).id;

    const a = await bookRunningNow(court.id, "0140000501", 16);
    const b = await bookRunningNow(court.id, "0140000502", 16);
    if (!a.ok || !b.ok) return;

    const idle = (await getLiveOccupancy(venueId)).find((o) => o.courtId === court.id)!;
    expect(idle).toMatchObject({ present: 0, capacity: 10, level: "quiet" });

    await checkIn(a.booking.code);
    await checkIn(b.booking.code);
    const busy = (await getLiveOccupancy(venueId)).find((o) => o.courtId === court.id)!;
    expect(busy.present).toBe(2);

    await checkOut(a.booking.code);
    expect((await getLiveOccupancy(venueId)).find((o) => o.courtId === court.id)!.present).toBe(1);
  });

  it("stops counting someone whose booking has ended even without a check-out", async () => {
    const court = await gym(10, "Expiry Gym");
    const venueId = (await VENUE()).id;
    const booking = await bookRunningNow(court.id, "0140000601", 10);
    if (!booking.ok) return;
    await checkIn(booking.booking.code);
    expect((await getLiveOccupancy(venueId)).find((o) => o.courtId === court.id)!.present).toBe(1);

    // the 10:00–11:00 slot is over; they are assumed to have left
    vi.setSystemTime(new Date(`${todayISO()}T11:30:00+08:00`));
    expect((await getLiveOccupancy(venueId)).find((o) => o.courtId === court.id)!.present).toBe(0);
  });

  it("reports a busyness level that tracks how full the room is", async () => {
    const court = await gym(4, "Level Gym");
    const venueId = (await VENUE()).id;
    const level = async () => (await getLiveOccupancy(venueId)).find((o) => o.courtId === court.id)!.level;

    const people = [];
    for (const i of [1, 2, 3, 4]) people.push(await bookRunningNow(court.id, `014000070${i}`, 20));
    expect(await level()).toBe("quiet");

    for (const [i, p] of people.entries()) {
      if (!p.ok) continue;
      await checkIn(p.booking.code);
      if (i === 0) expect(await level()).toBe("quiet"); // 1/4
      if (i === 1) expect(await level()).toBe("filling"); // 2/4
      if (i === 2) expect(await level()).toBe("busy"); // 3/4
      if (i === 3) expect(await level()).toBe("full"); // 4/4
    }
  });
});

describe("self-service check-in by QR token", () => {
  it("issues a distinct secret token with every booking", async () => {
    const court = await gym(5, "Token Gym");
    const a = await bookRunningNow(court.id, "0150000001", 15);
    const b = await bookRunningNow(court.id, "0150000002", 15);
    if (!a.ok || !b.ok) return;

    expect(a.booking.checkInToken).toMatch(/^[a-f0-9]{32}$/);
    expect(b.booking.checkInToken).toMatch(/^[a-f0-9]{32}$/);
    expect(a.booking.checkInToken).not.toBe(b.booking.checkInToken);
  });

  it("checks the holder in, and rejects an unknown or empty token", async () => {
    const court = await gym(5, "Scan Gym");
    const booking = await bookRunningNow(court.id, "0150000101", 16);
    if (!booking.ok) return;

    const scanned = await checkInByToken(booking.booking.checkInToken!);
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(scanned.booking.code).toBe(booking.booking.code);
    expect(scanned.booking.checkedInAt).toBeTruthy();

    // scanning twice is refused, as at the desk
    expect(await checkInByToken(booking.booking.checkInToken!)).toMatchObject({
      ok: false,
      error: "Already checked in.",
    });
    expect(await checkInByToken("f".repeat(32))).toMatchObject({
      ok: false,
      error: "Booking not found.",
    });
    expect(await checkInByToken("  ")).toMatchObject({ ok: false, error: "Booking not found." });
  });

  it("only opens the window shortly before the slot, and closes it at the end", async () => {
    const court = await gym(5, "Window Gym");
    const booking = await bookRunningNow(court.id, "0150000201", 18);
    if (!booking.ok) return;
    const token = booking.booking.checkInToken!;
    const date = booking.booking.date;

    // far too early
    vi.setSystemTime(new Date(`${date}T12:00:00+08:00`));
    expect(await checkInByToken(token)).toMatchObject({
      ok: false,
      error: expect.stringContaining(`${CHECK_IN_OPENS_MINUTES_BEFORE} minutes`),
    });

    // once the window opens, an early arrival is fine
    vi.setSystemTime(new Date(`${date}T17:30:00+08:00`));
    expect(await checkInByToken(token)).toMatchObject({ ok: true });
  });

  it("refuses once the booking has ended", async () => {
    const court = await gym(5, "Ended Gym");
    const booking = await bookRunningNow(court.id, "0150000301", 8);
    if (!booking.ok) return;

    vi.setSystemTime(new Date(`${booking.booking.date}T22:00:00+08:00`));
    expect(await checkInByToken(booking.booking.checkInToken!)).toMatchObject({
      ok: false,
      error: "This booking has already ended.",
    });
  });

  it("applies the same window to staff check-in at the desk", async () => {
    const court = await gym(5, "Desk Window Gym");
    const booking = await bookRunningNow(court.id, "0150000401", 19);
    if (!booking.ok) return;

    vi.setSystemTime(new Date(`${booking.booking.date}T09:00:00+08:00`));
    expect(await checkIn(booking.booking.code)).toMatchObject({
      ok: false,
      error: expect.stringContaining("Check-in opens"),
    });
  });
});
