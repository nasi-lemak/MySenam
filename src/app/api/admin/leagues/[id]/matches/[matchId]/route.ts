import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { jsonBody, staffLeague } from "@/lib/league-access";
import { decideResult, leagueDetail } from "@/lib/leagues";

export const dynamic = "force-dynamic";

/** `{ winner, score?, walkover? }` decides it; `{ void: true }` strikes it; `{ clear: true }` puts it back to be played. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; matchId: string }> }) {
  const { id, matchId } = await params;
  const found = await staffLeague(req, id);
  if (found instanceof NextResponse) return found;
  const match = (await getDb()
    .prepare(
      `SELECT m.id FROM league_matches m JOIN league_seasons s ON s.id = m.season_id
        WHERE m.id = ? AND s.league_id = ?`
    )
    .get(Number(matchId), found.id)) as { id: number } | undefined;
  if (!match) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const body = await jsonBody(req);
  if (body instanceof NextResponse) return body;
  const result = await decideResult(
    match.id,
    found.admin.id,
    body.void === true
      ? { void: true }
      : body.clear === true
        ? { clear: true }
        : { winner: Number(body.winner), score: typeof body.score === "string" ? body.score : undefined, walkover: body.walkover === true }
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ league: await leagueDetail(found.id, { forStaff: true }) });
}
