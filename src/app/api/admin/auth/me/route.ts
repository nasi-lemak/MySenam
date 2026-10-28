import { NextRequest, NextResponse } from "next/server";
import { getSessionAdmin } from "@/lib/admin-auth";
import { isOwner } from "@/lib/admin-auth";
import { listVenues, listVenuesByIds } from "@/lib/store";
import { pruneIfDue } from "@/lib/privacy";
import { twoFactorStatus } from "@/lib/two-factor";
import { staffMay } from "@/lib/roles";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const admin = await getSessionAdmin(req);
  if (!admin) return NextResponse.json({ admin: null, venues: [] });

  // Housekeeping, on the way past. There is no scheduler in this system, so
  // the retention policy applies itself the first time staff open the
  // dashboard each day — and a venue nobody opens is a venue accumulating
  // nothing either.
  await pruneIfDue();

  // Only the venues this admin may manage: every one for the platform owner,
  // and for anybody else their own, read on its own rather than picked out
  // of every venue there is.
  const venues = isOwner(admin) ? await listVenues() : await listVenuesByIds(admin.venueIds ?? []);
  // What the dashboard may offer this account, as lib/roles.ts answers it: `may` for each control it asks about.
  return NextResponse.json({
    admin,
    venues,
    twoFactor: await twoFactorStatus(admin),
    canManage: admin.role !== "desk",
    may: staffMay(admin.role),
  });
}
