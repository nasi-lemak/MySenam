import crypto from "crypto";
import { logAction } from "../activity";
import { canAccessVenue, getAdminById, isOwner, type Admin } from "../admin-auth";
import { getDb, withTransaction } from "../db";
import { baseUrl } from "../outbox";
import type { StaffRole } from "../roles";
import { siteName } from "../site";
import { hasTwoFactor, twoFactorRequired } from "../two-factor";

/**
 * The authorization server for signing a member of staff in to the MCP
 * server from an AI provider's connector (docs/integrations/mcp.md#signing-in-from-an-ai-assistant,
 * ADR 0030): OAuth 2.1 with the parts the MCP authorization specification
 * names, inside the app, with no service of its own.
 *
 * - Discovery: protected-resource metadata (RFC 9728) for the signed-in MCP
 *   address, and authorization-server metadata (RFC 8414).
 * - Dynamic client registration (RFC 7591), public clients only: no secret.
 *   A client's name is its own word, shown as an unverified name; it may go
 *   back only to the exact addresses it registered (https, or http on the
 *   same computer).
 * - The `code` grant with PKCE S256 required, and `refresh_token`. Every
 *   token is random and opaque and only its SHA-256 is kept, as API keys
 *   are. Access tokens last an hour; refresh tokens are replaced on each use,
 *   and one used twice ends the grant (RFC 9700's reuse detection).
 * - Audience: tokens are for the signed-in MCP address alone (RFC 8707
 *   `resource`); presented anywhere else they are refused.
 * - A grant is one member of staff, one venue, the role they had there when
 *   they allowed it, and the scopes they allowed. It is checked against their
 *   staff record as it is now on every call; removed, without the venue, or
 *   with a lower role there, the grant ends.
 */

export const OAUTH_SCOPES = ["venue:read", "venue:book", "venue:configure"] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];
/** What a client that asks for nothing is given. */
export const DEFAULT_SCOPES: readonly OAuthScope[] = ["venue:read"];

export const isScope = (s: string): s is OAuthScope => (OAUTH_SCOPES as readonly string[]).includes(s);

/** What a member of staff in a role may allow an assistant: front desk what front desk does; changing settings is a manager's. */
export function grantableScopes(role: StaffRole): OAuthScope[] {
  return role === "desk" ? ["venue:read", "venue:book"] : [...OAUTH_SCOPES];
}

export const ACCESS_SECONDS = 3600;
export const REFRESH_DAYS = 30;
export const CODE_SECONDS = 300;
export const MAX_REDIRECT_URIS = 5;
export const MAX_CLIENT_NAME = 80;

/** The signed-in MCP address, the one resource tokens are for. */
export const MCP_STAFF_PATH = "/api/mcp/staff";
export const issuer = (): string => baseUrl();
export const mcpResource = (): string => `${baseUrl()}${MCP_STAFF_PATH}`;
export const resourceMetadataUrl = (): string => `${baseUrl()}/.well-known/oauth-protected-resource${MCP_STAFF_PATH}`;

/** RFC 9728: what the signed-in MCP address is and who signs people in to it. */
export function protectedResourceMetadata(): Record<string, unknown> {
  return {
    resource: mcpResource(),
    authorization_servers: [issuer()],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: `${siteName()} (signed in as a member of staff)`,
    resource_documentation: `${baseUrl()}/for-venues`,
  };
}

/** RFC 8414: where to register, sign in, exchange and revoke. */
export function authorizationServerMetadata(): Record<string, unknown> {
  const site = baseUrl();
  return {
    issuer: issuer(),
    authorization_endpoint: `${site}/oauth/authorize`,
    token_endpoint: `${site}/api/oauth/token`,
    registration_endpoint: `${site}/api/oauth/register`,
    revocation_endpoint: `${site}/api/oauth/revoke`,
    scopes_supported: [...OAUTH_SCOPES],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
  };
}

const sha256 = (value: string): string => crypto.createHash("sha256").update(value, "utf8").digest("hex");
const random = (bytes = 32): string => crypto.randomBytes(bytes).toString("base64url");
/** Control characters and the bidirectional overrides a name could use to pass for another. */
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;

// ------------------------------------------------------------------ clients

export interface Client {
  id: number;
  clientId: string;
  name: string;
  redirectUris: string[];
}

