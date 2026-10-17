import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_MARKETPLACE = "on";

// The booking route reads the customer's language from a cookie.
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, authenticateAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import type { Admin } from "../src/lib/admin-auth";
import { approveApplication, REVIEW_CHECKS, requestGoLive, submitApplication } from "../src/lib/applications";
import { issueDueInvoices, listInvoices, markInvoicePaid } from "../src/lib/billing";
import { getDb } from "../src/lib/db";
import { deleteStaleDrafts, staleDrafts } from "../src/lib/drafts";
import { mayShowVenue, venueIsOpen } from "../src/lib/listing";
import { notifyBookingConfirmed } from "../src/lib/notify";
import { applyPaymentHolds, GRACE_DAYS } from "../src/lib/payment-holds";
import { savePaymentSettings, startBookingPayment, takesPaymentOnline } from "../src/lib/payments";
import { retentionDue } from "../src/lib/privacy";
import {
  createBooking,
  createClassSessions,
  createCourt,
  issuePass,
  listClasses,
  listVenuePage,
  searchAvailability,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * A business signs up and sets up at once, but customers meet it only once
 * it is live — and not while an invoice is long unpaid. Drafts nobody comes
 * back to are cleared away.
 */

let n = 0;
let ownerId: number;

/** A business that has signed up: its draft venue with one court, and its manager. */
async function signUp(): Promise<{ venueId: number; courtId: number; manager: Admin; cookie: string }> {
  n++;
  const applied = await submitApplication({
    businessName: `Draft Hall ${n}`,
    area: "Seremban",
    address: `${n} Jalan Draf`,
    venuePhone: "0600000000",
    contactName: "Dee",
    email: `dee${n}@draft.my`,
    password: "a long enough password",
    lat: 2.7 + n * 0.01,
    lng: 101.94,
  });
  if (!applied.ok) throw new Error(applied.error);
  const venueId = applied.application.venueId!;
  const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 12, peakRate: 18 });
  if (!court.ok) throw new Error("court");
  const manager = (await authenticateAdmin(`dee${n}@draft.my`, "a long enough password"))!;
  const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(manager.id)).token}`;
  return { venueId, courtId: court.court.id, manager, cookie };
}

async function goLive(venueId: number, manager: Admin): Promise<void> {
  const asked = await requestGoLive(manager, venueId);
  if (!asked.ok) throw new Error(asked.error);
  const { id } = (await getDb().prepare("SELECT id FROM venue_applications WHERE venue_id = ?").get(venueId)) as { id: number };
  const approved = await approveApplication(id, ownerId, REVIEW_CHECKS.map((c) => c.id));
  if (!approved.ok) throw new Error(approved.error);
}

const date = addDays(todayISO(), 3);

beforeAll(async () => {
  await ensureBootstrapAdmin();
  ownerId = (await listAdmins()).find((a) => a.venueId === null && a.businessId === null)!.id;
});

afterEach(() => {
  delete process.env.MYSENAM_VENUE_FEE;
});

describe("a draft", () => {
  it("is nowhere a customer looks", async () => {
    const { venueId, courtId } = await signUp();
    expect(await venueIsOpen(venueId)).toBe(false);
    expect((await listVenuePage({ pageSize: 100 })).venues.some((v) => v.id === venueId)).toBe(false);
    expect(
      (await searchAvailability({ sport: "badminton", date, area: "Seremban" })).some((r) => r.venue.id === venueId)
    ).toBe(false);
    const made = await createClassSessions({
      courtId,
      name: "Smash basics",
      instructor: "Coach",
      date,
      startHour: 9,
      endHour: 10,
      capacity: 1,
      price: 20,
    });
    expect(made.ok).toBe(true);
    expect((await listClasses({ openOnly: true })).some((c) => c.venueId === venueId)).toBe(false);
    expect((await listClasses({ venueId })).length).toBe(1);
  });

  it("shows its own staff a preview, and nobody else", async () => {
    const { venueId, manager, cookie } = await signUp();
    expect(await mayShowVenue(venueId, null)).toEqual({ show: false, preview: false });
    expect(await mayShowVenue(venueId, manager)).toEqual({ show: true, preview: true });

    const { GET } = await import("../src/app/api/availability/route");
    const ask = (headers: Record<string, string> = {}) =>
      GET(new NextRequest(`http://localhost/api/availability?venueId=${venueId}&date=${date}`, { headers }));
    expect((await ask()).status).toBe(404);
    expect((await ask({ cookie })).status).toBe(200);

    const live = await import("../src/app/api/venues/[id]/live/route");
    const occupancy = (headers: Record<string, string> = {}) =>
      live.GET(new NextRequest(`http://localhost/api/venues/${venueId}/live`, { headers }), {
        params: Promise.resolve({ id: String(venueId) }),
      });
    expect((await occupancy()).status).toBe(404);
    expect((await occupancy({ cookie })).status).toBe(200);

    const classes = await import("../src/app/api/classes/route");
    const listed = await classes.GET(new NextRequest(`http://localhost/api/classes?venueId=${venueId}`));
    expect(await listed.json()).toEqual({ classes: [] });
  });

  it("takes no booking from a customer, but lets its staff try one", async () => {
    const { venueId, courtId, cookie } = await signUp();
    const { POST } = await import("../src/app/api/bookings/route");
    const book = (phone: string, headers: Record<string, string> = {}) =>
      POST(
        new NextRequest("http://localhost/api/bookings", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": `10.7.0.${n}`, ...headers },
          body: JSON.stringify({ courtId, date, hours: [10], name: "Tester", phone }),
        })
      );
    const refused = await book("0123000001");
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe("VENUE_NOT_OPEN");
    expect((await book("0123000002", { cookie })).status).toBe(201);

    const waitlist = await import("../src/app/api/waitlist/route");
    const queued = await waitlist.POST(
      new NextRequest("http://localhost/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `10.7.1.${n}` },
        body: JSON.stringify({ courtId, date, startHour: 10, endHour: 11, name: "Wait", phone: "0123000003" }),
      })
    );
    expect((await queued.json()).code).toBe("VENUE_NOT_OPEN");
    expect(venueId).toBeGreaterThan(0);
  });

  it("messages nobody, and takes no payment", async () => {
    const { venueId, courtId } = await signUp();
    const made = await createBooking({ courtId, date, hours: [11], name: "Test", phone: "0123000004" });
    if (!made.ok) throw new Error("booking");
    expect(await notifyBookingConfirmed([made.booking], "en", null)).toBeNull();
    const settings = await savePaymentSettings(venueId, {
      apiKey: "api-key-123",
      collectionId: "col-123",
      xSignatureKey: "signature-123",
      sandbox: true,
      enabled: true,
    });
    expect(settings.ok).toBe(true);
    expect(await takesPaymentOnline(venueId)).toBe(false);
    const paying = await startBookingPayment({ codes: [made.booking.code], phone: "0123000004" });
    expect(paying).toMatchObject({ ok: false, status: 409 });
  });

  it("is in front of customers once it goes live", async () => {
    const { venueId, manager } = await signUp();
    await goLive(venueId, manager);
    expect(await venueIsOpen(venueId)).toBe(true);
    expect(
      (await searchAvailability({ sport: "badminton", date, area: "Seremban" })).some((r) => r.venue.id === venueId)
    ).toBe(true);
  });
});

