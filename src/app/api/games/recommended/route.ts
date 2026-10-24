import { isActivity } from "@/lib/activities";
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { recommendGames } from "@/lib/matchmaking";
import { storefrontForRequest } from "@/lib/storefront";
import { type Sport } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Open games suggested for the signed-in player, best first, each with its
 * reasons (lib/matchmaking.ts): `?sport=&offset=&limit=`.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const params = req.nextUrl.searchParams;
  const sport = params.get("sport");
  if (sport && !(await isActivity(sport))) return NextResponse.json({ error: "Unknown sport." }, { status: 400 });
  const result = await recommendGames(user.id, {
    sport: (sport as Sport) || undefined,
    offset: Number(params.get("offset")) || 0,
    limit: Number(params.get("limit")) || 20,
    venueIds: (await storefrontForRequest(req))?.venueIds,
  });
  return NextResponse.json(result);
}
