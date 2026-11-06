import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_MARKETPLACE = "on";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, authenticateAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import type { Admin } from "../src/lib/admin-auth";
import { addBranch, applicationById, approveApplication, REVIEW_CHECKS, requestGoLive, submitApplication } from "../src/lib/applications";
import { registerUser } from "../src/lib/auth";
import { issueDueInvoices, listInvoices } from "../src/lib/billing";
import { getDb } from "../src/lib/db";
import { venueIsOpen } from "../src/lib/listing";
import { applyPaymentHolds, GRACE_DAYS, giveInvoiceGrace, WARN_AFTER_DAYS } from "../src/lib/payment-holds";
import { listActivity } from "../src/lib/activity";
import { startPassPayment, startTopUpPayment } from "../src/lib/payments";
import { saveProfile } from "../src/lib/player-profiles";
import { cancelBooking, createBooking, createCourt, issuePass, sellMembership, topUpWallet } from "../src/lib/store";
import { liftBusiness, liftVenue, suspendBusiness, suspendVenue } from "../src/lib/suspensions";
import { tellSuspendedVenues } from "../src/lib/suspension-notices";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Audit 9, FX11 (ADR 0063): what a suspension or a hold for an unpaid invoice does for the customers who hold something at the
 * venue (told once; nothing new sold; bookings stand), time the owner gives an overdue venue without falsifying the books, and a
 * branch that is not approved on its own under a business that is not in good standing.
 */

let n = 0;
let ownerId: number;
let hour = 10;

interface Live {
  venueId: number;
  businessId: number;
  courtId: number;
  manager: Admin;
}

async function liveBusiness(): Promise<Live> {
  n++;
  const applied = await submitApplication({
    businessName: `Effects Hall ${n}`,
    area: "Seremban",
    address: `${n} Jalan Kesan`,
    venuePhone: `06000${String(n).padStart(4, "0")}`,
    contactName: "Dee",
    email: `dee${n}@effects.my`,
    password: "a long enough password",
    lat: 2.71 + n * 0.01,
    lng: 101.94,
  });
  if (!applied.ok) throw new Error(applied.error);
  const venueId = applied.application.venueId!;
  const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 12, peakRate: 18 });
  if (!court.ok) throw new Error("court");
  const manager = (await authenticateAdmin(`dee${n}@effects.my`, "a long enough password"))!;
  const asked = await requestGoLive(manager, venueId);
  if (!asked.ok) throw new Error(asked.error);
  const approved = await approveApplication(applied.application.id, ownerId, REVIEW_CHECKS.map((c) => c.id));
  if (!approved.ok) throw new Error(approved.error);
  return { venueId, businessId: manager.businessId!, courtId: court.court.id, manager };
}

