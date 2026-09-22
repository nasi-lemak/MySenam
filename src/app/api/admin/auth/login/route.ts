import { NextRequest, NextResponse } from "next/server";
import { ADMIN_SESSION_COOKIE, authenticateAdmin, createAdminSession } from "@/lib/admin-auth";
import { rateLimit } from "@/lib/rate-limit";

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

  const limited = rateLimit(req, "login", email);
  if (limited) return limited;

  const admin = authenticateAdmin(email, password);
  if (!admin) return NextResponse.json({ error: "Wrong email or password." }, { status: 401 });

  const session = createAdminSession(admin.id);
  const res = NextResponse.json({ admin });
  res.cookies.set(ADMIN_SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    expires: session.expiresAt,
  });
  return res;
}
