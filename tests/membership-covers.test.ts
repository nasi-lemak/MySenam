import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "crypto";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.sg";
process.env.MYSENAM_COUNTRY = "SG";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { documentsForUser } from "../src/lib/documents";
import { addManaged } from "../src/lib/managed-people";
import { addMonths, createPlan, planById, setPlanBenefits } from "../src/lib/membership-plans";
import { changeCovers, correctCover, coverHistory, coverStanding, setNextCovers } from "../src/lib/membership-purchases";
import { createAtVenue, participantHistory } from "../src/lib/participants";
import { savePaymentSettings } from "../src/lib/payments";
import { createResources } from "../src/lib/resources";
import { createVenue, listMembershipsFor, participantMembership } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import * as myMembership from "../src/app/api/my/membership/route";
import * as plansRoute from "../src/app/api/admin/membership-plans/route";
import * as adminMemberships from "../src/app/api/admin/memberships/route";
import * as coversRoute from "../src/app/api/admin/memberships/[id]/covers/route";
import * as bookingsRoute from "../src/app/api/bookings/route";
import { POST as callback } from "../src/app/api/payments/[provider]/callback/route";

/**
 * Whom a family membership covers, changed within a term by the plan's
 * policy (the owner's decision of 27 October 2026;
 * lib/membership-purchases.ts; docs/features/pricing.md#changing-whom-a-family-membership-covers):
 * adding within the term's places, removing with nothing back, replacements
 * only as the plan allows, a different list from the next term, a manager's
 * correction with a reason, and every change kept as a record. Paid through a
 * stand-in for Stripe's API and signed webhooks: no live calls.
 */

const SECRET = "whsec_coverssecret12345678";
let venueId: number;
let pool: number;
let plans: { four: number; duo: number; single: number; kid: number };
let manager: string;
let desk: string;
let n = 0;
const sessions: string[] = [];

function fakeStripe() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string }) => {
      if (init.method === "DELETE") return Response.json({ id: url.split("/").pop(), object: "subscription", status: "canceled" });
      const id = `cs_test_cov${++n}`;
      sessions.push(id);
      return Response.json({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
    })
  );
}
const signed = (body: string) => {
  const at = Math.floor(Date.now() / 1000);
  return `t=${at},v1=${crypto.createHmac("sha256", SECRET).update(`${at}.${body}`).digest("hex")}`;
};
async function webhook(event: object) {
  const body = JSON.stringify(event);
  const res = await callback(
    new NextRequest("http://localhost/api/payments/stripe/callback", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signed(body) },
      body,
    }),
    { params: Promise.resolve({ provider: "stripe" }) }
  );
  expect(res.status).toBe(200);
}
const completed = (id: string, subscription?: string) => ({
  id: `evt_${id}`,
  type: "checkout.session.completed",
  created: Math.floor(Date.now() / 1000),
  data: { object: { id, object: "checkout.session", payment_status: "paid", status: "complete", ...(subscription ? { subscription } : {}) } },
});
const invoicePaid = (invoice: string, subscription: string, amount: number) => ({
  id: `evt_${invoice}`,
  type: "invoice.paid",
  created: Math.floor(Date.now() / 1000),
  data: { object: { id: invoice, object: "invoice", billing_reason: "subscription_cycle", amount_paid: amount, parent: { subscription_details: { subscription } } } },
});

