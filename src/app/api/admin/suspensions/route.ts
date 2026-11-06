import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, requireOwner } from "@/lib/admin-auth";
import { liftBusiness, liftVenue, suspendBusiness, suspendVenue } from "@/lib/suspensions";
import { jsonObject } from "@/lib/api";
import { logAction } from "@/lib/activity";

export const dynamic = "force-dynamic";

/**
 * `{ venueId | businessId, action: "suspend" | "lift", reason?, graceUntil? }` — the
 * platform owner taking a venue or a whole business off the marketplace, or
 * putting it back. A venue held for an unpaid invoice is put back by giving the
 * invoice time: `graceUntil` (YYYY-MM-DD, at most 90 days) and a `reason` of 5 to
 * 300 characters, both required then (409 `FX11_GRACE_NEEDED` without a date).
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
  const graceUntil = typeof body.graceUntil === "string" && body.graceUntil.trim() ? body.graceUntil.trim() : undefined;
  let result: { ok: true; grace?: { until: string; invoices: { id: number; period: string }[] } } | { ok: false; error: string; code?: string };
  if (Number.isInteger(venueId) && venueId > 0)
    result = body.action === "lift" ? await liftVenue(venueId, { reason, graceUntil, by: admin.name }) : await suspendVenue(venueId, reason);
  else if (Number.isInteger(businessId) && businessId > 0)
    result = body.action === "lift" ? await liftBusiness(businessId) : await suspendBusiness(businessId, reason);
  else return NextResponse.json({ error: "Which venue or business?" }, { status: 400 });
  if (!result.ok) return NextResponse.json({ error: result.error, ...(result.code ? { code: result.code } : {}) }, { status: result.code === "BILL_REASON_REQUIRED" ? 400 : 409 });
  const ofVenue = Number.isInteger(venueId) && venueId > 0;
  // A hold for an unpaid invoice is lifted by giving time: the log says so, with the invoices, the date and the reason.
  const grace = "grace" in result && result.grace ? result.grace : null;
  await logAction(admin, {
    venueId: ofVenue ? venueId : null,
    businessId: ofVenue ? null : businessId,
    action: body.action === "lift" ? "venue.suspension_lifted" : "venue.suspended",
    detail: `${ofVenue ? `Venue ${venueId}` : `Business ${businessId}, every branch`}${
      grace ? `, held for an unpaid invoice: time given until ${grace.until} on ${grace.invoices.map((i) => `invoice ${i.id} (${i.period})`).join(", ") || "no invoice still owing"}` : ""
    }${reason.trim() ? `: ${reason.trim().slice(0, 300)}` : ""}`,
  });
  return NextResponse.json(result);
}
