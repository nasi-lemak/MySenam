import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { counterEntrant, isEntrantRefusal } from "@/lib/competition-entrants";
import { jsonBody, staffLeague } from "@/lib/league-access";
import { joinAs, leagueById, leagueDetail } from "@/lib/leagues";

export const dynamic = "force-dynamic";

/**
 * Staff add a player at the counter (front desk or a manager, as a counter
 * booking): `{ phone, name }` on staff's word, or `{ phone, participantId }`
 * for a participant the venue knows whose live guardian is on that number;
 * `partnerName?` and `partnerGender?` for pairs, `gender?` (the player's,
 * declared) in a women's or men's league. The number is what box-mates are
 * given to arrange matches. The same checks as a player joining themself
 * (lib/leagues.ts `joinAs`); in the activity log.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const found = await staffLeague(req, (await params).id);
  if (found instanceof NextResponse) return found;
  const body = await jsonBody(req);
  if (body instanceof NextResponse) return body;
  const league = (await leagueById(found.id))!;
  const entrant = await counterEntrant(league.venueId, found.admin, body);
  if (isEntrantRefusal(entrant)) return NextResponse.json({ error: entrant.error, code: entrant.code, ...(entrant.vars ? { vars: entrant.vars } : {}) }, { status: entrant.status ?? 409 });
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const result = await joinAs(entrant, league.id, { partnerName: str(body.partnerName), partnerGender: str(body.partnerGender), gender: str(body.gender) });
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code, ...(result.vars ? { vars: result.vars } : {}) }, { status: 409 });
  await logAction(found.admin, { venueId: league.venueId, action: "league.joined_at_counter", detail: `${league.name}: ${result.value.name}` });
  return NextResponse.json({ player: result.value, league: await leagueDetail(league.id, { forStaff: true }) }, { status: 201 });
}
