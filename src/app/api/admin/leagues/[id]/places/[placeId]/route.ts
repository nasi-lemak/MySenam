import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { logAction } from "@/lib/activity";
import { jsonBody, staffLeague } from "@/lib/league-access";
import { leagueDetail, setPlacePaid } from "@/lib/leagues";
import { money } from "@/lib/region";

export const dynamic = "force-dynamic";

/** `{ paid }` — a season's fee taken at the counter, or not; in the activity log either way. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; placeId: string }> }) {
  const { id, placeId } = await params;
  const found = await staffLeague(req, id);
  if (found instanceof NextResponse) return found;
  const place = (await getDb()
    .prepare(
      `SELECT lp.id, s.number, l.venue_id, l.name AS league, l.fee::float AS fee, p.name
         FROM league_places lp JOIN league_seasons s ON s.id = lp.season_id JOIN leagues l ON l.id = s.league_id
         JOIN league_players p ON p.id = lp.player_id
        WHERE lp.id = ? AND s.league_id = ?`
    )
    .get(Number(placeId), found.id)) as { id: number; number: number; venue_id: number; league: string; fee: number; name: string } | undefined;
  if (!place) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const body = await jsonBody(req);
  if (body instanceof NextResponse) return body;
  if (typeof body.paid !== "boolean") return NextResponse.json({ error: "Paid, or not?" }, { status: 400 });
  const result = await setPlacePaid(place.id, body.paid);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  await logAction(found.admin, {
    venueId: place.venue_id,
    action: body.paid ? "league.fee_paid" : "league.fee_unpaid",
    detail: `${place.league}, season ${place.number}: ${place.name}, ${money(place.fee)}`,
  });
  return NextResponse.json({ league: await leagueDetail(found.id, { forStaff: true, season: place.number }) });
}
