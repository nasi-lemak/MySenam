import { NextRequest, NextResponse } from "next/server";
import { phoneRefusal } from "@/lib/phone-check";
import { refusal } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import { jsonBody } from "@/lib/league-access";
import { join, leagueById, leagueDetail, leave, myLeague } from "@/lib/leagues";
import { mayShowVenue } from "@/lib/listing";
import { startLeaguePayment } from "@/lib/payments";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

async function visible(req: NextRequest, id: number) {
  const league = await leagueById(id);
  if (!league) return null;
  return (await mayShowVenue(league.venueId, req)).show ? league : null;
}

/** The boxes, the tables and the results, `?season=` for an earlier one; and, signed in, your place and box-mates. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const league = await visible(req, Number((await params).id));
  if (!league) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const raw = req.nextUrl.searchParams.get("season");
  const user = await getSessionUser(req);
  return NextResponse.json({
    league: await leagueDetail(league.id, { season: raw ? Number(raw) : undefined }),
    mine: user ? await myLeague(user.id, league.id) : null,
    signedIn: user !== null,
  });
}

/** `{ action: "join", partnerName? }`, `{ action: "leave" }`, or `{ action: "pay" }` this season's fee. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in to join." }, { status: 401 });
  const league = await visible(req, Number((await params).id));
  if (!league) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const body = await jsonBody(req);
  if (body instanceof NextResponse) return body;
  if (body.action === "pay") {
    const limited = rateLimit(req, "payment");
    if (limited) return limited;
    const paying = await startLeaguePayment(user, league.id);
    if (!paying.ok) return NextResponse.json({ error: paying.error }, { status: paying.status });
    return NextResponse.json({ url: paying.url });
  }
  if (body.action === "join") {
    const limited = rateLimit(req, "booking");
    if (limited) return limited;
    // Box-mates are given this number to arrange matches: it had better be theirs.
    const noPhone = await phoneRefusal(user.id);
    if (noPhone) return refusal(noPhone, 403);
    const result = await join(user, league.id, { partnerName: typeof body.partnerName === "string" ? body.partnerName : undefined });
    if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.code ? 403 : 409 });
    return NextResponse.json({ mine: await myLeague(user.id, league.id) }, { status: 201 });
  }
  if (body.action === "leave") {
    const mine = await myLeague(user.id, league.id);
    if (!mine) return NextResponse.json({ error: "You are not in this league." }, { status: 404 });
    const result = await leave(mine.playerId);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
    return NextResponse.json({ mine: null });
  }
  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