type Adult = { id: number; name: string; email: string; phone: string; cookie: string };
async function adult(name: string): Promise<Adult> {
  const k = ++n;
  const phone = `9${String(5000000 + k).padStart(7, "0")}`;
  const made = await registerUser({ name: `${name} ${k}`, email: `cov${k}@example.sg`, phone, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return { ...made.user, phone, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}
async function kids(parent: Adult, ...names: string[]) {
  const out: { id: number; name: string }[] = [];
  for (const displayName of names) {
    const made = await addManaged(parent.id, { displayName, relationship: "parent", authority: true }, parent.name);
    if (!made.ok) throw new Error(made.error);
    out.push({ id: made.person.id, name: made.person.displayName });
  }
  return out;
}
/** A family membership bought online and paid: its id. */
async function family(parent: Adult, planId: number, covers: number[], subscription?: string) {
  fakeStripe();
  const res = await myMembership.POST(
    new NextRequest("http://localhost/api/my/membership", {
      method: "POST",
      headers: { cookie: parent.cookie, "content-type": "application/json", "x-forwarded-for": `10.9.${++n % 250}.1` },
      body: JSON.stringify({ planId, covers, ...(subscription ? { autoRenew: true } : {}) }),
    })
  );
  vi.unstubAllGlobals();
  const data = (await res.json()) as { url?: string; code?: string };
  if (!data.url) throw new Error(`could not buy: ${data.code}`);
  await webhook(completed(data.url.split("/").pop()!, subscription));
  const mine = await listMembershipsFor(parent.id);
  return mine[0].id;
}
const covered = async (membershipId: number) =>
  ((await getDb().prepare("SELECT participant_id FROM membership_participants WHERE membership_id = ? ORDER BY participant_id").all(membershipId)) as { participant_id: number }[]).map(
    (r) => r.participant_id
  );
const ids = (...people: { id: number }[]) => people.map((p) => p.id);
const patch = (who: Adult, body: Record<string, unknown>) =>
  myMembership.PATCH(
    new NextRequest("http://localhost/api/my/membership", { method: "PATCH", headers: { cookie: who.cookie, "content-type": "application/json" }, body: JSON.stringify(body) })
  );
const correct = (cookie: string, membershipId: number, body: Record<string, unknown>) =>
  coversRoute.POST(
    new NextRequest(`http://localhost/api/admin/memberships/${membershipId}/covers`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: String(membershipId) }) }
  );

beforeAll(async () => {
  const v = await createVenue({ name: "Katong Family Club", area: "Katong", address: "x", phone: "61234511", openMin: 7 * 60, closeMin: 22 * 60 });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  const saved = await savePaymentSettings(venueId, { credentials: { secretKey: "rk_test_coverskey1234567", webhookSecret: SECRET }, sandbox: true, enabled: true });
  if (!saved.ok) throw new Error(saved.error);
  const r = await createResources({ venueId, sport: "swimming", name: "Family pool", offPeakRate: 10, peakRate: 10, capacity: 8, maxPlayers: 8 });
  if (!r.ok) throw new Error(r.error);
  pool = r.courts[0].id;
  const plan = async (input: Record<string, unknown>) => {
    const made = await createPlan(venueId, input as Parameters<typeof createPlan>[1]);
    if (!made.ok) throw new Error(made.error);
    return made.plan.id;
  };
  plans = {
    // The default: no replacements during a term.
    four: await plan({ name: "Family of four", months: 12, price: 400, offeredFor: "family", familyLimit: 4, ratePercent: 50, scope: "participant" }),
    duo: await plan({ name: "Duo", months: 12, price: 250, offeredFor: "family", familyLimit: 2, coverSwaps: 1 }),
    single: await plan({ name: "Single", months: 1, price: 40 }),
    kid: await plan({ name: "Junior", months: 6, price: 60, offeredFor: "participant" }),
  };
  const admin = await createAdmin({ name: "Manager", email: "cov-manager@example.sg", password: "a long enough password", venueId, role: "manager" });
  const front = await createAdmin({ name: "Desk", email: "cov-desk@example.sg", password: "a long enough password", venueId, role: "desk" });
  if (!admin.ok || !front.ok) throw new Error("admin");
  manager = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(admin.admin.id)).token}`;
  desk = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(front.admin.id)).token}`;
});

afterEach(() => vi.unstubAllGlobals());
afterAll(() => {
  delete process.env.MYSENAM_COUNTRY;
});

