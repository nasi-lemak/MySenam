import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import { renderToStaticMarkup } from "react-dom/server";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";
process.env.MYSENAM_PAYMENT_PROVIDERS = "billplz,stripe";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { xSignature } from "../src/lib/billplz";
import { getDb } from "../src/lib/db";
import { addManaged } from "../src/lib/managed-people";
import { cashUp } from "../src/lib/cash-up";
import { journalCsv, salesJournal } from "../src/lib/accounting";
import { consolidate } from "../src/lib/myinvois";
import { createPassProduct, listOnlinePassProducts, retirePassProduct } from "../src/lib/pass-products";
import { markRefunded, paymentByBill, recordDispute, refundOnline, refundsOwed, savePaymentSettings, settleBill, startPassPayment } from "../src/lib/payments";
import { createVenue, issuePass, listPassesFor } from "../src/lib/store";
import { setVenueTax } from "../src/lib/tax";
import { addDays, todayISO } from "../src/lib/time";
import { listActivity } from "../src/lib/activity";
import * as myPasses from "../src/app/api/my/passes/route";
import * as products from "../src/app/api/admin/pass-products/route";
import { POST as voidPassRoute } from "../src/app/api/admin/passes/[id]/void/route";
import { POST as callback } from "../src/app/api/payments/[provider]/callback/route";
import PaymentReturnPage from "../src/app/payments/return/page";

/**
 * Multi-visit passes sold online (owner's approval of 2 November 2026;
 * lib/pass-purchases.ts, lib/payments.ts startPassPayment; migration 0264;
 * docs/features/pricing.md#buying-a-pass-online): a product a manager marks
 * sold online is bought by a signed-in customer and paid to the venue through
 * its own gateway; the pass is issued only once paid, exactly once, and is
 * receipted, taxed, journalled, cashed up and consolidated as a counter pass
 * sale is, by online. Through stand-ins for Stripe's and Billplz's APIs and
 * signed callbacks: no live calls.
 */

const STRIPE_SECRET = "whsec_passsecret1234567890";
const BILLPLZ_SIGNATURE = "S-pass-signature-key";
let stripeVenue: number;
let billplzVenue: number;
let draftVenue: number;
let privateVenue: number;
let manager: string;
let desk: string;
let billplzManager: string;
let n = 0;
let sent: { url: string; method: string; form: URLSearchParams | null }[] = [];
const P: Record<string, number> = {};

function fakeGateways() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string; body?: string } = {}) => {
      const form = init.body ? new URLSearchParams(init.body) : null;
      sent.push({ url, method: init.method ?? "GET", form });
      if (url.includes("billplz")) {
        const id = `passbill${++n}`;
        return Response.json({ id, url: `https://www.billplz-sandbox.com/bills/${id}` });
      }
      if (url.includes("/refunds?payment_intent=")) return Response.json({ object: "list", data: [] });
      if (url.endsWith("/refunds"))
        return Response.json({ id: `re_pass${++n}`, status: "succeeded", payment_intent: form?.get("payment_intent") ?? "", metadata: {} });
      if (init.method === "POST") {
        const id = `cs_test_pass${++n}`;
        return Response.json({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
      }
      const id = decodeURIComponent(url.split("/").pop()!);
      return Response.json({ id, payment_status: "paid", status: "complete", payment_intent: `pi_for_${id}` });
    })
  );
}

