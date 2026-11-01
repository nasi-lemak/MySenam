import crypto from "crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";
process.env.MYSENAM_MARKETPLACE = "on";

import { NextRequest } from "next/server";
import { POST as mcpPost } from "../src/app/api/mcp/route";
import { POST as staffPost, GET as staffGet } from "../src/app/api/mcp/staff/route";
import { GET as prmRoot } from "../src/app/.well-known/oauth-protected-resource/route";
import { GET as prmPath } from "../src/app/.well-known/oauth-protected-resource/api/mcp/staff/route";
import { GET as asMeta } from "../src/app/.well-known/oauth-authorization-server/route";
import { POST as registerPost } from "../src/app/api/oauth/register/route";
import { GET as authorizeGet, POST as authorizePost } from "../src/app/api/oauth/authorize/route";
import { POST as tokenPost } from "../src/app/api/oauth/token/route";
import { POST as revokePost } from "../src/app/api/oauth/revoke/route";
import { GET as assistantsGet, POST as assistantsPost } from "../src/app/api/admin/assistants/route";
import { PATCH as venuePatch } from "../src/app/api/admin/venues/[id]/route";
import { PATCH as courtPatch } from "../src/app/api/admin/courts/[id]/route";
import { listActivity } from "../src/lib/activity";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, deleteAdmin, setStaffRole } from "../src/lib/admin-auth";
import { createApiKey } from "../src/lib/api-keys";
import { listCourtChanges, listHoursChanges } from "../src/lib/dated-changes";
import { getDb } from "../src/lib/db";
import { readGuide } from "../src/lib/guide/answers";
import { playbookFor } from "../src/lib/guide/playbook/server";
import { cancelPolicy } from "../src/lib/cancel-policy";
import { resetRateLimits } from "../src/lib/rate-limit";
import { resetFromConsole } from "../src/lib/two-factor-reset";
import { changePassword } from "../src/lib/password-reset";
import { createBooking, createCourt, createVenue, getCourt, getVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Layer 3 of the MCP server (docs/integrations/mcp.md#signing-in-from-an-ai-assistant,
 * ADR 0030): the OAuth 2.1 authorization server inside the app, through its
 * real route handlers (discovery, registration, the consent page's requests,
 * tokens, revocation), the signed-in MCP address, tools by scope and the
 * person's current role, acting as the person in the staff log, and the
 * configuration tools compared with the dashboard's own routes.
 */

const SITE = "https://book.example.my";
const RESOURCE = `${SITE}/api/mcp/staff`;
const REDIRECT = "https://assistant.example.com/oauth/callback";
const day = addDays(todayISO(), 5);
const later = addDays(todayISO(), 20);

let venueA: number;
let venueB: number;
let courtA: number;
let courtB: number;
let managerId: number;
let managerCookie: string;
let deskCookie: string;
let ownerCookie: string;
let otherManagerCookie: string;
let clientId: string;

let ip = 1;
const address = () => `203.0.113.${ip++ % 250}`;

const json = (url: string, body: unknown, headers: Record<string, string> = {}, method = "POST") =>
  new NextRequest(`${SITE}${url}`, { method, headers: { "content-type": "application/json", "x-forwarded-for": address(), ...headers }, body: JSON.stringify(body) });
const form = (url: string, fields: Record<string, string>) =>
  new NextRequest(`${SITE}${url}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": address() }, body: new URLSearchParams(fields).toString() });
const get = (url: string, cookie?: string) => new NextRequest(`${SITE}${url}`, { headers: { "x-forwarded-for": address(), ...(cookie ? { cookie } : {}) } });

const pkce = () => {
  const verifier = crypto.randomBytes(32).toString("base64url");
  return { verifier, challenge: crypto.createHash("sha256").update(verifier).digest("base64url") };
};

async function register(body: Record<string, unknown>, from = address()) {
  const res = await registerPost(new NextRequest(`${SITE}/api/oauth/register`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": from }, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

function query(o: { client?: string; redirect?: string; challenge?: string; method?: string; scope?: string; state?: string; resource?: string; responseType?: string } = {}) {
  const q = new URLSearchParams({
    response_type: o.responseType ?? "code",
    client_id: o.client ?? clientId,
    redirect_uri: o.redirect ?? REDIRECT,
    code_challenge: o.challenge ?? pkce().challenge,
    code_challenge_method: o.method ?? "S256",
    state: o.state ?? "state-123",
    resource: o.resource ?? RESOURCE,
  });
  if (o.scope !== undefined) q.set("scope", o.scope);
  else q.set("scope", "venue:read venue:book venue:configure");
  return `?${q.toString()}`;
}

async function consent(search: string, cookie?: string) {
  const res = await authorizeGet(get(`/api/oauth/authorize${search}`, cookie));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function decide(search: string, cookie: string, choice: Record<string, unknown>, headers: Record<string, string> = {}) {
  const res = await authorizePost(json("/api/oauth/authorize", { query: search, ...choice }, { cookie, origin: SITE, ...headers }));
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

async function token(fields: Record<string, string>) {
  const res = await tokenPost(form("/api/oauth/token", fields));
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

/** The whole sign-in: consent as `cookie` for `venueId` with `scopes`, then the code for tokens. */
async function signIn(cookie: string, venueId: number, scopes: string[], asked = "venue:read venue:book venue:configure") {
  const { verifier, challenge } = pkce();
  const search = query({ challenge, scope: asked });
  const decided = await decide(search, cookie, { decision: "allow", venueId, scopes });
  expect(decided.status, JSON.stringify(decided.body)).toBe(200);
  const back = new URL(decided.body.redirect);
  const code = back.searchParams.get("code")!;
  const tokens = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: RESOURCE });
  expect(tokens.status, JSON.stringify(tokens.body)).toBe(200);
  return tokens.body as unknown as { access_token: string; refresh_token: string; scope: string; expires_in: number };
}

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}
const staff = (access: string | null, body: unknown, headers: Record<string, string> = {}) =>
  staffPost(
    new NextRequest(`${SITE}/api/mcp/staff`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": address(), ...(access ? { authorization: `Bearer ${access}` } : {}), ...headers },
      body: JSON.stringify(body),
    })
  );
const listTools = async (access: string) => ((await (await staff(access, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json()).result.tools as { name: string; annotations: Record<string, boolean> }[]).map((t) => t.name);
async function call(access: string, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const res = await staff(access, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.error, JSON.stringify(body.error)).toBeUndefined();
  return body.result as ToolResult;
}
const text = (r: ToolResult) => r.content.map((c) => c.text).join("\n");
const data = (r: ToolResult) => {
  expect(r.isError, text(r)).toBeFalsy();
  return JSON.parse(r.content[0].text.slice(r.content[0].text.indexOf("\n\n") + 2));
};
const adminReq = (method: string, url: string, cookie: string, body: unknown) =>
  new NextRequest(`${SITE}${url}`, { method, headers: { cookie, "content-type": "application/json", origin: SITE, "x-forwarded-for": "192.0.2.50" }, body: JSON.stringify(body) });

beforeAll(async () => {
  const venue = async (name: string) => {
    const made = await createVenue({ name, area: "Shah Alam", address: `2 Jalan ${name}`, phone: "0355550000", openMin: 7 * 60, closeMin: 23 * 60 });
    if (!made.ok) throw new Error(made.error);
    const c = await createCourt({ venueId: made.venue.id, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 30 });
    if (!c.ok) throw new Error(c.error);
    return { id: made.venue.id, court: c.court.id };
  };
  const a = await venue("Oauth Arena");
  venueA = a.id;
  courtA = a.court;
  const b = await venue("Other Hall");
  venueB = b.id;
  courtB = b.court;
  const m = await createAdmin({ name: "Maya Manager", email: "oa-mgr@oauth.test", password: "a long enough password", venueId: venueA, role: "manager" });
  const d = await createAdmin({ name: "Dan Desk", email: "oa-desk@oauth.test", password: "a long enough password", venueId: venueA, role: "desk" });
  const o = await createAdmin({ name: "Olive Owner", email: "oa-owner@oauth.test", password: "a long enough password", venueId: null });
  const ob = await createAdmin({ name: "Bob Other", email: "oa-other@oauth.test", password: "a long enough password", venueId: venueB, role: "manager" });
  if (!m.ok || !d.ok || !o.ok || !ob.ok) throw new Error("admins");
  managerId = m.admin.id;
  const cookieOf = async (id: number) => `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(id)).token}`;
  managerCookie = await cookieOf(m.admin.id);
  deskCookie = await cookieOf(d.admin.id);
  ownerCookie = await cookieOf(o.admin.id);
  otherManagerCookie = await cookieOf(ob.admin.id);
  const reg = await register({ client_name: "Test Assistant", redirect_uris: [REDIRECT, "http://127.0.0.1:33418/callback"] });
  expect(reg.status).toBe(201);
  clientId = reg.body.client_id;
});

afterEach(async () => {
  delete process.env.MYSENAM_STAFF_2FA;
  await resetRateLimits();
});

describe("discovery", () => {
  it("publishes protected-resource and authorization-server metadata, and the signed-in address asks for sign-in with a 401", async () => {
    for (const handler of [prmRoot, prmPath]) {
      const prm = await (await handler()).json();
      expect(prm).toMatchObject({ resource: RESOURCE, authorization_servers: [SITE], scopes_supported: ["venue:read", "venue:book", "venue:configure"], bearer_methods_supported: ["header"] });
    }
    const meta = await (await asMeta()).json();
    expect(meta).toMatchObject({
      issuer: SITE,
      authorization_endpoint: `${SITE}/oauth/authorize`,
      token_endpoint: `${SITE}/api/oauth/token`,
      registration_endpoint: `${SITE}/api/oauth/register`,
      revocation_endpoint: `${SITE}/api/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
    const res = await staff(null, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${SITE}/.well-known/oauth-protected-resource/api/mcp/staff"`);
    expect((await staffGet()).status).toBe(405);
  });
});

