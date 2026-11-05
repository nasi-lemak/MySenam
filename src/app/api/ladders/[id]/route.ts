import { NextRequest, NextResponse } from "next/server";
import { readJsonObject, refusal } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import { guardianEntrant, isEntrantRefusal } from "@/lib/competition-entrants";
import { ladderResponse } from "@/lib/ladder-access";
import { challenge, freeze, join, joinAs, ladderById, ladderDetail, leave, myPlaces, thaw } from "@/lib/ladders";
import { captainedTeams } from "@/lib/teams";
import { joinTeam } from "@/lib/team-ladders";
import { mayShowVenue } from "@/lib/listing";
import { listManaged } from "@/lib/managed-people";
import { phoneRefusal } from "@/lib/phone-check";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

async function visible(req: NextRequest, id: number) {
  const ladder = await ladderById(id);
  if (!ladder) return null;
  return (await mayShowVenue(ladder.venueId, req)).show ? ladder : null;
}

/**
 * The ladder for anybody: the ranks and the confirmed results, never a challenge (`?season=` for an earlier season, whose final order is
 * kept); names as the ladder shows them (a junior ladder's by first name and initial). Signed in: your places on it (`mine`,
 * each with who you may challenge now and why not, your open challenges, and your history) and the people you act for (`people`,
 * to enter one on a junior ladder).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ladder = await visible(req, Number((await params).id));
  if (!ladder) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const raw = req.nextUrl.searchParams.get("season");
  const user = await getSessionUser(req);
  return NextResponse.json({
    ladder: await ladderDetail(ladder.id, { season: raw ? Number(raw) : undefined }),
    mine: user ? await myPlaces(user.id, ladder.id) : [],
    people: user ? (await listManaged(user.id)).map((p) => ({ id: p.id, name: p.displayName })) : [],
    // A ladder of teams: the teams this account captains for the sport, to enter one.
    teams: user && ladder.kind === "teams" ? await captainedTeams(user.id, ladder.sport) : [],
    signedIn: user !== null,
  });
}

/**
 * `{ action: "join", adult?, partnerName?, partnerGender?, gender? }`: on an adult ladder `adult: true` says they are 18 or over
 * (declared, never verified); `participantId` joins somebody the account acts for (junior ladders only).
 * `{ action: "join_team", teamId }` on a ladder of teams: the captain of the team enters it (`LAD2_*` refusals). `{ action: "leave", playerId }`
 * (a team's captain takes the team off). `{ action: "challenge", playerId, target, onDate?, minute? }`: the player (one of the account's
 * places) challenges one of the players within reach above. `{ action: "freeze", playerId, until }` and `{ action: "thaw", playerId }`.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const ladder = await visible(req, Number((await params).id));
  if (!ladder) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const limited = await rateLimit(req, "booking");
  if (limited) return limited;
  const mine = async (playerId: unknown) => (await myPlaces(user.id, ladder.id)).find((p) => p.playerId === Number(playerId)) ?? null;
  // A ladder of teams: the captain of a persistent team enters it, at the bottom; the captain acts for its place from then on.
  if (body.action === "join_team") {
    const noPhone = await phoneRefusal(user.id);
    if (noPhone) return refusal(noPhone, 403);
    const result = await joinTeam(user, ladder.id, body.teamId);
    if (!result.ok) return ladderResponse(result);
    return NextResponse.json({ mine: await myPlaces(user.id, ladder.id) }, { status: 201 });
  }
  if (body.action === "join") {
    // Opponents are given this number to arrange matches: it had better be theirs.
    const noPhone = await phoneRefusal(user.id);
    if (noPhone) return refusal(noPhone, 403);
    const forSomebody = body.participantId !== undefined && body.participantId !== null;
    const entrant = forSomebody ? await guardianEntrant(user, body.participantId) : null;
    if (isEntrantRefusal(entrant)) return NextResponse.json({ error: entrant.error, code: entrant.code }, { status: entrant.status ?? 403 });
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    const input = { partnerName: str(body.partnerName), partnerGender: str(body.partnerGender), gender: str(body.gender), adult: body.adult === true };
    const result = entrant ? await joinAs(entrant, ladder.id, input) : await join(user, ladder.id, input);
    if (!result.ok) return ladderResponse(result);
    return NextResponse.json({ mine: await myPlaces(user.id, ladder.id) }, { status: 201 });
  }
  if (!(await mine(body.playerId))) return NextResponse.json({ error: "That is not your place." }, { status: 404 });
  const playerId = Number(body.playerId);
  const done =
    body.action === "leave"
      ? await leave(playerId)
      : body.action === "challenge"
        ? await challenge(user.id, ladder.id, playerId, Number(body.target), { onDate: typeof body.onDate === "string" ? body.onDate : undefined, minute: body.minute === undefined ? undefined : Number(body.minute) })
        : body.action === "freeze"
          ? await freeze(user.id, playerId, String(body.until ?? ""))
          : body.action === "thaw"
            ? await thaw(user.id, playerId)
            : null;
  if (!done) return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  if (!done.ok) return ladderResponse(done);
  return NextResponse.json({ result: done.value, mine: await myPlaces(user.id, ladder.id) });
}