describe("an invoice long unpaid", () => {
  it("takes the business's branches off until it is paid", async () => {
    process.env.MYSENAM_VENUE_FEE = "99";
    const { venueId, manager } = await signUp();
    await goLive(venueId, manager);
    // Billing started a while back, and this month's invoice is out.
    await getDb().prepare("UPDATE venues SET billing_starts_on = '2020-01-01' WHERE id = ?").run(venueId);
    await issueDueInvoices();
    const invoice = (await listInvoices(venueId)).find((i) => i.status === "due")!;

    // Due, and within the grace: still listed.
    await getDb().prepare("UPDATE venue_invoices SET due_on = ? WHERE id = ?").run(addDays(todayISO(), -GRACE_DAYS), invoice.id);
    expect((await applyPaymentHolds()).held).toEqual([]);

    // A day past the grace: off.
    await getDb().prepare("UPDATE venue_invoices SET due_on = ? WHERE id = ?").run(addDays(todayISO(), -GRACE_DAYS - 1), invoice.id);
    const changes = await applyPaymentHolds();
    expect(changes.held.map((v) => v.id)).toContain(venueId);
    expect(await venueIsOpen(venueId)).toBe(false);
    expect((await listVenuePage({ pageSize: 100 })).venues.some((v) => v.id === venueId)).toBe(false);
    // Still its staff's to use.
    expect((await mayShowVenue(venueId, manager)).show).toBe(true);
    // Once only.
    expect((await applyPaymentHolds()).held).toEqual([]);

    // Paid: back at once.
    expect((await markInvoicePaid(invoice.id)).ok).toBe(true);
    expect(await venueIsOpen(venueId)).toBe(true);
  });
});

