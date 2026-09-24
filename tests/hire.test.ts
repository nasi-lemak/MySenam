import { afterEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import {
  adminCancelBooking,
  cancelBooking,
  checkIn,
  createBooking,
  createCourt,
  hasOpenHire,
  hireFor,
  listOpenHires,
  listVenues,
  moveBooking,
  returnHire,
  takeHire,
  updateCourt,
} from "../src/lib/store";
import { todayISO } from "../src/lib/time";
import { MAX_DEPOSIT } from "../src/lib/types";

const VENUE = () => listVenues()[0];

let seq = 0;

function fleet(deposit: number, capacity = 4) {
  const created = createCourt({
    venueId: VENUE().id,
    name: `Kayak Fleet ${++seq}`,
    sport: "kayak",
    offPeakRate: 15,
    peakRate: 20,
    capacity,
    deposit,
  });
  if (!created.ok) throw new Error(created.error);
  return created.court;
}

/** Book an hour today that is currently running, then freeze the clock in it. */
function bookRunningNow(courtId: number, phone: string, hour = 12) {
  vi.useRealTimers();
  const date = todayISO();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${date}T${String(hour - 1).padStart(2, "0")}:30:00+08:00`));
  const booking = createBooking({ courtId, date, hours: [hour], name: "Paddler", phone });
  vi.setSystemTime(new Date(`${date}T${String(hour).padStart(2, "0")}:15:00+08:00`));
  if (!booking.ok) throw new Error(booking.error);
  return booking.booking;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("taking kit out", () => {
  it("holds the court's deposit and checks the customer in", () => {
    const court = fleet(50);
    const booking = bookRunningNow(court.id, "0150000001");
    expect(booking.checkedInAt).toBeNull();

    const out = takeHire(booking.code);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.hire.deposit).toBe(50);
    expect(out.hire.returnedAt).toBeNull();
    // Handing the kayak over is also the arrival at the desk.
    expect(out.booking.checkedInAt).not.toBeNull();
    expect(hasOpenHire(booking.id)).toBe(true);
  });

  it("accepts an override, including a waiver, but not a silly one", () => {
    const court = fleet(50, 8);
    const waived = takeHire(bookRunningNow(court.id, "0150000002").code, 0);
    expect(waived.ok).toBe(true);
    if (waived.ok) expect(waived.hire.deposit).toBe(0);

    const smaller = takeHire(bookRunningNow(court.id, "0150000003").code, 20);
    expect(smaller.ok).toBe(true);
    if (smaller.ok) expect(smaller.hire.deposit).toBe(20);

    const silly = takeHire(bookRunningNow(court.id, "0150000004").code, MAX_DEPOSIT + 1);
    expect(silly).toEqual({ ok: false, error: `A deposit cannot be more than RM${MAX_DEPOSIT}.` });
    const fractional = takeHire(bookRunningNow(court.id, "0150000005").code, 12.5);
    expect(fractional.ok).toBe(false);
    const negative = takeHire(bookRunningNow(court.id, "0150000006").code, -10);
    expect(negative.ok).toBe(false);
  });

  it("refuses a resource that is not hired out", () => {
    const court = fleet(0);
    const booking = bookRunningNow(court.id, "0150000007");
    const out = takeHire(booking.code);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("not hired out");
  });

  it("refuses a second deposit on the same booking", () => {
    const court = fleet(50);
    const booking = bookRunningNow(court.id, "0150000008");
    expect(takeHire(booking.code).ok).toBe(true);
    const again = takeHire(booking.code);
    expect(again).toEqual({ ok: false, error: "A deposit is already held on this booking." });
  });

  it("will not hand kit over before the slot, or to a cancelled booking", () => {
    vi.useRealTimers();
    const court = fleet(50);
    const date = todayISO();
    const later = createBooking({
      courtId: court.id,
      date,
      hours: [23],
      name: "Early",
      phone: "0150000009",
    });
    // The venue may close before 23:00, in which case there is nothing to test.
    if (later.ok) {
      const early = takeHire(later.booking.code);
      expect(early.ok).toBe(false);
      if (!early.ok) expect(early.error).toContain("Check-in opens");
    }

    const booking = bookRunningNow(court.id, "0150000010");
    expect(adminCancelBooking(booking.code).ok).toBe(true);
    const gone = takeHire(booking.code);
    expect(gone).toEqual({ ok: false, error: "This booking was cancelled." });
  });
});

describe("taking kit back", () => {
  it("settles a clean return and checks the customer out", () => {
    const court = fleet(50);
    const booking = bookRunningNow(court.id, "0150000011");
    takeHire(booking.code);

    const back = returnHire(booking.code, { condition: "ok" });
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.hire.condition).toBe("ok");
    expect(back.hire.withheld).toBe(0);
    expect(back.hire.returnedAt).not.toBeNull();
    expect(back.booking.checkedOutAt).not.toBeNull();
    expect(hasOpenHire(booking.id)).toBe(false);
  });

  it("records damage with a note and keeps back part of the deposit", () => {
    const court = fleet(50);
    const booking = bookRunningNow(court.id, "0150000012");
    takeHire(booking.code);

    const back = returnHire(booking.code, {
      condition: "damaged",
      withheld: 30,
      note: "Cracked hull near the bow seat.",
    });
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.hire.withheld).toBe(30);
    expect(back.hire.note).toBe("Cracked hull near the bow seat.");
    expect(hireFor(booking.id)?.condition).toBe("damaged");
  });

  it("never keeps back more than it held", () => {
    const court = fleet(50);
    const booking = bookRunningNow(court.id, "0150000013");
    takeHire(booking.code, 20);

    const over = returnHire(booking.code, {
      condition: "lost",
      withheld: 200,
      note: "Never came back.",
    });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toContain("RM20 is held");
    // The hire is still open, so the desk can settle it properly.
    expect(hasOpenHire(booking.id)).toBe(true);
  });

  it("insists on a note whenever money is kept back or the kit is not fine", () => {
    const court = fleet(50);
    const damaged = bookRunningNow(court.id, "0150000014");
    takeHire(damaged.code);
    const bare = returnHire(damaged.code, { condition: "damaged" });
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.error).toContain("note is required");

    const kept = bookRunningNow(court.id, "0150000015");
    takeHire(kept.code);
    const quiet = returnHire(kept.code, { condition: "ok", withheld: 10 });
    expect(quiet.ok).toBe(false);
  });

  it("refuses a return that was never taken, and a second return", () => {
    const court = fleet(50);
    const booking = bookRunningNow(court.id, "0150000016");
    const never = returnHire(booking.code, { condition: "ok" });
    expect(never).toEqual({ ok: false, error: "No deposit is held on this booking." });

    takeHire(booking.code);
    expect(returnHire(booking.code, { condition: "ok" }).ok).toBe(true);
    const twice = returnHire(booking.code, { condition: "ok" });
    expect(twice).toEqual({ ok: false, error: "This kit has already been taken back." });
    expect(takeHire(booking.code).ok).toBe(false);
  });
});

describe("kit that is still out", () => {
  it("blocks cancelling and moving until it comes back", () => {
    const court = fleet(50);
    const other = fleet(50);
    const booking = bookRunningNow(court.id, "0150000017");
    takeHire(booking.code);

    const byStaff = adminCancelBooking(booking.code);
    expect(byStaff.ok).toBe(false);
    if (!byStaff.ok) expect(byStaff.error).toContain("still out");

    const byCustomer = cancelBooking(booking.code, "0150000017");
    expect(byCustomer.ok).toBe(false);

    const moved = moveBooking(booking.code, other.id);
    expect(moved.ok).toBe(false);
    if (!moved.ok) expect(moved.error).toContain("still out");

    returnHire(booking.code, { condition: "ok" });
    expect(adminCancelBooking(booking.code).ok).toBe(true);
  });

  it("lists what a venue has out, oldest first, and drops it on return", () => {
    const court = fleet(50);
    const first = bookRunningNow(court.id, "0150000018", 12);
    const second = bookRunningNow(court.id, "0150000019", 12);
    takeHire(first.code);
    takeHire(second.code);

    const out = listOpenHires(VENUE().id).filter((h) => h.courtId === court.id);
    expect(out.map((h) => h.bookingCode)).toEqual([first.code, second.code]);
    expect(out[0].name).toBe("Paddler");
    expect(out[0].courtName).toBe(court.name);

    returnHire(first.code, { condition: "ok" });
    const left = listOpenHires(VENUE().id).filter((h) => h.courtId === court.id);
    expect(left.map((h) => h.bookingCode)).toEqual([second.code]);
  });

  it("will not let a venue switch off a deposit while kit is out", () => {
    const court = fleet(50);
    const booking = bookRunningNow(court.id, "0150000020");
    takeHire(booking.code);

    const off = updateCourt(court.id, { deposit: 0 });
    expect(off.ok).toBe(false);
    if (!off.ok) expect(off.error).toContain("still out");

    // Changing the figure for future hires is fine.
    const changed = updateCourt(court.id, { deposit: 80 });
    expect(changed.ok).toBe(true);
    if (changed.ok) expect(changed.court.deposit).toBe(80);
    // The hold already taken is untouched by that.
    expect(hireFor(booking.id)?.deposit).toBe(50);

    returnHire(booking.code, { condition: "ok" });
    expect(updateCourt(court.id, { deposit: 0 }).ok).toBe(true);
  });
});
