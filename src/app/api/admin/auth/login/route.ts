import { NextRequest, NextResponse } from "next/server";
import { ADMIN_SESSION_COOKIE, authenticateAdmin, createAdminSession, getAdminById } from "@/lib/admin-auth";
import { hasTwoFactor, issueLoginTicket, redeemLoginTicket } from "@/lib/two-factor";
import { failedFor, rateLimit, refusedFor } from "@/lib/rate-limit";
import { sessionCookieOptions } from "@/lib/session-cookie";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { email, password, ticket, code } = (body ?? {}) as Record<string, unknown>;

  // The second step: the ticket from the password, and the code from the app.
  if (typeof ticket === "string" && typeof code === "string") {
    const limitedCode = await rateLimit(req, "login", ticket);
    if (limitedCode) return limitedCode;
    const done = await redeemLoginTicket(ticket, code);
    if (!done.ok) return NextResponse.json({ error: done.error }, { status: 401 });
    return signedIn(req, done.adminId);
  }

  if (typeof email !== "string" || typeof password !== "string")
    return NextResponse.json({ error: "email and password are required." }, { status: 400 });

  const limited = (await rateLimit(req, "login", email)) ?? (await refusedFor("loginFailures", `admin:${email}`));
  if (limited) return limited;

  const admin = await authenticateAdmin(email, password);
  if (!admin) {
    await failedFor("loginFailures", `admin:${email}`);
    return NextResponse.json({ error: "Wrong email or password." }, { status: 401 });
  }

  // The password alone is not enough for an account with two-factor on.
  if (await hasTwoFactor(admin.id)) return NextResponse.json({ twoFactor: true, ticket: await issueLoginTicket(admin.id) });
  return signedIn(req, admin.id);
}

async function signedIn(req: NextRequest, adminId: number) {
  const admin = await getAdminById(adminId);
  if (!admin) return NextResponse.json({ error: "Wrong email or password." }, { status: 401 });
  const session = await createAdminSession(admin.id);
  const res = NextResponse.json({ admin });
  res.cookies.set(ADMIN_SESSION_COOKIE, session.token, sessionCookieOptions(req, session.expiresAt));
  return res;
}
