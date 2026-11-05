import {
  ProviderError,
  type AccountingProvider,
  type ChartAccount,
  type ChartTaxRate,
  type DocumentLine,
  type DocumentToSend,
  type Organisation,
  type SentDocument,
  type Session,
  type Tokens,
} from "./accounting-provider.ts";

/**
 * Xero, as an accounting provider (lib/accounting-provider.ts; docs/integrations/xero.md).
 *
 * OAuth 2.0 authorization code with PKCE through the install's registered app (`XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`,
 * `XERO_REDIRECT_URI`), then the accounting API for one organisation: a sales invoice (authorised) and its payment, a
 * credit note and its refund, and a read of the chart of accounts and tax rates. Nothing is read back but those, and no
 * webhook is used.
 *
 * Written from Xero's published API; it has been exercised only against the stand-in in tests/helpers/xero-standin.ts.
 * It stays INTEGRATION_VERIFICATION_REQUIRED until `scripts/verify-xero.mjs` has passed against a Xero demo company
 * (docs/integrations/xero.md#verifying-against-a-demo-company).
 *
 * A token, a secret and a refresh token are only ever put in a request's headers or body, never in an error, a log or
 * anything returned to a caller.
 */

const LOGIN = "https://login.xero.com/identity/connect/authorize";
const API_VERSION = "api.xro/2.0";

/** Calls time out after this long: a push is background work, and a hung call must not hold a tick. */
const TIMEOUT_MS = 20_000;

const apiBase = () => (process.env.XERO_API_URL?.trim() || "https://api.xero.com").replace(/\/$/, "");
const identityBase = () => (process.env.XERO_IDENTITY_URL?.trim() || "https://identity.xero.com").replace(/\/$/, "");

/**
 * What the install asks Xero for. Xero's newer apps use narrow scopes (invoices, payments, contacts, settings read);
 * an older app may still hold the broad `accounting.transactions`: `XERO_SCOPES` names what that app was given.
 */
export function xeroScopes(): string {
  return process.env.XERO_SCOPES?.trim() || "offline_access accounting.invoices accounting.payments accounting.contacts accounting.settings.read";
}

const credentials = () => ({
  id: process.env.XERO_CLIENT_ID?.trim() ?? "",
  secret: process.env.XERO_CLIENT_SECRET?.trim() ?? "",
  redirect: process.env.XERO_REDIRECT_URI?.trim() ?? "",
});

const basic = () => {
  const c = credentials();
  return `Basic ${Buffer.from(`${c.id}:${c.secret}`).toString("base64")}`;
};

/** A money amount in cents as the number Xero reads (two decimals). */
const amount = (cents: number) => Math.round(cents) / 100;
const cents = (n: unknown) => Math.round(Number(n ?? 0) * 100);

async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    // Never the error's own text: it can carry the address, and has nothing a person could act on.
    throw new ProviderError("unavailable", "Xero could not be reached.");
  }
}

/** Xero's own words for what was wrong, from its validation and error bodies. */
function wordsOf(body: unknown): string {
  const b = body as {
    Message?: string;
    Detail?: string;
    Title?: string;
    error?: string;
    error_description?: string;
    Elements?: { ValidationErrors?: { Message?: string }[] }[];
  } | null;
  if (!b || typeof b !== "object") return "";
  const found = (b.Elements ?? []).flatMap((e) => (e.ValidationErrors ?? []).map((v) => v.Message ?? "")).filter(Boolean);
  const text = found.length > 0 ? found.join(" ") : (b.Detail ?? b.Message ?? b.error_description ?? b.error ?? b.Title ?? "");
  return String(text).slice(0, 400);
}

