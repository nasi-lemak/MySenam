import { NextRequest, NextResponse } from "next/server";
import { createSession, SESSION_COOKIE } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { completeRegistration } from "@/lib/registration";
import { sessionCookieOptions } from "@/lib/session-cookie";

export const dynamic = "force-dynamic";

/**
 * `{ token, name, phone, password }` → the account made with an emailed
 * sign-up link, and signed in (`201 { user }`). A link that cannot be used
 * (run out, used, replaced, or the address has an account by now) makes
 * nothing: `400 REGISTRATION_INVALID`, which says to sign in.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { token, name, phone, password } = (body ?? {}) as Record<string, unknown>;
  if (typeof token !== "string") return NextResponse.json({ error: "token is required." }, { status: 400 });
  if (typeof name !== "string") return NextResponse.json({ error: "Please provide your name." }, { status: 400 });
  if (typeof phone !== "string") return NextResponse.json({ error: "Please provide a valid phone number." }, { status: 400 });
  if (typeof password !== "string") return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });

  const limited = await rateLimit(req, "login");
  if (limited) return limited;

  const result = await completeRegistration(token, { name, phone, password });
  if (!result.ok) return NextResponse.json(result, { status: 400 });

  const session = await createSession(result.user.id);
  const res = NextResponse.json({ user: result.user }, { status: 201 });
  res.cookies.set(SESSION_COOKIE, session.token, sessionCookieOptions(req, session.expiresAt));
  return res;
}