const stripeSigned = (body: string) => {
  const at = Math.floor(Date.now() / 1000);
  return `t=${at},v1=${crypto.createHmac("sha256", STRIPE_SECRET).update(`${at}.${body}`).digest("hex")}`;
};
async function stripeEvent(id: string, type: string, object: Record<string, unknown>) {
  const body = JSON.stringify({ id: `evt_${id}_${type}_${++n}`, type, created: Math.floor(Date.now() / 1000), data: { object: { id, object: "checkout.session", ...object } } });
  const res = await callback(
    new NextRequest("http://localhost/api/payments/stripe/callback", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": stripeSigned(body) }, body }),
    { params: Promise.resolve({ provider: "stripe" }) }
  );
  expect(res.status).toBe(200);
}
const stripePaid = (bill: string) => stripeEvent(bill, "checkout.session.completed", { payment_status: "paid", status: "complete" });
async function billplzSays(billId: string, paid: boolean) {
  // As Billplz documents the callback: the bill's collection, what it was for and what was paid (ADR 0065).
  const sen = String(Math.round(((await getDb().prepare("SELECT amount::float AS amount FROM online_payments WHERE bill_id = ?").get(billId)) as { amount: number }).amount * 100));
  const fields: Record<string, string> = { id: billId, collection_id: "colpass", paid: String(paid), amount: sen, paid_amount: paid ? sen : "0", paid_at: new Date().toISOString(), state: paid ? "paid" : "due" };
  fields.x_signature = xSignature(fields, BILLPLZ_SIGNATURE);
  const res = await callback(
    new NextRequest("http://localhost/api/payments/billplz/callback", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() }),
    { params: Promise.resolve({ provider: "billplz" }) }
  );
  expect(res.status).toBe(200);
}
const returnPage = async (bill: string) => renderToStaticMarkup(await PaymentReturnPage({ searchParams: Promise.resolve({ stripe_session: bill }) }));

