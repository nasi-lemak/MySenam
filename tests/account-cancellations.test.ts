import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { chargeToAccount, invoiceById, invoiceLines, issueInvoice, listAccounts, markInvoicePaid, saveAccount, withdrawInvoice } from "../src/lib/accounts";
import { salesJournal } from "../src/lib/accounting";
import { getDb } from "../src/lib/db";
import { documentFor } from "../src/lib/documents";
import { adminCancelBooking, createBooking, createCourt, createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * A booking on a company account cancelled after its invoice was issued
 * (audit R8, X3-3): the invoice stays as issued, the cancellation is a
 * credit note on the account against it, what the account owes agrees with
 * the invoice, and the sales journal nets the booking to nothing.
 */

let venueId: number;
let courtId: number;
let accountId: number;
const today = todayISO();
const date = addDays(today, 3);

async function onAccount(hour: number, on = date) {
  const b = await createBooking({ courtId, date: on, hours: [hour], name: "Cikgu Rahim", phone: "0129990001" });
  if (!b.ok) throw new Error(JSON.stringify(b));
  expect((await chargeToAccount(venueId, accountId, [b.booking.id])).ok).toBe(true);
  return b.booking;
}

beforeAll(async () => {
  const v = await createVenue({ name: "Arena Akaun", area: "Klang", address: "1", phone: "0333331111" });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  const c = await createCourt({ venueId, name: "C1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!c.ok) throw new Error("court");
  courtId = c.court.id;
  const a = await saveAccount(venueId, { name: "SK Taman Klang", email: "bursar@sk.edu.my" });
  if (!a.ok) throw new Error(a.error);
  accountId = a.account.id;
});

afterEach(() => vi.useRealTimers());

describe("a booking cancelled after its invoice was issued", () => {
  it("is a credit note on the account; the invoice stays as issued and the account owes what it says", async () => {
    const kept = await onAccount(9);
    const off = await onAccount(12);
    // The morning of the sessions: invoiced (this month so far), not yet played.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${date}T07:00:00+08:00`));
    const invoice = (await issueInvoice(accountId, date.slice(0, 7), { email: false }))!;
    expect(invoice).toMatchObject({ total: 40, due: 40 });

    expect(await adminCancelBooking(off.code)).toMatchObject({ ok: true });
    const credits = (await getDb().prepare("SELECT id, amount::float AS amount, invoice_id, applied_invoice_id FROM account_credits WHERE booking_id = ?").all(off.id)) as {
      id: number;
      amount: number;
      invoice_id: number;
      applied_invoice_id: number | null;
    }[];
    expect(credits).toEqual([{ id: expect.any(Number), amount: 20, invoice_id: invoice.id, applied_invoice_id: null }]);
    const note = await documentFor(`account-credit:${credits[0].id}`);
    expect(note).toMatchObject({ kind: "credit_note", total: 20, customerName: "SK Taman Klang", credits: invoice.number, note: "receipt.why.cancelled" });
    expect(note!.lines[0].description).toBe(`${off.code}, cancelled`);
    // Nothing reversed twice: no credit note on the booking's own receipt as well.
    expect(await documentFor(`booking:${off.id}`)).toBeNull();
    // The invoice as issued; the account owes what it says, the credit waiting for the next one.
    expect((await invoiceLines(invoice.id)).map((l) => l.code).sort()).toEqual([kept.code, off.code].sort());
    expect((await listAccounts(venueId)).find((a) => a.id === accountId)).toMatchObject({ owing: 40, credit: 20, uninvoiced: 0 });
    // Cancelling again gives nothing more.
    expect(await adminCancelBooking(off.code)).toMatchObject({ ok: false });
    expect((await getDb().prepare("SELECT COUNT(*)::int AS n FROM account_credits WHERE booking_id = ?").get(off.id)) as { n: number }).toEqual({ n: 1 });
    // Its credit note stands, so the invoice does: it cannot be withdrawn as if never issued.
    expect(await withdrawInvoice(venueId, invoice.id)).toBe(false);

    // Paid as issued: the cancelled booking was paid for too, and its credit note gives it back, in the journal as on the account.
    expect(await markInvoicePaid(venueId, invoice.id, "transfer")).toMatchObject({ ok: true, invoice: { due: 40 } });
    expect(await getDb().prepare("SELECT status, payment_status FROM bookings WHERE id = ?").get(off.id)).toEqual({ status: "cancelled", payment_status: "paid" });
    const journal = await salesJournal(venueId, today, date);
    const forOff = journal.filter((r) => r.number === off.code || r.number === note!.number);
    expect(forOff.map((r) => [r.category, r.gross]).sort()).toEqual([
      ["Court hire", -20],
      ["Court hire", 20],
    ]);
    expect((await listAccounts(venueId)).find((a) => a.id === accountId)).toMatchObject({ owing: 0, credit: 20 });

    // The next invoice takes the credit off.
    await onAccount(15);
    const second = (await issueInvoice(accountId, date.slice(0, 7), { email: false }))!;
    expect(second).toMatchObject({ total: 20, credited: 20, due: 0 });
    expect(await invoiceById(second.id)).toMatchObject({ due: 0 });
    expect((await listAccounts(venueId)).find((a) => a.id === accountId)).toMatchObject({ owing: 0, credit: 0 });
  });

  it("cancelled before the invoice, it simply drops off: nothing invoiced, nothing credited", async () => {
    const b = await onAccount(18);
    expect(await adminCancelBooking(b.code)).toMatchObject({ ok: true });
    expect(await getDb().prepare("SELECT 1 FROM account_credits WHERE booking_id = ?").get(b.id)).toBeUndefined();
    expect((await listAccounts(venueId)).find((a) => a.id === accountId)).toMatchObject({ uninvoiced: 0, credit: 0 });
  });
});
