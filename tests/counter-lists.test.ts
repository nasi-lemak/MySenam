import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { readListQuery, textMatch, PAGE_SIZE } from "../src/lib/list-search";
import { createCourt, createVenue, issuePass, sellMembership } from "../src/lib/store";
import { sellVoucher } from "../src/lib/vouchers";
import { addDays, todayISO } from "../src/lib/time";
import { GET as membershipsGet } from "../src/app/api/admin/memberships/route";
import { GET as passesGet } from "../src/app/api/admin/passes/route";
import { GET as receiptsGet } from "../src/app/api/admin/receipts/route";
import { GET as vouchersGet } from "../src/app/api/admin/vouchers/route";
import { GET as invoicesGet } from "../src/app/api/admin/accounts/invoices/route";

/**
 * X1-7: the counter's lists that grow (memberships, passes, receipts, gift
 * vouchers, company invoices) are searched by code, name or number however it
 * is typed, filtered by status ("lapsing within 30 days" among them), and
 * paged, so a record sold a year ago can still be found and acted on.
 */

const today = todayISO();
let venueId: number;
let otherVenueId: number;
let asDesk: string;
let accountId: number;

const get = async (handler: (req: NextRequest) => Promise<Response>, url: string) => {
  const res = await handler(new NextRequest(`http://localhost${url}`, { headers: { cookie: asDesk } }));
  return { status: res.status, body: await res.json() };
};

beforeAll(async () => {
  const v = await createVenue({ name: "List Club", area: "PJ", address: "x", phone: "0344440000" });
  const o = await createVenue({ name: "Other Club", area: "PJ", address: "x", phone: "0344440001" });
  if (!v.ok || !o.ok) throw new Error("venue");
  venueId = v.venue.id;
  otherVenueId = o.venue.id;
  await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  const desk = await createAdmin({ name: "Desk", email: "desk@list.my", password: "desk-password-1", venueId, role: "desk" });
  if (!desk.ok) throw new Error("desk");
  asDesk = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;

  // Sixty members, one a year old and lapsing next week, one already ended.
  for (let i = 1; i <= 60; i++) {
    const lapsing = i === 1;
    const ended = i === 2;
    const made = await sellMembership({
      venueId,
      holderName: i === 1 ? "Aminah Yusof" : `Member ${i}`,
      holderPhone: `0123${String(i).padStart(6, "0")}`,
      startsOn: lapsing || ended ? addDays(today, -358) : today,
      expiresOn: lapsing || ended ? addDays(today, 6) : addDays(today, 365),
      price: 100,
      adminId: desk.admin.id,
    });
    if (!made.ok) throw new Error(made.error);
    // Time passing: this one ended yesterday.
    if (ended) await getDb().prepare("UPDATE memberships SET expires_on = ? WHERE id = ?").run(addDays(today, -1), made.membership.id);
  }
  // Passes: one used up, one ending soon, one cancelled.
  for (const [name, expires, entries] of [
    ["Kumar", addDays(today, 10), 5],
    ["Lee", addDays(today, 90), 1],
    ["Mohd", addDays(today, 90), 5],
  ] as const) {
    const p = await issuePass({ venueId, name: "Five", entries, price: 50, holderName: name, holderPhone: "0198765432", expiresOn: expires, adminId: null });
    if (!p.ok) throw new Error(p.error);
    if (name === "Lee") await getDb().prepare("INSERT INTO pass_entries (pass_id, delta, reason) VALUES (?, -1, 'used')").run(p.pass.id);
    if (name === "Mohd") await getDb().prepare("UPDATE passes SET status = 'void' WHERE id = ?").run(p.pass.id);
  }
  // Vouchers.
  for (const buyer of ["Nadia", "Omar"]) {
    const s = await sellVoucher({ venueId, amount: 50, buyerName: buyer, buyerEmail: `${buyer.toLowerCase()}@mail.my`, buyerPhone: "0171112222", adminId: desk.admin.id, via: "cash" });
    if (!s.ok) throw new Error(s.error);
  }
  await getDb().prepare("UPDATE gift_vouchers SET status = 'redeemed' WHERE buyer_name = 'Omar'").run();
  // Company invoices: one paid, one overdue, one open.
  const a = (await getDb().prepare("INSERT INTO venue_accounts (venue_id, name, email) VALUES (?, 'Sekolah Taman Jaya', 'pe@stj.edu.my') RETURNING id").get(venueId)) as { id: number };
  accountId = a.id;
  const inv = getDb().prepare("INSERT INTO account_invoices (account_id, venue_id, period, issued_on, due_on, total, token, paid_on) VALUES (?, ?, ?, ?, ?, 100, ?, ?)");
  await inv.run(accountId, venueId, "2026-07", "2026-08-01", "2026-08-31", "tok-list-1-abcdefghijklmnop", "2026-08-20");
  await inv.run(accountId, venueId, "2026-08", "2026-09-01", addDays(today, -5), "tok-list-2-abcdefghijklmnop", null);
  await inv.run(accountId, venueId, "2026-09", "2026-10-01", addDays(today, 20), "tok-list-3-abcdefghijklmnop", null);
});