interface ClientRow {
  id: number;
  client_id: string;
  name: string;
  redirect_uris: string[] | string;
}

const toClient = (r: ClientRow): Client => ({
  id: r.id,
  clientId: r.client_id,
  name: r.name,
  redirectUris: typeof r.redirect_uris === "string" ? (JSON.parse(r.redirect_uris) as string[]) : r.redirect_uris,
});

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Why an address may not be a redirect URI, or null: https with a host, or http on the same computer; never a fragment or a user. */
export function redirectUriProblem(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 500) return "Each redirect URI is an address of at most 500 characters.";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `${raw.slice(0, 100)} is not an address.`;
  }
  if (url.hash || raw.includes("#")) return "A redirect URI has no fragment (#).";
  if (url.username || url.password) return "A redirect URI carries no user name or password.";
  if (url.protocol === "https:" && url.hostname) return null;
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return null;
  return "A redirect URI is https, or http on this computer (localhost, 127.0.0.1 or [::1]).";
}

export type Registered = { ok: true; client: Client; response: Record<string, unknown> } | { ok: false; error: string; description: string };

/**
 * RFC 7591: a client registers itself. Public clients only: whatever
 * authentication method it asks for, it is told `none` and given no secret,
 * as the specification lets a server do.
 */
export async function registerClient(meta: Record<string, unknown>): Promise<Registered> {
  const bad = (description: string): Registered => ({ ok: false, error: "invalid_client_metadata", description });
  const uris = meta.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) return { ok: false, error: "invalid_redirect_uri", description: "redirect_uris is a list of one or more addresses." };
  if (uris.length > MAX_REDIRECT_URIS) return { ok: false, error: "invalid_redirect_uri", description: `At most ${MAX_REDIRECT_URIS} redirect URIs.` };
  for (const u of uris) {
    const problem = redirectUriProblem(u);
    if (problem) return { ok: false, error: "invalid_redirect_uri", description: problem };
  }
  const grantTypes = meta.grant_types ?? ["authorization_code", "refresh_token"];
  if (!Array.isArray(grantTypes) || !grantTypes.includes("authorization_code") || !grantTypes.every((g) => g === "authorization_code" || g === "refresh_token"))
    return bad("grant_types are authorization_code and refresh_token.");
  const responseTypes = meta.response_types ?? ["code"];
  if (!Array.isArray(responseTypes) || responseTypes.length !== 1 || responseTypes[0] !== "code") return bad("response_types is [\"code\"].");
  if (meta.client_name !== undefined && typeof meta.client_name !== "string") return bad("client_name is text.");
  const name = (typeof meta.client_name === "string" ? meta.client_name.replace(UNPRINTABLE, "").trim().slice(0, MAX_CLIENT_NAME) : "") || "An unnamed application";
  const clientUri = typeof meta.client_uri === "string" && /^https:\/\/[^\s#]+$/.test(meta.client_uri) && meta.client_uri.length <= 300 ? meta.client_uri : null;
  const clientId = `mcp_${random(24)}`;
  const row = (await getDb()
    .prepare("INSERT INTO oauth_clients (client_id, name, redirect_uris, client_uri) VALUES (?, ?, ?, ?) RETURNING id, client_id, name, redirect_uris")
    .get(clientId, name, JSON.stringify(uris), clientUri)) as ClientRow;
  const client = toClient(row);
  return {
    ok: true,
    client,
    response: {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      ...(clientUri ? { client_uri: clientUri } : {}),
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  };
}

export async function clientById(clientId: string): Promise<Client | null> {
  if (!/^mcp_[A-Za-z0-9_-]{20,64}$/.test(clientId)) return null;
  const row = (await getDb().prepare("SELECT id, client_id, name, redirect_uris FROM oauth_clients WHERE client_id = ?").get(clientId)) as ClientRow | undefined;
  return row ? toClient(row) : null;
}

// ------------------------------------------------------------------ the authorization request

export interface AuthRequest {
  client: Client;
  redirectUri: string;
  state: string | null;
  scopes: OAuthScope[];
  challenge: string;
  resource: string;
}

/**
 * The request read, or what to do instead: a problem shown on the page and
 * never sent anywhere (the client or its address is not known: sending the
 * browser to an address the request named would be an open redirect), or an
 * error sent back to the client's own registered address.
 */
export type ReadRequest =
  | { ok: true; request: AuthRequest }
  | { ok: false; kind: "page"; problem: "client" | "redirect"; description: string }
  | { ok: false; kind: "redirect"; redirect: string };

/** The client's address with an OAuth error (RFC 6749 4.1.2.1), the state echoed and the issuer named (RFC 9207). */
export function errorRedirect(redirectUri: string, error: string, description: string, state: string | null): string {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state !== null) url.searchParams.set("state", state);
  url.searchParams.set("iss", issuer());
  return url.toString();
}

