import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { reportMistake } from "@/lib/guardian-requests";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Report a change to who acts for somebody this account manages as a
 * mistake (lib/guardian-requests.ts; ADR 0023): `{ id, guardianshipId,
 * note? }`, another guardian's relationship to participant `id`, one of
 * the changes `GET /api/my/people` lists. Flagged for a manager of a venue
 * that knows the participant (or the platform owner), who keeps, pauses or
 * revokes it; nothing changes until then.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const limited = await rateLimit(req, "booking", "guardian-report");
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const done = await reportMistake(user, body.id, body.guardianshipId, body.note);
  if (!done.ok) return NextResponse.json({ error: done.error, code: done.code }, { status: done.status });
  return NextResponse.json({ ok: true });
}