let customers = 0;
async function customer(locale?: string) {
  customers++;
  const made = await registerUser({ name: `Cust ${customers}`, email: `cust${customers}@example.my`, phone: `01230${String(customers).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  if (locale) await getDb().prepare("UPDATE users SET locale = ? WHERE id = ?").run(locale, made.user.id);
  return made.user;
}

const notices = async (email: string) =>
  (await getDb()
    .prepare("SELECT kind, channel, subject, body, status, venue_id AS \"venueId\", locale FROM messages WHERE kind = 'venue_suspension_notice' AND lower(recipient) = lower(?) ORDER BY id")
    .all(email)) as { kind: string; channel: string; subject: string | null; body: string; status: string; venueId: number; locale: string }[];

const noticesAt = async (venueId: number) =>
  ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages WHERE kind = 'venue_suspension_notice' AND venue_id = ?").get(venueId)) as { n: number }).n;

beforeAll(async () => {
  await ensureBootstrapAdmin();
  ownerId = (await listAdmins()).find((a) => a.venueId === null && a.businessId === null)!.id;
});

afterEach(() => {
  delete process.env.MYSENAM_VENUE_FEE;
  delete process.env.MYSENAM_AUTO_APPROVE_BRANCHES;
  delete process.env.MYSENAM_GEOCODER;
  vi.unstubAllGlobals();
});

describe("A4: customers of a suspended venue are told, once", () => {
  it("tells the customers with a booking, a pass, a membership or credit, in their language, and nobody else", async () => {
    const live = await liveBusiness();
    const today = todayISO();
    const bookingGuest = await createBooking({ courtId: live.courtId, date: addDays(today, 5), hours: [hour++], name: "Guest", phone: "0123111222", email: "guest-booker@example.my" });
    if (!bookingGuest.ok) throw new Error("booking");
    const passHolder = await customer();
    const memberHolder = await customer("ms");
    const creditHolder = await customer("zh");
    const nothing = await customer();
    const pass = await issuePass({ venueId: live.venueId, name: "10 visits", entries: 10, price: 100, holderName: "Pat Holder", holderPhone: "0123000001", expiresOn: addDays(today, 60), adminId: live.manager.id, userId: passHolder.id });
    expect(pass.ok, JSON.stringify(pass)).toBe(true);
    const member = await sellMembership({ venueId: live.venueId, holderName: "Mem Holder", holderPhone: "0123000002", startsOn: today, expiresOn: addDays(today, 90), price: 80, adminId: live.manager.id, userId: memberHolder.id });
    expect(member.ok, JSON.stringify(member)).toBe(true);
    expect((await topUpWallet({ userId: creditHolder.id, amount: 50, adminId: live.manager.id, venueId: live.venueId })).ok).toBe(true);
    // An expired pass and a booking in the past are not a reason to write to somebody.
    const lapsed = await customer();
    await issuePass({ venueId: live.venueId, name: "old", entries: 5, price: 10, holderName: "Lapsed Holder", holderPhone: "0123000003", expiresOn: addDays(today, -3), adminId: live.manager.id, userId: lapsed.id });

    const done = await suspendVenue(live.venueId, "complaints about refunds");
    expect(done).toMatchObject({ ok: true, upcomingBookings: 1 });

    const guest = await notices("guest-booker@example.my");
    expect(guest).toHaveLength(1);
    expect(guest[0]).toMatchObject({ kind: "venue_suspension_notice", channel: "email", venueId: live.venueId });
    // What stands, what waits and whom to ask: said, and not blamed on the customer.
    expect(guest[0].body).toContain(`Effects Hall ${n}`);
    expect(guest[0].body).toContain("upcoming bookings");
    expect(guest[0].body).toContain("nothing you have booked has been cancelled");
    expect(guest[0].body).toContain("refunded as usual");
    expect(guest[0].body).toContain(`06000${String(n).padStart(4, "0")}`);
    expect(guest[0].body).toContain("This is not something you did");
    expect(guest[0].body).toContain("/my-booking");

    const forPass = await notices(passHolder.email);
    expect(forPass).toHaveLength(1);
    expect(forPass[0].body).toContain("a pass");
    expect(forPass[0].body).toContain("/account");
    expect((await notices(memberHolder.email))[0].locale).toBe("ms");
    expect((await notices(memberHolder.email))[0].body).toContain("keahlian");
    expect((await notices(creditHolder.email))[0].body).toContain("储值");
    expect(await notices(nothing.email)).toHaveLength(0);
    expect(await notices(lapsed.email)).toHaveLength(0);
  });

  it("is told once per suspension, however often it is looked at again, and again for a new one", async () => {
    const live = await liveBusiness();
    const booker = await customer();
    const booked = await createBooking({ courtId: live.courtId, date: addDays(todayISO(), 6), hours: [hour++], name: "B", phone: "0123222333", email: booker.email, userId: booker.id });
    if (!booked.ok) throw new Error("booking");

    expect(await noticesAt(live.venueId)).toBe(0);
    await suspendVenue(live.venueId, "checking a complaint");
    expect(await noticesAt(live.venueId)).toBe(1);
    // The sweep, an owner suspending it again over the top, a payment check: nothing more.
    await tellSuspendedVenues();
    await tellSuspendedVenues([live.venueId]);
    await applyPaymentHolds();
    await suspendVenue(live.venueId, "still checking");
    expect(await noticesAt(live.venueId)).toBe(1);

    await liftVenue(live.venueId);
    // A suspension is stamped to the second: a later one is another.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await suspendVenue(live.venueId, "a second matter");
    expect(await noticesAt(live.venueId)).toBe(2);
  });

  it("is mended by the sweep when a stop came between the suspension and the notices", async () => {
    const live = await liveBusiness();
    const booker = await customer();
    const booked = await createBooking({ courtId: live.courtId, date: addDays(todayISO(), 6), hours: [hour++], name: "B", phone: "0123222444", email: booker.email, userId: booker.id });
    if (!booked.ok) throw new Error("booking");
    // As the stop leaves it: suspended, and nobody told for it.
    await getDb().prepare("UPDATE venues SET suspended_at = datetime('now'), suspended_by = 'owner', suspended_reason = 'x' WHERE id = ?").run(live.venueId);
    expect(await noticesAt(live.venueId)).toBe(0);
    await applyPaymentHolds();
    expect(await noticesAt(live.venueId)).toBe(1);
    await applyPaymentHolds();
    expect(await noticesAt(live.venueId)).toBe(1);
  });

  it("is not uncapped by accident: it is urgent news, past the day's ordinary limit", async () => {
    const live = await liveBusiness();
    const booker = await customer();
    const booked = await createBooking({ courtId: live.courtId, date: addDays(todayISO(), 7), hours: [hour++], name: "B", phone: "0123222555", email: booker.email, userId: booker.id });
    if (!booked.ok) throw new Error("booking");
    // Eight other messages to this address today: the ordinary limit.
    for (let i = 0; i < 9; i++)
      await getDb()
        .prepare("INSERT INTO messages (venue_id, kind, channel, recipient, locale, body, params, status) VALUES (?, 'campaign', 'email', ?, 'en', 'x', '{}', 'sent')")
        .run(live.venueId, booker.email);
    await suspendVenue(live.venueId, "a reason");
    const told = await notices(booker.email);
    expect(told).toHaveLength(1);
    expect(told[0].status).toBe("queued");
  });

  it("does not write to an account that said it is under 18, but tells its guardian's other things", async () => {
    const live = await liveBusiness();
    const child = await customer();
    expect((await saveProfile(child.id, { adult: false })).ok).toBe(true);
    const booked = await createBooking({ courtId: live.courtId, date: addDays(todayISO(), 6), hours: [hour++], name: "Kid", phone: "0123222666", email: child.email, userId: child.id });
    if (!booked.ok) throw new Error("booking");
    await suspendVenue(live.venueId, "a reason");
    expect(await notices(child.email)).toHaveLength(0);
  });

  it("is told for a whole business, and for a venue held for an unpaid invoice", async () => {
    const live = await liveBusiness();
    const booker = await customer();
    const booked = await createBooking({ courtId: live.courtId, date: addDays(todayISO(), 6), hours: [hour++], name: "B", phone: "0123222777", email: booker.email, userId: booker.id });
    if (!booked.ok) throw new Error("booking");
    expect(await suspendBusiness(live.businessId, "a business matter")).toMatchObject({ ok: true });
    expect(await noticesAt(live.venueId)).toBe(1);
    expect(await liftBusiness(live.businessId)).toEqual({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Held for an invoice far overdue.
    process.env.MYSENAM_VENUE_FEE = "99";
    await getDb().prepare("UPDATE venues SET billing_starts_on = '2020-01-01' WHERE id = ?").run(live.venueId);
    await issueDueInvoices();
    const invoice = (await listInvoices(live.venueId)).find((i) => i.status === "due")!;
    await getDb().prepare("UPDATE venue_invoices SET due_on = ? WHERE id = ?").run(addDays(todayISO(), -(GRACE_DAYS + 1)), invoice.id);
    await applyPaymentHolds();
    expect(await venueIsOpen(live.venueId)).toBe(false);
    expect(await noticesAt(live.venueId)).toBe(2);
  });

  it("leaves the customer's booking standing, and the customer free to cancel it as usual", async () => {
    const live = await liveBusiness();
    const booker = await customer();
    const booked = await createBooking({ courtId: live.courtId, date: addDays(todayISO(), 8), hours: [hour++], name: "B", phone: "0123222888", email: booker.email, userId: booker.id });
    if (!booked.ok) throw new Error("booking");
    await suspendVenue(live.venueId, "a reason");
    const row = (await getDb().prepare("SELECT status FROM bookings WHERE id = ?").get(booked.booking.id)) as { status: string };
    expect(row.status).toBe("confirmed");
    const cancelled = await cancelBooking(booked.booking.code, "0123222888");
    expect(cancelled.ok).toBe(true);
  });
});

describe("A4: nothing new is sold at a suspended venue", () => {
  const post = async (path: "passes" | "wallet" | "memberships" | "vouchers", adminId: number, body: object) => {
    const route = await import(`../src/app/api/admin/${path}/route`);
    return route.POST(
      new NextRequest(`http://localhost/api/admin/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(adminId)).token}` },
        body: JSON.stringify(body),
      })
    );
  };

  it("refuses a pass, a membership, credit and a voucher at the counter, with a code, until it is back", async () => {
    const live = await liveBusiness();
    const buyer = await customer();
    const today = todayISO();
    const sale = {
      passes: { venueId: live.venueId, name: "5 visits", entries: 5, price: 50, holderName: "Hana Holder", holderPhone: "0123555111", expiresOn: addDays(today, 30), via: "cash", priceReason: "A test sale at the counter" },
      memberships: { venueId: live.venueId, holderName: "Hana Holder", holderPhone: "0123555111", startsOn: today, expiresOn: addDays(today, 30), price: 40, via: "cash", priceReason: "A test sale at the counter" },
      wallet: { userId: buyer.id, amount: 30, venueId: live.venueId, via: "cash" },
      vouchers: { venueId: live.venueId, amount: 30, buyerName: "H", via: "cash" },
    } as const;
    await suspendVenue(live.venueId, "a reason");
    for (const path of ["passes", "memberships", "wallet", "vouchers"] as const) {
      const res = await post(path, live.manager.id, sale[path]);
      expect(res.status, path).toBe(409);
      expect(await res.json()).toMatchObject({ code: "FX11_SALES_SUSPENDED" });
    }
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM passes WHERE venue_id = ?").get(live.venueId)) as { n: number }).n).toBe(0);
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM wallet_entries WHERE venue_id = ?").get(live.venueId)) as { n: number }).n).toBe(0);

    expect((await liftVenue(live.venueId)).ok).toBe(true);
    for (const path of ["passes", "wallet"] as const) {
      const sold = await post(path, live.manager.id, sale[path]);
      expect(sold.status, JSON.stringify(await sold.clone().json())).toBe(201);
    }
  });

  it("refuses a pass bought online, and credit bought online, and says why", async () => {
    const live = await liveBusiness();
    const buyer = await customer();
    await suspendVenue(live.venueId, "a reason");
    const pass = await startPassPayment({ id: buyer.id, name: buyer.name, email: buyer.email }, live.venueId, { productId: 1 } as never);
    expect(pass).toMatchObject({ ok: false, status: 409, code: "FX11_SUSPENDED" });
    const topUp = await startTopUpPayment({ id: buyer.id, name: buyer.name, phone: buyer.phone, email: buyer.email }, live.venueId, 30);
    expect(topUp).toMatchObject({ ok: false, status: 409, code: "FX11_SUSPENDED" });
    if (!topUp.ok) expect(topUp.error).toContain("Bookings already made stand");
  });
});