describe("the query", () => {
  it("reads q, status and page, and refuses what it does not know", () => {
    expect(readListQuery(new URLSearchParams("q=%20Ami%20&status=lapsing&page=2"), ["lapsing"])).toEqual({ q: "Ami", status: "lapsing", page: 2 });
    expect(readListQuery(new URLSearchParams(""), ["lapsing"])).toEqual({ q: "", status: null, page: 1 });
    expect(readListQuery(new URLSearchParams("status=all"), ["lapsing"])).toEqual({ q: "", status: null, page: 1 });
    expect(readListQuery(new URLSearchParams("status=nope"), ["lapsing"])).toHaveProperty("error");
    expect(readListQuery(new URLSearchParams("page=0"), ["lapsing"])).toHaveProperty("error");
    // A name's % and _ are searched for, not wild cards; a number is matched as a number, from seven digits.
    expect(textMatch("50%_", { names: ["n"] }).params).toEqual(["%50\\%\\_%"]);
    expect(textMatch("012-345", { names: ["n"], phones: ["p"] }).sql).not.toContain("phone_key");
  });
});

describe("memberships", () => {
  it("come fifty at a time, newest first, with whether there are more", async () => {
    const first = await get(membershipsGet, `/api/admin/memberships?venueId=${venueId}`);
    expect(first.body.memberships).toHaveLength(PAGE_SIZE);
    expect(first.body).toMatchObject({ page: 1, more: true });
    expect(first.body.memberships[0].holderName).toBe("Member 60");
    const second = await get(membershipsGet, `/api/admin/memberships?venueId=${venueId}&page=2`);
    expect(second.body.memberships).toHaveLength(10);
    expect(second.body.more).toBe(false);
  });

  it("are found by name, by number however typed, and by code", async () => {
    expect((await get(membershipsGet, `/api/admin/memberships?venueId=${venueId}&q=aminah`)).body.memberships.map((m: { holderName: string }) => m.holderName)).toEqual(["Aminah Yusof"]);
    const byPhone = await get(membershipsGet, `/api/admin/memberships?venueId=${venueId}&q=${encodeURIComponent("+60 12-300 0001")}`);
    expect(byPhone.body.memberships.map((m: { holderName: string }) => m.holderName)).toEqual(["Aminah Yusof"]);
    const code = byPhone.body.memberships[0].code as string;
    expect((await get(membershipsGet, `/api/admin/memberships?venueId=${venueId}&q=${code.toLowerCase()}`)).body.memberships).toHaveLength(1);
  });

  it("are filtered by status: lapsing within 30 days, expired, active", async () => {
    expect((await get(membershipsGet, `/api/admin/memberships?venueId=${venueId}&status=lapsing`)).body.memberships.map((m: { holderName: string }) => m.holderName)).toEqual(["Aminah Yusof"]);
    expect((await get(membershipsGet, `/api/admin/memberships?venueId=${venueId}&status=expired`)).body.memberships.map((m: { holderName: string }) => m.holderName)).toEqual(["Member 2"]);
    const active = await get(membershipsGet, `/api/admin/memberships?venueId=${venueId}&status=active&page=2`);
    expect(active.body.memberships).toHaveLength(9);
    expect((await get(membershipsGet, `/api/admin/memberships?venueId=${venueId}&status=bogus`)).status).toBe(400);
    expect((await get(membershipsGet, `/api/admin/memberships?venueId=${otherVenueId}`)).status).toBe(403);
  });
});

