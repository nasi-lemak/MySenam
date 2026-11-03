import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { refusal } from "@/lib/api";
import { getDb } from "@/lib/db";
import { staffTeamLeague } from "@/lib/team-league-access";
import { teamLeagueDetail, withdrawTeam } from "@/lib/team-leagues";

export const dynamic = "force-dynamic";

/**
 * A manager taking a team out of the league. Before the fixtures are made it simply goes; after, each fixture it had still
 * to play is a forfeit to the other side (their court time back) and what was played still counts. The opposing captains are told.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string; teamId: string }> }) {
  const { id, teamId } = await params;
  const found = await staffTeamLeague(req, id);
  if (found instanceof NextResponse) return found;
  const team = (await getDb().prepare("SELECT id, name FROM team_league_teams WHERE id = ? AND league_id = ?").get(Number(teamId), found.id)) as { id: number; name: string } | undefined;
  if (!team) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const done = await withdrawTeam({ adminId: found.admin.id }, team.id);
  if (!done.ok) return refusal(done, done.status ?? 409);
  await logAction(found.admin, { venueId: found.venueId, action: "team_league.team_removed", detail: `${found.name}: ${team.name}` });
  return NextResponse.json({ league: await teamLeagueDetail(found.id, { forStaff: true }) });
}