type Adult = { id: number; name: string; email: string; phone: string; cookie: string };
async function adult(name: string): Promise<Adult> {
  const k = ++n;
  const phone = `01${String(60000000 + k).padStart(8, "0")}`;
  const made = await registerUser({ name: `${name} ${k}`, email: `pass${k}@example.my`, phone, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return { ...made.user, phone, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}
async function child(parent: Adult, displayName: string) {
  const made = await addManaged(parent.id, { displayName, relationship: "parent", authority: true }, parent.name);
  if (!made.ok) throw new Error(made.error);
  return { id: made.person.id, name: made.person.displayName };
}
let ip = 0;
/** The customer's own route: the payment page's address, or the refusal. */
async function buy(who: Adult, venueId: number, productId: number, participantId?: number) {
  fakeGateways();
  const res = await myPasses.POST(
    new NextRequest("http://localhost/api/my/passes", {
      method: "POST",
      headers: { cookie: who.cookie, "content-type": "application/json", "x-forwarded-for": `10.9.${Math.floor(++ip / 200)}.${ip % 200}` },
      body: JSON.stringify({ venueId, productId, ...(participantId ? { participantId } : {}) }),
    })
  );
  vi.unstubAllGlobals();
  return { status: res.status, body: (await res.json()) as { url?: string; reused?: boolean; code?: string; error?: string } };
}
async function bought(who: Adult, venueId: number, productId: number, participantId?: number): Promise<string> {
  const r = await buy(who, venueId, productId, participantId);
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  return r.body.url!.split("/").pop()!;
}
const paymentRow = async (bill: string) =>
  (await getDb()
    .prepare("SELECT id, status, amount::float AS amount, refund_due::float AS refund_due, refunded::float AS refunded, pass_id, page_closed_at FROM online_payments WHERE bill_id = ?")
    .get(bill)) as { id: number; status: string; amount: number; refund_due: number; refunded: number; pass_id: number | null; page_closed_at: string | null };
const passesOf = async (userId: number) =>
  (await getDb().prepare("SELECT id, code, price::float AS price, holder_phone, holder_participant_id, product_id, expires_on, status FROM passes WHERE user_id = ? ORDER BY id").all(userId)) as {
    id: number;
    code: string;
    price: number;
    holder_phone: string;
    holder_participant_id: number | null;
    product_id: number | null;
    expires_on: string;
    status: string;
  }[];
const receiptsOf = async (passId: number) =>
  (await getDb()
    .prepare(
      `SELECT kind, number, total::float AS total, tax_rate::float AS tax_rate, tax_amount::float AS tax_amount, paid_via FROM receipts
        WHERE source = ? OR credits_id IN (SELECT id FROM receipts WHERE source = ?) ORDER BY id`
    )
    .all(`pass:${passId}`, `pass:${passId}`)) as { kind: string; number: string; total: number; tax_rate: number | null; tax_amount: number; paid_via: string | null }[];
const voidPass = (cookie: string, passId: number, body: unknown) =>
  voidPassRoute(
    new NextRequest(`http://localhost/api/admin/passes/${passId}/void`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: String(passId) }) }
  );
const patchProduct = (cookie: string, body: unknown) =>
  products.PATCH(new NextRequest("http://localhost/api/admin/pass-products", { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }));

async function product(venueId: number, input: Record<string, unknown>) {
  const made = await createPassProduct(venueId, { entries: 10, validDays: 90, ...input }, null);
  if (!made.ok) throw new Error(made.error);
  return made.product.id;
}

beforeAll(async () => {
  const mk = async (name: string) => {
    const v = await createVenue({ name, area: "KL", address: "x", phone: `03${String(12340000 + ++n)}` });
    if (!v.ok) throw new Error("venue");
    return v.venue.id;
  };
  stripeVenue = await mk("Stripe Sports Centre");
  billplzVenue = await mk("Billplz Sports Centre");
  draftVenue = await mk("Draft Sports Centre");
  privateVenue = await mk("Private Club");
  for (const v of [stripeVenue, draftVenue, privateVenue]) {
    const saved = await savePaymentSettings(v, { provider: "stripe", credentials: { secretKey: "rk_test_passkey1234567", webhookSecret: STRIPE_SECRET }, sandbox: true, enabled: true });
    if (!saved.ok) throw new Error(saved.error);
  }
  const savedB = await savePaymentSettings(billplzVenue, { provider: "billplz", apiKey: "api-key-pass", collectionId: "colpass", xSignatureKey: BILLPLZ_SIGNATURE, sandbox: true, enabled: true });
  if (!savedB.ok) throw new Error(savedB.error);
  await getDb().prepare("UPDATE venues SET published_at = NULL WHERE id = ?").run(draftVenue);
  await getDb().prepare("UPDATE venues SET access = 'private' WHERE id = ?").run(privateVenue);
  await setVenueTax(stripeVenue, { registered: true, rate: 6, regNo: "W10-1234-56789012" });

  P.ten = await product(stripeVenue, { name: "Ten sessions", price: 120, soldOnline: true });
  P.kids = await product(stripeVenue, { name: "Kids swim five", entries: 5, price: 50, scope: "participant", soldOnline: true });
  P.counterOnly = await product(stripeVenue, { name: "Counter only", price: 80 });
  P.billplz = await product(billplzVenue, { name: "Billplz ten", price: 100, soldOnline: true });
  P.draft = await product(draftVenue, { name: "Draft ten", price: 100, soldOnline: true });
  P.private = await product(privateVenue, { name: "Club ten", price: 100, soldOnline: true });

  const staff = async (venueId: number, role: "manager" | "desk") => {
    const made = await createAdmin({ name: `${role} ${++n}`, email: `pass-${role}${n}@example.my`, password: "a long enough password", venueId, role });
    if (!made.ok) throw new Error(made.error);
    return `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}`;
  };
  manager = await staff(stripeVenue, "manager");
  desk = await staff(stripeVenue, "desk");
  billplzManager = await staff(billplzVenue, "manager");
});

afterEach(() => {
  vi.unstubAllGlobals();
  sent = [];
});

afterAll(() => {
  delete process.env.MYSENAM_PAYMENT_PROVIDERS;
});

describe("which passes are sold online", () => {
  it("is off unless a manager says, at least 1, and the front desk cannot change it; each change is logged", async () => {
    expect((await listOnlinePassProducts(stripeVenue)).map((p) => p.name)).toEqual(["Kids swim five", "Ten sessions"]);
    const free = await createPassProduct(stripeVenue, { name: "Free taster", entries: 1, validDays: 7, price: 0, soldOnline: true }, null);
    expect(free).toMatchObject({ ok: false });

    const asDesk = await patchProduct(desk, { venueId: stripeVenue, id: P.counterOnly, soldOnline: true });
    expect(asDesk.status).toBe(403);
    const on = await patchProduct(manager, { venueId: stripeVenue, id: P.counterOnly, soldOnline: true });
    expect(on.status).toBe(200);
    expect((await on.json()).product).toMatchObject({ soldOnline: true });
    const off = await patchProduct(manager, { venueId: stripeVenue, id: P.counterOnly, soldOnline: false });
    expect((await off.json()).product).toMatchObject({ soldOnline: false });
    // Another venue's product is not this manager's to change.
    expect((await patchProduct(manager, { venueId: billplzVenue, id: P.billplz, soldOnline: false })).status).toBe(403);
    expect((await patchProduct(manager, { venueId: stripeVenue, id: P.billplz, soldOnline: false })).status).toBe(404);
    const log = (await listActivity([stripeVenue])).map((a) => a.action);
    expect(log).toContain("pass_product.online");
    expect(log).toContain("pass_product.offline");
  });

  it("refuses a product not sold online, another venue's, a retired one, and every product of a draft venue", async () => {
    const who = await adult("Refused");
    expect(await buy(who, stripeVenue, P.counterOnly)).toMatchObject({ status: 404, body: { code: "PSO_NOT_SOLD" } });
    expect(await buy(who, stripeVenue, P.billplz)).toMatchObject({ status: 404, body: { code: "PSO_NOT_SOLD" } });
    expect(await buy(who, draftVenue, P.draft)).toMatchObject({ status: 409, body: { code: "PSO_OFFLINE" } });
    const gone = await product(stripeVenue, { name: "Gone soon", price: 30, soldOnline: true });
    await retirePassProduct(stripeVenue, gone);
    expect(await buy(who, stripeVenue, gone)).toMatchObject({ status: 404, body: { code: "PSO_NOT_SOLD" } });
    // A private venue sells only to the people on its list.
    expect(await buy(who, privateVenue, P.private)).toMatchObject({ status: 404, body: { code: "PSO_NOT_SOLD" } });
    expect(sent).toEqual([]);
    expect(await getDb().prepare("SELECT 1 FROM online_payments WHERE pass_user_id = ?").get(who.id)).toBeUndefined();
    // Signed out: nothing.
    const res = await myPasses.POST(new NextRequest("http://localhost/api/my/passes", { method: "POST", body: JSON.stringify({ venueId: stripeVenue, productId: P.ten }) }));
    expect(res.status).toBe(401);
  });
});

describe("paid once, issued once", () => {
  it("issues nothing until paid; the webhook issues one pass, a second webhook and the return page none more", async () => {
    const who = await adult("Aisyah");
    const bill = await bought(who, stripeVenue, P.ten);
    expect(await paymentRow(bill)).toMatchObject({ status: "pending", pass_id: null });
    expect(await passesOf(who.id)).toEqual([]);
    // The page is asked to close when a membership's would: an hour.
    const opened = sent.find((s) => s.method === "POST" && s.url.endsWith("/checkout/sessions"))!;
    expect(Number(opened.form!.get("expires_at")) - Math.floor(Date.now() / 1000)).toBeGreaterThan(55 * 60);

    // The same pass while its page is open: back to that page.
    const again = await buy(who, stripeVenue, P.ten);
    expect(again.body).toMatchObject({ reused: true });
    expect(again.body.url!.endsWith(bill)).toBe(true);

    fakeGateways();
    await stripePaid(bill);
    await stripePaid(bill);
    const back = await returnPage(bill);
    vi.unstubAllGlobals();
    const passes = await passesOf(who.id);
    expect(passes).toHaveLength(1);
    expect(passes[0]).toMatchObject({ price: 120, holder_phone: who.phone, holder_participant_id: null, product_id: P.ten, expires_on: addDays(todayISO(), 89), status: "active" });
    expect(await paymentRow(bill)).toMatchObject({ status: "paid", pass_id: passes[0].id, refund_due: 0 });
    expect(back).toContain("Your pass is ready");
    expect(back).toContain(passes[0].code);
    // Its receipt is the pass's own, as at the counter, by online, taxed as the venue taxes passes.
    const receipts = await receiptsOf(passes[0].id);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ kind: "receipt", total: 120, tax_rate: 6, paid_via: "Online (Stripe)" });
    expect(receipts[0].tax_amount).toBeCloseTo(6.79, 2);
    // The customer sees it with its payment; staff see it bought online, and the log says so.
    const mine = await listPassesFor(who.id);
    expect(mine[0].boughtOnline).toEqual({ gateway: "Stripe", reference: bill });
    const log = await listActivity([stripeVenue]);
    expect(log.filter((a) => a.action === "pass.bought_online" && a.detail?.includes(passes[0].code))).toHaveLength(1);
    expect((await paymentByBill(bill))!.pass).toMatchObject({ code: passes[0].code, name: "Ten sessions" });
  });

  it("the webhook, the return page and a retry racing each other issue one pass and one receipt", async () => {
    const who = await adult("Race");
    const bill = await bought(who, stripeVenue, P.ten);
    fakeGateways();
    await Promise.all([stripePaid(bill), returnPage(bill), settleBill({ billId: bill, paid: true, paidAt: null }), stripePaid(bill)]);
    vi.unstubAllGlobals();
    const passes = await passesOf(who.id);
    expect(passes).toHaveLength(1);
    expect(await receiptsOf(passes[0].id)).toHaveLength(1);
    expect(await paymentRow(bill)).toMatchObject({ status: "paid", pass_id: passes[0].id, refund_due: 0 });
  });

  it("an expired Stripe page and a failed Billplz payment issue nothing, and an expired page is not offered again", async () => {
    const who = await adult("Lapsed");
    const bill = await bought(who, stripeVenue, P.ten);
    await stripeEvent(bill, "checkout.session.expired", { payment_status: "unpaid", status: "expired" });
    expect(await paymentRow(bill)).toMatchObject({ status: "pending", pass_id: null });
    expect((await paymentRow(bill)).page_closed_at).not.toBeNull();
    const fresh = await buy(who, stripeVenue, P.ten);
    expect(fresh.body.reused).toBe(false);
    expect(fresh.body.url!.endsWith(bill)).toBe(false);

    const b = await adult("Failed");
    const bbill = await bought(b, billplzVenue, P.billplz);
    await billplzSays(bbill, false);
    expect(await paymentRow(bbill)).toMatchObject({ status: "pending", pass_id: null });
    expect(await passesOf(who.id)).toEqual([]);
    expect(await passesOf(b.id)).toEqual([]);
    // A Billplz page cannot be closed: money that still comes in issues the pass.
    await billplzSays(bbill, true);
    expect(await passesOf(b.id)).toHaveLength(1);
  });

  it("a product retired while the customer paid still gives what was paid for", async () => {
    const who = await adult("Retired");
    const id = await product(stripeVenue, { name: "Last chance", entries: 3, price: 33, soldOnline: true });
    const bill = await bought(who, stripeVenue, id);
    await retirePassProduct(stripeVenue, id);
    fakeGateways();
    await stripePaid(bill);
    vi.unstubAllGlobals();
    expect(await passesOf(who.id)).toMatchObject([{ price: 33, product_id: id }]);
  });
});

