import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { getDb } from "../src/lib/db";
import { setVenueTax, taxIncluded, taxOnTop, venueTax } from "../src/lib/tax";
import { receiptFor, receiptPath, receiptToken } from "../src/lib/receipts";
import { createBooking, createCourt, createVenue, findBookingByCode, setPaymentStatus } from "../src/lib/store";
import { venueReport } from "../src/lib/reports";
import { bookingsCsv } from "../src/lib/export";
import { notifyPaid } from "../src/lib/notify";
import { messagesForBooking } from "../src/lib/outbox";
import { addDays, isPeakMinute, todayISO } from "../src/lib/time";

/**
 * A venue's own SST or GST: prices stay what customers pay, and receipts,
 * reports and exports show the tax inside them at the rate each booking was
 * taken at.
 */

let venueId: number;
let courtId: number;
let date: string;
let n = 0;

const book = async (hours: number[]) => {
  const made = await createBooking({ courtId, date, hours, name: "Aisyah", phone: `01933300${String(++n).padStart(2, "0")}`, email: "aisyah@example.my" });
  if (!made.ok) throw new Error(made.error);
  return made.booking;
};

beforeAll(async () => {
  const made = await createVenue({ name: "Tax Hall", area: "PJ", address: "1 Jalan Cukai, Petaling Jaya", phone: "0312345678" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  // RM21.20 an hour: RM20 and 6% SST, as a venue would set it.
  const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 21.2, peakRate: 21.2 });
  if (!court.ok) throw new Error("court");
  courtId = court.court.id;
  date = addDays(todayISO(), 3);
  while (isPeakMinute(date, 9 * 60)) date = addDays(date, 1);
});

describe("the arithmetic", () => {
  it("finds the tax inside a price, and adds it on top of a fee", () => {
    expect(taxIncluded(21.2, 6)).toBe(1.2);
    expect(taxIncluded(10.9, 9)).toBe(0.9);
    expect(taxIncluded(20, null)).toBe(0);
    expect(taxOnTop(100, 8)).toBe(8);
    expect(taxOnTop(19.9, 8)).toBe(1.59);
  });
});

describe("a venue registering", () => {
  it("needs a sensible rate and its registration number", async () => {
    expect(await setVenueTax(venueId, { registered: true, rate: 0, regNo: "W10-1234-56789012" })).toMatchObject({ ok: false });
    expect(await setVenueTax(venueId, { registered: true, rate: 45, regNo: "W10-1234-56789012" })).toMatchObject({ ok: false });
    expect(await setVenueTax(venueId, { registered: true, rate: 6 })).toMatchObject({ ok: false });
    expect(await venueTax(venueId)).toMatchObject({ registered: false, name: "SST", rate: null });
  });

  it("puts its rate on bookings from then on, and leaves earlier ones alone", async () => {
    const before = await book([9]);
    expect(before.taxRate).toBeNull();
    expect(await setVenueTax(venueId, { registered: true, rate: 6, regNo: "W10-1234-56789012" })).toMatchObject({
      ok: true,
      tax: { registered: true, name: "SST", rate: 6, regNo: "W10-1234-56789012" },
    });
    const after = await book([10]);
    expect(after.taxRate).toBe(6);
    // The price is what the customer pays: unchanged by the tax.
    expect(after.totalPrice).toBe(21.2);
    await setVenueTax(venueId, { registered: true, rate: 8, regNo: "W10-1234-56789012" });
    const later = await book([11]);
    expect(later.taxRate).toBe(8);
    expect((await findBookingByCode(after.code))!.taxRate).toBe(6);
    await setVenueTax(venueId, { registered: true, rate: 6, regNo: "W10-1234-56789012" });
  });
});

describe("the receipt", () => {
  it("is a tax invoice for a paid, taxed booking, behind a signed link", async () => {
    const b = await book([12]);
    expect(await receiptFor(b.code, receiptToken(b.code))).toBeNull(); // not paid yet
    await setPaymentStatus(b.code, true, "cash");
    expect(await receiptFor(b.code, "x".repeat(24))).toBeNull();
    const receipt = await receiptFor(b.code, receiptToken(b.code));
    expect(receipt).toMatchObject({
      code: b.code,
      venue: { name: "Tax Hall" },
      customer: "Aisyah",
      total: 21.2,
      tax: { name: "SST", rate: 6, amount: 1.2, regNo: "W10-1234-56789012" },
      paidVia: "Cash",
    });
    expect(receipt!.lines[0].amount).toBe(21.2);
    expect(receiptPath(b.code)).toBe(`/receipt/${b.code}?t=${receiptToken(b.code)}`);
  });

  it("goes by email with the tax inside it and the link", async () => {
    const b = await book([13]);
    await getDb().prepare("UPDATE bookings SET payment_status = 'paid', paid_at = datetime('now') WHERE id = ?").run(b.id);
    await notifyPaid([{ ...b, paymentStatus: "paid" }], "counter");
    const body = (await messagesForBooking(b.id)).find((m) => m.kind === "payment_received")!.body;
    expect(body).toContain("That includes SST of RM1.20 (6%).");
    expect(body).toContain(`https://book.example.my/receipt/${b.code}?t=`);
  });

  it("is a plain receipt where the venue charges no tax", async () => {
    const other = await createVenue({ name: "Plain Hall", area: "PJ", address: "x", phone: "0312345679" });
    if (!other.ok) throw new Error("venue");
    const court = await createCourt({ venueId: other.venue.id, name: "Court A", sport: "badminton", offPeakRate: 15, peakRate: 15 });
    if (!court.ok) throw new Error("court");
    const made = await createBooking({ courtId: court.court.id, date, hours: [9], name: "Lee", phone: "0194440001" });
    if (!made.ok) throw new Error(made.error);
    await setPaymentStatus(made.booking.code, true, "qr");
    expect(await receiptFor(made.booking.code, receiptToken(made.booking.code))).toMatchObject({ total: 15, tax: null });
  });
});

describe("the venue's books", () => {
  it("report the tax collected and export it by booking", async () => {
    const report = (await venueReport(venueId, date, date))!;
    // Two paid bookings at 6%: RM1.20 each.
    expect(report.revenue.tax).toEqual({ name: "SST", amount: 2.4 });
    const csv = await bookingsCsv(venueId, date, date);
    expect(csv.split("\r\n")[0]).toContain('"SST rate (%)","SST included (RM)"');
    expect(csv).toContain('"21.20","6.00","1.20","paid"');
  });
});
