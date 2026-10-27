import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { acceptGuestInvitation } from "@/lib/guest-invites";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * `{ token }`, signed in: accept a resident's emailed invitation, linking the
 * one guest entry it was made for to this account. Every reason it cannot be
 * used is the same `404 GUEST_INVITATION_INVALID`.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const limited = await rateLimit(req, "guestAccept");
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const result = await acceptGuestInvitation(user, body?.token);
  if (!result.ok) return NextResponse.json(result, { status: 404 });
  return NextResponse.json({ venue: result.venue, expiresOn: result.expiresOn });
}
