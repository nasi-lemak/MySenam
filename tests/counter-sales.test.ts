import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { salesJournal } from "../src/lib/accounting";
import { createAddon } from "../src/lib/addons";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { counterDay, sellAtCounter, voidCounterSale } from "../src/lib/counter-sales";
import { documentFor } from "../src/lib/documents";
import { venueReport } from "../src/lib/reports";
import { createVenue } from "../src/lib/store";
import { setVenueTax } from "../src/lib/tax";
import { todayISO } from "../src/lib/time";
import { POST as sellRoute } from "../src/app/api/admin/counter-sales/route";
import { POST as voidRoute } from "../src/app/api/admin/counter-sales/[id]/void/route";

/**
 * Selling over the counter with no booking: from the venue's list or typed
 * in, receipted with the venue's tax inside, counted per day by how it was
 * paid, and voided by a manager with a credit note.
 */

let venueId: number;
let otherVenueId: number;
let drink: number;
let racket: number;
let foreign: number;
let asDesk: string;
let asManager: string;
const today = todayISO("Asia/Kuala_Lumpur");

beforeAll(async () => {
  const made = await createVenue({ name: "Till Hall", area: "PJ", address: "x", phone: "0366660000" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const other = await createVenue({ name: "Other Hall", area: "PJ", address: "x", phone: "0366660001" });
  if (!other.ok) throw new Error("venue");
  otherVenueId = other.venue.id;
  await setVenueTax(venueId, { registered: true, name: "SST", rate: 6, regNo: "W10-1808-31000001" });
  const d = await createAddon(venueId, { name: "100Plus", kind: "sale", price: 3.5 });
  const r = await createAddon(venueId, { name: "Racket", kind: "rental", price: 5, stock: 4 });
  const f = await createAddon(otherVenueId, { name: "Towel", kind: "sale", price: 2 });
  if (!d.ok || !r.ok || !f.ok) throw new Error("addons");
  drink = d.value.id;
  racket = r.value.id;
  foreign = f.value.id;
  const desk = await createAdmin({ name: "Desk", email: "desk@till.my", password: "desk-password-1", venueId, role: "desk" });
  const mgr = await createAdmin({ name: "Mgr", email: "mgr@till.my", password: "mgr-password-12", venueId });
  if (!desk.ok || !mgr.ok) throw new Error("admins");
  asDesk = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
  asManager = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(mgr.admin.id)).token}`;
});

const post = (handler: typeof sellRoute, url: string, cookie: string, body: unknown, params?: Record<string, string>) =>
  (handler as (req: NextRequest, ctx?: unknown) => Promise<Response>)(
    new NextRequest(url, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }),
    params ? { params: Promise.resolve(params) } : undefined
  );

describe("a counter sale", () => {
  let saleId: number;

  it("is rung up by the desk from the list and typed in, and receipted with the tax inside", async () => {
    const res = await post(sellRoute, "http://localhost/api/admin/counter-sales", asDesk, {
      venueId,
      via: "qr",
      customerName: "Mei",
      items: [
        { addonId: drink, quantity: 2 },
        { addonId: racket, quantity: 1 },
        { name: "Grip tape", price: 8, quantity: 1 },
      ],
    });
    expect(res.status).toBe(200);
    const { sale } = await res.json();
    saleId = sale.id;
    expect(sale).toMatchObject({ total: 20, paidVia: "qr", customerName: "Mei" });
    expect(sale.lines.map((l: { name: string }) => l.name)).toEqual(["100Plus", "Racket (hire)", "Grip tape"]);
    const receipt = (await documentFor(`sale:${sale.id}`))!;
    expect(receipt).toMatchObject({ kind: "receipt", total: 20, customerName: "Mei", paidVia: "DuitNow QR / e-wallet" });
    expect(receipt.tax).toMatchObject({ name: "SST", rate: 6, amount: 1.13 });
    expect(receipt.lines[0]).toEqual({ description: "100Plus × 2", amount: 7 });
    expect(sale.receipt.path).toMatch(/^\/receipt\/R\d+\?t=/);
  });

  it("is refused for nothing, a bad price, no payment method or another venue's item", async () => {
    expect(await sellAtCounter({ venueId, adminId: null, items: [], via: "cash" })).toMatchObject({ ok: false });
    expect(await sellAtCounter({ venueId, adminId: null, items: [{ name: "Thing", price: -1 }], via: "cash" })).toMatchObject({ ok: false });
    expect(await sellAtCounter({ venueId, adminId: null, items: [{ addonId: drink }], via: "online" })).toMatchObject({ ok: false });
    expect(await sellAtCounter({ venueId, adminId: null, items: [{ addonId: foreign }], via: "cash" })).toMatchObject({
      ok: false,
      error: "That item is not on this venue's list.",
    });
  });

  it("adds up the day by how it was paid", async () => {
    await sellAtCounter({ venueId, adminId: null, items: [{ addonId: drink }], via: "cash" });
    const day = await counterDay(venueId, today);
    expect(day.total).toBe(23.5);
    expect(day.byMethod).toEqual(expect.arrayContaining([{ via: "qr", total: 20 }, { via: "cash", total: 3.5 }]));
    expect(day.sales[1]).toMatchObject({ soldBy: "Desk" });
  });

  it("is voided only by a manager, with a reason, once, and credited", async () => {
    expect((await post(voidRoute, `http://localhost/api/admin/counter-sales/${saleId}/void`, asDesk, { reason: "Wrong item" }, { id: String(saleId) })).status).toBe(403);
    expect(await voidCounterSale(saleId, null, "")).toMatchObject({ ok: false });
    const res = await post(voidRoute, `http://localhost/api/admin/counter-sales/${saleId}/void`, asManager, { reason: "Wrong item" }, { id: String(saleId) });
    expect(res.status).toBe(200);
    expect((await res.json()).sale).toMatchObject({ voidReason: "Wrong item" });
    const receipt = (await documentFor(`sale:${saleId}`))!;
    expect(await documentFor(`credit:${receipt.id}`)).toMatchObject({ kind: "credit_note", total: 20, note: "receipt.why.voided" });
    expect(await voidCounterSale(saleId, null, "Again")).toMatchObject({ ok: false });
    expect((await counterDay(venueId, today)).total).toBe(3.5);
  });

  it("shows in the reports and the accounting export as counter sales", async () => {
    expect((await venueReport(venueId, today, today))!.counterSales).toEqual({ sales: 1, total: 3.5 });
    const rows = (await salesJournal(venueId, today, today)).filter((r) => r.category === "Counter sales");
    expect(rows.map((r) => r.gross).sort((a, b) => a - b)).toEqual([-20, 3.5, 20]);
  });
});
