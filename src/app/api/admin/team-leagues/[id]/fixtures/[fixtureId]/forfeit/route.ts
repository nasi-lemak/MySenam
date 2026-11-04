import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { readJsonObject, refusal } from "@/lib/api";
import { getDb } from "@/lib/db";
import { staffTeamLeague } from "@/lib/team-league-access";
import { decideFixture, teamLeagueDetail } from "@/lib/team-leagues";

export const dynamic = "force-dynamic";

/**
 * A manager gives a fixture as a forfeit: `{ forfeitBy: leagueTeamId, version? }`, the other side awarded every game as the
 * sport's template says, the table, ratings and court time following as they do for any forfeit. A manager's act
 * (`MANAGER_ONLY`): the desk asks for one instead, at `.../forfeit-requests`. Both captains are emailed.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; fixtureId: string }> }) {
  const { id, fixtureId } = await params;
  const found = await staffTeamLeague(req, id);
  if (found instanceof NextResponse) return found;
  const fixture = (await getDb().prepare("SELECT id FROM team_fixtures WHERE id = ? AND league_id = ?").get(Number(fixtureId), found.id)) as { id: number } | undefined;
  if (!fixture) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  if (!Number.isInteger(body.forfeitBy)) return NextResponse.json({ error: "Say which team forfeits." }, { status: 400 });
  const done = await decideFixture(fixture.id, found.admin.id, { forfeitBy: body.forfeitBy as number }, Number.isInteger(body.version) ? { version: body.version as number } : {});
  if (!done.ok) return refusal(done, done.status ?? 409);
  const detail = await teamLeagueDetail(found.id, { forStaff: true });
  const f = detail?.fixtures.find((x) => x.id === fixture.id);
  await logAction(found.admin, {
    venueId: found.venueId,
    action: "team_league.fixture_forfeit",
    detail: `${found.name}: ${f?.home.name ?? ""} v ${f?.away.name ?? ""} on ${f?.date ?? ""} — ${f?.status ?? ""}`,
  });
  return NextResponse.json({ league: detail });
}
