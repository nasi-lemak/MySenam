import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { chargeToAccount, invoicePayments, issueInvoice, markInvoicePaid, saveAccount } from "../src/lib/accounts";
import { salesJournal } from "../src/lib/accounting";
import { createAdmin } from "../src/lib/admin-auth";
import { asStaff } from "../src/lib/acting-staff";
import { getDb } from "../src/lib/db";
import { createBooking, createCourt, createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import AccountInvoicePage from "../src/app/account-invoice/[token]/page";

/**
 * Hardening, brief MONEY, C6 (ADR 0068): the account's invoice page shows what has been paid on it, when and how, and what is left; the journal
 * keeps its granularity (a booking enters it when the money received covers it), which is pinned here so it is understood, not misstated.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (k: number) => addDays(todayISO(ZONE), k);
let venueId: number;
let courtId: number;
let managerId: number;
let phoneN = 0;
let seq = 0;

const morningOf = (date: string) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${date}T07:00:00+08:00`));
};
async function invoiceOf(name: string, hoursList: number[][], on: string, locale?: string) {
  const a = await saveAccount(venueId, { name, email: `${name.replace(/\W/g, "").toLowerCase()}${++seq}@co.test`, ...(locale ? { locale } : {}) });
  if (!a.ok) throw new Error(a.error);
  for (const h of hoursList) {
    const b = await createBooking({ courtId, date: on, hours: h, name: "Cikgu", phone: `01277700${String(10 + phoneN++).padStart(2, "0")}` });
    if (!b.ok) throw new Error(JSON.stringify(b));
    const charged = await chargeToAccount(venueId, a.account.id, [b.booking.id]);
    if (!charged.ok) throw new Error(JSON.stringify(charged));
  }
  morningOf(on);
  const invoice = (await issueInvoice(a.account.id, on.slice(0, 7), { email: false }))!;
  vi.useRealTimers();
  return invoice;
}
const page = async (token: string) => renderToStaticMarkup(await AccountInvoicePage({ params: Promise.resolve({ token }) }));
const pay = (invoiceId: number, via: string, amount?: number) => asStaff({ id: managerId, name: "Mira" }, () => markInvoicePaid(venueId, invoiceId, via, amount));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

beforeAll(async () => {
  const v = await createVenue({ name: "Arena Terima", area: "Klang", address: "1", phone: "0333339922" });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  const c = await createCourt({ venueId, name: "C1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!c.ok) throw new Error("court");
  courtId = c.court.id;
  const made = await createAdmin({ name: "Mira", email: "mira@terima.test", password: "a long enough password", venueId, role: "manager" });
  if (!made.ok) throw new Error(made.error);
  managerId = made.admin.id;
});
afterEach(() => vi.useRealTimers());

describe("C6: the invoice page shows what was paid and what is left", () => {
  it("an unpaid invoice says it is due and lists no payments", async () => {
    const invoice = await invoiceOf("Unpaid Sdn Bhd", [[9], [10]], day(3));
    const html = text(await page(invoice.token));
    expect(html).toContain("Please pay by");
    expect(html).not.toContain("Payment received");
    expect(html).not.toContain("Balance to pay");
    expect(await invoicePayments(invoice.id)).toEqual([]);
  });

  it("a part payment is listed with its day and way, the balance is shown, and the closing line says how much is still to pay", async () => {
    const invoice = await invoiceOf("Parts Sdn Bhd", [[9], [10], [11]], day(4)); // 3 x 20
    expect((await pay(invoice.id, "cash", 25)).ok).toBe(true);
    const html = text(await page(invoice.token));
    expect(html).toContain(`Payment received ${todayISO(ZONE)}, by cash`);
    expect(html).toContain("−RM25");
    expect(html).toContain("Balance to pay RM35");
    expect(html).toContain("RM25 received so far. RM35 is still to pay by");
    expect(html).not.toContain("Paid on");
    expect(await invoicePayments(invoice.id)).toEqual([{ receivedOn: todayISO(ZONE), via: "cash", amount: 25 }]);

    expect((await pay(invoice.id, "qr", 15)).ok).toBe(true);
    const two = text(await page(invoice.token));
    expect(two).toContain("by cash");
    expect(two).toContain("by duitnow qr / e-wallet");
    expect(two).toContain("Balance to pay RM20");
    // Viewed twice, the same (the page only reads).
    expect(text(await page(invoice.token))).toBe(two);

    expect((await pay(invoice.id, "card")).ok).toBe(true);
    const done = text(await page(invoice.token));
    expect(done).toContain("by card terminal");
    expect(done).toContain("Paid on");
    expect(done).not.toContain("Balance to pay");
    expect((await invoicePayments(invoice.id)).map((p) => p.amount)).toEqual([25, 15, 20]);
  });

  it("is in the account's language", async () => {
    const invoice = await invoiceOf("Malay Sdn Bhd", [[9], [10]], day(5), "ms");
    expect((await pay(invoice.id, "cash", 10)).ok).toBe(true);
    const html = text(await page(invoice.token));
    expect(html).toContain("Bayaran diterima");
    expect(html).toContain("Baki yang perlu dibayar");
    const zh = await invoiceOf("Chinese Sdn Bhd", [[9], [10]], day(6), "zh");
    await pay(zh.id, "cash", 10);
    expect(text(await page(zh.token))).toContain("待付余额");
    const ta = await invoiceOf("Tamil Sdn Bhd", [[9], [10]], day(7), "ta");
    await pay(ta.id, "cash", 10);
    expect(text(await page(ta.token))).toContain("செலுத்த வேண்டிய மீதி");
  });

  it("two requests paying the whole balance at once record it once", async () => {
    const invoice = await invoiceOf("Race Sdn Bhd", [[9], [10]], day(8));
    const both = await Promise.all([pay(invoice.id, "cash"), pay(invoice.id, "cash")]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect((await invoicePayments(invoice.id)).map((p) => p.amount)).toEqual([40]);
  });
});

describe("C6: the journal keeps its granularity, and the figures stay the ledger's", () => {
  it("a booking enters the journal when the money received covers it, so a part payment that covers none is not in it yet, and the whole is when the invoice is paid", async () => {
    const invoice = await invoiceOf("Journal Sdn Bhd", [[9], [10], [11]], day(9)); // 3 x 20
    const ids = (await getDb().prepare("SELECT id FROM bookings WHERE account_invoice_id = ? ORDER BY start_min").all(invoice.id)) as { id: number }[];
    const journalTotal = async () =>
      (await salesJournal(venueId, day(-1), day(2))).filter((r) => ids.some((b) => r.ref === `booking:${b.id}`)).reduce((s, r) => s + r.gross, 0);

    // RM15 received covers no whole booking: the money is on the account, not yet in the journal.
    expect((await pay(invoice.id, "cash", 15)).ok).toBe(true);
    expect(await journalTotal()).toBe(0);
    // RM30 received in all covers one booking (RM20): the journal holds RM20, and RM10 is on the invoice's payments only.
    expect((await pay(invoice.id, "cash", 15)).ok).toBe(true);
    expect(await journalTotal()).toBe(20);
    expect((await invoicePayments(invoice.id)).reduce((s, p) => s + p.amount, 0)).toBe(30);
    // Paid in full: the journal holds the invoice, to the sen, and the payments sum to the same.
    expect((await pay(invoice.id, "cash")).ok).toBe(true);
    expect(await journalTotal()).toBe(60);
    expect((await invoicePayments(invoice.id)).reduce((s, p) => s + p.amount, 0)).toBe(60);
  });
});
