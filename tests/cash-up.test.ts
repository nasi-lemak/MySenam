import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { salesJournal, totals } from "../src/lib/accounting";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { registerUser } from "../src/lib/auth";
import { cashUp } from "../src/lib/cash-up";
import { getDb } from "../src/lib/db";
import { documentFor } from "../src/lib/documents";
import { listActivity } from "../src/lib/activity";
import { createPlan } from "../src/lib/membership-plans";
import { createBooking, createCourt, createVenue } from "../src/lib/store";
import { createTournament, enter } from "../src/lib/tournaments";
import { addDays, todayISO } from "../src/lib/time";
import { POST as walletPost } from "../src/app/api/admin/wallet/route";
import { POST as passesPost } from "../src/app/api/admin/passes/route";
import { POST as productsPost } from "../src/app/api/admin/pass-products/route";
import { POST as membershipsPost } from "../src/app/api/admin/memberships/route";
import { POST as paymentsPost } from "../src/app/api/admin/payments/route";
import { POST as salesPost } from "../src/app/api/admin/counter-sales/route";
import { POST as passVoid } from "../src/app/api/admin/passes/[id]/void/route";
import { POST as entryPost } from "../src/app/api/admin/tournaments/[id]/entries/[entryId]/route";
import { GET as cashUpGet } from "../src/app/api/admin/cash-up/route";

/**
 * X1-2: every counter sale says how it was paid, and the cash-up adds up a
 * day's receipts and credit notes from every source by method, for one member
 * of staff or everybody, out of the sales journal itself: its totals are the
 * journal's.
 */

const ZONE = "Asia/Kuala_Lumpur";
const today = todayISO(ZONE);
let venueId: number;
let courtId: number;
let deskId: number;
let managerId: number;
let asDesk: string;
let asManager: string;
let asOtherDesk: string;
let customerId: number;
let planId: number;

const call = (handler: (req: NextRequest, ctx: never) => Promise<Response>, url: string, cookie: string, body?: unknown, params: Record<string, string> = {}) =>
  handler(
    new NextRequest(`http://localhost${url}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve(params) } as never
  );

beforeAll(async () => {
  const v = await createVenue({ name: "Till Arena", area: "PJ", address: "x", phone: "0377770000" });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  const c = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 30, peakRate: 30 });
  if (!c.ok) throw new Error("court");
  courtId = c.court.id;
  const desk = await createAdmin({ name: "Dee Desk", email: "dee@till.my", password: "desk-password-1", venueId, role: "desk" });
  const other = await createAdmin({ name: "Ola Desk", email: "ola@till.my", password: "desk-password-2", venueId, role: "desk" });
  const mgr = await createAdmin({ name: "Mo Manager", email: "mo@till.my", password: "manager-password-1", venueId });
  if (!desk.ok || !other.ok || !mgr.ok) throw new Error("admins");
  deskId = desk.admin.id;
  managerId = mgr.admin.id;
  asDesk = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(deskId)).token}`;
  asOtherDesk = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(other.admin.id)).token}`;
  asManager = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(managerId)).token}`;
  const u = await registerUser({ name: "Cara Customer", email: "cara@till.my", phone: "0129990001", password: "a long enough password" });
  if (!u.ok) throw new Error("user");
  customerId = u.user.id;
  const plan = await createPlan(venueId, { name: "Annual", months: 12, price: 300 });
  if (!plan.ok) throw new Error(plan.error);
  planId = plan.plan.id;
});

