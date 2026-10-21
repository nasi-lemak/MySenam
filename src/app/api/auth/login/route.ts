import { NextRequest, NextResponse } from "next/server";
import { authenticate, createSession, SESSION_COOKIE } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { sessionCookieOptions } from "@/lib/session-cookie";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { email, password } = (body ?? {}) as Record<string, unknown>;
  if (typeof email !== "string" || typeof password !== "string")
    return NextResponse.json({ error: "email and password are required." }, { status: 400 });

  const limited = await rateLimit(req, "login", email);
  if (limited) return limited;

  const user = await authenticate(email, password);
  if (!user)
    return NextResponse.json({ error: "Wrong email or password." }, { status: 401 });

  const session = await createSession(user.id);
  const res = NextResponse.json({ user });
  res.cookies.set(SESSION_COOKIE, session.token, sessionCookieOptions(req, session.expiresAt));
  return res;
}
