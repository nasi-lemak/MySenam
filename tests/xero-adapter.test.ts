import crypto from "crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ProviderError } from "../src/lib/accounting-provider";
import { xero, xeroScopes } from "../src/lib/xero";
import { startXeroStandin, type Standin } from "./helpers/xero-standin";

/**
 * The Xero adapter (lib/xero.ts) on its own, against the stand-in: the sign-in's address, the token calls, what each kind of
 * answer becomes (a limit, a bad token, a refusal, a duplicate, an outage), what is created and how (only ever created,
 * never edited), and that nothing a caller could show holds a token. It proves what the adapter does with an API of this
 * shape; whether Xero answers so is for scripts/verify-xero.mjs against a demo company.
 */

let s: Standin;
let tokens: Awaited<ReturnType<typeof xero.exchangeCode>>;
let session: { accessToken: string; tenantId: string };
const verifier = crypto.randomBytes(48).toString("base64url");
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");

const doc = (number: string) => ({
  number,
  reference: `ref ${number}`,
  date: "2026-11-05",
  contact: { name: "Walk-in customers", email: null },
  lines: [{ description: "Court hire", grossCents: 2120, taxCents: 120, accountCode: "200", taxType: "SV6" }],
});

beforeAll(async () => {
  s = await startXeroStandin();
  process.env.XERO_CLIENT_ID = s.clientId;
  process.env.XERO_CLIENT_SECRET = s.clientSecret;
  process.env.XERO_REDIRECT_URI = "https://app.example.test/callback";
  process.env.XERO_API_URL = s.url;
  process.env.XERO_IDENTITY_URL = s.url;
  const url = xero.authorizeUrl({ state: "st", challenge });
  const code = s.consent(url, [[...s.organisations.keys()][0]]);
  tokens = await xero.exchangeCode({ code, verifier });
  const orgs = await xero.organisations(tokens.accessToken);
  session = { accessToken: tokens.accessToken, tenantId: orgs[0].tenantId };
});
afterAll(async () => {
  await s.close();
});
beforeEach(() => {
  s.faults.length = 0;
});

const kind = async (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof ProviderError ? e.kind : `other: ${e}`));

describe("signing in", () => {
  it("is configured only with the app's id, secret and redirect address", () => {
    expect(xero.configured()).toBe(true);
    const secret = process.env.XERO_CLIENT_SECRET;
    delete process.env.XERO_CLIENT_SECRET;
    expect(xero.configured()).toBe(false);
    process.env.XERO_CLIENT_SECRET = secret;
  });

  it("asks only for what it uses, with PKCE and a state, and an older app can name the scopes it was given", () => {
    const url = new URL(xero.authorizeUrl({ state: "abc", challenge: "xyz" }));
    expect(url.searchParams.get("scope")!.split(" ").sort()).toEqual(["accounting.contacts", "accounting.invoices", "accounting.payments", "accounting.settings.read", "offline_access"]);
    expect(url.searchParams.get("state")).toBe("abc");
    expect(url.searchParams.get("code_challenge")).toBe("xyz");
    expect(url.toString()).not.toContain(s.clientSecret);
    process.env.XERO_SCOPES = "offline_access accounting.transactions accounting.settings.read";
    expect(xeroScopes()).toBe("offline_access accounting.transactions accounting.settings.read");
    expect(new URL(xero.authorizeUrl({ state: "a", challenge: "b" })).searchParams.get("scope")).toBe("offline_access accounting.transactions accounting.settings.read");
    delete process.env.XERO_SCOPES;
  });

  it("trades a code once, only with the verifier it began with", async () => {
    const url = xero.authorizeUrl({ state: "s2", challenge });
    const code = s.consent(url, [[...s.organisations.keys()][0]]);
    expect(await kind(xero.exchangeCode({ code, verifier: "another verifier altogether" }))).toBe("unauthorised");
    const again = s.consent(url, [[...s.organisations.keys()][0]]);
    const ok = await xero.exchangeCode({ code: again, verifier });
    expect(ok.accessToken).toBeTruthy();
    expect(ok.expiresInSeconds).toBe(1800);
    expect(await kind(xero.exchangeCode({ code: again, verifier }))).toBe("unauthorised");
  });

  it("rotates the refresh token: the new one works, the old one is spent", async () => {
    const fresh = await xero.refresh(tokens.refreshToken);
    expect(fresh.refreshToken).not.toBe(tokens.refreshToken);
    expect(await kind(xero.refresh(tokens.refreshToken))).toBe("unauthorised");
    tokens = fresh;
    session = { ...session, accessToken: fresh.accessToken };
  });

  it("lists only the organisations the sign-in chose, and reads its name, currency and whether it is a demo company", async () => {
    const orgs = await xero.organisations(tokens.accessToken);
    expect(orgs).toHaveLength(1);
    expect(orgs[0].name).toBe("Demo Company (MY)");
    expect(await xero.organisation({ accessToken: tokens.accessToken, tenantId: orgs[0].tenantId })).toEqual({ name: "Demo Company (MY)", currency: "MYR", isDemo: true });
  });

  it("gives the grant up, and an organisation's connection with it, never throwing", async () => {
    const url = xero.authorizeUrl({ state: "s3", challenge });
    const code = s.consent(url, [[...s.organisations.keys()][0]]);
    const t = await xero.exchangeCode({ code, verifier });
    const [org] = await xero.organisations(t.accessToken);
    expect(await xero.revoke({ refreshToken: t.refreshToken, accessToken: t.accessToken, connectionId: org.connectionId })).toBe(true);
    expect(s.refreshTokens.has(t.refreshToken)).toBe(false);
    expect(await kind(xero.refresh(t.refreshToken))).toBe("unauthorised");
    // Said false, not thrown, when Xero cannot be reached.
    const was = process.env.XERO_IDENTITY_URL;
    process.env.XERO_IDENTITY_URL = "http://127.0.0.1:1";
    expect(await xero.revoke({ refreshToken: t.refreshToken, accessToken: null, connectionId: null })).toBe(false);
    process.env.XERO_IDENTITY_URL = was;
  });
});

