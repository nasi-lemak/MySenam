import { isActivity } from "@/lib/activities";
import { NextRequest, NextResponse } from "next/server";
import { publicTournaments } from "@/lib/tournaments";
import { storefrontForRequest } from "@/lib/storefront";
import { type Sport } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Tournaments coming up, or just played: `?sport=`. */
export async function GET(req: NextRequest) {
  const sport = req.nextUrl.searchParams.get("sport");
  if (sport && !(await isActivity(sport))) return NextResponse.json({ error: "Unknown sport." }, { status: 400 });
  return NextResponse.json({
    tournaments: await publicTournaments({
      sport: (sport as Sport) || undefined,
      venueIds: (await storefrontForRequest(req))?.venueIds,
    }),
  });
}
