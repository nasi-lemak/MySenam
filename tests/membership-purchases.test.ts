import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import crypto, { createHash } from "crypto";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.sg";
process.env.MYSENAM_COUNTRY = "SG";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { setAccessSettings } from "../src/lib/access";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { documentsForUser, lineText } from "../src/lib/documents";
import { acceptGuardianInvite, requestAtVenue } from "../src/lib/guardian-requests";
import { addManaged } from "../src/lib/managed-people";
import { addMonths, createPlan, setPlanBenefits } from "../src/lib/membership-plans";
import { changeCovers, purchaseTerms } from "../src/lib/membership-purchases";
import { createAtVenue, participantHistory } from "../src/lib/participants";
import { paymentByBill, renewalsFor, savePaymentSettings, settleBill, startMembershipPayment, stopRenewalOf } from "../src/lib/payments";
import { exportCustomerData } from "../src/lib/privacy";
import { createResources } from "../src/lib/resources";
import { activeMembership, createVenue, listMembershipsFor, listMembershipsForVenue, participantMembership } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import * as myMembership from "../src/app/api/my/membership/route";
import * as quoteRoute from "../src/app/api/my/membership/quote/route";
import * as plansRoute from "../src/app/api/admin/membership-plans/route";
import * as adminMemberships from "../src/app/api/admin/memberships/route";
import * as bookingsRoute from "../src/app/api/bookings/route";
import { POST as callback } from "../src/app/api/payments/[provider]/callback/route";

/**
 * Memberships bought online for oneself, for a child or other participant
 * the account is an active guardian of, and family memberships naming the
 * dependants they cover (lib/membership-purchases.ts;
 * docs/features/pricing.md#joining-online), paid through the venue's Stripe
 * (a stand-in for Stripe's API and its signed webhooks: no live calls).
 */

const SECRET = "whsec_purchasesecret123456";
const KEY = "rk_test_purchasekey1234567";
let venueId: number;
let pool: number;
let plans: { individual: number; family: number; adult: number; junior: number };
let manager: string;
let n = 0;
const sessions: string[] = [];
let sent: { url: string; method: string }[] = [];

function fakeStripe() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string }) => {
      sent.push({ url, method: init.method ?? "GET" });
      if (init.method === "DELETE") return Response.json({ id: url.split("/").pop(), object: "subscription", status: "canceled" });
      const id = `cs_test_mbo${++n}`;
      sessions.push(id);
      return Response.json({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
    })
  );
}

const signed = (body: string) => {
  const at = Math.floor(Date.now() / 1000);
  return `t=${at},v1=${crypto.createHmac("sha256", SECRET).update(`${at}.${body}`).digest("hex")}`;
};
const webhook = (event: object) => {
  const body = JSON.stringify(event);
  return callback(
    new NextRequest("http://localhost/api/payments/stripe/callback", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signed(body) },
      body,
    }),
    { params: Promise.resolve({ provider: "stripe" }) }
  );
};
const session = (id: string, type: string, object: Record<string, unknown>) => ({
  id: `evt_${id}_${type}`,
  type,
  created: Math.floor(Date.now() / 1000),
  data: { object: { id, object: "checkout.session", ...object } },
});
const completed = (id: string, subscription?: string) =>
  session(id, "checkout.session.completed", { payment_status: "paid", status: "complete", ...(subscription ? { subscription } : {}) });
const expired = (id: string) => session(id, "checkout.session.expired", { payment_status: "unpaid", status: "expired" });
const invoicePaid = (invoice: string, subscription: string, amount: number) => ({
  id: `evt_${invoice}`,
  type: "invoice.paid",
  created: Math.floor(Date.now() / 1000),
  data: { object: { id: invoice, object: "invoice", billing_reason: "subscription_cycle", amount_paid: amount, parent: { subscription_details: { subscription } } } },
});

