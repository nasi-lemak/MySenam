import { NextRequest, NextResponse } from "next/server";
import { readJsonObject, refusal } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import { mayShowVenue } from "@/lib/listing";
import { rateLimit } from "@/lib/rate-limit";
import { captainedTeams } from "@/lib/teams";
import {
  confirmFixture,
  disputeFixture,
  enterTeam,
  reportFixture,
  setBlackouts,
  setLeagueRoster,
  setLineup,
  teamLeagueById,
  teamLeagueDetail,
  withdrawTeam,
} from "@/lib/team-leagues";

export const dynamic = "force-dynamic";

async function visible(req: NextRequest, id: number) {
  const league = await teamLeagueById(id);
  if (!league) return null;
  return (await mayShowVenue(league.venueId, req)).show ? league : null;
}

/**
 * The teams, the fixture list, the results and the table, by team name (no player is named); and, signed in, your
 * teams in it with their rosters and lineups, a captain's dates the team cannot play, and `captained`: the teams you
 * captain that could enter.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const league = await visible(req, Number((await params).id));
  if (!league) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const user = await getSessionUser(req);
  return NextResponse.json({
    league: await teamLeagueDetail(league.id, { viewerId: user?.id ?? null }),
    captained: user ? await captainedTeams(user.id, league.sport) : [],
    signedIn: user !== null,
  });
}

const numbers = (v: unknown) => (Array.isArray(v) ? v.map((x) => Number(x)) : []);
const version = (b: Record<string, unknown>) => (Number.isInteger(b.version) ? { version: b.version as number } : {});

/**
 * `{ action }`: "enter" (`teamId`, `memberIds`, `homeCourtId?`, `blackouts?`: a team you captain, the roster picked from
 * its members); for a team you captain, "roster" (`leagueTeamId`, `memberIds`), "blackouts" (`leagueTeamId`, `dates`),
 * "withdraw" (`leagueTeamId`), "lineup" (`fixtureId`, `picks`: for each game, the members who play it), "report"
 * (`fixtureId`, `rubbers`: each game's `winner` "home" or "away" and `score`, home side first, or `walkover`; `version`),
 * "confirm" (`fixtureId`, `version`) and "dispute" (`fixtureId`, `note`, `version`) the other side's report.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const league = await visible(req, Number((await params).id));
  if (!league) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const limited = await rateLimit(req, "social");
  if (limited) return limited;
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const fixtureId = Number(body.fixtureId);
  const leagueTeamId = Number(body.leagueTeamId);
  const done =
    body.action === "enter"
      ? await enterTeam(user.id, league.id, { teamId: body.teamId, memberIds: numbers(body.memberIds), homeCourtId: body.homeCourtId, blackouts: body.blackouts })
      : body.action === "roster"
        ? await setLeagueRoster(user.id, leagueTeamId, numbers(body.memberIds))
        : body.action === "blackouts"
          ? await setBlackouts(user.id, leagueTeamId, body.dates)
          : body.action === "withdraw"
            ? await withdrawTeam({ userId: user.id }, leagueTeamId)
            : body.action === "lineup"
              ? await setLineup(user.id, fixtureId, body.picks)
              : body.action === "report"
                ? await reportFixture(user.id, fixtureId, body.rubbers, version(body))
                : body.action === "confirm"
                  ? await confirmFixture(user.id, fixtureId, version(body))
                  : body.action === "dispute"
                    ? await disputeFixture(user.id, fixtureId, String(body.note ?? ""), version(body))
                    : null;
  if (!done) return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  if (!done.ok) return refusal(done, done.status ?? 409);
  return NextResponse.json({ ...(done.value && typeof done.value === "object" ? done.value : {}), league: await teamLeagueDetail(league.id, { viewerId: user.id }) }, { status: body.action === "enter" ? 201 : 200 });
}
