import { NextRequest, NextResponse } from "next/server";
import { denyVenue, isOwner, requireAdmin, requireOwner } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import {
  moderateReview,
  replyToReview,
  reportedReviews,
  reportReview,
  reviewRequestsOn,
  setReviewRequests,
  staffReviews,
} from "@/lib/reviews";

export const dynamic = "force-dynamic";

/** `?venueId=` → the venue's reviews, hidden ones too, and whether it asks for them; the platform's owners also get those reported. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return NextResponse.json({
    reviews: await staffReviews(venueId),
    requests: await reviewRequestsOn(venueId),
    reported: isOwner(admin) ? await reportedReviews() : null,
  });
}

/**
 * `{ venueId, action }`:
 * - `reply` with `id`, `text` (empty takes the reply away);
 * - `report` with `id`, `reason`: ask the platform to look at it;
 * - `requests` with `on`: email customers once after a first visit, or not;
 * - `hide` with `id`, `reason`, or `show` with `id`: the platform's owners only.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !Number.isInteger(body.venueId)) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const venueId = body.venueId as number;
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const id = body.id as number;
  const needsId = ["reply", "report", "hide", "show"].includes(body.action as string);
  if (needsId && !Number.isInteger(id)) return NextResponse.json({ error: "id is required." }, { status: 400 });

  switch (body.action) {
    case "reply": {
      const done = await replyToReview(id, venueId, body.text);
      if (!done.ok) return NextResponse.json({ error: done.error }, { status: 400 });
      await logAction(admin, { venueId, action: "review.replied", detail: `${done.review.author}, ${done.review.rating}/5` });
      return NextResponse.json({ review: done.review });
    }
    case "report": {
      const done = await reportReview(id, venueId, body.reason);
      if (!done.ok) return NextResponse.json({ error: done.error }, { status: 400 });
      await logAction(admin, { venueId, action: "review.reported", detail: `${done.review.author}, ${done.review.rating}/5` });
      return NextResponse.json({ review: done.review });
    }
    case "requests": {
      await setReviewRequests(venueId, body.on === true);
      await logAction(admin, { venueId, action: "review.requests", detail: body.on === true ? "On" : "Off" });
      return NextResponse.json({ requests: await reviewRequestsOn(venueId) });
    }
    case "hide":
    case "show": {
      const owner = requireOwner(admin);
      if (owner) return owner;
      const done = await moderateReview(id, body.action === "hide", body.reason);
      if (!done.ok) return NextResponse.json({ error: done.error }, { status: 400 });
      if (done.review.venueId !== venueId) return NextResponse.json({ error: "Review not found." }, { status: 404 });
      await logAction(admin, { venueId, action: body.action === "hide" ? "review.hidden" : "review.shown", detail: `${done.review.author}, ${done.review.rating}/5` });
      return NextResponse.json({ review: done.review });
    }
    default:
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }
}
