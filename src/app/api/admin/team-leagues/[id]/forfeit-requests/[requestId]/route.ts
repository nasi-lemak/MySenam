import { NextRequest, NextResponse } from "next/server";
import { readJsonObject, refusal } from "@/lib/api";
import { getDb } from "@/lib/db";
import { staffTeamLeague } from "@/lib/team-league-access";
import { decideForfeitRequest, withdrawForfeitRequest } from "@/lib/team-forfeits";
import { teamLeagueDetail } from "@/lib/team-leagues";

export const dynamic = "force-dynamic";

async function requestOf(leagueId: number, raw: string) {
  const id = Number(raw);
  if (!Number.isInteger(id)) return null;
  return (await getDb().prepare("SELECT id FROM team_forfeit_requests WHERE id = ? AND league_id = ?").get(id, leagueId)) as { id: number } | undefined;
}

/**
 * A manager decides a forfeit request (`MANAGER_ONLY`): `{ confirm: true, version? }` gives the fixture as a forfeit by the team
 * asked, through the same path as any forfeit (table, ratings, court time), the table before and after kept with the request;
 * `{ decline: true, reason }` declines it, both captains told the reason. `version`: the fixture as the manager saw it.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; requestId: string }> }) {
  const { id, requestId } = await params;
  const found = await staffTeamLeague(req, id);
  if (found instanceof NextResponse) return found;
  const request = await requestOf(found.id, requestId);
  if (!request) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const decision = body.confirm === true ? { confirm: true as const } : body.decline === true ? { decline: true as const, reason: body.reason } : null;
  if (!decision) return NextResponse.json({ error: "Confirm it, or decline it with a reason." }, { status: 400 });
  const done = await decideForfeitRequest(request.id, { id: found.admin.id, name: found.admin.name }, decision, Number.isInteger(body.version) ? { version: body.version as number } : {});
  if (!done.ok) return refusal(done, done.status ?? 409);
  return NextResponse.json({ request: done.value, league: await teamLeagueDetail(found.id, { forStaff: true }) });
}

/** The member of staff who asked takes their request back (the desk may); nobody else's. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string; requestId: string }> }) {
  const { id, requestId } = await params;
  const found = await staffTeamLeague(req, id);
  if (found instanceof NextResponse) return found;
  const request = await requestOf(found.id, requestId);
  if (!request) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const done = await withdrawForfeitRequest({ admin: { id: found.admin.id, name: found.admin.name } }, request.id);
  if (!done.ok) return refusal(done, done.status ?? 409);
  return NextResponse.json({ league: await teamLeagueDetail(found.id, { forStaff: true }) });
}