describe("dynamic client registration", () => {
  it("registers public clients with https or loopback redirect URIs only, never issuing a secret", async () => {
    const ok = await register({ client_name: "Loopback‮ tool", redirect_uris: ["http://localhost:8123/cb"], token_endpoint_auth_method: "client_secret_post" });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ client_name: "Loopback tool", token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
    expect(ok.body.client_secret).toBeUndefined();
    for (const bad of ["http://assistant.example.com/cb", "https://assistant.example.com/cb#frag", "cursor://anysphere/cb", "https://user:pw@assistant.example.com/cb", "not a url"]) {
      const r = await register({ client_name: "Bad", redirect_uris: [bad] });
      expect(r.status, bad).toBe(400);
      expect(r.body.error).toBe("invalid_redirect_uri");
    }
    expect((await register({ client_name: "None" })).status).toBe(400);
    expect((await register({ redirect_uris: [REDIRECT], grant_types: ["client_credentials"] })).body.error).toBe("invalid_client_metadata");
  });

  it("limits registrations from one address", async () => {
    const from = "198.51.100.77";
    for (let i = 0; i < 30; i++) expect((await register({ client_name: `C${i}`, redirect_uris: [REDIRECT] }, from)).status).toBe(201);
    expect((await register({ client_name: "One too many", redirect_uris: [REDIRECT] }, from)).status).toBe(429);
  });
});

