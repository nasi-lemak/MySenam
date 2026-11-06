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

    const out = await takeHire(booking.code, undefined, "cash");
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

    const smaller = await takeHire((await bookRunningNow(court.id, "0150000003")).code, 20, "cash");
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
    const out = await takeHire(booking.code, undefined, "cash");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("not hired out");
  });

  it("refuses a second deposit on the same booking", async () => {
    const court = await fleet(50);
    const booking = await bookRunningNow(court.id, "0150000008");
    expect((await takeHire(booking.code, undefined, "cash")).ok).toBe(true);
    const again = await takeHire(booking.code, undefined, "cash");
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
      const early = await takeHire(later.booking.code, undefined, "cash");
      expect(early.ok).toBe(false);
      if (!early.ok) expect(early.error).toContain("Check-in opens");
    }

    const booking = await bookRunningNow(court.id, "0150000010");
    expect((await adminCancelBooking(booking.code)).ok).toBe(true);
    const gone = await takeHire(booking.code, undefined, "cash");
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
    await takeHire(booking.code, undefined, "cash");

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
    await takeHire(booking.code, undefined, "cash");

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
    await takeHire(booking.code, 20, "cash");

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
    await takeHire(damaged.code, undefined, "cash");
    const bare = await returnHire(damaged.code, { condition: "damaged" });
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.error).toContain("note is required");

    const kept = await bookRunningNow(court.id, "0150000015");
    await takeHire(kept.code, undefined, "cash");
    const quiet = await returnHire(kept.code, { condition: "ok", withheld: 10 });
    expect(quiet.ok).toBe(false);
  });

  it("refuses a return that was never taken, and a second return", async () => {
    const court = await fleet(50);
    const booking = await bookRunningNow(court.id, "0150000016");
    const never = await returnHire(booking.code, { condition: "ok" });
    expect(never).toEqual({ ok: false, error: "No deposit is held on this booking." });

    await takeHire(booking.code, undefined, "cash");
    expect((await returnHire(booking.code, { condition: "ok" })).ok).toBe(true);
    const twice = await returnHire(booking.code, { condition: "ok" });
    expect(twice).toEqual({ ok: false, error: "This kit has already been taken back." });
    expect((await takeHire(booking.code, undefined, "cash")).ok).toBe(false);
  });
});

