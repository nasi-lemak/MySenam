import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { readJsonObject, refusal } from "@/lib/api";
import { getDb } from "@/lib/db";
import { deskRefusal } from "@/lib/roles";
import { staffTeamLeague } from "@/lib/team-league-access";
import { decideFixture, isWholeFixtureWalkover, moveFixture, teamLeagueDetail, type DecideInput } from "@/lib/team-leagues";

export const dynamic = "force-dynamic";

async function fixtureOf(leagueId: number, raw: string) {
  const id = Number(raw);
  if (!Number.isInteger(id)) return null;
  return (await getDb().prepare("SELECT id FROM team_fixtures WHERE id = ? AND league_id = ?").get(id, leagueId)) as { id: number } | undefined;
}

const version = (b: Record<string, unknown>) => (Number.isInteger(b.version) ? { version: b.version as number } : {});

/**
 * Staff decide a fixture (the front desk may): `{ rubbers: [{ winner, score?, walkover? }] }` its games' results, taken as
 * confirmed; `{ forfeitBy: leagueTeamId }` a forfeit, the other side awarded every game (a manager's: the desk is refused, as it is
 * at `.../forfeit`, and asks for one at `.../forfeit-requests`); `{ void: true }` strikes it;
 * `{ clear: true }` puts it back to be played. `version`: the fixture as staff saw it; refused as changed if a captain reported
 * or answered since. Both captains are emailed.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; fixtureId: string }> }) {
  const { id, fixtureId } = await params;
  const found = await staffTeamLeague(req, id);
  if (found instanceof NextResponse) return found;
  const fixture = await fixtureOf(found.id, fixtureId);
  if (!fixture) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const input: DecideInput | null =
    body.void === true ? { void: true } : body.clear === true ? { clear: true } : Number.isInteger(body.forfeitBy) ? { forfeitBy: body.forfeitBy as number } : Array.isArray(body.rubbers) ? { rubbers: body.rubbers } : null;
  if (!input) return NextResponse.json({ error: "Give the games' results, a forfeit, void or clear." }, { status: 400 });
  // A forfeit changes the table and what follows: a manager's, whichever address it is sent to (lib/roles.ts).
  if ("forfeitBy" in input || ("rubbers" in input && isWholeFixtureWalkover(input.rubbers))) {
    const denied = deskRefusal(found.admin.role, "POST", `/api/admin/team-leagues/${found.id}/fixtures/${fixture.id}/forfeit`);
    if (denied) return denied;
  }
  const done = await decideFixture(fixture.id, found.admin.id, input, version(body));
  if (!done.ok) return refusal(done, done.status ?? 409);
  const detail = await teamLeagueDetail(found.id, { forStaff: true });
  const f = detail?.fixtures.find((x) => x.id === fixture.id);
  await logAction(found.admin, {
    venueId: found.venueId,
    action: "void" in input ? "team_league.fixture_void" : "clear" in input ? "team_league.fixture_cleared" : "forfeitBy" in input ? "team_league.fixture_forfeit" : "team_league.fixture_decided",
    detail: `${found.name}: ${f?.home.name ?? ""} v ${f?.away.name ?? ""} on ${f?.date ?? ""} — ${f?.status ?? ""}${f?.result?.score ? ` ${f.result.score}` : ""}`,
  });
  return NextResponse.json({ league: detail });
}

/** A manager's: `{ date, startMin, courtId? , version? }` moves a fixture still to play; its new court time is held, or nothing changes. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; fixtureId: string }> }) {
  const { id, fixtureId } = await params;
  const found = await staffTeamLeague(req, id);
  if (found instanceof NextResponse) return found;
  const fixture = await fixtureOf(found.id, fixtureId);
  if (!fixture) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const before = (await teamLeagueDetail(found.id, { forStaff: true }))?.fixtures.find((x) => x.id === fixture.id);
  const done = await moveFixture(fixture.id, { date: body.date, startMin: body.startMin, courtId: body.courtId }, version(body));
  if (!done.ok) return refusal(done, done.status ?? 409);
  const detail = await teamLeagueDetail(found.id, { forStaff: true });
  const after = detail?.fixtures.find((x) => x.id === fixture.id);
  await logAction(found.admin, {
    venueId: found.venueId,
    action: "team_league.fixture_moved",
    detail: `${found.name}: ${after?.home.name ?? ""} v ${after?.away.name ?? ""} from ${before?.date ?? ""} ${before?.startMin ?? ""} to ${after?.date ?? ""} ${after?.startMin ?? ""}`,
  });
  return NextResponse.json({ league: detail });
}
