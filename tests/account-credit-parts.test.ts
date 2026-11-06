import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { chargeToAccount, invoiceById, invoiceCredits, issueInvoice, listAccounts, markInvoicePaid, saveAccount, settleAccountCredit, withdrawInvoice } from "../src/lib/accounts";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { asStaff } from "../src/lib/acting-staff";
import { salesJournal } from "../src/lib/accounting";
import { getDb } from "../src/lib/db";
import { adminCancelBooking, createBooking, createCourt, createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import * as invoiceRoute from "../src/app/api/admin/accounts/invoices/[id]/route";

/**
 * Company and school accounts, credit notes and part payments (audit 9, C6; ADR 0061): a credit note comes off invoices part
 * by part (a record of each part: which credit, which invoice, how much, who, when), one too big for an invoice never
 * blocks the smaller ones behind it, an invoice can be paid in parts, and the figures stay the ledger's.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (k: number) => addDays(todayISO(ZONE), k);
let venueId: number;
let courtId: number;
let phoneN = 0;
let seq = 0;
let managerCookie: string;
let managerId: number;

async function account(name: string) {
  const a = await saveAccount(venueId, { name, email: `${name.replace(/\W/g, "").toLowerCase()}${++seq}@co.test` });
  if (!a.ok) throw new Error(a.error);
  return a.account.id;
}
async function onAccount(accountId: number, hours: number[], on: string) {
  const b = await createBooking({ courtId, date: on, hours, name: "Cikgu", phone: `01288800${String(10 + phoneN++).padStart(2, "0")}` });
  if (!b.ok) throw new Error(JSON.stringify(b));
  const charged = await chargeToAccount(venueId, accountId, [b.booking.id]);
  if (!charged.ok) throw new Error(JSON.stringify(charged));
  return b.booking;
}
/** The morning of `date`, in the venue's zone. */
const morningOf = (date: string) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${date}T07:00:00+08:00`));
};
const credit = async (accountId: number) => (await listAccounts(venueId)).find((a) => a.id === accountId)!.credit;
const allocations = async (accountId: number) =>
  (await getDb()
    .prepare(
      `SELECT a.credit_id, a.invoice_id, a.amount::float AS amount, a.allocated_by_name, a.created_at
         FROM account_credit_allocations a JOIN account_credits c ON c.id = a.credit_id WHERE c.account_id = ? ORDER BY a.id`
    )
    .all(accountId)) as { credit_id: number; invoice_id: number; amount: number; allocated_by_name: string; created_at: unknown }[];

beforeAll(async () => {
  const v = await createVenue({ name: "Arena Kredit", area: "Klang", address: "1", phone: "0333339911" });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  const c = await createCourt({ venueId, name: "C1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!c.ok) throw new Error("court");
  courtId = c.court.id;
  const made = await createAdmin({ name: "Mira", email: "mira@parts.test", password: "a long enough password", venueId, role: "manager" });
  if (!made.ok) throw new Error(made.error);
  managerId = made.admin.id;
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}`;
});
afterEach(() => vi.useRealTimers());