describe("the plan's policy", () => {
  it("is a family plan's setting, none by default, 0–12; a plan for one person has none", async () => {
    expect((await planById(plans.four))!.coverSwaps).toBe(0);
    expect((await planById(plans.duo))!.coverSwaps).toBe(1);
    expect(await createPlan(venueId, { name: "Too many", months: 1, price: 10, offeredFor: "family", familyLimit: 2, coverSwaps: 13 })).toMatchObject({
      ok: false,
      error: "A family plan lets 0–12 people be put on in place of others in one term.",
    });
    const single = await createPlan(venueId, { name: "Solo", months: 1, price: 10, coverSwaps: 3 });
    expect(single.ok && single.plan.coverSwaps).toBe(0);
    // Left out, it stays as it is; a manager changes it through the plans route.
    const kept = await setPlanBenefits(venueId, plans.duo, { ratePercent: null, aheadDays: null });
    expect(kept.ok && kept.plan.coverSwaps).toBe(1);
    const res = await plansRoute.PATCH(
      new NextRequest("http://localhost/api/admin/membership-plans", {
        method: "PATCH",
        headers: { cookie: manager, "content-type": "application/json" },
        body: JSON.stringify({ venueId, id: plans.duo, ratePercent: null, aheadDays: null, coverSwaps: 2 }),
      })
    );
    expect(((await res.json()) as { plan: { coverSwaps: number } }).plan.coverSwaps).toBe(2);
    await setPlanBenefits(venueId, plans.duo, { ratePercent: null, aheadDays: null, coverSwaps: 1 });
    // Sold for one person after all: no replacements.
    const solo = await setPlanBenefits(venueId, single.ok ? single.plan.id : 0, { ratePercent: null, aheadDays: null, offeredFor: "family", familyLimit: 2, coverSwaps: 2 });
    expect(solo.ok && solo.plan.coverSwaps).toBe(2);
    const back = await setPlanBenefits(venueId, single.ok ? single.plan.id : 0, { ratePercent: null, aheadDays: null, offeredFor: "account" });
    expect(back.ok && back.plan.coverSwaps).toBe(0);
  });
});

