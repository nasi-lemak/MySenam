import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import {
  accountsForUser,
  addBooker,
  chargeToAccount,
  closeAccount,
  invoiceByToken,
  invoiceLines,
  issueDueAccountInvoices,
  issueInvoice,
  listAccounts,
  markInvoicePaid,
  saveAccount,
  takeOffAccount,
  withdrawInvoice,
} from "../src/lib/accounts";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { exportPhoneData } from "../src/lib/privacy";
import { createBooking, createCourt, createVenue, findBooking } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { POST as book } from "../src/app/api/bookings/route";
import { POST as chargeRoute } from "../src/app/api/admin/accounts/charge/route";
import { POST as openRoute } from "../src/app/api/admin/accounts/route";

/**
 * Company and school accounts: their people book through the month, the
 * venue invoices the account once, and marks the invoice paid.
 */

let venueId: number;
let courtId: number;
let otherCourt: number;
let schoolId: number;
let teacher: { id: number; cookie: string };
const date = addDays(todayISO(), 2);
const thisMonth = todayISO().slice(0, 7);

beforeAll(async () => {
  const made = await createVenue({ name: "Arena Sekolah", area: "Klang", address: "1 Jalan Sekolah", phone: "0333331111" });
  const other = await createVenue({ name: "Elsewhere", area: "Ipoh", address: "x", phone: "0555552222" });
  if (!made.ok || !other.ok) throw new Error("venue");
  venueId = made.venue.id;
  const c = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  const o = await createCourt({ venueId: other.venue.id, name: "Court X", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!c.ok || !o.ok) throw new Error("court");
  courtId = c.court.id;
  otherCourt = o.court.id;
  const u = await registerUser({ name: "Cikgu Rahim", email: "rahim@sekolah.edu.my", phone: "0129990001", password: "password-123" });
  if (!u.ok) throw new Error(u.error);
  teacher = { id: u.user.id, cookie: `${SESSION_COOKIE}=${(await createSession(u.user.id)).token}` };
});

const post = (body: Record<string, unknown>, cookie?: string) =>
  book(
    new NextRequest("http://localhost/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ courtId, date, name: "Cikgu Rahim", phone: "0129990001", ...body }),
    })
  );

describe("opening an account", () => {
  it("needs a name and where the invoices go; a limit is optional", async () => {
    expect(await saveAccount(venueId, { name: "S", email: "bursar@sk.edu.my" })).toMatchObject({ ok: false });
    expect(await saveAccount(venueId, { name: "SK Taman Klang", email: "not-an-email" })).toMatchObject({ ok: false });
    expect(await saveAccount(venueId, { name: "SK Taman Klang", email: "bursar@sk.edu.my", termsDays: 120 })).toMatchObject({ ok: false });
    const made = await saveAccount(venueId, { name: "SK Taman Klang", email: "bursar@sk.edu.my", contact: "Puan Siti", termsDays: 14, creditLimit: 100 });
    if (!made.ok) throw new Error(made.error);
    schoolId = made.account.id;
    expect(made.account).toMatchObject({ termsDays: 14, creditLimit: 100, uninvoiced: 0, owing: 0 });
  });

  it("is a manager's to open; the desk cannot", async () => {
    const desk = await createAdmin({ name: "Desk", email: "desk@sekolah.my", password: "desk-password-1", venueId, role: "desk" });
    if (!desk.ok) throw new Error(desk.error);
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
    const res = await openRoute(
      new NextRequest("http://localhost/api/admin/accounts", { method: "POST", headers: { cookie }, body: JSON.stringify({ venueId, name: "X Sdn Bhd", email: "x@x.my" }) })
    );
    expect(res.status).toBe(403);
  });
});

describe("booking on the account", () => {
  it("is for somebody signed in whose proved number the account lists", async () => {
    expect((await addBooker(venueId, schoolId, { name: "Cikgu Rahim", phone: "012-999 0001" })).ok).toBe(true);
    // Listed, but the number is not proved on the account yet.
    expect(await accountsForUser(venueId, teacher.id)).toEqual([]);
    expect((await post({ hours: [9], chargeTo: schoolId }, teacher.cookie)).status).toBe(403);
    await getDb().prepare("UPDATE users SET verified_phone = ? WHERE id = ?").run("60129990001", teacher.id);
    expect(await accountsForUser(venueId, teacher.id)).toEqual([{ id: schoolId, name: "SK Taman Klang" }]);
    // Nobody signed out can, whatever number they type.
    expect((await post({ hours: [9], chargeTo: schoolId })).status).toBe(403);
  });

  it("stands unpaid on the account, with nothing to pay online", async () => {
    const res = await post({ hours: [9, 10], chargeTo: schoolId }, teacher.cookie);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ account: { name: "SK Taman Klang" }, payOnline: false, holdUntil: null });
    expect(body.booking).toMatchObject({ accountId: schoolId, paymentStatus: "unpaid", totalPrice: 40 });
    expect((await listAccounts(venueId))[0]).toMatchObject({ uninvoiced: 40, owing: 0 });
  });

  it("is refused past the account's limit, and nothing is booked", async () => {
    const before = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings").get()) as { n: number };
    const res = await post({ hours: [11, 12, 13, 14], chargeTo: schoolId }, teacher.cookie);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("ACCOUNT_OVER_LIMIT");
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings").get()) as { n: number }).n).toBe(before.n);
  });

  it("can be put on by the desk, and taken off until invoiced; only for this venue's bookings", async () => {
    const walkIn = await createBooking({ courtId, date, hours: [15], name: "Coach Lee", phone: "0177770001" });
    const away = await createBooking({ courtId: otherCourt, date, hours: [15], name: "Coach Lee", phone: "0177770001" });
    if (!walkIn.ok || !away.ok) throw new Error("booking");
    expect((await chargeToAccount(venueId, schoolId, [away.booking.id])).ok).toBe(false);
    const desk = await createAdmin({ name: "Desk 2", email: "desk2@sekolah.my", password: "desk-password-2", venueId, role: "desk" });
    if (!desk.ok) throw new Error(desk.error);
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
    const charge = (body: unknown) =>
      chargeRoute(new NextRequest("http://localhost/api/admin/accounts/charge", { method: "POST", headers: { cookie }, body: JSON.stringify(body) }));
    expect((await charge({ bookingId: walkIn.booking.id, accountId: schoolId })).status).toBe(200);
    expect((await listAccounts(venueId))[0].uninvoiced).toBe(60);
    expect((await charge({ bookingId: walkIn.booking.id, accountId: null })).status).toBe(200);
    expect((await listAccounts(venueId))[0].uninvoiced).toBe(40);
    expect((await charge({ bookingId: away.booking.id, accountId: schoolId })).status).toBe(403);
  });
});