type Adult = { id: number; name: string; email: string; phone: string; cookie: string };
async function adult(name = "Parent"): Promise<Adult> {
  const k = ++n;
  const phone = `9${String(4000000 + k).padStart(7, "0")}`;
  const made = await registerUser({ name: `${name} ${k}`, email: `mbo${k}@example.sg`, phone, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return { ...made.user, phone, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}
async function child(parent: Adult, displayName: string) {
  const made = await addManaged(parent.id, { displayName, relationship: "parent", authority: true }, parent.name);
  if (!made.ok) throw new Error(`${made.code}: ${made.error}`);
  return { id: made.person.id, name: made.person.displayName };
}
const req = (url: string, method: string, cookie: string | null, body?: unknown) =>
  new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.77.${++n % 250}.${n % 200}`, ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
async function buy(who: Adult, body: Record<string, unknown>) {
  fakeStripe();
  const before = sessions.length;
  const res = await myMembership.POST(req("http://localhost/api/my/membership", "POST", who.cookie, body));
  const data = (await res.json()) as Record<string, unknown>;
  vi.unstubAllGlobals();
  return { status: res.status, body: data, session: sessions.length > before ? sessions[sessions.length - 1] : null };
}
async function quote(who: Adult, body: Record<string, unknown>) {
  const res = await quoteRoute.POST(req("http://localhost/api/my/membership/quote", "POST", who.cookie, body));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const purchaseOf = async (sessionId: string) =>
  (await getDb()
    .prepare("SELECT pu.status, pu.why, pu.membership_id FROM membership_purchases pu JOIN online_payments p ON p.id = pu.payment_id WHERE p.bill_id = ?")
    .get(sessionId)) as { status: string; why: string | null; membership_id: number | null };
const count = async (sql: string, ...args: unknown[]) => ((await getDb().prepare(sql).get(...args)) as { n: number }).n;

beforeAll(async () => {
  const v = await createVenue({ name: "Tanjong Swim Club", area: "Tanjong Pagar", address: "x", phone: "61234500", openMin: 7 * 60, closeMin: 22 * 60 });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  const saved = await savePaymentSettings(venueId, { credentials: { secretKey: KEY, webhookSecret: SECRET }, sandbox: true, enabled: true });
  if (!saved.ok) throw new Error(saved.error);
  const r = await createResources({ venueId, sport: "swimming", name: "Club pool", offPeakRate: 10, peakRate: 10, capacity: 8, maxPlayers: 8 });
  if (!r.ok) throw new Error(r.error);
  pool = r.courts[0].id;
  expect((await setAccessSettings(venueId, { access: "members" })).ok).toBe(true);
  const plan = async (input: Record<string, unknown>) => {
    const made = await createPlan(venueId, input as Parameters<typeof createPlan>[1]);
    if (!made.ok) throw new Error(made.error);
    return made.plan.id;
  };
  plans = {
    individual: await plan({ name: "Swimmer", months: 3, price: 120, ratePercent: 50, scope: "participant", offeredFor: "individual" }),
    family: await plan({ name: "Family", months: 12, price: 300, offeredFor: "family", familyLimit: 2 }),
    adult: await plan({ name: "Adult", months: 1, price: 40 }),
    junior: await plan({ name: "Junior", months: 6, price: 60, offeredFor: "participant" }),
  };
  const admin = await createAdmin({ name: "Manager", email: "mbo-manager@example.sg", password: "a long enough password", venueId, role: "manager" });
  if (!admin.ok) throw new Error(admin.error);
  manager = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(admin.admin.id)).token}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  sent = [];
});

afterAll(() => {
  delete process.env.MYSENAM_COUNTRY;
});

describe("whom a plan is sold to online", () => {
  it("is the plan's: the account (every plan before), a participant, either, or a family within its limit", async () => {
    expect(await createPlan(venueId, { name: "Bad", months: 1, price: 10, offeredFor: "everyone" })).toMatchObject({ ok: false });
    expect(await createPlan(venueId, { name: "Bad", months: 1, price: 10, offeredFor: "family" })).toMatchObject({
      ok: false,
      error: "A family plan covers 1–12 people besides its holder.",
    });
    expect(await createPlan(venueId, { name: "Bad", months: 1, price: 10, offeredFor: "family", familyLimit: 13 })).toMatchObject({ ok: false });
    const list = await plansRoute.GET(req(`http://localhost/api/admin/membership-plans?venueId=${venueId}`, "GET", manager));
    const shown = ((await list.json()) as { plans: { id: number; offeredFor: string; familyLimit: number | null }[] }).plans;
    expect(shown.find((p) => p.id === plans.adult)).toMatchObject({ offeredFor: "account", familyLimit: null });
    expect(shown.find((p) => p.id === plans.family)).toMatchObject({ offeredFor: "family", familyLimit: 2 });
    // Changing other benefits keeps whom it is sold to; a manager changes that through the same route.
    const kept = await setPlanBenefits(venueId, plans.family, { ratePercent: null, aheadDays: null });
    expect(kept.ok && [kept.plan.offeredFor, kept.plan.familyLimit]).toEqual(["family", 2]);
    const patched = await plansRoute.PATCH(
      req("http://localhost/api/admin/membership-plans", "PATCH", manager, { venueId, id: plans.adult, ratePercent: null, aheadDays: null, offeredFor: "individual" })
    );
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { plan: { offeredFor: string } }).plan.offeredFor).toBe("individual");
    await setPlanBenefits(venueId, plans.adult, { ratePercent: null, aheadDays: null, offeredFor: "account" });
  });
});