describe("credit notes taken off an invoice part by part", () => {
  it("a credit bigger than the next invoice comes off it as far as it goes, the rest waiting, and each part is recorded (who, when, how much)", async () => {
    const accountId = await account("Big Credit Sdn Bhd");
    const date = day(3);
    const big = await onAccount(accountId, [9, 10, 11], date); // 60
    morningOf(date);
    const first = (await issueInvoice(accountId, date.slice(0, 7), { email: false }))!;
    expect(first).toMatchObject({ total: 60, credited: 0 });
    expect(await adminCancelBooking(big.code)).toMatchObject({ ok: true });
    expect(await credit(accountId)).toBe(60);
    vi.useRealTimers();
    await onAccount(accountId, [15], date); // 20
    morningOf(date);
    const second = (await asStaff({ id: managerId, name: "Mira" }, () => issueInvoice(accountId, date.slice(0, 7), { email: false })))!;
    // 20 of the 60 is taken off; 40 waits for the next invoice.
    expect(second).toMatchObject({ total: 20, credited: 20, due: 0 });
    expect(await credit(accountId)).toBe(40);
    const parts = await allocations(accountId);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ invoice_id: second.id, amount: 20, allocated_by_name: "Mira" });
    expect(parts[0].created_at).toBeTruthy();
    expect(await invoiceCredits(second.id)).toEqual([expect.objectContaining({ amount: 20 })]);
    // The account's owing counts the invoice as what it says to pay: nothing.
    expect((await listAccounts(venueId)).find((a) => a.id === accountId)).toMatchObject({ owing: 60, credit: 40 });
  });

  it("one credit too big for an invoice never stops the smaller, later ones; the whole of every credit is accounted for", async () => {
    const accountId = await account("Blocked Credit Sdn Bhd");
    const date = day(4);
    // Read before the clock is moved: the credit notes are dated by the database's clock, which is not always the test's.
    const [from, to] = [day(-1), day(30)];
    const big = await onAccount(accountId, [9, 10, 11], date);
    const small = await onAccount(accountId, [12], date);
    morningOf(date);
    await issueInvoice(accountId, date.slice(0, 7), { email: false });
    expect(await adminCancelBooking(big.code)).toMatchObject({ ok: true }); // 60
    expect(await adminCancelBooking(small.code)).toMatchObject({ ok: true }); // 20
    vi.useRealTimers();
    await onAccount(accountId, [16], date); // 20
    morningOf(date);
    const second = (await issueInvoice(accountId, date.slice(0, 7), { email: false }))!;
    expect(second).toMatchObject({ total: 20, credited: 20 });
    // Taken in order, oldest first, so the 20 came off the 60; the 20 behind it still waits whole, with the rest: 60 in all.
    expect(await credit(accountId)).toBe(60);
    // And the ledger: what was given in credit notes is what was taken plus what waits.
    const given = ((await getDb().prepare("SELECT COALESCE(SUM(amount), 0)::float AS n FROM account_credits WHERE account_id = ?").get(accountId)) as { n: number }).n;
    const taken = (await allocations(accountId)).reduce((s, a) => s + a.amount, 0);
    expect(given).toBe(80);
    expect(taken + (await credit(accountId))).toBe(given);
    // The credit notes themselves are the journal's, written when each booking was cancelled: allocating them moves nothing there.
    const notes = (await salesJournal(venueId, from, to)).filter((r) => r.type === "Credit note" && r.customer === "Blocked Credit Sdn Bhd");
    expect(notes.map((r) => r.gross).sort((a, b) => a - b)).toEqual([-60, -20]);
  });

  it("a credit is spread over several invoices, and an invoice withdrawn gives its part back", async () => {
    const accountId = await account("Spread Credit Sdn Bhd");
    const date = day(5);
    const big = await onAccount(accountId, [9, 10, 11], date); // 60
    morningOf(date);
    await issueInvoice(accountId, date.slice(0, 7), { email: false });
    expect(await adminCancelBooking(big.code)).toMatchObject({ ok: true });
    vi.useRealTimers();
    await onAccount(accountId, [14], date);
    morningOf(date);
    const a = (await issueInvoice(accountId, date.slice(0, 7), { email: false }))!;
    vi.useRealTimers();
    await onAccount(accountId, [15], date);
    morningOf(date);
    const b = (await issueInvoice(accountId, date.slice(0, 7), { email: false }))!;
    expect([a.credited, b.credited]).toEqual([20, 20]);
    expect(await credit(accountId)).toBe(20);
    // The second invoice is withdrawn, as if never issued: its 20 waits again.
    expect(await withdrawInvoice(venueId, b.id)).toBe(true);
    expect(await credit(accountId)).toBe(40);
    expect((await allocations(accountId)).map((x) => x.invoice_id)).toEqual([a.id]);
  });

  it("paid back by hand: what waits, not what an invoice has taken already", async () => {
    const accountId = await account("Hand Credit Sdn Bhd");
    const date = day(6);
    const big = await onAccount(accountId, [9, 10, 11], date);
    morningOf(date);
    await issueInvoice(accountId, date.slice(0, 7), { email: false });
    expect(await adminCancelBooking(big.code)).toMatchObject({ ok: true });
    vi.useRealTimers();
    await onAccount(accountId, [14], date);
    morningOf(date);
    const next = (await issueInvoice(accountId, date.slice(0, 7), { email: false }))!;
    expect(next.credited).toBe(20);
    const done = await settleAccountCredit(venueId, accountId, { adminId: managerId, name: "Mira" }, "DuitNow 1");
    expect(done).toMatchObject({ ok: true, amount: 40 });
    const row = (await getDb().prepare("SELECT settled_amount::float AS s FROM account_credits WHERE account_id = ?").get(accountId)) as { s: number };
    expect(row.s).toBe(40);
    expect(await credit(accountId)).toBe(0);
    // The invoice that took its part keeps it, and nothing is paid back twice.
    expect((await invoiceById(next.id))!.credited).toBe(20);
    expect(await settleAccountCredit(venueId, accountId, { adminId: managerId, name: "Mira" }, null)).toMatchObject({ ok: false });
  });

  it("settled and invoiced at the same moment: the credit's balance is taken off the invoice or paid back, never both (on Postgres too)", async () => {
    const accountId = await account("Race Credit Sdn Bhd");
    const date = day(7);
    const big = await onAccount(accountId, [9, 10, 11], date);
    morningOf(date);
    await issueInvoice(accountId, date.slice(0, 7), { email: false });
    expect(await adminCancelBooking(big.code)).toMatchObject({ ok: true });
    vi.useRealTimers();
    await onAccount(accountId, [14], date);
    morningOf(date);
    const [settled, invoice] = await Promise.all([
      settleAccountCredit(venueId, accountId, { adminId: managerId, name: "Mira" }, null),
      issueInvoice(accountId, date.slice(0, 7), { email: false }),
    ]);
    const taken = invoice!.credited;
    const paidBack = settled.ok ? settled.amount : 0;
    expect(taken + paidBack).toBe(60);
    expect(await credit(accountId)).toBe(0);
  });
});