describe("a draft nobody came back to", () => {
  const away = (venueId: number, days: number) =>
    getDb()
      .prepare(
        `UPDATE admins SET last_seen_at = datetime('now', ?), created_at = datetime('now', ?)
          WHERE business_id = (SELECT business_id FROM venues WHERE id = ?)`
      )
      .run(`-${days} days`, `-${days} days`, venueId);

  it("goes after ninety days, with everything it set up", async () => {
    const { venueId, courtId } = await signUp();
    expect((await createBooking({ courtId, date, hours: [12], name: "Test", phone: "0123000005" })).ok).toBe(true);
    await away(venueId, 91);
    expect((await staleDrafts()).some((d) => d.venueIds.includes(venueId))).toBe(true);
    expect((await retentionDue()).find((l) => l.what.startsWith("Draft venues"))!.affected).toBeGreaterThan(0);

    await deleteStaleDrafts();
    expect(await getDb().prepare("SELECT 1 FROM venues WHERE id = ?").get(venueId)).toBeUndefined();
    expect(await getDb().prepare("SELECT 1 FROM courts WHERE id = ?").get(courtId)).toBeUndefined();
    expect(await authenticateAdmin(`dee${n}@draft.my`, "a long enough password")).toBeNull();
  });

  it("stays while somebody still signs in, or while it is waiting to go live", async () => {
    const recent = await signUp();
    await away(recent.venueId, 30);
    const waiting = await signUp();
    expect((await requestGoLive(waiting.manager, waiting.venueId)).ok).toBe(true);
    await away(waiting.venueId, 120);
    const due = (await staleDrafts()).flatMap((d) => d.venueIds);
    expect(due).not.toContain(recent.venueId);
    expect(due).not.toContain(waiting.venueId);
  });

  it("stays when it holds something of a customer's", async () => {
    const { venueId, manager } = await signUp();
    const sold = await issuePass({
      venueId,
      name: "10 visits",
      entries: 10,
      price: 100,
      holderName: "Customer",
      holderPhone: "0123000006",
      expiresOn: addDays(todayISO(), 90),
      adminId: manager.id,
    });
    expect(sold.ok).toBe(true);
    await away(venueId, 200);
    expect((await staleDrafts()).flatMap((d) => d.venueIds)).not.toContain(venueId);
  });
});

describe("the go-live route", () => {
  it("says what is missing, and sends a draft that is ready", async () => {
    const { venueId, cookie } = await signUp();
    const { GET, POST } = await import("../src/app/api/admin/go-live/route");
    const status = await GET(new NextRequest(`http://localhost/api/admin/go-live?venueId=${venueId}`, { headers: { cookie } }));
    expect(await status.json()).toMatchObject({ state: "draft", request: { status: "draft" }, missing: [] });
    const sent = await POST(
      new NextRequest("http://localhost/api/admin/go-live", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ venueId }),
      })
    );
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ live: false, status: { request: { status: "pending" } } });
  });
});