describe("buying for a child the account looks after", () => {
  it("shows the price and dates first, makes nothing until it is paid, then makes the child's own membership once", async () => {
    const parent = await adult("Mum");
    const kid = await child(parent, "Alya");
    const q = await quote(parent, { planId: plans.individual, participantId: kid.id });
    expect(q.status).toBe(200);
    const today = todayISO();
    expect(q.body).toMatchObject({
      price: 120,
      startsOn: today,
      expiresOn: addDays(addMonths(today, 3), -1),
      renewing: false,
      holder: { id: kid.id, name: "Alya" },
      covers: [],
    });

    const bought = await buy(parent, { planId: plans.individual, participantId: kid.id });
    expect(bought.status).toBe(200);
    expect(bought.body).toMatchObject({ amount: 120, reused: false });
    // Unpaid: pending, and nobody is a member.
    expect(await purchaseOf(bought.session!)).toMatchObject({ status: "pending", membership_id: null });
    expect(await listMembershipsFor(parent.id)).toEqual([]);
    expect(await participantMembership(venueId, kid.id)).toBeNull();
    const pending = await myMembership.GET(req("http://localhost/api/my/membership", "GET", parent.cookie));
    expect(((await pending.json()) as { pending: unknown[] }).pending).toMatchObject([{ holderName: "Alya", price: 120, status: "pending" }]);

    // Paid: the webhook and the customer's return, each told twice, make one membership.
    for (let i = 0; i < 2; i++) expect((await webhook(completed(bought.session!))).status).toBe(200);
    await settleBill({ billId: bought.session!, paid: true, paidAt: null });
    const mine = await listMembershipsFor(parent.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ holderParticipantId: kid.id, holderParticipantName: "Alya", online: true, price: 120, startsOn: today });
    expect(await purchaseOf(bought.session!)).toMatchObject({ status: "made", membership_id: mine[0].id });
    // The child's alone: not the parent's.
    expect((await participantMembership(venueId, kid.id))?.id).toBe(mine[0].id);
    expect(await activeMembership(venueId, parent.phone)).toBeNull();
    // The receipt names whom it is for; the child's history says who bought it.
    const receipt = (await documentsForUser(parent.id)).find((d) => d.lines[0].description.startsWith("Membership"))!;
    // Said with the names, kept apart from the words so retention and erasure clear them (lib/receipt-names.ts).
    expect(lineText(receipt.lines[0])).toBe(`Membership ${mine[0].code} for Alya, ${today} to ${mine[0].expiresOn}`);
    expect(receipt.lines[0]).toMatchObject({ description: `Membership ${mine[0].code} for {who}, ${today} to ${mine[0].expiresOn}`, who: ["Alya"] });
    expect(receipt).toMatchObject({ total: 120, paidVia: "Online (Stripe)" });
    expect((await participantHistory(kid.id)).some((e) => e.action === "membership.bought" && e.detail?.includes(mine[0].code))).toBe(true);
    expect(await paymentByBill(bought.session!)).toMatchObject({ status: "paid", refundOwed: 0 });

    // Renewing opens near the end, said with the child's name.
    expect(await quote(parent, { planId: plans.individual, participantId: kid.id })).toMatchObject({ status: 409, body: { code: "MBO_TOO_EARLY", vars: { name: "Alya" } } });
  });

  it("a junior plan is sold only for somebody looked after; a plan for the account only, only for the account", async () => {
    const parent = await adult("Dad");
    const kid = await child(parent, "Bilal");
    expect((await quote(parent, { planId: plans.junior })).body).toMatchObject({ code: "MBO_NOT_FOR_ACCOUNT" });
    expect((await quote(parent, { planId: plans.adult, participantId: kid.id })).body).toMatchObject({ code: "MBO_NOT_FOR_PARTICIPANT" });
    expect((await quote(parent, { planId: plans.individual, covers: [kid.id] })).body).toMatchObject({ code: "MBO_NOT_FAMILY" });
    expect((await quote(parent, { planId: plans.junior, participantId: kid.id })).status).toBe(200);
    // For oneself, as before.
    const self = await buy(parent, { planId: plans.adult });
    expect(self.status).toBe(200);
    await webhook(completed(self.session!));
    expect(await activeMembership(venueId, parent.phone)).toMatchObject({ holderParticipantId: null, online: true });
  });

  it("is refused for somebody the account does not act for: another's child, a paused relationship, a request still pending", async () => {
    const parent = await adult("Guardian");
    const stranger = await adult("Stranger");
    const kid = await child(parent, "Chen");
    expect(await buy(stranger, { planId: plans.individual, participantId: kid.id })).toMatchObject({ status: 404, body: { code: "MBO_NOT_GUARDIAN" }, session: null });
    // Paused for a review: refused, and said so.
    await getDb().prepare("UPDATE participant_guardians SET suspended_at = now() WHERE participant_id = ? AND user_id = ?").run(kid.id, parent.id);
    expect(await buy(parent, { planId: plans.individual, participantId: kid.id })).toMatchObject({ status: 409, body: { code: "MBO_PAUSED", vars: { name: "Chen" } }, session: null });
    expect((await quote(parent, { planId: plans.family, covers: [kid.id] })).body).toMatchObject({ code: "MBO_PAUSED" });
    await getDb().prepare("UPDATE participant_guardians SET suspended_at = NULL WHERE participant_id = ? AND user_id = ?").run(kid.id, parent.id);
    // An adult whose request to become a guardian is still waiting is nobody's guardian yet.
    const known = await createAtVenue({
      venueId,
      admin: { id: null, name: "Desk" },
      displayName: "Dina",
      guardian: { name: "Puan D", phone: "81112222", relationship: "parent", authority: true },
    });
    if (!known.ok) throw new Error(known.error);
    const asked = await requestAtVenue({ venueId, participantId: known.participant.id, admin: { id: null, name: "Desk" }, proposedName: stranger.name });
    if (!asked.ok) throw new Error(asked.error);
    const hash = createHash("sha256").update(asked.code.replace(/[^A-Z0-9]/g, "")).digest("hex");
    expect(await acceptGuardianInvite(stranger, hash, { relationship: "parent", authority: true })).toMatchObject({ ok: true, as: "pending" });
    expect(await buy(stranger, { planId: plans.individual, participantId: known.participant.id })).toMatchObject({ body: { code: "MBO_NOT_GUARDIAN" }, session: null });
    expect(await buy(stranger, { planId: plans.family, covers: [known.participant.id] })).toMatchObject({ body: { code: "MBO_NOT_GUARDIAN" }, session: null });
    expect(await count("SELECT COUNT(*)::int AS n FROM membership_purchases WHERE user_id = ?", stranger.id)).toBe(0);
  });
});

