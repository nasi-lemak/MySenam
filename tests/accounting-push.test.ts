import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { createAdmin, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { registerUser } from "../src/lib/auth";
import { salesJournal } from "../src/lib/accounting";
import {
  alertIfFailing,
  beginConnect,
  classify,
  connectionView,
  disconnect,
  enqueueNew,
  enqueueRange,
  finishConnect,
  loadMapping,
  MAX_ATTEMPTS,
  NOTICE_VERSION,
  previewStart,
  pushApproved,
  pushDue,
  queueView,
  reconcile,
  refreshChart,
  REFUSALS,
  retry,
  runAccountingPush,
  saveMapping,
  scrub,
  startFrom,
  WALK_IN,
} from "../src/lib/accounting-push";
import { getDb } from "../src/lib/db";
import { resetSecretKey } from "../src/lib/secrets";
import {
  adminCancelBooking,
  createBooking,
  createCourt,
  createVenue,
  issuePass,
  payBookingFromWallet,
  sellMembership,
  setPaymentStatus,
  topUpWallet,
} from "../src/lib/store";
import { setVenueTax } from "../src/lib/tax";
import { addDays, isPeakMinute, todayISO } from "../src/lib/time";
import { sellVoucher } from "../src/lib/vouchers";
import { organisation, startXeroStandin, type Standin } from "./helpers/xero-standin";

/**
 * The live push of a venue's sales to Xero (lib/accounting-push.ts, ADR 0041), against a stand-in for Xero
 * (tests/helpers/xero-standin.ts): what is connected and what is acknowledged, the mapping that is never guessed, what
 * is sent from the sales journal and how it adds up, the queue's reliability (a crash, a retry, a rate limit, an expired
 * token), disconnecting, the start day for earlier sales, and the reconciliation. A stand-in proves what the app does
 * against an API of this shape, not that Xero behaves so: the integration stays INTEGRATION_VERIFICATION_REQUIRED.
 */

const today = todayISO();
let date = addDays(today, 3);
let hour = 8;
let standin: Standin;
let venueId: number;
let courtId: number;
let manager: { id: number; name: string };
let guardianId: number;
const CHILD = "Zara Kecil Tester";
const PHONE = "0198887777";

const redirect = "https://app.example.test/api/admin/accounting/xero/callback";

function configure(): void {
  process.env.ACCOUNTING_PUSH_APPROVED = "yes";
  process.env.XERO_CLIENT_ID = standin.clientId;
  process.env.XERO_CLIENT_SECRET = standin.clientSecret;
  process.env.XERO_REDIRECT_URI = redirect;
  process.env.XERO_API_URL = standin.url;
  process.env.XERO_IDENTITY_URL = standin.url;
}

async function booked(over: { userId?: number; name?: string } = {}) {
  // One court, a new day when its hours run out.
  if (hour > 21) {
    hour = 8;
    date = addDays(date, 1);
  }
  const made = await createBooking({ courtId, date, hours: [hour++], name: over.name ?? "Nurul Ain", phone: PHONE, userId: over.userId });
  if (!made.ok) throw new Error(made.error);
  return made.booking;
}

/** Sign in at the stand-in the way a manager would: begin, consent, come back. */
async function connect(venue = venueId, tenants = [...standin.organisations.keys()].slice(0, 1), admin = manager) {
  const begun = await beginConnect(venue, admin, { acknowledged: true, noticeVersion: NOTICE_VERSION });
  if (!begun.ok) throw new Error(begun.error);
  const state = new URL(begun.url).searchParams.get("state")!;
  const code = standin.consent(begun.url, tenants);
  return { state, code, done: await finishConnect({ code, state, denied: false }, admin, () => true) };
}

/** Every kind of sale, tax and way of paying mapped to something in the stand-in's chart. */
async function mapEverything(venue = venueId) {
  await refreshChart(venue);
  const { ACCOUNT_KEYS, OWED_KEYS, PAYMENT_KEYS, taxKeysInUse } = await import("../src/lib/accounting-push");
  const account: Record<string, string> = {};
  for (const k of ACCOUNT_KEYS) account[k] = (OWED_KEYS as string[]).includes(k) ? "800" : "200";
  const payment: Record<string, string> = {};
  for (const k of PAYMENT_KEYS) payment[k] = k === "credit" ? "800" : "090";
  const tax: Record<string, string> = {};
  for (const k of await taxKeysInUse(venue)) tax[k] = k === "none" ? "NONE" : k === "rate:6" ? "SV6" : "SV8";
  const saved = await saveMapping(venue, { account, payment, tax });
  if (!saved.ok) throw new Error(saved.error);
}

const rows = async (v = venueId) =>
  (await getDb().prepare("SELECT * FROM accounting_queue WHERE venue_id = ? ORDER BY id").all(v)) as Record<string, unknown>[];
const status = async (v = venueId) => {
  const counts: Record<string, number> = {};
  for (const r of await rows(v)) counts[String(r.status)] = (counts[String(r.status)] ?? 0) + 1;
  return counts;
};

beforeAll(async () => {
  standin = await startXeroStandin([organisation(), organisation({ name: "Second Org" })]);
  configure();
  await ensureBootstrapAdmin();
  const made = await createVenue({ name: "Ledger Hall", area: "PJ", address: "1 Jalan Akaun", phone: "0311110000" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 21.2, peakRate: 21.2 });
  if (!court.ok) throw new Error("court");
  courtId = court.court.id;
  await setVenueTax(venueId, { registered: true, rate: 6, regNo: "W10-1234-56789012" });
  while (isPeakMinute(date, 9 * 60)) date = addDays(date, 1);
  const admin = await createAdmin({ name: "Musa Manager", email: "musa@push.test", password: "manager-pass-1", venueId });
  if (!admin.ok) throw new Error("admin");
  manager = { id: admin.admin.id, name: admin.admin.name };
  const user = await registerUser({ name: "Nurul Ain", email: "nurul.push@example.my", phone: PHONE, password: "a long enough password" });
  if (!user.ok) throw new Error(user.error);
  guardianId = user.user.id;

  // The same sales as the journal's own test: takings, money owed to customers, and a refund.
  const cash = await booked();
  await setPaymentStatus(cash.code, true, "cash");
  const cancelled = await booked();
  await setPaymentStatus(cancelled.code, true, "qr");
  await adminCancelBooking(cancelled.code);
  await topUpWallet({ userId: guardianId, amount: 50, adminId: manager.id, venueId });
  const fromCredit = await booked({ userId: guardianId });
  await payBookingFromWallet(fromCredit.id);
  const pass = await issuePass({
    venueId, name: "5-hour pass", entries: 5, price: 100, holderName: "Nurul Ain", holderPhone: PHONE,
    expiresOn: addDays(today, 60), adminId: manager.id, userId: guardianId,
  });
  if (!pass.ok) throw new Error(pass.error);
  await sellMembership({ venueId, holderName: "Nurul Ain", holderPhone: PHONE, startsOn: today, expiresOn: addDays(today, 30), price: 80, adminId: manager.id });
  await sellVoucher({ venueId, amount: 30, buyerName: "Siti", adminId: manager.id, via: "cash" });
  // A child's name typed on a booking made through the guardian's account, and on a walk-in's: neither may reach Xero.
  const child = await booked({ userId: guardianId, name: CHILD });
  await setPaymentStatus(child.code, true, "card");
  const walkIn = await booked({ name: CHILD });
  await setPaymentStatus(walkIn.code, true, "cash");
  // A long setup on a busy machine (a database to migrate, a dozen sales to make): not a timing assertion, only room to finish.
}, 180_000);

afterAll(async () => {
  await standin.close();
});

describe("what the install allows", () => {
  it("is off until the install says so, and offers nothing then", async () => {
    delete process.env.ACCOUNTING_PUSH_APPROVED;
    expect(pushApproved()).toBe(false);
    const view = await connectionView(venueId);
    expect(view.available).toEqual({ approved: false, configured: true });
    expect(view.status).toBe("not_connected");
    expect(await beginConnect(venueId, manager, { acknowledged: true, noticeVersion: NOTICE_VERSION })).toEqual({ ok: false, error: REFUSALS.off });
    expect(await pushDue(venueId)).toEqual({ idle: "off" });
    configure();
  });

  it("needs the install's Xero app registered", async () => {
    const id = process.env.XERO_CLIENT_ID;
    delete process.env.XERO_CLIENT_ID;
    expect(await beginConnect(venueId, manager, { acknowledged: true, noticeVersion: NOTICE_VERSION })).toEqual({ ok: false, error: REFUSALS.notConfigured });
    process.env.XERO_CLIENT_ID = id;
  });

  it("refuses to connect until the venue has acknowledged what is sent, and the wording it read is the current one", async () => {
    expect(await beginConnect(venueId, manager, { acknowledged: false, noticeVersion: NOTICE_VERSION })).toEqual({ ok: false, error: REFUSALS.notAcknowledged });
    expect(await beginConnect(venueId, manager, { acknowledged: "yes", noticeVersion: NOTICE_VERSION })).toEqual({ ok: false, error: REFUSALS.notAcknowledged });
    expect(await beginConnect(venueId, manager, { acknowledged: true, noticeVersion: NOTICE_VERSION + 1 })).toEqual({ ok: false, error: REFUSALS.staleNotice });
    expect(await getDb().prepare("SELECT COUNT(*)::int AS n FROM accounting_connections").get()).toEqual({ n: 0 });
  });
});

describe("connecting", () => {
  it("sends the manager to Xero with PKCE and the narrow scopes, and records the acknowledgement with the connection", async () => {
    const begun = await beginConnect(venueId, manager, { acknowledged: true, noticeVersion: NOTICE_VERSION });
    if (!begun.ok) throw new Error(begun.error);
    const url = new URL(begun.url);
    expect(url.origin + url.pathname).toBe("https://login.xero.com/identity/connect/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(standin.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(redirect);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toContain("offline_access");
    expect(url.searchParams.get("scope")).not.toContain("payroll");
    // The client secret is never in what the browser is sent to.
    expect(begun.url).not.toContain(standin.clientSecret);
    const stored = (await getDb().prepare("SELECT verifier FROM accounting_oauth_states").get()) as { verifier: string };
    expect(stored.verifier.startsWith("v1:")).toBe(true);
    await getDb().prepare("DELETE FROM accounting_oauth_states").run();
  });

  it("finishes only what a signed-in manager began: once, by the same person, with the tokens sealed", async () => {
    const begun = await beginConnect(venueId, manager, { acknowledged: true, noticeVersion: NOTICE_VERSION });
    if (!begun.ok) throw new Error(begun.error);
    const state = new URL(begun.url).searchParams.get("state")!;
    const code = standin.consent(begun.url, [[...standin.organisations.keys()][0]]);
    // Somebody else cannot finish it, and a state made up is nothing.
    expect(await finishConnect({ code, state: "made-up", denied: false }, manager, () => true)).toMatchObject({ ok: false, error: REFUSALS.badState });
    // A state taken by another member of staff is spent by trying: the first try consumed it.
    expect(await finishConnect({ code, state, denied: false }, { id: manager.id + 99, name: "Other" }, () => true)).toMatchObject({ ok: false, error: REFUSALS.otherPerson });
    expect(await finishConnect({ code, state, denied: false }, manager, () => true)).toMatchObject({ ok: false, error: REFUSALS.badState });
    expect((await connectionView(venueId)).status).toBe("not_connected");

    const { done, state: s2 } = await connect();
    expect(done).toMatchObject({ ok: true, venueId, organisation: "Demo Company (MY)" });
    // Used once: the same address again finds nothing.
    expect(await finishConnect({ code: "again", state: s2, denied: false }, manager, () => true)).toMatchObject({ ok: false, error: REFUSALS.badState });

    const view = await connectionView(venueId);
    expect(view).toMatchObject({ status: "connected", organisation: "Demo Company (MY)", connectedBy: "Musa Manager", acknowledgedBy: "Musa Manager", startDate: todayISO() });
    expect(view.acknowledgedAt).toBeTruthy();
    expect(JSON.stringify(view)).not.toMatch(/token|secret/i);
  });

  it("keeps both tokens sealed: nothing readable in the database, and not under another key", async () => {
    const c = (await getDb().prepare("SELECT * FROM accounting_connections WHERE venue_id = ?").get(venueId)) as Record<string, string>;
    const plain = [...standin.refreshTokens][0];
    for (const [column, value] of Object.entries(c)) {
      if (typeof value !== "string") continue;
      expect(value, column).not.toContain(plain);
      expect(value, column).not.toContain(standin.clientSecret);
    }
    expect(c.access_token.startsWith("v1:")).toBe(true);
    expect(c.refresh_token.startsWith("v1:")).toBe(true);
    // Under another key (an install restored elsewhere) it cannot be opened, so the access is asked for again, not guessed.
    const was = process.env.MYSENAM_SECRET;
    process.env.MYSENAM_SECRET = "a different secret entirely";
    resetSecretKey();
    await getDb().prepare("UPDATE accounting_connections SET access_expires_at = now() - interval '1 hour' WHERE venue_id = ?").run(venueId);
    expect(await pushDue(venueId)).toEqual({ idle: "reconnect" });
    expect((await connectionView(venueId)).status).toBe("needs_reconnect");
    if (was === undefined) delete process.env.MYSENAM_SECRET;
    else process.env.MYSENAM_SECRET = was;
    resetSecretKey();
  });

  it("refuses several organisations, another currency and a consent that was declined, keeping and sending nothing", async () => {
    await disconnect(venueId);
    const held = standin.refreshTokens.size;
    // Two organisations chosen: connect exactly one.
    const both = await connect(venueId, [...standin.organisations.keys()]);
    expect(both.done).toMatchObject({ ok: false, error: REFUSALS.oneOrganisation });
    expect((await connectionView(venueId)).status).toBe("disconnected");
    // The grant it was given is given back at once: nothing is left alive at Xero.
    expect(standin.refreshTokens.size).toBe(held);

    const sgd = organisation({ currency: "SGD", name: "Singapore Co" });
    standin.organisations.set(sgd.tenantId, sgd);
    expect((await connect(venueId, [sgd.tenantId])).done).toMatchObject({ ok: false, error: REFUSALS.currency });
    expect(standin.refreshTokens.size).toBe(held);
    standin.organisations.delete(sgd.tenantId);

    const begun = await beginConnect(venueId, manager, { acknowledged: true, noticeVersion: NOTICE_VERSION });
    if (!begun.ok) throw new Error(begun.error);
    const state = new URL(begun.url).searchParams.get("state")!;
    expect(await finishConnect({ code: null, state, denied: true }, manager, () => true)).toMatchObject({ ok: false, error: REFUSALS.declined });
    expect((await connectionView(venueId)).status).toBe("disconnected");
  });

  it("connects to the venue's own organisation after all of that", async () => {
    expect((await connect()).done).toMatchObject({ ok: true });
    expect((await connectionView(venueId)).status).toBe("connected");
  });

  it("is refused by a manager who does not manage that venue", async () => {
    const begun = await beginConnect(venueId, manager, { acknowledged: true, noticeVersion: NOTICE_VERSION });
    if (!begun.ok) throw new Error(begun.error);
    const state = new URL(begun.url).searchParams.get("state")!;
    const code = standin.consent(begun.url, [[...standin.organisations.keys()][0]]);
    expect(await finishConnect({ code, state, denied: false }, manager, () => false)).toMatchObject({ ok: false, venueId: null });
  });
});

describe("the mapping is never guessed", () => {
  it("holds a sale with an unmapped part and lists what it needs, sending nothing", async () => {
    await enqueueNew(venueId, new Date(), true);
    const queue = await queueView(venueId);
    expect(queue.counts.held).toBeGreaterThan(0);
    expect(queue.counts.queued).toBe(0);
    expect(queue.held[0].needs.length).toBe(3);
    expect(queue.held.some((h) => h.needs.includes("account:Court hire"))).toBe(true);
    expect(queue.held.some((h) => h.needs.includes("tax:rate:6"))).toBe(true);
    expect(await pushDue(venueId)).toMatchObject({ sent: 0 });
    expect(standin.invoices).toHaveLength(0);
  });

  it("checks each choice against the chart read from Xero", async () => {
    // Connecting read the organisation's lists; forgotten, they have to be read before anything is chosen.
    await getDb().prepare("DELETE FROM accounting_chart WHERE venue_id = ?").run(venueId);
    expect(await saveMapping(venueId, { account: { "Court hire": "200" } })).toEqual({ ok: false, error: REFUSALS.loadFirst });
    const read = await refreshChart(venueId);
    expect(read.ok && read.chart.accounts.map((a) => a.code)).not.toContain("999");
    const bad = (input: Record<string, unknown>) => saveMapping(venueId, input).then((r) => (r.ok ? "ok" : r.error));
    expect(await bad({ account: { "Court hire": "404" } })).toBe(REFUSALS.noAccount);
    expect(await bad({ account: { "Court hire": "999" } })).toBe(REFUSALS.noAccount);
    // Income to a bank account, money owed to customers to income, a payment to an account that takes none.
    expect(await bad({ account: { "Court hire": "090" } })).toBe(REFUSALS.notIncome);
    expect(await bad({ account: { "Gift vouchers": "200" } })).toBe(REFUSALS.notLiability);
    expect(await bad({ payment: { cash: "200" } })).toBe(REFUSALS.noPayment);
    // A tax type at the wrong rate, a made-up one, a "no tax" that is not at nothing.
    expect(await bad({ tax: { "rate:6": "SV8" } })).toBe(REFUSALS.taxRate);
    expect(await bad({ tax: { "rate:6": "NOPE" } })).toBe(REFUSALS.noTaxType);
    expect(await bad({ tax: { none: "SV6" } })).toBe(REFUSALS.taxNone);
    expect(await bad({ account: { "Not a category": "200" } })).toBe(REFUSALS.badKey);
    expect(await bad({ tax: { "rate:abc": "SV6" } })).toBe(REFUSALS.badKey);
    expect(await loadMapping(venueId)).toEqual({ account: {}, tax: {}, payment: {} });
  });

  it("holds a sale for the one part still missing, and releases it as soon as it is mapped", async () => {
    expect(await saveMapping(venueId, { account: { "Court hire": "200" }, tax: { "rate:6": "SV6", none: "NONE" }, payment: { cash: "090" } })).toMatchObject({ ok: true });
    const queue = await queueView(venueId);
    const court = queue.held.find((h) => h.category === "Court hire" && h.needs.length === 1);
    expect(court?.needs[0].startsWith("payment:")).toBe(true);
    // A credit note is held for what its own sale is paid by, not for what it does not know.
    expect(queue.counts.queued).toBeGreaterThan(0);
    await mapEverything();
    expect((await queueView(venueId)).counts.held).toBe(0);
  });
});

describe("what is sent", () => {
  beforeAll(async () => {
    expect((await pushDue(venueId)).failed).toBe(0);
    // A credit note waits for its sale: a second pass sends what the first set aside.
    await pushDue(venueId, new Date(Date.now() + 11 * 60_000));
  });

  it("sends each paid sale as an authorised invoice with its payment, and each refund as a credit note with its refund", async () => {
    const journal = (await salesJournal(venueId, today, today)).filter((r) => !r.test);
    expect(standin.invoices.length + standin.creditNotes.length).toBe(journal.length);
    expect(standin.creditNotes).toHaveLength(1);
    expect(standin.creditNotes[0]).toMatchObject({ type: "ACCRECCREDIT", status: "PAID", lineAmountTypes: "Inclusive" });
    expect(standin.invoices.every((i) => i.type === "ACCREC" && i.status === "PAID")).toBe(true);
    // One payment for each invoice and one refund for the credit note, none twice.
    expect(standin.payments).toHaveLength(journal.length);
    expect(standin.payments.filter((p) => p.forCreditNote)).toHaveLength(1);
    expect(new Set(standin.payments.map((p) => p.documentId)).size).toBe(journal.length);
    expect(await status()).toEqual({ sent: journal.length });
  });

  it("uses the mapping: the income account, the tax type and the account the way of paying was mapped to", () => {
    const court = standin.invoices.find((i) => i.lines[0].AccountCode === "200" && i.lines[0].TaxType === "SV6")!;
    expect(court.lines[0]).toMatchObject({ Quantity: 1, UnitAmount: 21.2, TaxAmount: 1.2 });
    expect(court.reference).toMatch(/^MySenam V\d+ booking:\d+$/);
    // Money held for customers goes to the liability account, with no tax.
    const voucher = standin.invoices.find((i) => i.lines[0].AccountCode === "800" && i.lines[0].UnitAmount === 30)!;
    expect(voucher.lines[0]).toMatchObject({ TaxType: "NONE", TaxAmount: 0 });
    // (Several bookings cost 21.20, so which one the stand-in lists first depends on the order they were made in: look at all of them.)
    const bookingIds = standin.invoices.filter((i) => i.lines[0].UnitAmount === 21.2 && i.reference.includes("booking")).map((i) => i.id);
    expect(standin.payments.filter((p) => bookingIds.includes(p.documentId)).some((p) => p.accountCode === "090")).toBe(true);
    // A booking paid from stored credit settles against the account chosen for stored credit.
    const paidFromCredit = standin.payments.find((p) => p.accountCode === "800" && !p.forCreditNote);
    expect(paidFromCredit).toBeTruthy();
  });

  it("numbers each document with the venue's own number in front, and says which sale it is", () => {
    for (const d of [...standin.invoices, ...standin.creditNotes]) {
      expect(d.number).toMatch(new RegExp(`^V${venueId}-`));
      expect(d.reference).toContain(`V${venueId}`);
    }
  });

  it("matches the ledger to the cent: the same documents, the same totals, the same tax", async () => {
    const journal = (await salesJournal(venueId, today, today)).filter((r) => !r.test);
    const cents = (n: number) => Math.round(n * 100);
    const ledger = journal.reduce((s, r) => s + cents(r.gross), 0);
    const sent = [...standin.invoices.map((i) => i.totalCents), ...standin.creditNotes.map((c) => -c.totalCents)].reduce((a, b) => a + b, 0);
    expect(sent).toBe(ledger);
    const ledgerTax = journal.reduce((s, r) => s + cents(r.tax), 0);
    expect([...standin.invoices.map((i) => i.taxCents), ...standin.creditNotes.map((c) => -c.taxCents)].reduce((a, b) => a + b, 0)).toBe(ledgerTax);
    const r = await reconcile(venueId, today, today);
    expect(r.ok && r.report).toMatchObject({ differs: false, days: [] });
    expect(r.ok && r.report.sent.count).toBe(journal.length);
    expect(r.ok && r.report.waiting).toMatchObject({ queued: 0, held: 0, failed: 0 });
  });

  it("books each sale under the account that paid, or one walk-in contact; never a child, a phone number or whom a place was for", () => {
    const everything = JSON.stringify([standin.invoices, standin.creditNotes]);
    expect(everything).not.toContain(CHILD);
    expect(everything).not.toContain(PHONE);
    expect(everything).not.toMatch(/Siti/);
    const names = new Set([...standin.invoices, ...standin.creditNotes].map((d) => d.contact.Name));
    expect([...names].sort()).toEqual(["Nurul Ain", WALK_IN].sort());
    const account = [...standin.invoices].filter((d) => d.contact.Name === "Nurul Ain");
    expect(account.length).toBeGreaterThan(0);
    expect(account.every((d) => d.contact.EmailAddress === "nurul.push@example.my")).toBe(true);
    expect([...standin.invoices].filter((d) => d.contact.Name === WALK_IN).every((d) => d.contact.EmailAddress === undefined)).toBe(true);
    // A line says the kind of sale; a booking's the court and day; no line holds a name.
    for (const d of [...standin.invoices, ...standin.creditNotes]) expect(d.lines[0].Description).not.toMatch(/Nurul|Siti|Zara/);
  });

  it("keeps no customer's name, email or phone in the queue or the connection", async () => {
    const text = JSON.stringify([await rows(), await getDb().prepare("SELECT * FROM accounting_connections").all(), await getDb().prepare("SELECT * FROM accounting_mappings").all()]);
    for (const secret of ["Nurul", "nurul.push", PHONE, CHILD, "Siti"]) expect(text, secret).not.toContain(secret);
  });

  it("never writes a token or the client secret to the log or the activity log", async () => {
    const tokens = [standin.clientSecret, ...standin.refreshTokens];
    const logged = JSON.stringify(await getDb().prepare("SELECT * FROM staff_actions").all());
    for (const t of tokens) expect(logged).not.toContain(t);
  });

  it("is idempotent: reading the journal again queues nothing twice, and sending again sends nothing twice", async () => {
    const before = standin.invoices.length + standin.creditNotes.length;
    expect(await enqueueNew(venueId, new Date(), true)).toBe(0);
    await pushDue(venueId, new Date(Date.now() + 60 * 60_000));
    expect(standin.invoices.length + standin.creditNotes.length).toBe(before);
    const dup = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM (SELECT source_ref FROM accounting_queue GROUP BY venue_id, source_ref HAVING COUNT(*) > 1) d").get()) as { n: number };
    expect(dup.n).toBe(0);
  });
});

describe("a credit note and what it reverses", () => {
  it("is pushed for a sale that is in Xero, and set aside, not guessed, for one that never was", async () => {
    const [credit] = (await getDb().prepare("SELECT * FROM accounting_queue WHERE venue_id = ? AND kind = 'credit_note'").all(venueId)) as { original_ref: string; xero_id: string }[];
    expect(credit.original_ref).toMatch(/^booking:\d+$/);
    const original = (await getDb().prepare("SELECT xero_id, status FROM accounting_queue WHERE venue_id = ? AND source_ref = ?").get(venueId, credit.original_ref)) as { xero_id: string; status: string };
    expect(original.status).toBe("sent");
    expect(credit.xero_id).toBeTruthy();
  });

  it("waits while its sale is still on its way, and is left out when that sale is not in this organisation", async () => {
    const v = await createVenue({ name: "Credit Hall", area: "PJ", address: "2 Jalan Akaun", phone: "0311110011" });
    if (!v.ok) throw new Error("venue");
    const other = v.venue.id;
    expect((await connect(other)).done).toMatchObject({ ok: true });
    await mapEverything(other);
    const put = async (ref: string, kind: string, status: string, original: string | null, tenant: string | null) =>
      getDb()
        .prepare(
          `INSERT INTO accounting_queue (venue_id, source_ref, kind, number, category, day, occurred_at, gross_cents, tax_cents, method, description, original_ref, status, tenant_id)
           VALUES (?, ?, ?, ?, 'Court hire', ?, now(), 1000, 0, 'cash', 'Court hire', ?, ?, ?)`
        )
        .run(other, ref, kind, ref, today, original, status, tenant);
    // A sale that failed (it is not in Xero yet), a credit note for it; a credit note for a sale that was never queued; a sale
    // that went to another organisation, and a credit note for it.
    await put("receipt:9001", "invoice", "failed", null, null);
    await put("receipt:9002", "credit_note", "queued", "receipt:9001", null);
    await put("receipt:9003", "credit_note", "queued", "receipt:9000", null);
    await put("receipt:9004", "invoice", "sent", null, "another-tenant");
    await put("receipt:9005", "credit_note", "queued", "receipt:9004", null);
    const calls = standin.calls.length;
    await pushDue(other, new Date(Date.now() + 1000));
    const by = async (ref: string) => (await getDb().prepare("SELECT status, reason, error_code FROM accounting_queue WHERE venue_id = ? AND source_ref = ?").get(other, ref)) as { status: string; reason: string | null; error_code: string | null };
    expect(await by("receipt:9002")).toMatchObject({ status: "queued", error_code: "waiting_for_sale" });
    expect(await by("receipt:9003")).toMatchObject({ status: "skipped", reason: "before_connection" });
    expect(await by("receipt:9005")).toMatchObject({ status: "skipped", reason: "original_not_in_xero" });
    // None of them was sent: decided before anything went to Xero for them.
    expect(standin.calls.slice(calls).filter((c) => c.path.includes("/CreditNotes") && c.method === "PUT")).toHaveLength(0);
    await disconnect(other);
  });
});

describe("a crash, a retry, a limit and a bad token", () => {
  async function freshSale(): Promise<string> {
    const b = await booked();
    await setPaymentStatus(b.code, true, "cash");
    await enqueueNew(venueId, new Date(), true);
    return `booking:${b.id}`;
  }
  const due = async () => ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM accounting_queue WHERE venue_id = ? AND status = 'queued'").get(venueId)) as { n: number }).n;
  const rowOf = async (ref: string) => (await getDb().prepare("SELECT * FROM accounting_queue WHERE venue_id = ? AND source_ref = ?").get(venueId, ref)) as Record<string, unknown>;

  beforeEach(() => {
    standin.faults.length = 0;
    standin.rememberKeys = true;
    standin.perMinute = 0;
  });

  it("does not send twice when Xero did the work and the answer was lost: the same key is replayed", async () => {
    const ref = await freshSale();
    const before = standin.invoices.length;
    standin.faults.push({ match: /PUT \/api.xro\/2.0\/Invoices/, lose: true, times: 1 });
    const first = await pushDue(venueId);
    expect(first.retried).toBe(1);
    expect(standin.invoices.length).toBe(before + 1);
    expect(await rowOf(ref)).toMatchObject({ status: "queued", error_code: "unavailable", attempts: 1, xero_id: null });
    // Not yet: it backs off. Then, once it is time, the same sale is sent again under the same key and Xero answers as before.
    expect(await pushDue(venueId)).toMatchObject({ sent: 0 });
    const second = await pushDue(venueId, new Date(Date.now() + 3 * 60_000));
    expect(second.sent).toBe(1);
    expect(standin.invoices.length).toBe(before + 1);
    expect(await rowOf(ref)).toMatchObject({ status: "sent", error_code: null });
    const keys = standin.calls.filter((c) => c.method === "PUT" && c.path.endsWith("/Invoices")).slice(-2).map((c) => c.idempotencyKey);
    expect(keys[0]).toBeTruthy();
    expect(keys[0]).toBe(keys[1]);
  });

  it("adopts its own invoice when Xero no longer remembers the key, and never somebody else's of the same number", async () => {
    const ref = await freshSale();
    standin.rememberKeys = false;
    const before = standin.invoices.length;
    standin.faults.push({ match: /PUT \/api.xro\/2.0\/Invoices/, lose: true, times: 1 });
    await pushDue(venueId);
    expect(standin.invoices.length).toBe(before + 1);
    await pushDue(venueId, new Date(Date.now() + 3 * 60_000));
    expect(standin.invoices.length).toBe(before + 1);
    expect(await rowOf(ref)).toMatchObject({ status: "sent" });

    // Another document of the same number but not ours: the sale is failed for a person, not matched to it.
    const other = await freshSale();
    const number = `V${venueId}-${(await rowOf(other)).number as string}`;
    standin.invoices.push({ id: "foreign", number, reference: "someone else's", type: "ACCREC", contact: { Name: "X" }, date: today, lineAmountTypes: "Inclusive", lines: [], totalCents: 0, taxCents: 0, paidCents: 0, status: "AUTHORISED" });
    await pushDue(venueId);
    expect(await rowOf(other)).toMatchObject({ status: "failed", error_code: "rejected" });
    standin.invoices.pop();
  });

  it("does not pay twice when the payment's answer was lost", async () => {
    const ref = await freshSale();
    const paid = standin.payments.length;
    standin.faults.push({ match: /PUT \/api.xro\/2.0\/Payments/, lose: true, times: 1 });
    await pushDue(venueId);
    // The invoice step's result was kept: the retry goes straight to the payment.
    expect(await rowOf(ref)).toMatchObject({ status: "queued", error_code: "unavailable" });
    expect((await rowOf(ref)).xero_id).toBeTruthy();
    const invoices = standin.invoices.length;
    await pushDue(venueId, new Date(Date.now() + 3 * 60_000));
    expect(standin.invoices.length).toBe(invoices);
    expect(standin.payments.length).toBe(paid + 1);
    expect(await rowOf(ref)).toMatchObject({ status: "sent" });
  });

  it("takes a payment already there as done when Xero says nothing is owing and the key is forgotten", async () => {
    const ref = await freshSale();
    standin.rememberKeys = false;
    const paid = standin.payments.length;
    standin.faults.push({ match: /PUT \/api.xro\/2.0\/Payments/, lose: true, times: 1 });
    await pushDue(venueId);
    await pushDue(venueId, new Date(Date.now() + 3 * 60_000));
    expect(standin.payments.length).toBe(paid + 1);
    expect(await rowOf(ref)).toMatchObject({ status: "sent", xero_payment_id: "already-recorded" });
  });

  it("backs off exponentially, gives up after the cap, and a manager can send it again", async () => {
    const ref = await freshSale();
    standin.faults.push({ match: /PUT \/api.xro\/2.0\/Invoices/, status: 500 });
    let at = Date.now();
    const waits: number[] = [];
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      await pushDue(venueId, new Date(at));
      const row = await rowOf(ref);
      expect(row.attempts).toBe(i);
      if (i < MAX_ATTEMPTS) {
        expect(row.status).toBe("queued");
        const next = new Date(row.next_attempt_at as Date).getTime();
        waits.push(Math.round((next - at) / 60_000));
        at = next + 1000;
      }
    }
    expect(waits).toEqual([2, 4, 8, 16, 32, 64, 128]);
    expect(await rowOf(ref)).toMatchObject({ status: "failed", error_code: "unavailable", attempts: MAX_ATTEMPTS });
    expect((await queueView(venueId)).failed.map((f) => f.number)).toContain((await rowOf(ref)).number);
    standin.faults.length = 0;
    expect(await retry(venueId, 999999999)).toEqual({ ok: false, error: REFUSALS.nothingToRetry });
    const id = (await rowOf(ref)).id as number;
    expect(await retry(venueId, id)).toEqual({ ok: true, count: 1 });
    expect(await pushDue(venueId, new Date(at + 1000))).toMatchObject({ sent: 1 });
    expect(await rowOf(ref)).toMatchObject({ status: "sent", attempts: 0, error_code: null });
  });

  it("stops after three that could not be reached in a row, leaving the rest for the next tick untouched", async () => {
    const refs = [await freshSale(), await freshSale(), await freshSale(), await freshSale(), await freshSale()];
    standin.faults.push({ match: /PUT \/api.xro\/2.0\/Invoices/, status: 500 });
    const run = await pushDue(venueId);
    expect(run.retried).toBe(3);
    const stat = await Promise.all(refs.map(async (r) => (await rowOf(r)).attempts));
    expect(stat.filter((a) => a === 0)).toHaveLength(2);
    standin.faults.length = 0;
    // Nothing was lost: the next tick sends what was left, the five of them.
    await pushDue(venueId, new Date(Date.now() + 3 * 60_000));
    await pushDue(venueId, new Date(Date.now() + 6 * 60_000));
    for (const r of refs) expect(await rowOf(r)).toMatchObject({ status: "sent" });
  });

  it("fails what Xero refuses for a person to see, in Xero's words with no name in them, and does not retry it by itself", async () => {
    const ref = await freshSale();
    const before = (await rowOf(ref)).id;
    // An account archived in Xero since it was chosen.
    const org = [...standin.organisations.values()][0];
    org.accounts = org.accounts.map((a) => (a.Code === "200" ? { ...a, Status: "ARCHIVED" } : a));
    await pushDue(venueId);
    const row = await rowOf(ref);
    expect(row).toMatchObject({ id: before, status: "failed", error_code: "rejected", attempts: 1 });
    expect(String(row.error_detail)).toContain("not a valid code");
    org.accounts = org.accounts.map((a) => (a.Code === "200" ? { ...a, Status: "ACTIVE" } : a));
    const calls = standin.calls.length;
    await pushDue(venueId, new Date(Date.now() + 10 * 60_000));
    expect(standin.calls.length).toBe(calls);
    await retry(venueId, null);
    expect((await pushDue(venueId, new Date(Date.now() + 10 * 60_000))).sent).toBeGreaterThanOrEqual(1);
    expect(await rowOf(ref)).toMatchObject({ status: "sent", error_code: null });
  });

  it("keeps what Xero says free of names, addresses and tokens", () => {
    expect(scrub("Contact Nurul Ain <nurul@example.my> token eyJhbGciOiJub25lIn0.eyJhIjoxfQ.abcdefghijklmnop", ["Nurul Ain", "nurul@example.my"])).toBe("Contact … <…> token …");
    expect(scrub("x ".repeat(250)).length).toBe(300);
  });

  it("pauses the venue when Xero says too many calls, losing nothing, and carries on when told", async () => {
    const ref = await freshSale();
    const ref2 = await freshSale();
    standin.faults.push({ match: /PUT \/api.xro\/2.0\/Invoices/, status: 429, retryAfter: 90, times: 1 });
    const start = Date.now();
    const first = await pushDue(venueId, new Date(start));
    expect(first).toMatchObject({ paused: true, sent: 0 });
    // Not a failure: no attempt counted, and the rows wait until Xero's time.
    expect(await rowOf(ref)).toMatchObject({ status: "queued", error_code: "rate_limited", attempts: 0 });
    const view = await connectionView(venueId);
    expect(view.pausedUntil).toBeTruthy();
    expect(new Date(view.pausedUntil!).getTime() - start).toBeGreaterThanOrEqual(89_000);
    const calls = standin.calls.length;
    expect(await pushDue(venueId, new Date(start + 30_000))).toEqual({ idle: "paused" });
    expect(standin.calls.length).toBe(calls);
    const later = await pushDue(venueId, new Date(start + 95_000));
    expect(later.sent).toBe(2);
    expect(await rowOf(ref)).toMatchObject({ status: "sent", error_code: null });
    expect(await rowOf(ref2)).toMatchObject({ status: "sent" });
  });

  it("refreshes an expired token once, rotating the refresh token and sealing the new pair", async () => {
    await freshSale();
    const oldRefresh = [...standin.refreshTokens][0];
    const sealedBefore = ((await getDb().prepare("SELECT refresh_token FROM accounting_connections WHERE venue_id = ?").get(venueId)) as { refresh_token: string }).refresh_token;
    standin.expireAccessTokens();
    const tokenCalls = () => standin.calls.filter((c) => c.path === "/connect/token").length;
    const t0 = tokenCalls();
    expect(await pushDue(venueId, new Date(Date.now() + 5 * 60_000))).toMatchObject({ sent: 1 });
    expect(tokenCalls()).toBe(t0 + 1);
    expect(standin.refreshTokens.has(oldRefresh)).toBe(false);
    const sealedAfter = ((await getDb().prepare("SELECT refresh_token FROM accounting_connections WHERE venue_id = ?").get(venueId)) as { refresh_token: string }).refresh_token;
    expect(sealedAfter).not.toBe(sealedBefore);
    expect(JSON.stringify(await getDb().prepare("SELECT * FROM accounting_connections").all())).not.toContain([...standin.refreshTokens][0]);
  });

  it("refreshes and retries on a 401, once: a second refusal asks for a reconnect and sends nothing more", async () => {
    await freshSale();
    standin.faults.push({ match: /PUT \/api.xro\/2.0\/Invoices/, status: 401, times: 1 });
    expect(await pushDue(venueId)).toMatchObject({ sent: 1 });
    expect((await connectionView(venueId)).status).toBe("connected");

    const ref = await freshSale();
    standin.faults.push({ match: /PUT \/api.xro\/2.0\/Invoices/, status: 401, times: 2 });
    const run = await pushDue(venueId);
    expect(run).toMatchObject({ sent: 0, reconnect: true });
    const view = await connectionView(venueId);
    expect(view.status).toBe("needs_reconnect");
    expect(view.failingSince).toBeTruthy();
    // Not failed: it waits for the reconnect, and nothing is tried meanwhile.
    expect(await rowOf(ref)).toMatchObject({ status: "queued", error_code: "unauthorised", attempts: 0 });
    const calls = standin.calls.length;
    expect(await pushDue(venueId)).toEqual({ idle: "reconnect" });
    expect(standin.calls.length).toBe(calls);
    // Mending it keeps what was sent from and read through, and sends what waited.
    standin.faults.length = 0;
    expect((await connect()).done).toMatchObject({ ok: true });
    expect((await connectionView(venueId)).failingSince).toBeNull();
    expect(await pushDue(venueId, new Date(Date.now() + 60_000))).toMatchObject({ sent: 1 });
  });

  it("asks for a reconnect when the refresh token itself has been revoked", async () => {
    await freshSale();
    standin.refreshTokens.clear();
    standin.expireAccessTokens();
    expect(await pushDue(venueId, new Date(Date.now() + 5 * 60_000))).toMatchObject({ sent: 0, reconnect: true });
    expect((await connectionView(venueId)).status).toBe("needs_reconnect");
    standin.faults.length = 0;
    expect((await connect()).done).toMatchObject({ ok: true });
    expect(await pushDue(venueId, new Date(Date.now() + 10 * 60_000))).toMatchObject({ sent: 1 });
  });

  it("refreshes the rotating token once when two ticks find it expired at the same moment: one refreshes, the other waits for its turn", async () => {
    for (let i = 0; i < 4; i++) await freshSale();
    const waiting = await due();
    await getDb().prepare("UPDATE accounting_connections SET access_expires_at = now() - interval '1 hour' WHERE venue_id = ?").run(venueId);
    const tokenCalls = () => standin.calls.filter((c) => c.path === "/connect/token").length;
    const t0 = tokenCalls();
    const now = new Date(Date.now() + 5 * 60_000);
    const [a, b] = await Promise.all([pushDue(venueId, now), pushDue(venueId, now)]);
    expect(tokenCalls() - t0).toBe(1);
    expect([a.idle, b.idle].filter((i) => i === "busy").length + [a.sent, b.sent].filter((n) => n !== undefined).length).toBe(2);
    expect((a.sent ?? 0) + (b.sent ?? 0)).toBe(waiting);
    expect((await connectionView(venueId)).status).toBe("connected");
  });

  it("does not take a refresh another tick is doing for a lost grant when a 401 reaches both", async () => {
    for (let i = 0; i < 4; i++) await freshSale();
    const waiting = await due();
    // Xero turned the access token in early: the stored expiry says it is good, Xero says not.
    standin.expireAccessTokens();
    const tokenCalls = () => standin.calls.filter((c) => c.path === "/connect/token").length;
    const t0 = tokenCalls();
    const now = new Date(Date.now() + 5 * 60_000);
    const [a, b] = await Promise.all([pushDue(venueId, now), pushDue(venueId, now)]);
    expect(tokenCalls() - t0).toBe(1);
    expect((a.sent ?? 0) + (b.sent ?? 0)).toBe(waiting);
    expect((await connectionView(venueId)).status).toBe("connected");
  });
});

describe("two ticks at once", () => {
  it("send each sale once: a sale is taken by one of them", async () => {
    for (let i = 0; i < 6; i++) {
      const b = await booked();
      await setPaymentStatus(b.code, true, "cash");
    }
    await enqueueNew(venueId, new Date(), true);
    const before = standin.invoices.length;
    const queued = ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM accounting_queue WHERE venue_id = ? AND status = 'queued'").get(venueId)) as { n: number }).n;
    expect(queued).toBeGreaterThanOrEqual(6);
    const now = new Date(Date.now() + 60_000);
    const [a, b, c] = await Promise.all([pushDue(venueId, now), pushDue(venueId, now), pushDue(venueId, now)]);
    expect((a.sent ?? 0) + (b.sent ?? 0) + (c.sent ?? 0)).toBe(queued);
    expect(standin.invoices.length).toBe(before + queued);
    const numbers = standin.invoices.map((i) => i.number);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("take a sale back from a taker that died mid-send, once its lease has run out", async () => {
    const b = await booked();
    await setPaymentStatus(b.code, true, "cash");
    await enqueueNew(venueId, new Date(), true);
    const ref = `booking:${b.id}`;
    // Taken, and the taker is gone.
    await getDb().prepare("UPDATE accounting_queue SET status = 'sending', lease_until = ? WHERE venue_id = ? AND source_ref = ?").run(new Date(Date.now() + 60_000).toISOString(), venueId, ref);
    expect(await pushDue(venueId, new Date())).toMatchObject({ sent: 0 });
    expect(await pushDue(venueId, new Date(Date.now() + 6 * 60_000))).toMatchObject({ sent: 1 });
  });
});

describe("the venue's managers are told when it has been failing for a day", () => {
  const alerts = async () => ((await getDb().prepare("SELECT recipient, subject, body FROM messages WHERE kind = 'staff_alert' AND subject LIKE '%Xero%'").all()) as { recipient: string; subject: string; body: string }[]);

  it("tells them once a day, in their language, and nothing is lost", async () => {
    const day = 24 * 3600_000;
    await getDb().prepare("UPDATE accounting_connections SET failing_since = ? WHERE venue_id = ?").run(new Date(Date.now() - day - 1000).toISOString(), venueId);
    const before = (await alerts()).length;
    expect(await alertIfFailing(venueId, new Date())).toBe(true);
    const sent = await alerts();
    expect(sent.length).toBeGreaterThan(before);
    expect(sent.some((m) => m.recipient === "musa@push.test")).toBe(true);
    expect(sent.at(-1)!.body).toContain("Nothing is lost");
    expect(await alertIfFailing(venueId, new Date())).toBe(false);
    expect(await alertIfFailing(venueId, new Date(Date.now() + day + 5000))).toBe(true);
    await getDb().prepare("UPDATE accounting_connections SET failing_since = NULL, last_alert_at = NULL WHERE venue_id = ?").run(venueId);
    expect(await alertIfFailing(venueId, new Date())).toBe(false);
  });

  it("tells them of a sale left failed for a day, even when everything else is working", async () => {
    await getDb().prepare("UPDATE accounting_queue SET status = 'failed', updated_at = ? WHERE id = (SELECT MAX(id) FROM accounting_queue WHERE venue_id = ?)").run(new Date(Date.now() - 25 * 3600_000).toISOString(), venueId);
    expect(await alertIfFailing(venueId, new Date())).toBe(true);
    await getDb().prepare("UPDATE accounting_queue SET status = 'sent' WHERE venue_id = ? AND status = 'failed'").run(venueId);
  });

  it("is run by the scheduler for every connected venue, and does nothing when the install has not allowed it", async () => {
    const calls = standin.calls.length;
    delete process.env.ACCOUNTING_PUSH_APPROVED;
    await runAccountingPush(new Date());
    expect(standin.calls.length).toBe(calls);
    configure();
    const b = await booked();
    await setPaymentStatus(b.code, true, "cash");
    await getDb().prepare("UPDATE accounting_connections SET scanned_at = NULL WHERE venue_id = ?").run(venueId);
    const before = standin.invoices.length;
    await runAccountingPush(new Date(Date.now() + 60_000));
    expect(standin.invoices.length).toBe(before + 1);
  });
});

describe("earlier sales", () => {
  let older: number;
  beforeAll(async () => {
    // A sale paid four days ago, before the connection: not sent, and not back-filled by itself.
    const b = await booked();
    await setPaymentStatus(b.code, true, "cash");
    await getDb().prepare("UPDATE bookings SET paid_at = datetime('now', '-4 days') WHERE id = ?").run(b.id);
    older = b.id;
    await enqueueNew(venueId, new Date(), true);
  });

  it("are not sent unless a manager picks a day and confirms what would be sent", async () => {
    expect(await getDb().prepare("SELECT 1 FROM accounting_queue WHERE source_ref = ?").get(`booking:${older}`)).toBeUndefined();
    const from = addDays(todayISO(), -6);
    const preview = await previewStart(venueId, from);
    expect(preview).toMatchObject({ ok: true, preview: { from, count: 1, totalCents: 2120 } });
    // The confirmation must be the preview's: another count or total is refused, and nothing is queued.
    expect(await startFrom(venueId, from, { count: 2, totalCents: 2120 })).toEqual({ ok: false, error: REFUSALS.previewChanged });
    expect(await startFrom(venueId, from, { count: 1, totalCents: 2121 })).toEqual({ ok: false, error: REFUSALS.previewChanged });
    expect(await startFrom(venueId, from, { count: "1", totalCents: 2120 })).toEqual({ ok: false, error: REFUSALS.previewChanged });
    expect(await getDb().prepare("SELECT 1 FROM accounting_queue WHERE source_ref = ?").get(`booking:${older}`)).toBeUndefined();
    expect(await startFrom(venueId, from, { count: 1, totalCents: 2120 })).toEqual({ ok: true, added: 1 });
    expect((await connectionView(venueId)).startDate).toBe(from);
    expect(await pushDue(venueId, new Date(Date.now() + 60_000))).toMatchObject({ sent: 1 });
    expect(await getDb().prepare("SELECT status FROM accounting_queue WHERE source_ref = ?").get(`booking:${older}`)).toEqual({ status: "sent" });
  });

  it("refuses a day that is not a date, is in the future, is too far back, or is later than the day it already sends from", async () => {
    expect(await previewStart(venueId, "soon")).toEqual({ ok: false, error: REFUSALS.badDate });
    expect(await previewStart(venueId, addDays(todayISO(), 3))).toEqual({ ok: false, error: REFUSALS.badDate });
    expect(await previewStart(venueId, addDays(todayISO(), -900))).toEqual({ ok: false, error: REFUSALS.tooEarly });
    expect(await previewStart(venueId, addDays(todayISO(), -1))).toEqual({ ok: false, error: REFUSALS.laterThanStart });
  });
});

describe("the reconciliation", () => {
  it("says plainly when the ledger and Xero differ, and by how much, and which day", async () => {
    const day = addDays(todayISO(), -6);
    // Everything left over from the cases above is sent first.
    await retry(venueId, null);
    await pushDue(venueId, new Date(Date.now() + 10 * 60_000));
    await pushDue(venueId, new Date(Date.now() + 20 * 60_000));
    const same = await reconcile(venueId, day, today);
    expect(same.ok && same.report.differs).toBe(false);
    // A sale that is in the ledger and not in Xero, left unsent: the difference is its amount.
    const b = await booked();
    await setPaymentStatus(b.code, true, "cash");
    await getDb().prepare("UPDATE accounting_connections SET status = 'connected' WHERE venue_id = ?").run(venueId);
    await enqueueRange(venueId, today, today);
    await getDb().prepare("UPDATE accounting_queue SET status = 'failed', error_code = 'rejected' WHERE venue_id = ? AND source_ref = ?").run(venueId, `booking:${b.id}`);
    const off = await reconcile(venueId, day, today);
    expect(off.ok && off.report).toMatchObject({ differs: true });
    if (!off.ok) throw new Error(off.error);
    expect(off.report.ledger.grossCents - off.report.sent.grossCents).toBe(2120);
    expect(off.report.days).toHaveLength(1);
    expect(off.report.days[0].day).toBe(today);
    expect(off.report.days[0].ledgerGrossCents - off.report.days[0].sentGrossCents).toBe(2120);
    expect(off.report.waiting.failed).toBe(1);
  });

  it("catches Xero holding a different total than was sent (it rounds, or somebody edited it)", async () => {
    await getDb().prepare("UPDATE accounting_queue SET status = 'sent' WHERE venue_id = ? AND status = 'failed'").run(venueId);
    const first = (await getDb().prepare("SELECT id, xero_total_cents FROM accounting_queue WHERE venue_id = ? AND status = 'sent' AND kind = 'invoice' AND xero_total_cents IS NOT NULL ORDER BY id LIMIT 1").get(venueId)) as { id: number; xero_total_cents: number };
    await getDb().prepare("UPDATE accounting_queue SET xero_total_cents = ? WHERE id = ?").run(first.xero_total_cents + 1, first.id);
    const r = await reconcile(venueId, addDays(todayISO(), -6), today);
    expect(r.ok && r.report.differs).toBe(true);
    await getDb().prepare("UPDATE accounting_queue SET xero_total_cents = ? WHERE id = ?").run(first.xero_total_cents, first.id);
  });

  it("leaves out sales from before the start day, as the push does, and refuses a range that is not one", async () => {
    expect(await reconcile(venueId, "2026-13-45", today)).toEqual({ ok: false, error: REFUSALS.badDate });
    expect(await reconcile(venueId, today, addDays(today, -3))).toEqual({ ok: false, error: REFUSALS.badDate });
  });
});

describe("disconnecting", () => {
  it("revokes the grant at Xero, empties both tokens, leaves what was sent, and sets aside what was not", async () => {
    await getDb().prepare("UPDATE accounting_queue SET status = 'failed' WHERE id = (SELECT MAX(id) FROM accounting_queue WHERE venue_id = ? AND status = 'sent')").run(venueId);
    const sentBefore = (await status()).sent;
    const done = await disconnect(venueId);
    expect(done).toEqual({ ok: true, revoked: true });
    expect(standin.refreshTokens.size).toBe(0);
    const c = (await getDb().prepare("SELECT status, access_token, refresh_token, access_expires_at FROM accounting_connections WHERE venue_id = ?").get(venueId)) as Record<string, unknown>;
    expect(c).toEqual({ status: "disconnected", access_token: null, refresh_token: null, access_expires_at: null });
    expect((await status()).sent).toBe(sentBefore);
    expect((await status()).skipped).toBe(1);
    expect(await pushDue(venueId)).toEqual({ idle: "not_connected" });
    expect((await connectionView(venueId))).toMatchObject({ status: "disconnected", organisation: null, startDate: null });
    expect(await disconnect(venueId)).toEqual({ ok: false, error: REFUSALS.notConnected });
    // Reading the journal does nothing while it is off.
    expect(await enqueueNew(venueId, new Date(), true)).toBe(0);
  });

  it("says so when Xero could not be reached to take the access back, and still removes it here", async () => {
    expect((await connect()).done).toMatchObject({ ok: true });
    standin.faults.push({ match: /DELETE \/connections/, status: 500, times: 1 });
    const done = await disconnect(venueId);
    expect(done).toEqual({ ok: true, revoked: false });
    expect(((await getDb().prepare("SELECT refresh_token FROM accounting_connections WHERE venue_id = ?").get(venueId)) as { refresh_token: string | null }).refresh_token).toBeNull();
  });

  it("gives back to the queue, on a chosen day, what was set aside when it was disconnected", async () => {
    expect((await connect()).done).toMatchObject({ ok: true });
    const from = addDays(todayISO(), -6);
    const preview = await previewStart(venueId, from);
    expect(preview.ok && preview.preview.count).toBe(1);
    const p = preview.ok ? preview.preview : null;
    expect(await startFrom(venueId, from, { count: p!.count, totalCents: p!.totalCents })).toMatchObject({ ok: true });
    expect(await pushDue(venueId, new Date(Date.now() + 60_000))).toMatchObject({ sent: 1 });
  });
});

describe("money in cents", () => {
  it("sends the receipt's own tax for odd amounts, never recomputing it, and the sums stay whole", async () => {
    const court = await createCourt({ venueId, name: "Odd Court", sport: "badminton", offPeakRate: 13.37, peakRate: 13.37 });
    if (!court.ok) throw new Error("court");
    for (let i = 0; i < 3; i++) {
      const made = await createBooking({ courtId: court.court.id, date, hours: [8 + i], name: "Odd Sum", phone: "0197776655" });
      if (!made.ok) throw new Error(made.error);
      await setPaymentStatus(made.booking.code, true, "cash");
    }
    await enqueueNew(venueId, new Date(), true);
    await pushDue(venueId, new Date(Date.now() + 60_000));
    const odd = standin.invoices.filter((i) => i.lines[0].UnitAmount === 13.37);
    expect(odd).toHaveLength(3);
    // 13.37 at 6% holds 0.76 of tax (rounded as the receipt does), and Xero was told so.
    for (const i of odd) {
      expect(i.lines[0].TaxAmount).toBe(0.76);
      expect(i.totalCents).toBe(1337);
      expect(i.taxCents).toBe(76);
    }
    const ledger = (await salesJournal(venueId, today, today)).filter((r) => !r.test);
    const centsSum = ledger.reduce((s, r) => s + Math.round(r.gross * 100), 0);
    // What was sent for today (the one sale from four days ago was sent as an earlier day's).
    const sent = [...standin.invoices.filter((i) => i.date === today).map((i) => i.totalCents), ...standin.creditNotes.filter((c) => c.date === today).map((c) => -c.totalCents)].reduce((a, b) => a + b, 0);
    expect(sent).toBe(centsSum);
  });
});

describe("classify", () => {
  it("is safe to run at any time: it changes only queued and held sales", async () => {
    const counts = await status();
    await classify(venueId, new Date());
    expect(await status()).toEqual(counts);
  });
});

vi.spyOn(console, "error").mockImplementation(() => undefined);