describe("every counter sale says how it was paid", () => {
  it("a credit top-up: refused without a method, receipted with it and with who took it", async () => {
    const none = await call(walletPost, "/api/admin/wallet", asDesk, { userId: customerId, amount: 50, venueId });
    expect(none.status).toBe(400);
    expect((await none.json()).code).toBe("P8B_VIA_REQUIRED");
    expect((await call(walletPost, "/api/admin/wallet", asDesk, { userId: customerId, amount: 50, venueId, via: "online" })).status).toBe(400);
    const res = await call(walletPost, "/api/admin/wallet", asDesk, { userId: customerId, amount: 50, venueId, via: "cash" });
    expect(res.status).toBe(201);
    const { id } = (await getDb().prepare("SELECT id FROM wallet_entries WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(customerId)) as { id: number };
    expect(await documentFor(`wallet:${id}`)).toMatchObject({ kind: "receipt", total: 50, paidVia: "Cash", staffName: "Dee Desk" });
  });

  it("a pass from the venue's list, and a membership on a plan, each by its method", async () => {
    const product = await call(productsPost, "/api/admin/pass-products", asManager, { venueId, name: "Ten sessions", entries: 10, price: 120, validDays: 90 });
    expect(product.status).toBe(201);
    const productId = (await product.json()).product.id;
    const noVia = await call(passesPost, "/api/admin/passes", asDesk, { venueId, productId, holderName: "Pat", holderPhone: "0128880001" });
    expect(noVia.status).toBe(400);
    expect((await noVia.json()).code).toBe("P8B_VIA_REQUIRED");
    const pass = await call(passesPost, "/api/admin/passes", asDesk, { venueId, productId, holderName: "Pat", holderPhone: "0128880001", via: "qr" });
    expect(pass.status).toBe(201);
    const sold = (await pass.json()).pass;
    expect(sold).toMatchObject({ name: "Ten sessions", entries: 10, price: 120, expiresOn: addDays(todayISO(), 89) });
    expect(await documentFor(`pass:${sold.id}`)).toMatchObject({ total: 120, paidVia: "DuitNow QR / e-wallet", staffName: "Dee Desk" });

    const m = await call(membershipsPost, "/api/admin/memberships", asDesk, { venueId, tierId: planId, holderName: "Mira", holderPhone: "0128880002", startsOn: today, via: "card" });
    expect(m.status).toBe(201);
    const membership = (await m.json()).membership;
    expect(membership).toMatchObject({ price: 300, startsOn: today });
    expect(await documentFor(`membership:${membership.id}`)).toMatchObject({ total: 300, paidVia: "Card terminal", staffName: "Dee Desk" });
    // A free one (a manager's, with a reason) asks no method.
    const free = await call(membershipsPost, "/api/admin/memberships", asManager, {
      venueId,
      holderName: "Coach Kim",
      holderPhone: "0128880003",
      startsOn: today,
      expiresOn: addDays(today, 30),
      price: 0,
      priceReason: "Our coach, free while she teaches here",
    });
    expect(free.status).toBe(201);
  });

  it("a tournament entry fee marked paid: by its method, or refused without one", async () => {
    const t = await createTournament(
      {
        venueId,
        name: "Till Cup",
        sport: "badminton",
        format: "knockout",
        teamSize: 1,
        level: null,
        entryFee: 20,
        maxEntries: 8,
        startsOn: addDays(today, 10),
        endsOn: addDays(today, 10),
        startHour: 9,
        endHour: 21,
        courtIds: [courtId],
      },
      managerId
    );
    if (!t.ok) throw new Error(t.error);
    const player = await registerUser({ name: "Eli Entrant", email: "eli@till.my", phone: "0129990002", password: "a long enough password" });
    if (!player.ok) throw new Error("player");
    const e = await enter(player.user, t.value.id);
    if (!e.ok) throw new Error(e.error);
    const params = { id: String(t.value.id), entryId: String(e.value.id) };
    const none = await call(entryPost, "", asDesk, { paid: true }, params);
    expect(none.status).toBe(400);
    expect((await none.json()).code).toBe("P8B_VIA_REQUIRED");
    expect((await call(entryPost, "", asDesk, { paid: true, via: "transfer" }, params)).status).toBe(200);
    const receipt = (await getDb().prepare("SELECT paid_via, staff_name FROM receipts WHERE source LIKE ?").get(`entry:${e.value.id}@%`)) as { paid_via: string; staff_name: string };
    expect(receipt).toEqual({ paid_via: "Bank transfer", staff_name: "Dee Desk" });
  });
});

describe("the cash-up", () => {
  beforeAll(async () => {
    // A booking marked paid in cash by the desk, a counter sale by the manager, and a pass voided by the manager, its
    // unused part (all of it) handed back.
    const b = await createBooking({ courtId, date: addDays(today, 2), hours: [10], name: "Ben", phone: "0128880009" });
    if (!b.ok) throw new Error(b.error);
    expect((await call(paymentsPost, "/api/admin/payments", asDesk, { code: b.booking.code, paid: true, via: "cash" })).status).toBe(200);
    expect((await call(salesPost, "/api/admin/counter-sales", asManager, { venueId, via: "transfer", items: [{ name: "Grip", price: 8, quantity: 1 }] })).status).toBe(200);
    const pass = (await getDb().prepare("SELECT id FROM passes WHERE venue_id = ? ORDER BY id LIMIT 1").get(venueId)) as { id: number };
    expect((await call(passVoid, "", asManager, { refund: true }, { id: String(pass.id) })).status).toBe(200);
  });

  it("adds up the day by method out of the journal, row for row", async () => {
    const day = await cashUp(venueId, today, null);
    const journal = await salesJournal(venueId, today, today, { counter: true });
    // Credit is the install's own here: its top-up is in this till, not in this venue's books.
    const books = await salesJournal(venueId, today, today);
    expect(journal.length - books.length).toBe(1);
    expect(books.some((r) => r.category === "Stored credit")).toBe(false);
    expect(journal.find((r) => r.category === "Stored credit")).toMatchObject({ gross: 50, method: "cash", staffName: "Dee Desk" });
    expect(day.entries).toHaveLength(journal.length);
    expect(day.entries.reduce((s, e) => s + e.gross, 0)).toBeCloseTo(journal.reduce((s, r) => s + r.gross, 0), 2);
    // What came in each way is the journal's own "received each way".
    const received = totals(journal).byPaidVia;
    for (const m of day.byMethod) {
      const label = { cash: "Cash", qr: "DuitNow QR / e-wallet", transfer: "Bank transfer", card: "Card terminal" }[m.method as string];
      if (label) expect(m.taken).toBeCloseTo(received.find((r) => r.paidVia === label)?.gross ?? 0, 2);
    }
    const by = Object.fromEntries(day.byMethod.map((m) => [m.method, m]));
    expect(by.cash).toMatchObject({ taken: 80, givenBack: 0, net: 80 }); // 50 credit + 30 booking
    expect(by.qr).toMatchObject({ taken: 120, givenBack: 120, net: 0 }); // the pass, then voided
    expect(by.card).toMatchObject({ taken: 300, net: 300 });
    expect(by.transfer).toMatchObject({ taken: 28, net: 28 }); // the entry fee and the grip
    expect(day.totals).toEqual({ taken: 528, givenBack: 120, net: 408 });
    expect(day.staff.map((s) => s.name)).toEqual(["Dee Desk", "Mo Manager"]);
  });

  it("for one member of staff: what they took and gave back", async () => {
    const mine = await cashUp(venueId, today, deskId);
    expect(mine.totals).toEqual({ taken: 520, givenBack: 0, net: 520 });
    expect(mine.entries.every((e) => e.staffName === "Dee Desk")).toBe(true);
    const manager = await cashUp(venueId, today, managerId);
    expect(manager.totals).toEqual({ taken: 8, givenBack: 120, net: -112 });
  });

  it("front desk sees its own shift only; a manager everybody's, or one person's, any day", async () => {
    const own = await call(cashUpGet, `/api/admin/cash-up?venueId=${venueId}`, asDesk);
    expect(own.status).toBe(200);
    const body = await own.json();
    expect(body).toMatchObject({ scope: "own", staffId: deskId, date: today, staff: [] });
    expect(body.totals.net).toBe(520);
    // Another desk's own is theirs: nothing taken.
    expect((await (await call(cashUpGet, `/api/admin/cash-up?venueId=${venueId}`, asOtherDesk)).json()).totals.net).toBe(0);
    const someoneElse = await call(cashUpGet, `/api/admin/cash-up?venueId=${venueId}&staffId=${managerId}`, asDesk);
    expect(someoneElse.status).toBe(403);
    expect((await someoneElse.json()).code).toBe("P8B_CASHUP_OWN");
    const lastWeek = await call(cashUpGet, `/api/admin/cash-up?venueId=${venueId}&date=${addDays(today, -7)}`, asDesk);
    expect(lastWeek.status).toBe(403);
    expect((await lastWeek.json()).code).toBe("P8B_CASHUP_DAY");
    expect((await call(cashUpGet, `/api/admin/cash-up?venueId=${venueId}&date=${addDays(today, -1)}`, asDesk)).status).toBe(200);

    const all = await (await call(cashUpGet, `/api/admin/cash-up?venueId=${venueId}`, asManager)).json();
    expect(all).toMatchObject({ scope: "all", staffId: null, totals: { net: 408 } });
    const one = await (await call(cashUpGet, `/api/admin/cash-up?venueId=${venueId}&staffId=${deskId}`, asManager)).json();
    expect(one.totals.net).toBe(520);
    expect((await call(cashUpGet, `/api/admin/cash-up?venueId=${venueId}&date=${addDays(today, -30)}`, asManager)).status).toBe(200);
    expect((await call(cashUpGet, `/api/admin/cash-up?venueId=${venueId}&date=nope`, asManager)).status).toBe(400);
  });

  it("where credit is the venue's own, a top-up is in its books and its till alike", async () => {
    const was = process.env.MYSENAM_CREDIT_SCOPE;
    process.env.MYSENAM_CREDIT_SCOPE = "venue";
    try {
      const before = (await cashUp(venueId, today, deskId)).totals.net;
      expect((await call(walletPost, "/api/admin/wallet", asDesk, { userId: customerId, amount: 20, venueId, via: "qr" })).status).toBe(201);
      const row = (await getDb().prepare("SELECT venue_id, counter_venue_id FROM receipts WHERE source LIKE 'wallet:%' ORDER BY id DESC LIMIT 1").get()) as { venue_id: number; counter_venue_id: number | null };
      expect(row).toEqual({ venue_id: venueId, counter_venue_id: null });
      expect((await cashUp(venueId, today, deskId)).totals.net).toBe(before + 20);
      expect((await salesJournal(venueId, today, today)).filter((r) => r.category === "Stored credit")).toHaveLength(1);
    } finally {
      if (was === undefined) delete process.env.MYSENAM_CREDIT_SCOPE;
      else process.env.MYSENAM_CREDIT_SCOPE = was;
    }
  });

  it("is refused for another venue", async () => {
    const other = await createVenue({ name: "Elsewhere", area: "PJ", address: "x", phone: "0377770009" });
    if (!other.ok) throw new Error("venue");
    expect((await call(cashUpGet, `/api/admin/cash-up?venueId=${other.venue.id}`, asDesk)).status).toBe(403);
  });

  it("logs each sale with how it was paid", async () => {
    const log = await listActivity([venueId]);
    expect(log.filter((a) => a.action === "credit.changed").map((a) => a.detail)).toEqual(expect.arrayContaining([expect.stringContaining("by Cash")]));
    expect(log.find((a) => a.action === "pass.sold")?.detail).toContain("by DuitNow QR");
    expect(log.find((a) => a.action === "membership.sold" && a.detail?.includes("Mira"))?.detail).toContain("by Card terminal");
  });
});
