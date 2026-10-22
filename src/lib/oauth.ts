import crypto from "crypto";
import { getDb } from "./db";
import { baseUrl } from "./outbox";

/**
 * Signing in with Google, for customers.
 *
 * The OpenID Connect authorisation-code flow, with PKCE, a `state` to tie
 * the answer to the browser that asked, and a `nonce` to tie the ID token to
 * this request. The ID token comes straight from Google's token endpoint over
 * TLS, which is what lets its claims be trusted without checking its
 * signature against Google's keys (OpenID Connect Core, 3.1.3.7); its issuer,
 * audience, expiry and nonce are still checked.
 *
 * An account is found by Google's own id for the person, which never
 * changes. The first time, an existing account with the same email is joined
 * to it — only if Google says it has verified that email, or anybody could
 * make a Google account with somebody else's address and walk into theirs.
 * Joining it clears the account's password and signs it out everywhere, since
 * that password was set by whoever registered the address, not necessarily
 * its owner.
 * Otherwise a new account is made, with no password and no phone number yet:
 * the number is asked for, and checked, before anything that needs it.
 *
 * GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET turn it on; the address to give
 * Google as the redirect is `<MYSENAM_URL>/api/auth/google/callback`.
 */

const AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export const OAUTH_COOKIE = "ms_oauth";
export const OAUTH_COOKIE_MINUTES = 10;

export function googleConfig(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function googleRedirectUri(): string {
  return `${baseUrl()}/api/auth/google/callback`;
}

/**
 * Google sends people back to the one address registered with it, so the
 * button is offered only there — not on a venue's own storefront domain,
 * where the sign-in would land on another site's cookie.
 */
export function googleOfferedAt(host: string | null): boolean {
  if (!googleConfig() || !host) return false;
  try {
    return new URL(baseUrl()).host === host;
  } catch {
    return false;
  }
}

/** Only a path on this site: never somewhere else, never `//elsewhere`. */
export function safeNext(next: string | null | undefined): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next.slice(0, 500) : "/account";
}

const b64url = (buf: Buffer) => buf.toString("base64url");

export interface PendingSignIn {
  state: string;
  verifier: string;
  nonce: string;
  next: string;
}

/** Where to send the browser, and what to remember until it comes back. */
export function startGoogle(next: string | null): { url: string; pending: PendingSignIn } | null {
  const config = googleConfig();
  if (!config) return null;
  const pending: PendingSignIn = {
    state: b64url(crypto.randomBytes(24)),
    verifier: b64url(crypto.randomBytes(48)),
    nonce: b64url(crypto.randomBytes(24)),
    next: safeNext(next),
  };
  const url = new URL(AUTHORIZE);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: googleRedirectUri(),
    response_type: "code",
    scope: "openid email profile",
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: b64url(crypto.createHash("sha256").update(pending.verifier).digest()),
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return { url: url.toString(), pending };
}

export function encodePending(p: PendingSignIn): string {
  return Buffer.from(JSON.stringify(p)).toString("base64url");
}

export function decodePending(raw: string | undefined): PendingSignIn | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<PendingSignIn>;
    if (typeof p.state !== "string" || typeof p.verifier !== "string" || typeof p.nonce !== "string") return null;
    return { state: p.state, verifier: p.verifier, nonce: p.nonce, next: safeNext(p.next) };
  } catch {
    return null;
  }
}

export type SignInResult = { ok: true; userId: number; created: boolean } | { ok: false; error: string };

/** Google has sent the browser back with a code: turn it into an account. */
export async function finishGoogle(
  query: { code: string | null; state: string | null; error: string | null },
  pending: PendingSignIn | null
): Promise<SignInResult> {
  const config = googleConfig();
  if (!config) return { ok: false, error: "Signing in with Google is not set up here." };
  if (query.error) return { ok: false, error: "Google sign-in was cancelled." };
  if (!pending || !query.state || query.state.length !== pending.state.length ||
      !crypto.timingSafeEqual(Buffer.from(query.state), Buffer.from(pending.state)))
    return { ok: false, error: "That sign-in did not start here, or took too long. Try again." };
  if (!query.code) return { ok: false, error: "Google sent no answer. Try again." };

  let tokens: { id_token?: string };
  try {
    const res = await fetch(TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: query.code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: googleRedirectUri(),
        grant_type: "authorization_code",
        code_verifier: pending.verifier,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false, error: "Google did not accept the sign-in. Try again." };
    tokens = (await res.json()) as { id_token?: string };
  } catch {
    return { ok: false, error: "Google could not be reached. Try again." };
  }
  const claims = readIdToken(tokens.id_token);
  if (!claims) return { ok: false, error: "Google's answer could not be read. Try again." };
  if (!ISSUERS.includes(claims.iss) || claims.aud !== config.clientId || claims.exp * 1000 < Date.now() || claims.nonce !== pending.nonce)
    return { ok: false, error: "Google's answer was not for this sign-in. Try again." };
  if (!claims.email) return { ok: false, error: "Google did not share an email address." };
  return signInWithIdentity({
    provider: "google",
    subject: claims.sub,
    email: claims.email,
    emailVerified: claims.email_verified === true || claims.email_verified === "true",
    name: claims.name,
  });
}

interface IdClaims {
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
}

function readIdToken(token: string | undefined): IdClaims | null {
  const payload = token?.split(".")[1];
  if (!payload) return null;
  try {
    const c = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<IdClaims>;
    if (typeof c.iss !== "string" || typeof c.aud !== "string" || typeof c.sub !== "string" || typeof c.exp !== "number") return null;
    return c as IdClaims;
  } catch {
    return null;
  }
}

/** The account for this person at this provider: found, joined by a verified email, or made. */
export async function signInWithIdentity(who: {
  provider: "google" | "apple";
  subject: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}): Promise<SignInResult> {
  const db = getDb();
  const known = (await db
    .prepare("SELECT user_id FROM user_identities WHERE provider = ? AND subject = ?")
    .get(who.provider, who.subject)) as { user_id: number } | undefined;
  if (known) return { ok: true, userId: known.user_id, created: false };

  const email = who.email.trim();
  const existing = (await db.prepare("SELECT id FROM users WHERE email = ?").get(email)) as { id: number } | undefined;
  if (existing && !who.emailVerified)
    return { ok: false, error: "An account with this email already exists. Sign in with your password instead." };
  let userId: number;
  let created = false;
  if (existing) {
    userId = existing.id;
    // Nothing here ever proved that whoever set this account's password owns the address; Google just has.
    // So somebody who signed up with it first, to be let in later, is shut out: the password goes, and
    // every session with it. The owner signs in with Google, or sets a password by the reset email.
    const had = (await db.prepare("SELECT password_hash FROM users WHERE id = ?").get(userId)) as { password_hash: string } | undefined;
    if (had?.password_hash) {
      await db.prepare("UPDATE users SET password_hash = '' WHERE id = ?").run(userId);
      await db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    }
  } else {
    const name = (who.name?.trim() || email.split("@")[0]).slice(0, 100);
    // No password, so none can match; no phone yet, so one is asked for before booking.
    userId = (await db.prepare("INSERT INTO users (name, email, phone, password_hash) VALUES (?, ?, '', '')").run(name, email))
      .lastInsertRowid as number;
    created = true;
  }
  await db
    .prepare("INSERT INTO user_identities (provider, subject, user_id, email) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
    .run(who.provider, who.subject, userId, email);
  return { ok: true, userId, created };
}
