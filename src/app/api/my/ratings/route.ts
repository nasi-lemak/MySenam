import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { RATING_FORMATS, type RatingFormat } from "@/lib/rating-math";
import { mayViewSubject, myRatings, ratingHistory, ratingRulesNow, type SubjectKind } from "@/lib/ratings";

export const dynamic = "force-dynamic";

/**
 * The signed-in player's ratings (lib/ratings.ts): their own, a child's they act for, and the teams they are on, each by venue,
 * sport and format. With `?venueId=&sport=&format=` and one of `participantId` (a child they act for) or `teamId` (a team they
 * are on), the results that moved it, newest first, each explained (the opponent, what was expected, how far it moved); without
 * either, their own.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const q = req.nextUrl.searchParams;
  const venueId = Number(q.get("venueId"));
  const sport = q.get("sport");
  const format = q.get("format");
  if (!venueId && !sport && !format) {
    const { rules } = await ratingRulesNow();
    return NextResponse.json({ ratings: await myRatings(user.id), rules: { start: rules.start, provisionalGames: rules.provisionalGames, matchBand: rules.matchBand } });
  }
  if (!Number.isInteger(venueId) || venueId <= 0 || !sport || !(RATING_FORMATS as string[]).includes(format ?? ""))
    return NextResponse.json({ error: "Which venue, sport and format?" }, { status: 400 });
  const participantId = Number(q.get("participantId"));
  const teamId = Number(q.get("teamId"));
  const subject: { kind: SubjectKind; id: number } = participantId > 0 ? { kind: "participant", id: participantId } : teamId > 0 ? { kind: "team", id: teamId } : { kind: "user", id: user.id };
  // Only their own, a child they act for, or a team they are on.
  if (!(await mayViewSubject(user.id, subject))) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ history: await ratingHistory(venueId, sport, format as RatingFormat, subject, { limit: Number(q.get("limit")) || 50 }) });
}