describe("changing whom it covers within a term", () => {
  it("adds within the limit at no charge, removes with nothing back, and says how many places are left", async () => {
    const parent = await adult("Adder");
    const [a, b, c] = await kids(parent, "Aiman", "Batrisya", "Chong");
    const m = await family(parent, plans.four, ids(a, b));
    expect(await coverStanding(m)).toMatchObject({ limit: 4, swaps: 0, used: 2, left: 2, renews: false, nextCovers: null });
    const added = await patch(parent, { membershipId: m, covers: ids(a, b, c) });
    expect(added.status).toBe(200);
    expect(((await added.json()) as { standing: { left: number } }).standing.left).toBe(1);
    expect((await participantMembership(venueId, c.id))?.id).toBe(m);
    // Taken off: no longer a member through it, nothing back, and the place stays used.
    expect((await patch(parent, { membershipId: m, covers: ids(b, c) })).status).toBe(200);
    expect(await participantMembership(venueId, a.id)).toBeNull();
    expect(await coverStanding(m)).toMatchObject({ used: 3, left: 1 });
    expect((await listMembershipsFor(parent.id))[0].price).toBe(400);
    const receipts = (await documentsForUser(parent.id)).filter((d) => d.lines.some((l) => l.description.includes("Membership")));
    expect(receipts).toHaveLength(1);
    expect(receipts[0].kind).toBe("receipt");
  });

  it("a family of four cannot be rotated through more people: with no replacements, nobody new once its places are used, nor the person taken off put back", async () => {
    const parent = await adult("Rotator");
    const [a, b, c, d, e, f] = await kids(parent, "Dina", "Ezra", "Fahmi", "Gina", "Haris", "Ilya");
    const m = await family(parent, plans.four, ids(a, b, c, d));
    expect((await patch(parent, { membershipId: m, covers: ids(b, c, d) })).status).toBe(200);
    for (const who of [e, f, a]) {
      const res = await patch(parent, { membershipId: m, covers: [...ids(b, c, d), who.id] });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "MBO_NO_PLACES_LEFT", vars: { n: 4 } });
    }
    // Refused whole: a swap in one go is refused too, and nothing changed.
    expect(await changeCovers(parent.id, m, ids(b, c, e))).toMatchObject({ ok: false, code: "MBO_NO_PLACES_LEFT" });
    expect(await covered(m)).toEqual(ids(b, c, d).sort((x, y) => x - y));
    const history = await coverHistory(m);
    expect(history.changes.map((x) => x.change)).toEqual(["named", "named", "named", "named", "removed"]);
    expect(history.places).toMatchObject({ limit: 4, swaps: 0, used: 4, left: 0 });
  });

  it("a plan allowing one replacement per term allows exactly one: never more people than the limit plus its replacements in a term", async () => {
    const parent = await adult("Swapper");
    const [a, b, c, d] = await kids(parent, "Jamal", "Kirana", "Lukman", "Mei");
    const m = await family(parent, plans.duo, ids(a, b));
    expect(await changeCovers(parent.id, m, ids(b, c))).toMatchObject({ ok: true, standing: { used: 3, left: 0 } });
    expect(await changeCovers(parent.id, m, ids(b, d))).toMatchObject({ ok: false, code: "MBO_NO_PLACES_LEFT" });
    expect(await changeCovers(parent.id, m, ids(a, c))).toMatchObject({ ok: false, code: "MBO_NO_PLACES_LEFT" });
    const everyone = new Set((await coverHistory(m)).changes.filter((x) => x.change !== "removed").map((x) => x.name));
    expect(everyone.size).toBeLessThanOrEqual(3);
  });

  it("taking the same person off and putting them back uses a place each time: it cannot go past the allowance", async () => {
    const parent = await adult("Yoyo");
    const [a] = await kids(parent, "Nadia");
    const m = await family(parent, plans.four, ids(a));
    let refusedAt = 0;
    for (let i = 1; i <= 6; i++) {
      expect((await changeCovers(parent.id, m, [])).ok).toBe(true);
      const back = await changeCovers(parent.id, m, ids(a));
      if (!back.ok) {
        refusedAt = i;
        expect(back.code).toBe("MBO_NO_PLACES_LEFT");
        break;
      }
    }
    // Named once, then put back three times: four places, no more.
    expect(refusedAt).toBe(4);
    expect(await coverStanding(m)).toMatchObject({ used: 4, left: 0 });
  });

  it("swapping cannot reset or multiply what a person used: a booking keeps its member price and its person; the term's count stays", async () => {
    const parent = await adult("Booker");
    const [a, b] = await kids(parent, "Omar", "Puan");
    const m = await family(parent, plans.four, ids(a));
    const day = addDays(todayISO(), 3);
    const book = async (participantIds: number[], start: number) => {
      const res = await bookingsRoute.POST(
        new NextRequest("http://localhost/api/bookings", {
          method: "POST",
          headers: { cookie: parent.cookie, "content-type": "application/json", "x-forwarded-for": `10.8.${++n % 250}.2` },
          body: JSON.stringify({ name: parent.name, phone: parent.phone, courtId: pool, date: day, start, end: start + 60, participantIds }),
        })
      );
      return (await res.json()) as { booking: { id: number; totalPrice: number } };
    };
    // Omar's own place at the plan's 50%.
    const made = await book(ids(a), 9 * 60);
    expect(made.booking.totalPrice).toBe(5);
    const used = (await coverStanding(m))!.used;
    // Taken off, then Puan put on: the booking stays Omar's, at the price it was given.
    expect((await changeCovers(parent.id, m, [])).ok).toBe(true);
    expect((await changeCovers(parent.id, m, ids(b))).ok).toBe(true);
    const kept = (await getDb()
      .prepare("SELECT b.total_price::float AS price, (SELECT array_agg(participant_id) FROM booking_participants WHERE booking_id = b.id) AS who FROM bookings b WHERE b.id = ?")
      .get(made.booking.id)) as { price: number; who: number[] };
    expect(kept).toMatchObject({ price: 5, who: [a.id] });
    // Omar now books at the public price; the term's count only went up.
    expect((await book(ids(a), 11 * 60)).booking.totalPrice).toBe(10);
    expect((await coverStanding(m))!.used).toBe(used + 1);
  });

  it("nobody covered twice: somebody another membership covers for those days is refused", async () => {
    const parent = await adult("Twice");
    const [a, b] = await kids(parent, "Qadir", "Rania");
    const m = await family(parent, plans.duo, ids(a));
    // Rania has her own junior membership: she cannot be put on the family one for the same days.
    fakeStripe();
    const own = await myMembership.POST(
      new NextRequest("http://localhost/api/my/membership", {
        method: "POST",
        headers: { cookie: parent.cookie, "content-type": "application/json", "x-forwarded-for": "10.6.1.1" },
        body: JSON.stringify({ planId: plans.kid, participantId: b.id }),
      })
    );
    vi.unstubAllGlobals();
    await webhook(completed(((await own.json()) as { url: string }).url.split("/").pop()!));
    expect(await changeCovers(parent.id, m, ids(a, b))).toMatchObject({ ok: false, code: "MBO_ALREADY_COVERED", vars: { name: "Rania" } });
    expect(await covered(m)).toEqual([a.id]);
    // Nor by a manager's correction.
    expect(await correctCover({ id: null, name: "Manager" }, m, { remove: a.id, add: b.id, reason: "x x x" })).toMatchObject({ ok: false, code: "MBO_ALREADY_COVERED" });
  });
});

