import { NextRequest, NextResponse } from "next/server";
import { readJsonObject } from "@/lib/api";
import { getDb } from "@/lib/db";
import { ladderResponse, staffLadder } from "@/lib/ladder-access";
import { ladderDetail } from "@/lib/ladders";
import { decideLadderForfeitRequest, withdrawLadderForfeitRequest } from "@/lib/team-forfeits";

export const dynamic = "force-dynamic";

async function requestOf(ladderId: number, raw: string) {
  const id = Number(raw);
  if (!Number.isInteger(id)) return null;
  return (await getDb()
    .prepare("SELECT r.id FROM team_forfeit_requests r JOIN ladder_challenges c ON c.id = r.ladder_challenge_id WHERE r.id = ? AND c.ladder_id = ?")
    .get(id, ladderId)) as { id: number } | undefined;
}

/**
 * A manager decides a forfeit request (`MANAGER_ONLY`): `{ confirm: true }` gives the challenge as a forfeit by the team asked, through the
 * ladder's own decision (the other team wins by default and takes the place, the ledger and the ratings follow, any court held is let go);
 * `{ decline: true, reason }` declines it, both captains told the reason.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; requestId: string }> }) {
  const { id, requestId } = await params;
  const found = await staffLadder(req, id);
  if (found instanceof NextResponse) return found;
  const request = await requestOf(found.id, requestId);
  if (!request) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const decision = body.confirm === true ? { confirm: true as const } : body.decline === true ? { decline: true as const, reason: body.reason } : null;
  if (!decision) return NextResponse.json({ error: "Confirm it, or decline it with a reason." }, { status: 400 });
  const done = await decideLadderForfeitRequest(request.id, { id: found.admin.id, name: found.admin.name }, decision);
  if (!done.ok) return ladderResponse(done);
  return NextResponse.json({ request: done.value, ladder: await ladderDetail(found.id, { forStaff: true }) });
}

/** The member of staff who asked takes their request back (the desk may); nobody else's. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string; requestId: string }> }) {
  const { id, requestId } = await params;
  const found = await staffLadder(req, id);
  if (found instanceof NextResponse) return found;
  const request = await requestOf(found.id, requestId);
  if (!request) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const done = await withdrawLadderForfeitRequest({ admin: { id: found.admin.id, name: found.admin.name } }, request.id);
  if (!done.ok) return ladderResponse(done);
  return NextResponse.json({ ladder: await ladderDetail(found.id, { forStaff: true }) });
}
