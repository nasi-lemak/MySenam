import { afterEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import {
  adminCancelBooking,
  cancelBooking,
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

const VENUE = async () => (await listVenues())[0];

let seq = 0;

async function fleet(deposit: number, capacity = 4) {
  const created = await createCourt({
    venueId: (await VENUE()).id,
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
async function bookRunningNow(courtId: number, phone: string, hour = 12) {
  vi.useRealTimers();
  const date = todayISO();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${date}T${String(hour - 1).padStart(2, "0")}:30:00+08:00`));
  const booking = await createBooking({ courtId, date, hours: [hour], name: "Paddler", phone });
  vi.setSystemTime(new Date(`${date}T${String(hour).padStart(2, "0")}:15:00+08:00`));
  if (!booking.ok) throw new Error(booking.error);
  return booking.booking;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("taking kit out", () => {
  it("holds the court's deposit and checks the customer in", async () => {
    const court = await fleet(50);
    const booking = await bookRunningNow(court.id, "0150000001");
    expect(booking.checkedInAt).toBeNull();

    const out = await takeHire(booking.code);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.hire.deposit).toBe(50);
    expect(out.hire.returnedAt).toBeNull();
    // Handing the kayak over is also the arrival at the desk.
    expect(out.booking.checkedInAt).not.toBeNull();
    expect(await hasOpenHire(booking.id)).toBe(true);
  });

  it("accepts an override, including a waiver, but not a silly one", async () => {
    const court = await fleet(50, 8);
    const waived = await takeHire((await bookRunningNow(court.id, "0150000002")).code, 0);
    expect(waived.ok).toBe(true);
    if (waived.ok) expect(waived.hire.deposit).toBe(0);

    const smaller = await takeHire((await bookRunningNow(court.id, "0150000003")).code, 20);
    expect(smaller.ok).toBe(true);
    if (smaller.ok) expect(smaller.hire.deposit).toBe(20);

    const silly = await takeHire((await bookRunningNow(court.id, "0150000004")).code, MAX_DEPOSIT + 1);
    expect(silly).toEqual({ ok: false, error: `A deposit cannot be more than RM${MAX_DEPOSIT}.` });
    const fractional = await takeHire((await bookRunningNow(court.id, "0150000005")).code, 12.505);
    expect(fractional.ok).toBe(false);
    const negative = await takeHire((await bookRunningNow(court.id, "0150000006")).code, -10);
    expect(negative.ok).toBe(false);
  });

  it("refuses a resource that is not hired out", async () => {
    const court = await fleet(0);
    const booking = await bookRunningNow(court.id, "0150000007");
    const out = await takeHire(booking.code);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("not hired out");
  });

  it("refuses a second deposit on the same booking", async () => {
    const court = await fleet(50);
    const booking = await bookRunningNow(court.id, "0150000008");
    expect((await takeHire(booking.code)).ok).toBe(true);
    const again = await takeHire(booking.code);
    expect(again).toEqual({ ok: false, error: "A deposit is already held on this booking." });
  });

  it("will not hand kit over before the slot, or to a cancelled booking", async () => {
    vi.useRealTimers();
    const court = await fleet(50);
    const date = todayISO();
    const later = await createBooking({
      courtId: court.id,
      date,
      hours: [23],
      name: "Early",
      phone: "0150000009",
    });
    // The venue may close before 23:00, in which case there is nothing to test.
    if (later.ok) {
      const early = await takeHire(later.booking.code);
      expect(early.ok).toBe(false);
      if (!early.ok) expect(early.error).toContain("Check-in opens");
    }

    const booking = await bookRunningNow(court.id, "0150000010");
    expect((await adminCancelBooking(booking.code)).ok).toBe(true);
    const gone = await takeHire(booking.code);
    expect(gone).toEqual({
      ok: false,
      error: "This booking was cancelled.",
      code: "BOOKING_WAS_CANCELLED",
    });
  });
});

describe("taking kit back", () => {
  it("settles a clean return and checks the customer out", async () => {
    const court = await fleet(50);
    const booking = await bookRunningNow(court.id, "0150000011");
    await takeHire(booking.code);

    const back = await returnHire(booking.code, { condition: "ok" });
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.hire.condition).toBe("ok");
    expect(back.hire.withheld).toBe(0);
    expect(back.hire.returnedAt).not.toBeNull();
    expect(back.booking.checkedOutAt).not.toBeNull();
    expect(await hasOpenHire(booking.id)).toBe(false);
  });

  it("records damage with a note and keeps back part of the deposit", async () => {
    const court = await fleet(50);
    const booking = await bookRunningNow(court.id, "0150000012");
    await takeHire(booking.code);

    const back = await returnHire(booking.code, {
      condition: "damaged",
      withheld: 30,
      note: "Cracked hull near the bow seat.",
    });
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.hire.withheld).toBe(30);
    expect(back.hire.note).toBe("Cracked hull near the bow seat.");
    expect((await hireFor(booking.id))?.condition).toBe("damaged");
  });

  it("never keeps back more than it held", async () => {
    const court = await fleet(50);
    const booking = await bookRunningNow(court.id, "0150000013");
    await takeHire(booking.code, 20);

    const over = await returnHire(booking.code, {
      condition: "lost",
      withheld: 200,
      note: "Never came back.",
    });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toContain("RM20 is held");
    // The hire is still open, so the desk can settle it properly.
    expect(await hasOpenHire(booking.id)).toBe(true);
  });

  it("insists on a note whenever money is kept back or the kit is not fine", async () => {
    const court = await fleet(50);
    const damaged = await bookRunningNow(court.id, "0150000014");
    await takeHire(damaged.code);
    const bare = await returnHire(damaged.code, { condition: "damaged" });
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.error).toContain("note is required");

    const kept = await bookRunningNow(court.id, "0150000015");
    await takeHire(kept.code);
    const quiet = await returnHire(kept.code, { condition: "ok", withheld: 10 });
    expect(quiet.ok).toBe(false);
  });

  it("refuses a return that was never taken, and a second return", async () => {
    const court = await fleet(50);
    const booking = await bookRunningNow(court.id, "0150000016");
    const never = await returnHire(booking.code, { condition: "ok" });
    expect(never).toEqual({ ok: false, error: "No deposit is held on this booking." });

    await takeHire(booking.code);
    expect((await returnHire(booking.code, { condition: "ok" })).ok).toBe(true);
    const twice = await returnHire(booking.code, { condition: "ok" });
    expect(twice).toEqual({ ok: false, error: "This kit has already been taken back." });
    expect((await takeHire(booking.code)).ok).toBe(false);
  });
});

describe("kit that is still out", () => {
  it("blocks cancelling and moving until it comes back", async () => {
    const court = await fleet(50);
    const other = await fleet(50);
    const booking = await bookRunningNow(court.id, "0150000017");
    await takeHire(booking.code);

    const byStaff = await adminCancelBooking(booking.code);
    expect(byStaff.ok).toBe(false);
    if (!byStaff.ok) expect(byStaff.error).toContain("still out");

    const byCustomer = await cancelBooking(booking.code, "0150000017");
    expect(byCustomer.ok).toBe(false);

    const moved = await moveBooking(booking.code, other.id);
    expect(moved.ok).toBe(false);
    if (!moved.ok) expect(moved.error).toContain("still out");

    await returnHire(booking.code, { condition: "ok" });
    expect((await adminCancelBooking(booking.code)).ok).toBe(true);
  });

  it("lists what a venue has out, oldest first, and drops it on return", async () => {
    const court = await fleet(50);
    const first = await bookRunningNow(court.id, "0150000018", 12);
    const second = await bookRunningNow(court.id, "0150000019", 12);
    await takeHire(first.code);
    await takeHire(second.code);

    const out = (await listOpenHires((await VENUE()).id)).filter((h) => h.courtId === court.id);
    expect(out.map((h) => h.bookingCode)).toEqual([first.code, second.code]);
    expect(out[0].name).toBe("Paddler");
    expect(out[0].courtName).toBe(court.name);

    await returnHire(first.code, { condition: "ok" });
    const left = (await listOpenHires((await VENUE()).id)).filter((h) => h.courtId === court.id);
    expect(left.map((h) => h.bookingCode)).toEqual([second.code]);
  });

  it("will not let a venue switch off a deposit while kit is out", async () => {
    const court = await fleet(50);
    const booking = await bookRunningNow(court.id, "0150000020");
    await takeHire(booking.code);

    const off = await updateCourt(court.id, { deposit: 0 });
    expect(off.ok).toBe(false);
    if (!off.ok) expect(off.error).toContain("still out");

    // Changing the figure for future hires is fine.
    const changed = await updateCourt(court.id, { deposit: 80 });
    expect(changed.ok).toBe(true);
    if (changed.ok) expect(changed.court.deposit).toBe(80);
    // The hold already taken is untouched by that.
    expect((await hireFor(booking.id))?.deposit).toBe(50);

    await returnHire(booking.code, { condition: "ok" });
    expect((await updateCourt(court.id, { deposit: 0 })).ok).toBe(true);
  });
});

describe("money kept back from a deposit", () => {
  const db = async () => (await import("../src/lib/db")).getDb();

  it("is a receipted sale in the takings and the books, untaxed as compensation unless the venue says it is a charge", async () => {
    const { setVenueTax } = await import("../src/lib/tax");
    const { salesJournal } = await import("../src/lib/accounting");
    const venue = await VENUE();
    expect((await setVenueTax(venue.id, { registered: true, name: "SST", rate: 8, regNo: "W10-1808-31000001" })).ok).toBe(true);
    try {
      const court = await fleet(80);
      const damaged = await bookRunningNow(court.id, "0150000091");
      expect((await takeHire(damaged.code)).ok).toBe(true);
      const charged = await bookRunningNow(court.id, "0150000092", 13);
      expect((await takeHire(charged.code)).ok).toBe(true);

      // Two returns of the same kit at once keep the deposit once. On a real
      // server one of them is run again after a short, real wait: a frozen
      // clock would hold it there.
      vi.useRealTimers();
      const [a, b] = await Promise.all([
        returnHire(damaged.code, { condition: "damaged", withheld: 30, note: "Cracked paddle blade", via: "card" }),
        returnHire(damaged.code, { condition: "damaged", withheld: 30, note: "Cracked paddle blade", via: "card" }),
      ]);
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
      expect((await returnHire(charged.code, { condition: "ok", withheld: 10, note: "Late back by an hour", taxable: true })).ok).toBe(true);

      const sales = (await (await db())
        .prepare(
          `SELECT s.total::float AS total, s.paid_via, r.tax_amount::float AS tax, r.total::float AS receipt
             FROM counter_sales s JOIN hire_records h ON h.id = s.hire_record_id JOIN bookings b ON b.id = h.booking_id
             JOIN receipts r ON r.source = 'sale:' || s.id WHERE b.code IN (?, ?) ORDER BY s.id`
        )
        .all(damaged.code, charged.code)) as { total: number; paid_via: string; tax: number; receipt: number }[];
      expect(sales).toEqual([
        { total: 30, paid_via: "card", tax: 0, receipt: 30 },
        { total: 10, paid_via: "cash", tax: expect.closeTo(0.74, 2), receipt: 10 },
      ]);
      // Deposit held, kept and given back add up.
      const hire = await hireFor(damaged.id);
      expect(hire).toMatchObject({ deposit: 80, withheld: 30 });

      const today = todayISO();
      const kept = (await salesJournal(venue.id, today, today)).filter(
        (r) => r.category === "Hire deposits kept" && (r.description.includes(damaged.code) || r.description.includes(charged.code))
      );
      expect(kept.map((r) => r.gross).sort()).toEqual([10, 30]);
      expect(kept.every((r) => r.revenue)).toBe(true);
    } finally {
      await setVenueTax(venue.id, { registered: false });
    }
  });

  it("is not a sale when nothing is kept", async () => {
    const court = await fleet(40);
    const fine = await bookRunningNow(court.id, "0150000093", 14);
    expect((await takeHire(fine.code)).ok).toBe(true);
    expect((await returnHire(fine.code, { condition: "ok" })).ok).toBe(true);
    const n = (await (await db())
      .prepare("SELECT COUNT(*)::int AS n FROM counter_sales s JOIN hire_records h ON h.id = s.hire_record_id JOIN bookings b ON b.id = h.booking_id WHERE b.code = ?")
      .get(fine.code)) as { n: number };
    expect(n.n).toBe(0);
  });
});
