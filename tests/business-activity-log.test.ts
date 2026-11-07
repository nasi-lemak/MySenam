import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin, type Admin } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { removeStaff } from "../src/lib/staff-accounts";
import { createVenue } from "../src/lib/store";
import { listAdmins } from "../src/lib/admin-auth";
import { GET as activity } from "../src/app/api/admin/activity/route";

/**
 * Audit 9 / A5: staff changes at business level are logged with venue_id NULL (lib/staff-accounts.ts
 * `logAction(by, { venueId: target.venueId ... })`), and the staff activity log is read by venue
 * (lib/activity.ts listActivity: `venue_id IN (...)` for everybody but the platform owner). So when one
 * business manager removes another, the business's remaining manager cannot see who did it or that it
 * happened; only the platform owner can. Intended: a business sees its own managers' changes.
 */
let business: number;
let bina: Admin;
let chen: Admin;

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const v = await createVenue({ name: "Chain A", area: "PJ", address: "1 Jalan Ujian", phone: "0377770000" });
  if (!v.ok) throw new Error(v.error);
  business = ((await getDb().prepare("INSERT INTO businesses (name) VALUES ('Chain') RETURNING id").get()) as { id: number }).id;
  await getDb().prepare("UPDATE venues SET business_id = ? WHERE id = ?").run(business, v.venue.id);
  const a = await createAdmin({ name: "Bina", email: "bina@chain.my", password: "a long enough password", venueId: null, businessId: business });
  const b = await createAdmin({ name: "Chen", email: "chen@chain.my", password: "a long enough password", venueId: null, businessId: business });
  const c = await createAdmin({ name: "Dato", email: "dato@chain.my", password: "a long enough password", venueId: null, businessId: business });
  if (!a.ok || !b.ok || !c.ok) throw new Error("staff");
  bina = a.admin;
  chen = b.admin;
  // Dato is the business manager who gets removed.
  (globalThis as { dato?: Admin }).dato = c.admin;
});

describe("one business manager removing another", () => {
  it("is visible in the activity log to the business's other manager", async () => {
    const dato = (globalThis as { dato?: Admin }).dato!;
    const done = await removeStaff(bina, dato.id);
    expect(done.ok).toBe(true);
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(chen.id)).token}`;
    const res = await activity(new NextRequest("http://localhost/api/admin/activity", { headers: { cookie } }));
    const { actions } = (await res.json()) as { actions: { action: string; detail: string }[] };
    expect(actions.some((a) => a.action === "staff.removed" && a.detail.includes("Dato")), "Chen cannot see that Bina removed Dato").toBe(true);
  });

  it("is not visible to another business's manager, to a branch's own manager, or to the front desk, but is to the platform owner", async () => {
    const other = await createVenue({ name: "Other Chain A", area: "JB", address: "1 Jalan Lain", phone: "0377770055" });
    if (!other.ok) throw new Error(other.error);
    const otherBusiness = ((await getDb().prepare("INSERT INTO businesses (name) VALUES ('Other Chain') RETURNING id").get()) as { id: number }).id;
    await getDb().prepare("UPDATE venues SET business_id = ? WHERE id = ?").run(otherBusiness, other.venue.id);
    const zed = await createAdmin({ name: "Zed", email: "zed@other.my", password: "a long enough password", venueId: null, businessId: otherBusiness });
    const branch = await createAdmin({ name: "Branch Boss", email: "boss@other.my", password: "a long enough password", venueId: other.venue.id, role: "manager" });
    const desk = await createAdmin({ name: "Branch Desk", email: "desk@other.my", password: "a long enough password", venueId: other.venue.id, role: "desk" });
    if (!zed.ok || !branch.ok || !desk.ok) throw new Error("staff");
    const seenBy = async (admin: Admin) => {
      const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(admin.id)).token}`;
      const res = await activity(new NextRequest("http://localhost/api/admin/activity", { headers: { cookie } }));
      return res.status === 200 ? ((await res.json()) as { actions: { action: string; detail: string }[] }).actions : [];
    };
    const removed = (a: { action: string; detail: string }) => a.action === "staff.removed" && a.detail.includes("Dato");
    expect((await seenBy(zed.admin)).some(removed)).toBe(false);
    expect((await seenBy(branch.admin)).some(removed)).toBe(false);
    expect(await seenBy(desk.admin)).toEqual([]);
    const owner = (await listAdmins()).find((a) => a.venueId === null && a.businessId === null)!;
    expect((await seenBy(owner)).some(removed)).toBe(true);
    // Business-level entries have the business on them, and no venue.
    const row = (await getDb().prepare("SELECT venue_id, business_id FROM staff_actions WHERE action = 'staff.removed' AND detail LIKE '%Dato%'").get()) as { venue_id: number | null; business_id: number | null };
    expect(row).toEqual({ venue_id: null, business_id: business });
  });
});

/**
 * Entries written before migration 0301 carry no business (venue_id and business_id both null): which business they were about was
 * never recorded and is not guessed. They stay the platform owner's to read (ADR 0064, audit A8): no business manager, branch manager or
 * front desk sees them, whichever business they would seem to be about.
 */
describe("entries from before the business was recorded", () => {
  it("are the platform owner's alone", async () => {
    await getDb()
      .prepare("INSERT INTO staff_actions (admin_name, venue_id, business_id, action, detail) VALUES ('Old Bina', NULL, NULL, 'staff.removed', 'Legacy Dato (legacy@chain.my)')")
      .run();
    const seenBy = async (admin: Admin) => {
      const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(admin.id)).token}`;
      const res = await activity(new NextRequest("http://localhost/api/admin/activity?limit=1000", { headers: { cookie } }));
      return res.status === 200 ? ((await res.json()) as { actions: { detail: string }[] }).actions : [];
    };
    const legacy = (a: { detail: string }) => a.detail.includes("Legacy Dato");
    expect((await seenBy(bina)).some(legacy)).toBe(false);
    expect((await seenBy(chen)).some(legacy)).toBe(false);
    const v = await createVenue({ name: "Legacy Branch", area: "PJ", address: "1 Jalan Lama", phone: "0377770066" });
    if (!v.ok) throw new Error(v.error);
    await getDb().prepare("UPDATE venues SET business_id = ? WHERE id = ?").run(business, v.venue.id);
    const branch = await createAdmin({ name: "Legacy Boss", email: "legacy-boss@chain.my", password: "a long enough password", venueId: v.venue.id, role: "manager" });
    if (!branch.ok) throw new Error(branch.error);
    expect((await seenBy(branch.admin)).some(legacy)).toBe(false);
    const owner = (await listAdmins()).find((a) => a.venueId === null && a.businessId === null)!;
    expect((await seenBy(owner)).some(legacy)).toBe(true);
  });
});