describe("an invoice paid in parts", () => {
  async function invoiceOf(name: string, hoursList: number[][], on: string) {
    const accountId = await account(name);
    for (const h of hoursList) await onAccount(accountId, h, on);
    morningOf(on);
    const invoice = (await issueInvoice(accountId, on.slice(0, 7), { email: false }))!;
    vi.useRealTimers();
    return { accountId, invoice };
  }

  it("part payments are recorded, the bookings are paid as the money covers them, and the invoice is paid when the last part is in", async () => {
    const { accountId, invoice } = await invoiceOf("Parts Sdn Bhd", [[9], [10], [11]], day(8)); // 3 x 20
    expect(invoice.total).toBe(60);
    const first = await asStaff({ id: managerId, name: "Mira" }, () => markInvoicePaid(venueId, invoice.id, "cash", 25));
    expect(first).toMatchObject({ ok: true, invoice: { paidOn: null, received: 25, balance: 35 } });
    // 25 covers the first booking (20) in full; the second waits for more.
    const paid = async () =>
      (await getDb().prepare("SELECT payment_status, paid_via FROM bookings WHERE account_invoice_id = ? ORDER BY start_min").all(invoice.id)) as { payment_status: string; paid_via: string | null }[];
    expect((await paid()).map((b) => b.payment_status)).toEqual(["paid", "unpaid", "unpaid"]);
    expect((await listAccounts(venueId)).find((a) => a.id === accountId)!.owing).toBe(35);
    const second = await markInvoicePaid(venueId, invoice.id, "qr", 15);
    expect(second).toMatchObject({ ok: true, invoice: { paidOn: null, received: 40, balance: 20 } });
    expect((await paid()).map((b) => b.payment_status)).toEqual(["paid", "paid", "unpaid"]);
    // More than is left is refused; the rest, with no amount said, pays it.
    expect(await markInvoicePaid(venueId, invoice.id, "cash", 21)).toMatchObject({ ok: false });
    const last = await markInvoicePaid(venueId, invoice.id, "card");
    expect(last).toMatchObject({ ok: true, invoice: { received: 60, balance: 0 } });
    expect((await invoiceById(invoice.id))!.paidOn).not.toBeNull();
    expect((await paid()).map((b) => `${b.payment_status}:${b.paid_via}`)).toEqual(["paid:cash", "paid:qr", "paid:card"]);
    const rows = (await getDb().prepare("SELECT amount::float AS amount, via, received_by_name FROM account_invoice_payments WHERE invoice_id = ? ORDER BY id").all(invoice.id)) as { amount: number; via: string; received_by_name: string | null }[];
    expect(rows).toEqual([
      { amount: 25, via: "cash", received_by_name: "Mira" },
      { amount: 15, via: "qr", received_by_name: null },
      { amount: 20, via: "card", received_by_name: null },
    ]);
    // Paid: nothing more to take, and the account owes nothing.
    expect(await markInvoicePaid(venueId, invoice.id, "cash", 1)).toMatchObject({ ok: false });
    expect((await listAccounts(venueId)).find((a) => a.id === accountId)!.owing).toBe(0);
  });

  it("the money the desk took is in the day's cash-up by method as the bookings it covers", async () => {
    const { invoice } = await invoiceOf("Parts Cash Sdn Bhd", [[9], [10]], day(9)); // 2 x 20
    await markInvoicePaid(venueId, invoice.id, "cash", 20);
    await markInvoicePaid(venueId, invoice.id, "card", 20);
    const rows = (await salesJournal(venueId, day(0), day(0))).filter((r) => r.type === "Receipt");
    const byMethod = (m: string) => rows.filter((r) => r.method === m && r.description.includes(day(9))).reduce((s, r) => s + r.gross, 0);
    expect(byMethod("cash")).toBe(20);
    expect(byMethod("card")).toBe(20);
  });

  it("an invoice part-paid cannot be withdrawn, and a part payment over the route is the venue's manager's or desk's own and says how", async () => {
    const { invoice } = await invoiceOf("Parts Route Sdn Bhd", [[9], [10]], day(10));
    const post = (body: Record<string, unknown>) =>
      invoiceRoute.POST(
        new NextRequest(`http://localhost/api/admin/accounts/invoices/${invoice.id}`, { method: "POST", headers: { "content-type": "application/json", cookie: managerCookie }, body: JSON.stringify(body) }),
        { params: Promise.resolve({ id: String(invoice.id) }) }
      );
    expect((await post({ via: "cash", amount: -5 })).status).toBe(409);
    expect((await post({ via: "cash", amount: 15 })).status).toBe(200);
    expect(await withdrawInvoice(venueId, invoice.id)).toBe(false);
    const res = await invoiceRoute.DELETE(
      new NextRequest(`http://localhost/api/admin/accounts/invoices/${invoice.id}`, { method: "DELETE", headers: { cookie: managerCookie } }),
      { params: Promise.resolve({ id: String(invoice.id) }) }
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("received") });
    expect((await invoiceById(invoice.id))!.balance).toBe(25);
  });
});