describe("the month's invoice", () => {
  let token: string;
  let invoiceId: number;

  it("puts what was played on one invoice, emailed to the account; once", async () => {
    // Played: put the account's booking in the past.
    const played = addDays(todayISO(), -1);
    await getDb().prepare("UPDATE bookings SET date = ? WHERE account_id = ?").run(played, schoolId);
    const invoice = await issueInvoice(schoolId, played.slice(0, 7));
    if (!invoice) throw new Error("no invoice");
    expect(invoice).toMatchObject({ accountName: "SK Taman Klang", total: 40, dueOn: addDays(todayISO(), 14) });
    token = invoice.token;
    invoiceId = invoice.id;
    expect(await invoiceLines(invoice.id)).toEqual([expect.objectContaining({ bookedBy: "Cikgu Rahim", amount: 40, courtName: "Court 1" })]);
    expect((await invoiceByToken(token))?.id).toBe(invoice.id);
    const mail = (await getDb().prepare("SELECT recipient, body FROM messages WHERE kind = 'account_invoice'").all()) as { recipient: string; body: string }[];
    expect(mail).toHaveLength(1);
    expect(mail[0].recipient).toBe("bursar@sk.edu.my");
    expect(mail[0].body).toContain(`/account-invoice/${token}`);
    // Nothing left to invoice.
    expect(await issueInvoice(schoolId, played.slice(0, 7))).toBeNull();
    expect((await listAccounts(venueId))[0]).toMatchObject({ uninvoiced: 0, owing: 40 });
  });

  it("withdrawn, its bookings wait for the next; paid, so is each booking on it", async () => {
    expect(await withdrawInvoice(venueId, invoiceId)).toBe(true);
    expect((await listAccounts(venueId))[0]).toMatchObject({ uninvoiced: 40, owing: 0 });
    const again = await issueInvoice(schoolId, thisMonth, { email: false });
    if (!again) throw new Error("no invoice");
    expect(await markInvoicePaid(venueId, again.id, "bitcoin")).toMatchObject({ ok: false });
    expect(await markInvoicePaid(venueId, again.id, "transfer")).toMatchObject({ ok: true, invoice: { paidVia: "transfer" } });
    const code = (await invoiceLines(again.id))[0].code;
    expect(await findBooking(code, "0129990001")).toMatchObject({ paymentStatus: "paid", paidVia: "transfer" });
    expect(await withdrawInvoice(venueId, again.id)).toBe(false);
    expect((await listAccounts(venueId))[0]).toMatchObject({ uninvoiced: 0, owing: 0 });
  });

  it("is issued early each month for last month's, by itself", async () => {
    const lastMonthDay = addDays(`${thisMonth}-01`, -3);
    const b = await createBooking({ courtId, date: addDays(todayISO(), 3), hours: [17], name: "Cikgu Rahim", phone: "0129990001" });
    if (!b.ok) throw new Error("booking");
    expect((await chargeToAccount(venueId, schoolId, [b.booking.id])).ok).toBe(true);
    await getDb().prepare("UPDATE bookings SET date = ? WHERE id = ?").run(lastMonthDay, b.booking.id);
    expect(await issueDueAccountInvoices()).toBe(1);
    expect(await issueDueAccountInvoices()).toBe(0);
    expect(await takeOffAccount(venueId, b.booking.id)).toBe(false);
  });
});

describe("the numbers on an account", () => {
  it("go out with what the venue holds against a number, and a closed account takes no more", async () => {
    const held = await exportPhoneData([venueId], "0129990001");
    expect(held.accountBookers).toEqual([expect.objectContaining({ account: "SK Taman Klang", name: "Cikgu Rahim" })]);
    expect(await closeAccount(venueId, schoolId)).toBe(true);
    expect(await accountsForUser(venueId, teacher.id)).toEqual([]);
    expect((await post({ hours: [18], chargeTo: schoolId }, teacher.cookie)).status).toBe(403);
  });
});
