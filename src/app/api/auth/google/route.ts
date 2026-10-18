import { NextRequest, NextResponse } from "next/server";
import { encodePending, googleOfferedAt, OAUTH_COOKIE, OAUTH_COOKIE_MINUTES, startGoogle } from "@/lib/oauth";
import { rateLimit } from "@/lib/rate-limit";
import { sessionCookieOptions } from "@/lib/session-cookie";

export const dynamic = "force-dynamic";

/** Off to Google, `?next=` being where to come back to. */
export async function GET(req: NextRequest) {
  const limited = rateLimit(req, "login");
  if (limited) return limited;
  if (!googleOfferedAt(req.headers.get("host")))
    return NextResponse.redirect(new URL("/login?error=google", req.url));
  const started = startGoogle(req.nextUrl.searchParams.get("next"))!;
  const res = NextResponse.redirect(started.url);
  res.cookies.set(OAUTH_COOKIE, encodePending(started.pending), {
    ...sessionCookieOptions(req, new Date(Date.now() + OAUTH_COOKIE_MINUTES * 60_000)),
    path: "/api/auth/google",
  });
  return res;
}