/** Whether `asked` names the signed-in MCP address (a trailing slash allowed). */
export const isOurResource = (asked: string): boolean => asked.replace(/\/+$/, "") === mcpResource();

/** Read `response_type`, `client_id`, `redirect_uri`, `state`, `scope`, `code_challenge(_method)` and `resource`. */
export async function readAuthorizationRequest(get: (name: string) => string | null | undefined): Promise<ReadRequest> {
  const clientId = get("client_id") ?? "";
  const client = await clientById(clientId);
  if (!client) return { ok: false, kind: "page", problem: "client", description: "The application asking is not registered here." };
  const redirectUri = get("redirect_uri") ?? "";
  // Exactly as registered, character for character: nothing else is ever an address the browser is sent to.
  if (!client.redirectUris.includes(redirectUri)) return { ok: false, kind: "page", problem: "redirect", description: "The address to return to is not one the application registered." };
  const rawState = get("state");
  const state = rawState === null || rawState === undefined ? null : rawState.slice(0, 500);
  const back = (error: string, description: string): ReadRequest => ({ ok: false, kind: "redirect", redirect: errorRedirect(redirectUri, error, description, state) });
  if (get("response_type") !== "code") return back("unsupported_response_type", "Only response_type=code is supported.");
  const challenge = get("code_challenge") ?? "";
  if (get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge))
    return back("invalid_request", "PKCE is required: code_challenge with code_challenge_method=S256.");
  const asked = (get("scope") ?? "").split(" ").filter(Boolean);
  const unknown = asked.filter((s) => !isScope(s));
  if (unknown.length > 0) return back("invalid_scope", `Unknown scope: ${unknown.join(" ").slice(0, 100)}. Scopes: ${OAUTH_SCOPES.join(" ")}.`);
  const scopes = asked.length > 0 ? OAUTH_SCOPES.filter((s) => asked.includes(s)) : [...DEFAULT_SCOPES];
  const resource = get("resource");
  if (resource !== null && resource !== undefined && !isOurResource(resource))
    return back("invalid_target", `Tokens here are only for ${mcpResource()}.`);
  return { ok: true, request: { client, redirectUri, state, scopes, challenge, resource: mcpResource() } };
}

/** The role this member of staff has at a venue now, or null where they may not manage it (lib/admin-auth.ts). */
export function roleAt(admin: Admin, venueId: number): StaffRole | null {
  return canAccessVenue(admin, venueId) ? admin.role : null;
}

const RANK: Record<StaffRole, number> = { desk: 0, manager: 1 };

/** The venues a member of staff may choose to connect an assistant to, with their role at each. */
export async function venuesToChoose(admin: Admin): Promise<{ id: number; name: string; role: StaffRole }[]> {
  const rows = isOwner(admin)
    ? ((await getDb().prepare("SELECT id, name FROM venues ORDER BY name, id").all()) as { id: number; name: string }[])
    : (admin.venueIds ?? []).length === 0
      ? []
      : ((await getDb()
          .prepare(`SELECT id, name FROM venues WHERE id IN (${(admin.venueIds ?? []).map(() => "?").join(",")}) ORDER BY name, id`)
          .all(...(admin.venueIds ?? []))) as { id: number; name: string }[]);
  return rows.map((v) => ({ ...v, role: admin.role }));
}

export type Decision = { ok: true; redirect: string } | { ok: false; status: number; error: string };

/**
 * What a signed-in member of staff decided on the consent page. Allowed: a
 * code for the one venue chosen and the scopes ticked, each of them one the
 * request asked for and their role there may grant; the browser goes back to
 * the client's registered address with it. Denied: back with `access_denied`.
 */
