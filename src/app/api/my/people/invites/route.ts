import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { createInvite } from "@/lib/participants";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * A code for somebody to accept (lib/participants.ts; ADR 0023): `{ id,
 * purpose: "guardian" }`, another adult becoming a guardian of somebody this
 * account manages too, or `{ id, purpose: "link" }`, that person's own login
 * taking them over. Shown once, good for a week; only its hash is kept.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const limited = await rateLimit(req, "booking", "participant-invite");
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const made = await createInvite(user, body.id, body.purpose);
  if (!made.ok) return NextResponse.json({ error: made.error, code: made.code }, { status: made.status });
  return NextResponse.json({ code: made.code, expiresAt: made.expiresAt }, { status: 201, headers: { "Cache-Control": "no-store" } });
}
