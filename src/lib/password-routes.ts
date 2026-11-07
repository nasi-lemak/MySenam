import { NextRequest, NextResponse } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdminSession, getSessionAdmin } from "./admin-auth";
import { accountEmailRefusal } from "./account-email-gate";
import { createSession, getSessionUser, SESSION_COOKIE } from "./auth";
import { isLocale, LOCALE_COOKIE } from "./i18n";
import { changePassword, hasPassword, requestReset, resetPassword, type AccountKind } from "./password-reset";
import { rateLimit } from "./rate-limit";
import { sessionCookieOptions } from "./session-cookie";

/**
 * The forgot / reset / change password endpoints, the same for customers
 * (`/api/auth/…`, `/api/my/password`) and for staff (`/api/admin/auth/…`).
 * All three count against the same limit as signing in, so neither the
 * emailed link nor a stolen session is a faster way to guess.
 */

const COOKIE: Record<AccountKind, string> = { user: SESSION_COOKIE, admin: ADMIN_SESSION_COOKIE };

async function bodyOf(req: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const body = (await req.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

const invalid = () => NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

/** `{ email }` → always `{ ok: true }`; emails a link if the address has an account. */
export function forgotRoute(kind: AccountKind) {
  return async (req: NextRequest) => {
    const body = await bodyOf(req);
    if (!body) return invalid();
    if (typeof body.email !== "string" || body.email.trim() === "")
      return NextResponse.json({ error: "email is required." }, { status: 400 });
    // A production marketplace whose email cannot deliver takes no request it could not answer by email (lib/account-email-gate.ts).
    const unavailable = accountEmailRefusal();
    if (unavailable) return unavailable;
    const limited = (await rateLimit(req, "login", body.email.trim().toLowerCase())) ?? (await rateLimit(req, "forgot"));
    if (limited) return limited;
    const locale = req.cookies.get(LOCALE_COOKIE)?.value;
    return NextResponse.json(await requestReset(kind, body.email, isLocale(locale) ? locale : "en"));
  };
}

/** `{ token, password }` → sets the password, ends every session, and signs in here. */
export function resetRoute(kind: AccountKind) {
  return async (req: NextRequest) => {
    const body = await bodyOf(req);
    if (!body) return invalid();
    if (typeof body.token !== "string" || typeof body.password !== "string")
      return NextResponse.json({ error: "token and password are required." }, { status: 400 });
    const limited = await rateLimit(req, "login");
    if (limited) return limited;
    const result = await resetPassword(kind, body.token, body.password);
    if (!result.ok) return NextResponse.json(result, { status: 400 });
    const session = kind === "admin" ? await createAdminSession(result.accountId) : await createSession(result.accountId);
    const res = NextResponse.json({ ok: true });
    res.cookies.set(COOKIE[kind], session.token, sessionCookieOptions(req, session.expiresAt));
    return res;
  };
}

/** Whether the signed-in account has a password to give (one made with Google may not). */
export function passwordStatusRoute(kind: AccountKind) {
  return async (req: NextRequest) => {
    const account = kind === "admin" ? await getSessionAdmin(req) : await getSessionUser(req);
    if (!account) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
    return NextResponse.json({ hasPassword: await hasPassword(kind, account.id) });
  };
}

/** `{ current, next }` while signed in → changes it; other sessions end, this one stays. */
export function changeRoute(kind: AccountKind) {
  return async (req: NextRequest) => {
    const account = kind === "admin" ? await getSessionAdmin(req) : await getSessionUser(req);
    if (!account) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
    const body = await bodyOf(req);
    if (!body) return invalid();
    if (typeof body.next !== "string") return NextResponse.json({ error: "next is required." }, { status: 400 });
    const limited = await rateLimit(req, "login", `${kind}:${account.id}`);
    if (limited) return limited;
    const result = await changePassword(
      kind,
      account.id,
      typeof body.current === "string" ? body.current : "",
      body.next,
      req.cookies.get(COOKIE[kind])?.value ?? null
    );
    if (!result.ok) return NextResponse.json(result, { status: 400 });
    return NextResponse.json({ ok: true });
  };
}