describe("the next term", () => {
  it("a family membership that renews by itself names a different list from its next term, within the limit; this term is unchanged", async () => {
    const parent = await adult("Planner");
    const [a, b, c] = await kids(parent, "Taufik", "Umi", "Vera");
    const m = await family(parent, plans.duo, ids(a, b), "sub_cov_next");
    expect(await coverStanding(m)).toMatchObject({ renews: true, left: 1 });
    // Over the limit, or somebody not looked after: refused.
    expect(await setNextCovers(parent.id, m, ids(a, b, c))).toMatchObject({ ok: false, code: "MBO_FAMILY_LIMIT" });
    const stranger = await adult("Stranger");
    const [s] = await kids(stranger, "Wira");
    expect(await setNextCovers(parent.id, m, ids(a, s))).toMatchObject({ ok: false, code: "MBO_NOT_GUARDIAN" });
    const res = await patch(parent, { membershipId: m, covers: ids(b, c), at: "renewal" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { standing: { nextCovers: { name: string }[] } }).standing.nextCovers.map((x) => x.name)).toEqual(["Umi", "Vera"]);
    expect(await covered(m)).toEqual(ids(a, b));
    // The next charge makes the next term naming them, with its own places.
    await webhook(invoicePaid("in_cov_next", "sub_cov_next", 25000));
    const next = (await listMembershipsFor(parent.id)).find((x) => x.id !== m)!;
    expect(next.covers!.map((x) => x.id)).toEqual(ids(b, c));
    expect(await coverStanding(next.id)).toMatchObject({ limit: 2, swaps: 1, used: 2, left: 1 });
    expect(next.startsOn).toBe(addDays((await listMembershipsFor(parent.id)).find((x) => x.id === m)!.expiresOn, 1));
  });

  it("one that does not renew by itself is renewed by buying it again, naming a different list within the limit", async () => {
    const parent = await adult("Renewer");
    const [a, b, c] = await kids(parent, "Xavier", "Yasmin", "Zaki");
    const m = await family(parent, plans.duo, ids(a, b));
    expect(await setNextCovers(parent.id, m, ids(b, c))).toMatchObject({ ok: false, code: "MBO_NOT_RENEWING" });
    await getDb().prepare("UPDATE memberships SET expires_on = ? WHERE id = ?").run(addDays(todayISO(), 20), m);
    fakeStripe();
    const over = await myMembership.POST(
      new NextRequest("http://localhost/api/my/membership", {
        method: "POST",
        headers: { cookie: parent.cookie, "content-type": "application/json", "x-forwarded-for": "10.7.1.1" },
        body: JSON.stringify({ planId: plans.duo, covers: ids(a, b, c) }),
      })
    );
    expect(((await over.json()) as { code: string }).code).toBe("MBO_FAMILY_LIMIT");
    vi.unstubAllGlobals();
    await family(parent, plans.duo, ids(b, c));
    const next = (await listMembershipsFor(parent.id)).find((x) => x.id !== m)!;
    expect(next).toMatchObject({ startsOn: addDays(todayISO(), 21), expiresOn: addDays(addMonths(addDays(todayISO(), 21), 12), -1) });
    expect(next.covers!.map((x) => x.id)).toEqual(ids(b, c));
    expect(await covered(m)).toEqual(ids(a, b));
  });
});

