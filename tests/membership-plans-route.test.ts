import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { createPlan, planById } from "../src/lib/membership-plans";
import { createCourt, createVenue, updateCourt } from "../src/lib/store";
import { PATCH as plansPatch, POST as plansPost } from "../src/app/api/admin/membership-plans/route";
import { listActivity } from "../src/lib/activity";

/**
 * The plan editor's route (MEMB D19, D6, ADR 0071): a price level above a court's member rate is answered 409 with nothing
 * saved until it is sent again confirmed; a manager changes only their own venue's plans; the edit is in the activity log with
 * the plan's version.
 */

let venueA: number;
let venueB: number;
let planA: number;
let planB: number;
let cookieA: string;

const call = (handler: typeof plansPatch, method: string, body: unknown) =>
  handler(new NextRequest("http://localhost/api/admin/membership-plans", { method, headers: { cookie: cookieA, "content-type": "application/json" }, body: JSON.stringify(body) }));

async function venue(name: string) {
  const v = await createVenue({ name, area: "Ampang", address: "x", phone: "0344445555" });
  if (!v.ok) throw new Error("venue");
  const c = await createCourt({ venueId: v.venue.id, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!c.ok) throw new Error("court");
  await updateCourt(c.court.id, { memberOffPeakRate: 15, memberPeakRate: 15 });
  const p = await createPlan(v.venue.id, { name: "Gold", months: 12, price: 500, ratePercent: 70 });
  if (!p.ok) throw new Error(p.error);
  return { venueId: v.venue.id, planId: p.plan.id };
}

beforeAll(async () => {
  ({ venueId: venueA, planId: planA } = await venue("Kelab A"));
  ({ venueId: venueB, planId: planB } = await venue("Kelab B"));
  const manager = await createAdmin({ email: "mgr@kelab-a.my", name: "Manager", password: "manager-pass-123", venueId: venueA, role: "manager" });
  if (!manager.ok) throw new Error(manager.error);
  cookieA = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(manager.admin.id)).token}`;
});

describe("saving a plan's benefits", () => {
  it("asks to confirm a price level above a court's member rate, saves nothing until it is, then logs the version", async () => {
    const asked = await call(plansPatch, "PATCH", { venueId: venueA, id: planA, ratePercent: 90, aheadDays: null });
    expect(asked.status).toBe(409);
    expect(await asked.json()).toMatchObject({ needsConfirm: "above-member-rate", error: expect.stringContaining("member rate of RM15") });
    expect((await planById(planA))!).toMatchObject({ ratePercent: 70, version: 1 });

    const saved = await call(plansPatch, "PATCH", { venueId: venueA, id: planA, ratePercent: 90, aheadDays: null, confirmAboveMemberRate: true });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ plan: { ratePercent: 90, version: 2 } });
    const log = await listActivity([venueA]);
    expect(log.some((e) => e.action === "membership.plan_added" && e.detail?.includes("version 2"))).toBe(true);
  });

  it("asks the same when a plan is made, and a confirmed one is made", async () => {
    const body = { venueId: venueA, name: "Dear", months: 6, price: 200, ratePercent: 85 };
    const asked = await call(plansPost, "POST", body);
    expect(asked.status).toBe(409);
    expect(await asked.json()).toMatchObject({ needsConfirm: "above-member-rate" });
    const made = await call(plansPost, "POST", { ...body, confirmAboveMemberRate: true });
    expect(made.status).toBe(201);
  });

  it("is refused for another venue's plan, confirmed or not, and an ordinary mistake is still a 400", async () => {
    const other = await call(plansPatch, "PATCH", { venueId: venueB, id: planB, ratePercent: 50, aheadDays: null, confirmAboveMemberRate: true });
    expect(other.status).toBe(403);
    expect((await planById(planB))!).toMatchObject({ ratePercent: 70, version: 1 });
    // Their own venue, another venue's plan id.
    const crossed = await call(plansPatch, "PATCH", { venueId: venueA, id: planB, ratePercent: 50, aheadDays: null });
    expect(crossed.status).toBe(400);
    expect((await planById(planB))!.version).toBe(1);
    const bad = await call(plansPatch, "PATCH", { venueId: venueA, id: planA, ratePercent: 5, aheadDays: null });
    expect(bad.status).toBe(400);
  });
});
