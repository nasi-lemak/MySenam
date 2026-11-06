import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { readJsonObject, refusal } from "@/lib/api";
import { staffTeamLeague } from "@/lib/team-league-access";
import { closeTeamLeague, generateFixtures, postponeLeagueDay, teamLeagueDetail } from "@/lib/team-leagues";

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
 * and gives the court time back; `{ action: "postpone_day", from, to }` moves each fixture still to play on `from` to the same time on `to` (another of the
 * league's courts where its own is not free), one at a time by the checks of any move, each moved one telling both captains; answers `moved` and `left` (the fixtures
 * that could not be placed, with why, still where they were; ADR 0059).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const found = await staffTeamLeague(req, (await params).id);
  if (found instanceof NextResponse) return found;
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  if (body.action === "postpone_day") {
    const moved = await postponeLeagueDay(found.id, String(body.from ?? ""), String(body.to ?? ""));
    if (!moved.ok) return refusal(moved, moved.status ?? 409);
    await logAction(found.admin, { venueId: found.venueId, action: "team_league.fixture_moved", detail: `${found.name}: ${moved.value.moved} fixture(s) postponed from ${String(body.from)} to ${String(body.to)}, ${moved.value.left.length} left` });
    return NextResponse.json({ league: await teamLeagueDetail(found.id, { forStaff: true }), moved: moved.value.moved, left: moved.value.left });
  }
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
