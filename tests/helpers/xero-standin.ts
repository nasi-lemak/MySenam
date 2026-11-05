import crypto from "crypto";
import http from "http";

/**
 * A stand-in for Xero on this machine (the way tests/uat/gateway.ts stands in for Billplz), faithful in the ways the app
 * depends on and nothing more: the identity server (authorization code with PKCE checked, rotating refresh tokens that
 * spend the old one, revocation), `/connections`, and the accounting API for one or more organisations: organisation,
 * accounts, tax rates, invoices, credit notes and payments, with validation (a duplicate number, an unknown account or tax
 * type, a payment past what is owing), `Idempotency-Key` replays, 429 with `Retry-After`, 401 for an expired or revoked
 * token, 5xx, and a response lost after the work was done. It is NOT Xero: it shows what the app does against an
 * API of this shape, never that Xero behaves so. docs/integrations/xero.md#verifying-against-a-demo-company says what
 * only a real demo company can show.
 */

export interface StandinOrganisation {
  tenantId: string;
  name: string;
  currency: string;
  isDemo: boolean | null;
  accounts: { Code: string; Name: string; Type: string; Class: string; Status: string; EnablePaymentsToAccount?: boolean }[];
  taxRates: { Name: string; TaxType: string; EffectiveRate: number; Status: string }[];
}

export interface StoredDocument {
  id: string;
  number: string;
  reference: string;
  type: string;
  contact: { Name?: string; EmailAddress?: string };
  date: string;
  lineAmountTypes: string;
  lines: { Description: string; Quantity: number; UnitAmount: number; AccountCode: string; TaxType: string; TaxAmount: number }[];
  totalCents: number;
  taxCents: number;
  paidCents: number;
  status: string;
}

export interface StoredPayment {
  id: string;
  documentId: string;
  accountCode: string;
  date: string;
  amountCents: number;
  reference: string;
  forCreditNote: boolean;
}

export type Fault =
  /** The next call whose path matches answers with this status (500, 401 or 429 with `retryAfter`). */
  | { match: RegExp; status: 500 | 401 | 429 | 403; retryAfter?: number; times?: number }
  /** The work is done and kept, and the answer never arrives (the connection is cut): a crash between Xero's work and ours. */
  | { match: RegExp; lose: true; times?: number };

export interface Standin {
  url: string;
  clientId: string;
  clientSecret: string;
  organisations: Map<string, StandinOrganisation>;
  invoices: StoredDocument[];
  creditNotes: StoredDocument[];
  payments: StoredPayment[];
  /** Every request, in order: method, path with its query, the tenant it named and whether it carried a bearer token. */
  calls: { method: string; path: string; tenant: string | null; bearer: boolean; idempotencyKey: string | null }[];
  faults: Fault[];
  /** How long an access token lives, in seconds (default 1800). */
  accessSeconds: number;
  /** Remember `Idempotency-Key`s (the default); false stands for keys that have expired at Xero. */
  rememberKeys: boolean;
  /** Calls allowed per minute before 429 (0: no limit). */
  perMinute: number;
  /** Refresh tokens currently good: each is spent as it is used. */
  refreshTokens: Set<string>;
  /** Start a consent: the code Xero would hand back after the manager chose these organisations. */
  consent(authorizeUrl: string, tenantIds: string[]): string;
  /** Make an access token stop working now (an expired or revoked one). */
  expireAccessTokens(): void;
  close(): Promise<void>;
}

const MYR_ACCOUNTS: StandinOrganisation["accounts"] = [
  { Code: "090", Name: "Business Bank Account", Type: "BANK", Class: "ASSET", Status: "ACTIVE" },
  { Code: "091", Name: "Card clearing", Type: "CURRENT", Class: "ASSET", Status: "ACTIVE", EnablePaymentsToAccount: true },
  { Code: "092", Name: "Equipment", Type: "FIXED", Class: "ASSET", Status: "ACTIVE" },
  { Code: "200", Name: "Court hire income", Type: "REVENUE", Class: "REVENUE", Status: "ACTIVE" },
  { Code: "210", Name: "Class income", Type: "REVENUE", Class: "REVENUE", Status: "ACTIVE" },
  { Code: "220", Name: "Membership income", Type: "REVENUE", Class: "REVENUE", Status: "ACTIVE" },
  { Code: "800", Name: "Customer credit held", Type: "CURRLIAB", Class: "LIABILITY", Status: "ACTIVE", EnablePaymentsToAccount: true },
  { Code: "999", Name: "Old income", Type: "REVENUE", Class: "REVENUE", Status: "ARCHIVED" },
];
const MYR_TAX: StandinOrganisation["taxRates"] = [
  { Name: "No tax", TaxType: "NONE", EffectiveRate: 0, Status: "ACTIVE" },
  { Name: "Service tax 8%", TaxType: "SV8", EffectiveRate: 8, Status: "ACTIVE" },
  { Name: "Service tax 6%", TaxType: "SV6", EffectiveRate: 6, Status: "ACTIVE" },
];

