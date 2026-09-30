import { NextRequest, NextResponse } from "next/server";
import { destroySession, getSessionUser, SESSION_COOKIE } from "@/lib/auth";
import { eraseCustomer } from "@/lib/privacy";

export const dynamic = "force-dynamic";

/**
 * Close an account and forget the person behind it.
 *
 * The typed confirmation is not ceremony: this cancels upcoming bookings and
 * cannot be undone from inside the app, so it should be hard to do by
 * misclicking.
 */
export async function POST(req: NextRequest) {
  const user = getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { confirm } = (body ?? {}) as Record<string, unknown>;
  if (confirm !== "DELETE")
    return NextResponse.json(
      { error: 'Type DELETE to confirm that you want the account closed.' },
      { status: 400 }
    );

  const result = eraseCustomer(user.id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) destroySession(token);
  const res = NextResponse.json({
    ok: true,
    bookingsAnonymised: result.bookingsAnonymised,
    cancelled: result.cancelled,
  });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
