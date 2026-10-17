import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { jsonBody, staffLeague } from "@/lib/league-access";
import { leagueDetail, setPlacePaid } from "@/lib/leagues";

export const dynamic = "force-dynamic";

/** `{ paid }` — a season's fee taken at the counter, or not. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; placeId: string }> }) {
  const { id, placeId } = await params;
  const found = await staffLeague(req, id);
  if (found instanceof NextResponse) return found;
  const place = (await getDb()
    .prepare(
      `SELECT lp.id, s.number FROM league_places lp JOIN league_seasons s ON s.id = lp.season_id
        WHERE lp.id = ? AND s.league_id = ?`
    )
    .get(Number(placeId), found.id)) as { id: number; number: number } | undefined;
  if (!place) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const body = await jsonBody(req);
  if (body instanceof NextResponse) return body;
  if (typeof body.paid !== "boolean") return NextResponse.json({ error: "Paid, or not?" }, { status: 400 });
  const result = await setPlacePaid(place.id, body.paid);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ league: await leagueDetail(found.id, { forStaff: true, season: place.number }) });
}
