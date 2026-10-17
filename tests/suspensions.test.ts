import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_MARKETPLACE = "on";

const sent: { to: string; subject: string; text: string }[] = [];
vi.mock("../src/lib/transports", async (original) => ({
  ...(await original<typeof import("../src/lib/transports")>()),
  sendPlainEmail: async (to: string, subject: string, text: string) => {
    sent.push({ to, subject, text });
    return true;
  },
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, authenticateAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import type { Admin } from "../src/lib/admin-auth";
import {
  addBranch,
  applicationById,
  approveApplication,
  confirmApplicationEmail,
  REVIEW_CHECKS,
  requestGoLive,
  submitApplication,
} from "../src/lib/applications";
import { issueDueInvoices, listInvoices, markInvoicePaid } from "../src/lib/billing";
import { getDb } from "../src/lib/db";
import { venueIsOpen } from "../src/lib/listing";
import { applyPaymentHolds, GRACE_DAYS, WARN_AFTER_DAYS } from "../src/lib/payment-holds";
import { createCourt } from "../src/lib/store";
import { liftBusiness, liftVenue, suspendBusiness, suspendVenue } from "../src/lib/suspensions";
import { addDays, todayISO } from "../src/lib/time";

/** The platform owner suspending a venue or a business, and invoices that run late. */

let n = 0;
let ownerId: number;

async function liveBusiness(): Promise<{ venueId: number; businessId: number; manager: Admin }> {
  n++;
  const applied = await submitApplication({
    businessName: `Hall ${n}`,
    area: "Ipoh",
    address: `${n} Jalan Ipoh`,
    venuePhone: "0500000000",
    contactName: "Mgr",
    email: `mgr${n}@hall.my`,
    password: "a long enough password",
    lat: 4.59 + n * 0.01,
    lng: 101.09,
  });
  if (!applied.ok) throw new Error(applied.error);
  // Follow the link in the confirmation email, as they would.
  const link = sent.filter((m) => m.to === `mgr${n}@hall.my`).at(-1)!;
  expect(await confirmApplicationEmail(/token=([\w-]+)/.exec(link.text)![1])).toBe("confirmed");
  const venueId = (await applicationById(applied.application.id))!.venueId!;
  await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 10, peakRate: 15 });
  const manager = (await authenticateAdmin(`mgr${n}@hall.my`, "a long enough password"))!;
  const asked = await requestGoLive(manager, venueId);
  if (!asked.ok) throw new Error(asked.error);
  const approved = await approveApplication(applied.application.id, ownerId, REVIEW_CHECKS.map((c) => c.id));
  if (!approved.ok) throw new Error(approved.error);
  return { venueId, businessId: manager.businessId!, manager };
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  ownerId = (await listAdmins()).find((a) => a.venueId === null && a.businessId === null)!.id;
});

afterEach(() => {
  delete process.env.MYSENAM_VENUE_FEE;
});

describe("suspending a venue", () => {
  it("takes it from customers, tells its staff why, and only the owner puts it back", async () => {
    const { venueId } = await liveBusiness();
    sent.length = 0;
    const done = await suspendVenue(venueId, "Complaints about unsafe flooring");
    expect(done).toMatchObject({ ok: true, venues: 1, upcomingBookings: 0 });
    expect(await venueIsOpen(venueId)).toBe(false);
    expect(sent[0].text).toContain("Complaints about unsafe flooring");

    // Settling invoices does not undo it.
    await applyPaymentHolds();
    expect(await venueIsOpen(venueId)).toBe(false);

    expect(await liftVenue(venueId)).toEqual({ ok: true });
    expect(await venueIsOpen(venueId)).toBe(true);
    expect(await liftVenue(venueId)).toEqual({ ok: false, error: "That venue is not suspended." });
  });

  it("needs a reason", async () => {
    const { venueId } = await liveBusiness();
    expect(await suspendVenue(venueId, " ")).toMatchObject({ ok: false });
  });
});

