import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { listActivity } from "../src/lib/activity";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { counterPrice } from "../src/lib/counter-prices";
import { getDb } from "../src/lib/db";
import { addMonths, createPlan } from "../src/lib/membership-plans";
import { createCourt, createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import * as productsRoute from "../src/app/api/admin/pass-products/route";
import * as passesRoute from "../src/app/api/admin/passes/route";
import * as membershipsRoute from "../src/app/api/admin/memberships/route";

/**
 * X1-19: the counter sells passes and memberships from the venue's own list,
 * at its price and for its term. Anything else is a manager's, with a reason,
 * written with the sale and in the activity log; front desk is refused.
 */

const today = todayISO();
let venueId: number;
let otherVenueId: number;
let asDesk: string;
let asManager: string;
let asOtherManager: string;
let planId: number;
let n = 0;
const phone = () => `01277${String(++n).padStart(5, "0")}`;

const req = (url: string, method: string, cookie: string, body?: unknown) =>
  new NextRequest(`http://localhost${url}`, {
    method,
    headers: { cookie, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeAll(async () => {
  const v = await createVenue({ name: "Price Hall", area: "PJ", address: "x", phone: "0355550000" });
  const o = await createVenue({ name: "Other Hall", area: "PJ", address: "x", phone: "0355550001" });
  if (!v.ok || !o.ok) throw new Error("venue");
  venueId = v.venue.id;
  otherVenueId = o.venue.id;
  await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  const desk = await createAdmin({ name: "Desk Ida", email: "ida@price.my", password: "desk-password-1", venueId, role: "desk" });
  const mgr = await createAdmin({ name: "Manager Ali", email: "ali@price.my", password: "manager-password-1", venueId });
  const other = await createAdmin({ name: "Other Mgr", email: "o@price.my", password: "manager-password-2", venueId: otherVenueId });
  if (!desk.ok || !mgr.ok || !other.ok) throw new Error("admins");
  asDesk = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
  asManager = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(mgr.admin.id)).token}`;
  asOtherManager = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(other.admin.id)).token}`;
  const plan = await createPlan(venueId, { name: "Quarterly", months: 3, price: 90 });
  if (!plan.ok) throw new Error(plan.error);
  planId = plan.plan.id;
});

describe("the rule", () => {
  const desk = { id: 1, name: "D", role: "desk" as const };
  const mgr = { id: 2, name: "M", role: "manager" as const };
  it("is the list price for anybody; another price or term, or no list, is a manager's with a reason", () => {
    expect(counterPrice({ seller: desk, listPrice: 50, asked: undefined, reason: undefined })).toEqual({ ok: true, price: 50, override: null });
    expect(counterPrice({ seller: desk, listPrice: 50, asked: 50, reason: undefined })).toEqual({ ok: true, price: 50, override: null });
    expect(counterPrice({ seller: desk, listPrice: 50, asked: 40, reason: "A good reason" })).toMatchObject({ ok: false, status: 403, code: "P8B_PRICE_MANAGER" });
    expect(counterPrice({ seller: desk, listPrice: 50, asked: 50, termDiffers: true, reason: "A good reason" })).toMatchObject({ ok: false, code: "P8B_PRICE_MANAGER" });
    expect(counterPrice({ seller: desk, listPrice: null, asked: 50, reason: "A good reason" })).toMatchObject({ ok: false, status: 403, code: "P8B_SELL_FROM_LIST" });
    expect(counterPrice({ seller: mgr, listPrice: 50, asked: 40, reason: "abc" })).toMatchObject({ ok: false, status: 400, code: "P8B_PRICE_REASON" });
    expect(counterPrice({ seller: mgr, listPrice: 50, asked: 40, reason: "Loyal customer, ten years" })).toEqual({
      ok: true,
      price: 40,
      override: { listPrice: 50, reason: "Loyal customer, ten years", adminId: 2, adminName: "M" },
    });
    expect(counterPrice({ seller: mgr, listPrice: null, asked: undefined, reason: "No price given" })).toMatchObject({ ok: false, code: "P8B_PRICE_INVALID" });
    expect(counterPrice({ seller: mgr, listPrice: 50, asked: 10.001, reason: "Fractions of a sen" })).toMatchObject({ ok: false, code: "P8B_PRICE_INVALID" });
  });
});

describe("pass products", () => {
  let productId: number;

  it("are a manager's to add and retire; the desk reads them", async () => {
    const byDesk = await productsRoute.POST(req("/api/admin/pass-products", "POST", asDesk, { venueId, name: "Ten", entries: 10, price: 100, validDays: 60 }));
    expect(byDesk.status).toBe(403);
    expect((await byDesk.json()).code).toBe("MANAGER_ONLY");
    expect((await productsRoute.POST(req("/api/admin/pass-products", "POST", asManager, { venueId, name: "x", entries: 10, price: 100, validDays: 60 }))).status).toBe(400);
    expect((await productsRoute.POST(req("/api/admin/pass-products", "POST", asManager, { venueId, name: "Ten", entries: 10, price: 100, validDays: 0 }))).status).toBe(400);
    expect((await productsRoute.POST(req("/api/admin/pass-products", "POST", asOtherManager, { venueId, name: "Ten", entries: 10, price: 100, validDays: 60 }))).status).toBe(403);
    const made = await productsRoute.POST(
      req("/api/admin/pass-products", "POST", asManager, { venueId, name: "Ten badminton", entries: 10, entryMinutes: 90, sport: "badminton", scope: "places", price: 100, validDays: 60 })
    );
    expect(made.status).toBe(201);
    productId = (await made.json()).product.id;
    const listed = await (await productsRoute.GET(req(`/api/admin/pass-products?venueId=${venueId}`, "GET", asDesk))).json();
    expect(listed.products).toEqual([expect.objectContaining({ id: productId, name: "Ten badminton", price: 100, validDays: 60, entryMinutes: 90, scope: "places" })]);
  });

  it("sell at their price and on their terms from the desk", async () => {
    const res = await passesRoute.POST(req("/api/admin/passes", "POST", asDesk, { venueId, productId, holderName: "Nina", holderPhone: phone(), via: "cash" }));
    expect(res.status).toBe(201);
    const { pass } = await res.json();
    expect(pass).toMatchObject({ name: "Ten badminton", entries: 10, entryMinutes: 90, sport: "badminton", scope: "places", price: 100, expiresOn: addDays(today, 59) });
    expect(((await getDb().prepare("SELECT product_id FROM passes WHERE id = ?").get(pass.id)) as { product_id: number }).product_id).toBe(productId);
    // Its own fields cannot be changed by what the desk sends with it.
    const sneaky = await passesRoute.POST(req("/api/admin/passes", "POST", asDesk, { venueId, productId, entries: 99, holderName: "Nina", holderPhone: phone(), via: "cash" }));
    expect((await sneaky.json()).pass.entries).toBe(10);
  });

  it("another price or term from the desk is refused; a pass not on the list too", async () => {
    const cheaper = await passesRoute.POST(req("/api/admin/passes", "POST", asDesk, { venueId, productId, price: 80, holderName: "Omar", holderPhone: phone(), via: "cash" }));
    expect(cheaper.status).toBe(403);
    expect((await cheaper.json()).code).toBe("P8B_PRICE_MANAGER");
    const longer = await passesRoute.POST(req("/api/admin/passes", "POST", asDesk, { venueId, productId, expiresOn: addDays(today, 120), holderName: "Omar", holderPhone: phone(), via: "cash" }));
    expect(longer.status).toBe(403);
    const custom = await passesRoute.POST(
      req("/api/admin/passes", "POST", asDesk, { venueId, name: "Own pass", entries: 5, price: 50, expiresOn: addDays(today, 30), holderName: "Omar", holderPhone: phone(), via: "cash" })
    );
    expect(custom.status).toBe(403);
    expect((await custom.json()).code).toBe("P8B_SELL_FROM_LIST");
  });

  it("a manager sells another price with a reason, kept with the sale and in the log", async () => {
    const none = await passesRoute.POST(req("/api/admin/passes", "POST", asManager, { venueId, productId, price: 80, holderName: "Omar", holderPhone: phone(), via: "card" }));
    expect(none.status).toBe(400);
    expect((await none.json()).code).toBe("P8B_PRICE_REASON");
    const res = await passesRoute.POST(
      req("/api/admin/passes", "POST", asManager, { venueId, productId, price: 80, priceReason: "Club captain discount", holderName: "Omar", holderPhone: phone(), via: "card" })
    );
    expect(res.status).toBe(201);
    const { pass } = await res.json();
    expect(pass.price).toBe(80);
    const row = (await getDb().prepare("SELECT kind, list_price::float AS list, price::float AS price, reason, admin_name FROM counter_price_overrides WHERE sale_id = ? AND kind = 'pass'").get(pass.id)) as Record<string, unknown>;
    expect(row).toEqual({ kind: "pass", list: 100, price: 80, reason: "Club captain discount", admin_name: "Manager Ali" });
    const log = await listActivity([venueId]);
    expect(log.find((a) => a.action === "sale.price_set")?.detail).toContain("Club captain discount");
    const listed = await (await passesRoute.GET(req(`/api/admin/passes?venueId=${venueId}&q=Omar`, "GET", asDesk))).json();
    expect(listed.passes[0].priceSet).toEqual({ listPrice: 100, reason: "Club captain discount", adminName: "Manager Ali" });
    // A pass that is not on the list at all: the manager's, with the reason.
    const custom = await passesRoute.POST(
      req("/api/admin/passes", "POST", asManager, {
        venueId,
        name: "Tournament warm-up",
        entries: 3,
        price: 30,
        expiresOn: addDays(today, 10),
        priceReason: "One-off for the tournament week",
        holderName: "Omar",
        holderPhone: phone(),
        via: "cash",
      })
    );
    expect(custom.status).toBe(201);
  });

  it("retired, or another venue's, are not sold", async () => {
    expect((await productsRoute.DELETE(req(`/api/admin/pass-products?venueId=${venueId}&id=${productId}`, "DELETE", asDesk))).status).toBe(403);
    expect((await productsRoute.DELETE(req(`/api/admin/pass-products?venueId=${venueId}&id=${productId}`, "DELETE", asManager))).status).toBe(200);
    const gone = await passesRoute.POST(req("/api/admin/passes", "POST", asDesk, { venueId, productId, holderName: "Pia", holderPhone: phone(), via: "cash" }));
    expect(gone.status).toBe(400);
    expect((await (await productsRoute.GET(req(`/api/admin/pass-products?venueId=${venueId}`, "GET", asDesk))).json()).products).toEqual([]);
  });
});

describe("memberships at the counter", () => {
  it("on a plan: its fee and its months from the start", async () => {
    const start = addDays(today, 1);
    const res = await membershipsRoute.POST(req("/api/admin/memberships", "POST", asDesk, { venueId, tierId: planId, holderName: "Raj", holderPhone: phone(), startsOn: start, via: "qr" }));
    expect(res.status).toBe(201);
    expect((await res.json()).membership).toMatchObject({ price: 90, startsOn: start, expiresOn: addDays(addMonths(start, 3), -1), tierName: "Quarterly" });
  });

  it("another fee or term, or no plan, is refused to the desk", async () => {
    const cheaper = await membershipsRoute.POST(req("/api/admin/memberships", "POST", asDesk, { venueId, tierId: planId, price: 0, holderName: "Sam", holderPhone: phone(), startsOn: today, via: "qr" }));
    expect(cheaper.status).toBe(403);
    expect((await cheaper.json()).code).toBe("P8B_PRICE_MANAGER");
    const longer = await membershipsRoute.POST(
      req("/api/admin/memberships", "POST", asDesk, { venueId, tierId: planId, expiresOn: addDays(today, 200), holderName: "Sam", holderPhone: phone(), startsOn: today, via: "qr" })
    );
    expect(longer.status).toBe(403);
    const noPlan = await membershipsRoute.POST(
      req("/api/admin/memberships", "POST", asDesk, { venueId, price: 50, expiresOn: addDays(today, 30), holderName: "Sam", holderPhone: phone(), startsOn: today, via: "qr" })
    );
    expect(noPlan.status).toBe(403);
    expect((await noPlan.json()).code).toBe("P8B_SELL_FROM_LIST");
  });

  it("a manager's other fee needs the reason, and is kept", async () => {
    const holder = phone();
    const without = await membershipsRoute.POST(req("/api/admin/memberships", "POST", asManager, { venueId, tierId: planId, price: 60, holderName: "Tan", holderPhone: holder, startsOn: today, via: "cash" }));
    expect(without.status).toBe(400);
    const res = await membershipsRoute.POST(
      req("/api/admin/memberships", "POST", asManager, { venueId, tierId: planId, price: 60, priceReason: "Staff family rate", holderName: "Tan", holderPhone: holder, startsOn: today, via: "cash" })
    );
    expect(res.status).toBe(201);
    const { membership } = await res.json();
    const listed = await (await membershipsRoute.GET(req(`/api/admin/memberships?venueId=${venueId}&q=${membership.code}`, "GET", asDesk))).json();
    expect(listed.memberships).toHaveLength(1);
    expect(listed.memberships[0].priceSet).toEqual({ listPrice: 90, reason: "Staff family rate", adminName: "Manager Ali" });
  });
});
