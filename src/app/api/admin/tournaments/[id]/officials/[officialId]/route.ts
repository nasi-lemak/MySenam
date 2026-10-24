import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { revokeOfficial } from "@/lib/match-reports";
import { staffTournament } from "@/lib/tournament-access";

export const dynamic = "force-dynamic";

/** The official's link stops working. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string; officialId: string }> }) {
  const { id, officialId } = await params;
  const found = await staffTournament(req, id);
  if (found instanceof NextResponse) return found;
  if (!(await revokeOfficial(found.id, Number(officialId)))) return NextResponse.json({ error: "Not found, or withdrawn already." }, { status: 404 });
  await logAction(found.admin, { venueId: null, action: "tournament.official_removed", detail: `Tournament ${found.id}: official ${officialId}` });
  return NextResponse.json({ ok: true });
}
