import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { decide, flaggedBookings, refusalBody, resolveFlag, venueApprovals, waitingCount, type Decision } from "@/lib/approvals";

export const dynamic = "force-dynamic";

const DECISIONS: Decision[] = ["approve", "reject", "ask", "in_person", "check", "revoke"];

/**
 * Applications to be approved for an activity here (lib/approvals.ts).
 * `?venueId` → those waiting first, then the latest decided, with how many
 * wait, and the bookings flagged for staff after an approval was revoked;
 * `&waiting=1` → only those waiting on the venue.
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
    { requests: await venueApprovals(venueId, { waitingOnly }), waiting: await waitingCount(venueId), flags: await flaggedBookings(venueId) },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * `{ venueId, id, action: "approve" | "reject" | "ask" | "in_person" | "check" | "revoke", reason?, payLater? }`:
 * a decision, by whoever is signed in. Rejecting, asking and revoking need a
 * reason. Approving writes the sign-off the booking rules check (once any
 * in-person step is recorded too) and books a slot asked for, if it is still
 * free, held for payment where the venue asks payment to hold (`payLater`:
 * an exception, paid at the counter, on record). For a safety-assessed
 * activity only a manager or front desk delegated for it approves or records
 * the in-person step (`APR_SAFETY_AUTHORITY`). Recorded in the application's
 * history and the activity log.
 *
 * `{ venueId, flagId, action: "resolve_flag", note }`: a booking flagged
 * after a revocation has been dealt with (cancelled, supervised or kept), on record.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const venueId = Number(body.venueId);
  const id = Number(body.id ?? body.flagId);
  if (!Number.isInteger(venueId) || venueId <= 0 || !Number.isInteger(id) || id <= 0)
    return NextResponse.json({ error: "venueId and id are required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  if (body.action === "resolve_flag") {
    if (!(await resolveFlag(admin, venueId, Number(body.flagId), body.note)))
      return NextResponse.json({ error: "Say what was done with this booking.", code: "APR_REASON_NEEDED" }, { status: 400 });
    return NextResponse.json({ ok: true, flags: await flaggedBookings(venueId) });
  }
  if (!DECISIONS.includes(body.action as Decision))
    return NextResponse.json({ error: "action is approve, reject, ask, in_person, check or revoke." }, { status: 400 });
  const done = await decide({ kind: "staff", admin }, id, body.action as Decision, { reason: body.reason, venueId, payLater: body.payLater });
  if (!done.ok) return NextResponse.json(refusalBody(done), { status: done.status });
  return NextResponse.json({ request: done.request, bookingCode: done.booking?.code ?? null });
}
