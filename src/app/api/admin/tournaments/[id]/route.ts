import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { cancelTournament, closeEntries, makeDraw, tournamentDetail } from "@/lib/tournaments";
import { staffTournament } from "@/lib/tournament-access";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const found = await staffTournament(req, (await params).id);
  if (found instanceof NextResponse) return found;
  return NextResponse.json({ tournament: await tournamentDetail(found.id, { forStaff: true }) });
}

/** `{ action: "close" | "draw" | "cancel" }` */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const found = await staffTournament(req, (await params).id);
  if (found instanceof NextResponse) return found;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const result =
    body.action === "close"
      ? await closeEntries(found.id)
      : body.action === "draw"
        ? await makeDraw(found.id)
        : body.action === "cancel"
          ? await cancelTournament(found.id)
          : null;
  if (!result) return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  const t = await tournamentDetail(found.id, { forStaff: true });
  await logAction(found.admin, {
    venueId: t?.venueId ?? null,
    action: body.action === "close" ? "tournament.closed" : body.action === "draw" ? "tournament.drawn" : "tournament.cancelled",
    detail: t?.name ?? `Tournament ${found.id}`,
  });
  return NextResponse.json({ tournament: await tournamentDetail(found.id, { forStaff: true }) });
}
