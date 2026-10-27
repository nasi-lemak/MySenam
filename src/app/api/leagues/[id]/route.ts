import { NextRequest, NextResponse } from "next/server";
import { phoneRefusal } from "@/lib/phone-check";
import { refusal } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import { jsonBody } from "@/lib/league-access";
import { join, joinAs, leagueById, leagueDetail, leave, managedLeague, myLeague } from "@/lib/leagues";
import { guardianEntrant, isEntrantRefusal } from "@/lib/competition-entrants";
import { listManaged } from "@/lib/managed-people";
import { mayShowVenue } from "@/lib/listing";
import { startLeaguePayment } from "@/lib/payments";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

async function visible(req: NextRequest, id: number) {
  const league = await leagueById(id);
  if (!league) return null;
  return (await mayShowVenue(league.venueId, req)).show ? league : null;
}

/**
 * The boxes, the tables and the results, `?season=` for an earlier one; and, signed in, your place and box-mates,
 * the places you hold for people you act for (`managed`), and those people (`people`, to enter one).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const league = await visible(req, Number((await params).id));
  if (!league) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const raw = req.nextUrl.searchParams.get("season");
  const user = await getSessionUser(req);
  return NextResponse.json({
    league: await leagueDetail(league.id, { season: raw ? Number(raw) : undefined }),
    mine: user ? await myLeague(user.id, league.id) : null,
    managed: user ? await managedLeague(user.id, league.id) : [],
    people: user ? (await listManaged(user.id)).map((p) => ({ id: p.id, name: p.displayName })) : [],
    signedIn: user !== null,
  });
}

/**
 * `{ action: "join", partnerName?, partnerGender? }` (a partner's declared gender in a women's or men's league of
 * pairs); with `participantId`, somebody the account acts for joins (their declared `gender` in a women's or men's
 * league). `{ action: "leave", playerId? }`, or `{ action: "pay", playerId? }` this season's fee: the account's own
 * place, or one it holds for somebody it acts for.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in to join." }, { status: 401 });
  const league = await visible(req, Number((await params).id));
  if (!league) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const body = await jsonBody(req);
  if (body instanceof NextResponse) return body;
  if (body.action === "pay") {
    const limited = await rateLimit(req, "payment");
    if (limited) return limited;
    const paying = await startLeaguePayment(user, league.id, Number.isInteger(body.playerId) ? (body.playerId as number) : undefined);
    if (!paying.ok) return NextResponse.json({ error: paying.error }, { status: paying.status });
    return NextResponse.json({ url: paying.url });
  }
  if (body.action === "join") {
    const limited = await rateLimit(req, "booking");
    if (limited) return limited;
    // Box-mates are given this number to arrange matches: it had better be theirs.
    const noPhone = await phoneRefusal(user.id);
    if (noPhone) return refusal(noPhone, 403);
    const forSomebody = body.participantId !== undefined && body.participantId !== null;
    const entrant = forSomebody ? await guardianEntrant(user, body.participantId) : null;
    if (isEntrantRefusal(entrant)) return NextResponse.json({ error: entrant.error, code: entrant.code }, { status: entrant.status ?? 403 });
    const input = {
      partnerName: typeof body.partnerName === "string" ? body.partnerName : undefined,
      partnerGender: typeof body.partnerGender === "string" ? body.partnerGender : undefined,
      gender: typeof body.gender === "string" ? body.gender : undefined,
    };
    const result = entrant ? await joinAs(entrant, league.id, input) : await join(user, league.id, input);
    if (!result.ok)
      return NextResponse.json({ error: result.error, code: result.code, ...(result.vars ? { vars: result.vars } : {}) }, { status: result.code ? 403 : 409 });
    return NextResponse.json({ mine: await myLeague(user.id, league.id), managed: await managedLeague(user.id, league.id) }, { status: 201 });
  }
  if (body.action === "leave") {
    // The account's own place, or one it holds for somebody it still acts for.
    const mine = Number.isInteger(body.playerId)
      ? [await myLeague(user.id, league.id), ...(await managedLeague(user.id, league.id))].find((p) => p?.playerId === body.playerId) ?? null
      : await myLeague(user.id, league.id);
    if (!mine) return NextResponse.json({ error: "You are not in this league." }, { status: 404 });
    const result = await leave(mine.playerId);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
    return NextResponse.json({ mine: null });
  }
  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
