import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { MAX_NO_SHOWS, myGames } from "@/lib/games";
import { myNoShowMarks } from "@/lib/no-show-marks";

export const dynamic = "force-dynamic";

/**
 * The signed-in player's games: hosting, with who asked; and playing. And `marks`: the no-show marks that count against them or wait for a
 * review (lib/no-show-marks.ts), each with where it counts; `noShows` is the most that count at any one venue (those that count everywhere
 * included), the number the limit `maxNoShows` is held against.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const marks = await myNoShowMarks(user.id);
  const counting = marks.filter((m) => m.counts);
  const everywhere = counting.filter((m) => m.scope !== "venue").length;
  const perVenue = new Map<string, number>();
  for (const m of counting) if (m.scope === "venue") perVenue.set(m.venueName, (perVenue.get(m.venueName) ?? 0) + 1);
  const noShows = everywhere + Math.max(0, ...perVenue.values());
  return NextResponse.json({ ...(await myGames(user.id)), noShows, maxNoShows: MAX_NO_SHOWS, marks });
}
