/// <reference types="vite/client" />
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { createBooking, createCourt, createVenue, setPaymentStatus } from "../src/lib/store";
import { setVenueTax } from "../src/lib/tax";
import { addDays, isPeakMinute, todayISO } from "../src/lib/time";
import { REFUSALS, NOTICE_VERSION } from "../src/lib/accounting-push";
import * as accounting from "../src/app/api/admin/accounting/route";
import * as callback from "../src/app/api/admin/accounting/xero/callback/route";
import { startXeroStandin, type Standin } from "./helpers/xero-standin";

/**
 * The routes of the live accounting push (ADR 0041): who may use them (a manager of the venue, nobody else), what each
 * logs, how the sign-in at Xero comes back, and that no token or secret is ever in an answer.
 */

let standin: Standin;
let venueA: number;
let venueB: number;
let courtA: number;
let managerA: string;
let managerB: string;
let deskA: string;
const today = todayISO();

const req = (url: string, method: string, cookie?: string, body?: unknown) =>
  new NextRequest(`http://localhost${url}`, { method, headers: cookie ? { cookie } : {}, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const get = (venue: number, cookie?: string, extra = "") => accounting.GET(req(`/api/admin/accounting?venueId=${venue}${extra}`, "GET", cookie));
const post = (cookie: string | undefined, body: Record<string, unknown>) => accounting.POST(req("/api/admin/accounting", "POST", cookie, body));
const log = async (venue: number) => ((await getDb().prepare("SELECT action, detail FROM staff_actions WHERE venue_id = ? ORDER BY id").all(venue)) as { action: string; detail: string | null }[]);

async function cookieFor(email: string, venueId: number, role?: "desk"): Promise<string> {
  const made = await createAdmin({ name: `Staff ${email}`, email, password: "a-strong-password-1", venueId, role });
  if (!made.ok) throw new Error("admin");
  return `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}`;
}

/** Begin connecting as `cookie` and come back from the stand-in's consent screen, answering the callback's redirect. */
async function signIn(cookie: string, venue: number, tenants = [[...standin.organisations.keys()][0]]) {
  const begun = await post(cookie, { venueId: venue, action: "connect", acknowledged: true, noticeVersion: NOTICE_VERSION });
  expect(begun.status).toBe(200);
  const { url } = (await begun.json()) as { url: string };
  const state = new URL(url).searchParams.get("state")!;
  const code = standin.consent(url, tenants);
  return { state, code, back: (as = cookie, extra = "") => callback.GET(req(`/api/admin/accounting/xero/callback?code=${code}&state=${state}${extra}`, "GET", as)) };
}

beforeAll(async () => {
  standin = await startXeroStandin();
  process.env.ACCOUNTING_PUSH_APPROVED = "yes";
  process.env.XERO_CLIENT_ID = standin.clientId;
  process.env.XERO_CLIENT_SECRET = standin.clientSecret;
  process.env.XERO_REDIRECT_URI = "https://app.example.test/api/admin/accounting/xero/callback";
  process.env.XERO_API_URL = standin.url;
  process.env.XERO_IDENTITY_URL = standin.url;
  await ensureBootstrapAdmin();
  const a = await createVenue({ name: "Route Hall A", area: "PJ", address: "1 Jalan A", phone: "0311110001" });
  const b = await createVenue({ name: "Route Hall B", area: "PJ", address: "1 Jalan B", phone: "0311110002" });
  if (!a.ok || !b.ok) throw new Error("venue");
  venueA = a.venue.id;
  venueB = b.venue.id;
  const court = await createCourt({ venueId: venueA, name: "Court 1", sport: "badminton", offPeakRate: 21.2, peakRate: 21.2 });
  if (!court.ok) throw new Error("court");
  courtA = court.court.id;
  await setVenueTax(venueA, { registered: true, rate: 6, regNo: "W10-1234-56789012" });
  managerA = await cookieFor("manager.a@routes.test", venueA);
  managerB = await cookieFor("manager.b@routes.test", venueB);
  deskA = await cookieFor("desk.a@routes.test", venueA, "desk");
});

afterAll(async () => {
  await standin.close();
});

describe("who may use live accounting", () => {
  it("is for signed-in managers of the venue: nobody else reads or changes any of it", async () => {
    expect((await get(venueA)).status).toBe(401);
    expect((await post(undefined, { venueId: venueA, action: "chart" })).status).toBe(401);
    expect((await callback.GET(req("/api/admin/accounting/xero/callback?code=x&state=y", "GET"))).status).toBe(401);
    // Front desk: turned away from every method of it, the callback too.
    for (const res of [await get(venueA, deskA), await post(deskA, { venueId: venueA, action: "disconnect" }), await callback.GET(req("/api/admin/accounting/xero/callback?code=x&state=y", "GET", deskA))]) {
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("MANAGER_ONLY");
    }
    // A manager of another venue.
    expect((await get(venueA, managerB)).status).toBe(403);
    expect((await post(managerB, { venueId: venueA, action: "connect", acknowledged: true, noticeVersion: NOTICE_VERSION })).status).toBe(403);
    expect((await get(venueB, managerB)).status).toBe(200);
    // No venue, an unknown action.
    expect((await accounting.GET(req("/api/admin/accounting", "GET", managerA))).status).toBe(400);
    expect((await post(managerA, { action: "chart" })).status).toBe(400);
    expect((await post(managerA, { venueId: venueA, action: "nonsense" })).status).toBe(400);
  });

  it("shows a venue that has not connected as exactly that, with the install's switches", async () => {
    const body = await (await get(venueA, managerA)).json();
    expect(body.connection).toMatchObject({ status: "not_connected", available: { approved: true, configured: true }, noticeVersion: NOTICE_VERSION });
    expect(body.queue.counts.sent).toBe(0);
    expect(body.keys.payment).toContain("cash");
    expect(body.keys.owed).toEqual(["Stored credit", "Gift vouchers"]);
  });
});

describe("connecting from the dashboard", () => {
  it("refuses to begin without the acknowledgement, with the wording read, and while the install has not allowed it", async () => {
    const no = await post(managerA, { venueId: venueA, action: "connect", acknowledged: false, noticeVersion: NOTICE_VERSION });
    expect(no.status).toBe(400);
    expect((await no.json()).error).toBe(REFUSALS.notAcknowledged);
    expect((await post(managerA, { venueId: venueA, action: "connect", acknowledged: true, noticeVersion: 0 })).status).toBe(400);
    delete process.env.ACCOUNTING_PUSH_APPROVED;
    const off = await post(managerA, { venueId: venueA, action: "connect", acknowledged: true, noticeVersion: NOTICE_VERSION });
    expect(off.status).toBe(400);
    expect((await off.json()).error).toBe(REFUSALS.off);
    process.env.ACCOUNTING_PUSH_APPROVED = "yes";
  });

  it("sends the manager to Xero and, when Xero sends them back, finishes it, logs it and returns them to Reports", async () => {
    const flow = await signIn(managerA, venueA);
    const res = await flow.back();
    expect(res.status).toBe(307);
    const to = new URL(res.headers.get("location")!);
    expect(to.pathname).toBe("/admin");
    expect(Object.fromEntries(to.searchParams)).toEqual({ tab: "reports", venue: String(venueA), xero: "connected" });
    // Neither the code nor the state is in where they are sent next.
    expect(to.toString()).not.toContain(flow.code);
    expect(to.toString()).not.toContain(flow.state);
    const entries = await log(venueA);
    expect(entries.map((e) => e.action)).toEqual(expect.arrayContaining(["accounting.connect_started", "accounting.connected"]));
    const body = await (await get(venueA, managerA)).json();
    expect(body.connection).toMatchObject({ status: "connected", organisation: "Demo Company (MY)", connectedBy: expect.stringContaining("manager.a") });
    expect(body.chart.accounts.length).toBeGreaterThan(0);
    // The same address again is nothing, and another manager cannot finish a sign-in that is not theirs.
    expect(new URL((await flow.back()).headers.get("location")!).searchParams.get("xero")).toBe("failed");
  });

  it("brings a manager back with a refusal in words when Xero declined, or somebody else finishes it", async () => {
    const declined = await signIn(managerA, venueA);
    const refusal = await callback.GET(req(`/api/admin/accounting/xero/callback?error=access_denied&state=${declined.state}`, "GET", managerA));
    const to = new URL(refusal.headers.get("location")!);
    expect(to.searchParams.get("xero")).toBe("failed");
    // A short code the dashboard says in words, never the sentence.
    expect(to.searchParams.get("why")).toBe("declined");
    // A manager of another venue holding the address: refused, and the state is spent either way.
    const stolen = await signIn(managerA, venueA);
    const other = await stolen.back(managerB);
    const away = new URL(other.headers.get("location")!);
    expect(away.searchParams.get("xero")).toBe("failed");
    expect(away.searchParams.get("why")).toBe("bad_state");
    expect(away.searchParams.has("venue")).toBe(false);
    expect((await stolen.back(managerA)).headers.get("location")).toContain("xero=failed");
  });

  it("never puts a token or the client secret in any answer", async () => {
    const answers = [
      await (await get(venueA, managerA)).text(),
      await (await post(managerA, { venueId: venueA, action: "chart" })).text(),
      await (await post(managerA, { venueId: venueA, action: "send_now" })).text(),
    ];
    const secrets = [standin.clientSecret, ...standin.refreshTokens];
    for (const a of answers) for (const s of secrets) expect(a).not.toContain(s);
    expect(answers.join(" ")).not.toMatch(/access_token|refresh_token|client_secret/);
  });
});

describe("the dashboard's actions", () => {
  let booking: string;
  beforeAll(async () => {
    let date = addDays(todayISO(), 3);
    while (isPeakMinute(date, 9 * 60)) date = addDays(date, 1);
    const made = await createBooking({ courtId: courtA, date, hours: [9], name: "Route Player", phone: "0191112222" });
    if (!made.ok) throw new Error(made.error);
    booking = made.booking.code;
    await setPaymentStatus(booking, true, "cash");
  });

  it("holds an unmapped sale, and a manager's mapping is checked, saved, logged and releases it", async () => {
    const sent = await post(managerA, { venueId: venueA, action: "send_now" });
    expect(sent.status).toBe(200);
    const first = await sent.json();
    expect(first).toMatchObject({ sent: 0 });
    expect(first.queue.counts.held).toBe(1);
    expect(first.queue.held[0].needs).toEqual(expect.arrayContaining(["account:Court hire", "tax:rate:6", "payment:cash"]));

    const bad = await post(managerA, { venueId: venueA, action: "mapping", account: { "Court hire": "090" } });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe(REFUSALS.notIncome);
    const saved = await post(managerA, { venueId: venueA, action: "mapping", account: { "Court hire": "200" }, tax: { "rate:6": "SV6", none: "NONE" }, payment: { cash: "090" } });
    expect(saved.status).toBe(200);
    expect((await saved.json()).queue.counts).toMatchObject({ held: 0, queued: 1 });
    expect((await log(venueA)).some((e) => e.action === "accounting.mapping")).toBe(true);
  });

  it("sends now, and the sale is in Xero once", async () => {
    const sent = await (await post(managerA, { venueId: venueA, action: "send_now" })).json();
    expect(sent).toMatchObject({ sent: 1 });
    expect(standin.invoices).toHaveLength(1);
    expect(standin.invoices[0].lines[0]).toMatchObject({ AccountCode: "200", TaxType: "SV6", UnitAmount: 21.2, TaxAmount: 1.2 });
    expect(sent.queue.counts.sent).toBe(1);
    const again = await (await post(managerA, { venueId: venueA, action: "send_now" })).json();
    expect(again).toMatchObject({ sent: 0 });
    expect(standin.invoices).toHaveLength(1);
    expect((await log(venueA)).filter((e) => e.action === "accounting.send_now").length).toBeGreaterThanOrEqual(3);
  });

  it("checks the totals against what was sent, for the days asked, and says plainly when they differ", async () => {
    const same = await (await get(venueA, managerA, `&reconcile=1&from=${today}&to=${today}`)).json();
    expect(same.reconciliation).toMatchObject({ differs: false, ledger: { count: 1, grossCents: 2120, taxCents: 120 }, sent: { count: 1, grossCents: 2120, taxCents: 120 } });
    await getDb().prepare("UPDATE accounting_queue SET xero_total_cents = 2000 WHERE venue_id = ?").run(venueA);
    const off = await (await get(venueA, managerA, `&reconcile=1&from=${today}&to=${today}`)).json();
    expect(off.reconciliation).toMatchObject({ differs: true, sent: { grossCents: 2000 } });
    expect((await get(venueA, managerA, "&reconcile=1&from=nope&to=nope")).status).toBe(400);
    await getDb().prepare("UPDATE accounting_queue SET xero_total_cents = 2120 WHERE venue_id = ?").run(venueA);
  });

  it("previews and confirms earlier sales, and refuses a confirmation that is not the preview's", async () => {
    const from = addDays(today, -5);
    const preview = await post(managerA, { venueId: venueA, action: "preview_start", from });
    expect(preview.status).toBe(200);
    expect((await preview.json()).preview).toMatchObject({ from, count: 0, totalCents: 0 });
    expect((await post(managerA, { venueId: venueA, action: "preview_start", from: "someday" })).status).toBe(400);
    const refused = await post(managerA, { venueId: venueA, action: "start", from, count: 3, totalCents: 1 });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe(REFUSALS.previewChanged);
    const ok = await post(managerA, { venueId: venueA, action: "start", from, count: 0, totalCents: 0 });
    expect(ok.status).toBe(200);
    expect((await log(venueA)).some((e) => e.action === "accounting.start" && e.detail?.includes(from))).toBe(true);
  });

  it("sends a failed sale again on a manager's word, and says so when there is nothing to send", async () => {
    await getDb().prepare("UPDATE accounting_queue SET status = 'failed', error_code = 'rejected', error_detail = 'A made-up reason', xero_id = NULL, xero_payment_id = NULL WHERE venue_id = ?").run(venueA);
    const view = await (await get(venueA, managerA)).json();
    expect(view.queue.failed).toHaveLength(1);
    expect(view.queue.failed[0]).toMatchObject({ code: "rejected", detail: "A made-up reason" });
    expect(JSON.stringify(view)).not.toMatch(/Route Player|0191112222/);
    const nothing = await post(managerA, { venueId: venueA, action: "retry", id: 999999 });
    expect(nothing.status).toBe(409);
    expect((await nothing.json()).error).toBe(REFUSALS.nothingToRetry);
    expect((await post(managerA, { venueId: venueA, action: "retry", id: "x" })).status).toBe(400);
    const done = await post(managerA, { venueId: venueA, action: "retry", id: view.queue.failed[0].id });
    expect(done.status).toBe(200);
    expect((await done.json()).count).toBe(1);
    expect((await log(venueA)).some((e) => e.action === "accounting.retried")).toBe(true);
  });

  it("is kept apart between venues: another venue's manager sees none of it and cannot touch it", async () => {
    const other = await (await get(venueB, managerB)).json();
    expect(other.connection.status).toBe("not_connected");
    expect(other.queue.counts.sent + other.queue.counts.queued + other.queue.counts.held).toBe(0);
    expect(other.mapping).toEqual({ account: {}, tax: {}, payment: {} });
    expect((await post(managerB, { venueId: venueA, action: "retry" })).status).toBe(403);
    expect((await post(managerB, { venueId: venueA, action: "mapping", account: { "Court hire": "200" } })).status).toBe(403);
    expect((await post(managerB, { venueId: venueB, action: "disconnect" })).status).toBe(409);
  });

  it("disconnects, revokes at Xero, logs it, and keeps the sales sent", async () => {
    const done = await post(managerA, { venueId: venueA, action: "disconnect" });
    expect(done.status).toBe(200);
    const body = await done.json();
    expect(body.revoked).toBe(true);
    expect(body.connection.status).toBe("disconnected");
    expect(standin.refreshTokens.size).toBe(0);
    expect((await log(venueA)).some((e) => e.action === "accounting.disconnected")).toBe(true);
    const row = (await getDb().prepare("SELECT access_token, refresh_token FROM accounting_connections WHERE venue_id = ?").get(venueA)) as Record<string, unknown>;
    expect(row).toEqual({ access_token: null, refresh_token: null });
    expect(standin.invoices).toHaveLength(1);
    expect((await post(managerA, { venueId: venueA, action: "disconnect" })).status).toBe(409);
    expect((await post(managerA, { venueId: venueA, action: "send_now" })).status).toBe(409);
  });
});