describe("kit that is still out", () => {
  it("blocks cancelling and moving until it comes back", async () => {
    const court = await fleet(50);
    const other = await fleet(50);
    const booking = await bookRunningNow(court.id, "0150000017");
    await takeHire(booking.code, undefined, "cash");

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
    await takeHire(first.code, undefined, "cash");
    await takeHire(second.code, undefined, "cash");

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
    await takeHire(booking.code, undefined, "cash");

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

  it("is a receipted sale per reason, taxed by its nature at the venue, under its own heading in the books", async () => {
    const { setVenueTax } = await import("../src/lib/tax");
    const { salesJournal } = await import("../src/lib/accounting");
    const venue = await VENUE();
    expect((await setVenueTax(venue.id, { registered: true, name: "SST", rate: 8, regNo: "W10-1808-31000001" })).ok).toBe(true);
    try {
      const court = await fleet(80);
      const damaged = await bookRunningNow(court.id, "0150000091");
      expect((await takeHire(damaged.code, undefined, "card")).ok).toBe(true);
      const charged = await bookRunningNow(court.id, "0150000092", 13);
      expect((await takeHire(charged.code, undefined, "cash")).ok).toBe(true);

      // Two returns of the same kit at once keep the deposit once. On a real
      // server one of them is run again after a short, real wait: a frozen
      // clock would hold it there.
      vi.useRealTimers();
      const damage = { condition: "damaged" as const, deductions: [{ reason: "damage", amount: 30 }], note: "Cracked paddle blade", via: "card" as const };
      const [a, b] = await Promise.all([returnHire(damaged.code, damage), returnHire(damaged.code, damage)]);
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
      // Back an hour late, and muddy: more hire, and cleaning.
      expect(
        (await returnHire(charged.code, {
          condition: "ok",
          deductions: [
            { reason: "late_return", amount: 10 },
            { reason: "cleaning", amount: 5 },
          ],
          note: "Back an hour late, covered in mud",
        })).ok
      ).toBe(true);

      const sales = (await (await db())
        .prepare(
          `SELECT s.hire_reason AS reason, s.total::float AS total, s.paid_via, r.tax_amount::float AS tax, r.note
             FROM counter_sales s JOIN hire_records h ON h.id = s.hire_record_id JOIN bookings b ON b.id = h.booking_id
             JOIN receipts r ON r.source = 'sale:' || s.id WHERE b.code IN (?, ?) ORDER BY s.id`
        )
        .all(damaged.code, charged.code)) as { reason: string; total: number; paid_via: string; tax: number; note: string | null }[];
      expect(sales).toEqual([
        // Compensation: no tax, and the receipt says it is not a charge for a service.
        { reason: "damage", total: 30, paid_via: "card", tax: 0, note: expect.stringContaining("compensation for damage") },
        // Charges for something the venue supplies: its tax, inside the amount.
        { reason: "late_return", total: 10, paid_via: "cash", tax: expect.closeTo(0.74, 2), note: null },
        { reason: "cleaning", total: 5, paid_via: "cash", tax: expect.closeTo(0.37, 2), note: null },
      ]);
      // Deposit held, kept and given back add up.
      expect(await hireFor(damaged.id)).toMatchObject({ deposit: 80, withheld: 30 });
      expect(await hireFor(charged.id)).toMatchObject({ deposit: 80, withheld: 15 });

      const today = todayISO();
      const journal = (await salesJournal(venue.id, today, today)).filter((r) => r.description.includes(damaged.code) || r.description.includes(charged.code));
      expect(journal.map((r) => [r.category, r.gross]).sort()).toEqual([
        ["Hire: damage and loss", 30],
        ["Hire: extra charges", 10],
        ["Hire: extra charges", 5],
      ]);
      expect(journal.every((r) => r.revenue)).toBe(true);
    } finally {
      await setVenueTax(venue.id, { registered: false });
    }
  });

  it("follows the venue's own choice of which reasons carry its tax, and marks the usual untaxed ones for review", async () => {
    const { setVenueTax } = await import("../src/lib/tax");
    const { deductionTreatments, setDeductionTreatments } = await import("../src/lib/deposit-deductions");
    const venue = await VENUE();
    const usual = await deductionTreatments(venue.id);
    expect(usual.find((t) => t.reason === "damage")).toMatchObject({ taxed: false, usual: true, review: true });
    expect(usual.find((t) => t.reason === "cleaning")).toMatchObject({ taxed: true, usual: true, review: false });
    expect(usual.find((t) => t.reason === "penalty")).toMatchObject({ taxed: false, review: true });

    // The venue's accountant says cleaning is not taxed here, and this "other" is.
    expect((await setDeductionTreatments(venue.id, { cleaning: false, other: true })).ok).toBe(true);
    expect((await setDeductionTreatments(venue.id, { nonsense: true })).ok).toBe(false);
    expect((await setVenueTax(venue.id, { registered: true, name: "SST", rate: 8, regNo: "W10-1808-31000001" })).ok).toBe(true);
    try {
      const court = await fleet(50);
      const booking = await bookRunningNow(court.id, "0150000094", 15);
      expect((await takeHire(booking.code, undefined, "cash")).ok).toBe(true);
      expect(
        (await returnHire(booking.code, {
          condition: "ok",
          deductions: [
            { reason: "cleaning", amount: 5 },
            { reason: "other", amount: 4 },
          ],
          note: "Cleaning, and the lost locker key",
        })).ok
      ).toBe(true);
      const taxes = (await (await db())
        .prepare(
          `SELECT s.hire_reason AS reason, r.tax_amount::float AS tax FROM counter_sales s JOIN hire_records h ON h.id = s.hire_record_id
             JOIN bookings b ON b.id = h.booking_id JOIN receipts r ON r.source = 'sale:' || s.id WHERE b.code = ? ORDER BY s.id`
        )
        .all(booking.code)) as { reason: string; tax: number }[];
      expect(taxes).toEqual([
        { reason: "cleaning", tax: 0 },
        { reason: "other", tax: expect.closeTo(0.3, 2) },
      ]);
      // Back to the country's usual.
      const reset = await setDeductionTreatments(venue.id, { cleaning: null, other: null });
      expect(reset.ok && reset.treatments.every((t) => t.usual)).toBe(true);
    } finally {
      await setVenueTax(venue.id, { registered: false });
    }
  });

  it("is provisional until the venue records an adviser's review; a change needs reviewing again; each sale and the journal say on what footing it was taxed", async () => {
    const { approveDeductionTreatments, deductionHistory, deductionReview, deductionTreatments, setDeductionTreatments } = await import("../src/lib/deposit-deductions");
    const { journalCsv } = await import("../src/lib/accounting");
    const venue = await VENUE();
    const { ensureBootstrapAdmin, listAdmins } = await import("../src/lib/admin-auth");
    await ensureBootstrapAdmin();
    const manager = { id: (await listAdmins())[0].id, name: "Manager" };
    expect(await deductionReview(venue.id)).toBeNull();
    expect((await deductionTreatments(venue.id)).every((t) => t.basis === "provisional")).toBe(true);

    const keep = async (phone: string, hour: number) => {
      const court = await fleet(40);
      const booking = await bookRunningNow(court.id, phone, hour);
      expect((await takeHire(booking.code, undefined, "cash")).ok).toBe(true);
      expect((await returnHire(booking.code, { condition: "damaged", deductions: [{ reason: "damage", amount: 10 }], note: "Cracked hull" })).ok).toBe(true);
      return ((await (await db())
        .prepare("SELECT s.tax_basis FROM counter_sales s JOIN hire_records h ON h.id = s.hire_record_id JOIN bookings b ON b.id = h.booking_id WHERE b.code = ?")
        .get(booking.code)) as { tax_basis: string }).tax_basis;
    };
    expect(await keep("0150000201", 16)).toBe("provisional");

    // Reviewed: needs a named adviser; then every reason is on a reviewed footing.
    expect(await approveDeductionTreatments(venue.id, "x", manager)).toMatchObject({ ok: false });
    const approved = await approveDeductionTreatments(venue.id, "Lim Mei Ling, LML Tax Advisory", manager);
    if (!approved.ok) throw new Error(approved.error);
    expect((await deductionTreatments(venue.id)).every((t) => t.basis === "reviewed" && !t.review)).toBe(true);
    expect(await keep("0150000202", 17)).toBe("reviewed");

    // A change lapses the review, and is kept in the record with who made it.
    expect((await setDeductionTreatments(venue.id, { penalty: true }, manager)).ok).toBe(true);
    expect(await deductionReview(venue.id)).toBeNull();
    expect((await deductionTreatments(venue.id)).find((t) => t.reason === "penalty")!.basis).toBe("venue");
    expect((await deductionTreatments(venue.id)).find((t) => t.reason === "damage")!.basis).toBe("provisional");
    const history = await deductionHistory(venue.id);
    expect(history.slice(0, 2)).toEqual([
      expect.objectContaining({ kind: "changed", changed: { penalty: true }, adminName: "Manager" }),
      expect.objectContaining({ kind: "approved", reviewer: "Lim Mei Ling, LML Tax Advisory" }),
    ]);
    await setDeductionTreatments(venue.id, { penalty: null }, manager);

    // The journal says which footing each amount kept was taxed on.
    const csv = await journalCsv(venue.id, todayISO(), todayISO());
    expect(csv.split(/\r?\n/)[0]).toMatch(/"Tax basis","Test booking"$/);
    expect(csv).toContain("Provisional default, not reviewed");
    expect(csv).toContain("Reviewed by the venue's adviser");
  });

  it("refuses what does not add up or says no reason; the older single amount takes its reason from the condition", async () => {
    const court = await fleet(40);
    const booking = await bookRunningNow(court.id, "0150000095", 16);
    expect((await takeHire(booking.code, undefined, "cash")).ok).toBe(true);
    const note = "Scratched";
    expect(await returnHire(booking.code, { condition: "damaged", deductions: [{ reason: "wear", amount: 5 }], note })).toMatchObject({ ok: false });
    expect(
      await returnHire(booking.code, {
        condition: "damaged",
        deductions: [
          { reason: "damage", amount: 5 },
          { reason: "damage", amount: 5 },
        ],
        note,
      })
    ).toMatchObject({ ok: false });
    expect(
      await returnHire(booking.code, {
        condition: "damaged",
        deductions: [
          { reason: "damage", amount: 30 },
          { reason: "cleaning", amount: 20 },
        ],
        note,
      })
    ).toMatchObject({ ok: false, error: expect.stringContaining("cannot be kept back") });
    expect((await returnHire(booking.code, { condition: "damaged", withheld: 12, note })).ok).toBe(true);
    const reason = (await (await db())
      .prepare("SELECT s.hire_reason FROM counter_sales s JOIN hire_records h ON h.id = s.hire_record_id JOIN bookings b ON b.id = h.booking_id WHERE b.code = ?")
      .get(booking.code)) as { hire_reason: string };
    expect(reason.hire_reason).toBe("damage");
  });

  it("is not a sale when nothing is kept", async () => {
    const court = await fleet(40);
    const fine = await bookRunningNow(court.id, "0150000093", 14);
    expect((await takeHire(fine.code, undefined, "cash")).ok).toBe(true);
    expect((await returnHire(fine.code, { condition: "ok" })).ok).toBe(true);
    const n = (await (await db())
      .prepare("SELECT COUNT(*)::int AS n FROM counter_sales s JOIN hire_records h ON h.id = s.hire_record_id JOIN bookings b ON b.id = h.booking_id WHERE b.code = ?")
      .get(fine.code)) as { n: number };
    expect(n.n).toBe(0);
  });
});
