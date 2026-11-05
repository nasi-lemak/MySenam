import { NextRequest, NextResponse } from "next/server";
import { readJsonObject } from "@/lib/api";
import { getDb } from "@/lib/db";
import { ladderResponse, staffLadder } from "@/lib/ladder-access";
import { ladderDetail } from "@/lib/ladders";
import { requestLadderForfeit } from "@/lib/team-forfeits";

export const dynamic = "force-dynamic";

/**
 * Staff (the front desk too) ask for a forfeit on a challenge of a ladder of teams: `{ challengeId, forfeitPlayer: the place (team) asked to
 * forfeit, reason: "no_show" | "short_handed" | "told_us" | "other", note? }` (up to 300 characters; `other` needs one). It changes nothing but
 * the request: a manager confirms or declines it (`POST .../forfeit-requests/:id`). The managers are emailed, and the other captain if a
 * captain asked. One open request per challenge and person.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const found = await staffLadder(req, (await params).id);
  if (found instanceof NextResponse) return found;
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const challenge = (await getDb().prepare("SELECT id FROM ladder_challenges WHERE id = ? AND ladder_id = ?").get(Number(body.challengeId), found.id)) as { id: number } | undefined;
  if (!challenge) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const done = await requestLadderForfeit({ admin: { id: found.admin.id, name: found.admin.name } }, challenge.id, { forfeitPlayer: body.forfeitPlayer, reason: body.reason, note: body.note });
  if (!done.ok) return ladderResponse(done);
  return NextResponse.json({ request: done.value, ladder: await ladderDetail(found.id, { forStaff: true }) }, { status: 201 });
}
