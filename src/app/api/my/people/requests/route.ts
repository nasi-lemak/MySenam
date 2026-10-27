import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { answerRequest } from "@/lib/guardian-requests";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * An existing guardian's answer to another adult's request to become a
 * guardian of somebody they act for (lib/guardian-requests.ts; ADR 0023):
 * `{ id, agree: true }` makes the relationship, `{ id, agree: false,
 * reason? }` refuses it. Only a guardian acting for the participant now;
 * the requests waiting for this account are in `GET /api/my/people`.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const limited = await rateLimit(req, "booking", "guardian-request");
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const done = await answerRequest(user, body.id, body.agree, body.reason);
  if (!done.ok) return NextResponse.json({ error: done.error, code: done.code }, { status: done.status });
  return NextResponse.json({ status: done.status });
}
