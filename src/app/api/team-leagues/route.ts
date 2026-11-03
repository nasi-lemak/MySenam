import { isActivity } from "@/lib/activities";
import { NextRequest, NextResponse } from "next/server";
import { publicTeamLeagues } from "@/lib/team-leagues";
import { storefrontForRequest } from "@/lib/storefront";

export const dynamic = "force-dynamic";

/** Leagues of teams taking teams or under way: `?sport=`. */
export async function GET(req: NextRequest) {
  const sport = req.nextUrl.searchParams.get("sport");
  if (sport && !(await isActivity(sport))) return NextResponse.json({ error: "Unknown sport." }, { status: 400 });
  return NextResponse.json({
    leagues: await publicTeamLeagues({
      sport: sport || undefined,
      venueIds: (await storefrontForRequest(req))?.venueIds,
    }),
  });
}
