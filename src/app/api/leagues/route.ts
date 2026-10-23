import { isActivity } from "@/lib/activities";
import { NextRequest, NextResponse } from "next/server";
import { publicLeagues } from "@/lib/leagues";
import { storefrontForRequest } from "@/lib/storefront";
import { type Sport } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Leagues taking players: `?sport=`. */
export async function GET(req: NextRequest) {
  const sport = req.nextUrl.searchParams.get("sport");
  if (sport && !(await isActivity(sport))) return NextResponse.json({ error: "Unknown sport." }, { status: 400 });
  return NextResponse.json({
    leagues: await publicLeagues({
      sport: (sport as Sport) || undefined,
      venueIds: (await storefrontForRequest(req))?.venueIds,
    }),
  });
}