async function bodyOf(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A failed call as the kind of problem it is. */
async function failure(res: Response): Promise<ProviderError> {
  const body = await bodyOf(res);
  const words = wordsOf(body);
  if (res.status === 401) return new ProviderError("unauthorised", words || "Xero refused the access.");
  if (res.status === 429) {
    const after = Number(res.headers.get("retry-after"));
    return new ProviderError("rate_limited", "Xero asked for fewer calls.", Number.isFinite(after) && after > 0 ? Math.ceil(after) : 60);
  }
  if (res.status >= 500) return new ProviderError("unavailable", "Xero had a problem.");
  if (res.status === 403) return new ProviderError("unauthorised", words || "Xero did not allow this.");
  if (/must be unique|already exists|already been used|duplicate/i.test(words)) return new ProviderError("duplicate", words);
  return new ProviderError("rejected", words || `Xero refused it (${res.status}).`);
}

async function api<T>(session: Session, method: "GET" | "POST" | "PUT", path: string, opts: { body?: unknown; key?: string } = {}): Promise<T> {
  const res = await send(`${apiBase()}/${API_VERSION}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "xero-tenant-id": session.tenantId,
      Accept: "application/json",
      ...(opts.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(opts.key ? { "Idempotency-Key": opts.key } : {}),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  if (!res.ok) throw await failure(res);
  return (await bodyOf(res)) as T;
}

async function token(form: Record<string, string>): Promise<Tokens> {
  const res = await send(`${identityBase()}/connect/token`, {
    method: "POST",
    headers: { Authorization: basic(), "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  if (!res.ok) {
    const body = (await bodyOf(res)) as { error?: string } | null;
    // A grant that no longer works (revoked, expired, already spent) cannot be mended by trying again: reconnect.
    if (res.status === 400 || res.status === 401) throw new ProviderError("unauthorised", body?.error ? `Xero said: ${body.error}.` : "Xero refused the sign-in.");
    throw await failure(res);
  }
  const t = (await bodyOf(res)) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string } | null;
  if (!t?.access_token || !t.refresh_token) throw new ProviderError("rejected", "Xero's answer had no token.");
  return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresInSeconds: Number(t.expires_in) || 1800, scopes: t.scope ?? "" };
}

/** The sign-in event a token belongs to, from its (unverified, only read) claims: lists just the organisations that sign-in chose. */
function authEventOf(accessToken: string): string | null {
  try {
    const claims = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8")) as { authentication_event_id?: string };
    return typeof claims.authentication_event_id === "string" ? claims.authentication_event_id : null;
  } catch {
    return null;
  }
}

interface XeroLine {
  Description: string;
  Quantity: number;
  UnitAmount: number;
  AccountCode: string;
  TaxType: string;
  TaxAmount: number;
}

const lineOf = (l: DocumentLine): XeroLine => ({
  Description: l.description,
  Quantity: 1,
  // The tax is inside the price (LineAmountTypes Inclusive) and sent as the receipt computed it: Xero does not round it again.
  UnitAmount: amount(l.grossCents),
  AccountCode: l.accountCode,
  TaxType: l.taxType,
  TaxAmount: amount(l.taxCents),
});

const contactOf = (c: DocumentToSend["contact"]) => ({ Name: c.name, ...(c.email ? { EmailAddress: c.email } : {}) });

interface XeroDocument {
  InvoiceID?: string;
  InvoiceNumber?: string;
  CreditNoteID?: string;
  CreditNoteNumber?: string;
  Reference?: string;
  Total?: number;
  TotalTax?: number;
  Status?: string;
  AmountDue?: number;
  RemainingCredit?: number;
}

const sentOf = (d: XeroDocument | undefined, credit: boolean): SentDocument => {
  const id = credit ? d?.CreditNoteID : d?.InvoiceID;
  if (!d || !id) throw new ProviderError("rejected", "Xero's answer did not hold the document.");
  return { id, number: (credit ? d.CreditNoteNumber : d.InvoiceNumber) ?? "", totalCents: cents(d.Total), taxCents: cents(d.TotalTax) };
};

async function create(session: Session, credit: boolean, doc: DocumentToSend, key: string): Promise<SentDocument> {
  const base = {
    Contact: contactOf(doc.contact),
    Date: doc.date,
    DueDate: doc.date,
    LineAmountTypes: "Inclusive",
    LineItems: doc.lines.map(lineOf),
    Reference: doc.reference,
    Status: "AUTHORISED",
  };
  const body = credit
    ? { CreditNotes: [{ Type: "ACCRECCREDIT", CreditNoteNumber: doc.number, ...base }] }
    : { Invoices: [{ Type: "ACCREC", InvoiceNumber: doc.number, ...base }] };
  const out = await api<{ Invoices?: XeroDocument[]; CreditNotes?: XeroDocument[] }>(session, "PUT", credit ? "CreditNotes" : "Invoices", { body, key });
  return sentOf((credit ? out.CreditNotes : out.Invoices)?.[0], credit);
}

async function find(session: Session, credit: boolean, number: string): Promise<(SentDocument & { reference: string }) | null> {
  const field = credit ? "CreditNoteNumber" : "InvoiceNumber";
  const where = encodeURIComponent(`${field}=="${number.replace(/"/g, "")}"`);
  const out = await api<{ Invoices?: XeroDocument[]; CreditNotes?: XeroDocument[] }>(session, "GET", `${credit ? "CreditNotes" : "Invoices"}?where=${where}`);
  const found = (credit ? out.CreditNotes : out.Invoices)?.[0];
  return found ? { ...sentOf(found, credit), reference: found.Reference ?? "" } : null;
}

async function pay(session: Session, credit: boolean, p: { documentId: string; accountCode: string; date: string; amountCents: number; reference: string }, key: string) {
  const out = await api<{ Payments?: { PaymentID?: string }[] }>(session, "PUT", "Payments", {
    body: {
      Payments: [
        {
          ...(credit ? { CreditNote: { CreditNoteID: p.documentId } } : { Invoice: { InvoiceID: p.documentId } }),
          Account: { Code: p.accountCode },
          Date: p.date,
          Amount: amount(p.amountCents),
          Reference: p.reference,
        },
      ],
    },
    key,
  });
  const id = out.Payments?.[0]?.PaymentID;
  if (!id) throw new ProviderError("rejected", "Xero's answer did not hold the payment.");
  return { id };
}

