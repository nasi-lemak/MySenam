import { NextRequest, NextResponse } from "next/server";
import { listVenuePage, readNear } from "@/lib/store";
import { storefrontForRequest } from "@/lib/storefront";
import { Sport, SPORTS } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Venues a page at a time, or on a storefront, its own.
 *
 *   ?area=Petaling Jaya   only that area
 *   ?sport=badminton      only venues with a court for it
 *   ?page=2&pageSize=50   which page (pageSize at most 100)
 *   ?near=3.13,101.68&km=10   within 10 km of there, nearest first, with distanceKm
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const sport = params.get("sport");
  if (sport && !SPORTS.includes(sport as Sport))
    return NextResponse.json({ error: "Unknown sport." }, { status: 400 });
  const page = await listVenuePage({
    area: params.get("area") || undefined,
    sport: (sport as Sport) || undefined,
    venueIds: (await storefrontForRequest(req))?.venueIds,
    near: readNear(params.get("near"), params.get("km")) ?? undefined,
    page: Number(params.get("page")) || 1,
    pageSize: Number(params.get("pageSize")) || 50,
  });
  return NextResponse.json(page);
}
