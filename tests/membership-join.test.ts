import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { getDb } from "../src/lib/db";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { accessRefusal, setAccessSettings } from "../src/lib/access";
import { addMonths, createPlan, joinTerms, listPlans, retirePlan } from "../src/lib/membership-plans";
import { paymentByBill, savePaymentSettings, settleBill, startMembershipPayment } from "../src/lib/payments";
import { createVenue, listMembershipsFor, listMembershipsForVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { POST as join } from "../src/app/api/my/membership/route";
import { GET as plansGet, POST as plansPost } from "../src/app/api/admin/membership-plans/route";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";

/**
 * A club selling membership online: plans on its page, paid to the club,
 * the membership made when the money is in; renewals run on from the old one.
 */

let venueId: number;
let planId: number;
let user: { id: number; name: string; email: string; phone: string };
let cookie: string;
let n = 0;

function fakeBillplz() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const id = `memberbill${++n}`;
      return Response.json({ id, url: `https://www.billplz-sandbox.com/bills/${id}` });
    })
  );
}

const lastBill = async () =>
  ((await getDb().prepare("SELECT bill_id FROM online_payments ORDER BY id DESC LIMIT 1").get()) as { bill_id: string }).bill_id;

async function payFor(userId: number, plan: number) {
  fakeBillplz();
  const started = await startMembershipPayment({ id: userId, name: "x", email: "x@example.my" }, plan);
  if (!started.ok) throw new Error(started.error);
  const billId = await lastBill();
  await settleBill({ billId, paid: true, paidAt: null });
  return billId;
}

async function newUser(email: string, phone: string) {
  const made = await registerUser({ name: "Member " + email, email, phone, password: "rahsia-123" });
  if (!made.ok) throw new Error(made.error);
  return made.user;
}

beforeAll(async () => {
  const made = await createVenue({ name: "Bukit Club", area: "KL", address: "x", phone: "0300000000" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  await setAccessSettings(venueId, { access: "members", listed: true });
  const saved = await savePaymentSettings(venueId, {
    apiKey: "api-key-1234",
    collectionId: "col123",
    xSignatureKey: "S-key",
    sandbox: true,
    enabled: true,
  });
  if (!saved.ok) throw new Error(saved.error);
  user = await newUser("join@example.my", "0193334444");
  cookie = `${SESSION_COOKIE}=${(await createSession(user.id)).token}`;
});

afterEach(() => vi.unstubAllGlobals());

describe("calendar months", () => {
  it("holds to the end of a shorter month", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2026-11-15", 3)).toBe("2027-02-15");
    expect(addMonths("2026-03-01", 12)).toBe("2027-03-01");
  });
});

describe("membership plans", () => {
  it("are checked, and capped per venue", async () => {
    expect(await createPlan(venueId, { name: "A", months: 12, price: 300 })).toMatchObject({ ok: false });
    expect(await createPlan(venueId, { name: "Annual", months: 13, price: 300 })).toMatchObject({ ok: false });
    expect(await createPlan(venueId, { name: "Annual", months: 12, price: 0 })).toMatchObject({ ok: false });
    const made = await createPlan(venueId, { name: "Annual", months: 12, price: 300 });
    if (!made.ok) throw new Error(made.error);
    planId = made.plan.id;
    expect(made.plan).toMatchObject({ name: "Annual", months: 12, price: 300 });
  });

  it("are a manager's to change, and anyone at the venue's to read", async () => {
    const desk = await createAdmin({ email: "desk@bukit.my", name: "Desk", password: "desk-pass-123", venueId, role: "desk" });
    if (!desk.ok) throw new Error(desk.error);
    const asDesk = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
    const read = await plansGet(new NextRequest(`http://localhost/api/admin/membership-plans?venueId=${venueId}`, { headers: { cookie: asDesk } }));
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ online: true, plans: [{ id: planId }] });
    const write = await plansPost(
      new NextRequest("http://localhost/api/admin/membership-plans", {
        method: "POST",
        headers: { cookie: asDesk, "content-type": "application/json" },
        body: JSON.stringify({ venueId, name: "Monthly", months: 1, price: 40 }),
      })
    );
    expect(write.status).toBe(403);
  });
});

