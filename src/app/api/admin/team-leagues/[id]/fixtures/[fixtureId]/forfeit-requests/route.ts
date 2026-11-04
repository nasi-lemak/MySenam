import { NextRequest, NextResponse } from "next/server";
import { readJsonObject, refusal } from "@/lib/api";
import { getDb } from "@/lib/db";
import { staffTeamLeague } from "@/lib/team-league-access";
import { requestForfeit } from "@/lib/team-forfeits";
import { teamLeagueDetail } from "@/lib/team-leagues";

export const dynamic = "force-dynamic";

/**
 * Staff (the front desk too) ask for a forfeit: `{ forfeitTeam: leagueTeamId, reason: "no_show" | "short_handed" | "told_us" | "other",
 * note? }` (up to 300 characters; `other` needs one). It changes nothing but the request: a manager confirms or declines it
 * (`POST .../forfeit-requests/:id`). The managers are emailed. One open request per fixture and person.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; fixtureId: string }> }) {
  const { id, fixtureId } = await params;
  const found = await staffTeamLeague(req, id);
  if (found instanceof NextResponse) return found;
  const fixture = (await getDb().prepare("SELECT id FROM team_fixtures WHERE id = ? AND league_id = ?").get(Number(fixtureId), found.id)) as { id: number } | undefined;
  if (!fixture) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const done = await requestForfeit({ admin: { id: found.admin.id, name: found.admin.name } }, fixture.id, { forfeitTeam: body.forfeitTeam, reason: body.reason, note: body.note });
  if (!done.ok) return refusal(done, done.status ?? 409);
  return NextResponse.json({ request: done.value, league: await teamLeagueDetail(found.id, { forStaff: true }) }, { status: 201 });
}
