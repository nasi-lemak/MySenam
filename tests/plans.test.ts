import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, authenticateAdmin, createAdmin, createAdminSession, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { issueDueInvoices, listInvoices, setVenuePlan, venuePlans } from "../src/lib/billing";
import { getDb } from "../src/lib/db";
import { billableResources, planTiers, priceFor, setPlanTiers, SUGGESTED_TIERS } from "../src/lib/plans";
import { createCourt, createVenue } from "../src/lib/store";
import { GET as billingGet, POST as billingPost } from "../src/app/api/admin/billing/route";

/**
 * Prices by venue size: tiers by how many courts and rooms a venue has,
 * counted when each month is invoiced.
 */

let n = 0;
async function venueWith(courts: number): Promise<number> {
  const made = await createVenue({ name: `Sized Venue ${++n}`, area: "PJ", address: "x", phone: "0300000000" });
  if (!made.ok) throw new Error("venue");
  for (let i = 1; i <= courts; i++)
    await createCourt({ venueId: made.venue.id, name: `Court ${i}`, sport: "badminton", offPeakRate: 15, peakRate: 20 });
  return made.venue.id;
}

const NOV_1 = new Date("2026-11-01T01:00:00Z");
let ownerCookie: string;

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const owner = await authenticateAdmin("admin@mysenam.my", process.env.ADMIN_PASSWORD ?? "mysenam-admin");
  ownerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(owner!.id)).token}`;
});

beforeEach(async () => {
  process.env.MYSENAM_MARKETPLACE = "on";
  process.env.MYSENAM_VENUE_FEE = "99";
  await setPlanTiers({ tiers: [], extraEach: 0 });
});

afterEach(() => {
  delete process.env.MYSENAM_MARKETPLACE;
  delete process.env.MYSENAM_VENUE_FEE;
});

describe("tiers", () => {
  it("price a venue by its size, with extra resources past the last limit", () => {
    expect(priceFor(1, SUGGESTED_TIERS)).toEqual({ name: "Starter", fee: 19.9 });
    expect(priceFor(5, SUGGESTED_TIERS)).toEqual({ name: "Starter", fee: 19.9 });
    expect(priceFor(6, SUGGESTED_TIERS)).toEqual({ name: "Growth", fee: 39.9 });
    expect(priceFor(30, SUGGESTED_TIERS)).toEqual({ name: "Large", fee: 69.9 });
    expect(priceFor(50, SUGGESTED_TIERS)).toEqual({ name: "Arena", fee: 99.9 });
    expect(priceFor(53, SUGGESTED_TIERS)).toEqual({ name: "Arena", fee: 105.9 });
    expect(priceFor(0, SUGGESTED_TIERS)).toEqual({ name: "Starter", fee: 19.9 });
    expect(priceFor(3, { tiers: [], extraEach: 0 })).toBeNull();
    expect(priceFor(400, { tiers: [{ name: "All", upTo: null, monthlyFee: 50 }], extraEach: 0 })).toEqual({ name: "All", fee: 50 });
  });

  it("are saved in order and refused when they do not make sense", async () => {
    expect(await setPlanTiers(SUGGESTED_TIERS)).toMatchObject({ ok: true });
    expect(await planTiers()).toEqual(SUGGESTED_TIERS);

    const bad = async (tiers: { name: string; upTo: number | null; monthlyFee: number }[], extraEach = 0) =>
      (await setPlanTiers({ tiers, extraEach })) as { ok: boolean; error?: string };
    expect((await bad([{ name: "", upTo: 5, monthlyFee: 10 }])).error).toMatch(/name/);
    expect((await bad([{ name: "A", upTo: 5, monthlyFee: 10 }, { name: "a", upTo: 9, monthlyFee: 20 }])).error).toMatch(/Two tiers/);
    expect((await bad([{ name: "A", upTo: 5, monthlyFee: 10 }, { name: "B", upTo: 5, monthlyFee: 20 }])).error).toMatch(/above/);
    expect((await bad([{ name: "A", upTo: 2.5, monthlyFee: 10 }])).error).toMatch(/whole number/);
    expect((await bad([{ name: "A", upTo: null, monthlyFee: 10 }, { name: "B", upTo: 9, monthlyFee: 20 }])).error).toMatch(/only the last/);
    expect((await bad([{ name: "A", upTo: 5, monthlyFee: -1 }])).error).toMatch(/RM0/);
    expect((await bad([{ name: "A", upTo: null, monthlyFee: 10 }], 2)).error).toMatch(/no limit/);
    expect((await bad([{ name: "A", upTo: 5, monthlyFee: 10 }], -2)).error).toMatch(/extra/);
    expect((await bad(Array.from({ length: 9 }, (_, i) => ({ name: `T${i}`, upTo: i + 1, monthlyFee: 1 })))).error).toMatch(/Up to 8/);
    // A refusal leaves what was there.
    expect(await planTiers()).toEqual(SUGGESTED_TIERS);
  });
});

describe("counting", () => {
  it("counts courts, but not one out of service for the whole month", async () => {
    const id = await venueWith(4);
    const courts = (await getDb().prepare("SELECT id FROM courts WHERE venue_id = ? ORDER BY id").all(id)) as { id: number }[];
    // Out all of November, out for part of it, and out from October with no end.
    await getDb().prepare("INSERT INTO court_outages (court_id, starts_on, ends_on) VALUES (?, ?, ?)").run(courts[0].id, "2026-10-20", "2026-11-30");
    await getDb().prepare("INSERT INTO court_outages (court_id, starts_on, ends_on) VALUES (?, ?, ?)").run(courts[1].id, "2026-11-03", "2026-11-10");
    await getDb().prepare("INSERT INTO court_outages (court_id, starts_on, ends_on) VALUES (?, ?, ?)").run(courts[2].id, "2026-10-01", null);
    expect((await billableResources([id], "2026-11")).get(id)).toBe(2);
    expect((await billableResources([id], "2026-09")).get(id)).toBe(4);
    expect(await billableResources([], "2026-11")).toEqual(new Map());
  });
});

describe("invoices by size", () => {
  it("charge each venue its tier, say so on the invoice, and keep agreed fees", async () => {
    await setPlanTiers(SUGGESTED_TIERS);
    const small = await venueWith(3);
    const mid = await venueWith(8);
    const agreed = await venueWith(20);
    for (const id of [small, mid, agreed]) await setVenuePlan(id, { monthlyFee: null, billingStartsOn: "2026-10-01" });
    await setVenuePlan(agreed, { monthlyFee: 45, billingStartsOn: "2026-10-01" });

    const issued = await issueDueInvoices(NOV_1);
    const of = (id: number) => issued.find((i) => i.venueId === id);
    expect(of(small)).toMatchObject({ amount: 19.9, planName: "Starter", resources: 3 });
    expect(of(mid)).toMatchObject({ amount: 39.9, planName: "Growth", resources: 8 });
    expect(of(agreed)).toMatchObject({ amount: 45, planName: null, resources: null });

    const plans = await venuePlans([small, agreed], NOV_1);
    expect(plans.find((p) => p.venueId === small)).toMatchObject({ feeFrom: "tier", tierName: "Starter", resources: 3, effectiveFee: 19.9 });
    expect(plans.find((p) => p.venueId === agreed)).toMatchObject({ feeFrom: "own", tierName: "Large", resources: 20, effectiveFee: 45 });

    // Changing the tiers later does not rewrite an invoice already issued.
    await setPlanTiers({ tiers: [{ name: "Flat", upTo: null, monthlyFee: 10 }], extraEach: 0 });
    expect((await listInvoices(mid))[0]).toMatchObject({ amount: 39.9, planName: "Growth" });
  });

  it("go back to the flat default with no tiers", async () => {
    const id = await venueWith(12);
    await setVenuePlan(id, { monthlyFee: null, billingStartsOn: "2026-10-01" });
    expect((await venuePlans([id]))[0]).toMatchObject({ feeFrom: "default", tierName: null, effectiveFee: 99 });
    const issued = (await issueDueInvoices(NOV_1)).find((i) => i.venueId === id);
    expect(issued).toMatchObject({ amount: 99, planName: null });
  });

  it("price each branch of a business by its own size, on one invoice", async () => {
    await setPlanTiers(SUGGESTED_TIERS);
    const business = Number(
      (await getDb().prepare("INSERT INTO businesses (name) VALUES (?)").run("Two Halls Sdn Bhd")).lastInsertRowid
    );
    const a = await venueWith(4);
    const b = await venueWith(16);
    for (const id of [a, b]) {
      await getDb().prepare("UPDATE venues SET business_id = ? WHERE id = ?").run(business, id);
      await setVenuePlan(id, { monthlyFee: null, billingStartsOn: "2026-10-01" });
    }
    const invoice = (await issueDueInvoices(NOV_1)).find((i) => i.businessId === business)!;
    expect(invoice.amount).toBeCloseTo(89.8, 2);
    expect(invoice.lines.map((l) => [l.planName, l.resources, l.amount])).toEqual(
      expect.arrayContaining([
        ["Starter", 4, 19.9],
        ["Large", 16, 69.9],
      ])
    );
  });
});

describe("the billing endpoint", () => {
  const post = (body: unknown, cookie = ownerCookie) =>
    billingPost(
      new NextRequest("http://localhost/api/admin/billing", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(body),
      })
    );

  it("lets the owner set tiers, and shows a venue's staff what they are on", async () => {
    const saved = await post({ action: "setTiers", tiers: SUGGESTED_TIERS.tiers.map((t) => ({ ...t, upTo: t.upTo === null ? "" : t.upTo })), extraEach: 2 });
    expect(saved.status).toBe(200);
    expect((await saved.json()).tiers).toEqual(SUGGESTED_TIERS);

    const refused = await post({ action: "setTiers", tiers: [{ name: "X", upTo: 0, monthlyFee: 5 }] });
    expect(refused.status).toBe(400);
    expect((await post({ action: "setTiers" })).status).toBe(400);

    const id = await venueWith(7);
    const desk = await createAdmin({ name: "Desk", email: `desk${id}@venue.my`, password: "desk-password-1", venueId: id });
    if (!desk.ok) throw new Error(desk.error);
    const deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
    expect((await post({ action: "setTiers", tiers: [] }, deskCookie)).status).toBe(403);

    const seen = await (await billingGet(new NextRequest("http://localhost/api/admin/billing", { headers: { cookie: deskCookie } }))).json();
    expect(seen.plans).toEqual([expect.objectContaining({ venueId: id, tierName: "Growth", resources: 7, effectiveFee: 39.9 })]);
    expect(seen.tiers).toEqual(SUGGESTED_TIERS);

    const owner = await (await billingGet(new NextRequest("http://localhost/api/admin/billing", { headers: { cookie: ownerCookie } }))).json();
    expect(owner.suggestedTiers).toEqual(SUGGESTED_TIERS);
  });
});