export const xero: AccountingProvider = {
  id: "xero",

  configured() {
    const c = credentials();
    return Boolean(c.id && c.secret && c.redirect);
  },

  authorizeUrl({ state, challenge }) {
    const c = credentials();
    const q = new URLSearchParams({
      response_type: "code",
      client_id: c.id,
      redirect_uri: c.redirect,
      scope: xeroScopes(),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return `${LOGIN}?${q.toString()}`;
  },

  exchangeCode({ code, verifier }) {
    return token({ grant_type: "authorization_code", code, redirect_uri: credentials().redirect, code_verifier: verifier });
  },

  refresh(refreshToken) {
    return token({ grant_type: "refresh_token", refresh_token: refreshToken });
  },

  async revoke({ refreshToken, accessToken, connectionId }) {
    let ok = true;
    // The organisation's connection first (it stops the app reaching the books), then the grant itself.
    if (accessToken && connectionId) {
      try {
        const res = await send(`${apiBase()}/connections/${encodeURIComponent(connectionId)}`, { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } });
        if (!res.ok && res.status !== 404) ok = false;
      } catch {
        ok = false;
      }
    }
    try {
      const res = await send(`${identityBase()}/connect/revocation`, {
        method: "POST",
        headers: { Authorization: basic(), "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refreshToken }).toString(),
      });
      if (!res.ok) ok = false;
    } catch {
      ok = false;
    }
    return ok;
  },

  async organisations(accessToken): Promise<Organisation[]> {
    const event = authEventOf(accessToken);
    const res = await send(`${apiBase()}/connections${event ? `?authEventId=${encodeURIComponent(event)}` : ""}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (!res.ok) throw await failure(res);
    const list = ((await bodyOf(res)) ?? []) as { id?: string; tenantId?: string; tenantType?: string; tenantName?: string }[];
    return list
      .filter((c) => c.tenantId && c.id && (c.tenantType === undefined || c.tenantType === "ORGANISATION"))
      .map((c) => ({ tenantId: c.tenantId!, connectionId: c.id!, name: c.tenantName ?? "" }));
  },

  async organisation(session) {
    const out = await api<{ Organisations?: { Name?: string; BaseCurrency?: string; IsDemoCompany?: boolean }[] }>(session, "GET", "Organisation");
    const o = out.Organisations?.[0];
    if (!o) throw new ProviderError("rejected", "Xero did not describe the organisation.");
    return { name: o.Name ?? "", currency: (o.BaseCurrency ?? "").toUpperCase(), isDemo: typeof o.IsDemoCompany === "boolean" ? o.IsDemoCompany : null };
  },

  async chart(session) {
    const a = await api<{ Accounts?: { Code?: string; Name?: string; Type?: string; Class?: string; Status?: string; EnablePaymentsToAccount?: boolean }[] }>(session, "GET", "Accounts");
    const t = await api<{ TaxRates?: { Name?: string; TaxType?: string; EffectiveRate?: number; Status?: string }[] }>(session, "GET", "TaxRates");
    const accounts: ChartAccount[] = (a.Accounts ?? [])
      .filter((x) => x.Code && (x.Status ?? "ACTIVE") === "ACTIVE")
      .map((x) => ({
        code: x.Code!,
        name: x.Name ?? x.Code!,
        type: x.Type ?? "",
        class: (x.Class ?? "").toUpperCase(),
        acceptsPayments: x.Type === "BANK" || x.EnablePaymentsToAccount === true,
      }));
    const taxRates: ChartTaxRate[] = (t.TaxRates ?? [])
      .filter((x) => x.TaxType && (x.Status ?? "ACTIVE") === "ACTIVE")
      .map((x) => ({ type: x.TaxType!, name: x.Name ?? x.TaxType!, rate: Number(x.EffectiveRate ?? 0) }));
    return { accounts, taxRates };
  },

  createInvoice: (session, doc, key) => create(session, false, doc, key),
  createCreditNote: (session, doc, key) => create(session, true, doc, key),
  findInvoice: (session, number) => find(session, false, number),
  findCreditNote: (session, number) => find(session, true, number),

  async invoiceState(session, id) {
    const out = await api<{ Invoices?: XeroDocument[] }>(session, "GET", `Invoices/${encodeURIComponent(id)}`);
    const d = out.Invoices?.[0];
    return { settled: d?.Status === "PAID" || (d?.AmountDue ?? 1) === 0 };
  },

  async creditNoteState(session, id) {
    const out = await api<{ CreditNotes?: XeroDocument[] }>(session, "GET", `CreditNotes/${encodeURIComponent(id)}`);
    const d = out.CreditNotes?.[0];
    return { settled: d?.Status === "PAID" || (d?.RemainingCredit ?? 1) === 0 };
  },

  createPayment: (session, p, key) => pay(session, false, p, key),
  createRefund: (session, p, key) => pay(session, true, p, key),
};
