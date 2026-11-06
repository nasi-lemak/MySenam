import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_MARKETPLACE = "on";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, authenticateAdmin, createAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins, type Admin } from "../src/lib/admin-auth";
import { listActivity } from "../src/lib/activity";
import { REVIEW_CHECKS, requestGoLive, submitApplication } from "../src/lib/applications";
import { createApiKey } from "../src/lib/api-keys";
import { getDb } from "../src/lib/db";
import { createCourt, createVenue, setPaymentStatus } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { GET as activityGet } from "../src/app/api/admin/activity/route";
import { POST as billingPost } from "../src/app/api/admin/billing/route";
import { POST as businessesPost } from "../src/app/api/admin/businesses/route";
import { POST as applicationsPost } from "../src/app/api/admin/venue-applications/route";
import { POST as suspensionsPost } from "../src/app/api/admin/suspensions/route";
import { POST as venuesPost } from "../src/app/api/admin/venues/route";
import { POST as bookingsPost } from "../src/app/api/v1/bookings/route";
import { POST as cancelPost } from "../src/app/api/v1/bookings/[code]/cancel/route";

/**
 * The platform owner's money and tenancy decisions, and what an API key does, are in the staff activity log with who
 * did them and why (lib/activity.ts), and the venue or business they concern can read them.
 */
let owner: Admin;
let branchManager: Admin;
let bizManager: Admin;
let desk: Admin;
let venueId: number;
let courtId: number;
let businessId: number;

const cookieFor = async (id: number) => `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(id)).token}`;
const post = async (handler: (r: NextRequest) => Promise<Response>, url: string, admin: Admin, body: unknown) =>
  handler(new NextRequest(`http://localhost${url}`, { method: "POST", headers: { cookie: await cookieFor(admin.id), "content-type": "application/json" }, body: JSON.stringify(body) }));
const logOf = async (admin: Admin, query = "") => {
  const res = await activityGet(new NextRequest(`http://localhost/api/admin/activity${query}`, { headers: { cookie: await cookieFor(admin.id) } }));
  return ((await res.json()) as { actions: { action: string; adminName: string; detail: string; venueId: number | null }[] }).actions;
};
const newInvoice = async (venue: number, period: string) =>
  ((await getDb()
    .prepare("INSERT INTO venue_invoices (venue_id, period, amount, issued_on, due_on) VALUES (?, ?, 99, '2026-10-01', '2026-10-15') RETURNING id")
    .get(venue, period)) as { id: number }).id;

beforeAll(async () => {
  await ensureBootstrapAdmin();
  owner = (await listAdmins()).find((a) => a.venueId === null && a.businessId === null)!;
  const v = await createVenue({ name: "Billed Hall", area: "PJ", address: "1 Jalan B", phone: "0377770011" });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  courtId = ((await createCourt({ venueId, name: "C1", sport: "badminton", offPeakRate: 20, peakRate: 30 })) as { court: { id: number } }).court.id;
  businessId = ((await getDb().prepare("INSERT INTO businesses (name) VALUES ('Billed Chain') RETURNING id").get()) as { id: number }).id;
  await getDb().prepare("UPDATE venues SET business_id = ? WHERE id = ?").run(businessId, venueId);
  const bm = await createAdmin({ name: "Mira Manager", email: "mira@billed.my", password: "a long enough password", venueId, role: "manager" });
  const biz = await createAdmin({ name: "Bina Business", email: "bina@billed.my", password: "a long enough password", venueId: null, businessId });
  const dk = await createAdmin({ name: "Dina Desk", email: "dina@billed.my", password: "a long enough password", venueId, role: "desk" });
  if (!bm.ok || !biz.ok || !dk.ok) throw new Error("staff");
  branchManager = bm.admin;
  bizManager = biz.admin;
  desk = dk.admin;
});

