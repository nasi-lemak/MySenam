import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { registerUser, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { documentFor, documentsForUser, documentsForVenue, issueReceipt } from "../src/lib/documents";
import { markRefunded } from "../src/lib/payments";
import { receiptFor, receiptToken } from "../src/lib/receipts";
import { venueReport } from "../src/lib/reports";
import {
  adminCancelBooking,
  createBooking,
  createCourt,
  createVenue,
  issuePass,
  payBookingWithPass,
  sellMembership,
  setPaymentStatus,
  topUpWallet,
  voidPass,
} from "../src/lib/store";
import { setVenueTax } from "../src/lib/tax";
import { addDays, isPeakMinute, todayISO } from "../src/lib/time";
import { createTournament, enter, setEntry } from "../src/lib/tournaments";

/**
 * Everything sold gets a receipt — a tax invoice at a registered venue — with
 * its own number in order at its venue, and a reversal gets a credit note.
 */

let venueId: number;
let courtId: number;
let adminId: number;
let customer: User;
let date: string;

const open = (ref: string) => receiptFor(ref, receiptToken(ref));

beforeAll(async () => {
  await ensureBootstrapAdmin();
  adminId = ((await getDb().prepare("SELECT id FROM admins ORDER BY id LIMIT 1").get()) as { id: number }).id;
  const made = await createVenue({ name: "Receipt Hall", area: "PJ", address: "2 Jalan Resit", phone: "0312340000" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 21.2, peakRate: 21.2 });
  if (!court.ok) throw new Error("court");
  courtId = court.court.id;
  await setVenueTax(venueId, { registered: true, rate: 6, regNo: "W10-1234-56789012" });
  const user = await registerUser({ name: "Nurul Ain", email: "nurul@example.my", phone: "0198887777", password: "a long enough password" });
  if (!user.ok) throw new Error(user.error);
  customer = user.user;
  date = addDays(todayISO(), 3);
  while (isPeakMinute(date, 9 * 60)) date = addDays(date, 1);
});

describe("receipts for what is sold", () => {
  it("number a venue's sales in order, with the tax inside each", async () => {
    const sold = await sellMembership({
      venueId, holderName: "Nurul Ain", holderPhone: "0198887777", startsOn: todayISO(), expiresOn: addDays(todayISO(), 30),
      price: 106, adminId, userId: customer.id,
    });
    if (!sold.ok) throw new Error(sold.error);
    const doc = (await documentFor(`membership:${sold.membership.id}`))!;
    expect(doc).toMatchObject({
      kind: "receipt", number: "R-000001", total: 106, paidVia: "At the counter",
      tax: { name: "SST", rate: 6, amount: 6, regNo: "W10-1234-56789012" },
    });
    expect(await open(doc.ref)).toMatchObject({ number: "R-000001", customer: "Nurul Ain", venue: { name: "Receipt Hall" }, tax: { amount: 6 } });
    expect(await receiptFor(doc.ref, "x".repeat(24))).toBeNull();

    // Another venue counts from one.
    const other = await createVenue({ name: "Other Hall", area: "PJ", address: "x", phone: "0312340001" });
    if (!other.ok) throw new Error("venue");
    const theirs = await sellMembership({
      venueId: other.venue.id, holderName: "Lee", holderPhone: "0198880000", startsOn: todayISO(), expiresOn: addDays(todayISO(), 30), price: 50, adminId,
    });
    if (!theirs.ok) throw new Error(theirs.error);
    expect(await documentFor(`membership:${theirs.membership.id}`)).toMatchObject({ number: "R-000001", tax: null });
  });

  it("are never given the same number twice, however many are made at once", async () => {
    const made = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        issueReceipt({ source: `test:${i}`, venueId, name: "Walk-in", lines: [{ description: "Towel", amount: 5 }], paidVia: "Cash", taxable: true })
      )
    );
    expect(new Set(made.map((d) => d!.number)).size).toBe(5);
    // And a sale is receipted once.
    const again = await issueReceipt({ source: "test:0", venueId, name: "Walk-in", lines: [{ description: "Towel", amount: 5 }], paidVia: "Cash", taxable: true });
    expect(again!.id).toBe(made[0]!.id);
  });

  it("are not made for something free", async () => {
    expect(await issueReceipt({ source: "free:1", venueId, name: "x", lines: [{ description: "Trial", amount: 0 }], paidVia: null, taxable: true })).toBeNull();
  });

  it("show credit untaxed, since it is taxed when spent", async () => {
    const topped = await topUpWallet({ userId: customer.id, amount: 50, adminId, venueId });
    if (!topped.ok) throw new Error(topped.error);
    const doc = (await documentsForUser(customer.id)).find((d) => d.lines[0].description.startsWith("Stored credit"))!;
    expect(doc).toMatchObject({ total: 50, tax: null, note: "receipt.creditNoTax" });
  });
});

