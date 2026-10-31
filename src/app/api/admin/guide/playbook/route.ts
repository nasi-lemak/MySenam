import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { guideFacts } from "@/lib/guide/facts";
import { guideVenue, ownRole } from "@/lib/guide/http";
import { readVenueProfile } from "@/lib/guide/profile";
import { GUIDE_ROLES, isGuideRole, mayViewAs } from "@/lib/guide/shell";

export const dynamic = "force-dynamic";

/**
 * The operating guide for a venue (`?venueId=`, or the admin's own), for a
 * role: the session's own, or with `as=` a role at or below it (a manager
 * preparing the front desk's or a coach's training), never above. The role a
 * guide is *for* is decided here from the session; `as` can only ask for less.
 * Every role may read its own, front desk included; the answer is built from
 * the venue's saved configuration alone, each request.
 *
 * Until the playbook is built on it, the answer is the role's `facts` from
 * the profile (lib/guide/facts.ts).
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = guideVenue(admin, req.nextUrl.searchParams.get("venueId"));
  if (venueId instanceof NextResponse) return venueId;
  const own = ownRole(admin);
  const asked = req.nextUrl.searchParams.get("as");
  let role = own;
  if (asked !== null && asked !== "") {
    if (!isGuideRole(asked)) return NextResponse.json({ error: "That is not a guide role." }, { status: 400 });
    if (!mayViewAs(own, asked)) return NextResponse.json({ error: "You can see the guide only for your own role or one below it." }, { status: 403 });
    role = asked;
  }
  const profile = await readVenueProfile(venueId);
  return NextResponse.json(
    { venueId, role, ownRole: own, roles: GUIDE_ROLES.filter((r) => mayViewAs(own, r)), facts: guideFacts(profile, role) },
    { headers: { "Cache-Control": "no-store" } }
  );
}
