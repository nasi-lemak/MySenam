import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { MAX_NO_SHOWS, myGames, recentNoShows } from "@/lib/games";

export const dynamic = "force-dynamic";

/** The signed-in player's games: hosting, with who asked; and playing. */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const noShows = await recentNoShows(user.id);
  return NextResponse.json({ ...(await myGames(user.id)), noShows, maxNoShows: MAX_NO_SHOWS });
}