describe("credit notes", () => {
  it("reverse a voided pass handed back unused in full, at the tax it was sold at", async () => {
    const sold = await issuePass({
      venueId, name: "10-hour pass", entries: 10, price: 190.8, holderName: "Nurul Ain", holderPhone: "0198887777",
      expiresOn: addDays(todayISO(), 60), adminId, userId: customer.id,
    });
    if (!sold.ok) throw new Error(sold.error);
    const receipt = (await documentFor(`pass:${sold.pass.id}`))!;
    expect(receipt.tax).toMatchObject({ rate: 6, amount: 10.8 });
    // The rate changes; the credit note is at the rate it was sold at.
    await setVenueTax(venueId, { registered: true, rate: 8, regNo: "W10-1234-56789012" });
    // Voiding alone is not a refund (no credit note); handed back, all of it unused, it is credited in full.
    await voidPass(sold.pass.id, { refund: true });
    await setVenueTax(venueId, { registered: true, rate: 6, regNo: "W10-1234-56789012" });
    const credit = (await documentFor(`credit:${receipt.id}`))!;
    expect(credit).toMatchObject({ kind: "credit_note", number: "CN-000001", credits: receipt.number, total: 190.8, tax: { rate: 6, amount: 10.8 } });
    expect(await open(credit.ref)).toMatchObject({ kind: "credit_note", credits: receipt.number, note: "receipt.why.voided" });
  });

  it("reverse a paid booking that is cancelled, and the booking's receipt links to it", async () => {
    const made = await createBooking({ courtId, date, hours: [9], name: "Nurul Ain", phone: "0198887777" });
    if (!made.ok) throw new Error(made.error);
    await setPaymentStatus(made.booking.code, true, "cash");
    await adminCancelBooking(made.booking.code);
    const credit = (await documentFor(`booking:${made.booking.id}`))!;
    expect(credit).toMatchObject({ kind: "credit_note", credits: made.booking.code, total: 21.2, tax: { rate: 6, amount: 1.2 } });
    const receipt = (await open(made.booking.code))!;
    expect(receipt).toMatchObject({ cancelled: true, creditNote: { number: credit.number } });
  });

  it("are not made for an unpaid booking that is cancelled", async () => {
    const made = await createBooking({ courtId, date, hours: [10], name: "Nurul Ain", phone: "0198887777" });
    if (!made.ok) throw new Error(made.error);
    await adminCancelBooking(made.booking.code);
    expect(await documentFor(`booking:${made.booking.id}`)).toBeNull();
  });

  it("follow an online payment refunded", async () => {
    const db = getDb();
    const { id } = (await db
      .prepare(
        `INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, status, payer_name, payer_phone, purpose, refund_due)
         VALUES ('billplz', 'bp_receipted', 'https://x', ?, 42.4, 'paid', 'Nurul Ain', '0198887777', 'entry', 42.4) RETURNING id`
      )
      .get(venueId)) as { id: number };
    const receipt = (await issueReceipt({
      source: `payment:${id}`, venueId, name: "Nurul Ain", lines: [{ description: "Entry: Cup", amount: 42.4 }], paidVia: "Online (Billplz)", taxable: true,
    }))!;
    await markRefunded(id, venueId);
    expect(await documentFor(`credit:${receipt.id}`)).toMatchObject({ credits: receipt.number, note: "receipt.why.refunded", tax: { amount: 2.4 } });
  });
});

describe("a booking paid with a pass", () => {
  it("carries no tax of its own: the pass's receipt did", async () => {
    const sold = await issuePass({
      venueId, name: "5-hour pass", entries: 5, price: 100, holderName: "Nurul Ain", holderPhone: "0198887777",
      expiresOn: addDays(todayISO(), 60), adminId, userId: customer.id,
    });
    if (!sold.ok) throw new Error(sold.error);
    const made = await createBooking({ courtId, date, hours: [11], name: "Nurul Ain", phone: "0198887777", userId: customer.id });
    if (!made.ok) throw new Error(made.error);
    const paid = await payBookingWithPass(made.booking.id, sold.pass.code);
    expect(paid.ok).toBe(true);
    expect(await open(made.booking.code)).toMatchObject({ tax: null, passTax: "SST", paidVia: "Pass" });
  });
});

describe("fees marked paid at the counter", () => {
  it("are receipted, credited when the mark is taken back, and receipted afresh when paid again", async () => {
    const day = addDays(todayISO(), 20);
    const t = await createTournament(
      {
        venueId, name: "Receipt Cup", sport: "badminton", format: "knockout", teamSize: 1, level: null, entryFee: 31.8,
        maxEntries: 8, startsOn: day, endsOn: day, startHour: 9, endHour: 21, courtIds: [courtId],
      },
      adminId
    );
    if (!t.ok) throw new Error(t.error);
    const entry = await enter({ id: customer.id, name: customer.name }, t.value.id);
    if (!entry.ok) throw new Error(entry.error);
    const entryReceipts = async () =>
      (await documentsForVenue(venueId)).filter((d) => d.lines[0].description === "Entry: Receipt Cup");
    await setEntry(entry.value.id, { paid: true });
    await setEntry(entry.value.id, { paid: true }); // again: still one receipt
    expect(await entryReceipts()).toHaveLength(1);
    await setEntry(entry.value.id, { paid: false });
    await setEntry(entry.value.id, { paid: true });
    const docs = await entryReceipts();
    expect(docs.map((d) => d.kind).sort()).toEqual(["credit_note", "receipt", "receipt"]);
    expect(docs.find((d) => d.kind === "receipt")!.tax).toMatchObject({ amount: 1.8 });
  });
});

describe("the venue's report", () => {
  it("counts the tax on receipts less credit notes alongside the bookings'", async () => {
    const report = (await venueReport(venueId, todayISO(), addDays(todayISO(), 30)))!;
    const docs = await documentsForVenue(venueId, 500);
    const fromDocs = docs.reduce(
      (sum, d) => sum + (d.kind === "receipt" ? d.tax?.amount ?? 0 : d.source.startsWith("credit:") ? -(d.tax?.amount ?? 0) : 0),
      0
    );
    expect(report.revenue.tax!.amount).toBeCloseTo(fromDocs, 2);
    expect(report.revenue.tax!.amount).toBeGreaterThan(0);
  });
});