export async function decide(
  admin: Admin,
  request: AuthRequest,
  choice: { allow: boolean; venueId: unknown; scopes: unknown }
): Promise<Decision> {
  if (!choice.allow) return { ok: true, redirect: errorRedirect(request.redirectUri, "access_denied", "The member of staff did not allow it.", request.state) };
  const venueId = Number(choice.venueId);
  const role = Number.isInteger(venueId) && venueId > 0 ? roleAt(admin, venueId) : null;
  if (role === null) return { ok: false, status: 403, error: "You do not manage that venue." };
  const ticked = Array.isArray(choice.scopes) ? choice.scopes.filter((s): s is string => typeof s === "string") : [...request.scopes];
  const allowed = grantableScopes(role);
  for (const s of ticked) {
    if (!isScope(s) || !request.scopes.includes(s)) return { ok: false, status: 400, error: "Allow only what the application asked for." };
    if (!allowed.includes(s)) return { ok: false, status: 403, error: "Front-desk accounts cannot allow an assistant to change the venue's settings. Ask a manager." };
  }
  const scopes = OAUTH_SCOPES.filter((s) => ticked.includes(s));
  if (scopes.length === 0) return { ok: false, status: 400, error: "Allow at least one thing, or deny." };
  const code = `msc_${random()}`;
  await getDb().prepare("DELETE FROM oauth_codes WHERE expires_at < datetime('now', '-1 day')").run();
  await getDb()
    .prepare(
      `INSERT INTO oauth_codes (code_hash, client_id, admin_id, venue_id, role, scopes, resource, redirect_uri, code_challenge, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+${CODE_SECONDS} seconds'))`
    )
    .run(sha256(code), request.client.id, admin.id, venueId, role, scopes.join(" "), request.resource, request.redirectUri, request.challenge);
  await logAction(admin, {
    venueId,
    action: "oauth.granted",
    detail: `${request.client.name} (name not verified), returning to ${new URL(request.redirectUri).host}: ${scopes.join(", ")}`,
  });
  const url = new URL(request.redirectUri);
  url.searchParams.set("code", code);
  if (request.state !== null) url.searchParams.set("state", request.state);
  url.searchParams.set("iss", issuer());
  return { ok: true, redirect: url.toString() };
}

// ------------------------------------------------------------------ tokens

export interface TokenBody {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export type TokenResult = { ok: true; body: TokenBody } | { ok: false; status: number; error: string; description: string };

const invalidGrant = (description: string): TokenResult => ({ ok: false, status: 400, error: "invalid_grant", description });

async function issueTokens(grantId: number, scopes: string): Promise<TokenBody> {
  const db = getDb();
  await db.prepare("DELETE FROM oauth_tokens WHERE expires_at < datetime('now')").run();
  const access = `msa_${random()}`;
  const refresh = `msr_${random()}`;
  await db.prepare(`INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at) VALUES (?, ?, 'access', datetime('now', '+${ACCESS_SECONDS} seconds'))`).run(sha256(access), grantId);
  await db.prepare(`INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at) VALUES (?, ?, 'refresh', datetime('now', '+${REFRESH_DAYS} days'))`).run(sha256(refresh), grantId);
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_SECONDS, refresh_token: refresh, scope: scopes };
}

interface GrantRow {
  id: number;
  client_id: number;
  admin_id: number;
  venue_id: number;
  role: StaffRole;
  scopes: string;
  resource: string;
  revoked_at: string | null;
  last_used_at: string | null;
  client_name: string;
  public_client_id: string;
}

const GRANT_COLUMNS = `g.id, g.client_id, g.admin_id, g.venue_id, g.role, g.scopes, g.resource, g.revoked_at, g.last_used_at,
  c.name AS client_name, c.client_id AS public_client_id`;
const GRANT_FROM = "oauth_grants g JOIN oauth_clients c ON c.id = g.client_id";
const GRANT_SELECT = `SELECT ${GRANT_COLUMNS} FROM ${GRANT_FROM}`;

/** End a grant, with why: every token of it stops working at once. */
export async function endGrant(grantId: number, reason: string): Promise<boolean> {
  const done = await getDb().prepare("UPDATE oauth_grants SET revoked_at = datetime('now'), revoked_reason = ? WHERE id = ? AND revoked_at IS NULL").run(reason.slice(0, 200), grantId);
  return done.changes === 1;
}

/** End a grant on the server's own account (a refresh token used twice, a person no longer at the venue), in the venue's staff log. */
async function endGrantForCause(g: Pick<GrantRow, "id" | "venue_id" | "client_name">, reason: string): Promise<void> {
  if (await endGrant(g.id, reason)) await logAction({ id: null, name: siteName() }, { venueId: g.venue_id, action: "oauth.revoked", detail: `${g.client_name}: ${reason}` });
}

