import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { jsonObject, refusal } from "@/lib/api";
import { classMoveRules, setClassMoveRules } from "@/lib/class-move-requests";

export const dynamic = "force-dynamic";

/**
 * `?venueId` → `{ rules }`: whether front desk may move classes at the venue and what makes a desk's move wait for a manager (lib/class-move-requests.ts
 * `ClassMoveRules`, ADR 0045): `deskMayMove`, `maxDays`, `maxSeries`, `withinHours`, `paidPeople` (null: not asked), `priceCheck`, `requestDays`. Any member of
 * the venue's staff reads them (the dashboard hides the Move button from a desk where it may not).
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return NextResponse.json({ rules: await classMoveRules(venueId) }, { headers: { "Cache-Control": "no-store" } });
}

/** `{ venueId, deskMayMove?, maxDays?, maxSeries?, withinHours?, paidPeople?, priceCheck?, requestDays? }`: a manager's (lib/roles.ts); what is left out stays; in the activity log. */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  let body: Record<string, unknown>;
  try {
    body = await jsonObject(req);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!Number.isInteger(body.venueId) || (body.venueId as number) <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const venueId = body.venueId as number;
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const done = await setClassMoveRules(venueId, body);
  if (!done.ok) return refusal({ ok: false, error: done.error, code: done.code }, 400);
  if (done.changed.length > 0) await logAction(admin, { venueId, action: "settings.changed", detail: `Class moves: ${done.changed.join("; ")}` });
  return NextResponse.json({ rules: done.rules });
}
