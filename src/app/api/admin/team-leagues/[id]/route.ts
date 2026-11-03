import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { readJsonObject, refusal } from "@/lib/api";
import { staffTeamLeague } from "@/lib/team-league-access";
import { closeTeamLeague, generateFixtures, teamLeagueDetail } from "@/lib/team-leagues";

export const dynamic = "force-dynamic";

/** The league as staff see it: every team's roster, the dates teams cannot play, lineups, every fixture and the table. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const found = await staffTeamLeague(req, (await params).id);
  if (found instanceof NextResponse) return found;
  return NextResponse.json({ league: await teamLeagueDetail(found.id, { forStaff: true }) });
}

/**
 * A manager's: `{ action: "generate", nights: [{ date, startMin }] }` makes (or makes again, until a lineup or a result is
 * in) the fixture list on those match nights, holding each fixture's court time; `{ action: "close" }` stops the league
 * and gives the court time back.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const found = await staffTeamLeague(req, (await params).id);
  if (found instanceof NextResponse) return found;
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const result = body.action === "generate" ? await generateFixtures(found.id, body.nights) : body.action === "close" ? await closeTeamLeague(found.id) : null;
  if (!result) return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  if (!result.ok) return refusal(result, result.status ?? 409);
  const detail = await teamLeagueDetail(found.id, { forStaff: true });
  await logAction(found.admin, {
    venueId: found.venueId,
    action: body.action === "generate" ? "team_league.fixtures_made" : "team_league.closed",
    detail: body.action === "generate" ? `${found.name}: ${detail?.fixtures.length ?? 0} fixtures on ${detail?.nights.length ?? 0} nights` : found.name,
  });
  return NextResponse.json({ league: detail });
}
