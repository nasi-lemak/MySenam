import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, requireOwner } from "@/lib/admin-auth";
import { liftBusiness, liftVenue, suspendBusiness, suspendVenue } from "@/lib/suspensions";
import { jsonObject } from "@/lib/api";
import { logAction } from "@/lib/activity";

export const dynamic = "force-dynamic";

/**
 * `{ venueId | businessId, action: "suspend" | "lift", reason? }` — the
 * platform owner taking a venue or a whole business off the marketplace, or
 * putting it back.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const denied = requireOwner(admin);
  if (denied) return denied;
  let body: Record<string, unknown>;
  try {
    body = (await jsonObject(req)) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (body.action !== "lift" && body.action !== "suspend")
    return NextResponse.json({ error: "Say suspend or lift." }, { status: 400 });
  const reason = typeof body.reason === "string" ? body.reason : "";
  const venueId = Number(body.venueId);
  const businessId = Number(body.businessId);
  let result;
  if (Number.isInteger(venueId) && venueId > 0)
    result = body.action === "lift" ? await liftVenue(venueId) : await suspendVenue(venueId, reason);
  else if (Number.isInteger(businessId) && businessId > 0)
    result = body.action === "lift" ? await liftBusiness(businessId) : await suspendBusiness(businessId, reason);
  else return NextResponse.json({ error: "Which venue or business?" }, { status: 400 });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  const ofVenue = Number.isInteger(venueId) && venueId > 0;
  await logAction(admin, {
    venueId: ofVenue ? venueId : null,
    businessId: ofVenue ? null : businessId,
    action: body.action === "lift" ? "venue.suspension_lifted" : "venue.suspended",
    detail: `${ofVenue ? `Venue ${venueId}` : `Business ${businessId}, every branch`}${reason.trim() ? `: ${reason.trim().slice(0, 300)}` : ""}`,
  });
  return NextResponse.json(result);
}
