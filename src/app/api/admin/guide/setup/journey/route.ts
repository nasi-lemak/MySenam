import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { guideVenue, ownRole } from "@/lib/guide/http";
import { isFocus, journeyView } from "@/lib/guide/setup-journey";

export const dynamic = "force-dynamic";

/**
 * What the setup journey draws (docs/features/venue-guide.md#the-setup-journey):
 * the venue's setup view as `GET /api/admin/guide/setup` answers it, with the
 * plan narrowed to `?focus=` (a group or a capability, for a targeted
 * journey: 400 for one that does not exist) and `extras`: the venue's hours
 * and courts for the editors it runs, a price example from the real pricing
 * function, and what *Try it* can tick from saved state. Reads only; a
 * manager's (lib/roles.ts MANAGER_ONLY: front desk is refused), a branch
 * manager reading their own branches only, as everywhere under /api/admin.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = guideVenue(admin, req.nextUrl.searchParams.get("venueId"));
  if (venueId instanceof NextResponse) return venueId;
  const asked = req.nextUrl.searchParams.get("focus");
  if (asked !== null && asked !== "" && !isFocus(asked)) return NextResponse.json({ error: "There is no such part of the setup." }, { status: 400 });
  return NextResponse.json(await journeyView(venueId, ownRole(admin), asked || null), { headers: { "Cache-Control": "no-store" } });
}