describe("for whom", () => {
  it("a pass for one person's place for a child the account looks after; held on the parent's number", async () => {
    const parent = await adult("Parent");
    const kid = await child(parent, "Alya");
    const bill = await bought(parent, stripeVenue, P.kids, kid.id);
    const opened = (await getDb().prepare("SELECT pass_holder_kind, pass_participant_id FROM online_payments WHERE bill_id = ?").get(bill)) as Record<string, unknown>;
    expect(opened).toEqual({ pass_holder_kind: "participant", pass_participant_id: kid.id });
    fakeGateways();
    await stripePaid(bill);
    const back = await returnPage(bill);
    vi.unstubAllGlobals();
    const [pass] = await passesOf(parent.id);
    expect(pass).toMatchObject({ holder_participant_id: kid.id, holder_phone: parent.phone, price: 50 });
    expect(back).toContain("Alya");
    const event = await getDb().prepare("SELECT action FROM participant_events WHERE participant_id = ? AND action = 'pass.bought'").get(kid.id);
    expect(event).toBeDefined();
  });

  it("refuses a pass that pays a whole booking for somebody else, somebody the account does not act for, and a paused relationship", async () => {
    const parent = await adult("Rules");
    const kid = await child(parent, "Badrul");
    expect(await buy(parent, stripeVenue, P.ten, kid.id)).toMatchObject({ status: 409, body: { code: "PSO_NOT_FOR_PARTICIPANT" } });
    const stranger = await adult("Stranger");
    expect(await buy(stranger, stripeVenue, P.kids, kid.id)).toMatchObject({ status: 404, body: { code: "PSO_NOT_GUARDIAN" } });
    await getDb().prepare("UPDATE participant_guardians SET suspended_at = now() WHERE participant_id = ? AND user_id = ?").run(kid.id, parent.id);
    expect(await buy(parent, stripeVenue, P.kids, kid.id)).toMatchObject({ status: 409, body: { code: "PSO_PAUSED" } });
  });

  it("checked again when the money comes in: an account that stopped acting for the child gets nothing, and is owed it back", async () => {
    const parent = await adult("Revoked");
    const kid = await child(parent, "Chandra");
    const bill = await bought(parent, stripeVenue, P.kids, kid.id);
    await getDb().prepare("UPDATE participant_guardians SET revoked_at = now() WHERE participant_id = ? AND user_id = ?").run(kid.id, parent.id);
    fakeGateways();
    await stripePaid(bill);
    const back = await returnPage(bill);
    vi.unstubAllGlobals();
    expect(await passesOf(parent.id)).toEqual([]);
    expect(await paymentRow(bill)).toMatchObject({ status: "paid", pass_id: null, refund_due: 50 });
    expect(back).toContain("No pass could be issued");
    expect((await refundsOwed(stripeVenue)).find((p) => p.billId === bill)).toMatchObject({ purpose: "pass", refundOwed: 50 });
  });
});