describe("the owner's billing decisions", () => {
  it("an invoice marked paid needs a reason, and is logged with the owner's name, visible to the venue's manager", async () => {
    const id = await newInvoice(venueId, "2026-09");
    const bare = await post(billingPost, "/api/admin/billing", owner, { action: "markPaid", invoiceId: id });
    expect(bare.status).toBe(400);
    expect(((await bare.json()) as { code: string }).code).toBe("BILL_REASON_REQUIRED");
    expect((await post(billingPost, "/api/admin/billing", owner, { action: "markPaid", invoiceId: id, reason: "ok" })).status).toBe(400);
    expect(((await getDb().prepare("SELECT status FROM venue_invoices WHERE id = ?").get(id)) as { status: string }).status).toBe("due");
    const done = await post(billingPost, "/api/admin/billing", owner, { action: "markPaid", invoiceId: id, reason: "Bank transfer seen on the 3 Nov statement" });
    expect(done.status).toBe(200);
    const mine = (await logOf(branchManager)).find((a) => a.action === "invoice.marked_paid");
    expect(mine).toBeTruthy();
    expect(mine!.adminName).toBe(owner.name);
    expect(mine!.detail).toContain("Bank transfer seen on the 3 Nov statement");
    expect(mine!.detail).toContain("2026-09");
  });

  it("an invoice voided needs a reason too, and the desk cannot do either", async () => {
    const id = await newInvoice(venueId, "2026-08");
    expect((await post(billingPost, "/api/admin/billing", owner, { action: "void", invoiceId: id })).status).toBe(400);
    expect((await post(billingPost, "/api/admin/billing", desk, { action: "void", invoiceId: id, reason: "I would like to" })).status).toBe(403);
    expect((await post(billingPost, "/api/admin/billing", branchManager, { action: "markPaid", invoiceId: id, reason: "I paid it" })).status).toBe(403);
    expect(((await getDb().prepare("SELECT status FROM venue_invoices WHERE id = ?").get(id)) as { status: string }).status).toBe("due");
    expect((await post(billingPost, "/api/admin/billing", owner, { action: "void", invoiceId: id, reason: "Billed in error, the venue was in its free months" })).status).toBe(200);
    const entry = (await logOf(owner)).find((a) => a.action === "invoice.voided");
    expect(entry?.detail).toContain("Billed in error");
  });

  it("a business invoice paid is visible to the business's managers, not to a branch's own manager", async () => {
    const id = ((await getDb()
      .prepare("INSERT INTO venue_invoices (venue_id, business_id, period, amount, issued_on, due_on) VALUES (NULL, ?, '2026-07', 150, '2026-08-01', '2026-08-15') RETURNING id")
      .get(businessId)) as { id: number }).id;
    expect((await post(billingPost, "/api/admin/billing", owner, { action: "markPaid", invoiceId: id, reason: "Cheque banked on 5 August" })).status).toBe(200);
    expect((await logOf(bizManager)).some((a) => a.action === "invoice.marked_paid" && a.detail.includes("(business)"))).toBe(true);
    expect((await logOf(branchManager)).some((a) => a.detail.includes("(business)"))).toBe(false);
  });

  it("a monthly fee and the plans by size are logged, with before and after and the reason given", async () => {
    const set = await post(billingPost, "/api/admin/billing", owner, { action: "setPlan", venueId, monthlyFee: 40, billingStartsOn: "2027-01-01", reason: "Agreed on the call" });
    expect(set.status).toBe(200);
    const plan = (await logOf(owner)).find((a) => a.action === "plan.set");
    expect(plan?.detail).toContain("RM");
    expect(plan?.detail).toContain("2027-01-01");
    expect(plan?.detail).toContain("Agreed on the call");
    expect(plan?.venueId).toBe(venueId);
    const tiers = await post(billingPost, "/api/admin/billing", owner, {
      action: "setTiers",
      tiers: [{ name: "Small", upTo: 3, monthlyFee: 49 }, { name: "Large", upTo: 10, monthlyFee: 99 }],
      extraEach: 10,
      reason: "New pricing for 2027",
    });
    expect(tiers.status).toBe(200);
    expect((await logOf(owner)).some((a) => a.action === "tiers.set" && a.detail.includes("Small") && a.detail.includes("New pricing for 2027"))).toBe(true);
    // Another venue's managers do not read the platform's tiers entry, which names no venue.
    expect((await logOf(branchManager)).some((a) => a.action === "tiers.set")).toBe(false);
  });

  it("a refused decision leaves no entry", async () => {
    const before = (await logOf(owner)).length;
    expect((await post(billingPost, "/api/admin/billing", owner, { action: "setPlan", venueId: 999999, monthlyFee: 1 })).status).toBe(400);
    expect((await logOf(owner)).length).toBe(before);
  });
});

