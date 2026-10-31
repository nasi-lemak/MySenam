import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { guideVenue, ownRole } from "@/lib/guide/http";
import { playbookFor } from "@/lib/guide/playbook/server";
import { GUIDE_ROLES, isGuideRole, mayViewAs } from "@/lib/guide/shell";

export const dynamic = "force-dynamic";

/**
 * The operating playbook of a venue (`?venueId=`, or the admin's own), for a
 * role: the session's own, or with `as=` a role at or below it (a manager
 * preparing the front desk's or a coach's training), never above. The role a
 * guide is *for* is decided here from the session; `as` can only ask for less.
 * Every role may read its own, front desk included.
 *
 * The answer is `{ venueId, role, ownRole, roles, playbook }`: the playbook is
 * typed content (docs/features/venue-guide.md, "The operating playbook")
 * composed from the venue's saved configuration alone, on each request, and
 * kept nowhere: not here, not in a cache, not between venues. Links in it are
 * only those the role may use.
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
  const playbook = await playbookFor(venueId, role);
  return NextResponse.json(
    { venueId, role, ownRole: own, roles: GUIDE_ROLES.filter((r) => mayViewAs(own, r)), playbook },
    { headers: { "Cache-Control": "no-store" } }
  );
}
