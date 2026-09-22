import { NextRequest, NextResponse } from "next/server";
import { createSession, registerUser, SESSION_COOKIE } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { name, email, phone, password } = (body ?? {}) as Record<string, unknown>;

  if (typeof name !== "string" || name.trim().length < 2)
    return NextResponse.json({ error: "Please provide your name." }, { status: 400 });
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return NextResponse.json({ error: "Please provide a valid email address." }, { status: 400 });
  if (typeof phone !== "string" || !/^\+?[0-9 -]{7,20}$/.test(phone.trim()))
    return NextResponse.json({ error: "Please provide a valid phone number." }, { status: 400 });
  if (typeof password !== "string" || password.length < 8)
    return NextResponse.json(
      { error: "Password must be at least 8 characters." },
      { status: 400 }
    );

  const limited = rateLimit(req, "register");
  if (limited) return limited;

  const result = registerUser({ name, email, phone, password });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });

  const session = createSession(result.user.id);
  const res = NextResponse.json({ user: result.user }, { status: 201 });
  res.cookies.set(SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    expires: session.expiresAt,
  });
  return res;
}