describe("a manager's correction", () => {
  it("replaces a person entered wrongly, with a reason, using no place: managers only, in the activity log and each person's history", async () => {
    const parent = await adult("Mistake");
    const [a, b, c, d, e] = await kids(parent, "Adam", "Bella", "Cyrus", "Delia", "Elif");
    const m = await family(parent, plans.four, ids(a, b, c, d));
    // The desk cannot; a reason is needed.
    expect((await correct(desk, m, { remove: a.id, add: e.id, reason: "wrong child" })).status).toBe(403);
    const noReason = await correct(manager, m, { remove: a.id, add: e.id });
    expect(noReason.status).toBe(400);
    expect(await noReason.json()).toMatchObject({ code: "MBO_REASON" });
    const done = await correct(manager, m, { remove: a.id, add: e.id, reason: "Adam entered instead of Elif at sign-up" });
    expect(done.status).toBe(200);
    expect(await covered(m)).toEqual(ids(b, c, d, e));
    expect(await coverStanding(m)).toMatchObject({ used: 4, left: 0 });
    const log = (await getDb().prepare("SELECT admin_name, detail FROM staff_actions WHERE action = 'membership.cover_corrected' ORDER BY id DESC LIMIT 1").get()) as { admin_name: string; detail: string };
    expect(log.admin_name).toBe("Manager");
    expect(log.detail).toContain("Adam entered instead of Elif at sign-up");
    expect((await participantHistory(a.id)).some((x) => x.action === "membership.uncovered" && x.detail?.includes("corrected"))).toBe(true);
    expect((await participantHistory(e.id)).some((x) => x.action === "membership.covered" && x.actorName === "Manager")).toBe(true);
    const history = await coverHistory(m);
    expect(history.changes.slice(-2)).toMatchObject([
      { change: "corrected_out", name: "Adam", byStaff: true, by: "Manager", reason: "Adam entered instead of Elif at sign-up" },
      { change: "corrected_in", name: "Elif", byStaff: true },
    ]);
    // Staff read the history through the route; desk too.
    const read = await coversRoute.GET(new NextRequest(`http://localhost/api/admin/memberships/${m}/covers`, { headers: { cookie: desk } }), {
      params: Promise.resolve({ id: String(m) }),
    });
    expect(((await read.json()) as { changes: unknown[] }).changes).toHaveLength(6);
  });

  it("refuses what would break the rules: somebody not on it, somebody already on it or covered elsewhere, somebody not the family's", async () => {
    const parent = await adult("Careful");
    const [a, b, c] = await kids(parent, "Faiz", "Gwen", "Hakim");
    const m = await family(parent, plans.duo, ids(a, b));
    const admin = { id: null, name: "Manager" };
    expect(await correctCover(admin, m, { remove: c.id, add: a.id, reason: "x x x" })).toMatchObject({ ok: false, code: "MBO_NOT_COVERED" });
    expect(await correctCover(admin, m, { remove: a.id, add: b.id, reason: "x x x" })).toMatchObject({ ok: false, code: "MBO_ALREADY_ON" });
    const stranger = await adult("Not family");
    const [s] = await kids(stranger, "Indra");
    expect(await correctCover(admin, m, { remove: a.id, add: s.id, reason: "x x x" })).toMatchObject({ ok: false, code: "MBO_NOT_GUARDIAN" });
    const other = await family(stranger, plans.duo, ids(s));
    expect(other).toBeGreaterThan(0);
    // Taken off as wrongly entered, with nobody in their place: the place is given back.
    expect(await correctCover(admin, m, { remove: a.id, reason: "not a member of the family" })).toMatchObject({ ok: true, added: null });
    expect(await coverStanding(m)).toMatchObject({ used: 1, left: 2 });
    expect((await changeCovers(parent.id, m, ids(b, c))).ok).toBe(true);
  });

  it("corrects a family membership sold at the counter, whose people have a guardian on the holder's number", async () => {
    const parent = await adult("Counter");
    const known = async (displayName: string) => {
      const made = await createAtVenue({ venueId, admin: { id: null, name: "Desk" }, displayName, guardian: { name: parent.name, phone: parent.phone, relationship: "parent", authority: true } });
      if (!made.ok) throw new Error(made.error);
      return { id: made.participant.id };
    };
    const [a, b] = [await known("Jasmin"), await known("Kahar")];
    const sold = await adminMemberships.POST(
      new NextRequest("http://localhost/api/admin/memberships", {
        method: "POST",
        headers: { cookie: manager, "content-type": "application/json" },
        // No plan: a manager's price, with the reason, and how it was paid (X1-19, X1-2).
        body: JSON.stringify({ venueId, holderName: parent.name, holderPhone: parent.phone, startsOn: todayISO(), expiresOn: addDays(todayISO(), 90), price: 100, covers: [a.id], via: "cash", priceReason: "Family rate agreed at the desk" }),
      })
    );
    expect(sold.status).toBe(201);
    const m = ((await sold.json()) as { membership: { id: number } }).membership.id;
    expect((await coverHistory(m)).changes).toMatchObject([{ change: "named", name: "Jasmin", byStaff: true }]);
    expect((await correct(manager, m, { remove: a.id, add: b.id, reason: "the other child" })).status).toBe(200);
    expect(await covered(m)).toEqual([b.id]);
  });
});