describe("what each answer becomes", () => {
  it("a limit is a pause for as long as Xero says", async () => {
    s.faults.push({ match: /Organisation/, status: 429, retryAfter: 37, times: 1 });
    const err = await xero.organisation(session).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ kind: "rate_limited", retryAfterSeconds: 37 });
  });

  it("a bad or expired token, and a forbidden call, ask for the access to be renewed", async () => {
    expect(await kind(xero.organisation({ ...session, accessToken: "an-expired-token" }))).toBe("unauthorised");
    s.faults.push({ match: /Accounts/, status: 403, times: 1 });
    expect(await kind(xero.chart(session))).toBe("unauthorised");
  });

  it("an outage is worth trying again, and says nothing of where it was", async () => {
    s.faults.push({ match: /Organisation/, status: 500, times: 1 });
    expect(await kind(xero.organisation(session))).toBe("unavailable");
    const was = process.env.XERO_API_URL;
    process.env.XERO_API_URL = "http://127.0.0.1:1";
    const err = await xero.organisation(session).catch((e) => e);
    expect(err).toMatchObject({ kind: "unavailable", message: "Xero could not be reached." });
    expect(String(err.message)).not.toContain("127.0.0.1");
    process.env.XERO_API_URL = was;
  });

  it("a refusal carries Xero's own words, and one that names an existing number is a duplicate", async () => {
    const bad = { ...doc("V1-R-1"), lines: [{ ...doc("x").lines[0], accountCode: "404" }] };
    const err = await xero.createInvoice(session, bad, "key-1").catch((e) => e);
    expect(err).toMatchObject({ kind: "rejected" });
    expect(err.message).toContain("not a valid code");
    const noTax = { ...doc("V1-R-2"), lines: [{ ...doc("x").lines[0], taxType: "NOPE" }] };
    expect((await xero.createInvoice(session, noTax, "key-2").catch((e) => e)).message).toContain("not valid");
    await xero.createInvoice(session, doc("V1-R-3"), "key-3");
    expect(await kind(xero.createInvoice(session, doc("V1-R-3"), "key-3b"))).toBe("duplicate");
  });

  it("never carries a token or the client secret in what it says", async () => {
    const errors = [
      await xero.organisation({ ...session, accessToken: "token-that-must-not-show-up" }).catch((e) => e),
      await xero.refresh("refresh-that-must-not-show-up").catch((e) => e),
    ];
    for (const e of errors) {
      expect(e.message).not.toContain("must-not-show-up");
      expect(e.message).not.toContain(s.clientSecret);
    }
  });
});

