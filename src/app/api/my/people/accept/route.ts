import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { acceptInvite } from "@/lib/participants";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Accept a code another guardian gave (lib/participants.ts; ADR 0023):
 * `{ code, relationship, authority: true }` to become a guardian too,
 * declaring this account's own relationship and authority; `{ code }` for a
 * code to take somebody over as their own login. Both sides agreed: the one
 * who gave it, and this account.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  // Codes are not to be guessed: as few tries as a booking lookup.
  const limited = await rateLimit(req, "bookingLookup", "participant-code");
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const done = await acceptInvite(user, body);
  if (!done.ok) return NextResponse.json({ error: done.error, code: done.code, ...(done.vars ? { vars: done.vars } : {}) }, { status: done.status });
  return NextResponse.json({ as: done.as, person: { id: done.participant.id, displayName: done.participant.displayName } });
}