/** Why the person behind a grant may no longer act through it, or null while they may, with their current record and role. */
async function personNow(g: Pick<GrantRow, "admin_id" | "venue_id" | "role">): Promise<{ ok: true; admin: Admin; role: StaffRole } | { ok: false; reason: string; end: boolean }> {
  const admin = await getAdminById(g.admin_id);
  if (!admin) return { ok: false, reason: "the staff account was removed", end: true };
  const role = roleAt(admin, g.venue_id);
  if (role === null) return { ok: false, reason: "the member of staff no longer works at the venue", end: true };
  if (RANK[role] < RANK[g.role]) return { ok: false, reason: "the member of staff's role at the venue changed", end: true };
  // Where the install requires two-factor sign-in, an account without it acts as nobody's staff (lib/admin-auth.ts), here too.
  if (twoFactorRequired(admin) && !(await hasTwoFactor(admin.id))) return { ok: false, reason: "two-factor sign-in is required and not set up", end: false };
  return { ok: true, admin, role };
}

/** `grant_type=authorization_code`: the code once, with its PKCE verifier, for the client it was given to. */
export async function exchangeCode(form: URLSearchParams): Promise<TokenResult> {
  const code = form.get("code") ?? "";
  const verifier = form.get("code_verifier") ?? "";
  if (!code || !verifier) return { ok: false, status: 400, error: "invalid_request", description: "code and code_verifier are required." };
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return { ok: false, status: 400, error: "invalid_request", description: "code_verifier is 43 to 128 unreserved characters." };
  return withTransaction(async () => {
    const db = getDb();
    // Used up as it is read, so two exchanges at once cannot both succeed.
    const row = (await db.prepare("UPDATE oauth_codes SET used_at = datetime('now') WHERE code_hash = ? AND used_at IS NULL RETURNING *").get(sha256(code))) as
      | { client_id: number; admin_id: number; venue_id: number; role: StaffRole; scopes: string; resource: string; redirect_uri: string; code_challenge: string; expires_at: string }
      | undefined;
    if (!row) {
      // A code used a second time: whatever the first use was given ends (RFC 6749 4.1.2).
      const used = (await db.prepare(`SELECT c.grant_id, g.venue_id, k.name AS client_name FROM oauth_codes c JOIN oauth_clients k ON k.id = c.client_id
        LEFT JOIN oauth_grants g ON g.id = c.grant_id WHERE c.code_hash = ?`).get(sha256(code))) as { grant_id: number | null; venue_id: number | null; client_name: string } | undefined;
      if (used?.grant_id && used.venue_id !== null) await endGrantForCause({ id: used.grant_id, venue_id: used.venue_id, client_name: used.client_name }, "a sign-in code was used twice");
      return invalidGrant("The code is not valid, or was used already.");
    }
    const client = (await db.prepare("SELECT client_id FROM oauth_clients WHERE id = ?").get(row.client_id)) as { client_id: string };
    if (form.get("client_id") !== client.client_id) return invalidGrant("The code was given to another client.");
    if (form.get("redirect_uri") !== row.redirect_uri) return invalidGrant("redirect_uri is not the one the code was given for.");
    if (row.expires_at < ((await db.prepare("SELECT datetime('now') AS now").get()) as { now: string }).now) return invalidGrant("The code has expired.");
    if (crypto.createHash("sha256").update(verifier, "ascii").digest("base64url") !== row.code_challenge) return invalidGrant("The code_verifier does not match.");
    const resource = form.get("resource");
    if (resource !== null && (!isOurResource(resource) || resource.replace(/\/+$/, "") !== row.resource)) return { ok: false, status: 400, error: "invalid_target", description: `Tokens here are only for ${row.resource}.` };
    const now = await personNow(row);
    if (!now.ok) return invalidGrant(`The sign-in no longer holds: ${now.reason}.`);
    const grant = (await db
      .prepare("INSERT INTO oauth_grants (client_id, admin_id, venue_id, role, scopes, resource, last_used_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now')) RETURNING id")
      .get(row.client_id, row.admin_id, row.venue_id, row.role, row.scopes, row.resource)) as { id: number };
    await db.prepare("UPDATE oauth_codes SET grant_id = ? WHERE code_hash = ?").run(grant.id, sha256(code));
    await db.prepare("UPDATE oauth_clients SET last_used_at = datetime('now') WHERE id = ?").run(row.client_id);
    return { ok: true, body: await issueTokens(grant.id, row.scopes) };
  });
}