describe("A7: time given to an overdue venue, without falsifying the books", () => {
  async function overdueVenue(daysPast = GRACE_DAYS + 1) {
    process.env.MYSENAM_VENUE_FEE = "99";
    const live = await liveBusiness();
    await getDb().prepare("UPDATE venues SET billing_starts_on = '2020-01-01' WHERE id = ?").run(live.venueId);
    await issueDueInvoices();
    const invoice = (await listInvoices(live.venueId)).find((i) => i.status === "due")!;
    await getDb().prepare("UPDATE venue_invoices SET due_on = ?, warned_at = NULL WHERE id = ?").run(addDays(todayISO(), -daysPast), invoice.id);
    return { ...live, invoiceId: invoice.id };
  }
  const invoiceRow = async (id: number) =>
    (await getDb().prepare("SELECT status, paid_at, paid_via, due_on, amount, billing_grace_until AS \"until\", billing_grace_reason AS reason, billing_grace_by AS by FROM venue_invoices WHERE id = ?").get(id)) as {
      status: string; paid_at: string | null; paid_via: string | null; due_on: string; amount: string | number; until: string | null; reason: string | null; by: string | null;
    };

  it("gives an invoice time: the venue is not held until after the date, and the invoice is left as issued", async () => {
    const v = await overdueVenue(GRACE_DAYS - 2);
    const before = await invoiceRow(v.invoiceId);
    const until = addDays(todayISO(), 10);
    expect(await giveInvoiceGrace(v.invoiceId, { until, reason: "Bank transfer delayed at their end", by: "Owner" })).toMatchObject({ ok: true });
    // Past its natural hold date: the venue would be held without it.
    await getDb().prepare("UPDATE venue_invoices SET due_on = ? WHERE id = ?").run(addDays(todayISO(), -(GRACE_DAYS + 1)), v.invoiceId);
    await applyPaymentHolds();
    expect(await venueIsOpen(v.venueId)).toBe(true);
    const row = await invoiceRow(v.invoiceId);
    // The books say what happened: still owed, not marked paid, nothing voided, nothing moved.
    expect(row).toMatchObject({ status: "due", paid_at: null, paid_via: null, until, reason: "Bank transfer delayed at their end", by: "Owner" });
    expect(String(row.amount)).toBe(String(before.amount));

    // After the date, if still owed: held.
    await applyPaymentHolds(new Date(Date.now() + 12 * 86_400_000));
    expect(await venueIsOpen(v.venueId)).toBe(false);
  });

  it("brings back a venue that is already held, at once, and tells its managers the date", async () => {
    const v = await overdueVenue();
    await applyPaymentHolds();
    expect(await venueIsOpen(v.venueId)).toBe(false);
    const until = addDays(todayISO(), 7);
    expect((await giveInvoiceGrace(v.invoiceId, { until, reason: "Agreed by phone with the owner", by: "Owner" })).ok).toBe(true);
    expect(await venueIsOpen(v.venueId)).toBe(true);
    const told = (await getDb().prepare("SELECT recipient, body FROM messages WHERE dedupe_key LIKE ?").all(`invoice-grace:${v.invoiceId}:${until}:%`)) as { recipient: string; body: string }[];
    expect(told.length).toBeGreaterThan(0);
    expect(told[0].body).toContain(until);
    expect(told[0].body).toContain(addDays(until, 1));
  });

  it("needs a reason, a sensible date, and an invoice that is still owed; and time can be taken back", async () => {
    const v = await overdueVenue();
    const until = addDays(todayISO(), 5);
    expect(await giveInvoiceGrace(v.invoiceId, { until, reason: "no", by: "Owner" })).toMatchObject({ ok: false, code: "BILL_REASON_REQUIRED" });
    expect(await giveInvoiceGrace(v.invoiceId, { until: todayISO(), reason: "Because of a delay", by: "Owner" })).toMatchObject({ ok: false });
    expect(await giveInvoiceGrace(v.invoiceId, { until: "2026-02-31", reason: "Because of a delay", by: "Owner" })).toMatchObject({ ok: false });
    expect(await giveInvoiceGrace(v.invoiceId, { until: addDays(todayISO(), 91), reason: "Because of a delay", by: "Owner" })).toMatchObject({ ok: false, error: "At most 90 days at a time." });
    expect(await giveInvoiceGrace(99_999, { until, reason: "Because of a delay", by: "Owner" })).toMatchObject({ ok: false, error: "That invoice is not waiting to be paid." });
    expect((await invoiceRow(v.invoiceId)).until).toBeNull();

    expect((await giveInvoiceGrace(v.invoiceId, { until, reason: "A delay at the bank", by: "Owner" })).ok).toBe(true);
    expect(await venueIsOpen(v.venueId)).toBe(true);
    // Taken back: held again at once, the invoice being long overdue.
    expect((await giveInvoiceGrace(v.invoiceId, { until: null, reason: "They paid nothing and said nothing", by: "Owner" })).ok).toBe(true);
    expect(await venueIsOpen(v.venueId)).toBe(false);
  });

  it("lifts a hold for payment with liftVenue: a date and a reason are needed, and it is the truth it says", async () => {
    const v = await overdueVenue();
    await applyPaymentHolds();
    expect(await venueIsOpen(v.venueId)).toBe(false);
    // Not the wrong answer "not suspended".
    const bare = await liftVenue(v.venueId);
    expect(bare).toMatchObject({ ok: false, code: "FX11_GRACE_NEEDED" });
    expect(!bare.ok && bare.error).not.toBe("That venue is not suspended.");
    expect(await liftVenue(v.venueId, { graceUntil: addDays(todayISO(), 7), reason: "x", by: "Owner" })).toMatchObject({ ok: false, code: "BILL_REASON_REQUIRED" });
    expect(await venueIsOpen(v.venueId)).toBe(false);

    const until = addDays(todayISO(), 7);
    const lifted = await liftVenue(v.venueId, { graceUntil: until, reason: "Paying by transfer on Monday", by: "Owner" });
    expect(lifted).toMatchObject({ ok: true, grace: { until, invoices: [{ id: v.invoiceId }] } });
    expect(await venueIsOpen(v.venueId)).toBe(true);
    expect(await invoiceRow(v.invoiceId)).toMatchObject({ status: "due", paid_via: null, until, reason: "Paying by transfer on Monday" });
    // Truly not suspended any more: the honest answer now.
    expect(await liftVenue(v.venueId)).toEqual({ ok: false, error: "That venue is not suspended." });
  });

  it("is the owner's, through the routes, and is in the activity log with the reason and the owner's name", async () => {
    const v = await overdueVenue();
    await applyPaymentHolds();
    const owner = (await listAdmins()).find((a) => a.id === ownerId)!;
    const cookie = async (id: number) => `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(id)).token}`;
    const billing = await import("../src/app/api/admin/billing/route");
    const suspensions = await import("../src/app/api/admin/suspensions/route");
    const call = async (handler: (req: NextRequest) => Promise<Response>, url: string, as: number, body: object) =>
      handler(new NextRequest(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json", cookie: await cookie(as) }, body: JSON.stringify(body) }));
    const until = addDays(todayISO(), 9);

    // A venue manager cannot give itself time.
    expect((await call(billing.POST, "/api/admin/billing", v.manager.id, { action: "giveTime", invoiceId: v.invoiceId, until, reason: "Please let us be" })).status).toBe(403);
    expect((await call(suspensions.POST, "/api/admin/suspensions", v.manager.id, { venueId: v.venueId, action: "lift", graceUntil: until, reason: "Please let us be" })).status).toBe(403);
    expect(await venueIsOpen(v.venueId)).toBe(false);

    // The owner: a reason is needed.
    expect((await call(billing.POST, "/api/admin/billing", ownerId, { action: "giveTime", invoiceId: v.invoiceId, until })).status).toBe(400);
    const done = await call(billing.POST, "/api/admin/billing", ownerId, { action: "giveTime", invoiceId: v.invoiceId, until, reason: "Transfer is on its way" });
    expect(done.status).toBe(200);
    expect(((await done.json()) as { invoice: { graceUntil: string } }).invoice.graceUntil).toBe(until);
    expect(await venueIsOpen(v.venueId)).toBe(true);
    // A business's invoice: the entry is the business's own, which its managers read (ADR 0057).
    const entry = (await listActivity(null)).find((a) => a.action === "invoice.grace_given" && (a.detail ?? "").includes(`invoice ${v.invoiceId},`));
    expect(entry).toMatchObject({ adminName: owner.name });
    expect(entry!.detail).toContain("Transfer is on its way");
    expect(entry!.detail).toContain(until);
    expect(entry!.detail).toContain("not marked paid");

    // The venue's own managers see the date but not the owner's reason.
    const own = await billing.GET(new NextRequest("http://localhost/api/admin/billing", { headers: { cookie: await cookie(v.manager.id) } }));
    const seen = ((await own.json()) as { invoices: { id: number; graceUntil: string | null; graceReason?: string }[] }).invoices.find((i) => i.id === v.invoiceId)!;
    expect(seen.graceUntil).toBe(until);
    expect(seen.graceReason).toBeUndefined();

    // Lifting a payment hold by the suspensions route is logged as the lift it is.
    const w = await overdueVenue();
    await applyPaymentHolds();
    const bare = await call(suspensions.POST, "/api/admin/suspensions", ownerId, { venueId: w.venueId, action: "lift" });
    expect(bare.status).toBe(409);
    expect(await bare.json()).toMatchObject({ code: "FX11_GRACE_NEEDED" });
    const lifted = await call(suspensions.POST, "/api/admin/suspensions", ownerId, { venueId: w.venueId, action: "lift", graceUntil: until, reason: "Agreed with the manager" });
    expect(lifted.status).toBe(200);
    expect(await venueIsOpen(w.venueId)).toBe(true);
    const lift = (await listActivity(null)).find((a) => a.action === "venue.suspension_lifted" && a.venueId === w.venueId);
    expect(lift!.detail).toContain("time given until");
    expect(lift!.detail).toContain("Agreed with the manager");
  });

  it("is not warned about as 'coming off on' a date it has been given time past", async () => {
    const v = await overdueVenue(WARN_AFTER_DAYS + 1);
    await giveInvoiceGrace(v.invoiceId, { until: addDays(todayISO(), 20), reason: "Time for the transfer", by: "Owner" });
    await applyPaymentHolds();
    const warned = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages WHERE dedupe_key LIKE ?").get(`invoice-overdue:${v.invoiceId}:%`)) as { n: number };
    expect(warned.n).toBe(0);
    expect(await venueIsOpen(v.venueId)).toBe(true);
  });
});

describe("A11: a branch is not approved on its own under a business that is not in good standing", () => {
  // Each branch has a pin of its own, and the map agrees with it: nothing about where it is needs a second look.
  let pin = { lat: 0, lng: 0 };
  let pins = 0;
  const geocode = () => {
    process.env.MYSENAM_AUTO_APPROVE_BRANCHES = "on";
    process.env.MYSENAM_GEOCODER = "http://geo.test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        Response.json(
          url.includes("/search")
            ? [{ lat: String(pin.lat), lon: String(pin.lng + 0.002), display_name: "1 Jalan Cabang" }]
            : { display_name: "Seremban, Negeri Sembilan, Malaysia" }
        )
      )
    );
  };
  const newBranch = async (live: Live, name: string) => {
    pins++;
    pin = { lat: 3.4 + pins * 0.05, lng: 101.3 };
    const added = await addBranch(live.manager, { name, area: "Seremban", address: `${pins} Jalan Cabang`, phone: "0600099999", ...pin });
    if (!added.ok) throw new Error(added.error);
    const court = await createCourt({ venueId: added.venueId!, name: "Court 1", sport: "badminton", offPeakRate: 10, peakRate: 10 });
    if (!court.ok) throw new Error("court");
    return added.venueId!;
  };

  it("goes live on its own for a business in good standing (the control)", async () => {
    const live = await liveBusiness();
    geocode();
    const branch = await newBranch(live, "Cabang Baik");
    expect(await requestGoLive(live.manager, branch)).toEqual({ ok: true, live: true });
    expect(await venueIsOpen(branch)).toBe(true);
  });

  it("waits for the owner when the business's only live branch is suspended at venue level", async () => {
    const live = await liveBusiness();
    geocode();
    await suspendVenue(live.venueId, "a complaint");
    const branch = await newBranch(live, "Cabang Tangguh");
    const asked = await requestGoLive(live.manager, branch);
    expect(asked).toEqual({ ok: true, live: false });
    expect(await venueIsOpen(branch)).toBe(false);
    const application = (await getDb().prepare("SELECT id, status FROM venue_applications WHERE venue_id = ?").get(branch)) as { id: number; status: string };
    expect(application.status).toBe("pending");
    expect((await applicationById(application.id))!.status).toBe("pending");
    // The owner is told why it was not approved on its own.
    const told = (await getDb().prepare("SELECT body FROM messages WHERE kind = 'staff_alert' AND body LIKE '%not approved automatically%'").all()) as { body: string }[];
    expect(told.length).toBeGreaterThan(0);
    // The owner may still decide.
    expect((await approveApplication(application.id, ownerId, REVIEW_CHECKS.map((c) => c.id))).ok).toBe(true);
  });

  it("waits for the owner when a sibling is held for an invoice, even if another branch is open", async () => {
    const live = await liveBusiness();
    geocode();
    const second = await newBranch(live, "Cabang Kedua");
    expect((await requestGoLive(live.manager, second)).ok).toBe(true);
    expect(await venueIsOpen(second)).toBe(true);
    await getDb().prepare("UPDATE venues SET suspended_at = datetime('now'), suspended_by = 'payment' WHERE id = ?").run(live.venueId);
    const third = await newBranch(live, "Cabang Ketiga");
    expect(await requestGoLive(live.manager, third)).toEqual({ ok: true, live: false });
    expect(await venueIsOpen(third)).toBe(false);
  });

  it("is refused, as before, for a suspended business", async () => {
    const live = await liveBusiness();
    geocode();
    const branch = await newBranch(live, "Cabang Gantung");
    await suspendBusiness(live.businessId, "a business matter");
    expect(await requestGoLive(live.manager, branch)).toMatchObject({ ok: false });
    expect(await venueIsOpen(branch)).toBe(false);
  });
});
