import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { accountReviews, coachReviewerFor, decide, refusalBody, reviewerCoaches, type Decision } from "@/lib/approvals";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const DECISIONS: Decision[] = ["approve", "reject", "ask", "in_person", "check", "revoke", "authority"];

/**
 * A coach's review of applications, signed in to their own account
 * (lib/approvals.ts; ADR 0020): the applications for the activities each
 * venue that linked this account to its coach record named them for.
 * `coaches`: which coach records those are (empty for everybody else).
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const coaches = await reviewerCoaches(user.id);
  return NextResponse.json(
    { coaches: coaches.map((c) => ({ id: c.id, name: c.name, venueName: c.venueName })), requests: coaches.length ? await accountReviews(user.id) : [] },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * `{ id, action: "approve" | "reject" | "ask" | "in_person" | "check" | "revoke" | "authority", reason? }`:
 * the coach's decision on an application they may review, under their name
 * and this account; refused for any other (`APR_NOT_REVIEWER`).
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const limited = await rateLimit(req, "booking", "approval-review");
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Application not found." }, { status: 404 });
  if (!DECISIONS.includes(body.action as Decision))
    return NextResponse.json({ error: "action is approve, reject, ask, in_person, check, revoke or authority." }, { status: 400 });
  const reviewer = await coachReviewerFor(user.id, id);
  if (!reviewer) return NextResponse.json({ error: "You may not review applications for this activity.", code: "APR_NOT_REVIEWER" }, { status: 403 });
  const done = await decide(reviewer, id, body.action as Decision, { reason: body.reason });
  if (!done.ok) return NextResponse.json(refusalBody(done), { status: done.status });
  return NextResponse.json({ request: done.request, bookingCode: done.booking?.code ?? null });
}