/** `grant_type=refresh_token`: a new pair for the old refresh token, which is used up; one used twice ends the grant. */
export async function refreshTokens(form: URLSearchParams): Promise<TokenResult> {
  const token = form.get("refresh_token") ?? "";
  if (!token) return { ok: false, status: 400, error: "invalid_request", description: "refresh_token is required." };
  return withTransaction(async () => {
    const db = getDb();
    const used = (await db
      .prepare("UPDATE oauth_tokens SET used_at = datetime('now') WHERE token_hash = ? AND kind = 'refresh' AND used_at IS NULL RETURNING grant_id, expires_at")
      .get(sha256(token))) as { grant_id: number; expires_at: string } | undefined;
    if (!used) {
      const seen = (await db.prepare("SELECT grant_id FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'").get(sha256(token))) as { grant_id: number } | undefined;
      if (seen) {
        const g = (await db.prepare(`${GRANT_SELECT} WHERE g.id = ?`).get(seen.grant_id)) as GrantRow;
        await endGrantForCause(g, "a refresh token was used twice");
      }
      return invalidGrant("The refresh token is not valid, or was used already.");
    }
    const g = (await db.prepare(`${GRANT_SELECT} WHERE g.id = ?`).get(used.grant_id)) as GrantRow;
    if (g.revoked_at) return invalidGrant("The connection was revoked.");
    if (form.get("client_id") !== g.public_client_id) return invalidGrant("The refresh token was given to another client.");
    if (used.expires_at < ((await db.prepare("SELECT datetime('now') AS now").get()) as { now: string }).now) return invalidGrant("The refresh token has expired.");
    const asked = (form.get("scope") ?? "").split(" ").filter(Boolean);
    const held = g.scopes.split(" ");
    if (asked.some((s) => !held.includes(s))) return { ok: false, status: 400, error: "invalid_scope", description: "A refresh cannot add scopes; sign in again for more." };
    const resource = form.get("resource");
    if (resource !== null && resource.replace(/\/+$/, "") !== g.resource) return { ok: false, status: 400, error: "invalid_target", description: `Tokens here are only for ${g.resource}.` };
    const now = await personNow(g);
    if (!now.ok) {
      if (now.end) await endGrantForCause(g, now.reason);
      return invalidGrant(`The connection no longer holds: ${now.reason}.`);
    }
    return { ok: true, body: await issueTokens(g.id, g.scopes) };
  });
}

/** RFC 7009: the token's grant ends, whichever of its tokens is sent; an unknown token, or another client's, changes nothing. */
export async function revokeToken(form: URLSearchParams): Promise<void> {
  const token = form.get("token") ?? "";
  if (!token) return;
  const row = (await getDb()
    .prepare(`SELECT g.id, g.venue_id, c.name AS client_name, c.client_id AS public_client_id FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
      JOIN oauth_clients c ON c.id = g.client_id WHERE t.token_hash = ?`)
    .get(sha256(token))) as { id: number; venue_id: number; client_name: string; public_client_id: string } | undefined;
  if (!row) return;
  const clientId = form.get("client_id");
  if (clientId !== null && clientId !== row.public_client_id) return;
  if (await endGrant(row.id, "revoked by the application"))
    await logAction({ id: null, name: row.client_name }, { venueId: row.venue_id, action: "oauth.revoked", detail: `${row.client_name}: revoked by the application` });
}

// ------------------------------------------------------------------ calling the MCP server

/** Somebody signed in through an assistant, as the MCP server acts for them on one call. */
export interface PersonCaller {
  grantId: number;
  clientName: string;
  adminId: number;
  venueId: number;
  /** Their role at the venue now, from their staff record. */
  role: StaffRole;
  scopes: OAuthScope[];
  /**
   * Their staff record as it is now, narrowed to the one venue and named as
   * acting through the assistant, for the dashboard's route handlers
   * (lib/admin-auth.ts `asDelegate`) and the staff activity log.
   */
  acting: Admin;
}

