import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { salesJournal, totals } from "../src/lib/accounting";
import { setCancelPolicy } from "../src/lib/cancel-policy";
import { getDb } from "../src/lib/db";
import { documentFor } from "../src/lib/documents";
import { venueReport } from "../src/lib/reports";
import { cancelBooking, createBooking, createCourt, createVenue, setPaymentStatus } from "../src/lib/store";
import { setVenueTax } from "../src/lib/tax";
import { addDays, todayISO } from "../src/lib/time";

/**
 * What a venue keeps of a booking cancelled late is takings (audit R8,
 * X3-6): the period report counts it in what was collected and its tax, from
 * the same receipt and credit notes as the sales journal, so the two agree;
 * and the tax on the fee kept is worked out on the fee itself.
 */

let venueId: number;
let courtId: number;
const today = todayISO();
const tomorrow = addDays(today, 1);

beforeAll(async () => {
  const v = await createVenue({ name: "Late Hall", area: "PJ", address: "1", phone: "0312345678" });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  await getDb().prepare("UPDATE venues SET cancel_cutoff_hours = 48 WHERE id = ?").run(venueId);
  expect((await setVenueTax(venueId, { registered: true, rate: 8, regNo: "SST-123" })).ok).toBe(true);
  expect((await setCancelPolicy(venueId, { lateKeep: 50 })).ok).toBe(true);
  const c = await createCourt({ venueId, name: "C1", sport: "badminton", offPeakRate: 100, peakRate: 100 });
  if (!c.ok) throw new Error("court");
  courtId = c.court.id;
});

describe("a booking cancelled late", () => {
  it("is in the report's takings and tax as the sales journal has it", async () => {
    const b = await createBooking({ courtId, date: tomorrow, hours: [9], name: "A", phone: "0197770001" });
    if (!b.ok) throw new Error(JSON.stringify(b));
    expect((await setPaymentStatus(b.booking.code, true, "cash")).ok).toBe(true);
    expect(await cancelBooking(b.booking.code, "0197770001")).toMatchObject({ ok: true, kept: 50 });
    // The fee kept carries its own tax: 50 at 8% is 3.70; the credit note takes the rest of the receipt's 7.41.
    expect(await documentFor(`booking:${b.booking.id}`)).toMatchObject({ kind: "credit_note", total: 50, tax: { amount: 3.71 } });

    const report = (await venueReport(venueId, today, tomorrow))!;
    expect(report.revenue).toMatchObject({ collected: 50, lateKept: 50, expected: 0, outstanding: 0, tax: { amount: 3.7 } });
    expect(report.bookings).toMatchObject({ confirmed: 0, cancelled: 1 });
    expect(report.collectedBy).toEqual([{ via: "cash", amount: 50, bookings: 1 }]);
    expect(report.bySport).toEqual([]);
    expect(report.byMonth.reduce((s, m) => s + m.collected, 0)).toBe(50);

    const journal = totals(await salesJournal(venueId, today, tomorrow));
    expect(journal.takings).toMatchObject({ gross: report.revenue.collected, tax: report.revenue.tax!.amount });
  });

  it("alongside one played and one cancelled in time, the report and the journal still agree", async () => {
    const played = await createBooking({ courtId, date: tomorrow, hours: [11], name: "B", phone: "0197770002" });
    const free = await createBooking({ courtId, date: addDays(today, 5), hours: [12], name: "C", phone: "0197770003" });
    if (!played.ok || !free.ok) throw new Error("booking");
    expect((await setPaymentStatus(played.booking.code, true, "card")).ok).toBe(true);
    expect((await setPaymentStatus(free.booking.code, true, "cash")).ok).toBe(true);
    expect(await cancelBooking(free.booking.code, "0197770003")).toMatchObject({ ok: true });
    const to = addDays(today, 5);
    const report = (await venueReport(venueId, today, to))!;
    expect(report.revenue).toMatchObject({ collected: 150, lateKept: 50 });
    const journal = totals(await salesJournal(venueId, today, to));
    expect(journal.takings).toMatchObject({ gross: report.revenue.collected, tax: report.revenue.tax!.amount });
  });
});