describe("joining online", () => {
  it("makes the membership once it is paid, and lets them book", async () => {
    expect(await accessRefusal(venueId, user.id)).toMatchObject({ code: "MEMBERS_ONLY" });
    fakeBillplz();
    const res = await join(
      new NextRequest("http://localhost/api/my/membership", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ planId }),
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ amount: 300 });
    expect(await listMembershipsFor(user.id)).toEqual([]);

    const billId = await lastBill();
    await settleBill({ billId, paid: true, paidAt: null });
    await settleBill({ billId, paid: true, paidAt: null });
    const mine = await listMembershipsFor(user.id);
    expect(mine).toHaveLength(1);
    const today = todayISO();
    expect(mine[0]).toMatchObject({
      venueId,
      holderPhone: "0193334444",
      startsOn: today,
      expiresOn: addDays(addMonths(today, 12), -1),
      price: 300,
      online: true,
    });
    expect(await accessRefusal(venueId, user.id)).toBeNull();
    const payment = await paymentByBill(billId);
    expect(payment?.membership).toMatchObject({ code: mine[0].code, venueName: "Bukit Club", startsOn: today });
    expect((await listMembershipsForVenue(venueId))[0].online).toBe(true);
  });

  it("opens renewal only near the end, and runs it on from the old one", async () => {
    expect(await joinTerms(user.id, planId)).toMatchObject({ ok: false, code: "JOIN_TOO_EARLY" });
    fakeBillplz();
    expect(await startMembershipPayment(user, planId)).toMatchObject({ ok: false, status: 409, code: "JOIN_TOO_EARLY" });

    const ends = addDays(todayISO(), 20);
    await getDb().prepare("UPDATE memberships SET expires_on = ? WHERE user_id = ?").run(ends, user.id);
    const terms = await joinTerms(user.id, planId);
    expect(terms).toMatchObject({ ok: true, terms: { renewing: true, startsOn: addDays(ends, 1) } });
    await payFor(user.id, planId);
    const mine = await listMembershipsFor(user.id);
    expect(mine).toHaveLength(2);
    expect(mine.map((m) => m.startsOn).sort()).toEqual([todayISO(), addDays(ends, 1)]);
  });

  it("owes back a second payment for the same months", async () => {
    const other = await newUser("twice@example.my", "0195556666");
    fakeBillplz();
    expect((await startMembershipPayment(other, planId)).ok).toBe(true);
    const first = await lastBill();
    // While the first page is open the same purchase goes back to it (lib/membership-purchases.ts)…
    expect(await startMembershipPayment(other, planId)).toMatchObject({ ok: true, reused: true });
    expect(await lastBill()).toBe(first);
    // …and once its hold lapses a second page can be opened, and paid as well.
    await getDb().prepare("UPDATE membership_purchases SET hold_until = now() - interval '1 minute' WHERE user_id = ?").run(other.id);
    expect((await startMembershipPayment(other, planId)).ok).toBe(true);
    const second = await lastBill();
    expect(second).not.toBe(first);
    await settleBill({ billId: first, paid: true, paidAt: null });
    await settleBill({ billId: second, paid: true, paidAt: null });
    expect(await listMembershipsFor(other.id)).toHaveLength(1);
    expect(await paymentByBill(second)).toMatchObject({ status: "paid", refundOwed: 300 });
    expect((await paymentByBill(second))?.membership).toBeUndefined();
  });

  it("still gives a plan retired while they were paying", async () => {
    const monthly = await createPlan(venueId, { name: "Monthly", months: 1, price: 40 });
    if (!monthly.ok) throw new Error(monthly.error);
    const late = await newUser("late@example.my", "0197778888");
    fakeBillplz();
    expect((await startMembershipPayment(late, monthly.plan.id)).ok).toBe(true);
    expect(await retirePlan(venueId, monthly.plan.id)).toBe(true);
    expect((await listPlans(venueId)).map((p) => p.name)).toEqual(["Annual"]);
    await settleBill({ billId: await lastBill(), paid: true, paidAt: null });
    expect(await listMembershipsFor(late.id)).toMatchObject([{ price: 40 }]);
    // But nobody new can start on it.
    expect(await startMembershipPayment(user, monthly.plan.id)).toMatchObject({ ok: false, code: "JOIN_NO_PLAN" });
  });

  it("needs a phone to hold it against, and a venue that is not private", async () => {
    const nophone = await newUser("nophone@example.my", "0190000001");
    await getDb().prepare("UPDATE users SET phone = '' WHERE id = ?").run(nophone.id);
    expect(await startMembershipPayment(nophone, planId)).toMatchObject({ ok: false, code: "JOIN_NO_PHONE" });

    await setAccessSettings(venueId, { access: "private" });
    const someone = await newUser("private@example.my", "0190000002");
    expect(await startMembershipPayment(someone, planId)).toMatchObject({ ok: false, code: "JOIN_NO_PLAN" });
    await setAccessSettings(venueId, { access: "members", listed: true });
  });

  it("needs an account", async () => {
    const res = await join(
      new NextRequest("http://localhost/api/my/membership", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planId }),
      })
    );
    expect(res.status).toBe(401);
  });
});