describe("passes", () => {
  it("by status: used up, lapsing, cancelled; and by name", async () => {
    const names = async (q: string) => (await get(passesGet, `/api/admin/passes?venueId=${venueId}&${q}`)).body.passes.map((p: { holderName: string }) => p.holderName);
    expect(await names("status=used")).toEqual(["Lee"]);
    expect(await names("status=lapsing")).toEqual(["Kumar"]);
    expect(await names("status=cancelled")).toEqual(["Mohd"]);
    expect(await names("status=active")).toEqual(["Kumar"]);
    expect(await names("q=lee")).toEqual(["Lee"]);
    expect(await names("q=0198765432")).toEqual(["Mohd", "Lee", "Kumar"]);
  });
});

describe("receipts", () => {
  it("by number, by customer, receipts or credit notes, paged", async () => {
    const all = await get(receiptsGet, `/api/admin/receipts?venueId=${venueId}`);
    expect(all.body.receipts).toHaveLength(PAGE_SIZE);
    expect(all.body.more).toBe(true);
    const aminah = await get(receiptsGet, `/api/admin/receipts?venueId=${venueId}&q=Aminah`);
    expect(aminah.body.receipts).toHaveLength(1);
    const byNumber = await get(receiptsGet, `/api/admin/receipts?venueId=${venueId}&q=${aminah.body.receipts[0].number}`);
    expect(byNumber.body.receipts.map((r: { customer: string }) => r.customer)).toEqual(["Aminah Yusof"]);
    expect((await get(receiptsGet, `/api/admin/receipts?venueId=${venueId}&status=credit_note`)).body.receipts).toEqual([]);
    expect((await get(receiptsGet, `/api/admin/receipts?venueId=${venueId}&q=0171112222`)).body.receipts).toHaveLength(2);
  });
});

describe("gift vouchers", () => {
  it("by buyer, email or code, and by status", async () => {
    const nadia = await get(vouchersGet, `/api/admin/vouchers?venueId=${venueId}&q=nadia@mail`);
    expect(nadia.body.vouchers.map((v: { buyerName: string }) => v.buyerName)).toEqual(["Nadia"]);
    expect((await get(vouchersGet, `/api/admin/vouchers?venueId=${venueId}&q=${nadia.body.vouchers[0].code}`)).body.vouchers).toHaveLength(1);
    expect((await get(vouchersGet, `/api/admin/vouchers?venueId=${venueId}&status=redeemed`)).body.vouchers.map((v: { buyerName: string }) => v.buyerName)).toEqual(["Omar"]);
    expect((await get(vouchersGet, `/api/admin/vouchers?venueId=${venueId}&status=active`)).body.vouchers.map((v: { buyerName: string }) => v.buyerName)).toEqual(["Nadia"]);
  });
});

describe("company invoices", () => {
  it("by number or account, and open, overdue or paid", async () => {
    const numbers = async (q: string) => (await get(invoicesGet, `/api/admin/accounts/invoices?venueId=${venueId}&${q}`)).body.invoices.map((i: { period: string }) => i.period);
    expect(await numbers("")).toEqual(["2026-09", "2026-08", "2026-07"]);
    expect(await numbers("status=overdue")).toEqual(["2026-08"]);
    expect(await numbers("status=paid")).toEqual(["2026-07"]);
    expect(await numbers("status=open")).toEqual(["2026-09"]);
    expect(await numbers("q=taman")).toHaveLength(3);
    const one = (await get(invoicesGet, `/api/admin/accounts/invoices?venueId=${venueId}&status=paid`)).body.invoices[0];
    expect(await numbers(`q=${one.number}`)).toEqual(["2026-07"]);
    expect((await get(invoicesGet, `/api/admin/accounts/invoices?venueId=${otherVenueId}`)).status).toBe(403);
  });
});
