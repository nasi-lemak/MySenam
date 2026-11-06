import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { chargeToAccount, invoiceById, invoiceLines, issueInvoice, listAccounts, saveAccount } from "../src/lib/accounts";
import { salesJournal } from "../src/lib/accounting";
import { getDb } from "../src/lib/db";
import { adminCancelBooking, createBooking, createCourt, createVenue, rescheduleBooking } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * An invoice to a company or school account never changes after it is issued (audit 9, C5; ADR 0061): a booking on it moved to a
 * cheaper court or time keeps what it was invoiced at, the difference is a credit note on the account against that invoice, and a
 * later cancellation gives back what the invoice charged, less that credit, never the live price.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (k: number) => addDays(todayISO(ZONE), k);
let venueId: number;
let courtId: number;
let cheapCourtId: number;
let dearCourtId: number;
let phoneN = 0;
let seq = 0;

async function account(name: string) {
  const a = await saveAccount(venueId, { name, email: `${name.replace(/\W/g, "").toLowerCase()}${++seq}@co.test` });
  if (!a.ok) throw new Error(a.error);
  return a.account.id;
}
async function onAccount(accountId: number, hours: number[], on: string, court = courtId) {
  const b = await createBooking({ courtId: court, date: on, hours, name: "Cikgu", phone: `01277700${String(10 + phoneN++).padStart(2, "0")}` });
  if (!b.ok) throw new Error(JSON.stringify(b));
  const charged = await chargeToAccount(venueId, accountId, [b.booking.id]);
  if (!charged.ok) throw new Error(JSON.stringify(charged));
  return b.booking;
}
const morningOf = (date: string) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${date}T07:00:00+08:00`));
};
const lineSum = async (invoiceId: number) => (await invoiceLines(invoiceId)).reduce((s, l) => s + l.amount, 0);
const live = async (code: string) =>
  (await getDb().prepare("SELECT total_price::float AS price, invoiced_amount::float AS invoiced FROM bookings WHERE code = ?").get(code)) as { price: number; invoiced: number | null };

beforeAll(async () => {
  const v = await createVenue({ name: "Arena Snapshot", area: "Klang", address: "1", phone: "0333338822" });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  for (const [name, rate] of [["C1", 20], ["C2", 10], ["C3", 30]] as const) {
    const c = await createCourt({ venueId, name, sport: "badminton", offPeakRate: rate, peakRate: rate });
    if (!c.ok) throw new Error("court");
    if (name === "C1") courtId = c.court.id;
    if (name === "C2") cheapCourtId = c.court.id;
    if (name === "C3") dearCourtId = c.court.id;
  }
});
afterEach(() => vi.useRealTimers());

describe("an issued invoice and a booking moved afterwards", () => {
  it("moved to a cheaper court: the invoice and its lines stay as issued, the difference is a credit note waiting for the next invoice", async () => {
    const accountId = await account("Drift Sdn Bhd");
    const date = day(5);
    const b = await onAccount(accountId, [9], date); // 20 on C1
    morningOf(date);
    const invoice = (await issueInvoice(accountId, date.slice(0, 7), { email: false }))!;
    vi.useRealTimers();
    expect(invoice.total).toBe(20);
    expect((await live(b.code)).invoiced).toBe(20);

    const moved = await rescheduleBooking(b.code, { date, start: 9 * 60, courtId: cheapCourtId }, "staff");
    expect(moved).toMatchObject({ ok: true, priceChange: 0, accountCredited: 10 });
    // What was issued has not moved: the booking keeps its invoiced price, the lines still add up to the total.
    expect((await live(b.code)).price).toBe(20);
    expect(await lineSum(invoice.id)).toBe(invoice.total);
    expect((await invoiceById(invoice.id))!.total).toBe(20);
    // The difference is a credit note on the account, against that invoice.
    expect((await listAccounts(venueId)).find((a) => a.id === accountId)!.credit).toBe(10);
    const notes = (await salesJournal(venueId, day(-1), day(30))).filter((r) => r.type === "Credit note" && r.customer === "Drift Sdn Bhd");
    expect(notes.map((r) => r.gross)).toEqual([-10]);
    const credit = (await getDb().prepare("SELECT for_adjustment, invoice_id FROM account_credits WHERE booking_id = ?").get(moved.ok ? moved.booking.id : 0)) as { for_adjustment: boolean; invoice_id: number };
    expect(credit).toEqual({ for_adjustment: true, invoice_id: invoice.id });

    // It comes off the account's next invoice.
    await onAccount(accountId, [15], date);
    morningOf(date);
    const next = (await issueInvoice(accountId, date.slice(0, 7), { email: false }))!;
    expect(next).toMatchObject({ total: 20, credited: 10, due: 10 });
  });

  it("a later cancellation credits what the invoice charged, less what was credited for the move: never the live price, never twice", async () => {
    const accountId = await account("Cancel After Move Sdn Bhd");
    const date = day(6);
    const b = await onAccount(accountId, [9], date); // 20
    morningOf(date);
    const invoice = (await issueInvoice(accountId, date.slice(0, 7), { email: false }))!;
    vi.useRealTimers();
    expect((await rescheduleBooking(b.code, { date, start: 9 * 60, courtId: cheapCourtId }, "staff")).ok).toBe(true); // credit 10
    morningOf(date);
    expect(await adminCancelBooking(b.code)).toMatchObject({ ok: true });
    // 10 for the move and 10 for the cancellation: the 20 the invoice charged, no more.
    const given = ((await getDb().prepare("SELECT COALESCE(SUM(amount), 0)::float AS n FROM account_credits WHERE booking_id = (SELECT id FROM bookings WHERE code = ?)").get(b.code)) as { n: number }).n;
    expect(given).toBe(invoice.total);
    expect((await listAccounts(venueId)).find((a) => a.id === accountId)!.credit).toBe(20);
  });

  it("cancelled without a move: the credit is the invoiced price, even if the booking's own price has drifted since", async () => {
    const accountId = await account("Invoiced Price Sdn Bhd");
    const date = day(7);
    const b = await onAccount(accountId, [9], date);
    morningOf(date);
    const invoice = (await issueInvoice(accountId, date.slice(0, 7), { email: false }))!;
    // Whatever changed the booking's live price (a path that never was meant to), the invoice's line and the credit follow what was charged.
    await getDb().prepare("UPDATE bookings SET total_price = 5 WHERE code = ?").run(b.code);
    expect(await lineSum(invoice.id)).toBe(20);
    expect(await adminCancelBooking(b.code)).toMatchObject({ ok: true });
    const given = ((await getDb().prepare("SELECT COALESCE(SUM(amount), 0)::float AS n FROM account_credits WHERE account_id = ?").get(accountId)) as { n: number }).n;
    expect(given).toBe(20);
  });

  it("moved to a dearer court: the invoice stays, the booking is not charged more, and staff are told what was not charged", async () => {
    const accountId = await account("Dearer Sdn Bhd");
    const date = day(8);
    const b = await onAccount(accountId, [9], date);
    morningOf(date);
    const invoice = (await issueInvoice(accountId, date.slice(0, 7), { email: false }))!;
    vi.useRealTimers();
    const moved = await rescheduleBooking(b.code, { date, start: 9 * 60, courtId: dearCourtId }, "staff");
    expect(moved).toMatchObject({ ok: true, priceChange: 0, unchargedDifference: 10 });
    expect((await live(b.code)).price).toBe(20);
    expect(await lineSum(invoice.id)).toBe(20);
    expect((await listAccounts(venueId)).find((a) => a.id === accountId)!.credit).toBe(0);
  });

  it("a booking on an account not yet invoiced is still re-priced when it moves (nothing issued to protect)", async () => {
    const accountId = await account("Not Yet Sdn Bhd");
    const date = day(9);
    const b = await onAccount(accountId, [9], date);
    const moved = await rescheduleBooking(b.code, { date, start: 9 * 60, courtId: cheapCourtId }, "staff");
    expect(moved).toMatchObject({ ok: true, priceChange: -10 });
    expect((await live(b.code)).price).toBe(10);
    morningOf(date);
    const invoice = (await issueInvoice(accountId, date.slice(0, 7), { email: false }))!;
    expect(invoice.total).toBe(10);
    expect(await lineSum(invoice.id)).toBe(10);
  });
});