describe("money", () => {
  it("goes in the journal, its export, the cash-up and the month's consolidated e-invoice as a counter pass sale does, by online", async () => {
    const who = await adult("Books");
    const bill = await bought(who, stripeVenue, P.ten);
    fakeGateways();
    await stripePaid(bill);
    vi.unstubAllGlobals();
    const [pass] = await passesOf(who.id);
    const [online] = await receiptsOf(pass.id);
    const counter = await issuePass({
      venueId: stripeVenue,
      name: "Ten sessions",
      entries: 10,
      price: 120,
      holderName: "Walk In",
      holderPhone: "0123456789",
      expiresOn: addDays(todayISO(), 89),
      adminId: null,
      paidVia: "Cash",
      productId: P.ten,
    });
    if (!counter.ok) throw new Error(counter.error);
    const [cash] = await receiptsOf(counter.pass.id);

    const today = todayISO();
    const journal = await salesJournal(stripeVenue, today, today);
    const a = journal.find((r) => r.number === online.number)!;
    const b = journal.find((r) => r.number === cash.number)!;
    expect(a).toMatchObject({ category: "Passes", revenue: true, gross: 120, taxRate: 6, method: "online", paidVia: "Online (Stripe)" });
    expect(b).toMatchObject({ category: "Passes", revenue: true, gross: 120, taxRate: 6, method: "cash" });
    expect(a.tax).toBe(b.tax);
    expect(await journalCsv(stripeVenue, today, today)).toContain(online.number);

    const day = await cashUp(stripeVenue, today, null);
    expect(day.entries.some((e) => e.number === online.number && e.method === "online" && e.category === "Passes")).toBe(true);
    expect(day.byMethod.find((m) => m.method === "online")!.taken).toBeGreaterThanOrEqual(120);

    const made = await consolidate(stripeVenue, today.slice(0, 7));
    const con = made.find((e) => e.kind === "consolidated")!;
    const receiptsTotal = journal.filter((r) => r.type === "Receipt" && r.gross > 0).reduce((s, r) => s + r.gross, 0);
    expect(con.total).toBeCloseTo(receiptsTotal, 2);
  });
});