describe("a family membership", () => {
  it("names the dependants it covers, within the plan's limit; the holder and each of them are members", async () => {
    const parent = await adult("Family");
    const [a, b, c] = [await child(parent, "Ena"), await child(parent, "Fikri"), await child(parent, "Gita")];
    expect((await quote(parent, { planId: plans.family })).body).toMatchObject({ code: "MBO_FAMILY_EMPTY" });
    expect(await buy(parent, { planId: plans.family, covers: [a.id, b.id, c.id] })).toMatchObject({ status: 409, body: { code: "MBO_FAMILY_LIMIT", vars: { n: 2 } }, session: null });
    expect((await quote(parent, { planId: plans.family, participantId: a.id, covers: [b.id] })).body).toMatchObject({ code: "MBO_NOT_FOR_PARTICIPANT" });
    const bought = await buy(parent, { planId: plans.family, covers: [a.id, b.id] });
    expect(bought.status).toBe(200);
    expect(await participantMembership(venueId, a.id)).toBeNull();
    await webhook(completed(bought.session!));
    const [m] = await listMembershipsFor(parent.id);
    expect(m).toMatchObject({ holderParticipantId: null, covers: [{ id: a.id, name: "Ena" }, { id: b.id, name: "Fikri" }], price: 300 });
    expect((await activeMembership(venueId, parent.phone))?.id).toBe(m.id);
    expect((await participantMembership(venueId, b.id))?.id).toBe(m.id);
    expect(await participantMembership(venueId, c.id)).toBeNull();
    const receipt = (await documentsForUser(parent.id)).find((d) => d.lines[0].description.startsWith("Membership"))!;
    expect(lineText(receipt.lines[0])).toBe(`Membership ${m.code} for ${parent.name}, Ena, Fikri, ${m.startsOn} to ${m.expiresOn}`);
    expect(receipt.lines[0].who).toEqual([parent.name, "Ena", "Fikri"]);
    // Covered already: refused for the same days, said with the date it ends.
    expect((await quote(parent, { planId: plans.individual, participantId: a.id })).body).toMatchObject({
      code: "MBO_ALREADY_COVERED",
      vars: { name: "Ena", until: m.expiresOn },
    });

    // Staff see it as they see one sold at the counter: online, its holder and whom it covers.
    const staff = await adminMemberships.GET(req(`http://localhost/api/admin/memberships?venueId=${venueId}`, "GET", manager));
    const listed = ((await staff.json()) as { memberships: { id: number; online: boolean; covers: { name: string }[] }[] }).memberships.find((x) => x.id === m.id);
    expect(listed).toMatchObject({ online: true, covers: [{ name: "Ena" }, { name: "Fikri" }] });
    expect((await listMembershipsForVenue(venueId)).some((x) => x.holderParticipantName === "Alya" && x.online)).toBe(true);

    // The account's data export has it, structured: whom it covers, and the purchase as chosen.
    const exported = (await exportCustomerData(parent.id))!;
    expect(exported.memberships).toContainEqual(expect.objectContaining({ code: m.code, covers: "Ena, Fikri", for_participant: null }));
    expect(exported.membershipPurchases).toContainEqual(expect.objectContaining({ plan: "Family", covers: "Ena, Fikri", status: "made" }));
  });

  it("changes whom it covers: added within the limit, removed, at the same price; only by its buyer, only for their own people", async () => {
    const parent = await adult("Changer");
    const [a, b, c] = [await child(parent, "Hana"), await child(parent, "Irfan"), await child(parent, "Jun")];
    const bought = await buy(parent, { planId: plans.family, covers: [a.id] });
    await webhook(completed(bought.session!));
    const [m] = await listMembershipsFor(parent.id);
    const patch = (who: Adult, covers: unknown) => myMembership.PATCH(req("http://localhost/api/my/membership", "PATCH", who.cookie, { membershipId: m.id, covers }));

    const added = await patch(parent, [a.id, b.id]);
    expect(added.status).toBe(200);
    expect(((await added.json()) as { membership: { covers: { name: string }[] } }).membership.covers.map((x) => x.name)).toEqual(["Hana", "Irfan"]);
    expect((await participantMembership(venueId, b.id))?.id).toBe(m.id);
    // Over the limit.
    expect(((await (await patch(parent, [a.id, b.id, c.id])).json()) as { code: string }).code).toBe("MBO_FAMILY_LIMIT");
    // Somebody else's child, or a stranger changing it.
    const other = await adult("Other");
    const theirs = await child(other, "Kiki");
    expect(((await (await patch(parent, [a.id, theirs.id])).json()) as { code: string }).code).toBe("MBO_NOT_GUARDIAN");
    expect((await patch(other, [theirs.id])).status).toBe(404);
    // Removed: no longer a member through it. The price stays as sold, with no second receipt or credit note.
    expect((await patch(parent, [b.id])).status).toBe(200);
    expect(await participantMembership(venueId, a.id)).toBeNull();
    expect((await listMembershipsFor(parent.id))[0]).toMatchObject({ price: 300, covers: [{ id: b.id }] });
    expect((await documentsForUser(parent.id)).filter((d) => d.lines.some((l) => l.description.includes(m.code)))).toHaveLength(1);
    expect((await participantHistory(a.id)).map((e) => e.action)).toEqual(expect.arrayContaining(["membership.bought", "membership.uncovered"]));
    expect((await participantHistory(b.id)).map((e) => e.action)).toContain("membership.covered");
    // A membership that is not a family one bought online is the venue's to change.
    const single = await buy(parent, { planId: plans.individual, participantId: c.id });
    await webhook(completed(single.session!));
    const childs = (await listMembershipsFor(parent.id)).find((x) => x.holderParticipantId === c.id)!;
    expect(await changeCovers(parent.id, childs.id, [a.id])).toMatchObject({ ok: false, code: "MBO_NOT_CHANGEABLE" });
  });
});

