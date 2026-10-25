import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { decide, refusalBody, venueApprovals, waitingCount, type Decision } from "@/lib/approvals";

export const dynamic = "force-dynamic";

const DECISIONS: Decision[] = ["approve", "reject", "ask", "in_person"];

/**
 * Applications to be approved for an activity here (lib/approvals.ts).
 * `?venueId` → those waiting first, then the latest decided, with how many
 * wait; `&waiting=1` → only those waiting on the venue.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const waitingOnly = req.nextUrl.searchParams.get("waiting") === "1";
  return NextResponse.json(
    { requests: await venueApprovals(venueId, { waitingOnly }), waiting: await waitingCount(venueId) },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * `{ venueId, id, action: "approve" | "reject" | "ask" | "in_person", reason? }`:
 * a decision, by whoever is signed in. Rejecting and asking need a reason.
 * Approving writes the sign-off the booking rules check (once any in-person
 * step is recorded too) and books a slot asked for, if it is still free.
 * Recorded in the application's history and the activity log.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const venueId = Number(body.venueId);
  const id = Number(body.id);
  if (!Number.isInteger(venueId) || venueId <= 0 || !Number.isInteger(id) || id <= 0)
    return NextResponse.json({ error: "venueId and id are required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  if (!DECISIONS.includes(body.action as Decision)) return NextResponse.json({ error: "action is approve, reject, ask or in_person." }, { status: 400 });
  const done = await decide({ kind: "staff", admin }, id, body.action as Decision, { reason: body.reason, venueId });
  if (!done.ok) return NextResponse.json(refusalBody(done), { status: done.status });
  return NextResponse.json({ request: done.request, bookingCode: done.booking?.code ?? null });
}
