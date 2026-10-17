import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { jsonBody, staffLeague } from "@/lib/league-access";
import { leagueDetail, leave, setStartBox } from "@/lib/leagues";

export const dynamic = "force-dynamic";

/** `{ startBox }` (a number, or null) for a newcomer, or `{ remove: true }`. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; playerId: string }> }) {
  const { id, playerId } = await params;
  const found = await staffLeague(req, id);
  if (found instanceof NextResponse) return found;
  const player = (await getDb()
    .prepare("SELECT id FROM league_players WHERE id = ? AND league_id = ?")
    .get(Number(playerId), found.id)) as { id: number } | undefined;
  if (!player) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const body = await jsonBody(req);
  if (body instanceof NextResponse) return body;
  const result =
    body.remove === true
      ? await leave(player.id)
      : "startBox" in body
        ? await setStartBox(player.id, body.startBox === null || body.startBox === "" ? null : Number(body.startBox))
        : null;
  if (!result) return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ league: await leagueDetail(found.id, { forStaff: true }) });
}
