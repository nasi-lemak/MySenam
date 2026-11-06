import { logAction } from "@/lib/activity";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, requireOwner } from "@/lib/admin-auth";
import { approveApplication, countDrafts, listApplications, rejectApplication } from "@/lib/applications";
import { isMarketplace } from "@/lib/mode";

export const dynamic = "force-dynamic";

/** Venues asking to go live, and how many drafts are being set up, for the platform owner alone. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const denied = requireOwner(admin);
  if (denied) return denied;
  return NextResponse.json({
    marketplace: isMarketplace(),
    applications: await listApplications(),
    drafts: await countDrafts(),
  });
}

/** `{ id, decision: "approve" | "reject", checks?, reason? }`; approving needs every one of REVIEW_CHECKS in `checks`. */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const denied = requireOwner(admin);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { id, decision, reason, checks } = (body ?? {}) as Record<string, unknown>;
  if (!Number.isInteger(id) || (decision !== "approve" && decision !== "reject"))
    return NextResponse.json({ error: "id and a decision are required." }, { status: 400 });

  const result =
    decision === "approve"
      ? await approveApplication(
          id as number,
          admin.id,
          Array.isArray(checks) ? checks.filter((c): c is string => typeof c === "string") : []
        )
      : await rejectApplication(id as number, admin.id, typeof reason === "string" ? reason : "");
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  // Who let a venue onto the marketplace, or refused it, and on what grounds: in the log, beside the application's own record.
  await logAction(admin, {
    venueId: result.application.venueId,
    action: decision === "approve" ? "venue.approved" : "venue.rejected",
    detail:
      decision === "approve"
        ? `Approved the application of ${result.application.businessName} to list a venue (platform); checks ticked: ${Array.isArray(checks) ? checks.length : 0}`
        : `Refused the application of ${result.application.businessName} to list a venue (platform): ${typeof reason === "string" ? reason.trim().slice(0, 300) : ""}`,
  });
  return NextResponse.json({ application: result.application, emailed: result.emailed });
}