describe("at the same moment", () => {
  it("several changes at once, each adding somebody: the places hold, one after the other", async () => {
    const parent = await adult("Racer");
    const people = await kids(parent, "Laila", "Malik", "Nora", "Oscar", "Pia", "Qamar");
    const [first, ...rest] = people;
    const m = await family(parent, plans.duo, ids(first));
    const results = await Promise.all(rest.map((p) => changeCovers(parent.id, m, [first.id, p.id])));
    // Two places left (limit 2 plus one replacement, one used): every change replaces the one before it,
    // so the first fills the second place, the next swaps into the last, and every other is refused.
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.code === "MBO_NO_PLACES_LEFT")).toBe(true);
    expect((await covered(m)).length).toBe(2);
    expect(await coverStanding(m)).toMatchObject({ used: 3, left: 0 });
  });

  it("a manager's correction and the buyer's change at once: never past the limit", async () => {
    const parent = await adult("Both");
    const [a, b, c] = await kids(parent, "Rizal", "Sara", "Tan");
    const m = await family(parent, plans.duo, ids(a, b));
    await Promise.all([
      correctCover({ id: null, name: "Manager" }, m, { remove: a.id, add: c.id, reason: "wrong child" }),
      changeCovers(parent.id, m, ids(a, b, c)),
      changeCovers(parent.id, m, ids(b, c)),
    ]);
    expect((await covered(m)).length).toBeLessThanOrEqual(2);
    const standing = (await coverStanding(m))!;
    expect(standing.used).toBeLessThanOrEqual(standing.limit + standing.swaps);
  });
});