describe("paying", () => {
  it("holds the people a purchase names while it is paid: the same purchase goes back to its page, another naming them waits", async () => {
    const parent = await adult("Holder");
    const kid = await child(parent, "Lina");
    const first = await buy(parent, { planId: plans.individual, participantId: kid.id });
    const again = await buy(parent, { planId: plans.individual, participantId: kid.id });
    expect(again).toMatchObject({ status: 200, body: { reused: true, url: `https://checkout.stripe.com/c/pay/${first.session}` }, session: null });
    const other = await buy(parent, { planId: plans.family, covers: [kid.id] });
    expect(other).toMatchObject({ status: 409, body: { code: "MBO_PENDING" }, session: null });
    expect(await count("SELECT COUNT(*)::int AS n FROM membership_purchases WHERE user_id = ? AND status = 'pending'", parent.id)).toBe(1);
  });

  it("a payment that fails or lapses releases the purchase, and never makes a membership", async () => {
    const parent = await adult("Failing");
    const kid = await child(parent, "Maya");
    const first = await buy(parent, { planId: plans.junior, participantId: kid.id });
    expect((await webhook(expired(first.session!))).status).toBe(200);
    expect(await purchaseOf(first.session!)).toMatchObject({ status: "released", why: "not_paid", membership_id: null });
    expect(await participantMembership(venueId, kid.id)).toBeNull();
    // Released: a new purchase may name her at once.
    const second = await buy(parent, { planId: plans.junior, participantId: kid.id });
    expect(second.status).toBe(200);
    // A hold that lapses with nothing heard releases it too.
    await getDb().prepare("UPDATE membership_purchases SET hold_until = now() - interval '1 minute' WHERE status = 'pending' AND user_id = ?").run(parent.id);
    const third = await buy(parent, { planId: plans.individual, participantId: kid.id });
    expect(third.status).toBe(200);
    expect(await purchaseOf(second.session!)).toMatchObject({ status: "released", why: "expired" });
    expect(await listMembershipsFor(parent.id)).toEqual([]);
    // Money that still comes in for a released purchase makes the membership where it can.
    await webhook(completed(second.session!));
    expect(await listMembershipsFor(parent.id)).toMatchObject([{ holderParticipantId: kid.id, price: 60 }]);
    // And the other one, paid for the same months, is owed back, its purchase saying why.
    await webhook(completed(third.session!));
    expect(await listMembershipsFor(parent.id)).toHaveLength(1);
    expect(await paymentByBill(third.session!)).toMatchObject({ status: "paid", refundOwed: 120 });
    expect(await purchaseOf(third.session!)).toMatchObject({ status: "owed_back", why: "MBO_TOO_EARLY" });
  });

  it("is owed back, making nothing, when the account stopped acting for the child before the money came in", async () => {
    const parent = await adult("Ended");
    const kid = await child(parent, "Nur");
    const bought = await buy(parent, { planId: plans.individual, participantId: kid.id });
    await getDb().prepare("UPDATE participant_guardians SET revoked_at = now() WHERE participant_id = ? AND user_id = ?").run(kid.id, parent.id);
    await webhook(completed(bought.session!));
    expect(await listMembershipsFor(parent.id)).toEqual([]);
    expect(await paymentByBill(bought.session!)).toMatchObject({ status: "paid", refundOwed: 120 });
    expect(await purchaseOf(bought.session!)).toMatchObject({ status: "owed_back", why: "MBO_NOT_GUARDIAN" });
  });
});