export function organisation(over: Partial<StandinOrganisation> = {}): StandinOrganisation {
  const n = crypto.randomUUID();
  return { tenantId: n, name: "Demo Company (MY)", currency: "MYR", isDemo: true, accounts: MYR_ACCOUNTS, taxRates: MYR_TAX, ...over };
}

const money = (cents: number) => cents / 100;
const toCents = (n: unknown) => Math.round(Number(n ?? 0) * 100);

export async function startXeroStandin(orgs: StandinOrganisation[] = [organisation()]): Promise<Standin> {
  const clientId = "standin-client-id";
  const clientSecret = crypto.randomBytes(16).toString("hex");
  const organisations = new Map(orgs.map((o) => [o.tenantId, o]));
  const codes = new Map<string, { challenge: string; tenants: string[]; event: string }>();
  // access token -> { refresh token it came from, tenants, expires }; refresh token -> its tenants and event
  const access = new Map<string, { refresh: string; tenants: string[]; expires: number; revoked: boolean }>();
  const refreshes = new Map<string, { tenants: string[]; event: string }>();
  // A connection is one organisation reached by one sign-in (authorisation event), as in Xero: two sign-ins to the same
  // organisation are two connections, and removing one leaves the other.
  const connections = new Map<string, { event: string; tenant: string }>();
  const replays = new Map<string, { status: number; body: string }>();
  const hits: number[] = [];

  const state: Standin = {
    url: "",
    clientId,
    clientSecret,
    organisations,
    invoices: [],
    creditNotes: [],
    payments: [],
    calls: [],
    faults: [],
    accessSeconds: 1800,
    rememberKeys: true,
    perMinute: 0,
    refreshTokens: new Set(),
    consent(authorizeUrl, tenantIds) {
      const q = new URL(authorizeUrl).searchParams;
      const code = crypto.randomBytes(12).toString("hex");
      codes.set(code, { challenge: q.get("code_challenge") ?? "", tenants: tenantIds, event: crypto.randomUUID() });
      return code;
    },
    expireAccessTokens() {
      for (const a of access.values()) a.expires = 0;
    },
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
    },
  };

  const mint = (tenants: string[], event: string) => {
    const refresh = crypto.randomBytes(24).toString("hex");
    const claims = Buffer.from(JSON.stringify({ authentication_event_id: event })).toString("base64url");
    const token = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${claims}.${crypto.randomBytes(18).toString("base64url")}`;
    refreshes.set(refresh, { tenants, event });
    for (const tenant of tenants) if (![...connections.values()].some((c) => c.event === event && c.tenant === tenant)) connections.set(crypto.randomUUID(), { event, tenant });
    state.refreshTokens.add(refresh);
    access.set(token, { refresh, tenants, expires: Date.now() + state.accessSeconds * 1000, revoked: false });
    return { access_token: token, refresh_token: refresh, expires_in: state.accessSeconds, token_type: "Bearer", scope: "offline_access accounting.invoices accounting.payments accounting.contacts accounting.settings.read" };
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      void handle(req, res, Buffer.concat(chunks).toString("utf8"));
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse, raw: string): Promise<void> {
    const url = new URL(req.url!, "http://xero");
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers }).end(body === null ? "" : JSON.stringify(body));
    };
    const path = url.pathname;
    state.calls.push({
      method: req.method!,
      path: path + url.search,
      tenant: (req.headers["xero-tenant-id"] as string) ?? null,
      bearer: /^Bearer .+/.test(String(req.headers.authorization ?? "")),
      idempotencyKey: (req.headers["idempotency-key"] as string) ?? null,
    });
    const basicOk = () => req.headers.authorization === `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;

    // ---- the identity server
    if (path === "/connect/token" && req.method === "POST") {
      if (!basicOk()) return send(401, { error: "invalid_client" });
      const form = new URLSearchParams(raw);
      if (form.get("grant_type") === "authorization_code") {
        const issued = codes.get(form.get("code") ?? "");
        if (!issued) return send(400, { error: "invalid_grant" });
        codes.delete(form.get("code")!);
        const verifier = form.get("code_verifier") ?? "";
        if (crypto.createHash("sha256").update(verifier).digest("base64url") !== issued.challenge) return send(400, { error: "invalid_grant" });
        return send(200, mint(issued.tenants, issued.event));
      }
      if (form.get("grant_type") === "refresh_token") {
        const old = refreshes.get(form.get("refresh_token") ?? "");
        if (!old || !state.refreshTokens.has(form.get("refresh_token")!)) return send(400, { error: "invalid_grant" });
        // Rotation: the old one is spent, its access tokens go with it.
        state.refreshTokens.delete(form.get("refresh_token")!);
        return send(200, mint(old.tenants, old.event));
      }
      return send(400, { error: "unsupported_grant_type" });
    }
    if (path === "/connect/revocation" && req.method === "POST") {
      if (!basicOk()) return send(401, { error: "invalid_client" });
      const token = new URLSearchParams(raw).get("token") ?? "";
      state.refreshTokens.delete(token);
      for (const a of access.values()) if (a.refresh === token) a.revoked = true;
      return send(200, null);
    }

    // ---- bearer from here on
    const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
    const grant = bearer ? access.get(bearer) : undefined;

    // A fault asked for by the test: the first whose pattern matches this call.
    const fault = state.faults.find((f) => f.match.test(`${req.method} ${path}`));
    if (fault) {
      if (fault.times !== undefined && --fault.times <= 0) state.faults.splice(state.faults.indexOf(fault), 1);
      if ("status" in fault) {
        if (fault.status === 429) return send(429, { Title: "Too Many Requests" }, { "retry-after": String(fault.retryAfter ?? 30), "x-rate-limit-problem": "minute" });
        return send(fault.status, { Title: "fault", Detail: "stand-in fault" });
      }
    }
    if (!grant || grant.revoked || grant.expires <= Date.now()) return send(401, { Title: "Unauthorized", Detail: "TokenExpired" });

    // The event this token was granted in.
    const eventOf = (token: string | undefined) => (token ? refreshes.get(access.get(token)?.refresh ?? "")?.event : undefined);
    if (path === "/connections" && req.method === "GET") {
      const event = eventOf(bearer);
      const list = [...connections.entries()]
        .filter(([, c]) => c.event === event && grant.tenants.includes(c.tenant))
        .map(([id, c]) => ({ id, tenantId: c.tenant, tenantType: "ORGANISATION", tenantName: organisations.get(c.tenant)?.name ?? "" }));
      return send(200, list);
    }
    const del = /^\/connections\/(.+)$/.exec(path);
    if (del && req.method === "DELETE") {
      const c = connections.get(del[1]);
      if (!c) return send(404, { Title: "Not Found" });
      connections.delete(del[1]);
      for (const [token, a] of access) if (eventOf(token) === c.event) a.tenants = a.tenants.filter((t) => t !== c.tenant);
      for (const r of refreshes.values()) if (r.event === c.event) r.tenants = r.tenants.filter((t) => t !== c.tenant);
      return send(200, null);
    }

    if (!path.startsWith("/api.xro/2.0/")) return send(404, { Title: "Not Found" });
    const org = organisations.get(String(req.headers["xero-tenant-id"] ?? ""));
    if (!org || !grant.tenants.includes(org.tenantId)) return send(403, { Title: "Forbidden", Detail: "AuthenticationUnsuccessful" });

    // Rate limit: calls per minute for the organisation.
    if (state.perMinute > 0) {
      const now = Date.now();
      while (hits.length && hits[0] < now - 60_000) hits.shift();
      if (hits.length >= state.perMinute) return send(429, { Title: "Too Many Requests" }, { "retry-after": "45", "x-rate-limit-problem": "minute" });
      hits.push(now);
    }

    const resource = path.slice("/api.xro/2.0/".length);
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    const key = (req.headers["idempotency-key"] as string) ?? null;
    const replayKey = key ? `${org.tenantId}|${req.method}|${resource}|${key}` : null;
    if (replayKey && state.rememberKeys && replays.has(replayKey)) {
      const kept = replays.get(replayKey)!;
      return void res.writeHead(kept.status, { "content-type": "application/json" }).end(kept.body);
    }
    const reply = (status: number, out: unknown, lose = false) => {
      const text = JSON.stringify(out);
      if (replayKey && status < 300) replays.set(replayKey, { status, body: text });
      if (lose && fault && "lose" in fault) return void req.socket.destroy();
      res.writeHead(status, { "content-type": "application/json" }).end(text);
    };
    const lose = Boolean(fault && "lose" in fault);
    const invalid = (message: string) => send(400, { ErrorNumber: 10, Type: "ValidationException", Message: "A validation exception occurred", Elements: [{ ValidationErrors: [{ Message: message }] }] });

    if (resource === "Organisation" && req.method === "GET") return send(200, { Organisations: [{ Name: org.name, BaseCurrency: org.currency, ...(org.isDemo === null ? {} : { IsDemoCompany: org.isDemo }), CountryCode: "MY" }] });
    if (resource === "Accounts" && req.method === "GET") return send(200, { Accounts: org.accounts });
    if (resource === "TaxRates" && req.method === "GET") return send(200, { TaxRates: org.taxRates });

    const docs = (credit: boolean) => (credit ? state.creditNotes : state.invoices);
    const shape = (d: StoredDocument, credit: boolean) => ({
      [credit ? "CreditNoteID" : "InvoiceID"]: d.id,
      [credit ? "CreditNoteNumber" : "InvoiceNumber"]: d.number,
      Reference: d.reference,
      Type: d.type,
      Status: d.status,
      Total: money(d.totalCents),
      TotalTax: money(d.taxCents),
      [credit ? "RemainingCredit" : "AmountDue"]: money(d.totalCents - d.paidCents),
      Contact: d.contact,
    });

    for (const credit of [false, true]) {
      const name = credit ? "CreditNotes" : "Invoices";
      if (resource === name && req.method === "PUT") {
        const item = ((body?.[name] as Record<string, unknown>[]) ?? [])[0];
        if (!item) return invalid("No document.");
        const number = String(item[credit ? "CreditNoteNumber" : "InvoiceNumber"] ?? "");
        if (docs(credit).some((d) => d.number === number)) return invalid(`${credit ? "Credit note" : "Invoice"} # must be unique.`);
        const lines = (item.LineItems as StoredDocument["lines"]) ?? [];
        if (item.Status !== "AUTHORISED" || item.LineAmountTypes !== "Inclusive") return invalid("Status and line amount types are as the app sends them.");
        for (const l of lines) {
          if (!org.accounts.some((a) => a.Code === l.AccountCode && a.Status === "ACTIVE")) return invalid(`Account code '${l.AccountCode}' is not a valid code.`);
          if (!org.taxRates.some((t) => t.TaxType === l.TaxType)) return invalid(`Tax type '${l.TaxType}' is not valid.`);
        }
        const contact = item.Contact as StoredDocument["contact"];
        if (!contact?.Name) return invalid("A contact is needed.");
        const d: StoredDocument = {
          id: crypto.randomUUID(),
          number,
          reference: String(item.Reference ?? ""),
          type: String(item.Type),
          contact,
          date: String(item.Date),
          lineAmountTypes: String(item.LineAmountTypes),
          lines,
          totalCents: lines.reduce((s, l) => s + toCents(l.UnitAmount) * (l.Quantity ?? 1), 0),
          taxCents: lines.reduce((s, l) => s + toCents(l.TaxAmount), 0),
          paidCents: 0,
          status: "AUTHORISED",
        };
        docs(credit).push(d);
        return reply(200, { [name]: [shape(d, credit)] }, lose);
      }
      if (resource === name && req.method === "GET") {
        const where = url.searchParams.get("where") ?? "";
        const m = new RegExp(`${credit ? "CreditNoteNumber" : "InvoiceNumber"}=="(.*)"`).exec(where);
        return send(200, { [name]: docs(credit).filter((d) => !m || d.number === m[1]).map((d) => shape(d, credit)) });
      }
      const one = new RegExp(`^${name}/(.+)$`).exec(resource);
      if (one && req.method === "GET") {
        const d = docs(credit).find((x) => x.id === one[1]);
        return d ? send(200, { [name]: [shape(d, credit)] }) : send(404, { Title: "Not Found" });
      }
    }

    if (resource === "Payments" && req.method === "PUT") {
      const item = ((body?.Payments as Record<string, unknown>[]) ?? [])[0];
      if (!item) return invalid("No payment.");
      const forCreditNote = Boolean(item.CreditNote);
      const id = String(((item.CreditNote ?? item.Invoice) as Record<string, string> | undefined)?.[forCreditNote ? "CreditNoteID" : "InvoiceID"] ?? "");
      const doc = docs(forCreditNote).find((d) => d.id === id);
      if (!doc) return invalid("The document cannot be found.");
      const account = org.accounts.find((a) => a.Code === (item.Account as { Code?: string })?.Code);
      if (!account || !(account.Type === "BANK" || account.EnablePaymentsToAccount)) return invalid("The account does not accept payments.");
      const cents = toCents(item.Amount);
      if (cents <= 0 || cents > doc.totalCents - doc.paidCents) return invalid("Payment amount exceeds the amount outstanding.");
      doc.paidCents += cents;
      if (doc.paidCents === doc.totalCents) doc.status = "PAID";
      const p: StoredPayment = { id: crypto.randomUUID(), documentId: id, accountCode: account.Code, date: String(item.Date), amountCents: cents, reference: String(item.Reference ?? ""), forCreditNote };
      state.payments.push(p);
      return reply(200, { Payments: [{ PaymentID: p.id }] }, lose);
    }
    return send(404, { Title: "Not Found", Detail: `${req.method} ${resource}` });
  }

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  state.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return state;
}
