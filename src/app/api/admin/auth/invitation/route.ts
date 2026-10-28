import { NextRequest, NextResponse } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdminSession } from "@/lib/admin-auth";
import { acceptInvitation } from "@/lib/staff-accounts";
import { rateLimit } from "@/lib/rate-limit";
import { sessionCookieOptions } from "@/lib/session-cookie";

export const dynamic = "force-dynamic";

/**
 * `{ token, password }` from an emailed staff invitation: makes the account
 * (or moves it to its new address) with that password, and signs in here.
 * Counted against the same limit as signing in, as a password reset is.
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    const raw = (await req.json()) as unknown;
    body = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (typeof body.token !== "string" || typeof body.password !== "string")
    return NextResponse.json({ error: "token and password are required." }, { status: 400 });
  const limited = await rateLimit(req, "login");
  if (limited) return limited;
  const result = await acceptInvitation(body.token, body.password);
  if (!result.ok) return NextResponse.json({ error: result.error, ...(result.code ? { code: result.code } : {}) }, { status: result.status });
  const session = await createAdminSession(result.adminId);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_SESSION_COOKIE, session.token, sessionCookieOptions(req, session.expiresAt));
  return res;
}
