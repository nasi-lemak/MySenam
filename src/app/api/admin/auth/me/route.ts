import { NextRequest, NextResponse } from "next/server";
import { getSessionAdmin } from "@/lib/admin-auth";
import { listVenues } from "@/lib/store";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  const admin = getSessionAdmin(req);
  if (!admin) return NextResponse.json({ admin: null, venues: [] });

  // Only the venues this admin may manage.
  const venues = listVenues().filter((v) => admin.venueId === null || v.id === admin.venueId);
  return NextResponse.json({ admin, venues });
}