describe("renewing by itself", () => {
  it("names the same holder and dependants again, as the membership names them then, less anybody no longer looked after", async () => {
    const parent = await adult("Renewer");
    const [a, b] = [await child(parent, "Omar"), await child(parent, "Puteri")];
    const bought = await buy(parent, { planId: plans.family, covers: [a.id], autoRenew: true });
    expect(bought.status).toBe(200);
    expect((await webhook(completed(bought.session!, "sub_family"))).status).toBe(200);
    const [first] = await listMembershipsFor(parent.id);
    // Puteri added before it renews; then the account stops acting for Omar.
    expect((await changeCovers(parent.id, first.id, [a.id, b.id])).ok).toBe(true);
    await getDb().prepare("UPDATE participant_guardians SET archived_at = now() WHERE participant_id = ? AND user_id = ?").run(a.id, parent.id);
    for (let i = 0; i < 2; i++) expect((await webhook(invoicePaid("in_family_2", "sub_family", 30000))).status).toBe(200);
    const all = await listMembershipsFor(parent.id);
    expect(all).toHaveLength(2);
    const next = all.find((m) => m.id !== first.id)!;
    expect(next).toMatchObject({ startsOn: addDays(first.expiresOn, 1), holderParticipantId: null, covers: [{ id: b.id, name: "Puteri" }] });
    expect((await participantHistory(b.id)).map((e) => e.action)).toContain("membership.renewed");

    // A child's own membership renewing: still the child's, and stopped when the venue cancels it.
    const kid = await child(parent, "Qistina");
    const own = await buy(parent, { planId: plans.individual, participantId: kid.id, autoRenew: true });
    await webhook(completed(own.session!, "sub_child"));
    await webhook(invoicePaid("in_child_2", "sub_child", 12000));
    const kids = (await listMembershipsFor(parent.id)).filter((m) => m.holderParticipantId === kid.id);
    expect(kids).toHaveLength(2);
    expect(await renewalsFor(parent.id, venueId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ holderParticipantId: kid.id, holderName: "Qistina" }), expect.objectContaining({ holderParticipantId: null })])
    );
    sent = [];
    fakeStripe();
    expect(await stopRenewalOf(kids[0].id)).toBeNull();
    expect(sent).toEqual([expect.objectContaining({ method: "DELETE", url: "https://api.stripe.com/v1/subscriptions/sub_child" })]);
  });
});

