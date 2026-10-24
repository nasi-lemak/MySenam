import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { cancelCompetition, competitionById, competitionDetail } from "@/lib/competitions";
import { logAction } from "@/lib/activity";

export const dynamic = "force-dynamic";

async function load(req: NextRequest, idText: string) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return { error: admin };
  const competition = await competitionById(Number(idText));
  if (!competition) return { error: NextResponse.json({ error: "Not found." }, { status: 404 }) };
  const denied = denyVenue(admin, competition.venueId);
  if (denied) return { error: denied };
  return { admin, competition };
}

/** A competition and its divisions. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const got = await load(req, (await params).id);
  if ("error" in got) return got.error;
  return NextResponse.json({ competition: await competitionDetail(got.competition.id) });
}

/** Called off, with every division (a manager's). */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const got = await load(req, (await params).id);
  if ("error" in got) return got.error;
  const done = await cancelCompetition(got.competition.id);
  if (!done.ok) return NextResponse.json({ error: done.error }, { status: 409 });
  await logAction(got.admin, { venueId: got.competition.venueId, action: "competition.cancelled", detail: got.competition.name });
  return NextResponse.json({ competition: done.value });
}
