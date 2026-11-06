import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import {
  chargeToAccount,
  issueInvoice,
  markInvoicePaid,
  overdueAccountsAttention,
  overdueBlockDays,
  remindOverdueAccountInvoices,
  saveAccount,
  setOverdueBlockDays,
} from "../src/lib/accounts";
import { listActivity } from "../src/lib/activity";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { money } from "../src/lib/region";
import { createBooking, createCourt, createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import * as settingsRoute from "../src/app/api/admin/accounts/settings/route";
import * as chargeRoute from "../src/app/api/admin/accounts/charge/route";
import * as attentionRoute from "../src/app/api/admin/attention/route";

/**
 * A company or school account that does not pay (audit 9, C7; ADR 0061): its overdue invoices are on the venue's needs-attention
 * list and reminded to the account weekly, and a venue may set after how many days overdue new bookings on the account are refused
 * (off unless set), with a refusal that names what is overdue, staff able to go past it with a reason that is recorded.
 */

const ZONE = "Asia/Kuala_Lumpur";
const today = () => todayISO(ZONE);
let venueId: number;
let otherVenueId: number;
let courtId: number;
let managerCookie: string;
let deskCookie: string;
let otherCookie: string;
let seq = 0;
let phoneN = 0;
let slotN = 0;
/** The next free day inside the booking window, and an hour that is free on it (hours rise as the days wrap). */
const nextSlot = (base: number) => {
  const n = slotN++;
  return { on: addDays(today(), 1 + (n % 12)), hour: base + Math.floor(n / 12) };
};

async function account(name: string) {
  const a = await saveAccount(venueId, { name, email: `${name.replace(/\W/g, "").toLowerCase()}${++seq}@co.test` });
  if (!a.ok) throw new Error(a.error);
  return a.account.id;
}
async function booking(on: string, hour: number) {
  const b = await createBooking({ courtId, date: on, hours: [hour], name: "Cikgu", phone: `01266600${String(10 + phoneN++).padStart(2, "0")}` });
  if (!b.ok) throw new Error(JSON.stringify(b));
  return b.booking;
}
/** An account with one invoice of 20, issued, and made `daysOverdue` days past its day. */
async function overdueAccount(name: string, daysOverdue: number) {
  const accountId = await account(name);
  const { on, hour } = nextSlot(8);
  const b = await booking(on, hour);
  expect((await chargeToAccount(venueId, accountId, [b.id])).ok).toBe(true);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${on}T07:00:00+08:00`));
  const invoice = (await issueInvoice(accountId, on.slice(0, 7), { email: false }))!;
  vi.useRealTimers();
  await getDb().prepare("UPDATE account_invoices SET due_on = ? WHERE id = ?").run(addDays(today(), -daysOverdue), invoice.id);
  return { accountId, invoice };
}
async function another(accountId: number) {
  const slot = nextSlot(15);
  const b = await booking(slot.on, slot.hour);
  return { id: b.id, code: b.code, charge: (opts?: { override?: { reason: string } }) => chargeToAccount(venueId, accountId, [b.id], opts) };
}
const post = (route: { POST: (r: NextRequest) => Promise<Response> }, url: string, cookie: string, body: unknown) =>
  route.POST(new NextRequest(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));

beforeAll(async () => {
  const v = await createVenue({ name: "Arena Tertunggak", area: "Klang", address: "1", phone: "0333337733" });
  const o = await createVenue({ name: "Arena Lain", area: "Klang", address: "2", phone: "0333337744" });
  if (!v.ok || !o.ok) throw new Error("venue");
  venueId = v.venue.id;
  otherVenueId = o.venue.id;
  const c = await createCourt({ venueId, name: "C1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!c.ok) throw new Error("court");
  courtId = c.court.id;
  const cookieOf = async (name: string, forVenue: number, role: "manager" | "desk") => {
    const made = await createAdmin({ name, email: `ov${++seq}@ov.test`, password: "a long enough password", venueId: forVenue, role });
    if (!made.ok) throw new Error(made.error);
    return `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}`;
  };
  managerCookie = await cookieOf("Mira", venueId, "manager");
  deskCookie = await cookieOf("Dina Desk", venueId, "desk");
  otherCookie = await cookieOf("Other Manager", otherVenueId, "manager");
});
afterEach(() => vi.useRealTimers());

describe("the venue's block on an account with an invoice long overdue", () => {
  it("is off unless the venue sets it: an invoice 90 days overdue still takes a booking, as before", async () => {
    expect(await overdueBlockDays(venueId)).toBeNull();
    const { accountId } = await overdueAccount("Default Off Bhd", 90);
    expect((await (await another(accountId)).charge()).ok).toBe(true);
  });

  it("refuses new bookings once an invoice is that many days overdue, naming what is overdue; before then it does not", async () => {
    expect(await setOverdueBlockDays(venueId, 30)).toEqual({ ok: true, days: 30 });
    try {
      const { accountId, invoice } = await overdueAccount("Thirty Days Bhd", 29);
      expect((await (await another(accountId)).charge()).ok).toBe(true);
      await getDb().prepare("UPDATE account_invoices SET due_on = ? WHERE id = ?").run(addDays(today(), -30), invoice.id);
      const refused = await (await another(accountId)).charge();
      expect(refused).toMatchObject({ ok: false, code: "ACCOUNT_OVERDUE" });
      if (!refused.ok) {
        expect(refused.error).toContain(money(20));
        expect(refused.error).toContain("30");
      }
      // Nothing was charged to it.
      const stuck = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE account_id = ? AND account_invoice_id IS NULL").get(accountId)) as { n: number };
      expect(stuck.n).toBe(1);
    } finally {
      await setOverdueBlockDays(venueId, null);
    }
  });

  it("a part payment lowers the amount named; a paid invoice no longer blocks", async () => {
    expect(await setOverdueBlockDays(venueId, 10)).toMatchObject({ ok: true });
    try {
      const { accountId, invoice } = await overdueAccount("Part Paid Bhd", 40);
      expect(await markInvoicePaid(venueId, invoice.id, "cash", 5)).toMatchObject({ ok: true });
      const refused = await (await another(accountId)).charge();
      expect(refused).toMatchObject({ ok: false, code: "ACCOUNT_OVERDUE" });
      if (!refused.ok) expect(refused.error).toContain(money(15));
      expect(await markInvoicePaid(venueId, invoice.id, "cash")).toMatchObject({ ok: true });
      expect((await (await another(accountId)).charge()).ok).toBe(true);
    } finally {
      await setOverdueBlockDays(venueId, null);
    }
  });

  it("staff go past it with a reason, which is recorded; a few letters of reason is not one", async () => {
    expect(await setOverdueBlockDays(venueId, 7)).toMatchObject({ ok: true });
    try {
      const { accountId } = await overdueAccount("Override Bhd", 20);
      const b = await another(accountId);
      expect(await b.charge({ override: { reason: " " } })).toMatchObject({ ok: false, code: "ACCOUNT_OVERDUE" });
      const body = { bookingId: b.id, accountId };
      // The desk, over the route: refused without a reason, allowed with one.
      expect((await post(chargeRoute, "/api/admin/accounts/charge", deskCookie, body)).status).toBe(409);
      const done = await post(chargeRoute, "/api/admin/accounts/charge", deskCookie, { ...body, overrideReason: "Head teacher confirmed the cheque is in the post" });
      expect(done.status).toBe(200);
      const logged = (await listActivity([venueId])).filter((a) => a.action === "account.charged" && a.bookingCode === b.code);
      expect(logged[0]?.detail).toContain("past the venue's block");
      expect(logged[0]?.detail).toContain("Head teacher confirmed");
      expect(logged[0]?.detail).toContain(money(20));
    } finally {
      await setOverdueBlockDays(venueId, null);
    }
  });
});

describe("the setting", () => {
  it("is a manager's: the desk and another venue's manager are refused, and a sensible number only", async () => {
    const url = "/api/admin/accounts/settings";
    expect((await post(settingsRoute, url, deskCookie, { venueId, overdueBlockDays: 30 })).status).toBe(403);
    expect((await post(settingsRoute, url, otherCookie, { venueId, overdueBlockDays: 30 })).status).toBe(403);
    expect(await overdueBlockDays(venueId)).toBeNull();
    for (const bad of [0, -3, 366, 2.5, "soon"]) expect((await post(settingsRoute, url, managerCookie, { venueId, overdueBlockDays: bad })).status).toBe(400);
    const ok = await post(settingsRoute, url, managerCookie, { venueId, overdueBlockDays: 30 });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ overdueBlockDays: 30 });
    expect(await overdueBlockDays(venueId)).toBe(30);
    expect((await listActivity([venueId])).some((a) => a.action === "settings.changed" && a.detail?.includes("30 days overdue"))).toBe(true);
    const off = await post(settingsRoute, url, managerCookie, { venueId, overdueBlockDays: null });
    expect(await off.json()).toEqual({ overdueBlockDays: null });
  });
});

describe("overdue invoices on the dashboard and reminded to the account", () => {
  it("are on the needs-attention list with what is still to pay, the days overdue and whether they block; only for the venue's own staff", async () => {
    const { invoice } = await overdueAccount("Attention Bhd", 12);
    await setOverdueBlockDays(venueId, 10);
    try {
      const list = await overdueAccountsAttention([venueId]);
      expect(list.find((i) => i.id === invoice.id)).toMatchObject({ accountName: "Attention Bhd", daysOverdue: 12, balance: 20, blocking: true });
      const res = await attentionRoute.GET(new NextRequest("http://localhost/api/admin/attention", { headers: { cookie: managerCookie } }));
      const seen = ((await res.json()) as { accountsOverdue: { id: number }[] }).accountsOverdue;
      expect(seen.some((i) => i.id === invoice.id)).toBe(true);
      const other = await attentionRoute.GET(new NextRequest("http://localhost/api/admin/attention", { headers: { cookie: otherCookie } }));
      expect(((await other.json()) as { accountsOverdue: { id: number }[] }).accountsOverdue.some((i) => i.id === invoice.id)).toBe(false);
      // Paid, it is gone.
      await markInvoicePaid(venueId, invoice.id, "cash");
      expect((await overdueAccountsAttention([venueId])).some((i) => i.id === invoice.id)).toBe(false);
    } finally {
      await setOverdueBlockDays(venueId, null);
    }
  });

  it("an invoice not yet past its day is not listed", async () => {
    const { invoice } = await overdueAccount("Not Late Bhd", 0);
    expect((await overdueAccountsAttention([venueId])).some((i) => i.id === invoice.id)).toBe(false);
  });

  it("is reminded the first day it is overdue and weekly after, once each, and not once paid", async () => {
    const { accountId, invoice } = await overdueAccount("Reminded Bhd", 1);
    const mails = async () =>
      (await getDb()
        .prepare("SELECT subject, body FROM messages WHERE kind = 'account_invoice' AND recipient = (SELECT email FROM venue_accounts WHERE id = ?) AND dedupe_key LIKE 'account-overdue:%' ORDER BY id")
        .all(accountId)) as { subject: string; body: string }[];
    const on = (offset: number) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(`${addDays(today(), offset)}T10:00:00+08:00`));
    };
    vi.useRealTimers();
    // Other overdue invoices in this venue are reminded by the same tick: this account's mail is what is counted.
    await remindOverdueAccountInvoices();
    expect(await mails()).toHaveLength(1);
    expect((await mails())[0].subject).toContain("overdue");
    expect((await mails())[0].body).toContain(invoice.number);
    // Again at once, and a few days on: nothing more.
    await remindOverdueAccountInvoices();
    expect(await mails()).toHaveLength(1);
    on(3);
    await remindOverdueAccountInvoices();
    expect(await mails()).toHaveLength(1);
    // A week on: the next, once.
    on(7);
    await remindOverdueAccountInvoices();
    await remindOverdueAccountInvoices();
    expect(await mails()).toHaveLength(2);
    // Paid: no more.
    await markInvoicePaid(venueId, invoice.id, "cash");
    on(20);
    await remindOverdueAccountInvoices();
    expect(await mails()).toHaveLength(2);
  });

  it("two ticks at once send one reminder", async () => {
    const { accountId } = await overdueAccount("Twice Bhd", 5);
    const [a, b] = await Promise.all([remindOverdueAccountInvoices(), remindOverdueAccountInvoices()]);
    expect(a + b).toBeGreaterThanOrEqual(1);
    const n = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages WHERE dedupe_key LIKE 'account-overdue:%' AND recipient = (SELECT email FROM venue_accounts WHERE id = ?)").get(accountId)) as { n: number };
    expect(n.n).toBe(1);
  });
});