/** How the staff activity log names a member of staff acting through an assistant. */
export const throughAssistant = (name: string, client: string): string => `${name} through ${client} (AI assistant)`;

export type Verified = { ok: true; person: PersonCaller } | { ok: false; description: string };

/** An access token presented to the signed-in MCP address: valid, unexpired, for this address, its grant live and its person still allowed. */
export async function personFromToken(token: string, resource: string): Promise<Verified> {
  if (!/^msa_[A-Za-z0-9_-]{30,64}$/.test(token)) return { ok: false, description: "That is not an access token from this server." };
  const db = getDb();
  const row = (await db
    .prepare(`SELECT ${GRANT_COLUMNS}, t.expires_at < datetime('now') AS expired FROM ${GRANT_FROM} JOIN oauth_tokens t ON t.grant_id = g.id WHERE t.token_hash = ? AND t.kind = 'access'`)
    .get(sha256(token))) as (GrantRow & { expired: boolean }) | undefined;
  if (!row) return { ok: false, description: "The access token is not valid." };
  if (row.expired) return { ok: false, description: "The access token has expired." };
  if (row.revoked_at) return { ok: false, description: "The connection was revoked." };
  if (row.resource !== resource) return { ok: false, description: "The access token is not for this address." };
  const now = await personNow(row);
  if (!now.ok) {
    if (now.end) await endGrantForCause(row, now.reason);
    return { ok: false, description: `The connection no longer holds: ${now.reason}.` };
  }
  // Written at most once a minute, as an API key's.
  if (!row.last_used_at || Date.parse(`${row.last_used_at.replace(" ", "T")}Z`) < Date.now() - 60_000)
    await db.prepare("UPDATE oauth_grants SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
  const { admin, role } = now;
  const acting: Admin = {
    ...admin,
    name: throughAssistant(admin.name, row.client_name),
    // The one venue allowed. The platform owner acts as a manager of that venue, not as the owner of every one.
    venueId: isOwner(admin) ? row.venue_id : admin.venueId,
    venueIds: [row.venue_id],
    role,
  };
  return {
    ok: true,
    person: { grantId: row.id, clientName: row.client_name, adminId: admin.id, venueId: row.venue_id, role, scopes: row.scopes.split(" ").filter(isScope), acting },
  };
}

// ------------------------------------------------------------------ the dashboard's list

export interface AssistantGrant {
  id: number;
  clientName: string;
  venueId: number;
  venueName: string;
  adminId: number;
  personName: string;
  role: StaffRole;
  scopes: OAuthScope[];
  createdAt: string;
  lastUsedAt: string | null;
  mine: boolean;
}

/** The live connections a member of staff sees: their own, and a manager also every one at the venues they manage. */
export async function grantsFor(admin: Admin): Promise<AssistantGrant[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT g.id, c.name AS client_name, g.venue_id, v.name AS venue_name, g.admin_id, a.name AS person_name, g.role, g.scopes, g.created_at, g.last_used_at
         FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id JOIN venues v ON v.id = g.venue_id JOIN admins a ON a.id = g.admin_id
        WHERE g.revoked_at IS NULL ORDER BY g.id DESC`
    )
    .all()) as { id: number; client_name: string; venue_id: number; venue_name: string; admin_id: number; person_name: string; role: StaffRole; scopes: string; created_at: string; last_used_at: string | null }[];
  return rows
    .filter((r) => r.admin_id === admin.id || (admin.role === "manager" && canAccessVenue(admin, r.venue_id)))
    .map((r) => ({
      id: r.id,
      clientName: r.client_name,
      venueId: r.venue_id,
      venueName: r.venue_name,
      adminId: r.admin_id,
      personName: r.person_name,
      role: r.role,
      scopes: r.scopes.split(" ").filter(isScope),
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      mine: r.admin_id === admin.id,
    }));
}

/** Revoke a connection from the dashboard: one's own, or as a manager one at a venue one manages. Logged. */
export async function revokeGrantAs(admin: Admin, id: number): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const grant = (await grantsFor(admin)).find((g) => g.id === id);
  if (!grant) return { ok: false, status: 404, error: "That connection is not one you can see." };
  if (await endGrant(id, `revoked by ${admin.name}`))
    await logAction(admin, { venueId: grant.venueId, action: "oauth.revoked", detail: `${grant.clientName}, connected by ${grant.personName}` });
  return { ok: true };
}