describe("refunds", () => {
  it("an unused pass bought through Stripe: voided with the money back, credited in full, refunded through Stripe once", async () => {
    const who = await adult("Refund");
    const bill = await bought(who, stripeVenue, P.ten);
    fakeGateways();
    await stripePaid(bill);
    vi.unstubAllGlobals();
    const [pass] = await passesOf(who.id);
    const res = await voidPass(manager, pass.id, { refund: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ refunded: 120, owedBack: 120 });
    const docs = await receiptsOf(pass.id);
    expect(docs.map((d) => [d.kind, d.total, d.paid_via])).toEqual([
      ["receipt", 120, "Online (Stripe)"],
      ["credit_note", 120, "Online (Stripe)"],
    ]);
    const owed = (await refundsOwed(stripeVenue)).find((p) => p.billId === bill)!;
    expect(owed).toMatchObject({ purpose: "pass", refundOwed: 120, refundsByApi: true });
    fakeGateways();
    expect(await refundOnline(owed.id, stripeVenue)).toMatchObject({ ok: true });
    expect(await refundOnline(owed.id, stripeVenue)).toMatchObject({ ok: false });
    expect(sent.filter((s) => s.method === "POST" && s.url.endsWith("/refunds"))).toHaveLength(1);
    expect(sent.find((s) => s.url.endsWith("/refunds"))!.form!.get("amount")).toBe("12000");
    // Voiding again owes nothing more.
    expect((await voidPass(manager, pass.id, { refund: true })).status).toBe(409);
  });

  it("a partly used pass hands back the unused share, the venue's rule for passes; voided without a refund nothing is owed", async () => {
    const who = await adult("Partly");
    const bill = await bought(who, stripeVenue, P.ten);
    const second = await bought(who, stripeVenue, P.kids);
    fakeGateways();
    await stripePaid(bill);
    await stripePaid(second);
    vi.unstubAllGlobals();
    const [pass, kids] = await passesOf(who.id);
    // Three of ten entries spent.
    await getDb().prepare("INSERT INTO pass_entries (pass_id, delta, reason) VALUES (?, -3, 'spent')").run(pass.id);
    const res = await voidPass(manager, pass.id, { refund: true });
    expect(await res.json()).toMatchObject({ refunded: 84, owedBack: 84 });
    expect((await paymentRow(bill)).refund_due).toBe(84);
    const plain = await voidPass(manager, kids.id, { refund: false });
    expect(await plain.json()).not.toHaveProperty("owedBack");
    expect((await paymentRow(second)).refund_due).toBe(0);
  });

  it("through Billplz, which has no refund API: owed back and marked refunded by hand, once", async () => {
    const who = await adult("ByHand");
    const bill = await bought(who, billplzVenue, P.billplz);
    await billplzSays(bill, true);
    const [pass] = await passesOf(who.id);
    const res = await voidPass(billplzManager, pass.id, { refund: true });
    expect(await res.json()).toMatchObject({ refunded: 100, owedBack: 100 });
    const owed = (await refundsOwed(billplzVenue)).find((p) => p.billId === bill)!;
    expect(owed).toMatchObject({ purpose: "pass", refundOwed: 100, refundsByApi: false });
    expect(await refundOnline(owed.id, billplzVenue)).toMatchObject({ ok: false });
    expect(await markRefunded(owed.id, billplzVenue, null, "FPX ref 456")).toMatchObject({ ok: true });
    expect(await markRefunded(owed.id, billplzVenue)).toMatchObject({ ok: false });
  });

  it("a chargeback lost voids the pass and credits its receipt for what went back", async () => {
    const who = await adult("Disputed");
    const bill = await bought(who, stripeVenue, P.ten);
    fakeGateways();
    await stripePaid(bill);
    vi.unstubAllGlobals();
    const [pass] = await passesOf(who.id);
    const lost = await recordDispute("stripe", bill, { disputeId: `dp_pass${++n}`, paymentRef: `pi_for_${bill}`, amountMinor: 12000, reason: "fraudulent", status: "lost", dueBy: null, outcome: "lost" });
    expect(lost).not.toBeNull();
    expect((await passesOf(who.id))[0].status).toBe("void");
    expect((await receiptsOf(pass.id)).map((d) => [d.kind, d.total])).toEqual([
      ["receipt", 120],
      ["credit_note", 120],
    ]);
  });
});

describe("the venue going away", () => {
  it("a venue taken off the marketplace sells no more online, and a page already open still issues the pass", async () => {
    const who = await adult("Suspended");
    const bill = await bought(who, stripeVenue, P.ten);
    await getDb().prepare("UPDATE venues SET suspended_at = datetime('now') WHERE id = ?").run(stripeVenue);
    try {
      expect(await buy(who, stripeVenue, P.ten)).toMatchObject({ status: 409, body: { code: "FX11_SUSPENDED" } });
      fakeGateways();
      await stripePaid(bill);
      vi.unstubAllGlobals();
      expect(await passesOf(who.id)).toHaveLength(1);
    } finally {
      await getDb().prepare("UPDATE venues SET suspended_at = NULL WHERE id = ?").run(stripeVenue);
    }
  });

  it("startPassPayment refuses the same as the route", async () => {
    const who = await adult("Direct");
    expect(await startPassPayment(who, draftVenue, { productId: P.draft, participantId: null })).toMatchObject({ ok: false, code: "PSO_OFFLINE" });
  });
});
