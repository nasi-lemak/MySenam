import { NextRequest, NextResponse } from "next/server";
import { getSessionAdmin } from "@/lib/admin-auth";
import { getVenue, listVenues } from "@/lib/store";
import { pruneIfDue } from "@/lib/privacy";

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
  const venues =
    admin.venueId === null
      ? await listVenues()
      : await getVenue(admin.venueId).then((v) => (v ? [v] : []));
  return NextResponse.json({ admin, venues });
}
