import { isActivity } from "@/lib/activities";
import { NextRequest, NextResponse } from "next/server";
import { publicLadders } from "@/lib/ladders";
import { storefrontForRequest } from "@/lib/storefront";
import { type Sport } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Ladders taking players, at venues customers can reach: `?sport=`. */
export async function GET(req: NextRequest) {
  const sport = req.nextUrl.searchParams.get("sport");
  if (sport && !(await isActivity(sport))) return NextResponse.json({ error: "Unknown sport." }, { status: 400 });
  return NextResponse.json({
    ladders: await publicLadders({
      sport: (sport as Sport) || undefined,
      venueIds: (await storefrontForRequest(req))?.venueIds,
    }),
  });
}