describe("what it creates", () => {
  it("only ever creates (PUT), under an idempotency key, with the tax inside and as the receipt computed it", async () => {
    const before = s.calls.length;
    const sent = await xero.createInvoice(session, doc("V1-R-10"), "k-10");
    expect(sent).toMatchObject({ number: "V1-R-10", totalCents: 2120, taxCents: 120 });
    const call = s.calls.slice(before).find((c) => c.path.endsWith("/Invoices"))!;
    expect(call).toMatchObject({ method: "PUT", idempotencyKey: "k-10", bearer: true, tenant: session.tenantId });
    const stored = s.invoices.find((i) => i.number === "V1-R-10")!;
    expect(stored).toMatchObject({ type: "ACCREC", status: "AUTHORISED", lineAmountTypes: "Inclusive" });
    expect(stored.lines[0]).toMatchObject({ Quantity: 1, UnitAmount: 21.2, TaxAmount: 1.2, AccountCode: "200", TaxType: "SV6" });
    expect(stored.contact).toEqual({ Name: "Walk-in customers" });
    expect(s.calls.filter((c) => c.method === "POST" && c.path.includes("/api.xro/"))).toHaveLength(0);
  });

  it("replays an idempotent call as the same document", async () => {
    const a = await xero.createInvoice(session, doc("V1-R-11"), "k-11");
    const b = await xero.createInvoice(session, doc("V1-R-11"), "k-11");
    expect(b.id).toBe(a.id);
    expect(s.invoices.filter((i) => i.number === "V1-R-11")).toHaveLength(1);
  });

  it("sends the contact's email only when there is one", async () => {
    await xero.createInvoice(session, { ...doc("V1-R-12"), contact: { name: "Nurul Ain", email: "nurul@example.my" } }, "k-12");
    expect(s.invoices.find((i) => i.number === "V1-R-12")!.contact).toEqual({ Name: "Nurul Ain", EmailAddress: "nurul@example.my" });
  });

  it("records a payment against an invoice and a refund against a credit note, and reads each as settled", async () => {
    const invoice = await xero.createInvoice(session, doc("V1-R-13"), "k-13");
    expect((await xero.invoiceState(session, invoice.id)).settled).toBe(false);
    await xero.createPayment(session, { documentId: invoice.id, accountCode: "090", date: "2026-11-05", amountCents: 2120, reference: "ref" }, "p-13");
    expect((await xero.invoiceState(session, invoice.id)).settled).toBe(true);
    // Paid twice is refused: nothing is owing any more.
    expect(await kind(xero.createPayment(session, { documentId: invoice.id, accountCode: "090", date: "2026-11-05", amountCents: 2120, reference: "ref" }, "p-13b"))).toBe("rejected");
    const credit = await xero.createCreditNote(session, doc("V1-CN-13"), "c-13");
    expect(s.creditNotes.find((c) => c.id === credit.id)).toMatchObject({ type: "ACCRECCREDIT" });
    await xero.createRefund(session, { documentId: credit.id, accountCode: "090", date: "2026-11-05", amountCents: 2120, reference: "ref" }, "r-13");
    expect((await xero.creditNoteState(session, credit.id)).settled).toBe(true);
    expect(s.payments.find((p) => p.documentId === credit.id)).toMatchObject({ forCreditNote: true });
  });

  it("refuses a payment to an account that takes none", async () => {
    const invoice = await xero.createInvoice(session, doc("V1-R-14"), "k-14");
    expect(await kind(xero.createPayment(session, { documentId: invoice.id, accountCode: "200", date: "2026-11-05", amountCents: 100, reference: "r" }, "p-14"))).toBe("rejected");
  });

  it("finds a document by its number, with the reference it was made with", async () => {
    expect(await xero.findInvoice(session, "V1-R-10")).toMatchObject({ number: "V1-R-10", reference: "ref V1-R-10" });
    expect(await xero.findInvoice(session, "nothing-like-it")).toBeNull();
    expect(await xero.findCreditNote(session, "V1-CN-13")).toMatchObject({ reference: "ref V1-CN-13" });
  });
});

describe("the organisation's lists", () => {
  it("reads active accounts with their class and whether they take payments, and active tax rates with their rate", async () => {
    const chart = await xero.chart(session);
    expect(chart.accounts.find((a) => a.code === "999")).toBeUndefined();
    expect(chart.accounts.find((a) => a.code === "090")).toEqual({ code: "090", name: "Business Bank Account", type: "BANK", class: "ASSET", acceptsPayments: true });
    expect(chart.accounts.find((a) => a.code === "091")?.acceptsPayments).toBe(true);
    expect(chart.accounts.find((a) => a.code === "200")).toMatchObject({ class: "REVENUE", acceptsPayments: false });
    expect(chart.accounts.find((a) => a.code === "800")).toMatchObject({ class: "LIABILITY" });
    expect(chart.taxRates).toEqual(expect.arrayContaining([{ type: "SV6", name: "Service tax 6%", rate: 6 }, { type: "NONE", name: "No tax", rate: 0 }]));
  });
});