describe("suspending a business", () => {
  it("takes every branch, stops new ones going live, and lifts as a whole", async () => {
    const { venueId, businessId, manager } = await liveBusiness();
    const branch = await addBranch(manager, {
      name: "Second",
      area: "Ipoh",
      address: "99 Jalan Kedua",
      phone: "0500000001",
      lat: 4.7,
      lng: 101.1,
    });
    if (!branch.ok) throw new Error(branch.error);
    await createCourt({ venueId: branch.venueId!, name: "Court 1", sport: "badminton", offPeakRate: 10, peakRate: 15 });

    expect(await suspendBusiness(businessId, "Unpaid refunds to customers")).toMatchObject({ ok: true, venues: 2 });
    expect(await venueIsOpen(venueId)).toBe(false);
    const refused = await requestGoLive(manager, branch.venueId!);
    expect(refused).toEqual({ ok: false, error: "Your business is suspended: Unpaid refunds to customers." });
    expect(await liftVenue(venueId)).toEqual({ ok: false, error: "Its whole business is suspended. Lift that instead." });

    expect(await liftBusiness(businessId)).toEqual({ ok: true });
    expect(await venueIsOpen(venueId)).toBe(true);
    // The draft is still a draft: lifting a suspension is not going live.
    expect(await venueIsOpen(branch.venueId!)).toBe(false);
  });
});

describe("an overdue invoice", () => {
  it("is warned about a week in, once, then takes the venue off, and a lifted suspension does not hide that", async () => {
    process.env.MYSENAM_VENUE_FEE = "99";
    const { venueId } = await liveBusiness();
    await getDb().prepare("UPDATE venues SET billing_starts_on = '2020-01-01' WHERE id = ?").run(venueId);
    await issueDueInvoices();
    const invoice = (await listInvoices(venueId)).find((i) => i.status === "due")!;
    const setDue = (daysAgo: number) =>
      getDb().prepare("UPDATE venue_invoices SET due_on = ? WHERE id = ?").run(addDays(todayISO(), -daysAgo), invoice.id);

    sent.length = 0;
    await setDue(WARN_AFTER_DAYS);
    await applyPaymentHolds();
    expect(sent.filter((m) => m.subject.includes("overdue"))).toHaveLength(0);

    await setDue(WARN_AFTER_DAYS + 1);
    await applyPaymentHolds();
    await applyPaymentHolds();
    const warnings = sent.filter((m) => m.subject.includes("overdue"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].text).toContain(addDays(todayISO(), -(WARN_AFTER_DAYS + 1) + GRACE_DAYS + 1));
    expect(await venueIsOpen(venueId)).toBe(true);

    await setDue(GRACE_DAYS + 1);
    await applyPaymentHolds();
    expect(await venueIsOpen(venueId)).toBe(false);

    // The owner suspends it too, then lifts that: still owing, so still off.
    await suspendVenue(venueId, "Checking a complaint");
    await liftVenue(venueId);
    expect(await venueIsOpen(venueId)).toBe(false);
    const row = (await getDb().prepare("SELECT suspended_by FROM venues WHERE id = ?").get(venueId)) as { suspended_by: string };
    expect(row.suspended_by).toBe("payment");

    await markInvoicePaid(invoice.id);
    expect(await venueIsOpen(venueId)).toBe(true);
  });
});

describe("the routes", () => {
  it("let only the platform owner suspend, and staff move their own pin", async () => {
    const { venueId, manager } = await liveBusiness();
    const asManager = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(manager.id)).token}`;
    const asOwner = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(ownerId)).token}`;
    const { POST } = await import("../src/app/api/admin/suspensions/route");
    const suspend = (cookie: string, body: object) =>
      POST(
        new NextRequest("http://localhost/api/admin/suspensions", {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify(body),
        })
      );
    expect((await suspend(asManager, { venueId, action: "suspend", reason: "No" })).status).toBe(403);
    expect((await suspend(asOwner, { venueId, action: "oops" })).status).toBe(400);
    expect(await venueIsOpen(venueId)).toBe(true);
    expect((await suspend(asOwner, { venueId, action: "suspend", reason: "Checking" })).status).toBe(200);
    expect((await suspend(asOwner, { venueId, action: "lift" })).status).toBe(200);

    // A live venue moving its pin across town: allowed, and the owner hears.
    sent.length = 0;
    const venues = await import("../src/app/api/admin/venues/[id]/route");
    const move = (lat: number, lng: number) =>
      venues.PATCH(
        new NextRequest(`http://localhost/api/admin/venues/${venueId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json", cookie: asManager },
          body: JSON.stringify({ lat, lng }),
        }),
        { params: Promise.resolve({ id: String(venueId) }) }
      );
    expect((await move(51.5, -0.1)).status).toBe(400);
    const moved = await move(3.14, 101.69);
    expect(moved.status).toBe(200);
    expect((await moved.json()).venue).toMatchObject({ lat: 3.14, lng: 101.69 });
    expect(sent.some((m) => m.subject.includes("moved its pin"))).toBe(true);
  });
});
