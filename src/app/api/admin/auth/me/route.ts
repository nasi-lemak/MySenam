import { NextRequest, NextResponse } from "next/server";
import { getSessionAdmin } from "@/lib/admin-auth";
import { listVenues } from "@/lib/store";
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

  // Only the venues this admin may manage.
  const venues = (await listVenues()).filter((v) => admin.venueId === null || v.id === admin.venueId);
  return NextResponse.json({ admin, venues });
}