describe("member prices and members-only places, per participant", () => {
  it("a child's membership bought online prices and admits the child's own place, never a brother's", async () => {
    const parent = await adult("Booker");
    const [member, other] = [await child(parent, "Rafiq"), await child(parent, "Sara")];
    const bought = await buy(parent, { planId: plans.individual, participantId: member.id });
    await webhook(completed(bought.session!));
    const day = addDays(todayISO(), 2);
    const book = async (participantIds: number[]) => {
      const res = await bookingsRoute.POST(req("http://localhost/api/bookings", "POST", parent.cookie, { name: parent.name, phone: parent.phone, courtId: pool, date: day, start: 9 * 60, end: 10 * 60, participantIds }));
      return { status: res.status, body: (await res.json()) as { code?: string; vars?: { name: string }; booking?: { totalPrice: number } } };
    };
    // The plan's price is for the members' own places: half of SGD 10.
    expect(await book([member.id])).toMatchObject({ status: 201, body: { booking: { totalPrice: 5 } } });
    // Members only: Sara is not a member, whoever books her.
    expect(await book([member.id, other.id])).toMatchObject({ status: 409, body: { code: "ENT_MEMBERS_PLACE", vars: { name: "Sara" } } });
  });
});

describe("at the same moment", () => {
  it("two purchases naming one child at once: one page, never two waiting", async () => {
    const parent = await adult("Racer");
    const kid = await child(parent, "Tini");
    fakeStripe();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => startMembershipPayment(parent, plans.individual, { participantId: kid.id }))
    );
    expect(results.filter((r) => r.ok && !r.reused)).toHaveLength(1);
    expect(results.every((r) => r.ok || r.code === "MBO_PENDING")).toBe(true);
    expect(await count("SELECT COUNT(*)::int AS n FROM membership_purchases WHERE user_id = ? AND status = 'pending'", parent.id)).toBe(1);
  });

  it("two changes to whom a family membership covers at once: each applied whole or refused, one after the other, never past the limit or the term's places", async () => {
    const parent = await adult("Adder");
    const [a, b, c] = [await child(parent, "Uma"), await child(parent, "Vin"), await child(parent, "Wan")];
    const bought = await buy(parent, { planId: plans.family, covers: [a.id] });
    await webhook(completed(bought.session!));
    const [m] = await listMembershipsFor(parent.id);
    const both = await Promise.all([changeCovers(parent.id, m.id, [a.id, b.id]), changeCovers(parent.id, m.id, [a.id, c.id])]);
    // One after the other under the membership's lock: the first fills the term's last place, so the
    // second (taking the first's person off to put another on) has none left (the owner's decision of 27 October 2026).
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(both.filter((r) => !r.ok).map((r) => !r.ok && r.code)).toEqual(["MBO_NO_PLACES_LEFT"]);
    // Never more than the plan's limit at once.
    expect(await count("SELECT COUNT(*)::int AS n FROM membership_participants WHERE membership_id = ?", m.id)).toBe(2);
    const three = await Promise.all([changeCovers(parent.id, m.id, [a.id, b.id, c.id]), changeCovers(parent.id, m.id, [a.id, c.id, b.id])]);
    expect(three.every((r) => !r.ok && r.code === "MBO_FAMILY_LIMIT")).toBe(true);
    expect(await count("SELECT COUNT(*)::int AS n FROM membership_participants WHERE membership_id = ?", m.id)).toBeLessThanOrEqual(2);
  });

  it("the terms say the same as the payment", async () => {
    const parent = await adult("Terms");
    const kid = await child(parent, "Xena");
    const terms = await purchaseTerms(parent.id, { planId: plans.junior, participantId: kid.id });
    expect(terms).toMatchObject({ ok: true, terms: { price: 60, holder: { id: kid.id }, covers: [] } });
  });
});
