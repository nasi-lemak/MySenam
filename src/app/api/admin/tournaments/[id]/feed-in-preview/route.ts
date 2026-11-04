import { NextRequest, NextResponse } from "next/server";
import { feedInPreview, tournamentById } from "@/lib/tournaments";
import { staffTournament } from "@/lib/tournament-access";

export const dynamic = "force-dynamic";

/**
 * What an advanced feed-in consolation draw would add to this tournament's knockout (ADR 0034, M), for the entries it has (or the
 * most it takes while fewer than five have entered), or for `?entries=` (2 to 128) and `?consolationThirdPlace=1|0` to ask about
 * another: the matches in the main and the consolation draw, the court hours, the rounds, the most matches one entrant can play,
 * and whether the court time held would hold them (an estimate: the draw itself refuses, changing nothing, if a match cannot be
 * placed). Read-only, for any staff of the venue; nothing is changed.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const found = await staffTournament(req, (await params).id);
  if (found instanceof NextResponse) return found;
  const t = (await tournamentById(found.id))!;
  if (t.format !== "knockout") return NextResponse.json({ error: "A feed-in consolation draw is for a straight knockout." }, { status: 409 });
  const asked = req.nextUrl.searchParams.get("entries");
  const entries = asked === null ? undefined : Number(asked);
  if (entries !== undefined && (!Number.isInteger(entries) || entries < 2 || entries > 128)) return NextResponse.json({ error: "Between 2 and 128 entries." }, { status: 400 });
  const third = req.nextUrl.searchParams.get("consolationThirdPlace");
  const consolationThirdPlace = third === null ? t.rules.bracket.consolationThirdPlace : third === "1" || third === "true";
  return NextResponse.json({ preview: feedInPreview(t, consolationThirdPlace, entries) });
}