describe("the authorization request", () => {
  it("shows an unknown client or an unregistered return address on the page and sends the browser nowhere", async () => {
    const unknown = await consent(query({ client: "mcp_unknownclientidentifier000" }), managerCookie);
    expect(unknown).toMatchObject({ status: 400, body: { problem: "client" } });
    for (const redirect of ["https://assistant.example.com/oauth/callback/", "https://assistant.example.com/oauth/callbackx", "https://evil.example/cb"]) {
      const r = await consent(query({ redirect }), managerCookie);
      expect(r, redirect).toMatchObject({ status: 400, body: { problem: "redirect" } });
      expect(r.body.redirect).toBeUndefined();
    }
  });

  it("sends other faults back to the registered address with the state: PKCE required, S256 only, known scopes, this resource", async () => {
    const cases: [Parameters<typeof query>[0], string][] = [
      [{ challenge: "" }, "invalid_request"],
      [{ method: "plain" }, "invalid_request"],
      [{ responseType: "token" }, "unsupported_response_type"],
      [{ scope: "venue:read admin:all" }, "invalid_scope"],
      [{ resource: "https://elsewhere.example/api/mcp" }, "invalid_target"],
    ];
    for (const [o, error] of cases) {
      const r = await consent(query({ ...o, state: "keep-me" }), managerCookie);
      expect(r.status).toBe(200);
      const back = new URL(r.body.redirect as string);
      expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
      expect(back.searchParams.get("error"), JSON.stringify(o)).toBe(error);
      expect(back.searchParams.get("state")).toBe("keep-me");
      expect(back.searchParams.get("iss")).toBe(SITE);
    }
  });

  it("sends somebody not signed in to the staff sign-in, coming back to the same request, and honours two-factor sign-in", async () => {
    const search = query();
    const out = await consent(search);
    expect(out.body.signIn).toBe(`/admin?next=${encodeURIComponent(`/oauth/authorize${search}`)}`);
    process.env.MYSENAM_STAFF_2FA = "all";
    const pending = await consent(search, managerCookie);
    expect(pending.body).toMatchObject({ twoFactor: true });
    expect(pending.body.signIn).toBeDefined();
    const refused = await decide(search, managerCookie, { decision: "allow", venueId: venueA, scopes: ["venue:read"] });
    expect(refused.status).toBe(401);
  });

  it("names the client as unverified, the return host, the person and their venues with what their role there may allow", async () => {
    const mgr = await consent(query(), managerCookie);
    expect(mgr.body).toMatchObject({
      request: { clientName: "Test Assistant", nameVerified: false, redirectHost: "assistant.example.com", scopes: ["venue:read", "venue:book", "venue:configure"] },
      person: { name: "Maya Manager" },
      venues: [{ id: venueA, role: "manager", grantable: ["venue:read", "venue:book", "venue:configure"] }],
    });
    const desk = await consent(query(), deskCookie);
    expect(desk.body.venues).toEqual([{ id: venueA, name: "Oauth Arena", role: "desk", grantable: ["venue:read", "venue:book"] }]);
  });

  it("refuses front desk changing settings, a venue the person cannot reach, and anything not asked for; deny goes back with access_denied", async () => {
    const search = query({ state: "s-1" });
    expect((await decide(search, deskCookie, { decision: "allow", venueId: venueA, scopes: ["venue:read", "venue:configure"] })).status).toBe(403);
    expect((await decide(search, managerCookie, { decision: "allow", venueId: venueB, scopes: ["venue:read"] })).status).toBe(403);
    expect((await decide(query({ scope: "venue:read" }), managerCookie, { decision: "allow", venueId: venueA, scopes: ["venue:book"] })).status).toBe(400);
    expect((await decide(search, managerCookie, { decision: "allow", venueId: venueA, scopes: [] })).status).toBe(400);
    const denied = await decide(search, managerCookie, { decision: "deny", venueId: venueA, scopes: [] });
    const back = new URL(denied.body.redirect);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("s-1");
    expect(back.searchParams.get("code")).toBeNull();
    const allowed = await decide(search, deskCookie, { decision: "allow", venueId: venueA, scopes: ["venue:read", "venue:book"] });
    const code = new URL(allowed.body.redirect);
    expect(`${code.origin}${code.pathname}`).toBe(REDIRECT);
    expect(code.searchParams.get("code")).toMatch(/^msc_/);
    expect(code.searchParams.get("state")).toBe("s-1");
    const log = await listActivity([venueA], { limit: 5 });
    expect(log.find((e) => e.action === "oauth.granted" && e.adminName === "Dan Desk")?.detail).toContain("Test Assistant (name not verified)");
  });

  it("takes the consent only as a JSON request from this site (CSRF)", async () => {
    const search = query();
    expect((await decide(search, managerCookie, { decision: "allow", venueId: venueA, scopes: ["venue:read"] }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await decide(search, managerCookie, { decision: "allow", venueId: venueA, scopes: ["venue:read"] }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    const asForm = await authorizePost(
      new NextRequest(`${SITE}/api/oauth/authorize`, { method: "POST", headers: { cookie: managerCookie, "content-type": "text/plain", "x-forwarded-for": address() }, body: JSON.stringify({ query: search, decision: "allow", venueId: venueA }) })
    );
    expect(asForm.status).toBe(403);
  });
});

describe("tokens", () => {
  it("exchanges a code once, with its PKCE verifier, for the client and address it was given to, keeping only hashes", async () => {
    const { verifier, challenge } = pkce();
    const search = query({ challenge, scope: "venue:read" });
    const codeOf = async () => new URL((await decide(search, managerCookie, { decision: "allow", venueId: venueA, scopes: ["venue:read"] })).body.redirect).searchParams.get("code")!;
    const base = (code: string) => ({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier });
    expect((await token({ ...base(await codeOf()), code_verifier: pkce().verifier })).body.error).toBe("invalid_grant");
    expect((await token({ ...base(await codeOf()), redirect_uri: "http://127.0.0.1:33418/callback" })).body.error).toBe("invalid_grant");
    const other = (await register({ client_name: "Other", redirect_uris: [REDIRECT] })).body.client_id;
    expect((await token({ ...base(await codeOf()), client_id: other })).body.error).toBe("invalid_grant");
    expect((await token({ ...base(await codeOf()), resource: "https://elsewhere.example/mcp" })).body.error).toBe("invalid_target");
    const stale = await codeOf();
    await getDb().prepare("UPDATE oauth_codes SET expires_at = datetime('now', '-1 minutes')").run();
    expect((await token(base(stale))).body.error).toBe("invalid_grant");

    const code = await codeOf();
    const ok = await token(base(code));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "venue:read" });
    expect(ok.body.access_token).toMatch(/^msa_/);
    expect(ok.body.refresh_token).toMatch(/^msr_/);
    // Only hashes are kept: no token or code appears anywhere in the tables.
    const dump = JSON.stringify([
      await getDb().prepare("SELECT * FROM oauth_tokens").all(),
      await getDb().prepare("SELECT * FROM oauth_codes").all(),
      await getDb().prepare("SELECT * FROM oauth_grants").all(),
    ]);
    for (const secret of [ok.body.access_token, ok.body.refresh_token, code]) expect(dump).not.toContain(secret);
    expect(dump).toContain(crypto.createHash("sha256").update(ok.body.access_token).digest("hex"));
    expect((await listTools(ok.body.access_token)).includes("my_venue")).toBe(true);
    // The same code again: refused, and what it gave ends.
    expect((await token(base(code))).body.error).toBe("invalid_grant");
    expect((await staff(ok.body.access_token, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
  });

  it("rotates refresh tokens, and a refresh token used twice ends the connection", async () => {
    const first = await signIn(managerCookie, venueA, ["venue:read"]);
    const second = await token({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId });
    expect(second.status).toBe(200);
    expect(second.body.refresh_token).not.toBe(first.refresh_token);
    expect((await token({ grant_type: "refresh_token", refresh_token: second.body.refresh_token, client_id: clientId, scope: "venue:read venue:configure" })).body.error).toBe("invalid_scope");
    // The scope refusal used that refresh token up too; the newest pair still works for calls.
    expect((await staff(second.body.access_token, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(200);
    // Replaying the first refresh token: refused, and the connection ends.
    expect((await token({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId })).body.error).toBe("invalid_grant");
    const res = await staff(second.body.access_token, { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect((await listActivity([venueA], { limit: 10 })).some((e) => e.action === "oauth.revoked" && (e.detail ?? "").includes("refresh token was used twice"))).toBe(true);
  });

  it("refuses an expired access token, a token for another address, and one revoked by the client; never a cookie or a foreign origin", async () => {
    const a = await signIn(managerCookie, venueA, ["venue:read"]);
    await getDb().prepare("UPDATE oauth_tokens SET expires_at = datetime('now', '-1 minutes') WHERE kind = 'access'").run();
    const expired = await staff(a.access_token, { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(expired.status).toBe(401);
    expect((await expired.json()).error.message).toBe("The access token has expired.");

    const b = await signIn(managerCookie, venueA, ["venue:read"]);
    await getDb().prepare("UPDATE oauth_grants SET resource = 'https://elsewhere.example/api/mcp/staff' WHERE id = (SELECT MAX(id) FROM oauth_grants)").run();
    expect((await (await staff(b.access_token, { jsonrpc: "2.0", id: 1, method: "ping" })).json()).error.message).toBe("The access token is not for this address.");
    // A sign-in token is not a key for /api/mcp either.
    const asKey = await mcpPost(new NextRequest(`${SITE}/api/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${b.access_token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) }));
    expect(asKey.status).toBe(401);

    const c = await signIn(managerCookie, venueA, ["venue:read"]);
    expect((await revokePost(form("/api/oauth/revoke", { token: c.refresh_token, client_id: clientId }))).status).toBe(200);
    expect((await staff(c.access_token, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
    expect((await revokePost(form("/api/oauth/revoke", { token: "msr_nothing", client_id: clientId }))).status).toBe(200);

    expect((await staff(null, { jsonrpc: "2.0", id: 1, method: "ping" }, { cookie: managerCookie })).status).toBe(401);
    const d = await signIn(managerCookie, venueA, ["venue:read"]);
    expect((await staff(d.access_token, { jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://evil.example" })).status).toBe(403);
  });

  it("ends the connection on the next call when the person's role drops, they lose the venue, are removed, or their password or two-factor sign-in changes", async () => {
    const extra = await createAdmin({ name: "Rita Role", email: "oa-rita@oauth.test", password: "a long enough password", venueId: venueA, role: "manager" });
    if (!extra.ok) throw new Error(extra.error);
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(extra.admin.id)).token}`;
    const ping = async (access: string) => (await staff(access, { jsonrpc: "2.0", id: 1, method: "ping" })).status;

    const t1 = await signIn(cookie, venueA, ["venue:read", "venue:configure"]);
    expect(await ping(t1.access_token)).toBe(200);
    await setStaffRole(extra.admin.id, "desk");
    expect(await ping(t1.access_token)).toBe(401);
    expect((await token({ grant_type: "refresh_token", refresh_token: t1.refresh_token, client_id: clientId })).body.error).toBe("invalid_grant");
    await setStaffRole(extra.admin.id, "manager");
    // Ended for good: the role coming back does not bring it back.
    expect(await ping(t1.access_token)).toBe(401);

    const t2 = await signIn(cookie, venueA, ["venue:read"]);
    await getDb().prepare("UPDATE admins SET venue_id = ? WHERE id = ?").run(venueB, extra.admin.id);
    expect(await ping(t2.access_token)).toBe(401);
    await getDb().prepare("UPDATE admins SET venue_id = ? WHERE id = ?").run(venueA, extra.admin.id);

    const t3 = await signIn(cookie, venueA, ["venue:read"]);
    process.env.MYSENAM_STAFF_2FA = "managers";
    expect(await ping(t3.access_token)).toBe(401);
    delete process.env.MYSENAM_STAFF_2FA;
    expect(await ping(t3.access_token)).toBe(200);
    // Two-factor sign-in reset (a lost phone): signed out everywhere, assistants included.
    await getDb().prepare("UPDATE admins SET totp_secret = 'x', totp_enabled_at = datetime('now') WHERE id = ?").run(extra.admin.id);
    expect((await resetFromConsole("oa-rita@oauth.test", "confirmed by phone call with the owner")).ok).toBe(true);
    expect(await ping(t3.access_token)).toBe(401);

    const session = async () => `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(extra.admin.id)).token}`;
    // A password changed ends them as it ends the account's other sessions.
    const t4 = await signIn(await session(), venueA, ["venue:read"]);
    expect((await changePassword("admin", extra.admin.id, "a long enough password", "another long password", null)).ok).toBe(true);
    expect(await ping(t4.access_token)).toBe(401);

    const t5 = await signIn(await session(), venueA, ["venue:read"]);
    expect((await deleteAdmin(extra.admin.id)).ok).toBe(true);
    expect(await ping(t5.access_token)).toBe(401);
    expect(await ping(t3.access_token)).toBe(401);
    expect((await getDb().prepare("SELECT COUNT(*)::int AS n FROM oauth_grants WHERE admin_id = ?").get(extra.admin.id)) as { n: number }).toEqual({ n: 0 });
  });
});

describe("tools by authority", () => {
  it("lists what the grant's scopes and the person's current role reach", async () => {
    const open = ["guide_business_types", "guide_fit", "search_venues", "venue_details", "venue_availability"];
    const reads = ["my_venue", "my_availability", "my_bookings", "my_booking", "my_setup_status", "my_playbook"];
    const config = ["save_setup_answers", "acknowledge_setup_step", "set_opening_hours", "set_court_rates", "add_courts", "set_peak_hours", "set_booking_rules", "set_cancellation_terms"];
    expect(await listTools((await signIn(managerCookie, venueA, ["venue:read"])).access_token)).toEqual([...open, ...reads]);
    expect(await listTools((await signIn(managerCookie, venueA, ["venue:book"])).access_token)).toEqual([...open, "create_booking", "cancel_booking"]);
    const all = await signIn(managerCookie, venueA, ["venue:read", "venue:book", "venue:configure"]);
    expect(await listTools(all.access_token)).toEqual([...open, ...reads, "create_booking", "cancel_booking", ...config]);
    // Front desk: no setup status (a manager's on the dashboard too), no settings.
    const desk = await signIn(deskCookie, venueA, ["venue:read", "venue:book"]);
    expect(await listTools(desk.access_token)).toEqual([...open, ...reads.filter((r) => r !== "my_setup_status"), "create_booking", "cancel_booking"]);
    const refused = await call(desk.access_token, "my_setup_status");
    expect(text(refused)).toBe("Front-desk accounts cannot change this. Ask a manager. (MANAGER_ONLY)");
    expect(text(await call(desk.access_token, "set_opening_hours", { open: "08:00", close: "22:00" }))).toContain("This connection was not allowed venue:configure");
    // The desk's own playbook, not the manager's.
    expect(text(await call(desk.access_token, "my_playbook"))).toContain("for its front desk");
    // Annotations on the configuration tools.
    const listed = (await (await staff(all.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json()).result.tools as { name: string; annotations: Record<string, boolean> }[];
    expect(listed.find((t) => t.name === "set_opening_hours")!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    expect(listed.find((t) => t.name === "add_courts")!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
  });

  it("keeps configuration tools from API keys and from nobody", async () => {
    const k = await createApiKey(venueA, { name: "Write", scope: "write" }, null);
    if (!k.ok) throw new Error("key");
    const viaKey = async (body: unknown) =>
      (await mcpPost(new NextRequest(`${SITE}/api/mcp`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": address(), authorization: `Bearer ${k.key}` }, body: JSON.stringify(body) }))).json();
    const names = ((await viaKey({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools as { name: string }[]).map((t) => t.name);
    expect(names).not.toContain("set_opening_hours");
    const r = (await viaKey({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "set_opening_hours", arguments: { open: "08:00", close: "22:00" } } })).result;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("needs a member of staff signed in");
  });

  it("acts as the person: the one venue allowed, named in the staff log through the assistant, with the API's limits", async () => {
    const t = await signIn(managerCookie, venueA, ["venue:read", "venue:book"]);
    expect(data(await call(t.access_token, "my_venue")).id).toBe(venueA);
    const other = await createBooking({ courtId: courtB, date: day, start: 9 * 60, end: 10 * 60, name: "Elsewhere", phone: "0123999001" });
    if (!other.ok) throw new Error(other.error);
    expect(text(await call(t.access_token, "my_booking", { code: other.booking.code }))).toBe("Booking not found.");
    const preview = await call(t.access_token, "create_booking", { courtId: courtA, date: day, start: "10:00", end: "11:00", name: "Ali Assistant", phone: "0129990001" });
    expect(text(preview)).toContain("Nothing was booked");
    const made = data(await call(t.access_token, "create_booking", { courtId: courtA, date: day, start: "10:00", end: "11:00", name: "Ali Assistant", phone: "0129990001", confirm: true }));
    // Personal data still off by default for assistants.
    expect(made.booking.name).toBeUndefined();
    expect(text(await call(t.access_token, "create_booking", { courtId: courtA, date: day, start: "12:00", end: "13:00", name: "Override", phone: "0129990002", overridePolicies: true, confirm: true }))).toContain("R9_API_NO_OVERRIDE");
    const log = await listActivity([venueA], { limit: 20 });
    const booked = log.find((e) => e.action === "booking.created" && e.bookingCode === made.booking.code)!;
    expect(booked).toMatchObject({ adminName: "Maya Manager through Test Assistant (AI assistant)" });
    expect(booked.detail).toContain("by Maya Manager through Test Assistant (AI assistant)");
    const row = (await getDb().prepare("SELECT admin_id FROM staff_actions WHERE action = 'booking.created' AND booking_code = ?").get(made.booking.code)) as { admin_id: number };
    expect(row.admin_id).toBe(managerId);
    expect(log.some((e) => e.action === "mcp.staff_tool" && e.adminName === "Maya Manager through Test Assistant (AI assistant)" && (e.detail ?? "").startsWith("my_venue"))).toBe(true);
  });

  it("lets the platform owner act for one venue only, as its manager", async () => {
    const t = await signIn(ownerCookie, venueB, ["venue:read", "venue:configure"]);
    expect(data(await call(t.access_token, "my_venue")).id).toBe(venueB);
    const elsewhere = await call(t.access_token, "set_court_rates", { courtId: courtA, offPeakRate: 1, peakRate: 2 });
    expect(elsewhere.isError).toBe(true);
    expect(text(elsewhere)).toBe("You do not manage that venue.");
  });
});

describe("configuration tools", () => {
  it("previews without changing anything, applies only with the preview's token, and makes the change the dashboard's route makes", async () => {
    const t = await signIn(managerCookie, venueA, ["venue:configure"]);
    const before = await getVenue(venueA);
    const preview = data(await call(t.access_token, "set_opening_hours", { open: "08:00", close: "22:30" }));
    expect(preview.changes).toEqual(
      expect.arrayContaining([
        { setting: "openMin", from: 420, to: 480 },
        { setting: "closeMin", from: 1380, to: 1350 },
      ])
    );
    expect(preview.previewToken).toMatch(/^[0-9a-f]{40}$/);
    expect((await getVenue(venueA))!.openMin).toBe(before!.openMin);
    expect(text(await call(t.access_token, "set_opening_hours", { open: "08:00", close: "22:30", confirm: true }))).toContain("MCP_PREVIEW_FIRST");
    // Other arguments than were previewed: refused.
    expect(text(await call(t.access_token, "set_opening_hours", { open: "09:00", close: "22:30", confirm: true, previewToken: preview.previewToken }))).toContain("MCP_PREVIEW_STALE");
    const applied = data(await call(t.access_token, "set_opening_hours", { open: "08:00", close: "22:30", confirm: true, previewToken: preview.previewToken }));
    expect(applied.changes.length).toBeGreaterThan(0);
    const viaTool = await getVenue(venueA);
    expect([viaTool!.openMin, viaTool!.closeMin]).toEqual([480, 1350]);
    const log = await listActivity([venueA], { limit: 10 });
    expect(log.find((e) => e.action === "settings.changed")).toMatchObject({ adminName: "Maya Manager through Test Assistant (AI assistant)", detail: "Venue details: openMin, closeMin" });

    // The dashboard's own request, as the person, from the same starting point: the same saved state.
    expect((await venuePatch(adminReq("PATCH", `/api/admin/venues/${venueA}`, managerCookie, { openMin: 420, closeMin: 1380 }), { params: Promise.resolve({ id: String(venueA) }) })).status).toBe(200);
    expect((await venuePatch(adminReq("PATCH", `/api/admin/venues/${venueA}`, managerCookie, { openMin: "08:00", closeMin: "22:30" }), { params: Promise.resolve({ id: String(venueA) }) })).status).toBe(200);
    const viaDashboard = await getVenue(venueA);
    expect({ open: viaDashboard!.openMin, close: viaDashboard!.closeMin, week: viaDashboard!.weekHours ?? null }).toEqual({ open: viaTool!.openMin, close: viaTool!.closeMin, week: viaTool!.weekHours ?? null });
  });

  it("refuses a stale preview with the settings as they are now, and keeps the dashboard's refusals (bookings stranded)", async () => {
    const t = await signIn(managerCookie, venueA, ["venue:configure"]);
    const preview = data(await call(t.access_token, "set_court_rates", { courtId: courtA, offPeakRate: 25, peakRate: 35 }));
    expect(preview.changes).toEqual(expect.arrayContaining([{ setting: "offPeakRate", from: 20, to: 25 }]));
    // Somebody changes the court on the dashboard meanwhile.
    expect((await courtPatch(adminReq("PATCH", `/api/admin/courts/${courtA}`, managerCookie, { offPeakRate: 22, peakRate: 30 }), { params: Promise.resolve({ id: String(courtA) }) })).status).toBe(200);
    const stale = await call(t.access_token, "set_court_rates", { courtId: courtA, offPeakRate: 25, peakRate: 35, confirm: true, previewToken: preview.previewToken });
    expect(stale.isError).toBe(true);
    expect(text(stale)).toContain("MCP_PREVIEW_STALE");
    expect(JSON.parse(text(stale).split("\n\n")[1]).current).toMatchObject({ offPeakRate: 22, peakRate: 30 });
    expect((await getCourt(courtA))!.offPeakRate).toBe(22);

    // A booking at 21:00: closing at 20:00 would strand it, refused in the dashboard's words with the booking listed.
    const late = await createBooking({ courtId: courtA, date: day, start: 21 * 60, end: 22 * 60, name: "Late Player", phone: "0127770001" });
    if (!late.ok) throw new Error(late.error);
    const refused = await call(t.access_token, "set_opening_hours", { open: "08:00", close: "20:00" });
    expect(refused.isError).toBe(true);
    const dashboard = await venuePatch(adminReq("PATCH", `/api/admin/venues/${venueA}`, managerCookie, { openMin: 480, closeMin: 1200 }), { params: Promise.resolve({ id: String(venueA) }) });
    const said = (await dashboard.json()) as { error: string; stranded: { code: string }[] };
    expect(dashboard.status).toBe(400);
    expect(text(refused).split("\n\n")[0]).toBe(said.error);
    expect(JSON.parse(text(refused).split("\n\n")[1]).stranded.map((s: { code: string }) => s.code)).toContain(late.booking.code);
    expect((await getVenue(venueA))!.closeMin).not.toBe(1200);
  });

  it("schedules hours and rates from a date as the dashboard does, shown in the playbook's Coming later", async () => {
    const t = await signIn(managerCookie, venueA, ["venue:configure"]);
    const rates = data(await call(t.access_token, "set_court_rates", { courtId: courtA, offPeakRate: 40, peakRate: 50, from: later }));
    data(await call(t.access_token, "set_court_rates", { courtId: courtA, offPeakRate: 40, peakRate: 50, from: later, confirm: true, previewToken: rates.previewToken }));
    const hours = data(await call(t.access_token, "set_opening_hours", { open: "06:00", close: "23:00", from: later }));
    expect(hours.note).toContain("Coming later");
    data(await call(t.access_token, "set_opening_hours", { open: "06:00", close: "23:00", from: later, confirm: true, previewToken: hours.previewToken }));
    expect((await listCourtChanges(venueA)).find((c) => c.courtId === courtA)!.rates).toEqual([expect.objectContaining({ from: later, offPeakRate: 40, peakRate: 50 })]);
    expect(await listHoursChanges(venueA)).toEqual([expect.objectContaining({ from: later, openMin: 360, closeMin: 1380 })]);
    const book = await playbookFor(venueA, "manager");
    expect(book.scheduled.map((s) => s.kind).sort()).toEqual(["hours", "rates"]);
    expect(book.sections.flatMap((s) => s.blocks.filter((b) => b.type === "callout" && b.kind === "scheduled")).length).toBe(2);
    const log = await listActivity([venueA], { limit: 10 });
    expect(log.filter((e) => ["rates.scheduled", "hours.scheduled"].includes(e.action)).every((e) => e.adminName === "Maya Manager through Test Assistant (AI assistant)")).toBe(true);
  });

  it("adds courts, sets peak hours, booking rules, cancellation terms and setup answers through the journey's own routes", async () => {
    const t = await signIn(managerCookie, venueA, ["venue:configure"]);
    const apply = async (name: string, args: Record<string, unknown>) => {
      const p = data(await call(t.access_token, name, args));
      return data(await call(t.access_token, name, { ...args, confirm: true, previewToken: p.previewToken }));
    };
    const before = (await getVenue(venueA))!.courts.length;
    await apply("add_courts", { sport: "badminton", count: 2, offPeakRate: 18, peakRate: 28 });
    expect((await getVenue(venueA))!.courts.length).toBe(before + 2);
    expect((await listActivity([venueA], { limit: 5 })).filter((e) => e.action === "court.created").every((e) => e.adminName.includes("through Test Assistant"))).toBe(true);

    await apply("set_peak_hours", { weekdayFrom: "17:00", weekdayUntil: "22:00", weekendDays: [0, 6], weekendFrom: "08:00", weekendUntil: "22:00" });
    await apply("set_booking_rules", { level: "venue", settings: { noticeMinutes: 60 } });
    expect(text(await call(t.access_token, "set_booking_rules", { level: "business", settings: {} }))).toBe("level is venue, sport or court.");

    const terms = await apply("set_cancellation_terms", { cutoffHours: 12, lateKeep: 50, reviewed: true });
    expect(terms.changes).toEqual(expect.arrayContaining([{ setting: "cutoffHours", from: expect.any(Number), to: 12 }, { setting: "policy.lateKeep", from: null, to: 50 }, { setting: "reviewed", from: false, to: true }]));
    expect((await cancelPolicy(venueA)).lateKeep).toBe(50);
    expect((await readGuide(venueA)).acknowledged["cancellation-terms"]).toMatchObject({ byName: "Maya Manager through Test Assistant (AI assistant)" });

    const rev = (await readGuide(venueA)).rev;
    await apply("save_setup_answers", { answers: { staffing: "staffed" }, rev });
    expect((await readGuide(venueA)).answers.staffing).toBe("staffed");
    // On top of a revision somebody has since moved on: the journey's own refusal.
    const stale = await call(t.access_token, "save_setup_answers", { answers: { staffing: "partial" }, rev });
    expect(stale.isError).toBe(true);
    expect(text(stale)).toContain("Somebody saved the guide's answers");
  });
});

describe("the dashboard's list of connected assistants", () => {
  it("shows a member of staff their own, a manager also the venue's, and either may revoke what they see, logged", async () => {
    const desk = await signIn(deskCookie, venueA, ["venue:read"]);
    const listAs = async (cookie: string) => ((await (await assistantsGet(get("/api/admin/assistants", cookie))).json()).assistants as { id: number; venueId: number; personName: string; mine: boolean }[]);
    const deskSees = await listAs(deskCookie);
    expect(deskSees.every((a) => a.personName === "Dan Desk" && a.mine)).toBe(true);
    const managerSees = await listAs(managerCookie);
    expect(managerSees.some((a) => a.personName === "Dan Desk" && !a.mine)).toBe(true);
    // Another venue's manager sees that venue's (the owner's connection there), never this one's.
    expect((await listAs(otherManagerCookie)).every((a) => a.venueId === venueB && a.personName !== "Dan Desk")).toBe(true);
    const target = deskSees[0];
    // Another venue's manager cannot.
    expect((await assistantsPost(adminReq("POST", "/api/admin/assistants", otherManagerCookie, { action: "revoke", id: target.id }))).status).toBe(404);
    expect((await assistantsPost(adminReq("POST", "/api/admin/assistants", managerCookie, { action: "revoke", id: target.id }))).status).toBe(200);
    expect((await staff(desk.access_token, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
    expect((await listActivity([venueA], { limit: 5 })).find((e) => e.action === "oauth.revoked")).toMatchObject({ adminName: "Maya Manager" });
  });
});