describe("the owner's tenancy decisions", () => {
  it("grouping venues into a business, and making staff its managers, is logged where the business's managers read it", async () => {
    const a = await createVenue({ name: "Group A", area: "PJ", address: "1", phone: "0377770021" });
    if (!a.ok) throw new Error("venue");
    const staff = await createAdmin({ name: "Sam Staff", email: "sam@group.my", password: "a long enough password", venueId: a.venue.id, role: "manager" });
    if (!staff.ok) throw new Error("staff");
    const made = await post(businessesPost, "/api/admin/businesses", owner, { name: "Group Co", venueIds: [a.venue.id], managerIds: [staff.admin.id], reason: "They asked to be one business" });
    expect(made.status).toBe(201);
    const newBusiness = ((await made.json()) as { businessId: number }).businessId;
    const promoted = (await authenticateAdmin("sam@group.my", "a long enough password"))!;
    expect(promoted.businessId).toBe(newBusiness);
    const seen = await logOf(promoted);
    expect(seen.some((e) => e.action === "business.grouped" && e.detail.includes("Group Co") && e.detail.includes("Group A"))).toBe(true);
    expect(seen.some((e) => e.action === "staff.promoted" && e.detail.includes("Sam Staff") && e.adminName === owner.name)).toBe(true);
    // Another business's manager does not.
    expect((await logOf(bizManager)).some((e) => e.action === "business.grouped" && e.detail.includes("Group Co"))).toBe(false);
  });

  it("a venue added by the owner is logged", async () => {
    const res = await post(venuesPost, "/api/admin/venues", owner, { name: "Owner Added Hall", area: "KL", address: "9 Jalan Owner", phone: "0377770031" });
    expect(res.status).toBe(201);
    expect((await logOf(owner)).some((e) => e.action === "venue.added" && e.detail.includes("Owner Added Hall"))).toBe(true);
  });

  it("approving or refusing an application to list a venue is logged with the owner, and the venue's manager can read it", async () => {
    const applied = await submitApplication({
      businessName: "Fresh Hall", area: "Ipoh", address: "1 Jalan Baru", venuePhone: "0500000001", contactName: "Fay",
      email: "fay@fresh.my", password: "a long enough password", lat: 4.7, lng: 101.1,
    });
    if (!applied.ok) throw new Error(applied.error);
    const fay = (await authenticateAdmin("fay@fresh.my", "a long enough password"))!;
    expect((await createCourt({ venueId: applied.application.venueId!, name: "C1", sport: "badminton", offPeakRate: 10, peakRate: 12 })).ok).toBe(true);
    const asked = await requestGoLive(fay, applied.application.venueId!);
    if (!asked.ok) throw new Error(asked.error);
    const { id } = (await getDb().prepare("SELECT id FROM venue_applications WHERE venue_id = ?").get(applied.application.venueId)) as { id: number };
    const refusedRes = await post(applicationsPost, "/api/admin/venue-applications", owner, { id, decision: "reject", reason: "The pin is in a car park" });
    expect(refusedRes.status).toBe(200);
    expect((await logOf(fay)).some((e) => e.action === "venue.rejected" && e.detail.includes("The pin is in a car park") && e.adminName === owner.name)).toBe(true);
    // Asked again, and approved.
    const again = await requestGoLive(fay, applied.application.venueId!);
    if (!again.ok) throw new Error(again.error);
    const second = (await getDb().prepare("SELECT id FROM venue_applications WHERE venue_id = ? AND status = 'pending'").get(applied.application.venueId)) as { id: number };
    const approved = await post(applicationsPost, "/api/admin/venue-applications", owner, { id: second.id, decision: "approve", checks: REVIEW_CHECKS.map((c) => c.id) });
    expect(approved.status).toBe(200);
    expect((await logOf(fay)).some((e) => e.action === "venue.approved")).toBe(true);
  });

  it("suspending and lifting a business are logged with the reason, readable by that business's managers", async () => {
    const off = await post(suspensionsPost, "/api/admin/suspensions", owner, { action: "suspend", businessId, reason: "Complaints about refunds" });
    expect(off.status).toBe(200);
    const on = await post(suspensionsPost, "/api/admin/suspensions", owner, { action: "lift", businessId, reason: "Refunds made, checked" });
    expect(on.status).toBe(200);
    const seen = await logOf(bizManager);
    expect(seen.some((e) => e.action === "venue.suspended" && e.detail.includes("Complaints about refunds"))).toBe(true);
    expect(seen.some((e) => e.action === "venue.suspension_lifted" && e.detail.includes("Refunds made, checked"))).toBe(true);
  });
});

describe("a booking made and cancelled through an API key", () => {
  it("is in the staff activity log, naming the key, like a desk booking and cancellation", async () => {
    const key = await createApiKey(venueId, { name: "Website", scope: "write" }, null);
    if (!key.ok) throw new Error("key");
    const call = (url: string, body?: unknown) =>
      new NextRequest(`http://localhost${url}`, {
        method: "POST",
        headers: { authorization: `Bearer ${key.key}`, "content-type": "application/json", "x-forwarded-for": "203.0.113.77" },
        body: body ? JSON.stringify(body) : undefined,
      });
    const res = await bookingsPost(call("/api/v1/bookings", { courtId, date: addDays(todayISO(), 3), hours: [9], name: "Web Customer", phone: "0123334455", email: "web@example.my" }));
    expect(res.status).toBe(201);
    const { booking } = (await res.json()) as { booking: { code: string } };
    expect((await setPaymentStatus(booking.code, true, "cash")).ok).toBe(true);
    const cancelled = await cancelPost(call(`/api/v1/bookings/${booking.code}/cancel`), { params: Promise.resolve({ code: booking.code }) });
    expect(cancelled.status).toBe(200);
    const entries = await listActivity([venueId], { bookingCode: booking.code });
    expect(entries.map((e) => e.action)).toEqual(expect.arrayContaining(["booking.created", "booking.cancelled"]));
    expect(entries.every((e) => e.adminId === null && e.adminName === 'API key "Website"')).toBe(true);
    expect(entries.find((e) => e.action === "booking.cancelled")?.detail).toContain("(was paid)");
    // A refused call (a booking that is not this key's venue's) writes nothing.
    const before = (await listActivity([venueId])).length;
    const none = await cancelPost(call("/api/v1/bookings/NOSUCH/cancel"), { params: Promise.resolve({ code: "NOSUCH" }) });
    expect(none.status).toBe(404);
    expect((await listActivity([venueId])).length).toBe(before);
  });
});
