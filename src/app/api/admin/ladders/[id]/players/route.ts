import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { readJsonObject } from "@/lib/api";
import { counterEntrant, isEntrantRefusal } from "@/lib/competition-entrants";
import { ladderResponse, staffLadder } from "@/lib/ladder-access";
import { joinAs, ladderById, ladderDetail } from "@/lib/ladders";

export const dynamic = "force-dynamic";

/**
 * Staff add a player at the counter (front desk or a manager, as a counter booking), at the bottom:
 * `{ phone, name }` on staff's word, or `{ phone, participantId }` for a participant the venue knows whose live guardian is on that number
 * (a junior ladder's); `adult: true` for an adult ladder (the player says they are 18 or over); `partnerName?`, `partnerGender?` for
 * pairs, `gender?` in a women's or men's ladder. The same checks as joining online (lib/ladders.ts `joinAs`); in the activity log.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const found = await staffLadder(req, (await params).id);
  if (found instanceof NextResponse) return found;
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const ladder = (await ladderById(found.id))!;
  const entrant = await counterEntrant(ladder.venueId, found.admin, body);
  if (isEntrantRefusal(entrant)) return NextResponse.json({ error: entrant.error, code: entrant.code, ...(entrant.vars ? { vars: entrant.vars } : {}) }, { status: entrant.status ?? 409 });
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const result = await joinAs(entrant, ladder.id, { partnerName: str(body.partnerName), partnerGender: str(body.partnerGender), gender: str(body.gender), adult: body.adult === true });
  if (!result.ok) return ladderResponse(result);
  await logAction(found.admin, { venueId: ladder.venueId, action: "ladder.joined_at_counter", detail: `${ladder.name}: ${entrant.name}` });
  return NextResponse.json({ player: result.value, ladder: await ladderDetail(ladder.id, { forStaff: true }) }, { status: 201 });
}
