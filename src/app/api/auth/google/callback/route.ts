import { NextRequest, NextResponse } from "next/server";
import { createSession, SESSION_COOKIE } from "@/lib/auth";
import { decodePending, finishGoogle, OAUTH_COOKIE } from "@/lib/oauth";
import { sessionCookieOptions } from "@/lib/session-cookie";

export const dynamic = "force-dynamic";

/** Back from Google: signed in, and on to where they were going; or back to sign in, saying why. */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const pending = decodePending(req.cookies.get(OAUTH_COOKIE)?.value);
  const result = await finishGoogle({ code: q.get("code"), state: q.get("state"), error: q.get("error") }, pending);
  const res = result.ok
    ? NextResponse.redirect(new URL(pending!.next, req.url))
    : // Why, as a code the sign-in page has words for: never the text itself in the address (lib/safe-path.ts).
      NextResponse.redirect(new URL(`/login?error=${result.code}`, req.url));
  res.cookies.set(OAUTH_COOKIE, "", { path: "/api/auth/google", maxAge: 0 });
  if (result.ok) {
    const session = await createSession(result.userId);
    res.cookies.set(SESSION_COOKIE, session.token, sessionCookieOptions(req, session.expiresAt));
  }
  return res;
}
