import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { logAction } from "@/lib/activity";
import { jsonBody, staffLeague } from "@/lib/league-access";
import { leagueDetail, leave, setStartBox } from "@/lib/leagues";

export const dynamic = "force-dynamic";

/** `{ startBox }` (a number, or null) for a newcomer, or `{ remove: true }`; in the activity log either way. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; playerId: string }> }) {
  const { id, playerId } = await params;
  const found = await staffLeague(req, id);
  if (found instanceof NextResponse) return found;
  const player = (await getDb()
    .prepare("SELECT p.id, p.name, l.name AS league, l.venue_id FROM league_players p JOIN leagues l ON l.id = p.league_id WHERE p.id = ? AND p.league_id = ?")
    .get(Number(playerId), found.id)) as { id: number; name: string; league: string; venue_id: number } | undefined;
  if (!player) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const body = await jsonBody(req);
  if (body instanceof NextResponse) return body;
  const box = "startBox" in body ? (body.startBox === null || body.startBox === "" ? null : Number(body.startBox)) : undefined;
  const result =
    body.remove === true ? await leave(player.id) : box !== undefined ? await setStartBox(player.id, box) : null;
  if (!result) return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  await logAction(found.admin, {
    venueId: player.venue_id,
    action: body.remove === true ? "league.player_removed" : "league.start_box",
    detail: `${player.league}: ${player.name}${body.remove === true ? " taken out" : `, starts in ${box === null ? "the box the league gives" : `box ${box}`}`}`,
  });
  return NextResponse.json({ league: await leagueDetail(found.id, { forStaff: true }) });
}
