import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { recordResult } from "@/lib/tournaments";
import { staffTournament } from "@/lib/tournament-access";

export const dynamic = "force-dynamic";

/** `{ winner, score?, walkover? }` — a result. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; matchId: string }> }) {
  const { id, matchId } = await params;
  const found = await staffTournament(req, id);
  if (found instanceof NextResponse) return found;
  const match = (await getDb()
    .prepare("SELECT id FROM tournament_matches WHERE id = ? AND tournament_id = ?")
    .get(Number(matchId), found.id)) as { id: number } | undefined;
  if (!match) return NextResponse.json({ error: "Not found." }, { status: 404 });
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const result = await recordResult(match.id, {
    winner: Number(body.winner),
    score: typeof body.score === "string" ? body.score : undefined,
    walkover: body.walkover === true,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ tournament: result.value });
}
